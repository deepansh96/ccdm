import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { createWorkspace, runNodeEntrypoint, runScript } from "./support/runner.js";
import { bridgeChildEnv, injectDiscordMessage, injectDiscordThread, startFakeCodexServer, waitForState }
  from "./support/bridge.js";
import { readState, writeState } from "./support/state.js";
import { cleanup } from "./support/teardown.js";

test.afterEach(async () => cleanup());

// Discord snowflakes; a Claude thread's tmux name ends in the last six digits.
const THREAD = "1500000000000123456";
const SIBLING = "1500000000000654321";
const CODEX_THREAD = "1500000000000777777";
const THREAD_TMUX = "demo_session-t-123456";
const HOST_TMUX = "codexy_session-threads";
const GUEST = "222222222222222222";
const READY_SCREEN = "Listening for channel messages from: server:discord\n";
const OWNER = { id: "owner", username: "owner" };

// A Claude project (`demo`) and a Codex project (`codexy`), each with its own
// bot, plus an unassigned pool bot per project for reassignment.
function setup(workspace, { port = 18999 } = {}) {
  const projectDir = path.join(workspace.tmpDir, "project");
  fs.mkdirSync(projectDir, { recursive: true });
  const codexHome = path.join(workspace.homeDir, ".codex-work");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(codexHome, "config.toml"), "model = \"gpt-6\"\n");
  const plugin = path.join(workspace.homeDir, ".claude", "plugins", "cache", "claude-plugins-official", "discord", "0.0.4");
  fs.mkdirSync(plugin, { recursive: true });
  fs.writeFileSync(path.join(plugin, "server.ts"), "// fixture official plugin\n");
  const states = {};
  for (const name of ["demo", "demo2", "codexy", "codexy2"]) {
    states[name] = path.join(workspace.homeDir, ".claude", "channels", `discord-${name}`);
    fs.mkdirSync(states[name], { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(states[name], ".env"), `DISCORD_BOT_TOKEN=${name}-token\n`, { mode: 0o600 });
  }
  writeRegistry(workspace, {
    discord_user_id: "owner", guild_id: "guild", root_bot_app_id: "root-app",
    codex_accounts: { work: codexHome }, default_codex_account: "work",
    pool: [
      { id: "demo-bot", app_id: "demo-app", token: "demo-token", state_dir: states.demo, assigned_to: "demo" },
      { id: "demo2-bot", app_id: "demo2-app", token: "demo2-token", state_dir: states.demo2, assigned_to: null },
      { id: "codexy-bot", app_id: "codexy-app", token: "codexy-token", state_dir: states.codexy, assigned_to: "codexy" },
      { id: "codexy2-bot", app_id: "codexy2-app", token: "codexy2-token", state_dir: states.codexy2, assigned_to: null },
    ],
    projects: {
      demo: { type: "claude", path: projectDir, bot_id: "demo-bot", channel_id: "channel", screen_name: "demo_session",
        model: "claude-opus-5-5", claude_effort: "high" },
      codexy: { type: "codex", path: projectDir, bot_id: "codexy-bot", channel_id: "codex-channel",
        screen_name: "codexy_session", ws_port: 18399, thread_ws_port: port, codex_model: "gpt-6",
        codex_reasoning_effort: "high", text_reply_fallback: true },
    },
  });
  const rootState = path.join(workspace.homeDir, "root-discord");
  fs.mkdirSync(rootState, { recursive: true });
  fs.writeFileSync(path.join(rootState, ".env"), "DISCORD_BOT_TOKEN=fixture-root-token\n", { mode: 0o600 });
  const seed = readState(workspace.stateDir);
  // The supervisor (root) and a thread host (project bot) each receive every event.
  seed.fixtures.discord.fanOut = true;
  seed.fixtures.tmux.claudeBootScreens = [READY_SCREEN];
  writeState(seed, workspace.stateDir);
  const clockFile = path.join(workspace.tmpDir, "thread-clock");
  fs.writeFileSync(clockFile, "2026-09-28T10:00:00Z\n");
  const env = bridgeChildEnv(workspace, { ROOT_DISCORD_STATE_DIR: rootState, CCDM_THREAD_NODE: process.execPath,
    CCDM_THREAD_CLOCK_FILE: clockFile, CCDM_FIXTURE_CLAUDE_VERSION: "2.1.281 (Claude Code)",
    CCDM_REMINDER_PROJECT_ROOT: workspace.repoDir });
  return { env, states, threadDir: (bot, threadId) => path.join(states[bot], "threads", threadId) };
}

