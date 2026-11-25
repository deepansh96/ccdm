import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";

import { injectDiscordMessage, startFakeCodexServer } from "./support/bridge.js";
import { PYTHON } from "./support/platform.js";
import { OWNER_ID, createRouterWorkspace, routerRegistry, routerWithWebhooks, waitFor,
  writeProjectKey } from "./support/router.js";
import { readState, updateState } from "./support/state.js";
import { cleanup, registerTeardownCallback } from "./support/teardown.js";
import { assertSupervisorStops, startThreadSupervisor, supervisorStateDir, supervisorStatus,
  waitForThreadIdle } from "./support/thread-supervisor.js";

test.afterEach(cleanup);

// Per-provider thread session caps end to end: the real Router, Thread
// Supervisor, start-thread-session.sh, CCDM channel server and codex-bridge.js,
// with the fixture claude, codex and tmux. Turn state comes only from the
// fixtures' turns: a fixture claude turn ends with its Stop hook unless the
// test holds it, and a fake app-server turn ends with `turn/completed`.
const BOT_USER_ID = "fixture-bot-user-id";
const PAUSED = "Paused to free a session slot; send a message here to resume.";
// The production 30-minute idle threshold, cut to nothing for the tests.
const NO_IDLE_WAIT = { CCDM_THREAD_IDLE_S: "0" };
// Each thread runs in its own tmux session, `<screen>-t-<thread id>`.
const THREADS = {
  a: { id: "1700000000000100001", name: "Thread A" },
  b: { id: "1700000000000100002", name: "Thread B" },
  c: { id: "1700000000000100003", name: "Thread C" },
  d: { id: "1700000000000100004", name: "Thread D" },
  x: { id: "1700000000000100005", name: "Codex X" },
  y: { id: "1700000000000100006", name: "Codex Y" },
};

function capacityWorkspace(extra = {}) {
  const workspace = createRouterWorkspace({ ...routerRegistry({
    demo: { channel_id: "demo-channel", type: "claude", transport: "router", screen_name: "demo_claude" },
  }), root_channels: ["root-channel"], ...extra });
  const registryFile = path.join(workspace.repoDir, "registry.json");
  const registry = JSON.parse(fs.readFileSync(registryFile, "utf8"));
  registry.projects.demo.path = workspace.tmpDir;
  fs.writeFileSync(registryFile, `${JSON.stringify(registry, null, 2)}\n`);
  fs.mkdirSync(path.join(workspace.homeDir, ".codex"), { recursive: true });
  return workspace;
}

async function supervised(workspace, env = {}) {
  await routerWithWebhooks(workspace, ["demo"]);
  updateState(workspace.stateDir, state => {
    state.fixtures.claude.replyText = "on it";
  });
  return startThreadSupervisor(workspace, { env: { ...NO_IDLE_WAIT, ...env } });
}

function threadEvent(workspace, thread, event, fields = {}) {
  updateState(workspace.stateDir, state => {
    (state.fixtures.discord.injectedThreads ||= []).push({ id: thread.id, type: 11, parentId: "demo-channel",
      name: thread.name, ownerId: OWNER_ID, autoArchiveDuration: 10080, event, ...fields });
  });
}

function message(workspace, thread, id, content) {
  injectDiscordMessage(workspace, { id, channelId: thread.id, content, author: { id: OWNER_ID, username: "Owner" } });
}

async function threadRow(workspace, thread, predicate = () => true, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await supervisorStatus(workspace);
    const row = last.projects?.demo?.threads?.[thread.id];
    if (row && predicate(row)) return row;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`thread ${thread.id} never matched: ${JSON.stringify(last)}\n${turnAccount(workspace)}`);
}

// What decides idleness and eviction, for a failure: each thread's activity.json,
// the Stop hooks run, the held turns released (and whether the hold list still
// named them on a second read), and every post per thread.
function turnAccount(workspace) {
  const activity = {};
  const posted = {};
  for (const thread of Object.values(THREADS)) {
    try {
      activity[thread.name] = JSON.parse(fs.readFileSync(activityFile(workspace, thread), "utf8"));
    } catch (error) {
      activity[thread.name] = error.code ?? error.message;
    }
    posted[thread.name] = posts(workspace, thread).map(post => ({ webhook: Boolean(post.webhookId), content: post.content }));
  }
  const fixture = claude(workspace);
  return JSON.stringify({ activity, posted, stopHooks: stopHooks(workspace), holdTurnsIn: fixture.holdTurnsIn ?? [],
    turnHolds: fixture.turnHolds ?? [] });
}

