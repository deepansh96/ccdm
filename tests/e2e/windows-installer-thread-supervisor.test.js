// The Windows Thread Supervisor service: install, disable and enable, the refusals
// and uninstall, through a fixture schtasks and the real service host. Task
// Scheduler is never reached: `schtasks` resolves to the workspace's fixture and
// the workspace's PATH holds nothing else. Thread sessions live on the fake
// ccdm-host, as in every other thread suite on Windows.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import nodeTest from "node:test";
import os from "node:os";
import path from "node:path";

import { bridgeChildEnv } from "./support/bridge.js";
import { PYTHON, assertPrivate, platformGate, suiteTest } from "./support/platform.js";
import { createRouterWorkspace, routerWithWebhooks, runRouterCli } from "./support/router.js";
import { runScript, scaledTimeout } from "./support/runner.js";
import { callSeam, hostOps } from "./support/session-fixture.js";
import { readState, writeState } from "./support/state.js";
import { cleanup, registerTeardownCallback } from "./support/teardown.js";
import {
  startThreadHost, startThreadSupervisor, supervisorCli, supervisorEnv, supervisorStateDir, supervisorStatus,
} from "./support/thread-supervisor.js";

const test = suiteTest(nodeTest, import.meta.url);
test.afterEach(async () => cleanup());

const TASK = "\\CCDM\\ThreadSupervisor";
const THREAD_SESSION = "demo_session-t-1700000000000249001";
const onlyWindows = platformGate("win32", "Task Scheduler and ccdm-host exist only on Windows");
// What a test carries past the service host's clean environment: fixture state only.
const TEST_PASS = "CCDM_TEST_STATE,CCDM_TEST_ACCELERATE_TYPING";
const ALWAYS_SET = ["CCDM_PYTHON", "CCDM_ROUTER_NODE", "CCDM_ROUTER_STATE_DIR", "CCDM_STATE_ROOT", "PATH", "PYTHONUTF8"];

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(what, predicate, timeoutMs = scaledTimeout(30000)) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await pause(100);
  }
}

const real = file => fs.realpathSync.native(file);
const installEnv = (workspace, extra = {}) => supervisorEnv(workspace, { CCDM_SERVICE_HOST_TEST_PASS: TEST_PASS, ...extra });
const stateRoot = workspace => installEnv(workspace).CCDM_STATE_ROOT ?? path.join(workspace.homeDir, ".local", "state", "ccdm");
const serviceFile = (workspace, suffix) => path.join(stateRoot(workspace), "services", `thread-supervisor${suffix}`);
const schtasks = workspace => readState(workspace.stateDir).fixtures.schtasks;
const verbs = workspace => schtasks(workspace).invocations.map(entry => entry.verb);
const runs = workspace => verbs(workspace).filter(verb => verb === "/run").length;
const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};
const serviceState = workspace => readJson(serviceFile(workspace, ".state.json"));

// Python directly on Windows, as the other installer tests do.
const ccdm = (workspace, args, env = {}) => runScript(workspace, "scripts/ccdm.py", {
  args, env: installEnv(workspace, env), timeoutMs: scaledTimeout(120000),
});

// What Task Scheduler does with the task's action: the program the XML names,
// without its conhost, on a hidden console of its own. It gets none of the
// installer's CCDM settings, as a real task does not.
function startTaskAction(workspace) {
  const xml = schtasks(workspace).definitions[TASK];
  assert.match(/<Command>([^<]*)<\/Command>/.exec(xml)[1], /conhost\.exe$/);
  const args = [...(/<Arguments>([^<]*)<\/Arguments>/.exec(xml)[1]).matchAll(/&quot;([^&]*)&quot;|"([^"]*)"|(\S+)/g)].map(m => m[1] ?? m[2] ?? m[3]);
  assert.equal(args[0], "--headless");
  const cwd = /<WorkingDirectory>([^<]*)<\/WorkingDirectory>/.exec(xml)[1];
  const env = bridgeChildEnv(workspace, { CCDM_SERVICE_HOST_TEST_PASS: TEST_PASS });
  const child = spawn(args[1], args.slice(2), { cwd, env, stdio: "ignore", windowsHide: true });
  registerTeardownCallback(() => child.kill());
  child.exitedWith = new Promise(resolve => child.once("close", resolve));
  return child;
}

