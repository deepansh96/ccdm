import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import test from "node:test";

import {
  createRouterWorkspace,
  routerRegistry,
  routerSocketPath,
  routerWithWebhooks,
  runRouterCli,
  seedThreads,
  startRouter,
  waitFor,
  writeThreadKey,
} from "./support/router.js";
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

async function readStatus(workspace) {
  const [jsonResult, textResult] = await Promise.all([
    runRouterCli(workspace, ["status", "--json"]),
    runRouterCli(workspace, ["status"]),
  ]);
  assert.equal(jsonResult.exitCode, 0, jsonResult.stderr || jsonResult.stdout);
  assert.equal(textResult.exitCode, 0, textResult.stderr || textResult.stdout);
  return {
    json: JSON.parse(jsonResult.stdout),
    rawJson: jsonResult.stdout,
    text: textResult.stdout,
  };
}

test("with no exchanges, router status shows ledger ok with zero open requests and zero refusals in both JSON and text", async () => {
  const workspace = createRouterWorkspace(routerRegistry({
    demo: { channel_id: "demo-channel", type: "claude", transport: "router", agent_message_targets: ["beta"] },
    beta: { channel_id: "beta-channel", type: "codex", transport: "router" },
  }));
  await routerWithWebhooks(workspace, ["demo", "beta"]);

  const { json, text } = await readStatus(workspace);

  assert.equal(json.gateway, "ready");
  assert.ok(Array.isArray(json.projects));
  assert.ok(Array.isArray(json.sessions));
  assert.ok(Array.isArray(json.scope_violations));
  assert.deepEqual(json.agent_messages, {
    ledger: { ok: true, error: null },
    open_requests: [],
    recent_refusals: [],
  });
  assert.match(text, /\nagent messages: ledger ok\n/);
  assert.match(text, /\nopen agent requests: 0\n/);
  assert.match(text, /\nrecent agent refusals: 0\n/);
});

