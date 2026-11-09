// The session-host seam, Node and Python: every verb on the fake ccdm-host and on
// the fake tmux, from a workspace child, as a launcher would call it.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";

import { PYTHON, platformGate } from "./support/platform.js";
import { createWorkspace, scaledTimeout } from "./support/runner.js";
import { callSeam, hostOps, sessionCalls, startFakeHost, tmuxCalls } from "./support/session-fixture.js";
import { readState, seedTmuxSession, updateState } from "./support/state.js";
import { cleanup, registerTeardownCallback } from "./support/teardown.js";

const NOT_RUNNING = /ccdm-host is not running/;
const LANGUAGES = ["node", "python"];
const ACTIVE_MS = 2000;
const onlyWindows = platformGate("win32", "named pipes, the server proof and ERROR_PIPE_BUSY exist only on Windows");
const require = createRequire(import.meta.url);

test.afterEach(cleanup);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const launches = workspace => readState(workspace.stateDir).fixtures.sessionHost?.launches ?? [];
const tmuxSessions = workspace => readState(workspace.stateDir).fixtures.tmux.sessions;

async function until(predicate, what, timeoutMs = 10000) {
  const deadline = Date.now() + scaledTimeout(timeoutMs);
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await sleep(25);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

// A workspace whose seam calls reach the fake host, or (with host: false) the fake tmux.
async function world(language, { host = true, badProof = false, extraEnv = {} } = {}) {
  const workspace = createWorkspace();
  const fake = host ? await startFakeHost(workspace, { badProof }) : null;
  const env = { ...(fake ? fake.env : { CCDM_SESSION_HOST: "tmux" }), ...extraEnv };
  const call = (verb, positional = [], options) => callSeam(workspace, language, verb, { positional, options, env, python: PYTHON });
  const ok = async (verb, positional, options) => {
    const result = await call(verb, positional, options);
    assert.equal(result.ok, true, `${verb}: ${JSON.stringify(result)}`);
    return result.value;
  };
  return { call, env, fake, ok, workspace };
}

const adhoc = workspace => ({ argv: ["some-program", "an arg", "it's quoted"], cwd: workspace.tmpDir, kind: "adhoc" });

// Sleepers carrying the workspace marker, so teardown and the fake `ps` accept them.
function sleeper(workspace) {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", workspace.tmpRoot], { stdio: "ignore", windowsHide: true });
  registerTeardownCallback(() => {
    child.kill();
  });
  return child.pid;
}

// A helper that records what it saw, then exits.
function helperScript(workspace) {
  const script = path.join(workspace.tmpRoot, "p3.2a-helper.cjs");
  fs.writeFileSync(script, `
const fs = require("node:fs");
const [marker, parentPid] = process.argv.slice(2);
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const timer = setInterval(() => {
  if (parentPid && alive(Number(parentPid))) return;
  clearInterval(timer);
  fs.writeFileSync(marker, JSON.stringify({ cwd: process.cwd(), env: process.env, argv: process.argv.slice(2) }));
}, 25);
`);
  return script;
}

for (const language of LANGUAGES) {
  test(`${language} fake host: start records argv, cwd, env, pty and kind without shell quoting, and names the session`, async () => {
    const { ok, workspace } = await world(language);
    const started = await ok("start", ["seam-a"], { ...adhoc(workspace), env: { CCDM_KEEP: "a value", CCDM_SESSION_NAME: "from-caller" }, pty: false });
    assert.equal(started.kind, "adhoc");
    const [record] = launches(workspace);
    assert.equal(record.front, "ccdm-host");
    assert.deepEqual(record.argv, ["some-program", "an arg", "it's quoted"]);
    assert.equal(record.cwd, workspace.tmpDir);
    assert.deepEqual(record.env, { CCDM_KEEP: "a value", CCDM_SESSION_NAME: "seam-a" });
    assert.equal(record.pty, false);
    assert.equal(record.kind, "adhoc");
  });

  test(`${language} fake host: start accepts each kind and list reports it`, async () => {
    const { ok, workspace } = await world(language);
    for (const kind of ["project", "thread", "root", "adhoc"]) {
      await ok("start", [`seam-${kind}`], { ...adhoc(workspace), kind, pty: false });
    }
    const listed = await ok("list");
    assert.deepEqual(listed.map(({ name, kind }) => [name, kind]).sort(),
      [["seam-adhoc", "adhoc"], ["seam-project", "project"], ["seam-root", "root"], ["seam-thread", "thread"]]);
  });

  test(`${language} fake host: an unknown kind and a duplicate name are refused`, async () => {
    const { call, ok, workspace } = await world(language);
    const badKind = await call("start", ["seam-b"], { ...adhoc(workspace), kind: "other" });
    assert.equal(badKind.ok, false);
    assert.match(badKind.message, /unknown session kind/);
    await ok("start", ["seam-b"], { ...adhoc(workspace), pty: false });
    const duplicate = await call("start", ["seam-b"], { ...adhoc(workspace), pty: false });
    assert.equal(duplicate.code, "duplicate_session");
  });

  test(`${language} fake host: isLive answers for a live and an absent session`, async () => {
    const { ok, workspace } = await world(language);
    await ok("start", ["seam-c"], { ...adhoc(workspace), pty: false });
    assert.equal(await ok("isLive", ["seam-c"]), true);
    assert.equal(await ok("isLive", ["seam-absent"]), false);
  });

  test(`${language} fake host: sendText is literal, sendKey is a key`, async () => {
    const { ok, workspace } = await world(language);
    await ok("start", ["seam-d"], { ...adhoc(workspace), pty: false });
    await ok("sendText", ["seam-d", "/compact now"]);
    await ok("sendKey", ["seam-d", "Enter"]);
    assert.deepEqual(tmuxSessions(workspace)["seam-d"].sendKeys, [["-l", "/compact now"], ["Enter"]]);
  });

  test(`${language} fake host: capture sends its history and join options and returns the screen`, async () => {
    const { call, ok, workspace } = await world(language);
    await ok("start", ["seam-e"], { ...adhoc(workspace), pty: false });
    updateState(workspace.stateDir, (state) => { state.fixtures.tmux.sessions["seam-e"].paneOutput = "screen ✓\n"; return state; });
    assert.equal(await ok("capture", ["seam-e"], { history: 200, join: true }), "screen ✓\n");
    assert.deepEqual(hostOps(workspace).filter(entry => entry.op === "capture").map(({ history, join }) => [history, join]), [[200, true]]);
    assert.equal((await call("capture", ["seam-absent"], {})).code, "unknown_session");
  });

  test(`${language} fake host: waitFor sends its keys when the screen matches, and a timeout says so`, async () => {
    const { ok, workspace } = await world(language);
    await ok("start", ["seam-f"], { ...adhoc(workspace), pty: false });
    updateState(workspace.stateDir, (state) => { state.fixtures.tmux.sessions["seam-f"].paneOutput = "Loading Development Channels\n"; return state; });
    const matched = await ok("waitFor", ["seam-f", { regexSource: "development channels?", flags: "i" }, 2000, ["Enter"]]);
    assert.equal(matched.matched, true);
    assert.match(matched.screen, /Development Channels/);
    assert.deepEqual(tmuxSessions(workspace)["seam-f"].sendKeys, [["Enter"]]);
    const missed = await ok("waitFor", ["seam-f", "never appears", 100, "Enter"]);
    assert.equal(missed.matched, false);
    assert.equal(tmuxSessions(workspace)["seam-f"].sendKeys.length, 1);
  });

  test(`${language} fake host: pids lists the session's Job, and stop empties it`, async () => {
    const { ok, workspace } = await world(language);
    const { pid } = await ok("start", ["seam-g"], { ...adhoc(workspace), pty: false });
    const members = await ok("pids", ["seam-g"]);
    assert.equal(members.length, 2);
    assert.ok(members.includes(pid));
    assert.deepEqual(await ok("stop", ["seam-g"], { graceMs: 50 }), { stopped: true });
    assert.equal(hostOps(workspace).find(entry => entry.op === "kill").graceMs, 50);
    assert.deepEqual(await ok("pids", ["seam-g"]), []);
    for (const member of members) {
      await until(() => { try { process.kill(member, 0); return false; } catch { return true; } }, `pid ${member} to end`);
    }
    assert.deepEqual(await ok("list"), []);
  });

  test(`${language} fake host: stop without graceMs is immediate, and an absent session is not an error`, async () => {
    const { ok, workspace } = await world(language);
    await ok("start", ["seam-h"], { ...adhoc(workspace), pty: false });
    assert.deepEqual(await ok("stop", ["seam-h"]), { stopped: true });
    assert.equal(hostOps(workspace).find(entry => entry.op === "kill").graceMs, 0);
    assert.deepEqual(await ok("stop", ["seam-h"]), { stopped: false });
  });

  test(`${language} fake host: attachHint names a command that attaches`, async () => {
    const { ok } = await world(language);
    assert.match(await ok("attachHint", ["seam-i", "demo"]), /^Attach with: .*seam-i$/);
  });

  test(`${language} fake host: runDetached passes cwd and env, never the session name, and the helper is outside every session`, async () => {
    const { ok, workspace } = await world(language, { extraEnv: { CCDM_SESSION_NAME: "the-caller" } });
    await ok("start", ["seam-j"], { ...adhoc(workspace), pty: false });
    const marker = path.join(workspace.tmpRoot, "helper-saw.json");
    const argv = [process.execPath, helperScript(workspace), marker];
    const log = path.join(workspace.tmpRoot, "helper.log");
    const { pid } = await ok("runDetached", [argv], { cwd: workspace.tmpDir, env: { CCDM_PASSED: "yes", CCDM_SESSION_NAME: "the-caller" }, log });
    assert.ok(Number.isInteger(pid));
    const [record] = readState(workspace.stateDir).fixtures.sessionHost.detached;
    assert.deepEqual(record.argv, argv);
    assert.equal(record.cwd, workspace.tmpDir);
    assert.deepEqual(record.env, { CCDM_PASSED: "yes" });
    assert.equal(record.log, log);
    await until(() => fs.existsSync(marker), "the helper to run");
    const saw = JSON.parse(fs.readFileSync(marker, "utf8"));
    assert.equal(fs.realpathSync(saw.cwd), fs.realpathSync(workspace.tmpDir));
    assert.equal(saw.env.CCDM_PASSED, "yes");
    assert.equal(saw.env.CCDM_SESSION_NAME, undefined);
    assert.ok(!(await ok("pids", ["seam-j"])).includes(pid));
  });

  test(`${language} with no host running, every verb fails within 2 s with the not-running message`, async () => {
    const workspace = createWorkspace();
    const env = { CCDM_SESSION_HOST: "ccdm-host", CCDM_STATE_ROOT: path.join(workspace.tmpRoot, "no-host") };
    const verbs = [
      ["start", ["seam-x"], adhoc(workspace)],
      ["isLive", ["seam-x"]],
      ["sendText", ["seam-x", "text"]],
      ["sendKey", ["seam-x", "Enter"]],
      ["capture", ["seam-x"], {}],
      ["waitFor", ["seam-x", "x", 500]],
      ["stop", ["seam-x"], {}],
      ["stop", ["seam-x"], { graceMs: 1000 }],
      ["pids", ["seam-x"]],
      ["list", []],
      ["runDetached", [[process.execPath, "-e", ""]], { cwd: workspace.tmpDir }],
    ];
    for (const [verb, positional, options] of verbs) {
      const result = await callSeam(workspace, language, verb, { positional, options, env, python: PYTHON });
      assert.equal(result.ok, false, `${verb}: ${JSON.stringify(result)}`);
      assert.equal(result.code, "not_running", verb);
      assert.match(result.message, NOT_RUNNING, verb);
      assert.ok(result.ms < ACTIVE_MS, `${verb} took ${result.ms} ms`);
    }
  });

  test(`${language} tmux: start issues the exact new-session argv with CCDM_SESSION_NAME as the last assignment`, async () => {
    const { ok, workspace } = await world(language, { host: false });
    await ok("start", ["tm-a"], {
      argv: ["claude", "--dangerously-load-development-channels", "server:ccdm", "--dangerously-skip-permissions"],
      cwd: workspace.tmpDir,
      env: { CCDM_ROUTER_KEY_FILE: "/keys/a.key", CCDM_SESSION_NAME: "from-caller" },
      kind: "project",
    });
    assert.deepEqual(tmuxCalls(workspace), [["new-session", "-d", "-s", "tm-a", "--", "zsh", "-ic",
      `cd '${workspace.tmpDir}' && CCDM_ROUTER_KEY_FILE='/keys/a.key' CCDM_SESSION_NAME='tm-a' claude --dangerously-load-development-channels server:ccdm --dangerously-skip-permissions`]]);
    const [record] = launches(workspace);
    assert.equal(record.front, "tmux");
    assert.equal(record.env.CCDM_SESSION_NAME, "tm-a");
    assert.deepEqual(record.argv.slice(0, 3), ["claude", "--dangerously-load-development-channels", "server:ccdm"]);
  });

  test(`${language} tmux: a value holding a single quote stays one word`, async () => {
    const { ok } = await world(language, { host: false });
    const command = await ok("tmuxLaunchCommand", language === "node"
      ? ["tm-q", { argv: ["prog", "it's"], cwd: "/a'b", env: { A: "c'd" }, kind: "adhoc" }]
      : ["tm-q", ["prog", "it's"], "/a'b", { A: "c'd" }]);
    assert.equal(command, `cd '/a'\\''b' && A='c'\\''d' CCDM_SESSION_NAME='tm-q' prog 'it'\\''s'`);
  });

  test(`${language} tmux: isLive, sendText, sendKey, capture, waitFor and list issue today's commands`, async () => {
    const { ok, workspace } = await world(language, { host: false });
    seedTmuxSession("tm-b", { paneOutput: "Loading development channels\n" }, { stateDir: workspace.stateDir });
    assert.equal(await ok("isLive", ["tm-b"]), true);
    assert.equal(await ok("isLive", ["tm-none"]), false);
    await ok("sendText", ["tm-b", "/compact"]);
    await ok("sendText", ["tm-b", "-rf looks like a flag"]);
    await ok("sendKey", ["tm-b", "Enter"]);
    assert.equal(await ok("capture", ["tm-b"], {}), "Loading development channels\n");
    await ok("capture", ["tm-b"], { join: true, history: 50 });
    await ok("capture", ["tm-b"], { history: true });
    const matched = await ok("waitFor", ["tm-b", "development channels?", 2000, "Enter"]);
    assert.equal(matched.matched, true);
    const missed = await ok("waitFor", ["tm-b", "never", 50]);
    assert.equal(missed.matched, false);
    assert.deepEqual((await ok("list")).map(({ name }) => name), ["tm-b"]);
    assert.deepEqual(tmuxCalls(workspace).filter(args => !["capture-pane"].includes(args[0]) || args.length > 4), [
      ["has-session", "-t", "=tm-b"],
      ["has-session", "-t", "=tm-none"],
      ["send-keys", "-t", "=tm-b:", "-l", "/compact"],
      ["send-keys", "-t", "=tm-b:", "-l", "--", "-rf looks like a flag"],
      ["send-keys", "-t", "=tm-b:", "Enter"],
      ["capture-pane", "-t", "=tm-b:", "-p", "-J", "-S", "-50"],
      ["capture-pane", "-t", "=tm-b:", "-p", "-S", "-"],
      ["send-keys", "-t", "=tm-b:", "Enter"],
      ["list-sessions", "-F", "#{session_name}"],
    ]);
    assert.ok(tmuxCalls(workspace).some(args => args.join(" ") === "capture-pane -t =tm-b: -p"));
  });

  test(`${language} tmux: list is empty when tmux has no server, and verbs on an absent session report it`, async () => {
    const { call, ok } = await world(language, { host: false });
    assert.deepEqual(await ok("list"), []);
    assert.equal((await call("capture", ["tm-none"], {})).code, "unknown_session");
    assert.deepEqual(await ok("pids", ["tm-none"]), []);
    assert.deepEqual(await ok("stop", ["tm-none"]), { stopped: false });
  });

  test(`${language} tmux: pids is the pane PID and its descendants`, async () => {
    const { ok, workspace } = await world(language, { host: false });
    const [pane, child, grandchild, stranger] = [sleeper(workspace), sleeper(workspace), sleeper(workspace), sleeper(workspace)];
    updateState(workspace.stateDir, (state) => {
      const row = (pid, ppid) => ({ command: `node ${workspace.tmpRoot}`, owned: true, ownerStateDir: workspace.stateDir, pid, ppid });
      state.fixtures.processes.push(row(child, pane), row(grandchild, child), row(stranger, 1));
      state.fixtures.tmux.sessions["tm-c"] = { name: "tm-c", panePid: pane };
      return state;
    });
    assert.deepEqual(await ok("pids", ["tm-c"]), [pane, child, grandchild]);
    assert.deepEqual(tmuxCalls(workspace), [["display-message", "-t", "=tm-c:", "-p", "#{pane_pid}"]]);
  });

  test(`${language} tmux: stop with graceMs runs restart-root's sequence, and retries a session that survives`, async () => {
    const { ok, workspace } = await world(language, { host: false });
    seedTmuxSession("tm-d", { panePid: 999999 }, { stateDir: workspace.stateDir });
    assert.deepEqual(await ok("stop", ["tm-d"], { graceMs: 20 }), { stopped: true });
    const sequence = name => [
      ["tmux", "has-session", "-t", `=${name}`],
      ["tmux", "display-message", "-t", `=${name}:`, "-p", "#{pane_pid}"],
      ["pkill", "-TERM", "-P", "999999"],
      ["tmux", "kill-session", "-t", `=${name}`],
      ["tmux", "has-session", "-t", `=${name}`],
    ];
    assert.deepEqual(sessionCalls(workspace).map(({ front, args }) => [front, ...args]), sequence("tm-d"));

    seedTmuxSession("tm-e", { panePid: 999999, killFailuresRemaining: 1 }, { stateDir: workspace.stateDir });
    await ok("stop", ["tm-e"], { graceMs: 20 });
    assert.deepEqual(sessionCalls(workspace).slice(5).map(({ front, args }) => [front, ...args]),
      [...sequence("tm-e"), ["tmux", "kill-session", "-t", "=tm-e"]]);
  });

  test(`${language} tmux: stop without graceMs is one kill-session`, async () => {
    const { ok, workspace } = await world(language, { host: false });
    seedTmuxSession("tm-f", {}, { stateDir: workspace.stateDir });
    assert.deepEqual(await ok("stop", ["tm-f"]), { stopped: true });
    assert.deepEqual(tmuxCalls(workspace), [["kill-session", "-t", "=tm-f"]]);
  });

  test(`${language} tmux: attachHint is today's line`, async () => {
    const { ok } = await world(language, { host: false });
    assert.equal(await ok("attachHint", ["tm-g", "demo"]), "Attach with: tmux attach -t tm-g");
  });

  test(`${language} the backend follows CCDM_SESSION_HOST, then the platform`, async () => {
    const workspace = createWorkspace();
    const backend = async (value) => {
      const env = value === undefined ? {} : { CCDM_SESSION_HOST: value };
      const result = await callSeam(workspace, language, "backendName", { env, python: PYTHON });
      return result.ok ? result.value : `error:${result.code}`;
    };
    assert.equal(await backend(undefined), process.platform === "win32" ? "ccdm-host" : "tmux");
    assert.equal(await backend("tmux"), "tmux");
    assert.equal(await backend("ccdm-host"), "ccdm-host");
    assert.equal(await backend("screen"), "error:bad_backend");
  });
}

// The two fixture switches, on both fronts.
for (const front of ["fake host", "tmux"]) {
  const claudeLaunch = workspace => ({
    argv: ["claude", "--dangerously-load-development-channels", "server:ccdm", "--dangerously-skip-permissions"],
    cwd: workspace.tmpDir,
    env: { CCDM_ROUTER_KEY_FILE: path.join(workspace.tmpRoot, "fixture.key") },
    kind: "project",
  });

  test(`${front}: fixtures.claude.trustPrompt shows the trust prompt before the channel prompt`, async () => {
    const { ok, workspace } = await world("node", { host: front === "fake host" });
    updateState(workspace.stateDir, (state) => { state.fixtures.claude.trustPrompt = true; return state; });
    await ok("start", ["sw-a"], claudeLaunch(workspace));
    assert.match(await ok("capture", ["sw-a"], {}), /Is this a project you created or one you trust\?/);
    await ok("sendKey", ["sw-a", "Enter"]);
    assert.match(await ok("capture", ["sw-a"], {}), /Loading development channels/);
    assert.equal(tmuxSessions(workspace)["sw-a"].devChannelPrompt, "pending");
    await ok("sendKey", ["sw-a", "Enter"]);
    assert.equal(tmuxSessions(workspace)["sw-a"].devChannelPrompt, "accepted");
  });

  test(`${front}: without trustPrompt the channel prompt comes first`, async () => {
    const { ok, workspace } = await world("node", { host: front === "fake host" });
    await ok("start", ["sw-b"], claudeLaunch(workspace));
    assert.match(await ok("capture", ["sw-b"], {}), /Loading development channels/);
  });

  test(`${front}: fixtures.claude.contextScreen answers /context`, async () => {
    const { ok, workspace } = await world("node", { host: front === "fake host" });
    updateState(workspace.stateDir, (state) => { state.fixtures.claude.contextScreen = "GRID 42%\n"; return state; });
    seedTmuxSession("sw-c", { paneOutput: "idle\n", ...(front === "fake host" ? { pid: process.pid, job: [] } : {}) }, { stateDir: workspace.stateDir });
    await ok("sendText", ["sw-c", "/context"]);
    await ok("sendKey", ["sw-c", "Enter"]);
    assert.equal(await ok("capture", ["sw-c"], {}), "GRID 42%\n");
  });
}

// ---- POSIX only ----

test("node runDetached on POSIX outlives its caller and carries no session name", platformGate("posix", "POSIX detaches with a new session; Windows goes through ccdm-host"), async () => {
  const { workspace } = await world("node", { host: false, extraEnv: {} });
  await assertOutlives(workspace, "node");
});

test("python run_detached on POSIX outlives its caller and carries no session name", platformGate("posix", "POSIX detaches with a new session; Windows goes through ccdm-host"), async () => {
  const { workspace } = await world("python", { host: false, extraEnv: {} });
  await assertOutlives(workspace, "python");
});

async function assertOutlives(workspace, language) {
  const marker = path.join(workspace.tmpRoot, "outlived.json");
  const log = path.join(workspace.tmpRoot, "logs", "outlived.log");
  const driverPid = await launchThenExit(workspace, language, marker, log);
  await until(() => fs.existsSync(marker), "the helper to outlive its caller");
  const saw = JSON.parse(fs.readFileSync(marker, "utf8"));
  assert.equal(fs.realpathSync(saw.cwd), fs.realpathSync(workspace.tmpDir));
  assert.equal(saw.env.CCDM_PASSED, "yes");
  assert.equal(saw.env.CCDM_SESSION_NAME, undefined);
  assert.equal(saw.argv.at(-1), String(driverPid));
  assert.ok(fs.existsSync(log));
}

// The seam's caller is a child that exits at once, leaving the helper running.
async function launchThenExit(workspace, language, marker, log) {
  const callerFile = path.join(workspace.tmpRoot, "caller-pid.txt");
  const script = helperScript(workspace);
  const source = language === "node"
    ? `require("node:fs").writeFileSync(process.argv[1], String(process.pid));
       require(process.argv[2]).runDetached([process.execPath, process.argv[3], process.argv[4], String(process.pid)],
         { cwd: process.argv[5], env: { CCDM_PASSED: "yes", CCDM_SESSION_NAME: "x" }, log: process.argv[6] });`
    : `import os, sys
sys.dont_write_bytecode = True
sys.path.insert(0, sys.argv[7])
from ccdmlib.platform import session_host
open(sys.argv[1], "w").write(str(os.getpid()))
session_host.run_detached([sys.argv[2], sys.argv[3], sys.argv[4], str(os.getpid())], cwd=sys.argv[5],
                           env={"CCDM_PASSED": "yes", "CCDM_SESSION_NAME": "x"}, log=sys.argv[6])`;
  const seamPath = path.join(workspace.repoDir, "scripts", "lib", "session-host.js");
  const args = language === "node"
    ? ["-e", source, callerFile, seamPath, script, marker, workspace.tmpDir, log]
    : ["-c", source, callerFile, process.execPath, script, marker, workspace.tmpDir, log, path.join(workspace.repoDir, "scripts")];
  const child = spawn(language === "node" ? process.execPath : PYTHON, args, {
    env: { ...workspace.env, CCDM_SESSION_HOST: "tmux", CCDM_SESSION_NAME: "the-caller", PYTHONDONTWRITEBYTECODE: "1" },
    stdio: "ignore",
  });
  const code = await new Promise(resolve => child.once("close", resolve));
  assert.equal(code, 0);
  return Number(fs.readFileSync(callerFile, "utf8"));
}

// ---- Windows only ----

// The fake host was written from the protocol; this holds the seam to the real one.
async function realHostWorld(language) {
  const workspace = createWorkspace();
  const stateRoot = path.join(workspace.tmpRoot, "real-host-state");
  const env = { CCDM_STATE_ROOT: stateRoot, CCDM_SESSION_HOST: "ccdm-host" };
  const script = path.join(workspace.repoDir, "scripts", "ccdm-host.js");
  const options = { cwd: path.dirname(workspace.tmpRoot), env: { ...workspace.env, ...env }, windowsHide: true };
  const host = spawn(process.execPath, [script, "serve", "--allow-in-job"], { ...options, stdio: ["ignore", "pipe", "pipe"] });
  const exited = new Promise(resolve => host.once("exit", resolve));
  registerTeardownCallback(async () => {
    if (host.exitCode !== null) return;
    await new Promise(resolve => spawn(process.execPath, [script, "shutdown"], { ...options, stdio: "ignore" }).once("close", resolve));
    await Promise.race([exited, sleep(scaledTimeout(5000))]);
    if (host.exitCode === null) host.kill();
  });
  let output = "";
  host.stdout.setEncoding("utf8").on("data", (chunk) => { output += chunk; });
  host.stderr.setEncoding("utf8").on("data", (chunk) => { output += chunk; });
  await until(() => /ready/.test(output) || host.exitCode !== null, "the real host to be ready", 15000);
  assert.match(output, /ready/);
  const ok = async (verb, positional, options_) => {
    const result = await callSeam(workspace, language, verb, { positional, options: options_, env, python: PYTHON });
    assert.equal(result.ok, true, `${verb}: ${JSON.stringify(result)}`);
    return result.value;
  };
  return { ok, workspace };
}

const ECHO_PROGRAM = `
  process.stdout.write("READY\\n");
  process.stdin.setEncoding("utf8").on("data", text => process.stdout.write("Got " + text.trim() + "\\n"));
`;

for (const language of LANGUAGES) {
  test(`${language} seam drives every verb on the real ccdm-host`, onlyWindows, async () => {
    const { ok, workspace } = await realHostWorld(language);
    const name = "real-seam";
    const started = await ok("start", [name], { argv: [process.execPath, "-e", ECHO_PROGRAM], cwd: workspace.tmpDir, kind: "adhoc" });
    assert.equal(started.kind, "adhoc");
    assert.equal(await ok("isLive", [name]), true);
    assert.ok((await ok("list")).some(session => session.name === name && session.pid === started.pid));
    assert.equal((await ok("waitFor", [name, "^READY", 15000])).matched, true);

    await ok("sendText", [name, "first"]);
    await ok("sendKey", [name, "Enter"]);
    const found = await ok("waitFor", [name, { regexSource: "^GOT first", flags: "i" }, 15000, ["Enter"]]);
    assert.equal(found.matched, true, "a case-insensitive pattern has to reach the host as one");
    assert.equal((await ok("waitFor", [name, "^GOT first", 200])).matched, false, "and a plain pattern stays case-sensitive");
    assert.match(await ok("capture", [name]), /Got first/);
    assert.ok((await ok("pids", [name])).includes(started.pid));

    const helper = [process.execPath, "-e", "console.log(JSON.stringify([process.cwd(), process.env.CCDM_SESSION_NAME ?? null]))"];
    const relativeLog = "real-seam-helper.log";
    await ok("runDetached", [helper], { env: { CCDM_SESSION_NAME: name }, log: relativeLog });
    const log = path.join(workspace.tmpRoot, relativeLog);
    await until(() => fs.existsSync(log) && fs.readFileSync(log, "utf8").includes("]"), "the helper's log");
    const [cwd, sessionName] = JSON.parse(fs.readFileSync(log, "utf8"));
    assert.equal(fs.realpathSync(cwd), fs.realpathSync(workspace.tmpRoot), "the helper starts where the caller is");
    assert.equal(sessionName, null);

    assert.deepEqual(await ok("stop", [name], { graceMs: 200 }), { stopped: true });
    assert.equal(await ok("isLive", [name]), false);
    assert.deepEqual(await ok("stop", [name]), { stopped: false });
  });
}

test("spawnDetached throws on Windows, where runDetached goes through the host", onlyWindows, () => {
  const { spawnDetached } = require("../../scripts/platform/detached.js");
  assert.throws(() => spawnDetached(process.execPath, []), /POSIX only/);
});

test("the Python seam reaches the CCDM_HOST_SOCKET pipe when CCDM_ROUTER_SOCKET is also set", onlyWindows, async () => {
  const { fake, workspace } = await world("python");
  const pipe = fs.readFileSync(path.join(fake.hostDir, "host.pipe"), "utf8");
  // With the published name gone, only the override can find the host.
  fs.rmSync(path.join(fake.hostDir, "host.pipe"));
  const env = { ...fake.env, CCDM_HOST_SOCKET: pipe, CCDM_ROUTER_SOCKET: "\\\\.\\pipe\\ccdm-p3.2a-no-router-here" };
  const result = await callSeam(workspace, "python", "list", { env, python: PYTHON });
  assert.deepEqual(result.ok ? result.value : result, []);
  assert.deepEqual(hostOps(workspace).map(entry => entry.op), ["hello", "list"]);
});

test("the Node seam also honours CCDM_HOST_SOCKET", onlyWindows, async () => {
  const { fake, workspace } = await world("node");
  const pipe = fs.readFileSync(path.join(fake.hostDir, "host.pipe"), "utf8");
  fs.rmSync(path.join(fake.hostDir, "host.pipe"));
  const env = { ...fake.env, CCDM_HOST_SOCKET: pipe };
  const result = await callSeam(workspace, "node", "list", { env });
  assert.deepEqual(result.ok ? result.value : result, []);
});

for (const language of LANGUAGES) {
  test(`${language} seam refuses a server that fails the proof, and sends it nothing more`, onlyWindows, async () => {
    const { call, workspace } = await world(language, { badProof: true });
    const result = await call("list");
    assert.equal(result.ok, false);
    assert.equal(result.code, "not_authenticated");
    assert.deepEqual(hostOps(workspace), []);
  });
}

test("the Python seam connects after retrying ERROR_PIPE_BUSY", onlyWindows, async () => {
  const workspace = createWorkspace();
  const stateRoot = path.join(workspace.tmpRoot, "busy-state");
  const hostDir = path.join(stateRoot, "host");
  fs.mkdirSync(hostDir, { recursive: true });
  const source = `
import sys
sys.dont_write_bytecode = True
import json, secrets, threading, time, _winapi
sys.path.insert(0, sys.argv[1])
from ccdmlib.platform import ipc, session_host
host_dir = sys.argv[2]
pipe, secret = ipc.publish_pipe(host_dir, "host")
token = secrets.token_hex(16)
open(host_dir + "/host.token", "w").write(token)
def instance():
    return _winapi.CreateNamedPipe(pipe, _winapi.PIPE_ACCESS_DUPLEX, _winapi.PIPE_WAIT, 2, 4096, 4096, 0, _winapi.NULL)
def serve(handle):
    try:
        _winapi.ConnectNamedPipe(handle, False)
    except OSError as error:
        # ERROR_PIPE_CONNECTED: the client got in first, which is just as good.
        if error.winerror != 535:
            raise
    def read():
        return json.loads(_winapi.ReadFile(handle, 4096)[0])
    def write(frame):
        _winapi.WriteFile(handle, (json.dumps(frame) + "\\n").encode("utf-8"))
    proof = read()
    write({"type": "server_proof_ok", "proof": ipc.server_proof(secret, proof["nonce"])})
    read()
    write({"ok": True, "type": "hello_ok", "protocol_version": 1})
    op = read()
    write({"id": op["id"], "ok": True, "sessions": [{"name": "busy-ok", "kind": "adhoc", "pid": 7, "exit": None}]})
    while True:
        time.sleep(1)
first = instance()
threading.Thread(target=serve, args=(first,), daemon=True).start()
holder = ipc.connect("host", host_dir)
def later():
    time.sleep(0.4)
    serve(instance())
threading.Thread(target=later, daemon=True).start()
started = time.monotonic()
sessions = session_host.list_sessions()
print(json.dumps({"waited_ms": (time.monotonic() - started) * 1000, "sessions": sessions}))
`;
  const child = spawn(PYTHON, ["-c", source, path.join(workspace.repoDir, "scripts"), hostDir], {
    env: { ...workspace.env, CCDM_SESSION_HOST: "ccdm-host", CCDM_STATE_ROOT: stateRoot, PYTHONDONTWRITEBYTECODE: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  const code = await new Promise(resolve => child.once("close", resolve));
  assert.equal(code, 0, stderr);
  const result = JSON.parse(stdout);
  assert.ok(result.waited_ms >= 200, stdout);
  assert.deepEqual(result.sessions, [{ name: "busy-ok", kind: "adhoc", pid: 7 }]);
});
