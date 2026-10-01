import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { collectProcess, injectDiscordMessage, startFakeCodexServer } from "./support/bridge.js";
import { runScript } from "./support/runner.js";
import { OWNER_ID, ROOT_TOKEN, connectSession, createRouterWorkspace, routerEnv, routerRegistry,
  routerWithWebhooks, waitFor } from "./support/router.js";
import { readState, updateState } from "./support/state.js";
import { cleanup, registerTeardownCallback } from "./support/teardown.js";
import { startThreadSupervisor, supervisorEnv, supervisorStateDir, supervisorStatus } from "./support/thread-supervisor.js";

test.afterEach(cleanup);

// Creating a configured Thread Conversation with `/thread` in a project
// channel or `scripts/threads.sh create`, end to end: the real Router, Thread
// Supervisor, start-thread-session.sh and CCDM channel server, with the
// fixture claude and tmux. Only Discord inputs and threads.sh go in.
// The fake gives the root bot's first created thread this id.
const CREATED_THREAD_ID = "1600000000000000001";
// `<screen>-t-<last 6 of the thread id>`.
const CREATED_THREAD_TMUX = "demo_claude-t-000001";
const ROOT_AUTH = `Bot ${ROOT_TOKEN}`;
const BOT_USER_ID = "fixture-bot-user-id";

function commandWorkspace(extra = {}) {
  const workspace = createRouterWorkspace({ ...routerRegistry({
    demo: { channel_id: "demo-channel", type: "claude", transport: "router", guest_user_ids: ["guest-id"],
      screen_name: "demo_claude" },
  }), root_channels: ["root-channel"], claude_accounts: { work: "~/.claude-work" },
  codex_accounts: { "codex-work": "~/.codex-work" }, ...extra });
  const registryFile = path.join(workspace.repoDir, "registry.json");
  const registry = JSON.parse(fs.readFileSync(registryFile, "utf8"));
  registry.projects.demo.path = workspace.tmpDir;
  registry.projects.beta.path = workspace.tmpDir;
  registry.projects.beta.screen_name = "beta_codex";
  fs.writeFileSync(registryFile, `${JSON.stringify(registry, null, 2)}\n`);
  return workspace;
}

async function supervised(workspace, projects = ["demo"]) {
  await routerWithWebhooks(workspace, projects);
  updateState(workspace.stateDir, state => {
    state.fixtures.claude.replyText = "on it";
  });
  return startThreadSupervisor(workspace);
}

