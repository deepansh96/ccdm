import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { bridgeChildEnv, collectProcess, createBridgeWorkspace, runPreloadProbe } from "./support/bridge.js";
import {
  ROOT_TOKEN,
  createRouterWorkspace,
  routerEnv,
  routerRegistry,
  routerWithWebhooks,
  writeRootKey,
} from "./support/router.js";
import { runNodeEntrypoint } from "./support/runner.js";
import { readState, writeState } from "./support/state.js";
import { cleanup, registerTeardownCallback } from "./support/teardown.js";

test.afterEach(async () => {
  await cleanup();
});

function rpc(id, method, params) {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params });
}

function toolCall(id, name, args = {}) {
  return rpc(id, "tools/call", { name, arguments: args });
}

function channelScopeToken(secret, authorId, channelId) {
  const encoded = Buffer.from(JSON.stringify({
    author_id: authorId,
    channel_id: channelId,
    nonce: "test-nonce",
  })).toString("base64url");
  const signature = createHmac("sha256", secret).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

// `beta` is the registry's router-transport Codex project in `beta-channel`;
// its webhook is the fake's first (`fake-webhook-1`) and its key `beta-key`.
// The fake webhook token is spelled in parts because router.test.js
// scans every Test Workspace file, including this copied source, for that token.
const BETA_WEBHOOK_EXECUTE = `/api/v10/webhooks/fake-webhook-1/${"fake-webhook-"}token-1`;

// A Router serving `beta`, as start-codex-session.sh leaves it before the
// bridge's MCP server connects. `registry` and `routerOptions` adjust it.
async function betaRouter({ registry = routerRegistry(), routerOptions } = {}) {
  const workspace = createRouterWorkspace(registry);
  const router = await routerWithWebhooks(workspace, ["beta"], routerOptions);
  return { workspace, router };
}

// The scoped MCP server's environment for `beta`, as the bridge writes it.
function betaMcpEnv(workspace, extraEnv = {}) {
  return {
    CCDM_ROUTER_KEY_FILE: path.join(workspace.routerStateDir, "keys", "beta.key"),
    CCDM_CODEX_PROJECT: "beta",
    CHANNEL_ID: "beta-channel",
    ...extraEnv,
  };
}

// Root Codex's scoped MCP server: the Router root role with root's key.
function rootMcpEnv(workspace, extraEnv = {}) {
  return {
    CCDM_ROUTER_KEY_FILE: path.join(workspace.routerStateDir, "keys", ".root.key"),
    CCDM_ROUTER_ROLE: "root",
    CHANNEL_ID: "root-channel",
    ...extraEnv,
  };
}

function parsedLines(stdout) {
  return stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

// Codex keeps the server's stdin open while it runs, and a Router-backed
// server exits when stdin closes. So each line is written in turn, a request
// waits for its response before the next goes out (Router operations are
// asynchronous, and later calls may target messages earlier ones created),
// and stdin closes only after the last response.
async function runMcp(workspace, lines, env, { timeoutMs = 10000 } = {}) {
  const childEnv = routerEnv(workspace, env);
  const command = [process.execPath, path.join(workspace.repoDir, "scripts/discord-mcp-server.js")];
  const child = spawn(command[0], command.slice(1), {
    cwd: workspace.repoDir,
    detached: true,
    env: childEnv,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const running = collectProcess(child, { command, cwd: workspace.repoDir, detached: true, env: childEnv }, workspace);
  registerTeardownCallback(() => running.stop());
  for (const line of lines) {
    child.stdin.write(`${line}\n`);
    let request = null;
    try {
      request = JSON.parse(line);
    } catch {
      // Malformed input gets no response.
    }
    if (request?.id === undefined) continue;
    const deadline = Date.now() + timeoutMs;
    while (!parsedLines(running.stdout).some((entry) => entry.id === request.id)) {
      if (child.exitCode !== null) break;
      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for response ${request.id}; stdout:\n${running.stdout}\nstderr:\n${running.stderr}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  child.stdin.end();
  return await running.closed;
}

function responses(result) {
  return parsedLines(result.stdout);
}

function responseById(result) {
  return new Map(responses(result).map((entry) => [entry.id, entry]));
}

// Channel history as Discord returns it: newest first.
function seedHistory(workspace, channelId, messages) {
  const state = readState(workspace.stateDir);
  state.fixtures.discord.history ||= {};
  state.fixtures.discord.history[channelId] = messages;
  writeState(state, workspace.stateDir);
}

function seedDiscord(workspace, update) {
  const state = readState(workspace.stateDir);
  update(state.fixtures.discord);
  writeState(state, workspace.stateDir);
}

function webhookMessages(workspace) {
  return (readState(workspace.stateDir).fixtures.discord.messages ?? []).filter((message) => message.webhookId);
}

test("Discord MCP initializes, lists tools, accepts initialized notifications, and replies with text through the Router", async () => {
  const { workspace } = await betaRouter();
  seedHistory(workspace, "beta-channel", [
    { id: "parent-message", timestamp: "2026-05-28T10:00:00.000Z", content: "question",
      author: { id: "owner-id", username: "Owner" }, attachments: [] },
  ]);

  const result = await runMcp(workspace, [
    rpc(1, "initialize", {}),
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    rpc(2, "tools/list", {}),
    toolCall(3, "reply", { text: "hello Discord", reply_to: "parent-message" }),
  ], betaMcpEnv(workspace));

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  const output = responses(result);
  assert.equal(output[0].result.serverInfo.name, "discord-mcp");
  assert.deepEqual(
    output[1].result.tools.map((tool) => tool.name),
    [
      "reply",
      "edit_message",
      "react",
      "fetch_messages",
      "read_last_x_messages_in_channel",
      "export_message_range",
      "download_attachment",
    ],
  );
  const replyTool = output[1].result.tools.find((tool) => tool.name === "reply");
  assert.match(replyTool.inputSchema.properties.files.description, /Max 10 files, 25MB each/);
  assert.deepEqual(output[2].result.content, [{ type: "text", text: "sent (id: fake-message-1)" }]);

  // The Router posts as beta's webhook; webhooks can't send native replies,
  // so the quote-reply is a jump link.
  const discord = readState(workspace.stateDir).fixtures.discord;
  assert.deepEqual(discord.messages, [{
    avatarUrl: "https://cdn.discordapp.com/embed/avatars/1.png",
    channelId: "beta-channel",
    content: "↪ [jump](https://discord.com/channels/guild-id/beta-channel/parent-message)\nhello Discord",
    id: "fake-message-1",
    username: "beta-codex",
    webhookId: "fake-webhook-1",
  }]);
});

test("Discord MCP exports a message range through the latest message", async () => {
  const { workspace } = await betaRouter();
  seedHistory(workspace, "beta-channel", [
    { id: "103", timestamp: "2026-07-13T10:02:00.000Z", content: "latest", author: { id: "2", username: "Bob" }, attachments: [] },
    { id: "102", timestamp: "2026-07-13T10:01:00.000Z", content: "start", author: { id: "1", username: "Alice" }, attachments: [] },
    { id: "101", timestamp: "2026-07-13T10:00:00.000Z", content: "older", author: { id: "1", username: "Alice" }, attachments: [] },
  ]);

  const result = await runMcp(
    workspace,
    [toolCall(1, "export_message_range", { start_message_id: "102" })],
    betaMcpEnv(workspace),
  );

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  const output = responseById(result).get(1).result.content[0].text;
  const exportPath = output.replace(/^exported to /, "");
  const text = fs.readFileSync(exportPath, "utf8");
  assert.match(text, /Message ID: 102/);
  assert.match(text, /Message ID: 103/);
  assert.doesNotMatch(text, /Message ID: 101/);
  assert.equal(fs.statSync(exportPath).mode & 0o777, 0o600);
});

test("Discord MCP reads 500 recent messages across API pages", async () => {
  const { workspace } = await betaRouter();
  seedHistory(workspace, "beta-channel", Array.from({ length: 505 }, (_, index) => ({
    id: String(1504 - index),
    timestamp: "2026-08-01T10:00:00.000Z",
    content: `message ${1504 - index}`,
    author: { username: "Alice", bot: false },
    attachments: [],
  })));
  seedDiscord(workspace, (discord) => {
    discord.restFailures = [{
      path: "/api/v10/channels/beta-channel/messages",
      status: 429,
      body: { message: "rate limited", retry_after: 0, global: false },
    }];
  });

  const result = await runMcp(workspace, [
    toolCall(1, "read_last_x_messages_in_channel", { count: 500 }),
  ], betaMcpEnv(workspace));

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  const transcript = responseById(result).get(1).result.content[0].text
    .replace(/^saved 500 messages to /, "");
  const messages = fs.readFileSync(transcript, "utf8").trim().split("\n");
  assert.equal(messages.length, 500);
  assert.equal(messages[0], "[2026-08-01T10:00:00.000Z] Alice: message 1005 (id: 1005)");
  assert.equal(messages.at(-1), "[2026-08-01T10:00:00.000Z] Alice: message 1504 (id: 1504)");
  assert.equal(fs.statSync(transcript).mode & 0o777, 0o600);
  // The Router absorbed the 429 and retried the page with the bot token.
  const discord = readState(workspace.stateDir).fixtures.discord;
  assert.deepEqual(discord.restFailureUses, [{
    method: "GET",
    path: "/api/v10/channels/beta-channel/messages",
    status: 429,
  }]);
  assert.deepEqual(
    discord.historyFetches.map(({ authorization, channelId, limit, before }) => ({ authorization, channelId, limit, before })),
    [
      { authorization: `Bot ${ROOT_TOKEN}`, channelId: "beta-channel", limit: 100, before: undefined },
      { authorization: `Bot ${ROOT_TOKEN}`, channelId: "beta-channel", limit: 100, before: "1405" },
      { authorization: `Bot ${ROOT_TOKEN}`, channelId: "beta-channel", limit: 100, before: "1305" },
      { authorization: `Bot ${ROOT_TOKEN}`, channelId: "beta-channel", limit: 100, before: "1205" },
      { authorization: `Bot ${ROOT_TOKEN}`, channelId: "beta-channel", limit: 100, before: "1105" },
    ],
  );
});

test("Discord MCP read-only mode exposes only the read tools and hides all others", async () => {
  const workspace = createBridgeWorkspace();
  const result = await runNodeEntrypoint(workspace, "scripts/discord-mcp-server.js", {
    env: bridgeChildEnv(workspace, {
      BOT_TOKEN: "",
      CHANNEL_ID: "channel-id",
      DISCORD_MCP_EXPORT_ONLY: "1",
    }),
    input: [
      rpc(1, "tools/list", {}),
      toolCall(2, "reply", { text: "hidden" }),
      toolCall(3, "fetch_messages", {}),
      toolCall(4, "download_attachment", { message_id: "1" }),
    ].join("\n") + "\n",
  });

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  const output = responseById(result);
  assert.deepEqual(
    output.get(1).result.tools.map((tool) => tool.name),
    ["read_last_x_messages_in_channel", "export_message_range"],
  );
  for (const id of [2, 3, 4]) {
    assert.equal(output.get(id).result.isError, true);
    assert.match(output.get(id).result.content[0].text, /unavailable in read-only mode/);
  }
  assert.deepEqual(readState(workspace.stateDir).fixtures.discord.messages ?? [], []);
});

test("Discord MCP read-only mode reads recent messages with the state-directory token", async () => {
  const workspace = createBridgeWorkspace();
  const state = readState(workspace.stateDir);
  state.fixtures.discord.restMessages = [
    { id: "203", timestamp: "2026-09-27T10:02:00.000Z", content: "latest", author: { username: "Alice" }, attachments: [] },
    { id: "202", timestamp: "2026-09-27T10:01:00.000Z", content: "reply", author: { username: "bot", bot: true }, attachments: [{}] },
    { id: "201", timestamp: "2026-09-27T10:00:00.000Z", content: "older", author: { username: "Alice" }, attachments: [] },
  ];
  writeState(state, workspace.stateDir);
  const botStateDir = fs.mkdtempSync(path.join(workspace.homeDir, "bot-state-"));
  fs.writeFileSync(path.join(botStateDir, ".env"), "DISCORD_BOT_TOKEN=state-token\n");
  const env = { BOT_TOKEN: "", CHANNEL_ID: "channel-id", DISCORD_MCP_EXPORT_ONLY: "1" };

  const result = await runNodeEntrypoint(workspace, "scripts/discord-mcp-server.js", {
    env: bridgeChildEnv(workspace, { ...env, DISCORD_STATE_DIR: botStateDir }),
    input: `${toolCall(1, "read_last_x_messages_in_channel", { count: 2 })}\n`,
  });
  const missing = await runNodeEntrypoint(workspace, "scripts/discord-mcp-server.js", {
    env: bridgeChildEnv(workspace, { ...env, DISCORD_STATE_DIR: path.join(botStateDir, "missing") }),
    input: `${toolCall(1, "read_last_x_messages_in_channel", { count: 2 })}\n`,
  });

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.equal(
    responseById(result).get(1).result.content[0].text,
    "[2026-09-27T10:01:00.000Z] me: reply +1att (id: 202)\n[2026-09-27T10:02:00.000Z] Alice: latest (id: 203)",
  );
  assert.deepEqual(
    readState(workspace.stateDir).fixtures.discord.fetches,
    [{ authorization: "Bot state-token", channelId: "channel-id", limit: 2 }],
  );
  assert.equal(responseById(missing).get(1).result.isError, true);
  assert.match(responseById(missing).get(1).result.content[0].text, /No bot token found/);
});

test("Discord MCP writes require the bridge scope token when configured", async () => {
  const { workspace } = await betaRouter();

  const result = await runMcp(
    workspace,
    [
      rpc(1, "initialize", {}),
      rpc(2, "tools/list", {}),
      toolCall(3, "reply", { text: "missing token" }),
      toolCall(4, "reply", { text: "wrong token", scope_token: "wrong" }),
      toolCall(5, "edit_message", { message_id: "fake-message-1", text: "missing token" }),
      toolCall(6, "react", { message_id: "fake-message-1", emoji: "👍", scope_token: "wrong" }),
      toolCall(7, "reply", { text: "right token", scope_token: "secret-token" }),
      toolCall(8, "edit_message", { message_id: "fake-message-1", text: "right token edited", scope_token: "secret-token" }),
      toolCall(9, "react", { message_id: "fake-message-1", emoji: "👍", scope_token: "secret-token" }),
    ],
    betaMcpEnv(workspace, { DISCORD_REPLY_TOKEN: "secret-token" }),
  );

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  const output = responseById(result);
  const replyTool = output.get(2).result.tools.find((tool) => tool.name === "reply");
  const editTool = output.get(2).result.tools.find((tool) => tool.name === "edit_message");
  const reactTool = output.get(2).result.tools.find((tool) => tool.name === "react");
  assert.deepEqual(replyTool.inputSchema.required, ["text", "scope_token"]);
  assert.deepEqual(editTool.inputSchema.required, ["message_id", "text", "scope_token"]);
  assert.deepEqual(reactTool.inputSchema.required, ["message_id", "emoji", "scope_token"]);
  for (const id of [3, 4, 5, 6]) {
    assert.equal(output.get(id).result.isError, true);
    assert.deepEqual(output.get(id).result.content, [
      { type: "text", text: "Error: Discord write denied: missing or invalid scope token" },
    ]);
  }
  assert.deepEqual(output.get(7).result.content, [{ type: "text", text: "sent (id: fake-message-1)" }]);
  assert.deepEqual(output.get(8).result.content, [{ type: "text", text: "edited (id: fake-message-1)" }]);
  assert.deepEqual(output.get(9).result.content, [{ type: "text", text: "reacted with 👍" }]);

  // Only the scoped writes reached Discord: one webhook message, its webhook
  // edit, and the bot's reaction.
  const discord = readState(workspace.stateDir).fixtures.discord;
  assert.deepEqual(webhookMessages(workspace).map((message) => message.content), ["right token edited"]);
  assert.deepEqual(discord.webhookEdits, [
    { webhookId: "fake-webhook-1", messageId: "fake-message-1", content: "right token edited" },
  ]);
  assert.deepEqual(discord.reactions, [{
    authorization: `Bot ${ROOT_TOKEN}`, channelId: "beta-channel", emoji: "%F0%9F%91%8D", messageId: "fake-message-1",
  }]);
});

test("Discord MCP root override routes calls to the requested channel as the Router root role", async () => {
  // `beta-channel` is the guest's project channel, `demo-channel` another
  // registered channel, and `stray-channel` outside root's Router scope.
  const { workspace, router } = await betaRouter({ registry: { ...routerRegistry(), root_channels: ["root-channel"] } });
  writeRootKey(workspace, "root-key");
  const scopeFile = path.join(workspace.tmpDir, "active-scope");
  const scopeSecret = "scope-secret";
  const guestScope = channelScopeToken(scopeSecret, "guest-user", "beta-channel");
  const globalScope = channelScopeToken(scopeSecret, "global-user", "beta-channel");
  fs.writeFileSync(scopeFile, guestScope);
  const hello = [{ id: "message-1", timestamp: "2026-05-28T10:00:00.000Z", content: "hello",
    author: { username: "Alice", bot: false }, attachments: [] }];
  seedHistory(workspace, "beta-channel", hello);
  seedHistory(workspace, "demo-channel", [{ ...hello[0], id: "message-2", content: "hello demo" }]);
  const overrideEnv = {
    DISCORD_CHANNEL_OVERRIDE: "1",
    DISCORD_CHANNEL_SCOPE_FILE: scopeFile,
    DISCORD_CHANNEL_SCOPE_SECRET: scopeSecret,
    DISCORD_GLOBAL_USER_IDS: "global-user",
    DISCORD_REPLY_TOKEN: "secret-token",
  };

  const result = await runMcp(
    workspace,
    [
      rpc(1, "tools/list", {}),
      toolCall(2, "reply", { text: "missing channel", scope_token: "secret-token" }),
      toolCall(3, "reply", { text: "to project", channel_id: "beta-channel", channel_scope_token: guestScope, scope_token: "secret-token" }),
      toolCall(4, "fetch_messages", { channel_id: "beta-channel", channel_scope_token: guestScope, limit: 1 }),
      toolCall(5, "reply", { text: "denied", channel_id: "demo-channel", channel_scope_token: guestScope, scope_token: "secret-token" }),
      toolCall(6, "fetch_messages", { channel_id: "demo-channel", channel_scope_token: guestScope, limit: 1 }),
      toolCall(9, "fetch_messages", { channel_id: "demo-channel", channel_scope_token: globalScope, limit: 1 }),
    ],
    rootMcpEnv(workspace, overrideEnv),
  );

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  const output = responseById(result);
  const replyTool = output.get(1).result.tools.find((tool) => tool.name === "reply");
  assert.deepEqual(replyTool.inputSchema.required, ["text", "channel_id", "channel_scope_token", "scope_token"]);
  assert.equal(output.get(2).result.isError, true);
  assert.equal(output.get(2).result.content[0].text, "Error: channel_id is required in root multi-channel mode");
  assert.deepEqual(output.get(3).result.content, [{ type: "text", text: "sent (id: fake-message-1)" }]);
  assert.equal(output.get(4).result.content[0].text, "[2026-05-28T10:00:00.000Z] Alice: hello (id: message-1)");
  for (const id of [5, 6]) {
    assert.equal(output.get(id).result.isError, true);
    assert.equal(output.get(id).result.content[0].text, "Error: Discord channel demo-channel is not allowed for this message");
  }
  assert.equal(output.get(9).result.isError, true);
  assert.equal(output.get(9).result.content[0].text, "Error: Discord channel scope is missing, expired, or invalid");

  // Root posts as the bot itself, in the channel the call named.
  let discord = readState(workspace.stateDir).fixtures.discord;
  assert.deepEqual(discord.messages.map(({ authorization, channelId, content, webhookId }) => ({ authorization, channelId, content, webhookId })), [
    { authorization: `Bot ${ROOT_TOKEN}`, channelId: "beta-channel", content: "to project", webhookId: undefined },
  ]);
  assert.deepEqual(discord.historyFetches.map(({ channelId, limit }) => ({ channelId, limit })), [
    { channelId: "beta-channel", limit: 1 },
  ]);

  // A global user may name any channel; the Router still bounds root's scope.
  fs.writeFileSync(scopeFile, globalScope);
  const globalResult = await runMcp(
    workspace,
    [
      toolCall(7, "reply", { text: "global target", channel_id: "demo-channel", channel_scope_token: globalScope, scope_token: "secret-token" }),
      toolCall(8, "fetch_messages", { channel_id: "demo-channel", channel_scope_token: globalScope, limit: 1 }),
      toolCall(10, "reply", { text: "stray", channel_id: "stray-channel", channel_scope_token: globalScope, scope_token: "secret-token" }),
    ],
    rootMcpEnv(workspace, overrideEnv),
  );
  const globalOutput = responseById(globalResult);
  assert.deepEqual(globalOutput.get(7).result, { content: [{ type: "text", text: "sent (id: fake-message-2)" }] });
  assert.deepEqual(globalOutput.get(8).result, {
    content: [{ type: "text", text: "[2026-05-28T10:00:00.000Z] Alice: hello demo (id: message-2)" }],
  });
  assert.equal(globalOutput.get(10).result.isError, true);
  assert.equal(globalOutput.get(10).result.content[0].text, "Error: Router reply failed: scope_violation");
  await router.waitForOutput(/scope_violation project=root op=reply target=stray-channel/);
  discord = readState(workspace.stateDir).fixtures.discord;
  assert.deepEqual(discord.messages.map(({ channelId, content }) => ({ channelId, content })), [
    { channelId: "beta-channel", content: "to project" },
    { channelId: "demo-channel", content: "global target" },
  ]);

  // Multi-channel mode is root's alone: a project-role server refuses it.
  const projectResult = await runMcp(
    workspace,
    [toolCall(11, "reply", { text: "not root", channel_id: "demo-channel", channel_scope_token: globalScope, scope_token: "secret-token" })],
    betaMcpEnv(workspace, overrideEnv),
  );
  assert.deepEqual(responseById(projectResult).get(11).result, {
    content: [{ type: "text", text: "Error: Root multi-channel mode needs the Router root role" }],
    isError: true,
  });
  assert.equal(readState(workspace.stateDir).fixtures.discord.messages.length, 2);
});

test("Discord MCP reports JSON-RPC errors and drives edit, react, and fetch tools through the Router", async () => {
  const { workspace } = await betaRouter();
  seedHistory(workspace, "beta-channel", [
    {
      id: "new-message",
      timestamp: "2026-05-28T10:00:01.000Z",
      content: "newest",
      author: { username: "Alice", bot: false },
      attachments: [{ id: "att-1" }],
    },
    {
      id: "old-message",
      timestamp: "2026-05-28T10:00:00.000Z",
      content: "oldest",
      author: { username: "Bot", bot: true },
      attachments: [],
    },
  ]);

  const missingKey = await runNodeEntrypoint(workspace, "scripts/discord-mcp-server.js", {
    env: routerEnv(workspace, { CHANNEL_ID: "beta-channel" }),
    input: "",
  });
  assert.equal(missingKey.exitCode, 1);
  assert.equal(missingKey.stderr, "Missing CCDM_ROUTER_KEY_FILE or CHANNEL_ID\n");
  const missingProject = await runNodeEntrypoint(workspace, "scripts/discord-mcp-server.js", {
    env: routerEnv(workspace, betaMcpEnv(workspace, { CCDM_CODEX_PROJECT: "" })),
    input: "",
  });
  assert.equal(missingProject.exitCode, 1);
  assert.equal(missingProject.stderr, "Missing CCDM_CODEX_PROJECT or CHANNEL_ID\n");

  const result = await runMcp(workspace, [
    "{not json",
    rpc(10, "unknown/method", {}),
    toolCall(11, "reply", { text: "draft" }),
    toolCall(12, "edit_message", { message_id: "fake-message-1", text: "updated" }),
    toolCall(13, "react", { message_id: "new-message", emoji: "👍" }),
    toolCall(14, "fetch_messages", { limit: 2 }),
    toolCall(15, "read_last_x_messages_in_channel", { count: 1 }),
    toolCall(16, "read_last_x_messages_in_channel", { count: 0 }),
  ], betaMcpEnv(workspace));

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.match(result.stderr, /Parse error/);
  const output = responseById(result);
  assert.equal(output.get(10).error.message, "Method not found: unknown/method");
  assert.deepEqual(output.get(11).result.content, [{ type: "text", text: "sent (id: fake-message-1)" }]);
  assert.deepEqual(output.get(12).result.content, [{ type: "text", text: "edited (id: fake-message-1)" }]);
  assert.deepEqual(output.get(13).result.content, [{ type: "text", text: "reacted with 👍" }]);
  assert.equal(
    output.get(14).result.content[0].text,
    "[2026-05-28T10:00:00.000Z] me: oldest (id: old-message)\n[2026-05-28T10:00:01.000Z] Alice: newest +1att (id: new-message)",
  );
  assert.equal(
    output.get(15).result.content[0].text,
    "[2026-05-28T10:00:01.000Z] Alice: newest +1att (id: new-message)",
  );
  // The Router rejects the count as invalid_args; the MCP reports the code.
  assert.deepEqual(output.get(16).result, {
    content: [{ type: "text", text: "Error: Router read_last_x_messages_in_channel failed: invalid_args" }],
    isError: true,
  });

  const discord = readState(workspace.stateDir).fixtures.discord;
  assert.deepEqual(discord.webhookEdits, [{ webhookId: "fake-webhook-1", messageId: "fake-message-1", content: "updated" }]);
  assert.deepEqual(discord.reactions, [{
    authorization: `Bot ${ROOT_TOKEN}`,
    channelId: "beta-channel",
    emoji: "%F0%9F%91%8D",
    messageId: "new-message",
  }]);
  assert.deepEqual(discord.historyFetches, [
    { authorization: `Bot ${ROOT_TOKEN}`, channelId: "beta-channel", limit: 2 },
    { authorization: `Bot ${ROOT_TOKEN}`, channelId: "beta-channel", limit: 1 },
  ]);
});

test("Discord MCP replies with files as Router webhook uploads and reports upload failures", async () => {
  const { workspace, router } = await betaRouter();
  const smallFile = path.join(workspace.tmpDir, "small.txt");
  const largeFile = path.join(workspace.tmpDir, "large.bin");
  fs.writeFileSync(smallFile, "small file");
  fs.writeFileSync(largeFile, "");
  fs.truncateSync(largeFile, 26 * 1024 * 1024);
  const extraFiles = Array.from({ length: 9 }, (_, index) => {
    const file = path.join(workspace.tmpDir, `extra-${index}.txt`);
    fs.writeFileSync(file, `extra ${index}`);
    return file;
  });

  const rejected = await runMcp(workspace, [
    toolCall(20, "reply", { text: "missing", files: [path.join(workspace.tmpDir, "missing.txt")] }),
    // Eleven files: the Router enforces the advertised 10-file limit.
    toolCall(23, "reply", { text: "too many", files: [smallFile, largeFile, ...extraFiles] }),
  ], betaMcpEnv(workspace));
  for (const id of [20, 23]) {
    assert.deepEqual(responseById(rejected).get(id).result, {
      content: [{ type: "text", text: "Error: Router reply failed: invalid_args" }],
      isError: true,
    });
  }

  const success = await runMcp(workspace, [
    toolCall(21, "reply", { text: "", files: [smallFile, largeFile, ...extraFiles.slice(0, 8)] }),
  ], betaMcpEnv(workspace));
  assert.equal(success.exitCode, 0, success.stderr || success.stdout);
  assert.equal(responseById(success).get(21).result.content[0].text, "sent (id: fake-message-1)");

  // One webhook message carries all ten uploads; the Router does not enforce
  // the advertised 25MB size limit locally.
  assert.deepEqual(webhookMessages(workspace).map(({ channelId, content, uploads, webhookId }) => ({ channelId, content, uploads, webhookId })), [{
    channelId: "beta-channel",
    content: "",
    uploads: [
      { name: "small.txt", size: 10 },
      { name: "large.bin", size: 26 * 1024 * 1024 },
      ...Array.from({ length: 8 }, (_, index) => ({ name: `extra-${index}.txt`, size: 7 })),
    ],
    webhookId: "fake-webhook-1",
  }]);

  seedDiscord(workspace, (discord) => {
    discord.restFailures = [{ method: "POST", path: BETA_WEBHOOK_EXECUTE, status: 500, body: { message: "upload failed" } }];
  });
  const failure = await runMcp(workspace, [toolCall(22, "reply", { text: "upload", files: [smallFile] })], betaMcpEnv(workspace));
  assert.deepEqual(responseById(failure).get(22).result, {
    content: [{ type: "text", text: "Error: Router reply failed: discord_error" }],
    isError: true,
  });
  await router.waitForOutput(/op_failed project=beta op=reply error=Discord API 500: upload failed/);
  const discord = readState(workspace.stateDir).fixtures.discord;
  assert.deepEqual(discord.restFailureUses, [{ method: "POST", path: BETA_WEBHOOK_EXECUTE, status: 500 }]);
  assert.equal(webhookMessages(workspace).length, 1);
});

test("FormData shim blocks missed upload egress", async () => {
  const workspace = createBridgeWorkspace();

  const probe = await runPreloadProbe(
    workspace,
    `
      const FormData = require("form-data");
      const form = new FormData();
      form.append("payload_json", JSON.stringify({ content: "missed" }));
      form.submit({ protocol: "https:", host: "example.com", path: "/upload", method: "POST" }, (error) => {
        console.log(error.message);
        setTimeout(() => process.exit(0), 10);
      });
      setTimeout(() => process.exit(2), 1000);
    `,
    { CCDM_TEST_FORM_DATA_SHIM: "1" },
  );

  assert.equal(probe.exitCode, 0, probe.stderr || probe.stdout);
  assert.match(probe.stdout, /Blocked unexpected form-data egress: https:\/\/example\.com\/upload/);
  assert.deepEqual(readState(workspace.stateDir).fixtures.network.blocked.at(-1), {
    kind: "form-data",
    target: "https://example.com/upload",
  });
});

test("Discord MCP fetch and download tools cover limits, attachment indexes, writes, and download failures", async () => {
  const { workspace } = await betaRouter();
  seedHistory(workspace, "beta-channel", [
    {
      id: "message-with-attachments",
      timestamp: "2026-05-28T10:00:02.000Z",
      content: "files",
      author: { username: "Alice", bot: false },
      attachments: [
        {
          id: "att-1",
          filename: "first.txt",
          url: "https://cdn.discordapp.com/attachments/channel/message/first.txt",
        },
        {
          id: "att-2",
          filename: "second.txt",
          url: "https://cdn.discordapp.com/attachments/channel/message/second.txt",
        },
      ],
    },
    {
      id: "message-without-attachments",
      timestamp: "2026-05-28T10:00:01.000Z",
      content: "no files",
      author: { username: "Alice", bot: false },
      attachments: [],
    },
    {
      id: "message-cdn-failure",
      timestamp: "2026-05-28T10:00:00.000Z",
      content: "cdn failure",
      author: { username: "Alice", bot: false },
      attachments: [
        {
          id: "att-3",
          filename: "failure.txt",
          url: "https://cdn.discordapp.com/attachments/channel/message/failure.txt",
        },
      ],
    },
    {
      id: "message-network-failure",
      timestamp: "2026-05-28T09:59:59.000Z",
      content: "network failure",
      author: { username: "Alice", bot: false },
      attachments: [
        {
          id: "att-4",
          filename: "blocked.txt",
          url: "https://example.com/blocked.txt",
        },
      ],
    },
  ]);
  seedDiscord(workspace, (discord) => {
    discord.attachments["https://cdn.discordapp.com/attachments/channel/message/first.txt"] = { body: "first file" };
    discord.attachments["https://cdn.discordapp.com/attachments/channel/message/second.txt"] = { body: "second file" };
    discord.attachments["https://cdn.discordapp.com/attachments/channel/message/failure.txt"] = { body: "cdn down", status: 503 };
  });

  const absoluteSaveDir = path.join(workspace.tmpDir, "absolute-downloads");
  const result = await runMcp(workspace, [
    toolCall(30, "fetch_messages", { limit: 150 }),
    toolCall(31, "fetch_messages", { limit: -1 }),
    toolCall(32, "download_attachment", { message_id: "message-with-attachments", save_dir: absoluteSaveDir }),
    toolCall(33, "download_attachment", {
      message_id: "message-with-attachments",
      attachment_index: 1,
      save_dir: absoluteSaveDir,
    }),
    toolCall(34, "download_attachment", { message_id: "message-with-attachments", attachment_index: 3 }),
    toolCall(35, "download_attachment", { message_id: "message-with-attachments", attachment_index: -1 }),
    toolCall(36, "download_attachment", { message_id: "message-without-attachments" }),
    toolCall(37, "download_attachment", { message_id: "message-cdn-failure", save_dir: absoluteSaveDir }),
    toolCall(38, "download_attachment", { message_id: "message-network-failure", save_dir: absoluteSaveDir }),
  ], betaMcpEnv(workspace));

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  const output = responseById(result);
  const text = (id) => output.get(id).result.content[0].text;
  assert.match(text(30), /message-with-attachments/);
  assert.equal(output.get(31).result.isError, true);
  assert.equal(text(31), "Error: Router fetch_messages failed: invalid_args");
  assert.equal(text(32), path.join(absoluteSaveDir, "first.txt"));
  assert.equal(text(33), path.join(absoluteSaveDir, "second.txt"));
  assert.equal(fs.readFileSync(path.join(absoluteSaveDir, "first.txt"), "utf8"), "first file");
  assert.equal(fs.readFileSync(path.join(absoluteSaveDir, "second.txt"), "utf8"), "second file");
  assert.equal(text(34), "Error: Router download_attachment failed: not_found");
  assert.equal(text(35), "Error: Router download_attachment failed: invalid_args");
  assert.equal(text(36), "Error: Router download_attachment failed: not_found");
  assert.equal(text(37), "Error: Failed to download: 503");
  assert.equal(text(38), "Error: Blocked unexpected fetch egress: https://example.com/blocked.txt");
  for (const id of [31, 34, 35, 36, 37, 38]) assert.equal(output.get(id).result.isError, true);

  const discord = readState(workspace.stateDir).fixtures.discord;
  assert.deepEqual(
    discord.attachmentFetches.map((entry) => entry.url).sort(),
    [
      "https://cdn.discordapp.com/attachments/channel/message/failure.txt",
      "https://cdn.discordapp.com/attachments/channel/message/first.txt",
      "https://cdn.discordapp.com/attachments/channel/message/second.txt",
    ].sort(),
  );
  // The MCP caps the page at 100; the Router refuses a negative limit before
  // reading, so only one page was requested.
  assert.deepEqual(discord.historyFetches.map((fetch) => fetch.limit), [100]);
  assert.deepEqual(readState(workspace.stateDir).fixtures.network.blocked.at(-1), {
    kind: "fetch",
    target: "https://example.com/blocked.txt",
  });
});

test("Discord MCP surfaces fake REST API errors as MCP error content", async () => {
  // A short wait bound, so the Router reports a rate limit it cannot outlast.
  const { workspace, router } = await betaRouter({ routerOptions: { env: { CCDM_ROUTER_RATE_LIMIT_MAX_WAIT_MS: "200" } } });
  const statuses = [400, 401, 403, 404, 503, 429];
  seedDiscord(workspace, (discord) => {
    discord.restFailures = statuses.map((status) => ({
      method: "POST",
      path: BETA_WEBHOOK_EXECUTE,
      status,
      body:
        status === 429
          ? { message: "rate limited", retry_after: 1.25, global: false }
          : { message: `status ${status}` },
    }));
  });

  const result = await runMcp(
    workspace,
    statuses.map((status) => toolCall(status, "reply", { text: `status ${status}` })),
    betaMcpEnv(workspace),
  );

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  const output = responseById(result);
  for (const status of [400, 401, 403, 404, 503]) {
    assert.deepEqual(output.get(status).result, {
      content: [{ type: "text", text: "Error: Router reply failed: discord_error" }],
      isError: true,
    });
    await router.waitForOutput(new RegExp(`op_failed project=beta op=reply error=Discord API ${status}: status ${status}`));
  }
  // The Router never passes a raw 429 on: past its wait bound it is rate_limited.
  assert.deepEqual(output.get(429).result, {
    content: [{ type: "text", text: "Error: Router reply failed: rate_limited" }],
    isError: true,
  });
  assert.deepEqual(
    readState(workspace.stateDir).fixtures.discord.restFailureUses.map((entry) => entry.status),
    [400, 401, 403, 404, 503, 429],
  );
  assert.deepEqual(webhookMessages(workspace), []);
});
