import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { bridgeChildEnv, createBridgeWorkspace } from "./support/bridge.js";
import { assertFixtureExecutable, assertIsolatedPath, redactSecrets } from "./support/diagnostics.js";
import {
  fixtureLauncher,
  harnessPrerequisiteProblem,
  hookShell,
  interpreterFor,
  platformGate,
  PYTHON,
  resolvePython,
  sendCtrlBreak,
  spawnWithCtrlBreak,
  withoutGitBashTmpWarning,
} from "./support/platform.js";
import { createWorkspace, runNodeEntrypoint, runnerInternals, runScript } from "./support/runner.js";
import {
  readState,
  recordCommandInvocation,
  seedFixtureProcess,
  seedRegistry,
  seedTmuxSession,
  snapshotFiles,
  writeState,
} from "./support/state.js";
import { cleanup, registerTeardownCallback, teardownSkips, workspaceOwnsPid } from "./support/teardown.js";
import { signalSupervisorWorker } from "./support/thread-supervisor.js";

const WINDOWS_ONLY = platformGate("win32", "this case only means anything on Windows");

test.afterEach(async () => {
  await cleanup();
});

test("workspace copies Git-visible source files and excludes local-only artifacts", () => {
  const workspace = createWorkspace();

  assert.ok(fs.existsSync(path.join(workspace.sourceRoot, "registry.example.json")));
  for (const artifact of ["registry.json", ".env", "CLAUDE.local.md", ".claude", ".codex"]) {
    assert.ok(!fs.existsSync(path.join(workspace.repoDir, artifact)), `${artifact} leaked into workspace`);
  }
  assert.ok(fs.existsSync(path.join(workspace.repoDir, "setup.sh")));
});

test("state store reloads from disk and records fixture helpers", () => {
  const workspace = createWorkspace();

  writeState({ custom: "value" }, workspace.stateDir);
  assert.equal(readState(workspace.stateDir).custom, "value");

  seedRegistry(workspace, { pool: [], projects: {} });
  seedFixtureProcess({ pid: process.pid, command: "fixture process" }, { stateDir: workspace.stateDir });
  seedTmuxSession("root_agent", { pane: "ready" }, { stateDir: workspace.stateDir });
  recordCommandInvocation({ command: ["setup.sh"], exitCode: 0 }, { stateDir: workspace.stateDir });
  const snapshot = snapshotFiles(workspace.repoDir, ["setup.sh"], { stateDir: workspace.stateDir });

  const state = readState(workspace.stateDir);
  assert.deepEqual(state.fixtures.registry, { pool: [], projects: {} });
  assert.equal(state.fixtures.processes[0].command, "fixture process");
  assert.equal(state.fixtures.tmux.sessions.root_agent.pane, "ready");
  assert.equal(state.commands[0].exitCode, 0);
  assert.equal(snapshot["setup.sh"].sha256.length, 64);
});

test("command runner injects isolated environment and allowlisted PATH", platformGate("posix", "drives setup.sh, a zsh script"), async () => {
  const workspace = createWorkspace();

  const result = await runScript(workspace, "setup.sh", {
    input: "user-id\nguild-id\nroot-token\n",
  });

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.equal(result.cwd, workspace.repoDir);
  assert.equal(result.detached, true);
  assert.equal(result.env.HOME, workspace.homeDir);
  assert.equal(result.env.PATH, workspace.fixtureDir);
  assert.equal(result.env.TMPDIR, workspace.tmpDir);
  assert.equal(result.env.CCDM_TEST_STATE, workspace.stateDir);
  assert.equal(result.env.NODE_PATH, path.join(workspace.sourceRoot, "node_modules"));
  assert.ok(Object.hasOwn(result.env, "NODE_OPTIONS"));
});

test("the command runner drops Git Bash's missing /tmp warning from stderr on Windows, and nothing else", async () => {
  const warning = "bash.exe: warning: could not find /tmp, please create!\n";
  const kept = "bash.exe: warning: something else\nfound /tmp, please create!\n";
  assert.equal(withoutGitBashTmpWarning(`${warning}${kept}${warning}`, "win32"), kept);
  assert.equal(withoutGitBashTmpWarning(`sh: warning: could not find /tmp, please create!\r\n${kept}`, "win32"), kept);
  assert.equal(withoutGitBashTmpWarning(`${warning}${kept}`, "linux"), `${warning}${kept}`);

  const workspace = createWorkspace({ excludeFixtures: ["sleep"] });
  fs.writeFileSync(path.join(workspace.repoDir, "scripts", "warns.sh"),
    "#!/bin/sh\nprintf '%s\\n' 'bash.exe: warning: could not find /tmp, please create!' 'bash.exe: warning: something else' >&2\n",
    { mode: 0o755 });
  const result = await runScript(workspace, "scripts/warns.sh");
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.stderr, `${process.platform === "win32" ? "" : warning}bash.exe: warning: something else\n`);
});

test("missing fixture tools fail fast without falling through to the host PATH", async () => {
  const workspace = createWorkspace({ excludeFixtures: ["jq"] });

  const result = await runScript(workspace, "setup.sh");

  assert.equal(result.exitCode, 1);
  assert.match(result.stdout, /jq/);
  assert.equal(result.env.PATH, workspace.fixtureDir);
});

// The sleep fixture needs a POSIX `true` binary, and these checks run no fixture,
// so leaving it out lets them run on Windows before the fixtures do.
function probeWorkspace() {
  return createWorkspace({ excludeFixtures: ["sleep"] });
}

test("isolation guards produce diagnostics for protected local boundaries", () => {
  const workspace = probeWorkspace();
  const protectedTargets = [
    path.join(workspace.sourceRoot, "registry.json"),
    path.join(os.homedir(), ".claude", "settings.json"),
    path.join(os.homedir(), ".codex", "config.toml"),
    path.join(os.tmpdir(), "ccdm-unapproved-os-tmpdir-file"),
    ...(process.platform === "win32" ? [] : ["/tmp/ccdm-unapproved-global-file"]),
  ];

  for (const target of protectedTargets) {
    assert.throws(() => assertIsolatedPath(workspace, target), /Protected path access denied/);
  }
  assert.throws(() => assertFixtureExecutable(workspace, "/usr/bin/tmux"), /Protected path access denied/);
  assert.throws(() => assertFixtureExecutable(workspace, "/usr/bin/security"), /Protected path access denied/);

  const state = readState(workspace.stateDir);
  assert.equal(state.diagnostics.protectedPathViolations.length, protectedTargets.length + 2);
});

