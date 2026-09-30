import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { runNodeEntrypoint, runScript } from "./support/runner.js";
import { injectDiscordMessage, waitForState } from "./support/bridge.js";
import {
  OWNER_ID,
  ROOT_TOKEN,
  createRouterWorkspace,
  routerEnv,
  routerWithWebhooks,
  waitFor,
  writeRootKey,
} from "./support/router.js";
import { readState, writeState } from "./support/state.js";
import { cleanup, registerTeardownCallback } from "./support/teardown.js";

test.afterEach(async () => { await cleanup(); });

// Conversation Reminder events of a Claude project session. Every Claude
// session is served through the Router, and its CCDM channel server records
// the events itself: the real Router and channel server run against the fake
// Discord, and a scripted MCP client stands in for Claude. `ensure-webhook`
// gives demo `fake-webhook-1`.
const WEBHOOK_ID = "fake-webhook-1";
// The fake gateway's bot user: root, as the Router logs in.
const ROOT_BOT_ID = "fixture-bot-user-id";
// Spelled in parts because router.test.js scans Test Workspace files for the fake webhook token.
const WEBHOOK_EXECUTE = `/api/v10/webhooks/${WEBHOOK_ID}/${"fake-webhook-"}token-1`;

function seedClaudeAssignment(workspace) {
  const registryPath = path.join(workspace.repoDir, "registry.json");
  const registry = JSON.parse(fs.readFileSync(registryPath, "utf8"));
  registry.projects.demo.path = workspace.repoDir;
  fs.writeFileSync(registryPath, JSON.stringify(registry));
  return registry;
}

async function claudeWorkspace() {
  const workspace = createRouterWorkspace({
    discord_user_id: OWNER_ID,
    guild_id: "guild-id",
    root_bot_app_id: "root-app",
    projects: { demo: {
      type: "claude", transport: "router", channel_id: "channel-1", assignment_generation: "generation-1",
      screen_name: "demo_claude", guest_user_ids: ["guest-id"], session_id: null, pid: null,
    } },
  });
  const router = await routerWithWebhooks(workspace, ["demo"]);
  const registry = seedClaudeAssignment(workspace);
  return { workspace, router, registry };
}

function reminderStateDir(workspace) {
  return path.join(workspace.homeDir, ".local", "state", "ccdm", "conversation-reminders");
}

let launchCounter = 0;

// The real channel server as Claude runs it: initialized, tools listed, and
// connected to the Router. `root` runs it in root's role.
async function startChannel(workspace, options = {}) {
  launchCounter += 1;
  const hookSettings = path.join(workspace.tmpDir, `claude-reminder-hooks-${launchCounter}.json`);
  if (!options.noHooksConfig) {
    const command = `node '${path.join(workspace.repoDir, "scripts", "claude-reminder-hook.js")}'`;
    fs.writeFileSync(hookSettings, JSON.stringify({
      ...(options.noSingleListenerConfig ? {} : { enabledPlugins: { "discord@claude-plugins-official": false } }),
      hooks: Object.fromEntries(
        ["SessionStart", "Stop", "StopFailure", "SessionEnd"].map(event => [event, [{ hooks: [{ type: "command", command }] }]]),
      ),
    }), { mode: 0o600 });
  }
  const readyFile = path.join(workspace.tmpDir, `channel-ready-${launchCounter}.json`);
  const stateDir = reminderStateDir(workspace);
  const env = routerEnv(workspace, {
    CCDM_CHANNEL_READY_FILE: readyFile,
    CCDM_ROUTER_KEY_FILE: path.join(workspace.routerStateDir, "keys", options.root ? ".root.key" : "demo.key"),
    ...(options.root ? { CCDM_ROUTER_ROLE: "root" } : { CCDM_CLAUDE_PROJECT: "demo", CCDM_CLAUDE_CHANNEL_ID: "channel-1" }),
    CCDM_CLAUDE_LAUNCH_ID: "fixture-claude-launch",
    CCDM_REMINDER_PROJECT_ROOT: workspace.repoDir,
    CCDM_REMINDER_STATE_DIR: stateDir,
    CCDM_REMINDER_RECEIPTS_DIR: path.join(stateDir, "claude-receipts"),
    ...(options.noHooksConfig ? {} : { CCDM_CLAUDE_HOOK_SETTINGS: hookSettings }),
    ...(options.receiverOutage ? { CCDM_REMINDER_PYTHON: "/missing/ralph-57-python" } : {}),
    ...(options.launchEnv || {}),
  });
  const child = spawn(process.execPath, [path.join(workspace.repoDir, "scripts", "ccdm-channel-server.js")], {
    cwd: workspace.repoDir, env, stdio: ["pipe", "pipe", "pipe"],
  });
  const exited = new Promise(resolve => child.once("exit", resolve));
  let output = "";
  let errors = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { errors += chunk; });
  const stop = async (signal = "SIGTERM") => {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
    await exited;
  };
  registerTeardownCallback(() => stop("SIGKILL"));
  const frames = () => output.split("\n").filter(Boolean).map(line => JSON.parse(line));
  const response = id => frames().find(frame => frame.id === id);
  let nextId = 1;
  const request = async (method, params) => {
    const id = nextId++;
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    await waitFor(() => response(id), () => `response ${id} to ${method}; stderr:\n${errors}`, 10000);
    return response(id);
  };
  const initialize = await request("initialize", { protocolVersion: "2025-03-26", capabilities: {},
    clientInfo: { name: "fixture", version: "1" } });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  const tools = await request("tools/list", {});
  await waitFor(() => fs.existsSync(readyFile), () => `the channel server's Router hello; stderr:\n${errors}`, 10000);
  const ready = JSON.parse(fs.readFileSync(readyFile, "utf8"));
  assert.equal(ready.ok, true, errors);
  const notifications = () => frames().filter(frame => frame.method === "notifications/claude/channel").map(frame => frame.params);
  return {
    pid: child.pid,
    initialize,
    tools,
    notifications,
    get errors() { return errors; },
    call: async (name, args) => (await request("tools/call", { name, arguments: args })).result,
    stop,
  };
}

