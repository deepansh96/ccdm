import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { bridgeChildEnv, createBridgeWorkspace, runPreloadProbe } from "./support/bridge.js";
import { runNodeEntrypoint } from "./support/runner.js";
import { readState, writeState } from "./support/state.js";
import { cleanup } from "./support/teardown.js";

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

async function runMcp(workspace, lines, options = {}) {
  return await runNodeEntrypoint(workspace, "scripts/discord-mcp-server.js", {
    env: bridgeChildEnv(workspace, {
      BOT_TOKEN: "bot-token",
      CCDM_TEST_FORM_DATA_SHIM: "1",
      CHANNEL_ID: "channel-id",
      ...(options.env ?? {}),
    }),
    input: `${lines.join("\n")}\n`,
    timeoutMs: options.timeoutMs ?? 5000,
  });
}

function responses(result) {
  return result.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function responseById(result) {
  return new Map(responses(result).map((entry) => [entry.id, entry]));
}

test("Discord MCP initializes, lists tools, accepts initialized notifications, and replies with text", async () => {
  const workspace = createBridgeWorkspace();

  const result = await runMcp(workspace, [
    rpc(1, "initialize", {}),
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    rpc(2, "tools/list", {}),
    toolCall(3, "reply", { text: "hello Discord", reply_to: "parent-message" }),
  ]);

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  const output = responses(result);
  assert.equal(output[0].result.serverInfo.name, "discord-mcp");
  assert.deepEqual(
    output[1].result.tools.map((tool) => tool.name),
    ["reply", "edit_message", "react", "fetch_messages", "export_message_range", "download_attachment"],
  );
  const replyTool = output[1].result.tools.find((tool) => tool.name === "reply");
  assert.match(replyTool.inputSchema.properties.files.description, /Max 10 files, 25MB each/);
  assert.deepEqual(output[2].result.content, [{ type: "text", text: "sent (id: fake-message-1)" }]);

  const discord = readState(workspace.stateDir).fixtures.discord;
  assert.deepEqual(discord.messages[0], {
    authorization: "Bot bot-token",
    channelId: "channel-id",
    content: "hello Discord",
    id: "fake-message-1",
    messageReference: { message_id: "parent-message" },
  });
});

test("Discord MCP exports a message range through the latest message", async () => {
  const workspace = createBridgeWorkspace();
  const state = readState(workspace.stateDir);
  state.fixtures.discord.restMessages = [
    { id: "103", timestamp: "2026-07-13T10:02:00.000Z", content: "latest", author: { id: "2", username: "Bob" }, attachments: [] },
    { id: "102", timestamp: "2026-07-13T10:01:00.000Z", content: "start", author: { id: "1", username: "Alice" }, attachments: [] },
    { id: "101", timestamp: "2026-07-13T10:00:00.000Z", content: "older", author: { id: "1", username: "Alice" }, attachments: [] },
  ];
  writeState(state, workspace.stateDir);

  const result = await runMcp(
    workspace,
    [toolCall(1, "export_message_range", { start_message_id: "102" })],
    { env: { CHANNEL_ID: "100" } },
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

test("Discord MCP export-only mode hides and rejects all other tools", async () => {
  const workspace = createBridgeWorkspace();
  const result = await runNodeEntrypoint(workspace, "scripts/discord-mcp-server.js", {
    env: bridgeChildEnv(workspace, {
      BOT_TOKEN: "",
      CHANNEL_ID: "channel-id",
      DISCORD_MCP_EXPORT_ONLY: "1",
    }),
    input: `${rpc(1, "tools/list", {})}\n${toolCall(2, "reply", { text: "hidden" })}\n`,
  });

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  const output = responseById(result);
  assert.deepEqual(output.get(1).result.tools.map((tool) => tool.name), ["export_message_range"]);
  assert.equal(output.get(2).result.isError, true);
  assert.match(output.get(2).result.content[0].text, /unavailable in export-only mode/);
});

test("Discord MCP writes require the bridge scope token when configured", async () => {
  const workspace = createBridgeWorkspace();

  const result = await runMcp(
    workspace,
    [
      rpc(1, "initialize", {}),
      rpc(2, "tools/list", {}),
      toolCall(3, "reply", { text: "missing token" }),
      toolCall(4, "reply", { text: "wrong token", scope_token: "wrong" }),
      toolCall(5, "edit_message", { message_id: "message-1", text: "missing token" }),
      toolCall(6, "react", { message_id: "message-1", emoji: "👍", scope_token: "wrong" }),
      toolCall(7, "reply", { text: "right token", scope_token: "secret-token" }),
      toolCall(8, "edit_message", { message_id: "message-1", text: "right token", scope_token: "secret-token" }),
      toolCall(9, "react", { message_id: "message-1", emoji: "👍", scope_token: "secret-token" }),
    ],
    { env: { DISCORD_REPLY_TOKEN: "secret-token" } },
  );

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  const output = responseById(result);
  const replyTool = output.get(2).result.tools.find((tool) => tool.name === "reply");
  const editTool = output.get(2).result.tools.find((tool) => tool.name === "edit_message");
  const reactTool = output.get(2).result.tools.find((tool) => tool.name === "react");
  assert.deepEqual(replyTool.inputSchema.required, ["text", "scope_token"]);
  assert.deepEqual(editTool.inputSchema.required, ["message_id", "text", "scope_token"]);
  assert.deepEqual(reactTool.inputSchema.required, ["message_id", "emoji", "scope_token"]);
  assert.equal(output.get(3).result.isError, true);
  assert.match(output.get(3).result.content[0].text, /missing or invalid scope token/);
  assert.equal(output.get(4).result.isError, true);
  assert.match(output.get(4).result.content[0].text, /missing or invalid scope token/);
  assert.equal(output.get(5).result.isError, true);
  assert.match(output.get(5).result.content[0].text, /missing or invalid scope token/);
  assert.equal(output.get(6).result.isError, true);
  assert.match(output.get(6).result.content[0].text, /missing or invalid scope token/);
  assert.deepEqual(output.get(7).result.content, [{ type: "text", text: "sent (id: fake-message-1)" }]);
  assert.deepEqual(output.get(8).result.content, [{ type: "text", text: "edited (id: message-1)" }]);
  assert.deepEqual(output.get(9).result.content, [{ type: "text", text: "reacted with 👍" }]);

  const discord = readState(workspace.stateDir).fixtures.discord;
  assert.deepEqual(discord.messages.map((message) => message.content), ["right token"]);
  assert.deepEqual(discord.edits.map((edit) => edit.content), ["right token"]);
  assert.equal(discord.reactions.length, 1);
});

test("Discord MCP root override routes calls to the requested channel", async () => {
  const workspace = createBridgeWorkspace();
  const accessFile = path.join(workspace.tmpDir, "root-access.json");
  const scopeFile = path.join(workspace.tmpDir, "active-scope");
  const scopeSecret = "scope-secret";
  const guestScope = channelScopeToken(scopeSecret, "guest-user", "project-channel");
  const globalScope = channelScopeToken(scopeSecret, "global-user", "project-channel");
  fs.writeFileSync(accessFile, `${JSON.stringify({
    allowFrom: ["global-user"],
    groups: {
      "project-channel": { requireMention: true, allowFrom: ["guest-user"] },
      "other-channel": { requireMention: true, allowFrom: ["other-user"] },
    },
  })}\n`);
  fs.writeFileSync(scopeFile, guestScope);
  const seed = readState(workspace.stateDir);
  seed.fixtures.discord.restMessages = [
    {
      id: "message-1",
      timestamp: "2026-05-28T10:00:00.000Z",
      content: "hello",
      author: { username: "Alice", bot: false },
      attachments: [],
    },
  ];
  writeState(seed, workspace.stateDir);

  const result = await runMcp(
    workspace,
    [
      rpc(1, "tools/list", {}),
      toolCall(2, "reply", { text: "missing channel", scope_token: "secret-token" }),
      toolCall(3, "reply", { text: "to project", channel_id: "project-channel", channel_scope_token: guestScope, scope_token: "secret-token" }),
      toolCall(4, "fetch_messages", { channel_id: "project-channel", channel_scope_token: guestScope, limit: 1 }),
      toolCall(5, "reply", { text: "denied", channel_id: "other-channel", channel_scope_token: guestScope, scope_token: "secret-token" }),
      toolCall(6, "fetch_messages", { channel_id: "other-channel", channel_scope_token: guestScope, limit: 1 }),
      toolCall(9, "fetch_messages", { channel_id: "other-channel", channel_scope_token: globalScope, limit: 1 }),
    ],
    {
      env: {
        DISCORD_ACCESS_FILE: accessFile,
        DISCORD_CHANNEL_OVERRIDE: "1",
        DISCORD_CHANNEL_SCOPE_FILE: scopeFile,
        DISCORD_CHANNEL_SCOPE_SECRET: scopeSecret,
        DISCORD_GLOBAL_USER_IDS: "global-user",
        DISCORD_REPLY_TOKEN: "secret-token",
      },
    },
  );

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  const output = responseById(result);
  const replyTool = output.get(1).result.tools.find((tool) => tool.name === "reply");
  assert.deepEqual(replyTool.inputSchema.required, ["text", "channel_id", "channel_scope_token", "scope_token"]);
  assert.equal(output.get(2).result.isError, true);
  assert.match(output.get(2).result.content[0].text, /channel_id is required/);
  assert.deepEqual(output.get(3).result.content, [{ type: "text", text: "sent (id: fake-message-1)" }]);
  assert.match(output.get(4).result.content[0].text, /Alice: hello/);
  assert.equal(output.get(5).result.isError, true);
  assert.match(output.get(5).result.content[0].text, /other-channel is not allowed for this message/);
  assert.equal(output.get(6).result.isError, true);
  assert.match(output.get(6).result.content[0].text, /other-channel is not allowed for this message/);
  assert.equal(output.get(9).result.isError, true);
  assert.match(output.get(9).result.content[0].text, /scope is missing, expired, or invalid/);

  const discord = readState(workspace.stateDir).fixtures.discord;
  assert.equal(discord.messages[0].channelId, "project-channel");
  assert.equal(discord.fetches[0].channelId, "project-channel");

  fs.writeFileSync(scopeFile, globalScope);
  const globalResult = await runMcp(
    workspace,
    [
      toolCall(7, "reply", { text: "global target", channel_id: "other-channel", channel_scope_token: globalScope, scope_token: "secret-token" }),
      toolCall(8, "fetch_messages", { channel_id: "other-channel", channel_scope_token: globalScope, limit: 1 }),
    ],
    {
      env: {
        DISCORD_ACCESS_FILE: accessFile,
        DISCORD_CHANNEL_OVERRIDE: "1",
        DISCORD_CHANNEL_SCOPE_FILE: scopeFile,
        DISCORD_CHANNEL_SCOPE_SECRET: scopeSecret,
        DISCORD_GLOBAL_USER_IDS: "global-user",
        DISCORD_REPLY_TOKEN: "secret-token",
      },
    },
  );
  const globalOutput = responseById(globalResult);
  assert.equal(globalOutput.get(7).result.isError, undefined);
  assert.equal(globalOutput.get(8).result.isError, undefined);
});

test("Discord MCP reports JSON-RPC errors and drives edit, react, and fetch tools", async () => {
  const workspace = createBridgeWorkspace();
  const seed = readState(workspace.stateDir);
  seed.fixtures.discord.restMessages = [
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
  ];
  writeState(seed, workspace.stateDir);

  const missingEnv = await runNodeEntrypoint(workspace, "scripts/discord-mcp-server.js", {
    env: bridgeChildEnv(workspace, { BOT_TOKEN: "", CHANNEL_ID: "channel-id" }),
    input: "",
  });
  assert.equal(missingEnv.exitCode, 1);
  assert.match(missingEnv.stderr, /Missing BOT_TOKEN or CHANNEL_ID/);

  const result = await runMcp(workspace, [
    "{not json",
    rpc(10, "unknown/method", {}),
    toolCall(11, "edit_message", { message_id: "message-1", text: "updated" }),
    toolCall(12, "react", { message_id: "message-1", emoji: "👍" }),
    toolCall(13, "fetch_messages", { limit: 2 }),
  ]);

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.match(result.stderr, /Parse error/);
  const output = responseById(result);
  assert.equal(output.get(10).error.message, "Method not found: unknown/method");
  assert.deepEqual(output.get(11).result.content, [{ type: "text", text: "edited (id: message-1)" }]);
  assert.deepEqual(output.get(12).result.content, [{ type: "text", text: "reacted with 👍" }]);
  assert.equal(
    output.get(13).result.content[0].text,
    "[2026-05-28T10:00:00.000Z] me: oldest (id: old-message)\n[2026-05-28T10:00:01.000Z] Alice: newest +1att (id: new-message)",
  );

  const discord = readState(workspace.stateDir).fixtures.discord;
  assert.deepEqual(discord.edits[0], {
    authorization: "Bot bot-token",
    channelId: "channel-id",
    content: "updated",
    messageId: "message-1",
  });
  assert.deepEqual(discord.reactions[0], {
    authorization: "Bot bot-token",
    channelId: "channel-id",
    emoji: "%F0%9F%91%8D",
    messageId: "message-1",
  });
  assert.deepEqual(discord.fetches[0], { authorization: "Bot bot-token", channelId: "channel-id", limit: 2 });
});

test("Discord MCP replies with files through the FormData shim and reports upload failures", async () => {
  const workspace = createBridgeWorkspace();
  const smallFile = path.join(workspace.tmpDir, "small.txt");
  const largeFile = path.join(workspace.tmpDir, "large.bin");
  fs.writeFileSync(smallFile, "small file");
  fs.writeFileSync(largeFile, "");
  fs.truncateSync(largeFile, 26 * 1024 * 1024);
  const manyFiles = Array.from({ length: 9 }, (_, index) => {
    const file = path.join(workspace.tmpDir, `extra-${index}.txt`);
    fs.writeFileSync(file, `extra ${index}`);
    return file;
  });

  const missing = await runMcp(workspace, [
    toolCall(20, "reply", { text: "missing", files: [path.join(workspace.tmpDir, "missing.txt")] }),
  ]);
  assert.equal(responseById(missing).get(20).result.isError, true);
  assert.match(responseById(missing).get(20).result.content[0].text, /ENOENT/);

  const success = await runMcp(workspace, [
    toolCall(21, "reply", {
      text: "",
      files: [smallFile, largeFile, ...manyFiles],
      reply_to: "parent-message",
    }),
  ]);
  assert.equal(success.exitCode, 0, success.stderr || success.stdout);
  assert.equal(responseById(success).get(21).result.content[0].text, "sent (id: fake-upload-1)");

  let discord = readState(workspace.stateDir).fixtures.discord;
  assert.equal(discord.uploads[0].authorization, "Bot bot-token");
  assert.equal(discord.uploads[0].channelId, "channel-id");
  assert.equal(discord.uploads[0].payload.content, "");
  assert.deepEqual(discord.uploads[0].payload.message_reference, { message_id: "parent-message" });
  assert.equal(discord.uploads[0].files.length, 11, "current behavior does not enforce the advertised 10-file limit locally");
  assert.ok(
    discord.uploads[0].files.some((file) => file.filename === "large.bin" && file.size === 26 * 1024 * 1024),
    "current behavior does not enforce the advertised 25MB size limit locally",
  );

  const seed = readState(workspace.stateDir);
  seed.fixtures.discord.failures.upload = { status: 500, body: { message: "upload failed" } };
  writeState(seed, workspace.stateDir);
  const failure = await runMcp(workspace, [toolCall(22, "reply", { text: "upload", files: [smallFile] })]);
  assert.equal(responseById(failure).get(22).result.isError, true);
  assert.match(responseById(failure).get(22).result.content[0].text, /Discord API 500: \{"message":"upload failed"\}/);

  discord = readState(workspace.stateDir).fixtures.discord;
  assert.equal(discord.uploadFailures.length, 1);
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
  const workspace = createBridgeWorkspace();
  const seed = readState(workspace.stateDir);
  seed.fixtures.discord.restMessages = [
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
  ];
  seed.fixtures.discord.attachments["https://cdn.discordapp.com/attachments/channel/message/first.txt"] = {
    body: "first file",
  };
  seed.fixtures.discord.attachments["https://cdn.discordapp.com/attachments/channel/message/second.txt"] = {
    body: "second file",
  };
  seed.fixtures.discord.attachments["https://cdn.discordapp.com/attachments/channel/message/failure.txt"] = {
    body: "cdn down",
    status: 503,
  };
  writeState(seed, workspace.stateDir);

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
  ]);

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  const output = responseById(result);
  assert.match(output.get(30).result.content[0].text, /message-with-attachments/);
  assert.equal(output.get(31).result.isError, true);
  assert.match(output.get(31).result.content[0].text, /Discord API 400/);
  assert.equal(output.get(32).result.content[0].text, path.join(absoluteSaveDir, "first.txt"));
  assert.equal(output.get(33).result.content[0].text, path.join(absoluteSaveDir, "second.txt"));
  assert.equal(fs.readFileSync(path.join(absoluteSaveDir, "first.txt"), "utf8"), "first file");
  assert.equal(fs.readFileSync(path.join(absoluteSaveDir, "second.txt"), "utf8"), "second file");
  assert.match(output.get(34).result.content[0].text, /out of range/);
  assert.match(output.get(35).result.content[0].text, /Cannot read/);
  assert.match(output.get(36).result.content[0].text, /Message has no attachments/);
  assert.match(output.get(37).result.content[0].text, /Failed to download: 503/);
  assert.match(output.get(38).result.content[0].text, /Blocked unexpected fetch egress: https:\/\/example\.com\/blocked\.txt/);

  const discord = readState(workspace.stateDir).fixtures.discord;
  assert.deepEqual(
    discord.attachmentFetches.map((entry) => entry.url).sort(),
    [
      "https://cdn.discordapp.com/attachments/channel/message/failure.txt",
      "https://cdn.discordapp.com/attachments/channel/message/first.txt",
      "https://cdn.discordapp.com/attachments/channel/message/second.txt",
    ].sort(),
  );
  assert.equal(discord.fetches[0].limit, 100);
  assert.equal(discord.fetches[1].limit, -1);
});

test("Discord MCP surfaces fake REST API errors as MCP error content", async () => {
  const workspace = createBridgeWorkspace();
  const seed = readState(workspace.stateDir);
  seed.fixtures.discord.restFailures = [400, 401, 403, 404, 429, 503].map((status) => ({
    status,
    body:
      status === 429
        ? { message: "rate limited", retry_after: 1.25, global: false }
        : { message: `status ${status}` },
  }));
  writeState(seed, workspace.stateDir);

  const result = await runMcp(
    workspace,
    [400, 401, 403, 404, 429, 503].map((status) => toolCall(status, "reply", { text: `status ${status}` })),
  );

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  const output = responseById(result);
  for (const status of [400, 401, 403, 404, 429, 503]) {
    assert.equal(output.get(status).result.isError, true);
    assert.match(output.get(status).result.content[0].text, new RegExp(`Discord API ${status}`));
  }
  assert.match(output.get(429).result.content[0].text, /retry_after/);
  assert.deepEqual(
    readState(workspace.stateDir).fixtures.discord.restFailureUses.map((entry) => entry.status),
    [400, 401, 403, 404, 429, 503],
  );
});
