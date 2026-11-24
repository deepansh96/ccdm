import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import test from "node:test";

import { injectDiscordMessage, injectDiscordReaction } from "./support/bridge.js";
import { assertPrivate, replaceFile } from "./support/platform.js";
import {
  OWNER_ID,
  createRouterWorkspace,
  routerRegistry,
  routerSocketPath,
  routerWithWebhooks,
  runRouterCli,
  seedThreads,
  startRouter,
  waitFor,
  writeProjectKey,
  writeThreadKey,
} from "./support/router.js";
import { readState } from "./support/state.js";
import { cleanup, registerTeardownCallback } from "./support/teardown.js";

test.afterEach(cleanup);

async function rawClient(workspace, hello) {
  const socket = net.connect(routerSocketPath(workspace));
  registerTeardownCallback(() => socket.destroy());
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  const frames = [];
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.trim()) frames.push(JSON.parse(line));
    }
  });
  const closed = new Promise((resolve) => socket.once("close", resolve));
  const send = (frame) => socket.write(typeof frame === "string" ? frame : `${JSON.stringify(frame)}\n`);
  send({ type: "hello", v: 1, ...hello });
  const answer = await waitFor(
    () => frames.find((frame) => frame.type === "hello_ok" || frame.type === "hello_error"),
    () => `${hello.role} hello: ${JSON.stringify(frames)}`,
  );
  let requests = 0;
  return {
    frames,
    closed,
    send,
    close() {
      socket.destroy();
      return closed;
    },
    hello: answer,
    get events() { return frames.filter((frame) => frame.type === "event"); },
    async request(op, args = {}, timeoutMs = 5000) {
      const id = `request-${++requests}`;
      send({ type: "request", id, op, args });
      return waitFor(
        () => frames.find((frame) => frame.type === "response" && frame.id === id),
        () => `${op} response: ${JSON.stringify(frames)}`,
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

function connectAgentThread(workspace, project, threadId, key, provider = "claude", extra = {}) {
  return rawClient(workspace, {
    role: "thread",
    project,
    thread_id: threadId,
    provider,
    key,
    capabilities: ["agent_messages"],
    ...extra,
  });
}

async function restartRouter(workspace, router, { env = {} } = {}) {
  await router.stop();
  return startRouter(workspace, { env });
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

test("after a Router restart (and even two restarts in a row), a reply to an open request posts records, marks both request posts ✅, and reaches the sender once its same launch reconnects", async () => {
  const workspace = createRouterWorkspace(routerRegistry({
    demo: { channel_id: "demo-channel", type: "claude", transport: "router", agent_message_targets: ["beta"] },
    beta: { channel_id: "beta-channel", type: "codex", transport: "router" },
  }));
  let router = await routerWithWebhooks(workspace, ["demo", "beta"]);

  const demo1 = await connectAgentProject(workspace, "demo", "demo-key");
  const beta1 = await connectAgentProject(workspace, "beta", "beta-key");

  const sent = await demo1.request("agent_request", {
    target: "beta",
    text: "Check migration status",
    idempotency_key: "restart-open-req-1",
  });
  assert.equal(sent.ok, true, JSON.stringify(sent));
  const reqId = sent.result.request_id;

  const reqEvent = await waitFor(
    () => beta1.events.find((event) => event.event === "agent_message" && event.kind === "request" && event.request_id === reqId),
    () => `beta1 request: ${JSON.stringify(beta1.events)}`,
  );
  const ackReq = await beta1.request("agent_message_ack", { delivery_id: reqEvent.delivery_id });
  assert.equal(ackReq.ok, true, JSON.stringify(ackReq));

  await waitFor(
    () => (readState(workspace.stateDir).fixtures.discord.messages ?? []).length === 2,
    () => `two request records: ${JSON.stringify(readState(workspace.stateDir).fixtures.discord.messages)}`,
  );
  const requestMessages = readState(workspace.stateDir).fixtures.discord.messages;
  const senderReqMsg = requestMessages.find((m) => m.channelId === "demo-channel");
  const receiverReqMsg = requestMessages.find((m) => m.channelId === "beta-channel");
  assert.ok(senderReqMsg && receiverReqMsg);

  const ledgerFile = path.join(workspace.routerStateDir, "agent-messages.jsonl");
  assertPrivate(ledgerFile, "ledger file must be private before restart");

  // Restart the Router twice in a row (compaction must keep the open exchange).
  await demo1.close();
  await beta1.close();
  router = await restartRouter(workspace, router);
  assertPrivate(ledgerFile, "ledger file must stay private after first restart compaction");
  router = await restartRouter(workspace, router);
  assertPrivate(ledgerFile, "ledger file must stay private after second restart compaction");

  // Only beta reconnects first; beta replies while demo is still offline.
  const beta2 = await connectAgentProject(workspace, "beta", "beta-key");
  const replied = await beta2.request("agent_reply", {
    request_id: reqId,
    text: "Migration complete",
    idempotency_key: "restart-open-reply-1",
  });
  assert.equal(replied.ok, true, JSON.stringify(replied));
  assert.deepEqual(replied.result, { request_id: reqId, delivered_to_live_session: false });

  // Both reply records post and both original request posts get ✅.
  await waitFor(
    () => (readState(workspace.stateDir).fixtures.discord.messages ?? []).length === 4,
    () => `four total records: ${JSON.stringify(readState(workspace.stateDir).fixtures.discord.messages)}`,
  );
  const checkEmoji = encodeURIComponent("✅");
  await waitFor(
    () => (readState(workspace.stateDir).fixtures.discord.reactions ?? []).filter((r) => r.emoji === checkEmoji).length === 2,
    () => `two ✅ reactions: ${JSON.stringify(readState(workspace.stateDir).fixtures.discord.reactions)}`,
  );
  const reactions = readState(workspace.stateDir).fixtures.discord.reactions.filter((r) => r.emoji === checkEmoji);
  assert.deepEqual(
    reactions.map((r) => `${r.channelId}:${r.messageId}`).sort(),
    [`beta-channel:${receiverReqMsg.id}`, `demo-channel:${senderReqMsg.id}`],
  );

  // Once demo's same launch reconnects, it receives the reply with its own conversation's post set.
  const demo2 = await connectAgentProject(workspace, "demo", "demo-key");
  const replyEvent = await waitFor(
    () => demo2.events.find((event) => event.event === "agent_message" && event.kind === "reply" && event.request_id === reqId),
    () => `demo2 reply after restart: ${JSON.stringify(demo2.events)}`,
  );
  assert.equal(replyEvent.text, "Migration complete");
  assert.equal(replyEvent.from.project, "beta");
  assert.equal(replyEvent.post?.channel_id, "demo-channel");
  assert.ok(replyEvent.post?.message_id);

  // Because beta already acked the request before restart, beta2 did not get the request re-sent.
  await fenceOwnerMessage(workspace, beta2, "beta-channel", "fence-beta2-no-resend");
  assert.deepEqual(beta2.events.filter((event) => event.event === "agent_message"), []);
});

test("unacknowledged deliveries re-send to the same launch after a Router restart, acks survive restart, and a new launch gets nothing from before its hello", async () => {
  const workspace = createRouterWorkspace(routerRegistry({
    demo: { channel_id: "demo-channel", type: "claude", transport: "router", agent_message_targets: ["beta"] },
    beta: { channel_id: "beta-channel", type: "codex", transport: "router" },
  }));
  seedThreads(workspace, {
    "beta-thread-1": { type: 11, parentId: "beta-channel", name: "worker" },
  });
  writeThreadKey(workspace, "beta-thread-1", "thread-key-1");
  let router = await routerWithWebhooks(workspace, ["demo", "beta"]);

  const demo1 = await connectAgentProject(workspace, "demo", "demo-key");
  const beta1 = await connectAgentProject(workspace, "beta", "beta-key");
  const thread1 = await connectAgentThread(workspace, "beta", "beta-thread-1", "thread-key-1", "codex");
  assert.equal(thread1.hello.type, "hello_ok");

  // Send one request to beta channel (leave unacked) and one to beta thread (leave unacked).
  const reqChan = await demo1.request("agent_request", {
    target: "beta",
    text: "Channel request unacked across restart",
    idempotency_key: "unacked-chan-1",
  });
  assert.equal(reqChan.ok, true, JSON.stringify(reqChan));
  const reqChanId = reqChan.result.request_id;
  const betaFirstEvent = await waitFor(
    () => beta1.events.find((event) => event.event === "agent_message" && event.kind === "request" && event.request_id === reqChanId),
    () => `beta1 request: ${JSON.stringify(beta1.events)}`,
  );

  const reqThread = await demo1.request("agent_request", {
    target: "beta/beta-thread-1",
    text: "Thread request unacked across restart",
    idempotency_key: "unacked-thread-1",
  });
  assert.equal(reqThread.ok, true, JSON.stringify(reqThread));
  const reqThreadId = reqThread.result.request_id;
  const threadFirstEvent = await waitFor(
    () => thread1.events.find((event) => event.event === "agent_message" && event.kind === "request" && event.request_id === reqThreadId),
    () => `thread1 request: ${JSON.stringify(thread1.events)}`,
  );

  // Also send a second channel request, let beta reply while demo is disconnected (reply stays unacked across restart).
  const reqOfflineReply = await demo1.request("agent_request", {
    target: "beta",
    text: "Reply while offline before restart",
    idempotency_key: "unacked-reply-req-1",
  });
  assert.equal(reqOfflineReply.ok, true, JSON.stringify(reqOfflineReply));
  const reqOfflineReplyId = reqOfflineReply.result.request_id;
  const betaSecondEvent = await waitFor(
    () => beta1.events.find((event) => event.event === "agent_message" && event.kind === "request" && event.request_id === reqOfflineReplyId),
    () => `beta1 second request: ${JSON.stringify(beta1.events)}`,
  );
  assert.equal((await beta1.request("agent_message_ack", { delivery_id: betaSecondEvent.delivery_id })).ok, true);

  await demo1.close();
  await waitFor(
    async () => {
      const status = JSON.parse((await runRouterCli(workspace, ["status", "--json"])).stdout);
      return !status.sessions.some((s) => s.project === "demo" && s.role === "project");
    },
    () => "demo1 disconnect",
  );
  const replyOffline = await beta1.request("agent_reply", {
    request_id: reqOfflineReplyId,
    text: "Answer queued before Router restart",
    idempotency_key: "unacked-reply-1",
  });
  assert.equal(replyOffline.ok, true, JSON.stringify(replyOffline));
  assert.deepEqual(replyOffline.result, { request_id: reqOfflineReplyId, delivered_to_live_session: false });
  // Wait for reply records (6 request records + 2 reply records = 8) so the reply delivery is in the ledger.
  await waitFor(
    () => (readState(workspace.stateDir).fixtures.discord.messages ?? []).length === 8,
    () => `eight records before restart: ${JSON.stringify(readState(workspace.stateDir).fixtures.discord.messages)}`,
  );

  // Restart the Router.
  await beta1.close();
  await thread1.close();
  router = await restartRouter(workspace, router);

  // Same launch of beta reconnects -> receives the unacked channel request with the exact same delivery_id (and NOT the acked one).
  const beta2 = await connectAgentProject(workspace, "beta", "beta-key");
  const betaResent = await waitFor(
    () => beta2.events.find((event) => event.event === "agent_message" && event.request_id === reqChanId),
    () => `beta2 resent request: ${JSON.stringify(beta2.events)}`,
  );
  assert.equal(betaResent.delivery_id, betaFirstEvent.delivery_id);
  assert.deepEqual(betaResent, betaFirstEvent);
  await fenceOwnerMessage(workspace, beta2, "beta-channel", "fence-beta2-only-unacked");
  assert.equal(beta2.events.filter((event) => event.event === "agent_message").length, 1);

  // Ack beta's channel request, then rotate beta's key and restart -> neither same nor new launch gets it again.
  assert.equal((await beta2.request("agent_message_ack", { delivery_id: betaResent.delivery_id })).ok, true);

  // Same launch of thread reconnects -> receives the unacked thread request with the exact same delivery_id.
  const thread2 = await connectAgentThread(workspace, "beta", "beta-thread-1", "thread-key-1", "codex");
  const threadResent = await waitFor(
    () => thread2.events.find((event) => event.event === "agent_message" && event.request_id === reqThreadId),
    () => `thread2 resent request: ${JSON.stringify(thread2.events)}`,
  );
  assert.equal(threadResent.delivery_id, threadFirstEvent.delivery_id);
  assert.deepEqual(threadResent, threadFirstEvent);

  // Same launch of demo reconnects -> receives the pending reply from before the Router restart.
  const demoSame = await connectAgentProject(workspace, "demo", "demo-key");
  const demoReply = await waitFor(
    () => demoSame.events.find((event) => event.event === "agent_message" && event.kind === "reply" && event.request_id === reqOfflineReplyId),
    () => `demoSame pending reply after restart: ${JSON.stringify(demoSame.events)}`,
  );
  assert.equal(demoReply.text, "Answer queued before Router restart");
  assert.equal(demoReply.post?.channel_id, "demo-channel");

  // Do NOT ack demoReply or threadResent; restart Router again and connect NEW launches -> they receive nothing from before their hello.
  await beta2.close();
  await thread2.close();
  await demoSame.close();
  writeProjectKey(workspace, "demo", "demo-key-launch-2");
  writeThreadKey(workspace, "beta-thread-1", "thread-key-2");
  router = await restartRouter(workspace, router);

  const demoNew = await connectAgentProject(workspace, "demo", "demo-key-launch-2");
  const threadNew = await connectAgentThread(workspace, "beta", "beta-thread-1", "thread-key-2", "codex");
  const betaAfterAck = await connectAgentProject(workspace, "beta", "beta-key");

  await fenceOwnerMessage(workspace, demoNew, "demo-channel", "fence-demo-new-after-restart");
  await fenceOwnerMessage(workspace, threadNew, "beta-thread-1", "fence-thread-new-after-restart");
  await fenceOwnerMessage(workspace, betaAfterAck, "beta-channel", "fence-beta-after-ack-restart");

  assert.deepEqual(demoNew.events.filter((event) => event.event === "agent_message"), []);
  assert.deepEqual(threadNew.events.filter((event) => event.event === "agent_message"), []);
  assert.deepEqual(betaAfterAck.events.filter((event) => event.event === "agent_message"), []);

  // Even after the thread's new launch, the open thread request can still be answered.
  const threadReply = await threadNew.request("agent_reply", {
    request_id: reqThreadId,
    text: "Thread answered after two restarts",
    idempotency_key: "thread-reply-after-restart",
  });
  assert.equal(threadReply.ok, true, JSON.stringify(threadReply));
  assert.deepEqual(threadReply.result, { request_id: reqThreadId, delivered_to_live_session: false });
});

test("an overdue request expires at Router start with ⚠️ and an expired notice on reconnect, while one not yet due expires at its original expires_at", async () => {
  const workspace = createRouterWorkspace(routerRegistry({
    demo: { channel_id: "demo-channel", type: "claude", transport: "router", agent_message_targets: ["beta"] },
    beta: { channel_id: "beta-channel", type: "codex", transport: "router" },
  }));
  const env = { CCDM_ROUTER_AGENT_MESSAGE_MINUTE_MS: "200" };
  let router = await routerWithWebhooks(workspace, ["demo", "beta"], { env });

  const demo1 = await connectAgentProject(workspace, "demo", "demo-key");
  const beta1 = await connectAgentProject(workspace, "beta", "beta-key");

  // Short request (1 min = 200ms): will come due while the Router is down.
  const shortReq = await demo1.request("agent_request", {
    target: "beta",
    text: "Expire while Router is down",
    timeout_minutes: 1,
    idempotency_key: "expire-overdue-1",
  });
  assert.equal(shortReq.ok, true, JSON.stringify(shortReq));
  const shortId = shortReq.result.request_id;

  // Longer request (12 min = 2400ms): still open when Router comes back, expires at its original expires_at.
  const longReq = await demo1.request("agent_request", {
    target: "beta",
    text: "Expire after Router comes back",
    timeout_minutes: 12,
    idempotency_key: "expire-later-1",
  });
  assert.equal(longReq.ok, true, JSON.stringify(longReq));
  const longId = longReq.result.request_id;
  const longExpiresAtMs = Date.parse(longReq.result.expires_at);

  await waitFor(
    () => beta1.events.filter((event) => event.event === "agent_message" && event.kind === "request").length === 2,
    () => `beta1 two requests: ${JSON.stringify(beta1.events)}`,
  );
  await waitFor(
    () => (readState(workspace.stateDir).fixtures.discord.messages ?? []).length === 4,
    () => `four request records: ${JSON.stringify(readState(workspace.stateDir).fixtures.discord.messages)}`,
  );
  const allMsgs = readState(workspace.stateDir).fixtures.discord.messages;
  const shortMsgs = allMsgs.filter((m) => m.content.includes(shortId));
  const longMsgs = allMsgs.filter((m) => m.content.includes(longId));
  assert.equal(shortMsgs.length, 2);
  assert.equal(longMsgs.length, 2);
  const shortSenderMsg = shortMsgs.find((m) => m.channelId === "demo-channel");

  // Stop the Router and wait until shortReq is overdue while longReq is still well in the future.
  await demo1.close();
  await beta1.close();
  await router.stop();
  const waitUntilOverdue = Math.max(50, Date.parse(shortReq.result.expires_at) - Date.now() + 80);
  await new Promise((resolve) => setTimeout(resolve, waitUntilOverdue));

  // Start the Router back up.
  router = await startRouter(workspace, { env });

  // shortReq expires at start: both of its posts get ⚠️.
  const warnEmoji = encodeURIComponent("⚠️");
  await waitFor(
    () => (readState(workspace.stateDir).fixtures.discord.reactions ?? []).filter((r) => r.emoji === warnEmoji).length >= 2,
    () => `overdue ⚠️ reactions: ${JSON.stringify(readState(workspace.stateDir).fixtures.discord.reactions)}`,
  );
  const initialWarns = readState(workspace.stateDir).fixtures.discord.reactions.filter((r) => r.emoji === warnEmoji);
  assert.deepEqual(
    initialWarns.map((r) => `${r.channelId}:${r.messageId}`).sort(),
    shortMsgs.map((m) => `${m.channelId}:${m.id}`).sort(),
  );

  // When demo's same launch reconnects, it receives the expired notice for shortReq (and NOT yet for longReq).
  const demo2 = await connectAgentProject(workspace, "demo", "demo-key");
  const shortNotice = await waitFor(
    () => demo2.events.find((event) => event.event === "agent_message" && event.kind === "notice" && event.request_id === shortId),
    () => `demo2 overdue notice: ${JSON.stringify(demo2.events)}`,
  );
  assert.equal(shortNotice.outcome, "expired");
  assert.equal(shortNotice.target.project, "beta");
  assert.equal(shortNotice.target.conversation_id, "beta-channel");
  assert.deepEqual(shortNotice.post, { channel_id: "demo-channel", message_id: shortSenderMsg.id });

  // Late reply to shortReq is refused with request_expired.
  const beta2 = await connectAgentProject(workspace, "beta", "beta-key");
  const lateReply = await beta2.request("agent_reply", {
    request_id: shortId,
    text: "Too late",
    idempotency_key: "late-after-restart-1",
  });
  assert.equal(lateReply.ok, false);
  assert.equal(lateReply.error.code, "request_expired");

  // Confirm longReq has NOT expired early before its original expires_at.
  if (Date.now() < longExpiresAtMs - 150) {
    await fenceOwnerMessage(workspace, demo2, "demo-channel", "fence-long-not-expired-yet");
    assert.equal(
      demo2.events.some((event) => event.event === "agent_message" && event.kind === "notice" && event.request_id === longId),
      false,
    );
  }

  // Wait for longReq to expire at its original expires_at: both posts get ⚠️ and demo2 receives the expired notice.
  const longNotice = await waitFor(
    () => demo2.events.find((event) => event.event === "agent_message" && event.kind === "notice" && event.request_id === longId),
    () => `demo2 longReq expired notice: ${JSON.stringify(demo2.events)}`,
    8000,
  );
  assert.ok(Date.now() >= longExpiresAtMs - 50, "longReq should not expire before its original expires_at");
  assert.equal(longNotice.outcome, "expired");
  await waitFor(
    () => (readState(workspace.stateDir).fixtures.discord.reactions ?? []).filter((r) => r.emoji === warnEmoji).length === 4,
    () => `four ⚠️ reactions total: ${JSON.stringify(readState(workspace.stateDir).fixtures.discord.reactions)}`,
  );
  // Expiry posts no extra Discord message (still only the 4 original request records).
  assert.equal((readState(workspace.stateDir).fixtures.discord.messages ?? []).length, 4);
});

test("retried agent_request and agent_reply with the same key after a Router restart return the original result or refusal and post nothing new", async () => {
  const workspace = createRouterWorkspace({
    ...routerRegistry({
      demo: { channel_id: "demo-channel", type: "claude", transport: "router", agent_message_targets: ["beta"] },
      beta: { channel_id: "beta-channel", type: "codex", transport: "router" },
      gamma: { channel_id: "gamma-channel", type: "claude", transport: "router" },
    }),
    agent_message_limits: { requests_per_hour: 2, open_requests: 2 },
  });
  let router = await routerWithWebhooks(workspace, ["demo", "beta", "gamma"]);

  const demo1 = await connectAgentProject(workspace, "demo", "demo-key");
  const beta1 = await connectAgentProject(workspace, "beta", "beta-key");

  // 1. Accepted request before restart.
  const sent = await demo1.request("agent_request", {
    target: "beta",
    text: "Idempotent across restart",
    idempotency_key: "restart-idem-req-1",
  });
  assert.equal(sent.ok, true, JSON.stringify(sent));
  const reqId = sent.result.request_id;
  const reqEvent = await waitFor(
    () => beta1.events.find((event) => event.event === "agent_message" && event.kind === "request" && event.request_id === reqId),
    () => `beta1 reqEvent: ${JSON.stringify(beta1.events)}`,
  );
  assert.equal((await beta1.request("agent_message_ack", { delivery_id: reqEvent.delivery_id })).ok, true);

  // 2. Refused request (not_granted) before restart.
  const deniedBefore = await demo1.request("agent_request", {
    target: "gamma",
    text: "Ungranted before restart",
    idempotency_key: "restart-idem-refusal-1",
  });
  assert.equal(deniedBefore.ok, false);
  assert.equal(deniedBefore.error.code, "not_granted");

  // 3. Accepted reply while demo is disconnected (delivered_to_live_session: false), plus a refused reply.
  await demo1.close();
  await waitFor(
    async () => {
      const status = JSON.parse((await runRouterCli(workspace, ["status", "--json"])).stdout);
      return !status.sessions.some((s) => s.project === "demo" && s.role === "project");
    },
    () => "demo1 disconnect",
  );
  const replied = await beta1.request("agent_reply", {
    request_id: reqId,
    text: "Replied before restart",
    idempotency_key: "restart-idem-reply-1",
  });
  assert.equal(replied.ok, true, JSON.stringify(replied));
  assert.deepEqual(replied.result, { request_id: reqId, delivered_to_live_session: false });

  const unknownReplyBefore = await beta1.request("agent_reply", {
    request_id: "req-000000000000",
    text: "Missing",
    idempotency_key: "restart-idem-reply-refusal-1",
  });
  assert.equal(unknownReplyBefore.ok, false);
  assert.equal(unknownReplyBefore.error.code, "unknown_request");

  await waitFor(
    () => (readState(workspace.stateDir).fixtures.discord.messages ?? []).length === 4,
    () => `four records before restart: ${JSON.stringify(readState(workspace.stateDir).fixtures.discord.messages)}`,
  );

  // Grant demo -> gamma in registry before restart, then restart Router.
  await beta1.close();
  const regPath = path.join(workspace.repoDir, "registry.json");
  const reg = JSON.parse(fs.readFileSync(regPath, "utf8"));
  reg.projects.demo.agent_message_targets = ["beta", "gamma"];
  replaceFile(regPath, JSON.stringify(reg, null, 2));

  router = await restartRouter(workspace, router);

  const demo2 = await connectAgentProject(workspace, "demo", "demo-key");
  const beta2 = await connectAgentProject(workspace, "beta", "beta-key");
  const gamma2 = await connectAgentProject(workspace, "gamma", "gamma-key");

  // Drain the pending reply to demo2 and ack it.
  const demoReply = await waitFor(
    () => demo2.events.find((event) => event.event === "agent_message" && event.kind === "reply" && event.request_id === reqId),
    () => `demo2 reply after restart: ${JSON.stringify(demo2.events)}`,
  );
  assert.equal((await demo2.request("agent_message_ack", { delivery_id: demoReply.delivery_id })).ok, true);

  // Retrying the pre-restart request returns the exact original result and posts/delivers nothing new.
  const retryReq = await demo2.request("agent_request", {
    target: "beta",
    text: "Idempotent across restart",
    idempotency_key: "restart-idem-req-1",
  });
  assert.equal(retryReq.ok, true, JSON.stringify(retryReq));
  assert.deepEqual(retryReq.result, sent.result);

  // Retrying the pre-restart refusal returns not_granted even though gamma is now granted and live.
  const retryDenied = await demo2.request("agent_request", {
    target: "gamma",
    text: "Ungranted before restart",
    idempotency_key: "restart-idem-refusal-1",
  });
  assert.equal(retryDenied.ok, false);
  assert.equal(retryDenied.error.code, "not_granted");

  // Retrying the pre-restart reply returns the exact original result (delivered_to_live_session: false), not already_replied.
  const retryReply = await beta2.request("agent_reply", {
    request_id: reqId,
    text: "Replied before restart",
    idempotency_key: "restart-idem-reply-1",
  });
  assert.equal(retryReply.ok, true, JSON.stringify(retryReply));
  assert.deepEqual(retryReply.result, { request_id: reqId, delivered_to_live_session: false });

  // Retrying the pre-restart refused reply replays unknown_request.
  const retryUnknown = await beta2.request("agent_reply", {
    request_id: "req-000000000000",
    text: "Missing",
    idempotency_key: "restart-idem-reply-refusal-1",
  });
  assert.equal(retryUnknown.ok, false);
  assert.equal(retryUnknown.error.code, "unknown_request");

  // Confirm nothing new was posted or delivered.
  await fenceOwnerMessage(workspace, beta2, "beta-channel", "fence-idem-beta2");
  await fenceOwnerMessage(workspace, gamma2, "gamma-channel", "fence-idem-gamma2");
  await fenceOwnerMessage(workspace, demo2, "demo-channel", "fence-idem-demo2");
  assert.equal((readState(workspace.stateDir).fixtures.discord.messages ?? []).length, 4);
  assert.deepEqual(beta2.events.filter((event) => event.event === "agent_message"), []);
  assert.deepEqual(gamma2.events.filter((event) => event.event === "agent_message"), []);
  assert.equal(demo2.events.filter((event) => event.event === "agent_message").length, 1);
});

test("rate, open-request, and depth limits count exchanges and offline attempts from before a Router restart", async () => {
  const workspace = createRouterWorkspace({
    ...routerRegistry({
      alpha: { channel_id: "alpha-channel", type: "claude", transport: "router", agent_message_targets: ["beta", "offline"] },
      beta: { channel_id: "beta-channel", type: "codex", transport: "router", agent_message_targets: ["gamma"] },
      gamma: { channel_id: "gamma-channel", type: "claude", transport: "router", agent_message_targets: ["delta"] },
      delta: { channel_id: "delta-channel", type: "codex", transport: "router" },
      offline: { channel_id: "offline-channel", type: "claude", transport: "router" },
    }),
    agent_message_limits: {
      requests_per_hour: 2,
      open_requests: 2,
      depth: 2,
    },
  });
  const env = { CCDM_ROUTER_AGENT_MESSAGE_RATE_WINDOW_MS: "60000" };
  let router = await routerWithWebhooks(workspace, ["alpha", "beta", "gamma", "delta", "offline"], { env });

  const alpha1 = await connectAgentProject(workspace, "alpha", "alpha-key");
  const beta1 = await connectAgentProject(workspace, "beta", "beta-key");
  const gamma1 = await connectAgentProject(workspace, "gamma", "gamma-key");
  const delta1 = await connectAgentProject(workspace, "delta", "delta-key");

  // Rate test setup on alpha: 1 accepted request (alpha -> beta, depth 1) + 1 target_offline attempt (alpha -> offline) = 2/2.
  const ab = await alpha1.request("agent_request", {
    target: "beta",
    text: "Chain hop 1",
    idempotency_key: "lim-ab-1",
  });
  assert.equal(ab.ok, true, JSON.stringify(ab));
  assert.equal(ab.result.depth, 1);
  await waitFor(
    () => beta1.events.some((event) => event.event === "agent_message" && event.request_id === ab.result.request_id),
    () => "beta1 ab request",
  );

  const alphaOffline = await alpha1.request("agent_request", {
    target: "offline",
    text: "Counts toward rate",
    idempotency_key: "lim-alpha-offline-1",
  });
  assert.equal(alphaOffline.ok, false);
  assert.equal(alphaOffline.error.code, "target_offline");

  // Depth + open_requests setup on beta: 2 open requests from beta -> gamma (both depth 2 because beta holds ab at depth 1).
  const bg1 = await beta1.request("agent_request", {
    target: "gamma",
    text: "Chain hop 2a",
    idempotency_key: "lim-bg-1",
  });
  assert.equal(bg1.ok, true, JSON.stringify(bg1));
  assert.equal(bg1.result.depth, 2);

  const bg2 = await beta1.request("agent_request", {
    target: "gamma",
    text: "Chain hop 2b",
    idempotency_key: "lim-bg-2",
  });
  assert.equal(bg2.ok, true, JSON.stringify(bg2));
  assert.equal(bg2.result.depth, 2);

  await waitFor(
    () => gamma1.events.filter((event) => event.event === "agent_message" && event.kind === "request").length === 2,
    () => "gamma1 both requests",
  );

  // Restart Router (bump requests_per_hour to 5 for beta/gamma check only? No: keep 2 on alpha first!).
  await alpha1.close();
  await beta1.close();
  await gamma1.close();
  await delta1.close();
  router = await restartRouter(workspace, router, { env });

  const alpha2 = await connectAgentProject(workspace, "alpha", "alpha-key");
  const beta2 = await connectAgentProject(workspace, "beta", "beta-key");
  const gamma2 = await connectAgentProject(workspace, "gamma", "gamma-key");
  const delta2 = await connectAgentProject(workspace, "delta", "delta-key");

  // 1. Rate limit survived restart: alpha already used 2/2 (1 accepted + 1 target_offline).
  const alphaOverRate = await alpha2.request("agent_request", {
    target: "beta",
    text: "Should exceed rate after restart",
    idempotency_key: "lim-alpha-over-rate",
  });
  assert.equal(alphaOverRate.ok, false);
  assert.equal(alphaOverRate.error.code, "request_rate_exceeded");
  assert.match(alphaOverRate.error.message, /requests_per_hour.*2/);

  // 2. Depth limit survived restart: gamma holds open depth-2 requests, so gamma -> delta would be depth 3 > 2.
  const gammaOverDepth = await gamma2.request("agent_request", {
    target: "delta",
    text: "Should exceed depth after restart",
    idempotency_key: "lim-gamma-over-depth",
  });
  assert.equal(gammaOverDepth.ok, false);
  assert.equal(gammaOverDepth.error.code, "depth_exceeded");
  assert.match(gammaOverDepth.error.message, /depth.*2/);

  // 3. Raise requests_per_hour via registry reload so beta hits open_requests_exceeded (not rate) from its 2 pre-restart open requests.
  const regPath = path.join(workspace.repoDir, "registry.json");
  const reg = JSON.parse(fs.readFileSync(regPath, "utf8"));
  reg.agent_message_limits = { requests_per_hour: 10, open_requests: 2, depth: 2 };
  const reloads = () => router.stdout.split("registry reloaded").length - 1;
  const beforeReloads = reloads();
  replaceFile(regPath, JSON.stringify(reg, null, 2));
  await waitFor(() => reloads() > beforeReloads, () => `registry reload:\n${router.stdout}`);

  const betaOverOpen = await beta2.request("agent_request", {
    target: "gamma",
    text: "Should exceed open_requests after restart",
    idempotency_key: "lim-beta-over-open",
  });
  assert.equal(betaOverOpen.ok, false);
  assert.equal(betaOverOpen.error.code, "open_requests_exceeded");
  assert.match(betaOverOpen.error.message, /open_requests.*2/);

  // Answering both pre-restart requests to gamma frees beta's open slots AND drops gamma's depth back to 1.
  assert.equal((await gamma2.request("agent_reply", {
    request_id: bg1.result.request_id,
    text: "Done 1",
    idempotency_key: "lim-gamma-reply-1",
  })).ok, true);
  assert.equal((await gamma2.request("agent_reply", {
    request_id: bg2.result.request_id,
    text: "Done 2",
    idempotency_key: "lim-gamma-reply-2",
  })).ok, true);

  const gammaNowOk = await gamma2.request("agent_request", {
    target: "delta",
    text: "Depth is 1 now",
    idempotency_key: "lim-gamma-ok",
  });
  assert.equal(gammaNowOk.ok, true, JSON.stringify(gammaNowOk));
  assert.equal(gammaNowOk.result.depth, 1);
  assert.ok(delta2.hello.type === "hello_ok");
});

test("with a torn last line, the Router starts cleanly with earlier exchanges intact, and compaction drops closed exchanges older than 30 days while keeping recent ones, open exchanges, and pending deliveries", async () => {
  const workspace = createRouterWorkspace(routerRegistry({
    demo: { channel_id: "demo-channel", type: "claude", transport: "router", agent_message_targets: ["beta"] },
    beta: { channel_id: "beta-channel", type: "codex", transport: "router" },
  }));
  let router = await routerWithWebhooks(workspace, ["demo", "beta"]);

  const demo1 = await connectAgentProject(workspace, "demo", "demo-key");
  const beta1 = await connectAgentProject(workspace, "beta", "beta-key");

  const sent = await demo1.request("agent_request", {
    target: "beta",
    text: "Survive torn tail",
    idempotency_key: "torn-tail-req-1",
  });
  assert.equal(sent.ok, true, JSON.stringify(sent));
  const liveReqId = sent.result.request_id;
  await waitFor(
    () => beta1.events.some((event) => event.event === "agent_message" && event.request_id === liveReqId),
    () => "beta1 torn-tail request",
  );
  await waitFor(
    () => (readState(workspace.stateDir).fixtures.discord.messages ?? []).length === 2,
    () => "two records before torn tail",
  );

  await demo1.close();
  await beta1.close();
  await router.stop();

  // Append a torn final line (incomplete JSON, no trailing newline) to the real ledger.
  const ledgerFile = path.join(workspace.routerStateDir, "agent-messages.jsonl");
  fs.appendFileSync(ledgerFile, '{"v":1,"at":"2026-11-24T00:00:00.000Z","type":"request","request_id":"req-torn-crash');

  router = await startRouter(workspace);
  assertPrivate(ledgerFile, "compacted ledger stays private after torn-line recovery");

  const demo2 = await connectAgentProject(workspace, "demo", "demo-key");
  const beta2 = await connectAgentProject(workspace, "beta", "beta-key");

  // Earlier open exchange is intact and answerable.
  const replied = await beta2.request("agent_reply", {
    request_id: liveReqId,
    text: "Survived the torn line",
    idempotency_key: "torn-tail-reply-1",
  });
  assert.equal(replied.ok, true, JSON.stringify(replied));
  assert.deepEqual(replied.result, { request_id: liveReqId, delivered_to_live_session: true });

  const demoReply = await waitFor(
    () => demo2.events.find((event) => event.event === "agent_message" && event.kind === "reply" && event.request_id === liveReqId),
    () => `demo2 reply after torn line: ${JSON.stringify(demo2.events)}`,
  );
  assert.equal(demoReply.text, "Survived the torn line");

  // Now replace the ledger input with aged closed/recent/pending/open records to verify 30-day compaction retention.
  await demo2.close();
  await beta2.close();
  await router.stop();

  const now = Date.now();
  const oldAt = new Date(now - 31 * 24 * 60 * 60 * 1000).toISOString();
  const recentAt = new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString();
  const futureExpiry = new Date(now + 30 * 60 * 1000).toISOString();
  const demoFp = crypto.createHash("sha256").update("demo-key").digest("hex");
  const betaFp = crypto.createHash("sha256").update("beta-key").digest("hex");
  const demoConv = { project: "demo", provider: "claude", conversation_id: "demo-channel" };
  const betaConv = { project: "beta", provider: "codex", conversation_id: "beta-channel" };

  const seededLines = [
    // 1. 31-day-old closed exchange (acked) -> should be dropped by compaction.
    { v: 1, at: oldAt, type: "request", request_id: "req-oldclosed001", from: demoConv, to: betaConv, from_channel_id: "demo-channel", to_channel_id: "beta-channel", from_launch: demoFp, to_launch: betaFp, text: "old", depth: 1, expires_at: oldAt, idempotency_key: "old-closed-req" },
    { v: 1, at: oldAt, type: "reply", request_id: "req-oldclosed001", from: betaConv, to: demoConv, from_launch: betaFp, text: "old answer", idempotency_key: "old-closed-rep", delivered_to_live_session: true },
    { v: 1, at: oldAt, type: "delivery", delivery_id: "del-oldclosed001", kind: "reply", request_id: "req-oldclosed001", to: demoConv, to_launch: demoFp, from: betaConv, text: "old answer", ts: oldAt, post: null },
    { v: 1, at: oldAt, type: "ack", delivery_id: "del-oldclosed001", request_id: "req-oldclosed001", by: demoConv, by_launch: demoFp },
    // 2. 31-day-old refusal -> should be dropped by compaction.
    { v: 1, at: oldAt, type: "refusal", refusal_id: "ref-oldrefusal01", op: "agent_request", from: demoConv, to: null, target: "missing", code: "not_granted", message: "denied", from_launch: demoFp, idempotency_key: "old-refusal" },
    // 3. 2-day-old closed exchange -> should be kept by compaction.
    { v: 1, at: recentAt, type: "request", request_id: "req-recentcls001", from: demoConv, to: betaConv, from_channel_id: "demo-channel", to_channel_id: "beta-channel", from_launch: demoFp, to_launch: betaFp, text: "recent", depth: 1, expires_at: recentAt, idempotency_key: "recent-closed-req" },
    { v: 1, at: recentAt, type: "reply", request_id: "req-recentcls001", from: betaConv, to: demoConv, from_launch: betaFp, text: "recent answer", idempotency_key: "recent-closed-rep", delivered_to_live_session: true },
    // 4. 31-day-old closed exchange WITH an unacked pending delivery -> pending delivery MUST be kept.
    { v: 1, at: oldAt, type: "request", request_id: "req-oldpending01", from: demoConv, to: betaConv, from_channel_id: "demo-channel", to_channel_id: "beta-channel", from_launch: demoFp, to_launch: betaFp, text: "old pending", depth: 1, expires_at: oldAt, idempotency_key: "old-pending-req" },
    { v: 1, at: oldAt, type: "reply", request_id: "req-oldpending01", from: betaConv, to: demoConv, from_launch: betaFp, text: "old pending answer", idempotency_key: "old-pending-rep", delivered_to_live_session: false },
    { v: 1, at: oldAt, type: "delivery", delivery_id: "del-oldpending01", kind: "reply", request_id: "req-oldpending01", to: demoConv, to_launch: demoFp, from: betaConv, text: "old pending answer", ts: oldAt, post: null },
    // 5. Open exchange -> MUST be kept across restarts.
    { v: 1, at: recentAt, type: "request", request_id: "req-stillopen001", from: demoConv, to: betaConv, from_channel_id: "demo-channel", to_channel_id: "beta-channel", from_launch: demoFp, to_launch: betaFp, text: "still open", depth: 1, expires_at: futureExpiry, idempotency_key: "still-open-req" },
  ];
  fs.writeFileSync(ledgerFile, `${seededLines.map((line) => JSON.stringify(line)).join("\n")}\n`, { mode: 0o600 });

  // Restart twice to verify compaction output is itself valid and preserves everything required.
  router = await startRouter(workspace);
  router = await restartRouter(workspace, router);

  const demo3 = await connectAgentProject(workspace, "demo", "demo-key");
  const beta3 = await connectAgentProject(workspace, "beta", "beta-key");

  // 31-day-old closed exchange was dropped -> unknown_request.
  const oldClosedReply = await beta3.request("agent_reply", {
    request_id: "req-oldclosed001",
    text: "late",
    idempotency_key: "check-old-closed",
  });
  assert.equal(oldClosedReply.ok, false);
  assert.equal(oldClosedReply.error.code, "unknown_request");

  // 2-day-old closed exchange was kept -> already_replied.
  const recentClosedReply = await beta3.request("agent_reply", {
    request_id: "req-recentcls001",
    text: "late",
    idempotency_key: "check-recent-closed",
  });
  assert.equal(recentClosedReply.ok, false);
  assert.equal(recentClosedReply.error.code, "already_replied");

  // 31-day-old pending delivery was kept -> delivered to demo's same launch.
  const pendingOld = await waitFor(
    () => demo3.events.find((event) => event.event === "agent_message" && event.delivery_id === "del-oldpending01"),
    () => `demo3 old pending delivery: ${JSON.stringify(demo3.events)}`,
  );
  assert.equal(pendingOld.text, "old pending answer");

  // Open exchange was kept -> answerable.
  const openReply = await beta3.request("agent_reply", {
    request_id: "req-stillopen001",
    text: "Answered after compaction",
    idempotency_key: "check-still-open",
  });
  assert.equal(openReply.ok, true, JSON.stringify(openReply));
  assert.deepEqual(openReply.result, { request_id: "req-stillopen001", delivered_to_live_session: true });
});

test("with an unreadable ledger, agent_request and agent_reply return ledger_unavailable after argument checks while ordinary routing and registry reload keep working, and moving the file aside + restarting recovers", async () => {
  const workspace = createRouterWorkspace(routerRegistry({
    demo: { channel_id: "demo-channel", type: "claude", transport: "router", agent_message_targets: ["beta"], guest_user_ids: [] },
    beta: { channel_id: "beta-channel", type: "codex", transport: "router" },
  }));
  let router = await routerWithWebhooks(workspace, ["demo", "beta"], {
    env: { CCDM_ROUTER_REGISTRY_DEBOUNCE_MS: "50" },
  });
  await router.stop();

  // Write an unreadable (corrupt complete line) ledger before starting.
  const ledgerFile = path.join(workspace.routerStateDir, "agent-messages.jsonl");
  fs.writeFileSync(ledgerFile, "not valid json\n", { mode: 0o600 });

  router = await startRouter(workspace, { env: { CCDM_ROUTER_REGISTRY_DEBOUNCE_MS: "50" } });

  const demo = await connectAgentProject(workspace, "demo", "demo-key");
  const beta = await connectAgentProject(workspace, "beta", "beta-key");

  // Argument shape is checked BEFORE ledger_unavailable.
  const badReqArgs = await demo.request("agent_request", {
    target: "beta",
    text: "",
    idempotency_key: "bad-args-1",
  });
  assert.equal(badReqArgs.ok, false);
  assert.equal(badReqArgs.error.code, "invalid_args");

  const badReplyArgs = await beta.request("agent_reply", {
    request_id: "req-1234567890ab",
    text: "",
    idempotency_key: "bad-reply-args-1",
  });
  assert.equal(badReplyArgs.ok, false);
  assert.equal(badReplyArgs.error.code, "invalid_args");

  // Valid arguments get ledger_unavailable right after argument shape (even for ungranted target or unknown request) and post nothing.
  const ungrantedWhileDamaged = await demo.request("agent_request", {
    target: "does-not-exist",
    text: "Should report ledger_unavailable not not_granted",
    idempotency_key: "damaged-req-ungranted",
  });
  assert.equal(ungrantedWhileDamaged.ok, false);
  assert.equal(ungrantedWhileDamaged.error.code, "ledger_unavailable");

  const grantedWhileDamaged = await demo.request("agent_request", {
    target: "beta",
    text: "Should report ledger_unavailable",
    idempotency_key: "damaged-req-granted",
  });
  assert.equal(grantedWhileDamaged.ok, false);
  assert.equal(grantedWhileDamaged.error.code, "ledger_unavailable");

  const replyWhileDamaged = await beta.request("agent_reply", {
    request_id: "req-1234567890ab",
    text: "Should report ledger_unavailable not unknown_request",
    idempotency_key: "damaged-reply-1",
  });
  assert.equal(replyWhileDamaged.ok, false);
  assert.equal(replyWhileDamaged.error.code, "ledger_unavailable");

  // Ordinary owner message still routes.
  injectDiscordMessage(workspace, {
    id: "owner-msg-damaged",
    channelId: "demo-channel",
    content: "ordinary owner message",
    author: { id: OWNER_ID, username: "Owner" },
  });
  await waitFor(
    () => demo.events.some((event) => event.event === "message" && event.message_id === "owner-msg-damaged"),
    () => `owner message while ledger damaged: ${JSON.stringify(demo.events)}`,
  );

  // Ordinary project reply still posts through the webhook.
  const normalReply = await demo.request("reply", {
    channel_id: "demo-channel",
    text: "ordinary reply works",
  });
  assert.equal(normalReply.ok, true, JSON.stringify(normalReply));
  await waitFor(
    () => (readState(workspace.stateDir).fixtures.discord.messages ?? []).some((m) => m.content === "ordinary reply works"),
    () => `ordinary reply recorded: ${JSON.stringify(readState(workspace.stateDir).fixtures.discord.messages)}`,
  );

  // Ordinary owner reaction still routes.
  injectDiscordReaction(workspace, {
    id: "react-damaged-1",
    channelId: "demo-channel",
    messageId: normalReply.result.message_id,
    emoji: "👍",
    user: { id: OWNER_ID, username: "Owner" },
  });
  await waitFor(
    () => demo.events.some((event) => event.event === "reaction" && event.message_id === normalReply.result.message_id),
    () => `owner reaction while ledger damaged: ${JSON.stringify(demo.events)}`,
  );

  // Registry reload still works (adding a guest lets that guest's message through).
  const regPath = path.join(workspace.repoDir, "registry.json");
  const reg = JSON.parse(fs.readFileSync(regPath, "utf8"));
  reg.projects.demo.guest_user_ids = ["new-guest-id"];
  const reloads = () => router.stdout.split("registry reloaded").length - 1;
  const beforeReloads = reloads();
  replaceFile(regPath, JSON.stringify(reg, null, 2));
  await waitFor(() => reloads() > beforeReloads, () => `registry reload while ledger damaged:\n${router.stdout}`);

  injectDiscordMessage(workspace, {
    id: "guest-msg-after-reload",
    channelId: "demo-channel",
    content: "guest after reload",
    author: { id: "new-guest-id", username: "Guest" },
  });
  await waitFor(
    () => demo.events.some((event) => event.event === "message" && event.message_id === "guest-msg-after-reload"),
    () => `guest message after reload: ${JSON.stringify(demo.events)}`,
  );

  // No Agent Message records were posted while the ledger was unreadable (only the one ordinary reply).
  assert.equal((readState(workspace.stateDir).fixtures.discord.messages ?? []).length, 1);

  // Also check a corrupt middle line and unsupported schema version mark the ledger unavailable.
  await demo.close();
  await beta.close();
  await router.stop();
  fs.writeFileSync(ledgerFile, '{"v":99,"at":"2026-11-24T00:00:00.000Z","type":"expired","request_id":"req-1"}\n', { mode: 0o600 });
  router = await startRouter(workspace);
  const demoBadVer = await connectAgentProject(workspace, "demo", "demo-key");
  const badVerReq = await demoBadVer.request("agent_request", {
    target: "beta",
    text: "Bad version ledger",
    idempotency_key: "bad-ver-1",
  });
  assert.equal(badVerReq.ok, false);
  assert.equal(badVerReq.error.code, "ledger_unavailable");

  // Recovery: move the damaged ledger file aside and restart the Router -> sends work again.
  await demoBadVer.close();
  await router.stop();
  fs.renameSync(ledgerFile, `${ledgerFile}.damaged`);

  router = await startRouter(workspace);
  const demoRec = await connectAgentProject(workspace, "demo", "demo-key");
  const betaRec = await connectAgentProject(workspace, "beta", "beta-key");

  const recoveredSend = await demoRec.request("agent_request", {
    target: "beta",
    text: "Recovered after moving damaged ledger aside",
    idempotency_key: "recovered-req-1",
  });
  assert.equal(recoveredSend.ok, true, JSON.stringify(recoveredSend));
  const reqEvent = await waitFor(
    () => betaRec.events.find((event) => event.event === "agent_message" && event.request_id === recoveredSend.result.request_id),
    () => `betaRec recovered request: ${JSON.stringify(betaRec.events)}`,
  );
  assert.equal(reqEvent.text, "Recovered after moving damaged ledger aside");
  assertPrivate(ledgerFile, "newly created ledger file after recovery is private");
});
