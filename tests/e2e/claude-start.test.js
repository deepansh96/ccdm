import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { createWorkspace, runScript } from "./support/runner.js";
import { OWNER_ID, createRouterWorkspace, routerEnv, routerWithWebhooks, runRouterCli } from "./support/router.js";
import { readState, seedFixtureProcess, seedRegistry, seedTmuxSession, updateState } from "./support/state.js";
import { cleanup } from "./support/teardown.js";

test.afterEach(async () => {
  await cleanup();
});

function runFixture(workspace, tool, args, options = {}) {
  return spawnSync(path.join(workspace.fixtureDir, tool), args, {
    cwd: workspace.repoDir,
    encoding: "utf8",
    env: {
      ...workspace.env,
      ...(options.env ?? {}),
    },
  });
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Claude has no pool mode: `alpha` names no pool bot and no `transport`, and
// is still served through the Router.
function buildClaudeRegistry(workspace, options = {}) {
  const projectPath = options.projectPath ?? path.join(workspace.tmpDir, 'project with spaces and "quotes"');
  fs.mkdirSync(projectPath, { recursive: true });
  return {
    discord_user_id: OWNER_ID,
    guild_id: "guild-id",
    category_ids: [],
    projects: {
      alpha: {
        path: projectPath,
        screen_name: "alpha_session",
        channel_id: "channel-1",
        type: "claude",
        session_id: null,
        pid: null,
      },
      ...(options.extraProjects?.(workspace) ?? {}),
    },
  };
}

function readRegistry(workspace) {
  return JSON.parse(fs.readFileSync(path.join(workspace.repoDir, "registry.json"), "utf8"));
}

// The Router serves `projects` with their webhooks before a launch says hello.
function seededWorkspace(options = {}) {
  const workspace = createRouterWorkspace({ projects: {} });
  const registry = buildClaudeRegistry(workspace, options);
  options.mutate?.(registry, workspace);
  seedRegistry(workspace, registry);
  return workspace;
}

async function claudeRouterWorkspace(options = {}) {
  const workspace = seededWorkspace(options);
  await routerWithWebhooks(workspace, options.served ?? ["alpha"]);
  return { workspace, registry: readRegistry(workspace) };
}

function startSession(workspace, extraEnv = {}) {
  return runScript(workspace, "scripts/start-session.sh", { args: ["alpha"], env: routerEnv(workspace, extraEnv) });
}

function launchDir(workspace) {
  return path.join(workspace.routerStateDir, "launches", "alpha");
}

test("tmux and process fixtures expose Claude Router sessions without host PID leakage", () => {
  const workspace = createWorkspace();
  const projectPath = path.join(workspace.tmpDir, "project with spaces");
  fs.mkdirSync(projectPath, { recursive: true });
  const keyFile = path.join(workspace.tmpDir, "router", "keys", "project.key");
  const launchCommand = `cd '${projectPath}' && CCDM_ROUTER_KEY_FILE='${keyFile}' claude --dangerously-load-development-channels server:ccdm --dangerously-skip-permissions`;

  const missing = runFixture(workspace, "tmux", ["has-session", "-t", "=project_session"]);
  assert.equal(missing.status, 1);

  const started = runFixture(workspace, "tmux", [
    "new-session",
    "-d",
    "-s",
    "project_session",
    "--",
    "zsh",
    "-ic",
    launchCommand,
  ]);
  assert.equal(started.status, 0, started.stderr);

  const present = runFixture(workspace, "tmux", ["has-session", "-t", "=project_session"]);
  assert.equal(present.status, 0);

  const pane = runFixture(workspace, "tmux", ["capture-pane", "-t", "=project_session", "-p"]);
  assert.equal(pane.status, 0, pane.stderr);
  assert.match(pane.stdout, /Loading development channels/);

  seedFixtureProcess(
    {
      command: "fabricated-host-process",
      owned: true,
      ownerStateDir: "/outside/fixture/state",
      pid: 1,
      ppid: 1,
    },
    { stateDir: workspace.stateDir },
  );

  const ps = runFixture(workspace, "ps", ["axeww", "-o", "pid=,command="]);
  assert.equal(ps.status, 0, ps.stderr);
  assert.match(ps.stdout, /claude --dangerously-load-development-channels server:ccdm --dangerously-skip-permissions/);
  assert.match(ps.stdout, new RegExp(`CCDM_ROUTER_KEY_FILE='${escapeRegex(keyFile)}'`));
  assert.doesNotMatch(ps.stdout, /fabricated-host-process/);

  const state = readState(workspace.stateDir);
  const pgrep = runFixture(workspace, "pgrep", ["-P", String(state.fixtures.processes[0].ppid)]);
  assert.equal(pgrep.status, 0, pgrep.stderr);
  assert.equal(pgrep.stdout.trim(), String(state.fixtures.processes[0].pid));

  const unsupportedPgrep = runFixture(workspace, "pgrep", ["claude"]);
  assert.equal(unsupportedPgrep.status, 2);

  const claudeVersion = runFixture(workspace, "claude", ["--version"]);
  assert.equal(claudeVersion.status, 0, claudeVersion.stderr);
  assert.match(claudeVersion.stdout, /Claude Code fixture/);

  assert.equal(state.fixtures.tmux.sessions.project_session.shellCommand, launchCommand);
  assert.equal(state.fixtures.claude.invocations[0].env.CCDM_ROUTER_KEY_FILE, keyFile);
});

test("the tmux fixture rejects a Claude launch through the official Discord plugin", () => {
  const workspace = createWorkspace();
  const stateDir = path.join(workspace.homeDir, ".claude", "channels", "discord2");
  const started = runFixture(workspace, "tmux", [
    "new-session", "-d", "-s", "project_session", "--", "zsh", "-ic",
    `cd '${workspace.tmpDir}' && DISCORD_STATE_DIR='${stateDir}' claude --channels plugin:discord@claude-plugins-official --dangerously-skip-permissions`,
  ]);
  assert.notEqual(started.status, 0);
  assert.equal(readState(workspace.stateDir).fixtures.tmux.sessions.project_session, undefined);
});

test("a Claude project with no transport field starts through the Router and records PID/session metadata", async () => {
  const { workspace, registry: seeded } = await claudeRouterWorkspace();
  assert.equal("transport" in seeded.projects.alpha, false);
  const projectPath = seeded.projects.alpha.path;

  const result = await startSession(workspace);

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Started Claude Router session in tmux session 'alpha_session'/);
  assert.match(result.stdout, /Channel server connected to the Router \(scope channel-1\)/);
  assert.match(result.stdout, /Attach with: tmux attach -t alpha_session/);
  assert.match(result.stdout, /Recorded PID \d+ and session fixture-session-\d+/);

  const registry = readRegistry(workspace);
  assert.equal(typeof registry.projects.alpha.pid, "number");
  assert.equal(registry.projects.alpha.session_id, `fixture-session-${registry.projects.alpha.pid}`);
  const status = await runRouterCli(workspace, ["status"]);
  assert.match(status.stdout, /project alpha scope=channel-1 connected=/);

  const session = readState(workspace.stateDir).fixtures.tmux.sessions.alpha_session;
  assert.equal(session.cwd, projectPath);
  assert.equal(session.env.CCDM_ROUTER_KEY_FILE, path.join(workspace.routerStateDir, "keys", "alpha.key"));
  assert.deepEqual(session.sendKeys, [["Enter"]]);
  const mcpConfigPath = path.join(launchDir(workspace), "mcp.json");
  const mcpConfig = JSON.parse(fs.readFileSync(mcpConfigPath, "utf8"));
  assert.deepEqual(Object.keys(mcpConfig.mcpServers), ["ccdm"]);
  assert.deepEqual(mcpConfig.mcpServers.ccdm.args, [path.join(workspace.repoDir, "scripts", "ccdm-channel-server.js")]);
  assert.equal(mcpConfig.mcpServers.ccdm.env.CCDM_CLAUDE_CHANNEL_ID, "channel-1");
  assert.equal(fs.statSync(mcpConfigPath).mode & 0o777, 0o600);
  assert.match(session.shellCommand, /--mcp-config/);
  assert.equal(fs.existsSync(path.join(workspace.homeDir, ".claude", ".claude.json")), false);
});

