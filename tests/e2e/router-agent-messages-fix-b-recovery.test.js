// Review finding 3 (Worker B): an accepted Agent Request or Agent Reply must
// never lose its records, outcome marks, or delivery across a Router restart
// or a failed post-acceptance ledger append.
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import test from "node:test";

import { injectDiscordMessage } from "./support/bridge.js";
import {
  OWNER_ID,
  createRouterWorkspace,
  killRouter,
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
import { runScript } from "./support/runner.js";
import { readState, updateState } from "./support/state.js";
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

function webhookExecutePath(workspace, channelId) {
  const webhook = (readState(workspace.stateDir).fixtures.discord.webhooks ?? [])
    .find((entry) => entry.channel_id === channelId);
  assert.ok(webhook, `missing webhook for ${channelId}`);
  return `/api/v10/webhooks/${webhook.id}/${webhook.token}`;
}

function holdDiscordPath(workspace, { method = "POST", apiPath, retryAfter = 10 }) {
  updateState(workspace.stateDir, (state) => {
    state.fixtures.discord.rateLimits = [
      { method, path: apiPath, count: 1, retryAfter },
    ];
    state.fixtures.discord.rateLimitHits = [];
  });
}

function clearDiscordHolds(workspace) {
  updateState(workspace.stateDir, (state) => {
    state.fixtures.discord.rateLimits = [];
    state.fixtures.discord.rateLimitHits = [];
  });
}

async function waitForHoldHit(workspace, apiPath) {
  await waitFor(
    () => (readState(workspace.stateDir).fixtures.discord.rateLimitHits ?? []).some((hit) => hit.path === apiPath),
    () => `rateLimitHit for ${apiPath}: ${JSON.stringify(readState(workspace.stateDir).fixtures.discord.rateLimitHits)}`,
  );
}

async function crashAndRestartRouter(workspace, router, { env = {} } = {}) {
  killRouter(router);
  await router.closed;
  clearDiscordHolds(workspace);
  return startRouter(workspace, { env });
}

test("reply side: Router killed after agent_reply succeeds but before records or delivery finishes posts both reply records once, marks both request posts ✅, and delivers the reply once on same-launch reconnect", async () => {
  const workspace = createRouterWorkspace(routerRegistry({
    demo: { channel_id: "demo-channel", type: "claude", transport: "router", agent_message_targets: ["beta"] },
    beta: { channel_id: "beta-channel", type: "codex", transport: "router" },
  }));
  let router = await routerWithWebhooks(workspace, ["demo", "beta"]);

  const demo1 = await connectAgentProject(workspace, "demo", "demo-key");
  const beta1 = await connectAgentProject(workspace, "beta", "beta-key");

  // Open a request and let beta receive + ack it.
  const sent = await demo1.request("agent_request", {
    target: "beta",
    text: "Run diagnostics",
    idempotency_key: "fixb-reply-req-1",
  });
  assert.equal(sent.ok, true, JSON.stringify(sent));
  const reqId = sent.result.request_id;
  const reqEvent = await waitFor(
    () => beta1.events.find((e) => e.event === "agent_message" && e.kind === "request" && e.request_id === reqId),
    () => `beta1 request: ${JSON.stringify(beta1.events)}`,
  );
  assert.equal((await beta1.request("agent_message_ack", { delivery_id: reqEvent.delivery_id })).ok, true);
  await waitFor(
    () => (readState(workspace.stateDir).fixtures.discord.messages ?? []).length === 2,
    () => `two request records`,
  );
  const requestMsgs = readState(workspace.stateDir).fixtures.discord.messages;
  const senderReqMsg = requestMsgs.find((m) => m.channelId === "demo-channel");
  const receiverReqMsg = requestMsgs.find((m) => m.channelId === "beta-channel");

  // Hold beta's webhook execute so publishReply blocks BEFORE posting anything.
  const betaWebhookPath = webhookExecutePath(workspace, "beta-channel");
  holdDiscordPath(workspace, { method: "POST", apiPath: betaWebhookPath });

  const replied = await beta1.request("agent_reply", {
    request_id: reqId,
    text: "Diagnostics green",
    idempotency_key: "fixb-reply-1",
  });
  assert.equal(replied.ok, true, JSON.stringify(replied));
  assert.deepEqual(replied.result, { request_id: reqId, delivered_to_live_session: true });

  // Wait until publishReply hits the hold, confirm no reply post or delivery happened yet, then kill Router.
  await waitForHoldHit(workspace, betaWebhookPath);
  assert.equal((readState(workspace.stateDir).fixtures.discord.messages ?? []).length, 2);
  assert.equal(demo1.events.some((e) => e.event === "agent_message" && e.kind === "reply"), false);

  await demo1.close();
  await beta1.close();
  router = await crashAndRestartRouter(workspace, router);

  // Reconnect A's same launch: receives reply once with post set.
  const demo2 = await connectAgentProject(workspace, "demo", "demo-key");
  const replyEvent = await waitFor(
    () => demo2.events.find((e) => e.event === "agent_message" && e.kind === "reply" && e.request_id === reqId),
    () => `demo2 reply after crash: ${JSON.stringify(demo2.events)}`,
  );
  assert.equal(replyEvent.text, "Diagnostics green");
  assert.equal(replyEvent.from.project, "beta");
  assert.equal(replyEvent.post?.channel_id, "demo-channel");
  assert.ok(replyEvent.post?.message_id);
  assert.equal((await demo2.request("agent_message_ack", { delivery_id: replyEvent.delivery_id })).ok, true);

  // Both reply records posted exactly once (4 total messages: 2 request + 2 reply) and linked.
  await waitFor(
    () => (readState(workspace.stateDir).fixtures.discord.messages ?? []).length === 4,
    () => `four records after recovery: ${JSON.stringify(readState(workspace.stateDir).fixtures.discord.messages)}`,
  );
  const allMsgs = readState(workspace.stateDir).fixtures.discord.messages;
  const replyMsgs = allMsgs.slice(2);
  const betaReplyMsg = replyMsgs.find((m) => m.channelId === "beta-channel");
  const demoReplyMsg = replyMsgs.find((m) => m.channelId === "demo-channel");
  assert.ok(betaReplyMsg && demoReplyMsg, JSON.stringify(replyMsgs));
  assert.match(betaReplyMsg.content, /\[counterpart\]\(https:\/\/discord\.com\/channels\/guild-id\/demo-channel\//);
  assert.match(demoReplyMsg.content, /\[counterpart\]\(https:\/\/discord\.com\/channels\/guild-id\/beta-channel\//);
  assert.equal(replyEvent.post.message_id, demoReplyMsg.id);

  // Both original request posts carry ✅ exactly once.
  const checkEmoji = encodeURIComponent("✅");
  await waitFor(
    () => (readState(workspace.stateDir).fixtures.discord.reactions ?? []).filter((r) => r.emoji === checkEmoji).length === 2,
    () => `two ✅ marks: ${JSON.stringify(readState(workspace.stateDir).fixtures.discord.reactions)}`,
  );
  const checks = readState(workspace.stateDir).fixtures.discord.reactions.filter((r) => r.emoji === checkEmoji);
  assert.deepEqual(
    checks.map((r) => `${r.channelId}:${r.messageId}`).sort(),
    [`beta-channel:${receiverReqMsg.id}`, `demo-channel:${senderReqMsg.id}`],
  );

  // Fence to confirm no duplicate delivery or duplicate posts.
  await fenceOwnerMessage(workspace, demo2, "demo-channel", "fence-fixb-reply-once");
  assert.equal(demo2.events.filter((e) => e.event === "agent_message").length, 1);
  assert.equal((readState(workspace.stateDir).fixtures.discord.messages ?? []).length, 4);

  // Also verify `scripts/ccdm agent-messages log` reads the ledger cleanly.
  await demo2.close();
  await router.stop();
  const logResult = await runScript(workspace, "scripts/ccdm", {
    args: ["agent-messages", "log", "--json"],
    env: { CCDM_ROUTER_STATE_DIR: workspace.routerStateDir },
    timeoutMs: 20000,
  });
  assert.equal(logResult.exitCode, 0, `${logResult.stderr}\n${logResult.stdout}`);
  const entries = JSON.parse(logResult.stdout);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].request_id, reqId);
  assert.equal(entries[0].outcome, "replied");
});

test("request side: Router killed after agent_request returns a request ID but before posting or delivering posts both records once and delivers once to target's same launch", async () => {
  const workspace = createRouterWorkspace(routerRegistry({
    demo: { channel_id: "demo-channel", type: "claude", transport: "router", agent_message_targets: ["beta"] },
    beta: { channel_id: "beta-channel", type: "codex", transport: "router" },
  }));
  let router = await routerWithWebhooks(workspace, ["demo", "beta"]);

  const demo1 = await connectAgentProject(workspace, "demo", "demo-key");
  const beta1 = await connectAgentProject(workspace, "beta", "beta-key");

  // Hold demo's webhook execute so publishRequest blocks BEFORE posting sender record.
  const demoWebhookPath = webhookExecutePath(workspace, "demo-channel");
  holdDiscordPath(workspace, { method: "POST", apiPath: demoWebhookPath });

  const sent = await demo1.request("agent_request", {
    target: "beta",
    text: "Deploy checklist ready?",
    idempotency_key: "fixb-req-1",
  });
  assert.equal(sent.ok, true, JSON.stringify(sent));
  const reqId = sent.result.request_id;

  await waitForHoldHit(workspace, demoWebhookPath);
  assert.equal((readState(workspace.stateDir).fixtures.discord.messages ?? []).length, 0);
  assert.equal(beta1.events.some((e) => e.event === "agent_message"), false);

  await demo1.close();
  await beta1.close();
  router = await crashAndRestartRouter(workspace, router);

  // Target's same launch reconnects -> receives the request once with receiver post set.
  const beta2 = await connectAgentProject(workspace, "beta", "beta-key");
  const reqEvent = await waitFor(
    () => beta2.events.find((e) => e.event === "agent_message" && e.kind === "request" && e.request_id === reqId),
    () => `beta2 recovered request: ${JSON.stringify(beta2.events)}`,
  );
  assert.equal(reqEvent.text, "Deploy checklist ready?");
  assert.equal(reqEvent.from.project, "demo");
  assert.equal(reqEvent.post?.channel_id, "beta-channel");
  assert.ok(reqEvent.post?.message_id);
  assert.equal((await beta2.request("agent_message_ack", { delivery_id: reqEvent.delivery_id })).ok, true);

  // Both request records posted once and linked.
  await waitFor(
    () => (readState(workspace.stateDir).fixtures.discord.messages ?? []).length === 2,
    () => `two request records after crash: ${JSON.stringify(readState(workspace.stateDir).fixtures.discord.messages)}`,
  );
  const msgs = readState(workspace.stateDir).fixtures.discord.messages;
  const senderMsg = msgs.find((m) => m.channelId === "demo-channel");
  const receiverMsg = msgs.find((m) => m.channelId === "beta-channel");
  assert.ok(senderMsg && receiverMsg, JSON.stringify(msgs));
  assert.equal(reqEvent.post.message_id, receiverMsg.id);
  assert.match(senderMsg.content, /\[counterpart\]\(https:\/\/discord\.com\/channels\/guild-id\/beta-channel\//);
  assert.match(receiverMsg.content, /\[counterpart\]\(https:\/\/discord\.com\/channels\/guild-id\/demo-channel\//);

  // Fence: no duplicate request delivery or posts.
  await fenceOwnerMessage(workspace, beta2, "beta-channel", "fence-fixb-req-once");
  assert.equal(beta2.events.filter((e) => e.event === "agent_message").length, 1);
  assert.equal((readState(workspace.stateDir).fixtures.discord.messages ?? []).length, 2);

  // Beta can reply to the recovered request and demo receives it.
  const demo2 = await connectAgentProject(workspace, "demo", "demo-key");
  const replied = await beta2.request("agent_reply", {
    request_id: reqId,
    text: "Checklist approved",
    idempotency_key: "fixb-req-reply-1",
  });
  assert.equal(replied.ok, true, JSON.stringify(replied));
  const replyEvent = await waitFor(
    () => demo2.events.find((e) => e.event === "agent_message" && e.kind === "reply" && e.request_id === reqId),
    () => `demo2 reply to recovered request: ${JSON.stringify(demo2.events)}`,
  );
  assert.equal(replyEvent.text, "Checklist approved");
});

test("records fully posted before the restart are never posted a second time (both request and reply mid-publish crashes)", async () => {
  const workspace = createRouterWorkspace(routerRegistry({
    demo: { channel_id: "demo-channel", type: "claude", transport: "router", agent_message_targets: ["beta"] },
    beta: { channel_id: "beta-channel", type: "codex", transport: "router" },
  }));
  let router = await routerWithWebhooks(workspace, ["demo", "beta"]);

  const demo1 = await connectAgentProject(workspace, "demo", "demo-key");
  const beta1 = await connectAgentProject(workspace, "beta", "beta-key");

  // 1. Request side: let sender record post, hold receiver bot post, then kill Router.
  const betaBotPath = "/api/v10/channels/beta-channel/messages";
  holdDiscordPath(workspace, { method: "POST", apiPath: betaBotPath });

  const sent = await demo1.request("agent_request", {
    target: "beta",
    text: "Partial request publish",
    idempotency_key: "fixb-partial-req-1",
  });
  assert.equal(sent.ok, true, JSON.stringify(sent));
  const reqId = sent.result.request_id;

  await waitForHoldHit(workspace, betaBotPath);
  // Sender post succeeded (1 message in demo-channel), receiver post not yet sent.
  const msgsBeforeReqKill = readState(workspace.stateDir).fixtures.discord.messages ?? [];
  assert.equal(msgsBeforeReqKill.length, 1);
  assert.equal(msgsBeforeReqKill[0].channelId, "demo-channel");
  const originalSenderReqId = msgsBeforeReqKill[0].id;

  await demo1.close();
  await beta1.close();
  router = await crashAndRestartRouter(workspace, router);

  const beta2 = await connectAgentProject(workspace, "beta", "beta-key");
  const reqEvent = await waitFor(
    () => beta2.events.find((e) => e.event === "agent_message" && e.kind === "request" && e.request_id === reqId),
    () => `beta2 partial req recovery: ${JSON.stringify(beta2.events)}`,
  );
  assert.equal((await beta2.request("agent_message_ack", { delivery_id: reqEvent.delivery_id })).ok, true);

  // Total messages must be EXACTLY 2 (original sender post was NOT reposted; it WAS link-edited).
  const msgsAfterReqRecovery = readState(workspace.stateDir).fixtures.discord.messages ?? [];
  assert.equal(msgsAfterReqRecovery.length, 2, JSON.stringify(msgsAfterReqRecovery));
  const demoReqPost = msgsAfterReqRecovery.find((m) => m.channelId === "demo-channel");
  const betaReqPost = msgsAfterReqRecovery.find((m) => m.channelId === "beta-channel");
  assert.equal(demoReqPost.id, originalSenderReqId);
  assert.match(demoReqPost.content, new RegExp(`\\[counterpart\\]\\(https://discord\\.com/channels/guild-id/beta-channel/${betaReqPost.id}\\)`));

  // 2. Reply side (crash #1 between replier post and receiver post; crash #2 after both reply posts and 1st ✅ mark).
  const demo2 = await connectAgentProject(workspace, "demo", "demo-key");
  const demoBotPath = "/api/v10/channels/demo-channel/messages";
  holdDiscordPath(workspace, { method: "POST", apiPath: demoBotPath });

  const replied = await beta2.request("agent_reply", {
    request_id: reqId,
    text: "Partial reply publish",
    idempotency_key: "fixb-partial-reply-1",
  });
  assert.equal(replied.ok, true, JSON.stringify(replied));

  await waitForHoldHit(workspace, demoBotPath);
  // Replier reply record posted (total 3 messages), receiver reply record held.
  const msgsBeforeReplyKill1 = readState(workspace.stateDir).fixtures.discord.messages ?? [];
  assert.equal(msgsBeforeReplyKill1.length, 3);
  const originalReplierMsgId = msgsBeforeReplyKill1[2].id;
  assert.equal(msgsBeforeReplyKill1[2].channelId, "beta-channel");

  await demo2.close();
  await beta2.close();
  // Hold the 2nd ✅ mark BEFORE restarting so crash #2 hits right after receiver reply post + link edit + 1st ✅ mark!
  const checkEmoji = encodeURIComponent("✅");
  const secondMarkPath = `/api/v10/channels/beta-channel/messages/${betaReqPost.id}/reactions/${checkEmoji}/@me`;
  killRouter(router);
  await router.closed;
  holdDiscordPath(workspace, { method: "PUT", apiPath: secondMarkPath });
  router = await startRouter(workspace);

  await waitForHoldHit(workspace, secondMarkPath);
  // Replier post was NOT reposted (total 4 messages: 2 req + 2 reply), and 1st ✅ mark succeeded.
  const msgsBeforeReplyKill2 = readState(workspace.stateDir).fixtures.discord.messages ?? [];
  assert.equal(msgsBeforeReplyKill2.length, 4, JSON.stringify(msgsBeforeReplyKill2));
  assert.equal(msgsBeforeReplyKill2[2].id, originalReplierMsgId);
  assert.match(
    msgsBeforeReplyKill2[2].content,
    new RegExp(`\\[counterpart\\]\\(https://discord\\.com/channels/guild-id/demo-channel/${msgsBeforeReplyKill2[3].id}\\)`),
  );
  assert.equal(
    (readState(workspace.stateDir).fixtures.discord.reactions ?? []).filter((r) => r.emoji === checkEmoji).length,
    1,
  );

  // Crash #2 and restart with no holds -> neither reply record is reposted, 2nd ✅ mark added, reply delivered once!
  router = await crashAndRestartRouter(workspace, router);

  const demo3 = await connectAgentProject(workspace, "demo", "demo-key");
  const replyEvent = await waitFor(
    () => demo3.events.find((e) => e.event === "agent_message" && e.kind === "reply" && e.request_id === reqId),
    () => `demo3 partial reply recovery: ${JSON.stringify(demo3.events)}`,
  );
  assert.equal(replyEvent.text, "Partial reply publish");
  assert.equal(replyEvent.post?.channel_id, "demo-channel");
  assert.equal(replyEvent.post?.message_id, msgsBeforeReplyKill2[3].id);

  await fenceOwnerMessage(workspace, demo3, "demo-channel", "fence-fixb-no-repost");
  assert.equal((readState(workspace.stateDir).fixtures.discord.messages ?? []).length, 4);
  const checksAfter = (readState(workspace.stateDir).fixtures.discord.reactions ?? []).filter((r) => r.emoji === checkEmoji);
  assert.deepEqual(
    checksAfter.map((r) => `${r.channelId}:${r.messageId}`).sort(),
    [`beta-channel:${betaReqPost.id}`, `demo-channel:${demoReqPost.id}`],
  );
});

test("new launch after restart: records still post, nothing from before the new launch is delivered, and unanswered request expires later", async () => {
  const workspace = createRouterWorkspace(routerRegistry({
    demo: { channel_id: "demo-channel", type: "claude", transport: "router", agent_message_targets: ["beta"] },
    beta: { channel_id: "beta-channel", type: "codex", transport: "router" },
  }));
  const env = { CCDM_ROUTER_AGENT_MESSAGE_MINUTE_MS: "500" };
  let router = await routerWithWebhooks(workspace, ["demo", "beta"], { env });

  const demo1 = await connectAgentProject(workspace, "demo", "demo-key");
  const beta1 = await connectAgentProject(workspace, "beta", "beta-key");

  // Part A: Request side with a new launch of beta after restart.
  const demoWebhookPath = webhookExecutePath(workspace, "demo-channel");
  holdDiscordPath(workspace, { method: "POST", apiPath: demoWebhookPath });

  const reqA = await demo1.request("agent_request", {
    target: "beta",
    text: "Target will restart fresh",
    timeout_minutes: 2, // 1000ms
    idempotency_key: "fixb-newlaunch-req-1",
  });
  assert.equal(reqA.ok, true, JSON.stringify(reqA));
  const reqAId = reqA.result.request_id;
  await waitForHoldHit(workspace, demoWebhookPath);

  await demo1.close();
  await beta1.close();
  // Rotate beta's key so beta2 is a NEW launch!
  writeProjectKey(workspace, "beta", "beta-key-launch-2");
  router = await crashAndRestartRouter(workspace, router, { env });

  const demo2 = await connectAgentProject(workspace, "demo", "demo-key");
  const betaNew = await connectAgentProject(workspace, "beta", "beta-key-launch-2");

  // Both request records ARE posted on recovery.
  await waitFor(
    () => (readState(workspace.stateDir).fixtures.discord.messages ?? []).length === 2,
    () => `two request records for new launch: ${JSON.stringify(readState(workspace.stateDir).fixtures.discord.messages)}`,
  );

  // Request expires at its timeout -> demo's same launch gets expired notice, beta's new launch NEVER got the request.
  const expNotice = await waitFor(
    () => demo2.events.find((e) => e.event === "agent_message" && e.kind === "notice" && e.request_id === reqAId && e.outcome === "expired"),
    () => `demo2 expired notice: ${JSON.stringify(demo2.events)}`,
    6000,
  );
  assert.equal(expNotice.target.project, "beta");
  await fenceOwnerMessage(workspace, betaNew, "beta-channel", "fence-beta-new-no-req");
  assert.deepEqual(betaNew.events.filter((e) => e.event === "agent_message"), []);

  // Part B: Reply side with a new launch of demo after restart.
  const reqB = await demo2.request("agent_request", {
    target: "beta",
    text: "Sender will restart fresh",
    timeout_minutes: 10,
    idempotency_key: "fixb-newlaunch-req-2",
  });
  assert.equal(reqB.ok, true, JSON.stringify(reqB));
  const reqBId = reqB.result.request_id;
  const betaReqB = await waitFor(
    () => betaNew.events.find((e) => e.event === "agent_message" && e.kind === "request" && e.request_id === reqBId),
    () => `betaNew reqB: ${JSON.stringify(betaNew.events)}`,
  );
  assert.equal((await betaNew.request("agent_message_ack", { delivery_id: betaReqB.delivery_id })).ok, true);
  await waitFor(
    () => (readState(workspace.stateDir).fixtures.discord.messages ?? []).length === 4,
    () => `four records before reply B`,
  );

  // Disconnect demo2 before beta replies, hold beta's reply post, then kill Router.
  await demo2.close();
  await waitFor(
    async () => {
      const status = JSON.parse((await runRouterCli(workspace, ["status", "--json"])).stdout);
      return !status.sessions.some((s) => s.project === "demo" && s.role === "project");
    },
    () => "demo2 disconnect",
  );
  const betaWebhookPath = webhookExecutePath(workspace, "beta-channel");
  holdDiscordPath(workspace, { method: "POST", apiPath: betaWebhookPath });

  const repB = await betaNew.request("agent_reply", {
    request_id: reqBId,
    text: "Reply for old launch of demo",
    idempotency_key: "fixb-newlaunch-reply-2",
  });
  assert.equal(repB.ok, true, JSON.stringify(repB));
  assert.deepEqual(repB.result, { request_id: reqBId, delivered_to_live_session: false });
  await waitForHoldHit(workspace, betaWebhookPath);

  await betaNew.close();
  writeProjectKey(workspace, "demo", "demo-key-launch-2");
  router = await crashAndRestartRouter(workspace, router, { env });

  const demoNew = await connectAgentProject(workspace, "demo", "demo-key-launch-2");

  // Both reply records ARE posted (total 6 messages) and both reqB posts get ✅.
  await waitFor(
    () => (readState(workspace.stateDir).fixtures.discord.messages ?? []).length === 6,
    () => `six records after reply B recovery: ${JSON.stringify(readState(workspace.stateDir).fixtures.discord.messages)}`,
  );
  const checkEmoji = encodeURIComponent("✅");
  await waitFor(
    () => (readState(workspace.stateDir).fixtures.discord.reactions ?? []).filter((r) => r.emoji === checkEmoji).length === 2,
    () => `two ✅ marks for reqB: ${JSON.stringify(readState(workspace.stateDir).fixtures.discord.reactions)}`,
  );

  // Demo's new launch receives NOTHING from before its launch.
  await fenceOwnerMessage(workspace, demoNew, "demo-channel", "fence-demo-new-no-reply");
  assert.deepEqual(demoNew.events.filter((e) => e.event === "agent_message"), []);
});

test("a ledger write failure during request or reply acceptance returns ledger_unavailable and posts nothing; a failure during post-acceptance delivery append never silently drops delivery", async () => {
  const workspace = createRouterWorkspace(routerRegistry({
    demo: { channel_id: "demo-channel", type: "claude", transport: "router", agent_message_targets: ["beta"] },
    beta: { channel_id: "beta-channel", type: "codex", transport: "router" },
  }));
  let router = await routerWithWebhooks(workspace, ["demo", "beta"]);
  const ledgerFile = path.join(workspace.routerStateDir, "agent-messages.jsonl");

  const demo = await connectAgentProject(workspace, "demo", "demo-key");
  const beta = await connectAgentProject(workspace, "beta", "beta-key");

  // 1. Acceptance failure on agent_request: create read-only ledger file so open("a") fails with EACCES.
  fs.writeFileSync(ledgerFile, "", { mode: 0o400 });
  registerTeardownCallback(() => {
    try { fs.chmodSync(ledgerFile, 0o600); } catch { /* ignore */ }
  });

  const failedReq = await demo.request("agent_request", {
    target: "beta",
    text: "Must fail with ledger_unavailable",
    idempotency_key: "fixb-fail-accept-req",
  });
  assert.equal(failedReq.ok, false);
  assert.equal(failedReq.error.code, "ledger_unavailable");
  await fenceOwnerMessage(workspace, beta, "beta-channel", "fence-after-ledger-fail-req");
  assert.equal((readState(workspace.stateDir).fixtures.discord.messages ?? []).length, 0);
  assert.deepEqual(beta.events.filter((e) => e.event === "agent_message"), []);

  // Restore write permissions: same idempotency_key now succeeds!
  fs.chmodSync(ledgerFile, 0o600);
  const okReq = await demo.request("agent_request", {
    target: "beta",
    text: "Now succeeds",
    idempotency_key: "fixb-fail-accept-req",
  });
  assert.equal(okReq.ok, true, JSON.stringify(okReq));
  const reqId = okReq.result.request_id;
  const reqEvent = await waitFor(
    () => beta.events.find((e) => e.event === "agent_message" && e.kind === "request" && e.request_id === reqId),
    () => `beta okReq: ${JSON.stringify(beta.events)}`,
  );
  assert.equal((await beta.request("agent_message_ack", { delivery_id: reqEvent.delivery_id })).ok, true);
  await waitFor(
    () => (readState(workspace.stateDir).fixtures.discord.messages ?? []).length === 2,
    () => `two request records`,
  );

  // 2. Acceptance failure on agent_reply: make ledger read-only -> returns ledger_unavailable, posts nothing, exchange stays open.
  fs.chmodSync(ledgerFile, 0o400);
  const failedRep = await beta.request("agent_reply", {
    request_id: reqId,
    text: "Reply when ledger unwritable",
    idempotency_key: "fixb-fail-accept-rep",
  });
  assert.equal(failedRep.ok, false);
  assert.equal(failedRep.error.code, "ledger_unavailable");
  await fenceOwnerMessage(workspace, demo, "demo-channel", "fence-after-ledger-fail-rep");
  assert.equal((readState(workspace.stateDir).fixtures.discord.messages ?? []).length, 2);
  assert.equal((readState(workspace.stateDir).fixtures.discord.reactions ?? []).length, 0);
  assert.deepEqual(demo.events.filter((e) => e.event === "agent_message"), []);

  // 3. Post-acceptance delivery append failure: restore permissions so reply acceptance succeeds,
  // hold receiver reply post so we can make ledger read-only BEFORE enqueueDelivery runs!
  fs.chmodSync(ledgerFile, 0o600);
  const demoBotPath = "/api/v10/channels/demo-channel/messages";
  holdDiscordPath(workspace, { method: "POST", apiPath: demoBotPath, retryAfter: 0.4 });

  const okRep = await beta.request("agent_reply", {
    request_id: reqId,
    text: "Must still deliver when delivery append fails",
    idempotency_key: "fixb-fail-accept-rep",
  });
  assert.equal(okRep.ok, true, JSON.stringify(okRep));

  // Wait until publishReply is paused at receiver post, then make ledger read-only so the delivery append fails!
  await waitForHoldHit(workspace, demoBotPath);
  fs.chmodSync(ledgerFile, 0o400);

  // Live recipient STILL receives the reply (never silently dropped!).
  const liveReply = await waitFor(
    () => demo.events.find((e) => e.event === "agent_message" && e.kind === "reply" && e.request_id === reqId),
    () => `demo live reply despite failed delivery append: ${JSON.stringify(demo.events)}`,
  );
  assert.equal(liveReply.text, "Must still deliver when delivery append fails");
  const deliveryId = liveReply.delivery_id;

  // Do NOT ack. Restore permissions and restart Router -> delivery is STILL recovered from the acceptance line with the SAME delivery_id!
  await demo.close();
  await beta.close();
  await router.stop();
  fs.chmodSync(ledgerFile, 0o600);
  clearDiscordHolds(workspace);
  router = await startRouter(workspace);

  const demoAfter = await connectAgentProject(workspace, "demo", "demo-key");
  const recoveredReply = await waitFor(
    () => demoAfter.events.find((e) => e.event === "agent_message" && e.kind === "reply" && e.request_id === reqId),
    () => `demoAfter recovered reply after failed delivery append: ${JSON.stringify(demoAfter.events)}`,
  );
  assert.equal(recoveredReply.delivery_id, deliveryId);
  assert.equal(recoveredReply.text, "Must still deliver when delivery append fails");
});

test("thread conversations also recover unfinished request and reply publishing across a Router restart", async () => {
  const workspace = createRouterWorkspace(routerRegistry({
    demo: { channel_id: "demo-channel", type: "claude", transport: "router", agent_message_targets: ["beta"] },
    beta: { channel_id: "beta-channel", type: "codex", transport: "router" },
  }));
  seedThreads(workspace, {
    "demo-thread-1": { type: 11, parentId: "demo-channel", name: "triage" },
    "beta-thread-1": { type: 11, parentId: "beta-channel", name: "worker" },
  });
  writeThreadKey(workspace, "demo-thread-1", "demo-thread-key");
  writeThreadKey(workspace, "beta-thread-1", "beta-thread-key");
  let router = await routerWithWebhooks(workspace, ["demo", "beta"]);

  const demoThread1 = await connectAgentThread(workspace, "demo", "demo-thread-1", "demo-thread-key", "claude");
  const betaThread1 = await connectAgentThread(workspace, "beta", "beta-thread-1", "beta-thread-key", "codex");

  const demoWebhookPath = webhookExecutePath(workspace, "demo-channel");
  holdDiscordPath(workspace, { method: "POST", apiPath: demoWebhookPath });

  const sent = await demoThread1.request("agent_request", {
    target: "beta/beta-thread-1",
    text: "Thread request survives crash",
    idempotency_key: "fixb-thread-req-1",
  });
  assert.equal(sent.ok, true, JSON.stringify(sent));
  const reqId = sent.result.request_id;
  await waitForHoldHit(workspace, demoWebhookPath);

  await demoThread1.close();
  await betaThread1.close();
  router = await crashAndRestartRouter(workspace, router);

  const betaThread2 = await connectAgentThread(workspace, "beta", "beta-thread-1", "beta-thread-key", "codex");
  const reqEvent = await waitFor(
    () => betaThread2.events.find((e) => e.event === "agent_message" && e.kind === "request" && e.request_id === reqId),
    () => `betaThread2 recovered request: ${JSON.stringify(betaThread2.events)}`,
  );
  assert.equal(reqEvent.from.thread_id, "demo-thread-1");
  assert.equal(reqEvent.post?.channel_id, "beta-thread-1");
  assert.equal((await betaThread2.request("agent_message_ack", { delivery_id: reqEvent.delivery_id })).ok, true);

  // Now hold beta's webhook execute during thread reply and kill Router.
  const betaWebhookPath = webhookExecutePath(workspace, "beta-channel");
  holdDiscordPath(workspace, { method: "POST", apiPath: betaWebhookPath });

  const replied = await betaThread2.request("agent_reply", {
    request_id: reqId,
    text: "Thread reply survives crash",
    idempotency_key: "fixb-thread-reply-1",
  });
  assert.equal(replied.ok, true, JSON.stringify(replied));
  await waitForHoldHit(workspace, betaWebhookPath);

  await betaThread2.close();
  router = await crashAndRestartRouter(workspace, router);

  const demoThread2 = await connectAgentThread(workspace, "demo", "demo-thread-1", "demo-thread-key", "claude");
  const replyEvent = await waitFor(
    () => demoThread2.events.find((e) => e.event === "agent_message" && e.kind === "reply" && e.request_id === reqId),
    () => `demoThread2 recovered reply: ${JSON.stringify(demoThread2.events)}`,
  );
  assert.equal(replyEvent.text, "Thread reply survives crash");
  assert.equal(replyEvent.from.thread_id, "beta-thread-1");
  assert.equal(replyEvent.post?.channel_id, "demo-thread-1");
  assert.equal((readState(workspace.stateDir).fixtures.discord.messages ?? []).length, 4);
  const checkEmoji = encodeURIComponent("✅");
  await waitFor(
    () => (readState(workspace.stateDir).fixtures.discord.reactions ?? []).filter((r) => r.emoji === checkEmoji).length === 2,
    () => `two ✅ marks on thread request posts: ${JSON.stringify(readState(workspace.stateDir).fixtures.discord.reactions)}`,
  );
});
