// Regression tests for PR #409 worker H (finding H1):
// `scripts/ccdm agent-messages log` skips unknown ledger record types with exit 0
// while warning clearly on stderr that the running Router refuses such a ledger
// (so sends may fail with `ledger_unavailable`), naming the skipped line numbers
// and pointing to `router status`.
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
  startRouter,
  waitFor,
} from "./support/router.js";
import { runScript } from "./support/runner.js";
import { cleanup, registerTeardownCallback } from "./support/teardown.js";

test.afterEach(cleanup);

const unix = (text) => text.replaceAll("\r\n", "\n");
const ledgerFile = (workspace) => path.join(workspace.routerStateDir, "agent-messages.jsonl");

async function connectProject(workspace, project, key = `${project}-key`) {
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
  const send = (frame) => socket.write(`${JSON.stringify(frame)}\n`);
  send({ type: "hello", v: 1, capabilities: ["agent_messages"], role: "project", project, key });
  const hello = await waitFor(
    () => frames.find((frame) => frame.type === "hello_ok" || frame.type === "hello_error"),
    () => `hello: ${JSON.stringify(frames)}`,
  );
  assert.equal(hello.type, "hello_ok", JSON.stringify(hello));
  let reqCount = 0;
  return {
    get events() { return frames.filter((frame) => frame.type === "event"); },
    async request(op, args = {}, timeoutMs = 5000) {
      const id = `req-${++reqCount}`;
      send({ type: "request", id, op, args });
      return waitFor(
        () => frames.find((frame) => frame.type === "response" && frame.id === id),
        () => `${op} response: ${JSON.stringify(frames)}`,
        timeoutMs,
      );
    },
    close() {
      socket.destroy();
    },
  };
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

test("log on a Router-written ledger with an unknown record type warns of Router refusal, ledger_unavailable, router status, and skipped line numbers", async () => {
  const workspace = createRouterWorkspace(routerRegistry({
    demo: { channel_id: "demo-channel", type: "claude", transport: "router", agent_message_targets: ["beta"] },
    beta: { channel_id: "beta-channel", type: "codex", transport: "router" },
  }));
  const router = await routerWithWebhooks(workspace, ["demo", "beta"]);
  const demo = await connectProject(workspace, "demo");
  const beta = await connectProject(workspace, "beta");

  const req = await demo.request("agent_request", {
    target: "beta",
    text: "H1_KNOWN_REQUEST",
    idempotency_key: "h1-req-1",
  });
  assert.equal(req.ok, true, JSON.stringify(req));
  const requestId = req.result.request_id;
  const reqEv = await waitForEvent(beta, (e) => e.event === "agent_message" && e.request_id === requestId && e.kind === "request", "req delivery");
  await beta.request("agent_message_ack", { delivery_id: reqEv.delivery_id });

  const rep = await beta.request("agent_reply", {
    request_id: requestId,
    text: "H1_KNOWN_REPLY",
    idempotency_key: "h1-rep-1",
  });
  assert.equal(rep.ok, true, JSON.stringify(rep));
  const repEv = await waitForEvent(demo, (e) => e.event === "agent_message" && e.request_id === requestId && e.kind === "reply", "rep delivery");
  await demo.request("agent_message_ack", { delivery_id: repEv.delivery_id });

  demo.close();
  beta.close();
  await router.stop();

  // Append one corrupted/unknown-type record line to the Router-written ledger.
  const corruptRecord = {
    v: 1,
    at: new Date().toISOString(),
    type: "reqvest",
    request_id: "req-corrupted0001",
  };
  fs.appendFileSync(ledgerFile(workspace), `${JSON.stringify(corruptRecord)}\n`);
  const beforeStat = fs.statSync(ledgerFile(workspace));

  const plain = await runLog(workspace);
  assert.equal(plain.exitCode, 0, `${plain.stderr}\n${plain.stdout}`);
  const stdoutLines = plain.stdout.trimEnd().split("\n");
  assert.equal(stdoutLines.length, 1, plain.stdout);
  assert.match(stdoutLines[0], new RegExp(`${requestId}.*demo -> beta.*replied`));

  const stderrLines = plain.stderr.trim().split("\n");
  assert.equal(stderrLines.length, 1, plain.stderr);
  const note = stderrLines[0];
  assert.match(note, /skipped 1\b/i);
  const lineMatch = note.match(/\bline\s+(\d+)\b/i);
  assert.ok(lineMatch, `expected skipped line number in stderr note, got: ${note}`);
  const firstSkippedLine = Number(lineMatch[1]);
  assert.ok(firstSkippedLine >= 2, `expected skipped line >= 2 after Router exchange, got ${firstSkippedLine}`);
  assert.match(note, /Router refuses/i);
  assert.match(note, /ledger_unavailable/);
  assert.match(note, /router status/i);

  const asJson = await runLog(workspace, ["--json"]);
  assert.equal(asJson.exitCode, 0, `${asJson.stderr}\n${asJson.stdout}`);
  const parsed = JSON.parse(asJson.stdout);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].request_id, requestId);
  assert.equal(parsed[0].outcome, "replied");
  assert.equal(asJson.stderr.trim(), note);

  // Appending a second unknown-type line reports both consecutive line numbers.
  fs.appendFileSync(
    ledgerFile(workspace),
    `${JSON.stringify({ v: 1, at: new Date().toISOString(), type: "repIy", request_id: "req-corrupted0002" })}\n`,
  );
  const second = await runLog(workspace);
  assert.equal(second.exitCode, 0, `${second.stderr}\n${second.stdout}`);
  const secondStderrLines = second.stderr.trim().split("\n");
  assert.equal(secondStderrLines.length, 1, second.stderr);
  assert.match(secondStderrLines[0], /skipped 2\b/i);
  assert.match(
    secondStderrLines[0],
    new RegExp(`\\blines\\s+${firstSkippedLine},\\s*${firstSkippedLine + 1}\\b`, "i"),
    `expected both line numbers ${firstSkippedLine} and ${firstSkippedLine + 1} in: ${secondStderrLines[0]}`,
  );
  assert.match(secondStderrLines[0], /Router refuses/i);
  assert.match(secondStderrLines[0], /ledger_unavailable/);
  assert.match(secondStderrLines[0], /router status/i);

  // Confirm log did not modify the ledger on the first run.
  const firstRunStatCheck = fs.statSync(ledgerFile(workspace));
  assert.ok(firstRunStatCheck.size > beforeStat.size, "only our second append should have grown the file");

  // Confirm the note describes actual Router behavior: restarting the Router on this
  // ledger makes router status report ledger unavailable and sends fail with ledger_unavailable.
  const restarted = await startRouter(workspace);
  try {
    const status = await runRouterCli(workspace, ["status", "--json"]);
    assert.equal(status.exitCode, 0, status.stderr);
    const statusJson = JSON.parse(status.stdout);
    assert.equal(statusJson.agent_messages.ledger.ok, false);
    const demo2 = await connectProject(workspace, "demo");
    const blocked = await demo2.request("agent_request", {
      target: "beta",
      text: "blocked by unknown type",
      idempotency_key: "h1-blocked-1",
    });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.error.code, "ledger_unavailable");
    demo2.close();
  } finally {
    await restarted.stop();
  }
});

