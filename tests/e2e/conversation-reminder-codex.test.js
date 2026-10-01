import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { createWorkspace, runScript } from "./support/runner.js";
import { readState, updateState } from "./support/state.js";
import { cleanup, registerTeardownCallback } from "./support/teardown.js";
import { bridgeChildEnv, createBridgeWorkspace, injectDiscordMessage, injectDiscordReaction, startFakeCodexServer, waitForState } from "./support/bridge.js";
import { routerEnv, runRouterCli, startBridge } from "./support/router.js";

test.afterEach(async () => {
  await cleanup();
});

// Every Codex project is served through the Router and speaks through its
// webhook, so its reminder identity is `router:<webhook_id>`. Receiver-only
// tests record the webhook the Router would have created; bridge tests leave
// it out so startBridge runs ensure-webhook, which creates `fake-webhook-1`.
function writeRegistry(workspace, overrides = {}, { webhookId = "fake-webhook-1" } = {}) {
  const registry = {
    discord_user_id: "owner-id",
    guild_id: "guild-id",
    projects: {
      demo: {
        type: "codex",
        transport: "router",
        path: workspace.repoDir,
        screen_name: "demo_codex",
        channel_id: "channel-id",
        assignment_generation: "fixture-generation-1",
        ...(webhookId ? { webhook_id: webhookId } : {}),
      },
    },
    ...overrides,
  };
  fs.writeFileSync(path.join(workspace.repoDir, "registry.json"), `${JSON.stringify(registry)}\n`, { mode: 0o600 });
}

// A bridge workspace whose demo project gets its webhook from the Router.
function bridgeRegistry(workspace, overrides = {}) {
  writeRegistry(workspace, { discord_user_id: "allowed-user-id", ...overrides }, { webhookId: null });
}

// Root's Discord state holds the only bot token, which the Router reads.
function writeRootToken(workspace) {
  const rootStateDir = path.join(workspace.homeDir, ".claude/channels/discord");
  fs.mkdirSync(rootStateDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(rootStateDir, ".env"), "DISCORD_BOT_TOKEN=root-bot-token\n", { mode: 0o600 });
}

async function ensureWebhook(workspace, project) {
  writeRootToken(workspace);
  const result = await runRouterCli(workspace, ["ensure-webhook", project]);
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
}

function startDemoBridge(workspace, options = {}) {
  return startBridge(workspace, { project: "demo", ...options });
}

