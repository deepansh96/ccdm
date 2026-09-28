import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { createWorkspace, runScript } from "./support/runner.js";
import { bridgeChildEnv, createBridgeWorkspace, injectDiscordMessage, injectDiscordThread, runPreloadProbe,
  startFakeCodexServer, waitForState } from "./support/bridge.js";
import { readState, writeState } from "./support/state.js";
import { cleanup } from "./support/teardown.js";

test.afterEach(async () => cleanup());

// Discord's longest auto-archive duration, in minutes (one week).
const ONE_WEEK = 10080;
const READY_SCREEN = "Listening for channel messages from: server:discord\n";

// A Claude project (`demo`) and a Codex project (`codexy`), each with its own
// bot, plus a named Codex Account and a named Claude account.
function setup(workspace, { port = 18999 } = {}) {
  const projectDir = path.join(workspace.tmpDir, "project");
  fs.mkdirSync(projectDir, { recursive: true });
  const codexHome = path.join(workspace.homeDir, ".codex-work");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(codexHome, "config.toml"), "model = \"gpt-6\"\n");
  const claudeWork = path.join(workspace.homeDir, ".claude-work");
  const plugin = path.join(claudeWork, "plugins", "cache", "claude-plugins-official", "discord", "0.0.4");
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
    claude_accounts: { work: claudeWork },
    pool: [
      { id: "demo-bot", app_id: "demo-app", token: "demo-token", state_dir: demoState, assigned_to: "demo" },
      { id: "codexy-bot", app_id: "codexy-app", token: "codexy-token", state_dir: codexyState, assigned_to: "codexy" },
    ],
    projects: {
      demo: { type: "claude", path: projectDir, bot_id: "demo-bot", channel_id: "channel", screen_name: "demo_session",
        guest_user_ids: ["guest"], model: "claude-opus-5-5", claude_effort: "high", thread_ws_port: port,
        text_reply_fallback: true },
      codexy: { type: "codex", path: projectDir, bot_id: "codexy-bot", channel_id: "codex-channel",
        screen_name: "codexy_session", ws_port: 18399, thread_ws_port: port, codex_model: "gpt-6",
        codex_reasoning_effort: "high", codex_sandbox: "workspace-write" },
    },
  }, null, 2), { mode: 0o600 });
  const rootState = path.join(workspace.homeDir, "root-discord");
  fs.mkdirSync(rootState, { recursive: true });
  fs.writeFileSync(path.join(rootState, ".env"), "DISCORD_BOT_TOKEN=fixture-root-token\n", { mode: 0o600 });
  const seed = readState(workspace.stateDir);
  // The supervisor (root) and a thread host (project bot) each receive every message.
  seed.fixtures.discord.fanOut = true;
  seed.fixtures.tmux.claudeBootScreens = [READY_SCREEN];
  writeState(seed, workspace.stateDir);
  const clockFile = path.join(workspace.tmpDir, "thread-clock");
  fs.writeFileSync(clockFile, "2026-09-28T10:00:00Z\n");
  const env = bridgeChildEnv(workspace, { ROOT_DISCORD_STATE_DIR: rootState, CCDM_THREAD_NODE: process.execPath,
    CCDM_THREAD_CLOCK_FILE: clockFile, CCDM_FIXTURE_CLAUDE_VERSION: "2.1.281 (Claude Code)",
    CCDM_REMINDER_PROJECT_ROOT: workspace.repoDir });
  return { claudeWork, codexyState, env };
}

