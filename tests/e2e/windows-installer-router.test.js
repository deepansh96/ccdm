// The Windows Router service: install, uninstall and status through a fixture
// schtasks, and the service host itself with a scaled clock and a fake daemon.
// Task Scheduler is never reached: `schtasks` resolves to the workspace's fixture
// and the workspace's PATH holds nothing else.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import nodeTest from "node:test";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PYTHON, assertPrivate, platformGate, suiteTest } from "./support/platform.js";
import { routerEnv, runRouterCli, createRouterWorkspace, ROOT_TOKEN } from "./support/router.js";
import { runScript, scaledTimeout } from "./support/runner.js";
import { readState, writeState } from "./support/state.js";
import { cleanup, registerTeardownCallback } from "./support/teardown.js";

const test = suiteTest(nodeTest, import.meta.url);
test.afterEach(async () => cleanup());

const require = createRequire(import.meta.url);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const TASK = "\\CCDM\\Router";
const onlyWindows = platformGate("win32", "Task Scheduler and conhost exist only on Windows");

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(what, predicate, timeoutMs = scaledTimeout(15000)) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await pause(50);
  }
}

const rootStateDir = workspace => path.join(workspace.homeDir, ".claude", "channels", "discord");
const serviceDir = workspace => path.join(workspace.homeDir, ".local", "state", "ccdm", "services");
const serviceFile = (workspace, suffix) => path.join(serviceDir(workspace), `router${suffix}`);
const invocations = workspace => readState(workspace.stateDir).fixtures.schtasks.invocations;
const verbs = workspace => invocations(workspace).map(entry => entry.verb);
const readServiceState = workspace => {
  try {
    return JSON.parse(fs.readFileSync(serviceFile(workspace, ".state.json"), "utf8"));
  } catch {
    return null;
  }
};

// The preflight blocks on a token directory that inherits access.
function protectTokenDir(workspace) {
  if (process.platform === "win32") require("../../scripts/platform/privacy.js").ensurePrivateDirSync(rootStateDir(workspace));
}

function installEnv(workspace, extra = {}) {
  return routerEnv(workspace, {
    ROOT_DISCORD_STATE_DIR: rootStateDir(workspace),
    CCDM_ROUTER_NODE: process.execPath,
    CCDM_SERVICE_HOST_TEST_PASS: "CCDM_TEST_STATE,CCDM_TEST_ACCELERATE_TYPING",
    ...extra,
  });
}

// Python directly on Windows; on POSIX scripts/ccdm.py is not executable and the sh entry starts it.
const CCDM_ENTRY = process.platform === "win32" ? "scripts/ccdm.py" : "scripts/ccdm";
const ccdm = (workspace, args, env = {}) => runScript(workspace, CCDM_ENTRY, {
  args, env: installEnv(workspace, env), timeoutMs: scaledTimeout(30000),
});

function seedTask(workspace, xml) {
  const state = readState(workspace.stateDir);
  state.fixtures.schtasks.tasks = [TASK];
  state.fixtures.schtasks.definitions = { [TASK]: xml };
  writeState(state, workspace.stateDir);
}

// Stands in for Task Scheduler answering /run: starts the program the XML names,
// without its conhost, on a hidden console of its own, and marks the task Running.
// The fixture cannot do this: a process it started dies with it on Windows.
async function actAsScheduler(workspace, runsBefore = 0) {
  await waitFor("schtasks /run", () => verbs(workspace).filter(verb => verb === "/run").length > runsBefore);
  const xml = readState(workspace.stateDir).fixtures.schtasks.definitions[TASK];
  const [, command] = /<Command>([^<]*)<\/Command>/.exec(xml);
  assert.match(command, /conhost\.exe$/);
  const args = [...(/<Arguments>([^<]*)<\/Arguments>/.exec(xml)[1]).matchAll(/&quot;([^&]*)&quot;|"([^"]*)"|(\S+)/g)].map(m => m[1] ?? m[2] ?? m[3]);
  assert.equal(args[0], "--headless");
  const cwd = /<WorkingDirectory>([^<]*)<\/WorkingDirectory>/.exec(xml)[1];
  const child = spawn(args[1], args.slice(2), { cwd, env: installEnv(workspace), stdio: "ignore", windowsHide: true });
  registerTeardownCallback(() => child.kill());
  const state = readState(workspace.stateDir);
  state.fixtures.schtasks.running[TASK] = child.pid;
  writeState(state, workspace.stateDir);
  return child;
}

