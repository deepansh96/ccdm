// Root's `ccdm` subcommands: list, status, session, context report, reminders.
// Every front runs on Linux and macOS; Windows has no tmux, so only the fake host there.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { gitBashTool, platformGate, PYTHON } from "./support/platform.js";
import { createWorkspace, runScript, scaledTimeout } from "./support/runner.js";
import { hostOps, startFakeHost, tmuxCalls } from "./support/session-fixture.js";
import { readState, seedRegistry, seedTmuxSession, updateState } from "./support/state.js";
import { cleanup, registerTeardownCallback } from "./support/teardown.js";

const WIN = process.platform === "win32";
const FRONTS = WIN ? ["fake host"] : ["tmux", "fake host"];
const onlyWindows = platformGate("win32", "ccdm-host under ConPTY and Git Bash exist only on Windows");
const CONTEXT_TIMEOUT = { CCDM_SESSION_CONTEXT_TIMEOUT_MS: "300" };

test.afterEach(cleanup);

// Python's print ends a line with CRLF on Windows.
const unix = text => text.replaceAll("\r\n", "\n");

const projects = workspace => ({
  alpha: { path: workspace.repoDir, screen_name: "alpha_s", channel_id: "c-a", type: "claude", pid: 4242, session_id: "sess-alpha" },
  beta: { path: workspace.repoDir, screen_name: "beta_s", channel_id: "c-b", type: "codex", pid: 777, session_id: "sess-beta" },
  gamma: { path: workspace.repoDir, screen_name: "gamma_s", channel_id: "c-g", pid: null, session_id: null },
  remote: { path: "remote:vm", screen_name: "remote_s", channel_id: "c-r", type: "claude", pid: null, session_id: null },
});

async function world(front, { extraProjects = {} } = {}) {
  const workspace = createWorkspace();
  const registry = { discord_user_id: "owner", projects: { ...projects(workspace), ...extraProjects } };
  seedRegistry(workspace, registry);
  const env = front === "tmux" ? { CCDM_SESSION_HOST: "tmux" } : (await startFakeHost(workspace)).env;
  const ccdm = async (args, options = {}) => {
    const result = await runScript(workspace, "scripts/ccdm", {
      args, timeoutMs: 20000, ...options, env: { ...env, ...options.env },
    });
    return { ...result, stdout: unix(result.stdout), stderr: unix(result.stderr) };
  };
  const seed = (name, session = {}) => seedTmuxSession(name, {
    paneOutput: "idle\n", ...(front === "fake host" ? { pid: process.pid, job: [], kind: "project" } : {}), ...session,
  }, { stateDir: workspace.stateDir });
  const session = name => readState(workspace.stateDir).fixtures.tmux.sessions[name];
  return { workspace, env, ccdm, seed, session };
}

function assertOk(result) {
  assert.equal(result.exitCode, 0, `${result.stderr}\n${result.stdout}`);
}

function assertFailed(result, pattern) {
  assert.equal(result.exitCode, 1, `${result.stderr}\n${result.stdout}`);
  assert.match(result.stderr, /^ccdm: /m);
  assert.match(result.stderr, pattern);
}

