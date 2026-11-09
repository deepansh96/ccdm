// Root after logon on Windows: install, uninstall and the run the task makes,
// through a fixture schtasks, the fake ccdm-host and a real Router on the Local
// Fake Discord. Task Scheduler is never reached: `schtasks` resolves to the
// workspace's fixture and the workspace's PATH holds nothing else. The 120 s
// wait runs on a scaled clock, so no test waits real minutes.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import nodeTest from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PYTHON, platformGate, suiteTest } from "./support/platform.js";
import { createRouterWorkspace, routerEnv, routerRegistry, runRouterCli, startRouter, waitFor } from "./support/router.js";
import { runScript, scaledTimeout } from "./support/runner.js";
import { hostOps, startFakeHost } from "./support/session-fixture.js";
import { readState } from "./support/state.js";
import { cleanup, registerTeardownCallback } from "./support/teardown.js";

const test = suiteTest(nodeTest, import.meta.url);
test.afterEach(async () => cleanup());

const require = createRequire(import.meta.url);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const TASK = "\\CCDM\\RootAtLogon";
const onlyWindows = platformGate("win32", "Task Scheduler and conhost exist only on Windows");
const TIME_SCALE = "CCDM_ROOT_AT_LOGON_TIME_SCALE";
const CHANGING_OPS = ["kill", "new", "run-detached"];
// Clock scales for the run's 120 s wait. A run that should start root gets a 60 s
// window polled every second: room for a busy machine, and it ends as soon as
// both answer. A run that should give up gets a 2 s window.
const UNHURRIED = 2;
const GIVES_UP_SOON = 60;

const invocations = workspace => readState(workspace.stateDir).fixtures.schtasks.invocations;
const verbs = workspace => invocations(workspace).map(entry => entry.verb);
const definition = workspace => readState(workspace.stateDir).fixtures.schtasks.definitions[TASK];
const defaultStateRoot = workspace => path.join(workspace.homeDir, ".local", "state", "ccdm");
// Where startFakeHost keeps the host's files; the task must find the same place.
const hostStateRoot = workspace => path.join(workspace.tmpRoot, "fake-host-state");
const serviceFile = (stateRoot, suffix) => path.join(stateRoot, "services", `root-at-logon${suffix}`);
const readConfig = stateRoot => JSON.parse(fs.readFileSync(serviceFile(stateRoot, ".json"), "utf8"));
// Python ends its lines with CRLF on Windows.
const readLog = (workspace, suffix = ".log") => fs.readFileSync(serviceFile(hostStateRoot(workspace), suffix), "utf8").replace(/\r\n/g, "\n");
const rootKey = workspace => path.join(workspace.routerStateDir, "keys", ".root.key");
const rootLaunches = workspace => hostOps(workspace).filter(call => call.op === "new");

function rootWorkspace() {
  return createRouterWorkspace({ ...routerRegistry(), root_channels: ["root-channel"] });
}

// The operator's shell: this installation's state root, Router state and session host.
function installEnv(workspace, extra = {}) {
  return routerEnv(workspace, {
    CCDM_PYTHON: PYTHON,
    CCDM_SESSION_HOST: "ccdm-host",
    CCDM_STATE_ROOT: hostStateRoot(workspace),
    ...extra,
  });
}

// Python directly on Windows, as the other installer tests do.
const CCDM_ENTRY = process.platform === "win32" ? "scripts/ccdm.py" : "scripts/ccdm";
const ccdm = (workspace, args, env = {}) => runScript(workspace, CCDM_ENTRY, {
  args, env: installEnv(workspace, env), timeoutMs: scaledTimeout(30000),
});

async function install(workspace, env = {}) {
  const installed = await ccdm(workspace, ["install-service", "root-at-logon"], env);
  assert.equal(installed.exitCode, 0, installed.stderr || installed.stdout);
  return installed;
}

async function startHost(workspace) {
  const host = await startFakeHost(workspace, { env: routerEnv(workspace) });
  assert.equal(host.stateRoot, hostStateRoot(workspace));
  return host;
}