// An owner, guest, or stranger message through the fake gateway, then the
// Router's classification; `notified` waits for the session to hear it.
async function deliver(workspace, channel, message, { notified = false } = {}) {
  injectDiscordMessage(workspace, { channelId: "channel-1", ...message,
    author: { id: OWNER_ID, username: "Owner", ...(message.author ?? {}) } });
  await waitFor(() => readState(workspace.stateDir).fixtures.discord.deliveredMessages.some(entry => entry.id === message.id),
    () => `gateway delivery of ${message.id}`);
  if (notified) {
    await waitFor(() => channel.notifications().some(item => item.meta.message_id === message.id),
      () => `notification of ${message.id}; stderr:\n${channel.errors}`);
  }
  // Classification and event recording are asynchronous to the gateway emit.
  await new Promise(resolve => setTimeout(resolve, 300));
}

function replyArgs(extra = {}) {
  return { chat_id: "channel-1", text: "Which option?", conversation_interaction_id: "owner-message-1",
    conversation_disposition: "input-needed", ...extra };
}

function sentId(result) {
  return /\(id: ([^)]+)\)/.exec(result.content[0].text)?.[1];
}

async function readiness(workspace) {
  const result = await runScript(workspace, "scripts/conversation-reminder-readiness.py", {
    args: ["demo", "--json"], env: routerEnv(workspace),
  });
  return { exitCode: result.exitCode, stderr: result.stderr, report: JSON.parse(result.stdout) };
}

const eventTypes = report => report.events.map(event => event.event_type);

async function runHook(workspace, hook_event_name, fields = {}, extraEnv = {}) {
  return runNodeEntrypoint(workspace, "scripts/claude-reminder-hook.js", {
    env: {
      CCDM_CLAUDE_PROJECT: "demo",
      CCDM_CLAUDE_CHANNEL_ID: "channel-1",
      CCDM_CLAUDE_LAUNCH_ID: "fixture-claude-launch",
      CCDM_REMINDER_PROJECT_ROOT: workspace.repoDir,
      CCDM_REMINDER_STATE_DIR: reminderStateDir(workspace),
      CCDM_REMINDER_RECEIPTS_DIR: path.join(reminderStateDir(workspace), "claude-receipts"),
      ...extraEnv,
    },
    input: JSON.stringify({ hook_event_name, session_id: "fixture-session", ...fields }),
  });
}

// One owner question answered by one Claude reply, as a turn.
async function answeredTurn(workspace, channel, args = {}) {
  await deliver(workspace, channel, { id: "owner-message-1", content: "choose an option" }, { notified: true });
  return channel.call("reply", replyArgs(args));
}

