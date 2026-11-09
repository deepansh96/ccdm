import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { startFakeCodexServer, waitForState } from "./support/bridge.js";
import { PYTHON, platformGate } from "./support/platform.js";
import { createRouterWorkspace, routerEnv, runRouterCli, startRouter } from "./support/router.js";
import { createWorkspace, runScript } from "./support/runner.js";
import { hostOps, sessionCalls, startFakeHost } from "./support/session-fixture.js";
import { readState, seedFixtureProcess, seedRegistry, seedTmuxSession, updateState, writeState } from "./support/state.js";
import { cleanup, registerTeardownCallback } from "./support/teardown.js";

// Why a case runs only on Linux and macOS.
const POSIX_STOP = "reads listeners from the fixture ps and sends POSIX signals; Windows has its own cases here";
const TMUX_ROOT = "drives tmux's kill retry and the fixture pkill; the fake-host root cases here run on Windows";
const TMUX_INHERITS = "a tmux session inherits its creator's environment; ccdm-host passes a session only what it is given";
// Owner decision D2: the Windows root is Claude-only, so `restart-root --provider codex` is refused there.
const CODEX_ROOT = "root Codex stays POSIX until D2";
const NO_ACTIVE_SESSION = process.platform === "win32" ? "No active session" : "No active tmux session";

test.afterEach(async () => {
  await cleanup();
});

function runFixture(workspace, tool, args) {
  return spawnSync(path.join(workspace.fixtureDir, tool), args, {
    cwd: workspace.repoDir,
    encoding: "utf8",
    env: workspace.env,
  });
}

function buildRegistry(workspace, overrides = {}) {
  const sessionType = overrides.sessionType ?? "claude";
  // Neither Claude nor Codex has a pool mode: no project names a pool bot.
  const project = {
    path: path.join(workspace.tmpDir, "alpha project"),
    screen_name: sessionType === "codex" ? "alpha_codex" : "alpha_session",
    channel_id: "channel-id",
    type: sessionType,
    session_id: "existing-session",
    pid: overrides.pid ?? null,
    ...(sessionType === "codex" ? { ws_port: 18342 } : {}),
    ...(overrides.project ?? {}),
  };
  return {
    discord_user_id: "allowed-user-id",
    guild_id: "guild-id",
    category_ids: [],
    ...(overrides.codexHome ? { codex_home: overrides.codexHome } : {}),
    projects: {
      alpha: project,
    },
  };
}

function readRegistry(workspace) {
  return JSON.parse(fs.readFileSync(path.join(workspace.repoDir, "registry.json"), "utf8"));
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function spawnOwnedProcess(workspace, command, options = {}) {
  const script = options.ignoreTerm
    ? "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"
    : "setInterval(() => {}, 1000)";
  // The workspace marker lets the fixture pkill and teardown signal it.
  const child = spawn(process.execPath, ["-e", script, workspace.tmpRoot], {
    detached: true,
    env: {
      CCDM_TEST_STATE: workspace.stateDir,
    },
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  registerTeardownCallback(() => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // The process group may already be gone.
    }
    try {
      process.kill(child.pid, "SIGKILL");
    } catch {
      // The process may already be gone.
    }
  });
  seedFixtureProcess(
    {
      command,
      owned: true,
      ownerStateDir: workspace.stateDir,
      pid: child.pid,
      ppid: options.ppid ?? process.pid,
    },
    { stateDir: workspace.stateDir },
  );
  return child.pid;
}

// The default Router state under the Test Workspace home holds alpha's launch key.
function alphaKeyFile(workspace) {
  return path.join(workspace.homeDir, ".local", "state", "ccdm", "router", "keys", "alpha.key");
}

function claudeCommand(workspace) {
  return `claude --dangerously-load-development-channels server:ccdm --dangerously-skip-permissions CCDM_ROUTER_KEY_FILE='${alphaKeyFile(workspace)}'`;
}

function codexBridgeCommand() {
  return "node scripts/codex-bridge.js CCDM_CODEX_PROJECT='alpha' CHANNEL_ID='channel-id' WS_PORT='18342'";
}

function codexAppServerCommand() {
  return "codex app-server --listen ws://127.0.0.1:18342";
}

// Root Codex reads its root channels from the registry.
function seedRootCodexFiles(workspace, rootChannels = ["root-channel-id"]) {
  const registryFile = path.join(workspace.repoDir, "registry.json");
  const registry = JSON.parse(fs.readFileSync(registryFile, "utf8"));
  registry.root_channels = rootChannels;
  fs.writeFileSync(registryFile, `${JSON.stringify(registry, null, 2)}\n`);
}

// Root Codex is a Router client: a Router, and the fake app-server its bridge
// bootstraps against.
async function rootCodexRouterEnv(workspace, extraEnv = {}) {
  const codex = await startFakeCodexServer(workspace);
  await startRouter(workspace);
  return routerEnv(workspace, { ROOT_CODEX_WS_PORT: String(codex.port), ...extraEnv });
}

async function stopProject(workspace) {
  return runScript(workspace, "scripts/stop-session.sh", { args: ["alpha"], timeoutMs: 30000 });
}

test("sleep fixture resolves fixture-mode delays quickly", platformGate("posix", POSIX_STOP), () => {
  const workspace = createWorkspace();
  const started = performance.now();

  const result = runFixture(workspace, "sleep", ["8"]);

  assert.equal(result.status, 0, result.stderr);
  assert.ok(performance.now() - started < 100);
});

test("stop-session stops a Claude session and clears registry metadata", platformGate("posix", POSIX_STOP), async () => {
  const workspace = createWorkspace();
  const registry = buildRegistry(workspace);
  const pid = spawnOwnedProcess(workspace, claudeCommand(workspace));
  registry.projects.alpha.pid = pid;
  seedRegistry(workspace, registry);
  seedTmuxSession("alpha_session", { pid, paneOutput: "Listening\n" }, { stateDir: workspace.stateDir });

  const result = await stopProject(workspace);

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.match(result.stdout, new RegExp(`Stopping recorded process tree for 'alpha' \\(pid ${pid}\\)`));
  assert.match(result.stdout, /Stopped tmux session 'alpha_session'/);
  assert.match(result.stdout, /Stopped Discord session 'alpha'/);
  assert.equal(isAlive(pid), false);
  assert.equal(readState(workspace.stateDir).fixtures.tmux.sessions.alpha_session, undefined);
  assert.equal(readRegistry(workspace).projects.alpha.pid, null);
  assert.equal(readRegistry(workspace).projects.alpha.session_id, null);
});

test("stop-session stops a Codex bridge session from seeded registry and process state", platformGate("posix", POSIX_STOP), async () => {
  const workspace = createWorkspace();
  const registry = buildRegistry(workspace, { sessionType: "codex" });
  const pid = spawnOwnedProcess(workspace, codexBridgeCommand());
  registry.projects.alpha.pid = pid;
  seedRegistry(workspace, registry);
  seedTmuxSession("alpha_codex", { pid, paneOutput: "Codex bridge\n" }, { stateDir: workspace.stateDir });

  const result = await stopProject(workspace);

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.match(result.stdout, new RegExp(`Stopping recorded process tree for 'alpha' \\(pid ${pid}\\)`));
  assert.match(result.stdout, /Stopped tmux session 'alpha_codex'/);
  assert.equal(isAlive(pid), false);
  assert.equal(readRegistry(workspace).projects.alpha.pid, null);
  assert.equal(readRegistry(workspace).projects.alpha.session_id, null);
});

test("stop-session skips an unowned recorded PID and still cleans the registry", async () => {
  const workspace = createWorkspace();
  const registry = buildRegistry(workspace, { pid: process.pid });
  seedRegistry(workspace, registry);
  seedTmuxSession("alpha_session", { pid: process.pid }, { stateDir: workspace.stateDir });

  const result = await stopProject(workspace);

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.match(result.stdout, new RegExp(`Skipping recorded pid ${process.pid}`));
  assert.equal(isAlive(process.pid), true);
  assert.equal(readRegistry(workspace).projects.alpha.pid, null);
  assert.equal(readRegistry(workspace).projects.alpha.session_id, null);
});

test("stop-session handles already-stopped projects", async () => {
  const workspace = createWorkspace();
  seedRegistry(workspace, buildRegistry(workspace));

  const result = await stopProject(workspace);

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.match(result.stdout, new RegExp(`${NO_ACTIVE_SESSION} 'alpha_session' found`));
  assert.match(result.stdout, /Stopped Discord session 'alpha'/);
  assert.equal(readRegistry(workspace).projects.alpha.pid, null);
});

test("stop-session sweeps orphan Claude and Codex listener processes", platformGate("posix", POSIX_STOP), async () => {
  const claudeWorkspace = createWorkspace();
  const claudeRegistry = buildRegistry(claudeWorkspace);
  const claudePid = spawnOwnedProcess(claudeWorkspace, claudeCommand(claudeWorkspace));
  seedRegistry(claudeWorkspace, claudeRegistry);

  const claudeResult = await stopProject(claudeWorkspace);

  assert.equal(claudeResult.exitCode, 0, claudeResult.stderr || claudeResult.stdout);
  assert.match(claudeResult.stdout, /Cleaning remaining listener process\(es\):/);
  assert.match(claudeResult.stdout, new RegExp(String(claudePid)));
  assert.equal(isAlive(claudePid), false);
  await cleanup();

  const codexWorkspace = createWorkspace();
  const codexRegistry = buildRegistry(codexWorkspace, { sessionType: "codex" });
  const bridgePid = spawnOwnedProcess(codexWorkspace, codexBridgeCommand());
  const appServerPid = spawnOwnedProcess(codexWorkspace, codexAppServerCommand());
  seedRegistry(codexWorkspace, codexRegistry);

  const codexResult = await stopProject(codexWorkspace);

  assert.equal(codexResult.exitCode, 0, codexResult.stderr || codexResult.stdout);
  assert.match(codexResult.stdout, /Cleaning remaining listener process\(es\):/);
  assert.match(codexResult.stdout, new RegExp(String(bridgePid)));
  assert.match(codexResult.stdout, new RegExp(String(appServerPid)));
  assert.equal(isAlive(bridgePid), false);
  assert.equal(isAlive(appServerPid), false);
});

test("during cutover, stop-session also sweeps a legacy pool Claude listener for the project's former pool bot", platformGate("posix", POSIX_STOP), async () => {
  const workspace = createWorkspace();
  const stateDir = (n) => path.join(workspace.homeDir, ".claude", "channels", `discord${n}`);
  // alpha still names its former pool bot; bot3 serves another project.
  const registry = buildRegistry(workspace, { project: { bot_id: "bot2" } });
  registry.pool = [
    { id: "bot2", app_id: "app-2", state_dir: stateDir(2), assigned_to: "alpha" },
    { id: "bot3", app_id: "app-3", state_dir: stateDir(3), assigned_to: "other" },
  ];
  seedRegistry(workspace, registry);
  const legacy = (n) => `claude --channels plugin:discord@claude-plugins-official --dangerously-skip-permissions DISCORD_STATE_DIR='${stateDir(n)}'`;
  const orphanPid = spawnOwnedProcess(workspace, legacy(2));
  const otherPid = spawnOwnedProcess(workspace, legacy(3));
  const pluginPid = spawnOwnedProcess(workspace,
    `bun run --cwd ${workspace.homeDir}/.claude/plugins/cache/claude-plugins-official/discord/0.0.1 start DISCORD_STATE_DIR=${stateDir(2)}`);

  const result = await stopProject(workspace);

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Cleaning remaining listener process\(es\):/);
  assert.equal(isAlive(orphanPid), false);
  assert.equal(isAlive(pluginPid), false);
  assert.equal(isAlive(otherPid), true);
  assert.equal(readRegistry(workspace).projects.alpha.pid, null);
});

