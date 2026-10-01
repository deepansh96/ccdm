import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { injectDiscordMessage } from "./support/bridge.js";
import { runScript } from "./support/runner.js";
import { OWNER_ID, ROOT_TOKEN, createRouterWorkspace, routerEnv, routerRegistry, routerWithWebhooks,
  runRouterCli, waitFor } from "./support/router.js";
import { readState, updateState } from "./support/state.js";
import { cleanup } from "./support/teardown.js";
import { startThreadSupervisor, supervisorStateDir, supervisorStatus } from "./support/thread-supervisor.js";

test.afterEach(cleanup);

// A Claude Thread Conversation end to end: the real Router, Thread
// Supervisor, start-thread-session.sh and CCDM channel server, with the
// fixture claude and tmux. Only Discord inputs go in; recorded Discord REST
// calls, Claude channel notifications and the supervisor CLI come out.
const THREAD_ID = "1700000000000123456";
// `<screen>-t-<last 6 of the thread id>`.
const THREAD_TMUX = "demo_claude-t-123456";
const ROOT_AUTH = `Bot ${ROOT_TOKEN}`;
const BOT_USER_ID = "fixture-bot-user-id";
const EYES = encodeURIComponent("👀");

function threadWorkspace(extra = {}) {
  const workspace = createRouterWorkspace({ ...routerRegistry({
    demo: { channel_id: "demo-channel", type: "claude", transport: "router", guest_user_ids: ["guest-id"],
      screen_name: "demo_claude" },
  }), root_channels: ["root-channel"], ...extra });
  const registryFile = path.join(workspace.repoDir, "registry.json");
  const registry = JSON.parse(fs.readFileSync(registryFile, "utf8"));
  registry.projects.demo.path = workspace.tmpDir;
  fs.writeFileSync(registryFile, `${JSON.stringify(registry, null, 2)}\n`);
  return workspace;
}

async function supervised(workspace, { env = {} } = {}) {
  await routerWithWebhooks(workspace, ["demo"]);
  updateState(workspace.stateDir, state => {
    state.fixtures.claude.replyText = "on it";
  });
  return startThreadSupervisor(workspace, { env });
}

function createThread(workspace, thread = {}) {
  updateState(workspace.stateDir, state => {
    (state.fixtures.discord.injectedThreads ||= []).push({ id: THREAD_ID, type: 11, parentId: "demo-channel",
      name: "Fix flaky test", ownerId: OWNER_ID, autoArchiveDuration: 1440, event: "create", ...thread });
  });
}

function threadMessage(workspace, id, content, author = { id: OWNER_ID, username: "Owner" }) {
  injectDiscordMessage(workspace, { id, channelId: THREAD_ID, content, author });
}

async function threadRow(workspace, predicate = () => true, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await supervisorStatus(workspace);
    const row = last.projects?.demo?.threads?.[THREAD_ID];
    if (row && predicate(row)) return row;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`thread ${THREAD_ID} never matched: ${JSON.stringify(last)}`);
}

const discord = workspace => readState(workspace.stateDir).fixtures.discord;
const notifications = workspace => readState(workspace.stateDir).fixtures.claude.channelNotifications ?? [];
const occurrences = (text, needle) => text.split(needle).length - 1;
const threadReactions = (workspace, field) => (discord(workspace)[field] ?? [])
  .filter(reaction => reaction.channelId === THREAD_ID)
  .map(({ messageId, emoji, authorization }) => ({ messageId, emoji, authorization }));
const threadPosts = workspace => (discord(workspace).messages ?? []).filter(message => message.channelId === THREAD_ID);

