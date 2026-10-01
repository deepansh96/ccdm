import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { injectDiscordMessage } from "./support/bridge.js";
import { runScript } from "./support/runner.js";
import { OWNER_ID, createRouterWorkspace, routerEnv, routerRegistry, routerWithWebhooks, runRouterCli,
  waitFor } from "./support/router.js";
import { readState, updateState } from "./support/state.js";
import { cleanup } from "./support/teardown.js";
import { startThreadSupervisor, supervisorStatus } from "./support/thread-supervisor.js";

test.afterEach(cleanup);

// Project changes and channel maintenance, end to end: the real Router,
// Thread Supervisor, start-session.sh, stop-session.sh,
// start-thread-session.sh and CCDM channel server, with the fixture claude
// and tmux. Registry edits, Discord inputs and the session scripts go in.
const THREAD_ID = "1700000000000410001";
const THREAD_TMUX = "demo_claude-t-410001";
const SIBLING_ID = "1700000000000410002";
const SIBLING_TMUX = "demo_claude-t-410002";
const CHANNEL_TMUX = "demo_claude";
const OWNER = { id: OWNER_ID, username: "Owner" };
const GUEST = { id: "guest-id", username: "Guest" };

function changesWorkspace() {
  const workspace = createRouterWorkspace({ ...routerRegistry({
    demo: { channel_id: "demo-channel", type: "claude", transport: "router", guest_user_ids: ["guest-id"],
      screen_name: "demo_claude" },
  }), root_channels: ["root-channel"] });
  editRegistry(workspace, registry => {
    registry.projects.demo.path = workspace.tmpDir;
  });
  return workspace;
}

const registryFile = workspace => path.join(workspace.repoDir, "registry.json");
const readRegistry = workspace => JSON.parse(fs.readFileSync(registryFile(workspace), "utf8"));

function editRegistry(workspace, change) {
  const next = readRegistry(workspace);
  change(next);
  fs.writeFileSync(`${registryFile(workspace)}.edit`, `${JSON.stringify(next, null, 2)}\n`);
  fs.renameSync(`${registryFile(workspace)}.edit`, registryFile(workspace));
}

// An atomic registry replace, as router-channel-move.test.js makes, once the
// Router has reloaded it.
async function changeRegistry(workspace, router, change) {
  await new Promise(resolve => setTimeout(resolve, 100));
  const reloads = () => router.stdout.split("registry reloaded").length - 1;
  const before = reloads();
  editRegistry(workspace, change);
  await waitFor(() => reloads() > before, () => `registry reload:\n${router.stdout}\n${router.stderr}`);
}

async function supervised(workspace) {
  const router = await routerWithWebhooks(workspace, ["demo"]);
  updateState(workspace.stateDir, state => {
    state.fixtures.claude.replyText = "on it";
  });
  return { router, supervisor: await startThreadSupervisor(workspace) };
}

async function threadRow(workspace, threadId, predicate = () => true, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await supervisorStatus(workspace);
    const row = Object.values(last.projects ?? {}).map(project => project.threads?.[threadId]).find(Boolean);
    if (row && predicate(row)) return row;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`thread ${threadId} never matched: ${JSON.stringify(last)}`);
}

const settle = ms => new Promise(resolve => setTimeout(resolve, ms));
const discord = workspace => readState(workspace.stateDir).fixtures.discord;
const claude = workspace => readState(workspace.stateDir).fixtures.claude;
const tmuxSessions = workspace => readState(workspace.stateDir).fixtures.tmux.sessions;
const notifications = (workspace, threadId) => (claude(workspace).channelNotifications ?? [])
  .filter(notification => notification.meta?.chat_id === threadId);
const replies = (workspace, threadId) => (discord(workspace).messages ?? [])
  .filter(message => message.channelId === threadId && message.webhookId);
const threadLaunches = (workspace, threadId) => claude(workspace).invocations
  .filter(invocation => invocation.env.CCDM_ROUTER_KEY_FILE?.endsWith(`.thread-${threadId}.key`));
const alive = pid => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const threadConnected = async (workspace, threadId) =>
  new RegExp(`thread demo thread=${threadId} `).test((await runRouterCli(workspace, ["status"])).stdout);
// Every Discord mutation the fakes record.
const MUTATIONS = ["messages", "edits", "deletes", "reactions", "reactionDeletes", "threadPatches", "threadCreates"];
const mutations = workspace => Object.fromEntries(MUTATIONS.map(field => [field, discord(workspace)[field] ?? []]));

function threadMessage(workspace, threadId, id, content, author = OWNER) {
  injectDiscordMessage(workspace, { id, channelId: threadId, content, author });
}

async function liveThread(workspace, threadId) {
  updateState(workspace.stateDir, state => {
    (state.fixtures.discord.injectedThreads ||= []).push({ id: threadId, type: 11, parentId: "demo-channel",
      name: `thread ${threadId.slice(-6)}`, ownerId: OWNER_ID, autoArchiveDuration: 10080, event: "create" });
  });
  await threadRow(workspace, threadId);
  threadMessage(workspace, threadId, `boot-${threadId}`, "please fix the parser");
  await threadRow(workspace, threadId, row => row.state === "live" && row.provider_conversation_id != null);
  await waitFor(() => replies(workspace, threadId).length === 1, () => `${threadId}'s bootstrap reply`, 15000);
  return tmuxSessions(workspace)[threadId === THREAD_ID ? THREAD_TMUX : SIBLING_TMUX].pid;
}