test("a Claude project without a webhook_id is refused before any key, launch file, tmux session, or PID", async () => {
  const workspace = seededWorkspace();
  assert.equal("webhook_id" in readRegistry(workspace).projects.alpha, false);

  const result = await startSession(workspace);

  assert.equal(result.exitCode, 1, result.stderr || result.stdout);
  assert.match(result.stderr, /Refusing to start 'alpha': it has no webhook_id, so its replies could not be posted\. Run scripts\/migrate-to-router\.sh alpha/);
  assert.deepEqual(readState(workspace.stateDir).fixtures.tmux.sessions, {});
  assert.equal(fs.existsSync(path.join(workspace.routerStateDir, "keys", "alpha.key")), false);
  assert.equal(fs.existsSync(launchDir(workspace)), false);
  assert.deepEqual(readRegistry(workspace).projects.alpha, buildClaudeRegistry(workspace).projects.alpha);
});

test("no Claude launch passes a Discord token, DISCORD_STATE_DIR, the official plugin channel, or the reminder proxy", async () => {
  // The retired reminder-adapter opt-in and a stale pool bot entry change nothing.
  const { workspace } = await claudeRouterWorkspace({
    mutate: (registry, workspace) => {
      registry.pool = [{ id: "bot2", app_id: "app-2", token: "pool-bot-token",
        state_dir: path.join(workspace.homeDir, ".claude", "channels", "discord2"), assigned_to: "alpha" }];
      registry.projects.alpha.bot_id = "bot2";
      registry.projects.alpha.transport = "pool";
    },
  });

  const result = await startSession(workspace, { CCDM_CLAUDE_REMINDER_ADAPTER: "1" });

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  const state = readState(workspace.stateDir);
  const session = state.fixtures.tmux.sessions.alpha_session;
  assert.match(session.shellCommand, /--dangerously-load-development-channels server:ccdm/);
  const surfaces = [
    session.shellCommand,
    JSON.stringify(state.fixtures.claude.invocations),
    JSON.stringify(state.fixtures.claude.sessionEnvironments),
    ...fs.readdirSync(launchDir(workspace)).map((file) => fs.readFileSync(path.join(launchDir(workspace), file), "utf8")),
  ];
  for (const text of surfaces) {
    for (const forbidden of ["pool-bot-token", "root-bot-token", "DISCORD_BOT_TOKEN", "DISCORD_STATE_DIR",
      "plugin:discord", "server:discord", "claude-reminder-channel", "DISCORD_MCP_EXPORT_ONLY", "discord-message-export"]) {
      assert.equal(text.includes(forbidden), false, `${forbidden} reached ${text.slice(0, 200)}`);
    }
  }
  assert.equal(fs.existsSync(path.join(workspace.homeDir, ".claude", "channels", "discord2")), false);
  const settings = JSON.parse(fs.readFileSync(path.join(launchDir(workspace), "settings.json"), "utf8"));
  assert.equal(settings.enabledPlugins["discord@claude-plugins-official"], false);
});

