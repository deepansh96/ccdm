import assert from "node:assert/strict";
import test from "node:test";

import { injectDiscordMessage } from "./support/bridge.js";
import {
  OWNER_ID,
  ROOT_TOKEN,
  createRouterWorkspace,
  rawRouterSocket,
  routerRegistry,
  routerWithWebhooks,
  seedThreads,
  waitFor,
  writeThreadKey,
} from "./support/router.js";
import { readState, updateState } from "./support/state.js";
import { cleanup } from "./support/teardown.js";
import {
  startThreadSupervisor,
  supervisorStatus,
} from "./support/thread-supervisor.js";

test.afterEach(cleanup);

async function rawClient(workspace, hello) {
  const socket = await rawRouterSocket(workspace);
  socket.send({ type: "hello", v: 1, ...hello });
  const answer = await waitFor(
    () => socket.frames.find((frame) => frame.type === "hello_ok" || frame.type === "hello_error"),
    () => `${hello.role} hello: ${JSON.stringify(socket.frames)}`,
  );
  let requests = 0;
  return {
    ...socket,
    hello: answer,
    get events() { return socket.frames.filter((frame) => frame.type === "event"); },
    async request(op, args = {}, timeoutMs = 5000) {
      const id = `request-${++requests}`;
      socket.send({ type: "request", id, op, args });
      return waitFor(
        () => socket.frames.find((frame) => frame.type === "response" && frame.id === id),
        () => `${op} response: ${JSON.stringify(socket.frames)}`,
        timeoutMs,
      );
    },
  };
}

function connectAgentProject(workspace, project, key = `${project}-key`, extra = {}) {
  return rawClient(workspace, {
    role: "project",
    project,
    key,
    capabilities: ["agent_messages"],
    ...extra,
  });
}

async function connectAgentThread(workspace, { project = "demo", threadId, provider = "claude", key, capabilities = ["agent_messages"], listener } = {}) {
  if (key === undefined) {
    key = `${threadId}-key`;
    writeThreadKey(workspace, threadId, key);
  }
  return rawClient(workspace, {
    role: "thread",
    project,
    thread_id: threadId,
    provider,
    key,
    ...(capabilities ? { capabilities } : {}),
    ...(listener === undefined ? {} : { listener }),
  });
}

async function fenceOwnerMessage(workspace, client, channelId, id) {
  injectDiscordMessage(workspace, {
    id,
    channelId,
    content: `fence ${id}`,
    author: { id: OWNER_ID, username: "Owner" },
  });
  await waitFor(
    () => client.events.some((event) => event.event === "message" && event.message_id === id),
    () => `fence ${id}: ${JSON.stringify(client.events)}`,
  );
}

