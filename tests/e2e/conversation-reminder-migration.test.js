import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { createWorkspace, runScript } from "./support/runner.js";
import { bridgeChildEnv, waitForState } from "./support/bridge.js";
import { cleanup } from "./support/teardown.js";

test.afterEach(async () => cleanup());

// The schema a v6 service wrote, before stores were keyed by conversation.
const V6_SCHEMA = `
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE conversations (
  project TEXT PRIMARY KEY, channel_id TEXT NOT NULL, bot_id TEXT NOT NULL,
  assignment_generation TEXT NOT NULL, owner_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('closed','open-paused','awaiting-owner')),
  revision INTEGER NOT NULL, last_ack_at TEXT, last_ack_message_id TEXT,
  current_interaction_id TEXT, response_message_id TEXT, response_at TEXT,
  due_at TEXT, reminder_message_id TEXT, cleanup_message_ids TEXT NOT NULL,
  last_event_order TEXT, reconciliation_status TEXT NOT NULL,
  checkpoint INTEGER NOT NULL DEFAULT 0, consecutive_reminders INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE applied_events (event_id TEXT PRIMARY KEY);
CREATE TABLE owner_sources (
  project TEXT NOT NULL, assignment_generation TEXT NOT NULL,
  source_message_id TEXT NOT NULL, kind TEXT NOT NULL,
  PRIMARY KEY(project,assignment_generation,source_message_id)
);
CREATE TABLE qualifications (
  project TEXT NOT NULL, assignment_generation TEXT NOT NULL,
  provider_session_id TEXT NOT NULL, provider_turn_id TEXT NOT NULL,
  kind TEXT NOT NULL, response_message_id TEXT NOT NULL,
  PRIMARY KEY(project,assignment_generation,provider_session_id,provider_turn_id,kind,response_message_id)
);
CREATE TABLE pending_actions (
  action_id TEXT PRIMARY KEY, project TEXT NOT NULL, kind TEXT NOT NULL,
  message_id TEXT NOT NULL, assignment_generation TEXT NOT NULL, completed INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE delivery_intents (
  nonce TEXT PRIMARY KEY, project TEXT NOT NULL, assignment_generation TEXT NOT NULL,
  revision INTEGER NOT NULL, state TEXT NOT NULL, message_id TEXT,
  claimed_at TEXT NOT NULL, retry_at TEXT
);
CREATE UNIQUE INDEX active_delivery_intent ON delivery_intents(project,assignment_generation)
  WHERE state IN ('sending','uncertain');
CREATE TABLE retired_assignments (
  project TEXT NOT NULL, assignment_generation TEXT NOT NULL,
  channel_id TEXT NOT NULL, bot_id TEXT NOT NULL, reason TEXT NOT NULL, retired_at TEXT NOT NULL,
  PRIMARY KEY(project,assignment_generation)
);
CREATE TABLE retired_leftovers (
  action_id TEXT PRIMARY KEY, project TEXT NOT NULL, assignment_generation TEXT NOT NULL,
  message_id TEXT NOT NULL, reason TEXT NOT NULL
);
CREATE TABLE discoveries (
  project TEXT NOT NULL, assignment_generation TEXT NOT NULL, phase TEXT NOT NULL,
  started_revision INTEGER NOT NULL, watermark_id TEXT, before_id TEXT, after_id TEXT,
  summary_json TEXT NOT NULL, pages_total INTEGER NOT NULL DEFAULT 0,
  reactions_total INTEGER NOT NULL DEFAULT 0, passes INTEGER NOT NULL DEFAULT 0,
  pass_key INTEGER, pass_pages INTEGER NOT NULL DEFAULT 0,
  pass_reactions INTEGER NOT NULL DEFAULT 0, last_seq INTEGER NOT NULL DEFAULT 0,
  pending_request TEXT, retry_at TEXT, reason TEXT, basis TEXT,
  PRIMARY KEY(project,assignment_generation)
);
CREATE TABLE catch_ups (
  project TEXT NOT NULL, assignment_generation TEXT NOT NULL, marked_at TEXT NOT NULL,
  PRIMARY KEY(project,assignment_generation)
);
`;