test("an open request appears with its ID, both conversations, opened_at, expires_at and depth, leaks no text or secrets, and disappears once replied or expired", async () => {
  const workspace = createRouterWorkspace(routerRegistry({
    demo: { channel_id: "demo-channel", type: "claude", transport: "router", agent_message_targets: ["beta"] },
    beta: { channel_id: "beta-channel", type: "codex", transport: "router", agent_message_targets: ["gamma"] },
    gamma: { channel_id: "gamma-channel", type: "claude", transport: "router" },
  }));
  seedThreads(workspace, {
    "gamma-thread-1": { type: 11, parentId: "gamma-channel", name: "inspector" },
  });
  writeThreadKey(workspace, "gamma-thread-1", "gamma-thread-secret-key");
  const env = { CCDM_ROUTER_AGENT_MESSAGE_MINUTE_MS: "400" };
  await routerWithWebhooks(workspace, ["demo", "beta", "gamma"], { env });

  const demo = await connectAgentProject(workspace, "demo", "demo-key");
  const beta = await connectAgentProject(workspace, "beta", "beta-key");
  const gammaThread = await connectAgentThread(workspace, "gamma", "gamma-thread-1", "gamma-thread-secret-key", "claude");
  assert.equal(gammaThread.hello.type, "hello_ok");

  const secretBody1 = "TOP_SECRET_REQUEST_BODY_ALPHA";
  const secretBody2 = "TOP_SECRET_REQUEST_BODY_BETA";

  const req1 = await demo.request("agent_request", {
    target: "beta",
    text: secretBody1,
    timeout_minutes: 30,
    idempotency_key: "status-open-1",
  });
  assert.equal(req1.ok, true, JSON.stringify(req1));
  const req1Id = req1.result.request_id;
  await waitFor(
    () => beta.events.some((event) => event.event === "agent_message" && event.request_id === req1Id),
    () => `beta req1: ${JSON.stringify(beta.events)}`,
  );

  // Nested request from beta -> gamma thread (depth 2) with short timeout (2 min = 800ms).
  const req2 = await beta.request("agent_request", {
    target: "gamma/gamma-thread-1",
    text: secretBody2,
    timeout_minutes: 2,
    idempotency_key: "status-open-2",
  });
  assert.equal(req2.ok, true, JSON.stringify(req2));
  const req2Id = req2.result.request_id;
  await waitFor(
    () => gammaThread.events.some((event) => event.event === "agent_message" && event.request_id === req2Id),
    () => `gammaThread req2: ${JSON.stringify(gammaThread.events)}`,
  );

  const openStatus = await readStatus(workspace);
  assert.equal(openStatus.json.agent_messages.ledger.ok, true);
  assert.equal(openStatus.json.agent_messages.ledger.error, null);
  assert.equal(openStatus.json.agent_messages.open_requests.length, 2);

  const [entry1, entry2] = openStatus.json.agent_messages.open_requests;
  assert.deepEqual(Object.keys(entry1).sort(), ["depth", "expires_at", "from", "opened_at", "request_id", "to"]);
  assert.equal(entry1.request_id, req1Id);
  assert.deepEqual(entry1.from, { project: "demo", provider: "claude", conversation_id: "demo-channel" });
  assert.deepEqual(entry1.to, { project: "beta", provider: "codex", conversation_id: "beta-channel" });
  assert.ok(Number.isFinite(Date.parse(entry1.opened_at)));
  assert.equal(entry1.expires_at, req1.result.expires_at);
  assert.equal(entry1.depth, 1);

  assert.equal(entry2.request_id, req2Id);
  assert.deepEqual(entry2.from, { project: "beta", provider: "codex", conversation_id: "beta-channel" });
  assert.deepEqual(entry2.to, {
    project: "gamma",
    provider: "claude",
    conversation_id: "gamma-thread-1",
    thread_id: "gamma-thread-1",
    thread_name: "inspector",
  });
  assert.ok(Number.isFinite(Date.parse(entry2.opened_at)));
  assert.equal(entry2.expires_at, req2.result.expires_at);
  assert.equal(entry2.depth, 2);

  // Text output lists both open requests in scope-violation block style.
  assert.match(openStatus.text, new RegExp(
    `open agent requests: 2\\n`
    + `  ${req1Id} from=demo to=beta opened_at=\\S+ expires_at=\\S+ depth=1\\n`
    + `  ${req2Id} from=beta to=gamma/gamma-thread-1 opened_at=\\S+ expires_at=\\S+ depth=2\\n`,
  ));

  // No message text, launch key, or bot/webhook token appears anywhere in JSON or text status output.
  for (const forbidden of [secretBody1, secretBody2, "demo-key", "beta-key", "gamma-thread-secret-key", "root-bot-token", "fake-webhook-token"]) {
    assert.equal(openStatus.rawJson.includes(forbidden), false, `status --json leaked ${forbidden}`);
    assert.equal(openStatus.text.includes(forbidden), false, `status text leaked ${forbidden}`);
  }

  // Reply to req1 -> req1 disappears while req2 remains (until req2 expires).
  const replied = await beta.request("agent_reply", {
    request_id: req1Id,
    text: "TOP_SECRET_REPLY_BODY",
    idempotency_key: "status-reply-1",
  });
  assert.equal(replied.ok, true, JSON.stringify(replied));

  const afterReply = await readStatus(workspace);
  assert.equal(afterReply.json.agent_messages.open_requests.some((r) => r.request_id === req1Id), false);
  assert.equal(afterReply.rawJson.includes("TOP_SECRET_REPLY_BODY"), false);
  assert.equal(afterReply.text.includes("TOP_SECRET_REPLY_BODY"), false);

  // Wait for req2 to expire -> it disappears too.
  await waitFor(
    () => beta.events.some((event) => event.event === "agent_message" && event.kind === "notice" && event.request_id === req2Id && event.outcome === "expired"),
    () => `beta expired notice for ${req2Id}: ${JSON.stringify(beta.events)}`,
    6000,
  );

  const afterExpiry = await readStatus(workspace);
  assert.deepEqual(afterExpiry.json.agent_messages.open_requests, []);
  assert.match(afterExpiry.text, /\nopen agent requests: 0\n/);
});