function channelMessage(workspace, id, content, author = { id: OWNER_ID, username: "Owner" }) {
  injectDiscordMessage(workspace, { id, channelId: "demo-channel", content, author });
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

const discord = workspace => readState(workspace.stateDir).fixtures.discord;
const claude = workspace => readState(workspace.stateDir).fixtures.claude;
const notifications = workspace => claude(workspace).channelNotifications ?? [];
const threadCreates = workspace => (discord(workspace).threadCreates ?? [])
  .map(({ authorization, body, channelId }) => ({ authorization, body, channelId }));
const posts = (workspace, channelId) => (discord(workspace).messages ?? [])
  .filter(message => message.channelId === channelId);
const notices = (workspace, channelId) => posts(workspace, channelId).filter(message => !message.webhookId)
  .map(({ content, authorization }) => ({ content, authorization }));
const settle = ms => new Promise(resolve => setTimeout(resolve, ms));

test("/thread with --model, --effort and a first message creates a one-week thread, posts its settings and starts Claude with that message as the starter", async () => {
  const workspace = commandWorkspace();
  await supervised(workspace);
  const channel = await connectSession(workspace, "demo", "demo-key");

  channelMessage(workspace, "thread-command-1", "/thread fix-login --model claude-test-model --effort high please look at X");
  await threadRow(workspace, CREATED_THREAD_ID, row => row.state === "live");
  await waitFor(() => notifications(workspace).length === 1 && posts(workspace, CREATED_THREAD_ID).length === 2,
    () => `the bootstrap and its reply: ${JSON.stringify(discord(workspace).messages)}`, 15000);

  assert.deepEqual(threadCreates(workspace), [{ authorization: ROOT_AUTH, channelId: "demo-channel",
    body: { name: "fix-login", type: 11, auto_archive_duration: 10080 } }]);
  const [notice] = notices(workspace, CREATED_THREAD_ID);
  assert.equal(notice.authorization, ROOT_AUTH);
  for (const setting of ["claude", "claude-test-model", "high", "please look at X"]) {
    assert.ok(notice.content.includes(setting), `${setting} in ${notice.content}`);
  }
  const [bootstrap] = notifications(workspace);
  assert.equal(bootstrap.meta.chat_id, CREATED_THREAD_ID);
  assert.match(bootstrap.content, /fix-login/);
  assert.match(bootstrap.content, /please look at X/);
  assert.equal(claude(workspace).invocations.length, 1);
  assert.match(readState(workspace.stateDir).fixtures.tmux.sessions[CREATED_THREAD_TMUX].shellCommand,
    /--model 'claude-test-model' --effort 'high'/);
  const row = await threadRow(workspace, CREATED_THREAD_ID);
  assert.deepEqual([row.name, row.provider, row.account, row.model, row.effort],
    ["fix-login", null, null, "claude-test-model", "high"]);
  // `/thread` reached neither the Channel Conversation nor any model, and the
  // channel heard nothing back.
  assert.deepEqual(channel.events.filter(event => event.message_id === "thread-command-1"), []);
  assert.equal(notifications(workspace).some(item => item.content.includes("/thread")), false);
  assert.deepEqual(posts(workspace, "demo-channel"), []);
});

test("/thread with no message creates the thread and starts nothing until the first owner message", async () => {
  const workspace = commandWorkspace();
  await supervised(workspace);

  channelMessage(workspace, "thread-command-1", "/thread quiet-one");
  await threadRow(workspace, CREATED_THREAD_ID);
  await waitFor(() => notices(workspace, CREATED_THREAD_ID).length === 1, () => "the settings notice", 15000);
  await settle(1000);
  assert.equal((await threadRow(workspace, CREATED_THREAD_ID)).state, "registered");
  assert.deepEqual(claude(workspace).invocations, []);
  assert.deepEqual(threadCreates(workspace).map(create => create.body),
    [{ name: "quiet-one", type: 11, auto_archive_duration: 10080 }]);

  injectDiscordMessage(workspace, { id: "first-owner-message", channelId: CREATED_THREAD_ID,
    content: "now start", author: { id: OWNER_ID, username: "Owner" } });
  await threadRow(workspace, CREATED_THREAD_ID, row => row.state === "live");
  await waitFor(() => notifications(workspace).length === 1, () => "the bootstrap", 15000);
  assert.match(notifications(workspace)[0].content, /now start/);
});

test("/thread from a guest creates a thread too", async () => {
  const workspace = commandWorkspace();
  await supervised(workspace);

  channelMessage(workspace, "thread-command-1", "/thread guest-task", { id: "guest-id", username: "Guest" });
  const row = await threadRow(workspace, CREATED_THREAD_ID);
  assert.equal(row.name, "guest-task");
});

test("an invalid provider, a foreign or unknown account alias, or an invalid model or effort posts a notice and creates no thread", async () => {
  const workspace = commandWorkspace();
  await supervised(workspace);
  const commands = [
    "/thread a --provider gemini hello",
    "/thread b --account nobody hello",
    // `work` is a Claude alias, not a Codex one.
    "/thread c --provider codex --account work hello",
    "/thread d --effort turbo hello",
    // `max` is a Claude effort, not a Codex one.
    "/thread e --provider codex --effort max hello",
    "/thread f --model bad;model hello",
    "/thread g --colour red hello",
    "/thread",
  ];
  commands.forEach((content, index) => channelMessage(workspace, `bad-command-${index}`, content));
  await waitFor(() => notices(workspace, "demo-channel").length === commands.length,
    () => `a notice per bad command: ${JSON.stringify(notices(workspace, "demo-channel"))}`, 15000);

  for (const notice of notices(workspace, "demo-channel")) {
    assert.equal(notice.authorization, ROOT_AUTH);
    assert.match(notice.content, /^Thread not created: /);
  }
  const texts = notices(workspace, "demo-channel").map(notice => notice.content);
  assert.match(texts[0], /gemini/);
  assert.match(texts[1], /nobody/);
  assert.match(texts[2], /work/);
  assert.match(texts[3], /turbo/);
  assert.match(texts[4], /max/);
  assert.match(texts[5], /bad;model/);
  assert.match(texts[6], /--colour/);
  assert.deepEqual(threadCreates(workspace), []);
  assert.deepEqual((await supervisorStatus(workspace)).projects, {});
});

function threadsCli(workspace, args) {
  return runScript(workspace, "scripts/threads.sh", { args, env: supervisorEnv(workspace) });
}

test("threads.sh create makes and starts a thread with an account alias, and a bad flag exits 2", async () => {
  const workspace = commandWorkspace();
  await supervised(workspace);
  const socket = fs.statSync(path.join(supervisorStateDir(workspace), "control.sock"));
  assert.ok(socket.isSocket());
  assert.equal(socket.mode & 0o777, 0o600);

  const created = await threadsCli(workspace, ["create", "demo", "cli-task", "--account", "work", "look at the logs"]);
  assert.equal(created.exitCode, 0, created.stderr || created.stdout);
  assert.equal(JSON.parse(created.stdout.trim().split("\n").at(-1)).thread_id, CREATED_THREAD_ID);
  await threadRow(workspace, CREATED_THREAD_ID, row => row.state === "live");
  await waitFor(() => notifications(workspace).length === 1, () => "the bootstrap", 15000);
  assert.match(notifications(workspace)[0].content, /look at the logs/);
  assert.equal(claude(workspace).invocations[0].env.CLAUDE_CONFIG_DIR, path.join(workspace.homeDir, ".claude-work"));
  assert.equal((await threadRow(workspace, CREATED_THREAD_ID)).account, "work");
  assert.deepEqual(threadCreates(workspace).map(create => create.body),
    [{ name: "cli-task", type: 11, auto_archive_duration: 10080 }]);
  const [notice] = notices(workspace, CREATED_THREAD_ID);
  assert.ok(notice.content.includes("work") && notice.content.includes("look at the logs"), notice.content);

  for (const args of [["create", "demo", "x", "--effort", "turbo"], ["create", "demo", "x", "--colour", "red"],
    ["create", "demo", "x", "--provider", "codex", "--account", "work"], ["create", "nowhere", "x"]]) {
    const refused = await threadsCli(workspace, args);
    assert.equal(refused.exitCode, 2, `${args.join(" ")}: ${refused.stderr || refused.stdout}`);
  }
  assert.equal(threadCreates(workspace).length, 1);
});

test("threads.sh create exits non-zero with a reason when no supervisor runs", async () => {
  const workspace = commandWorkspace();
  await routerWithWebhooks(workspace, ["demo"]);
  const result = await threadsCli(workspace, ["create", "demo", "x"]);
  assert.equal(result.exitCode, 1, result.stdout);
  assert.match(result.stderr, /supervisor/i);
});

test("a bot-created thread with no matching pending request binds nothing", async () => {
  const workspace = commandWorkspace();
  await supervised(workspace);
  updateState(workspace.stateDir, state => {
    (state.fixtures.discord.injectedThreads ||= []).push({ id: "1700000000000999999", type: 11,
      parentId: "demo-channel", name: "not requested", ownerId: BOT_USER_ID, event: "create" });
  });
  await waitFor(() => (discord(workspace).deliveredThreads ?? []).length === 1, () => "the thread_create");
  await settle(1000);
  assert.deepEqual((await supervisorStatus(workspace)).projects, {});
});

// A side task handed off from a Channel Conversation with the create_thread
// tool. The fixture claude runs `toolScript` on every notification, the
// Channel Conversation's and the new thread's alike.
async function channelSession(workspace, toolScript) {
  updateState(workspace.stateDir, state => {
    state.fixtures.claude.toolScript = toolScript;
  });
  const started = await runScript(workspace, "scripts/start-session.sh", { args: ["demo"], env: routerEnv(workspace) });
  assert.equal(started.exitCode, 0, started.stderr || started.stdout);
  channelMessage(workspace, "owner-message-1", "split the parser work off");
}

const toolResults = workspace => claude(workspace).toolResults ?? [];
const resultText = entry => entry.result?.content?.[0]?.text ?? entry.error?.message ?? "";
const toolList = (workspace, threadId) => (claude(workspace).toolLists ?? []).find(list => list.threadId === threadId);

test("a Claude channel session's create_thread with a first message creates a one-week thread with the notice and starts a thread session with that message as its starter", async () => {
  const workspace = commandWorkspace();
  await supervised(workspace);
  await channelSession(workspace, [{ name: "create_thread", arguments: { name: "parser-port", effort: "high",
    first_message: "port the parser to the new API" } }]);

  await waitFor(() => toolResults(workspace).some(entry => entry.name === "create_thread"),
    () => `the create_thread result: ${JSON.stringify(claude(workspace))}`, 15000);
  const [created] = toolResults(workspace).filter(entry => entry.name === "create_thread");
  assert.equal(created.result.isError, undefined, JSON.stringify(created));
  assert.match(resultText(created), new RegExp(CREATED_THREAD_ID));

  await threadRow(workspace, CREATED_THREAD_ID, row => row.state === "live");
  await waitFor(() => notifications(workspace).some(item => item.meta.chat_id === CREATED_THREAD_ID),
    () => `the thread bootstrap: ${JSON.stringify(notifications(workspace))}`, 15000);
  assert.deepEqual(threadCreates(workspace), [{ authorization: ROOT_AUTH, channelId: "demo-channel",
    body: { name: "parser-port", type: 11, auto_archive_duration: 10080 } }]);
  const [notice] = notices(workspace, CREATED_THREAD_ID);
  assert.equal(notice.authorization, ROOT_AUTH);
  for (const setting of ["high", "port the parser to the new API"]) {
    assert.ok(notice.content.includes(setting), `${setting} in ${notice.content}`);
  }
  const bootstrap = notifications(workspace).find(item => item.meta.chat_id === CREATED_THREAD_ID);
  assert.match(bootstrap.content, /port the parser to the new API/);
  const row = await threadRow(workspace, CREATED_THREAD_ID);
  assert.deepEqual([row.name, row.effort], ["parser-port", "high"]);

  // The channel session lists the tool; the thread session neither lists nor runs it.
  assert.ok(toolList(workspace, null).tools.includes("create_thread"));
  await waitFor(() => toolList(workspace, CREATED_THREAD_ID), () => "the thread session's tools");
  assert.equal(toolList(workspace, CREATED_THREAD_ID).tools.includes("create_thread"), false);
  await waitFor(() => toolResults(workspace).filter(entry => entry.name === "create_thread").length === 2,
    () => "the thread session's create_thread attempt");
  assert.match(resultText(toolResults(workspace).filter(entry => entry.name === "create_thread")[1]), /unknown tool/);
  assert.equal(threadCreates(workspace).length, 1);
});

test("create_thread with invalid overrides returns an op error, refuses another channel, and creates no thread", async () => {
  const workspace = commandWorkspace();
  await supervised(workspace);
  await channelSession(workspace, [
    { name: "create_thread", arguments: { name: "a", effort: "turbo" } },
    // `work` is a Claude alias, not a Codex one.
    { name: "create_thread", arguments: { name: "b", provider: "codex", account: "work" } },
    { name: "create_thread", arguments: { name: "c", chat_id: "beta-channel" } },
  ]);

  await waitFor(() => toolResults(workspace).filter(entry => entry.name === "create_thread").length === 3,
    () => `three create_thread results: ${JSON.stringify(toolResults(workspace))}`, 15000);
  const [effort, account, elsewhere] = toolResults(workspace).filter(entry => entry.name === "create_thread");
  for (const entry of [effort, account, elsewhere]) assert.equal(entry.result.isError, true, JSON.stringify(entry));
  assert.match(resultText(effort), /invalid.*turbo/);
  assert.match(resultText(account), /invalid.*work/);
  assert.match(resultText(elsewhere), /scope_violation/);
  await settle(500);
  assert.deepEqual(threadCreates(workspace), []);
  assert.deepEqual((await supervisorStatus(workspace)).projects, {});
});

test("create_thread returns supervisor_unavailable with the supervisor stopped", async () => {
  const workspace = commandWorkspace();
  const supervisor = await supervised(workspace);
  await supervisor.stop();
  await channelSession(workspace, [{ name: "create_thread", arguments: { name: "later" } }]);

  await waitFor(() => toolResults(workspace).some(entry => entry.name === "create_thread"),
    () => `the create_thread result: ${JSON.stringify(toolResults(workspace))}`, 15000);
  const [result] = toolResults(workspace).filter(entry => entry.name === "create_thread");
  assert.equal(result.result.isError, true);
  assert.match(resultText(result), /supervisor_unavailable/);
  assert.deepEqual(threadCreates(workspace), []);
});

// `beta`'s Codex channel session reaches the Router through its scoped
// Discord MCP server, as the bridge configures it.
async function codexMcpCall(workspace, args) {
  const env = routerEnv(workspace, { CCDM_ROUTER_KEY_FILE: path.join(workspace.routerStateDir, "keys", "beta.key"),
    CCDM_CODEX_PROJECT: "beta", CHANNEL_ID: "beta-channel" });
  const command = [process.execPath, path.join(workspace.repoDir, "scripts/discord-mcp-server.js")];
  const child = spawn(command[0], command.slice(1), { cwd: workspace.repoDir, detached: true, env,
    stdio: ["pipe", "pipe", "pipe"] });
  const running = collectProcess(child, { command, cwd: workspace.repoDir, detached: true, env }, workspace);
  registerTeardownCallback(() => running.stop());
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "create_thread", arguments: args } })}\n`);
  await waitFor(() => running.stdout.includes("\n"), () => `the MCP response: ${running.stderr}`, 20000);
  child.stdin.end();
  await running.closed;
  return JSON.parse(running.stdout.trim().split("\n")[0]);
}

test("a Codex channel session's create_thread through the Discord MCP creates the thread and starts it with the first message", async () => {
  const workspace = commandWorkspace();
  await supervised(workspace, ["demo", "beta"]);

  const response = await codexMcpCall(workspace, { name: "codex-side-task", provider: "claude",
    first_message: "summarise the open issues" });
  assert.equal(response.result.isError, undefined, JSON.stringify(response));
  assert.match(response.result.content[0].text, new RegExp(CREATED_THREAD_ID));

  await threadRow(workspace, CREATED_THREAD_ID, row => row.state === "live");
  await waitFor(() => notifications(workspace).some(item => item.meta.chat_id === CREATED_THREAD_ID),
    () => `the thread bootstrap: ${JSON.stringify(notifications(workspace))}`, 15000);
  assert.deepEqual(threadCreates(workspace), [{ authorization: ROOT_AUTH, channelId: "beta-channel",
    body: { name: "codex-side-task", type: 11, auto_archive_duration: 10080 } }]);
  const [notice] = notices(workspace, CREATED_THREAD_ID);
  assert.ok(notice.content.includes("summarise the open issues"), notice.content);
  assert.match(notifications(workspace).find(item => item.meta.chat_id === CREATED_THREAD_ID).content,
    /summarise the open issues/);

  const invalid = await codexMcpCall(workspace, { name: "bad", effort: "max" });
  assert.equal(invalid.result.isError, true);
  assert.match(invalid.result.content[0].text, /invalid.*max/);
  const elsewhere = await codexMcpCall(workspace, { name: "elsewhere", channel_id: "demo-channel" });
  assert.match(elsewhere.result.content[0].text, /scope_violation/);
  assert.equal(threadCreates(workspace).length, 1);
});

// In-thread management commands: each affects only its own thread. Two
// user-created threads under `demo`, beside its Channel Conversation.
const THREAD_ID = "1700000000000223344";
const THREAD_TMUX = "demo_claude-t-223344";
const SIBLING_ID = "1700000000000556677";
const SIBLING_TMUX = "demo_claude-t-556677";
const CHANNEL_TMUX = "demo_claude";
const userThread = id => ({ id, type: 11, parentId: "demo-channel", name: `thread ${id.slice(-6)}`, ownerId: OWNER_ID,
  autoArchiveDuration: 10080 });

function threadMessage(workspace, threadId, id, content, author = { id: OWNER_ID, username: "Owner" }) {
  injectDiscordMessage(workspace, { id, channelId: threadId, content, author });
}

const GUEST = { id: "guest-id", username: "Guest" };
const tmuxSessions = workspace => readState(workspace.stateDir).fixtures.tmux.sessions;
// Claude launches by whose key they carry: a thread's `.thread-<id>.key`, or the channel's.
const launches = (workspace, threadId) => claude(workspace).invocations.filter(invocation =>
  threadId ? invocation.env.CCDM_ROUTER_KEY_FILE?.endsWith(`.thread-${threadId}.key`)
    : !invocation.env.CCDM_ROUTER_KEY_FILE?.includes(".thread-"));
const resumeArg = invocation => {
  const index = invocation.args.indexOf("--resume");
  return index < 0 ? null : invocation.args[index + 1].replace(/^'|'$/g, "");
};
const alive = pid => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const replies = (workspace, threadId) => posts(workspace, threadId).filter(message => message.webhookId);

// Claude keeps a conversation's transcript at
// <home>/projects/<cwd, each non-alphanumeric character as "-">/<id>.jsonl.
function writeClaudeTranscript(workspace, sessionId) {
  const dir = path.join(workspace.homeDir, ".claude", "projects", workspace.tmpDir.replace(/[^A-Za-z0-9]/g, "-"));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), "{}\n");
}

async function liveThread(workspace, threadId) {
  updateState(workspace.stateDir, state => {
    (state.fixtures.discord.injectedThreads ||= []).push({ ...userThread(threadId), event: "create" });
  });
  await threadRow(workspace, threadId);
  threadMessage(workspace, threadId, `boot-${threadId}`, "please fix the parser");
  await threadRow(workspace, threadId, current => current.state === "live" && current.provider_conversation_id != null);
  await waitFor(() => replies(workspace, threadId).length === 1, () => `${threadId}'s bootstrap reply`, 15000);
}