test("start-session honors Claude model and effort overrides", async () => {
  const { workspace } = await claudeRouterWorkspace({
    mutate: (registry) => {
      registry.projects.alpha.model = "claude-fable-5";
      registry.projects.alpha.claude_effort = "high";
    },
  });

  const result = await startSession(workspace);

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  const state = readState(workspace.stateDir);
  assert.match(
    state.fixtures.tmux.sessions.alpha_session.shellCommand,
    /--model 'claude-fable-5' --effort 'high'/,
  );
});

for (const effort of ["invalid", "high\tbad", "high\nbad", "__NONE__", false, 0, 1, [], {}]) {
  test(`start-session rejects invalid Claude effort ${JSON.stringify(effort)} before side effects`, async () => {
    const workspace = seededWorkspace({ mutate: (registry) => { registry.projects.alpha.claude_effort = effort; } });
    const registryBefore = fs.readFileSync(path.join(workspace.repoDir, "registry.json"), "utf8");

    const result = await startSession(workspace);

    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /Invalid claude_effort/);
    const state = readState(workspace.stateDir);
    assert.equal(state.fixtures.claude.invocations.length, 0);
    assert.equal(state.fixtures.tmux.sessions.alpha_session, undefined);
    assert.equal(fs.existsSync(launchDir(workspace)), false);
    assert.equal(fs.existsSync(path.join(workspace.routerStateDir, "keys", "alpha.key")), false);
    assert.equal(fs.readFileSync(path.join(workspace.repoDir, "registry.json"), "utf8"), registryBefore);
  });
}

