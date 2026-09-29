import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { runScript } from "./support/runner.js";
import { OWNER_ID, ROOT_TOKEN, createRouterWorkspace, routerEnv, runRouterCli, startRouter } from "./support/router.js";
import { readState, writeState } from "./support/state.js";
import { cleanup } from "./support/teardown.js";

test.afterEach(async () => cleanup());

// Switching a project between the Bot Pool and the Router: the real reminder
// service CLI, the real Router, and the fake Discord. `ensure-webhook` gives
// demo `fake-webhook-1`; root's Gateway user is `fixture-bot-user-id`.
function switchWorkspace(demo = {}) {
  const workspace = createRouterWorkspace({
    discord_user_id: OWNER_ID,
    guild_id: "guild-id",
    pool: [{ id: "bot", app_id: "app", token: "pool-bot-token", assigned_to: "demo" }],
    projects: { demo: { type: "codex", bot_id: "bot", channel_id: "demo-channel", assignment_generation: "gen-1",
      screen_name: "demo_codex", ...demo } },
  });
  fs.mkdirSync(path.join(workspace.homeDir, ".codex"), { recursive: true });
  const clockFile = path.join(workspace.tmpDir, "reminder-clock");
  fs.writeFileSync(clockFile, "2026-09-24T11:00:00Z");
  return {
    workspace,
    stateDir: path.join(workspace.homeDir, ".local", "state", "ccdm", "conversation-reminders"),
    setClock: (value) => fs.writeFileSync(clockFile, value),
    env: routerEnv(workspace, { CCDM_REMINDER_NODE: process.execPath, CCDM_REMINDER_CLOCK_FILE: clockFile }),
  };
}

const registryFile = (context) => path.join(context.workspace.repoDir, "registry.json");
const readRegistry = (context) => JSON.parse(fs.readFileSync(registryFile(context), "utf8"));
const writeRegistry = (context, registry) => fs.writeFileSync(registryFile(context), JSON.stringify(registry, null, 2));

