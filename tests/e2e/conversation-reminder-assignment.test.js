import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { createWorkspace, runScript } from "./support/runner.js";
import { bridgeChildEnv, waitForState } from "./support/bridge.js";
import { readState, writeState } from "./support/state.js";
import { cleanup } from "./support/teardown.js";

test.afterEach(async () => cleanup());

function writeRegistry(workspace, registry) {
  fs.writeFileSync(path.join(workspace.repoDir, "registry.json"), JSON.stringify(registry), { mode: 0o600 });
}

function readRegistry(workspace) {
  return JSON.parse(fs.readFileSync(path.join(workspace.repoDir, "registry.json"), "utf8"));
}

function baseRegistry() {
  return {
    discord_user_id: "owner", guild_id: "guild",
    pool: [
      { id: "bot", app_id: "app", token: "fixture-token", assigned_to: "demo" },
      { id: "bot2", app_id: "app2", token: "fixture-token-2", assigned_to: null },
    ],
    projects: { demo: { type: "codex", bot_id: "bot", channel_id: "channel", assignment_generation: "generation-1" } },
  };
}

function setup(workspace) {
  writeRegistry(workspace, baseRegistry());
  const rootState = path.join(workspace.homeDir, "root-discord");
  fs.mkdirSync(rootState, { recursive: true });
  fs.writeFileSync(path.join(rootState, ".env"), "DISCORD_BOT_TOKEN=fixture-root-token\n", { mode: 0o600 });
  const clockFile = path.join(workspace.tmpDir, "reminder-clock");
  fs.writeFileSync(clockFile, "2026-09-24T11:00:00Z");
  return {
    stateDir: path.join(workspace.homeDir, ".local", "state", "ccdm", "conversation-reminders"),
    clockFile,
    env: bridgeChildEnv(workspace, { ROOT_DISCORD_STATE_DIR: rootState,
      CCDM_REMINDER_NODE: process.execPath, CCDM_REMINDER_CLOCK_FILE: clockFile }),
  };
}

async function command(workspace, stateDir, name, extra = {}) {
  const { args = [], ...options } = extra;
  const result = await runScript(workspace, "scripts/conversation-reminder-service.py", {
    args: [name, "--project-root", workspace.repoDir, "--state-dir", stateDir, ...args], ...options,
  });
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

async function event(workspace, stateDir, type, id, time, fields = {}) {
  const value = {
    schema_version: 1, event_id: id, event_type: type, project: "demo", channel_id: "channel",
    bot_id: "bot", assignment_generation: "generation-1", provider: "codex",
    event_time: time, event_order: `${time}:${id}`, adapter_instance_id: "test-adapter",
    ...fields,
  };
  const result = await runScript(workspace, "scripts/conversation-reminder-events.py", {
    args: ["ingest", "--project-root", workspace.repoDir, "--state-dir", stateDir], input: JSON.stringify(value),
  });
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout).status;
}

async function awaitingExchange(workspace, stateDir, fields = {}) {
  const owner = { actor_id: "owner", source_message_id: "question", activity_kind: "message", ...fields };
  assert.equal(await event(workspace, stateDir, "owner_activity", `owner-${fields.bot_id || "bot"}`,
    "2026-09-24T09:00:00Z", owner), "committed");
  const turn = { provider_session_id: "session", provider_turn_id: "turn", interaction_id: "question", ...fields };
  assert.equal(await event(workspace, stateDir, "response_delivered", `receipt-${fields.bot_id || "bot"}`,
    "2026-09-24T10:00:00Z", { ...turn, message_id: "answer", disposition: "progress" }), "committed");
  assert.equal(await event(workspace, stateDir, "turn_completed", `completion-${fields.bot_id || "bot"}`,
    "2026-09-24T10:00:00Z", { ...turn, delivered_message_ids: ["answer"] }), "committed");
  await command(workspace, stateDir, "sync");
}

// Discovery and restart reconciliation belong to a later slice. Seed only that
// prerequisite and drive every assignment transition through executable surfaces.
function markReconciled(stateDir) {
  const database = path.join(stateDir, "conversations.sqlite3");
  const seeded = spawnSync("python3", ["-c", "import sqlite3,sys; db=sqlite3.connect(sys.argv[1]); db.execute(\"UPDATE conversations SET reconciliation_status='ready' WHERE project='demo'\"); db.commit()", database], { encoding: "utf8" });
  assert.equal(seeded.status, 0, seeded.stderr);
}

