import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { createWorkspace, runScript } from "./support/runner.js";
import { bridgeChildEnv, waitForState } from "./support/bridge.js";
import { readState, writeState } from "./support/state.js";
import { cleanup } from "./support/teardown.js";

test.afterEach(async () => cleanup());

// Restart, reconnect, and re-enable scenarios drive the real foreground service
// against the stateful Discord history fake with a controllable clock. Expected
// times come from literal timelines, never from the service's own calculation.

function setup(workspace, projects = { demo: "channel" }) {
  const names = Object.keys(projects);
  fs.writeFileSync(path.join(workspace.repoDir, "registry.json"), JSON.stringify({
    discord_user_id: "owner", guild_id: "guild",
    pool: names.map(name => ({ id: `bot-${name}`, app_id: `app-${name}`, token: `token-${name}` })),
    projects: Object.fromEntries(names.map(name => [name, {
      type: "codex", bot_id: `bot-${name}`, channel_id: projects[name], assignment_generation: `gen-${name}`,
    }])),
  }), { mode: 0o600 });
  const rootState = path.join(workspace.homeDir, "root-discord");
  fs.mkdirSync(rootState, { recursive: true });
  fs.writeFileSync(path.join(rootState, ".env"), "DISCORD_BOT_TOKEN=fixture-root-token\n", { mode: 0o600 });
  const clockFile = path.join(workspace.tmpDir, "reminder-clock");
  const env = bridgeChildEnv(workspace, { ROOT_DISCORD_STATE_DIR: rootState,
    CCDM_REMINDER_NODE: process.execPath, CCDM_REMINDER_CLOCK_FILE: clockFile });
  return { stateDir: path.join(workspace.homeDir, ".local", "state", "ccdm", "conversation-reminders"),
    clockFile, env, setClock: value => fs.writeFileSync(clockFile, value) };
}

function message(id, timestamp, author, content = "text", extra = {}) {
  return { id, timestamp, content, type: 0, attachments: [],
    author: { id: author, bot: author.startsWith("app-") }, ...extra };
}

// An owner question at 08:00 answered by the assigned bot at 08:05.
function answered(name, prefix = name) {
  return [message(`${prefix}-2`, "2026-09-20T08:05:00Z", `app-${name}`, "Done"),
    message(`${prefix}-1`, "2026-09-20T08:00:00Z", "owner", "Please do it")];
}

function seedHistory(workspace, history, extra = {}) {
  const state = readState(workspace.stateDir);
  state.fixtures.discord.history = history;
  Object.assign(state.fixtures.discord, extra);
  writeState(state, workspace.stateDir);
}

// A message sent while nothing observed the Gateway exists only in history.
function missed(workspace, channelId, raw) {
  const state = readState(workspace.stateDir);
  state.fixtures.discord.history[channelId].unshift(raw);
  writeState(state, workspace.stateDir);
}

