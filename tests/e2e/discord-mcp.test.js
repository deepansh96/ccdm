import assert from "node:assert/strict";
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
    ["reply", "edit_message", "react", "fetch_messages", "download_attachment"],
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