for (const effort of [undefined, null, "", "low", "medium", "high", "xhigh", "max"]) {
  test(`start-session preserves account and channel with Claude effort ${JSON.stringify(effort)}`, async () => {
    const { workspace, registry } = await claudeRouterWorkspace({
      mutate: (seed) => {
        seed.projects.alpha.claude_effort = effort;
        seed.projects.alpha.claude_home = "~/.claude-work";
      },
    });

    const result = await startSession(workspace);

    assert.equal(result.exitCode, 0, result.stderr || result.stdout);
    const session = readState(workspace.stateDir).fixtures.tmux.sessions.alpha_session;
    assert.equal(session.env.CLAUDE_CONFIG_DIR, path.join(workspace.homeDir, ".claude-work"));
    if (effort) assert.ok(session.shellCommand.includes(`--effort '${effort}'`));
    else assert.doesNotMatch(session.shellCommand, /--effort/);
    const mcpConfig = JSON.parse(fs.readFileSync(path.join(launchDir(workspace), "mcp.json"), "utf8"));
    assert.equal(mcpConfig.mcpServers.ccdm.env.CCDM_CLAUDE_CHANNEL_ID, registry.projects.alpha.channel_id);
  });
}

test("start-session honors claude_home: launches with CLAUDE_CONFIG_DIR and records session metadata from the alternate Claude home", async () => {
  const { workspace } = await claudeRouterWorkspace({
    mutate: (registry) => { registry.projects.alpha.claude_home = "~/.claude-work"; },
  });
  const claudeHome = path.join(workspace.homeDir, ".claude-work");

  const result = await startSession(workspace);

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Started Claude Router session in tmux session 'alpha_session'/);
  assert.match(result.stdout, /Recorded PID \d+ and session fixture-session-\d+/);

  const registry = readRegistry(workspace);
  const pid = registry.projects.alpha.pid;
  assert.equal(typeof pid, "number");
  assert.equal(registry.projects.alpha.session_id, `fixture-session-${pid}`);

  const state = readState(workspace.stateDir);
  assert.equal(state.fixtures.tmux.sessions.alpha_session.env.CLAUDE_CONFIG_DIR, claudeHome);
  assert.equal(state.fixtures.tmux.sessions.alpha_session.env.DISCORD_STATE_DIR, undefined);
  assert.ok(fs.existsSync(path.join(claudeHome, "sessions", `${pid}.json`)));
  assert.equal(fs.existsSync(path.join(workspace.homeDir, ".claude", "sessions", `${pid}.json`)), false);
});

const RESUME_ID = "3f1c2b7a-9d4e-4c1a-8b2f-5e6d7c8a9b0c";

// Claude keeps each transcript at <home>/projects/<cwd, non-alphanumerics as "-">/<id>.jsonl.
function writeTranscript(claudeHome, projectPath, sessionId = RESUME_ID) {
  const dir = path.join(claudeHome, "projects", projectPath.replace(/[^A-Za-z0-9]/g, "-"));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), "{}\n");
}

function startResume(workspace, id = RESUME_ID, extraEnv = {}) {
  return runScript(workspace, "scripts/start-session.sh", { args: ["alpha", "--resume", id], env: routerEnv(workspace, extraEnv) });
}

function assertNothingLaunched(workspace, registryBefore) {
  const state = readState(workspace.stateDir);
  assert.equal(state.fixtures.claude.invocations.length, 0);
  assert.deepEqual(state.fixtures.tmux.sessions, {});
  assert.equal(fs.existsSync(path.join(workspace.routerStateDir, "keys", "alpha.key")), false);
  assert.equal(fs.existsSync(launchDir(workspace)), false);
  assert.equal(fs.readFileSync(path.join(workspace.repoDir, "registry.json"), "utf8"), registryBefore);
}

