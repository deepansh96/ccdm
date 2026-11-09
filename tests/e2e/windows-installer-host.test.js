// The Windows session-host service: install, refusal while sessions are live,
// --force and uninstall, through a fixture schtasks and the real service host.
// Task Scheduler is never reached: `schtasks` resolves to the workspace's fixture
// and the workspace's PATH holds nothing else. The host's keep-awake runs on the
// fake power seam, so no test reaches the Windows power calls.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import nodeTest from "node:test";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PYTHON, assertPrivate, platformGate, suiteTest } from "./support/platform.js";
import { createWorkspace, runNodeEntrypoint, runScript, scaledTimeout } from "./support/runner.js";
import { readState, seedRegistry, writeState } from "./support/state.js";
import { cleanup, registerTeardownCallback } from "./support/teardown.js";

const test = suiteTest(nodeTest, import.meta.url);
test.afterEach(async () => cleanup());

const require = createRequire(import.meta.url);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const TASK = "\\CCDM\\Host";
const SESSION_ID = "11111111-2222-4333-8444-555555555555";
const onlyWindows = platformGate("win32", "Task Scheduler and ccdm-host exist only on Windows");
// What a test carries past the service host's clean environment: fixture state and the fake power seam.
const TEST_PASS = "CCDM_TEST_STATE,CCDM_HOST_POWER_FAKE,CCDM_HOST_POWER_POLL_MS";

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(what, predicate, timeoutMs = scaledTimeout(20000)) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await pause(50);
  }
}

function hostWorkspace() {
  const workspace = createWorkspace();
  seedRegistry(workspace, {
    projects: {
      alpha: { channel_id: "alpha-channel", type: "claude", screen_name: "alpha_session", session_id: SESSION_ID },
    },
  });
  const stateRoot = path.join(workspace.tmpRoot, "ccdm-state");
  const powerDir = path.join(workspace.tmpRoot, "p5.2-power");
  const fixtures = path.join(workspace.tmpRoot, "p5.2-fixtures");
  fs.mkdirSync(fixtures, { recursive: true });
  const env = {
    CCDM_STATE_ROOT: stateRoot,
    CCDM_ROUTER_NODE: process.execPath,
    CCDM_HOST_POWER_FAKE: powerDir,
    CCDM_HOST_POWER_POLL_MS: "50",
    CCDM_SERVICE_HOST_TEST_PASS: TEST_PASS,
  };
  const extended = { ...workspace, stateRoot, powerDir, fixtures, hostEnv: env };
  // Whatever host is still up when the test ends is asked to stop, which ends its sessions.
  registerTeardownCallback(async () => {
    await hostCli(extended, ["shutdown"]);
  });
  return extended;
}

const serviceFile = (workspace, suffix) => path.join(workspace.stateRoot, "services", `host${suffix}`);
const invocations = workspace => readState(workspace.stateDir).fixtures.schtasks.invocations;
const verbs = workspace => invocations(workspace).map(entry => entry.verb);
const runs = workspace => verbs(workspace).filter(verb => verb === "/run").length;
const definition = workspace => readState(workspace.stateDir).fixtures.schtasks.definitions[TASK];
const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};
const serviceState = workspace => readJson(serviceFile(workspace, ".state.json"));
const heldRequests = workspace => readJson(path.join(workspace.powerDir, "requests.json"))?.held;

// Python directly on Windows, as the other installer tests do.
const ccdm = (workspace, args, env = {}) => runScript(workspace, "scripts/ccdm.py", {
  args, env: { ...workspace.hostEnv, ...env }, timeoutMs: scaledTimeout(90000),
});
const hostCli = (workspace, args) => runNodeEntrypoint(workspace, "scripts/ccdm-host.js", {
  args, env: workspace.hostEnv, timeoutMs: scaledTimeout(60000),
});
const hostAnswers = async workspace => (await hostCli(workspace, ["list-sessions"])).exitCode === 0;