test("a thread session sends a request to another project's channel, posts under the thread's provider with thread label, and gets the reply only in that thread", async () => {
  const workspace = createRouterWorkspace(routerRegistry({
    demo: { channel_id: "demo-channel", type: "claude", transport: "router", agent_message_targets: ["beta"] },
    beta: { channel_id: "beta-channel", type: "codex", transport: "router" },
  }));
  await routerWithWebhooks(workspace, ["demo", "beta"]);
  seedThreads(workspace, {
    "demo-thread": { type: 11, parentId: "demo-channel", name: "Deploy Check" },
    "demo-sibling": { type: 11, parentId: "demo-channel", name: "Other Task" },
  });
  updateState(workspace.stateDir, (state) => {
    state.fixtures.discord.requestLog = [];
  });

  const demoChannel = await connectAgentProject(workspace, "demo");
  const demoThread = await connectAgentThread(workspace, { project: "demo", threadId: "demo-thread", provider: "codex" });
  const demoSibling = await connectAgentThread(workspace, { project: "demo", threadId: "demo-sibling", provider: "claude" });
  const beta = await connectAgentProject(workspace, "beta");
  assert.equal(demoThread.hello.type, "hello_ok");
  assert.equal(demoSibling.hello.type, "hello_ok");

  const sent = await demoThread.request("agent_request", {
    target: "beta",
    text: "Check staging from thread",
    idempotency_key: "thread-send-1",
    context_pct: 37,
  });
  assert.equal(sent.ok, true, JSON.stringify(sent));
  const reqId = sent.result.request_id;
  assert.match(reqId, /^req-[0-9a-f]{12}$/);

  const reqEvent = await waitFor(
    () => beta.events.find((event) => event.event === "agent_message" && event.kind === "request"),
    () => `beta request event: ${JSON.stringify(beta.events)}`,
  );
  assert.equal(reqEvent.request_id, reqId);
  assert.equal(reqEvent.text, "Check staging from thread");
  assert.deepEqual(reqEvent.from, {
    project: "demo",
    provider: "codex",
    conversation_id: "demo-thread",
    thread_id: "demo-thread",
    thread_name: "Deploy Check",
  });

  const afterRequest = readState(workspace.stateDir).fixtures.discord;
  const senderReqPost = afterRequest.messages.find((m) => m.channelId === "demo-thread" && m.webhookId);
  const receiverReqPost = afterRequest.messages.find((m) => m.channelId === "beta-channel" && !m.webhookId);
  assert.ok(senderReqPost, `expected sender-side post in demo-thread: ${JSON.stringify(afterRequest.messages)}`);
  assert.ok(receiverReqPost, `expected receiver-side post in beta-channel: ${JSON.stringify(afterRequest.messages)}`);
  assert.deepEqual(reqEvent.post, { channel_id: "beta-channel", message_id: receiverReqPost.id });

  const senderReqLink = `https://discord.com/channels/guild-id/demo-thread/${senderReqPost.id}`;
  const receiverReqLink = `https://discord.com/channels/guild-id/beta-channel/${receiverReqPost.id}`;
  assert.equal(senderReqPost.username, "demo-codex · 37%");
  assert.equal(
    senderReqPost.content,
    `-# ⇄ Agent Request to **beta-codex** · ${reqId} · [counterpart](${receiverReqLink})\nCheck staging from thread`,
  );
  assert.equal(
    receiverReqPost.content,
    `-# ⇄ Agent Request from **demo-codex › Deploy Check** · ${reqId} · [counterpart](${senderReqLink})\nCheck staging from thread`,
  );
  // Sender-side post used parent webhook with thread_id=demo-thread; nothing was posted into demo-channel.
  assert.deepEqual(afterRequest.messages.filter((m) => m.channelId === "demo-channel"), []);
  const webhookPostReq = afterRequest.requestLog.find((entry) => entry.method === "POST" && entry.path.includes("/webhooks/"));
  assert.match(webhookPostReq.path, /[?&]thread_id=demo-thread(?:&|$)/);

  const replied = await beta.request("agent_reply", {
    request_id: reqId,
    text: "Staging is healthy",
    idempotency_key: "thread-reply-1",
    context_pct: 19,
  });
  assert.equal(replied.ok, true, JSON.stringify(replied));
  assert.deepEqual(replied.result, { request_id: reqId, delivered_to_live_session: true });

  const replyEvent = await waitFor(
    () => demoThread.events.find((event) => event.event === "agent_message" && event.kind === "reply"),
    () => `demoThread reply event: ${JSON.stringify(demoThread.events)}`,
  );
  assert.equal(replyEvent.request_id, reqId);
  assert.equal(replyEvent.text, "Staging is healthy");
  assert.deepEqual(replyEvent.from, {
    project: "beta",
    provider: "codex",
    conversation_id: "beta-channel",
  });

  // Fence parent channel and sibling thread: neither receives the reply.
  await fenceOwnerMessage(workspace, demoChannel, "demo-channel", "fence-parent");
  await fenceOwnerMessage(workspace, demoSibling, "demo-sibling", "fence-sibling");
  assert.deepEqual(demoChannel.events.filter((e) => e.event === "agent_message"), []);
  assert.deepEqual(demoSibling.events.filter((e) => e.event === "agent_message"), []);

  const afterReply = readState(workspace.stateDir).fixtures.discord;
  const replierReplyPost = afterReply.messages.find((m) => m.channelId === "beta-channel" && m.webhookId);
  const receiverReplyPost = afterReply.messages.find((m) => m.channelId === "demo-thread" && !m.webhookId);
  assert.ok(replierReplyPost, `expected replier post in beta-channel: ${JSON.stringify(afterReply.messages)}`);
  assert.ok(receiverReplyPost, `expected receiver reply post in demo-thread: ${JSON.stringify(afterReply.messages)}`);
  assert.deepEqual(replyEvent.post, { channel_id: "demo-thread", message_id: receiverReplyPost.id });

  const replierReplyLink = `https://discord.com/channels/guild-id/beta-channel/${replierReplyPost.id}`;
  const receiverReplyLink = `https://discord.com/channels/guild-id/demo-thread/${receiverReplyPost.id}`;
  assert.equal(
    replierReplyPost.content,
    `-# ⇄ Agent Reply to **demo-codex › Deploy Check** · ${reqId} · [counterpart](${receiverReplyLink})\nStaging is healthy`,
  );
  assert.equal(
    receiverReplyPost.content,
    `-# ⇄ Agent Reply from **beta-codex** · ${reqId} · [counterpart](${replierReplyLink})\nStaging is healthy`,
  );

  const checkMarks = (afterReply.reactions ?? []).filter((r) => r.emoji === encodeURIComponent("✅"));
  assert.deepEqual(checkMarks, [
    { authorization: `Bot ${ROOT_TOKEN}`, channelId: "demo-thread", emoji: encodeURIComponent("✅"), messageId: senderReqPost.id, threadArchived: false },
    { authorization: `Bot ${ROOT_TOKEN}`, channelId: "beta-channel", emoji: encodeURIComponent("✅"), messageId: receiverReqPost.id },
  ]);
});

