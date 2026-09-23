import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { createWorkspace, runNodeEntrypoint, runScript } from "./support/runner.js";
import { readState, writeState } from "./support/state.js";
import { cleanup } from "./support/teardown.js";
import { bridgeChildEnv, createBridgeWorkspace, injectDiscordMessage, injectDiscordReaction, startBridge, startFakeCodexServer, waitForState } from "./support/bridge.js";

test.afterEach(async () => {
  await cleanup();
});

function writeRegistry(workspace, overrides = {}) {
  const registry = {
    discord_user_id: "owner-id",
    guild_id: "guild-id",
    pool: [{ id: "assigned-bot", app_id: "assigned-app", token: "fixture-bot-token" }],
    projects: {
      demo: {
        type: "codex",
        path: workspace.repoDir,
      screen_name: "demo_codex",
      bot_id: "assigned-bot",
      channel_id: "channel-id",
      assignment_generation: "fixture-generation-1",
      },
    },
    ...overrides,
  };
  fs.writeFileSync(path.join(workspace.repoDir, "registry.json"), `${JSON.stringify(registry)}\n`, { mode: 0o600 });
}

function lifecycleEvent(eventType, eventId, fields = {}) {
  return {
    schema_version: 1,
    event_id: eventId,
    event_type: eventType,
    project: "demo",
    channel_id: "channel-id",
    bot_id: "assigned-bot",
    assignment_generation: "fixture-generation-1",
    provider: "codex",
    provider_session_id: "thread-1",
    provider_turn_id: "turn-1",
    event_time: "2026-09-24T10:00:00.000Z",
    event_order: "0000000001000000:fixture-adapter:000000000001",
    adapter_instance_id: "fixture-adapter",
    interaction_id: "owner-message-1",
    ...fields,
  };
}

