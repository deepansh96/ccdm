import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import test from "node:test";

import {
  ROOT_TOKEN,
  createRouterWorkspace,
  routerRegistry,
  routerSocketPath,
  routerWithWebhooks,
  runRouterCli,
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

test("an expiry whose ledger write fails once retries automatically, marks both posts ⚠️, notifies the sender, and frees open_requests", async () => {
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

  // Open one request occupying the single open_requests slot (2 short minutes = 500ms).
  const sent = await demo.request("agent_request", {
    target: "beta",
    text: "Expire after transient ledger failure",
    timeout_minutes: 2,
    idempotency_key: "exp-retry-1",
  });
  assert.equal(sent.ok, true, JSON.stringify(sent));
  const reqId = sent.result.request_id;

  const reqEvent = await waitFor(
    () => beta.events.find((event) => event.event === "agent_message" && event.kind === "request" && event.request_id === reqId),
    () => `beta request event: ${JSON.stringify(beta.events)}`,
  );
  assert.equal((await beta.request("agent_message_ack", { delivery_id: reqEvent.delivery_id })).ok, true);

  await waitFor(
    () => (readState(workspace.stateDir).fixtures.discord.messages ?? []).length === 2,
    () => `two request records: ${JSON.stringify(readState(workspace.stateDir).fixtures.discord.messages)}`,
  );

  // Confirm the single open_requests slot is occupied while the request is open.
  const blockedByLimit = await demo.request("agent_request", {
    target: "beta",
    text: "Should hit open_requests limit",
    idempotency_key: "exp-retry-limit-check",
  });
  assert.equal(blockedByLimit.ok, false);
  assert.equal(blockedByLimit.error.code, "open_requests_exceeded");

  // Temporarily make the ledger unwritable by swapping the file for a directory before expiry fires.
  const ledgerFile = path.join(workspace.routerStateDir, "agent-messages.jsonl");
  const savedLedger = `${ledgerFile}.saved`;
  let restored = false;
  const restoreLedger = () => {
    if (restored) return;
    restored = true;
    try { fs.rmdirSync(ledgerFile); } catch {}
    if (fs.existsSync(savedLedger)) fs.renameSync(savedLedger, ledgerFile);
  };
  registerTeardownCallback(restoreLedger);

  fs.renameSync(ledgerFile, savedLedger);
  fs.mkdirSync(ledgerFile);

  // Wait for the expiry timer to fire and fail its first ledger append.
  await waitFor(
    () => router.stdout.includes("agent_message_ledger_failed type=expired"),
    () => `expected expiry ledger failure in router stdout:\n${router.stdout}\n${router.stderr}`,
    5000,
  );

  // While the write failed, the exchange is still open in router status and no ⚠️ was added.
  const statusWhileBlocked = JSON.parse((await runRouterCli(workspace, ["status", "--json"])).stdout);
  assert.equal(
    statusWhileBlocked.agent_messages.open_requests.some((entry) => entry.request_id === reqId),
    true,
    JSON.stringify(statusWhileBlocked.agent_messages),
  );
  assert.deepEqual(readState(workspace.stateDir).fixtures.discord.reactions ?? [], []);

  // Restore ledger writability: without restarting or replying, the retry expires the request.
  restoreLedger();

  const notice = await waitFor(
    () => demo.events.find((event) => event.event === "agent_message" && event.kind === "notice" && event.request_id === reqId),
    () => `demo expiry notice after retry: ${JSON.stringify(demo.events)}\nrouter stdout:\n${router.stdout}`,
    5000,
  );
  assert.equal(notice.outcome, "expired");
  assert.deepEqual(notice.target, { project: "beta", provider: "codex", conversation_id: "beta-channel" });

  const warnEmoji = encodeURIComponent("⚠️");
  await waitFor(
    () => (readState(workspace.stateDir).fixtures.discord.reactions ?? []).filter((r) => r.emoji === warnEmoji).length === 2,
    () => `two ⚠️ reactions after retry: ${JSON.stringify(readState(workspace.stateDir).fixtures.discord.reactions)}`,
  );
  const discord = readState(workspace.stateDir).fixtures.discord;
  const senderPost = discord.messages.find((m) => m.channelId === "demo-channel" && m.webhookId);
  const receiverPost = discord.messages.find((m) => m.id === reqEvent.post.message_id);
  assert.deepEqual(discord.reactions, [
    { authorization: `Bot ${ROOT_TOKEN}`, channelId: "demo-channel", emoji: warnEmoji, messageId: senderPost.id },
    { authorization: `Bot ${ROOT_TOKEN}`, channelId: "beta-channel", emoji: warnEmoji, messageId: receiverPost.id },
  ]);

  // router status no longer lists the expired request as open.
  const statusAfterRetry = JSON.parse((await runRouterCli(workspace, ["status", "--json"])).stdout);
  assert.deepEqual(statusAfterRetry.agent_messages.open_requests, []);

  // The freed open_requests slot accepts a new request.
  const followUp = await demo.request("agent_request", {
    target: "beta",
    text: "New request in freed slot",
    timeout_minutes: 30,
    idempotency_key: "exp-retry-followup",
  });
  assert.equal(followUp.ok, true, JSON.stringify(followUp));
  assert.notEqual(followUp.result.request_id, reqId);

  // Late reply to the retried-expired request is refused with request_expired.
  const lateReply = await beta.request("agent_reply", {
    request_id: reqId,
    text: "Too late after retry",
    idempotency_key: "exp-retry-late-reply",
  });
  assert.equal(lateReply.ok, false);
  assert.equal(lateReply.error.code, "request_expired");
});
