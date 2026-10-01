import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { OWNER_ID, ROOT_TOKEN, createRouterWorkspace, routerRegistry, routerWithWebhooks,
  waitFor } from "./support/router.js";
import { readState, updateState } from "./support/state.js";
import { cleanup } from "./support/teardown.js";
import { startThreadSupervisor, supervisorCli, supervisorStateDir, supervisorStatus } from "./support/thread-supervisor.js";

test.afterEach(cleanup);

// The Thread Supervisor against the harness Router: only Discord thread
// events go in, and only recorded Discord REST calls and the supervisor CLI
// come out. demo is a Claude project whose guest is `guest-id`.
const ROOT_AUTH = `Bot ${ROOT_TOKEN}`;
// Discord's longest auto-archive duration, one week in minutes.
const ONE_WEEK_MINUTES = 10080;
const BOT_USER_ID = "fixture-bot-user-id";

async function supervisedWorkspace() {
  const workspace = createRouterWorkspace({ ...routerRegistry(), root_channels: ["root-channel"] });
  const router = await routerWithWebhooks(workspace, ["demo", "beta"]);
  return { workspace, router };
}

function injectThreads(workspace, threads) {
  updateState(workspace.stateDir, state => {
    (state.fixtures.discord.injectedThreads ||= []).push(...threads.map(thread =>
      ({ type: 11, parentId: "demo-channel", name: `Task ${thread.id}`, autoArchiveDuration: 1440,
        event: "create", ...thread })));
  });
}

const discord = workspace => readState(workspace.stateDir).fixtures.discord;
const patches = workspace => (discord(workspace).threadPatches ?? [])
  .map(({ threadId, authorization, body }) => ({ threadId, authorization, body }));

async function waitForBound(workspace, threadId) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const status = await supervisorStatus(workspace);
    const thread = Object.values(status.projects ?? {}).find(project => project.threads?.[threadId]);
    if (thread) return status;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`thread ${threadId} never bound: ${JSON.stringify(await supervisorStatus(workspace))}`);
}

// Bot-created threads and stranger threads bind nothing, so a later owner
// thread fences the ones before it: events are handled in order.
async function fence(workspace, id = "fence-thread") {
  injectThreads(workspace, [{ id, ownerId: OWNER_ID }]);
  await waitForBound(workspace, id);
  await waitFor(() => patches(workspace).some(patch => patch.threadId === id), () => `the ${id} PATCH`);
}

function modes(dir) {
  const result = { [path.basename(dir)]: (fs.statSync(dir).mode & 0o777).toString(8) };
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name);
    if (fs.statSync(file).isFile()) result[name] = (fs.statSync(file).mode & 0o777).toString(8);
  }
  return result;
}

test("an owner-created thread binds, shows in status, and is PATCHed to a one-week auto-archive", async () => {
  const { workspace } = await supervisedWorkspace();
  const supervisor = await startThreadSupervisor(workspace);
  injectThreads(workspace, [{ id: "owner-thread", name: "Fix flaky test", ownerId: OWNER_ID }]);
  const status = await waitForBound(workspace, "owner-thread");
  assert.equal(status.running, true);
  assert.deepEqual(status.projects, { demo: { threads: { "owner-thread": {
    name: "Fix flaky test", creator_id: OWNER_ID, state: "registered", stop_reason: null, close_reason: null,
    ws_port: null, provider_conversation_id: null,
    provider: null, account: null, model: null, effort: null,
  } } } });
  await waitFor(() => patches(workspace).length === 1, () => "the auto-archive PATCH");
  assert.deepEqual(patches(workspace), [
    { threadId: "owner-thread", authorization: ROOT_AUTH, body: { auto_archive_duration: ONE_WEEK_MINUTES } },
  ]);
  const exit = await supervisor.stop();
  assert.equal(exit.exitCode, 0, exit.stderr || exit.stdout);
});

