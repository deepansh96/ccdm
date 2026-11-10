import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { injectDiscordMessage, injectDiscordReaction, startFakeCodexServer } from "./support/bridge.js";
import { OWNER_ID, routerWithWebhooks, waitFor } from "./support/router.js";
import { readState, updateState } from "./support/state.js";
import { cleanup } from "./support/teardown.js";
import { startThreadSupervisor, supervisorEnv } from "./support/thread-supervisor.js";
import {
  FAST_POLL, THREAD_A, THREAD_B, THREAD_BLOCKERS, THREAD_C, THREAD_D, WIN, agentReplies, answeredHistory,
  answeredThread, createThread, eyes, notices, owner, reminderService, settle, snowflakeNow, supervisedThread,
  threadReminderWorkspace, threadReminders, threadStatus, threadStatusMatching,
} from "./support/reminder-threads.js";

test.afterEach(async () => cleanup());

test("status nests each Thread Conversation under its project, beside the channel's own state", async () => {
  const context = threadReminderWorkspace();
  const stop = await threadReminders(context);
  await answeredThread(context, THREAD_A, "thread-question-1");

  const demo = (await reminderService(context, "status")).conversations.demo;
  assert.deepEqual(Object.keys(demo.threads), [THREAD_A]);
  const thread = demo.threads[THREAD_A];
  assert.deepEqual([thread.state, thread.current_interaction_id, thread.consecutive_reminders,
    thread.reconciliation_status], ["awaiting-owner", "thread-question-1", 0, "ready"]);
  assert.equal(thread.response_message_id, agentReplies(context.workspace, THREAD_A)[0].id);
  // The channel's own conversation is untouched by the thread's turn.
  assert.deepEqual([demo.channel_id, demo.state, demo.current_interaction_id], ["demo-channel", "open-paused", null]);
  await stop();
});

test("an accepted /config provider= resets the thread's reminder tracking, and /clear does not", async () => {
  const context = threadReminderWorkspace();
  const { workspace } = context;
  const codex = await startFakeCodexServer(workspace, { port: 29520, deferListen: true,
    codexHome: path.join(workspace.homeDir, ".codex"), channelId: THREAD_A,
    threadId: "0199a5c4-7e1b-7c3d-9f2a-4b8e6d1c3a59", bootstrapPlan: { status: "completed" } });
  const stop = await threadReminders(context, { supervisorEnv: { CCDM_THREAD_WS_PORT_BASE: "29520" } });
  await answeredThread(context, THREAD_A, "thread-question-1");
  const answered = await threadStatus(context, THREAD_A);
  assert.deepEqual([answered.state, answered.current_interaction_id], ["awaiting-owner", "thread-question-1"]);

  // /clear acknowledges like any command, but the tracked turn stays.
  injectDiscordMessage(workspace, { id: "thread-clear", channelId: THREAD_A, author: owner, content: "/clear" });
  await waitFor(() => notices(workspace, THREAD_A).some(message =>
    message.content === "Starting a fresh conversation in this thread."), () => "the /clear notice", 15000);
  const cleared = await threadStatusMatching(context, THREAD_A, row => row.state === "open-paused");
  assert.deepEqual([cleared.current_interaction_id, cleared.response_message_id],
    ["thread-question-1", answered.response_message_id]);

  // A provider switch takes effect only on the owner's ✅, and then resets the thread.
  injectDiscordMessage(workspace, { id: "thread-switch", channelId: THREAD_A, author: owner,
    content: "/config provider=codex" });
  await waitFor(() => notices(workspace, THREAD_A).some(message => message.content.startsWith("Changing provider")),
    () => "the switch warning", 15000);
  const warning = notices(workspace, THREAD_A).find(message => message.content.startsWith("Changing provider"));
  await settle();
  assert.equal((await threadStatus(context, THREAD_A)).current_interaction_id, "thread-question-1");
  injectDiscordReaction(workspace, { id: "owner-check", channelId: THREAD_A, emoji: "✅", messageId: warning.id,
    user: owner, message: { author: { id: "fixture-bot-user-id", bot: true }, content: warning.content } });
  const reset = await threadStatusMatching(context, THREAD_A, row => row.current_interaction_id === null);
  assert.deepEqual([reset.state, reset.response_message_id, reset.response_at, reset.due_at,
    reset.consecutive_reminders], ["open-paused", null, null, null, 0]);
  await codex.listen();
  await stop();
});