test("each refusal appears with time, sender, target as given and code, and only the latest 20 are kept", async () => {
  const workspace = createRouterWorkspace(routerRegistry({
    demo: { channel_id: "demo-channel", type: "claude", transport: "router", agent_message_targets: ["beta"] },
    beta: { channel_id: "beta-channel", type: "codex", transport: "router" },
  }));
  seedThreads(workspace, {
    "demo-thread-1": { type: 11, parentId: "demo-channel", name: "runner" },
  });
  writeThreadKey(workspace, "demo-thread-1", "demo-thread-key");
  await routerWithWebhooks(workspace, ["demo", "beta"]);

  const demo = await connectAgentProject(workspace, "demo", "demo-key");
  const demoThread = await connectAgentThread(workspace, "demo", "demo-thread-1", "demo-thread-key", "claude");
  assert.equal(demoThread.hello.type, "hello_ok");

  // Trigger 23 refusals: first 3 will be evicted once all 23 land, leaving #4..#23 (20 total).
  for (let i = 1; i <= 20; i += 1) {
    const res = await demo.request("agent_request", {
      target: `ungranted-${i}`,
      text: `REFUSAL_SECRET_BODY_${i}`,
      idempotency_key: `refusal-batch-${i}`,
    });
    assert.equal(res.ok, false);
    assert.equal(res.error.code, "not_granted");
  }

  // #21: target_offline to granted project beta (as given: "beta").
  const offlineRes = await demo.request("agent_request", {
    target: "beta",
    text: "REFUSAL_SECRET_OFFLINE",
    idempotency_key: "refusal-21-offline",
  });
  assert.equal(offlineRes.ok, false);
  assert.equal(offlineRes.error.code, "target_offline");

  // #22: unknown_target from a thread sender (target as given: "beta/nonexistent-thread").
  const threadRes = await demoThread.request("agent_request", {
    target: "beta/nonexistent-thread",
    text: "REFUSAL_SECRET_THREAD",
    idempotency_key: "refusal-22-thread",
  });
  assert.equal(threadRes.ok, false);
  assert.equal(threadRes.error.code, "unknown_target");

  // #23: agent_reply unknown_request refusal.
  const replyRes = await demo.request("agent_reply", {
    request_id: "req-000000000023",
    text: "REFUSAL_SECRET_REPLY",
    idempotency_key: "refusal-23-reply",
  });
  assert.equal(replyRes.ok, false);
  assert.equal(replyRes.error.code, "unknown_request");

  // Repeating an idempotent refusal must NOT create a duplicate entry in recent_refusals.
  const replay = await demo.request("agent_reply", {
    request_id: "req-000000000023",
    text: "REFUSAL_SECRET_REPLY",
    idempotency_key: "refusal-23-reply",
  });
  assert.equal(replay.ok, false);
  assert.equal(replay.error.code, "unknown_request");

  const { json, rawJson, text } = await readStatus(workspace);
  const refusals = json.agent_messages.recent_refusals;
  assert.equal(refusals.length, 20);

  // Oldest 3 (ungranted-1..3) were dropped; first kept is ungranted-4.
  assert.equal(refusals[0].target, "ungranted-4");
  assert.equal(refusals[0].code, "not_granted");
  assert.deepEqual(refusals[0].from, { project: "demo", provider: "claude", conversation_id: "demo-channel" });
  assert.ok(Number.isFinite(Date.parse(refusals[0].at)));
  assert.deepEqual(Object.keys(refusals[0]).sort(), ["at", "code", "from", "target"]);

  // Last 3 are #21 (target_offline), #22 (unknown_target from thread), #23 (unknown_request).
  assert.equal(refusals[17].target, "beta");
  assert.equal(refusals[17].code, "target_offline");
  assert.deepEqual(refusals[17].from, { project: "demo", provider: "claude", conversation_id: "demo-channel" });

  assert.equal(refusals[18].target, "beta/nonexistent-thread");
  assert.equal(refusals[18].code, "unknown_target");
  assert.deepEqual(refusals[18].from, {
    project: "demo",
    provider: "claude",
    conversation_id: "demo-thread-1",
    thread_id: "demo-thread-1",
    thread_name: "runner",
  });

  assert.equal(refusals[19].target, "req-000000000023");
  assert.equal(refusals[19].code, "unknown_request");

  // Text output shows count 20 and formats entries in scope-violation block style.
  assert.match(text, /\nrecent agent refusals: 20\n/);
  assert.match(text, /  \d{4}-\d{2}-\d{2}T\S+ from=demo target=ungranted-4 code=not_granted\n/);
  assert.match(text, /  \d{4}-\d{2}-\d{2}T\S+ from=demo target=beta code=target_offline\n/);
  assert.match(text, /  \d{4}-\d{2}-\d{2}T\S+ from=demo\/demo-thread-1 target=beta\/nonexistent-thread code=unknown_target\n/);
  assert.match(text, /  \d{4}-\d{2}-\d{2}T\S+ from=demo target=req-000000000023 code=unknown_request\n/);
  assert.equal(text.includes("target=ungranted-1 "), false);
  assert.equal(text.includes("target=ungranted-3 "), false);

  // No message text or secrets leak.
  for (const forbidden of ["REFUSAL_SECRET_BODY_4", "REFUSAL_SECRET_OFFLINE", "REFUSAL_SECRET_THREAD", "REFUSAL_SECRET_REPLY", "demo-key", "demo-thread-key"]) {
    assert.equal(rawJson.includes(forbidden), false, `status --json leaked ${forbidden}`);
    assert.equal(text.includes(forbidden), false, `status text leaked ${forbidden}`);
  }
});

