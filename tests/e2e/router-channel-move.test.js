import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";
import test from "node:test";

import { injectDiscordMessage, startFakeCodexServer, waitForState } from "./support/bridge.js";
import { runScript } from "./support/runner.js";
import {
  OWNER_ID,
  connectSession,
  createRouterWorkspace,
  routerEnv,
  routerRegistry,
  routerWithWebhooks,
  runRouterCli,
  waitFor,
} from "./support/router.js";
import { readState, updateState } from "./support/state.js";
import { registerTeardownCallback } from "./support/teardown.js";
import { cleanup } from "./support/teardown.js";

// A registry channel move reaches running sessions: the Router pushes the new
// Session Scope to the project's connections, and each adapter retargets its
// inbound filter and its implicit tool channel.

test.afterEach(async () => {
  await cleanup();
});

function readRegistry(workspace) {
  return JSON.parse(fs.readFileSync(path.join(workspace.repoDir, "registry.json"), "utf8"));
}

// Moves only the project's registered channel, keeping its webhook_id, as an
// atomic replace, and waits for the Router to reload it.
async function moveChannel(workspace, router, project, channelId) {
  await new Promise((resolve) => setTimeout(resolve, 100));
  const reloads = () => router.stdout.split("registry reloaded").length - 1;
  const before = reloads();
  const next = readRegistry(workspace);
  next.projects[project].channel_id = channelId;
  const file = path.join(workspace.repoDir, "registry.json");
  fs.writeFileSync(`${file}.edit`, `${JSON.stringify(next, null, 2)}\n`);
  fs.renameSync(`${file}.edit`, file);
  await waitFor(() => reloads() > before, () => `registry reload:\n${router.stdout}\n${router.stderr}`);
}

function seedHistory(workspace, channelId, messages) {
  updateState(workspace.stateDir, (state) => {
    state.fixtures.discord.history ||= {};
    state.fixtures.discord.history[channelId] = messages;
  });
}

// Newest first, as Discord returns it; each channel's history is distinct.
const history = (channelId, id, content) => [{
  id, channel_id: channelId, timestamp: "2026-10-01T10:00:00.000Z", content,
  author: { id: OWNER_ID, username: "Owner" }, attachments: [],
}];
const MOVED_READ = `[2026-10-01T10:00:00.000Z] Owner: in the new channel (id: 2001)`;

function projectWorkspace(type) {
  const workspace = createRouterWorkspace(routerRegistry({
    demo: {
      channel_id: "demo-channel", type, transport: "router",
      screen_name: `demo_${type}`, session_id: null, pid: null,
    },
  }));
  const registryFile = path.join(workspace.repoDir, "registry.json");
  const registry = JSON.parse(fs.readFileSync(registryFile, "utf8"));
  registry.projects.demo.path = workspace.tmpDir;
  fs.writeFileSync(registryFile, `${JSON.stringify(registry, null, 2)}\n`);
  seedHistories(workspace);
  return workspace;
}

function seedHistories(workspace) {
  seedHistory(workspace, "demo-channel", history("demo-channel", "1001", "in the old channel"));
  seedHistory(workspace, "moved-channel", history("moved-channel", "2001", "in the new channel"));
}

test("a connected listener and an op-only connection both adopt the moved channel from the Router", async () => {
  const workspace = createRouterWorkspace();
  seedHistories(workspace);
  const router = await routerWithWebhooks(workspace, ["demo"]);
  const listener = await connectSession(workspace, "demo", "demo-key");
  const { RouterClient } = createRequire(import.meta.url)(path.join(workspace.repoDir, "scripts/router/client.js"));
  const opOnly = new RouterClient({ socketPath: workspace.socketPath, project: "demo", key: "demo-key", listener: false });
  registerTeardownCallback(() => opOnly.close());
  await opOnly.connect();
  const moves = [];
  listener.client.on("scope_changed", (scope) => moves.push(["listener", scope]));
  opOnly.on("scope_changed", (scope) => moves.push(["op", scope]));
  assert.equal(listener.client.scope.channel_id, "demo-channel");

  await moveChannel(workspace, router, "demo", "moved-channel");

  await waitFor(() => moves.length === 2, () => `scope changes: ${JSON.stringify(moves)}`);
  const moved = { project: "demo", channel_id: "moved-channel", type: "claude" };
  assert.deepEqual(moves.sort(), [["listener", moved], ["op", moved]]);
  assert.deepEqual([listener.client.scope, opOnly.scope], [moved, moved]);
  const read = await opOnly.request("read_last_x_messages_in_channel", { channel_id: "moved-channel", count: 1 });
  assert.equal(read.text, MOVED_READ);
  const status = await runRouterCli(workspace, ["status"]);
  assert.match(status.stdout, /project demo scope=moved-channel connected=/);
});

