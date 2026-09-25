import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { createWorkspace, runScript } from "./support/runner.js";
import { bridgeChildEnv, injectDiscordMessage, injectDiscordReaction, waitForState } from "./support/bridge.js";
import { readState, writeState } from "./support/state.js";
import { cleanup } from "./support/teardown.js";

test.afterEach(async () => cleanup());

// History discovery scenarios drive the real foreground service against a
// stateful paginated Discord history fake. Timestamps are literal timelines.

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
  return path.join(workspace.homeDir, ".local", "state", "ccdm", "conversation-reminders");
}

function message(id, timestamp, author, content = "text", extra = {}) {
  return { id, timestamp, content, type: 0, attachments: [],
    author: { id: author, bot: author.startsWith("app-") }, ...extra };
}

// A live arrival is visible both to the Gateway observer and to later history reads.
function arrive(workspace, channelId, raw) {
  const state = readState(workspace.stateDir);
  state.fixtures.discord.history[channelId].unshift(raw);
  writeState(state, workspace.stateDir);
  if (!raw.author.bot) {
    injectDiscordMessage(workspace, { channelId, id: raw.id, author: { id: raw.author.id }, content: raw.content });
  }
}

function seedHistory(workspace, history, extra = {}) {
  const state = readState(workspace.stateDir);
  state.fixtures.discord.history = history;
  Object.assign(state.fixtures.discord, extra);
  writeState(state, workspace.stateDir);
}

