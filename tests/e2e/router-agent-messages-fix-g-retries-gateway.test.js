// Round-2 retry, failure-journaling, and gateway-wait tests (Worker G: G4, G5, G6):
// - G4: a late reply (or route-mismatch reply) during a ledger outage never
//   cancels the expiry retry; once the ledger is writable again, the request
//   expires on its own with ⚠️ marks, notice, and freed open_requests slot.
// - G5: a failed request post during a ledger outage never reports failure
//   before `failed` is written to the ledger; (a) when the ledger becomes
//   writable, the sender gets the failure notice and a restart never delivers
//   to the target; (b) if the Router restarts first, the request recovers as a
//   normal open request and the sender is never told it failed.
// - G6: when the Discord gateway never becomes ready after a restart, a
//   recovered open request still expires on time, `agent_reply` to a recovered
//   open request returns within a bounded time, and deferred posting retries
//   once the gateway becomes ready.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import test from "node:test";

import { collectProcess, injectDiscordMessage } from "./support/bridge.js";
import {
  OWNER_ID,
  ROOT_TOKEN,
  createRouterWorkspace,
  killRouter,
  routerEnv,
  routerRegistry,
  routerSocketPath,
  routerWithWebhooks,
  runRouterCli,
  startRouter,
  waitFor,
} from "./support/router.js";
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