test("stop-session sweeps an orphaned CCDM channel server and removes the launch key", platformGate("posix", POSIX_STOP), async () => {
  const workspace = createWorkspace();
  const registry = buildRegistry(workspace);
  seedRegistry(workspace, registry);
  const keyFile = alphaKeyFile(workspace);
  fs.mkdirSync(path.dirname(keyFile), { recursive: true });
  fs.writeFileSync(keyFile, "old-key\n", { mode: 0o600 });
  const server = path.join(workspace.repoDir, "scripts", "ccdm-channel-server.js");
  const orphanPid = spawnOwnedProcess(workspace, `node '${server}' CCDM_ROUTER_KEY_FILE='${keyFile}'`);

  const result = await stopProject(workspace);

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.match(result.stdout, new RegExp(String(orphanPid)));
  assert.equal(isAlive(orphanPid), false);
  assert.equal(fs.existsSync(keyFile), false);
});

test("stop-session escalates SIGTERM-resistant child processes to SIGKILL", platformGate("posix", POSIX_STOP), async () => {
  const workspace = createWorkspace();
  const registry = buildRegistry(workspace);
  const parentPid = spawnOwnedProcess(workspace, claudeCommand(workspace));
  const childPid = spawnOwnedProcess(workspace, "claude child worker", { ppid: parentPid, ignoreTerm: true });
  registry.projects.alpha.pid = parentPid;
  seedRegistry(workspace, registry);

  const result = await stopProject(workspace);

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.equal(isAlive(parentPid), false);
  assert.equal(isAlive(childPid), false);
});

test("stop-session skips Codex listener sweep when required registry fields are missing", async () => {
  const workspace = createWorkspace();
  const registry = buildRegistry(workspace, {
    sessionType: "codex",
    project: { channel_id: "", ws_port: "", pid: null },
  });
  const orphanPid = spawnOwnedProcess(workspace, codexBridgeCommand());
  seedRegistry(workspace, registry);

  const result = await stopProject(workspace);

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.match(result.stderr, /Skipping Codex listener sweep/);
  assert.equal(isAlive(orphanPid), true);
});

// ---- stop-session through the fake ccdm-host, and what any backend must do ----

const WIN_ONLY = "Windows finds session processes by their command line";
const WAIT_STEP_MS = 50;

// Stopped at teardown through the handle this test holds, so nothing else can be hit.
function spawnWithArgs(args, program = process.execPath, leading = ["-e", "setInterval(() => {}, 1000)", "--"]) {
  const child = spawn(program, [...leading, ...args], { detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
  registerTeardownCallback(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      // It has already ended.
    }
  });
  return child.pid;
}

const spawnBystander = () => spawnWithArgs([]);

function writePrivate(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, { mode: 0o600 });
}

// One project with its key, launch files, thread launch files and capability marker on disk.
async function hostWorld(overrides = {}) {
  const workspace = createWorkspace();
  const fake = await startFakeHost(workspace);
  const routerDir = path.join(fake.stateRoot, "router");
  const launchDir = path.join(routerDir, "launches", "alpha");
  const files = {
    key: path.join(routerDir, "keys", "alpha.key"),
    launchDir,
    mcp: path.join(launchDir, "mcp.json"),
    settings: path.join(launchDir, "run", "settings.json"),
    threadLaunch: path.join(launchDir, "threads", "123", "mcp.json"),
    marker: path.join(fake.stateRoot, "conversation-reminders", "capabilities", "alpha.json"),
  };
  writePrivate(files.key, "key\n");
  writePrivate(files.mcp, "{}\n");
  writePrivate(files.settings, "{}\n");
  writePrivate(files.threadLaunch, "{}\n");
  writePrivate(files.marker, "{}\n");
  const stop = (args = ["alpha"], env = {}) => runScript(workspace, "scripts/stop-session.sh", {
    args, env: { ...fake.env, ...env }, timeoutMs: 30000,
  });
  return { workspace, fake, files, stop, registry: buildRegistry(workspace, overrides) };
}

function assertClaudeStateGone(world) {
  assert.equal(fs.existsSync(world.files.key), false, "key file");
  assert.equal(fs.existsSync(world.files.mcp), false, "launch file");
  assert.equal(fs.existsSync(world.files.settings), false, "launch directory entry");
  assert.equal(fs.existsSync(world.files.marker), false, "capability marker");
  const registry = readRegistry(world.workspace).projects.alpha;
  assert.equal(registry.pid, null);
  assert.equal(registry.session_id, null);
}

