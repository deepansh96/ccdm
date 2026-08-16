import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

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
  const project = {
    path: path.join(workspace.tmpDir, "alpha project"),
    bot_id: "bot2",
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
    max_pool_size: 50,
    project_bot_role_id: null,
    category_ids: [],
    ...(overrides.codexHome ? { codex_home: overrides.codexHome } : {}),
    pool: [
      {
        id: "bot1",
        app_id: "root-app-id",
        token: "root-token",
        state_dir: path.join(workspace.homeDir, ".claude", "channels", "discord"),
        assigned_to: null,
      },
      {
        id: "bot2",
        app_id: "bot-app-id",
        token: "bot-token",
        state_dir: path.join(workspace.homeDir, ".claude", "channels", "discord2"),
        assigned_to: "alpha",
      },
    ],
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

function claudeCommand(registry) {
  const stateDir = registry.pool.find((bot) => bot.id === "bot2").state_dir;
  return `claude --channels plugin:discord@claude-plugins-official --dangerously-skip-permissions DISCORD_STATE_DIR='${stateDir}'`;
}

function codexBridgeCommand() {
  return "node scripts/codex-bridge.js CHANNEL_ID='channel-id' BOT_APP_ID='bot-app-id' WS_PORT='18342'";
}

function codexAppServerCommand() {
  return "codex app-server --listen ws://127.0.0.1:18342";
}

function seedRootCodexFiles(workspace) {
  const rootStateDir = path.join(workspace.homeDir, ".claude", "channels", "discord");
  fs.mkdirSync(rootStateDir, { recursive: true });
  fs.writeFileSync(path.join(rootStateDir, ".env"), "DISCORD_BOT_TOKEN=cm9vdC1hcHA.fixture.token\n");
  fs.writeFileSync(path.join(rootStateDir, "access.json"), `${JSON.stringify({
    groups: { "root-channel-id": { requireMention: false } },
  })}\n`);
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
  const pid = spawnOwnedProcess(workspace, claudeCommand(registry));
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
  const claudePid = spawnOwnedProcess(claudeWorkspace, claudeCommand(claudeRegistry));
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

test("stop-session escalates SIGTERM-resistant child processes to SIGKILL", async () => {
  const workspace = createWorkspace();
  const registry = buildRegistry(workspace);
  const parentPid = spawnOwnedProcess(workspace, claudeCommand(registry));
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
  delete registry.pool[1].app_id;
  const orphanPid = spawnOwnedProcess(workspace, codexBridgeCommand());
  seedRegistry(workspace, registry);

  const result = await stopProject(workspace);

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.match(result.stderr, /Skipping Codex listener sweep/);
  assert.equal(isAlive(orphanPid), true);
});

test("restart-root-agent simulates root_agent cleanup, retry, fresh launch, and trust-dialog send-key", async () => {
  const workspace = createWorkspace();
  const panePid = spawnOwnedProcess(workspace, "zsh root pane");
  const childPid = spawnOwnedProcess(workspace, "claude root child", { ppid: panePid });
  seedTmuxSession(
    "root_agent",
    { panePid, killFailuresRemaining: 1, paneOutput: "old root\n" },
    { stateDir: workspace.stateDir },
  );

  const result = await runScript(workspace, "restart-root-agent.sh");

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Restarted root agent in tmux session 'root_agent'/);
  assert.equal(isAlive(childPid), false);
  const session = readState(workspace.stateDir).fixtures.tmux.sessions.root_agent;
  assert.equal(session.cwd, workspace.repoDir);
  assert.equal(session.env.DISCORD_STATE_DIR, "~/.claude/channels/discord");
  assert.deepEqual(session.sendKeys, [["Enter"]]);
  assert.equal(session.killAttempts, 2);
});

test("restart-root-codex-agent starts the root bot through the Codex bridge", async () => {
  const workspace = createWorkspace();
  const codexHome = path.join(workspace.homeDir, ".codex-ccdm");
  fs.mkdirSync(codexHome, { recursive: true });
  seedRegistry(workspace, buildRegistry(workspace, { codexHome }));
  const rootStateDir = path.join(workspace.homeDir, ".claude", "channels", "discord");
  fs.mkdirSync(rootStateDir, { recursive: true });
  fs.writeFileSync(path.join(rootStateDir, ".env"), "DISCORD_BOT_TOKEN=cm9vdC1hcHA.fixture.token\n");
  fs.writeFileSync(path.join(rootStateDir, "access.json"), `${JSON.stringify({
    allowFrom: ["global-user-id"],
    groups: {
      "root-channel-id": { requireMention: false, allowFrom: ["channel-only-user-id"] },
    },
  })}\n`);
  const panePid = spawnOwnedProcess(workspace, "zsh root pane");
  const childPid = spawnOwnedProcess(workspace, "claude root child", { ppid: panePid });
  const orphanBridgePid = spawnOwnedProcess(
    workspace,
    "node scripts/codex-bridge.js BOT_APP_ID='root-app' WS_PORT='18399'",
  );
  const orphanAppServerPid = spawnOwnedProcess(
    workspace,
    "codex app-server --listen ws://127.0.0.1:18399",
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

  const result = await runScript(workspace, "restart-root-codex-agent.sh", {
    args: ["root-channel-id"],
    env: { CODEX_HOME: path.join(workspace.homeDir, ".codex-legacy") },
  });

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
    BOT_DISPLAY_NAME: "root-codex",
    BOT_TOKEN: "cm9vdC1hcHA.fixture.token",
    CHANNEL_ID: "root-channel-id",
    CODEX_HOME: codexHome,
    GUILD_ID: "guild-id",
    PROJECT_DIR: workspace.repoDir,
    ROOT_ACCESS_FILE: path.join(rootStateDir, "access.json"),
    ROOT_BOT_APP_ID: "root-app",
    ROOT_BOT_TOKEN: "cm9vdC1hcHA.fixture.token",
    ROOT_MULTI_CHANNEL: "1",
    WS_PORT: "18399",
  });
  assert.equal(session.bridgeCommand, "node scripts/codex-bridge.js");
  assert.equal(session.killAttempts, 2);
});