// demo awaits the owner after two ignored reminders; quiet was closed with /close;
// moved was reassigned to a new channel and bot, and still owes its retired reminder's deletion.
const V6_ROWS = `
INSERT INTO settings VALUES ('disabled','0'), ('discovery_requested','1');
INSERT INTO conversations VALUES
  ('demo','channel','bot','generation-1','owner','awaiting-owner',7,'2026-09-24T09:00:00Z','question-1',
   'question-1','answer-1','2026-09-24T10:00:00Z','2026-09-24T17:00:00Z','r-2','[]','order-4','ready',4,2),
  ('quiet','quiet-channel','quiet-bot','quiet-generation','owner','closed',3,'2026-09-24T08:00:00Z','close-1',
   NULL,NULL,NULL,NULL,NULL,'[]','order-2','ready',2,0),
  ('moved','moved-channel','moved-bot','moved-generation-2','owner','open-paused',0,NULL,NULL,
   NULL,NULL,NULL,NULL,NULL,'[]',NULL,'ready',0,0);
INSERT INTO applied_events VALUES ('demo-owner'), ('demo-completion'), ('quiet-close');
INSERT INTO owner_sources VALUES ('demo','generation-1','question-1','owner_activity'),
  ('quiet','quiet-generation','close-1','close_requested');
INSERT INTO qualifications VALUES ('demo','generation-1','session','turn','turn_completed','answer-1');
INSERT INTO pending_actions VALUES
  ('delete:moved-old-reminder','moved','delete','moved-old-reminder','moved-generation-1',0),
  ('ack:close-1','quiet','ack','close-1','quiet-generation',1);
INSERT INTO delivery_intents VALUES
  ('nonce-1','demo','generation-1',5,'sent','r-1','2026-09-24T11:00:00Z',NULL),
  ('nonce-2','demo','generation-1',6,'sent','r-2','2026-09-24T13:00:00Z',NULL);
INSERT INTO retired_assignments VALUES
  ('moved','moved-generation-1','old-moved-channel','old-moved-bot','reassigned','2026-09-23T12:00:00Z');
INSERT INTO discoveries (project,assignment_generation,phase,started_revision,watermark_id,summary_json,
  pages_total,reactions_total,passes,basis)
  VALUES ('demo','generation-1','complete',2,'watermark-1','{"mode":"initial"}',3,1,2,'no-missed-activity');
PRAGMA user_version=6;
`;

function registry(workspace) {
  fs.writeFileSync(path.join(workspace.repoDir, "registry.json"), JSON.stringify({
    discord_user_id: "owner", guild_id: "guild",
    pool: [{ id: "bot", app_id: "app", token: "fixture-token" },
      { id: "quiet-bot", app_id: "quiet-app", token: "quiet-token" },
      { id: "moved-bot", app_id: "moved-app", token: "moved-token" },
      { id: "old-moved-bot", app_id: "old-moved-app", token: "old-moved-token" }],
    projects: {
      demo: { type: "codex", bot_id: "bot", channel_id: "channel", assignment_generation: "generation-1" },
      quiet: { type: "codex", bot_id: "quiet-bot", channel_id: "quiet-channel", assignment_generation: "quiet-generation" },
      moved: { type: "codex", bot_id: "moved-bot", channel_id: "moved-channel", assignment_generation: "moved-generation-2" },
    },
  }), { mode: 0o600 });
}

function seedV6(workspace) {
  registry(workspace);
  const stateDir = path.join(workspace.homeDir, ".local", "state", "ccdm", "conversation-reminders");
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const database = path.join(stateDir, "conversations.sqlite3");
  sql(database, V6_SCHEMA + V6_ROWS);
  fs.chmodSync(database, 0o600);
  return { stateDir, database };
}