test("on Windows, a stopped session leaves nothing from its Job and no process carrying its key-file argument", platformGate("win32", WIN_ONLY), async () => {
  const world = await hostWorld();
  const root = spawnWithArgs(["--mcp-config", world.files.mcp]);
  const child = spawnWithArgs(["--ccdm-key-file", world.files.key]);
  world.registry.projects.alpha.pid = root;
  world.registry.projects.alpha.pid_started_at = "133000000000000000";
  seedRegistry(world.workspace, world.registry);
  seedTmuxSession("alpha_session", { pid: root, job: [root, child] }, { stateDir: world.workspace.stateDir });

  const result = await world.stop();

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.equal(readRegistry(world.workspace).projects.alpha.pid_started_at, null);
  assert.match(result.stdout, new RegExp(`Stopping recorded process tree for 'alpha' \\(pid ${root}\\)`));
  assert.match(result.stdout, /Stopped session 'alpha_session'/);
  assert.doesNotMatch(result.stdout, /tmux/);
  assert.match(result.stdout, /Stopped Discord session 'alpha'/);
  assert.equal(isAlive(root), false);
  assert.equal(isAlive(child), false);
  assertClaudeStateGone(world);
  assert.equal(fs.existsSync(world.files.threadLaunch), true, "a plain stop keeps threads/");
  const ops = hostOps(world.workspace).map(call => call.op);
  const killed = ops.indexOf("kill");
  assert.ok(killed >= 0, ops.join(" "));
  assert.equal(hostOps(world.workspace)[killed].graceMs, 2000);
  assert.ok(ops.lastIndexOf("pids") > killed, `the session is confirmed empty after the kill: ${ops.join(" ")}`);
});

test("on Windows, the launch directory goes once no thread launch is left", platformGate("win32", WIN_ONLY), async () => {
  const world = await hostWorld();
  fs.rmSync(path.join(world.files.launchDir, "threads"), { recursive: true });
  seedRegistry(world.workspace, world.registry);

  const result = await world.stop();

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.equal(fs.existsSync(world.files.launchDir), false);
  assertClaudeStateGone(world);
});

test("on Windows, an orphan listener outside the Job is found by its key-file argument and killed", platformGate("win32", WIN_ONLY), async () => {
  const world = await hostWorld();
  seedRegistry(world.workspace, world.registry);
  // The launcher's form and the same path with forward slashes are one path.
  const orphan = spawnWithArgs(["--ccdm-key-file", world.files.key.replaceAll("\\", "/")]);
  const launchOrphan = spawnWithArgs(["--settings", world.files.settings]);

  const result = await world.stop();

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /No active session 'alpha_session' found/);
  assert.match(result.stdout, /Cleaning remaining listener process\(es\):/);
  assert.match(result.stdout, new RegExp(`^  ${orphan}$`, "m"));
  assert.match(result.stdout, new RegExp(`^  ${launchOrphan}$`, "m"));
  assert.equal(isAlive(orphan), false);
  assert.equal(isAlive(launchOrphan), false);
  assertClaudeStateGone(world);
});

test("on Windows, a Codex stop leaves no app-server on the bridge's port and keeps other ports", platformGate("win32", WIN_ONLY), async () => {
  const world = await hostWorld({ sessionType: "codex" });
  seedRegistry(world.workspace, world.registry);
  const bridge = spawnWithArgs(["--ccdm-key-file", world.files.key]);
  const appServer = spawnWithArgs(["app-server", "--listen", "ws://127.0.0.1:18342"]);
  const otherPort = spawnWithArgs(["app-server", "--listen", "ws://127.0.0.1:18343"]);

  const result = await world.stop();

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.equal(isAlive(bridge), false);
  assert.equal(isAlive(appServer), false);
  assert.equal(isAlive(otherPort), true);
  assert.equal(readRegistry(world.workspace).projects.alpha.pid, null);
  assert.equal(fs.existsSync(world.files.key), true, "the Codex launcher owns its key file");
});

test("on Windows, an unrelated process whose PID was planted in state survives, as do near matches", platformGate("win32", WIN_ONLY), async () => {
  const world = await hostWorld();
  const planted = spawnBystander();
  world.registry.projects.alpha.pid = planted;
  seedRegistry(world.workspace, world.registry);
  const launches = path.dirname(world.files.launchDir);
  const nearMisses = [
    spawnWithArgs(["--ccdm-key-file", `${world.files.key}.bak`]),
    spawnWithArgs(["--ccdm-key-file", path.join(path.dirname(world.files.key), "beta.key")]),
    spawnWithArgs(["--mcp-config", path.join(launches, "alpha2", "mcp.json")]),
    spawnWithArgs(["--mcp-config", world.files.threadLaunch]),
    // The flag and the path, but not as the flag's value.
    spawnWithArgs([world.files.key, "--ccdm-key-file"]),
    // A program that is no listener, with a launch file named.
    spawnWithArgs([world.files.mcp], PYTHON, ["-c", "import time; time.sleep(600)"]),
  ];

  const result = await world.stop();

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.match(result.stdout, new RegExp(`Skipping recorded pid ${planted}: it no longer belongs to 'alpha'`));
  assert.equal(isAlive(planted), true);
  for (const pid of nearMisses) assert.equal(isAlive(pid), true, `process ${pid} is not this session's`);
  assert.equal(readRegistry(world.workspace).projects.alpha.pid, null);
});

test("on Windows, a launch file that stays held fails the stop loudly and leaves the registry", platformGate("win32", WIN_ONLY), async () => {
  const world = await hostWorld();
  world.registry.projects.alpha.pid = 4242;
  seedRegistry(world.workspace, world.registry);
  // Python's open() shares nothing for deletion, so this holds the file against removal.
  const holderScript = "import sys, time\nhandle = open(sys.argv[1], 'r')\nopen(sys.argv[2], 'w').close()\ntime.sleep(600)\n";
  const ready = path.join(world.workspace.tmpDir, "holding");
  spawnWithArgs([world.files.mcp, ready], PYTHON, ["-c", holderScript]);
  for (let waited = 0; !fs.existsSync(ready); waited += WAIT_STEP_MS) {
    assert.ok(waited < 15000, "the file holder never started");
    await new Promise(resolve => setTimeout(resolve, WAIT_STEP_MS));
  }

  const result = await world.stop();

  assert.equal(result.exitCode, 1, result.stdout);
  assert.match(result.stderr, /could not be removed/);
  assert.doesNotMatch(result.stdout, /Stopped Discord session/);
  assert.equal(readRegistry(world.workspace).projects.alpha.pid, 4242);
});

test("on Windows, a stop from inside the session moves to a detached copy that finishes the job", platformGate("win32", WIN_ONLY), async () => {
  const world = await hostWorld();
  const root = spawnBystander();
  seedRegistry(world.workspace, world.registry);
  seedTmuxSession("alpha_session", { pid: root, job: [root] }, { stateDir: world.workspace.stateDir });

  const result = await world.stop(["alpha"], { CCDM_SESSION_NAME: "alpha_session" });

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /continues in a detached process/);
  for (let waited = 0; readRegistry(world.workspace).projects.alpha.session_id !== null; waited += WAIT_STEP_MS) {
    assert.ok(waited < 20000, "the detached copy never cleared the registry");
    await new Promise(resolve => setTimeout(resolve, WAIT_STEP_MS));
  }
  assert.equal(isAlive(root), false);
});

test("a registry path containing a single quote works", async () => {
  const workspace = createWorkspace();
  const repoDir = path.join(workspace.tmpRoot, "it's the repo");
  fs.cpSync(workspace.repoDir, repoDir, { recursive: true });
  const quoted = { ...workspace, repoDir };
  seedRegistry(quoted, buildRegistry(quoted));

  const result = await stopProject(quoted);

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Stopped Discord session 'alpha'/);
  assert.equal(readRegistry(quoted).projects.alpha.pid, null);
  assert.equal(readRegistry(quoted).projects.alpha.session_id, null);
});

