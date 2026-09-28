import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { createWorkspace, runScript } from "./support/runner.js";
import { bridgeChildEnv, injectDiscordMessage, injectDiscordThread, waitForState } from "./support/bridge.js";
import { readState, writeState } from "./support/state.js";
import { cleanup } from "./support/teardown.js";

test.afterEach(async () => cleanup());

// Discord snowflakes; a thread's tmux name ends in its last six digits.
const MISSED = "1500000000000111111";
const ANSWERED = "1500000000000222222";
const OWNED = "1500000000000333333";
const LAPSED = "1500000000000444444";
// Discord's longest auto-archive duration, one week in minutes, and its 3-day default.
const ONE_WEEK_MINUTES = 10080;
const THREE_DAYS_MINUTES = 4320;
// Audit-log action 111 is THREAD_UPDATE.
const THREAD_UPDATE = 111;
// Discord's snowflake epoch; an id's top bits are milliseconds since it.
const DISCORD_EPOCH = 1420070400000n;
const snowflake = iso => String((BigInt(Date.parse(iso)) - DISCORD_EPOCH) << 22n);

function setup(workspace) {
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
    pool: [{ id: "bot", app_id: "app", token: "project-token", state_dir: botState, assigned_to: "demo" }],
    projects: {
      demo: { type: "claude", path: projectDir, bot_id: "bot", channel_id: "channel", screen_name: "demo_session",
        guest_user_ids: ["guest"], model: "claude-opus-5-5", claude_effort: "high", claude_home: claudeHome,
        session_id: null, pid: null },
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
  return { clockFile, env, threadDir: threadId => path.join(botState, "threads", threadId) };
}

function fixtures(workspace, change) {
  const state = readState(workspace.stateDir);
  change(state.fixtures.discord);
  writeState(state, workspace.stateDir);
}

// A public thread under the project channel as the REST fake lists it.
function thread(id, extra = {}) {
  return { id, type: 11, parentId: "channel", parentType: 0, name: `thread ${id.slice(-6)}`, ownerId: "owner",
    archived: false, autoArchiveDuration: ONE_WEEK_MINUTES, ...extra };
}

// One message in a thread's history, as Discord's Get Channel Messages returns it.
function historyMessage(id, at, author, content) {
  return { id, channel_id: "", content, type: 0, attachments: [], timestamp: at,
    author: { id: author, username: author, bot: author === "app" } };
}

// Seeds a thread's history, newest first as Discord returns it.
function seedHistory(workspace, threadId, messages) {
  fixtures(workspace, discord => {
    (discord.history ||= {})[threadId] = messages.map(row => ({ ...row, channel_id: threadId }));
  });
}

function archiveEntry(threadId, userId, at) {
  return { id: snowflake(at), user_id: userId, target_id: threadId, action_type: THREAD_UPDATE,
    changes: [{ key: "archived", old_value: false, new_value: true }] };
}

async function supervisor(workspace, env, command) {
  const result = await runScript(workspace, "scripts/thread-supervisor.py", { args: [command], env, timeoutMs: 45000 });
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function startRun(workspace, env) {
  return runScript(workspace, "scripts/thread-supervisor.py", { args: ["run"], env, timeoutMs: 45000 });
}

async function waitForThread(workspace, env, threadId, predicate, label, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let current;
  while (Date.now() < deadline) {
    current = await supervisor(workspace, env, "status");
    const row = current.projects.demo?.threads[threadId];
    if (predicate(row)) return row;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for thread ${threadId} to be ${label}: ${JSON.stringify(current)}`);
}

async function stopRun(workspace, env, running) {
  const current = await supervisor(workspace, env, "status");
  process.kill(-current.worker_pid, "SIGTERM");
  const result = await running;
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
}

// Starts the supervisor and brings a thread live with one owner message.
async function liveThread(workspace, context, threadId, messageId) {
  injectDiscordThread(workspace, thread(threadId));
  injectDiscordMessage(workspace, { id: messageId, channelId: threadId, channelType: 11, parentId: "channel",
    author: { id: "owner", username: "owner" }, content: "fix the login redirect" });
  return waitForThread(workspace, context.env, threadId, row => row?.state === "live", "live");
}

const claudeLaunches = workspace => readState(workspace.stateDir).fixtures.claude.invocations ?? [];

test("a restart binds threads created during downtime and starts only the one with an unanswered owner message", async () => {
  const workspace = createWorkspace();
  const context = setup(workspace);
  let running = startRun(workspace, context.env);
  await waitForState(workspace, state => state.fixtures.discord.ready.length === 1);
  await stopRun(workspace, context.env, running);

  // While the supervisor is down, the owner opens two threads with Discord's
  // 3-day default. One waits for an answer; the other already has the agent's reply.
  fixtures(workspace, discord => {
    discord.threads = { [MISSED]: thread(MISSED, { autoArchiveDuration: THREE_DAYS_MINUTES }),
      [ANSWERED]: thread(ANSWERED, { autoArchiveDuration: THREE_DAYS_MINUTES }) };
  });
  seedHistory(workspace, MISSED, [historyMessage("missed-1", "2026-09-28T09:40:00Z", "owner", "fix the flaky login test")]);
  seedHistory(workspace, ANSWERED, [historyMessage("answered-2", "2026-09-28T09:35:00Z", "app", "Done, tests pass."),
    historyMessage("answered-1", "2026-09-28T09:30:00Z", "owner", "rename the helper")]);

  running = startRun(workspace, context.env);
  const missed = await waitForThread(workspace, context.env, MISSED, row => row?.state === "live", "live");
  assert.equal(missed.runtime_tmux, "demo_session-t-111111");
  const answered = await waitForThread(workspace, context.env, ANSWERED, row => row !== undefined, "bound");
  assert.deepEqual(answered, { name: "thread 222222", creator_id: "owner", state: "registered" });
  const bootstrap = JSON.parse(fs.readFileSync(path.join(context.threadDir(MISSED), "ccdm-thread-bootstrap.json"), "utf8"));
  assert.match(bootstrap.content, /owner: fix the flaky login test/);
  assert.equal(bootstrap.meta.message_id, "missed-1");
  assert.equal(claudeLaunches(workspace).length, 1, "only the unanswered thread gets a session");
  const patches = readState(workspace.stateDir).fixtures.discord.threadPatches;
  assert.deepEqual(patches.map(({ authorization, body, threadId }) => ({ authorization, body, threadId })).sort(
    (a, b) => a.threadId.localeCompare(b.threadId)), [
    { authorization: "Bot project-token", body: { auto_archive_duration: ONE_WEEK_MINUTES }, threadId: MISSED },
    { authorization: "Bot project-token", body: { auto_archive_duration: ONE_WEEK_MINUTES }, threadId: ANSWERED },
  ]);
  // Threads are listed with root credentials.
  const listings = readState(workspace.stateDir).fixtures.discord.threadListFetches;
  assert.ok(listings.length >= 1);
  for (const fetch of listings) assert.equal(fetch.authorization, "Bot fixture-root-token");
  await stopRun(workspace, context.env, running);
});

test("a restart classifies archives missed during downtime by audit-log actor and stops their sessions", async () => {
  const workspace = createWorkspace();
  const context = setup(workspace);
  let running = startRun(workspace, context.env);
  await waitForState(workspace, state => state.fixtures.discord.ready.length === 1);
  const owned = await liveThread(workspace, context, OWNED, "owner-1");
  await liveThread(workspace, context, LAPSED, "owner-2");
  await stopRun(workspace, context.env, running);

  // While the supervisor is down, the owner archives one thread and Discord
  // auto-archives the other, which has no audit-log entry.
  fixtures(workspace, discord => {
    discord.threads[OWNED] = { ...discord.threads[OWNED], archived: true, archiveTimestamp: "2026-09-28T10:10:00.000Z" };
    discord.threads[LAPSED] = { ...discord.threads[LAPSED], archived: true, archiveTimestamp: "2026-09-28T10:20:00.000Z" };
    discord.auditLogEntries = [archiveEntry(OWNED, "owner", "2026-09-28T10:10:00Z")];
  });
  fs.writeFileSync(context.clockFile, "2026-09-28T11:00:00Z\n");

  running = startRun(workspace, context.env);
  const closed = await waitForThread(workspace, context.env, OWNED, row => row?.state === "closed", "closed");
  assert.equal(closed.stop_reason, undefined);
  assert.equal(closed.provider_conversation_id, owned.provider_conversation_id);
  const lapsed = await waitForThread(workspace, context.env, LAPSED, row => row?.state === "stopped", "stopped");
  assert.equal(lapsed.stop_reason, "auto-archive");
  assert.equal(lapsed.archive, "archive-actor-unknown");
  assert.deepEqual(readState(workspace.stateDir).fixtures.tmux.sessions, {});
  assert.equal(claudeLaunches(workspace).length, 2, "no archived thread is restarted");
  await stopRun(workspace, context.env, running);
});

test("a restart marks a live thread whose tmux is gone as crashed and waits for the owner's next message", async () => {
  const workspace = createWorkspace();
  const context = setup(workspace);
  let running = startRun(workspace, context.env);
  await waitForState(workspace, state => state.fixtures.discord.ready.length === 1);
  const live = await liveThread(workspace, context, MISSED, "owner-1");
  await stopRun(workspace, context.env, running);

  // While the supervisor is down, the session dies mid-turn: its tmux session
  // and Claude process are gone and the owner's message is still unanswered.
  const [launch] = claudeLaunches(workspace);
  process.kill(launch.pid, "SIGKILL");
  const state = readState(workspace.stateDir);
  delete state.fixtures.tmux.sessions["demo_session-t-111111"];
  writeState(state, workspace.stateDir);
  seedHistory(workspace, MISSED, [historyMessage("owner-1", "2026-09-28T10:00:00Z", "owner", "fix the login redirect")]);

  running = startRun(workspace, context.env);
  const crashed = await waitForThread(workspace, context.env, MISSED, row => row?.state === "stopped", "stopped");
  assert.equal(crashed.stop_reason, "crashed");
  assert.equal(crashed.provider_conversation_id, live.provider_conversation_id);
  // A further pass, run by hand, starts nothing either.
  const again = await supervisor(workspace, context.env, "reconcile");
  assert.deepEqual([again.status, again.started, again.crashed], ["ok", [], []]);
  assert.equal(claudeLaunches(workspace).length, 1, "a crashed session is not restarted automatically");
  assert.equal((await supervisor(workspace, context.env, "status")).projects.demo.threads[MISSED].state, "stopped");

  injectDiscordMessage(workspace, { id: "owner-2", channelId: MISSED, channelType: 11, parentId: "channel",
    author: { id: "owner", username: "owner" }, content: "try again" });
  await waitForThread(workspace, context.env, MISSED, row => row?.state === "live", "live again");
  const relaunch = claudeLaunches(workspace)[1];
  assert.equal(relaunch.args[relaunch.args.indexOf("--resume") + 1], `'${live.provider_conversation_id}'`);
  await stopRun(workspace, context.env, running);
});

function gatewayEvent(workspace, event) {
  fixtures(workspace, discord => (discord.injectedGatewayEvents ||= []).push({ event, delivered: false }));
}

test("a Gateway disconnect and resume, or a new Gateway session, triggers the same reconciliation", async () => {
  const workspace = createWorkspace();
  const context = setup(workspace);
  const running = startRun(workspace, context.env);
  await waitForState(workspace, state => (state.fixtures.discord.threadListFetches ?? []).length === 1);

  // While the Gateway is disconnected, the owner opens a thread and writes in it.
  gatewayEvent(workspace, "shardDisconnect");
  fixtures(workspace, discord => {
    discord.threads = { [MISSED]: thread(MISSED, { autoArchiveDuration: THREE_DAYS_MINUTES }) };
  });
  seedHistory(workspace, MISSED, [historyMessage("missed-1", "2026-09-28T10:00:00Z", "owner", "fix the flaky login test")]);
  gatewayEvent(workspace, "shardResume");
  const missed = await waitForThread(workspace, context.env, MISSED, row => row?.state === "live", "live");
  assert.equal(missed.runtime_tmux, "demo_session-t-111111");
  assert.deepEqual(readState(workspace.stateDir).fixtures.discord.threadPatches.map(row => [row.threadId, row.body]),
    [[MISSED, { auto_archive_duration: ONE_WEEK_MINUTES }]]);

  // A later new Gateway session catches up on another missed thread.
  fixtures(workspace, discord => { discord.threads[ANSWERED] = thread(ANSWERED); });
  gatewayEvent(workspace, "shardReady");
  assert.deepEqual(await waitForThread(workspace, context.env, ANSWERED, row => row !== undefined, "bound"),
    { name: "thread 222222", creator_id: "owner", state: "registered" });
  assert.equal(claudeLaunches(workspace).length, 1);
  await stopRun(workspace, context.env, running);
});
