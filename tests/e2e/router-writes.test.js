import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { injectDiscordMessage } from "./support/bridge.js";
import {
  OWNER_ID,
  ROOT_TOKEN,
  connectSession,
  createRouterWorkspace,
  routerWithWebhooks,
  waitFor,
} from "./support/router.js";
import { readState } from "./support/state.js";
import { cleanup } from "./support/teardown.js";

test.afterEach(async () => {
  await cleanup();
});

function webhookMessages(workspace) {
  return (readState(workspace.stateDir).fixtures.discord.messages ?? []).filter(message => message.webhookId);
}

test("a reply with two files is one webhook message carrying both uploads", async () => {
  const workspace = createRouterWorkspace();
  await routerWithWebhooks(workspace, ["demo"]);
  const demo = await connectSession(workspace, "demo", "demo-key");
  const log = path.join(workspace.tmpRoot, "build.log");
  const image = path.join(workspace.tmpRoot, "screen.png");
  fs.writeFileSync(log, "all green\n");
  fs.writeFileSync(image, "png-bytes");

  const result = await demo.client.request("reply", {
    channel_id: "demo-channel", text: "see attached", files: [log, image], context_pct: 42,
  });

  assert.deepEqual(webhookMessages(workspace).map(({ id, channelId, content, username, webhookId, uploads }) =>
    ({ id, channelId, content, username, webhookId, uploads })), [{
    id: "fake-message-1",
    channelId: "demo-channel",
    content: "see attached",
    username: "demo-claude · 42%",
    webhookId: "fake-webhook-1",
    uploads: [{ name: "build.log", size: 10 }, { name: "screen.png", size: 9 }],
  }]);
  assert.deepEqual(result, { message_id: "fake-message-1", message_ids: ["fake-message-1"] });
});

test("a reply to a message starts with a jump link, since webhooks cannot send native replies", async () => {
  const workspace = createRouterWorkspace();
  await routerWithWebhooks(workspace, ["demo"]);
  const demo = await connectSession(workspace, "demo", "demo-key");
  injectDiscordMessage(workspace, { id: "owner-message-7", channelId: "demo-channel", content: "status?",
    author: { id: OWNER_ID, username: "Owner" } });
  await waitFor(() => demo.events.length > 0, () => "the owner message event");

  await demo.client.request("reply", { channel_id: "demo-channel", text: "all green", reply_to: "owner-message-7" });

  assert.deepEqual(webhookMessages(workspace).map(message => message.content), [
    "↪ [jump](https://discord.com/channels/guild-id/demo-channel/owner-message-7)\nall green",
  ]);
});

test("text longer than one Discord message is split into ordered webhook messages within the limit", async () => {
  const workspace = createRouterWorkspace();
  await routerWithWebhooks(workspace, ["demo"]);
  const demo = await connectSession(workspace, "demo", "demo-key");

  // A newline past 30% of the limit ends a chunk; without one, chunks split at exactly 2000 characters.
  const result = await demo.client.request("reply", {
    channel_id: "demo-channel", text: `${"a".repeat(1500)}\n${"c".repeat(4500)}`, context_pct: 42,
  });

  const messages = webhookMessages(workspace);
  assert.deepEqual(messages.map(message => message.content), [
    "a".repeat(1500),
    `\n${"c".repeat(1999)}`,
    "c".repeat(2000),
    "c".repeat(501),
  ]);
  assert.ok(messages.every(message => message.content.length <= 2000));
  assert.deepEqual(messages.map(message => message.username), Array(4).fill("demo-claude · 42%"));
  assert.deepEqual(result, {
    message_id: "fake-message-1",
    message_ids: ["fake-message-1", "fake-message-2", "fake-message-3", "fake-message-4"],
  });
});

test("edit_message updates the project's own webhook message; Discord keeps its username", async () => {
  const workspace = createRouterWorkspace();
  await routerWithWebhooks(workspace, ["demo"]);
  const demo = await connectSession(workspace, "demo", "demo-key");
  const { message_id } = await demo.client.request("reply", { channel_id: "demo-channel", text: "working…", context_pct: 42 });

  const result = await demo.client.request("edit_message", {
    channel_id: "demo-channel", message_id, text: "done", context_pct: 57,
  });

  assert.deepEqual(result, { message_id: "fake-message-1" });
  assert.deepEqual(webhookMessages(workspace).map(({ id, content, username }) => ({ id, content, username })), [
    { id: "fake-message-1", content: "done", username: "demo-claude · 42%" },
  ]);
});

