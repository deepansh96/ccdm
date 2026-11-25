import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";

import { injectDiscordMessage } from "./support/bridge.js";
import {
  OWNER_ID,
  createRouterWorkspace,
  routerRegistry,
  routerSocketPath,
  routerWithWebhooks,
  runRouterCli,
  startRouter,
  waitFor,
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

async function waitForDisconnect(workspace, project) {
  await waitFor(
    async () => {
      const status = JSON.parse((await runRouterCli(workspace, ["status", "--json"])).stdout);
      return !status.sessions.some((s) => s.project === project && s.role === "project");
    },
    () => `${project} disconnect`,
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

test("compaction drops unacknowledged deliveries older than retention for closed exchanges while keeping recent unacked deliveries and open-exchange deliveries", async () => {
  const workspace = createRouterWorkspace(routerRegistry({
    demo: { channel_id: "demo-channel", type: "claude", transport: "router", agent_message_targets: ["beta"] },
    gamma: { channel_id: "gamma-channel", type: "claude", transport: "router", agent_message_targets: ["beta"] },
    alpha: { channel_id: "alpha-channel", type: "claude", transport: "router", agent_message_targets: ["beta"] },
    beta: { channel_id: "beta-channel", type: "codex", transport: "router" },
  }));
  // Start with default minute length so open exchanges have real 120-minute expiries.
  let router = await routerWithWebhooks(workspace, ["demo", "gamma", "alpha", "beta"]);

  const demo1 = await connectAgentProject(workspace, "demo", "demo-key");
  const alpha1 = await connectAgentProject(workspace, "alpha", "alpha-key");
  const beta1 = await connectAgentProject(workspace, "beta", "beta-key");

  // 1. Old closed exchange with an unacknowledged reply delivery for demo1.
  const oldSent = await demo1.request("agent_request", {
    target: "beta",
    text: "Old closed request",
    idempotency_key: "ret-old-req",
  });
  assert.equal(oldSent.ok, true, JSON.stringify(oldSent));
  const oldReqId = oldSent.result.request_id;
  const oldBetaEvent = await waitFor(
    () => beta1.events.find((e) => e.event === "agent_message" && e.request_id === oldReqId),
    () => `beta1 old request: ${JSON.stringify(beta1.events)}`,
  );
  assert.equal((await beta1.request("agent_message_ack", { delivery_id: oldBetaEvent.delivery_id })).ok, true);

  await demo1.close();
  await waitForDisconnect(workspace, "demo");

  const oldReply = await beta1.request("agent_reply", {
    request_id: oldReqId,
    text: "Old unacked reply for demo",
    idempotency_key: "ret-old-rep",
  });
  assert.equal(oldReply.ok, true, JSON.stringify(oldReply));
  assert.equal(oldReply.result.delivered_to_live_session, false);
  await waitFor(
    () => (readState(workspace.stateDir).fixtures.discord.messages ?? []).length === 4
      && (readState(workspace.stateDir).fixtures.discord.reactions ?? []).filter((r) => r.emoji === encodeURIComponent("✅")).length === 2,
    () => "four records and two ✅ marks for old closed exchange",
  );
  await new Promise((resolve) => setTimeout(resolve, 100));

  // 2. Old OPEN exchange with an unacknowledged request delivery for beta1 (must survive compaction).
  const openSent = await alpha1.request("agent_request", {
    target: "beta",
    text: "Old still-open request",
    timeout_minutes: 120,
    idempotency_key: "ret-open-req",
  });
  assert.equal(openSent.ok, true, JSON.stringify(openSent));
  const openReqId = openSent.result.request_id;
  const openBetaEvent = await waitFor(
    () => beta1.events.find((e) => e.event === "agent_message" && e.request_id === openReqId),
    () => `beta1 open request: ${JSON.stringify(beta1.events)}`,
  );
  // Intentionally leave openBetaEvent unacked and unanswered.

  // Wait past the shortened 30-day retention window (43200 * 0.08ms = 3456ms) before creating the recent exchange.
  await new Promise((resolve) => setTimeout(resolve, 3800));

  // 3. Recent closed exchange with an unacknowledged reply delivery for gamma1 (inside retention window).
  const gamma1 = await connectAgentProject(workspace, "gamma", "gamma-key");
  const recentSent = await gamma1.request("agent_request", {
    target: "beta",
    text: "Recent closed request",
    idempotency_key: "ret-recent-req",
  });
  assert.equal(recentSent.ok, true, JSON.stringify(recentSent));
  const recentReqId = recentSent.result.request_id;
  const recentBetaEvent = await waitFor(
    () => beta1.events.find((e) => e.event === "agent_message" && e.request_id === recentReqId),
    () => `beta1 recent request: ${JSON.stringify(beta1.events)}`,
  );
  assert.equal((await beta1.request("agent_message_ack", { delivery_id: recentBetaEvent.delivery_id })).ok, true);

  await gamma1.close();
  await waitForDisconnect(workspace, "gamma");

  const recentReply = await beta1.request("agent_reply", {
    request_id: recentReqId,
    text: "Recent unacked reply for gamma",
    idempotency_key: "ret-recent-rep",
  });
  assert.equal(recentReply.ok, true, JSON.stringify(recentReply));
  assert.equal(recentReply.result.delivered_to_live_session, false);
  await waitFor(
    () => (readState(workspace.stateDir).fixtures.discord.messages ?? []).length === 10
      && (readState(workspace.stateDir).fixtures.discord.reactions ?? []).filter((r) => r.emoji === encodeURIComponent("✅")).length === 4,
    () => "ten records and four ✅ marks before compaction restart",
  );
  await new Promise((resolve) => setTimeout(resolve, 100));

  // Stop and restart Router with shortened minute length so retention = 43200 * 0.08ms = 3456ms.
  await alpha1.close();
  await beta1.close();
  await router.stop();
  router = await startRouter(workspace, {
    env: { CCDM_ROUTER_AGENT_MESSAGE_MINUTE_MS: "0.08" },
  });

  // Reconnect with the exact same launch keys.
  const demo2 = await connectAgentProject(workspace, "demo", "demo-key");
  const gamma2 = await connectAgentProject(workspace, "gamma", "gamma-key");
  const beta2 = await connectAgentProject(workspace, "beta", "beta-key");

  // Recent unacked delivery (inside retention) IS redelivered to gamma2.
  const recentDelivered = await waitFor(
    () => gamma2.events.find((e) => e.event === "agent_message" && e.kind === "reply" && e.request_id === recentReqId),
    () => `gamma2 recent delivery: ${JSON.stringify(gamma2.events)}`,
  );
  assert.equal(recentDelivered.text, "Recent unacked reply for gamma");

  // Old unacked delivery for the still-open exchange IS redelivered to beta2 with the same delivery_id.
  const openDelivered = await waitFor(
    () => beta2.events.find((e) => e.event === "agent_message" && e.kind === "request" && e.request_id === openReqId),
    () => `beta2 open delivery: ${JSON.stringify(beta2.events)}`,
  );
  assert.equal(openDelivered.delivery_id, openBetaEvent.delivery_id);

  // Old unacked delivery for the closed exchange was DROPPED: demo2 receives nothing.
  await fenceOwnerMessage(workspace, demo2, "demo-channel", "fence-demo2-dropped");
  assert.deepEqual(demo2.events.filter((e) => e.event === "agent_message"), []);

  // Restart once more with default minute length to confirm the dropped delivery is gone from disk too.
  await demo2.close();
  await gamma2.close();
  await beta2.close();
  await router.stop();
  router = await startRouter(workspace);

  const demo3 = await connectAgentProject(workspace, "demo", "demo-key");
  await fenceOwnerMessage(workspace, demo3, "demo-channel", "fence-demo3-still-dropped");
  assert.deepEqual(demo3.events.filter((e) => e.event === "agent_message"), []);
});
