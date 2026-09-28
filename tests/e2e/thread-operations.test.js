import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { createWorkspace, runScript } from "./support/runner.js";
import { bridgeChildEnv, injectDiscordMessage, injectDiscordThread, startFakeCodexServer, waitForState }
  from "./support/bridge.js";
import { readState, seedTmuxSession, writeState } from "./support/state.js";
import { cleanup } from "./support/teardown.js";

test.afterEach(async () => cleanup());

// Discord snowflakes; a Claude thread's tmux name ends in the last six digits.
const THREAD = "1500000000000123456";
const SIBLING = "1500000000000654321";
const CODEX_THREAD = "1500000000000777777";
const THREAD_TMUX = "demo_session-t-123456";
const SIBLING_TMUX = "demo_session-t-654321";
const HOST_TMUX = "codexy_session-threads";
const READY_SCREEN = "Listening for channel messages from: server:discord\n";
const link = threadId => `https://discord.com/channels/guild/${threadId}`;

// A Claude project (`demo`) with a running Channel Conversation in tmux
// `demo_session`, and a Codex project (`codexy`) with one in `codexy_session`.
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
    discord_user_id: "owner", guild_id: "guild", root_bot_app_id: "root-app",
    codex_accounts: { work: codexHome }, default_codex_account: "work",
    pool: [
      { id: "demo-bot", app_id: "demo-app", token: "demo-token", state_dir: demoState, assigned_to: "demo" },
      { id: "codexy-bot", app_id: "codexy-app", token: "codexy-token", state_dir: codexyState, assigned_to: "codexy" },
    ],
    projects: {
      demo: { type: "claude", path: projectDir, bot_id: "demo-bot", channel_id: "channel", screen_name: "demo_session",
        model: "claude-opus-5-5", claude_effort: "high" },
      codexy: { type: "codex", path: projectDir, bot_id: "codexy-bot", channel_id: "codex-channel",
        screen_name: "codexy_session", ws_port: 18399, thread_ws_port: port, codex_model: "gpt-6",
        codex_reasoning_effort: "high", text_reply_fallback: true },
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
  return { env, clockFile };
}

