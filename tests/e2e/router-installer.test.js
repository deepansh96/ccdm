import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { spawnSync } from "node:child_process";

import { runNodeEntrypoint, runScript } from "./support/runner.js";
import {
  ROOT_TOKEN, createRouterWorkspace, routerEnv, runRouterCli, startRouter,
} from "./support/router.js";
import { readState, writeState } from "./support/state.js";
import { cleanup } from "./support/teardown.js";

test.afterEach(async () => cleanup());

// The Router is supervised as the `com.ccdm.router` LaunchAgent. Scenarios
// drive the real installer through the `launchctl` Fixture Binary; the real
// user's LaunchAgents directory is never touched.

const LABEL = "com.ccdm.router";
const INSTALLER = "scripts/install-router-service.sh";

const plistPath = workspace => path.join(workspace.homeDir, "Library", "LaunchAgents", `${LABEL}.plist`);
const rootStateDir = workspace => path.join(workspace.homeDir, ".claude/channels/discord");
const installEnv = (workspace, extra = {}) => ({
  ROOT_DISCORD_STATE_DIR: rootStateDir(workspace), CCDM_ROUTER_NODE: process.execPath, ...extra,
});
const install = (workspace, extra = {}) =>
  runScript(workspace, INSTALLER, { env: routerEnv(workspace, installEnv(workspace, extra)) });
const operations = workspace =>
  readState(workspace.stateDir).fixtures.launchctl.invocations.map(({ operation }) => operation);

function renderedAgent(workspace) {
  const parsed = spawnSync("python3", ["-c",
    "import json,plistlib,sys; print(json.dumps(plistlib.load(open(sys.argv[1],'rb'))))", plistPath(workspace)],
  { encoding: "utf8" });
  assert.equal(parsed.status, 0, parsed.stderr);
  return JSON.parse(parsed.stdout);
}

test("a second Router exits non-zero while one holds the lock, and the running one keeps serving", async () => {
  const workspace = createRouterWorkspace();
  const first = await startRouter(workspace);

  const second = await runRouterCli(workspace, ["serve"], { timeoutMs: 15000 });

  assert.notEqual(second.exitCode, 0);
  assert.match(second.stderr, /another Router is already running \(pid \d+\)/);
  assert.equal(fs.existsSync(workspace.socketPath), true);
  const status = await runRouterCli(workspace, ["status"]);
  assert.equal(status.exitCode, 0, status.stderr || status.stdout);
  assert.match(status.stdout, /gateway: ready/);
  assert.doesNotMatch(first.stdout + first.stderr, /router (serve )?failed/);
});

