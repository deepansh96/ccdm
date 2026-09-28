import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { createWorkspace } from "./support/runner.js";
import { cleanup, registerTeardownCallback } from "./support/teardown.js";

test.afterEach(async () => { await cleanup(); });

// The official Discord plugin 0.0.4 tool set (server.ts ListTools handler).
const OFFICIAL_TOOLS = ["reply", "react", "edit_message", "download_attachment", "fetch_messages"];

// A Local Fake of the official Discord plugin speaking MCP over stdio. It emits
// the given channel notifications once Claude reports it is initialized, and
// answers every tool call it receives with a delivered-message receipt.
function writeFakePlugin(workspace, { notifications = [], tools = OFFICIAL_TOOLS } = {}) {
  const fake = path.join(workspace.tmpDir, "fake-official-discord.cjs");
  fs.writeFileSync(fake, `
process.stdin.setEncoding("utf8");
let buffer = "";
const write = value => process.stdout.write(JSON.stringify(value) + "\\n");
process.stdin.on("data", chunk => {
  buffer += chunk;
  for (let end; (end = buffer.indexOf("\\n")) >= 0;) {
    const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
    if (!line) continue;
    const request = JSON.parse(line);
    if (request.method === "initialize") write({ jsonrpc: "2.0", id: request.id, result: {
      protocolVersion: "2025-03-26", capabilities: { experimental: { "claude/channel": {} }, tools: {} },
      serverInfo: { name: "discord", version: "1.0.0" }, instructions: "Official Discord reply" } });
    if (request.method === "notifications/initialized") {
      for (const params of ${JSON.stringify(notifications)}) write({ jsonrpc: "2.0", method: "notifications/claude/channel", params });
    }
    if (request.method === "tools/list") write({ jsonrpc: "2.0", id: request.id, result: { tools: ${JSON.stringify(tools)}.map(name => ({
      name, inputSchema: { type: "object", properties: { chat_id: { type: "string" }, text: { type: "string" } }, required: ["chat_id", "text"] },
    })) } });
    if (request.method === "tools/call") write({ jsonrpc: "2.0", id: request.id,
      result: { content: [{ type: "text", text: "sent (id: plugin-delivered-" + request.id + ")" }] } });
  }
});
`);
  return fake;
}

// Starts the proxy the way Claude Code runs an MCP server: a child process
// whose stdin/stdout carry newline-delimited JSON-RPC.
function startProxy(workspace, fake, env = {}) {
  const child = spawn(process.execPath, [path.join(workspace.repoDir, "scripts", "claude-reminder-channel.js")], {
    cwd: workspace.repoDir,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...workspace.env,
      CCDM_REMINDER_PROJECT_ROOT: workspace.repoDir,
      CCDM_REMINDER_STATE_DIR: path.join(workspace.homeDir, ".local", "state", "ccdm", "conversation-reminders"),
      CCDM_CLAUDE_PLUGIN_COMMAND: process.execPath,
      CCDM_CLAUDE_PLUGIN_ARGS: JSON.stringify([fake]),
      CCDM_CLAUDE_REMINDER_ADAPTER: "0",
      CCDM_CLAUDE_PROJECT: "demo",
      CCDM_CLAUDE_CHANNEL_ID: "channel-1",
      CCDM_CLAUDE_BOT_APP_ID: "app-1",
      CCDM_CLAUDE_ROOT_APP_ID: "root-app",
      ...env,
    },
  });
  const exited = new Promise(resolve => child.once("exit", resolve));
  const proxy = { output: "", errors: "", exited };
  child.stdout.on("data", chunk => { proxy.output += chunk; });
  child.stderr.on("data", chunk => { proxy.errors += chunk; });
  proxy.send = value => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n");
  proxy.until = async (predicate, label) => {
    for (let attempt = 0; attempt < 250 && !predicate(proxy.output); attempt++) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.ok(predicate(proxy.output), `proxy never produced ${label}: ${proxy.output}\n${proxy.errors}`);
  };
  proxy.messages = () => proxy.output.split("\n").filter(Boolean).map(line => JSON.parse(line));
  proxy.notifications = () => proxy.messages().filter(message => message.method === "notifications/claude/channel");
  proxy.response = id => proxy.messages().find(message => message.id === id);
  proxy.call = async (id, name, args) => {
    proxy.send({ id, method: "tools/call", params: { name, arguments: args } });
    await proxy.until(() => proxy.response(id), `a response to call ${id}`);
    return proxy.response(id);
  };
  proxy.stop = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await exited;
  };
  registerTeardownCallback(() => proxy.stop());
  return proxy;
}