test("a channel session reaches a thread by project/<thread id>, Discord link, and unique thread name, and any launch of the target thread may reply", async () => {
  const workspace = createRouterWorkspace(routerRegistry({
    demo: { channel_id: "demo-channel", type: "claude", transport: "router", agent_message_targets: ["beta"] },
    beta: { channel_id: "beta-channel", type: "codex", transport: "router" },
  }));
  await routerWithWebhooks(workspace, ["demo", "beta"]);
  seedThreads(workspace, {
    "beta-thread": { type: 11, parentId: "beta-channel", name: "Infra Check" },
    "beta-sibling": { type: 11, parentId: "beta-channel", name: "Other Thread" },
  });

  const demo = await connectAgentProject(workspace, "demo");
  const betaChannel = await connectAgentProject(workspace, "beta");
  writeThreadKey(workspace, "beta-thread", "beta-thread-key-1");
  const betaThread = await connectAgentThread(workspace, {
    project: "beta",
    threadId: "beta-thread",
    provider: "gemini",
    key: "beta-thread-key-1",
  });
  const betaSibling = await connectAgentThread(workspace, {
    project: "beta",
    threadId: "beta-sibling",
    provider: "claude",
  });
  assert.equal(betaThread.hello.type, "hello_ok");
  assert.equal(betaSibling.hello.type, "hello_ok");

  const targets = [
    ["by-id", "beta/beta-thread", "Hello by id"],
    ["by-link", "https://discord.com/channels/guild-id/beta-thread", "Hello by link"],
    ["by-name", "beta/Infra Check", "Hello by name"],
  ];

  const requestIds = [];
  for (const [label, target, text] of targets) {
    const sent = await demo.request("agent_request", {
      target,
      text,
      idempotency_key: `target-${label}`,
    });
    assert.equal(sent.ok, true, `${label}: ${JSON.stringify(sent)}`);
    requestIds.push(sent.result.request_id);

    const event = await waitFor(
      () => betaThread.events.find((e) => e.event === "agent_message" && e.kind === "request" && e.request_id === sent.result.request_id),
      () => `${label} request event on betaThread: ${JSON.stringify(betaThread.events)}`,
    );
    assert.equal(event.text, text);
    assert.equal(event.post.channel_id, "beta-thread");
    assert.deepEqual(event.from, {
      project: "demo",
      provider: "claude",
      conversation_id: "demo-channel",
    });
  }

  // Only beta-thread received the events; beta's channel and sibling thread received nothing.
  await fenceOwnerMessage(workspace, betaChannel, "beta-channel", "fence-beta-ch");
  await fenceOwnerMessage(workspace, betaSibling, "beta-sibling", "fence-beta-sib");
  assert.deepEqual(betaChannel.events.filter((e) => e.event === "agent_message"), []);
  assert.deepEqual(betaSibling.events.filter((e) => e.event === "agent_message"), []);

  // Verify records: sender-side in demo-channel with label `beta-gemini › Infra Check`, receiver-side in beta-thread.
  const afterRequests = readState(workspace.stateDir).fixtures.discord;
  const senderPosts = afterRequests.messages.filter((m) => m.channelId === "demo-channel" && m.webhookId);
  const receiverPosts = afterRequests.messages.filter((m) => m.channelId === "beta-thread" && !m.webhookId);
  assert.equal(senderPosts.length, 3);
  assert.equal(receiverPosts.length, 3);
  assert.match(senderPosts[0].content, new RegExp(`^-# ⇄ Agent Request to \\*\\*beta-gemini › Infra Check\\*\\* · ${requestIds[0]} · \\[counterpart\\]\\(https://discord\\.com/channels/guild-id/beta-thread/${receiverPosts[0].id}\\)\nHello by id$`));
  assert.match(receiverPosts[0].content, new RegExp(`^-# ⇄ Agent Request from \\*\\*demo-claude\\*\\* · ${requestIds[0]} · \\[counterpart\\]\\(https://discord\\.com/channels/guild-id/demo-channel/${senderPosts[0].id}\\)\nHello by id$`));

  // Rotate beta-thread's launch key: a new launch of the target thread can still reply!
  writeThreadKey(workspace, "beta-thread", "beta-thread-key-2");
  await betaThread.closed;
  const betaThreadNewLaunch = await connectAgentThread(workspace, {
    project: "beta",
    threadId: "beta-thread",
    provider: "gemini",
    key: "beta-thread-key-2",
  });
  assert.equal(betaThreadNewLaunch.hello.type, "hello_ok");

  const replied = await betaThreadNewLaunch.request("agent_reply", {
    request_id: requestIds[0],
    text: "Answered from new launch",
    idempotency_key: "reply-new-launch",
    context_pct: 64,
  });
  assert.equal(replied.ok, true, JSON.stringify(replied));
  assert.deepEqual(replied.result, { request_id: requestIds[0], delivered_to_live_session: true });

  const replyEvent = await waitFor(
    () => demo.events.find((e) => e.event === "agent_message" && e.kind === "reply" && e.request_id === requestIds[0]),
    () => `demo reply from betaThreadNewLaunch: ${JSON.stringify(demo.events)}`,
  );
  assert.deepEqual(replyEvent.from, {
    project: "beta",
    provider: "gemini",
    conversation_id: "beta-thread",
    thread_id: "beta-thread",
    thread_name: "Infra Check",
  });

  const afterReply = readState(workspace.stateDir).fixtures.discord;
  const replierPost = afterReply.messages.find((m) => m.channelId === "beta-thread" && m.webhookId);
  assert.ok(replierPost, `expected replier webhook post in beta-thread: ${JSON.stringify(afterReply.messages)}`);
  assert.equal(replierPost.username, "beta-gemini · 64%");
  const receiverReplyPost = afterReply.messages.find((m) => m.id === replyEvent.post.message_id);
  assert.equal(receiverReplyPost.channelId, "demo-channel");
  assert.match(receiverReplyPost.content, new RegExp(`^-# ⇄ Agent Reply from \\*\\*beta-gemini › Infra Check\\*\\* · ${requestIds[0]}`));
});

test("channel to own thread and thread to sibling thread require a self-grant", async () => {
  const workspace = createRouterWorkspace(routerRegistry({
    demo: { channel_id: "demo-channel", type: "claude", transport: "router" },
    beta: { channel_id: "beta-channel", type: "codex", transport: "router", agent_message_targets: ["beta"] },
  }));
  await routerWithWebhooks(workspace, ["demo", "beta"]);
  seedThreads(workspace, {
    "demo-t1": { type: 11, parentId: "demo-channel", name: "Demo One" },
    "demo-t2": { type: 11, parentId: "demo-channel", name: "Demo Two" },
    "beta-t1": { type: 11, parentId: "beta-channel", name: "Beta One" },
    "beta-t2": { type: 11, parentId: "beta-channel", name: "Beta Two" },
  });

  const demoCh = await connectAgentProject(workspace, "demo");
  const demoT1 = await connectAgentThread(workspace, { project: "demo", threadId: "demo-t1", provider: "claude" });
  const demoT2 = await connectAgentThread(workspace, { project: "demo", threadId: "demo-t2", provider: "codex" });
  const betaCh = await connectAgentProject(workspace, "beta");
  const betaT1 = await connectAgentThread(workspace, { project: "beta", threadId: "beta-t1", provider: "claude" });
  const betaT2 = await connectAgentThread(workspace, { project: "beta", threadId: "beta-t2", provider: "codex" });

  // Without self-grant: channel -> own thread and thread -> sibling thread are not_granted (including by link and name).
  for (const [label, sender, target] of [
    ["ch->own-thread-id", demoCh, "demo/demo-t1"],
    ["ch->own-thread-link", demoCh, "https://discord.com/channels/guild-id/demo-t1"],
    ["ch->own-thread-name", demoCh, "demo/Demo One"],
    ["thread->sibling-id", demoT1, "demo/demo-t2"],
    ["thread->parent-ch", demoT1, "demo"],
  ]) {
    const res = await sender.request("agent_request", { target, text: "denied", idempotency_key: `deny-${label}` });
    assert.equal(res.ok, false, label);
    assert.equal(res.error.code, "not_granted", `${label}: ${JSON.stringify(res)}`);
  }

  // With self-grant: channel -> own thread and thread -> sibling thread succeed end-to-end.
  const chToThread = await betaCh.request("agent_request", {
    target: "beta/Beta One",
    text: "Channel asking own thread",
    idempotency_key: "self-ch-t1",
  });
  assert.equal(chToThread.ok, true, JSON.stringify(chToThread));
  await waitFor(
    () => betaT1.events.some((e) => e.event === "agent_message" && e.request_id === chToThread.result.request_id),
    () => `betaT1 event: ${JSON.stringify(betaT1.events)}`,
  );

  const threadToSibling = await betaT1.request("agent_request", {
    target: "beta/beta-t2",
    text: "Thread asking sibling",
    idempotency_key: "self-t1-t2",
  });
  assert.equal(threadToSibling.ok, true, JSON.stringify(threadToSibling));
  const sibEvent = await waitFor(
    () => betaT2.events.find((e) => e.event === "agent_message" && e.request_id === threadToSibling.result.request_id),
    () => `betaT2 event: ${JSON.stringify(betaT2.events)}`,
  );
  assert.deepEqual(sibEvent.from, {
    project: "beta",
    provider: "claude",
    conversation_id: "beta-t1",
    thread_id: "beta-t1",
    thread_name: "Beta One",
  });

  // Verify nothing was posted into demo's channels or threads for the denied sends.
  const discord = readState(workspace.stateDir).fixtures.discord;
  assert.deepEqual(
    discord.messages.filter((m) => ["demo-channel", "demo-t1", "demo-t2"].includes(m.channelId)),
    [],
  );
});

