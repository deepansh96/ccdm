import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { assertPrivate } from "./support/platform.js";
import { runScript } from "./support/runner.js";
import { createBridgeWorkspace, injectDiscordMessage, startFakeCodexServer } from "./support/bridge.js";
import { OWNER_ID, waitFor } from "./support/router.js";
import { readState, updateState } from "./support/state.js";
import { cleanup } from "./support/teardown.js";
import { supervisorEnv } from "./support/thread-supervisor.js";
import {
  FAST_POLL, ROOT_AUTH, THREAD_A, THREAD_B, V7_STORE, V8_STORE, agentReplies, answeredThread, backups, cli,
  createThread, eyes, guest, ingest, owner, posts, seedV7, settle, sql, storeRows, supervisedThread,
  threadReminderWorkspace, threadReminders,
} from "./support/reminder-threads.js";

test.afterEach(async () => cleanup());

test("a v7 store migrates to v8, keying every row by its Channel Conversation", async () => {
  const workspace = createBridgeWorkspace();
  const { stateDir, database } = seedV7(workspace);
  const status = await cli(workspace, stateDir, "status");
  assert.deepEqual(storeRows(database), V8_STORE);

  // Channel status is unchanged: no conversation id, the same timers and streak.
  const demo = status.conversations.demo;
  assert.equal("conversation_id" in demo, false);
  assert.deepEqual([demo.channel_id, demo.identity, demo.state, demo.due_at, demo.consecutive_reminders,
    demo.reminder_message_id, demo.catch_up_queued],
  ["channel", "router:webhook", "awaiting-owner", "2026-09-24T17:00:00Z", 2, "r-2", true]);
  assert.deepEqual([status.conversations.quiet.state, status.conversations.quiet.last_ack_message_id],
    ["closed", "close-1"]);
  assert.equal(status.retired_assignments[0].channel_id, "old-channel");
});

test("the v7 store is backed up unchanged before migrating, and a v8 store is left alone", async () => {
  const workspace = createBridgeWorkspace();
  const { stateDir, database } = seedV7(workspace);
  await cli(workspace, stateDir, "status");
  assert.deepEqual(backups(stateDir), ["conversations.v7.backup.sqlite3"]);
  const backup = path.join(stateDir, "conversations.v7.backup.sqlite3");
  assertPrivate(backup);
  assert.deepEqual(storeRows(backup), V7_STORE);

  // Re-running on the v8 store changes nothing and takes no second backup.
  await cli(workspace, stateDir, "sync");
  await cli(workspace, stateDir, "status");
  assert.deepEqual(storeRows(database), V8_STORE);
  assert.deepEqual(backups(stateDir), ["conversations.v7.backup.sqlite3"]);
});

test("a failed v8 migration leaves the v7 store unchanged and usable", async () => {
  const workspace = createBridgeWorkspace();
  const { stateDir, database } = seedV7(workspace);
  // An injected failure aborts the migration after most tables were re-keyed.
  sql(database, `CREATE TRIGGER fail_migration BEFORE UPDATE ON delivery_intents
    BEGIN SELECT RAISE(ABORT, 'injected migration failure'); END;`);
  const failed = await runScript(workspace, "scripts/conversation-reminder-service.py", {
    args: ["status", "--project-root", workspace.repoDir, "--state-dir", stateDir],
  });
  assert.notEqual(failed.exitCode, 0);
  assert.deepEqual(storeRows(database), V7_STORE);
  assert.deepEqual(backups(stateDir), ["conversations.v7.backup.sqlite3"]);

  sql(database, "DROP TRIGGER fail_migration;");
  await cli(workspace, stateDir, "status");
  assert.deepEqual(storeRows(database), V8_STORE);
});

