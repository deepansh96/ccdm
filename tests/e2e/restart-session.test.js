import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";

import { platformGate } from "./support/platform.js";
import { createWorkspace, runScript } from "./support/runner.js";
import { startFakeHost } from "./support/session-fixture.js";
import { readState, seedRegistry } from "./support/state.js";
import { cleanup, registerTeardownCallback } from "./support/teardown.js";

const require = createRequire(import.meta.url);
const { processStartTime } = require("../../scripts/platform/process.js");

const WIN32 = process.platform === "win32";
const BACKENDS = WIN32 ? ["ccdm-host"] : ["tmux", "ccdm-host"];
const RECORD = "CCDM_E2E_RESTART_RECORD";

test.afterEach(async () => {
  await cleanup();
});

// A command that records the environment it ran in and exits as the test says.
const standIn = (name, variable) => `
import json, os, time
def _run(args):
    with open(os.environ["${RECORD}"], "a", encoding="utf-8") as out:
        out.write(json.dumps({"step": "${name}", "project": args.rest[0], "at": time.time(),
            "detached": os.environ.get("CCDM_DETACHED"), "session": os.environ.get("CCDM_SESSION_NAME"),
            "routerState": os.environ.get("CCDM_ROUTER_STATE_DIR")}) + "\\n")
    print("${name} output")
    return int(os.environ.get("${variable}") or 0)
def register(subparsers):
    parser = subparsers.add_parser("${name}", add_help=False)
    parser.add_argument("rest", nargs="*")
    parser.set_defaults(func=_run)
`;

function replaceModule(workspace, file, text) {
  const target = path.join(workspace.repoDir, "scripts", "ccdmlib", "cli", file);
  fs.rmSync(target); // A hard link to the checkout: unlink, never write through it.
  fs.writeFileSync(target, text);
}

