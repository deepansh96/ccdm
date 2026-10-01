import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { runScript } from "./support/runner.js";
import { createBridgeWorkspace, injectDiscordMessage, injectDiscordReaction, startFakeCodexServer } from "./support/bridge.js";
import { OWNER_ID, ROOT_TOKEN, createRouterWorkspace, routerEnv, routerWithWebhooks, waitFor } from "./support/router.js";
import { readState, updateState } from "./support/state.js";
import { cleanup } from "./support/teardown.js";
import { startThreadSupervisor, supervisorStatus } from "./support/thread-supervisor.js";

test.afterEach(async () => cleanup());

// demo and quiet are Router projects; demo also left a retired assignment from
// its old channel.
function setup(workspace) {
  fs.writeFileSync(path.join(workspace.repoDir, "registry.json"), JSON.stringify({
    discord_user_id: "owner", guild_id: "guild",
    projects: {
      demo: { type: "codex", webhook_id: "webhook", channel_id: "channel", assignment_generation: "generation-1" },
      quiet: { type: "codex", webhook_id: "quiet-webhook", channel_id: "quiet-channel",
        assignment_generation: "quiet-generation" },
    },
  }), { mode: 0o600 });
  return path.join(workspace.homeDir, ".local", "state", "ccdm", "conversation-reminders");
}

// A v7 store as the identity-keyed v7 service wrote it, seeded by hand.
const V7_SCHEMA = `
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE conversations (
  project TEXT PRIMARY KEY, channel_id TEXT NOT NULL, identity TEXT NOT NULL,
  assignment_generation TEXT NOT NULL, owner_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('closed','open-paused','awaiting-owner')),
  revision INTEGER NOT NULL, last_ack_at TEXT, last_ack_message_id TEXT,
  current_interaction_id TEXT, response_message_id TEXT, response_at TEXT,
  due_at TEXT, reminder_message_id TEXT, cleanup_message_ids TEXT NOT NULL,
  last_event_order TEXT, reconciliation_status TEXT NOT NULL,
  checkpoint INTEGER NOT NULL DEFAULT 0, consecutive_reminders INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE applied_events (event_id TEXT PRIMARY KEY);
CREATE TABLE owner_sources (project TEXT NOT NULL, assignment_generation TEXT NOT NULL,
  source_message_id TEXT NOT NULL, kind TEXT NOT NULL, PRIMARY KEY(project,assignment_generation,source_message_id));
CREATE TABLE qualifications (project TEXT NOT NULL, assignment_generation TEXT NOT NULL,
  provider_session_id TEXT NOT NULL, provider_turn_id TEXT NOT NULL, kind TEXT NOT NULL,
  response_message_id TEXT NOT NULL, PRIMARY KEY(project,assignment_generation,provider_session_id,
  provider_turn_id,kind,response_message_id));
CREATE TABLE pending_actions (action_id TEXT PRIMARY KEY, project TEXT NOT NULL, kind TEXT NOT NULL,
  message_id TEXT NOT NULL, assignment_generation TEXT NOT NULL, completed INTEGER NOT NULL DEFAULT 0);
CREATE TABLE delivery_intents (nonce TEXT PRIMARY KEY, project TEXT NOT NULL, assignment_generation TEXT NOT NULL,
  revision INTEGER NOT NULL, state TEXT NOT NULL, message_id TEXT, claimed_at TEXT NOT NULL, retry_at TEXT);
CREATE UNIQUE INDEX active_delivery_intent ON delivery_intents(project,assignment_generation)
  WHERE state IN ('sending','uncertain');
CREATE TABLE retired_assignments (project TEXT NOT NULL, assignment_generation TEXT NOT NULL,
  channel_id TEXT NOT NULL, identity TEXT NOT NULL, reason TEXT NOT NULL, retired_at TEXT NOT NULL,
  PRIMARY KEY(project,assignment_generation));
CREATE TABLE retired_leftovers (action_id TEXT PRIMARY KEY, project TEXT NOT NULL,
  assignment_generation TEXT NOT NULL, message_id TEXT NOT NULL, reason TEXT NOT NULL);
CREATE TABLE discoveries (
  project TEXT NOT NULL, assignment_generation TEXT NOT NULL, phase TEXT NOT NULL,
  started_revision INTEGER NOT NULL, watermark_id TEXT, before_id TEXT, after_id TEXT,
  summary_json TEXT NOT NULL, pages_total INTEGER NOT NULL DEFAULT 0,
  reactions_total INTEGER NOT NULL DEFAULT 0, passes INTEGER NOT NULL DEFAULT 0,
  pass_key INTEGER, pass_pages INTEGER NOT NULL DEFAULT 0,
  pass_reactions INTEGER NOT NULL DEFAULT 0, last_seq INTEGER NOT NULL DEFAULT 0,
  pending_request TEXT, retry_at TEXT, reason TEXT, basis TEXT,
  PRIMARY KEY(project,assignment_generation));
CREATE TABLE catch_ups (project TEXT NOT NULL, assignment_generation TEXT NOT NULL, marked_at TEXT NOT NULL,
  PRIMARY KEY(project,assignment_generation));
`;