async function gone(workspace, pid, tmux) {
  await waitFor(() => !alive(pid) && tmuxSessions(workspace)[tmux] === undefined,
    () => `${tmux} (pid ${pid}) to stop: ${JSON.stringify(tmuxSessions(workspace))}`, 15000);
}

test("deregistering a project stops its thread sessions and closes them as deregistered, with no Discord calls", async () => {
  const workspace = changesWorkspace();
  const { router } = await supervised(workspace);
  const threadPid = await liveThread(workspace, THREAD_ID);
  const siblingPid = await liveThread(workspace, SIBLING_ID);
  const before = mutations(workspace);

  await changeRegistry(workspace, router, registry => {
    delete registry.projects.demo;
  });

  const row = await threadRow(workspace, THREAD_ID, current => current.state === "closed");
  assert.deepEqual([row.state, row.stop_reason, row.close_reason], ["closed", null, "deregistered"]);
  const sibling = await threadRow(workspace, SIBLING_ID, current => current.state === "closed");
  assert.equal(sibling.close_reason, "deregistered");
  await gone(workspace, threadPid, THREAD_TMUX);
  await gone(workspace, siblingPid, SIBLING_TMUX);
  await settle(500);
  assert.deepEqual(mutations(workspace), before);
});

test("moving a project's channel stops its thread sessions and closes them as project-moved", async () => {
  const workspace = changesWorkspace();
  const { router } = await supervised(workspace);
  const threadPid = await liveThread(workspace, THREAD_ID);
  const before = mutations(workspace);

  await changeRegistry(workspace, router, registry => {
    registry.projects.demo.channel_id = "moved-channel";
  });

  const row = await threadRow(workspace, THREAD_ID, current => current.state === "closed");
  assert.deepEqual([row.state, row.stop_reason, row.close_reason], ["closed", null, "project-moved"]);
  await gone(workspace, threadPid, THREAD_TMUX);
  assert.deepEqual(mutations(workspace), before);
});

async function startChannel(workspace) {
  const started = await runScript(workspace, "scripts/start-session.sh", { args: ["demo"], env: routerEnv(workspace) });
  assert.equal(started.exitCode, 0, started.stderr || started.stdout);
  return tmuxSessions(workspace)[CHANNEL_TMUX].pid;
}

async function stopSession(workspace, ...flags) {
  const stopped = await runScript(workspace, "scripts/stop-session.sh", { args: ["demo", ...flags], env: routerEnv(workspace) });
  assert.equal(stopped.exitCode, 0, stopped.stderr || stopped.stdout);
  return stopped;
}

async function assertThreadRuns(workspace, threadId, pid) {
  assert.ok(alive(pid), `thread ${threadId}'s listener still runs`);
  assert.ok(await threadConnected(workspace, threadId), `thread ${threadId} is still connected to the Router`);
  assert.equal(threadLaunches(workspace, threadId).length, 1);
  assert.equal((await threadRow(workspace, threadId)).state, "live");
}

test("stopping, restarting or rotating the key of the channel session leaves thread sessions running and connected", async () => {
  const workspace = changesWorkspace();
  await supervised(workspace);
  const channelPid = await startChannel(workspace);
  const threadPid = await liveThread(workspace, THREAD_ID);

  await stopSession(workspace);
  await waitFor(() => !alive(channelPid), () => "the channel session to stop", 15000);
  await settle(500);
  await assertThreadRuns(workspace, THREAD_ID, threadPid);

  const restartedPid = await startChannel(workspace);
  assert.notEqual(restartedPid, channelPid);
  await settle(500);
  await assertThreadRuns(workspace, THREAD_ID, threadPid);

  const projectKey = path.join(workspace.routerStateDir, "keys", "demo.key");
  fs.writeFileSync(projectKey, "rotated-project-key\n", { mode: 0o600 });
  await settle(1000);
  await assertThreadRuns(workspace, THREAD_ID, threadPid);
  threadMessage(workspace, THREAD_ID, "after-maintenance", "still there?");
  await waitFor(() => notifications(workspace, THREAD_ID).some(item => item.content.includes("still there?")),
    () => "the thread session to hear a new message", 15000);
});