test("a thread /close and an owner archive each close only that thread's reminders", async () => {
  const context = threadReminderWorkspace();
  const { workspace } = context;
  const stop = await threadReminders(context, { supervisorEnv: FAST_POLL });
  await answeredThread(context, THREAD_A, "thread-a-question");
  await answeredThread(context, THREAD_B, "thread-b-question");
  injectDiscordMessage(workspace, { id: "channel-question", channelId: "demo-channel", author: owner,
    content: "and in the channel?" });
  await waitFor(() => agentReplies(workspace, "demo-channel").length === 1, () => "the channel reply", 20000);
  await settle();

  injectDiscordMessage(workspace, { id: "thread-a-close", channelId: THREAD_A, author: owner, content: "/close" });
  await threadStatusMatching(context, THREAD_A, row => row.state === "closed");
  let demo = (await reminderService(context, "status")).conversations.demo;
  assert.deepEqual([demo.state, demo.threads[THREAD_B].state], ["awaiting-owner", "awaiting-owner"]);

  // The owner archives B by hand; the audit log names the owner.
  updateState(workspace.stateDir, state => {
    (state.fixtures.discord.auditLogEntries ||= []).unshift({ id: snowflakeNow(), user_id: OWNER_ID,
      target_id: THREAD_B, action_type: 111, changes: [{ key: "archived", old_value: false, new_value: true }] });
  });
  const threadB = { id: THREAD_B, type: 11, parentId: "demo-channel", name: "Side task 222222", ownerId: OWNER_ID,
    autoArchiveDuration: 10080 };
  updateState(workspace.stateDir, state => {
    (state.fixtures.discord.injectedThreads ||= []).push({ ...threadB, archived: true, event: "update",
      previous: { ...threadB, archived: false } });
  });
  await supervisedThread(workspace, THREAD_B, row => row.state === "closed" && row.close_reason === "owner-archive");
  await threadStatusMatching(context, THREAD_B, row => row.state === "closed");
  demo = (await reminderService(context, "status")).conversations.demo;
  assert.deepEqual([demo.state, demo.due_at !== null], ["awaiting-owner", true]);

  // Past the hour only the channel is reminded.
  context.setClock(61);
  await waitFor(() => eyes(workspace, "demo-channel").length === 1, () => "the channel's reminder", 20000);
  await settle();
  assert.deepEqual([eyes(workspace, THREAD_A), eyes(workspace, THREAD_B)], [[], []]);
  await stop();
});