test("the shim and scripts/ccdm stop-session give the same output and exit codes", async () => {
  const workspace = createWorkspace();
  seedRegistry(workspace, buildRegistry(workspace));
  const viaBoth = async (args) => {
    const shim = await runScript(workspace, "scripts/stop-session.sh", { args, timeoutMs: 30000 });
    const command = await runScript(workspace, "scripts/ccdm", { args: ["stop-session", ...args], timeoutMs: 30000 });
    assert.equal(command.exitCode, shim.exitCode, args.join(" "));
    assert.equal(command.stdout, shim.stdout, args.join(" "));
    assert.equal(command.stderr, shim.stderr, args.join(" "));
    return shim;
  };

  for (const args of [[], ["alpha", "--bogus"], ["alpha", "--all", "extra"]]) {
    const refused = await viaBoth(args);
    assert.equal(refused.exitCode, 1, args.join(" "));
    assert.match(refused.stdout, /^Usage: .*stop-session.* <project_name> \[--threads\|--all\]$/m);
  }
  const help = await viaBoth(["--help"]);
  assert.equal(help.exitCode, 0);
  assert.equal(readRegistry(workspace).projects.alpha.session_id, "existing-session", "--help changes nothing");

  const stopped = await viaBoth(["alpha"]);
  assert.equal(stopped.exitCode, 0, stopped.stderr);
  assert.match(stopped.stdout, /Stopped Discord session 'alpha'/);

  const unknown = await viaBoth(["nosuch"]);
  assert.equal(unknown.exitCode, 1);
  assert.match(unknown.stderr, /unknown project: nosuch/);
});

// ---- restart-root: tmux on Linux and macOS, the fake ccdm-host everywhere ----

const WIN = process.platform === "win32";
const DEFAULT_BACKEND = WIN ? "ccdm-host" : "tmux";
const ROOT_BACKENDS = WIN ? ["ccdm-host"] : ["tmux", "ccdm-host"];
const SESSION_WORD = WIN ? "session" : "tmux session";
// A Windows temp folder can carry a short (8.3) name; the `ccdm` entry starts Python from the long one.
const repoAsLaunched = workspace => (WIN ? fs.realpathSync.native(workspace.repoDir) : workspace.repoDir);
// What a launch ran: the tmux string, or the argv the fake host received.
const launchText = session => session.shellCommand ?? session.command.join(" ");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const rootHosts = new WeakMap();
async function rootHost(workspace) {
  if (!rootHosts.has(workspace)) rootHosts.set(workspace, await startFakeHost(workspace, { env: routerEnv(workspace) }));
  return rootHosts.get(workspace);
}

async function restartRoot(workspace, { args = [], backend = DEFAULT_BACKEND, env = {}, script = "restart-root-agent.sh" } = {}) {
  const backendEnv = backend === "tmux" ? {} : (await rootHost(workspace)).env;
  return runScript(workspace, script, { args, env: routerEnv(workspace, { ...backendEnv, ...env }), timeoutMs: 30000 });
}

function rootFiles(workspace) {
  const launchDir = path.join(workspace.routerStateDir, "launches", ".root");
  return {
    key: path.join(workspace.routerStateDir, "keys", ".root.key"),
    mcp: path.join(launchDir, "mcp.json"),
    settings: path.join(launchDir, "settings.json"),
    ready: path.join(launchDir, "ready.json"),
  };
}

// Windows names the key file on the channel server's command line: another process's environment is not readable there.
function channelServerArgs(workspace) {
  const script = path.join(repoAsLaunched(workspace), "scripts", "ccdm-channel-server.js");
  return WIN ? [script, "--ccdm-key-file", rootFiles(workspace).key] : [script];
}

const rootSession = workspace => readState(workspace.stateDir).fixtures.tmux.sessions.root_agent;
const outputLines = result => result.stdout.split(/\r?\n/).filter(Boolean);

async function waitUntilGone(pids) {
  for (let waited = 0; pids.some(isAlive); waited += WAIT_STEP_MS) {
    assert.ok(waited < 10000, `still running: ${pids.filter(isAlive).join(" ")}`);
    await sleep(WAIT_STEP_MS);
  }
}

test("restart-root-agent simulates root_agent cleanup, retry, fresh launch, and development-channel send-key", platformGate("posix", TMUX_ROOT), async () => {
  const workspace = createRouterWorkspace();
  await startRouter(workspace);
  const panePid = spawnOwnedProcess(workspace, "zsh root pane");
  const childPid = spawnOwnedProcess(workspace, "claude root child", { ppid: panePid });
  seedTmuxSession(
    "root_agent",
    { panePid, killFailuresRemaining: 1, paneOutput: "old root\n" },
    { stateDir: workspace.stateDir },
  );

  const result = await runScript(workspace, "restart-root-agent.sh", { env: routerEnv(workspace), timeoutMs: 20000 });

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Restarted root agent in tmux session 'root_agent'/);
  assert.equal(isAlive(childPid), false);
  const session = readState(workspace.stateDir).fixtures.tmux.sessions.root_agent;
  assert.equal(session.cwd, workspace.repoDir);
  assert.equal(session.env.CCDM_ROUTER_KEY_FILE, path.join(workspace.routerStateDir, "keys", ".root.key"));
  assert.deepEqual(session.sendKeys, [["Enter"]]);
  assert.equal(session.killAttempts, 2);
});

test("the retired reminder-adapter opt-in and a selected root state directory leave root Claude on the Router", async () => {
  const workspace = createRouterWorkspace();
  await startRouter(workspace);
  const selectedState = path.join(workspace.homeDir, "selected-root-discord");
  const pluginDir = path.join(workspace.homeDir, ".claude", "plugins", "cache", "claude-plugins-official", "discord", "0.0.4");
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(path.join(pluginDir, "server.ts"), "// fixture official plugin\n");

  const result = await restartRoot(workspace, {
    env: {
      CCDM_CLAUDE_REMINDER_ADAPTER: "1",
      ROOT_DISCORD_STATE_DIR: selectedState,
      CCDM_FIXTURE_CLAUDE_VERSION: "1.0.0 (Claude Code fixture)",
    },
  });

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Root channel server connected to the Router/);
  const session = readState(workspace.stateDir).fixtures.tmux.sessions.root_agent;
  assert.match(launchText(session), /--dangerously-load-development-channels server:ccdm/);
  assert.equal(session.env.CCDM_ROUTER_KEY_FILE, rootFiles(workspace).key);
  for (const forbidden of ["DISCORD_STATE_DIR", "plugin:discord", "server:discord"]) {
    assert.equal(launchText(session).includes(forbidden), false, forbidden);
    assert.equal(JSON.stringify(session.env).includes(forbidden), false, forbidden);
  }
  const config = JSON.parse(fs.readFileSync(rootFiles(workspace).mcp, "utf8"));
  assert.deepEqual(Object.keys(config.mcpServers), ["ccdm"]);
  assert.deepEqual(config.mcpServers.ccdm.args, channelServerArgs(workspace));
  assert.equal(fs.existsSync(selectedState), false);
  assert.equal(fs.existsSync(path.join(workspace.homeDir, ".claude", "channels", "discord", "ccdm-root-reminder-mcp.json")), false);
});

test("restart-root-codex-agent starts the root bot through the Codex bridge in Router root mode", platformGate("posix", CODEX_ROOT), async () => {
  const workspace = createRouterWorkspace();
  const codexHome = path.join(workspace.homeDir, ".codex-ccdm");
  fs.mkdirSync(codexHome, { recursive: true });
  seedRegistry(workspace, {
    ...buildRegistry(workspace, { codexHome }),
    root_bot_app_id: "root-app",
    root_allowed_user_ids: ["global-user-id"],
  });
  seedRootCodexFiles(workspace);
  const rootStateDir = path.join(workspace.homeDir, ".claude", "channels", "discord");
  const env = await rootCodexRouterEnv(workspace, { CODEX_HOME: path.join(workspace.homeDir, ".codex-legacy") });
  const port = env.ROOT_CODEX_WS_PORT;
  const panePid = spawnOwnedProcess(workspace, "zsh root pane");
  const childPid = spawnOwnedProcess(workspace, "claude root child", { ppid: panePid });
  const orphanBridgePid = spawnOwnedProcess(
    workspace,
    `node scripts/codex-bridge.js BOT_APP_ID='root-app' WS_PORT='${port}'`,
  );
  const orphanAppServerPid = spawnOwnedProcess(
    workspace,
    `codex app-server --listen ws://127.0.0.1:${port}`,
  );
  const orphanClaudePid = spawnOwnedProcess(
    workspace,
    `bun server.ts DISCORD_STATE_DIR='${rootStateDir}' CLAUDE_PLUGIN_ROOT='/tmp/claude-plugins-official/discord/0.0.4'`,
  );
  seedTmuxSession(
    "root_agent",
    { panePid, killFailuresRemaining: 1, paneOutput: "old root\n" },
    { stateDir: workspace.stateDir },
  );

  const result = await runScript(workspace, "restart-root-codex-agent.sh", { args: ["root-channel-id"], env, timeoutMs: 30000 });

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Restarted root Codex agent in tmux session 'root_agent'/);
  assert.match(result.stdout, /Cleaning remaining root listener process\(es\):/);
  assert.equal(isAlive(childPid), false);
  assert.equal(isAlive(orphanBridgePid), false);
  assert.equal(isAlive(orphanAppServerPid), false);
  assert.equal(isAlive(orphanClaudePid), false);
  const session = readState(workspace.stateDir).fixtures.tmux.sessions.root_agent;
  assert.equal(session.cwd, workspace.repoDir);
  assert.deepEqual(session.env, {
    ALLOWED_USER_IDS: "allowed-user-id,global-user-id",
    BOT_APP_ID: "root-app",
    CCDM_CHANNEL_READY_FILE: path.join(workspace.routerStateDir, "launches", ".root", "ready.json"),
    CCDM_ROUTER_KEY_FILE: path.join(workspace.routerStateDir, "keys", ".root.key"),
    CCDM_ROUTER_ROLE: "root",
    CCDM_ROUTER_STATE_DIR: workspace.routerStateDir,
    CHANNEL_ID: "root-channel-id",
    CODEX_HOME: codexHome,
    PROJECT_DIR: workspace.repoDir,
    ROOT_BOT_APP_ID: "root-app",
    WS_PORT: port,
    // Every session carries its own name: a restart asked for from inside root reads it.
    CCDM_SESSION_NAME: "root_agent",
  });
  assert.equal(session.bridgeCommand, "node scripts/codex-bridge.js");
  assert.equal(session.killAttempts, 2);
});

