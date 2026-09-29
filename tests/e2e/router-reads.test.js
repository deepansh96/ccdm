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
  fetchThroughFakeCdn,
  routerWithWebhooks,
  waitFor,
} from "./support/router.js";
import { readState, writeState } from "./support/state.js";
import { cleanup } from "./support/teardown.js";

test.afterEach(async () => {
  await cleanup();
});

// Channel history as Discord returns it: newest first.
function seedHistory(workspace, channelId, messages) {
  const state = readState(workspace.stateDir);
  state.fixtures.discord.history ||= {};
  state.fixtures.discord.history[channelId] = messages;
  writeState(state, workspace.stateDir);
}

const DEMO_HISTORY = [
  { id: "1003", channel_id: "demo-channel", timestamp: "2026-09-01T10:02:00.000Z", content: "all green",
    author: { id: "root-bot-id", username: "Root", bot: true }, attachments: [] },
  { id: "1002", channel_id: "demo-channel", timestamp: "2026-09-01T10:01:00.000Z", content: "see log",
    author: { id: "owner-id", username: "Owner" },
    attachments: [{ id: "a1", filename: "build.log", url: "https://cdn.discordapp.com/attachments/demo-channel/a1/build.log" }] },
  { id: "1001", channel_id: "demo-channel", timestamp: "2026-09-01T10:00:00.000Z", content: "run the tests",
    author: { id: "owner-id", username: "Owner" }, attachments: [] },
];

test("read_last_x_messages_in_channel with a small count returns the messages inline, oldest first", async () => {
  const workspace = createRouterWorkspace();
  seedHistory(workspace, "demo-channel", DEMO_HISTORY);
  await routerWithWebhooks(workspace, ["demo"]);
  const demo = await connectSession(workspace, "demo", "demo-key");

  const result = await demo.client.request("read_last_x_messages_in_channel", { channel_id: "demo-channel", count: 2 });

  assert.deepEqual(result, {
    count: 2,
    text: "[2026-09-01T10:01:00.000Z] Owner: see log +1att (id: 1002)\n"
      + "[2026-09-01T10:02:00.000Z] me: all green (id: 1003)",
  });
});

test("read_last_x_messages_in_channel over the inline limit returns a private transcript in order", async () => {
  const workspace = createRouterWorkspace();
  // 150 messages, 1150 (newest) down to 1001.
  seedHistory(workspace, "demo-channel", Array.from({ length: 150 }, (_, index) => ({
    id: String(1150 - index), channel_id: "demo-channel", timestamp: "2026-09-01T10:00:00.000Z",
    content: `message ${1150 - index}`, author: { id: "owner-id", username: "Owner" }, attachments: [],
  })));
  await routerWithWebhooks(workspace, ["demo"]);
  const demo = await connectSession(workspace, "demo", "demo-key");

  const result = await demo.client.request("read_last_x_messages_in_channel", { channel_id: "demo-channel", count: 120 });

  assert.equal(result.count, 120);
  assert.equal(result.text, undefined);
  assert.equal(fs.statSync(result.path).mode & 0o777, 0o600);
  const lines = fs.readFileSync(result.path, "utf8").split("\n");
  assert.equal(lines.length, 121);
  assert.equal(lines[0], "[2026-09-01T10:00:00.000Z] Owner: message 1031 (id: 1031)");
  assert.equal(lines[1], "[2026-09-01T10:00:00.000Z] Owner: message 1032 (id: 1032)");
  assert.equal(lines[119], "[2026-09-01T10:00:00.000Z] Owner: message 1150 (id: 1150)");
  assert.equal(lines[120], "");
});

test("fetch_messages returns a recent page inline, oldest first", async () => {
  const workspace = createRouterWorkspace();
  seedHistory(workspace, "demo-channel", DEMO_HISTORY);
  await routerWithWebhooks(workspace, ["demo"]);
  const demo = await connectSession(workspace, "demo", "demo-key");

  const result = await demo.client.request("fetch_messages", { channel_id: "demo-channel" });

  assert.deepEqual(result, {
    count: 3,
    text: "[2026-09-01T10:00:00.000Z] Owner: run the tests (id: 1001)\n"
      + "[2026-09-01T10:01:00.000Z] Owner: see log +1att (id: 1002)\n"
      + "[2026-09-01T10:02:00.000Z] me: all green (id: 1003)",
  });
});

