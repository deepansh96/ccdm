import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { injectDiscordMessage } from "./support/bridge.js";
import { runScript } from "./support/runner.js";
import { OWNER_ID, ROOT_TOKEN, connectSession, createRouterWorkspace, routerRegistry, routerWithWebhooks,
  waitFor } from "./support/router.js";
import { readState, updateState } from "./support/state.js";
import { cleanup } from "./support/teardown.js";
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
  fs.writeFileSync(registryFile, `${JSON.stringify(registry, null, 2)}\n`);
  return workspace;
}

async function supervised(workspace) {
  await routerWithWebhooks(workspace, ["demo"]);
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
    const row = last.projects?.demo?.threads?.[threadId];
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