test("an owner /close in the project channel never reaches the Claude channel server", async () => {
  const { workspace } = await claudeWorkspace();
  const channel = await startChannel(workspace);
  await deliver(workspace, channel, { id: "owner-close-1", content: "  /close  " });
  const { exitCode, report } = await readiness(workspace);
  await channel.stop();
  assert.deepEqual(channel.notifications(), []);
  assert.equal(exitCode, 0, JSON.stringify(report));
  // The reminder service records the closure through its observer, not the session.
  assert.deepEqual(eventTypes(report), []);
  assert.match(report.tested_runtime.bridge_contract, /Claude Code/);
});

test("the Claude channel server serves Discord itself, with no official plugin process", async () => {
  const { workspace } = await claudeWorkspace();
  const bunLog = path.join(workspace.tmpDir, "bun-invocations.txt");
  fs.writeFileSync(path.join(workspace.fixtureDir, "bun"), `#!/bin/sh\nprintf '%s\\n' "$@" >> '${bunLog}'\n`, { mode: 0o755 });
  const channel = await startChannel(workspace);
  await deliver(workspace, channel, { id: "owner-message-1", content: "hello" }, { notified: true });
  await channel.stop();
  assert.deepEqual(channel.initialize.result.serverInfo, { name: "ccdm", version: "1.0.0" });
  assert.equal(fs.existsSync(bunLog), false);
});

test("the Claude channel server refuses to start without its launch key and reports the failed hello", async () => {
  const { workspace } = await claudeWorkspace();
  const readyFile = path.join(workspace.tmpDir, "ready.json");
  const result = await runNodeEntrypoint(workspace, "scripts/ccdm-channel-server.js", {
    env: routerEnv(workspace, { CCDM_CLAUDE_PROJECT: "demo", CCDM_CHANNEL_READY_FILE: readyFile,
      CCDM_ROUTER_KEY_FILE: path.join(workspace.routerStateDir, "keys", "missing.key") }),
  });
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /launch key unavailable/);
  assert.equal(JSON.parse(fs.readFileSync(readyFile, "utf8")).ok, false);
});

test("Claude project channel forwards normal owner input", async () => {
  const { workspace } = await claudeWorkspace();
  const channel = await startChannel(workspace);
  await deliver(workspace, channel, { id: "owner-message-1", content: "please continue" }, { notified: true });
  const { exitCode, stderr, report } = await readiness(workspace);
  await channel.stop();
  assert.equal(exitCode, 0, stderr);
  assert.deepEqual(eventTypes(report), ["owner_activity"]);
});

test("Claude project channel forwards allowed guest input without owner activity", async () => {
  const { workspace } = await claudeWorkspace();
  const channel = await startChannel(workspace);
  await deliver(workspace, channel, { id: "guest-message-1", content: "guest question", author: { id: "guest-id", username: "Guest" } },
    { notified: true });
  await channel.stop();
  assert.equal(channel.notifications()[0].content, "guest question");
  const { report } = await readiness(workspace);
  assert.deepEqual(report.events, []);
});

test("Claude successful reply exposes a confirmed input-needed receipt", async () => {
  const { workspace } = await claudeWorkspace();
  const channel = await startChannel(workspace);
  const result = await answeredTurn(workspace, channel);
  const replyId = sentId(result);
  assert.ok(replyId, JSON.stringify(result));
  const { exitCode, stderr, report } = await readiness(workspace);
  await channel.stop();
  assert.equal(exitCode, 0, stderr);
  assert.deepEqual(eventTypes(report), ["owner_activity", "response_delivered", "input_needed"]);
  assert.equal(report.events[1].message_id, replyId);
  assert.equal(report.events[1].provider_session_id, "fixture-claude-launch");
  const stateDir = reminderStateDir(workspace);
  const sync = await runScript(workspace, "scripts/conversation-reminder-service.py", {
    args: ["sync", "--project-root", workspace.repoDir, "--state-dir", stateDir], env: routerEnv(workspace),
  });
  assert.equal(sync.exitCode, 0, sync.stderr || sync.stdout);
  const status = await runScript(workspace, "scripts/conversation-reminder-service.py", {
    args: ["status", "--project-root", workspace.repoDir, "--state-dir", stateDir], env: routerEnv(workspace),
  });
  assert.equal(JSON.parse(status.stdout).conversations.demo.state, "awaiting-owner");
  assert.equal(JSON.parse(status.stdout).delivery_enabled, false);
});