// turnAccount plus the worker's own log (a failed notice is logged there), which it
// gives up only when it ends, so the worker is stopped here.
async function workerAccount(workspace, supervisor) {
  const ended = await Promise.race([supervisor.stop(), new Promise(resolve => setTimeout(() => resolve(null), 10000))]);
  return `${turnAccount(workspace)}\n${ended ? `worker exit ${ended.exitCode}, stderr:\n${ended.stderr}`
    : "the worker did not stop within 10 s"}`;
}

const discord = workspace => readState(workspace.stateDir).fixtures.discord;
const claude = workspace => readState(workspace.stateDir).fixtures.claude;
const posts = (workspace, thread) => (discord(workspace).messages ?? []).filter(post => post.channelId === thread.id);
const replies = (workspace, thread) => posts(workspace, thread).filter(post => post.webhookId);
const notices = (workspace, thread) => posts(workspace, thread).filter(post => !post.webhookId).map(post => post.content);
const stopHooks = workspace => (claude(workspace).hookRuns ?? []).filter(run => run.event === "Stop").length;
const invocationsFor = (workspace, thread) =>
  claude(workspace).invocations.filter(invocation => invocation.args.some(arg => arg.replaceAll("\\", "/").includes(`/threads/${thread.id}/`)));
const resumeArg = invocation => {
  const index = invocation.args.indexOf("--resume");
  return index < 0 ? null : invocation.args[index + 1].replace(/^'|'$/g, "");
};

// Holds every fixture claude turn in these threads open (no Stop hook) until released.
function holdTurns(workspace, ...threads) {
  updateState(workspace.stateDir, state => {
    state.fixtures.claude.holdTurnsIn = threads.map(thread => thread.id);
  });
}

// An owner-created Claude thread whose first owner message boots it to live and gets the reply.
async function liveClaudeThread(workspace, thread) {
  threadEvent(workspace, thread, "create");
  await threadRow(workspace, thread);
  message(workspace, thread, `${thread.id}-1`, `start ${thread.name}`);
  await threadRow(workspace, thread, row => row.state === "live" && row.provider_conversation_id != null);
  await waitFor(() => replies(workspace, thread).length === 1, () => `${thread.name}'s bootstrap reply`, 20000);
}

// Its turn has ended once its Stop hook ran.
async function idleClaudeThread(workspace, thread) {
  const before = stopHooks(workspace);
  await liveClaudeThread(workspace, thread);
  await waitFor(() => stopHooks(workspace) > before, () => `${thread.name}'s Stop hook`, 20000);
}

function writeClaudeTranscript(workspace, sessionId) {
  const dir = path.join(workspace.homeDir, ".claude", "projects", workspace.tmpDir.replace(/[^A-Za-z0-9]/g, "-"));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), "{}\n");
}

// What the thread's adapter writes into its launch dir; tests only read or lose it.
const activityFile = (workspace, thread) =>
  path.join(workspace.routerStateDir, "launches", "demo", "threads", thread.id, "activity.json");

const capsRegistry = caps => ({ thread_session_caps: caps });

test("at the Claude cap a new thread evicts the idle one with the pause notice and starts, and a reply resumes the evicted one", async () => {
  const workspace = capacityWorkspace(capsRegistry({ claude: 2 }));
  await supervised(workspace);
  await idleClaudeThread(workspace, THREADS.a);
  await idleClaudeThread(workspace, THREADS.b);

  await liveClaudeThread(workspace, THREADS.c);

  const evicted = await threadRow(workspace, THREADS.a);
  assert.deepEqual([evicted.state, evicted.stop_reason], ["stopped", "evicted"]);
  assert.deepEqual(notices(workspace, THREADS.a), [PAUSED]);
  assert.equal((await threadRow(workspace, THREADS.b)).state, "live");
  assert.deepEqual(notices(workspace, THREADS.c), []);

  // A's reply resumes it; B, now the longest idle, makes room.
  await waitFor(() => stopHooks(workspace) >= 3, () => "Thread C's Stop hook", 20000);
  writeClaudeTranscript(workspace, evicted.provider_conversation_id);
  message(workspace, THREADS.a, "a-resume", "picking this back up");

  await threadRow(workspace, THREADS.a, row => row.state === "live");
  await waitFor(() => replies(workspace, THREADS.a).length === 2, () => "the resumed reply", 20000);
  const invocations = invocationsFor(workspace, THREADS.a);
  assert.equal(invocations.length, 2);
  assert.equal(resumeArg(invocations[1]), evicted.provider_conversation_id);
  const b = await threadRow(workspace, THREADS.b);
  assert.deepEqual([b.state, b.stop_reason], ["stopped", "evicted"]);
  assert.deepEqual(notices(workspace, THREADS.b), [PAUSED]);
});