// Stands in for the logon trigger firing: starts the program the XML names,
// without its conhost, and resolves with its exit code. Nothing of the
// installer's environment is here, as in a real task: the run has only what the
// install recorded. `scale` is how much faster than real time its wait runs.
function runAsLogonTask(workspace, scale) {
  const xml = definition(workspace);
  const args = [...(/<Arguments>([^<]*)<\/Arguments>/.exec(xml)[1]).matchAll(/&quot;([^&]*)&quot;|"([^"]*)"|(\S+)/g)].map(m => m[1] ?? m[2] ?? m[3]);
  assert.equal(args[0], "--headless");
  const cwd = /<WorkingDirectory>([^<]*)<\/WorkingDirectory>/.exec(xml)[1];
  const env = { ...workspace.env, CCDM_SERVICE_HOST_TEST_PASS: `CCDM_TEST_STATE,${TIME_SCALE}`, [TIME_SCALE]: String(scale) };
  const { killTree, rememberSpawn } = require("../../scripts/platform/process.js");
  const child = rememberSpawn(spawn(args[1], args.slice(2), { cwd, env, stdio: "ignore", windowsHide: true }));
  registerTeardownCallback(() => killTree(child));
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
}

async function assertRootIsUp(workspace) {
  const status = await runRouterCli(workspace, ["status"]);
  assert.equal(status.exitCode, 0, status.stderr);
  assert.match(status.stdout, /sessions: 1\n  root root scope=/);
}

function assertNothingStarted(workspace) {
  assert.deepEqual(hostOps(workspace).filter(call => CHANGING_OPS.includes(call.op)), []);
  assert.equal(fs.existsSync(rootKey(workspace)), false, "no root key was written");
  assert.doesNotMatch(readLog(workspace), /running restart-root/);
  assert.match(readLog(workspace), /root was not started/);
}

test("install-service root-at-logon creates a task that runs once, one minute after logon, and does not start it", onlyWindows, async () => {
  const workspace = rootWorkspace();

  const installed = await install(workspace, { CCDM_STATE_ROOT: undefined });

  assert.match(installed.stdout, /Task \\CCDM\\RootAtLogon installed/);
  const xml = definition(workspace);
  const [, triggerUser] = /<Triggers>\s*<LogonTrigger>\s*<Enabled>true<\/Enabled>\s*<UserId>([^<]+)<\/UserId>\s*<Delay>PT1M<\/Delay>\s*<\/LogonTrigger>\s*<\/Triggers>/.exec(xml)
    ?? assert.fail(`the only trigger must be a logon trigger with a 1-minute delay: ${xml}`);
  assert.equal(triggerUser, /<Principal id="Author">\s*<UserId>([^<]+)<\/UserId>/.exec(xml)[1]);
  assert.doesNotMatch(xml, /<TimeTrigger>|<Repetition>|<RestartOnFailure>/, "it runs once per logon, with no restart loop");
  assert.doesNotMatch(xml, /__[A-Z_]+__/);
  assert.match(xml, /<LogonType>InteractiveToken<\/LogonType>/);
  assert.match(xml, /<Command>[^<]*conhost\.exe<\/Command>/);
  assert.match(xml, /<Arguments>--headless (&quot;|")[^<]*node[^<]*service-host\.js(&quot;|") --config (&quot;|")[^<]*root-at-logon\.json(&quot;|") --once<\/Arguments>/);
  const stateRoot = defaultStateRoot(workspace);
  // Python reports the long form of a path; a CI temp folder can be an 8.3 short name.
  assert.deepEqual(readConfig(stateRoot).command,
    [PYTHON, path.join(fs.realpathSync.native(workspace.repoDir), "scripts", "ccdm.py"), "root-at-logon", "--wait", "120"]);
  assert.equal(verbs(workspace).includes("/run"), false, "root starts at the next logon, not at install");
  assert.ok(fs.existsSync(serviceFile(stateRoot, ".log")));
  assert.ok(fs.existsSync(serviceFile(stateRoot, ".err")));
  assert.deepEqual(rootLaunches(workspace), []);
});

