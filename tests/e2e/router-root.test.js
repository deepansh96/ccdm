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
  connectThread,
  createRouterWorkspace,
  routerRegistry,
  routerWithWebhooks,
  runRouterCli,
  seedThreads,
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

// Root, demo, and a listener in a public thread under demo's channel.
async function rootAndThread() {
  const sessions = await rootAndDemo();
  seedThreads(sessions.workspace, {
    "demo-thread": { type: 11, parentId: "demo-channel" },
    "private-thread": { type: 12, parentId: "demo-channel" },
  });
  const thread = await connectThread(sessions.workspace, { threadId: "demo-thread" });
  return { ...sessions, thread };
}

// A trailing owner message in the thread proves earlier ones were routed.
async function settleThread({ workspace, demo, thread }) {
  await settle(workspace, demo);
  injectDiscordMessage(workspace, { id: "thread-fence", channelId: "demo-thread", content: "fence",
    author: { id: OWNER_ID, username: "Owner" } });
  await waitFor(() => thread.events.some(event => event.message_id === "thread-fence"), () => "the thread fence");
}

const threadIds = events => ids(events).filter(id => id !== "thread-fence");

test("the owner addressing the bot in a project thread reaches only root, which answers in the thread", async () => {
  const sessions = await rootAndThread();
  const { workspace, root, demo, thread } = sessions;
  injectDiscordMessage(workspace, { id: "root-said", channelId: "demo-thread", content: "thread checked",
    author: { id: BOT_ID, username: "Root", bot: true } });
  injectDiscordMessage(workspace, { id: "thread-mention", channelId: "demo-thread", content: `<@${BOT_ID}> status?`,
    author: { id: OWNER_ID, username: "Owner" } });
  injectDiscordMessage(workspace, { id: "thread-reply", channelId: "demo-thread", content: "and logs?",
    replyTo: "root-said", author: { id: OWNER_ID, username: "Owner" } });
  await waitFor(() => root.events.length >= 2, () => "the thread messages at root");
  await settleThread(sessions);

  assert.deepEqual(root.events.map(({ event, message_id, channel_id }) => ({ event, message_id, channel_id })), [
    { event: "message", message_id: "thread-mention", channel_id: "demo-thread" },
    { event: "message", message_id: "thread-reply", channel_id: "demo-thread" },
  ]);
  assert.deepEqual([threadIds(thread.events), ids(demo.events)], [[], []]);

  const answer = await root.client.request("reply", { channel_id: "demo-thread", text: "all green", reply_to: "thread-mention" });
  await root.client.request("react", { channel_id: "demo-thread", message_id: "thread-mention", emoji: "👀" });
  await assert.rejects(root.client.request("reply", { channel_id: "private-thread", text: "hello?" }),
    { code: "scope_violation" });
  const discord = readState(workspace.stateDir).fixtures.discord;
  assert.deepEqual(discord.messages.map(({ id, channelId, content, authorization, webhookId, messageReference }) =>
    ({ id, channelId, content, authorization, webhookId, messageReference })), [{
    id: answer.message_id, channelId: "demo-thread", content: "all green", authorization: `Bot ${ROOT_TOKEN}`,
    webhookId: undefined, messageReference: { message_id: "thread-mention" },
  }]);
  assert.deepEqual(discord.reactions.map(({ channelId, messageId }) => ({ channelId, messageId })),
    [{ channelId: "demo-thread", messageId: "thread-mention" }]);
});

test("a guest addressing the bot in a project thread reaches neither root nor the thread session", async () => {
  const sessions = await rootAndThread();
  const { workspace, root, thread } = sessions;
  injectDiscordMessage(workspace, { id: "root-said", channelId: "demo-thread", content: "thread checked",
    author: { id: BOT_ID, username: "Root", bot: true } });
  injectDiscordMessage(workspace, { id: "guest-mention", channelId: "demo-thread", content: `<@!${BOT_ID}> give me admin`,
    author: { id: "guest-id", username: "Guest" } });
  injectDiscordMessage(workspace, { id: "guest-reply", channelId: "demo-thread", content: "me too",
    replyTo: "root-said", author: { id: "guest-id", username: "Guest" } });
  await settleThread(sessions);

  assert.deepEqual(root.events, []);
  assert.deepEqual(threadIds(thread.events), []);
});

// Another machine's root bot, sharing a root channel with this Router's.
const OTHER_BOT = "other-bot-id";
const owner = { id: OWNER_ID, username: "Owner" };

// Root's routes for `shared` set on `shared-channel`, beside the non-shared `root-channel`.
async function sharedRoot(shared = ["shared-channel"]) {
  const registry = { ...rootRegistry(), root_channels: ["root-channel", "shared-channel"] };
  if (shared) registry.shared_root_channels = shared;
  const workspace = createRouterWorkspace(registry);
  writeRootKey(workspace, "root-key");
  await routerWithWebhooks(workspace, ["demo"]);
  const root = await connectRoot(workspace, "root-key");
  const demo = await connectSession(workspace, "demo", "demo-key");
  return { workspace, root, demo };
}