// The channel session and two live threads, before any command.
async function threeSessions(workspace) {
  await supervised(workspace);
  const started = await runScript(workspace, "scripts/start-session.sh", { args: ["demo"], env: routerEnv(workspace) });
  assert.equal(started.exitCode, 0, started.stderr || started.stdout);
  await liveThread(workspace, THREAD_ID);
  await liveThread(workspace, SIBLING_ID);
  return { siblingPid: tmuxSessions(workspace)[SIBLING_TMUX].pid, channelPid: tmuxSessions(workspace)[CHANNEL_TMUX].pid };
}

function assertUntouched(workspace, { siblingPid, channelPid }) {
  assert.equal(launches(workspace, SIBLING_ID).length, 1);
  assert.equal(tmuxSessions(workspace)[SIBLING_TMUX].pid, siblingPid);
  assert.ok(alive(siblingPid), "the sibling thread's listener still runs");
  assert.equal(launches(workspace, null).length, 1);
  assert.equal(tmuxSessions(workspace)[CHANNEL_TMUX].pid, channelPid);
  assert.ok(alive(channelPid), "the channel session still runs");
}

const commandNotified = (workspace, command) => notifications(workspace)
  .some(item => new RegExp(`(^|\\s)${command}(\\s|$)`).test(item.content));

