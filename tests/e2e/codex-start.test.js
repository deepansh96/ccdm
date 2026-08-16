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
  const registry = {
    discord_user_id: "allowed-user-id",
    guild_id: "guild-id",
    max_pool_size: 50,
    project_bot_role_id: null,
    category_ids: [],
    ...(options.globalCodexHome ? { codex_home: options.globalCodexHome } : {}),
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
        ...(options.guestUserIds ? { guest_user_ids: options.guestUserIds } : {}),
        ...(options.codexHome ? { codex_home: options.codexHome } : {}),
        ...(options.textReplyFallback ? { text_reply_fallback: true } : {}),
        ...(options.codexModel ? { codex_model: options.codexModel } : {}),
        ...(options.codexReasoningEffort ? { codex_reasoning_effort: options.codexReasoningEffort } : {}),
        ...(options.codexServiceTier ? { codex_service_tier: options.codexServiceTier } : {}),
        session_id: null,
        pid: null,
      },
      ...(options.extraProjects ?? {}),
    },
  };

  if (options.createCodexHomes !== false) {
    fs.mkdirSync(path.join(workspace.homeDir, ".codex"), { recursive: true });
    for (const selectedHome of [options.globalCodexHome, options.codexHome]) {
      if (typeof selectedHome === "string") {
        fs.mkdirSync(selectedHome, { recursive: true });
      }
    }
  }

  return registry;
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
  const codexHome = path.join(workspace.homeDir, ".codex-ccdm");
  const defaultCodexHome = path.join(workspace.homeDir, ".codex");
  const registrySeed = buildCodexRegistry(workspace, { globalCodexHome: codexHome });
  seedRegistry(workspace, registrySeed);
  fs.mkdirSync(path.join(workspace.homeDir, ".claude", "channels", "discord"), { recursive: true });
  fs.writeFileSync(
    path.join(workspace.homeDir, ".claude", "channels", "discord", ".env"),
    "DISCORD_BOT_TOKEN=cm9vdC1saXN0ZW5lci1pZA.fixture.token\n",
  );
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(
    path.join(codexHome, "config.toml"),
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
  fs.mkdirSync(defaultCodexHome, { recursive: true });
  fs.writeFileSync(
    path.join(defaultCodexHome, "config.toml"),
    [
      "[mcp_servers.discord-default-home]",
      'command = "default"',
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

  const config = fs.readFileSync(path.join(codexHome, "config.toml"), "utf8");
  assert.match(config, /\[mcp_servers\.keep\]/);
  assert.doesNotMatch(config, /discord-channel-id/);
  assert.match(fs.readFileSync(path.join(defaultCodexHome, "config.toml"), "utf8"), /discord-default-home/);

  const registry = readRegistry(workspace);
  assert.equal(typeof registry.projects.alpha.pid, "number");
  assert.equal(registry.projects.alpha.session_id, null);

  const state = readState(workspace.stateDir);
  const session = state.fixtures.tmux.sessions.alpha_codex;
  assert.equal(session.cwd, workspace.repoDir);
  assert.deepEqual(session.env, {
    ALLOWED_USER_IDS: registrySeed.discord_user_id,
    BOT_APP_ID: registrySeed.pool[1].app_id,
    BOT_DISPLAY_NAME: "bot2-alpha-codex",
    BOT_TOKEN: registrySeed.pool[1].token,
    CHANNEL_ID: registrySeed.projects.alpha.channel_id,
    CODEX_HOME: codexHome,
    CODEX_SERVICE_TIER: "default",
    GUILD_ID: registrySeed.guild_id,
    PROJECT_DIR: registrySeed.projects.alpha.path,
    ROOT_BOT_APP_ID: "root-listener-id",
    ROOT_BOT_TOKEN: registrySeed.pool[0].token,
    WS_PORT: String(registrySeed.projects.alpha.ws_port),
  });
  assert.equal(session.bridgeCommand, "node scripts/codex-bridge.js");
  assert.equal(state.fixtures.codex.bridgeInvocations.length, 1);
  assert.equal(state.fixtures.codex.appServerInvocations.length, 0);
  assert.equal(state.fixtures.npm.invocations.length, 0);
});

test("start-codex-session launches a project under its Codex Account Alias home", async () => {
  const workspace = createWorkspace();
  const projectAccountHome = path.join(workspace.homeDir, ".codex-project-account");
  fs.mkdirSync(projectAccountHome, { recursive: true });
  const registrySeed = buildCodexRegistry(workspace);
  registrySeed.codex_accounts = { "codex-project": projectAccountHome };
  registrySeed.projects.alpha.codex_account = "codex-project";
  seedRegistry(workspace, registrySeed);

  const result = await runScript(workspace, "scripts/start-codex-session.sh", {
    args: ["alpha"],
  });

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.equal(
    readState(workspace.stateDir).fixtures.tmux.sessions.alpha_codex.env.CODEX_HOME,
    projectAccountHome,
  );
});

test("start-codex-session inherits the Default Codex Account when a project has no selector", async () => {
  const workspace = createWorkspace();
  const defaultAccountHome = path.join(workspace.homeDir, ".codex-default-account");
  fs.mkdirSync(defaultAccountHome, { recursive: true });
  const registrySeed = buildCodexRegistry(workspace);
  registrySeed.codex_accounts = { "codex-default": defaultAccountHome };
  registrySeed.default_codex_account = "codex-default";
  seedRegistry(workspace, registrySeed);

  const result = await runScript(workspace, "scripts/start-codex-session.sh", {
    args: ["alpha"],
  });

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.equal(
    readState(workspace.stateDir).fixtures.tmux.sessions.alpha_codex.env.CODEX_HOME,
    defaultAccountHome,
  );
});

test("start-codex-session rejects a project Codex Account Alias and Legacy Codex Home conflict", async () => {
  const workspace = createWorkspace();
  const accountHome = path.join(workspace.homeDir, ".codex-account");
  const legacyHome = path.join(workspace.homeDir, ".codex-legacy");
  fs.mkdirSync(accountHome, { recursive: true });
  fs.mkdirSync(legacyHome, { recursive: true });
  const registrySeed = buildCodexRegistry(workspace);
  registrySeed.codex_accounts = { "codex-account": accountHome };
  registrySeed.projects.alpha.codex_account = "codex-account";
  registrySeed.projects.alpha.codex_home = legacyHome;
  seedRegistry(workspace, registrySeed);

  const result = await runScript(workspace, "scripts/start-codex-session.sh", {
    args: ["alpha"],
  });

  assert.notEqual(result.exitCode, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /project 'alpha'.*(codex_account.*codex_home|codex_home.*codex_account)/);
  const state = readState(workspace.stateDir);
  assert.deepEqual(state.fixtures.tmux.sessions, {});
  assert.equal(readRegistry(workspace).projects.alpha.pid, null);
});

test("start-codex-session rejects an unknown project Codex Account Alias without falling back", async () => {
  const workspace = createWorkspace();
  const configuredHome = path.join(workspace.homeDir, ".codex-configured");
  fs.mkdirSync(configuredHome, { recursive: true });
  const registrySeed = buildCodexRegistry(workspace);
  registrySeed.codex_accounts = { configured: configuredHome };
  registrySeed.projects.alpha.codex_account = "missing-account";
  seedRegistry(workspace, registrySeed);

  const result = await runScript(workspace, "scripts/start-codex-session.sh", {
    args: ["alpha"],
  });

  assert.notEqual(result.exitCode, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /unknown Codex Account Alias 'missing-account'/);
  assert.deepEqual(readState(workspace.stateDir).fixtures.tmux.sessions, {});
  assert.equal(readRegistry(workspace).projects.alpha.pid, null);
});

test("start-codex-session rejects an unknown Default Codex Account even when the project has a legacy override", async () => {
  const workspace = createWorkspace();
  const legacyHome = path.join(workspace.homeDir, ".codex-legacy");
  fs.mkdirSync(legacyHome, { recursive: true });
  const registrySeed = buildCodexRegistry(workspace, { codexHome: legacyHome });
  registrySeed.codex_accounts = { configured: path.join(workspace.homeDir, ".codex-configured") };
  registrySeed.default_codex_account = "missing-account";
  registrySeed.projects.alpha.codex_home = path.join(workspace.homeDir, ".codex-project-legacy");
  fs.mkdirSync(registrySeed.projects.alpha.codex_home, { recursive: true });
  seedRegistry(workspace, registrySeed);

  const result = await runScript(workspace, "scripts/start-codex-session.sh", {
    args: ["alpha"],
  });

  assert.notEqual(result.exitCode, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /default_codex_account.*unknown Codex Account Alias 'missing-account'/);
  assert.deepEqual(readState(workspace.stateDir).fixtures.tmux.sessions, {});
  assert.equal(readRegistry(workspace).projects.alpha.pid, null);
});

test("start-codex-session rejects malformed named-account maps and project selectors", async () => {
  const cases = [
    {
      name: "map wrong type",
      setup(registry) {
        registry.codex_accounts = [];
      },
      message: /codex_accounts.*object mapping/,
    },
    {
      name: "map value wrong type",
      setup(registry) {
        registry.codex_accounts = { configured: 42 };
      },
      message: /codex_accounts\['configured'\].*non-empty string/,
    },
    {
      name: "empty project selector",
      setup(registry, workspace) {
        registry.codex_accounts = { configured: path.join(workspace.homeDir, ".codex-configured") };
        registry.projects.alpha.codex_account = " ";
      },
      message: /project 'alpha' codex_account.*empty or whitespace-only/,
    },
    {
      name: "wrong-typed project selector",
      setup(registry, workspace) {
        registry.codex_accounts = { configured: path.join(workspace.homeDir, ".codex-configured") };
        registry.projects.alpha.codex_account = 42;
      },
      message: /project 'alpha' codex_account.*non-empty string/,
    },
  ];

  for (const invalidCase of cases) {
    const workspace = createWorkspace();
    const registrySeed = buildCodexRegistry(workspace);
    invalidCase.setup(registrySeed, workspace);
    seedRegistry(workspace, registrySeed);

    const result = await runScript(workspace, "scripts/start-codex-session.sh", {
      args: ["alpha"],
    });

    assert.notEqual(result.exitCode, 0, invalidCase.name);
    assert.match(`${result.stdout}\n${result.stderr}`, invalidCase.message, invalidCase.name);
    assert.deepEqual(readState(workspace.stateDir).fixtures.tmux.sessions, {}, invalidCase.name);
    assert.equal(readRegistry(workspace).projects.alpha.pid, null, invalidCase.name);
  }
});

test("start-codex-session treats a null project Codex Account Alias as unset", async () => {
  const workspace = createWorkspace();
  const defaultAccountHome = path.join(workspace.homeDir, ".codex-default-account");
  fs.mkdirSync(defaultAccountHome, { recursive: true });
  const registrySeed = buildCodexRegistry(workspace);
  registrySeed.codex_accounts = { "codex-default": defaultAccountHome };
  registrySeed.default_codex_account = "codex-default";
  registrySeed.projects.alpha.codex_account = null;
  seedRegistry(workspace, registrySeed);

  const result = await runScript(workspace, "scripts/start-codex-session.sh", {
    args: ["alpha"],
  });

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.equal(
    readState(workspace.stateDir).fixtures.tmux.sessions.alpha_codex.env.CODEX_HOME,
    defaultAccountHome,
  );
});

test("start-codex-session applies Codex Home validation to an aliased home", async () => {
  const cases = [
    {
      name: "missing",
      setup(workspace) {
        return path.join(workspace.homeDir, ".codex-missing-account");
      },
      message: /Codex Account Alias 'selected'.*does not exist/,
    },
    {
      name: "non-directory",
      setup(workspace) {
        const selectedHome = path.join(workspace.homeDir, ".codex-account-file");
        fs.writeFileSync(selectedHome, "not a directory\n");
        return selectedHome;
      },
      message: /Codex Account Alias 'selected'.*not a directory/,
    },
    {
      name: "inaccessible",
      setup(workspace) {
        const selectedHome = path.join(workspace.homeDir, ".codex-account-read-only");
        fs.mkdirSync(selectedHome, { recursive: true });
        fs.chmodSync(selectedHome, 0o555);
        return selectedHome;
      },
      message: /Codex Account Alias 'selected'.*not writable/,
    },
    {
      name: "unusable config",
      setup(workspace) {
        const selectedHome = path.join(workspace.homeDir, ".codex-account-config-directory");
        fs.mkdirSync(path.join(selectedHome, "config.toml"), { recursive: true });
        return selectedHome;
      },
      message: /Codex Account Alias 'selected'.*config\.toml.*not a regular file/,
    },
  ];

  for (const invalidCase of cases) {
    const workspace = createWorkspace();
    const selectedHome = invalidCase.setup(workspace);
    const registrySeed = buildCodexRegistry(workspace);
    registrySeed.codex_accounts = { selected: selectedHome };
    registrySeed.projects.alpha.codex_account = "selected";
    seedRegistry(workspace, registrySeed);
    const markerPath = path.join(selectedHome, "stale-mcp-marker");
    if (invalidCase.name === "unusable config") {
      fs.writeFileSync(markerPath, "stale\n");
    }

    const result = await runScript(workspace, "scripts/start-codex-session.sh", {
      args: ["alpha"],
    });

    assert.notEqual(result.exitCode, 0, invalidCase.name);
    assert.match(`${result.stdout}\n${result.stderr}`, invalidCase.message, invalidCase.name);
    assert.deepEqual(readState(workspace.stateDir).fixtures.tmux.sessions, {}, invalidCase.name);
    assert.equal(readRegistry(workspace).projects.alpha.pid, null, invalidCase.name);
    if (invalidCase.name === "unusable config") {
      assert.equal(fs.readFileSync(markerPath, "utf8"), "stale\n", invalidCase.name);
    }
  }
});

test("start-codex-session ignores a broken Codex Account Alias on an unrelated project", async () => {
  const workspace = createWorkspace();
  const selectedHome = path.join(workspace.homeDir, ".codex-selected");
  fs.mkdirSync(selectedHome, { recursive: true });
  const registrySeed = buildCodexRegistry(workspace, {
    extraProjects: {
      beta: {
        path: path.join(workspace.tmpDir, "beta project"),
        bot_id: "bot3",
        screen_name: "beta_codex",
        channel_id: "beta-channel-id",
        type: "codex",
        codex_account: "missing-account",
        ws_port: 18343,
        session_id: null,
        pid: null,
      },
    },
  });
  registrySeed.codex_accounts = { selected: selectedHome };
  registrySeed.projects.alpha.codex_account = "selected";
  seedRegistry(workspace, registrySeed);

  const result = await runScript(workspace, "scripts/start-codex-session.sh", {
    args: ["alpha"],
  });

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.equal(readState(workspace.stateDir).fixtures.tmux.sessions.alpha_codex.env.CODEX_HOME, selectedHome);
  assert.equal(readRegistry(workspace).projects.beta.pid, null);
});

test("start-codex-session rejects a missing Codex home before lifecycle mutation", async () => {
  const workspace = createWorkspace();
  const missingHome = path.join(workspace.homeDir, ".codex-missing");
  seedRegistry(workspace, buildCodexRegistry(workspace, { createCodexHomes: false, globalCodexHome: missingHome }));

  const result = await runScript(workspace, "scripts/start-codex-session.sh", {
    args: ["alpha"],
  });

  assert.notEqual(result.exitCode, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /codex_home/);
  assert.match(`${result.stdout}\n${result.stderr}`, new RegExp(missingHome.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  const state = readState(workspace.stateDir);
  assert.deepEqual(state.fixtures.tmux.sessions, {});
  assert.equal(state.fixtures.codex.bridgeInvocations.length, 0);
  assert.equal(readRegistry(workspace).projects.alpha.pid, null);
});

test("start-codex-session rejects a wrong-typed project Codex home selector", async () => {
  for (const selector of ["project", "top-level"]) {
    const workspace = createWorkspace();
    const registrySeed = buildCodexRegistry(workspace);
    if (selector === "project") {
      registrySeed.projects.alpha.codex_home = 42;
    } else {
      registrySeed.codex_home = 42;
    }
    seedRegistry(workspace, registrySeed);

    const result = await runScript(workspace, "scripts/start-codex-session.sh", {
      args: ["alpha"],
    });

    assert.notEqual(result.exitCode, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /codex_home/);
    assert.match(`${result.stdout}\n${result.stderr}`, /non-empty string/);
    assert.deepEqual(readState(workspace.stateDir).fixtures.tmux.sessions, {});
    assert.equal(readRegistry(workspace).projects.alpha.pid, null);
  }
});

test("start-codex-session treats null Codex home selectors as unset", async () => {
  const workspace = createWorkspace();
  const registrySeed = buildCodexRegistry(workspace);
  registrySeed.codex_home = null;
  registrySeed.projects.alpha.codex_home = null;
  seedRegistry(workspace, registrySeed);

  const result = await runScript(workspace, "scripts/start-codex-session.sh", {
    args: ["alpha"],
  });

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.equal(
    readState(workspace.stateDir).fixtures.tmux.sessions.alpha_codex.env.CODEX_HOME,
    path.join(workspace.homeDir, ".codex"),
  );
});

test("start-codex-session rejects empty or whitespace Codex home selectors", async () => {
  for (const selector of ["project", "top-level"]) {
    const workspace = createWorkspace();
    const registrySeed = buildCodexRegistry(workspace);
    if (selector === "project") {
      registrySeed.projects.alpha.codex_home = " \t";
    } else {
      registrySeed.codex_home = "\n";
    }
    seedRegistry(workspace, registrySeed);

    const result = await runScript(workspace, "scripts/start-codex-session.sh", {
      args: ["alpha"],
    });

    assert.notEqual(result.exitCode, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /codex_home.*empty or whitespace-only/);
    assert.deepEqual(readState(workspace.stateDir).fixtures.tmux.sessions, {});
    assert.equal(readRegistry(workspace).projects.alpha.pid, null);
  }
});

test("start-codex-session rejects a non-regular config.toml before MCP cleanup", async () => {
  const workspace = createWorkspace();
  const codexHome = path.join(workspace.homeDir, ".codex-config-directory");
  seedRegistry(workspace, buildCodexRegistry(workspace, { globalCodexHome: codexHome }));
  fs.mkdirSync(path.join(codexHome, "config.toml"), { recursive: true });
  fs.writeFileSync(path.join(codexHome, "stale-mcp-marker"), "[mcp_servers.discord-stale]\n");

  const result = await runScript(workspace, "scripts/start-codex-session.sh", {
    args: ["alpha"],
  });

  assert.notEqual(result.exitCode, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /config\.toml.*not a regular file/);
  assert.equal(fs.statSync(path.join(codexHome, "config.toml")).isDirectory(), true);
  assert.equal(fs.readFileSync(path.join(codexHome, "stale-mcp-marker"), "utf8"), "[mcp_servers.discord-stale]\n");
  assert.deepEqual(readState(workspace.stateDir).fixtures.tmux.sessions, {});
  assert.equal(readRegistry(workspace).projects.alpha.pid, null);
});

test("start-codex-session accepts normalized paths with spaces and valid symlinks", async () => {
  const workspace = createWorkspace();
  const targetHome = path.join(workspace.tmpDir, "codex home with spaces");
  const symlinkHome = path.join(workspace.homeDir, "codex home link");
  fs.mkdirSync(targetHome, { recursive: true });
  fs.symlinkSync(targetHome, symlinkHome, "dir");
  const registrySeed = buildCodexRegistry(workspace, {
    globalCodexHome: `${workspace.homeDir}/./codex home link`,
  });
  seedRegistry(workspace, registrySeed);

  const result = await runScript(workspace, "scripts/start-codex-session.sh", {
    args: ["alpha"],
  });

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.equal(
    readState(workspace.stateDir).fixtures.tmux.sessions.alpha_codex.env.CODEX_HOME,
    symlinkHome,
  );
});

test("start-codex-session rejects a broken Codex Home symlink before lifecycle mutation", async () => {
  const workspace = createWorkspace();
  const brokenHome = path.join(workspace.homeDir, "broken codex home");
  fs.symlinkSync(path.join(workspace.tmpDir, "missing codex target"), brokenHome, "dir");
  const registrySeed = buildCodexRegistry(workspace, {
    createCodexHomes: false,
    globalCodexHome: brokenHome,
  });
  seedRegistry(workspace, registrySeed);

  const result = await runScript(workspace, "scripts/start-codex-session.sh", {
    args: ["alpha"],
  });

  assert.notEqual(result.exitCode, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /broken symlink/);
  assert.deepEqual(readState(workspace.stateDir).fixtures.tmux.sessions, {});
  assert.equal(readRegistry(workspace).projects.alpha.pid, null);
});

test("start-codex-session rejects non-directory and non-writable Codex Homes", async () => {
  const nonDirectoryWorkspace = createWorkspace();
  const nonDirectoryHome = path.join(nonDirectoryWorkspace.homeDir, "codex file");
  fs.writeFileSync(nonDirectoryHome, "not a directory\n");
  seedRegistry(
    nonDirectoryWorkspace,
    buildCodexRegistry(nonDirectoryWorkspace, {
      createCodexHomes: false,
      globalCodexHome: nonDirectoryHome,
    }),
  );
  const nonDirectoryResult = await runScript(nonDirectoryWorkspace, "scripts/start-codex-session.sh", {
    args: ["alpha"],
  });
  assert.notEqual(nonDirectoryResult.exitCode, 0);
  assert.match(`${nonDirectoryResult.stdout}\n${nonDirectoryResult.stderr}`, /not a directory/);
  assert.deepEqual(readState(nonDirectoryWorkspace.stateDir).fixtures.tmux.sessions, {});

  const permissionWorkspace = createWorkspace();
  const permissionHome = path.join(permissionWorkspace.homeDir, "codex read-only");
  seedRegistry(permissionWorkspace, buildCodexRegistry(permissionWorkspace, { globalCodexHome: permissionHome }));
  fs.chmodSync(permissionHome, 0o555);
  const permissionResult = await runScript(permissionWorkspace, "scripts/start-codex-session.sh", {
    args: ["alpha"],
  });
  assert.notEqual(permissionResult.exitCode, 0);
  assert.match(`${permissionResult.stdout}\n${permissionResult.stderr}`, /not writable/);
  assert.deepEqual(readState(permissionWorkspace.stateDir).fixtures.tmux.sessions, {});
});

test("start-codex-session rejects a non-writable config.toml before cleanup", async () => {
  const workspace = createWorkspace();
  const codexHome = path.join(workspace.homeDir, ".codex-read-only-config");
  seedRegistry(workspace, buildCodexRegistry(workspace, { globalCodexHome: codexHome }));
  const configPath = path.join(codexHome, "config.toml");
  const originalConfig = "[mcp_servers.discord-stale]\ncommand = \"node\"\n";
  fs.writeFileSync(configPath, originalConfig);
  fs.chmodSync(configPath, 0o444);

  const result = await runScript(workspace, "scripts/start-codex-session.sh", {
    args: ["alpha"],
  });

  assert.notEqual(result.exitCode, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /config\.toml.*not writable/);
  assert.equal(fs.readFileSync(configPath, "utf8"), originalConfig);
  assert.deepEqual(readState(workspace.stateDir).fixtures.tmux.sessions, {});
});

test("start-codex-session ignores a broken Codex home on an unrelated project", async () => {
  const workspace = createWorkspace();
  const registrySeed = buildCodexRegistry(workspace, {
    extraProjects: {
      beta: {
        path: path.join(workspace.tmpDir, "beta project"),
        bot_id: "bot3",
        screen_name: "beta_codex",
        channel_id: "beta-channel-id",
        type: "codex",
        codex_home: path.join(workspace.homeDir, "missing beta codex home"),
        ws_port: 18343,
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
  assert.equal(
    readState(workspace.stateDir).fixtures.tmux.sessions.alpha_codex.env.CODEX_HOME,
    path.join(workspace.homeDir, ".codex"),
  );
  assert.equal(readRegistry(workspace).projects.beta.pid, null);
});

test("start-codex-session expands home-relative selectors and rejects unresolved paths", async () => {
  const successWorkspace = createWorkspace();
  const tildeHome = path.join(successWorkspace.homeDir, ".codex tilde home");
  fs.mkdirSync(tildeHome, { recursive: true });
  const successRegistry = buildCodexRegistry(successWorkspace);
  successRegistry.codex_home = "~/.codex tilde home";
  seedRegistry(successWorkspace, successRegistry);
  const successResult = await runScript(successWorkspace, "scripts/start-codex-session.sh", {
    args: ["alpha"],
  });
  assert.equal(successResult.exitCode, 0, successResult.stderr || successResult.stdout);
  assert.equal(
    readState(successWorkspace.stateDir).fixtures.tmux.sessions.alpha_codex.env.CODEX_HOME,
    tildeHome,
  );

  for (const unresolvedPath of ["relative/codex-home", "${HOME}/codex-home"]) {
    const workspace = createWorkspace();
    const registrySeed = buildCodexRegistry(workspace);
    registrySeed.codex_home = unresolvedPath;
    seedRegistry(workspace, registrySeed);
    const result = await runScript(workspace, "scripts/start-codex-session.sh", {
      args: ["alpha"],
    });
    assert.notEqual(result.exitCode, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /top-level codex_home.*must be absolute or use '~'/);
    assert.deepEqual(readState(workspace.stateDir).fixtures.tmux.sessions, {});
  }
});

test("start-codex-session keeps project Codex homes above the shared home", async () => {
  const workspace = createWorkspace();
  const sharedHome = path.join(workspace.homeDir, ".codex-ccdm");
  const projectHome = path.join(workspace.homeDir, ".codex-api");
  seedRegistry(workspace, buildCodexRegistry(workspace, {
    codexHome: projectHome,
    globalCodexHome: sharedHome,
  }));

  const result = await runScript(workspace, "scripts/start-codex-session.sh", {
    args: ["alpha"],
  });

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.equal(readState(workspace.stateDir).fixtures.tmux.sessions.alpha_codex.env.CODEX_HOME, projectHome);
});

test("start-codex-session passes text reply fallback only for flagged Codex projects", async () => {
  const workspace = createWorkspace();
  seedRegistry(workspace, buildCodexRegistry(workspace, { textReplyFallback: true }));

  const result = await runScript(workspace, "scripts/start-codex-session.sh", {
    args: ["alpha"],
  });

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  const session = readState(workspace.stateDir).fixtures.tmux.sessions.alpha_codex;
  assert.equal(session.env.CODEX_BRIDGE_TEXT_REPLY_FALLBACK, "1");
});

test("start-codex-session passes per-project Codex config overrides to the bridge", async () => {
  const workspace = createWorkspace();
  seedRegistry(
    workspace,
    buildCodexRegistry(workspace, {
      codexModel: "gpt-5.6-sol",
      codexReasoningEffort: "high",
      codexServiceTier: "priority",
    }),
  );

  const result = await runScript(workspace, "scripts/start-codex-session.sh", {
    args: ["alpha"],
  });

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  const session = readState(workspace.stateDir).fixtures.tmux.sessions.alpha_codex;
  assert.equal(session.env.CODEX_MODEL, "gpt-5.6-sol");
  assert.equal(session.env.CODEX_REASONING_EFFORT, "high");
  assert.equal(session.env.CODEX_SERVICE_TIER, "priority");
});

test("start-codex-session allows owner plus project guests", async () => {
  const workspace = createWorkspace();
  seedRegistry(workspace, buildCodexRegistry(workspace, { guestUserIds: ["222222222222222222"] }));

  const result = await runScript(workspace, "scripts/start-codex-session.sh", {
    args: ["alpha"],
  });

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  const session = readState(workspace.stateDir).fixtures.tmux.sessions.alpha_codex;
  assert.equal(session.env.ALLOWED_USER_IDS, "allowed-user-id,222222222222222222");
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
