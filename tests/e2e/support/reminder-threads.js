// Shared setup for the Thread Conversation reminder suites: conversation-reminder-threads
// and conversation-reminder-thread-lifecycle.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { PYTHON } from "./platform.js";
import { runScript } from "./runner.js";
import { injectDiscordMessage } from "./bridge.js";
import { OWNER_ID, ROOT_TOKEN, createRouterWorkspace, routerEnv, routerWithWebhooks, waitFor } from "./router.js";
import { readState, updateState } from "./state.js";
import { startThreadHost, startThreadSupervisor, supervisorEnv, supervisorStatus } from "./thread-supervisor.js";

export const WIN = process.platform === "win32";

export const { ensurePrivateDirSync } = createRequire(import.meta.url)("../../../scripts/platform/privacy.js");

// demo and quiet are Router projects; demo also left a retired assignment from
// its old channel.
export function setup(workspace) {
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
export const V7_SCHEMA = `
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
export const V7_ROWS = `
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

export function sql(database, script) {
  const result = spawnSync(PYTHON, ["-c", `import sqlite3,sys
db=sqlite3.connect(sys.argv[1]); db.executescript(sys.argv[2]); db.close()`, database, script], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

export function seedV7(workspace) {
  const stateDir = setup(workspace);
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  // Mode bits mean nothing on Windows: the store must sit in a protected directory.
  if (WIN) ensurePrivateDirSync(stateDir);
  const database = path.join(stateDir, "conversations.sqlite3");
  sql(database, V7_SCHEMA + V7_ROWS);
  fs.chmodSync(database, 0o600);
  return { stateDir, database };
}

// Every conversation-scoped table, as stored rows in a stable order.
export function storeRows(database) {
  const result = spawnSync(PYTHON, ["-c", `import json,sqlite3,sys
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

export async function cli(workspace, stateDir, name) {
  const result = await runScript(workspace, "scripts/conversation-reminder-service.py", {
    args: [name, "--project-root", workspace.repoDir, "--state-dir", stateDir],
  });
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

export function backups(stateDir) {
  return fs.readdirSync(stateDir).filter(name => name.includes("backup"));
}

export const DEMO = {
  project: "demo", channel_id: "channel", identity: "router:webhook", assignment_generation: "generation-1",
  owner_id: "owner", state: "awaiting-owner", revision: 7, last_ack_at: "2026-09-24T09:00:00Z",
  last_ack_message_id: "ack-1", current_interaction_id: "question-1", response_message_id: "answer-1",
  response_at: "2026-09-24T10:00:00Z", due_at: "2026-09-24T17:00:00Z", reminder_message_id: "r-2",
  cleanup_message_ids: "[]", last_event_order: "order-4", reconciliation_status: "ready",
  checkpoint: 4, consecutive_reminders: 2,
};

export const QUIET = {
  project: "quiet", channel_id: "quiet-channel", identity: "router:quiet-webhook",
  assignment_generation: "quiet-generation", owner_id: "owner", state: "closed", revision: 3,
  last_ack_at: "2026-09-24T08:00:00Z", last_ack_message_id: "close-1", current_interaction_id: null,
  response_message_id: null, response_at: null, due_at: null, reminder_message_id: null,
  cleanup_message_ids: "[]", last_event_order: "order-2", reconciliation_status: "ready",
  checkpoint: 2, consecutive_reminders: 0,
};

export const DISCOVERY = {
  project: "demo", assignment_generation: "generation-1", phase: "complete", started_revision: 2,
  watermark_id: "watermark-1", before_id: null, after_id: null, summary_json: '{"mode":"initial"}',
  pages_total: 3, reactions_total: 1, passes: 2, pass_key: null, pass_pages: 0, pass_reactions: 0,
  last_seq: 0, pending_request: null, retry_at: null, reason: null, basis: "no-missed-activity",
};

// The v7 rows exactly as seeded.
export const V7_STORE = {
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
export const V8_STORE = {
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

export async function ingest(workspace, stateDir, id, fields) {
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

// Thread Conversation reminders end to end: the real Router, Thread
// Supervisor, thread sessions and reminder service, with the fixture claude,
// codex and tmux. The Claude project's own channel session runs too, since
// its adapter readiness gates every reminder for the project.
export const THREAD_A = "1700000000000111111";

export const THREAD_B = "1700000000000222222";

export const ROOT_AUTH = `Bot ${ROOT_TOKEN}`;

export const FAST_POLL = { CCDM_THREAD_ARCHIVE_POLL_WINDOW_S: "1.5", CCDM_THREAD_ARCHIVE_POLL_INTERVAL_S: "0.2" };

export const owner = { id: OWNER_ID, username: "Owner" };

export const guest = { id: "guest-id", username: "Guest" };

export function threadReminderWorkspace(type = "claude") {
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

// What the services and launchers run with. On Windows sessions run on the fake
// ccdm-host, whose env moves the state root, so the reminder state is named.
export const servicesEnv = (context, extra = {}) => (WIN
  ? supervisorEnv(context.workspace, { CCDM_REMINDER_STATE_DIR: context.stateDir, PYTHONUTF8: "1", ...extra })
  : routerEnv(context.workspace, extra));

export async function reminderService(context, name) {
  const result = await runScript(context.workspace, "scripts/conversation-reminder-service.py", {
    args: [name, "--project-root", context.workspace.repoDir, "--state-dir", context.stateDir],
    env: servicesEnv(context, context.env),
  });
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

// Claude answers every notification, naming the message it answers.
export const ANSWER = [{ name: "reply", arguments: { chat_id: "{{chat_id}}", text: "Here is the answer",
  conversation_interaction_id: "{{message_id}}", conversation_disposition: "progress" } }];

// The Router with demo's webhook, the supervisor, demo's channel session when
// it is a Claude project, and the enabled reminder worker, ready for demo.
export async function threadReminders(context, { channelSession = true, supervisorEnv: workerEnv = {}, beforeEnable } = {}) {
  const { workspace } = context;
  updateState(workspace.stateDir, state => {
    state.fixtures.discord.history = { "demo-channel": [] };
    state.fixtures.claude.toolScript = ANSWER;
  });
  await routerWithWebhooks(workspace, ["demo"]);
  if (WIN) await startThreadHost(workspace);
  if (channelSession) {
    const started = await runScript(workspace, "scripts/start-session.sh", {
      args: ["demo"], env: servicesEnv(context), timeoutMs: 30000,
    });
    assert.equal(started.exitCode, 0, started.stderr || started.stdout);
  }
  await startThreadSupervisor(workspace, {
    env: { ...(WIN ? { CCDM_REMINDER_STATE_DIR: context.stateDir } : {}), ...workerEnv } });
  await beforeEnable?.();
  await reminderService(context, "enable");
  context.setClock(0);
  const running = runScript(workspace, "scripts/conversation-reminder-service.py", {
    args: ["run", "--project-root", workspace.repoDir, "--state-dir", context.stateDir],
    env: servicesEnv(context, context.env), timeoutMs: 120000,
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

export function createThread(workspace, id, fields = {}) {
  updateState(workspace.stateDir, state => {
    (state.fixtures.discord.injectedThreads ||= []).push({ id, type: 11, parentId: "demo-channel",
      name: `Side task ${id.slice(-6)}`, ownerId: OWNER_ID, autoArchiveDuration: 10080, event: "create", ...fields });
  });
}

export async function supervisedThread(workspace, id, predicate = () => true, timeoutMs = 20000) {
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

export const posts = (workspace, channelId) => (readState(workspace.stateDir).fixtures.discord.messages ?? [])
  .filter(message => message.channelId === channelId);

export const eyes = (workspace, channelId) => posts(workspace, channelId).filter(message => message.content === "👀");

export const agentReplies = (workspace, channelId) => posts(workspace, channelId)
  .filter(message => message.webhookId === "fake-webhook-1");

export const settle = () => new Promise(resolve => setTimeout(resolve, 1500));

// A thread whose session answered the owner's first message.
export async function answeredThread(context, id, messageId) {
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

export const threadStatus = async (context, id) => (await reminderService(context, "status")).conversations.demo.threads[id];

export async function threadStatusMatching(context, id, predicate, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await threadStatus(context, id);
    if (predicate(last)) return last;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`thread ${id}'s reminders never matched: ${JSON.stringify(last)}`);
}

export const notices = (workspace, channelId) => posts(workspace, channelId)
  .filter(message => !message.webhookId && message.content !== "👀");

// A Discord snowflake for now: milliseconds since the Discord epoch, shifted 22 bits.
export const snowflakeNow = () => String((BigInt(Date.now()) - 1420070400000n) << 22n);

export const THREAD_BLOCKERS = [
  "root lacks Create Public Threads in the project channel; grant root permission Create Public Threads in demo-channel",
  "root lacks Manage Threads in the project channel; grant root permission Manage Threads in demo-channel",
  "root lacks View Audit Log in the guild; grant root permission View Audit Log in guild guild-id",
];

export const THREAD_C = "1700000000000333333";

export const THREAD_D = "1700000000000444444";

// The owner asked and the project's agent answered, minutes ago: newest first, as Discord pages history.
export function answeredHistory(id) {
  const at = minutes => new Date(Date.now() - minutes * 60000).toISOString();
  return [
    { id: `${id}-answer`, timestamp: at(5), type: 0, content: "Here is the answer", webhook_id: "fake-webhook-1",
      author: { id: "fake-webhook-1", username: "demo", bot: true } },
    { id: `${id}-question`, timestamp: at(10), type: 0, content: "please fix the parser", author: owner },
  ];
}
