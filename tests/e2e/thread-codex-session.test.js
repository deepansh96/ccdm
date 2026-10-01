import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import test from "node:test";

import { injectDiscordMessage, startFakeCodexServer } from "./support/bridge.js";
import { runScript } from "./support/runner.js";
import { OWNER_ID, ROOT_TOKEN, createRouterWorkspace, routerEnv, routerRegistry, routerWithWebhooks,
  runRouterCli, waitFor } from "./support/router.js";
import { readState, updateState } from "./support/state.js";
import { cleanup, registerTeardownCallback } from "./support/teardown.js";
import { startThreadSupervisor, supervisorStateDir, supervisorStatus } from "./support/thread-supervisor.js";

test.afterEach(cleanup);

// A Codex Thread Conversation end to end: the real Router, Thread Supervisor,
// start-thread-session.sh and codex-bridge.js in thread mode, with the fixture
// codex and tmux and a fake Codex app-server. Only Discord inputs go in;
// recorded Discord REST calls, the app-server's protocol messages and the
// supervisor CLI come out.
const THREAD_ID = "1700000000000654321";
// `<screen>-t-<last 6 of the thread id>`.
const THREAD_TMUX = "demo_claude-t-654321";
const CODEX_THREAD_UUID = "0199a5c4-7e1b-7c3d-9f2a-4b8e6d1c3a57";
const ROOT_AUTH = `Bot ${ROOT_TOKEN}`;
const BOT_USER_ID = "fixture-bot-user-id";
const READY_INSTRUCTION = "Reply with exactly READY";
// 64,600 of a 258,400-token window is 25%.
const SEEDED_USAGE = { last: { inputTokens: 64600 }, modelContextWindow: 258400 };

function threadWorkspace(project = {}, extra = {}) {
  const workspace = createRouterWorkspace({ ...routerRegistry({
    demo: { channel_id: "demo-channel", type: "claude", transport: "router", guest_user_ids: ["guest-id"],
      screen_name: "demo_claude", ...project },
  }), root_channels: ["root-channel"], ...extra });
  const registryFile = path.join(workspace.repoDir, "registry.json");
  const registry = JSON.parse(fs.readFileSync(registryFile, "utf8"));
  registry.projects.demo.path = workspace.tmpDir;
  fs.writeFileSync(registryFile, `${JSON.stringify(registry, null, 2)}\n`);
  fs.mkdirSync(path.join(workspace.homeDir, ".codex"), { recursive: true });
  return workspace;
}

const codexHome = workspace => path.join(workspace.homeDir, ".codex");

// The supervisor allocates thread ports from this base; tests use their own
// literal ranges, below the ephemeral ports other tests bind.
async function supervised(workspace, portBase, { env = {} } = {}) {
  await routerWithWebhooks(workspace, ["demo"]);
  return startThreadSupervisor(workspace, { env: { CCDM_THREAD_WS_PORT_BASE: String(portBase), ...env } });
}

// Keeps a port in use for the rest of the test.
async function holdPort(port) {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  registerTeardownCallback(() => new Promise(resolve => server.close(resolve)));
}

