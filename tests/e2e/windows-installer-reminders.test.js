// The Windows Conversation Reminder service: install, the enable-state line,
// disable and enable, the preflight refusal and uninstall, through a fixture
// schtasks and the real service host. Task Scheduler is never reached: `schtasks`
// resolves to the workspace's fixture and the workspace's PATH holds nothing else.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import nodeTest from "node:test";
import path from "node:path";

import { bridgeChildEnv } from "./support/bridge.js";
import { assertPrivate, platformGate, suiteTest } from "./support/platform.js";
import { OWNER_ID, createRouterWorkspace, routerEnv, routerWithWebhooks } from "./support/router.js";
import { runScript, scaledTimeout } from "./support/runner.js";
import { readState, writeState } from "./support/state.js";
import { cleanup, registerTeardownCallback } from "./support/teardown.js";

const test = suiteTest(nodeTest, import.meta.url);
test.afterEach(async () => cleanup());

const TASK = "\\CCDM\\Reminders";
const onlyWindows = platformGate("win32", "Task Scheduler exists only on Windows");
// What a test carries past the service host's clean environment: fixture state only.
const TEST_PASS = "CCDM_TEST_STATE,CCDM_TEST_ACCELERATE_TYPING";
const ALWAYS_SET = ["CCDM_PYTHON", "CCDM_REMINDER_NODE", "CCDM_ROUTER_STATE_DIR", "CCDM_STATE_ROOT", "PATH", "PYTHONUTF8",
  "ROOT_DISCORD_STATE_DIR"];

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
const stateRoot = workspace => path.join(workspace.homeDir, ".local", "state", "ccdm");
const reminderStateDir = workspace => path.join(stateRoot(workspace), "conversation-reminders");
const rootStateDir = workspace => path.join(workspace.homeDir, ".claude", "channels", "discord");
const serviceFile = (workspace, suffix) => path.join(stateRoot(workspace), "services", `reminders${suffix}`);
const schtasks = workspace => readState(workspace.stateDir).fixtures.schtasks;
const verbs = workspace => schtasks(workspace).invocations.map(entry => entry.verb);
const runs = workspace => verbs(workspace).filter(verb => verb === "/run").length;
// The worker's `status` asks the fixture whether the supervisor's task exists; nothing else may reach it.
const changes = workspace => verbs(workspace).filter(verb => verb !== "/query");
const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};
const serviceState = workspace => readJson(serviceFile(workspace, ".state.json"));

// Each worker start writes a fresh observer key before it connects to the Router.
const observerKey = (workspace) => {
  const file = path.join(workspace.routerStateDir, "keys", ".observer.key");
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
};

// Two router Codex projects, as in the reminder suites; the Router is root's only login.
function reminderWorkspace() {
  const workspace = createRouterWorkspace({
    discord_user_id: OWNER_ID,
    guild_id: "guild-id",
    projects: {
      demo: { channel_id: "demo-channel", type: "codex", screen_name: "demo_codex", assignment_generation: "gen-demo" },
      beta: { channel_id: "beta-channel", type: "codex", screen_name: "beta_codex", assignment_generation: "gen-beta" },
    },
  });
  fs.mkdirSync(path.join(workspace.homeDir, ".codex"), { recursive: true });
  return workspace;
}

