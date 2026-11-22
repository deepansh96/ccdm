// The `ccdm` dispatcher: its entries in each shell, module discovery, shims and the self-detach rule.
import assert from "node:assert/strict";
import { execFile, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { gitBashTool, platformGate } from "./support/platform.js";
import { createWorkspace, runScript, scaledTimeout } from "./support/runner.js";
import { hostOps, startFakeHost } from "./support/session-fixture.js";
import { seedTmuxSession, updateState } from "./support/state.js";
import { cleanup } from "./support/teardown.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const WIN = process.platform === "win32";
const onlyWindows = platformGate("win32", "PowerShell, cmd and Git Bash exist together only on Windows");
const TARGET = "alpha_agent";
const FOREGROUND_EXIT = 7;

test.afterEach(cleanup);

const FIXTURE_MODULE = `
import json
import os
import sys
import time

from ccdmlib.cli._detach import detach_if_self


def report(rest):
    print(json.dumps({
        "argv": rest,
        "detached": os.environ.get("CCDM_DETACHED"),
        "pathconv": os.environ.get("MSYS_NO_PATHCONV"),
        "pid": os.getpid(),
        "session": os.environ.get("CCDM_SESSION_NAME"),
        "utf8": sys.flags.utf8_mode,
    }))


def echo(args):
    report(args.rest)
    return args.exit


def lifecycle(args):
    if args.pid_file:
        with open(args.pid_file + ".tmp", "w") as stream:
            stream.write(str(os.getpid()))
        os.replace(args.pid_file + ".tmp", args.pid_file)
        while not os.path.exists(args.go_file):
            time.sleep(0.02)
    detach_if_self(args.target)
    report([args.target])
    return ${FOREGROUND_EXIT}


def register(subparsers):
    parser = subparsers.add_parser("fixture-echo", help="prints what it received")
    parser.add_argument("--exit", type=int, default=0)
    parser.add_argument("rest", nargs="*")
    parser.set_defaults(func=echo)
    parser = subparsers.add_parser("fixture-lifecycle", help="a lifecycle command")
    parser.add_argument("target")
    parser.add_argument("--pid-file")
    parser.add_argument("--go-file")
    parser.set_defaults(func=lifecycle)
`;

function fixtureWorkspace() {
  const workspace = createWorkspace();
  const modules = path.join(workspace.tmpRoot, "cli-modules");
  fs.mkdirSync(modules);
  fs.writeFileSync(path.join(modules, "fixture_commands.py"), FIXTURE_MODULE);
  return { workspace, moduleEnv: { CCDM_CLI_TEST_MODULES: modules } };
}

const ccdm = (workspace, args, env, options = {}) => runScript(workspace, "scripts/ccdm", {
  args, env, timeoutMs: 20000, ...options,
});

function assertRan(result) {
  assert.equal(result.exitCode, 0, `${result.stderr}\n${result.stdout}`);
}

const reportOf = result => JSON.parse(result.stdout.trim().split("\n").at(-1));
const exists = file => fs.existsSync(file);

function run(command, args, options) {
  return new Promise((resolve) => {
    execFile(command, args, { encoding: "utf8", windowsHide: true, timeout: scaledTimeout(30000), ...options }, (error, stdout, stderr) => {
      resolve({ exitCode: error ? error.code : 0, stdout, stderr });
    });
  });
}

async function until(predicate, what, timeoutMs = 15000) {
  const deadline = Date.now() + scaledTimeout(timeoutMs);
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

// ---- the entries in each shell ----

// A Test Workspace's PATHEXT leaves out .CMD; a real one has it, and both shells use it to find ccdm.cmd.
const windowsShellEnv = (workspace, moduleEnv) => ({ ...workspace.env, ...moduleEnv, PATHEXT: ".COM;.EXE;.BAT;.CMD" });

function cmdLine(workspace, env, line) {
  return run(process.env.ComSpec, ["/d", "/s", "/c", `"${line}"`], { cwd: workspace.repoDir, env, windowsVerbatimArguments: true });
}

// PowerShell 7 where installed, and the 5.1 that ships with Windows.
function powerShells() {
  const where = path.join(process.env.SystemRoot, "System32", "where.exe");
  const found = spawnSync(where, ["pwsh.exe"], { encoding: "utf8", windowsHide: true });
  const seven = found.status === 0 ? found.stdout.split(/\r?\n/).filter(Boolean).slice(0, 1) : [];
  return [...seven, path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")];
}

function powerShellLine(shell, workspace, env, line) {
  return run(shell, ["-NoProfile", "-NonInteractive", "-Command", line], { cwd: workspace.repoDir, env });
}

test("--help lists a registered subcommand through the sh entry", async () => {
  const { workspace, moduleEnv } = fixtureWorkspace();
  const result = await ccdm(workspace, ["--help"], moduleEnv);
  assertRan(result);
  assert.match(result.stdout, /fixture-echo\s+prints what it received/);
});

test("--help lists a registered subcommand in Git Bash, PowerShell and cmd", onlyWindows, async () => {
  const { workspace, moduleEnv } = fixtureWorkspace();
  const env = windowsShellEnv(workspace, moduleEnv);
  const fromBash = await run(gitBashTool("bash"), ["-c", "scripts/ccdm --help"], { cwd: workspace.repoDir, env });
  assert.match(fromBash.stdout, /fixture-echo/, fromBash.stderr);
  for (const shell of powerShells()) {
    const fromPowerShell = await powerShellLine(shell, workspace, env, "scripts\\ccdm --help");
    assert.match(fromPowerShell.stdout, /fixture-echo/, `${path.basename(shell)}: ${fromPowerShell.stderr}`);
  }
  const fromCmd = await cmdLine(workspace, env, "scripts\\ccdm --help");
  assert.match(fromCmd.stdout, /fixture-echo/, fromCmd.stderr);
});

test("--help lists a registered subcommand in zsh", platformGate("posix", "zsh is the owner's shell on macOS"), async (t) => {
  if (!exists("/bin/zsh")) return t.skip("this machine has no /bin/zsh");
  const { workspace, moduleEnv } = fixtureWorkspace();
  const result = await run("/bin/zsh", ["-f", "-c", "scripts/ccdm --help"], { cwd: workspace.repoDir, env: { ...workspace.env, ...moduleEnv } });
  assert.match(result.stdout, /fixture-echo/, result.stderr);
});

test("the sh entry sets UTF-8 mode and turns off Git Bash path conversion itself", async () => {
  const { workspace, moduleEnv } = fixtureWorkspace();
  const result = await ccdm(workspace, ["fixture-echo", "/compact", "/compact focus on x", "/c/x", "--", "--flag=/"], moduleEnv);
  assertRan(result);
  const report = reportOf(result);
  assert.deepEqual(report.argv, ["/compact", "/compact focus on x", "/c/x", "--flag=/"]);
  assert.equal(report.pathconv, "1");
  assert.equal(report.utf8, 1);
});

test("the sh entry passes the exit code through", async () => {
  const { workspace, moduleEnv } = fixtureWorkspace();
  assert.equal((await ccdm(workspace, ["fixture-echo", "--exit", "9"], moduleEnv)).exitCode, 9);
});

test("ccdm.cmd passes arguments and the exit code through, and leaks no variable to cmd", onlyWindows, async () => {
  const { workspace, moduleEnv } = fixtureWorkspace();
  const env = windowsShellEnv(workspace, moduleEnv);
  const result = await cmdLine(workspace, env, "scripts\\ccdm fixture-echo --exit 5 \"two words\" /compact");
  assert.equal(result.exitCode, 5, result.stderr);
  const report = reportOf(result);
  assert.deepEqual(report.argv, ["two words", "/compact"]);
  assert.equal(report.utf8, 1);
  const leak = await run(process.env.ComSpec, ["/d", "/v:on", "/s", "/c", "\"scripts\\ccdm --help >nul & echo leak=[!PYTHONUTF8!][!_PY!]\""], {
    cwd: workspace.repoDir, env, windowsVerbatimArguments: true,
  });
  assert.match(leak.stdout, /leak=\[(!PYTHONUTF8!)?\]\[(!_PY!)?\]/, leak.stderr);
});

test("with no subcommand ccdm prints its help and exits 2", async () => {
  const { workspace, moduleEnv } = fixtureWorkspace();
  const result = await ccdm(workspace, [], moduleEnv);
  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /fixture-echo/);
});

// ---- finding Python ----

test("a CCDM_PYTHON is used as given: one that is missing fails rather than falls back", async () => {
  const { workspace, moduleEnv } = fixtureWorkspace();
  const missing = path.join(workspace.tmpRoot, "no-such-python");
  const result = await ccdm(workspace, ["--help"], { ...moduleEnv, CCDM_PYTHON: missing });
  assert.notEqual(result.exitCode, 0);
  assert.doesNotMatch(result.stdout, /fixture-echo/);
});

test("with no Python on PATH the entry says so", async () => {
  const workspace = createWorkspace({ excludeFixtures: ["python", "python3"] });
  const result = await ccdm(workspace, ["--help"]);
  assert.equal(result.exitCode, 127, result.stderr);
  assert.match(result.stderr, /No usable Python was found/);
});

test("both Windows entries ignore a .cmd and the Store stub as CCDM_PYTHON, and go on to PATH", onlyWindows, async () => {
  const { workspace, moduleEnv } = fixtureWorkspace();
  const env = windowsShellEnv(workspace, moduleEnv);
  for (const bad of [path.join(workspace.tmpRoot, "python.cmd"), path.join(workspace.tmpRoot, "WindowsApps", "python.exe")]) {
    const fromSh = await ccdm(workspace, ["--help"], { ...moduleEnv, CCDM_PYTHON: bad });
    assertRan(fromSh);
    assert.match(fromSh.stderr, /ignoring CCDM_PYTHON=/);
    assert.match(fromSh.stdout, /fixture-echo/);
    const fromCmd = await cmdLine(workspace, { ...env, CCDM_PYTHON: bad }, "scripts\\ccdm --help");
    assert.equal(fromCmd.exitCode, 0, fromCmd.stderr);
    assert.match(fromCmd.stderr, /ignoring CCDM_PYTHON=/);
    assert.match(fromCmd.stdout, /fixture-echo/);
  }
});

// ---- module discovery ----

function plantModule(workspace, name, text) {
  fs.writeFileSync(path.join(workspace.repoDir, "scripts", "ccdmlib", "cli", name), text);
}

const REGISTERS = name => `def register(subparsers):\n    subparsers.add_parser("${name}", help="a planted module")\n`;

test("a module dropped into ccdmlib/cli appears in --help; helpers and modules without register do not", async () => {
  const workspace = createWorkspace();
  const before = fs.readFileSync(path.join(workspace.repoDir, "scripts", "ccdmlib", "cli", "__init__.py"));
  plantModule(workspace, "planted.py", REGISTERS("planted-command"));
  plantModule(workspace, "_helper.py", REGISTERS("helper-command"));
  plantModule(workspace, "no_register.py", "VALUE = 1\n");
  const result = await ccdm(workspace, ["--help"]);
  assertRan(result);
  assert.match(result.stdout, /planted-command\s+a planted module/);
  assert.doesNotMatch(result.stdout, /helper-command/);
  assert.equal(result.stderr, "");
  assert.ok(before.equals(fs.readFileSync(path.join(workspace.repoDir, "scripts", "ccdmlib", "cli", "__init__.py"))));
});

test("a package with register is discovered, as P5.1's services package will be", async () => {
  const workspace = createWorkspace();
  const directory = path.join(workspace.repoDir, "scripts", "ccdmlib", "cli", "planted_package");
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, "__init__.py"), REGISTERS("package-command"));
  const result = await ccdm(workspace, ["--help"]);
  assertRan(result);
  assert.match(result.stdout, /package-command/);
});

