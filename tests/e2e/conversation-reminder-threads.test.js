import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { runScript } from "./support/runner.js";
import { createBridgeWorkspace } from "./support/bridge.js";
import { cleanup } from "./support/teardown.js";

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