async function restartWorld(backend, { type = "claude", screen = "demo_session", real = [] } = {}) {
  const workspace = createWorkspace();
  const fake = backend === "ccdm-host" ? await startFakeHost(workspace) : null;
  const stateRoot = fake?.stateRoot ?? path.join(workspace.tmpRoot, "ccdm-state");
  const record = path.join(workspace.tmpRoot, "steps.jsonl");
  const routerState = path.join(stateRoot, "router");
  seedRegistry(workspace, {
    projects: { demo: { type, screen_name: screen, path: workspace.repoDir, channel_id: "demo-channel", ws_port: 18542, pid: null, session_id: null } },
  });
  for (const [name, file, variable] of [
    ["stop-session", "stop_session.py", "CCDM_E2E_STOP_EXIT"],
    ["start-session", "start_session.py", "CCDM_E2E_START_EXIT"],
    ["start-codex-session", "start_codex_session.py", "CCDM_E2E_START_EXIT"],
  ]) {
    if (!real.includes(name)) replaceModule(workspace, file, standIn(name, variable));
  }
  // The thread launcher imports names from the Codex launcher, which is a stand-in here.
  fs.rmSync(path.join(workspace.repoDir, "scripts", "ccdmlib", "cli", "start_thread_session.py"));
  const baseEnv = {
    ...(fake?.env ?? { CCDM_STATE_ROOT: stateRoot, CCDM_SESSION_HOST: "tmux" }),
    CCDM_ROUTER_STATE_DIR: routerState,
    [RECORD]: record,
  };
  const run = (args, env = {}) => runScript(workspace, "scripts/ccdm", {
    args: ["restart-session", ...args], env: { ...baseEnv, ...env }, timeoutMs: 30000,
  });
  const steps = () => (fs.existsSync(record) ? fs.readFileSync(record, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : []);
  const logFile = path.join(stateRoot, "logs", "restart-demo.log");
  return { workspace, fake, run, steps, logFile, routerState };
}

function spawnSleeper(ms) {
  const child = spawn(process.execPath, ["-e", `setTimeout(() => {}, ${ms})`], { stdio: "ignore", windowsHide: true });
  const exited = new Promise(resolve => child.once("exit", () => resolve(Date.now() / 1000)));
  registerTeardownCallback(async () => {
    child.kill();
    await exited;
  });
  return { pid: child.pid, exited };
}

function assertSucceeded(result) {
  assert.equal(result.exitCode, 0, `${result.stderr}\n${result.stdout}`);
}

const stepNames = steps => steps.map(({ step }) => step);

for (const backend of BACKENDS) {
  test(`${backend}: without --after-pid, restart-session stops then starts at once and logs both`, async () => {
    const world = await restartWorld(backend);

    const result = await world.run(["demo"], { CCDM_SESSION_NAME: "someone_else" });

    assertSucceeded(result);
    assert.deepEqual(stepNames(world.steps()), ["stop-session", "start-session"]);
    assert.match(result.stdout, /Restarted 'demo'; log: /);
    const log = fs.readFileSync(world.logFile, "utf8");
    assert.match(log, /stop-session output/);
    assert.match(log, /start-session output/);
    assert.ok(log.indexOf("stop-session exited 0") < log.indexOf("running start-session"), log);
  });

  test(`${backend}: the stop is a detached copy with no session name, and the start carries neither`, async () => {
    const world = await restartWorld(backend);

    assertSucceeded(await world.run(["demo"], { CCDM_SESSION_NAME: "someone_else", CCDM_DETACHED: "1" }));

    const [stop, start] = world.steps();
    assert.equal(stop.detached, "1");
    assert.equal(stop.session, null);
    assert.equal(stop.routerState, world.routerState);
    assert.equal(start.detached, null, "a tmux server this start creates would pass CCDM_DETACHED to every later session");
    assert.equal(start.session, null);
    assert.equal(start.routerState, world.routerState);
  });

  test(`${backend}: a Codex project is started with the Codex launcher`, async () => {
    const world = await restartWorld(backend, { type: "codex" });

    assertSucceeded(await world.run(["demo"]));

    assert.deepEqual(stepNames(world.steps()), ["stop-session", "start-codex-session"]);
  });

  test(`${backend}: a failed stop starts nothing and reports the stop's exit code`, async () => {
    const world = await restartWorld(backend);

    const result = await world.run(["demo"], { CCDM_E2E_STOP_EXIT: "7" });

    assert.equal(result.exitCode, 7);
    assert.match(result.stderr, /could not stop 'demo', so it was not started again/);
    assert.deepEqual(stepNames(world.steps()), ["stop-session"]);
  });

  test(`${backend}: a failed start is reported with its exit code after the stop`, async () => {
    const world = await restartWorld(backend);

    const result = await world.run(["demo"], { CCDM_E2E_START_EXIT: "3" });

    assert.equal(result.exitCode, 3);
    assert.match(result.stderr, /'demo' was stopped but did not start again/);
    assert.deepEqual(stepNames(world.steps()), ["stop-session", "start-session"]);
  });

  test(`${backend}: with --after-pid it waits for that process to exit before stopping`, async () => {
    const world = await restartWorld(backend);
    const sleeper = spawnSleeper(1500);
    const startedAt = processStartTime(sleeper.pid);

    const result = await world.run(["demo", "--after-pid", String(sleeper.pid), ...(startedAt ? ["--after-started-at", startedAt] : [])]);

    assertSucceeded(result);
    const exitedAt = await sleeper.exited;
    const [stop] = world.steps();
    assert.ok(stop.at >= exitedAt - 0.05, `the stop ran at ${stop.at}, before the process exited at ${exitedAt}`);
    assert.match(fs.readFileSync(world.logFile, "utf8"), new RegExp(`pid ${sleeper.pid} has exited`));
  });

  test(`${backend}: --after-pid gives up at the time limit and goes on to the stop`, async () => {
    const world = await restartWorld(backend);
    const sleeper = spawnSleeper(60000);

    const result = await world.run(["demo", "--after-pid", String(sleeper.pid)], { CCDM_RESTART_AFTER_PID_TIMEOUT_S: "0.5" });

    assertSucceeded(result);
    assert.deepEqual(stepNames(world.steps()), ["stop-session", "start-session"]);
    assert.match(fs.readFileSync(world.logFile, "utf8"), new RegExp(`pid ${sleeper.pid} is still running; going on`));
  });

  test(`${backend}: restart-session refuses the root session name and a project that uses it`, async () => {
    const world = await restartWorld(backend);
    const named = await world.run(["root_agent"]);
    assert.equal(named.exitCode, 2);
    assert.match(named.stderr, /never restarts the root session/);
    assert.deepEqual(world.steps(), []);

    const aliased = await restartWorld(backend, { screen: "root_agent" });
    const refused = await aliased.run(["demo"]);
    assert.equal(refused.exitCode, 2);
    assert.match(refused.stderr, /never restarts the root session/);
    assert.deepEqual(aliased.steps(), []);
  });

  test(`${backend}: run inside its own session, restart-session hands off and the detached copy does the work`, async () => {
    const world = await restartWorld(backend);

    const result = await world.run(["demo"], { CCDM_SESSION_NAME: "demo_session" });

    assertSucceeded(result);
    assert.match(result.stdout, /restart-session continues in a detached process \(pid \d+\); log: /);
    const deadline = Date.now() + 20000;
    while (world.steps().length < 2) {
      assert.ok(Date.now() < deadline, `the detached copy did not finish: ${JSON.stringify(world.steps())}`);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const [stop, start] = world.steps();
    assert.equal(stop.step, "stop-session");
    assert.equal(stop.session, null);
    assert.equal(start.step, "start-session");
    assert.equal(start.session, null);
  });
}

test("restart-session names an unknown project and changes nothing", async () => {
  const world = await restartWorld(BACKENDS[0]);

  const result = await world.run(["nope"]);

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /could not read 'nope' from the registry/);
  assert.deepEqual(world.steps(), []);
});

test("--after-started-at without --after-pid is refused before any change", async () => {
  const world = await restartWorld(BACKENDS[0]);

  const result = await world.run(["demo", "--after-started-at", "123"]);

  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /--after-started-at needs --after-pid/);
  assert.deepEqual(world.steps(), []);
});

