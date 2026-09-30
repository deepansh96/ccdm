import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { injectDiscordMessage, injectDiscordReaction } from "./support/bridge.js";
import {
  OWNER_ID,
  ROOT_TOKEN,
  connectRoot,
  connectSession,
  createRouterWorkspace,
  routerRegistry,
  routerWithWebhooks,
  runRouterCli,
  waitFor,
  writeRootKey,
} from "./support/router.js";
import { readState, writeState } from "./support/state.js";
import { cleanup } from "./support/teardown.js";

test.afterEach(async () => {
  await cleanup();
});

// The fake gateway's bot user, as `client.user` reports it to the Router.
const BOT_ID = "fixture-bot-user-id";

function rootRegistry() {
  return {
    ...routerRegistry(),
    root_channels: ["root-channel"],
    root_allowed_user_ids: ["helper-id"],
  };
}

async function rootAndDemo() {
  const workspace = createRouterWorkspace(rootRegistry());
  writeRootKey(workspace, "root-key");
  await routerWithWebhooks(workspace, ["demo"]);
  const root = await connectRoot(workspace, "root-key");
  const demo = await connectSession(workspace, "demo", "demo-key");
  return { workspace, root, demo };
}

// A trailing owner message to `demo` proves earlier ones were already routed.
async function settle(workspace, demo) {
  injectDiscordMessage(workspace, { id: "fence", channelId: "demo-channel", content: "fence",
    author: { id: OWNER_ID, username: "Owner" } });
  await waitFor(() => demo.events.some(event => event.message_id === "fence"), () => "the fence message");
}

const ids = events => events.filter(event => event.message_id !== "fence").map(event => event.message_id);

test("the owner's bot mention in a project channel arrives only at root", async () => {
  const { workspace, root, demo } = await rootAndDemo();

  injectDiscordMessage(workspace, { id: "mention", channelId: "demo-channel", content: `<@${BOT_ID}> restart demo please`,
    author: { id: OWNER_ID, username: "Owner" } });
  await waitFor(() => root.events.length > 0, () => "the mention at root");
  await settle(workspace, demo);

  assert.deepEqual(root.events.map(({ event, message_id, channel_id, content, author }) =>
    ({ event, message_id, channel_id, content, author })), [{
    event: "message", message_id: "mention", channel_id: "demo-channel", content: `<@${BOT_ID}> restart demo please`,
    author: { id: OWNER_ID, name: "Owner", is_owner: true },
  }]);
  assert.deepEqual(ids(demo.events), []);
});

test("a native reply to a root-bot message in a project channel arrives only at root", async () => {
  const { workspace, root, demo } = await rootAndDemo();
  injectDiscordMessage(workspace, { id: "root-said", channelId: "demo-channel", content: "demo restarted",
    author: { id: BOT_ID, username: "Root", bot: true } });

  injectDiscordMessage(workspace, { id: "reply-to-root", channelId: "demo-channel", content: "thanks, now check logs",
    replyTo: "root-said", author: { id: OWNER_ID, username: "Owner" } });
  await waitFor(() => root.events.length > 0, () => "the reply at root");
  await settle(workspace, demo);

  assert.deepEqual(root.events.map(({ message_id, reply_to }) => ({ message_id, reply_to })),
    [{ message_id: "reply-to-root", reply_to: "root-said" }]);
  assert.deepEqual(ids(demo.events), []);
});

test("a native reply to a project's webhook message arrives only at that project", async () => {
  const { workspace, root, demo } = await rootAndDemo();
  const { message_id } = await demo.client.request("reply", { channel_id: "demo-channel", text: "tests pass" });

  injectDiscordMessage(workspace, { id: "reply-to-demo", channelId: "demo-channel", content: "ship it",
    replyTo: message_id, author: { id: OWNER_ID, username: "Owner" } });
  await settle(workspace, demo);

  assert.deepEqual(ids(demo.events), ["reply-to-demo"]);
  assert.deepEqual(root.events, []);
});

