import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { injectDiscordMessage, injectDiscordReaction, runPreloadProbe } from "./support/bridge.js";
import {
  OWNER_ID,
  ROOT_TOKEN,
  connectSession,
  createRouterWorkspace,
  routerRegistry,
  routerWithWebhooks,
  runRouterCli,
  startRouter,
  waitFor,
  writeProjectKey,
} from "./support/router.js";
import { readState, updateState } from "./support/state.js";
import { cleanup } from "./support/teardown.js";

test.afterEach(async () => {
  await cleanup();
});

test("an owner message in a router project channel reaches only that project's session", async () => {
  const workspace = createRouterWorkspace();
  writeProjectKey(workspace, "demo", "demo-key");
  writeProjectKey(workspace, "beta", "beta-key");
  const router = await startRouter(workspace);
  const demo = await connectSession(workspace, "demo", "demo-key");
  const beta = await connectSession(workspace, "beta", "beta-key");

  injectDiscordMessage(workspace, {
    id: "owner-message-1",
    channelId: "demo-channel",
    content: "please run the tests",
    createdTimestamp: Date.parse("2026-09-29T10:00:00.000Z"),
    replyTo: "earlier-message",
    author: { id: OWNER_ID, username: "Owner" },
    attachments: [{ id: "att-1", name: "notes.txt", contentType: "text/plain", size: 12,
      url: "https://cdn.discordapp.com/attachments/demo-channel/att-1/notes.txt" }],
  });

  await waitFor(() => demo.events.length > 0, () => `demo message event; router:\n${router.stdout}\n${router.stderr}`);
  assert.deepEqual(demo.events, [{
    type: "event",
    event: "message",
    message_id: "owner-message-1",
    channel_id: "demo-channel",
    author: { id: OWNER_ID, name: "Owner", is_owner: true },
    content: "please run the tests",
    attachments: [{ id: "att-1", name: "notes.txt", content_type: "text/plain", size: 12,
      url: "https://cdn.discordapp.com/attachments/demo-channel/att-1/notes.txt" }],
    reply_to: "earlier-message",
    ts: "2026-09-29T10:00:00.000Z",
  }]);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.deepEqual(beta.events, []);
});

test("a registry with no transport fields and no pool routes every project through the Router", async () => {
  const workspace = createRouterWorkspace({
    discord_user_id: OWNER_ID,
    guild_id: "guild-id",
    projects: {
      demo: { channel_id: "demo-channel", type: "claude" },
      beta: { channel_id: "beta-channel", type: "codex" },
    },
  });
  writeProjectKey(workspace, "demo", "demo-key");
  writeProjectKey(workspace, "beta", "beta-key");
  const router = await startRouter(workspace);
  const demo = await connectSession(workspace, "demo", "demo-key");
  const beta = await connectSession(workspace, "beta", "beta-key");

  for (const [id, channelId] of [["demo-message", "demo-channel"], ["beta-message", "beta-channel"]]) {
    injectDiscordMessage(workspace, {
      id, channelId, content: `hello ${channelId}`, author: { id: OWNER_ID, username: "Owner" },
    });
  }

  await waitFor(() => demo.events.length > 0 && beta.events.length > 0,
    () => `both project events; router:\n${router.stdout}\n${router.stderr}`);
  assert.deepEqual(demo.events.map(({ message_id, channel_id }) => ({ message_id, channel_id })),
    [{ message_id: "demo-message", channel_id: "demo-channel" }]);
  assert.deepEqual(beta.events.map(({ message_id, channel_id }) => ({ message_id, channel_id })),
    [{ message_id: "beta-message", channel_id: "beta-channel" }]);
});

test("the network guard permits Unix sockets inside the Test Workspace and blocks other egress", async () => {
  const workspace = createRouterWorkspace();
  const inside = path.join(workspace.tmpRoot, "probe.sock");
  const outside = path.join(os.tmpdir(), `ralph-127-outside-${process.pid}.sock`);
  const result = await runPreloadProbe(workspace, `
    const net = require("node:net");
    const server = net.createServer(socket => socket.end("pong"));
    server.listen(${JSON.stringify(inside)}, () => {
      const client = net.connect(${JSON.stringify(inside)});
      client.on("data", data => {
        console.log("inside:" + data);
        for (const target of [${JSON.stringify(outside)}, { path: ${JSON.stringify(outside)} }]) {
          try { net.connect(target); } catch (error) { console.log(error.message); }
        }
        try { net.connect(443, "example.com"); } catch (error) { console.log(error.message); }
        server.close();
      });
    });
  `);

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /inside:pong/);
  assert.equal(result.stdout.split(`Blocked unexpected net egress: unix:${outside}`).length - 1, 2);
  assert.match(result.stdout, /Blocked unexpected net egress: example\.com:443/);
  assert.deepEqual(readState(workspace.stateDir).fixtures.network.blocked.map(entry => entry.target),
    [`unix:${outside}`, `unix:${outside}`, "example.com:443"]);
});