test("with no caps entry the defaults apply, and an invalid cap falls back to its default and shows in status", async () => {
  const defaults = capacityWorkspace();
  assert.deepEqual((await supervisorStatus(defaults)).capacity, { caps: { claude: 6, codex: 8, gemini: 4 }, invalid: [] });

  const invalid = capacityWorkspace(capsRegistry({ claude: "lots", codex: 3 }));
  const { capacity } = await supervisorStatus(invalid);
  assert.deepEqual(capacity.caps, { claude: 6, codex: 3, gemini: 4 });
  assert.equal(capacity.invalid.length, 1);
  assert.match(capacity.invalid[0], /thread_session_caps\.claude/);
});

test("a session mid-turn or without activity.json is never evicted: new threads queue, and drain FIFO as slots free", async () => {
  const workspace = capacityWorkspace(capsRegistry({ claude: 2 }));
  await supervised(workspace);
  holdTurns(workspace, THREADS.a, THREADS.c);  // An idle C could be evicted for D, the queue head.
  await liveClaudeThread(workspace, THREADS.a);
  await idleClaudeThread(workspace, THREADS.b);
  // B's turn ended, but with its activity file lost it counts as busy.
  const activity = activityFile(workspace, THREADS.b);
  assert.equal(JSON.parse(fs.readFileSync(activity, "utf8")).turn_running, false);
  fs.rmSync(activity);

  threadEvent(workspace, THREADS.c, "create");
  await threadRow(workspace, THREADS.c);
  message(workspace, THREADS.c, "c-1", "start C");
  const queuedC = await threadRow(workspace, THREADS.c, row => row.state === "queued");
  threadEvent(workspace, THREADS.d, "create");
  await threadRow(workspace, THREADS.d);
  message(workspace, THREADS.d, "d-1", "start D");
  const queuedD = await threadRow(workspace, THREADS.d, row => row.state === "queued");

  assert.ok(queuedD.queue_position > queuedC.queue_position, JSON.stringify([queuedC, queuedD]));
  await waitFor(() => notices(workspace, THREADS.d).length === 1, () => "the queued notices");
  assert.deepEqual(notices(workspace, THREADS.c), ["Queued, 2 sessions busy."]);
  assert.deepEqual(notices(workspace, THREADS.d), ["Queued, 2 sessions busy."]);
  for (const thread of [THREADS.a, THREADS.b]) {
    assert.deepEqual([(await threadRow(workspace, thread)).state, notices(workspace, thread)], ["live", []]);
  }

  // An archive of A mid-turn is reverted and A keeps its session and its slot.
  threadEvent(workspace, THREADS.a, "update", { archived: true, previous: { id: THREADS.a.id, archived: false } });
  await waitFor(() => readState(workspace.stateDir).fixtures.discord.threads[THREADS.a.id]?.archived === false,
    () => "A's unarchive");
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.deepEqual([(await threadRow(workspace, THREADS.a)).state, (await threadRow(workspace, THREADS.c)).state],
    ["live", "queued"]);

  // /close frees A's slot: the queue head, C, starts with its queued message.
  injectDiscordMessage(workspace, { id: "a-close", channelId: THREADS.a.id, content: "/close",
    author: { id: OWNER_ID, username: "Owner" } });
  await threadRow(workspace, THREADS.a, row => row.state === "closed");
  await threadRow(workspace, THREADS.c, row => row.state === "live");
  await waitFor(() => replies(workspace, THREADS.c).length === 1, () => "C's reply", 20000);
  assert.match(claude(workspace).channelNotifications.find(n => n.meta.chat_id === THREADS.c.id).content, /start C/);
  assert.equal((await threadRow(workspace, THREADS.d)).state, "queued");

  // /close frees B's slot for D.
  injectDiscordMessage(workspace, { id: "b-close", channelId: THREADS.b.id, content: "/close",
    author: { id: OWNER_ID, username: "Owner" } });
  await threadRow(workspace, THREADS.b, row => row.state === "closed");
  await threadRow(workspace, THREADS.d, row => row.state === "live");
  await waitFor(() => replies(workspace, THREADS.d).length === 1, () => "D's reply", 20000);
});

test("under the production 30-minute threshold a session whose turn just ended is not idle, so the new thread queues", async () => {
  const workspace = capacityWorkspace(capsRegistry({ claude: 1 }));
  await supervised(workspace, { CCDM_THREAD_IDLE_S: "" });
  await idleClaudeThread(workspace, THREADS.a);

  threadEvent(workspace, THREADS.b, "create");
  await threadRow(workspace, THREADS.b);
  message(workspace, THREADS.b, "b-1", "start B");

  await threadRow(workspace, THREADS.b, row => row.state === "queued");
  await waitFor(() => notices(workspace, THREADS.b).length === 1, () => "B's queued notice");
  assert.deepEqual(notices(workspace, THREADS.b), ["Queued, 1 sessions busy."]);
  assert.deepEqual([(await threadRow(workspace, THREADS.a)).state, notices(workspace, THREADS.a)], ["live", []]);
});

