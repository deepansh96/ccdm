// Regression tests for PR #409 worker F (findings 9 and 13):
// - `scripts/ccdm agent-messages log` handles a final line torn mid-UTF-8 character;
// - `log` is lenient with unknown record types (skipping with a one-line note)
//   and unknown extra fields on known records;
// - JS ledger and Python log reader stay in step on known record types.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";
import test from "node:test";

import {
  createRouterWorkspace,
  routerRegistry,
  routerSocketPath,
  routerWithWebhooks,
  waitFor,
} from "./support/router.js";
import { runScript } from "./support/runner.js";
import { cleanup, registerTeardownCallback } from "./support/teardown.js";

const require = createRequire(import.meta.url);
const { pythonCommand } = require("../../scripts/platform/tools.js");

test.afterEach(cleanup);

const unix = text => text.replaceAll("\r\n", "\n");
const ledgerFile = workspace => path.join(workspace.routerStateDir, "agent-messages.jsonl");

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
  send({ type: "hello", v: 1, capabilities: ["agent_messages"], role: "project", project, key });
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

test("log ignores a final line cut in the middle of a multi-byte UTF-8 character without modifying the ledger", async () => {
  const workspace = createRouterWorkspace(routerRegistry({
    demo: { channel_id: "demo-channel", type: "claude", transport: "router", agent_message_targets: ["beta"] },
    beta: { channel_id: "beta-channel", type: "codex", transport: "router" },
    gamma: { channel_id: "gamma-channel", type: "gemini", transport: "router" },
  }));
  const router = await routerWithWebhooks(workspace, ["demo", "beta", "gamma"]);
  const demo = await connectProject(workspace, "demo");
  const beta = await connectProject(workspace, "beta");

  // One complete exchange written by the real Router.
  const firstReq = await demo.request("agent_request", {
    target: "beta",
    text: "COMPLETE_EXCHANGE_REQ",
    idempotency_key: "utf8-torn-ex-1",
  });
  assert.equal(firstReq.ok, true, JSON.stringify(firstReq));
  const firstId = firstReq.result.request_id;
  const reqEv = await waitForEvent(beta, e => e.event === "agent_message" && e.request_id === firstId && e.kind === "request", "req delivery");
  await beta.request("agent_message_ack", { delivery_id: reqEv.delivery_id });

  const firstRep = await beta.request("agent_reply", {
    request_id: firstId,
    text: "COMPLETE_EXCHANGE_REP",
    idempotency_key: "utf8-torn-rep-1",
  });
  assert.equal(firstRep.ok, true, JSON.stringify(firstRep));
  const repEv = await waitForEvent(demo, e => e.event === "agent_message" && e.request_id === firstId && e.kind === "reply", "rep delivery");
  await demo.request("agent_message_ack", { delivery_id: repEv.delivery_id });

  // A synchronous refusal with a 4-byte UTF-8 character written as the final line.
  const denied = await demo.request("agent_request", {
    target: "gamma/🚀-cut",
    text: "refused",
    idempotency_key: "utf8-torn-deny-1",
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.error.code, "not_granted");

  demo.close();
  beta.close();
  await router.stop();

  // Truncate the real Router ledger in the middle of the 4-byte 🚀 UTF-8 sequence on the last line.
  const rawBytes = fs.readFileSync(ledgerFile(workspace));
  const rocketBytes = Buffer.from("🚀", "utf8");
  assert.equal(rocketBytes.length, 4);
  const lastNewlineBeforeEnd = rawBytes.lastIndexOf(0x0a, rawBytes.length - 2);
  const rocketIndex = rawBytes.indexOf(rocketBytes, lastNewlineBeforeEnd + 1);
  assert.ok(rocketIndex > lastNewlineBeforeEnd, "expected 4-byte UTF-8 character on the final ledger line");
  fs.truncateSync(ledgerFile(workspace), rocketIndex + 2);

  const beforeStat = fs.statSync(ledgerFile(workspace));

  const plain = await runLog(workspace);
  assertOk(plain);
  assert.equal(plain.stderr, "");
  const lines = plain.stdout.trimEnd().split("\n");
  assert.equal(lines.length, 1, plain.stdout);
  assert.match(lines[0], new RegExp(`${firstId}.*demo -> beta.*replied`));

  const asJson = await runLog(workspace, ["--json"]);
  assertOk(asJson);
  assert.equal(asJson.stderr, "");
  const parsed = JSON.parse(asJson.stdout);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].request_id, firstId);
  assert.equal(parsed[0].outcome, "replied");

  const afterStat = fs.statSync(ledgerFile(workspace));
  assert.equal(afterStat.size, beforeStat.size);
  assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs);

  // A terminated line with invalid UTF-8 is not a torn final line and must fail with ccdm: error.
  fs.appendFileSync(ledgerFile(workspace), Buffer.from("\n"));
  assertFailed(await runLog(workspace), /corrupt|utf-?8|decode|ledger/i);
});

