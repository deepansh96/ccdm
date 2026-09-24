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

async function reconciledExchange(workspace, stateDir) {
  await event(workspace, stateDir, "owner_activity", "delivery-owner", "2026-09-24T09:00:00Z", {
    actor_id: "owner", source_message_id: "delivery-question", activity_kind: "message",
  });
  await event(workspace, stateDir, "response_delivered", "delivery-receipt", "2026-09-24T10:00:00Z", {
    provider_session_id: "session", provider_turn_id: "turn", interaction_id: "delivery-question",
    message_id: "delivery-answer", disposition: "progress",
  });
  await event(workspace, stateDir, "turn_completed", "delivery-completion", "2026-09-24T10:00:00Z", {
    provider_session_id: "session", provider_turn_id: "turn", interaction_id: "delivery-question",
    delivered_message_ids: ["delivery-answer"],
  });
  await command(workspace, stateDir, "sync");
  // A later discovery slice will establish this state through reconciliation.
  // Seed only the prerequisite; drive and assert delivery through executable surfaces.
  const database = path.join(stateDir, "conversations.sqlite3");
  const seeded = spawnSync("python3", ["-c", "import sqlite3,sys; db=sqlite3.connect(sys.argv[1]); db.execute(\"UPDATE conversations SET reconciliation_status='ready' WHERE project='demo'\"); db.commit()", database], { encoding: "utf8" });
  assert.equal(seeded.status, 0, seeded.stderr);
}

test("a reconciled Project Conversation gets its first emoji only after a full hour", async () => {
  const workspace = createWorkspace();
  const stateDir = setup(workspace);
  await reconciledExchange(workspace, stateDir);
  const rootState = path.join(workspace.homeDir, "root-discord");
  fs.mkdirSync(rootState, { recursive: true });
  fs.writeFileSync(path.join(rootState, ".env"), "DISCORD_BOT_TOKEN=fixture-root-token\n", { mode: 0o600 });
  const clockFile = path.join(workspace.tmpDir, "reminder-clock");
  fs.writeFileSync(clockFile, "2026-09-24T10:59:59Z");
  const running = runScript(workspace, "scripts/conversation-reminder-service.py", {
    args: ["run", "--project-root", workspace.repoDir, "--state-dir", stateDir],
    env: bridgeChildEnv(workspace, { ROOT_DISCORD_STATE_DIR: rootState,
      CCDM_REMINDER_NODE: process.execPath, CCDM_REMINDER_CLOCK_FILE: clockFile }),
    timeoutMs: 10000,
  });
  await waitForState(workspace, state => state.fixtures.discord.logins.length === 1);
  await new Promise(resolve => setTimeout(resolve, 600));
  assert.equal(readState(workspace.stateDir).fixtures.discord.messages.length, 0);
  fs.writeFileSync(clockFile, "2026-09-24T11:00:00Z");
  const sent = await waitForState(workspace, state => state.fixtures.discord.messages.length === 1);
  assert.equal(sent.fixtures.discord.messages[0].content, "👀");
  assert.equal(sent.fixtures.discord.messages[0].authorization, "Bot fixture-token");
  assert.equal(sent.fixtures.codex.appServerInvocations.length, 0);
  await command(workspace, stateDir, "disable");
  assert.equal((await running).exitCode, 0);
});

test("hourly replacement sends the exact emoji before deleting only the recorded reminder", async () => {
  const workspace = createWorkspace();
  const stateDir = setup(workspace);
  await reconciledExchange(workspace, stateDir);
  const rootState = path.join(workspace.homeDir, "root-discord");
  fs.mkdirSync(rootState, { recursive: true });
  fs.writeFileSync(path.join(rootState, ".env"), "DISCORD_BOT_TOKEN=fixture-root-token\n", { mode: 0o600 });
  const clockFile = path.join(workspace.tmpDir, "reminder-clock");
  fs.writeFileSync(clockFile, "2026-09-24T11:00:00Z");
  const running = runScript(workspace, "scripts/conversation-reminder-service.py", {
    args: ["run", "--project-root", workspace.repoDir, "--state-dir", stateDir],
    env: bridgeChildEnv(workspace, { ROOT_DISCORD_STATE_DIR: rootState,
      CCDM_REMINDER_NODE: process.execPath, CCDM_REMINDER_CLOCK_FILE: clockFile }),
    timeoutMs: 10000,
  });
  await waitForState(workspace, state => state.fixtures.discord.messages.length === 1);
  await waitForConversation(workspace, stateDir, current => current?.due_at === "2026-09-24T12:00:00Z");
  fs.writeFileSync(clockFile, "2026-09-24T11:59:59Z");
  await new Promise(resolve => setTimeout(resolve, 600));
  assert.equal(readState(workspace.stateDir).fixtures.discord.messages.length, 1);
  fs.writeFileSync(clockFile, "2026-09-24T12:00:00Z");
  const observed = await waitForState(workspace, state => state.fixtures.discord.deletes?.length === 1);
  assert.deepEqual(observed.fixtures.discord.messages.map(row => row.requestBody), [
    { content: "👀", allowed_mentions: { parse: [] }, nonce: observed.fixtures.discord.messages[0].requestBody.nonce,
      enforce_nonce: true },
    { content: "👀", allowed_mentions: { parse: [] }, nonce: observed.fixtures.discord.messages[1].requestBody.nonce,
      enforce_nonce: true },
  ]);
  assert.notEqual(observed.fixtures.discord.messages[0].requestBody.nonce,
    observed.fixtures.discord.messages[1].requestBody.nonce);
  assert.deepEqual(observed.fixtures.discord.deletes.map(row => row.messageId), ["fake-message-1"]);
  assert.deepEqual(observed.fixtures.discord.reminderRequests.map(row => row.method), ["POST", "POST", "DELETE"]);
  await waitForConversation(workspace, stateDir, current => current?.due_at === "2026-09-24T13:00:00Z");
  await command(workspace, stateDir, "disable");
  assert.equal((await running).exitCode, 0);
});

test("a delayed Discord response anchors the next hour to message creation", async () => {
  const workspace = createWorkspace();
  const stateDir = setup(workspace);
  await reconciledExchange(workspace, stateDir);
  const seed = readState(workspace.stateDir);
  seed.fixtures.discord.restResponseDelayMs = 800;
  writeState(seed, workspace.stateDir);
  const rootState = path.join(workspace.homeDir, "root-discord");
  fs.mkdirSync(rootState, { recursive: true });
  fs.writeFileSync(path.join(rootState, ".env"), "DISCORD_BOT_TOKEN=fixture-root-token\n", { mode: 0o600 });
  const clockFile = path.join(workspace.tmpDir, "reminder-clock");
  fs.writeFileSync(clockFile, "2026-09-24T11:00:00Z");
  const running = runScript(workspace, "scripts/conversation-reminder-service.py", {
    args: ["run", "--project-root", workspace.repoDir, "--state-dir", stateDir],
    env: bridgeChildEnv(workspace, { ROOT_DISCORD_STATE_DIR: rootState,
      CCDM_REMINDER_NODE: process.execPath, CCDM_REMINDER_CLOCK_FILE: clockFile }),
    timeoutMs: 10000,
  });
  await waitForState(workspace, state => state.fixtures.discord.responsePending === true);
  fs.writeFileSync(clockFile, "2026-09-24T11:02:00Z");
  const sent = await waitForConversation(workspace, stateDir, current =>
    current?.reminder_message_id === "fake-message-1");
  assert.equal(sent.conversations.demo.due_at, "2026-09-24T12:00:00Z");
  await command(workspace, stateDir, "disable");
  assert.equal((await running).exitCode, 0);
});

test("a Conversation Reply after a delivery claim invalidates it before the Discord request", async () => {
  const workspace = createWorkspace();
  const stateDir = setup(workspace);
  await reconciledExchange(workspace, stateDir);
  const clockFile = path.join(workspace.tmpDir, "reminder-clock");
  fs.writeFileSync(clockFile, "2026-09-24T11:00:00Z");
  const env = { CCDM_REMINDER_CLOCK_FILE: clockFile };
  const claimed = await command(workspace, stateDir, "claim", { env });
  assert.equal(typeof claimed.claim.nonce, "string");
  await event(workspace, stateDir, "owner_activity", "reply-before-request", "2026-09-24T11:00:00Z", {
    actor_id: "owner", source_message_id: "reply-before-request", activity_kind: "message",
  });
  const checked = await runScript(workspace, "scripts/conversation-reminder-service.py", {
    args: ["validate", "--project-root", workspace.repoDir, "--state-dir", stateDir,
      "--nonce", claimed.claim.nonce], env,
  });
  assert.equal(checked.exitCode, 0, checked.stderr || checked.stdout);
  assert.equal(JSON.parse(checked.stdout).valid, false);
  assert.equal((await command(workspace, stateDir, "status")).conversations.demo.state, "open-paused");
  assert.deepEqual(readState(workspace.stateDir).fixtures.discord.messages, []);
});

