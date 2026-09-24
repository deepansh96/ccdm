import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { spawn, spawnSync } from "node:child_process";

import { createWorkspace, runNodeEntrypoint, runScript } from "./support/runner.js";
import {
  bridgeChildEnv, createBridgeWorkspace, injectDiscordMessage, startBridge, startFakeCodexServer, waitForState,
} from "./support/bridge.js";
import { readState, writeState } from "./support/state.js";
import { cleanup } from "./support/teardown.js";

test.afterEach(async () => cleanup());

// The opt-in supervisor installs the same foreground worker as a macOS
// LaunchAgent. Scenarios drive the real installer through the `launchctl`
// Fixture Binary and launch the rendered ProgramArguments themselves; the
// real user's LaunchAgents directory is never touched.

const LABEL = "com.discord.conversation-reminders";
const INSTALLER = "scripts/install-conversation-reminder-service.sh";

function setup(workspace) {
  fs.writeFileSync(path.join(workspace.repoDir, "registry.json"), JSON.stringify({
    discord_user_id: "owner", guild_id: "guild",
    pool: [{ id: "bot", app_id: "app", token: "fixture-project-token" }],
    projects: { demo: { type: "codex", bot_id: "bot", channel_id: "channel", assignment_generation: "gen-demo" } },
  }), { mode: 0o600 });
  const rootState = path.join(workspace.homeDir, "root-discord");
  fs.mkdirSync(rootState, { recursive: true });
  fs.writeFileSync(path.join(rootState, ".env"), "DISCORD_BOT_TOKEN=fixture-root-token\n", { mode: 0o600 });
  return {
    rootState,
    stateDir: path.join(workspace.homeDir, ".local", "state", "ccdm", "conversation-reminders"),
    env: { ROOT_DISCORD_STATE_DIR: rootState, CCDM_REMINDER_NODE: process.execPath },
  };
}

const plistPath = workspace => path.join(workspace.homeDir, "Library", "LaunchAgents", `${LABEL}.plist`);
const install = (workspace, context, extra = {}) => runScript(workspace, INSTALLER, { env: context.env, ...extra });

