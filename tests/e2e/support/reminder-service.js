// Shared setup for the Conversation Reminders service suites: conversation-reminder-service,
// conversation-reminder-recovery and conversation-reminder-state.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { PYTHON } from "./platform.js";
import { runScript } from "./runner.js";
import { createBridgeWorkspace } from "./bridge.js";
import { routerEnv, startRouter, waitFor } from "./router.js";
import { cleanup, registerTeardownCallback, workspaceOwnsPid } from "./teardown.js";

export const { ensurePrivateDirSync } = createRequire(import.meta.url)("../../../scripts/platform/privacy.js");

// Every project is served through the Router and speaks through its webhook,
// so demo's reminder identity is `router:webhook`. No pool bot exists: root
// sends, acknowledges, and deletes every reminder with its own token.
export function setup(workspace) {
  fs.writeFileSync(path.join(workspace.repoDir, "registry.json"), JSON.stringify({
    discord_user_id: "owner", guild_id: "guild",
    projects: { demo: { type: "codex", webhook_id: "webhook", channel_id: "channel",
      assignment_generation: "generation-1" } },
  }), { mode: 0o600 });
  return path.join(workspace.homeDir, ".local", "state", "ccdm", "conversation-reminders");
}

// Root's token, and the Router the worker observes through as its `observer`
// client. Without the Router no channel is observed, so nothing sends.
export async function rootRouter(workspace) {
  const rootState = path.join(workspace.homeDir, "root-discord");
  fs.mkdirSync(rootState, { recursive: true });
  fs.writeFileSync(path.join(rootState, ".env"), "DISCORD_BOT_TOKEN=fixture-root-token\n", { mode: 0o600 });
  await startRouter(workspace, { env: { ROOT_DISCORD_STATE_DIR: rootState } });
  return rootState;
}