test("a Conversation Reply during the Discord request removes its returned reminder", async () => {
  const workspace = createWorkspace();
  const stateDir = setup(workspace);
  await reconciledExchange(workspace, stateDir);
  const seed = readState(workspace.stateDir);
  seed.fixtures.discord.restResponseDelayMs = 800;
  writeState(seed, workspace.stateDir);
  const rootState = path.join(workspace.homeDir, "root-discord");
  fs.mkdirSync(rootState, { recursive: true });
  fs.writeFileSync(path.join(rootState, ".env"), "DISCORD_BOT_TOKEN=fixture-root-token\n", { mode: 0o600 });
  const clockFile = path.join(workspace.tmpDir, "reminder-clock");
  fs.writeFileSync(clockFile, "2026-09-24T11:00:00Z");
  const running = runScript(workspace, "scripts/conversation-reminder-service.py", {
    args: ["run", "--project-root", workspace.repoDir, "--state-dir", stateDir],
    env: bridgeChildEnv(workspace, { ROOT_DISCORD_STATE_DIR: rootState,
      CCDM_REMINDER_NODE: process.execPath, CCDM_REMINDER_CLOCK_FILE: clockFile }),
    timeoutMs: 10000,
  });
  await waitForState(workspace, state => state.fixtures.discord.responsePending === true);
  await event(workspace, stateDir, "owner_activity", "during-request", "2026-09-24T11:00:01Z", {
    actor_id: "owner", source_message_id: "owner-during-request", activity_kind: "message",
  });
  const observed = await waitForState(workspace, state => state.fixtures.discord.deletes?.length === 1);
  assert.deepEqual(observed.fixtures.discord.deletes.map(row => row.messageId), ["fake-message-1"]);
  const state = await waitForConversation(workspace, stateDir, current =>
    current?.state === "open-paused" && current?.cleanup_message_ids.length === 0);
  assert.equal(state.conversations.demo.reminder_message_id, null);
  assert.equal(state.conversations.demo.due_at, null);
  assert.equal(observed.fixtures.codex.appServerInvocations.length, 0);
  await command(workspace, stateDir, "disable");
  assert.equal((await running).exitCode, 0);
});

test("owner closure during the Discord request deletes its returned reminder and confirms closure", async () => {
  const workspace = createWorkspace();
  const stateDir = setup(workspace);
  await reconciledExchange(workspace, stateDir);
  const seed = readState(workspace.stateDir);
  seed.fixtures.discord.restResponseDelayMs = 800;
  writeState(seed, workspace.stateDir);
  const rootState = path.join(workspace.homeDir, "root-discord");
  fs.mkdirSync(rootState, { recursive: true });
  fs.writeFileSync(path.join(rootState, ".env"), "DISCORD_BOT_TOKEN=fixture-root-token\n", { mode: 0o600 });
  const clockFile = path.join(workspace.tmpDir, "reminder-clock");
  fs.writeFileSync(clockFile, "2026-09-24T11:00:00Z");
  const running = runScript(workspace, "scripts/conversation-reminder-service.py", {
    args: ["run", "--project-root", workspace.repoDir, "--state-dir", stateDir],
    env: bridgeChildEnv(workspace, { ROOT_DISCORD_STATE_DIR: rootState,
      CCDM_REMINDER_NODE: process.execPath, CCDM_REMINDER_CLOCK_FILE: clockFile }),
    timeoutMs: 10000,
  });
  await waitForState(workspace, state => state.fixtures.discord.responsePending === true);
  await event(workspace, stateDir, "close_requested", "close-during-request", "2026-09-24T11:00:01Z", {
    actor_id: "owner", source_message_id: "owner-close-during-request", command: "/close",
  });
  await waitForState(workspace, state => state.fixtures.discord.deletes?.length === 1 &&
    state.fixtures.discord.reactions.some(row => row.messageId === "owner-close-during-request"));
  const closed = await waitForConversation(workspace, stateDir, current =>
    current?.state === "closed" && current?.cleanup_message_ids.length === 0);
  assert.equal(closed.conversations.demo.reminder_message_id, null);
  assert.equal(closed.conversations.demo.due_at, null);
  assert.deepEqual(readState(workspace.stateDir).fixtures.discord.deletes.map(row => row.messageId),
    ["fake-message-1"]);
  assert.equal(readState(workspace.stateDir).fixtures.codex.appServerInvocations.length, 0);
  await command(workspace, stateDir, "disable");
  assert.equal((await running).exitCode, 0);
});

test("failed cleanup blocks another replacement until deletion succeeds", async () => {
  const workspace = createWorkspace();
  const stateDir = setup(workspace);
  await reconciledExchange(workspace, stateDir);
  const rootState = path.join(workspace.homeDir, "root-discord");
  fs.mkdirSync(rootState, { recursive: true });
  fs.writeFileSync(path.join(rootState, ".env"), "DISCORD_BOT_TOKEN=fixture-root-token\n", { mode: 0o600 });
  const clockFile = path.join(workspace.tmpDir, "reminder-clock");
  fs.writeFileSync(clockFile, "2026-09-24T11:00:00Z");
  const running = runScript(workspace, "scripts/conversation-reminder-service.py", {
    args: ["run", "--project-root", workspace.repoDir, "--state-dir", stateDir],
    env: bridgeChildEnv(workspace, { ROOT_DISCORD_STATE_DIR: rootState,
      CCDM_REMINDER_NODE: process.execPath, CCDM_REMINDER_CLOCK_FILE: clockFile }),
    timeoutMs: 10000,
  });
  await waitForConversation(workspace, stateDir, current => current?.reminder_message_id === "fake-message-1");
  const seed = readState(workspace.stateDir);
  seed.fixtures.discord.restFailures = Array.from({ length: 20 }, () => ({ method: "DELETE", status: 503 }));
  writeState(seed, workspace.stateDir);
  fs.writeFileSync(clockFile, "2026-09-24T12:00:00Z");
  await waitForState(workspace, state => state.fixtures.discord.deletes?.length === 1);
  assert.deepEqual((await command(workspace, stateDir, "status")).conversations.demo.cleanup_message_ids,
    ["fake-message-1"]);
  fs.writeFileSync(clockFile, "2026-09-24T13:00:00Z");
  await new Promise(resolve => setTimeout(resolve, 450));
  assert.equal(readState(workspace.stateDir).fixtures.discord.messages.length, 2);
  const recovery = readState(workspace.stateDir);
  recovery.fixtures.discord.restFailures = [];
  writeState(recovery, workspace.stateDir);
  fs.writeFileSync(clockFile, "2026-09-24T13:00:01Z");
  await waitForState(workspace, state => state.fixtures.discord.deletes?.length >= 2);
  await waitForState(workspace, state => state.fixtures.discord.messages.length === 3);
  await command(workspace, stateDir, "disable");
  assert.equal((await running).exitCode, 0);
});

test("cleanup waits for Discord's full 429 retry window before deleting by ID", async () => {
  const workspace = createWorkspace();
  const stateDir = setup(workspace);
  await reconciledExchange(workspace, stateDir);
  const rootState = path.join(workspace.homeDir, "root-discord");
  fs.mkdirSync(rootState, { recursive: true });
  fs.writeFileSync(path.join(rootState, ".env"), "DISCORD_BOT_TOKEN=fixture-root-token\n", { mode: 0o600 });
  const clockFile = path.join(workspace.tmpDir, "reminder-clock");
  fs.writeFileSync(clockFile, "2026-09-24T11:00:00Z");
  const running = runScript(workspace, "scripts/conversation-reminder-service.py", {
    args: ["run", "--project-root", workspace.repoDir, "--state-dir", stateDir],
    env: bridgeChildEnv(workspace, { ROOT_DISCORD_STATE_DIR: rootState,
      CCDM_REMINDER_NODE: process.execPath, CCDM_REMINDER_CLOCK_FILE: clockFile }),
    timeoutMs: 10000,
  });
  await waitForConversation(workspace, stateDir, current => current?.reminder_message_id === "fake-message-1");
  const seed = readState(workspace.stateDir);
  seed.fixtures.discord.restFailures = [{ method: "DELETE", status: 429, body: { retry_after: 360 } }];
  writeState(seed, workspace.stateDir);
  fs.writeFileSync(clockFile, "2026-09-24T12:00:00Z");
  await waitForState(workspace, state => state.fixtures.discord.restFailureUses.length === 1);
  assert.deepEqual((await command(workspace, stateDir, "status")).conversations.demo.cleanup_message_ids,
    ["fake-message-1"]);
  fs.writeFileSync(clockFile, "2026-09-24T12:05:59Z");
  await new Promise(resolve => setTimeout(resolve, 600));
  assert.equal(readState(workspace.stateDir).fixtures.discord.deletes.length, 1);
  fs.writeFileSync(clockFile, "2026-09-24T12:06:00Z");
  await waitForState(workspace, state => state.fixtures.discord.deletes.length === 2);
  await waitForConversation(workspace, stateDir, current => current?.cleanup_message_ids.length === 0);
  assert.deepEqual(readState(workspace.stateDir).fixtures.discord.deletes.map(row => row.messageId),
    ["fake-message-1", "fake-message-1"]);
  await command(workspace, stateDir, "disable");
  assert.equal((await running).exitCode, 0);
});