// demo awaits the owner two reminders into its streak, with a catch-up queued;
// quiet was closed with /close; demo's retired generation still owes a deletion.
const V7_ROWS = `
INSERT INTO settings VALUES ('disabled','0');
INSERT INTO conversations VALUES
  ('demo','channel','router:webhook','generation-1','owner','awaiting-owner',7,'2026-09-24T09:00:00Z','ack-1',
   'question-1','answer-1','2026-09-24T10:00:00Z','2026-09-24T17:00:00Z','r-2','[]','order-4','ready',4,2),
  ('quiet','quiet-channel','router:quiet-webhook','quiet-generation','owner','closed',3,'2026-09-24T08:00:00Z',
   'close-1',NULL,NULL,NULL,NULL,NULL,'[]','order-2','ready',2,0);
INSERT INTO applied_events VALUES ('demo-owner'), ('demo-completion'), ('quiet-close');
INSERT INTO owner_sources VALUES ('demo','generation-1','question-1','owner_activity'),
  ('quiet','quiet-generation','close-1','close_requested');
INSERT INTO qualifications VALUES ('demo','generation-1','session','turn','turn_completed','answer-1');
INSERT INTO pending_actions VALUES
  ('delete:r-old','demo','delete','r-old','generation-0',0),
  ('ack:close-1','quiet','ack','close-1','quiet-generation',1);
INSERT INTO delivery_intents VALUES
  ('nonce-1','demo','generation-1',5,'sent','r-1','2026-09-24T11:00:00Z',NULL),
  ('nonce-2','demo','generation-1',6,'sent','r-2','2026-09-24T13:00:00Z',NULL);
INSERT INTO retired_assignments VALUES
  ('demo','generation-0','old-channel','router:old-webhook','reassigned','2026-09-23T08:00:00Z');
INSERT INTO discoveries (project,assignment_generation,phase,started_revision,watermark_id,summary_json,
  pages_total,reactions_total,passes,basis)
  VALUES ('demo','generation-1','complete',2,'watermark-1','{"mode":"initial"}',3,1,2,'no-missed-activity');
INSERT INTO catch_ups VALUES ('demo','generation-1','2026-09-24T17:00:05Z');
PRAGMA user_version=7;
`;

