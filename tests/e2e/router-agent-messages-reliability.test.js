import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import test from "node:test";

import { injectDiscordMessage } from "./support/bridge.js";
import { replaceFile } from "./support/platform.js";
import {
  OWNER_ID,
  createRouterWorkspace,
  routerRegistry,
  routerSocketPath,
  routerWithWebhooks,
  runRouterCli,
  seedThreads,
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

async function waitForDisconnect(workspace, predicate, label) {
  await waitFor(
    async () => {
      const status = JSON.parse((await runRouterCli(workspace, ["status", "--json"])).stdout);
      return predicate(status);
    },
    () => `disconnect of ${label}`,
  );
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

test("repeating agent_request with the same key returns the original result with one record pair, one delivery, and one rate count", async () => {
  const workspace = createRouterWorkspace({
    ...routerRegistry({
      demo: { channel_id: "demo-channel", type: "claude", transport: "router", agent_message_targets: ["beta"] },
      beta: { channel_id: "beta-channel", type: "codex", transport: "router" },
    }),
    agent_message_limits: { requests_per_hour: 2, open_requests: 2 },
  });
  await routerWithWebhooks(workspace, ["demo", "beta"]);

  const demo = await connectAgentProject(workspace, "demo", "demo-key");
  const demoOps = await rawClient(workspace, { role: "project", project: "demo", key: "demo-key", listener: false });
  const beta = await connectAgentProject(workspace, "beta", "beta-key");

  const first = await demo.request("agent_request", {
    target: "beta",
    text: "Check schema",
    idempotency_key: "idem-req-1",
  });
  assert.equal(first.ok, true, JSON.stringify(first));
  const reqId = first.result.request_id;
  await waitFor(
    () => beta.events.some((event) => event.event === "agent_message" && event.kind === "request" && event.request_id === reqId),
    () => `beta first request: ${JSON.stringify(beta.events)}`,
  );
  await waitFor(
    () => (readState(workspace.stateDir).fixtures.discord.messages ?? []).length === 2,
    () => `two records: ${JSON.stringify(readState(workspace.stateDir).fixtures.discord.messages)}`,
  );

  // Repeat from listener and from op-only connection sharing the same launch key.
  const repeatListener = await demo.request("agent_request", {
    target: "beta",
    text: "Check schema",
    idempotency_key: "idem-req-1",
  });
  assert.equal(repeatListener.ok, true, JSON.stringify(repeatListener));
  assert.deepEqual(repeatListener.result, first.result);

  const repeatOpOnly = await demoOps.request("agent_request", {
    target: "beta",
    text: "Check schema",
    idempotency_key: "idem-req-1",
  });
  assert.equal(repeatOpOnly.ok, true, JSON.stringify(repeatOpOnly));
  assert.deepEqual(repeatOpOnly.result, first.result);

  // Argument shape is still checked before idempotency replay.
  const badArgsRepeat = await demo.request("agent_request", {
    target: "beta",
    text: "",
    idempotency_key: "idem-req-1",
  });
  assert.equal(badArgsRepeat.ok, false);
  assert.equal(badArgsRepeat.error.code, "invalid_args");

  await fenceOwnerMessage(workspace, beta, "beta-channel", "fence-after-idem-req");

  // Exactly one pair of records and one delivery event.
  const messages = readState(workspace.stateDir).fixtures.discord.messages ?? [];
  assert.equal(messages.length, 2, JSON.stringify(messages));
  assert.equal(
    beta.events.filter((event) => event.event === "agent_message" && event.request_id === reqId).length,
    1,
  );

  // The repeats did not consume the second rate or open-request slot: a fresh key still succeeds.
  const second = await demo.request("agent_request", {
    target: "beta",
    text: "Second distinct request",
    idempotency_key: "idem-req-2",
  });
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.notEqual(second.result.request_id, reqId);
});

test("repeating a refused agent_request with the same key returns the original refusal even after conditions change; a new key evaluates fresh", async () => {
  const workspace = createRouterWorkspace({
    ...routerRegistry({
      demo: { channel_id: "demo-channel", type: "claude", transport: "router" },
      beta: { channel_id: "beta-channel", type: "codex", transport: "router" },
    }),
    agent_message_limits: { requests_per_hour: 2 },
  });
  const router = await routerWithWebhooks(workspace, ["demo", "beta"], {
    env: { CCDM_ROUTER_REGISTRY_DEBOUNCE_MS: "40" },
  });

  const demo = await connectAgentProject(workspace, "demo", "demo-key");

  // 1. Refused with not_granted before grant exists.
  const deniedFirst = await demo.request("agent_request", {
    target: "beta",
    text: "Before grant",
    idempotency_key: "refused-grant-key",
  });
  assert.equal(deniedFirst.ok, false);
  assert.equal(deniedFirst.error.code, "not_granted");

  // Add the grant and hot-reload.
  await afterReload(router, () => {
    const registry = readRegistry(workspace);
    registry.projects.demo.agent_message_targets = ["beta"];
    replaceFile(path.join(workspace.repoDir, "registry.json"), `${JSON.stringify(registry, null, 2)}\n`);
  });

  // Same key still returns the original not_granted refusal even though beta is now granted.
  const deniedRepeat = await demo.request("agent_request", {
    target: "beta",
    text: "Before grant",
    idempotency_key: "refused-grant-key",
  });
  assert.equal(deniedRepeat.ok, false);
  assert.equal(deniedRepeat.error.code, "not_granted");
  assert.equal(deniedRepeat.error.message, deniedFirst.error.message);

  // 2. New key evaluates fresh: beta is offline -> target_offline, one sender record posted.
  const offlineFirst = await demo.request("agent_request", {
    target: "beta",
    text: "Offline check",
    idempotency_key: "refused-offline-key",
  });
  assert.equal(offlineFirst.ok, false);
  assert.equal(offlineFirst.error.code, "target_offline");
  await waitFor(
    () => (readState(workspace.stateDir).fixtures.discord.messages ?? []).length === 1,
    () => `one offline record: ${JSON.stringify(readState(workspace.stateDir).fixtures.discord.messages)}`,
  );

  // Connect beta, then repeat the offline key: still returns target_offline, no second record, no delivery, no second rate count.
  const beta = await connectAgentProject(workspace, "beta", "beta-key");
  const offlineRepeat = await demo.request("agent_request", {
    target: "beta",
    text: "Offline check",
    idempotency_key: "refused-offline-key",
  });
  assert.equal(offlineRepeat.ok, false);
  assert.equal(offlineRepeat.error.code, "target_offline");
  assert.equal(offlineRepeat.error.message, offlineFirst.error.message);

  await fenceOwnerMessage(workspace, beta, "beta-channel", "fence-after-offline-repeat");
  assert.equal((readState(workspace.stateDir).fixtures.discord.messages ?? []).length, 1);
  assert.deepEqual(beta.events.filter((event) => event.event === "agent_message"), []);

  // A new key now succeeds (proving the repeated target_offline did not consume the 2nd rate slot).
  const freshAfterGrant = await demo.request("agent_request", {
    target: "beta",
    text: "Fresh after grant and online",
    idempotency_key: "fresh-online-key",
  });
  assert.equal(freshAfterGrant.ok, true, JSON.stringify(freshAfterGrant));
  await waitFor(
    () => beta.events.some((event) => event.event === "agent_message" && event.request_id === freshAfterGrant.result.request_id),
    () => `beta fresh request: ${JSON.stringify(beta.events)}`,
  );
});

test("repeating agent_reply with the same key returns the original result without duplicate records or already_replied", async () => {
  const workspace = createRouterWorkspace(routerRegistry({
    demo: { channel_id: "demo-channel", type: "claude", transport: "router", agent_message_targets: ["beta"] },
    beta: { channel_id: "beta-channel", type: "codex", transport: "router" },
  }));
  await routerWithWebhooks(workspace, ["demo", "beta"]);

  const demo = await connectAgentProject(workspace, "demo", "demo-key");
  const beta = await connectAgentProject(workspace, "beta", "beta-key");
  const betaOps = await rawClient(workspace, { role: "project", project: "beta", key: "beta-key", listener: false });

  // Refused reply with unknown_request is cached for that key.
  const unknownFirst = await beta.request("agent_reply", {
    request_id: "req-000000000000",
    text: "Nope",
    idempotency_key: "idem-rep-unknown",
  });
  assert.equal(unknownFirst.ok, false);
  assert.equal(unknownFirst.error.code, "unknown_request");

  const unknownRepeat = await beta.request("agent_reply", {
    request_id: "req-000000000000",
    text: "Nope",
    idempotency_key: "idem-rep-unknown",
  });
  assert.equal(unknownRepeat.ok, false);
  assert.equal(unknownRepeat.error.code, "unknown_request");
  assert.equal(unknownRepeat.error.message, unknownFirst.error.message);

  // Send request and reply once.
  const sent = await demo.request("agent_request", {
    target: "beta",
    text: "Need answer",
    idempotency_key: "idem-rep-req-1",
  });
  assert.equal(sent.ok, true, JSON.stringify(sent));
  const reqId = sent.result.request_id;
  await waitFor(
    () => beta.events.some((event) => event.event === "agent_message" && event.request_id === reqId),
    () => `beta request: ${JSON.stringify(beta.events)}`,
  );

  const firstReply = await beta.request("agent_reply", {
    request_id: reqId,
    text: "Here is the answer",
    idempotency_key: "idem-rep-1",
  });
  assert.equal(firstReply.ok, true, JSON.stringify(firstReply));
  assert.deepEqual(firstReply.result, { request_id: reqId, delivered_to_live_session: true });

  await waitFor(
    () => demo.events.some((event) => event.event === "agent_message" && event.kind === "reply" && event.request_id === reqId),
    () => `demo reply: ${JSON.stringify(demo.events)}`,
  );
  await waitFor(
    () => (readState(workspace.stateDir).fixtures.discord.messages ?? []).length === 4,
    () => `four records (2 req + 2 reply): ${JSON.stringify(readState(workspace.stateDir).fixtures.discord.messages)}`,
  );

  // Repeating with the same key (from listener or op-only) returns the original result instead of already_replied.
  const repeatReply = await beta.request("agent_reply", {
    request_id: reqId,
    text: "Here is the answer",
    idempotency_key: "idem-rep-1",
  });
  assert.equal(repeatReply.ok, true, JSON.stringify(repeatReply));
  assert.deepEqual(repeatReply.result, { request_id: reqId, delivered_to_live_session: true });

  const repeatReplyOps = await betaOps.request("agent_reply", {
    request_id: reqId,
    text: "Here is the answer",
    idempotency_key: "idem-rep-1",
  });
  assert.equal(repeatReplyOps.ok, true, JSON.stringify(repeatReplyOps));
  assert.deepEqual(repeatReplyOps.result, { request_id: reqId, delivered_to_live_session: true });

  // Argument shape still fails before idempotency replay.
  const badReplyRepeat = await beta.request("agent_reply", {
    request_id: reqId,
    text: "",
    idempotency_key: "idem-rep-1",
  });
  assert.equal(badReplyRepeat.ok, false);
  assert.equal(badReplyRepeat.error.code, "invalid_args");

  await fenceOwnerMessage(workspace, demo, "demo-channel", "fence-after-reply-repeat");
  assert.equal((readState(workspace.stateDir).fixtures.discord.messages ?? []).length, 4);
  assert.equal(
    demo.events.filter((event) => event.event === "agent_message" && event.kind === "reply" && event.request_id === reqId).length,
    1,
  );

  // A new key for the same request still returns already_replied.
  const secondKeyReply = await beta.request("agent_reply", {
    request_id: reqId,
    text: "Second attempt",
    idempotency_key: "idem-rep-2",
  });
  assert.equal(secondKeyReply.ok, false);
  assert.equal(secondKeyReply.error.code, "already_replied");
});

test("the same idempotency_key from another conversation or from a new launch of the same conversation is treated as a new call", async () => {
  const workspace = createRouterWorkspace(routerRegistry({
    demo: { channel_id: "demo-channel", type: "claude", transport: "router", agent_message_targets: ["beta"] },
    gamma: { channel_id: "gamma-channel", type: "claude", transport: "router", agent_message_targets: ["beta"] },
    beta: { channel_id: "beta-channel", type: "codex", transport: "router" },
  }));
  seedThreads(workspace, {
    "demo-thread-1": { type: 11, parentId: "demo-channel", name: "side-task" },
  });
  writeThreadKey(workspace, "demo-thread-1", "demo-thread-key");
  await routerWithWebhooks(workspace, ["demo", "gamma", "beta"]);

  const demo1 = await connectAgentProject(workspace, "demo", "demo-key");
  const demoThread = await connectAgentThread(workspace, "demo", "demo-thread-1", "demo-thread-key", "claude");
  const gamma = await connectAgentProject(workspace, "gamma", "gamma-key");
  const beta1 = await connectAgentProject(workspace, "beta", "beta-key");

  const sharedKey = "shared-key-1";

  const fromDemo = await demo1.request("agent_request", {
    target: "beta",
    text: "From demo channel",
    idempotency_key: sharedKey,
  });
  assert.equal(fromDemo.ok, true, JSON.stringify(fromDemo));

  // Same key from another project conversation -> new request.
  const fromGamma = await gamma.request("agent_request", {
    target: "beta",
    text: "From gamma channel",
    idempotency_key: sharedKey,
  });
  assert.equal(fromGamma.ok, true, JSON.stringify(fromGamma));
  assert.notEqual(fromGamma.result.request_id, fromDemo.result.request_id);

  // Same key from a thread of the same project -> new request.
  const fromDemoThread = await demoThread.request("agent_request", {
    target: "beta",
    text: "From demo thread",
    idempotency_key: sharedKey,
  });
  assert.equal(fromDemoThread.ok, true, JSON.stringify(fromDemoThread));
  assert.notEqual(fromDemoThread.result.request_id, fromDemo.result.request_id);
  assert.notEqual(fromDemoThread.result.request_id, fromGamma.result.request_id);

  // Rotate demo's launch key: same key from a new launch of demo -> new request.
  writeProjectKey(workspace, "demo", "demo-key-launch-2");
  await demo1.closed;
  const demo2 = await connectAgentProject(workspace, "demo", "demo-key-launch-2");

  const fromDemoLaunch2 = await demo2.request("agent_request", {
    target: "beta",
    text: "From demo launch 2",
    idempotency_key: sharedKey,
  });
  assert.equal(fromDemoLaunch2.ok, true, JSON.stringify(fromDemoLaunch2));
  assert.notEqual(fromDemoLaunch2.result.request_id, fromDemo.result.request_id);

  // Same check for agent_reply: a new launch of beta reusing beta1's reply key is treated as a new call (already_replied).
  const reqId = fromDemoLaunch2.result.request_id;
  await waitFor(
    () => beta1.events.some((event) => event.event === "agent_message" && event.request_id === reqId),
    () => `beta1 request: ${JSON.stringify(beta1.events)}`,
  );
  const firstReply = await beta1.request("agent_reply", {
    request_id: reqId,
    text: "Answered by launch 1",
    idempotency_key: "reply-launch-key",
  });
  assert.equal(firstReply.ok, true, JSON.stringify(firstReply));

  writeProjectKey(workspace, "beta", "beta-key-launch-2");
  await beta1.closed;
  const beta2 = await connectAgentProject(workspace, "beta", "beta-key-launch-2");
  const newLaunchReply = await beta2.request("agent_reply", {
    request_id: reqId,
    text: "Answered by launch 1",
    idempotency_key: "reply-launch-key",
  });
  assert.equal(newLaunchReply.ok, false);
  assert.equal(newLaunchReply.error.code, "already_replied");
});

test("an unacknowledged request delivery is re-sent with the same delivery_id on same-launch reconnect and stops after ack", async () => {
  const workspace = createRouterWorkspace(routerRegistry({
    demo: { channel_id: "demo-channel", type: "claude", transport: "router", agent_message_targets: ["beta"] },
    beta: { channel_id: "beta-channel", type: "codex", transport: "router" },
  }));
  await routerWithWebhooks(workspace, ["demo", "beta"]);

  const demo = await connectAgentProject(workspace, "demo", "demo-key");
  const beta1 = await connectAgentProject(workspace, "beta", "beta-key");

  const sent = await demo.request("agent_request", {
    target: "beta",
    text: "Retry delivery check",
    idempotency_key: "resend-req-1",
  });
  assert.equal(sent.ok, true, JSON.stringify(sent));
  const reqId = sent.result.request_id;

  const firstEvent = await waitFor(
    () => beta1.events.find((event) => event.event === "agent_message" && event.request_id === reqId),
    () => `beta1 request: ${JSON.stringify(beta1.events)}`,
  );
  assert.equal(firstEvent.kind, "request");
  assert.equal(typeof firstEvent.delivery_id, "string");

  // Disconnect WITHOUT acknowledging.
  await beta1.close();
  await waitForDisconnect(
    workspace,
    (status) => !status.sessions.some((s) => s.project === "beta" && s.role === "project"),
    "beta1",
  );

  // An incapable reconnect with the same key receives nothing.
  const betaIncapable = await rawClient(workspace, { role: "project", project: "beta", key: "beta-key" });
  assert.equal(betaIncapable.hello.type, "hello_ok");
  await fenceOwnerMessage(workspace, betaIncapable, "beta-channel", "fence-beta-incapable");
  assert.deepEqual(betaIncapable.events.filter((event) => event.event === "agent_message"), []);
  await betaIncapable.close();
  await waitForDisconnect(
    workspace,
    (status) => !status.sessions.some((s) => s.project === "beta" && s.role === "project"),
    "betaIncapable",
  );

  // Reconnect with the same launch key and agent_messages capability -> receives the exact same delivery_id.
  const beta2 = await connectAgentProject(workspace, "beta", "beta-key");
  const resentEvent = await waitFor(
    () => beta2.events.find((event) => event.event === "agent_message" && event.request_id === reqId),
    () => `beta2 resent request: ${JSON.stringify(beta2.events)}`,
  );
  assert.equal(resentEvent.delivery_id, firstEvent.delivery_id);
  assert.deepEqual(resentEvent, firstEvent);

  // Acknowledge on beta2.
  const ackRes = await beta2.request("agent_message_ack", { delivery_id: resentEvent.delivery_id });
  assert.equal(ackRes.ok, true, JSON.stringify(ackRes));
  assert.deepEqual(ackRes.result, {});

  // Disconnect and reconnect again with the same launch key -> receives nothing.
  await beta2.close();
  await waitForDisconnect(
    workspace,
    (status) => !status.sessions.some((s) => s.project === "beta" && s.role === "project"),
    "beta2",
  );
  const beta3 = await connectAgentProject(workspace, "beta", "beta-key");
  await fenceOwnerMessage(workspace, beta3, "beta-channel", "fence-beta3-after-ack");
  assert.deepEqual(beta3.events.filter((event) => event.event === "agent_message"), []);
});

test("a new launch of the target receives nothing from before its hello and can still reply to the open request", async () => {
  const workspace = createRouterWorkspace(routerRegistry({
    demo: { channel_id: "demo-channel", type: "claude", transport: "router", agent_message_targets: ["beta"] },
    beta: { channel_id: "beta-channel", type: "codex", transport: "router" },
  }));
  await routerWithWebhooks(workspace, ["demo", "beta"]);

  const demo = await connectAgentProject(workspace, "demo", "demo-key");
  const betaOld = await connectAgentProject(workspace, "beta", "beta-key");

  const sent = await demo.request("agent_request", {
    target: "beta",
    text: "Survive target relaunch",
    idempotency_key: "new-launch-req-1",
  });
  assert.equal(sent.ok, true, JSON.stringify(sent));
  const reqId = sent.result.request_id;

  await waitFor(
    () => betaOld.events.some((event) => event.event === "agent_message" && event.request_id === reqId),
    () => `betaOld request: ${JSON.stringify(betaOld.events)}`,
  );

  // Rotate beta's key without acknowledging, then connect a new launch.
  writeProjectKey(workspace, "beta", "beta-key-new");
  await betaOld.closed;
  const betaNew = await connectAgentProject(workspace, "beta", "beta-key-new");

  // New launch receives nothing from before its hello.
  await fenceOwnerMessage(workspace, betaNew, "beta-channel", "fence-beta-new-launch");
  assert.deepEqual(betaNew.events.filter((event) => event.event === "agent_message"), []);

  // The open request is still answerable by the new launch.
  const replied = await betaNew.request("agent_reply", {
    request_id: reqId,
    text: "Answered after relaunch",
    idempotency_key: "new-launch-reply-1",
  });
  assert.equal(replied.ok, true, JSON.stringify(replied));
  assert.deepEqual(replied.result, { request_id: reqId, delivered_to_live_session: true });

  const demoReply = await waitFor(
    () => demo.events.find((event) => event.event === "agent_message" && event.kind === "reply" && event.request_id === reqId),
    () => `demo reply from betaNew: ${JSON.stringify(demo.events)}`,
  );
  assert.equal(demoReply.text, "Answered after relaunch");
});

test("a reply accepted while the sender is disconnected posts records, returns delivered_to_live_session false, delivers on same-launch reconnect, and never delivers to a new launch", async () => {
  const workspace = createRouterWorkspace(routerRegistry({
    demo: { channel_id: "demo-channel", type: "claude", transport: "router", agent_message_targets: ["beta"] },
    beta: { channel_id: "beta-channel", type: "codex", transport: "router" },
  }));
  await routerWithWebhooks(workspace, ["demo", "beta"]);

  const demo1 = await connectAgentProject(workspace, "demo", "demo-key");
  const beta = await connectAgentProject(workspace, "beta", "beta-key");

  // Send two requests while demo1 is connected.
  const sent1 = await demo1.request("agent_request", {
    target: "beta",
    text: "Answer while I reconnect",
    idempotency_key: "disc-req-1",
  });
  assert.equal(sent1.ok, true, JSON.stringify(sent1));
  const req1 = sent1.result.request_id;

  const sent2 = await demo1.request("agent_request", {
    target: "beta",
    text: "Answer before new launch",
    idempotency_key: "disc-req-2",
  });
  assert.equal(sent2.ok, true, JSON.stringify(sent2));
  const req2 = sent2.result.request_id;

  await waitFor(
    () => beta.events.filter((event) => event.event === "agent_message" && event.kind === "request").length === 2,
    () => `beta both requests: ${JSON.stringify(beta.events)}`,
  );

  // Disconnect demo1 before beta replies to req1.
  await demo1.close();
  await waitForDisconnect(
    workspace,
    (status) => !status.sessions.some((s) => s.project === "demo" && s.role === "project"),
    "demo1",
  );

  const reply1 = await beta.request("agent_reply", {
    request_id: req1,
    text: "Answer for reconnecting launch",
    idempotency_key: "disc-rep-1",
  });
  assert.equal(reply1.ok, true, JSON.stringify(reply1));
  assert.deepEqual(reply1.result, { request_id: req1, delivered_to_live_session: false });

  // Both reply records are posted even while sender is disconnected (4 req records + 2 reply records = 6).
  await waitFor(
    () => (readState(workspace.stateDir).fixtures.discord.messages ?? []).length === 6,
    () => `six records after offline reply: ${JSON.stringify(readState(workspace.stateDir).fixtures.discord.messages)}`,
  );

  // Same launch reconnects -> receives the pending reply delivery with post set.
  const demo1ReconnectA = await connectAgentProject(workspace, "demo", "demo-key");
  const replyEventA = await waitFor(
    () => demo1ReconnectA.events.find((event) => event.event === "agent_message" && event.kind === "reply" && event.request_id === req1),
    () => `demo1ReconnectA reply: ${JSON.stringify(demo1ReconnectA.events)}`,
  );
  assert.equal(replyEventA.text, "Answer for reconnecting launch");
  assert.equal(replyEventA.post?.channel_id, "demo-channel");
  assert.ok(replyEventA.post?.message_id);

  // Disconnect without acking and reconnect with same key -> gets the same delivery_id again.
  await demo1ReconnectA.close();
  await waitForDisconnect(
    workspace,
    (status) => !status.sessions.some((s) => s.project === "demo" && s.role === "project"),
    "demo1ReconnectA",
  );
  const demo1ReconnectB = await connectAgentProject(workspace, "demo", "demo-key");
  const replyEventB = await waitFor(
    () => demo1ReconnectB.events.find((event) => event.event === "agent_message" && event.kind === "reply" && event.request_id === req1),
    () => `demo1ReconnectB reply: ${JSON.stringify(demo1ReconnectB.events)}`,
  );
  assert.equal(replyEventB.delivery_id, replyEventA.delivery_id);

  // Acknowledge reply1, then disconnect demo1.
  const ack1 = await demo1ReconnectB.request("agent_message_ack", { delivery_id: replyEventB.delivery_id });
  assert.equal(ack1.ok, true, JSON.stringify(ack1));
  await demo1ReconnectB.close();
  await waitForDisconnect(
    workspace,
    (status) => !status.sessions.some((s) => s.project === "demo" && s.role === "project"),
    "demo1ReconnectB",
  );

  // While demo is disconnected, beta replies to req2 -> delivered_to_live_session: false, records still posted.
  const reply2 = await beta.request("agent_reply", {
    request_id: req2,
    text: "Answer that new launch must not receive",
    idempotency_key: "disc-rep-2",
  });
  assert.equal(reply2.ok, true, JSON.stringify(reply2));
  assert.deepEqual(reply2.result, { request_id: req2, delivered_to_live_session: false });
  await waitFor(
    () => (readState(workspace.stateDir).fixtures.discord.messages ?? []).length === 8,
    () => `eight records after second offline reply: ${JSON.stringify(readState(workspace.stateDir).fixtures.discord.messages)}`,
  );

  // Connect a NEW launch of demo -> receives neither reply1 (acked) nor reply2 (for old launch).
  writeProjectKey(workspace, "demo", "demo-key-launch-2");
  const demo2 = await connectAgentProject(workspace, "demo", "demo-key-launch-2");
  await fenceOwnerMessage(workspace, demo2, "demo-channel", "fence-demo2-no-old-replies");
  assert.deepEqual(demo2.events.filter((event) => event.event === "agent_message"), []);
});

test("notice deliveries follow the same pending, re-send, ack, and new-launch rules as requests and replies", async () => {
  const workspace = createRouterWorkspace(routerRegistry({
    demo: { channel_id: "demo-channel", type: "claude", transport: "router", agent_message_targets: ["beta"] },
    beta: { channel_id: "beta-channel", type: "codex", transport: "router" },
  }));
  await routerWithWebhooks(workspace, ["demo", "beta"], {
    env: { CCDM_ROUTER_AGENT_MESSAGE_MINUTE_MS: "120" },
  });

  const demo1 = await connectAgentProject(workspace, "demo", "demo-key");
  const beta = await connectAgentProject(workspace, "beta", "beta-key");

  // Open two short-timeout requests, then disconnect demo1 before expiry.
  const sent1 = await demo1.request("agent_request", {
    target: "beta",
    text: "Expire while disconnected (same launch)",
    timeout_minutes: 1,
    idempotency_key: "notice-req-1",
  });
  assert.equal(sent1.ok, true, JSON.stringify(sent1));
  const req1 = sent1.result.request_id;

  await waitFor(
    () => beta.events.some((event) => event.event === "agent_message" && event.request_id === req1),
    () => `beta notice req1`,
  );

  await demo1.close();
  await waitForDisconnect(
    workspace,
    (status) => !status.sessions.some((s) => s.project === "demo" && s.role === "project"),
    "demo1 before expiry",
  );

  // Wait until expiry marks (⚠️) land on both request posts.
  const warnEmoji = encodeURIComponent("⚠️");
  await waitFor(
    () => (readState(workspace.stateDir).fixtures.discord.reactions ?? []).filter((r) => r.emoji === warnEmoji).length >= 2,
    () => `expiry reactions: ${JSON.stringify(readState(workspace.stateDir).fixtures.discord.reactions)}`,
  );

  // Reconnect with the same launch key -> receives the pending expiry notice.
  const demo1ReconnectA = await connectAgentProject(workspace, "demo", "demo-key");
  const noticeA = await waitFor(
    () => demo1ReconnectA.events.find((event) => event.event === "agent_message" && event.kind === "notice" && event.request_id === req1),
    () => `demo1ReconnectA notice: ${JSON.stringify(demo1ReconnectA.events)}`,
  );
  assert.equal(noticeA.outcome, "expired");
  assert.equal(noticeA.target.project, "beta");
  assert.equal(noticeA.post?.channel_id, "demo-channel");

  // Disconnect without acking and reconnect with same key -> gets the same delivery_id again.
  await demo1ReconnectA.close();
  await waitForDisconnect(
    workspace,
    (status) => !status.sessions.some((s) => s.project === "demo" && s.role === "project"),
    "demo1ReconnectA",
  );
  const demo1ReconnectB = await connectAgentProject(workspace, "demo", "demo-key");
  const noticeB = await waitFor(
    () => demo1ReconnectB.events.find((event) => event.event === "agent_message" && event.kind === "notice" && event.request_id === req1),
    () => `demo1ReconnectB notice: ${JSON.stringify(demo1ReconnectB.events)}`,
  );
  assert.equal(noticeB.delivery_id, noticeA.delivery_id);

  // Ack, disconnect, reconnect -> nothing further for req1.
  const ackRes = await demo1ReconnectB.request("agent_message_ack", { delivery_id: noticeB.delivery_id });
  assert.equal(ackRes.ok, true, JSON.stringify(ackRes));
  await demo1ReconnectB.close();
  await waitForDisconnect(
    workspace,
    (status) => !status.sessions.some((s) => s.project === "demo" && s.role === "project"),
    "demo1ReconnectB",
  );
  const demo1ReconnectC = await connectAgentProject(workspace, "demo", "demo-key");

  // Open a second short-timeout request, disconnect, let it expire, then connect a NEW launch -> gets nothing.
  const sent2 = await demo1ReconnectC.request("agent_request", {
    target: "beta",
    text: "Expire before new launch",
    timeout_minutes: 1,
    idempotency_key: "notice-req-2",
  });
  assert.equal(sent2.ok, true, JSON.stringify(sent2));
  const req2 = sent2.result.request_id;
  await waitFor(
    () => beta.events.some((event) => event.event === "agent_message" && event.request_id === req2),
    () => `beta notice req2`,
  );
  await demo1ReconnectC.close();
  await waitForDisconnect(
    workspace,
    (status) => !status.sessions.some((s) => s.project === "demo" && s.role === "project"),
    "demo1ReconnectC",
  );
  await waitFor(
    () => (readState(workspace.stateDir).fixtures.discord.reactions ?? []).filter((r) => r.emoji === warnEmoji).length >= 4,
    () => `four expiry reactions: ${JSON.stringify(readState(workspace.stateDir).fixtures.discord.reactions)}`,
  );

  writeProjectKey(workspace, "demo", "demo-key-new");
  const demoNew = await connectAgentProject(workspace, "demo", "demo-key-new");
  await fenceOwnerMessage(workspace, demoNew, "demo-channel", "fence-demo-new-notice");
  assert.deepEqual(demoNew.events.filter((event) => event.event === "agent_message"), []);
});

test("thread listeners re-receive unacknowledged deliveries on same-launch reconnect and stay isolated across new thread launches", async () => {
  const workspace = createRouterWorkspace(routerRegistry({
    demo: { channel_id: "demo-channel", type: "claude", transport: "router", agent_message_targets: ["beta"] },
    beta: { channel_id: "beta-channel", type: "codex", transport: "router" },
  }));
  seedThreads(workspace, {
    "beta-thread-1": { type: 11, parentId: "beta-channel", name: "worker-thread" },
  });
  writeThreadKey(workspace, "beta-thread-1", "thread-key-1");
  await routerWithWebhooks(workspace, ["demo", "beta"]);

  const demo = await connectAgentProject(workspace, "demo", "demo-key");
  const thread1 = await connectAgentThread(workspace, "beta", "beta-thread-1", "thread-key-1", "codex");
  assert.equal(thread1.hello.type, "hello_ok");

  const sent = await demo.request("agent_request", {
    target: "beta/beta-thread-1",
    text: "Thread reconnect test",
    idempotency_key: "thread-resend-1",
  });
  assert.equal(sent.ok, true, JSON.stringify(sent));
  const reqId = sent.result.request_id;

  const firstEvent = await waitFor(
    () => thread1.events.find((event) => event.event === "agent_message" && event.request_id === reqId),
    () => `thread1 request: ${JSON.stringify(thread1.events)}`,
  );

  // Disconnect without ack, reconnect with same launch key -> receives the exact same delivery_id.
  await thread1.close();
  await waitForDisconnect(
    workspace,
    (status) => !status.sessions.some((s) => s.role === "thread" && s.thread_id === "beta-thread-1"),
    "thread1",
  );

  const thread1Reconnect = await connectAgentThread(workspace, "beta", "beta-thread-1", "thread-key-1", "codex");
  const resentEvent = await waitFor(
    () => thread1Reconnect.events.find((event) => event.event === "agent_message" && event.request_id === reqId),
    () => `thread1Reconnect request: ${JSON.stringify(thread1Reconnect.events)}`,
  );
  assert.equal(resentEvent.delivery_id, firstEvent.delivery_id);

  // Rotate thread key without acking -> new thread launch receives nothing from before its hello and can still reply.
  writeThreadKey(workspace, "beta-thread-1", "thread-key-2");
  await thread1Reconnect.closed;
  const thread2 = await connectAgentThread(workspace, "beta", "beta-thread-1", "thread-key-2", "codex");
  assert.equal(thread2.hello.type, "hello_ok");
  await fenceOwnerMessage(workspace, thread2, "beta-thread-1", "fence-thread2-new-launch");
  assert.deepEqual(thread2.events.filter((event) => event.event === "agent_message"), []);

  const threadReply = await thread2.request("agent_reply", {
    request_id: reqId,
    text: "Answered from new thread launch",
    idempotency_key: "thread-reply-1",
  });
  assert.equal(threadReply.ok, true, JSON.stringify(threadReply));
  assert.deepEqual(threadReply.result, { request_id: reqId, delivered_to_live_session: true });

  const demoReply = await waitFor(
    () => demo.events.find((event) => event.event === "agent_message" && event.kind === "reply" && event.request_id === reqId),
    () => `demo reply from thread2: ${JSON.stringify(demo.events)}`,
  );
  assert.equal(demoReply.text, "Answered from new thread launch");
  assert.equal(demoReply.from.thread_id, "beta-thread-1");
});

test("ledger_unavailable is not cached by idempotency, and repeating an offline-sender reply replays delivered_to_live_session false", async () => {
  const workspace = createRouterWorkspace(routerRegistry({
    demo: { channel_id: "demo-channel", type: "claude", transport: "router", agent_message_targets: ["beta"] },
    beta: { channel_id: "beta-channel", type: "codex", transport: "router" },
  }));
  await routerWithWebhooks(workspace, ["demo", "beta"]);

  const demo1 = await connectAgentProject(workspace, "demo", "demo-key");
  const beta = await connectAgentProject(workspace, "beta", "beta-key");
  const ledgerFile = path.join(workspace.routerStateDir, "agent-messages.jsonl");

  // Block ledger, fail with ledger_unavailable, restore ledger, retry with the SAME key -> succeeds.
  fs.mkdirSync(ledgerFile);
  const blockedReq = await demo1.request("agent_request", {
    target: "beta",
    text: "Retry after ledger failure",
    idempotency_key: "ledger-same-key",
  });
  assert.equal(blockedReq.ok, false);
  assert.equal(blockedReq.error.code, "ledger_unavailable");

  fs.rmdirSync(ledgerFile);
  const recoveredReq = await demo1.request("agent_request", {
    target: "beta",
    text: "Retry after ledger failure",
    idempotency_key: "ledger-same-key",
  });
  assert.equal(recoveredReq.ok, true, JSON.stringify(recoveredReq));
  const reqId = recoveredReq.result.request_id;
  await waitFor(
    () => beta.events.some((event) => event.event === "agent_message" && event.request_id === reqId),
    () => `beta recovered request`,
  );

  // Disconnect demo1, reply while offline -> delivered_to_live_session: false.
  await demo1.close();
  await waitForDisconnect(
    workspace,
    (status) => !status.sessions.some((s) => s.project === "demo" && s.role === "project"),
    "demo1 offline for reply replay",
  );
  const firstOfflineReply = await beta.request("agent_reply", {
    request_id: reqId,
    text: "Offline answer",
    idempotency_key: "offline-reply-same-key",
  });
  assert.equal(firstOfflineReply.ok, true, JSON.stringify(firstOfflineReply));
  assert.deepEqual(firstOfflineReply.result, { request_id: reqId, delivered_to_live_session: false });

  // Reconnect demo1 and receive the one reply.
  const demo1Back = await connectAgentProject(workspace, "demo", "demo-key");
  await waitFor(
    () => demo1Back.events.some((event) => event.event === "agent_message" && event.kind === "reply" && event.request_id === reqId),
    () => `demo1Back reply`,
  );

  // Repeating the reply with the same key returns the original delivered_to_live_session: false and delivers nothing new.
  const repeatOfflineReply = await beta.request("agent_reply", {
    request_id: reqId,
    text: "Offline answer",
    idempotency_key: "offline-reply-same-key",
  });
  assert.equal(repeatOfflineReply.ok, true, JSON.stringify(repeatOfflineReply));
  assert.deepEqual(repeatOfflineReply.result, { request_id: reqId, delivered_to_live_session: false });

  await fenceOwnerMessage(workspace, demo1Back, "demo-channel", "fence-after-offline-reply-repeat");
  assert.equal(
    demo1Back.events.filter((event) => event.event === "agent_message" && event.kind === "reply" && event.request_id === reqId).length,
    1,
  );
  assert.equal((readState(workspace.stateDir).fixtures.discord.messages ?? []).length, 4);
});