// The Router hands /close to the reminder service alone, through its observer
// client; the service's worker runs that observer.
function reminderWorker(workspace) {
  const stateDir = path.join(workspace.homeDir, ".local", "state", "ccdm", "conversation-reminders");
  const clockFile = path.join(workspace.tmpDir, "reminder-clock");
  fs.writeFileSync(clockFile, new Date().toISOString().replace(/\.\d{3}Z$/, "Z"));
  fs.mkdirSync(path.join(workspace.homeDir, ".codex"), { recursive: true });
  const env = routerEnv(workspace, { CCDM_REMINDER_NODE: process.execPath, CCDM_REMINDER_CLOCK_FILE: clockFile });
  const service = async (name) => {
    const result = await runScript(workspace, "scripts/conversation-reminder-service.py", {
      args: [name, "--project-root", workspace.repoDir, "--state-dir", stateDir], env,
    });
    assert.equal(result.exitCode, 0, result.stderr || result.stdout);
    return JSON.parse(result.stdout);
  };
  let running = null;
  return {
    async start(projects) {
      updateState(workspace.stateDir, (seed) => {
        seed.fixtures.discord.history = Object.fromEntries(projects.map(([, channelId]) => [channelId, []]));
      });
      await service("enable");
      running = runScript(workspace, "scripts/conversation-reminder-service.py", {
        args: ["run", "--project-root", workspace.repoDir, "--state-dir", stateDir], env, timeoutMs: 60000,
      });
      for (let attempt = 0; attempt < 400; attempt++) {
        const current = await service("status");
        if (projects.every(([name]) => current.conversations[name]?.reconciliation_status === "ready")) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error(`reminder worker not ready: ${JSON.stringify(await service("status"))}`);
    },
    async stop() {
      await service("disable");
      const result = await running;
      assert.equal(result.exitCode, 0, result.stderr || result.stdout);
    },
  };
}

// The bridge's scoped MCP server, as Codex runs it: a Router client that exits
// when its stdin closes, so stdin stays open until the tool call is answered.
async function runMcp(workspace, { env, input, timeoutMs = 10000 }) {
  const child = spawn(process.execPath, [path.join(workspace.repoDir, "scripts/discord-mcp-server.js")], {
    cwd: workspace.repoDir, detached: true, env, stdio: ["pipe", "pipe", "pipe"],
  });
  registerTeardownCallback(() => { try { process.kill(-child.pid, "SIGKILL"); } catch {} });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  const closed = new Promise((resolve) => child.on("close", resolve));
  const answered = new Promise((resolve) => child.stdout.on("data", (chunk) => {
    stdout += chunk;
    if (stdout.includes("\n")) resolve();
  }));
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdin.write(input);
  const timer = setTimeout(() => child.stdin.end(), timeoutMs);
  await Promise.race([answered, closed]);
  clearTimeout(timer);
  child.stdin.end();
  const exitCode = await closed;
  return { exitCode, stdout, stderr };
}

async function waitForEvents(workspace, predicate, attempts = 200) {
  let events = [];
  for (let attempt = 0; attempt < attempts; attempt++) {
    const result = await runScript(workspace, "scripts/conversation-reminder-readiness.py", { args: ["demo", "--json"] });
    events = JSON.parse(result.stdout).events;
    if (predicate(events)) return events;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return events;
}

function lifecycleEvent(eventType, eventId, fields = {}) {
  return {
    schema_version: 1,
    event_id: eventId,
    event_type: eventType,
    project: "demo",
    channel_id: "channel-id",
    bot_id: "router:fake-webhook-1",
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
  assert.equal(readiness.assignment.bot_id, "router:fake-webhook-1");
  assert.equal(readiness.assignment.generation, "fixture-generation-1");
  assert.deepEqual(readiness.missing_credentials, []);
  assert.deepEqual(readiness.assignment_mismatches, []);
  assert.deepEqual(readiness.unsupported_capabilities, []);
  assert.equal(readiness.event_receiver.available, true);
  assert.deepEqual(readiness.events, []);
  assert.equal(readState(workspace.stateDir).fixtures.codex.appServerInvocations.length, 0);
});

// Adapters drain their outbox after every emit, so two events emitted at once
// open a new store from two processes. Both must commit, not leave one stranded.
test("concurrent drains of a new event store commit every event", async () => {
  const workspace = createWorkspace();
  writeRegistry(workspace);
  for (let round = 0; round < 5; round++) {
    const stateDir = path.join(workspace.homeDir, `concurrent-store-${round}`);
    const events = [0, 1, 2].map((index) => lifecycleEvent("owner_activity", `2222222${round}-2222-4222-8222-22222222222${index}`,
      { actor_id: "owner-id", source_message_id: `concurrent-${round}-${index}`, activity_kind: "message",
        event_order: `000000000100000${index}:fixture-adapter:00000000000${index}` }));
    const results = await Promise.all(events.map((event) => ingestEvent(workspace, stateDir, event)));
    assert.deepEqual(results.map((result) => result.status), ["committed", "committed", "committed"], JSON.stringify(results));
  }
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
    { bot_id: "router:obsolete-webhook", message_id: "stale-message", disposition: "progress" },
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
  assert.doesNotMatch(fs.readFileSync(path.join(stateDir, "events.sqlite3"), "utf8"), /question body/);
});

test("owner /close is recorded before Codex dispatch and does not start a turn", async () => {
  const workspace = createBridgeWorkspace();
  bridgeRegistry(workspace);
  const codex = await startFakeCodexServer(workspace);
  const bridge = await startDemoBridge(workspace, { port: codex.port });
  await bridge.waitForOutput(/Listening in #demo/, 7000);

  const worker = reminderWorker(workspace);
  await worker.start([["demo", "channel-id"]]);

  injectDiscordMessage(workspace, { id: "close-message-1", content: "  /close  " });
  await waitForState(workspace, (state) => state.fixtures.discord.deliveredMessages.some((message) => message.id === "close-message-1"));
  const events = await waitForEvents(workspace, (rows) => rows.some((event) => event.event_type === "close_requested"));
  assert.deepEqual(events.map((event) => event.event_type), ["close_requested"]);
  assert.equal(events[0].source_message_id, "close-message-1");
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(codex.clientMessages.filter((message) => message.method === "turn/start").length, 1);
  await worker.stop();
  await bridge.stop();
});

test("a successful scoped Codex reply produces a progress receipt and a completed response", async () => {
  const workspace = createBridgeWorkspace();
  bridgeRegistry(workspace);
  const codex = await startFakeCodexServer(workspace, {
    turns: [{ turnId: "answer-turn", status: "completed", waitForRelease: true, mcpReply: true }],
  });
  const bridge = await startDemoBridge(workspace, { port: codex.port });
  await bridge.waitForOutput(/Listening in #demo/, 7000);
  injectDiscordMessage(workspace, { id: "owner-message-1", content: "answer this" });
  await waitForState(workspace, (state) => state.fixtures.discord.deliveredMessages.some((message) => message.id === "owner-message-1"));
  const config = codex.clientMessages.find((message) => message.method === "config/value/write" && message.params.keyPath === "mcp_servers.discord-channel-id");
  const contextFile = config.params.value.env.CCDM_REMINDER_CONTEXT_FILE;
  for (let attempt = 0; attempt < 100 && !fs.existsSync(contextFile); attempt++) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(fs.existsSync(contextFile), `${bridge.stdout}\n${bridge.stderr}\n${JSON.stringify(codex.clientMessages.filter((message) => message.method === "turn/start"))}`);
  const reply = await runMcp(workspace, {
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
  bridgeRegistry(workspace);
  const codex = await startFakeCodexServer(workspace, { turns: [{ turnId: "active-turn", status: "completed", waitForRelease: true }] });
  const bridge = await startDemoBridge(workspace, { port: codex.port });
  await bridge.waitForOutput(/Listening in #demo/, 7000);
  injectDiscordMessage(workspace, { id: "first-message", content: "work on this" });
  const config = codex.clientMessages.find((message) => message.method === "config/value/write" && message.params.keyPath === "mcp_servers.discord-channel-id");
  const contextFile = config.params.value.env.CCDM_REMINDER_CONTEXT_FILE;
  for (let attempt = 0; attempt < 100 && !fs.existsSync(contextFile); attempt++) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(fs.existsSync(contextFile));
  const reply = await runMcp(workspace, {
    env: bridgeChildEnv(workspace, config.params.value.env),
    input: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "reply", arguments: { text: "Which option?", conversation_disposition: "input-needed", scope_token: config.params.value.env.DISCORD_REPLY_TOKEN } } }) + "\n",
  });
  assert.equal(JSON.parse(reply.stdout).result.content[0].text, "sent (id: fake-message-1)");
  injectDiscordMessage(workspace, { id: "resume-message", content: "Option A" });
  await waitForState(workspace, (state) => state.fixtures.discord.deliveredMessages.some((message) => message.id === "resume-message"));
  // The resume is recorded after the steer; wait for it, then settle for any stray event.
  await waitForEvents(workspace, (rows) => rows.some((event) => event.event_type === "work_resumed"));
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
  bridgeRegistry(workspace);
  const codex = await startFakeCodexServer(workspace, { turns: [{ turnId: "failed-reply-turn", waitForRelease: true, mcpReply: true }] });
  const bridge = await startDemoBridge(workspace, { port: codex.port });
  await bridge.waitForOutput(/Listening in #demo/, 7000);
  injectDiscordMessage(workspace, { id: "failed-reply-owner", content: "hello" });
  const config = codex.clientMessages.find((message) => message.method === "config/value/write" && message.params.keyPath === "mcp_servers.discord-channel-id");
  const contextFile = config.params.value.env.CCDM_REMINDER_CONTEXT_FILE;
  for (let attempt = 0; attempt < 100 && !fs.existsSync(contextFile); attempt++) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(fs.existsSync(contextFile));
  // The Router's execute of the project's webhook fails.
  // The fake webhook token is spelled in parts because router.test.js
  // scans every Test Workspace file, including this copied source, for that token.
  const execute = `/api/v10/webhooks/fake-webhook-1/${"fake-webhook-"}token-1`;
  // The bridge is live, so the seed goes through the state lock.
  updateState(workspace.stateDir, (state) => {
    state.fixtures.discord.restFailures = [{ status: 503, method: "POST", path: execute }];
  });
  const reply = await runMcp(workspace, {
    env: bridgeChildEnv(workspace, config.params.value.env),
    input: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "reply", arguments: { text: "failed", scope_token: config.params.value.env.DISCORD_REPLY_TOKEN } } }) + "\n",
  });
  assert.equal(JSON.parse(reply.stdout).result.isError, true);
  assert.deepEqual(readState(workspace.stateDir).fixtures.discord.restFailureUses, [{ method: "POST", path: execute, status: 503 }]);
  codex.releaseTurn("failed-reply-turn");
  await new Promise((resolve) => setTimeout(resolve, 200));
  const result = await runScript(workspace, "scripts/conversation-reminder-readiness.py", { args: ["demo", "--json"] });
  assert.deepEqual(JSON.parse(result.stdout).events.map((event) => event.event_type), ["owner_activity"]);
  await bridge.stop();
});

test("failed Codex turns do not send or record optional fallback text", async () => {
  const workspace = createBridgeWorkspace();
  bridgeRegistry(workspace);
  const codex = await startFakeCodexServer(workspace, { turns: [{ turnId: "bad-turn", status: "failed", completedItem: { type: "agentMessage", text: "unsent draft" } }] });
  const bridge = await startDemoBridge(workspace, { port: codex.port, env: { CODEX_BRIDGE_TEXT_REPLY_FALLBACK: "1" } });
  await bridge.waitForOutput(/Listening in #demo/, 7000);
  injectDiscordMessage(workspace, { id: "failed-turn-owner", content: "try this" });
  await waitForState(workspace, (state) => state.fixtures.discord.deliveredMessages.some((message) => message.id === "failed-turn-owner"));
  await new Promise((resolve) => setTimeout(resolve, 200));
  const result = await runScript(workspace, "scripts/conversation-reminder-readiness.py", { args: ["demo", "--json"] });
  assert.deepEqual(JSON.parse(result.stdout).events.map((event) => event.event_type), ["owner_activity"]);
  assert.deepEqual(readState(workspace.stateDir).fixtures.discord.messages ?? [], []);
  await bridge.stop();
});

test("owner reactions, including one on a recorded reminder, are activity but reminder reactions do not reach Codex", async () => {
  const workspace = createBridgeWorkspace();
  bridgeRegistry(workspace);
  const codex = await startFakeCodexServer(workspace);
  const bridge = await startDemoBridge(workspace, { port: codex.port });
  await bridge.waitForOutput(/Listening in #demo/, 7000);
  const excluded = path.join(workspace.homeDir, ".local", "state", "ccdm", "conversation-reminders", "recorded-reminder-message-ids.json");
  fs.mkdirSync(path.dirname(excluded), { recursive: true });
  fs.writeFileSync(excluded, JSON.stringify({ schema_version: 1, message_ids: ["reminder-1"] }), { mode: 0o600 });
  injectDiscordReaction(workspace, { id: "ordinary-reaction", emoji: "custom_emoji", messageId: "ordinary-message" });
  injectDiscordReaction(workspace, { id: "reminder-reaction", emoji: "👍", messageId: "reminder-1" });
  await waitForState(workspace, (state) => state.fixtures.discord.deliveredReactions.length === 2);
  await new Promise((resolve) => setTimeout(resolve, 150));
  const result = await runScript(workspace, "scripts/conversation-reminder-readiness.py", { args: ["demo", "--json"] });
  const events = JSON.parse(result.stdout).events;
  assert.deepEqual(events.map((event) => [event.event_type, event.activity_kind, event.source_message_id]), [
    ["owner_activity", "reaction", "ordinary-message"], ["owner_activity", "reaction", "reminder-1"]]);
  assert.equal(codex.clientMessages.filter((message) => message.method === "turn/start").length, 1);
  await bridge.stop();
});

test("a bridge management command records owner activity without a response completion", async () => {
  const workspace = createBridgeWorkspace();
  bridgeRegistry(workspace);
  const codex = await startFakeCodexServer(workspace);
  const bridge = await startDemoBridge(workspace, { port: codex.port });
  await bridge.waitForOutput(/Listening in #demo/, 7000);
  injectDiscordMessage(workspace, { id: "pause-command", content: "/pause" });
  await waitForState(workspace, (state) => state.fixtures.discord.deliveredMessages.some((message) => message.id === "pause-command"));
  await waitForEvents(workspace, (rows) => rows.length >= 1);
  // Settle so a wrongly recorded completion or turn would show up.
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
  bridgeRegistry(workspace);
  const codex = await startFakeCodexServer(workspace, { turns: [{ turnId: "steer-turn", status: "completed", waitForRelease: true }] });
  const bridge = await startDemoBridge(workspace, { port: codex.port });
  await bridge.waitForOutput(/Listening in #demo/, 7000);
  injectDiscordMessage(workspace, { id: "first-owner", content: "first task" });
  const config = codex.clientMessages.find((message) => message.method === "config/value/write" && message.params.keyPath === "mcp_servers.discord-channel-id");
  const contextFile = config.params.value.env.CCDM_REMINDER_CONTEXT_FILE;
  for (let attempt = 0; attempt < 100 && !fs.existsSync(contextFile); attempt++) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(fs.existsSync(contextFile));
  const send = (text) => runMcp(workspace, {
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
  bridgeRegistry(workspace);
  // The event names the webhook the Router records for demo.
  await ensureWebhook(workspace, "demo");
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
  const bridge = await startDemoBridge(workspace, { port: codex.port });
  await bridge.waitForOutput(/Listening in #demo/, 7000);
  const result = await runScript(workspace, "scripts/conversation-reminder-readiness.py", { args: ["demo", "--json"] });
  const readiness = JSON.parse(result.stdout);
  assert.deepEqual(readiness.events.map((row) => row.source_message_id), ["outage-owner"]);
  assert.equal(readiness.event_receiver.pending_count, 0);
  await bridge.stop();
});

test("stopping a Codex bridge records session termination for its assignment", async () => {
  const workspace = createBridgeWorkspace();
  bridgeRegistry(workspace);
  const codex = await startFakeCodexServer(workspace);
  const bridge = await startDemoBridge(workspace, { port: codex.port });
  await bridge.waitForOutput(/Listening in #demo/, 7000);
  await bridge.stop();
  const result = await runScript(workspace, "scripts/conversation-reminder-readiness.py", { args: ["demo", "--json"] });
  const events = JSON.parse(result.stdout).events;
  assert.deepEqual(events.map((event) => event.event_type), ["session_terminated"], `${bridge.stdout}\n${bridge.stderr}\n${JSON.stringify(JSON.parse(result.stdout).event_receiver)}`);
  assert.equal(events[0].provider_session_id, "thread-1");
});

test("attachment replies and successful optional text fallback produce confirmed receipts", async () => {
  const workspace = createBridgeWorkspace();
  bridgeRegistry(workspace);
  const codex = await startFakeCodexServer(workspace, {
    turns: [
      { turnId: "upload-turn", status: "completed", waitForRelease: true, mcpReply: true },
      { turnId: "fallback-turn", status: "completed", completedItem: { type: "agentMessage", text: "fallback answer" } },
    ],
  });
  const bridge = await startDemoBridge(workspace, { port: codex.port, env: { CODEX_BRIDGE_TEXT_REPLY_FALLBACK: "1" } });
  await bridge.waitForOutput(/Listening in #demo/, 7000);
  injectDiscordMessage(workspace, { id: "upload-owner", content: "send file" });
  const config = codex.clientMessages.find((message) => message.method === "config/value/write" && message.params.keyPath === "mcp_servers.discord-channel-id");
  const contextFile = config.params.value.env.CCDM_REMINDER_CONTEXT_FILE;
  for (let attempt = 0; attempt < 100 && !fs.existsSync(contextFile); attempt++) await new Promise((resolve) => setTimeout(resolve, 20));
  const file = path.join(workspace.tmpDir, "reply.txt");
  fs.writeFileSync(file, "attachment fixture");
  const upload = await runMcp(workspace, {
    env: bridgeChildEnv(workspace, { ...config.params.value.env, CCDM_TEST_FORM_DATA_SHIM: "1" }),
    input: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "reply", arguments: { text: "file attached", files: [file], scope_token: config.params.value.env.DISCORD_REPLY_TOKEN } } }) + "\n",
  });
  assert.equal(JSON.parse(upload.stdout).result.content[0].text, "sent (id: fake-message-1)");
  assert.deepEqual(readState(workspace.stateDir).fixtures.discord.messages.map(({ content, uploads, webhookId }) => ({ content, uploads, webhookId })),
    [{ content: "file attached", uploads: [{ name: "reply.txt", size: 18 }], webhookId: "fake-webhook-1" }]);
  codex.releaseTurn("upload-turn");
  await new Promise((resolve) => setTimeout(resolve, 100));
  injectDiscordMessage(workspace, { id: "fallback-owner", content: "plain answer" });
  await waitForState(workspace, (state) => state.fixtures.discord.messages.some((row) => row.content === "fallback answer" && row.webhookId === "fake-webhook-1"));
  // The fallback's receipt is recorded after its Discord post lands.
  const receipts = (await waitForEvents(workspace, (rows) => rows.filter((event) => event.event_type === "response_delivered").length >= 2))
    .filter((event) => event.event_type === "response_delivered");
  assert.equal(receipts.length, 2);
  assert.equal(receipts[0].message_id, "fake-message-1");
  assert.equal(receipts[1].message_id, "fake-message-2");
  assert.deepEqual(receipts.map((event) => event.disposition), ["progress", "progress"]);
  await bridge.stop();
});

// Mentioning the bot addresses root, the Router's only bot user, so the
// mention forms name it; a guest's /close reaches no one and is not recorded.
test("exact mention forms of /close are consumed, including a guest command", async () => {
  const workspace = createBridgeWorkspace();
  bridgeRegistry(workspace);
  const codex = await startFakeCodexServer(workspace);
  const bridge = await startDemoBridge(workspace, { port: codex.port, allowedUserIds: ["allowed-user-id", "guest-id"] });
  await bridge.waitForOutput(/Listening in #demo/, 7000);
  const worker = reminderWorker(workspace);
  await worker.start([["demo", "channel-id"]]);
  injectDiscordMessage(workspace, { id: "root-mention-close", content: "<@fixture-bot-user-id> /close" });
  injectDiscordMessage(workspace, { id: "root-bang-mention-close", content: "<@!fixture-bot-user-id> /close" });
  injectDiscordMessage(workspace, { id: "guest-close", content: "/close", author: { id: "guest-id" } });
  await waitForState(workspace, (state) => state.fixtures.discord.deliveredMessages.length === 3);
  const events = await waitForEvents(workspace, (rows) => rows.length >= 2);
  await new Promise((resolve) => setTimeout(resolve, 150));
  // The bridge handles Discord messages concurrently, so two closes may commit
  // in either order; each exact mention form is recorded once.
  assert.deepEqual(events.map((event) => event.source_message_id).sort(), ["root-bang-mention-close", "root-mention-close"]);
  assert.deepEqual(events.map((event) => event.event_type), ["close_requested", "close_requested"]);
  assert.equal(codex.clientMessages.filter((message) => message.method === "turn/start").length, 1);
  await worker.stop();
  await bridge.stop();
});

test("a Codex root consumes a root-mention /close in a Claude project channel without a model turn", async () => {
  const workspace = createBridgeWorkspace();
  writeRegistry(workspace, {
    discord_user_id: "allowed-user-id",
    projects: { "claude-demo": { type: "claude", transport: "router", path: workspace.repoDir, screen_name: "claude-demo_claude",
      channel_id: "project-channel", assignment_generation: "claude-generation-1" } },
  });
  await ensureWebhook(workspace, "claude-demo");
  const codex = await startFakeCodexServer(workspace, { channelId: "root-channel", turns: [{ complete: true }] });
  // The fake gateway's bot user is root's, so mentions name it.
  const bridge = await startBridge(workspace, { root: true, rootBotAppId: "fixture-bot-user-id",
    channelId: "root-channel", port: codex.port });
  await bridge.waitForOutput(/Root routing active for 1 configured channel\(s\)/, 7000);
  const userTurns = () => codex.clientMessages.filter((message) => message.method === "turn/start" &&
    !message.params?.input?.[0]?.text?.startsWith("You are communicating with the user via Discord"));
  injectDiscordMessage(workspace, { id: "root-close", channelId: "project-channel", content: "<@fixture-bot-user-id> /close" });
  // A later root-management request proves the close was consumed rather than queued.
  injectDiscordMessage(workspace, { id: "root-status", channelId: "project-channel", content: "<@fixture-bot-user-id> status" });
  for (let attempt = 0; attempt < 200 && userTurns().length === 0; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(userTurns().length, 1);
  assert.doesNotMatch(JSON.stringify(userTurns()[0].params.input), /\/close/);
  const status = await runScript(workspace, "scripts/conversation-reminder-events.py", {
    args: ["status", "--project", "claude-demo", "--state-dir",
      path.join(workspace.homeDir, ".local", "state", "ccdm", "conversation-reminders")],
  });
  assert.equal(status.exitCode, 0, status.stderr);
  const events = JSON.parse(status.stdout).events;
  assert.deepEqual(events.filter((event) => event.event_type === "close_requested")
    .map((event) => [event.source_message_id, event.provider]), [["root-close", "ccdm-root"]]);
  await bridge.stop();
});

// Root delivers a router project's reminders, so no project credential can be
// missing; an unrecorded webhook leaves the assignment incomplete instead.
test("readiness reports a missing webhook and an ambiguous assignment without exposing secrets", async () => {
  const workspace = createWorkspace();
  writeRootToken(workspace);
  writeRegistry(workspace, {
    projects: {
      demo: { type: "codex", transport: "router", channel_id: "channel-id", webhook_id: "fake-webhook-1" },
      duplicate: { type: "codex", transport: "router", channel_id: "channel-id", webhook_id: "fake-webhook-2" },
      unhooked: { type: "codex", transport: "router", channel_id: "other-channel" },
    },
  });
  const result = await runScript(workspace, "scripts/conversation-reminder-readiness.py", { args: ["demo", "--json"] });
  const readiness = JSON.parse(result.stdout);
  assert.equal(result.exitCode, 2);
  assert.equal(readiness.status, "blocked");
  assert.deepEqual(readiness.missing_credentials, []);
  assert.deepEqual(readiness.assignment_mismatches, ["project channel assignment is ambiguous"]);
  assert.equal(readiness.delivery_enabled, false);
  assert.doesNotMatch(result.stdout, /root-bot-token/);

  const unhooked = await runScript(workspace, "scripts/conversation-reminder-readiness.py", { args: ["unhooked", "--json"] });
  const blocked = JSON.parse(unhooked.stdout);
  assert.equal(unhooked.exitCode, 2);
  assert.equal(blocked.status, "blocked");
  assert.deepEqual(blocked.assignment_mismatches, ["project assignment is incomplete or ambiguous"]);
  assert.equal(blocked.delivery_enabled, false);
  assert.doesNotMatch(unhooked.stdout, /root-bot-token/);
});

test("new Codex work after a completed input-needed turn emits a resumption pause", async () => {
  const workspace = createBridgeWorkspace();
  bridgeRegistry(workspace);
  const codex = await startFakeCodexServer(workspace, { turns: [
    { turnId: "question-turn", status: "completed", waitForRelease: true, mcpReply: true },
    { turnId: "resumed-turn", status: "completed", waitForRelease: true },
  ] });
  const bridge = await startDemoBridge(workspace, { port: codex.port });
  await bridge.waitForOutput(/Listening in #demo/, 7000);
  injectDiscordMessage(workspace, { id: "question-owner", content: "ask me" });
  const config = codex.clientMessages.find((message) => message.method === "config/value/write" && message.params.keyPath === "mcp_servers.discord-channel-id");
  const contextFile = config.params.value.env.CCDM_REMINDER_CONTEXT_FILE;
  // The question turn's reply needs its reminder context, written as the turn starts.
  for (const deadline = Date.now() + 10000; Date.now() < deadline && !fs.existsSync(contextFile);) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(fs.existsSync(contextFile), "the question turn's reminder context");
  const reply = await runMcp(workspace, {
    env: bridgeChildEnv(workspace, config.params.value.env),
    input: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "reply", arguments: { text: "What do you prefer?", conversation_disposition: "input-needed", scope_token: config.params.value.env.DISCORD_REPLY_TOKEN } } }) + "\n",
  });
  assert.equal(JSON.parse(reply.stdout).result.isError, undefined);
  // The answer must start a new turn, not steer the question turn, so it is
  // sent only once the bridge is idle again.
  const idleTurns = () => bridge.stdout.split("bridge idle").length - 1;
  const idleBefore = idleTurns();
  codex.releaseTurn("question-turn");
  await bridge.waitForOutput(new RegExp(`(?:bridge idle[^]*){${idleBefore + 1}}`), 7000);
  injectDiscordMessage(workspace, { id: "answer-owner", content: "The first choice" });
  await waitForState(workspace, (state) => state.fixtures.discord.deliveredMessages.some((message) => message.id === "answer-owner"));
  const events = await waitForEvents(workspace, (current) => current.at(-1)?.event_type === "work_resumed");
  assert.equal(events.at(-1).event_type, "work_resumed");
  assert.equal(events.at(-1).resumed_from_turn_id, "question-turn");
  assert.equal(events.at(-1).source_message_id, "answer-owner");
  await bridge.stop();
});

test("unexpected Codex runtime exit records session termination", async () => {
  const workspace = createBridgeWorkspace();
  bridgeRegistry(workspace);
  const codex = await startFakeCodexServer(workspace);
  const bridge = await startDemoBridge(workspace, { port: codex.port });
  await bridge.waitForOutput(/Listening in #demo/, 7000);
  const state = await waitForState(workspace, (snapshot) => snapshot.fixtures.codex.appServerInvocations.length > 0);
  const fixturePid = state.fixtures.codex.appServerInvocations[0].pid;
  process.kill(fixturePid, "SIGTERM");
  await bridge.closed;
  const result = await runScript(workspace, "scripts/conversation-reminder-readiness.py", { args: ["demo", "--json"] });
  assert.deepEqual(JSON.parse(result.stdout).events.map((event) => event.event_type), ["session_terminated"]);
});

test("a Codex completion without confirmed success status cannot qualify a response", async () => {
  const workspace = createBridgeWorkspace();
  bridgeRegistry(workspace);
  const codex = await startFakeCodexServer(workspace, { turns: [{ turnId: "unknown-status-turn", waitForRelease: true, mcpReply: true }] });
  const bridge = await startDemoBridge(workspace, { port: codex.port });
  await bridge.waitForOutput(/Listening in #demo/, 7000);
  injectDiscordMessage(workspace, { id: "unknown-status-owner", content: "hello" });
  const config = codex.clientMessages.find((message) => message.method === "config/value/write" && message.params.keyPath === "mcp_servers.discord-channel-id");
  const contextFile = config.params.value.env.CCDM_REMINDER_CONTEXT_FILE;
  for (let attempt = 0; attempt < 100 && !fs.existsSync(contextFile); attempt++) await new Promise((resolve) => setTimeout(resolve, 20));
  const reply = await runMcp(workspace, {
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
  bridgeRegistry(workspace);
  const codex = await startFakeCodexServer(workspace, { turns: [{ turnId: "old-turn", waitForRelease: true }] });
  const bridge = await startDemoBridge(workspace, { port: codex.port });
  await bridge.waitForOutput(/Listening in #demo/, 7000);
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

test("a completion notification without a turn ID cannot end the active Codex exchange", async () => {
  const workspace = createBridgeWorkspace();
  bridgeRegistry(workspace);
  const codex = await startFakeCodexServer(workspace, { turns: [{
    turnId: "identified-turn", status: "completed", waitForRelease: true, mcpReply: true,
    notificationsBeforeStart: [{ method: "turn/completed", params: { turn: { status: "completed" } } }],
  }] });
  const bridge = await startDemoBridge(workspace, { port: codex.port });
  await bridge.waitForOutput(/Listening in #demo/, 7000);
  injectDiscordMessage(workspace, { id: "identified-owner", content: "answer" });
  const config = codex.clientMessages.find((message) => message.method === "config/value/write" && message.params.keyPath === "mcp_servers.discord-channel-id");
  const contextFile = config.params.value.env.CCDM_REMINDER_CONTEXT_FILE;
  await waitForState(workspace, (state) => state.fixtures.discord.deliveredMessages.some((message) => message.id === "identified-owner"));
  // The bridge writes the grant once turn/start returns; a loaded machine can
  // take longer than a fixed delay to get there.
  for (let attempt = 0; attempt < 250 && !fs.existsSync(contextFile); attempt++) await new Promise((resolve) => setTimeout(resolve, 20));
  // The unidentified completion follows the turn/start reply; let it land.
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.ok(fs.existsSync(contextFile), "unidentified completion must leave the active reply grant intact");
  const reply = await runMcp(workspace, {
    env: bridgeChildEnv(workspace, config.params.value.env),
    input: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "reply", arguments: { text: "answer", scope_token: config.params.value.env.DISCORD_REPLY_TOKEN } } }) + "\n",
  });
  assert.equal(JSON.parse(reply.stdout).result.isError, undefined);
  codex.releaseTurn("identified-turn");
  await new Promise((resolve) => setTimeout(resolve, 150));
  const result = await runScript(workspace, "scripts/conversation-reminder-readiness.py", { args: ["demo", "--json"] });
  assert.deepEqual(JSON.parse(result.stdout).events.map((event) => event.event_type), ["owner_activity", "response_delivered", "turn_completed"]);
  await bridge.stop();
});

test("an owner reaction that starts a Codex turn keeps its reminder correlation", async () => {
  const workspace = createBridgeWorkspace();
  bridgeRegistry(workspace);
  const codex = await startFakeCodexServer(workspace, {
    turns: [
      { turnId: "answer-turn", status: "completed", completedItem: { type: "agentMessage", text: "first answer" } },
      { turnId: "reaction-turn", status: "completed", completedItem: { type: "agentMessage", text: "reaction answer" } },
    ],
  });
  const bridge = await startDemoBridge(workspace, { port: codex.port, env: { CODEX_BRIDGE_TEXT_REPLY_FALLBACK: "1" } });
  await bridge.waitForOutput(/Listening in #demo/, 7000);
  injectDiscordMessage(workspace, { id: "owner-question", content: "answer this" });
  await waitForState(workspace, (state) => state.fixtures.discord.messages?.some((row) => row.content === "first answer" && row.webhookId === "fake-webhook-1"));
  for (let attempt = 0; attempt < 50; attempt++) {
    const result = await runScript(workspace, "scripts/conversation-reminder-readiness.py", { args: ["demo", "--json"] });
    if (JSON.parse(result.stdout).events.some((event) => event.event_type === "turn_completed")) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  // The first answer is the project's own webhook message.
  injectDiscordReaction(workspace, { id: "owner-thumbs", emoji: "👍", messageId: "fake-message-1",
    message: { author: { bot: true, id: "fake-webhook-1" }, webhookId: "fake-webhook-1", content: "first answer" } });
  await waitForState(workspace, (state) => state.fixtures.discord.messages?.some((row) => row.content === "reaction answer" && row.webhookId === "fake-webhook-1"));
  let events = [];
  for (let attempt = 0; attempt < 50; attempt++) {
    const result = await runScript(workspace, "scripts/conversation-reminder-readiness.py", { args: ["demo", "--json"] });
    events = JSON.parse(result.stdout).events;
    if (events.some((event) => event.event_type === "turn_completed" && event.provider_turn_id === "reaction-turn")) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const reaction = events.find((event) => event.event_type === "owner_activity" && event.activity_kind === "reaction");
  assert.deepEqual([reaction.source_message_id, reaction.reaction_emoji], ["fake-message-1", "👍"]);
  // The reaction-started turn continues the owner's current interaction, so its
  // confirmed reply and completion can re-arm a reminder.
  const receipt = events.find((event) => event.event_type === "response_delivered" && event.provider_turn_id === "reaction-turn");
  assert.equal(receipt?.interaction_id, "owner-question");
  const completed = events.find((event) => event.event_type === "turn_completed" && event.provider_turn_id === "reaction-turn");
  assert.equal(completed?.interaction_id, "owner-question");
  assert.deepEqual(completed.delivered_message_ids, [receipt.message_id]);
  await bridge.stop();
});

test("the automatic terminal retry keeps the owner's reminder correlation on its new turn", async () => {
  const workspace = createBridgeWorkspace();
  bridgeRegistry(workspace);
  const codex = await startFakeCodexServer(workspace, {
    turns: [
      { turnId: "failed-turn", error: "stream disconnected before completion: response.failed event received" },
      { turnId: "retry-turn", status: "completed", completedItem: { type: "agentMessage", text: "Recovered response" } },
    ],
  });
  const bridge = await startDemoBridge(workspace, { port: codex.port, env: { CODEX_BRIDGE_TEXT_REPLY_FALLBACK: "1" } });
  await bridge.waitForOutput(/Listening in #demo/, 7000);
  injectDiscordMessage(workspace, { id: "owner-retry", content: "recover this turn" });
  await waitForState(workspace, (state) => state.fixtures.discord.messages?.some((row) => row.content === "Recovered response" && row.webhookId === "fake-webhook-1"));
  await bridge.waitForOutput(/Retrying terminal response\.failed turn once/, 5000);
  let events = [];
  for (let attempt = 0; attempt < 50; attempt++) {
    const result = await runScript(workspace, "scripts/conversation-reminder-readiness.py", { args: ["demo", "--json"] });
    events = JSON.parse(result.stdout).events;
    if (events.some((event) => event.event_type === "turn_completed")) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const receipt = events.find((event) => event.event_type === "response_delivered");
  assert.deepEqual([receipt?.provider_turn_id, receipt?.interaction_id], ["retry-turn", "owner-retry"]);
  const completed = events.find((event) => event.event_type === "turn_completed");
  assert.deepEqual([completed?.provider_turn_id, completed?.interaction_id, completed?.delivered_message_ids],
    ["retry-turn", "owner-retry", [receipt.message_id]]);
  assert.equal(events.some((event) => event.provider_turn_id === "failed-turn" && event.event_type !== "owner_activity"), false);
  await bridge.stop();
});

test("a delivered scoped reply stays successful when its reminder receipt cannot be recorded", async () => {
  const workspace = createBridgeWorkspace();
  bridgeRegistry(workspace);
  const codex = await startFakeCodexServer(workspace, {
    turns: [{ turnId: "answer-turn", status: "completed", waitForRelease: true, mcpReply: true }],
  });
  const bridge = await startDemoBridge(workspace, { port: codex.port });
  await bridge.waitForOutput(/Listening in #demo/, 7000);
  injectDiscordMessage(workspace, { id: "owner-message-1", content: "answer this" });
  const config = codex.clientMessages.find((message) => message.method === "config/value/write" && message.params.keyPath === "mcp_servers.discord-channel-id");
  const contextFile = config.params.value.env.CCDM_REMINDER_CONTEXT_FILE;
  for (let attempt = 0; attempt < 100 && !fs.existsSync(contextFile); attempt++) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(fs.existsSync(contextFile));
  // Receipt storage fails locally after Discord has accepted the reply.
  const blocked = path.join(workspace.tmpDir, "receipts-are-a-file");
  fs.writeFileSync(blocked, "not a directory");
  const reply = await runMcp(workspace, {
    env: bridgeChildEnv(workspace, { ...config.params.value.env, CCDM_REMINDER_RECEIPTS_DIR: blocked }),
    input: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "reply", arguments: { text: "Here is the answer", scope_token: config.params.value.env.DISCORD_REPLY_TOKEN } } }) + "\n",
  });
  const response = JSON.parse(reply.stdout);
  assert.equal(response.result.isError, undefined, reply.stdout);
  assert.equal(response.result.content[0].text, "sent (id: fake-message-1)");
  assert.match(reply.stderr, /reply fake-message-1 was delivered but its Conversation Reminder receipt was not recorded/);
  assert.equal(readState(workspace.stateDir).fixtures.discord.messages.filter((row) => row.content === "Here is the answer").length, 1);
  codex.releaseTurn("answer-turn");
  await new Promise((resolve) => setTimeout(resolve, 200));
  // Without a confirmed receipt the turn cannot qualify a reminder.
  const result = await runScript(workspace, "scripts/conversation-reminder-readiness.py", { args: ["demo", "--json"] });
  assert.equal(JSON.parse(result.stdout).events.some((event) => event.event_type === "turn_completed"), false);
  await bridge.stop();
});
