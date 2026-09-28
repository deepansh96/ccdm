import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { createWorkspace, runScript } from "./support/runner.js";
import { bridgeChildEnv, injectDiscordMessage, injectDiscordThread, injectDiscordThreadDelete,
  injectDiscordThreadUpdate, startFakeCodexServer, waitForState } from "./support/bridge.js";
import { readState, writeState } from "./support/state.js";
import { cleanup } from "./support/teardown.js";

test.afterEach(async () => cleanup());

// Discord snowflakes for two threads under the Codex project's channel.
const THREAD = "1500000000000123456";
const SIBLING = "1500000000000654321";
const HOST_TMUX = "codexy_session-threads";
const PROJECT_TOKEN = "codex-project-token";
// Audit-log action 111 is THREAD_UPDATE.
const THREAD_UPDATE = 111;
// Discord's snowflake epoch; an id's top bits are milliseconds since it.
const DISCORD_EPOCH = 1420070400000n;
const snowflake = iso => String((BigInt(Date.parse(iso)) - DISCORD_EPOCH) << 22n);

function setup(workspace, { port }) {
  const projectDir = path.join(workspace.tmpDir, "codex project");
  fs.mkdirSync(projectDir, { recursive: true });
  const codexHome = path.join(workspace.homeDir, ".codex-work");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(codexHome, "config.toml"),
    "model = \"gpt-6\"\n\n[mcp_servers.discord-other]\ncommand = \"node\"\nargs = [\"other.js\"]\n");
  fs.writeFileSync(path.join(workspace.repoDir, "registry.json"), JSON.stringify({
    discord_user_id: "owner", guild_id: "guild",
    pool: [{ id: "codex-bot", app_id: "codex-app", token: PROJECT_TOKEN,
      state_dir: path.join(workspace.homeDir, "codex-bot"), assigned_to: "codexy" }],
    projects: {
      codexy: { type: "codex", path: projectDir, bot_id: "codex-bot", channel_id: "codex-channel",
        screen_name: "codexy_session", ws_port: 18399, thread_ws_port: port, codex_home: codexHome,
        codex_model: "gpt-6-luna", codex_reasoning_effort: "high", codex_sandbox: "workspace-write",
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
  return { codexHome, clockFile, env };
}

function seedAuditLog(workspace, entries) {
  const state = readState(workspace.stateDir);
  state.fixtures.discord.auditLogEntries = entries;
  writeState(state, workspace.stateDir);
}

// An audit-log entry for a thread archive, as Discord records it.
function archiveEntry(threadId, userId, at) {
  return { id: snowflake(at), user_id: userId, target_id: threadId, action_type: THREAD_UPDATE,
    changes: [{ key: "archived", old_value: false, new_value: true }] };
}

async function status(workspace, env) {
  const result = await runScript(workspace, "scripts/thread-supervisor.py", { args: ["status"], env });
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function startRun(workspace, env) {
  return runScript(workspace, "scripts/thread-supervisor.py", { args: ["run"], env, timeoutMs: 45000 });
}

function hostLog(workspace) {
  const file = path.join(workspace.stateDir, `thread-host-${HOST_TMUX}.log`);
  const { discord, codex } = readState(workspace.stateDir).fixtures;
  return `${fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "(no host log)"}\nposted: ${
    JSON.stringify(discord.messages.map(message => message.content))}\nCodex requests: ${
    JSON.stringify(codex.protocolEvents.map(event => event.message?.method ?? event.event))}`;
}

async function waitForThread(workspace, env, threadId, predicate, label, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let current;
  while (Date.now() < deadline) {
    current = await status(workspace, env);
    const thread = current.projects.codexy?.threads[threadId];
    if (predicate(thread)) return thread;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for thread ${threadId} to be ${label}: ${JSON.stringify(current)}\n${hostLog(workspace)}`);
}

async function stopRun(workspace, env, running) {
  const current = await status(workspace, env);
  process.kill(-current.worker_pid, "SIGTERM");
  const result = await running;
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
}

function threadMessage(workspace, id, content, threadId = THREAD, author = { id: "owner", username: "owner" }) {
  injectDiscordMessage(workspace, { id, channelId: threadId, channelType: 11, parentId: "codex-channel", author, content });
}

async function liveThread(workspace, context, threadId, messageId, name = "Login bug") {
  injectDiscordThread(workspace, { id: threadId, parentId: "codex-channel", name, ownerId: "owner",
    autoArchiveDuration: 10080 });
  threadMessage(workspace, messageId, "fix the login redirect", threadId);
  const thread = await waitForThread(workspace, context.env, threadId, row => row?.state === "live", "live");
  await waitForState(workspace, state => state.fixtures.discord.sends.some(send => send.channelId === threadId), 10000);
  return thread;
}

function archive(workspace, threadId, at) {
  injectDiscordThreadUpdate(workspace, { id: threadId, archived: true, archiveTimestamp: at });
}

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

async function gatewayDrained(workspace) {
  await waitForState(workspace, state => (state.fixtures.discord.injectedThreads ?? []).every(row => row.delivered) &&
    state.fixtures.discord.injectedMessages.every(row => row.delivered));
  // Let the observer hand the last event to the service.
  await new Promise(resolve => setTimeout(resolve, 1500));
}

// The app-server methods the host sent, in order, without the connection handshake.
const methods = state => state.fixtures.codex.protocolEvents
  .filter(event => event.event === "client-message" && event.message.method &&
    !["initialize", "initialized"].includes(event.message.method))
  .map(event => event.message.method);
// The methods addressed to one Codex conversation, in order.
const conversationRequests = (state, codexThreadId) => state.fixtures.codex.protocolEvents
  .filter(event => event.event === "client-message" && event.message.params?.threadId === codexThreadId)
  .map(event => event.message.method);
const clientRequests = (state, method) => state.fixtures.codex.protocolEvents
  .filter(event => event.event === "client-message" && event.message.method === method)
  .map(event => event.message.params);
const turnText = params => params.input.map(part => part.text ?? "").join("\n");
const isBootstrap = params => turnText(params).startsWith("You are communicating with the user via Discord");

test("auto-archiving the only live Codex thread unloads it and the host exits; only the owner resumes it", async () => {
  const workspace = createWorkspace();
  const codex = await startFakeCodexServer(workspace, { homeMcpServers: ["discord-other"],
    forbidDiscordConfigWrites: true, threadIds: ["codex-thread-a"],
    turnsByThread: { "codex-thread-a": [{ delta: "On it." }, { delta: "Resumed and done." }] } });
  const context = setup(workspace, { port: codex.port });
  const running = startRun(workspace, context.env);
  await waitForState(workspace, state => state.fixtures.discord.ready.length === 1);
  await liveThread(workspace, context, THREAD, "owner-1");
  // The app-server fixture records its launch on its own schedule.
  let state = await waitForState(workspace, next => next.fixtures.codex.appServerInvocations.length === 1);
  const [host] = state.fixtures.codex.threadHostInvocations;
  const [appServer] = state.fixtures.codex.appServerInvocations;

  seedAuditLog(workspace, [archiveEntry(THREAD, "guest", "2026-09-28T10:05:00Z")]);
  fs.writeFileSync(context.clockFile, "2026-09-28T10:05:00Z\n");
  archive(workspace, THREAD, "2026-09-28T10:05:00Z");
  const stopped = await waitForThread(workspace, context.env, THREAD, row => row?.state === "stopped", "stopped");
  assert.equal(stopped.stop_reason, "auto-archive");
  assert.equal(stopped.provider_conversation_id, "codex-thread-a");

  // It was the only live Codex thread: the host and its app-server exit.
  await waitForExit(host.pid, "the Codex thread host");
  await waitForExit(appServer.pid, "the Codex app-server");
  state = readState(workspace.stateDir);
  // Stopping unloads the conversation and never archives it.
  assert.deepEqual(methods(state), ["mcpServerStatus/list", "thread/start", "turn/start", "mcpServerStatus/list",
    "turn/start", "thread/unsubscribe"]);
  assert.deepEqual(clientRequests(state, "thread/unsubscribe"), [{ threadId: "codex-thread-a" }]);

  // A guest message starts nothing.
  threadMessage(workspace, "guest-1", "is anyone there?", THREAD, { id: "guest", username: "guest" });
  await gatewayDrained(workspace);
  state = readState(workspace.stateDir);
  assert.equal(state.fixtures.codex.threadHostInvocations.length, 1);
  assert.equal(state.fixtures.codex.appServerInvocations.length, 1);
  assert.equal((await status(workspace, context.env)).projects.codexy.threads[THREAD].state, "stopped");

  // The conversation was archived on the Codex side meanwhile; the owner's
  // message relaunches the host, which unarchives and resumes it.
  codex.archiveThread("codex-thread-a");
  const before = methods(state).length;
  threadMessage(workspace, "owner-2", "back to it");
  const resumed = await waitForThread(workspace, context.env, THREAD, row => row?.state === "live", "live again");
  assert.equal(resumed.provider_conversation_id, "codex-thread-a");
  state = await waitForState(workspace, next => next.fixtures.discord.sends
    .some(send => send.channelId === THREAD && send.content === "Resumed and done."), 10000);
  assert.equal(state.fixtures.codex.threadHostInvocations.length, 2);
  assert.deepEqual(methods(state).slice(before), ["mcpServerStatus/list", "thread/resume", "thread/unarchive",
    "thread/resume", "turn/start", "mcpServerStatus/list", "turn/start"]);
  assert.deepEqual(clientRequests(state, "thread/unarchive"), [{ threadId: "codex-thread-a" }]);
  // The override is re-sent on every resume, scoped to the thread.
  const resumes = state.fixtures.codex.threadConfigs.filter(config => config.method === "thread/resume");
  assert.equal(resumes.length, 2);
  for (const { params, mcpServers } of resumes) {
    assert.equal(params.threadId, "codex-thread-a");
    assert.deepEqual(Object.keys(mcpServers).sort(), [`discord-${THREAD}`, "discord-other"]);
    assert.equal(mcpServers[`discord-${THREAD}`].env.CHANNEL_ID, THREAD);
    assert.equal(mcpServers[`discord-${THREAD}`].env.BOT_TOKEN, PROJECT_TOKEN);
    assert.deepEqual(mcpServers["discord-other"], { enabled: false });
    assert.equal(params.config.model_reasoning_effort, "high");
  }
  const turns = clientRequests(state, "turn/start").slice(2);
  assert.ok(isBootstrap(turns[0]), "a resumed conversation gets the bootstrap with its new scope token");
  assert.match(turnText(turns[1]), /back to it/);
  assert.doesNotMatch(turnText(turns[1]), /is anyone there/);
  assert.equal(state.fixtures.codex.violations, undefined);
  await stopRun(workspace, context.env, running);
});

test("an owner archive closes a Codex thread, a delete forgets one, and each unloads its conversation", async () => {
  const workspace = createWorkspace();
  const codex = await startFakeCodexServer(workspace, { homeMcpServers: ["discord-other"],
    threadIds: ["codex-thread-a", "codex-thread-b"],
    turnsByThread: { "codex-thread-a": [{ delta: "Reply in A" }], "codex-thread-b": [{ delta: "Reply in B" }] } });
  const context = setup(workspace, { port: codex.port });
  const running = startRun(workspace, context.env);
  await waitForState(workspace, state => state.fixtures.discord.ready.length === 1);
  await liveThread(workspace, context, THREAD, "owner-1");
  await liveThread(workspace, context, SIBLING, "owner-2", "Flaky test");
  const [host] = readState(workspace.stateDir).fixtures.codex.threadHostInvocations;

  seedAuditLog(workspace, [archiveEntry(THREAD, "owner", "2026-09-28T10:05:00Z")]);
  fs.writeFileSync(context.clockFile, "2026-09-28T10:05:00Z\n");
  archive(workspace, THREAD, "2026-09-28T10:05:00Z");
  const closed = await waitForThread(workspace, context.env, THREAD, row => row?.state === "closed", "closed");
  assert.equal(closed.stop_reason, undefined);
  assert.equal(closed.provider_conversation_id, "codex-thread-a");
  let state = await waitForState(workspace, next => clientRequests(next, "thread/unsubscribe").length === 1);
  assert.deepEqual(conversationRequests(state, "codex-thread-a").slice(-1), ["thread/unsubscribe"]);
  // The sibling is still live, so the host keeps running.
  assert.equal(alive(host.pid), true);

  injectDiscordThreadDelete(workspace, SIBLING);
  await waitForThread(workspace, context.env, SIBLING, row => row === undefined, "forgotten");
  await waitForExit(host.pid, "the Codex thread host");
  state = readState(workspace.stateDir);
  assert.deepEqual(clientRequests(state, "thread/unsubscribe"), [{ threadId: "codex-thread-a" },
    { threadId: "codex-thread-b" }]);
  assert.equal(clientRequests(state, "thread/archive").length, 0);
  assert.equal(fs.existsSync(path.join(workspace.homeDir, ".local", "state", "ccdm", "thread-supervisor", "boot", `${SIBLING}.json`)), false);
  assert.deepEqual(Object.keys((await status(workspace, context.env)).projects.codexy.threads), [THREAD]);
  await stopRun(workspace, context.env, running);
});

test("a discord server added to the home between turns is disabled by an unload and resume before the next turn", async () => {
  const workspace = createWorkspace();
  const codex = await startFakeCodexServer(workspace, { homeMcpServers: ["discord-other"], threadIds: ["codex-thread-a"],
    turnsByThread: { "codex-thread-a": [{ delta: "On it." }, { delta: "Still scoped." }] } });
  const context = setup(workspace, { port: codex.port });
  const running = startRun(workspace, context.env);
  await waitForState(workspace, state => state.fixtures.discord.ready.length === 1);
  await liveThread(workspace, context, THREAD, "owner-1");
  const before = methods(readState(workspace.stateDir)).length;

  // A channel bridge on the same home registers its own Discord server.
  codex.setHomeMcpServers(["discord-other", "discord-new"]);
  threadMessage(workspace, "owner-2", "keep the query string");
  const state = await waitForState(workspace, next => next.fixtures.discord.sends
    .some(send => send.content === "Still scoped."), 10000);

  assert.deepEqual(methods(state).slice(before), ["mcpServerStatus/list", "thread/unsubscribe", "thread/resume",
    "turn/start"]);
  const [refreshed] = state.fixtures.codex.threadConfigs.filter(config => config.method === "thread/resume");
  assert.equal(refreshed.params.threadId, "codex-thread-a");
  assert.deepEqual(Object.keys(refreshed.mcpServers).sort(), [`discord-${THREAD}`, "discord-new", "discord-other"]);
  assert.deepEqual(refreshed.mcpServers["discord-new"], { enabled: false });
  assert.deepEqual(refreshed.mcpServers["discord-other"], { enabled: false });
  assert.equal(refreshed.mcpServers[`discord-${THREAD}`].env.CHANNEL_ID, THREAD);
  const [lastTurn] = clientRequests(state, "turn/start").slice(-1);
  assert.equal(turnText(lastTurn), "keep the query string");
  assert.equal((await status(workspace, context.env)).projects.codexy.threads[THREAD].state, "live");
  await stopRun(workspace, context.env, running);
});
