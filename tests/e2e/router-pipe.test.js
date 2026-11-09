// The Router's endpoint: a random named pipe per start on Windows with a server
// proof before any key, a lock that survives crashes and PID reuse, a clean stop,
// and the POSIX behaviour launchd relies on.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";
import test from "node:test";

import { runPreloadProbe } from "./support/bridge.js";
import { assertPrivate, platformGate, sendCtrlBreak } from "./support/platform.js";
import {
  connectSession,
  createRouterWorkspace,
  killRouter,
  listenAsRouter,
  proofReply,
  routerEnv,
  runRouterCli,
  startRouter,
  startRouterWithConsole,
  waitFor,
  writeProjectKey,
} from "./support/router.js";
import { readState, updateState } from "./support/state.js";
import { cleanup, registerTeardownCallback } from "./support/teardown.js";

const onlyWindows = platformGate("win32", "named pipes and schtasks are Windows behaviour");
const posixRouterSignals = platformGate("posix", "launchd's relaunch rule depends on POSIX signals");
const posixSocketListener = platformGate("posix", "a Unix socket path can be held by a live listener");
const PIPE_NAME = /^\\\\\.\\pipe\\ccdm-[0-9a-f]{32}-router$/;

test.afterEach(async () => {
  await cleanup();
});

const lib = (workspace, name) => createRequire(import.meta.url)(path.join(workspace.repoDir, "scripts", name));
const stateFile = (workspace, name) => path.join(workspace.routerStateDir, name);
const readTrimmed = file => fs.readFileSync(file, "utf8").trim();

// A listener that records every byte a client sends. `onFrame` may answer it.
async function recordingServer(workspace, { endpoint = null, onFrame = () => {} } = {}) {
  const bytes = [];
  const frames = [];
  const server = net.createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      bytes.push(chunk);
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const frame = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        frames.push(frame);
        onFrame(frame, socket);
      }
    });
    socket.on("error", () => {});
  });
  const target = endpoint ?? (process.platform === "win32"
    ? `\\\\.\\pipe\\ccdm-p2.1-test-${randomBytes(8).toString("hex")}-router`
    : path.join(workspace.tmpRoot, `p2.1-${randomBytes(4).toString("hex")}.sock`));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(target, resolve);
  });
  registerTeardownCallback(() => new Promise((resolve) => server.close(resolve)));
  return { bytes, frames, server, target };
}

function assertSawNoKey(squatter, key) {
  assert.deepEqual(squatter.frames.map(frame => frame.type).filter(type => type !== "server_proof"), []);
  assert.equal(squatter.bytes.join("").includes(key), false, "the key reached a server that did not prove itself");
}

function publishedRouter(workspace) {
  return { pipe: readTrimmed(stateFile(workspace, "router.pipe")), secret: readTrimmed(stateFile(workspace, "router.secret")) };
}

function clientFor(workspace, options) {
  const { RouterClient } = lib(workspace, "router/client.js");
  const client = new RouterClient(options);
  registerTeardownCallback(() => client.close());
  return client;
}

test("each serve on Windows publishes a new pipe name and secret, and status works through the pipe", onlyWindows, async () => {
  const workspace = createRouterWorkspace();
  const first = await startRouter(workspace);
  const before = publishedRouter(workspace);
  assert.match(before.pipe, PIPE_NAME);
  assert.match(before.secret, /^[0-9a-f]{64}$/);
  assertPrivate(stateFile(workspace, "router.secret"));

  const status = await runRouterCli(workspace, ["status"]);
  assert.equal(status.exitCode, 0, status.stderr || status.stdout);
  assert.match(status.stdout, /gateway: ready/);

  killRouter(first);
  await first.closed;
  await startRouter(workspace);
  const after = publishedRouter(workspace);
  assert.match(after.pipe, PIPE_NAME);
  assert.notEqual(after.pipe, before.pipe);
  assert.notEqual(after.secret, before.secret);
});