// Performs Claude Code's MCP handshake and lists tools, which also starts the
// fake plugin's notification burst.
async function initialize(proxy) {
  proxy.send({ id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {},
    clientInfo: { name: "claude-code", version: "2.1.281" } } });
  await proxy.until(() => proxy.response(1), "the initialize response");
  proxy.send({ method: "notifications/initialized" });
  proxy.send({ id: 2, method: "tools/list" });
  await proxy.until(() => proxy.response(2), "the tool list");
}

async function settle(ms = 300) {
  await new Promise(resolve => setTimeout(resolve, ms));
}

function notification(chatId, messageId, content) {
  return { content, meta: { chat_id: chatId, message_id: messageId, user_id: "owner-id", user: "owner", ts: "2026-09-28T00:00:00.000Z" } };
}

test("a Channel Conversation proxy forwards project-channel messages and drops thread traffic and reserved commands", async () => {
  const workspace = createWorkspace();
  const fake = writeFakePlugin(workspace, { notifications: [
    notification("thread-under-channel-1", "thread-message-1", "hello from a thread"),
    notification("channel-1", "reserved-thread", "/thread fix the login bug --model claude-opus-5-5"),
    notification("channel-1", "reserved-config", "/config"),
    notification("channel-1", "reserved-close", "/close"),
    notification("channel-1", "channel-message-1", "hello from the channel"),
  ] });
  const proxy = startProxy(workspace, fake);
  await initialize(proxy);
  await proxy.until(output => output.includes("channel-message-1"), "the channel message");
  await settle();
  await proxy.stop();

  assert.deepEqual(proxy.notifications().map(item => item.params.meta.message_id), ["channel-message-1"]);
  assert.equal(proxy.notifications()[0].params.content, "hello from the channel");
});

test("a proxy launched without the reminder adapter records no reminder capability or events", async () => {
  const workspace = createWorkspace();
  fs.writeFileSync(path.join(workspace.repoDir, "registry.json"), JSON.stringify({
    discord_user_id: "owner-id",
    root_bot_app_id: "root-app",
    pool: [{ id: "bot-1", app_id: "app-1", token: "fixture-token", state_dir: path.join(workspace.homeDir, ".claude", "channels", "discord-demo") }],
    projects: { demo: { type: "claude", path: workspace.repoDir, bot_id: "bot-1", channel_id: "channel-1", screen_name: "demo_claude" } },
  }));
  const fake = writeFakePlugin(workspace, { notifications: [notification("channel-1", "channel-message-1", "hello"), notification("channel-1", "close-1", "/close")] });
  const proxy = startProxy(workspace, fake);
  await initialize(proxy);
  await proxy.until(output => output.includes("channel-message-1"), "the channel message");
  await settle();
  const reminderState = path.join(workspace.homeDir, ".local", "state", "ccdm", "conversation-reminders");
  assert.equal(fs.existsSync(path.join(reminderState, "capabilities", "demo", "channel-1.json")), false);
  await proxy.stop();

  const tools = proxy.response(2).result.tools;
  assert.deepEqual(tools.find(tool => tool.name === "reply").inputSchema.required, ["chat_id", "text"]);
  assert.equal(proxy.response(1).result.instructions, "Official Discord reply");
  assert.deepEqual(proxy.notifications().map(item => item.params.meta.message_id), ["channel-message-1"]);
  assert.equal(fs.existsSync(path.join(reminderState, "outbox")), false);
  assert.equal(fs.existsSync(path.join(reminderState, "events.sqlite3")), false);
});