test("Claude progress reply remains non-qualifying until a Stop hook", async () => {
  const { workspace } = await claudeWorkspace();
  const channel = await startChannel(workspace);
  await answeredTurn(workspace, channel, { conversation_disposition: "progress" });
  await channel.stop();
  const { report } = await readiness(workspace);
  assert.deepEqual(eventTypes(report), ["owner_activity", "response_delivered"]);
  assert.equal(report.events[1].disposition, "progress");
});

test("a multipart Claude question arms input-needed only after its last confirmed chunk", async () => {
  const { workspace } = await claudeWorkspace();
  const channel = await startChannel(workspace);
  const result = await answeredTurn(workspace, channel, { text: `${"a".repeat(1500)}\n${"b".repeat(1500)}` });
  await channel.stop();
  const ids = /ids: (.+)\)/.exec(result.content[0].text)[1].split(", ");
  assert.equal(ids.length, 2, result.content[0].text);
  const { report } = await readiness(workspace);
  assert.deepEqual(eventTypes(report), ["owner_activity", "response_delivered", "response_delivered", "input_needed"]);
  assert.equal(report.events.at(-1).message_id, ids[1]);
});

test("Claude Stop hook qualifies a confirmed reply after foreground work finishes", async () => {
  const { workspace } = await claudeWorkspace();
  const start = await runHook(workspace, "SessionStart");
  assert.equal(start.exitCode, 0, start.stderr);
  const channel = await startChannel(workspace);
  const replyId = sentId(await answeredTurn(workspace, channel));
  await channel.stop();
  const stop = await runHook(workspace, "Stop", { stop_hook_active: false, background_tasks: [], session_crons: [] });
  assert.equal(stop.exitCode, 0, stop.stderr);
  const { report } = await readiness(workspace);
  assert.deepEqual(eventTypes(report), ["owner_activity", "response_delivered", "input_needed", "turn_completed"]);
  assert.deepEqual(report.events.at(-1).delivered_message_ids, [replyId]);
});

test("owner continuation after an active Claude question records resumed work", async () => {
  const { workspace } = await claudeWorkspace();
  const channel = await startChannel(workspace);
  await answeredTurn(workspace, channel);
  await deliver(workspace, channel, { id: "owner-message-2", content: "Option A" }, { notified: true });
  await channel.stop();
  const { report } = await readiness(workspace);
  assert.deepEqual(eventTypes(report), [
    "owner_activity", "response_delivered", "input_needed", "owner_activity", "work_resumed",
  ]);
});

// A pre-contract launch's reminder-proxy marker, or any marker the live
// channel server didn't write, never proves the Router transport.
for (const [name, change] of [
  ["a reminder-proxy transport", { transport: "official-discord-stdio-proxy", plugin_version: "0.0.4" }],
  ["an unverified reply tool", { reply_tool_verified: false }],
  ["an unsupported server version", { server_version: "9.9.9" }],
]) {
  test(`Claude readiness rejects a capability marker with ${name}`, async () => {
    const { workspace } = await claudeWorkspace();
    const channel = await startChannel(workspace);
    assert.equal((await readiness(workspace)).exitCode, 0);
    const marker = path.join(reminderStateDir(workspace), "capabilities", "demo.json");
    fs.writeFileSync(marker, JSON.stringify({ ...JSON.parse(fs.readFileSync(marker, "utf8")), ...change }), { mode: 0o600 });
    const { exitCode, report } = await readiness(workspace);
    await channel.stop();
    assert.equal(exitCode, 2);
    assert.match(report.unsupported_capabilities.join(" "),
      /Claude launch-scoped transport is not verified for this assignment; restart the session with scripts\/start-session\.sh demo/);
  });
}

test("Claude readiness does not treat a local marker as proof of remote deployment", async () => {
  const { workspace, registry } = await claudeWorkspace();
  const channel = await startChannel(workspace);
  registry.projects.demo.path = "remote:example-host:/srv/demo";
  fs.writeFileSync(path.join(workspace.repoDir, "registry.json"), JSON.stringify(registry));
  const { exitCode, report } = await readiness(workspace);
  await channel.stop();
  assert.equal(exitCode, 2);
  assert.match(report.unsupported_capabilities.join(" "), /remote Claude adapter deployment/);
});