test("a second serve exits non-zero and leaves the running Router alone", async () => {
  const workspace = createRouterWorkspace();
  await startRouter(workspace);
  const before = process.platform === "win32" ? publishedRouter(workspace) : null;

  const second = await runRouterCli(workspace, ["serve"]);

  assert.notEqual(second.exitCode, 0);
  assert.match(second.stderr, /another Router is already running/);
  if (before) assert.deepEqual(publishedRouter(workspace), before);
  const status = await runRouterCli(workspace, ["status"]);
  assert.equal(status.exitCode, 0, status.stderr || status.stdout);
});

test("after a hard kill the next serve reclaims the stale lock and pipe files", onlyWindows, async () => {
  const workspace = createRouterWorkspace();
  const first = await startRouter(workspace);
  killRouter(first);
  await first.closed;
  for (const name of ["router.lock", "router.pipe", "router.secret"]) {
    assert.equal(fs.existsSync(stateFile(workspace, name)), true, `${name} is left behind by a crash`);
  }

  await startRouter(workspace);
  const status = await runRouterCli(workspace, ["status"]);
  assert.equal(status.exitCode, 0, status.stderr || status.stdout);
});

test("on Windows a lock naming a live PID with another start time is reclaimed", onlyWindows, async () => {
  const workspace = createRouterWorkspace();
  fs.mkdirSync(workspace.routerStateDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(stateFile(workspace, "router.lock"), `${process.pid} 12345\n`);

  await startRouter(workspace);

  const [pid, startedAt] = readTrimmed(stateFile(workspace, "router.lock")).split(" ");
  assert.notEqual(Number(pid), process.pid);
  assert.match(startedAt, /^\d+$/);
});

test("a live Unix socket blocks serve when no lock exists", posixSocketListener, async () => {
  const workspace = createRouterWorkspace();
  const holder = net.createServer();
  await listenAsRouter(workspace, holder);
  registerTeardownCallback(() => new Promise(resolve => holder.close(resolve)));

  const started = await runRouterCli(workspace, ["serve"]);

  assert.notEqual(started.exitCode, 0);
  assert.match(started.stderr, /another Router is listening/);
});

test("an emergency marker with a reused PID is not engaged on Windows", onlyWindows, async () => {
  const workspace = createRouterWorkspace();
  const { processStartTime } = createRequire(import.meta.url)("../../scripts/platform/process.js");
  const marker = path.join(workspace.tmpDir, "p2.1-emergency.json");
  const engaged = async (content) => {
    fs.writeFileSync(marker, `${JSON.stringify(content)}\n`);
    const result = await runPreloadProbe(workspace, `
      const { emergencyEngaged } = require(${JSON.stringify(path.join(workspace.repoDir, "scripts/router/emergency.js"))});
      console.log(JSON.stringify(emergencyEngaged(${JSON.stringify(marker)})));
    `);
    assert.equal(result.exitCode, 0, result.stderr || result.stdout);
    return JSON.parse(result.stdout.trim().split("\n").at(-1));
  };

  assert.equal(await engaged({ pid: process.pid, startedAt: "12345" }), false);
  assert.equal(await engaged({ pid: process.pid, startedAt: processStartTime(process.pid) }), true);
  assert.equal(await engaged({ pid: process.pid }), true);
});

test("a client given a secret sends nothing but its nonce to a server that cannot prove itself", async () => {
  const workspace = createRouterWorkspace();
  const key = "p2.1-never-sent-key";
  const wrong = await recordingServer(workspace, {
    onFrame: (frame, socket) => socket.write(`${JSON.stringify({ type: "server_proof_ok", proof: "0".repeat(64) })}\n`),
  });
  const silent = await recordingServer(workspace);

  const refused = clientFor(workspace, { endpoint: () => ({ path: wrong.target, secret: "test-secret" }), project: "demo", key });
  await assert.rejects(refused.connect(), { code: "router_unavailable" });
  assertSawNoKey(wrong, key);
  assert.equal(wrong.frames.length, 1);
  assert.match(wrong.frames[0].nonce, /^[0-9a-f]{64}$/);

  const timed = clientFor(workspace, {
    endpoint: () => ({ path: silent.target, secret: "test-secret" }), project: "demo", key, timeoutMs: 200,
  });
  await assert.rejects(timed.connect(), { code: "router_unavailable" });
  assertSawNoKey(silent, key);
});

test("a server that proves the secret gets the hello", async () => {
  const workspace = createRouterWorkspace();
  const secret = "test-secret";
  const server = await recordingServer(workspace, {
    onFrame: (frame, socket) => {
      if (frame.type === "server_proof") socket.write(`${JSON.stringify(proofReply(frame, secret))}\n`);
      else socket.write(`${JSON.stringify({ type: "hello_ok", v: 1, scope: null })}\n`);
    },
  });
  const client = clientFor(workspace, { endpoint: () => ({ path: server.target, secret }), project: "demo", key: "demo-key" });

  await client.connect();

  assert.deepEqual(server.frames.map(frame => frame.type), ["server_proof", "hello"]);
  assert.equal(server.frames[1].key, "demo-key");
});

test("a squatter on the published name gets no key", onlyWindows, async () => {
  const workspace = createRouterWorkspace();
  const key = "p2.1-never-sent-key";
  const squatter = await recordingServer(workspace);
  fs.mkdirSync(workspace.routerStateDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(stateFile(workspace, "router.secret"), randomBytes(32).toString("hex"));
  fs.writeFileSync(stateFile(workspace, "router.pipe"), squatter.target);

  const client = clientFor(workspace, { socketPath: workspace.socketPath, project: "demo", key, timeoutMs: 300 });
  await assert.rejects(client.connect(), { code: "router_unavailable" });

  assert.equal(squatter.frames.length, 1);
  assertSawNoKey(squatter, key);
});

test("CCDM_ROUTER_SOCKET still needs the server proof", onlyWindows, async () => {
  const workspace = createRouterWorkspace();
  const key = "p2.1-never-sent-key";
  const connectWith = async (socketOverride) => {
    // The harness allows only pipe names published inside the workspace.
    fs.writeFileSync(stateFile(workspace, "override.pipe"), socketOverride);
    const result = await runPreloadProbe(workspace, `
      const { RouterClient } = require(${JSON.stringify(path.join(workspace.repoDir, "scripts/router/client.js"))});
      const client = new RouterClient({ role: "project", project: "demo", key: ${JSON.stringify(key)}, timeoutMs: 1000 });
      client.connect().then(() => console.log("connected"), error => console.log(error.code)).finally(() => client.close());
    `, routerEnvFor(workspace, socketOverride));
    assert.equal(result.exitCode, 0, result.stderr || result.stdout);
    return result.stdout.trim().split("\n").at(-1);
  };

  writeProjectKey(workspace, "demo", key);
  const router = await startRouter(workspace);
  const squatter = await recordingServer(workspace);

  assert.equal(await connectWith(squatter.target), "router_unavailable");
  assert.equal(squatter.frames.length, 1);
  assertSawNoKey(squatter, key);

  assert.equal(await connectWith(publishedRouter(workspace).pipe), "connected");
  assert.equal(router.child.exitCode, null);
});

function routerEnvFor(workspace, socketOverride) {
  return { ...routerEnv(workspace), CCDM_ROUTER_SOCKET: socketOverride };
}

test("a reconnecting client meets a squatter on the old name, sends no key, and rejoins the real Router", onlyWindows, async () => {
  const workspace = createRouterWorkspace();
  const webhook = await runRouterCli(workspace, ["ensure-webhook", "demo"]);
  assert.equal(webhook.exitCode, 0, webhook.stderr || webhook.stdout);
  writeProjectKey(workspace, "demo", "demo-key");
  const first = await startRouter(workspace);
  const { pipe: oldPipe } = publishedRouter(workspace);
  const demo = await connectSession(workspace, "demo", "demo-key", {
    env: { CCDM_ROUTER_RECONNECT_MIN_MS: "50", CCDM_ROUTER_RECONNECT_MAX_MS: "200" },
  });
  let reconnected = false;
  demo.client.once("reconnect", () => { reconnected = true; });

  killRouter(first);
  await first.closed;
  const squatter = await recordingServer(workspace, {
    endpoint: oldPipe,
    onFrame: (frame, socket) => socket.write(`${JSON.stringify({ type: "server_proof_ok", proof: "0".repeat(64) })}\n`),
  });
  await waitFor(() => squatter.frames.length >= 2, () => `reconnect attempts at the squatter: ${squatter.frames.length}`);
  assert.equal(reconnected, false);
  assertSawNoKey(squatter, "demo-key");

  await startRouter(workspace);
  await waitFor(() => reconnected, () => "reconnect to the new pipe name");
  await demo.client.request("reply", { channel_id: "demo-channel", text: "back", context_pct: 42 });
  assert.deepEqual(readState(workspace.stateDir).fixtures.discord.messages.map(({ content }) => content), ["back"]);
  assertSawNoKey(squatter, "demo-key");
});

test("Ctrl+Break stops serve cleanly and removes the pipe files and lock", onlyWindows, async () => {
  const workspace = createRouterWorkspace();
  const router = await startRouterWithConsole(workspace);

  sendCtrlBreak(router.child);
  const result = await router.closed;

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  for (const name of ["router.lock", "router.pipe", "router.secret"]) {
    assert.equal(fs.existsSync(stateFile(workspace, name)), false, `${name} survives a clean stop`);
  }
});

test("on POSIX, serve ignores stdin EOF and dies by signal on SIGHUP", posixRouterSignals, async () => {
  const workspace = createRouterWorkspace();
  const router = await startRouterWithConsole(workspace);

  router.child.stdin.end();
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(router.child.exitCode, null);
  assert.equal(router.child.signalCode, null);

  process.kill(router.child.pid, "SIGHUP");
  const result = await router.closed;
  assert.equal(result.signal, "SIGHUP");
  assert.equal(result.exitCode, null);
});

test("threads are enabled on Windows by the task names, or else fall back to the registry field", onlyWindows, async () => {
  const workspace = createRouterWorkspace();
  await startRouter(workspace);
  const threadsEnabled = async () => {
    const status = await runRouterCli(workspace, ["status", "--json"]);
    assert.equal(status.exitCode, 0, status.stderr || status.stdout);
    return JSON.parse(status.stdout).threads_enabled;
  };
  const tasks = (list) => updateState(workspace.stateDir, (state) => {
    state.fixtures.schtasks.tasks = list;
    return state;
  });

  assert.equal(await threadsEnabled(), false);
  assert.deepEqual(readState(workspace.stateDir).fixtures.schtasks.invocations.map(entry => entry.name),
    ["\\CCDM\\ThreadSupervisor", "CCDM-ThreadSupervisor"]);

  tasks(["\\CCDM\\ThreadSupervisor"]);
  assert.equal(await threadsEnabled(), true);

  tasks(["CCDM-ThreadSupervisor"]);
  assert.equal(await threadsEnabled(), true);

  tasks([]);
  const registryFile = path.join(workspace.repoDir, "registry.json");
  fs.writeFileSync(registryFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(registryFile, "utf8")), thread_session_caps: { claude: 1 } }));
  assert.equal(await threadsEnabled(), true);
});

test("onShutdown runs once for stdin EOF only when asked", async () => {
  const { spawn } = await import("node:child_process");
  const workspace = createRouterWorkspace();
  const processModule = path.join(workspace.repoDir, "scripts/platform/process.js");
  const run = async (stdinEof) => {
    const child = spawn(process.execPath, ["-e", `
      const { onShutdown } = require(${JSON.stringify(processModule)});
      onShutdown(reason => { console.log(reason); process.exit(0); }, { signals: [], stdinEof: ${stdinEof} });
      setTimeout(() => { console.log("timer"); process.exit(0); }, ${stdinEof ? 5000 : 400});
    `], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stdin.end();
    await new Promise(resolve => child.on("close", resolve));
    return stdout.trim();
  };

  assert.equal(await run(true), "stdin");
  assert.equal(await run(false), "timer");
});
