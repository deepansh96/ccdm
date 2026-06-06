import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { createWorkspace, runScript } from "./support/runner.js";
import { readState, seedFixtureProcess, seedRegistry, seedTmuxSession } from "./support/state.js";
import { cleanup, registerTeardownCallback } from "./support/teardown.js";

test.afterEach(async () => {
  await cleanup();
});

function buildCodexRegistry(workspace, options = {}) {
  const projectPath = options.projectPath ?? path.join(workspace.tmpDir, 'project with spaces and "quotes"');
  const stateDir = options.stateDir ?? path.join(workspace.homeDir, ".claude", "channels", "discord2");
  return {
    discord_user_id: "allowed-user-id",
    guild_id: "guild-id",
    max_pool_size: 50,
    project_bot_role_id: null,
    category_ids: [],
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
        state_dir: stateDir,
        assigned_to: "alpha",
      },
      ...(options.extraPool ?? []),
    ],
    projects: {
      alpha: {
        path: projectPath,
        bot_id: "bot2",
        screen_name: "alpha_codex",
        channel_id: "channel-id",
        type: "codex",
        ws_port: 18342,
        session_id: null,
        pid: null,
      },
      ...(options.extraProjects ?? {}),
    },
  };
}

function readRegistry(workspace) {
  return JSON.parse(fs.readFileSync(path.join(workspace.repoDir, "registry.json"), "utf8"));
}

function seedOwnedProcess(workspace, command) {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true,
    env: {
      CCDM_TEST_STATE: workspace.stateDir,
    },
    stdio: "ignore",
  });
  child.unref();
  registerTeardownCallback(() => {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      // The process group may already be gone.
    }
    try {
      process.kill(child.pid, "SIGTERM");
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
      ppid: process.pid,
    },
    { stateDir: workspace.stateDir },
  );
  return child.pid;
}

function runFixture(workspace, tool, args) {
  return spawnSync(path.join(workspace.fixtureDir, tool), args, {
    cwd: workspace.repoDir,
    encoding: "utf8",
    env: workspace.env,
  });
}

function listRelativeFiles(root, relative = "") {
  const absolute = path.join(root, relative);
  if (!fs.existsSync(absolute)) {
    return [];
  }
  const stat = fs.statSync(absolute);
  if (stat.isFile()) {
    return [relative];
  }
  if (!stat.isDirectory()) {
    return [];
  }
  return fs.readdirSync(absolute).flatMap((entry) => listRelativeFiles(root, path.join(relative, entry))).sort();
}

test("npm fixture fails closed when a scenario tries to run package installation", () => {
  const workspace = createWorkspace();

  const result = runFixture(workspace, "npm", ["ci"]);

  assert.equal(result.status, 42);
  assert.match(result.stderr, /npm fixture blocks package-manager execution/);
  assert.deepEqual(readState(workspace.stateDir).fixtures.npm.invocations[0].args, ["ci"]);
});

test("start-codex-session constructs a bridge tmux launch, removes stale MCP config, and records PID", async () => {
  const workspace = createWorkspace();
  const registrySeed = buildCodexRegistry(workspace);
  seedRegistry(workspace, registrySeed);
  const codexDir = path.join(workspace.homeDir, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  fs.writeFileSync(
    path.join(codexDir, "config.toml"),
    [
      'model = "gpt-5"',
      "",
      "[mcp_servers.discord-channel-id]",
      'command = "node"',
      'args = ["scripts/discord-mcp-server.js"]',
      "",
      "[mcp_servers.keep]",
      'command = "keep"',
      "",
    ].join("\n"),
  );

  const beforeInventory = listRelativeFiles(workspace.repoDir);
  const result = await runScript(workspace, "scripts/start-codex-session.sh", {
    args: ["alpha"],
  });
  const afterInventory = listRelativeFiles(workspace.repoDir);

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Started Codex bridge in tmux session 'alpha_codex'/);
  assert.match(result.stdout, /Recorded PID \d+/);
  assert.deepEqual(afterInventory, beforeInventory);

  const config = fs.readFileSync(path.join(codexDir, "config.toml"), "utf8");
  assert.match(config, /\[mcp_servers\.keep\]/);
  assert.doesNotMatch(config, /discord-channel-id/);

  const registry = readRegistry(workspace);
  assert.equal(typeof registry.projects.alpha.pid, "number");
  assert.equal(registry.projects.alpha.session_id, null);

  const state = readState(workspace.stateDir);
  const session = state.fixtures.tmux.sessions.alpha_codex;
  assert.equal(session.cwd, workspace.repoDir);
  assert.deepEqual(session.env, {
    ALLOWED_USER_ID: registrySeed.discord_user_id,
    BOT_APP_ID: registrySeed.pool[1].app_id,
    BOT_DISPLAY_NAME: "bot2-alpha-codex",
    BOT_TOKEN: registrySeed.pool[1].token,
    CHANNEL_ID: registrySeed.projects.alpha.channel_id,
    GUILD_ID: registrySeed.guild_id,
    PROJECT_DIR: registrySeed.projects.alpha.path,
    ROOT_BOT_APP_ID: registrySeed.pool[0].app_id,
    ROOT_BOT_TOKEN: registrySeed.pool[0].token,
    WS_PORT: String(registrySeed.projects.alpha.ws_port),
  });
  assert.equal(session.bridgeCommand, "node scripts/codex-bridge.js");
  assert.equal(state.fixtures.codex.bridgeInvocations.length, 1);
  assert.equal(state.fixtures.codex.appServerInvocations.length, 0);
  assert.equal(state.fixtures.npm.invocations.length, 0);
});

