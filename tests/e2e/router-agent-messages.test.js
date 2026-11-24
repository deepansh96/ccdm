import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";

import { injectDiscordMessage } from "./support/bridge.js";
import { replaceFile } from "./support/platform.js";
import {
  OWNER_ID,
  createRouterWorkspace,
  rawRouterSocket,
  routerRegistry,
  runRouterCli,
  startRouter,
  waitFor,
  writeProjectKey,
  writeRootKey,
} from "./support/router.js";
import { cleanup, registerTeardownCallback } from "./support/teardown.js";

const RELOAD_ENV = { CCDM_ROUTER_REGISTRY_DEBOUNCE_MS: "20" };

test.afterEach(cleanup);

// A raw Router client returning its hello answer, pushed events, and request().
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

async function connectCapableRouterClient(workspace, project, key) {
  const { RouterClient } = createRequire(import.meta.url)(path.join(workspace.repoDir, "scripts/router/client.js"));
  const client = new RouterClient({
    socketPath: workspace.socketPath,
    project,
    key,
    role: "project",
    capabilities: ["agent_messages"],
  });
  const events = [];
  client.on("event", (event) => events.push(event));
  await client.connect();
  registerTeardownCallback(() => client.close());
  return { client, events };
}

function writeSpecialKey(workspace, filename, key) {
  const keysDir = path.join(workspace.routerStateDir, "keys");
  fs.mkdirSync(keysDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(keysDir, filename), `${key}\n`, { mode: 0o600 });
}

function replaceRegistry(workspace, registry) {
  const file = path.join(workspace.repoDir, "registry.json");
  replaceFile(file, `${JSON.stringify(registry, null, 2)}\n`);
}

async function afterReload(router, change) {
  await new Promise((resolve) => setTimeout(resolve, 100));
  const reloads = () => router.stdout.split("registry reloaded").length - 1;
  const before = reloads();
  await change();
  await waitFor(() => reloads() > before, () => `registry reload:\n${router.stdout}\n${router.stderr}`);
}

// Sends an ordinary owner message to `channelId` and waits for `client` to receive
// it, proving every earlier event on that connection would already have arrived.
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