test("restart-root-codex-agent keeps ROOT_CODEX_HOME above the shared home", async () => {
  const workspace = createWorkspace();
  const rootHome = path.join(workspace.homeDir, ".codex-root");
  fs.mkdirSync(rootHome, { recursive: true });
  seedRegistry(workspace, buildRegistry(workspace, {
    codexHome: path.join(workspace.homeDir, ".codex-ccdm"),
  }));
  const rootStateDir = path.join(workspace.homeDir, ".claude", "channels", "discord");
  fs.mkdirSync(rootStateDir, { recursive: true });
  fs.writeFileSync(path.join(rootStateDir, ".env"), "DISCORD_BOT_TOKEN=cm9vdC1hcHA.fixture.token\n");
  fs.writeFileSync(path.join(rootStateDir, "access.json"), `${JSON.stringify({
    allowFrom: [],
    groups: { "root-channel-id": { requireMention: false } },
  })}\n`);

  const result = await runScript(workspace, "restart-root-codex-agent.sh", {
    args: ["root-channel-id"],
    env: { ROOT_CODEX_HOME: rootHome },
  });

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.equal(readState(workspace.stateDir).fixtures.tmux.sessions.root_agent.env.CODEX_HOME, rootHome);
});

test("restart-root-codex-agent validates the selected home before tearing down root_agent", async () => {
  const workspace = createWorkspace();
  const missingHome = path.join(workspace.homeDir, ".missing-root-codex");
  seedRegistry(workspace, buildRegistry(workspace, { codexHome: missingHome }));
  const rootStateDir = path.join(workspace.homeDir, ".claude", "channels", "discord");
  fs.mkdirSync(rootStateDir, { recursive: true });
  fs.writeFileSync(path.join(rootStateDir, ".env"), "DISCORD_BOT_TOKEN=cm9vdC1hcHA.fixture.token\n");
  fs.writeFileSync(path.join(rootStateDir, "access.json"), `${JSON.stringify({
    groups: { "root-channel-id": { requireMention: false } },
  })}\n`);
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
  const workspace = createWorkspace();
  const ambientHome = path.join(workspace.homeDir, ".codex-ambient");
  fs.mkdirSync(ambientHome, { recursive: true });
  seedRegistry(workspace, buildRegistry(workspace));
  seedRootCodexFiles(workspace);

  const result = await runScript(workspace, "restart-root-codex-agent.sh", {
    args: ["root-channel-id"],
    env: { CODEX_HOME: ambientHome },
  });

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.equal(readState(workspace.stateDir).fixtures.tmux.sessions.root_agent.env.CODEX_HOME, ambientHome);
});

test("restart-root-codex-agent lets ROOT_CODEX_HOME recover from a broken registry home", async () => {
  const workspace = createWorkspace();
  const rootHome = path.join(workspace.homeDir, ".codex-emergency");
  fs.mkdirSync(rootHome, { recursive: true });
  const registry = buildRegistry(workspace);
  registry.codex_home = path.join(workspace.homeDir, ".broken-registry-codex");
  seedRegistry(workspace, registry);
  seedRootCodexFiles(workspace);

  const result = await runScript(workspace, "restart-root-codex-agent.sh", {
    args: ["root-channel-id"],
    env: { ROOT_CODEX_HOME: rootHome },
  });

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.equal(readState(workspace.stateDir).fixtures.tmux.sessions.root_agent.env.CODEX_HOME, rootHome);
});