test("the fixture directory is searched only when CCDM_CLI_TEST_MODULES is set", async () => {
  const { workspace } = fixtureWorkspace();
  const result = await ccdm(workspace, ["--help"]);
  assertRan(result);
  assert.doesNotMatch(result.stdout, /fixture-echo/);
});

test("a module that fails to import is named on stderr and the others still work", async () => {
  const { workspace, moduleEnv } = fixtureWorkspace();
  plantModule(workspace, "broken_module.py", "raise RuntimeError('planted failure')\n");
  const result = await ccdm(workspace, ["fixture-echo", "still-here"], moduleEnv);
  assertRan(result);
  assert.match(result.stderr, /broken_module.*planted failure/);
  assert.deepEqual(reportOf(result).argv, ["still-here"]);
});

// ---- shims ----

const SHIM_EXEC = /^\s*exec\s+"\$\(cd\s.*\bccdm"\s/m;

function trackedShims() {
  const listed = spawnSync("git", ["ls-files", "-z", "*.sh"], { cwd: REPO, encoding: "utf8", windowsHide: true });
  assert.equal(listed.status, 0, listed.stderr);
  return listed.stdout.split("\0").filter(Boolean)
    .filter(file => SHIM_EXEC.test(fs.readFileSync(path.join(REPO, file), "utf8")));
}