async function status(workspace, env) {
  const result = await runScript(workspace, "scripts/thread-supervisor.py", { args: ["status"], env });
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

async function startRun(workspace, env) {
  const exited = runScript(workspace, "scripts/thread-supervisor.py", { args: ["run"], env, timeoutMs: 60000 });
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

const threadRow = async (workspace, env, threadId) =>
  Object.values((await status(workspace, env)).projects).map(project => project.threads[threadId]).find(Boolean);

function threads(workspace, env, args) {
  return runScript(workspace, "scripts/threads.sh", { args, env, timeoutMs: 30000 });
}

async function threadsOk(workspace, env, args) {
  const result = await threads(workspace, env, args);
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  return result;
}

function stopSession(workspace, env, args) {
  return runScript(workspace, "scripts/stop-session.sh", { args, env, timeoutMs: 30000 });
}

const OWNER = { id: "owner", username: "owner" };

async function liveThread(workspace, env, threadId, name, { parentId = "channel", messageId = `m-${threadId}` } = {}) {
  injectDiscordThread(workspace, { id: threadId, parentId, name, ownerId: "owner", autoArchiveDuration: 10080 });
  injectDiscordMessage(workspace, { id: messageId, channelId: threadId, channelType: 11, parentId, author: OWNER,
    content: "fix the login redirect" });
  return waitForThread(workspace, env, threadId, row => row.state === "live" && !row.turn_running, "live");
}

const posts = (state, threadId) => (state.fixtures.discord.messages ?? []).filter(posted => posted.channelId === threadId);
const archives = state => state.fixtures.discord.threadPatches.filter(patch => patch.body.archived !== undefined)
  .map(patch => [patch.authorization, patch.threadId, patch.body]);
const clientRequests = (state, method) => state.fixtures.codex.protocolEvents
  .filter(event => event.event === "client-message" && event.message.method === method)
  .map(event => event.message.params);
const alive = pid => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function waitForExit(pid, label, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (alive(pid)) {
    if (Date.now() > deadline) throw new Error(`${label} (pid ${pid}) is still running`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

// `threads.sh list` output as rows of columns separated by two or more spaces.
const table = stdout => stdout.trimEnd().split("\n").map(line => line.trim().split(/\s{2,}/));

test("threads.sh list shows each thread's name, provider/model, state with stop reason, and idle time", async () => {
  const workspace = createWorkspace();
  const codex = await startFakeCodexServer(workspace, { threadIds: ["codex-thread-a"],
    turnsByThread: { "codex-thread-a": [{ delta: "On it." }] } });
  const context = setup(workspace, { port: codex.port });
  const running = await startRun(workspace, context.env);
  await liveThread(workspace, context.env, THREAD, "Login bug");
  const created = await threadsOk(workspace, context.env, ["create", "demo", "notes"]);
  const notes = JSON.parse(created.stdout).thread_id;
  await threadsOk(workspace, context.env, ["stop", "demo", "notes"]);
  await liveThread(workspace, context.env, CODEX_THREAD, "review", { parentId: "codex-channel" });

  // Every thread was last active at 10:00 on the supervisor clock.
  fs.writeFileSync(context.clockFile, "2026-09-28T10:45:00Z\n");
  const demo = await threadsOk(workspace, context.env, ["list", "demo"]);
  assert.deepEqual(table(demo.stdout), [
    ["NAME", "THREAD", "PROVIDER/MODEL", "STATE", "IDLE"],
    ["Login bug", THREAD, "claude/claude-opus-5-5", "live", "45m"],
    ["notes", notes, "claude/claude-opus-5-5", "stopped/operator", "45m"],
  ]);
  fs.writeFileSync(context.clockFile, "2026-09-28T12:05:00Z\n");
  const codexy = await threadsOk(workspace, context.env, ["list", "codexy"]);
  assert.deepEqual(table(codexy.stdout), [
    ["NAME", "THREAD", "PROVIDER/MODEL", "STATE", "IDLE"],
    ["review", CODEX_THREAD, "codex/gpt-6", "live", "2h05m"],
  ]);

  const unknown = await threads(workspace, context.env, ["list", "nowhere"]);
  assert.notEqual(unknown.exitCode, 0);
  assert.match(unknown.stderr, /no registered project named nowhere/);
  await stopRun(workspace, context.env, running);
});

test("threads.sh stop, restart, and close act on one Claude thread by name", async () => {
  const workspace = createWorkspace();
  const context = setup(workspace);
  const running = await startRun(workspace, context.env);
  const first = await liveThread(workspace, context.env, THREAD, "Login bug");
  await liveThread(workspace, context.env, SIBLING, "Other task");
  let state = readState(workspace.stateDir);
  const siblingPid = state.fixtures.tmux.sessions[SIBLING_TMUX].pid;
  const threadPid = state.fixtures.tmux.sessions[THREAD_TMUX].pid;

  await threadsOk(workspace, context.env, ["stop", "demo", "Login bug"]);
  const stopped = await threadRow(workspace, context.env, THREAD);
  assert.equal(stopped.state, "stopped");
  assert.equal(stopped.stop_reason, "operator");
  assert.equal(stopped.provider_conversation_id, first.provider_conversation_id);
  await waitForExit(threadPid, "the thread's Claude session");
  state = readState(workspace.stateDir);
  assert.equal(state.fixtures.tmux.sessions[THREAD_TMUX], undefined);
  assert.deepEqual(posts(state, THREAD).map(posted => [posted.authorization, posted.content]),
    [["Bot demo-token", "Stopped by root; the owner's next message resumes this thread."]]);

  // Without a project, the name is looked up across every project.
  await threadsOk(workspace, context.env, ["restart", "Login bug"]);
  const resumed = await waitForThread(workspace, context.env, THREAD, row => row.state === "live", "live again");
  assert.equal(resumed.provider_conversation_id, first.provider_conversation_id);
  state = readState(workspace.stateDir);
  const relaunch = state.fixtures.claude.invocations.at(-1);
  assert.equal(relaunch.args[relaunch.args.indexOf("--resume") + 1], `'${first.provider_conversation_id}'`);
  const notice = posts(state, THREAD).at(-1);
  assert.equal(notice.content, "Restarting this thread's session for root; the conversation resumes.");
  // 👀 marks the notice while the session boots.
  assert.deepEqual(state.fixtures.discord.reactions.filter(row => row.channelId === THREAD)
    .map(row => [decodeURIComponent(row.emoji), row.messageId]).at(-1), ["👀", notice.id]);

  await threadsOk(workspace, context.env, ["close", "demo", "Login bug"]);
  const closed = await waitForThread(workspace, context.env, THREAD, row => row.state === "closed", "closed");
  assert.equal(closed.stop_reason, undefined);
  state = await waitForState(workspace, next => !next.fixtures.tmux.sessions[THREAD_TMUX]);
  assert.deepEqual(archives(state), [["Bot demo-token", THREAD, { archived: true }]]);

  // The sibling thread and the Channel Conversation are untouched.
  assert.equal(state.fixtures.tmux.sessions[SIBLING_TMUX].pid, siblingPid);
  assert.equal(posts(state, SIBLING).length, 0);
  assert.ok(!state.fixtures.tmux.sessions.demo_session.killAttempts);
  assert.equal((await threadRow(workspace, context.env, SIBLING)).state, "live");
  await stopRun(workspace, context.env, running);
});

test("threads.sh restart, stop, and close act on a Codex thread by link, and close works on a stopped thread", async () => {
  const workspace = createWorkspace();
  const codex = await startFakeCodexServer(workspace, { threadIds: ["codex-thread-a"],
    turnsByThread: { "codex-thread-a": [{ delta: "On it." }] } });
  const context = setup(workspace, { port: codex.port });
  const running = await startRun(workspace, context.env);
  await liveThread(workspace, context.env, CODEX_THREAD, "review", { parentId: "codex-channel" });
  let state = readState(workspace.stateDir);
  const [host] = state.fixtures.codex.threadHostInvocations;

  await threadsOk(workspace, context.env, ["restart", link(CODEX_THREAD)]);
  state = await waitForState(workspace, next => clientRequests(next, "thread/resume").length === 1, 10000);
  assert.equal(clientRequests(state, "thread/resume")[0].threadId, "codex-thread-a");
  await waitForThread(workspace, context.env, CODEX_THREAD, row => row.state === "live", "live again");
  const unloaded = clientRequests(readState(workspace.stateDir), "thread/unsubscribe").length;

  await threadsOk(workspace, context.env, ["stop", link(CODEX_THREAD)]);
  const stopped = await threadRow(workspace, context.env, CODEX_THREAD);
  assert.equal(stopped.state, "stopped");
  assert.equal(stopped.stop_reason, "operator");
  // It was the only live Codex thread: the host exits.
  await waitForExit(host.pid, "the Codex thread host");
  assert.deepEqual(clientRequests(readState(workspace.stateDir), "thread/unsubscribe").slice(unloaded),
    [{ threadId: "codex-thread-a" }]);

  await threadsOk(workspace, context.env, ["close", link(CODEX_THREAD)]);
  const closed = await waitForThread(workspace, context.env, CODEX_THREAD, row => row.state === "closed", "closed");
  assert.equal(closed.stop_reason, undefined);
  state = readState(workspace.stateDir);
  assert.deepEqual(archives(state), [["Bot codexy-token", CODEX_THREAD, { archived: true }]]);
  assert.equal(state.fixtures.codex.threadHostInvocations.length, 2);
  await stopRun(workspace, context.env, running);
});

test("threads.sh fails on an ambiguous or unknown thread, and without a running supervisor", async () => {
  const workspace = createWorkspace();
  const context = setup(workspace);
  const notRunning = await threads(workspace, context.env, ["stop", "demo", "review"]);
  assert.notEqual(notRunning.exitCode, 0);
  assert.match(notRunning.stderr, /the thread supervisor is not running/);

  const running = await startRun(workspace, context.env);
  const demoReview = JSON.parse((await threadsOk(workspace, context.env, ["create", "demo", "review"])).stdout).thread_id;
  const codexyReview = JSON.parse((await threadsOk(workspace, context.env, ["create", "codexy", "review"])).stdout).thread_id;

  const ambiguous = await threads(workspace, context.env, ["stop", "review"]);
  assert.notEqual(ambiguous.exitCode, 0);
  const lines = ambiguous.stderr.trim().split("\n");
  assert.equal(lines.length, 1, ambiguous.stderr);
  assert.match(lines[0], /^threads\.sh stop: thread name review is ambiguous: /);
  assert.ok(lines[0].includes(`review in demo (${demoReview})`), lines[0]);
  assert.ok(lines[0].includes(`review in codexy (${codexyReview})`), lines[0]);
  const unknown = await threads(workspace, context.env, ["close", "demo", "nothing-here"]);
  assert.notEqual(unknown.exitCode, 0);
  assert.match(unknown.stderr, /^threads\.sh close: no thread named nothing-here in demo$/m);
  const unbound = await threads(workspace, context.env, ["close", link("1500000000000999999")]);
  assert.notEqual(unbound.exitCode, 0);
  assert.match(unbound.stderr, /no bound thread 1500000000000999999/);
  let current = await status(workspace, context.env);
  assert.equal(current.projects.demo.threads[demoReview].state, "registered");
  assert.equal(current.projects.codexy.threads[codexyReview].state, "registered");
  assert.deepEqual(readState(workspace.stateDir).fixtures.discord.threadPatches
    .filter(patch => patch.body.archived !== undefined), []);

  // The project narrows the name to one thread.
  await threadsOk(workspace, context.env, ["stop", "codexy", "review"]);
  current = await status(workspace, context.env);
  assert.equal(current.projects.codexy.threads[codexyReview].state, "stopped");
  assert.equal(current.projects.demo.threads[demoReview].state, "registered");
  await stopRun(workspace, context.env, running);
});

test("stop-session.sh stops only the Channel Conversation, --threads only the threads, and --all both", async () => {
  const workspace = createWorkspace();
  const context = setup(workspace);
  const running = await startRun(workspace, context.env);
  await liveThread(workspace, context.env, THREAD, "Login bug");
  const threadPid = readState(workspace.stateDir).fixtures.tmux.sessions[THREAD_TMUX].pid;

  const channel = await stopSession(workspace, context.env, ["demo"]);
  assert.equal(channel.exitCode, 0, channel.stderr || channel.stdout);
  let state = readState(workspace.stateDir);
  assert.equal(state.fixtures.tmux.sessions.demo_session, undefined);
  assert.equal(state.fixtures.tmux.sessions[THREAD_TMUX].pid, threadPid);
  assert.ok(alive(threadPid));
  assert.equal((await threadRow(workspace, context.env, THREAD)).state, "live");

  seedTmuxSession("demo_session", { paneOutput: "Listening for channel messages\n" }, { stateDir: workspace.stateDir });
  const onlyThreads = await stopSession(workspace, context.env, ["demo", "--threads"]);
  assert.equal(onlyThreads.exitCode, 0, onlyThreads.stderr || onlyThreads.stdout);
  await waitForExit(threadPid, "the thread's Claude session");
  state = readState(workspace.stateDir);
  assert.equal(state.fixtures.tmux.sessions[THREAD_TMUX], undefined);
  assert.ok(state.fixtures.tmux.sessions.demo_session);
  assert.ok(!state.fixtures.tmux.sessions.demo_session.killAttempts);
  const stopped = await threadRow(workspace, context.env, THREAD);
  assert.equal(stopped.state, "stopped");
  assert.equal(stopped.stop_reason, "operator");

  // The owner's message resumes the thread; --all then stops it and the channel.
  injectDiscordMessage(workspace, { id: "owner-2", channelId: THREAD, channelType: 11, parentId: "channel",
    author: OWNER, content: "back to it" });
  await waitForThread(workspace, context.env, THREAD, row => row.state === "live", "live again");
  const resumedPid = readState(workspace.stateDir).fixtures.tmux.sessions[THREAD_TMUX].pid;
  const all = await stopSession(workspace, context.env, ["demo", "--all"]);
  assert.equal(all.exitCode, 0, all.stderr || all.stdout);
  await waitForExit(resumedPid, "the resumed thread's Claude session");
  state = readState(workspace.stateDir);
  assert.equal(state.fixtures.tmux.sessions.demo_session, undefined);
  assert.equal(state.fixtures.tmux.sessions[THREAD_TMUX], undefined);
  assert.equal((await threadRow(workspace, context.env, THREAD)).stop_reason, "operator");
  await stopRun(workspace, context.env, running);
});

test("stop-session.sh --threads stops a Codex project's thread host and leaves its channel bridge", async () => {
  const workspace = createWorkspace();
  const codex = await startFakeCodexServer(workspace, { threadIds: ["codex-thread-a"],
    turnsByThread: { "codex-thread-a": [{ delta: "On it." }] } });
  const context = setup(workspace, { port: codex.port });
  seedTmuxSession("codexy_session", { paneOutput: "Codex-Discord bridge running\n" }, { stateDir: workspace.stateDir });
  const running = await startRun(workspace, context.env);
  await liveThread(workspace, context.env, CODEX_THREAD, "review", { parentId: "codex-channel" });
  const [host] = readState(workspace.stateDir).fixtures.codex.threadHostInvocations;

  const channel = await stopSession(workspace, context.env, ["codexy"]);
  assert.equal(channel.exitCode, 0, channel.stderr || channel.stdout);
  let state = readState(workspace.stateDir);
  assert.equal(state.fixtures.tmux.sessions.codexy_session, undefined);
  assert.ok(state.fixtures.tmux.sessions[HOST_TMUX]);
  assert.ok(alive(host.pid));

  seedTmuxSession("codexy_session", { paneOutput: "Codex-Discord bridge running\n" }, { stateDir: workspace.stateDir });
  const onlyThreads = await stopSession(workspace, context.env, ["codexy", "--threads"]);
  assert.equal(onlyThreads.exitCode, 0, onlyThreads.stderr || onlyThreads.stdout);
  await waitForExit(host.pid, "the Codex thread host");
  state = readState(workspace.stateDir);
  assert.equal(state.fixtures.tmux.sessions[HOST_TMUX], undefined);
  assert.ok(state.fixtures.tmux.sessions.codexy_session);
  assert.ok(!state.fixtures.tmux.sessions.codexy_session.killAttempts);
  const stopped = await threadRow(workspace, context.env, CODEX_THREAD);
  assert.equal(stopped.state, "stopped");
  assert.equal(stopped.stop_reason, "operator");
  await stopRun(workspace, context.env, running);
});