test("the task's environment carries this installation's names and root's account, and nothing of the caller's session", onlyWindows, async () => {
  const workspace = rootWorkspace();
  const claudeHome = path.join(workspace.homeDir, "root-claude-home");

  await install(workspace, {
    CLAUDE_CONFIG_DIR: claudeHome,
    CCDM_SESSION_NAME: "alpha_session",
    CCDM_ROUTER_ROLE: "project",
    CCDM_ROUTER_KEY_FILE: path.join(workspace.tmpDir, "alpha.key"),
    CCDM_DETACHED: "1",
  });

  const { env } = readConfig(hostStateRoot(workspace));
  assert.deepEqual(Object.keys(env).sort(), [
    "CCDM_PYTHON", "CCDM_ROUTER_NODE", "CCDM_ROUTER_STATE_DIR", "CCDM_SESSION_HOST", "CCDM_STATE_ROOT",
    "CLAUDE_CONFIG_DIR", "PATH", "PYTHONUTF8",
  ]);
  assert.equal(env.CLAUDE_CONFIG_DIR, claudeHome);
  assert.equal(env.CCDM_STATE_ROOT, hostStateRoot(workspace));
  assert.equal(env.CCDM_ROUTER_STATE_DIR, workspace.routerStateDir);
  assert.equal(env.CCDM_SESSION_HOST, "ccdm-host");
  assert.equal(env.PYTHONUTF8, "1");
  const directories = env.PATH.split(";");
  assert.ok(directories.includes(workspace.fixtureDir), "Claude's folder is on the task's PATH");
  assert.ok(directories.includes(path.dirname(process.execPath)), "node's folder is on the task's PATH");

  // With the defaults in use, the state root is recorded and the unset names are not.
  const plain = rootWorkspace();
  await install(plain, { CCDM_STATE_ROOT: undefined, CCDM_SESSION_HOST: undefined, CCDM_ROUTER_STATE_DIR: undefined });
  const recorded = readConfig(defaultStateRoot(plain)).env;
  assert.deepEqual(Object.keys(recorded).sort(), ["CCDM_PYTHON", "CCDM_ROUTER_NODE", "CCDM_STATE_ROOT", "PATH", "PYTHONUTF8"]);
  assert.equal(recorded.CCDM_STATE_ROOT, defaultStateRoot(plain));
});

test("an option, a relative account folder or a missing Claude stops the installer before any schtasks call", onlyWindows, async () => {
  const workspace = rootWorkspace();

  const codex = await ccdm(workspace, ["install-service", "root-at-logon", "--provider", "codex"]);
  assert.equal(codex.exitCode, 2, codex.stderr || codex.stdout);
  assert.match(codex.stderr, /install-service root-at-logon takes no options: --provider codex/);

  const relative = await ccdm(workspace, ["install-service", "root-at-logon"], { CLAUDE_CONFIG_DIR: "relative/home" });
  assert.equal(relative.exitCode, 2, relative.stderr || relative.stdout);
  assert.match(relative.stderr, /CLAUDE_CONFIG_DIR must be an absolute path/);

  fs.rmSync(path.join(workspace.fixtureDir, "claude.exe"));
  const missing = await ccdm(workspace, ["install-service", "root-at-logon"]);
  assert.equal(missing.exitCode, 1, missing.stderr || missing.stdout);
  assert.match(missing.stderr, /Claude Code was not found/);

  assert.deepEqual(invocations(workspace), []);
  assert.equal(fs.existsSync(serviceFile(hostStateRoot(workspace), ".json")), false);
});

