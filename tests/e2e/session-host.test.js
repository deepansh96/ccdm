// ccdm-host: the daemon's lock, pipe and handshake, the protocol ops, session
// environments, and Job kills. Windows only; every command is a small Node
// fixture in the workspace, never a real agent.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";
import test from "node:test";

import { assertPrivate, platformGate, PYTHON } from "./support/platform.js";
import { createWorkspace, runScript, scaledTimeout } from "./support/runner.js";
import { tmuxCalls } from "./support/session-fixture.js";
import { seedRegistry, seedTmuxSession } from "./support/state.js";
import { cleanup, registerTeardownCallback } from "./support/teardown.js";
import { supervisorStateDir } from "./support/thread-supervisor.js";

const onlyWindows = platformGate("win32", "ccdm-host is the Windows session host; other platforms use tmux");
const PIPE_NAME = /^\\\\\.\\pipe\\ccdm-[0-9a-f]{32}-host$/;
const NOT_RUNNING = "ccdm-host is not running; start it with `node scripts/ccdm-host.js serve`";
const require = createRequire(import.meta.url);
const lazy = name => require(`../../scripts/${name}`);

test.afterEach(async () => {
  await cleanup();
});

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitUntil(predicate, what, timeoutMs = 5000) {
  const deadline = Date.now() + scaledTimeout(timeoutMs);
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await sleep(25);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

function hostWorkspace() {
  const workspace = createWorkspace();
  const stateRoot = path.join(workspace.tmpRoot, "ccdm-state");
  const hostDir = path.join(stateRoot, "host");
  const fixtures = path.join(workspace.tmpRoot, "p3.1a-fixtures");
  fs.mkdirSync(fixtures, { recursive: true });
  const script = path.join(workspace.repoDir, "scripts", "ccdm-host.js");
  const env = extra => ({ ...workspace.env, CCDM_STATE_ROOT: stateRoot, ...extra });
  return { ...workspace, stateRoot, hostDir, fixtures, script, childEnv: env };
}

function collect(child) {
  const output = { stdout: "", stderr: "" };
  child.stdout?.setEncoding("utf8").on("data", chunk => { output.stdout += chunk; });
  child.stderr?.setEncoding("utf8").on("data", chunk => { output.stderr += chunk; });
  const closed = new Promise(resolve => { child.once("close", code => resolve(code)); });
  return { output, closed };
}

// Runs one CLI subcommand and reports its code, output and how long it took.
function cli(workspace, args, { env = {}, timeoutMs = 20000 } = {}) {
  const started = performance.now();
  const child = spawn(process.execPath, [workspace.script, ...args], {
    cwd: workspace.repoDir, env: workspace.childEnv(env), stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  const { output, closed } = collect(child);
  const timer = setTimeout(() => child.kill(), scaledTimeout(timeoutMs));
  return closed.then(code => {
    clearTimeout(timer);
    return { code, ...output, ms: performance.now() - started };
  });
}

async function cliOk(workspace, args, options) {
  const result = await cli(workspace, args, options);
  assert.equal(result.code, 0, `${args.join(" ")} failed: ${result.stderr}`);
  return result;
}

function serveProcess(workspace, { env = {}, args = ["--allow-in-job"], wrapper = null } = {}) {
  const command = wrapper ? [wrapper, workspace.script, "serve", ...args] : [workspace.script, "serve", ...args];
  const child = spawn(process.execPath, command, {
    cwd: workspace.repoDir, env: workspace.childEnv(env), stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  return { child, ...collect(child) };
}

async function startHost(workspace, options = {}) {
  const host = serveProcess(workspace, options);
  registerTeardownCallback(async () => {
    if (host.child.exitCode === null) {
      await cli(workspace, ["shutdown"]);
      await Promise.race([host.closed, sleep(5000)]);
      if (host.child.exitCode === null) host.child.kill();
    }
  });
  await waitUntil(() => /ready/.test(host.output.stdout) || host.child.exitCode !== null,
    () => `host ready: ${host.output.stderr}`, 15000);
  assert.match(host.output.stdout, /ready/, host.output.stderr);
  return host;
}

// Remembers each fixture process with its start time, so the end-of-test check
// can never mistake a reused PID for one of ours.
const tracked = new Map();
function trackPid(pid) {
  const { processStartTime } = lazy("platform/process.js");
  const startedAt = processStartTime(pid);
  if (startedAt !== null) tracked.set(pid, startedAt);
  return { pid, startedAt };
}

const isAlive = ({ pid, startedAt }) => lazy("platform/process.js").processAlive(pid, startedAt);

test.afterEach(() => {
  for (const [pid, startedAt] of tracked) {
    if (isAlive({ pid, startedAt })) {
      try {
        process.kill(pid);
      } catch { /* It went on its own. */ }
    }
    tracked.delete(pid);
  }
});

// Writes a fixture and returns its path.
function fixture(workspace, name, source) {
  const file = path.join(workspace.fixtures, name);
  fs.writeFileSync(file, source);
  return file;
}

// Prints its marker, then echoes each stdin line back. Exits when stdin closes.
function echoSession(workspace, marker = "fixture-up") {
  return fixture(workspace, "p3.1a-echo.js", `
    process.stdin.setEncoding("utf8");
    console.log(${JSON.stringify(marker)});
    let buffer = "";
    process.stdin.on("data", chunk => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\\n")) >= 0) {
        console.log("echo:" + buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
      }
    });
    process.stdin.on("end", () => process.exit(0));
  `);
}

const newSession = (workspace, name, fixtureFile, { kind = "adhoc", extra = [], env } = {}) =>
  cliOk(workspace, ["new-session", "-d", "-s", name, "-c", workspace.fixtures, "--kind", kind, "--no-pty", ...extra, "--", process.execPath, fixtureFile], { env });

const capture = async (workspace, name, args = []) => (await cliOk(workspace, ["capture-pane", "-t", `=${name}`, "-p", ...args])).stdout;

async function waitForCapture(workspace, name, pattern) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const text = await capture(workspace, name);
    if (pattern.test(text)) return text;
    await sleep(50);
  }
  throw new Error(`capture of ${name} never matched ${pattern}: ${await capture(workspace, name)}`);
}

const readPublished = workspace => ({
  pipe: fs.readFileSync(path.join(workspace.hostDir, "host.pipe"), "utf8").trim(),
  secret: fs.readFileSync(path.join(workspace.hostDir, "host.secret"), "utf8").trim(),
  token: fs.readFileSync(path.join(workspace.hostDir, "host.token"), "utf8").trim(),
});

// A raw NDJSON connection to the host, without the client library.
function rawConnection(pipe) {
  const socket = net.connect(pipe);
  socket.setEncoding("utf8");
  socket.on("error", () => {});
  const frames = [];
  const waiters = [];
  let buffer = "";
  let closed = false;
  socket.on("data", chunk => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const frame = JSON.parse(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      (waiters.shift() ?? (value => frames.push(value)))(frame);
    }
  });
  socket.on("close", () => {
    closed = true;
    for (const waiter of waiters.splice(0)) waiter(null);
  });
  registerTeardownCallback(() => socket.destroy());
  const connected = new Promise(resolve => { socket.once("connect", resolve); });
  return {
    connected,
    send: frame => socket.write(`${JSON.stringify(frame)}\n`),
    next: () => frames.length ? Promise.resolve(frames.shift()) : new Promise(resolve => { waiters.push(resolve); }),
    isClosed: () => closed,
    destroy: () => socket.destroy(),
  };
}

async function authenticated(workspace, pipe = readPublished(workspace).pipe) {
  const connection = rawConnection(pipe);
  await connection.connected;
  connection.send({ op: "hello", protocol_version: 1, token: readPublished(workspace).token });
  const reply = await connection.next();
  assert.equal(reply.ok, true);
  assert.equal(reply.type, "hello_ok");
  return connection;
}

async function ask(connection, frame) {
  connection.send(frame);
  return connection.next();
}

test("serve publishes a new pipe, secret and token each start, and a second serve exits while the first holds the lock", onlyWindows, async () => {
  const workspace = hostWorkspace();
  const first = await startHost(workspace);
  const published = readPublished(workspace);
  assert.match(published.pipe, PIPE_NAME);
  assertPrivate(workspace.hostDir);
  const lock = fs.readFileSync(path.join(workspace.hostDir, "host.lock"), "utf8").trim();
  assert.match(lock, new RegExp(`^${first.child.pid} \\d+$`));

  const second = serveProcess(workspace);
  const secondCode = await second.closed;
  assert.notEqual(secondCode, 0);
  assert.match(second.output.stderr, /already running/);
  assert.deepEqual(readPublished(workspace), published, "the second serve changed what the first published");

  await cliOk(workspace, ["shutdown"]);
  await first.closed;
  await startHost(workspace);
  const again = readPublished(workspace);
  assert.notEqual(again.pipe, published.pipe);
  assert.notEqual(again.secret, published.secret);
  assert.notEqual(again.token, published.token);
});

for (const { label, reply } of [
  { label: "with a wrong proof", reply: { type: "server_proof_ok", proof: "0".repeat(64) } },
  { label: "with no proof at all", reply: null },
]) {
  test(`a client facing a server ${label} sends no token`, onlyWindows, async () => {
    const workspace = hostWorkspace();
    await startHost(workspace);
    const { token } = readPublished(workspace);
    const bytes = [];
    const fakePipe = `\\\\.\\pipe\\ccdm-p3.1a-test-${randomBytes(8).toString("hex")}-host`;
    const server = net.createServer(socket => {
      socket.setEncoding("utf8");
      socket.on("error", () => {});
      socket.on("data", chunk => {
        bytes.push(chunk);
        if (reply) socket.write(`${JSON.stringify(reply)}\n`);
      });
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(fakePipe, resolve);
    });
    registerTeardownCallback(() => new Promise(resolve => server.close(resolve)));

    const result = await cli(workspace, ["list-sessions"], { env: { CCDM_HOST_SOCKET: fakePipe } });
    assert.notEqual(result.code, 0);
    assert.doesNotMatch(result.stdout, /\w/);
    await waitUntil(() => bytes.length > 0, () => "the client's proof frame");
    const text = bytes.join("");
    assert.equal(text.includes(token), false, "the token reached a server that did not prove itself");
    const frames = text.trim().split("\n").map(line => JSON.parse(line));
    assert.deepEqual(frames.map(frame => frame.type), ["server_proof"]);
  });
}

test("a CCDM_HOST_SOCKET override still works against the real host, proof included", onlyWindows, async () => {
  const workspace = hostWorkspace();
  await startHost(workspace);
  const result = await cliOk(workspace, ["list-sessions"], { env: { CCDM_HOST_SOCKET: readPublished(workspace).pipe } });
  assert.equal(result.stdout, "");
});

test("a connection without a valid hello gets not_authenticated for any op", onlyWindows, async () => {
  const workspace = hostWorkspace();
  await startHost(workspace);
  const { pipe } = readPublished(workspace);
  for (const frame of [
    { id: 1, op: "list" },
    { id: 2, op: "new", name: "x", argv: ["x"], kind: "adhoc" },
    { id: 3, op: "ping" },
    { id: 4, op: "hello", protocol_version: 1, token: "wrong" },
    { id: 5, op: "hello", protocol_version: 1 },
    { id: 6, op: "hello", protocol_version: 99, token: "wrong" },
  ]) {
    const connection = rawConnection(pipe);
    await connection.connected;
    connection.send(frame);
    const reply = await connection.next();
    assert.equal(reply.ok, false);
    assert.equal(reply.id, frame.id);
    assert.equal(reply.error, "not_authenticated");
    await waitUntil(connection.isClosed, () => `connection for frame ${frame.id} to close`);
  }
});

test("the server proof comes before the hello and the first frame after it must still be a valid hello", onlyWindows, async () => {
  const workspace = hostWorkspace();
  await startHost(workspace);
  const { pipe, secret } = readPublished(workspace);
  const { serverProof } = lazy("platform/ipc.js");
  const nonce = randomBytes(32).toString("hex");
  const connection = rawConnection(pipe);
  await connection.connected;
  connection.send({ type: "server_proof", nonce });
  const proof = await connection.next();
  assert.equal(proof.type, "server_proof_ok");
  assert.equal(proof.proof, serverProof(secret, nonce));
  connection.send({ id: 7, op: "list" });
  const reply = await connection.next();
  assert.equal(reply.error, "not_authenticated");
  await waitUntil(connection.isClosed, () => "connection to close");
});

test("a wrong protocol_version gets protocol_mismatch naming the restart", onlyWindows, async () => {
  const workspace = hostWorkspace();
  await startHost(workspace);
  const { pipe, token } = readPublished(workspace);
  const connection = rawConnection(pipe);
  await connection.connected;
  connection.send({ op: "hello", protocol_version: 2, token });
  const reply = await connection.next();
  assert.equal(reply.ok, false);
  assert.equal(reply.error, "protocol_mismatch");
  assert.match(reply.message, /restart ccdm-host/);
});

test("new-session --no-pty starts a child with a log, capture-pane shows its output and send-keys reaches its stdin", onlyWindows, async () => {
  const workspace = hostWorkspace();
  await startHost(workspace);
  const log = path.join(workspace.fixtures, "p3.1a-echo.log");
  await newSession(workspace, "echo", echoSession(workspace), { extra: ["--log", log] });
  await waitForCapture(workspace, "echo", /fixture-up/);
  await cliOk(workspace, ["send-keys", "-t", "echo", "-l", "typed text"]);
  await cliOk(workspace, ["send-keys", "-t", "echo", "Enter"]);
  await waitForCapture(workspace, "echo", /echo:typed text/);
  assert.match(fs.readFileSync(log, "utf8"), /fixture-up[\s\S]*echo:typed text/);
  const history = await capture(workspace, "echo", ["-S", "-"]);
  assert.match(history, /fixture-up/);
});

test("capture-pane without -S shows one screen; -S - returns the older lines too", onlyWindows, async () => {
  const workspace = hostWorkspace();
  await startHost(workspace);
  const many = fixture(workspace, "p3.1a-many.js", `
    for (let i = 0; i < 120; i += 1) console.log("line-" + i);
    setInterval(() => {}, 1000);
  `);
  await newSession(workspace, "many", many);
  await waitForCapture(workspace, "many", /line-119/);
  const screen = await capture(workspace, "many");
  assert.doesNotMatch(screen, /line-0\n/);
  assert.equal(screen.trim().split("\n").length, 50);
  const history = await capture(workspace, "many", ["-S", "-"]);
  assert.match(history, /line-0\n/);
  assert.equal(history.trim().split("\n").length, 120);
});

test("a duplicate name is refused, has-session never matches a prefix, and an unknown name is unknown_session", onlyWindows, async () => {
  const workspace = hostWorkspace();
  await startHost(workspace);
  const echo = echoSession(workspace);
  await newSession(workspace, "alpha", echo);
  const duplicate = await cli(workspace, ["new-session", "-d", "-s", "alpha", "-c", workspace.fixtures, "--kind", "adhoc", "--no-pty", "--", process.execPath, echo]);
  assert.notEqual(duplicate.code, 0);
  assert.match(duplicate.stderr, /already exists/);
  assert.equal((await cli(workspace, ["has-session", "-t", "=alpha"])).code, 0);
  assert.equal((await cli(workspace, ["has-session", "-t", "=alp"])).code, 1);
  assert.equal((await cli(workspace, ["has-session", "-t", "alp"])).code, 1);
  for (const args of [["send-keys", "-t", "ghost", "x"], ["capture-pane", "-t", "=ghost", "-p"], ["kill-session", "-t", "=ghost"], ["pids", "-t", "ghost"]]) {
    const result = await cli(workspace, args);
    assert.equal(result.code, 1, args.join(" "));
    assert.match(result.stderr, /no session named ghost/);
  }
  const connection = await authenticated(workspace);
  assert.equal((await ask(connection, { id: "a", op: "has", name: "alp" })).live, false);
  assert.equal((await ask(connection, { id: "b", op: "pids", name: "ghost" })).error, "unknown_session");
});

test("list-sessions and display-message print name and PID, and list reports each kind", onlyWindows, async () => {
  const workspace = hostWorkspace();
  await startHost(workspace);
  const echo = echoSession(workspace);
  await newSession(workspace, "proj", echo, { kind: "project" });
  await newSession(workspace, "thr", echo, { kind: "thread" });
  const listed = (await cliOk(workspace, ["list-sessions", "-F", "#{session_name} #{pane_pid}"])).stdout.trim().split("\n").sort();
  assert.equal(listed.length, 2);
  const pids = Object.fromEntries(listed.map(line => line.split(" ")));
  assert.match(pids.proj, /^\d+$/);
  const displayed = (await cliOk(workspace, ["display-message", "-t", "thr", "-p", "#{pane_pid}"])).stdout.trim();
  assert.equal(displayed, pids.thr);
  const connection = await authenticated(workspace);
  const { sessions } = await ask(connection, { id: 1, op: "list" });
  assert.deepEqual(sessions.map(({ name, kind, pty, exit }) => ({ name, kind, pty, exit })).sort((a, b) => a.name.localeCompare(b.name)), [
    { name: "proj", kind: "project", pty: false, exit: null },
    { name: "thr", kind: "thread", pty: false, exit: null },
  ]);
  for (const session of sessions) assert.equal(typeof session.created, "number");
});

test("kill-session removes the whole tree, a detached grandchild included, and pids is then empty", onlyWindows, async () => {
  const workspace = hostWorkspace();
  await startHost(workspace);
  const report = path.join(workspace.fixtures, "p3.1a-tree.json");
  const tree = fixture(workspace, "p3.1a-tree.js", `
    const { spawn } = require("node:child_process");
    const fs = require("node:fs");
    const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore", windowsHide: true });
    grandchild.unref();
    fs.writeFileSync(${JSON.stringify(report)}, JSON.stringify({ child: process.pid, grandchild: grandchild.pid }));
    console.log("tree-ready");
    // Ignores stdin closing, so only the Job can stop it.
    process.stdin.resume();
    process.stdin.on("end", () => {});
    setInterval(() => {}, 1000);
  `);
  await newSession(workspace, "tree", tree);
  await waitForCapture(workspace, "tree", /tree-ready/);
  const { child, grandchild } = JSON.parse(fs.readFileSync(report, "utf8"));
  const processes = [trackPid(child), trackPid(grandchild)];
  assert.ok(processes.every(isAlive), "the fixture tree did not start");
  const jobPids = (await cliOk(workspace, ["pids", "-t", "tree"])).stdout.trim().split("\n").map(Number);
  assert.ok(jobPids.includes(child));
  assert.ok(jobPids.includes(grandchild));

  await cliOk(workspace, ["kill-session", "-t", "=tree", "--grace", "300"]);
  await waitUntil(() => processes.every(entry => !isAlive(entry)), () => "the fixture tree to be gone");
  assert.equal((await cliOk(workspace, ["pids", "-t", "tree"])).stdout, "");
  assert.equal((await cli(workspace, ["has-session", "-t", "=tree"])).code, 1);
});

test("the grace phase closes stdin, so a session that stops on EOF ends before the Job is used", onlyWindows, async () => {
  const workspace = hostWorkspace();
  await startHost(workspace);
  const marker = path.join(workspace.fixtures, "p3.1a-grace.txt");
  const graceful = fixture(workspace, "p3.1a-graceful.js", `
    const fs = require("node:fs");
    console.log("up");
    process.stdin.resume();
    process.stdin.on("end", () => { fs.writeFileSync(${JSON.stringify(marker)}, "eof"); process.exit(0); });
  `);
  await newSession(workspace, "graceful", graceful);
  await waitForCapture(workspace, "graceful", /up/);
  const started = performance.now();
  await cliOk(workspace, ["kill-session", "-t", "=graceful", "--grace", "8000"]);
  assert.ok(performance.now() - started < 7000, "the grace wait did not end when the session did");
  assert.equal(fs.readFileSync(marker, "utf8"), "eof");
});

test("an ended session reports not live, keeps its output for capture, and frees its name", onlyWindows, async () => {
  const workspace = hostWorkspace();
  await startHost(workspace);
  const brief = fixture(workspace, "p3.1a-brief.js", `console.log("short-lived"); process.exit(4);`);
  await newSession(workspace, "brief", brief);
  const connection = await authenticated(workspace);
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (!(await ask(connection, { id: attempt, op: "has", name: "brief" })).live) break;
    await sleep(25);
  }
  const listed = (await ask(connection, { id: "l", op: "list" })).sessions.find(session => session.name === "brief");
  assert.equal(listed.exit, 4);
  assert.match((await capture(workspace, "brief")), /short-lived/);
  assert.equal((await cli(workspace, ["list-sessions"])).stdout.includes("brief"), false);
  await newSession(workspace, "brief", echoSession(workspace));
  await waitForCapture(workspace, "brief", /fixture-up/);
});

test("a command that cannot start gets spawn_failed, and an unknown op gets unsupported_op", onlyWindows, async () => {
  const workspace = hostWorkspace();
  await startHost(workspace);
  const connection = await authenticated(workspace);
  const missing = await ask(connection, { id: 1, op: "new", name: "x", argv: ["no-such-program-p3-1a.exe"], cwd: workspace.fixtures, env: {}, pty: false, kind: "adhoc" });
  assert.equal(missing.error, "spawn_failed");
  assert.equal((await ask(connection, { id: 2, op: "has", name: "x" })).live, false);
  assert.equal((await ask(connection, { id: "n", op: "nonsense" })).error, "unsupported_op");
  await newSession(workspace, "plain", echoSession(workspace));
  const noPty = await ask(connection, { id: 3, op: "wait", name: "plain", regex: "x", timeoutMs: 10 });
  assert.equal(noPty.error, "unsupported_op");
  assert.equal((await ask(connection, { id: 4, op: "attach", name: "plain" })).error, "unsupported_op");
});

function userProfilePaths() {
  const powershell = path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const script = `
    $ErrorActionPreference = 'Stop'
    [Console]::OutputEncoding = [Text.Encoding]::UTF8
    $profilePath = [Environment]::GetFolderPath('UserProfile')
    $environment = Get-Item 'HKCU:\\Environment'
    $machine = Get-Item 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment'
    $temp = $environment.GetValue('TEMP', $null, 'DoNotExpandEnvironmentNames')
    if ($null -eq $temp) { $temp = $machine.GetValue('TEMP', $null, 'DoNotExpandEnvironmentNames') }
    @{
      SystemRoot = [Environment]::GetFolderPath('Windows');
      USERPROFILE = $profilePath;
      APPDATA = [Environment]::GetFolderPath('ApplicationData');
      LOCALAPPDATA = [Environment]::GetFolderPath('LocalApplicationData');
      ProgramData = [Environment]::GetFolderPath('CommonApplicationData');
      TEMP = $temp;
      WindowsSession = [string](Get-Process -Id $PID).SessionId;
    } | ConvertTo-Json -Compress
  `;
  const probe = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true });
  assert.equal(probe.status, 0, probe.stderr);
  const values = JSON.parse(probe.stdout.trim().split("\n").at(-1));
  values.windir = values.SystemRoot;
  return Object.fromEntries(Object.entries(values).map(([name, value]) => [name, value
    .replace(/%USERPROFILE%/i, values.USERPROFILE)
    .replace(/%SystemRoot%/i, values.SystemRoot)]));
}

