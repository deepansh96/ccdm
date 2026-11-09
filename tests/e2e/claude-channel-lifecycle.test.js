import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";

import { platformGate, sendCtrlBreak, spawnWithCtrlBreak } from "./support/platform.js";
import { runNodeEntrypoint } from "./support/runner.js";
import { OWNER_ID, createRouterWorkspace, routerEnv, routerWithWebhooks, waitFor } from "./support/router.js";
import { cleanup, registerTeardownCallback } from "./support/teardown.js";

test.afterEach(async () => { await cleanup(); });

// How the real channel server starts, stops and proves its capability, against
// the real Router and the fake Discord: its hook check, capability marker, stop
// paths and key-file flag. No reminder readiness or launcher is involved.
const require = createRequire(import.meta.url);
const { hookCommand } = require("../../scripts/platform/hooks.js");
const { ensurePrivateDirSync } = require("../../scripts/platform/privacy.js");

async function claudeWorkspace() {
  const workspace = createRouterWorkspace({
    discord_user_id: OWNER_ID,
    guild_id: "guild-id",
    root_bot_app_id: "root-app",
    projects: { demo: {
      type: "claude", transport: "router", channel_id: "channel-1", assignment_generation: "generation-1",
      screen_name: "demo_claude", session_id: null, pid: null,
    } },
  });
  await routerWithWebhooks(workspace, ["demo"]);
  const registryPath = path.join(workspace.repoDir, "registry.json");
  const registry = JSON.parse(fs.readFileSync(registryPath, "utf8"));
  registry.projects.demo.path = workspace.repoDir;
  fs.writeFileSync(registryPath, JSON.stringify(registry));
  return workspace;
}

const serverScript = workspace => path.join(workspace.repoDir, "scripts", "ccdm-channel-server.js");
const keyFileOf = workspace => path.join(workspace.routerStateDir, "keys", "demo.key");
const stateDirOf = workspace => path.join(workspace.homeDir, ".local", "state", "ccdm", "conversation-reminders");
const markerOf = workspace => path.join(stateDirOf(workspace), "capabilities", "demo.json");
const readMarker = workspace => JSON.parse(fs.readFileSync(markerOf(workspace), "utf8"));
const reminderHook = workspace => hookCommand(path.join(workspace.repoDir, "scripts", "claude-reminder-hook.js"));

// The channel server's environment, with its hook settings in a private
// directory, as the check requires.
function launchEnv(workspace, command = reminderHook(workspace)) {
  const hookDir = path.join(workspace.tmpDir, "claude-hook-settings");
  ensurePrivateDirSync(hookDir);
  const hookSettings = path.join(hookDir, "settings.json");
  fs.writeFileSync(hookSettings, JSON.stringify({
    enabledPlugins: { "discord@claude-plugins-official": false },
    hooks: Object.fromEntries(["SessionStart", "Stop", "StopFailure", "SessionEnd"]
      .map(event => [event, [{ hooks: [{ type: "command", command }] }]])),
  }), { mode: 0o600 });
  return routerEnv(workspace, {
    CCDM_ROUTER_KEY_FILE: keyFileOf(workspace),
    CCDM_CLAUDE_PROJECT: "demo",
    CCDM_CLAUDE_CHANNEL_ID: "channel-1",
    CCDM_CLAUDE_LAUNCH_ID: "fixture-claude-launch",
    CCDM_CLAUDE_HOOK_SETTINGS: hookSettings,
    CCDM_REMINDER_PROJECT_ROOT: workspace.repoDir,
    CCDM_REMINDER_STATE_DIR: stateDirOf(workspace),
  });
}

// The server under a parent that holds its stdin, connected once its marker exists.
async function startServer(workspace, { command, args = [] } = {}) {
  const child = spawn(process.execPath, [serverScript(workspace), ...args], {
    cwd: workspace.repoDir, env: launchEnv(workspace, command), stdio: ["pipe", "ignore", "pipe"], windowsHide: true,
  });
  const exited = new Promise(resolve => child.once("exit", resolve));
  let errors = "";
  child.stderr.on("data", chunk => { errors += chunk; });
  registerTeardownCallback(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
  });
  await waitFor(() => fs.existsSync(markerOf(workspace)), () => `the capability marker; stderr:\n${errors}`, 15000);
  return {
    pid: child.pid,
    endStdin: async () => {
      child.stdin.end();
      return exited;
    },
  };
}

test("the capability marker records the writer's pid and start time and leaves no temporary file", async () => {
  const workspace = await claudeWorkspace();
  const server = await startServer(workspace);
  const marker = readMarker(workspace);
  assert.equal(marker.pid, server.pid);
  if (process.platform === "win32") assert.match(marker.started_at, /^\d+$/);
  else assert.equal(marker.started_at, null);
  assert.deepEqual(fs.readdirSync(path.dirname(markerOf(workspace))), ["demo.json"]);
  await server.endStdin();
});

