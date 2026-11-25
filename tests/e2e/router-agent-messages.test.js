import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
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
  runRouterCli,
  startRouter,
  waitFor,
  writeProjectKey,
  writeRootKey,
} from "./support/router.js";
import { readState, updateState } from "./support/state.js";
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

async function ensureWebhooks(workspace, projects) {
  for (const project of projects) {
    const result = await runRouterCli(workspace, ["ensure-webhook", project]);
    assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  }
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
  await ensureWebhooks(workspace, ["demo", "beta"]);
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
  assert.equal(requestEvent.post.channel_id, "beta-channel");
  assert.equal(typeof requestEvent.post.message_id, "string");
  assert.ok(requestEvent.post.message_id.length > 0);
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
  assert.equal(replyEvent.post.channel_id, "demo-channel");
  assert.equal(typeof replyEvent.post.message_id, "string");
  assert.ok(replyEvent.post.message_id.length > 0);
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
  await ensureWebhooks(workspace, ["demo", "beta"]);
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
  await ensureWebhooks(workspace, ["demo", "beta"]);
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
  await ensureWebhooks(workspace, ["demo", "beta", "legacy"]);
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
  await ensureWebhooks(workspace, ["demo", "beta", "legacy"]);
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

test("root, observer, supervisor and status get forbidden for all four ops and receive no agent_message events", async () => {
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
  await ensureWebhooks(workspace, ["demo", "beta"]);
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
      ["agent_targets", {}],
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
  await ensureWebhooks(workspace, ["demo", "beta"]);
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
  await ensureWebhooks(workspace, ["demo", "beta"]);
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

test("accepted requests and replies post linked records in both conversations, mark request posts ✅, and deliver only after both request records exist", async () => {
  const workspace = createRouterWorkspace(routerRegistry({
    demo: { channel_id: "demo-channel", type: "claude", transport: "router", agent_message_targets: ["beta"] },
    beta: { channel_id: "beta-channel", type: "codex", transport: "router" },
  }));
  await routerWithWebhooks(workspace, ["demo", "beta"]);
  updateState(workspace.stateDir, (state) => {
    state.fixtures.discord.requestLog = [];
    state.fixtures.discord.rateLimits = [
      { method: "POST", path: "/api/v10/channels/beta-channel/messages", count: 1, retryAfter: 0.4, bucket: "beta-post" },
    ];
  });

  const demo = await connectCapableRouterClient(workspace, "demo", "demo-key");
  const beta = await connectAgentProject(workspace, "beta", "beta-key");

  // agent_request returns immediately without waiting for the 400 ms receiver-side post delay.
  const startedAt = Date.now();
  const sent = await demo.client.request("agent_request", {
    target: "beta",
    text: "Check staging health",
    idempotency_key: "rec-req-1",
    context_pct: 42,
  });
  const callElapsed = Date.now() - startedAt;
  assert.ok(callElapsed < 350, `agent_request should not await record posting (took ${callElapsed} ms)`);
  const reqId = sent.request_id;

  // Before the delayed receiver-side record lands, beta gets nothing (proven by a fence owner message).
  await fenceOwnerMessage(workspace, beta, "beta-channel", "fence-before-records");
  assert.deepEqual(beta.events.filter((event) => event.event === "agent_message"), []);

  // Once both records exist, beta receives the request event with `post` set to the receiver-side record.
  const requestEvent = await waitFor(
    () => beta.events.find((event) => event.event === "agent_message" && event.kind === "request"),
    () => `beta request event: ${JSON.stringify(beta.events)}`,
  );
  assert.ok(Date.now() - startedAt >= 350, "delivery waited for the receiver-side post");

  const afterRequest = readState(workspace.stateDir).fixtures.discord;
  const senderReqPost = afterRequest.messages.find((message) => message.channelId === "demo-channel" && message.webhookId);
  const receiverReqPost = afterRequest.messages.find((message) => message.channelId === "beta-channel" && !message.webhookId);
  assert.ok(senderReqPost, `expected sender-side request post: ${JSON.stringify(afterRequest.messages)}`);
  assert.ok(receiverReqPost, `expected receiver-side request post: ${JSON.stringify(afterRequest.messages)}`);
  assert.deepEqual(requestEvent.post, { channel_id: "beta-channel", message_id: receiverReqPost.id });

  const senderReqLink = `https://discord.com/channels/guild-id/demo-channel/${senderReqPost.id}`;
  const receiverReqLink = `https://discord.com/channels/guild-id/beta-channel/${receiverReqPost.id}`;
  assert.equal(senderReqPost.username, "demo-claude · 42%");
  assert.equal(
    senderReqPost.content,
    `-# ⇄ Agent Request to **beta-codex** · ${reqId} · [counterpart](${receiverReqLink})\nCheck staging health`,
  );
  assert.equal(receiverReqPost.authorization, `Bot ${ROOT_TOKEN}`);
  assert.deepEqual(receiverReqPost.allowedMentions, { parse: [] });
  assert.equal(
    receiverReqPost.content,
    `-# ⇄ Agent Request from **demo-claude** · ${reqId} · [counterpart](${senderReqLink})\nCheck staging health`,
  );

  // Reply posts linked records the other way, reacts ✅ on both request posts, and delivers with `post`.
  const replied = await beta.request("agent_reply", {
    request_id: reqId,
    text: "Staging is green",
    idempotency_key: "rec-reply-1",
    context_pct: 25,
  });
  assert.equal(replied.ok, true, JSON.stringify(replied));

  const replyEvent = await waitFor(
    () => demo.events.find((event) => event.event === "agent_message" && event.kind === "reply"),
    () => `demo reply event: ${JSON.stringify(demo.events)}`,
  );

  const afterReply = readState(workspace.stateDir).fixtures.discord;
  const replierReplyPost = afterReply.messages.find((message) => message.channelId === "beta-channel" && message.webhookId);
  const receiverReplyPost = afterReply.messages.find((message) => message.channelId === "demo-channel" && !message.webhookId);
  assert.ok(replierReplyPost, `expected replier-side reply post: ${JSON.stringify(afterReply.messages)}`);
  assert.ok(receiverReplyPost, `expected receiver-side reply post: ${JSON.stringify(afterReply.messages)}`);
  assert.deepEqual(replyEvent.post, { channel_id: "demo-channel", message_id: receiverReplyPost.id });

  const replierReplyLink = `https://discord.com/channels/guild-id/beta-channel/${replierReplyPost.id}`;
  const receiverReplyLink = `https://discord.com/channels/guild-id/demo-channel/${receiverReplyPost.id}`;
  assert.equal(replierReplyPost.username, "beta-codex · 25%");
  assert.equal(
    replierReplyPost.content,
    `-# ⇄ Agent Reply to **demo-claude** · ${reqId} · [counterpart](${receiverReplyLink})\nStaging is green`,
  );
  assert.equal(receiverReplyPost.authorization, `Bot ${ROOT_TOKEN}`);
  assert.deepEqual(receiverReplyPost.allowedMentions, { parse: [] });
  assert.equal(
    receiverReplyPost.content,
    `-# ⇄ Agent Reply from **beta-codex** · ${reqId} · [counterpart](${replierReplyLink})\nStaging is green`,
  );

  // Root reacts ✅ on both request posts.
  const checkMarks = (afterReply.reactions ?? []).filter((reaction) => reaction.emoji === encodeURIComponent("✅"));
  assert.deepEqual(checkMarks, [
    { authorization: `Bot ${ROOT_TOKEN}`, channelId: "demo-channel", emoji: encodeURIComponent("✅"), messageId: senderReqPost.id },
    { authorization: `Bot ${ROOT_TOKEN}`, channelId: "beta-channel", emoji: encodeURIComponent("✅"), messageId: receiverReqPost.id },
  ]);

  // Every record POST and PATCH carried empty allowed_mentions.
  const writeRequests = afterReply.requestLog.filter((entry) =>
    (entry.method === "POST" || entry.method === "PATCH")
    && (/^\/api\/v10\/webhooks\/[^/]+\/[^/]+/.test(entry.path) || /^\/api\/v10\/channels\/[^/]+\/messages/.test(entry.path)));
  assert.ok(writeRequests.length >= 6, `expected at least 6 record writes, got ${writeRequests.length}`);
  for (const entry of writeRequests) {
    assert.deepEqual(JSON.parse(entry.body).allowed_mentions, { parse: [] }, `${entry.method} ${entry.path}`);
  }
});

test("records over 2000 characters chunk cleanly with links and marks on the first chunk, and a failed link edit is logged without blocking delivery", async () => {
  const workspace = createRouterWorkspace(routerRegistry({
    demo: { channel_id: "demo-channel", type: "claude", transport: "router", agent_message_targets: ["beta"] },
    beta: { channel_id: "beta-channel", type: "codex", transport: "router" },
  }));
  const router = await routerWithWebhooks(workspace, ["demo", "beta"]);
  updateState(workspace.stateDir, (state) => {
    state.fixtures.discord.requestLog = [];
  });

  const demo = await connectAgentProject(workspace, "demo", "demo-key");
  const beta = await connectAgentProject(workspace, "beta", "beta-key");

  const longRequestText = `${"a".repeat(1400)}\n${"b".repeat(1300)}`;
  const sent = await demo.request("agent_request", {
    target: "beta",
    text: longRequestText,
    idempotency_key: "chunk-req-1",
    context_pct: 51,
  });
  assert.equal(sent.ok, true, JSON.stringify(sent));
  const reqId = sent.result.request_id;

  const reqEvent = await waitFor(
    () => beta.events.find((event) => event.event === "agent_message" && event.request_id === reqId),
    () => `beta chunked request: ${JSON.stringify(beta.events)}`,
  );

  const afterRequest = readState(workspace.stateDir).fixtures.discord;
  const senderReqChunks = afterRequest.messages.filter((message) => message.channelId === "demo-channel" && message.webhookId);
  const receiverReqChunks = afterRequest.messages.filter((message) => message.channelId === "beta-channel" && !message.webhookId);
  assert.ok(senderReqChunks.length >= 2, `expected chunked sender request, got ${senderReqChunks.length}`);
  assert.ok(receiverReqChunks.length >= 2, `expected chunked receiver request, got ${receiverReqChunks.length}`);
  for (const chunk of [...senderReqChunks, ...receiverReqChunks]) {
    assert.ok(chunk.content.length <= 2000, `chunk exceeded 2000 chars (${chunk.content.length})`);
  }

  // Links and `post` point to the first chunk of each record, and the body text is preserved intact.
  const senderFirst = senderReqChunks[0];
  const receiverFirst = receiverReqChunks[0];
  assert.deepEqual(reqEvent.post, { channel_id: "beta-channel", message_id: receiverFirst.id });
  const senderHeaderLine = senderFirst.content.slice(0, senderFirst.content.indexOf("\n"));
  const receiverHeaderLine = receiverFirst.content.slice(0, receiverFirst.content.indexOf("\n"));
  assert.equal(
    senderHeaderLine,
    `-# ⇄ Agent Request to **beta-codex** · ${reqId} · [counterpart](https://discord.com/channels/guild-id/beta-channel/${receiverFirst.id})`,
  );
  assert.equal(
    receiverHeaderLine,
    `-# ⇄ Agent Request from **demo-claude** · ${reqId} · [counterpart](https://discord.com/channels/guild-id/demo-channel/${senderFirst.id})`,
  );
  const stripHeader = (chunk) => chunk.content.slice(chunk.content.indexOf("\n") + 1);
  for (const chunks of [senderReqChunks, receiverReqChunks]) {
    for (const [index, chunk] of chunks.entries()) {
      assert.ok(chunk.content.startsWith("-# ⇄ Agent "), `chunk ${index + 1} missing prefix`);
      if (index > 0) {
        assert.equal(
          chunk.content.slice(0, chunk.content.indexOf("\n")),
          `-# ⇄ Agent Request · ${reqId} · part ${index + 1}/${chunks.length}`,
        );
      }
    }
  }
  const senderBody = senderReqChunks.map(stripHeader).join("");
  const receiverBody = receiverReqChunks.map(stripHeader).join("");
  assert.equal(senderBody, longRequestText);
  assert.equal(receiverBody, longRequestText);

  // Reply over 2000 characters also chunks, links on first chunks, and marks only the first request chunks ✅.
  const longReplyText = `${"c".repeat(1500)}\n${"d".repeat(1200)}`;
  const replied = await beta.request("agent_reply", {
    request_id: reqId,
    text: longReplyText,
    idempotency_key: "chunk-reply-1",
    context_pct: 33,
  });
  assert.equal(replied.ok, true, JSON.stringify(replied));

  const replyEvent = await waitFor(
    () => demo.events.find((event) => event.event === "agent_message" && event.kind === "reply" && event.request_id === reqId),
    () => `demo chunked reply: ${JSON.stringify(demo.events)}`,
  );

  const afterReply = readState(workspace.stateDir).fixtures.discord;
  const replierReplyChunks = afterReply.messages.filter((message) => message.channelId === "beta-channel" && message.webhookId);
  const receiverReplyChunks = afterReply.messages.filter((message) => message.channelId === "demo-channel" && !message.webhookId);
  assert.ok(replierReplyChunks.length >= 2, `expected chunked replier reply, got ${replierReplyChunks.length}`);
  assert.ok(receiverReplyChunks.length >= 2, `expected chunked receiver reply, got ${receiverReplyChunks.length}`);
  for (const chunk of [...replierReplyChunks, ...receiverReplyChunks]) {
    assert.ok(chunk.content.length <= 2000, `reply chunk exceeded 2000 chars (${chunk.content.length})`);
  }
  assert.deepEqual(replyEvent.post, { channel_id: "demo-channel", message_id: receiverReplyChunks[0].id });

  const checkMarks = (afterReply.reactions ?? []).filter((reaction) => reaction.emoji === encodeURIComponent("✅"));
  assert.deepEqual(checkMarks, [
    { authorization: `Bot ${ROOT_TOKEN}`, channelId: "demo-channel", emoji: encodeURIComponent("✅"), messageId: senderFirst.id },
    { authorization: `Bot ${ROOT_TOKEN}`, channelId: "beta-channel", emoji: encodeURIComponent("✅"), messageId: receiverFirst.id },
  ]);

  // Every chunk write carried empty allowed_mentions.
  const writeRequests = afterReply.requestLog.filter((entry) =>
    (entry.method === "POST" || entry.method === "PATCH")
    && (/^\/api\/v10\/webhooks\/[^/]+\/[^/]+/.test(entry.path) || /^\/api\/v10\/channels\/[^/]+\/messages/.test(entry.path)));
  for (const entry of writeRequests) {
    assert.deepEqual(JSON.parse(entry.body).allowed_mentions, { parse: [] }, `${entry.method} ${entry.path}`);
  }

  // A failed counterpart link edit is logged and does not block delivery.
  updateState(workspace.stateDir, (state) => {
    state.fixtures.discord.restFailures = [{ method: "PATCH", status: 500 }];
  });
  const sent2 = await demo.request("agent_request", {
    target: "beta",
    text: "Link edit may fail",
    idempotency_key: "chunk-req-2",
  });
  assert.equal(sent2.ok, true, JSON.stringify(sent2));
  const req2Event = await waitFor(
    () => beta.events.find((event) => event.event === "agent_message" && event.request_id === sent2.result.request_id),
    () => `beta event after failed link edit: ${JSON.stringify(beta.events)}`,
  );
  assert.equal(req2Event.post.channel_id, "beta-channel");
  await router.waitForOutput(new RegExp(`agent_message_link_edit_failed id=${sent2.result.request_id}`));
});

test("request record post failure marks the request failed, reacts ⚠️ if posted, notifies sender, delivers nothing to target, and refuses late replies with request_failed", async () => {
  const workspace = createRouterWorkspace(routerRegistry({
    demo: { channel_id: "demo-channel", type: "claude", transport: "router", agent_message_targets: ["beta"] },
    beta: { channel_id: "beta-channel", type: "codex", transport: "router" },
  }));
  await routerWithWebhooks(workspace, ["demo", "beta"], { env: { CCDM_ROUTER_RATE_LIMIT_MAX_WAIT_MS: "500" } });

  const demo = await connectAgentProject(workspace, "demo", "demo-key");
  const beta = await connectAgentProject(workspace, "beta", "beta-key");

  // 1. Sender-side record post fails (rate limit outlasts the Router's wait bound):
  // nothing posted in target, no ⚠️ reaction, notice with outcome=failed and post=null, reply -> request_failed.
  const demoWebhook = readState(workspace.stateDir).fixtures.discord.webhooks.find((w) => w.channel_id === "demo-channel");
  updateState(workspace.stateDir, (state) => {
    state.fixtures.discord.rateLimits = [
      { method: "POST", path: `/api/v10/webhooks/${demoWebhook.id}/${demoWebhook.token}`, count: null, retryAfter: 0.3, bucket: "demo-wh" },
    ];
  });
  const failedSender = await demo.request("agent_request", {
    target: "beta",
    text: "Cannot post sender side",
    idempotency_key: "fail-sender-1",
  });
  assert.equal(failedSender.ok, true, JSON.stringify(failedSender));
  const senderNotice = await waitFor(
    () => demo.events.find((event) => event.event === "agent_message" && event.kind === "notice"
      && event.request_id === failedSender.result.request_id),
    () => `demo sender failure notice: ${JSON.stringify(demo.events)}`,
  );
  assert.equal(senderNotice.outcome, "failed");
  assert.equal(senderNotice.post, null);
  assert.deepEqual(senderNotice.target, { project: "beta", provider: "codex", conversation_id: "beta-channel" });
  assert.equal(senderNotice.from, undefined);
  const ackNotice = await demo.request("agent_message_ack", { delivery_id: senderNotice.delivery_id });
  assert.equal(ackNotice.ok, true, JSON.stringify(ackNotice));

  await fenceOwnerMessage(workspace, beta, "beta-channel", "fence-after-sender-fail");
  assert.deepEqual(beta.events.filter((event) => event.event === "agent_message"), []);
  const afterSenderFail = readState(workspace.stateDir).fixtures.discord;
  assert.deepEqual(afterSenderFail.messages ?? [], []);
  assert.deepEqual(afterSenderFail.reactions ?? [], []);

  const replyToFailed1 = await beta.request("agent_reply", {
    request_id: failedSender.result.request_id,
    text: "Too late",
    idempotency_key: "reply-failed-1",
  });
  assert.equal(replyToFailed1.ok, false);
  assert.equal(replyToFailed1.error.code, "request_failed");

  // 2. Sender-side record posts, receiver-side record fails (500):
  // sender-side record gets ⚠️, target receives nothing, sender gets notice with post=sender record, reply -> request_failed.
  updateState(workspace.stateDir, (state) => {
    state.fixtures.discord.rateLimits = [];
    state.fixtures.discord.restFailures = [
      { method: "POST", path: "/api/v10/channels/beta-channel/messages", status: 500 },
    ];
  });
  const failedReceiver = await demo.request("agent_request", {
    target: "beta",
    text: "Cannot post receiver side",
    idempotency_key: "fail-receiver-1",
  });
  assert.equal(failedReceiver.ok, true, JSON.stringify(failedReceiver));

  const receiverNotice = await waitFor(
    () => demo.events.find((event) => event.event === "agent_message" && event.kind === "notice"
      && event.request_id === failedReceiver.result.request_id),
    () => `demo receiver failure notice: ${JSON.stringify(demo.events)}`,
  );
  const afterReceiverFail = readState(workspace.stateDir).fixtures.discord;
  const senderOnlyPost = afterReceiverFail.messages.find((message) => message.channelId === "demo-channel" && message.webhookId);
  assert.ok(senderOnlyPost, `expected sender-side post: ${JSON.stringify(afterReceiverFail.messages)}`);
  assert.deepEqual(
    afterReceiverFail.messages.filter((message) => message.channelId === "beta-channel"),
    [],
  );
  assert.equal(receiverNotice.outcome, "failed");
  assert.deepEqual(receiverNotice.post, { channel_id: "demo-channel", message_id: senderOnlyPost.id });
  assert.deepEqual(receiverNotice.target, { project: "beta", provider: "codex", conversation_id: "beta-channel" });
  assert.deepEqual(afterReceiverFail.reactions, [
    { authorization: `Bot ${ROOT_TOKEN}`, channelId: "demo-channel", emoji: encodeURIComponent("⚠️"), messageId: senderOnlyPost.id },
  ]);

  await fenceOwnerMessage(workspace, beta, "beta-channel", "fence-after-receiver-fail");
  assert.deepEqual(beta.events.filter((event) => event.event === "agent_message"), []);

  const replyToFailed2 = await beta.request("agent_reply", {
    request_id: failedReceiver.result.request_id,
    text: "Still cannot reply",
    idempotency_key: "reply-failed-2",
  });
  assert.equal(replyToFailed2.ok, false);
  assert.equal(replyToFailed2.error.code, "request_failed");
});

test("a reply whose record cannot be posted is still delivered and still marks both request posts ✅", async () => {
  const workspace = createRouterWorkspace(routerRegistry({
    demo: { channel_id: "demo-channel", type: "claude", transport: "router", agent_message_targets: ["beta"] },
    beta: { channel_id: "beta-channel", type: "codex", transport: "router" },
  }));
  await routerWithWebhooks(workspace, ["demo", "beta"]);

  const demo = await connectAgentProject(workspace, "demo", "demo-key");
  const beta = await connectAgentProject(workspace, "beta", "beta-key");
  const betaWebhook = readState(workspace.stateDir).fixtures.discord.webhooks.find((w) => w.channel_id === "beta-channel");

  // Case A: replier-side webhook record fails (500); receiver-side record posts and reply delivers with post.
  const sentA = await demo.request("agent_request", {
    target: "beta",
    text: "Question A",
    idempotency_key: "rfail-req-a",
  });
  await waitFor(
    () => beta.events.some((event) => event.event === "agent_message" && event.request_id === sentA.result.request_id),
    () => "beta request A",
  );
  updateState(workspace.stateDir, (state) => {
    state.fixtures.discord.restFailures = [
      { method: "POST", path: `/api/v10/webhooks/${betaWebhook.id}/${betaWebhook.token}`, status: 500 },
    ];
  });
  const replyA = await beta.request("agent_reply", {
    request_id: sentA.result.request_id,
    text: "Answer A",
    idempotency_key: "rfail-rep-a",
  });
  assert.equal(replyA.ok, true, JSON.stringify(replyA));
  const replyEventA = await waitFor(
    () => demo.events.find((event) => event.event === "agent_message" && event.kind === "reply"
      && event.request_id === sentA.result.request_id),
    () => `demo reply A: ${JSON.stringify(demo.events)}`,
  );
  assert.equal(replyEventA.text, "Answer A");
  assert.equal(replyEventA.post.channel_id, "demo-channel");
  const receiverPostA = readState(workspace.stateDir).fixtures.discord.messages.find((m) => m.id === replyEventA.post.message_id);
  assert.equal(receiverPostA.content, `-# ⇄ Agent Reply from **beta-codex** · ${sentA.result.request_id}\nAnswer A`);

  // Case B: receiver-side bot record fails (500); reply still delivers with post: null and ✅ marks land.
  const sentB = await demo.request("agent_request", {
    target: "beta",
    text: "Question B",
    idempotency_key: "rfail-req-b",
  });
  await waitFor(
    () => beta.events.some((event) => event.event === "agent_message" && event.request_id === sentB.result.request_id),
    () => "beta request B",
  );
  updateState(workspace.stateDir, (state) => {
    state.fixtures.discord.restFailures = [
      { method: "POST", path: "/api/v10/channels/demo-channel/messages", status: 500 },
    ];
  });
  const replyB = await beta.request("agent_reply", {
    request_id: sentB.result.request_id,
    text: "Answer B",
    idempotency_key: "rfail-rep-b",
  });
  assert.equal(replyB.ok, true, JSON.stringify(replyB));
  const replyEventB = await waitFor(
    () => demo.events.find((event) => event.event === "agent_message" && event.kind === "reply"
      && event.request_id === sentB.result.request_id),
    () => `demo reply B: ${JSON.stringify(demo.events)}`,
  );
  assert.equal(replyEventB.text, "Answer B");
  assert.equal(replyEventB.post, null);

  const checkMarks = (readState(workspace.stateDir).fixtures.discord.reactions ?? [])
    .filter((reaction) => reaction.emoji === encodeURIComponent("✅"));
  assert.equal(checkMarks.length, 4, `expected 4 ✅ marks across both exchanges, got ${JSON.stringify(checkMarks)}`);
});

test("target_offline posts one ⚠️-marked record in sender conversation only, not_granted posts nothing, and Session Scope is unchanged", async () => {
  const workspace = createRouterWorkspace(routerRegistry({
    demo: { channel_id: "demo-channel", type: "claude", transport: "router", agent_message_targets: ["beta"] },
    beta: { channel_id: "beta-channel", type: "codex", transport: "router" },
  }));
  const router = await routerWithWebhooks(workspace, ["demo", "beta"]);
  updateState(workspace.stateDir, (state) => {
    state.fixtures.discord.requestLog = [];
  });

  const demo = await connectAgentProject(workspace, "demo", "demo-key");

  // 1. target_offline posts exactly one record in demo-channel with `not delivered: target_offline` and ⚠️, nothing in beta-channel.
  const offline = await demo.request("agent_request", {
    target: "beta",
    text: "Anyone there?",
    idempotency_key: "off-rec-1",
    context_pct: 18,
  });
  assert.equal(offline.ok, false);
  assert.equal(offline.error.code, "target_offline");

  const offlineState = await waitFor(() => {
    const discord = readState(workspace.stateDir).fixtures.discord;
    const hasMsg = (discord.messages ?? []).some((m) => m.channelId === "demo-channel" && m.webhookId);
    const hasWarn = (discord.reactions ?? []).some((r) => r.emoji === encodeURIComponent("⚠️"));
    return hasMsg && hasWarn ? discord : null;
  }, () => `offline record and ⚠️: ${JSON.stringify(readState(workspace.stateDir).fixtures.discord)}`);

  assert.equal(offlineState.messages.length, 1, JSON.stringify(offlineState.messages));
  const [offlineMsg] = offlineState.messages;
  assert.equal(offlineMsg.channelId, "demo-channel");
  assert.equal(offlineMsg.username, "demo-claude · 18%");
  assert.match(
    offlineMsg.content,
    /^-# ⇄ Agent Request to \*\*beta-codex\*\* · req-[0-9a-f]{12} · not delivered: target_offline\nAnyone there\?$/,
  );
  assert.deepEqual(offlineState.reactions, [
    { authorization: `Bot ${ROOT_TOKEN}`, channelId: "demo-channel", emoji: encodeURIComponent("⚠️"), messageId: offlineMsg.id },
  ]);
  const offlinePostLog = offlineState.requestLog.find((entry) => entry.method === "POST" && entry.path.includes("/webhooks/"));
  assert.deepEqual(JSON.parse(offlinePostLog.body).allowed_mentions, { parse: [] });

  // 2. not_granted posts nothing in either conversation.
  const beta = await connectAgentProject(workspace, "beta", "beta-key");
  const denied = await beta.request("agent_request", {
    target: "demo",
    text: "Should never post",
    idempotency_key: "denied-rec-1",
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.error.code, "not_granted");

  // Run an ordinary exchange (demo -> beta -> demo) so we have records in both conversations and also fence the denied send.
  const sent = await demo.request("agent_request", {
    target: "beta",
    text: "Scope test request",
    idempotency_key: "scope-req-1",
  });
  assert.equal(sent.ok, true, JSON.stringify(sent));
  const reqEvent = await waitFor(
    () => beta.events.find((event) => event.event === "agent_message" && event.request_id === sent.result.request_id),
    () => "beta scope test request",
  );
  const replied = await beta.request("agent_reply", {
    request_id: sent.result.request_id,
    text: "Scope test reply",
    idempotency_key: "scope-rep-1",
  });
  assert.equal(replied.ok, true, JSON.stringify(replied));
  const replyEvent = await waitFor(
    () => demo.events.find((event) => event.event === "agent_message" && event.kind === "reply"
      && event.request_id === sent.result.request_id),
    () => "demo scope test reply",
  );

  const afterExchange = readState(workspace.stateDir).fixtures.discord;
  assert.equal(
    afterExchange.messages.some((message) => message.content.includes("Should never post")),
    false,
    "not_granted must post nothing in either conversation",
  );

  // 3. Session Scope is unchanged: neither side can read, react to, or edit the other conversation or its records,
  // nor edit the root-bot receiver record in its own conversation.
  const demoSenderPost = afterExchange.messages.find((m) => m.channelId === "demo-channel" && m.webhookId && m.id !== offlineMsg.id);
  const betaReceiverPost = afterExchange.messages.find((m) => m.id === reqEvent.post.message_id);
  const betaReplierPost = afterExchange.messages.find((m) => m.channelId === "beta-channel" && m.webhookId);
  const demoReceiverPost = afterExchange.messages.find((m) => m.id === replyEvent.post.message_id);

  const scopeAttempts = [
    ["demo fetch beta channel", demo, "fetch_messages", { channel_id: "beta-channel", limit: 10 }],
    ["demo read_last beta channel", demo, "read_last_x_messages_in_channel", { channel_id: "beta-channel", count: 5 }],
    ["demo react beta channel", demo, "react", { channel_id: "beta-channel", message_id: betaReceiverPost.id, emoji: "👍" }],
    ["demo react beta record via own channel", demo, "react", { channel_id: "demo-channel", message_id: betaReplierPost.id, emoji: "👍" }],
    ["demo edit beta record via beta channel", demo, "edit_message", { channel_id: "beta-channel", message_id: betaReplierPost.id, text: "nope" }],
    ["demo edit beta record via own channel", demo, "edit_message", { channel_id: "demo-channel", message_id: betaReplierPost.id, text: "nope" }],
    ["demo edit root-bot reply record in own channel", demo, "edit_message", { channel_id: "demo-channel", message_id: demoReceiverPost.id, text: "nope" }],
    ["beta fetch demo channel", beta, "fetch_messages", { channel_id: "demo-channel", limit: 10 }],
    ["beta read_last demo channel", beta, "read_last_x_messages_in_channel", { channel_id: "demo-channel", count: 5 }],
    ["beta react demo channel", beta, "react", { channel_id: "demo-channel", message_id: demoSenderPost.id, emoji: "👍" }],
    ["beta react demo record via own channel", beta, "react", { channel_id: "beta-channel", message_id: demoSenderPost.id, emoji: "👍" }],
    ["beta edit demo record via own channel", beta, "edit_message", { channel_id: "beta-channel", message_id: demoSenderPost.id, text: "nope" }],
    ["beta edit root-bot request record in own channel", beta, "edit_message", { channel_id: "beta-channel", message_id: betaReceiverPost.id, text: "nope" }],
  ];
  for (const [label, caller, op, args] of scopeAttempts) {
    const res = await caller.request(op, args);
    assert.equal(res.ok, false, `${label} should fail`);
    assert.equal(res.error.code, "scope_violation", `${label}: ${JSON.stringify(res)}`);
  }
  await router.waitForOutput(/scope_violation project=beta op=edit_message/);
});