// Stands in for Task Scheduler answering /run, and marks the task Running.
async function actAsScheduler(workspace, runsBefore = 0) {
  await waitFor("schtasks /run", () => runs(workspace) > runsBefore);
  const child = startTaskAction(workspace);
  const state = readState(workspace.stateDir);
  state.fixtures.schtasks.running[TASK] = child.pid;
  writeState(state, workspace.stateDir);
  return child;
}

async function install(workspace, env = {}) {
  const runsBefore = runs(workspace);
  const installing = ccdm(workspace, ["install-service", "thread-supervisor"], env);
  const serviceHost = await actAsScheduler(workspace, runsBefore);
  const result = await installing;
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Task \\CCDM\\ThreadSupervisor installed and running/);
  return { result, serviceHost };
}

async function routerStatus(workspace) {
  const text = await runRouterCli(workspace, ["status"]);
  const json = await runRouterCli(workspace, ["status", "--json"]);
  assert.equal(json.exitCode, 0, json.stderr || json.stdout);
  return { text: text.stdout, json: JSON.parse(json.stdout) };
}
const supervisorConnected = async workspace => /^supervisor: connected/m.test((await runRouterCli(workspace, ["status"])).stdout);

async function supervisorWorkspace() {
  const workspace = createRouterWorkspace();
  await routerWithWebhooks(workspace, ["demo", "beta"]);
  await startThreadHost(workspace);
  return workspace;
}

// A session on the host that the supervisor did not start: it stands for a live thread session.
async function startHostSession(workspace) {
  const started = await callSeam(workspace, "python", "start", {
    positional: [THREAD_SESSION, [process.execPath, "-e", "setInterval(() => {}, 1000)"], workspace.tmpRoot],
    options: { kind: "thread", pty: false }, env: supervisorEnv(workspace), python: PYTHON,
  });
  assert.equal(started.ok, true, started.message);
}
async function hostSessions(workspace) {
  const listed = await callSeam(workspace, "python", "list", { env: supervisorEnv(workspace), python: PYTHON });
  assert.equal(listed.ok, true, listed.message);
  return listed.value.map(session => session.name);
}
const hostKills = workspace => hostOps(workspace).filter(call => call.op === "kill");
// `router status` asks the fixture whether the task exists; nothing else may reach it.
const changes = workspace => verbs(workspace).filter(verb => verb !== "/query");