test("/restart relaunches only that thread with --resume and the same id, and a guest's /clear relaunches it fresh", async () => {
  const workspace = commandWorkspace();
  const before = await threeSessions(workspace);
  const { provider_conversation_id: conversationId } = await threadRow(workspace, THREAD_ID);
  writeClaudeTranscript(workspace, conversationId);

  threadMessage(workspace, THREAD_ID, "restart-1", "/restart");
  await waitFor(() => launches(workspace, THREAD_ID).length === 2, () => "the restarted launch", 15000);
  await threadRow(workspace, THREAD_ID, row => row.state === "live");
  assert.equal(resumeArg(launches(workspace, THREAD_ID)[1]), conversationId);
  assert.equal((await threadRow(workspace, THREAD_ID)).provider_conversation_id, conversationId);

  threadMessage(workspace, THREAD_ID, "clear-1", "/clear", GUEST);
  await waitFor(() => launches(workspace, THREAD_ID).length === 3, () => `the cleared launch: ${JSON.stringify(posts(workspace, THREAD_ID))}`, 15000);
  const cleared = await threadRow(workspace, THREAD_ID, row => row.state === "live" &&
    row.provider_conversation_id != null);
  assert.equal(resumeArg(launches(workspace, THREAD_ID)[2]), null);
  assert.notEqual(cleared.provider_conversation_id, conversationId);

  const answered = notices(workspace, THREAD_ID);
  assert.equal(answered.length, 2, JSON.stringify(answered));
  for (const notice of answered) assert.equal(notice.authorization, ROOT_AUTH);
  assertUntouched(workspace, before);
  assert.equal(commandNotified(workspace, "/restart") || commandNotified(workspace, "/clear"), false);
});