test("a thread delete drops its reminder state and leaves its siblings and the channel alone", async () => {
  const context = threadReminderWorkspace();
  const { workspace } = context;
  const stop = await threadReminders(context);
  await answeredThread(context, THREAD_A, "thread-a-question");
  await answeredThread(context, THREAD_B, "thread-b-question");

  updateState(workspace.stateDir, state => {
    (state.fixtures.discord.injectedThreads ||= []).push({ id: THREAD_A, type: 11, parentId: "demo-channel",
      name: "Side task 111111", ownerId: OWNER_ID, event: "delete" });
  });
  const deadline = Date.now() + 20000;
  let demo;
  while (THREAD_A in (demo = (await reminderService(context, "status")).conversations.demo).threads) {
    if (Date.now() > deadline) throw new Error(`thread A's reminders were never dropped: ${JSON.stringify(demo)}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.deepEqual(Object.keys(demo.threads), [THREAD_B]);
  assert.equal(demo.threads[THREAD_B].state, "awaiting-owner");

  // Past the hour only the surviving thread is reminded.
  context.setClock(61);
  await waitFor(() => eyes(workspace, THREAD_B).length === 1, () => "thread B's reminder", 20000);
  await settle();
  assert.deepEqual(eyes(workspace, THREAD_A), []);
  await stop();
});

test("readiness reports root's missing thread permissions only while threads are enabled", async () => {
  const context = threadReminderWorkspace();
  const { workspace } = context;
  updateState(workspace.stateDir, state => {
    state.fixtures.discord.permissionDenials = { "fixture-bot-user-id":
      ["CreatePublicThreads", "ManageThreads", "ViewAuditLog"] };
  });
  await routerWithWebhooks(workspace, ["demo"]);
  await reminderService(context, "sync");
  const routerBlockers = async () => (await reminderService(context, "status")).readiness.projects.demo.router.blockers;
  const registryFile = path.join(workspace.repoDir, "registry.json");
  const editRegistry = edit => {
    const registry = JSON.parse(fs.readFileSync(registryFile, "utf8"));
    edit(registry);
    fs.writeFileSync(registryFile, `${JSON.stringify(registry, null, 2)}\n`);
  };

  // Threads are not enabled: no installed supervisor, no caps, no supervisor.
  assert.deepEqual(await routerBlockers(), []);

  // `thread_session_caps` in the registry enables them.
  editRegistry(registry => { registry.thread_session_caps = { claude: 6, codex: 8 }; });
  assert.deepEqual(await routerBlockers(), THREAD_BLOCKERS);
  editRegistry(registry => { delete registry.thread_session_caps; });
  assert.deepEqual(await routerBlockers(), []);

  // So does the installed supervisor: its LaunchAgent plist, or on Windows its
  // scheduled task under either name, as the fixture schtasks reports it.
  const plist = path.join(workspace.homeDir, "Library", "LaunchAgents", "com.ccdm.thread-supervisor.plist");
  fs.mkdirSync(path.dirname(plist), { recursive: true });
  fs.writeFileSync(plist, "<plist/>\n");
  if (WIN) {
    // A plist means nothing on Windows, and the service asked for both task names.
    assert.deepEqual(await routerBlockers(), []);
    const asked = new Set(readState(workspace.stateDir).fixtures.schtasks.invocations.map(entry => entry.name));
    assert.deepEqual([...asked].sort(), ["CCDM-ThreadSupervisor", String.raw`\CCDM\ThreadSupervisor`]);
    for (const task of [String.raw`\CCDM\ThreadSupervisor`, "CCDM-ThreadSupervisor"]) {
      updateState(workspace.stateDir, state => { state.fixtures.schtasks.tasks = [task]; });
      assert.deepEqual(await routerBlockers(), THREAD_BLOCKERS, task);
    }
    updateState(workspace.stateDir, state => { state.fixtures.schtasks.tasks = []; });
  } else {
    assert.deepEqual(await routerBlockers(), THREAD_BLOCKERS);
  }
  fs.rmSync(plist);
  assert.deepEqual(await routerBlockers(), []);

  // And so does a connected supervisor.
  const supervisor = await startThreadSupervisor(workspace);
  assert.deepEqual(await routerBlockers(), THREAD_BLOCKERS);
  await supervisor.stop();

  // Granted, nothing is reported.
  updateState(workspace.stateDir, state => { delete state.fixtures.discord.permissionDenials; });
  editRegistry(registry => { registry.thread_session_caps = { claude: 6, codex: 8 }; });
  assert.deepEqual(await routerBlockers(), []);
});

test("enable discovery adopts active and recently archived open threads, and skips closed and older ones", async () => {
  const context = threadReminderWorkspace();
  const { workspace } = context;
  const day = 24 * 3600000;
  const stop = await threadReminders(context, { supervisorEnv: FAST_POLL, beforeEnable: async () => {
    // D was bound, then the owner archived it yesterday: its conversation is closed.
    createThread(workspace, THREAD_D);
    await supervisedThread(workspace, THREAD_D);
    updateState(workspace.stateDir, state => {
      (state.fixtures.discord.auditLogEntries ||= []).unshift({ id: snowflakeNow(), user_id: OWNER_ID,
        target_id: THREAD_D, action_type: 111, changes: [{ key: "archived", old_value: false, new_value: true }] });
    });
    const threadD = { id: THREAD_D, type: 11, parentId: "demo-channel", name: "Side task 444444",
      ownerId: OWNER_ID, autoArchiveDuration: 10080 };
    updateState(workspace.stateDir, state => {
      state.fixtures.discord.injectedThreads.push({ ...threadD, archived: true,
        archiveTimestamp: new Date(Date.now() - day).toISOString(), event: "update",
        previous: { ...threadD, archived: false } });
    });
    await supervisedThread(workspace, THREAD_D, row => row.state === "closed");
    // A is active, B was archived a day ago and C eight days ago.
    const thread = (id, fields) => ({ id, type: 11, parentId: "demo-channel", name: `Side task ${id.slice(-6)}`,
      ownerId: OWNER_ID, autoArchiveDuration: 10080, ...fields });
    updateState(workspace.stateDir, state => {
      Object.assign(state.fixtures.discord.threads, {
        [THREAD_A]: thread(THREAD_A, { archived: false }),
        [THREAD_B]: thread(THREAD_B, { archived: true, archiveTimestamp: new Date(Date.now() - day).toISOString() }),
        [THREAD_C]: thread(THREAD_C, { archived: true,
          archiveTimestamp: new Date(Date.now() - 8 * day).toISOString() }),
      });
      for (const id of [THREAD_A, THREAD_B, THREAD_C, THREAD_D]) state.fixtures.discord.history[id] = answeredHistory(id);
    });
  } });

  const demo = (await reminderService(context, "status")).conversations.demo;
  assert.deepEqual(Object.keys(demo.threads), [THREAD_A, THREAD_B]);
  for (const id of [THREAD_A, THREAD_B]) {
    const row = demo.threads[id];
    assert.deepEqual([row.state, row.current_interaction_id, row.response_message_id, row.reconciliation_status,
      row.discovery.phase], ["awaiting-owner", `${id}-question`, `${id}-answer`, "ready", "complete"]);
  }
  const read = new Set((readState(workspace.stateDir).fixtures.discord.historyFetches ?? [])
    .map(fetch => fetch.channelId));
  assert.deepEqual([read.has(THREAD_A), read.has(THREAD_B), read.has(THREAD_C), read.has(THREAD_D)],
    [true, true, false, false]);
  await stop();
});