async function ingestEvent(workspace, stateDir, event) {
  const result = await runScript(workspace, "scripts/conversation-reminder-events.py", {
    args: ["ingest", "--project-root", workspace.repoDir, "--state-dir", stateDir],
    input: JSON.stringify(event),
  });
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

test("Codex readiness reports an assigned observe-only adapter without invoking a provider", async () => {
  const workspace = createWorkspace();
  writeRegistry(workspace);

  const result = await runScript(workspace, "scripts/conversation-reminder-readiness.py", {
    args: ["demo", "--json"],
  });

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  const readiness = JSON.parse(result.stdout);
  assert.equal(readiness.project, "demo");
  assert.equal(readiness.provider, "codex");
  assert.equal(readiness.delivery_enabled, false);
  assert.equal(readiness.reminders_enabled, false);
  assert.equal(readiness.assignment.channel_id, "channel-id");
  assert.equal(readiness.assignment.bot_id, "assigned-bot");
  assert.equal(readiness.assignment.generation, "fixture-generation-1");
  assert.deepEqual(readiness.missing_credentials, []);
  assert.deepEqual(readiness.assignment_mismatches, []);
  assert.deepEqual(readiness.unsupported_capabilities, []);
  assert.equal(readiness.event_receiver.available, true);
  assert.deepEqual(readiness.events, []);
  assert.doesNotMatch(result.stdout, /fixture-bot-token/);
  assert.equal(readState(workspace.stateDir).fixtures.codex.appServerInvocations.length, 0);
});

test("event receiver binds receipts to the registered assignment and requires a successful input-needed delivery", async () => {
  const workspace = createWorkspace();
  writeRegistry(workspace);
  const stateDir = path.join(workspace.homeDir, ".local", "state", "ccdm", "conversation-reminders");

  const progressReceipt = lifecycleEvent(
    "response_delivered",
    "11111111-1111-4111-8111-111111111111",
    { message_id: "discord-message-progress", disposition: "progress" },
  );
  assert.equal((await ingestEvent(workspace, stateDir, progressReceipt)).status, "committed");
  const emptyCompletion = lifecycleEvent(
    "turn_completed",
    "66666666-6666-4666-8666-666666666666",
    { delivered_message_ids: [] },
  );
  assert.equal((await ingestEvent(workspace, stateDir, emptyCompletion)).status, "rejected");
  const unsupportedInputNeeded = lifecycleEvent(
    "input_needed",
    "22222222-2222-4222-8222-222222222222",
    { message_id: "discord-message-progress", disposition: "input-needed" },
  );
  assert.equal((await ingestEvent(workspace, stateDir, unsupportedInputNeeded)).status, "rejected");

  const questionReceipt = lifecycleEvent(
    "response_delivered",
    "33333333-3333-4333-8333-333333333333",
    { message_id: "discord-message-question", disposition: "input-needed" },
  );
  assert.equal((await ingestEvent(workspace, stateDir, questionReceipt)).status, "committed");
  const inputNeeded = lifecycleEvent(
    "input_needed",
    "44444444-4444-4444-8444-444444444444",
    { message_id: "discord-message-question", disposition: "input-needed" },
  );
  assert.equal((await ingestEvent(workspace, stateDir, inputNeeded)).status, "committed");
  assert.equal((await ingestEvent(workspace, stateDir, questionReceipt)).status, "duplicate");

  const staleReceipt = lifecycleEvent(
    "response_delivered",
    "55555555-5555-4555-8555-555555555555",
    { bot_id: "obsolete-bot", message_id: "stale-message", disposition: "progress" },
  );
  assert.equal((await ingestEvent(workspace, stateDir, staleReceipt)).status, "stale");

  const readinessResult = await runScript(workspace, "scripts/conversation-reminder-readiness.py", {
    args: ["demo", "--json", "--state-dir", stateDir],
  });
  assert.equal(readinessResult.exitCode, 0, readinessResult.stderr || readinessResult.stdout);
  const readiness = JSON.parse(readinessResult.stdout);
  assert.deepEqual(readiness.events.map((row) => row.event_type), ["response_delivered", "response_delivered", "input_needed"]);
  assert.equal(readiness.events.at(-1).message_id, "discord-message-question");
  assert.equal(readiness.event_receiver.event_count, 3);
  assert.equal(fs.statSync(path.join(stateDir, "events.sqlite3")).mode & 0o777, 0o600);
  assert.doesNotMatch(fs.readFileSync(path.join(stateDir, "events.sqlite3"), "utf8"), /question body|fixture-bot-token/);
});

test("owner /close is recorded before Codex dispatch and does not start a turn", async () => {
  const workspace = createBridgeWorkspace();
  writeRegistry(workspace, { discord_user_id: "allowed-user-id" });
  const codex = await startFakeCodexServer(workspace);
  const bridge = startBridge(workspace, { port: codex.port, botAppId: "assigned-app" });
  await bridge.waitForOutput(/Listening in #channel-channel-id/, 7000);

  injectDiscordMessage(workspace, { id: "close-message-1", content: "  /close  " });
  await waitForState(workspace, (state) => state.fixtures.discord.deliveredMessages.some((message) => message.id === "close-message-1"));
  const result = await runScript(workspace, "scripts/conversation-reminder-readiness.py", { args: ["demo", "--json"] });
  const readiness = JSON.parse(result.stdout);
  assert.deepEqual(readiness.events.map((event) => event.event_type), ["close_requested"]);
  assert.equal(readiness.events[0].source_message_id, "close-message-1");
  assert.equal(codex.clientMessages.filter((message) => message.method === "turn/start").length, 1);
  await bridge.stop();
});

test("a successful scoped Codex reply produces a progress receipt and a completed response", async () => {
  const workspace = createBridgeWorkspace();
  writeRegistry(workspace, { discord_user_id: "allowed-user-id" });
  const codex = await startFakeCodexServer(workspace, {
    turns: [{ turnId: "answer-turn", status: "completed", waitForRelease: true, mcpReply: true }],
  });
  const bridge = startBridge(workspace, { port: codex.port, botAppId: "assigned-app" });
  await bridge.waitForOutput(/Listening in #channel-channel-id/, 7000);
  injectDiscordMessage(workspace, { id: "owner-message-1", content: "answer this" });
  await waitForState(workspace, (state) => state.fixtures.discord.deliveredMessages.some((message) => message.id === "owner-message-1"));
  const config = codex.clientMessages.find((message) => message.method === "config/value/write" && message.params.keyPath === "mcp_servers.discord-channel-id");
  const contextFile = config.params.value.env.CCDM_REMINDER_CONTEXT_FILE;
  for (let attempt = 0; attempt < 100 && !fs.existsSync(contextFile); attempt++) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(fs.existsSync(contextFile), `${bridge.stdout}\n${bridge.stderr}\n${JSON.stringify(codex.clientMessages.filter((message) => message.method === "turn/start"))}`);
  const reply = await runNodeEntrypoint(workspace, "scripts/discord-mcp-server.js", {
    env: bridgeChildEnv(workspace, config.params.value.env),
    input: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "reply", arguments: { text: "Here is the answer", scope_token: config.params.value.env.DISCORD_REPLY_TOKEN } } }) + "\n",
  });
  assert.ok(reply.stdout.trim(), JSON.stringify({ exitCode: reply.exitCode, stderr: reply.stderr, stdout: reply.stdout }));
  assert.equal(JSON.parse(reply.stdout).result.content[0].text, "sent (id: fake-message-1)");
  codex.releaseTurn("answer-turn");
  await new Promise((resolve) => setTimeout(resolve, 200));
  const result = await runScript(workspace, "scripts/conversation-reminder-readiness.py", { args: ["demo", "--json"] });
  const events = JSON.parse(result.stdout).events;
  assert.deepEqual(events.map((event) => event.event_type), ["owner_activity", "response_delivered", "turn_completed"]);
  assert.equal(events[0].provider_session_id, "thread-1");
  assert.equal(events[1].message_id, "fake-message-1");
  assert.equal(events[1].disposition, "progress");
  assert.deepEqual(events[2].delivered_message_ids, ["fake-message-1"]);
  await bridge.stop();
});