// A pending creation request the root bot fulfils: the PRD's store schema.
function requestCodexThread(workspace, thread) {
  execFileSync(PYTHON, ["-c", `import sqlite3, sys
db = sqlite3.connect(sys.argv[1], timeout=5)
db.execute("""INSERT INTO creation_requests (request_id, project, name, provider, account, model, effort,
  first_message, requester_id, requester_kind, status, thread_id, created_at)
  VALUES (?, 'demo', ?, 'codex', NULL, NULL, NULL, NULL, ?, 'owner', 'pending', NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))""",
  (sys.argv[2], sys.argv[3], sys.argv[4]))
db.commit()`, path.join(supervisorStateDir(workspace), "threads.sqlite3"), `request-${thread.id}`, thread.name,
  OWNER_ID]);
  threadEvent(workspace, thread, "create", { ownerId: BOT_USER_ID });
}

// A Codex thread's fake app-server, bound once the supervisor allocated its port.
async function liveCodexThread(workspace, thread, port, uuid) {
  const codex = await startFakeCodexServer(workspace, { port, deferListen: true,
    codexHome: path.join(workspace.homeDir, ".codex"), channelId: thread.id, threadId: uuid,
    bootstrapPlan: { mcpReplyText: "on it" } });
  requestCodexThread(workspace, thread);
  await threadRow(workspace, thread, row => row.provider === "codex");
  message(workspace, thread, `${thread.id}-1`, `start ${thread.name}`);
  await threadRow(workspace, thread, row => row.ws_port === port);
  await codex.listen();
  await threadRow(workspace, thread, row => row.state === "live");
  await waitFor(() => replies(workspace, thread).length === 1, () => `${thread.name}'s bootstrap reply`, 20000);
  return codex;
}

test("Codex and Claude caps are independent, and a Codex session idle after turn/completed is evicted", async () => {
  const workspace = capacityWorkspace(capsRegistry({ claude: 1, codex: 1 }));
  const supervisor = await supervised(workspace, { CCDM_THREAD_WS_PORT_BASE: "29700" });
  holdTurns(workspace, THREADS.a);
  await liveClaudeThread(workspace, THREADS.a);

  // The Claude cap is full; a Codex thread still starts.
  await liveCodexThread(workspace, THREADS.x, 29700, "0199a5c4-7e1b-7c3d-9f2a-4b8e6d1c3a61");
  const activity = activityFile(workspace, THREADS.x);
  await waitFor(() => fs.existsSync(activity) && JSON.parse(fs.readFileSync(activity, "utf8")).turn_running === false,
    () => "X's turn/completed", 20000);

  await liveCodexThread(workspace, THREADS.y, 29701, "0199a5c4-7e1b-7c3d-9f2a-4b8e6d1c3a62");
  const x = await threadRow(workspace, THREADS.x);
  assert.deepEqual([x.state, x.stop_reason], ["stopped", "evicted"]);
  const xNotices = notices(workspace, THREADS.x);
  assert.deepEqual(xNotices, [PAUSED], xNotices.length === 1 ? undefined : await workerAccount(workspace, supervisor));
  assert.equal((await threadRow(workspace, THREADS.a)).state, "live");

  // A Codex slot is not a Claude one: Claude B still queues behind busy A.
  threadEvent(workspace, THREADS.b, "create");
  await threadRow(workspace, THREADS.b);
  message(workspace, THREADS.b, "b-1", "start B");
  await threadRow(workspace, THREADS.b, row => row.state === "queued");
  await waitFor(() => notices(workspace, THREADS.b).length === 1, () => "B's queued notice");
  assert.deepEqual(notices(workspace, THREADS.b), ["Queued, 1 sessions busy."]);
});

test("a queued thread starts ahead of a newer one: the drain evicts an idle session for the queue head, and the newer thread queues behind it", async () => {
  const workspace = capacityWorkspace(capsRegistry({ claude: 1 }));
  await supervised(workspace);
  holdTurns(workspace, THREADS.a);
  await liveClaudeThread(workspace, THREADS.a);
  threadEvent(workspace, THREADS.c, "create");
  await threadRow(workspace, THREADS.c);
  message(workspace, THREADS.c, "c-1", "start C");
  await threadRow(workspace, THREADS.c, row => row.state === "queued");

  // A's turn ends, so A is idle; C's turns are held from here, so C stays busy once it runs.
  const stops = stopHooks(workspace);
  holdTurns(workspace, THREADS.c);
  await waitFor(() => stopHooks(workspace) > stops, () => "A's Stop hook", 20000);
  threadEvent(workspace, THREADS.d, "create");
  await threadRow(workspace, THREADS.d);
  message(workspace, THREADS.d, "d-1", "start D");

  await threadRow(workspace, THREADS.c, row => row.state === "live");
  await waitFor(() => replies(workspace, THREADS.c).length === 1, () => "C's reply", 20000);
  assert.match(claude(workspace).channelNotifications.find(n => n.meta.chat_id === THREADS.c.id).content, /start C/);
  const a = await threadRow(workspace, THREADS.a);
  assert.deepEqual([a.state, a.stop_reason], ["stopped", "evicted"]);
  assert.deepEqual(notices(workspace, THREADS.a), [PAUSED]);
  assert.equal((await threadRow(workspace, THREADS.d, row => row.state === "queued")).state, "queued");
  assert.equal(invocationsFor(workspace, THREADS.d).length, 0);
});