test("start-session --resume launches claude --resume <id> from the project's claude_home and records that session", async () => {
  const { workspace, registry: seeded } = await claudeRouterWorkspace({
    mutate: (registry) => { registry.projects.alpha.claude_home = "~/.claude-work"; },
  });
  writeTranscript(path.join(workspace.homeDir, ".claude-work"), seeded.projects.alpha.path);

  const result = await startResume(workspace);

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.match(result.stdout, new RegExp(`Started Claude Router session in tmux session 'alpha_session' \\(resuming ${RESUME_ID}\\)`));
  assert.match(result.stdout, /Channel server connected to the Router/);
  const state = readState(workspace.stateDir);
  assert.equal(state.fixtures.claude.invocations.length, 1);
  assert.match(state.fixtures.tmux.sessions.alpha_session.shellCommand, new RegExp(`--resume '${RESUME_ID}'`));
  assert.equal(readRegistry(workspace).projects.alpha.session_id, RESUME_ID);
});

test("start-session --resume refuses a transcript missing from the project's Claude home before any side effect", async () => {
  const workspace = seededWorkspace({ mutate: (registry) => {
    registry.projects.alpha.webhook_id = "webhook-alpha";
    registry.projects.alpha.claude_home = "~/.claude-work";
  } });
  // Present in the default home only: the project's own home is what counts.
  writeTranscript(path.join(workspace.homeDir, ".claude"), readRegistry(workspace).projects.alpha.path);
  const registryBefore = fs.readFileSync(path.join(workspace.repoDir, "registry.json"), "utf8");

  const result = await startResume(workspace);

  assert.equal(result.exitCode, 1, result.stdout);
  assert.match(result.stderr, new RegExp(`No saved Claude transcript for session ${RESUME_ID} in ${escapeRegex(path.join(workspace.homeDir, ".claude-work"))}`));
  assert.match(result.stderr, /Refusing to resume 'alpha': its transcript is missing/);
  assertNothingLaunched(workspace, registryBefore);
});

for (const args of [["alpha", "--resume", "not-a-uuid"], ["alpha", "--resume", RESUME_ID.toUpperCase()], ["alpha", "--resume"], ["alpha", "--fork", RESUME_ID]]) {
  test(`start-session rejects ${JSON.stringify(args.slice(1))} before side effects`, async () => {
    const workspace = seededWorkspace({ mutate: (registry) => { registry.projects.alpha.webhook_id = "webhook-alpha"; } });
    const registryBefore = fs.readFileSync(path.join(workspace.repoDir, "registry.json"), "utf8");

    const result = await runScript(workspace, "scripts/start-session.sh", { args, env: routerEnv(workspace) });

    assert.equal(result.exitCode, 1, result.stdout);
    assert.match(result.stderr, /Resume session must be a canonical UUID|Usage: .* <project_name> \[--resume <session_id>\]/);
    assertNothingLaunched(workspace, registryBefore);
  });
}

test("start-session --resume whose launch fails exits non-zero, cleans up, and does not start a fresh session", async () => {
  const { workspace, registry: seeded } = await claudeRouterWorkspace();
  writeTranscript(path.join(workspace.homeDir, ".claude"), seeded.projects.alpha.path);
  updateState(workspace.stateDir, (state) => { state.fixtures.tmux.devChannelPrompt = "never"; });

  const result = await startResume(workspace, RESUME_ID, { CCDM_CLAUDE_LAUNCH_TIMEOUT_S: "1" });

  assert.notEqual(result.exitCode, 0, result.stdout);
  assert.match(result.stderr, /Launch of 'alpha' failed; cleaning up/);
  const state = readState(workspace.stateDir);
  assert.equal(state.fixtures.claude.invocations.length, 1);
  assert.ok(state.fixtures.claude.invocations[0].args.some((arg) => arg.includes(RESUME_ID)));
  assert.equal(state.fixtures.tmux.sessions.alpha_session, undefined);
  assert.equal(fs.existsSync(path.join(workspace.routerStateDir, "keys", "alpha.key")), false);
  assert.equal(readRegistry(workspace).projects.alpha.pid, null);
});

