import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { spawnSync } from "node:child_process";

import { createWorkspace, runScript } from "./support/runner.js";
import { bridgeChildEnv, waitForState } from "./support/bridge.js";
import { readState, writeState } from "./support/state.js";
import { cleanup } from "./support/teardown.js";

test.afterEach(async () => cleanup());

// The Thread Supervisor LaunchAgent supervises the same foreground `run`
// worker. Scenarios drive the real installer through the `launchctl` Fixture
// Binary and launch the rendered ProgramArguments themselves; the real user's
// LaunchAgents directory is never touched.

const LABEL = "com.discord.thread-supervisor";
const INSTALLER = "scripts/install-thread-supervisor.sh";

function setup(workspace) {
  fs.writeFileSync(path.join(workspace.repoDir, "registry.json"), JSON.stringify({
    discord_user_id: "owner", guild_id: "guild",
    pool: [{ id: "bot", app_id: "app", token: "fixture-project-token" }],
    projects: { demo: { type: "claude", path: "/work/demo", bot_id: "bot", channel_id: "channel" } },
  }), { mode: 0o600 });
  const rootState = path.join(workspace.homeDir, "root-discord");
  fs.mkdirSync(rootState, { recursive: true });
  fs.writeFileSync(path.join(rootState, ".env"), "DISCORD_BOT_TOKEN=fixture-root-token\n", { mode: 0o600 });
  return {
    rootState,
    stateDir: path.join(workspace.homeDir, ".local", "state", "ccdm", "thread-supervisor"),
    env: { ROOT_DISCORD_STATE_DIR: rootState, CCDM_THREAD_NODE: process.execPath },
  };
}

const plistPath = workspace => path.join(workspace.homeDir, "Library", "LaunchAgents", `${LABEL}.plist`);
const install = (workspace, context, extra = {}) => runScript(workspace, INSTALLER, { env: context.env, ...extra });

