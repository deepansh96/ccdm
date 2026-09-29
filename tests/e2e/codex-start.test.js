import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { startFakeCodexServer } from "./support/bridge.js";
import { createRouterWorkspace, routerEnv, routerWithWebhooks, runRouterCli } from "./support/router.js";
import { createWorkspace, runScript } from "./support/runner.js";
import { readState, seedFixtureProcess, seedRegistry, seedTmuxSession, writeState } from "./support/state.js";
import { cleanup, registerTeardownCallback } from "./support/teardown.js";

test.afterEach(async () => {
  await cleanup();
});

// Every Codex launch goes through the Router, so each scenario runs in a
// Router Test Workspace (its private state under `routerStateDir`, root's
// token in root's Discord state for the Router alone).
function createCodexWorkspace() {
  return createRouterWorkspace({});
}

// The router default: `alpha` is a Codex project with no pool bot and no
// `transport` field (`options.transport` sets one); the pool is empty.
function buildCodexRegistry(workspace, options = {}) {
  const projectPath = options.projectPath ?? path.join(workspace.tmpDir, 'project with spaces and "quotes"');
  fs.mkdirSync(projectPath, { recursive: true });
  const registry = {
    discord_user_id: "allowed-user-id",
    guild_id: "guild-id",
    max_pool_size: 50,
    project_bot_role_id: null,
    category_ids: [],
    ...(options.globalCodexHome ? { codex_home: options.globalCodexHome } : {}),
    pool: [],
    projects: {
      alpha: {
        path: projectPath,
        screen_name: "alpha_codex",
        channel_id: "channel-id",
        type: "codex",
        ws_port: 18342,
        ...(options.transport ? { transport: options.transport } : {}),
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

// Puts alpha (and any `samePort` projects) on a fake Codex app-server, seeds
// the registry, gives alpha its webhook, and starts the Router, so a launch
// can say hello.
async function serveAlpha(workspace, registrySeed, { codex: codexOptions = {}, samePort = [] } = {}) {
  const codex = await startFakeCodexServer(workspace, { channelId: "channel-id", ...codexOptions });
  for (const name of ["alpha", ...samePort]) registrySeed.projects[name].ws_port = codex.port;
  seedRegistry(workspace, registrySeed);
  const router = await routerWithWebhooks(workspace, ["alpha"]);
  return { codex, router };
}

function startCodex(workspace, { args = ["alpha"], env = {}, timeoutMs = 30000 } = {}) {
  return runScript(workspace, "scripts/start-codex-session.sh", { args, env: routerEnv(workspace, env), timeoutMs });
}

function alphaKeyFile(workspace) {
  return path.join(workspace.routerStateDir, "keys", "alpha.key");
}

// A refused launch creates no tmux session, records no PID, and writes no launch key.
function assertNoLaunch(workspace, label) {
  assert.deepEqual(readState(workspace.stateDir).fixtures.tmux.sessions, {}, label);
  assert.equal(readRegistry(workspace).projects.alpha.pid, null, label);
  assert.equal(fs.existsSync(alphaKeyFile(workspace)), false, label);
}

async function waitForExit(pid, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === "ESRCH") return;
      throw error;
    }
    assert.ok(Date.now() < deadline, `process ${pid} is still running`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
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

test("start-codex-session constructs a Router bridge tmux launch, removes stale MCP config, and records PID", async () => {
  const workspace = createCodexWorkspace();
  const codexHome = path.join(workspace.homeDir, ".codex-ccdm");
  const defaultCodexHome = path.join(workspace.homeDir, ".codex");
  const registrySeed = buildCodexRegistry(workspace, { globalCodexHome: codexHome });
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
  const { codex } = await serveAlpha(workspace, registrySeed);

  const beforeInventory = listRelativeFiles(workspace.repoDir);
  const result = await startCodex(workspace);
  const afterInventory = listRelativeFiles(workspace.repoDir);

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Started Codex Router bridge in tmux session 'alpha_codex'/);
  assert.match(result.stdout, /Bridge connected to the Router \(scope channel-id\)/);
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
  assert.equal(registry.projects.alpha.pid, session.pid);
  assert.deepEqual(session.env, {
    ALLOWED_USER_IDS: "allowed-user-id",
    CCDM_CHANNEL_READY_FILE: path.join(workspace.routerStateDir, "launches", "alpha", "ready.json"),
    CCDM_CODEX_PROJECT: "alpha",
    CCDM_ROUTER_KEY_FILE: alphaKeyFile(workspace),
    CCDM_ROUTER_STATE_DIR: workspace.routerStateDir,
    CHANNEL_ID: "channel-id",
    CODEX_HOME: codexHome,
    CODEX_SERVICE_TIER: "default",
    CODEX_RESUME_THREAD_ID: "",
    PROJECT_DIR: path.join(workspace.tmpDir, 'project with spaces and "quotes"'),
    WS_PORT: String(codex.port),
  });
  for (const forbidden of ["BOT_TOKEN", "DISCORD_STATE_DIR"]) {
    assert.equal(session.shellCommand.includes(forbidden), false, forbidden);
  }
  assert.equal(session.bridgeCommand, "node scripts/codex-bridge.js");
  assert.equal(fs.statSync(alphaKeyFile(workspace)).mode & 0o777, 0o600);
  assert.equal(state.fixtures.codex.bridgeInvocations.length, 1);
  // The bridge's Codex app-server is the fake one on alpha's port.
  assert.equal(codex.clientMessages.filter((message) => message.method === "initialize").length, 1);
  assert.equal(state.fixtures.npm.invocations.length, 0);
  const status = await runRouterCli(workspace, ["status"]);
  assert.match(status.stdout, /sessions: 1\n  project alpha scope=channel-id connected=/);
});

test("start-codex-session forwards an explicit resume ID and ignores an inherited one", async () => {
  for (const resume of [true, false]) {
    const workspace = createCodexWorkspace();
    const { codex } = await serveAlpha(workspace, buildCodexRegistry(workspace));
    const id = "00000000-0000-4000-8000-000000000001";
    const result = await startCodex(workspace, {
      args: resume ? ["alpha", "--resume", id] : ["alpha"],
      env: {
        CODEX_RESUME_THREAD_ID: "inherited-other-thread",
        CODEX_STARTUP_READY_FILE: "/unwanted/inherited/file",
        CCDM_CHANNEL_READY_FILE: "/unwanted/inherited/ready.json",
      },
    });
    assert.equal(result.exitCode, 0, result.stderr || result.stdout);
    const session = readState(workspace.stateDir).fixtures.tmux.sessions.alpha_codex;
    assert.equal(session.env.CODEX_RESUME_THREAD_ID, resume ? id : "");
    assert.equal(readRegistry(workspace).projects.alpha.pid, session.pid);
    assert.equal(session.env.CCDM_CHANNEL_READY_FILE, path.join(workspace.routerStateDir, "launches", "alpha", "ready.json"));
    assert.equal(session.env.CODEX_STARTUP_READY_FILE, undefined);
    const threadRequests = codex.clientMessages
      .filter((message) => message.method === "thread/resume" || message.method === "thread/start")
      .map((message) => [message.method, message.params?.threadId]);
    assert.deepEqual(threadRequests, resume ? [["thread/resume", id]] : [["thread/start", undefined]]);
  }
});

test("resume startup failures clean the listener, runtime state, launch key, and launch directory", async () => {
  for (const startupMode of ["exit", "timeout"]) {
    const workspace = createCodexWorkspace();
    const registry = buildCodexRegistry(workspace);
    registry.projects.alpha.pid = 99999999;
    registry.projects.alpha.session_id = "old-session";
    // `exit`: Codex refuses the thread and the bridge exits; `timeout`: the
    // bootstrap turn never completes, so the bridge never says hello.
    await serveAlpha(workspace, registry, {
      codex: startupMode === "exit" ? { resumeError: "no rollout found for thread" } : { bootstrapPlan: { complete: false } },
    });
    const result = await startCodex(workspace, {
      args: ["alpha", "--resume", "00000000-0000-4000-8000-000000000001"],
      env: { CCDM_CODEX_LAUNCH_TIMEOUT_S: "5" },
    });
    assert.equal(result.exitCode, 1, result.stderr || result.stdout);
    assert.match(result.stderr, startupMode === "exit"
      ? /Codex Router launch failed: .*no rollout found for thread/
      : /Codex Router launch failed: the bridge never said hello to the Router/);
    assert.match(result.stderr, /Launch of 'alpha' failed; cleaning up/);
    assert.doesNotMatch(result.stdout, /Recorded PID/);
    const after = readState(workspace.stateDir);
    assert.deepEqual(after.fixtures.tmux.sessions, {});
    assert.equal(fs.existsSync(alphaKeyFile(workspace)), false);
    assert.equal(fs.existsSync(path.join(workspace.routerStateDir, "launches", "alpha")), false);
    const launch = after.fixtures.codex.bridgeInvocations[0];
    assert.equal(launch.env.CODEX_RESUME_THREAD_ID, "00000000-0000-4000-8000-000000000001");
    await waitForExit(launch.pid);
    assert.equal(readRegistry(workspace).projects.alpha.pid, null);
    assert.equal(readRegistry(workspace).projects.alpha.session_id, null);
    await cleanup();
  }
});

test("start-codex-session rejects malformed resume arguments before changing state", async () => {
  const workspace = createCodexWorkspace();
  const seed = buildCodexRegistry(workspace);
  seedRegistry(workspace, seed);
  for (const args of [
    ["alpha", "--resume"],
    ["alpha", "--resume", ""],
    ["alpha", "--resume", "not-a-uuid"],
    ["alpha", "--resume", "$(touch injected)"],
    ["alpha", "--resume", "00000000-0000-4000-8000-000000000001", "extra"],
    ["alpha", "--unknown", "00000000-0000-4000-8000-000000000001"],
  ]) {
    const result = await startCodex(workspace, { args });
    assert.notEqual(result.exitCode, 0);
    assert.deepEqual(readRegistry(workspace), seed);
    assert.deepEqual(readState(workspace.stateDir).fixtures.tmux.sessions, {});
  }
});

test("start-codex-session launches a project under its Codex Account Alias home", async () => {
  const workspace = createCodexWorkspace();
  const projectAccountHome = path.join(workspace.homeDir, ".codex-project-account");
  fs.mkdirSync(projectAccountHome, { recursive: true });
  const registrySeed = buildCodexRegistry(workspace);
  registrySeed.codex_accounts = { "codex-project": projectAccountHome };
  registrySeed.projects.alpha.codex_account = "codex-project";
  await serveAlpha(workspace, registrySeed);

  const result = await startCodex(workspace);

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.equal(
    readState(workspace.stateDir).fixtures.tmux.sessions.alpha_codex.env.CODEX_HOME,
    projectAccountHome,
  );
});

test("start-codex-session inherits the Default Codex Account when a project has no selector", async () => {
  const workspace = createCodexWorkspace();
  const defaultAccountHome = path.join(workspace.homeDir, ".codex-default-account");
  fs.mkdirSync(defaultAccountHome, { recursive: true });
  const registrySeed = buildCodexRegistry(workspace);
  registrySeed.codex_accounts = { "codex-default": defaultAccountHome };
  registrySeed.default_codex_account = "codex-default";
  await serveAlpha(workspace, registrySeed);

  const result = await startCodex(workspace);

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.equal(
    readState(workspace.stateDir).fixtures.tmux.sessions.alpha_codex.env.CODEX_HOME,
    defaultAccountHome,
  );
});

test("start-codex-session rejects a project Codex Account Alias and Legacy Codex Home conflict", async () => {
  const workspace = createCodexWorkspace();
  const accountHome = path.join(workspace.homeDir, ".codex-account");
  const legacyHome = path.join(workspace.homeDir, ".codex-legacy");
  fs.mkdirSync(accountHome, { recursive: true });
  fs.mkdirSync(legacyHome, { recursive: true });
  const registrySeed = buildCodexRegistry(workspace);
  registrySeed.codex_accounts = { "codex-account": accountHome };
  registrySeed.projects.alpha.codex_account = "codex-account";
  registrySeed.projects.alpha.codex_home = legacyHome;
  seedRegistry(workspace, registrySeed);

  const result = await startCodex(workspace);

  assert.notEqual(result.exitCode, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /project 'alpha'.*(codex_account.*codex_home|codex_home.*codex_account)/);
  const state = readState(workspace.stateDir);
  assert.deepEqual(state.fixtures.tmux.sessions, {});
  assert.equal(readRegistry(workspace).projects.alpha.pid, null);
});

test("start-codex-session rejects an unknown project Codex Account Alias without falling back", async () => {
  const workspace = createCodexWorkspace();
  const configuredHome = path.join(workspace.homeDir, ".codex-configured");
  fs.mkdirSync(configuredHome, { recursive: true });
  const registrySeed = buildCodexRegistry(workspace);
  registrySeed.codex_accounts = { configured: configuredHome };
  registrySeed.projects.alpha.codex_account = "missing-account";
  seedRegistry(workspace, registrySeed);

  const result = await startCodex(workspace);

  assert.notEqual(result.exitCode, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /unknown Codex Account Alias 'missing-account'/);
  assertNoLaunch(workspace);
});

test("start-codex-session rejects an unknown Default Codex Account even when the project has a legacy override", async () => {
  const workspace = createCodexWorkspace();
  const legacyHome = path.join(workspace.homeDir, ".codex-legacy");
  fs.mkdirSync(legacyHome, { recursive: true });
  const registrySeed = buildCodexRegistry(workspace, { codexHome: legacyHome });
  registrySeed.codex_accounts = { configured: path.join(workspace.homeDir, ".codex-configured") };
  registrySeed.default_codex_account = "missing-account";
  registrySeed.projects.alpha.codex_home = path.join(workspace.homeDir, ".codex-project-legacy");
  fs.mkdirSync(registrySeed.projects.alpha.codex_home, { recursive: true });
  seedRegistry(workspace, registrySeed);

  const result = await startCodex(workspace);

  assert.notEqual(result.exitCode, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /default_codex_account.*unknown Codex Account Alias 'missing-account'/);
  assertNoLaunch(workspace);
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
    const workspace = createCodexWorkspace();
    const registrySeed = buildCodexRegistry(workspace);
    invalidCase.setup(registrySeed, workspace);
    seedRegistry(workspace, registrySeed);

    const result = await startCodex(workspace);

    assert.notEqual(result.exitCode, 0, invalidCase.name);
    assert.match(`${result.stdout}\n${result.stderr}`, invalidCase.message, invalidCase.name);
    assertNoLaunch(workspace, invalidCase.name);
  }
});

test("start-codex-session treats a null project Codex Account Alias as unset", async () => {
  const workspace = createCodexWorkspace();
  const defaultAccountHome = path.join(workspace.homeDir, ".codex-default-account");
  fs.mkdirSync(defaultAccountHome, { recursive: true });
  const registrySeed = buildCodexRegistry(workspace);
  registrySeed.codex_accounts = { "codex-default": defaultAccountHome };
  registrySeed.default_codex_account = "codex-default";
  registrySeed.projects.alpha.codex_account = null;
  await serveAlpha(workspace, registrySeed);

  const result = await startCodex(workspace);

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
    const workspace = createCodexWorkspace();
    const selectedHome = invalidCase.setup(workspace);
    const registrySeed = buildCodexRegistry(workspace);
    registrySeed.codex_accounts = { selected: selectedHome };
    registrySeed.projects.alpha.codex_account = "selected";
    seedRegistry(workspace, registrySeed);
    const markerPath = path.join(selectedHome, "stale-mcp-marker");
    if (invalidCase.name === "unusable config") {
      fs.writeFileSync(markerPath, "stale\n");
    }

    const result = await startCodex(workspace);

    assert.notEqual(result.exitCode, 0, invalidCase.name);
    assert.match(`${result.stdout}\n${result.stderr}`, invalidCase.message, invalidCase.name);
    assertNoLaunch(workspace, invalidCase.name);
    if (invalidCase.name === "unusable config") {
      assert.equal(fs.readFileSync(markerPath, "utf8"), "stale\n", invalidCase.name);
    }
  }
});

test("start-codex-session ignores a broken Codex Account Alias on an unrelated project", async () => {
  const workspace = createCodexWorkspace();
  const selectedHome = path.join(workspace.homeDir, ".codex-selected");
  fs.mkdirSync(selectedHome, { recursive: true });
  const registrySeed = buildCodexRegistry(workspace, {
    extraProjects: {
      beta: {
        path: path.join(workspace.tmpDir, "beta project"),
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
  await serveAlpha(workspace, registrySeed);

  const result = await startCodex(workspace);

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.equal(readState(workspace.stateDir).fixtures.tmux.sessions.alpha_codex.env.CODEX_HOME, selectedHome);
  assert.equal(readRegistry(workspace).projects.beta.pid, null);
});

test("start-codex-session rejects a missing Codex home before lifecycle mutation", async () => {
  const workspace = createCodexWorkspace();
  const missingHome = path.join(workspace.homeDir, ".codex-missing");
  seedRegistry(workspace, buildCodexRegistry(workspace, { createCodexHomes: false, globalCodexHome: missingHome }));

  const result = await startCodex(workspace);

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
    const workspace = createCodexWorkspace();
    const registrySeed = buildCodexRegistry(workspace);
    if (selector === "project") {
      registrySeed.projects.alpha.codex_home = 42;
    } else {
      registrySeed.codex_home = 42;
    }
    seedRegistry(workspace, registrySeed);

    const result = await startCodex(workspace);

    assert.notEqual(result.exitCode, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /codex_home/);
    assert.match(`${result.stdout}\n${result.stderr}`, /non-empty string/);
    assertNoLaunch(workspace);
  }
});

test("start-codex-session treats null Codex home selectors as unset", async () => {
  const workspace = createCodexWorkspace();
  const registrySeed = buildCodexRegistry(workspace);
  registrySeed.codex_home = null;
  registrySeed.projects.alpha.codex_home = null;
  await serveAlpha(workspace, registrySeed);

  const result = await startCodex(workspace);

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.equal(
    readState(workspace.stateDir).fixtures.tmux.sessions.alpha_codex.env.CODEX_HOME,
    path.join(workspace.homeDir, ".codex"),
  );
});

test("start-codex-session rejects empty or whitespace Codex home selectors", async () => {
  for (const selector of ["project", "top-level"]) {
    const workspace = createCodexWorkspace();
    const registrySeed = buildCodexRegistry(workspace);
    if (selector === "project") {
      registrySeed.projects.alpha.codex_home = " \t";
    } else {
      registrySeed.codex_home = "\n";
    }
    seedRegistry(workspace, registrySeed);

    const result = await startCodex(workspace);

    assert.notEqual(result.exitCode, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /codex_home.*empty or whitespace-only/);
    assertNoLaunch(workspace);
  }
});

test("start-codex-session rejects a non-regular config.toml before MCP cleanup", async () => {
  const workspace = createCodexWorkspace();
  const codexHome = path.join(workspace.homeDir, ".codex-config-directory");
  seedRegistry(workspace, buildCodexRegistry(workspace, { globalCodexHome: codexHome }));
  fs.mkdirSync(path.join(codexHome, "config.toml"), { recursive: true });
  fs.writeFileSync(path.join(codexHome, "stale-mcp-marker"), "[mcp_servers.discord-stale]\n");

  const result = await startCodex(workspace);

  assert.notEqual(result.exitCode, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /config\.toml.*not a regular file/);
  assert.equal(fs.statSync(path.join(codexHome, "config.toml")).isDirectory(), true);
  assert.equal(fs.readFileSync(path.join(codexHome, "stale-mcp-marker"), "utf8"), "[mcp_servers.discord-stale]\n");
  assertNoLaunch(workspace);
});

test("start-codex-session accepts normalized paths with spaces and valid symlinks", async () => {
  const workspace = createCodexWorkspace();
  const targetHome = path.join(workspace.tmpDir, "codex home with spaces");
  const symlinkHome = path.join(workspace.homeDir, "codex home link");
  fs.mkdirSync(targetHome, { recursive: true });
  fs.symlinkSync(targetHome, symlinkHome, "dir");
  const registrySeed = buildCodexRegistry(workspace, {
    globalCodexHome: `${workspace.homeDir}/./codex home link`,
  });
  await serveAlpha(workspace, registrySeed);

  const result = await startCodex(workspace);

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.equal(
    readState(workspace.stateDir).fixtures.tmux.sessions.alpha_codex.env.CODEX_HOME,
    symlinkHome,
  );
});

test("start-codex-session rejects a broken Codex Home symlink before lifecycle mutation", async () => {
  const workspace = createCodexWorkspace();
  const brokenHome = path.join(workspace.homeDir, "broken codex home");
  fs.symlinkSync(path.join(workspace.tmpDir, "missing codex target"), brokenHome, "dir");
  const registrySeed = buildCodexRegistry(workspace, {
    createCodexHomes: false,
    globalCodexHome: brokenHome,
  });
  seedRegistry(workspace, registrySeed);

  const result = await startCodex(workspace);

  assert.notEqual(result.exitCode, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /broken symlink/);
  assertNoLaunch(workspace);
});

test("start-codex-session rejects non-directory and non-writable Codex Homes", async () => {
  const nonDirectoryWorkspace = createCodexWorkspace();
  const nonDirectoryHome = path.join(nonDirectoryWorkspace.homeDir, "codex file");
  fs.writeFileSync(nonDirectoryHome, "not a directory\n");
  seedRegistry(
    nonDirectoryWorkspace,
    buildCodexRegistry(nonDirectoryWorkspace, {
      createCodexHomes: false,
      globalCodexHome: nonDirectoryHome,
    }),
  );
  const nonDirectoryResult = await startCodex(nonDirectoryWorkspace);
  assert.notEqual(nonDirectoryResult.exitCode, 0);
  assert.match(`${nonDirectoryResult.stdout}\n${nonDirectoryResult.stderr}`, /not a directory/);
  assert.deepEqual(readState(nonDirectoryWorkspace.stateDir).fixtures.tmux.sessions, {});

  const permissionWorkspace = createCodexWorkspace();
  const permissionHome = path.join(permissionWorkspace.homeDir, "codex read-only");
  seedRegistry(permissionWorkspace, buildCodexRegistry(permissionWorkspace, { globalCodexHome: permissionHome }));
  fs.chmodSync(permissionHome, 0o555);
  const permissionResult = await startCodex(permissionWorkspace);
  assert.notEqual(permissionResult.exitCode, 0);
  assert.match(`${permissionResult.stdout}\n${permissionResult.stderr}`, /not writable/);
  assert.deepEqual(readState(permissionWorkspace.stateDir).fixtures.tmux.sessions, {});
});

test("start-codex-session rejects a non-writable config.toml before cleanup", async () => {
  const workspace = createCodexWorkspace();
  const codexHome = path.join(workspace.homeDir, ".codex-read-only-config");
  seedRegistry(workspace, buildCodexRegistry(workspace, { globalCodexHome: codexHome }));
  const configPath = path.join(codexHome, "config.toml");
  const originalConfig = "[mcp_servers.discord-stale]\ncommand = \"node\"\n";
  fs.writeFileSync(configPath, originalConfig);
  fs.chmodSync(configPath, 0o444);

  const result = await startCodex(workspace);

  assert.notEqual(result.exitCode, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /config\.toml.*not writable/);
  assert.equal(fs.readFileSync(configPath, "utf8"), originalConfig);
  assert.deepEqual(readState(workspace.stateDir).fixtures.tmux.sessions, {});
});

test("start-codex-session ignores a broken Codex home on an unrelated project", async () => {
  const workspace = createCodexWorkspace();
  const registrySeed = buildCodexRegistry(workspace, {
    extraProjects: {
      beta: {
        path: path.join(workspace.tmpDir, "beta project"),
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
  await serveAlpha(workspace, registrySeed);

  const result = await startCodex(workspace);

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.equal(
    readState(workspace.stateDir).fixtures.tmux.sessions.alpha_codex.env.CODEX_HOME,
    path.join(workspace.homeDir, ".codex"),
  );
  assert.equal(readRegistry(workspace).projects.beta.pid, null);
});

test("start-codex-session expands home-relative selectors and rejects unresolved paths", async () => {
  const successWorkspace = createCodexWorkspace();
  const tildeHome = path.join(successWorkspace.homeDir, ".codex tilde home");
  fs.mkdirSync(tildeHome, { recursive: true });
  const successRegistry = buildCodexRegistry(successWorkspace);
  successRegistry.codex_home = "~/.codex tilde home";
  await serveAlpha(successWorkspace, successRegistry);
  const successResult = await startCodex(successWorkspace);
  assert.equal(successResult.exitCode, 0, successResult.stderr || successResult.stdout);
  assert.equal(
    readState(successWorkspace.stateDir).fixtures.tmux.sessions.alpha_codex.env.CODEX_HOME,
    tildeHome,
  );

  for (const unresolvedPath of ["relative/codex-home", "${HOME}/codex-home"]) {
    const workspace = createCodexWorkspace();
    const registrySeed = buildCodexRegistry(workspace);
    registrySeed.codex_home = unresolvedPath;
    seedRegistry(workspace, registrySeed);
    const result = await startCodex(workspace);
    assert.notEqual(result.exitCode, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /top-level codex_home.*must be absolute or use '~'/);
    assert.deepEqual(readState(workspace.stateDir).fixtures.tmux.sessions, {});
  }
});

test("start-codex-session keeps project Codex homes above the shared home", async () => {
  const workspace = createCodexWorkspace();
  const sharedHome = path.join(workspace.homeDir, ".codex-ccdm");
  const projectHome = path.join(workspace.homeDir, ".codex-api");
  await serveAlpha(workspace, buildCodexRegistry(workspace, {
    codexHome: projectHome,
    globalCodexHome: sharedHome,
  }));

  const result = await startCodex(workspace);

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.equal(readState(workspace.stateDir).fixtures.tmux.sessions.alpha_codex.env.CODEX_HOME, projectHome);
});

test("start-codex-session passes text reply fallback only for flagged Codex projects", async () => {
  const workspace = createCodexWorkspace();
  await serveAlpha(workspace, buildCodexRegistry(workspace, { textReplyFallback: true }));

  const result = await startCodex(workspace);

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  const session = readState(workspace.stateDir).fixtures.tmux.sessions.alpha_codex;
  assert.equal(session.env.CODEX_BRIDGE_TEXT_REPLY_FALLBACK, "1");
});

test("start-codex-session passes per-project Codex config overrides to the bridge", async () => {
  const workspace = createCodexWorkspace();
  await serveAlpha(
    workspace,
    buildCodexRegistry(workspace, {
      codexModel: "gpt-5.6-sol",
      codexReasoningEffort: "high",
      codexServiceTier: "priority",
    }),
  );

  const result = await startCodex(workspace);

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  const session = readState(workspace.stateDir).fixtures.tmux.sessions.alpha_codex;
  assert.equal(session.env.CODEX_MODEL, "gpt-5.6-sol");
  assert.equal(session.env.CODEX_REASONING_EFFORT, "high");
  assert.equal(session.env.CODEX_SERVICE_TIER, "priority");
});

test("start-codex-session allows owner plus project guests", async () => {
  const workspace = createCodexWorkspace();
  await serveAlpha(workspace, buildCodexRegistry(workspace, { guestUserIds: ["222222222222222222"], transport: "router" }));

  const result = await startCodex(workspace);

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  const session = readState(workspace.stateDir).fixtures.tmux.sessions.alpha_codex;
  assert.equal(session.env.ALLOWED_USER_IDS, "allowed-user-id,222222222222222222");
});

test("start-codex-session exits successfully when the target tmux session is already running", async () => {
  const workspace = createCodexWorkspace();
  seedRegistry(workspace, buildCodexRegistry(workspace));
  seedTmuxSession("alpha_codex", { paneOutput: "already running\n" }, { stateDir: workspace.stateDir });

  const result = await startCodex(workspace);

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Session 'alpha_codex' is already running\./);
  assert.equal(readState(workspace.stateDir).fixtures.codex.bridgeInvocations.length, 0);
  assert.equal(readRegistry(workspace).projects.alpha.pid, null);
  // The running launch keeps its key: no new key revokes it.
  assert.equal(fs.existsSync(alphaKeyFile(workspace)), false);
});

test("start-codex-session refuses duplicate bridge and app-server processes from fixture ps state", async () => {
  const bridgeWorkspace = createCodexWorkspace();
  const bridgeRegistry = buildCodexRegistry(bridgeWorkspace);
  seedRegistry(bridgeWorkspace, bridgeRegistry);
  const bridgePid = seedOwnedProcess(
    bridgeWorkspace,
    `node scripts/codex-bridge.js CHANNEL_ID='channel-id' WS_PORT='18399' CCDM_ROUTER_KEY_FILE='${alphaKeyFile(bridgeWorkspace)}'`,
  );

  const bridgeResult = await startCodex(bridgeWorkspace);

  assert.equal(bridgeResult.exitCode, 1);
  assert.match(bridgeResult.stdout, /existing Codex Discord bridge process\(es\)/);
  assert.match(bridgeResult.stdout, new RegExp(String(bridgePid)));
  assert.equal(readState(bridgeWorkspace.stateDir).fixtures.tmux.sessions.alpha_codex, undefined);
  assert.equal(fs.existsSync(alphaKeyFile(bridgeWorkspace)), false);

  const appServerWorkspace = createCodexWorkspace();
  const appServerRegistry = buildCodexRegistry(appServerWorkspace);
  seedRegistry(appServerWorkspace, appServerRegistry);
  const appServerPid = seedOwnedProcess(
    appServerWorkspace,
    "codex app-server --listen ws://127.0.0.1:18342",
  );

  const appServerResult = await startCodex(appServerWorkspace);

  assert.equal(appServerResult.exitCode, 1);
  assert.match(appServerResult.stdout, /channel channel-id or port 18342/);
  assert.match(appServerResult.stdout, new RegExp(String(appServerPid)));
  assert.equal(readState(appServerWorkspace.stateDir).fixtures.tmux.sessions.alpha_codex, undefined);
  assert.equal(fs.existsSync(alphaKeyFile(appServerWorkspace)), false);
});

test("start-codex-session reports current executable failures for registry lookup errors", async () => {
  const missingProject = createCodexWorkspace();
  seedRegistry(missingProject, buildCodexRegistry(missingProject));
  const missingProjectResult = await startCodex(missingProject, { args: ["missing"] });
  assert.notEqual(missingProjectResult.exitCode, 0);
  assert.match(missingProjectResult.stderr, /KeyError: 'missing'/);

  const malformed = createCodexWorkspace();
  fs.writeFileSync(path.join(malformed.repoDir, "registry.json"), "{ not json\n");
  const malformedResult = await startCodex(malformed);
  assert.notEqual(malformedResult.exitCode, 0);
  assert.match(malformedResult.stderr, /JSONDecodeError/);

  // A stale `bot_id` naming no pool bot is not looked up: the lookup passes
  // and the launch reaches the Router bridge (which, with no Router or
  // app-server here, never says hello).
  const staleBot = createCodexWorkspace();
  const staleBotRegistry = buildCodexRegistry(staleBot);
  staleBotRegistry.projects.alpha.bot_id = "bot2";
  seedRegistry(staleBot, staleBotRegistry);
  const staleBotResult = await startCodex(staleBot, { env: { CCDM_CODEX_LAUNCH_TIMEOUT_S: "2" } });
  assert.notEqual(staleBotResult.exitCode, 0);
  assert.doesNotMatch(staleBotResult.stderr, /StopIteration|KeyError|Traceback/);
  assert.match(staleBotResult.stdout, /Started Codex Router bridge in tmux session 'alpha_codex'/);
  assert.match(staleBotResult.stderr, /Codex Router launch failed/);
  assertNoLaunch(staleBot);
});

test("start-codex-session preserves current duplicate channel and port registry behavior", async () => {
  const workspace = createCodexWorkspace();
  const registrySeed = buildCodexRegistry(workspace, {
    extraProjects: {
      beta: {
        path: path.join(workspace.tmpDir, "beta project"),
        screen_name: "beta_codex",
        channel_id: "channel-id",
        type: "codex",
        ws_port: 18342,
        session_id: null,
        pid: null,
      },
    },
  });
  await serveAlpha(workspace, registrySeed, { samePort: ["beta"] });

  const result = await startCodex(workspace);

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  const registry = readRegistry(workspace);
  assert.equal(registry.projects.alpha.ws_port, registry.projects.beta.ws_port);
  assert.equal(typeof registry.projects.alpha.pid, "number");
  assert.equal(registry.projects.beta.pid, null);
  const state = readState(workspace.stateDir);
  assert.ok(state.fixtures.tmux.sessions.alpha_codex);
  assert.equal(state.fixtures.tmux.sessions.beta_codex, undefined);
});

test("project launch never reads a pool token or root .env and carries no bot identity", async () => {
  const workspace = createCodexWorkspace();
  // Leftover pool-era fields: a pool entry for alpha's old bot and no root
  // identity. Root's Discord state holds root-bot-token for the Router alone.
  const registry = buildCodexRegistry(workspace);
  registry.pool = [{ id: "bot2", app_id: "pool-app-id", token: "pool-bot-token", state_dir: path.join(workspace.homeDir, ".claude", "channels", "discord2"), assigned_to: "alpha" }];
  registry.projects.alpha.bot_id = "bot2";
  delete registry.root_bot_app_id;
  await serveAlpha(workspace, registry);

  const result = await startCodex(workspace);

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.doesNotMatch(result.stderr, /Root bot identity missing/);
  const state = readState(workspace.stateDir);
  const session = state.fixtures.tmux.sessions.alpha_codex;
  assert.equal(session.env.CCDM_ROUTER_KEY_FILE, alphaKeyFile(workspace));
  const surfaces = [session.shellCommand, JSON.stringify(session.env), JSON.stringify(state.fixtures.codex.bridgeInvocations), result.stdout, result.stderr];
  for (const text of surfaces) {
    for (const forbidden of ["pool-bot-token", "root-bot-token", "pool-app-id", "BOT_TOKEN", "BOT_APP_ID", "ROOT_BOT_APP_ID", "BOT_DISPLAY_NAME", "GUILD_ID", "DISCORD_STATE_DIR"]) {
      assert.equal(text.includes(forbidden), false, `${forbidden} in ${text.slice(0, 300)}`);
    }
  }
});