// Sets (or, with undefined, removes) env vars for one synchronous body.
function withEnv(changes, body) {
  const saved = Object.keys(changes).map((key) => [key, process.env[key]]);
  const apply = (entries) => {
    for (const [key, value] of entries) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  apply(Object.entries(changes));
  try {
    return body();
  } finally {
    apply(saved);
  }
}

test("diagnostics resolve ~/.claude and ~/.codex through os.homedir()", () => {
  const workspace = probeWorkspace();

  // Takes HOME out of the answer: unset on POSIX (os.homedir() falls back to the
  // password database), and elsewhere on Windows (os.homedir() reads USERPROFILE).
  const home = process.platform === "win32" ? path.resolve(path.sep, "ccdm-not-the-home") : undefined;
  withEnv({ HOME: home }, () => {
    assert.notEqual(process.env.HOME, os.homedir());
    for (const name of [".claude", ".codex"]) {
      assert.throws(() => assertIsolatedPath(workspace, path.join(os.homedir(), name, "file")), /Protected path access denied/);
    }
  });
});

test("a path under os.tmpdir() outside the workspace is flagged, and /tmp/ stays flagged on POSIX", () => {
  const workspace = probeWorkspace();

  // A temp dir that is not /tmp, so each check has to hold by itself.
  const fakeTmp = path.resolve(path.sep, "ccdm-fake-tmpdir");
  const inFakeTmp = { ...workspace, tmpRoot: path.join(fakeTmp, "ccdm-e2e-workspace") };
  withEnv({ TEMP: fakeTmp, TMP: fakeTmp, TMPDIR: fakeTmp }, () => {
    assert.equal(os.tmpdir(), fakeTmp);
    assert.throws(() => assertIsolatedPath(inFakeTmp, path.join(fakeTmp, "outside")), /Protected path access denied/);
    assert.throws(() => assertIsolatedPath(inFakeTmp, `${inFakeTmp.tmpRoot}-sibling${path.sep}file`), /Protected path access denied/);
    assert.doesNotThrow(() => assertIsolatedPath(inFakeTmp, path.join(inFakeTmp.tmpRoot, "tmp", "file")));
    if (process.platform !== "win32") {
      assert.throws(() => assertIsolatedPath(inFakeTmp, "/tmp/ccdm-unapproved-global-file"), /Protected path access denied/);
    }
  });
});

test("the workspace env on win32 isolates the profile and temp dirs and keeps what Windows needs to start", () => {
  const dirs = {
    fixtureDir: "C:\\w\\fixtures",
    homeDir: "C:\\w\\home",
    root: "C:\\src",
    stateDir: "C:\\w\\state",
    tmpDir: "C:\\w\\tmp",
  };
  const env = runnerInternals.workspaceEnv({
    ...dirs,
    hostEnv: {
      APPDATA: "C:\\real\\Roaming",
      ComSpec: "C:\\Windows\\system32\\cmd.exe",
      LOCALAPPDATA: "C:\\real\\Local",
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
      SystemRoot: "C:\\Windows",
      TEMP: "C:\\real\\Temp",
      USERPROFILE: "C:\\real",
      windir: "C:\\Windows",
    },
    platform: "win32",
  });

  assert.deepEqual(env, {
    APPDATA: "C:\\w\\home\\AppData\\Roaming",
    CCDM_TEST_STATE: dirs.stateDir,
    ComSpec: "C:\\Windows\\system32\\cmd.exe",
    HOME: dirs.homeDir,
    HOMEDRIVE: "C:",
    HOMEPATH: "\\w\\home",
    LOCALAPPDATA: "C:\\w\\home\\AppData\\Local",
    NODE_OPTIONS: "",
    NODE_PATH: path.join(dirs.root, "node_modules"),
    PATH: dirs.fixtureDir,
    PATHEXT: ".COM;.EXE",
    PYTHONPATH: path.join(dirs.root, "tests", "e2e", "support", "pysafe"),
    SystemRoot: "C:\\Windows",
    TEMP: dirs.tmpDir,
    TMP: dirs.tmpDir,
    TMPDIR: dirs.tmpDir,
    USERPROFILE: dirs.homeDir,
    windir: "C:\\Windows",
  });
});

test("the workspace env on POSIX is only the isolated values and the Python guard's path", () => {
  const dirs = { fixtureDir: "/w/fixtures", homeDir: "/w/home", root: "/src", stateDir: "/w/state", tmpDir: "/w/tmp" };
  for (const platform of ["linux", "darwin"]) {
    assert.deepEqual(runnerInternals.workspaceEnv({ ...dirs, hostEnv: { SystemRoot: "unused" }, platform }), {
      CCDM_TEST_STATE: dirs.stateDir,
      HOME: dirs.homeDir,
      NODE_OPTIONS: "",
      NODE_PATH: path.join(dirs.root, "node_modules"),
      PATH: dirs.fixtureDir,
      PYTHONPATH: path.join(dirs.root, "tests", "e2e", "support", "pysafe"),
      TMPDIR: dirs.tmpDir,
    });
  }
});

// The workspace PATH holds only fixtures, so the host interpreter goes by absolute path.
function hostPythonPath() {
  const probe = spawnSync(PYTHON, ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" });
  assert.equal(probe.status, 0, probe.stderr);
  return probe.stdout.trim();
}

function locationsSeenWith(env, cwd) {
  const python = hostPythonPath();
  const read = (command, args) => {
    const result = spawnSync(command, args, { cwd, encoding: "utf8", env });
    assert.equal(result.status, 0, result.stderr || String(result.error));
    return result.stdout.trim();
  };
  return {
    nodeHome: read(process.execPath, ["-e", "console.log(require('os').homedir())"]),
    nodeTemp: read(process.execPath, ["-e", "console.log(require('os').tmpdir())"]),
    pythonHome: read(python, ["-c", "from pathlib import Path; print(Path.home())"]),
    pythonTemp: read(python, ["-c", "import tempfile; print(tempfile.gettempdir())"]),
  };
}

test("inside a workspace, Node and the host Python see the workspace home and temp dir", () => {
  const workspace = probeWorkspace();

  assert.deepEqual(locationsSeenWith(workspace.env, workspace.repoDir), {
    nodeHome: workspace.homeDir,
    nodeTemp: workspace.tmpDir,
    pythonHome: workspace.homeDir,
    pythonTemp: workspace.tmpDir,
  });
});

// Runs in a child with its own empty temp dir: other files share this process's
// temp dir, and the fixture cache lives there and in the process.
function createWorkspaceInEmptyTemp(options, extraEnv = {}) {
  const emptyTemp = fs.mkdtempSync(path.join(os.tmpdir(), "ccdm-empty-temp-"));
  registerTeardownCallback(() => fs.rmSync(emptyTemp, { force: true, recursive: true }));
  const script = `
    import fs from "node:fs";
    import os from "node:os";
    import { createWorkspace } from ${JSON.stringify(new URL("./support/runner.js", import.meta.url).href)};
    import { cleanup } from ${JSON.stringify(new URL("./support/teardown.js", import.meta.url).href)};
    let message = null;
    try {
      createWorkspace(${JSON.stringify(options)});
    } catch (error) {
      message = error.message;
    }
    const beforeCleanup = fs.readdirSync(os.tmpdir());
    await cleanup();
    console.log(JSON.stringify({ afterCleanup: fs.readdirSync(os.tmpdir()), beforeCleanup, message }));
  `;
  const { CCDM_E2E_KEEP_FAILED, ...hostEnv } = process.env;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    env: { ...hostEnv, ...extraEnv, TEMP: emptyTemp, TMP: emptyTemp, TMPDIR: emptyTemp },
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim().split("\n").at(-1));
}

test("createWorkspace that throws part-way leaves nothing it created after cleanup", () => {
  // Not iterable, so it throws in createFixtures: after the workspace tree, before any build.
  const { afterCleanup, beforeCleanup, message } = createWorkspaceInEmptyTemp({ excludeFixtures: 5 });

  assert.match(message, /not iterable/);
  assert.equal(beforeCleanup.filter((name) => /^ccdm-e2e-(?!fixtures-)/.test(name)).length, 1, beforeCleanup.join());
  assert.deepEqual(afterCleanup, []);
});

test("a failed fixture build leaves no staging dir and no workspace in its temp dir", () => {
  const { afterCleanup, beforeCleanup, message } = createWorkspaceInEmptyTemp({}, { CCDM_E2E_FAIL_FIXTURE_BUILD: "1" });

  assert.match(message, /Forced fixture build failure/);
  assert.deepEqual(beforeCleanup.filter((name) => name.includes(".staging-")), []);
  assert.deepEqual(afterCleanup, []);
});

// A process this test starts itself: the only kind these cases may signal or plant.
function startSleeper(extraArgs = []) {
  return spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", ...extraArgs], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function exitOf(child) {
  return new Promise((resolve) => child.once("exit", resolve));
}

async function waitUntilGone(pid, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (processAlive(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(processAlive(pid), false, `process ${pid} is still running`);
}

function seedOwnedRow(workspace, pid) {
  seedFixtureProcess(
    { command: "fixture process", owned: true, ownerStateDir: workspace.stateDir, pid, ppid: process.pid },
    { stateDir: workspace.stateDir },
  );
}

test("teardown leaves a recorded PID running when its command line lacks the workspace marker, and logs the skip", async () => {
  const workspace = probeWorkspace();
  const sentinel = startSleeper();
  try {
    seedOwnedRow(workspace, sentinel.pid);

    await cleanup();

    assert.equal(processAlive(sentinel.pid), true);
    assert.ok(teardownSkips().some((skip) => skip.pid === sentinel.pid && skip.marker === workspace.tmpRoot));
  } finally {
    sentinel.kill();
  }
});

test("teardown stops a recorded PID whose command line carries the workspace marker", async () => {
  const workspace = probeWorkspace();
  const owned = startSleeper([workspace.tmpRoot]);
  const exited = exitOf(owned);
  try {
    seedOwnedRow(workspace, owned.pid);

    await cleanup();
    await exited;

    assert.deepEqual(teardownSkips().filter((skip) => skip.pid === owned.pid), []);
  } finally {
    owned.kill();
  }
});

test("teardown stops a process the harness holds a handle to", async () => {
  const workspace = probeWorkspace();
  fs.writeFileSync(path.join(workspace.repoDir, "hold.js"), "setInterval(() => {}, 1000);\n");
  const running = runNodeEntrypoint(workspace, "hold.js", { timeoutMs: 120000 });

  await cleanup();
  const result = await running;

  assert.notEqual(result.exitCode, 0);
});

test("on POSIX, teardown still stops every process in a verified group", platformGate("posix", "Windows has no process groups to signal"), async () => {
  const workspace = probeWorkspace();
  const leaderCode = `
    const child = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    console.log(child.pid);
    setInterval(() => {}, 1000);
  `;
  const leader = spawn(process.execPath, ["-e", leaderCode, workspace.tmpRoot], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
  const exited = exitOf(leader);
  const member = await new Promise((resolve) => leader.stdout.once("data", (chunk) => resolve(Number(String(chunk).trim()))));
  try {
    seedOwnedRow(workspace, leader.pid);

    await cleanup();
    await exited;

    await waitUntilGone(member);
  } finally {
    leader.kill();
    if (processAlive(member)) process.kill(member, "SIGKILL");
  }
});

test("a fixture's real launch carries the workspace marker, so teardown can stop it", async () => {
  const workspace = createWorkspace();
  const keyFile = path.join(workspace.tmpDir, "router", "keys", "project.key");
  const started = spawnSync(path.join(workspace.fixtureDir, "tmux"), [
    "new-session", "-d", "-s", "project_session", "--", "zsh", "-ic",
    `cd '${workspace.tmpDir}' && CCDM_ROUTER_KEY_FILE='${keyFile}' claude --dangerously-load-development-channels server:ccdm --dangerously-skip-permissions`,
  ], { cwd: workspace.repoDir, encoding: "utf8", env: workspace.env });
  assert.equal(started.status, 0, started.stderr);
  const { pid } = readState(workspace.stateDir).fixtures.processes.find((row) => row.owned);

  assert.equal(workspaceOwnsPid(pid, workspace.tmpRoot), true);
  await cleanup();

  await waitUntilGone(pid);
  assert.deepEqual(teardownSkips().filter((skip) => skip.pid === pid), []);
});

test("the thread supervisor's stop signals worker_pid only after the marker check", async () => {
  const workspace = probeWorkspace();
  const sentinel = startSleeper();
  const worker = startSleeper([workspace.tmpRoot]);
  const workerExited = exitOf(worker);
  try {
    assert.equal(signalSupervisorWorker(workspace, sentinel.pid), false);
    assert.equal(processAlive(sentinel.pid), true);
    assert.ok(teardownSkips().some((skip) => skip.pid === sentinel.pid));

    assert.equal(signalSupervisorWorker(workspace, worker.pid), true);
    await workerExited;
  } finally {
    sentinel.kill();
    worker.kill();
  }
});

test("os.kill(pid, 0) in a Python grandchild raises RuntimeError on win32 and is untouched on POSIX", async () => {
  const workspace = probeWorkspace();
  // On win32 it never makes the real call: an unguarded signal 0 would be Ctrl+C.
  fs.writeFileSync(path.join(workspace.repoDir, "probe.py"), [
    "import json, os, sitecustomize, sys",
    "builtin = type(os.kill).__name__ == 'builtin_function_or_method'",
    "if sys.platform == 'win32' and builtin:",
    "    outcome = 'unguarded'",
    "else:",
    "    try:",
    "        os.kill(os.getpid(), 0)",
    "        outcome = 'returned'",
    "    except BaseException as error:",
    "        outcome = f'{type(error).__name__}: {error}'",
    "print(json.dumps({'builtin': builtin, 'guard': sitecustomize.__file__, 'outcome': outcome}))",
    "",
  ].join("\n"));
  fs.writeFileSync(path.join(workspace.repoDir, "launch.js"), [
    'const { spawnSync } = require("node:child_process");',
    'const result = spawnSync(process.argv[2], [process.argv[3]], { encoding: "utf8", windowsHide: true });',
    'process.stdout.write(result.stdout ?? "");',
    'process.stderr.write(result.stderr || String(result.error ?? ""));',
    "process.exit(result.status ?? 1);",
    "",
  ].join("\n"));

  const result = await runNodeEntrypoint(workspace, "launch.js", {
    args: [hostPythonPath(), path.join(workspace.repoDir, "probe.py")],
    timeoutMs: 30000,
  });

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout.trim());
  assert.equal(report.guard, path.join(workspace.sourceRoot, "tests", "e2e", "support", "pysafe", "sitecustomize.py"));
  if (process.platform === "win32") {
    assert.equal(report.builtin, false);
    assert.equal(report.outcome, "RuntimeError: os.kill(pid, 0) is unsafe on Windows");
  } else {
    assert.equal(report.builtin, true);
    assert.equal(report.outcome, "returned");
  }
});

// Every spawn-family call in a source file, from its name to its closing paren.
function spawnCalls(source) {
  const calls = [];
  for (const match of source.matchAll(/\b(?:spawn|spawnSync|execFile|execFileSync|execSync)\(/g)) {
    let depth = 0;
    let quote = null;
    let end = match.index + match[0].length - 1;
    for (; end < source.length; end += 1) {
      const char = source[end];
      if (char === "\\") end += 1;
      else if (quote) quote = char === quote ? null : quote;
      else if ("'\"`".includes(char)) quote = char;
      else if (char === "(") depth += 1;
      else if (char === ")" && --depth === 0) break;
    }
    calls.push(source.slice(match.index, end + 1));
  }
  return calls;
}

test("every harness spawn hides its window, and the fixture claude's hook PATH uses the platform delimiter", () => {
  const supportDir = fileURLToPath(new URL("./support/", import.meta.url));
  const calls = fs.readdirSync(supportDir)
    .filter((name) => name.endsWith(".js"))
    .flatMap((name) => spawnCalls(fs.readFileSync(path.join(supportDir, name), "utf8")).map((call) => ({ call, name })));

  assert.ok(calls.length >= 15, `found only ${calls.length} spawn calls`);
  for (const { call, name } of calls) {
    assert.match(call, /windowsHide: true/, `${name}: ${call}`);
  }
  const runnerSource = fs.readFileSync(path.join(supportDir, "runner.js"), "utf8");
  assert.match(runnerSource, /const hookEnv = .*path\.delimiter/);
});

function seedChildOf(workspace, parentPid, pid) {
  seedFixtureProcess(
    { command: "child worker", owned: true, ownerStateDir: workspace.stateDir, pid, ppid: parentPid },
    { stateDir: workspace.stateDir },
  );
}

function runPkill(workspace, parentPid) {
  return spawnSync(path.join(workspace.fixtureDir, "pkill"), ["-TERM", "-P", String(parentPid)], {
    cwd: workspace.repoDir,
    encoding: "utf8",
    env: workspace.env,
    windowsHide: true,
  });
}

test("the fixture pkill leaves a seeded child without the workspace marker running, and logs the skip", async () => {
  const workspace = createWorkspace();
  const parentPid = 424242;
  const sentinel = startSleeper();
  try {
    seedChildOf(workspace, parentPid, sentinel.pid);

    const result = runPkill(workspace, parentPid);

    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, new RegExp(`skipped pid ${sentinel.pid}`));
    assert.equal(processAlive(sentinel.pid), true);
    assert.deepEqual(readState(workspace.stateDir).fixtures.pkillSkips, [{ marker: workspace.tmpRoot, pid: sentinel.pid }]);
  } finally {
    sentinel.kill();
  }
});

test("the fixture pkill signals a seeded child whose command line holds the workspace marker", async () => {
  const workspace = createWorkspace();
  const parentPid = 424243;
  const child = startSleeper([workspace.tmpRoot]);
  const exited = exitOf(child);
  try {
    seedChildOf(workspace, parentPid, child.pid);

    const result = runPkill(workspace, parentPid);

    assert.equal(result.status, 0, result.stderr);
    await exited;
    assert.equal(readState(workspace.stateDir).fixtures.pkillSkips, undefined);
  } finally {
    child.kill();
  }
});

test("on win32 the fixture ps and pgrep leave out a live owned row without the workspace marker", WINDOWS_ONLY, () => {
  const workspace = createWorkspace();
  const parentPid = 424244;
  const sentinel = startSleeper();
  const owned = startSleeper([workspace.tmpRoot]);
  const run = (tool, args) => spawnSync(path.join(workspace.fixtureDir, tool), args, { cwd: workspace.repoDir, encoding: "utf8", env: workspace.env, windowsHide: true });
  try {
    seedChildOf(workspace, parentPid, sentinel.pid);
    seedChildOf(workspace, parentPid, owned.pid);

    assert.equal(run("pgrep", ["-P", String(parentPid)]).stdout.trim(), String(owned.pid));
    const listed = run("ps", ["axeww", "-o", "pid=,command="]).stdout;
    assert.match(listed, new RegExp(`\\b${owned.pid}\\b`));
    assert.doesNotMatch(listed, new RegExp(`\\b${sentinel.pid}\\b`));
  } finally {
    sentinel.kill();
    owned.kill();
  }
});

test("a SessionStart hook written as node '<forward-slash path>' runs through the fixture claude and records exit 0", async () => {
  const workspace = createWorkspace();
  const marker = path.join(workspace.tmpDir, "hook-ran");
  const forwardSlash = (file) => file.split(path.sep).join("/");
  const hookScript = path.join(workspace.tmpDir, "hook.js");
  fs.writeFileSync(hookScript, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");\n`);
  const settings = path.join(workspace.tmpDir, "settings.json");
  fs.writeFileSync(settings, JSON.stringify({
    hooks: { SessionStart: [{ hooks: [{ type: "command", command: `node '${forwardSlash(hookScript)}'` }] }] },
  }));
  const server = path.join(workspace.tmpDir, "server.js");
  fs.writeFileSync(server, "setInterval(() => {}, 1000);\n");
  const mcpConfig = path.join(workspace.tmpDir, "mcp.json");
  fs.writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { ccdm: { command: "node", args: [server] } } }));
  const keyFile = path.join(workspace.tmpDir, "project.key");
  const tmux = (args) => spawnSync(path.join(workspace.fixtureDir, "tmux"), args, {
    cwd: workspace.repoDir, encoding: "utf8", env: workspace.env, windowsHide: true,
  });

  const started = tmux([
    "new-session", "-d", "-s", "hook_session", "--", "zsh", "-ic",
    `cd '${workspace.tmpDir}' && CCDM_ROUTER_KEY_FILE='${keyFile}' claude --dangerously-load-development-channels server:ccdm --dangerously-skip-permissions --settings ${settings} --mcp-config ${mcpConfig}`,
  ]);
  assert.equal(started.status, 0, started.stderr);
  const accepted = tmux(["send-keys", "-t", "hook_session", "Enter"]);
  assert.equal(accepted.status, 0, accepted.stderr);

  const deadline = Date.now() + 60000;
  while (!readState(workspace.stateDir).fixtures.claude.hookRuns?.length && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.deepEqual(readState(workspace.stateDir).fixtures.claude.hookRuns, [{ event: "SessionStart", exitCode: 0 }]);
  assert.equal(fs.readFileSync(marker, "utf8"), "ran");
});

test("hooks use /bin/sh on POSIX, and Git Bash on win32 or a clear failure without it", () => {
  for (const platform of ["linux", "darwin"]) assert.equal(hookShell({ platform }), "/bin/sh");
  assert.throws(() => hookShell({ env: { CCDM_E2E_GIT_SH: "Z:\\no\\sh.exe" }, platform: "win32" }), /Git Bash.*sh\.exe/s);
});

test("PYTHON resolution follows CCDM_PYTHON, then python3 on POSIX, then py -3 and python on win32, rejecting the Store stub", () => {
  const unused = () => assert.fail("nothing to probe");
  assert.equal(resolvePython({ env: { CCDM_PYTHON: "/opt/py" }, platform: "win32", probe: unused }), "/opt/py");
  assert.equal(resolvePython({ env: {}, platform: "linux", probe: unused }), "python3");
  assert.equal(resolvePython({ env: {}, platform: "darwin", probe: unused }), "python3");
  const probeOf = (answers) => (command) => answers[command] ?? null;
  assert.equal(resolvePython({ env: {}, platform: "win32", probe: probeOf({ py: "C:\\Py\\python.exe", python: "C:\\Other\\python.exe" }) }), "C:\\Py\\python.exe");
  assert.equal(resolvePython({
    env: {},
    platform: "win32",
    probe: probeOf({ py: "C:\\Users\\a\\AppData\\Local\\Microsoft\\WindowsApps\\python.exe", python: "C:\\Other\\python.exe" }),
  }), "C:\\Other\\python.exe");
  assert.equal(resolvePython({ env: {}, platform: "win32", probe: probeOf({}) }), null);
});

test("platformGate runs posix on Linux and macOS, darwin only on macOS, and win32 only on Windows", () => {
  const skipped = (tag, platform) => Boolean(platformGate(tag, "why", platform).skip);
  assert.deepEqual(["linux", "darwin", "win32"].map((os_) => skipped("posix", os_)), [false, false, true]);
  assert.deepEqual(["linux", "darwin", "win32"].map((os_) => skipped("darwin", os_)), [true, false, true]);
  assert.deepEqual(["linux", "darwin", "win32"].map((os_) => skipped("win32", os_)), [true, true, false]);
  assert.throws(() => platformGate("freebsd"), /Unknown platform tag/);
});

test("interpreterFor leaves POSIX to the shebang and names the interpreter on win32", () => {
  const workspace = probeWorkspace();
  const script = (name, content) => {
    const file = path.join(workspace.tmpDir, name);
    fs.writeFileSync(file, content);
    return file;
  };
  const python = script("tool", "#!/usr/bin/env python3\n");
  const node = script("tool.js", "#!/usr/bin/env node\n");

  assert.deepEqual(interpreterFor(python, "linux"), [python]);
  assert.deepEqual(interpreterFor(python, "darwin"), [python]);
  assert.deepEqual(interpreterFor(python, "win32"), [PYTHON, python]);
  assert.deepEqual(interpreterFor(node, "win32"), [process.execPath, node]);
  assert.deepEqual(interpreterFor("C:\\x\\tool.exe", "win32"), ["C:\\x\\tool.exe"]);
});

test("the prerequisite check is silent off Windows and names a missing compiler on win32", () => {
  for (const platform of ["linux", "darwin"]) {
    assert.equal(harnessPrerequisiteProblem({ env: { CCDM_E2E_CSC: "/no/csc.exe" }, platform }), null);
  }
});

test("a detached grandchild of a fixture tool does not hold the caller's pipes open", WINDOWS_ONLY, () => {
  const workspace = probeWorkspace();
  const middle = path.join(workspace.tmpDir, "middle.js");
  fs.writeFileSync(middle, [
    'const { spawn } = require("node:child_process");',
    'spawn(process.execPath, ["-e", "setTimeout(() => {}, 15000)"], { detached: true, stdio: "ignore", windowsHide: true }).unref();',
    "process.exit(0);",
    "",
  ].join("\n"));
  const started = Date.now();

  const result = spawnSync(launcherPair(workspace.tmpDir, "middle", [process.execPath, middle]), [], { encoding: "utf8", windowsHide: true });

  assert.equal(result.status, 0, result.stderr);
  assert.ok(Date.now() - started < 10000, "spawnSync waited for the grandchild");
});

// A workspace-free launcher with a shim of our own, to check exactly what the child receives.
function launcherPair(dir, name, shimLines) {
  const exe = path.join(dir, `${name}.exe`);
  fs.copyFileSync(fixtureLauncher(), exe);
  fs.writeFileSync(path.join(dir, `${name}.shim`), `${shimLines.join("\n")}\n`);
  return exe;
}

test("the launcher passes hostile arguments through unchanged and returns the exit code", WINDOWS_ONLY, () => {
  const workspace = probeWorkspace();
  const dump = path.join(workspace.tmpDir, "dump.js");
  fs.writeFileSync(dump, "process.stdout.write(JSON.stringify(process.argv.slice(2))); process.exit(Number(process.env.CODE));\n");
  const exe = launcherPair(workspace.tmpDir, "dump tool", [process.execPath, dump]);
  const args = [
    "with space", "it's", 'say "hi"', "a&b", "100%", "%PATH%", "wow!", "x^y", 'a\\"b', "C:\\dir\\", '\\\\"', "",
    "trailing\\", " leading", "日本語", "🦈 and 🌊", "a\tb", "--flag=a b",
  ];

  const result = spawnSync(exe, args, { encoding: "utf8", env: { ...process.env, CODE: "37" }, windowsHide: true });

  assert.equal(result.status, 37, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), args);
});

test("the launcher passes stdin through, sends a no-op shim to exit 0, and reports a bad program", WINDOWS_ONLY, () => {
  const workspace = probeWorkspace();
  const copy = path.join(workspace.tmpDir, "copy.js");
  fs.writeFileSync(copy, "process.stdin.pipe(process.stdout);\n");
  const piped = spawnSync(launcherPair(workspace.tmpDir, "copy", [process.execPath, copy]), [], {
    encoding: "utf8", input: "through the pipe", windowsHide: true,
  });
  assert.equal(piped.status, 0, piped.stderr);
  assert.equal(piped.stdout, "through the pipe");

  const noop = spawnSync(launcherPair(workspace.tmpDir, "noop", [":noop"]), ["30"], { encoding: "utf8", windowsHide: true });
  assert.equal(noop.status, 0, noop.stderr);

  const bad = spawnSync(launcherPair(workspace.tmpDir, "bad", ["Z:\\no\\such.exe"]), [], { encoding: "utf8", windowsHide: true });
  assert.equal(bad.status, 126);
  assert.match(bad.stderr, /cannot start/);
});

test("workspaces get hard-linked tool.exe and tool.shim pairs, and a tool runs when found through PATH", WINDOWS_ONLY, () => {
  const workspace = createWorkspace();
  for (const file of ["jq.exe", "jq.shim", "sleep.exe", "sleep.shim", "python3.exe", "python3.shim"]) {
    assert.ok(fs.statSync(path.join(workspace.fixtureDir, file)).nlink >= 2, `${file} is not a hard link`);
  }

  const jq = spawnSync("jq", [".guild_id"], { cwd: workspace.repoDir, encoding: "utf8", env: workspace.env, input: '{"guild_id":"123"}', windowsHide: true });
  assert.equal(jq.status, 0, jq.stderr);
  assert.equal(jq.stdout, "123\n");

  const sleep = spawnSync("sleep", ["30"], { cwd: workspace.repoDir, encoding: "utf8", env: workspace.env, timeout: 15000, windowsHide: true });
  assert.equal(sleep.status, 0, sleep.stderr);

  const wrapper = "python3"; // The fixture, found through the workspace PATH.
  const python = spawnSync(wrapper, ["-c", "import sys; print(sys.version_info[0])"], { cwd: workspace.repoDir, encoding: "utf8", env: workspace.env, windowsHide: true });
  assert.equal(python.status, 0, python.stderr);
  assert.equal(python.stdout.trim(), "3");
});

test("the launcher is compiled once per content hash and the next run reuses the cache", WINDOWS_ONLY, () => {
  const emptyTemp = fs.mkdtempSync(path.join(os.tmpdir(), "ccdm-launcher-cache-"));
  registerTeardownCallback(() => fs.rmSync(emptyTemp, { force: true, recursive: true }));
  const platformUrl = new URL("./support/platform.js", import.meta.url).href;
  const script = `import { fixtureLauncher } from ${JSON.stringify(platformUrl)}; console.log(fixtureLauncher());`;
  const run = (extraEnv = {}) => spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    env: { ...process.env, ...extraEnv, TEMP: emptyTemp, TMP: emptyTemp, TMPDIR: emptyTemp },
    windowsHide: true,
  });

  const first = run();
  assert.equal(first.status, 0, first.stderr);
  const exe = first.stdout.trim();
  assert.ok(exe.startsWith(emptyTemp), exe);
  const built = fs.statSync(exe).mtimeMs;

  // With no compiler to call, only the cache can answer.
  const second = run({ CCDM_E2E_CSC: path.join(emptyTemp, "missing-csc.exe") });
  assert.equal(second.status, 0, second.stderr);
  assert.equal(second.stdout.trim(), exe);
  assert.equal(fs.statSync(exe).mtimeMs, built);
});