test("unknown_target, ambiguous_target, and not_granted follow grant-first rules and post nothing", async () => {
  const workspace = createRouterWorkspace(routerRegistry({
    demo: { channel_id: "demo-channel", type: "claude", transport: "router", agent_message_targets: ["beta", "far"] },
    beta: { channel_id: "beta-channel", type: "codex", transport: "router" },
    gamma: { channel_id: "gamma-channel", type: "claude", transport: "router" },
    far: { channel_id: "far-channel", type: "claude", transport: "router", path: "remote:mac:/srv/far" },
  }));
  await routerWithWebhooks(workspace, ["demo", "beta", "gamma"]);
  seedThreads(workspace, {
    "demo-thread": { type: 11, parentId: "demo-channel", name: "Demo Thread" },
    "beta-dup-1": { type: 11, parentId: "beta-channel", name: "Shared Name" },
    "beta-dup-2": { type: 11, parentId: "beta-channel", name: "Shared Name" },
    "beta-offline": { type: 11, parentId: "beta-channel", name: "Offline Name" },
    "beta-private": { type: 12, parentId: "beta-channel", name: "Secret Thread" },
    "gamma-thread": { type: 11, parentId: "gamma-channel", name: "Gamma Thread" },
    "far-thread": { type: 11, parentId: "far-channel", name: "Far Thread" },
  });
  updateState(workspace.stateDir, (state) => {
    state.fixtures.discord.missingChannels = ["deleted-thread"];
  });

  const demo = await connectAgentProject(workspace, "demo");
  const betaDup1 = await connectAgentThread(workspace, { project: "beta", threadId: "beta-dup-1", provider: "codex" });
  const betaDup2 = await connectAgentThread(workspace, { project: "beta", threadId: "beta-dup-2", provider: "claude" });
  const gammaThread = await connectAgentThread(workspace, { project: "gamma", threadId: "gamma-thread", provider: "claude" });
  assert.equal(betaDup1.hello.type, "hello_ok");
  assert.equal(betaDup2.hello.type, "hello_ok");
  assert.equal(gammaThread.hello.type, "hello_ok");

  const expectedErrors = [
    // unknown_target inside granted project beta
    ["other-project-thread-id", "beta/demo-thread", "unknown_target"],
    ["ungranted-project-thread-id-under-beta", "beta/gamma-thread", "unknown_target"],
    ["private-thread-id", "beta/beta-private", "unknown_target"],
    ["private-thread-link", "https://discord.com/channels/guild-id/beta-private", "unknown_target"],
    ["granted-channel-link-not-thread", "https://discord.com/channels/guild-id/beta-channel", "unknown_target"],
    ["offline-thread-by-name", "beta/Offline Name", "unknown_target"],
    ["missing-thread-by-name", "beta/No Such Thread", "unknown_target"],
    // ambiguous_target for two live threads sharing a name
    ["duplicate-live-name", "beta/Shared Name", "ambiguous_target"],
    // not_granted for links resolving nowhere, into ungranted project, or into remote project
    ["link-nowhere-unseeded", "https://discord.com/channels/guild-id/no-such-channel", "not_granted"],
    ["link-nowhere-404", "https://discord.com/channels/guild-id/deleted-thread", "not_granted"],
    ["link-ungranted-thread", "https://discord.com/channels/guild-id/gamma-thread", "not_granted"],
    ["link-ungranted-channel", "https://discord.com/channels/guild-id/gamma-channel", "not_granted"],
    ["link-remote-thread", "https://discord.com/channels/guild-id/far-thread", "not_granted"],
    ["ungranted-project-slash-missing", "gamma/does-not-exist", "not_granted"],
  ];

  for (const [label, target, expectedCode] of expectedErrors) {
    const res = await demo.request("agent_request", {
      target,
      text: `check ${label}`,
      idempotency_key: `err-${label}`,
    });
    assert.equal(res.ok, false, `${label} should fail`);
    assert.equal(res.error.code, expectedCode, `${label}: ${JSON.stringify(res)}`);
  }

  // None of those refusals posted any Discord message.
  await fenceOwnerMessage(workspace, demo, "demo-channel", "fence-errors-done");
  assert.deepEqual(readState(workspace.stateDir).fixtures.discord.messages ?? [], []);
});