test("a Channel Conversation proxy refuses a reply aimed at another channel", async () => {
  const workspace = createWorkspace();
  const proxy = startProxy(workspace, writeFakePlugin(workspace));
  await initialize(proxy);
  const elsewhere = await proxy.call(10, "reply", { chat_id: "channel-2", text: "misdirected" });
  const inThread = await proxy.call(11, "reply", { chat_id: "thread-under-channel-1", text: "misdirected" });
  const home = await proxy.call(12, "reply", { chat_id: "channel-1", text: "hello" });
  await proxy.stop();

  assert.deepEqual(elsewhere.result, { isError: true, content: [{ type: "text", text: "channel not assigned" }] });
  assert.deepEqual(inThread.result, { isError: true, content: [{ type: "text", text: "channel not assigned" }] });
  assert.equal(home.result.content[0].text, "sent (id: plugin-delivered-12)");
});

test("a Thread Conversation proxy admits only its thread and refuses replies to the parent and siblings", async () => {
  const workspace = createWorkspace();
  const fake = writeFakePlugin(workspace, { notifications: [
    notification("channel-1", "parent-message-1", "hello from the parent channel"),
    notification("thread-sibling", "sibling-message-1", "hello from a sibling thread"),
    notification("thread-own", "own-message-1", "hello from this thread"),
  ] });
  const proxy = startProxy(workspace, fake, { CCDM_CLAUDE_THREAD_ID: "thread-own" });
  await initialize(proxy);
  await proxy.until(output => output.includes("own-message-1"), "the thread message");
  const parent = await proxy.call(10, "reply", { chat_id: "channel-1", text: "misdirected" });
  const sibling = await proxy.call(11, "reply", { chat_id: "thread-sibling", text: "misdirected" });
  const parentRead = await proxy.call(12, "fetch_messages", { channel: "channel-1", limit: 5 });
  const own = await proxy.call(13, "reply", { chat_id: "thread-own", text: "hello" });
  await settle();
  await proxy.stop();

  assert.deepEqual(proxy.notifications().map(item => item.params.meta.message_id), ["own-message-1"]);
  for (const refused of [parent, sibling, parentRead]) {
    assert.deepEqual(refused.result, { isError: true, content: [{ type: "text", text: "channel not assigned" }] });
  }
  assert.equal(own.result.content[0].text, "sent (id: plugin-delivered-13)");
});

test("a Thread Conversation proxy delivers its launcher's bootstrap exactly once and drops live copies of included messages", async () => {
  const workspace = createWorkspace();
  // The plugin's Gateway reports a message the owner sent during boot, and one
  // sent after it, before the launcher has handed over the bootstrap.
  const fake = writeFakePlugin(workspace, { notifications: [
    notification("thread-own", "boot-message-1", "sent while booting"),
    notification("thread-own", "after-boot-1", "sent after the handoff"),
  ] });
  const bootstrapFile = path.join(workspace.tmpDir, "thread-own-bootstrap.json");
  const bootstrap = {
    content: "You are in the Discord thread \"login bug\". Reply only here.\n\nstarter message\n\nsent while booting",
    meta: { chat_id: "thread-own", message_id: "boot-message-1", user_id: "owner-id", user: "owner", ts: "2026-09-28T00:00:00.000Z" },
    included_message_ids: ["thread-own", "boot-message-1"],
  };
  const inject = () => {
    fs.writeFileSync(`${bootstrapFile}.tmp`, JSON.stringify(bootstrap));
    fs.renameSync(`${bootstrapFile}.tmp`, bootstrapFile);
  };
  const proxy = startProxy(workspace, fake, { CCDM_CLAUDE_THREAD_ID: "thread-own", CCDM_CLAUDE_BOOTSTRAP_FILE: bootstrapFile });
  await initialize(proxy);
  await settle();
  assert.deepEqual(proxy.notifications(), [], "live thread messages wait for the bootstrap");

  inject();
  await proxy.until(output => output.includes("after-boot-1"), "the post-boot message");
  inject();
  await settle(600);
  await proxy.stop();

  const delivered = proxy.notifications();
  assert.deepEqual(delivered.map(item => item.params.meta.message_id), ["boot-message-1", "after-boot-1"]);
  assert.equal(delivered[0].params.content, bootstrap.content);
  assert.deepEqual(delivered[0].params.meta, bootstrap.meta);
  assert.equal(delivered[1].params.content, "sent after the handoff");
});