async function service(workspace, context, name, expected = 0) {
  const result = await runScript(workspace, "scripts/conversation-reminder-service.py", {
    args: [name, "--project-root", workspace.repoDir, "--state-dir", context.stateDir],
    env: bridgeChildEnv(workspace, { ...context.env, ...context.extraEnv }),
  });
  assert.equal(result.exitCode, expected, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function renderedAgent(workspace) {
  const parsed = spawnSync("python3", ["-c",
    "import json,plistlib,sys; print(json.dumps(plistlib.load(open(sys.argv[1],'rb'))))", plistPath(workspace)],
  { encoding: "utf8" });
  assert.equal(parsed.status, 0, parsed.stderr);
  return JSON.parse(parsed.stdout);
}

// Launch exactly what launchd would: the rendered ProgramArguments with the
// rendered environment. PATH stays the harness fixture PATH so the Test
// Workspace cannot fall through to host tools; the rendered interpreter paths
// are what the worker actually uses.
function launchAsSupervisor(workspace, context) {
  const agent = renderedAgent(workspace);
  const [python, script, ...args] = agent.ProgramArguments;
  assert.equal(python, path.join(workspace.fixtureDir, "python3"));
  const { PATH: _renderedPath, ...rendered } = agent.EnvironmentVariables;
  return runScript(workspace, path.relative(fs.realpathSync(workspace.repoDir), script), {
    args, cwd: agent.WorkingDirectory, timeoutMs: 30000,
    env: bridgeChildEnv(workspace, { ...rendered, ...context.extraEnv }),
  });
}

const operations = workspace =>
  readState(workspace.stateDir).fixtures.launchctl.invocations.map(({ operation }) => operation);

test("installer renders a secret-free LaunchAgent that supervises the foreground worker", async () => {
  const workspace = createWorkspace();
  const context = setup(workspace);

  const result = await install(workspace, context);

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  const repo = fs.realpathSync(workspace.repoDir);
  const expected = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
<key>Label</key>
<string>com.discord.conversation-reminders</string>
<key>ProgramArguments</key>
<array>
<string>${path.join(workspace.fixtureDir, "python3")}</string>
<string>${path.join(repo, "scripts", "conversation-reminder-service.py")}</string>
<string>run</string>
<string>--project-root</string>
<string>${repo}</string>
<string>--state-dir</string>
<string>${context.stateDir}</string>
</array>
<key>WorkingDirectory</key>
<string>${repo}</string>
<key>RunAtLoad</key>
<true/>
<key>KeepAlive</key>
<dict>
<key>SuccessfulExit</key>
<false/>
</dict>
<key>ThrottleInterval</key>
<integer>30</integer>
<key>Umask</key>
<integer>63</integer>
<key>EnvironmentVariables</key>
<dict>
<key>CCDM_REMINDER_NODE</key>
<string>${process.execPath}</string>
<key>CCDM_REMINDER_PYTHON</key>
<string>${path.join(workspace.fixtureDir, "python3")}</string>
<key>PATH</key>
<string>${path.dirname(process.execPath)}:/usr/bin:/bin</string>
<key>ROOT_DISCORD_STATE_DIR</key>
<string>${context.rootState}</string>
</dict>
<key>StandardOutPath</key>
<string>${path.join(context.stateDir, "service.log")}</string>
<key>StandardErrorPath</key>
<string>${path.join(context.stateDir, "service.err")}</string>
</dict>
</plist>
`;
  assert.equal(fs.readFileSync(plistPath(workspace), "utf8"), expected);
  assert.deepEqual(operations(workspace), ["list", "unload", "load", "list"]);
  assert.match(result.stdout, /LaunchAgent 'com\.discord\.conversation-reminders' loaded/);
  for (const text of [expected, result.stdout, result.stderr]) {
    assert.doesNotMatch(text, /fixture-(root|project)-token|DISCORD_BOT_TOKEN/);
  }
  // Durable state and logs live in a private directory the installer prepares.
  assert.equal(fs.statSync(context.stateDir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(context.stateDir, "service.log")).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(context.stateDir, "service.err")).mode & 0o777, 0o600);
  // Installing supervises the worker; it neither opts in nor contacts Discord.
  const state = readState(workspace.stateDir);
  assert.deepEqual(state.fixtures.discord.sends, []);
  assert.equal(fs.existsSync(path.join(context.stateDir, "conversations.sqlite3")), false);
});

test("reinstalling the same LaunchAgent is idempotent", async () => {
  const workspace = createWorkspace();
  const context = setup(workspace);
  const first = await install(workspace, context);
  assert.equal(first.exitCode, 0, first.stderr || first.stdout);
  const firstPlist = fs.readFileSync(plistPath(workspace), "utf8");

  const second = await install(workspace, context);

  assert.equal(second.exitCode, 0, second.stderr || second.stdout);
  assert.equal(fs.readFileSync(plistPath(workspace), "utf8"), firstPlist);
  assert.deepEqual(operations(workspace), ["list", "unload", "load", "list", "list", "unload", "load", "list"]);
  assert.deepEqual(readState(workspace.stateDir).fixtures.launchctl.loaded, [LABEL]);
  assert.deepEqual(fs.readdirSync(path.dirname(plistPath(workspace))), [`${LABEL}.plist`]);
});

test("a failed replacement load restores the previous plist and loaded service", async () => {
  const workspace = createWorkspace();
  const context = setup(workspace);
  const first = await install(workspace, context);
  assert.equal(first.exitCode, 0, first.stderr || first.stdout);
  const prior = fs.readFileSync(plistPath(workspace), "utf8");
  // The replacement differs only by its node path, so a rollback is observable.
  const otherNode = path.join(workspace.tmpDir, "node-bin", "node");
  fs.mkdirSync(path.dirname(otherNode));
  fs.symlinkSync(process.execPath, otherNode);
  const state = readState(workspace.stateDir);
  state.fixtures.launchctl.loadFailuresRemaining = 1;
  writeState(state, workspace.stateDir);

  const result = await install(workspace, { ...context, env: { ...context.env, CCDM_REMINDER_NODE: otherNode } });

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /restored the previous LaunchAgent/);
  assert.equal(fs.readFileSync(plistPath(workspace), "utf8"), prior);
  assert.deepEqual(readState(workspace.stateDir).fixtures.launchctl.loaded, [LABEL]);
  assert.deepEqual(operations(workspace), ["list", "unload", "load", "list", "list", "unload", "load", "unload", "load"]);
  assert.deepEqual(fs.readdirSync(path.dirname(plistPath(workspace))), [`${LABEL}.plist`]);
});

test("missing prerequisites or provider capabilities refuse installation before launchctl", async () => {
  const cases = [
    { name: "outdated node", expected: /node 22 or newer is required/, prepare: (workspace, context) => {
      const oldNode = path.join(workspace.tmpDir, "old-node");
      fs.writeFileSync(oldNode, "#!/bin/sh\n# reports Node 18: the version probe fails\nexit 1\n", { mode: 0o755 });
      context.env.CCDM_REMINDER_NODE = oldNode;
    } },
    { name: "missing Claude adapter", expected: /claude missing scripts\/claude-reminder-hook\.js/, prepare: workspace =>
      fs.rmSync(path.join(workspace.repoDir, "scripts", "claude-reminder-hook.js")) },
    { name: "missing Codex adapter", expected: /codex missing scripts\/codex-bridge\.js/, prepare: workspace =>
      fs.rmSync(path.join(workspace.repoDir, "scripts", "codex-bridge.js")) },
    { name: "missing root credentials", expected: /root Discord credentials are unavailable/, prepare: (workspace, context) =>
      fs.rmSync(path.join(context.rootState, ".env")) },
  ];
  for (const scenario of cases) {
    const workspace = createWorkspace();
    const context = setup(workspace);
    scenario.prepare(workspace, context);

    const result = await install(workspace, context);

    assert.notEqual(result.exitCode, 0, scenario.name);
    assert.match(result.stderr, scenario.expected, scenario.name);
    assert.deepEqual(readState(workspace.stateDir).fixtures.launchctl.invocations, [], scenario.name);
    assert.equal(fs.existsSync(plistPath(workspace)), false, scenario.name);
    assert.equal(fs.existsSync(context.stateDir), false, scenario.name);
    assert.doesNotMatch(result.stdout + result.stderr, /fixture-(root|project)-token/, scenario.name);
  }
});

test("invalid configuration or an unusable store leaves the working installation and permissions intact", async () => {
  const workspace = createWorkspace();
  const context = setup(workspace);
  const first = await install(workspace, context);
  assert.equal(first.exitCode, 0, first.stderr || first.stdout);
  const registryPath = path.join(workspace.repoDir, "registry.json");
  const working = {
    plist: fs.readFileSync(plistPath(workspace), "utf8"),
    stateMode: fs.statSync(context.stateDir).mode,
    registryMode: fs.statSync(registryPath).mode,
  };
  const registry = fs.readFileSync(registryPath, "utf8");

  fs.writeFileSync(registryPath, JSON.stringify({ ...JSON.parse(registry), discord_user_id: "" }));
  const ownerless = await install(workspace, context);
  assert.equal(ownerless.exitCode, 2);
  assert.match(ownerless.stderr, /preflight failed; the existing LaunchAgent was left unchanged/);
  assert.match(ownerless.stderr, /registry\.json has no CCDM owner/);

  fs.writeFileSync(registryPath, registry);
  const store = path.join(context.stateDir, "conversations.sqlite3");
  fs.writeFileSync(store, "invalid database", { mode: 0o600 });
  const corrupt = await install(workspace, context);
  assert.equal(corrupt.exitCode, 2);
  assert.match(corrupt.stderr, /conversation store cannot be used/);
  assert.equal(fs.readFileSync(store, "utf8"), "invalid database");

  assert.equal(fs.readFileSync(plistPath(workspace), "utf8"), working.plist);
  assert.equal(fs.statSync(context.stateDir).mode, working.stateMode);
  assert.equal(fs.statSync(registryPath).mode, working.registryMode);
  assert.deepEqual(operations(workspace), ["list", "unload", "load", "list"]);
  assert.deepEqual(readState(workspace.stateDir).fixtures.launchctl.loaded, [LABEL]);
});

test("supervised and foreground launches share one worker, and disable keeps relaunches from sending", async () => {
  const workspace = createWorkspace();
  const context = setup(workspace);
  const installed = await install(workspace, context);
  assert.equal(installed.exitCode, 0, installed.stderr || installed.stdout);
  await service(workspace, context, "enable");

  const supervised = launchAsSupervisor(workspace, context);
  await waitForState(workspace, state => state.fixtures.discord.logins.length === 1, 10000);
  assert.equal((await service(workspace, context, "status")).worker_running, true);
  const foreground = await runScript(workspace, "scripts/conversation-reminder-service.py", {
    args: ["run", "--project-root", workspace.repoDir, "--state-dir", context.stateDir],
    env: bridgeChildEnv(workspace, context.env),
  });
  assert.equal(foreground.exitCode, 2);
  assert.match(JSON.parse(foreground.stdout).reason, /already running/);

  // Disable exits the supervised worker successfully, so KeepAlive does not relaunch it.
  await service(workspace, context, "disable");
  const stopped = await supervised;
  assert.equal(stopped.exitCode, 0, stopped.stderr || stopped.stdout);
  // A load at login (RunAtLoad) while disabled exits at once without observing or sending.
  const relaunched = await launchAsSupervisor(workspace, context);
  assert.equal(relaunched.exitCode, 0, relaunched.stderr || relaunched.stdout);
  assert.equal(JSON.parse(relaunched.stdout).disabled, true);
  const state = readState(workspace.stateDir);
  assert.equal(state.fixtures.discord.logins.length, 1);
  assert.deepEqual((state.fixtures.discord.messages ?? []).filter(row => row.content === "👀"), []);

  // Re-enabling names both ways to start the stopped worker.
  const reenabled = await service(workspace, context, "enable");
  assert.match(reenabled.readiness.projects.demo.blockers.join("\n"),
    /worker is not running; start `run` or rerun scripts\/install-conversation-reminder-service\.sh/);

  // A foreground worker holds the lock the supervised relaunch then waits on.
  const manual = runScript(workspace, "scripts/conversation-reminder-service.py", {
    args: ["run", "--project-root", workspace.repoDir, "--state-dir", context.stateDir],
    env: bridgeChildEnv(workspace, context.env), timeoutMs: 30000,
  });
  await waitForState(workspace, current => current.fixtures.discord.logins.length === 2, 10000);
  const refused = await launchAsSupervisor(workspace, context);
  assert.equal(refused.exitCode, 2, "a nonzero exit lets launchd retry after ThrottleInterval");
  assert.match(JSON.parse(refused.stdout).reason, /already running/);
  await service(workspace, context, "disable");
  assert.equal((await manual).exitCode, 0);

  assert.equal(fs.statSync(context.stateDir).mode & 0o777, 0o700);
  for (const name of ["conversations.sqlite3", "worker.lock", "service.log", "service.err"]) {
    assert.equal(fs.statSync(path.join(context.stateDir, name)).mode & 0o777, 0o600, name);
  }
});

test("the reminder supervisor leaves the Usage Stats Poster service, storage, and output unchanged", async () => {
  const workspace = createWorkspace();
  const context = setup(workspace);
  const usage = await runScript(workspace, "scripts/install-usage-stats-poster.sh");
  assert.equal(usage.exitCode, 0, usage.stderr || usage.stdout);
  const usagePlist = path.join(path.dirname(plistPath(workspace)), "com.discord.usage-stats-poster.plist");
  const usagePlistText = fs.readFileSync(usagePlist, "utf8");
  const history = path.join(workspace.homeDir, "Library", "Application Support", "CCDM", "usage-stats", "history.sqlite3");
  fs.mkdirSync(path.dirname(history), { recursive: true });
  fs.writeFileSync(history, "usage history bytes", { mode: 0o600 });

  const installed = await install(workspace, context);
  assert.equal(installed.exitCode, 0, installed.stderr || installed.stdout);
  await service(workspace, context, "enable");

  assert.equal(fs.readFileSync(usagePlist, "utf8"), usagePlistText);
  assert.equal(fs.readFileSync(history, "utf8"), "usage history bytes");
  assert.deepEqual(fs.readdirSync(path.dirname(history)), ["history.sqlite3"]);
  assert.deepEqual(readState(workspace.stateDir).fixtures.launchctl.loaded.sort(),
    ["com.discord.conversation-reminders", "com.discord.usage-stats-poster"]);
  const reminderTargets = readState(workspace.stateDir).fixtures.launchctl.invocations.slice(4)
    .map(({ target }) => target);
  assert.deepEqual(reminderTargets, [LABEL, plistPath(workspace), plistPath(workspace), LABEL]);
  assert.doesNotMatch(installed.stdout, /usage/i);
  assert.deepEqual(readState(workspace.stateDir).fixtures.discord.sends, []);
});

// Both providers in one registry, each with its own assigned bot and channel.
function setupBothProviders(workspace) {
  const claudeState = path.join(workspace.homeDir, ".claude", "channels", "discord-claude-demo");
  fs.writeFileSync(path.join(workspace.repoDir, "registry.json"), JSON.stringify({
    discord_user_id: "owner-id", guild_id: "guild-id", root_bot_app_id: "root-app",
    pool: [
      { id: "claude-bot", app_id: "claude-app", token: "fixture-claude-token", state_dir: claudeState },
      { id: "codex-bot", app_id: "codex-app", token: "fixture-codex-token" },
    ],
    projects: {
      "claude-demo": { type: "claude", path: workspace.repoDir, bot_id: "claude-bot", channel_id: "claude-channel",
        assignment_generation: "gen-claude", screen_name: "claude-demo_claude" },
      "codex-demo": { type: "codex", path: workspace.repoDir, bot_id: "codex-bot", channel_id: "codex-channel",
        assignment_generation: "gen-codex", screen_name: "codex-demo_codex" },
    },
  }), { mode: 0o600 });
  const rootState = path.join(workspace.homeDir, "root-discord");
  fs.mkdirSync(rootState, { recursive: true });
  fs.writeFileSync(path.join(rootState, ".env"), "DISCORD_BOT_TOKEN=fixture-root-token\n", { mode: 0o600 });
  const clockFile = path.join(workspace.tmpDir, "reminder-clock");
  return {
    rootState, clockFile,
    stateDir: path.join(workspace.homeDir, ".local", "state", "ccdm", "conversation-reminders"),
    env: { ROOT_DISCORD_STATE_DIR: rootState, CCDM_REMINDER_NODE: process.execPath },
    extraEnv: { CCDM_REMINDER_CLOCK_FILE: clockFile },
    setClock: value => fs.writeFileSync(clockFile, value),
  };
}

// One Claude turn through the launch-scoped reminder channel around a Local
// Fake of the official Discord plugin: the owner's message reaches Claude, and
// Claude's reply asks for input and is confirmed by the plugin.
async function claudeTurn(workspace, context, { messageId, answerId }) {
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
    if (request.method === "notifications/initialized") write({ jsonrpc: "2.0", method: "notifications/claude/channel",
      params: { content: "please decide", meta: { chat_id: "claude-channel", message_id: ${JSON.stringify(messageId)},
        user_id: "owner-id" } } });
    if (request.method === "tools/list") write({ jsonrpc: "2.0", id: request.id, result: { tools: [{ name: "reply",
      inputSchema: { type: "object", properties: { chat_id: { type: "string" }, text: { type: "string" } },
        required: ["chat_id", "text"] } }] } });
    if (request.method === "tools/call") write({ jsonrpc: "2.0", id: request.id,
      result: { content: [{ type: "text", text: ${JSON.stringify(`sent (id: ${answerId})`)} }] } });
  }
});
`);
  const hookSettings = path.join(workspace.tmpDir, "claude-reminder-hooks.json");
  const hook = `node '${path.join(workspace.repoDir, "scripts", "claude-reminder-hook.js")}'`;
  fs.writeFileSync(hookSettings, JSON.stringify({
    enabledPlugins: { "discord@claude-plugins-official": false },
    hooks: Object.fromEntries(["SessionStart", "Stop", "StopFailure", "SessionEnd"]
      .map(event => [event, [{ hooks: [{ type: "command", command: hook }] }]])),
  }), { mode: 0o600 });
  const child = spawn(process.execPath, [path.join(workspace.repoDir, "scripts", "claude-reminder-channel.js")], {
    cwd: workspace.repoDir, stdio: ["pipe", "pipe", "pipe"],
    env: { ...workspace.env, CCDM_REMINDER_PROJECT_ROOT: workspace.repoDir, CCDM_REMINDER_STATE_DIR: context.stateDir,
      CCDM_CLAUDE_PLUGIN_COMMAND: process.execPath, CCDM_CLAUDE_PLUGIN_ARGS: JSON.stringify([fake]),
      CCDM_CLAUDE_PROJECT: "claude-demo", CCDM_CLAUDE_CHANNEL_ID: "claude-channel", CCDM_CLAUDE_BOT_APP_ID: "claude-app",
      CCDM_CLAUDE_ROOT_APP_ID: "root-app", CCDM_CLAUDE_LAUNCH_ID: "fixture-claude-launch",
      CCDM_CLAUDE_HOOK_SETTINGS: hookSettings,
      CCDM_REMINDER_RECEIPTS_DIR: path.join(context.stateDir, "claude-receipts") },
  });
  const exited = new Promise(resolve => child.once("exit", resolve));
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  const until = async text => {
    for (let attempt = 0; attempt < 200 && !output.includes(text); attempt++) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.ok(output.includes(text), `Claude channel never produced ${text}: ${output}`);
  };
  const send = value => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n");
  send({ id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {},
    clientInfo: { name: "fixture", version: "1" } } });
  await until('"id":1');
  send({ method: "notifications/initialized" });
  send({ id: 3, method: "tools/list" });
  await until("notifications/claude/channel");
  send({ id: 2, method: "tools/call", params: { name: "reply", arguments: { chat_id: "claude-channel",
    text: "Which option?", conversation_interaction_id: messageId, conversation_disposition: "input-needed" } } });
  await until(answerId);
  await new Promise(resolve => setTimeout(resolve, 150));
  // The coding agent stops: the reminder service must not depend on it.
  child.kill();
  await exited;
}

// One Codex turn through the real bridge, a fake Codex app-server, and the
// scoped Discord MCP reply tool; the bridge is stopped afterwards.
async function codexTurn(workspace, messageId) {
  const codex = await startFakeCodexServer(workspace, {
    turns: [{ turnId: "codex-turn", status: "completed", waitForRelease: true, mcpReply: true }],
  });
  const bridge = startBridge(workspace, { port: codex.port, botAppId: "codex-app", botToken: "fixture-codex-token",
    allowedUserId: "owner-id", channelId: "codex-channel" });
  await bridge.waitForOutput(/Listening in #channel-codex-channel/, 7000);
  injectDiscordMessage(workspace, { id: messageId, channelId: "codex-channel", author: { id: "owner-id" },
    content: "answer this" });
  const config = await (async () => {
    for (let attempt = 0; attempt < 200; attempt++) {
      const found = codex.clientMessages.find(message => message.method === "config/value/write" &&
        message.params.keyPath === "mcp_servers.discord-codex-channel");
      if (found && fs.existsSync(found.params.value.env.CCDM_REMINDER_CONTEXT_FILE)) return found;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error(`Codex turn never started: ${bridge.stdout}\n${bridge.stderr}`);
  })();
  const reply = await runNodeEntrypoint(workspace, "scripts/discord-mcp-server.js", {
    env: bridgeChildEnv(workspace, config.params.value.env),
    input: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "reply",
      arguments: { text: "Here is the answer", scope_token: config.params.value.env.DISCORD_REPLY_TOKEN } } }) + "\n",
  });
  const answerId = /sent \(id: ([^)]+)\)/.exec(JSON.parse(reply.stdout).result.content[0].text)[1];
  codex.releaseTurn("codex-turn");
  for (let attempt = 0; attempt < 200; attempt++) {
    const readiness = await runScript(workspace, "scripts/conversation-reminder-readiness.py", {
      args: ["codex-demo", "--json"] });
    if (JSON.parse(readiness.stdout).events.some(event => event.event_type === "turn_completed")) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  await bridge.stop();
  return { answerId, appServerInvocations: readState(workspace.stateDir).fixtures.codex.appServerInvocations.length };
}