test("a guest-created thread binds, and a stranger-created thread binds nothing and gets no PATCH", async () => {
  const { workspace } = await supervisedWorkspace();
  await startThreadSupervisor(workspace);
  injectThreads(workspace, [
    { id: "stranger-thread", ownerId: "stranger-id" },
    { id: "guest-thread", name: "Guest idea", ownerId: "guest-id" },
  ]);
  const status = await waitForBound(workspace, "guest-thread");
  await waitFor(() => patches(workspace).length === 1, () => "the guest thread PATCH");
  assert.deepEqual(Object.keys(status.projects.demo.threads), ["guest-thread"]);
  assert.deepEqual([status.projects.demo.threads["guest-thread"].creator_id,
    status.projects.demo.threads["guest-thread"].state], ["guest-id", "registered"]);
  assert.deepEqual(patches(workspace), [
    { threadId: "guest-thread", authorization: ROOT_AUTH, body: { auto_archive_duration: ONE_WEEK_MINUTES } },
  ]);
});

test("a repeated thread_create leaves one row and sends no second PATCH", async () => {
  const { workspace } = await supervisedWorkspace();
  await startThreadSupervisor(workspace);
  injectThreads(workspace, [{ id: "owner-thread", name: "First", ownerId: OWNER_ID }]);
  await waitForBound(workspace, "owner-thread");
  // Discord re-sends THREAD_CREATE when a bot posts into an archived thread.
  injectThreads(workspace, [{ id: "owner-thread", name: "First", ownerId: OWNER_ID, newlyCreated: false }]);
  await fence(workspace);
  const status = await supervisorStatus(workspace);
  assert.deepEqual(Object.keys(status.projects.demo.threads).sort(), ["fence-thread", "owner-thread"]);
  assert.deepEqual(patches(workspace).map(patch => patch.threadId), ["owner-thread", "fence-thread"]);
});

test("a bot-created thread binds only for a pending creation request, taking its overrides", async () => {
  const { workspace } = await supervisedWorkspace();
  // The worker creates the store on its first start; the request producer is a
  // later slice, so the pending row goes in through the PRD's store schema.
  const first = await startThreadSupervisor(workspace);
  assert.equal((await first.stop()).exitCode, 0);
  const store = path.join(supervisorStateDir(workspace), "threads.sqlite3");
  execFileSync("python3", ["-c", `import sqlite3, sys
db = sqlite3.connect(sys.argv[1])
db.execute("""INSERT INTO creation_requests (request_id, project, name, provider, account, model, effort,
  first_message, requester_id, requester_kind, status, thread_id, created_at)
  VALUES ('request-1', 'demo', 'Port the parser', 'codex', NULL, 'gpt-5.5', 'high', NULL, ?, 'owner',
  'pending', NULL, '2026-10-01T00:00:00Z')""", ("${OWNER_ID}",))
db.commit()`, store]);
  await startThreadSupervisor(workspace);
  injectThreads(workspace, [
    { id: "unrequested-bot-thread", name: "Something else", ownerId: BOT_USER_ID },
    { id: "requested-bot-thread", name: "Port the parser", ownerId: BOT_USER_ID },
  ]);
  const status = await waitForBound(workspace, "requested-bot-thread");
  await fence(workspace);
  assert.deepEqual((await supervisorStatus(workspace)).projects.demo.threads["requested-bot-thread"], {
    name: "Port the parser", creator_id: BOT_USER_ID, state: "registered", stop_reason: null, close_reason: null,
    ws_port: null, provider_conversation_id: null,
    provider: "codex", account: null, model: "gpt-5.5", effort: "high",
  });
  assert.equal(status.projects.demo.threads["unrequested-bot-thread"], undefined);
  // A bot-created thread was made with the one-week duration already.
  assert.deepEqual(patches(workspace).map(patch => patch.threadId), ["fence-thread"]);
});

test("a second worker exits 2 while the first holds the lock", async () => {
  const { workspace } = await supervisedWorkspace();
  const first = await startThreadSupervisor(workspace);
  const second = await supervisorCli(workspace, "run", { timeoutMs: 15000 });
  assert.equal(second.exitCode, 2, second.stderr || second.stdout);
  assert.match(second.stdout, /already running/);
  assert.equal((await supervisorStatus(workspace)).worker_pid, first.workerPid);
});