test("an input-needed reply during active work pauses when the owner resumes", async () => {
  const workspace = createBridgeWorkspace();
  writeRegistry(workspace, { discord_user_id: "allowed-user-id" });
  const codex = await startFakeCodexServer(workspace, { turns: [{ turnId: "active-turn", status: "completed", waitForRelease: true }] });
  const bridge = startBridge(workspace, { port: codex.port, botAppId: "assigned-app" });
  await bridge.waitForOutput(/Listening in #channel-channel-id/, 7000);
  injectDiscordMessage(workspace, { id: "first-message", content: "work on this" });
  const config = codex.clientMessages.find((message) => message.method === "config/value/write" && message.params.keyPath === "mcp_servers.discord-channel-id");
  const contextFile = config.params.value.env.CCDM_REMINDER_CONTEXT_FILE;
  for (let attempt = 0; attempt < 100 && !fs.existsSync(contextFile); attempt++) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(fs.existsSync(contextFile));
  const reply = await runNodeEntrypoint(workspace, "scripts/discord-mcp-server.js", {
    env: bridgeChildEnv(workspace, config.params.value.env),
    input: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "reply", arguments: { text: "Which option?", conversation_disposition: "input-needed", scope_token: config.params.value.env.DISCORD_REPLY_TOKEN } } }) + "\n",
  });
  assert.equal(JSON.parse(reply.stdout).result.content[0].text, "sent (id: fake-message-1)");
  injectDiscordMessage(workspace, { id: "resume-message", content: "Option A" });
  await waitForState(workspace, (state) => state.fixtures.discord.deliveredMessages.some((message) => message.id === "resume-message"));
  await new Promise((resolve) => setTimeout(resolve, 150));
  const result = await runScript(workspace, "scripts/conversation-reminder-readiness.py", { args: ["demo", "--json"] });
  const events = JSON.parse(result.stdout).events;
  assert.deepEqual(events.map((event) => event.event_type), ["owner_activity", "response_delivered", "input_needed", "owner_activity", "work_resumed"]);
  assert.equal(events[2].message_id, "fake-message-1");
  assert.equal(events[4].source_message_id, "resume-message");
  assert.equal(codex.clientMessages.filter((message) => message.method === "turn/steer").length, 1);
  await bridge.stop();
});

test("a failed Discord reply and tool start cannot qualify Codex completion", async () => {
  const workspace = createBridgeWorkspace();
  writeRegistry(workspace, { discord_user_id: "allowed-user-id" });
  const codex = await startFakeCodexServer(workspace, { turns: [{ turnId: "failed-reply-turn", waitForRelease: true, mcpReply: true }] });
  const bridge = startBridge(workspace, { port: codex.port, botAppId: "assigned-app" });
  await bridge.waitForOutput(/Listening in #channel-channel-id/, 7000);
  injectDiscordMessage(workspace, { id: "failed-reply-owner", content: "hello" });
  const config = codex.clientMessages.find((message) => message.method === "config/value/write" && message.params.keyPath === "mcp_servers.discord-channel-id");
  const contextFile = config.params.value.env.CCDM_REMINDER_CONTEXT_FILE;
  for (let attempt = 0; attempt < 100 && !fs.existsSync(contextFile); attempt++) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(fs.existsSync(contextFile));
  const seed = readState(workspace.stateDir);
  seed.fixtures.discord.restFailures = [{ status: 503 }];
  writeState(seed, workspace.stateDir);
  const reply = await runNodeEntrypoint(workspace, "scripts/discord-mcp-server.js", {
    env: bridgeChildEnv(workspace, config.params.value.env),
    input: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "reply", arguments: { text: "failed", scope_token: config.params.value.env.DISCORD_REPLY_TOKEN } } }) + "\n",
  });
  assert.equal(JSON.parse(reply.stdout).result.isError, true);
  codex.releaseTurn("failed-reply-turn");
  await new Promise((resolve) => setTimeout(resolve, 200));
  const result = await runScript(workspace, "scripts/conversation-reminder-readiness.py", { args: ["demo", "--json"] });
  assert.deepEqual(JSON.parse(result.stdout).events.map((event) => event.event_type), ["owner_activity"]);
  await bridge.stop();
});