async function until(predicate, what, timeoutMs = 15000) {
  const deadline = Date.now() + scaledTimeout(timeoutMs);
  for (;;) {
    const value = await predicate();
    if (value) return value;
    assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

test("ccdm --help lists root's subcommands", async () => {
  const { ccdm } = await world(FRONTS[0]);
  const help = await ccdm(["--help"]);
  assertOk(help);
  for (const name of ["list", "status", "session", "context", "reminders"]) {
    assert.match(help.stdout, new RegExp(`^\\s+${name}\\s`, "m"), `${name} is missing from --help`);
  }
  assert.doesNotMatch(help.stderr, /skipping subcommand/);
});

for (const front of FRONTS) {
  test(`${front}: list and status join the registry with the backend's liveness`, async () => {
    const { ccdm, seed } = await world(front);
    seed("alpha_s");
    seed("gamma_s");

    const list = await ccdm(["list"]);
    assertOk(list);
    assert.deepEqual(list.stdout.trimEnd().split("\n"), [
      "alpha\tclaude\talpha_s\tlive\t4242",
      "beta\tcodex\tbeta_s\tstopped\t-",
      "gamma\tclaude\tgamma_s\tlive\t-",
      "remote\tclaude\tremote_s\tstopped\t-",
    ]);

    const json = await ccdm(["list", "--json"]);
    assertOk(json);
    assert.deepEqual(JSON.parse(json.stdout), [
      { project: "alpha", type: "claude", screen_name: "alpha_s", state: "live", pid: 4242 },
      { project: "beta", type: "codex", screen_name: "beta_s", state: "stopped", pid: null },
      { project: "gamma", type: "claude", screen_name: "gamma_s", state: "live", pid: null },
      { project: "remote", type: "claude", screen_name: "remote_s", state: "stopped", pid: null },
    ]);

    const status = await ccdm(["status"]);
    assertOk(status);
    assert.equal(status.stdout.split("\n")[0], "alpha\tclaude\talpha_s\tlive\t4242\tsess-alpha");
    assert.equal(status.stdout.split("\n")[1], "beta\tcodex\tbeta_s\tstopped\t-\tsess-beta");

    const one = await ccdm(["status", "alpha", "--json"]);
    assertOk(one);
    assert.deepEqual(JSON.parse(one.stdout), [
      { project: "alpha", type: "claude", screen_name: "alpha_s", state: "live", pid: 4242, session_id: "sess-alpha" },
    ]);

    assertFailed(await ccdm(["status", "nope"]), /unknown project: nope/);
  });

  test(`${front}: session new, capture, send and kill drive an ad-hoc session`, async () => {
    const { workspace, ccdm, session } = await world(front);
    const cwd = path.join(workspace.tmpRoot, "login place");
    fs.mkdirSync(cwd);

    const started = await ccdm(["session", "new", "login_s", "--cwd", cwd, "--env", "CODEX_HOME=/homes/a b", "--", "fixture-login", "--device-auth", "x y"]);
    assertOk(started);
    assert.match(started.stdout, /Started session 'login_s'/);

    const launch = readState(workspace.stateDir).fixtures.sessionHost.launches.at(-1);
    assert.equal(launch.name, "login_s");
    if (front === "fake host") assert.equal(launch.kind, "adhoc");
    assert.deepEqual(launch.argv, ["fixture-login", "--device-auth", "x y"]);
    assert.equal(launch.cwd, cwd);
    assert.equal(launch.env.CODEX_HOME, "/homes/a b");
    assert.equal(launch.env.CCDM_SESSION_NAME, "login_s");

    updateState(workspace.stateDir, (state) => {
      state.fixtures.tmux.sessions.login_s.paneOutput = "Open https://example.test/device\n";
      return state;
    });
    const captured = await ccdm(["session", "capture", "login_s"]);
    assertOk(captured);
    assert.equal(captured.stdout, "Open https://example.test/device\n");

    assertOk(await ccdm(["session", "send", "login_s", "--literal", "code-123", "--enter"]));
    assert.deepEqual(session("login_s").sendKeys, [["-l", "code-123"], ["Enter"]]);

    const killed = await ccdm(["session", "kill", "login_s"]);
    assertOk(killed);
    assert.equal(session("login_s"), undefined);
    assertFailed(await ccdm(["session", "capture", "login_s"]), /session 'login_s' is not running/);
    assertFailed(await ccdm(["session", "kill", "login_s"]), /no session named 'login_s'/);
  });

  test(`${front}: session new takes a program's own flags and refuses a missing program or directory`, async () => {
    const { workspace, ccdm } = await world(front);
    const noProgram = await ccdm(["session", "new", "x"]);
    assert.equal(noProgram.exitCode, 2);
    assert.match(noProgram.stderr, /after --/);
    assertFailed(await ccdm(["session", "new", "x", "--cwd", path.join(workspace.tmpRoot, "absent"), "--", "fixture"]), /no such directory/);
    const help = await ccdm(["session", "new", "--help"]);
    assertOk(help);
    assert.match(help.stdout, /--cwd/);
  });

  test(`${front}: session capture passes --join and --history to the backend`, async () => {
    const { workspace, ccdm, seed } = await world(front);
    seed("wide_s", { paneOutput: "screen\n" });
    assertOk(await ccdm(["session", "capture", "wide_s", "--join", "--history"]));
    if (front === "tmux") {
      const call = tmuxCalls(workspace).find(args => args[0] === "capture-pane");
      assert.ok(call.includes("-J"), call.join(" "));
      assert.deepEqual(call.slice(call.indexOf("-S"), call.indexOf("-S") + 2), ["-S", "-"]);
    } else {
      const frame = hostOps(workspace).find(op => op.op === "capture");
      assert.equal(frame.join, true);
      assert.equal(frame.history, true);
    }
    assertOk(await ccdm(["session", "capture", "wide_s"]));
    if (front === "tmux") {
      assert.ok(!tmuxCalls(workspace).filter(args => args[0] === "capture-pane").at(-1).includes("-J"));
    } else {
      assert.equal(hostOps(workspace).filter(op => op.op === "capture").at(-1).join, false);
    }
  });

  test(`${front}: session send has stdin and file routes that carry shell metacharacters`, async () => {
    const { workspace, ccdm, seed, session } = await world(front);
    seed("typed_s");
    const free = `a & b | "c" %X% é ^`;

    assertOk(await ccdm(["session", "send", "typed_s", "--stdin", "--enter"], { input: `${free}\n` }));
    assert.deepEqual(session("typed_s").sendKeys, [["-l", free], ["Enter"]]);

    const file = path.join(workspace.tmpRoot, "text.txt");
    fs.writeFileSync(file, `﻿${free}\r\n`);
    seed("filed_s");
    assertOk(await ccdm(["session", "send", "filed_s", "--file", file]));
    assert.deepEqual(session("filed_s").sendKeys, [["-l", free]]);

    assertFailed(await ccdm(["session", "send", "filed_s", "--file", path.join(workspace.tmpRoot, "absent")]), /could not read/);
  });

  test(`${front}: session send without --literal presses a key, and text starting with - stays text`, async () => {
    const { ccdm, seed, session } = await world(front);
    seed("keys_s");
    assertOk(await ccdm(["session", "send", "keys_s", "C-c"]));
    assertOk(await ccdm(["session", "send", "keys_s", "--enter"]));
    assertOk(await ccdm(["session", "send", "keys_s", "--literal", "Enter"]));
    assertOk(await ccdm(["session", "send", "keys_s", "--enter", "--", "-dash"]));
    assert.deepEqual(session("keys_s").sendKeys.map(keys => keys.filter(key => key !== "--")), [
      ["C-c"], ["Enter"], ["-l", "Enter"], ["-l", "-dash"], ["Enter"],
    ]);
  });

  test(`${front}: session send refuses a session that is not running and bad usage, typing nothing`, async () => {
    const { ccdm, session } = await world(front);
    assertFailed(await ccdm(["session", "send", "ghost_s", "--literal", "x", "--enter"]), /session 'ghost_s' is not running/);
    assert.equal(session("ghost_s"), undefined);
    for (const args of [["ghost_s", "--bad"], ["ghost_s", "a", "b"], ["ghost_s"], ["ghost_s", "a", "--stdin"]]) {
      const result = await ccdm(["session", "send", ...args]);
      assert.equal(result.exitCode, 2, args.join(" "));
      assert.match(result.stderr, /usage: ccdm session send/);
    }
  });

  test(`${front}: session kill on the caller's own session hands off and still ends it`, async () => {
    const { ccdm, seed, session } = await world(front);
    seed("own_s");
    const result = await ccdm(["session", "kill", "own_s"], { env: { CCDM_SESSION_NAME: "own_s" } });
    assertOk(result);
    assert.match(result.stdout, /continues in a detached process/);
    await until(() => session("own_s") === undefined, "the detached kill");
  });

  test(`${front}: session context prints the context screen`, async () => {
    const { workspace, ccdm, seed, session } = await world(front);
    updateState(workspace.stateDir, (state) => { state.fixtures.claude.contextScreen = true; return state; });
    seed("ctx_s");
    const result = await ccdm(["session", "context", "ctx_s"]);
    assertOk(result);
    assert.match(result.stdout, /Context Usage/);
    assert.match(result.stdout, /45k\/200k tokens \(22%\)/);
    assert.deepEqual(session("ctx_s").sendKeys, [["-l", "/context"], ["Enter"]]);
  });

  test(`${front}: session context fails when no context screen comes`, async () => {
    const { ccdm, seed } = await world(front);
    seed("idle_s");
    assertFailed(await ccdm(["session", "context", "idle_s"], { env: CONTEXT_TIMEOUT }), /did not show its context/);
    assertFailed(await ccdm(["session", "context", "ghost_s"], { env: CONTEXT_TIMEOUT }), /not running/);
  });

  test(`${front}: context report prints every live Claude session and skips Codex, stopped and remote ones`, async () => {
    const { workspace, ccdm, seed, session } = await world(front);
    updateState(workspace.stateDir, (state) => { state.fixtures.claude.contextScreen = true; return state; });
    seed("alpha_s");
    seed("beta_s");
    seed("gamma_s");
    seed("remote_s");
    const result = await ccdm(["context", "report"]);
    assertOk(result);
    assert.match(result.stdout, /=== alpha \(alpha_s\) ===\nContext Usage/);
    assert.match(result.stdout, /=== gamma \(gamma_s\) ===\nContext Usage/);
    assert.doesNotMatch(result.stdout, /beta|remote/);
    assert.equal(session("beta_s").sendKeys, undefined);
    assert.equal(session("remote_s").sendKeys, undefined);
  });

  test(`${front}: context report carries on past a session that shows nothing and exits 1`, async () => {
    const { ccdm, seed } = await world(front, {
      extraProjects: { delta: { path: "/fixture/delta", screen_name: "delta_s", channel_id: "c-d", type: "claude" } },
    });
    // alpha's /context is typed but never answered; delta's grid is already there.
    seed("alpha_s");
    seed("delta_s", { paneOutput: "Context Usage\ndelta\n" });
    const result = await ccdm(["context", "report"], { env: CONTEXT_TIMEOUT });
    assert.equal(result.exitCode, 1, result.stderr);
    assert.match(result.stderr, /^ccdm: alpha: /m);
    assert.match(result.stdout, /=== delta \(delta_s\) ===\nContext Usage/);
  });

  test(`${front}: context report with nothing live says so and exits 0`, async () => {
    const { ccdm } = await world(front);
    const result = await ccdm(["context", "report"]);
    assertOk(result);
    assert.match(result.stdout, /No live Claude sessions\./);
  });
}

test("list says every project is stopped when no session host is running", onlyWindows, async () => {
  const workspace = createWorkspace();
  seedRegistry(workspace, { discord_user_id: "owner", projects: projects(workspace) });
  const result = await runScript(workspace, "scripts/ccdm", {
    args: ["list"], timeoutMs: 20000, env: { CCDM_STATE_ROOT: path.join(workspace.tmpRoot, "no-host"), CCDM_SESSION_HOST: "ccdm-host" },
  });
  assertOk(result);
  assert.match(unix(result.stdout), /^alpha\tclaude\talpha_s\tstopped\t-$/m);
  assert.match(result.stderr, /ccdm-host is not running/);
});

test("session verbs say so when no session host is running", onlyWindows, async () => {
  const workspace = createWorkspace();
  const result = await runScript(workspace, "scripts/ccdm", {
    args: ["session", "capture", "x"], timeoutMs: 20000, env: { CCDM_STATE_ROOT: path.join(workspace.tmpRoot, "no-host"), CCDM_SESSION_HOST: "ccdm-host" },
  });
  assertFailed(result, /ccdm-host is not running/);
});

test("reminders assignment-changed runs the script with the resolved Python and passes through its output and exit code", async () => {
  const { workspace, ccdm } = await world(FRONTS[0]);
  // No shebang and no execute bit: only a named interpreter can run it.
  const service = path.join(workspace.repoDir, "scripts", "conversation-reminder-service.py");
  // A workspace's executable may be a hard link to the checkout's: replace it, never write through it.
  fs.rmSync(service);
  fs.writeFileSync(service, [
    "import json, sys",
    "print(json.dumps({'argv': sys.argv[1:], 'python': sys.executable}))",
    "print('from the script on stderr', file=sys.stderr)",
    "sys.exit(7)",
    "",
  ].join("\n"));
  if (!WIN) fs.chmodSync(service, 0o644);

  // On POSIX a wrapper logs what it is asked to run; on Windows an override must be a real program.
  const env = { CCDM_PYTHON: PYTHON };
  let wrapperLog = null;
  if (!WIN) {
    wrapperLog = path.join(workspace.tmpRoot, "python-calls.log");
    const wrapper = path.join(workspace.tmpRoot, "fixture-python");
    fs.writeFileSync(wrapper, `#!/bin/sh\nprintf '%s\\n' "$1" >> '${wrapperLog}'\nexec '${PYTHON}' "$@"\n`, { mode: 0o755 });
    env.CCDM_PYTHON = wrapper;
  }

  const result = await ccdm(["reminders", "assignment-changed", "--project", "alpha"], { env });
  assert.equal(result.exitCode, 7, result.stderr);
  assert.match(result.stderr, /from the script on stderr/);
  const seen = JSON.parse(result.stdout.trim());
  assert.deepEqual(seen.argv, ["assignment-changed", "--project", "alpha"]);
  if (WIN) assert.equal(fs.realpathSync(seen.python).toLowerCase(), fs.realpathSync(PYTHON).toLowerCase());
  else assert.equal(fs.readFileSync(wrapperLog, "utf8").trim().split("\n").at(-1), fs.realpathSync(service));

  // The operator's other verbs reach the script as they are.
  for (const verb of ["preflight", "enable", "status", "run", "disable", "discover", "recover"]) {
    const plain = await ccdm(["reminders", verb], { env });
    assert.equal(plain.exitCode, 7, plain.stderr);
    assert.deepEqual(JSON.parse(plain.stdout.trim()).argv, [verb]);
  }
});

test("on Windows, the pinned RELAY_INSTRUCTIONS command types /foo and then Enter into the caller's own session", onlyWindows, async () => {
  const { workspace, env, seed, session } = await world("fake host");
  seed("own_session");
  const projectCwd = path.join(workspace.tmpRoot, "some project");
  fs.mkdirSync(projectCwd);
  const repo = fs.realpathSync(workspace.repoDir).replace(/\\/g, "/");
  // The sentence the channel server tells a session, with its placeholder filled.
  const pinned = `"${repo}/scripts/ccdm" session send "$CCDM_SESSION_NAME" --literal '/foo' --enter`;
  const result = await new Promise((resolve) => {
    execFile(gitBashTool("bash"), ["-c", pinned], {
      cwd: projectCwd, encoding: "utf8", windowsHide: true, timeout: scaledTimeout(30000),
      env: { ...workspace.env, ...env, CCDM_SESSION_NAME: "own_session" },
    }, (error, stdout, stderr) => resolve({ exitCode: error ? error.code : 0, stdout, stderr }));
  });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.deepEqual(session("own_session").sendKeys, [["-l", "/foo"], ["Enter"]]);
});

test("on Windows, session new finds claude through the resolver, not the host's PATH search", onlyWindows, async () => {
  const { workspace, env, ccdm } = await world("fake host");
  const bin = path.join(workspace.homeDir, ".local", "bin");
  fs.mkdirSync(bin, { recursive: true });
  const claude = path.join(bin, "claude.exe");
  fs.copyFileSync(process.execPath, claude);
  const result = await ccdm(["session", "new", "login_s", "--", "claude", "auth", "login"], { env });
  assertOk(result);
  const launch = readState(workspace.stateDir).fixtures.sessionHost.launches.at(-1);
  assert.equal(launch.kind, "adhoc");
  assert.deepEqual(launch.argv.slice(1), ["auth", "login"]);
  assert.equal(path.basename(launch.argv[0]).toLowerCase(), "claude.exe");
});

// ---- the real host under ConPTY ----

async function realHost(workspace) {
  const stateRoot = path.join(workspace.tmpRoot, "ccdm-state");
  const hostEnv = { ...workspace.env, CCDM_STATE_ROOT: stateRoot };
  const script = path.join(workspace.repoDir, "scripts", "ccdm-host.js");
  const child = spawn(process.execPath, [script, "serve", "--allow-in-job"], {
    cwd: workspace.repoDir, env: hostEnv, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  let output = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { output += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { output += chunk; });
  const closed = new Promise(resolve => child.once("close", resolve));
  registerTeardownCallback(async () => {
    await new Promise((resolve) => {
      execFile(process.execPath, [script, "shutdown"], { env: hostEnv, windowsHide: true, timeout: 15000 }, () => resolve());
    });
    await Promise.race([closed, new Promise(resolve => setTimeout(resolve, 5000))]);
    if (child.exitCode === null) child.kill();
  });
  await until(() => /ready/.test(output) || child.exitCode !== null, `the host to be ready: ${output}`);
  assert.match(output, /ready/, output);
  return { CCDM_STATE_ROOT: stateRoot, CCDM_SESSION_HOST: "ccdm-host" };
}

test("on Windows, session capture --join returns a 300-character URL from a 200-column session on one line", onlyWindows, async () => {
  const workspace = createWorkspace();
  const env = await realHost(workspace);
  const ccdm = async (args) => {
    const result = await runScript(workspace, "scripts/ccdm", { args, env, timeoutMs: 30000 });
    return { ...result, stdout: unix(result.stdout), stderr: unix(result.stderr) };
  };
  const url = `https://example.test/${"a".repeat(300 - "https://example.test/".length - 3)}END`;
  assert.equal(url.length, 300);
  const printer = `process.stdout.write(${JSON.stringify(`${url}\n`)}); setTimeout(() => {}, 60000);`;
  assertOk(await ccdm(["session", "new", "wide_s", "--cwd", workspace.tmpRoot, "--", process.execPath, "-e", printer]));

  const joined = await until(async () => {
    const result = await ccdm(["session", "capture", "wide_s", "--join"]);
    return result.exitCode === 0 && result.stdout.includes("END") ? result : null;
  }, "the URL to reach the screen", 30000);
  assert.ok(joined.stdout.split("\n").includes(url), joined.stdout);

  const plain = await ccdm(["session", "capture", "wide_s"]);
  assertOk(plain);
  assert.ok(!plain.stdout.split("\n").includes(url), "without --join the URL should be wrapped at 200 columns");
  assert.equal(plain.stdout.split("\n").find(line => line.startsWith("https:")).length, 200);

  assertOk(await ccdm(["session", "kill", "wide_s"]));
  assertFailed(await ccdm(["session", "capture", "wide_s"]), /not running/);
});

test("on Windows, an ended host session counts as not running for capture and send", onlyWindows, async () => {
  const workspace = createWorkspace();
  const env = await realHost(workspace);
  const ccdm = args => runScript(workspace, "scripts/ccdm", { args, env, timeoutMs: 30000 });
  assertOk(await ccdm(["session", "new", "brief_s", "--cwd", workspace.tmpRoot, "--", process.execPath, "-e", "console.log('done')"]));
  await until(async () => {
    const result = await ccdm(["session", "capture", "brief_s"]);
    return result.exitCode === 1;
  }, "the session to end", 30000);
  assertFailed(await ccdm(["session", "capture", "brief_s"]), /session 'brief_s' is not running/);
  assertFailed(await ccdm(["session", "send", "brief_s", "--literal", "x"]), /session 'brief_s' is not running/);
});