test("a missing csc.exe fails the build with a clear message and leaves nothing behind", WINDOWS_ONLY, () => {
  const { afterCleanup, beforeCleanup, message } = createWorkspaceInEmptyTemp({}, { CCDM_E2E_CSC: "Z:\\no\\csc.exe" });

  assert.match(message, /csc\.exe/);
  assert.deepEqual(beforeCleanup.filter((name) => name.includes(".staging-")), []);
  assert.deepEqual(afterCleanup, []);
});

test("npm test stops before any file runs when csc.exe is missing", WINDOWS_ONLY, () => {
  const emptyTemp = fs.mkdtempSync(path.join(os.tmpdir(), "ccdm-no-csc-"));
  registerTeardownCallback(() => fs.rmSync(emptyTemp, { force: true, recursive: true }));
  const runner = fileURLToPath(new URL("../run-e2e.mjs", import.meta.url));
  const probe = fileURLToPath(new URL("../fixtures/runner/pass.test.js", import.meta.url));
  const started = Date.now();

  const result = spawnSync(process.execPath, [runner, probe], {
    cwd: path.dirname(path.dirname(path.dirname(runner))),
    encoding: "utf8",
    env: { ...process.env, CCDM_E2E_CSC: "Z:\\no\\csc.exe", TEMP: emptyTemp, TMP: emptyTemp, TMPDIR: emptyTemp },
    windowsHide: true,
  });

  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /E2E run cannot start.*csc\.exe/s);
  assert.doesNotMatch(result.stdout, /pass\.test\.js/);
  assert.ok(Date.now() - started < 30000);
});