test("Discord 429 preserves the prior reminder and waits for the advertised retry time", async () => {
  const workspace = createWorkspace();
  const stateDir = setup(workspace);
  await reconciledExchange(workspace, stateDir);
  const rootState = path.join(workspace.homeDir, "root-discord");
  fs.mkdirSync(rootState, { recursive: true });
  fs.writeFileSync(path.join(rootState, ".env"), "DISCORD_BOT_TOKEN=fixture-root-token\n", { mode: 0o600 });
  const clockFile = path.join(workspace.tmpDir, "reminder-clock");
  fs.writeFileSync(clockFile, "2026-09-24T11:00:00Z");
  const running = runScript(workspace, "scripts/conversation-reminder-service.py", {
    args: ["run", "--project-root", workspace.repoDir, "--state-dir", stateDir],
    env: bridgeChildEnv(workspace, { ROOT_DISCORD_STATE_DIR: rootState,
      CCDM_REMINDER_NODE: process.execPath, CCDM_REMINDER_CLOCK_FILE: clockFile }),
    timeoutMs: 10000,
  });
  await waitForConversation(workspace, stateDir, current => current?.reminder_message_id === "fake-message-1");
  const seed = readState(workspace.stateDir);
  seed.fixtures.discord.restFailures = [{ method: "POST", status: 429, body: { retry_after: 360 } }];
  writeState(seed, workspace.stateDir);
  fs.writeFileSync(clockFile, "2026-09-24T12:00:00Z");
  await waitForState(workspace, state => state.fixtures.discord.restFailureUses.length === 1);
  assert.equal((await command(workspace, stateDir, "status")).conversations.demo.reminder_message_id,
    "fake-message-1");
  assert.equal(readState(workspace.stateDir).fixtures.discord.deletes?.length || 0, 0);
  fs.writeFileSync(clockFile, "2026-09-24T12:05:59Z");
  await new Promise(resolve => setTimeout(resolve, 650));
  assert.equal(readState(workspace.stateDir).fixtures.discord.messages.length, 1);
  fs.writeFileSync(clockFile, "2026-09-24T12:06:00Z");
  await waitForState(workspace, state => state.fixtures.discord.messages.length === 2);
  await waitForConversation(workspace, stateDir, current => current?.due_at === "2026-09-24T13:06:00Z");
  await command(workspace, stateDir, "disable");
  assert.equal((await running).exitCode, 0);
});

test("a bot access failure suspends delivery without deleting the prior reminder", async () => {
  const workspace = createWorkspace();
  const stateDir = setup(workspace);
  await reconciledExchange(workspace, stateDir);
  const rootState = path.join(workspace.homeDir, "root-discord");
  fs.mkdirSync(rootState, { recursive: true });
  fs.writeFileSync(path.join(rootState, ".env"), "DISCORD_BOT_TOKEN=fixture-root-token\n", { mode: 0o600 });
  const clockFile = path.join(workspace.tmpDir, "reminder-clock");
  fs.writeFileSync(clockFile, "2026-09-24T11:00:00Z");
  const running = runScript(workspace, "scripts/conversation-reminder-service.py", {
    args: ["run", "--project-root", workspace.repoDir, "--state-dir", stateDir],
    env: bridgeChildEnv(workspace, { ROOT_DISCORD_STATE_DIR: rootState,
      CCDM_REMINDER_NODE: process.execPath, CCDM_REMINDER_CLOCK_FILE: clockFile }),
    timeoutMs: 10000,
  });
  await waitForConversation(workspace, stateDir, current => current?.reminder_message_id === "fake-message-1");
  const seed = readState(workspace.stateDir);
  seed.fixtures.discord.restFailures = [{ method: "POST", status: 403 }];
  writeState(seed, workspace.stateDir);
  fs.writeFileSync(clockFile, "2026-09-24T12:00:00Z");
  await waitForState(workspace, state => state.fixtures.discord.restFailureUses.length === 1);
  const suspended = await waitForConversation(workspace, stateDir, current =>
    current?.reconciliation_status === "suspended-delivery-access");
  assert.equal(suspended.conversations.demo.reminder_message_id, "fake-message-1");
  assert.equal(readState(workspace.stateDir).fixtures.discord.deletes?.length || 0, 0);
  fs.writeFileSync(clockFile, "2026-09-24T13:00:00Z");
  await new Promise(resolve => setTimeout(resolve, 600));
  assert.equal(readState(workspace.stateDir).fixtures.discord.messages.length, 1);
  await command(workspace, stateDir, "disable");
  assert.equal((await running).exitCode, 0);
});

test("a lost send response is resolved with the same nonce instead of risking a duplicate", async () => {
  const workspace = createWorkspace();
  const stateDir = setup(workspace);
  await reconciledExchange(workspace, stateDir);
  const rootState = path.join(workspace.homeDir, "root-discord");
  fs.mkdirSync(rootState, { recursive: true });
  fs.writeFileSync(path.join(rootState, ".env"), "DISCORD_BOT_TOKEN=fixture-root-token\n", { mode: 0o600 });
  const clockFile = path.join(workspace.tmpDir, "reminder-clock");
  fs.writeFileSync(clockFile, "2026-09-24T11:00:00Z");
  const env = bridgeChildEnv(workspace, { ROOT_DISCORD_STATE_DIR: rootState,
    CCDM_REMINDER_NODE: process.execPath, CCDM_REMINDER_CLOCK_FILE: clockFile });
  const args = ["run", "--project-root", workspace.repoDir, "--state-dir", stateDir];
  const running = runScript(workspace, "scripts/conversation-reminder-service.py", { args, env, timeoutMs: 15000 });
  await waitForConversation(workspace, stateDir, current => current?.reminder_message_id === "fake-message-1");
  const seed = readState(workspace.stateDir);
  seed.fixtures.discord.restLoseResponse = true;
  writeState(seed, workspace.stateDir);
  fs.writeFileSync(clockFile, "2026-09-24T12:00:00Z");
  const replaced = await waitForConversation(workspace, stateDir, current =>
    current?.reminder_message_id === "fake-message-2" && current.cleanup_message_ids.length === 0);
  assert.equal(replaced.conversations.demo.reconciliation_status, "ready");
  assert.equal(replaced.conversations.demo.due_at, "2026-09-24T13:00:00Z");
  const discord = readState(workspace.stateDir).fixtures.discord;
  assert.equal(discord.lostResponseUses, 1);
  assert.equal(discord.messages.length, 2, "the retry returned the created reminder instead of posting another");
  assert.equal(discord.reminderRequests.filter(row => row.method === "POST").length, 3);
  assert.deepEqual(discord.deletes.map(row => row.messageId), ["fake-message-1"]);
  await command(workspace, stateDir, "disable");
  assert.equal((await running).exitCode, 0);
});

