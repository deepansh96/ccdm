import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { createWorkspace, runScript } from "./support/runner.js";
import { readState, seedFixtureProcess, seedRegistry, seedTmuxSession } from "./support/state.js";
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

function buildClaudeRegistry(workspace, options = {}) {
  const projectPath = options.projectPath ?? path.join(workspace.tmpDir, 'project with spaces and "quotes"');
  const stateDir = options.stateDir ?? path.join(workspace.homeDir, ".claude", "channels", "discord2");
  return {
    discord_user_id: "user-id",
    guild_id: "guild-id",
    max_pool_size: 50,
    project_bot_role_id: null,
    category_ids: [],
    pool: [
      {
        id: "bot2",
        app_id: "app-2",
        token: "fixture-token",
        state_dir: stateDir,
        assigned_to: "alpha",
      },
      ...(options.extraPool ?? []),
    ],
    projects: {
      alpha: {
        path: projectPath,
        bot_id: "bot2",
        screen_name: "alpha_session",
        channel_id: "channel-1",
        type: "claude",
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

test("tmux and process fixtures expose Claude listener sessions without host PID leakage", () => {
  const workspace = createWorkspace();
  const projectPath = path.join(workspace.tmpDir, "project with spaces");
  const discordStateDir = path.join(workspace.homeDir, ".claude", "channels", "discord2");
  const launchCommand = `cd '${projectPath}' && DISCORD_STATE_DIR='${discordStateDir}' claude --channels plugin:discord@claude-plugins-official --dangerously-skip-permissions`;

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
  assert.equal(pane.stdout, "Listening for channel messages\n");

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
  assert.match(ps.stdout, /claude --channels plugin:discord@claude-plugins-official --dangerously-skip-permissions/);
  assert.match(ps.stdout, new RegExp(`DISCORD_STATE_DIR='${escapeRegex(discordStateDir)}'`));
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
  assert.equal(state.fixtures.tmux.sessions.project_session.paneOutput, "Listening for channel messages\n");
  assert.equal(state.fixtures.claude.invocations[0].env.DISCORD_STATE_DIR, discordStateDir);
});

test("start-session starts a Claude project through tmux and records PID/session metadata", async () => {
  const workspace = createWorkspace();
  const registrySeed = buildClaudeRegistry(workspace);
  const projectPath = registrySeed.projects.alpha.path;
  const stateDir = registrySeed.pool[0].state_dir;
  seedRegistry(workspace, registrySeed);

  const result = await runScript(workspace, "scripts/start-session.sh", {
    args: ["alpha"],
  });

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Started Discord bot in tmux session 'alpha_session'/);
  assert.match(result.stdout, /Attach with: tmux attach -t alpha_session/);
  assert.match(result.stdout, /Recorded PID \d+ and session fixture-session-\d+/);

  const registry = readRegistry(workspace);
  assert.equal(typeof registry.projects.alpha.pid, "number");
  assert.equal(registry.projects.alpha.session_id, `fixture-session-${registry.projects.alpha.pid}`);

  const state = readState(workspace.stateDir);
  assert.equal(state.fixtures.tmux.sessions.alpha_session.cwd, projectPath);
  assert.equal(state.fixtures.tmux.sessions.alpha_session.env.DISCORD_STATE_DIR, stateDir);
  assert.equal(state.fixtures.tmux.sessions.alpha_session.sendKeys, undefined);
  assert.equal(fs.existsSync(path.join(workspace.homeDir, ".claude", ".claude.json")), false);
});

test("start-session honors claude_home: launches with CLAUDE_CONFIG_DIR and records session metadata from the alternate Claude home", async () => {
  const workspace = createWorkspace();
  const claudeHome = path.join(workspace.homeDir, ".claude-work");
  const registrySeed = buildClaudeRegistry(workspace);
  registrySeed.projects.alpha.claude_home = "~/.claude-work";
  seedRegistry(workspace, registrySeed);

  const result = await runScript(workspace, "scripts/start-session.sh", {
    args: ["alpha"],
  });

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Started Discord bot in tmux session 'alpha_session'/);
  assert.match(result.stdout, /Recorded PID \d+ and session fixture-session-\d+/);

  const registry = readRegistry(workspace);
  const pid = registry.projects.alpha.pid;
  assert.equal(typeof pid, "number");
  assert.equal(registry.projects.alpha.session_id, `fixture-session-${pid}`);

  const state = readState(workspace.stateDir);
  assert.equal(state.fixtures.tmux.sessions.alpha_session.env.CLAUDE_CONFIG_DIR, claudeHome);
  assert.equal(state.fixtures.tmux.sessions.alpha_session.env.DISCORD_STATE_DIR, registrySeed.pool[0].state_dir);
  assert.ok(fs.existsSync(path.join(claudeHome, "sessions", `${pid}.json`)));
  assert.equal(fs.existsSync(path.join(workspace.homeDir, ".claude", "sessions", `${pid}.json`)), false);
});

test("start-session exits successfully when the target tmux session is already running", async () => {
  const workspace = createWorkspace();
  seedRegistry(workspace, buildClaudeRegistry(workspace));
  seedTmuxSession("alpha_session", { paneOutput: "already running\n" }, { stateDir: workspace.stateDir });

  const result = await runScript(workspace, "scripts/start-session.sh", {
    args: ["alpha"],
  });

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Session 'alpha_session' is already running\./);
  assert.equal(readState(workspace.stateDir).fixtures.claude.invocations.length, 0);
  assert.equal(readRegistry(workspace).projects.alpha.pid, null);
});

test("start-session refuses to launch when a Claude Discord listener already owns the state dir", async () => {
  const workspace = createWorkspace();
  const registrySeed = buildClaudeRegistry(workspace);
  const stateDir = registrySeed.pool[0].state_dir;
  seedRegistry(workspace, registrySeed);

  const existing = runFixture(workspace, "tmux", [
    "new-session",
    "-d",
    "-s",
    "other_session",
    "--",
    "zsh",
    "-ic",
    `cd '${workspace.tmpDir}' && DISCORD_STATE_DIR='${stateDir}' claude --channels plugin:discord@claude-plugins-official --dangerously-skip-permissions`,
  ]);
  assert.equal(existing.status, 0, existing.stderr);

  const result = await runScript(workspace, "scripts/start-session.sh", {
    args: ["alpha"],
  });

  assert.equal(result.exitCode, 1);
  assert.match(result.stdout, /Refusing to start 'alpha'/);
  assert.match(result.stdout, new RegExp(escapeRegex(stateDir)));
  assert.match(result.stdout, /Run scripts\/stop-session\.sh 'alpha' first/);
  assert.equal(readState(workspace.stateDir).fixtures.tmux.sessions.alpha_session, undefined);
  assert.equal(readRegistry(workspace).projects.alpha.pid, null);
});

test("start-session reports current executable failures for missing project, malformed registry, and missing bot", async () => {
  const missingProject = createWorkspace();
  seedRegistry(missingProject, { pool: [], projects: {} });
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

  const missingBot = createWorkspace();
  const missingBotRegistry = buildClaudeRegistry(missingBot);
  missingBotRegistry.pool = [];
  seedRegistry(missingBot, missingBotRegistry);
  const missingBotResult = await runScript(missingBot, "scripts/start-session.sh", {
    args: ["alpha"],
  });
  assert.notEqual(missingBotResult.exitCode, 0);
  assert.match(missingBotResult.stderr, /StopIteration/);
});

test("start-session updates only the requested Claude project in a multi-project registry", async () => {
  const workspace = createWorkspace();
  seedRegistry(
    workspace,
    buildClaudeRegistry(workspace, {
      extraPool: [
        {
          id: "bot3",
          app_id: "app-3",
          token: "fixture-token-3",
          state_dir: path.join(workspace.homeDir, ".claude", "channels", "discord3"),
          assigned_to: "beta",
        },
      ],
      extraProjects: {
        beta: {
          path: path.join(workspace.tmpDir, "beta project"),
          bot_id: "bot3",
          screen_name: "beta_session",
          channel_id: "channel-2",
          type: "claude",
          session_id: null,
          pid: null,
        },
      },
    }),
  );

  const result = await runScript(workspace, "scripts/start-session.sh", {
    args: ["alpha"],
  });

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  const registry = readRegistry(workspace);
  assert.equal(typeof registry.projects.alpha.pid, "number");
  assert.equal(registry.projects.beta.pid, null);
  assert.equal(registry.projects.beta.session_id, null);

  const state = readState(workspace.stateDir);
  assert.ok(state.fixtures.tmux.sessions.alpha_session);
  assert.equal(state.fixtures.tmux.sessions.beta_session, undefined);
});