test("restart-root-codex-agent re-reads the registry home on every restart", async () => {
  const workspace = createWorkspace();
  const firstHome = path.join(workspace.homeDir, ".codex-first");
  const secondHome = path.join(workspace.homeDir, ".codex-second");
  fs.mkdirSync(firstHome, { recursive: true });
  fs.mkdirSync(secondHome, { recursive: true });
  const registry = buildRegistry(workspace, { codexHome: firstHome });
  seedRegistry(workspace, registry);
  seedRootCodexFiles(workspace);

  const firstResult = await runScript(workspace, "restart-root-codex-agent.sh", {
    args: ["root-channel-id"],
  });
  assert.equal(firstResult.exitCode, 0, firstResult.stderr || firstResult.stdout);
  assert.equal(readState(workspace.stateDir).fixtures.tmux.sessions.root_agent.env.CODEX_HOME, firstHome);

  registry.codex_home = secondHome;
  fs.writeFileSync(path.join(workspace.repoDir, "registry.json"), `${JSON.stringify(registry, null, 2)}\n`);

  const secondResult = await runScript(workspace, "restart-root-codex-agent.sh", {
    args: ["root-channel-id"],
  });
  assert.equal(secondResult.exitCode, 0, secondResult.stderr || secondResult.stdout);
  assert.equal(readState(workspace.stateDir).fixtures.tmux.sessions.root_agent.env.CODEX_HOME, secondHome);
});

test("restart-root-codex-agent keeps the legacy default without home overrides", async () => {
  const workspace = createWorkspace();
  fs.mkdirSync(path.join(workspace.homeDir, ".codex"), { recursive: true });
  seedRegistry(workspace, buildRegistry(workspace));
  const rootStateDir = path.join(workspace.homeDir, ".claude", "channels", "discord");
  fs.mkdirSync(rootStateDir, { recursive: true });
  fs.writeFileSync(path.join(rootStateDir, ".env"), "DISCORD_BOT_TOKEN=cm9vdC1hcHA.fixture.token\n");
  fs.writeFileSync(path.join(rootStateDir, "access.json"), `${JSON.stringify({
    allowFrom: [],
    groups: { "root-channel-id": { requireMention: false } },
  })}\n`);

  const result = await runScript(workspace, "restart-root-codex-agent.sh", {
    args: ["root-channel-id"],
  });

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.equal(
    readState(workspace.stateDir).fixtures.tmux.sessions.root_agent.env.CODEX_HOME,
    path.join(workspace.homeDir, ".codex"),
  );
});

test("restart-root-codex-agent rejects an unconfigured channel before stopping the current root", async () => {
  const workspace = createWorkspace();
  seedRegistry(workspace, buildRegistry(workspace));
  const rootStateDir = path.join(workspace.homeDir, ".claude", "channels", "discord");
  fs.mkdirSync(rootStateDir, { recursive: true });
  fs.writeFileSync(path.join(rootStateDir, "access.json"), `${JSON.stringify({
    groups: { "configured-channel": { requireMention: false } },
  })}\n`);
  const panePid = spawnOwnedProcess(workspace, "zsh root pane");
  const childPid = spawnOwnedProcess(workspace, "claude root child", { ppid: panePid });
  seedTmuxSession("root_agent", { panePid, paneOutput: "old root\n" }, { stateDir: workspace.stateDir });

  const result = await runScript(workspace, "restart-root-codex-agent.sh", {
    args: ["missing-channel"],
  });

  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /Root channel missing-channel is not configured as a no-mention channel/);
  assert.ok(readState(workspace.stateDir).fixtures.tmux.sessions.root_agent);
  assert.equal(isAlive(childPid), true);

  fs.writeFileSync(path.join(rootStateDir, "access.json"), `${JSON.stringify({
    groups: { "missing-channel": { requireMention: true } },
  })}\n`);
  const mentionedResult = await runScript(workspace, "restart-root-codex-agent.sh", {
    args: ["missing-channel"],
  });
  assert.notEqual(mentionedResult.exitCode, 0);
  assert.match(mentionedResult.stderr, /requireMention set to false/);
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
  const workspace = createWorkspace();
  registerTeardownCallback(() => {
    throw new Error("restart cleanup failure");
  });

  const result = await runScript(workspace, "restart-root-agent.sh");

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  await cleanup({ stateDir: workspace.stateDir });
  assert.match(JSON.stringify(readState(workspace.stateDir).diagnostics.cleanupFailures), /restart cleanup failure/);
});
