import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
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

test("fake Codex app-server supports active-turn controls and approval requests", async () => {
  const workspace = createBridgeWorkspace();
  const codex = await startFakeCodexServer(workspace, {
    approvals: true,
    compactComplete: true,
    steer: ["success", "failure"],
  });
  const ws = new WebSocket(`ws://127.0.0.1:${codex.port}`);
  await once(ws, "open");
  const received = [];
  ws.on("message", (data) => received.push(JSON.parse(data.toString())));

  const request = async (id, method, params) => {
    ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    return await waitFor(() => received.find((message) => message.id === id));
  };

  await request(1, "initialize", {});
  await request(2, "thread/start", { cwd: workspace.repoDir });
  await waitFor(() => received.find((message) => message.method === "thread/started"));
  await request(3, "turn/start", { input: [{ type: "text", text: "user" }] });
  const approvalMethods = [
    "fileChangeRequestApproval",
    "execCommandApproval",
    "permissionsRequestApproval",
    "toolRequestUserInput",
  ];
  for (const method of approvalMethods) {
    const message = await waitFor(() => received.find((entry) => entry.method === method));
    ws.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: method === "toolRequestUserInput" ? { cancelled: true } : { approved: true } }));
  }
  const steerOk = await request(4, "turn/steer", { expectedTurnId: "active-turn" });
  const steerFailed = await request(5, "turn/steer", { expectedTurnId: "stale-turn" });
  await request(6, "thread/compact/start", { threadId: "thread-1" });
  await request(7, "thread/archive", { threadId: "thread-1" });

  ws.close();
  assert.deepEqual(steerOk.result, {});
  assert.equal(steerFailed.error.message, "stale turn");
  assert.ok(received.some((message) => message.method === "item/completed" && message.params?.item?.type === "contextCompaction"));
  const clientMethods = readState(workspace.stateDir).fixtures.codex.protocolEvents
    .filter((event) => event.event === "client-message")
    .map((event) => event.message.method);
  assert.ok(clientMethods.includes("thread/compact/start"));
  assert.ok(clientMethods.includes("thread/archive"));
  assert.ok(clientMethods.includes("turn/steer"));
});

