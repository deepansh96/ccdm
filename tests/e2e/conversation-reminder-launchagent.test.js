import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { spawn, spawnSync } from "node:child_process";

import { runScript } from "./support/runner.js";
import { routerEnv, runRouterCli, startBridge, startRouter, waitFor, writeProjectKey } from "./support/router.js";
import {
  bridgeChildEnv, createBridgeWorkspace, injectDiscordMessage, startFakeCodexServer, waitForState,
} from "./support/bridge.js";
import { readState, writeState } from "./support/state.js";
import { cleanup, registerTeardownCallback } from "./support/teardown.js";

test.afterEach(async () => cleanup());

// The opt-in supervisor installs the same foreground worker as a macOS
// LaunchAgent. Scenarios drive the real installer through the `launchctl`
// Fixture Binary and launch the rendered ProgramArguments themselves; the
// real user's LaunchAgents directory is never touched.

const LABEL = "com.discord.conversation-reminders";
const INSTALLER = "scripts/install-conversation-reminder-service.sh";

// Every project is served through the Router, so the installer's preflight
// needs it up and the project's webhook made: `ensure-webhook` gives demo
// `fake-webhook-1`. The Router logs in as root from root's default Discord
// state; the worker reads root's token from ROOT_DISCORD_STATE_DIR.
async function setup(workspace) {
  fs.writeFileSync(path.join(workspace.repoDir, "registry.json"), JSON.stringify({
    discord_user_id: "owner", guild_id: "guild",
    projects: { demo: { type: "codex", channel_id: "channel", assignment_generation: "gen-demo" } },
  }), { mode: 0o600 });
  const rootState = path.join(workspace.homeDir, "root-discord");
  fs.mkdirSync(rootState, { recursive: true });
  fs.writeFileSync(path.join(rootState, ".env"), "DISCORD_BOT_TOKEN=fixture-root-token\n", { mode: 0o600 });
  const routerRootState = path.join(workspace.homeDir, ".claude", "channels", "discord");
  fs.mkdirSync(routerRootState, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(routerRootState, ".env"), "DISCORD_BOT_TOKEN=fixture-root-token\n", { mode: 0o600 });
  const ensured = await runRouterCli(workspace, ["ensure-webhook", "demo"]);
  assert.equal(ensured.exitCode, 0, ensured.stderr || ensured.stdout);
  await startRouter(workspace);
  return {
    rootState,
    stateDir: path.join(workspace.homeDir, ".local", "state", "ccdm", "conversation-reminders"),
    env: { ROOT_DISCORD_STATE_DIR: rootState, CCDM_REMINDER_NODE: process.execPath,
      CCDM_ROUTER_STATE_DIR: workspace.routerStateDir },
    // The rendered LaunchAgent environment names no Router state directory.
    extraEnv: { CCDM_ROUTER_STATE_DIR: workspace.routerStateDir },
  };
}

// Each worker start writes a fresh observer key before connecting to the
// Router, so a changed key marks one more observer start.
const observerKey = workspace => {
  const file = path.join(workspace.routerStateDir, "keys", ".observer.key");
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
};

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
  const workspace = createBridgeWorkspace();
  const context = await setup(workspace);

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
  const workspace = createBridgeWorkspace();
  const context = await setup(workspace);
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
  const workspace = createBridgeWorkspace();
  const context = await setup(workspace);
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
    const workspace = createBridgeWorkspace();
    const context = await setup(workspace);
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
  const workspace = createBridgeWorkspace();
  const context = await setup(workspace);
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
  const workspace = createBridgeWorkspace();
  const context = await setup(workspace);
  const installed = await install(workspace, context);
  assert.equal(installed.exitCode, 0, installed.stderr || installed.stdout);
  await service(workspace, context, "enable");
  // Only the Router logs in to the Gateway; the worker observes through it.
  const routerLogins = readState(workspace.stateDir).fixtures.discord.logins.length;

  const supervised = launchAsSupervisor(workspace, context);
  await waitFor(() => observerKey(workspace) !== null, () => "the supervised worker's observer start", 10000);
  const supervisedKey = observerKey(workspace);
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
  assert.equal(observerKey(workspace), supervisedKey);
  assert.equal(state.fixtures.discord.logins.length, routerLogins);
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
  await waitFor(() => observerKey(workspace) !== supervisedKey, () => "the foreground worker's observer start", 10000);
  const refused = await launchAsSupervisor(workspace, context);
  assert.equal(refused.exitCode, 2, "a nonzero exit lets launchd retry after ThrottleInterval");
  assert.match(JSON.parse(refused.stdout).reason, /already running/);
  await service(workspace, context, "disable");
  assert.equal((await manual).exitCode, 0);
  assert.equal(readState(workspace.stateDir).fixtures.discord.logins.length, routerLogins);

  assert.equal(fs.statSync(context.stateDir).mode & 0o777, 0o700);
  for (const name of ["conversations.sqlite3", "worker.lock", "service.log", "service.err"]) {
    assert.equal(fs.statSync(path.join(context.stateDir, name)).mode & 0o777, 0o600, name);
  }
});