test("installer renders a secret-free LaunchAgent with private logs that relaunches only after a crash", async () => {
  const workspace = createRouterWorkspace();

  const result = await install(workspace);

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  const repo = fs.realpathSync(workspace.repoDir);
  const expected = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
<key>Label</key>
<string>com.ccdm.router</string>
<key>ProgramArguments</key>
<array>
<string>${process.execPath}</string>
<string>${path.join(repo, "scripts", "router.js")}</string>
<string>serve</string>
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
<integer>10</integer>
<key>Umask</key>
<integer>63</integer>
<key>EnvironmentVariables</key>
<dict>
<key>CCDM_ROUTER_STATE_DIR</key>
<string>${workspace.routerStateDir}</string>
<key>PATH</key>
<string>${path.dirname(process.execPath)}:/usr/bin:/bin</string>
<key>ROOT_DISCORD_STATE_DIR</key>
<string>${rootStateDir(workspace)}</string>
</dict>
<key>StandardOutPath</key>
<string>${path.join(workspace.routerStateDir, "router.log")}</string>
<key>StandardErrorPath</key>
<string>${path.join(workspace.routerStateDir, "router.err")}</string>
</dict>
</plist>
`;
  assert.equal(fs.readFileSync(plistPath(workspace), "utf8"), expected);
  assert.deepEqual(operations(workspace), ["list", "unload", "load", "list"]);
  assert.deepEqual(readState(workspace.stateDir).fixtures.launchctl.loaded, [LABEL]);
  assert.match(result.stdout, /LaunchAgent 'com\.ccdm\.router' loaded/);
  for (const text of [expected, result.stdout, result.stderr]) {
    assert.doesNotMatch(text, new RegExp(`${ROOT_TOKEN}|pool-bot-token|DISCORD_BOT_TOKEN`));
  }
  assert.equal(fs.statSync(workspace.routerStateDir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(workspace.routerStateDir, "router.log")).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(workspace.routerStateDir, "router.err")).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(path.dirname(plistPath(workspace))), [`${LABEL}.plist`]);
});

test("the supervised Router and a foreground Router share one lock", async () => {
  const workspace = createRouterWorkspace();
  const installed = await install(workspace);
  assert.equal(installed.exitCode, 0, installed.stderr || installed.stdout);
  await startRouter(workspace);

  // Launch exactly what launchd would: the rendered ProgramArguments and environment.
  const agent = renderedAgent(workspace);
  const [node, script, ...args] = agent.ProgramArguments;
  const { PATH: _renderedPath, ...rendered } = agent.EnvironmentVariables;
  assert.equal(node, process.execPath);
  const supervised = await runNodeEntrypoint(workspace, path.relative(fs.realpathSync(workspace.repoDir), script), {
    args, cwd: agent.WorkingDirectory, timeoutMs: 15000, env: routerEnv(workspace, rendered),
  });

  assert.notEqual(supervised.exitCode, 0);
  assert.match(supervised.stderr, /another Router is already running/);
  const status = await runRouterCli(workspace, ["status"]);
  assert.equal(status.exitCode, 0, status.stderr || status.stdout);
});

test("a lock left by a dead Router is reclaimed", async () => {
  const workspace = createRouterWorkspace();
  const dead = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
  fs.mkdirSync(workspace.routerStateDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(workspace.routerStateDir, "router.lock"), `${dead.stdout}\n`, { mode: 0o600 });

  await startRouter(workspace);

  const status = await runRouterCli(workspace, ["status"]);
  assert.equal(status.exitCode, 0, status.stderr || status.stdout);
});

test("a failed replacement load restores the previous plist and loaded service", async () => {
  const workspace = createRouterWorkspace();
  const first = await install(workspace);
  assert.equal(first.exitCode, 0, first.stderr || first.stdout);
  const prior = fs.readFileSync(plistPath(workspace), "utf8");
  // The replacement differs only by its node path, so a rollback is observable.
  const otherNode = path.join(workspace.tmpDir, "node-bin", "node");
  fs.mkdirSync(path.dirname(otherNode));
  fs.symlinkSync(process.execPath, otherNode);
  const state = readState(workspace.stateDir);
  state.fixtures.launchctl.loadFailuresRemaining = 1;
  writeState(state, workspace.stateDir);

  const result = await install(workspace, { CCDM_ROUTER_NODE: otherNode });

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /restored the previous LaunchAgent/);
  assert.equal(fs.readFileSync(plistPath(workspace), "utf8"), prior);
  assert.deepEqual(readState(workspace.stateDir).fixtures.launchctl.loaded, [LABEL]);
  assert.deepEqual(operations(workspace), ["list", "unload", "load", "list", "list", "unload", "load", "unload", "load"]);
  assert.deepEqual(fs.readdirSync(path.dirname(plistPath(workspace))), [`${LABEL}.plist`]);
});

test("a preflight failure names its fix and leaves launchd and the installed plist untouched", async () => {
  const cases = [
    { name: "missing root token", expected: /root Discord token is missing; add DISCORD_BOT_TOKEN to .*\.env/,
      prepare: workspace => fs.writeFileSync(path.join(rootStateDir(workspace), ".env"), "OTHER=1\n") },
    { name: "unreadable registry", expected: /registry\.json .*cannot be read.*fix or restore/,
      prepare: workspace => fs.writeFileSync(path.join(workspace.repoDir, "registry.json"), "{not json") },
    { name: "ownerless registry", expected: /registry\.json has no discord_user_id/, prepare: workspace => {
      const file = path.join(workspace.repoDir, "registry.json");
      fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), discord_user_id: "" }));
    } },
    { name: "group-readable socket directory", expected: /has mode 0755; run chmod 700 /,
      prepare: workspace => fs.chmodSync(workspace.routerStateDir, 0o755) },
    { name: "outdated node", expected: /node 22 or newer is required/, prepare: (workspace, env) => {
      const oldNode = path.join(workspace.tmpDir, "old-node");
      fs.writeFileSync(oldNode, "#!/bin/sh\n# reports Node 18: the version probe fails\nexit 1\n", { mode: 0o755 });
      env.CCDM_ROUTER_NODE = oldNode;
    } },
  ];
  for (const scenario of cases) {
    const workspace = createRouterWorkspace();
    const first = await install(workspace);
    assert.equal(first.exitCode, 0, first.stderr || first.stdout);
    const working = fs.readFileSync(plistPath(workspace), "utf8");
    const env = {};
    scenario.prepare(workspace, env);
    const stateMode = fs.statSync(workspace.routerStateDir).mode;

    const result = await install(workspace, env);

    assert.notEqual(result.exitCode, 0, scenario.name);
    assert.match(result.stderr, scenario.expected, scenario.name);
    assert.equal(fs.readFileSync(plistPath(workspace), "utf8"), working, scenario.name);
    assert.equal(fs.statSync(workspace.routerStateDir).mode, stateMode, scenario.name);
    assert.deepEqual(operations(workspace), ["list", "unload", "load", "list"], scenario.name);
    assert.deepEqual(readState(workspace.stateDir).fixtures.launchctl.loaded, [LABEL], scenario.name);
    assert.deepEqual(fs.readdirSync(path.dirname(plistPath(workspace))), [`${LABEL}.plist`], scenario.name);
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp(ROOT_TOKEN), scenario.name);
  }
});

test("preflight is read-only: it creates no state directory when none exists", async () => {
  const workspace = createRouterWorkspace();

  const result = await runRouterCli(workspace, ["preflight"]);

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.deepEqual(JSON.parse(result.stdout), { ready: true, blockers: [] });
  assert.equal(fs.existsSync(workspace.routerStateDir), false);
  assert.deepEqual(operations(workspace), []);
});