function sql(database, script) {
  const result = spawnSync("python3", ["-c", `import sqlite3,sys
db=sqlite3.connect(sys.argv[1]); db.executescript(sys.argv[2]); db.close()`, database, script], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

function userVersion(database) {
  const result = spawnSync("python3", ["-c",
    "import sqlite3,sys; print(sqlite3.connect(sys.argv[1]).execute('PRAGMA user_version').fetchone()[0])", database],
  { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return Number(result.stdout.trim());
}

async function cli(workspace, stateDir, name, args = [], env = {}) {
  const result = await runScript(workspace, "scripts/conversation-reminder-service.py", {
    args: [name, "--project-root", workspace.repoDir, "--state-dir", stateDir, ...args], env,
  });
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

const MIGRATED = {
  demo: {
    channel_id: "channel", assignment_generation: "generation-1", state: "awaiting-owner", revision: 7,
    last_ack_at: "2026-09-24T09:00:00Z", last_ack_message_id: "question-1", current_interaction_id: "question-1",
    response_message_id: "answer-1", response_at: "2026-09-24T10:00:00Z", due_at: "2026-09-24T17:00:00Z",
    consecutive_reminders: 2, reminder_message_id: "r-2", cleanup_message_ids: [],
    reconciliation_status: "ready", checkpoint: 4, catch_up_queued: false,
    discovery: { phase: "complete", basis: "no-missed-activity", mode: "initial", limitation: null,
      resumable: false, pages_scanned: 3, reaction_checks: 1, passes: 2, watermark_id: "watermark-1",
      before_id: null, after_id: null, retry_at: null, reason: null },
  },
  quiet: {
    channel_id: "quiet-channel", assignment_generation: "quiet-generation", state: "closed", revision: 3,
    last_ack_at: "2026-09-24T08:00:00Z", last_ack_message_id: "close-1", current_interaction_id: null,
    response_message_id: null, response_at: null, due_at: null, consecutive_reminders: 0,
    reminder_message_id: null, cleanup_message_ids: [], reconciliation_status: "ready", checkpoint: 2,
    catch_up_queued: false, discovery: null,
  },
  moved: {
    channel_id: "moved-channel", assignment_generation: "moved-generation-2", state: "open-paused", revision: 0,
    last_ack_at: null, last_ack_message_id: null, current_interaction_id: null, response_message_id: null,
    response_at: null, due_at: null, consecutive_reminders: 0, reminder_message_id: null,
    cleanup_message_ids: [], reconciliation_status: "ready", checkpoint: 0, catch_up_queued: false, discovery: null,
  },
};

test("a v6 store migrates to v7 with every Channel Conversation's due time, closure, and streak intact", async () => {
  const workspace = createWorkspace();
  const { stateDir, database } = seedV6(workspace);
  const migrated = await cli(workspace, stateDir, "status");
  assert.equal(userVersion(database), 7);
  assert.deepEqual(migrated.conversations, MIGRATED);
  assert.deepEqual(migrated.retired_assignments.map(row => [row.project, row.assignment_generation,
    row.channel_id, row.cleanup.pending]), [["moved", "moved-generation-1", "old-moved-channel", ["moved-old-reminder"]]]);
  assert.deepEqual(migrated.pending_actions,
    [{ project: "moved", kind: "delete", message_id: "moved-old-reminder" }]);

  // The worker keeps delivering from the migrated state: demo's third reminder is due at
  // 17:00 and the next waits six hours; the retired reminder is deleted with its own bot.
  const rootState = path.join(workspace.homeDir, "root-discord");
  fs.mkdirSync(rootState, { recursive: true });
  fs.writeFileSync(path.join(rootState, ".env"), "DISCORD_BOT_TOKEN=fixture-root-token\n", { mode: 0o600 });
  const clockFile = path.join(workspace.tmpDir, "reminder-clock");
  fs.writeFileSync(clockFile, "2026-09-24T17:00:00Z");
  const running = runScript(workspace, "scripts/conversation-reminder-service.py", {
    args: ["run", "--project-root", workspace.repoDir, "--state-dir", stateDir],
    env: bridgeChildEnv(workspace, { ROOT_DISCORD_STATE_DIR: rootState,
      CCDM_REMINDER_NODE: process.execPath, CCDM_REMINDER_CLOCK_FILE: clockFile }),
    timeoutMs: 15000,
  });
  const observed = await waitForState(workspace, state => state.fixtures.discord.messages.length === 1 &&
    (state.fixtures.discord.deletes || []).length === 2);
  const [reminder] = observed.fixtures.discord.messages;
  assert.deepEqual([reminder.channelId, reminder.content, reminder.authorization],
    ["channel", "👀", "Bot fixture-token"]);
  assert.deepEqual(observed.fixtures.discord.deletes.map(row => [row.channelId, row.messageId, row.authorization])
    .sort(), [["channel", "r-2", "Bot fixture-token"], ["old-moved-channel", "moved-old-reminder", "Bot old-moved-token"]]);
  await cli(workspace, stateDir, "disable");
  assert.equal((await running).exitCode, 0);
  const after = (await cli(workspace, stateDir, "status")).conversations;
  assert.deepEqual([after.demo.due_at, after.demo.consecutive_reminders, after.quiet.state],
    ["2026-09-24T23:00:00Z", 3, "closed"]);
});

function schema(database) {
  const result = spawnSync("python3", ["-c", `import json,sqlite3,sys
db=sqlite3.connect(sys.argv[1])
print(json.dumps(db.execute("SELECT type,name,sql FROM sqlite_master ORDER BY name").fetchall()))`, database],
  { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("a second start on a v7 store changes nothing, and an unknown future version is refused", async () => {
  const workspace = createWorkspace();
  const { stateDir, database } = seedV6(workspace);
  const first = await cli(workspace, stateDir, "sync");
  const migrated = schema(database);
  assert.ok(migrated.some(([type, name, text]) => type === "table" && name === "conversations" &&
    /PRIMARY KEY\s*\(project,\s*conversation_id\)/.test(text)), "conversations are keyed by project and conversation");
  assert.deepEqual(await cli(workspace, stateDir, "sync"), first);
  assert.deepEqual(schema(database), migrated);
  assert.equal(userVersion(database), 7);
  assert.deepEqual((await cli(workspace, stateDir, "status")).conversations, MIGRATED);

  sql(database, "PRAGMA user_version=8;");
  const refused = await runScript(workspace, "scripts/conversation-reminder-service.py", {
    args: ["status", "--project-root", workspace.repoDir, "--state-dir", stateDir],
  });
  assert.equal(refused.exitCode, 2);
  assert.deepEqual(JSON.parse(refused.stdout), { status: "blocked", reason: "conversation store schema is unsupported" });
});

function adapterEvent(id, fields = {}) {
  return {
    schema_version: 1, event_id: id, event_type: "owner_activity", project: "demo", channel_id: "channel",
    bot_id: "bot", assignment_generation: "generation-1", provider: "codex",
    event_time: "2026-09-24T12:00:00Z", event_order: `2026-09-24T12:00:00Z:${id}`,
    adapter_instance_id: "test-adapter", actor_id: "owner", source_message_id: `${id}-message`,
    activity_kind: "message", ...fields,
  };
}

async function ingest(workspace, stateDir, value) {
  const result = await runScript(workspace, "scripts/conversation-reminder-events.py", {
    args: ["ingest", "--project-root", workspace.repoDir, "--state-dir", stateDir], input: JSON.stringify(value),
  });
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

test("an event for another conversation or a retired generation is stale and changes nothing", async () => {
  const workspace = createWorkspace();
  const { stateDir } = seedV6(workspace);
  const wrongConversation = await ingest(workspace, stateDir,
    adapterEvent("other-conversation", { conversation_id: "thread-1" }));
  assert.deepEqual([wrongConversation.status, wrongConversation.event_id], ["stale", "other-conversation"]);
  const retired = await ingest(workspace, stateDir, adapterEvent("retired-generation", {
    project: "moved", channel_id: "moved-channel", bot_id: "moved-bot", assignment_generation: "moved-generation-1",
  }));
  assert.deepEqual([retired.status, retired.event_id], ["stale", "retired-generation"]);
  assert.equal((await cli(workspace, stateDir, "sync")).applied, 0);
  assert.deepEqual((await cli(workspace, stateDir, "status")).conversations, MIGRATED);
  // The Channel Conversation's own id is its channel id.
  const matching = await ingest(workspace, stateDir, adapterEvent("channel-conversation", { conversation_id: "channel" }));
  assert.equal(matching.status, "committed");
  assert.equal((await cli(workspace, stateDir, "sync")).applied, 1);
  assert.equal((await cli(workspace, stateDir, "status")).conversations.demo.last_ack_message_id,
    "channel-conversation-message");
});

test("an event buffered before the upgrade, without a conversation_id, applies to the Channel Conversation", async () => {
  const workspace = createWorkspace();
  const { stateDir } = seedV6(workspace);
  assert.equal((await ingest(workspace, stateDir, adapterEvent("pre-upgrade-reply"))).status, "committed");
  await cli(workspace, stateDir, "sync");
  const status = await cli(workspace, stateDir, "status");
  const demo = status.conversations.demo;
  assert.deepEqual([demo.state, demo.due_at, demo.consecutive_reminders, demo.reminder_message_id,
    demo.cleanup_message_ids, demo.last_ack_message_id],
  ["open-paused", null, 0, null, ["r-2"], "pre-upgrade-reply-message"]);
  assert.deepEqual(status.pending_actions, [
    { project: "moved", kind: "delete", message_id: "moved-old-reminder" },
    { project: "demo", kind: "delete", message_id: "r-2" }]);
});
