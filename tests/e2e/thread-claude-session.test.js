import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { injectDiscordMessage } from "./support/bridge.js";
import { PYTHON, assertPrivate, platformGate } from "./support/platform.js";
import { runScript } from "./support/runner.js";
import { OWNER_ID, ROOT_TOKEN, createRouterWorkspace, routerRegistry, routerWithWebhooks,
  runRouterCli, waitFor } from "./support/router.js";
import { tmuxCalls } from "./support/session-fixture.js";
import { readState, updateState } from "./support/state.js";
import { cleanup, registerTeardownCallback } from "./support/teardown.js";
import { startThreadHost, startThreadSupervisor, supervisorEnv, supervisorStateDir, supervisorStatus } from "./support/thread-supervisor.js";

test.afterEach(cleanup);

// A Claude Thread Conversation end to end: the real Router, Thread
// Supervisor, start-thread-session.sh and CCDM channel server, with the
// fixture claude and tmux. Only Discord inputs go in; recorded Discord REST
// calls, Claude channel notifications and the supervisor CLI come out.
const THREAD_ID = "1700000000000123456";
// `<screen>-t-<thread id>`.
const THREAD_TMUX = `demo_claude-t-${THREAD_ID}`;
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
  return runScript(workspace, process.platform === "win32" ? "scripts/statusline-context.js" : "scripts/cc-statusline-wrapper.sh", {
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
  assertPrivate(dir);
  for (const file of files) assertPrivate(path.join(dir, file), file);
  assertPrivate(path.join(workspace.routerStateDir, "keys", `.thread-${THREAD_ID}.key`));
  // The session runs in the project checkout, in its own tmux session.
  assert.equal(state.fixtures.tmux.sessions[THREAD_TMUX].cwd, workspace.tmpDir);
  if (process.platform === "win32") assert.equal(state.fixtures.sessionHost.launches.at(-1).kind, "thread");
  else assert.deepEqual(state.fixtures.tmux.sessions[THREAD_TMUX].command.slice(0, 2), ["zsh", "-ic"]);
  const status = await runRouterCli(workspace, ["status"]);
  assert.match(status.stdout, new RegExp(`thread demo thread=${THREAD_ID} provider=claude connected=`));
});