const registryPath = workspace => path.join(workspace.repoDir, "registry.json");
const readRegistry = workspace => JSON.parse(fs.readFileSync(registryPath(workspace), "utf8"));
function writeRegistry(workspace, registry) {
  fs.writeFileSync(registryPath(workspace), JSON.stringify(registry, null, 2), { mode: 0o600 });
}

// What root's registration workflow does to the registry before running the hook.
function reassign(workspace, project, bot) {
  const registry = readRegistry(workspace);
  for (const entry of registry.pool) {
    if (entry.assigned_to === project) entry.assigned_to = null;
    if (entry.id === bot) entry.assigned_to = project;
  }
  registry.projects[project].bot_id = bot;
  writeRegistry(workspace, registry);
}

function deregister(workspace, project) {
  const registry = readRegistry(workspace);
  for (const entry of registry.pool) if (entry.assigned_to === project) entry.assigned_to = null;
  delete registry.projects[project];
  writeRegistry(workspace, registry);
}

async function status(workspace, env) {
  const result = await runScript(workspace, "scripts/thread-supervisor.py", { args: ["status"], env });
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

async function startRun(workspace, env) {
  const exited = runScript(workspace, "scripts/thread-supervisor.py", { args: ["run"], env, timeoutMs: 90000 });
  await waitForState(workspace, state => state.fixtures.discord.ready.length === 1);
  return { exited };
}

async function stopRun(workspace, env, running) {
  const current = await status(workspace, env);
  process.kill(-current.worker_pid, "SIGTERM");
  const result = await running.exited;
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
}

async function threadRow(workspace, env, threadId) {
  const current = await status(workspace, env);
  return Object.values(current.projects).map(project => project.threads[threadId]).find(Boolean);
}

async function waitForThread(workspace, env, threadId, predicate, label, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let row;
  while (Date.now() < deadline) {
    row = await threadRow(workspace, env, threadId);
    if (row && predicate(row)) return row;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for thread ${threadId} to be ${label}: ${JSON.stringify(row)}`);
}

async function liveThread(workspace, env, threadId, name, { parentId = "channel" } = {}) {
  injectDiscordThread(workspace, { id: threadId, parentId, name, ownerId: "owner", autoArchiveDuration: 10080 });
  injectDiscordMessage(workspace, { id: `m-${threadId}`, channelId: threadId, channelType: 11, parentId, author: OWNER,
    content: "fix the login redirect" });
  return waitForThread(workspace, env, threadId, row => row.state === "live" && !row.turn_running, "live");
}

async function projectChanged(workspace, env, project) {
  const result = await runScript(workspace, "scripts/thread-supervisor.py", {
    args: ["project-changed", "--project", project], env, timeoutMs: 60000 });
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

async function threadsOk(workspace, env, args) {
  const result = await runScript(workspace, "scripts/threads.sh", { args, env, timeoutMs: 30000 });
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  return result;
}

async function guestAccess(workspace, env, args) {
  const result = await runNodeEntrypoint(workspace, "scripts/guest-access.js", { args, env, timeoutMs: 60000 });
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  return result;
}

const posts = (state, threadId) => (state.fixtures.discord.messages ?? []).filter(posted => posted.channelId === threadId);
const clientRequests = (state, method) => state.fixtures.codex.protocolEvents
  .filter(event => event.event === "client-message" && event.message.method === method)
  .map(event => event.message.params);
const resumedWith = invocation => invocation.args[invocation.args.indexOf("--resume") + 1];
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

test("project-changed after deregistration stops every thread session and closes every thread", async () => {
  const workspace = createWorkspace();
  const codex = await startFakeCodexServer(workspace, { threadIds: ["codex-thread-a"],
    turnsByThread: { "codex-thread-a": [{ delta: "On it." }] } });
  const context = setup(workspace, { port: codex.port });
  const running = await startRun(workspace, context.env);
  await liveThread(workspace, context.env, THREAD, "Login bug");
  await liveThread(workspace, context.env, SIBLING, "Other task");
  await threadsOk(workspace, context.env, ["stop", "demo", "Other task"]);
  await liveThread(workspace, context.env, CODEX_THREAD, "review", { parentId: "codex-channel" });
  let state = readState(workspace.stateDir);
  const threadPid = state.fixtures.tmux.sessions[THREAD_TMUX].pid;
  const [host] = state.fixtures.codex.threadHostInvocations;

  deregister(workspace, "demo");
  const demo = await projectChanged(workspace, context.env, "demo");
  assert.deepEqual(demo, { status: "ok", project: "demo", result: "deregistered", closed: [THREAD, SIBLING].sort() });
  for (const threadId of [THREAD, SIBLING]) {
    const row = await threadRow(workspace, context.env, threadId);
    assert.equal(row.state, "closed");
    assert.equal(row.stop_reason, undefined);
  }
  await waitForExit(threadPid, "the deregistered project's Claude thread session");
  state = readState(workspace.stateDir);
  assert.equal(state.fixtures.tmux.sessions[THREAD_TMUX], undefined);
  assert.equal(fs.existsSync(context.threadDir("demo", THREAD)), false);
  // Another project's threads are untouched.
  assert.equal((await threadRow(workspace, context.env, CODEX_THREAD)).state, "live");
  assert.ok(alive(host.pid));

  deregister(workspace, "codexy");
  const codexy = await projectChanged(workspace, context.env, "codexy");
  assert.deepEqual(codexy, { status: "ok", project: "codexy", result: "deregistered", closed: [CODEX_THREAD] });
  assert.equal((await threadRow(workspace, context.env, CODEX_THREAD)).state, "closed");
  await waitForExit(host.pid, "the deregistered project's Codex thread host");
  assert.equal(readState(workspace.stateDir).fixtures.tmux.sessions[HOST_TMUX], undefined);
  await stopRun(workspace, context.env, running);
});

test("project-changed after a bot reassignment relaunches live Claude threads under the new bot with resume", async () => {
  const workspace = createWorkspace();
  const context = setup(workspace);
  const running = await startRun(workspace, context.env);
  const first = await liveThread(workspace, context.env, THREAD, "Login bug");
  await liveThread(workspace, context.env, SIBLING, "Other task");
  await threadsOk(workspace, context.env, ["stop", "demo", "Other task"]);
  const launches = readState(workspace.stateDir).fixtures.claude.invocations.length;
  const oldPid = readState(workspace.stateDir).fixtures.tmux.sessions[THREAD_TMUX].pid;

  reassign(workspace, "demo", "demo2-bot");
  const changed = await projectChanged(workspace, context.env, "demo");
  assert.deepEqual(changed, { status: "ok", project: "demo", result: "restarted",
    restarted: [{ thread_id: THREAD, reason: "bot-changed" }] });
  const resumed = await waitForThread(workspace, context.env, THREAD, row => row.state === "live", "live again");
  assert.equal(resumed.provider_conversation_id, first.provider_conversation_id);
  await waitForExit(oldPid, "the old bot's Claude thread session");

  const state = readState(workspace.stateDir);
  const relaunches = state.fixtures.claude.invocations.slice(launches);
  assert.equal(relaunches.length, 1);
  assert.equal(resumedWith(relaunches[0]), `'${first.provider_conversation_id}'`);
  const newDir = context.threadDir("demo2", THREAD);
  assert.equal(state.fixtures.tmux.sessions[THREAD_TMUX].env.DISCORD_STATE_DIR, newDir);
  assert.equal(fs.readlinkSync(path.join(newDir, ".env")), path.join(context.states.demo2, ".env"));
  assert.equal(fs.existsSync(context.threadDir("demo", THREAD)), false);
  const notice = posts(state, THREAD).at(-1);
  assert.deepEqual([notice.authorization, notice.content],
    ["Bot demo2-token", "Restarting this thread's session on the project's new bot; the conversation resumes."]);
  // The stopped thread stays stopped.
  const sibling = await threadRow(workspace, context.env, SIBLING);
  assert.equal(sibling.state, "stopped");
  assert.equal(sibling.stop_reason, "operator");
  assert.equal(posts(state, SIBLING).length, 1);
  await stopRun(workspace, context.env, running);
});

test("project-changed after a bot reassignment resumes live Codex threads on a host logged in with the new bot", async () => {
  const workspace = createWorkspace();
  const codex = await startFakeCodexServer(workspace, { threadIds: ["codex-thread-a"],
    turnsByThread: { "codex-thread-a": [{ delta: "On it." }] } });
  const context = setup(workspace, { port: codex.port });
  const running = await startRun(workspace, context.env);
  await liveThread(workspace, context.env, CODEX_THREAD, "review", { parentId: "codex-channel" });
  const [host] = readState(workspace.stateDir).fixtures.codex.threadHostInvocations;

  reassign(workspace, "codexy", "codexy2-bot");
  const changed = await projectChanged(workspace, context.env, "codexy");
  assert.deepEqual(changed, { status: "ok", project: "codexy", result: "restarted",
    restarted: [{ thread_id: CODEX_THREAD, reason: "bot-changed" }] });
  let state = await waitForState(workspace, next => clientRequests(next, "thread/resume").length === 1, 15000);
  assert.equal(clientRequests(state, "thread/resume")[0].threadId, "codex-thread-a");
  await waitForThread(workspace, context.env, CODEX_THREAD, row => row.state === "live", "live again");
  await waitForExit(host.pid, "the old bot's Codex thread host");

  state = readState(workspace.stateDir);
  assert.equal(state.fixtures.codex.threadHostInvocations.length, 2);
  assert.equal(state.fixtures.discord.logins.at(-1).token, "codexy2-token");
  const notice = posts(state, CODEX_THREAD).at(-1);
  assert.deepEqual([notice.authorization, notice.content],
    ["Bot codexy2-token", "Restarting this thread's session on the project's new bot; the conversation resumes."]);
  await stopRun(workspace, context.env, running);
});

test("a guest grant and revoke restart live threads with resume and regenerate their access", async () => {
  const workspace = createWorkspace();
  const context = setup(workspace);
  const running = await startRun(workspace, context.env);
  const first = await liveThread(workspace, context.env, THREAD, "Login bug");
  await liveThread(workspace, context.env, SIBLING, "Other task");
  await threadsOk(workspace, context.env, ["stop", "demo", "Other task"]);
  const access = () => JSON.parse(fs.readFileSync(path.join(context.threadDir("demo", THREAD), "access.json"), "utf8"))
    .groups.channel.allowFrom;
  assert.deepEqual(access(), ["owner"]);

  for (const [action, expected] of [["grant", ["owner", GUEST]], ["revoke", ["owner"]]]) {
    const launches = readState(workspace.stateDir).fixtures.claude.invocations.length;
    const oldPid = readState(workspace.stateDir).fixtures.tmux.sessions[THREAD_TMUX].pid;
    await guestAccess(workspace, context.env, [action, "demo", GUEST]);
    await waitForThread(workspace, context.env, THREAD, row => row.state === "live", `live after ${action}`);
    await waitForExit(oldPid, `the Claude thread session before the ${action}`);
    const state = readState(workspace.stateDir);
    const relaunches = state.fixtures.claude.invocations.slice(launches);
    assert.equal(relaunches.length, 1, action);
    assert.equal(resumedWith(relaunches[0]), `'${first.provider_conversation_id}'`);
    assert.deepEqual(access(), expected, action);
    assert.deepEqual([posts(state, THREAD).at(-1).authorization, posts(state, THREAD).at(-1).content],
      ["Bot demo-token", "Restarting this thread's session because guest access changed; the conversation resumes."]);
    const sibling = await threadRow(workspace, context.env, SIBLING);
    assert.equal(sibling.state, "stopped", action);
    assert.equal(sibling.stop_reason, "operator", action);
  }
  await stopRun(workspace, context.env, running);
});
