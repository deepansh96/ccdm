import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { createWorkspace, runScript } from "./support/runner.js";
import { bridgeChildEnv, injectDiscordMessage, injectDiscordThread, updateFixtureState, waitForState }
  from "./support/bridge.js";
import { readState, writeState } from "./support/state.js";
import { cleanup, registerTeardownCallback } from "./support/teardown.js";

test.afterEach(async () => cleanup());

// Discord snowflakes; the tmux name uses the thread id's last six digits.
const THREAD = "1500000000000123456";
const THREAD_TMUX = "demo_session-t-123456";
// Claude Code's startup screens that need an Enter keypress in tmux.
const CONSENT_SCREEN = "WARNING: Loading development channels\n❯ 1. I am using this for local development\n";
const TRUST_SCREEN = "Do you trust the files in this folder?\n❯ 1. Yes, proceed\n";
const READY_SCREEN = "Listening for channel messages from: server:discord\n";
const BOOTING_SCREEN = "Starting Claude Code\n";
// The official Discord plugin 0.0.4 tool set.
const OFFICIAL_TOOLS = ["reply", "react", "edit_message", "download_attachment", "fetch_messages"];

function setup(workspace, { bootScreens = [READY_SCREEN], restMessages = [] } = {}) {
  const botState = path.join(workspace.homeDir, ".claude", "channels", "discord-demo");
  fs.mkdirSync(botState, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(botState, ".env"), "DISCORD_BOT_TOKEN=project-token\n", { mode: 0o600 });
  const claudeHome = path.join(workspace.homeDir, ".claude-work");
  const plugin = path.join(claudeHome, "plugins", "cache", "claude-plugins-official", "discord", "0.0.4");
  fs.mkdirSync(plugin, { recursive: true });
  fs.writeFileSync(path.join(plugin, "server.ts"), "// fixture official plugin\n");
  const projectDir = path.join(workspace.tmpDir, "demo project");
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(workspace.repoDir, "registry.json"), JSON.stringify({
    discord_user_id: "owner", guild_id: "guild",
    pool: [{ id: "bot", app_id: "app", token: "project-token", state_dir: botState, assigned_to: "demo" },
      { id: "codex-bot", app_id: "codex-app", token: "codex-token", state_dir: path.join(workspace.homeDir, "codex-bot"),
        assigned_to: "codexy" }],
    projects: {
      demo: { type: "claude", path: projectDir, bot_id: "bot", channel_id: "channel", screen_name: "demo_session",
        guest_user_ids: ["guest"], model: "claude-opus-5-5", claude_effort: "high", claude_home: claudeHome,
        session_id: null, pid: null },
      codexy: { type: "codex", path: projectDir, bot_id: "codex-bot", channel_id: "codex-channel",
        screen_name: "codexy_session", ws_port: 18399 },
    },
  }, null, 2), { mode: 0o600 });
  const rootState = path.join(workspace.homeDir, "root-discord");
  fs.mkdirSync(rootState, { recursive: true });
  fs.writeFileSync(path.join(rootState, ".env"), "DISCORD_BOT_TOKEN=fixture-root-token\n", { mode: 0o600 });
  const seed = readState(workspace.stateDir);
  seed.fixtures.tmux.claudeBootScreens = bootScreens;
  seed.fixtures.discord.restMessages = restMessages;
  writeState(seed, workspace.stateDir);
  const clockFile = path.join(workspace.tmpDir, "thread-clock");
  fs.writeFileSync(clockFile, "2026-09-28T10:00:00Z\n");
  const env = bridgeChildEnv(workspace, { ROOT_DISCORD_STATE_DIR: rootState, CCDM_THREAD_NODE: process.execPath,
    CCDM_THREAD_CLOCK_FILE: clockFile, CCDM_FIXTURE_CLAUDE_VERSION: "2.1.281 (Claude Code)",
    CCDM_REMINDER_PROJECT_ROOT: workspace.repoDir });
  return { botState, claudeHome, projectDir, clockFile, env,
    threadDir: threadId => path.join(botState, "threads", threadId) };
}

