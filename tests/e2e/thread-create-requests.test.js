import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { createWorkspace, runNodeEntrypoint, runScript } from "./support/runner.js";
import { bridgeChildEnv, startBridge, startFakeCodexServer, waitForState }
  from "./support/bridge.js";
import { readState, writeState } from "./support/state.js";
import { cleanup } from "./support/teardown.js";

test.afterEach(async () => cleanup());

// Discord's longest auto-archive duration, in minutes (one week).
const ONE_WEEK = 10080;
const READY_SCREEN = "Listening for channel messages from: server:discord\n";

// A Claude project (`demo`) and a Codex project (`codexy`), each with its own
// bot and channel, plus a named Codex Account.
function setup(workspace, { port = 18999 } = {}) {
  const projectDir = path.join(workspace.tmpDir, "project");
  fs.mkdirSync(projectDir, { recursive: true });
  const codexHome = path.join(workspace.homeDir, ".codex-work");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(codexHome, "config.toml"), "model = \"gpt-6\"\n");
  const plugin = path.join(workspace.homeDir, ".claude", "plugins", "cache", "claude-plugins-official", "discord", "0.0.4");
  fs.mkdirSync(plugin, { recursive: true });
  fs.writeFileSync(path.join(plugin, "server.ts"), "// fixture official plugin\n");
  const demoState = path.join(workspace.homeDir, ".claude", "channels", "discord-demo");
  const codexyState = path.join(workspace.homeDir, ".claude", "channels", "discord-codexy");
  for (const [directory, token] of [[demoState, "demo-token"], [codexyState, "codexy-token"]]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(directory, ".env"), `DISCORD_BOT_TOKEN=${token}\n`, { mode: 0o600 });
  }
  fs.writeFileSync(path.join(workspace.repoDir, "registry.json"), JSON.stringify({
    discord_user_id: "owner", guild_id: "guild",
    codex_accounts: { work: codexHome }, default_codex_account: "work",
    pool: [
      { id: "demo-bot", app_id: "demo-app", token: "demo-token", state_dir: demoState, assigned_to: "demo" },
      { id: "codexy-bot", app_id: "codexy-app", token: "codexy-token", state_dir: codexyState, assigned_to: "codexy" },
    ],
    projects: {
      demo: { type: "claude", path: projectDir, bot_id: "demo-bot", channel_id: "channel", screen_name: "demo_session",
        model: "claude-opus-5-5", claude_effort: "high", thread_ws_port: port },
      codexy: { type: "codex", path: projectDir, bot_id: "codexy-bot", channel_id: "codex-channel",
        screen_name: "codexy_session", ws_port: 18399, thread_ws_port: port, codex_model: "gpt-6",
        codex_reasoning_effort: "high" },
    },
  }, null, 2), { mode: 0o600 });
  const rootState = path.join(workspace.homeDir, "root-discord");
  fs.mkdirSync(rootState, { recursive: true });
  fs.writeFileSync(path.join(rootState, ".env"), "DISCORD_BOT_TOKEN=fixture-root-token\n", { mode: 0o600 });
  const seed = readState(workspace.stateDir);
  seed.fixtures.discord.fanOut = true;
  seed.fixtures.tmux.claudeBootScreens = [READY_SCREEN];
  writeState(seed, workspace.stateDir);
  const clockFile = path.join(workspace.tmpDir, "thread-clock");
  fs.writeFileSync(clockFile, "2026-09-28T10:00:00Z\n");
  const env = bridgeChildEnv(workspace, { ROOT_DISCORD_STATE_DIR: rootState, CCDM_THREAD_NODE: process.execPath,
    CCDM_THREAD_CLOCK_FILE: clockFile, CCDM_FIXTURE_CLAUDE_VERSION: "2.1.281 (Claude Code)",
    CCDM_REMINDER_PROJECT_ROOT: workspace.repoDir });
  return { demoState, env };
}

