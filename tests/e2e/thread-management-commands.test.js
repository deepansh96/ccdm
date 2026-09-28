import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { createWorkspace, runScript } from "./support/runner.js";
import { bridgeChildEnv, injectDiscordMessage, injectDiscordThread, injectDiscordThreadUpdate, startFakeCodexServer,
  waitForState } from "./support/bridge.js";
import { readState, seedTmuxSession, writeState } from "./support/state.js";
import { cleanup } from "./support/teardown.js";

test.afterEach(async () => cleanup());

// Discord snowflakes; a Claude thread's tmux name ends in the last six digits.
const THREAD = "1500000000000123456";
const SIBLING = "1500000000000654321";
const THREAD_TMUX = "demo_session-t-123456";
const SIBLING_TMUX = "demo_session-t-654321";
// Audit-log action 111 is THREAD_UPDATE.
const THREAD_UPDATE = 111;
// Discord's snowflake epoch; an id's top bits are milliseconds since it.
const DISCORD_EPOCH = 1420070400000n;
const snowflake = iso => String((BigInt(Date.parse(iso)) - DISCORD_EPOCH) << 22n);
const READY_SCREEN = "Listening for channel messages from: server:discord\n";

// A Claude project (`demo`, bot user `demo-app`) with a running Channel
// Conversation in tmux `demo_session`, and a Codex project (`codexy`).
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
    discord_user_id: "owner", guild_id: "guild", root_bot_app_id: "root-app",
    codex_accounts: { work: codexHome }, default_codex_account: "work",
    pool: [
      { id: "demo-bot", app_id: "demo-app", token: "demo-token", state_dir: demoState, assigned_to: "demo" },
      { id: "codexy-bot", app_id: "codexy-app", token: "codexy-token", state_dir: codexyState, assigned_to: "codexy" },
    ],
    projects: {
      demo: { type: "claude", path: projectDir, bot_id: "demo-bot", channel_id: "channel", screen_name: "demo_session",
        guest_user_ids: ["guest"], model: "claude-opus-5-5", claude_effort: "high", claude_home: claudeHome },
      codexy: { type: "codex", path: projectDir, bot_id: "codexy-bot", channel_id: "codex-channel",
        screen_name: "codexy_session", ws_port: 18399, thread_ws_port: port, codex_model: "gpt-6",
        codex_reasoning_effort: "high", text_reply_fallback: true, guest_user_ids: ["guest"] },
    },
  }, null, 2), { mode: 0o600 });
  const rootState = path.join(workspace.homeDir, "root-discord");
  fs.mkdirSync(rootState, { recursive: true });
  fs.writeFileSync(path.join(rootState, ".env"), "DISCORD_BOT_TOKEN=fixture-root-token\n", { mode: 0o600 });
  const seed = readState(workspace.stateDir);
  // The supervisor (root) and a thread host (project bot) each receive every event.
  seed.fixtures.discord.fanOut = true;
  seed.fixtures.tmux.claudeBootScreens = [READY_SCREEN];
  writeState(seed, workspace.stateDir);
  seedTmuxSession("demo_session", { paneOutput: "Listening for channel messages\n" }, { stateDir: workspace.stateDir });
  const clockFile = path.join(workspace.tmpDir, "thread-clock");
  fs.writeFileSync(clockFile, "2026-09-28T10:00:00Z\n");
  const env = bridgeChildEnv(workspace, { ROOT_DISCORD_STATE_DIR: rootState, CCDM_THREAD_NODE: process.execPath,
    CCDM_THREAD_CLOCK_FILE: clockFile, CCDM_FIXTURE_CLAUDE_VERSION: "2.1.281 (Claude Code)",
    CCDM_REMINDER_PROJECT_ROOT: workspace.repoDir });
  return { env };
}