// Every tracked shim, plus one planted of each kind, so the test proves something before the first lift.
function workspaceShims(workspace) {
  const planted = {
    "scripts/planted-shim.sh": 'exec "$(cd "$(dirname "$0")" && pwd)/ccdm" planted-command "$@"',
    "restart-root-planted.sh": 'exec "$(cd "$(dirname "$0")" && pwd)/scripts/ccdm" planted-command "$@"',
  };
  for (const [file, body] of Object.entries(planted)) {
    const target = path.join(workspace.repoDir, file);
    fs.writeFileSync(target, `#!/bin/sh\n${body}\n`);
    fs.chmodSync(target, 0o755);
  }
  plantModule(workspace, "planted.py", REGISTERS("planted-command"));
  return [...Object.keys(planted), ...trackedShims()];
}

const SHIM_ARGS = ["--help"];

test("a shim gives the same output from another directory as from the repo root", async () => {
  const workspace = createWorkspace();
  for (const shim of workspaceShims(workspace)) {
    const atRoot = await runScript(workspace, shim, { args: SHIM_ARGS, timeoutMs: 20000 });
    const elsewhere = await runScript(workspace, shim, { args: SHIM_ARGS, cwd: workspace.tmpDir, timeoutMs: 20000 });
    assertRan(atRoot);
    assert.equal(elsewhere.exitCode, atRoot.exitCode, shim);
    assert.equal(elsewhere.stdout, atRoot.stdout, shim);
    assert.equal(elsewhere.stderr, atRoot.stderr, shim);
  }
});