test("root Claude hears the owner's root mentions in a project channel and records no reminder events", async () => {
  const { workspace } = await claudeWorkspace();
  writeRootKey(workspace, "root-key");
  const root = await startChannel(workspace, { root: true });
  const project = await startChannel(workspace);
  await deliver(workspace, root, { id: "root-close-1", content: `<@${ROOT_BOT_ID}> /close` }, { notified: true });
  await deliver(workspace, root, { id: "root-management-1", content: `<@${ROOT_BOT_ID}> status` }, { notified: true });
  await root.stop();
  await project.stop();
  assert.deepEqual(project.notifications(), []);
  const status = await runScript(workspace, "scripts/conversation-reminder-events.py", {
    args: ["status", "--project", "demo", "--state-dir", reminderStateDir(workspace)],
  });
  assert.equal(status.exitCode, 0, status.stderr);
  // The reminder service's observer classifies root management; the sessions record none of it.
  assert.deepEqual(JSON.parse(status.stdout).events, []);
});

test("an allowed guest /close never reaches Claude or changes owner readiness", async () => {
  const { workspace } = await claudeWorkspace();
  const channel = await startChannel(workspace);
  await deliver(workspace, channel, { id: "guest-close-1", content: "/close", author: { id: "guest-id", username: "Guest" } });
  await channel.stop();
  assert.deepEqual(channel.notifications(), []);
  const { report } = await readiness(workspace);
  assert.deepEqual(report.events, []);
});

test("Claude background work and failed turns do not qualify completion", async () => {
  const { workspace } = await claudeWorkspace();
  assert.equal((await runHook(workspace, "SessionStart")).exitCode, 0);
  const channel = await startChannel(workspace);
  await answeredTurn(workspace, channel);
  await channel.stop();
  const paused = await runHook(workspace, "Stop", {
    stop_hook_active: false, background_tasks: [{ id: "task-1", type: "shell", status: "running" }], session_crons: [],
  });
  assert.equal(paused.exitCode, 0, paused.stderr);
  const failed = await runHook(workspace, "StopFailure", { error: "rate_limit" });
  assert.equal(failed.exitCode, 0, failed.stderr);
  const { report } = await readiness(workspace);
  assert.deepEqual(eventTypes(report), ["owner_activity", "response_delivered", "input_needed"]);
});

test("a failed Claude reply cannot supply an input-needed receipt", async () => {
  const { workspace } = await claudeWorkspace();
  const channel = await startChannel(workspace);
  await deliver(workspace, channel, { id: "owner-message-1", content: "hello" }, { notified: true });
  const seed = readState(workspace.stateDir);
  seed.fixtures.discord.restFailures = [{ method: "POST", path: WEBHOOK_EXECUTE, status: 500 }];
  writeState(seed, workspace.stateDir);
  const result = await channel.call("reply", replyArgs());
  await channel.stop();
  assert.equal(result.isError, true, JSON.stringify(result));
  assert.equal(readState(workspace.stateDir).fixtures.discord.restFailureUses.length, 1);
  const { report } = await readiness(workspace);
  assert.deepEqual(eventTypes(report), ["owner_activity"]);
});

test("Claude channel instructions require reply correlation without modifying inbound text", async () => {
  const { workspace } = await claudeWorkspace();
  const channel = await startChannel(workspace);
  await deliver(workspace, channel, { id: "owner-message-1", content: "work on this" }, { notified: true });
  await channel.stop();
  assert.match(channel.initialize.result.instructions, /conversation_interaction_id/);
  assert.equal(channel.notifications()[0].content, "work on this");
});

test("Claude reply tool exposes explicit interaction and input-needed fields", async () => {
  const { workspace } = await claudeWorkspace();
  const channel = await startChannel(workspace);
  await channel.stop();
  const reply = channel.tools.result.tools.find(tool => tool.name === "reply");
  assert.deepEqual(reply.inputSchema.required, ["chat_id", "text", "conversation_interaction_id"]);
  assert.deepEqual(reply.inputSchema.properties.conversation_disposition.enum, ["progress", "input-needed"]);
});

test("Claude event outbox replays after a receiver outage", async () => {
  const { workspace } = await claudeWorkspace();
  const channel = await startChannel(workspace, { receiverOutage: true });
  await deliver(workspace, channel, { id: "owner-message-1", content: "hello" }, { notified: true });
  await channel.stop();
  const before = await readiness(workspace);
  assert.equal(before.report.event_receiver.pending_count, 1);
  const replay = await runScript(workspace, "scripts/conversation-reminder-events.py", {
    args: ["drain", "--project-root", workspace.repoDir, "--state-dir", reminderStateDir(workspace)],
  });
  assert.equal(replay.exitCode, 0, replay.stderr);
  const after = await readiness(workspace);
  assert.deepEqual(eventTypes(after.report), ["owner_activity"]);
  assert.equal(after.report.event_receiver.pending_count, 0);
});