test("start-session --resume refuses, rather than silently skipping the resume, when the session is already running", async () => {
  const workspace = seededWorkspace();
  seedTmuxSession("alpha_session", { paneOutput: "already running\n" }, { stateDir: workspace.stateDir });

  const result = await startResume(workspace);

  assert.equal(result.exitCode, 1, result.stdout);
  assert.match(result.stderr, /Refusing to resume 'alpha': session 'alpha_session' is already running/);
  assert.equal(readState(workspace.stateDir).fixtures.claude.invocations.length, 0);
});

test("start-session exits successfully when the target tmux session is already running", async () => {
  const workspace = seededWorkspace();
  seedTmuxSession("alpha_session", { paneOutput: "already running\n" }, { stateDir: workspace.stateDir });

  const result = await startSession(workspace);

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Session 'alpha_session' is already running\./);
  assert.equal(readState(workspace.stateDir).fixtures.claude.invocations.length, 0);
  assert.equal(readRegistry(workspace).projects.alpha.pid, null);
});

test("start-session refuses to launch when a Claude Router listener already holds the project's key file", async () => {
  const workspace = seededWorkspace();
  const keyFile = path.join(workspace.routerStateDir, "keys", "alpha.key");

  const existing = runFixture(workspace, "tmux", [
    "new-session",
    "-d",
    "-s",
    "other_session",
    "--",
    "zsh",
    "-ic",
    `cd '${workspace.tmpDir}' && CCDM_ROUTER_KEY_FILE='${keyFile}' claude --dangerously-load-development-channels server:ccdm --dangerously-skip-permissions`,
  ]);
  assert.equal(existing.status, 0, existing.stderr);

  const result = await startSession(workspace);

  assert.equal(result.exitCode, 1);
  assert.match(result.stdout, /Refusing to start 'alpha'/);
  assert.match(result.stdout, new RegExp(escapeRegex(keyFile)));
  assert.match(result.stdout, /Run scripts\/stop-session\.sh 'alpha' first/);
  assert.equal(readState(workspace.stateDir).fixtures.tmux.sessions.alpha_session, undefined);
  assert.equal(readRegistry(workspace).projects.alpha.pid, null);
});

test("start-session reports current executable failures for missing project and malformed registry", async () => {
  const missingProject = createWorkspace();
  seedRegistry(missingProject, { projects: {} });
  const missingProjectResult = await runScript(missingProject, "scripts/start-session.sh", {
    args: ["alpha"],
  });
  assert.notEqual(missingProjectResult.exitCode, 0);
  assert.match(missingProjectResult.stderr, /KeyError: 'alpha'/);

  const malformed = createWorkspace();
  fs.writeFileSync(path.join(malformed.repoDir, "registry.json"), "{ not json\n");
  const malformedResult = await runScript(malformed, "scripts/start-session.sh", {
    args: ["alpha"],
  });
  assert.notEqual(malformedResult.exitCode, 0);
  assert.match(malformedResult.stderr, /JSONDecodeError/);
});

test("start-session updates only the requested Claude project in a multi-project registry", async () => {
  const { workspace } = await claudeRouterWorkspace({
    extraProjects: (workspace) => ({
      beta: {
        path: workspace.tmpDir,
        screen_name: "beta_session",
        channel_id: "channel-2",
        type: "claude",
        session_id: null,
        pid: null,
      },
    }),
    served: ["alpha", "beta"],
  });

  const result = await startSession(workspace);

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  const registry = readRegistry(workspace);
  assert.equal(typeof registry.projects.alpha.pid, "number");
  assert.equal(registry.projects.beta.pid, null);
  assert.equal(registry.projects.beta.session_id, null);

  const state = readState(workspace.stateDir);
  assert.ok(state.fixtures.tmux.sessions.alpha_session);
  assert.equal(state.fixtures.tmux.sessions.beta_session, undefined);
});
