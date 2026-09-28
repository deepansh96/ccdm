import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { createWorkspace, runScript } from "./support/runner.js";
import { bridgeChildEnv, injectDiscordMessage, injectDiscordThread, waitForState } from "./support/bridge.js";
import { readState, seedTmuxSession, writeState } from "./support/state.js";
import { cleanup } from "./support/teardown.js";

test.afterEach(async () => cleanup());

// A Claude project (`demo`, bot user `demo-app`) whose Thread Conversations
// are reminded by the Conversation Reminder service beside the Thread Supervisor.
const THREAD = "1500000000000123456";
const READY_SCREEN = "Listening for channel messages from: server:discord\n";

function setup(workspace) {
  const projectDir = path.join(workspace.tmpDir, "project");
  fs.mkdirSync(projectDir, { recursive: true });
  const claudeHome = path.join(workspace.homeDir, ".claude-work");
  const plugin = path.join(claudeHome, "plugins", "cache", "claude-plugins-official", "discord", "0.0.4");
  fs.mkdirSync(plugin, { recursive: true });
  fs.writeFileSync(path.join(plugin, "server.ts"), "// fixture official plugin\n");
  const demoState = path.join(workspace.homeDir, ".claude", "channels", "discord-demo");
  fs.mkdirSync(demoState, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(demoState, ".env"), "DISCORD_BOT_TOKEN=demo-token\n", { mode: 0o600 });
  fs.writeFileSync(path.join(workspace.repoDir, "registry.json"), JSON.stringify({
    discord_user_id: "owner", guild_id: "guild", root_bot_app_id: "root-app",
    pool: [{ id: "demo-bot", app_id: "demo-app", token: "demo-token", state_dir: demoState, assigned_to: "demo" }],
    projects: { demo: { type: "claude", path: projectDir, bot_id: "demo-bot", channel_id: "channel",
      screen_name: "demo_session", assignment_generation: "generation-1", model: "claude-opus-5-5",
      claude_effort: "high", claude_home: claudeHome } },
  }, null, 2), { mode: 0o600 });
  const rootState = path.join(workspace.homeDir, "root-discord");
  fs.mkdirSync(rootState, { recursive: true });
  fs.writeFileSync(path.join(rootState, ".env"), "DISCORD_BOT_TOKEN=fixture-root-token\n", { mode: 0o600 });
  const seed = readState(workspace.stateDir);
  // The supervisor and the reminder observer each receive every Gateway event.
  seed.fixtures.discord.fanOut = true;
  seed.fixtures.tmux.claudeBootScreens = [READY_SCREEN];
  writeState(seed, workspace.stateDir);
  seedTmuxSession("demo_session", { paneOutput: "Listening for channel messages\n" }, { stateDir: workspace.stateDir });
  const threadClock = path.join(workspace.tmpDir, "thread-clock");
  fs.writeFileSync(threadClock, "2026-09-24T09:00:00Z\n");
  const clockFile = path.join(workspace.tmpDir, "reminder-clock");
  fs.writeFileSync(clockFile, "2026-09-24T10:30:00Z");
  const env = bridgeChildEnv(workspace, { ROOT_DISCORD_STATE_DIR: rootState, CCDM_THREAD_NODE: process.execPath,
    CCDM_THREAD_CLOCK_FILE: threadClock, CCDM_FIXTURE_CLAUDE_VERSION: "2.1.281 (Claude Code)",
    CCDM_REMINDER_NODE: process.execPath, CCDM_REMINDER_CLOCK_FILE: clockFile });
  return { env, clockFile, stateDir: path.join(workspace.homeDir, ".local", "state", "ccdm", "conversation-reminders") };
}