// A service host started directly, with a daemon written by the test.
function fakeDaemon(workspace, body) {
  const file = path.join(workspace.tmpDir, `daemon-${Math.random().toString(16).slice(2)}.js`);
  fs.writeFileSync(file, `const fs=require("node:fs");const runs=${JSON.stringify(path.join(workspace.tmpDir, "runs"))};
fs.appendFileSync(runs, "x");${body}`);
  return file;
}
function writeConfig(workspace, daemon) {
  fs.mkdirSync(serviceDir(workspace), { recursive: true });
  const config = serviceFile(workspace, ".json");
  fs.writeFileSync(config, JSON.stringify({
    name: "router",
    command: [process.execPath, daemon],
    cwd: workspace.repoDir,
    env: { PATH: path.dirname(process.execPath) },
    service_dir: serviceDir(workspace),
  }));
  return config;
}
function startHost(workspace, configFile, scale = 1) {
  const child = spawn(process.execPath, [path.join(workspace.repoDir, "scripts/win/service-host.js"), "--config", configFile], {
    env: { ...workspace.env, CCDM_SERVICE_HOST_TIME_SCALE: String(scale) },
    stdio: "ignore",
    windowsHide: true,
  });
  registerTeardownCallback(() => child.kill());
  child.exitedWith = new Promise(resolve => child.once("close", resolve));
  return child;
}
const runCount = workspace => {
  try {
    return fs.readFileSync(path.join(workspace.tmpDir, "runs"), "utf8").length;
  } catch {
    return 0;
  }
};
const hostMessages = workspace => {
  try {
    return fs.readFileSync(serviceFile(workspace, ".err"), "utf8");
  } catch {
    return "";
  }
};
const restartDelays = workspace => [...hostMessages(workspace).matchAll(/restart in (\d+)s/g)].map(match => Number(match[1]));