test("ensure-webhook creates the project webhook once, reuses it, and keeps its token out of the registry", async () => {
  const workspace = createRouterWorkspace();

  const first = await runRouterCli(workspace, ["ensure-webhook", "demo"]);
  const second = await runRouterCli(workspace, ["ensure-webhook", "demo"]);

  assert.equal(first.exitCode, 0, first.stderr || first.stdout);
  assert.equal(second.exitCode, 0, second.stderr || second.stdout);
  assert.match(first.stdout, /created webhook ccdm-demo id=fake-webhook-1/);
  assert.match(second.stdout, /reused webhook ccdm-demo id=fake-webhook-1/);
  const discord = readState(workspace.stateDir).fixtures.discord;
  assert.deepEqual(discord.webhookCreates, [
    { authorization: `Bot ${ROOT_TOKEN}`, channelId: "demo-channel", name: "ccdm-demo" },
  ]);
  const registryText = fs.readFileSync(path.join(workspace.repoDir, "registry.json"), "utf8");
  assert.equal(JSON.parse(registryText).projects.demo.webhook_id, "fake-webhook-1");
  for (const text of [registryText, first.stdout, first.stderr, second.stdout, second.stderr]) {
    assert.doesNotMatch(text, /fake-webhook-token/);
  }
});


test("a session's reply posts through its project webhook under its Project Identity", async () => {
  const workspace = createRouterWorkspace();
  await routerWithWebhooks(workspace, ["demo"]);
  const demo = await connectSession(workspace, "demo", "demo-key");

  const withPct = await demo.client.request("reply", { channel_id: "demo-channel", text: "done", context_pct: 42 });
  const withoutPct = await demo.client.request("reply", { channel_id: "demo-channel", text: "still done" });

  const messages = readState(workspace.stateDir).fixtures.discord.messages;
  assert.deepEqual(messages.map(({ id, channelId, content, username, webhookId }) => ({ id, channelId, content, username, webhookId })), [
    { id: "fake-message-1", channelId: "demo-channel", content: "done", username: "demo-claude · 42%", webhookId: "fake-webhook-1" },
    { id: "fake-message-2", channelId: "demo-channel", content: "still done", username: "demo-claude", webhookId: "fake-webhook-1" },
  ]);
  assert.deepEqual([withPct, withoutPct], [
    { message_id: "fake-message-1", message_ids: ["fake-message-1"] },
    { message_id: "fake-message-2", message_ids: ["fake-message-2"] },
  ]);
});

test("project names Discord would refuse get a sanitized username that keeps the context suffix", async () => {
  const longName = "a".repeat(90);
  const workspace = createRouterWorkspace(routerRegistry({
    "discord-root-agent": { channel_id: "dra-channel", type: "claude", transport: "router" },
    [longName]: { channel_id: "long-channel", type: "codex", transport: "router" },
  }));
  await routerWithWebhooks(workspace, ["discord-root-agent", longName]);
  const agent = await connectSession(workspace, "discord-root-agent", "discord-root-agent-key");
  const long = await connectSession(workspace, longName, `${longName}-key`);

  await agent.client.request("reply", { channel_id: "dra-channel", text: "hi", context_pct: 42 });
  await long.client.request("reply", { channel_id: "long-channel", text: "hi", context_pct: 7 });

  const discord = readState(workspace.stateDir).fixtures.discord;
  assert.deepEqual(discord.webhookRejections ?? [], []);
  assert.deepEqual(discord.messages.map(message => message.username), [
    "d‍iscord-root-agent-claude · 42%",
    `${"a".repeat(69)}-codex · 7%`,
  ]);
});