async function supervisor(workspace, context, command, payload) {
  const result = await runScript(workspace, "scripts/thread-supervisor.py", {
    args: [command, "--project-root", workspace.repoDir, ...(payload ? ["--payload", JSON.stringify(payload)] : [])],
    env: context.env });
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

async function reminders(workspace, context, command) {
  const result = await runScript(workspace, "scripts/conversation-reminder-service.py", {
    args: [command, "--project-root", workspace.repoDir, "--state-dir", context.stateDir], env: context.env });
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

// An owner question at 09:00 answered at 10:00 by the thread's Claude session.
async function threadExchange(workspace, context) {
  const base = { schema_version: 1, project: "demo", channel_id: "channel", conversation_id: THREAD,
    bot_id: "demo-bot", assignment_generation: "generation-1", provider: "claude", adapter_instance_id: "test" };
  const turn = { provider_session_id: "claude-session", provider_turn_id: "turn", interaction_id: "question" };
  for (const [id, type, time, fields] of [
    ["owner", "owner_activity", "2026-09-24T09:00:00Z", { actor_id: "owner", source_message_id: "question",
      activity_kind: "message" }],
    ["receipt", "response_delivered", "2026-09-24T10:00:00Z", { ...turn, message_id: "answer",
      disposition: "progress" }],
    ["completion", "turn_completed", "2026-09-24T10:00:00Z", { ...turn, delivered_message_ids: ["answer"] }],
  ]) {
    const result = await runScript(workspace, "scripts/conversation-reminder-events.py", {
      args: ["ingest", "--project-root", workspace.repoDir, "--state-dir", context.stateDir], env: context.env,
      input: JSON.stringify({ ...base, ...fields, event_id: id, event_type: type, event_time: time,
        event_order: `${time}:${id}` }) });
    assert.equal(JSON.parse(result.stdout).status, "committed", result.stderr || result.stdout);
  }
}

function startWorker(workspace, context) {
  return runScript(workspace, "scripts/conversation-reminder-service.py", {
    args: ["run", "--project-root", workspace.repoDir, "--state-dir", context.stateDir], env: context.env,
    timeoutMs: 60000 });
}

async function threadStatus(workspace, context, predicate) {
  let current;
  for (let attempt = 0; attempt < 200; attempt++) {
    current = await reminders(workspace, context, "status");
    const thread = current.readiness?.projects?.demo?.threads?.[THREAD];
    if (thread && predicate(thread.conversation)) return thread.conversation;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for the thread's reminder state: ${JSON.stringify(current)}`);
}

async function recordedEvents(workspace, context) {
  const result = await runScript(workspace, "scripts/conversation-reminder-readiness.py", {
    args: ["demo", "--json", "--state-dir", context.stateDir, "--conversation", THREAD], env: context.env });
  return JSON.parse(result.stdout).events;
}

const posts = (state, channelId) => (state.fixtures.discord.messages ?? [])
  .filter(message => message.channelId === channelId);
const reminderPosts = (state, channelId) => posts(state, channelId).filter(message => message.content === "👀");

// Waits until the thread's first reminder is posted at 11:00, an hour after its answer.
async function remindedThread(workspace, context) {
  await threadExchange(workspace, context);
  await reminders(workspace, context, "discover");
  const running = startWorker(workspace, context);
  await waitForState(workspace, state => state.fixtures.discord.logins.some(row => row.token === "fixture-root-token"));
  fs.writeFileSync(context.clockFile, "2026-09-24T11:00:00Z");
  const state = await waitForState(workspace, next => reminderPosts(next, THREAD).length === 1, 15000);
  return { running, reminder: reminderPosts(state, THREAD)[0] };
}

test("an owner-confirmed provider switch deletes the thread's outstanding reminder and restarts its tracking fresh", async () => {
  const workspace = createWorkspace();
  const context = setup(workspace);
  await supervisor(workspace, context, "bind", { thread_id: THREAD, type: 11, parent_id: "channel", parent_type: 0,
    name: "Login bug", creator_id: "owner", auto_archive_duration: 10080 });
  const { running, reminder } = await remindedThread(workspace, context);
  assert.equal(reminder.authorization, "Bot demo-token");

  // The supervisor's observer hands over the owner's /config and ✅; neither
  // reaches the reminder observer, so only the switch can remove the reminder.
  const pending = await supervisor(workspace, context, "message", { thread_id: THREAD, message_id: "config-1",
    author_id: "owner", author_name: "owner", content: "/config provider=codex", type: 0 });
  assert.equal(pending.result, "config-pending");
  const warning = posts(readState(workspace.stateDir), THREAD).find(message => /fresh conversation/.test(message.content));
  const applied = await supervisor(workspace, context, "reaction", { thread_id: THREAD, message_id: warning.id,
    user_id: "owner", emoji: "✅" });
  assert.equal(applied.result, "config-applied");

  const deleted = await waitForState(workspace, state => (state.fixtures.discord.deletes ?? [])
    .some(row => row.messageId === reminder.id), 15000);
  assert.deepEqual(deleted.fixtures.discord.deletes.map(row => [row.channelId, row.messageId, row.authorization]),
    [[THREAD, reminder.id, "Bot demo-token"]]);
  const fresh = await threadStatus(workspace, context, row => row.reminder_message_id === null &&
    row.cleanup_message_ids.length === 0);
  assert.deepEqual([fresh.state, fresh.due_at, fresh.consecutive_reminders, fresh.current_interaction_id,
    fresh.response_message_id, fresh.response_at], ["open-paused", null, 0, null, null, null]);
  assert.deepEqual((await recordedEvents(workspace, context)).filter(row => row.event_type === "conversation_reset")
    .map(row => [row.conversation_id, row.provider]), [[THREAD, "ccdm-root"]]);

  // The old answer's next reminder, due at 13:00, never comes.
  fs.writeFileSync(context.clockFile, "2026-09-24T13:00:10Z");
  await new Promise(resolve => setTimeout(resolve, 1500));
  assert.equal(reminderPosts(readState(workspace.stateDir), THREAD).length, 1);
  await reminders(workspace, context, "disable");
  assert.equal((await running).exitCode, 0);
});

test("/clear in a thread keeps its reminder conversation continuous", async () => {
  const workspace = createWorkspace();
  const context = setup(workspace);
  const threads = runScript(workspace, "scripts/thread-supervisor.py", { args: ["run", "--project-root",
    workspace.repoDir], env: context.env, timeoutMs: 60000 });
  await waitForState(workspace, state => state.fixtures.discord.ready.length === 1);
  injectDiscordThread(workspace, { id: THREAD, parentId: "channel", name: "Login bug", ownerId: "owner",
    autoArchiveDuration: 10080 });
  injectDiscordMessage(workspace, { id: "question", channelId: THREAD, channelType: 11, parentId: "channel",
    author: { id: "owner", username: "owner" }, content: "fix the login redirect" });
  const live = async predicate => {
    for (let attempt = 0; attempt < 300; attempt++) {
      const row = (await supervisor(workspace, context, "status")).projects?.demo?.threads?.[THREAD];
      if (row && predicate(row)) return row;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error("Timed out waiting for the thread's session");
  };
  const first = await live(row => row.state === "live");
  const { running, reminder } = await remindedThread(workspace, context);

  // The owner's /clear is a Conversation Reply: it clears the reminder, and
  // the thread's fresh Claude session continues the same reminder conversation.
  injectDiscordMessage(workspace, { id: "clear-1", channelId: THREAD, channelType: 11, parentId: "channel",
    author: { id: "owner", username: "owner" }, content: "/clear" });
  await live(row => row.state === "live" && row.provider_conversation_id !== first.provider_conversation_id);
  await waitForState(workspace, state => (state.fixtures.discord.deletes ?? []).some(row => row.messageId === reminder.id),
    15000);
  const continued = await threadStatus(workspace, context, row => row.last_ack_message_id === "clear-1" &&
    row.reminder_message_id === null);
  assert.deepEqual([continued.state, continued.current_interaction_id, continued.response_message_id,
    continued.response_at], ["open-paused", "question", "answer", "2026-09-24T10:00:00Z"]);
  const events = await recordedEvents(workspace, context);
  assert.deepEqual(events.filter(row => row.event_type === "conversation_reset"), []);
  assert.deepEqual(events.filter(row => row.source_message_id === "clear-1").map(row => row.activity_kind),
    ["management-command"]);
  await reminders(workspace, context, "disable");
  assert.equal((await running).exitCode, 0);
  const current = await supervisor(workspace, context, "status");
  process.kill(-current.worker_pid, "SIGTERM");
  assert.equal((await threads).exitCode, 0);
});