test("--threads stops only the project's thread sessions as stopped/operator, and a supervisor restart leaves them stopped", async () => {
  const workspace = changesWorkspace();
  const { supervisor } = await supervised(workspace);
  const channelPid = await startChannel(workspace);
  const threadPid = await liveThread(workspace, THREAD_ID);
  const siblingPid = await liveThread(workspace, SIBLING_ID);

  await stopSession(workspace, "--threads");

  for (const threadId of [THREAD_ID, SIBLING_ID]) {
    const row = await threadRow(workspace, threadId);
    assert.deepEqual([row.state, row.stop_reason, row.close_reason], ["stopped", "operator", null]);
  }
  await gone(workspace, threadPid, THREAD_TMUX);
  await gone(workspace, siblingPid, SIBLING_TMUX);
  assert.ok(alive(channelPid), "the channel session still runs");
  assert.equal(tmuxSessions(workspace)[CHANNEL_TMUX].pid, channelPid);
  assert.equal(readRegistry(workspace).projects.demo.pid, channelPid);

  assert.equal((await supervisor.stop()).exitCode, 0);
  await startThreadSupervisor(workspace);
  await settle(1500);
  for (const threadId of [THREAD_ID, SIBLING_ID]) {
    assert.equal((await threadRow(workspace, threadId)).stop_reason, "operator");
    assert.equal(threadLaunches(workspace, threadId).length, 1);
  }
});

test("--all stops the channel session and the thread sessions", async () => {
  const workspace = changesWorkspace();
  await supervised(workspace);
  const channelPid = await startChannel(workspace);
  const threadPid = await liveThread(workspace, THREAD_ID);

  const stopped = await stopSession(workspace, "--all");

  assert.match(stopped.stdout, /Stopped Discord session 'demo'/);
  assert.match(stopped.stdout, /Stopped 1 thread session\(s\) for 'demo'/);
  await waitFor(() => !alive(channelPid) && tmuxSessions(workspace)[CHANNEL_TMUX] === undefined,
    () => "the channel session to stop", 15000);
  assert.equal(readRegistry(workspace).projects.demo.pid, null);
  await gone(workspace, threadPid, THREAD_TMUX);
  const row = await threadRow(workspace, THREAD_ID);
  assert.deepEqual([row.state, row.stop_reason], ["stopped", "operator"]);
});

test("with the supervisor down, --threads still stops the thread sessions by their key paths", async () => {
  const workspace = changesWorkspace();
  const { supervisor } = await supervised(workspace);
  const channelPid = await startChannel(workspace);
  const threadPid = await liveThread(workspace, THREAD_ID);
  const siblingPid = await liveThread(workspace, SIBLING_ID);
  assert.equal((await supervisor.stop()).exitCode, 0);
  assert.ok(alive(threadPid) && alive(siblingPid), "thread sessions outlive the supervisor");

  const stopped = await stopSession(workspace, "--threads");

  assert.match(stopped.stdout, /swept 2 thread session\(s\) for 'demo' by key path/);
  await gone(workspace, threadPid, THREAD_TMUX);
  await gone(workspace, siblingPid, SIBLING_TMUX);
  for (const threadId of [THREAD_ID, SIBLING_ID]) {
    assert.equal(fs.existsSync(path.join(workspace.routerStateDir, "keys", `.thread-${threadId}.key`)), false);
    const row = await threadRow(workspace, threadId);
    assert.deepEqual([row.state, row.stop_reason], ["stopped", "operator"]);
  }
  assert.ok(alive(channelPid), "the channel session still runs");
});

// Claude keeps a conversation's transcript at
// <home>/projects/<cwd, each non-alphanumeric character as "-">/<id>.jsonl.
function writeClaudeTranscript(workspace, sessionId) {
  const dir = path.join(workspace.homeDir, ".claude", "projects", workspace.tmpDir.replace(/[^A-Za-z0-9]/g, "-"));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), "{}\n");
}

test("a guest revoked from the parent can no longer drive a live thread or resume a stopped one", async () => {
  const workspace = changesWorkspace();
  const { router } = await supervised(workspace);
  await liveThread(workspace, THREAD_ID);
  threadMessage(workspace, THREAD_ID, "guest-granted", "granted guest here", GUEST);
  await waitFor(() => notifications(workspace, THREAD_ID).some(item => item.content.includes("granted guest here")),
    () => "the granted guest's message in the session", 15000);

  await changeRegistry(workspace, router, registry => {
    registry.projects.demo.guest_user_ids = [];
  });
  threadMessage(workspace, THREAD_ID, "guest-revoked-live", "revoked guest, live", GUEST);
  await settle(1500);
  assert.equal(notifications(workspace, THREAD_ID).some(item => item.content.includes("revoked guest, live")), false);

  const { provider_conversation_id: conversationId } = await threadRow(workspace, THREAD_ID);
  writeClaudeTranscript(workspace, conversationId);
  await stopSession(workspace, "--threads");
  await threadRow(workspace, THREAD_ID, row => row.state === "stopped");
  threadMessage(workspace, THREAD_ID, "guest-revoked-stopped", "revoked guest, stopped", GUEST);
  await settle(1500);
  assert.equal((await threadRow(workspace, THREAD_ID)).state, "stopped");
  assert.equal(threadLaunches(workspace, THREAD_ID).length, 1);

  threadMessage(workspace, THREAD_ID, "owner-resume", "owner here", OWNER);
  await threadRow(workspace, THREAD_ID, row => row.state === "live");
  assert.equal(threadLaunches(workspace, THREAD_ID).length, 2);
});