// Stands in for Task Scheduler answering /run: starts the program the XML names,
// without its conhost, on a hidden console of its own, and marks the task Running.
// The state root is absent from its environment, as it is in a real task.
async function actAsScheduler(workspace, runsBefore = 0) {
  await waitFor("schtasks /run", () => runs(workspace) > runsBefore);
  const xml = definition(workspace);
  assert.match(/<Command>([^<]*)<\/Command>/.exec(xml)[1], /conhost\.exe$/);
  const args = [...(/<Arguments>([^<]*)<\/Arguments>/.exec(xml)[1]).matchAll(/&quot;([^&]*)&quot;|"([^"]*)"|(\S+)/g)].map(m => m[1] ?? m[2] ?? m[3]);
  assert.equal(args[0], "--headless");
  const cwd = /<WorkingDirectory>([^<]*)<\/WorkingDirectory>/.exec(xml)[1];
  const env = { ...workspace.env, ...workspace.hostEnv };
  delete env.CCDM_STATE_ROOT;
  const child = spawn(args[1], args.slice(2), { cwd, env, stdio: "ignore", windowsHide: true });
  registerTeardownCallback(() => child.kill());
  child.exitedWith = new Promise(resolve => child.once("close", resolve));
  const state = readState(workspace.stateDir);
  state.fixtures.schtasks.running[TASK] = child.pid;
  writeState(state, workspace.stateDir);
  return child;
}

async function install(workspace, options = []) {
  const runsBefore = runs(workspace);
  const installing = ccdm(workspace, ["install-service", "host", ...options]);
  const serviceHost = await actAsScheduler(workspace, runsBefore);
  const result = await installing;
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Task \\CCDM\\Host installed and running/);
  await waitFor("the installed ccdm-host to answer", () => hostAnswers(workspace));
  return { result, serviceHost };
}

