// Round-2 recovery tests (Worker G: G1, G2, G3):
// - G1: expiry journaling (`delivery_id` on `expired` + `mark` records) recovers
//   missing ⚠️ marks and expiry notice across a Router crash/restart or a failed
//   delivery append without duplicating marks or notices.
// - G2: an accepted request whose expiry passes while the Router is down still
//   posts its records in both conversations once on restart, delivers nothing to
//   the target, marks both posts ⚠️, and notifies the sender.
// - G3: multi-chunk records journal each chunk's message ID (`post_chunk`) so a
//   crash after chunk 1 of 3 posts only the remaining chunks on restart, in
//   order, with the counterpart link and outcome marks on chunk 1; ledgers in
//   the round-1 format (without `post_chunk`) still load cleanly.
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import test from "node:test";

import { injectDiscordMessage } from "./support/bridge.js";
import {
  OWNER_ID,
  ROOT_TOKEN,
  createRouterWorkspace,
  killRouter,
  routerRegistry,
  routerSocketPath,
  routerWithWebhooks,
  startRouter,
  waitFor,
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

function connectAgentProject(workspace, project, key) {
  return rawClient(workspace, {
    role: "project",
    project,
    key,
    capabilities: ["agent_messages"],
  });
}

function webhookExecutePath(workspace, channelId) {
  const webhook = (readState(workspace.stateDir).fixtures.discord.webhooks ?? [])
    .find((entry) => entry.channel_id === channelId);
  assert.ok(webhook, `missing webhook for ${channelId}`);
  return `/api/v10/webhooks/${webhook.id}/${webhook.token}`;
}

function holdDiscordPath(workspace, { method = "POST", apiPath, retryAfter = 10, count = 1 }) {
  updateState(workspace.stateDir, (state) => {
    state.fixtures.discord.rateLimits = [{ method, path: apiPath, count, retryAfter }];
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

function stripHeaderLine(content) {
  const newline = content.indexOf("\n");
  assert.ok(newline > 0, `expected header newline in ${JSON.stringify(content.slice(0, 80))}`);
  return content.slice(newline + 1);
}

test("G1: Router killed right after expiry (between ⚠️ marks, before notice delivery) recovers the missing mark and delivers the expiry notice once on reconnect", async () => {
  const workspace = createRouterWorkspace(routerRegistry({
    demo: { channel_id: "demo-channel", type: "claude", transport: "router", agent_message_targets: ["beta"] },
    beta: { channel_id: "beta-channel", type: "codex", transport: "router" },
  }));
  const env = { CCDM_ROUTER_AGENT_MESSAGE_MINUTE_MS: "350" };
  let router = await routerWithWebhooks(workspace, ["demo", "beta"], { env });

  const demo1 = await connectAgentProject(workspace, "demo", "demo-key");
  const beta1 = await connectAgentProject(workspace, "beta", "beta-key");

  const sent = await demo1.request("agent_request", {
    target: "beta",
    text: "Expire before notice is delivered",
    timeout_minutes: 2, // 700ms
    idempotency_key: "fixg-g1-req-1",
  });
  assert.equal(sent.ok, true, JSON.stringify(sent));
  const reqId = sent.result.request_id;

  const reqEv = await waitFor(
    () => beta1.events.find((e) => e.event === "agent_message" && e.kind === "request" && e.request_id === reqId),
    () => `beta1 request: ${JSON.stringify(beta1.events)}`,
  );
  assert.equal((await beta1.request("agent_message_ack", { delivery_id: reqEv.delivery_id })).ok, true);

  await waitFor(
    () => (readState(workspace.stateDir).fixtures.discord.messages ?? []).length === 2,
    () => "two request records",
  );
  const msgs = readState(workspace.stateDir).fixtures.discord.messages;
  const senderPost = msgs.find((m) => m.channelId === "demo-channel");
  const receiverPost = msgs.find((m) => m.channelId === "beta-channel");

  // Hold the 2nd ⚠️ mark (receiver post) so the Router writes `expired`, marks
  // the sender post ⚠️, and then blocks before marking the receiver post or
  // writing/delivering the expiry notice.
  const warnEmoji = encodeURIComponent("⚠️");
  const receiverWarnPath = `/api/v10/channels/beta-channel/messages/${receiverPost.id}/reactions/${warnEmoji}/@me`;
  holdDiscordPath(workspace, { method: "PUT", apiPath: receiverWarnPath });

  await waitForHoldHit(workspace, receiverWarnPath);
  assert.equal(
    (readState(workspace.stateDir).fixtures.discord.reactions ?? []).filter((r) => r.emoji === warnEmoji).length,
    1,
  );
  assert.equal(demo1.events.some((e) => e.event === "agent_message" && e.kind === "notice"), false);

  await demo1.close();
  await beta1.close();
  killRouter(router);
  await router.closed;
  clearDiscordHolds(workspace);

  router = await startRouter(workspace, { env });

  // Sender's same launch reconnects -> receives expiry notice once, and both posts carry ⚠️ once.
  const demo2 = await connectAgentProject(workspace, "demo", "demo-key");
  const notice = await waitFor(
    () => demo2.events.find((e) => e.event === "agent_message" && e.kind === "notice" && e.request_id === reqId),
    () => `demo2 recovered expiry notice: ${JSON.stringify(demo2.events)}`,
  );
  assert.equal(notice.outcome, "expired");
  assert.deepEqual(notice.target, { project: "beta", provider: "codex", conversation_id: "beta-channel" });
  assert.deepEqual(notice.post, { channel_id: "demo-channel", message_id: senderPost.id });
  assert.equal((await demo2.request("agent_message_ack", { delivery_id: notice.delivery_id })).ok, true);

  await waitFor(
    () => (readState(workspace.stateDir).fixtures.discord.reactions ?? []).filter((r) => r.emoji === warnEmoji).length === 2,
    () => `two ⚠️ marks after recovery: ${JSON.stringify(readState(workspace.stateDir).fixtures.discord.reactions)}`,
  );
  const warns = (readState(workspace.stateDir).fixtures.discord.reactions ?? []).filter((r) => r.emoji === warnEmoji);
  assert.deepEqual(
    warns.map((r) => `${r.channelId}:${r.messageId}`).sort(),
    [`beta-channel:${receiverPost.id}`, `demo-channel:${senderPost.id}`],
  );

  // Fence: no duplicate notice and no duplicate ⚠️ reactions.
  await fenceOwnerMessage(workspace, demo2, "demo-channel", "fence-g1-once");
  assert.equal(demo2.events.filter((e) => e.event === "agent_message").length, 1);
  assert.equal(
    (readState(workspace.stateDir).fixtures.discord.reactions ?? []).filter((r) => r.emoji === warnEmoji).length,
    2,
  );
});

test("G2: a request accepted before crash that expires while the Router is down still posts both linked records once, delivers nothing to target, marks ⚠️, and notifies sender", async () => {
  const workspace = createRouterWorkspace(routerRegistry({
    demo: { channel_id: "demo-channel", type: "claude", transport: "router", agent_message_targets: ["beta"] },
    beta: { channel_id: "beta-channel", type: "codex", transport: "router" },
  }));
  const env = { CCDM_ROUTER_AGENT_MESSAGE_MINUTE_MS: "250" };
  let router = await routerWithWebhooks(workspace, ["demo", "beta"], { env });

  const demo1 = await connectAgentProject(workspace, "demo", "demo-key");
  const beta1 = await connectAgentProject(workspace, "beta", "beta-key");

  // Hold demo's webhook execute so publishRequest blocks BEFORE posting anything.
  const demoWebhookPath = webhookExecutePath(workspace, "demo-channel");
  holdDiscordPath(workspace, { method: "POST", apiPath: demoWebhookPath });

  const sent = await demo1.request("agent_request", {
    target: "beta",
    text: "Expired while Router was down before posting",
    timeout_minutes: 2, // 500ms
    idempotency_key: "fixg-g2-req-1",
  });
  assert.equal(sent.ok, true, JSON.stringify(sent));
  const reqId = sent.result.request_id;

  await waitForHoldHit(workspace, demoWebhookPath);
  assert.equal((readState(workspace.stateDir).fixtures.discord.messages ?? []).length, 0);

  await demo1.close();
  await beta1.close();
  killRouter(router);
  await router.closed;
  clearDiscordHolds(workspace);

  // Stay down past the 500ms expiry.
  await new Promise((resolve) => setTimeout(resolve, 750));
  router = await startRouter(workspace, { env });

  const demo2 = await connectAgentProject(workspace, "demo", "demo-key");
  const beta2 = await connectAgentProject(workspace, "beta", "beta-key");

  // Both request records are posted once and linked.
  await waitFor(
    () => (readState(workspace.stateDir).fixtures.discord.messages ?? []).length === 2,
    () => `two request records after overdue recovery: ${JSON.stringify(readState(workspace.stateDir).fixtures.discord.messages)}`,
  );
  const msgs = readState(workspace.stateDir).fixtures.discord.messages;
  const senderPost = msgs.find((m) => m.channelId === "demo-channel");
  const receiverPost = msgs.find((m) => m.channelId === "beta-channel");
  assert.ok(senderPost && receiverPost, JSON.stringify(msgs));
  assert.match(senderPost.content, new RegExp(`\\[counterpart\\]\\(https://discord\\.com/channels/guild-id/beta-channel/${receiverPost.id}\\)`));
  assert.match(receiverPost.content, new RegExp(`\\[counterpart\\]\\(https://discord\\.com/channels/guild-id/demo-channel/${senderPost.id}\\)`));

  // Sender gets expiry notice once with post pointing at senderPost.
  const notice = await waitFor(
    () => demo2.events.find((e) => e.event === "agent_message" && e.kind === "notice" && e.request_id === reqId),
    () => `demo2 overdue expiry notice: ${JSON.stringify(demo2.events)}`,
  );
  assert.equal(notice.outcome, "expired");
  assert.deepEqual(notice.post, { channel_id: "demo-channel", message_id: senderPost.id });

  // Both request posts carry ⚠️ once.
  const warnEmoji = encodeURIComponent("⚠️");
  await waitFor(
    () => (readState(workspace.stateDir).fixtures.discord.reactions ?? []).filter((r) => r.emoji === warnEmoji).length === 2,
    () => `two ⚠️ marks on overdue recovered posts: ${JSON.stringify(readState(workspace.stateDir).fixtures.discord.reactions)}`,
  );
  const warns = readState(workspace.stateDir).fixtures.discord.reactions.filter((r) => r.emoji === warnEmoji);
  assert.deepEqual(
    warns.map((r) => `${r.channelId}:${r.messageId}`).sort(),
    [`beta-channel:${receiverPost.id}`, `demo-channel:${senderPost.id}`],
  );

  // Target session receives NOTHING.
  await fenceOwnerMessage(workspace, beta2, "beta-channel", "fence-g2-beta-nothing");
  assert.deepEqual(beta2.events.filter((e) => e.event === "agent_message"), []);
  assert.equal((readState(workspace.stateDir).fixtures.discord.messages ?? []).length, 2);
});

test("G3: Router killed after chunk 1 of a 3-chunk record posts only chunks 2 and 3 on restart, in order, with counterpart link and marks on chunk 1", async () => {
  const workspace = createRouterWorkspace(routerRegistry({
    demo: { channel_id: "demo-channel", type: "claude", transport: "router", agent_message_targets: ["beta"] },
    beta: { channel_id: "beta-channel", type: "codex", transport: "router" },
  }));
  let router = await routerWithWebhooks(workspace, ["demo", "beta"]);

  const demo1 = await connectAgentProject(workspace, "demo", "demo-key");
  const beta1 = await connectAgentProject(workspace, "beta", "beta-key");

  // 4000 characters splits into 3 chunks (header + link reserve < 2000 each).
  const longText = Array.from({ length: 80 }, (_, i) => `CHUNK-${String(i).padStart(2, "0")}-${"z".repeat(41)}`).join("\n").slice(0, 4000);
  assert.equal(longText.length, 4000);

  // Let chunk 1 of demo's webhook succeed, then hold chunk 2!
  // We can do this by setting a 1-shot rate limit on chunk 2 right after chunk 1 lands?
  // Wait: chunks post in a tight loop, so use a short rate-limit on chunk 1 (0.05s) or
  // use preload's rateLimits? Look: if we set two rules or wait: let's check if preload
  // has a way to hold the 2nd POST! Wait: let's check preload.cjs — rateLimits matches
  // the FIRST rule with count > 0 on every request. Instead, we can let chunk 1 succeed
  // on sender side by holding ONLY when messages.length >= 1, OR wait — let's check
  // whether preload supports skip/after! Let's test via a 3-chunk post on sender side:
  // If we use a helper or check preload.cjs first.
  const demoWebhookPath = webhookExecutePath(workspace, "demo-channel");
  updateState(workspace.stateDir, (state) => {
    state.fixtures.discord.rateLimits = [
      { method: "POST", path: demoWebhookPath, count: 1, retryAfter: 10, skip: 1 },
    ];
    state.fixtures.discord.rateLimitHits = [];
  });

  const sent = await demo1.request("agent_request", {
    target: "beta",
    text: longText,
    idempotency_key: "fixg-g3-long-1",
  });
  assert.equal(sent.ok, true, JSON.stringify(sent));
  const reqId = sent.result.request_id;

  await waitForHoldHit(workspace, demoWebhookPath);

  const preCrashDemoMsgs = (readState(workspace.stateDir).fixtures.discord.messages ?? [])
    .filter((m) => m.channelId === "demo-channel");
  assert.equal(preCrashDemoMsgs.length, 1, `expected exactly chunk 1 posted before crash, got ${preCrashDemoMsgs.length}`);
  const firstSenderChunkId = preCrashDemoMsgs[0].id;

  await demo1.close();
  await beta1.close();
  killRouter(router);
  await router.closed;
  clearDiscordHolds(workspace);

  // Also test receiver mid-chunk crash on the same request: hold chunk 2 of receiver bot post!
  const betaBotPath = "/api/v10/channels/beta-channel/messages";
  updateState(workspace.stateDir, (state) => {
    state.fixtures.discord.rateLimits = [
      { method: "POST", path: betaBotPath, count: 1, retryAfter: 10, skip: 1 },
    ];
    state.fixtures.discord.rateLimitHits = [];
  });

  router = await startRouter(workspace);
  await waitForHoldHit(workspace, betaBotPath);

  // Sender finished all 3 chunks without duplicating chunk 1, and receiver posted chunk 1.
  const midMsgs = readState(workspace.stateDir).fixtures.discord.messages ?? [];
  const midDemoMsgs = midMsgs.filter((m) => m.channelId === "demo-channel");
  const midBetaMsgs = midMsgs.filter((m) => m.channelId === "beta-channel");
  assert.equal(midDemoMsgs.length, 3, `expected 3 sender chunks, got ${midDemoMsgs.length}`);
  assert.equal(midDemoMsgs[0].id, firstSenderChunkId);
  assert.equal(midBetaMsgs.length, 1, `expected 1 receiver chunk before 2nd crash, got ${midBetaMsgs.length}`);
  const firstReceiverChunkId = midBetaMsgs[0].id;

  killRouter(router);
  await router.closed;
  clearDiscordHolds(workspace);

  router = await startRouter(workspace);
  const demo2 = await connectAgentProject(workspace, "demo", "demo-key");
  const beta2 = await connectAgentProject(workspace, "beta", "beta-key");

  const reqEv = await waitFor(
    () => beta2.events.find((e) => e.event === "agent_message" && e.kind === "request" && e.request_id === reqId),
    () => `beta2 recovered 3-chunk request: ${JSON.stringify(beta2.events)}`,
  );
  assert.equal(reqEv.text, longText);
  assert.deepEqual(reqEv.post, { channel_id: "beta-channel", message_id: firstReceiverChunkId });
  assert.equal((await beta2.request("agent_message_ack", { delivery_id: reqEv.delivery_id })).ok, true);

  await waitFor(
    () => {
      const msgs = readState(workspace.stateDir).fixtures.discord.messages ?? [];
      const sender = msgs.filter((m) => m.channelId === "demo-channel");
      const receiver = msgs.filter((m) => m.channelId === "beta-channel");
      return sender.length === 3 && receiver.length === 3 && sender[0].content.includes("[counterpart]");
    },
    () => "all 3 sender + 3 receiver chunks posted and linked",
  );

  const allMsgs = readState(workspace.stateDir).fixtures.discord.messages ?? [];
  const senderMsgs = allMsgs.filter((m) => m.channelId === "demo-channel");
  const receiverMsgs = allMsgs.filter((m) => m.channelId === "beta-channel");
  assert.equal(senderMsgs.length, 3);
  assert.equal(receiverMsgs.length, 3);
  assert.equal(senderMsgs[0].id, firstSenderChunkId);
  assert.equal(receiverMsgs[0].id, firstReceiverChunkId);

  for (const [side, chunks] of [["sender", senderMsgs], ["receiver", receiverMsgs]]) {
    for (let i = 0; i < chunks.length; i += 1) {
      assert.ok(chunks[i].content.startsWith("-# ⇄ Agent "), `${side} chunk ${i + 1} missing prefix`);
      assert.ok(chunks[i].content.length <= 2000, `${side} chunk ${i + 1} > 2000`);
      if (i > 0) {
        assert.equal(chunks[i].content.split("\n", 1)[0], `-# ⇄ Agent Request · ${reqId} · part ${i + 1}/3`);
      }
    }
    assert.equal(chunks.map((c) => stripHeaderLine(c.content)).join(""), longText);
  }
  assert.match(senderMsgs[0].content, new RegExp(`\\[counterpart\\]\\(https://discord\\.com/channels/guild-id/beta-channel/${firstReceiverChunkId}\\)`));
  assert.match(receiverMsgs[0].content, new RegExp(`\\[counterpart\\]\\(https://discord\\.com/channels/guild-id/demo-channel/${firstSenderChunkId}\\)`));

  // Reply marks ✅ on chunk 1 of both sides.
  const replied = await beta2.request("agent_reply", {
    request_id: reqId,
    text: "All 3 chunks received cleanly",
    idempotency_key: "fixg-g3-reply-1",
  });
  assert.equal(replied.ok, true, JSON.stringify(replied));

  const checkEmoji = encodeURIComponent("✅");
  await waitFor(
    () => (readState(workspace.stateDir).fixtures.discord.reactions ?? []).filter((r) => r.emoji === checkEmoji).length === 2,
    () => `two ✅ marks on chunk 1: ${JSON.stringify(readState(workspace.stateDir).fixtures.discord.reactions)}`,
  );
  const checks = readState(workspace.stateDir).fixtures.discord.reactions.filter((r) => r.emoji === checkEmoji);
  assert.deepEqual(
    checks.map((r) => `${r.channelId}:${r.messageId}`).sort(),
    [`beta-channel:${firstReceiverChunkId}`, `demo-channel:${firstSenderChunkId}`],
  );

  // `scripts/ccdm agent-messages log` reads the ledger containing `post_chunk` cleanly with no skipped-record note.
  await demo2.close();
  await beta2.close();
  await router.stop();
  const logResult = await runScript(workspace, "scripts/ccdm", {
    args: ["agent-messages", "log", "--json"],
    env: { CCDM_ROUTER_STATE_DIR: workspace.routerStateDir },
    timeoutMs: 20000,
  });
  assert.equal(logResult.exitCode, 0, `${logResult.stderr}\n${logResult.stdout}`);
  assert.equal(logResult.stderr, "");
  const entries = JSON.parse(logResult.stdout);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].request_id, reqId);
  assert.equal(entries[0].outcome, "replied");
});

test("G1: failed best-effort delivery append during expiry still delivers live and recovers with the same delivery_id after restart", async () => {
  const workspace = createRouterWorkspace(routerRegistry({
    demo: { channel_id: "demo-channel", type: "claude", transport: "router", agent_message_targets: ["beta"] },
    beta: { channel_id: "beta-channel", type: "codex", transport: "router" },
  }));
  const env = { CCDM_ROUTER_AGENT_MESSAGE_MINUTE_MS: "300" };
  let router = await routerWithWebhooks(workspace, ["demo", "beta"], { env });
  const ledgerFile = path.join(workspace.routerStateDir, "agent-messages.jsonl");
  registerTeardownCallback(() => {
    try { fs.chmodSync(ledgerFile, 0o600); } catch {}
  });

  const demo1 = await connectAgentProject(workspace, "demo", "demo-key");
  const beta1 = await connectAgentProject(workspace, "beta", "beta-key");

  const sent = await demo1.request("agent_request", {
    target: "beta",
    text: "Expiry notice survives failed delivery append",
    timeout_minutes: 2, // 600ms
    idempotency_key: "fixg-g1-del-fail-1",
  });
  assert.equal(sent.ok, true, JSON.stringify(sent));
  const reqId = sent.result.request_id;

  const reqEv = await waitFor(
    () => beta1.events.find((e) => e.event === "agent_message" && e.kind === "request" && e.request_id === reqId),
    () => "beta1 request",
  );
  assert.equal((await beta1.request("agent_message_ack", { delivery_id: reqEv.delivery_id })).ok, true);
  await waitFor(
    () => (readState(workspace.stateDir).fixtures.discord.messages ?? []).length === 2,
    () => "two request records",
  );
  const receiverPost = readState(workspace.stateDir).fixtures.discord.messages.find((m) => m.channelId === "beta-channel");

  // Hold the 2nd ⚠️ mark briefly so we can make the ledger read-only AFTER `expired` is written and BEFORE `delivery` is appended.
  const warnEmoji = encodeURIComponent("⚠️");
  const receiverWarnPath = `/api/v10/channels/beta-channel/messages/${receiverPost.id}/reactions/${warnEmoji}/@me`;
  holdDiscordPath(workspace, { method: "PUT", apiPath: receiverWarnPath, retryAfter: 0.35 });

  await waitForHoldHit(workspace, receiverWarnPath);
  fs.chmodSync(ledgerFile, 0o400);

  // Live sender still gets the expiry notice even though the `delivery` append failed.
  const liveNotice = await waitFor(
    () => demo1.events.find((e) => e.event === "agent_message" && e.kind === "notice" && e.request_id === reqId),
    () => `demo1 live expiry notice: ${JSON.stringify(demo1.events)}`,
  );
  assert.equal(liveNotice.outcome, "expired");
  const deliveryId = liveNotice.delivery_id;

  // Do NOT ack. Restore ledger permissions and restart Router -> sender recovers the unacked notice with the SAME delivery_id.
  await demo1.close();
  await beta1.close();
  await router.stop();
  fs.chmodSync(ledgerFile, 0o600);
  clearDiscordHolds(workspace);

  router = await startRouter(workspace, { env });
  const demo2 = await connectAgentProject(workspace, "demo", "demo-key");
  const recoveredNotice = await waitFor(
    () => demo2.events.find((e) => e.event === "agent_message" && e.kind === "notice" && e.request_id === reqId),
    () => `demo2 recovered expiry notice: ${JSON.stringify(demo2.events)}`,
  );
  assert.equal(recoveredNotice.delivery_id, deliveryId);
  assert.equal(recoveredNotice.outcome, "expired");
});

test("G3: a ledger written by round 1 (71c9d65, without post_chunk or expired.delivery_id) still loads cleanly", async () => {
  const workspace = createRouterWorkspace(routerRegistry({
    demo: { channel_id: "demo-channel", type: "claude", transport: "router", agent_message_targets: ["beta"] },
    beta: { channel_id: "beta-channel", type: "codex", transport: "router" },
  }));
  // Create webhooks without starting the Router yet, then seed a 71c9d65-format ledger.
  let router = await routerWithWebhooks(workspace, ["demo", "beta"]);
  await router.stop();

  const now = Date.now();
  const openedAt = new Date(now - 5000).toISOString();
  const expiresFuture = new Date(now + 120000).toISOString();
  const expiredPast = new Date(now - 1000).toISOString();
  const ledgerFile = path.join(workspace.routerStateDir, "agent-messages.jsonl");
  const crypto = await import("node:crypto");
  const fp = (k) => crypto.createHash("sha256").update(k).digest("hex");

  const lines = [
    // Open exchange with a 71c9d65 multi-chunk `post` (no `post_chunk`), already delivered.
    {
      v: 1, at: openedAt, type: "request", request_id: "req-legacy-open", delivery_id: "del-legacy-open",
      from: { project: "demo", provider: "claude", conversation_id: "demo-channel" },
      to: { project: "beta", provider: "codex", conversation_id: "beta-channel" },
      from_channel_id: "demo-channel", to_channel_id: "beta-channel",
      from_launch: fp("demo-key"), to_launch: fp("beta-key"),
      text: "Legacy open request", depth: 1, expires_at: expiresFuture, idempotency_key: "legacy-open-1",
    },
    {
      v: 1, at: openedAt, type: "post", request_id: "req-legacy-open", kind: "request", side: "sender",
      channel_id: "demo-channel", message_id: "legacy-s1", message_ids: ["legacy-s1", "legacy-s2"],
    },
    {
      v: 1, at: openedAt, type: "post", request_id: "req-legacy-open", kind: "request", side: "receiver",
      channel_id: "beta-channel", message_id: "legacy-r1", message_ids: ["legacy-r1", "legacy-r2"],
    },
    {
      v: 1, at: openedAt, type: "delivery", delivery_id: "del-legacy-open", kind: "request", request_id: "req-legacy-open",
      to: { project: "beta", provider: "codex", conversation_id: "beta-channel" }, to_launch: fp("beta-key"),
      from: { project: "demo", provider: "claude", conversation_id: "demo-channel" },
      text: "Legacy open request", ts: openedAt, expires_at: expiresFuture, depth: 1,
      post: { channel_id: "beta-channel", message_id: "legacy-r1" },
    },
    { v: 1, at: openedAt, type: "ack", delivery_id: "del-legacy-open", request_id: "req-legacy-open" },
    // Expired exchange in 71c9d65 format (no delivery_id on `expired`).
    {
      v: 1, at: openedAt, type: "request", request_id: "req-legacy-exp", delivery_id: "del-legacy-exp",
      from: { project: "demo", provider: "claude", conversation_id: "demo-channel" },
      to: { project: "beta", provider: "codex", conversation_id: "beta-channel" },
      from_channel_id: "demo-channel", to_channel_id: "beta-channel",
      from_launch: fp("demo-key"), to_launch: fp("beta-key"),
      text: "Legacy expired request", depth: 1, expires_at: expiredPast, idempotency_key: "legacy-exp-1",
    },
    { v: 1, at: expiredPast, type: "expired", request_id: "req-legacy-exp" },
  ];
  fs.writeFileSync(ledgerFile, `${lines.map((r) => JSON.stringify(r)).join("\n")}\n`, { mode: 0o600 });

  router = await startRouter(workspace);
  const demo = await connectAgentProject(workspace, "demo", "demo-key");
  const beta = await connectAgentProject(workspace, "beta", "beta-key");

  // Legacy open request accepts a reply and delivers it to demo; legacy expired request stays refused as request_expired.
  const repOpen = await beta.request("agent_reply", {
    request_id: "req-legacy-open",
    text: "Answered legacy open request",
    idempotency_key: "legacy-reply-1",
  });
  assert.equal(repOpen.ok, true, JSON.stringify(repOpen));

  const repEv = await waitFor(
    () => demo.events.find((e) => e.event === "agent_message" && e.kind === "reply" && e.request_id === "req-legacy-open"),
    () => `demo legacy reply: ${JSON.stringify(demo.events)}`,
  );
  assert.equal(repEv.text, "Answered legacy open request");

  const repExp = await beta.request("agent_reply", {
    request_id: "req-legacy-exp",
    text: "Too late for legacy expired",
    idempotency_key: "legacy-reply-exp",
  });
  assert.equal(repExp.ok, false);
  assert.equal(repExp.error.code, "request_expired");
});