async function status(workspace, env) {
  const result = await runScript(workspace, "scripts/thread-supervisor.py", { args: ["status"], env });
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function startRun(workspace, env) {
  return runScript(workspace, "scripts/thread-supervisor.py", { args: ["run"], env, timeoutMs: 30000 });
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

async function stopRun(workspace, env, running) {
  const current = await status(workspace, env);
  process.kill(-current.worker_pid, "SIGTERM");
  const result = await running;
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  return result;
}

function ownerMessage(workspace, id, content, threadId = THREAD, author = { id: "owner", username: "owner" }) {
  injectDiscordMessage(workspace, { id, channelId: threadId, channelType: 11, parentId: "channel", author, content });
}

const decoded = rows => rows.map(row => ({ ...row, emoji: decodeURIComponent(row.emoji) }));

// A Local Fake of the official Discord plugin speaking MCP over stdio: it
// reports the given live channel notifications once Claude is initialized.
function writeFakePlugin(workspace, notifications) {
  const fake = path.join(workspace.tmpDir, "fake-official-discord.cjs");
  fs.writeFileSync(fake, `
process.stdin.setEncoding("utf8");
let buffer = "";
const write = value => process.stdout.write(JSON.stringify(value) + "\\n");
process.stdin.on("data", chunk => {
  buffer += chunk;
  for (let end; (end = buffer.indexOf("\\n")) >= 0;) {
    const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
    if (!line) continue;
    const request = JSON.parse(line);
    if (request.method === "initialize") write({ jsonrpc: "2.0", id: request.id, result: {
      protocolVersion: "2025-03-26", capabilities: { experimental: { "claude/channel": {} }, tools: {} },
      serverInfo: { name: "discord", version: "1.0.0" }, instructions: "Official Discord reply" } });
    if (request.method === "notifications/initialized") {
      for (const params of ${JSON.stringify(notifications)}) write({ jsonrpc: "2.0", method: "notifications/claude/channel", params });
    }
    if (request.method === "tools/list") write({ jsonrpc: "2.0", id: request.id, result: { tools: ${JSON.stringify(OFFICIAL_TOOLS)}.map(name => ({
      name, inputSchema: { type: "object", properties: { chat_id: { type: "string" }, text: { type: "string" } }, required: ["chat_id", "text"] },
    })) } });
  }
});
`);
  return fake;
}

// Runs the thread's proxy exactly as its generated MCP config tells Claude
// Code to, with the official plugin replaced by the Local Fake, and returns
// the channel notifications it relays to Claude.
async function proxyNotifications(workspace, threadDir, liveNotifications) {
  const config = JSON.parse(fs.readFileSync(path.join(threadDir, "ccdm-message-export-mcp.json"), "utf8"));
  const server = config.mcpServers.discord;
  const fake = writeFakePlugin(workspace, liveNotifications);
  const child = spawn(process.execPath, server.args, {
    cwd: workspace.repoDir, stdio: ["pipe", "pipe", "pipe"],
    env: { ...workspace.env, ...server.env, CCDM_CLAUDE_PLUGIN_COMMAND: process.execPath,
      CCDM_CLAUDE_PLUGIN_ARGS: JSON.stringify([fake]) },
  });
  const exited = new Promise(resolve => child.once("exit", resolve));
  registerTeardownCallback(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await exited;
  });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  const send = value => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n");
  const messages = () => output.split("\n").filter(Boolean).map(line => JSON.parse(line));
  const until = async (predicate, label) => {
    for (let attempt = 0; attempt < 250 && !predicate(); attempt++) await new Promise(r => setTimeout(r, 20));
    assert.ok(predicate(), `proxy never produced ${label}: ${output}`);
  };
  send({ id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {},
    clientInfo: { name: "claude-code", version: "2.1.281" } } });
  await until(() => messages().some(message => message.id === 1), "the initialize response");
  send({ method: "notifications/initialized" });
  send({ id: 2, method: "tools/list" });
  const notifications = () => messages().filter(message => message.method === "notifications/claude/channel");
  await until(() => notifications().length >= 2, "the bootstrap and the post-boot message");
  await new Promise(resolve => setTimeout(resolve, 400));
  child.kill("SIGTERM");
  await exited;
  return notifications();
}

function live(meta, content) {
  return { content, meta: { chat_id: THREAD, user_id: "owner", user: "owner", ts: "2026-09-28T10:00:00.000Z", ...meta } };
}

