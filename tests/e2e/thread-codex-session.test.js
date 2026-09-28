import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { createWorkspace, runScript } from "./support/runner.js";
import { bridgeChildEnv, injectDiscordMessage, injectDiscordThread, startFakeCodexServer, waitForState }
  from "./support/bridge.js";
import { readState, writeState } from "./support/state.js";
import { cleanup } from "./support/teardown.js";

test.afterEach(async () => cleanup());

// Discord snowflakes for two threads under the Codex project's channel.
const THREAD = "1500000000000123456";
const SIBLING = "1500000000000654321";
const HOST_TMUX = "codexy_session-threads";
const PROJECT_TOKEN = "codex-project-token";

function setup(workspace, { port, sandbox = "workspace-write" }) {
  const projectDir = path.join(workspace.tmpDir, "codex project");
  fs.mkdirSync(projectDir, { recursive: true });
  // The Codex Home already configures another project's Discord server and
  // holds a saved rollout.
  const codexHome = path.join(workspace.homeDir, ".codex-work");
  const rollout = path.join(codexHome, "sessions", "2026", "09", "28", "rollout-2026-09-28T09-00-00-saved.jsonl");
  fs.mkdirSync(path.dirname(rollout), { recursive: true });
  fs.writeFileSync(path.join(codexHome, "config.toml"),
    "model = \"gpt-6\"\n\n[mcp_servers.discord-other]\ncommand = \"node\"\nargs = [\"other.js\"]\n");
  fs.writeFileSync(rollout, `${JSON.stringify({ type: "session_meta", payload: { id: "saved" } })}\n`);
  fs.writeFileSync(path.join(workspace.repoDir, "registry.json"), JSON.stringify({
    discord_user_id: "owner", guild_id: "guild",
    pool: [{ id: "codex-bot", app_id: "codex-app", token: PROJECT_TOKEN,
      state_dir: path.join(workspace.homeDir, "codex-bot"), assigned_to: "codexy" }],
    projects: {
      codexy: { type: "codex", path: projectDir, bot_id: "codex-bot", channel_id: "codex-channel",
        screen_name: "codexy_session", ws_port: 18399, thread_ws_port: port, codex_home: codexHome,
        codex_model: "gpt-6-luna", codex_reasoning_effort: "high", codex_sandbox: sandbox,
        text_reply_fallback: true, guest_user_ids: ["guest"] },
    },
  }, null, 2), { mode: 0o600 });
  const rootState = path.join(workspace.homeDir, "root-discord");
  fs.mkdirSync(rootState, { recursive: true });
  fs.writeFileSync(path.join(rootState, ".env"), "DISCORD_BOT_TOKEN=fixture-root-token\n", { mode: 0o600 });
  const seed = readState(workspace.stateDir);
  // The supervisor (root) and the host (project bot) each hold a Gateway
  // connection and both receive every thread message.
  seed.fixtures.discord.fanOut = true;
  writeState(seed, workspace.stateDir);
  const clockFile = path.join(workspace.tmpDir, "thread-clock");
  fs.writeFileSync(clockFile, "2026-09-28T10:00:00Z\n");
  const env = bridgeChildEnv(workspace, { ROOT_DISCORD_STATE_DIR: rootState, CCDM_THREAD_NODE: process.execPath,
    CCDM_THREAD_CLOCK_FILE: clockFile, CCDM_REMINDER_PROJECT_ROOT: workspace.repoDir });
  return { codexHome, rollout, env };
}

