import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { injectDiscordMessage, startFakeCodexServer } from "./support/bridge.js";
import { OWNER_ID, createRouterWorkspace, routerRegistry, routerWithWebhooks, waitFor } from "./support/router.js";
import { readState, updateState } from "./support/state.js";
import { cleanup } from "./support/teardown.js";
import { startThreadSupervisor, supervisorStateDir, supervisorStatus } from "./support/thread-supervisor.js";

test.afterEach(cleanup);

// Per-provider thread session caps end to end: the real Router, Thread
// Supervisor, start-thread-session.sh, CCDM channel server and codex-bridge.js,
// with the fixture claude, codex and tmux. Turn state comes only from the
// fixtures' turns: a fixture claude turn ends with its Stop hook unless the
// test holds it, and a fake app-server turn ends with `turn/completed`.
const BOT_USER_ID = "fixture-bot-user-id";
const PAUSED = "Paused to free a session slot; send a message here to resume.";
// The production 30-minute idle threshold, cut to nothing for the tests.
const NO_IDLE_WAIT = { CCDM_THREAD_IDLE_S: "0", CCDM_THREAD_ARCHIVE_POLL_WINDOW_S: "1",
  CCDM_THREAD_ARCHIVE_POLL_INTERVAL_S: "0.2" };
// Distinct last six digits give each thread its own tmux session.
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
  throw new Error(`thread ${thread.id} never matched: ${JSON.stringify(last)}`);
}

const discord = workspace => readState(workspace.stateDir).fixtures.discord;
const claude = workspace => readState(workspace.stateDir).fixtures.claude;
const posts = (workspace, thread) => (discord(workspace).messages ?? []).filter(post => post.channelId === thread.id);
const replies = (workspace, thread) => posts(workspace, thread).filter(post => post.webhookId);
const notices = (workspace, thread) => posts(workspace, thread).filter(post => !post.webhookId).map(post => post.content);
const stopHooks = workspace => (claude(workspace).hookRuns ?? []).filter(run => run.event === "Stop").length;
const invocationsFor = (workspace, thread) =>
  claude(workspace).invocations.filter(invocation => invocation.args.some(arg => arg.includes(`/threads/${thread.id}/`)));
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
  assert.deepEqual((await supervisorStatus(defaults)).capacity, { caps: { claude: 6, codex: 8 }, invalid: [] });

  const invalid = capacityWorkspace(capsRegistry({ claude: "lots", codex: 3 }));
  const { capacity } = await supervisorStatus(invalid);
  assert.deepEqual(capacity.caps, { claude: 6, codex: 3 });
  assert.equal(capacity.invalid.length, 1);
  assert.match(capacity.invalid[0], /thread_session_caps\.claude/);
});

test("a session mid-turn or without activity.json is never evicted: new threads queue, and drain FIFO as slots free", async () => {
  const workspace = capacityWorkspace(capsRegistry({ claude: 2 }));
  await supervised(workspace);
  holdTurns(workspace, THREADS.a);
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

  // An archive frees A's slot: the queue head, C, starts with its queued message.
  threadEvent(workspace, THREADS.a, "update", { archived: true, previous: { id: THREADS.a.id, archived: false } });
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
  execFileSync("python3", ["-c", `import sqlite3, sys
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
  await supervised(workspace, { CCDM_THREAD_WS_PORT_BASE: "29700" });
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
  assert.deepEqual(notices(workspace, THREADS.x), [PAUSED]);
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

  assert.equal((await supervisor.stop()).exitCode, 0);
  await startThreadSupervisor(workspace, { env: NO_IDLE_WAIT });
  // An archive frees A's slot for the queued thread.
  threadEvent(workspace, THREADS.a, "update", { archived: true, previous: { id: THREADS.a.id, archived: false } });

  await threadRow(workspace, created, row => row.state === "live");
  await waitFor(() => (claude(workspace).channelNotifications ?? []).some(n => n.meta.chat_id === created.id),
    () => "the queued thread's bootstrap", 20000);
  const bootstrap = claude(workspace).channelNotifications.find(n => n.meta.chat_id === created.id);
  assert.match(bootstrap.content, /please look at the flaky parser test/);
});