test("a queued creation request keeps its first message across a supervisor restart and starts with it", async () => {
  const workspace = capacityWorkspace(capsRegistry({ claude: 1 }));
  const supervisor = await supervised(workspace);
  holdTurns(workspace, THREADS.a);
  await liveClaudeThread(workspace, THREADS.a);
  const created = { id: "1600000000000000001", name: "queued-task" };
  injectDiscordMessage(workspace, { id: "thread-command", channelId: "demo-channel",
    content: "/thread queued-task please look at the flaky parser test", author: { id: OWNER_ID, username: "Owner" } });
  await threadRow(workspace, created, row => row.state === "queued");

  await assertSupervisorStops(supervisor);
  await startThreadSupervisor(workspace, { env: NO_IDLE_WAIT });
  // /close frees A's slot for the queued thread.
  injectDiscordMessage(workspace, { id: "a-close", channelId: THREADS.a.id, content: "/close",
    author: { id: OWNER_ID, username: "Owner" } });

  await threadRow(workspace, created, row => row.state === "live");
  await waitFor(() => (claude(workspace).channelNotifications ?? []).some(n => n.meta.chat_id === created.id),
    () => "the queued thread's bootstrap", 20000);
  const bootstrap = claude(workspace).channelNotifications.find(n => n.meta.chat_id === created.id);
  assert.match(bootstrap.content, /please look at the flaky parser test/);
});

test("two threads whose ids share their last six digits each run in their own tmux session", async () => {
  const workspace = capacityWorkspace();
  await supervised(workspace);
  const first = { id: "1700000000000900001", name: "First" };
  const second = { id: "1700000000001900001", name: "Second" };
  await liveClaudeThread(workspace, first);
  await liveClaudeThread(workspace, second);

  const sessions = readState(workspace.stateDir).fixtures.tmux.sessions;
  assert.ok(sessions[`demo_claude-t-${first.id}`], JSON.stringify(Object.keys(sessions)));
  assert.ok(sessions[`demo_claude-t-${second.id}`], JSON.stringify(Object.keys(sessions)));
  for (const thread of [first, second]) {
    assert.equal((await threadRow(workspace, thread)).state, "live");
    assert.deepEqual(notices(workspace, thread), []);
  }
});

// ---- Agent Messages & thread idle eviction (#406) --------------------------

function agentCapacityWorkspace(extra = {}) {
  const workspace = createRouterWorkspace({ ...routerRegistry({
    demo: { channel_id: "demo-channel", type: "claude", transport: "router", screen_name: "demo_claude",
      agent_message_targets: ["beta"] },
    beta: { channel_id: "beta-channel", type: "codex", transport: "router", agent_message_targets: ["demo"] },
  }), root_channels: ["root-channel"], ...extra });
  const registryFile = path.join(workspace.repoDir, "registry.json");
  const registry = JSON.parse(fs.readFileSync(registryFile, "utf8"));
  registry.projects.demo.path = workspace.tmpDir;
  registry.projects.beta.path = workspace.tmpDir;
  fs.writeFileSync(registryFile, `${JSON.stringify(registry, null, 2)}\n`);
  fs.mkdirSync(path.join(workspace.homeDir, ".codex"), { recursive: true });
  return workspace;
}

async function supervisedAgentCapacity(workspace, env = {}) {
  await routerWithWebhooks(workspace, ["demo", "beta"]);
  updateState(workspace.stateDir, state => {
    state.fixtures.claude.replyText = "on it";
  });
  return startThreadSupervisor(workspace, { env: { ...NO_IDLE_WAIT, ...env } });
}

async function connectAgentSender(workspace, project = "beta") {
  const key = `${project}-capacity-key`;
  writeProjectKey(workspace, project, key);
  const { RouterClient } = createRequire(import.meta.url)(path.join(workspace.repoDir, "scripts/router/client.js"));
  const client = new RouterClient({
    socketPath: workspace.socketPath, project, key, role: "project", capabilities: ["agent_messages"],
  });
  await client.connect();
  registerTeardownCallback(() => client.close());
  return client;
}