async function status(workspace, env) {
  const result = await runScript(workspace, "scripts/thread-supervisor.py", { args: ["status"], env });
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function startRun(workspace, env) {
  return runScript(workspace, "scripts/thread-supervisor.py", { args: ["run"], env, timeoutMs: 30000 });
}

function hostLog(workspace) {
  const file = path.join(workspace.stateDir, `thread-host-${HOST_TMUX}.log`);
  const { discord, codex } = readState(workspace.stateDir).fixtures;
  const methods = codex.protocolEvents.map(event => event.message?.method ?? event.event);
  return `${fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "(no host log)"}\nposted: ${
    JSON.stringify(discord.messages.map(message => message.content))}\nCodex requests: ${JSON.stringify(methods)}`;
}

async function waitForThread(workspace, env, threadId, predicate, label, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let current;
  while (Date.now() < deadline) {
    current = await status(workspace, env);
    const thread = current.projects.codexy?.threads[threadId];
    if (thread && predicate(thread)) return thread;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for thread ${threadId} to be ${label}: ${JSON.stringify(current)}\n${hostLog(workspace)}`);
}

async function stopRun(workspace, env, running) {
  const current = await status(workspace, env);
  process.kill(-current.worker_pid, "SIGTERM");
  const result = await running;
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  return result;
}

function threadMessage(workspace, id, content, threadId = THREAD, author = { id: "owner", username: "owner" }) {
  injectDiscordMessage(workspace, { id, channelId: threadId, channelType: 11, parentId: "codex-channel", author, content });
}

// Both Gateway clients (the supervisor's and the host's) have received the message.
function deliveredToBoth(workspace, id) {
  return waitForState(workspace, state => state.fixtures.discord.injectedMessages
    .find(message => message.id === id)?.deliveredTo?.length === 2, 10000);
}

const clientRequests = (state, method) => state.fixtures.codex.protocolEvents
  .filter(event => event.event === "client-message" && event.message.method === method)
  .map(event => event.message.params);
const turnText = params => params.input.map(part => part.text ?? "").join("\n");
const isBootstrap = params => turnText(params).startsWith("You are communicating with the user via Discord");
const decoded = rows => rows.map(row => ({ ...row, emoji: decodeURIComponent(row.emoji) }));

test("an owner message in a bound Codex thread starts the project's thread host with a thread-scoped Discord server", async () => {
  const workspace = createWorkspace();
  const codex = await startFakeCodexServer(workspace, { homeMcpServers: ["discord-other"],
    forbidDiscordConfigWrites: true, threadIds: ["codex-thread-a"],
    turnsByThread: { "codex-thread-a": [{ delta: "On it: the redirect drops the query string." }] } });
  const context = setup(workspace, { port: codex.port });
  const running = startRun(workspace, context.env);
  await waitForState(workspace, state => state.fixtures.discord.ready.length === 1);
  injectDiscordThread(workspace, { id: THREAD, parentId: "codex-channel", name: "Login bug", ownerId: "owner",
    autoArchiveDuration: 10080 });
  threadMessage(workspace, "owner-1", "fix the login redirect");
  const thread = await waitForThread(workspace, context.env, THREAD, row => row.state === "live", "live");
  const state = await waitForState(workspace, next => next.fixtures.discord.sends
    .some(send => send.channelId === THREAD), 10000);

  // One host for the project, in its own tmux session, logged in as the project bot.
  assert.deepEqual(Object.keys(state.fixtures.tmux.sessions), [HOST_TMUX]);
  assert.doesNotMatch(JSON.stringify(state.fixtures.tmux.sessions[HOST_TMUX]), new RegExp(PROJECT_TOKEN));
  assert.deepEqual(state.fixtures.discord.logins.map(login => login.token), ["fixture-root-token", PROJECT_TOKEN]);
  // One app-server, for the project's Codex Home, on the thread host port.
  const [appServer] = (await waitForState(workspace, next => next.fixtures.codex.appServerInvocations.length === 1))
    .fixtures.codex.appServerInvocations;
  assert.equal(appServer.port, String(codex.port));
  assert.equal(thread.provider_conversation_id, "codex-thread-a");
  assert.equal(thread.runtime_tmux, HOST_TMUX);

  // The conversation's own Discord server is scoped to the thread; the home's
  // other Discord server is disabled for it.
  assert.equal(state.fixtures.codex.threadConfigs.length, 1);
  const [{ method, mcpServers, params }] = state.fixtures.codex.threadConfigs;
  assert.equal(method, "thread/start");
  assert.deepEqual(Object.keys(mcpServers).sort(), [`discord-${THREAD}`, "discord-other"]);
  const scoped = mcpServers[`discord-${THREAD}`];
  assert.equal(scoped.env.CHANNEL_ID, THREAD);
  assert.equal(scoped.env.BOT_TOKEN, PROJECT_TOKEN);
  assert.equal(scoped.default_tools_approval_mode, "approve");
  assert.deepEqual(mcpServers["discord-other"], { enabled: false });
  assert.equal(params.cwd, path.join(workspace.tmpDir, "codex project"));
  assert.equal(params.sandbox, "workspace-write");

  // The thread's model and effort reach the conversation and every turn.
  assert.equal(params.model, "gpt-6-luna");
  assert.equal(params.config.model_reasoning_effort, "high");
  const turns = clientRequests(state, "turn/start");
  assert.equal(turns.length, 2);
  assert.ok(isBootstrap(turns[0]), "the first turn is the no-action bootstrap");
  for (const turn of turns) {
    assert.equal(turn.threadId, "codex-thread-a");
    assert.equal(turn.model, "gpt-6-luna");
    assert.equal(turn.effort, "high");
  }
  assert.match(turnText(turns[1]), /fix the login redirect/);

  // The reply lands in the thread, and 👀 marks the trigger only while booting.
  assert.deepEqual(state.fixtures.discord.sends.filter(send => send.channelId === THREAD).map(send => send.content),
    ["On it: the redirect drops the query string."]);
  assert.deepEqual(decoded(state.fixtures.discord.reactions), [{ authorization: `Bot ${PROJECT_TOKEN}`,
    channelId: THREAD, emoji: "👀", messageId: "owner-1" }]);
  await waitForState(workspace, next => next.fixtures.discord.reactionDeletes.length === 1);

  // No Discord credential reaches the home, and the host never renames the bot.
  assert.equal(state.fixtures.codex.violations, undefined);
  assert.equal(clientRequests(state, "config/value/write").length, 0);
  for (const file of [path.join(context.codexHome, "config.toml"), context.rollout]) {
    assert.doesNotMatch(fs.readFileSync(file, "utf8"), new RegExp(PROJECT_TOKEN), file);
  }
  assert.deepEqual(readState(workspace.stateDir).fixtures.discord.nicknamePatches, []);
  await stopRun(workspace, context.env, running);
});

test("two Codex threads get their own thread-scoped Discord servers, and full access sets no approval mode", async () => {
  const workspace = createWorkspace();
  const codex = await startFakeCodexServer(workspace, { homeMcpServers: ["discord-other"],
    forbidDiscordConfigWrites: true, threadIds: ["codex-thread-a", "codex-thread-b"],
    turnsByThread: { "codex-thread-a": [{ delta: "Reply in A" }], "codex-thread-b": [{ delta: "Reply in B" }] } });
  const context = setup(workspace, { port: codex.port, sandbox: "danger-full-access" });
  const running = startRun(workspace, context.env);
  await waitForState(workspace, state => state.fixtures.discord.ready.length === 1);
  injectDiscordThread(workspace, { id: THREAD, parentId: "codex-channel", name: "Login bug", ownerId: "owner" });
  injectDiscordThread(workspace, { id: SIBLING, parentId: "codex-channel", name: "Flaky test", ownerId: "guest" });
  threadMessage(workspace, "owner-1", "fix the login redirect");
  await waitForThread(workspace, context.env, THREAD, row => row.state === "live", "live");
  threadMessage(workspace, "guest-1", "the checkout test is flaky", SIBLING, { id: "guest", username: "guest" });
  await waitForThread(workspace, context.env, SIBLING, row => row.state === "live", "live");
  const state = await waitForState(workspace, next => next.fixtures.discord.sends.length === 2, 10000);

  const configs = state.fixtures.codex.threadConfigs;
  assert.deepEqual(configs.map(config => config.method), ["thread/start", "thread/start"]);
  assert.deepEqual(configs.map((config, index) => config.mcpServers[`discord-${[THREAD, SIBLING][index]}`].env.CHANNEL_ID),
    [THREAD, SIBLING]);
  for (const config of configs) {
    assert.deepEqual(config.mcpServers["discord-other"], { enabled: false });
    assert.equal(config.params.sandbox, "danger-full-access");
    for (const server of Object.values(config.mcpServers)) {
      assert.equal("default_tools_approval_mode" in server, false);
    }
  }
  // One host and one app-server serve both threads; each reply lands in its own thread.
  assert.deepEqual(Object.keys(state.fixtures.tmux.sessions), [HOST_TMUX]);
  assert.equal(state.fixtures.discord.logins.filter(login => login.token === PROJECT_TOKEN).length, 1);
  assert.deepEqual(state.fixtures.discord.sends.map(send => [send.channelId, send.content]).sort(),
    [[THREAD, "Reply in A"], [SIBLING, "Reply in B"]]);
  assert.equal(state.fixtures.codex.violations, undefined);
  await stopRun(workspace, context.env, running);
});

test("messages sent while a Codex thread boots reach its first real turn exactly once", async () => {
  const workspace = createWorkspace();
  const codex = await startFakeCodexServer(workspace, { homeMcpServers: ["discord-other"],
    threadIds: ["codex-thread-b", "codex-thread-a"],
    bootstrapPlans: { "codex-thread-a": { turnId: "bootstrap-a", waitForRelease: true } },
    turnsByThread: { "codex-thread-b": [{ delta: "Sibling started." }], "codex-thread-a": [{ delta: "Looking at all three." }] } });
  const context = setup(workspace, { port: codex.port });
  const running = startRun(workspace, context.env);
  await waitForState(workspace, state => state.fixtures.discord.ready.length === 1);
  // A live sibling keeps the host's Gateway connected, so the host also sees
  // the trigger and every message the supervisor holds for the handoff.
  injectDiscordThread(workspace, { id: SIBLING, parentId: "codex-channel", name: "Flaky test", ownerId: "owner" });
  threadMessage(workspace, "sibling-1", "the checkout test is flaky", SIBLING);
  await waitForThread(workspace, context.env, SIBLING, row => row.state === "live", "live");
  injectDiscordThread(workspace, { id: THREAD, parentId: "codex-channel", name: "Login bug", ownerId: "owner" });
  threadMessage(workspace, "owner-1", "first: fix the login redirect");
  await deliveredToBoth(workspace, "owner-1");
  await waitForState(workspace, state => clientRequests(state, "turn/start")
    .some(turn => turn.threadId === "codex-thread-a" && isBootstrap(turn)), 15000);
  threadMessage(workspace, "guest-1", "guest: it also breaks on mobile", THREAD, { id: "guest", username: "guest" });
  threadMessage(workspace, "owner-2", "second: and keep the query string");
  await deliveredToBoth(workspace, "guest-1");
  await deliveredToBoth(workspace, "owner-2");
  assert.equal((await status(workspace, context.env)).projects.codexy.threads[THREAD].state, "booting");
  codex.releaseTurn("bootstrap-a");
  await waitForThread(workspace, context.env, THREAD, row => row.state === "live", "live");
  await waitForState(workspace, state => state.fixtures.discord.sends.some(send => send.channelId === THREAD), 10000);
  // Nothing sent during boot turns into a turn of its own later.
  await new Promise(resolve => setTimeout(resolve, 500));

  const state = readState(workspace.stateDir);
  const turns = clientRequests(state, "turn/start").filter(turn => turn.threadId === "codex-thread-a");
  assert.equal(turns.length, 2);
  const first = turnText(turns[1]);
  for (const text of ["Login bug", "first: fix the login redirect", "guest: it also breaks on mobile",
    "second: and keep the query string"]) {
    assert.equal(first.split(text).length - 1, 1, `${text} appears once:\n${first}`);
  }
  assert.ok(first.indexOf("first:") < first.indexOf("guest:"));
  assert.ok(first.indexOf("guest:") < first.indexOf("second:"));
  const threadReactions = rows => decoded(rows).filter(row => row.channelId === THREAD)
    .map(row => [row.emoji, row.messageId]);
  assert.deepEqual(threadReactions(state.fixtures.discord.reactions), [["👀", "owner-1"]]);
  assert.deepEqual(threadReactions(state.fixtures.discord.reactionDeletes), [["👀", "owner-1"]]);
  await stopRun(workspace, context.env, running);
});

test("the thread host ignores strangers and threads it does not host", async () => {
  const workspace = createWorkspace();
  const codex = await startFakeCodexServer(workspace, { homeMcpServers: ["discord-other"], threadIds: ["codex-thread-a"],
    turnsByThread: { "codex-thread-a": [{ delta: "Started." }, { delta: "Kept the query string." }] } });
  const context = setup(workspace, { port: codex.port });
  const running = startRun(workspace, context.env);
  await waitForState(workspace, state => state.fixtures.discord.ready.length === 1);
  injectDiscordThread(workspace, { id: THREAD, parentId: "codex-channel", name: "Login bug", ownerId: "owner" });
  // A stranger's thread under the same channel is never bound, so never hosted.
  injectDiscordThread(workspace, { id: SIBLING, parentId: "codex-channel", name: "Mine", ownerId: "stranger" });
  threadMessage(workspace, "owner-1", "fix the login redirect");
  await waitForThread(workspace, context.env, THREAD, row => row.state === "live", "live");
  await waitForState(workspace, state => state.fixtures.discord.sends.length === 1, 10000);
  threadMessage(workspace, "stranger-1", "stranger: let me in", THREAD, { id: "stranger", username: "stranger" });
  threadMessage(workspace, "owner-elsewhere", "owner: in an unhosted thread", SIBLING);
  await deliveredToBoth(workspace, "stranger-1");
  await deliveredToBoth(workspace, "owner-elsewhere");
  threadMessage(workspace, "owner-2", "keep the query string");
  const state = await waitForState(workspace, next => next.fixtures.discord.sends.length === 2, 10000);

  const texts = clientRequests(state, "turn/start").map(turnText);
  assert.equal(texts.length, 3);
  assert.equal(texts[2], "keep the query string");
  assert.ok(texts.every(text => !text.includes("let me in") && !text.includes("unhosted thread")), texts.join("\n---\n"));
  assert.equal(state.fixtures.codex.threadConfigs.length, 1);
  assert.equal((await status(workspace, context.env)).projects.codexy.threads[SIBLING], undefined);
  await stopRun(workspace, context.env, running);
});