async function status(workspace, env) {
  const result = await runScript(workspace, "scripts/thread-supervisor.py", { args: ["status"], env });
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function startRun(workspace, env) {
  return runScript(workspace, "scripts/thread-supervisor.py", { args: ["run"], env, timeoutMs: 30000 });
}

async function stopRun(workspace, env, running) {
  const current = await status(workspace, env);
  process.kill(-current.worker_pid, "SIGTERM");
  const result = await running;
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  return result;
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

function channelMessage(workspace, id, content, { channelId = "channel", author = { id: "owner", username: "owner" } } = {}) {
  injectDiscordMessage(workspace, { id, channelId, channelType: 0, author, content });
}

const clientRequests = (state, method) => state.fixtures.codex.protocolEvents
  .filter(event => event.event === "client-message" && event.message.method === method)
  .map(event => event.message.params);
const turnText = params => params.input.map(part => part.text ?? "").join("\n");

test("/thread in a Claude project channel creates a one-week thread whose Codex conversation starts with the first message", async () => {
  const workspace = createWorkspace();
  const codex = await startFakeCodexServer(workspace, { threadIds: ["codex-thread-a"],
    turnsByThread: { "codex-thread-a": [{ delta: "On it." }] } });
  const context = setup(workspace, { port: codex.port });
  const running = startRun(workspace, context.env);
  await waitForState(workspace, state => state.fixtures.discord.ready.length === 1);
  channelMessage(workspace, "command-1", "/thread fix-login --provider codex --model gpt-6-luna fix the login redirect");
  const created = await waitForState(workspace, state => (state.fixtures.discord.threadCreates ?? []).length === 1,
    10000);

  // One standalone public thread, created by the project bot with a one-week archive.
  const [create] = created.fixtures.discord.threadCreates;
  assert.equal(create.authorization, "Bot demo-token");
  assert.equal(create.channelId, "channel");
  assert.equal(create.messageId, null);
  assert.deepEqual(create.body, { name: "fix-login", type: 11, auto_archive_duration: ONE_WEEK });
  const threadId = create.threadId;
  const thread = await waitForThread(workspace, context.env, threadId, row => row.state === "live", "live");
  assert.equal(thread.name, "fix-login");
  assert.equal(thread.creator_id, "demo-app");
  const state = await waitForState(workspace, next => next.fixtures.discord.sends
    .some(send => send.channelId === threadId), 10000);

  // The Codex conversation carries the model and the thread's CHANNEL_ID, and
  // the first message is its first real turn after the no-action bootstrap.
  const [{ method, mcpServers, params }] = state.fixtures.codex.threadConfigs;
  assert.equal(method, "thread/start");
  assert.equal(params.model, "gpt-6-luna");
  assert.equal(mcpServers[`discord-${threadId}`].env.CHANNEL_ID, threadId);
  const turns = clientRequests(state, "turn/start");
  assert.equal(turns.length, 2);
  assert.match(turnText(turns[1]), /fix the login redirect/);
  assert.ok(turns.every(turn => turn.model === "gpt-6-luna"));
  // 👀 marks the /thread command, the first message's own Discord message, while the thread boots.
  const decoded = rows => rows.map(row => [row.channelId, decodeURIComponent(row.emoji), row.messageId]);
  assert.deepEqual(decoded(state.fixtures.discord.reactions), [["channel", "👀", "command-1"]]);
  // The project's Claude Channel Conversation was never started for it.
  assert.deepEqual(Object.keys(state.fixtures.tmux.sessions), ["demo_session-threads"]);
  assert.equal(state.fixtures.claude.invocations.length, 0);
  // The Gateway's own THREAD_CREATE for the bot's thread binds nothing twice,
  // and the owner's creation request is fulfilled by this thread.
  const after = (await status(workspace, context.env)).projects.demo;
  assert.equal(Object.keys(after.threads).length, 1);
  assert.deepEqual(Object.values(after.creation_requests), [{ name: "fix-login", requester_kind: "owner",
    status: "fulfilled", thread_id: threadId }]);
  await stopRun(workspace, context.env, running);
});

test("/thread with --provider claude and a Claude account alias in a Codex project waits, then launches Claude on that account", async () => {
  const workspace = createWorkspace();
  const context = setup(workspace);
  const running = startRun(workspace, context.env);
  await waitForState(workspace, state => state.fixtures.discord.ready.length === 1);
  channelMessage(workspace, "command-1", "/thread notes --provider claude --account work", { channelId: "codex-channel" });
  const created = await waitForState(workspace, state => (state.fixtures.discord.threadCreates ?? []).length === 1,
    10000);
  const [create] = created.fixtures.discord.threadCreates;
  assert.equal(create.authorization, "Bot codexy-token");
  assert.deepEqual(create.body, { name: "notes", type: 11, auto_archive_duration: ONE_WEEK });
  const threadId = create.threadId;

  // Without a first message the thread waits for the owner.
  await waitForThread(workspace, context.env, threadId, row => row.state === "registered", "registered");
  assert.deepEqual(readState(workspace.stateDir).fixtures.tmux.sessions, {});
  injectDiscordMessage(workspace, { id: "owner-1", channelId: threadId, channelType: 11, parentId: "codex-channel",
    author: { id: "owner", username: "owner" }, content: "summarize the open questions" });
  await waitForThread(workspace, context.env, threadId, row => row.state === "live", "live");

  // A Claude thread session, on the alias's Claude home, with no Codex setting inherited.
  const state = readState(workspace.stateDir);
  const tmuxName = `codexy_session-t-${threadId.slice(-6)}`;
  assert.deepEqual(Object.keys(state.fixtures.tmux.sessions), [tmuxName]);
  const session = state.fixtures.tmux.sessions[tmuxName];
  assert.equal(session.env.CLAUDE_CONFIG_DIR, context.claudeWork);
  assert.match(session.shellCommand, / claude --dangerously-load-development-channels server:discord /);
  assert.doesNotMatch(session.shellCommand, /--model|--effort/);
  assert.equal(state.fixtures.claude.invocations.length, 1);
  assert.deepEqual(state.fixtures.codex.appServerInvocations ?? [], []);
  await stopRun(workspace, context.env, running);
});

test("an invalid /thread option posts exactly one error line and creates no thread, request, or session", async () => {
  const workspace = createWorkspace();
  const context = setup(workspace);
  const running = startRun(workspace, context.env);
  await waitForState(workspace, state => state.fixtures.discord.ready.length === 1);
  const commands = [
    "/thread fix-login --account /some/path fix the login redirect",
    "/thread fix-login --account personal fix the login redirect",
    "/thread fix-login --provider gemini fix the login redirect",
    "/thread fix-login --effort ludicrous fix the login redirect",
  ];
  commands.forEach((content, index) => channelMessage(workspace, `command-${index}`, content));
  const state = await waitForState(workspace, next => next.fixtures.discord.messages?.length === commands.length, 15000);
  // Give any late side effect a chance to appear before asserting there is none.
  await new Promise(resolve => setTimeout(resolve, 500));

  const posted = readState(workspace.stateDir).fixtures.discord.messages;
  assert.equal(posted.length, commands.length);
  for (const message of posted) {
    assert.equal(message.channelId, "channel");
    assert.equal(message.authorization, "Bot demo-token");
    assert.equal(message.content.split("\n").length, 1, message.content);
  }
  // Each names what was wrong with its option.
  assert.match(posted[0].content, /--account.*alias, not a path/);
  assert.match(posted[1].content, /--account personal/);
  assert.match(posted[2].content, /--provider must be claude or codex/);
  assert.match(posted[3].content, /--effort/);
  assert.deepEqual(state.fixtures.discord.threadCreates ?? [], []);
  assert.deepEqual(state.fixtures.tmux.sessions, {});
  assert.deepEqual((await status(workspace, context.env)).projects, {});
  await stopRun(workspace, context.env, running);
});

test("/thread from a stranger does nothing, a bot thread with no request stays unbound, and /config gets the thread hint", async () => {
  const workspace = createWorkspace();
  const context = setup(workspace);
  const running = startRun(workspace, context.env);
  await waitForState(workspace, state => state.fixtures.discord.ready.length === 1);
  channelMessage(workspace, "stranger-1", "/thread mine --provider codex let me in",
    { author: { id: "stranger", username: "stranger" } });
  // The project bot created this thread, but no creation request asked for it.
  injectDiscordThread(workspace, { id: "1500000000000123456", parentId: "channel", name: "unrequested",
    ownerId: "demo-app", autoArchiveDuration: ONE_WEEK });
  channelMessage(workspace, "config-1", "/config");
  const state = await waitForState(workspace, next => (next.fixtures.discord.messages ?? []).length === 1, 10000);
  await new Promise(resolve => setTimeout(resolve, 500));

  // Only the /config hint is posted, as one line in the channel.
  assert.deepEqual(readState(workspace.stateDir).fixtures.discord.messages.map(message =>
    [message.channelId, message.content]), [["channel",
    "/config works inside a thread: send it in the thread whose settings you want to see or change."]]);
  assert.deepEqual(state.fixtures.discord.threadCreates ?? [], []);
  assert.deepEqual(state.fixtures.tmux.sessions, {});
  assert.deepEqual((await status(workspace, context.env)).projects, {});
  await stopRun(workspace, context.env, running);
});

test("the REST fake creates standalone and message threads like Discord and rejects malformed creations", async () => {
  const workspace = createBridgeWorkspace();
  const result = await runPreloadProbe(workspace, `
    const create = (route, body) => fetch("https://discord.com/api/v10" + route, { method: "POST",
      headers: { Authorization: "Bot bot-token", "Content-Type": "application/json" }, body: JSON.stringify(body) })
      .then(async response => console.log(route + " " + response.status + " " + JSON.stringify(await response.json())));
    (async () => {
      await create("/channels/channel/threads", { name: "standalone", type: 11, auto_archive_duration: 10080 });
      await create("/channels/channel/messages/1500000000000999999/threads", { name: "from-message" });
      await create("/channels/channel/threads", { name: "", type: 11 });
      await create("/channels/channel/threads", { name: "bad-duration", auto_archive_duration: 30 });
    })();
  `);
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  const lines = result.stdout.trim().split("\n");
  assert.match(lines[0], /^\/channels\/channel\/threads 201 .*"parent_id":"channel".*"auto_archive_duration":10080/);
  // A thread started from a message takes the message's id; Discord's default archive is three days.
  assert.match(lines[1], /threads 201 \{"id":"1500000000000999999".*"auto_archive_duration":4320/);
  assert.match(lines[2], / 400 .*Invalid Form Body/);
  assert.match(lines[3], / 400 .*Invalid Form Body/);
  const discord = readState(workspace.stateDir).fixtures.discord;
  assert.deepEqual(discord.threadCreates.map(entry => [entry.channelId, entry.messageId, entry.body.name]),
    [["channel", null, "standalone"], ["channel", "1500000000000999999", "from-message"]]);
  assert.deepEqual(discord.injectedThreads.map(thread => [thread.name, thread.type, thread.parentId]),
    [["standalone", 11, "channel"], ["from-message", 11, "channel"]]);
});
