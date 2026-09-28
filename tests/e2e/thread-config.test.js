import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { createWorkspace, runScript } from "./support/runner.js";
import { bridgeChildEnv, injectDiscordMessage, injectDiscordReaction, injectDiscordThread, startFakeCodexServer,
  waitForState } from "./support/bridge.js";
import { readState, writeState } from "./support/state.js";
import { cleanup } from "./support/teardown.js";

test.afterEach(async () => cleanup());

// Discord snowflakes; a Claude thread's tmux name ends in the last six digits.
const THREAD = "1500000000000123456";
const CLAUDE_TMUX = "demo_session-t-123456";
const READY_SCREEN = "Listening for channel messages from: server:discord\n";

// A Claude project (`demo`) and a Codex project (`codexy`), each with its own
// bot, a named Claude account for the Claude project's home, and a named Codex
// Account as the Default Codex Account.
function setup(workspace, { port = 18999 } = {}) {
  const projectDir = path.join(workspace.tmpDir, "project");
  fs.mkdirSync(projectDir, { recursive: true });
  const codexHome = path.join(workspace.homeDir, ".codex-work");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(codexHome, "config.toml"), "model = \"gpt-6\"\n");
  const claudeHome = path.join(workspace.homeDir, ".claude-work");
  const plugin = path.join(claudeHome, "plugins", "cache", "claude-plugins-official", "discord", "0.0.4");
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
    claude_accounts: { work: claudeHome },
    pool: [
      { id: "demo-bot", app_id: "demo-app", token: "demo-token", state_dir: demoState, assigned_to: "demo" },
      { id: "codexy-bot", app_id: "codexy-app", token: "codexy-token", state_dir: codexyState, assigned_to: "codexy" },
    ],
    projects: {
      demo: { type: "claude", path: projectDir, bot_id: "demo-bot", channel_id: "channel", screen_name: "demo_session",
        guest_user_ids: ["guest"], model: "claude-opus-5-5", claude_effort: "high", claude_home: claudeHome,
        thread_ws_port: port, text_reply_fallback: true },
      codexy: { type: "codex", path: projectDir, bot_id: "codexy-bot", channel_id: "codex-channel",
        screen_name: "codexy_session", ws_port: 18399, thread_ws_port: port, codex_model: "gpt-6",
        codex_reasoning_effort: "high", codex_sandbox: "workspace-write", text_reply_fallback: true,
        guest_user_ids: ["guest"] },
    },
  }, null, 2), { mode: 0o600 });
  const rootState = path.join(workspace.homeDir, "root-discord");
  fs.mkdirSync(rootState, { recursive: true });
  fs.writeFileSync(path.join(rootState, ".env"), "DISCORD_BOT_TOKEN=fixture-root-token\n", { mode: 0o600 });
  const seed = readState(workspace.stateDir);
  // The supervisor (root) and a thread host (project bot) each receive every event.
  seed.fixtures.discord.fanOut = true;
  seed.fixtures.tmux.claudeBootScreens = [READY_SCREEN, READY_SCREEN];
  writeState(seed, workspace.stateDir);
  const clockFile = path.join(workspace.tmpDir, "thread-clock");
  fs.writeFileSync(clockFile, "2026-09-28T10:00:00Z\n");
  const env = bridgeChildEnv(workspace, { ROOT_DISCORD_STATE_DIR: rootState, CCDM_THREAD_NODE: process.execPath,
    CCDM_THREAD_CLOCK_FILE: clockFile, CCDM_FIXTURE_CLAUDE_VERSION: "2.1.281 (Claude Code)",
    CCDM_REMINDER_PROJECT_ROOT: workspace.repoDir });
  return { claudeHome, codexHome, projectDir, env };
}