test("a granted Agent Request reaches a live capable Channel Conversation and its Agent Reply comes back", async () => {
  const workspace = createRouterWorkspace(routerRegistry({
    demo: { channel_id: "demo-channel", type: "claude", transport: "router", agent_message_targets: ["beta"] },
    beta: { channel_id: "beta-channel", type: "codex", transport: "router" },
  }));
  writeProjectKey(workspace, "demo", "demo-key");
  writeProjectKey(workspace, "beta", "beta-key");
  await startRouter(workspace);

  const demo = await connectCapableRouterClient(workspace, "demo", "demo-key");
  const beta = await connectAgentProject(workspace, "beta", "beta-key");
  assert.equal(beta.hello.type, "hello_ok");

  const beforeSend = Date.now();
  const sent = await demo.client.request("agent_request", {
    target: "beta",
    text: "Check staging health",
    idempotency_key: "req-idem-1",
  });
  const afterSend = Date.now();

  assert.match(sent.request_id, /^req-[0-9a-f]{12}$/);
  assert.equal(sent.depth, 1);
  const expiresMs = Date.parse(sent.expires_at);
  assert.ok(
    expiresMs >= beforeSend + 30 * 60_000 - 1000 && expiresMs <= afterSend + 30 * 60_000 + 1000,
    `expected 30m default expiry, got ${sent.expires_at}`,
  );

  const requestEvent = await waitFor(
    () => beta.events.find((event) => event.event === "agent_message" && event.kind === "request"),
    () => `beta request event: ${JSON.stringify(beta.events)}`,
  );
  assert.equal(typeof requestEvent.delivery_id, "string");
  assert.ok(requestEvent.delivery_id.length > 0);
  assert.equal(requestEvent.request_id, sent.request_id);
  assert.equal(requestEvent.text, "Check staging health");
  assert.equal(requestEvent.expires_at, sent.expires_at);
  assert.equal(requestEvent.depth, 1);
  assert.equal(requestEvent.post, null);
  assert.ok(!Number.isNaN(Date.parse(requestEvent.ts)));
  assert.deepEqual(requestEvent.from, {
    project: "demo",
    provider: "claude",
    conversation_id: "demo-channel",
  });

  const ack = await beta.request("agent_message_ack", { delivery_id: requestEvent.delivery_id });
  assert.equal(ack.ok, true, JSON.stringify(ack));
  assert.deepEqual(ack.result, {});

  const replied = await beta.request("agent_reply", {
    request_id: sent.request_id,
    text: "Staging is green",
    idempotency_key: "reply-idem-1",
  });
  assert.equal(replied.ok, true, JSON.stringify(replied));
  assert.deepEqual(replied.result, {
    request_id: sent.request_id,
    delivered_to_live_session: true,
  });

  const replyEvent = await waitFor(
    () => demo.events.find((event) => event.event === "agent_message" && event.kind === "reply"),
    () => `demo reply event: ${JSON.stringify(demo.events)}`,
  );
  assert.equal(typeof replyEvent.delivery_id, "string");
  assert.ok(replyEvent.delivery_id.length > 0);
  assert.equal(replyEvent.request_id, sent.request_id);
  assert.equal(replyEvent.text, "Staging is green");
  assert.equal(replyEvent.post, null);
  assert.ok(!Number.isNaN(Date.parse(replyEvent.ts)));
  assert.deepEqual(replyEvent.from, {
    project: "beta",
    provider: "codex",
    conversation_id: "beta-channel",
  });
  assert.equal(replyEvent.expires_at, undefined);
  assert.equal(replyEvent.depth, undefined);

  const replyAck = await demo.client.request("agent_message_ack", { delivery_id: replyEvent.delivery_id });
  assert.deepEqual(replyAck, {});
});