function clearDiscordFaults(workspace) {
  updateState(workspace.stateDir, (state) => {
    state.fixtures.discord.rateLimits = [];
    state.fixtures.discord.rateLimitHits = [];
    state.fixtures.discord.restFailures = [];
    state.fixtures.discord.restFailureUses = [];
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

function makeLedgerUnwritable(workspace) {
  const ledgerFile = path.join(workspace.routerStateDir, "agent-messages.jsonl");
  const savedLedger = `${ledgerFile}.saved`;
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    try { fs.rmdirSync(ledgerFile); } catch {}
    if (fs.existsSync(savedLedger)) fs.renameSync(savedLedger, ledgerFile);
  };
  registerTeardownCallback(restore);
  fs.renameSync(ledgerFile, savedLedger);
  fs.mkdirSync(ledgerFile);
  return restore;
}

// Starts the Router without waiting for `router ready` (used when the gateway
// is intentionally held back so we wait for `status` to answer instead).
async function startRouterWithoutGatewayReady(workspace, { env: extraEnv = {} } = {}) {
  const env = routerEnv(workspace, extraEnv);
  const command = [process.execPath, path.join(workspace.repoDir, "scripts/router.js"), "serve"];
  const child = spawn(command[0], command.slice(1), {
    cwd: workspace.repoDir,
    detached: true,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const running = collectProcess(child, { command, cwd: workspace.repoDir, detached: true, env }, workspace);
  registerTeardownCallback(() => running.stop());
  await waitFor(
    async () => {
      const res = await runRouterCli(workspace, ["status", "--json"]);
      return res.exitCode === 0 ? JSON.parse(res.stdout) : null;
    },
    () => `router socket listening:\n${running.stdout}\n${running.stderr}`,
    10000,
  );
  return running;
}

test("G4: a late reply during a ledger outage does not cancel expiry retry; restoring the ledger expires the request automatically", async () => {
  const workspace = createRouterWorkspace({
    ...routerRegistry({
      demo: { channel_id: "demo-channel", type: "claude", transport: "router", agent_message_targets: ["beta"] },
      beta: { channel_id: "beta-channel", type: "codex", transport: "router" },
    }),
    agent_message_limits: { open_requests: 1 },
  });
  const router = await routerWithWebhooks(workspace, ["demo", "beta"], {
    env: { CCDM_ROUTER_AGENT_MESSAGE_MINUTE_MS: "250" },
  });

  const demo = await connectAgentProject(workspace, "demo", "demo-key");
  const beta = await connectAgentProject(workspace, "beta", "beta-key");

  const sent = await demo.request("agent_request", {
    target: "beta",
    text: "Expire even after late reply hits ledger outage",
    timeout_minutes: 2, // 500ms
    idempotency_key: "fixg-g4-req-1",
  });
  assert.equal(sent.ok, true, JSON.stringify(sent));
  const reqId = sent.result.request_id;

  const reqEv = await waitFor(
    () => beta.events.find((e) => e.event === "agent_message" && e.kind === "request" && e.request_id === reqId),
    () => `beta request: ${JSON.stringify(beta.events)}`,
  );
  assert.equal((await beta.request("agent_message_ack", { delivery_id: reqEv.delivery_id })).ok, true);
  await waitFor(
    () => (readState(workspace.stateDir).fixtures.discord.messages ?? []).length === 2,
    () => "two request records",
  );

  // Swap ledger file for a directory before expiry fires.
  const restoreLedger = makeLedgerUnwritable(workspace);

  // Wait for the expiry timer to fire and fail its first append.
  await waitFor(
    () => router.stdout.includes("agent_message_ledger_failed type=expired"),
    () => `expected expiry ledger failure in stdout:\n${router.stdout}\n${router.stderr}`,
    5000,
  );

  // A late reply arrives during the outage -> refused with ledger_unavailable.
  // Before G4, this cancelled the armed retry timer and left nothing re-armed!
  const lateDuringOutage = await beta.request("agent_reply", {
    request_id: reqId,
    text: "Late reply during outage",
    idempotency_key: "fixg-g4-late-during-outage",
  });
  assert.equal(lateDuringOutage.ok, false);
  assert.equal(lateDuringOutage.error.code, "ledger_unavailable");

  // Restore the ledger: without restarting or sending another reply, the
  // re-armed retry expires the request, adds ⚠️ marks, sends the notice, and
  // frees open_requests.
  restoreLedger();

  const notice = await waitFor(
    () => demo.events.find((e) => e.event === "agent_message" && e.kind === "notice" && e.request_id === reqId),
    () => `demo expiry notice after G4 retry: ${JSON.stringify(demo.events)}\nstdout:\n${router.stdout}`,
    5000,
  );
  assert.equal(notice.outcome, "expired");

  const warnEmoji = encodeURIComponent("⚠️");
  await waitFor(
    () => (readState(workspace.stateDir).fixtures.discord.reactions ?? []).filter((r) => r.emoji === warnEmoji).length === 2,
    () => `two ⚠️ marks after G4 retry: ${JSON.stringify(readState(workspace.stateDir).fixtures.discord.reactions)}`,
  );

  const followUp = await demo.request("agent_request", {
    target: "beta",
    text: "Slot is free again",
    timeout_minutes: 30,
    idempotency_key: "fixg-g4-followup",
  });
  assert.equal(followUp.ok, true, JSON.stringify(followUp));
});

test("G4: a route-mismatch reply during a ledger outage does not cancel the open request's expiry timer", async () => {
  const workspace = createRouterWorkspace(routerRegistry({
    demo: { channel_id: "demo-channel", type: "claude", transport: "router", agent_message_targets: ["beta"] },
    beta: { channel_id: "beta-channel", type: "codex", transport: "router" },
  }));
  const router = await routerWithWebhooks(workspace, ["demo", "beta"], {
    env: { CCDM_ROUTER_AGENT_MESSAGE_MINUTE_MS: "350", CCDM_ROUTER_REGISTRY_DEBOUNCE_MS: "50" },
  });

  const demo = await connectAgentProject(workspace, "demo", "demo-key");
  const beta = await connectAgentProject(workspace, "beta", "beta-key");

  const sent = await demo.request("agent_request", {
    target: "beta",
    text: "Route mismatch during ledger outage",
    timeout_minutes: 3, // 1050ms
    idempotency_key: "fixg-g4-route-req-1",
  });
  assert.equal(sent.ok, true, JSON.stringify(sent));
  const reqId = sent.result.request_id;
  const reqEv = await waitFor(
    () => beta.events.find((e) => e.event === "agent_message" && e.kind === "request" && e.request_id === reqId),
    () => "beta request",
  );
  assert.equal((await beta.request("agent_message_ack", { delivery_id: reqEv.delivery_id })).ok, true);

  // Move beta to another channel so replying hits the route-mismatch path.
  const regPath = path.join(workspace.repoDir, "registry.json");
  const reg = JSON.parse(fs.readFileSync(regPath, "utf8"));
  reg.projects.beta.channel_id = "beta-channel-moved";
  fs.writeFileSync(regPath, `${JSON.stringify(reg, null, 2)}\n`);
  await waitFor(
    () => beta.events.some((e) => e.event === "scope_changed" && e.scope?.channel_id === "beta-channel-moved"),
    () => `beta scope_changed: ${JSON.stringify(beta.events)}`,
  );

  // Make ledger unwritable and send a reply hitting route mismatch -> ledger_unavailable.
  const restoreLedger = makeLedgerUnwritable(workspace);
  const mismatchReply = await beta.request("agent_reply", {
    request_id: reqId,
    text: "Reply after channel moved during outage",
    idempotency_key: "fixg-g4-route-rep-1",
  });
  assert.equal(mismatchReply.ok, false);
  assert.equal(mismatchReply.error.code, "ledger_unavailable");

  // Restore ledger before expiry: because the failed route-mismatch append did
  // not cancel the timer, the request still expires on schedule!
  restoreLedger();
  const notice = await waitFor(
    () => demo.events.find((e) => e.event === "agent_message" && e.kind === "notice" && e.request_id === reqId),
    () => `demo expiry notice after route-mismatch outage: ${JSON.stringify(demo.events)}`,
    5000,
  );
  assert.equal(notice.outcome, "expired");
});

test("G5(a): failed sender post during a ledger outage holds the failure notice until `failed` is written, then notifies sender and never delivers after restart", async () => {
  const workspace = createRouterWorkspace(routerRegistry({
    demo: { channel_id: "demo-channel", type: "claude", transport: "router", agent_message_targets: ["beta"] },
    beta: { channel_id: "beta-channel", type: "codex", transport: "router" },
  }));
  const env = { CCDM_ROUTER_AGENT_MESSAGE_MINUTE_MS: "400" };
  let router = await routerWithWebhooks(workspace, ["demo", "beta"], { env });

  const demo1 = await connectAgentProject(workspace, "demo", "demo-key");
  const beta1 = await connectAgentProject(workspace, "beta", "beta-key");

  // Hold demo's webhook POST briefly with a 429, then fail the retry with 500!
  const demoWebhookPath = webhookExecutePath(workspace, "demo-channel");
  updateState(workspace.stateDir, (state) => {
    state.fixtures.discord.rateLimits = [{ method: "POST", path: demoWebhookPath, count: 1, retryAfter: 0.3 }];
    state.fixtures.discord.rateLimitHits = [];
    state.fixtures.discord.restFailures = [{ method: "POST", path: demoWebhookPath, status: 500 }];
    state.fixtures.discord.restFailureUses = [];
  });

  const sent = await demo1.request("agent_request", {
    target: "beta",
    text: "Post fails during ledger outage (a)",
    timeout_minutes: 30,
    idempotency_key: "fixg-g5a-req-1",
  });
  assert.equal(sent.ok, true, JSON.stringify(sent));
  const reqId = sent.result.request_id;

  // Pause point: publishRequest hit the 429 hold. Make ledger unwritable BEFORE the 500 hits!
  await waitForHoldHit(workspace, demoWebhookPath);
  const restoreLedger = makeLedgerUnwritable(workspace);

  // Wait for the 500 post failure and the failed `failed` ledger append.
  await waitFor(
    () => router.stdout.includes("agent_message_ledger_failed type=failed"),
    () => `expected failed ledger append log:\n${router.stdout}\n${router.stderr}`,
    5000,
  );

  // Sender gets NO failure notice during the outage.
  await fenceOwnerMessage(workspace, demo1, "demo-channel", "fence-g5a-during-outage");
  assert.deepEqual(demo1.events.filter((e) => e.event === "agent_message"), []);

  // Restore the ledger: retry writes `failed` and THEN notifies sender.
  restoreLedger();
  const failNotice = await waitFor(
    () => demo1.events.find((e) => e.event === "agent_message" && e.kind === "notice" && e.request_id === reqId),
    () => `demo1 failure notice after ledger restored: ${JSON.stringify(demo1.events)}`,
    5000,
  );
  assert.equal(failNotice.outcome, "failed");
  assert.equal((await demo1.request("agent_message_ack", { delivery_id: failNotice.delivery_id })).ok, true);

  // Restart the Router: target NEVER receives the request!
  await demo1.close();
  await beta1.close();
  killRouter(router);
  await router.closed;
  clearDiscordFaults(workspace);
  router = await startRouter(workspace, { env });

  const beta2 = await connectAgentProject(workspace, "beta", "beta-key");
  await fenceOwnerMessage(workspace, beta2, "beta-channel", "fence-g5a-beta-never-gets-it");
  assert.deepEqual(beta2.events.filter((e) => e.event === "agent_message"), []);
  assert.equal((readState(workspace.stateDir).fixtures.discord.messages ?? []).length, 0);
});

test("G5(b): failed sender post during a ledger outage followed by a Router restart recovers the request as open and never tells the sender it failed", async () => {
  const workspace = createRouterWorkspace(routerRegistry({
    demo: { channel_id: "demo-channel", type: "claude", transport: "router", agent_message_targets: ["beta"] },
    beta: { channel_id: "beta-channel", type: "codex", transport: "router" },
  }));
  const env = { CCDM_ROUTER_AGENT_MESSAGE_MINUTE_MS: "400" };
  let router = await routerWithWebhooks(workspace, ["demo", "beta"], { env });

  const demo1 = await connectAgentProject(workspace, "demo", "demo-key");
  const beta1 = await connectAgentProject(workspace, "beta", "beta-key");

  const demoWebhookPath = webhookExecutePath(workspace, "demo-channel");
  updateState(workspace.stateDir, (state) => {
    state.fixtures.discord.rateLimits = [{ method: "POST", path: demoWebhookPath, count: 1, retryAfter: 0.3 }];
    state.fixtures.discord.rateLimitHits = [];
    state.fixtures.discord.restFailures = [{ method: "POST", path: demoWebhookPath, status: 500 }];
    state.fixtures.discord.restFailureUses = [];
  });

  const sent = await demo1.request("agent_request", {
    target: "beta",
    text: "Post fails during outage then Router restarts (b)",
    timeout_minutes: 30,
    idempotency_key: "fixg-g5b-req-1",
  });
  assert.equal(sent.ok, true, JSON.stringify(sent));
  const reqId = sent.result.request_id;

  await waitForHoldHit(workspace, demoWebhookPath);
  const restoreLedger = makeLedgerUnwritable(workspace);

  await waitFor(
    () => router.stdout.includes("agent_message_ledger_failed type=failed"),
    () => `expected failed ledger append log:\n${router.stdout}\n${router.stderr}`,
    5000,
  );

  // Sender gets NO failure notice before restart.
  await fenceOwnerMessage(workspace, demo1, "demo-channel", "fence-g5b-no-fail-notice");
  assert.deepEqual(demo1.events.filter((e) => e.event === "agent_message"), []);

  // Router crashes BEFORE ledger is writable again, then restarts with ledger restored.
  await demo1.close();
  await beta1.close();
  killRouter(router);
  await router.closed;
  restoreLedger();
  clearDiscordFaults(workspace);

  router = await startRouter(workspace, { env });
  const demo2 = await connectAgentProject(workspace, "demo", "demo-key");
  const beta2 = await connectAgentProject(workspace, "beta", "beta-key");

  // Request recovers as a normal open request: beta receives it and replies!
  const reqEv = await waitFor(
    () => beta2.events.find((e) => e.event === "agent_message" && e.kind === "request" && e.request_id === reqId),
    () => `beta2 recovered open request: ${JSON.stringify(beta2.events)}`,
  );
  assert.equal(reqEv.text, "Post fails during outage then Router restarts (b)");
  assert.equal((await beta2.request("agent_message_ack", { delivery_id: reqEv.delivery_id })).ok, true);

  const rep = await beta2.request("agent_reply", {
    request_id: reqId,
    text: "Handled normally after restart",
    idempotency_key: "fixg-g5b-rep-1",
  });
  assert.equal(rep.ok, true, JSON.stringify(rep));

  const repEv = await waitFor(
    () => demo2.events.find((e) => e.event === "agent_message" && e.kind === "reply" && e.request_id === reqId),
    () => `demo2 reply: ${JSON.stringify(demo2.events)}`,
  );
  assert.equal(repEv.text, "Handled normally after restart");

  // Sender was NEVER told the request failed.
  await fenceOwnerMessage(workspace, demo2, "demo-channel", "fence-g5b-demo-never-failed");
  assert.equal(demo2.events.some((e) => e.event === "agent_message" && e.kind === "notice" && e.outcome === "failed"), false);
});

test("G6: with a gateway that never becomes ready after restart, a recovered open request still expires on time and agent_reply returns within bounded time", async () => {
  const workspace = createRouterWorkspace(routerRegistry({
    demo: { channel_id: "demo-channel", type: "claude", transport: "router", agent_message_targets: ["beta"] },
    beta: { channel_id: "beta-channel", type: "codex", transport: "router" },
  }));
  const env = {
    CCDM_ROUTER_AGENT_MESSAGE_MINUTE_MS: "300",
    CCDM_ROUTER_HELLO_READY_WAIT_MS: "300",
  };
  let router = await routerWithWebhooks(workspace, ["demo", "beta"], { env });

  const demo1 = await connectAgentProject(workspace, "demo", "demo-key");
  const beta1 = await connectAgentProject(workspace, "beta", "beta-key");

  // Hold demo's webhook so TWO requests are accepted but unpublished before crash:
  // reqExpire has a short timeout (2 * 300ms = 600ms); reqReply has a long timeout (30 min).
  const demoWebhookPath = webhookExecutePath(workspace, "demo-channel");
  holdDiscordPath(workspace, { method: "POST", apiPath: demoWebhookPath, retryAfter: 10, count: 2 });

  const sentExpire = await demo1.request("agent_request", {
    target: "beta",
    text: "Should expire on time without gateway ready",
    timeout_minutes: 2,
    idempotency_key: "fixg-g6-exp-1",
  });
  assert.equal(sentExpire.ok, true, JSON.stringify(sentExpire));
  const reqExpireId = sentExpire.result.request_id;

  const sentReply = await demo1.request("agent_request", {
    target: "beta",
    text: "Should allow agent_reply without gateway ready",
    timeout_minutes: 30,
    idempotency_key: "fixg-g6-rep-1",
  });
  assert.equal(sentReply.ok, true, JSON.stringify(sentReply));
  const reqReplyId = sentReply.result.request_id;

  await waitForHoldHit(workspace, demoWebhookPath);
  await demo1.close();
  await beta1.close();
  killRouter(router);
  await router.closed;
  clearDiscordFaults(workspace);

  // Hold the Discord gateway back indefinitely (10 minutes) on restart!
  updateState(workspace.stateDir, (state) => {
    state.fixtures.discord.readyDelayMs = 600000;
  });

  router = await startRouterWithoutGatewayReady(workspace, { env });
  const initialStatus = JSON.parse((await runRouterCli(workspace, ["status", "--json"])).stdout);
  assert.equal(initialStatus.gateway, "connecting");

  const demo2 = await connectAgentProject(workspace, "demo", "demo-key");
  const beta2 = await connectAgentProject(workspace, "beta", "beta-key");

  // 1. agent_reply to the recovered open request returns within bounded time (not hanging on gatewayReady).
  const replyStartedAt = Date.now();
  const replyRes = await beta2.request("agent_reply", {
    request_id: reqReplyId,
    text: "Reply while gateway is still connecting",
    idempotency_key: "fixg-g6-reply-call-1",
  }, 3000);
  const replyElapsedMs = Date.now() - replyStartedAt;
  assert.equal(replyRes.ok, true, JSON.stringify(replyRes));
  assert.ok(replyElapsedMs < 2500, `agent_reply took ${replyElapsedMs}ms`);

  // 2. The short-timeout recovered request still expires on time and notifies demo2.
  const expNotice = await waitFor(
    () => demo2.events.find((e) => e.event === "agent_message" && e.kind === "notice" && e.request_id === reqExpireId),
    () => `demo2 expired notice without gateway ready: ${JSON.stringify(demo2.events)}`,
    3000,
  );
  assert.equal(expNotice.outcome, "expired");

  const statusAfter = JSON.parse((await runRouterCli(workspace, ["status", "--json"])).stdout);
  assert.equal(statusAfter.gateway, "connecting");
  assert.deepEqual(statusAfter.agent_messages.open_requests, []);
});

test("G6: deferred recovery posting retries once the Discord gateway becomes ready", async () => {
  const workspace = createRouterWorkspace(routerRegistry({
    demo: { channel_id: "demo-channel", type: "claude", transport: "router", agent_message_targets: ["beta"] },
    beta: { channel_id: "beta-channel", type: "codex", transport: "router" },
  }));
  const env = {
    CCDM_ROUTER_HELLO_READY_WAIT_MS: "200",
  };
  let router = await routerWithWebhooks(workspace, ["demo", "beta"], { env });

  const demo1 = await connectAgentProject(workspace, "demo", "demo-key");
  const beta1 = await connectAgentProject(workspace, "beta", "beta-key");

  const demoWebhookPath = webhookExecutePath(workspace, "demo-channel");
  holdDiscordPath(workspace, { method: "POST", apiPath: demoWebhookPath });

  const sent = await demo1.request("agent_request", {
    target: "beta",
    text: "Retry posting when gateway becomes ready",
    timeout_minutes: 30,
    idempotency_key: "fixg-g6-deferred-1",
  });
  assert.equal(sent.ok, true, JSON.stringify(sent));
  const reqId = sent.result.request_id;

  await waitForHoldHit(workspace, demoWebhookPath);
  await demo1.close();
  await beta1.close();
  killRouter(router);
  await router.closed;
  clearDiscordFaults(workspace);

  // Delay gateway readiness past the 200ms recovery wait so posting defers and then retries at ~900ms.
  updateState(workspace.stateDir, (state) => {
    state.fixtures.discord.readyDelayMs = 900;
  });

  router = await startRouterWithoutGatewayReady(workspace, { env });
  const beta2 = await connectAgentProject(workspace, "beta", "beta-key");

  // Once the gateway becomes ready, deferred recovery posts both records and delivers to beta2.
  const reqEv = await waitFor(
    () => beta2.events.find((e) => e.event === "agent_message" && e.kind === "request" && e.request_id === reqId),
    () => `beta2 deferred request after gateway ready: ${JSON.stringify(beta2.events)}`,
    5000,
  );
  assert.equal(reqEv.text, "Retry posting when gateway becomes ready");
  await waitFor(
    () => (readState(workspace.stateDir).fixtures.discord.messages ?? []).length === 2,
    () => `two request records after gateway ready: ${JSON.stringify(readState(workspace.stateDir).fixtures.discord.messages)}`,
  );
});