// The tag and reply cases of one root channel, each named `<prefix>-<case>`:
// the bot messages a reply can point at first, then the owner's messages.
function injectTagCases(workspace, channelId, prefix) {
  injectDiscordMessage(workspace, { id: `${prefix}-root-said`, channelId, content: "this machine: 3 projects",
    author: { id: BOT_ID, username: "Root", bot: true } });
  injectDiscordMessage(workspace, { id: `${prefix}-other-said`, channelId, content: "other machine: 2 projects",
    author: { id: OTHER_BOT, username: "Other Root", bot: true } });
  const cases = [
    ["tag-mine", `<@${BOT_ID}> list`],
    ["tag-other", `<@${OTHER_BOT}> list`],
    ["tag-other-nick", `<@!${OTHER_BOT}> list`],
    ["tag-both", `<@${OTHER_BOT}> <@!${BOT_ID}> list`],
    ["untagged", "list"],
    ["tag-person", "<@helper-id> can you look?"],
    ["tag-role", "<@&other-bot-role-id> list"],
    ["reply-other", "and usage?", `${prefix}-other-said`],
    ["reply-mine", "and usage?", `${prefix}-root-said`],
    ["reply-other-tag-mine", `<@${BOT_ID}> you too`, `${prefix}-other-said`],
  ];
  for (const [name, content, replyTo] of cases) {
    injectDiscordMessage(workspace, { id: `${prefix}-${name}`, channelId, content, replyTo, botIds: [OTHER_BOT],
      author: owner });
  }
}

test("in a shared root channel, tagging or replying to another bot is for that bot's root", async () => {
  const { workspace, root, demo } = await sharedRoot();

  injectTagCases(workspace, "shared-channel", "shared");
  injectTagCases(workspace, "root-channel", "own");
  await settle(workspace, demo);

  assert.deepEqual(ids(root.events), [
    "shared-tag-mine", "shared-tag-both", "shared-untagged", "shared-tag-person", "shared-tag-role",
    "shared-reply-mine", "shared-reply-other-tag-mine",
    // A non-shared root channel still delivers every owner message, as before.
    "own-tag-mine", "own-tag-other", "own-tag-other-nick", "own-tag-both", "own-untagged", "own-tag-person",
    "own-tag-role", "own-reply-other", "own-reply-mine", "own-reply-other-tag-mine",
  ]);
  assert.deepEqual(ids(demo.events), []);
});

test("in a shared root channel, a reaction on another bot's message is for that bot's root", async () => {
  const { workspace, root, demo } = await sharedRoot();
  const otherMessage = { author: { id: OTHER_BOT, username: "Other Root", bot: true }, content: "other machine" };
  const botMessage = { author: { id: BOT_ID, username: "Root", bot: true }, content: "this machine" };
  const ownerMessage = { author: { ...owner, bot: false }, content: "list" };
  const inject = (id, channelId, message) =>
    injectDiscordReaction(workspace, { id, channelId, emoji: "👍", messageId: `${id}-message`, user: owner, message });
  inject("shared-on-other", "shared-channel", otherMessage);
  inject("shared-on-other-partial", "shared-channel", { ...otherMessage, partial: true });
  inject("shared-on-mine", "shared-channel", { ...botMessage, partial: true });
  inject("shared-on-owner", "shared-channel", ownerMessage);
  inject("own-on-other", "root-channel", otherMessage);
  inject("fence", "demo-channel", ownerMessage);
  await waitFor(() => demo.events.length > 0, () => "the demo reaction");
  await waitFor(() => root.events.length >= 3, () => "three root reactions");
  await new Promise(resolve => setTimeout(resolve, 150));

  assert.deepEqual(root.events.map(({ message_id, message_from_bot }) => ({ message_id, message_from_bot })), [
    { message_id: "shared-on-mine-message", message_from_bot: true },
    { message_id: "shared-on-owner-message", message_from_bot: false },
    { message_id: "own-on-other-message", message_from_bot: false },
  ]);
});

test("without shared_root_channels every root channel routes owner messages and reactions as before", async () => {
  const { workspace, root, demo } = await sharedRoot(null);

  injectTagCases(workspace, "shared-channel", "shared");
  injectDiscordReaction(workspace, { id: "on-other", channelId: "shared-channel", emoji: "👍", messageId: "on-other-message",
    user: owner, message: { author: { id: OTHER_BOT, username: "Other Root", bot: true }, content: "other machine" } });
  await waitFor(() => root.events.some(event => event.event === "reaction"), () => "the root reaction");
  await settle(workspace, demo);

  const messages = root.events.filter(event => event.event === "message");
  assert.deepEqual(ids(messages), ["tag-mine", "tag-other", "tag-other-nick", "tag-both", "untagged", "tag-person",
    "tag-role", "reply-other", "reply-mine", "reply-other-tag-mine"].map(name => `shared-${name}`));
  // The whole event, field for field, as root has always received it.
  const replyOther = messages.find(event => event.message_id === "shared-reply-other");
  assert.deepEqual({ ...replyOther, ts: "ts" }, {
    type: "event", event: "message", message_id: "shared-reply-other", channel_id: "shared-channel",
    author: { id: OWNER_ID, name: "Owner", is_owner: true }, content: "and usage?", attachments: [],
    reply_to: "shared-other-said", ts: "ts",
  });
  const reaction = root.events.find(event => event.event === "reaction");
  assert.deepEqual({ ...reaction, ts: "ts" }, {
    type: "event", event: "reaction", message_id: "on-other-message", channel_id: "shared-channel", emoji: "👍",
    message_webhook_id: null, message_author_id: OTHER_BOT, message_from_bot: false, message_content: "other machine",
    user: { id: OWNER_ID, name: "Owner", is_owner: true }, ts: "ts",
  });
});