function fakeAgyBin(workspace) {
  const fake = path.join(workspace.repoDir, "tests/e2e/support/fake-agy.cjs");
  if (process.platform === "win32") return fake;
  const bin = path.join(workspace.tmpRoot, "agy-bin", "agy");
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(bin, `#!/bin/sh\nexec /bin/bash -p -c 'exec -a agy "$0" "$@"' '${process.execPath}' '${fake}' "$@"\n`);
  fs.chmodSync(bin, 0o755);
  return bin;
}

const agyPlan = (workspace, plan) =>
  fs.writeFileSync(path.join(workspace.stateDir, "agy-plan.json"), `${JSON.stringify(plan)}\n`);

function agyPromptCount(workspace) {
  const file = path.join(workspace.stateDir, "agy.ndjson");
  if (!fs.existsSync(file)) return 0;
  return fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean)
    .map(line => JSON.parse(line))
    .filter(event => event.event === "client" && event.message?.method === "session/prompt").length;
}

function requestProviderThread(workspace, thread, provider) {
  execFileSync(PYTHON, ["-c", `import sqlite3, sys
db = sqlite3.connect(sys.argv[1], timeout=5)
db.execute("""INSERT INTO creation_requests (request_id, project, name, provider, account, model, effort,
  first_message, requester_id, requester_kind, status, thread_id, created_at)
  VALUES (?, 'demo', ?, ?, NULL, NULL, NULL, NULL, ?, 'owner', 'pending', NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))""",
  (sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5]))
db.commit()`, path.join(supervisorStateDir(workspace), "threads.sqlite3"), `request-${thread.id}`, thread.name,
  provider, OWNER_ID]);
  threadEvent(workspace, thread, "create", { ownerId: BOT_USER_ID });
}

test("Claude thread: an Agent Message does not reset the idle clock, and a running agent-started turn is never evicted", async () => {
  const workspace = agentCapacityWorkspace(capsRegistry({ claude: 2 }));
  await supervisedAgentCapacity(workspace, { CCDM_THREAD_IDLE_S: "2" });

  await idleClaudeThread(workspace, THREADS.a);
  const aOwnerAt = Date.now();
  await idleClaudeThread(workspace, THREADS.b);

  // Wait past the 2 s idle threshold from A's last owner message.
  const waitMs = Math.max(0, aOwnerAt + 2200 - Date.now());
  if (waitMs > 0) await new Promise(resolve => setTimeout(resolve, waitMs));

  const beta = await connectAgentSender(workspace, "beta");
  holdTurns(workspace, THREADS.a, THREADS.b);
  await beta.request("agent_request", {
    target: `demo/${THREADS.a.id}`, text: "check A", idempotency_key: "cap-claude-a",
  });
  await beta.request("agent_request", {
    target: `demo/${THREADS.b.id}`, text: "check B", idempotency_key: "cap-claude-b",
  });
  await waitFor(
    () => [THREADS.a.id, THREADS.b.id].every(id =>
      (claude(workspace).channelNotifications ?? []).some(n => n.meta?.chat_id === id && n.meta?.sender === "agent")),
    () => "Claude agent-started turns running in A and B",
    15000,
  );

  // While A and B are running agent-started turns, C cannot evict either and queues.
  threadEvent(workspace, THREADS.c, "create");
  await threadRow(workspace, THREADS.c);
  message(workspace, THREADS.c, "c-agent-1", "start C");
  await threadRow(workspace, THREADS.c, row => row.state === "queued");
  await waitFor(() => notices(workspace, THREADS.c).length === 1, () => "C queued notice");
  assert.deepEqual(notices(workspace, THREADS.c), ["Queued, 2 sessions busy."]);
  assert.equal((await threadRow(workspace, THREADS.a)).state, "live");
  assert.equal((await threadRow(workspace, THREADS.b)).state, "live");

  // Release both agent-started turns; A's idle clock was NOT reset by the Agent Message,
  // so triggering a drain immediately evicts A (oldest owner message) for C, leaving B live.
  holdTurns(workspace);
  await waitForThreadIdle(workspace, "demo", THREADS.a.id);
  await waitForThreadIdle(workspace, "demo", THREADS.b.id);
  const agentDoneAt = Date.now();
  threadEvent(workspace, THREADS.d, "create");
  const a = await threadRow(workspace, THREADS.a, row => row.state === "stopped");
  assert.ok(Date.now() - agentDoneAt < 2000, "A was evicted immediately without waiting a fresh 2 s idle window");
  await threadRow(workspace, THREADS.c, row => row.state === "live");
  assert.deepEqual([a.state, a.stop_reason], ["stopped", "evicted"]);
  assert.deepEqual(notices(workspace, THREADS.a).filter(text => !text.startsWith("-# ⇄ Agent ")), [PAUSED]);
  assert.equal((await threadRow(workspace, THREADS.b)).state, "live");
});

