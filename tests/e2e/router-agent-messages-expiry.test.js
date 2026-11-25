import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { injectDiscordMessage } from "./support/bridge.js";
import { replaceFile } from "./support/platform.js";
import {
  OWNER_ID,
  ROOT_TOKEN,
  createRouterWorkspace,
  rawRouterSocket,
  routerRegistry,
  routerWithWebhooks,
  seedThreads,
  waitFor,
  writeProjectKey,
  writeThreadKey,
} from "./support/router.js";
import { readState } from "./support/state.js";
import { cleanup } from "./support/teardown.js";

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

function connectAgentProject(workspace, project, key, extra = {}) {
  return rawClient(workspace, {
    role: "project",
    project,
    key,
    capabilities: ["agent_messages"],
    ...extra,
  });
}

function readRegistry(workspace) {
  return JSON.parse(fs.readFileSync(path.join(workspace.repoDir, "registry.json"), "utf8"));
}

async function afterReload(router, change) {
  await new Promise((resolve) => setTimeout(resolve, 100));
  const reloads = () => router.stdout.split("registry reloaded").length - 1;
  const before = reloads();
  await change();
  await waitFor(() => reloads() > before, () => `registry reload:\n${router.stdout}\n${router.stderr}`);
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

test("timeout_minutes defaults to 30, clamps values above 120 to 120, and rejects non-positive or non-integer values with invalid_args", async () => {
  const workspace = createRouterWorkspace(routerRegistry({
    demo: { channel_id: "demo-channel", type: "claude", transport: "router", agent_message_targets: ["beta"] },
    beta: { channel_id: "beta-channel", type: "codex", transport: "router" },
  }));
  await routerWithWebhooks(workspace, ["demo", "beta"]);

  const demo = await connectAgentProject(workspace, "demo", "demo-key");
  const beta = await connectAgentProject(workspace, "beta", "beta-key");
  assert.equal(demo.hello.type, "hello_ok");
  assert.equal(beta.hello.type, "hello_ok");

  // Default timeout_minutes (omitted) -> 30 minutes (30 * 60_000 ms).
  const beforeDefault = Date.now();
  const defaultSent = await demo.request("agent_request", {
    target: "beta",
    text: "Default timeout",
    idempotency_key: "to-default",
  });
  const afterDefault = Date.now();
  assert.equal(defaultSent.ok, true, JSON.stringify(defaultSent));
  const defaultExpires = Date.parse(defaultSent.result.expires_at);
  assert.ok(
    defaultExpires >= beforeDefault + 30 * 60_000 - 1000 && defaultExpires <= afterDefault + 30 * 60_000 + 1000,
    `expected 30 minutes after acceptance, got ${defaultSent.result.expires_at}`,
  );

  // Explicit timeout_minutes: 5 -> 5 minutes.
  const beforeExplicit = Date.now();
  const explicitSent = await demo.request("agent_request", {
    target: "beta",
    text: "Five minute timeout",
    timeout_minutes: 5,
    idempotency_key: "to-five",
  });
  const afterExplicit = Date.now();
  assert.equal(explicitSent.ok, true, JSON.stringify(explicitSent));
  const explicitExpires = Date.parse(explicitSent.result.expires_at);
  assert.ok(
    explicitExpires >= beforeExplicit + 5 * 60_000 - 1000 && explicitExpires <= afterExplicit + 5 * 60_000 + 1000,
    `expected 5 minutes after acceptance, got ${explicitSent.result.expires_at}`,
  );

  // timeout_minutes: 500 -> clamped to 120 minutes.
  const beforeClamped = Date.now();
  const clampedSent = await demo.request("agent_request", {
    target: "beta",
    text: "Clamped timeout",
    timeout_minutes: 500,
    idempotency_key: "to-clamped",
  });
  const afterClamped = Date.now();
  assert.equal(clampedSent.ok, true, JSON.stringify(clampedSent));
  const clampedExpires = Date.parse(clampedSent.result.expires_at);
  assert.ok(
    clampedExpires >= beforeClamped + 120 * 60_000 - 1000 && clampedExpires <= afterClamped + 120 * 60_000 + 1000,
    `expected 120 minutes after acceptance, got ${clampedSent.result.expires_at}`,
  );

  // Invalid values: 0, negative, fraction, string, null -> invalid_args.
  for (const [label, badValue] of [
    ["zero", 0],
    ["negative", -5],
    ["fraction", 1.5],
    ["string", "30"],
    ["null", null],
  ]) {
    const res = await demo.request("agent_request", {
      target: "beta",
      text: `Bad timeout ${label}`,
      timeout_minutes: badValue,
      idempotency_key: `to-bad-${label}`,
    });
    assert.equal(res.ok, false, `${label} should fail`);
    assert.equal(res.error.code, "invalid_args", `${label}: ${JSON.stringify(res)}`);
  }
});

test("an unanswered request expires at its timeout with ⚠️ on both request posts, an expired notice, no new post, and a late reply returns request_expired", async () => {
  const workspace = createRouterWorkspace(routerRegistry({
    demo: { channel_id: "demo-channel", type: "claude", transport: "router", agent_message_targets: ["beta"] },
    beta: { channel_id: "beta-channel", type: "codex", transport: "router" },
  }));
  seedThreads(workspace, {
    "beta-thread-1": { type: 11, parentId: "beta-channel", name: "deploy-check" },
  });
  writeThreadKey(workspace, "beta-thread-1", "thread-key-1");
  await routerWithWebhooks(workspace, ["demo", "beta"], {
    env: { CCDM_ROUTER_AGENT_MESSAGE_MINUTE_MS: "200" },
  });

  const demo = await connectAgentProject(workspace, "demo", "demo-key");
  const beta = await connectAgentProject(workspace, "beta", "beta-key");
  const betaThread = await rawClient(workspace, {
    role: "thread",
    project: "beta",
    thread_id: "beta-thread-1",
    provider: "claude",
    key: "thread-key-1",
    capabilities: ["agent_messages"],
  });
  assert.equal(betaThread.hello.type, "hello_ok");

  // Channel-to-channel request with 2 short minutes (400ms).
  const sent = await demo.request("agent_request", {
    target: "beta",
    text: "Please check build logs",
    timeout_minutes: 2,
    idempotency_key: "exp-chan-1",
  });
  assert.equal(sent.ok, true, JSON.stringify(sent));
  const reqId = sent.result.request_id;

  const reqEvent = await waitFor(
    () => beta.events.find((event) => event.event === "agent_message" && event.kind === "request" && event.request_id === reqId),
    () => `beta request event: ${JSON.stringify(beta.events)}`,
  );

  // Wait for expiry notice on sender.
  const notice = await waitFor(
    () => demo.events.find((event) => event.event === "agent_message" && event.kind === "notice" && event.request_id === reqId),
    () => `demo expiry notice: ${JSON.stringify(demo.events)}`,
  );

  const discordAfterExpiry = readState(workspace.stateDir).fixtures.discord;
  const senderPost = discordAfterExpiry.messages.find((m) => m.channelId === "demo-channel" && m.webhookId);
  const receiverPost = discordAfterExpiry.messages.find((m) => m.id === reqEvent.post.message_id);
  assert.ok(senderPost, `expected sender request post: ${JSON.stringify(discordAfterExpiry.messages)}`);
  assert.ok(receiverPost, `expected receiver request post: ${JSON.stringify(discordAfterExpiry.messages)}`);
  assert.equal(discordAfterExpiry.messages.length, 2, `expiry must not post a new message: ${JSON.stringify(discordAfterExpiry.messages)}`);

  assert.equal(notice.outcome, "expired");
  assert.equal(notice.from, undefined);
  assert.equal(notice.expires_at, undefined);
  assert.equal(notice.depth, undefined);
  assert.deepEqual(notice.target, { project: "beta", provider: "codex", conversation_id: "beta-channel" });
  assert.deepEqual(notice.post, { channel_id: "demo-channel", message_id: senderPost.id });
  assert.equal(typeof notice.delivery_id, "string");
  assert.ok(notice.delivery_id.length > 0);
  assert.ok(!Number.isNaN(Date.parse(notice.ts)));
  assert.ok(notice.text.includes(reqId), `expected notice text to include ${reqId}: ${notice.text}`);

  const ackNotice = await demo.request("agent_message_ack", { delivery_id: notice.delivery_id });
  assert.equal(ackNotice.ok, true, JSON.stringify(ackNotice));

  const warnEmoji = encodeURIComponent("⚠️");
  assert.deepEqual(discordAfterExpiry.reactions, [
    { authorization: `Bot ${ROOT_TOKEN}`, channelId: "demo-channel", emoji: warnEmoji, messageId: senderPost.id },
    { authorization: `Bot ${ROOT_TOKEN}`, channelId: "beta-channel", emoji: warnEmoji, messageId: receiverPost.id },
  ]);

  // Late reply after expiry is refused with request_expired, posts nothing, delivers nothing.
  const lateReply = await beta.request("agent_reply", {
    request_id: reqId,
    text: "Too late with the logs",
    idempotency_key: "exp-late-reply-1",
  });
  assert.equal(lateReply.ok, false);
  assert.equal(lateReply.error.code, "request_expired");

  await fenceOwnerMessage(workspace, demo, "demo-channel", "fence-after-late-reply-demo");
  await fenceOwnerMessage(workspace, beta, "beta-channel", "fence-after-late-reply-beta");
  assert.deepEqual(
    demo.events.filter((event) => event.event === "agent_message" && event.kind === "reply"),
    [],
  );
  const discordAfterLateReply = readState(workspace.stateDir).fixtures.discord;
  assert.equal(discordAfterLateReply.messages.length, 2);
  assert.equal(discordAfterLateReply.reactions.length, 2);

  // Thread target expiry includes thread_id and thread_name in notice.target and marks both posts ⚠️.
  const threadSent = await demo.request("agent_request", {
    target: "beta/beta-thread-1",
    text: "Thread check that expires",
    timeout_minutes: 2,
    idempotency_key: "exp-thread-1",
  });
  assert.equal(threadSent.ok, true, JSON.stringify(threadSent));
  const threadReqId = threadSent.result.request_id;
  const threadReqEvent = await waitFor(
    () => betaThread.events.find((event) => event.event === "agent_message" && event.request_id === threadReqId),
    () => `betaThread request event: ${JSON.stringify(betaThread.events)}`,
  );
  const threadNotice = await waitFor(
    () => demo.events.find((event) => event.event === "agent_message" && event.kind === "notice" && event.request_id === threadReqId),
    () => `demo thread expiry notice: ${JSON.stringify(demo.events)}`,
  );
  assert.equal(threadNotice.outcome, "expired");
  assert.deepEqual(threadNotice.target, {
    project: "beta",
    provider: "claude",
    conversation_id: "beta-thread-1",
    thread_id: "beta-thread-1",
    thread_name: "deploy-check",
  });
  const discordAfterThread = readState(workspace.stateDir).fixtures.discord;
  const threadSenderPost = discordAfterThread.messages.find((m) => m.id === threadNotice.post.message_id);
  assert.ok(threadSenderPost);
  assert.equal(discordAfterThread.messages.length, 4);
  assert.deepEqual(discordAfterThread.reactions.slice(2), [
    { authorization: `Bot ${ROOT_TOKEN}`, channelId: "demo-channel", emoji: warnEmoji, messageId: threadSenderPost.id },
    { authorization: `Bot ${ROOT_TOKEN}`, channelId: "beta-thread-1", emoji: warnEmoji, messageId: threadReqEvent.post.message_id, threadArchived: false },
  ]);
});

test("a request answered in time never gets ⚠️ or a notice, and revoking the grant or replacing the target launch still allows a reply", async () => {
  const workspace = createRouterWorkspace(routerRegistry({
    demo: { channel_id: "demo-channel", type: "claude", transport: "router", agent_message_targets: ["beta"] },
    beta: { channel_id: "beta-channel", type: "codex", transport: "router" },
  }));
  const router = await routerWithWebhooks(workspace, ["demo", "beta"], {
    env: {
      CCDM_ROUTER_AGENT_MESSAGE_MINUTE_MS: "250",
      CCDM_ROUTER_REGISTRY_DEBOUNCE_MS: "20",
    },
  });

  const demo = await connectAgentProject(workspace, "demo", "demo-key");
  const beta = await connectAgentProject(workspace, "beta", "beta-key");

  // 1. Answered in time: past expires_at there is no ⚠️ and no notice.
  const sentOnTime = await demo.request("agent_request", {
    target: "beta",
    text: "Fast question",
    timeout_minutes: 2,
    idempotency_key: "ontime-req-1",
  });
  assert.equal(sentOnTime.ok, true, JSON.stringify(sentOnTime));
  const onTimeId = sentOnTime.result.request_id;
  await waitFor(
    () => beta.events.some((event) => event.event === "agent_message" && event.request_id === onTimeId),
    () => `beta on-time request: ${JSON.stringify(beta.events)}`,
  );
  const onTimeReply = await beta.request("agent_reply", {
    request_id: onTimeId,
    text: "Fast answer",
    idempotency_key: "ontime-rep-1",
  });
  assert.equal(onTimeReply.ok, true, JSON.stringify(onTimeReply));
  await waitFor(
    () => demo.events.some((event) => event.event === "agent_message" && event.kind === "reply" && event.request_id === onTimeId),
    () => `demo on-time reply: ${JSON.stringify(demo.events)}`,
  );

  // Wait past expires_at (500ms) plus margin, then fence with a real owner message.
  const remainingMs = Date.parse(sentOnTime.result.expires_at) - Date.now();
  if (remainingMs > 0) await new Promise((resolve) => setTimeout(resolve, remainingMs + 150));
  await fenceOwnerMessage(workspace, demo, "demo-channel", "fence-after-ontime-expiry");

  assert.deepEqual(
    demo.events.filter((event) => event.event === "agent_message" && event.kind === "notice"),
    [],
    `answered request must never send a notice: ${JSON.stringify(demo.events)}`,
  );
  const reactionsAfterOnTime = readState(workspace.stateDir).fixtures.discord.reactions ?? [];
  assert.equal(
    reactionsAfterOnTime.some((r) => r.emoji === encodeURIComponent("⚠️")),
    false,
    `answered request must never get ⚠️: ${JSON.stringify(reactionsAfterOnTime)}`,
  );
  assert.equal(
    reactionsAfterOnTime.filter((r) => r.emoji === encodeURIComponent("✅")).length,
    2,
    `expected 2 ✅ marks: ${JSON.stringify(reactionsAfterOnTime)}`,
  );

  // 2. Open a second request, then revoke the grant AND replace beta's launch with a new key.
  const sentRevoked = await demo.request("agent_request", {
    target: "beta",
    text: "Keep working even if grant revoked",
    timeout_minutes: 20,
    idempotency_key: "revoked-req-1",
  });
  assert.equal(sentRevoked.ok, true, JSON.stringify(sentRevoked));
  const revokedReqId = sentRevoked.result.request_id;
  await waitFor(
    () => beta.events.some((event) => event.event === "agent_message" && event.request_id === revokedReqId),
    () => `beta revoked-grant request: ${JSON.stringify(beta.events)}`,
  );

  // Hot-reload registry to revoke demo -> beta grant.
  await afterReload(router, () => {
    const next = readRegistry(workspace);
    next.projects.demo.agent_message_targets = [];
    replaceFile(path.join(workspace.repoDir, "registry.json"), `${JSON.stringify(next, null, 2)}\n`);
  });

  // Confirm a new request is now not_granted.
  const blockedNew = await demo.request("agent_request", {
    target: "beta",
    text: "New request after revoke",
    idempotency_key: "after-revoke-req",
  });
  assert.equal(blockedNew.ok, false);
  assert.equal(blockedNew.error.code, "not_granted");

  // Rotate beta's key (revoking its original listener) and connect a new launch.
  writeProjectKey(workspace, "beta", "beta-key-2");
  await beta.closed;
  const betaLaunch2 = await connectAgentProject(workspace, "beta", "beta-key-2");
  assert.equal(betaLaunch2.hello.type, "hello_ok");

  // The new launch of beta can still answer the open request, and demo receives it.
  const replyAfterRevoke = await betaLaunch2.request("agent_reply", {
    request_id: revokedReqId,
    text: "Answer after grant revoke and relaunch",
    idempotency_key: "revoked-rep-1",
  });
  assert.equal(replyAfterRevoke.ok, true, JSON.stringify(replyAfterRevoke));
  assert.deepEqual(replyAfterRevoke.result, {
    request_id: revokedReqId,
    delivered_to_live_session: true,
  });

  const replyEvent = await waitFor(
    () => demo.events.find((event) => event.event === "agent_message" && event.kind === "reply" && event.request_id === revokedReqId),
    () => `demo reply after revoke: ${JSON.stringify(demo.events)}`,
  );
  assert.equal(replyEvent.text, "Answer after grant revoke and relaunch");
  assert.deepEqual(replyEvent.from, {
    project: "beta",
    provider: "codex",
    conversation_id: "beta-channel",
  });
});

test("a reply whose project moved to another channel is request_failed and closes the exchange, while an unanswered moved exchange expires", async () => {
  const workspace = createRouterWorkspace(routerRegistry({
    demo: { channel_id: "demo-channel", type: "claude", transport: "router", agent_message_targets: ["beta"] },
    beta: { channel_id: "beta-channel", type: "codex", transport: "router" },
  }));
  const router = await routerWithWebhooks(workspace, ["demo", "beta"], {
    env: {
      CCDM_ROUTER_AGENT_MESSAGE_MINUTE_MS: "250",
      CCDM_ROUTER_REGISTRY_DEBOUNCE_MS: "20",
    },
  });

  const demo = await connectAgentProject(workspace, "demo", "demo-key");
  const beta = await connectAgentProject(workspace, "beta", "beta-key");

  // 1. Open two requests: one that beta will try to reply to after moving, one that beta ignores so it expires.
  const sentMoved = await demo.request("agent_request", {
    target: "beta",
    text: "Will fail on reply after move",
    timeout_minutes: 3,
    idempotency_key: "move-fail-req",
  });
  assert.equal(sentMoved.ok, true, JSON.stringify(sentMoved));
  const movedId = sentMoved.result.request_id;

  const sentExpire = await demo.request("agent_request", {
    target: "beta",
    text: "Will expire untouched after move",
    timeout_minutes: 3,
    idempotency_key: "move-exp-req",
  });
  assert.equal(sentExpire.ok, true, JSON.stringify(sentExpire));
  const expireId = sentExpire.result.request_id;

  await waitFor(
    () => beta.events.filter((event) => event.event === "agent_message" && event.kind === "request").length === 2,
    () => `beta two requests: ${JSON.stringify(beta.events)}`,
  );
  const messagesBeforeMove = (readState(workspace.stateDir).fixtures.discord.messages ?? []).length;
  assert.equal(messagesBeforeMove, 4);

  // Move beta to beta-channel-2 and wait for reload + scope_changed on beta.
  await afterReload(router, () => {
    const next = readRegistry(workspace);
    next.projects.beta.channel_id = "beta-channel-2";
    replaceFile(path.join(workspace.repoDir, "registry.json"), `${JSON.stringify(next, null, 2)}\n`);
  });
  await waitFor(
    () => beta.events.some((event) => event.event === "scope_changed" && event.scope?.channel_id === "beta-channel-2"),
    () => `beta scope_changed: ${JSON.stringify(beta.events)}`,
  );

  // Reply from moved beta is refused with request_failed and closes the exchange.
  const movedReply = await beta.request("agent_reply", {
    request_id: movedId,
    text: "Reply from new channel",
    idempotency_key: "move-fail-rep-1",
  });
  assert.equal(movedReply.ok, false, JSON.stringify(movedReply));
  assert.equal(movedReply.error.code, "request_failed", JSON.stringify(movedReply));

  // Sender gets a failed notice, and no reply post was made in any channel.
  const failedNotice = await waitFor(
    () => demo.events.find((event) => event.event === "agent_message" && event.kind === "notice" && event.request_id === movedId),
    () => `demo failed notice after move: ${JSON.stringify(demo.events)}`,
  );
  assert.equal(failedNotice.outcome, "failed");
  assert.equal((readState(workspace.stateDir).fixtures.discord.messages ?? []).length, 4);

  // Move beta BACK to beta-channel and try replying again: exchange must already be closed as failed!
  await afterReload(router, () => {
    const next = readRegistry(workspace);
    next.projects.beta.channel_id = "beta-channel";
    replaceFile(path.join(workspace.repoDir, "registry.json"), `${JSON.stringify(next, null, 2)}\n`);
  });
  await waitFor(
    () => beta.events.some((event) => event.event === "scope_changed" && event.scope?.channel_id === "beta-channel"),
    () => `beta scope_changed back: ${JSON.stringify(beta.events)}`,
  );

  const retryAfterBack = await beta.request("agent_reply", {
    request_id: movedId,
    text: "Retry after moving back",
    idempotency_key: "move-fail-rep-2",
  });
  assert.equal(retryAfterBack.ok, false);
  assert.equal(retryAfterBack.error.code, "request_failed");

  // Meanwhile, the second request (not replied to while moved) expires normally!
  const expNotice = await waitFor(
    () => demo.events.find((event) => event.event === "agent_message" && event.kind === "notice" && event.request_id === expireId),
    () => `demo expired notice for second request: ${JSON.stringify(demo.events)}`,
  );
  assert.equal(expNotice.outcome, "expired");

  // Fence demo and assert movedId never got a second (expired) notice and no reply was posted.
  await fenceOwnerMessage(workspace, demo, "demo-channel", "fence-after-move-cases");
  assert.equal(
    demo.events.filter((event) => event.event === "agent_message" && event.kind === "notice" && event.request_id === movedId).length,
    1,
  );
  assert.equal((readState(workspace.stateDir).fixtures.discord.messages ?? []).length, 4);

  // 2. Sender project moved to another channel while exchange is open: replier's reply is request_failed and closes the exchange.
  const sentSenderMoves = await demo.request("agent_request", {
    target: "beta",
    text: "Sender will move before reply",
    timeout_minutes: 10,
    idempotency_key: "sender-move-req",
  });
  assert.equal(sentSenderMoves.ok, true, JSON.stringify(sentSenderMoves));
  const senderMoveId = sentSenderMoves.result.request_id;
  await waitFor(
    () => beta.events.some((event) => event.event === "agent_message" && event.request_id === senderMoveId),
    () => `beta sender-move request: ${JSON.stringify(beta.events)}`,
  );

  await afterReload(router, () => {
    const next = readRegistry(workspace);
    next.projects.demo.channel_id = "demo-channel-2";
    replaceFile(path.join(workspace.repoDir, "registry.json"), `${JSON.stringify(next, null, 2)}\n`);
  });
  await waitFor(
    () => demo.events.some((event) => event.event === "scope_changed" && event.scope?.channel_id === "demo-channel-2"),
    () => `demo scope_changed: ${JSON.stringify(demo.events)}`,
  );

  const replyWhenSenderMoved = await beta.request("agent_reply", {
    request_id: senderMoveId,
    text: "Replying after sender moved",
    idempotency_key: "sender-move-rep-1",
  });
  assert.equal(replyWhenSenderMoved.ok, false, JSON.stringify(replyWhenSenderMoved));
  assert.equal(replyWhenSenderMoved.error.code, "request_failed", JSON.stringify(replyWhenSenderMoved));

  // Verify no reply event reached moved demo and no reply message was posted.
  await fenceOwnerMessage(workspace, demo, "demo-channel-2", "fence-after-sender-move");
  assert.deepEqual(
    demo.events.filter((event) => event.event === "agent_message" && event.request_id === senderMoveId),
    [],
  );
  assert.equal((readState(workspace.stateDir).fixtures.discord.messages ?? []).length, 6);

  // 3. Sender project deregistered while exchange is open: replier's reply is request_failed and closes the exchange.
  const sentDereg = await demo.request("agent_request", {
    target: "beta",
    text: "Sender will be deregistered",
    timeout_minutes: 10,
    idempotency_key: "sender-dereg-req",
  });
  assert.equal(sentDereg.ok, true, JSON.stringify(sentDereg));
  const deregId = sentDereg.result.request_id;
  await waitFor(
    () => beta.events.some((event) => event.event === "agent_message" && event.request_id === deregId),
    () => `beta dereg request: ${JSON.stringify(beta.events)}`,
  );

  await afterReload(router, () => {
    const next = readRegistry(workspace);
    delete next.projects.demo;
    replaceFile(path.join(workspace.repoDir, "registry.json"), `${JSON.stringify(next, null, 2)}\n`);
  });
  await demo.closed;

  const replyWhenSenderDereg = await beta.request("agent_reply", {
    request_id: deregId,
    text: "Replying after sender deregistered",
    idempotency_key: "sender-dereg-rep-1",
  });
  assert.equal(replyWhenSenderDereg.ok, false, JSON.stringify(replyWhenSenderDereg));
  assert.equal(replyWhenSenderDereg.error.code, "request_failed", JSON.stringify(replyWhenSenderDereg));
});