test("an owner message in a bound Claude thread starts an isolated thread session in its own tmux", async () => {
  const workspace = createWorkspace();
  const context = setup(workspace, { bootScreens: [CONSENT_SCREEN, TRUST_SCREEN, READY_SCREEN] });
  const running = startRun(workspace, context.env);
  await waitForState(workspace, state => state.fixtures.discord.ready.length === 1);
  injectDiscordThread(workspace, { id: THREAD, parentId: "channel", name: "Login bug", ownerId: "owner",
    autoArchiveDuration: 10080 });
  ownerMessage(workspace, "owner-1", "fix the login redirect");
  const thread = await waitForThread(workspace, context.env, THREAD, row => row.state === "live", "live");

  const state = readState(workspace.stateDir);
  const threadDir = context.threadDir(THREAD);
  // Only the thread session runs: no Channel Conversation was started for it.
  assert.deepEqual(Object.keys(state.fixtures.tmux.sessions), [THREAD_TMUX]);
  const session = state.fixtures.tmux.sessions[THREAD_TMUX];
  assert.equal(session.cwd, context.projectDir);
  assert.deepEqual(session.env, { DISCORD_STATE_DIR: threadDir, DISCORD_ACCESS_MODE: "static",
    CLAUDE_CONFIG_DIR: context.claudeHome });
  assert.match(session.shellCommand, / claude --dangerously-load-development-channels server:discord /);
  assert.match(session.shellCommand, /--model 'claude-opus-5-5' --effort 'high'/);
  assert.doesNotMatch(JSON.stringify(session), /project-token/);
  // The consent and workspace-trust prompts were each accepted with Enter.
  assert.deepEqual(session.sendKeys, [["Enter"], ["Enter"]]);

  // The thread state dir borrows the bot credential by symlink and allows
  // only the parent group, for the owner and the project's guests.
  assert.equal(fs.readlinkSync(path.join(threadDir, ".env")), path.join(context.botState, ".env"));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(threadDir, "access.json"), "utf8")), {
    dmPolicy: "allowlist", allowFrom: [], groups: { channel: { requireMention: false, allowFrom: ["owner", "guest"] } },
    pending: {},
  });
  const mcp = JSON.parse(fs.readFileSync(path.join(threadDir, "ccdm-message-export-mcp.json"), "utf8"));
  assert.equal(mcp.mcpServers["discord-message-export"].env.CHANNEL_ID, THREAD);
  assert.equal(mcp.mcpServers["discord-message-export"].env.DISCORD_STATE_DIR, threadDir);
  assert.equal(mcp.mcpServers.discord.env.CCDM_CLAUDE_THREAD_ID, THREAD);
  assert.equal(mcp.mcpServers.discord.env.CCDM_CLAUDE_CHANNEL_ID, "channel");
  assert.doesNotMatch(JSON.stringify(mcp), /project-token/);
  // The channel's own launch files are untouched.
  assert.equal(fs.existsSync(path.join(context.botState, "ccdm-message-export-mcp.json")), false);

  const invocation = state.fixtures.claude.invocations.at(-1);
  assert.equal(state.fixtures.claude.invocations.length, 1);
  assert.equal(thread.state, "live");
  assert.equal(thread.provider_conversation_id, invocation.sessionId);
  assert.deepEqual(decoded(state.fixtures.discord.reactions), [{ authorization: "Bot project-token",
    channelId: THREAD, emoji: "👀", messageId: "owner-1" }]);
  assert.deepEqual(decoded(state.fixtures.discord.reactionDeletes), [{ authorization: "Bot project-token",
    channelId: THREAD, emoji: "👀", messageId: "owner-1" }]);

  // Stopping the project's Channel Conversation leaves the thread session alive.
  const stopped = await runScript(workspace, "scripts/stop-session.sh", { args: ["demo"], env: context.env });
  assert.equal(stopped.exitCode, 0, stopped.stderr || stopped.stdout);
  const after = readState(workspace.stateDir);
  assert.ok(after.fixtures.tmux.sessions[THREAD_TMUX], "the thread tmux survives stop-session.sh demo");
  assert.doesNotThrow(() => process.kill(invocation.pid, 0), "the thread's Claude process survives");
  await stopRun(workspace, context.env, running);
});