test("Claude channel startup replays an outbox event without new conversation input", async () => {
  const { workspace } = await claudeWorkspace();
  const outage = await startChannel(workspace, { receiverOutage: true });
  await deliver(workspace, outage, { id: "owner-message-1", content: "hello" }, { notified: true });
  await outage.stop();
  const relaunched = await startChannel(workspace);
  await waitFor(() => fs.readdirSync(path.join(reminderStateDir(workspace), "outbox"), { recursive: true })
    .every(name => !String(name).endsWith(".json")), () => "the startup outbox drain");
  await relaunched.stop();
  const { report } = await readiness(workspace);
  assert.deepEqual(eventTypes(report), ["owner_activity"]);
  assert.equal(report.event_receiver.pending_count, 0);
});

test("Claude SessionEnd reports termination without promoting progress to completion", async () => {
  const { workspace } = await claudeWorkspace();
  assert.equal((await runHook(workspace, "SessionStart")).exitCode, 0);
  const channel = await startChannel(workspace);
  await deliver(workspace, channel, { id: "owner-message-1", content: "hello" }, { notified: true });
  await channel.stop();
  const ended = await runHook(workspace, "SessionEnd", { reason: "logout" });
  assert.equal(ended.exitCode, 0, ended.stderr);
  const { report } = await readiness(workspace);
  assert.deepEqual(eventTypes(report), ["owner_activity", "session_terminated"]);
});

test("Claude readiness rejects a launch without command completion hooks", async () => {
  const { workspace } = await claudeWorkspace();
  const channel = await startChannel(workspace, { noHooksConfig: true });
  const { exitCode, report } = await readiness(workspace);
  await channel.stop();
  assert.equal(exitCode, 2);
  assert.match(report.unsupported_capabilities.join(" "), /Claude launch-scoped transport/);
});

test("Claude readiness rejects a launch that leaves the official Discord plugin enabled", async () => {
  const { workspace } = await claudeWorkspace();
  const channel = await startChannel(workspace, { noSingleListenerConfig: true });
  const { exitCode, report } = await readiness(workspace);
  await channel.stop();
  assert.equal(exitCode, 2);
  assert.match(report.unsupported_capabilities.join(" "), /Claude launch-scoped transport/);
});

test("Claude project channel never hears a message outside its assigned channel", async () => {
  const { workspace } = await claudeWorkspace();
  const channel = await startChannel(workspace);
  await deliver(workspace, channel, { id: "other-message", channelId: "channel-elsewhere", content: "hello from elsewhere" });
  await channel.stop();
  assert.deepEqual(channel.notifications(), []);
});

test("Claude project reply cannot target an unassigned channel", async () => {
  const { workspace } = await claudeWorkspace();
  const channel = await startChannel(workspace);
  await deliver(workspace, channel, { id: "owner-message-1", content: "hello" }, { notified: true });
  const result = await channel.call("reply", replyArgs({ chat_id: "channel-elsewhere" }));
  await channel.stop();
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /scope_violation/);
  assert.deepEqual(readState(workspace.stateDir).fixtures.discord.messages ?? [], []);
  const { report } = await readiness(workspace);
  assert.deepEqual(eventTypes(report), ["owner_activity"]);
});

test("Claude project history tool cannot read an unassigned channel", async () => {
  const { workspace } = await claudeWorkspace();
  const channel = await startChannel(workspace);
  const result = await channel.call("fetch_messages", { channel: "channel-elsewhere", limit: 5 });
  await channel.stop();
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /scope_violation/);
  assert.deepEqual(readState(workspace.stateDir).fixtures.discord.fetches ?? [], []);
});

test("shared receiver rejects a Claude owner event after provider reassignment", async () => {
  const { workspace, registry } = await claudeWorkspace();
  registry.projects.demo.type = "codex";
  fs.writeFileSync(path.join(workspace.repoDir, "registry.json"), JSON.stringify(registry));
  const event = {
    schema_version: 1, event_id: "fixture-claude-stale-1", event_type: "owner_activity",
    project: "demo", channel_id: "channel-1", bot_id: `router:${WEBHOOK_ID}`, assignment_generation: "generation-1",
    provider: "claude", provider_session_id: "fixture-claude-launch",
    event_time: "2026-09-24T10:00:00.000Z", event_order: "0000000001000000:fixture:000000000001",
    adapter_instance_id: "fixture", actor_id: OWNER_ID, source_message_id: "owner-message-1", activity_kind: "message",
  };
  const result = await runScript(workspace, "scripts/conversation-reminder-events.py", {
    args: ["ingest", "--project-root", workspace.repoDir, "--state-dir", reminderStateDir(workspace)],
    input: JSON.stringify(event),
  });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, "rejected");
});