// Runs a session that writes its environment to a file and returns it. It
// also starts a child node that connects to `tcpPort` when one is given.
async function sessionEnvironment(workspace, name, { extra = [], cliEnv, tcpPort = null } = {}) {
  const report = path.join(workspace.fixtures, `p3.1a-env-${name}.json`);
  const reporter = fixture(workspace, `p3.1a-env-${name}.js`, `
    const { spawnSync } = require("node:child_process");
    const fs = require("node:fs");
    const child = ${tcpPort ?? "null"} === null ? { status: 0 } : spawnSync(process.execPath, ["-e", ${JSON.stringify(`
      const socket = require("node:net").connect(${tcpPort}, "127.0.0.1", () => { socket.end("from-session-child\\n"); });
      socket.on("error", error => { console.error(error.code); process.exit(1); });
      socket.on("close", () => process.exit(0));
    `)}], { encoding: "utf8", windowsHide: true });
    fs.writeFileSync(${JSON.stringify(report)}, JSON.stringify({ env: process.env, childStatus: child.status, childError: child.stderr }));
    console.log("env-written");
    setInterval(() => {}, 1000);
  `);
  await newSession(workspace, name, reporter, { extra, env: cliEnv });
  await waitForCapture(workspace, name, /env-written/);
  await cliOk(workspace, ["kill-session", "-t", `=${name}`, "--grace", "0"]);
  return JSON.parse(fs.readFileSync(report, "utf8"));
}