test("with the Router and ccdm-host up, the run starts root once and root says hello to the Router", onlyWindows, async () => {
  const workspace = rootWorkspace();
  await startRouter(workspace);
  await startHost(workspace);
  await install(workspace);

  const exitCode = await runAsLogonTask(workspace, UNHURRIED);

  assert.equal(exitCode, 0, readLog(workspace, ".err") + readLog(workspace));
  await assertRootIsUp(workspace);
  const launches = rootLaunches(workspace);
  assert.equal(launches.length, 1, "restart-root ran once");
  const { name, kind, cwd, env } = launches[0];
  assert.deepEqual({ name, kind, cwd }, { name: "root_agent", kind: "root", cwd: fs.realpathSync.native(workspace.repoDir) });
  assert.equal(env.CCDM_STATE_ROOT, hostStateRoot(workspace));
  assert.equal(env.CCDM_ROUTER_STATE_DIR, workspace.routerStateDir);
  assert.equal(hostOps(workspace).some(call => call.op === "run-detached"), false, "restart-root ran in the foreground");
  const log = readLog(workspace);
  assert.match(log, /root-at-logon: waiting up to 120 s for the Router and ccdm-host/);
  assert.doesNotMatch(log, /not reachable after/);
  assert.match(log, /Root channel server connected to the Router/);
  assert.match(log, /root-at-logon: root is up/);
  assert.equal(fs.existsSync(serviceFile(hostStateRoot(workspace), ".state.json")), false, "a --once run keeps no state");
});

test("root's account from the install reaches root's session at logon", onlyWindows, async () => {
  const workspace = rootWorkspace();
  const claudeHome = path.join(workspace.homeDir, "root-claude-home");
  await startRouter(workspace);
  await startHost(workspace);
  await install(workspace, { CLAUDE_CONFIG_DIR: claudeHome });

  const exitCode = await runAsLogonTask(workspace, UNHURRIED);

  assert.equal(exitCode, 0, readLog(workspace, ".err") + readLog(workspace));
  assert.equal(rootLaunches(workspace)[0].env.CLAUDE_CONFIG_DIR, claudeHome);
});

test("with the Router down for the whole window, the run gives up after 120 s, logs 'router not reachable' and starts nothing", onlyWindows, async () => {
  const workspace = rootWorkspace();
  await startHost(workspace);
  await install(workspace);

  const started = Date.now();
  const exitCode = await runAsLogonTask(workspace, GIVES_UP_SOON);
  const elapsed = Date.now() - started;

  assert.equal(exitCode, 1);
  assert.ok(elapsed >= 2000, `the run waited its whole window, 2 s on this clock: ${elapsed} ms`);
  const log = readLog(workspace);
  assert.match(log, /root-at-logon: still waiting for: router\n/);
  assert.match(log, /root-at-logon: router not reachable after 120 s\n/);
  assert.doesNotMatch(log, /ccdm-host not reachable/);
  assertNothingStarted(workspace);
});

test("with ccdm-host down for the whole window, the run gives up after 120 s, logs 'ccdm-host not reachable' and starts nothing", onlyWindows, async () => {
  const workspace = rootWorkspace();
  await startRouter(workspace);
  await install(workspace);

  const started = Date.now();
  const exitCode = await runAsLogonTask(workspace, GIVES_UP_SOON);
  const elapsed = Date.now() - started;

  assert.equal(exitCode, 1);
  assert.ok(elapsed >= 2000, `the run waited its whole window, 2 s on this clock: ${elapsed} ms`);
  const log = readLog(workspace);
  assert.match(log, /root-at-logon: still waiting for: ccdm-host\n/);
  assert.match(log, /root-at-logon: ccdm-host not reachable after 120 s\n/);
  assert.doesNotMatch(log, /router not reachable|still waiting for: router/);
  assert.equal(fs.existsSync(rootKey(workspace)), false, "no root key was written");
  assert.match(log, /root was not started/);
  const status = await runRouterCli(workspace, ["status"]);
  assert.match(status.stdout, /sessions: 0/);
});

test("with neither up, the run names both and exits non-zero", onlyWindows, async () => {
  const workspace = rootWorkspace();
  await install(workspace);

  const exitCode = await runAsLogonTask(workspace, 120);

  assert.equal(exitCode, 1);
  const log = readLog(workspace);
  assert.match(log, /root-at-logon: router not reachable after 120 s\n/);
  assert.match(log, /root-at-logon: ccdm-host not reachable after 120 s\n/);
  assert.match(log, /root was not started/);
  assert.equal(fs.existsSync(rootKey(workspace)), false, "no root key was written");
});