test("install-service registers a logon task, the Router runs, and service-status reports it; uninstall stops it with exit 0", onlyWindows, async () => {
  const workspace = createRouterWorkspace();
  protectTokenDir(workspace);

  const installing = ccdm(workspace, ["install-service", "router"]);
  await actAsScheduler(workspace);
  const installed = await installing;
  assert.equal(installed.exitCode, 0, installed.stderr || installed.stdout);
  assert.match(installed.stdout, /installed and running/);

  const definition = readState(workspace.stateDir).fixtures.schtasks.definitions[TASK];
  assert.ok(definition, "the task was created under \\CCDM\\");
  const user = /<Principal id="Author">\s*<UserId>([^<]+)<\/UserId>/.exec(definition)[1];
  assert.match(user, new RegExp(`\\\\${os.userInfo().username}$`, "i"));
  assert.match(definition, new RegExp(`<LogonTrigger>\\s*<Enabled>true</Enabled>\\s*<UserId>${user.replaceAll("\\", "\\\\")}</UserId>`));
  assert.match(definition, /<Interval>PT5M<\/Interval>/);
  assert.match(definition, /<LogonType>InteractiveToken<\/LogonType>/);
  assert.match(definition, /<ExecutionTimeLimit>PT0S<\/ExecutionTimeLimit>/);
  assert.match(definition, /<StopIfGoingOnBatteries>false<\/StopIfGoingOnBatteries>/);
  assert.match(definition, /<Command>[^<]*conhost\.exe<\/Command>/);
  assert.match(definition, /<Arguments>--headless "[^"]*node[^"]*" "[^"]*service-host\.js" --config "[^"]*router\.json"<\/Arguments>/);

  // Every box about the rendered config and the private state directory.
  const config = JSON.parse(fs.readFileSync(serviceFile(workspace, ".json"), "utf8"));
  assert.deepEqual(Object.keys(config.env).sort(), ["CCDM_ROUTER_STATE_DIR", "PATH", "ROOT_DISCORD_STATE_DIR"]);
  for (const text of [definition, JSON.stringify(config)]) assert.doesNotMatch(text, new RegExp(ROOT_TOKEN));
  assertPrivate(workspace.routerStateDir);
  assertPrivate(serviceDir(workspace));
  assert.ok(fs.existsSync(serviceFile(workspace, ".log")));
  assert.ok(fs.existsSync(serviceFile(workspace, ".err")));

  // The Router itself answers, through the real service host.
  await waitFor("the Router to answer", async () => (await runRouterCli(workspace, ["status"], { env: installEnv(workspace) })).exitCode === 0);
  assert.equal(readServiceState(workspace).state, "running");
  const status = await ccdm(workspace, ["service-status"]);
  assert.equal(status.exitCode, 0, status.stderr);
  assert.match(status.stdout, /^router: running \(task \\CCDM\\Router/m);

  const removed = await ccdm(workspace, ["uninstall-service", "router"]);
  assert.equal(removed.exitCode, 0, removed.stderr || removed.stdout);
  assert.match(hostMessages(workspace), /stop requested/, "the service host saw the stop file");
  assert.equal(readServiceState(workspace).last_exit_code, 0, "the Router exited 0");
  assert.equal(readState(workspace.stateDir).fixtures.schtasks.tasks.includes(TASK), false);
  assert.equal(verbs(workspace).includes("/end"), false, "schtasks /end is not a stop");
  assert.equal(fs.existsSync(serviceFile(workspace, ".stop")), false);
  assert.ok(fs.existsSync(serviceFile(workspace, ".disabled")), "a clean stop leaves the marker");
  assert.doesNotMatch((await ccdm(workspace, ["service-status"])).stdout, /running/);

  // Only install-service removes the marker.
  const runsBefore = verbs(workspace).filter(verb => verb === "/run").length;
  const reinstalling = ccdm(workspace, ["install-service", "router"]);
  await actAsScheduler(workspace, runsBefore);
  const reinstalled = await reinstalling;
  assert.equal(reinstalled.exitCode, 0, reinstalled.stderr || reinstalled.stdout);
  assert.equal(fs.existsSync(serviceFile(workspace, ".disabled")), false);
  await waitFor("the Router to answer again", async () => (await runRouterCli(workspace, ["status"], { env: installEnv(workspace) })).exitCode === 0);
  const again = await ccdm(workspace, ["uninstall-service", "router"]);
  assert.equal(again.exitCode, 0, again.stderr || again.stdout);
});

test("preflight blockers are printed one per line, exit 2, and schtasks is never called", onlyWindows, async () => {
  const workspace = createRouterWorkspace();
  protectTokenDir(workspace);
  fs.writeFileSync(path.join(rootStateDir(workspace), ".env"), "OTHER=1\n");
  fs.writeFileSync(path.join(workspace.repoDir, "registry.json"), "{not json");

  const result = await ccdm(workspace, ["install-service", "router"]);

  assert.equal(result.exitCode, 2, result.stderr || result.stdout);
  assert.match(result.stderr, /preflight failed/);
  assert.match(result.stderr, /  - .*registry\.json .*cannot be read/);
  assert.match(result.stderr, /  - .*root Discord token is missing/);
  assert.deepEqual(invocations(workspace), []);
});

test("a relative or unusable node exits 1 before any schtasks call", onlyWindows, async () => {
  for (const node of ["node", path.join(process.env.SystemRoot, "System32", "cmd.exe")]) {
    const workspace = createRouterWorkspace();
    protectTokenDir(workspace);

    const result = await ccdm(workspace, ["install-service", "router"], { CCDM_ROUTER_NODE: node });

    assert.equal(result.exitCode, 1, node);
    assert.match(result.stderr, /node 22 or newer is required/, node);
    assert.deepEqual(invocations(workspace), [], node);
  }
});

test("a relative state directory exits 2 before any schtasks call", onlyWindows, async () => {
  const workspace = createRouterWorkspace();
  protectTokenDir(workspace);

  const result = await ccdm(workspace, ["install-service", "router"], { ROOT_DISCORD_STATE_DIR: "relative/dir" });

  assert.equal(result.exitCode, 2, result.stderr || result.stdout);
  assert.match(result.stderr, /must be an absolute path/);
  assert.deepEqual(invocations(workspace), []);
});

test("an extra env key fails validation and nothing is installed", onlyWindows, async () => {
  const workspace = createRouterWorkspace();
  protectTokenDir(workspace);
  const module = path.join(workspace.repoDir, "scripts/ccdmlib/cli/services/router.py");
  const source = fs.readFileSync(module, "utf8");
  assert.ok(source.includes('env={**env, "PATH": path},'));
  fs.writeFileSync(module, source.replace('env={**env, "PATH": path},', 'env={**env, "PATH": path, "EXTRA": "x"},'));

  const result = await ccdm(workspace, ["install-service", "router"]);

  assert.equal(result.exitCode, 1, result.stderr || result.stdout);
  assert.match(result.stderr, /rendered task is invalid: env must contain exactly/);
  assert.deepEqual(invocations(workspace), []);
  assert.equal(fs.existsSync(serviceFile(workspace, ".json")), false);
});

test("a task that never reaches running is rolled back to the previous XML", onlyWindows, async () => {
  const workspace = createRouterWorkspace();
  protectTokenDir(workspace);
  const priorXml = "<Task><Actions><Exec><Command>prior.exe</Command><Arguments></Arguments><WorkingDirectory>C:\\</WorkingDirectory></Exec></Actions></Task>";
  seedTask(workspace, priorXml);

  const result = await ccdm(workspace, ["install-service", "router"], { CCDM_SERVICE_WAIT_SECONDS: "1" });

  assert.equal(result.exitCode, 1, result.stderr || result.stdout);
  assert.match(result.stderr, /did not reach running; restored the previous task/);
  const state = readState(workspace.stateDir).fixtures.schtasks;
  assert.deepEqual(state.tasks, [TASK]);
  assert.equal(state.definitions[TASK], priorXml);
  const order = verbs(workspace).filter(verb => verb !== "/query");
  assert.deepEqual(order, ["/create", "/run", "/create", "/run"]);
});

test("a first install that never reaches running leaves no task behind", onlyWindows, async () => {
  const workspace = createRouterWorkspace();
  protectTokenDir(workspace);

  const result = await ccdm(workspace, ["install-service", "router"], { CCDM_SERVICE_WAIT_SECONDS: "1" });

  assert.equal(result.exitCode, 1, result.stderr || result.stdout);
  assert.deepEqual(readState(workspace.stateDir).fixtures.schtasks.tasks, []);
  assert.equal(fs.existsSync(serviceFile(workspace, ".json")), false);
});

test("in a crash loop the delays double, the status commands say so, and router status exits 1", onlyWindows, async () => {
  const workspace = createRouterWorkspace();
  seedTask(workspace, "<Task/>");
  const host = startHost(workspace, writeConfig(workspace, fakeDaemon(workspace, "process.exit(3);")), 30);

  await waitFor("the seventh failure", () => restartDelays(workspace).length >= 7, scaledTimeout(30000));

  assert.deepEqual(restartDelays(workspace).slice(0, 7), [10, 10, 10, 10, 10, 20, 40]);
  await waitFor("the crashloop state", () => readServiceState(workspace)?.state === "crashloop");
  const state = readServiceState(workspace);
  assert.equal(state.last_exit_code, 3);

  const status = await runRouterCli(workspace, ["status"], { env: installEnv(workspace) });
  assert.equal(status.exitCode, 1);
  assert.match(status.stderr, /service: crashloop/);
  const listing = await ccdm(workspace, ["service-status", "router"]);
  assert.match(listing.stdout, /^router: crashloop/m);

  host.kill();
  await host.exitedWith;
});

test("the backoff follows its window, its cap and the uptime reset", () => {
  const { createBackoff } = require("../../scripts/win/service-host.js");
  const backoff = createBackoff();
  const seconds = at => backoff.fail(at * 1000) / 1000;

  // Five failures inside the window: 10 s each, no crash loop yet.
  assert.deepEqual([0, 1, 2, 3, 4].map(seconds), [10, 10, 10, 10, 10]);
  assert.equal(backoff.crashloop, false);
  // The sixth starts the loop and each later one doubles, to the cap.
  assert.equal(seconds(5), 20);
  assert.equal(backoff.crashloop, true);
  assert.deepEqual([700, 800, 900, 1000, 1100, 1200, 1300].map(seconds), [40, 80, 160, 320, 600, 600, 600]);
  // 30 min of uptime: the next failure is back at the start.
  backoff.reset();
  assert.equal(backoff.crashloop, false);
  assert.equal(seconds(1400), 10);

  // A failure that has aged out of the sliding window does not count.
  const aged = createBackoff();
  for (const at of [0, 1, 2, 3, 4]) aged.fail(at * 1000);
  assert.equal(aged.fail(601 * 1000) / 1000, 10);
  assert.equal(aged.crashloop, false);
});

test("thirty minutes of uptime ends a crash loop in the running host", async () => {
  const workspace = createRouterWorkspace();
  // At 60x real time: fails six times, then stays up 31 scaled minutes, then fails.
  const daemon = fakeDaemon(workspace, `
const count = fs.statSync(runs).size;
if (count >= 7) setTimeout(() => process.exit(4), 31000); else process.exit(3);`);
  startHost(workspace, writeConfig(workspace, daemon), 60);

  await waitFor("the crash loop", () => restartDelays(workspace).length >= 6, scaledTimeout(30000));
  assert.deepEqual(restartDelays(workspace).slice(0, 6), [10, 10, 10, 10, 10, 20]);
  await waitFor("the uptime reset", () => readServiceState(workspace)?.state === "running", 60000);
  await waitFor("the next failure", () => restartDelays(workspace).length >= 7, 60000);
  assert.equal(restartDelays(workspace)[6], 10);
});

test("an exit 0 is not restarted, leaves the marker, and a later watchdog run exits at once", async () => {
  const workspace = createRouterWorkspace();
  const config = writeConfig(workspace, fakeDaemon(workspace, "process.exit(0);"));
  const host = startHost(workspace, config);

  assert.equal(await host.exitedWith, 0);
  assert.equal(runCount(workspace), 1);
  assert.ok(fs.existsSync(serviceFile(workspace, ".disabled")));
  assert.equal(readServiceState(workspace).state, "disabled");

  const watchdog = startHost(workspace, config);
  assert.equal(await watchdog.exitedWith, 0);
  assert.equal(runCount(workspace), 1, "no second start while the marker exists");
});

test("a watchdog run while the host is running exits 0 and starts no second daemon", async () => {
  const workspace = createRouterWorkspace();
  const config = writeConfig(workspace, fakeDaemon(workspace, "setInterval(() => {}, 1000);"));
  const first = startHost(workspace, config);
  await waitFor("the daemon to start", () => readServiceState(workspace)?.state === "running");

  const second = startHost(workspace, config);

  assert.equal(await second.exitedWith, 0);
  assert.equal(runCount(workspace), 1);
  assert.equal(readServiceState(workspace).host_pid, first.pid);
});

test("a stop file ends a running daemon and the host exits 0", async () => {
  const workspace = createRouterWorkspace();
  // Windows has no SIGTERM to send: the daemon's clean exit is Ctrl+Break on its console.
  const daemon = fakeDaemon(workspace, `const stop = () => process.exit(0);
for (const signal of ["SIGTERM", "SIGBREAK"]) process.on(signal, stop);
setInterval(() => {}, 1000);`);
  const host = startHost(workspace, writeConfig(workspace, daemon));
  await waitFor("the daemon to start", () => readServiceState(workspace)?.state === "running");

  fs.writeFileSync(serviceFile(workspace, ".stop"), "now\n");

  assert.equal(await host.exitedWith, 0);
  assert.equal(readServiceState(workspace).state, "disabled");
  assert.equal(readServiceState(workspace).last_exit_code, 0);
  assert.ok(fs.existsSync(serviceFile(workspace, ".disabled")));
  assert.equal(fs.existsSync(serviceFile(workspace, ".stop")), false);
});

test("a host that cannot write its marker still exits instead of lingering without a daemon", async () => {
  const workspace = createRouterWorkspace();
  const go = path.join(workspace.tmpDir, "go");
  const daemon = fakeDaemon(workspace, `setInterval(() => { if (fs.existsSync(${JSON.stringify(go)})) process.exit(0); }, 20);`);
  const host = startHost(workspace, writeConfig(workspace, daemon));
  await waitFor("the daemon to start", () => readServiceState(workspace)?.state === "running");
  await waitFor("the daemon to run", () => runCount(workspace) === 1);
  // A directory in the marker's place makes writing it fail.
  fs.mkdirSync(serviceFile(workspace, ".disabled"));

  fs.writeFileSync(go, "now\n");

  assert.equal(await host.exitedWith, 1);
  assert.equal(fs.existsSync(serviceFile(workspace, ".lock")), false, "the lock is released");
});

test("a log over 10 MiB rotates and at most three old files stay", async () => {
  const workspace = createRouterWorkspace();
  const chunk = 11 * 1024 * 1024;
  const daemon = fakeDaemon(workspace, `process.stdout.write(Buffer.alloc(${chunk}, 120), () => process.exit(fs.statSync(runs).size >= 5 ? 0 : 1));`);
  const host = startHost(workspace, writeConfig(workspace, daemon), 1000);

  assert.equal(await host.exitedWith, 0);
  assert.equal(runCount(workspace), 5);
  const names = fs.readdirSync(serviceDir(workspace)).filter(name => name.startsWith("router.log"));
  assert.deepEqual(names.sort(), ["router.log", "router.log.1", "router.log.2", "router.log.3"]);
  for (const old of ["router.log.1", "router.log.2", "router.log.3"]) {
    assert.ok(fs.statSync(path.join(serviceDir(workspace), old)).size >= 10 * 1024 * 1024, old);
  }
});

test("--once runs the command once with the same logging and returns its exit code", async () => {
  const workspace = createRouterWorkspace();
  const config = writeConfig(workspace, fakeDaemon(workspace, 'console.log("once-output"); process.exit(7);'));
  const child = spawn(process.execPath, [path.join(workspace.repoDir, "scripts/win/service-host.js"), "--config", config, "--once"], {
    env: workspace.env,
    stdio: "ignore",
    windowsHide: true,
  });
  const code = await new Promise(resolve => child.once("close", resolve));

  assert.equal(code, 7);
  assert.equal(runCount(workspace), 1);
  assert.match(fs.readFileSync(serviceFile(workspace, ".log"), "utf8"), /once-output/);
  assert.equal(fs.existsSync(serviceFile(workspace, ".disabled")), false);
});

test("a service that takes no options refuses them before any schtasks call", onlyWindows, async () => {
  const workspace = createRouterWorkspace();
  protectTokenDir(workspace);

  const result = await ccdm(workspace, ["install-service", "router", "--interval", "600"]);

  assert.equal(result.exitCode, 2, result.stderr || result.stdout);
  assert.match(result.stderr, /takes no options/);
  assert.deepEqual(invocations(workspace), []);
});

test("a later service adds only its module and template: options, template values, no start, its own subcommand", onlyWindows, async () => {
  const workspace = createRouterWorkspace();
  const winDir = path.join(workspace.repoDir, "scripts", "win");
  const template = fs.readFileSync(path.join(winDir, "router.task.xml.in"), "utf8")
    .replace(/<LogonTrigger>[\s\S]*?<\/LogonTrigger>\s*/, "")
    .replace("<Interval>PT5M</Interval>", "<Interval>__INTERVAL__</Interval>");
  fs.writeFileSync(path.join(winDir, "usage-poster.task.xml.in"), template);
  fs.writeFileSync(path.join(workspace.repoDir, "scripts/ccdmlib/cli/services/usage_poster.py"), `
from . import ROOT_DIR, Plan, require_node

TEMPLATE = "usage-poster.task.xml.in"
ACCEPTS_OPTIONS = True


def plan(context):
    node = require_node()
    return Plan(node=node, command=[node, "-e", "0"], cwd=str(ROOT_DIR), env={"PATH": "x"},
                allowed_env=frozenset(("PATH",)), private_dirs=[], supervised=False,
                template_values={"__INTERVAL__": context.options[1]})


def hidden(_args):
    print("hidden-ran")
    return 0


def register(subparsers):
    subparsers.add_parser("fixture-hidden").set_defaults(func=hidden)
`);

  const result = await ccdm(workspace, ["install-service", "usage-poster", "--interval", "PT10M"]);

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  const name = "\\CCDM\\UsagePoster";
  assert.match(readState(workspace.stateDir).fixtures.schtasks.definitions[name], /<Interval>PT10M<\/Interval>/);
  assert.equal(verbs(workspace).includes("/run"), false, "a scheduled task is not started at install");
  const hidden = await ccdm(workspace, ["fixture-hidden"]);
  assert.equal(hidden.exitCode, 0, hidden.stderr);
  assert.match(hidden.stdout, /hidden-ran/);
});

test("install-service for a known service without a module exits 2 with 'not available yet'", async () => {
  const workspace = createRouterWorkspace();
  // Every service gets its module in time, so the case takes one away.
  fs.rmSync(path.join(workspace.repoDir, "scripts/ccdmlib/cli/services/host.py"));

  const result = await ccdm(workspace, ["install-service", "host"]);

  assert.equal(result.exitCode, 2, result.stderr || result.stdout);
  assert.match(result.stderr, /not available yet/);
  assert.deepEqual(invocations(workspace), []);
});

test("the service names match the Node table", () => {
  const { SERVICE_TASKS } = require("../../scripts/platform/services.js");
  const python = spawnSync(PYTHON, ["-c",
    "import json,sys; sys.dont_write_bytecode=True; sys.path.insert(0,'scripts'); from ccdmlib.cli.services import SERVICE_TASKS as T; print(json.dumps(T))"],
  { cwd: REPO, encoding: "utf8", windowsHide: true });
  assert.equal(python.status, 0, python.stderr);
  assert.deepEqual(JSON.parse(python.stdout), { ...SERVICE_TASKS });
});

test("install-service runs the existing launchd installer unchanged", platformGate("posix", "the .sh installers run through launchctl"), async () => {
  const workspace = createRouterWorkspace();

  const result = await runScript(workspace, "scripts/ccdm", {
    args: ["install-service", "router"], env: installEnv(workspace), timeoutMs: scaledTimeout(30000),
  });

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /LaunchAgent 'com\.ccdm\.router' loaded/);
  assert.deepEqual(readState(workspace.stateDir).fixtures.launchctl.invocations.map(entry => entry.operation),
    ["list", "unload", "load", "list"]);
});

test("uninstall-service and service-status point to launchctl on POSIX", platformGate("posix", "Task Scheduler subcommands exit 2 outside Windows"), async () => {
  const workspace = createRouterWorkspace();

  for (const args of [["uninstall-service", "router"], ["service-status"]]) {
    const result = await runScript(workspace, "scripts/ccdm", { args, env: installEnv(workspace) });
    assert.equal(result.exitCode, 2, result.stderr || result.stdout);
    assert.match(result.stderr, /launchctl/);
  }
});