function injectMessage(workspace, id, author, extra = {}) {
  injectDiscordMessage(workspace, { id, channelId: "demo-channel", content: `from ${id}`, author, ...extra });
}

async function waitForDelivered(workspace, id) {
  await waitFor(() => readState(workspace.stateDir).fixtures.discord.deliveredMessages.some(entry => entry.id === id),
    () => `gateway delivery of ${id}`);
  // Classification is asynchronous to the gateway emit.
  await new Promise((resolve) => setTimeout(resolve, 150));
}

test("bot, webhook, and stranger messages are never forwarded, while a registered guest's is", async () => {
  const workspace = createRouterWorkspace();
  writeProjectKey(workspace, "demo", "demo-key");
  await startRouter(workspace);
  const demo = await connectSession(workspace, "demo", "demo-key");

  // Author IDs the filter would otherwise allow, so only the bot/webhook check can drop them.
  injectMessage(workspace, "from-bot", { id: "guest-id", username: "Bot", bot: true });
  injectMessage(workspace, "from-webhook", { id: OWNER_ID, username: "demo-claude" }, { webhookId: "fake-webhook-1" });
  injectMessage(workspace, "from-stranger", { id: "stranger-id", username: "Stranger" });
  injectMessage(workspace, "from-guest", { id: "guest-id", username: "Guest" });
  await waitForDelivered(workspace, "from-guest");

  assert.deepEqual(demo.events.map(event => [event.message_id, event.author]), [
    ["from-guest", { id: "guest-id", name: "Guest", is_owner: false }],
  ]);
  assert.deepEqual(readState(workspace.stateDir).fixtures.discord.reactions, []);
});

test("a message to a router channel with no session gets 💤 and is not replayed to a later session", async () => {
  const workspace = createRouterWorkspace();
  writeProjectKey(workspace, "demo", "demo-key");
  await startRouter(workspace);

  injectMessage(workspace, "while-offline", { id: OWNER_ID, username: "Owner" });
  await waitFor(() => readState(workspace.stateDir).fixtures.discord.reactions.length > 0, () => "offline reaction");
  const demo = await connectSession(workspace, "demo", "demo-key");
  await new Promise((resolve) => setTimeout(resolve, 200));

  assert.deepEqual(readState(workspace.stateDir).fixtures.discord.reactions, [{
    authorization: `Bot ${ROOT_TOKEN}`, channelId: "demo-channel", emoji: encodeURIComponent("💤"), messageId: "while-offline",
  }]);
  assert.deepEqual(demo.events, []);
});

test("an unregistered channel is ignored entirely", async () => {
  const workspace = createRouterWorkspace();
  writeProjectKey(workspace, "demo", "demo-key");
  await startRouter(workspace);
  const demo = await connectSession(workspace, "demo", "demo-key");

  injectDiscordMessage(workspace, { id: "stray-message", channelId: "unregistered-channel", content: "hi",
    author: { id: OWNER_ID, username: "Owner" } });
  await waitForDelivered(workspace, "stray-message");

  assert.deepEqual(readState(workspace.stateDir).fixtures.discord.reactions, []);
  assert.deepEqual(demo.events, []);
});

test("the five plain management commands arrive as command events", async () => {
  const workspace = createRouterWorkspace();
  writeProjectKey(workspace, "demo", "demo-key");
  await startRouter(workspace);
  const demo = await connectSession(workspace, "demo", "demo-key");

  for (const command of ["/pause", "/unpause", "/compact", "/clear", "/restart"]) {
    injectMessage(workspace, `cmd-${command.slice(1)}`, { id: OWNER_ID, username: "Owner" }, { content: command });
  }
  await waitForDelivered(workspace, "cmd-restart");

  assert.deepEqual(demo.events.map(event => [event.event, event.command, event.message_id]), [
    ["command", "pause", "cmd-pause"],
    ["command", "unpause", "cmd-unpause"],
    ["command", "compact", "cmd-compact"],
    ["command", "clear", "cmd-clear"],
    ["command", "restart", "cmd-restart"],
  ]);
});