test("export_message_range writes the inclusive range in the export tool's format, with attachments saved", async () => {
  const workspace = createRouterWorkspace();
  // The export tool's own fixture, between an older and a newer message.
  seedHistory(workspace, "demo-channel", [
    { id: "104", timestamp: "2026-07-13T10:03:00.000Z", content: "after", author: { id: "2", username: "Bob" }, attachments: [] },
    { id: "103", timestamp: "2026-07-13T10:02:00.000Z", content: "end", author: { id: "2", username: "Bob" }, attachments: [] },
    { id: "102", timestamp: "2026-07-13T10:01:00.000Z", content: "middle", author: { id: "1", username: "Alice" },
      attachments: [{ id: "a1", filename: "notes.txt", url: "https://cdn.discordapp.com/a1" }] },
    { id: "101", timestamp: "2026-07-13T10:00:00.000Z", content: "start", author: { id: "1", username: "Alice" }, attachments: [] },
    { id: "100", timestamp: "2026-07-13T09:59:00.000Z", content: "before", author: { id: "1", username: "Alice" }, attachments: [] },
  ]);
  const state = readState(workspace.stateDir);
  state.fixtures.discord.attachments["https://cdn.discordapp.com/a1"] = { body: "attachment body" };
  writeState(state, workspace.stateDir);
  await routerWithWebhooks(workspace, ["demo"]);
  const demo = await connectSession(workspace, "demo", "demo-key");

  const result = await demo.client.request("export_message_range", {
    channel_id: "demo-channel", start_message_id: "101", end_message_id: "103",
  });

  const directory = path.dirname(result.path);
  assert.equal(fs.statSync(result.path).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(result.path, "utf8"), [
    "[2026-07-13T10:00:00.000Z] Alice (1)",
    "Message ID: 101",
    "start",
    "",
    "---",
    "",
    "[2026-07-13T10:01:00.000Z] Alice (1)",
    "Message ID: 102",
    "middle",
    "Attachment: notes.txt",
    "URL: https://cdn.discordapp.com/a1",
    `Saved: ${directory}/attachments/102-a1-notes.txt`,
    "",
    "---",
    "",
    "[2026-07-13T10:02:00.000Z] Bob (2)",
    "Message ID: 103",
    "end",
    "",
  ].join("\n"));
  assert.equal(fs.readFileSync(path.join(directory, "attachments/102-a1-notes.txt"), "utf8"), "attachment body");
});

// Signed CDN URLs carry their expiry as hex Unix seconds in `ex`.
const FRESH_URL = "https://cdn.discordapp.com/attachments/demo-channel/a7/plan.txt?ex=ffffffff&is=00000001&hm=fresh";
const STALE_URL = "https://cdn.discordapp.com/attachments/demo-channel/a7/plan.txt?ex=00000002&is=00000001&hm=stale";

function seedCdn(workspace, url, body) {
  const state = readState(workspace.stateDir);
  state.fixtures.discord.attachments[url] = { body };
  writeState(state, workspace.stateDir);
}

test("download_attachment returns the event's signed CDN URL while it is fresh, and the fake CDN serves it", async () => {
  const workspace = createRouterWorkspace();
  seedCdn(workspace, FRESH_URL, "the plan");
  await routerWithWebhooks(workspace, ["demo"]);
  const demo = await connectSession(workspace, "demo", "demo-key");
  injectDiscordMessage(workspace, { id: "2001", channelId: "demo-channel", content: "read this",
    author: { id: OWNER_ID, username: "Owner" },
    attachments: [{ id: "a7", name: "plan.txt", contentType: "text/plain", size: 8, url: FRESH_URL }] });
  await waitFor(() => demo.events.length > 0, () => "the owner message event");

  const result = await demo.client.request("download_attachment", { channel_id: "demo-channel", message_id: "2001" });

  assert.deepEqual(result, { id: "a7", name: "plan.txt", content_type: "text/plain", size: 8, url: FRESH_URL });
  assert.deepEqual(fetchThroughFakeCdn(workspace, result.url), { status: 200, body: "the plan" });
});