test("restart-root-codex-agent uses the Default Codex Account when no emergency override is set", platformGate("posix", CODEX_ROOT), async () => {
  const workspace = createRouterWorkspace();
  const defaultAccountHome = path.join(workspace.homeDir, ".codex-default-account");
  fs.mkdirSync(defaultAccountHome, { recursive: true });
  const registry = buildRegistry(workspace, { sessionType: "codex" });
  registry.codex_accounts = { "codex-default": defaultAccountHome };
  registry.default_codex_account = "codex-default";
  seedRegistry(workspace, registry);
  seedRootCodexFiles(workspace);

  const result = await runScript(workspace, "restart-root-codex-agent.sh", {
    args: ["root-channel-id"],
    env: await rootCodexRouterEnv(workspace),
    timeoutMs: 30000,
  });

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.equal(readState(workspace.stateDir).fixtures.tmux.sessions.root_agent.env.CODEX_HOME, defaultAccountHome);
});

test("restart-root-codex-agent rejects malformed global named-account selectors before teardown", platformGate("posix", CODEX_ROOT), async () => {
  const cases = [
    {
      name: "map wrong type",
      setup(registry) {
        registry.codex_accounts = [];
        registry.default_codex_account = "configured";
      },
      message: /codex_accounts.*object mapping/,
    },
    {
      name: "empty default selector",
      setup(registry, workspace) {
        registry.codex_accounts = { configured: path.join(workspace.homeDir, ".codex-configured") };
        registry.default_codex_account = " ";
      },
      message: /default_codex_account.*empty or whitespace-only/,
    },
    {
      name: "wrong-typed default selector",
      setup(registry, workspace) {
        registry.codex_accounts = { configured: path.join(workspace.homeDir, ".codex-configured") };
        registry.default_codex_account = 42;
      },
      message: /default_codex_account.*non-empty string/,
    },
  ];

  for (const invalidCase of cases) {
    const workspace = createWorkspace();
    const registry = buildRegistry(workspace, { sessionType: "codex" });
    invalidCase.setup(registry, workspace);
    seedRegistry(workspace, registry);
    seedRootCodexFiles(workspace);

    const result = await runScript(workspace, "restart-root-codex-agent.sh", {
      args: ["root-channel-id"],
    });

    assert.notEqual(result.exitCode, 0, invalidCase.name);
    assert.match(`${result.stdout}\n${result.stderr}`, invalidCase.message, invalidCase.name);
    assert.deepEqual(readState(workspace.stateDir).fixtures.tmux.sessions, {}, invalidCase.name);
  }
});

test("restart-root-codex-agent rejects an unknown Default Codex Account before root teardown", platformGate("posix", CODEX_ROOT), async () => {
  const workspace = createWorkspace();
  const registry = buildRegistry(workspace, { sessionType: "codex" });
  registry.codex_accounts = { configured: path.join(workspace.homeDir, ".codex-configured") };
  registry.default_codex_account = "missing-account";
  seedRegistry(workspace, registry);
  seedRootCodexFiles(workspace);
  const panePid = spawnOwnedProcess(workspace, "zsh root pane");
  const childPid = spawnOwnedProcess(workspace, "node scripts/codex-bridge.js", { ppid: panePid });
  seedTmuxSession("root_agent", { panePid, paneOutput: "old root\n" }, { stateDir: workspace.stateDir });

  const result = await runScript(workspace, "restart-root-codex-agent.sh", {
    args: ["root-channel-id"],
  });

  assert.notEqual(result.exitCode, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /unknown Codex Account Alias 'missing-account'/);
  const state = readState(workspace.stateDir);
  assert.equal(state.fixtures.tmux.sessions.root_agent.panePid, panePid);
  assert.equal(isAlive(childPid), true);
});

test("restart-root-codex-agent rejects a Default Codex Account and Legacy Codex Home conflict", platformGate("posix", CODEX_ROOT), async () => {
  const workspace = createWorkspace();
  const accountHome = path.join(workspace.homeDir, ".codex-account");
  const legacyHome = path.join(workspace.homeDir, ".codex-legacy");
  fs.mkdirSync(accountHome, { recursive: true });
  fs.mkdirSync(legacyHome, { recursive: true });
  const registry = buildRegistry(workspace, { sessionType: "codex", codexHome: legacyHome });
  registry.codex_accounts = { "codex-account": accountHome };
  registry.default_codex_account = "codex-account";
  seedRegistry(workspace, registry);
  seedRootCodexFiles(workspace);

  const result = await runScript(workspace, "restart-root-codex-agent.sh", {
    args: ["root-channel-id"],
  });

  assert.notEqual(result.exitCode, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /default_codex_account.*top-level codex_home/);
  assert.deepEqual(readState(workspace.stateDir).fixtures.tmux.sessions, {});
});

test("restart-root-codex-agent keeps ROOT_CODEX_HOME above the shared home", platformGate("posix", CODEX_ROOT), async () => {
  const workspace = createRouterWorkspace();
  const rootHome = path.join(workspace.homeDir, ".codex-root");
  const defaultAccountHome = path.join(workspace.homeDir, ".codex-default-account");
  fs.mkdirSync(rootHome, { recursive: true });
  fs.mkdirSync(defaultAccountHome, { recursive: true });
  const registry = buildRegistry(workspace);
  registry.codex_accounts = { "codex-default": defaultAccountHome };
  registry.default_codex_account = "codex-default";
  seedRegistry(workspace, registry);
  seedRootCodexFiles(workspace);

  const result = await runScript(workspace, "restart-root-codex-agent.sh", {
    args: ["root-channel-id"],
    env: await rootCodexRouterEnv(workspace, { ROOT_CODEX_HOME: rootHome }),
    timeoutMs: 30000,
  });

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.equal(readState(workspace.stateDir).fixtures.tmux.sessions.root_agent.env.CODEX_HOME, rootHome);
});

test("restart-root-codex-agent validates the selected home before tearing down root_agent", platformGate("posix", CODEX_ROOT), async () => {
  const workspace = createWorkspace();
  const missingHome = path.join(workspace.homeDir, ".missing-root-codex");
  seedRegistry(workspace, buildRegistry(workspace, { codexHome: missingHome }));
  seedRootCodexFiles(workspace);
  const panePid = spawnOwnedProcess(workspace, "zsh root pane");
  const childPid = spawnOwnedProcess(workspace, "node scripts/codex-bridge.js", { ppid: panePid });
  seedTmuxSession("root_agent", { panePid, paneOutput: "old root\n" }, { stateDir: workspace.stateDir });

  const result = await runScript(workspace, "restart-root-codex-agent.sh", {
    args: ["root-channel-id"],
  });

  assert.notEqual(result.exitCode, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /top-level codex_home.*does not exist/);
  const state = readState(workspace.stateDir);
  assert.equal(state.fixtures.tmux.sessions.root_agent.panePid, panePid);
  assert.equal(isAlive(childPid), true);
  assert.deepEqual(Object.keys(state.fixtures.tmux.sessions), ["root_agent"]);
});