// The worker is observing once demo's channel reports ready. A worker that is
// still creating the store can briefly make status refuse it, so keep polling.
export async function waitForObserver(workspace, stateDir) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const result = await runScript(workspace, "scripts/conversation-reminder-service.py", {
      args: ["status", "--project-root", workspace.repoDir, "--state-dir", stateDir],
    });
    const current = result.exitCode === 0 ? JSON.parse(result.stdout) : null;
    if (current?.observer_channels.demo === "ready-observe-only") return current;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for the observer: ${JSON.stringify(await command(workspace, stateDir, "status"))}`);
}

export async function command(workspace, stateDir, name, extra = {}) {
  const result = await runScript(workspace, "scripts/conversation-reminder-service.py", {
    args: [name, "--project-root", workspace.repoDir, "--state-dir", stateDir], ...extra,
  });
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

export async function event(workspace, stateDir, type, id, time, fields = {}) {
  const value = {
    schema_version: 1, event_id: id, event_type: type, project: "demo", channel_id: "channel",
    bot_id: "router:webhook", assignment_generation: "generation-1", provider: "codex",
    event_time: time, event_order: `${time}:${id}`, adapter_instance_id: "test-adapter",
    ...fields,
  };
  const result = await runScript(workspace, "scripts/conversation-reminder-events.py", {
    args: ["ingest", "--project-root", workspace.repoDir, "--state-dir", stateDir], input: JSON.stringify(value),
  });
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.equal(JSON.parse(result.stdout).status, "committed");
}

export async function waitForConversation(workspace, stateDir, predicate) {
  for (let attempt = 0; attempt < 80; attempt++) {
    const current = await command(workspace, stateDir, "status");
    if (predicate(current.conversations.demo)) return current;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for conversation state");
}

export async function reconciledExchange(workspace, stateDir) {
  await event(workspace, stateDir, "owner_activity", "delivery-owner", "2026-09-24T09:00:00Z", {
    actor_id: "owner", source_message_id: "delivery-question", activity_kind: "message",
  });
  await event(workspace, stateDir, "response_delivered", "delivery-receipt", "2026-09-24T10:00:00Z", {
    provider_session_id: "session", provider_turn_id: "turn", interaction_id: "delivery-question",
    message_id: "delivery-answer", disposition: "progress",
  });
  await event(workspace, stateDir, "turn_completed", "delivery-completion", "2026-09-24T10:00:00Z", {
    provider_session_id: "session", provider_turn_id: "turn", interaction_id: "delivery-question",
    delivered_message_ids: ["delivery-answer"],
  });
  await command(workspace, stateDir, "sync");
  // A later discovery slice will establish this state through reconciliation.
  // Seed only the prerequisite; drive and assert delivery through executable surfaces.
  const database = path.join(stateDir, "conversations.sqlite3");
  const seeded = spawnSync(PYTHON, ["-c", "import sqlite3,sys; db=sqlite3.connect(sys.argv[1]); db.execute(\"UPDATE conversations SET reconciliation_status='ready' WHERE project='demo'\"); db.commit()", database], { encoding: "utf8", windowsHide: true });
  assert.equal(seeded.status, 0, seeded.stderr);
}

// Failed delivery intents that carry a retry time, read from the store itself.
export function refusalsWithRetryTime(stateDir) {
  const result = spawnSync(PYTHON, ["-c", "import json,sqlite3,sys; db=sqlite3.connect(sys.argv[1]); "
    + "print(json.dumps(db.execute(\"SELECT nonce FROM delivery_intents WHERE state='failed' AND retry_at IS NOT NULL\").fetchall()))",
  path.join(stateDir, "conversations.sqlite3")], { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

// Drive reminder sends through the claim/result surface without a worker.
// Queued cleanup is completed first so it never blocks the next claim.
export async function cli(workspace, stateDir, name, args = [], env = {}) {
  const result = await runScript(workspace, "scripts/conversation-reminder-service.py", {
    args: [name, "--project-root", workspace.repoDir, "--state-dir", stateDir, ...args], env,
  });
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

export async function claimAt(workspace, stateDir, clockFile, at) {
  fs.writeFileSync(clockFile, at);
  for (const action of (await cli(workspace, stateDir, "actions")).actions) {
    await cli(workspace, stateDir, "done", ["--action-id", action.action_id]);
  }
  return (await cli(workspace, stateDir, "claim", [], { CCDM_REMINDER_CLOCK_FILE: clockFile })).claim;
}

export async function sendAt(workspace, stateDir, clockFile, at, messageId) {
  const claim = await claimAt(workspace, stateDir, clockFile, at);
  assert.ok(claim?.nonce, `a reminder is due at ${at}`);
  await cli(workspace, stateDir, "result", ["--nonce", claim.nonce, "--outcome", "sent",
    "--message-id", messageId, "--sent-at", at], { CCDM_REMINDER_CLOCK_FILE: clockFile });
  return (await cli(workspace, stateDir, "status")).conversations.demo;
}

export async function freshCompletion(workspace, stateDir, turn, interaction, time) {
  await event(workspace, stateDir, "response_delivered", `${turn}-receipt`, time, {
    provider_session_id: "session", provider_turn_id: turn, interaction_id: interaction,
    message_id: `${turn}-answer`, disposition: "progress",
  });
  await event(workspace, stateDir, "turn_completed", `${turn}-completion`, time, {
    provider_session_id: "session", provider_turn_id: turn, interaction_id: interaction,
    delivered_message_ids: [`${turn}-answer`],
  });
  await cli(workspace, stateDir, "sync");
  return (await cli(workspace, stateDir, "status")).conversations.demo;
}

export function streak(row) {
  return [row.state, row.due_at, row.consecutive_reminders];
}

export function sql(database, script) {
  const result = spawnSync(PYTHON, ["-c", `import sqlite3,sys
db=sqlite3.connect(sys.argv[1]); db.executescript(sys.argv[2]); db.close()`, database, script], { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
}

// Turn a live v8 store back into the v7 shape: no table is keyed by conversation.
export function downgradeToV7(database) {
  const result = spawnSync(PYTHON, ["-c", `import sqlite3,sys
db=sqlite3.connect(sys.argv[1])
db.execute("DROP INDEX active_delivery_intent")
for table in ("conversations","owner_sources","qualifications","pending_actions","delivery_intents",
              "discoveries","catch_ups","retired_assignments"):
    columns=",".join(r[1] for r in db.execute(f"PRAGMA table_info({table})") if r[1]!="conversation_id")
    db.execute(f"CREATE TABLE {table}_v7 AS SELECT {columns} FROM {table}")
    db.execute(f"DROP TABLE {table}")
    db.execute(f"ALTER TABLE {table}_v7 RENAME TO {table}")