test("owner and guest messages sent while booting reach the bootstrap exactly once and are not re-delivered", async () => {
  const workspace = createWorkspace();
  const context = setup(workspace, { bootScreens: [BOOTING_SCREEN] });
  const running = startRun(workspace, context.env);
  await waitForState(workspace, state => state.fixtures.discord.ready.length === 1);
  injectDiscordThread(workspace, { id: THREAD, parentId: "channel", name: "Login bug", ownerId: "owner" });
  ownerMessage(workspace, "owner-1", "first: fix the login redirect");
  await waitForState(workspace, state => Boolean(state.fixtures.tmux.sessions[THREAD_TMUX]) &&
    state.fixtures.discord.reactions.length === 1, 15000);
  ownerMessage(workspace, "guest-1", "guest: it also breaks on mobile", THREAD, { id: "guest", username: "guest" });
  ownerMessage(workspace, "owner-2", "second: and keep the query string");
  await waitForThread(workspace, context.env, THREAD, row => row.buffered_messages === 3, "holding three messages");
  updateFixtureState(workspace, state => { state.fixtures.tmux.sessions[THREAD_TMUX].paneOutput = READY_SCREEN; });
  await waitForThread(workspace, context.env, THREAD, row => row.state === "live", "live");

  const delivered = await proxyNotifications(workspace, context.threadDir(THREAD), [
    live({ message_id: "owner-2" }, "second: and keep the query string"),
    live({ message_id: "owner-3" }, "third: sent after the handoff"),
  ]);
  assert.deepEqual(delivered.map(item => item.params.meta.message_id), ["owner-2", "owner-3"]);
  const [bootstrap] = delivered;
  assert.equal(bootstrap.params.meta.chat_id, THREAD);
  for (const text of ["Login bug", "first: fix the login redirect", "guest: it also breaks on mobile",
    "second: and keep the query string"]) {
    assert.equal(bootstrap.params.content.split(text).length - 1, 1, `${text} appears once:\n${bootstrap.params.content}`);
  }
  assert.ok(bootstrap.params.content.indexOf("first:") < bootstrap.params.content.indexOf("guest:"));
  assert.ok(bootstrap.params.content.indexOf("guest:") < bootstrap.params.content.indexOf("second:"));
  assert.equal(readState(workspace.stateDir).fixtures.claude.invocations.length, 1);
  await stopRun(workspace, context.env, running);
});

test("a thread started from a channel message carries that starter message in its bootstrap", async () => {
  const workspace = createWorkspace();
  // A thread started from a message has the same id as that message.
  const context = setup(workspace, { restMessages: [{ id: THREAD, channel_id: "channel", type: 0,
    content: "The login page redirects to /404 after SSO", author: { id: "owner", username: "owner" } }] });
  const running = startRun(workspace, context.env);
  await waitForState(workspace, state => state.fixtures.discord.ready.length === 1);
  injectDiscordThread(workspace, { id: THREAD, parentId: "channel", name: "SSO redirect", ownerId: "owner" });
  // Discord's thread-created notice (type 18) in the parent and the starter
  // reference (type 21) in the thread are system messages, never triggers.
  injectDiscordMessage(workspace, { id: "notice-18", channelId: "channel", type: 18, author: { id: "owner" },
    content: "SSO redirect" });
  injectDiscordMessage(workspace, { id: "starter-21", channelId: THREAD, channelType: 11, parentId: "channel",
    type: 21, author: { id: "owner" }, content: "", reference: { channelId: "channel", messageId: THREAD } });
  ownerMessage(workspace, "owner-1", "please take this one");
  await waitForThread(workspace, context.env, THREAD, row => row.state === "live", "live");

  const delivered = await proxyNotifications(workspace, context.threadDir(THREAD), [
    live({ message_id: "owner-1" }, "please take this one"),
    live({ message_id: "owner-2" }, "after the handoff"),
  ]);
  assert.deepEqual(delivered.map(item => item.params.meta.message_id), ["owner-1", "owner-2"]);
  const content = delivered[0].params.content;
  assert.equal(content.split("The login page redirects to /404 after SSO").length - 1, 1, content);
  assert.equal(content.split("please take this one").length - 1, 1, content);
  assert.ok(content.indexOf("/404 after SSO") < content.indexOf("please take this one"));
  const state = readState(workspace.stateDir);
  assert.deepEqual(decoded(state.fixtures.discord.reactions).map(row => row.messageId), ["owner-1"]);
  assert.equal(state.fixtures.claude.invocations.length, 1);
  await stopRun(workspace, context.env, running);
});