test("a Thread Conversation proxy never relays /config, and a hand-over-only bootstrap after a /config restart prompts nothing", async () => {
  const workspace = createWorkspace();
  // The /config that restarted the session, a later /config addressed to the
  // bot, and an owner message sent while the session restarted.
  const fake = writeFakePlugin(workspace, { notifications: [
    notification("thread-own", "config-1", "/config model=claude-sonnet-5"),
    notification("thread-own", "config-2", "<@app-1> /config"),
    notification("thread-own", "after-restart-1", "carry on"),
  ] });
  const bootstrapFile = path.join(workspace.tmpDir, "thread-own-bootstrap.json");
  const proxy = startProxy(workspace, fake, { CCDM_CLAUDE_THREAD_ID: "thread-own", CCDM_CLAUDE_BOOTSTRAP_FILE: bootstrapFile });
  await initialize(proxy);
  await settle();
  fs.writeFileSync(`${bootstrapFile}.tmp`, JSON.stringify({ included_message_ids: ["config-1"] }));
  fs.renameSync(`${bootstrapFile}.tmp`, bootstrapFile);
  await proxy.until(output => output.includes("after-restart-1"), "the message sent during the restart");
  await settle();
  await proxy.stop();

  assert.deepEqual(proxy.notifications().map(item => [item.params.meta.message_id, item.params.content]),
    [["after-restart-1", "carry on"]]);
  assert.doesNotMatch(proxy.errors, /invalid thread bootstrap/);
});

test("a Thread Conversation proxy never relays in-thread management commands", async () => {
  const workspace = createWorkspace();
  const commands = ["/restart", "/clear", "/compact", "/pause", "/unpause", "/close", "<@app-1> /restart"];
  const fake = writeFakePlugin(workspace, { notifications: [
    ...commands.map((content, index) => notification("thread-own", `command-${index}`, content)),
    notification("thread-own", "owner-1", "/clearly a question, not a command"),
  ] });
  const bootstrapFile = path.join(workspace.tmpDir, "thread-own-bootstrap.json");
  const proxy = startProxy(workspace, fake, { CCDM_CLAUDE_THREAD_ID: "thread-own", CCDM_CLAUDE_BOOTSTRAP_FILE: bootstrapFile });
  await initialize(proxy);
  await settle();
  fs.writeFileSync(`${bootstrapFile}.tmp`, JSON.stringify({ included_message_ids: [] }));
  fs.renameSync(`${bootstrapFile}.tmp`, bootstrapFile);
  await proxy.until(output => output.includes("owner-1"), "the ordinary message");
  await settle();
  await proxy.stop();

  assert.deepEqual(proxy.notifications().map(item => item.params.meta.message_id), ["owner-1"]);
});

test("a proxy fails closed with no tools when the plugin lacks the expected Discord tools", async () => {
  const workspace = createWorkspace();
  const fake = writeFakePlugin(workspace, {
    tools: ["reply", "react", "edit_message", "download_attachment"],
    notifications: [notification("channel-1", "channel-message-1", "hello")],
  });
  const proxy = startProxy(workspace, fake);
  await initialize(proxy);
  const reply = await proxy.call(10, "reply", { chat_id: "channel-1", text: "hello" });
  await settle();
  await proxy.stop();

  assert.deepEqual(proxy.response(2).result.tools, []);
  assert.equal(reply.result.isError, true);
  assert.doesNotMatch(JSON.stringify(reply), /plugin-delivered/);
  assert.deepEqual(proxy.notifications(), []);
  assert.match(proxy.errors, /official Discord tools are missing: fetch_messages/);
});
