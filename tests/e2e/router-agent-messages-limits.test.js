import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { injectDiscordMessage } from "./support/bridge.js";
import { replaceFile } from "./support/platform.js";
import {
  OWNER_ID,
  createRouterWorkspace,
  rawRouterSocket,
  routerRegistry,
  routerWithWebhooks,
  runRouterCli,
  seedThreads,
  waitFor,
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

function connectAgentThread(workspace, project, threadId, key, provider = "claude") {
  return rawClient(workspace, {
    role: "thread",
    project,
    thread_id: threadId,
    provider,
    key,
    capabilities: ["agent_messages"],
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

test("requests and replies enforce default max_characters of 4000, refuse 4001 without posting, and check reply length last", async () => {
  const workspace = createRouterWorkspace(routerRegistry({
    demo: { channel_id: "demo-channel", type: "claude", transport: "router", agent_message_targets: ["beta"] },
    beta: { channel_id: "beta-channel", type: "codex", transport: "router" },
  }));
  await routerWithWebhooks(workspace, ["demo", "beta"], {
    env: { CCDM_ROUTER_AGENT_MESSAGE_MINUTE_MS: "200" },
  });

  const demo = await connectAgentProject(workspace, "demo", "demo-key");
  const beta = await connectAgentProject(workspace, "beta", "beta-key");

  // 4001-character request is refused with text_too_long, naming limit and value, posting nothing.
  const tooLongReq = await demo.request("agent_request", {
    target: "beta",
    text: "a".repeat(4001),
    idempotency_key: "len-req-4001",
  });
  assert.equal(tooLongReq.ok, false, JSON.stringify(tooLongReq));
  assert.equal(tooLongReq.error.code, "text_too_long");
  assert.match(tooLongReq.error.message, /max_characters/);
  assert.match(tooLongReq.error.message, /\b4000\b/);

  await fenceOwnerMessage(workspace, demo, "demo-channel", "fence-after-too-long-req");
  await fenceOwnerMessage(workspace, beta, "beta-channel", "fence-after-too-long-req-beta");
  assert.equal((readState(workspace.stateDir).fixtures.discord.messages ?? []).length, 0);
  assert.deepEqual(
    beta.events.filter((event) => event.event === "agent_message"),
    [],
  );

  // 4000-character request is accepted.
  const exactReq = await demo.request("agent_request", {
    target: "beta",
    text: "b".repeat(4000),
    timeout_minutes: 20,
    idempotency_key: "len-req-4000",
  });
  assert.equal(exactReq.ok, true, JSON.stringify(exactReq));
  const reqId = exactReq.result.request_id;
  await waitFor(
    () => beta.events.some((event) => event.event === "agent_message" && event.kind === "request" && event.request_id === reqId),
    () => `beta 4000-char request: ${JSON.stringify(beta.events)}`,
  );
  const messagesAfterReq = (readState(workspace.stateDir).fixtures.discord.messages ?? []).length;
  assert.ok(messagesAfterReq >= 2);

  // 4001-character reply is refused with text_too_long, naming limit and value, posting nothing, leaving exchange open.
  const tooLongReply = await beta.request("agent_reply", {
    request_id: reqId,
    text: "c".repeat(4001),
    idempotency_key: "len-rep-4001",
  });
  assert.equal(tooLongReply.ok, false, JSON.stringify(tooLongReply));
  assert.equal(tooLongReply.error.code, "text_too_long");
  assert.match(tooLongReply.error.message, /max_characters/);
  assert.match(tooLongReply.error.message, /\b4000\b/);

  await fenceOwnerMessage(workspace, demo, "demo-channel", "fence-after-too-long-rep");
  assert.equal((readState(workspace.stateDir).fixtures.discord.messages ?? []).length, messagesAfterReq);
  assert.deepEqual(
    demo.events.filter((event) => event.event === "agent_message" && event.kind === "reply"),
    [],
  );

  // 4000-character reply to the still-open request succeeds.
  const exactReply = await beta.request("agent_reply", {
    request_id: reqId,
    text: "d".repeat(4000),
    idempotency_key: "len-rep-4000",
  });
  assert.equal(exactReply.ok, true, JSON.stringify(exactReply));
  await waitFor(
    () => demo.events.some((event) => event.event === "agent_message" && event.kind === "reply" && event.request_id === reqId),
    () => `demo 4000-char reply: ${JSON.stringify(demo.events)}`,
  );

  // Reply check order: text_too_long is checked last (after unknown_request, already_replied, request_expired).
  const overlongUnknown = await beta.request("agent_reply", {
    request_id: "req-000000000000",
    text: "e".repeat(4001),
    idempotency_key: "len-rep-unknown",
  });
  assert.equal(overlongUnknown.ok, false);
  assert.equal(overlongUnknown.error.code, "unknown_request");

  const overlongAlreadyReplied = await beta.request("agent_reply", {
    request_id: reqId,
    text: "f".repeat(4001),
    idempotency_key: "len-rep-already",
  });
  assert.equal(overlongAlreadyReplied.ok, false);
  assert.equal(overlongAlreadyReplied.error.code, "already_replied");

  // Short-timeout request expires; overlong reply after expiry returns request_expired, not text_too_long.
  const expReq = await demo.request("agent_request", {
    target: "beta",
    text: "will expire",
    timeout_minutes: 1,
    idempotency_key: "len-req-exp",
  });
  assert.equal(expReq.ok, true, JSON.stringify(expReq));
  await waitFor(
    () => demo.events.some((event) => event.event === "agent_message" && event.kind === "notice" && event.request_id === expReq.result.request_id),
    () => `expiry notice for ${expReq.result.request_id}: ${JSON.stringify(demo.events)}`,
  );
  const overlongExpired = await beta.request("agent_reply", {
    request_id: expReq.result.request_id,
    text: "g".repeat(4001),
    idempotency_key: "len-rep-expired",
  });
  assert.equal(overlongExpired.ok, false);
  assert.equal(overlongExpired.error.code, "request_expired");
});

test("requests_per_hour enforces default 20 per sending project over a sliding window, counts offline/closed attempts, and isolates other projects", async () => {
  const workspace = createRouterWorkspace(routerRegistry({
    demo: { channel_id: "demo-channel", type: "claude", transport: "router", agent_message_targets: ["beta", "offline"] },
    beta: { channel_id: "beta-channel", type: "codex", transport: "router" },
    gamma: { channel_id: "gamma-channel", type: "claude", transport: "router", agent_message_targets: ["beta"] },
    offline: { channel_id: "offline-channel", type: "claude", transport: "router" },
  }));
  seedThreads(workspace, {
    "demo-thread-1": { type: 11, parentId: "demo-channel", name: "demo-side" },
    "beta-archived": { type: 11, parentId: "beta-channel", name: "closed-thread", archived: true },
  });
  writeThreadKey(workspace, "demo-thread-1", "demo-thread-key");
  const windowMs = 4500;
  await routerWithWebhooks(workspace, ["demo", "beta", "gamma", "offline"], {
    env: { CCDM_ROUTER_AGENT_MESSAGE_RATE_WINDOW_MS: String(windowMs) },
  });

  const demo = await connectAgentProject(workspace, "demo", "demo-key");
  const demoThread = await connectAgentThread(workspace, "demo", "demo-thread-1", "demo-thread-key");
  const beta = await connectAgentProject(workspace, "beta", "beta-key");
  const gamma = await connectAgentProject(workspace, "gamma", "gamma-key");

  // Non-posting refusals (not_granted, text_too_long) must NOT count toward the rate limit.
  const ungranted = await demo.request("agent_request", {
    target: "gamma",
    text: "no grant",
    idempotency_key: "rate-ungranted",
  });
  assert.equal(ungranted.ok, false);
  assert.equal(ungranted.error.code, "not_granted");

  const tooLong = await demo.request("agent_request", {
    target: "beta",
    text: "x".repeat(4001),
    idempotency_key: "rate-too-long",
  });
  assert.equal(tooLong.ok, false);
  assert.equal(tooLong.error.code, "text_too_long");

  // Attempt 1 (counted): accepted request, answered immediately to free open_requests slot.
  const t1 = Date.now();
  const first = await demo.request("agent_request", {
    target: "beta",
    text: "rate 1",
    idempotency_key: "rate-1",
  });
  assert.equal(first.ok, true, JSON.stringify(first));
  const firstReply = await beta.request("agent_reply", {
    request_id: first.result.request_id,
    text: "ok 1",
    idempotency_key: "rate-rep-1",
  });
  assert.equal(firstReply.ok, true, JSON.stringify(firstReply));

  // Separate attempt 1 from attempts 2..20 so we can observe the sliding window freeing exactly 1 slot.
  await new Promise((resolve) => setTimeout(resolve, 900));

  // Attempts 2..17 (16 accepted + replied).
  for (let i = 2; i <= 17; i += 1) {
    const sent = await demo.request("agent_request", {
      target: "beta",
      text: `rate ${i}`,
      idempotency_key: `rate-${i}`,
    });
    assert.equal(sent.ok, true, `request ${i}: ${JSON.stringify(sent)}`);
    const rep = await beta.request("agent_reply", {
      request_id: sent.result.request_id,
      text: `ok ${i}`,
      idempotency_key: `rate-rep-${i}`,
    });
    assert.equal(rep.ok, true, `reply ${i}: ${JSON.stringify(rep)}`);
  }

  // Attempts 18..19 (2 target_offline attempts -> counted toward rate).
  for (let i = 18; i <= 19; i += 1) {
    const off = await demo.request("agent_request", {
      target: "offline",
      text: `offline ${i}`,
      idempotency_key: `rate-${i}`,
    });
    assert.equal(off.ok, false);
    assert.equal(off.error.code, "target_offline");
  }

  // Attempt 20 (1 target_closed attempt -> counted toward rate).
  const closedAttempt = await demo.request("agent_request", {
    target: "beta/beta-archived",
    text: "closed 20",
    idempotency_key: "rate-20",
  });
  assert.equal(closedAttempt.ok, false);
  assert.equal(closedAttempt.error.code, "target_closed");

  // Wait for background posts from attempts 1..20 to settle before measuring "posts nothing" for #21.
  await waitFor(
    () => (readState(workspace.stateDir).fixtures.discord.messages ?? []).length >= 17 * 4 + 3,
    () => `expected 71 messages from 17 exchanges + 3 undelivered, got ${(readState(workspace.stateDir).fixtures.discord.messages ?? []).length}`,
  );
  const messagesBefore21 = (readState(workspace.stateDir).fixtures.discord.messages ?? []).length;

  // 21st request from demo channel is refused with request_rate_exceeded and posts nothing.
  const rateBlocked = await demo.request("agent_request", {
    target: "beta",
    text: "rate 21",
    idempotency_key: "rate-21",
  });
  assert.equal(rateBlocked.ok, false, JSON.stringify(rateBlocked));
  assert.equal(rateBlocked.error.code, "request_rate_exceeded");
  assert.match(rateBlocked.error.message, /requests_per_hour/);
  assert.match(rateBlocked.error.message, /\b20\b/);

  // A thread of the same project shares the per-project rate limit.
  const threadBlocked = await demoThread.request("agent_request", {
    target: "beta",
    text: "thread rate blocked",
    idempotency_key: "rate-21-thread",
  });
  assert.equal(threadBlocked.ok, false, JSON.stringify(threadBlocked));
  assert.equal(threadBlocked.error.code, "request_rate_exceeded");

  await fenceOwnerMessage(workspace, demo, "demo-channel", "fence-after-rate-blocked");
  assert.equal((readState(workspace.stateDir).fixtures.discord.messages ?? []).length, messagesBefore21);

  // Another project (gamma) is completely unaffected by demo's rate limit.
  const gammaSent = await gamma.request("agent_request", {
    target: "beta",
    text: "from gamma",
    idempotency_key: "rate-gamma-1",
  });
  assert.equal(gammaSent.ok, true, JSON.stringify(gammaSent));

  // Wait until attempt 1 slides out of the window (attempts 2..20 are still inside it).
  const waitMs = t1 + windowMs + 150 - Date.now();
  if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));

  const afterSlide = await demo.request("agent_request", {
    target: "beta",
    text: "rate after slide",
    idempotency_key: "rate-after-slide-1",
  });
  assert.equal(afterSlide.ok, true, JSON.stringify(afterSlide));

  // Window is full again (attempts 2..20 + afterSlide = 20), so the very next send is refused again.
  const fullAgain = await demo.request("agent_request", {
    target: "beta",
    text: "rate full again",
    idempotency_key: "rate-after-slide-2",
  });
  assert.equal(fullAgain.ok, false, JSON.stringify(fullAgain));
  assert.equal(fullAgain.error.code, "request_rate_exceeded");
});

test("open_requests enforces default 5 per sending conversation, frees slots on reply and expiry, and counts sibling conversations separately", async () => {
  const workspace = createRouterWorkspace(routerRegistry({
    demo: { channel_id: "demo-channel", type: "claude", transport: "router", agent_message_targets: ["beta"] },
    beta: { channel_id: "beta-channel", type: "codex", transport: "router" },
  }));
  seedThreads(workspace, {
    "demo-thread-1": { type: 11, parentId: "demo-channel", name: "demo-thread" },
  });
  writeThreadKey(workspace, "demo-thread-1", "demo-thread-key");
  await routerWithWebhooks(workspace, ["demo", "beta"], {
    env: { CCDM_ROUTER_AGENT_MESSAGE_MINUTE_MS: "500" },
  });

  const demo = await connectAgentProject(workspace, "demo", "demo-key");
  const demoThread = await connectAgentThread(workspace, "demo", "demo-thread-1", "demo-thread-key");
  const beta = await connectAgentProject(workspace, "beta", "beta-key");

  // Open 5 requests from demo channel: #1 expires after 2 short minutes (1000ms), #2..#5 stay open longer.
  const openIds = [];
  for (let i = 1; i <= 5; i += 1) {
    const sent = await demo.request("agent_request", {
      target: "beta",
      text: `open ${i}`,
      timeout_minutes: i === 1 ? 2 : 30,
      idempotency_key: `open-req-${i}`,
    });
    assert.equal(sent.ok, true, `open ${i}: ${JSON.stringify(sent)}`);
    openIds.push(sent.result.request_id);
  }
  await waitFor(
    () => (readState(workspace.stateDir).fixtures.discord.messages ?? []).length >= 10,
    () => `expected 10 posts from 5 open requests, got ${(readState(workspace.stateDir).fixtures.discord.messages ?? []).length}`,
  );
  const messagesBeforeSixth = (readState(workspace.stateDir).fixtures.discord.messages ?? []).length;

  // 6th open request from demo channel is refused with open_requests_exceeded, naming limit and value, posting nothing.
  const sixth = await demo.request("agent_request", {
    target: "beta",
    text: "open 6",
    timeout_minutes: 30,
    idempotency_key: "open-req-6",
  });
  assert.equal(sixth.ok, false, JSON.stringify(sixth));
  assert.equal(sixth.error.code, "open_requests_exceeded");
  assert.match(sixth.error.message, /open_requests/);
  assert.match(sixth.error.message, /\b5\b/);

  await fenceOwnerMessage(workspace, demo, "demo-channel", "fence-after-open-sixth");
  assert.equal((readState(workspace.stateDir).fixtures.discord.messages ?? []).length, messagesBeforeSixth);

  // Another conversation of the same project (a thread of demo) has its own open_requests count.
  const threadOpen = await demoThread.request("agent_request", {
    target: "beta",
    text: "open from demo thread",
    timeout_minutes: 30,
    idempotency_key: "open-thread-1",
  });
  assert.equal(threadOpen.ok, true, JSON.stringify(threadOpen));

  // Replying to one of demo channel's open requests frees a slot.
  const replied = await beta.request("agent_reply", {
    request_id: openIds[1],
    text: "answering #2",
    idempotency_key: "open-rep-2",
  });
  assert.equal(replied.ok, true, JSON.stringify(replied));

  const afterReply = await demo.request("agent_request", {
    target: "beta",
    text: "open after reply",
    timeout_minutes: 30,
    idempotency_key: "open-req-after-reply",
  });
  assert.equal(afterReply.ok, true, JSON.stringify(afterReply));

  // Back at 5 open requests -> refused again.
  const fullAfterReply = await demo.request("agent_request", {
    target: "beta",
    text: "open full again",
    timeout_minutes: 30,
    idempotency_key: "open-req-full-again",
  });
  assert.equal(fullAfterReply.ok, false, JSON.stringify(fullAfterReply));
  assert.equal(fullAfterReply.error.code, "open_requests_exceeded");

  // Waiting for openIds[0] to expire frees its slot.
  await waitFor(
    () => demo.events.some((event) => event.event === "agent_message" && event.kind === "notice" && event.request_id === openIds[0]),
    () => `expiry notice for ${openIds[0]}: ${JSON.stringify(demo.events)}`,
  );
  const afterExpiry = await demo.request("agent_request", {
    target: "beta",
    text: "open after expiry",
    timeout_minutes: 30,
    idempotency_key: "open-req-after-expiry",
  });
  assert.equal(afterExpiry.ok, true, JSON.stringify(afterExpiry));
});

test("depth reports 1, 2, 3 across A->B->C->D, refuses depth 4 with depth_exceeded without posting, and resets to 1 once answered", async () => {
  const workspace = createRouterWorkspace(routerRegistry({
    alpha: { channel_id: "alpha-channel", type: "claude", transport: "router", agent_message_targets: ["beta", "gamma"] },
    beta: { channel_id: "beta-channel", type: "codex", transport: "router", agent_message_targets: ["gamma"] },
    gamma: { channel_id: "gamma-channel", type: "claude", transport: "router", agent_message_targets: ["delta"] },
    delta: { channel_id: "delta-channel", type: "codex", transport: "router", agent_message_targets: ["alpha"] },
  }));
  await routerWithWebhooks(workspace, ["alpha", "beta", "gamma", "delta"]);

  const alpha = await connectAgentProject(workspace, "alpha", "alpha-key");
  const beta = await connectAgentProject(workspace, "beta", "beta-key");
  const gamma = await connectAgentProject(workspace, "gamma", "gamma-key");
  const delta = await connectAgentProject(workspace, "delta", "delta-key");

  // A -> B: depth 1
  const ab = await alpha.request("agent_request", {
    target: "beta",
    text: "step 1",
    idempotency_key: "depth-ab",
  });
  assert.equal(ab.ok, true, JSON.stringify(ab));
  assert.equal(ab.result.depth, 1);
  const abEvent = await waitFor(
    () => beta.events.find((event) => event.event === "agent_message" && event.request_id === ab.result.request_id),
    () => `beta depth-1 event: ${JSON.stringify(beta.events)}`,
  );
  assert.equal(abEvent.depth, 1);

  // Also send A -> C (depth 1) so C will hold both depth-1 and depth-2 and must pick the greatest (2 -> 3).
  const ac = await alpha.request("agent_request", {
    target: "gamma",
    text: "side depth 1",
    idempotency_key: "depth-ac",
  });
  assert.equal(ac.ok, true, JSON.stringify(ac));
  assert.equal(ac.result.depth, 1);

  // B -> C (holding depth 1): depth 2
  const bc = await beta.request("agent_request", {
    target: "gamma",
    text: "step 2",
    idempotency_key: "depth-bc",
  });
  assert.equal(bc.ok, true, JSON.stringify(bc));
  assert.equal(bc.result.depth, 2);
  const bcEvent = await waitFor(
    () => gamma.events.find((event) => event.event === "agent_message" && event.request_id === bc.result.request_id),
    () => `gamma depth-2 event: ${JSON.stringify(gamma.events)}`,
  );
  assert.equal(bcEvent.depth, 2);

  // C -> D (holding depth 1 and depth 2): greatest is 2, so depth 3
  const cd = await gamma.request("agent_request", {
    target: "delta",
    text: "step 3",
    idempotency_key: "depth-cd",
  });
  assert.equal(cd.ok, true, JSON.stringify(cd));
  assert.equal(cd.result.depth, 3);
  const cdEvent = await waitFor(
    () => delta.events.find((event) => event.event === "agent_message" && event.request_id === cd.result.request_id),
    () => `delta depth-3 event: ${JSON.stringify(delta.events)}`,
  );
  assert.equal(cdEvent.depth, 3);

  await waitFor(
    () => (readState(workspace.stateDir).fixtures.discord.messages ?? []).length >= 8,
    () => `expected 8 posts from 4 open requests, got ${(readState(workspace.stateDir).fixtures.discord.messages ?? []).length}`,
  );
  const messagesBeforeBlocked = (readState(workspace.stateDir).fixtures.discord.messages ?? []).length;

  // D -> A (holding depth 3): would be depth 4 > 3 -> depth_exceeded, naming limit and value, posting nothing.
  const daBlocked = await delta.request("agent_request", {
    target: "alpha",
    text: "step 4 blocked",
    idempotency_key: "depth-da-blocked",
  });
  assert.equal(daBlocked.ok, false, JSON.stringify(daBlocked));
  assert.equal(daBlocked.error.code, "depth_exceeded");
  assert.match(daBlocked.error.message, /depth/);
  assert.match(daBlocked.error.message, /\b3\b/);

  await fenceOwnerMessage(workspace, alpha, "alpha-channel", "fence-after-depth-blocked");
  await fenceOwnerMessage(workspace, delta, "delta-channel", "fence-after-depth-blocked-delta");
  assert.equal((readState(workspace.stateDir).fixtures.discord.messages ?? []).length, messagesBeforeBlocked);
  assert.deepEqual(
    alpha.events.filter((event) => event.event === "agent_message"),
    [],
  );

  // Once D answers C's depth-3 request, D holds no open requests, so D -> A is depth 1 again.
  const cdReply = await delta.request("agent_reply", {
    request_id: cd.result.request_id,
    text: "answered step 3",
    idempotency_key: "depth-cd-reply",
  });
  assert.equal(cdReply.ok, true, JSON.stringify(cdReply));

  const daFresh = await delta.request("agent_request", {
    target: "alpha",
    text: "fresh depth 1",
    idempotency_key: "depth-da-fresh",
  });
  assert.equal(daFresh.ok, true, JSON.stringify(daFresh));
  assert.equal(daFresh.result.depth, 1);
  const daEvent = await waitFor(
    () => alpha.events.find((event) => event.event === "agent_message" && event.request_id === daFresh.result.request_id),
    () => `alpha fresh depth-1 event: ${JSON.stringify(alpha.events)}`,
  );
  assert.equal(daEvent.depth, 1);
});

test("agent_message_limits hot-reloads on the next send with no restart and invalid values keep the last good table", async () => {
  const workspace = createRouterWorkspace(routerRegistry({
    demo: { channel_id: "demo-channel", type: "claude", transport: "router", agent_message_targets: ["beta"] },
    beta: { channel_id: "beta-channel", type: "codex", transport: "router", agent_message_targets: ["demo"] },
  }));
  const router = await routerWithWebhooks(workspace, ["demo", "beta"], {
    env: { CCDM_ROUTER_REGISTRY_DEBOUNCE_MS: "20" },
  });

  const demo = await connectAgentProject(workspace, "demo", "demo-key");
  const beta = await connectAgentProject(workspace, "beta", "beta-key");

  // Under defaults, 25 characters succeeds.
  const beforeOverride = await demo.request("agent_request", {
    target: "beta",
    text: "a".repeat(25),
    idempotency_key: "ov-before",
  });
  assert.equal(beforeOverride.ok, true, JSON.stringify(beforeOverride));
  const beforeReply = await beta.request("agent_reply", {
    request_id: beforeOverride.result.request_id,
    text: "ok",
    idempotency_key: "ov-before-rep",
  });
  assert.equal(beforeReply.ok, true, JSON.stringify(beforeReply));

  // Change only max_characters to 20 -> applies on next send with no restart.
  await afterReload(router, () => {
    const next = readRegistry(workspace);
    next.agent_message_limits = { max_characters: 20 };
    replaceFile(path.join(workspace.repoDir, "registry.json"), `${JSON.stringify(next, null, 2)}\n`);
  });

  const over20 = await demo.request("agent_request", {
    target: "beta",
    text: "b".repeat(21),
    idempotency_key: "ov-21",
  });
  assert.equal(over20.ok, false, JSON.stringify(over20));
  assert.equal(over20.error.code, "text_too_long");
  assert.match(over20.error.message, /max_characters/);
  assert.match(over20.error.message, /\b20\b/);

  const exact20 = await demo.request("agent_request", {
    target: "beta",
    text: "c".repeat(20),
    idempotency_key: "ov-20",
  });
  assert.equal(exact20.ok, true, JSON.stringify(exact20));

  const replyOver20 = await beta.request("agent_reply", {
    request_id: exact20.result.request_id,
    text: "d".repeat(21),
    idempotency_key: "ov-rep-21",
  });
  assert.equal(replyOver20.ok, false, JSON.stringify(replyOver20));
  assert.equal(replyOver20.error.code, "text_too_long");
  assert.match(replyOver20.error.message, /\b20\b/);

  const replyExact20 = await beta.request("agent_reply", {
    request_id: exact20.result.request_id,
    text: "d".repeat(20),
    idempotency_key: "ov-rep-20",
  });
  assert.equal(replyExact20.ok, true, JSON.stringify(replyExact20));

  const loadedGood = (await runRouterCli(workspace, ["status"])).stdout.match(/registry loaded: (\S+)/)[1];
  const baseGood = readRegistry(workspace);
  const invalidLimits = [
    [{ max_characters: 50, unknown_limit: 5 }, /agent_message_limits/],
    [{ depth: 0 }, /agent_message_limits/],
    [{ open_requests: -1 }, /agent_message_limits/],
    [{ requests_per_hour: 2.5 }, /agent_message_limits/],
    [{ max_characters: "100" }, /agent_message_limits/],
    [{ depth: true }, /agent_message_limits/],
    [null, /agent_message_limits/],
    [[1, 2, 3], /agent_message_limits/],
    [42, /agent_message_limits/],
  ];

  for (const [badValue, pattern] of invalidLimits) {
    const failures = () => router.stdout.split("registry_reload_failed").length - 1;
    const beforeFailures = failures();
    await new Promise((resolve) => setTimeout(resolve, 60));
    replaceFile(
      path.join(workspace.repoDir, "registry.json"),
      `${JSON.stringify({ ...baseGood, agent_message_limits: badValue }, null, 2)}\n`,
    );
    await waitFor(() => failures() > beforeFailures, () => `expected reload failure for ${JSON.stringify(badValue)}:\n${router.stdout}`);
    const status = await runRouterCli(workspace, ["status"]);
    assert.match(status.stdout, new RegExp(`registry loaded: ${loadedGood}\\n`));
    assert.match(status.stdout, new RegExp(`registry error: \\S+ invalid registry: .*${pattern.source}`));
  }

  // Last good table (max_characters: 20) still active and sessions were not revoked.
  const stillOver20 = await demo.request("agent_request", {
    target: "beta",
    text: "e".repeat(21),
    idempotency_key: "ov-still-21",
  });
  assert.equal(stillOver20.ok, false);
  assert.equal(stillOver20.error.code, "text_too_long");
  assert.match(stillOver20.error.message, /\b20\b/);

  // Valid hot reload clears registry error and applies new depth: 1 and max_characters: 30.
  await afterReload(router, () => {
    replaceFile(
      path.join(workspace.repoDir, "registry.json"),
      `${JSON.stringify({ ...baseGood, agent_message_limits: { max_characters: 30, depth: 1 } }, null, 2)}\n`,
    );
  });
  const recovered = await runRouterCli(workspace, ["status"]);
  assert.doesNotMatch(recovered.stdout, /registry error/);

  const now25 = await demo.request("agent_request", {
    target: "beta",
    text: "f".repeat(25),
    idempotency_key: "ov-now-25",
  });
  assert.equal(now25.ok, true, JSON.stringify(now25));
  assert.equal(now25.result.depth, 1);

  // While holding depth-1 request, beta's outgoing request would be depth 2 > 1 -> depth_exceeded naming 1.
  const depth1Blocked = await beta.request("agent_request", {
    target: "demo",
    text: "depth 2 blocked",
    idempotency_key: "ov-depth-2",
  });
  assert.equal(depth1Blocked.ok, false, JSON.stringify(depth1Blocked));
  assert.equal(depth1Blocked.error.code, "depth_exceeded");
  assert.match(depth1Blocked.error.message, /depth/);
  assert.match(depth1Blocked.error.message, /\b1\b/);
  assert.equal(demo.events.some((event) => event.event === "revoked"), false);
});

test("check order returns the earliest failing code across invalid_args, grant, target, all four limits, and liveness", async () => {
  const workspace = createRouterWorkspace({
    ...routerRegistry({
      alpha: { channel_id: "alpha-channel", type: "claude", transport: "router", agent_message_targets: ["beta"] },
      beta: { channel_id: "beta-channel", type: "codex", transport: "router", agent_message_targets: ["gamma", "offline"] },
      gamma: { channel_id: "gamma-channel", type: "claude", transport: "router" },
      offline: { channel_id: "offline-channel", type: "claude", transport: "router" },
      ungranted: { channel_id: "ungranted-channel", type: "claude", transport: "router" },
    }),
    agent_message_limits: { max_characters: 10, requests_per_hour: 1, open_requests: 1, depth: 2 },
  });
  seedThreads(workspace, {
    "gamma-dup-1": { type: 11, parentId: "gamma-channel", name: "dup" },
    "gamma-dup-2": { type: 11, parentId: "gamma-channel", name: "dup" },
    "gamma-archived": { type: 11, parentId: "gamma-channel", name: "done", archived: true },
  });
  writeThreadKey(workspace, "gamma-dup-1", "dup-key-1");
  writeThreadKey(workspace, "gamma-dup-2", "dup-key-2");
  const router = await routerWithWebhooks(workspace, ["alpha", "beta", "gamma", "offline", "ungranted"], {
    env: { CCDM_ROUTER_REGISTRY_DEBOUNCE_MS: "20" },
  });

  const alpha = await connectAgentProject(workspace, "alpha", "alpha-key");
  const beta = await connectAgentProject(workspace, "beta", "beta-key");
  await connectAgentProject(workspace, "gamma", "gamma-key");
  await connectAgentThread(workspace, "gamma", "gamma-dup-1", "dup-key-1");
  await connectAgentThread(workspace, "gamma", "gamma-dup-2", "dup-key-2");

  // Put beta in a state where rate (1/1), open_requests (1/1), AND depth (holding depth 1 -> next is 2) are all active.
  const holdDepth1 = await alpha.request("agent_request", {
    target: "beta",
    text: "hold 1",
    idempotency_key: "ord-hold-1",
  });
  assert.equal(holdDepth1.ok, true, JSON.stringify(holdDepth1));

  const fillRateAndOpen = await beta.request("agent_request", {
    target: "gamma",
    text: "fill 1",
    idempotency_key: "ord-fill-1",
  });
  assert.equal(fillRateAndOpen.ok, true, JSON.stringify(fillRateAndOpen));
  assert.equal(fillRateAndOpen.result.depth, 2);

  await waitFor(
    () => (readState(workspace.stateDir).fixtures.discord.messages ?? []).length >= 4,
    () => `expected 4 setup messages, got ${(readState(workspace.stateDir).fixtures.discord.messages ?? []).length}`,
  );

  // Lower depth to 1 so beta now violates rate, open_requests, AND depth simultaneously.
  const setLimits = async (limits) => {
    await afterReload(router, () => {
      const next = readRegistry(workspace);
      next.agent_message_limits = limits;
      replaceFile(path.join(workspace.repoDir, "registry.json"), `${JSON.stringify(next, null, 2)}\n`);
    });
  };
  await setLimits({ max_characters: 10, requests_per_hour: 1, open_requests: 1, depth: 1 });
  const messagesBeforeChecks = (readState(workspace.stateDir).fixtures.discord.messages ?? []).length;

  // 1. invalid_args beats not_granted, text_too_long, rate, open, depth, offline.
  const rInvalid = await beta.request("agent_request", {
    target: "ungranted/missing",
    text: "x".repeat(11),
    timeout_minutes: 0,
    idempotency_key: "ord-1",
  });
  assert.equal(rInvalid.ok, false);
  assert.equal(rInvalid.error.code, "invalid_args");

  // 2. not_granted beats unknown_target, text_too_long, rate, open, depth, offline.
  const rGrant = await beta.request("agent_request", {
    target: "ungranted/missing",
    text: "x".repeat(11),
    idempotency_key: "ord-2",
  });
  assert.equal(rGrant.ok, false);
  assert.equal(rGrant.error.code, "not_granted");

  // 3. unknown_target and ambiguous_target beat text_too_long, rate, open, depth, offline.
  const rUnknown = await beta.request("agent_request", {
    target: "gamma/no-such-thread",
    text: "x".repeat(11),
    idempotency_key: "ord-3",
  });
  assert.equal(rUnknown.ok, false);
  assert.equal(rUnknown.error.code, "unknown_target");

  const rAmbiguous = await beta.request("agent_request", {
    target: "gamma/dup",
    text: "x".repeat(11),
    idempotency_key: "ord-4",
  });
  assert.equal(rAmbiguous.ok, false);
  assert.equal(rAmbiguous.error.code, "ambiguous_target");

  // 4. text_too_long beats request_rate_exceeded, open_requests_exceeded, depth_exceeded, target_closed, target_offline.
  const rLenClosed = await beta.request("agent_request", {
    target: "gamma/gamma-archived",
    text: "x".repeat(11),
    idempotency_key: "ord-5a",
  });
  assert.equal(rLenClosed.ok, false);
  assert.equal(rLenClosed.error.code, "text_too_long");

  const rLenOffline = await beta.request("agent_request", {
    target: "offline",
    text: "x".repeat(11),
    idempotency_key: "ord-5b",
  });
  assert.equal(rLenOffline.ok, false);
  assert.equal(rLenOffline.error.code, "text_too_long");

  // 5. request_rate_exceeded beats open_requests_exceeded, depth_exceeded, target_closed, target_offline.
  const rRateClosed = await beta.request("agent_request", {
    target: "gamma/gamma-archived",
    text: "short",
    idempotency_key: "ord-6a",
  });
  assert.equal(rRateClosed.ok, false);
  assert.equal(rRateClosed.error.code, "request_rate_exceeded");

  const rRateOffline = await beta.request("agent_request", {
    target: "offline",
    text: "short",
    idempotency_key: "ord-6b",
  });
  assert.equal(rRateOffline.ok, false);
  assert.equal(rRateOffline.error.code, "request_rate_exceeded");

  // 6. Raise rate limit; open_requests_exceeded beats depth_exceeded, target_closed, target_offline.
  await setLimits({ max_characters: 10, requests_per_hour: 10, open_requests: 1, depth: 1 });
  const rOpenClosed = await beta.request("agent_request", {
    target: "gamma/gamma-archived",
    text: "short",
    idempotency_key: "ord-7a",
  });
  assert.equal(rOpenClosed.ok, false);
  assert.equal(rOpenClosed.error.code, "open_requests_exceeded");

  const rOpenOffline = await beta.request("agent_request", {
    target: "offline",
    text: "short",
    idempotency_key: "ord-7b",
  });
  assert.equal(rOpenOffline.ok, false);
  assert.equal(rOpenOffline.error.code, "open_requests_exceeded");

  // 7. Raise open_requests; depth_exceeded beats target_closed and target_offline.
  await setLimits({ max_characters: 10, requests_per_hour: 10, open_requests: 5, depth: 1 });
  const rDepthClosed = await beta.request("agent_request", {
    target: "gamma/gamma-archived",
    text: "short",
    idempotency_key: "ord-8a",
  });
  assert.equal(rDepthClosed.ok, false);
  assert.equal(rDepthClosed.error.code, "depth_exceeded");

  const rDepthOffline = await beta.request("agent_request", {
    target: "offline",
    text: "short",
    idempotency_key: "ord-8b",
  });
  assert.equal(rDepthOffline.ok, false);
  assert.equal(rDepthOffline.error.code, "depth_exceeded");

  // None of those refusals posted anything to Discord.
  await fenceOwnerMessage(workspace, beta, "beta-channel", "fence-after-check-order-refusals");
  assert.equal((readState(workspace.stateDir).fixtures.discord.messages ?? []).length, messagesBeforeChecks);

  // 8. Raise depth; now liveness checks run -> target_closed and target_offline.
  await setLimits({ max_characters: 10, requests_per_hour: 10, open_requests: 5, depth: 3 });
  const rClosed = await beta.request("agent_request", {
    target: "gamma/gamma-archived",
    text: "short",
    idempotency_key: "ord-9a",
  });
  assert.equal(rClosed.ok, false);
  assert.equal(rClosed.error.code, "target_closed");

  const rOffline = await beta.request("agent_request", {
    target: "offline",
    text: "short",
    idempotency_key: "ord-9b",
  });
  assert.equal(rOffline.ok, false);
  assert.equal(rOffline.error.code, "target_offline");

  // Both liveness refusals post one sender-side record each.
  await waitFor(
    () => (readState(workspace.stateDir).fixtures.discord.messages ?? []).length === messagesBeforeChecks + 2,
    () => `expected 2 undelivered posts after liveness refusals, got ${(readState(workspace.stateDir).fixtures.discord.messages ?? []).length}`,
  );
});
