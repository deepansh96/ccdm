import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { createWorkspace, runNodeEntrypoint, runScript } from "./support/runner.js";
import { seedRegistry } from "./support/state.js";
import { cleanup } from "./support/teardown.js";

test.afterEach(async () => { await cleanup(); });

function seedClaudeAssignment(workspace) {
  const registry = {
    discord_user_id: "owner-id",
    root_bot_app_id: "root-app",
    pool: [{ id: "bot-1", app_id: "app-1", token: "fixture-token", state_dir: path.join(workspace.homeDir, ".claude", "channels", "discord-demo") }],
    projects: { demo: {
      type: "claude", path: workspace.repoDir, bot_id: "bot-1",
      channel_id: "channel-1", assignment_generation: "generation-1",
      screen_name: "demo_claude",
    } },
  };
  fs.writeFileSync(path.join(workspace.repoDir, "registry.json"), JSON.stringify(registry));
  return registry;
}

async function runChannel(workspace, notification, options = {}) {
  const fake = path.join(workspace.tmpDir, "fake-claude-discord-plugin.cjs");
  const pluginRoot = path.join(workspace.tmpDir, "official-plugin");
  const bunArgsFile = path.join(workspace.tmpDir, "bun-args.txt");
  if (options.defaultPluginLaunch) {
    fs.mkdirSync(pluginRoot, { recursive: true });
    fs.writeFileSync(path.join(pluginRoot, "server.ts"), "// fixture server entrypoint\n");
    const fakeBun = path.join(workspace.fixtureDir, "bun");
    fs.writeFileSync(fakeBun, `#!/bin/sh\nprintf '%s\\n' "$@" > '${bunArgsFile}'\nexec '${process.execPath}' '${fake}'\n`, { mode: 0o755 });
  }
  const hookSettings = path.join(workspace.tmpDir, "claude-reminder-hooks.json");
  if (!options.noHooksConfig) {
    const command = `node '${path.join(workspace.repoDir, "scripts", "claude-reminder-hook.js")}'`;
    fs.writeFileSync(hookSettings, JSON.stringify({
      ...(options.noSingleListenerConfig ? {} : { enabledPlugins: { "discord@claude-plugins-official": false } }),
      hooks: Object.fromEntries(
      ["SessionStart", "Stop", "StopFailure", "SessionEnd"].map(event => [event, [{ hooks: [{ type: "command", command }] }]]),
      ),
    }), { mode: 0o600 });
  }
  fs.writeFileSync(fake, `
process.stdin.setEncoding('utf8');
let buffer = '';
process.stdin.on('data', chunk => {
  buffer += chunk;
  for (let end; (end = buffer.indexOf('\\n')) >= 0;) {
    const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
    if (!line) continue;
    const request = JSON.parse(line);
    if (request.method === 'initialize') {
      process.stdout.write(JSON.stringify({jsonrpc:'2.0', id:request.id, result:{protocolVersion:'2025-03-26', capabilities:{experimental:{'claude/channel':{}}, tools:{}}, serverInfo:{name:'discord', version:${JSON.stringify(options.serverVersion || "1.0.0")}}, instructions:'Official Discord reply'}})+'\\n');
    }
    if (request.method === 'notifications/initialized') {
      ${options.noNotification ? "" : `process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/claude/channel',params:${JSON.stringify(notification)}})+'\\n');`}
    }
    if (request.method === 'tools/list') {
      process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result:{tools:${options.noReplyTool ? "[]" : "[{name:'reply',inputSchema:{type:'object',properties:{chat_id:{type:'string'},text:{type:'string'}},required:['chat_id','text']}}]"}}})+'\\n');
    }
    if (request.method === 'tools/call') {
      const unexpectedMetadata = 'conversation_disposition' in request.params.arguments || 'conversation_interaction_id' in request.params.arguments;
      process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result: unexpectedMetadata || ${Boolean(options.failReply)}
        ? {isError:true,content:[{type:'text',text:'delivery failed'}]}
        : {content:[{type:'text',text:${JSON.stringify(options.multipart ? "sent 2 parts (ids: fake-message-1, fake-message-2)" : "sent (id: fake-message-1)")}}]}})+'\\n');
      ${options.resumeNotification ? `process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/claude/channel',params:${JSON.stringify(options.resumeNotification)}})+'\\n');` : ""}
    }
  }
});
`);
  const child = spawn(process.execPath, [path.join(workspace.repoDir, "scripts/claude-reminder-channel.js")], {
    cwd: workspace.repoDir,
    env: {
      ...workspace.env,
      CCDM_REMINDER_PROJECT_ROOT: workspace.repoDir,
      CCDM_REMINDER_STATE_DIR: path.join(workspace.homeDir, ".local", "state", "ccdm", "conversation-reminders"),
      CCDM_CLAUDE_PLUGIN_COMMAND: process.execPath,
      CCDM_CLAUDE_PLUGIN_ARGS: JSON.stringify([fake]),
      CCDM_CLAUDE_PROJECT: options.root ? "" : "demo",
      CCDM_CLAUDE_CHANNEL_ID: options.root ? "" : "channel-1",
      CCDM_CLAUDE_BOT_APP_ID: options.root ? "" : "app-1",
      CCDM_CLAUDE_ROOT_APP_ID: "root-app",
      CCDM_CLAUDE_LAUNCH_ID: "fixture-claude-launch",
      ...(options.noHooksConfig ? {} : { CCDM_CLAUDE_HOOK_SETTINGS: hookSettings }),
      CCDM_REMINDER_RECEIPTS_DIR: path.join(workspace.homeDir, ".local", "state", "ccdm", "conversation-reminders", "claude-receipts"),
      ...(options.receiverOutage ? { CCDM_REMINDER_PYTHON: "/missing/ralph-57-python" } : {}),
      ...(options.launchEnv || {}),
      ...(options.defaultPluginLaunch
        ? { CCDM_CLAUDE_PLUGIN_ROOT: pluginRoot, CCDM_CLAUDE_PLUGIN_COMMAND: "bun", CCDM_CLAUDE_PLUGIN_ARGS: "" }
        : { CCDM_CLAUDE_PLUGIN_COMMAND: process.execPath, CCDM_CLAUDE_PLUGIN_ARGS: JSON.stringify([fake]) }),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const exited = new Promise(resolve => child.once("exit", resolve));
  let output = "";
  let errors = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { errors += chunk; });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "fixture", version: "1" } } }) + "\n");
  for (let attempt = 0; attempt < 100 && !output.includes('"id":1'); attempt++) {
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" }) + "\n");
  let expectedReply = null;
  if (options.reply) {
    for (let attempt = 0; attempt < 100 && !output.includes("notifications/claude/channel"); attempt++) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: {
      name: options.callName || "reply",
      arguments: options.callName === "fetch_messages"
        ? { channel: options.replyChatId || "channel-1", limit: 5 }
        : { chat_id: options.replyChatId || "channel-1", text: "Which option?", conversation_interaction_id: "owner-message-1", conversation_disposition: options.disposition || "input-needed" },
    } }) + "\n");
  }
  if (options.reply) {
    expectedReply = options.replyChatId === "channel-elsewhere" ? "channel not assigned" : options.failReply ? "delivery failed" : options.multipart ? "fake-message-2" : "fake-message-1";
    for (let attempt = 0; attempt < 100 && !output.includes(expectedReply); attempt++) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
  if (options.expectNotification) {
    for (let attempt = 0; attempt < 100 && !output.includes("notifications/claude/channel"); attempt++) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
  if (options.serverVersion === undefined || options.serverVersion === "1.0.0") {
    for (let attempt = 0; attempt < 100 && !output.includes('"id":3'); attempt++) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
  await new Promise(resolve => setTimeout(resolve, 100));
  child.kill();
  await exited;
  if (options.reply || options.expectNotification) assert.match(output, /notifications\/claude\/channel/, errors);
  if (expectedReply) assert.ok(output.includes(expectedReply), errors);
  if (options.serverVersion === undefined || options.serverVersion === "1.0.0") assert.match(output, /"id":3/, errors);
  return { output, errors, bunArgs: options.defaultPluginLaunch ? fs.readFileSync(bunArgsFile, "utf8").trim().split("\n") : [] };
}

async function runHook(workspace, hook_event_name, fields = {}, extraEnv = {}) {
  return runNodeEntrypoint(workspace, "scripts/claude-reminder-hook.js", {
    env: {
      CCDM_CLAUDE_PROJECT: "demo",
      CCDM_CLAUDE_CHANNEL_ID: "channel-1",
      CCDM_CLAUDE_BOT_APP_ID: "app-1",
      CCDM_CLAUDE_LAUNCH_ID: "fixture-claude-launch",
      CCDM_REMINDER_PROJECT_ROOT: workspace.repoDir,
      CCDM_REMINDER_STATE_DIR: path.join(workspace.homeDir, ".local", "state", "ccdm", "conversation-reminders"),
      CCDM_REMINDER_RECEIPTS_DIR: path.join(workspace.homeDir, ".local", "state", "ccdm", "conversation-reminders", "claude-receipts"),
      ...extraEnv,
    },
    input: JSON.stringify({ hook_event_name, session_id: "fixture-session", ...fields }),
  });
}

test("Claude project channel consumes owner /close before model notification", async () => {
  const workspace = createWorkspace();
  seedClaudeAssignment(workspace);
  const { output, errors } = await runChannel(workspace, {
    content: "  <@!app-1>   /close  ",
    meta: { chat_id: "channel-1", message_id: "owner-close-1", user_id: "owner-id" },
  });
  assert.match(output, /"id":1/);
  assert.doesNotMatch(output, /notifications\/claude\/channel/);
  const readiness = await runScript(workspace, "scripts/conversation-reminder-readiness.py", { args: ["demo", "--json"] });
  assert.equal(readiness.exitCode, 0, errors || readiness.stderr);
  assert.deepEqual(JSON.parse(readiness.stdout).events.map(event => event.event_type), ["close_requested"]);
  assert.match(JSON.parse(readiness.stdout).tested_runtime.bridge_contract, /Claude Code/);
});

test("Claude channel starts the installed server without a package install script", async () => {
  const workspace = createWorkspace();
  seedClaudeAssignment(workspace);
  const { bunArgs } = await runChannel(workspace, {
    content: "hello",
    meta: { chat_id: "channel-1", message_id: "owner-message-1", user_id: "owner-id" },
  }, { defaultPluginLaunch: true, expectNotification: true });
  assert.deepEqual(bunArgs, [path.join(workspace.tmpDir, "official-plugin", "server.ts")]);
});

test("Claude project channel rejects an incomplete assignment before starting its listener", async () => {
  const workspace = createWorkspace();
  const result = await runNodeEntrypoint(workspace, "scripts/claude-reminder-channel.js", {
    env: { CCDM_CLAUDE_PROJECT: "demo", CCDM_CLAUDE_CHANNEL_ID: "", CCDM_CLAUDE_BOT_APP_ID: "app-1" },
  });
  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /incomplete Claude project assignment/);
});

test("Claude project channel forwards normal owner input after the official gate", async () => {
  const workspace = createWorkspace();
  seedClaudeAssignment(workspace);
  const { output } = await runChannel(workspace, {
    content: "please continue",
    meta: { chat_id: "channel-1", message_id: "owner-message-1", user_id: "owner-id" },
  }, { expectNotification: true });
  assert.match(output, /notifications\/claude\/channel/);
  const readiness = await runScript(workspace, "scripts/conversation-reminder-readiness.py", { args: ["demo", "--json"] });
  assert.equal(readiness.exitCode, 0, readiness.stderr);
  assert.deepEqual(JSON.parse(readiness.stdout).events.map(event => event.event_type), ["owner_activity"]);
});

test("Claude project channel forwards allowed guest input without owner activity", async () => {
  const workspace = createWorkspace();
  seedClaudeAssignment(workspace);
  const { output } = await runChannel(workspace, {
    content: "guest question",
    meta: { chat_id: "channel-1", message_id: "guest-message-1", user_id: "guest-id" },
  }, { expectNotification: true });
  assert.match(output, /guest question/);
  const readiness = await runScript(workspace, "scripts/conversation-reminder-readiness.py", { args: ["demo", "--json"] });
  assert.deepEqual(JSON.parse(readiness.stdout).events, []);
});

test("Claude successful reply exposes a confirmed input-needed receipt", async () => {
  const workspace = createWorkspace();
  seedClaudeAssignment(workspace);
  const { output } = await runChannel(workspace, {
    content: "choose an option",
    meta: { chat_id: "channel-1", message_id: "owner-message-1", user_id: "owner-id" },
  }, { reply: true });
  assert.match(output, /fake-message-1/);
  const readiness = await runScript(workspace, "scripts/conversation-reminder-readiness.py", { args: ["demo", "--json"] });
  assert.equal(readiness.exitCode, 0, readiness.stderr);
  const events = JSON.parse(readiness.stdout).events;
  assert.deepEqual(events.map(event => event.event_type), ["owner_activity", "response_delivered", "input_needed"]);
  assert.equal(events[1].message_id, "fake-message-1");
  assert.equal(events[1].provider_session_id, "fixture-claude-launch");
});

test("Claude progress reply remains non-qualifying until a Stop hook", async () => {
  const workspace = createWorkspace();
  seedClaudeAssignment(workspace);
  await runChannel(workspace, {
    content: "begin",
    meta: { chat_id: "channel-1", message_id: "owner-message-1", user_id: "owner-id" },
  }, { reply: true, disposition: "progress" });
  const readiness = await runScript(workspace, "scripts/conversation-reminder-readiness.py", { args: ["demo", "--json"] });
  assert.deepEqual(JSON.parse(readiness.stdout).events.map(event => event.event_type), ["owner_activity", "response_delivered"]);
  assert.equal(JSON.parse(readiness.stdout).events[1].disposition, "progress");
});

test("a multipart Claude question arms input-needed only after its last confirmed chunk", async () => {
  const workspace = createWorkspace();
  seedClaudeAssignment(workspace);
  await runChannel(workspace, {
    content: "begin",
    meta: { chat_id: "channel-1", message_id: "owner-message-1", user_id: "owner-id" },
  }, { reply: true, multipart: true });
  const readiness = await runScript(workspace, "scripts/conversation-reminder-readiness.py", { args: ["demo", "--json"] });
  const events = JSON.parse(readiness.stdout).events;
  assert.deepEqual(events.map(event => event.event_type), ["owner_activity", "response_delivered", "response_delivered", "input_needed"]);
  assert.equal(events.at(-1).message_id, "fake-message-2");
});

test("Claude Stop hook qualifies a confirmed reply after foreground work finishes", async () => {
  const workspace = createWorkspace();
  seedClaudeAssignment(workspace);
  const start = await runHook(workspace, "SessionStart");
  assert.equal(start.exitCode, 0, start.stderr);
  await runChannel(workspace, {
    content: "choose an option",
    meta: { chat_id: "channel-1", message_id: "owner-message-1", user_id: "owner-id" },
  }, { reply: true });
  const stop = await runHook(workspace, "Stop", { stop_hook_active: false, background_tasks: [], session_crons: [] });
  assert.equal(stop.exitCode, 0, stop.stderr);
  const readiness = await runScript(workspace, "scripts/conversation-reminder-readiness.py", { args: ["demo", "--json"] });
  assert.deepEqual(JSON.parse(readiness.stdout).events.map(event => event.event_type), ["owner_activity", "response_delivered", "input_needed", "turn_completed"]);
  assert.deepEqual(JSON.parse(readiness.stdout).events.at(-1).delivered_message_ids, ["fake-message-1"]);
});

test("owner continuation after an active Claude question records resumed work", async () => {
  const workspace = createWorkspace();
  seedClaudeAssignment(workspace);
  await runChannel(workspace, {
    content: "choose an option",
    meta: { chat_id: "channel-1", message_id: "owner-message-1", user_id: "owner-id" },
  }, { reply: true, resumeNotification: {
    content: "Option A",
    meta: { chat_id: "channel-1", message_id: "owner-message-2", user_id: "owner-id" },
  } });
  const readiness = await runScript(workspace, "scripts/conversation-reminder-readiness.py", { args: ["demo", "--json"] });
  assert.deepEqual(JSON.parse(readiness.stdout).events.map(event => event.event_type), [
    "owner_activity", "response_delivered", "input_needed", "owner_activity", "work_resumed",
  ]);
});

test("Claude readiness rejects an unsupported official transport version", async () => {
  const workspace = createWorkspace();
  seedClaudeAssignment(workspace);
  await runChannel(workspace, {
    content: "hello",
    meta: { chat_id: "channel-1", message_id: "owner-message-1", user_id: "owner-id" },
  }, { serverVersion: "9.9.9" });
  const readiness = await runScript(workspace, "scripts/conversation-reminder-readiness.py", { args: ["demo", "--json"] });
  assert.equal(readiness.exitCode, 2);
  assert.match(JSON.parse(readiness.stdout).unsupported_capabilities.join(" "), /Claude launch-scoped transport/);
});

test("Claude readiness rejects a channel without the official reply tool", async () => {
  const workspace = createWorkspace();
  seedClaudeAssignment(workspace);
  await runChannel(workspace, {
    content: "hello",
    meta: { chat_id: "channel-1", message_id: "owner-message-1", user_id: "owner-id" },
  }, { noReplyTool: true });
  const readiness = await runScript(workspace, "scripts/conversation-reminder-readiness.py", { args: ["demo", "--json"] });
  assert.equal(readiness.exitCode, 2);
  assert.match(JSON.parse(readiness.stdout).unsupported_capabilities.join(" "), /Claude launch-scoped transport/);
});

test("Claude readiness does not treat a local marker as proof of remote deployment", async () => {
  const workspace = createWorkspace();
  const registry = seedClaudeAssignment(workspace);
  await runChannel(workspace, {
    content: "hello",
    meta: { chat_id: "channel-1", message_id: "owner-message-1", user_id: "owner-id" },
  });
  registry.projects.demo.path = "remote:example-host:/srv/demo";
  fs.writeFileSync(path.join(workspace.repoDir, "registry.json"), JSON.stringify(registry));
  const readiness = await runScript(workspace, "scripts/conversation-reminder-readiness.py", { args: ["demo", "--json"] });
  assert.equal(readiness.exitCode, 2);
  assert.match(JSON.parse(readiness.stdout).unsupported_capabilities.join(" "), /remote Claude adapter deployment/);
});

test("root Claude routing consumes an allowed mention /close without a model notification", async () => {
  const workspace = createWorkspace();
  seedClaudeAssignment(workspace);
  const { output } = await runChannel(workspace, {
    content: "<@root-app> /close",
    meta: { chat_id: "channel-1", message_id: "root-close-1", user_id: "owner-id" },
  }, { root: true });
  assert.doesNotMatch(output, /notifications\/claude\/channel/);
  const status = await runScript(workspace, "scripts/conversation-reminder-events.py", {
    args: ["status", "--project", "demo", "--state-dir", path.join(workspace.homeDir, ".local", "state", "ccdm", "conversation-reminders")],
  });
  assert.equal(status.exitCode, 0, status.stderr);
  assert.deepEqual(JSON.parse(status.stdout).events.map(event => event.event_type), ["close_requested"]);
  assert.equal(JSON.parse(status.stdout).events[0].provider, "ccdm-root");
});

test("an allowed guest /close never reaches Claude or changes owner readiness", async () => {
  const workspace = createWorkspace();
  seedClaudeAssignment(workspace);
  const { output } = await runChannel(workspace, {
    content: "/close",
    meta: { chat_id: "channel-1", message_id: "guest-close-1", user_id: "guest-id" },
  });
  assert.doesNotMatch(output, /notifications\/claude\/channel/);
  const readiness = await runScript(workspace, "scripts/conversation-reminder-readiness.py", { args: ["demo", "--json"] });
  assert.deepEqual(JSON.parse(readiness.stdout).events, []);
});

test("Claude background work and failed turns do not qualify completion", async () => {
  const workspace = createWorkspace();
  seedClaudeAssignment(workspace);
  assert.equal((await runHook(workspace, "SessionStart")).exitCode, 0);
  await runChannel(workspace, {
    content: "start work",
    meta: { chat_id: "channel-1", message_id: "owner-message-1", user_id: "owner-id" },
  }, { reply: true });
  const paused = await runHook(workspace, "Stop", {
    stop_hook_active: false, background_tasks: [{ id: "task-1", type: "shell", status: "running" }], session_crons: [],
  });
  assert.equal(paused.exitCode, 0, paused.stderr);
  const failed = await runHook(workspace, "StopFailure", { error: "rate_limit" });
  assert.equal(failed.exitCode, 0, failed.stderr);
  const readiness = await runScript(workspace, "scripts/conversation-reminder-readiness.py", { args: ["demo", "--json"] });
  assert.deepEqual(JSON.parse(readiness.stdout).events.map(event => event.event_type), ["owner_activity", "response_delivered", "input_needed"]);
});

test("a failed Claude reply cannot supply an input-needed receipt", async () => {
  const workspace = createWorkspace();
  seedClaudeAssignment(workspace);
  const { output } = await runChannel(workspace, {
    content: "hello",
    meta: { chat_id: "channel-1", message_id: "owner-message-1", user_id: "owner-id" },
  }, { reply: true, failReply: true });
  assert.match(output, /delivery failed/);
  const readiness = await runScript(workspace, "scripts/conversation-reminder-readiness.py", { args: ["demo", "--json"] });
  assert.deepEqual(JSON.parse(readiness.stdout).events.map(event => event.event_type), ["owner_activity"]);
});

test("Claude channel instructions require reply correlation without modifying inbound text", async () => {
  const workspace = createWorkspace();
  seedClaudeAssignment(workspace);
  const { output } = await runChannel(workspace, {
    content: "work on this",
    meta: { chat_id: "channel-1", message_id: "owner-message-1", user_id: "owner-id" },
  }, { expectNotification: true });
  const initialize = output.split("\n").filter(Boolean).map(line => JSON.parse(line)).find(message => message.id === 1);
  assert.match(initialize.result.instructions, /conversation_interaction_id/);
  assert.match(output, /work on this/);
});

test("Claude reply tool exposes explicit interaction and input-needed fields", async () => {
  const workspace = createWorkspace();
  seedClaudeAssignment(workspace);
  const { output } = await runChannel(workspace, {
    content: "work on this",
    meta: { chat_id: "channel-1", message_id: "owner-message-1", user_id: "owner-id" },
  }, { discover: true });
  const listing = output.split("\n").filter(Boolean).map(line => JSON.parse(line)).find(message => message.id === 3);
  assert.deepEqual(listing.result.tools[0].inputSchema.required, ["chat_id", "text", "conversation_interaction_id"]);
  assert.deepEqual(listing.result.tools[0].inputSchema.properties.conversation_disposition.enum, ["progress", "input-needed"]);
});

test("Claude event outbox replays after a receiver outage", async () => {
  const workspace = createWorkspace();
  seedClaudeAssignment(workspace);
  await runChannel(workspace, {
    content: "hello",
    meta: { chat_id: "channel-1", message_id: "owner-message-1", user_id: "owner-id" },
  }, { receiverOutage: true });
  const before = await runScript(workspace, "scripts/conversation-reminder-readiness.py", { args: ["demo", "--json"] });
  assert.equal(JSON.parse(before.stdout).event_receiver.pending_count, 1);
  const replay = await runScript(workspace, "scripts/conversation-reminder-events.py", {
    args: ["drain", "--project-root", workspace.repoDir, "--state-dir", path.join(workspace.homeDir, ".local", "state", "ccdm", "conversation-reminders")],
  });
  assert.equal(replay.exitCode, 0, replay.stderr);
  const after = await runScript(workspace, "scripts/conversation-reminder-readiness.py", { args: ["demo", "--json"] });
  assert.deepEqual(JSON.parse(after.stdout).events.map(event => event.event_type), ["owner_activity"]);
  assert.equal(JSON.parse(after.stdout).event_receiver.pending_count, 0);
});

test("Claude adapter startup replays an outbox event without new conversation input", async () => {
  const workspace = createWorkspace();
  seedClaudeAssignment(workspace);
  await runChannel(workspace, {
    content: "hello",
    meta: { chat_id: "channel-1", message_id: "owner-message-1", user_id: "owner-id" },
  }, { receiverOutage: true });
  await runChannel(workspace, {}, { noNotification: true });
  const readiness = await runScript(workspace, "scripts/conversation-reminder-readiness.py", { args: ["demo", "--json"] });
  assert.deepEqual(JSON.parse(readiness.stdout).events.map(event => event.event_type), ["owner_activity"]);
  assert.equal(JSON.parse(readiness.stdout).event_receiver.pending_count, 0);
});

test("Claude SessionEnd reports termination without promoting progress to completion", async () => {
  const workspace = createWorkspace();
  seedClaudeAssignment(workspace);
  assert.equal((await runHook(workspace, "SessionStart")).exitCode, 0);
  await runChannel(workspace, {
    content: "hello",
    meta: { chat_id: "channel-1", message_id: "owner-message-1", user_id: "owner-id" },
  });
  const ended = await runHook(workspace, "SessionEnd", { reason: "logout" });
  assert.equal(ended.exitCode, 0, ended.stderr);
  const readiness = await runScript(workspace, "scripts/conversation-reminder-readiness.py", { args: ["demo", "--json"] });
  assert.deepEqual(JSON.parse(readiness.stdout).events.map(event => event.event_type), ["owner_activity", "session_terminated"]);
});

test("root Claude filter rejects unsupported official transport before routing", async () => {
  const workspace = createWorkspace();
  seedClaudeAssignment(workspace);
  const { output, errors } = await runChannel(workspace, {
    content: "<@root-app> /close",
    meta: { chat_id: "channel-1", message_id: "root-close-1", user_id: "owner-id" },
  }, { root: true, serverVersion: "9.9.9" });
  assert.match(errors, /unsupported official Discord transport contract/);
  assert.doesNotMatch(output, /notifications\/claude\/channel/);
});

test("Claude readiness rejects a launch without command completion hooks", async () => {
  const workspace = createWorkspace();
  seedClaudeAssignment(workspace);
  await runChannel(workspace, {
    content: "hello",
    meta: { chat_id: "channel-1", message_id: "owner-message-1", user_id: "owner-id" },
  }, { noHooksConfig: true });
  const readiness = await runScript(workspace, "scripts/conversation-reminder-readiness.py", { args: ["demo", "--json"] });
  assert.equal(readiness.exitCode, 2);
  assert.match(JSON.parse(readiness.stdout).unsupported_capabilities.join(" "), /Claude launch-scoped transport/);
});

test("Claude readiness rejects an unfiltered parallel official channel configuration", async () => {
  const workspace = createWorkspace();
  seedClaudeAssignment(workspace);
  await runChannel(workspace, {
    content: "hello",
    meta: { chat_id: "channel-1", message_id: "owner-message-1", user_id: "owner-id" },
  }, { noSingleListenerConfig: true });
  const readiness = await runScript(workspace, "scripts/conversation-reminder-readiness.py", { args: ["demo", "--json"] });
  assert.equal(readiness.exitCode, 2);
  assert.match(JSON.parse(readiness.stdout).unsupported_capabilities.join(" "), /Claude launch-scoped transport/);
});

test("Claude project filter refuses notifications outside its assigned channel", async () => {
  const workspace = createWorkspace();
  seedClaudeAssignment(workspace);
  const { output } = await runChannel(workspace, {
    content: "hello from elsewhere",
    meta: { chat_id: "channel-elsewhere", message_id: "other-message", user_id: "owner-id" },
  });
  assert.doesNotMatch(output, /notifications\/claude\/channel/);
});

test("Claude project reply cannot target an unassigned channel", async () => {
  const workspace = createWorkspace();
  seedClaudeAssignment(workspace);
  const { output } = await runChannel(workspace, {
    content: "hello",
    meta: { chat_id: "channel-1", message_id: "owner-message-1", user_id: "owner-id" },
  }, { reply: true, replyChatId: "channel-elsewhere" });
  assert.match(output, /channel not assigned/);
  assert.doesNotMatch(output, /fake-message-1/);
  const readiness = await runScript(workspace, "scripts/conversation-reminder-readiness.py", { args: ["demo", "--json"] });
  assert.deepEqual(JSON.parse(readiness.stdout).events.map(event => event.event_type), ["owner_activity"]);
});

test("Claude project history tool cannot read an unassigned channel", async () => {
  const workspace = createWorkspace();
  seedClaudeAssignment(workspace);
  const { output } = await runChannel(workspace, {
    content: "hello",
    meta: { chat_id: "channel-1", message_id: "owner-message-1", user_id: "owner-id" },
  }, { reply: true, callName: "fetch_messages", replyChatId: "channel-elsewhere" });
  assert.match(output, /channel not assigned/);
  assert.doesNotMatch(output, /fake-message-1/);
});

test("shared receiver rejects a Claude owner event after provider reassignment", async () => {
  const workspace = createWorkspace();
  seedClaudeAssignment(workspace);
  const registryPath = path.join(workspace.repoDir, "registry.json");
  const registry = JSON.parse(fs.readFileSync(registryPath, "utf8"));
  registry.projects.demo.type = "codex";
  fs.writeFileSync(registryPath, JSON.stringify(registry));
  const event = {
    schema_version: 1, event_id: "fixture-claude-stale-1", event_type: "owner_activity",
    project: "demo", channel_id: "channel-1", bot_id: "bot-1", assignment_generation: "generation-1",
    provider: "claude", provider_session_id: "fixture-claude-launch",
    event_time: "2026-09-24T10:00:00.000Z", event_order: "0000000001000000:fixture:000000000001",
    adapter_instance_id: "fixture", actor_id: "owner-id", source_message_id: "owner-message-1", activity_kind: "message",
  };
  const result = await runScript(workspace, "scripts/conversation-reminder-events.py", {
    args: ["ingest", "--project-root", workspace.repoDir, "--state-dir", path.join(workspace.homeDir, ".local", "state", "ccdm", "conversation-reminders")],
    input: JSON.stringify(event),
  });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, "rejected");
});

test("Claude launcher, filtered channel, command hooks and readiness share one launch identity", async () => {
  const workspace = createWorkspace();
  const registry = seedClaudeAssignment(workspace);
  seedRegistry(workspace, registry);
  const pluginDir = path.join(workspace.homeDir, ".claude", "plugins", "cache", "claude-plugins-official", "discord", "0.0.4");
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(path.join(pluginDir, "server.ts"), "// fixture official plugin\n");
  const launched = await runScript(workspace, "scripts/start-session.sh", {
    args: ["demo"], env: { CCDM_CLAUDE_REMINDER_ADAPTER: "1" },
  });
  assert.equal(launched.exitCode, 0, launched.stderr || launched.stdout);
  const config = JSON.parse(fs.readFileSync(path.join(registry.pool[0].state_dir, "ccdm-message-export-mcp.json"), "utf8"));
  const launchEnv = config.mcpServers.discord.env;
  assert.equal((await runHook(workspace, "SessionStart", {}, launchEnv)).exitCode, 0);
  await runChannel(workspace, {
    content: "answer this",
    meta: { chat_id: "channel-1", message_id: "owner-message-1", user_id: "owner-id" },
  }, { reply: true, disposition: "progress", launchEnv, noHooksConfig: true });
  const stopped = await runHook(workspace, "Stop", { background_tasks: [], session_crons: [] }, launchEnv);
  assert.equal(stopped.exitCode, 0, stopped.stderr);
  const readiness = await runScript(workspace, "scripts/conversation-reminder-readiness.py", { args: ["demo", "--json"] });
  assert.equal(readiness.exitCode, 0, readiness.stderr);
  assert.deepEqual(JSON.parse(readiness.stdout).events.map(event => event.event_type), ["owner_activity", "response_delivered", "turn_completed"]);
});