const envValue = (env, name) => env[Object.keys(env).find(key => key.toUpperCase() === name.toUpperCase())];

test("a session sees the profile variables of a fresh logon, not the host's, and a child node can open a TCP socket", onlyWindows, async () => {
  const workspace = hostWorkspace();
  const received = [];
  const server = net.createServer(socket => {
    socket.setEncoding("utf8");
    socket.on("data", chunk => received.push(chunk));
    socket.on("error", () => {});
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  registerTeardownCallback(() => new Promise(resolve => server.close(resolve)));
  // The host's own environment lies about every one of these; the session must not.
  await startHost(workspace);
  const { env, childStatus, childError } = await sessionEnvironment(workspace, "profile", { tcpPort: server.address().port });
  const { WindowsSession: windowsSession, ...expected } = userProfilePaths();
  // Short and long forms of a path are the same folder.
  const longForm = value => {
    try {
      return fs.realpathSync.native(value).toLowerCase();
    } catch {
      return value.toLowerCase();
    }
  };
  // On a machine with per-session temp folders, Windows adds the session id to TEMP at logon.
  const withoutSessionFolder = value => value.replace(new RegExp(`\\\\${windowsSession}$`), "");
  for (const [name, value] of Object.entries(expected)) {
    const actual = envValue(env, name);
    assert.ok(actual, `${name} is missing`);
    assert.equal(longForm(name === "TEMP" ? withoutSessionFolder(actual) : actual), longForm(value), name);
  }
  assert.equal(childStatus, 0, childError);
  await waitUntil(() => received.join("").includes("from-session-child"), () => "the child's TCP write");
});

test("a value added under a CCDM_HOST_ENV_KEYS key after the host started appears in the next session", onlyWindows, async () => {
  const workspace = hostWorkspace();
  const reg = path.join(process.env.SystemRoot, "System32", "reg.exe");
  const root = `HKCU\\Software\\ccdm-e2e-${path.basename(workspace.tmpRoot)}`;
  const key = `${root}\\Environment`;
  const run = args => {
    const result = spawnSync(reg, args, { encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, `reg ${args.join(" ")}: ${result.stderr}`);
  };
  run(["add", key, "/f"]);
  registerTeardownCallback(() => { spawnSync(reg, ["delete", root, "/f"], { windowsHide: true }); });
  await startHost(workspace, { env: { CCDM_HOST_ENV_KEYS: key } });
  run(["add", key, "/v", "CCDM_P31A_NOT_SEEN", "/t", "REG_SZ", "/d", "stripped", "/f"]);
  run(["add", key, "/v", "P31A_FROM_REGISTRY", "/t", "REG_SZ", "/d", "registry value", "/f"]);
  run(["add", key, "/v", "PATH", "/t", "REG_SZ", "/d", "C:\\p3.1a\\added", "/f"]);
  const { env } = await sessionEnvironment(workspace, "regenv");
  assert.equal(env.P31A_FROM_REGISTRY, "registry value");
  assert.equal(env.CCDM_P31A_NOT_SEEN, undefined);
  const pathEntries = envValue(env, "PATH").split(";");
  assert.equal(pathEntries.at(-1), "C:\\p3.1a\\added", "the registry PATH is appended");
  assert.ok(pathEntries.length > 1, "the registry PATH replaced the base PATH");
});

test("nothing from the caller or host leaks into a session unless passed explicitly", onlyWindows, async () => {
  const workspace = hostWorkspace();
  const secretEnv = { CLAUDE_CONFIG_DIR: "leak-claude", CCDM_ROUTER_KEY_FILE: "leak-ccdm", MCP_SERVER_TOKEN: "leak-mcp", ANTHROPIC_API_KEY: "leak-anthropic" };
  await startHost(workspace, { env: secretEnv });
  const envFile = path.join(workspace.fixtures, "p3.1a.env");
  fs.writeFileSync(envFile, "# a comment\nP31A_FROM_FILE=file-value\nP31A_EQUALS=a=b\n");
  const { env } = await sessionEnvironment(workspace, "clean", { cliEnv: secretEnv });
  for (const name of Object.keys(secretEnv)) assert.equal(envValue(env, name), undefined, name);
  assert.equal(env.CCDM_SESSION_NAME, "clean");
  assert.equal(envValue(env, "CCDM_STATE_ROOT"), undefined);

  const passed = await sessionEnvironment(workspace, "passed", {
    extra: ["--env-file", envFile, "-e", "CLAUDE_CONFIG_DIR=explicit", "-e", "P31A_EXPLICIT=yes"],
    cliEnv: secretEnv,
  });
  assert.equal(envValue(passed.env, "CLAUDE_CONFIG_DIR"), "explicit");
  assert.equal(passed.env.P31A_FROM_FILE, "file-value");
  assert.equal(passed.env.P31A_EQUALS, "a=b");
  assert.equal(passed.env.P31A_EXPLICIT, "yes");
  assert.equal(envValue(passed.env, "CCDM_ROUTER_KEY_FILE"), undefined);
});

test("sessions.json lists live sessions, ping answers, and shutdown empties it and leaves no session process", onlyWindows, async () => {
  const workspace = hostWorkspace();
  const host = await startHost(workspace);
  await newSession(workspace, "one", echoSession(workspace));
  await newSession(workspace, "two", echoSession(workspace, "fixture-two"));
  await waitForCapture(workspace, "two", /fixture-two/);
  const journal = JSON.parse(fs.readFileSync(path.join(workspace.hostDir, "sessions.json"), "utf8"));
  assert.deepEqual(journal.sessions.map(session => session.name).sort(), ["one", "two"]);
  for (const session of journal.sessions) {
    assert.equal(session.env, undefined);
    trackPid(session.pid);
  }
  const roots = journal.sessions.map(({ pid }) => ({ pid, startedAt: tracked.get(pid) }));
  const connection = await authenticated(workspace);
  const pong = await ask(connection, { id: 1, op: "ping" });
  assert.equal(pong.ok, true);
  connection.destroy();
  await cliOk(workspace, ["shutdown"]);
  assert.equal(await host.closed, 0);
  await waitUntil(() => roots.every(entry => !isAlive(entry)), () => "sessions to stop on shutdown");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(workspace.hostDir, "sessions.json"), "utf8")).sessions, []);
  assert.equal(fs.existsSync(path.join(workspace.hostDir, "host.lock")), false);
});

test("serve inside a Job exits with a clear message unless --allow-in-job is passed", onlyWindows, async () => {
  const workspace = hostWorkspace();
  const jobs = path.join(workspace.repoDir, "scripts", "host", "jobs.js");
  const wrapper = fixture(workspace, "p3.1a-in-job.js", `
    const { spawn } = require("node:child_process");
    const job = require(${JSON.stringify(jobs)}).createSessionJob();
    job.assign(process.pid);
    const child = spawn(process.execPath, process.argv.slice(2), { stdio: "inherit", windowsHide: true });
    child.on("exit", code => process.exit(code ?? 1));
  `);
  const refused = serveProcess(workspace, { args: [], wrapper });
  const code = await refused.closed;
  assert.notEqual(code, 0);
  assert.match(refused.output.stderr, /Job object/);
  assert.match(refused.output.stderr, /--allow-in-job/);
  assert.equal(fs.existsSync(path.join(workspace.hostDir, "host.lock")), false);

  const allowed = serveProcess(workspace, { args: ["--allow-in-job"], wrapper });
  await waitUntil(() => /ready/.test(allowed.output.stdout), () => `allowed host ready: ${allowed.output.stderr}`, 15000);
  await cliOk(workspace, ["shutdown"]);
  await allowed.closed;
});

test("serve without koffi exits with a message that names it", onlyWindows, async () => {
  const workspace = hostWorkspace();
  const hide = fixture(workspace, "p3.1a-hide-koffi.cjs", `
    const Module = require("node:module");
    const resolve = Module._resolveFilename;
    Module._resolveFilename = function (request, ...rest) {
      if (request === "koffi") throw Object.assign(new Error("Cannot find module 'koffi'"), { code: "MODULE_NOT_FOUND" });
      return resolve.call(this, request, ...rest);
    };
  `);
  const host = serveProcess(workspace, { env: { NODE_OPTIONS: `--require ${hide.replace(/\\/g, "/")}` } });
  const code = await host.closed;
  assert.notEqual(code, 0);
  assert.match(host.output.stderr, /koffi/);
  assert.equal(fs.existsSync(path.join(workspace.hostDir, "host.lock")), false);
});

test("with no host every subcommand fails fast with the start hint and starts nothing", onlyWindows, async () => {
  const workspace = hostWorkspace();
  const subcommands = [
    ["new-session", "-d", "-s", "x", "--kind", "adhoc", "--no-pty", "--", process.execPath],
    ["has-session", "-t", "=x"],
    ["send-keys", "-t", "x", "hello"],
    ["capture-pane", "-t", "=x", "-p"],
    ["kill-session", "-t", "=x"],
    ["list-sessions"],
    ["display-message", "-t", "x", "-p", "#{pane_pid}"],
    ["pids", "-t", "x"],
    ["run-detached", "--log", "x.log", "--", process.execPath],
    ["shutdown"],
  ];
  for (const args of subcommands) {
    const result = await cli(workspace, args);
    assert.notEqual(result.code, 0, args[0]);
    assert.equal(result.stderr.trim(), NOT_RUNNING, args[0]);
    assert.ok(result.ms < 2000, `${args[0]} took ${Math.round(result.ms)} ms`);
  }
  // A daemon that started would have created its private directory, lock and pipe name.
  await sleep(300);
  assert.equal(fs.existsSync(workspace.hostDir), false, "a client started the daemon");
});