test("an owner message in a new thread boots a Claude session whose first notification holds the preamble, the starter and every boot-time message once", async () => {
  const workspace = threadWorkspace();
  // The thread was started from this parent-channel message, whose id is the thread's.
  updateState(workspace.stateDir, state => {
    state.fixtures.discord.history = { "demo-channel": [{ id: THREAD_ID, content: "The parser drops trailing commas",
      author: { id: OWNER_ID, username: "Owner" } }] };
  });
  await supervised(workspace);
  createThread(workspace);
  await threadRow(workspace);

  // Both arrive before the thread session's hello.
  threadMessage(workspace, "boot-message-1", "please fix the parser");
  threadMessage(workspace, "boot-message-2", "and add a regression test", { id: "guest-id", username: "Guest" });
  await threadRow(workspace, row => row.state === "live");
  await waitFor(() => notifications(workspace).length === 1 && threadPosts(workspace).length === 1,
    () => `the bootstrap notification and its reply: ${JSON.stringify(readState(workspace.stateDir).fixtures.claude)}`,
    15000);

  const [bootstrap] = notifications(workspace);
  assert.equal(bootstrap.meta.chat_id, THREAD_ID);
  assert.equal(bootstrap.meta.message_id, "boot-message-2");
  assert.match(bootstrap.content, /demo/);
  assert.match(bootstrap.content, new RegExp(THREAD_ID));
  assert.match(bootstrap.content, /Fix flaky test/);
  assert.match(bootstrap.content, /only in this thread/i);
  for (const text of ["The parser drops trailing commas", "please fix the parser", "and add a regression test"]) {
    assert.equal(occurrences(bootstrap.content, text), 1, `${text} in ${bootstrap.content}`);
  }
  assert.ok(bootstrap.content.indexOf("please fix the parser") < bootstrap.content.indexOf("and add a regression test"));
  assert.deepEqual(threadReactions(workspace, "reactions"),
    [{ messageId: "boot-message-1", emoji: EYES, authorization: ROOT_AUTH }]);
  assert.deepEqual(threadReactions(workspace, "reactionDeletes"),
    [{ messageId: "boot-message-1", emoji: EYES, authorization: ROOT_AUTH }]);
  assert.deepEqual(threadPosts(workspace).map(({ content, username, webhookId }) => ({ content, username, webhookId })),
    [{ content: "on it", username: "demo-claude", webhookId: "fake-webhook-1" }]);
  // The parent channel heard nothing of it.
  assert.deepEqual((discord(workspace).messages ?? []).filter(message => message.channelId !== THREAD_ID), []);
});

// Claude runs its statusline with its own environment, which carries the
// thread launch's key path.
function runStatusline(workspace, pct) {
  return runScript(workspace, "scripts/cc-statusline-wrapper.sh", {
    env: { CCDM_ROUTER_KEY_FILE: path.join(workspace.routerStateDir, "keys", `.thread-${THREAD_ID}.key`) },
    input: `${JSON.stringify({ context_window: { used_percentage: pct } })}\n`,
  });
}

test("a message after live arrives once as a live event, and its reply posts into the thread as demo-claude · N%", async () => {
  const workspace = threadWorkspace();
  await supervised(workspace);
  createThread(workspace);
  await threadRow(workspace);
  threadMessage(workspace, "boot-message-1", "please fix the parser");
  await threadRow(workspace, row => row.state === "live");
  await waitFor(() => threadPosts(workspace).length === 1, () => "the bootstrap reply", 15000);

  const statusline = await runStatusline(workspace, 42);
  assert.equal(statusline.exitCode, 0, statusline.stderr || statusline.stdout);
  threadMessage(workspace, "live-message-1", "how is it going?");
  await waitFor(() => threadPosts(workspace).length === 2, () => "the live reply", 15000);

  assert.deepEqual(notifications(workspace).slice(1), [{
    content: "how is it going?",
    meta: { chat_id: THREAD_ID, message_id: "live-message-1", user: "Owner", user_id: OWNER_ID,
      ts: notifications(workspace)[1].meta.ts },
  }]);
  assert.equal(notifications(workspace).length, 2);
  assert.equal(occurrences(notifications(workspace)[0].content, "how is it going?"), 0);
  assert.deepEqual(threadPosts(workspace).map(({ channelId, content, username, webhookId }) =>
    ({ channelId, content, username, webhookId })), [
    { channelId: THREAD_ID, content: "on it", username: "demo-claude", webhookId: "fake-webhook-1" },
    { channelId: THREAD_ID, content: "on it", username: "demo-claude · 42%", webhookId: "fake-webhook-1" },
  ]);
  // A live message gets no 👀: only the boot trigger did.
  assert.deepEqual(threadReactions(workspace, "reactions").map(reaction => reaction.messageId), ["boot-message-1"]);
});