test("an archived target thread returns target_closed whether or not a session is connected, posts one ⚠️ record in sender only, and stays archived", async () => {
  const workspace = createRouterWorkspace(routerRegistry({
    demo: { channel_id: "demo-channel", type: "claude", transport: "router", agent_message_targets: ["beta"] },
    beta: { channel_id: "beta-channel", type: "codex", transport: "router" },
  }));
  await routerWithWebhooks(workspace, ["demo", "beta"]);
  seedThreads(workspace, {
    "beta-archived-idle": { type: 11, parentId: "beta-channel", name: "Old Task", archived: true },
    "beta-archived-live": { type: 11, parentId: "beta-channel", name: "Closing Task", archived: false },
    "beta-offline": { type: 11, parentId: "beta-channel", name: "Quiet Task", archived: false },
  });

  const demo = await connectAgentProject(workspace, "demo");
  // Connect a capable listener while active, then archive the thread in Discord.
  const archivedLive = await connectAgentThread(workspace, {
    project: "beta",
    threadId: "beta-archived-live",
    provider: "gemini",
  });
  assert.equal(archivedLive.hello.type, "hello_ok");
  updateState(workspace.stateDir, (state) => {
    state.fixtures.discord.threads["beta-archived-live"].archived = true;
  });

  // 1. Archived thread with no session (by link).
  const closedIdle = await demo.request("agent_request", {
    target: "https://discord.com/channels/guild-id/beta-archived-idle",
    text: "Are you still open?",
    idempotency_key: "closed-idle-1",
    context_pct: 22,
  });
  assert.equal(closedIdle.ok, false);
  assert.equal(closedIdle.error.code, "target_closed");

  // 2. Archived thread WITH a live capable listener still connected (by project/<id>).
  const closedLive = await demo.request("agent_request", {
    target: "beta/beta-archived-live",
    text: "Even with listener connected",
    idempotency_key: "closed-live-1",
    context_pct: 23,
  });
  assert.equal(closedLive.ok, false);
  assert.equal(closedLive.error.code, "target_closed");

  // 3. Non-archived offline thread (by project/<id>) is target_offline.
  const offlineThread = await demo.request("agent_request", {
    target: "beta/beta-offline",
    text: "Session stopped",
    idempotency_key: "offline-thread-1",
  });
  assert.equal(offlineThread.ok, false);
  assert.equal(offlineThread.error.code, "target_offline");

  const state = await waitFor(() => {
    const discord = readState(workspace.stateDir).fixtures.discord;
    const senderMsgs = (discord.messages ?? []).filter((m) => m.channelId === "demo-channel" && m.webhookId);
    const warns = (discord.reactions ?? []).filter((r) => r.emoji === encodeURIComponent("⚠️"));
    return senderMsgs.length === 3 && warns.length === 3 ? discord : null;
  }, () => `3 undelivered records + ⚠️: ${JSON.stringify(readState(workspace.stateDir).fixtures.discord)}`);

  // Nothing posted into any target thread.
  assert.deepEqual(
    state.messages.filter((m) => m.channelId !== "demo-channel"),
    [],
  );
  // Both archived threads stayed archived.
  assert.equal(state.threads["beta-archived-idle"].archived, true);
  assert.equal(state.threads["beta-archived-live"].archived, true);
  // Check headers & labels.
  const [idleMsg, liveMsg, offMsg] = state.messages;
  assert.match(
    idleMsg.content,
    /^-# ⇄ Agent Request to \*\*beta-codex › Old Task\*\* · req-[0-9a-f]{12} · not delivered: target_closed\nAre you still open\?$/,
  );
  assert.match(
    liveMsg.content,
    /^-# ⇄ Agent Request to \*\*beta-gemini › Closing Task\*\* · req-[0-9a-f]{12} · not delivered: target_closed\nEven with listener connected$/,
  );
  assert.match(
    offMsg.content,
    /^-# ⇄ Agent Request to \*\*beta-codex › Quiet Task\*\* · req-[0-9a-f]{12} · not delivered: target_offline\nSession stopped$/,
  );
  // The connected session on the archived thread received no agent_message event.
  await fenceOwnerMessage(workspace, archivedLive, "beta-archived-live", "fence-archived-live");
  assert.deepEqual(archivedLive.events.filter((e) => e.event === "agent_message"), []);
});