test("log reports exact 1-based line numbers for skipped unknown record types", async () => {
  const workspace = createRouterWorkspace(routerRegistry({
    demo: { channel_id: "demo-channel", type: "claude", transport: "router" },
  }));
  fs.mkdirSync(workspace.routerStateDir, { recursive: true, mode: 0o700 });
  const now = new Date().toISOString();
  const validRefusal = {
    v: 1,
    at: now,
    type: "refusal",
    refusal_id: "ref-h1exact0001",
    op: "agent_request",
    from: { project: "demo", provider: "claude", conversation_id: "demo-channel" },
    to: null,
    target: "beta",
    code: "not_granted",
    message: "demo is not granted to send Agent Requests to beta",
    from_launch: "launch-h1",
    idempotency_key: "idem-h1-exact",
  };
  const unknownLine2 = { v: 1, at: now, type: "reqvest", request_id: "req-bad-2" };
  const unknownLine4 = { v: 1, at: now, type: "markx", request_id: "req-bad-4" };
  fs.writeFileSync(
    ledgerFile(workspace),
    [
      JSON.stringify(validRefusal),
      JSON.stringify(unknownLine2),
      JSON.stringify({ ...validRefusal, refusal_id: "ref-h1exact0002", idempotency_key: "idem-h1-exact-2" }),
      JSON.stringify(unknownLine4),
    ].join("\n") + "\n",
    { mode: 0o600 },
  );

  const result = await runLog(workspace);
  assert.equal(result.exitCode, 0, `${result.stderr}\n${result.stdout}`);
  assert.equal(result.stdout.trimEnd().split("\n").length, 2, result.stdout);
  const stderrLines = result.stderr.trim().split("\n");
  assert.equal(stderrLines.length, 1, result.stderr);
  assert.match(stderrLines[0], /skipped 2\b/i);
  assert.match(stderrLines[0], /\blines\s+2,\s*4\b/i, stderrLines[0]);
  assert.match(stderrLines[0], /Router refuses/i);
  assert.match(stderrLines[0], /ledger_unavailable/);
  assert.match(stderrLines[0], /router status/i);
});