test("Codex thread: an Agent Message does not reset the idle clock, and a running agent-started turn is never evicted", async () => {
  const workspace = agentCapacityWorkspace(capsRegistry({ codex: 2 }));
  await supervisedAgentCapacity(workspace, { CCDM_THREAD_IDLE_S: "2", CCDM_THREAD_WS_PORT_BASE: "29710" });
  const z = { id: "1700000000000100007", name: "Codex Z" };

  const codexX = await startFakeCodexServer(workspace, {
    port: 29710, deferListen: true, codexHome: path.join(workspace.homeDir, ".codex"),
    channelId: THREADS.x.id, threadId: "0199a5c4-7e1b-7c3d-9f2a-4b8e6d1c3a71",
    bootstrapPlan: { mcpReplyText: "on it" },
    turns: [{ turnId: "x-agent", waitForRelease: true, delta: "x checked" }],
  });
  const codexY = await startFakeCodexServer(workspace, {
    port: 29711, deferListen: true, codexHome: path.join(workspace.homeDir, ".codex"),
    channelId: THREADS.y.id, threadId: "0199a5c4-7e1b-7c3d-9f2a-4b8e6d1c3a72",
    bootstrapPlan: { mcpReplyText: "on it" },
    turns: [{ turnId: "y-agent", waitForRelease: true, delta: "y checked" }],
  });
  const codexZ = await startFakeCodexServer(workspace, {
    port: 29712, deferListen: true, codexHome: path.join(workspace.homeDir, ".codex"),
    channelId: z.id, threadId: "0199a5c4-7e1b-7c3d-9f2a-4b8e6d1c3a73",
    bootstrapPlan: { mcpReplyText: "on it" },
  });

  requestProviderThread(workspace, THREADS.x, "codex");
  await threadRow(workspace, THREADS.x, row => row.provider === "codex");
  message(workspace, THREADS.x, "x-1", "start X");
  const xOwnerAt = Date.now();
  await threadRow(workspace, THREADS.x, row => row.ws_port === 29710);
  await codexX.listen();
  await threadRow(workspace, THREADS.x, row => row.state === "live");
  await waitForThreadIdle(workspace, "demo", THREADS.x.id);

  requestProviderThread(workspace, THREADS.y, "codex");
  await threadRow(workspace, THREADS.y, row => row.provider === "codex");
  message(workspace, THREADS.y, "y-1", "start Y");
  await threadRow(workspace, THREADS.y, row => row.ws_port === 29711);
  await codexY.listen();
  await threadRow(workspace, THREADS.y, row => row.state === "live");
  await waitForThreadIdle(workspace, "demo", THREADS.y.id);

  const waitMs = Math.max(0, xOwnerAt + 2200 - Date.now());
  if (waitMs > 0) await new Promise(resolve => setTimeout(resolve, waitMs));

  const beta = await connectAgentSender(workspace, "beta");
  await beta.request("agent_request", {
    target: `demo/${THREADS.x.id}`, text: "check X", idempotency_key: "cap-codex-x",
  });
  await beta.request("agent_request", {
    target: `demo/${THREADS.y.id}`, text: "check Y", idempotency_key: "cap-codex-y",
  });
  await waitFor(() => codexX.pendingReleases().includes("x-agent"), () => "Codex X agent turn held", 15000);
  await waitFor(() => codexY.pendingReleases().includes("y-agent"), () => "Codex Y agent turn held", 15000);

  // While X and Y run agent-started turns, Z queues and neither is evicted.
  requestProviderThread(workspace, z, "codex");
  await threadRow(workspace, z, row => row.provider === "codex");
  message(workspace, z, "z-1", "start Z");
  await threadRow(workspace, z, row => row.state === "queued");
  await waitFor(() => notices(workspace, z).length === 1, () => "Z queued notice");
  assert.deepEqual(notices(workspace, z), ["Queued, 2 sessions busy."]);
  assert.equal((await threadRow(workspace, THREADS.x)).state, "live");
  assert.equal((await threadRow(workspace, THREADS.y)).state, "live");

  // Finish both agent-started turns; X's idle clock was untouched so drain evicts X immediately.
  codexX.releaseTurn("x-agent");
  codexY.releaseTurn("y-agent");
  await waitForThreadIdle(workspace, "demo", THREADS.x.id);
  await waitForThreadIdle(workspace, "demo", THREADS.y.id);
  const agentDoneAt = Date.now();
  threadEvent(workspace, THREADS.d, "create");
  const x = await threadRow(workspace, THREADS.x, row => row.state === "stopped");
  assert.ok(Date.now() - agentDoneAt < 2000, "X was evicted immediately without waiting a fresh 2 s idle window");
  await threadRow(workspace, z, row => row.ws_port === 29712);
  await codexZ.listen();
  await threadRow(workspace, z, row => row.state === "live");
  assert.deepEqual([x.state, x.stop_reason], ["stopped", "evicted"]);
  assert.deepEqual(notices(workspace, THREADS.x).filter(text => !text.startsWith("-# ⇄ Agent ")), [PAUSED]);
  assert.equal((await threadRow(workspace, THREADS.y)).state, "live");
});