test("the reminder supervisor leaves the Usage Stats Poster service, storage, and output unchanged", async () => {
  const workspace = createBridgeWorkspace();
  const context = await setup(workspace);
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

// Both providers in one registry, each with its own channel, both served
// through the Router: the Codex project gets webhook `fake-webhook-1` when its
// bridge starts, and the Claude project `fake-webhook-2` after it.
const CLAUDE_WEBHOOK = "fake-webhook-2";

function setupBothProviders(workspace) {
  fs.writeFileSync(path.join(workspace.repoDir, "registry.json"), JSON.stringify({
    discord_user_id: "owner-id", guild_id: "guild-id", root_bot_app_id: "root-app",
    projects: {
      "claude-demo": { type: "claude", transport: "router", path: workspace.repoDir, channel_id: "claude-channel",
        assignment_generation: "gen-claude", screen_name: "claude-demo_claude" },
      "codex-demo": { type: "codex", transport: "router", path: workspace.repoDir, channel_id: "codex-channel",
        assignment_generation: "gen-codex", screen_name: "codex-demo_codex" },
    },
  }), { mode: 0o600 });
  const rootState = path.join(workspace.homeDir, "root-discord");
  fs.mkdirSync(rootState, { recursive: true });
  fs.writeFileSync(path.join(rootState, ".env"), "DISCORD_BOT_TOKEN=fixture-root-token\n", { mode: 0o600 });
  // The Router logs in as the same root bot, from root's default Discord state.
  const routerRootState = path.join(workspace.homeDir, ".claude", "channels", "discord");
  fs.mkdirSync(routerRootState, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(routerRootState, ".env"), "DISCORD_BOT_TOKEN=fixture-root-token\n", { mode: 0o600 });
  const clockFile = path.join(workspace.tmpDir, "reminder-clock");
  return {
    rootState, clockFile,
    stateDir: path.join(workspace.homeDir, ".local", "state", "ccdm", "conversation-reminders"),
    env: { ROOT_DISCORD_STATE_DIR: rootState, CCDM_REMINDER_NODE: process.execPath },
    // The worker observes the Codex channel through the Router.
    extraEnv: { CCDM_REMINDER_CLOCK_FILE: clockFile, CCDM_ROUTER_STATE_DIR: workspace.routerStateDir },
    setClock: value => fs.writeFileSync(clockFile, value),
  };
}

// The Claude project's webhook and launch key, once the Router is up.
async function serveClaude(workspace) {
  const result = await runRouterCli(workspace, ["ensure-webhook", "claude-demo"]);
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  writeProjectKey(workspace, "claude-demo", "claude-demo-key");
  // The running Router picks up the new webhook on its debounced registry
  // reload; the installer's preflight reads it from `router status`.
  const deadline = Date.now() + 10000;
  for (;;) {
    const status = await runRouterCli(workspace, ["status", "--json"]);
    const row = status.exitCode === 0 && JSON.parse(status.stdout).projects.find((next) => next.project === "claude-demo");
    if (row?.webhook) return;
    if (Date.now() > deadline) throw new Error(`Router never reported claude-demo's webhook: ${status.stdout}${status.stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

// One Claude turn through the real CCDM channel server behind the Router: the
// owner's message reaches Claude, and Claude's reply asks for input and posts
// through the project webhook. The launch stays up until stopped, because
// readiness requires its live channel server.
async function claudeTurn(workspace, context, { messageId }) {
  const hookSettings = path.join(workspace.tmpDir, "claude-reminder-hooks.json");
  const hook = `node '${path.join(workspace.repoDir, "scripts", "claude-reminder-hook.js")}'`;
  fs.writeFileSync(hookSettings, JSON.stringify({
    enabledPlugins: { "discord@claude-plugins-official": false },
    hooks: Object.fromEntries(["SessionStart", "Stop", "StopFailure", "SessionEnd"]
      .map(event => [event, [{ hooks: [{ type: "command", command: hook }] }]])),
  }), { mode: 0o600 });
  const readyFile = path.join(workspace.tmpDir, `claude-ready-${messageId}.json`);
  const child = spawn(process.execPath, [path.join(workspace.repoDir, "scripts", "ccdm-channel-server.js")], {
    cwd: workspace.repoDir, stdio: ["pipe", "pipe", "pipe"],
    env: routerEnv(workspace, { CCDM_REMINDER_PROJECT_ROOT: workspace.repoDir, CCDM_REMINDER_STATE_DIR: context.stateDir,
      CCDM_ROUTER_KEY_FILE: path.join(workspace.routerStateDir, "keys", "claude-demo.key"),
      CCDM_CHANNEL_READY_FILE: readyFile,
      CCDM_CLAUDE_PROJECT: "claude-demo", CCDM_CLAUDE_CHANNEL_ID: "claude-channel",
      CCDM_CLAUDE_LAUNCH_ID: "fixture-claude-launch",
      CCDM_CLAUDE_HOOK_SETTINGS: hookSettings,
      CCDM_REMINDER_RECEIPTS_DIR: path.join(context.stateDir, "claude-receipts") }),
  });
  const exited = new Promise(resolve => child.once("exit", resolve));
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  const stop = async (signal = "SIGTERM") => {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
    await exited;
  };
  registerTeardownCallback(() => stop("SIGKILL"));
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
  await until('"id":3');
  await waitFor(() => fs.existsSync(readyFile), () => "the Claude channel server's Router hello");
  injectDiscordMessage(workspace, { id: messageId, channelId: "claude-channel", author: { id: "owner-id" },
    content: "please decide" });
  await until("notifications/claude/channel");
  send({ id: 2, method: "tools/call", params: { name: "reply", arguments: { chat_id: "claude-channel",
    text: "Which option?", conversation_interaction_id: messageId, conversation_disposition: "input-needed" } } });
  await until("sent (id: ");
  const answerId = /sent \(id: ([^)]+)\)/.exec(output)[1];
  await new Promise(resolve => setTimeout(resolve, 150));
  return { answerId, stop };
}

// The Codex bridge through the Router and a fake Codex app-server. Starting it
// starts the Router the reminder worker observes the Codex channel through,
// so it runs before the worker's first discovery.
async function startCodexBridge(workspace) {
  const codex = await startFakeCodexServer(workspace, {
    channelId: "codex-channel",
    turns: [{ turnId: "codex-turn", status: "completed", waitForRelease: true, mcpReply: true }],
  });
  const bridge = await startBridge(workspace, { project: "codex-demo", port: codex.port,
    allowedUserId: "owner-id", channelId: "codex-channel" });
  await bridge.waitForOutput(/Listening in #codex-demo/, 7000);
  return { codex, bridge };
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
  const closed = new Promise(resolve => child.on("close", resolve));
  const answered = new Promise(resolve => child.stdout.on("data", chunk => {
    stdout += chunk;
    if (stdout.includes("\n")) resolve();
  }));
  child.stderr.on("data", chunk => { stderr += chunk; });
  child.stdin.write(input);
  const timer = setTimeout(() => child.stdin.end(), timeoutMs);
  await Promise.race([answered, closed]);
  clearTimeout(timer);
  child.stdin.end();
  const exitCode = await closed;
  return { exitCode, stdout, stderr };
}

// One Codex turn through the real bridge, a fake Codex app-server, and the
// scoped Discord MCP reply tool; the bridge is stopped afterwards.
async function codexTurn(workspace, { codex, bridge }, messageId) {
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
  const reply = await runMcp(workspace, {
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

// A message is sent again until the worker, observing through the Router, has
// handled it.
async function injectUntilHandled(workspace, context, message, handled) {
  for (let attempt = 0; attempt < 12; attempt++) {
    injectDiscordMessage(workspace, message);
    for (let poll = 0; poll < 20; poll++) {
      if (handled(await service(workspace, context, "status"))) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  throw new Error(`${message.id} was never handled: ${JSON.stringify(await service(workspace, context, "status"))}`);
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
// A project's own webhook message.
const webhookMessage = (id, timestamp, webhookId) =>
  ({ ...historyMessage(id, timestamp, webhookId), author: { id: webhookId, bot: true }, webhook_id: webhookId });

test("Claude and Codex complete reply, reminder, and reply or close through the supervised worker", async () => {
  const workspace = createBridgeWorkspace();
  const context = setupBothProviders(workspace);
  const now = Date.now();
  const at = offset => new Date(now + offset).toISOString().replace(".000Z", "Z");
  const seed = readState(workspace.stateDir);
  seed.fixtures.discord.history = { "claude-channel": [], "codex-channel": [] };
  writeState(seed, workspace.stateDir);
  // The installer's preflight needs the Router up and the Codex webhook made.
  const codexBridge = await startCodexBridge(workspace);
  await serveClaude(workspace);
  const installed = await install(workspace, context, {
    env: { ...context.env, CCDM_ROUTER_STATE_DIR: workspace.routerStateDir }, timeoutMs: 30000 });
  assert.equal(installed.exitCode, 0, installed.stderr || installed.stdout);

  // First enablement: the Claude launch records its verified transport, then the
  // supervised worker discovers both (empty) channels before any delivery.
  const warmup = await claudeTurn(workspace, context, { messageId: "claude-warmup" });
  await service(workspace, context, "enable");
  context.setClock(at(-10 * 60000));
  let supervised = launchAsSupervisor(workspace, context);
  await waitForStatus(workspace, context, current => ["claude-demo", "codex-demo"].every(name =>
    current.conversations[name]?.reconciliation_status === "ready"));
  await service(workspace, context, "disable");
  assert.equal((await supervised).exitCode, 0);

  // Each provider answers its owner. The Claude session is relaunched for its
  // turn and keeps running; the Codex bridge is stopped after its turn.
  await warmup.stop();
  const claude = await claudeTurn(workspace, context, { messageId: "claude-question" });
  const codex = await codexTurn(workspace, codexBridge, "codex-question");
  const history = readState(workspace.stateDir);
  history.fixtures.discord.history["claude-channel"].unshift(
    webhookMessage(claude.answerId, at(0), CLAUDE_WEBHOOK), historyMessage("claude-question", at(-1000), "owner-id"),
    webhookMessage(warmup.answerId, at(-5 * 60000), CLAUDE_WEBHOOK),
    historyMessage("claude-warmup", at(-6 * 60000), "owner-id"));
  history.fixtures.discord.history["codex-channel"].unshift(
    // The Codex answer is the project's own webhook message.
    webhookMessage(codex.answerId, at(0), "fake-webhook-1"),
    historyMessage("codex-question", at(-1000), "owner-id"));
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
    ["claude-channel", "Bot fixture-root-token"], ["codex-channel", "Bot fixture-root-token"]]);

  // The owner replies to Claude and closes Codex; the root observer handles both
  // without starting either coding agent.
  await injectUntilHandled(workspace, context, { id: "claude-reply", channelId: "claude-channel",
    author: { id: "owner-id" }, content: "Option A" },
  current => current.conversations["claude-demo"].last_ack_message_id === "claude-reply");
  await injectUntilHandled(workspace, context, { id: "codex-close", channelId: "codex-channel",
    author: { id: "owner-id" }, content: "/close" },
  current => current.conversations["codex-demo"].state === "closed");
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
  assert.deepEqual([decodeURIComponent(check.emoji), check.authorization], ["✅", "Bot fixture-root-token"]);
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
  await claude.stop();
});