test("a thread archived while its request is open gets no further record, stays archived, settles 50083/404 marks, and ends the exchange normally", async () => {
  const workspace = createRouterWorkspace(routerRegistry({
    demo: { channel_id: "demo-channel", type: "claude", transport: "router", agent_message_targets: ["beta"] },
    beta: { channel_id: "beta-channel", type: "codex", transport: "router" },
  }));
  const router = await routerWithWebhooks(workspace, ["demo", "beta"]);
  seedThreads(workspace, {
    "demo-thread": { type: 11, parentId: "demo-channel", name: "Sender Thread", archived: false },
    "beta-thread": { type: 11, parentId: "beta-channel", name: "Target Thread", archived: false },
  });

  const demoCh = await connectAgentProject(workspace, "demo");
  const demoThread = await connectAgentThread(workspace, { project: "demo", threadId: "demo-thread", provider: "claude" });
  const betaCh = await connectAgentProject(workspace, "beta");
  const betaThread = await connectAgentThread(workspace, { project: "beta", threadId: "beta-thread", provider: "codex" });

  // Case A: sender thread is archived while its request to beta channel is open.
  const sentA = await demoThread.request("agent_request", {
    target: "beta",
    text: "Sender will archive",
    idempotency_key: "arch-mid-a",
  });
  assert.equal(sentA.ok, true, JSON.stringify(sentA));
  const reqIdA = sentA.result.request_id;
  await waitFor(
    () => betaCh.events.some((e) => e.event === "agent_message" && e.request_id === reqIdA),
    () => `betaCh request ${reqIdA}`,
  );
  const beforeArchiveA = readState(workspace.stateDir).fixtures.discord;
  const senderPostA = beforeArchiveA.messages.find((m) => m.channelId === "demo-thread" && m.webhookId);
  const receiverPostA = beforeArchiveA.messages.find((m) => m.channelId === "beta-channel" && !m.webhookId);
  assert.ok(senderPostA && receiverPostA);

  // Archive demo-thread and make Discord refuse the reaction on senderPostA with 50083 (Thread is archived).
  updateState(workspace.stateDir, (state) => {
    state.fixtures.discord.threads["demo-thread"].archived = true;
    state.fixtures.discord.restFailures = [
      {
        method: "PUT",
        path: `/api/v10/channels/demo-thread/messages/${senderPostA.id}/reactions/${encodeURIComponent("✅")}/@me`,
        status: 400,
        body: { code: 50083, message: "Thread is archived" },
      },
    ];
  });

  const replyA = await betaCh.request("agent_reply", {
    request_id: reqIdA,
    text: "Reply while sender archived",
    idempotency_key: "arch-mid-reply-a",
  });
  assert.equal(replyA.ok, true, JSON.stringify(replyA));
  const replyEventA = await waitFor(
    () => demoThread.events.find((e) => e.event === "agent_message" && e.kind === "reply" && e.request_id === reqIdA),
    () => `demoThread reply A: ${JSON.stringify(demoThread.events)}`,
  );
  assert.equal(replyEventA.text, "Reply while sender archived");
  assert.equal(replyEventA.post, null);

  const afterA = readState(workspace.stateDir).fixtures.discord;
  // demo-thread got no further record and stayed archived.
  assert.deepEqual(
    afterA.messages.filter((m) => m.channelId === "demo-thread").map((m) => m.id),
    [senderPostA.id],
  );
  assert.equal(afterA.threads["demo-thread"].archived, true);
  // beta-channel got its replier-side reply record and ✅ on receiverPostA.
  const replierPostA = afterA.messages.find((m) => m.channelId === "beta-channel" && m.webhookId);
  assert.ok(replierPostA);
  assert.equal(replierPostA.content, `-# ⇄ Agent Reply to **demo-claude › Sender Thread** · ${reqIdA}\nReply while sender archived`);
  assert.ok(
    (afterA.reactions ?? []).some((r) => r.channelId === "beta-channel" && r.messageId === receiverPostA.id && r.emoji === encodeURIComponent("✅")),
    `expected ✅ on receiverPostA: ${JSON.stringify(afterA.reactions)}`,
  );
  // Exchange ended normally: second reply is already_replied.
  const dupA = await betaCh.request("agent_reply", {
    request_id: reqIdA,
    text: "Duplicate",
    idempotency_key: "arch-mid-dup-a",
  });
  assert.equal(dupA.ok, false);
  assert.equal(dupA.error.code, "already_replied");

  // Case B: target thread is archived while its request from demo channel is open.
  const sentB = await demoCh.request("agent_request", {
    target: "beta/beta-thread",
    text: "Target will archive",
    idempotency_key: "arch-mid-b",
  });
  assert.equal(sentB.ok, true, JSON.stringify(sentB));
  const reqIdB = sentB.result.request_id;
  await waitFor(
    () => betaThread.events.some((e) => e.event === "agent_message" && e.request_id === reqIdB),
    () => `betaThread request ${reqIdB}`,
  );
  const beforeArchiveB = readState(workspace.stateDir).fixtures.discord;
  const senderPostB = beforeArchiveB.messages.find((m) => m.channelId === "demo-channel" && m.webhookId);
  const receiverPostB = beforeArchiveB.messages.find((m) => m.channelId === "beta-thread" && !m.webhookId);
  assert.ok(senderPostB && receiverPostB);

  // Archive beta-thread and make Discord return 404 (message gone) on receiverPostB's reaction.
  updateState(workspace.stateDir, (state) => {
    state.fixtures.discord.threads["beta-thread"].archived = true;
    state.fixtures.discord.restFailures = [
      {
        method: "PUT",
        path: `/api/v10/channels/beta-thread/messages/${receiverPostB.id}/reactions/${encodeURIComponent("✅")}/@me`,
        status: 404,
        body: { code: 10008, message: "Unknown Message" },
      },
    ];
  });

  const replyB = await betaThread.request("agent_reply", {
    request_id: reqIdB,
    text: "Reply while target archived",
    idempotency_key: "arch-mid-reply-b",
  });
  assert.equal(replyB.ok, true, JSON.stringify(replyB));
  const replyEventB = await waitFor(
    () => demoCh.events.find((e) => e.event === "agent_message" && e.kind === "reply" && e.request_id === reqIdB),
    () => `demoCh reply B: ${JSON.stringify(demoCh.events)}`,
  );
  assert.equal(replyEventB.text, "Reply while target archived");
  assert.equal(replyEventB.post.channel_id, "demo-channel");

  const afterB = readState(workspace.stateDir).fixtures.discord;
  // beta-thread got no further record and stayed archived.
  assert.deepEqual(
    afterB.messages.filter((m) => m.channelId === "beta-thread").map((m) => m.id),
    [receiverPostB.id],
  );
  assert.equal(afterB.threads["beta-thread"].archived, true);
  // demo-channel got the receiver-side reply record and ✅ on senderPostB.
  const receiverReplyB = afterB.messages.find((m) => m.id === replyEventB.post.message_id);
  assert.equal(receiverReplyB.content, `-# ⇄ Agent Reply from **beta-codex › Target Thread** · ${reqIdB}\nReply while target archived`);
  assert.ok(
    (afterB.reactions ?? []).some((r) => r.channelId === "demo-channel" && r.messageId === senderPostB.id && r.emoji === encodeURIComponent("✅")),
    `expected ✅ on senderPostB: ${JSON.stringify(afterB.reactions)}`,
  );
  // Both 50083 and 404 mark refusals counted as settled (no mark_failed log).
  assert.equal(router.stdout.includes("agent_message_mark_failed"), false, router.stdout);
});