async function waitForFile(file, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(file) || fs.readFileSync(file, "utf8") === "") {
    assert.ok(Date.now() < deadline, `${file} never appeared`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return fs.readFileSync(file, "utf8");
}

// A script that starts a detached grandchild, writes "<own pid> <grandchild pid>"
// to `pids`, then exits or stays.
function treeScript(dir, pids, { stay }) {
  const script = path.join(dir, "tree.js");
  fs.writeFileSync(script, [
    'const { spawn } = require("node:child_process");',
    'const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore", windowsHide: true });',
    "grandchild.unref();",
    `require("node:fs").writeFileSync(${JSON.stringify(pids)}, process.pid + " " + grandchild.pid);`,
    stay ? "setInterval(() => {}, 1000);" : "process.exit(0);",
    "",
  ].join("\n"));
  return script;
}

// A script that reports it is ready and then answers Ctrl+Break as told.
function breakScript(dir, ready, onBreak) {
  const script = path.join(dir, "break.js");
  fs.writeFileSync(script, [
    'const fs = require("node:fs");',
    `process.on("SIGBREAK", () => { ${onBreak} });`,
    `fs.writeFileSync(${JSON.stringify(ready)}, String(process.pid));`,
    "setInterval(() => {}, 1000);",
    "",
  ].join("\n"));
  return script;
}

test("a detached grandchild that outlives its fixture tool is gone after teardown", WINDOWS_ONLY, async () => {
  const workspace = probeWorkspace();
  const pids = path.join(workspace.tmpDir, "pids");
  const tool = launcherPair(workspace.fixtureDir, "leaver", [process.execPath, treeScript(workspace.tmpDir, pids, { stay: false })]);

  const result = spawnSync(tool, [], { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  const grandchild = Number((await waitForFile(pids)).split(" ")[1]);
  assert.equal(processAlive(grandchild), true, "the grandchild should outlive the tool until teardown");

  await cleanup();

  await waitUntilGone(grandchild);
});

test("an idle fake codex app-server whose starter has gone is stopped at teardown", WINDOWS_ONLY, async () => {
  const workspace = createWorkspace();
  const port = "45871";
  const state = readState(workspace.stateDir);
  state.fixtures.codex.servers[port] = { outliveBridge: true, ready: true };
  writeState(state, workspace.stateDir);
  const starter = path.join(workspace.tmpDir, "starter.js");
  fs.writeFileSync(starter, [
    'const { spawn } = require("node:child_process");',
    `spawn(${JSON.stringify(path.join(workspace.fixtureDir, "codex.exe"))}, ["app-server", "--listen", "ws://127.0.0.1:${port}"], { detached: true, stdio: "ignore", windowsHide: true }).unref();`,
    "",
  ].join("\n"));

  assert.equal(spawnSync(process.execPath, [starter], { env: workspace.env, windowsHide: true }).status, 0);
  const deadline = Date.now() + 20000;
  let server;
  while (!server && Date.now() < deadline) {
    server = readState(workspace.stateDir).fixtures.codex.appServerInvocations[0]?.pid;
    if (!server) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(server, "the fake app-server never recorded itself");
  assert.equal(processAlive(server), true);

  await cleanup();

  await waitUntilGone(server);
  assert.equal(fs.existsSync(workspace.tmpRoot), false, "a running launcher would hold the workspace open");
});

test("the launcher forwards Ctrl+Break, and a child that handles it exits cleanly with its own code", WINDOWS_ONLY, async () => {
  const workspace = probeWorkspace();
  const ready = path.join(workspace.tmpDir, "ready");
  const handled = path.join(workspace.tmpDir, "handled");
  const script = breakScript(workspace.tmpDir, ready, `fs.writeFileSync(${JSON.stringify(handled)}, "yes"); process.exit(5);`);
  const launcher = spawnWithCtrlBreak(launcherPair(workspace.fixtureDir, "polite", [process.execPath, script]), []);
  const exited = new Promise((resolve) => launcher.once("exit", resolve));
  const child = Number(await waitForFile(ready));

  const started = Date.now();
  sendCtrlBreak(launcher);
  const code = await exited;

  assert.equal(code, 5);
  assert.equal(fs.readFileSync(handled, "utf8"), "yes");
  assert.ok(Date.now() - started < 1900, "the child should not have used the whole grace period");
  await waitUntilGone(child);
});

test("a child that ignores Ctrl+Break is killed when the grace period ends", WINDOWS_ONLY, async () => {
  const workspace = probeWorkspace();
  const ready = path.join(workspace.tmpDir, "ready");
  const script = breakScript(workspace.tmpDir, ready, "/* ignored */");
  const launcher = spawnWithCtrlBreak(launcherPair(workspace.fixtureDir, "stubborn", [process.execPath, script]), []);
  const exited = new Promise((resolve) => launcher.once("exit", resolve));
  const child = Number(await waitForFile(ready));

  const started = Date.now();
  sendCtrlBreak(launcher);
  const code = await exited;

  assert.equal(code, 1);
  assert.ok(Date.now() - started >= 1800, "the child got less than the grace period");
  await waitUntilGone(child);
});

test("teardown gives Ctrl+Break to the child of a launcher that has no console", WINDOWS_ONLY, async () => {
  const workspace = probeWorkspace();
  // Outside the workspace, which teardown removes.
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ccdm-harness-break-"));
  try {
    const ready = path.join(outside, "ready");
    const handled = path.join(outside, "handled");
    const script = breakScript(outside, ready, `fs.writeFileSync(${JSON.stringify(handled)}, "yes"); process.exit(0);`);
    const launcher = spawn(launcherPair(workspace.fixtureDir, "detached", [process.execPath, script]), [], {
      detached: true, stdio: "ignore", windowsHide: true,
    });
    const child = Number(await waitForFile(ready));

    await cleanup();

    assert.equal(fs.readFileSync(handled, "utf8"), "yes");
    await waitUntilGone(child);
    await waitUntilGone(launcher.pid);
  } finally {
    fs.rmSync(outside, { force: true, recursive: true });
  }
});

test("killing the launcher directly kills its whole tree", WINDOWS_ONLY, async () => {
  const workspace = probeWorkspace();
  const pids = path.join(workspace.tmpDir, "pids");
  // In tmpDir there is no .job file: only the launcher's own job can end this tree.
  const tool = launcherPair(workspace.tmpDir, "stayer", [process.execPath, treeScript(workspace.tmpDir, pids, { stay: true })]);
  const launcher = spawn(tool, [], { stdio: "ignore", windowsHide: true });
  const [child, grandchild] = (await waitForFile(pids)).split(" ").map(Number);
  assert.equal(processAlive(grandchild), true);

  launcher.kill();

  await waitUntilGone(child);
  await waitUntilGone(grandchild);
});

test("job teardown leaves a live process alone even when its PID is planted in fixture state", WINDOWS_ONLY, async () => {
  const workspace = probeWorkspace();
  const pids = path.join(workspace.tmpDir, "pids");
  const tool = launcherPair(workspace.fixtureDir, "leaver", [process.execPath, treeScript(workspace.tmpDir, pids, { stay: false })]);
  assert.equal(spawnSync(tool, [], { windowsHide: true }).status, 0);
  const grandchild = Number((await waitForFile(pids)).split(" ")[1]);
  const sentinel = startSleeper();
  try {
    seedOwnedRow(workspace, sentinel.pid);

    await cleanup();

    await waitUntilGone(grandchild);
    assert.equal(processAlive(sentinel.pid), true);
    assert.ok(teardownSkips().some((skip) => skip.pid === sentinel.pid && skip.marker === workspace.tmpRoot));
  } finally {
    sentinel.kill();
  }
});

test("the launcher and workspace job work when the test runner is already inside a job", WINDOWS_ONLY, async () => {
  const support = (file) => JSON.stringify(new URL(`./support/${file}`, import.meta.url).href);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ccdm-harness-nested-"));
  try {
    const script = path.join(scratch, "nested.mjs");
    fs.writeFileSync(script, [
      'import { spawnSync } from "node:child_process";',
      'import fs from "node:fs";',
      'import path from "node:path";',
      `import { fixtureLauncher } from ${support("platform.js")};`,
      `import { createWorkspace } from ${support("runner.js")};`,
      `import { cleanup } from ${support("teardown.js")};`,
      'const workspace = createWorkspace({ excludeFixtures: ["sleep"] });',
      'const pids = path.join(workspace.tmpDir, "pids");',
      'const tree = path.join(workspace.tmpDir, "tree.js");',
      `fs.writeFileSync(tree, ${JSON.stringify(fs.readFileSync(treeScript(scratch, "PIDS", { stay: false }), "utf8"))}.replace('"PIDS"', JSON.stringify(pids)));`,
      'const exe = path.join(workspace.fixtureDir, "leaver.exe");',
      "fs.copyFileSync(fixtureLauncher(), exe);",
      'fs.writeFileSync(path.join(workspace.fixtureDir, "leaver.shim"), process.execPath + "\\n" + tree + "\\n");',
      'const started = spawnSync(exe, [], { encoding: "utf8", windowsHide: true });',
      'const grandchild = Number(fs.readFileSync(pids, "utf8").split(" ")[1]);',
      "const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };",
      "const aliveBefore = alive(grandchild);",
      "await cleanup();",
      "const deadline = Date.now() + 20000;",
      "while (alive(grandchild) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));",
      "process.stdout.write(JSON.stringify({ aliveBefore, goneAfter: !alive(grandchild), status: started.status, stderr: started.stderr }));",
      "process.exit(0);",
      "",
    ].join("\n"));

    // ctrl-break.exe runs its program inside a job, so everything in nested.mjs starts inside one.
    const runner = spawnWithCtrlBreak(process.execPath, [script]);
    let stdout = "";
    let stderr = "";
    runner.stdout.on("data", (chunk) => { stdout += chunk; });
    runner.stderr.on("data", (chunk) => { stderr += chunk; });
    const code = await new Promise((resolve) => runner.once("exit", resolve));

    assert.equal(code, 0, stderr);
    assert.deepEqual(JSON.parse(stdout), { aliveBefore: true, goneAfter: true, status: 0, stderr: "" });
  } finally {
    fs.rmSync(scratch, { force: true, recursive: true });
  }
});

test("teardown callbacks run in LIFO order and cleanup failures are diagnostic records", async () => {
  const workspace = createWorkspace();
  const calls = [];

  registerTeardownCallback(() => {
    calls.push("first");
  });
  registerTeardownCallback(() => {
    calls.push("second");
    throw new Error("cleanup-token-failure");
  });

  await cleanup({ stateDir: workspace.stateDir });

  assert.deepEqual(calls, ["second", "first"]);
  assert.match(
    JSON.stringify(readState(workspace.stateDir).diagnostics.cleanupFailures),
    /cleanup-token-failure/,
  );
});

test("failure diagnostics include command details and redact secrets", async () => {
  const workspace = createWorkspace({ excludeFixtures: ["claude"] });

  const result = await runScript(workspace, "setup.sh", {
    env: {
      AUTHORIZATION: "Bot aaaaaaaaaaaaaaaaaaaaaaaa.BBBBBB.cccccccccccccccccccc",
      DISCORD_BOT_TOKEN: "fixture-token-value",
      OAUTH_TOKEN: "sk-ant-x",
    },
  });

  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.diagnostics.command, [path.join(workspace.repoDir, "setup.sh")]);
  assert.match(result.diagnostics.stdout, /Missing required tools/);
  assert.equal(result.diagnostics.env.AUTHORIZATION, "[REDACTED]");
  assert.equal(result.diagnostics.env.DISCORD_BOT_TOKEN, "[REDACTED]");
  assert.equal(result.diagnostics.env.OAUTH_TOKEN, "[REDACTED]");
  assert.doesNotMatch(JSON.stringify(result.diagnostics), /aaaaaaaaaaaaaaaaaaaaaaaa\.BBBBBB/);

  const redactedBody = redactSecrets({
    commandLine: "curl -H 'Authorization: Bot aaaaaaaaaaaaaaaaaaaaaaaa.BBBBBB.cccccccccccccccccccc'",
    dotenv: "DISCORD_BOT_TOKEN=sk-ant-x",
    requestBody: "Authorization: Bot aaaaaaaaaaaaaaaaaaaaaaaa.BBBBBB.cccccccccccccccccccc",
    registry: { token: "ghp_x" },
  });
  assert.doesNotMatch(JSON.stringify(redactedBody), /ghp_|sk-ant-|Authorization: Bot [A-Za-z0-9_.-]+/);
});

test("a node:test file run directly reports TAP when the reporter comes through NODE_OPTIONS", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccdm-reporter-"));
  try {
    const file = path.join(dir, "probe.test.mjs");
    fs.writeFileSync(file, 'import test from "node:test";\ntest("reporter probe", () => {});\n');
    // Without NODE_TEST_CONTEXT, which this file's own run sets.
    const { NODE_TEST_CONTEXT, ...env } = process.env;
    const child = spawn(process.execPath, [file], {
      env: { ...env, NODE_OPTIONS: "--test-reporter=tap" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    const exitCode = await new Promise((resolve) => child.on("close", resolve));

    assert.equal(exitCode, 0, stdout);
    assert.match(stdout, /^TAP version \d+$/m);
    assert.match(stdout, /^ok 1 - reporter probe$/m);
    assert.match(stdout, /^# pass 1$/m);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the Router live smoke test is skipped and touches nothing without the Live Gate", async () => {
  const workspace = createBridgeWorkspace();
  const fixturesBefore = readState(workspace.stateDir).fixtures;

  // Live secrets alone do not open the gate; the preload fails closed on any egress.
  // A flag after the script is a script argument, so the reporter goes through
  // NODE_OPTIONS (Node 23+ defaults to the spec reporter).
  const result = await runNodeEntrypoint(workspace, "tests/e2e/live-smoke.test.js", {
    env: bridgeChildEnv(workspace, {
      CCDM_LIVE_DISCORD_BOT_TOKEN: "placeholder-live-token",
      CCDM_LIVE_DISCORD_CHANNEL_ID: "placeholder-channel",
      CCDM_LIVE_DISCORD_USER_ID: "placeholder-owner",
      NODE_OPTIONS: `${bridgeChildEnv(workspace).NODE_OPTIONS} --test-reporter=tap`,
    }),
    timeoutMs: 20000,
  });

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.deepEqual(result.command, [process.execPath, path.join(workspace.repoDir, "tests/e2e/live-smoke.test.js")]);
  assert.equal(result.env.NODE_OPTIONS,
    `--require ${path.join(workspace.repoDir, "tests/e2e/support/preload.cjs")} --test-reporter=tap`);
  assert.match(result.stdout, /^ok 1 - live Router smoke: Claude and Codex round trips, webhook provenance, root mention, and cleanup # SKIP/m);
  assert.match(result.stdout, /^# skipped 1$/m);
  assert.match(result.stdout, /^# pass 0$/m);
  assert.deepEqual(readState(workspace.stateDir).fixtures, fixturesBefore);
  assert.deepEqual(fs.readdirSync(workspace.tmpDir), []);
});
