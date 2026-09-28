import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { createWorkspace, runScript } from "./support/runner.js";
import { bridgeChildEnv, injectDiscordMessage, injectDiscordThread, injectDiscordThreadDelete, startFakeCodexServer,
  waitForState } from "./support/bridge.js";
import { readState, writeState } from "./support/state.js";
import { cleanup, registerTeardownCallback } from "./support/teardown.js";

test.afterEach(async () => cleanup());

// Discord snowflakes; a thread's tmux name ends in its last six digits.
const FIRST = "1500000000000111111";
const SECOND = "1500000000000222222";
const THIRD = "1500000000000333333";
// The PRD's exact capacity notices.
const PAUSED = "Paused to free a session slot; reply to resume.";

function setup(workspace, caps) {
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
    discord_user_id: "owner", guild_id: "guild", root_bot_app_id: "root-app",
    ...(caps ? { thread_session_caps: caps } : {}),
    pool: [{ id: "bot", app_id: "app", token: "project-token", state_dir: botState, assigned_to: "demo" }],
    projects: {
      demo: { type: "claude", path: projectDir, bot_id: "bot", channel_id: "channel", screen_name: "demo_session",
        model: "claude-opus-5-5", claude_effort: "high", claude_home: claudeHome, session_id: null, pid: null },
    },
  }, null, 2), { mode: 0o600 });
  const rootState = path.join(workspace.homeDir, "root-discord");
  fs.mkdirSync(rootState, { recursive: true });
  fs.writeFileSync(path.join(rootState, ".env"), "DISCORD_BOT_TOKEN=fixture-root-token\n", { mode: 0o600 });
  const clockFile = path.join(workspace.tmpDir, "thread-clock");
  fs.writeFileSync(clockFile, "2026-09-28T10:00:00Z\n");
  const env = bridgeChildEnv(workspace, { ROOT_DISCORD_STATE_DIR: rootState, CCDM_THREAD_NODE: process.execPath,
    CCDM_THREAD_CLOCK_FILE: clockFile, CCDM_FIXTURE_CLAUDE_VERSION: "2.1.281 (Claude Code)",
    CCDM_REMINDER_PROJECT_ROOT: workspace.repoDir });
  return { botState, clockFile, env, threadDir: threadId => path.join(botState, "threads", threadId),
    at: iso => fs.writeFileSync(clockFile, `${iso}\n`) };
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

async function waitForThread(workspace, env, threadId, predicate, label, timeoutMs = 15000, project = "demo") {
  const deadline = Date.now() + timeoutMs;
  let current;
  while (Date.now() < deadline) {
    current = await status(workspace, env);
    const thread = current.projects[project]?.threads[threadId];
    if (predicate(thread)) return thread;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for thread ${threadId} to be ${label}: ${JSON.stringify(current)}\nposted: ${
    JSON.stringify(readState(workspace.stateDir).fixtures.discord.messages ?? [])}`);
}

function ownerMessage(workspace, threadId, id, content, parentId = "channel") {
  injectDiscordMessage(workspace, { id, channelId: threadId, channelType: 11, parentId,
    author: { id: "owner", username: "owner" }, content });
}

function openThread(workspace, threadId, messageId, name, parentId = "channel") {
  injectDiscordThread(workspace, { id: threadId, parentId, name, ownerId: "owner", autoArchiveDuration: 10080 });
  ownerMessage(workspace, threadId, messageId, `work on ${name}`, parentId);
}

// Runs a thread's proxy as its generated MCP config tells Claude Code to, with
// a Local Fake of the official plugin, until the thread's bootstrap reaches
// Claude: relaying it starts a turn.
async function startTurn(workspace, threadDir) {
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
    if (request.method === "tools/list") write({ jsonrpc: "2.0", id: request.id, result: { tools:
      ["reply", "react", "edit_message", "download_attachment", "fetch_messages"].map(name => ({ name, inputSchema: {
        type: "object", properties: { chat_id: { type: "string" }, text: { type: "string" } }, required: ["chat_id", "text"] } })) } });
  }
});
`);
  const server = JSON.parse(fs.readFileSync(path.join(threadDir, "ccdm-message-export-mcp.json"), "utf8")).mcpServers.discord;
  const child = spawn(process.execPath, server.args, { cwd: workspace.repoDir, stdio: ["pipe", "pipe", "pipe"],
    env: { ...workspace.env, ...server.env, CCDM_CLAUDE_PLUGIN_COMMAND: process.execPath,
      CCDM_CLAUDE_PLUGIN_ARGS: JSON.stringify([fake]) } });
  const exited = new Promise(resolve => child.once("exit", resolve));
  registerTeardownCallback(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await exited;
  });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  const send = value => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n");
  send({ id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {},
    clientInfo: { name: "claude-code", version: "2.1.281" } } });
  send({ method: "notifications/initialized" });
  send({ id: 2, method: "tools/list" });
  await waitFor(() => output.includes("notifications/claude/channel"), `the bootstrap relayed: ${output}`);
}