test("an owner /close posts the notice, archives the thread, stops its session and leaves closed/close-command; a guest's is refused", async () => {
  const workspace = commandWorkspace();
  const before = await threeSessions(workspace);

  threadMessage(workspace, THREAD_ID, "guest-close", "/close", GUEST);
  await waitFor(() => notices(workspace, THREAD_ID).length === 1, () => "the guest's refusal", 15000);
  const [refusal] = notices(workspace, THREAD_ID);
  assert.equal(refusal.authorization, ROOT_AUTH);
  assert.match(refusal.content, /owner/i);
  await settle(500);
  assert.deepEqual((discord(workspace).threadPatches ?? []).filter(patch => "archived" in patch.body), []);
  assert.equal((await threadRow(workspace, THREAD_ID)).state, "live");
  assert.ok(tmuxSessions(workspace)[THREAD_TMUX], "the guest's /close left the session running");

  threadMessage(workspace, THREAD_ID, "owner-close", "/close");
  const row = await threadRow(workspace, THREAD_ID, current => current.state === "closed");
  assert.deepEqual([row.state, row.close_reason], ["closed", "close-command"]);
  assert.equal(notices(workspace, THREAD_ID).length, 2);
  assert.equal(notices(workspace, THREAD_ID)[1].authorization, ROOT_AUTH);
  assert.deepEqual((discord(workspace).threadPatches ?? []).filter(patch => "archived" in patch.body)
    .map(({ authorization, body, threadId }) =>
    ({ authorization, body, threadId })), [{ authorization: ROOT_AUTH, body: { archived: true }, threadId: THREAD_ID }]);
  await waitFor(() => tmuxSessions(workspace)[THREAD_TMUX] === undefined, () => "the thread's tmux to stop", 15000);
  // The archive the close made is not mistaken for an auto-archive.
  await settle(1000);
  assert.deepEqual([(await threadRow(workspace, THREAD_ID)).state, (await threadRow(workspace, THREAD_ID)).close_reason],
    ["closed", "close-command"]);
  assertUntouched(workspace, before);
  assert.equal(commandNotified(workspace, "/close"), false);
});