async function status(workspace, env) {
  const result = await runScript(workspace, "scripts/thread-supervisor.py", { args: ["status"], env });
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

// The running worker's exit, wrapped so that awaiting the start does not await the exit.
async function startRun(workspace, env) {
  const exited = runScript(workspace, "scripts/thread-supervisor.py", { args: ["run"], env, timeoutMs: 40000 });
  await waitForState(workspace, state => state.fixtures.discord.ready.length === 1);
  return { exited };
}

async function stopRun(workspace, env, running) {
  const current = await status(workspace, env);
  process.kill(-current.worker_pid, "SIGTERM");
  const result = await running.exited;
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
}

async function waitForThread(workspace, env, threadId, predicate, label, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let current;
  while (Date.now() < deadline) {
    current = await status(workspace, env);
    const thread = Object.values(current.projects).map(project => project.threads[threadId]).find(Boolean);
    if (thread && predicate(thread)) return thread;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for thread ${threadId} to be ${label}: ${JSON.stringify(current)}`);
}

function threadsCreate(workspace, env, args) {
  return runScript(workspace, "scripts/threads.sh", { args: ["create", ...args], env, timeoutMs: 20000 });
}

// Drive a Discord MCP server over stdio with the env its launcher configured.
async function mcp(workspace, env, calls) {
  const lines = calls.map(([method, params], index) => JSON.stringify({ jsonrpc: "2.0", id: index + 1, method, params }));
  const result = await runNodeEntrypoint(workspace, "scripts/discord-mcp-server.js", {
    env: bridgeChildEnv(workspace, env), input: `${lines.join("\n")}\n`, timeoutMs: 20000 });
  const replies = new Map(result.stdout.trim().split("\n").filter(Boolean).map(line => JSON.parse(line))
    .map(reply => [reply.id, reply.result]));
  assert.equal(replies.size, calls.length, result.stderr || result.stdout);
  return calls.map((_, index) => replies.get(index + 1));
}

const toolNames = listed => listed.tools.map(tool => tool.name);
const turnText = params => params.input.map(part => part.text ?? "").join("\n");

test("threads.sh create opens a one-week thread in the project's channel and starts its session with the message", async () => {
  const workspace = createWorkspace();
  const codex = await startFakeCodexServer(workspace, { threadIds: ["codex-thread-a"],
    turnsByThread: { "codex-thread-a": [{ delta: "Looking." }] } });
  const context = setup(workspace, { port: codex.port });
  const running = await startRun(workspace, context.env);

  const result = await threadsCreate(workspace, context.env, ["codexy", "review", "--model", "gpt-6-luna", "look at PR 12"]);
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  const state = readState(workspace.stateDir);
  // One standalone public thread, created by the project bot in its own channel.
  assert.equal(state.fixtures.discord.threadCreates.length, 1);
  const [create] = state.fixtures.discord.threadCreates;
  assert.equal(create.authorization, "Bot codexy-token");
  assert.equal(create.channelId, "codex-channel");
  assert.deepEqual(create.body, { name: "review", type: 11, auto_archive_duration: ONE_WEEK });
  const threadId = create.threadId;
  assert.match(result.stdout, new RegExp(threadId));

  await waitForThread(workspace, context.env, threadId, row => row.state === "live", "live");
  const started = await waitForState(workspace, next => next.fixtures.codex.protocolEvents
    .filter(event => event.event === "client-message" && event.message.method === "turn/start").length === 2, 10000);
  const [{ method, params, mcpServers }] = started.fixtures.codex.threadConfigs;
  assert.equal(method, "thread/start");
  assert.equal(params.model, "gpt-6-luna");
  const turns = started.fixtures.codex.protocolEvents
    .filter(event => event.event === "client-message" && event.message.method === "turn/start")
    .map(event => event.message.params);
  assert.match(turnText(turns[1]), /root: look at PR 12/);
  // The message is shown in the thread, and 👀 marks it while the session boots.
  const shown = started.fixtures.discord.messages.filter(message => message.channelId === threadId);
  assert.deepEqual(shown.map(message => [message.authorization, message.content]),
    [["Bot codexy-token", "From root: look at PR 12"]]);
  assert.deepEqual(started.fixtures.discord.reactions.map(row => [row.channelId, decodeURIComponent(row.emoji), row.messageId]),
    [[threadId, "👀", shown[0].id]]);
  // Root's request is fulfilled by this thread.
  assert.deepEqual(Object.values((await status(workspace, context.env)).projects.codexy.creation_requests),
    [{ name: "review", requester_kind: "root", status: "fulfilled", thread_id: threadId }]);

  // The thread's own Discord MCP server cannot open threads.
  const [, listed] = await mcp(workspace, mcpServers[`discord-${threadId}`].env,
    [["initialize", {}], ["tools/list", {}]]);
  assert.ok(toolNames(listed).includes("reply"));
  assert.ok(!toolNames(listed).includes("create_thread"));
  await stopRun(workspace, context.env, running);
});

test("threads.sh create exits nonzero and creates nothing when the thread supervisor is not running", async () => {
  const workspace = createWorkspace();
  const context = setup(workspace);
  const result = await threadsCreate(workspace, context.env, ["demo", "review", "look at PR 12"]);
  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /thread supervisor is not running/);
  const state = readState(workspace.stateDir);
  assert.deepEqual(state.fixtures.discord.threadCreates ?? [], []);
  assert.deepEqual(state.fixtures.tmux.sessions, {});
  assert.deepEqual((await status(workspace, context.env)).projects, {});
});

test("threads.sh create rejects invalid options with the /thread one-line errors and creates nothing", async () => {
  const workspace = createWorkspace();
  const context = setup(workspace);
  const running = await startRun(workspace, context.env);
  const cases = [
    [["demo", "review", "--account", "/some/path", "look"], /^--account takes an account alias, not a path\.$/],
    [["demo", "review", "--account", "personal", "look"], /^--account personal is not a configured Claude account alias\.$/],
    [["demo", "review", "--provider", "gemini", "look"], /^--provider must be claude or codex\.$/],
    [["demo", "review", "--effort", "ludicrous", "look"], /^--effort for Claude must be one of /],
    [["demo", "review", "--colour", "red"], /^unknown option --colour; use \/thread <name> /],
    [["nowhere", "review"], /^no registered project named nowhere$/],
  ];
  for (const [args, expected] of cases) {
    const result = await threadsCreate(workspace, context.env, args);
    assert.notEqual(result.exitCode, 0, args.join(" "));
    const lines = result.stderr.trim().split("\n");
    assert.equal(lines.length, 1, result.stderr);
    assert.match(lines[0].replace(/^threads\.sh create: /, ""), expected);
  }
  const state = readState(workspace.stateDir);
  assert.deepEqual(state.fixtures.discord.threadCreates ?? [], []);
  // Nothing is posted in Discord for a local request.
  assert.deepEqual(state.fixtures.discord.messages ?? [], []);
  assert.deepEqual((await status(workspace, context.env)).projects, {});
  await stopRun(workspace, context.env, running);
});

test("create_thread in the Codex channel bridge's MCP opens a thread in that project's channel only", async () => {
  const workspace = createWorkspace();
  const context = setup(workspace);
  const running = await startRun(workspace, context.env);
  const codex = await startFakeCodexServer(workspace);
  const bridge = startBridge(workspace, { port: codex.port, channelId: "codex-channel", botToken: "codexy-token",
    botAppId: "codexy-app", allowedUserId: "owner", env: context.env });
  await bridge.waitForOutput(/MCP server ready/, 10000);
  const config = codex.clientMessages.find(message => message.method === "config/value/write" &&
    message.params.keyPath === "mcp_servers.discord-codex-channel").params.value;

  const [, listed, called] = await mcp(workspace, config.env, [["initialize", {}], ["tools/list", {}],
    // A model cannot aim the tool at another channel or project.
    ["tools/call", { name: "create_thread", arguments: { name: "spike", model: "gpt-6-luna",
      channel_id: "channel", project: "demo", scope_token: config.env.DISCORD_REPLY_TOKEN } }]]);
  assert.ok(toolNames(listed).includes("create_thread"));
  assert.ok(!called.isError, called.content[0].text);
  const state = readState(workspace.stateDir);
  assert.deepEqual(state.fixtures.discord.threadCreates.map(entry => [entry.authorization, entry.channelId, entry.body]),
    [["Bot codexy-token", "codex-channel", { name: "spike", type: 11, auto_archive_duration: ONE_WEEK }]]);
  const threadId = state.fixtures.discord.threadCreates[0].threadId;
  assert.match(called.content[0].text, new RegExp(threadId));
  const current = await status(workspace, context.env);
  assert.deepEqual(Object.keys(current.projects), ["codexy"]);
  assert.equal(current.projects.codexy.threads[threadId].state, "registered");
  assert.deepEqual(Object.values(current.projects.codexy.creation_requests),
    [{ name: "spike", requester_kind: "channel-agent", status: "fulfilled", thread_id: threadId }]);
  await bridge.stop();
  await stopRun(workspace, context.env, running);
});

test("create_thread in a Claude channel's supplementary MCP opens a thread whose own session has no create_thread", async () => {
  const workspace = createWorkspace();
  const context = setup(workspace);
  const started = await runScript(workspace, "scripts/start-session.sh", { args: ["demo"], env: context.env });
  assert.equal(started.exitCode, 0, started.stderr || started.stdout);
  const channelConfig = JSON.parse(fs.readFileSync(path.join(context.demoState, "ccdm-message-export-mcp.json"), "utf8"));
  const running = await startRun(workspace, context.env);

  const exporter = channelConfig.mcpServers["discord-message-export"].env;
  const [, listed, called] = await mcp(workspace, exporter, [["initialize", {}], ["tools/list", {}],
    ["tools/call", { name: "create_thread", arguments: { name: "notes", message: "summarize the open questions",
      channel_id: "codex-channel" } }]]);
  assert.deepEqual(toolNames(listed), ["read_last_x_messages_in_channel", "export_message_range", "create_thread"]);
  assert.ok(!called.isError, called.content[0].text);
  const created = readState(workspace.stateDir).fixtures.discord.threadCreates;
  assert.deepEqual(created.map(entry => [entry.authorization, entry.channelId, entry.body.name]),
    [["Bot demo-token", "channel", "notes"]]);
  const threadId = created[0].threadId;

  // The message starts the thread's Claude session, whose exporter lacks the tool.
  await waitForThread(workspace, context.env, threadId, row => row.state === "live", "live");
  const threadConfig = JSON.parse(fs.readFileSync(path.join(context.demoState, "threads", threadId,
    "ccdm-message-export-mcp.json"), "utf8"));
  const [, threadListed] = await mcp(workspace, threadConfig.mcpServers["discord-message-export"].env,
    [["initialize", {}], ["tools/list", {}]]);
  assert.deepEqual(toolNames(threadListed), ["read_last_x_messages_in_channel", "export_message_range"]);
  assert.deepEqual(Object.values((await status(workspace, context.env)).projects.demo.creation_requests),
    [{ name: "notes", requester_kind: "channel-agent", status: "fulfilled", thread_id: threadId }]);
  await stopRun(workspace, context.env, running);
});

test("create_thread refuses when the thread supervisor is not running", async () => {
  const workspace = createWorkspace();
  const context = setup(workspace);
  const [called] = await mcp(workspace, { CHANNEL_ID: "channel", DISCORD_MCP_EXPORT_ONLY: "1",
    CCDM_CREATE_THREAD: "1", DISCORD_STATE_DIR: context.demoState },
  [["tools/call", { name: "create_thread", arguments: { name: "notes" } }]]);
  assert.equal(called.isError, true);
  assert.match(called.content[0].text, /thread supervisor is not running/);
  assert.deepEqual(readState(workspace.stateDir).fixtures.discord.threadCreates ?? [], []);
});
