import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { createRouterWorkspace, routerWithWebhooks, runRouterCli } from "./support/router.js";
import { runScript } from "./support/runner.js";
import { readState, updateState } from "./support/state.js";
import { cleanup } from "./support/teardown.js";
import {
  startThreadSupervisor, supervisorCli, supervisorEnv, supervisorStateDir, supervisorStatus,
} from "./support/thread-supervisor.js";

test.afterEach(cleanup);

const LABEL = "com.ccdm.thread-supervisor";
const plistPath = workspace => path.join(workspace.homeDir, "Library", "LaunchAgents", `${LABEL}.plist`);

// Root lacks two channel thread bits and the guild's View Audit Log.
function denyThreadPermissions(workspace) {
  updateState(workspace.stateDir, state => {
    state.fixtures.discord.permissionDenials = { "fixture-bot-user-id":
      ["CreatePublicThreads", "ManageThreads", "ViewAuditLog"] };
  });
}

function editRegistry(workspace, edit) {
  const file = path.join(workspace.repoDir, "registry.json");
  const registry = JSON.parse(fs.readFileSync(file, "utf8"));
  edit(registry);
  fs.writeFileSync(file, `${JSON.stringify(registry, null, 2)}\n`);
}
const addCaps = registry => { registry.thread_session_caps = { claude: 6, codex: 8 }; };
const removeCaps = registry => { delete registry.thread_session_caps; };

async function routerStatus(workspace) {
  const text = await runRouterCli(workspace, ["status"]);
  assert.equal(text.exitCode, 0, text.stderr || text.stdout);
  const json = await runRouterCli(workspace, ["status", "--json"]);
  assert.equal(json.exitCode, 0, json.stderr || json.stdout);
  return { text: text.stdout, json: JSON.parse(json.stdout) };
}

const DEMO_LINE = /^ {2}demo channel=demo-channel webhook=present root_permissions=ok$/m;
const DEMO_THREAD_LINE =
  /^ {2}demo channel=demo-channel webhook=present root_permissions=ok thread_permissions=missing CreatePublicThreads,ManageThreads$/m;
const GUILD_LINE = /^guild permissions: missing ViewAuditLog$/m;

function assertThreadBitsOmitted({ text, json }) {
  assert.match(text, DEMO_LINE);
  assert.doesNotMatch(text, /thread_permissions|guild permissions/);
  assert.equal(json.threads_enabled, false);
  for (const project of json.projects) assert.equal(project.missing_thread_permissions, undefined, project.project);
}

function assertThreadBitsListed({ text, json }) {
  assert.match(text, DEMO_THREAD_LINE);
  assert.match(text, GUILD_LINE);
  assert.equal(json.threads_enabled, true);
  const demo = json.projects.find(({ project }) => project === "demo");
  assert.deepEqual(demo.missing_thread_permissions, ["CreatePublicThreads", "ManageThreads", "ViewAuditLog"]);
}

test("router status lists root's missing thread permissions only while threads are enabled", async () => {
  const workspace = createRouterWorkspace();
  denyThreadPermissions(workspace);
  await routerWithWebhooks(workspace, ["demo", "beta"]);

  // No supervisor plist, no `thread_session_caps`, no supervisor: threads are off.
  assertThreadBitsOmitted(await routerStatus(workspace));

  // The supervisor's LaunchAgent plist enables them.
  fs.mkdirSync(path.dirname(plistPath(workspace)), { recursive: true });
  fs.writeFileSync(plistPath(workspace), "<plist/>\n");
  assertThreadBitsListed(await routerStatus(workspace));
  fs.rmSync(plistPath(workspace));
  assertThreadBitsOmitted(await routerStatus(workspace));

  // So does `thread_session_caps` in the registry.
  editRegistry(workspace, addCaps);
  assertThreadBitsListed(await routerStatus(workspace));
  editRegistry(workspace, removeCaps);
  assertThreadBitsOmitted(await routerStatus(workspace));

  // And so does a connected supervisor.
  const supervisor = await startThreadSupervisor(workspace);
  assertThreadBitsListed(await routerStatus(workspace));
  await supervisor.stop();

  // Granted, an enabled status names nothing missing.
  updateState(workspace.stateDir, state => { delete state.fixtures.discord.permissionDenials; });
  editRegistry(workspace, addCaps);
  const granted = await routerStatus(workspace);
  assert.match(granted.text, /^ {2}demo channel=demo-channel webhook=present root_permissions=ok thread_permissions=ok$/m);
  assert.match(granted.text, /^guild permissions: ok$/m);
});

