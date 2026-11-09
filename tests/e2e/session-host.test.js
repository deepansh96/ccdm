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

import { assertPrivate, platformGate } from "./support/platform.js";
import { createWorkspace, scaledTimeout } from "./support/runner.js";
import { cleanup, registerTeardownCallback } from "./support/teardown.js";

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

test("a command that cannot start gets spawn_failed, and later ops and pty sessions get unsupported_op", onlyWindows, async () => {
  const workspace = hostWorkspace();
  await startHost(workspace);
  const connection = await authenticated(workspace);
  const missing = await ask(connection, { id: 1, op: "new", name: "x", argv: ["no-such-program-p3-1a.exe"], cwd: workspace.fixtures, env: {}, pty: false, kind: "adhoc" });
  assert.equal(missing.error, "spawn_failed");
  assert.equal((await ask(connection, { id: 2, op: "has", name: "x" })).live, false);
  for (const op of ["wait", "attach", "run-detached", "subscribe", "nonsense"]) {
    assert.equal((await ask(connection, { id: op, op })).error, "unsupported_op", op);
  }
  const pty = await ask(connection, { id: 3, op: "new", name: "y", argv: [process.execPath], cwd: workspace.fixtures, env: {}, pty: true, kind: "adhoc" });
  assert.equal(pty.error, "unsupported_op");
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
