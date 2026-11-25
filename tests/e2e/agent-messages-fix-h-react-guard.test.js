// Regression tests for PR #409 worker H (finding H2):
// `react` (adding or removing) with outcome marks (✅, ⚠️, ⚠) on any chunk of
// a sender-side or receiver-side Agent Message record is refused with
// `invalid_args`, while other emoji on records and ✅/⚠️ on ordinary messages
// still work.
import assert from "node:assert/strict";
import test from "node:test";

import {
  ROOT_TOKEN,
  connectRoot,
  createRouterWorkspace,
  rawRouterSocket,
  routerRegistry,
  routerWithWebhooks,
  waitFor,
  writeRootKey,
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
  assert.equal(answer.type, "hello_ok", JSON.stringify(answer));
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

function connectAgentProject(workspace, project, key = `${project}-key`) {
  return rawClient(workspace, {
    role: "project",
    project,
    key,
    capabilities: ["agent_messages"],
  });
}

test("react refuses adding or removing ✅/⚠️ (and ⚠ without VS16) on any Agent Message record chunk, while allowing 👍 on records and ✅/⚠️ on ordinary messages", async () => {
  const workspace = createRouterWorkspace({
    ...routerRegistry({
      demo: { channel_id: "demo-channel", type: "claude", transport: "router", agent_message_targets: ["beta"] },
      beta: { channel_id: "beta-channel", type: "codex", transport: "router" },
    }),
    root_channels: ["root-channel"],
  });
  writeRootKey(workspace, "root-key");
  await routerWithWebhooks(workspace, ["demo", "beta"]);

  const demo = await connectAgentProject(workspace, "demo");
  const beta = await connectAgentProject(workspace, "beta");
  const root = await connectRoot(workspace, "root-key");

  // Send a multi-chunk Agent Request so both sender-side (webhook) and receiver-side (root bot)
  // records have a first chunk and a continuation chunk.
  const longRequestText = `${"A".repeat(1400)}\n${"B".repeat(1200)}`;
  const sent = await demo.request("agent_request", {
    target: "beta",
    text: longRequestText,
    idempotency_key: "h2-multi-chunk-req",
  });
  assert.equal(sent.ok, true, JSON.stringify(sent));
  const reqId = sent.result.request_id;

  const reqEv = await waitFor(
    () => beta.events.find((e) => e.event === "agent_message" && e.kind === "request" && e.request_id === reqId),
    () => `beta request event: ${JSON.stringify(beta.events)}`,
  );
  await beta.request("agent_message_ack", { delivery_id: reqEv.delivery_id });

  const afterRequest = readState(workspace.stateDir).fixtures.discord;
  const senderReqChunks = afterRequest.messages.filter((m) => m.channelId === "demo-channel" && m.webhookId);
  const receiverReqChunks = afterRequest.messages.filter((m) => m.channelId === "beta-channel" && !m.webhookId);
  assert.equal(senderReqChunks.length, 2, `expected 2 sender request chunks, got ${senderReqChunks.length}`);
  assert.equal(receiverReqChunks.length, 2, `expected 2 receiver request chunks, got ${receiverReqChunks.length}`);

  // Protected outcome marks: ✅, ⚠️ (with VS16), and ⚠ (without VS16).
  const protectedMarks = ["✅", "⚠️", "\u26a0", "\u2705\ufe0f"];

  // Adding any protected mark to chunk 1 or chunk 2 of either sender-side or receiver-side record is invalid_args.
  for (const emoji of protectedMarks) {
    for (const [idx, chunk] of senderReqChunks.entries()) {
      const res = await demo.request("react", { channel_id: "demo-channel", message_id: chunk.id, emoji });
      assert.equal(res.ok, false, `demo add ${JSON.stringify(emoji)} on sender chunk ${idx + 1}`);
      assert.equal(res.error.code, "invalid_args", JSON.stringify(res));
    }
    for (const [idx, chunk] of receiverReqChunks.entries()) {
      const res = await beta.request("react", { channel_id: "beta-channel", message_id: chunk.id, emoji });
      assert.equal(res.ok, false, `beta add ${JSON.stringify(emoji)} on receiver chunk ${idx + 1}`);
      assert.equal(res.error.code, "invalid_args", JSON.stringify(res));
    }
  }
  assert.deepEqual(readState(workspace.stateDir).fixtures.discord.reactions ?? [], []);
  assert.deepEqual(readState(workspace.stateDir).fixtures.discord.reactionDeletes ?? [], []);

  // Reply to the request so the Router adds root's ✅ mark to both request first chunks.
  const replied = await beta.request("agent_reply", {
    request_id: reqId,
    text: `${"C".repeat(1400)}\n${"D".repeat(1200)}`,
    idempotency_key: "h2-multi-chunk-rep",
  });
  assert.equal(replied.ok, true, JSON.stringify(replied));
  const repEv = await waitFor(
    () => demo.events.find((e) => e.event === "agent_message" && e.kind === "reply" && e.request_id === reqId),
    () => `demo reply event: ${JSON.stringify(demo.events)}`,
  );
  await demo.request("agent_message_ack", { delivery_id: repEv.delivery_id });

  await waitFor(
    () => (readState(workspace.stateDir).fixtures.discord.reactions ?? []).length === 2,
    () => `router ✅ marks on both request posts: ${JSON.stringify(readState(workspace.stateDir).fixtures.discord.reactions)}`,
  );

  // Attempting to remove root's ✅ from either request record is refused with invalid_args and leaves ✅ intact.
  const demoRemove = await demo.request("react", {
    channel_id: "demo-channel",
    message_id: senderReqChunks[0].id,
    emoji: "✅",
    remove: true,
  });
  assert.equal(demoRemove.ok, false, JSON.stringify(demoRemove));
  assert.equal(demoRemove.error.code, "invalid_args");

  const betaRemove = await beta.request("react", {
    channel_id: "beta-channel",
    message_id: receiverReqChunks[0].id,
    emoji: "✅",
    remove: true,
  });
  assert.equal(betaRemove.ok, false, JSON.stringify(betaRemove));
  assert.equal(betaRemove.error.code, "invalid_args");

  await assert.rejects(
    root.client.request("react", {
      channel_id: "beta-channel",
      message_id: receiverReqChunks[0].id,
      emoji: "✅",
      remove: true,
    }),
    { code: "invalid_args" },
  );

  const afterRemoveAttempts = readState(workspace.stateDir).fixtures.discord;
  assert.deepEqual(afterRemoveAttempts.reactionDeletes ?? [], []);
  assert.deepEqual(afterRemoveAttempts.reactions, [
    { authorization: `Bot ${ROOT_TOKEN}`, channelId: "demo-channel", emoji: encodeURIComponent("✅"), messageId: senderReqChunks[0].id },
    { authorization: `Bot ${ROOT_TOKEN}`, channelId: "beta-channel", emoji: encodeURIComponent("✅"), messageId: receiverReqChunks[0].id },
  ]);

  // Reply record chunks (first and later) also refuse ✅ and ⚠️.
  const replierReplyChunks = afterRemoveAttempts.messages.filter((m) => m.channelId === "beta-channel" && m.webhookId);
  const receiverReplyChunks = afterRemoveAttempts.messages.filter((m) => m.channelId === "demo-channel" && !m.webhookId);
  assert.equal(replierReplyChunks.length, 2);
  assert.equal(receiverReplyChunks.length, 2);
  for (const chunk of replierReplyChunks) {
    const res = await beta.request("react", { channel_id: "beta-channel", message_id: chunk.id, emoji: "⚠️" });
    assert.equal(res.ok, false);
    assert.equal(res.error.code, "invalid_args");
  }
  for (const chunk of receiverReplyChunks) {
    const res = await demo.request("react", { channel_id: "demo-channel", message_id: chunk.id, emoji: "\u26a0" });
    assert.equal(res.ok, false);
    assert.equal(res.error.code, "invalid_args");
  }

  // Non-outcome emoji (👍) on a record works (both add and remove).
  const thumbsUpSender = await demo.request("react", {
    channel_id: "demo-channel",
    message_id: senderReqChunks[0].id,
    emoji: "👍",
  });
  assert.equal(thumbsUpSender.ok, true, JSON.stringify(thumbsUpSender));
  const thumbsUpReceiver = await beta.request("react", {
    channel_id: "beta-channel",
    message_id: receiverReqChunks[1].id,
    emoji: "👍",
  });
  assert.equal(thumbsUpReceiver.ok, true, JSON.stringify(thumbsUpReceiver));
  const thumbsDownRemove = await demo.request("react", {
    channel_id: "demo-channel",
    message_id: senderReqChunks[0].id,
    emoji: "👍",
    remove: true,
  });
  assert.equal(thumbsDownRemove.ok, true, JSON.stringify(thumbsDownRemove));

  // Ordinary messages still accept ✅ and ⚠️ (both add and remove).
  const ordinary = await demo.request("reply", { channel_id: "demo-channel", text: "ordinary status message" });
  assert.equal(ordinary.ok, true, JSON.stringify(ordinary));
  const ordinaryMsgId = ordinary.result.message_id;

  const ordinaryCheck = await demo.request("react", { channel_id: "demo-channel", message_id: ordinaryMsgId, emoji: "✅" });
  assert.equal(ordinaryCheck.ok, true, JSON.stringify(ordinaryCheck));
  const ordinaryWarn = await demo.request("react", { channel_id: "demo-channel", message_id: ordinaryMsgId, emoji: "⚠️" });
  assert.equal(ordinaryWarn.ok, true, JSON.stringify(ordinaryWarn));
  const ordinaryCheckRemove = await demo.request("react", {
    channel_id: "demo-channel",
    message_id: ordinaryMsgId,
    emoji: "✅",
    remove: true,
  });
  assert.equal(ordinaryCheckRemove.ok, true, JSON.stringify(ordinaryCheckRemove));

  const finalDiscord = readState(workspace.stateDir).fixtures.discord;
  assert.deepEqual(
    finalDiscord.reactions.slice(2).map((r) => [r.channelId, r.messageId, decodeURIComponent(r.emoji)]),
    [
      ["demo-channel", senderReqChunks[0].id, "👍"],
      ["beta-channel", receiverReqChunks[1].id, "👍"],
      ["demo-channel", ordinaryMsgId, "✅"],
      ["demo-channel", ordinaryMsgId, "⚠️"],
    ],
  );
  assert.deepEqual(
    finalDiscord.reactionDeletes.map((r) => [r.channelId, r.messageId, decodeURIComponent(r.emoji)]),
    [
      ["demo-channel", senderReqChunks[0].id, "👍"],
      ["demo-channel", ordinaryMsgId, "✅"],
    ],
  );
});