test("adapter and observer events may name their conversation, defaulting to the channel", async () => {
  const workspace = createBridgeWorkspace();
  const { stateDir } = seedV7(workspace);
  await cli(workspace, stateDir, "status");
  assert.equal(await ingest(workspace, stateDir, "bad-conversation", { conversation_id: "", source_message_id: "m-0" }),
    "rejected");

  // An adapter message in another conversation never pauses the channel's reminders.
  assert.equal(await ingest(workspace, stateDir, "thread-owner", {
    conversation_id: "thread-1", source_message_id: "thread-message" }), "committed");
  await cli(workspace, stateDir, "sync");
  const waiting = (await cli(workspace, stateDir, "status")).conversations.demo;
  assert.deepEqual([waiting.state, waiting.due_at, waiting.consecutive_reminders, waiting.last_ack_message_id],
    ["awaiting-owner", "2026-09-24T17:00:00Z", 2, "ack-1"]);

  // The root observer naming the channel acts exactly like an event without a conversation.
  assert.equal(await ingest(workspace, stateDir, "channel-owner", {
    provider: "ccdm-root", adapter_instance_id: "root-observer", conversation_id: "channel",
    source_message_id: "channel-message" }), "committed");
  await cli(workspace, stateDir, "sync");
  const paused = (await cli(workspace, stateDir, "status")).conversations.demo;
  assert.deepEqual([paused.state, paused.due_at, paused.consecutive_reminders, paused.last_ack_message_id],
    ["open-paused", null, 0, "channel-message"]);
});

test("after a Claude thread turn ends, root reminds in that thread after the hour and never in the channel", async () => {
  const context = threadReminderWorkspace();
  const { workspace } = context;
  const stop = await threadReminders(context);
  await answeredThread(context, THREAD_A, "thread-question-1");

  // Inside the hour nothing is sent.
  context.setClock(59);
  await settle();
  assert.deepEqual(eyes(workspace, THREAD_A), []);

  context.setClock(61);
  await waitFor(() => eyes(workspace, THREAD_A).length === 1, () => "the thread's reminder", 20000);
  const [reminder] = eyes(workspace, THREAD_A);
  assert.deepEqual([reminder.authorization, reminder.requestBody.enforce_nonce], [ROOT_AUTH, true]);
  assert.deepEqual(eyes(workspace, "demo-channel"), []);

  // An ignored reminder backs off: the next one comes two hours after it.
  context.setClock(61 + 119);
  await settle();
  assert.equal(eyes(workspace, THREAD_A).length, 1);
  context.setClock(61 + 121);
  await waitFor(() => eyes(workspace, THREAD_A).length === 2, () => "the second reminder", 20000);
  assert.deepEqual(eyes(workspace, "demo-channel"), []);
  await stop();
});

test("a supervisor notice in a thread is not an agent reply, so it never arms a reminder", async () => {
  const context = threadReminderWorkspace();
  const { workspace } = context;
  const stop = await threadReminders(context);
  await answeredThread(context, THREAD_A, "thread-question-1");

  // The owner's /config acknowledges; the supervisor answers it as the root bot.
  injectDiscordMessage(workspace, { id: "thread-config-1", channelId: THREAD_A, author: owner, content: "/config" });
  await waitFor(() => posts(workspace, THREAD_A).some(message => !message.webhookId && message.content !== "👀"),
    () => "the supervisor's settings notice", 15000);
  const notice = posts(workspace, THREAD_A).find(message => !message.webhookId);
  assert.equal(notice.authorization, ROOT_AUTH);
  await settle();

  context.setClock(24 * 60);
  await settle();
  await settle();
  assert.deepEqual(eyes(workspace, THREAD_A), []);
  await stop();
});

