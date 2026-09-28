import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { createWorkspace, runNodeEntrypoint, runScript } from "./support/runner.js";
import { bridgeChildEnv, injectDiscordMessage, injectDiscordThread, injectDiscordThreadDelete,
  injectDiscordThreadUpdate, waitForState } from "./support/bridge.js";
import { readState, writeState } from "./support/state.js";
import { cleanup } from "./support/teardown.js";

test.afterEach(async () => cleanup());

// Discord snowflakes; a thread's tmux name ends in its last six digits.
const THREAD = "1500000000000123456";
const OTHER_THREAD = "1500000000000654321";
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
  return { botState, claudeHome, projectDir, clockFile, env,
    threadDir: threadId => path.join(botState, "threads", threadId) };
}

function seedAuditLog(workspace, entries, extra = {}) {
  const state = readState(workspace.stateDir);
  state.fixtures.discord.auditLogEntries = entries;
  Object.assign(state.fixtures.discord, extra);
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

async function waitForThread(workspace, env, threadId, predicate, label, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let current;
  while (Date.now() < deadline) {
    current = await status(workspace, env);
    const thread = current.projects.demo?.threads[threadId];
    if (predicate(thread)) return thread;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for thread ${threadId} to be ${label}: ${JSON.stringify(current)}`);
}

async function stopRun(workspace, env, running) {
  const current = await status(workspace, env);
  process.kill(-current.worker_pid, "SIGTERM");
  const result = await running;
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
}

function message(workspace, id, content, threadId = THREAD, author = { id: "owner", username: "owner" }) {
  injectDiscordMessage(workspace, { id, channelId: threadId, channelType: 11, parentId: "channel", author, content });
}

// Starts the supervisor and brings a thread live with one owner message.
async function liveThread(workspace, context, threadId = THREAD, messageId = "owner-1") {
  injectDiscordThread(workspace, { id: threadId, parentId: "channel", name: "Login bug", ownerId: "owner",
    autoArchiveDuration: 10080 });
  message(workspace, messageId, "fix the login redirect", threadId);
  return waitForThread(workspace, context.env, threadId, row => row?.state === "live", "live");
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

async function gatewayDrained(workspace) {
  await waitForState(workspace, state => (state.fixtures.discord.injectedThreads ?? []).every(row => row.delivered) &&
    state.fixtures.discord.injectedMessages.every(row => row.delivered));
  // Let the observer hand the last event to the service.
  await new Promise(resolve => setTimeout(resolve, 1500));
}

const decoded = rows => rows.map(row => ({ ...row, emoji: decodeURIComponent(row.emoji) }));

test("an owner archive closes the thread and a root archive does too, each stopping its session", async () => {
  const workspace = createWorkspace();
  const context = setup(workspace);
  const running = startRun(workspace, context.env);
  await waitForState(workspace, state => state.fixtures.discord.ready.length === 1);
  const owned = await liveThread(workspace, context);
  const rooted = await liveThread(workspace, context, OTHER_THREAD, "owner-2");
  const [first, second] = readState(workspace.stateDir).fixtures.claude.invocations;

  seedAuditLog(workspace, [archiveEntry(OTHER_THREAD, "root-app", "2026-09-28T10:05:00Z"),
    archiveEntry(THREAD, "owner", "2026-09-28T10:05:00Z")]);
  fs.writeFileSync(context.clockFile, "2026-09-28T10:05:00Z\n");
  archive(workspace, THREAD, "2026-09-28T10:05:00Z");
  archive(workspace, OTHER_THREAD, "2026-09-28T10:05:00Z");

  const closed = await waitForThread(workspace, context.env, THREAD, row => row?.state === "closed", "closed");
  const rootClosed = await waitForThread(workspace, context.env, OTHER_THREAD, row => row?.state === "closed", "closed");
  assert.equal(closed.stop_reason, undefined);
  assert.equal(closed.provider_conversation_id, owned.provider_conversation_id);
  assert.equal(rootClosed.provider_conversation_id, rooted.provider_conversation_id);
  assert.equal(closed.archive, undefined);
  const state = readState(workspace.stateDir);
  assert.deepEqual(state.fixtures.tmux.sessions, {});
  assert.equal(alive(first.pid), false, "the owner-archived thread's Claude process is gone");
  assert.equal(alive(second.pid), false, "the root-archived thread's Claude process is gone");
  // The archive actor is read with root credentials from action 111.
  assert.ok(state.fixtures.discord.auditLogFetches.length >= 2);
  for (const fetch of state.fixtures.discord.auditLogFetches) {
    assert.deepEqual([fetch.authorization, fetch.guildId, fetch.actionType], ["Bot fixture-root-token", "guild", "111"]);
  }
  await stopRun(workspace, context.env, running);
});

test("a non-owner actor or no audit-log entry within 60 seconds only stops the session as an auto-archive", async () => {
  const workspace = createWorkspace();
  const context = setup(workspace);
  const running = startRun(workspace, context.env);
  await waitForState(workspace, state => state.fixtures.discord.ready.length === 1);
  await liveThread(workspace, context);
  await liveThread(workspace, context, OTHER_THREAD, "owner-2");

  // The guest archived THREAD. OTHER_THREAD has only an owner archive from
  // a week earlier, which is not this archive.
  seedAuditLog(workspace, [archiveEntry(THREAD, "guest", "2026-09-28T10:05:00Z"),
    archiveEntry(OTHER_THREAD, "owner", "2026-09-21T10:00:00Z")]);
  fs.writeFileSync(context.clockFile, "2026-09-28T10:05:00Z\n");
  archive(workspace, THREAD, "2026-09-28T10:05:00Z");
  archive(workspace, OTHER_THREAD, "2026-09-28T10:05:00Z");

  const guestArchived = await waitForThread(workspace, context.env, THREAD, row => row?.state === "stopped", "stopped");
  assert.equal(guestArchived.stop_reason, "auto-archive");
  assert.equal(guestArchived.archive, undefined);
  // No actor yet: the lookup keeps retrying and the session keeps running.
  await new Promise(resolve => setTimeout(resolve, 1500));
  assert.equal((await status(workspace, context.env)).projects.demo.threads[OTHER_THREAD].state, "live");
  assert.ok(readState(workspace.stateDir).fixtures.tmux.sessions["demo_session-t-654321"]);

  fs.writeFileSync(context.clockFile, "2026-09-28T10:06:01Z\n");
  const unknown = await waitForThread(workspace, context.env, OTHER_THREAD, row => row?.state === "stopped", "stopped");
  assert.equal(unknown.stop_reason, "auto-archive");
  assert.equal(unknown.archive, "archive-actor-unknown");
  assert.deepEqual(readState(workspace.stateDir).fixtures.tmux.sessions, {});
  await stopRun(workspace, context.env, running);
});

test("an audit-log 403 falls back to auto-archive at once, and preflight names View Audit Log", async () => {
  const workspace = createWorkspace();
  const context = setup(workspace);
  const ready = await runScript(workspace, "scripts/thread-supervisor.py", { args: ["preflight"], env: context.env });
  assert.equal(ready.exitCode, 0, ready.stdout);
  assert.deepEqual(JSON.parse(ready.stdout).blockers, []);

  const running = startRun(workspace, context.env);
  await waitForState(workspace, state => state.fixtures.discord.ready.length === 1);
  await liveThread(workspace, context);
  seedAuditLog(workspace, [archiveEntry(THREAD, "owner", "2026-09-28T10:05:00Z")], { auditLogForbidden: true });
  archive(workspace, THREAD, "2026-09-28T10:05:00Z");
  // The clock never advances: a 403 does not wait out the retry window.
  const stopped = await waitForThread(workspace, context.env, THREAD, row => row?.state === "stopped", "stopped");
  assert.equal(stopped.stop_reason, "auto-archive");
  assert.equal(stopped.archive, "archive-actor-unknown");
  assert.deepEqual(readState(workspace.stateDir).fixtures.tmux.sessions, {});
  await stopRun(workspace, context.env, running);

  const blocked = await runScript(workspace, "scripts/thread-supervisor.py", { args: ["preflight"], env: context.env });
  assert.equal(blocked.exitCode, 2, blocked.stdout);
  const blockers = JSON.parse(blocked.stdout).blockers;
  assert.equal(blockers.length, 1, blockers.join("\n"));
  assert.match(blockers[0], /root bot lacks View Audit Log/);
});

test("deleting a thread forgets it and its runtime files but keeps the Claude session file", async () => {
  const workspace = createWorkspace();
  const context = setup(workspace);
  const running = startRun(workspace, context.env);
  await waitForState(workspace, state => state.fixtures.discord.ready.length === 1);
  await liveThread(workspace, context);
  const [invocation] = readState(workspace.stateDir).fixtures.claude.invocations;
  assert.ok(fs.existsSync(context.threadDir(THREAD)));

  injectDiscordThreadDelete(workspace, THREAD);
  await waitForThread(workspace, context.env, THREAD, row => row === undefined, "forgotten");
  assert.deepEqual(readState(workspace.stateDir).fixtures.tmux.sessions, {});
  assert.equal(alive(invocation.pid), false);
  assert.equal(fs.existsSync(context.threadDir(THREAD)), false);
  assert.ok(fs.existsSync(path.join(context.claudeHome, "sessions", `${invocation.pid}.json`)),
    "the provider conversation stays on disk");
  await stopRun(workspace, context.env, running);
});

test("a stopped thread keeps its row, ignores guests and bot reopening, and resumes on the owner's message", async () => {
  const workspace = createWorkspace();
  const context = setup(workspace);
  const running = startRun(workspace, context.env);
  await waitForState(workspace, state => state.fixtures.discord.ready.length === 1);
  const first = await liveThread(workspace, context);
  const sessionId = first.provider_conversation_id;
  seedAuditLog(workspace, [archiveEntry(THREAD, "guest", "2026-09-28T10:05:00Z")]);
  fs.writeFileSync(context.clockFile, "2026-09-28T10:05:00Z\n");
  archive(workspace, THREAD, "2026-09-28T10:05:00Z");
  const stopped = await waitForThread(workspace, context.env, THREAD, row => row?.state === "stopped", "stopped");
  assert.equal(stopped.stop_reason, "auto-archive");
  // The row persists while every per-thread runtime file is removed.
  assert.equal(stopped.provider_conversation_id, sessionId);
  assert.equal(fs.existsSync(context.threadDir(THREAD)), false);
  assert.deepEqual(fs.readdirSync(path.join(context.botState, "threads")), []);

  // A guest message starts nothing.
  message(workspace, "guest-1", "is anyone there?", THREAD, { id: "guest", username: "guest" });
  // The project bot posts into the archived thread, as a reminder would:
  // Discord reopens it and re-sends THREAD_CREATE.
  const posted = await runNodeEntrypoint(workspace, "scripts/thread-supervisor-discord.js", {
    args: ["post", JSON.stringify({ project_root: workspace.repoDir, bot_id: "bot", channel_id: THREAD,
      content: "👀" })], env: context.env });
  assert.equal(posted.exitCode, 0, posted.stderr);
  await gatewayDrained(workspace);
  let state = readState(workspace.stateDir);
  assert.deepEqual(state.fixtures.discord.deliveredThreads.slice(-2), [{ id: THREAD, event: "update" },
    { id: THREAD, event: "create" }]);
  assert.equal(state.fixtures.claude.invocations.length, 1);
  assert.deepEqual(state.fixtures.tmux.sessions, {});
  const unchanged = await status(workspace, context.env);
  assert.deepEqual(Object.keys(unchanged.projects.demo.threads), [THREAD]);
  assert.equal(unchanged.projects.demo.threads[THREAD].state, "stopped");
  assert.equal(unchanged.projects.demo.threads[THREAD].stop_reason, "auto-archive");

  message(workspace, "owner-2", "back to it");
  const resumed = await waitForThread(workspace, context.env, THREAD, row => row?.state === "live", "live again");
  assert.equal(resumed.provider_conversation_id, sessionId);
  state = readState(workspace.stateDir);
  assert.equal(state.fixtures.claude.invocations.length, 2);
  const relaunch = state.fixtures.claude.invocations[1];
  assert.equal(relaunch.args[relaunch.args.indexOf("--resume") + 1], `'${sessionId}'`);
  assert.equal(relaunch.env.CLAUDE_CONFIG_DIR, context.claudeHome);
  assert.equal(relaunch.cwd, context.projectDir);
  assert.equal(state.fixtures.claude.invocations[0].args.includes("--resume"), false);
  const onResume = row => row.messageId === "owner-2";
  assert.deepEqual(decoded(state.fixtures.discord.reactions).filter(onResume), [{ authorization: "Bot project-token",
    channelId: THREAD, emoji: "👀", messageId: "owner-2" }]);
  await waitForState(workspace, next => next.fixtures.discord.reactionDeletes.some(onResume));
  await stopRun(workspace, context.env, running);
});