async function command(workspace, stateDir, name, extra = {}) {
  const result = await runScript(workspace, "scripts/conversation-reminder-service.py", {
    args: [name, "--project-root", workspace.repoDir, "--state-dir", stateDir], ...extra,
  });
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

async function adapterEvent(workspace, stateDir, type, id, time, fields = {}) {
  const value = {
    schema_version: 1, event_id: id, event_type: type, project: "demo", channel_id: "channel",
    bot_id: "bot-demo", assignment_generation: "gen-demo", provider: "codex",
    event_time: time, event_order: `${time}:${id}`, adapter_instance_id: "test-adapter", ...fields,
  };
  const result = await runScript(workspace, "scripts/conversation-reminder-events.py", {
    args: ["ingest", "--project-root", workspace.repoDir, "--state-dir", stateDir], input: JSON.stringify(value),
  });
  assert.equal(JSON.parse(result.stdout).status, "committed", result.stderr || result.stdout);
}

function startWorker(workspace, stateDir, time) {
  const clockFile = path.join(workspace.tmpDir, "reminder-clock");
  fs.writeFileSync(clockFile, time);
  const running = runScript(workspace, "scripts/conversation-reminder-service.py", {
    args: ["run", "--project-root", workspace.repoDir, "--state-dir", stateDir],
    env: bridgeChildEnv(workspace, { ROOT_DISCORD_STATE_DIR: path.join(workspace.homeDir, "root-discord"),
      CCDM_REMINDER_NODE: process.execPath, CCDM_REMINDER_CLOCK_FILE: clockFile }),
    timeoutMs: 20000,
  });
  return { running, setClock: value => fs.writeFileSync(clockFile, value) };
}

// The harness records every command invocation into the shared fixture state,
// which can race with the observer's own fixture writes. Wait read-only for
// fixture records before polling status while a scan is writing.
function fetchCount(state, channelId) {
  return (state.fixtures.discord.historyFetches ?? []).filter(row => row.channelId === channelId).length;
}

function waitForFixture(workspace, predicate) {
  return waitForState(workspace, predicate, 20000);
}

async function waitForStatus(workspace, stateDir, predicate, attempts = 160) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const current = await command(workspace, stateDir, "status");
    if (predicate(current)) return current;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for status: ${JSON.stringify(await command(workspace, stateDir, "status"))}`);
}

async function stop(workspace, stateDir, worker) {
  await command(workspace, stateDir, "disable");
  const result = await worker.running;
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
}

test("discovery arms an old completed-looking answer from its answer time, then delivers", async () => {
  const workspace = createWorkspace();
  const stateDir = setup(workspace);
  seedHistory(workspace, { channel: [
    message("1003", "2026-09-20T08:05:00Z", "app-demo", "Done — the report is ready."),
    message("1002", "2026-09-20T08:01:00Z", "app-demo", "Working on it."),
    message("1001", "2026-09-20T08:00:00Z", "owner", "Please build the report"),
  ] });
  const requested = await command(workspace, stateDir, "discover");
  assert.equal(requested.discovery_requested, true);
  const worker = startWorker(workspace, stateDir, "2026-09-20T08:30:00Z");
  const ready = await waitForStatus(workspace, stateDir, current =>
    current.conversations.demo?.reconciliation_status === "ready");
  const demo = ready.conversations.demo;
  assert.equal(demo.state, "awaiting-owner");
  assert.equal(demo.response_message_id, "1003");
  assert.equal(demo.response_at, "2026-09-20T08:05:00Z");
  assert.equal(demo.due_at, "2026-09-20T09:05:00Z");
  assert.equal(demo.discovery.basis, "historical-owner-then-bot-approximation");
  assert.equal(ready.delivery_enabled, true);
  assert.ok(readState(workspace.stateDir).fixtures.discord.historyFetches.every(row =>
    row.authorization === "Bot fixture-root-token" && row.limit === 100));

  worker.setClock("2026-09-20T09:04:59Z");
  await new Promise(resolve => setTimeout(resolve, 600));
  assert.equal(readState(workspace.stateDir).fixtures.discord.messages?.length ?? 0, 0);
  worker.setClock("2026-09-20T09:05:00Z");
  const sent = await waitForState(workspace, state => state.fixtures.discord.messages?.length === 1);
  assert.equal(sent.fixtures.discord.messages[0].content, "👀");
  assert.equal(sent.fixtures.discord.messages[0].authorization, "Bot token-demo");
  await waitForStatus(workspace, stateDir, current => current.conversations.demo.due_at === "2026-09-20T10:05:00Z");
  assert.equal(readState(workspace.stateDir).fixtures.codex.appServerInvocations.length, 0);
  await stop(workspace, stateDir, worker);
});

// Newest-first history: an owner question at 08:00:00 followed by `count - 1`
// bot progress messages one second apart, so the owner's participation sits
// on the last page.
function longHistory(count, prefix = 100000) {
  const start = Date.parse("2026-09-20T08:00:00Z");
  return Array.from({ length: count }, (_, index) => {
    const at = new Date(start + index * 1000).toISOString().replace(".000Z", "Z");
    return index === 0 ? message(String(prefix), at, "owner", "Please run the migration")
      : message(String(prefix + index), at, "app-demo", `progress ${index}`);
  }).reverse();
}

test("discovery pages channels fairly in bounded passes and resumes from the saved cursor", async () => {
  const workspace = createWorkspace();
  const stateDir = setup(workspace, { demo: "channel", other: "other-channel" });
  seedHistory(workspace, {
    channel: longHistory(1150),
    "other-channel": [message("2001", "2026-09-21T10:00:00Z", "owner", "Anything new?")],
  });
  await command(workspace, stateDir, "discover");
  const worker = startWorker(workspace, stateDir, "2026-09-24T12:00:00Z");
  await waitForFixture(workspace, state => fetchCount(state, "channel") === 10 &&
    fetchCount(state, "other-channel") === 2);
  await new Promise(resolve => setTimeout(resolve, 600));
  const fetches = readState(workspace.stateDir).fixtures.discord.historyFetches;
  const demoFetches = fetches.filter(row => row.channelId === "channel");
  assert.equal(demoFetches.length, 10);
  assert.ok(fetches.findIndex(row => row.channelId === "other-channel") <
    fetches.indexOf(demoFetches[1]), "a small channel is not starved behind a long one");
  const first = await waitForStatus(workspace, stateDir, current =>
    current.conversations.other?.reconciliation_status === "ready");
  assert.equal(first.conversations.other.state, "open-paused");
  assert.equal(first.conversations.other.discovery.basis, "no-answer-after-reply");
  assert.equal(first.conversations.demo.reconciliation_status, "discovering");
  assert.equal(first.conversations.demo.discovery.pages_scanned, 10);
  assert.equal(first.conversations.demo.discovery.resumable, true);
  assert.equal(first.conversations.demo.discovery.before_id, "100150");

  worker.setClock("2026-09-24T12:00:30Z");
  await waitForFixture(workspace, state => fetchCount(state, "channel") === 13);
  const resumed = readState(workspace.stateDir).fixtures.discord.historyFetches
    .filter(row => row.channelId === "channel").slice(10);
  const ready = await waitForStatus(workspace, stateDir, current =>
    current.conversations.demo?.reconciliation_status === "ready");
  assert.deepEqual(resumed.map(row => row.before ?? `after:${row.after}`),
    ["100150", "100050", "after:101149"]);
  assert.equal(ready.conversations.demo.state, "awaiting-owner");
  assert.equal(ready.conversations.demo.response_message_id, "101149");
  assert.equal(ready.conversations.demo.response_at, "2026-09-20T08:19:09Z");
  assert.equal(ready.conversations.demo.last_ack_message_id, "100000");
  assert.equal(ready.conversations.demo.discovery.passes, 2);
  await stop(workspace, stateDir, worker);
});

test("a throttled channel backs off for Discord's retry window while others continue", async () => {
  const workspace = createWorkspace();
  const stateDir = setup(workspace, { demo: "channel", other: "other-channel" });
  seedHistory(workspace, {
    channel: [message("1002", "2026-09-20T08:05:00Z", "app-demo", "Done"),
      message("1001", "2026-09-20T08:00:00Z", "owner", "Ship it")],
    "other-channel": [message("2001", "2026-09-21T10:00:00Z", "owner", "Anything new?")],
  }, { restFailures: [{ method: "GET", path: "/api/v10/channels/channel/messages", status: 429,
    body: { retry_after: 60 } }] });
  await command(workspace, stateDir, "discover");
  const worker = startWorker(workspace, stateDir, "2026-09-24T12:00:00Z");
  await waitForFixture(workspace, state => state.fixtures.discord.restFailureUses?.length === 1 &&
    fetchCount(state, "other-channel") === 2);
  await new Promise(resolve => setTimeout(resolve, 400));
  const throttled = await waitForStatus(workspace, stateDir, current =>
    current.conversations.other?.reconciliation_status === "ready" &&
    current.conversations.demo?.discovery?.retry_at === "2026-09-24T12:01:00Z");
  assert.equal(throttled.conversations.demo.reconciliation_status, "discovering");
  assert.match(throttled.conversations.demo.discovery.reason, /rate-limited/);
  worker.setClock("2026-09-24T12:00:59Z");
  await new Promise(resolve => setTimeout(resolve, 600));
  assert.equal(readState(workspace.stateDir).fixtures.discord.historyFetches
    .filter(row => row.channelId === "channel").length, 0);
  worker.setClock("2026-09-24T12:01:00Z");
  const ready = await waitForStatus(workspace, stateDir, current =>
    current.conversations.demo?.reconciliation_status === "ready");
  assert.equal(ready.conversations.demo.state, "awaiting-owner");
  assert.equal(ready.conversations.demo.response_at, "2026-09-20T08:05:00Z");
  await stop(workspace, stateDir, worker);
});

async function scanFirstPass(workspace, stateDir, clock) {
  seedHistory(workspace, { channel: longHistory(1150) });
  await command(workspace, stateDir, "discover");
  const worker = startWorker(workspace, stateDir, clock);
  await waitForFixture(workspace, state => fetchCount(state, "channel") === 10);
  await new Promise(resolve => setTimeout(resolve, 400));
  return worker;
}

test("a newer owner reaction observed during scanning wins over the historical answer", async () => {
  const workspace = createWorkspace();
  const stateDir = setup(workspace);
  const worker = await scanFirstPass(workspace, stateDir, "2026-09-20T09:00:00Z");
  injectDiscordReaction(workspace, { channelId: "channel", id: "live-reaction", messageId: "101149",
    emoji: "custom:42", user: { id: "owner" } });
  await waitForState(workspace, state => state.fixtures.discord.deliveredReactions?.some(row => row.id === "live-reaction"));
  await new Promise(resolve => setTimeout(resolve, 400));
  const buffered = await command(workspace, stateDir, "status");
  assert.equal(buffered.conversations.demo.reconciliation_status, "discovering");
  assert.equal(buffered.conversations.demo.last_ack_message_id, null);
  worker.setClock("2026-09-20T09:00:30Z");
  const ready = await waitForStatus(workspace, stateDir, current =>
    current.conversations.demo?.reconciliation_status === "ready");
  assert.equal(ready.conversations.demo.state, "open-paused");
  assert.equal(ready.conversations.demo.due_at, null);
  assert.equal(ready.conversations.demo.last_ack_message_id, "101149");
  await new Promise(resolve => setTimeout(resolve, 600));
  assert.equal(readState(workspace.stateDir).fixtures.discord.messages?.length ?? 0, 0);
  await stop(workspace, stateDir, worker);
});

test("messages arriving during scanning are reconciled forward without counting the owner twice", async () => {
  const workspace = createWorkspace();
  const stateDir = setup(workspace);
  const worker = await scanFirstPass(workspace, stateDir, "2026-09-20T09:00:00Z");
  arrive(workspace, "channel", message("102000", "2026-09-20T09:00:10Z", "owner", "One more thing"));
  await waitForState(workspace, state => state.fixtures.discord.deliveredMessages?.some(row => row.id === "102000"));
  arrive(workspace, "channel", message("102001", "2026-09-20T09:00:20Z", "app-demo", "Handled."));
  await new Promise(resolve => setTimeout(resolve, 400));
  worker.setClock("2026-09-20T09:00:30Z");
  const ready = await waitForStatus(workspace, stateDir, current =>
    current.conversations.demo?.reconciliation_status === "ready");
  assert.equal(ready.conversations.demo.state, "awaiting-owner");
  assert.equal(ready.conversations.demo.last_ack_message_id, "102000");
  assert.equal(ready.conversations.demo.response_message_id, "102001");
  assert.equal(ready.conversations.demo.due_at, "2026-09-20T10:00:20Z");
  await stop(workspace, stateDir, worker);
});

test("an owner /close during scanning closes the conversation and still receives its checkmark", async () => {
  const workspace = createWorkspace();
  const stateDir = setup(workspace);
  const worker = await scanFirstPass(workspace, stateDir, "2026-09-20T09:00:00Z");
  arrive(workspace, "channel", message("102000", "2026-09-20T09:00:10Z", "owner", "/close"));
  await waitForState(workspace, state => state.fixtures.discord.deliveredMessages?.some(row => row.id === "102000"));
  await new Promise(resolve => setTimeout(resolve, 400));
  worker.setClock("2026-09-20T09:00:30Z");
  const ready = await waitForStatus(workspace, stateDir, current =>
    current.conversations.demo?.reconciliation_status === "ready");
  assert.equal(ready.conversations.demo.state, "closed");
  const acknowledged = await waitForState(workspace, state => state.fixtures.discord.reactions?.some(row =>
    row.messageId === "102000" && decodeURIComponent(row.emoji) === "✅"));
  assert.equal(acknowledged.fixtures.discord.reactions.find(row => row.messageId === "102000").authorization,
    "Bot token-demo");
  assert.equal(acknowledged.fixtures.discord.messages?.length ?? 0, 0);
  assert.equal(acknowledged.fixtures.codex.appServerInvocations.length, 0);
  await stop(workspace, stateDir, worker);
});

test("historical eligibility requires an owner reply answered by the assigned bot", async () => {
  const workspace = createWorkspace();
  const cases = {
    guestonly: { history: [["11", "08:01", "bot", "Sure"], ["10", "08:00", "guest", "Can you help?"]],
      state: "open-paused", basis: "no-owner-participation" },
    guestafter: { history: [["24", "08:03", "bot", "Answer for guest"], ["23", "08:02", "guest", "Me too?"],
      ["22", "08:01", "bot", "Answer for owner"], ["21", "08:00", "owner", "Question"]],
    state: "awaiting-owner", basis: "historical-owner-then-bot-approximation", response: "22" },
    waiting: { history: [["31", "08:00", "owner", "Next step?"], ["30", "07:00", "bot", "Old answer"]],
      state: "open-paused", basis: "no-answer-after-reply" },
    command: { history: [["43", "08:01", "bot", "Compaction queued."], ["42", "08:00", "owner", "/compact"],
      ["41", "07:05", "bot", "Answer"], ["40", "07:00", "owner", "Question"]],
    state: "open-paused", basis: "no-answer-after-reply" },
    closed: { history: [["53", "08:05", "bot", "Late answer"], ["52", "08:00", "owner", "/close"],
      ["51", "07:05", "bot", "Answer"], ["50", "07:00", "owner", "Question"]],
    state: "closed", basis: "closed-in-history" },
    closedcmd: { history: [["63", "07:40", "bot", "Answer"],
      ["62", "07:31", "bot", "Bridge paused. New messages will be queued."], ["61", "07:30", "owner", "/pause"],
      ["60", "07:00", "owner", "/close"]], state: "closed", basis: "closed-in-history" },
    reopened: { history: [["72", "08:05", "bot", "Answer"], ["71", "08:00", "owner", "New idea"],
      ["70", "07:00", "owner", "/close"]],
    state: "awaiting-owner", basis: "historical-owner-then-bot-approximation", response: "72" },
    eyes: { history: [["81", "08:05", "bot", "👀"], ["80", "08:00", "owner", "Look at this"]],
      state: "awaiting-owner", basis: "historical-owner-then-bot-approximation", response: "81" },
  };
  const stateDir = setup(workspace, Object.fromEntries(Object.keys(cases).map(name => [name, `${name}-channel`])));
  seedHistory(workspace, Object.fromEntries(Object.entries(cases).map(([name, row]) => [`${name}-channel`,
    row.history.map(([id, time, author, content]) => message(`${name}-${id}`, `2026-09-20T${time}:00Z`,
      author === "bot" ? `app-${name}` : author, content))])));
  await command(workspace, stateDir, "discover");
  const worker = startWorker(workspace, stateDir, "2026-09-20T08:10:00Z");
  const ready = await waitForStatus(workspace, stateDir, current => Object.keys(cases).every(name =>
    current.conversations[name]?.reconciliation_status === "ready"));
  for (const [name, row] of Object.entries(cases)) {
    const current = ready.conversations[name];
    assert.deepEqual([current.state, current.discovery.basis, current.response_message_id],
      [row.state, row.basis, row.response ? `${name}-${row.response}` : null], name);
  }
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.equal(readState(workspace.stateDir).fixtures.discord.messages?.length ?? 0, 0);
  await stop(workspace, stateDir, worker);
});

test("known active-turn progress is not a historical completion until the live turn completes", async () => {
  const workspace = createWorkspace();
  const stateDir = setup(workspace);
  seedHistory(workspace, { channel: [
    message("92", "2026-09-20T08:01:00Z", "app-demo", "Still running the tests…"),
    message("91", "2026-09-20T08:00:00Z", "owner", "Run the suite"),
  ] });
  await adapterEvent(workspace, stateDir, "owner_activity", "owner-91", "2026-09-20T08:00:00Z", {
    actor_id: "owner", source_message_id: "91", activity_kind: "message" });
  await adapterEvent(workspace, stateDir, "response_delivered", "progress-92", "2026-09-20T08:01:00Z", {
    provider_session_id: "session", provider_turn_id: "turn", interaction_id: "91",
    message_id: "92", disposition: "progress" });
  await command(workspace, stateDir, "discover");
  const worker = startWorker(workspace, stateDir, "2026-09-20T08:10:00Z");
  const ready = await waitForStatus(workspace, stateDir, current =>
    current.conversations.demo?.reconciliation_status === "ready");
  assert.equal(ready.conversations.demo.state, "open-paused");
  assert.equal(ready.conversations.demo.discovery.basis, "active-turn");
  assert.equal(ready.conversations.demo.due_at, null);
  await adapterEvent(workspace, stateDir, "turn_completed", "complete-91", "2026-09-20T08:30:00Z", {
    provider_session_id: "session", provider_turn_id: "turn", interaction_id: "91",
    delivered_message_ids: ["92"] });
  const armed = await waitForStatus(workspace, stateDir, current =>
    current.conversations.demo?.state === "awaiting-owner");
  assert.equal(armed.conversations.demo.due_at, "2026-09-20T09:30:00Z");
  await stop(workspace, stateDir, worker);
});

test("owner reaction membership acknowledges only when its ordering is established", async () => {
  const workspace = createWorkspace();
  const names = ["onanswer", "older", "guestreact", "selfonly", "recorded"];
  const stateDir = setup(workspace, Object.fromEntries(names.map(name => [name, `${name}-channel`])));
  const reacted = (emoji, count = 1, me = false) => ({ reactions: [{ emoji, count, me }] });
  const exchange = (name, progressExtra, answerExtra) => [
    message(`${name}-3`, "2026-09-20T08:05:00Z", `app-${name}`, "Done", answerExtra),
    message(`${name}-2`, "2026-09-20T08:01:00Z", `app-${name}`, "Working", progressExtra),
    message(`${name}-1`, "2026-09-20T08:00:00Z", "owner", "Please do it"),
  ];
  seedHistory(workspace, {
    "onanswer-channel": exchange("onanswer", {}, reacted({ name: "👍" })),
    "older-channel": exchange("older", reacted({ name: "party", id: "77" }), {}),
    "guestreact-channel": exchange("guestreact", {}, reacted({ name: "👍" })),
    "selfonly-channel": exchange("selfonly", {}, reacted({ name: "✅" }, 1, true)),
    "recorded-channel": exchange("recorded", reacted({ name: "👀" }), {}),
  }, { reactionUsers: {
    "onanswer-3|👍": ["owner"], "older-2|party:77": ["owner"], "guestreact-3|👍": ["guest"],
    "recorded-2|👀": ["owner"],
  } });
  await adapterEvent(workspace, stateDir, "owner_activity", "recorded-reaction", "2026-09-20T08:02:00Z", {
    project: "recorded", channel_id: "recorded-channel", bot_id: "bot-recorded",
    assignment_generation: "gen-recorded", actor_id: "owner", source_message_id: "recorded-2",
    activity_kind: "reaction" });
  await command(workspace, stateDir, "discover");
  const worker = startWorker(workspace, stateDir, "2026-09-20T08:10:00Z");
  await waitForFixture(workspace, state => state.fixtures.discord.reactionFetches?.length === 4);
  const ready = await waitForStatus(workspace, stateDir, current => names.every(name =>
    current.conversations[name]?.reconciliation_status === "ready"));
  assert.deepEqual(Object.fromEntries(names.map(name => [name,
    [ready.conversations[name].state, ready.conversations[name].discovery.basis]])), {
    onanswer: ["open-paused", "owner-reaction-after-answer"],
    older: ["open-paused", "reaction-ordering-unresolved"],
    guestreact: ["awaiting-owner", "historical-owner-then-bot-approximation"],
    selfonly: ["awaiting-owner", "historical-owner-then-bot-approximation"],
    recorded: ["awaiting-owner", "historical-owner-then-bot-approximation"],
  });
  const lookups = readState(workspace.stateDir).fixtures.discord.reactionFetches;
  assert.deepEqual(lookups.map(row => `${row.messageId}|${row.emoji}`).sort(),
    ["guestreact-3|👍", "older-2|party:77", "onanswer-3|👍", "recorded-2|👀"]);
  assert.ok(lookups.every(row => row.authorization === "Bot fixture-root-token" && row.limit === 100));
  await stop(workspace, stateDir, worker);
});

test("denied history suspends the channel with resumable progress instead of skipping it", async () => {
  const workspace = createWorkspace();
  const stateDir = setup(workspace);
  const worker = await scanFirstPass(workspace, stateDir, "2026-09-24T12:00:00Z");
  const seed = readState(workspace.stateDir);
  seed.fixtures.discord.restFailures = [{ method: "GET", path: "/api/v10/channels/channel/messages", status: 403 }];
  writeState(seed, workspace.stateDir);
  worker.setClock("2026-09-24T12:00:30Z");
  await waitForFixture(workspace, state => state.fixtures.discord.restFailureUses?.length === 1);
  await new Promise(resolve => setTimeout(resolve, 400));
  const suspended = await waitForStatus(workspace, stateDir, current =>
    current.conversations.demo?.reconciliation_status === "suspended-discovery-history");
  assert.deepEqual([suspended.conversations.demo.discovery.resumable, suspended.conversations.demo.discovery.before_id,
    suspended.conversations.demo.discovery.retry_at], [true, "100150", "2026-09-24T12:05:30Z"]);
  assert.match(suspended.conversations.demo.discovery.reason, /denied/);
  worker.setClock("2026-09-24T12:05:29Z");
  await new Promise(resolve => setTimeout(resolve, 600));
  const denied = readState(workspace.stateDir).fixtures.discord;
  assert.deepEqual([denied.historyFetches.length, denied.restFailureUses.length], [10, 1]);
  worker.setClock("2026-09-24T12:05:30Z");
  await waitForFixture(workspace, state => fetchCount(state, "channel") === 13);
  assert.equal(readState(workspace.stateDir).fixtures.discord.historyFetches[10].before, "100150");
  const ready = await waitForStatus(workspace, stateDir, current =>
    current.conversations.demo?.reconciliation_status === "ready");
  assert.equal(ready.conversations.demo.response_message_id, "101149");
  await stop(workspace, stateDir, worker);
});

test("a crashed scan resumes from its last recorded cursor after restart", async () => {
  const workspace = createWorkspace();
  const stateDir = setup(workspace);
  seedHistory(workspace, { channel: longHistory(1150) }, { crashAfterHistoryPages: 5 });
  await command(workspace, stateDir, "discover");
  const first = startWorker(workspace, stateDir, "2026-09-24T12:00:00Z");
  assert.equal((await first.running).exitCode, 2);
  const interrupted = await command(workspace, stateDir, "status");
  assert.deepEqual([interrupted.conversations.demo.reconciliation_status,
    interrupted.conversations.demo.discovery.pages_scanned, interrupted.conversations.demo.discovery.before_id],
  ["discovering", 4, "100750"]);
  const second = startWorker(workspace, stateDir, "2026-09-24T12:00:00Z");
  await waitForState(workspace, state => state.fixtures.discord.historyFetches.length === 10);
  second.setClock("2026-09-24T12:00:30Z");
  // Five first-worker reads (one lost to the crash), then the remaining 8 backward pages and 1 forward page.
  const fetches = (await waitForFixture(workspace, state => fetchCount(state, "channel") === 14))
    .fixtures.discord.historyFetches;
  assert.equal(fetches[5].before, "100750");
  const ready = await waitForStatus(workspace, stateDir, current =>
    current.conversations.demo?.reconciliation_status === "ready");
  assert.equal(ready.conversations.demo.response_message_id, "101149");
  await stop(workspace, stateDir, second);
});

test("an assignment change before commit discards the old scan and rescans the new generation", async () => {
  const workspace = createWorkspace();
  const stateDir = setup(workspace);
  const worker = await scanFirstPass(workspace, stateDir, "2026-09-24T12:00:00Z");
  const changed = await command(workspace, stateDir, "assignment-changed", { args: ["assignment-changed",
    "--project-root", workspace.repoDir, "--state-dir", stateDir, "--project", "demo"] });
  await waitForFixture(workspace, state => fetchCount(state, "channel") >= 19);
  await new Promise(resolve => setTimeout(resolve, 400));
  const rescanned = await waitForStatus(workspace, stateDir, current =>
    current.conversations.demo?.assignment_generation === changed.assignment_generation &&
    current.conversations.demo?.discovery?.pages_scanned === 10);
  assert.equal(rescanned.conversations.demo.reconciliation_status, "discovering");
  assert.ok(readState(workspace.stateDir).fixtures.discord.historyFetches.slice(10)
    .some(row => !row.before && !row.after), "the new generation starts from a fresh watermark");
  assert.ok(rescanned.retired_assignments.some(row => row.assignment_generation === "gen-demo"));
  worker.setClock("2026-09-24T12:00:30Z");
  const ready = await waitForStatus(workspace, stateDir, current =>
    current.conversations.demo?.reconciliation_status === "ready");
  assert.equal(ready.conversations.demo.assignment_generation, changed.assignment_generation);
  assert.equal(ready.conversations.demo.response_message_id, "101149");
  await stop(workspace, stateDir, worker);
});

test("history keeps a persisted closure unless it shows a later normal owner message", async () => {
  const workspace = createWorkspace();
  const stateDir = setup(workspace, { kept: "kept-channel", reopened: "reopened-channel" });
  seedHistory(workspace, {
    // The /close message itself was deleted; only the recorded closure knows it.
    "kept-channel": [message("kept-3", "2026-09-20T09:30:00Z", "app-kept", "Late answer"),
      message("kept-1", "2026-09-20T08:00:00Z", "owner", "Question")],
    "reopened-channel": [message("reopened-3", "2026-09-20T09:30:00Z", "app-reopened", "Answer"),
      message("reopened-2", "2026-09-20T09:20:00Z", "owner", "Actually, one more"),
      message("reopened-1", "2026-09-20T08:00:00Z", "owner", "Question")],
  });
  for (const name of ["kept", "reopened"]) {
    await adapterEvent(workspace, stateDir, "close_requested", `${name}-close`, "2026-09-20T09:00:00Z", {
      project: name, channel_id: `${name}-channel`, bot_id: `bot-${name}`, assignment_generation: `gen-${name}`,
      actor_id: "owner", source_message_id: `${name}-deleted-close`, command: "/close" });
  }
  await command(workspace, stateDir, "discover");
  const worker = startWorker(workspace, stateDir, "2026-09-20T09:40:00Z");
  const ready = await waitForStatus(workspace, stateDir, current => ["kept", "reopened"].every(name =>
    current.conversations[name]?.reconciliation_status === "ready"));
  assert.deepEqual([ready.conversations.kept.state, ready.conversations.kept.discovery.basis],
    ["closed", "persisted-closure"]);
  assert.deepEqual([ready.conversations.reopened.state, ready.conversations.reopened.due_at],
    ["awaiting-owner", "2026-09-20T10:30:00Z"]);
  await stop(workspace, stateDir, worker);
});