test("with an unreadable ledger, router status shows ledger.ok false with error and ledger unavailable in text while the rest of status is unchanged", async () => {
  const workspace = createRouterWorkspace(routerRegistry({
    demo: { channel_id: "demo-channel", type: "claude", transport: "router", agent_message_targets: ["beta"] },
    beta: { channel_id: "beta-channel", type: "codex", transport: "router" },
  }));
  let router = await routerWithWebhooks(workspace, ["demo", "beta"]);
  await router.stop();

  const ledgerFile = path.join(workspace.routerStateDir, "agent-messages.jsonl");
  fs.writeFileSync(ledgerFile, "corrupt non-json ledger line\n", { mode: 0o600 });

  router = await startRouter(workspace);
  const demo = await connectAgentProject(workspace, "demo", "demo-key");
  // Trigger a normal scope violation to verify existing status sections stay intact.
  const violation = await demo.request("reply", { channel_id: "beta-channel", text: "out of scope" });
  assert.equal(violation.ok, false);
  assert.equal(violation.error.code, "scope_violation");

  const { json, text } = await readStatus(workspace);

  assert.equal(json.gateway, "ready");
  assert.equal(json.registry_error, null);
  assert.equal(json.sessions.length, 1);
  assert.equal(json.sessions[0].project, "demo");
  assert.equal(json.supervisor.connected, false);
  assert.ok(json.projects.some((p) => p.project === "demo" && p.webhook === true));
  assert.ok(json.projects.some((p) => p.project === "beta" && p.webhook === true));
  assert.equal(json.scope_violations.length, 1);
  assert.equal(json.scope_violations[0].project, "demo");
  assert.equal(json.scope_violations[0].target, "beta-channel");

  assert.equal(json.agent_messages.ledger.ok, false);
  assert.equal(typeof json.agent_messages.ledger.error, "string");
  assert.ok(json.agent_messages.ledger.error.length > 0);
  assert.deepEqual(json.agent_messages.open_requests, []);
  assert.deepEqual(json.agent_messages.recent_refusals, []);

  assert.match(text, /^gateway: ready\n/);
  assert.match(text, /\nsessions: 1\n  project demo scope=demo-channel connected=/);
  assert.match(text, /\nscope violations: 1\n  \S+ project=demo op=reply target=beta-channel\n/);
  assert.match(text, /\nagent messages: ledger unavailable/);
  assert.match(text, /\nopen agent requests: 0\n/);
  assert.match(text, /\nrecent agent refusals: 0\n/);
});