test("failed Codex turns do not send or record optional fallback text", async () => {
  const workspace = createBridgeWorkspace();
  writeRegistry(workspace, { discord_user_id: "allowed-user-id" });
  const codex = await startFakeCodexServer(workspace, { turns: [{ turnId: "bad-turn", status: "failed", completedItem: { type: "agentMessage", text: "unsent draft" } }] });
  const bridge = startBridge(workspace, { port: codex.port, botAppId: "assigned-app", env: { CODEX_BRIDGE_TEXT_REPLY_FALLBACK: "1" } });
  await bridge.waitForOutput(/Listening in #channel-channel-id/, 7000);
  injectDiscordMessage(workspace, { id: "failed-turn-owner", content: "try this" });
  await waitForState(workspace, (state) => state.fixtures.discord.deliveredMessages.some((message) => message.id === "failed-turn-owner"));
  await new Promise((resolve) => setTimeout(resolve, 200));
  const result = await runScript(workspace, "scripts/conversation-reminder-readiness.py", { args: ["demo", "--json"] });
  assert.deepEqual(JSON.parse(result.stdout).events.map((event) => event.event_type), ["owner_activity"]);
  assert.deepEqual(readState(workspace.stateDir).fixtures.discord.sends, []);
  await bridge.stop();
});

test("owner reactions are activity, while recorded reminder reactions do not reach Codex", async () => {
  const workspace = createBridgeWorkspace();
  writeRegistry(workspace, { discord_user_id: "allowed-user-id" });
  const codex = await startFakeCodexServer(workspace);
  const bridge = startBridge(workspace, { port: codex.port, botAppId: "assigned-app" });
  await bridge.waitForOutput(/Listening in #channel-channel-id/, 7000);
  const excluded = path.join(workspace.homeDir, ".local", "state", "ccdm", "conversation-reminders", "recorded-reminder-message-ids.json");
  fs.mkdirSync(path.dirname(excluded), { recursive: true });
  fs.writeFileSync(excluded, JSON.stringify({ schema_version: 1, message_ids: ["reminder-1"] }), { mode: 0o600 });
  injectDiscordReaction(workspace, { id: "ordinary-reaction", emoji: "custom_emoji", messageId: "ordinary-message" });
  injectDiscordReaction(workspace, { id: "reminder-reaction", emoji: "👍", messageId: "reminder-1" });
  await waitForState(workspace, (state) => state.fixtures.discord.deliveredReactions.length === 2);
  await new Promise((resolve) => setTimeout(resolve, 150));
  const result = await runScript(workspace, "scripts/conversation-reminder-readiness.py", { args: ["demo", "--json"] });
  const events = JSON.parse(result.stdout).events;
  assert.deepEqual(events.map((event) => event.event_type), ["owner_activity"]);
  assert.equal(events[0].source_message_id, "ordinary-message");
  assert.equal(codex.clientMessages.filter((message) => message.method === "turn/start").length, 1);
  await bridge.stop();
});

test("a bridge management command records owner activity without a response completion", async () => {
  const workspace = createBridgeWorkspace();
  writeRegistry(workspace, { discord_user_id: "allowed-user-id" });
  const codex = await startFakeCodexServer(workspace);
  const bridge = startBridge(workspace, { port: codex.port, botAppId: "assigned-app" });
  await bridge.waitForOutput(/Listening in #channel-channel-id/, 7000);
  injectDiscordMessage(workspace, { id: "pause-command", content: "/pause" });
  await waitForState(workspace, (state) => state.fixtures.discord.deliveredMessages.some((message) => message.id === "pause-command"));
  await new Promise((resolve) => setTimeout(resolve, 100));
  const result = await runScript(workspace, "scripts/conversation-reminder-readiness.py", { args: ["demo", "--json"] });
  const events = JSON.parse(result.stdout).events;
  assert.deepEqual(events.map((event) => event.event_type), ["owner_activity"]);
  assert.equal(events[0].activity_kind, "management-command");
  assert.equal(codex.clientMessages.filter((message) => message.method === "turn/start").length, 1);
  await bridge.stop();
});

test("a steered owner message gets a new response correlation within the active Codex turn", async () => {
  const workspace = createBridgeWorkspace();
  writeRegistry(workspace, { discord_user_id: "allowed-user-id" });
  const codex = await startFakeCodexServer(workspace, { turns: [{ turnId: "steer-turn", status: "completed", waitForRelease: true }] });
  const bridge = startBridge(workspace, { port: codex.port, botAppId: "assigned-app" });
  await bridge.waitForOutput(/Listening in #channel-channel-id/, 7000);
  injectDiscordMessage(workspace, { id: "first-owner", content: "first task" });
  const config = codex.clientMessages.find((message) => message.method === "config/value/write" && message.params.keyPath === "mcp_servers.discord-channel-id");
  const contextFile = config.params.value.env.CCDM_REMINDER_CONTEXT_FILE;
  for (let attempt = 0; attempt < 100 && !fs.existsSync(contextFile); attempt++) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(fs.existsSync(contextFile));
  const send = (text) => runNodeEntrypoint(workspace, "scripts/discord-mcp-server.js", {
    env: bridgeChildEnv(workspace, config.params.value.env),
    input: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "reply", arguments: { text, scope_token: config.params.value.env.DISCORD_REPLY_TOKEN } } }) + "\n",
  });
  assert.equal(JSON.parse((await send("first answer")).stdout).result.isError, undefined);
  injectDiscordMessage(workspace, { id: "second-owner", content: "change task" });
  for (let attempt = 0; attempt < 100 && !readState(workspace.stateDir).fixtures.discord.deliveredMessages.some((message) => message.id === "second-owner"); attempt++) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(readState(workspace.stateDir).fixtures.discord.deliveredMessages.some((message) => message.id === "second-owner"), `${bridge.stdout}\n${bridge.stderr}\n${JSON.stringify(readState(workspace.stateDir).fixtures.discord.injectedMessages)}`);
  for (let attempt = 0; attempt < 100 && JSON.parse(fs.readFileSync(contextFile, "utf8")).interaction_id !== "second-owner"; attempt++) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(JSON.parse(fs.readFileSync(contextFile, "utf8")).interaction_id, "second-owner");
  assert.equal(JSON.parse((await send("second answer")).stdout).result.isError, undefined);
  codex.releaseTurn("steer-turn");
  await new Promise((resolve) => setTimeout(resolve, 200));
  const result = await runScript(workspace, "scripts/conversation-reminder-readiness.py", { args: ["demo", "--json"] });
  const events = JSON.parse(result.stdout).events;
  assert.deepEqual(events.filter((event) => event.event_type === "response_delivered").map((event) => event.interaction_id), ["first-owner", "second-owner"]);
  assert.deepEqual(events.find((event) => event.event_type === "turn_completed").delivered_message_ids, ["fake-message-2"]);
  await bridge.stop();
});

test("bridge startup replays a durable event after the receiver recovers", async () => {
  const workspace = createBridgeWorkspace();
  writeRegistry(workspace, { discord_user_id: "allowed-user-id" });
  const stateDir = path.join(workspace.homeDir, ".local", "state", "ccdm", "conversation-reminders");
  const outbox = path.join(stateDir, "outbox");
  fs.mkdirSync(outbox, { recursive: true, mode: 0o700 });
  const event = lifecycleEvent("owner_activity", "99999999-9999-4999-8999-999999999999", {
    actor_id: "allowed-user-id", source_message_id: "outage-owner", activity_kind: "message",
  });
  fs.writeFileSync(path.join(outbox, "pending.json"), JSON.stringify(event), { mode: 0o600 });
  fs.mkdirSync(path.join(stateDir, "events.sqlite3"));
  const failedDrain = await runScript(workspace, "scripts/conversation-reminder-events.py", {
    args: ["drain", "--project-root", workspace.repoDir, "--state-dir", stateDir],
  });
  assert.equal(JSON.parse(failedDrain.stdout).status, "retryable_failure");
  assert.equal(fs.readdirSync(outbox).length, 1);
  fs.rmdirSync(path.join(stateDir, "events.sqlite3"));

  const codex = await startFakeCodexServer(workspace);
  const bridge = startBridge(workspace, { port: codex.port, botAppId: "assigned-app" });
  await bridge.waitForOutput(/Listening in #channel-channel-id/, 7000);
  const result = await runScript(workspace, "scripts/conversation-reminder-readiness.py", { args: ["demo", "--json"] });
  const readiness = JSON.parse(result.stdout);
  assert.deepEqual(readiness.events.map((row) => row.source_message_id), ["outage-owner"]);
  assert.equal(readiness.event_receiver.pending_count, 0);
  await bridge.stop();
});

test("stopping a Codex bridge records session termination for its assignment", async () => {
  const workspace = createBridgeWorkspace();
  writeRegistry(workspace, { discord_user_id: "allowed-user-id" });
  const codex = await startFakeCodexServer(workspace);
  const bridge = startBridge(workspace, { port: codex.port, botAppId: "assigned-app" });
  await bridge.waitForOutput(/Listening in #channel-channel-id/, 7000);
  await bridge.stop();
  const result = await runScript(workspace, "scripts/conversation-reminder-readiness.py", { args: ["demo", "--json"] });
  const events = JSON.parse(result.stdout).events;
  assert.deepEqual(events.map((event) => event.event_type), ["session_terminated"], `${bridge.stdout}\n${bridge.stderr}\n${JSON.stringify(JSON.parse(result.stdout).event_receiver)}`);
  assert.equal(events[0].provider_session_id, "thread-1");
});

test("attachment replies and successful optional text fallback produce confirmed receipts", async () => {
  const workspace = createBridgeWorkspace();
  writeRegistry(workspace, { discord_user_id: "allowed-user-id" });
  const codex = await startFakeCodexServer(workspace, {
    turns: [
      { turnId: "upload-turn", status: "completed", waitForRelease: true, mcpReply: true },
      { turnId: "fallback-turn", status: "completed", completedItem: { type: "agentMessage", text: "fallback answer" } },
    ],
  });
  const bridge = startBridge(workspace, { port: codex.port, botAppId: "assigned-app", env: { CODEX_BRIDGE_TEXT_REPLY_FALLBACK: "1" } });
  await bridge.waitForOutput(/Listening in #channel-channel-id/, 7000);
  injectDiscordMessage(workspace, { id: "upload-owner", content: "send file" });
  const config = codex.clientMessages.find((message) => message.method === "config/value/write" && message.params.keyPath === "mcp_servers.discord-channel-id");
  const contextFile = config.params.value.env.CCDM_REMINDER_CONTEXT_FILE;
  for (let attempt = 0; attempt < 100 && !fs.existsSync(contextFile); attempt++) await new Promise((resolve) => setTimeout(resolve, 20));
  const file = path.join(workspace.tmpDir, "reply.txt");
  fs.writeFileSync(file, "attachment fixture");
  const upload = await runNodeEntrypoint(workspace, "scripts/discord-mcp-server.js", {
    env: bridgeChildEnv(workspace, { ...config.params.value.env, CCDM_TEST_FORM_DATA_SHIM: "1" }),
    input: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "reply", arguments: { text: "file attached", files: [file], scope_token: config.params.value.env.DISCORD_REPLY_TOKEN } } }) + "\n",
  });
  assert.equal(JSON.parse(upload.stdout).result.content[0].text, "sent (id: fake-upload-1)");
  codex.releaseTurn("upload-turn");
  await new Promise((resolve) => setTimeout(resolve, 100));
  injectDiscordMessage(workspace, { id: "fallback-owner", content: "plain answer" });
  await waitForState(workspace, (state) => state.fixtures.discord.sends.some((row) => row.content === "fallback answer"));
  const result = await runScript(workspace, "scripts/conversation-reminder-readiness.py", { args: ["demo", "--json"] });
  const receipts = JSON.parse(result.stdout).events.filter((event) => event.event_type === "response_delivered");
  assert.equal(receipts.length, 2);
  assert.equal(receipts[0].message_id, "fake-upload-1");
  assert.match(receipts[1].message_id, /^sent-\d+$/);
  assert.deepEqual(receipts.map((event) => event.disposition), ["progress", "progress"]);
  await bridge.stop();
});

test("exact mention forms of /close are consumed, including a guest command", async () => {
  const workspace = createBridgeWorkspace();
  writeRegistry(workspace, { discord_user_id: "allowed-user-id" });
  const codex = await startFakeCodexServer(workspace);
  const bridge = startBridge(workspace, { port: codex.port, botAppId: "assigned-app", allowedUserIds: ["allowed-user-id", "guest-id"] });
  await bridge.waitForOutput(/Listening in #channel-channel-id/, 7000);
  injectDiscordMessage(workspace, { id: "assigned-mention-close", content: "<@assigned-app> /close" });
  injectDiscordMessage(workspace, { id: "root-mention-close", content: "<@!root-bot-app-id> /close" });
  injectDiscordMessage(workspace, { id: "guest-close", content: "/close", author: { id: "guest-id" } });
  await waitForState(workspace, (state) => state.fixtures.discord.deliveredMessages.length === 3);
  await new Promise((resolve) => setTimeout(resolve, 150));
  const result = await runScript(workspace, "scripts/conversation-reminder-readiness.py", { args: ["demo", "--json"] });
  const events = JSON.parse(result.stdout).events;
  assert.deepEqual(events.map((event) => event.source_message_id), ["assigned-mention-close", "root-mention-close"]);
  assert.deepEqual(events.map((event) => event.event_type), ["close_requested", "close_requested"]);
  assert.equal(codex.clientMessages.filter((message) => message.method === "turn/start").length, 1);
  await bridge.stop();
});

test("readiness reports missing credentials and assignment mismatch without exposing secrets", async () => {
  const workspace = createWorkspace();
  writeRegistry(workspace, {
    pool: [{ id: "assigned-bot", app_id: "assigned-app" }],
    projects: {
      demo: { type: "codex", channel_id: "channel-id", bot_id: "assigned-bot" },
      duplicate: { type: "codex", channel_id: "channel-id", bot_id: "assigned-bot" },
    },
  });
  const result = await runScript(workspace, "scripts/conversation-reminder-readiness.py", { args: ["demo", "--json"] });
  const readiness = JSON.parse(result.stdout);
  assert.equal(result.exitCode, 2);
  assert.equal(readiness.status, "blocked");
  assert.deepEqual(readiness.missing_credentials, ["assigned_project_bot_token"]);
  assert.deepEqual(readiness.assignment_mismatches, ["project channel assignment is ambiguous"]);
  assert.equal(readiness.delivery_enabled, false);
  assert.doesNotMatch(result.stdout, /fixture-bot-token/);
});

test("new Codex work after a completed input-needed turn emits a resumption pause", async () => {
  const workspace = createBridgeWorkspace();
  writeRegistry(workspace, { discord_user_id: "allowed-user-id" });
  const codex = await startFakeCodexServer(workspace, { turns: [
    { turnId: "question-turn", status: "completed", waitForRelease: true, mcpReply: true },
    { turnId: "resumed-turn", status: "completed", waitForRelease: true },
  ] });
  const bridge = startBridge(workspace, { port: codex.port, botAppId: "assigned-app" });
  await bridge.waitForOutput(/Listening in #channel-channel-id/, 7000);
  injectDiscordMessage(workspace, { id: "question-owner", content: "ask me" });
  const config = codex.clientMessages.find((message) => message.method === "config/value/write" && message.params.keyPath === "mcp_servers.discord-channel-id");
  const contextFile = config.params.value.env.CCDM_REMINDER_CONTEXT_FILE;
  for (let attempt = 0; attempt < 100 && !fs.existsSync(contextFile); attempt++) await new Promise((resolve) => setTimeout(resolve, 20));
  const reply = await runNodeEntrypoint(workspace, "scripts/discord-mcp-server.js", {
    env: bridgeChildEnv(workspace, config.params.value.env),
    input: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "reply", arguments: { text: "What do you prefer?", conversation_disposition: "input-needed", scope_token: config.params.value.env.DISCORD_REPLY_TOKEN } } }) + "\n",
  });
  assert.equal(JSON.parse(reply.stdout).result.isError, undefined);
  codex.releaseTurn("question-turn");
  await new Promise((resolve) => setTimeout(resolve, 100));
  injectDiscordMessage(workspace, { id: "answer-owner", content: "The first choice" });
  await waitForState(workspace, (state) => state.fixtures.discord.deliveredMessages.some((message) => message.id === "answer-owner"));
  await new Promise((resolve) => setTimeout(resolve, 100));
  const result = await runScript(workspace, "scripts/conversation-reminder-readiness.py", { args: ["demo", "--json"] });
  const events = JSON.parse(result.stdout).events;
  assert.equal(events.at(-1).event_type, "work_resumed");
  assert.equal(events.at(-1).resumed_from_turn_id, "question-turn");
  assert.equal(events.at(-1).source_message_id, "answer-owner");
  await bridge.stop();
});