test("an owner's native reply to a root-bot message or bot mention in a sessionless thread is root's and boots nothing", async () => {
  const workspace = threadWorkspace();
  await supervised(workspace);
  createThread(workspace);
  await threadRow(workspace);

  injectDiscordMessage(workspace, { id: "root-said", channelId: THREAD_ID, content: "the deploy finished",
    author: { id: BOT_USER_ID, username: "root", bot: true } });
  injectDiscordMessage(workspace, { id: "reply-to-root", channelId: THREAD_ID, content: "thanks root, now tail the logs",
    replyTo: "root-said", author: { id: OWNER_ID, username: "Owner" } });
  threadMessage(workspace, "mention-root", `<@${BOT_USER_ID}> are you there?`);
  await new Promise(resolve => setTimeout(resolve, 1500));
  const idle = await threadRow(workspace);
  assert.equal(idle.state, "registered");
  assert.equal(readState(workspace.stateDir).fixtures.tmux.sessions[THREAD_TMUX], undefined);
  assert.deepEqual(notifications(workspace), []);

  // The next ordinary message boots the session, whose bootstrap carries
  // none of root's messages.
  threadMessage(workspace, "boot-message-1", "please fix the parser");
  await threadRow(workspace, row => row.state === "live");
  await waitFor(() => notifications(workspace).length === 1, () => "the bootstrap notification", 15000);
  const [bootstrap] = notifications(workspace);
  assert.equal(bootstrap.meta.message_id, "boot-message-1");
  for (const text of ["thanks root, now tail the logs", "are you there?"]) {
    assert.equal(occurrences(bootstrap.content, text), 0, `${text} in ${bootstrap.content}`);
  }
});

const launchDir = workspace => path.join(workspace.routerStateDir, "launches", "demo", "threads", THREAD_ID);

async function liveThread(workspace) {
  createThread(workspace);
  await threadRow(workspace);
  threadMessage(workspace, "boot-message-1", "please fix the parser");
  await threadRow(workspace, row => row.state === "live");
  await waitFor(() => threadPosts(workspace).length === 1, () => "the bootstrap reply", 15000);
}

test("no Discord credential reaches the thread session's environment, launch files, mcp.json or settings.json", async () => {
  const workspace = threadWorkspace();
  await supervised(workspace);
  await liveThread(workspace);

  const state = readState(workspace.stateDir);
  const dir = launchDir(workspace);
  const files = fs.readdirSync(dir);
  assert.ok(files.includes("mcp.json") && files.includes("settings.json") && files.includes("bootstrap.json"),
    JSON.stringify(files));
  const mcpConfig = JSON.parse(fs.readFileSync(path.join(dir, "mcp.json"), "utf8"));
  assert.deepEqual(Object.keys(mcpConfig.mcpServers), ["ccdm"]);
  assert.equal(mcpConfig.mcpServers.ccdm.env.CCDM_THREAD_ID, THREAD_ID);
  assert.equal(mcpConfig.mcpServers.ccdm.env.CCDM_ROUTER_KEY_FILE,
    path.join(workspace.routerStateDir, "keys", `.thread-${THREAD_ID}.key`));
  const surfaces = [
    JSON.stringify(state.fixtures.tmux.sessions[THREAD_TMUX]),
    JSON.stringify(state.fixtures.claude.invocations),
    JSON.stringify(state.fixtures.claude.sessionEnvironments),
    ...files.map(file => fs.readFileSync(path.join(dir, file), "utf8")),
  ];
  assert.equal(state.fixtures.claude.sessionEnvironments.length, 2);
  for (const text of surfaces) {
    for (const secret of [ROOT_TOKEN, "pool-bot-token", "fake-webhook-token", "DISCORD_BOT_TOKEN", "DISCORD_STATE_DIR"]) {
      assert.equal(text.includes(secret), false, `${secret} leaked into ${text.slice(0, 200)}`);
    }
  }
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  for (const file of files) assert.equal(fs.statSync(path.join(dir, file)).mode & 0o777, 0o600, file);
  assert.equal(fs.statSync(path.join(workspace.routerStateDir, "keys", `.thread-${THREAD_ID}.key`)).mode & 0o777, 0o600);
  // The session runs in the project checkout, in its own tmux session.
  assert.equal(state.fixtures.tmux.sessions[THREAD_TMUX].cwd, workspace.tmpDir);
  assert.deepEqual(state.fixtures.tmux.sessions[THREAD_TMUX].command.slice(0, 2), ["zsh", "-ic"]);
  const status = await runRouterCli(workspace, ["status"]);
  assert.match(status.stdout, new RegExp(`thread demo thread=${THREAD_ID} provider=claude connected=`));
});