test("the client adopts scope changes only for its own project, with a channel, after hello", async () => {
  const workspace = createRouterWorkspace();
  fs.mkdirSync(workspace.routerStateDir, { recursive: true, mode: 0o700 });
  const frame = (value) => `${JSON.stringify(value)}\n`;
  const scopeChanged = (scope) => frame({ type: "event", event: "scope_changed", scope });
  const server = net.createServer((socket) => {
    // Before hello_ok: ignored.
    socket.write(scopeChanged({ project: "demo", channel_id: "early-channel", type: "claude" }));
    socket.once("data", () => {
      socket.write(frame({ type: "hello_ok", v: 1, scope: { project: "demo", channel_id: "demo-channel", type: "claude" } }));
      socket.write(scopeChanged({ project: "beta", channel_id: "beta-channel", type: "codex" }));
      socket.write(scopeChanged({ project: "demo", channel_id: "", type: "claude" }));
      socket.write(scopeChanged({ project: "demo", channel_id: 42, type: "claude" }));
      socket.write(scopeChanged("moved-channel"));
      socket.write(scopeChanged({ project: "demo", channel_id: "moved-channel", type: "claude" }));
    });
  });
  await new Promise((resolve) => server.listen(workspace.socketPath, resolve));
  registerTeardownCallback(() => new Promise((resolve) => server.close(resolve)));
  const { RouterClient } = createRequire(import.meta.url)(path.join(workspace.repoDir, "scripts/router/client.js"));
  const client = new RouterClient({ socketPath: workspace.socketPath, project: "demo", key: "demo-key" });
  registerTeardownCallback(() => client.close());
  const moves = [];
  client.on("scope_changed", (scope) => moves.push(scope.channel_id));

  await client.connect();

  await waitFor(() => moves.length > 0, () => "a scope change");
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(moves, ["moved-channel"]);
  assert.equal(client.scope.channel_id, "moved-channel");
});

test("after a registry channel move, a Claude session hears the new channel and its tools target it", async () => {
  const workspace = projectWorkspace("claude");
  const router = await routerWithWebhooks(workspace, ["demo"]);
  updateState(workspace.stateDir, (state) => {
    state.fixtures.claude.toolScript = [
      { name: "reply", arguments: { chat_id: "{{chat_id}}", text: "heard you" } },
      { name: "read_last_x_messages_in_channel", arguments: { count: 1 } },
      { name: "export_message_range", arguments: { start_message_id: "2001" } },
    ];
  });
  const started = await runScript(workspace, "scripts/start-session.sh", { args: ["demo"], env: routerEnv(workspace) });
  assert.equal(started.exitCode, 0, started.stderr || started.stdout);

  await moveChannel(workspace, router, "demo", "moved-channel");
  injectDiscordMessage(workspace, {
    id: "owner-moved-1", channelId: "moved-channel", content: "over here",
    createdTimestamp: Date.parse("2026-10-01T10:05:00.000Z"), author: { id: OWNER_ID, username: "Owner" },
  });

  const done = await waitForState(workspace, (next) => (next.fixtures.claude.toolResults?.length ?? 0) >= 3, 15000);
  assert.deepEqual(done.fixtures.claude.channelNotifications.map(({ content, meta }) => [meta.chat_id, content]),
    [["moved-channel", "over here"]]);
  const [reply, read, exported] = done.fixtures.claude.toolResults;
  assert.deepEqual(reply.result, { content: [{ type: "text", text: "sent (id: fake-message-1)" }] }, router.stdout);
  assert.deepEqual(read.result, { content: [{ type: "text", text: MOVED_READ }] }, router.stdout);
  assert.match(exported.result.content[0].text, /^exported to /, router.stdout);
  assert.equal(exported.result.isError, undefined);
  assert.deepEqual(done.fixtures.discord.messages.map(({ channelId, content }) => ({ channelId, content })),
    [{ channelId: "moved-channel", content: "heard you" }]);
  assert.doesNotMatch(router.stdout, /scope_violation/);
});

test("after a registry channel move, a Codex bridge hears the new channel and its tools target it", async () => {
  const workspace = projectWorkspace("codex");
  fs.mkdirSync(path.join(workspace.homeDir, ".codex"), { recursive: true });
  const codex = await startFakeCodexServer(workspace, {
    channelId: "demo-channel",
    turns: [{ mcpCalls: () => [
      ["reply", { text: "heard you" }],
      ["read_last_x_messages_in_channel", { count: 1 }],
    ] }],
  });
  const registryFile = path.join(workspace.repoDir, "registry.json");
  const registry = JSON.parse(fs.readFileSync(registryFile, "utf8"));
  registry.projects.demo.ws_port = codex.port;
  fs.writeFileSync(registryFile, `${JSON.stringify(registry, null, 2)}\n`);
  const router = await routerWithWebhooks(workspace, ["demo"]);
  const started = await runScript(workspace, "scripts/start-codex-session.sh",
    { args: ["demo"], env: routerEnv(workspace), timeoutMs: 30000 });
  assert.equal(started.exitCode, 0, started.stderr || started.stdout);

  await moveChannel(workspace, router, "demo", "moved-channel");
  injectDiscordMessage(workspace, {
    id: "owner-moved-1", channelId: "moved-channel", content: "over here", author: { id: OWNER_ID, username: "Owner" },
  });

  const done = await waitForState(workspace, (next) =>
    next.fixtures.codex.protocolEvents.filter((event) => event.event === "mcp-tool-result").length >= 2, 20000);
  const results = done.fixtures.codex.protocolEvents.filter((event) => event.event === "mcp-tool-result");
  assert.deepEqual(results.map(({ tool, result, error }) => [tool, error ?? result?.content?.[0]?.text]), [
    ["reply", "sent (id: fake-message-1)"],
    ["read_last_x_messages_in_channel", MOVED_READ],
  ], router.stdout);
  assert.deepEqual(readState(workspace.stateDir).fixtures.discord.messages.map(({ channelId, content }) => ({ channelId, content })),
    [{ channelId: "moved-channel", content: "heard you" }]);
  const turnInputs = done.fixtures.codex.protocolEvents.filter((event) => event.event === "client-message"
    && event.message.method === "turn/start").map((event) => JSON.stringify(event.message.params.input));
  assert.ok(turnInputs.some((input) => input.includes("over here")), turnInputs.join("\n"));
  assert.doesNotMatch(router.stdout, /scope_violation/);
});