test("a persistently lost response suspends until the running worker finds the reminder in history", async () => {
  const workspace = createWorkspace();
  const stateDir = setup(workspace);
  await reconciledExchange(workspace, stateDir);
  const rootState = path.join(workspace.homeDir, "root-discord");
  fs.mkdirSync(rootState, { recursive: true });
  fs.writeFileSync(path.join(rootState, ".env"), "DISCORD_BOT_TOKEN=fixture-root-token\n", { mode: 0o600 });
  const clockFile = path.join(workspace.tmpDir, "reminder-clock");
  fs.writeFileSync(clockFile, "2026-09-24T11:00:00Z");
  const env = bridgeChildEnv(workspace, { ROOT_DISCORD_STATE_DIR: rootState,
    CCDM_REMINDER_NODE: process.execPath, CCDM_REMINDER_CLOCK_FILE: clockFile });
  const seed = readState(workspace.stateDir);
  // Discord accepts the first attempt, but every response is lost and the
  // history the worker reads first does not yet show the reminder.
  seed.fixtures.discord.restLoseResponse = 3;
  seed.fixtures.discord.includeSentInHistory = false;
  writeState(seed, workspace.stateDir);
  const args = ["run", "--project-root", workspace.repoDir, "--state-dir", stateDir];
  const running = runScript(workspace, "scripts/conversation-reminder-service.py", { args, env, timeoutMs: 60000 });
  const suspended = await waitForConversation(workspace, stateDir, current =>
    current?.reconciliation_status === "suspended-uncertain-send");
  assert.equal(suspended.conversations.demo.reminder_message_id, null);
  const lost = readState(workspace.stateDir).fixtures.discord;
  assert.equal(lost.messages.length, 1, "every retry reused the nonce, so Discord kept one reminder");
  assert.equal(lost.reminderRequests.filter(row => row.method === "POST").length, 3);
  // Inside the identity window an empty history proves nothing, so the send
  // stays suspended rather than being retried.
  await new Promise(resolve => setTimeout(resolve, 6000));
  assert.equal((await command(workspace, stateDir, "status")).conversations.demo.reconciliation_status,
    "suspended-uncertain-send");

  // Once history shows the assigned bot's own emoji, the worker records it
  // without an operator and reconciles before releasing the channel.
  const visible = readState(workspace.stateDir);
  visible.fixtures.discord.includeSentInHistory = true;
  writeState(visible, workspace.stateDir);
  let found;
  for (let attempt = 0; attempt < 60 && !found; attempt++) {
    const current = await command(workspace, stateDir, "status");
    if (current.conversations.demo.reminder_message_id === "fake-message-1" &&
        current.conversations.demo.reconciliation_status === "ready") found = current;
    else await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.ok(found, "the worker resolved the lost reminder from history");
  assert.equal(found.conversations.demo.due_at, "2026-09-24T12:00:00Z");
  assert.deepEqual(found.unresolved_intents, []);
  await command(workspace, stateDir, "disable");
  assert.equal((await running).exitCode, 0);
  assert.equal(readState(workspace.stateDir).fixtures.discord.messages.length, 1);
});

test("server errors that never created a reminder release the channel once the identity window closes", async () => {
  const workspace = createWorkspace();
  const stateDir = setup(workspace);
  await reconciledExchange(workspace, stateDir);
  const rootState = path.join(workspace.homeDir, "root-discord");
  fs.mkdirSync(rootState, { recursive: true });
  fs.writeFileSync(path.join(rootState, ".env"), "DISCORD_BOT_TOKEN=fixture-root-token\n", { mode: 0o600 });
  const clockFile = path.join(workspace.tmpDir, "reminder-clock");
  fs.writeFileSync(clockFile, "2026-09-24T11:00:00Z");
  const env = bridgeChildEnv(workspace, { ROOT_DISCORD_STATE_DIR: rootState,
    CCDM_REMINDER_NODE: process.execPath, CCDM_REMINDER_CLOCK_FILE: clockFile });
  const seed = readState(workspace.stateDir);
  seed.fixtures.discord.restFailures = [503, 502, 504].map(status => ({ method: "POST", status }));
  writeState(seed, workspace.stateDir);
  const running = runScript(workspace, "scripts/conversation-reminder-service.py", {
    args: ["run", "--project-root", workspace.repoDir, "--state-dir", stateDir], env, timeoutMs: 60000 });
  await waitForConversation(workspace, stateDir, current =>
    current?.reconciliation_status === "suspended-uncertain-send");
  assert.equal(readState(workspace.stateDir).fixtures.discord.messages.length, 0);
  // After the window closes, history covering it shows no reminder: the
  // channel reconciles and sends once more instead of waiting on an operator.
  fs.writeFileSync(clockFile, "2026-09-24T11:06:00Z");
  const sent = await waitForState(workspace, state => (state.fixtures.discord.messages ?? []).length === 1, 20000);
  assert.equal(sent.fixtures.discord.messages[0].content, "👀");
  const released = await waitForConversation(workspace, stateDir, current =>
    current?.reminder_message_id === "fake-message-1");
  assert.equal(released.conversations.demo.due_at, "2026-09-24T12:06:00Z");
  assert.equal(released.conversations.demo.discovery.mode, "restart");
  await command(workspace, stateDir, "disable");
  assert.equal((await running).exitCode, 0);
});

test("operator recovery finds a lost reminder by its bot, emoji, and claim time after restart", async () => {
  const workspace = createWorkspace();
  const stateDir = setup(workspace);
  await reconciledExchange(workspace, stateDir);
  const rootState = path.join(workspace.homeDir, "root-discord");
  fs.mkdirSync(rootState, { recursive: true });
  fs.writeFileSync(path.join(rootState, ".env"), "DISCORD_BOT_TOKEN=fixture-root-token\n", { mode: 0o600 });
  const clockFile = path.join(workspace.tmpDir, "reminder-clock");
  fs.writeFileSync(clockFile, "2026-09-24T11:00:00Z");
  const env = bridgeChildEnv(workspace, { ROOT_DISCORD_STATE_DIR: rootState,
    CCDM_REMINDER_NODE: process.execPath, CCDM_REMINDER_CLOCK_FILE: clockFile });
  const args = ["run", "--project-root", workspace.repoDir, "--state-dir", stateDir];
  const running = runScript(workspace, "scripts/conversation-reminder-service.py", { args, env, timeoutMs: 10000 });
  await waitForConversation(workspace, stateDir, current => current?.reminder_message_id === "fake-message-1");
  const seed = readState(workspace.stateDir);
  seed.fixtures.discord.restLoseResponse = 3;
  seed.fixtures.discord.includeSentInHistory = false;
  writeState(seed, workspace.stateDir);
  fs.writeFileSync(clockFile, "2026-09-24T12:00:00Z");
  await waitForConversation(workspace, stateDir, current =>
    current?.reconciliation_status === "suspended-uncertain-send");
  await command(workspace, stateDir, "disable");
  assert.equal((await running).exitCode, 0);
  await command(workspace, stateDir, "enable", { env });

  const visible = readState(workspace.stateDir);
  visible.fixtures.discord.includeSentInHistory = true;
  writeState(visible, workspace.stateDir);

  const recovered = await command(workspace, stateDir, "recover", { env });
  assert.equal(recovered.recovered, 1);
  const observed = readState(workspace.stateDir).fixtures.discord;
  assert.equal(observed.messages.length, 2);
  assert.equal(observed.messages[0].deleted, true);
  assert.equal(observed.messages[1].deleted, undefined);
  assert.equal((await command(workspace, stateDir, "status")).conversations.demo.due_at,
    "2026-09-24T13:00:00Z");
  // One hourly send, then three same-nonce attempts that Discord deduplicated.
  assert.equal(observed.reminderRequests.filter(row => row.method === "POST").length, 4);
  assert.equal(readState(workspace.stateDir).fixtures.codex.appServerInvocations.length, 0);
});

test("an interrupted claim never adopts an unrelated emoji and is released once history proves nothing was sent", async () => {
  const workspace = createWorkspace();
  const stateDir = setup(workspace);
  await reconciledExchange(workspace, stateDir);
  const rootState = path.join(workspace.homeDir, "root-discord");
  fs.mkdirSync(rootState, { recursive: true });
  fs.writeFileSync(path.join(rootState, ".env"), "DISCORD_BOT_TOKEN=fixture-root-token\n", { mode: 0o600 });
  const clockFile = path.join(workspace.tmpDir, "reminder-clock");
  fs.writeFileSync(clockFile, "2026-09-24T11:00:00Z");
  const env = bridgeChildEnv(workspace, { ROOT_DISCORD_STATE_DIR: rootState,
    CCDM_REMINDER_NODE: process.execPath, CCDM_REMINDER_CLOCK_FILE: clockFile });
  const claimed = await command(workspace, stateDir, "claim", { env });
  assert.ok(claimed.claim?.nonce);
  const fixture = readState(workspace.stateDir);
  // The owner's own 👀 inside the window and the bot's 👀 from before it are
  // not the claim's identity; the bot's older emoji also bounds the scan.
  fixture.fixtures.discord.restMessages = [
    { id: "owner-eye", content: "👀", author: { id: "owner", bot: false }, timestamp: "2026-09-24T11:00:30Z" },
    { id: "ordinary-eye", content: "👀", author: { id: "app", bot: true }, timestamp: "2026-09-24T10:30:00Z" },
  ];
  writeState(fixture, workspace.stateDir);

  // Inside the identity window, an empty result proves nothing.
  const early = await command(workspace, stateDir, "recover", { env });
  assert.deepEqual([early.recovered, early.released], [0, 0]);
  assert.match(early.unresolved[0].reason, /identity window/);
  const waiting = await command(workspace, stateDir, "status");
  assert.equal(waiting.conversations.demo.reconciliation_status, "suspended-uncertain-send");
  assert.equal(waiting.unresolved_intents[0].nonce, claimed.claim.nonce);
  assert.match(waiting.recovery_guidance, /do not resend/i);

  fs.writeFileSync(clockFile, "2026-09-24T12:10:00Z");
  const recovered = await command(workspace, stateDir, "recover", { env });
  assert.deepEqual([recovered.recovered, recovered.released, recovered.unresolved], [0, 1, []]);
  const current = await command(workspace, stateDir, "status");
  assert.equal(current.conversations.demo.reconciliation_status, "suspended-restart-reconciliation");
  assert.deepEqual(current.unresolved_intents, []);
  assert.equal(current.conversations.demo.reminder_message_id, null);
  const discord = readState(workspace.stateDir).fixtures.discord;
  assert.equal(discord.messages.length, 0);
  assert.equal(discord.deletes?.length || 0, 0);
  assert.equal(discord.restMessages[0].content, "👀");
});

test("recovery refuses duplicate candidate identities across bounded history pages", async () => {
  const workspace = createWorkspace();
  const stateDir = setup(workspace);
  await reconciledExchange(workspace, stateDir);
  const rootState = path.join(workspace.homeDir, "root-discord");
  fs.mkdirSync(rootState, { recursive: true });
  fs.writeFileSync(path.join(rootState, ".env"), "DISCORD_BOT_TOKEN=fixture-root-token\n", { mode: 0o600 });
  const clockFile = path.join(workspace.tmpDir, "reminder-clock");
  fs.writeFileSync(clockFile, "2026-09-24T11:00:00Z");
  const env = bridgeChildEnv(workspace, { ROOT_DISCORD_STATE_DIR: rootState,
    CCDM_REMINDER_NODE: process.execPath, CCDM_REMINDER_CLOCK_FILE: clockFile });
  const nonce = (await command(workspace, stateDir, "claim", { env })).claim.nonce;
  const fixture = readState(workspace.stateDir);
  fixture.fixtures.discord.restMessages = Array.from({ length: 101 }, (_, index) => ({
    id: `history-${index}`, content: index === 0 || index === 100 ? "👀" : "other",
    author: { id: "app", bot: true }, timestamp: "2026-09-24T11:00:00Z",
  }));
  writeState(fixture, workspace.stateDir);

  const recovered = await command(workspace, stateDir, "recover", { env });
  assert.equal(recovered.recovered, 0);
  assert.match(recovered.unresolved[0].reason, /multiple unrecorded reminders/);
  assert.equal((await command(workspace, stateDir, "status")).unresolved_intents[0].nonce, nonce);
});

test("a crash after Discord accepts a reminder recovers one identity without resending", async () => {
  const workspace = createWorkspace();
  const stateDir = setup(workspace);
  await reconciledExchange(workspace, stateDir);
  const rootState = path.join(workspace.homeDir, "root-discord");
  fs.mkdirSync(rootState, { recursive: true });
  fs.writeFileSync(path.join(rootState, ".env"), "DISCORD_BOT_TOKEN=fixture-root-token\n", { mode: 0o600 });
  const clockFile = path.join(workspace.tmpDir, "reminder-clock");
  fs.writeFileSync(clockFile, "2026-09-24T11:00:00Z");
  const env = bridgeChildEnv(workspace, { ROOT_DISCORD_STATE_DIR: rootState,
    CCDM_REMINDER_NODE: process.execPath, CCDM_REMINDER_CLOCK_FILE: clockFile });
  const fixture = readState(workspace.stateDir);
  fixture.fixtures.discord.crashAfterReminderAccept = true;
  writeState(fixture, workspace.stateDir);

  const crashed = await runScript(workspace, "scripts/conversation-reminder-service.py", {
    args: ["run", "--project-root", workspace.repoDir, "--state-dir", stateDir], env, timeoutMs: 5000,
  });
  assert.equal(crashed.exitCode, 2);
  const afterCrash = readState(workspace.stateDir);
  assert.equal(afterCrash.fixtures.discord.messages.length, 1);
  afterCrash.fixtures.discord.includeSentInHistory = true;
  writeState(afterCrash, workspace.stateDir);
  const recovered = await command(workspace, stateDir, "recover", { env });
  assert.equal(recovered.recovered, 1);
  assert.equal(readState(workspace.stateDir).fixtures.discord.messages.length, 1);
  assert.equal((await command(workspace, stateDir, "status")).conversations.demo.due_at,
    "2026-09-24T12:00:00Z");
});

test("a crash after receiving the Discord response still reconciles the durable intent", async () => {
  const workspace = createWorkspace();
  const stateDir = setup(workspace);
  await reconciledExchange(workspace, stateDir);
  const rootState = path.join(workspace.homeDir, "root-discord");
  fs.mkdirSync(rootState, { recursive: true });
  fs.writeFileSync(path.join(rootState, ".env"), "DISCORD_BOT_TOKEN=fixture-root-token\n", { mode: 0o600 });
  const clockFile = path.join(workspace.tmpDir, "reminder-clock");
  fs.writeFileSync(clockFile, "2026-09-24T11:00:00Z");
  const env = bridgeChildEnv(workspace, { ROOT_DISCORD_STATE_DIR: rootState,
    CCDM_REMINDER_NODE: process.execPath, CCDM_REMINDER_CLOCK_FILE: clockFile });
  const fixture = readState(workspace.stateDir);
  fixture.fixtures.discord.crashAfterReminderResponseParsed = true;
  writeState(fixture, workspace.stateDir);

  const crashed = await runScript(workspace, "scripts/conversation-reminder-service.py", {
    args: ["run", "--project-root", workspace.repoDir, "--state-dir", stateDir], env, timeoutMs: 5000,
  });
  assert.equal(crashed.exitCode, 2);
  const visible = readState(workspace.stateDir);
  visible.fixtures.discord.includeSentInHistory = true;
  writeState(visible, workspace.stateDir);
  const recovered = await command(workspace, stateDir, "recover", { env });
  assert.equal(recovered.recovered, 1);
  assert.equal(readState(workspace.stateDir).fixtures.discord.messages.length, 1);
  assert.equal((await command(workspace, stateDir, "status")).conversations.demo.due_at,
    "2026-09-24T12:00:00Z");
});

test("closure during a lost send keeps the conversation closed and replays cleanup and acknowledgment", async () => {
  const workspace = createWorkspace();
  const stateDir = setup(workspace);
  await reconciledExchange(workspace, stateDir);
  const rootState = path.join(workspace.homeDir, "root-discord");
  fs.mkdirSync(rootState, { recursive: true });
  fs.writeFileSync(path.join(rootState, ".env"), "DISCORD_BOT_TOKEN=fixture-root-token\n", { mode: 0o600 });
  const clockFile = path.join(workspace.tmpDir, "reminder-clock");
  fs.writeFileSync(clockFile, "2026-09-24T11:00:00Z");
  const env = bridgeChildEnv(workspace, { ROOT_DISCORD_STATE_DIR: rootState,
    CCDM_REMINDER_NODE: process.execPath, CCDM_REMINDER_CLOCK_FILE: clockFile });
  const fixture = readState(workspace.stateDir);
  fixture.fixtures.discord.crashAfterReminderAccept = true;
  writeState(fixture, workspace.stateDir);
  const crashed = await runScript(workspace, "scripts/conversation-reminder-service.py", {
    args: ["run", "--project-root", workspace.repoDir, "--state-dir", stateDir], env, timeoutMs: 5000,
  });
  assert.equal(crashed.exitCode, 2);
  await event(workspace, stateDir, "close_requested", "closed-during-recovery", "2026-09-24T11:00:01Z", {
    actor_id: "owner", source_message_id: "close-after-send", command: "/close",
  });
  const visible = readState(workspace.stateDir);
  visible.fixtures.discord.includeSentInHistory = true;
  visible.fixtures.discord.restFailures = [{ method: "DELETE", status: 503 }];
  writeState(visible, workspace.stateDir);

  const first = await command(workspace, stateDir, "recover", { env });
  assert.equal(first.recovered, 1);
  const pending = await command(workspace, stateDir, "status");
  assert.equal(pending.conversations.demo.state, "closed");
  assert.equal(pending.conversations.demo.due_at, null);
  assert.deepEqual(pending.conversations.demo.cleanup_message_ids, ["fake-message-1"]);
  assert.equal(readState(workspace.stateDir).fixtures.discord.reactions.length, 1);

  const second = await command(workspace, stateDir, "recover", { env });
  assert.equal(second.recovered, 0);
  assert.deepEqual((await command(workspace, stateDir, "status")).conversations.demo.cleanup_message_ids, []);
  const discord = readState(workspace.stateDir).fixtures.discord;
  assert.equal(discord.messages.length, 1);
  assert.equal(discord.messages[0].deleted, true);
  assert.equal(discord.reminderRequests.filter(row => row.method === "POST").length, 1);
  assert.equal(readState(workspace.stateDir).fixtures.codex.appServerInvocations.length, 0);
});

test("denied identity lookup leaves an uncertain reminder suspended without another send", async () => {
  const workspace = createWorkspace();
  const stateDir = setup(workspace);
  await reconciledExchange(workspace, stateDir);
  const rootState = path.join(workspace.homeDir, "root-discord");
  fs.mkdirSync(rootState, { recursive: true });
  fs.writeFileSync(path.join(rootState, ".env"), "DISCORD_BOT_TOKEN=fixture-root-token\n", { mode: 0o600 });
  const clockFile = path.join(workspace.tmpDir, "reminder-clock");
  fs.writeFileSync(clockFile, "2026-09-24T11:00:00Z");
  const env = bridgeChildEnv(workspace, { ROOT_DISCORD_STATE_DIR: rootState,
    CCDM_REMINDER_NODE: process.execPath, CCDM_REMINDER_CLOCK_FILE: clockFile });
  const nonce = (await command(workspace, stateDir, "claim", { env })).claim.nonce;
  const fixture = readState(workspace.stateDir);
  fixture.fixtures.discord.restFailures = [{ method: "GET", path: "/api/v10/channels/channel/messages",
    status: 403 }];
  writeState(fixture, workspace.stateDir);

  const recovered = await command(workspace, stateDir, "recover", { env });
  assert.equal(recovered.recovered, 0);
  assert.match(recovered.unresolved[0].reason, /lookup denied/);
  assert.equal((await command(workspace, stateDir, "status")).unresolved_intents[0].nonce, nonce);
  assert.equal(readState(workspace.stateDir).fixtures.discord.messages.length, 0);
});

test("operator recovery cannot take over a live foreground worker", async () => {
  const workspace = createWorkspace();
  const stateDir = setup(workspace);
  await reconciledExchange(workspace, stateDir);
  const rootState = path.join(workspace.homeDir, "root-discord");
  fs.mkdirSync(rootState, { recursive: true });
  fs.writeFileSync(path.join(rootState, ".env"), "DISCORD_BOT_TOKEN=fixture-root-token\n", { mode: 0o600 });
  const clockFile = path.join(workspace.tmpDir, "reminder-clock");
  fs.writeFileSync(clockFile, "2026-09-24T10:59:59Z");
  const env = bridgeChildEnv(workspace, { ROOT_DISCORD_STATE_DIR: rootState,
    CCDM_REMINDER_NODE: process.execPath, CCDM_REMINDER_CLOCK_FILE: clockFile });
  const running = runScript(workspace, "scripts/conversation-reminder-service.py", {
    args: ["run", "--project-root", workspace.repoDir, "--state-dir", stateDir], env, timeoutMs: 10000,
  });
  await waitForState(workspace, state => state.fixtures.discord.logins.length === 1);
  const refused = await runScript(workspace, "scripts/conversation-reminder-service.py", {
    args: ["recover", "--project-root", workspace.repoDir, "--state-dir", stateDir], env,
  });
  assert.equal(refused.exitCode, 2);
  assert.match(refused.stdout, /already running/);
  assert.equal((await command(workspace, stateDir, "status")).worker_running, true);
  await command(workspace, stateDir, "disable");
  assert.equal((await running).exitCode, 0);
  await command(workspace, stateDir, "enable", { env });
  assert.equal((await command(workspace, stateDir, "recover", { env })).recovered, 0);
  assert.equal(readState(workspace.stateDir).fixtures.discord.messages.length, 0);
});

test("recovery completes cleanup after Discord deleted the prior reminder but the worker crashed", async () => {
  const workspace = createWorkspace();
  const stateDir = setup(workspace);
  await reconciledExchange(workspace, stateDir);
  const rootState = path.join(workspace.homeDir, "root-discord");
  fs.mkdirSync(rootState, { recursive: true });
  fs.writeFileSync(path.join(rootState, ".env"), "DISCORD_BOT_TOKEN=fixture-root-token\n", { mode: 0o600 });
  const clockFile = path.join(workspace.tmpDir, "reminder-clock");
  fs.writeFileSync(clockFile, "2026-09-24T11:00:00Z");
  const env = bridgeChildEnv(workspace, { ROOT_DISCORD_STATE_DIR: rootState,
    CCDM_REMINDER_NODE: process.execPath, CCDM_REMINDER_CLOCK_FILE: clockFile });
  const running = runScript(workspace, "scripts/conversation-reminder-service.py", {
    args: ["run", "--project-root", workspace.repoDir, "--state-dir", stateDir], env, timeoutMs: 7000,
  });
  await waitForConversation(workspace, stateDir, current => current?.reminder_message_id === "fake-message-1");
  const fixture = readState(workspace.stateDir);
  fixture.fixtures.discord.crashAfterReminderDelete = true;
  writeState(fixture, workspace.stateDir);
  fs.writeFileSync(clockFile, "2026-09-24T12:00:00Z");
  const crashed = await running;
  assert.equal(crashed.exitCode, 2);
  assert.deepEqual((await command(workspace, stateDir, "status")).conversations.demo.cleanup_message_ids,
    ["fake-message-1"]);
  assert.equal(readState(workspace.stateDir).fixtures.discord.messages[0].deleted, true);

  const recovered = await command(workspace, stateDir, "recover", { env });
  assert.equal(recovered.recovered, 0);
  const current = (await command(workspace, stateDir, "status")).conversations.demo;
  assert.deepEqual(current.cleanup_message_ids, []);
  assert.equal(current.due_at, "2026-09-24T13:00:00Z");
  const discord = readState(workspace.stateDir).fixtures.discord;
  assert.equal(discord.messages.length, 2);
  assert.deepEqual(discord.deletes.map(row => row.messageId), ["fake-message-1", "fake-message-1"]);
});

test("recovery deletes the prior reminder after a crash following local send confirmation", async () => {
  const workspace = createWorkspace();
  const stateDir = setup(workspace);
  await reconciledExchange(workspace, stateDir);
  const rootState = path.join(workspace.homeDir, "root-discord");
  fs.mkdirSync(rootState, { recursive: true });
  fs.writeFileSync(path.join(rootState, ".env"), "DISCORD_BOT_TOKEN=fixture-root-token\n", { mode: 0o600 });
  const clockFile = path.join(workspace.tmpDir, "reminder-clock");
  fs.writeFileSync(clockFile, "2026-09-24T11:00:00Z");
  const marker = path.join(workspace.tmpDir, "first-confirmation");
  const wrapper = path.join(workspace.tmpDir, "crash-after-confirmation.sh");
  fs.writeFileSync(wrapper, `#!/bin/sh\npython3 "$@"\nresult=$?\nif [ "$result" -eq 0 ] && [ "$2" = result ]; then\n  if [ -f '${marker}' ]; then kill -KILL "$PPID"; else : > '${marker}'; fi\nfi\nexit "$result"\n`, { mode: 0o700 });
  const env = bridgeChildEnv(workspace, { ROOT_DISCORD_STATE_DIR: rootState,
    CCDM_REMINDER_NODE: process.execPath, CCDM_REMINDER_CLOCK_FILE: clockFile,
    CCDM_REMINDER_PYTHON: wrapper });
  const running = runScript(workspace, "scripts/conversation-reminder-service.py", {
    args: ["run", "--project-root", workspace.repoDir, "--state-dir", stateDir], env, timeoutMs: 7000,
  });
  await waitForConversation(workspace, stateDir, current => current?.reminder_message_id === "fake-message-1");
  fs.writeFileSync(clockFile, "2026-09-24T12:00:00Z");
  assert.equal((await running).exitCode, 2);
  const pending = (await command(workspace, stateDir, "status")).conversations.demo;
  assert.deepEqual(pending.cleanup_message_ids, ["fake-message-1"]);
  assert.equal(pending.due_at, "2026-09-24T13:00:00Z");
  assert.equal(readState(workspace.stateDir).fixtures.discord.deletes?.length || 0, 0);

  const cleanEnv = bridgeChildEnv(workspace, { ROOT_DISCORD_STATE_DIR: rootState,
    CCDM_REMINDER_NODE: process.execPath, CCDM_REMINDER_CLOCK_FILE: clockFile });
  assert.equal((await command(workspace, stateDir, "recover", { env: cleanEnv })).recovered, 0);
  assert.deepEqual((await command(workspace, stateDir, "status")).conversations.demo.cleanup_message_ids, []);
  assert.equal(readState(workspace.stateDir).fixtures.discord.messages.length, 2);
});

test("a crash after durable claim but before the Discord request is released without resending during recovery", async () => {
  const workspace = createWorkspace();
  const stateDir = setup(workspace);
  await reconciledExchange(workspace, stateDir);
  const rootState = path.join(workspace.homeDir, "root-discord");
  fs.mkdirSync(rootState, { recursive: true });
  fs.writeFileSync(path.join(rootState, ".env"), "DISCORD_BOT_TOKEN=fixture-root-token\n", { mode: 0o600 });
  const clockFile = path.join(workspace.tmpDir, "reminder-clock");
  fs.writeFileSync(clockFile, "2026-09-24T11:00:00Z");
  const wrapper = path.join(workspace.tmpDir, "crash-after-claim.sh");
  fs.writeFileSync(wrapper, "#!/bin/sh\npython3 \"$@\"\nresult=$?\nif [ \"$result\" -eq 0 ] && [ \"$2\" = validate ]; then kill -KILL \"$PPID\"; fi\nexit \"$result\"\n", { mode: 0o700 });
  const env = bridgeChildEnv(workspace, { ROOT_DISCORD_STATE_DIR: rootState,
    CCDM_REMINDER_NODE: process.execPath, CCDM_REMINDER_CLOCK_FILE: clockFile,
    CCDM_REMINDER_PYTHON: wrapper });
  const crashed = await runScript(workspace, "scripts/conversation-reminder-service.py", {
    args: ["run", "--project-root", workspace.repoDir, "--state-dir", stateDir], env, timeoutMs: 5000,
  });
  assert.equal(crashed.exitCode, 2);
  assert.equal(readState(workspace.stateDir).fixtures.discord.messages.length, 0);

  fs.writeFileSync(clockFile, "2026-09-24T12:10:00Z");
  const cleanEnv = bridgeChildEnv(workspace, { ROOT_DISCORD_STATE_DIR: rootState,
    CCDM_REMINDER_NODE: process.execPath, CCDM_REMINDER_CLOCK_FILE: clockFile });
  const recovered = await command(workspace, stateDir, "recover", { env: cleanEnv });
  assert.deepEqual([recovered.recovered, recovered.released, recovered.unresolved.length], [0, 1, 0]);
  assert.equal(readState(workspace.stateDir).fixtures.discord.messages.length, 0);
  // History must still be reconciled before the channel sends again.
  assert.equal((await command(workspace, stateDir, "status")).conversations.demo.reconciliation_status,
    "suspended-restart-reconciliation");
});

test("a restarted worker reconciles history before a previously ready channel sends again", async () => {
  const workspace = createWorkspace();
  const stateDir = setup(workspace);
  await reconciledExchange(workspace, stateDir);
  const rootState = path.join(workspace.homeDir, "root-discord");
  fs.mkdirSync(rootState, { recursive: true });
  fs.writeFileSync(path.join(rootState, ".env"), "DISCORD_BOT_TOKEN=fixture-root-token\n", { mode: 0o600 });
  const clockFile = path.join(workspace.tmpDir, "reminder-clock");
  fs.writeFileSync(clockFile, "2026-09-24T11:00:00Z");
  const env = bridgeChildEnv(workspace, { ROOT_DISCORD_STATE_DIR: rootState,
    CCDM_REMINDER_NODE: process.execPath, CCDM_REMINDER_CLOCK_FILE: clockFile });
  const args = ["run", "--project-root", workspace.repoDir, "--state-dir", stateDir];
  const first = runScript(workspace, "scripts/conversation-reminder-service.py", { args, env, timeoutMs: 10000 });
  await waitForConversation(workspace, stateDir, current => current?.reminder_message_id === "fake-message-1");
  await command(workspace, stateDir, "disable");
  assert.equal((await first).exitCode, 0);
  const enabled = await command(workspace, stateDir, "enable", { env });
  assert.equal(enabled.conversations.demo.reconciliation_status, "suspended-restart-reconciliation");
  assert.equal(readState(workspace.stateDir).fixtures.discord.fetches?.length ?? 0, 0);
  fs.writeFileSync(clockFile, "2026-09-24T12:00:00Z");
  const second = runScript(workspace, "scripts/conversation-reminder-service.py", { args, env, timeoutMs: 10000 });
  const sent = await waitForState(workspace, state => state.fixtures.discord.messages.length === 2);
  assert.ok(sent.fixtures.discord.fetches.some(row => row.channelId === "channel" &&
    row.authorization === "Bot fixture-root-token"), "history is read before the channel is released");
  const released = await waitForConversation(workspace, stateDir, current =>
    current?.due_at === "2026-09-24T13:00:00Z");
  assert.deepEqual([released.conversations.demo.discovery.mode, released.conversations.demo.discovery.basis],
    ["restart", "no-missed-activity"]);
  await new Promise(resolve => setTimeout(resolve, 600));
  assert.equal(readState(workspace.stateDir).fixtures.discord.messages.length, 2);
  await command(workspace, stateDir, "disable");
  assert.equal((await second).exitCode, 0);
});

test("manual deletion does not acknowledge or accelerate a reminder and ordinary emoji survives", async () => {
  const workspace = createWorkspace();
  const stateDir = setup(workspace);
  await reconciledExchange(workspace, stateDir);
  const rootState = path.join(workspace.homeDir, "root-discord");
  fs.mkdirSync(rootState, { recursive: true });
  fs.writeFileSync(path.join(rootState, ".env"), "DISCORD_BOT_TOKEN=fixture-root-token\n", { mode: 0o600 });
  const clockFile = path.join(workspace.tmpDir, "reminder-clock");
  fs.writeFileSync(clockFile, "2026-09-24T11:00:00Z");
  const running = runScript(workspace, "scripts/conversation-reminder-service.py", {
    args: ["run", "--project-root", workspace.repoDir, "--state-dir", stateDir],
    env: bridgeChildEnv(workspace, { ROOT_DISCORD_STATE_DIR: rootState,
      CCDM_REMINDER_NODE: process.execPath, CCDM_REMINDER_CLOCK_FILE: clockFile }),
    timeoutMs: 10000,
  });
  await waitForConversation(workspace, stateDir, current => current?.reminder_message_id === "fake-message-1");
  const seed = readState(workspace.stateDir);
  seed.fixtures.discord.messages[0].deleted = true;
  seed.fixtures.discord.restMessages = [{ id: "ordinary-eye", content: "👀" }];
  writeState(seed, workspace.stateDir);
  fs.writeFileSync(clockFile, "2026-09-24T11:30:00Z");
  await new Promise(resolve => setTimeout(resolve, 600));
  assert.equal(readState(workspace.stateDir).fixtures.discord.messages.length, 1);
  assert.equal((await command(workspace, stateDir, "status")).conversations.demo.state, "awaiting-owner");
  fs.writeFileSync(clockFile, "2026-09-24T12:00:00Z");
  await waitForState(workspace, state => state.fixtures.discord.deletes?.length === 1);
  const after = await waitForConversation(workspace, stateDir, current =>
    current?.reminder_message_id === "fake-message-2" && current?.cleanup_message_ids.length === 0);
  assert.equal(after.conversations.demo.state, "awaiting-owner");
  assert.deepEqual(readState(workspace.stateDir).fixtures.discord.deletes.map(row => row.messageId),
    ["fake-message-1"]);
  assert.equal(readState(workspace.stateDir).fixtures.discord.restMessages[0].id, "ordinary-eye");
  await command(workspace, stateDir, "disable");
  assert.equal((await running).exitCode, 0);
});

test("an owner reaction on a recorded Conversation Reminder acknowledges without starting coding", async () => {
  const workspace = createWorkspace();
  const stateDir = setup(workspace);
  await reconciledExchange(workspace, stateDir);
  const rootState = path.join(workspace.homeDir, "root-discord");
  fs.mkdirSync(rootState, { recursive: true });
  fs.writeFileSync(path.join(rootState, ".env"), "DISCORD_BOT_TOKEN=fixture-root-token\n", { mode: 0o600 });
  const clockFile = path.join(workspace.tmpDir, "reminder-clock");
  fs.writeFileSync(clockFile, "2026-09-24T11:00:00Z");
  const running = runScript(workspace, "scripts/conversation-reminder-service.py", {
    args: ["run", "--project-root", workspace.repoDir, "--state-dir", stateDir],
    env: bridgeChildEnv(workspace, { ROOT_DISCORD_STATE_DIR: rootState,
      CCDM_REMINDER_NODE: process.execPath, CCDM_REMINDER_CLOCK_FILE: clockFile }),
    timeoutMs: 10000,
  });
  await waitForConversation(workspace, stateDir, current => current?.reminder_message_id === "fake-message-1");
  const excluded = JSON.parse(fs.readFileSync(path.join(stateDir, "recorded-reminder-message-ids.json"), "utf8"));
  assert.deepEqual(excluded.message_ids, ["fake-message-1"]);
  injectDiscordReaction(workspace, { channelId: "channel", id: "reaction-on-reminder",
    messageId: "fake-message-1", emoji: "👍", user: { id: "owner" } });
  await waitForState(workspace, state => state.fixtures.discord.deliveredReactions.some(row =>
    row.id === "reaction-on-reminder"));
  const current = (await waitForConversation(workspace, stateDir, row =>
    row?.state === "open-paused" && row.cleanup_message_ids.length === 0)).conversations.demo;
  assert.equal(current.reminder_message_id, null);
  assert.equal(current.due_at, null);
  assert.equal(current.last_ack_message_id, "fake-message-1");
  assert.deepEqual(readState(workspace.stateDir).fixtures.discord.deletes.map(row => row.messageId),
    ["fake-message-1"]);
  fs.writeFileSync(clockFile, "2026-09-24T12:00:00Z");
  await new Promise(resolve => setTimeout(resolve, 600));
  assert.equal(readState(workspace.stateDir).fixtures.discord.messages.length, 1, "no further reminder");
  assert.equal(readState(workspace.stateDir).fixtures.codex.appServerInvocations.length, 0);
  await command(workspace, stateDir, "disable");
  assert.equal((await running).exitCode, 0);
});

test("a new qualifying response resets the first hour after a Conversation Reply", async () => {
  const workspace = createWorkspace();
  const stateDir = setup(workspace);
  await reconciledExchange(workspace, stateDir);
  const rootState = path.join(workspace.homeDir, "root-discord");
  fs.mkdirSync(rootState, { recursive: true });
  fs.writeFileSync(path.join(rootState, ".env"), "DISCORD_BOT_TOKEN=fixture-root-token\n", { mode: 0o600 });
  const clockFile = path.join(workspace.tmpDir, "reminder-clock");
  fs.writeFileSync(clockFile, "2026-09-24T11:00:00Z");
  const running = runScript(workspace, "scripts/conversation-reminder-service.py", {
    args: ["run", "--project-root", workspace.repoDir, "--state-dir", stateDir],
    env: bridgeChildEnv(workspace, { ROOT_DISCORD_STATE_DIR: rootState,
      CCDM_REMINDER_NODE: process.execPath, CCDM_REMINDER_CLOCK_FILE: clockFile }),
    timeoutMs: 10000,
  });
  await waitForConversation(workspace, stateDir, current => current?.reminder_message_id === "fake-message-1");
  await event(workspace, stateDir, "owner_activity", "second-owner", "2026-09-24T11:05:00Z", {
    actor_id: "owner", source_message_id: "second-question", activity_kind: "message",
  });
  await waitForConversation(workspace, stateDir, current => current?.state === "open-paused");
  await event(workspace, stateDir, "response_delivered", "second-receipt", "2026-09-24T11:10:00Z", {
    provider_session_id: "session", provider_turn_id: "turn-2", interaction_id: "second-question",
    message_id: "second-answer", disposition: "progress",
  });
  await event(workspace, stateDir, "turn_completed", "second-completion", "2026-09-24T11:10:00Z", {
    provider_session_id: "session", provider_turn_id: "turn-2", interaction_id: "second-question",
    delivered_message_ids: ["second-answer"],
  });
  await waitForConversation(workspace, stateDir, current => current?.due_at === "2026-09-24T12:10:00Z");
  fs.writeFileSync(clockFile, "2026-09-24T12:00:00Z");
  await new Promise(resolve => setTimeout(resolve, 600));
  assert.equal(readState(workspace.stateDir).fixtures.discord.messages.length, 1);
  fs.writeFileSync(clockFile, "2026-09-24T12:10:00Z");
  await waitForState(workspace, state => state.fixtures.discord.messages.length === 2);
  assert.deepEqual(readState(workspace.stateDir).fixtures.discord.deletes.map(row => row.messageId),
    ["fake-message-1"]);
  await command(workspace, stateDir, "disable");
  assert.equal((await running).exitCode, 0);
});

test("connection failures that never reached Discord back off with a finite increasing delay", async () => {
  const workspace = createWorkspace();
  const stateDir = setup(workspace);
  await reconciledExchange(workspace, stateDir);
  const rootState = path.join(workspace.homeDir, "root-discord");
  fs.mkdirSync(rootState, { recursive: true });
  fs.writeFileSync(path.join(rootState, ".env"), "DISCORD_BOT_TOKEN=fixture-root-token\n", { mode: 0o600 });
  const clockFile = path.join(workspace.tmpDir, "reminder-clock");
  fs.writeFileSync(clockFile, "2026-09-24T11:00:00Z");
  const seed = readState(workspace.stateDir);
  seed.fixtures.discord.restConnectFailures = 2;
  writeState(seed, workspace.stateDir);
  const running = runScript(workspace, "scripts/conversation-reminder-service.py", {
    args: ["run", "--project-root", workspace.repoDir, "--state-dir", stateDir],
    env: bridgeChildEnv(workspace, { ROOT_DISCORD_STATE_DIR: rootState,
      CCDM_REMINDER_NODE: process.execPath, CCDM_REMINDER_CLOCK_FILE: clockFile }),
    timeoutMs: 10000,
  });
  await waitForState(workspace, state => state.fixtures.discord.connectFailureUses === 1);
  await new Promise(resolve => setTimeout(resolve, 250));
  // A refused connection is a definite failure, never an uncertain send.
  assert.equal((await command(workspace, stateDir, "status")).conversations.demo.reconciliation_status, "ready");
  fs.writeFileSync(clockFile, "2026-09-24T11:00:05Z");
  await waitForState(workspace, state => state.fixtures.discord.connectFailureUses === 2);
  await new Promise(resolve => setTimeout(resolve, 250));
  fs.writeFileSync(clockFile, "2026-09-24T11:00:14Z");
  await new Promise(resolve => setTimeout(resolve, 600));
  assert.equal(readState(workspace.stateDir).fixtures.discord.messages.length, 0);
  fs.writeFileSync(clockFile, "2026-09-24T11:00:15Z");
  await waitForState(workspace, state => state.fixtures.discord.messages.length === 1);
  await command(workspace, stateDir, "disable");
  assert.equal((await running).exitCode, 0);
});

test("server errors retry the same nonce, so an accepted reminder is neither duplicated nor untracked", async () => {
  const workspace = createWorkspace();
  const stateDir = setup(workspace);
  await reconciledExchange(workspace, stateDir);
  const rootState = path.join(workspace.homeDir, "root-discord");
  fs.mkdirSync(rootState, { recursive: true });
  fs.writeFileSync(path.join(rootState, ".env"), "DISCORD_BOT_TOKEN=fixture-root-token\n", { mode: 0o600 });
  const clockFile = path.join(workspace.tmpDir, "reminder-clock");
  fs.writeFileSync(clockFile, "2026-09-24T11:00:00Z");
  const seed = readState(workspace.stateDir);
  // The first attempt fails before Discord creates anything; the second is
  // created by Discord and then answered with a gateway error.
  seed.fixtures.discord.restFailures = [{ method: "POST", status: 503 }];
  seed.fixtures.discord.restAcceptedFailures = [{ status: 502 }];
  writeState(seed, workspace.stateDir);
  const running = runScript(workspace, "scripts/conversation-reminder-service.py", {
    args: ["run", "--project-root", workspace.repoDir, "--state-dir", stateDir],
    env: bridgeChildEnv(workspace, { ROOT_DISCORD_STATE_DIR: rootState,
      CCDM_REMINDER_NODE: process.execPath, CCDM_REMINDER_CLOCK_FILE: clockFile }),
    timeoutMs: 15000,
  });
  const recorded = await waitForConversation(workspace, stateDir, current =>
    current?.reminder_message_id === "fake-message-1");
  assert.equal(recorded.conversations.demo.reconciliation_status, "ready");
  assert.equal(recorded.conversations.demo.due_at, "2026-09-24T12:00:00Z");
  const discord = readState(workspace.stateDir).fixtures.discord;
  assert.equal(discord.messages.length, 1, "one reminder exists and it is the recorded one");
  assert.equal(discord.reminderRequests.filter(row => row.method === "POST").length, 2);
  assert.deepEqual(discord.restFailureUses.map(row => row.status), [503]);
  await command(workspace, stateDir, "disable");
  assert.equal((await running).exitCode, 0);
});

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
  // A root mention later in the text is still root-management traffic.
  injectDiscordMessage(workspace, { channelId: "channel", id: "root-management-inline", author: { id: "owner" },
    content: "please ask <@!fixture-bot-user-id> for status" });
  await waitForState(workspace, state => state.fixtures.discord.deliveredMessages.some(row =>
    row.id === "root-management-inline"));
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

test("an acknowledgment of mid-turn progress still arms a fresh hour for the turn's final answer", async () => {
  const workspace = createWorkspace();
  const stateDir = setup(workspace);
  const turn = { provider_session_id: "session", provider_turn_id: "turn", interaction_id: "question" };
  // 10:00 the owner asks; 10:05 progress; 10:06 the owner reacts to it; 10:30 the final answer.
  await event(workspace, stateDir, "owner_activity", "ask", "2026-09-24T10:00:00Z", {
    actor_id: "owner", source_message_id: "question", activity_kind: "message",
  });
  await event(workspace, stateDir, "response_delivered", "progress-receipt", "2026-09-24T10:05:00Z", {
    ...turn, message_id: "progress", disposition: "progress",
  });
  await event(workspace, stateDir, "owner_activity", "progress-reaction", "2026-09-24T10:06:00Z", {
    actor_id: "owner", source_message_id: "progress", activity_kind: "reaction",
  });
  await event(workspace, stateDir, "response_delivered", "final-receipt", "2026-09-24T10:30:00Z", {
    ...turn, message_id: "final", disposition: "progress",
  });
  await event(workspace, stateDir, "turn_completed", "completion", "2026-09-24T10:30:00Z", {
    ...turn, delivered_message_ids: ["progress", "final"],
  });
  await command(workspace, stateDir, "sync");
  const armed = (await command(workspace, stateDir, "status")).conversations.demo;
  assert.deepEqual([armed.state, armed.response_message_id, armed.due_at],
    ["awaiting-owner", "final", "2026-09-24T11:30:00Z"]);

  // An acknowledgment of the final answer still wins over a completion that arrives later.
  await event(workspace, stateDir, "owner_activity", "ask-2", "2026-09-24T12:00:00Z", {
    actor_id: "owner", source_message_id: "question-2", activity_kind: "message",
  });
  const second = { provider_session_id: "session", provider_turn_id: "turn-2", interaction_id: "question-2" };
  await event(workspace, stateDir, "response_delivered", "final-2-receipt", "2026-09-24T12:10:00Z", {
    ...second, message_id: "final-2", disposition: "progress",
  });
  await event(workspace, stateDir, "owner_activity", "final-2-reaction", "2026-09-24T12:11:00Z", {
    actor_id: "owner", source_message_id: "final-2", activity_kind: "reaction",
  });
  await event(workspace, stateDir, "turn_completed", "completion-2", "2026-09-24T12:12:00Z", {
    ...second, delivered_message_ids: ["final-2"],
  });
  await command(workspace, stateDir, "sync");
  const acknowledged = (await command(workspace, stateDir, "status")).conversations.demo;
  assert.deepEqual([acknowledged.state, acknowledged.due_at], ["open-paused", null]);
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
  const rootState = path.join(workspace.homeDir, "root-discord");
  fs.mkdirSync(rootState, { recursive: true });
  fs.writeFileSync(path.join(rootState, ".env"), "DISCORD_BOT_TOKEN=fixture-root-token\n", { mode: 0o600 });
  const enabled = await command(workspace, stateDir, "enable", { env: bridgeChildEnv(workspace, {
    ROOT_DISCORD_STATE_DIR: rootState }) });
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
