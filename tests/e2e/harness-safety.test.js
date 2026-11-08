import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { bridgeChildEnv, createBridgeWorkspace } from "./support/bridge.js";
import { assertFixtureExecutable, assertIsolatedPath, redactSecrets } from "./support/diagnostics.js";
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
import { cleanup, registerTeardownCallback } from "./support/teardown.js";

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

test("command runner injects isolated environment and allowlisted PATH", async () => {
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
    SystemRoot: "C:\\Windows",
    TEMP: dirs.tmpDir,
    TMP: dirs.tmpDir,
    TMPDIR: dirs.tmpDir,
    USERPROFILE: dirs.homeDir,
    windir: "C:\\Windows",
  });
});

test("the workspace env on POSIX is only the isolated six values", () => {
  const dirs = { fixtureDir: "/w/fixtures", homeDir: "/w/home", root: "/src", stateDir: "/w/state", tmpDir: "/w/tmp" };
  for (const platform of ["linux", "darwin"]) {
    assert.deepEqual(runnerInternals.workspaceEnv({ ...dirs, hostEnv: { SystemRoot: "unused" }, platform }), {
      CCDM_TEST_STATE: dirs.stateDir,
      HOME: dirs.homeDir,
      NODE_OPTIONS: "",
      NODE_PATH: path.join(dirs.root, "node_modules"),
      PATH: dirs.fixtureDir,
      TMPDIR: dirs.tmpDir,
    });
  }
});

// The workspace PATH holds only fixtures, so the host interpreter goes by absolute path.
function hostPythonPath() {
  const candidates = process.platform === "win32" ? [["py", "-3"], ["python"]] : [["python3"]];
  for (const [command, ...args] of candidates) {
    const probe = spawnSync(command, [...args, "-c", "import sys; print(sys.executable)"], { encoding: "utf8" });
    if (probe.status === 0 && probe.stdout.trim()) return probe.stdout.trim();
  }
  throw new Error("No host Python found");
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