test(".supervisor.key is rewritten on each start, and the state is private", async () => {
  const { workspace } = await supervisedWorkspace();
  const keyFile = path.join(workspace.routerStateDir, "keys/.supervisor.key");
  const first = await startThreadSupervisor(workspace);
  const firstKey = fs.readFileSync(keyFile, "utf8");
  assert.equal((fs.statSync(keyFile).mode & 0o777).toString(8), "600");
  assert.equal((await first.stop()).exitCode, 0);
  await startThreadSupervisor(workspace);
  const secondKey = fs.readFileSync(keyFile, "utf8");
  assert.notEqual(secondKey, firstKey);
  assert.match(secondKey.trim(), /^[0-9a-f]{32,}$/);
  const stateDir = supervisorStateDir(workspace);
  const stateModes = modes(stateDir);
  assert.equal(stateModes["thread-supervisor"], "700");
  assert.ok(stateModes["threads.sqlite3"], JSON.stringify(stateModes));
  for (const [name, mode] of Object.entries(stateModes)) {
    if (name !== "thread-supervisor") assert.equal(mode, "600", `${name}: ${JSON.stringify(stateModes)}`);
  }
});

test("the supervisor holds no Discord token and sends nothing to Discord but Router ops", async () => {
  const { workspace } = await supervisedWorkspace();
  const supervisor = await startThreadSupervisor(workspace);
  injectThreads(workspace, [{ id: "owner-thread", ownerId: OWNER_ID }]);
  await waitForBound(workspace, "owner-thread");
  await waitFor(() => patches(workspace).length === 1, () => "the auto-archive PATCH");
  for (const pid of [supervisor.workerPid, supervisor.linkPid]) {
    assert.ok(Number.isInteger(pid), `pid ${pid}`);
    const environment = execFileSync("ps", ["-E", "-ww", "-o", "command=", "-p", String(pid)], { encoding: "utf8" });
    // `ps -E` shows the environment: the Router state override proves it is there.
    assert.match(environment, /CCDM_ROUTER_STATE_DIR=/);
    assert.ok(!environment.includes(ROOT_TOKEN), `process ${pid} environment holds the token`);
    assert.ok(!environment.includes("pool-bot-token"), `process ${pid} environment holds a pool token`);
    assert.ok(!/DISCORD_BOT_TOKEN/.test(environment), `process ${pid} environment names DISCORD_BOT_TOKEN`);
  }
  const stateDir = supervisorStateDir(workspace);
  // Every file, past the control socket.
  for (const name of fs.readdirSync(stateDir).filter(name => fs.statSync(path.join(stateDir, name)).isFile())) {
    const content = fs.readFileSync(path.join(stateDir, name));
    assert.ok(!content.includes(ROOT_TOKEN), `${name} holds the token`);
  }
  // Every Discord write is the Router's thread_update, sent with its token.
  const state = discord(workspace);
  assert.deepEqual(patches(workspace), [
    { threadId: "owner-thread", authorization: ROOT_AUTH, body: { auto_archive_duration: ONE_WEEK_MINUTES } },
  ]);
  assert.deepEqual([state.threadCreates ?? [], state.messages ?? [], state.reactions ?? [], state.malformedRequests],
    [[], [], [], []]);
  assert.deepEqual(readState(workspace.stateDir).fixtures.network.blocked, []);
});

test("the store reports user_version 1, and an unexpected column is refused", async () => {
  const { workspace } = await supervisedWorkspace();
  const supervisor = await startThreadSupervisor(workspace);
  assert.deepEqual((await supervisorStatus(workspace)).store, { user_version: 1 });
  assert.equal((await supervisor.stop()).exitCode, 0);
  const store = path.join(supervisorStateDir(workspace), "threads.sqlite3");
  const version = execFileSync("python3", ["-c",
    "import sqlite3, sys; print(sqlite3.connect(sys.argv[1]).execute('PRAGMA user_version').fetchone()[0])", store],
  { encoding: "utf8" });
  assert.equal(version.trim(), "1");
  execFileSync("python3", ["-c", "import sqlite3, sys; db = sqlite3.connect(sys.argv[1]); " +
    "db.execute('ALTER TABLE threads ADD COLUMN runtime_bot TEXT'); db.commit()", store]);
  const status = await supervisorCli(workspace, "status");
  assert.equal(status.exitCode, 2, status.stdout);
  assert.match(status.json.reason, /thread store schema is unsupported/);
  const run = await supervisorCli(workspace, "run", { timeoutMs: 15000 });
  assert.equal(run.exitCode, 2, run.stdout);
  assert.match(run.json.reason, /thread store schema is unsupported/);
});