test("owner reactions in the channel reach the session as reaction events", async () => {
  const workspace = createRouterWorkspace();
  writeProjectKey(workspace, "demo", "demo-key");
  await startRouter(workspace);
  const demo = await connectSession(workspace, "demo", "demo-key");

  injectDiscordReaction(workspace, { id: "bot-reaction", channelId: "demo-channel", emoji: "🤖", messageId: "reply-1",
    user: { id: "some-bot", username: "Bot", bot: true } });
  injectDiscordReaction(workspace, { id: "owner-reaction", channelId: "demo-channel", emoji: "👍", messageId: "reply-1",
    user: { id: OWNER_ID, username: "Owner" } });
  await waitFor(() => demo.events.length > 0, () => "reaction event");
  await new Promise((resolve) => setTimeout(resolve, 150));

  assert.deepEqual(demo.events.map(({ ts, ...event }) => event), [{
    type: "event", event: "reaction", message_id: "reply-1", channel_id: "demo-channel", emoji: "👍",
    message_webhook_id: null, message_author_id: "fixture-bot-user-id", message_from_bot: true,
    message_content: "", user: { id: OWNER_ID, name: "Owner", is_owner: true },
  }]);
});

test("a reply aimed at another channel is rejected as a scope violation and logged", async () => {
  const workspace = createRouterWorkspace();
  const router = await routerWithWebhooks(workspace, ["demo"]);
  const demo = await connectSession(workspace, "demo", "demo-key");

  await assert.rejects(demo.client.request("reply", { channel_id: "beta-channel", text: "sneaky" }),
    { code: "scope_violation" });

  await router.waitForOutput(/scope_violation project=demo op=reply target=beta-channel/);
  assert.deepEqual(readState(workspace.stateDir).fixtures.discord.messages ?? [], []);
});

test("router status reports connected sessions and webhook presence without leaking webhook tokens", async () => {
  const workspace = createRouterWorkspace();
  const router = await routerWithWebhooks(workspace, ["demo"]);
  writeProjectKey(workspace, "beta", "beta-key");
  await connectSession(workspace, "demo", "demo-key");

  const status = await runRouterCli(workspace, ["status"]);

  assert.equal(status.exitCode, 0, status.stderr || status.stdout);
  assert.match(status.stdout, /gateway: ready/);
  assert.match(status.stdout, /registry loaded: \d{4}-\d{2}-\d{2}T/);
  assert.match(status.stdout, /sessions: 1\n  project demo scope=demo-channel connected=\d{4}-/);
  assert.match(status.stdout, /demo channel=demo-channel webhook=present/);
  assert.match(status.stdout, /beta channel=beta-channel webhook=missing/);
  // The unmigrated project is routed too; it has no webhook yet.
  assert.match(status.stdout, /legacy channel=legacy-channel webhook=missing/);

  // The token Discord issued lives only in the Router's private webhook state.
  const [{ token }] = readState(workspace.stateDir).fixtures.discord.webhooks;
  const leaks = [];
  const scan = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (file === workspace.stateDir || file === path.join(workspace.routerStateDir, "webhooks")) continue;
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      if (entry.isDirectory()) scan(file);
      else if (entry.isFile() && fs.readFileSync(file, "utf8").includes(token)) leaks.push(file);
    }
  };
  scan(workspace.tmpRoot);
  assert.deepEqual(leaks, []);
  for (const text of [status.stdout, status.stderr, router.stdout, router.stderr]) {
    assert.equal(text.includes(token), false);
  }
  const secretFile = path.join(workspace.routerStateDir, "webhooks", "demo.json");
  assert.equal(fs.statSync(secretFile).mode & 0o777, 0o600);
  assert.equal(fs.statSync(workspace.routerStateDir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(workspace.socketPath).mode & 0o777, 0o600);
});

test("router status names a missing Manage Webhooks permission in a project channel", async () => {
  const workspace = createRouterWorkspace();
  updateState(workspace.stateDir, (state) => {
    state.fixtures.discord.permissionDenials = { "fixture-bot-user-id": ["ManageWebhooks"] };
  });
  await startRouter(workspace);

  const status = await runRouterCli(workspace, ["status", "--json"]);

  assert.equal(status.exitCode, 0, status.stderr || status.stdout);
  const demo = JSON.parse(status.stdout).projects.find(({ project }) => project === "demo");
  assert.deepEqual(demo.missing_permissions, ["ManageWebhooks"]);
});

test("router status exits non-zero when the Router is not running", async () => {
  const workspace = createRouterWorkspace();

  const status = await runRouterCli(workspace, ["status"]);

  assert.notEqual(status.exitCode, 0);
  assert.match(status.stderr, /router unreachable/);
});
