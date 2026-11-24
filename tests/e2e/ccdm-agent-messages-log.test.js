// `scripts/ccdm agent-messages log`: reads the Router's private Agent Messages
// ledger directly (even while the Router is stopped) and prints exchange history.
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
  seedThreads,
  startRouter,
  waitFor,
  writeThreadKey,
} from "./support/router.js";
import { runScript } from "./support/runner.js";
import { updateState } from "./support/state.js";
import { cleanup, registerTeardownCallback } from "./support/teardown.js";

test.afterEach(cleanup);

const unix = text => text.replaceAll("\r\n", "\n");
const ledgerFile = workspace => path.join(workspace.routerStateDir, "agent-messages.jsonl");

async function connectClient(workspace, helloFrame) {
  const socket = net.connect(routerSocketPath(workspace));
  registerTeardownCallback(() => socket.destroy());
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  const frames = [];
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", chunk => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.trim()) frames.push(JSON.parse(line));
    }
  });
  const send = frame => socket.write(`${JSON.stringify(frame)}\n`);
  send({ type: "hello", v: 1, capabilities: ["agent_messages"], ...helloFrame });
  const hello = await waitFor(
    () => frames.find(frame => frame.type === "hello_ok" || frame.type === "hello_error"),
    () => `hello: ${JSON.stringify(frames)}`,
  );
  assert.equal(hello.type, "hello_ok", JSON.stringify(hello));
  let reqCount = 0;
  return {
    get events() { return frames.filter(frame => frame.type === "event"); },
    async request(op, args = {}, timeoutMs = 5000) {
      const id = `req-${++reqCount}`;
      send({ type: "request", id, op, args });
      return waitFor(
        () => frames.find(frame => frame.type === "response" && frame.id === id),
        () => `${op} response: ${JSON.stringify(frames)}`,
        timeoutMs,
      );
    },
    close() {
      socket.destroy();
    },
  };
}

async function connectProject(workspace, project, key = `${project}-key`) {
  return connectClient(workspace, { role: "project", project, key });
}

async function connectCapableThread(workspace, { project, threadId, provider = "claude", key = `${threadId}-key` }) {
  writeThreadKey(workspace, threadId, key);
  return connectClient(workspace, { role: "thread", project, thread_id: threadId, provider, key });
}

async function waitForEvent(client, predicate, label) {
  return waitFor(() => client.events.find(predicate), () => `${label}: ${JSON.stringify(client.events)}`);
}

async function runLog(workspace, args = [], options = {}) {
  const result = await runScript(workspace, "scripts/ccdm", {
    args: ["agent-messages", "log", ...args],
    env: { CCDM_ROUTER_STATE_DIR: workspace.routerStateDir, ...(options.env ?? {}) },
    timeoutMs: 20000,
    ...options,
  });
  return { ...result, stdout: unix(result.stdout), stderr: unix(result.stderr) };
}

function assertOk(result) {
  assert.equal(result.exitCode, 0, `${result.stderr}\n${result.stdout}`);
}

function assertFailed(result, pattern) {
  assert.equal(result.exitCode, 1, `${result.stderr}\n${result.stdout}`);
  assert.match(result.stderr, /^ccdm: /m);
  assert.match(result.stderr, pattern);
}