test("an owner reply in one thread acknowledges only that thread, and a guest reply acknowledges nothing", async () => {
  const context = threadReminderWorkspace();
  const { workspace } = context;
  const stop = await threadReminders(context);
  await answeredThread(context, THREAD_A, "thread-a-question");
  await answeredThread(context, THREAD_B, "thread-b-question");
  injectDiscordMessage(workspace, { id: "channel-question", channelId: "demo-channel", author: owner,
    content: "and in the channel?" });
  await waitFor(() => agentReplies(workspace, "demo-channel").length === 1, () => "the channel reply", 20000);
  await settle();

  // From here Claude keeps working without answering.
  updateState(workspace.stateDir, state => {
    delete state.fixtures.claude.toolScript;
  });
  injectDiscordMessage(workspace, { id: "thread-a-ack", channelId: THREAD_A, author: owner, content: "thanks" });
  injectDiscordMessage(workspace, { id: "thread-b-guest", channelId: THREAD_B, author: guest, content: "me too" });
  await settle();

  // Thread reminders are spaced by the 5 s gate.
  context.setClock(61);
  await waitFor(() => eyes(workspace, "demo-channel").length === 1 &&
    eyes(workspace, THREAD_B).length + eyes(workspace, THREAD_A).length === 1, () => "the first reminders", 20000);
  context.setClock(62);
  await settle();
  assert.equal(eyes(workspace, THREAD_B).length, 1);
  assert.deepEqual(eyes(workspace, THREAD_A), []);
  assert.equal(eyes(workspace, "demo-channel").length, 1);
  await stop();
});

test("a reminder posted into an auto-archived thread reopens it without starting a session", async () => {
  const context = threadReminderWorkspace();
  const { workspace } = context;
  const stop = await threadReminders(context, { supervisorEnv: FAST_POLL });
  await answeredThread(context, THREAD_A, "thread-question-1");
  const launched = readState(workspace.stateDir).fixtures.claude.channelServers.length;

  // Discord's inactivity auto-archive: no audit entry names an actor.
  const thread = { id: THREAD_A, type: 11, parentId: "demo-channel", name: "Side task 111111", ownerId: OWNER_ID,
    autoArchiveDuration: 10080 };
  updateState(workspace.stateDir, state => {
    (state.fixtures.discord.injectedThreads ||= []).push({ ...thread, archived: true, event: "update",
      previous: { ...thread, archived: false } });
  });
  await supervisedThread(workspace, THREAD_A, row => row.state === "stopped" && row.stop_reason === "auto-archive");

  context.setClock(61);
  await waitFor(() => eyes(workspace, THREAD_A).length === 1, () => "the reminder in the archived thread", 20000);
  await waitFor(() => readState(workspace.stateDir).fixtures.discord.threads[THREAD_A].archived === false,
    () => "the thread to reopen", 10000);
  await settle();
  const row = await supervisedThread(workspace, THREAD_A);
  assert.deepEqual([row.state, row.stop_reason], ["stopped", "auto-archive"]);
  assert.equal(readState(workspace.stateDir).fixtures.claude.channelServers.length, launched);
  assert.equal(readState(workspace.stateDir).fixtures.tmux.sessions[`demo_claude-t-${THREAD_A}`], undefined);
  await stop();
});

test("after a Codex thread turn ends, root reminds in that thread after the hour and never in the channel", async () => {
  const context = threadReminderWorkspace("codex");
  const { workspace } = context;
  const codex = await startFakeCodexServer(workspace, { port: 29510, deferListen: true,
    codexHome: path.join(workspace.homeDir, ".codex"), channelId: THREAD_A,
    threadId: "0199a5c4-7e1b-7c3d-9f2a-4b8e6d1c3a58", bootstrapPlan: { status: "completed", mcpReplyText: "on it" } });
  const stop = await threadReminders(context, { channelSession: false,
    supervisorEnv: { CCDM_THREAD_WS_PORT_BASE: "29510" } });
  createThread(workspace, THREAD_A);
  await supervisedThread(workspace, THREAD_A);
  injectDiscordMessage(workspace, { id: "thread-question-1", channelId: THREAD_A, author: owner,
    content: "please fix the parser" });
  await supervisedThread(workspace, THREAD_A, row => row.ws_port === 29510);
  await codex.listen();
  await waitFor(() => agentReplies(workspace, THREAD_A).length === 1, () => "the Codex thread's reply", 20000);
  await settle();

  context.setClock(59);
  await settle();
  assert.deepEqual(eyes(workspace, THREAD_A), []);
  context.setClock(61);
  await waitFor(() => eyes(workspace, THREAD_A).length === 1, () => "the Codex thread's reminder", 20000);
  assert.equal(eyes(workspace, THREAD_A)[0].authorization, ROOT_AUTH);
  assert.deepEqual(eyes(workspace, "demo-channel"), []);
  await stop();
});
