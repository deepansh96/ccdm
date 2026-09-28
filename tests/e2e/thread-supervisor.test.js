import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { createWorkspace, runScript } from "./support/runner.js";
import { bridgeChildEnv, injectDiscordThread, waitForState } from "./support/bridge.js";
import { readState, writeState } from "./support/state.js";
import { cleanup } from "./support/teardown.js";

test.afterEach(async () => cleanup());

// Discord's maximum auto-archive duration, one week in minutes.
const ONE_WEEK_MINUTES = 10080;

function setup(workspace, projects = {}) {
  fs.writeFileSync(path.join(workspace.repoDir, "registry.json"), JSON.stringify({
    discord_user_id: "owner", guild_id: "guild",
    pool: [{ id: "bot", app_id: "app", token: "project-token" },
      { id: "remote-bot", app_id: "remote-app", token: "remote-token" }],
    projects: {
      demo: { type: "claude", path: "/work/demo", bot_id: "bot", channel_id: "channel",
        guest_user_ids: ["guest"] },
      far: { type: "codex", path: "remote:vm:/work/far", bot_id: "remote-bot", channel_id: "remote-channel" },
      ...projects,
    },
  }), { mode: 0o600 });
  const rootState = path.join(workspace.homeDir, "root-discord");
  fs.mkdirSync(rootState, { recursive: true });
  fs.writeFileSync(path.join(rootState, ".env"), "DISCORD_BOT_TOKEN=fixture-root-token\n", { mode: 0o600 });
  return rootState;
}

function defaultStateDir(workspace) {
  return path.join(workspace.homeDir, ".local", "state", "ccdm", "thread-supervisor");
}

function supervisorEnv(workspace, rootState, extra = {}) {
  return bridgeChildEnv(workspace, { ROOT_DISCORD_STATE_DIR: rootState, CCDM_THREAD_NODE: process.execPath,
    ...extra });
}

async function supervisor(workspace, name, env = workspace.env) {
  return runScript(workspace, "scripts/thread-supervisor.py", { args: [name], env });
}

