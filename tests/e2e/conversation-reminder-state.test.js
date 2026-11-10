import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { PYTHON, assertPrivate, platformGate } from "./support/platform.js";
import { runScript } from "./support/runner.js";
import { createBridgeWorkspace, injectDiscordMessage, injectDiscordReaction, waitForState } from "./support/bridge.js";
import { routerEnv, waitFor } from "./support/router.js";
import { readState, writeState } from "./support/state.js";
import { cleanup, registerTeardownCallback } from "./support/teardown.js";
import {
  ICACLS, OBSERVER_SCRIPT, SERVICE_SCRIPT, V8_CONVERSATION, V8_RETIRED, alive, backups, claimAt, cli, command,
  downgradeToV7, event, freshCompletion, observerEnv, observerReady, observerWorkspace, pythonProbe,
  reconciledExchange, refusalsWithRetryTime, rootRouter, seedV6, sendAt, setup, sql, startObserverDriver, storeRows,
  streak, waitForConversation, waitForObserver,
} from "./support/reminder-service.js";

test.afterEach(async () => cleanup());

const windowsOnly = platformGate("win32", "Windows access lists and scheduled tasks; POSIX modes and the plist are checked elsewhere");

test("manual deletion does not acknowledge or accelerate a reminder and ordinary emoji survives", async () => {
  const workspace = createBridgeWorkspace();
  const stateDir = setup(workspace);
  await reconciledExchange(workspace, stateDir);
  const rootState = await rootRouter(workspace);
  const clockFile = path.join(workspace.tmpDir, "reminder-clock");
  fs.writeFileSync(clockFile, "2026-09-24T11:00:00Z");
  const running = runScript(workspace, "scripts/conversation-reminder-service.py", {
    args: ["run", "--project-root", workspace.repoDir, "--state-dir", stateDir],
    env: routerEnv(workspace, { ROOT_DISCORD_STATE_DIR: rootState,
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
  fs.writeFileSync(clockFile, "2026-09-24T13:00:00Z");
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
  const workspace = createBridgeWorkspace();
  const stateDir = setup(workspace);
  await reconciledExchange(workspace, stateDir);
  const rootState = await rootRouter(workspace);
  const clockFile = path.join(workspace.tmpDir, "reminder-clock");
  fs.writeFileSync(clockFile, "2026-09-24T11:00:00Z");
  const running = runScript(workspace, "scripts/conversation-reminder-service.py", {
    args: ["run", "--project-root", workspace.repoDir, "--state-dir", stateDir],
    env: routerEnv(workspace, { ROOT_DISCORD_STATE_DIR: rootState,
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
  const workspace = createBridgeWorkspace();
  const stateDir = setup(workspace);
  await reconciledExchange(workspace, stateDir);
  const rootState = await rootRouter(workspace);
  const clockFile = path.join(workspace.tmpDir, "reminder-clock");
  fs.writeFileSync(clockFile, "2026-09-24T11:00:00Z");
  const running = runScript(workspace, "scripts/conversation-reminder-service.py", {
    args: ["run", "--project-root", workspace.repoDir, "--state-dir", stateDir],
    env: routerEnv(workspace, { ROOT_DISCORD_STATE_DIR: rootState,
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
  const workspace = createBridgeWorkspace();
  const stateDir = setup(workspace);
  await reconciledExchange(workspace, stateDir);
  const rootState = await rootRouter(workspace);
  const clockFile = path.join(workspace.tmpDir, "reminder-clock");
  fs.writeFileSync(clockFile, "2026-09-24T11:00:00Z");
  const seed = readState(workspace.stateDir);
  seed.fixtures.discord.restConnectFailures = 2;
  writeState(seed, workspace.stateDir);
  const running = runScript(workspace, "scripts/conversation-reminder-service.py", {
    args: ["run", "--project-root", workspace.repoDir, "--state-dir", stateDir],
    env: routerEnv(workspace, { ROOT_DISCORD_STATE_DIR: rootState,
      CCDM_REMINDER_NODE: process.execPath, CCDM_REMINDER_CLOCK_FILE: clockFile }),
    timeoutMs: 10000,
  });
  await waitForState(workspace, state => state.fixtures.discord.connectFailureUses === 1);
  // Each retry time counts from the clock when its failure is recorded.
  await waitFor(() => refusalsWithRetryTime(stateDir).length === 1, () => "the first failure to be recorded", 15000);
  // A refused connection is a definite failure, never an uncertain send.
  assert.equal((await command(workspace, stateDir, "status")).conversations.demo.reconciliation_status, "ready");
  fs.writeFileSync(clockFile, "2026-09-24T11:00:05Z");
  await waitForState(workspace, state => state.fixtures.discord.connectFailureUses === 2);
  await waitFor(() => refusalsWithRetryTime(stateDir).length === 2, () => "the second failure to be recorded", 15000);
  fs.writeFileSync(clockFile, "2026-09-24T11:00:14Z");
  await new Promise(resolve => setTimeout(resolve, 600));
  assert.equal(readState(workspace.stateDir).fixtures.discord.messages.length, 0);
  fs.writeFileSync(clockFile, "2026-09-24T11:00:15Z");
  await waitForState(workspace, state => state.fixtures.discord.messages.length === 1);
  await command(workspace, stateDir, "disable");
  assert.equal((await running).exitCode, 0);
});

test("server errors retry the same nonce, so an accepted reminder is neither duplicated nor untracked", async () => {
  const workspace = createBridgeWorkspace();
  const stateDir = setup(workspace);
  await reconciledExchange(workspace, stateDir);
  const rootState = await rootRouter(workspace);
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
    env: routerEnv(workspace, { ROOT_DISCORD_STATE_DIR: rootState,
      CCDM_REMINDER_NODE: process.execPath, CCDM_REMINDER_CLOCK_FILE: clockFile }),
    timeoutMs: 15000,
  });
  const recorded = await waitForConversation(workspace, stateDir, current =>
    current?.reminder_message_id === "fake-message-1");
  assert.equal(recorded.conversations.demo.reconciliation_status, "ready");
  assert.equal(recorded.conversations.demo.due_at, "2026-09-24T13:00:00Z");
  const discord = readState(workspace.stateDir).fixtures.discord;
  assert.equal(discord.messages.length, 1, "one reminder exists and it is the recorded one");
  assert.equal(discord.reminderRequests.filter(row => row.method === "POST").length, 2);
  assert.deepEqual(discord.restFailureUses.map(row => row.status), [503]);
  await command(workspace, stateDir, "disable");
  assert.equal((await running).exitCode, 0);
});

test("owner closure persists, normal owner message reopens, and a confirmed completion exposes its due time", async () => {
  const workspace = createBridgeWorkspace();
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
  const workspace = createBridgeWorkspace();
  const stateDir = setup(workspace);
  const rootState = await rootRouter(workspace);

  const running = runScript(workspace, "scripts/conversation-reminder-service.py", {
    args: ["run", "--project-root", workspace.repoDir, "--state-dir", stateDir],
    env: routerEnv(workspace, { ROOT_DISCORD_STATE_DIR: rootState, CCDM_REMINDER_NODE: process.execPath }),
    timeoutMs: 10000,
  });
  await waitForObserver(workspace, stateDir);
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
    "Bot fixture-root-token");
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
  const workspace = createBridgeWorkspace();
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
  const workspace = createBridgeWorkspace();
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
  const workspace = createBridgeWorkspace();
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

test("duplicate owner observations from root and project adapters do not cancel a later response", async () => {
  const workspace = createBridgeWorkspace();
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

test("a delayed copy of an owner reaction cannot clear a later arm, but a distinct later reaction does", async () => {
  const workspace = createBridgeWorkspace();
  const stateDir = setup(workspace);
  const turn = { provider_session_id: "session", provider_turn_id: "turn", interaction_id: "question" };
  const thumbs = { actor_id: "owner", source_message_id: "progress", activity_kind: "reaction", reaction_emoji: "👍" };
  await event(workspace, stateDir, "owner_activity", "ask", "2026-09-24T10:00:00Z", {
    actor_id: "owner", source_message_id: "question", activity_kind: "message",
  });
  await event(workspace, stateDir, "response_delivered", "progress-receipt", "2026-09-24T10:05:00Z", {
    ...turn, message_id: "progress", disposition: "progress",
  });
  // The root observer commits its copy of the owner's reaction promptly.
  await event(workspace, stateDir, "owner_activity", "root-reaction", "2026-09-24T10:06:00Z", {
    ...thumbs, provider: "ccdm-root",
  });
  await event(workspace, stateDir, "response_delivered", "final-receipt", "2026-09-24T10:30:00Z", {
    ...turn, message_id: "final", disposition: "progress",
  });
  await event(workspace, stateDir, "turn_completed", "completion", "2026-09-24T10:30:00Z", {
    ...turn, delivered_message_ids: ["progress", "final"],
  });
  await command(workspace, stateDir, "sync");
  const armed = (await command(workspace, stateDir, "status")).conversations.demo;
  assert.deepEqual([armed.state, armed.due_at], ["awaiting-owner", "2026-09-24T11:30:00Z"]);

  // The Codex bridge's copy of that same reaction arrives only after the arm.
  await event(workspace, stateDir, "owner_activity", "bridge-reaction", "2026-09-24T10:06:02Z", thumbs);
  await command(workspace, stateDir, "sync");
  const kept = (await command(workspace, stateDir, "status")).conversations.demo;
  assert.deepEqual([kept.state, kept.due_at], ["awaiting-owner", "2026-09-24T11:30:00Z"]);

  // Re-adding the same emoji later is a new acknowledgment.
  await event(workspace, stateDir, "owner_activity", "readded-reaction", "2026-09-24T10:45:00Z", {
    ...thumbs, provider: "ccdm-root",
  });
  await command(workspace, stateDir, "sync");
  const acknowledged = (await command(workspace, stateDir, "status")).conversations.demo;
  assert.deepEqual([acknowledged.state, acknowledged.due_at, acknowledged.last_ack_at],
    ["open-paused", null, "2026-09-24T10:45:00Z"]);
});

test("disable survives restart and explicit enable preserves a closed conversation", async () => {
  const workspace = createBridgeWorkspace();
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
  const enabled = await command(workspace, stateDir, "enable", { env: routerEnv(workspace, {
    ROOT_DISCORD_STATE_DIR: rootState }) });
  assert.equal(enabled.disabled, false);
  assert.equal(enabled.conversations.demo.state, "closed");
});

test("a second foreground observer is refused while the first owns the store", async () => {
  const workspace = createBridgeWorkspace();
  const stateDir = setup(workspace);
  const rootState = await rootRouter(workspace);
  const env = routerEnv(workspace, { ROOT_DISCORD_STATE_DIR: rootState, CCDM_REMINDER_NODE: process.execPath });
  const args = ["run", "--project-root", workspace.repoDir, "--state-dir", stateDir];
  const first = runScript(workspace, "scripts/conversation-reminder-service.py", { args, env, timeoutMs: 10000 });
  await waitForObserver(workspace, stateDir);
  assert.equal((await command(workspace, stateDir, "status")).worker_running, true);
  const second = await runScript(workspace, "scripts/conversation-reminder-service.py", { args, env });
  assert.equal(second.exitCode, 2);
  assert.match(JSON.parse(second.stdout).reason, /already running/);
  await command(workspace, stateDir, "disable");
  assert.equal((await first).exitCode, 0);
});

test("missing root credentials fail the foreground observer closed", async () => {
  const workspace = createBridgeWorkspace();
  const stateDir = setup(workspace);
  const result = await runScript(workspace, "scripts/conversation-reminder-service.py", {
    args: ["run", "--project-root", workspace.repoDir, "--state-dir", stateDir],
    env: routerEnv(workspace, { ROOT_DISCORD_STATE_DIR: path.join(workspace.homeDir, "missing-root"),
      CCDM_REMINDER_NODE: process.execPath }), timeoutMs: 5000,
  });
  assert.equal(result.exitCode, 2);
  assert.equal(JSON.parse(result.stdout).status, "blocked");
  // It never joins the Router as the observer.
  assert.equal(fs.existsSync(path.join(workspace.routerStateDir, "keys", ".observer.key")), false);
});

test("a corrupt conversation store is reported without initializing over it", async () => {
  const workspace = createBridgeWorkspace();
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
  const workspace = createBridgeWorkspace();
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
  const workspace = createBridgeWorkspace();
  const stateDir = setup(workspace);
  fs.mkdirSync(stateDir, { recursive: true });
  const database = path.join(stateDir, "conversations.sqlite3");
  const seeded = spawnSync(PYTHON, ["-c", `import sqlite3,sys
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
  const workspace = createBridgeWorkspace();
  const stateDir = setup(workspace);
  await command(workspace, stateDir, "sync");
  const status = await command(workspace, stateDir, "status");
  assert.equal(status.conversations.demo.reconciliation_status, "suspended-incomplete-discovery");
  assert.equal(status.conversations.demo.state, "open-paused");
  // A project the service has not recorded yet explains how to start tracking it.
  const registryPath = path.join(workspace.repoDir, "registry.json");
  const registry = JSON.parse(fs.readFileSync(registryPath, "utf8"));
  registry.projects.later = { type: "codex", webhook_id: "later-webhook", channel_id: "later-channel" };
  fs.writeFileSync(registryPath, JSON.stringify(registry), { mode: 0o600 });
  const untracked = (await command(workspace, stateDir, "status")).readiness.projects.later;
  assert.equal(untracked.history, "untracked");
  assert.match(untracked.blockers.join("\n"), /history: untracked; .*start the worker \(`run`.*assignment-changed --project later/);
});

test("a subsecond completion never gets an early due time", async () => {
  const workspace = createBridgeWorkspace();
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
  const workspace = createBridgeWorkspace();
  const stateDir = setup(workspace);
  for (const source of [undefined, ""]) {
    const result = await runScript(workspace, "scripts/conversation-reminder-events.py", {
      args: ["ingest", "--project-root", workspace.repoDir, "--state-dir", stateDir],
      input: JSON.stringify({
        schema_version: 1, event_id: `missing-close-source-${String(source)}`, event_type: "close_requested",
        project: "demo", channel_id: "channel", bot_id: "router:webhook", assignment_generation: "generation-1",
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
  const workspace = createBridgeWorkspace();
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

test("the worker reads a ledger with no events table as empty, and still surfaces other database errors", async () => {
  const workspace = createBridgeWorkspace();
  const script = path.join(workspace.repoDir, "scripts", "conversation-reminder-service.py");
  const stateDir = path.join(workspace.tmpDir, "missing-table-state");
  const probe = spawnSync(PYTHON, ["-c", `import importlib.util,json,sqlite3,sys
from pathlib import Path
spec=importlib.util.spec_from_file_location("service", sys.argv[1]); service=importlib.util.module_from_spec(spec)
spec.loader.exec_module(service)
service.is_private=lambda path: True
state=Path(sys.argv[2]); state.mkdir()
path=service.EVENTS.database_path(state); path.parent.mkdir(parents=True,exist_ok=True)
def read():
    return [len(service.event_rows(state)), len(service.rows_matching(state,"p","g","1=1"))]
def error(reader):
    try:
        reader(); return None
    except sqlite3.OperationalError as caught:
        return str(caught)
db=sqlite3.connect(path); db.execute("CREATE TABLE other (id INTEGER)"); db.commit(); db.close()
empty=read()
db=sqlite3.connect(path); db.execute("CREATE TABLE events (id INTEGER)"); db.commit(); db.close()
print(json.dumps([empty, error(lambda: service.event_rows(state)), error(lambda: service.rows_matching(state,"p","g","1=1"))]))`,
  script, stateDir], { encoding: "utf8" });
  assert.equal(probe.status, 0, probe.stderr);
  const [empty, eventRowsError, rowsMatchingError] = JSON.parse(probe.stdout);
  assert.deepEqual(empty, [0, 0]);
  assert.match(eventRowsError, /no such column/);
  assert.match(rowsMatchingError, /no such column/);
});

test("the reminder gap follows 1h, then 2h per ignored reminder, capped at 24h", async () => {
  const workspace = createBridgeWorkspace();
  const script = path.join(workspace.repoDir, "scripts", "conversation-reminder-service.py");
  const probe = spawnSync(PYTHON, ["-c", `import importlib.util,json,sys
spec=importlib.util.spec_from_file_location("service", sys.argv[1]); service=importlib.util.module_from_spec(spec)
spec.loader.exec_module(service)
print(json.dumps([service.reminder_gap(k).total_seconds() / 3600 for k in [*range(16), 1000]]))`, script],
  { encoding: "utf8" });
  assert.equal(probe.status, 0, probe.stderr);
  assert.deepEqual(JSON.parse(probe.stdout),
    [1, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 24, 24, 24, 24]);
});

test("a long ignored streak settles on one reminder a day", async () => {
  const workspace = createBridgeWorkspace();
  const stateDir = setup(workspace);
  await reconciledExchange(workspace, stateDir);
  sql(path.join(stateDir, "conversations.sqlite3"),
    "UPDATE conversations SET consecutive_reminders=11 WHERE project='demo'");
  const clockFile = path.join(workspace.tmpDir, "reminder-clock");
  assert.deepEqual(streak(await sendAt(workspace, stateDir, clockFile, "2026-09-24T11:00:00Z", "r-12")),
    ["awaiting-owner", "2026-09-25T11:00:00Z", 12]);
  assert.equal(await claimAt(workspace, stateDir, clockFile, "2026-09-25T10:59:59Z"), null);
  assert.deepEqual(streak(await sendAt(workspace, stateDir, clockFile, "2026-09-25T11:00:00Z", "r-13")),
    ["awaiting-owner", "2026-09-26T11:00:00Z", 13]);
});

test("an owner reply ends the ignored streak, so the next response starts again at one hour", async () => {
  const workspace = createBridgeWorkspace();
  const stateDir = setup(workspace);
  await reconciledExchange(workspace, stateDir);
  const clockFile = path.join(workspace.tmpDir, "reminder-clock");
  await sendAt(workspace, stateDir, clockFile, "2026-09-24T11:00:00Z", "r-1");
  assert.deepEqual(streak(await sendAt(workspace, stateDir, clockFile, "2026-09-24T13:00:00Z", "r-2")),
    ["awaiting-owner", "2026-09-24T17:00:00Z", 2]);
  await event(workspace, stateDir, "owner_activity", "reply-owner", "2026-09-24T14:00:00Z", {
    actor_id: "owner", source_message_id: "reply-question", activity_kind: "message",
  });
  await cli(workspace, stateDir, "sync");
  const paused = (await cli(workspace, stateDir, "status")).conversations.demo;
  assert.deepEqual([...streak(paused), paused.reminder_message_id], ["open-paused", null, 0, null]);
  assert.ok(paused.cleanup_message_ids.includes("r-2"), "the ignored reminder is queued for deletion");
  assert.deepEqual(streak(await freshCompletion(workspace, stateDir, "turn-2", "reply-question", "2026-09-24T15:00:00Z")),
    ["awaiting-owner", "2026-09-24T16:00:00Z", 0]);
  assert.deepEqual(streak(await sendAt(workspace, stateDir, clockFile, "2026-09-24T16:00:00Z", "r-3")),
    ["awaiting-owner", "2026-09-24T18:00:00Z", 1]);
});

test("a fresh qualifying response while awaiting the owner resets the streak to one hour", async () => {
  const workspace = createBridgeWorkspace();
  const stateDir = setup(workspace);
  await reconciledExchange(workspace, stateDir);
  const clockFile = path.join(workspace.tmpDir, "reminder-clock");
  await sendAt(workspace, stateDir, clockFile, "2026-09-24T11:00:00Z", "r-1");
  await sendAt(workspace, stateDir, clockFile, "2026-09-24T13:00:00Z", "r-2");
  const rearmed = await freshCompletion(workspace, stateDir, "turn-2", "delivery-question", "2026-09-24T14:00:00Z");
  assert.deepEqual([...streak(rearmed), rearmed.reminder_message_id],
    ["awaiting-owner", "2026-09-24T15:00:00Z", 0, "r-2"]);
  assert.equal(await claimAt(workspace, stateDir, clockFile, "2026-09-24T14:59:59Z"), null);
  assert.deepEqual(streak(await sendAt(workspace, stateDir, clockFile, "2026-09-24T15:00:00Z", "r-3")),
    ["awaiting-owner", "2026-09-24T17:00:00Z", 1]);
});

test("closing and reopening a conversation starts its next streak at one hour", async () => {
  const workspace = createBridgeWorkspace();
  const stateDir = setup(workspace);
  await reconciledExchange(workspace, stateDir);
  const clockFile = path.join(workspace.tmpDir, "reminder-clock");
  await sendAt(workspace, stateDir, clockFile, "2026-09-24T11:00:00Z", "r-1");
  await sendAt(workspace, stateDir, clockFile, "2026-09-24T13:00:00Z", "r-2");
  await event(workspace, stateDir, "close_requested", "streak-close", "2026-09-24T14:00:00Z", {
    actor_id: "owner", source_message_id: "streak-close-message", command: "/close",
  });
  await cli(workspace, stateDir, "sync");
  assert.deepEqual(streak((await cli(workspace, stateDir, "status")).conversations.demo), ["closed", null, 0]);
  await event(workspace, stateDir, "owner_activity", "reopen-owner", "2026-09-24T15:00:00Z", {
    actor_id: "owner", source_message_id: "reopen-question", activity_kind: "message",
  });
  assert.deepEqual(streak(await freshCompletion(workspace, stateDir, "turn-2", "reopen-question", "2026-09-24T16:00:00Z")),
    ["awaiting-owner", "2026-09-24T17:00:00Z", 0]);
  assert.deepEqual(streak(await sendAt(workspace, stateDir, clockFile, "2026-09-24T17:00:00Z", "r-3")),
    ["awaiting-owner", "2026-09-24T19:00:00Z", 1]);
});

test("a canceled send and a late send after reassignment never grow the streak", async () => {
  const workspace = createBridgeWorkspace();
  const stateDir = setup(workspace);
  await reconciledExchange(workspace, stateDir);
  const clockFile = path.join(workspace.tmpDir, "reminder-clock");
  const env = { CCDM_REMINDER_CLOCK_FILE: clockFile };
  await sendAt(workspace, stateDir, clockFile, "2026-09-24T11:00:00Z", "r-1");
  // A fresh response lands after the claim: the returned reminder is canceled.
  const canceledClaim = await claimAt(workspace, stateDir, clockFile, "2026-09-24T13:00:00Z");
  await freshCompletion(workspace, stateDir, "turn-2", "delivery-question", "2026-09-24T13:00:30Z");
  await cli(workspace, stateDir, "result", ["--nonce", canceledClaim.nonce, "--outcome", "sent",
    "--message-id", "r-canceled", "--sent-at", "2026-09-24T13:00:00Z"], env);
  const canceled = (await cli(workspace, stateDir, "status")).conversations.demo;
  assert.deepEqual([...streak(canceled), canceled.reminder_message_id],
    ["awaiting-owner", "2026-09-24T14:00:30Z", 0, "r-1"]);
  assert.deepEqual(canceled.cleanup_message_ids, ["r-canceled"]);

  // The assignment changes while the next request is in flight: the late send
  // belongs to the retired generation and the new conversation starts at zero.
  const lateClaim = await claimAt(workspace, stateDir, clockFile, "2026-09-24T14:00:30Z");
  assert.ok(lateClaim?.nonce);
  const registryPath = path.join(workspace.repoDir, "registry.json");
  const registry = JSON.parse(fs.readFileSync(registryPath, "utf8"));
  registry.projects.demo.assignment_generation = "generation-2";
  fs.writeFileSync(registryPath, JSON.stringify(registry), { mode: 0o600 });
  await cli(workspace, stateDir, "result", ["--nonce", lateClaim.nonce, "--outcome", "sent",
    "--message-id", "r-late", "--sent-at", "2026-09-24T14:00:30Z"], env);
  const replaced = (await cli(workspace, stateDir, "status")).conversations.demo;
  assert.deepEqual([replaced.assignment_generation, replaced.consecutive_reminders, replaced.reminder_message_id],
    ["generation-2", 0, null]);
});

test("a v5 store upgrades to v8, keeping a recorded reminder's pending due time", async () => {
  const downgrade = `ALTER TABLE conversations DROP COLUMN consecutive_reminders;
    ALTER TABLE conversations RENAME COLUMN identity TO bot_id; UPDATE conversations SET bot_id='bot';
    ALTER TABLE retired_assignments RENAME COLUMN identity TO bot_id; PRAGMA user_version=5;`;
  const withReminder = createBridgeWorkspace();
  const stateDir = setup(withReminder);
  await reconciledExchange(withReminder, stateDir);
  const clockFile = path.join(withReminder.tmpDir, "reminder-clock");
  await sendAt(withReminder, stateDir, clockFile, "2026-09-24T11:00:00Z", "r-1");
  const database = path.join(stateDir, "conversations.sqlite3");
  downgradeToV7(database);
  sql(database, downgrade);
  const upgraded = (await cli(withReminder, stateDir, "status")).conversations.demo;
  assert.deepEqual([...streak(upgraded), upgraded.reminder_message_id],
    ["awaiting-owner", "2026-09-24T13:00:00Z", 1, "r-1"]);
  const version = spawnSync(PYTHON, ["-c", "import sqlite3,sys; print(sqlite3.connect(sys.argv[1]).execute('PRAGMA user_version').fetchone()[0])", database], { encoding: "utf8" });
  assert.equal(version.stdout.trim(), "8");
  // Every v5 assignment was a pool bot, so the row stays readable as history,
  // but the Router's webhook now speaks for demo: nothing sends until the
  // operator records the assignment change.
  assert.equal(upgraded.identity, "pool:bot");
  assert.equal(await claimAt(withReminder, stateDir, clockFile, "2026-09-24T13:00:00Z"), null);
  assert.match((await cli(withReminder, stateDir, "status")).readiness.projects.demo.blockers.join("\n"),
    /transport changed; run assignment-changed --project demo/);

  const withoutReminder = createBridgeWorkspace();
  const otherDir = setup(withoutReminder);
  await reconciledExchange(withoutReminder, otherDir);
  downgradeToV7(path.join(otherDir, "conversations.sqlite3"));
  sql(path.join(otherDir, "conversations.sqlite3"), downgrade);
  assert.deepEqual(streak((await cli(withoutReminder, otherDir, "status")).conversations.demo),
    ["awaiting-owner", "2026-09-24T11:00:00Z", 0]);
});

test("a fresh store is created at v8, and a v8 store without the streak or a future version fails closed", async () => {
  const workspace = createBridgeWorkspace();
  const stateDir = setup(workspace);
  await cli(workspace, stateDir, "sync");
  const database = path.join(stateDir, "conversations.sqlite3");
  const shape = spawnSync(PYTHON, ["-c", `import json,sqlite3,sys
db=sqlite3.connect(sys.argv[1])
print(json.dumps([db.execute('PRAGMA user_version').fetchone()[0],
  'consecutive_reminders' in [row[1] for row in db.execute('PRAGMA table_info(conversations)')]]))`, database],
  { encoding: "utf8" });
  assert.deepEqual(JSON.parse(shape.stdout), [8, true]);
  for (const script of ["PRAGMA user_version=9;",
    "ALTER TABLE conversations DROP COLUMN consecutive_reminders;"]) {
    const copy = createBridgeWorkspace();
    const copyDir = setup(copy);
    await cli(copy, copyDir, "sync");
    sql(path.join(copyDir, "conversations.sqlite3"), script);
    const result = await runScript(copy, "scripts/conversation-reminder-service.py", {
      args: ["status", "--project-root", copy.repoDir, "--state-dir", copyDir],
    });
    assert.equal(result.exitCode, 2, script);
    assert.deepEqual(JSON.parse(result.stdout),
      { status: "blocked", reason: "conversation store schema is unsupported" }, script);
  }
});

test("a v6 store migrates to v8, keying conversations and retired assignments by pool identity", async () => {
  const workspace = createBridgeWorkspace();
  const { stateDir, database } = seedV6(workspace);
  const status = await cli(workspace, stateDir, "status");
  assert.equal(status.conversations.demo.identity, "pool:bot");
  assert.equal(status.conversations.demo.consecutive_reminders, 2);
  assert.equal(status.retired_assignments[0].identity, "pool:old-bot");
  assert.deepEqual(storeRows(database),
    { version: 8, conversations: [V8_CONVERSATION], retired_assignments: [V8_RETIRED] });

  // The pre-migration store is kept privately beside the migrated one.
  assert.deepEqual(backups(stateDir), ["conversations.v6.backup.sqlite3"]);
  const backup = path.join(stateDir, "conversations.v6.backup.sqlite3");
  assertPrivate(backup);
  const original = storeRows(backup);
  assert.equal(original.version, 6);
  assert.deepEqual(original.conversations[0].bot_id, "bot");
  assert.deepEqual(original.retired_assignments[0].bot_id, "old-bot");

  // The retired assignment's cleanup still names its former pool bot as
  // history; root deletes that reminder with its own token.
  const actions = await cli(workspace, stateDir, "actions");
  assert.deepEqual(actions.actions.map(a => [a.message_id, a.channel_id, a.bot_id, a.retired]),
    [["r-old", "old-channel", "old-bot", true]]);

  // Re-running on the v8 store changes nothing and takes no second backup.
  await cli(workspace, stateDir, "status");
  assert.deepEqual(storeRows(database),
    { version: 8, conversations: [V8_CONVERSATION], retired_assignments: [V8_RETIRED] });
  assert.deepEqual(backups(stateDir), ["conversations.v6.backup.sqlite3"]);
});

test("a failed v7 migration leaves the v6 store usable", async () => {
  const workspace = createBridgeWorkspace();
  const { stateDir, database } = seedV6(workspace);
  // An injected failure aborts the identity rewrite partway through.
  sql(database, `CREATE TRIGGER fail_migration BEFORE UPDATE ON retired_assignments
    BEGIN SELECT RAISE(ABORT, 'injected migration failure'); END;`);
  const failed = await runScript(workspace, "scripts/conversation-reminder-service.py", {
    args: ["status", "--project-root", workspace.repoDir, "--state-dir", stateDir],
  });
  assert.notEqual(failed.exitCode, 0);
  const untouched = storeRows(database);
  assert.equal(untouched.version, 6);
  assert.equal(untouched.conversations[0].bot_id, "bot");
  assert.equal(untouched.retired_assignments[0].bot_id, "old-bot");
  assert.deepEqual(backups(stateDir), ["conversations.v6.backup.sqlite3"]);

  sql(database, "DROP TRIGGER fail_migration;");
  await cli(workspace, stateDir, "status");
  assert.deepEqual(storeRows(database),
    { version: 8, conversations: [V8_CONVERSATION], retired_assignments: [V8_RETIRED] });
});

test("the worker stops its observer by closing its stdin: it exits 0 well inside 15 s and no observer remains", async () => {
  const { workspace, stateDir, rootState } = await observerWorkspace();
  const driver = await startObserverDriver(workspace, stateDir, rootState);
  driver.child.stdin.write("stop\n");
  const stopped = await waitFor(() => driver.lines()[1], () => "the observer to stop", 40000);
  assert.equal(stopped.code, 0);
  assert.ok(stopped.seconds < 15, `the stop took ${stopped.seconds} s`);
  assert.equal(alive(driver.pid), false, "the observer is still running");
  assert.equal(await driver.exited, 0);
});

test("an observer whose worker is killed sees its stdin close and exits by itself", async () => {
  const { workspace, stateDir, rootState } = await observerWorkspace();
  const driver = await startObserverDriver(workspace, stateDir, rootState);
  driver.child.kill("SIGKILL");
  await driver.exited;
  await waitFor(() => !alive(driver.pid), () => "the orphaned observer to exit", 15000);
});

// An observer started the old way has no stop flag: its stdin is nothing, or a
// pipe that has already ended, and neither may stop it.
for (const [name, stdin] of [["no stdin", "ignore"], ["an ended stdin pipe", "pipe"]]) {
  test(`an observer started without the stop flag keeps observing with ${name}, and SIGTERM still stops it`, async () => {
    const { workspace, stateDir, rootState } = await observerWorkspace();
    const child = spawn(process.execPath, [path.join(workspace.repoDir, OBSERVER_SCRIPT),
      "--project-root", workspace.repoDir, "--state-dir", stateDir], {
      cwd: workspace.repoDir, env: observerEnv(workspace, stateDir, rootState), stdio: [stdin, "ignore", "pipe"],
      windowsHide: true,
    });
    child.stdin?.end();
    child.stderr.resume();
    const exited = new Promise(resolve => child.once("exit", (code, signal) => resolve({ code, signal })));
    registerTeardownCallback(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited;
    });
    // It reaches the channel after its stdin ended, and stays.
    await observerReady(stateDir);
    await new Promise(resolve => setTimeout(resolve, 1000));
    assert.deepEqual([child.exitCode, child.signalCode], [null, null]);
    child.kill("SIGTERM");
    const stopped = await exited;
    // A caught SIGTERM is a clean exit; on Windows the same call is a hard kill.
    if (process.platform !== "win32") assert.deepEqual(stopped, { code: 0, signal: null });
  });
}

test("on Windows the events, store and health files are private in a protected state dir and refused in an inherited one", windowsOnly, async () => {
  const workspace = createBridgeWorkspace();
  const stateDir = setup(workspace);
  await reconciledExchange(workspace, stateDir);
  const rootState = await rootRouter(workspace);
  const running = runScript(workspace, SERVICE_SCRIPT, {
    args: ["run", "--project-root", workspace.repoDir, "--state-dir", stateDir],
    env: routerEnv(workspace, { ROOT_DISCORD_STATE_DIR: rootState, CCDM_REMINDER_NODE: process.execPath }),
    timeoutMs: 60000,
  });
  // status reads the observer's health file, and accepts it.
  await waitForObserver(workspace, stateDir);
  await command(workspace, stateDir, "disable");
  assert.equal((await running).exitCode, 0);

  const files = ["events.sqlite3", "conversations.sqlite3", "observer-health.json"];
  const isPrivate = () => pythonProbe(workspace, "privacy-probe.py", [
    "import os",
    "from ccdmlib.platform.private_fs import is_private",
    "print(json.dumps({name: is_private(os.path.join(sys.argv[2], name)) for name in sys.argv[3:]}))",
  ], [stateDir, ...files]);
  assertPrivate(stateDir);
  for (const name of files) assertPrivate(path.join(stateDir, name), name);
  assert.deepEqual(await isPrivate(), Object.fromEntries(files.map(name => [name, true])));

  // The directory takes its parent's permissions again: nothing in it is trusted.
  const inherited = spawnSync(ICACLS, [stateDir, "/inheritance:e"], { encoding: "utf8", windowsHide: true });
  assert.equal(inherited.status, 0, inherited.stdout + inherited.stderr);
  assert.deepEqual(await isPrivate(), Object.fromEntries(files.map(name => [name, false])));
  const refused = await runScript(workspace, SERVICE_SCRIPT, {
    args: ["status", "--project-root", workspace.repoDir, "--state-dir", stateDir],
  });
  assert.equal(refused.exitCode, 2, refused.stdout);
  assert.match(JSON.parse(refused.stdout).reason, /permissions are not private/);
  const events = await runScript(workspace, "scripts/conversation-reminder-events.py", {
    args: ["status", "--project", "demo", "--state-dir", stateDir],
  });
  assert.deepEqual([JSON.parse(events.stdout).available, JSON.parse(events.stdout).reason],
    [false, "event database permissions are not private"]);
});

test("service_installed asks schtasks for a service's task under both of its names", windowsOnly, async () => {
  const workspace = createBridgeWorkspace();
  const installed = name => pythonProbe(workspace, "service-installed.py", [
    "from ccdmlib.platform.services import service_installed",
    "try:",
    "    print(json.dumps(service_installed(sys.argv[2])))",
    "except ValueError as error:",
    "    print(json.dumps(str(error)))",
  ], [name]);
  const fixture = () => readState(workspace.stateDir).fixtures.schtasks;
  const setTasks = tasks => {
    const state = readState(workspace.stateDir);
    state.fixtures.schtasks.tasks = tasks;
    state.fixtures.schtasks.invocations = [];
    writeState(state, workspace.stateDir);
  };
  const folder = String.raw`\CCDM\ThreadSupervisor`;

  // No task: both names are asked, with a query and nothing else.
  assert.equal(await installed("thread-supervisor"), false);
  assert.deepEqual(fixture().invocations.map(({ name, verb }) => [verb, name]),
    [["/query", folder], ["/query", "CCDM-ThreadSupervisor"]]);
  for (const task of [folder, "CCDM-ThreadSupervisor"]) {
    setTasks([task]);
    assert.equal(await installed("thread-supervisor"), true, task);
  }
  // Another service's task is not this one's.
  setTasks([String.raw`\CCDM\Router`]);
  assert.equal(await installed("thread-supervisor"), false);
  assert.equal(await installed("router"), true);
  assert.equal(await installed("no-such-service"), "unknown service: no-such-service");
});
