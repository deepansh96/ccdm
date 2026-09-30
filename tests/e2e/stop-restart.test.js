import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { startFakeCodexServer } from "./support/bridge.js";
import { createRouterWorkspace, routerEnv, startRouter } from "./support/router.js";
import { createWorkspace, runScript } from "./support/runner.js";
import { readState, seedFixtureProcess, seedRegistry, seedTmuxSession, writeState } from "./support/state.js";
import { cleanup, registerTeardownCallback } from "./support/teardown.js";

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
  const child = spawn(process.execPath, ["-e", script], {
    detached: true,
    env: {
      CCDM_TEST_STATE: workspace.stateDir,
    },
    stdio: "ignore",
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
  return runScript(workspace, "scripts/stop-session.sh", { args: ["alpha"] });
}

test("sleep fixture resolves fixture-mode delays quickly", () => {
  const workspace = createWorkspace();
  const started = performance.now();

  const result = runFixture(workspace, "sleep", ["8"]);

  assert.equal(result.status, 0, result.stderr);
  assert.ok(performance.now() - started < 100);
});

test("stop-session stops a Claude session and clears registry metadata", async () => {
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

test("stop-session stops a Codex bridge session from seeded registry and process state", async () => {
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
  assert.match(result.stdout, /No active tmux session 'alpha_session' found/);
  assert.match(result.stdout, /Stopped Discord session 'alpha'/);
  assert.equal(readRegistry(workspace).projects.alpha.pid, null);
});

test("stop-session sweeps orphan Claude and Codex listener processes", async () => {
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

test("during cutover, stop-session also sweeps a legacy pool Claude listener for the project's former pool bot", async () => {
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

test("stop-session sweeps an orphaned CCDM channel server and removes the launch key", async () => {
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

test("stop-session escalates SIGTERM-resistant child processes to SIGKILL", async () => {
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

test("restart-root-agent simulates root_agent cleanup, retry, fresh launch, and development-channel send-key", async () => {
  const workspace = createRouterWorkspace();
  await startRouter(workspace);
  const panePid = spawnOwnedProcess(workspace, "zsh root pane");
  const childPid = spawnOwnedProcess(workspace, "claude root child", { ppid: panePid });
  seedTmuxSession(
    "root_agent",
    { panePid, killFailuresRemaining: 1, paneOutput: "old root\n" },
    { stateDir: workspace.stateDir },
  );

  const result = await runScript(workspace, "restart-root-agent.sh", { env: routerEnv(workspace) });

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

  const result = await runScript(workspace, "restart-root-agent.sh", {
    env: routerEnv(workspace, {
      CCDM_CLAUDE_REMINDER_ADAPTER: "1",
      ROOT_DISCORD_STATE_DIR: selectedState,
      CCDM_FIXTURE_CLAUDE_VERSION: "1.0.0 (Claude Code fixture)",
    }),
  });

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Root channel server connected to the Router/);
  const session = readState(workspace.stateDir).fixtures.tmux.sessions.root_agent;
  assert.match(session.shellCommand, /--dangerously-load-development-channels server:ccdm/);
  assert.equal(session.env.CCDM_ROUTER_KEY_FILE, path.join(workspace.routerStateDir, "keys", ".root.key"));
  for (const forbidden of ["DISCORD_STATE_DIR", "plugin:discord", "server:discord"]) {
    assert.equal(session.shellCommand.includes(forbidden), false, forbidden);
  }
  const config = JSON.parse(fs.readFileSync(path.join(workspace.routerStateDir, "launches", ".root", "mcp.json"), "utf8"));
  assert.deepEqual(Object.keys(config.mcpServers), ["ccdm"]);
  assert.deepEqual(config.mcpServers.ccdm.args, [path.join(workspace.repoDir, "scripts", "ccdm-channel-server.js")]);
  assert.equal(fs.existsSync(selectedState), false);
  assert.equal(fs.existsSync(path.join(workspace.homeDir, ".claude", "channels", "discord", "ccdm-root-reminder-mcp.json")), false);
});

test("restart-root-codex-agent starts the root bot through the Codex bridge in Router root mode", async () => {
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
  });
  assert.equal(session.bridgeCommand, "node scripts/codex-bridge.js");
  assert.equal(session.killAttempts, 2);
});

test("restart-root-codex-agent uses the Default Codex Account when no emergency override is set", async () => {
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
  });

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.equal(readState(workspace.stateDir).fixtures.tmux.sessions.root_agent.env.CODEX_HOME, defaultAccountHome);
});

test("restart-root-codex-agent rejects malformed global named-account selectors before teardown", async () => {
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

test("restart-root-codex-agent rejects an unknown Default Codex Account before root teardown", async () => {
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

test("restart-root-codex-agent rejects a Default Codex Account and Legacy Codex Home conflict", async () => {
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

test("restart-root-codex-agent keeps ROOT_CODEX_HOME above the shared home", async () => {
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
  });

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.equal(readState(workspace.stateDir).fixtures.tmux.sessions.root_agent.env.CODEX_HOME, rootHome);
});

test("restart-root-codex-agent validates the selected home before tearing down root_agent", async () => {
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

test("restart-root-codex-agent rejects every invalid selected home before root teardown", async () => {
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

test("restart-root-codex-agent uses ambient CODEX_HOME when the registry has no home", async () => {
  const workspace = createRouterWorkspace();
  const ambientHome = path.join(workspace.homeDir, ".codex-ambient");
  fs.mkdirSync(ambientHome, { recursive: true });
  seedRegistry(workspace, buildRegistry(workspace));
  seedRootCodexFiles(workspace);

  const result = await runScript(workspace, "restart-root-codex-agent.sh", {
    args: ["root-channel-id"],
    env: await rootCodexRouterEnv(workspace, { CODEX_HOME: ambientHome }),
  });

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.equal(readState(workspace.stateDir).fixtures.tmux.sessions.root_agent.env.CODEX_HOME, ambientHome);
});

test("restart-root-codex-agent lets ROOT_CODEX_HOME recover from a broken registry home", async () => {
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
  });

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.equal(readState(workspace.stateDir).fixtures.tmux.sessions.root_agent.env.CODEX_HOME, rootHome);
});

test("restart-root-codex-agent re-reads the registry home on every restart", async () => {
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
  });
  assert.equal(firstResult.exitCode, 0, firstResult.stderr || firstResult.stdout);
  assert.equal(readState(workspace.stateDir).fixtures.tmux.sessions.root_agent.env.CODEX_HOME, firstHome);

  registry.default_codex_account = "second";
  registry.root_channels = ["root-channel-id"];
  fs.writeFileSync(path.join(workspace.repoDir, "registry.json"), `${JSON.stringify(registry, null, 2)}\n`);

  const secondResult = await runScript(workspace, "restart-root-codex-agent.sh", {
    args: ["root-channel-id"],
    env,
  });
  assert.equal(secondResult.exitCode, 0, secondResult.stderr || secondResult.stdout);
  assert.equal(readState(workspace.stateDir).fixtures.tmux.sessions.root_agent.env.CODEX_HOME, secondHome);
});

test("restart-root-codex-agent keeps the legacy default without home overrides", async () => {
  const workspace = createRouterWorkspace();
  fs.mkdirSync(path.join(workspace.homeDir, ".codex"), { recursive: true });
  seedRegistry(workspace, buildRegistry(workspace));
  seedRootCodexFiles(workspace);

  const result = await runScript(workspace, "restart-root-codex-agent.sh", {
    args: ["root-channel-id"],
    env: await rootCodexRouterEnv(workspace),
  });

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.equal(
    readState(workspace.stateDir).fixtures.tmux.sessions.root_agent.env.CODEX_HOME,
    path.join(workspace.homeDir, ".codex"),
  );
});

test("restart-root-codex-agent rejects a channel missing from the registry's root channels before stopping the current root", async () => {
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
  const workspace = createWorkspace();
  const state = readState(workspace.stateDir);
  state.fixtures.tmux.newSessionFailures = { root_agent: 1 };
  writeState(state, workspace.stateDir);

  const result = await runScript(workspace, "restart-root-agent.sh");

  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /Failed to create tmux session 'root_agent'|fixture tmux new-session failure/);
  assert.deepEqual(result.diagnostics.command, [path.join(workspace.repoDir, "restart-root-agent.sh")]);
  assert.equal(result.diagnostics.fixtureState.fixtures.tmux.newSessionFailures.root_agent, 0);
});

test("restart-root-agent teardown failures are recorded as diagnostics", async () => {
  const workspace = createRouterWorkspace();
  await startRouter(workspace);
  registerTeardownCallback(() => {
    throw new Error("restart cleanup failure");
  });

  const result = await runScript(workspace, "restart-root-agent.sh", { env: routerEnv(workspace) });

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  await cleanup({ stateDir: workspace.stateDir });
  assert.match(JSON.stringify(readState(workspace.stateDir).diagnostics.cleanupFailures), /restart cleanup failure/);
});