test("restart-root-codex-agent rejects every invalid selected home before root teardown", platformGate("posix", CODEX_ROOT), async () => {
  const cases = [
    {
      name: "missing",
      setup(workspace) {
        return path.join(workspace.homeDir, ".missing-root-codex");
      },
      message: /does not exist/,
    },
    {
      name: "non-directory",
      setup(workspace) {
        const selectedHome = path.join(workspace.homeDir, ".root-codex-file");
        fs.writeFileSync(selectedHome, "not a directory\n");
        return selectedHome;
      },
      message: /not a directory/,
    },
    {
      name: "inaccessible",
      setup(workspace) {
        const selectedHome = path.join(workspace.homeDir, ".root-codex-read-only");
        fs.mkdirSync(selectedHome, { recursive: true });
        fs.chmodSync(selectedHome, 0o555);
        return selectedHome;
      },
      message: /not writable/,
    },
    {
      name: "broken symlink",
      setup(workspace) {
        const selectedHome = path.join(workspace.homeDir, ".broken-root-codex");
        fs.symlinkSync(path.join(workspace.tmpDir, "missing-root-target"), selectedHome, "dir");
        return selectedHome;
      },
      message: /broken symlink/,
    },
    {
      name: "unusable config",
      setup(workspace) {
        const selectedHome = path.join(workspace.homeDir, ".root-codex-config-directory");
        fs.mkdirSync(path.join(selectedHome, "config.toml"), { recursive: true });
        return selectedHome;
      },
      message: /config\.toml.*not a regular file/,
    },
    {
      name: "empty selector",
      setup() {
        return "";
      },
      message: /top-level codex_home.*empty or whitespace-only/,
    },
    {
      name: "wrong-typed selector",
      setup() {
        return 42;
      },
      message: /top-level codex_home.*non-empty string/,
    },
  ];

  for (const invalidCase of cases) {
    const workspace = createWorkspace();
    const registry = buildRegistry(workspace);
    registry.codex_home = invalidCase.setup(workspace);
    seedRegistry(workspace, registry);
    seedRootCodexFiles(workspace);
    const panePid = spawnOwnedProcess(workspace, `zsh root pane (${invalidCase.name})`);
    const childPid = spawnOwnedProcess(workspace, `node scripts/codex-bridge.js (${invalidCase.name})`, { ppid: panePid });
    seedTmuxSession("root_agent", { panePid, paneOutput: "old root\n" }, { stateDir: workspace.stateDir });

    const result = await runScript(workspace, "restart-root-codex-agent.sh", {
      args: ["root-channel-id"],
    });

    assert.notEqual(result.exitCode, 0, invalidCase.name);
    assert.match(`${result.stdout}\n${result.stderr}`, invalidCase.message, invalidCase.name);
    const state = readState(workspace.stateDir);
    assert.equal(state.fixtures.tmux.sessions.root_agent.panePid, panePid, invalidCase.name);
    assert.equal(isAlive(childPid), true, invalidCase.name);
    await cleanup();
  }
});

test("restart-root-codex-agent uses ambient CODEX_HOME when the registry has no home", platformGate("posix", CODEX_ROOT), async () => {
  const workspace = createRouterWorkspace();
  const ambientHome = path.join(workspace.homeDir, ".codex-ambient");
  fs.mkdirSync(ambientHome, { recursive: true });
  seedRegistry(workspace, buildRegistry(workspace));
  seedRootCodexFiles(workspace);

  const result = await runScript(workspace, "restart-root-codex-agent.sh", {
    args: ["root-channel-id"],
    env: await rootCodexRouterEnv(workspace, { CODEX_HOME: ambientHome }),
    timeoutMs: 30000,
  });

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.equal(readState(workspace.stateDir).fixtures.tmux.sessions.root_agent.env.CODEX_HOME, ambientHome);
});

test("restart-root-codex-agent lets ROOT_CODEX_HOME recover from a broken registry home", platformGate("posix", CODEX_ROOT), async () => {
  const workspace = createRouterWorkspace();
  const rootHome = path.join(workspace.homeDir, ".codex-emergency");
  fs.mkdirSync(rootHome, { recursive: true });
  const registry = buildRegistry(workspace);
  registry.codex_home = path.join(workspace.homeDir, ".broken-registry-codex");
  seedRegistry(workspace, registry);
  seedRootCodexFiles(workspace);

  const result = await runScript(workspace, "restart-root-codex-agent.sh", {
    args: ["root-channel-id"],
    env: await rootCodexRouterEnv(workspace, { ROOT_CODEX_HOME: rootHome }),
    timeoutMs: 30000,
  });

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.equal(readState(workspace.stateDir).fixtures.tmux.sessions.root_agent.env.CODEX_HOME, rootHome);
});

test("restart-root-codex-agent re-reads the registry home on every restart", platformGate("posix", CODEX_ROOT), async () => {
  const workspace = createRouterWorkspace();
  const firstHome = path.join(workspace.homeDir, ".codex-first");
  const secondHome = path.join(workspace.homeDir, ".codex-second");
  fs.mkdirSync(firstHome, { recursive: true });
  fs.mkdirSync(secondHome, { recursive: true });
  const registry = buildRegistry(workspace);
  registry.codex_accounts = { first: firstHome, second: secondHome };
  registry.default_codex_account = "first";
  seedRegistry(workspace, registry);
  seedRootCodexFiles(workspace);
  const env = await rootCodexRouterEnv(workspace);

  const firstResult = await runScript(workspace, "restart-root-codex-agent.sh", {
    args: ["root-channel-id"],
    env,
    timeoutMs: 30000,
  });
  assert.equal(firstResult.exitCode, 0, firstResult.stderr || firstResult.stdout);
  assert.equal(readState(workspace.stateDir).fixtures.tmux.sessions.root_agent.env.CODEX_HOME, firstHome);

  registry.default_codex_account = "second";
  registry.root_channels = ["root-channel-id"];
  fs.writeFileSync(path.join(workspace.repoDir, "registry.json"), `${JSON.stringify(registry, null, 2)}\n`);

  const secondResult = await runScript(workspace, "restart-root-codex-agent.sh", {
    args: ["root-channel-id"],
    env,
    timeoutMs: 30000,
  });
  assert.equal(secondResult.exitCode, 0, secondResult.stderr || secondResult.stdout);
  assert.equal(readState(workspace.stateDir).fixtures.tmux.sessions.root_agent.env.CODEX_HOME, secondHome);
});

test("restart-root-codex-agent keeps the legacy default without home overrides", platformGate("posix", CODEX_ROOT), async () => {
  const workspace = createRouterWorkspace();
  fs.mkdirSync(path.join(workspace.homeDir, ".codex"), { recursive: true });
  seedRegistry(workspace, buildRegistry(workspace));
  seedRootCodexFiles(workspace);

  const result = await runScript(workspace, "restart-root-codex-agent.sh", {
    args: ["root-channel-id"],
    env: await rootCodexRouterEnv(workspace),
    timeoutMs: 30000,
  });

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.equal(
    readState(workspace.stateDir).fixtures.tmux.sessions.root_agent.env.CODEX_HOME,
    path.join(workspace.homeDir, ".codex"),
  );
});

test("restart-root-codex-agent rejects a channel missing from the registry's root channels before stopping the current root", platformGate("posix", CODEX_ROOT), async () => {
  const workspace = createWorkspace();
  seedRegistry(workspace, buildRegistry(workspace));
  const panePid = spawnOwnedProcess(workspace, "zsh root pane");
  const childPid = spawnOwnedProcess(workspace, "claude root child", { ppid: panePid });
  seedTmuxSession("root_agent", { panePid, paneOutput: "old root\n" }, { stateDir: workspace.stateDir });

  const unmigrated = await runScript(workspace, "restart-root-codex-agent.sh", { args: ["missing-channel"] });
  assert.notEqual(unmigrated.exitCode, 0);
  assert.match(unmigrated.stderr, /No root_channels in .*registry\.json\. Run `node scripts\/router\.js migrate-root-config`/);

  seedRootCodexFiles(workspace, ["configured-channel"]);
  const result = await runScript(workspace, "restart-root-codex-agent.sh", { args: ["missing-channel"] });
  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /Root channel missing-channel is not in root_channels/);
  assert.ok(readState(workspace.stateDir).fixtures.tmux.sessions.root_agent);
  assert.equal(isAlive(childPid), true);
});

