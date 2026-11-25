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
  THREAD_A, THREAD_B, THREAD_BLOCKERS, THREAD_C, THREAD_D, WIN, agentReplies, answeredHistory,
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

test("a thread /close closes only that thread's reminders; an owner archive is reverted and keeps them", async () => {
  const context = threadReminderWorkspace();
  const { workspace } = context;
  const stop = await threadReminders(context);
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

  // The owner archives B by hand; the audit log names the owner. Only /close and
  // threads.sh close archive a thread, so the supervisor reverts it and B stays open.
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
  await supervisedThread(workspace, THREAD_B, row => row.state === "stopped" && row.stop_reason === "auto-archive");
  await waitFor(() => readState(workspace.stateDir).fixtures.discord.threads[THREAD_B].archived === false,
    () => "thread B's unarchive", 20000);
  demo = (await reminderService(context, "status")).conversations.demo;
  assert.deepEqual([demo.state, demo.due_at !== null, demo.threads[THREAD_B].state],
    ["awaiting-owner", true, "awaiting-owner"]);

  // Past the hour the channel and B are reminded; the closed A is not.
  context.setClock(61);
  await waitFor(() => eyes(workspace, "demo-channel").length === 1, () => "the channel's reminder", 20000);
  await waitFor(() => eyes(workspace, THREAD_B).length === 1, () => "thread B's reminder", 20000);
  await settle();
  assert.deepEqual(eyes(workspace, THREAD_A), []);
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
  const stop = await threadReminders(context, { beforeEnable: async () => {
    // D was bound, then the owner closed it with /close yesterday: its conversation is closed.
    createThread(workspace, THREAD_D);
    await supervisedThread(workspace, THREAD_D);
    injectDiscordMessage(workspace, { id: "thread-d-close", channelId: THREAD_D, author: owner, content: "/close" });
    await supervisedThread(workspace, THREAD_D, row => row.state === "closed");
    await waitFor(() => readState(workspace.stateDir).fixtures.discord.threads[THREAD_D].archived === true,
      () => "thread D's archive", 20000);
    updateState(workspace.stateDir, state => {
      state.fixtures.discord.threads[THREAD_D].archiveTimestamp = new Date(Date.now() - day).toISOString();
    });
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

test("Agent Messages in Claude Thread Conversations never arm, acknowledge, or reopen reminders, keep armed reminders recurring, and restore arming when owner input joins", async () => {
  const context = threadReminderWorkspace("claude", { agent_message_targets: ["demo"] });
  const { workspace } = context;
  const stop = await threadReminders(context, {
    routerOptions: { env: { CCDM_ROUTER_AGENT_MESSAGE_MINUTE_MS: "500" } },
  });

  // Boot THREAD_B with an owner message and leave it open-paused (no reply),
  // so THREAD_B holds a valid older owner interaction it could name during an agent-started turn.
  updateState(workspace.stateDir, state => {
    delete state.fixtures.claude.toolScript;
    state.fixtures.claude.toolScriptsByConversation = {
      [THREAD_B]: [
        {
          whenAgentKind: "request",
          name: "reply",
          arguments: {
            chat_id: "{{chat_id}}",
            text: "Thread B posting during request turn",
            conversation_interaction_id: "thread-b-owner-1",
            conversation_disposition: "input-needed",
          },
        },
        {
          whenAgentKind: "request",
          name: "send_agent_reply",
          arguments: { request_id: "{{request_id}}", text: "Thread B answer" },
        },
      ],
      [THREAD_A]: [
        {
          whenSender: "owner",
          name: "reply",
          arguments: {
            chat_id: "{{chat_id}}",
            text: "Thread A answered owner",
            conversation_interaction_id: "{{message_id}}",
            conversation_disposition: "progress",
          },
        },
        {
          whenSender: "owner",
          name: "send_agent_request",
          arguments: { target: `demo/${THREAD_B}`, text: "Check thread B" },
        },
        {
          whenAgentKind: "reply",
          name: "reply",
          arguments: {
            chat_id: "{{chat_id}}",
            text: "Thread A reporting thread B reply",
            conversation_interaction_id: "thread-a-owner-1",
            conversation_disposition: "progress",
          },
        },
      ],
    };
  });

  createThread(workspace, THREAD_B);
  await supervisedThread(workspace, THREAD_B);
  injectDiscordMessage(workspace, { id: "thread-b-owner-1", channelId: THREAD_B, author: owner, content: "stand by in thread B" });
  await supervisedThread(workspace, THREAD_B, row => row.state === "live");
  await waitFor(() => (readState(workspace.stateDir).fixtures.claude.channelNotifications ?? [])
    .some(n => n.meta.chat_id === THREAD_B && n.meta.message_id === "thread-b-owner-1"), () => "thread B bootstrap", 20000);
  await waitFor(() => (readState(workspace.stateDir).fixtures.claude.hookRuns ?? [])
    .filter(run => run.event === "Stop").length >= 1, () => "thread B initial Stop", 15000);
  const threadBBefore = await threadStatusMatching(context, THREAD_B, row => row?.last_ack_message_id === "thread-b-owner-1");
  assert.equal(threadBBefore.state, "open-paused");
  assert.equal(threadBBefore.response_message_id, null);

  // Boot THREAD_A: answers its owner message (arming its reminder) and sends an Agent Request to THREAD_B.
  // Note: bootstrapNotification carries no meta.sender, so trigger the exchange on the second owner message once live.
  createThread(workspace, THREAD_A);
  await supervisedThread(workspace, THREAD_A);
  injectDiscordMessage(workspace, { id: "thread-a-boot", channelId: THREAD_A, author: owner, content: "open thread A" });
  await supervisedThread(workspace, THREAD_A, row => row.state === "live");
  await waitFor(() => (readState(workspace.stateDir).fixtures.claude.hookRuns ?? [])
    .filter(run => run.event === "Stop").length >= 2, () => "thread A boot Stop", 15000);

  injectDiscordMessage(workspace, { id: "thread-a-owner-1", channelId: THREAD_A, author: owner, content: "check thread B" });
  await waitFor(() =>
    (readState(workspace.stateDir).fixtures.discord.messages ?? []).some(m => m.channelId === THREAD_B && m.content === "Thread B posting during request turn")
    && (readState(workspace.stateDir).fixtures.discord.messages ?? []).some(m => m.channelId === THREAD_A && m.content === "Thread A reporting thread B reply"),
  () => "full thread-to-thread exchange", 25000);
  await waitFor(() => (readState(workspace.stateDir).fixtures.claude.hookRuns ?? [])
    .filter(run => run.event === "Stop").length >= 5, () => "all exchange Stop hooks", 15000);

  const threadAOwnerReply = (readState(workspace.stateDir).fixtures.discord.messages ?? []).find(
    m => m.channelId === THREAD_A && m.content === "Thread A answered owner",
  );
  assert.ok(threadAOwnerReply);
  const threadAAfter = await threadStatusMatching(context, THREAD_A, row => row?.state === "awaiting-owner");
  assert.equal(threadAAfter.response_message_id, threadAOwnerReply.id);
  const threadBAfter = await threadStatus(context, THREAD_B);
  assert.deepEqual(
    [threadBAfter.state, threadBAfter.revision, threadBAfter.response_message_id, threadBAfter.due_at],
    ["open-paused", threadBBefore.revision, null, null],
  );

  // THREAD_A's already-armed reminder fires at +61m and recurs at +182m; THREAD_B gets none.
  context.setClock(61);
  await waitFor(() => eyes(workspace, THREAD_A).length === 1, () => "thread A first reminder", 20000);
  assert.deepEqual(eyes(workspace, THREAD_B), []);
  context.setClock(61 + 121);
  await waitFor(() => eyes(workspace, THREAD_A).length === 2, () => "thread A recurring reminder", 20000);
  assert.deepEqual(eyes(workspace, THREAD_B), []);

  // Notice-started turn (expired request) in THREAD_B: reply during notice turn arms nothing.
  const stopsBeforeNotice = (readState(workspace.stateDir).fixtures.claude.hookRuns ?? [])
    .filter(run => run.event === "Stop").length;
  updateState(workspace.stateDir, state => {
    state.fixtures.claude.toolScriptsByConversation = {
      [THREAD_A]: [],
      [THREAD_B]: [
        {
          whenSender: "owner",
          name: "send_agent_request",
          arguments: { target: `demo/${THREAD_A}`, text: "Will expire in thread", timeout_minutes: 1 },
        },
        {
          whenAgentKind: "notice",
          name: "reply",
          arguments: {
            chat_id: "{{chat_id}}",
            text: "Thread B posting during expiry notice",
            conversation_interaction_id: "thread-b-owner-2",
            conversation_disposition: "progress",
          },
        },
      ],
    };
  });
  injectDiscordMessage(workspace, { id: "thread-b-owner-2", channelId: THREAD_B, author: owner, content: "ping thread A" });
  await waitFor(() => (readState(workspace.stateDir).fixtures.discord.messages ?? [])
    .some(m => m.channelId === THREAD_B && m.content === "Thread B posting during expiry notice"),
  () => "thread B notice reply", 20000);
  await waitFor(() => (readState(workspace.stateDir).fixtures.claude.hookRuns ?? [])
    .filter(run => run.event === "Stop").length >= stopsBeforeNotice + 3, () => "notice Stop hooks", 15000);
  const threadBAfterNotice = await threadStatusMatching(context, THREAD_B, row => row?.last_ack_message_id === "thread-b-owner-2");
  assert.deepEqual([threadBAfterNotice.state, threadBAfterNotice.response_message_id, threadBAfterNotice.due_at],
    ["open-paused", null, null]);

  // Owner message joining an agent-started turn in THREAD_B restores reminder arming.
  updateState(workspace.stateDir, state => {
    state.fixtures.claude.holdTurnsIn = [THREAD_B];
    state.fixtures.claude.toolScriptsByConversation = {
      "demo-channel": [
        {
          whenSender: "owner",
          name: "send_agent_request",
          arguments: { target: `demo/${THREAD_B}`, text: "Hold in thread B" },
        },
      ],
      [THREAD_B]: [
        {
          whenAgentKind: "request",
          name: "reply",
          arguments: {
            chat_id: "{{chat_id}}",
            text: "Thread B pre-join reply",
            conversation_interaction_id: "thread-b-owner-2",
            conversation_disposition: "progress",
          },
        },
      ],
    };
    state.fixtures.claude.midTurnToolScriptsByConversation = {
      [THREAD_B]: [
        {
          whenSender: "owner",
          name: "reply",
          arguments: {
            chat_id: "{{chat_id}}",
            text: "Thread B post-join reply",
            conversation_interaction_id: "{{message_id}}",
            conversation_disposition: "progress",
          },
        },
      ],
    };
  });
  injectDiscordMessage(workspace, { id: "demo-ch-trigger-b", channelId: "demo-channel", author: owner, content: "ask thread B" });
  await waitFor(() => (readState(workspace.stateDir).fixtures.discord.messages ?? [])
    .some(m => m.channelId === THREAD_B && m.content === "Thread B pre-join reply"),
  () => "thread B pre-join reply", 20000);
  injectDiscordMessage(workspace, { id: "thread-b-owner-join", channelId: THREAD_B, author: owner, content: "owner joins thread B" });
  await waitFor(() => (readState(workspace.stateDir).fixtures.discord.messages ?? [])
    .some(m => m.channelId === THREAD_B && m.content === "Thread B post-join reply"),
  () => "thread B post-join reply", 15000);
  updateState(workspace.stateDir, state => {
    state.fixtures.claude.holdTurnsIn = [];
  });
  const threadBPostJoinReply = (readState(workspace.stateDir).fixtures.discord.messages ?? []).find(
    m => m.channelId === THREAD_B && m.content === "Thread B post-join reply",
  );
  assert.ok(threadBPostJoinReply);
  const threadBArmed = await threadStatusMatching(context, THREAD_B, row => row?.state === "awaiting-owner");
  assert.deepEqual([threadBArmed.current_interaction_id, threadBArmed.response_message_id],
    ["thread-b-owner-join", threadBPostJoinReply.id]);

  // Closed Thread Conversation stays closed when targeted by an Agent Request (target_closed).
  injectDiscordMessage(workspace, { id: "thread-a-close-am", channelId: THREAD_A, author: owner, content: "/close" });
  const closedA = await threadStatusMatching(context, THREAD_A, row => row?.state === "closed");
  await waitFor(() => readState(workspace.stateDir).fixtures.discord.threads[THREAD_A]?.archived === true,
    () => "thread A archived", 20000);
  updateState(workspace.stateDir, state => {
    state.fixtures.claude.toolScriptsByConversation = {
      "demo-channel": [
        {
          whenSender: "owner",
          name: "send_agent_request",
          arguments: { target: `demo/${THREAD_A}`, text: "Ping closed thread A" },
        },
      ],
    };
  });
  injectDiscordMessage(workspace, { id: "demo-ch-trigger-closed", channelId: "demo-channel", author: owner, content: "ping closed thread" });
  await waitFor(() => (readState(workspace.stateDir).fixtures.claude.toolResults ?? [])
    .some(r => r.name === "send_agent_request" && r.result?.content?.[0]?.text?.includes("target_closed")),
  () => "target_closed refusal", 20000);
  const closedAAfter = await threadStatus(context, THREAD_A);
  assert.deepEqual([closedAAfter.state, closedAAfter.revision], ["closed", closedA.revision]);
  assert.equal(readState(workspace.stateDir).fixtures.discord.threads[THREAD_A].archived, true);

  await stop();
});