test("/compact, /pause and /unpause reach only that thread's Claude session and pane", async () => {
  const workspace = commandWorkspace();
  const before = await threeSessions(workspace);
  const keys = name => (tmuxSessions(workspace)[name].sendKeys ?? []).filter(keys => keys[0] !== "Enter");

  threadMessage(workspace, THREAD_ID, "compact-1", "/compact");
  // Typed literally, then submitted.
  await waitFor(() => JSON.stringify(tmuxSessions(workspace)[THREAD_TMUX].sendKeys.slice(-2)) ===
    JSON.stringify([["-l", "/compact"], ["Enter"]]), () => `/compact in the pane: ${JSON.stringify(tmuxSessions(workspace))}`,
  15000);
  assert.deepEqual(keys(THREAD_TMUX), [["-l", "/compact"]]);

  threadMessage(workspace, THREAD_ID, "pause-1", "/pause");
  await waitFor(() => replies(workspace, THREAD_ID).some(reply => /paused/i.test(reply.content)), () => "the pause reply",
    15000);
  const delivered = notifications(workspace).length;
  threadMessage(workspace, THREAD_ID, "while-paused", "held while paused");
  await settle(1000);
  assert.equal(notifications(workspace).length, delivered);
  threadMessage(workspace, THREAD_ID, "unpause-1", "/unpause");
  await waitFor(() => notifications(workspace).some(item => item.content.includes("held while paused")),
    () => "the held message after /unpause", 15000);

  assert.deepEqual(keys(SIBLING_TMUX), []);
  assert.deepEqual(keys(CHANNEL_TMUX), []);
  assert.deepEqual(notices(workspace, THREAD_ID), []);
  assertUntouched(workspace, before);
  for (const command of ["/compact", "/pause", "/unpause"]) assert.equal(commandNotified(workspace, command), false);
});