test("a thread session still cannot read, react, edit, or fetch in its parent, a sibling, or the other project", async () => {
  const workspace = createRouterWorkspace(routerRegistry({
    demo: { channel_id: "demo-channel", type: "claude", transport: "router", agent_message_targets: ["demo", "beta"] },
    beta: { channel_id: "beta-channel", type: "codex", transport: "router" },
  }));
  await routerWithWebhooks(workspace, ["demo", "beta"]);
  seedThreads(workspace, {
    "demo-thread": { type: 11, parentId: "demo-channel", name: "Thread A" },
    "demo-sibling": { type: 11, parentId: "demo-channel", name: "Thread B" },
    "beta-thread": { type: 11, parentId: "beta-channel", name: "Beta Thread" },
  });

  const demoThread = await connectAgentThread(workspace, { project: "demo", threadId: "demo-thread", provider: "claude" });
  const demoSibling = await connectAgentThread(workspace, { project: "demo", threadId: "demo-sibling", provider: "claude" });
  const betaThread = await connectAgentThread(workspace, { project: "beta", threadId: "beta-thread", provider: "codex" });

  const sent = await demoThread.request("agent_request", {
    target: "beta/beta-thread",
    text: "Cross-project thread request",
    idempotency_key: "scope-th-1",
  });
  assert.equal(sent.ok, true, JSON.stringify(sent));
  const reqEvent = await waitFor(
    () => betaThread.events.find((e) => e.event === "agent_message" && e.request_id === sent.result.request_id),
    () => `betaThread request`,
  );
  const replied = await betaThread.request("agent_reply", {
    request_id: sent.result.request_id,
    text: "Cross-project thread reply",
    idempotency_key: "scope-th-reply-1",
  });
  assert.equal(replied.ok, true, JSON.stringify(replied));
  const replyEvent = await waitFor(
    () => demoThread.events.find((e) => e.event === "agent_message" && e.kind === "reply" && e.request_id === sent.result.request_id),
    () => `demoThread reply`,
  );

  // Also seed a message in sibling and parent via reply from demoSibling.
  const sibReply = await demoSibling.request("reply", { channel_id: "demo-sibling", text: "Sibling msg" });
  assert.equal(sibReply.ok, true, JSON.stringify(sibReply));
  const siblingMsgId = sibReply.result.message_id;
  const betaRecordId = reqEvent.post.message_id;
  const ownBotReplyId = replyEvent.post.message_id;

  const attempts = [
    ["fetch parent", "fetch_messages", { channel_id: "demo-channel", limit: 5 }],
    ["read_last parent", "read_last_x_messages_in_channel", { channel_id: "demo-channel", count: 5 }],
    ["react parent", "react", { channel_id: "demo-channel", message_id: siblingMsgId, emoji: "👍" }],
    ["edit parent", "edit_message", { channel_id: "demo-channel", message_id: siblingMsgId, text: "nope" }],
    ["fetch sibling", "fetch_messages", { channel_id: "demo-sibling", limit: 5 }],
    ["react sibling", "react", { channel_id: "demo-sibling", message_id: siblingMsgId, emoji: "👍" }],
    ["react sibling via own thread", "react", { channel_id: "demo-thread", message_id: siblingMsgId, emoji: "👍" }],
    ["edit sibling", "edit_message", { channel_id: "demo-sibling", message_id: siblingMsgId, text: "nope" }],
    ["fetch beta channel", "fetch_messages", { channel_id: "beta-channel", limit: 5 }],
    ["fetch beta thread", "fetch_messages", { channel_id: "beta-thread", limit: 5 }],
    ["read_last beta thread", "read_last_x_messages_in_channel", { channel_id: "beta-thread", count: 5 }],
    ["react beta thread", "react", { channel_id: "beta-thread", message_id: betaRecordId, emoji: "👍" }],
    ["react beta record via own thread", "react", { channel_id: "demo-thread", message_id: betaRecordId, emoji: "👍" }],
    ["edit beta thread", "edit_message", { channel_id: "beta-thread", message_id: betaRecordId, text: "nope" }],
    ["edit own root-bot reply record", "edit_message", { channel_id: "demo-thread", message_id: ownBotReplyId, text: "nope" }],
  ];
  for (const [label, op, args] of attempts) {
    const res = await demoThread.request(op, args);
    assert.equal(res.ok, false, `${label} should fail`);
    assert.equal(res.error.code, "scope_violation", `${label}: ${JSON.stringify(res)}`);
  }
});