// The creation-request producer is a later slice, so a pending request goes in
// through the PRD's store schema; the root bot then creates the thread.
function requestThread(workspace, { account = null } = {}) {
  const store = path.join(supervisorStateDir(workspace), "threads.sqlite3");
  execFileSync("python3", ["-c", `import sqlite3, sys
db = sqlite3.connect(sys.argv[1], timeout=5)
db.execute("""INSERT INTO creation_requests (request_id, project, name, provider, account, model, effort,
  first_message, requester_id, requester_kind, status, thread_id, created_at)
  VALUES ('request-1', 'demo', 'Fix flaky test', NULL, ?, NULL, NULL, NULL, ?, 'owner', 'pending', NULL,
  '2026-10-01T00:00:00Z')""", (sys.argv[2] or None, sys.argv[3]))
db.commit()`, store, account ?? "", OWNER_ID]);
  createThread(workspace, { ownerId: BOT_USER_ID });
}

function setRegistry(workspace, update) {
  const file = path.join(workspace.repoDir, "registry.json");
  const registry = JSON.parse(fs.readFileSync(file, "utf8"));
  update(registry);
  fs.writeFileSync(file, `${JSON.stringify(registry, null, 2)}\n`);
}

const notices = workspace => threadPosts(workspace).filter(message => !message.webhookId)
  .map(({ content, authorization }) => ({ content, authorization }));

async function assertStartFailed(workspace, reason) {
  const row = await threadRow(workspace, current => current.state === "stopped");
  assert.deepEqual([row.state, row.stop_reason], ["stopped", "start-failed"]);
  await waitFor(() => notices(workspace).length === 1, () => "the start-failure notice", 15000);
  const [notice] = notices(workspace);
  assert.equal(notice.authorization, ROOT_AUTH);
  assert.match(notice.content, reason);
  assert.equal(notice.content.includes("\n"), false, notice.content);
  await waitFor(() => threadReactions(workspace, "reactionDeletes").length === 1, () => "the 👀 removal");
  assert.deepEqual(threadReactions(workspace, "reactions"),
    [{ messageId: "boot-message-1", emoji: EYES, authorization: ROOT_AUTH }]);
  assert.deepEqual(threadReactions(workspace, "reactionDeletes"),
    [{ messageId: "boot-message-1", emoji: EYES, authorization: ROOT_AUTH }]);
  assert.equal(notifications(workspace).length, 0);
  // The failed launch leaves no key, launch directory or tmux session behind.
  assert.equal(fs.existsSync(path.join(workspace.routerStateDir, "keys", `.thread-${THREAD_ID}.key`)), false);
  assert.equal(fs.existsSync(launchDir(workspace)), false);
  assert.equal(readState(workspace.stateDir).fixtures.tmux.sessions[THREAD_TMUX], undefined);
}

// The next eligible message starts the thread again, and this time it boots.
async function assertRetryBoots(workspace) {
  threadMessage(workspace, "retry-message-1", "try again");
  await threadRow(workspace, row => row.state === "live");
  await waitFor(() => notifications(workspace).length === 1, () => "the retried bootstrap", 15000);
  assert.match(notifications(workspace)[0].content, /try again/);
  assert.equal(occurrences(notifications(workspace)[0].content, "please fix the parser"), 0);
}