async function status(workspace, env) {
  const result = await runScript(workspace, "scripts/thread-supervisor.py", { args: ["status"], env });
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function startRun(workspace, env) {
  return runScript(workspace, "scripts/thread-supervisor.py", { args: ["run"], env, timeoutMs: 45000 });
}

async function stopRun(workspace, env, running) {
  const current = await status(workspace, env);
  process.kill(-current.worker_pid, "SIGTERM");
  const result = await running;
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
}

async function waitForThread(workspace, env, predicate, label, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let current;
  while (Date.now() < deadline) {
    current = await status(workspace, env);
    const thread = Object.values(current.projects).map(project => project.threads[THREAD]).find(Boolean);
    if (thread && predicate(thread)) return thread;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for thread ${THREAD} to be ${label}: ${JSON.stringify(current)}\nposted: ${
    JSON.stringify(readState(workspace.stateDir).fixtures.discord.messages)}`);
}

function message(workspace, id, content, { parentId = "channel", author = { id: "owner", username: "owner" } } = {}) {
  injectDiscordMessage(workspace, { id, channelId: THREAD, channelType: 11, parentId, author, content });
}

async function liveThread(workspace, env, parentId = "channel") {
  injectDiscordThread(workspace, { id: THREAD, parentId, name: "Login bug", ownerId: "owner", autoArchiveDuration: 10080 });
  message(workspace, "owner-1", "fix the login redirect", { parentId });
  return waitForThread(workspace, env, row => row.state === "live", "live");
}

// Waits for the supervisor to post its `count`-th message in the thread.
async function threadPosts(workspace, count) {
  const state = await waitForState(workspace, next => (next.fixtures.discord.messages ?? [])
    .filter(posted => posted.channelId === THREAD).length >= count, 10000);
  return state.fixtures.discord.messages.filter(posted => posted.channelId === THREAD);
}

async function gatewayDrained(workspace) {
  await waitForState(workspace, state => state.fixtures.discord.injectedMessages.every(row => row.delivered) &&
    (state.fixtures.discord.injectedReactions ?? []).every(row => row.delivered));
  // Let the observer hand the last event to the service.
  await new Promise(resolve => setTimeout(resolve, 1500));
}

test("/config in a Claude thread posts its settings, marking those inherited from the project", async () => {
  const workspace = createWorkspace();
  const context = setup(workspace);
  const running = startRun(workspace, context.env);
  await waitForState(workspace, state => state.fixtures.discord.ready.length === 1);
  await liveThread(workspace, context.env);

  message(workspace, "config-1", "/config");
  const [posted] = await threadPosts(workspace, 1);
  assert.equal(posted.authorization, "Bot demo-token");
  assert.equal(posted.content, "/config: provider claude (inherited), account work (inherited), " +
    "model claude-opus-5-5 (inherited), effort high (inherited)");
  await stopRun(workspace, context.env, running);
});

test("/config model= on a live Claude thread relaunches the same session with the new model", async () => {
  const workspace = createWorkspace();
  const context = setup(workspace);
  const running = startRun(workspace, context.env);
  await waitForState(workspace, state => state.fixtures.discord.ready.length === 1);
  const first = await liveThread(workspace, context.env);
  const sessionId = first.provider_conversation_id;

  message(workspace, "config-1", "/config model=claude-sonnet-5");
  await waitForState(workspace, state => state.fixtures.claude.invocations.length === 2, 15000);
  const resumed = await waitForThread(workspace, context.env, row => row.state === "live", "live again");
  assert.equal(resumed.provider_conversation_id, sessionId);
  const state = readState(workspace.stateDir);
  const relaunch = state.fixtures.claude.invocations[1];
  assert.equal(relaunch.args[relaunch.args.indexOf("--resume") + 1], `'${sessionId}'`);
  assert.equal(relaunch.args[relaunch.args.indexOf("--model") + 1], "'claude-sonnet-5'");
  assert.equal(relaunch.env.CLAUDE_CONFIG_DIR, context.claudeHome);
  assert.deepEqual(Object.keys(state.fixtures.tmux.sessions), [CLAUDE_TMUX]);
  // 👀 marks the /config message while the session restarts.
  const onConfig = row => row.messageId === "config-1";
  assert.deepEqual(state.fixtures.discord.reactions.filter(onConfig).map(row => decodeURIComponent(row.emoji)), ["👀"]);

  // The stored override now shows as the thread's own.
  message(workspace, "config-2", "/config");
  const posts = await threadPosts(workspace, 2);
  assert.equal(posts.at(-1).content, "/config: provider claude (inherited), account work (inherited), " +
    "model claude-sonnet-5, effort high (inherited)");
  await stopRun(workspace, context.env, running);
});

test("/config with a raw account path, an unknown alias, a bad provider, or a bad effort posts one error line and changes nothing", async () => {
  const workspace = createWorkspace();
  const context = setup(workspace);
  const running = startRun(workspace, context.env);
  await waitForState(workspace, state => state.fixtures.discord.ready.length === 1);
  await liveThread(workspace, context.env);
  const commands = ["/config account=/tmp/x", "/config account=personal", "/config provider=gemini",
    "/config effort=ludicrous"];
  commands.forEach((content, index) => message(workspace, `config-${index}`, content));
  const posts = await threadPosts(workspace, commands.length);
  await gatewayDrained(workspace);

  assert.deepEqual(posts.map(posted => posted.content), [
    "/config: account takes an account alias, not a path.",
    "/config: account=personal is not a configured Claude account alias.",
    "/config: provider must be claude or codex.",
    "/config: effort for Claude must be one of low, medium, high, xhigh, max.",
  ]);
  const state = readState(workspace.stateDir);
  assert.equal(state.fixtures.discord.messages.filter(posted => posted.channelId === THREAD).length, commands.length);
  assert.equal(state.fixtures.claude.invocations.length, 1);
  assert.equal((state.fixtures.discord.reactions ?? []).filter(row => row.messageId.startsWith("config-")).length, 0);
  const thread = await waitForThread(workspace, context.env, row => row.state === "live", "still live");
  assert.equal(thread.stop_reason, undefined);
  await stopRun(workspace, context.env, running);
});

const clientRequests = (state, method) => state.fixtures.codex.protocolEvents
  .filter(event => event.event === "client-message" && event.message.method === method)
  .map(event => event.message.params);

test("/config provider=codex waits for the owner's ✅ on its warning, then starts a fresh Codex conversation", async () => {
  const workspace = createWorkspace();
  const codex = await startFakeCodexServer(workspace, { threadIds: ["codex-thread-a"],
    turnsByThread: { "codex-thread-a": [{ delta: "Codex here." }] } });
  const context = setup(workspace, { port: codex.port });
  const running = startRun(workspace, context.env);
  await waitForState(workspace, state => state.fixtures.discord.ready.length === 1);
  const first = await liveThread(workspace, context.env);
  const claudeSession = first.provider_conversation_id;

  message(workspace, "config-1", "/config provider=codex");
  const [warning] = await threadPosts(workspace, 1);
  assert.equal(warning.content.split("\n").length, 1);
  assert.match(warning.content, /fresh conversation/);
  // The bot reacts ✅ on its own warning, and nothing else changes yet.
  let state = await waitForState(workspace, next => (next.fixtures.discord.reactions ?? [])
    .some(row => row.messageId === warning.id));
  assert.deepEqual(state.fixtures.discord.reactions.filter(row => row.messageId === warning.id)
    .map(row => [row.authorization, row.channelId, decodeURIComponent(row.emoji)]), [["Bot demo-token", THREAD, "✅"]]);

  // A guest's ✅ does nothing.
  injectDiscordReaction(workspace, { id: "guest-confirm", channelId: THREAD, messageId: warning.id, emoji: "✅",
    message: { author: { id: "demo-app" }, content: warning.content }, user: { id: "guest", username: "guest" } });
  await gatewayDrained(workspace);
  state = readState(workspace.stateDir);
  assert.equal(state.fixtures.claude.invocations.length, 1);
  assert.deepEqual(Object.keys(state.fixtures.tmux.sessions), [CLAUDE_TMUX]);
  assert.deepEqual(state.fixtures.codex.appServerInvocations ?? [], []);
  const unchanged = await waitForThread(workspace, context.env, row => row.state === "live", "still live");
  assert.equal(unchanged.provider_conversation_id, claudeSession);

  // The owner's ✅ stops Claude and starts a fresh Codex conversation in the same thread.
  injectDiscordReaction(workspace, { id: "owner-confirm", channelId: THREAD, messageId: warning.id, emoji: "✅",
    message: { author: { id: "demo-app" }, content: warning.content }, user: { id: "owner", username: "owner" } });
  const switched = await waitForThread(workspace, context.env,
    row => row.state === "live" && row.provider_conversation_id === "codex-thread-a", "live on Codex");
  assert.notEqual(switched.provider_conversation_id, claudeSession);
  state = readState(workspace.stateDir);
  assert.deepEqual(Object.keys(state.fixtures.tmux.sessions), ["demo_session-threads"]);
  const [{ method, mcpServers }] = state.fixtures.codex.threadConfigs;
  assert.equal(method, "thread/start");
  assert.equal(mcpServers[`discord-${THREAD}`].env.CHANNEL_ID, THREAD);
  // Only the no-action bootstrap runs: neither /config nor the ✅ becomes a turn.
  const turns = clientRequests(state, "turn/start");
  assert.equal(turns.length, 1);
  assert.doesNotMatch(JSON.stringify(turns), /\/config/);
  await stopRun(workspace, context.env, running);
});

test("/config model= effort= on a live Codex thread resumes the same conversation with them, and /config never becomes a turn", async () => {
  const workspace = createWorkspace();
  const codex = await startFakeCodexServer(workspace, { threadIds: ["codex-thread-a"],
    turnsByThread: { "codex-thread-a": [{ delta: "On it." }, { delta: "Faster now." }] } });
  const context = setup(workspace, { port: codex.port });
  const running = startRun(workspace, context.env);
  await waitForState(workspace, state => state.fixtures.discord.ready.length === 1);
  await liveThread(workspace, context.env, "codex-channel");
  await waitForState(workspace, state => state.fixtures.discord.sends.some(send => send.content === "On it."), 10000);

  // A guest's /config is dropped without a reply, and the owner's shows the settings.
  message(workspace, "guest-config", "/config model=gpt-1", { parentId: "codex-channel",
    author: { id: "guest", username: "guest" } });
  message(workspace, "config-0", "/config", { parentId: "codex-channel" });
  const [shown] = await threadPosts(workspace, 1);
  assert.equal(shown.authorization, "Bot codexy-token");
  assert.equal(shown.content, "/config: provider codex (inherited), account work (inherited), " +
    "model gpt-6 (inherited), effort high (inherited)");

  message(workspace, "config-1", "/config model=gpt-6-mini effort=low", { parentId: "codex-channel" });
  let state = await waitForState(workspace, next => (next.fixtures.codex.threadConfigs ?? [])
    .some(config => config.method === "thread/resume"), 15000);
  const thread = await waitForThread(workspace, context.env, row => row.state === "live", "live again");
  assert.equal(thread.provider_conversation_id, "codex-thread-a");
  const [resume] = state.fixtures.codex.threadConfigs.filter(config => config.method === "thread/resume");
  assert.equal(resume.params.threadId, "codex-thread-a");
  assert.equal(resume.params.model, "gpt-6-mini");
  assert.equal(resume.params.config.model_reasoning_effort, "low");
  assert.equal(resume.mcpServers[`discord-${THREAD}`].env.CHANNEL_ID, THREAD);

  // The next owner message is a turn with the new settings; no turn ever carried /config.
  message(workspace, "owner-2", "try again", { parentId: "codex-channel" });
  state = await waitForState(workspace, next => next.fixtures.discord.sends.some(send => send.content === "Faster now."),
    10000);
  const turns = clientRequests(state, "turn/start");
  assert.doesNotMatch(JSON.stringify(turns), /\/config/);
  const last = turns.at(-1);
  assert.equal(last.input.map(part => part.text).join(""), "try again");
  assert.equal(last.model, "gpt-6-mini");
  assert.equal(last.effort, "low");
  await stopRun(workspace, context.env, running);
});