test("a shim run by absolute path from / under env -i gives the same output as from the repo root", platformGate("posix", "emulates the bare environment of a macOS LaunchAgent"), async () => {
  const workspace = createWorkspace();
  const bare = ["-i", `HOME=${workspace.homeDir}`, "PATH=/usr/bin:/bin"];
  for (const shim of workspaceShims(workspace)) {
    const script = path.join(workspace.repoDir, shim);
    const fromRoot = await run("/usr/bin/env", [...bare, script, ...SHIM_ARGS], { cwd: "/" });
    const fromRepo = await run("/usr/bin/env", [...bare, script, ...SHIM_ARGS], { cwd: workspace.repoDir });
    assert.equal(fromRepo.exitCode, 0, `${shim}: ${fromRepo.stderr}`);
    assert.equal(fromRoot.exitCode, fromRepo.exitCode, shim);
    assert.equal(fromRoot.stdout, fromRepo.stdout, shim);
    assert.equal(fromRoot.stderr, fromRepo.stderr, shim);
  }
});

// ---- the self-detach rule ----

async function hostWorld() {
  const { workspace, moduleEnv } = fixtureWorkspace();
  const fake = await startFakeHost(workspace);
  seedTmuxSession(TARGET, { job: [] }, { stateDir: workspace.stateDir });
  return { workspace, stateRoot: fake.stateRoot, env: { ...moduleEnv, ...fake.env } };
}