// ConPTY sessions. Every program here is a small Node console fixture.
const ptySession = (workspace, name, fixtureFile, { extra = [] } = {}) =>
  cliOk(workspace, ["new-session", "-d", "-s", name, "-c", workspace.fixtures, "--kind", "adhoc", ...extra, "--", process.execPath, fixtureFile]);

const STAY_ALIVE = "setInterval(() => {}, 1000);";

// The OpenConsole processes the host started. The host is ours and alive, and
// each one is checked to be younger than it, so a reused PID cannot pass.
function openConsolesOf(host) {
  const { processStartTime } = lazy("platform/process.js");
  const powershell = path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const script = `Get-CimInstance Win32_Process -Filter "ParentProcessId=${host.child.pid} AND Name='OpenConsole.exe'" | ForEach-Object { $_.ProcessId }`;
  const probe = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true });
  assert.equal(probe.status, 0, probe.stderr);
  const hostStarted = processStartTime(host.child.pid);
  return probe.stdout.trim().split(/\s+/).filter(Boolean).map(Number).map(trackPid)
    .filter(entry => entry.startedAt !== null && entry.startedAt >= hostStarted);
}

async function waitForHasSessionFalse(workspace, name) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if ((await cli(workspace, ["has-session", "-t", `=${name}`])).code === 1) return;
    await sleep(25);
  }
  throw new Error(`${name} never ended`);
}

test("wait-for --then-send Enter accepts a prompt that appears later, and the program's next output reaches capture-pane", onlyWindows, async () => {
  const workspace = hostWorkspace();
  await startHost(workspace);
  const dialog = fixture(workspace, "p3.1b-dialog.js", `
    setTimeout(() => console.log("Do you trust this folder? Press Enter"), 500);
    process.stdin.once("data", () => console.log("trusted-next"));
    ${STAY_ALIVE}
  `);
  await ptySession(workspace, "dialog", dialog);
  const accepted = await cliOk(workspace, ["wait-for", "-t", "=dialog", "--regex", "trust this folder", "--timeout", "30", "--then-send", "Enter"], { timeoutMs: 40000 });
  assert.match(accepted.stdout, /trust this folder/);
  await waitForCapture(workspace, "dialog", /trusted-next/);
  await cliOk(workspace, ["kill-session", "-t", "=dialog", "--grace", "0"]);
});

test("wait-for with a regex that never appears gives matched:false and the last screen after the timeout, and the CLI exits 1", onlyWindows, async () => {
  const workspace = hostWorkspace();
  await startHost(workspace);
  const quiet = fixture(workspace, "p3.1b-quiet.js", `console.log("quiet-screen"); ${STAY_ALIVE}`);
  await ptySession(workspace, "quiet", quiet);
  await waitForCapture(workspace, "quiet", /quiet-screen/);
  const missed = await cli(workspace, ["wait-for", "-t", "=quiet", "--regex", "never-appears", "--timeout", "1", "--then-send", "Enter"]);
  assert.equal(missed.code, 1, missed.stderr);
  assert.match(missed.stdout, /quiet-screen/);
  const connection = await authenticated(workspace);
  const reply = await ask(connection, { id: 1, op: "wait", name: "quiet", regex: "never-appears", timeoutMs: 300 });
  assert.equal(reply.matched, false);
  assert.ok(reply.ms >= 300, `the wait returned after ${reply.ms} ms`);
  assert.match(reply.screen, /quiet-screen/);
  const invalid = await ask(connection, { id: 2, op: "wait", name: "quiet", regex: "(", timeoutMs: 10 });
  assert.equal(invalid.ok, false);
  assert.match(invalid.message, /invalid regex/);
});

test("a wait whose client went away sends nothing when its prompt appears later", onlyWindows, async () => {
  const workspace = hostWorkspace();
  await startHost(workspace);
  const trigger = path.join(workspace.fixtures, "p3.1b-trigger.txt");
  const late = fixture(workspace, "p3.1b-late.js", `
    const fs = require("node:fs");
    process.stdin.once("data", () => console.log("got-enter"));
    console.log("waiting-for-trigger");
    const timer = setInterval(() => {
      if (fs.existsSync(${JSON.stringify(trigger)})) { clearInterval(timer); console.log("late-prompt"); }
    }, 20);
    ${STAY_ALIVE}
  `);
  await ptySession(workspace, "late", late);
  await waitForCapture(workspace, "late", /waiting-for-trigger/);
  const connection = await authenticated(workspace);
  connection.send({ id: 1, op: "wait", name: "late", regex: "late-prompt", timeoutMs: 30000, thenSend: ["Enter"] });
  await sleep(200);
  connection.destroy();
  await sleep(200);
  fs.writeFileSync(trigger, "go");
  await waitForCapture(workspace, "late", /late-prompt/);
  await sleep(500);
  assert.doesNotMatch(await capture(workspace, "late"), /got-enter/);
});

