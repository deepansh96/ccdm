import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { injectDiscordMessage } from "./support/bridge.js";
import {
  OWNER_ID,
  createRouterWorkspace,
  rawRouterSocket,
  routerRegistry,
  routerWithWebhooks,
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

test("parallel sends from one project (single and two conversations) enforce requests_per_hour across 5 rounds", async () => {
  const workspace = createRouterWorkspace({
    ...routerRegistry({
      demo: { channel_id: "demo-channel", type: "claude", transport: "router", agent_message_targets: ["beta"] },
      beta: { channel_id: "beta-channel", type: "codex", transport: "router" },
    }),
    agent_message_limits: { requests_per_hour: 3, open_requests: 30 },
  });
  seedThreads(workspace, {
    "demo-thread-1": { type: 11, parentId: "demo-channel", name: "demo-side" },
  });
  writeThreadKey(workspace, "demo-thread-1", "demo-thread-key");
  const windowMs = 1500;
  await routerWithWebhooks(workspace, ["demo", "beta"], {
    env: { CCDM_ROUTER_AGENT_MESSAGE_RATE_WINDOW_MS: String(windowMs) },
  });

  const demo = await connectAgentProject(workspace, "demo", "demo-key");
  const demoThread = await connectAgentThread(workspace, "demo", "demo-thread-1", "demo-thread-key");
  const beta = await connectAgentProject(workspace, "beta", "beta-key");

  let expectedAcceptedTotal = 0;

  for (let round = 1; round <= 5; round += 1) {
    // Rounds 1-2: all 6 calls from the channel conversation; rounds 3-5: 3 from channel + 3 from thread.
    const calls = Array.from({ length: 6 }, (_, i) => {
      const client = round >= 3 && i >= 3 ? demoThread : demo;
      return client.request("agent_request", {
        target: "beta",
        text: `round ${round} call ${i}`,
        idempotency_key: `par-rate-r${round}-${i}`,
      });
    });

    const responses = await Promise.all(calls);
    const roundEnd = Date.now();

    const accepted = responses.filter((res) => res.ok);
    const rateExceeded = responses.filter((res) => !res.ok && res.error.code === "request_rate_exceeded");
    assert.equal(accepted.length, 3, `round ${round} accepted: ${JSON.stringify(responses)}`);
    assert.equal(rateExceeded.length, 3, `round ${round} rateExceeded: ${JSON.stringify(responses)}`);
    for (const refused of rateExceeded) {
      assert.match(refused.error.message, /requests_per_hour/);
      assert.match(refused.error.message, /\b3\b/);
    }

    expectedAcceptedTotal += 3;
    await waitFor(
      () => beta.events.filter((event) => event.event === "agent_message" && event.kind === "request").length === expectedAcceptedTotal,
      () => `round ${round} expected ${expectedAcceptedTotal} requests on beta`,
    );

    if (round < 5) {
      const waitMs = roundEnd + windowMs + 150 - Date.now();
      if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }

  await fenceOwnerMessage(workspace, beta, "beta-channel", "fence-after-parallel-rate");
  assert.equal(
    beta.events.filter((event) => event.event === "agent_message" && event.kind === "request").length,
    15,
  );
  assert.equal((readState(workspace.stateDir).fixtures.discord.messages ?? []).length, 30);
});

test("parallel sends from one conversation enforce open_requests without letting extras through", async () => {
  const workspace = createRouterWorkspace({
    ...routerRegistry({
      demo: { channel_id: "demo-channel", type: "claude", transport: "router", agent_message_targets: ["beta"] },
      beta: { channel_id: "beta-channel", type: "codex", transport: "router" },
    }),
    agent_message_limits: { open_requests: 2, requests_per_hour: 20 },
  });
  await routerWithWebhooks(workspace, ["demo", "beta"]);

  const demo = await connectAgentProject(workspace, "demo", "demo-key");
  const beta = await connectAgentProject(workspace, "beta", "beta-key");

  const responses = await Promise.all(
    Array.from({ length: 5 }, (_, i) => demo.request("agent_request", {
      target: "beta",
      text: `parallel open ${i}`,
      idempotency_key: `par-open-${i}`,
    })),
  );

  const accepted = responses.filter((res) => res.ok);
  const openExceeded = responses.filter((res) => !res.ok && res.error.code === "open_requests_exceeded");
  assert.equal(accepted.length, 2, JSON.stringify(responses));
  assert.equal(openExceeded.length, 3, JSON.stringify(responses));
  for (const refused of openExceeded) {
    assert.match(refused.error.message, /open_requests/);
    assert.match(refused.error.message, /\b2\b/);
  }

  await waitFor(
    () => beta.events.filter((event) => event.event === "agent_message" && event.kind === "request").length === 2,
    () => `beta 2 open requests: ${JSON.stringify(beta.events)}`,
  );
  await fenceOwnerMessage(workspace, beta, "beta-channel", "fence-after-parallel-open");
  assert.equal(beta.events.filter((event) => event.event === "agent_message" && event.kind === "request").length, 2);
  assert.equal((readState(workspace.stateDir).fixtures.discord.messages ?? []).length, 4);
});

test("parallel sends mixing online, offline, and archived targets never exceed requests_per_hour", async () => {
  const workspace = createRouterWorkspace({
    ...routerRegistry({
      demo: { channel_id: "demo-channel", type: "claude", transport: "router", agent_message_targets: ["beta", "offline"] },
      gamma: { channel_id: "gamma-channel", type: "claude", transport: "router", agent_message_targets: ["beta", "offline"] },
      beta: { channel_id: "beta-channel", type: "codex", transport: "router" },
      offline: { channel_id: "offline-channel", type: "claude", transport: "router" },
    }),
    agent_message_limits: { requests_per_hour: 3, open_requests: 10 },
  });
  seedThreads(workspace, {
    "beta-archived": { type: 11, parentId: "beta-channel", name: "closed-thread", archived: true },
  });
  await routerWithWebhooks(workspace, ["demo", "gamma", "beta", "offline"]);

  const demo = await connectAgentProject(workspace, "demo", "demo-key");
  const gamma = await connectAgentProject(workspace, "gamma", "gamma-key");
  await connectAgentProject(workspace, "beta", "beta-key");

  // Online + offline mix from demo (3 online + 3 offline against limit 3).
  const demoResponses = await Promise.all([
    demo.request("agent_request", { target: "beta", text: "on 1", idempotency_key: "mix-on-1" }),
    demo.request("agent_request", { target: "offline", text: "off 1", idempotency_key: "mix-off-1" }),
    demo.request("agent_request", { target: "beta", text: "on 2", idempotency_key: "mix-on-2" }),
    demo.request("agent_request", { target: "offline", text: "off 2", idempotency_key: "mix-off-2" }),
    demo.request("agent_request", { target: "beta", text: "on 3", idempotency_key: "mix-on-3" }),
    demo.request("agent_request", { target: "offline", text: "off 3", idempotency_key: "mix-off-3" }),
  ]);

  const demoAccepted = demoResponses.filter((res) => res.ok).length;
  const demoOffline = demoResponses.filter((res) => !res.ok && res.error.code === "target_offline").length;
  const demoRateExceeded = demoResponses.filter((res) => !res.ok && res.error.code === "request_rate_exceeded").length;
  assert.equal(demoAccepted + demoOffline, 3, JSON.stringify(demoResponses));
  assert.equal(demoRateExceeded, 3, JSON.stringify(demoResponses));

  // Online + offline + archived-thread mix from gamma (2 each against limit 3).
  const gammaResponses = await Promise.all([
    gamma.request("agent_request", { target: "beta", text: "g on 1", idempotency_key: "gmix-on-1" }),
    gamma.request("agent_request", { target: "offline", text: "g off 1", idempotency_key: "gmix-off-1" }),
    gamma.request("agent_request", { target: "beta/beta-archived", text: "g closed 1", idempotency_key: "gmix-closed-1" }),
    gamma.request("agent_request", { target: "beta", text: "g on 2", idempotency_key: "gmix-on-2" }),
    gamma.request("agent_request", { target: "offline", text: "g off 2", idempotency_key: "gmix-off-2" }),
    gamma.request("agent_request", { target: "beta/beta-archived", text: "g closed 2", idempotency_key: "gmix-closed-2" }),
  ]);

  const gammaAccepted = gammaResponses.filter((res) => res.ok).length;
  const gammaOffline = gammaResponses.filter((res) => !res.ok && res.error.code === "target_offline").length;
  const gammaClosed = gammaResponses.filter((res) => !res.ok && res.error.code === "target_closed").length;
  const gammaRateExceeded = gammaResponses.filter((res) => !res.ok && res.error.code === "request_rate_exceeded").length;
  assert.equal(gammaAccepted + gammaOffline + gammaClosed, 3, JSON.stringify(gammaResponses));
  assert.equal(gammaRateExceeded, 3, JSON.stringify(gammaResponses));
});

test("parallel sends from a conversation holding an open depth-3 request are all refused with depth_exceeded", async () => {
  const workspace = createRouterWorkspace(routerRegistry({
    alpha: { channel_id: "alpha-channel", type: "claude", transport: "router", agent_message_targets: ["beta"] },
    beta: { channel_id: "beta-channel", type: "codex", transport: "router", agent_message_targets: ["gamma"] },
    gamma: { channel_id: "gamma-channel", type: "claude", transport: "router", agent_message_targets: ["delta"] },
    delta: { channel_id: "delta-channel", type: "codex", transport: "router", agent_message_targets: ["alpha"] },
  }));
  await routerWithWebhooks(workspace, ["alpha", "beta", "gamma", "delta"]);

  const alpha = await connectAgentProject(workspace, "alpha", "alpha-key");
  const beta = await connectAgentProject(workspace, "beta", "beta-key");
  const gamma = await connectAgentProject(workspace, "gamma", "gamma-key");
  const delta = await connectAgentProject(workspace, "delta", "delta-key");

  const ab = await alpha.request("agent_request", { target: "beta", text: "d1", idempotency_key: "par-depth-1" });
  assert.equal(ab.ok, true);
  assert.equal(ab.result.depth, 1);

  const bc = await beta.request("agent_request", { target: "gamma", text: "d2", idempotency_key: "par-depth-2" });
  assert.equal(bc.ok, true);
  assert.equal(bc.result.depth, 2);

  const cd = await gamma.request("agent_request", { target: "delta", text: "d3", idempotency_key: "par-depth-3" });
  assert.equal(cd.ok, true);
  assert.equal(cd.result.depth, 3);

  await waitFor(
    () => (readState(workspace.stateDir).fixtures.discord.messages ?? []).length >= 6,
    () => `expected 6 setup messages, got ${(readState(workspace.stateDir).fixtures.discord.messages ?? []).length}`,
  );
  const messagesBefore = (readState(workspace.stateDir).fixtures.discord.messages ?? []).length;

  const parallel = await Promise.all(
    Array.from({ length: 5 }, (_, i) => delta.request("agent_request", {
      target: "alpha",
      text: `d4 blocked ${i}`,
      idempotency_key: `par-depth-4-${i}`,
    })),
  );

  for (const res of parallel) {
    assert.equal(res.ok, false, JSON.stringify(res));
    assert.equal(res.error.code, "depth_exceeded");
    assert.match(res.error.message, /depth/);
    assert.match(res.error.message, /\b3\b/);
  }

  await fenceOwnerMessage(workspace, alpha, "alpha-channel", "fence-after-parallel-depth");
  assert.deepEqual(alpha.events.filter((event) => event.event === "agent_message"), []);
  assert.equal((readState(workspace.stateDir).fixtures.discord.messages ?? []).length, messagesBefore);
});

test("parallel sends from two different projects each get their own limit accepted", async () => {
  const workspace = createRouterWorkspace({
    ...routerRegistry({
      alpha: { channel_id: "alpha-channel", type: "claude", transport: "router", agent_message_targets: ["beta"] },
      gamma: { channel_id: "gamma-channel", type: "claude", transport: "router", agent_message_targets: ["beta"] },
      beta: { channel_id: "beta-channel", type: "codex", transport: "router" },
    }),
    agent_message_limits: { requests_per_hour: 3, open_requests: 10 },
  });
  await routerWithWebhooks(workspace, ["alpha", "gamma", "beta"]);

  const alpha = await connectAgentProject(workspace, "alpha", "alpha-key");
  const gamma = await connectAgentProject(workspace, "gamma", "gamma-key");
  await connectAgentProject(workspace, "beta", "beta-key");

  const [alphaResponses, gammaResponses] = await Promise.all([
    Promise.all(Array.from({ length: 6 }, (_, i) => alpha.request("agent_request", {
      target: "beta",
      text: `alpha ${i}`,
      idempotency_key: `two-proj-alpha-${i}`,
    }))),
    Promise.all(Array.from({ length: 6 }, (_, i) => gamma.request("agent_request", {
      target: "beta",
      text: `gamma ${i}`,
      idempotency_key: `two-proj-gamma-${i}`,
    }))),
  ]);

  assert.equal(alphaResponses.filter((res) => res.ok).length, 3, JSON.stringify(alphaResponses));
  assert.equal(
    alphaResponses.filter((res) => !res.ok && res.error.code === "request_rate_exceeded").length,
    3,
    JSON.stringify(alphaResponses),
  );
  assert.equal(gammaResponses.filter((res) => res.ok).length, 3, JSON.stringify(gammaResponses));
  assert.equal(
    gammaResponses.filter((res) => !res.ok && res.error.code === "request_rate_exceeded").length,
    3,
    JSON.stringify(gammaResponses),
  );
});

test("racing retries with the same idempotency_key return the first result and use no extra slot", async () => {
  const workspace = createRouterWorkspace({
    ...routerRegistry({
      demo: { channel_id: "demo-channel", type: "claude", transport: "router", agent_message_targets: ["beta", "offline"] },
      beta: { channel_id: "beta-channel", type: "codex", transport: "router" },
      offline: { channel_id: "offline-channel", type: "claude", transport: "router" },
    }),
    agent_message_limits: { requests_per_hour: 2, open_requests: 2 },
  });
  await routerWithWebhooks(workspace, ["demo", "beta", "offline"]);

  const demo = await connectAgentProject(workspace, "demo", "demo-key");
  const demoOps = await rawClient(workspace, { role: "project", project: "demo", key: "demo-key", listener: false });
  const beta = await connectAgentProject(workspace, "beta", "beta-key");

  // 4 concurrent calls with the exact same idempotency_key across listener + op-only connections.
  const raced = await Promise.all([
    demo.request("agent_request", { target: "beta", text: "raced send", idempotency_key: "race-idem-1" }),
    demoOps.request("agent_request", { target: "beta", text: "raced send", idempotency_key: "race-idem-1" }),
    demo.request("agent_request", { target: "beta", text: "raced send", idempotency_key: "race-idem-1" }),
    demoOps.request("agent_request", { target: "beta", text: "raced send", idempotency_key: "race-idem-1" }),
  ]);

  for (const res of raced) {
    assert.equal(res.ok, true, JSON.stringify(raced));
    assert.deepEqual(res.result, raced[0].result);
  }
  const reqId = raced[0].result.request_id;
  await waitFor(
    () => beta.events.some((event) => event.event === "agent_message" && event.request_id === reqId),
    () => `beta raced request: ${JSON.stringify(beta.events)}`,
  );
  await fenceOwnerMessage(workspace, beta, "beta-channel", "fence-after-raced-idem");
  assert.equal(beta.events.filter((event) => event.event === "agent_message" && event.request_id === reqId).length, 1);
  assert.equal((readState(workspace.stateDir).fixtures.discord.messages ?? []).length, 2);

  // Racing retries on a target_offline attempt also return the same refusal and consume only 1 rate slot.
  const racedOffline = await Promise.all([
    demo.request("agent_request", { target: "offline", text: "raced offline", idempotency_key: "race-idem-offline" }),
    demoOps.request("agent_request", { target: "offline", text: "raced offline", idempotency_key: "race-idem-offline" }),
    demo.request("agent_request", { target: "offline", text: "raced offline", idempotency_key: "race-idem-offline" }),
  ]);
  for (const res of racedOffline) {
    assert.equal(res.ok, false, JSON.stringify(racedOffline));
    assert.equal(res.error.code, "target_offline");
    assert.equal(res.error.message, racedOffline[0].error.message);
  }

  // Both rate slots are now used (1 accepted + 1 target_offline); a fresh key is refused.
  const third = await demo.request("agent_request", {
    target: "beta",
    text: "should exceed rate",
    idempotency_key: "race-idem-3",
  });
  assert.equal(third.ok, false, JSON.stringify(third));
  assert.equal(third.error.code, "request_rate_exceeded");
});

test("a failed ledger append leaves no reserved rate or open_requests slot behind", async () => {
  const workspace = createRouterWorkspace({
    ...routerRegistry({
      demo: { channel_id: "demo-channel", type: "claude", transport: "router", agent_message_targets: ["beta", "offline"] },
      beta: { channel_id: "beta-channel", type: "codex", transport: "router" },
      offline: { channel_id: "offline-channel", type: "claude", transport: "router" },
    }),
    agent_message_limits: { requests_per_hour: 2, open_requests: 2 },
  });
  await routerWithWebhooks(workspace, ["demo", "beta", "offline"]);

  const demo = await connectAgentProject(workspace, "demo", "demo-key");
  await connectAgentProject(workspace, "beta", "beta-key");
  const ledgerFile = path.join(workspace.routerStateDir, "agent-messages.jsonl");

  // Force ledger.append to fail with EISDIR -> ledger_unavailable on both online and offline sends.
  fs.mkdirSync(ledgerFile);
  const failed = await Promise.all([
    demo.request("agent_request", { target: "beta", text: "fail 1", idempotency_key: "fail-append-1" }),
    demo.request("agent_request", { target: "offline", text: "fail 2", idempotency_key: "fail-append-2" }),
    demo.request("agent_request", { target: "beta", text: "fail 3", idempotency_key: "fail-append-3" }),
  ]);
  for (const res of failed) {
    assert.equal(res.ok, false, JSON.stringify(failed));
    assert.equal(res.error.code, "ledger_unavailable");
  }

  // Restore ledger; none of the failed attempts consumed a rate or open_requests slot.
  fs.rmdirSync(ledgerFile);
  const afterRecovery = await Promise.all([
    demo.request("agent_request", { target: "beta", text: "ok 1", idempotency_key: "after-fail-1" }),
    demo.request("agent_request", { target: "beta", text: "ok 2", idempotency_key: "after-fail-2" }),
    demo.request("agent_request", { target: "beta", text: "over 3", idempotency_key: "after-fail-3" }),
  ]);
  assert.equal(afterRecovery.filter((res) => res.ok).length, 2, JSON.stringify(afterRecovery));
  assert.equal(
    afterRecovery.filter((res) => !res.ok && res.error.code === "request_rate_exceeded").length,
    1,
    JSON.stringify(afterRecovery),
  );
});