test("--help lists the options and changes nothing", async () => {
  const world = await restartWorld(BACKENDS[0]);

  const result = await world.run(["--help"]);

  assertSucceeded(result);
  assert.match(result.stdout, /--after-pid/);
  assert.deepEqual(world.steps(), []);
  assert.equal(fs.existsSync(world.logFile), false);
});

test("on Windows, --after-pid with another process's start time does not wait for a reused PID", platformGate("win32", "POSIX has no start time"), async () => {
  const world = await restartWorld("ccdm-host");
  const sleeper = spawnSleeper(60000);

  const result = await world.run(["demo", "--after-pid", String(sleeper.pid), "--after-started-at", "1"]);

  assertSucceeded(result);
  assert.match(fs.readFileSync(world.logFile, "utf8"), new RegExp(`pid ${sleeper.pid} has exited`));
});

// Stopped at teardown through the handle this test holds, so nothing else can be hit.
function spawnWithArgs(args) {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "--", ...args], { detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
  registerTeardownCallback(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      // It has already ended.
    }
  });
  return child.pid;
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("on Windows, a Codex restart runs the real stop: the old app-server no longer holds the port, and another port's stays", platformGate("win32", "the port sweep reads the Windows process table"), async () => {
  const world = await restartWorld("ccdm-host", { type: "codex", real: ["stop-session"] });
  const appServer = spawnWithArgs(["app-server", "--listen", "ws://127.0.0.1:18542"]);
  const otherPort = spawnWithArgs(["app-server", "--listen", "ws://127.0.0.1:18543"]);

  const result = await world.run(["demo"]);

  assertSucceeded(result);
  assert.deepEqual(stepNames(world.steps()), ["start-codex-session"]);
  assert.equal(isAlive(appServer), false, "the old app-server still runs");
  assert.equal(isAlive(otherPort), true, "another project's app-server was stopped");
  assert.equal(readState(world.workspace.stateDir).fixtures.sessionHost?.detached?.length ?? 0, 0);
});