test("when ccdm-host and then the Router come up late but within the window, root starts", onlyWindows, async () => {
  const workspace = rootWorkspace();
  await install(workspace);

  const run = runAsLogonTask(workspace, UNHURRIED);
  const logged = pattern => waitFor(() => pattern.test(readLog(workspace)), () => `${pattern} in the log: ${readLog(workspace)}`, 15000);
  await logged(/still waiting for: router, ccdm-host\n/);
  assert.deepEqual(rootLaunches(workspace), []);
  await startHost(workspace);
  await logged(/still waiting for: router\n/);
  assert.deepEqual(rootLaunches(workspace), [], "root is not started while the Router is still down");
  await startRouter(workspace);
  const exitCode = await run;

  assert.equal(exitCode, 0, readLog(workspace, ".err") + readLog(workspace));
  await assertRootIsUp(workspace);
  assert.equal(rootLaunches(workspace).length, 1, "restart-root ran once");
  assert.doesNotMatch(readLog(workspace), /not reachable after/);
});

test("uninstall-service root-at-logon removes the task and service-status follows it", onlyWindows, async () => {
  const workspace = rootWorkspace();
  await install(workspace);
  assert.match((await ccdm(workspace, ["service-status", "root-at-logon"])).stdout, /^root-at-logon: installed \(task \\CCDM\\RootAtLogon\)/m);

  const removed = await ccdm(workspace, ["uninstall-service", "root-at-logon"]);

  assert.equal(removed.exitCode, 0, removed.stderr || removed.stdout);
  assert.match(removed.stdout, /Task \\CCDM\\RootAtLogon removed/);
  assert.equal(readState(workspace.stateDir).fixtures.schtasks.tasks.includes(TASK), false);
  assert.equal(verbs(workspace).includes("/end"), false, "schtasks /end is not a stop");
  assert.equal(fs.existsSync(serviceFile(hostStateRoot(workspace), ".json")), false);
  assert.match((await ccdm(workspace, ["service-status", "root-at-logon"])).stdout, /^root-at-logon: not installed/m);
});

test("the hidden root-at-logon subcommand stays out of ccdm --help and refuses a bad --wait", async () => {
  const workspace = rootWorkspace();

  const help = await ccdm(workspace, ["--help"]);
  assert.equal(help.exitCode, 0, help.stderr);
  assert.match(help.stdout, /install-service/);
  assert.doesNotMatch(help.stdout, /root-at-logon/);

  for (const value of ["-1", "soon", "nan", "inf"]) {
    const refused = await ccdm(workspace, ["root-at-logon", `--wait=${value}`]);
    assert.equal(refused.exitCode, 2, value);
    assert.match(refused.stderr, /--wait/, value);
  }
});

test("on macOS and Linux install-service root-at-logon is refused and reaches no installer", platformGate("posix", "root-at-logon is a Windows task; macOS keeps its LaunchAgent"), async () => {
  const workspace = rootWorkspace();

  const result = await ccdm(workspace, ["install-service", "root-at-logon"]);

  assert.equal(result.exitCode, 2, result.stderr || result.stdout);
  assert.match(result.stderr, /service "root-at-logon" is not available yet/);
  assert.deepEqual(readState(workspace.stateDir).fixtures.launchctl.invocations, []);
});

test("the macOS root LaunchAgent in the README and the restart-root-agent.sh shim are as they were", () => {
  const readme = fs.readFileSync(path.join(REPO, "README.md"), "utf8");
  assert.match(readme, /cat > ~\/Library\/LaunchAgents\/com\.claude\.root-agent\.plist/);
  assert.match(readme, /The Launch Agent runs `restart-root-agent\.sh` on login/);
  const shim = fs.readFileSync(path.join(REPO, "restart-root-agent.sh"), "utf8");
  assert.match(shim, /^exec "\$\(cd "\$\(dirname "\$0"\)" && pwd\)\/scripts\/ccdm" restart-root "\$@"$/m);
  assert.doesNotMatch(shim, /root-at-logon/);
});