function sql(database, script) {
  const result = spawnSync("python3", ["-c", `import sqlite3,sys
db=sqlite3.connect(sys.argv[1]); db.executescript(sys.argv[2]); db.close()`, database, script], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

function seedV7(workspace) {
  const stateDir = setup(workspace);
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const database = path.join(stateDir, "conversations.sqlite3");
  sql(database, V7_SCHEMA + V7_ROWS);
  fs.chmodSync(database, 0o600);
  return { stateDir, database };
}

// Every conversation-scoped table, as stored rows in a stable order.
function storeRows(database) {
  const result = spawnSync("python3", ["-c", `import json,sqlite3,sys
db=sqlite3.connect(sys.argv[1]); db.row_factory=sqlite3.Row
tables=["conversations","owner_sources","qualifications","pending_actions","delivery_intents",
        "discoveries","catch_ups","retired_assignments"]
rows={t: sorted((dict(r) for r in db.execute(f"SELECT * FROM {t}")), key=lambda r: json.dumps(r, sort_keys=True))
      for t in tables}
print(json.dumps({"version": db.execute('PRAGMA user_version').fetchone()[0], **rows}))`, database],
  { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

async function cli(workspace, stateDir, name) {
  const result = await runScript(workspace, "scripts/conversation-reminder-service.py", {
    args: [name, "--project-root", workspace.repoDir, "--state-dir", stateDir],
  });
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function backups(stateDir) {
  return fs.readdirSync(stateDir).filter(name => name.includes("backup"));
}

const DEMO = {
  project: "demo", channel_id: "channel", identity: "router:webhook", assignment_generation: "generation-1",
  owner_id: "owner", state: "awaiting-owner", revision: 7, last_ack_at: "2026-09-24T09:00:00Z",
  last_ack_message_id: "ack-1", current_interaction_id: "question-1", response_message_id: "answer-1",
  response_at: "2026-09-24T10:00:00Z", due_at: "2026-09-24T17:00:00Z", reminder_message_id: "r-2",
  cleanup_message_ids: "[]", last_event_order: "order-4", reconciliation_status: "ready",
  checkpoint: 4, consecutive_reminders: 2,
};
const QUIET = {
  project: "quiet", channel_id: "quiet-channel", identity: "router:quiet-webhook",
  assignment_generation: "quiet-generation", owner_id: "owner", state: "closed", revision: 3,
  last_ack_at: "2026-09-24T08:00:00Z", last_ack_message_id: "close-1", current_interaction_id: null,
  response_message_id: null, response_at: null, due_at: null, reminder_message_id: null,
  cleanup_message_ids: "[]", last_event_order: "order-2", reconciliation_status: "ready",
  checkpoint: 2, consecutive_reminders: 0,
};
const DISCOVERY = {
  project: "demo", assignment_generation: "generation-1", phase: "complete", started_revision: 2,
  watermark_id: "watermark-1", before_id: null, after_id: null, summary_json: '{"mode":"initial"}',
  pages_total: 3, reactions_total: 1, passes: 2, pass_key: null, pass_pages: 0, pass_reactions: 0,
  last_seq: 0, pending_request: null, retry_at: null, reason: null, basis: "no-missed-activity",
};

// The v7 rows exactly as seeded.
const V7_STORE = {
  version: 7,
  conversations: [DEMO, QUIET],
  owner_sources: [
    { project: "demo", assignment_generation: "generation-1", source_message_id: "question-1", kind: "owner_activity" },
    { project: "quiet", assignment_generation: "quiet-generation", source_message_id: "close-1", kind: "close_requested" },
  ],
  qualifications: [{ project: "demo", assignment_generation: "generation-1", provider_session_id: "session",
    provider_turn_id: "turn", kind: "turn_completed", response_message_id: "answer-1" }],
  pending_actions: [
    { action_id: "ack:close-1", project: "quiet", kind: "ack", message_id: "close-1",
      assignment_generation: "quiet-generation", completed: 1 },
    { action_id: "delete:r-old", project: "demo", kind: "delete", message_id: "r-old",
      assignment_generation: "generation-0", completed: 0 },
  ],
  delivery_intents: [
    { nonce: "nonce-1", project: "demo", assignment_generation: "generation-1", revision: 5, state: "sent",
      message_id: "r-1", claimed_at: "2026-09-24T11:00:00Z", retry_at: null },
    { nonce: "nonce-2", project: "demo", assignment_generation: "generation-1", revision: 6, state: "sent",
      message_id: "r-2", claimed_at: "2026-09-24T13:00:00Z", retry_at: null },
  ],
  discoveries: [DISCOVERY],
  catch_ups: [{ project: "demo", assignment_generation: "generation-1", marked_at: "2026-09-24T17:00:05Z" }],
  retired_assignments: [{ project: "demo", assignment_generation: "generation-0", channel_id: "old-channel",
    identity: "router:old-webhook", reason: "reassigned", retired_at: "2026-09-23T08:00:00Z" }],
};

// The same rows at v8: each is its project's Channel Conversation, so its
// conversation id is the channel id. The retired generation keeps its old channel.
const V8_STORE = {
  version: 8,
  conversations: [{ ...DEMO, conversation_id: "channel" }, { ...QUIET, conversation_id: "quiet-channel" }],
  owner_sources: [
    { project: "demo", conversation_id: "channel", assignment_generation: "generation-1",
      source_message_id: "question-1", kind: "owner_activity" },
    { project: "quiet", conversation_id: "quiet-channel", assignment_generation: "quiet-generation",
      source_message_id: "close-1", kind: "close_requested" },
  ],
  qualifications: [{ project: "demo", conversation_id: "channel", assignment_generation: "generation-1",
    provider_session_id: "session", provider_turn_id: "turn", kind: "turn_completed",
    response_message_id: "answer-1" }],
  pending_actions: [
    { action_id: "ack:close-1", project: "quiet", conversation_id: "quiet-channel", kind: "ack",
      message_id: "close-1", assignment_generation: "quiet-generation", completed: 1 },
    { action_id: "delete:r-old", project: "demo", conversation_id: "old-channel", kind: "delete",
      message_id: "r-old", assignment_generation: "generation-0", completed: 0 },
  ],
  delivery_intents: [
    { nonce: "nonce-1", project: "demo", conversation_id: "channel", assignment_generation: "generation-1",
      revision: 5, state: "sent", message_id: "r-1", claimed_at: "2026-09-24T11:00:00Z", retry_at: null },
    { nonce: "nonce-2", project: "demo", conversation_id: "channel", assignment_generation: "generation-1",
      revision: 6, state: "sent", message_id: "r-2", claimed_at: "2026-09-24T13:00:00Z", retry_at: null },
  ],
  discoveries: [{ ...DISCOVERY, conversation_id: "channel" }],
  catch_ups: [{ project: "demo", conversation_id: "channel", assignment_generation: "generation-1",
    marked_at: "2026-09-24T17:00:05Z" }],
  retired_assignments: [{ project: "demo", conversation_id: "old-channel", assignment_generation: "generation-0",
    channel_id: "old-channel", identity: "router:old-webhook", reason: "reassigned",
    retired_at: "2026-09-23T08:00:00Z" }],
};

test("a v7 store migrates to v8, keying every row by its Channel Conversation", async () => {
  const workspace = createBridgeWorkspace();
  const { stateDir, database } = seedV7(workspace);
  const status = await cli(workspace, stateDir, "status");
  assert.deepEqual(storeRows(database), V8_STORE);

  // Channel status is unchanged: no conversation id, the same timers and streak.
  const demo = status.conversations.demo;
  assert.equal("conversation_id" in demo, false);
  assert.deepEqual([demo.channel_id, demo.identity, demo.state, demo.due_at, demo.consecutive_reminders,
    demo.reminder_message_id, demo.catch_up_queued],
  ["channel", "router:webhook", "awaiting-owner", "2026-09-24T17:00:00Z", 2, "r-2", true]);
  assert.deepEqual([status.conversations.quiet.state, status.conversations.quiet.last_ack_message_id],
    ["closed", "close-1"]);
  assert.equal(status.retired_assignments[0].channel_id, "old-channel");
});

test("the v7 store is backed up unchanged before migrating, and a v8 store is left alone", async () => {
  const workspace = createBridgeWorkspace();
  const { stateDir, database } = seedV7(workspace);
  await cli(workspace, stateDir, "status");
  assert.deepEqual(backups(stateDir), ["conversations.v7.backup.sqlite3"]);
  const backup = path.join(stateDir, "conversations.v7.backup.sqlite3");
  assert.equal(fs.statSync(backup).mode & 0o777, 0o600);
  assert.deepEqual(storeRows(backup), V7_STORE);

  // Re-running on the v8 store changes nothing and takes no second backup.
  await cli(workspace, stateDir, "sync");
  await cli(workspace, stateDir, "status");
  assert.deepEqual(storeRows(database), V8_STORE);
  assert.deepEqual(backups(stateDir), ["conversations.v7.backup.sqlite3"]);
});

test("a failed v8 migration leaves the v7 store unchanged and usable", async () => {
  const workspace = createBridgeWorkspace();
  const { stateDir, database } = seedV7(workspace);
  // An injected failure aborts the migration after most tables were re-keyed.
  sql(database, `CREATE TRIGGER fail_migration BEFORE UPDATE ON delivery_intents
    BEGIN SELECT RAISE(ABORT, 'injected migration failure'); END;`);
  const failed = await runScript(workspace, "scripts/conversation-reminder-service.py", {
    args: ["status", "--project-root", workspace.repoDir, "--state-dir", stateDir],
  });
  assert.notEqual(failed.exitCode, 0);
  assert.deepEqual(storeRows(database), V7_STORE);
  assert.deepEqual(backups(stateDir), ["conversations.v7.backup.sqlite3"]);

  sql(database, "DROP TRIGGER fail_migration;");
  await cli(workspace, stateDir, "status");
  assert.deepEqual(storeRows(database), V8_STORE);
});

async function ingest(workspace, stateDir, id, fields) {
  const value = {
    schema_version: 1, event_id: id, event_type: "owner_activity", project: "demo", channel_id: "channel",
    bot_id: "router:webhook", assignment_generation: "generation-1", provider: "codex",
    event_time: "2026-09-24T14:00:00Z", event_order: `2026-09-24T14:00:00Z:${id}`,
    adapter_instance_id: "test-adapter", actor_id: "owner", activity_kind: "message", ...fields,
  };
  const result = await runScript(workspace, "scripts/conversation-reminder-events.py", {
    args: ["ingest", "--project-root", workspace.repoDir, "--state-dir", stateDir], input: JSON.stringify(value),
  });
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout).status;
}

test("adapter and observer events may name their conversation, defaulting to the channel", async () => {
  const workspace = createBridgeWorkspace();
  const { stateDir } = seedV7(workspace);
  await cli(workspace, stateDir, "status");
  assert.equal(await ingest(workspace, stateDir, "bad-conversation", { conversation_id: "", source_message_id: "m-0" }),
    "rejected");

  // An adapter message in another conversation never pauses the channel's reminders.
  assert.equal(await ingest(workspace, stateDir, "thread-owner", {
    conversation_id: "thread-1", source_message_id: "thread-message" }), "committed");
  await cli(workspace, stateDir, "sync");
  const waiting = (await cli(workspace, stateDir, "status")).conversations.demo;
  assert.deepEqual([waiting.state, waiting.due_at, waiting.consecutive_reminders, waiting.last_ack_message_id],
    ["awaiting-owner", "2026-09-24T17:00:00Z", 2, "ack-1"]);

  // The root observer naming the channel acts exactly like an event without a conversation.
  assert.equal(await ingest(workspace, stateDir, "channel-owner", {
    provider: "ccdm-root", adapter_instance_id: "root-observer", conversation_id: "channel",
    source_message_id: "channel-message" }), "committed");
  await cli(workspace, stateDir, "sync");
  const paused = (await cli(workspace, stateDir, "status")).conversations.demo;
  assert.deepEqual([paused.state, paused.due_at, paused.consecutive_reminders, paused.last_ack_message_id],
    ["open-paused", null, 0, "channel-message"]);
});

// Thread Conversation reminders end to end: the real Router, Thread
// Supervisor, thread sessions and reminder service, with the fixture claude,
// codex and tmux. The Claude project's own channel session runs too, since
// its adapter readiness gates every reminder for the project.
const THREAD_A = "1700000000000111111";
const THREAD_B = "1700000000000222222";
const ROOT_AUTH = `Bot ${ROOT_TOKEN}`;
const FAST_POLL = { CCDM_THREAD_ARCHIVE_POLL_WINDOW_S: "1.5", CCDM_THREAD_ARCHIVE_POLL_INTERVAL_S: "0.2" };
const owner = { id: OWNER_ID, username: "Owner" };
const guest = { id: "guest-id", username: "Guest" };

function threadReminderWorkspace(type = "claude") {
  const workspace = createRouterWorkspace({
    discord_user_id: OWNER_ID, guild_id: "guild-id",
    projects: { demo: { channel_id: "demo-channel", type, transport: "router", guest_user_ids: ["guest-id"],
      screen_name: "demo_claude", assignment_generation: "gen-demo" } },
  });
  const registryFile = path.join(workspace.repoDir, "registry.json");
  const registry = JSON.parse(fs.readFileSync(registryFile, "utf8"));
  registry.projects.demo.path = workspace.tmpDir;
  fs.writeFileSync(registryFile, `${JSON.stringify(registry, null, 2)}\n`);
  fs.mkdirSync(path.join(workspace.homeDir, ".codex"), { recursive: true });
  const clockFile = path.join(workspace.tmpDir, "reminder-clock");
  const now = Date.now();
  return {
    workspace,
    stateDir: path.join(workspace.homeDir, ".local", "state", "ccdm", "conversation-reminders"),
    // Minutes past the test's start, on the reminder service's clock.
    setClock: minutes => fs.writeFileSync(clockFile,
      new Date(now + minutes * 60000).toISOString().replace(/\.\d{3}Z$/, "Z")),
    env: { CCDM_REMINDER_NODE: process.execPath, CCDM_REMINDER_CLOCK_FILE: clockFile },
  };
}

async function reminderService(context, name) {
  const result = await runScript(context.workspace, "scripts/conversation-reminder-service.py", {
    args: [name, "--project-root", context.workspace.repoDir, "--state-dir", context.stateDir],
    env: routerEnv(context.workspace, context.env),
  });
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

// Claude answers every notification, naming the message it answers.
const ANSWER = [{ name: "reply", arguments: { chat_id: "{{chat_id}}", text: "Here is the answer",
  conversation_interaction_id: "{{message_id}}", conversation_disposition: "progress" } }];

// The Router with demo's webhook, the supervisor, demo's channel session when
// it is a Claude project, and the enabled reminder worker, ready for demo.
async function threadReminders(context, { channelSession = true, supervisorEnv = {}, beforeEnable } = {}) {
  const { workspace } = context;
  updateState(workspace.stateDir, state => {
    state.fixtures.discord.history = { "demo-channel": [] };
    state.fixtures.claude.toolScript = ANSWER;
  });
  await routerWithWebhooks(workspace, ["demo"]);
  if (channelSession) {
    const started = await runScript(workspace, "scripts/start-session.sh", {
      args: ["demo"], env: routerEnv(workspace), timeoutMs: 30000,
    });
    assert.equal(started.exitCode, 0, started.stderr || started.stdout);
  }
  await startThreadSupervisor(workspace, { env: supervisorEnv });
  await beforeEnable?.();
  await reminderService(context, "enable");
  context.setClock(0);
  const running = runScript(workspace, "scripts/conversation-reminder-service.py", {
    args: ["run", "--project-root", workspace.repoDir, "--state-dir", context.stateDir],
    env: routerEnv(workspace, context.env), timeoutMs: 120000,
  });
  const deadline = Date.now() + 20000;
  while ((await reminderService(context, "status")).conversations.demo?.reconciliation_status !== "ready") {
    if (Date.now() > deadline) throw new Error("demo never became ready for reminders");
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return async () => {
    await reminderService(context, "disable");
    const stopped = await running;
    assert.equal(stopped.exitCode, 0, stopped.stderr || stopped.stdout);
  };
}

function createThread(workspace, id, fields = {}) {
  updateState(workspace.stateDir, state => {
    (state.fixtures.discord.injectedThreads ||= []).push({ id, type: 11, parentId: "demo-channel",
      name: `Side task ${id.slice(-6)}`, ownerId: OWNER_ID, autoArchiveDuration: 10080, event: "create", ...fields });
  });
}

async function supervisedThread(workspace, id, predicate = () => true, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await supervisorStatus(workspace);
    const row = last.projects?.demo?.threads?.[id];
    if (row && predicate(row)) return row;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`thread ${id} never matched: ${JSON.stringify(last)}`);
}

const posts = (workspace, channelId) => (readState(workspace.stateDir).fixtures.discord.messages ?? [])
  .filter(message => message.channelId === channelId);
const eyes = (workspace, channelId) => posts(workspace, channelId).filter(message => message.content === "👀");
const agentReplies = (workspace, channelId) => posts(workspace, channelId)
  .filter(message => message.webhookId === "fake-webhook-1");
const settle = () => new Promise(resolve => setTimeout(resolve, 1500));

// A thread whose session answered the owner's first message.
async function answeredThread(context, id, messageId) {
  const { workspace } = context;
  createThread(workspace, id);
  await supervisedThread(workspace, id);
  injectDiscordMessage(workspace, { id: messageId, channelId: id, author: owner, content: "please fix the parser" });
  await waitFor(() => agentReplies(workspace, id).length === 1, () => `the reply in ${id}`, 20000);
  // The Stop hook that ends the turn runs after the reply.
  await waitFor(() => (readState(workspace.stateDir).fixtures.claude.hookRuns ?? [])
    .filter(run => run.event === "Stop").length >= 1, () => "the Stop hook", 10000);
  await settle();
}

test("after a Claude thread turn ends, root reminds in that thread after the hour and never in the channel", async () => {
  const context = threadReminderWorkspace();
  const { workspace } = context;
  const stop = await threadReminders(context);
  await answeredThread(context, THREAD_A, "thread-question-1");

  // Inside the hour nothing is sent.
  context.setClock(59);
  await settle();
  assert.deepEqual(eyes(workspace, THREAD_A), []);

  context.setClock(61);
  await waitFor(() => eyes(workspace, THREAD_A).length === 1, () => "the thread's reminder", 20000);
  const [reminder] = eyes(workspace, THREAD_A);
  assert.deepEqual([reminder.authorization, reminder.requestBody.enforce_nonce], [ROOT_AUTH, true]);
  assert.deepEqual(eyes(workspace, "demo-channel"), []);

  // An ignored reminder backs off: the next one comes two hours after it.
  context.setClock(61 + 119);
  await settle();
  assert.equal(eyes(workspace, THREAD_A).length, 1);
  context.setClock(61 + 121);
  await waitFor(() => eyes(workspace, THREAD_A).length === 2, () => "the second reminder", 20000);
  assert.deepEqual(eyes(workspace, "demo-channel"), []);
  await stop();
});

test("a supervisor notice in a thread is not an agent reply, so it never arms a reminder", async () => {
  const context = threadReminderWorkspace();
  const { workspace } = context;
  const stop = await threadReminders(context);
  await answeredThread(context, THREAD_A, "thread-question-1");

  // The owner's /config acknowledges; the supervisor answers it as the root bot.
  injectDiscordMessage(workspace, { id: "thread-config-1", channelId: THREAD_A, author: owner, content: "/config" });
  await waitFor(() => posts(workspace, THREAD_A).some(message => !message.webhookId && message.content !== "👀"),
    () => "the supervisor's settings notice", 15000);
  const notice = posts(workspace, THREAD_A).find(message => !message.webhookId);
  assert.equal(notice.authorization, ROOT_AUTH);
  await settle();

  context.setClock(24 * 60);
  await settle();
  await settle();
  assert.deepEqual(eyes(workspace, THREAD_A), []);
  await stop();
});

test("an owner reply in one thread acknowledges only that thread, and a guest reply acknowledges nothing", async () => {
  const context = threadReminderWorkspace();
  const { workspace } = context;
  const stop = await threadReminders(context);
  await answeredThread(context, THREAD_A, "thread-a-question");
  await answeredThread(context, THREAD_B, "thread-b-question");
  injectDiscordMessage(workspace, { id: "channel-question", channelId: "demo-channel", author: owner,
    content: "and in the channel?" });
  await waitFor(() => agentReplies(workspace, "demo-channel").length === 1, () => "the channel reply", 20000);
  await settle();

  // From here Claude keeps working without answering.
  updateState(workspace.stateDir, state => {
    delete state.fixtures.claude.toolScript;
  });
  injectDiscordMessage(workspace, { id: "thread-a-ack", channelId: THREAD_A, author: owner, content: "thanks" });
  injectDiscordMessage(workspace, { id: "thread-b-guest", channelId: THREAD_B, author: guest, content: "me too" });
  await settle();

  // Thread reminders are spaced by the 5 s gate.
  context.setClock(61);
  await waitFor(() => eyes(workspace, "demo-channel").length === 1 &&
    eyes(workspace, THREAD_B).length + eyes(workspace, THREAD_A).length === 1, () => "the first reminders", 20000);
  context.setClock(62);
  await settle();
  assert.equal(eyes(workspace, THREAD_B).length, 1);
  assert.deepEqual(eyes(workspace, THREAD_A), []);
  assert.equal(eyes(workspace, "demo-channel").length, 1);
  await stop();
});

test("a reminder posted into an auto-archived thread reopens it without starting a session", async () => {
  const context = threadReminderWorkspace();
  const { workspace } = context;
  const stop = await threadReminders(context, { supervisorEnv: FAST_POLL });
  await answeredThread(context, THREAD_A, "thread-question-1");
  const launched = readState(workspace.stateDir).fixtures.claude.channelServers.length;

  // Discord's inactivity auto-archive: no audit entry names an actor.
  const thread = { id: THREAD_A, type: 11, parentId: "demo-channel", name: "Side task 111111", ownerId: OWNER_ID,
    autoArchiveDuration: 10080 };
  updateState(workspace.stateDir, state => {
    (state.fixtures.discord.injectedThreads ||= []).push({ ...thread, archived: true, event: "update",
      previous: { ...thread, archived: false } });
  });
  await supervisedThread(workspace, THREAD_A, row => row.state === "stopped" && row.stop_reason === "auto-archive");

  context.setClock(61);
  await waitFor(() => eyes(workspace, THREAD_A).length === 1, () => "the reminder in the archived thread", 20000);
  await waitFor(() => readState(workspace.stateDir).fixtures.discord.threads[THREAD_A].archived === false,
    () => "the thread to reopen", 10000);
  await settle();
  const row = await supervisedThread(workspace, THREAD_A);
  assert.deepEqual([row.state, row.stop_reason], ["stopped", "auto-archive"]);
  assert.equal(readState(workspace.stateDir).fixtures.claude.channelServers.length, launched);
  assert.equal(readState(workspace.stateDir).fixtures.tmux.sessions[`demo_claude-t-${THREAD_A}`], undefined);
  await stop();
});

test("after a Codex thread turn ends, root reminds in that thread after the hour and never in the channel", async () => {
  const context = threadReminderWorkspace("codex");
  const { workspace } = context;
  const codex = await startFakeCodexServer(workspace, { port: 29510, deferListen: true,
    codexHome: path.join(workspace.homeDir, ".codex"), channelId: THREAD_A,
    threadId: "0199a5c4-7e1b-7c3d-9f2a-4b8e6d1c3a58", bootstrapPlan: { status: "completed", mcpReplyText: "on it" } });
  const stop = await threadReminders(context, { channelSession: false,
    supervisorEnv: { CCDM_THREAD_WS_PORT_BASE: "29510" } });
  createThread(workspace, THREAD_A);
  await supervisedThread(workspace, THREAD_A);
  injectDiscordMessage(workspace, { id: "thread-question-1", channelId: THREAD_A, author: owner,
    content: "please fix the parser" });
  await supervisedThread(workspace, THREAD_A, row => row.ws_port === 29510);
  await codex.listen();
  await waitFor(() => agentReplies(workspace, THREAD_A).length === 1, () => "the Codex thread's reply", 20000);
  await settle();

  context.setClock(59);
  await settle();
  assert.deepEqual(eyes(workspace, THREAD_A), []);
  context.setClock(61);
  await waitFor(() => eyes(workspace, THREAD_A).length === 1, () => "the Codex thread's reminder", 20000);
  assert.equal(eyes(workspace, THREAD_A)[0].authorization, ROOT_AUTH);
  assert.deepEqual(eyes(workspace, "demo-channel"), []);
  await stop();
});

test("status nests each Thread Conversation under its project, beside the channel's own state", async () => {
  const context = threadReminderWorkspace();
  const stop = await threadReminders(context);
  await answeredThread(context, THREAD_A, "thread-question-1");

  const demo = (await reminderService(context, "status")).conversations.demo;
  assert.deepEqual(Object.keys(demo.threads), [THREAD_A]);
  const thread = demo.threads[THREAD_A];
  assert.deepEqual([thread.state, thread.current_interaction_id, thread.consecutive_reminders,
    thread.reconciliation_status], ["awaiting-owner", "thread-question-1", 0, "ready"]);
  assert.equal(thread.response_message_id, agentReplies(context.workspace, THREAD_A)[0].id);
  // The channel's own conversation is untouched by the thread's turn.
  assert.deepEqual([demo.channel_id, demo.state, demo.current_interaction_id], ["demo-channel", "open-paused", null]);
  await stop();
});

const threadStatus = async (context, id) => (await reminderService(context, "status")).conversations.demo.threads[id];

async function threadStatusMatching(context, id, predicate, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await threadStatus(context, id);
    if (predicate(last)) return last;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`thread ${id}'s reminders never matched: ${JSON.stringify(last)}`);
}

const notices = (workspace, channelId) => posts(workspace, channelId)
  .filter(message => !message.webhookId && message.content !== "👀");

test("an accepted /config provider= resets the thread's reminder tracking, and /clear does not", async () => {
  const context = threadReminderWorkspace();
  const { workspace } = context;
  const codex = await startFakeCodexServer(workspace, { port: 29520, deferListen: true,
    codexHome: path.join(workspace.homeDir, ".codex"), channelId: THREAD_A,
    threadId: "0199a5c4-7e1b-7c3d-9f2a-4b8e6d1c3a59", bootstrapPlan: { status: "completed" } });
  const stop = await threadReminders(context, { supervisorEnv: { CCDM_THREAD_WS_PORT_BASE: "29520" } });
  await answeredThread(context, THREAD_A, "thread-question-1");
  const answered = await threadStatus(context, THREAD_A);
  assert.deepEqual([answered.state, answered.current_interaction_id], ["awaiting-owner", "thread-question-1"]);

  // /clear acknowledges like any command, but the tracked turn stays.
  injectDiscordMessage(workspace, { id: "thread-clear", channelId: THREAD_A, author: owner, content: "/clear" });
  await waitFor(() => notices(workspace, THREAD_A).some(message =>
    message.content === "Starting a fresh conversation in this thread."), () => "the /clear notice", 15000);
  const cleared = await threadStatusMatching(context, THREAD_A, row => row.state === "open-paused");
  assert.deepEqual([cleared.current_interaction_id, cleared.response_message_id],
    ["thread-question-1", answered.response_message_id]);

  // A provider switch takes effect only on the owner's ✅, and then resets the thread.
  injectDiscordMessage(workspace, { id: "thread-switch", channelId: THREAD_A, author: owner,
    content: "/config provider=codex" });
  await waitFor(() => notices(workspace, THREAD_A).some(message => message.content.startsWith("Changing provider")),
    () => "the switch warning", 15000);
  const warning = notices(workspace, THREAD_A).find(message => message.content.startsWith("Changing provider"));
  await settle();
  assert.equal((await threadStatus(context, THREAD_A)).current_interaction_id, "thread-question-1");
  injectDiscordReaction(workspace, { id: "owner-check", channelId: THREAD_A, emoji: "✅", messageId: warning.id,
    user: owner, message: { author: { id: "fixture-bot-user-id", bot: true }, content: warning.content } });
  const reset = await threadStatusMatching(context, THREAD_A, row => row.current_interaction_id === null);
  assert.deepEqual([reset.state, reset.response_message_id, reset.response_at, reset.due_at,
    reset.consecutive_reminders], ["open-paused", null, null, null, 0]);
  await codex.listen();
  await stop();
});

// A Discord snowflake for now: milliseconds since the Discord epoch, shifted 22 bits.
const snowflakeNow = () => String((BigInt(Date.now()) - 1420070400000n) << 22n);

test("a thread /close and an owner archive each close only that thread's reminders", async () => {
  const context = threadReminderWorkspace();
  const { workspace } = context;
  const stop = await threadReminders(context, { supervisorEnv: FAST_POLL });
  await answeredThread(context, THREAD_A, "thread-a-question");
  await answeredThread(context, THREAD_B, "thread-b-question");
  injectDiscordMessage(workspace, { id: "channel-question", channelId: "demo-channel", author: owner,
    content: "and in the channel?" });
  await waitFor(() => agentReplies(workspace, "demo-channel").length === 1, () => "the channel reply", 20000);
  await settle();

  injectDiscordMessage(workspace, { id: "thread-a-close", channelId: THREAD_A, author: owner, content: "/close" });
  await threadStatusMatching(context, THREAD_A, row => row.state === "closed");
  let demo = (await reminderService(context, "status")).conversations.demo;
  assert.deepEqual([demo.state, demo.threads[THREAD_B].state], ["awaiting-owner", "awaiting-owner"]);

  // The owner archives B by hand; the audit log names the owner.
  updateState(workspace.stateDir, state => {
    (state.fixtures.discord.auditLogEntries ||= []).unshift({ id: snowflakeNow(), user_id: OWNER_ID,
      target_id: THREAD_B, action_type: 111, changes: [{ key: "archived", old_value: false, new_value: true }] });
  });
  const threadB = { id: THREAD_B, type: 11, parentId: "demo-channel", name: "Side task 222222", ownerId: OWNER_ID,
    autoArchiveDuration: 10080 };
  updateState(workspace.stateDir, state => {
    (state.fixtures.discord.injectedThreads ||= []).push({ ...threadB, archived: true, event: "update",
      previous: { ...threadB, archived: false } });
  });
  await supervisedThread(workspace, THREAD_B, row => row.state === "closed" && row.close_reason === "owner-archive");
  await threadStatusMatching(context, THREAD_B, row => row.state === "closed");
  demo = (await reminderService(context, "status")).conversations.demo;
  assert.deepEqual([demo.state, demo.due_at !== null], ["awaiting-owner", true]);

  // Past the hour only the channel is reminded.
  context.setClock(61);
  await waitFor(() => eyes(workspace, "demo-channel").length === 1, () => "the channel's reminder", 20000);
  await settle();
  assert.deepEqual([eyes(workspace, THREAD_A), eyes(workspace, THREAD_B)], [[], []]);
  await stop();
});

test("a thread delete drops its reminder state and leaves its siblings and the channel alone", async () => {
  const context = threadReminderWorkspace();
  const { workspace } = context;
  const stop = await threadReminders(context);
  await answeredThread(context, THREAD_A, "thread-a-question");
  await answeredThread(context, THREAD_B, "thread-b-question");

  updateState(workspace.stateDir, state => {
    (state.fixtures.discord.injectedThreads ||= []).push({ id: THREAD_A, type: 11, parentId: "demo-channel",
      name: "Side task 111111", ownerId: OWNER_ID, event: "delete" });
  });
  const deadline = Date.now() + 20000;
  let demo;
  while (THREAD_A in (demo = (await reminderService(context, "status")).conversations.demo).threads) {
    if (Date.now() > deadline) throw new Error(`thread A's reminders were never dropped: ${JSON.stringify(demo)}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.deepEqual(Object.keys(demo.threads), [THREAD_B]);
  assert.equal(demo.threads[THREAD_B].state, "awaiting-owner");

  // Past the hour only the surviving thread is reminded.
  context.setClock(61);
  await waitFor(() => eyes(workspace, THREAD_B).length === 1, () => "thread B's reminder", 20000);
  await settle();
  assert.deepEqual(eyes(workspace, THREAD_A), []);
  await stop();
});

const THREAD_BLOCKERS = [
  "root lacks Create Public Threads in the project channel; grant root permission Create Public Threads in demo-channel",
  "root lacks Manage Threads in the project channel; grant root permission Manage Threads in demo-channel",
  "root lacks View Audit Log in the guild; grant root permission View Audit Log in guild guild-id",
];

test("readiness reports root's missing thread permissions only while threads are enabled", async () => {
  const context = threadReminderWorkspace();
  const { workspace } = context;
  updateState(workspace.stateDir, state => {
    state.fixtures.discord.permissionDenials = { "fixture-bot-user-id":
      ["CreatePublicThreads", "ManageThreads", "ViewAuditLog"] };
  });
  await routerWithWebhooks(workspace, ["demo"]);
  await reminderService(context, "sync");
  const routerBlockers = async () => (await reminderService(context, "status")).readiness.projects.demo.router.blockers;
  const registryFile = path.join(workspace.repoDir, "registry.json");
  const editRegistry = edit => {
    const registry = JSON.parse(fs.readFileSync(registryFile, "utf8"));
    edit(registry);
    fs.writeFileSync(registryFile, `${JSON.stringify(registry, null, 2)}\n`);
  };

  // Threads are not enabled: no supervisor plist, no caps, no supervisor.
  assert.deepEqual(await routerBlockers(), []);

  // `thread_session_caps` in the registry enables them.
  editRegistry(registry => { registry.thread_session_caps = { claude: 6, codex: 8 }; });
  assert.deepEqual(await routerBlockers(), THREAD_BLOCKERS);
  editRegistry(registry => { delete registry.thread_session_caps; });
  assert.deepEqual(await routerBlockers(), []);

  // So does the supervisor's LaunchAgent plist.
  const plist = path.join(workspace.homeDir, "Library", "LaunchAgents", "com.ccdm.thread-supervisor.plist");
  fs.mkdirSync(path.dirname(plist), { recursive: true });
  fs.writeFileSync(plist, "<plist/>\n");
  assert.deepEqual(await routerBlockers(), THREAD_BLOCKERS);
  fs.rmSync(plist);
  assert.deepEqual(await routerBlockers(), []);

  // And so does a connected supervisor.
  const supervisor = await startThreadSupervisor(workspace);
  assert.deepEqual(await routerBlockers(), THREAD_BLOCKERS);
  await supervisor.stop();

  // Granted, nothing is reported.
  updateState(workspace.stateDir, state => { delete state.fixtures.discord.permissionDenials; });
  editRegistry(registry => { registry.thread_session_caps = { claude: 6, codex: 8 }; });
  assert.deepEqual(await routerBlockers(), []);
});

const THREAD_C = "1700000000000333333";
const THREAD_D = "1700000000000444444";

// The owner asked and the project's agent answered, minutes ago: newest first, as Discord pages history.
function answeredHistory(id) {
  const at = minutes => new Date(Date.now() - minutes * 60000).toISOString();
  return [
    { id: `${id}-answer`, timestamp: at(5), type: 0, content: "Here is the answer", webhook_id: "fake-webhook-1",
      author: { id: "fake-webhook-1", username: "demo", bot: true } },
    { id: `${id}-question`, timestamp: at(10), type: 0, content: "please fix the parser", author: owner },
  ];
}

test("enable discovery adopts active and recently archived open threads, and skips closed and older ones", async () => {
  const context = threadReminderWorkspace();
  const { workspace } = context;
  const day = 24 * 3600000;
  const stop = await threadReminders(context, { supervisorEnv: FAST_POLL, beforeEnable: async () => {
    // D was bound, then the owner archived it yesterday: its conversation is closed.
    createThread(workspace, THREAD_D);
    await supervisedThread(workspace, THREAD_D);
    updateState(workspace.stateDir, state => {
      (state.fixtures.discord.auditLogEntries ||= []).unshift({ id: snowflakeNow(), user_id: OWNER_ID,
        target_id: THREAD_D, action_type: 111, changes: [{ key: "archived", old_value: false, new_value: true }] });
    });
    const threadD = { id: THREAD_D, type: 11, parentId: "demo-channel", name: "Side task 444444",
      ownerId: OWNER_ID, autoArchiveDuration: 10080 };
    updateState(workspace.stateDir, state => {
      state.fixtures.discord.injectedThreads.push({ ...threadD, archived: true,
        archiveTimestamp: new Date(Date.now() - day).toISOString(), event: "update",
        previous: { ...threadD, archived: false } });
    });
    await supervisedThread(workspace, THREAD_D, row => row.state === "closed");
    // A is active, B was archived a day ago and C eight days ago.
    const thread = (id, fields) => ({ id, type: 11, parentId: "demo-channel", name: `Side task ${id.slice(-6)}`,
      ownerId: OWNER_ID, autoArchiveDuration: 10080, ...fields });
    updateState(workspace.stateDir, state => {
      Object.assign(state.fixtures.discord.threads, {
        [THREAD_A]: thread(THREAD_A, { archived: false }),
        [THREAD_B]: thread(THREAD_B, { archived: true, archiveTimestamp: new Date(Date.now() - day).toISOString() }),
        [THREAD_C]: thread(THREAD_C, { archived: true,
          archiveTimestamp: new Date(Date.now() - 8 * day).toISOString() }),
      });
      for (const id of [THREAD_A, THREAD_B, THREAD_C, THREAD_D]) state.fixtures.discord.history[id] = answeredHistory(id);
    });
  } });

  const demo = (await reminderService(context, "status")).conversations.demo;
  assert.deepEqual(Object.keys(demo.threads), [THREAD_A, THREAD_B]);
  for (const id of [THREAD_A, THREAD_B]) {
    const row = demo.threads[id];
    assert.deepEqual([row.state, row.current_interaction_id, row.response_message_id, row.reconciliation_status,
      row.discovery.phase], ["awaiting-owner", `${id}-question`, `${id}-answer`, "ready", "complete"]);
  }
  const read = new Set((readState(workspace.stateDir).fixtures.discord.historyFetches ?? [])
    .map(fetch => fetch.channelId));
  assert.deepEqual([read.has(THREAD_A), read.has(THREAD_B), read.has(THREAD_C), read.has(THREAD_D)],
    [true, true, false, false]);
  await stop();
});