test("missing ledger prints empty history and exits 0 without creating the file; unreadable ledger exits 1 with ccdm: error", async () => {
  const workspace = createRouterWorkspace(routerRegistry());
  assert.equal(fs.existsSync(ledgerFile(workspace)), false);

  const help = await runScript(workspace, "scripts/ccdm", { args: ["agent-messages", "--help"], timeoutMs: 20000 });
  assertOk(help);
  assert.match(unix(help.stdout), /^\s+log\s/m);

  const emptyText = await runLog(workspace);
  assertOk(emptyText);
  assert.equal(emptyText.stdout, "");
  assert.equal(emptyText.stderr, "");
  assert.equal(fs.existsSync(ledgerFile(workspace)), false);

  const emptyJson = await runLog(workspace, ["--json"]);
  assertOk(emptyJson);
  assert.deepEqual(JSON.parse(emptyJson.stdout), []);
  assert.equal(fs.existsSync(ledgerFile(workspace)), false);

  // Invalid --limit fails with ccdm: ... and exit 1.
  assertFailed(await runLog(workspace, ["--limit", "0"]), /limit/i);

  // Corrupt ledger content fails with ccdm: ... and exit 1.
  fs.mkdirSync(workspace.routerStateDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(ledgerFile(workspace), "not-valid-json\n", { mode: 0o600 });
  assertFailed(await runLog(workspace), /ledger|corrupt/i);

  // Unsupported ledger version also fails.
  fs.writeFileSync(ledgerFile(workspace), `${JSON.stringify({ v: 99, at: "2026-11-25T00:00:00.000Z", type: "expired", request_id: "req-000000000001" })}\n`, { mode: 0o600 });
  assertFailed(await runLog(workspace), /ledger|version/i);

  // A directory at the ledger path cannot be read as a file -> ccdm: ... and exit 1.
  fs.rmSync(ledgerFile(workspace), { force: true });
  fs.mkdirSync(ledgerFile(workspace), { mode: 0o700 });
  assertFailed(await runLog(workspace), /ledger|read/i);
});

test("after exchanges with Router stopped, log shows requests and replies with both conversations and times newest last, text only with --text, and never modifies the ledger", async () => {
  const workspace = createRouterWorkspace(routerRegistry({
    demo: { channel_id: "demo-channel", type: "claude", transport: "router", agent_message_targets: ["beta"] },
    beta: { channel_id: "beta-channel", type: "codex", transport: "router", agent_message_targets: ["demo"] },
  }));
  seedThreads(workspace, {
    "thread-triage": { type: 11, parentId: "demo-channel", name: "triage" },
  });
  const router = await routerWithWebhooks(workspace, ["demo", "beta"]);
  const demo = await connectProject(workspace, "demo");
  const beta = await connectProject(workspace, "beta");
  const triage = await connectCapableThread(workspace, { project: "demo", threadId: "thread-triage", provider: "claude" });

  // Exchange 1: channel demo -> channel beta, replied.
  const firstReq = await demo.request("agent_request", {
    target: "beta",
    text: "SECRET_FIRST_REQUEST_TEXT",
    idempotency_key: "secret-idem-1",
  });
  assert.equal(firstReq.ok, true, JSON.stringify(firstReq));
  const firstId = firstReq.result.request_id;
  const firstDel = await waitForEvent(beta, e => e.event === "agent_message" && e.request_id === firstId && e.kind === "request", "first request delivery");
  await beta.request("agent_message_ack", { delivery_id: firstDel.delivery_id });

  const firstRep = await beta.request("agent_reply", {
    request_id: firstId,
    text: "SECRET_FIRST_REPLY_TEXT",
    idempotency_key: "secret-reply-idem-1",
  });
  assert.equal(firstRep.ok, true, JSON.stringify(firstRep));
  const firstRepDel = await waitForEvent(demo, e => e.event === "agent_message" && e.request_id === firstId && e.kind === "reply", "first reply delivery");
  await demo.request("agent_message_ack", { delivery_id: firstRepDel.delivery_id });

  // Exchange 2: thread demo/thread-triage -> channel beta, replied.
  const secondReq = await triage.request("agent_request", {
    target: "beta",
    text: "SECRET_SECOND_REQUEST_TEXT",
    idempotency_key: "secret-idem-2",
  });
  assert.equal(secondReq.ok, true, JSON.stringify(secondReq));
  const secondId = secondReq.result.request_id;
  const secondDel = await waitForEvent(beta, e => e.event === "agent_message" && e.request_id === secondId && e.kind === "request", "second request delivery");
  await beta.request("agent_message_ack", { delivery_id: secondDel.delivery_id });

  const secondRep = await beta.request("agent_reply", {
    request_id: secondId,
    text: "SECRET_SECOND_REPLY_TEXT",
    idempotency_key: "secret-reply-idem-2",
  });
  assert.equal(secondRep.ok, true, JSON.stringify(secondRep));
  const secondRepDel = await waitForEvent(triage, e => e.event === "agent_message" && e.request_id === secondId && e.kind === "reply", "second reply delivery");
  await triage.request("agent_message_ack", { delivery_id: secondRepDel.delivery_id });

  // Stop Router before inspecting the log.
  demo.close();
  beta.close();
  triage.close();
  await router.stop();

  const beforeStat = fs.statSync(ledgerFile(workspace));

  // Default text output: newest last, both conversations and times, NO message text.
  const plain = await runLog(workspace);
  assertOk(plain);
  const lines = plain.stdout.trimEnd().split("\n");
  assert.equal(lines.length, 2, plain.stdout);
  assert.match(lines[0], new RegExp(`${firstId}.*demo -> beta.*replied`));
  assert.match(lines[1], new RegExp(`${secondId}.*demo/thread-triage \\(triage\\) -> beta.*replied`));
  // Both timestamps (opened and reply) appear on each line.
  assert.ok((lines[0].match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/g) ?? []).length >= 2, lines[0]);
  assert.ok((lines[1].match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/g) ?? []).length >= 2, lines[1]);
  // No message text or idempotency keys leak without --text.
  for (const secret of ["SECRET_FIRST_REQUEST_TEXT", "SECRET_FIRST_REPLY_TEXT", "SECRET_SECOND_REQUEST_TEXT", "SECRET_SECOND_REPLY_TEXT", "secret-idem-1", "demo-key"]) {
    assert.doesNotMatch(plain.stdout, new RegExp(secret));
  }

  // With --text: message text appears for both request and reply.
  const withText = await runLog(workspace, ["--text"]);
  assertOk(withText);
  assert.match(withText.stdout, /SECRET_FIRST_REQUEST_TEXT/);
  assert.match(withText.stdout, /SECRET_FIRST_REPLY_TEXT/);
  assert.match(withText.stdout, /SECRET_SECOND_REQUEST_TEXT/);
  assert.match(withText.stdout, /SECRET_SECOND_REPLY_TEXT/);
  assert.ok(withText.stdout.indexOf(firstId) < withText.stdout.indexOf(secondId));

  // --json without --text: structured entries, no text fields.
  const jsonNoText = await runLog(workspace, ["--json"]);
  assertOk(jsonNoText);
  const parsed = JSON.parse(jsonNoText.stdout);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].kind, "exchange");
  assert.equal(parsed[0].request_id, firstId);
  assert.deepEqual(parsed[0].from, { project: "demo", provider: "claude", conversation_id: "demo-channel" });
  assert.deepEqual(parsed[0].to, { project: "beta", provider: "codex", conversation_id: "beta-channel" });
  assert.equal(parsed[0].outcome, "replied");
  assert.equal(typeof parsed[0].opened_at, "string");
  assert.equal(typeof parsed[0].ended_at, "string");
  assert.equal(typeof parsed[0].reply.at, "string");
  assert.equal(parsed[0].reply.delivered_to_live_session, true);
  assert.equal("text" in parsed[0], false);
  assert.equal("text" in parsed[0].reply, false);

  assert.equal(parsed[1].request_id, secondId);
  assert.deepEqual(parsed[1].from, {
    project: "demo",
    provider: "claude",
    conversation_id: "thread-triage",
    thread_id: "thread-triage",
    thread_name: "triage",
  });
  assert.equal(parsed[1].outcome, "replied");
  assert.equal("text" in parsed[1], false);
  assert.equal("text" in parsed[1].reply, false);

  // --json with --text: includes request and reply text.
  const jsonWithText = await runLog(workspace, ["--json", "--text"]);
  assertOk(jsonWithText);
  const parsedWithText = JSON.parse(jsonWithText.stdout);
  assert.equal(parsedWithText[0].text, "SECRET_FIRST_REQUEST_TEXT");
  assert.equal(parsedWithText[0].reply.text, "SECRET_FIRST_REPLY_TEXT");
  assert.equal(parsedWithText[1].text, "SECRET_SECOND_REQUEST_TEXT");
  assert.equal(parsedWithText[1].reply.text, "SECRET_SECOND_REPLY_TEXT");

  // Ledger file was never modified by log calls.
  const afterStat = fs.statSync(ledgerFile(workspace));
  assert.equal(afterStat.size, beforeStat.size);
  assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs);
});