test("root-channel messages reach root only from the owner and root's allowed users", async () => {
  const { workspace, root, demo } = await rootAndDemo();

  for (const [id, author] of [
    ["from-owner", { id: OWNER_ID, username: "Owner" }],
    ["from-helper", { id: "helper-id", username: "Helper" }],
    ["from-guest", { id: "guest-id", username: "Guest" }],
    ["from-stranger", { id: "stranger-id", username: "Stranger" }],
  ]) {
    injectDiscordMessage(workspace, { id, channelId: "root-channel", content: "status of every project?", author });
  }
  await settle(workspace, demo);

  assert.deepEqual(root.events.map(({ message_id, channel_id, author }) => ({ message_id, channel_id, is_owner: author.is_owner })), [
    { message_id: "from-owner", channel_id: "root-channel", is_owner: true },
    { message_id: "from-helper", channel_id: "root-channel", is_owner: false },
  ]);
  assert.deepEqual(ids(demo.events), []);
});

test("root-channel reactions reach only root, under root's allowlist, with the root bot's provenance", async () => {
  const { workspace, root, demo } = await rootAndDemo();
  const users = {
    owner: { id: OWNER_ID, username: "Owner" }, helper: { id: "helper-id", username: "Helper" },
    guest: { id: "guest-id", username: "Guest" }, stranger: { id: "stranger-id", username: "Stranger" },
  };
  const botMessage = { author: { id: BOT_ID, username: "Root", bot: true }, content: "root said" };
  const webhookMessage = { author: { id: "fake-webhook-1", username: "demo-codex", bot: true }, webhookId: "fake-webhook-1" };
  const inject = (id, channelId, user, message) =>
    injectDiscordReaction(workspace, { id, channelId, emoji: "👍", messageId: `${id}-message`, user, message });
  inject("owner-on-bot", "root-channel", users.owner, { ...botMessage, partial: true });
  inject("helper-on-owner", "root-channel", users.helper, { author: { id: OWNER_ID, username: "Owner", bot: false } });
  inject("owner-on-webhook", "root-channel", users.owner, webhookMessage);
  inject("guest-in-root", "root-channel", users.guest, botMessage);
  inject("stranger-in-root", "root-channel", users.stranger, botMessage);
  // The project's own reaction is the fence: everything before it has been routed.
  inject("owner-in-demo", "demo-channel", users.owner, webhookMessage);
  await waitFor(() => demo.events.length > 0, () => "the demo reaction");
  await waitFor(() => root.events.length === 3, () => "three root reactions");

  const shape = ({ message_id, channel_id, message_author_id, message_webhook_id, message_from_bot, user }) =>
    ({ message_id, channel_id, message_author_id, message_webhook_id, message_from_bot, user: user.id });
  assert.deepEqual(root.events.map(shape), [
    { message_id: "owner-on-bot-message", channel_id: "root-channel", message_author_id: BOT_ID,
      message_webhook_id: null, message_from_bot: true, user: OWNER_ID },
    { message_id: "helper-on-owner-message", channel_id: "root-channel", message_author_id: OWNER_ID,
      message_webhook_id: null, message_from_bot: false, user: "helper-id" },
    { message_id: "owner-on-webhook-message", channel_id: "root-channel", message_author_id: "fake-webhook-1",
      message_webhook_id: "fake-webhook-1", message_from_bot: false, user: OWNER_ID },
  ]);
  assert.deepEqual(demo.events.map(shape), [
    { message_id: "owner-in-demo-message", channel_id: "demo-channel", message_author_id: "fake-webhook-1",
      message_webhook_id: "fake-webhook-1", message_from_bot: false, user: OWNER_ID },
  ]);
});

test("a guest's bot mention in a project channel reaches neither root nor the project", async () => {
  const { workspace, root, demo } = await rootAndDemo();

  injectDiscordMessage(workspace, { id: "guest-mention", channelId: "demo-channel", content: `<@!${BOT_ID}> give me admin`,
    author: { id: "guest-id", username: "Guest" } });
  await settle(workspace, demo);

  assert.deepEqual(root.events, []);
  assert.deepEqual(ids(demo.events), []);
});

test("root replies in a project channel as the bot, and an unregistered channel is a scope violation", async () => {
  const { workspace, root } = await rootAndDemo();

  const result = await root.client.request("reply", { channel_id: "demo-channel", text: "restarting demo", context_pct: 12 });
  await assert.rejects(root.client.request("reply", { channel_id: "unregistered-channel", text: "hello?" }),
    { code: "scope_violation" });

  const sent = readState(workspace.stateDir).fixtures.discord.messages;
  assert.deepEqual(sent.map(({ id, channelId, content, authorization, webhookId }) =>
    ({ id, channelId, content, authorization, webhookId })), [{
    id: "fake-message-1", channelId: "demo-channel", content: "restarting demo",
    authorization: `Bot ${ROOT_TOKEN}`, webhookId: undefined,
  }]);
  assert.deepEqual(result, { message_id: "fake-message-1", message_ids: ["fake-message-1"] });
});