test("edit_message on a bot, other-webhook, or other-channel message is a logged scope violation", async () => {
  const workspace = createRouterWorkspace();
  const router = await routerWithWebhooks(workspace, ["demo", "beta"]);
  const demo = await connectSession(workspace, "demo", "demo-key");
  const beta = await connectSession(workspace, "beta", "beta-key");
  const { message_id: betaMessage } = await beta.client.request("reply", { channel_id: "beta-channel", text: "beta's own" });
  injectDiscordMessage(workspace, { id: "bot-message", channelId: "demo-channel", content: "from the bot",
    author: { id: "root-bot-id", username: "Root", bot: true } });
  injectDiscordMessage(workspace, { id: "other-webhook-message", channelId: "demo-channel", content: "from elsewhere",
    author: { id: "other-webhook", username: "someone", bot: true }, webhookId: "other-webhook" });

  for (const target of ["bot-message", "other-webhook-message", betaMessage]) {
    await assert.rejects(demo.client.request("edit_message", { channel_id: "demo-channel", message_id: target, text: "hijacked" }),
      { code: "scope_violation" }, target);
    await router.waitForOutput(new RegExp(`scope_violation project=demo op=edit_message target=${target}`));
  }

  const state = readState(workspace.stateDir);
  assert.deepEqual(state.fixtures.discord.webhookEdits ?? [], []);
  assert.deepEqual(state.fixtures.discord.edits ?? [], []);
  assert.equal(webhookMessages(workspace).find(message => message.id === "fake-message-1").content, "beta's own");
});

test("react adds and removes a reaction as the bot on a message in the session's channel", async () => {
  const workspace = createRouterWorkspace();
  await routerWithWebhooks(workspace, ["demo"]);
  const demo = await connectSession(workspace, "demo", "demo-key");
  injectDiscordMessage(workspace, { id: "owner-message-9", channelId: "demo-channel", content: "look at this",
    author: { id: OWNER_ID, username: "Owner" } });
  await waitFor(() => demo.events.length > 0, () => "the owner message event");

  await demo.client.request("react", { channel_id: "demo-channel", message_id: "owner-message-9", emoji: "👀" });
  await demo.client.request("react", { channel_id: "demo-channel", message_id: "owner-message-9", emoji: "👀", remove: true });

  const { reactions, reactionDeletes } = readState(workspace.stateDir).fixtures.discord;
  const asBot = { authorization: `Bot ${ROOT_TOKEN}`, channelId: "demo-channel", emoji: "%F0%9F%91%80", messageId: "owner-message-9" };
  assert.deepEqual(reactions, [asBot]);
  assert.deepEqual(reactionDeletes, [asBot]);
});

test("typing shows the bot typing in the session's channel", async () => {
  const workspace = createRouterWorkspace();
  await routerWithWebhooks(workspace, ["demo"]);
  const demo = await connectSession(workspace, "demo", "demo-key");

  await demo.client.request("typing", { channel_id: "demo-channel" });

  assert.deepEqual(readState(workspace.stateDir).fixtures.discord.typing,
    [{ authorization: `Bot ${ROOT_TOKEN}`, channelId: "demo-channel" }]);
});

test("react, typing, and reply_to aimed at another channel or its message are rejected and logged", async () => {
  const workspace = createRouterWorkspace();
  const router = await routerWithWebhooks(workspace, ["demo", "beta"]);
  const demo = await connectSession(workspace, "demo", "demo-key");
  const beta = await connectSession(workspace, "beta", "beta-key");
  const { message_id: betaMessage } = await beta.client.request("reply", { channel_id: "beta-channel", text: "beta's own" });

  const attempts = [
    ["typing", { channel_id: "beta-channel" }, "beta-channel"],
    ["react", { channel_id: "beta-channel", message_id: betaMessage, emoji: "👀" }, "beta-channel"],
    ["react", { channel_id: "demo-channel", message_id: betaMessage, emoji: "👀" }, "fake-message-1"],
    ["reply", { channel_id: "demo-channel", text: "sneaky", reply_to: betaMessage }, "fake-message-1"],
  ];
  for (const [op, args, target] of attempts) {
    await assert.rejects(demo.client.request(op, args), { code: "scope_violation" }, `${op} ${JSON.stringify(args)}`);
    await router.waitForOutput(new RegExp(`scope_violation project=demo op=${op} target=${target}`));
  }

  const { reactions, typing } = readState(workspace.stateDir).fixtures.discord;
  assert.deepEqual([reactions ?? [], typing ?? []], [[], []]);
  assert.deepEqual(webhookMessages(workspace).map(message => message.channelId), ["beta-channel"]);
});