test("a boot that never becomes ready fails once after 120 seconds and waits for the next owner message", async () => {
  const workspace = createWorkspace();
  const context = setup(workspace, { bootScreens: [BOOTING_SCREEN] });
  const running = startRun(workspace, context.env);
  await waitForState(workspace, state => state.fixtures.discord.ready.length === 1);
  injectDiscordThread(workspace, { id: THREAD, parentId: "channel", name: "Login bug", ownerId: "owner" });
  ownerMessage(workspace, "owner-1", "fix the login redirect");
  await waitForState(workspace, state => Boolean(state.fixtures.tmux.sessions[THREAD_TMUX]), 15000);
  fs.writeFileSync(context.clockFile, "2026-09-28T10:02:01Z\n");
  const failed = await waitForThread(workspace, context.env, THREAD, row => row.state === "stopped", "stopped");
  assert.equal(failed.stop_reason, "start-failed");

  let state = await waitForState(workspace, next => next.fixtures.discord.reactionDeletes?.length === 1);
  const posted = state.fixtures.discord.messages.filter(message => message.channelId === THREAD);
  assert.equal(posted.length, 1);
  assert.equal(posted[0].authorization, "Bot project-token");
  assert.match(posted[0].content, /^Thread session failed to start: .*120 seconds/);
  assert.doesNotMatch(posted[0].content, /\n/);
  assert.equal(state.fixtures.tmux.sessions[THREAD_TMUX], undefined, "the failed tmux session is stopped");

  // Neither time nor a guest message retries the failed start.
  fs.writeFileSync(context.clockFile, "2026-09-28T10:10:00Z\n");
  ownerMessage(workspace, "guest-1", "any news?", THREAD, { id: "guest", username: "guest" });
  await new Promise(resolve => setTimeout(resolve, 1500));
  assert.equal(readState(workspace.stateDir).fixtures.claude.invocations.length, 1);

  ownerMessage(workspace, "owner-2", "try again");
  state = await waitForState(workspace, next => next.fixtures.claude.invocations.length === 2, 15000);
  assert.ok(state.fixtures.tmux.sessions[THREAD_TMUX]);
  await stopRun(workspace, context.env, running);
});

test("a stranger's message and a thread in a Codex project start nothing", async () => {
  const workspace = createWorkspace();
  const context = setup(workspace);
  const running = startRun(workspace, context.env);
  await waitForState(workspace, state => state.fixtures.discord.ready.length === 1);
  const codexThread = "1500000000000222222";
  const laterThread = "1500000000000333333";
  injectDiscordThread(workspace, { id: THREAD, parentId: "channel", ownerId: "owner" });
  injectDiscordThread(workspace, { id: codexThread, parentId: "codex-channel", ownerId: "owner" });
  injectDiscordThread(workspace, { id: laterThread, parentId: "channel", ownerId: "owner" });
  ownerMessage(workspace, "stranger-1", "let me in", THREAD, { id: "stranger", username: "stranger" });
  injectDiscordMessage(workspace, { id: "codex-1", channelId: codexThread, channelType: 11, parentId: "codex-channel",
    author: { id: "owner", username: "owner" }, content: "codex please" });
  ownerMessage(workspace, "owner-1", "this one starts", laterThread);
  await waitForThread(workspace, context.env, laterThread, row => row.state === "live", "live");

  const current = await status(workspace, context.env);
  assert.equal(current.projects.demo.threads[THREAD].state, "registered");
  assert.equal(current.projects.codexy.threads[codexThread].state, "registered");
  const state = readState(workspace.stateDir);
  assert.deepEqual(Object.keys(state.fixtures.tmux.sessions), ["demo_session-t-333333"]);
  assert.deepEqual(decoded(state.fixtures.discord.reactions).map(row => row.messageId), ["owner-1"]);
  assert.equal(state.fixtures.claude.invocations.length, 1);
  await stopRun(workspace, context.env, running);
});