test("install-service thread-supervisor runs the supervised worker under a logon task; disable stops it for good, enable and a reinstall bring it back, and uninstall leaves thread sessions alone", onlyWindows, async () => {
  const workspace = await supervisorWorkspace();
  const claudeHome = path.join(workspace.tmpRoot, "p5.3-claude-home");
  assert.equal((await routerStatus(workspace)).json.threads_enabled, false);

  const { result, serviceHost } = await install(workspace, { CLAUDE_CONFIG_DIR: claudeHome });
  assert.match(result.stdout, /Run py -3 scripts\\thread-supervisor\.py status for the worker/);

  // Only the service that was asked for: reminders stay opt-in.
  assert.deepEqual(schtasks(workspace).tasks, [TASK]);
  const xml = schtasks(workspace).definitions[TASK];
  assert.match(xml, /<URI>\\CCDM\\ThreadSupervisor<\/URI>/);
  const user = /<Principal id="Author">\s*<UserId>([^<]+)<\/UserId>/.exec(xml)[1];
  assert.match(user, new RegExp(`\\\\${os.userInfo().username}$`, "i"));
  assert.match(xml, new RegExp(`<LogonTrigger>\\s*<Enabled>true</Enabled>\\s*<UserId>${user.replaceAll("\\", "\\\\")}</UserId>`));
  assert.match(xml, /<Interval>PT5M<\/Interval>/);
  assert.match(xml, /<LogonType>InteractiveToken<\/LogonType>/);
  assert.match(xml, /<ExecutionTimeLimit>PT0S<\/ExecutionTimeLimit>/);
  assert.match(xml, /<Arguments>--headless "[^"]*node[^"]*" "[^"]*service-host\.js" --config "[^"]*thread-supervisor\.json"<\/Arguments>/);

  // What the service host runs: the supervised worker, as the macOS plist does.
  const config = readJson(serviceFile(workspace, ".json"));
  const [python, script, ...args] = config.command;
  assert.ok(path.win32.isAbsolute(python), python);
  assert.doesNotMatch(python, /\\WindowsApps\\/i);
  // Python reports the long form of a temp folder that the runner names in its 8.3 form.
  assert.equal(real(script), real(path.join(workspace.repoDir, "scripts", "thread-supervisor.py")));
  assert.deepEqual([args[0], args[1], args[2], args[4]], ["run", "--supervised", "--project-root", "--state-dir"]);
  assert.equal(args.length, 6);
  assert.equal(real(args[3]), real(workspace.repoDir));
  assert.equal(real(args[5]), real(supervisorStateDir(workspace)));
  assert.equal(real(config.cwd), real(workspace.repoDir));

  // Exactly the names the worker reads, and of the installation's own names only those that were set.
  const carried = ["CLAUDE_CONFIG_DIR", "CCDM_SESSION_HOST"];
  assert.deepEqual(Object.keys(config.env).sort(), [...ALWAYS_SET, ...carried].sort());
  assert.equal(config.env.CCDM_PYTHON, python);
  assert.equal(config.env.CCDM_ROUTER_NODE, process.execPath);
  assert.equal(real(config.env.CCDM_ROUTER_STATE_DIR), real(workspace.routerStateDir));
  assert.equal(real(config.env.CCDM_STATE_ROOT), real(stateRoot(workspace)));
  assert.equal(config.env.PYTHONUTF8, "1");
  assert.equal(config.env.CLAUDE_CONFIG_DIR, claudeHome);
  assert.equal(config.env.CCDM_SESSION_HOST, "ccdm-host");
  for (const directory of [path.dirname(process.execPath), path.dirname(python)]) {
    assert.ok(config.env.PATH.split(path.delimiter).includes(directory), `${directory} is on the task's PATH`);
  }
  assertPrivate(path.join(stateRoot(workspace), "services"));
  assertPrivate(supervisorStateDir(workspace));

  // The worker itself: running, and the Router's supervisor.
  await waitFor("the supervisor's Router connection", () => supervisorConnected(workspace));
  const running = await supervisorStatus(workspace);
  assert.equal(running.running, true);
  assert.equal(running.router, "connected");
  assert.equal(serviceState(workspace).state, "running");
  const listed = await ccdm(workspace, ["service-status", "thread-supervisor"]);
  assert.match(listed.stdout, /^thread-supervisor: running \(task \\CCDM\\ThreadSupervisor/m);

  // disable: the worker exits 0, so the service host stays stopped and a watchdog start does nothing.
  await startHostSession(workspace);
  const disabled = await supervisorCli(workspace, "disable");
  assert.equal(disabled.exitCode, 0, disabled.stderr || disabled.stdout);
  assert.equal(await serviceHost.exitedWith, 0);
  assert.equal(serviceState(workspace).state, "disabled");
  assert.equal(serviceState(workspace).last_exit_code, 0);
  assert.equal(await startTaskAction(workspace).exitedWith, 0, "a watchdog start exits at once");
  assert.equal((await supervisorStatus(workspace)).running, false);
  assert.ok((await hostSessions(workspace)).includes(THREAD_SESSION), "the thread session outlived the worker");
  // The installed task alone keeps threads enabled.
  const stopped = await routerStatus(workspace);
  assert.doesNotMatch(stopped.text, /^supervisor: connected/m);
  assert.equal(stopped.json.threads_enabled, true);

  // An install while disabled registers the task and starts nothing.
  const runsBefore = runs(workspace);
  const whileDisabled = await ccdm(workspace, ["install-service", "thread-supervisor"]);
  assert.equal(whileDisabled.exitCode, 0, whileDisabled.stderr || whileDisabled.stdout);
  assert.match(whileDisabled.stdout, /The Thread Supervisor is disabled: .*thread-supervisor\.py enable and then this command again/);
  assert.equal(runs(workspace), runsBefore);
  assert.equal((await supervisorStatus(workspace)).running, false);

  // enable, then install-service: it runs again.
  const enabled = await supervisorCli(workspace, "enable");
  assert.equal(enabled.exitCode, 0, enabled.stderr || enabled.stdout);
  const again = await install(workspace);
  await waitFor("the supervisor's Router connection after enable", () => supervisorConnected(workspace));
  assert.equal(fs.existsSync(serviceFile(workspace, ".disabled")), false);

  // uninstall: the worker stops, the task goes, and the host is never asked to stop a session.
  const removed = await ccdm(workspace, ["uninstall-service", "thread-supervisor"]);
  assert.equal(removed.exitCode, 0, removed.stderr || removed.stdout);
  assert.match(removed.stdout, /Task \\CCDM\\ThreadSupervisor removed/);
  assert.equal(await again.serviceHost.exitedWith, 0);
  assert.equal(schtasks(workspace).tasks.includes(TASK), false);
  assert.equal(verbs(workspace).includes("/end"), false, "schtasks /end is not a stop");
  assert.equal((await supervisorStatus(workspace)).running, false);
  assert.ok((await hostSessions(workspace)).includes(THREAD_SESSION), "the thread session outlived the task");
  assert.deepEqual(hostKills(workspace), [], "the host was never asked to end a session");
  await waitFor("the supervisor to leave the Router", async () => !(await supervisorConnected(workspace)));
  assert.equal((await routerStatus(workspace)).json.threads_enabled, false);
});

test("with the Router unreachable the installer prints the blockers, exits 2 and never calls schtasks", onlyWindows, async () => {
  const workspace = createRouterWorkspace();

  const result = await ccdm(workspace, ["install-service", "thread-supervisor"]);

  assert.equal(result.exitCode, 2, result.stderr || result.stdout);
  assert.match(result.stderr, /Thread Supervisor preflight failed; the existing task was left unchanged/);
  assert.match(result.stderr, /^ {2}- the Router is not reachable/m);
  assert.deepEqual(schtasks(workspace).invocations, []);
  assert.equal(fs.existsSync(serviceFile(workspace, ".json")), false);
  assert.equal(fs.existsSync(supervisorStateDir(workspace)), false, "the preflight created nothing");
});

test("a worker started by hand is not replaced: the installer exits 1 before any schtasks call, and a relative state directory exits 2", onlyWindows, async () => {
  const workspace = await supervisorWorkspace();
  const byHand = await startThreadSupervisor(workspace);

  const refused = await ccdm(workspace, ["install-service", "thread-supervisor"]);

  assert.equal(refused.exitCode, 1, refused.stderr || refused.stdout);
  assert.match(refused.stderr, /a Thread Supervisor worker is already running outside the service/);
  assert.deepEqual(changes(workspace), []);
  assert.equal(fs.existsSync(serviceFile(workspace, ".json")), false);
  assert.equal((await supervisorStatus(workspace)).running, true, "the worker was left running");
  assert.equal((await byHand.stop()).exitCode, 0);

  const relative = await ccdm(workspace, ["install-service", "thread-supervisor"], { CCDM_THREAD_SUPERVISOR_STATE_DIR: "relative/dir" });
  assert.equal(relative.exitCode, 2, relative.stderr || relative.stdout);
  assert.match(relative.stderr, /CCDM_THREAD_SUPERVISOR_STATE_DIR must be an absolute path/);
  assert.deepEqual(changes(workspace), []);
});