async function supervisor(workspace, context, name, expected = 0) {
  const result = await runScript(workspace, "scripts/thread-supervisor.py", {
    args: [name, "--project-root", workspace.repoDir, "--state-dir", context.stateDir],
    env: bridgeChildEnv(workspace, context.env), timeoutMs: 30000,
  });
  assert.equal(result.exitCode, expected, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function renderedAgent(workspace) {
  const parsed = spawnSync("python3", ["-c",
    "import json,plistlib,sys; print(json.dumps(plistlib.load(open(sys.argv[1],'rb'))))", plistPath(workspace)],
  { encoding: "utf8" });
  assert.equal(parsed.status, 0, parsed.stderr);
  return JSON.parse(parsed.stdout);
}

// Launch exactly what launchd would: the rendered ProgramArguments with the
// rendered environment. PATH stays the harness fixture PATH so the Test
// Workspace cannot fall through to host tools.
function launchAsSupervisor(workspace) {
  const agent = renderedAgent(workspace);
  const [python, script, ...args] = agent.ProgramArguments;
  assert.equal(python, path.join(workspace.fixtureDir, "python3"));
  const { PATH: _renderedPath, ...rendered } = agent.EnvironmentVariables;
  return runScript(workspace, path.relative(fs.realpathSync(workspace.repoDir), script), {
    args, cwd: agent.WorkingDirectory, timeoutMs: 30000, env: bridgeChildEnv(workspace, rendered),
  });
}

const operations = workspace =>
  readState(workspace.stateDir).fixtures.launchctl.invocations.map(({ operation }) => operation);

test("installer renders a secret-free LaunchAgent that supervises the foreground worker", async () => {
  const workspace = createWorkspace();
  const context = setup(workspace);

  const result = await install(workspace, context);

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  const repo = fs.realpathSync(workspace.repoDir);
  const expected = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
<key>Label</key>
<string>com.discord.thread-supervisor</string>
<key>ProgramArguments</key>
<array>
<string>${path.join(workspace.fixtureDir, "python3")}</string>
<string>${path.join(repo, "scripts", "thread-supervisor.py")}</string>
<string>run</string>
<string>--project-root</string>
<string>${repo}</string>
<string>--state-dir</string>
<string>${context.stateDir}</string>
</array>
<key>WorkingDirectory</key>
<string>${repo}</string>
<key>RunAtLoad</key>
<true/>
<key>KeepAlive</key>
<dict>
<key>SuccessfulExit</key>
<false/>
</dict>
<key>ThrottleInterval</key>
<integer>30</integer>
<key>Umask</key>
<integer>63</integer>
<key>EnvironmentVariables</key>
<dict>
<key>CCDM_THREAD_NODE</key>
<string>${process.execPath}</string>
<key>CCDM_THREAD_PYTHON</key>
<string>${path.join(workspace.fixtureDir, "python3")}</string>
<key>PATH</key>
<string>${path.dirname(process.execPath)}:/usr/bin:/bin</string>
<key>ROOT_DISCORD_STATE_DIR</key>
<string>${context.rootState}</string>
</dict>
<key>StandardOutPath</key>
<string>${path.join(context.stateDir, "service.log")}</string>
<key>StandardErrorPath</key>
<string>${path.join(context.stateDir, "service.err")}</string>
</dict>
</plist>
`;
  assert.equal(fs.readFileSync(plistPath(workspace), "utf8"), expected);
  assert.deepEqual(operations(workspace), ["list", "unload", "load", "list"]);
  assert.match(result.stdout, /LaunchAgent 'com\.discord\.thread-supervisor' loaded/);
  for (const text of [expected, result.stdout, result.stderr]) {
    assert.doesNotMatch(text, /fixture-(root|project)-token|DISCORD_BOT_TOKEN|\.env/);
  }
  assert.equal(fs.statSync(context.stateDir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(context.stateDir, "service.log")).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(context.stateDir, "service.err")).mode & 0o777, 0o600);
  // Installing supervises the worker; it neither creates the store nor contacts Discord.
  assert.equal(fs.existsSync(path.join(context.stateDir, "threads.sqlite3")), false);
  assert.deepEqual(readState(workspace.stateDir).fixtures.discord.logins, []);
});

test("reinstalling the same LaunchAgent is idempotent", async () => {
  const workspace = createWorkspace();
  const context = setup(workspace);
  const first = await install(workspace, context);
  assert.equal(first.exitCode, 0, first.stderr || first.stdout);
  const firstPlist = fs.readFileSync(plistPath(workspace), "utf8");

  const second = await install(workspace, context);

  assert.equal(second.exitCode, 0, second.stderr || second.stdout);
  assert.equal(fs.readFileSync(plistPath(workspace), "utf8"), firstPlist);
  assert.deepEqual(operations(workspace), ["list", "unload", "load", "list", "list", "unload", "load", "list"]);
  assert.deepEqual(readState(workspace.stateDir).fixtures.launchctl.loaded, [LABEL]);
  assert.deepEqual(fs.readdirSync(path.dirname(plistPath(workspace))), [`${LABEL}.plist`]);
});

test("a failed replacement load restores the previous plist and loaded service", async () => {
  const workspace = createWorkspace();
  const context = setup(workspace);
  const first = await install(workspace, context);
  assert.equal(first.exitCode, 0, first.stderr || first.stdout);
  const prior = fs.readFileSync(plistPath(workspace), "utf8");
  // The replacement differs only by its node path, so a rollback is observable.
  const otherNode = path.join(workspace.tmpDir, "node-bin", "node");
  fs.mkdirSync(path.dirname(otherNode));
  fs.symlinkSync(process.execPath, otherNode);
  const state = readState(workspace.stateDir);
  state.fixtures.launchctl.loadFailuresRemaining = 1;
  writeState(state, workspace.stateDir);

  const result = await install(workspace, { ...context, env: { ...context.env, CCDM_THREAD_NODE: otherNode } });

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /restored the previous LaunchAgent/);
  assert.equal(fs.readFileSync(plistPath(workspace), "utf8"), prior);
  assert.deepEqual(readState(workspace.stateDir).fixtures.launchctl.loaded, [LABEL]);
  assert.deepEqual(operations(workspace), ["list", "unload", "load", "list", "list", "unload", "load", "unload", "load"]);
  assert.deepEqual(fs.readdirSync(path.dirname(plistPath(workspace))), [`${LABEL}.plist`]);
});

test("a failing preflight or missing interpreter stops the installer before any launchctl call", async () => {
  const cases = [
    { name: "outdated node", expected: /node 22 or newer is required/, prepare: (workspace, context) => {
      const oldNode = path.join(workspace.tmpDir, "old-node");
      fs.writeFileSync(oldNode, "#!/bin/sh\n# reports Node 18: the version probe fails\nexit 1\n", { mode: 0o755 });
      context.env.CCDM_THREAD_NODE = oldNode;
    } },
    { name: "missing root credentials", expected: /root Discord credentials are unavailable/, prepare: (_workspace, context) =>
      fs.rmSync(path.join(context.rootState, ".env")) },
    { name: "missing owner", expected: /registry\.json has no CCDM owner/, prepare: workspace => {
      const registryPath = path.join(workspace.repoDir, "registry.json");
      fs.writeFileSync(registryPath, JSON.stringify({ ...JSON.parse(fs.readFileSync(registryPath, "utf8")),
        discord_user_id: "" }));
    } },
  ];
  for (const scenario of cases) {
    const workspace = createWorkspace();
    const context = setup(workspace);
    scenario.prepare(workspace, context);

    const result = await install(workspace, context);

    assert.notEqual(result.exitCode, 0, scenario.name);
    assert.match(result.stderr, scenario.expected, scenario.name);
    assert.deepEqual(readState(workspace.stateDir).fixtures.launchctl.invocations, [], scenario.name);
    assert.equal(fs.existsSync(plistPath(workspace)), false, scenario.name);
    assert.equal(fs.existsSync(context.stateDir), false, scenario.name);
    assert.doesNotMatch(result.stdout + result.stderr, /fixture-(root|project)-token/, scenario.name);
  }
});

test("an unusable store leaves the working installation loaded and unchanged", async () => {
  const workspace = createWorkspace();
  const context = setup(workspace);
  const first = await install(workspace, context);
  assert.equal(first.exitCode, 0, first.stderr || first.stdout);
  const working = fs.readFileSync(plistPath(workspace), "utf8");
  const store = path.join(context.stateDir, "threads.sqlite3");
  fs.writeFileSync(store, "invalid database", { mode: 0o600 });

  const corrupt = await install(workspace, context);

  assert.equal(corrupt.exitCode, 2);
  assert.match(corrupt.stderr, /preflight failed; the existing LaunchAgent was left unchanged/);
  assert.match(corrupt.stderr, /thread store cannot be used/);
  assert.equal(fs.readFileSync(store, "utf8"), "invalid database");
  assert.equal(fs.readFileSync(plistPath(workspace), "utf8"), working);
  assert.deepEqual(operations(workspace), ["list", "unload", "load", "list"]);
  assert.deepEqual(readState(workspace.stateDir).fixtures.launchctl.loaded, [LABEL]);
});

test("a foreground run while the supervised worker holds the lock exits nonzero", async () => {
  const workspace = createWorkspace();
  const context = setup(workspace);
  const installed = await install(workspace, context);
  assert.equal(installed.exitCode, 0, installed.stderr || installed.stdout);
  const supervised = launchAsSupervisor(workspace);
  await waitForState(workspace, state => state.fixtures.discord.ready.length === 1, 10000);

  const foreground = await supervisor(workspace, context, "run", 2);

  assert.match(foreground.reason, /already running/);
  assert.equal((await supervisor(workspace, context, "status")).running, true);
  await supervisor(workspace, context, "disable");
  assert.equal((await supervised).exitCode, 0);
});

test("disable stops the supervised worker for good, and enable plus the installer brings it back", async () => {
  const workspace = createWorkspace();
  const context = setup(workspace);
  const installed = await install(workspace, context);
  assert.equal(installed.exitCode, 0, installed.stderr || installed.stdout);
  const supervised = launchAsSupervisor(workspace);
  await waitForState(workspace, state => state.fixtures.discord.ready.length === 1, 10000);

  const disabled = await supervisor(workspace, context, "disable");

  // The worker has stopped before `disable` returns, and it stopped successfully,
  // so KeepAlive (relaunch only on an unsuccessful exit) does not restart it.
  assert.equal(disabled.disabled, true);
  assert.equal(disabled.running, false);
  const stopped = await supervised;
  assert.equal(stopped.exitCode, 0, stopped.stderr || stopped.stdout);
  // A load at login (RunAtLoad) while disabled exits successfully without logging in.
  const relaunched = await launchAsSupervisor(workspace);
  assert.equal(relaunched.exitCode, 0, relaunched.stderr || relaunched.stdout);
  assert.equal(JSON.parse(relaunched.stdout).disabled, true);
  assert.equal(readState(workspace.stateDir).fixtures.discord.logins.length, 1);
  assert.equal(fs.statSync(path.join(context.stateDir, "disabled")).mode & 0o777, 0o600);

  // The root restart sequence: disable, enable, then the installer.
  const enabled = await supervisor(workspace, context, "enable");
  assert.equal(enabled.disabled, false);
  assert.equal(enabled.status, "ok");
  const reinstalled = await install(workspace, context);
  assert.equal(reinstalled.exitCode, 0, reinstalled.stderr || reinstalled.stdout);
  assert.deepEqual(operations(workspace), ["list", "unload", "load", "list", "list", "unload", "load", "list"]);
  const restarted = launchAsSupervisor(workspace);
  await waitForState(workspace, state => state.fixtures.discord.ready.length === 2, 10000);
  assert.equal((await supervisor(workspace, context, "status")).running, true);
  await supervisor(workspace, context, "disable");
  assert.equal((await restarted).exitCode, 0);
});

test("enable refuses and names blockers when preflight fails", async () => {
  const workspace = createWorkspace();
  const context = setup(workspace);
  await supervisor(workspace, context, "disable");
  fs.rmSync(path.join(context.rootState, ".env"));

  const refused = await supervisor(workspace, context, "enable", 2);

  assert.equal(refused.status, "blocked");
  assert.match(refused.blockers.join("\n"), /root Discord credentials are unavailable/);
});