test("grants are one-way, self-grant is required for self-sends, and unknown, root, and remote targets are not_granted", async () => {
  const workspace = createRouterWorkspace({
    ...routerRegistry({
      demo: {
        channel_id: "demo-channel",
        type: "claude",
        transport: "router",
        agent_message_targets: ["beta", "ghost", "root", "far"],
      },
      beta: { channel_id: "beta-channel", type: "codex", transport: "router", agent_message_targets: ["beta"] },
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
  writeProjectKey(workspace, "demo", "demo-key");
  writeProjectKey(workspace, "beta", "beta-key");
  writeProjectKey(workspace, "far", "far-key");
  await startRouter(workspace);

  const demo = await connectAgentProject(workspace, "demo", "demo-key");
  const beta = await connectAgentProject(workspace, "beta", "beta-key");
  const far = await connectAgentProject(workspace, "far", "far-key");

  // Argument shape fails before grant checks.
  const badArgs = await beta.request("agent_request", { target: "", text: "hi", idempotency_key: "k" });
  assert.equal(badArgs.ok, false);
  assert.equal(badArgs.error.code, "invalid_args");

  // Reverse direction of A -> B grant is not_granted.
  const reverse = await beta.request("agent_request", { target: "demo", text: "reverse", idempotency_key: "rev-1" });
  assert.equal(reverse.ok, false);
  assert.equal(reverse.error.code, "not_granted");

  // Without self-grant, demo -> demo is not_granted.
  const selfDenied = await demo.request("agent_request", { target: "demo", text: "self", idempotency_key: "self-no" });
  assert.equal(selfDenied.ok, false);
  assert.equal(selfDenied.error.code, "not_granted");

  // With self-grant, beta -> beta works end-to-end.
  const selfSent = await beta.request("agent_request", { target: "beta", text: "self check", idempotency_key: "self-ok" });
  assert.equal(selfSent.ok, true, JSON.stringify(selfSent));
  const selfReq = await waitFor(
    () => beta.events.find((event) => event.event === "agent_message" && event.request_id === selfSent.result.request_id),
    () => `beta self request: ${JSON.stringify(beta.events)}`,
  );
  assert.equal(selfReq.from.project, "beta");
  const selfReply = await beta.request("agent_reply", {
    request_id: selfSent.result.request_id,
    text: "self answer",
    idempotency_key: "self-reply",
  });
  assert.equal(selfReply.ok, true, JSON.stringify(selfReply));
  assert.equal(selfReply.result.delivered_to_live_session, true);
  await waitFor(
    () => beta.events.some((event) => event.event === "agent_message" && event.kind === "reply"
      && event.request_id === selfSent.result.request_id),
    () => `beta self reply: ${JSON.stringify(beta.events)}`,
  );

  // Unknown project, root, remote target, and remote sender are all not_granted.
  for (const [label, sender, target] of [
    ["unknown", demo, "ghost"],
    ["unlisted-unknown", beta, "missing"],
    ["root", demo, "root"],
    ["remote-target", demo, "far"],
    ["remote-sender", far, "beta"],
  ]) {
    const response = await sender.request("agent_request", {
      target,
      text: `check ${label}`,
      idempotency_key: `k-${label}`,
    });
    assert.equal(response.ok, false, `${label} should fail`);
    assert.equal(response.error.code, "not_granted", `${label}: ${JSON.stringify(response)}`);
  }
});

test("an offline or incapable target fails with target_offline at once and gets nothing after connecting", async () => {
  const workspace = createRouterWorkspace(routerRegistry({
    demo: { channel_id: "demo-channel", type: "claude", transport: "router", agent_message_targets: ["beta"] },
    beta: { channel_id: "beta-channel", type: "codex", transport: "router" },
  }));
  writeProjectKey(workspace, "demo", "demo-key");
  writeProjectKey(workspace, "beta", "beta-key");
  await startRouter(workspace);

  const demo = await connectAgentProject(workspace, "demo", "demo-key");

  // 1. No listener connected at all.
  const noListener = await demo.request("agent_request", {
    target: "beta",
    text: "anyone home?",
    idempotency_key: "off-1",
  });
  assert.equal(noListener.ok, false);
  assert.equal(noListener.error.code, "target_offline");

  // 2. Listener connected WITHOUT agent_messages capability.
  const incapableBeta = await rawClient(workspace, { role: "project", project: "beta", key: "beta-key" });
  assert.equal(incapableBeta.hello.type, "hello_ok");
  const incapable = await demo.request("agent_request", {
    target: "beta",
    text: "upgrade needed",
    idempotency_key: "off-2",
  });
  assert.equal(incapable.ok, false);
  assert.equal(incapable.error.code, "target_offline");
  await fenceOwnerMessage(workspace, incapableBeta, "beta-channel", "fence-incapable");
  assert.deepEqual(incapableBeta.events.filter((event) => event.event === "agent_message"), []);

  // 3. Capable listener connects afterwards: receives none of the earlier offline attempts.
  const capableBeta = await connectAgentProject(workspace, "beta", "beta-key");
  await fenceOwnerMessage(workspace, capableBeta, "beta-channel", "fence-after-connect");
  assert.deepEqual(capableBeta.events.filter((event) => event.event === "agent_message"), []);
});

test("reply rejects unknown_request and already_replied, honours op-only callers, and binds delivery to sender launch", async () => {
  const workspace = createRouterWorkspace(routerRegistry({
    demo: { channel_id: "demo-channel", type: "claude", transport: "router", agent_message_targets: ["beta"] },
    beta: { channel_id: "beta-channel", type: "codex", transport: "router" },
    legacy: { channel_id: "legacy-channel", type: "claude", transport: "router" },
  }));
  writeProjectKey(workspace, "demo", "demo-key-1");
  writeProjectKey(workspace, "beta", "beta-key");
  writeProjectKey(workspace, "legacy", "legacy-key");
  await startRouter(workspace);

  const demo = await connectAgentProject(workspace, "demo", "demo-key-1");
  const demoOps = await rawClient(workspace, { role: "project", project: "demo", key: "demo-key-1", listener: false });
  const beta = await connectAgentProject(workspace, "beta", "beta-key");
  const betaOps = await rawClient(workspace, { role: "project", project: "beta", key: "beta-key", listener: false });
  const legacy = await connectAgentProject(workspace, "legacy", "legacy-key");

  // Send request through op-only connection (shares launch key with demo listener).
  const sent = await demoOps.request("agent_request", {
    target: "beta",
    text: "First request",
    idempotency_key: "op-req-1",
  });
  assert.equal(sent.ok, true, JSON.stringify(sent));
  const reqId = sent.result.request_id;
  await waitFor(
    () => beta.events.some((event) => event.event === "agent_message" && event.request_id === reqId),
    () => `beta request ${reqId}`,
  );

  // Unknown request ID and replies from unaddressed conversations fail with unknown_request.
  for (const [label, caller, id] of [
    ["nonexistent", beta, "req-000000000000"],
    ["third-party", legacy, reqId],
    ["sender-itself", demo, reqId],
  ]) {
    const refused = await caller.request("agent_reply", {
      request_id: id,
      text: "wrong",
      idempotency_key: `bad-reply-${label}`,
    });
    assert.equal(refused.ok, false, label);
    assert.equal(refused.error.code, "unknown_request", `${label}: ${JSON.stringify(refused)}`);
  }

  // First reply (via beta's op-only connection) succeeds and reaches demo's listener.
  const firstReply = await betaOps.request("agent_reply", {
    request_id: reqId,
    text: "Done",
    idempotency_key: "op-reply-1",
  });
  assert.equal(firstReply.ok, true, JSON.stringify(firstReply));
  assert.deepEqual(firstReply.result, { request_id: reqId, delivered_to_live_session: true });
  await waitFor(
    () => demo.events.some((event) => event.event === "agent_message" && event.kind === "reply" && event.request_id === reqId),
    () => `demo reply for ${reqId}`,
  );

  // Second reply to the same request is already_replied.
  const secondReply = await beta.request("agent_reply", {
    request_id: reqId,
    text: "Duplicate",
    idempotency_key: "op-reply-2",
  });
  assert.equal(secondReply.ok, false);
  assert.equal(secondReply.error.code, "already_replied");
  await fenceOwnerMessage(workspace, demo, "demo-channel", "fence-after-second-reply");
  assert.equal(
    demo.events.filter((event) => event.event === "agent_message" && event.request_id === reqId).length,
    1,
  );

  // Launch binding: if sender rotates to a new launch key before reply, reply is not delivered to the new launch.
  const sent2 = await demo.request("agent_request", {
    target: "beta",
    text: "Second request",
    idempotency_key: "req-2",
  });
  assert.equal(sent2.ok, true, JSON.stringify(sent2));
  writeProjectKey(workspace, "demo", "demo-key-2");
  await demo.closed;
  const demoNewLaunch = await connectAgentProject(workspace, "demo", "demo-key-2");

  const replyToOldLaunch = await beta.request("agent_reply", {
    request_id: sent2.result.request_id,
    text: "Late answer for old launch",
    idempotency_key: "reply-2",
  });
  assert.equal(replyToOldLaunch.ok, true, JSON.stringify(replyToOldLaunch));
  assert.deepEqual(replyToOldLaunch.result, {
    request_id: sent2.result.request_id,
    delivered_to_live_session: false,
  });
  await fenceOwnerMessage(workspace, demoNewLaunch, "demo-channel", "fence-new-launch");
  assert.deepEqual(demoNewLaunch.events.filter((event) => event.event === "agent_message"), []);

  // If the sender disconnects before the reply arrives, delivered_to_live_session is false.
  const demoTemp = await connectCapableRouterClient(workspace, "demo", "demo-key-2");
  const sent3 = await demoTemp.client.request("agent_request", {
    target: "beta",
    text: "Third request",
    idempotency_key: "req-3",
  });
  demoTemp.client.close();
  await waitFor(
    async () => {
      const status = JSON.parse((await runRouterCli(workspace, ["status", "--json"])).stdout);
      return !status.sessions.some((session) => session.project === "demo");
    },
    () => "demo listener disconnect",
  );
  const replyOfflineSender = await beta.request("agent_reply", {
    request_id: sent3.request_id,
    text: "Sender went away",
    idempotency_key: "reply-3",
  });
  assert.equal(replyOfflineSender.ok, true, JSON.stringify(replyOfflineSender));
  assert.deepEqual(replyOfflineSender.result, {
    request_id: sent3.request_id,
    delivered_to_live_session: false,
  });
});

test("agent_message_ack is refused from any connection other than the addressed listener", async () => {
  const workspace = createRouterWorkspace(routerRegistry({
    demo: { channel_id: "demo-channel", type: "claude", transport: "router", agent_message_targets: ["beta"] },
    beta: { channel_id: "beta-channel", type: "codex", transport: "router" },
    legacy: { channel_id: "legacy-channel", type: "claude", transport: "router" },
  }));
  writeProjectKey(workspace, "demo", "demo-key");
  writeProjectKey(workspace, "beta", "beta-key-1");
  writeProjectKey(workspace, "legacy", "legacy-key");
  await startRouter(workspace);

  const demo = await connectAgentProject(workspace, "demo", "demo-key");
  const beta = await connectAgentProject(workspace, "beta", "beta-key-1");
  const betaOps = await rawClient(workspace, { role: "project", project: "beta", key: "beta-key-1", listener: false });
  const legacy = await connectAgentProject(workspace, "legacy", "legacy-key");

  const sent = await demo.request("agent_request", {
    target: "beta",
    text: "Ack check",
    idempotency_key: "ack-req-1",
  });
  assert.equal(sent.ok, true, JSON.stringify(sent));
  const delivery = await waitFor(
    () => beta.events.find((event) => event.event === "agent_message" && event.request_id === sent.result.request_id),
    () => `beta delivery: ${JSON.stringify(beta.events)}`,
  );

  // Missing delivery_id is invalid_args.
  const badAck = await beta.request("agent_message_ack", {});
  assert.equal(badAck.ok, false);
  assert.equal(badAck.error.code, "invalid_args");

  // Sender listener, third project, op-only connection of target, and unknown delivery_id are all refused.
  for (const [label, caller, deliveryId] of [
    ["sender", demo, delivery.delivery_id],
    ["third-project", legacy, delivery.delivery_id],
    ["target-op-only", betaOps, delivery.delivery_id],
    ["unknown-delivery", beta, "del-000000000000"],
  ]) {
    const refused = await caller.request("agent_message_ack", { delivery_id: deliveryId });
    assert.equal(refused.ok, false, `${label} ack should be refused`);
    assert.equal(refused.error.code, "forbidden", `${label}: ${JSON.stringify(refused)}`);
  }

  // Addressed listener succeeds.
  const accepted = await beta.request("agent_message_ack", { delivery_id: delivery.delivery_id });
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
  assert.deepEqual(accepted.result, {});

  // A new launch of the same target conversation cannot ack a previous launch's delivery.
  const sent2 = await demo.request("agent_request", {
    target: "beta",
    text: "Ack launch check",
    idempotency_key: "ack-req-2",
  });
  const delivery2 = await waitFor(
    () => beta.events.find((event) => event.event === "agent_message" && event.request_id === sent2.result.request_id),
    () => `beta delivery2: ${JSON.stringify(beta.events)}`,
  );
  writeProjectKey(workspace, "beta", "beta-key-2");
  await beta.closed;
  const betaNewLaunch = await connectAgentProject(workspace, "beta", "beta-key-2");
  const wrongLaunchAck = await betaNewLaunch.request("agent_message_ack", { delivery_id: delivery2.delivery_id });
  assert.equal(wrongLaunchAck.ok, false);
  assert.equal(wrongLaunchAck.error.code, "forbidden");
});

test("root, observer, supervisor and status get forbidden for all three ops and receive no agent_message events", async () => {
  const workspace = createRouterWorkspace({
    ...routerRegistry({
      demo: { channel_id: "demo-channel", type: "claude", transport: "router", agent_message_targets: ["beta"] },
      beta: { channel_id: "beta-channel", type: "codex", transport: "router" },
    }),
    root_channels: ["root-channel"],
  });
  writeProjectKey(workspace, "demo", "demo-key");
  writeProjectKey(workspace, "beta", "beta-key");
  writeRootKey(workspace, "root-key");
  writeSpecialKey(workspace, ".observer.key", "observer-key");
  writeSpecialKey(workspace, ".supervisor.key", "supervisor-key");
  await startRouter(workspace);

  const demo = await connectAgentProject(workspace, "demo", "demo-key");
  const beta = await connectAgentProject(workspace, "beta", "beta-key");
  const root = await rawClient(workspace, { role: "root", key: "root-key" });
  const observer = await rawClient(workspace, { role: "observer", key: "observer-key" });
  const supervisor = await rawClient(workspace, { role: "supervisor", key: "supervisor-key" });
  const statusClient = await rawClient(workspace, { role: "status" });

  for (const [name, client] of [
    ["root", root],
    ["observer", observer],
    ["supervisor", supervisor],
    ["status", statusClient],
  ]) {
    assert.equal(client.hello.type, "hello_ok", name);
    for (const [op, args] of [
      ["agent_request", { target: "beta", text: "nope", idempotency_key: `k-${name}-1` }],
      ["agent_reply", { request_id: "req-000000000000", text: "nope", idempotency_key: `k-${name}-2` }],
      ["agent_message_ack", { delivery_id: "del-000000000000" }],
    ]) {
      const response = await client.request(op, args);
      assert.equal(response.ok, false, `${name} ${op}`);
      assert.equal(response.error.code, "forbidden", `${name} ${op}: ${JSON.stringify(response)}`);
    }
  }

  // Run a full exchange and verify root, observer, and supervisor see no agent_message events.
  const sent = await demo.request("agent_request", {
    target: "beta",
    text: "Quiet exchange",
    idempotency_key: "quiet-req",
  });
  assert.equal(sent.ok, true, JSON.stringify(sent));
  const reqEvent = await waitFor(
    () => beta.events.find((event) => event.event === "agent_message" && event.request_id === sent.result.request_id),
    () => `beta quiet request`,
  );
  await beta.request("agent_message_ack", { delivery_id: reqEvent.delivery_id });
  const replied = await beta.request("agent_reply", {
    request_id: sent.result.request_id,
    text: "Quiet reply",
    idempotency_key: "quiet-reply",
  });
  assert.equal(replied.ok, true, JSON.stringify(replied));
  await waitFor(
    () => demo.events.some((event) => event.event === "agent_message" && event.kind === "reply"),
    () => `demo quiet reply`,
  );

  // Fence root and observer with ordinary messages so any misplaced event would already have landed.
  await fenceOwnerMessage(workspace, root, "root-channel", "fence-root");
  await fenceOwnerMessage(workspace, observer, "demo-channel", "fence-observer");
  assert.deepEqual(root.events.filter((event) => event.event === "agent_message"), []);
  assert.deepEqual(observer.events.filter((event) => event.event === "agent_message"), []);
  assert.deepEqual(supervisor.events.filter((event) => event.event === "agent_message"), []);
});

test("hot-reloading agent_message_targets updates the next send without restart and invalid values keep the last good table", async () => {
  const workspace = createRouterWorkspace(routerRegistry({
    demo: { channel_id: "demo-channel", type: "claude", transport: "router" },
    beta: { channel_id: "beta-channel", type: "codex", transport: "router" },
  }));
  writeProjectKey(workspace, "demo", "demo-key");
  writeProjectKey(workspace, "beta", "beta-key");
  const router = await startRouter(workspace, { env: RELOAD_ENV });

  const demo = await connectAgentProject(workspace, "demo", "demo-key");
  const beta = await connectAgentProject(workspace, "beta", "beta-key");

  // Initially ungranted.
  const beforeGrant = await demo.request("agent_request", {
    target: "beta",
    text: "Before grant",
    idempotency_key: "reload-1",
  });
  assert.equal(beforeGrant.ok, false);
  assert.equal(beforeGrant.error.code, "not_granted");

  // Add grant -> next send succeeds without restarting Router or sessions.
  await afterReload(router, () => replaceRegistry(workspace, routerRegistry({
    demo: { channel_id: "demo-channel", type: "claude", transport: "router", agent_message_targets: ["beta"] },
    beta: { channel_id: "beta-channel", type: "codex", transport: "router" },
  })));
  const afterGrant = await demo.request("agent_request", {
    target: "beta",
    text: "After grant",
    idempotency_key: "reload-2",
  });
  assert.equal(afterGrant.ok, true, JSON.stringify(afterGrant));
  await waitFor(
    () => beta.events.some((event) => event.event === "agent_message" && event.request_id === afterGrant.result.request_id),
    () => `beta event after grant reload`,
  );

  // Invalid agent_message_targets keeps the last good table and shows in router status.
  const goodStatus = JSON.parse((await runRouterCli(workspace, ["status", "--json"])).stdout);
  assert.equal(goodStatus.registry_error, null);
  for (const badValue of ["beta", [""], ["   "], [123], null]) {
    const failures = () => router.stdout.split("registry_reload_failed").length - 1;
    const before = failures();
    await new Promise((resolve) => setTimeout(resolve, 100));
    replaceRegistry(workspace, routerRegistry({
      demo: { channel_id: "demo-channel", type: "claude", transport: "router", agent_message_targets: badValue },
      beta: { channel_id: "beta-channel", type: "codex", transport: "router" },
    }));
    await waitFor(() => failures() > before, () => `reload failure for ${JSON.stringify(badValue)}:\n${router.stdout}`);
    const statusJson = JSON.parse((await runRouterCli(workspace, ["status", "--json"])).stdout);
    assert.equal(statusJson.registry_loaded_at, goodStatus.registry_loaded_at);
    assert.match(statusJson.registry_error.message, /agent_message_targets/);
  }
  const duringInvalid = await demo.request("agent_request", {
    target: "beta",
    text: "Still granted under last good table",
    idempotency_key: "reload-3",
  });
  assert.equal(duringInvalid.ok, true, JSON.stringify(duringInvalid));

  // Remove grant -> next send is not_granted and status clears the error.
  await afterReload(router, () => replaceRegistry(workspace, routerRegistry({
    demo: { channel_id: "demo-channel", type: "claude", transport: "router", agent_message_targets: [] },
    beta: { channel_id: "beta-channel", type: "codex", transport: "router" },
  })));
  const restoredStatus = JSON.parse((await runRouterCli(workspace, ["status", "--json"])).stdout);
  assert.equal(restoredStatus.registry_error, null);
  const afterRevoke = await demo.request("agent_request", {
    target: "beta",
    text: "After revoke",
    idempotency_key: "reload-4",
  });
  assert.equal(afterRevoke.ok, false);
  assert.equal(afterRevoke.error.code, "not_granted");

  // Neither the Router nor the sessions restarted.
  assert.equal(router.stdout.split("router ready").length - 1, 1);
  assert.equal(demo.events.some((event) => event.event === "revoked"), false);
  assert.equal(beta.events.some((event) => event.event === "revoked"), false);
});

test("state changes append to the ledger before taking effect while ordinary owner messages keep routing", async () => {
  const workspace = createRouterWorkspace(routerRegistry({
    demo: { channel_id: "demo-channel", type: "claude", transport: "router", agent_message_targets: ["beta"] },
    beta: { channel_id: "beta-channel", type: "codex", transport: "router" },
  }));
  writeProjectKey(workspace, "demo", "demo-key");
  writeProjectKey(workspace, "beta", "beta-key");
  await startRouter(workspace);

  const demo = await connectAgentProject(workspace, "demo", "demo-key");
  const beta = await connectAgentProject(workspace, "beta", "beta-key");
  const ledgerFile = path.join(workspace.routerStateDir, "agent-messages.jsonl");

  // Block ledger writes before sending: request fails with ledger_unavailable,
  // nothing reaches beta, and ordinary owner messages still route.
  fs.mkdirSync(ledgerFile);
  const blockedSend = await demo.request("agent_request", {
    target: "beta",
    text: "Should not deliver",
    idempotency_key: "ledger-blocked-1",
  });
  assert.equal(blockedSend.ok, false);
  assert.equal(blockedSend.error.code, "ledger_unavailable");
  await fenceOwnerMessage(workspace, demo, "demo-channel", "owner-while-ledger-blocked-demo");
  await fenceOwnerMessage(workspace, beta, "beta-channel", "owner-while-ledger-blocked-beta");
  assert.deepEqual(beta.events.filter((event) => event.event === "agent_message"), []);

  // Restore ledger path: exchange starts, ordinary owner messages route while it is in flight.
  fs.rmdirSync(ledgerFile);
  const sent = await demo.request("agent_request", {
    target: "beta",
    text: "In-flight request",
    idempotency_key: "ledger-ok-1",
  });
  assert.equal(sent.ok, true, JSON.stringify(sent));
  await waitFor(
    () => beta.events.some((event) => event.event === "agent_message" && event.request_id === sent.result.request_id),
    () => `beta in-flight request`,
  );
  await fenceOwnerMessage(workspace, demo, "demo-channel", "owner-in-flight-demo");
  await fenceOwnerMessage(workspace, beta, "beta-channel", "owner-in-flight-beta");

  // Block ledger writes before replying: reply fails with ledger_unavailable,
  // nothing reaches demo, and the exchange stays open so retrying after recovery succeeds.
  fs.unlinkSync(ledgerFile);
  fs.mkdirSync(ledgerFile);
  const blockedReply = await beta.request("agent_reply", {
    request_id: sent.result.request_id,
    text: "Blocked reply",
    idempotency_key: "ledger-blocked-reply",
  });
  assert.equal(blockedReply.ok, false);
  assert.equal(blockedReply.error.code, "ledger_unavailable");
  await fenceOwnerMessage(workspace, demo, "demo-channel", "owner-after-blocked-reply");
  assert.deepEqual(demo.events.filter((event) => event.event === "agent_message"), []);

  fs.rmdirSync(ledgerFile);
  const replied = await beta.request("agent_reply", {
    request_id: sent.result.request_id,
    text: "Recovered reply",
    idempotency_key: "ledger-recovered-reply",
  });
  assert.equal(replied.ok, true, JSON.stringify(replied));
  assert.deepEqual(replied.result, {
    request_id: sent.result.request_id,
    delivered_to_live_session: true,
  });
  await waitFor(
    () => demo.events.some((event) => event.event === "agent_message" && event.kind === "reply"
      && event.request_id === sent.result.request_id),
    () => `demo recovered reply`,
  );
});