test("refused, expired, and failed requests appear in log with their code or outcome", async () => {
  const workspace = createRouterWorkspace(routerRegistry({
    demo: { channel_id: "demo-channel", type: "claude", transport: "router", agent_message_targets: ["beta", "offline"] },
    beta: { channel_id: "beta-channel", type: "codex", transport: "router" },
    offline: { channel_id: "offline-channel", type: "gemini", transport: "router" },
    gamma: { channel_id: "gamma-channel", type: "claude", transport: "router" },
  }));
  seedThreads(workspace, {
    "thread-archived": { type: 11, parentId: "beta-channel", name: "old-task", archived: true },
  });
  const router = await routerWithWebhooks(workspace, ["demo", "beta", "offline", "gamma"], {
    env: { CCDM_ROUTER_AGENT_MESSAGE_MINUTE_MS: "150" },
  });
  const demo = await connectProject(workspace, "demo");
  const beta = await connectProject(workspace, "beta");

  // 1. Refused: not_granted
  const notGranted = await demo.request("agent_request", {
    target: "gamma",
    text: "unauthorized question",
    idempotency_key: "ref-not-granted",
  });
  assert.equal(notGranted.ok, false);
  assert.equal(notGranted.error.code, "not_granted");

  // 2. Refused: target_offline
  const offlineRes = await demo.request("agent_request", {
    target: "offline",
    text: "anyone home?",
    idempotency_key: "ref-offline",
  });
  assert.equal(offlineRes.ok, false);
  assert.equal(offlineRes.error.code, "target_offline");

  // 3. Refused: target_closed (archived thread)
  const closedRes = await demo.request("agent_request", {
    target: "beta/thread-archived",
    text: "archived thread ping",
    idempotency_key: "ref-closed",
  });
  assert.equal(closedRes.ok, false);
  assert.equal(closedRes.error.code, "target_closed");

  // 4. Expired request (1 shortened minute = 150ms)
  const expReq = await demo.request("agent_request", {
    target: "beta",
    text: "EXPIRED_REQ_TEXT",
    timeout_minutes: 1,
    idempotency_key: "exp-1",
  });
  assert.equal(expReq.ok, true, JSON.stringify(expReq));
  const expId = expReq.result.request_id;
  await waitForEvent(demo, e => e.event === "agent_message" && e.kind === "notice" && e.request_id === expId && e.outcome === "expired", "expired notice");

  // 5. Failed request (receiver record post fails with 500)
  updateState(workspace.stateDir, state => {
    state.fixtures.discord.restFailures = [
      { method: "POST", path: "/api/v10/channels/beta-channel/messages", status: 500 },
    ];
  });
  const failReq = await demo.request("agent_request", {
    target: "beta",
    text: "FAILED_REQ_TEXT",
    idempotency_key: "fail-1",
  });
  assert.equal(failReq.ok, true, JSON.stringify(failReq));
  const failId = failReq.result.request_id;
  await waitForEvent(demo, e => e.event === "agent_message" && e.kind === "notice" && e.request_id === failId && e.outcome === "failed", "failed notice");

  demo.close();
  beta.close();
  await router.stop();

  const textResult = await runLog(workspace);
  assertOk(textResult);
  const lines = textResult.stdout.trimEnd().split("\n");
  assert.equal(lines.length, 5, textResult.stdout);
  assert.match(lines[0], /demo -> gamma.*refused.*code=not_granted/);
  assert.match(lines[1], /req-[0-9a-f]{12}.*demo -> offline.*refused.*code=target_offline/);
  assert.match(lines[2], /req-[0-9a-f]{12}.*demo -> beta\/thread-archived \(old-task\).*refused.*code=target_closed/);
  assert.match(lines[3], new RegExp(`${expId}.*demo -> beta.*expired`));
  assert.match(lines[4], new RegExp(`${failId}.*demo -> beta.*failed`));
  assert.doesNotMatch(textResult.stdout, /EXPIRED_REQ_TEXT|FAILED_REQ_TEXT/);

  const jsonResult = await runLog(workspace, ["--json"]);
  assertOk(jsonResult);
  const entries = JSON.parse(jsonResult.stdout);
  assert.equal(entries.length, 5);
  assert.equal(entries[0].kind, "refusal");
  assert.equal(entries[0].outcome, "refused");
  assert.equal(entries[0].code, "not_granted");
  assert.equal(entries[0].target, "gamma");
  assert.equal(entries[0].to, null);

  assert.equal(entries[1].kind, "refusal");
  assert.equal(entries[1].code, "target_offline");
  assert.match(entries[1].request_id, /^req-[0-9a-f]{12}$/);
  assert.equal(entries[1].to.project, "offline");

  assert.equal(entries[2].kind, "refusal");
  assert.equal(entries[2].code, "target_closed");
  assert.equal(entries[2].to.thread_id, "thread-archived");

  assert.equal(entries[3].kind, "exchange");
  assert.equal(entries[3].request_id, expId);
  assert.equal(entries[3].outcome, "expired");
  assert.equal(typeof entries[3].ended_at, "string");
  assert.equal("text" in entries[3], false);

  assert.equal(entries[4].kind, "exchange");
  assert.equal(entries[4].request_id, failId);
  assert.equal(entries[4].outcome, "failed");
  assert.equal(typeof entries[4].ended_at, "string");
  assert.equal(typeof entries[4].reason, "string");
  assert.equal("text" in entries[4], false);
});