// Runs the thread's generated Claude Code hook for ``event``, as Claude Code does when a turn ends.
function runHook(context, threadDir, event) {
  const settings = JSON.parse(fs.readFileSync(path.join(threadDir, "ccdm-claude-channel-settings.json"), "utf8"));
  const [group] = settings.hooks[event];
  // Claude Code runs command hooks in the user's shell, where `node` resolves.
  const env = { ...context.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${context.env.PATH}` };
  const ran = spawnSync("/bin/sh", ["-c", group.hooks[0].command], { env, encoding: "utf8",
    input: JSON.stringify({ hook_event_name: event, session_id: "fixture-session" }) });
  assert.equal(ran.status, 0, ran.stderr);
}

async function waitFor(predicate, label, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !(await predicate())) await new Promise(resolve => setTimeout(resolve, 50));
  assert.ok(await predicate(), `timed out waiting for ${label}`);
}

const posts = (workspace, threadId) => (readState(workspace.stateDir).fixtures.discord.messages ?? [])
  .filter(posted => posted.channelId === threadId).map(posted => [posted.authorization, posted.content]);

test("at the Claude cap, an owner message in a second thread evicts the first once it has been idle 31 minutes", async () => {
  const workspace = createWorkspace();
  const context = setup(workspace, { claude: 1 });
  // The project's Claude Channel Conversation runs throughout and takes no thread slot.
  const channel = await runScript(workspace, "scripts/start-session.sh", { args: ["demo"], env: context.env });
  assert.equal(channel.exitCode, 0, channel.stderr || channel.stdout);
  const running = startRun(workspace, context.env);
  await waitForState(workspace, state => state.fixtures.discord.ready.length === 1);
  openThread(workspace, FIRST, "owner-1", "Login bug");
  await waitForThread(workspace, context.env, FIRST, row => row?.state === "live", "live");

  context.at("2026-09-28T10:31:00Z");
  openThread(workspace, SECOND, "owner-2", "Billing");
  await waitForThread(workspace, context.env, SECOND, row => row?.state === "live", "live");
  const first = (await status(workspace, context.env)).projects.demo.threads[FIRST];
  assert.equal(first.state, "stopped");
  assert.equal(first.stop_reason, "evicted");
  assert.deepEqual(posts(workspace, FIRST), [["Bot project-token", PAUSED]]);
  assert.deepEqual(Object.keys(readState(workspace.stateDir).fixtures.tmux.sessions).sort(),
    ["demo_session", "demo_session-t-222222"]);
  assert.equal(fs.existsSync(context.threadDir(FIRST)), false);
  await stopRun(workspace, context.env, running);
});

test("the owner's reply in an evicted thread resumes it by the same rules: queued while the other is active, then evicting it once idle", async () => {
  const workspace = createWorkspace();
  const context = setup(workspace, { claude: 1 });
  const running = startRun(workspace, context.env);
  await waitForState(workspace, state => state.fixtures.discord.ready.length === 1);
  openThread(workspace, FIRST, "owner-1", "Login bug");
  const first = await waitForThread(workspace, context.env, FIRST, row => row?.state === "live", "live");
  context.at("2026-09-28T10:31:00Z");
  openThread(workspace, SECOND, "owner-2", "Billing");
  const second = await waitForThread(workspace, context.env, SECOND, row => row?.state === "live", "live");
  await waitForThread(workspace, context.env, FIRST, row => row?.stop_reason === "evicted", "evicted");

  // The second thread's owner wrote just now, so it is not idle: the reply waits.
  ownerMessage(workspace, FIRST, "owner-3", "back to the login bug");
  await waitForThread(workspace, context.env, FIRST, row => row?.state === "queued", "queued");
  assert.deepEqual(posts(workspace, FIRST), [["Bot project-token", PAUSED], ["Bot project-token", "Queued, 1 sessions busy."]]);
  assert.equal(readState(workspace.stateDir).fixtures.claude.invocations.length, 2);

  // Thirty-one minutes on, the second thread is idle and gives up its slot.
  context.at("2026-09-28T11:02:00Z");
  const resumed = await waitForThread(workspace, context.env, FIRST, row => row?.state === "live", "live again");
  assert.equal(resumed.provider_conversation_id, first.provider_conversation_id);
  const relaunch = readState(workspace.stateDir).fixtures.claude.invocations[2];
  assert.equal(relaunch.args[relaunch.args.indexOf("--resume") + 1], `'${first.provider_conversation_id}'`);
  const evicted = (await status(workspace, context.env)).projects.demo.threads[SECOND];
  assert.deepEqual([evicted.state, evicted.stop_reason, evicted.provider_conversation_id],
    ["stopped", "evicted", second.provider_conversation_id]);
  assert.deepEqual(posts(workspace, SECOND), [["Bot project-token", PAUSED]]);
  await stopRun(workspace, context.env, running);
});

test("a Claude session mid-turn is never evicted: the new thread queues and starts once the Stop hook ends the turn", async () => {
  const workspace = createWorkspace();
  const context = setup(workspace, { claude: 1 });
  const running = startRun(workspace, context.env);
  await waitForState(workspace, state => state.fixtures.discord.ready.length === 1);
  openThread(workspace, FIRST, "owner-1", "Login bug");
  await waitForThread(workspace, context.env, FIRST, row => row?.state === "live", "live");
  await startTurn(workspace, context.threadDir(FIRST));
  await waitForThread(workspace, context.env, FIRST, row => row?.turn_running === true, "mid-turn");

  context.at("2026-09-28T10:31:00Z");
  openThread(workspace, SECOND, "owner-2", "Billing");
  await waitForThread(workspace, context.env, SECOND, row => row?.state === "queued", "queued");
  assert.deepEqual(posts(workspace, SECOND), [["Bot project-token", "Queued, 1 sessions busy."]]);
  ownerMessage(workspace, SECOND, "owner-3", "and the invoice total");
  await new Promise(resolve => setTimeout(resolve, 1500));
  let current = await status(workspace, context.env);
  assert.equal(current.projects.demo.threads[FIRST].state, "live");
  assert.equal(current.projects.demo.threads[SECOND].state, "queued");
  assert.equal(readState(workspace.stateDir).fixtures.claude.invocations.length, 1);

  runHook(context, context.threadDir(FIRST), "Stop");
  await waitForThread(workspace, context.env, SECOND, row => row?.state === "live", "started");
  current = await status(workspace, context.env);
  assert.deepEqual([current.projects.demo.threads[FIRST].state, current.projects.demo.threads[FIRST].stop_reason],
    ["stopped", "evicted"]);
  assert.deepEqual(posts(workspace, FIRST), [["Bot project-token", PAUSED]]);
  // The queued thread's messages all reach its bootstrap.
  const bootstrap = JSON.parse(fs.readFileSync(path.join(context.threadDir(SECOND), "ccdm-thread-bootstrap.json"), "utf8"));
  assert.match(bootstrap.content, /owner: work on Billing\nowner: and the invoice total$/);
  await stopRun(workspace, context.env, running);
});

test("two queued Claude threads start in FIFO order as slots free", async () => {
  const workspace = createWorkspace();
  const context = setup(workspace, { claude: 1 });
  const running = startRun(workspace, context.env);
  await waitForState(workspace, state => state.fixtures.discord.ready.length === 1);
  openThread(workspace, FIRST, "owner-1", "Login bug");
  await waitForThread(workspace, context.env, FIRST, row => row?.state === "live", "live");
  await startTurn(workspace, context.threadDir(FIRST));
  await waitForThread(workspace, context.env, FIRST, row => row?.turn_running === true, "mid-turn");

  context.at("2026-09-28T10:31:00Z");
  // THIRD is queued first, so it starts first even though its id sorts last.
  openThread(workspace, THIRD, "owner-3", "Invoices");
  await waitForThread(workspace, context.env, THIRD, row => row?.state === "queued", "queued");
  openThread(workspace, SECOND, "owner-2", "Billing");
  await waitForThread(workspace, context.env, SECOND, row => row?.state === "queued", "queued");
  assert.deepEqual(posts(workspace, THIRD), [["Bot project-token", "Queued, 1 sessions busy."]]);
  assert.deepEqual(posts(workspace, SECOND), [["Bot project-token", "Queued, 1 sessions busy."]]);

  // Deleting the busy thread frees its slot for the oldest waiter only.
  injectDiscordThreadDelete(workspace, FIRST);
  await waitForThread(workspace, context.env, THIRD, row => row?.state === "live", "started");
  await new Promise(resolve => setTimeout(resolve, 1500));
  assert.equal((await status(workspace, context.env)).projects.demo.threads[SECOND].state, "queued");

  // Thirty-one minutes on, the started thread is idle and yields to the next waiter.
  context.at("2026-09-28T11:02:00Z");
  await waitForThread(workspace, context.env, SECOND, row => row?.state === "live", "started");
  const started = readState(workspace.stateDir).fixtures.claude.invocations
    .map(invocation => path.basename(invocation.env.DISCORD_STATE_DIR));
  assert.deepEqual(started, [FIRST, THIRD, SECOND]);
  assert.deepEqual(posts(workspace, THIRD), [["Bot project-token", "Queued, 1 sessions busy."], ["Bot project-token", PAUSED]]);
  await stopRun(workspace, context.env, running);
});

// Two Codex projects, each with its own thread host on the fake app-server.
function setupCodex(workspace, { port }) {
  const codexHome = path.join(workspace.homeDir, ".codex-work");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(codexHome, "config.toml"), "model = \"gpt-6\"\n");
  const project = (name, channel) => {
    const projectDir = path.join(workspace.tmpDir, name);
    fs.mkdirSync(projectDir, { recursive: true });
    return { type: "codex", path: projectDir, bot_id: `${name}-bot`, channel_id: channel, screen_name: `${name}_session`,
      ws_port: 18399, thread_ws_port: port, codex_home: codexHome, text_reply_fallback: true, session_id: null, pid: null };
  };
  fs.writeFileSync(path.join(workspace.repoDir, "registry.json"), JSON.stringify({
    discord_user_id: "owner", guild_id: "guild", root_bot_app_id: "root-app", thread_session_caps: { claude: 1, codex: 1 },
    pool: ["alpha", "beta"].map(name => ({ id: `${name}-bot`, app_id: `${name}-app`, token: `${name}-token`,
      state_dir: path.join(workspace.homeDir, `${name}-bot`), assigned_to: name })),
    projects: { alpha: project("alpha", "alpha-channel"), beta: project("beta", "beta-channel") },
  }, null, 2), { mode: 0o600 });
  const rootState = path.join(workspace.homeDir, "root-discord");
  fs.mkdirSync(rootState, { recursive: true });
  fs.writeFileSync(path.join(rootState, ".env"), "DISCORD_BOT_TOKEN=fixture-root-token\n", { mode: 0o600 });
  const seed = readState(workspace.stateDir);
  // The supervisor and each host hold a Gateway connection and all receive thread messages.
  seed.fixtures.discord.fanOut = true;
  writeState(seed, workspace.stateDir);
  const clockFile = path.join(workspace.tmpDir, "thread-clock");
  fs.writeFileSync(clockFile, "2026-09-28T10:00:00Z\n");
  const env = bridgeChildEnv(workspace, { ROOT_DISCORD_STATE_DIR: rootState, CCDM_THREAD_NODE: process.execPath,
    CCDM_THREAD_CLOCK_FILE: clockFile, CCDM_REMINDER_PROJECT_ROOT: workspace.repoDir });
  return { env, at: iso => fs.writeFileSync(clockFile, `${iso}\n`) };
}

test("the Codex cap counts conversations across project hosts, never a running Channel Conversation", async () => {
  const workspace = createWorkspace();
  const fake = await startFakeCodexServer(workspace);
  const context = setupCodex(workspace, fake);
  // alpha's Codex Channel Conversation runs throughout.
  const channel = await runScript(workspace, "scripts/start-codex-session.sh", { args: ["alpha"], env: context.env });
  assert.equal(channel.exitCode, 0, channel.stderr || channel.stdout);
  assert.ok(readState(workspace.stateDir).fixtures.tmux.sessions.alpha_session);

  const running = startRun(workspace, context.env);
  await waitForState(workspace, state => state.fixtures.discord.ready.length === 1);
  openThread(workspace, FIRST, "owner-1", "Login bug", "alpha-channel");
  await waitForThread(workspace, context.env, FIRST, row => row?.state === "live", "live", 20000, "alpha");

  // beta's first thread would be its host's only conversation, but alpha's host holds the one Codex slot.
  openThread(workspace, SECOND, "owner-2", "Billing", "beta-channel");
  await waitForThread(workspace, context.env, SECOND, row => row?.state === "queued", "queued", 15000, "beta");
  assert.deepEqual(posts(workspace, SECOND), [["Bot beta-token", "Queued, 1 sessions busy."]]);
  assert.equal(readState(workspace.stateDir).fixtures.tmux.sessions["beta_session-threads"], undefined);

  context.at("2026-09-28T10:31:00Z");
  await waitForThread(workspace, context.env, SECOND, row => row?.state === "live", "started", 20000, "beta");
  const alpha = (await status(workspace, context.env)).projects.alpha.threads[FIRST];
  assert.deepEqual([alpha.state, alpha.stop_reason], ["stopped", "evicted"]);
  assert.deepEqual(posts(workspace, FIRST).filter(([, content]) => content === PAUSED), [["Bot alpha-token", PAUSED]]);
  const sessions = readState(workspace.stateDir).fixtures.tmux.sessions;
  assert.ok(sessions["beta_session-threads"]);
  assert.ok(sessions.alpha_session, "the Channel Conversation keeps running");
  await stopRun(workspace, context.env, running);
});