test("download_attachment refreshes a stale URL by re-fetching the message", async () => {
  const workspace = createRouterWorkspace();
  seedCdn(workspace, FRESH_URL, "the plan");
  await routerWithWebhooks(workspace, ["demo"]);
  const demo = await connectSession(workspace, "demo", "demo-key");
  // The gateway delivered a URL that has since expired; Discord re-signs it on fetch.
  injectDiscordMessage(workspace, { id: "2001", channelId: "demo-channel", content: "read this",
    author: { id: OWNER_ID, username: "Owner" },
    attachments: [{ id: "a7", name: "plan.txt", contentType: "text/plain", size: 8, url: STALE_URL, refreshedUrl: FRESH_URL }] });
  await waitFor(() => demo.events.length > 0, () => "the owner message event");
  assert.equal(demo.events[0].attachments[0].url, STALE_URL);

  const result = await demo.client.request("download_attachment", { channel_id: "demo-channel", message_id: "2001", attachment_id: "a7" });

  assert.equal(result.url, FRESH_URL);
  assert.deepEqual(fetchThroughFakeCdn(workspace, result.url), { status: 200, body: "the plan" });
  assert.deepEqual(readState(workspace.stateDir).fixtures.discord.messageFetches.filter(get => get.messageId === "2001"),
    [{ authorization: `Bot ${ROOT_TOKEN}`, channelId: "demo-channel", messageId: "2001" }]);
});

test("each read op aimed at another channel or its message is a logged scope violation", async () => {
  const workspace = createRouterWorkspace();
  seedHistory(workspace, "demo-channel", DEMO_HISTORY);
  seedHistory(workspace, "beta-channel", [
    { id: "3002", timestamp: "2026-09-01T11:01:00.000Z", content: "beta secret", author: { id: "owner-id", username: "Owner" },
      attachments: [{ id: "b1", filename: "secret.txt", url: FRESH_URL }] },
    { id: "3001", timestamp: "2026-09-01T11:00:00.000Z", content: "beta start", author: { id: "owner-id", username: "Owner" }, attachments: [] },
  ]);
  const router = await routerWithWebhooks(workspace, ["demo", "beta"]);
  const demo = await connectSession(workspace, "demo", "demo-key");

  const attempts = [
    ["fetch_messages", { channel_id: "beta-channel" }, "beta-channel"],
    ["read_last_x_messages_in_channel", { channel_id: "beta-channel", count: 5 }, "beta-channel"],
    ["export_message_range", { channel_id: "beta-channel", start_message_id: "3001" }, "beta-channel"],
    ["export_message_range", { channel_id: "demo-channel", start_message_id: "3001", end_message_id: "3002" }, "3001"],
    ["export_message_range", { channel_id: "demo-channel", start_message_id: "1001", end_message_id: "3002" }, "3002"],
    ["download_attachment", { channel_id: "beta-channel", message_id: "3002" }, "beta-channel"],
    ["download_attachment", { channel_id: "demo-channel", message_id: "3002" }, "3002"],
  ];
  for (const [op, args, target] of attempts) {
    await assert.rejects(demo.client.request(op, args), { code: "scope_violation" }, `${op} ${JSON.stringify(args)}`);
    await router.waitForOutput(new RegExp(`scope_violation project=demo op=${op} target=${target}\\b`));
  }

  const discord = readState(workspace.stateDir).fixtures.discord;
  assert.deepEqual((discord.historyFetches ?? []).filter(fetch => fetch.channelId === "beta-channel"), []);
  assert.deepEqual(discord.attachmentFetches ?? [], []);
});