test("an unknown account alias fails the start with a one-line reason, and the next owner message retries", async () => {
  const workspace = threadWorkspace();
  await supervised(workspace);
  requestThread(workspace, { account: "work" });
  await threadRow(workspace, row => row.account === "work");
  threadMessage(workspace, "boot-message-1", "please fix the parser");
  await assertStartFailed(workspace, /^Thread session failed to start: .*Unknown Claude account alias 'work'/);

  setRegistry(workspace, registry => {
    registry.claude_accounts = { work: path.join(workspace.homeDir, ".claude-work") };
  });
  await assertRetryBoots(workspace);
});

test("a session that exits before its hello fails the start with a one-line reason, and the next owner message retries", async () => {
  const workspace = threadWorkspace();
  await supervised(workspace);
  updateState(workspace.stateDir, state => {
    state.fixtures.tmux.earlyExits = { [THREAD_TMUX]: 1 };
  });
  createThread(workspace);
  await threadRow(workspace);
  threadMessage(workspace, "boot-message-1", "please fix the parser");
  await assertStartFailed(workspace, /^Thread session failed to start: Claude exited before/);
  await assertRetryBoots(workspace);
});

test("a session that never says hello within the boot timeout fails the start, and the next owner message retries", async () => {
  const workspace = threadWorkspace();
  // The 120-second production default, shortened for the test.
  await supervised(workspace, { env: { CCDM_THREAD_BOOT_TIMEOUT_S: "3" } });
  updateState(workspace.stateDir, state => {
    state.fixtures.tmux.devChannelPrompt = "never";
  });
  createThread(workspace);
  await threadRow(workspace);
  threadMessage(workspace, "boot-message-1", "please fix the parser");
  await assertStartFailed(workspace, /^Thread session failed to start: .*within 3s/);
  updateState(workspace.stateDir, state => {
    delete state.fixtures.tmux.devChannelPrompt;
  });
  await assertRetryBoots(workspace);
});

test("a thread with a claude_accounts alias launches with that home", async () => {
  const workspace = threadWorkspace({ claude_accounts: { work: "~/.claude-work" } });
  await supervised(workspace);
  requestThread(workspace, { account: "work" });
  await threadRow(workspace, row => row.account === "work");
  threadMessage(workspace, "boot-message-1", "please fix the parser");
  await threadRow(workspace, row => row.state === "live");
  await waitFor(() => threadPosts(workspace).length === 1, () => "the bootstrap reply", 15000);

  const home = path.join(workspace.homeDir, ".claude-work");
  const [invocation] = readState(workspace.stateDir).fixtures.claude.invocations;
  assert.equal(invocation.env.CLAUDE_CONFIG_DIR, home);
  // Claude's session id comes from that home, into the supervisor's store, never the registry.
  assert.ok(fs.existsSync(path.join(home, "sessions", `${invocation.pid}.json`)));
  const registry = JSON.parse(fs.readFileSync(path.join(workspace.repoDir, "registry.json"), "utf8"));
  assert.equal(registry.projects.demo.session_id, undefined);
  assert.equal(registry.projects.demo.pid, undefined);
});

test("a second launch for the same thread is refused while the first runs", async () => {
  const workspace = threadWorkspace();
  await supervised(workspace);
  await liveThread(workspace);
  const keyFile = path.join(workspace.routerStateDir, "keys", `.thread-${THREAD_ID}.key`);
  const key = fs.readFileSync(keyFile, "utf8");

  const second = await runScript(workspace, "scripts/start-thread-session.sh", {
    args: ["demo", THREAD_ID, "--provider", "claude"], env: routerEnv(workspace),
  });

  assert.notEqual(second.exitCode, 0, second.stdout);
  assert.match(second.stderr, /Refusing to start thread 1700000000000123456/);
  assert.equal(fs.readFileSync(keyFile, "utf8"), key);
  assert.equal(readState(workspace.stateDir).fixtures.claude.invocations.length, 1);
  assert.ok(readState(workspace.stateDir).fixtures.tmux.sessions[THREAD_TMUX]);
  const status = await runRouterCli(workspace, ["status"]);
  assert.match(status.stdout, new RegExp(`thread demo thread=${THREAD_ID} provider=claude connected=`));
});