test("--project, --request, and --limit (default 50) filter and cap entries consistently in text and --json", async () => {
  const workspace = createRouterWorkspace(routerRegistry({
    alpha: { channel_id: "alpha-channel", type: "claude", transport: "router", agent_message_targets: ["beta"] },
    beta: { channel_id: "beta-channel", type: "codex", transport: "router", agent_message_targets: ["gamma"] },
    gamma: { channel_id: "gamma-channel", type: "gemini", transport: "router", agent_message_targets: ["alpha"] },
  }));
  const router = await routerWithWebhooks(workspace, ["alpha", "beta", "gamma"]);
  const alpha = await connectProject(workspace, "alpha");
  const beta = await connectProject(workspace, "beta");
  const gamma = await connectProject(workspace, "gamma");

  // 52 early refusals (alpha -> gamma, not granted) so total entries > 50.
  for (let i = 1; i <= 52; i += 1) {
    const denied = await alpha.request("agent_request", {
      target: "gamma",
      text: `denied-${i}`,
      idempotency_key: `bulk-deny-${i}`,
    });
    assert.equal(denied.ok, false);
    assert.equal(denied.error.code, "not_granted");
  }

  // Exchange A: alpha -> beta (replied, plus a duplicate reply refusal).
  const reqA = await alpha.request("agent_request", {
    target: "beta",
    text: "EXCHANGE_A_REQ",
    idempotency_key: "ex-a",
  });
  assert.equal(reqA.ok, true);
  const idA = reqA.result.request_id;
  await waitForEvent(beta, e => e.event === "agent_message" && e.request_id === idA && e.kind === "request", "req A");
  const repA = await beta.request("agent_reply", {
    request_id: idA,
    text: "EXCHANGE_A_REP",
    idempotency_key: "ex-a-rep",
  });
  assert.equal(repA.ok, true);
  await waitForEvent(alpha, e => e.event === "agent_message" && e.request_id === idA && e.kind === "reply", "rep A");
  const dupRepA = await beta.request("agent_reply", {
    request_id: idA,
    text: "duplicate",
    idempotency_key: "ex-a-rep-2",
  });
  assert.equal(dupRepA.ok, false);
  assert.equal(dupRepA.error.code, "already_replied");

  // Exchange B: beta -> gamma (replied).
  const reqB = await beta.request("agent_request", {
    target: "gamma",
    text: "EXCHANGE_B_REQ",
    idempotency_key: "ex-b",
  });
  assert.equal(reqB.ok, true);
  const idB = reqB.result.request_id;
  await waitForEvent(gamma, e => e.event === "agent_message" && e.request_id === idB && e.kind === "request", "req B");
  const repB = await gamma.request("agent_reply", {
    request_id: idB,
    text: "EXCHANGE_B_REP",
    idempotency_key: "ex-b-rep",
  });
  assert.equal(repB.ok, true);
  await waitForEvent(beta, e => e.event === "agent_message" && e.request_id === idB && e.kind === "reply", "rep B");

  // Exchange C: gamma -> alpha (left open).
  const reqC = await gamma.request("agent_request", {
    target: "alpha",
    text: "EXCHANGE_C_REQ",
    idempotency_key: "ex-c",
  });
  assert.equal(reqC.ok, true);
  const idC = reqC.result.request_id;
  await waitForEvent(alpha, e => e.event === "agent_message" && e.request_id === idC && e.kind === "request", "req C");

  alpha.close();
  beta.close();
  gamma.close();
  await router.stop();

  // Default limit is 50 (out of 56 total: 52 refusals + idA + dupRepA + idB + idC), newest last.
  const defaultJson = await runLog(workspace, ["--json"]);
  assertOk(defaultJson);
  const defaultEntries = JSON.parse(defaultJson.stdout);
  assert.equal(defaultEntries.length, 50);
  assert.equal(defaultEntries.at(-1).request_id, idC);
  assert.equal(defaultEntries.at(-2).request_id, idB);
  assert.equal(defaultEntries.at(-3).code, "already_replied");
  assert.equal(defaultEntries.at(-4).request_id, idA);

  const defaultText = await runLog(workspace);
  assertOk(defaultText);
  assert.equal(defaultText.stdout.trimEnd().split("\n").length, 50);

  // --limit 2 returns the 2 newest entries, newest last.
  const limit2 = await runLog(workspace, ["--limit", "2", "--json"]);
  assertOk(limit2);
  const limit2Entries = JSON.parse(limit2.stdout);
  assert.deepEqual(limit2Entries.map(e => e.request_id), [idB, idC]);

  // --project beta keeps only entries where beta is sender or target (idA, dupRepA, idB).
  const byBetaJson = await runLog(workspace, ["--project", "beta", "--json"]);
  assertOk(byBetaJson);
  const betaEntries = JSON.parse(byBetaJson.stdout);
  assert.equal(betaEntries.length, 3);
  assert.deepEqual(betaEntries.map(e => e.request_id), [idA, idA, idB]);
  assert.equal(betaEntries[0].kind, "exchange");
  assert.equal(betaEntries[1].kind, "refusal");
  assert.equal(betaEntries[1].code, "already_replied");
  assert.equal(betaEntries[2].kind, "exchange");

  const byBetaLimit = await runLog(workspace, ["--project", "beta", "--limit", "1", "--json"]);
  assertOk(byBetaLimit);
  assert.deepEqual(JSON.parse(byBetaLimit.stdout).map(e => e.request_id), [idB]);

  // --project gamma includes gamma as target of not_granted refusals AND as target of idB AND sender of idC.
  const byGammaJson = await runLog(workspace, ["--project", "gamma", "--limit", "3", "--json"]);
  assertOk(byGammaJson);
  const gammaTail = JSON.parse(byGammaJson.stdout);
  assert.equal(gammaTail.length, 3);
  assert.equal(gammaTail[0].code, "not_granted");
  assert.equal(gammaTail[0].target, "gamma");
  assert.equal(gammaTail[1].request_id, idB);
  assert.equal(gammaTail[2].request_id, idC);

  // --request shows one exchange (even when an already_replied refusal also named that request_id).
  const oneExchangeJson = await runLog(workspace, ["--request", idA, "--text", "--json"]);
  assertOk(oneExchangeJson);
  const oneEntries = JSON.parse(oneExchangeJson.stdout);
  assert.equal(oneEntries.length, 1);
  assert.equal(oneEntries[0].kind, "exchange");
  assert.equal(oneEntries[0].request_id, idA);
  assert.equal(oneEntries[0].text, "EXCHANGE_A_REQ");
  assert.equal(oneEntries[0].reply.text, "EXCHANGE_A_REP");

  const oneExchangeText = await runLog(workspace, ["--request", idA]);
  assertOk(oneExchangeText);
  const oneLines = oneExchangeText.stdout.trimEnd().split("\n");
  assert.equal(oneLines.length, 1);
  assert.match(oneLines[0], new RegExp(`${idA}.*alpha -> beta.*replied`));

  // --request for an unknown id returns empty history and exit 0.
  const unknownReq = await runLog(workspace, ["--request", "req-000000000000", "--json"]);
  assertOk(unknownReq);
  assert.deepEqual(JSON.parse(unknownReq.stdout), []);
});