async function status(workspace, env) {
  const result = await supervisor(workspace, "status", env);
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function startRun(workspace, env) {
  return runScript(workspace, "scripts/thread-supervisor.py", { args: ["run"], env, timeoutMs: 20000 });
}

async function waitForThread(workspace, env, threadId) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const current = await status(workspace, env);
    const found = Object.values(current.projects).find(project => project.threads[threadId]);
    if (found) return current;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for thread ${threadId} to bind`);
}

async function stopRun(workspace, env, running) {
  const current = await status(workspace, env);
  assert.equal(current.running, true, "the worker is still running before it is stopped");
  process.kill(-current.worker_pid, "SIGTERM");
  const result = await running;
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  return result;
}

test("an owner-created public thread under a project channel binds and gets a one-week auto-archive", async () => {
  const workspace = createWorkspace();
  const rootState = setup(workspace);
  const env = supervisorEnv(workspace, rootState);
  const running = startRun(workspace, env);
  await waitForState(workspace, state => state.fixtures.discord.ready.length === 1);
  assert.deepEqual(readState(workspace.stateDir).fixtures.discord.logins, [{ token: "fixture-root-token" }]);
  injectDiscordThread(workspace, { id: "thread-1", parentId: "channel", name: "Refactor", ownerId: "owner",
    autoArchiveDuration: 1440 });
  const current = await waitForThread(workspace, env, "thread-1");
  assert.deepEqual(current.projects.demo.threads["thread-1"],
    { name: "Refactor", creator_id: "owner", state: "registered" });
  const patches = (await waitForState(workspace, state => state.fixtures.discord.threadPatches.length === 1))
    .fixtures.discord.threadPatches;
  assert.deepEqual(patches, [{ authorization: "Bot project-token", body: { auto_archive_duration: ONE_WEEK_MINUTES },
    status: 200, threadId: "thread-1" }]);
  await stopRun(workspace, env, running);
});

test("a thread already at the one-week auto-archive gets no PATCH", async () => {
  const workspace = createWorkspace();
  const rootState = setup(workspace);
  const env = supervisorEnv(workspace, rootState);
  const running = startRun(workspace, env);
  await waitForState(workspace, state => state.fixtures.discord.ready.length === 1);
  injectDiscordThread(workspace, { id: "week-thread", parentId: "channel", ownerId: "owner",
    autoArchiveDuration: ONE_WEEK_MINUTES });
  // Events are handled in order, so this later thread's PATCH shows the first was handled.
  injectDiscordThread(workspace, { id: "day-thread", parentId: "channel", ownerId: "owner", autoArchiveDuration: 1440 });
  await waitForThread(workspace, env, "day-thread");
  const observed = await waitForState(workspace, state => state.fixtures.discord.threadPatches.length === 1);
  assert.deepEqual(observed.fixtures.discord.threadPatches.map(row => row.threadId), ["day-thread"]);
  assert.equal((await status(workspace, env)).projects.demo.threads["week-thread"].state, "registered");
  await stopRun(workspace, env, running);
});

test("only owner or guest public threads under a local project channel bind", async () => {
  const workspace = createWorkspace();
  const rootState = setup(workspace);
  const env = supervisorEnv(workspace, rootState);
  const running = startRun(workspace, env);
  await waitForState(workspace, state => state.fixtures.discord.ready.length === 1);
  for (const ignored of [
    { id: "stranger-thread", parentId: "channel", ownerId: "stranger" },
    { id: "private-thread", parentId: "channel", ownerId: "owner", type: 12 },
    { id: "root-thread", parentId: "root-channel", ownerId: "owner" },
    { id: "unregistered-thread", parentId: "unregistered-channel", ownerId: "owner" },
    { id: "forum-thread", parentId: "channel", parentType: 15, ownerId: "owner" },
    { id: "remote-thread", parentId: "remote-channel", ownerId: "owner" },
    // The project bot itself, with no pending creation request.
    { id: "bot-thread", parentId: "channel", ownerId: "app" },
  ]) injectDiscordThread(workspace, ignored);
  injectDiscordThread(workspace, { id: "guest-thread", parentId: "channel", name: "Guest idea", ownerId: "guest" });
  const current = await waitForThread(workspace, env, "guest-thread");
  assert.deepEqual(current.projects, { demo: { threads: {
    "guest-thread": { name: "Guest idea", creator_id: "guest", state: "registered" } } } });
  const observed = await waitForState(workspace, state => state.fixtures.discord.threadPatches.length === 1);
  assert.equal(observed.fixtures.discord.deliveredThreads.length, 8);
  assert.deepEqual(observed.fixtures.discord.threadPatches.map(row => row.threadId), ["guest-thread"]);
  assert.deepEqual(observed.fixtures.discord.malformedRequests, []);
  await stopRun(workspace, env, running);
});

test("a re-sent THREAD_CREATE for a bound thread leaves exactly one row", async () => {
  const workspace = createWorkspace();
  const rootState = setup(workspace);
  const env = supervisorEnv(workspace, rootState);
  const running = startRun(workspace, env);
  await waitForState(workspace, state => state.fixtures.discord.ready.length === 1);
  injectDiscordThread(workspace, { id: "thread-1", parentId: "channel", name: "First", ownerId: "owner" });
  await waitForThread(workspace, env, "thread-1");
  // Discord re-sends THREAD_CREATE when a bot posts into an archived thread.
  injectDiscordThread(workspace, { id: "thread-1", parentId: "channel", name: "First", ownerId: "owner",
    newlyCreated: false });
  injectDiscordThread(workspace, { id: "thread-2", parentId: "channel", name: "Second", ownerId: "owner" });
  const current = await waitForThread(workspace, env, "thread-2");
  assert.deepEqual(Object.keys(current.projects.demo.threads).sort(), ["thread-1", "thread-2"]);
  const observed = await waitForState(workspace, state => state.fixtures.discord.threadPatches.length === 2);
  assert.deepEqual(observed.fixtures.discord.threadPatches.map(row => row.threadId), ["thread-1", "thread-2"]);
  await stopRun(workspace, env, running);
  const rows = spawnSync("python3", ["-c", "import sqlite3,sys; print(sqlite3.connect(sys.argv[1]).execute(" +
    "\"SELECT COUNT(*) FROM threads WHERE thread_id='thread-1'\").fetchone()[0])",
  path.join(defaultStateDir(workspace), "threads.sqlite3")], { encoding: "utf8" });
  assert.equal(rows.stdout.trim(), "1", rows.stderr);
});

test("a 403 50001 on the auto-archive PATCH keeps the thread bound and the worker running", async () => {
  const workspace = createWorkspace();
  const rootState = setup(workspace);
  const seed = readState(workspace.stateDir);
  seed.fixtures.discord.manageThreadsDenied = ["Bot project-token"];
  writeState(seed, workspace.stateDir);
  const env = supervisorEnv(workspace, rootState);
  const running = startRun(workspace, env);
  await waitForState(workspace, state => state.fixtures.discord.ready.length === 1);
  injectDiscordThread(workspace, { id: "thread-1", parentId: "channel", ownerId: "owner" });
  await waitForThread(workspace, env, "thread-1");
  await waitForState(workspace, state => state.fixtures.discord.threadPatches.length === 1);
  injectDiscordThread(workspace, { id: "thread-2", parentId: "channel", ownerId: "owner" });
  const current = await waitForThread(workspace, env, "thread-2");
  assert.equal(current.projects.demo.threads["thread-1"].state, "registered");
  const observed = await waitForState(workspace, state => state.fixtures.discord.threadPatches.length === 2);
  assert.deepEqual(observed.fixtures.discord.threadPatches.map(row => [row.threadId, row.status]),
    [["thread-1", 403], ["thread-2", 403]]);
  const result = await stopRun(workspace, env, running);
  assert.match(result.stderr, /thread-1 stays bound.*403 50001.*Manage Threads/);
});

test("one worker holds the lock and the state directory and store are private and relocatable", async () => {
  const workspace = createWorkspace();
  const rootState = setup(workspace);
  const relocated = path.join(workspace.tmpDir, "custom-thread-state");
  const env = supervisorEnv(workspace, rootState, { CCDM_THREAD_STATE_DIR: relocated });
  const running = startRun(workspace, env);
  await waitForState(workspace, state => state.fixtures.discord.ready.length === 1);
  const second = await supervisor(workspace, "run", env);
  assert.notEqual(second.exitCode, 0);
  assert.match(JSON.parse(second.stdout).reason, /already running/);
  const mode = file => fs.statSync(path.join(relocated, file)).mode & 0o777;
  assert.equal(fs.statSync(relocated).mode & 0o777, 0o700);
  assert.equal(mode("threads.sqlite3"), 0o600);
  assert.equal(mode("worker.lock"), 0o600);
  assert.equal(fs.existsSync(defaultStateDir(workspace)), false);
  assert.equal((await status(workspace, env)).state_dir, relocated);
  await stopRun(workspace, env, running);
  assert.equal(readState(workspace.stateDir).fixtures.discord.logins.length, 1);
});

test("preflight validates the owner, root credentials, and store without side effects", async () => {
  const workspace = createWorkspace();
  const rootState = setup(workspace);
  const env = supervisorEnv(workspace, rootState);
  const ready = await supervisor(workspace, "preflight", env);
  assert.equal(ready.exitCode, 0, ready.stdout);
  assert.deepEqual(JSON.parse(ready.stdout).blockers, []);
  assert.equal(fs.existsSync(defaultStateDir(workspace)), false);

  const registryPath = path.join(workspace.repoDir, "registry.json");
  const registry = JSON.parse(fs.readFileSync(registryPath, "utf8"));
  delete registry.discord_user_id;
  fs.writeFileSync(registryPath, JSON.stringify(registry));
  fs.rmSync(path.join(rootState, ".env"));
  const stateDir = defaultStateDir(workspace);
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(stateDir, "threads.sqlite3"), "not a database", { mode: 0o644 });
  const blocked = await supervisor(workspace, "preflight", env);
  assert.equal(blocked.exitCode, 2, blocked.stdout);
  const blockers = JSON.parse(blocked.stdout).blockers;
  assert.equal(blockers.length, 3, blockers.join("\n"));
  assert.match(blockers[0], /no CCDM owner \(discord_user_id\)/);
  assert.match(blockers[1], /root Discord credentials .*DISCORD_BOT_TOKEN/);
  assert.match(blockers[2], /thread store .*not private/);
  assert.equal(fs.statSync(path.join(stateDir, "threads.sqlite3")).mode & 0o777, 0o644);
  assert.equal(fs.readFileSync(path.join(stateDir, "threads.sqlite3"), "utf8"), "not a database");

  fs.chmodSync(path.join(stateDir, "threads.sqlite3"), 0o600);
  const unsupported = JSON.parse((await supervisor(workspace, "preflight", env)).stdout).blockers;
  assert.match(unsupported.at(-1), /thread store cannot be used/);
  fs.chmodSync(stateDir, 0o755);
  const exposed = JSON.parse((await supervisor(workspace, "preflight", env)).stdout).blockers;
  assert.ok(exposed.some(blocker => /state directory is not private/.test(blocker)), exposed.join("\n"));
  assert.equal(fs.statSync(stateDir).mode & 0o777, 0o755);
});

test("a schema v1 thread store passes preflight and gains the archive actor and queue position columns, keeping its rows", async () => {
  const workspace = createWorkspace();
  const rootState = setup(workspace);
  const env = supervisorEnv(workspace, rootState);
  const stateDir = defaultStateDir(workspace);
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const store = path.join(stateDir, "threads.sqlite3");
  // The schema v1 thread store, as the first Thread Supervisor release created it.
  const seeded = spawnSync("python3", ["-c", `
import sqlite3, sys
db = sqlite3.connect(sys.argv[1])
db.executescript("""
CREATE TABLE threads (thread_id TEXT PRIMARY KEY, project TEXT NOT NULL, name TEXT NOT NULL,
  creator_id TEXT NOT NULL, starter_message_id TEXT, provider TEXT, account TEXT, model TEXT, effort TEXT,
  resolved_provider TEXT, resolved_account TEXT, resolved_model TEXT, resolved_effort TEXT,
  provider_conversation_id TEXT, provider_home TEXT, state TEXT NOT NULL, stop_reason TEXT,
  turn_running INTEGER NOT NULL DEFAULT 0, runtime_tmux TEXT, runtime_pid INTEGER, runtime_host TEXT,
  runtime_home TEXT, created_at TEXT NOT NULL, last_owner_activity_at TEXT, last_turn_end_at TEXT,
  pending_config TEXT, pending_close TEXT);
CREATE TABLE creation_requests (request_id TEXT PRIMARY KEY, project TEXT NOT NULL, name TEXT NOT NULL,
  provider TEXT, account TEXT, model TEXT, effort TEXT, first_message TEXT, requester_id TEXT NOT NULL,
  requester_kind TEXT NOT NULL, status TEXT NOT NULL, thread_id TEXT, created_at TEXT NOT NULL);
INSERT INTO threads (thread_id, project, name, creator_id, state, stop_reason, provider_conversation_id, created_at)
  VALUES ('thread-1', 'demo', 'Old', 'owner', 'stopped', 'auto-archive', 'session-1', '2026-09-27T10:00:00Z');
PRAGMA user_version=1;
""")`, store], { encoding: "utf8" });
  assert.equal(seeded.status, 0, seeded.stderr);
  fs.chmodSync(store, 0o600);

  const checked = await supervisor(workspace, "preflight", env);
  assert.equal(checked.exitCode, 0, checked.stdout);
  assert.equal(JSON.parse(checked.stdout).store, "ok");
  const current = await status(workspace, env);
  assert.deepEqual(current.projects.demo.threads["thread-1"], { name: "Old", creator_id: "owner", state: "stopped",
    stop_reason: "auto-archive", provider_conversation_id: "session-1" });
  const version = spawnSync("python3", ["-c", "import sqlite3,sys; db=sqlite3.connect(sys.argv[1]); " +
    "columns = [row[1] for row in db.execute('PRAGMA table_info(threads)')]; " +
    "print(db.execute('PRAGMA user_version').fetchone()[0], 'archive_actor' in columns, 'queue_position' in columns)",
  store], { encoding: "utf8" });
  assert.equal(version.stdout.trim(), "3 True True", version.stderr);
});