test("agent_targets lists exactly granted registered non-remote projects with channel_live and capable live threads, null when unreadable, and empty for ungranted/remote senders", async () => {
  const workspace = createRouterWorkspace({
    ...routerRegistry({
      demo: {
        channel_id: "demo-channel",
        type: "claude",
        transport: "router",
        agent_message_targets: ["beta", "gamma", "delta", "stale-ghost", "root", "far"],
      },
      beta: { channel_id: "beta-channel", type: "codex", transport: "router" },
      gamma: { channel_id: "gamma-channel", type: "claude", transport: "router" },
      delta: { channel_id: "delta-channel", type: "gemini", transport: "router" },
      ungranted: { channel_id: "ungranted-channel", type: "claude", transport: "router" },
      far: {
        channel_id: "far-channel",
        type: "claude",
        transport: "router",
        path: "remote:mac:/srv/far",
        agent_message_targets: ["beta"],
      },
    }),
    root_channels: ["root-channel"],
  });
  await routerWithWebhooks(workspace, ["demo", "beta", "gamma", "delta", "ungranted", "far"]);
  seedThreads(workspace, {
    "demo-thread": { type: 11, parentId: "demo-channel", name: "Demo Thread" },
    "beta-live-1": { type: 11, parentId: "beta-channel", name: "Alpha Task" },
    "beta-live-2": { type: 11, parentId: "beta-channel", name: "Beta Task" },
    "beta-incapable": { type: 11, parentId: "beta-channel", name: "Old Session" },
    "beta-offline": { type: 11, parentId: "beta-channel", name: "Offline Thread" },
    "gamma-live": { type: 11, parentId: "gamma-channel", name: "Gamma Task" },
  });

  const demo = await connectAgentProject(workspace, "demo");
  const demoOps = await rawClient(workspace, { role: "project", project: "demo", key: "demo-key", listener: false });
  const demoThread = await connectAgentThread(workspace, { project: "demo", threadId: "demo-thread", provider: "claude" });
  const demoThreadOps = await connectAgentThread(workspace, {
    project: "demo",
    threadId: "demo-thread",
    provider: "claude",
    key: "demo-thread-key",
    listener: false,
  });

  // beta: capable channel listener + 2 capable live threads + 1 incapable thread + 1 op-only thread.
  await connectAgentProject(workspace, "beta");
  await connectAgentThread(workspace, { project: "beta", threadId: "beta-live-1", provider: "codex" });
  await connectAgentThread(workspace, { project: "beta", threadId: "beta-live-2", provider: "gemini" });
  await connectAgentThread(workspace, { project: "beta", threadId: "beta-incapable", provider: "claude", capabilities: null });
  await connectAgentThread(workspace, { project: "beta", threadId: "beta-live-1", provider: "codex", key: "beta-live-1-key", listener: false });

  // gamma: INCAPABLE channel listener + 1 capable live thread.
  await rawClient(workspace, { role: "project", project: "gamma", key: "gamma-key" });
  await connectAgentThread(workspace, { project: "gamma", threadId: "gamma-live", provider: "claude" });

  // delta: no listeners at all (only an op-only connection).
  await rawClient(workspace, { role: "project", project: "delta", key: "delta-key", listener: false });

  // ungranted and remote senders.
  const ungranted = await connectAgentProject(workspace, "ungranted");
  const far = await connectAgentProject(workspace, "far");

  const expected = {
    targets: [
      {
        project: "beta",
        channel_live: true,
        threads: [
          { id: "beta-live-1", name: "Alpha Task" },
          { id: "beta-live-2", name: "Beta Task" },
        ],
      },
      {
        project: "gamma",
        channel_live: false,
        threads: [
          { id: "gamma-live", name: "Gamma Task" },
        ],
      },
      {
        project: "delta",
        channel_live: false,
        threads: [],
      },
    ],
  };

  for (const [label, client] of [
    ["project-listener", demo],
    ["project-op-only", demoOps],
    ["thread-listener", demoThread],
    ["thread-op-only", demoThreadOps],
  ]) {
    const res = await client.request("agent_targets", {});
    assert.equal(res.ok, true, `${label}: ${JSON.stringify(res)}`);
    assert.deepEqual(res.result, expected, label);
  }

  // Ungranted and remote senders receive an empty targets list.
  const ungrantedRes = await ungranted.request("agent_targets", {});
  assert.equal(ungrantedRes.ok, true, JSON.stringify(ungrantedRes));
  assert.deepEqual(ungrantedRes.result, { targets: [] });

  const farRes = await far.request("agent_targets", {});
  assert.equal(farRes.ok, true, JSON.stringify(farRes));
  assert.deepEqual(farRes.result, { targets: [] });

  // When Discord cannot read a thread's name, agent_targets returns name: null for that thread.
  updateState(workspace.stateDir, (state) => {
    state.fixtures.discord.missingChannels = ["beta-live-2"];
  });
  const unreadableRes = await demo.request("agent_targets", {});
  assert.equal(unreadableRes.ok, true, JSON.stringify(unreadableRes));
  assert.deepEqual(unreadableRes.result.targets[0].threads, [
    { id: "beta-live-1", name: "Alpha Task" },
    { id: "beta-live-2", name: null },
  ]);
});

test("an Agent Request to a bound offline thread returns target_offline at once, starts no session under Thread Supervisor, and is not delivered later", async () => {
  const workspace = createRouterWorkspace(routerRegistry({
    demo: { channel_id: "demo-channel", type: "claude", transport: "router", agent_message_targets: ["beta"] },
    beta: { channel_id: "beta-channel", type: "claude", transport: "router" },
  }));
  await routerWithWebhooks(workspace, ["demo", "beta"]);
  await startThreadSupervisor(workspace);

  const threadId = "beta-bound-offline-thread";
  updateState(workspace.stateDir, (state) => {
    (state.fixtures.discord.injectedThreads ||= []).push({
      id: threadId,
      type: 11,
      parentId: "beta-channel",
      name: "Idle Worker",
      ownerId: OWNER_ID,
      autoArchiveDuration: 1440,
      event: "create",
    });
  });
  await waitFor(
    async () => (await supervisorStatus(workspace)).projects?.beta?.threads?.[threadId]?.state === "registered",
    async () => `bound offline thread: ${JSON.stringify(await supervisorStatus(workspace))}`,
  );

  const demo = await connectAgentProject(workspace, "demo");
  const res = await demo.request("agent_request", {
    target: `beta/${threadId}`,
    text: "Do not boot this thread",
    idempotency_key: "offline-bound-thread-1",
  });
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.equal(res.error.code, "target_offline");

  // Wait for the sender-side ⚠️ record, then fence with an owner message in demo-channel.
  await waitFor(() => {
    const discord = readState(workspace.stateDir).fixtures.discord;
    return (discord.messages ?? []).some((m) => m.channelId === "demo-channel" && m.content.includes("not delivered: target_offline"))
      && (discord.reactions ?? []).some((r) => r.emoji === encodeURIComponent("⚠️"));
  }, () => `offline sender record: ${JSON.stringify(readState(workspace.stateDir).fixtures.discord)}`);
  await fenceOwnerMessage(workspace, demo, "demo-channel", "fence-no-boot");

  // Nothing was posted into the target thread and the Thread Supervisor started no session.
  const state = readState(workspace.stateDir);
  assert.deepEqual(
    (state.fixtures.discord.messages ?? []).filter((m) => m.channelId === threadId),
    [],
  );
  assert.equal((await supervisorStatus(workspace)).projects?.beta?.threads?.[threadId]?.state, "registered");
  assert.deepEqual(Object.keys(state.fixtures.tmux?.sessions ?? {}), []);

  // Even if the target thread connects later, the offline request is never delivered.
  const lateThread = await connectAgentThread(workspace, { project: "beta", threadId, provider: "claude" });
  assert.equal(lateThread.hello.type, "hello_ok");
  await fenceOwnerMessage(workspace, lateThread, threadId, "fence-late-thread");
  assert.deepEqual(lateThread.events.filter((e) => e.event === "agent_message"), []);
});