test("a program that sends DA1 gets a reply in under a second, and its first screen is not held back", onlyWindows, async () => {
  const workspace = hostWorkspace();
  await startHost(workspace);
  const report = path.join(workspace.fixtures, "p3.1b-da1.json");
  const da1 = fixture(workspace, "p3.1b-da1.js", `
    const fs = require("node:fs");
    process.stdin.setRawMode(true);
    process.stdin.setEncoding("utf8");
    console.log("first-screen");
    let reply = "";
    let started;
    process.stdin.on("data", chunk => {
      reply += chunk;
      if (/\\x1b\\[\\?[0-9;]*c/.test(reply)) {
        fs.writeFileSync(${JSON.stringify(report)}, JSON.stringify({ ms: performance.now() - started, reply }));
      }
    });
    setTimeout(() => { started = performance.now(); process.stdout.write("\\x1b[c"); }, 300);
    ${STAY_ALIVE}
  `);
  const started = performance.now();
  await ptySession(workspace, "da1", da1);
  await waitForCapture(workspace, "da1", /first-screen/);
  // Without an answer from the headless terminal the first screen takes over 3 s.
  assert.ok(performance.now() - started < scaledTimeout(2500), "the first screen was held back");
  await waitUntil(() => fs.existsSync(report), () => "the DA1 reply", 5000);
  const { ms, reply } = JSON.parse(fs.readFileSync(report, "utf8"));
  assert.ok(ms < 1000, `the DA1 reply took ${ms} ms`);
  assert.match(reply, /\x1b\[\?[0-9;]*c/);
});

test("after the program exits has-session is false and capture-pane still shows its last screen until kill-session", onlyWindows, async () => {
  const workspace = hostWorkspace();
  await startHost(workspace);
  const brief = fixture(workspace, "p3.1b-brief.js", `console.log("final-screen-line"); process.exit(7);`);
  await ptySession(workspace, "brief", brief);
  await waitForHasSessionFalse(workspace, "brief");
  assert.match(await capture(workspace, "brief"), /final-screen-line/);
  assert.equal((await cliOk(workspace, ["pids", "-t", "brief"])).stdout, "");
  const connection = await authenticated(workspace);
  const listed = (await ask(connection, { id: 1, op: "list" })).sessions.find(session => session.name === "brief");
  assert.equal(listed.exit, 7);
  assert.equal(listed.pty, true);
  const ended = await ask(connection, { id: 2, op: "wait", name: "brief", regex: "final-screen-line", timeoutMs: 10 });
  assert.equal(ended.matched, true);
  const cannotSend = await ask(connection, { id: 3, op: "wait", name: "brief", regex: "final-screen-line", timeoutMs: 10, thenSend: ["Enter"] });
  assert.equal(cannotSend.matched, false);
  await cliOk(workspace, ["kill-session", "-t", "=brief"]);
  const released = await cli(workspace, ["capture-pane", "-t", "=brief", "-p"]);
  assert.equal(released.code, 1);
});

test("a session ends with its root program even when a child is still attached to the console", onlyWindows, async () => {
  const workspace = hostWorkspace();
  await startHost(workspace);
  const report = path.join(workspace.fixtures, "p3.1b-lingering.json");
  const lingering = fixture(workspace, "p3.1b-lingering.js", `
    const { spawn } = require("node:child_process");
    const fs = require("node:fs");
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "inherit" });
    fs.writeFileSync(${JSON.stringify(report)}, JSON.stringify({ child: child.pid }));
    console.log("root-leaving");
    setTimeout(() => process.exit(0), 300);
  `);
  await ptySession(workspace, "lingering", lingering);
  await waitUntil(() => fs.existsSync(report), () => "the fixture's report");
  const lingerer = trackPid(JSON.parse(fs.readFileSync(report, "utf8")).child);
  await waitForHasSessionFalse(workspace, "lingering");
  await waitUntil(() => !isAlive(lingerer), () => "the attached child to be gone");
  assert.match(await capture(workspace, "lingering"), /root-leaving/);
});

test("kill-session on a PTY session removes the program, OpenConsole and a detached grandchild, and pids is then empty", onlyWindows, async () => {
  const workspace = hostWorkspace();
  const host = await startHost(workspace);
  const report = path.join(workspace.fixtures, "p3.1b-tree.json");
  const tree = fixture(workspace, "p3.1b-tree.js", `
    const { spawn } = require("node:child_process");
    const fs = require("node:fs");
    const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore", windowsHide: true });
    grandchild.unref();
    fs.writeFileSync(${JSON.stringify(report)}, JSON.stringify({ child: process.pid, grandchild: grandchild.pid }));
    console.log("tree-ready");
    // Ignores the console closing, so only the Job can stop it inside the grace.
    process.on("SIGHUP", () => {});
    ${STAY_ALIVE}
  `);
  await ptySession(workspace, "tree", tree);
  await waitForCapture(workspace, "tree", /tree-ready/);
  const { child, grandchild } = JSON.parse(fs.readFileSync(report, "utf8"));
  const consoles = openConsolesOf(host);
  assert.equal(consoles.length, 1, "expected one OpenConsole for the session");
  const processes = [trackPid(child), trackPid(grandchild), ...consoles];
  assert.ok(processes.every(isAlive), "the fixture tree did not start");
  const jobPids = (await cliOk(workspace, ["pids", "-t", "tree"])).stdout.trim().split("\n").map(Number);
  assert.ok(jobPids.includes(child));
  assert.ok(jobPids.includes(grandchild));

  await cliOk(workspace, ["kill-session", "-t", "=tree", "--grace", "300"]);
  await waitUntil(() => processes.every(entry => !isAlive(entry)), () => "the program, OpenConsole and the grandchild to be gone");
  assert.equal((await cliOk(workspace, ["pids", "-t", "tree"])).stdout, "");
  assert.equal((await cli(workspace, ["has-session", "-t", "=tree"])).code, 1);
  assert.deepEqual(openConsolesOf(host), []);
});

test("the grace phase closes the pseudo-console, so a program that handles SIGHUP ends before the Job is used", onlyWindows, async () => {
  const workspace = hostWorkspace();
  await startHost(workspace);
  const marker = path.join(workspace.fixtures, "p3.1b-hup.txt");
  const graceful = fixture(workspace, "p3.1b-hup.js", `
    const fs = require("node:fs");
    process.on("SIGHUP", () => { fs.writeFileSync(${JSON.stringify(marker)}, "hup"); process.exit(0); });
    console.log("up");
    ${STAY_ALIVE}
  `);
  await ptySession(workspace, "hup", graceful);
  await waitForCapture(workspace, "hup", /up/);
  const started = performance.now();
  await cliOk(workspace, ["kill-session", "-t", "=hup", "--grace", "8000"]);
  assert.ok(performance.now() - started < 7000, "the grace wait did not end when the program did");
  assert.equal(fs.readFileSync(marker, "utf8"), "hup");
});

test("send-keys maps tmux key names for a console program and -l sends text as is", onlyWindows, async () => {
  const workspace = hostWorkspace();
  await startHost(workspace);
  const report = path.join(workspace.fixtures, "p3.1b-keys.txt");
  const keys = fixture(workspace, "p3.1b-keys.js", `
    const fs = require("node:fs");
    process.stdin.setRawMode(true);
    process.stdin.on("data", chunk => fs.appendFileSync(${JSON.stringify(report)}, chunk.toString("hex") + "\\n"));
    console.log("keys-ready");
    ${STAY_ALIVE}
  `);
  await ptySession(workspace, "keys", keys);
  await waitForCapture(workspace, "keys", /keys-ready/);
  const received = () => fs.existsSync(report) ? fs.readFileSync(report, "utf8").trim().split("\n") : [];
  for (const [args, expected] of [
    [["Escape"], "1b"],
    [["C-c"], "03"],
    [["Tab"], "09"],
    [["BSpace"], "7f"],
    [["Up"], "1b5b41"],
    [["Enter"], "0d"],
    [["-l", "Enter"], Buffer.from("Enter").toString("hex")],
  ]) {
    const before = received().length;
    await cliOk(workspace, ["send-keys", "-t", "=keys", ...args]);
    await waitUntil(() => received().length > before && received().slice(before).join("") === expected,
      () => `${args.join(" ")} to arrive as ${expected}; got ${received().slice(before).join(",")}`);
  }
});

test("capture-pane -S - returns lines scrolled off the screen, and -J puts a wrapped 300-character URL back on one line", onlyWindows, async () => {
  const workspace = hostWorkspace();
  await startHost(workspace);
  const url = `https://example.test/${"a".repeat(279)}`;
  assert.equal(url.length, 300);
  const printer = fixture(workspace, "p3.1b-printer.js", `
    for (let i = 0; i < 120; i += 1) console.log("line-" + i);
    console.log(${JSON.stringify(url)});
    console.log("printer-done");
    ${STAY_ALIVE}
  `);
  await ptySession(workspace, "printer", printer);
  await waitForCapture(workspace, "printer", /printer-done/);

  const screen = await capture(workspace, "printer");
  assert.doesNotMatch(screen, /^line-0$/m);
  assert.equal(screen.split("\n").length - 1, 50);
  const history = await capture(workspace, "printer", ["-S", "-"]);
  for (const line of ["line-0", "line-60", "line-119"]) assert.match(history, new RegExp(`^${line}$`, "m"));
  const lastTen = await capture(workspace, "printer", ["-S", "-10"]);
  assert.equal(lastTen.split("\n").length - 1, 60);

  assert.equal(screen.split("\n").includes(url), false);
  assert.ok(screen.split("\n").includes(url.slice(0, 200)), "without -J the URL stays wrapped at 200 columns");
  assert.ok((await capture(workspace, "printer", ["-J"])).split("\n").includes(url), "-J did not unwrap the URL");
  assert.ok((await capture(workspace, "printer", ["-S", "-", "-J"])).split("\n").includes(url), "-S - -J did not unwrap the URL");
});

test("wide characters are captured without shifting the line", onlyWindows, async () => {
  const workspace = hostWorkspace();
  await startHost(workspace);
  // The second write lands in a later frame, so OpenConsole repaints only that
  // cell by column: it lands right only if the screen counts the emoji as two wide.
  const wide = fixture(workspace, "p3.1b-wide.js", `
    console.log("│漢字🙂│");
    process.stdout.write("🙂ab");
    setTimeout(() => { process.stdout.write("\\x1b[4GZ\\n"); console.log("wide-done"); }, 400);
    ${STAY_ALIVE}
  `);
  await ptySession(workspace, "wide", wide);
  const lines = (await waitForCapture(workspace, "wide", /wide-done/)).split("\n");
  assert.ok(lines.includes("│漢字🙂│"), `captured: ${lines.slice(0, 3).join("|")}`);
  assert.ok(lines.includes("🙂aZ"), `captured: ${lines.slice(0, 3).join("|")}`);
});

test("shutdown ends PTY sessions and their consoles", onlyWindows, async () => {
  const workspace = hostWorkspace();
  const host = await startHost(workspace);
  const report = path.join(workspace.fixtures, "p3.1b-stop.json");
  const stopped = fixture(workspace, "p3.1b-stop.js", `
    require("node:fs").writeFileSync(${JSON.stringify(report)}, String(process.pid));
    console.log("up");
    ${STAY_ALIVE}
  `);
  await ptySession(workspace, "stopped", stopped);
  await waitForCapture(workspace, "stopped", /up/);
  const processes = [trackPid(Number(fs.readFileSync(report, "utf8"))), ...openConsolesOf(host)];
  assert.equal(processes.length, 2);
  await cliOk(workspace, ["shutdown"]);
  assert.equal(await host.closed, 0);
  await waitUntil(() => processes.every(entry => !isAlive(entry)), () => "the program and OpenConsole to stop on shutdown");
});

test("without node-pty a PTY session is refused with a message that names it, and no-PTY sessions still start", onlyWindows, async () => {
  const workspace = hostWorkspace();
  const hide = fixture(workspace, "p3.1b-hide-pty.cjs", `
    const Module = require("node:module");
    const resolve = Module._resolveFilename;
    Module._resolveFilename = function (request, ...rest) {
      if (request === "node-pty") throw Object.assign(new Error("Cannot find module 'node-pty'"), { code: "MODULE_NOT_FOUND" });
      return resolve.call(this, request, ...rest);
    };
  `);
  await startHost(workspace, { env: { NODE_OPTIONS: `--require ${hide.replace(/\\/g, "/")}` } });
  const refused = await cli(workspace, ["new-session", "-d", "-s", "p", "-c", workspace.fixtures, "--kind", "adhoc", "--", process.execPath, "-v"]);
  assert.notEqual(refused.code, 0);
  assert.match(refused.stderr, /node-pty/);
  await newSession(workspace, "plain", echoSession(workspace));
  await waitForCapture(workspace, "plain", /fixture-up/);
});

test("a PTY program that cannot start gets spawn_failed and leaves no console behind", onlyWindows, async () => {
  const workspace = hostWorkspace();
  const host = await startHost(workspace);
  const connection = await authenticated(workspace);
  for (const [id, frame] of [
    [1, { argv: ["no-such-program-p3-1b"], cwd: workspace.fixtures }],
    [2, { argv: [path.join(workspace.fixtures, "p3.1b-missing.exe")], cwd: workspace.fixtures }],
    [3, { argv: [process.execPath], cwd: path.join(workspace.fixtures, "p3.1b-no-such-dir") }],
  ]) {
    const reply = await ask(connection, { id, op: "new", name: "bad", env: {}, pty: true, kind: "adhoc", ...frame });
    assert.equal(reply.error, "spawn_failed", JSON.stringify(reply));
  }
  assert.equal((await ask(connection, { id: 4, op: "has", name: "bad" })).live, false);
  assert.deepEqual(openConsolesOf(host), []);
});

test("a PTY session is launched with its own environment and kept in its Job, and a named log gets its output", onlyWindows, async () => {
  const workspace = hostWorkspace();
  await startHost(workspace);
  const report = path.join(workspace.fixtures, "p3.1b-ptyenv.json");
  const log = path.join(workspace.fixtures, "p3.1b-pty.log");
  const reporter = fixture(workspace, "p3.1b-ptyenv.js", `
    const fs = require("node:fs");
    fs.writeFileSync(${JSON.stringify(report)}, JSON.stringify({ pid: process.pid, env: process.env, argv: process.argv.slice(2), isTTY: process.stdout.isTTY }));
    console.log("env-written");
    ${STAY_ALIVE}
  `);
  await cliOk(workspace, ["new-session", "-d", "-s", "ptyenv", "-c", workspace.fixtures, "--kind", "adhoc", "-e", "P31B_EXPLICIT=value with space", "--log", log,
    "--", process.execPath, reporter, "arg with space", 'quote"inside'], { env: { CCDM_ROUTER_KEY_FILE: "leak" } });
  await waitForCapture(workspace, "ptyenv", /env-written/);
  const seen = JSON.parse(fs.readFileSync(report, "utf8"));
  assert.equal(seen.isTTY, true);
  assert.deepEqual(seen.argv, ["arg with space", 'quote"inside']);
  assert.equal(seen.env.P31B_EXPLICIT, "value with space");
  assert.equal(seen.env.CCDM_SESSION_NAME, "ptyenv");
  assert.equal(envValue(seen.env, "CCDM_ROUTER_KEY_FILE"), undefined);
  assert.ok((await cliOk(workspace, ["pids", "-t", "ptyenv"])).stdout.trim().split("\n").map(Number).includes(seen.pid));
  await cliOk(workspace, ["kill-session", "-t", "=ptyenv", "--grace", "0"]);
  assert.match(fs.readFileSync(log, "utf8"), /env-written/);
});

// Attach. The client runs under its own pseudo-console, standing in for a terminal tab.
const attachClient = (workspace, args) => consoleClient(workspace, [process.execPath, workspace.script, "attach", ...args]);

function consoleClient(workspace, argv) {
  const job = lazy("host/jobs.js").createSessionJob();
  let ended;
  const exited = new Promise(resolve => { ended = resolve; });
  const terminal = lazy("host/pty.js").startConsole({
    argv,
    cwd: workspace.fixtures,
    env: workspace.childEnv(),
    job,
    onEnd: code => {
      job.close();
      ended(code);
    },
  });
  registerTeardownCallback(async () => {
    try {
      job.terminate(1);
    } catch { /* It already ended. */ }
    await Promise.race([exited, sleep(5000)]);
  });
  return { exited, screen: () => terminal.capture({}), type: text => terminal.send([text], true), resize: (cols, rows) => terminal.resize(cols, rows) };
}

// Prints a marker, then reports each piece of raw input and every window size it has.
function attachFixture(workspace, sizeReport = path.join(workspace.fixtures, "p3.1c-size.txt")) {
  const file = fixture(workspace, "p3.1c-attach.js", `
    const fs = require("node:fs");
    process.stdin.setRawMode(true);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", chunk => {
      if (chunk === "q") process.exit(3);
      console.log("got:" + chunk);
    });
    let last = "";
    setInterval(() => {
      const size = process.stdout.getWindowSize().join("x");
      if (size !== last) fs.appendFileSync(${JSON.stringify(sizeReport)}, size + "\\n");
      last = size;
    }, 25);
    console.log("before-attach");
  `);
  const sizes = () => fs.existsSync(sizeReport) ? fs.readFileSync(sizeReport, "utf8").trim().split("\n") : [];
  return { file, sizes, currentSize: () => sizes().at(-1) };
}

const plainText = text => text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");

// Reads stream frames until their output contains `text`.
async function readOutputUntil(connection, text) {
  let seen = "";
  while (!plainText(seen).includes(text)) {
    const frame = await connection.next();
    assert.ok(frame, `the connection closed before ${text}; saw ${JSON.stringify(seen)}`);
    if (frame.out) seen += frame.out;
  }
}

async function attachFrames(workspace, name, options = {}) {
  const connection = await authenticated(workspace);
  const reply = await ask(connection, { id: "attach", op: "attach", name, ...options });
  assert.equal(reply.ok, true, JSON.stringify(reply));
  assert.equal(reply.id, "attach");
  return { connection, reply };
}

test("attach shows what the session already printed, typed input reaches it, and Ctrl-] exits 0 with the session still live", onlyWindows, async () => {
  const workspace = hostWorkspace();
  await startHost(workspace);
  await ptySession(workspace, "live", attachFixture(workspace).file);
  await waitForCapture(workspace, "live", /before-attach/);

  const client = attachClient(workspace, ["-t", "=live"]);
  await waitUntil(() => client.screen().includes("before-attach"), () => `the replayed screen; saw ${client.screen()}`, 10000);

  client.type("hello");
  await waitForCapture(workspace, "live", /got:hello/);
  await waitUntil(() => client.screen().includes("got:hello"), () => `live output in the client; saw ${client.screen()}`);

  client.type("\x1d");
  assert.equal(await client.exited, 0);
  assert.equal((await cli(workspace, ["has-session", "-t", "=live"])).code, 0);
  assert.doesNotMatch(await capture(workspace, "live"), /got:\x1d/);
  await cliOk(workspace, ["send-keys", "-t", "=live", "-l", "after"]);
  await waitForCapture(workspace, "live", /got:after/);
});

for (const flag of ["-r", "--read-only"]) {
  test(`attach ${flag} shows the screen, drops input and still leaves with Ctrl-]`, onlyWindows, async () => {
    const workspace = hostWorkspace();
    await startHost(workspace);
    const { file, currentSize } = attachFixture(workspace);
    await ptySession(workspace, "watched", file);
    await waitForCapture(workspace, "watched", /before-attach/);

    const client = attachClient(workspace, ["-t", "=watched", flag]);
    await waitUntil(() => client.screen().includes("before-attach"), () => `the replayed screen; saw ${client.screen()}`, 10000);
    client.type("dropped");
    await sleep(500);
    assert.doesNotMatch(await capture(workspace, "watched"), /got:/);
    assert.equal(currentSize(), "200x50");

    client.type("\x1d");
    assert.equal(await client.exited, 0);
    assert.equal((await cli(workspace, ["has-session", "-t", "=watched"])).code, 0);
  });
}

test("a read-only attach never resizes, the last writer sets the size, and the fixed size comes back when writers leave", onlyWindows, async () => {
  const workspace = hostWorkspace();
  await startHost(workspace);
  const { file, currentSize } = attachFixture(workspace);
  await ptySession(workspace, "sized", file);
  await waitForCapture(workspace, "sized", /before-attach/);
  await waitUntil(() => currentSize() === "200x50", () => "the fixture's first size report");
  const sizeIs = expected => waitUntil(() => currentSize() === expected, () => `size ${expected}; saw ${currentSize()}`);

  const watcher = await attachFrames(workspace, "sized", { readOnly: true, size: [80, 24] });
  assert.equal(watcher.reply.cols, 200);
  assert.equal(watcher.reply.rows, 50);
  assert.match(watcher.reply.snapshot, /before-attach/);
  assert.equal(watcher.reply.exit, null);
  watcher.connection.send({ resize: [90, 20] });
  watcher.connection.send({ in: "dropped" });
  await sleep(400);
  assert.equal(currentSize(), "200x50");
  assert.doesNotMatch(await capture(workspace, "sized"), /got:/);

  const first = await attachFrames(workspace, "sized", { readOnly: false, size: [100, 30] });
  assert.equal(first.reply.cols, 100);
  assert.equal(first.reply.rows, 30);
  await sizeIs("100x30");

  const second = await attachFrames(workspace, "sized", { readOnly: false });
  second.connection.send({ resize: [120, 40] });
  await sizeIs("120x40");
  second.connection.send({ resize: [0, 40] });

  // Both clients and the read-only one see the same live output.
  first.connection.send({ in: "shared" });
  await Promise.all([first, second, watcher].map(({ connection }) => readOutputUntil(connection, "got:shared")));

  second.connection.send({ detach: true });
  await sizeIs("100x30");
  // A client that goes away without saying so counts as leaving.
  first.connection.destroy();
  await sizeIs("200x50");
  assert.equal((await cli(workspace, ["has-session", "-t", "=sized"])).code, 0);
});

test("output printed while attaching is neither lost nor shown twice", onlyWindows, async () => {
  const workspace = hostWorkspace();
  await startHost(workspace);
  // Prints until the test says stop, so a slow machine cannot finish it before the attach.
  const stop = path.join(workspace.fixtures, "p3.1c-counter-stop.txt");
  const counter = fixture(workspace, "p3.1c-counter.js", `
    const fs = require("node:fs");
    let i = 0;
    const timer = setInterval(() => {
      for (let n = 0; n < 5; n += 1) console.log("count-" + (i++) + "-end");
      if (fs.existsSync(${JSON.stringify(stop)})) { clearInterval(timer); console.log("counter-done"); }
    }, 5);
    ${STAY_ALIVE}
  `);
  await ptySession(workspace, "counter", counter);
  await waitForCapture(workspace, "counter", /count-\d+-end/);
  const { connection, reply } = await attachFrames(workspace, "counter");
  const numbers = text => [...plainText(text).matchAll(/count-(\d+)-end/g)].map(match => Number(match[1]));
  let stream = "";
  while (!plainText(stream).includes("counter-done")) {
    const frame = await connection.next();
    assert.ok(frame, "the stream closed early");
    if (frame.out) stream += frame.out;
    if (numbers(stream).length > 0 && !fs.existsSync(stop)) fs.writeFileSync(stop, "stop");
  }
  const before = numbers(reply.snapshot);
  const after = numbers(stream);
  assert.ok(before.length > 0, "the snapshot had no counter lines");
  assert.ok(after.length > 0, "the stream had no counter lines");
  // Joined, because a line can be split between the snapshot and the first chunk.
  const combined = numbers(reply.snapshot + stream);
  for (let index = 1; index < combined.length; index += 1) {
    assert.equal(combined[index], combined[index - 1] + 1, `gap or repeat at ${index}: ${combined.slice(Math.max(0, index - 3), index + 2)}`);
  }
});

test("attaching to an ended session shows its last screen and exit code, and a released one is unknown", onlyWindows, async () => {
  const workspace = hostWorkspace();
  await startHost(workspace);
  const brief = fixture(workspace, "p3.1c-brief.js", `console.log("final-screen-line"); process.exit(7);`);
  await ptySession(workspace, "over", brief);
  await waitForHasSessionFalse(workspace, "over");

  const { connection, reply } = await attachFrames(workspace, "over", { size: [80, 24] });
  assert.match(reply.snapshot, /final-screen-line/);
  assert.equal(reply.exit, 7);
  assert.equal(reply.cols, 200);
  assert.deepEqual(await connection.next(), { exit: 7 });

  const client = attachClient(workspace, ["-t", "=over"]);
  assert.equal(await client.exited, 0);
  assert.match(client.screen(), /final-screen-line/);
  assert.match(client.screen(), /\[session over ended with code 7\]/);

  await cliOk(workspace, ["kill-session", "-t", "=over"]);
  assert.equal((await ask(connection, { id: 2, op: "attach", name: "over" })).error, "unknown_session");
  assert.equal((await ask(connection, { id: 3, op: "attach", name: "ghost" })).error, "unknown_session");
});

test("an attached client gets {exit} when the session ends, and the attach command then exits 0", onlyWindows, async () => {
  const workspace = hostWorkspace();
  await startHost(workspace);
  await ptySession(workspace, "ending", attachFixture(workspace).file);
  await waitForCapture(workspace, "ending", /before-attach/);
  const { connection } = await attachFrames(workspace, "ending");
  const client = attachClient(workspace, ["-t", "=ending"]);
  await waitUntil(() => client.screen().includes("before-attach"), () => `the replayed screen; saw ${client.screen()}`, 10000);

  client.type("q");
  let frame;
  do {
    frame = await connection.next();
    assert.ok(frame, "the stream closed without an exit frame");
  } while (frame.exit === undefined);
  assert.equal(frame.exit, 3);
  assert.equal(await client.exited, 0);
  assert.match(client.screen(), /\[session ending ended with code 3\]/);
});

test("attach needs a terminal, and without the serialize package it fails with a message that names it", onlyWindows, async () => {
  const workspace = hostWorkspace();
  const hide = fixture(workspace, "p3.1c-hide-serialize.cjs", `
    const Module = require("node:module");
    const resolve = Module._resolveFilename;
    Module._resolveFilename = function (request, ...rest) {
      if (request === "@xterm/addon-serialize") throw Object.assign(new Error("Cannot find module"), { code: "MODULE_NOT_FOUND" });
      return resolve.call(this, request, ...rest);
    };
  `);
  await startHost(workspace, { env: { NODE_OPTIONS: `--require ${hide.replace(/\\/g, "/")}` } });
  await ptySession(workspace, "plain", attachFixture(workspace).file);
  await waitForCapture(workspace, "plain", /before-attach/);
  const notTerminal = await cli(workspace, ["attach", "-t", "=plain"]);
  assert.equal(notTerminal.code, 1);
  assert.match(notTerminal.stderr, /needs a terminal/);
  const connection = await authenticated(workspace);
  const reply = await ask(connection, { id: 1, op: "attach", name: "plain" });
  assert.equal(reply.ok, false);
  assert.match(reply.message, /@xterm\/addon-serialize/);
  assert.equal((await ask(connection, { id: 2, op: "has", name: "plain" })).live, true);
});

test("a run-detached helper outlives the session that asked for it, logs to the requested file, and sees the request's env without CCDM_SESSION_NAME", onlyWindows, async () => {
  const workspace = hostWorkspace();
  await startHost(workspace);
  const log = path.join(workspace.fixtures, "logs-p3.1c", "helper.log");
  fs.mkdirSync(path.dirname(log));
  fs.writeFileSync(log, "existing-line\n");
  const report = path.join(workspace.fixtures, "p3.1c-helper.json");
  const requested = path.join(workspace.fixtures, "p3.1c-requested.json");
  const helper = fixture(workspace, "p3.1c-helper.js", `
    require("node:fs").writeFileSync(${JSON.stringify(report)}, JSON.stringify({ env: process.env }));
    console.log("helper-stdout");
    console.error("helper-stderr");
    ${STAY_ALIVE}
  `);
  const session = fixture(workspace, "p3.1c-asks.js", `
    const { spawnSync } = require("node:child_process");
    const result = spawnSync(process.execPath, [${JSON.stringify(workspace.script)}, "run-detached", "--log", ${JSON.stringify(log)},
      "-e", "P31C_HELPER=from request", "-e", "CCDM_SESSION_NAME=passed-along", "--", process.execPath, ${JSON.stringify(helper)}], { encoding: "utf8", windowsHide: true });
    require("node:fs").writeFileSync(${JSON.stringify(requested)}, JSON.stringify({ status: result.status, stdout: result.stdout, stderr: result.stderr }));
    console.log("asked");
    ${STAY_ALIVE}
  `);
  await ptySession(workspace, "asker", session, { extra: ["-e", `CCDM_STATE_ROOT=${workspace.stateRoot}`] });
  await waitForCapture(workspace, "asker", /asked/);
  const { status, stdout, stderr } = JSON.parse(fs.readFileSync(requested, "utf8"));
  assert.equal(status, 0, stderr);
  const started = trackPid(Number(stdout.trim()));
  assert.ok(started.pid > 0 && isAlive(started), "the helper did not start");
  await waitUntil(() => fs.existsSync(report), () => "the helper's report");
  const jobPids = (await cliOk(workspace, ["pids", "-t", "=asker"])).stdout.trim().split("\n").map(Number);
  assert.equal(jobPids.includes(started.pid), false, "the helper is in the session's Job");

  await cliOk(workspace, ["kill-session", "-t", "=asker", "--grace", "300"]);
  await sleep(500);
  assert.equal(isAlive(started), true, "the helper died with the session");

  await waitUntil(() => /helper-stderr/.test(fs.readFileSync(log, "utf8")), () => "the helper's stderr in its log");
  const logged = fs.readFileSync(log, "utf8");
  assert.match(logged, /^existing-line\r?\n/);
  assert.match(logged, /helper-stdout/);
  const { env } = JSON.parse(fs.readFileSync(report, "utf8"));
  assert.equal(env.P31C_HELPER, "from request");
  assert.equal(envValue(env, "CCDM_SESSION_NAME"), undefined);
  assert.equal(envValue(env, "CCDM_STATE_ROOT"), undefined);
  assert.ok(envValue(env, "USERPROFILE"), "the helper did not get the rebuilt profile");
  process.kill(started.pid);
  await waitUntil(() => !isAlive(started), () => "the helper to stop");
});

test("run-detached refuses a bad request with spawn_failed and needs --log on the command line", onlyWindows, async () => {
  const workspace = hostWorkspace();
  await startHost(workspace);
  const connection = await authenticated(workspace);
  const log = path.join(workspace.fixtures, "p3.1c-refused.log");
  for (const [id, frame] of [
    [1, { argv: ["no-such-program-p3-1c.exe"], cwd: workspace.fixtures, env: {}, log }],
    [2, { argv: [], cwd: workspace.fixtures, env: {}, log }],
    [3, { argv: [process.execPath], cwd: workspace.fixtures, env: {}, log: "relative.log" }],
  ]) {
    assert.equal((await ask(connection, { id, op: "run-detached", ...frame })).error, "spawn_failed", String(id));
  }
  const noLog = await cli(workspace, ["run-detached", "--", process.execPath]);
  assert.equal(noLog.code, 2);
  assert.match(noLog.stderr, /--log/);
});

test("a subscribe client gets one exit event with the code for each session that ends", onlyWindows, async () => {
  const workspace = hostWorkspace();
  await startHost(workspace);
  const connection = await authenticated(workspace);
  const subscribed = await ask(connection, { id: "sub", op: "subscribe" });
  assert.equal(subscribed.ok, true);
  assert.equal(subscribed.id, "sub");

  const brief = fixture(workspace, "p3.1c-exits.js", `console.log("leaving"); process.exit(4);`);
  await ptySession(workspace, "pty-end", brief);
  assert.deepEqual(await connection.next(), { event: "exit", name: "pty-end", code: 4 });
  // Releasing an ended session is not a second end: the next event is for another session.
  await cliOk(workspace, ["kill-session", "-t", "=pty-end"]);
  await newSession(workspace, "plain-end", brief);
  assert.deepEqual(await connection.next(), { event: "exit", name: "plain-end", code: 4 });

  connection.destroy();
  await newSession(workspace, "unheard", brief);
  await waitForHasSessionFalse(workspace, "unheard");
});

// Keep-awake: the host with CCDM_HOST_KEEP_AWAKE=1 and the fake power seam, which
// keeps what it holds in a file. No test here reaches the Windows power calls.
const POWER_POLL_MS = 50;

function powerWorkspace() {
  const workspace = hostWorkspace();
  const powerDir = path.join(workspace.tmpRoot, "p5.2-power");
  const powerEnv = { CCDM_HOST_KEEP_AWAKE: "1", CCDM_HOST_POWER_FAKE: powerDir, CCDM_HOST_POWER_POLL_MS: String(POWER_POLL_MS) };
  return { ...workspace, powerDir, powerEnv };
}

function readPower(workspace) {
  try {
    return JSON.parse(fs.readFileSync(path.join(workspace.powerDir, "requests.json"), "utf8"));
  } catch {
    return null;
  }
}

const holds = (workspace, expected) => waitUntil(
  () => (JSON.stringify(readPower(workspace)?.held) === JSON.stringify(expected) ? readPower(workspace) : null),
  `the power seam to hold ${JSON.stringify(expected)}`,
);
const setPowerSource = (workspace, source) => fs.writeFileSync(path.join(workspace.powerDir, "ac"), source);
// Long enough for several polls of the power source to have run.
const severalPolls = () => sleep(POWER_POLL_MS * 8);

// Exits as soon as anything arrives on stdin, so a test can end it without kill-session.
const exitsOnInput = workspace => fixture(workspace, "p5.2-exits-on-input.js", `
  console.log("waiting");
  process.stdin.once("data", () => process.exit(0));
`);

test("one project session on AC holds \"CCDM: 1 sessions\", a thread session makes it 2, and the request goes when the last one stops", onlyWindows, async () => {
  const workspace = powerWorkspace();
  await startHost(workspace, { env: workspace.powerEnv });
  assert.deepEqual(readPower(workspace), { held: [], calls: [] });

  await newSession(workspace, "alpha_session", echoSession(workspace), { kind: "project" });
  await holds(workspace, ["CCDM: 1 sessions"]);
  await newSession(workspace, "alpha_session-t-1", exitsOnInput(workspace), { kind: "thread" });
  const two = await holds(workspace, ["CCDM: 2 sessions"]);
  // The new request is held before the old one is released.
  assert.deepEqual(two.calls, [["hold", "CCDM: 1 sessions"], ["hold", "CCDM: 2 sessions"], ["release", "CCDM: 1 sessions"]]);

  // One session ends on its own, the other through kill-session.
  await cliOk(workspace, ["send-keys", "-t", "=alpha_session-t-1", "bye", "Enter"]);
  await holds(workspace, ["CCDM: 1 sessions"]);
  await cliOk(workspace, ["kill-session", "-t", "=alpha_session"]);
  const none = await holds(workspace, []);
  assert.deepEqual(none.calls.slice(3), [
    ["hold", "CCDM: 1 sessions"], ["release", "CCDM: 2 sessions"], ["release", "CCDM: 1 sessions"],
  ]);
});

test("root and adhoc sessions never hold a request, and are not counted beside a project session", onlyWindows, async () => {
  const workspace = powerWorkspace();
  await startHost(workspace, { env: workspace.powerEnv });
  await newSession(workspace, "root_agent", echoSession(workspace), { kind: "root" });
  await newSession(workspace, "scratch", echoSession(workspace), { kind: "adhoc" });
  await waitForCapture(workspace, "scratch", /fixture-up/);
  await severalPolls();
  assert.deepEqual(readPower(workspace), { held: [], calls: [] });

  await newSession(workspace, "alpha_session", echoSession(workspace), { kind: "project" });
  await holds(workspace, ["CCDM: 1 sessions"]);
  await cliOk(workspace, ["kill-session", "-t", "=alpha_session"]);
  await holds(workspace, []);
  assert.equal((await cli(workspace, ["has-session", "-t", "=root_agent"])).code, 0);
  assert.equal((await cli(workspace, ["has-session", "-t", "=scratch"])).code, 0);
});

test("on battery the request is released, back on AC it is held again, and a shutdown releases it", onlyWindows, async () => {
  const workspace = powerWorkspace();
  const host = await startHost(workspace, { env: workspace.powerEnv });
  setPowerSource(workspace, "battery");
  await newSession(workspace, "alpha_session", echoSession(workspace), { kind: "project" });
  await waitForCapture(workspace, "alpha_session", /fixture-up/);
  await severalPolls();
  assert.deepEqual(readPower(workspace), { held: [], calls: [] }, "a session started on battery holds nothing");

  setPowerSource(workspace, "ac");
  await holds(workspace, ["CCDM: 1 sessions"]);
  setPowerSource(workspace, "battery");
  await holds(workspace, []);
  await newSession(workspace, "beta_session", echoSession(workspace), { kind: "project" });
  await severalPolls();
  assert.deepEqual(readPower(workspace).held, []);
  setPowerSource(workspace, "ac");
  await holds(workspace, ["CCDM: 2 sessions"]);

  await cliOk(workspace, ["shutdown"]);
  assert.equal(await host.closed, 0);
  assert.deepEqual(readPower(workspace).held, []);
});

test("a host started without CCDM_HOST_KEEP_AWAKE never touches the power seam", onlyWindows, async () => {
  const workspace = powerWorkspace();
  await startHost(workspace, { env: { CCDM_HOST_POWER_FAKE: workspace.powerDir, CCDM_HOST_POWER_POLL_MS: String(POWER_POLL_MS) } });
  await newSession(workspace, "alpha_session", echoSession(workspace), { kind: "project" });
  await waitForCapture(workspace, "alpha_session", /fixture-up/);
  await severalPolls();
  assert.equal(fs.existsSync(workspace.powerDir), false);
});

test("the Windows seam creates a SystemRequired request with the reason, clears and closes it, and only a known battery counts as battery", () => {
  const { win32PowerSeam } = lazy("host/power.js");
  const calls = [];
  let acLine = 1;
  let nextHandle = 100;
  const api = {
    CloseHandle: handle => calls.push(["CloseHandle", handle]),
    GetLastError: () => 5,
    GetSystemPowerStatus: (status) => {
      status[0] = acLine;
      return 1;
    },
    PowerClearRequest: (handle, type) => calls.push(["PowerClearRequest", handle, type]),
    PowerCreateRequest: (context) => {
      calls.push(["PowerCreateRequest", context]);
      return nextHandle;
    },
    PowerSetRequest: (handle, type) => calls.push(["PowerSetRequest", handle, type]),
  };
  const seam = win32PowerSeam(api);

  const release = seam.hold("CCDM: 3 sessions");
  assert.deepEqual(calls, [
    ["PowerCreateRequest", { Version: 0, Flags: 1, SimpleReasonString: "CCDM: 3 sessions", Reserved: [0, 0] }],
    ["PowerSetRequest", 100, 1],
  ]);
  release();
  assert.deepEqual(calls.slice(2), [["PowerClearRequest", 100, 1], ["CloseHandle", 100]]);

  for (const [line, onAc] of [[1, true], [0, false], [255, true]]) {
    acLine = line;
    assert.equal(seam.onAc(), onAc, `ACLineStatus ${line}`);
  }

  // INVALID_HANDLE_VALUE is the failure of PowerCreateRequest; a failed set closes what was created.
  nextHandle = -1;
  assert.throws(() => seam.hold("CCDM: 1 sessions"), /PowerCreateRequest failed \(Windows error 5\)/);
  nextHandle = 200;
  api.PowerSetRequest = () => 0;
  calls.length = 0;
  assert.throws(() => seam.hold("CCDM: 1 sessions"), /PowerSetRequest failed/);
  assert.deepEqual(calls.at(-1), ["CloseHandle", 200]);
});

test("a power seam that fails never throws into the host, is reported once, and is tried again at the next poll", async () => {
  const { POLL_MS, createKeepAwake } = lazy("host/power.js");
  assert.equal(POLL_MS, 30000);
  const held = [];
  const lines = [];
  let failing = true;
  const seam = {
    onAc: () => true,
    hold(reason) {
      if (failing) throw new Error("no power service");
      held.push(reason);
      return () => held.splice(held.indexOf(reason), 1);
    },
  };
  const keepAwake = createKeepAwake({ seam, pollMs: 10, log: line => lines.push(line) });

  keepAwake.update([{ kind: "project" }, { kind: "root" }]);
  await sleep(100);
  assert.deepEqual(held, []);
  assert.deepEqual(lines, ["keep-awake is not available: no power service"]);

  failing = false;
  await waitUntil(() => held.length === 1, "the request after the seam recovered");
  assert.deepEqual(held, ["CCDM: 1 sessions"]);
  keepAwake.close();
  assert.deepEqual(held, []);
});

// `ccdm attach`: the owner's command, run under its own pseudo-console.
const THREAD_ID = "1500000000000000001";

function attachWorkspace() {
  const workspace = hostWorkspace();
  seedRegistry(workspace, {
    discord_user_id: "allowed-user-id",
    projects: {
      alpha: { path: workspace.tmpDir, screen_name: "alpha_session", channel_id: "channel-alpha", type: "claude" },
      codex: { path: workspace.tmpDir, screen_name: "codex_session", channel_id: "channel-codex", type: "codex" },
    },
  });
  // A Workspace's PATH has no node; the launchers' override names it.
  return { ...workspace, childEnv: extra => workspace.childEnv({ CCDM_ROUTER_NODE: process.execPath, ...extra }) };
}

const ccdmAttachClient = (workspace, args) =>
  consoleClient(workspace, [PYTHON, path.join(workspace.repoDir, "scripts", "ccdm.py"), "attach", ...args]);

const ccdmAttach = (workspace, args, env = {}) =>
  runScript(workspace, "scripts/ccdm", { args: ["attach", ...args], env: workspace.childEnv(env), timeoutMs: 30000 });

async function sees(client, text) {
  await waitUntil(() => client.screen().includes(text), text, 15000).catch(() => assert.fail(`${text} never reached the client; saw ${client.screen()}`));
}

test("ccdm attach <project> shows the screen, passes input and window size, and Ctrl-] exits 0 with the session still live", onlyWindows, async () => {
  const workspace = attachWorkspace();
  await startHost(workspace);
  const { file, currentSize } = attachFixture(workspace);
  await ptySession(workspace, "alpha_session", file);
  await waitForCapture(workspace, "alpha_session", /before-attach/);

  const client = ccdmAttachClient(workspace, ["alpha"]);
  await sees(client, "before-attach");
  client.type("hello");
  await waitForCapture(workspace, "alpha_session", /got:hello/);
  client.resize(90, 30);
  await waitUntil(() => currentSize() === "90x30", () => `the new size; saw ${currentSize()}`);

  client.type("\x1d");
  assert.equal(await client.exited, 0);
  assert.equal((await cli(workspace, ["has-session", "-t", "=alpha_session"])).code, 0);
});

for (const flag of ["-r", "--read-only"]) {
  test(`ccdm attach ${flag} shows the screen, drops input and does not resize the session`, onlyWindows, async () => {
    const workspace = attachWorkspace();
    await startHost(workspace);
    const { file, currentSize } = attachFixture(workspace);
    await ptySession(workspace, "alpha_session", file);
    await waitForCapture(workspace, "alpha_session", /before-attach/);

    const client = ccdmAttachClient(workspace, ["alpha", flag]);
    await sees(client, "before-attach");
    client.type("dropped");
    client.resize(90, 30);
    await sleep(500);
    assert.doesNotMatch(await capture(workspace, "alpha_session"), /got:/);
    assert.equal(currentSize(), "200x50");

    client.type("\x1d");
    assert.equal(await client.exited, 0);
    assert.equal((await cli(workspace, ["has-session", "-t", "=alpha_session"])).code, 0);
  });
}

test("ccdm attach root attaches to root_agent", onlyWindows, async () => {
  const workspace = attachWorkspace();
  await startHost(workspace);
  await ptySession(workspace, "root_agent", attachFixture(workspace).file);
  await waitForCapture(workspace, "root_agent", /before-attach/);

  const client = ccdmAttachClient(workspace, ["root"]);
  await sees(client, "before-attach");
  client.type("\x1d");
  assert.equal(await client.exited, 0);
});

test("ccdm attach exits 0 when the session ends while attached", onlyWindows, async () => {
  const workspace = attachWorkspace();
  await startHost(workspace);
  await ptySession(workspace, "alpha_session", attachFixture(workspace).file);
  await waitForCapture(workspace, "alpha_session", /before-attach/);

  const client = ccdmAttachClient(workspace, ["alpha"]);
  await sees(client, "before-attach");
  client.type("q");
  assert.equal(await client.exited, 0);
  await sees(client, "ended with code 3");
});

test("ccdm attach names an unknown target and a stopped project, and shows an ended session's last screen", onlyWindows, async () => {
  const workspace = attachWorkspace();

  const noHost = await ccdmAttach(workspace, ["alpha"]);
  assert.equal(noHost.exitCode, 1, noHost.stderr);
  assert.match(noHost.stderr, /Session 'alpha_session' for project 'alpha' is not running/);

  await startHost(workspace);
  const unknown = await ccdmAttach(workspace, ["ghost"]);
  assert.equal(unknown.exitCode, 2, unknown.stderr);
  assert.match(unknown.stderr, /Unknown project or session: ghost/);

  const stopped = await ccdmAttach(workspace, ["alpha"]);
  assert.equal(stopped.exitCode, 1, stopped.stderr);
  assert.match(stopped.stderr, /Session 'alpha_session' for project 'alpha' is not running/);
  assert.equal(stopped.stdout, "");

  await ptySession(workspace, "alpha_session", fixture(workspace, "p3.9-ends.js", `console.log("final-screen-line"); process.exit(7);`));
  await waitForHasSessionFalse(workspace, "alpha_session");
  const ended = await ccdmAttach(workspace, ["alpha"]);
  assert.equal(ended.exitCode, 1, ended.stderr);
  assert.match(ended.stdout, /final-screen-line/);
  assert.match(ended.stderr, /Session 'alpha_session' for project 'alpha' is not running/);
});

// Prints numbered lines until the stop file appears, as a bridge writes its log.
function outputFixture(workspace, stopFile) {
  return fixture(workspace, "p3.9-output.js", `
    const fs = require("node:fs");
    let line = 0;
    setInterval(() => {
      if (fs.existsSync(${JSON.stringify(stopFile)})) process.exit(0);
      console.log("output-line-" + line + "-end");
      line += 1;
    }, 100);
    process.stdin.resume();
  `);
}

test("ccdm attach on a no-PTY session follows its output once, and Ctrl-] exits 0 with the session still live", onlyWindows, async () => {
  const workspace = attachWorkspace();
  await startHost(workspace);
  await newSession(workspace, "codex_session", outputFixture(workspace, path.join(workspace.fixtures, "p3.9-stop")));
  await waitForCapture(workspace, "codex_session", /output-line-0-end/);

  const client = ccdmAttachClient(workspace, ["codex"]);
  await sees(client, "following its output");
  await sees(client, "output-line-0-end");
  const last = Number(/output-line-(\d+)-end/.exec((await capture(workspace, "codex_session")).trim().split("\n").at(-1))[1]);
  await sees(client, `output-line-${last + 6}-end`);
  assert.equal(client.screen().split(`output-line-${last}-end`).length, 2, client.screen());

  client.type("\x1d");
  assert.equal(await client.exited, 0);
  assert.equal((await cli(workspace, ["has-session", "-t", "=codex_session"])).code, 0);
});

test("ccdm attach on a no-PTY session exits 0 when it ends and 1 when the host goes away", onlyWindows, async () => {
  const workspace = attachWorkspace();
  const host = await startHost(workspace);
  const stopFile = path.join(workspace.fixtures, "p3.9-stop");
  await newSession(workspace, "codex_session", outputFixture(workspace, stopFile));
  await waitForCapture(workspace, "codex_session", /output-line-0-end/);

  const ending = ccdmAttachClient(workspace, ["codex"]);
  await sees(ending, "output-line-0-end");
  fs.writeFileSync(stopFile, "");
  assert.equal(await ending.exited, 0);
  await sees(ending, "[session codex_session ended]");

  fs.rmSync(stopFile);
  await newSession(workspace, "codex_session", outputFixture(workspace, stopFile));
  await waitForCapture(workspace, "codex_session", /output-line-0-end/);
  const orphaned = ccdmAttachClient(workspace, ["codex"]);
  await sees(orphaned, "output-line-0-end");
  host.child.kill();
  assert.equal(await orphaned.exited, 1);
  await sees(orphaned, "ccdm-host is not running");
});

test("ccdm attach on tmux runs tmux attach, -r for read-only, and resolves root and a thread", async () => {
  const workspace = attachWorkspace();
  for (const name of ["alpha_session", "root_agent", `alpha_session-t-${THREAD_ID}`]) {
    seedTmuxSession(name, {}, { stateDir: workspace.stateDir });
  }
  const { ensurePrivateDirSync } = lazy("platform/privacy.js");
  const stateDir = supervisorStateDir(workspace);
  ensurePrivateDirSync(stateDir);
  const store = path.join(stateDir, "threads.sqlite3");
  const db = new (require("node:sqlite").DatabaseSync)(store);
  db.exec("CREATE TABLE threads (thread_id TEXT, project TEXT, name TEXT, provider TEXT, resolved_provider TEXT, state TEXT)");
  db.prepare("INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?)").run(THREAD_ID, "alpha", "fix-login", "claude", "claude", "live");
  db.close();
  fs.chmodSync(store, 0o600);
  const env = { CCDM_SESSION_HOST: "tmux", CCDM_ROUTER_NODE: process.execPath, CCDM_THREAD_SUPERVISOR_STATE_DIR: stateDir };

  const cases = [
    [["alpha"], ["attach", "-t", "alpha_session"]],
    [["alpha", "-r"], ["attach", "-r", "-t", "alpha_session"]],
    [["alpha", "--read-only"], ["attach", "-r", "-t", "alpha_session"]],
    [["root"], ["attach", "-t", "root_agent"]],
    [["alpha", "--thread", THREAD_ID], ["attach", "-t", `alpha_session-t-${THREAD_ID}`]],
    [["alpha", "--thread", `https://discord.com/channels/guild-id/${THREAD_ID}`], ["attach", "-t", `alpha_session-t-${THREAD_ID}`]],
  ];
  for (const [args, expected] of cases) {
    const result = await ccdmAttach(workspace, args, env);
    assert.equal(result.exitCode, 0, `${args.join(" ")}: ${result.stderr}`);
    assert.deepEqual(tmuxCalls(workspace).filter(call => call[0] === "attach").at(-1), expected);
  }

  const before = tmuxCalls(workspace).filter(call => call[0] === "attach").length;
  const stopped = await ccdmAttach(workspace, ["codex"], env);
  assert.equal(stopped.exitCode, 1, stopped.stderr);
  assert.match(stopped.stderr, /Session 'codex_session' for project 'codex' is not running/);
  const unknown = await ccdmAttach(workspace, ["ghost"], env);
  assert.equal(unknown.exitCode, 2, unknown.stderr);
  assert.match(unknown.stderr, /ghost/);
  const wrongProject = await ccdmAttach(workspace, ["codex", "--thread", THREAD_ID], env);
  assert.notEqual(wrongProject.exitCode, 0);
  assert.match(wrongProject.stderr, /not a thread of project 'codex'/);
  assert.equal(tmuxCalls(workspace).filter(call => call[0] === "attach").length, before);
});