test("unexpected Codex runtime exit records session termination", async () => {
  const workspace = createBridgeWorkspace();
  writeRegistry(workspace, { discord_user_id: "allowed-user-id" });
  const codex = await startFakeCodexServer(workspace);
  const bridge = startBridge(workspace, { port: codex.port, botAppId: "assigned-app" });
  await bridge.waitForOutput(/Listening in #channel-channel-id/, 7000);
  const state = await waitForState(workspace, (snapshot) => snapshot.fixtures.codex.appServerInvocations.length > 0);
  const fixturePid = state.fixtures.codex.appServerInvocations[0].pid;
  process.kill(fixturePid, "SIGTERM");
  await bridge.closed;
  const result = await runScript(workspace, "scripts/conversation-reminder-readiness.py", { args: ["demo", "--json"] });
  assert.deepEqual(JSON.parse(result.stdout).events.map((event) => event.event_type), ["session_terminated"]);
});

test("a Codex completion without confirmed success status cannot qualify a response", async () => {
  const workspace = createBridgeWorkspace();
  writeRegistry(workspace, { discord_user_id: "allowed-user-id" });
  const codex = await startFakeCodexServer(workspace, { turns: [{ turnId: "unknown-status-turn", waitForRelease: true, mcpReply: true }] });
  const bridge = startBridge(workspace, { port: codex.port, botAppId: "assigned-app" });
  await bridge.waitForOutput(/Listening in #channel-channel-id/, 7000);
  injectDiscordMessage(workspace, { id: "unknown-status-owner", content: "hello" });
  const config = codex.clientMessages.find((message) => message.method === "config/value/write" && message.params.keyPath === "mcp_servers.discord-channel-id");
  const contextFile = config.params.value.env.CCDM_REMINDER_CONTEXT_FILE;
  for (let attempt = 0; attempt < 100 && !fs.existsSync(contextFile); attempt++) await new Promise((resolve) => setTimeout(resolve, 20));
  const reply = await runNodeEntrypoint(workspace, "scripts/discord-mcp-server.js", {
    env: bridgeChildEnv(workspace, config.params.value.env),
    input: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "reply", arguments: { text: "visible", scope_token: config.params.value.env.DISCORD_REPLY_TOKEN } } }) + "\n",
  });
  assert.equal(JSON.parse(reply.stdout).result.isError, undefined);
  codex.releaseTurn("unknown-status-turn");
  await new Promise((resolve) => setTimeout(resolve, 150));
  const result = await runScript(workspace, "scripts/conversation-reminder-readiness.py", { args: ["demo", "--json"] });
  assert.deepEqual(JSON.parse(result.stdout).events.map((event) => event.event_type), ["owner_activity", "response_delivered"]);
  await bridge.stop();
});

test("clearing an active Codex turn removes its stale scoped reply context", async () => {
  const workspace = createBridgeWorkspace();
  writeRegistry(workspace, { discord_user_id: "allowed-user-id" });
  const codex = await startFakeCodexServer(workspace, { turns: [{ turnId: "old-turn", waitForRelease: true }] });
  const bridge = startBridge(workspace, { port: codex.port, botAppId: "assigned-app" });
  await bridge.waitForOutput(/Listening in #channel-channel-id/, 7000);
  injectDiscordMessage(workspace, { id: "old-owner", content: "old task" });
  const config = codex.clientMessages.find((message) => message.method === "config/value/write" && message.params.keyPath === "mcp_servers.discord-channel-id");
  const contextFile = config.params.value.env.CCDM_REMINDER_CONTEXT_FILE;
  for (let attempt = 0; attempt < 100 && !fs.existsSync(contextFile); attempt++) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(fs.existsSync(contextFile));
  injectDiscordMessage(workspace, { id: "clear-owner", content: "/clear" });
  await bridge.waitForOutput(/New thread after \/clear/, 7000);
  assert.equal(fs.existsSync(contextFile), false);
  await bridge.stop();
});