function tmuxWorld() {
  const { workspace, moduleEnv } = fixtureWorkspace();
  const stateRoot = path.join(workspace.tmpRoot, "tmux-state");
  seedTmuxSession(TARGET, {}, { stateDir: workspace.stateDir });
  return { workspace, stateRoot, env: { ...moduleEnv, CCDM_SESSION_HOST: "tmux", CCDM_STATE_ROOT: stateRoot } };
}

const logOf = (stateRoot, target = TARGET) => path.join(stateRoot, "logs", `fixture-lifecycle-${target}.log`);
const lifecycle = (world, env = {}, args = []) => ccdm(world.workspace, ["fixture-lifecycle", TARGET, ...args], { ...world.env, ...env });

async function assertForeground(world, env) {
  const result = await lifecycle(world, env);
  assert.equal(result.exitCode, FOREGROUND_EXIT, result.stderr);
  const report = reportOf(result);
  assert.deepEqual(report.argv, [TARGET]);
  assert.equal(report.detached, null);
  assert.equal(exists(logOf(world.stateRoot)), false);
}

async function assertDetachedCopy(world, callerPid) {
  const log = logOf(world.stateRoot);
  const written = await until(() => exists(log) && fs.readFileSync(log, "utf8").trim(), "the detached copy's log");
  const lines = written.split("\n").filter(Boolean);
  assert.equal(lines.length, 1, written);
  const report = JSON.parse(lines[0]);
  assert.deepEqual(report.argv, [TARGET]);
  assert.equal(report.detached, "1");
  assert.equal(report.session, null);
  assert.equal(report.utf8, 1);
  assert.notEqual(report.pid, callerPid);
}

function assertRedispatched(result) {
  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout, /continues in a detached process/);
}

function assertOneHostRedispatch(world) {
  const dispatched = hostOps(world.workspace).filter(entry => entry.op === "run-detached");
  assert.equal(dispatched.length, 1);
  const [{ argv, env, log }] = dispatched;
  assert.equal(path.basename(argv[1]), "ccdm.py");
  assert.deepEqual(argv.slice(2, 4), ["fixture-lifecycle", TARGET]);
  assert.equal(env.CCDM_DETACHED, "1");
  assert.equal(env.CCDM_SESSION_NAME, undefined);
  assert.equal(env.CCDM_STATE_ROOT, world.stateRoot);
  assert.equal(path.isAbsolute(log), true);
  assert.equal(path.basename(log), `fixture-lifecycle-${TARGET}.log`);
}

// Runs the lifecycle command, with the caller's PID put into the target's pids before it decides.
async function lifecycleFromOwnPid(world, addPid) {
  const pidFile = path.join(world.workspace.tmpRoot, "caller.pid");
  const goFile = path.join(world.workspace.tmpRoot, "caller.go");
  const running = lifecycle(world, {}, ["--pid-file", pidFile, "--go-file", goFile]);
  const pid = Number(await until(() => exists(pidFile) && fs.readFileSync(pidFile, "utf8"), "the caller's PID"));
  updateState(world.workspace.stateDir, (state) => {
    addPid(state.fixtures.tmux.sessions[TARGET], pid);
    return state;
  });
  fs.writeFileSync(goFile, "");
  return { pid, result: await running };
}