// The creation-request producer is a later slice, so a pending request goes in
// through the PRD's store schema; the root bot then creates the thread.
function requestThread(workspace, { account = null } = {}) {
  const store = path.join(supervisorStateDir(workspace), "threads.sqlite3");
  execFileSync(PYTHON, ["-c", `import sqlite3, sys
db = sqlite3.connect(sys.argv[1], timeout=5)
db.execute("""INSERT INTO creation_requests (request_id, project, name, provider, account, model, effort,
  first_message, requester_id, requester_kind, status, thread_id, created_at)
  VALUES ('request-1', 'demo', 'Fix flaky test', NULL, ?, NULL, NULL, NULL, ?, 'owner', 'pending', NULL,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))""", (sys.argv[2] or None, sys.argv[3]))
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
    args: ["demo", THREAD_ID, "--provider", "claude"], env: supervisorEnv(workspace),
  });

  assert.notEqual(second.exitCode, 0, second.stdout);
  assert.match(second.stderr, /Refusing to start thread 1700000000000123456/);
  assert.equal(fs.readFileSync(keyFile, "utf8"), key);
  assert.equal(readState(workspace.stateDir).fixtures.claude.invocations.length, 1);
  assert.ok(readState(workspace.stateDir).fixtures.tmux.sessions[THREAD_TMUX]);
  const status = await runRouterCli(workspace, ["status"]);
  assert.match(status.stdout, new RegExp(`thread demo thread=${THREAD_ID} provider=claude connected=`));
});

test("a failed launch's cleanup leaves the key and launch dir a newer launch of the thread took over", async () => {
  const workspace = threadWorkspace();
  await routerWithWebhooks(workspace, ["demo"]);
  if (process.platform === "win32") await startThreadHost(workspace);
  createThread(workspace);
  await waitFor(() => discord(workspace).threads?.[THREAD_ID], () => "the thread in Discord");
  updateState(workspace.stateDir, state => {
    state.fixtures.claude.holdHellosIn = [THREAD_ID];
  });
  const launching = runScript(workspace, "scripts/start-thread-session.sh", {
    args: ["demo", THREAD_ID, "--provider", "claude"], env: supervisorEnv(workspace, { CCDM_THREAD_BOOT_TIMEOUT_S: "30" }),
  });
  const keyFile = path.join(workspace.routerStateDir, "keys", `.thread-${THREAD_ID}.key`);
  const launchDir = path.join(workspace.routerStateDir, "launches", "demo", "threads", THREAD_ID);
  await waitFor(() => readState(workspace.stateDir).fixtures.tmux.sessions[THREAD_TMUX]?.devChannelPrompt === "accepted",
    () => "the held launch");
  // A newer launch of the thread has written its own token and key meanwhile.
  fs.writeFileSync(path.join(launchDir, ".launch-token"), "newer-launch\n");
  fs.writeFileSync(keyFile, "newer-key\n");
  // The earlier launch's session goes before its hello, so that launch fails.
  const { pid } = readState(workspace.stateDir).fixtures.tmux.sessions[THREAD_TMUX];
  updateState(workspace.stateDir, state => {
    delete state.fixtures.tmux.sessions[THREAD_TMUX];
  });
  process.kill(process.platform === "win32" ? pid : -pid, "SIGKILL");

  const result = await launching;
  assert.notEqual(result.exitCode, 0, result.stdout);
  assert.match(result.stderr, /Leaving thread 1700000000000123456's launch files to its newer launch/);
  assert.equal(fs.readFileSync(keyFile, "utf8"), "newer-key\n");
  assert.equal(fs.readFileSync(path.join(launchDir, ".launch-token"), "utf8"), "newer-launch\n");
});

test("a resumed session's bootstrap carries the message that resumed it but not the thread's starter again", async () => {
  const workspace = threadWorkspace();
  updateState(workspace.stateDir, state => {
    state.fixtures.discord.history = { "demo-channel": [{ id: THREAD_ID, content: "The parser drops trailing commas",
      author: { id: OWNER_ID, username: "Owner" } }] };
  });
  await supervised(workspace);
  createThread(workspace);
  await threadRow(workspace);
  threadMessage(workspace, "boot-message-1", "please fix the parser");
  const live = await threadRow(workspace, row => row.state === "live" && row.provider_conversation_id != null);
  await waitFor(() => notifications(workspace).length === 1 && threadPosts(workspace).length === 1,
    () => "the bootstrap and its reply", 15000);
  assert.equal(occurrences(notifications(workspace)[0].content, "The parser drops trailing commas"), 1);

  // An inactivity archive stops the session; the next owner message resumes it.
  updateState(workspace.stateDir, state => {
    state.fixtures.discord.injectedThreads.push({ id: THREAD_ID, type: 11, parentId: "demo-channel",
      name: "Fix flaky test", ownerId: OWNER_ID, autoArchiveDuration: 1440, event: "update", archived: true,
      previous: { id: THREAD_ID, archived: false } });
  });
  await threadRow(workspace, row => row.state === "stopped");
  const transcripts = path.join(workspace.homeDir, ".claude", "projects", workspace.tmpDir.replace(/[^A-Za-z0-9]/g, "-"));
  fs.mkdirSync(transcripts, { recursive: true });
  fs.writeFileSync(path.join(transcripts, `${live.provider_conversation_id}.jsonl`), "{}\n");
  threadMessage(workspace, "resume-message-1", "picking this back up");

  await threadRow(workspace, row => row.state === "live");
  await waitFor(() => notifications(workspace).length === 2, () => "the resumed bootstrap", 15000);
  const resumed = notifications(workspace)[1].content;
  assert.equal(occurrences(resumed, "picking this back up"), 1, resumed);
  assert.equal(occurrences(resumed, "The parser drops trailing commas"), 0, resumed);
});

// ---- the launcher, on each backend ----

const WIN = process.platform === "win32";
// Windows has only the fake ccdm-host; POSIX runs each case on tmux and on the fake host.
const BACKENDS = WIN ? ["ccdm-host"] : ["tmux", "ccdm-host"];
const KEY_FILE_FLAG = "--ccdm-key-file";
const keyPath = workspace => path.join(workspace.routerStateDir, "keys", `.thread-${THREAD_ID}.key`);

// `workspace` with its thread session on `backend`: the worker's env for it.
async function backendSession(workspace, backend) {
  if (backend === "ccdm-host") await startThreadHost(workspace);
  await supervised(workspace);
}

// Through run() itself: the in-process contract, with no shell in the way.
const RUN_LAUNCHER = `
import json, os, sys
sys.dont_write_bytecode = True
sys.path.insert(0, sys.argv[1])
from ccdmlib.cli import start_thread_session as launcher
print(json.dumps(launcher.run(json.loads(sys.argv[2]), dict(os.environ), os.getcwd())))
`;

function launcherRun(workspace, argv, env = {}) {
  return new Promise((resolve, reject) => {
    execFile(PYTHON, ["-c", RUN_LAUNCHER, path.join(workspace.repoDir, "scripts"), JSON.stringify(argv)], {
      cwd: workspace.tmpRoot, env: supervisorEnv(workspace, env), encoding: "utf8", windowsHide: true,
    }, (error, stdout, stderr) => {
      if (error) return reject(new Error(`${error.message}: ${stderr}`));
      const [returncode, out, err] = JSON.parse(stdout.trim().split("\n").at(-1));
      resolve({ returncode, stdout: out, stderr: err });
    });
  });
}

const homeRun = (workspace, home) => launcherRun(workspace, ["demo", THREAD_ID, "--provider", "claude", "--home", home]);

function assertNothingStarted(workspace) {
  assert.deepEqual(readState(workspace.stateDir).fixtures.claude.invocations, []);
  assert.equal(fs.existsSync(keyPath(workspace)), false);
  assert.deepEqual(tmuxCalls(workspace).filter(args => args[0] === "new-session"), []);
}

for (const value of ["with'quote", 'with"quote', "with$dollar", "with`backtick", "with\nnewline"]) {
  const shown = JSON.stringify(value);
  test(`a conversation home holding ${shown} is refused with exit 2, on every OS`, async () => {
    const workspace = threadWorkspace();
    const home = WIN ? `X:\\homes\\${value}` : `/tmp/${value}`;
    const result = await homeRun(workspace, home);
    assert.equal(result.returncode, 2, result.stderr);
    assert.equal(result.stderr.trim(), `Invalid conversation home: '${home}'`);
    assert.equal(result.stdout, "");
    assertNothingStarted(workspace);
  });
}

test("on Windows a drive or UNC conversation home passes the check and a relative one is refused", platformGate("win32", "Windows path forms"), async () => {
  const workspace = threadWorkspace();
  for (const home of ["X:\\homes\\claude-alt", "\\\\server\\share\\claude-alt"]) {
    // Past the shape check: the home simply does not exist on this machine.
    const accepted = await homeRun(workspace, home);
    assert.equal(accepted.returncode, 1, accepted.stderr);
    assert.equal(accepted.stderr.trim(), `The conversation's home ${home} is missing`);
  }
  for (const home of ["homes\\claude-alt", "\\homes\\claude-alt"]) {
    const refused = await homeRun(workspace, home);
    assert.equal(refused.returncode, 2, refused.stderr);
    assert.match(refused.stderr, /Invalid conversation home/);
  }
  assertNothingStarted(workspace);
});

test("a relative conversation home is refused on every OS, and on POSIX one holding a backslash", async () => {
  const workspace = threadWorkspace();
  for (const home of WIN ? ["homes\claude-alt"] : ["homes/claude-alt", "/tmp/with\backslash"]) {
    const refused = await homeRun(workspace, home);
    assert.equal(refused.returncode, 2, refused.stderr);
    assert.equal(refused.stderr.trim(), `Invalid conversation home: '${home}'`);
  }
  assertNothingStarted(workspace);
});

test("run() gives the command's usage, exit code and id checks, with nothing on stdout", async () => {
  const workspace = threadWorkspace();
  const usage = await launcherRun(workspace, ["demo"]);
  assert.equal(usage.returncode, 2);
  assert.match(usage.stderr, /^Usage: .* <project> <thread_id> --provider claude\|codex /);
  const badId = await launcherRun(workspace, ["demo", "../evil", "--provider", "claude"]);
  assert.equal(badId.returncode, 2);
  assert.equal(badId.stderr.trim(), "Invalid thread id: '../evil'");
  const badResume = await launcherRun(workspace, ["demo", THREAD_ID, "--provider", "claude", "--resume", "no/such"]);
  assert.equal(badResume.returncode, 2);
  assert.equal(badResume.stderr.trim(), "Invalid conversation id to resume: 'no/such'");
  assert.equal(badId.stdout + badResume.stdout + usage.stdout, "");
  assertNothingStarted(workspace);
});

test("boot needs no shell script: a thread boots to live with the shim gone, through its one launcher", async () => {
  const workspace = threadWorkspace();
  fs.rmSync(path.join(workspace.repoDir, "scripts", "start-thread-session.sh"));
  await supervised(workspace);
  await liveThread(workspace);
  assert.equal(readState(workspace.stateDir).fixtures.claude.invocations.length, 1);
});

for (const backend of BACKENDS) {
  test(`${backend}: a launch that shows the folder-trust prompt, then the channel prompt, reaches the Router`, async () => {
    const workspace = threadWorkspace();
    updateState(workspace.stateDir, state => { state.fixtures.claude.trustPrompt = true; });
    await backendSession(workspace, backend);
    await liveThread(workspace);
    const session = readState(workspace.stateDir).fixtures.tmux.sessions[THREAD_TMUX];
    assert.deepEqual(session.sendKeys, [["Enter"], ["Enter"]]);
    assert.deepEqual([session.trustPrompt, session.devChannelPrompt], ["accepted", "accepted"]);
    const status = await runRouterCli(workspace, ["status"]);
    assert.match(status.stdout, new RegExp(`thread demo thread=${THREAD_ID} provider=claude connected=`));
  });

  test(`${backend}: an already-trusted launch accepts the channel prompt within 1 s of it appearing`, async () => {
    const workspace = threadWorkspace();
    await backendSession(workspace, backend);
    createThread(workspace);
    await threadRow(workspace);
    threadMessage(workspace, "boot-message-1", "please fix the parser");
    let appeared;
    for (;;) {
      const session = readState(workspace.stateDir).fixtures.tmux.sessions[THREAD_TMUX];
      if (session?.devChannelPrompt === "pending" && appeared === undefined) appeared = performance.now();
      if (session?.devChannelPrompt === "accepted") break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.ok(appeared === undefined || performance.now() - appeared < 1000, "Enter came more than 1 s after the channel prompt");
    await threadRow(workspace, row => row.state === "live");
    assert.deepEqual(readState(workspace.stateDir).fixtures.tmux.sessions[THREAD_TMUX].sendKeys, [["Enter"]]);
  });

  test(`${backend}: the thread mcp.json args carry the key file, the launch env holds no CCDM_THREAD_TMUX, and the hook strings are hook_command()'s`, async () => {
    const workspace = threadWorkspace();
    await backendSession(workspace, backend);
    await liveThread(workspace);
    const dir = launchDir(workspace);
    const mcp = JSON.parse(fs.readFileSync(path.join(dir, "mcp.json"), "utf8")).mcpServers.ccdm;
    const scriptsDir = path.join(fs.realpathSync.native(workspace.repoDir), "scripts");
    assert.deepEqual(mcp.args, [path.join(scriptsDir, "ccdm-channel-server.js"), KEY_FILE_FLAG, keyPath(workspace)]);
    assert.equal("CCDM_THREAD_TMUX" in mcp.env, false);
    const launch = readState(workspace.stateDir).fixtures.sessionHost.launches.at(-1);
    assert.equal("CCDM_THREAD_TMUX" in launch.env, false);
    assert.equal(launch.env.CCDM_SESSION_NAME, THREAD_TMUX);

    const python = script => execFileSync(PYTHON, ["-B", "-c", `import sys
sys.path.insert(0, sys.argv[1])
from ccdmlib.platform.hooks import hook_command
print(hook_command(*sys.argv[2:]))`, path.join(workspace.repoDir, "scripts"), ...script], { encoding: "utf8" }).trim();
    const expected = (...parts) => {
      const command = python(parts);
      if (!WIN) assert.equal(command, `node ${parts.map(part => `'${part}'`).join(" ")}`);
      else assert.equal(command, `node ${parts.map(part => `'${part.replaceAll("\\", "/")}'`).join(" ")}`);
      return command;
    };
    const activity = expected(path.join(scriptsDir, "thread-activity.js"), path.join(dir, "activity.json"));
    const reminder = expected(path.join(scriptsDir, "claude-reminder-hook.js"));
    const settings = JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf8"));
    const commands = event => settings.hooks[event][0].hooks.map(hook => hook.command);
    assert.deepEqual(commands("Stop"), [activity, reminder]);
    assert.deepEqual(commands("StopFailure"), [activity, reminder]);
    assert.deepEqual(commands("SessionStart"), [reminder]);
    assert.deepEqual(commands("SessionEnd"), [reminder]);
    if (WIN) {
      assert.deepEqual(settings.statusLine, { type: "command", command: `node '${path.join(scriptsDir, "statusline-context.js").replaceAll("\\", "/")}'` });
    } else {
      assert.equal("statusLine" in settings, false);
    }
  });
}

test("a thread's own session gets the state root and backend it needs to find the host", async () => {
  const workspace = threadWorkspace();
  const host = await startThreadHost(workspace);
  await supervised(workspace);
  await liveThread(workspace);
  const launch = readState(workspace.stateDir).fixtures.sessionHost.launches.at(-1);
  assert.equal(launch.env.CCDM_STATE_ROOT, host.env.CCDM_STATE_ROOT);
  assert.equal(launch.env.CCDM_SESSION_HOST, "ccdm-host");
});

test("on Windows a second launch of a live thread is refused because a process carries its key file", platformGate("win32", "POSIX finds listeners by their environment"), async () => {
  const workspace = threadWorkspace();
  await routerWithWebhooks(workspace, ["demo"]);
  await startThreadHost(workspace);
  const listener = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "--", KEY_FILE_FLAG, keyPath(workspace)],
    { stdio: "ignore", windowsHide: true });
  const exited = new Promise(resolve => listener.once("exit", resolve));
  registerTeardownCallback(async () => {
    listener.kill();
    await exited;
  });
  await new Promise(resolve => setTimeout(resolve, 500));

  const second = await launcherRun(workspace, ["demo", THREAD_ID, "--provider", "claude"]);

  assert.equal(second.returncode, 1, second.stderr);
  assert.match(second.stderr, new RegExp(`Refusing to start thread ${THREAD_ID}: listener process\\(es\\) already use .*${listener.pid}`));
  assert.equal(readState(workspace.stateDir).fixtures.tmux.sessions[THREAD_TMUX], undefined);
});

test("on Windows the recorded runtime_pid is the Claude process, stored with its start time", platformGate("win32", "only Windows records a start time"), async () => {
  const workspace = threadWorkspace();
  await supervised(workspace);
  await liveThread(workspace);
  const store = path.join(supervisorStateDir(workspace), "threads.sqlite3");
  const row = () => JSON.parse(execFileSync(PYTHON, ["-c",
    `import json, sqlite3, sys
db = sqlite3.connect(sys.argv[1])
print(json.dumps(db.execute("SELECT runtime_pid, runtime_tmux, provider_home FROM threads WHERE thread_id = ?", (sys.argv[2],)).fetchone()))`,
    store, THREAD_ID], { encoding: "utf8" }));
  await waitFor(() => row()[0] != null, () => "the launcher's result on the row");
  const [pid, tmux, home] = row();
  assert.equal(tmux, THREAD_TMUX);
  assert.equal(pid, readState(workspace.stateDir).fixtures.claude.invocations[0].pid);
  assert.ok(fs.existsSync(path.join(home, "sessions", `${pid}.json`)), `${home}/sessions/${pid}.json`);
  const runtime = JSON.parse(fs.readFileSync(path.join(launchDir(workspace), "runtime.json"), "utf8"));
  assert.equal(runtime.pid, pid);
  assert.match(runtime.pid_started_at, /^\d+$/);
});