async function waitForStatus(workspace, context, predicate) {
  for (let attempt = 0; attempt < 300; attempt++) {
    const current = await service(workspace, context, "status");
    if (predicate(current)) return current;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for status: ${JSON.stringify(await service(workspace, context, "status"))}`);
}

const reminders = state => (state.fixtures.discord.messages ?? []).filter(row => row.content === "👀" && !row.deleted);
const historyMessage = (id, timestamp, author, content = "text") =>
  ({ id, timestamp, content, type: 0, attachments: [], author: { id: author, bot: author.endsWith("-app") } });

test("Claude and Codex complete reply, reminder, and reply or close through the supervised worker", async () => {
  const workspace = createBridgeWorkspace();
  const context = setupBothProviders(workspace);
  const now = Date.now();
  const at = offset => new Date(now + offset).toISOString().replace(".000Z", "Z");
  const seed = readState(workspace.stateDir);
  seed.fixtures.discord.history = { "claude-channel": [], "codex-channel": [] };
  writeState(seed, workspace.stateDir);
  const installed = await install(workspace, context);
  assert.equal(installed.exitCode, 0, installed.stderr || installed.stdout);

  // First enablement: the Claude launch records its verified transport, then the
  // supervised worker discovers both (empty) channels before any delivery.
  await claudeTurn(workspace, context, { messageId: "claude-warmup", answerId: "claude-warmup-answer" });
  await service(workspace, context, "enable");
  context.setClock(at(-10 * 60000));
  let supervised = launchAsSupervisor(workspace, context);
  await waitForStatus(workspace, context, current => ["claude-demo", "codex-demo"].every(name =>
    current.conversations[name]?.reconciliation_status === "ready"));
  await service(workspace, context, "disable");
  assert.equal((await supervised).exitCode, 0);

  // Each provider answers its owner; both coding agents are then stopped.
  await claudeTurn(workspace, context, { messageId: "claude-question", answerId: "claude-answer" });
  const codex = await codexTurn(workspace, "codex-question");
  const history = readState(workspace.stateDir);
  history.fixtures.discord.history["claude-channel"].unshift(
    historyMessage("claude-answer", at(0), "claude-app"), historyMessage("claude-question", at(-1000), "owner-id"),
    historyMessage("claude-warmup-answer", at(-5 * 60000), "claude-app"),
    historyMessage("claude-warmup", at(-6 * 60000), "owner-id"));
  history.fixtures.discord.history["codex-channel"].unshift(
    historyMessage(codex.answerId, at(0), "codex-app"), historyMessage("codex-question", at(-1000), "owner-id"));
  writeState(history, workspace.stateDir);

  // Re-enable reconciles before any send; at +30 minutes nothing is due yet.
  await service(workspace, context, "enable");
  context.setClock(at(30 * 60000));
  supervised = launchAsSupervisor(workspace, context);
  const awaiting = await waitForStatus(workspace, context, current => ["claude-demo", "codex-demo"].every(name =>
    current.conversations[name]?.reconciliation_status === "ready" &&
    current.conversations[name]?.state === "awaiting-owner"));
  assert.equal(awaiting.readiness.projects["claude-demo"].provider, "claude");
  assert.equal(awaiting.readiness.projects["codex-demo"].provider, "codex");
  assert.deepEqual(reminders(readState(workspace.stateDir)), []);

  // Both conversations become due one hour after their answers.
  context.setClock(at(61 * 60000));
  const sent = await waitForState(workspace, state => reminders(state).length === 2, 20000);
  assert.deepEqual(reminders(sent).map(row => [row.channelId, row.authorization]).sort(), [
    ["claude-channel", "Bot fixture-claude-token"], ["codex-channel", "Bot fixture-codex-token"]]);

  // The owner replies to Claude and closes Codex; the root observer handles both
  // without starting either coding agent.
  injectDiscordMessage(workspace, { id: "claude-reply", channelId: "claude-channel", author: { id: "owner-id" },
    content: "Option A" });
  injectDiscordMessage(workspace, { id: "codex-close", channelId: "codex-channel", author: { id: "owner-id" },
    content: "/close" });
  const settled = await waitForStatus(workspace, context, current =>
    current.conversations["claude-demo"].state === "open-paused" &&
    current.conversations["codex-demo"].state === "closed" &&
    current.conversations["claude-demo"].cleanup_message_ids.length === 0 &&
    current.conversations["codex-demo"].cleanup_message_ids.length === 0);
  assert.equal(settled.conversations["claude-demo"].last_ack_message_id, "claude-reply");
  const acknowledged = await waitForState(workspace, state => (state.fixtures.discord.deletes ?? []).length === 2 &&
    state.fixtures.discord.reactions.some(row => row.messageId === "codex-close"));
  assert.deepEqual(acknowledged.fixtures.discord.deletes.map(row => row.messageId).sort(),
    reminders(sent).map(row => row.id).sort());
  const check = acknowledged.fixtures.discord.reactions.find(row => row.messageId === "codex-close");
  assert.deepEqual([decodeURIComponent(check.emoji), check.authorization], ["✅", "Bot fixture-codex-token"]);
  assert.equal(acknowledged.fixtures.codex.appServerInvocations.length, codex.appServerInvocations);

  // A supervised restart preserves the closure and the paused conversation.
  await service(workspace, context, "disable");
  assert.equal((await supervised).exitCode, 0);
  const restartHistory = readState(workspace.stateDir);
  restartHistory.fixtures.discord.history["claude-channel"].unshift(
    historyMessage("claude-reply", at(62 * 60000), "owner-id", "Option A"));
  restartHistory.fixtures.discord.history["codex-channel"].unshift(
    historyMessage("codex-close", at(62 * 60000), "owner-id", "/close"));
  writeState(restartHistory, workspace.stateDir);
  await service(workspace, context, "enable");
  context.setClock(at(5 * 3600000));
  supervised = launchAsSupervisor(workspace, context);
  const restarted = await waitForStatus(workspace, context, current => ["claude-demo", "codex-demo"].every(name =>
    current.conversations[name]?.reconciliation_status === "ready"));
  assert.deepEqual([restarted.conversations["claude-demo"].state, restarted.conversations["codex-demo"].state],
    ["open-paused", "closed"]);
  await new Promise(resolve => setTimeout(resolve, 700));
  assert.equal(reminders(readState(workspace.stateDir)).length, 0);
  assert.equal((readState(workspace.stateDir).fixtures.discord.messages ?? [])
    .filter(row => row.content === "👀").length, 2, "no reminder is sent after reply or close");
  await service(workspace, context, "disable");
  assert.equal((await supervised).exitCode, 0);
});