db.execute("""CREATE UNIQUE INDEX active_delivery_intent ON delivery_intents(project,assignment_generation)
    WHERE state IN ('sending','uncertain')""")
db.execute("PRAGMA user_version=7"); db.commit(); db.close()`, database], { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
}

// A v6 store as the v6 service wrote it, seeded by hand: one awaiting
// conversation mid-streak and one retired assignment with pending cleanup.
export const V6_STORE = `
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO settings VALUES ('disabled','0');
CREATE TABLE conversations (
  project TEXT PRIMARY KEY, channel_id TEXT NOT NULL, bot_id TEXT NOT NULL,
  assignment_generation TEXT NOT NULL, owner_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('closed','open-paused','awaiting-owner')),
  revision INTEGER NOT NULL, last_ack_at TEXT, last_ack_message_id TEXT,
  current_interaction_id TEXT, response_message_id TEXT, response_at TEXT,
  due_at TEXT, reminder_message_id TEXT, cleanup_message_ids TEXT NOT NULL,
  last_event_order TEXT, reconciliation_status TEXT NOT NULL,
  checkpoint INTEGER NOT NULL DEFAULT 0,
  consecutive_reminders INTEGER NOT NULL DEFAULT 0
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
  channel_id TEXT NOT NULL, bot_id TEXT NOT NULL, reason TEXT NOT NULL, retired_at TEXT NOT NULL,
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
INSERT INTO conversations VALUES ('demo','channel','bot','generation-1','owner','awaiting-owner',7,
  '2026-09-24T09:00:00Z','ack-1','question-1','answer-1','2026-09-24T10:00:00Z','2026-09-24T17:00:00Z',
  'r-2','[]','2026-09-24T13:00:00Z:r-2','ready',3,2);
INSERT INTO retired_assignments VALUES ('demo','generation-0','old-channel','old-bot','reassigned',
  '2026-09-23T08:00:00Z');
INSERT INTO pending_actions VALUES ('delete:r-old','demo','delete','r-old','generation-0',0);
PRAGMA user_version=6;
`;

export function seedV6(workspace) {
  const stateDir = setup(workspace);
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  // Mode bits mean nothing on Windows: the store must sit in a protected directory.
  if (process.platform === "win32") ensurePrivateDirSync(stateDir);
  const database = path.join(stateDir, "conversations.sqlite3");
  sql(database, V6_STORE);
  fs.chmodSync(database, 0o600);
  return { stateDir, database };
}

export function storeRows(database) {
  const result = spawnSync(PYTHON, ["-c", `import json,sqlite3,sys