async function waitForStatus(workspace, stateDir, predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const current = await command(workspace, stateDir, "status");
    if (predicate(current)) return current;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for reminder status: ${JSON.stringify(await command(workspace, stateDir, "status"))}`);
}

function startWorker(workspace, context) {
  return runScript(workspace, "scripts/conversation-reminder-service.py", {
    args: ["run", "--project-root", workspace.repoDir, "--state-dir", context.stateDir],
    env: context.env, timeoutMs: 15000,
  });
}

async function stopWorker(workspace, context, running) {
  await command(workspace, context.stateDir, "disable");
  const result = await running;
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
}

test("idle reassignment retires the old generation and removes its reminder with the old bot only", async () => {
  const workspace = createWorkspace();
  const context = setup(workspace);
  await awaitingExchange(workspace, context.stateDir);
  markReconciled(context.stateDir);
  const running = startWorker(workspace, context);
  await waitForState(workspace, state => state.fixtures.discord.messages?.length === 1);
  await waitForStatus(workspace, context.stateDir, current =>
    current.conversations.demo?.reminder_message_id === "fake-message-1");

  const registry = readRegistry(workspace);
  registry.pool[0].assigned_to = null;
  registry.pool[1].assigned_to = "demo";
  registry.projects.demo.bot_id = "bot2";
  registry.projects.demo.assignment_generation = "generation-2";
  writeRegistry(workspace, registry);

  await waitForState(workspace, state => state.fixtures.discord.deletes?.length === 1);
  const retired = await waitForStatus(workspace, context.stateDir, current =>
    current.retired_assignments?.[0]?.cleanup.completed.includes("fake-message-1"));
  assert.deepEqual(retired.retired_assignments.map(row => [row.project, row.assignment_generation, row.bot_id]),
    [["demo", "generation-1", "bot"]]);
  const current = retired.conversations.demo;
  assert.equal(current.assignment_generation, "generation-2");
  assert.equal(current.state, "open-paused");
  assert.equal(current.due_at, null);
  assert.equal(current.reminder_message_id, null);

  fs.writeFileSync(context.clockFile, "2026-09-24T12:00:00Z");
  await new Promise(resolve => setTimeout(resolve, 700));
  const discord = readState(workspace.stateDir).fixtures.discord;
  assert.equal(discord.messages.length, 1);
  assert.deepEqual(discord.deletes.map(row => [row.messageId, row.authorization]),
    [["fake-message-1", "Bot fixture-token"]]);
  await stopWorker(workspace, context, running);
});

test("deregistration during an in-flight send removes the late reminder and never sends again", async () => {
  const workspace = createWorkspace();
  const context = setup(workspace);
  await awaitingExchange(workspace, context.stateDir);
  markReconciled(context.stateDir);
  const seed = readState(workspace.stateDir);
  seed.fixtures.discord.restResponseDelayMs = 800;
  writeState(seed, workspace.stateDir);
  const running = startWorker(workspace, context);
  await waitForState(workspace, state => state.fixtures.discord.responsePending === true);

  const registry = readRegistry(workspace);
  registry.pool[0].assigned_to = null;
  delete registry.projects.demo;
  writeRegistry(workspace, registry);

  await waitForState(workspace, state => state.fixtures.discord.deletes?.length === 1);
  const retired = await waitForStatus(workspace, context.stateDir, current =>
    current.retired_assignments?.[0]?.cleanup.completed.includes("fake-message-1"));
  assert.equal(retired.retired_assignments[0].reason, "deregistered");
  assert.equal(retired.conversations.demo, undefined);
  fs.writeFileSync(context.clockFile, "2026-09-24T13:00:00Z");
  await new Promise(resolve => setTimeout(resolve, 700));
  const discord = readState(workspace.stateDir).fixtures.discord;
  assert.equal(discord.messages.length, 1);
  assert.deepEqual(discord.deletes.map(row => [row.messageId, row.authorization]),
    [["fake-message-1", "Bot fixture-token"]]);
  assert.equal(discord.reactions?.length || 0, 0);
  await stopWorker(workspace, context, running);
});

test("a registry change after a delivery claim cancels it before any Discord request", async () => {
  const workspace = createWorkspace();
  const context = setup(workspace);
  await awaitingExchange(workspace, context.stateDir);
  markReconciled(context.stateDir);
  const claimed = await command(workspace, context.stateDir, "claim", { env: context.env });
  assert.equal(typeof claimed.claim.nonce, "string");

  const registry = readRegistry(workspace);
  registry.projects.demo.bot_id = "bot2";
  registry.projects.demo.assignment_generation = "generation-2";
  writeRegistry(workspace, registry);

  const checked = await command(workspace, context.stateDir, "validate",
    { args: ["--nonce", claimed.claim.nonce], env: context.env });
  assert.equal(checked.valid, false);
  const current = await command(workspace, context.stateDir, "status");
  assert.deepEqual(current.retired_assignments.map(row => [row.assignment_generation, row.reason]),
    [["generation-1", "reassigned"]]);
  assert.deepEqual(current.retired_assignments[0].unresolved_nonces, []);
  assert.equal(current.conversations.demo.assignment_generation, "generation-2");
  assert.deepEqual(readState(workspace.stateDir).fixtures.discord.messages ?? [], []);
});

async function reassignAfterReminder(workspace, context, mutate) {
  await awaitingExchange(workspace, context.stateDir);
  markReconciled(context.stateDir);
  const running = startWorker(workspace, context);
  await waitForState(workspace, state => state.fixtures.discord.messages?.length === 1);
  await waitForStatus(workspace, context.stateDir, current =>
    current.conversations.demo?.reminder_message_id === "fake-message-1");
  const registry = readRegistry(workspace);
  registry.projects.demo.bot_id = "bot2";
  registry.projects.demo.assignment_generation = "generation-2";
  registry.pool[1].assigned_to = "demo";
  registry.pool[0].assigned_to = null;
  mutate(registry);
  writeRegistry(workspace, registry);
  return { running };
}

test("revoked retired credentials report the leftover reminder without borrowing another bot", async () => {
  const workspace = createWorkspace();
  const context = setup(workspace);
  const seed = readState(workspace.stateDir);
  seed.fixtures.discord.restFailures = [];
  writeState(seed, workspace.stateDir);
  const { running } = await reassignAfterReminder(workspace, context, () => {
    const failing = readState(workspace.stateDir);
    failing.fixtures.discord.restFailures = [{ method: "DELETE", status: 401 }];
    writeState(failing, workspace.stateDir);
  });
  await waitForState(workspace, state => state.fixtures.discord.restFailureUses?.length === 1);
  const reported = await waitForStatus(workspace, context.stateDir, current =>
    current.retired_assignments?.[0]?.cleanup.inaccessible.length === 1);
  assert.deepEqual(reported.retired_assignments[0].cleanup, {
    pending: [], completed: [],
    inaccessible: [{ message_id: "fake-message-1", reason: "retired bot credentials were rejected" }],
  });
  await new Promise(resolve => setTimeout(resolve, 600));
  const discord = readState(workspace.stateDir).fixtures.discord;
  assert.deepEqual(discord.deletes.map(row => row.authorization), ["Bot fixture-token"]);
  assert.equal(discord.messages[0].deleted, undefined);
  assert.doesNotMatch(JSON.stringify(reported), /fixture-token/);
  await stopWorker(workspace, context, running);
});

test("a retired bot now serving another channel is not used for old cleanup", async () => {
  const workspace = createWorkspace();
  const context = setup(workspace);
  const { running } = await reassignAfterReminder(workspace, context, registry => {
    registry.projects.other = { type: "codex", bot_id: "bot", channel_id: "other-channel",
      assignment_generation: "other-generation" };
    registry.pool[0].assigned_to = "other";
  });
  const reported = await waitForStatus(workspace, context.stateDir, current =>
    current.retired_assignments?.[0]?.cleanup.inaccessible.length === 1);
  assert.equal(reported.retired_assignments[0].cleanup.inaccessible[0].reason,
    "retired bot is now authorized for another assignment");
  await new Promise(resolve => setTimeout(resolve, 600));
  const discord = readState(workspace.stateDir).fixtures.discord;
  assert.equal(discord.deletes?.length || 0, 0);
  assert.equal(discord.messages.length, 1);
  await stopWorker(workspace, context, running);
});

test("the generation contract gives an identical re-registration a new generation and rejects old events", async () => {
  const workspace = createWorkspace();
  const context = setup(workspace);
  await awaitingExchange(workspace, context.stateDir);
  markReconciled(context.stateDir);
  // Polling never observed this delete/re-add: the adapter queued an old event
  // before the registration workflow called the generation contract.
  assert.equal(await event(workspace, context.stateDir, "owner_activity", "queued-old", "2026-09-24T10:30:00Z",
    { actor_id: "owner", source_message_id: "queued-old-message", activity_kind: "message" }), "committed");
  const before = fs.statSync(path.join(workspace.repoDir, "registry.json")).mode & 0o777;

  const changed = await command(workspace, context.stateDir, "assignment-changed", { args: ["--project", "demo"] });
  assert.equal(changed.status, "changed");
  assert.deepEqual(changed.retired_generations, ["generation-1"]);
  const registry = readRegistry(workspace);
  assert.equal(registry.projects.demo.assignment_generation, changed.assignment_generation);
  assert.notEqual(changed.assignment_generation, "generation-1");
  assert.equal(registry.pool[0].token, "fixture-token");
  assert.equal(fs.statSync(path.join(workspace.repoDir, "registry.json")).mode & 0o777, before);
  assert.doesNotMatch(JSON.stringify(changed), /fixture-token/);

  assert.equal(await event(workspace, context.stateDir, "turn_completed", "replayed-old", "2026-09-24T10:40:00Z", {
    provider_session_id: "session", provider_turn_id: "turn", interaction_id: "question",
    delivered_message_ids: ["answer"],
  }), "stale");
  await command(workspace, context.stateDir, "sync");
  const current = await command(workspace, context.stateDir, "status");
  assert.equal(current.conversations.demo.assignment_generation, changed.assignment_generation);
  assert.equal(current.conversations.demo.state, "open-paused");
  assert.equal(current.conversations.demo.due_at, null);
  assert.equal(current.conversations.demo.last_ack_message_id, null);
  assert.equal(current.conversations.demo.reconciliation_status, "suspended-incomplete-discovery");
  assert.deepEqual(current.retired_assignments.map(row => [row.assignment_generation, row.reason]),
    [["generation-1", "assignment-changed"]]);
});

test("an observed deregistration blocks an identical re-add until a new generation is issued", async () => {
  const workspace = createWorkspace();
  const context = setup(workspace);
  await awaitingExchange(workspace, context.stateDir);
  const original = readRegistry(workspace);
  const removed = readRegistry(workspace);
  delete removed.projects.demo;
  removed.pool[0].assigned_to = null;
  writeRegistry(workspace, removed);
  await command(workspace, context.stateDir, "sync");
  writeRegistry(workspace, original);
  await command(workspace, context.stateDir, "sync");
  // The identical identity lets the adapter commit, but its old generation stays retired.
  assert.equal(await event(workspace, context.stateDir, "owner_activity", "revived-owner", "2026-09-24T11:00:00Z",
    { actor_id: "owner", source_message_id: "revived-message", activity_kind: "message" }), "committed");
  await command(workspace, context.stateDir, "sync");
  const blocked = await command(workspace, context.stateDir, "status");
  assert.equal(blocked.conversations.demo.reconciliation_status, "blocked-retired-generation");
  assert.equal(blocked.conversations.demo.state, "open-paused");
  assert.equal(blocked.conversations.demo.due_at, null);
  assert.equal(blocked.conversations.demo.last_ack_message_id, null);
  assert.match(blocked.assignment_guidance, /assignment-changed --project demo/);

  const changed = await command(workspace, context.stateDir, "assignment-changed", { args: ["--project", "demo"] });
  const renewed = await command(workspace, context.stateDir, "status");
  assert.equal(renewed.conversations.demo.assignment_generation, changed.assignment_generation);
  assert.equal(renewed.conversations.demo.reconciliation_status, "suspended-incomplete-discovery");
  assert.equal(renewed.assignment_guidance, null);
});

test("an ambiguous registry suspends a ready channel and restoring it does not resume blindly", async () => {
  const workspace = createWorkspace();
  const context = setup(workspace);
  fs.writeFileSync(context.clockFile, "2026-09-24T10:59:00Z");
  await awaitingExchange(workspace, context.stateDir);
  markReconciled(context.stateDir);
  const running = startWorker(workspace, context);
  await waitForState(workspace, state => state.fixtures.discord.logins?.length === 1);
  const original = readRegistry(workspace);
  const ambiguous = readRegistry(workspace);
  ambiguous.projects.twin = { type: "codex", bot_id: "bot2", channel_id: "channel", assignment_generation: "twin-1" };
  ambiguous.pool[1].assigned_to = "twin";
  writeRegistry(workspace, ambiguous);
  const suspended = await waitForStatus(workspace, context.stateDir, current =>
    current.conversations.demo?.reconciliation_status === "suspended-assignment");
  assert.equal(suspended.conversations.demo.state, "awaiting-owner");
  assert.equal(suspended.conversations.twin, undefined);
  writeRegistry(workspace, original);
  fs.writeFileSync(context.clockFile, "2026-09-24T11:00:00Z");
  await new Promise(resolve => setTimeout(resolve, 800));
  const current = await command(workspace, context.stateDir, "status");
  assert.equal(current.conversations.demo.reconciliation_status, "suspended-assignment");
  assert.equal(current.conversations.demo.assignment_generation, "generation-1");
  assert.equal(readState(workspace.stateDir).fixtures.discord.messages?.length || 0, 0);
  await stopWorker(workspace, context, running);
});

test("lost root observation access found at a registry change suspends delivery before it is due", async () => {
  const workspace = createWorkspace();
  const context = setup(workspace);
  fs.writeFileSync(context.clockFile, "2026-09-24T10:59:00Z");
  await awaitingExchange(workspace, context.stateDir);
  markReconciled(context.stateDir);
  const running = startWorker(workspace, context);
  await waitForStatus(workspace, context.stateDir, current =>
    current.observer_channels.demo === "ready-observe-only");
  const denied = readState(workspace.stateDir);
  denied.fixtures.discord.permissionDenials = { "fixture-bot-user-id": ["ReadMessageHistory"] };
  writeState(denied, workspace.stateDir);
  const registry = readRegistry(workspace);
  registry.projects.other = { type: "codex", bot_id: "bot2", channel_id: "other-channel",
    assignment_generation: "other-1" };
  registry.pool[1].assigned_to = "other";
  writeRegistry(workspace, registry);

  const suspended = await waitForStatus(workspace, context.stateDir, current =>
    current.conversations.demo?.reconciliation_status === "suspended-observation-access" &&
    current.observer_channels.demo === "blocked-observation-access");
  assert.equal(suspended.conversations.demo.state, "awaiting-owner");
  fs.writeFileSync(context.clockFile, "2026-09-24T11:00:00Z");
  await new Promise(resolve => setTimeout(resolve, 800));
  const discord = readState(workspace.stateDir).fixtures.discord;
  assert.equal(discord.messages?.length || 0, 0);
  assert.equal((discord.permissionOverwrites || []).length, 0);
  await stopWorker(workspace, context, running);
});

test("project stop and root restart keep the independent service and closed state", async () => {
  const workspace = createWorkspace();
  const context = setup(workspace);
  const registry = readRegistry(workspace);
  registry.pool[0].state_dir = path.join(workspace.homeDir, ".claude", "channels", "discord2");
  registry.projects.demo = { ...registry.projects.demo, path: path.join(workspace.tmpDir, "demo"),
    screen_name: "demo_codex", ws_port: 18342, session_id: "existing-session", pid: null };
  writeRegistry(workspace, registry);
  assert.equal(await event(workspace, context.stateDir, "close_requested", "close-before-stop",
    "2026-09-24T10:00:00Z", { actor_id: "owner", source_message_id: "close-message", command: "/close" }),
  "committed");
  await command(workspace, context.stateDir, "sync");
  const running = startWorker(workspace, context);
  await waitForStatus(workspace, context.stateDir, current =>
    current.worker_running && current.conversations.demo?.state === "closed");

  const stopped = await runScript(workspace, "scripts/stop-session.sh", { args: ["demo"] });
  assert.equal(stopped.exitCode, 0, stopped.stderr || stopped.stdout);
  const restarted = await runScript(workspace, "restart-root-agent.sh");
  assert.equal(restarted.exitCode, 0, restarted.stderr || restarted.stdout);

  const current = await command(workspace, context.stateDir, "status");
  assert.equal(current.worker_running, true);
  assert.equal(current.conversations.demo.state, "closed");
  assert.equal(current.conversations.demo.assignment_generation, "generation-1");
  assert.deepEqual(current.retired_assignments, []);
  await stopWorker(workspace, context, running);
});

test("a remote Codex channel without a deployed adapter stays visibly unsupported", async () => {
  const workspace = createWorkspace();
  const context = setup(workspace);
  const registry = readRegistry(workspace);
  registry.projects.demo.path = "remote:example-host:/srv/demo";
  writeRegistry(workspace, registry);
  const readiness = await runScript(workspace, "scripts/conversation-reminder-readiness.py", {
    args: ["demo", "--json", "--project-root", workspace.repoDir, "--state-dir", context.stateDir],
  });
  assert.equal(readiness.exitCode, 2);
  assert.match(JSON.parse(readiness.stdout).unsupported_capabilities.join(" "), /remote Codex adapter deployment/);
  await command(workspace, context.stateDir, "sync");
  const running = startWorker(workspace, context);
  const observed = await waitForStatus(workspace, context.stateDir, current =>
    current.observer_channels.demo === "blocked-adapter-capability");
  assert.equal(observed.conversations.demo.reconciliation_status, "suspended-incomplete-discovery");
  await stopWorker(workspace, context, running);
});