const installEnv = (workspace, extra = {}) => routerEnv(workspace, {
  CCDM_REMINDER_NODE: process.execPath, CCDM_SERVICE_HOST_TEST_PASS: TEST_PASS, ...extra,
});
// Python directly on Windows, as the other installer tests do.
const ccdm = (workspace, args, env = {}) => runScript(workspace, "scripts/ccdm.py", {
  args, env: installEnv(workspace, env), timeoutMs: scaledTimeout(180000),
});
async function service(workspace, verb, expected = 0) {
  const result = await runScript(workspace, "scripts/conversation-reminder-service.py", {
    args: [verb, "--project-root", workspace.repoDir, "--state-dir", reminderStateDir(workspace)],
    env: installEnv(workspace), timeoutMs: scaledTimeout(120000),
  });
  assert.equal(result.exitCode, expected, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

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

async function install(workspace) {
  const runsBefore = runs(workspace);
  const installing = ccdm(workspace, ["install-service", "reminders"]);
  // Stands in for Task Scheduler answering /run, and marks the task Running.
  await waitFor("schtasks /run", () => runs(workspace) > runsBefore);
  const serviceHost = startTaskAction(workspace);
  const state = readState(workspace.stateDir);
  state.fixtures.schtasks.running[TASK] = serviceHost.pid;
  writeState(state, workspace.stateDir);
  const result = await installing;
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Task \\CCDM\\Reminders installed and running/);
  return { result, serviceHost };
}

test("install-service reminders runs the worker under a logon task and says whether delivery is on; disable stops it for good, enable and a reinstall bring it back, and uninstall removes it", onlyWindows, async () => {
  const workspace = reminderWorkspace();
  await routerWithWebhooks(workspace, ["demo", "beta"]);
  assert.deepEqual(schtasks(workspace).tasks, [], "nothing installs reminders until the operator asks");

  const { result, serviceHost } = await install(workspace);
  assert.match(result.stdout, /^Delivery stays off until scripts\/ccdm reminders enable; the worker observes but sends nothing\.$/m);
  for (const text of [result.stdout, result.stderr]) assert.doesNotMatch(text, /DISCORD_BOT_TOKEN|fixture-root-token/);

  assert.deepEqual(schtasks(workspace).tasks, [TASK]);
  const xml = schtasks(workspace).definitions[TASK];
  assert.match(xml, /<URI>\\CCDM\\Reminders<\/URI>/);
  assert.match(xml, /<LogonTrigger>\s*<Enabled>true<\/Enabled>/);
  assert.match(xml, /<Interval>PT5M<\/Interval>/);
  assert.match(xml, /<LogonType>InteractiveToken<\/LogonType>/);
  assert.match(xml, /<ExecutionTimeLimit>PT0S<\/ExecutionTimeLimit>/);
  assert.match(xml, /<Arguments>--headless "[^"]*node[^"]*" "[^"]*service-host\.js" --config "[^"]*reminders\.json"<\/Arguments>/);

  // What the service host runs: the foreground worker, as the macOS plist does.
  const config = readJson(serviceFile(workspace, ".json"));
  const [python, script, ...args] = config.command;
  assert.ok(path.win32.isAbsolute(python), python);
  assert.doesNotMatch(python, /\\WindowsApps\\/i);
  // Python reports the long form of a temp folder that the runner names in its 8.3 form.
  assert.equal(real(script), real(path.join(workspace.repoDir, "scripts", "conversation-reminder-service.py")));
  assert.deepEqual([args[0], args[1], args[3]], ["run", "--project-root", "--state-dir"]);
  assert.equal(args.length, 5);
  assert.equal(real(args[2]), real(workspace.repoDir));
  assert.equal(real(args[4]), real(reminderStateDir(workspace)));

  // Exactly the names the worker and its observer read; no token, only where its file is.
  assert.deepEqual(Object.keys(config.env).sort(), ALWAYS_SET);
  assert.equal(config.env.CCDM_PYTHON, python);
  assert.equal(config.env.CCDM_REMINDER_NODE, process.execPath);
  assert.equal(real(config.env.CCDM_ROUTER_STATE_DIR), real(workspace.routerStateDir));
  assert.equal(real(config.env.CCDM_STATE_ROOT), real(stateRoot(workspace)));
  assert.equal(real(config.env.ROOT_DISCORD_STATE_DIR), real(rootStateDir(workspace)));
  assert.equal(config.env.PYTHONUTF8, "1");
  for (const text of [xml, JSON.stringify(config)]) assert.doesNotMatch(text, /DISCORD_BOT_TOKEN|fixture-root-token/);
  assertPrivate(path.join(stateRoot(workspace), "services"));
  assertPrivate(reminderStateDir(workspace));

  // The worker itself: its observer started, `status` reports it, and a second worker is refused.
  await waitFor("the worker's observer start", () => observerKey(workspace) !== null);
  const firstKey = observerKey(workspace);
  assert.equal((await service(workspace, "status")).worker_running, true);
  assert.equal(serviceState(workspace).state, "running");
  assert.match((await service(workspace, "run", 2)).reason, /already running/);

  // disable: the worker exits 0, so the service host stays stopped and a watchdog start does nothing.
  await service(workspace, "disable");
  assert.equal(await serviceHost.exitedWith, 0);
  assert.equal(serviceState(workspace).state, "disabled");
  assert.equal(serviceState(workspace).last_exit_code, 0);
  assert.equal(await startTaskAction(workspace).exitedWith, 0, "a watchdog start exits at once");
  assert.equal(observerKey(workspace), firstKey, "no worker started");

  // An install while disabled registers the task and starts nothing.
  const runsBefore = runs(workspace);
  const whileDisabled = await ccdm(workspace, ["install-service", "reminders"]);
  assert.equal(whileDisabled.exitCode, 0, whileDisabled.stderr || whileDisabled.stdout);
  assert.match(whileDisabled.stdout, /^Reminders are disabled: .*scripts\/ccdm reminders enable and then this command again\.$/m);
  assert.equal(runs(workspace), runsBefore);
  assert.equal(observerKey(workspace), firstKey);

  // enable, then install-service: it runs again, and the line says delivery is on.
  await service(workspace, "enable");
  const again = await install(workspace);
  assert.match(again.result.stdout, /^Reminders are enabled; run scripts\/ccdm reminders status for per-channel readiness\.$/m);
  await waitFor("the worker's next observer start", () => observerKey(workspace) !== firstKey);
  assert.equal(fs.existsSync(serviceFile(workspace, ".disabled")), false);

  const removed = await ccdm(workspace, ["uninstall-service", "reminders"]);
  assert.equal(removed.exitCode, 0, removed.stderr || removed.stdout);
  assert.match(removed.stdout, /Task \\CCDM\\Reminders removed/);
  assert.equal(await again.serviceHost.exitedWith, 0);
  assert.equal(schtasks(workspace).tasks.includes(TASK), false);
  assert.equal(verbs(workspace).includes("/end"), false, "schtasks /end is not a stop");
  assert.equal((await service(workspace, "status")).worker_running, false);
});

test("with the Router unreachable and root's credentials missing the installer prints each blocker, exits 2 and never calls schtasks", onlyWindows, async () => {
  const workspace = reminderWorkspace();
  const empty = path.join(workspace.tmpRoot, "p5.3-no-credentials");
  fs.mkdirSync(empty, { recursive: true });

  const result = await ccdm(workspace, ["install-service", "reminders"], { ROOT_DISCORD_STATE_DIR: empty });

  assert.equal(result.exitCode, 2, result.stderr || result.stdout);
  assert.match(result.stderr, /Conversation Reminder preflight failed; the existing task was left unchanged/);
  assert.match(result.stderr, /^ {2}- .*root Discord credentials are unavailable/m);
  assert.match(result.stderr, /^ {2}- .*Router/m);
  // The printed fix is a command Windows has: no .sh installer, and Node scripts through node.
  assert.match(result.stderr,
    /the Router is not reachable; start the Router \(scripts\/ccdm install-service router, or node scripts\/router\.js serve\)/);
  assert.doesNotMatch(result.stderr, /install-[a-z-]+\.sh|LaunchAgent/);
  assert.deepEqual(changes(workspace), []);
  assert.equal(fs.existsSync(serviceFile(workspace, ".json")), false);
  assert.equal(fs.existsSync(reminderStateDir(workspace)), false, "the preflight created nothing");

  const relative = await ccdm(workspace, ["install-service", "reminders"], { CCDM_REMINDER_STATE_DIR: "relative/dir" });
  assert.equal(relative.exitCode, 2, relative.stderr || relative.stdout);
  assert.match(relative.stderr, /CCDM_REMINDER_STATE_DIR must be an absolute path/);
  const oldNode = await ccdm(workspace, ["install-service", "reminders"], { CCDM_REMINDER_NODE: "node" });
  assert.equal(oldNode.exitCode, 1, oldNode.stderr || oldNode.stdout);
  assert.match(oldNode.stderr, /node 22 or newer is required; set CCDM_REMINDER_NODE to its absolute path/);
  assert.deepEqual(changes(workspace), []);
});