async function status(workspace, env) {
  const result = await runScript(workspace, "scripts/thread-supervisor.py", { args: ["status"], env });
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function startRun(workspace, env) {
  return runScript(workspace, "scripts/thread-supervisor.py", { args: ["run"], env, timeoutMs: 60000 });
}

async function stopRun(workspace, env, running) {
  const current = await status(workspace, env);
  process.kill(-current.worker_pid, "SIGTERM");
  const result = await running;
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
  throw new Error(`Timed out waiting for thread ${threadId} to be ${label}: ${JSON.stringify(current)}\nposted: ${
    JSON.stringify(readState(workspace.stateDir).fixtures.discord.messages)}`);
}

const OWNER = { id: "owner", username: "owner" };
const GUEST = { id: "guest", username: "guest" };

function message(workspace, threadId, id, content, { parentId = "channel", author = OWNER } = {}) {
  injectDiscordMessage(workspace, { id, channelId: threadId, channelType: 11, parentId, author, content });
}

async function liveThread(workspace, env, threadId, messageId, parentId = "channel") {
  injectDiscordThread(workspace, { id: threadId, parentId, name: `Task ${threadId.slice(-3)}`, ownerId: "owner",
    autoArchiveDuration: 10080 });
  message(workspace, threadId, messageId, "fix the login redirect", { parentId });
  return waitForThread(workspace, env, threadId, row => row.state === "live", "live");
}

const posts = (state, threadId) => (state.fixtures.discord.messages ?? []).filter(posted => posted.channelId === threadId);

// Waits for the project bot's `count`-th post in the thread.
async function threadPosts(workspace, threadId, count) {
  const state = await waitForState(workspace, next => posts(next, threadId).length >= count, 15000);
  return posts(state, threadId);
}

async function gatewayDrained(workspace) {
  await waitForState(workspace, state => state.fixtures.discord.injectedMessages.every(row => row.delivered) &&
    (state.fixtures.discord.injectedThreads ?? []).every(row => row.delivered));
  // Let the observer hand the last event to the service.
  await new Promise(resolve => setTimeout(resolve, 1500));
}

const clientRequests = (state, method) => state.fixtures.codex.protocolEvents
  .filter(event => event.event === "client-message" && event.message.method === method)
  .map(event => event.message.params);
const turnText = turn => turn.input.map(part => part.text).join("");

test("/restart in a Claude thread resumes its own session only, and /compact reaches only that thread's tmux", async () => {
  const workspace = createWorkspace();
  const context = setup(workspace);
  const running = startRun(workspace, context.env);
  await waitForState(workspace, state => state.fixtures.discord.ready.length === 1);
  const first = await liveThread(workspace, context.env, THREAD, "owner-1");
  await liveThread(workspace, context.env, SIBLING, "owner-2");
  const siblingPid = readState(workspace.stateDir).fixtures.tmux.sessions[SIBLING_TMUX].pid;

  message(workspace, THREAD, "restart-1", "/restart");
  let state = await waitForState(workspace, next => next.fixtures.claude.invocations.length === 3, 15000);
  const resumed = await waitForThread(workspace, context.env, THREAD, row => row.state === "live", "live again");
  assert.equal(resumed.provider_conversation_id, first.provider_conversation_id);
  const relaunch = state.fixtures.claude.invocations[2];
  assert.equal(relaunch.args[relaunch.args.indexOf("--resume") + 1], `'${first.provider_conversation_id}'`);

  // A guest's /compact is relayed like the owner's, into this thread's tmux only.
  message(workspace, THREAD, "compact-1", "/compact", { author: GUEST });
  const acknowledged = await threadPosts(workspace, THREAD, 2);
  await gatewayDrained(workspace);
  state = readState(workspace.stateDir);
  assert.deepEqual(acknowledged.map(posted => [posted.authorization, posted.content]), [
    ["Bot demo-token", "/restart: restarting this thread's session; the conversation resumes."],
    ["Bot demo-token", "/compact: compacting this thread's conversation."],
  ]);
  assert.equal(posts(state, THREAD).length, 2);
  assert.deepEqual(state.fixtures.tmux.sessions[THREAD_TMUX].sendKeys, [["-l", "/compact"], ["Enter"]]);
  // The sibling thread and the Channel Conversation are untouched.
  assert.equal(posts(state, SIBLING).length, 0);
  assert.equal(state.fixtures.tmux.sessions[SIBLING_TMUX].pid, siblingPid);
  assert.equal(state.fixtures.tmux.sessions[SIBLING_TMUX].sendKeys, undefined);
  assert.equal(state.fixtures.tmux.sessions.demo_session.sendKeys, undefined);
  assert.ok(!state.fixtures.tmux.sessions.demo_session.killAttempts);
  assert.equal(state.fixtures.claude.invocations.length, 3);
  await waitForThread(workspace, context.env, SIBLING, row => row.state === "live", "still live");
  await stopRun(workspace, context.env, running);
});

test("/clear in a Claude thread starts a fresh session and stores its new id", async () => {
  const workspace = createWorkspace();
  const context = setup(workspace);
  const running = startRun(workspace, context.env);
  await waitForState(workspace, state => state.fixtures.discord.ready.length === 1);
  const first = await liveThread(workspace, context.env, THREAD, "owner-1");

  message(workspace, THREAD, "clear-1", "/clear");
  const cleared = await waitForThread(workspace, context.env, THREAD,
    row => row.state === "live" && row.provider_conversation_id !== first.provider_conversation_id, "live afresh");
  const state = readState(workspace.stateDir);
  const relaunch = state.fixtures.claude.invocations[1];
  assert.equal(relaunch.args.includes("--resume"), false);
  assert.equal(cleared.provider_conversation_id, relaunch.sessionId);
  const [ack] = await threadPosts(workspace, THREAD, 1);
  assert.equal(ack.content, "/clear: starting a fresh conversation in this thread.");
  await gatewayDrained(workspace);
  assert.equal(posts(readState(workspace.stateDir), THREAD).length, 1);
  await stopRun(workspace, context.env, running);
});

test("in a Codex thread, /restart resumes its own conversation, /pause and /unpause hold and release its messages, and /clear moves it to a fresh conversation", async () => {
  const workspace = createWorkspace();
  const codex = await startFakeCodexServer(workspace, { threadIds: ["codex-a", "codex-b", "codex-c"],
    turnsByThread: {
      "codex-a": [{ delta: "On it." }, { delta: "Did the held work." }],
      "codex-b": [{ delta: "Sibling on it." }, { delta: "Sibling kept going." }],
      "codex-c": [{ delta: "Fresh start." }],
    } });
  const context = setup(workspace, { port: codex.port });
  const running = startRun(workspace, context.env);
  await waitForState(workspace, state => state.fixtures.discord.ready.length === 1);
  await liveThread(workspace, context.env, THREAD, "owner-1", "codex-channel");
  await liveThread(workspace, context.env, SIBLING, "owner-2", "codex-channel");
  await waitForState(workspace, state => ["On it.", "Sibling on it."]
    .every(text => state.fixtures.discord.sends.some(send => send.content === text)), 10000);
  const options = { parentId: "codex-channel" };

  message(workspace, THREAD, "restart-1", "/restart", options);
  let state = await waitForState(workspace, next => (next.fixtures.codex.threadConfigs ?? [])
    .some(config => config.method === "thread/resume"), 15000);
  await waitForThread(workspace, context.env, THREAD, row => row.state === "live", "live again");
  assert.deepEqual(state.fixtures.codex.threadConfigs.filter(config => config.method === "thread/resume")
    .map(config => config.params.threadId), ["codex-a"]);
  await threadPosts(workspace, THREAD, 1);

  message(workspace, THREAD, "pause-1", "/pause", options);
  await threadPosts(workspace, THREAD, 2);
  message(workspace, THREAD, "owner-3", "held work", options);
  message(workspace, SIBLING, "owner-4", "sibling work", options);
  state = await waitForState(workspace, next => next.fixtures.discord.sends.some(send => send.content === "Sibling kept going."),
    10000);
  await gatewayDrained(workspace);
  state = readState(workspace.stateDir);
  assert.equal(clientRequests(state, "turn/start").some(turn => turnText(turn) === "held work"), false);

  message(workspace, THREAD, "unpause-1", "/unpause", options);
  state = await waitForState(workspace, next => next.fixtures.discord.sends.some(send => send.content === "Did the held work."),
    10000);
  const held = clientRequests(state, "turn/start").filter(turn => turnText(turn) === "held work");
  assert.deepEqual(held.map(turn => turn.threadId), ["codex-a"]);

  message(workspace, THREAD, "clear-1", "/clear", options);
  await waitForThread(workspace, context.env, THREAD,
    row => row.state === "live" && row.provider_conversation_id === "codex-c", "live on a fresh conversation");
  message(workspace, THREAD, "owner-5", "start over", options);
  state = await waitForState(workspace, next => next.fixtures.discord.sends.some(send => send.content === "Fresh start."),
    10000);
  const fresh = clientRequests(state, "turn/start").filter(turn => turnText(turn) === "start over");
  assert.deepEqual(fresh.map(turn => turn.threadId), ["codex-c"]);

  await gatewayDrained(workspace);
  state = readState(workspace.stateDir);
  assert.deepEqual(posts(state, THREAD).map(posted => [posted.authorization, posted.content]), [
    ["Bot codexy-token", "/restart: restarting this thread's session; the conversation resumes."],
    ["Bot codexy-token", "/pause: paused; new messages in this thread wait for /unpause."],
    ["Bot codexy-token", "/unpause: unpaused; waiting messages go through now."],
    ["Bot codexy-token", "/clear: starting a fresh conversation in this thread."],
  ]);
  // The sibling conversation was never reloaded, and no command became a turn.
  assert.equal(posts(state, SIBLING).length, 0);
  assert.equal(state.fixtures.codex.threadConfigs.some(config => config.params.threadId === "codex-b" &&
    config.method === "thread/resume"), false);
  assert.equal(clientRequests(state, "thread/unsubscribe").some(params => params.threadId === "codex-b"), false);
  assert.doesNotMatch(JSON.stringify(clientRequests(state, "turn/start")), /\/(?:restart|pause|unpause|clear)/);
  await stopRun(workspace, context.env, running);
});

test("/close archives the thread with the project bot, stops its session, and the bot's archive keeps it closed", async () => {
  const workspace = createWorkspace();
  const context = setup(workspace);
  const running = startRun(workspace, context.env);
  await waitForState(workspace, state => state.fixtures.discord.ready.length === 1);
  await liveThread(workspace, context.env, THREAD, "owner-1");

  // A guest's /close does nothing.
  message(workspace, THREAD, "guest-close", "/close", { author: GUEST });
  await gatewayDrained(workspace);
  let state = readState(workspace.stateDir);
  assert.equal(posts(state, THREAD).length, 0);
  assert.deepEqual(state.fixtures.discord.threadPatches.filter(patch => patch.body.archived !== undefined), []);

  message(workspace, THREAD, "close-1", "/close");
  const closed = await waitForThread(workspace, context.env, THREAD, row => row.state === "closed", "closed");
  assert.equal(closed.stop_reason, undefined);
  state = await waitForState(workspace, next => (next.fixtures.discord.auditLogFetches ?? []).length > 0 &&
    !next.fixtures.tmux.sessions[THREAD_TMUX]);
  assert.deepEqual(state.fixtures.discord.threadPatches.filter(patch => patch.body.archived !== undefined)
    .map(patch => [patch.authorization, patch.threadId, patch.body]), [["Bot demo-token", THREAD, { archived: true }]]);
  await gatewayDrained(workspace);
  // The archive's audit-log actor is the project bot; the close intent keeps it closed.
  const after = await waitForThread(workspace, context.env, THREAD, row => row.state === "closed", "still closed");
  assert.equal(after.stop_reason, undefined);
  assert.equal(after.archive, undefined);
  state = readState(workspace.stateDir);
  assert.deepEqual(posts(state, THREAD).map(posted => posted.content), ["/close: closing this thread."]);
  assert.ok(!state.fixtures.tmux.sessions.demo_session.killAttempts);
  await stopRun(workspace, context.env, running);
});

test("an archive by the project bot without a /close intent is an auto-archive", async () => {
  const workspace = createWorkspace();
  const context = setup(workspace);
  const running = startRun(workspace, context.env);
  await waitForState(workspace, state => state.fixtures.discord.ready.length === 1);
  await liveThread(workspace, context.env, THREAD, "owner-1");

  const state = readState(workspace.stateDir);
  state.fixtures.discord.auditLogEntries = [{ id: snowflake("2026-09-28T10:05:00Z"), user_id: "demo-app",
    target_id: THREAD, action_type: THREAD_UPDATE, changes: [{ key: "archived", old_value: false, new_value: true }] }];
  writeState(state, workspace.stateDir);
  injectDiscordThreadUpdate(workspace, { id: THREAD, archived: true, archiveTimestamp: "2026-09-28T10:05:00Z" });
  const stopped = await waitForThread(workspace, context.env, THREAD, row => row.state === "stopped", "stopped");
  assert.equal(stopped.stop_reason, "auto-archive");
  await stopRun(workspace, context.env, running);
});
