// Consolidation interaction tests across PR #409 fix branches:
// - D + B: Router crash recovery of >2000-char records posts the multi-chunk
//   continuation-header form without reposting already-posted chunks and links
//   chunk 1 cleanly.
// - C + B: Router startup recovery never resurrects an unacknowledged delivery
//   of a closed exchange that compaction's retention window drops.
import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";

import { injectDiscordMessage } from "./support/bridge.js";
import {
  OWNER_ID,
  createRouterWorkspace,
  killRouter,
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

function holdDiscordPath(workspace, { method = "POST", apiPath, retryAfter = 10 }) {
  updateState(workspace.stateDir, (state) => {
    state.fixtures.discord.rateLimits = [{ method, path: apiPath, count: 1, retryAfter }];
    state.fixtures.discord.rateLimitHits = [];
  });
}

function clearDiscordHolds(workspace) {
  updateState(workspace.stateDir, (state) => {
    state.fixtures.discord.rateLimits = [];
    state.fixtures.discord.rateLimitHits = [];
  });
}

async function waitForHoldHit(workspace, apiPath) {
  await waitFor(
    () => (readState(workspace.stateDir).fixtures.discord.rateLimitHits ?? []).some((hit) => hit.path === apiPath),
    () => `rateLimitHit for ${apiPath}`,
  );
}

async function waitForDisconnect(workspace, project) {
  await waitFor(
    async () => {
      const status = JSON.parse((await runRouterCli(workspace, ["status", "--json"])).stdout);
      return !status.sessions.some((s) => s.project === project && s.role === "project");
    },
    () => `${project} disconnect`,
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

function stripHeaderLine(content) {
  const newline = content.indexOf("\n");
  assert.ok(newline > 0, `expected header newline in ${JSON.stringify(content.slice(0, 80))}`);
  return content.slice(newline + 1);
}

test("D+B: crash recovery of a 4000-character Agent Request posts multi-chunk continuation headers without reposting completed sender chunks", async () => {
  const workspace = createRouterWorkspace(routerRegistry({
    demo: { channel_id: "demo-channel", type: "claude", transport: "router", agent_message_targets: ["beta"] },
    beta: { channel_id: "beta-channel", type: "codex", transport: "router" },
  }));
  let router = await routerWithWebhooks(workspace, ["demo", "beta"]);

  const demo1 = await connectAgentProject(workspace, "demo", "demo-key");
  const beta1 = await connectAgentProject(workspace, "beta", "beta-key");

  // Hold receiver bot post so sender's multi-chunk webhook record finishes before the crash.
  const receiverPostPath = "/api/v10/channels/beta-channel/messages";
  holdDiscordPath(workspace, { method: "POST", apiPath: receiverPostPath });

  const longText = Array.from({ length: 80 }, (_, i) => `LINE-${String(i).padStart(2, "0")}-${"x".repeat(42)}`).join("\n").slice(0, 4000);
  assert.equal(longText.length, 4000);

  const sent = await demo1.request("agent_request", {
    target: "beta",
    text: longText,
    idempotency_key: "consolidation-db-long-1",
  });
  assert.equal(sent.ok, true, JSON.stringify(sent));
  const reqId = sent.result.request_id;

  await waitForHoldHit(workspace, receiverPostPath);
  const preCrashSender = (readState(workspace.stateDir).fixtures.discord.messages ?? [])
    .filter((m) => m.channelId === "demo-channel");
  assert.ok(preCrashSender.length >= 2, `expected multi-chunk sender record before crash, got ${preCrashSender.length}`);
  assert.equal(
    (readState(workspace.stateDir).fixtures.discord.messages ?? []).filter((m) => m.channelId === "beta-channel").length,
    0,
  );

  await demo1.close();
  await beta1.close();
  killRouter(router);
  await router.closed;
  clearDiscordHolds(workspace);
  router = await startRouter(workspace);

  const beta2 = await connectAgentProject(workspace, "beta", "beta-key");
  const reqEvent = await waitFor(
    () => beta2.events.find((e) => e.event === "agent_message" && e.kind === "request" && e.request_id === reqId),
    () => `beta2 recovered long request: ${JSON.stringify(beta2.events)}`,
  );
  assert.equal(reqEvent.text, longText);
  assert.equal((await beta2.request("agent_message_ack", { delivery_id: reqEvent.delivery_id })).ok, true);

  await waitFor(
    () => {
      const msgs = readState(workspace.stateDir).fixtures.discord.messages ?? [];
      const sender = msgs.filter((m) => m.channelId === "demo-channel");
      const receiver = msgs.filter((m) => m.channelId === "beta-channel");
      return receiver.length >= 2 && sender[0]?.content.includes("[counterpart]");
    },
    () => "recovered multi-chunk receiver record and linked sender chunk 1",
  );

  const allMsgs = readState(workspace.stateDir).fixtures.discord.messages ?? [];
  const senderMsgs = allMsgs.filter((m) => m.channelId === "demo-channel");
  const receiverMsgs = allMsgs.filter((m) => m.channelId === "beta-channel");

  // Sender chunks were NOT reposted.
  assert.equal(senderMsgs.length, preCrashSender.length);

  // Every sender and receiver chunk starts with `-# ⇄ Agent `, stays <= 2000 chars,
  // carries `part k/n` on continuation chunks, and reconstructs the exact 4000-char text.
  for (const [side, chunks] of [["sender", senderMsgs], ["receiver", receiverMsgs]]) {
    assert.ok(chunks.length >= 2, `${side} expected >=2 chunks`);
    for (let i = 0; i < chunks.length; i += 1) {
      const content = chunks[i].content;
      assert.ok(content.startsWith("-# ⇄ Agent "), `${side} chunk ${i + 1} missing prefix`);
      assert.ok(content.length <= 2000, `${side} chunk ${i + 1} length ${content.length} > 2000`);
      if (i > 0) {
        assert.equal(
          content.split("\n", 1)[0],
          `-# ⇄ Agent Request · ${reqId} · part ${i + 1}/${chunks.length}`,
        );
      }
    }
    assert.equal(chunks.map((c) => stripHeaderLine(c.content)).join(""), longText);
  }
  assert.match(senderMsgs[0].content, new RegExp(`\\[counterpart\\]\\(https://discord\\.com/channels/guild-id/beta-channel/${receiverMsgs[0].id}\\)`));
});

test("C+B: startup recovery never resurrects an unpublished closed-exchange reply past retention", async () => {
  const workspace = createRouterWorkspace(routerRegistry({
    demo: { channel_id: "demo-channel", type: "claude", transport: "router", agent_message_targets: ["beta"] },
    beta: { channel_id: "beta-channel", type: "codex", transport: "router" },
  }));
  let router = await routerWithWebhooks(workspace, ["demo", "beta"]);

  const demo1 = await connectAgentProject(workspace, "demo", "demo-key");
  const beta1 = await connectAgentProject(workspace, "beta", "beta-key");

  const sent = await demo1.request("agent_request", {
    target: "beta",
    text: "Check before retention",
    idempotency_key: "consolidation-cb-req-1",
  });
  assert.equal(sent.ok, true, JSON.stringify(sent));
  const reqId = sent.result.request_id;
  const reqEv = await waitFor(
    () => beta1.events.find((e) => e.event === "agent_message" && e.kind === "request" && e.request_id === reqId),
    () => `beta1 request`,
  );
  assert.equal((await beta1.request("agent_message_ack", { delivery_id: reqEv.delivery_id })).ok, true);

  await demo1.close();
  await waitForDisconnect(workspace, "demo");

  // Hold beta's reply webhook so the Router crashes after accepting `reply` but before writing `delivery`.
  const betaWebhookPath = webhookExecutePath(workspace, "beta-channel");
  holdDiscordPath(workspace, { method: "POST", apiPath: betaWebhookPath });

  const replied = await beta1.request("agent_reply", {
    request_id: reqId,
    text: "Reply accepted before crash and aged past retention",
    idempotency_key: "consolidation-cb-rep-1",
  });
  assert.equal(replied.ok, true, JSON.stringify(replied));
  await waitForHoldHit(workspace, betaWebhookPath);

  await beta1.close();
  killRouter(router);
  await router.closed;
  clearDiscordHolds(workspace);

  // Wait past shortened retention window (43200 * 0.08ms = 3456ms), then restart.
  await new Promise((resolve) => setTimeout(resolve, 3800));
  router = await startRouter(workspace, {
    env: { CCDM_ROUTER_AGENT_MESSAGE_MINUTE_MS: "0.08" },
  });

  // Reconnect demo with the same launch key: must receive nothing and no reply records should be resurrected.
  const demo2 = await connectAgentProject(workspace, "demo", "demo-key");
  await fenceOwnerMessage(workspace, demo2, "demo-channel", "fence-cb-not-resurrected");
  assert.deepEqual(demo2.events.filter((e) => e.event === "agent_message"), []);
  assert.equal((readState(workspace.stateDir).fixtures.discord.messages ?? []).length, 2);
});