test("/compact, /pause and /unpause with no live session get a no live session notice and start nothing", async () => {
  const workspace = commandWorkspace();
  await supervised(workspace);
  updateState(workspace.stateDir, state => {
    (state.fixtures.discord.injectedThreads ||= []).push({ ...userThread(THREAD_ID), event: "create" });
  });
  await threadRow(workspace, THREAD_ID);

  threadMessage(workspace, THREAD_ID, "compact-1", "/compact");
  threadMessage(workspace, THREAD_ID, "pause-1", "/pause", GUEST);
  threadMessage(workspace, THREAD_ID, "unpause-1", "/unpause");
  await waitFor(() => notices(workspace, THREAD_ID).length === 3, () => `three notices: ${JSON.stringify(posts(workspace,
    THREAD_ID))}`, 15000);
  for (const notice of notices(workspace, THREAD_ID)) {
    assert.equal(notice.authorization, ROOT_AUTH);
    assert.match(notice.content, /no live session/i);
  }
  await settle(500);
  assert.deepEqual(claude(workspace).invocations, []);
  assert.equal((await threadRow(workspace, THREAD_ID)).state, "registered");
});

const CODEX_THREAD_UUID = "0199a5c4-7e1b-7c3d-9f2a-4b8e6d1c3a58";

test("/compact in a Codex thread reaches only that thread's bridge", async () => {
  const workspace = commandWorkspace();
  const codexHome = path.join(workspace.homeDir, ".codex");
  fs.mkdirSync(codexHome, { recursive: true });
  const codex = await startFakeCodexServer(workspace, { port: 29600, deferListen: true, codexHome,
    channelId: CREATED_THREAD_ID, threadId: CODEX_THREAD_UUID, bootstrapPlan: { mcpReplyText: "on it" } });
  await routerWithWebhooks(workspace, ["demo"]);
  await startThreadSupervisor(workspace, { env: { CCDM_THREAD_WS_PORT_BASE: "29600" } });

  channelMessage(workspace, "thread-command-1", "/thread codex-task --provider codex");
  await threadRow(workspace, CREATED_THREAD_ID, row => row.provider === "codex");
  threadMessage(workspace, CREATED_THREAD_ID, "boot-message-1", "please fix the parser");
  await threadRow(workspace, CREATED_THREAD_ID, row => row.ws_port === 29600);
  await codex.listen();
  await threadRow(workspace, CREATED_THREAD_ID, row => row.state === "live" &&
    row.provider_conversation_id === CODEX_THREAD_UUID);
  await waitFor(() => replies(workspace, CREATED_THREAD_ID).length === 1, () => "the bootstrap reply", 20000);

  threadMessage(workspace, CREATED_THREAD_ID, "compact-1", "/compact");
  await waitFor(() => codex.clientMessages.some(message => message.method === "thread/compact/start"),
    () => `thread/compact/start: ${JSON.stringify(codex.clientMessages.map(message => message.method))}`, 20000);
  const [compact] = codex.clientMessages.filter(message => message.method === "thread/compact/start");
  assert.equal(compact.params.threadId, CODEX_THREAD_UUID);
  assert.deepEqual(notices(workspace, CREATED_THREAD_ID).filter(notice => /no live session/i.test(notice.content)), []);
  assert.equal(codex.clientMessages.some(message => message.method === "turn/start" &&
    JSON.stringify(message.params).includes("/compact")), false);
});