test("log ignores a torn final line, works after Router restart compaction, and never modifies the ledger", async () => {
  const workspace = createRouterWorkspace(routerRegistry({
    demo: { channel_id: "demo-channel", type: "claude", transport: "router", agent_message_targets: ["beta"] },
    beta: { channel_id: "beta-channel", type: "codex", transport: "router" },
    gamma: { channel_id: "gamma-channel", type: "gemini", transport: "router" },
  }));

  // Seed one closed exchange and one refusal older than 30 days as input so Router compaction drops them on restart.
  const oldIso = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
  const oldReplyIso = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000 + 5000).toISOString();
  const oldExpiryIso = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000 + 30 * 60 * 1000).toISOString();
  const demoConv = { project: "demo", provider: "claude", conversation_id: "demo-channel" };
  const betaConv = { project: "beta", provider: "codex", conversation_id: "beta-channel" };
  fs.mkdirSync(workspace.routerStateDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    ledgerFile(workspace),
    [
      JSON.stringify({
        v: 1,
        at: oldIso,
        type: "request",
        request_id: "req-000000000001",
        from: demoConv,
        to: betaConv,
        from_launch: "old-demo-launch",
        to_launch: "old-beta-launch",
        text: "ANCIENT_REQUEST",
        depth: 1,
        expires_at: oldExpiryIso,
        idempotency_key: "old-idem-1",
      }),
      JSON.stringify({
        v: 1,
        at: oldReplyIso,
        type: "reply",
        request_id: "req-000000000001",
        from: betaConv,
        to: demoConv,
        from_launch: "old-beta-launch",
        text: "ANCIENT_REPLY",
        idempotency_key: "old-rep-1",
        delivered_to_live_session: true,
      }),
      JSON.stringify({
        v: 1,
        at: oldIso,
        type: "refusal",
        refusal_id: "ref-000000000001",
        op: "agent_request",
        from: demoConv,
        to: null,
        target: "gamma",
        code: "not_granted",
        message: "demo is not granted to send Agent Requests to gamma",
        from_launch: "old-demo-launch",
        idempotency_key: "old-ref-1",
      }),
    ].join("\n") + "\n",
    { mode: 0o600 },
  );

  // Start Router: compacts out the >30d closed entries.
  const router1 = await routerWithWebhooks(workspace, ["demo", "beta", "gamma"]);
  const demo = await connectProject(workspace, "demo");
  const beta = await connectProject(workspace, "beta");

  const req = await demo.request("agent_request", {
    target: "beta",
    text: "FRESH_POST_COMPACT_REQ",
    idempotency_key: "fresh-1",
  });
  assert.equal(req.ok, true);
  const freshId = req.result.request_id;
  const reqEv = await waitForEvent(beta, e => e.event === "agent_message" && e.request_id === freshId && e.kind === "request", "fresh req");
  await beta.request("agent_message_ack", { delivery_id: reqEv.delivery_id });
  const rep = await beta.request("agent_reply", {
    request_id: freshId,
    text: "FRESH_POST_COMPACT_REP",
    idempotency_key: "fresh-rep-1",
  });
  assert.equal(rep.ok, true);
  const repEv = await waitForEvent(demo, e => e.event === "agent_message" && e.request_id === freshId && e.kind === "reply", "fresh rep");
  await demo.request("agent_message_ack", { delivery_id: repEv.delivery_id });

  const denied = await demo.request("agent_request", {
    target: "gamma",
    text: "fresh denied",
    idempotency_key: "fresh-deny-1",
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.error.code, "not_granted");

  demo.close();
  beta.close();
  await router1.stop();

  // Restart Router so compaction runs again on the live ledger, then stop it.
  const router2 = await startRouter(workspace);
  await router2.stop();

  const compactedStat = fs.statSync(ledgerFile(workspace));
  const afterCompact = await runLog(workspace, ["--text", "--json"]);
  assertOk(afterCompact);
  const compactedEntries = JSON.parse(afterCompact.stdout);
  assert.equal(compactedEntries.length, 2);
  assert.equal(compactedEntries[0].request_id, freshId);
  assert.equal(compactedEntries[0].outcome, "replied");
  assert.equal(compactedEntries[0].text, "FRESH_POST_COMPACT_REQ");
  assert.equal(compactedEntries[0].reply.text, "FRESH_POST_COMPACT_REP");
  assert.equal(compactedEntries[1].kind, "refusal");
  assert.equal(compactedEntries[1].code, "not_granted");
  // Old compacted-out entries are gone.
  assert.equal(compactedEntries.some(e => e.request_id === "req-000000000001"), false);
  // Ledger file was not touched by log.
  const afterCompactStat = fs.statSync(ledgerFile(workspace));
  assert.equal(afterCompactStat.size, compactedStat.size);
  assert.equal(afterCompactStat.mtimeMs, compactedStat.mtimeMs);

  // Append a torn unterminated final line (crash mid-write) and confirm log ignores it without modifying the file.
  fs.appendFileSync(ledgerFile(workspace), '{"v":1,"at":"2026-11-25T01:00:00.000Z","type":"request"');
  const tornStatBefore = fs.statSync(ledgerFile(workspace));

  const tornJson = await runLog(workspace, ["--json"]);
  assertOk(tornJson);
  const tornEntries = JSON.parse(tornJson.stdout);
  assert.equal(tornEntries.length, 2);
  assert.equal(tornEntries[0].request_id, freshId);
  assert.equal(tornEntries[1].code, "not_granted");

  const tornStatAfter = fs.statSync(ledgerFile(workspace));
  assert.equal(tornStatAfter.size, tornStatBefore.size);
  assert.equal(tornStatAfter.mtimeMs, tornStatBefore.mtimeMs);
});
