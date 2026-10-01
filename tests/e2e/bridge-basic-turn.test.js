import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import WebSocket from "ws";

import {
  createBridgeWorkspace,
  injectDiscordMessage,
  injectDiscordReaction,
  runPreloadProbe,
  startFakeCodexServer,
  waitForState,
} from "./support/bridge.js";
import { runRouterCli, startBridge } from "./support/router.js";
import { readState, seedRegistry, updateState, writeState } from "./support/state.js";
import { cleanup } from "./support/teardown.js";

test.afterEach(async () => {
  await cleanup();
});

// The fake gateway's bot user, which the Router logs in as: the root bot.
const ROOT_BOT_USER_ID = "fixture-bot-user-id";
// The first webhook the fake Discord creates, `alpha`'s Project Identity.
const ALPHA_WEBHOOK_ID = "fake-webhook-1";
// The fake webhook token is spelled in parts because router.test.js
// scans every Test Workspace file, including this copied source, for that token.
const ALPHA_WEBHOOK_PATH = `/api/v10/webhooks/fake-webhook-1/${"fake-webhook-"}token-1`;

// Messages the Router posted through alpha's webhook.
function webhookReplies(state) {
  return state.fixtures.discord.messages.filter((message) => message.webhookId === ALPHA_WEBHOOK_ID);
}

function replyContents(state) {
  return webhookReplies(state).map((message) => message.content);
}

// Reactions the Router added as the root bot, emoji decoded from the REST path.
function botReactions(state) {
  return state.fixtures.discord.reactions.map(({ messageId, emoji }) => [messageId, decodeURIComponent(emoji)]);
}

function readReadyFile(file) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
}

// Whether the Router holds a connected session for `project`.
async function routerHasSession(workspace, project) {
  const status = await runRouterCli(workspace, ["status"]);
  assert.equal(status.exitCode, 0, status.stderr);
  return new RegExp(`\\n  project ${project} scope=`).test(status.stdout);
}

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