// The worker the LaunchAgent runs: `run --supervised`, which honours `disable`.
function supervisedRun(workspace) {
  return runScript(workspace, "scripts/thread-supervisor.py", {
    args: ["run", "--supervised"], env: supervisorEnv(workspace), timeoutMs: 30000,
  });
}

async function waitForConnected(workspace, describe) {
  const deadline = Date.now() + 15000;
  while ((await supervisorStatus(workspace)).router !== "connected") {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${describe}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

const supervisorKey = workspace => {
  const file = path.join(workspace.routerStateDir, "keys", ".supervisor.key");
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
};

test("disable stops the supervised worker for good, and run still works in the foreground", async () => {
  const workspace = createRouterWorkspace();
  await routerWithWebhooks(workspace, ["demo", "beta"]);
  assert.equal((await supervisorStatus(workspace)).disabled, false);

  const supervised = supervisedRun(workspace);
  await waitForConnected(workspace, "the supervised worker's Router connection");

  // Disable exits the supervised worker successfully, so KeepAlive does not relaunch it.
  const disabled = await supervisorCli(workspace, "disable");
  assert.equal(disabled.exitCode, 0, disabled.stderr || disabled.stdout);
  assert.equal(disabled.json.disabled, true);
  const stopped = await supervised;
  assert.equal(stopped.exitCode, 0, stopped.stderr || stopped.stdout);
  const status = await supervisorStatus(workspace);
  assert.equal(status.disabled, true);
  assert.equal(status.running, false);

  // A load at login while disabled exits at once, without a fresh key or a Router connection.
  const key = supervisorKey(workspace);
  const relaunched = await supervisedRun(workspace);
  assert.equal(relaunched.exitCode, 0, relaunched.stderr || relaunched.stdout);
  assert.equal(JSON.parse(relaunched.stdout).disabled, true);
  assert.equal(supervisorKey(workspace), key);

  // The foreground debug worker runs while disabled, and a second worker exits 2.
  const foreground = await startThreadSupervisor(workspace);
  assert.notEqual(supervisorKey(workspace), key);
  const second = await supervisorCli(workspace, "run", { timeoutMs: 15000 });
  assert.equal(second.exitCode, 2, second.stderr || second.stdout);
  assert.match(second.json.reason, /already running/);
  assert.equal((await foreground.stop()).exitCode, 0);

  // Enable clears the flag, so the supervised worker runs again.
  const enabled = await supervisorCli(workspace, "enable");
  assert.equal(enabled.exitCode, 0, enabled.stderr || enabled.stdout);
  assert.equal(enabled.json.disabled, false);
  const again = supervisedRun(workspace);
  await waitForConnected(workspace, "the re-enabled supervised worker's Router connection");
  await supervisorCli(workspace, "disable");
  assert.equal((await again).exitCode, 0);
});

test("enable refuses with exit 2 while the preflight is blocked, and leaves the worker disabled", async () => {
  const workspace = createRouterWorkspace();
  await routerWithWebhooks(workspace, ["demo", "beta"]);
  assert.equal((await supervisorCli(workspace, "disable")).exitCode, 0);
  editRegistry(workspace, registry => { delete registry.guild_id; });

  const refused = await supervisorCli(workspace, "enable");

  assert.equal(refused.exitCode, 2, refused.stderr || refused.stdout);
  assert.equal(refused.json.status, "blocked");
  assert.match(refused.json.reason, /registry\.json has no guild_id/);
  assert.equal((await supervisorStatus(workspace)).disabled, true);
});

// The installer, driven through the `launchctl` Fixture Binary; the real
// user's LaunchAgents directory is never touched.
const INSTALLER = "scripts/install-thread-supervisor.sh";
const install = (workspace, env = {}) => runScript(workspace, INSTALLER, { env: supervisorEnv(workspace, env) });
const operations = workspace =>
  readState(workspace.stateDir).fixtures.launchctl.invocations.map(({ operation }) => operation);

function renderedAgent(workspace) {
  const parsed = spawnSync("python3", ["-c",
    "import json,plistlib,sys; print(json.dumps(plistlib.load(open(sys.argv[1],'rb'))))", plistPath(workspace)],
  { encoding: "utf8" });
  assert.equal(parsed.status, 0, parsed.stderr);
  return JSON.parse(parsed.stdout);
}

test("installer renders a secret-free LaunchAgent for the supervised worker and loads it", async () => {
  const workspace = createRouterWorkspace();
  await routerWithWebhooks(workspace, ["demo", "beta"]);

  const result = await install(workspace);

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  const repo = fs.realpathSync(workspace.repoDir);
  const stateDir = supervisorStateDir(workspace);
  const python = path.join(workspace.fixtureDir, "python3");
  const expected = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
<key>Label</key>
<string>com.ccdm.thread-supervisor</string>
<key>ProgramArguments</key>
<array>
<string>${python}</string>
<string>${path.join(repo, "scripts", "thread-supervisor.py")}</string>
<string>run</string>
<string>--supervised</string>
<string>--project-root</string>
<string>${repo}</string>
<string>--state-dir</string>
<string>${stateDir}</string>
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
<key>CCDM_ROUTER_NODE</key>
<string>${process.execPath}</string>
<key>CCDM_ROUTER_STATE_DIR</key>
<string>${workspace.routerStateDir}</string>
<key>PATH</key>
<string>${path.dirname(process.execPath)}:${workspace.fixtureDir}:/usr/bin:/bin</string>
</dict>
<key>StandardOutPath</key>
<string>${path.join(stateDir, "service.log")}</string>
<key>StandardErrorPath</key>
<string>${path.join(stateDir, "service.err")}</string>
</dict>
</plist>
`;
  assert.equal(fs.readFileSync(plistPath(workspace), "utf8"), expected);
  assert.deepEqual(operations(workspace), ["list", "unload", "load", "list"]);
  assert.deepEqual(readState(workspace.stateDir).fixtures.launchctl.loaded, [LABEL]);
  assert.match(result.stdout, /LaunchAgent 'com\.ccdm\.thread-supervisor' loaded/);
  for (const text of [expected, result.stdout, result.stderr]) {
    assert.doesNotMatch(text, /root-bot-token|pool-bot-token|DISCORD_BOT_TOKEN|\.key\b/);
  }
  assert.equal(fs.statSync(stateDir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(stateDir, "service.log")).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(stateDir, "service.err")).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(path.join(stateDir, "threads.sqlite3")), false);

  // What launchd would run connects the worker to the Router.
  const agent = renderedAgent(workspace);
  const [, script, ...args] = agent.ProgramArguments;
  const { PATH: _renderedPath, ...rendered } = agent.EnvironmentVariables;
  const supervised = runScript(workspace, path.relative(repo, script), {
    args, cwd: agent.WorkingDirectory, timeoutMs: 30000, env: supervisorEnv(workspace, rendered),
  });
  await waitForConnected(workspace, "the LaunchAgent worker's Router connection");
  assert.equal((await supervisorCli(workspace, "disable")).exitCode, 0);
  assert.equal((await supervised).exitCode, 0);
});

test("a failing preflight refuses installation before launchctl and touches nothing", async () => {
  const cases = [
    { name: "Router down", expected: /the Router is not reachable/, start: false },
    { name: "no owner", expected: /registry\.json has no CCDM owner/,
      prepare: workspace => editRegistry(workspace, registry => { delete registry.discord_user_id; }) },
    { name: "no guild", expected: /registry\.json has no guild_id/,
      prepare: workspace => editRegistry(workspace, registry => { delete registry.guild_id; }) },
    { name: "outdated node", expected: /node 22 or newer is required/, env: workspace => {
      const oldNode = path.join(workspace.tmpDir, "old-node");
      fs.writeFileSync(oldNode, "#!/bin/sh\n# reports Node 18: the version probe fails\nexit 1\n", { mode: 0o755 });
      return { CCDM_ROUTER_NODE: oldNode };
    } },
  ];
  for (const scenario of cases) {
    const workspace = createRouterWorkspace();
    if (scenario.start !== false) await routerWithWebhooks(workspace, ["demo", "beta"]);
    scenario.prepare?.(workspace);

    const result = await install(workspace, scenario.env?.(workspace));

    assert.notEqual(result.exitCode, 0, scenario.name);
    assert.match(result.stderr, scenario.expected, scenario.name);
    assert.deepEqual(readState(workspace.stateDir).fixtures.launchctl.invocations, [], scenario.name);
    assert.equal(fs.existsSync(path.dirname(plistPath(workspace))), false, scenario.name);
    assert.equal(fs.existsSync(supervisorStateDir(workspace)), false, scenario.name);
  }
});

test("an unusable store fails the preflight and leaves the working installation intact", async () => {
  const workspace = createRouterWorkspace();
  await routerWithWebhooks(workspace, ["demo", "beta"]);
  const first = await install(workspace);
  assert.equal(first.exitCode, 0, first.stderr || first.stdout);
  const working = fs.readFileSync(plistPath(workspace), "utf8");
  const store = path.join(supervisorStateDir(workspace), "threads.sqlite3");
  fs.writeFileSync(store, "invalid database", { mode: 0o600 });

  const corrupt = await install(workspace);

  assert.equal(corrupt.exitCode, 2);
  assert.match(corrupt.stderr, /preflight failed; the existing LaunchAgent was left unchanged/);
  assert.match(corrupt.stderr, /the thread store cannot be used/);
  assert.equal(fs.readFileSync(store, "utf8"), "invalid database");
  assert.equal(fs.readFileSync(plistPath(workspace), "utf8"), working);
  assert.deepEqual(operations(workspace), ["list", "unload", "load", "list"]);
});

test("a failed replacement load restores the previous plist and loaded service", async () => {
  const workspace = createRouterWorkspace();
  await routerWithWebhooks(workspace, ["demo", "beta"]);
  const first = await install(workspace);
  assert.equal(first.exitCode, 0, first.stderr || first.stdout);
  const prior = fs.readFileSync(plistPath(workspace), "utf8");
  // The replacement differs only by its node path, so a rollback is observable.
  const otherNode = path.join(workspace.tmpDir, "node-bin", "node");
  fs.mkdirSync(path.dirname(otherNode));
  fs.symlinkSync(process.execPath, otherNode);
  updateState(workspace.stateDir, state => { state.fixtures.launchctl.loadFailuresRemaining = 1; });

  const result = await install(workspace, { CCDM_ROUTER_NODE: otherNode });

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /restored the previous LaunchAgent/);
  assert.equal(fs.readFileSync(plistPath(workspace), "utf8"), prior);
  assert.deepEqual(readState(workspace.stateDir).fixtures.launchctl.loaded, [LABEL]);
  assert.deepEqual(operations(workspace), ["list", "unload", "load", "list", "list", "unload", "load", "unload", "load"]);
  assert.deepEqual(fs.readdirSync(path.dirname(plistPath(workspace))), [`${LABEL}.plist`]);
});