test("root reacts, types, reads, and edits only its own bot messages across its channels", async () => {
  const workspace = createRouterWorkspace(rootRegistry());
  const state = readState(workspace.stateDir);
  state.fixtures.discord.history = { "demo-channel": [
    { id: "2001", channel_id: "demo-channel", timestamp: "2026-09-01T10:00:00.000Z", content: "run the tests",
      author: { id: OWNER_ID, username: "Owner" }, attachments: [] },
  ] };
  writeState(state, workspace.stateDir);
  writeRootKey(workspace, "root-key");
  await routerWithWebhooks(workspace, ["demo"]);
  const root = await connectRoot(workspace, "root-key");
  const demo = await connectSession(workspace, "demo", "demo-key");
  const { message_id: demoMessage } = await demo.client.request("reply", { channel_id: "demo-channel", text: "demo's own" });
  const { message_id: rootMessage } = await root.client.request("reply", { channel_id: "root-channel", text: "checking…" });

  await root.client.request("react", { channel_id: "demo-channel", message_id: "2001", emoji: "👀" });
  await root.client.request("typing", { channel_id: "root-channel" });
  const read = await root.client.request("fetch_messages", { channel_id: "demo-channel", limit: 5 });
  const edited = await root.client.request("edit_message", { channel_id: "root-channel", message_id: rootMessage, text: "all fine" });
  await assert.rejects(root.client.request("edit_message", { channel_id: "demo-channel", message_id: demoMessage, text: "hijacked" }),
    { code: "scope_violation" });

  const discord = readState(workspace.stateDir).fixtures.discord;
  assert.deepEqual(discord.reactions.map(({ channelId, messageId, authorization }) => ({ channelId, messageId, authorization })),
    [{ channelId: "demo-channel", messageId: "2001", authorization: `Bot ${ROOT_TOKEN}` }]);
  assert.deepEqual(discord.typing.map(({ channelId }) => channelId), ["root-channel"]);
  assert.deepEqual(read, { count: 1, text: "[2026-09-01T10:00:00.000Z] Owner: run the tests (id: 2001)" });
  assert.deepEqual(edited, { message_id: rootMessage });
  assert.deepEqual(discord.edits.map(({ channelId, messageId, content }) => ({ channelId, messageId, content })),
    [{ channelId: "root-channel", messageId: rootMessage, content: "all fine" }]);
});

test("migrate-root-config copies root channels and allowed users from access.json once", async () => {
  const workspace = createRouterWorkspace();
  const accessFile = path.join(workspace.homeDir, ".claude/channels/discord/access.json");
  const access = `${JSON.stringify({
    dmPolicy: "allowlist",
    allowFrom: [OWNER_ID, "helper-id"],
    groups: {
      "root-channel": { requireMention: false, allowFrom: [OWNER_ID, "ops-id"] },
      "root-side-channel": { requireMention: false },
      "demo-channel": { requireMention: true, allowFrom: [OWNER_ID] },
    },
    pending: {},
  }, null, 2)}\n`;
  fs.writeFileSync(accessFile, access, { mode: 0o600 });
  const registryFile = path.join(workspace.repoDir, "registry.json");

  const first = await runRouterCli(workspace, ["migrate-root-config"]);
  const migrated = fs.readFileSync(registryFile, "utf8");
  const second = await runRouterCli(workspace, ["migrate-root-config"]);

  assert.equal(first.exitCode, 0, first.stderr);
  const registry = JSON.parse(migrated);
  assert.deepEqual({ root_channels: registry.root_channels, root_allowed_user_ids: registry.root_allowed_user_ids }, {
    root_channels: ["root-channel", "root-side-channel"],
    root_allowed_user_ids: ["helper-id", "ops-id"],
  });
  assert.deepEqual(registry.projects.demo, routerRegistry().projects.demo);
  assert.equal(second.exitCode, 0, second.stderr);
  assert.match(second.stdout, /nothing to migrate/);
  assert.equal(fs.readFileSync(registryFile, "utf8"), migrated);
  assert.equal(fs.readFileSync(accessFile, "utf8"), access);
});