async function command(workspace, context, name, extra = []) {
  const result = await runScript(workspace, "scripts/conversation-reminder-service.py", {
    args: [name, "--project-root", workspace.repoDir, "--state-dir", context.stateDir, ...extra], env: context.env,
  });
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function startWorker(workspace, context) {
  return runScript(workspace, "scripts/conversation-reminder-service.py", {
    args: ["run", "--project-root", workspace.repoDir, "--state-dir", context.stateDir],
    env: context.env, timeoutMs: 30000,
  });
}

async function stopWorker(workspace, context, running) {
  await command(workspace, context, "disable");
  const result = await running;
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
}

async function waitForStatus(workspace, context, predicate, attempts = 200) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const current = await command(workspace, context, "status");
    if (predicate(current)) return current;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for status: ${JSON.stringify(await command(workspace, context, "status"))}`);
}

const reminders = state => (state.fixtures.discord.messages ?? []).filter(row => row.content === "👀");
const settle = (ms = 700) => new Promise(resolve => setTimeout(resolve, ms));

// Enable, discover, and reconcile every channel at 08:30, then stop the worker.
async function discoveredThenStopped(workspace, context, names) {
  await command(workspace, context, "enable");
  context.setClock("2026-09-20T08:30:00Z");
  const first = startWorker(workspace, context);
  const ready = await waitForStatus(workspace, context, current => names.every(name =>
    current.conversations[name]?.reconciliation_status === "ready"));
  await stopWorker(workspace, context, first);
  return ready;
}

test("downtime catch-up sends one reminder per overdue channel, spaced globally, anchored to its send", async () => {
  const workspace = createWorkspace();
  const context = setup(workspace, { alpha: "alpha-channel", beta: "beta-channel", gamma: "gamma-channel" });
  seedHistory(workspace, {
    "alpha-channel": answered("alpha"),
    "beta-channel": answered("beta"),
    "gamma-channel": answered("gamma"),
  });
  const ready = await discoveredThenStopped(workspace, context, ["alpha", "beta", "gamma"]);
  assert.deepEqual(["alpha", "beta", "gamma"].map(name => ready.conversations[name].due_at),
    ["2026-09-20T09:05:00Z", "2026-09-20T09:05:00Z", "2026-09-20T09:05:00Z"]);
  assert.equal(reminders(readState(workspace.stateDir)).length, 0);
  // Gamma's owner replies while the service is down; the bot's later answer has
  // no live completion, so history alone never re-arms it.
  missed(workspace, "gamma-channel", message("gamma-3", "2026-09-20T10:00:00Z", "owner", "Next step"));
  missed(workspace, "gamma-channel", message("gamma-4", "2026-09-20T10:05:00Z", "app-gamma", "Next step done"));

  await command(workspace, context, "enable");
  context.setClock("2026-09-20T15:20:00Z");
  const second = startWorker(workspace, context);
  const first = await waitForState(workspace, state => reminders(state).length === 1, 20000);
  assert.equal(reminders(first)[0].channelId, "alpha-channel");
  context.setClock("2026-09-20T15:20:04Z");
  await settle();
  assert.equal(reminders(readState(workspace.stateDir)).length, 1, "catch-up sends are spaced five seconds apart");
  context.setClock("2026-09-20T15:20:05Z");
  const both = await waitForState(workspace, state => reminders(state).length === 2, 20000);
  assert.equal(reminders(both)[1].channelId, "beta-channel");
  const anchored = await waitForStatus(workspace, context, current =>
    current.conversations.beta.due_at === "2026-09-20T17:20:05Z");
  // A catch-up is a real send: the streak grows and the next gap is two hours.
  assert.deepEqual([anchored.conversations.alpha.due_at, anchored.conversations.alpha.consecutive_reminders],
    ["2026-09-20T17:20:00Z", 1]);
  assert.deepEqual([anchored.conversations.gamma.state, anchored.conversations.gamma.last_ack_message_id],
    ["open-paused", "gamma-3"]);

  context.setClock("2026-09-20T17:19:59Z");
  await settle();
  assert.equal(reminders(readState(workspace.stateDir)).length, 2, "missed intervals are never replayed");
  context.setClock("2026-09-20T17:20:00Z");
  const next = await waitForState(workspace, state => reminders(state).length === 3, 20000);
  assert.equal(reminders(next)[2].channelId, "alpha-channel");
  const backedOff = await waitForStatus(workspace, context, current =>
    current.conversations.alpha.due_at === "2026-09-20T21:20:00Z");
  assert.equal(backedOff.conversations.alpha.consecutive_reminders, 2);
  assert.equal(readState(workspace.stateDir).fixtures.codex.appServerInvocations.length, 0);
  await stopWorker(workspace, context, second);
});

test("waking from sleep reconciles missed replies before any send and spaces overdue catch-ups", async () => {
  const workspace = createWorkspace();
  const context = setup(workspace, { alpha: "alpha-channel", beta: "beta-channel", gamma: "gamma-channel" });
  const wallOffset = path.join(workspace.tmpDir, "wall-offset");
  context.env = { ...context.env, CCDM_TEST_WALL_OFFSET_FILE: wallOffset, CCDM_REMINDER_WAKE_SETTLE_MS: "4000" };
  seedHistory(workspace, {
    "alpha-channel": answered("alpha"),
    "beta-channel": answered("beta"),
    "gamma-channel": answered("gamma"),
  });
  await command(workspace, context, "enable");
  context.setClock("2026-09-20T08:30:00Z");
  const running = startWorker(workspace, context);
  const names = ["alpha", "beta", "gamma"];
  await waitForStatus(workspace, context, current => names.every(name =>
    current.conversations[name]?.reconciliation_status === "ready"));
  await settle();
  assert.equal(reminders(readState(workspace.stateDir)).length, 0);

  // The Mac sleeps for seven hours. Gamma's owner replies from a phone; the
  // Gateway never delivers it and the socket still looks connected on wake.
  missed(workspace, "gamma-channel", message("gamma-3", "2026-09-20T10:00:00Z", "owner", "Next step"));
  fs.writeFileSync(wallOffset, String(7 * 3600000));
  await waitForStatus(workspace, context, current => names.every(name =>
    current.conversations[name].reconciliation_status === "suspended-restart-reconciliation"));
  context.setClock("2026-09-20T15:20:00Z");
  await settle(1000);
  assert.equal(reminders(readState(workspace.stateDir)).length, 0, "nothing sends before restart reconciliation");

  const first = await waitForState(workspace, state => reminders(state).length === 1, 20000);
  assert.equal(reminders(first)[0].channelId, "alpha-channel");
  context.setClock("2026-09-20T15:20:04Z");
  await settle();
  assert.equal(reminders(readState(workspace.stateDir)).length, 1, "catch-up sends are spaced five seconds apart");
  context.setClock("2026-09-20T15:20:05Z");
  const both = await waitForState(workspace, state => reminders(state).length === 2, 20000);
  assert.equal(reminders(both)[1].channelId, "beta-channel");
  const woke = await waitForStatus(workspace, context, current =>
    current.conversations.beta.due_at === "2026-09-20T17:20:05Z");
  assert.deepEqual(names.map(name => woke.conversations[name].discovery.mode), ["restart", "restart", "restart"]);
  assert.deepEqual([woke.conversations.gamma.state, woke.conversations.gamma.last_ack_message_id],
    ["open-paused", "gamma-3"]);
  await settle();
  assert.equal(reminders(readState(workspace.stateDir)).length, 2);
  await stopWorker(workspace, context, running);
});

async function adapterEvent(workspace, context, project, type, id, time, fields = {}) {
  const value = {
    schema_version: 1, event_id: id, event_type: type, project, channel_id: `${project}-channel`,
    bot_id: `bot-${project}`, assignment_generation: `gen-${project}`, provider: "codex",
    event_time: time, event_order: `${time}:${id}`, adapter_instance_id: "test-adapter", ...fields,
  };
  const result = await runScript(workspace, "scripts/conversation-reminder-events.py", {
    args: ["ingest", "--project-root", workspace.repoDir, "--state-dir", context.stateDir],
    input: JSON.stringify(value),
  });
  assert.equal(JSON.parse(result.stdout).status, "committed", result.stderr || result.stdout);
}

test("missed owner activity and provider replay are applied before any catch-up is sent", async () => {
  const workspace = createWorkspace();
  const names = ["closed", "reacted", "ambiguous", "replayed", "denied", "untouched"];
  const context = setup(workspace, Object.fromEntries(names.map(name => [name, `${name}-channel`])));
  seedHistory(workspace, Object.fromEntries(names.map(name => [`${name}-channel`, [
    message(`${name}-2`, "2026-09-20T08:05:00Z", `app-${name}`, "Done"),
    message(`${name}-p`, "2026-09-20T08:02:00Z", `app-${name}`, "Working"),
    message(`${name}-1`, "2026-09-20T08:00:00Z", "owner", "Please do it"),
  ]])));
  await discoveredThenStopped(workspace, context, names);

  // Downtime, 10:00-15:20. Nothing observes the Gateway.
  missed(workspace, "closed-channel", message("closed-3", "2026-09-20T10:00:00Z", "owner", "/close"));
  const state = readState(workspace.stateDir);
  state.fixtures.discord.history["reacted-channel"][0].reactions = [{ emoji: { name: "party", id: "77" }, count: 1 }];
  state.fixtures.discord.history["ambiguous-channel"][1].reactions = [{ emoji: { name: "👍" }, count: 1 }];
  state.fixtures.discord.reactionUsers = { "reacted-2|party:77": ["owner"], "ambiguous-p|👍": ["owner"] };
  state.fixtures.discord.restFailures = [{ method: "GET", path: "/api/v10/channels/denied-channel/messages",
    status: 403 }];
  writeState(state, workspace.stateDir);
  // A still-running Codex bridge answered a new owner message and durably recorded it.
  missed(workspace, "replayed-channel", message("replayed-3", "2026-09-20T12:00:00Z", "owner", "One more"));
  missed(workspace, "replayed-channel", message("replayed-4", "2026-09-20T12:05:00Z", "app-replayed", "Answered"));
  await adapterEvent(workspace, context, "replayed", "owner_activity", "replayed-owner", "2026-09-20T12:00:01Z", {
    actor_id: "owner", source_message_id: "replayed-3", activity_kind: "message" });
  await adapterEvent(workspace, context, "replayed", "response_delivered", "replayed-receipt", "2026-09-20T12:05:00Z", {
    provider_session_id: "session", provider_turn_id: "turn-2", interaction_id: "replayed-3",
    message_id: "replayed-4", disposition: "progress" });
  await adapterEvent(workspace, context, "replayed", "turn_completed", "replayed-complete", "2026-09-20T12:05:00Z", {
    provider_session_id: "session", provider_turn_id: "turn-2", interaction_id: "replayed-3",
    delivered_message_ids: ["replayed-4"] });

  await command(workspace, context, "enable");
  context.setClock("2026-09-20T15:20:00Z");
  const worker = startWorker(workspace, context);
  const settled = await waitForStatus(workspace, context, current =>
    names.filter(name => name !== "denied").every(name =>
      current.conversations[name]?.reconciliation_status === "ready") &&
    current.conversations.denied?.reconciliation_status === "suspended-discovery-history");
  const summary = Object.fromEntries(names.map(name => [name,
    [settled.conversations[name].state, settled.conversations[name].discovery?.basis]]));
  assert.deepEqual(summary, {
    closed: ["closed", "missed-owner-activity"],
    reacted: ["open-paused", "owner-reaction-after-answer"],
    ambiguous: ["open-paused", "reaction-ordering-unresolved"],
    replayed: ["awaiting-owner", "missed-owner-activity"],
    denied: ["awaiting-owner", null],
    untouched: ["awaiting-owner", "no-missed-activity"],
  });
  assert.equal(settled.conversations.replayed.due_at, "2026-09-20T13:05:00Z");
  assert.match(settled.readiness.projects.denied.blockers.join("\n"), /history: suspended-discovery-history .*denied/);
  assert.equal(settled.readiness.projects.denied.delivery_ready, false);

  const acknowledged = await waitForState(workspace, current => current.fixtures.discord.reactions?.some(row =>
    row.messageId === "closed-3" && decodeURIComponent(row.emoji) === "✅"), 20000);
  assert.equal(acknowledged.fixtures.discord.reactions.find(row => row.messageId === "closed-3").authorization,
    "Bot token-closed");
  const first = await waitForState(workspace, current => reminders(current).length === 1, 20000);
  context.setClock("2026-09-20T15:20:05Z");
  const second = await waitForState(workspace, current => reminders(current).length === 2, 20000);
  assert.deepEqual(reminders(second).map(row => row.channelId).sort(), ["replayed-channel", "untouched-channel"]);
  assert.equal(reminders(first)[0].channelId, "replayed-channel");
  context.setClock("2026-09-20T15:21:00Z");
  await settle();
  assert.equal(reminders(readState(workspace.stateDir)).length, 2);
  assert.equal(readState(workspace.stateDir).fixtures.codex.appServerInvocations.length, 0);
  await stopWorker(workspace, context, worker);
});

test("a rate limit outranks catch-up spacing, and a restart during catch-up cannot bypass it", async () => {
  const workspace = createWorkspace();
  const names = ["alpha", "beta", "gamma"];
  const context = setup(workspace, Object.fromEntries(names.map(name => [name, `${name}-channel`])));
  seedHistory(workspace, Object.fromEntries(names.map(name => [`${name}-channel`, answered(name)])));
  await discoveredThenStopped(workspace, context, names);
  const seed = readState(workspace.stateDir);
  seed.fixtures.discord.restFailures = [{ method: "POST", path: "/api/v10/channels/alpha-channel/messages",
    status: 429, body: { retry_after: 60, global: true } }];
  writeState(seed, workspace.stateDir);

  await command(workspace, context, "enable");
  context.setClock("2026-09-20T15:20:00Z");
  let worker = startWorker(workspace, context);
  await waitForState(workspace, state => state.fixtures.discord.restFailureUses?.length === 1, 20000);
  const limited = await waitForStatus(workspace, context, current =>
    current.catch_up_next_at === "2026-09-20T15:21:00Z");
  assert.ok(names.every(name => limited.conversations[name].catch_up_queued));
  context.setClock("2026-09-20T15:20:59Z");
  await settle();
  assert.equal(reminders(readState(workspace.stateDir)).length, 0, "no catch-up is sent inside Discord's retry window");

  context.setClock("2026-09-20T15:21:00Z");
  const first = await waitForState(workspace, state => reminders(state).length === 1, 20000);
  assert.equal(reminders(first)[0].channelId, "alpha-channel");
  await waitForStatus(workspace, context, current => current.conversations.alpha.due_at === "2026-09-20T17:21:00Z");
  // Restart two seconds later: every channel reconciles again, yet the durable gate holds.
  await stopWorker(workspace, context, worker);
  await command(workspace, context, "enable");
  context.setClock("2026-09-20T15:21:02Z");
  worker = startWorker(workspace, context);
  await waitForStatus(workspace, context, current => names.every(name =>
    current.conversations[name].reconciliation_status === "ready"));
  context.setClock("2026-09-20T15:21:04Z");
  await settle();
  assert.equal(reminders(readState(workspace.stateDir)).length, 1, "a restart does not reset global spacing");
  const second = await command(workspace, context, "status");
  assert.deepEqual(names.map(name => second.conversations[name].catch_up_queued), [false, true, true]);
  assert.equal(second.readiness.projects.alpha.catch_up_queued, false);

  context.setClock("2026-09-20T15:21:05Z");
  const beta = await waitForState(workspace, state => reminders(state).length === 2, 20000);
  assert.equal(reminders(beta)[1].channelId, "beta-channel");
  context.setClock("2026-09-20T15:21:09Z");
  await settle();
  assert.equal(reminders(readState(workspace.stateDir)).length, 2);
  context.setClock("2026-09-20T15:21:10Z");
  const gamma = await waitForState(workspace, state => reminders(state).length === 3, 20000);
  assert.equal(reminders(gamma)[2].channelId, "gamma-channel");
  assert.deepEqual((await waitForStatus(workspace, context, current =>
    current.conversations.gamma.due_at === "2026-09-20T17:21:10Z")).conversations.beta.due_at,
  "2026-09-20T17:21:05Z");
  await stopWorker(workspace, context, worker);
});

function gatewayEvent(workspace, event) {
  const state = readState(workspace.stateDir);
  state.fixtures.discord.injectedGatewayEvents ||= [];
  state.fixtures.discord.injectedGatewayEvents.push({ event, delivered: false });
  writeState(state, workspace.stateDir);
}

test("a Gateway reconnect gap is reconciled from history before the next reminder is due", async () => {
  const workspace = createWorkspace();
  const context = setup(workspace, { alpha: "alpha-channel", beta: "beta-channel" });
  seedHistory(workspace, { "alpha-channel": answered("alpha"), "beta-channel": answered("beta") });
  await command(workspace, context, "enable");
  context.setClock("2026-09-20T08:30:00Z");
  const worker = startWorker(workspace, context);
  await waitForStatus(workspace, context, current => ["alpha", "beta"].every(name =>
    current.conversations[name]?.reconciliation_status === "ready"));

  gatewayEvent(workspace, "shardDisconnect");
  const gap = await waitForStatus(workspace, context, current => ["alpha", "beta"].every(name =>
    current.conversations[name].reconciliation_status === "suspended-restart-reconciliation"));
  assert.match(gap.readiness.projects.alpha.blockers.join("\n"), /history: suspended-restart-reconciliation/);
  // While disconnected, the owner answers alpha; the observer never sees it.
  missed(workspace, "alpha-channel", message("alpha-3", "2026-09-20T08:40:00Z", "owner", "Thanks, looks good"));
  context.setClock("2026-09-20T09:05:00Z");
  await settle();
  assert.equal(reminders(readState(workspace.stateDir)).length, 0, "nothing is sent while the Gateway is down");

  gatewayEvent(workspace, "shardReady");
  const reconciled = await waitForStatus(workspace, context, current => ["alpha", "beta"].every(name =>
    current.conversations[name].reconciliation_status === "ready"));
  assert.deepEqual([reconciled.conversations.alpha.state, reconciled.conversations.alpha.last_ack_message_id],
    ["open-paused", "alpha-3"]);
  const sent = await waitForState(workspace, state => reminders(state).length === 1, 20000);
  assert.equal(reminders(sent)[0].channelId, "beta-channel");
  await settle();
  assert.equal(reminders(readState(workspace.stateDir)).length, 1);
  await stopWorker(workspace, context, worker);
});

test("a queued catch-up honors an owner reply and a deregistration before its turn", async () => {
  const workspace = createWorkspace();
  const names = ["alpha", "beta", "gamma"];
  const context = setup(workspace, Object.fromEntries(names.map(name => [name, `${name}-channel`])));
  seedHistory(workspace, Object.fromEntries(names.map(name => [`${name}-channel`, answered(name)])));
  await discoveredThenStopped(workspace, context, names);
  await command(workspace, context, "enable");
  context.setClock("2026-09-20T15:20:00Z");
  const worker = startWorker(workspace, context);
  await waitForState(workspace, state => reminders(state).length === 1, 20000);
  const queued = await command(workspace, context, "status");
  assert.deepEqual(names.map(name => queued.conversations[name].catch_up_queued), [false, true, true]);

  const state = readState(workspace.stateDir);
  state.fixtures.discord.history["beta-channel"].unshift(
    message("beta-3", "2026-09-20T15:20:02Z", "owner", "Seen it, thanks"));
  state.fixtures.discord.injectedMessages.push({ id: "beta-3", channelId: "beta-channel", content: "Seen it, thanks",
    author: { id: "owner", bot: false }, attachments: [], delivered: false });
  writeState(state, workspace.stateDir);
  const registryPath = path.join(workspace.repoDir, "registry.json");
  const registry = JSON.parse(fs.readFileSync(registryPath, "utf8"));
  delete registry.projects.gamma;
  fs.writeFileSync(registryPath, JSON.stringify(registry), { mode: 0o600 });
  const canceled = await waitForStatus(workspace, context, current =>
    current.conversations.beta.state === "open-paused" && current.conversations.gamma === undefined);
  assert.equal(canceled.conversations.beta.catch_up_queued, false);

  context.setClock("2026-09-20T15:20:05Z");
  await settle(1000);
  assert.deepEqual(reminders(readState(workspace.stateDir)).map(row => row.channelId), ["alpha-channel"]);
  await stopWorker(workspace, context, worker);
});

test("disable lets an in-flight send finish, keeps closures, and re-enable reconciles before sending", async () => {
  const workspace = createWorkspace();
  const names = ["alpha", "beta", "shut"];
  const context = setup(workspace, Object.fromEntries(names.map(name => [name, `${name}-channel`])));
  seedHistory(workspace, {
    "alpha-channel": answered("alpha"), "beta-channel": answered("beta"),
    "shut-channel": [message("shut-3", "2026-09-20T08:10:00Z", "owner", "/close"), ...answered("shut")],
  }, { restResponseDelayMs: 800 });
  await discoveredThenStopped(workspace, context, names);
  await command(workspace, context, "enable");
  context.setClock("2026-09-20T15:20:00Z");
  const worker = startWorker(workspace, context);
  await waitForState(workspace, state => state.fixtures.discord.responsePending === true, 20000);
  const disabled = await command(workspace, context, "disable");
  assert.equal(disabled.delivery_enabled, false);
  assert.equal((await worker).exitCode, 0);

  const stopped = await command(workspace, context, "status");
  assert.equal(stopped.conversations.alpha.reminder_message_id, "fake-message-1", "the in-flight send was recorded");
  assert.equal(stopped.conversations.alpha.due_at, "2026-09-20T17:20:00Z");
  assert.deepEqual(stopped.unresolved_intents, []);
  assert.equal(stopped.conversations.beta.catch_up_queued, true);
  assert.equal(stopped.conversations.shut.state, "closed");
  assert.match(stopped.readiness.projects.beta.blockers.join("\n"), /service is disabled; run enable/);
  context.setClock("2026-09-20T15:30:00Z");
  await settle();
  assert.equal(reminders(readState(workspace.stateDir)).length, 1, "disable stops sends");

  // While disabled the owner answers beta; re-enable must reconcile before anything is due.
  missed(workspace, "beta-channel", message("beta-3", "2026-09-20T15:25:00Z", "owner", "Got it"));
  const enabled = await command(workspace, context, "enable");
  assert.deepEqual(names.map(name => enabled.conversations[name].reconciliation_status),
    Array(3).fill("suspended-restart-reconciliation"));
  assert.equal(enabled.conversations.shut.state, "closed");
  assert.match(enabled.readiness.projects.alpha.blockers.join("\n"), /foreground worker is not running/);
  context.setClock("2026-09-20T17:20:00Z");
  const again = startWorker(workspace, context);
  const reconciled = await waitForStatus(workspace, context, current => names.every(name =>
    current.conversations[name].reconciliation_status === "ready"));
  assert.deepEqual(names.map(name => reconciled.conversations[name].state), ["awaiting-owner", "open-paused", "closed"]);
  const next = await waitForState(workspace, state => reminders(state).length === 2, 20000);
  assert.equal(reminders(next)[1].channelId, "alpha-channel");
  await settle();
  assert.equal(reminders(readState(workspace.stateDir)).length, 2);
  await stopWorker(workspace, context, again);
});

test("a catch-up waits for the cleanup backlog left before downtime", async () => {
  const workspace = createWorkspace();
  const context = setup(workspace, { alpha: "alpha-channel" });
  seedHistory(workspace, { "alpha-channel": answered("alpha") });
  await command(workspace, context, "enable");
  context.setClock("2026-09-20T08:30:00Z");
  const first = startWorker(workspace, context);
  await waitForStatus(workspace, context, current => current.conversations.alpha?.reconciliation_status === "ready");
  context.setClock("2026-09-20T09:05:00Z");
  await waitForState(workspace, state => reminders(state).length === 1, 20000);
  await waitForStatus(workspace, context, current => current.conversations.alpha.due_at === "2026-09-20T11:05:00Z");
  const seed = readState(workspace.stateDir);
  const failure = { method: "DELETE", path: "/api/v10/channels/alpha-channel/messages/fake-message-1", status: 500 };
  seed.fixtures.discord.restFailures = [failure, failure];
  writeState(seed, workspace.stateDir);
  context.setClock("2026-09-20T11:05:00Z");
  await waitForState(workspace, state => state.fixtures.discord.restFailureUses?.length === 1, 20000);
  await stopWorker(workspace, context, first);
  const backlog = await command(workspace, context, "status");
  assert.deepEqual(backlog.conversations.alpha.cleanup_message_ids, ["fake-message-1"]);
  assert.deepEqual(backlog.readiness.projects.alpha.pending_cleanup, ["fake-message-1"]);

  await command(workspace, context, "enable");
  context.setClock("2026-09-20T15:20:00Z");
  const second = startWorker(workspace, context);
  await waitForState(workspace, state => state.fixtures.discord.restFailureUses?.length === 2, 20000);
  await settle();
  assert.equal(reminders(readState(workspace.stateDir)).length, 2, "no catch-up while the prior reminder remains");
  context.setClock("2026-09-20T15:20:01Z");
  const sent = await waitForState(workspace, state => reminders(state).length === 3, 20000);
  assert.deepEqual(sent.fixtures.discord.reminderRequests.slice(0, 6).map(row => row.method),
    ["POST", "POST", "DELETE", "DELETE", "DELETE", "POST"]);
  const anchored = await waitForStatus(workspace, context, current =>
    current.conversations.alpha.due_at === "2026-09-20T21:20:01Z");
  assert.equal(anchored.conversations.alpha.catch_up_queued, false);
  assert.equal(anchored.conversations.alpha.consecutive_reminders, 3);
  await stopWorker(workspace, context, second);
});

test("an uncertain delivery stays gated through restart until its nonce replay resolves its identity", async () => {
  const workspace = createWorkspace();
  const context = setup(workspace, { alpha: "alpha-channel", beta: "beta-channel" });
  seedHistory(workspace, { "alpha-channel": answered("alpha"),
    "beta-channel": [message("beta-3", "2026-09-20T09:30:00Z", "app-beta", "Done"), ...answered("beta").slice(1)] });
  await command(workspace, context, "enable");
  context.setClock("2026-09-20T08:30:00Z");
  const first = startWorker(workspace, context);
  await waitForStatus(workspace, context, current => ["alpha", "beta"].every(name =>
    current.conversations[name]?.reconciliation_status === "ready"));
  const seed = readState(workspace.stateDir);
  seed.fixtures.discord.crashAfterReminderAccept = true;
  // History briefly lags the accepted reminder.
  seed.fixtures.discord.includeSentInHistory = false;
  writeState(seed, workspace.stateDir);
  context.setClock("2026-09-20T09:05:00Z");
  assert.equal((await first).exitCode, 2);
  assert.equal(reminders(readState(workspace.stateDir)).length, 1);

  // Until a nonce replay returns the accepted reminder, alpha stays gated while
  // beta reconciles normally. History never shows the reminder here.
  const losing = readState(workspace.stateDir);
  losing.fixtures.discord.restLoseResponse = 30;
  writeState(losing, workspace.stateDir);
  await command(workspace, context, "enable");
  context.setClock("2026-09-20T09:06:00Z");
  const second = startWorker(workspace, context);
  const gated = await waitForStatus(workspace, context, current =>
    current.conversations.beta.reconciliation_status === "ready" &&
    current.conversations.alpha.reconciliation_status === "suspended-uncertain-send");
  assert.match(gated.readiness.projects.alpha.blockers.join("\n"), /uncertain delivery: run recover/);
  assert.equal(gated.readiness.projects.alpha.uncertain_delivery.length, 1);
  await settle();
  assert.equal(reminders(readState(workspace.stateDir)).length, 1, "the uncertain channel is never resent");

  // Once a replay inside Discord's duplicate-check window is answered, it
  // returns the 09:05 reminder itself; the worker records it and reconciles.
  const answering = readState(workspace.stateDir);
  answering.fixtures.discord.restLoseResponse = false;
  writeState(answering, workspace.stateDir);
  const adopted = await waitForStatus(workspace, context, current =>
    current.conversations.alpha.reminder_message_id === "fake-message-1" &&
    current.conversations.alpha.reconciliation_status === "ready", 800);
  assert.equal(adopted.conversations.alpha.due_at, "2026-09-20T11:05:00Z");
  assert.deepEqual(adopted.unresolved_intents, []);
  context.setClock("2026-09-20T15:30:00Z");
  const resumed = await waitForState(workspace, state => reminders(state).length === 3, 20000);
  assert.deepEqual(reminders(resumed).map(row => row.channelId).sort(),
    ["alpha-channel", "alpha-channel", "beta-channel"]);
  await waitForStatus(workspace, context, current => current.conversations.alpha.due_at === "2026-09-20T19:30:00Z");
  await settle();
  assert.equal(reminders(readState(workspace.stateDir)).length, 3);
  await stopWorker(workspace, context, second);
});

test("an interrupted restart scan resumes from its checkpoint before releasing the channel", async () => {
  const workspace = createWorkspace();
  const context = setup(workspace, { alpha: "alpha-channel" });
  const start = Date.parse("2026-09-20T08:00:00Z");
  seedHistory(workspace, { "alpha-channel": Array.from({ length: 150 }, (_, index) => {
    const at = new Date(start + index * 1000).toISOString().replace(".000Z", "Z");
    return index === 0 ? message("300000", at, "owner", "Run it")
      : message(String(300000 + index), at, "app-alpha", `progress ${index}`);
  }).reverse() });
  await discoveredThenStopped(workspace, context, ["alpha"]);
  const before = readState(workspace.stateDir).fixtures.discord.historyFetches.length;
  const seed = readState(workspace.stateDir);
  seed.fixtures.discord.crashAfterHistoryPages = 2;
  writeState(seed, workspace.stateDir);

  await command(workspace, context, "enable");
  context.setClock("2026-09-20T15:20:00Z");
  assert.equal((await startWorker(workspace, context)).exitCode, 2);
  const interrupted = await command(workspace, context, "status");
  assert.deepEqual([interrupted.conversations.alpha.reconciliation_status,
    interrupted.conversations.alpha.discovery.mode, interrupted.conversations.alpha.discovery.before_id],
  ["reconciling", "restart", "300050"]);
  assert.equal(reminders(readState(workspace.stateDir)).length, 0);

  const resumed = startWorker(workspace, context);
  await waitForStatus(workspace, context, current => current.conversations.alpha.reconciliation_status === "ready");
  const fetches = readState(workspace.stateDir).fixtures.discord.historyFetches.slice(before);
  assert.equal(fetches[2].before, "300050", "the resumed scan continues from its saved cursor");
  const sent = await waitForState(workspace, state => reminders(state).length === 1, 20000);
  assert.equal(reminders(sent)[0].channelId, "alpha-channel");
  await stopWorker(workspace, context, resumed);
});

test("unmet Claude prerequisites block enablement and cannot be bypassed into Codex-only delivery", async () => {
  const workspace = createWorkspace();
  const context = setup(workspace, { alpha: "alpha-channel" });
  seedHistory(workspace, { "alpha-channel": answered("alpha") });
  const adapter = path.join(workspace.repoDir, "scripts", "claude-reminder-channel.js");
  const saved = fs.readFileSync(adapter);
  fs.rmSync(adapter);

  const refused = await runScript(workspace, "scripts/conversation-reminder-service.py", {
    args: ["enable", "--project-root", workspace.repoDir, "--state-dir", context.stateDir], env: context.env,
  });
  assert.equal(refused.exitCode, 2);
  const blocked = JSON.parse(refused.stdout);
  assert.equal(blocked.status, "blocked");
  assert.match(blocked.reason, /provider prerequisites are unmet: claude missing scripts\/claude-reminder-channel\.js/);
  assert.deepEqual(blocked.preflight.provider_prerequisites.providers.codex, { met: true, missing: [] });
  assert.equal(blocked.preflight.root_credentials, "present");
  assert.doesNotMatch(refused.stdout, /fixture-root-token|token-alpha/);

  // Even a directly requested scan of a ready Codex channel cannot send.
  await command(workspace, context, "discover");
  context.setClock("2026-09-20T15:20:00Z");
  const worker = startWorker(workspace, context);
  const ready = await waitForStatus(workspace, context, current =>
    current.conversations.alpha?.reconciliation_status === "ready");
  assert.equal(ready.delivery_enabled, false);
  assert.equal(ready.readiness.provider_prerequisites.met, false);
  assert.match(ready.readiness.projects.alpha.blockers.join("\n"), /provider prerequisites are unmet/);
  await settle();
  assert.equal(reminders(readState(workspace.stateDir)).length, 0);
  await stopWorker(workspace, context, worker);

  fs.writeFileSync(adapter, saved);
  const enabled = await command(workspace, context, "enable");
  assert.equal(enabled.delivery_enabled, true);
  assert.deepEqual(enabled.preflight.blockers, []);
  assert.equal(enabled.preflight.state_dir_private, true);
  assert.equal(fs.statSync(context.stateDir).mode & 0o777, 0o700);
  const again = startWorker(workspace, context);
  const sent = await waitForState(workspace, state => reminders(state).length === 1, 20000);
  assert.equal(reminders(sent)[0].authorization, "Bot token-alpha");
  const released = await waitForStatus(workspace, context, current =>
    current.conversations.alpha.due_at === "2026-09-20T17:20:00Z");
  assert.deepEqual([released.readiness.projects.alpha.delivery_ready, released.readiness.projects.alpha.blockers],
    [true, []]);
  await stopWorker(workspace, context, again);
});

test("enable refuses without root observation credentials or an owner, and never exposes secrets", async () => {
  const workspace = createWorkspace();
  const context = setup(workspace, { alpha: "alpha-channel" });
  fs.rmSync(path.join(workspace.homeDir, "root-discord", ".env"));
  const registryPath = path.join(workspace.repoDir, "registry.json");
  const registry = JSON.parse(fs.readFileSync(registryPath, "utf8"));
  delete registry.discord_user_id;
  fs.writeFileSync(registryPath, JSON.stringify(registry), { mode: 0o600 });
  const refused = await runScript(workspace, "scripts/conversation-reminder-service.py", {
    args: ["enable", "--project-root", workspace.repoDir, "--state-dir", context.stateDir], env: context.env,
  });
  assert.equal(refused.exitCode, 2);
  const blocked = JSON.parse(refused.stdout);
  assert.match(blocked.reason, /no CCDM owner/);
  assert.match(blocked.reason, /root Discord credentials are unavailable: set DISCORD_BOT_TOKEN in ROOT_DISCORD_STATE_DIR\/\.env/);
  assert.doesNotMatch(refused.stdout, /token-alpha/);
  // A refused enable validates without side effects: no state directory exists.
  assert.equal(fs.existsSync(context.stateDir), false);
  const current = await command(workspace, context, "status");
  assert.equal(current.discovery_requested, false);
  assert.equal(current.delivery_enabled, false);
  assert.equal(fs.existsSync(context.stateDir), false);
});

test("a refused enable leaves an existing state directory's permissions unchanged", async () => {
  const workspace = createWorkspace();
  const context = setup(workspace, { alpha: "alpha-channel" });
  fs.mkdirSync(context.stateDir, { recursive: true, mode: 0o755 });
  fs.chmodSync(context.stateDir, 0o755);
  fs.rmSync(path.join(workspace.homeDir, "root-discord", ".env"));
  const refused = await runScript(workspace, "scripts/conversation-reminder-service.py", {
    args: ["enable", "--project-root", workspace.repoDir, "--state-dir", context.stateDir], env: context.env,
  });
  assert.equal(refused.exitCode, 2);
  assert.match(JSON.parse(refused.stdout).reason, /set DISCORD_BOT_TOKEN/);
  assert.equal(fs.statSync(context.stateDir).mode & 0o777, 0o755);
  assert.deepEqual(fs.readdirSync(context.stateDir), []);

  // Once every blocker clears, enable prepares the private directory itself.
  fs.writeFileSync(path.join(workspace.homeDir, "root-discord", ".env"), "DISCORD_BOT_TOKEN=fixture-root-token\n",
    { mode: 0o600 });
  const enabled = await command(workspace, context, "enable");
  assert.deepEqual(enabled.preflight.blockers, []);
  assert.equal(fs.statSync(context.stateDir).mode & 0o777, 0o700);
});

test("a generation change during downtime rediscovers the new assignment and shares the catch-up spacing", async () => {
  const workspace = createWorkspace();
  const context = setup(workspace, { alpha: "alpha-channel", beta: "beta-channel" });
  seedHistory(workspace, { "alpha-channel": answered("alpha"), "beta-channel": answered("beta") });
  await discoveredThenStopped(workspace, context, ["alpha", "beta"]);
  const changed = await command(workspace, context, "assignment-changed", ["--project", "beta"]);
  assert.deepEqual(changed.retired_generations, ["gen-beta"]);
  // A late event from the retired generation is rejected rather than replayed.
  const late = await runScript(workspace, "scripts/conversation-reminder-events.py", {
    args: ["ingest", "--project-root", workspace.repoDir, "--state-dir", context.stateDir],
    input: JSON.stringify({ schema_version: 1, event_id: "late-owner", event_type: "owner_activity", project: "beta",
      channel_id: "beta-channel", bot_id: "bot-beta", assignment_generation: "gen-beta", provider: "codex",
      event_time: "2026-09-20T12:00:00Z", event_order: "late", adapter_instance_id: "test-adapter",
      actor_id: "owner", source_message_id: "beta-late", activity_kind: "message" }),
  });
  assert.notEqual(JSON.parse(late.stdout).status, "committed");

  await command(workspace, context, "enable");
  context.setClock("2026-09-20T15:20:00Z");
  const worker = startWorker(workspace, context);
  const first = await waitForState(workspace, state => reminders(state).length === 1, 20000);
  context.setClock("2026-09-20T15:20:04Z");
  await settle();
  assert.equal(reminders(readState(workspace.stateDir)).length, 1);
  context.setClock("2026-09-20T15:20:05Z");
  const both = await waitForState(workspace, state => reminders(state).length === 2, 20000);
  assert.deepEqual([reminders(first)[0].channelId, reminders(both)[1].channelId].sort(),
    ["alpha-channel", "beta-channel"]);
  const current = await waitForStatus(workspace, context, status =>
    status.conversations.beta.assignment_generation === changed.assignment_generation &&
    status.conversations.beta.reminder_message_id);
  assert.equal(current.conversations.beta.discovery.mode, "initial");
  assert.ok(current.retired_assignments.some(row => row.assignment_generation === "gen-beta"));
  await stopWorker(workspace, context, worker);
});