test("restart-root-agent launch failures include command diagnostics", async () => {
  const workspace = createRouterWorkspace();
  await startRouter(workspace);
  const state = readState(workspace.stateDir);
  state.fixtures.tmux.newSessionFailures = { root_agent: 1 };
  writeState(state, workspace.stateDir);

  const result = await restartRoot(workspace);

  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /fixture tmux new-session failure/);
  assert.match(result.stderr, new RegExp(`Failed to create ${SESSION_WORD} 'root_agent'`));
  assert.deepEqual(result.diagnostics.command, [path.join(workspace.repoDir, "restart-root-agent.sh")]);
  assert.equal(result.diagnostics.fixtureState.fixtures.tmux.newSessionFailures.root_agent, 0);
});

test("restart-root-agent teardown failures are recorded as diagnostics", async () => {
  const workspace = createRouterWorkspace();
  await startRouter(workspace);
  registerTeardownCallback(() => {
    throw new Error("restart cleanup failure");
  });

  const result = await restartRoot(workspace);

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  await cleanup({ stateDir: workspace.stateDir });
  assert.match(JSON.stringify(readState(workspace.stateDir).diagnostics.cleanupFailures), /restart cleanup failure/);
});

// ---- restart-root: who runs it, the hand-off, and Claude's start-up prompts ----

const ROOT_PROMPT_SCREEN = "WARNING: Loading development channels\n\n--dangerously-load-development-channels is for local channel development only.\n";
const CHANGING_OPS = ["kill", "new", "run-detached"];
const CHANGING_TMUX = ["kill-session", "new-session"];
const changes = workspace => sessionCalls(workspace)
  .filter(call => CHANGING_OPS.includes(call.op) || CHANGING_TMUX.includes(call.args?.[0]));

test("on the fake host, restart-root from a plain terminal and from a project session runs in the foreground: the old root is stopped and a new one starts with a fresh key", async () => {
  const workspace = createRouterWorkspace();
  await startRouter(workspace);
  const files = rootFiles(workspace);
  const first = await restartRoot(workspace, { backend: "ccdm-host" });
  assert.equal(first.exitCode, 0, first.stderr || first.stdout);
  const old = rootSession(workspace);
  const oldKey = fs.readFileSync(files.key, "utf8");

  const second = await restartRoot(workspace, { backend: "ccdm-host", env: { CCDM_SESSION_NAME: "alpha_session" } });

  assert.equal(second.exitCode, 0, second.stderr || second.stdout);
  for (const result of [first, second]) {
    assert.deepEqual(outputLines(result), [
      "Root channel server connected to the Router",
      `Restarted root agent in ${SESSION_WORD} 'root_agent'`,
      "Attach with: scripts/ccdm attach root",
    ]);
  }
  await waitUntilGone(old.job);
  assert.notEqual(rootSession(workspace).pid, old.pid);
  assert.notEqual(fs.readFileSync(files.key, "utf8"), oldKey);
  const ops = hostOps(workspace);
  assert.equal(ops.some(call => call.op === "run-detached"), false, "nothing was handed off");
  const launches = ops.filter(call => call.op === "new");
  assert.equal(launches.length, 2);
  const stopped = ops.findLastIndex(call => call.op === "kill");
  assert.ok(stopped >= 0 && stopped < ops.lastIndexOf(launches[1]), "the old root is stopped before the new one starts");
  assert.equal(ops[stopped].name, "root_agent");
  assert.equal(ops[stopped].graceMs, 2000);
  const { name, kind, pty, cwd, env } = launches[1];
  assert.deepEqual({ name, kind, pty, cwd }, { name: "root_agent", kind: "root", pty: true, cwd: repoAsLaunched(workspace) });
  assert.equal(env.CCDM_SESSION_NAME, "root_agent");
  assert.equal(env.CCDM_ROUTER_KEY_FILE, files.key);
  assert.equal("CCDM_DETACHED" in env, false);
  const status = await runRouterCli(workspace, ["status"]);
  assert.match(status.stdout, /sessions: 1\n  root root scope=/);
});

test("run from inside root's own session, restart-root exits 0 at once and a detached copy outside the old root's Job brings a new root to its Router hello", async () => {
  const workspace = createRouterWorkspace();
  await startRouter(workspace);
  const files = rootFiles(workspace);
  const first = await restartRoot(workspace, { backend: "ccdm-host" });
  assert.equal(first.exitCode, 0, first.stderr || first.stdout);
  const old = rootSession(workspace);
  const oldKey = fs.readFileSync(files.key, "utf8");
  const claudeHome = path.join(workspace.homeDir, "root-claude-home");
  const log = path.join((await rootHost(workspace)).stateRoot, "logs", "restart-root-root_agent.log");

  const handedOff = await restartRoot(workspace, {
    backend: "ccdm-host",
    env: { CCDM_SESSION_NAME: "root_agent", CLAUDE_CONFIG_DIR: claudeHome },
  });

  assert.equal(handedOff.exitCode, 0, handedOff.stderr || handedOff.stdout);
  assert.match(handedOff.stdout, /^ccdm: restart-root continues in a detached process \(pid \d+\); log: .*restart-root-root_agent\.log\s*$/);
  const done = await waitForState(workspace, (next) => {
    const session = next.fixtures.tmux.sessions.root_agent;
    return session && session.pid !== old.pid && session.devChannelPrompt === "accepted";
  }, 30000);
  for (let waited = 0; !/Restarted root agent in/.test(fs.readFileSync(log, "utf8")); waited += WAIT_STEP_MS) {
    assert.ok(waited < 30000, `the detached copy never finished: ${fs.readFileSync(log, "utf8")}`);
    await sleep(WAIT_STEP_MS);
  }
  const helpers = done.fixtures.sessionHost.detached;
  assert.equal(helpers.length, 1);
  const [helper] = helpers;
  assert.equal(old.job.includes(helper.pid), false, "the helper was never in the old root's Job");
  assert.equal(helper.argv.at(-1), "restart-root");
  assert.equal(helper.log, log);
  assert.equal(helper.env.CCDM_DETACHED, "1");
  assert.equal("CCDM_SESSION_NAME" in helper.env, false);
  assert.equal(helper.env.CCDM_ROUTER_STATE_DIR, workspace.routerStateDir);
  assert.equal(helper.env.CLAUDE_CONFIG_DIR, claudeHome, "root comes back on the same account");
  await waitUntilGone(old.job);
  assert.notEqual(fs.readFileSync(files.key, "utf8"), oldKey);
  const launch = hostOps(workspace).filter(call => call.op === "new").at(-1);
  assert.equal(launch.env.CCDM_SESSION_NAME, "root_agent");
  assert.equal(launch.env.CLAUDE_CONFIG_DIR, claudeHome);
  assert.equal("CCDM_DETACHED" in launch.env, false, "the new root can hand off its own restart again");
  assert.equal(JSON.parse(fs.readFileSync(files.ready, "utf8")).ok, true);
  const status = await runRouterCli(workspace, ["status"]);
  assert.match(status.stdout, /sessions: 1\n  root root scope=/);
});

test("with the Router down, restart-root refuses with today's message, also from inside root, and the running root and its key stay", async () => {
  const workspace = createRouterWorkspace();
  const files = rootFiles(workspace);
  const rootPid = spawnBystander();
  seedTmuxSession("root_agent", { pid: rootPid, job: [rootPid] }, { stateDir: workspace.stateDir });
  writePrivate(files.key, "the running root's key\n");

  for (const env of [{}, { CCDM_SESSION_NAME: "root_agent" }]) {
    const result = await restartRoot(workspace, { env });

    assert.equal(result.exitCode, 1, result.stdout);
    assert.match(result.stderr, /The Router is not answering, so root was not restarted: the running root and its key are unchanged\. Start the Router \(.*, or node scripts\/router\.js serve\) and retry\./);
    assert.equal(result.stdout, "");
  }
  assert.deepEqual(changes(workspace), [], "nothing was stopped, started or handed off");
  assert.equal(rootSession(workspace).pid, rootPid);
  assert.equal(isAlive(rootPid), true);
  assert.equal(fs.readFileSync(files.key, "utf8"), "the running root's key\n");
});

