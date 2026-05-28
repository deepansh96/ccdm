import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import WebSocket from "ws";

import {
  createBridgeWorkspace,
  injectDiscordMessage,
  runPreloadProbe,
  startBridge,
  startFakeCodexServer,
  waitForState,
} from "./support/bridge.js";
import { readState, writeState } from "./support/state.js";
import { cleanup } from "./support/teardown.js";

test.afterEach(async () => {
  await cleanup();
});

test("child-scoped bridge preload blocks unexpected fetch egress", async () => {
  const workspace = createBridgeWorkspace();
  const seed = readState(workspace.stateDir);
  seed.fixtures.discord.attachments["https://cdn.discordapp.com/attachments/channel/message/file.txt"] = {
    body: "fixture attachment",
    contentType: "text/plain",
  };
  writeState(seed, workspace.stateDir);

  const result = await runPreloadProbe(
    workspace,
    "Promise.all([fetch('https://cdn.discordapp.com/attachments/channel/message/file.txt').then((res) => res.text()).then((text) => console.log('cdn:' + text)), fetch('https://discord.com/api/v10/unhandled').then((res) => console.log('discord-status:' + res.status)), fetch('https://example.com').catch((error) => console.log(error.message)), Promise.resolve().then(() => { try { require('https').request('https://example.com') } catch (error) { console.log(error.message) } }), Promise.resolve().then(() => { try { require('net').connect(443, 'example.com') } catch (error) { console.log(error.message) } })])",
  );

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.equal(workspace.env.NODE_OPTIONS, "");
  assert.match(result.stdout, /Blocked unexpected fetch egress: https:\/\/example\.com\//);
  assert.match(result.stdout, /Blocked unexpected https egress/);
  assert.match(result.stdout, /Blocked unexpected net egress: example\.com:443/);
  assert.match(result.stdout, /cdn:fixture attachment/);
  assert.match(result.stdout, /discord-status:400/);
  const discord = readState(workspace.stateDir).fixtures.discord;
  assert.equal(discord.attachmentFetches[0].url, "https://cdn.discordapp.com/attachments/channel/message/file.txt");
  assert.equal(discord.malformedRequests[0].url, "https://discord.com/api/v10/unhandled");
  assert.deepEqual(
    readState(workspace.stateDir).fixtures.network.blocked.map((entry) => entry.kind).sort(),
    ["fetch", "https", "net"],
  );
});

test("discord.js overlay exports the bridge surface and emits injected gateway messages", async () => {
  const workspace = createBridgeWorkspace();
  injectDiscordMessage(workspace, { content: "hello bridge" });

  const result = await runPreloadProbe(
    workspace,
    `
      const { Client, GatewayIntentBits, Partials } = require("discord.js");
      if (!GatewayIntentBits.Guilds || !Partials.Message) throw new Error("missing discord shim exports");
      const client = new Client({ intents: [GatewayIntentBits.Guilds], partials: [Partials.Message] });
      client.on("ready", () => console.log("ready:" + client.user.tag));
      client.on("messageCreate", async (msg) => {
        await msg.channel.sendTyping?.();
        console.log("message:" + msg.content);
        client.destroy();
        setTimeout(() => process.exit(0), 10);
      });
      client.login("bot-token");
      setTimeout(() => process.exit(2), 1000);
    `,
  );

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /ready:fixture-bot#0001/);
  assert.match(result.stdout, /message:hello bridge/);
  const discord = readState(workspace.stateDir).fixtures.discord;
  assert.equal(discord.logins[0].token, "bot-token");
  assert.equal(discord.deliveredMessages.length, 1);
});

test("fake Codex app-server speaks the startup, MCP, thread, turn, delta, MCP-reply, and token-usage protocol", async () => {
  const workspace = createBridgeWorkspace();
  const codex = await startFakeCodexServer(workspace, {
    channelId: "channel-id",
    staleMcpName: "discord-stale",
    turns: [
      {
        delta: "hello",
        mcpReply: true,
        tokenUsage: { last: { inputTokens: 20 }, modelContextWindow: 100 },
      },
    ],
  });
  const ws = new WebSocket(`ws://127.0.0.1:${codex.port}`);
  await once(ws, "open");
  const received = [];
  ws.on("message", (data) => received.push(JSON.parse(data.toString())));

  const request = async (id, method, params) => {
    ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    await waitFor(() => received.find((message) => message.id === id));
  };

  await request(1, "initialize", {});
  ws.send(JSON.stringify({ jsonrpc: "2.0", method: "initialized" }));
  await request(2, "mcpServerStatus/list", {});
  await request(3, "config/value/delete", { keyPath: "mcp_servers.discord-stale" });
  await request(4, "config/value/write", { keyPath: "mcp_servers.discord-channel-id" });
  await request(5, "config/mcpServer/reload", null);
  await request(6, "thread/start", { cwd: workspace.repoDir });
  await waitFor(() => received.find((message) => message.method === "thread/started"));
  await request(7, "turn/start", { input: [{ type: "text", text: "user" }] });
  await waitFor(() => received.find((message) => message.method === "turn/completed"));

  ws.close();
  const notifications = received.filter((message) => message.method).map((message) => message.method);
  assert.ok(notifications.includes("thread/started"));
  assert.ok(notifications.includes("item/agentMessage/delta"));
  assert.ok(notifications.includes("item/started"));
  assert.ok(notifications.includes("thread/tokenUsage/updated"));
  const clientMethods = readState(workspace.stateDir).fixtures.codex.protocolEvents
    .filter((event) => event.event === "client-message")
    .map((event) => event.message.method);
  assert.deepEqual(clientMethods.slice(0, 8), [
    "initialize",
    "initialized",
    "mcpServerStatus/list",
    "config/value/delete",
    "config/value/write",
    "config/mcpServer/reload",
    "thread/start",
    "turn/start",
  ]);
});

test("bridge boots, registers Discord MCP, removes stale MCP, and completes one allowed text turn", async () => {
  const workspace = createBridgeWorkspace();
  const codex = await startFakeCodexServer(workspace, {
    channelId: "channel-id",
    staleMcpName: "discord-stale",
    turns: [{ delta: "Codex response" }],
  });
  const bridge = startBridge(workspace, { port: codex.port });

  await bridge.waitForOutput(/Codex-Discord bridge running/, 7000);
  injectDiscordMessage(workspace, { content: "hello codex" });
  const state = await waitForState(workspace, (nextState) => nextState.fixtures.discord.sends.length === 1, 5000);

  assert.equal(state.fixtures.discord.sends[0].content, "Codex response");
  assert.equal(state.fixtures.discord.logins[0].token, "bot-token");
  assert.equal(state.fixtures.discord.ready.length, 1);
  assert.equal(state.fixtures.discord.channelCacheGets[0].id, "channel-id");
  assert.ok(state.fixtures.discord.typing.length >= 1);
  const methods = state.fixtures.codex.protocolEvents
    .filter((event) => event.event === "client-message")
    .map((event) => event.message.method);
  assert.deepEqual(
    methods.filter(Boolean),
    [
      "initialize",
      "initialized",
      "mcpServerStatus/list",
      "config/value/delete",
      "config/value/write",
      "config/mcpServer/reload",
      "mcpServerStatus/list",
      "thread/start",
      "turn/start",
      "turn/start",
    ],
  );
  await bridge.stop();
});

test("bridge covers channel fetch, filtering, fallback splitting, MCP reply suppression, and token-usage nickname PATCH", async () => {
  const workspace = createBridgeWorkspace();
  const longText = "x".repeat(2001);
  const seed = readState(workspace.stateDir);
  seed.fixtures.discord.channelCacheMiss = true;
  writeState(seed, workspace.stateDir);
  const codex = await startFakeCodexServer(workspace, {
    channelId: "channel-id",
    turns: [
      { delta: longText },
      { delta: "suppressed", mcpReply: true },
      { delta: "usage done", tokenUsage: { last: { inputTokens: 42 }, modelContextWindow: 100 } },
    ],
  });
  const bridge = startBridge(workspace, { port: codex.port });

  await bridge.waitForOutput(/Listening in #channel-channel-id/, 7000);
  injectDiscordMessage(workspace, { author: { id: "other-user" }, content: "ignore me" });
  injectDiscordMessage(workspace, { channelId: "other-channel", content: "ignore channel" });
  injectDiscordMessage(workspace, { author: { bot: true }, content: "ignore bot" });
  injectDiscordMessage(workspace, { content: "split this" });
  await waitForState(workspace, (nextState) => nextState.fixtures.discord.sends.length === 2, 5000);
  injectDiscordMessage(workspace, { content: "mcp will reply" });
  await waitForState(workspace, (nextState) => nextState.fixtures.discord.deliveredMessages.length >= 5, 5000);
  await new Promise((resolve) => setTimeout(resolve, 150));
  injectDiscordMessage(workspace, { content: "usage" });
  const state = await waitForState(
    workspace,
    (nextState) => nextState.fixtures.discord.sends.length === 3 && nextState.fixtures.discord.nicknamePatches.length === 1,
    5000,
  );

  assert.equal(state.fixtures.discord.channelFetches[0].id, "channel-id");
  assert.equal(state.fixtures.discord.sends[0].content.length, 2000);
  assert.equal(state.fixtures.discord.sends[1].content.length, 1);
  assert.equal(state.fixtures.discord.sends[2].content, "usage done");
  assert.match(state.fixtures.discord.nicknamePatches[0].nick, /42%/);
  await bridge.stop();
});

test("bridge exits on login failure, app-server exit, websocket close, and startup without a thread id", async () => {
  const loginWorkspace = createBridgeWorkspace();
  let state = readState(loginWorkspace.stateDir);
  state.fixtures.discord.failures.login = "login failed";
  writeState(state, loginWorkspace.stateDir);
  const loginCodex = await startFakeCodexServer(loginWorkspace);
  const loginBridge = startBridge(loginWorkspace, { port: loginCodex.port });
  const loginResult = await loginBridge.closed;
  assert.notEqual(loginResult.exitCode, 0);
  assert.match(loginResult.stderr, /login failed/);

  const appExitWorkspace = createBridgeWorkspace();
  state = readState(appExitWorkspace.stateDir);
  state.fixtures.codex.servers["65530"] = { ready: true, exitImmediately: true, exitCode: 7 };
  writeState(state, appExitWorkspace.stateDir);
  const appExitBridge = startBridge(appExitWorkspace, { port: 65530 });
  const appExitResult = await appExitBridge.closed;
  assert.notEqual(appExitResult.exitCode, 0);
  assert.match(appExitResult.stderr, /Codex app-server exited with code 7/);

  const closeWorkspace = createBridgeWorkspace();
  const closeCodex = await startFakeCodexServer(closeWorkspace, { closeAfterInitialize: true });
  const closeBridge = startBridge(closeWorkspace, { port: closeCodex.port });
  const closeResult = await closeBridge.closed;
  assert.notEqual(closeResult.exitCode, 0);
  assert.match(closeResult.stderr, /WebSocket closed/);

  const noThreadWorkspace = createBridgeWorkspace();
  const noThreadCodex = await startFakeCodexServer(noThreadWorkspace, { omitThreadStarted: true });
  const noThreadBridge = startBridge(noThreadWorkspace, { port: noThreadCodex.port });
  const noThreadResult = await noThreadBridge.closed;
  assert.notEqual(noThreadResult.exitCode, 0);
  assert.match(noThreadResult.stderr, /Failed to get thread ID from server/);
});

test("bridge fixture resolves ws from the harness NODE_PATH before launch", async () => {
  const workspace = createBridgeWorkspace();

  const result = await runPreloadProbe(workspace, "console.log(require.resolve('ws'))");

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /node_modules\/ws\/index\.js/);
});

async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for condition");
}