test("bridge passes Codex config overrides to app-server", async () => {
  const workspace = createBridgeWorkspace();
  const codex = await startFakeCodexServer(workspace);
  const bridge = await startBridge(workspace, {
    port: codex.port,
    env: {
      CODEX_MODEL: "gpt-5.6-sol",
      CODEX_REASONING_EFFORT: "high",
      CODEX_SERVICE_TIER: "priority",
    },
  });

  await bridge.waitForOutput(/Starting codex app-server .* model=gpt-5\.6-sol reasoning=high service_tier=priority/, 7000);
  const state = await waitForState(
    workspace,
    (nextState) => nextState.fixtures.codex.appServerInvocations.length === 1,
    5000,
  );

  assert.deepEqual(state.fixtures.codex.appServerInvocations[0].args, [
    "app-server",
    "-c",
    'model="gpt-5.6-sol"',
    "-c",
    'model_reasoning_effort="high"',
    "-c",
    'service_tier="priority"',
    "--listen",
    `ws://127.0.0.1:${codex.port}`,
  ]);
  await bridge.stop();
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

test("bridge resumes the requested thread but clear starts a fresh conversation", async () => {
  const workspace = createBridgeWorkspace();
  const readyFile = path.join(workspace.tmpDir, "ready");
  const codex = await startFakeCodexServer(workspace);
  const bridge = await startBridge(workspace, {
    port: codex.port,
    env: { CODEX_RESUME_THREAD_ID: "saved-thread", CCDM_CHANNEL_READY_FILE: readyFile },
  });
  await bridge.waitForOutput(/Listening in #alpha/, 7000);
  await waitForState(workspace, () => fs.existsSync(readyFile));
  assert.deepEqual(readReadyFile(readyFile), { ok: true, scope: { channel_id: "channel-id" } });
  const resume = codex.clientMessages.find((m) => m.method === "thread/resume");
  assert.equal(resume.params.threadId, "saved-thread");
  assert.equal(resume.params.cwd, workspace.repoDir);
  assert.ok(!codex.clientMessages.some((m) => m.method === "thread/start"));
  assert.ok(codex.clientMessages.some((m) => m.method === "turn/start" && m.params.threadId === "saved-thread"));
  await injectMessageUntil(workspace, { content: "/clear", id: "clear-resumed" },
    () => codex.clientMessages.some((m) => m.method === "thread/start"), 7000);
  assert.equal(codex.clientMessages.filter((m) => m.method === "thread/resume").length, 1);
  await bridge.stop();
});

test("failed resume never silently starts a fresh conversation", async () => {
  const workspace = createBridgeWorkspace();
  const readyFile = path.join(workspace.tmpDir, "ready");
  const codex = await startFakeCodexServer(workspace, { resumeError: "Saved thread unavailable" });
  const bridge = await startBridge(workspace, {
    port: codex.port,
    env: { CODEX_RESUME_THREAD_ID: "missing-thread", CCDM_CHANNEL_READY_FILE: readyFile },
  });
  await bridge.waitForOutput(/Saved thread unavailable/, 7000);
  await waitForState(workspace, () => fs.existsSync(readyFile));
  // The launcher hears a failed startup, never a ready listener.
  assert.equal(readReadyFile(readyFile).ok, false);
  assert.match(readReadyFile(readyFile).error, /Saved thread unavailable/);
  assert.doesNotMatch(bridge.stdout, /Discord bot logged in/);
  assert.ok(!codex.clientMessages.some((m) => m.method === "thread/start" || m.method === "turn/start"));
  await bridge.stop();
});

test("resumed startup fails when the fresh Discord instructions are rejected", async () => {
  const workspace = createBridgeWorkspace();
  const readyFile = path.join(workspace.tmpDir, "ready");
  const codex = await startFakeCodexServer(workspace, { bootstrapError: "Bootstrap rejected" });
  const bridge = await startBridge(workspace, {
    port: codex.port,
    env: { CODEX_RESUME_THREAD_ID: "saved-thread", CCDM_CHANNEL_READY_FILE: readyFile },
  });
  await bridge.waitForOutput(/Fatal:/, 5000);
  assert.equal((await bridge.closed).exitCode, 1);
  assert.ok(codex.clientMessages.some((m) => m.method === "thread/resume"));
  assert.ok(codex.clientMessages.some((m) => m.method === "turn/start"));
  assert.ok(!codex.clientMessages.some((m) => m.method === "thread/start"));
  assert.match(bridge.stderr, /Bootstrap rejected/);
  assert.equal(readReadyFile(readyFile).ok, false);
  assert.match(readReadyFile(readyFile).error, /Bootstrap rejected/);
  // The bridge never said hello to the Router.
  assert.doesNotMatch(bridge.stdout, /Discord bot logged in/);
  assert.equal(await routerHasSession(workspace, "alpha"), false);
});

test("bridge boots, registers Discord MCP, removes stale MCP, and completes one allowed text turn with opt-in text fallback", async () => {
  const workspace = createBridgeWorkspace();
  const codex = await startFakeCodexServer(workspace, {
    channelId: "channel-id",
    staleMcpName: "discord-stale",
    turns: [{ delta: "Codex response" }],
  });
  const bridge = await startBridge(workspace, {
    port: codex.port,
    env: { CODEX_BRIDGE_TEXT_REPLY_FALLBACK: "1" },
  });

  await bridge.waitForOutput(/Listening in #alpha/, 7000);
  const state = await injectMessageUntil(
    workspace,
    { content: "hello codex", id: "hello-codex" },
    (nextState) => nextState.fixtures.discord.messages.length === 1,
    5000,
  );

  // The text fallback posts through the Router as alpha's webhook, with no
  // context percentage known yet.
  assert.deepEqual(state.fixtures.discord.messages.map(({ channelId, content, username, webhookId }) => ({ channelId, content, username, webhookId })), [
    { channelId: "channel-id", content: "Codex response", username: "alpha-codex", webhookId: "fake-webhook-1" },
  ]);
  // Only the Router logs in to Discord, with the root bot token.
  assert.deepEqual(state.fixtures.discord.logins, [{ token: "root-bot-token" }]);
  assert.equal(state.fixtures.discord.ready.length, 1);
  const status = await runRouterCli(workspace, ["status"]);
  assert.match(status.stdout, /\n  project alpha scope=channel-id connected=/);
  assert.ok(state.fixtures.discord.typing.length >= 1);
  assert.deepEqual([...new Set(state.fixtures.discord.typing.map(({ authorization, channelId }) => `${authorization} ${channelId}`))],
    ["Bot root-bot-token channel-id"]);
  const methods = codex.clientMessages.map((message) => message.method);
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
  const threadStart = codex.clientMessages
    .find((message) => message.method === "thread/start");
  assert.match(threadStart.params.developerInstructions, /Subagents and delegated tasks must return results to their parent agent/);
  assert.doesNotMatch(threadStart.params.developerInstructions, /scope_token/);
  const bootstrapTurn = codex.clientMessages
    .find((message) =>
      message.method === "turn/start" &&
      message.params?.input?.[0]?.text?.includes("Use ONLY the MCP server named \"discord-channel-id\""),
    );
  assert.ok(bootstrapTurn);
  assert.match(bootstrapTurn.params.input[0].text, /scope_token: "[a-f0-9]{32}"/);
  await bridge.stop();
});

test("bridge keeps regular agent deltas private by default", async () => {
  const workspace = createBridgeWorkspace();
  const codex = await startFakeCodexServer(workspace, {
    channelId: "channel-id",
    turns: [{ delta: "sub-agent progress should stay private" }],
  });
  const bridge = await startBridge(workspace, { port: codex.port });

  await bridge.waitForOutput(/Listening in #alpha/, 7000);
  await injectMessageUntil(
    workspace,
    { content: "use a sub agent", id: "private-sub-agent" },
    (nextState) => nextState.fixtures.discord.deliveredMessages.some((message) => message.id === "private-sub-agent"),
    5000,
  );
  await new Promise((resolve) => setTimeout(resolve, 150));

  assert.deepEqual(readState(workspace.stateDir).fixtures.discord.messages, []);
  await bridge.stop();
});

test("bridge accepts project guests from a comma-separated allowlist", async () => {
  const workspace = createBridgeWorkspace();
  const codex = await startFakeCodexServer(workspace, {
    channelId: "channel-id",
    turns: [{ delta: "Guest response" }],
  });
  const bridge = await startBridge(workspace, {
    allowedUserIds: ["allowed-user-id", "222222222222222222"],
    env: { CODEX_BRIDGE_TEXT_REPLY_FALLBACK: "1" },
    port: codex.port,
  });

  await bridge.waitForOutput(/Listening in #alpha/, 7000);
  await injectMessageUntil(
    workspace,
    { author: { id: "333333333333333333" }, content: "ignore outsider", id: "outsider" },
    (nextState) => nextState.fixtures.discord.deliveredMessages.some((message) => message.id === "outsider"),
    5000,
  );
  const state = await injectMessageUntil(
    workspace,
    { author: { id: "222222222222222222" }, content: "guest hello", id: "guest" },
    (nextState) => nextState.fixtures.discord.messages.length === 1,
    5000,
  );

  assert.deepEqual(replyContents(state), ["Guest response"]);
  assert.equal(
    codex.clientMessages.filter((message) => message.method === "turn/start").length,
    2,
  );
  await bridge.stop();
});

test("bridge covers filtering, fallback splitting, MCP reply suppression, and the token-usage percentage on the webhook username", async () => {
  const workspace = createBridgeWorkspace();
  const longText = "x".repeat(2001);
  const codex = await startFakeCodexServer(workspace, {
    channelId: "channel-id",
    turns: [
      { delta: longText },
      { delta: "suppressed", mcpReply: true },
      { delta: "react suppressed", mcpTool: "react" },
      { delta: "usage done", tokenUsage: { last: { inputTokens: 42 }, modelContextWindow: 100 } },
    ],
  });
  const bridge = await startBridge(workspace, {
    port: codex.port,
    env: { CODEX_BRIDGE_TEXT_REPLY_FALLBACK: "1" },
  });

  await bridge.waitForOutput(/Listening in #alpha/, 7000);
  // Each reply lands before its turn ends; the next message must wait for the
  // bridge to go idle, or it is steered into the finished turn.
  await waitForFinishedTurns(bridge, 1); // the transport bootstrap
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
    (nextState) => nextState.fixtures.discord.messages.length === 2,
    5000,
  );
  // The fake records the reply before the Router acknowledges it to the
  // bridge, which ends the turn only then.
  await waitForFinishedTurns(bridge, 2);
  await injectMessageUntil(
    workspace,
    { content: "mcp will reply", id: "mcp-message" },
    (nextState) => nextState.fixtures.discord.deliveredMessages.some((message) => message.id === "mcp-message"),
    5000,
  );
  await waitForFinishedTurns(bridge, 3);
  await injectMessageUntil(
    workspace,
    { content: "mcp will react", id: "react-message" },
    (nextState) => nextState.fixtures.discord.deliveredMessages.some((message) => message.id === "react-message"),
    5000,
  );
  await waitForFinishedTurns(bridge, 4);
  const state = await injectMessageUntil(
    workspace,
    { content: "usage", id: "usage-message" },
    (nextState) => nextState.fixtures.discord.messages.length === 3,
    5000,
  );

  // Ignored messages, suppressed turns, and replies all stayed in alpha's channel and webhook.
  assert.deepEqual(state.fixtures.discord.messages.map(({ channelId, content, username, webhookId }) =>
    ({ channelId, length: content.length, username, webhookId })), [
    { channelId: "channel-id", length: 2000, username: "alpha-codex", webhookId: "fake-webhook-1" },
    { channelId: "channel-id", length: 1, username: "alpha-codex", webhookId: "fake-webhook-1" },
    { channelId: "channel-id", length: 10, username: "alpha-codex · 42%", webhookId: "fake-webhook-1" },
  ]);
  assert.equal(state.fixtures.discord.messages[2].content, "usage done");
  // 42 of a 100-token window is 42%, carried on the reply's username, not a nickname.
  assert.deepEqual(state.fixtures.discord.nicknamePatches, []);
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
  const flaggedBridge = await startBridge(flagged, {
    port: flaggedCodex.port,
    env: { CODEX_BRIDGE_TEXT_REPLY_FALLBACK: "1" },
  });

  await flaggedBridge.waitForOutput(/Listening in #alpha/, 7000);
  // Each fallback reply posts before its turn ends; wait for the bridge to go
  // idle so the next message starts its own turn instead of steering.
  await waitForFinishedTurns(flaggedBridge, 1); // the transport bootstrap
  await injectMessageUntil(
    flagged,
    { content: "no deltas", id: "no-deltas" },
    (nextState) => nextState.fixtures.discord.messages.length === 1,
    5000,
  );
  await waitForFinishedTurns(flaggedBridge, 2);
  await injectMessageUntil(
    flagged,
    { content: "completed before turn", id: "completed-before-turn" },
    (nextState) => nextState.fixtures.discord.messages.length === 2,
    5000,
  );
  await waitForFinishedTurns(flaggedBridge, 3);
  await injectMessageUntil(
    flagged,
    { content: "message field", id: "message-field" },
    (nextState) => nextState.fixtures.discord.messages.length === 3,
    5000,
  );
  await flaggedBridge.waitForOutput(/\[text-reply-fallback\] completed item.type=agentMessage/, 5000);

  const flaggedState = readState(flagged.stateDir);
  assert.deepEqual(replyContents(flaggedState), [
    "completed GLM response",
    "streamed GLM response",
    "message field GLM response",
  ]);
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
  const unflaggedBridge = await startBridge(unflagged, { port: unflaggedCodex.port });

  await unflaggedBridge.waitForOutput(/Listening in #alpha/, 7000);
  await injectMessageUntil(
    unflagged,
    { content: "old path", id: "old-path" },
    (nextState) => nextState.fixtures.discord.deliveredMessages.some((message) => message.id === "old-path"),
    5000,
  );
  await new Promise((resolve) => setTimeout(resolve, 150));

  assert.deepEqual(readState(unflagged.stateDir).fixtures.discord.messages, []);
  await unflaggedBridge.stop();
});

// Turns a Discord message started, without the bridge's bootstrap instruction turns.
function userTurnStarts(codex) {
  return codex.clientMessages.filter((message) =>
    message.method === "turn/start" &&
    !message.params?.input?.[0]?.text?.startsWith("You are communicating with the user via Discord"));
}

test("project-channel messages that mention the root bot reach root, not the project session", async () => {
  const workspace = createBridgeWorkspace();
  seedRegistry(workspace, { discord_user_id: "allowed-user-id", guild_id: "guild-id", root_channels: ["root-channel"], projects: {} });
  const codex = await startFakeCodexServer(workspace, {
    channelId: "channel-id",
    turns: [{ delta: "should not respond" }],
  });
  const rootCodex = await startFakeCodexServer(workspace, { channelId: "root-channel", turns: [{ complete: true }] });
  const bridge = await startBridge(workspace, {
    port: codex.port,
    rootBotAppId: ROOT_BOT_USER_ID,
  });
  const root = await startBridge(workspace, {
    root: true,
    botAppId: ROOT_BOT_USER_ID,
    channelId: "root-channel",
    port: rootCodex.port,
    rootBotAppId: ROOT_BOT_USER_ID,
  });

  await bridge.waitForOutput(/Listening in #alpha/, 7000);
  await root.waitForOutput(/Listening in #root-channel/, 7000);
  await injectMessageUntil(
    workspace,
    { content: "<@fixture-bot-user-id> list sessions", id: "root-mention" },
    () => userTurnStarts(rootCodex).length === 1,
    5000,
  );
  await new Promise((resolve) => setTimeout(resolve, 150));

  assert.equal(userTurnStarts(codex).length, 0);
  const [rootTurn] = userTurnStarts(rootCodex).map((message) => message.params.input[0].text);
  assert.match(rootTurn, /^channel_id: channel-id$/m);
  assert.match(rootTurn, /^message_id: root-mention$/m);
  assert.match(rootTurn, /list sessions$/);
  assert.deepEqual(readState(workspace.stateDir).fixtures.discord.messages, []);
  await bridge.stop();
  await root.stop();
});

test("root bridge accepts registry root channels and mentioned project channels with routing metadata", async () => {
  const workspace = createBridgeWorkspace();
  const registryFile = path.join(workspace.repoDir, "registry.json");
  seedRegistry(workspace, {
    discord_user_id: "allowed-user-id",
    guild_id: "guild-id",
    root_channels: ["root-channel"],
    projects: {
      beta: { type: "codex", channel_id: "project-channel", path: workspace.repoDir, screen_name: "beta_codex" },
    },
  });
  const codex = await startFakeCodexServer(workspace, {
    channelId: "root-channel",
    turns: [{ complete: true }, { complete: true }, { complete: true }],
  });
  const bridge = await startBridge(workspace, {
    root: true,
    botAppId: ROOT_BOT_USER_ID,
    channelId: "root-channel",
    port: codex.port,
    rootBotAppId: ROOT_BOT_USER_ID,
  });

  await bridge.waitForOutput(/Root routing active for 1 configured channel\(s\)/, 7000);
  await injectMessageUntil(
    workspace,
    { channelId: "root-channel", content: "status", id: "root-status" },
    (nextState) => nextState.fixtures.discord.deliveredMessages.some((message) => message.id === "root-status"),
    5000,
  );
  await injectMessageUntil(
    workspace,
    { channelId: "project-channel", content: "status without mention", id: "project-no-mention" },
    (nextState) => nextState.fixtures.discord.deliveredMessages.some((message) => message.id === "project-no-mention"),
    5000,
  );
  await injectMessageUntil(
    workspace,
    { channelId: "project-channel", content: "<@fixture-bot-user-id> codex restart this session with codex", id: "project-mentioned" },
    () => userTurnStarts(codex).length === 2,
    5000,
  );

  const writes = codex.clientMessages.filter((message) => message.method === "config/value/write");
  const rootMcp = writes.find((message) => message.params.keyPath === "mcp_servers.discord-root");
  assert.ok(rootMcp);
  const rootMcpEnv = rootMcp.params.value.env;
  assert.equal(rootMcpEnv.DISCORD_CHANNEL_OVERRIDE, "1");
  // Root's MCP server reaches the Router with root's key; there is no access file.
  assert.equal(rootMcpEnv.CCDM_ROUTER_ROLE, "root");
  assert.equal(rootMcpEnv.CCDM_ROUTER_KEY_FILE, path.join(workspace.routerStateDir, "keys", ".root.key"));
  assert.equal(rootMcpEnv.DISCORD_ACCESS_FILE, undefined);
  assert.match(rootMcpEnv.DISCORD_CHANNEL_SCOPE_SECRET, /^[a-f0-9]{64}$/);
  assert.match(rootMcpEnv.DISCORD_CHANNEL_SCOPE_FILE, /codex-discord-scope-/);

  const userTurns = userTurnStarts(codex);
  assert.equal(userTurns.length, 2);
  assert.match(userTurns[0].params.input[0].text, /channel_id: root-channel/);
  assert.match(userTurns[0].params.input[0].text, /channel_scope_token: [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
  assert.match(userTurns[0].params.input[0].text, /with channel_id and channel_scope_token/);
  assert.doesNotMatch(userTurns[0].params.input[0].text, /reply_channel_id/);
  assert.match(userTurns[1].params.input[0].text, /channel_id: project-channel/);
  assert.match(userTurns[1].params.input[0].text, /codex restart this session with codex/);
  assert.doesNotMatch(userTurns[1].params.input[0].text, /<@fixture-bot-user-id>/);

  // A newly registered project channel reaches root once the Router reloads the registry.
  const registry = JSON.parse(fs.readFileSync(registryFile, "utf8"));
  registry.projects.gamma = { type: "codex", channel_id: "new-project-channel", path: workspace.repoDir, screen_name: "gamma_codex" };
  fs.writeFileSync(registryFile, `${JSON.stringify(registry, null, 2)}\n`);
  await new Promise((resolve) => setTimeout(resolve, 1000));
  await injectMessageUntil(
    workspace,
    { channelId: "new-project-channel", content: "<@fixture-bot-user-id> new channel", id: "new-project-mentioned" },
    () => userTurnStarts(codex).length === 3,
    5000,
  );

  // A deregistered project channel no longer does.
  delete registry.projects.beta;
  fs.writeFileSync(registryFile, `${JSON.stringify(registry, null, 2)}\n`);
  await new Promise((resolve) => setTimeout(resolve, 1000));
  await injectMessageUntil(
    workspace,
    { channelId: "project-channel", content: "<@fixture-bot-user-id> removed channel", id: "removed-project-mentioned" },
    (nextState) => nextState.fixtures.discord.deliveredMessages.some((message) => message.id === "removed-project-mentioned"),
    5000,
  );
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(userTurnStarts(codex).length, 3);
  await bridge.stop();
});

test("bridge never PATCHes a nickname and carries the context percentage on the reply username", async () => {
  const workspace = createBridgeWorkspace();
  // The pool-mode nickname endpoint would fail, as a guild without the permission does.
  const seed = readState(workspace.stateDir);
  seed.fixtures.discord.restFailures = [
    { method: "PATCH", path: "/api/v10/guilds/guild-id/members/@me", status: 403, body: { message: "missing permissions" } },
  ];
  writeState(seed, workspace.stateDir);
  const codex = await startFakeCodexServer(workspace, {
    turns: [
      { delta: "usage done", tokenUsage: { last: { inputTokens: 42 }, modelContextWindow: 100 } },
    ],
  });
  const bridge = await startBridge(workspace, { port: codex.port, env: { CODEX_BRIDGE_TEXT_REPLY_FALLBACK: "1" } });

  await bridge.waitForOutput(/Listening in #alpha/, 7000);
  const state = await injectMessageUntil(
    workspace,
    { content: "usage", id: "failed-nickname-usage-message" },
    (nextState) => nextState.fixtures.discord.messages.length === 1,
    5000,
  );

  // 42 of a 100-token window.
  assert.deepEqual(state.fixtures.discord.messages.map(({ content, username, webhookId }) => ({ content, username, webhookId })), [
    { content: "usage done", username: "alpha-codex · 42%", webhookId: "fake-webhook-1" },
  ]);
  assert.deepEqual(state.fixtures.discord.nicknamePatches, []);
  assert.deepEqual(state.fixtures.discord.restFailureUses ?? [], []);
  assert.doesNotMatch(bridge.stdout + bridge.stderr, /Nickname/i);
  await bridge.stop();
});

test("bridge handles approvals, active-turn steer, and stale-turn queue fallback", async () => {
  const workspace = createBridgeWorkspace();
  const codex = await startFakeCodexServer(workspace, {
    steer: ["success", "failure"],
    turns: [
      { approvals: true, delta: "first done", startDelayMs: 10, turnId: "turn-active", waitForRelease: true },
      { delta: "queued done" },
    ],
  });
  const bridge = await startBridge(workspace, {
    port: codex.port,
    env: { CODEX_BRIDGE_TEXT_REPLY_FALLBACK: "1" },
  });
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

  await bridge.waitForOutput(/Listening in #alpha/, 7000);
  await injectMessageUntil(
    workspace,
    { content: "first", id: "first" },
    (nextState) => codex.clientMessages.some((message) => message.method === "turn/start" && message.params.input?.[0]?.text === "first"),
  );
  await new Promise((resolve) => setTimeout(resolve, 250));
  await injectAndWait({ content: "steer succeeds", id: "steer-succeeds" }, /\[steer\] Injected into active turn turn-active/);
  await injectAndWait({ content: "steer queues", id: "steer-queues" }, /\[steer\] Failed \(stale turn\), queuing instead/);
  codex.releaseTurn("turn-active");
  const state = await waitForState(
    workspace,
    (nextState) => {
      const clientMessages = codex.clientMessages;
      return (
        replyContents(nextState).includes("queued done") &&
        clientMessages.filter((message) => message.result?.approved === true).length >= 2
      );
    },
    15000,
  );
  const typingCountAfterCompletion = state.fixtures.discord.typing.length;
  await new Promise((resolve) => setTimeout(resolve, 150));
  const afterDelay = readState(workspace.stateDir);

  assert.ok(replyContents(state).includes("first done"));
  assert.ok(replyContents(state).includes("queued done"));
  // The queued message's ⏳ is added as the root bot through the Router. (The
  // Router has no reaction-removal op, so the bridge no longer removes it.)
  const hourglass = state.fixtures.discord.reactions.filter((reaction) => decodeURIComponent(reaction.emoji) === "\u23f3");
  assert.ok(hourglass.length >= 1);
  assert.ok(hourglass.every((reaction) => reaction.authorization === "Bot root-bot-token" &&
    reaction.channelId === "channel-id" && reaction.messageId.startsWith("steer-queues-")));
  assert.ok(state.fixtures.discord.typing.length >= 2);
  assert.equal(afterDelay.fixtures.discord.typing.length, typingCountAfterCompletion);
  const clientMessages = codex.clientMessages;
  assert.match(bridge.stdout, /\[steer\] Injected into active turn turn-active/);
  assert.match(bridge.stdout, /\[steer\] Failed \(stale turn\), queuing instead/);
  assert.ok(
    clientMessages.filter((message) => message.method === "turn/start" && message.params?.input?.[0]?.text !== undefined).length >= 2,
  );
  assert.ok(clientMessages.filter((message) => message.result?.approved === true).length >= 2);
  await bridge.stop();
});

test("bridge drains queued messages after Codex reports a different active turn id", async () => {
  const workspace = createBridgeWorkspace();
  const codex = await startFakeCodexServer(workspace, {
    steer: ["failure"],
    turns: [
      {
        delta: "first done",
        startDelayMs: 10,
        turnId: "returned-turn",
        notificationTurnId: "actual-turn",
        omitTurnStarted: true,
        waitForRelease: true,
      },
      { delta: "queued done" },
    ],
  });
  const bridge = await startBridge(workspace, {
    port: codex.port,
    env: { CODEX_BRIDGE_TEXT_REPLY_FALLBACK: "1" },
  });

  await bridge.waitForOutput(/Listening in #alpha/, 7000);
  await injectMessageUntil(
    workspace,
    { content: "first", id: "first-mismatch" },
    (nextState) => codex.clientMessages.some((message) => message.method === "turn/start" && message.params.input?.[0]?.text === "first"),
  );
  await injectMessageUntil(
    workspace,
    { content: "queued after mismatch", id: "queued-after-mismatch" },
    (nextState) => nextState.fixtures.discord.deliveredMessages.some(
      (message) => message.id === "queued-after-mismatch",
    ),
  );
  await bridge.waitForOutput(/\[steer\] Failed \(stale turn\), queuing instead/, 5000);
  codex.releaseTurn("returned-turn");

  const state = await waitForState(
    workspace,
    (nextState) => replyContents(nextState).includes("queued done"),
    10000,
  );
  const replies = replyContents(state);

  assert.ok(replies.includes("first done"));
  assert.ok(replies.includes("queued done"));
  assert.match(bridge.stdout, /\[turn\] accepting active turn id actual-turn/);
  await bridge.stop();
});

test("bridge finishes a mismatched turn that only completes an assistant item", async () => {
  const workspace = createBridgeWorkspace();
  const codex = await startFakeCodexServer(workspace, {
    turns: [
      {
        completedItem: { type: "agentMessage", text: "completed-only reply" },
        notificationTurnId: "actual-turn",
        omitTurnStarted: true,
        turnId: "returned-turn",
      },
      { delta: "queued reply" },
    ],
  });
  const bridge = await startBridge(workspace, {
    port: codex.port,
    env: { CODEX_BRIDGE_TEXT_REPLY_FALLBACK: "1" },
  });

  await bridge.waitForOutput(/Listening in #alpha/, 7000);
  await waitForFinishedTurns(bridge, 1); // the transport bootstrap
  await injectMessageUntil(
    workspace,
    { content: "first", id: "completed-only-mismatch" },
    (nextState) => replyContents(nextState).includes("completed-only reply"),
    5000,
  );
  // The reply posts before the turn ends; the second message must start its own turn.
  await waitForFinishedTurns(bridge, 2);
  const state = await injectMessageUntil(
    workspace,
    { content: "second", id: "after-completed-only" },
    (nextState) => replyContents(nextState).includes("queued reply"),
    5000,
  );
  assert.deepEqual(
    replyContents(state),
    ["completed-only reply", "queued reply"],
  );
  assert.match(bridge.stdout, /accepting active turn id actual-turn for item\/completed/);
  await bridge.stop();
});

test("bridge ignores stale turn notifications before and after the current turn is confirmed", async () => {
  const workspace = createBridgeWorkspace();
  const codex = await startFakeCodexServer(workspace, {
    turns: [
      { delta: "first done", turnId: "turn-a" },
      {
        delta: "second done",
        delayMs: 100,
        startDelayMs: 5,
        turnId: "turn-b",
        notificationsBeforeStart: [
          { method: "turn/completed", params: { turn: { id: "turn-a" } } },
        ],
        notificationsBeforeComplete: [
          { method: "turn/completed", params: { turn: { id: "turn-a" } } },
        ],
      },
    ],
  });
  const bridge = await startBridge(workspace, {
    port: codex.port,
    env: { CODEX_BRIDGE_TEXT_REPLY_FALLBACK: "1" },
  });

  await bridge.waitForOutput(/Listening in #alpha/, 7000);
  await waitForFinishedTurns(bridge, 1); // the transport bootstrap
  await injectMessageUntil(
    workspace,
    { content: "first", id: "first-turn" },
    (state) => replyContents(state).includes("first done"),
    5000,
  );
  // The reply posts before the turn ends; the second message must start its own turn.
  await waitForFinishedTurns(bridge, 2);
  await injectMessageUntil(
    workspace,
    { content: "second", id: "second-turn" },
    (state) => replyContents(state).includes("second done"),
    5000,
  );

  assert.match(bridge.stdout, /ignoring stale turn id turn-a.*active id is turn-b/);
  await bridge.stop();
});

test("bridge queues compact during an active turn and runs it after completion", async () => {
  const workspace = createBridgeWorkspace();
  const codex = await startFakeCodexServer(workspace, {
    compactComplete: true,
    turns: [{ delta: "busy done", startDelayMs: 10, turnId: "busy-turn", waitForRelease: true }],
  });
  const bridge = await startBridge(workspace, {
    port: codex.port,
    env: { CODEX_BRIDGE_TEXT_REPLY_FALLBACK: "1" },
  });

  await bridge.waitForOutput(/Listening in #alpha/, 7000);
  await injectMessageUntil(
    workspace,
    { content: "busy", id: "busy-0" },
    (nextState) => codex.clientMessages.some((message) => message.method === "turn/start" && message.params.input?.[0]?.text === "busy"),
  );
  await new Promise((resolve) => setTimeout(resolve, 80));
  await injectMessageUntil(
    workspace,
    { content: "/compact", id: "compact-message" },
    (nextState) => replyContents(nextState).includes("Compaction queued."),
    5000,
  );
  codex.releaseTurn("busy-turn");
  await waitForState(
    workspace,
    (nextState) => replyContents(nextState).includes("Compaction complete."),
    20000,
  );
  await new Promise((resolve) => setTimeout(resolve, 150));
  const state = readState(workspace.stateDir);

  assert.deepEqual(botReactions(state), [["compact-message", "\ud83d\udd04"]]);
  const clientMessages = codex.clientMessages;
  assert.ok(clientMessages.some((message) => message.method === "thread/compact/start"));
  const mcpWrite = clientMessages.find((message) => message.method === "config/value/write");
  assert.equal(mcpWrite.params.keyPath, "mcp_servers.discord-channel-id");
  // Codex waits out the Router's longest per-op deadline (a 10-minute export).
  assert.equal(mcpWrite.params.value.tool_timeout_sec, 630);
  assert.equal(mcpWrite.params.value.env.CHANNEL_ID, "channel-id");
  assert.match(mcpWrite.params.value.env.DISCORD_REPLY_TOKEN, /^[a-f0-9]{32}$/);
  const bootstrapTurns = clientMessages.filter((message) =>
    message.method === "turn/start" &&
    message.params?.input?.[0]?.text?.includes("Use ONLY the MCP server named \"discord-channel-id\"") &&
    /scope_token: "[a-f0-9]{32}"/.test(message.params.input[0].text),
  );
  assert.ok(bootstrapTurns.length >= 1);
  await bridge.stop();
});

test("bridge pauses new turns and sends queued messages in order after unpause", async () => {
  const workspace = createBridgeWorkspace();
  const codex = await startFakeCodexServer(workspace, {
    turns: [
      { delta: "active done", delayMs: 300, startDelayMs: 10, turnId: "active-turn" },
      { delta: "first queued done", turnId: "first-queued-turn" },
      { delta: "second queued done", turnId: "second-queued-turn" },
    ],
  });
  const bridge = await startBridge(workspace, {
    port: codex.port,
    env: { CODEX_BRIDGE_TEXT_REPLY_FALLBACK: "1" },
  });

  await bridge.waitForOutput(/Listening in #alpha/, 7000);
  await injectMessageUntil(
    workspace,
    { content: "active", id: "active-message" },
    (state) => codex.clientMessages.some((message) => message.method === "turn/start" && message.params.input?.[0]?.text === "active"),
  );
  await injectMessageUntil(
    workspace,
    { content: "/pause", id: "pause-message" },
    (state) => replyContents(state).includes("Bridge paused. New messages will be queued."),
  );
  for (const [id, content] of [
    ["first-queued-message", "first queued"],
    ["second-queued-message", "second queued"],
  ]) {
    await injectMessageUntil(
      workspace,
      { content, id },
      (state) => botReactions(state).some(([messageId, emoji]) => messageId === id && emoji === "⏳"),
    );
  }

  const pausedState = await waitForState(
    workspace,
    (state) => replyContents(state).includes("active done"),
    5000,
  );
  const pausedUserTurns = codex.clientMessages
    .filter((message) => message.method === "turn/start")
    .map((message) => message.params.input?.[0]?.text)
    .filter((text) => text && !text.startsWith("You are communicating with the user via Discord"));
  assert.deepEqual(pausedUserTurns, ["active"]);

  const unpausedState = await injectMessageUntil(
    workspace,
    { content: "/unpause", id: "unpause-message" },
    (state) => replyContents(state).includes("second queued done"),
    5000,
  );
  assert.deepEqual(
    replyContents(unpausedState)
      .filter((content) => ["active done", "first queued done", "second queued done"].includes(content)),
    ["active done", "first queued done", "second queued done"],
  );
  assert.deepEqual(botReactions(unpausedState), [
    ["pause-message", "⏸️"], ["first-queued-message", "⏳"], ["second-queued-message", "⏳"], ["unpause-message", "▶️"],
  ]);
  await bridge.stop();
});

test("bridge forwards thumbs-up and thumbs-down reactions on its own messages", async () => {
  const workspace = createBridgeWorkspace();
  const codex = await startFakeCodexServer(workspace, {
    turns: [
      { delta: "up received", turnId: "thumbs-up-turn" },
      { delta: "down received", turnId: "thumbs-down-turn" },
    ],
  });
  const bridge = await startBridge(workspace, {
    port: codex.port,
    env: { CODEX_BRIDGE_TEXT_REPLY_FALLBACK: "1" },
  });

  await bridge.waitForOutput(/Listening in #alpha/, 7000);
  // The bridge's own messages are those alpha's webhook posted.
  const ownMessage = { author: { bot: true, id: ALPHA_WEBHOOK_ID, username: "alpha-codex" }, webhookId: ALPHA_WEBHOOK_ID };
  for (const reaction of [
    { emoji: "🎉", id: "ignored-emoji", message: ownMessage },
    {
      emoji: "👍",
      id: "ignored-user-message",
      message: { author: { bot: false, id: "allowed-user-id" } },
    },
    // A message the root bot itself sent is not this session's.
    { emoji: "👍", id: "ignored-root-bot-message", message: { author: { bot: true, id: ROOT_BOT_USER_ID } } },
    {
      emoji: "👍",
      id: "ignored-user",
      message: ownMessage,
      user: { id: "other-user" },
    },
  ]) {
    await injectReactionUntil(
      workspace,
      reaction,
      (state) => state.fixtures.discord.deliveredReactions.some(
        (delivered) => delivered.id === reaction.id,
      ),
      5000,
    );
  }
  await new Promise((resolve) => setTimeout(resolve, 300));

  await injectReactionUntil(
    workspace,
    {
      emoji: "👍",
      id: "thumbs-up",
      messageId: "bot-message-up",
      partial: true,
      message: { ...ownMessage, content: "The PR is ready.", partial: true },
      user: { partial: true },
    },
    (state) => replyContents(state).includes("up received"),
    5000,
  );
  await new Promise((resolve) => setTimeout(resolve, 50));

  const state = await injectReactionUntil(
    workspace,
    {
      emoji: "👎",
      id: "thumbs-down",
      messageId: "bot-message-down",
      message: ownMessage,
    },
    (nextState) => replyContents(nextState).includes("down received"),
    5000,
  );
  const reactionTurns = codex.clientMessages
    .filter((message) => message.method === "turn/start")
    .map((message) => message.params.input?.[0]?.text)
    .filter((text) => text && !text.startsWith("You are communicating with the user via Discord"));

  assert.deepEqual(reactionTurns, [
    'User Allowed User reacted 👍 to your message: "The PR is ready." (message ID: bot-message-up).',
    "User Allowed User reacted 👎 to your message (message ID: bot-message-down).",
  ]);
  await bridge.stop();
});

test("bridge clears during an active turn", async () => {
  const workspace = createBridgeWorkspace();
  const codex = await startFakeCodexServer(workspace, {
    threadIds: ["thread-before-clear", "thread-after-clear"],
    turns: [{ delta: "busy done", startDelayMs: 10, turnId: "busy-turn", waitForRelease: true }],
  });
  const bridge = await startBridge(workspace, {
    port: codex.port,
    env: { CODEX_BRIDGE_TEXT_REPLY_FALLBACK: "1" },
  });

  await bridge.waitForOutput(/Listening in #alpha/, 7000);
  await injectMessageUntil(
    workspace,
    { content: "busy", id: "busy-before-clear" },
    () => codex.clientMessages.some(
      (message) => message.method === "turn/start" && message.params?.input?.[0]?.text === "busy",
    ),
  );
  await injectMessageUntil(
    workspace,
    { content: "/clear", id: "clear-message" },
    (nextState) =>
      replyContents(nextState).some((content) => content.startsWith("Conversation cleared")) &&
      codex.clientMessages.filter((message) => message.method === "thread/start").length === 2,
    15000,
  );

  assert.match(bridge.stdout, /\[clear\] Interrupted turn/);
  assert.ok(codex.clientMessages.some((message) => message.method === "thread/archive"));
  assert.equal(
    codex.clientMessages.filter((message) => message.method === "thread/start").length,
    2,
  );
  await bridge.stop();
});

test("bridge sends the bootstrap instruction turn after idle compact completion", async () => {
  const workspace = createBridgeWorkspace();
  const codex = await startFakeCodexServer(workspace, {
    compactComplete: true,
    compactTurnId: "compact-turn",
  });
  const bridge = await startBridge(workspace, { port: codex.port });

  await bridge.waitForOutput(/Listening in #alpha/, 7000);
  await injectMessageUntil(
    workspace,
    { content: "/compact", id: "idle-compact-message" },
    (nextState) => replyContents(nextState).includes("Compaction complete."),
    15000,
  );
  // Compaction can announce completion before its queued instruction refresh finishes.
  await bridge.waitForOutput(/Bootstrap instruction sent \(compact\)/, 5000);
  const state = readState(workspace.stateDir);
  const bootstrapTurns = codex.clientMessages
    .filter((message) =>
      message.method === "turn/start" &&
      message.params?.input?.[0]?.text?.includes("Use ONLY the MCP server named \"discord-channel-id\"") &&
      /scope_token: "[a-f0-9]{32}"/.test(message.params.input[0].text),
    );

  assert.equal(bootstrapTurns.length, 2);
  await bridge.stop();
});

test("bridge restarts its own Codex session from slash command", async () => {
  const workspace = createBridgeWorkspace();
  const codex = await startFakeCodexServer(workspace);
  seedRegistry(workspace, {
    root_bot_app_id: ROOT_BOT_USER_ID,
    discord_user_id: "allowed-user-id",
    guild_id: "guild-id",
    projects: {
      alpha: {
        path: workspace.repoDir,
        screen_name: "alpha",
        channel_id: "channel-id",
        type: "codex",
        ws_port: codex.port,
        pid: process.pid,
        session_id: null,
      },
    },
  });
  fs.mkdirSync(path.join(workspace.homeDir, ".codex"), { recursive: true });
  const bridge = await startBridge(workspace, { port: codex.port });

  await bridge.waitForOutput(/Listening in #alpha/, 7000);
  await injectMessageUntil(
    workspace,
    { content: "/restart", id: "restart-message" },
    (nextState) =>
      replyContents(nextState).some((content) => content.startsWith("Restarting session")) &&
      botReactions(nextState).some(([messageId, emoji]) => messageId === "restart-message" && emoji === "🔄"),
    5000,
  );
  const result = await bridge.closed;
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  const state = await waitForState(
    workspace,
    (nextState) => Boolean(nextState.fixtures.tmux.sessions.alpha),
    30000,
  );

  assert.deepEqual(replyContents(state), ["Restarting session — fresh thread coming up."]);
  assert.equal(state.fixtures.tmux.sessions.alpha.bridgeCommand, "node scripts/codex-bridge.js");
  assert.equal(state.fixtures.tmux.sessions.alpha.env.CHANNEL_ID, "channel-id");
  // The relaunched bridge is a Router client for alpha, with a fresh key file.
  assert.equal(state.fixtures.tmux.sessions.alpha.env.CCDM_CODEX_PROJECT, "alpha");
  assert.equal(state.fixtures.tmux.sessions.alpha.env.CCDM_ROUTER_KEY_FILE, path.join(workspace.routerStateDir, "keys", "alpha.key"));
});

test("bridge stops typing after a non-retryable Codex error", async () => {
  const workspace = createBridgeWorkspace();
  const codex = await startFakeCodexServer(workspace, {
    turns: [{ error: "model unavailable" }],
  });
  const bridge = await startBridge(workspace, { port: codex.port });

  await bridge.waitForOutput(/Listening in #alpha/, 7000);
  let failed;
  let lastError;
  for (let attempt = 0; attempt < 3 && !failed; attempt++) {
    injectDiscordMessage(workspace, { content: "fail this turn", id: `fail-this-turn-${attempt}` });
    try {
      failed = await waitForState(
        workspace,
        (nextState) => replyContents(nextState).includes("**Error:** model unavailable"),
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

test("bridge retries a terminal response.failed once before reporting it", async () => {
  const workspace = createBridgeWorkspace();
  const codex = await startFakeCodexServer(workspace, {
    turns: [
      { error: "stream disconnected before completion: response.failed event received" },
      { delta: "Recovered response" },
    ],
  });
  const bridge = await startBridge(workspace, {
    port: codex.port,
    env: { CODEX_BRIDGE_TEXT_REPLY_FALLBACK: "1" },
  });

  await bridge.waitForOutput(/Listening in #alpha/, 7000);
  await injectMessageUntil(
    workspace,
    { content: "recover this turn", id: "recover-this-turn" },
    (nextState) => replyContents(nextState).includes("Recovered response"),
    5000,
  );
  const recoveryTurn = codex.clientMessages.find(
    (message) =>
      message.method === "turn/start" &&
      message.params.input?.[0]?.text ===
        "Retry the previous user request. The prior model response failed before any work began.",
  );
  assert.ok(recoveryTurn);
  const state = readState(workspace.stateDir);

  assert.equal(
    replyContents(state).some((content) => content.startsWith("**Error:**")),
    false,
  );
  await bridge.stop();
});

test("bridge reports response.failed after its single recovery attempt", async () => {
  const workspace = createBridgeWorkspace();
  const error = "stream disconnected before completion: response.failed event received";
  const codex = await startFakeCodexServer(workspace, {
    turns: [
      { error },
      { error },
      { delta: "unexpected third attempt" },
    ],
  });
  const bridge = await startBridge(workspace, { port: codex.port });

  await bridge.waitForOutput(/Listening in #alpha/, 7000);
  const state = await injectMessageUntil(
    workspace,
    { content: "fail twice", id: "fail-twice" },
    (nextState) => replyContents(nextState).includes(`**Error:** ${error}`),
    5000,
  );

  await bridge.waitForOutput(/Retrying terminal response\.failed turn once/, 5000);
  assert.equal(
    bridge.stdout.match(/Retrying terminal response\.failed turn once/g)?.length,
    1,
  );
  assert.equal(
    replyContents(state).includes("unexpected third attempt"),
    false,
  );
  await bridge.stop();
});

test("bridge does not retry response.failed after agent work starts", async () => {
  const workspace = createBridgeWorkspace();
  const error = "stream disconnected before completion: response.failed event received";
  const codex = await startFakeCodexServer(workspace, {
    turns: [
      { error, mcpReply: true },
      { delta: "unexpected retry" },
    ],
  });
  const bridge = await startBridge(workspace, { port: codex.port });

  await bridge.waitForOutput(/Listening in #alpha/, 7000);
  await injectMessageUntil(
    workspace,
    { content: "start work then fail", id: "start-work-then-fail" },
    (nextState) => replyContents(nextState).includes(`**Error:** ${error}`),
    5000,
  );

  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.doesNotMatch(bridge.stdout, /Retrying terminal response\.failed turn once/);
  await bridge.stop();
});

test("bridge refuses to start when a stale MCP server it could not remove stays loaded, and records diagnostics for MCP registration failure", async () => {
  const staleWorkspace = createBridgeWorkspace();
  const staleCodex = await startFakeCodexServer(staleWorkspace, {
    failStaleMcpRemoval: "delete failed",
    staleMcpName: "discord-stale",
  });
  const staleBridge = await startBridge(staleWorkspace, { port: staleCodex.port });

  const staleResult = await staleBridge.closed;
  assert.equal(staleResult.exitCode, 1);
  assert.match(staleResult.stdout, /Warning: could not clean stale MCP servers: delete failed/);
  assert.match(staleResult.stderr, /foreign MCP server discord-stale still loaded after reload/);
  assert.doesNotMatch(staleResult.stdout, /Discord bot logged in|Listening in/);
  assert.ok(!staleCodex.clientMessages.some((message) => message.method === "thread/start"));
  assert.ok(
    staleCodex.clientMessages.some(
      (message) => message.method === "config/value/delete" && message.params?.keyPath === "mcp_servers.discord-stale",
    ),
  );
  assert.ok(
    staleCodex.clientMessages.some(
      (message) => message.method === "config/value/write" && message.params?.keyPath === "mcp_servers.discord-channel-id",
    ),
  );
  await staleBridge.stop();

  const registrationWorkspace = createBridgeWorkspace();
  const registrationCodex = await startFakeCodexServer(registrationWorkspace, {
    failMcpRegistration: "write failed",
  });
  const registrationBridge = await startBridge(registrationWorkspace, { port: registrationCodex.port });
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
  const codex = await startFakeCodexServer(workspace, {
    turns: [{ delta: "cannot send" }],
  });
  const bridge = await startBridge(workspace, {
    port: codex.port,
    env: { CODEX_BRIDGE_TEXT_REPLY_FALLBACK: "1" },
  });

  await bridge.waitForOutput(/Listening in #alpha/, 7000);
  // Discord refuses the Router's post through alpha's webhook.
  updateState(workspace.stateDir, (seed) => {
    seed.fixtures.discord.restFailures = [
      { method: "POST", path: ALPHA_WEBHOOK_PATH, status: 403, body: { message: "send failed" } },
    ];
  });
  await injectMessageUntil(
    workspace,
    { content: "trigger send failure", id: "trigger-send-failure" },
    (state) => state.fixtures.discord.deliveredMessages.some((message) => message.id === "trigger-send-failure"),
    5000,
  );
  const result = await bridge.closed;

  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /send failed/);
  const state = readState(workspace.stateDir);
  assert.deepEqual(state.fixtures.discord.restFailureUses, [{ method: "POST", path: ALPHA_WEBHOOK_PATH, status: 403 }]);
  assert.deepEqual(state.fixtures.discord.messages, []);
  assert.match(state.commands.at(-1).stderr, /send failed/);
});

test("bridge builds Codex input for empty messages and image, text, binary, and failed attachments", async () => {
  const workspace = createBridgeWorkspace();
  const seed = readState(workspace.stateDir);
  seed.fixtures.discord.attachments["https://cdn.discordapp.com/attachments/channel/message/diagram.png"] = {
    body: "image bytes",
    contentType: "image/png",
  };
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
  const bridge = await startBridge(workspace, {
    port: codex.port,
    env: { CODEX_BRIDGE_TEXT_REPLY_FALLBACK: "1" },
  });

  await bridge.waitForOutput(/Listening in #alpha/, 7000);
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
        id: "att-1",
        contentType: "image/png",
        name: "diagram.png",
        size: 123,
        url: "https://cdn.discordapp.com/attachments/channel/message/diagram.png",
      },
      {
        id: "att-2",
        contentType: "text/plain",
        name: "notes.txt",
        size: 17,
        url: "https://cdn.discordapp.com/attachments/channel/message/notes.txt",
      },
      {
        id: "att-3",
        contentType: "application/octet-stream",
        name: "archive.bin",
        size: 11,
        url: "https://cdn.discordapp.com/attachments/channel/message/archive.bin",
      },
      {
        id: "att-4",
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
      replyContents(nextState).includes("attachments done") &&
      codex.clientMessages.some((message) =>
        message.method === "turn/start" && message.params?.input?.[0]?.type === "image"),
    15000,
  );

  const userTurns = codex.clientMessages.filter((message) => message.method === "turn/start").map((message) => message.params.input)
    .filter((input) => !input[0]?.text?.startsWith("You are communicating with the user via Discord"));
  assert.equal(userTurns.length, 1);
  assert.equal(userTurns[0][0].type, "image");
  assert.equal(userTurns[0][0].url, "data:image/png;base64,aW1hZ2UgYnl0ZXM=");
  assert.match(userTurns[0][1].text, /--- File: notes\.txt ---\nline one\nline two/);
  assert.match(userTurns[0][2].text, /\.discord-attachments/);
  assert.match(userTurns[0][2].text, /archive\.bin/);
  assert.deepEqual(
    state.fixtures.discord.attachmentFetches.map((entry) => entry.url).sort(),
    [
      "https://cdn.discordapp.com/attachments/channel/message/archive.bin",
      "https://cdn.discordapp.com/attachments/channel/message/diagram.png",
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
  const bridge = await startBridge(workspace, {
    port: codex.port,
    env: { CODEX_BRIDGE_TEXT_REPLY_FALLBACK: "1" },
  });

  await bridge.waitForOutput(/Listening in #alpha/, 7000);
  const state = await injectMessageUntil(
    workspace,
    {
      id: "voice-message",
      content: "some context",
      attachments: [
        {
          id: "voice-att",
          contentType: "audio/ogg",
          name: "voice-message.ogg",
          size: 399925,
          url: "https://cdn.discordapp.com/attachments/channel/message/voice-message.ogg",
        },
        {
          id: "notes-att",
          contentType: "text/plain",
          name: "notes.txt",
          size: 15,
          url: "https://cdn.discordapp.com/attachments/channel/message/notes.txt",
        },
      ],
    },
    (nextState) =>
      replyContents(nextState).includes("transcription done") &&
      nextState.fixtures.whisper.invocations.length === 1,
    15000,
  );

  const userTurns = codex.clientMessages.filter((message) => message.method === "turn/start").map((message) => message.params.input)
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

test("bridge exits on a failed Router hello, app-server exit, websocket close, and startup without a thread id", async () => {
  const helloWorkspace = createBridgeWorkspace();
  // A key the Router never issued: the hello is refused.
  const wrongKeyFile = path.join(helloWorkspace.tmpDir, "wrong.key");
  fs.writeFileSync(wrongKeyFile, "not-the-launch-key\n", { mode: 0o600 });
  const helloReadyFile = path.join(helloWorkspace.tmpDir, "hello-ready");
  const helloCodex = await startFakeCodexServer(helloWorkspace);
  const helloBridge = await startBridge(helloWorkspace, {
    port: helloCodex.port,
    env: { CCDM_ROUTER_KEY_FILE: wrongKeyFile, CCDM_CHANNEL_READY_FILE: helloReadyFile },
  });
  const helloResult = await helloBridge.closed;
  assert.notEqual(helloResult.exitCode, 0);
  assert.match(helloResult.stderr, /Discord startup failed/);
  assert.equal(readReadyFile(helloReadyFile).ok, false);
  assert.match(readReadyFile(helloReadyFile).error, /^Router hello failed: /);
  assert.equal(await routerHasSession(helloWorkspace, "alpha"), false);

  const appExitWorkspace = createBridgeWorkspace();
  updateState(appExitWorkspace.stateDir, (state) => {
    state.fixtures.codex.servers["65530"] = { ready: true, exitImmediately: true, exitCode: 7 };
  });
  const appExitBridge = await startBridge(appExitWorkspace, { port: 65530 });
  const appExitResult = await appExitBridge.closed;
  assert.notEqual(appExitResult.exitCode, 0);
  assert.match(appExitResult.stderr, /Codex app-server exited with code 7/);

  const closeWorkspace = createBridgeWorkspace();
  const closeCodex = await startFakeCodexServer(closeWorkspace, { closeAfterInitialize: true });
  const closeBridge = await startBridge(closeWorkspace, { port: closeCodex.port });
  const closeResult = await closeBridge.closed;
  assert.notEqual(closeResult.exitCode, 0);
  assert.match(closeResult.stderr, /WebSocket closed/);

  const noThreadWorkspace = createBridgeWorkspace();
  const noThreadCodex = await startFakeCodexServer(noThreadWorkspace, { omitThreadStarted: true });
  const noThreadBridge = await startBridge(noThreadWorkspace, { port: noThreadCodex.port });
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

// The bridge logs each turn's end once it is idle and will start, not steer, a turn.
async function waitForFinishedTurns(bridge, count, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while ((bridge.stdout.match(/\[turn\] Finished /g) ?? []).length < count) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${count} finished turn(s); stdout:\n${bridge.stdout}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
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

async function injectReactionUntil(workspace, reaction, predicate, timeoutMs = 5000) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    const id = reaction.id ?? `reaction-${attempt}`;
    const state = readState(workspace.stateDir);
    const alreadyKnown =
      state.fixtures.discord.injectedReactions.some((entry) => entry.id === id) ||
      state.fixtures.discord.deliveredReactions.some((entry) => entry.id === id);
    if (!alreadyKnown) {
      injectDiscordReaction(workspace, { ...reaction, id });
    }
    try {
      return await waitForState(workspace, predicate, timeoutMs);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

test("root steers only the active channel and author, retaining the active grant and safe queue fallback", async () => {
  const workspace = createBridgeWorkspace();
  const users = ["allowed-user-id", "second-user-id"];
  seedRegistry(workspace, {
    discord_user_id: "allowed-user-id",
    guild_id: "guild-id",
    root_channels: ["root-channel", "other-channel"],
    root_allowed_user_ids: ["second-user-id"],
    projects: {},
  });
  const codex = await startFakeCodexServer(workspace, {
    steer: ["success", "failure"],
    turns: [
      { turnId: "root-active", waitForRelease: true, delta: "active done" },
      { delta: "other channel done" }, { delta: "other author done" }, { delta: "fallback done" },
    ],
  });
  const bridge = await startBridge(workspace, {
    root: true, allowedUserIds: users, botAppId: ROOT_BOT_USER_ID, rootBotAppId: ROOT_BOT_USER_ID,
    channelId: "root-channel", port: codex.port, env: { CODEX_BRIDGE_TEXT_REPLY_FALLBACK: "1" },
  });
  // The fake app-server's own record; the state file can drop protocol events
  // written while the Router and bridge also write it.
  const messages = () => codex.clientMessages;
  const turns = (state) => messages(state).filter((m) => m.method === "turn/start" &&
    m.params.input?.[0]?.text?.startsWith("Discord routing metadata:"));
  const grant = (input) => input[0].text.match(/channel_scope_token: (\S+)/)[1];
  await bridge.waitForOutput(/Root routing active for 2 configured channel/, 7000);
  await injectMessageUntil(workspace, { channelId: "root-channel", content: "start", id: "root-start" },
    (state) => turns(state).length === 1);
  await new Promise((resolve) => setTimeout(resolve, 250));
  const before = readState(workspace.stateDir);
  const activeGrant = grant(turns(before)[0].params.input);
  const config = messages(before).find((m) => m.method === "config/value/write" && m.params.keyPath === "mcp_servers.discord-root");
  const scopeFile = config.params.value.env.DISCORD_CHANNEL_SCOPE_FILE;
  await injectMessageUntil(workspace, { channelId: "root-channel", content: "correction", id: "root-correction" },
    (state) => messages(state).some((m) => m.method === "turn/steer"));
  await bridge.waitForOutput(/Injected into active turn root-active/, 5000);
  let state = readState(workspace.stateDir);
  assert.equal(grant(messages(state).find((m) => m.method === "turn/steer").params.input), activeGrant);
  assert.equal(fs.readFileSync(scopeFile, "utf8"), activeGrant);
  for (const message of [
    { channelId: "other-channel", content: "other channel", id: "other-channel-message" },
    { channelId: "root-channel", content: "other author", id: "other-author-message", author: { id: "second-user-id" } },
  ]) {
    await injectMessageUntil(workspace, message,
      (next) => botReactions(next).some(([messageId, emoji]) => messageId === message.id && emoji === "⏳"));
  }
  state = readState(workspace.stateDir);
  assert.equal(messages(state).filter((m) => m.method === "turn/steer").length, 1);
  assert.equal(turns(state).length, 1);
  assert.equal(fs.readFileSync(scopeFile, "utf8"), activeGrant);
  await injectMessageUntil(workspace, { channelId: "root-channel", content: "fallback", id: "root-fallback" },
    (next) => messages(next).filter((m) => m.method === "turn/steer").length === 2);
  await bridge.waitForOutput(/Failed \(stale turn\), queuing instead/, 5000);
  codex.releaseTurn("root-active");
  // Root replies post as the root bot, not a webhook.
  state = await waitForState(workspace,
    (next) => next.fixtures.discord.messages.some((m) => m.content === "fallback done" && !m.webhookId), 15000);
  const queued = turns(state).slice(1);
  assert.equal(queued.length, 3);
  assert.match(queued[0].params.input[0].text, /channel_id: other-channel/);
  assert.match(queued[1].params.input[0].text, /author_id: second-user-id/);
  assert.match(queued[2].params.input[0].text, /Message:\nfallback/);
  for (const turn of queued) assert.notEqual(grant(turn.params.input), activeGrant);
  await bridge.stop();
});

test("Discord MCP readiness follows data pages and waits for the reply tool before starting a thread", async () => {
  const workspace = createBridgeWorkspace();
  const codex = await startFakeCodexServer(workspace, { staleMcpName: "discord-stale", mcpReadyAfter: 5, paginatedMcp: true });
  const bridge = await startBridge(workspace, { port: codex.port });
  await bridge.waitForOutput(/Listening in #alpha/, 7000);
  const messages = codex.clientMessages;
  assert.ok(messages.some((m) => m.method === "config/value/delete" && m.params.keyPath === "mcp_servers.discord-stale"));
  const start = messages.findIndex((m) => m.method === "thread/start");
  assert.ok(messages.slice(0, start).filter((m) => m.method === "mcpServerStatus/list").length >= 4);
  assert.match(bridge.stdout, /reply tool available/);
  assert.ok(messages.some((m) => m.method === "mcpServerStatus/list" && m.params.cursor === "discord-page"));
  const bootstrap = messages.find((m) => m.method === "turn/start");
  assert.match(bootstrap.params.input[0].text, /Do not call tools, inspect files, or send a Discord message/);
  assert.match(messages[start].params.developerInstructions, /Never reconstruct the Discord transport/);
  await bridge.stop();
});

test("Discord MCP missing reply fails startup without advertising a listener", async () => {
  const workspace = createBridgeWorkspace();
  const codex = await startFakeCodexServer(workspace, { missingReply: true });
  const bridge = await startBridge(workspace, { port: codex.port, env: { CODEX_MCP_READY_TIMEOUT_MS: "250" } });
  const result = await bridge.closed;
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /did not expose the reply tool/);
  assert.ok(!codex.clientMessages.some((m) => m.method === "thread/start"));
  assert.doesNotMatch(result.stdout, /Discord bot logged in|Listening in/);
});

test("slow bootstrap remains tracked beyond the old fifteen-second cutoff", async () => {
  const workspace = createBridgeWorkspace();
  const codex = await startFakeCodexServer(workspace, {
    bootstrapPlan: { turnId: "slow-bootstrap", waitForRelease: true },
  });
  const bridge = await startBridge(workspace, { port: codex.port });
  await waitForState(workspace, () => codex.clientMessages.some((m) => m.method === "turn/start"), 7000);
  await new Promise((resolve) => setTimeout(resolve, 15500));
  assert.doesNotMatch(bridge.stdout, /Bootstrap instruction sent|Discord bot logged in|Listening in/);
  // No Router hello until the bootstrap turn finishes.
  assert.equal(await routerHasSession(workspace, "alpha"), false);
  codex.releaseTurn("slow-bootstrap");
  await bridge.waitForOutput(/Listening in #alpha/, 7000);
  assert.equal(await routerHasSession(workspace, "alpha"), true);
  assert.doesNotMatch(bridge.stdout, /no turn is active/);
  await bridge.stop();
});

test("bootstrap deadline explicitly interrupts and fails closed instead of forgetting an active turn", async () => {
  const workspace = createBridgeWorkspace();
  const codex = await startFakeCodexServer(workspace, {
    bootstrapPlan: { turnId: "blocked-bootstrap", waitForRelease: true },
  });
  const bridge = await startBridge(workspace, { port: codex.port, env: { CODEX_BOOTSTRAP_TIMEOUT_MS: "250" } });
  const result = await bridge.closed;
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /Bootstrap timed out/);
  assert.ok(codex.clientMessages.some((m) => m.method === "turn/interrupt" && m.params.turnId === "blocked-bootstrap"));
  assert.doesNotMatch(result.stdout, /Discord bot logged in|Listening in/);
});

test("failed bootstrap completion without a separate error event fails startup", async () => {
  const workspace = createBridgeWorkspace();
  const codex = await startFakeCodexServer(workspace, {
    bootstrapPlan: { status: "failed", terminalError: { message: "provider bootstrap failure" } },
  });
  const bridge = await startBridge(workspace, { port: codex.port });
  const result = await bridge.closed;
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /provider bootstrap failure/);
  assert.doesNotMatch(result.stdout, /Discord bot logged in|Listening in/);
});
