import assert from "node:assert/strict";
import { execFile, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { PYTHON, assertPrivate, platformGate } from "./support/platform.js";
import { createWorkspace, runScript } from "./support/runner.js";
import { OWNER_ID, createRouterWorkspace, routerEnv, routerWithWebhooks, runRouterCli } from "./support/router.js";
import { AUTO_MODE_OFFER, startFakeHost } from "./support/session-fixture.js";
import { readState, seedFixtureProcess, seedRegistry, seedTmuxSession, updateState } from "./support/state.js";
import { cleanup, registerTeardownCallback } from "./support/teardown.js";

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
  const projectPath = options.projectPath ?? path.join(workspace.tmpDir, "project with spaces & 50% off!");
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

// Windows has no tmux, so a launch there goes through the fake ccdm-host. POSIX
// runs the launcher on tmux and, for the cases that matter on both, on the host too.
const WIN = process.platform === "win32";
// A Windows temp folder can carry a short (8.3) name; the `ccdm` entry starts Python from the long one.
const repoAsLaunched = workspace => (WIN ? fs.realpathSync.native(workspace.repoDir) : workspace.repoDir);
const DEFAULT_BACKEND = WIN ? "ccdm-host" : "tmux";
const BACKENDS = WIN ? ["ccdm-host"] : ["tmux", "ccdm-host"];
const SESSION_WORD = WIN ? "session" : "tmux session";
const ATTACH_HINT = WIN ? "Attach with: scripts/ccdm attach alpha" : "Attach with: tmux attach -t alpha_session";
const LAUNCH_TIMEOUT_MS = WIN ? 30000 : undefined;

const fakeHosts = new WeakMap();
async function backendEnv(workspace, backend = DEFAULT_BACKEND) {
  if (backend === "tmux") return { CCDM_SESSION_HOST: "tmux" };
  if (!fakeHosts.has(workspace)) fakeHosts.set(workspace, await startFakeHost(workspace, { env: routerEnv(workspace) }));
  return fakeHosts.get(workspace).env;
}

async function startSession(workspace, extraEnv = {}, backend = DEFAULT_BACKEND) {
  return runScript(workspace, "scripts/start-session.sh", {
    args: ["alpha"],
    env: routerEnv(workspace, { ...(await backendEnv(workspace, backend)), ...extraEnv }),
    timeoutMs: LAUNCH_TIMEOUT_MS,
  });
}

// What a launch ran: the tmux string, or the argv the fake host received.
const launchText = session => session.shellCommand ?? session.command.join(" ");
// A value in `launchText`: quoted in the tmux string, plain in an argv.
const launched = (session, value) => (session.shellCommand ? `'${value}'` : value);

function launchDir(workspace) {
  return path.join(workspace.routerStateDir, "launches", "alpha");
}

test("tmux and process fixtures expose Claude Router sessions without host PID leakage", platformGate("posix", "the fixture tmux and ps exist on POSIX; Windows has the fake ccdm-host"), () => {
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

test("the tmux fixture rejects a Claude launch through the official Discord plugin", platformGate("posix", "the fixture tmux exists on POSIX; Windows has the fake ccdm-host"), () => {
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
  assert.match(result.stdout, new RegExp(`Started Claude Router session in ${SESSION_WORD} 'alpha_session'`));
  assert.match(result.stdout, /Channel server connected to the Router \(scope channel-1\)/);
  assert.match(result.stdout, new RegExp(ATTACH_HINT));
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
  const serverScript = path.join(repoAsLaunched(workspace), "scripts", "ccdm-channel-server.js");
  const keyFile = path.join(workspace.routerStateDir, "keys", "alpha.key");
  assert.deepEqual(mcpConfig.mcpServers.ccdm.args, WIN ? [serverScript, "--ccdm-key-file", keyFile] : [serverScript]);
  assert.equal(mcpConfig.mcpServers.ccdm.env.CCDM_CLAUDE_CHANNEL_ID, "channel-1");
  assertPrivate(mcpConfigPath);
  assert.match(launchText(session), /--mcp-config/);
  assert.equal(fs.existsSync(path.join(workspace.homeDir, ".claude", ".claude.json")), false);
});

test("a Claude project without a webhook_id is refused before any key, launch file, tmux session, or PID", async () => {
  const workspace = seededWorkspace();
  assert.equal("webhook_id" in readRegistry(workspace).projects.alpha, false);

  const result = await startSession(workspace);

  assert.equal(result.exitCode, 1, result.stderr || result.stdout);
  const migrate = WIN ? "scripts/ccdm migrate-to-router" : "scripts/migrate-to-router.sh";
  assert.ok(result.stderr.includes(`Refusing to start 'alpha': it has no webhook_id, so its replies could not be posted. Run ${migrate} alpha`), result.stderr);
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
  assert.match(launchText(session), /--dangerously-load-development-channels server:ccdm/);
  const surfaces = [
    launchText(session),
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
  const session = readState(workspace.stateDir).fixtures.tmux.sessions.alpha_session;
  assert.ok(launchText(session).includes(`--model ${launched(session, "claude-fable-5")} --effort ${launched(session, "high")}`));
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
    if (effort) assert.ok(launchText(session).includes(`--effort ${launched(session, effort)}`));
    else assert.doesNotMatch(launchText(session), /--effort/);
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
  assert.match(result.stdout, new RegExp(`Started Claude Router session in ${SESSION_WORD} 'alpha_session'`));
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

async function startResume(workspace, id = RESUME_ID, extraEnv = {}) {
  return runScript(workspace, "scripts/start-session.sh", {
    args: ["alpha", "--resume", id],
    env: routerEnv(workspace, { ...(await backendEnv(workspace)), ...extraEnv }),
    timeoutMs: LAUNCH_TIMEOUT_MS,
  });
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
  assert.match(result.stdout, new RegExp(`Started Claude Router session in ${SESSION_WORD} 'alpha_session' \\(resuming ${RESUME_ID}\\)`));
  assert.match(result.stdout, /Channel server connected to the Router/);
  const state = readState(workspace.stateDir);
  assert.equal(state.fixtures.claude.invocations.length, 1);
  const session = state.fixtures.tmux.sessions.alpha_session;
  assert.ok(launchText(session).includes(`--resume ${launched(session, RESUME_ID)}`));
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

    const result = await runScript(workspace, "scripts/start-session.sh", { args, env: routerEnv(workspace, await backendEnv(workspace)) });

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

test("start-session refuses to launch when a Claude Router listener already holds the project's key file", platformGate("posix", "POSIX finds listeners by their environment; the Windows case is below"), async () => {
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

// ---- what the launcher does on both backends ----

function settledHome(workspace) {
  return path.join(workspace.homeDir, ".claude");
}

function launchRecord(workspace, name = "alpha_session") {
  return readState(workspace.stateDir).fixtures.sessionHost.launches.findLast(launch => launch.name === name);
}

// Runs `_launch.py` against the workspace's fixture session, as a launcher would.
const LAUNCH_DRIVER = `
import sys
sys.dont_write_bytecode = True
import json, time
sys.path.insert(0, sys.argv[1])
from ccdmlib.cli import _launch
name, cwd, project_path, timeout = json.loads(sys.argv[2])
try:
    _launch.accept_dialogs(name, cwd, project_path, time.monotonic() + timeout)
    print(json.dumps({"ok": True}))
except _launch.LaunchFailed as error:
    print(json.dumps({"ok": False, "message": str(error)}))
`;

async function runAcceptDialogs(workspace, name, cwd, projectPath, { backend = DEFAULT_BACKEND, timeout = 5 } = {}) {
  const env = { ...workspace.env, PYTHONUTF8: "1", ...(await backendEnv(workspace, backend)) };
  const child = spawn(PYTHON, ["-c", LAUNCH_DRIVER, path.join(workspace.repoDir, "scripts"), JSON.stringify([name, cwd, projectPath, timeout])],
    { cwd: workspace.tmpRoot, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  const exited = new Promise(resolve => child.once("close", resolve));
  return { child, exited, output: () => ({ stdout, stderr }) };
}

async function acceptDialogsResult(workspace, ...rest) {
  const run = await runAcceptDialogs(workspace, ...rest);
  await run.exited;
  const { stdout, stderr } = run.output();
  try {
    return JSON.parse(stdout.trim());
  } catch {
    throw new Error(`accept_dialogs driver printed no result: ${stderr}${stdout}`);
  }
}

const PROMPT_SCREEN = "WARNING: Loading development channels\n\n--dangerously-load-development-channels is for local channel development only.\n";

for (const backend of BACKENDS) {
  test(`${backend}: a launch that shows the folder-trust prompt, then the channel prompt, is accepted and reaches the Router`, async () => {
    const { workspace } = await claudeRouterWorkspace();
    updateState(workspace.stateDir, (state) => { state.fixtures.claude.trustPrompt = true; });

    const result = await startSession(workspace, {}, backend);

    assert.equal(result.exitCode, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Channel server connected to the Router/);
    const session = readState(workspace.stateDir).fixtures.tmux.sessions.alpha_session;
    assert.deepEqual(session.sendKeys, [["Enter"], ["Enter"]]);
    assert.equal(session.trustPrompt, "accepted");
    assert.equal(session.devChannelPrompt, "accepted");
    const status = await runRouterCli(workspace, ["status"]);
    assert.match(status.stdout, /project alpha scope=channel-1 connected=/);
  });

  test(`${backend}: the auto-mode offer gets Esc once and the launch still reaches the Router`, async () => {
    const { workspace } = await claudeRouterWorkspace();
    updateState(workspace.stateDir, (state) => { state.fixtures.claude.autoModeOffer = true; });

    const result = await startSession(workspace, {}, backend);

    assert.equal(result.exitCode, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Channel server connected to the Router/);
    assert.deepEqual(readState(workspace.stateDir).fixtures.tmux.sessions.alpha_session.sendKeys, [["Escape"], ["Enter"]]);
  });

  test(`${backend}: an auto-mode offer still on screen after Esc does not get a second Esc`, async () => {
    const workspace = seededWorkspace();
    const projectPath = readRegistry(workspace).projects.alpha.path;
    seedTmuxSession("alpha_session", { paneOutput: AUTO_MODE_OFFER }, { stateDir: workspace.stateDir });

    const run = await runAcceptDialogs(workspace, "alpha_session", projectPath, projectPath, { backend, timeout: 10 });
    await new Promise(resolve => setTimeout(resolve, 1000));
    updateState(workspace.stateDir, (state) => { state.fixtures.tmux.sessions.alpha_session.paneOutput = PROMPT_SCREEN; });
    await run.exited;

    assert.deepEqual(JSON.parse(run.output().stdout.trim()), { ok: true });
    assert.deepEqual(readState(workspace.stateDir).fixtures.tmux.sessions.alpha_session.sendKeys, [["Escape"], ["Enter"]]);
  });

  test(`${backend}: a channel prompt that never appears fails at the deadline with today's message`, async () => {
    const { workspace } = await claudeRouterWorkspace();
    updateState(workspace.stateDir, (state) => { state.fixtures.tmux.devChannelPrompt = "never"; });

    const result = await startSession(workspace, { CCDM_CLAUDE_LAUNCH_TIMEOUT_S: "1" }, backend);

    assert.equal(result.exitCode, 1, result.stdout);
    assert.match(result.stderr, /The development-channel confirmation never appeared/);
    assert.match(result.stderr, /Launch of 'alpha' failed; cleaning up/);
    assert.equal(readState(workspace.stateDir).fixtures.tmux.sessions.alpha_session, undefined);
    assert.equal(fs.existsSync(path.join(workspace.routerStateDir, "keys", "alpha.key")), false);
  });

  test(`${backend}: a folder-trust prompt in a session outside the project's registry path is not accepted, naming both paths`, async () => {
    const workspace = seededWorkspace();
    const projectPath = readRegistry(workspace).projects.alpha.path;
    const elsewhere = path.join(workspace.tmpDir, "somewhere else");
    seedTmuxSession("alpha_session", { paneOutput: "Do you trust the files in this folder?\n\nIs this a project you created or one you trust?\n" }, { stateDir: workspace.stateDir });

    const result = await acceptDialogsResult(workspace, "alpha_session", elsewhere, projectPath, { backend });

    assert.equal(result.ok, false);
    assert.ok(result.message.includes(elsewhere), result.message);
    assert.ok(result.message.includes(projectPath), result.message);
    assert.equal(readState(workspace.stateDir).fixtures.tmux.sessions.alpha_session.sendKeys, undefined);
  });

  test(`${backend}: an already-trusted launch accepts the channel prompt within 1 s of it appearing`, async () => {
    const workspace = seededWorkspace();
    const projectPath = readRegistry(workspace).projects.alpha.path;
    seedTmuxSession("alpha_session", { paneOutput: "Starting Claude Code\n" }, { stateDir: workspace.stateDir });

    const run = await runAcceptDialogs(workspace, "alpha_session", projectPath, projectPath, { backend, timeout: 10 });
    await new Promise(resolve => setTimeout(resolve, 800));
    const appeared = performance.now();
    updateState(workspace.stateDir, (state) => { state.fixtures.tmux.sessions.alpha_session.paneOutput = PROMPT_SCREEN; });

    for (;;) {
      if (readState(workspace.stateDir).fixtures.tmux.sessions.alpha_session.sendKeys) break;
      assert.ok(performance.now() - appeared < 1000, "Enter was not sent within 1 s of the channel prompt");
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    await run.exited;
    assert.deepEqual(readState(workspace.stateDir).fixtures.tmux.sessions.alpha_session.sendKeys, [["Enter"]]);
    assert.deepEqual(JSON.parse(run.output().stdout.trim()), { ok: true });
  });

  test(`${backend}: the recorded PID is the Claude process, with its session id`, async () => {
    const { workspace } = await claudeRouterWorkspace();

    const result = await startSession(workspace, {}, backend);

    assert.equal(result.exitCode, 0, result.stderr || result.stdout);
    const { pid, session_id: sessionId, pid_started_at: startedAt } = readRegistry(workspace).projects.alpha;
    assert.equal(pid, launchRecord(workspace).pid);
    assert.equal(sessionId, `fixture-session-${pid}`);
    assert.ok(fs.existsSync(path.join(settledHome(workspace), "sessions", `${pid}.json`)));
    if (WIN) assert.match(startedAt, /^\d+$/);
    else assert.equal(startedAt, undefined);
  });

  test(`${backend}: a Claude that writes no session file is still recorded by its PID, with no session id`, async () => {
    const { workspace } = await claudeRouterWorkspace();
    updateState(workspace.stateDir, (state) => { state.fixtures.claude.omitSessionFile = true; });

    // The launcher waits about 10 s for the session id before it records the PID alone.
    const result = await runScript(workspace, "scripts/start-session.sh", {
      args: ["alpha"], env: routerEnv(workspace, await backendEnv(workspace, backend)), timeoutMs: 40000,
    });

    assert.equal(result.exitCode, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Recorded PID \d+; session_id not found yet/);
    const { pid, session_id: sessionId, pid_started_at: startedAt } = readRegistry(workspace).projects.alpha;
    assert.equal(pid, launchRecord(workspace).pid);
    assert.equal(sessionId, null);
    if (WIN) assert.match(startedAt, /^\d+$/);
  });
}

// `find_claude_process` with a shorter wait: prints `[pid, start time]`.
const FIND_CLAUDE_DRIVER = `
import sys
sys.dont_write_bytecode = True
import json
sys.path.insert(0, sys.argv[1])
from ccdmlib.cli import _launch
_launch._PID_ROUNDS = 8
print(json.dumps(_launch.find_claude_process(*json.loads(sys.argv[2]))))
`;

test("on Windows a host session's Claude with no session file is found by its command line, and only inside its session", platformGate("win32", "reads real command lines; POSIX reads the key file from the environment, in the launch above"), async () => {
  const workspace = seededWorkspace();
  const env = { ...workspace.env, PYTHONUTF8: "1", ...(await backendEnv(workspace)) };
  const mcpConfig = path.join(launchDir(workspace), "mcp.json");
  const channelFlags = ["--dangerously-load-development-channels", "server:ccdm"];
  // `--` keeps Node from reading the flags as its own options.
  const idle = (...args) => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "--", ...args], { stdio: "ignore", windowsHide: true });
    const exited = new Promise(resolve => child.once("exit", resolve));
    registerTeardownCallback(async () => {
      child.kill();
      await exited;
    });
    return child.pid;
  };
  const find = () => new Promise((resolve, reject) => {
    const args = ["alpha_session", path.join(workspace.routerStateDir, "keys", "alpha.key"), settledHome(workspace), launchDir(workspace)];
    execFile(PYTHON, ["-c", FIND_CLAUDE_DRIVER, path.join(workspace.repoDir, "scripts"), JSON.stringify(args)],
      { cwd: workspace.tmpRoot, env, encoding: "utf8", windowsHide: true }, (error, stdout, stderr) => {
        if (error) return reject(new Error(`${error.message}: ${stderr}`));
        resolve(JSON.parse(stdout.trim().split("\n").at(-1)));
      });
  });
  // In the session: a process that only names this launch's mcp.json, and another launch's Claude.
  const bystander = idle("--mcp-config", mcpConfig);
  const otherLaunch = idle(...channelFlags, "--mcp-config", path.join(workspace.routerStateDir, "launches", "beta", "mcp.json"));
  // Outside the session: a process with exactly this launch's Claude arguments.
  idle(...channelFlags, "--mcp-config", mcpConfig);
  seedTmuxSession("alpha_session", { job: [bystander, otherLaunch] }, { stateDir: workspace.stateDir });
  await new Promise(resolve => setTimeout(resolve, 500));

  assert.deepEqual(await find(), [null, null]);

  const claudeProcess = idle(...channelFlags, "--mcp-config", mcpConfig);
  updateState(workspace.stateDir, (state) => { state.fixtures.tmux.sessions.alpha_session.job.push(claudeProcess); });
  await new Promise(resolve => setTimeout(resolve, 500));
  const [pid, startedAt] = await find();
  assert.equal(pid, claudeProcess);
  assert.match(startedAt, /^\d+$/);
});

test("the generated settings.json hook commands are hook_command()'s output", async () => {
  const { workspace } = await claudeRouterWorkspace();

  const result = await startSession(workspace);

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  const hookScript = path.join(repoAsLaunched(workspace), "scripts", "claude-reminder-hook.js");
  const printed = spawnSync(PYTHON, ["-c", `import sys; sys.dont_write_bytecode = True; sys.path.insert(0, sys.argv[1]); from ccdmlib.platform.hooks import hook_command; print(hook_command(sys.argv[2]))`,
    path.join(workspace.repoDir, "scripts"), hookScript], { encoding: "utf8", env: workspace.env, windowsHide: true });
  assert.equal(printed.status, 0, printed.stderr);
  const expected = printed.stdout.trim();
  assert.match(expected, /^node '/);
  const settings = JSON.parse(fs.readFileSync(path.join(launchDir(workspace), "settings.json"), "utf8"));
  for (const event of ["SessionStart", "Stop", "StopFailure", "SessionEnd"]) {
    assert.equal(settings.hooks[event][0].hooks[0].command, expected, event);
  }
});

test("on POSIX the launch settings carry no statusLine and the channel server args stay one script path", platformGate("posix", "the POSIX launch files; Windows gets statusLine and --ccdm-key-file"), async () => {
  const { workspace } = await claudeRouterWorkspace();

  const result = await startSession(workspace);

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  const settings = JSON.parse(fs.readFileSync(path.join(launchDir(workspace), "settings.json"), "utf8"));
  assert.equal("statusLine" in settings, false);
  const mcpConfig = JSON.parse(fs.readFileSync(path.join(launchDir(workspace), "mcp.json"), "utf8"));
  assert.deepEqual(mcpConfig.mcpServers.ccdm.args, [path.join(workspace.repoDir, "scripts", "ccdm-channel-server.js")]);
});

const statusLineCommand = workspace => `node '${path.join(repoAsLaunched(workspace), "scripts", "statusline-context.js").replaceAll("\\", "/")}'`;

test("on Windows settings.json has the statusLine command", platformGate("win32", "the per-launch statusLine is Windows-only"), async () => {
  const { workspace } = await claudeRouterWorkspace();

  const result = await startSession(workspace);

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  const settings = JSON.parse(fs.readFileSync(path.join(launchDir(workspace), "settings.json"), "utf8"));
  assert.equal(settings.statusLine.type, "command");
  assert.equal(settings.statusLine.command, statusLineCommand(workspace));
  assert.match(settings.statusLine.command, /^node '[A-Za-z]:\//);
  const mcpConfig = JSON.parse(fs.readFileSync(path.join(launchDir(workspace), "mcp.json"), "utf8"));
  assert.deepEqual(mcpConfig.mcpServers.ccdm.args.slice(1), ["--ccdm-key-file", path.join(workspace.routerStateDir, "keys", "alpha.key")]);
});

test("on Windows a user's own statusLine command is kept with --chain, its quotes escaped", platformGate("win32", "the per-launch statusLine is Windows-only"), async () => {
  const { workspace } = await claudeRouterWorkspace();
  fs.mkdirSync(settledHome(workspace), { recursive: true });
  fs.writeFileSync(path.join(settledHome(workspace), "settings.json"), JSON.stringify({ statusLine: { type: "command", command: "bash -c 'echo hi'", padding: 2 } }));

  const result = await startSession(workspace);

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  const { statusLine } = JSON.parse(fs.readFileSync(path.join(launchDir(workspace), "settings.json"), "utf8"));
  const chained = "bash -c 'echo hi'".replaceAll("'", "'\\''");
  assert.equal(statusLine.command, `${statusLineCommand(workspace)} --chain '${chained}'`);
  assert.equal(statusLine.padding, 2);
});

test("on Windows a registered Claude listener found by its command-line key file blocks a second launch", platformGate("win32", "POSIX finds listeners by their environment"), async () => {
  const workspace = seededWorkspace({ mutate: (registry) => { registry.projects.alpha.webhook_id = "webhook-alpha"; } });
  const keyFile = path.join(workspace.routerStateDir, "keys", "alpha.key");
  // `--` keeps Node from reading the flag as one of its own options.
  const listener = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "--", "--ccdm-key-file", keyFile], { stdio: "ignore", windowsHide: true });
  const exited = new Promise(resolve => listener.once("exit", resolve));
  registerTeardownCallback(async () => {
    listener.kill();
    await exited;
  });
  await new Promise(resolve => setTimeout(resolve, 500));

  const result = await startSession(workspace);

  assert.equal(result.exitCode, 1, result.stdout);
  assert.match(result.stdout, /Refusing to start 'alpha'/);
  assert.match(result.stdout, new RegExp(`  ${listener.pid}`));
  assert.match(result.stdout, /Run scripts\/ccdm stop-session 'alpha' first/);
  assert.equal(readState(workspace.stateDir).fixtures.tmux.sessions.alpha_session, undefined);
});

test("on Windows --resume finds a transcript kept under the drive-letter folder name", platformGate("win32", "Windows folder names"), async () => {
  const { workspace, registry } = await claudeRouterWorkspace();
  const projectPath = registry.projects.alpha.path;
  assert.match(projectPath, /^[A-Za-z]:\\/);
  const munged = projectPath.replace(/[^A-Za-z0-9]/g, "-");
  assert.match(munged, /^[A-Za-z]--/);
  // Claude takes the drive letter from its own process, so the case may differ.
  const stored = munged[0] === munged[0].toUpperCase() ? munged[0].toLowerCase() + munged.slice(1) : munged[0].toUpperCase() + munged.slice(1);
  const dir = path.join(settledHome(workspace), "projects", stored);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${RESUME_ID}.jsonl`), "{}\n");

  const result = await startResume(workspace);

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.equal(readRegistry(workspace).projects.alpha.session_id, RESUME_ID);
});

test("the shim and scripts/ccdm start-session print the same and exit the same", async () => {
  const workspace = seededWorkspace();
  const env = routerEnv(workspace, await backendEnv(workspace));

  const shim = await runScript(workspace, "scripts/start-session.sh", { args: ["alpha"], env, timeoutMs: LAUNCH_TIMEOUT_MS });
  const direct = await runScript(workspace, "scripts/ccdm", { args: ["start-session", "alpha"], env, timeoutMs: LAUNCH_TIMEOUT_MS });

  assert.equal(shim.exitCode, 1, shim.stderr || shim.stdout);
  assert.match(shim.stderr, /it has no webhook_id/);
  assert.equal(direct.exitCode, shim.exitCode);
  assert.equal(direct.stdout, shim.stdout);
  assert.equal(direct.stderr, shim.stderr);
});