async function service(context, name, args = []) {
  const result = await runScript(context.workspace, "scripts/conversation-reminder-service.py", {
    args: [name, "--project-root", context.workspace.repoDir, "--state-dir", context.stateDir, ...args],
    env: context.env,
  });
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

async function event(context, type, id, time, fields) {
  const value = { schema_version: 1, event_id: id, event_type: type, project: "demo", channel_id: "demo-channel",
    bot_id: "bot", assignment_generation: "gen-1", provider: "codex", event_time: time,
    event_order: `${time}:${id}`, adapter_instance_id: "test-adapter", ...fields };
  const result = await runScript(context.workspace, "scripts/conversation-reminder-events.py", {
    args: ["ingest", "--project-root", context.workspace.repoDir, "--state-dir", context.stateDir],
    input: JSON.stringify(value), env: context.env,
  });
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.equal(JSON.parse(result.stdout).status, "committed");
}

// The pool bot answered the owner's question at 10:00; the owner has not replied.
async function awaitingOwner(context) {
  await event(context, "owner_activity", "owner-1", "2026-09-24T09:00:00Z",
    { actor_id: OWNER_ID, source_message_id: "question", activity_kind: "message" });
  const turn = { provider_session_id: "session", provider_turn_id: "turn", interaction_id: "question" };
  await event(context, "response_delivered", "receipt-1", "2026-09-24T10:00:00Z",
    { ...turn, message_id: "answer", disposition: "progress" });
  await event(context, "turn_completed", "completion-1", "2026-09-24T10:00:00Z",
    { ...turn, delivered_message_ids: ["answer"] });
  await service(context, "sync");
  // Discovery belongs to its own suite; seed only its outcome.
  const seeded = spawnSync("python3", ["-c", "import sqlite3,sys; db=sqlite3.connect(sys.argv[1]); db.execute(\"UPDATE conversations SET reconciliation_status='ready'\"); db.commit()",
    path.join(context.stateDir, "conversations.sqlite3")], { encoding: "utf8" });
  assert.equal(seeded.status, 0, seeded.stderr);
}

async function waitForStatus(context, predicate) {
  for (let attempt = 0; attempt < 300; attempt++) {
    const current = await service(context, "status");
    if (predicate(current)) return current;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for status: ${JSON.stringify(await service(context, "status"))}`);
}

function startWorker(context) {
  return runScript(context.workspace, "scripts/conversation-reminder-service.py", {
    args: ["run", "--project-root", context.workspace.repoDir, "--state-dir", context.stateDir],
    env: context.env, timeoutMs: 60000,
  });
}

async function stopWorker(context, running) {
  await service(context, "disable");
  const result = await running;
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
}

// Waits for the worker to record a reminder other than `previous`.
async function nextReminder(context, previous) {
  const current = await waitForStatus(context, (next) => next.conversations.demo?.reminder_message_id &&
    next.conversations.demo.reminder_message_id !== previous);
  const id = current.conversations.demo.reminder_message_id;
  return { id, status: current, sent: readState(context.workspace.stateDir).fixtures.discord.messages.find((row) => row.id === id) };
}

const deletes = (context) => (readState(context.workspace.stateDir).fixtures.discord.deletes ?? [])
  .map((row) => [row.messageId, row.authorization]);

test("switching to the Router retires the pool reminder with the pool bot, and root reminds under the webhook identity", async () => {
  const context = switchWorkspace();
  await awaitingOwner(context);
  await startRouter(context.workspace);
  const running = startWorker(context);
  const pooled = await nextReminder(context, null);
  assert.deepEqual([pooled.sent.channelId, pooled.sent.authorization, pooled.sent.content],
    ["demo-channel", "Bot pool-bot-token", "👀"]);

  const ensured = await runRouterCli(context.workspace, ["ensure-webhook", "demo"]);
  assert.equal(ensured.exitCode, 0, ensured.stderr || ensured.stdout);
  const registry = readRegistry(context);
  registry.projects.demo.transport = "router";
  writeRegistry(context, registry);
  // Until the generation changes, nothing is sent and status names the fix.
  const pending = await service(context, "status");
  assert.equal(pending.conversations.demo.identity, "pool:bot");
  assert.ok(pending.readiness.projects.demo.blockers.includes(
    "assignment: the project's transport changed; run assignment-changed --project demo"));

  const changed = await service(context, "assignment-changed", ["--project", "demo"]);
  assert.deepEqual(changed.retired_generations, ["gen-1"]);
  assert.notEqual(changed.assignment_generation, "gen-1");
  assert.equal(readRegistry(context).projects.demo.assignment_generation, changed.assignment_generation);
  // Either the change workflow or the running worker deletes it, always as the pool bot.
  assert.deepEqual([...changed.retired_cleanup.completed, ...changed.retired_cleanup.inaccessible], [pooled.id]);
  await waitForStatus(context, (current) => current.retired_assignments?.find((row) =>
    row.assignment_generation === "gen-1")?.cleanup.completed.includes(pooled.id));
  assert.deepEqual([...new Set(deletes(context).map(String))], [[pooled.id, "Bot pool-bot-token"]].map(String));
  // The open conversation keeps its state under the new identity.
  const switched = (await service(context, "status")).conversations.demo;
  assert.deepEqual([switched.identity, switched.assignment_generation, switched.state, switched.response_message_id,
    switched.reminder_message_id],
  ["router:fake-webhook-1", changed.assignment_generation, "awaiting-owner", "answer", null]);

  // Two hours after the first reminder, root sends the next one.
  context.setClock("2026-09-24T13:01:00Z");
  const routed = await nextReminder(context, pooled.id);
  assert.deepEqual([routed.sent.channelId, routed.sent.authorization, routed.sent.content],
    ["demo-channel", `Bot ${ROOT_TOKEN}`, "👀"]);
  assert.equal(routed.status.conversations.demo.identity, "router:fake-webhook-1");
  await stopWorker(context, running);
});

test("rolling back to the pool issues another generation, retires root's reminder, and the pool bot reminds again", async () => {
  const context = switchWorkspace();
  await awaitingOwner(context);
  await startRouter(context.workspace);
  const ensured = await runRouterCli(context.workspace, ["ensure-webhook", "demo"]);
  assert.equal(ensured.exitCode, 0, ensured.stderr || ensured.stdout);
  const registry = readRegistry(context);
  registry.projects.demo.transport = "router";
  writeRegistry(context, registry);
  const forward = await service(context, "assignment-changed", ["--project", "demo"]);
  const running = startWorker(context);
  const routed = await nextReminder(context, null);
  assert.deepEqual([routed.sent.authorization, routed.status.conversations.demo.identity],
    [`Bot ${ROOT_TOKEN}`, "router:fake-webhook-1"]);

  const rollback = readRegistry(context);
  delete rollback.projects.demo.transport;
  writeRegistry(context, rollback);
  const back = await service(context, "assignment-changed", ["--project", "demo"]);
  assert.deepEqual(back.retired_generations, [forward.assignment_generation]);
  assert.ok(![forward.assignment_generation, "gen-1"].includes(back.assignment_generation));
  await waitForStatus(context, (current) => current.retired_assignments?.find((row) =>
    row.assignment_generation === forward.assignment_generation)?.cleanup.completed.includes(routed.id));
  assert.deepEqual([...new Set(deletes(context).map(String))], [[routed.id, `Bot ${ROOT_TOKEN}`]].map(String));
  const restored = (await service(context, "status")).conversations.demo;
  assert.deepEqual([restored.identity, restored.assignment_generation, restored.state, restored.reminder_message_id],
    ["pool:bot", back.assignment_generation, "awaiting-owner", null]);

  context.setClock("2026-09-24T13:01:00Z");
  const pooled = await nextReminder(context, routed.id);
  assert.deepEqual([pooled.sent.channelId, pooled.sent.authorization, pooled.sent.content],
    ["demo-channel", "Bot pool-bot-token", "👀"]);
  assert.equal(pooled.status.conversations.demo.identity, "pool:bot");
  await stopWorker(context, running);
});

const routerBlockers = (report) => report.readiness.projects.demo.router;

test("status and preflight name each missing router prerequisite with its fix, and show ready once all are present", async () => {
  const context = switchWorkspace({ transport: "router" });
  const preflight = async () => {
    const result = await runScript(context.workspace, "scripts/conversation-reminder-service.py", {
      args: ["preflight", "--project-root", context.workspace.repoDir, "--state-dir", context.stateDir],
      env: context.env,
    });
    return { exitCode: result.exitCode, ...JSON.parse(result.stdout) };
  };
  await service(context, "enable");

  // No Router and no webhook yet.
  const missing = [
    "demo: the Router is not reachable; start the Router (scripts/install-router-service.sh, or scripts/router.js serve)",
    "demo: the project's webhook is missing; run scripts/router.js ensure-webhook demo",
  ];
  assert.deepEqual(routerBlockers(await service(context, "status")),
    { ready: false, blockers: missing.map((line) => line.slice("demo: ".length)) });
  const blocked = await preflight();
  assert.equal(blocked.exitCode, 2);
  assert.equal(blocked.status, "blocked");
  assert.deepEqual(blocked.blockers, missing);

  // The Router is up and the webhook exists, but root lacks two permissions in the channel.
  const ensured = await runRouterCli(context.workspace, ["ensure-webhook", "demo"]);
  assert.equal(ensured.exitCode, 0, ensured.stderr || ensured.stdout);
  const denied = readState(context.workspace.stateDir);
  denied.fixtures.discord.permissionDenials = { "fixture-bot-user-id": ["AddReactions", "ManageMessages"] };
  writeState(denied, context.workspace.stateDir);
  await startRouter(context.workspace);
  const permissions = [
    "demo: root lacks Add Reactions in the project channel; grant root permission Add Reactions in demo-channel",
    "demo: root lacks Manage Messages in the project channel; grant root permission Manage Messages in demo-channel",
  ];
  assert.deepEqual(routerBlockers(await service(context, "status")),
    { ready: false, blockers: permissions.map((line) => line.slice("demo: ".length)) });
  assert.deepEqual((await preflight()).blockers, permissions);

  const granted = readState(context.workspace.stateDir);
  delete granted.fixtures.discord.permissionDenials;
  writeState(granted, context.workspace.stateDir);
  assert.deepEqual(routerBlockers(await service(context, "status")), { ready: true, blockers: [] });
  const ready = await preflight();
  assert.deepEqual([ready.exitCode, ready.status, ready.blockers], [0, "ok", []]);
});