test("open requests and recent refusals survive a Router restart (keeping only the latest 20 refusals and excluding closed exchanges)", async () => {
  const workspace = createRouterWorkspace(routerRegistry({
    demo: { channel_id: "demo-channel", type: "claude", transport: "router", agent_message_targets: ["beta"] },
    beta: { channel_id: "beta-channel", type: "codex", transport: "router" },
  }));
  seedThreads(workspace, {
    "beta-thread-1": { type: 11, parentId: "beta-channel", name: "worker" },
  });
  writeThreadKey(workspace, "beta-thread-1", "beta-thread-key");
  let router = await routerWithWebhooks(workspace, ["demo", "beta"]);

  const demo1 = await connectAgentProject(workspace, "demo", "demo-key");
  const beta1 = await connectAgentProject(workspace, "beta", "beta-key");
  const betaThread1 = await connectAgentThread(workspace, "beta", "beta-thread-1", "beta-thread-key", "codex");
  assert.equal(betaThread1.hello.type, "hello_ok");

  // One request that stays open across restart (to beta thread).
  const openReq = await demo1.request("agent_request", {
    target: "beta/beta-thread-1",
    text: "SECRET_OPEN_ACROSS_RESTART",
    timeout_minutes: 30,
    idempotency_key: "restart-status-open-1",
  });
  assert.equal(openReq.ok, true, JSON.stringify(openReq));
  const openReqId = openReq.result.request_id;

  // One request that is answered before restart (must NOT appear in open_requests after restart).
  const closedReq = await demo1.request("agent_request", {
    target: "beta",
    text: "SECRET_CLOSED_BEFORE_RESTART",
    timeout_minutes: 30,
    idempotency_key: "restart-status-closed-1",
  });
  assert.equal(closedReq.ok, true, JSON.stringify(closedReq));
  const closedReqId = closedReq.result.request_id;
  await waitFor(
    () => beta1.events.some((event) => event.event === "agent_message" && event.request_id === closedReqId),
    () => `beta1 closedReq: ${JSON.stringify(beta1.events)}`,
  );
  assert.equal((await beta1.request("agent_reply", {
    request_id: closedReqId,
    text: "SECRET_CLOSED_ANSWER",
    idempotency_key: "restart-status-closed-reply-1",
  })).ok, true);

  // 22 refusals before restart -> latest 20 (#3..#22) must survive restart.
  for (let i = 1; i <= 22; i += 1) {
    const res = await demo1.request("agent_request", {
      target: `blocked-${i}`,
      text: `SECRET_REFUSAL_${i}`,
      idempotency_key: `restart-status-refusal-${i}`,
    });
    assert.equal(res.ok, false);
    assert.equal(res.error.code, "not_granted");
  }

  const beforeRestart = await readStatus(workspace);
  assert.equal(beforeRestart.json.agent_messages.open_requests.length, 1);
  assert.equal(beforeRestart.json.agent_messages.open_requests[0].request_id, openReqId);
  assert.equal(beforeRestart.json.agent_messages.recent_refusals.length, 20);
  assert.equal(beforeRestart.json.agent_messages.recent_refusals[0].target, "blocked-3");
  assert.equal(beforeRestart.json.agent_messages.recent_refusals[19].target, "blocked-22");

  // Restart the Router.
  await demo1.close();
  await beta1.close();
  await betaThread1.close();
  await router.stop();
  router = await startRouter(workspace);

  const afterRestart = await readStatus(workspace);
  assert.deepEqual(afterRestart.json.agent_messages, beforeRestart.json.agent_messages);
  assert.match(afterRestart.text, /\nagent messages: ledger ok\n/);
  assert.match(afterRestart.text, new RegExp(
    `open agent requests: 1\\n  ${openReqId} from=demo to=beta/beta-thread-1 opened_at=\\S+ expires_at=\\S+ depth=1\\n`,
  ));
  assert.match(afterRestart.text, /\nrecent agent refusals: 20\n/);
  assert.match(afterRestart.text, /  \S+ from=demo target=blocked-3 code=not_granted\n/);
  assert.match(afterRestart.text, /  \S+ from=demo target=blocked-22 code=not_granted\n/);
  assert.equal(afterRestart.text.includes("target=blocked-2 "), false);

  for (const forbidden of ["SECRET_OPEN_ACROSS_RESTART", "SECRET_CLOSED_BEFORE_RESTART", "SECRET_CLOSED_ANSWER", "SECRET_REFUSAL_22", "beta-thread-key"]) {
    assert.equal(afterRestart.rawJson.includes(forbidden), false, `post-restart JSON leaked ${forbidden}`);
    assert.equal(afterRestart.text.includes(forbidden), false, `post-restart text leaked ${forbidden}`);
  }
});