test("bridge boots, registers Discord MCP, removes stale MCP, and completes one allowed text turn", async () => {
  const workspace = createBridgeWorkspace();
  const codex = await startFakeCodexServer(workspace, {
    channelId: "channel-id",
    staleMcpName: "discord-stale",
    turns: [{ delta: "Codex response" }],
  });
  const bridge = startBridge(workspace, { port: codex.port });

  await bridge.waitForOutput(/Listening in #channel-channel-id/, 7000);
  const state = await injectMessageUntil(
    workspace,
    { content: "hello codex", id: "hello-codex" },
    (nextState) => nextState.fixtures.discord.sends.length === 1,
    5000,
  );

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
  const threadStart = state.fixtures.codex.protocolEvents
    .filter((event) => event.event === "client-message")
    .map((event) => event.message)
    .find((message) => message.method === "thread/start");
  assert.match(threadStart.params.developerInstructions, /Use ONLY the MCP server named "discord-channel-id"/);
  const bootstrapTurn = state.fixtures.codex.protocolEvents
    .filter((event) => event.event === "client-message")
    .map((event) => event.message)
    .find((message) =>
      message.method === "turn/start" &&
      message.params?.input?.[0]?.text?.includes("Use ONLY the MCP server named \"discord-channel-id\""),
    );
  assert.ok(bootstrapTurn);
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
  await injectMessageUntil(
    workspace,
    { author: { id: "other-user" }, content: "ignore me", id: "ignore-user" },
    (nextState) => nextState.fixtures.discord.deliveredMessages.some((message) => message.id === "ignore-user"),
    5000,
  );
  await injectMessageUntil(
    workspace,
    { channelId: "other-channel", content: "ignore channel", id: "ignore-channel" },
    (nextState) => nextState.fixtures.discord.deliveredMessages.some((message) => message.id === "ignore-channel"),
    5000,
  );
  await injectMessageUntil(
    workspace,
    { author: { bot: true }, content: "ignore bot", id: "ignore-bot" },
    (nextState) => nextState.fixtures.discord.deliveredMessages.some((message) => message.id === "ignore-bot"),
    5000,
  );
  await injectMessageUntil(
    workspace,
    { content: "split this", id: "split-message" },
    (nextState) => nextState.fixtures.discord.sends.length === 2,
    5000,
  );
  await injectMessageUntil(
    workspace,
    { content: "mcp will reply", id: "mcp-message" },
    (nextState) => nextState.fixtures.discord.deliveredMessages.some((message) => message.id === "mcp-message"),
    5000,
  );
  await new Promise((resolve) => setTimeout(resolve, 150));
  const state = await injectMessageUntil(
    workspace,
    { content: "usage", id: "usage-message" },
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

test("bridge text fallback is opt-in for completed assistant items without MCP reply", async () => {
  const flagged = createBridgeWorkspace();
  const flaggedCodex = await startFakeCodexServer(flagged, {
    channelId: "channel-id",
    turns: [
      {
        completedItem: { type: "agentMessage", content: [{ text: "completed GLM response" }] },
      },
      {
        delta: "streamed GLM response",
        completedItem: { type: "agentMessage", text: "completed stream copy" },
      },
      {
        completedItem: {
          type: "message",
          message: {
            role: "assistant",
            content: [{ text: "message field GLM response" }],
          },
        },
      },
    ],
  });
  const flaggedBridge = startBridge(flagged, {
    port: flaggedCodex.port,
    env: { CODEX_BRIDGE_TEXT_REPLY_FALLBACK: "1" },
  });

  await flaggedBridge.waitForOutput(/Listening in #channel-channel-id/, 7000);
  await injectMessageUntil(
    flagged,
    { content: "no deltas", id: "no-deltas" },
    (nextState) => nextState.fixtures.discord.sends.length === 1,
    5000,
  );
  await injectMessageUntil(
    flagged,
    { content: "completed before turn", id: "completed-before-turn" },
    (nextState) => nextState.fixtures.discord.sends.length === 2,
    5000,
  );
  await injectMessageUntil(
    flagged,
    { content: "message field", id: "message-field" },
    (nextState) => nextState.fixtures.discord.sends.length === 3,
    5000,
  );
  await flaggedBridge.waitForOutput(/\[text-reply-fallback\] completed item.type=agentMessage/, 5000);

  const flaggedState = readState(flagged.stateDir);
  assert.equal(flaggedState.fixtures.discord.sends[0].content, "completed GLM response");
  assert.equal(flaggedState.fixtures.discord.sends[1].content, "streamed GLM response");
  assert.equal(flaggedState.fixtures.discord.sends[2].content, "message field GLM response");
  await flaggedBridge.stop();

  const unflagged = createBridgeWorkspace();
  const unflaggedCodex = await startFakeCodexServer(unflagged, {
    channelId: "channel-id",
    turns: [
      {
        delta: "old path stays silent",
        completedItem: { type: "agentMessage", text: "old path completed" },
      },
    ],
  });
  const unflaggedBridge = startBridge(unflagged, { port: unflaggedCodex.port });

  await unflaggedBridge.waitForOutput(/Listening in #channel-channel-id/, 7000);
  await injectMessageUntil(
    unflagged,
    { content: "old path", id: "old-path" },
    (nextState) => nextState.fixtures.discord.deliveredMessages.some((message) => message.id === "old-path"),
    5000,
  );
  await new Promise((resolve) => setTimeout(resolve, 150));

  assert.equal(readState(unflagged.stateDir).fixtures.discord.sends.length, 0);
  await unflaggedBridge.stop();
});

test("bridge ignores project-channel messages that mention the root bot", async () => {
  const workspace = createBridgeWorkspace();
  const codex = await startFakeCodexServer(workspace, {
    channelId: "channel-id",
    turns: [{ delta: "should not respond" }],
  });
  const bridge = startBridge(workspace, {
    port: codex.port,
    rootBotAppId: "root-bot-app-id",
  });

  await bridge.waitForOutput(/Listening in #channel-channel-id/, 7000);
  await injectMessageUntil(
    workspace,
    { content: "<@root-bot-app-id> list sessions", id: "root-mention" },
    (nextState) => nextState.fixtures.discord.deliveredMessages.some((message) => message.id === "root-mention"),
    5000,
  );
  await new Promise((resolve) => setTimeout(resolve, 150));

  const state = readState(workspace.stateDir);
  const userTurns = state.fixtures.codex.protocolEvents
    .filter((event) => event.event === "client-message")
    .map((event) => event.message)
    .filter((message) =>
      message.method === "turn/start" &&
      !message.params?.input?.[0]?.text?.startsWith("You are communicating with the user via Discord")
    );
  assert.equal(userTurns.length, 0);
  assert.equal(state.fixtures.discord.sends.length, 0);
  await bridge.stop();
});

test("bridge logs failed nickname PATCH responses", async () => {
  const workspace = createBridgeWorkspace();
  const seed = readState(workspace.stateDir);
  seed.fixtures.discord.restFailures = [
    { status: 403, body: { message: "missing permissions" } },
  ];
  writeState(seed, workspace.stateDir);
  const codex = await startFakeCodexServer(workspace, {
    turns: [
      { delta: "usage done", tokenUsage: { last: { inputTokens: 42 }, modelContextWindow: 100 } },
    ],
  });
  const bridge = startBridge(workspace, { port: codex.port });

  await bridge.waitForOutput(/Listening in #channel-channel-id/, 7000);
  await injectMessageUntil(
    workspace,
    { content: "usage", id: "failed-nickname-usage-message" },
    (nextState) => nextState.fixtures.discord.sends.some((send) => send.content === "usage done"),
    5000,
  );
  await bridge.waitForOutput(/Nickname update failed: Discord API 403.*missing permissions/, 5000);
  const state = readState(workspace.stateDir);
  assert.equal(state.fixtures.discord.restFailureUses[0].path, "/api/v10/guilds/guild-id/members/@me");
  await bridge.stop();
});

test("bridge handles approvals, active-turn steer, and stale-turn queue fallback", async () => {
  const workspace = createBridgeWorkspace();
  const codex = await startFakeCodexServer(workspace, {
    steer: ["success", "failure"],
    turns: [
      { approvals: true, delta: "first done", delayMs: 5000, startDelayMs: 10, turnId: "turn-active" },
      { delta: "queued done" },
    ],
  });
  const bridge = startBridge(workspace, { port: codex.port });
  const injectAndWait = async (message, pattern) => {
    let lastError;
    for (let attempt = 0; attempt < 3; attempt++) {
      injectDiscordMessage(workspace, { ...message, id: `${message.id}-${attempt}` });
      try {
        await bridge.waitForOutput(pattern, 2000);
        return;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  };

  await bridge.waitForOutput(/Listening in #channel-channel-id/, 7000);
  injectDiscordMessage(workspace, { content: "first", id: "first" });
  await bridge.waitForOutput(/\[discord\] Allowed User: first/, 5000);
  await new Promise((resolve) => setTimeout(resolve, 250));
  await injectAndWait({ content: "steer succeeds", id: "steer-succeeds" }, /\[steer\] Injected into active turn turn-active/);
  await injectAndWait({ content: "steer queues", id: "steer-queues" }, /\[steer\] Failed \(stale turn\), queuing instead/);
  const state = await waitForState(
    workspace,
    (nextState) => {
      const clientMessages = nextState.fixtures.codex.protocolEvents
        .filter((event) => event.event === "client-message")
        .map((event) => event.message);
      return (
        nextState.fixtures.discord.sends.map((send) => send.content).includes("queued done") &&
        clientMessages.filter((message) => message.result?.approved === true).length >= 2
      );
    },
    15000,
  );
  const typingCountAfterCompletion = state.fixtures.discord.typing.length;
  await new Promise((resolve) => setTimeout(resolve, 150));
  const afterDelay = readState(workspace.stateDir);

  assert.ok(state.fixtures.discord.sends.map((send) => send.content).includes("first done"));
  assert.ok(state.fixtures.discord.sends.map((send) => send.content).includes("queued done"));
  assert.ok(state.fixtures.discord.reactions.map((reaction) => reaction.emoji).includes("\u23f3"));
  assert.ok(state.fixtures.discord.reactionRemovals.length >= 1);
  assert.ok(state.fixtures.discord.typing.length >= 2);
  assert.equal(afterDelay.fixtures.discord.typing.length, typingCountAfterCompletion);
  const clientMessages = state.fixtures.codex.protocolEvents
    .filter((event) => event.event === "client-message")
    .map((event) => event.message);
  assert.match(bridge.stdout, /\[steer\] Injected into active turn turn-active/);
  assert.match(bridge.stdout, /\[steer\] Failed \(stale turn\), queuing instead/);
  assert.ok(
    clientMessages.filter((message) => message.method === "turn/start" && message.params?.input?.[0]?.text !== undefined).length >= 2,
  );
  assert.ok(clientMessages.filter((message) => message.result?.approved === true).length >= 2);
  await bridge.stop();
});

test("bridge handles compact and clear slash commands during an active turn", async () => {
  const workspace = createBridgeWorkspace();
  const codex = await startFakeCodexServer(workspace, {
    compactComplete: true,
    threadIds: ["thread-before-clear", "thread-after-clear"],
    turns: [
      { delta: "busy done", delayMs: 60000, startDelayMs: 10, turnId: "busy-turn" },
      { delta: "after clear done", turnId: "after-clear-turn" },
    ],
  });
  const bridge = startBridge(workspace, { port: codex.port });

  await bridge.waitForOutput(/Listening in #channel-channel-id/, 7000);
  for (let attempt = 0; attempt < 3 && !/\[discord\] Allowed User: busy/.test(bridge.stdout); attempt++) {
    injectDiscordMessage(workspace, { content: "busy", id: `busy-${attempt}` });
    try {
      await bridge.waitForOutput(/\[discord\] Allowed User: busy/, 5000);
    } catch {
      // Retry injection if the previous message landed before the shim poller was ready.
    }
  }
  assert.match(bridge.stdout, /\[discord\] Allowed User: busy/);
  await new Promise((resolve) => setTimeout(resolve, 80));
  const compactState = await injectMessageUntil(
    workspace,
    { content: "/compact", id: "compact-message" },
    (nextState) =>
      nextState.fixtures.discord.sends.some((send) => send.content === "Compaction started.") &&
      nextState.fixtures.discord.sends.some((send) => send.content === "Compaction complete."),
    15000,
  );
  const clearState = await injectMessageUntil(
    workspace,
    { content: "/clear", id: "clear-message" },
    (nextState) =>
      nextState.fixtures.discord.sends.some((send) => send.content.startsWith("Conversation cleared")),
    15000,
  );
  await injectMessageUntil(
    workspace,
    { content: "after clear", id: "after-clear-message" },
    (nextState) => nextState.fixtures.discord.sends.some((send) => send.content === "after clear done"),
    15000,
  );
  await new Promise((resolve) => setTimeout(resolve, 150));
  const state = readState(workspace.stateDir);

  assert.deepEqual(state.fixtures.discord.reactions.map((reaction) => reaction.emoji), ["\ud83d\udd04", "\ud83d\udd04"]);
  assert.ok(!state.fixtures.discord.sends.some((send) => send.content === "busy done"));
  const clientMessageMap = new Map();
  for (const sourceState of [compactState, clearState, state]) {
    for (const event of sourceState.fixtures.codex.protocolEvents) {
      if (event.event === "client-message") {
        clientMessageMap.set(JSON.stringify(event.message), event.message);
      }
    }
  }
  const clientMessages = [...clientMessageMap.values()];
  assert.ok(clientMessages.some((message) => message.method === "turn/interrupt"));
  assert.ok(clientMessages.some((message) => message.method === "thread/archive"));
  assert.equal(clientMessages.filter((message) => message.method === "thread/start").length, 2);
  const mcpWrite = clientMessages.find((message) => message.method === "config/value/write");
  assert.equal(mcpWrite.params.keyPath, "mcp_servers.discord-channel-id");
  assert.equal(mcpWrite.params.value.env.CHANNEL_ID, "channel-id");
  const threadStarts = clientMessages.filter((message) => message.method === "thread/start");
  assert.equal(
    threadStarts.filter((message) =>
      message.params?.developerInstructions?.includes("Use ONLY the MCP server named \"discord-channel-id\""),
    ).length,
    2,
  );
  assert.equal(clientMessages.filter((message) =>
    message.method === "turn/start" &&
    message.params?.input?.[0]?.text?.includes("Use ONLY the MCP server named \"discord-channel-id\""),
  ).length, 2);
  await bridge.stop();
});

test("bridge sends the bootstrap instruction turn after idle compact completion", async () => {
  const workspace = createBridgeWorkspace();
  const codex = await startFakeCodexServer(workspace, {
    compactComplete: true,
  });
  const bridge = startBridge(workspace, { port: codex.port });

  await bridge.waitForOutput(/Listening in #channel-channel-id/, 7000);
  await injectMessageUntil(
    workspace,
    { content: "/compact", id: "idle-compact-message" },
    (nextState) => nextState.fixtures.discord.sends.some((send) => send.content === "Compaction complete."),
    15000,
  );
  const state = readState(workspace.stateDir);
  const bootstrapTurns = state.fixtures.codex.protocolEvents
    .filter((event) => event.event === "client-message")
    .map((event) => event.message)
    .filter((message) =>
      message.method === "turn/start" &&
      message.params?.input?.[0]?.text?.includes("Use ONLY the MCP server named \"discord-channel-id\""),
    );

  assert.equal(bootstrapTurns.length, 2);
  await bridge.stop();
});

test("bridge restarts its own Codex session from slash command", async () => {
  const workspace = createBridgeWorkspace();
  fs.writeFileSync(
    path.join(workspace.repoDir, "registry.json"),
    `${JSON.stringify({
      discord_user_id: "allowed-user-id",
      guild_id: "guild-id",
      pool: [
        { id: "bot1", app_id: "root-bot-app-id", token: "root-token", state_dir: "~/.claude/channels/discord", assigned_to: null },
        { id: "bot2", app_id: "bot-app-id", token: "bot-token", state_dir: "~/.claude/channels/discord2", assigned_to: "alpha" },
      ],
      projects: {
        alpha: {
          path: workspace.repoDir,
          bot_id: "bot2",
          screen_name: "alpha",
          channel_id: "channel-id",
          type: "codex",
          ws_port: 18342,
          pid: process.pid,
          session_id: null,
        },
      },
    }, null, 2)}\n`,
  );
  const codex = await startFakeCodexServer(workspace);
  const bridge = startBridge(workspace, { port: codex.port });

  await bridge.waitForOutput(/Listening in #channel-channel-id/, 7000);
  await injectMessageUntil(
    workspace,
    { content: "/restart", id: "restart-message" },
    (nextState) =>
      nextState.fixtures.discord.sends.some((send) => send.content.startsWith("Restarting session")) &&
      nextState.fixtures.discord.reactions.some((reaction) => reaction.emoji === "🔄"),
    5000,
  );
  const result = await bridge.closed;
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  const state = await waitForState(
    workspace,
    (nextState) => Boolean(nextState.fixtures.tmux.sessions.alpha),
    5000,
  );

  assert.equal(state.fixtures.tmux.sessions.alpha.bridgeCommand, "node scripts/codex-bridge.js");
  assert.equal(state.fixtures.tmux.sessions.alpha.env.CHANNEL_ID, "channel-id");
});

test("bridge stops typing after a non-retryable Codex error", async () => {
  const workspace = createBridgeWorkspace();
  const codex = await startFakeCodexServer(workspace, {
    turns: [{ error: "model unavailable", complete: false }],
  });
  const bridge = startBridge(workspace, { port: codex.port });

  await bridge.waitForOutput(/Listening in #channel-channel-id/, 7000);
  let failed;
  let lastError;
  for (let attempt = 0; attempt < 3 && !failed; attempt++) {
    injectDiscordMessage(workspace, { content: "fail this turn", id: `fail-this-turn-${attempt}` });
    try {
      failed = await waitForState(
        workspace,
        (nextState) => nextState.fixtures.discord.sends.some((send) => send.content === "**Error:** model unavailable"),
        5000,
      );
    } catch (error) {
      lastError = error;
    }
  }
  if (!failed) throw lastError;
  const typingCountAfterFailure = failed.fixtures.discord.typing.length;
  await new Promise((resolve) => setTimeout(resolve, 150));
  const afterDelay = readState(workspace.stateDir);

  assert.ok(typingCountAfterFailure >= 1);
  assert.equal(afterDelay.fixtures.discord.typing.length, typingCountAfterFailure);
  await bridge.stop();
});

test("bridge warns on stale MCP removal failure and records diagnostics for MCP registration failure", async () => {
  const staleWorkspace = createBridgeWorkspace();
  const staleCodex = await startFakeCodexServer(staleWorkspace, {
    failStaleMcpRemoval: "delete failed",
    staleMcpName: "discord-stale",
  });
  const staleBridge = startBridge(staleWorkspace, { port: staleCodex.port });

  await staleBridge.waitForOutput(/Warning: could not clean stale MCP servers: delete failed/, 7000);
  await staleBridge.waitForOutput(/Codex-Discord bridge running/, 7000);
  const staleState = readState(staleWorkspace.stateDir);
  assert.ok(
    staleState.fixtures.codex.protocolEvents.some(
      (event) => event.message?.method === "config/value/delete" && event.message.params?.keyPath === "mcp_servers.discord-stale",
    ),
  );
  assert.ok(
    staleState.fixtures.codex.protocolEvents.some(
      (event) => event.message?.method === "config/value/write" && event.message.params?.keyPath === "mcp_servers.discord-channel-id",
    ),
  );
  await staleBridge.stop();

  const registrationWorkspace = createBridgeWorkspace();
  const registrationCodex = await startFakeCodexServer(registrationWorkspace, {
    failMcpRegistration: "write failed",
  });
  const registrationBridge = startBridge(registrationWorkspace, { port: registrationCodex.port });
  const registrationResult = await registrationBridge.closed;

  assert.notEqual(registrationResult.exitCode, 0);
  assert.match(registrationResult.stderr, /Fatal:/);
  assert.match(registrationResult.stderr, /write failed/);
  const command = readState(registrationWorkspace.stateDir).commands.at(-1);
  assert.equal(command.exitCode, registrationResult.exitCode);
  assert.match(command.stderr, /write failed/);
});

test("bridge records diagnostics when Discord send fails", async () => {
  const workspace = createBridgeWorkspace();
  const seed = readState(workspace.stateDir);
  seed.fixtures.discord.failures.send = "send failed";
  writeState(seed, workspace.stateDir);
  const codex = await startFakeCodexServer(workspace, {
    turns: [{ delta: "cannot send" }],
  });
  const bridge = startBridge(workspace, { port: codex.port });

  await bridge.waitForOutput(/Listening in #channel-channel-id/, 7000);
  injectDiscordMessage(workspace, { content: "trigger send failure" });
  const result = await bridge.closed;

  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /send failed/);
  const state = readState(workspace.stateDir);
  assert.equal(state.fixtures.discord.sendFailures[0].channelId, "channel-id");
  assert.equal(state.fixtures.discord.sendFailures[0].content, "cannot send");
  assert.match(state.commands.at(-1).stderr, /send failed/);
});

test("bridge builds Codex input for empty messages and image, text, binary, and failed attachments", async () => {
  const workspace = createBridgeWorkspace();
  const seed = readState(workspace.stateDir);
  seed.fixtures.discord.attachments["https://cdn.discordapp.com/attachments/channel/message/notes.txt"] = {
    body: "line one\nline two",
    contentType: "text/plain",
  };
  seed.fixtures.discord.attachments["https://cdn.discordapp.com/attachments/channel/message/archive.bin"] = {
    body: "binary body",
    contentType: "application/octet-stream",
  };
  writeState(seed, workspace.stateDir);
  const codex = await startFakeCodexServer(workspace, {
    turns: [{ delta: "attachments done" }],
  });
  const bridge = startBridge(workspace, { port: codex.port });

  await bridge.waitForOutput(/Listening in #channel-channel-id/, 7000);
  await injectMessageUntil(
    workspace,
    { content: "   ", id: "empty-message" },
    (nextState) => nextState.fixtures.discord.deliveredMessages.some((message) => message.id === "empty-message"),
    5000,
  );
  await new Promise((resolve) => setTimeout(resolve, 100));
  const attachmentMessage = {
    id: "attachment-message",
    content: "",
    attachments: [
      {
        contentType: "image/png",
        name: "diagram.png",
        size: 123,
        url: "https://cdn.discordapp.com/attachments/channel/message/diagram.png",
      },
      {
        contentType: "text/plain",
        name: "notes.txt",
        size: 17,
        url: "https://cdn.discordapp.com/attachments/channel/message/notes.txt",
      },
      {
        contentType: "application/octet-stream",
        name: "archive.bin",
        size: 11,
        url: "https://cdn.discordapp.com/attachments/channel/message/archive.bin",
      },
      {
        contentType: "text/plain",
        name: "missing.txt",
        size: 7,
        url: "https://cdn.discordapp.com/attachments/channel/message/missing.txt",
      },
    ],
  };
  const state = await injectMessageUntil(
    workspace,
    attachmentMessage,
    (nextState) =>
      nextState.fixtures.discord.sends.some((send) => send.content === "attachments done") &&
      nextState.fixtures.codex.protocolEvents.some((event) =>
        event.event === "client-message" &&
        event.message.method === "turn/start" &&
        event.message.params?.input?.[0]?.type === "image",
      ),
    15000,
  );

  const userTurns = state.fixtures.codex.protocolEvents
    .filter((event) => event.event === "client-message" && event.message.method === "turn/start")
    .map((event) => event.message.params.input)
    .filter((input) => !input[0]?.text?.startsWith("You are communicating with the user via Discord"));
  assert.equal(userTurns.length, 1);
  assert.equal(userTurns[0][0].type, "image");
  assert.equal(userTurns[0][0].url, "https://cdn.discordapp.com/attachments/channel/message/diagram.png");
  assert.match(userTurns[0][1].text, /--- File: notes\.txt ---\nline one\nline two/);
  assert.match(userTurns[0][2].text, /\.discord-attachments/);
  assert.match(userTurns[0][2].text, /archive\.bin/);
  assert.deepEqual(
    state.fixtures.discord.attachmentFetches.map((entry) => entry.url).sort(),
    [
      "https://cdn.discordapp.com/attachments/channel/message/archive.bin",
      "https://cdn.discordapp.com/attachments/channel/message/missing.txt",
      "https://cdn.discordapp.com/attachments/channel/message/notes.txt",
    ],
  );
  const attachmentDir = path.join(workspace.repoDir, ".discord-attachments");
  assert.equal(fs.existsSync(attachmentDir), true);
  assert.ok(fs.readdirSync(attachmentDir).some((file) => file.endsWith("-archive.bin")));
  await bridge.stop();
});

test("bridge transcribes audio attachments by default", async () => {
  const workspace = createBridgeWorkspace();
  const seed = readState(workspace.stateDir);
  seed.fixtures.discord.attachments["https://cdn.discordapp.com/attachments/channel/message/voice-message.ogg"] = {
    body: "fixture audio body",
    contentType: "audio/ogg",
  };
  seed.fixtures.discord.attachments["https://cdn.discordapp.com/attachments/channel/message/notes.txt"] = {
    body: "text attachment",
    contentType: "text/plain",
  };
  seed.fixtures.whisper.transcriptions["voice-message.ogg"] = "please add audio support";
  writeState(seed, workspace.stateDir);

  const codex = await startFakeCodexServer(workspace, {
    turns: [{ delta: "transcription done" }],
  });
  const bridge = startBridge(workspace, { port: codex.port });

  await bridge.waitForOutput(/Listening in #channel-channel-id/, 7000);
  const state = await injectMessageUntil(
    workspace,
    {
      id: "voice-message",
      content: "some context",
      attachments: [
        {
          contentType: "audio/ogg",
          name: "voice-message.ogg",
          size: 399925,
          url: "https://cdn.discordapp.com/attachments/channel/message/voice-message.ogg",
        },
        {
          contentType: "text/plain",
          name: "notes.txt",
          size: 15,
          url: "https://cdn.discordapp.com/attachments/channel/message/notes.txt",
        },
      ],
    },
    (nextState) =>
      nextState.fixtures.discord.sends.some((send) => send.content === "transcription done") &&
      nextState.fixtures.whisper.invocations.length === 1,
    15000,
  );

  const userTurns = state.fixtures.codex.protocolEvents
    .filter((event) => event.event === "client-message" && event.message.method === "turn/start")
    .map((event) => event.message.params.input)
    .filter((input) => !input[0]?.text?.startsWith("You are communicating with the user via Discord"));
  assert.equal(userTurns.length, 1);
  assert.equal(userTurns[0][0].text, "some context");
  assert.match(userTurns[0][1].text, /--- Audio transcription: voice-message\.ogg ---\nplease add audio support/);
  assert.match(userTurns[0][2].text, /--- File: notes\.txt ---\ntext attachment/);
  assert.equal(userTurns[0].some((part) => part.text?.includes(".discord-attachments")), false);
  assert.equal(state.fixtures.whisper.invocations[0].inputExists, true);
  assert.deepEqual(
    state.fixtures.discord.attachmentFetches.map((entry) => entry.url).sort(),
    [
      "https://cdn.discordapp.com/attachments/channel/message/notes.txt",
      "https://cdn.discordapp.com/attachments/channel/message/voice-message.ogg",
    ],
  );
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

async function injectMessageUntil(workspace, message, predicate, timeoutMs = 5000) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    const id = message.id ?? `message-${attempt}`;
    const state = readState(workspace.stateDir);
    const alreadyKnown =
      state.fixtures.discord.injectedMessages.some((entry) => entry.id === id) ||
      state.fixtures.discord.deliveredMessages.some((entry) => entry.id === id);
    if (!alreadyKnown) {
      injectDiscordMessage(workspace, { ...message, id });
    }
    try {
      return await waitForState(workspace, predicate, timeoutMs);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}