// The creation-request producer is a later slice, so a pending request goes in
// through the PRD's store schema; the root bot then creates the thread.
function requestThread(workspace, { provider = "codex", account = null } = {}) {
  const store = path.join(supervisorStateDir(workspace), "threads.sqlite3");
  execFileSync("python3", ["-c", `import sqlite3, sys
db = sqlite3.connect(sys.argv[1], timeout=5)
db.execute("""INSERT INTO creation_requests (request_id, project, name, provider, account, model, effort,
  first_message, requester_id, requester_kind, status, thread_id, created_at)
  VALUES ('request-1', 'demo', 'Fix flaky test', ?, ?, NULL, NULL, NULL, ?, 'owner', 'pending', NULL,
  '2026-10-01T00:00:00Z')""", (sys.argv[2] or None, sys.argv[3] or None, sys.argv[4]))
db.commit()`, store, provider ?? "", account ?? "", OWNER_ID]);
  updateState(workspace.stateDir, state => {
    (state.fixtures.discord.injectedThreads ||= []).push({ id: THREAD_ID, type: 11, parentId: "demo-channel",
      name: "Fix flaky test", ownerId: BOT_USER_ID, autoArchiveDuration: 10080, event: "create" });
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
const occurrences = (text, needle) => text.split(needle).length - 1;
const threadPosts = workspace => (discord(workspace).messages ?? []).filter(message => message.channelId === THREAD_ID);
const turnTexts = codex => codex.clientMessages.filter(message => message.method === "turn/start")
  .map(message => message.params.input.map(part => part.text ?? "").join("\n"));

// The fake app-server for the thread's allocated port, bound only once the
// supervisor has recorded that port, so the allocator saw it free.
async function threadCodex(workspace, port, options = {}) {
  const codex = await startFakeCodexServer(workspace, { port, deferListen: true, codexHome: codexHome(workspace),
    channelId: THREAD_ID, threadId: CODEX_THREAD_UUID, ...options });
  return {
    codex,
    async listenWhenAllocated() {
      const row = await threadRow(workspace, current => current.ws_port != null);
      assert.equal(row.ws_port, port);
      await codex.listen();
    },
  };
}

test("an owner message in a Codex thread of a Claude project boots a bridge whose first turn is the bootstrap, on a port clear of the registry's and those in use", async () => {
  // Port 29400 is a registry ws_port and 29401 is in use, so the thread gets 29402.
  const workspace = threadWorkspace({ ws_port: 29400 });
  await holdPort(29401);
  updateState(workspace.stateDir, state => {
    state.fixtures.discord.history = { "demo-channel": [{ id: THREAD_ID, content: "The parser drops trailing commas",
      author: { id: OWNER_ID, username: "Owner" } }] };
  });
  const { codex, listenWhenAllocated } = await threadCodex(workspace, 29402, {
    bootstrapPlan: { mcpReplyText: "on it", tokenUsage: SEEDED_USAGE },
    turns: [{ mcpReplyText: "done", mcpEditText: "done: 3 files changed" }],
  });
  await supervised(workspace, 29400);
  requestThread(workspace);
  await threadRow(workspace, row => row.provider === "codex");

  threadMessage(workspace, "boot-message-1", "please fix the parser");
  threadMessage(workspace, "boot-message-2", "and add a regression test", { id: "guest-id", username: "Guest" });
  await listenWhenAllocated();
  await threadRow(workspace, row => row.state === "live");
  await waitFor(() => threadPosts(workspace).length === 1, () => `the bootstrap reply: ${JSON.stringify(turnTexts(codex))}`,
    20000);

  const [bootstrap] = turnTexts(codex);
  assert.match(bootstrap, /demo/);
  assert.match(bootstrap, new RegExp(THREAD_ID));
  assert.match(bootstrap, /Fix flaky test/);
  assert.match(bootstrap, /only in this thread/i);
  for (const text of ["The parser drops trailing commas", "please fix the parser", "and add a regression test"]) {
    assert.equal(occurrences(bootstrap, text), 1, `${text} in ${bootstrap}`);
  }
  assert.ok(bootstrap.indexOf("please fix the parser") < bootstrap.indexOf("and add a regression test"));
  assert.equal(turnTexts(codex).some(text => text.includes(READY_INSTRUCTION)), false);

  threadMessage(workspace, "live-message-1", "how is it going?");
  await waitFor(() => (discord(workspace).webhookEdits ?? []).length === 1, () => "the live reply's edit", 20000);

  assert.equal(turnTexts(codex).length, 2);
  assert.equal(turnTexts(codex)[1], "how is it going?");
  assert.deepEqual(threadPosts(workspace).map(({ channelId, content, username, webhookId }) =>
    ({ channelId, content, username, webhookId })), [
    { channelId: THREAD_ID, content: "on it", username: "demo-codex", webhookId: "fake-webhook-1" },
    // Edited in place, through the thread's webhook message.
    { channelId: THREAD_ID, content: "done: 3 files changed", username: "demo-codex · 25%", webhookId: "fake-webhook-1" },
  ]);
  assert.deepEqual(discord(workspace).webhookEdits.map(({ channelId, content }) => ({ channelId, content })),
    [{ channelId: THREAD_ID, content: "done: 3 files changed" }]);
  // The parent channel heard nothing of it.
  assert.deepEqual((discord(workspace).messages ?? []).filter(message => message.channelId !== THREAD_ID), []);

  const state = readState(workspace.stateDir);
  assert.deepEqual(state.fixtures.codex.appServerInvocations.map(invocation => invocation.port), ["29402"]);
  // Recorded once the launcher exits, after the hello.
  const row = await threadRow(workspace, current => current.provider_conversation_id != null);
  assert.equal(row.ws_port, 29402);
  assert.equal(row.provider_conversation_id, CODEX_THREAD_UUID);
  const status = await runRouterCli(workspace, ["status"]);
  assert.match(status.stdout, new RegExp(`thread demo thread=${THREAD_ID} provider=codex connected=`));
});

test("no Discord credential reaches the Codex thread's environment, launch files, MCP config, config.toml or Codex Home", async () => {
  const workspace = threadWorkspace();
  const { listenWhenAllocated } = await threadCodex(workspace, 29410, { bootstrapPlan: { mcpReplyText: "on it" } });
  await supervised(workspace, 29410);
  requestThread(workspace);
  await threadRow(workspace, row => row.provider === "codex");
  threadMessage(workspace, "boot-message-1", "please fix the parser");
  await listenWhenAllocated();
  await waitFor(() => threadPosts(workspace).length === 1, () => "the bootstrap reply", 20000);

  const state = readState(workspace.stateDir);
  const session = state.fixtures.tmux.sessions[THREAD_TMUX];
  assert.ok(session, JSON.stringify(Object.keys(state.fixtures.tmux.sessions)));
  assert.deepEqual(session.command.slice(0, 2), ["zsh", "-ic"]);
  assert.equal(session.env.CCDM_ROUTER_KEY_FILE, path.join(workspace.routerStateDir, "keys", `.thread-${THREAD_ID}.key`));
  assert.equal(session.env.CHANNEL_ID, THREAD_ID);
  assert.equal(session.env.PROJECT_DIR, workspace.tmpDir);
  const config = fs.readFileSync(path.join(codexHome(workspace), "config.toml"), "utf8");
  assert.match(config, new RegExp(`^\\[mcp_servers\\.discord-${THREAD_ID}\\]$`, "m"));
  assert.match(config, new RegExp(`CCDM_THREAD_ID = "${THREAD_ID}"`));
  const launchDir = path.join(workspace.routerStateDir, "launches", "demo", "threads", THREAD_ID);
  const homeFiles = fs.readdirSync(codexHome(workspace), { recursive: true })
    .map(file => path.join(codexHome(workspace), file)).filter(file => fs.statSync(file).isFile());
  const surfaces = [
    JSON.stringify(session),
    JSON.stringify(state.fixtures.codex.bridgeInvocations),
    JSON.stringify(state.fixtures.codex.appServerInvocations),
    ...fs.readdirSync(launchDir).map(file => fs.readFileSync(path.join(launchDir, file), "utf8")),
    ...homeFiles.map(file => fs.readFileSync(file, "utf8")),
  ];
  for (const text of surfaces) {
    for (const secret of [ROOT_TOKEN, "pool-bot-token", "fake-webhook-token", "DISCORD_BOT_TOKEN", "DISCORD_STATE_DIR"]) {
      assert.equal(text.includes(secret), false, `${secret} leaked into ${text.slice(0, 200)}`);
    }
  }
  assert.equal(fs.statSync(launchDir).mode & 0o777, 0o700);
  for (const file of fs.readdirSync(launchDir)) {
    assert.equal(fs.statSync(path.join(launchDir, file)).mode & 0o777, 0o600, file);
  }
});

test("a project session and a Codex thread sharing one Codex Home each load only their own discord-* server", async () => {
  const workspace = threadWorkspace({ type: "codex", screen_name: "demo_claude" });
  const project = await startFakeCodexServer(workspace, { channelId: "demo-channel", codexHome: codexHome(workspace) });
  const registryFile = path.join(workspace.repoDir, "registry.json");
  const registry = JSON.parse(fs.readFileSync(registryFile, "utf8"));
  registry.projects.demo.ws_port = project.port;
  fs.writeFileSync(registryFile, `${JSON.stringify(registry, null, 2)}\n`);
  const { listenWhenAllocated } = await threadCodex(workspace, 29420, { bootstrapPlan: { mcpReplyText: "on it" } });
  await supervised(workspace, 29420);
  const started = await runScript(workspace, "scripts/start-codex-session.sh", {
    args: ["demo"], env: routerEnv(workspace), timeoutMs: 30000,
  });
  assert.equal(started.exitCode, 0, started.stderr || started.stdout);

  requestThread(workspace, { provider: null });
  await threadRow(workspace);
  threadMessage(workspace, "boot-message-1", "please fix the parser");
  await listenWhenAllocated();
  await waitFor(() => threadPosts(workspace).length === 1, () => "the bootstrap reply", 20000);

  const servers = readState(workspace.stateDir).fixtures.codex.servers;
  assert.deepEqual(servers[String(project.port)].mcpReloads.at(-1), ["discord-demo-channel"]);
  assert.deepEqual(servers["29420"].mcpReloads.at(-1), [`discord-${THREAD_ID}`]);
  const status = await runRouterCli(workspace, ["status"]);
  assert.match(status.stdout, /project demo scope=demo-channel connected=/);
  assert.match(status.stdout, new RegExp(`thread demo thread=${THREAD_ID} provider=codex connected=`));
});

test("an unknown Codex account alias fails the start with a one-line reason", async () => {
  const workspace = threadWorkspace();
  await supervised(workspace, 29430);
  requestThread(workspace, { account: "work" });
  await threadRow(workspace, row => row.account === "work");
  threadMessage(workspace, "boot-message-1", "please fix the parser");

  const row = await threadRow(workspace, current => current.state === "stopped");
  assert.deepEqual([row.state, row.stop_reason], ["stopped", "start-failed"]);
  const notices = () => threadPosts(workspace).filter(message => !message.webhookId);
  await waitFor(() => notices().length === 1, () => "the start-failure notice", 15000);
  const [notice] = notices();
  assert.equal(notice.authorization, ROOT_AUTH);
  assert.match(notice.content, /^Thread session failed to start: .*unknown Codex Account Alias 'work'/);
  assert.equal(notice.content.includes("\n"), false, notice.content);
  assert.equal(fs.existsSync(path.join(workspace.routerStateDir, "keys", `.thread-${THREAD_ID}.key`)), false);
  assert.equal(readState(workspace.stateDir).fixtures.tmux.sessions[THREAD_TMUX], undefined);
  assert.deepEqual(readState(workspace.stateDir).fixtures.codex.bridgeInvocations, []);
});