db=sqlite3.connect(sys.argv[1]); db.row_factory=sqlite3.Row
print(json.dumps({"version": db.execute('PRAGMA user_version').fetchone()[0],
  "conversations": [dict(r) for r in db.execute('SELECT * FROM conversations ORDER BY project')],
  "retired_assignments": [dict(r) for r in db.execute('SELECT * FROM retired_assignments')]}))`, database],
  { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

export const V8_CONVERSATION = {
  project: "demo", conversation_id: "channel", channel_id: "channel", identity: "pool:bot", assignment_generation: "generation-1",
  owner_id: "owner", state: "awaiting-owner", revision: 7, last_ack_at: "2026-09-24T09:00:00Z",
  last_ack_message_id: "ack-1", current_interaction_id: "question-1", response_message_id: "answer-1",
  response_at: "2026-09-24T10:00:00Z", due_at: "2026-09-24T17:00:00Z", reminder_message_id: "r-2",
  cleanup_message_ids: "[]", last_event_order: "2026-09-24T13:00:00Z:r-2", reconciliation_status: "ready",
  checkpoint: 3, consecutive_reminders: 2,
};

export const V8_RETIRED = {
  project: "demo", conversation_id: "old-channel", assignment_generation: "generation-0", channel_id: "old-channel", identity: "pool:old-bot",
  reason: "reassigned", retired_at: "2026-09-23T08:00:00Z",
};

export function backups(stateDir) {
  return fs.readdirSync(stateDir).filter(name => name.includes("backup"));
}

// ---- Stopping the observer ----
// The worker holds its Node observer's stdin and closes it to ask for a stop:
// Windows has no SIGTERM a process can catch, and a closed pipe reaches every OS.

export const SERVICE_SCRIPT = "scripts/conversation-reminder-service.py";

export const OBSERVER_SCRIPT = "scripts/conversation-reminder-observer.js";

export function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

// The observer is observing demo's channel once its health file says so.
export const observerReady = stateDir => waitFor(() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(stateDir, "observer-health.json"), "utf8"))
      .channels?.demo === "ready-observe-only";
  } catch {
    return false;
  }
}, () => "the observer to observe demo's channel", 20000);

export const observerEnv = (workspace, stateDir, rootState) => routerEnv(workspace, {
  ROOT_DISCORD_STATE_DIR: rootState, CCDM_REMINDER_NODE: process.execPath,
  CCDM_REMINDER_PROJECT_ROOT: workspace.repoDir, CCDM_REMINDER_STATE_DIR: stateDir,
});

// The service's own start_observer and stop_observer, driven from outside: it
// prints the observer's PID, waits for a line on stdin, stops the observer and
// prints the exit code and how long the stop took.
export const OBSERVER_DRIVER = [
  "import importlib.util, json, os, sys, time",
  "spec = importlib.util.spec_from_file_location('reminder_service', sys.argv[1])",
  "service = importlib.util.module_from_spec(spec)",
  "sys.modules['reminder_service'] = service",
  "spec.loader.exec_module(service)",
  "project_root, state_dir = sys.argv[2], sys.argv[3]",
  "observer = service.start_observer(",
  "    [os.environ['CCDM_REMINDER_NODE'], sys.argv[4], '--project-root', project_root, '--state-dir', state_dir],",
  "    dict(os.environ))",
  "print(json.dumps({'pid': observer.pid}), flush=True)",
  "sys.stdin.readline()",
  "started = time.monotonic()",
  "code = service.stop_observer(observer)",
  "print(json.dumps({'code': code, 'seconds': round(time.monotonic() - started, 2)}), flush=True)",
  "",
].join("\n");

export async function startObserverDriver(workspace, stateDir, rootState) {
  const driver = path.join(workspace.tmpDir, "observer-driver.py");
  fs.writeFileSync(driver, OBSERVER_DRIVER);
  const child = spawn(PYTHON, [driver, path.join(workspace.repoDir, SERVICE_SCRIPT), workspace.repoDir, stateDir,
    path.join(workspace.repoDir, OBSERVER_SCRIPT)], {
    cwd: workspace.repoDir, env: observerEnv(workspace, stateDir, rootState), stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let output = "";
  let errors = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { errors += chunk; });
  const exited = new Promise(resolve => child.once("exit", resolve));
  const lines = () => output.split("\n").filter(line => line.trim()).map(line => JSON.parse(line));
  registerTeardownCallback(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
    const pid = lines()[0]?.pid;
    if (pid && alive(pid) && workspaceOwnsPid(pid, workspace.tmpRoot)) process.kill(pid, "SIGKILL");
  });
  const { pid } = await waitFor(() => lines()[0], () => `the observer's PID; stderr:\n${errors}`, 15000);
  await observerReady(stateDir);
  assert.equal(alive(pid), true);
  return { child, exited, lines, pid };
}

export async function observerWorkspace() {
  const workspace = createBridgeWorkspace();
  const stateDir = setup(workspace);
  await command(workspace, stateDir, "sync");
  return { workspace, stateDir, rootState: await rootRouter(workspace) };
}

// ---- Windows ----

export const ICACLS = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "icacls.exe");

export const SCRIPTS_DIR = workspace => path.join(workspace.repoDir, "scripts");

// A Python snippet with ccdmlib importable; its stdout parsed as JSON.
export async function pythonProbe(workspace, name, lines, args) {
  const probe = path.join(workspace.tmpDir, name);
  fs.writeFileSync(probe, ["import json, sys", "sys.dont_write_bytecode = True", "sys.path.insert(0, sys.argv[1])",
    ...lines, ""].join("\n"));
  const result = await runScript(workspace, path.relative(workspace.repoDir, probe), {
    args: [SCRIPTS_DIR(workspace), ...args],
  });
  assert.equal(result.exitCode, 0, result.stderr);
  return JSON.parse(result.stdout);
}