function startSession(workspace) {
  return runScript(workspace, "scripts/start-session.sh", { args: ["demo"], env: routerEnv(workspace), timeoutMs: 30000 });
}

test("Claude launcher, channel server, command hooks and readiness share one launch identity", async () => {
  const { workspace } = await claudeWorkspace();
  const seed = readState(workspace.stateDir);
  seed.fixtures.claude.toolScript = [{ name: "reply", arguments: {
    chat_id: "{{chat_id}}", text: "working on it", conversation_interaction_id: "{{message_id}}",
    conversation_disposition: "progress",
  } }];
  writeState(seed, workspace.stateDir);
  const launched = await startSession(workspace);
  assert.equal(launched.exitCode, 0, launched.stderr || launched.stdout);
  const launchEnv = JSON.parse(fs.readFileSync(path.join(workspace.routerStateDir, "launches", "demo", "reminder-env.json"), "utf8"));

  injectDiscordMessage(workspace, { id: "owner-message-1", channelId: "channel-1", content: "answer this",
    author: { id: OWNER_ID, username: "Owner" } });
  await waitForState(workspace, state => (state.fixtures.claude.hookRuns ?? []).some(run => run.event === "Stop"), 15000);
  const { exitCode, stderr, report } = await readiness(workspace);
  assert.equal(exitCode, 0, stderr);
  assert.deepEqual(eventTypes(report), ["owner_activity", "response_delivered", "turn_completed"]);
  assert.deepEqual(report.events.slice(1).map(event => event.provider_session_id),
    [launchEnv.CCDM_CLAUDE_LAUNCH_ID, launchEnv.CCDM_CLAUDE_LAUNCH_ID]);
  const marker = path.join(reminderStateDir(workspace), "capabilities", "demo.json");
  assert.equal(JSON.parse(fs.readFileSync(marker, "utf8")).launch_id, launchEnv.CCDM_CLAUDE_LAUNCH_ID);

  const stopped = await runScript(workspace, "scripts/stop-session.sh", { args: ["demo"], env: routerEnv(workspace) });
  assert.equal(stopped.exitCode, 0, stopped.stderr || stopped.stdout);
  assert.equal(fs.existsSync(marker), false, "stopping the launch removes its capability marker");
  const exited = await readiness(workspace);
  assert.equal(exited.exitCode, 2);
  assert.match(exited.report.unsupported_capabilities.join(" "), /Claude launch-scoped transport/);
});

test("a killed Claude channel server never leaves a stale ready transport", async () => {
  const { workspace } = await claudeWorkspace();
  const launched = await startSession(workspace);
  assert.equal(launched.exitCode, 0, launched.stderr || launched.stdout);
  assert.equal((await readiness(workspace)).exitCode, 0);

  // The channel server dies without cleanup, as with SIGKILL: its marker
  // survives but no longer proves a live launch.
  const marker = path.join(reminderStateDir(workspace), "capabilities", "demo.json");
  process.kill(JSON.parse(fs.readFileSync(marker, "utf8")).pid, "SIGKILL");
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(fs.existsSync(marker), true);
  const dead = await readiness(workspace);
  assert.equal(dead.exitCode, 2);
  assert.match(dead.report.unsupported_capabilities.join(" "),
    /Claude launch-scoped transport is not running for this assignment; restart the session with scripts\/start-session\.sh demo/);

  const stopped = await runScript(workspace, "scripts/stop-session.sh", { args: ["demo"], env: routerEnv(workspace) });
  assert.equal(stopped.exitCode, 0, stopped.stderr || stopped.stdout);
  assert.equal(fs.existsSync(marker), false, "stop-session removes the launch's capability marker");
  // A relaunch replaces any earlier marker with its own live channel server's.
  fs.writeFileSync(marker, JSON.stringify({ stale: true }), { mode: 0o600 });
  const relaunched = await startSession(workspace);
  assert.equal(relaunched.exitCode, 0, relaunched.stderr || relaunched.stdout);
  assert.equal(JSON.parse(fs.readFileSync(marker, "utf8")).transport, "ccdm-channel-server");
  assert.equal((await readiness(workspace)).exitCode, 0);
});