test("Gemini thread: an Agent Message does not reset the idle clock, and a running agent-started turn is never evicted", async () => {
  const workspace = agentCapacityWorkspace(capsRegistry({ gemini: 2 }));
  const g1 = { id: "1700000000000100011", name: "Gemini 1" };
  const g2 = { id: "1700000000000100012", name: "Gemini 2" };
  const g3 = { id: "1700000000000100013", name: "Gemini 3" };
  const gateG1 = path.join(workspace.tmpDir, "gate-g1");
  const gateG2 = path.join(workspace.tmpDir, "gate-g2");
  agyPlan(workspace, {
    turns: [
      { reply: "g1 boot" },
      { reply: "g2 boot" },
      { holdUntilFile: gateG1, text: "g1 agent" },
      { holdUntilFile: gateG2, text: "g2 agent" },
      { reply: "g3 boot" },
    ],
  });
  await supervisedAgentCapacity(workspace, { CCDM_THREAD_IDLE_S: "2", CCDM_AGY_BIN: fakeAgyBin(workspace) });

  requestProviderThread(workspace, g1, "gemini");
  await threadRow(workspace, g1, row => row.provider === "gemini");
  message(workspace, g1, "g1-1", "start G1");
  const g1OwnerAt = Date.now();
  await threadRow(workspace, g1, row => row.state === "live");
  await waitFor(() => replies(workspace, g1).length === 1, () => "G1 bootstrap reply", 20000);
  await waitForThreadIdle(workspace, "demo", g1.id);

  requestProviderThread(workspace, g2, "gemini");
  await threadRow(workspace, g2, row => row.provider === "gemini");
  message(workspace, g2, "g2-1", "start G2");
  await threadRow(workspace, g2, row => row.state === "live");
  await waitFor(() => replies(workspace, g2).length === 1, () => "G2 bootstrap reply", 20000);
  await waitForThreadIdle(workspace, "demo", g2.id);

  const waitMs = Math.max(0, g1OwnerAt + 2200 - Date.now());
  if (waitMs > 0) await new Promise(resolve => setTimeout(resolve, waitMs));

  const beta = await connectAgentSender(workspace, "beta");
  await beta.request("agent_request", {
    target: `demo/${g1.id}`, text: "check G1", idempotency_key: "cap-gemini-g1",
  });
  await waitFor(() => agyPromptCount(workspace) >= 3, () => "G1 agent prompt running", 15000);
  await beta.request("agent_request", {
    target: `demo/${g2.id}`, text: "check G2", idempotency_key: "cap-gemini-g2",
  });
  await waitFor(() => agyPromptCount(workspace) >= 4, () => "G2 agent prompt running", 15000);

  // While G1 and G2 run agent-started turns, G3 queues and neither is evicted.
  requestProviderThread(workspace, g3, "gemini");
  await threadRow(workspace, g3, row => row.provider === "gemini");
  message(workspace, g3, "g3-1", "start G3");
  await threadRow(workspace, g3, row => row.state === "queued");
  await waitFor(() => notices(workspace, g3).length === 1, () => "G3 queued notice");
  assert.deepEqual(notices(workspace, g3), ["Queued, 2 sessions busy."]);
  assert.equal((await threadRow(workspace, g1)).state, "live");
  assert.equal((await threadRow(workspace, g2)).state, "live");

  // Release both agent-started turns; G1's idle clock was untouched so drain evicts G1 immediately.
  fs.writeFileSync(gateG1, "go");
  fs.writeFileSync(gateG2, "go");
  await waitForThreadIdle(workspace, "demo", g1.id);
  await waitForThreadIdle(workspace, "demo", g2.id);
  const agentDoneAt = Date.now();
  threadEvent(workspace, THREADS.d, "create");
  const evictedG1 = await threadRow(workspace, g1, row => row.state === "stopped");
  assert.ok(Date.now() - agentDoneAt < 2000, "G1 was evicted immediately without waiting a fresh 2 s idle window");
  await threadRow(workspace, g3, row => row.state === "live");
  await waitFor(() => replies(workspace, g3).length === 1, () => "G3 bootstrap reply", 20000);
  assert.deepEqual([evictedG1.state, evictedG1.stop_reason], ["stopped", "evicted"]);
  assert.deepEqual(notices(workspace, g1).filter(text => !text.startsWith("-# ⇄ Agent ")), [PAUSED]);
  assert.equal((await threadRow(workspace, g2)).state, "live");
});