for (const backend of ROOT_BACKENDS) {
  test(`${backend}: a root launch in an untrusted repo folder accepts the folder-trust prompt without help and reaches the Router`, async () => {
    const workspace = createRouterWorkspace();
    await startRouter(workspace);
    updateState(workspace.stateDir, (state) => { state.fixtures.claude.trustPrompt = true; });

    const result = await restartRoot(workspace, { backend });

    assert.equal(result.exitCode, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Root channel server connected to the Router/);
    const session = rootSession(workspace);
    assert.equal(session.cwd, repoAsLaunched(workspace), "the folder trusted is the repo root it launched in");
    assert.deepEqual(session.sendKeys, [["Enter"], ["Enter"]]);
    assert.equal(session.trustPrompt, "accepted");
    assert.equal(session.devChannelPrompt, "accepted");
  });

  test(`${backend}: an already-trusted root launch accepts the channel prompt within 1 s of it appearing`, async () => {
    const workspace = createRouterWorkspace();
    await startRouter(workspace);
    updateState(workspace.stateDir, (state) => { state.fixtures.tmux.devChannelPrompt = "never"; });

    const running = restartRoot(workspace, { backend });
    await waitForState(workspace, next => Boolean(next.fixtures.tmux.sessions.root_agent), 20000);
    await sleep(800);
    assert.equal(rootSession(workspace).sendKeys, undefined, "no key is sent before a prompt is on screen");
    const appeared = performance.now();
    updateState(workspace.stateDir, (state) => {
      Object.assign(state.fixtures.tmux.sessions.root_agent, { paneOutput: ROOT_PROMPT_SCREEN, devChannelPrompt: "pending" });
    });
    while (!rootSession(workspace).sendKeys) {
      assert.ok(performance.now() - appeared < 1000, "Enter was not sent within 1 s of the channel prompt");
      await sleep(20);
    }
    const result = await running;

    assert.equal(result.exitCode, 0, result.stderr || result.stdout);
    assert.deepEqual(rootSession(workspace).sendKeys, [["Enter"]]);
  });
}

test("a root restart run as the detached copy starts root without CCDM_DETACHED", platformGate("posix", TMUX_INHERITS), async () => {
  const workspace = createRouterWorkspace();
  await startRouter(workspace);

  const result = await restartRoot(workspace, { backend: "tmux", env: { CCDM_DETACHED: "1" } });

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  // Root with the variable could not hand off its own next restart.
  const environments = readState(workspace.stateDir).fixtures.claude.sessionEnvironments;
  assert.deepEqual(environments.map(({ process: name }) => name), ["claude", "ccdm"]);
  for (const { process: name, env } of environments) {
    assert.equal("CCDM_DETACHED" in env, false, `${name} was started with CCDM_DETACHED`);
  }
});

test("root's launch settings carry the statusLine command on Windows and are unchanged elsewhere", async () => {
  const workspace = createRouterWorkspace();
  await startRouter(workspace);

  const result = await restartRoot(workspace);

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  const files = rootFiles(workspace);
  const settings = JSON.parse(fs.readFileSync(files.settings, "utf8"));
  assert.deepEqual(settings.enabledPlugins, { "discord@claude-plugins-official": false });
  if (WIN) {
    const script = path.join(repoAsLaunched(workspace), "scripts", "statusline-context.js").replaceAll("\\", "/");
    assert.deepEqual(settings.statusLine, { type: "command", command: `node '${script}'` });
  } else {
    assert.deepEqual(Object.keys(settings), ["enabledPlugins"]);
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(files.mcp, "utf8")).mcpServers.ccdm.args, channelServerArgs(workspace));
});

test("on Windows, restart-root --provider codex is refused with a message naming the pending decision, and nothing changes", platformGate("win32", "the refusal is Windows-only; root Codex runs on Linux and macOS"), async () => {
  const workspace = createRouterWorkspace();
  await startRouter(workspace);
  seedRootCodexFiles(workspace);
  const files = rootFiles(workspace);
  const rootPid = spawnBystander();
  seedTmuxSession("root_agent", { pid: rootPid, job: [rootPid] }, { stateDir: workspace.stateDir });
  writePrivate(files.key, "the running root's key\n");

  for (const [script, args] of [
    ["restart-root-codex-agent.sh", ["root-channel-id"]],
    ["scripts/ccdm", ["restart-root", "--provider", "codex", "root-channel-id"]],
  ]) {
    const result = await restartRoot(workspace, { script, args });

    assert.equal(result.exitCode, 1, `${script}: ${result.stdout}`);
    assert.match(result.stderr, /^Root Codex is not available on Windows yet: the Windows root is Claude-only until the owner's decision on a Codex root there \(D2\) is made\./);
    assert.equal(result.stdout, "");
  }
  assert.deepEqual(changes(workspace), []);
  assert.equal(isAlive(rootPid), true);
  assert.equal(fs.readFileSync(files.key, "utf8"), "the running root's key\n");
});

test("the root restart shims and scripts/ccdm restart-root give the same output and exit codes", async () => {
  const workspace = createRouterWorkspace();
  const viaBoth = async (shim, shimArgs, commandArgs) => {
    const viaShim = await restartRoot(workspace, { script: shim, args: shimArgs });
    const viaCommand = await restartRoot(workspace, { script: "scripts/ccdm", args: commandArgs });
    const label = `${shim} ${shimArgs.join(" ")}`;
    assert.equal(viaCommand.exitCode, viaShim.exitCode, label);
    assert.equal(viaCommand.stdout, viaShim.stdout, label);
    assert.equal(viaCommand.stderr, viaShim.stderr, label);
    return viaShim;
  };

  for (const [shim, provider] of [["restart-root-agent.sh", []], ["restart-root-codex-agent.sh", ["--provider", "codex"]]]) {
    const help = await viaBoth(shim, ["--help"], ["restart-root", ...provider, "--help"]);
    assert.equal(help.exitCode, 0, help.stderr);
    assert.match(help.stdout, /usage: ccdm restart-root/);
  }
  const channelForClaude = await viaBoth("restart-root-agent.sh", ["root-channel-id"], ["restart-root", "root-channel-id"]);
  assert.equal(channelForClaude.exitCode, 2);
  assert.match(channelForClaude.stderr, /a channel is only for root Codex: add --provider codex/);
  // No Router is running in this workspace.
  const routerDown = await viaBoth("restart-root-agent.sh", [], ["restart-root"]);
  assert.equal(routerDown.exitCode, 1);
  assert.match(routerDown.stderr, /The Router is not answering, so root was not restarted/);
  const codex = await viaBoth("restart-root-codex-agent.sh", ["missing-channel"], ["restart-root", "--provider", "codex", "missing-channel"]);
  assert.equal(codex.exitCode, 1);
  assert.match(codex.stderr, WIN ? /Root Codex is not available on Windows yet/ : /No root_channels in .*registry\.json\./);
  assert.deepEqual(changes(workspace), []);
  assert.equal(fs.existsSync(rootFiles(workspace).key), false);
});

test("no nohup or shell string is left in the root restart paths", () => {
  const workspace = createWorkspace();
  for (const file of [
    "restart-root-agent.sh",
    "restart-root-codex-agent.sh",
    "scripts/ccdmlib/cli/restart_root.py",
    "scripts/ccdmlib/cli/_detach.py",
    "scripts/lib/restart-helper.js",
    "scripts/codex-bridge.js",
  ]) {
    const source = fs.readFileSync(path.join(workspace.repoDir, file), "utf8");
    assert.doesNotMatch(source, /\bnohup\b|["']\/bin\/sh["']|\bsh\s+-c\b|\bzsh\s+-ic\b/, file);
  }
  for (const shim of ["restart-root-agent.sh", "restart-root-codex-agent.sh"]) {
    const lines = fs.readFileSync(path.join(workspace.repoDir, shim), "utf8").split("\n").filter(line => line && !line.startsWith("#"));
    assert.equal(lines.length, 1, shim);
    assert.match(lines[0], /^exec "\$\(cd "\$\(dirname "\$0"\)" && pwd\)\/scripts\/ccdm" restart-root /, shim);
  }
});
