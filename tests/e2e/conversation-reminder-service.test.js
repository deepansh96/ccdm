import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { createWorkspace, runScript } from "./support/runner.js";
import { bridgeChildEnv, injectDiscordMessage, injectDiscordReaction, waitForState } from "./support/bridge.js";
import { readState, writeState } from "./support/state.js";
import { cleanup } from "./support/teardown.js";

test.afterEach(async () => cleanup());

function setup(workspace) {
  fs.writeFileSync(path.join(workspace.repoDir, "registry.json"), JSON.stringify({
    discord_user_id: "owner", guild_id: "guild",
    pool: [{ id: "bot", app_id: "app", token: "fixture-token" }],
    projects: { demo: { type: "codex", bot_id: "bot", channel_id: "channel", assignment_generation: "generation-1" } },
  }), { mode: 0o600 });
  return path.join(workspace.homeDir, ".local", "state", "ccdm", "conversation-reminders");
}

async function command(workspace, stateDir, name, extra = {}) {
  const result = await runScript(workspace, "scripts/conversation-reminder-service.py", {
    args: [name, "--project-root", workspace.repoDir, "--state-dir", stateDir], ...extra,
  });
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

async function event(workspace, stateDir, type, id, time, fields = {}) {
  const value = {
    schema_version: 1, event_id: id, event_type: type, project: "demo", channel_id: "channel",
    bot_id: "bot", assignment_generation: "generation-1", provider: "codex",
    event_time: time, event_order: `${time}:${id}`, adapter_instance_id: "test-adapter",
    ...fields,
  };
  const result = await runScript(workspace, "scripts/conversation-reminder-events.py", {
    args: ["ingest", "--project-root", workspace.repoDir, "--state-dir", stateDir], input: JSON.stringify(value),
  });
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.equal(JSON.parse(result.stdout).status, "committed");
}

async function waitForConversation(workspace, stateDir, predicate) {
  for (let attempt = 0; attempt < 80; attempt++) {
    const current = await command(workspace, stateDir, "status");
    if (predicate(current.conversations.demo)) return current;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for conversation state");
}

test("owner closure persists, normal owner message reopens, and a confirmed completion exposes its due time", async () => {
  const workspace = createWorkspace();
  const stateDir = setup(workspace);
  await event(workspace, stateDir, "owner_activity", "open-1", "2026-09-24T09:00:00Z", {
    actor_id: "owner", source_message_id: "owner-1", activity_kind: "message",
  });
  await command(workspace, stateDir, "sync");
  assert.equal((await command(workspace, stateDir, "status")).conversations.demo.state, "open-paused");

  await event(workspace, stateDir, "close_requested", "close-1", "2026-09-24T09:05:00Z", {
    actor_id: "owner", source_message_id: "close-message", command: "/close",
  });
  await command(workspace, stateDir, "sync");
  assert.equal((await command(workspace, stateDir, "status")).conversations.demo.state, "closed");

  await event(workspace, stateDir, "owner_activity", "open-2", "2026-09-24T09:10:00Z", {
    actor_id: "owner", source_message_id: "owner-2", activity_kind: "attachment",
  });
  await event(workspace, stateDir, "response_delivered", "receipt-1", "2026-09-24T10:00:00Z", {
    provider_session_id: "session", provider_turn_id: "turn", interaction_id: "owner-2",
    message_id: "answer-1", disposition: "progress", source_message_id: "owner-2",
  });
  await event(workspace, stateDir, "turn_completed", "complete-1", "2026-09-24T10:00:00Z", {
    provider_session_id: "session", provider_turn_id: "turn", interaction_id: "owner-2",
    delivered_message_ids: ["answer-1"],
  });
  await command(workspace, stateDir, "sync");
  const status = await command(workspace, stateDir, "status");
  assert.equal(status.conversations.demo.state, "awaiting-owner");
  assert.equal(status.conversations.demo.due_at, "2026-09-24T11:00:00Z");
  assert.equal(status.delivery_enabled, false);
});

test("the independent root observer consumes owner close and arbitrary reaction without a coding turn", async () => {
  const workspace = createWorkspace();
  const stateDir = setup(workspace);
  const rootState = path.join(workspace.homeDir, "root-discord");
  fs.mkdirSync(rootState, { recursive: true });
  fs.writeFileSync(path.join(rootState, ".env"), "DISCORD_BOT_TOKEN=fixture-root-token\n", { mode: 0o600 });

  const running = runScript(workspace, "scripts/conversation-reminder-service.py", {
    args: ["run", "--project-root", workspace.repoDir, "--state-dir", stateDir],
    env: bridgeChildEnv(workspace, { ROOT_DISCORD_STATE_DIR: rootState, CCDM_REMINDER_NODE: process.execPath }),
    timeoutMs: 10000,
  });
  await waitForState(workspace, state => state.fixtures.discord.logins.length === 1);
  injectDiscordMessage(workspace, { channelId: "channel", id: "guest-close", author: { id: "guest" }, content: "/close" });
  injectDiscordMessage(workspace, { channelId: "root-channel", id: "root-close", author: { id: "owner" }, content: "/close" });
  await waitForState(workspace, state => state.fixtures.discord.deliveredMessages.some(row => row.id === "root-close"));
  injectDiscordMessage(workspace, { channelId: "channel", id: "close-1", author: { id: "owner" }, content: "/close" });
  await waitForState(workspace, state => state.fixtures.discord.deliveredMessages.some(row => row.id === "close-1"));
  injectDiscordReaction(workspace, { channelId: "channel", id: "reaction-1", messageId: "ordinary-emoji",
    emoji: "custom:123", user: { id: "owner" } });
  await waitForState(workspace, state => state.fixtures.discord.deliveredReactions.some(row => row.id === "reaction-1"));
  const status = await waitForConversation(workspace, stateDir, current => current?.state === "closed");
  assert.equal(status.conversations.demo.state, "closed");
  const reactions = await waitForState(workspace, state => state.fixtures.discord.reactions.some(row =>
    row.messageId === "close-1" && decodeURIComponent(row.emoji) === "✅"));
  assert.equal(reactions.fixtures.discord.reactions.find(row => row.messageId === "close-1").authorization,
    "Bot fixture-token");
  assert.equal(readState(workspace.stateDir).fixtures.codex.appServerInvocations.length, 0);
  injectDiscordMessage(workspace, { channelId: "channel", id: "root-management", author: { id: "owner" },
    content: "<@fixture-bot-user-id> status" });
  await waitForState(workspace, state => state.fixtures.discord.deliveredMessages.some(row => row.id === "root-management"));
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.equal((await command(workspace, stateDir, "status")).conversations.demo.state, "closed");
  injectDiscordMessage(workspace, { channelId: "channel", id: "new-normal", author: { id: "owner" }, content: "/note" });
  const reopened = await waitForConversation(workspace, stateDir, current =>
    current?.state === "open-paused" && current?.last_ack_message_id === "new-normal");
  assert.equal(reopened.conversations.demo.state, "open-paused");
  await command(workspace, stateDir, "disable");
  const result = await running;
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
});

test("acknowledgment and a reopened exchange defeat delayed completion, while resume pauses input-needed", async () => {
  const workspace = createWorkspace();
  const stateDir = setup(workspace);
  await event(workspace, stateDir, "owner_activity", "owner-old", "2026-09-24T09:00:00Z", {
    actor_id: "owner", source_message_id: "old-question", activity_kind: "message",
  });
  await event(workspace, stateDir, "response_delivered", "old-receipt", "2026-09-24T09:10:00Z", {
    provider_session_id: "session", provider_turn_id: "old-turn", interaction_id: "old-question",
    message_id: "old-answer", disposition: "progress",
  });
  await event(workspace, stateDir, "owner_activity", "owner-reaction", "2026-09-24T09:11:00Z", {
    actor_id: "owner", source_message_id: "unrelated-target", activity_kind: "reaction",
  });
  await event(workspace, stateDir, "turn_completed", "old-completion", "2026-09-24T09:12:00Z", {
    provider_session_id: "session", provider_turn_id: "old-turn", interaction_id: "old-question",
    delivered_message_ids: ["old-answer"],
  });
  await command(workspace, stateDir, "sync");
  assert.equal((await command(workspace, stateDir, "status")).conversations.demo.state, "open-paused");

  await event(workspace, stateDir, "owner_activity", "owner-new", "2026-09-24T09:20:00Z", {
    actor_id: "owner", source_message_id: "new-question", activity_kind: "message",
  });
  await event(workspace, stateDir, "turn_completed", "late-old-completion", "2026-09-24T09:21:00Z", {
    provider_session_id: "session", provider_turn_id: "old-turn", interaction_id: "old-question",
    delivered_message_ids: ["old-answer"],
  });
  await event(workspace, stateDir, "response_delivered", "new-receipt", "2026-09-24T10:00:00Z", {
    provider_session_id: "session", provider_turn_id: "new-turn", interaction_id: "new-question",
    message_id: "new-answer", disposition: "input-needed",
  });
  await event(workspace, stateDir, "input_needed", "new-input", "2026-09-24T10:01:00Z", {
    provider_session_id: "session", provider_turn_id: "new-turn", interaction_id: "new-question",
    message_id: "new-answer", disposition: "input-needed",
  });
  await command(workspace, stateDir, "sync");
  assert.equal((await command(workspace, stateDir, "status")).conversations.demo.due_at, "2026-09-24T11:01:00Z");
  await event(workspace, stateDir, "work_resumed", "resumed", "2026-09-24T10:02:00Z", {
    provider_session_id: "session", provider_turn_id: "new-turn", interaction_id: "new-question",
    source_message_id: "new-question",
  });
  await command(workspace, stateDir, "sync");
  const status = await command(workspace, stateDir, "status");
  assert.equal(status.conversations.demo.state, "open-paused");
  assert.equal(status.conversations.demo.due_at, null);
});

test("closure ignores an older owner message that arrives late from another adapter", async () => {
  const workspace = createWorkspace();
  const stateDir = setup(workspace);
  await event(workspace, stateDir, "close_requested", "close-first", "2026-09-24T10:00:00Z", {
    actor_id: "owner", source_message_id: "close-message", command: "/close",
  });
  await event(workspace, stateDir, "owner_activity", "late-message", "2026-09-24T09:50:00Z", {
    actor_id: "owner", source_message_id: "old-message", activity_kind: "message",
  });
  await command(workspace, stateDir, "sync");
  assert.equal((await command(workspace, stateDir, "status")).conversations.demo.state, "closed");
});

test("observer rejects a channel when the assigned bot lacks required permissions", async () => {
  const workspace = createWorkspace();
  const stateDir = setup(workspace);
  const rootState = path.join(workspace.homeDir, "root-discord");
  fs.mkdirSync(rootState, { recursive: true });
  fs.writeFileSync(path.join(rootState, ".env"), "DISCORD_BOT_TOKEN=fixture-root-token\n", { mode: 0o600 });
  const fixture = readState(workspace.stateDir);
  fixture.fixtures.discord.permissionDenials = { app: ["SendMessages"] };
  writeState(fixture, workspace.stateDir);
  const running = runScript(workspace, "scripts/conversation-reminder-service.py", {
    args: ["run", "--project-root", workspace.repoDir, "--state-dir", stateDir],
    env: bridgeChildEnv(workspace, { ROOT_DISCORD_STATE_DIR: rootState, CCDM_REMINDER_NODE: process.execPath }),
    timeoutMs: 10000,
  });
  await waitForState(workspace, state => state.fixtures.discord.logins.length === 1);
  injectDiscordMessage(workspace, { channelId: "channel", id: "blocked-close", author: { id: "owner" }, content: "/close" });
  await waitForState(workspace, state => state.fixtures.discord.deliveredMessages.some(row => row.id === "blocked-close"));
  await new Promise(resolve => setTimeout(resolve, 1500));
  const deniedStatus = await command(workspace, stateDir, "status");
  const blocked = deniedStatus.conversations.demo;
  assert.equal(blocked.state, "open-paused");
  assert.equal(blocked.checkpoint, 0);
  assert.equal(deniedStatus.observer_channels.demo, "blocked-assigned-bot-permissions");
  await command(workspace, stateDir, "disable");
  assert.equal((await running).exitCode, 0);
});

test("duplicate owner observations from root and project adapters do not cancel a later response", async () => {
  const workspace = createWorkspace();
  const stateDir = setup(workspace);
  await event(workspace, stateDir, "owner_activity", "root-owner", "2026-09-24T09:00:00Z", {
    provider: "ccdm-root", actor_id: "owner", source_message_id: "owner-message", activity_kind: "message",
  });
  await event(workspace, stateDir, "response_delivered", "answer-receipt", "2026-09-24T10:00:00Z", {
    provider_session_id: "session", provider_turn_id: "turn", interaction_id: "owner-message",
    message_id: "answer", disposition: "progress",
  });
  await event(workspace, stateDir, "turn_completed", "answer-completion", "2026-09-24T10:01:00Z", {
    provider_session_id: "session", provider_turn_id: "turn", interaction_id: "owner-message",
    delivered_message_ids: ["answer"],
  });
  await event(workspace, stateDir, "owner_activity", "project-owner", "2026-09-24T10:02:00Z", {
    actor_id: "owner", source_message_id: "owner-message", activity_kind: "message",
  });
  await command(workspace, stateDir, "sync");
  assert.equal((await command(workspace, stateDir, "status")).conversations.demo.state, "awaiting-owner");
});

test("disable survives restart and explicit enable preserves a closed conversation", async () => {
  const workspace = createWorkspace();
  const stateDir = setup(workspace);
  await event(workspace, stateDir, "close_requested", "close-durable", "2026-09-24T10:00:00Z", {
    actor_id: "owner", source_message_id: "close-durable-message", command: "/close",
  });
  await command(workspace, stateDir, "sync");
  assert.equal((await command(workspace, stateDir, "disable")).disabled, true);
  const disabled = await command(workspace, stateDir, "status");
  assert.equal(disabled.conversations.demo.state, "closed");
  assert.equal(disabled.disabled, true);
  const enabled = await command(workspace, stateDir, "enable");
  assert.equal(enabled.disabled, false);
  assert.equal(enabled.conversations.demo.state, "closed");
});

test("a second foreground observer is refused while the first owns the store", async () => {
  const workspace = createWorkspace();
  const stateDir = setup(workspace);
  const rootState = path.join(workspace.homeDir, "root-discord");
  fs.mkdirSync(rootState, { recursive: true });
  fs.writeFileSync(path.join(rootState, ".env"), "DISCORD_BOT_TOKEN=fixture-root-token\n", { mode: 0o600 });
  const env = bridgeChildEnv(workspace, { ROOT_DISCORD_STATE_DIR: rootState, CCDM_REMINDER_NODE: process.execPath });
  const args = ["run", "--project-root", workspace.repoDir, "--state-dir", stateDir];
  const first = runScript(workspace, "scripts/conversation-reminder-service.py", { args, env, timeoutMs: 10000 });
  await waitForState(workspace, state => state.fixtures.discord.logins.length === 1);
  assert.equal((await command(workspace, stateDir, "status")).worker_running, true);
  const second = await runScript(workspace, "scripts/conversation-reminder-service.py", { args, env });
  assert.equal(second.exitCode, 2);
  assert.match(JSON.parse(second.stdout).reason, /already running/);
  await command(workspace, stateDir, "disable");
  assert.equal((await first).exitCode, 0);
});

test("missing root credentials fail the foreground observer closed", async () => {
  const workspace = createWorkspace();
  const stateDir = setup(workspace);
  const result = await runScript(workspace, "scripts/conversation-reminder-service.py", {
    args: ["run", "--project-root", workspace.repoDir, "--state-dir", stateDir],
    env: bridgeChildEnv(workspace, { ROOT_DISCORD_STATE_DIR: path.join(workspace.homeDir, "missing-root"),
      CCDM_REMINDER_NODE: process.execPath }), timeoutMs: 5000,
  });
  assert.equal(result.exitCode, 2);
  assert.equal(JSON.parse(result.stdout).status, "blocked");
  assert.equal(readState(workspace.stateDir).fixtures.discord.logins.length, 0);
});

test("a corrupt conversation store is reported without initializing over it", async () => {
  const workspace = createWorkspace();
  const stateDir = setup(workspace);
  fs.mkdirSync(stateDir, { recursive: true });
  const database = path.join(stateDir, "conversations.sqlite3");
  fs.writeFileSync(database, "invalid database", { mode: 0o600 });
  const result = await runScript(workspace, "scripts/conversation-reminder-service.py", {
    args: ["sync", "--project-root", workspace.repoDir, "--state-dir", stateDir],
  });
  assert.equal(result.exitCode, 2);
  assert.equal(JSON.parse(result.stdout).status, "blocked");
  assert.equal(fs.readFileSync(database, "utf8"), "invalid database");
});

test("an existing unversioned store is never silently replaced", async () => {
  const workspace = createWorkspace();
  const stateDir = setup(workspace);
  fs.mkdirSync(stateDir, { recursive: true });
  const database = path.join(stateDir, "conversations.sqlite3");
  fs.writeFileSync(database, "", { mode: 0o600 });
  const result = await runScript(workspace, "scripts/conversation-reminder-service.py", {
    args: ["sync", "--project-root", workspace.repoDir, "--state-dir", stateDir],
  });
  assert.equal(result.exitCode, 2);
  assert.equal(JSON.parse(result.stdout).status, "blocked");
});

test("a versioned store with the wrong table shape fails closed", async () => {
  const workspace = createWorkspace();
  const stateDir = setup(workspace);
  fs.mkdirSync(stateDir, { recursive: true });
  const database = path.join(stateDir, "conversations.sqlite3");
  const seeded = spawnSync("python3", ["-c", `import sqlite3,sys
db=sqlite3.connect(sys.argv[1]); db.executescript("""
CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT); INSERT INTO settings VALUES('disabled','0');
CREATE TABLE conversations(project TEXT PRIMARY KEY);
CREATE TABLE applied_events(event_id TEXT PRIMARY KEY);
CREATE TABLE owner_sources(project TEXT);
CREATE TABLE qualifications(project TEXT);
CREATE TABLE pending_actions(action_id TEXT PRIMARY KEY);
PRAGMA user_version=1;
"""); db.close()`, database], { encoding: "utf8" });
  assert.equal(seeded.status, 0, seeded.stderr);
  fs.chmodSync(database, 0o600);
  const result = await runScript(workspace, "scripts/conversation-reminder-service.py", {
    args: ["status", "--project-root", workspace.repoDir, "--state-dir", stateDir],
  });
  assert.equal(result.exitCode, 2);
  assert.equal(JSON.parse(result.stdout).status, "blocked");
});

test("an idle registered project is visible as suspended until discovery is implemented", async () => {
  const workspace = createWorkspace();
  const stateDir = setup(workspace);
  await command(workspace, stateDir, "sync");
  const status = await command(workspace, stateDir, "status");
  assert.equal(status.conversations.demo.reconciliation_status, "suspended-incomplete-discovery");
  assert.equal(status.conversations.demo.state, "open-paused");
});

test("a subsecond completion never gets an early due time", async () => {
  const workspace = createWorkspace();
  const stateDir = setup(workspace);
  await event(workspace, stateDir, "owner_activity", "subsecond-owner", "2026-09-24T09:00:00Z", {
    actor_id: "owner", source_message_id: "subsecond-question", activity_kind: "message",
  });
  await event(workspace, stateDir, "response_delivered", "subsecond-receipt", "2026-09-24T10:00:00.500Z", {
    provider_session_id: "session", provider_turn_id: "turn", interaction_id: "subsecond-question",
    message_id: "subsecond-answer", disposition: "progress",
  });
  await event(workspace, stateDir, "turn_completed", "subsecond-completion", "2026-09-24T10:00:00.500Z", {
    provider_session_id: "session", provider_turn_id: "turn", interaction_id: "subsecond-question",
    delivered_message_ids: ["subsecond-answer"],
  });
  await command(workspace, stateDir, "sync");
  assert.equal((await command(workspace, stateDir, "status")).conversations.demo.due_at,
    "2026-09-24T11:00:00.500Z");
});

test("a close without a Discord message identity is rejected before state processing", async () => {
  const workspace = createWorkspace();
  const stateDir = setup(workspace);
  for (const source of [undefined, ""]) {
    const result = await runScript(workspace, "scripts/conversation-reminder-events.py", {
      args: ["ingest", "--project-root", workspace.repoDir, "--state-dir", stateDir],
      input: JSON.stringify({
        schema_version: 1, event_id: `missing-close-source-${String(source)}`, event_type: "close_requested",
        project: "demo", channel_id: "channel", bot_id: "bot", assignment_generation: "generation-1",
        provider: "ccdm-root", event_time: "2026-09-24T10:00:00Z", event_order: "close-order",
        adapter_instance_id: "test-adapter", actor_id: "owner", command: "/close",
        source_message_id: source,
      }),
    });
    assert.equal(result.exitCode, 0);
    assert.equal(JSON.parse(result.stdout).status, "rejected");
  }
});

test("a duplicate completion for the same visible answer cannot postpone its due time", async () => {
  const workspace = createWorkspace();
  const stateDir = setup(workspace);
  await event(workspace, stateDir, "owner_activity", "duplicate-owner", "2026-09-24T09:00:00Z", {
    actor_id: "owner", source_message_id: "duplicate-question", activity_kind: "message",
  });
  await event(workspace, stateDir, "response_delivered", "duplicate-receipt", "2026-09-24T10:00:00Z", {
    provider_session_id: "session", provider_turn_id: "turn", interaction_id: "duplicate-question",
    message_id: "answer", disposition: "progress",
  });
  for (const [id, time] of [["completion-first", "2026-09-24T10:00:00Z"],
    ["completion-duplicate", "2026-09-24T10:30:00Z"]]) {
    await event(workspace, stateDir, "turn_completed", id, time, {
      provider_session_id: "session", provider_turn_id: "turn", interaction_id: "duplicate-question",
      delivered_message_ids: ["answer"],
    });
  }
  await command(workspace, stateDir, "sync");
  assert.equal((await command(workspace, stateDir, "status")).conversations.demo.due_at,
    "2026-09-24T11:00:00Z");
});