// A ccdm-host started from a shell, outside any service: it holds no power request.
async function startHostByHand(workspace) {
  const child = spawn(process.execPath, [path.join(workspace.repoDir, "scripts", "ccdm-host.js"), "serve", "--allow-in-job"], {
    cwd: workspace.repoDir, env: { ...workspace.env, ...workspace.hostEnv }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  registerTeardownCallback(() => child.kill());
  let output = "";
  for (const stream of [child.stdout, child.stderr]) stream.setEncoding("utf8").on("data", chunk => { output += chunk; });
  child.exitedWith = new Promise(resolve => child.once("close", resolve));
  await waitFor(`the hand-started host: ${output}`, () => /ready/.test(output) || child.exitCode !== null);
  assert.match(output, /ready/);
  return child;
}

// Echoes stdin and exits when it closes, which is how the host asks a session to stop.
async function startSession(workspace, name, kind) {
  const script = path.join(workspace.fixtures, "session.js");
  fs.writeFileSync(script, 'console.log("up"); process.stdin.on("data", () => {}); process.stdin.on("end", () => process.exit(0));\n');
  const started = await hostCli(workspace, ["new-session", "-d", "-s", name, "-c", workspace.fixtures, "--kind", kind, "--no-pty", "--", process.execPath, script]);
  assert.equal(started.exitCode, 0, started.stderr);
  const listed = await hostCli(workspace, ["list-sessions", "-F", "#{session_name} #{pane_pid}"]);
  const pid = Number(new RegExp(`^${name} (\\d+)$`, "m").exec(listed.stdout)[1]);
  const { processAlive, processStartTime } = require("../../scripts/platform/process.js");
  const startedAt = processStartTime(pid);
  return { name, alive: () => processAlive(pid, startedAt) };
}

test("install-service host registers a logon task, ccdm-host runs under it with keep-awake on, and service-status shows it; uninstall ends it and its sessions", onlyWindows, async () => {
  const workspace = hostWorkspace();
  const { serviceHost } = await install(workspace);

  const xml = definition(workspace);
  assert.ok(xml, "the task was created under \\CCDM\\");
  assert.match(xml, /<URI>\\CCDM\\Host<\/URI>/);
  const user = /<Principal id="Author">\s*<UserId>([^<]+)<\/UserId>/.exec(xml)[1];
  assert.match(user, new RegExp(`\\\\${os.userInfo().username}$`, "i"));
  assert.match(xml, new RegExp(`<LogonTrigger>\\s*<Enabled>true</Enabled>\\s*<UserId>${user.replaceAll("\\", "\\\\")}</UserId>`));
  assert.match(xml, /<Interval>PT5M<\/Interval>/);
  assert.match(xml, /<LogonType>InteractiveToken<\/LogonType>/);
  assert.match(xml, /<ExecutionTimeLimit>PT0S<\/ExecutionTimeLimit>/);
  assert.match(xml, /<StopIfGoingOnBatteries>false<\/StopIfGoingOnBatteries>/);
  assert.match(xml, /<Command>[^<]*conhost\.exe<\/Command>/);
  assert.match(xml, /<Arguments>--headless "[^"]*node[^"]*" "[^"]*service-host\.js" --config "[^"]*host\.json"<\/Arguments>/);

  // What the service host runs: the daemon, allowed inside the task's Job, with
  // the state root and keep-awake passed on explicitly.
  const config = readJson(serviceFile(workspace, ".json"));
  assert.deepEqual(config.command.slice(1), [path.join(workspace.repoDir, "scripts", "ccdm-host.js"), "serve", "--allow-in-job"]);
  assert.deepEqual(Object.keys(config.env).sort(), ["CCDM_HOST_KEEP_AWAKE", "CCDM_STATE_ROOT", "PATH"]);
  assert.equal(config.env.CCDM_HOST_KEEP_AWAKE, "1");
  assert.equal(fs.realpathSync.native(config.env.CCDM_STATE_ROOT), fs.realpathSync.native(workspace.stateRoot));
  assertPrivate(path.join(workspace.stateRoot, "services"));
  assertPrivate(path.join(workspace.stateRoot, "host"));

  assert.equal(serviceState(workspace).state, "running");
  const status = await ccdm(workspace, ["service-status"]);
  assert.equal(status.exitCode, 0, status.stderr);
  assert.match(status.stdout, /^host: running \(task \\CCDM\\Host/m);

  // The installed host holds the power request for a project session.
  assert.deepEqual(heldRequests(workspace), []);
  const session = await startSession(workspace, "alpha_session", "project");
  await waitFor("the power request", () => JSON.stringify(heldRequests(workspace)) === '["CCDM: 1 sessions"]');

  const removed = await ccdm(workspace, ["uninstall-service", "host"]);
  assert.equal(removed.exitCode, 0, removed.stderr || removed.stdout);
  assert.match(removed.stdout, /Ending 1 live session with the host/);
  assert.match(removed.stdout, new RegExp(`  - alpha_session \\(project, project alpha, id ${SESSION_ID}\\)`));
  assert.equal(await serviceHost.exitedWith, 0);
  assert.equal(serviceState(workspace).last_exit_code, 0, "ccdm-host exited 0 on the stop");
  assert.equal(session.alive(), false, "the session ended with the host");
  assert.deepEqual(heldRequests(workspace), [], "the power request was released");
  assert.equal(await hostAnswers(workspace), false);
  assert.equal(readState(workspace.stateDir).fixtures.schtasks.tasks.includes(TASK), false);
  assert.equal(verbs(workspace).includes("/end"), false, "schtasks /end is not a stop");
  assert.doesNotMatch((await ccdm(workspace, ["service-status"])).stdout, /running/);
});

test("with live sessions install-service host exits 1, names each one, prints the upgrade procedure and changes nothing; --force goes ahead", onlyWindows, async () => {
  const workspace = hostWorkspace();
  const { serviceHost } = await install(workspace);
  const project = await startSession(workspace, "alpha_session", "project");
  const root = await startSession(workspace, "root_agent", "root");
  const before = invocations(workspace).length;
  const configBefore = fs.readFileSync(serviceFile(workspace, ".json"), "utf8");

  const refused = await ccdm(workspace, ["install-service", "host"]);

  assert.equal(refused.exitCode, 1, refused.stderr || refused.stdout);
  assert.match(refused.stderr, /ccdm-host has 2 live sessions/);
  assert.match(refused.stderr, new RegExp(`^  - alpha_session \\(project, project alpha, id ${SESSION_ID}\\)$`, "m"));
  assert.match(refused.stderr, /^  - root_agent \(root\)$/m);
  for (const step of [/scripts\/ccdm status/, /scripts\/ccdm stop-session <project>/, /scripts\/ccdm install-service host$/m,
    /scripts\/ccdm start-session <project> --resume <id>/, /install-service host --force/]) {
    assert.match(refused.stderr, step);
  }
  assert.equal(invocations(workspace).length, before, "schtasks was not called");
  assert.equal(fs.readFileSync(serviceFile(workspace, ".json"), "utf8"), configBefore);
  assert.ok(project.alive() && root.alive(), "the sessions were left running");
  assert.equal(serviceHost.exitCode, null, "the service host was left running");

  // From inside a session the command would be ended by its own stop of the host.
  for (const args of [["install-service", "host", "--force"], ["uninstall-service", "host"]]) {
    const inside = await ccdm(workspace, args, { CCDM_SESSION_NAME: "root_agent" });
    assert.equal(inside.exitCode, 1, `${args.join(" ")}: ${inside.stderr || inside.stdout}`);
    assert.match(inside.stderr, /cannot run inside a CCDM session \(root_agent\)/);
  }
  assert.equal(invocations(workspace).length, before);
  assert.equal(fs.existsSync(serviceFile(workspace, ".stop")), false);
  assert.ok(project.alive() && root.alive());

  const { result } = await install(workspace, ["--force"]);

  assert.match(result.stdout, /--force: ending 2 live sessions/);
  assert.match(result.stdout, /  - root_agent \(root\)/);
  assert.equal(await serviceHost.exitedWith, 0, "the old service host stopped through its stop file");
  assert.ok(!project.alive() && !root.alive(), "the old host's sessions ended");
  assert.equal((await hostCli(workspace, ["list-sessions"])).stdout, "");
  assert.equal(verbs(workspace).includes("/end"), false);
});

test("a ccdm-host started by hand is refused the same way while it has sessions, and is shut down by an install that goes ahead", onlyWindows, async () => {
  const workspace = hostWorkspace();
  const byHand = await startHostByHand(workspace);
  const thread = await startSession(workspace, "alpha_session-t-1500000000000000001", "thread");

  const refused = await ccdm(workspace, ["install-service", "host"]);

  assert.equal(refused.exitCode, 1, refused.stderr || refused.stdout);
  assert.match(refused.stderr, /ccdm-host has 1 live session,/);
  assert.match(refused.stderr, /^  - alpha_session-t-1500000000000000001 \(thread\)$/m);
  assert.deepEqual(invocations(workspace), []);
  assert.equal(fs.existsSync(serviceFile(workspace, ".json")), false);
  assert.ok(thread.alive());
  assert.equal(byHand.exitCode, null);

  const { result } = await install(workspace, ["--force"]);

  assert.match(result.stdout, /Stopping the ccdm-host that was started outside the service/);
  assert.equal(await byHand.exitedWith, 0);
  assert.equal(thread.alive(), false);
  assert.equal(serviceState(workspace).state, "running", "the task's own host took the lock");
  assert.equal((await hostCli(workspace, ["list-sessions"])).stdout, "");
});

test("a ccdm-host started by hand with no sessions is shut down without --force", onlyWindows, async () => {
  const workspace = hostWorkspace();
  const byHand = await startHostByHand(workspace);

  const { result } = await install(workspace);

  assert.match(result.stdout, /Stopping the ccdm-host that was started outside the service/);
  assert.equal(await byHand.exitedWith, 0);
  assert.equal(serviceState(workspace).state, "running");
});

test("any option but --force exits 2 before any schtasks call", onlyWindows, async () => {
  const workspace = hostWorkspace();

  const result = await ccdm(workspace, ["install-service", "host", "--interval", "600"]);

  assert.equal(result.exitCode, 2, result.stderr || result.stdout);
  assert.match(result.stderr, /takes only --force/);
  assert.deepEqual(invocations(workspace), []);
});

test("without koffi the install exits 2 naming it, before any schtasks call", onlyWindows, async () => {
  const workspace = hostWorkspace();

  // The workspace's checkout has no node_modules of its own.
  const result = await ccdm(workspace, ["install-service", "host"], { NODE_PATH: "" });

  assert.equal(result.exitCode, 2, result.stderr || result.stdout);
  assert.match(result.stderr, /preflight failed/);
  assert.match(result.stderr, /  - ccdm-host needs the optional native package koffi/);
  assert.deepEqual(invocations(workspace), []);
});

test("the host's command passes --allow-in-job exactly when the recorded Task Scheduler result says tasks run in a Job", () => {
  const program = [
    "import json, sys",
    "sys.dont_write_bytecode = True",
    "sys.path.insert(0, 'scripts')",
    "from ccdmlib.cli.services import host",
    "recorded = host.TASKS_RUN_IN_A_JOB",
    "commands = {}",
    "for value in (True, False):",
    "    host.TASKS_RUN_IN_A_JOB = value",
    "    commands[str(value)] = host.serve_command('node')[2:]",
    "print(json.dumps({'recorded': recorded, 'commands': commands}))",
  ].join("\n");
  const python = spawnSync(PYTHON, ["-c", program], { cwd: REPO, encoding: "utf8", windowsHide: true });
  assert.equal(python.status, 0, python.stderr);
  const { recorded, commands } = JSON.parse(python.stdout);
  assert.deepEqual(commands, { True: ["serve", "--allow-in-job"], False: ["serve"] });
  // The spike found a task's processes already inside a Job.
  assert.equal(recorded, true);
});