test("stdin closing ends the channel server with exit 0 and removes its marker", async () => {
  const workspace = await claudeWorkspace();
  const server = await startServer(workspace);
  assert.equal(await server.endStdin(), 0);
  assert.equal(fs.existsSync(markerOf(workspace)), false);
});

test("a marker with this server's pid but another start time survives its cleanup", async () => {
  const workspace = await claudeWorkspace();
  const server = await startServer(workspace);
  const reused = { ...readMarker(workspace), started_at: "1" };
  fs.writeFileSync(markerOf(workspace), JSON.stringify(reused), { mode: 0o600 });
  assert.equal(await server.endStdin(), 0);
  assert.deepEqual(readMarker(workspace), reused);
});

test("Ctrl+Break ends the channel server with exit 0 and removes its marker", platformGate("win32", "Ctrl+Break exists only on Windows"), async () => {
  const workspace = await claudeWorkspace();
  // The Ctrl+Break launcher leaves its program no stdin, and this server ends on
  // stdin EOF, so a small parent holds a pipe open as Claude would.
  const holder = path.join(workspace.tmpDir, "hold-stdin.cjs");
  fs.writeFileSync(holder, `
const { spawn } = require("node:child_process");
const child = spawn(process.execPath, process.argv.slice(2), { stdio: ["pipe", "inherit", "inherit"] });
process.on("SIGBREAK", () => {});
child.on("exit", code => process.exit(code ?? 1));
`);
  const child = spawnWithCtrlBreak(process.execPath, [holder, serverScript(workspace)], {
    cwd: workspace.repoDir, env: launchEnv(workspace),
  });
  let errors = "";
  child.stdout.resume();
  child.stderr.on("data", chunk => { errors += chunk; });
  const exited = new Promise(resolve => child.once("exit", resolve));
  registerTeardownCallback(async () => {
    if (child.exitCode === null) child.kill();
    await exited;
  });
  await waitFor(() => fs.existsSync(markerOf(workspace)), () => `the capability marker; stderr:\n${errors}`, 15000);
  sendCtrlBreak(child);
  assert.equal(await exited, 0, errors);
  assert.equal(fs.existsSync(markerOf(workspace)), false);
});

test("the hook check accepts the command from the shared builder", async () => {
  const workspace = await claudeWorkspace();
  const server = await startServer(workspace);
  assert.equal(readMarker(workspace).hooks_configured, true);
  await server.endStdin();
});

test("the hook check rejects a backslash command on Windows", platformGate("win32", "backslash paths are a Windows form"), async () => {
  const workspace = await claudeWorkspace();
  const server = await startServer(workspace, {
    command: `node '${path.join(workspace.repoDir, "scripts", "claude-reminder-hook.js")}'`,
  });
  assert.equal(readMarker(workspace).hooks_configured, false);
  await server.endStdin();
});

for (const [name, change] of [
  ["double quotes", command => command.replaceAll("'", '"')],
  ["an extra argument", command => `${command} --extra`],
]) {
  test(`the hook check rejects a command with ${name}`, async () => {
    const workspace = await claudeWorkspace();
    const server = await startServer(workspace, { command: change(reminderHook(workspace)) });
    assert.equal(readMarker(workspace).hooks_configured, false);
    await server.endStdin();
  });
}

test("--ccdm-key-file naming the launch key file behaves like no flag", async () => {
  const workspace = await claudeWorkspace();
  const server = await startServer(workspace, { args: ["--ccdm-key-file", keyFileOf(workspace)] });
  assert.equal(readMarker(workspace).transport, "ccdm-channel-server");
  assert.equal(await server.endStdin(), 0);
});

test("--ccdm-key-file naming another file exits non-zero and names both", async () => {
  const workspace = await claudeWorkspace();
  const readyFile = path.join(workspace.tmpDir, "ready.json");
  const other = path.join(workspace.routerStateDir, "keys", "other.key");
  const result = await runNodeEntrypoint(workspace, "scripts/ccdm-channel-server.js", {
    args: ["--ccdm-key-file", other],
    env: routerEnv(workspace, {
      CCDM_CLAUDE_PROJECT: "demo", CCDM_CHANNEL_READY_FILE: readyFile, CCDM_ROUTER_KEY_FILE: keyFileOf(workspace),
    }),
  });
  assert.notEqual(result.exitCode, 0);
  assert.ok(result.stderr.includes(other), result.stderr);
  assert.ok(result.stderr.includes(keyFileOf(workspace)), result.stderr);
  assert.equal(JSON.parse(fs.readFileSync(readyFile, "utf8")).ok, false);
});