test("a Claude input-needed receipt replayed after downtime gets one catch-up from root", async () => {
  const { workspace } = await claudeWorkspace();
  const stateDir = reminderStateDir(workspace);
  const clockFile = path.join(workspace.tmpDir, "reminder-clock");
  const env = routerEnv(workspace, { CCDM_REMINDER_NODE: process.execPath, CCDM_REMINDER_CLOCK_FILE: clockFile });
  const service = async (name, expected = 0) => {
    const result = await runScript(workspace, "scripts/conversation-reminder-service.py", {
      args: [name, "--project-root", workspace.repoDir, "--state-dir", stateDir], env });
    assert.equal(result.exitCode, expected, result.stderr || result.stdout);
    return JSON.parse(result.stdout);
  };
  const worker = () => runScript(workspace, "scripts/conversation-reminder-service.py", {
    args: ["run", "--project-root", workspace.repoDir, "--state-dir", stateDir], env, timeoutMs: 30000 });
  const at = offset => new Date(now + offset).toISOString();
  const message = (id, timestamp, author) => ({ id, timestamp, content: "text", type: 0, attachments: [],
    author: { id: author, bot: author === WEBHOOK_ID }, ...(author === WEBHOOK_ID ? { webhook_id: WEBHOOK_ID } : {}) });
  const waitForStatus = async predicate => {
    for (let attempt = 0; attempt < 200; attempt++) {
      const current = await service("status");
      if (predicate(current)) return current;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(JSON.stringify(await service("status")));
  };
  const now = Date.now();
  // Before downtime the owner thanked the session, so the conversation is paused.
  const seed = readState(workspace.stateDir);
  seed.fixtures.discord.history = { "channel-1": [message("old-3", at(-2 * 3600000), OWNER_ID),
    message("old-2", at(-3 * 3600000 + 300000), WEBHOOK_ID), message("old-1", at(-3 * 3600000), OWNER_ID)] };
  writeState(seed, workspace.stateDir);
  // The live channel server records its verified transport while it runs.
  const warmup = await startChannel(workspace);
  await service("enable");
  fs.writeFileSync(clockFile, at(-90 * 60000));
  let running = worker();
  const paused = await waitForStatus(current => current.conversations.demo?.reconciliation_status === "ready");
  assert.deepEqual([paused.conversations.demo.state, paused.readiness.projects.demo.provider,
    paused.readiness.projects.demo.adapter], ["open-paused", "claude", "ready-observe-only"]);
  await service("disable");
  assert.equal((await running).exitCode, 0);
  await warmup.stop();

  // Downtime: the stopped service misses a Claude question the channel server durably recorded.
  const asked = await startChannel(workspace);
  const replyId = sentId(await answeredTurn(workspace, asked));
  await asked.stop();
  const history = readState(workspace.stateDir);
  history.fixtures.discord.history["channel-1"].unshift(message(replyId, at(0), WEBHOOK_ID),
    message("owner-message-1", at(-1000), OWNER_ID));
  writeState(history, workspace.stateDir);
  // The Claude session is relaunched before reminders resume.
  const relaunched = await startChannel(workspace);
  await service("enable");
  fs.writeFileSync(clockFile, at(2 * 3600000));
  running = worker();
  const sent = await waitForState(workspace, state =>
    (state.fixtures.discord.messages ?? []).some(row => row.content === "👀"), 20000);
  const reminder = sent.fixtures.discord.messages.find(row => row.content === "👀");
  assert.deepEqual([reminder.channelId, reminder.authorization], ["channel-1", `Bot ${ROOT_TOKEN}`]);
  const released = await waitForStatus(current => current.conversations.demo.reminder_message_id);
  assert.equal(released.conversations.demo.state, "awaiting-owner");
  assert.equal(released.conversations.demo.response_message_id, replyId);
  // The catch-up anchors the next gap (two hours after one reminder) to its own
  // send time, not to the missed interval.
  assert.equal(released.conversations.demo.due_at, at(4 * 3600000).replace(".000Z", "Z"));
  assert.equal(released.readiness.projects.demo.delivery_ready, true);
  await new Promise(resolve => setTimeout(resolve, 700));
  assert.equal(readState(workspace.stateDir).fixtures.discord.messages.filter(row => row.content === "👀").length, 1);
  await service("disable");
  assert.equal((await running).exitCode, 0);
  await relaunched.stop();
});