test("log skips unknown record types with a one-line note and tolerates unknown extra fields on known records", async () => {
  const workspace = createRouterWorkspace(routerRegistry({
    demo: { channel_id: "demo-channel", type: "claude", transport: "router", agent_message_targets: ["beta"] },
    beta: { channel_id: "beta-channel", type: "codex", transport: "router" },
  }));
  const router = await routerWithWebhooks(workspace, ["demo", "beta"]);
  const demo = await connectProject(workspace, "demo");
  const beta = await connectProject(workspace, "beta");

  const req = await demo.request("agent_request", {
    target: "beta",
    text: "KNOWN_EXCHANGE_REQ",
    idempotency_key: "lenient-ex-1",
  });
  assert.equal(req.ok, true, JSON.stringify(req));
  const firstId = req.result.request_id;
  const reqEv = await waitForEvent(beta, e => e.event === "agent_message" && e.request_id === firstId && e.kind === "request", "req delivery");
  await beta.request("agent_message_ack", { delivery_id: reqEv.delivery_id });

  const rep = await beta.request("agent_reply", {
    request_id: firstId,
    text: "KNOWN_EXCHANGE_REP",
    idempotency_key: "lenient-rep-1",
  });
  assert.equal(rep.ok, true, JSON.stringify(rep));
  const repEv = await waitForEvent(demo, e => e.event === "agent_message" && e.request_id === firstId && e.kind === "reply", "rep delivery");
  await demo.request("agent_message_ack", { delivery_id: repEv.delivery_id });

  demo.close();
  beta.close();
  await router.stop();

  // Append one known record carrying an unknown extra field, plus one record of an unknown type.
  const extraFieldRefusal = {
    v: 1,
    at: new Date().toISOString(),
    type: "refusal",
    refusal_id: "ref-0000000000aa",
    op: "agent_request",
    from: { project: "demo", provider: "claude", conversation_id: "demo-channel" },
    to: null,
    target: "unknown-project",
    code: "not_granted",
    message: "demo is not granted to send Agent Requests to unknown-project",
    from_launch: "synthetic-launch",
    idempotency_key: "synthetic-extra-field",
    future_extra_field: { origin: "worker-b", count: 2 },
  };
  const unknownTypeRecord = {
    v: 1,
    at: new Date().toISOString(),
    type: "future_record_type",
    request_id: firstId,
    detail: "added by a newer Router",
  };
  fs.appendFileSync(
    ledgerFile(workspace),
    `${JSON.stringify(extraFieldRefusal)}\n${JSON.stringify(unknownTypeRecord)}\n`,
  );

  const beforeStat = fs.statSync(ledgerFile(workspace));

  const plain = await runLog(workspace);
  assertOk(plain);
  const textLines = plain.stdout.trimEnd().split("\n");
  assert.equal(textLines.length, 2, plain.stdout);
  assert.match(textLines[0], new RegExp(`${firstId}.*demo -> beta.*replied`));
  assert.match(textLines[1], /ref-0000000000aa.*demo -> unknown-project.*refused.*code=not_granted/);
  const stderrLines = plain.stderr.trim().split("\n");
  assert.equal(stderrLines.length, 1, plain.stderr);
  assert.match(stderrLines[0], /skipped 1\b/i);

  const asJson = await runLog(workspace, ["--json"]);
  assertOk(asJson);
  const parsed = JSON.parse(asJson.stdout);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].request_id, firstId);
  assert.equal(parsed[0].outcome, "replied");
  assert.equal(parsed[1].refusal_id, "ref-0000000000aa");
  assert.equal(parsed[1].code, "not_granted");
  const jsonStderrLines = asJson.stderr.trim().split("\n");
  assert.equal(jsonStderrLines.length, 1, asJson.stderr);
  assert.match(jsonStderrLines[0], /skipped 1\b/i);

  const afterStat = fs.statSync(ledgerFile(workspace));
  assert.equal(afterStat.size, beforeStat.size);
  assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs);

  // Adding a second unknown record increments the skipped count to 2.
  fs.appendFileSync(
    ledgerFile(workspace),
    `${JSON.stringify({ v: 1, at: new Date().toISOString(), type: "another_future_type", request_id: firstId })}\n`,
  );
  const secondRun = await runLog(workspace, ["--json"]);
  assertOk(secondRun);
  assert.equal(JSON.parse(secondRun.stdout).length, 2);
  const secondStderrLines = secondRun.stderr.trim().split("\n");
  assert.equal(secondStderrLines.length, 1, secondRun.stderr);
  assert.match(secondStderrLines[0], /skipped 2\b/i);
});

test("JS ledger and Python log reader know the exact same ledger record types", () => {
  const ledgerSource = fs.readFileSync("scripts/router/agent-messages/ledger.js", "utf8");
  const switchMatch = ledgerSource.match(/switch\s*\(\s*record\.type\s*\)\s*\{([\s\S]*?)\n\s*\}/);
  assert.ok(switchMatch, "could not find switch (record.type) in scripts/router/agent-messages/ledger.js");
  const jsTypes = [...switchMatch[1].matchAll(/case\s+"([^"]+)"\s*:/g)].map(match => match[1]).sort();
  assert.ok(jsTypes.length > 0, "no record types extracted from scripts/router/agent-messages/ledger.js");

  const [pythonBin, ...pythonArgs] = pythonCommand();
  const pyRun = spawnSync(
    pythonBin,
    [
      ...pythonArgs,
      "-c",
      "import json, sys; sys.path.insert(0, 'scripts'); from ccdmlib.cli import agent_messages; print(json.dumps(sorted(agent_messages._KNOWN_RECORD_TYPES)))",
    ],
    { encoding: "utf8" },
  );
  assert.equal(pyRun.status, 0, `${pyRun.stderr}\n${pyRun.stdout}`);
  const pyTypes = JSON.parse(pyRun.stdout);
  assert.ok(Array.isArray(pyTypes) && pyTypes.length > 0, "no record types found in scripts/ccdmlib/cli/agent_messages.py");

  assert.deepEqual(pyTypes, jsTypes);
});