test("fake host: a lifecycle command against another session runs in the foreground", async () => {
  const world = await hostWorld();
  await assertForeground(world, { CCDM_SESSION_NAME: "root_agent" });
  assert.equal(hostOps(world.workspace).filter(entry => entry.op === "run-detached").length, 0);
});

test("fake host: from the target's own session name it re-dispatches and exits 0", async () => {
  const world = await hostWorld();
  const result = await lifecycle(world, { CCDM_SESSION_NAME: TARGET });
  assertRedispatched(result);
  assertOneHostRedispatch(world);
  await assertDetachedCopy(world, null);
  assertOneHostRedispatch(world);
});

test("fake host: from a PID in the target's pids it re-dispatches and exits 0", async () => {
  const world = await hostWorld();
  const { pid, result } = await lifecycleFromOwnPid(world, (session, callerPid) => { session.job = [callerPid]; });
  assertRedispatched(result);
  assertOneHostRedispatch(world);
  await assertDetachedCopy(world, pid);
});

test("fake host: a copy with CCDM_DETACHED=1 never re-dispatches, even from the target's session", async () => {
  const world = await hostWorld();
  const result = await lifecycle(world, { CCDM_DETACHED: "1", CCDM_SESSION_NAME: TARGET });
  assert.equal(result.exitCode, FOREGROUND_EXIT, result.stderr);
  assert.equal(reportOf(result).detached, "1");
  assert.equal(hostOps(world.workspace).filter(entry => entry.op === "run-detached").length, 0);
});

test("with no ccdm-host running another session's command still runs in the foreground", async () => {
  const { workspace, moduleEnv } = fixtureWorkspace();
  const stateRoot = path.join(workspace.tmpRoot, "no-host");
  await assertForeground({ workspace, stateRoot, env: { ...moduleEnv, CCDM_SESSION_HOST: "ccdm-host", CCDM_STATE_ROOT: stateRoot } }, {});
});

test("with no ccdm-host running a command in its own session fails and says why", async () => {
  const { workspace, moduleEnv } = fixtureWorkspace();
  const stateRoot = path.join(workspace.tmpRoot, "no-host");
  const world = { workspace, stateRoot, env: { ...moduleEnv, CCDM_SESSION_HOST: "ccdm-host", CCDM_STATE_ROOT: stateRoot } };
  const result = await lifecycle(world, { CCDM_SESSION_NAME: TARGET });
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /ccdm-host is not running/);
});

test("a target name unsafe in a file name is made safe in the log name", async () => {
  const world = await hostWorld();
  const result = await ccdm(world.workspace, ["fixture-lifecycle", "a/b:c"], { ...world.env, CCDM_SESSION_NAME: "a/b:c" });
  assertRedispatched(result);
  await until(() => exists(logOf(world.stateRoot, "a_b_c")), "the safely named log");
});

test("fake tmux: a lifecycle command against another session runs in the foreground", platformGate("posix", "the tmux front is POSIX; Windows goes through ccdm-host"), async () => {
  await assertForeground(tmuxWorld(), { CCDM_SESSION_NAME: "root_agent" });
});

test("fake tmux: from the target's own session name it re-dispatches and exits 0", platformGate("posix", "the tmux front is POSIX; Windows goes through ccdm-host"), async () => {
  const world = tmuxWorld();
  assertRedispatched(await lifecycle(world, { CCDM_SESSION_NAME: TARGET }));
  await assertDetachedCopy(world, null);
});

test("fake tmux: from a PID in the target's pids it re-dispatches and exits 0", platformGate("posix", "the tmux front is POSIX; Windows goes through ccdm-host"), async () => {
  const world = tmuxWorld();
  const { pid, result } = await lifecycleFromOwnPid(world, (session, callerPid) => { session.panePid = callerPid; });
  assertRedispatched(result);
  await assertDetachedCopy(world, pid);
});