test("start-codex-session exits successfully when the target tmux session is already running", async () => {
  const workspace = createWorkspace();
  seedRegistry(workspace, buildCodexRegistry(workspace));
  seedTmuxSession("alpha_codex", { paneOutput: "already running\n" }, { stateDir: workspace.stateDir });

  const result = await runScript(workspace, "scripts/start-codex-session.sh", {
    args: ["alpha"],
  });

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Session 'alpha_codex' is already running\./);
  assert.equal(readState(workspace.stateDir).fixtures.codex.bridgeInvocations.length, 0);
  assert.equal(readRegistry(workspace).projects.alpha.pid, null);
});

test("start-codex-session refuses duplicate bridge and app-server processes from fixture ps state", async () => {
  const bridgeWorkspace = createWorkspace();
  const bridgeRegistry = buildCodexRegistry(bridgeWorkspace);
  seedRegistry(bridgeWorkspace, bridgeRegistry);
  const bridgePid = seedOwnedProcess(
    bridgeWorkspace,
    "node scripts/codex-bridge.js CHANNEL_ID='channel-id' BOT_APP_ID='bot-app-id'",
  );

  const bridgeResult = await runScript(bridgeWorkspace, "scripts/start-codex-session.sh", {
    args: ["alpha"],
  });

  assert.equal(bridgeResult.exitCode, 1);
  assert.match(bridgeResult.stdout, /existing Codex Discord bridge process\(es\)/);
  assert.match(bridgeResult.stdout, new RegExp(String(bridgePid)));
  assert.equal(readState(bridgeWorkspace.stateDir).fixtures.tmux.sessions.alpha_codex, undefined);

  const appServerWorkspace = createWorkspace();
  const appServerRegistry = buildCodexRegistry(appServerWorkspace);
  seedRegistry(appServerWorkspace, appServerRegistry);
  const appServerPid = seedOwnedProcess(
    appServerWorkspace,
    "codex app-server --listen ws://127.0.0.1:18342",
  );

  const appServerResult = await runScript(appServerWorkspace, "scripts/start-codex-session.sh", {
    args: ["alpha"],
  });

  assert.equal(appServerResult.exitCode, 1);
  assert.match(appServerResult.stdout, /channel channel-id or port 18342/);
  assert.match(appServerResult.stdout, new RegExp(String(appServerPid)));
  assert.equal(readState(appServerWorkspace.stateDir).fixtures.tmux.sessions.alpha_codex, undefined);
});

test("start-codex-session reports current executable failures for registry lookup errors", async () => {
  const missingProject = createWorkspace();
  seedRegistry(missingProject, buildCodexRegistry(missingProject));
  const missingProjectResult = await runScript(missingProject, "scripts/start-codex-session.sh", {
    args: ["missing"],
  });
  assert.notEqual(missingProjectResult.exitCode, 0);
  assert.match(missingProjectResult.stderr, /KeyError: 'missing'/);

  const malformed = createWorkspace();
  fs.writeFileSync(path.join(malformed.repoDir, "registry.json"), "{ not json\n");
  const malformedResult = await runScript(malformed, "scripts/start-codex-session.sh", {
    args: ["alpha"],
  });
  assert.notEqual(malformedResult.exitCode, 0);
  assert.match(malformedResult.stderr, /JSONDecodeError/);

  const missingBot = createWorkspace();
  const missingBotRegistry = buildCodexRegistry(missingBot);
  missingBotRegistry.pool = missingBotRegistry.pool.filter((bot) => bot.id !== "bot2");
  seedRegistry(missingBot, missingBotRegistry);
  const missingBotResult = await runScript(missingBot, "scripts/start-codex-session.sh", {
    args: ["alpha"],
  });
  assert.notEqual(missingBotResult.exitCode, 0);
  assert.match(missingBotResult.stderr, /StopIteration/);

  const missingRootBot = createWorkspace();
  const missingRootBotRegistry = buildCodexRegistry(missingRootBot);
  missingRootBotRegistry.pool = missingRootBotRegistry.pool.filter((bot) => bot.id !== "bot1");
  seedRegistry(missingRootBot, missingRootBotRegistry);
  const missingRootBotResult = await runScript(missingRootBot, "scripts/start-codex-session.sh", {
    args: ["alpha"],
  });
  assert.notEqual(missingRootBotResult.exitCode, 0);
  assert.match(missingRootBotResult.stderr, /StopIteration/);
});

test("start-codex-session preserves current duplicate channel and port registry behavior", async () => {
  const workspace = createWorkspace();
  const registrySeed = buildCodexRegistry(workspace, {
    extraPool: [
      {
        id: "bot3",
        app_id: "bot-app-id-3",
        token: "bot-token-3",
        state_dir: path.join(workspace.homeDir, ".claude", "channels", "discord3"),
        assigned_to: "beta",
      },
    ],
    extraProjects: {
      beta: {
        path: path.join(workspace.tmpDir, "beta project"),
        bot_id: "bot3",
        screen_name: "beta_codex",
        channel_id: "channel-id",
        type: "codex",
        ws_port: 18342,
        session_id: null,
        pid: null,
      },
    },
  });
  seedRegistry(workspace, registrySeed);

  const result = await runScript(workspace, "scripts/start-codex-session.sh", {
    args: ["alpha"],
  });

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  const registry = readRegistry(workspace);
  assert.equal(typeof registry.projects.alpha.pid, "number");
  assert.equal(registry.projects.beta.pid, null);
  const state = readState(workspace.stateDir);
  assert.ok(state.fixtures.tmux.sessions.alpha_codex);
  assert.equal(state.fixtures.tmux.sessions.beta_codex, undefined);
});
