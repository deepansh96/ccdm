// The Windows pipe server behind createIpcListener: koffi owns the instances, so
// everything net.Server used to do for free is proved here, on the same stream
// surface the Router and ccdm-host use.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, promises as fsp, rmSync } from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { PYTHON, platformGate } from "./support/platform.js";
import { waitFor } from "./support/router.js";

const onlyWindows = platformGate("win32", "named pipes created through koffi are Windows behaviour");
const IPC_MODULE = fileURLToPath(new URL("../../scripts/platform/ipc.js", import.meta.url));
const ipc = () => createRequire(import.meta.url)(IPC_MODULE);
const nap = ms => new Promise(resolve => setTimeout(resolve, ms));
const sha = buffers => createHash("sha256").update(Buffer.concat(buffers)).digest("hex");
const MEGABYTE = 1024 * 1024;

const pipeName = () => `\\\\.\\pipe\\ccdm-p2.1h-test-${randomBytes(8).toString("hex")}`;
let openListeners = [];
let openClients = [];

test.afterEach(() => {
  for (const client of openClients) client.destroy();
  openClients = [];
  for (const listener of openListeners) listener.close();
  openListeners = [];
});

async function startListener(onConnection) {
  const listener = ipc().createIpcListener(onConnection);
  const endpoint = pipeName();
  await listener.listen(endpoint);
  openListeners.push(listener);
  return { endpoint, listener };
}

function connect(endpoint) {
  return new Promise((resolve, reject) => {
    const client = net.connect(endpoint);
    openClients.push(client);
    client.once("connect", () => resolve(client));
    client.once("error", reject);
  });
}

// Every server stream, in connection order, with a bag for what it received.
async function startCollecting(onStream = () => {}) {
  const streams = [];
  const { endpoint, listener } = await startListener((stream) => {
    streams.push(stream);
    stream.on("error", () => {});
    onStream(stream);
  });
  return { endpoint, listener, streams };
}

const receiveAll = (client, chunks = []) => new Promise((resolve, reject) => {
  client.on("data", chunk => chunks.push(chunk));
  client.on("error", reject);
  client.on("close", () => resolve(chunks));
});

test("eight clients at once each get their own replies", onlyWindows, async () => {
  const { endpoint } = await startListener((stream) => {
    stream.setEncoding("utf8");
    stream.on("data", text => stream.write(`echo:${text}`));
    stream.on("error", () => {});
  });

  const roundTrips = Array.from({ length: 8 }, async (_, index) => {
    const client = await connect(endpoint);
    client.setEncoding("utf8");
    const got = [];
    for (let trip = 0; trip < 3; trip += 1) {
      const reply = new Promise(resolve => client.once("data", resolve));
      client.write(`c${index}p${trip}`);
      got.push(await reply);
    }
    client.destroy();
    return got;
  });

  const replies = await Promise.all(roundTrips);
  replies.forEach((got, index) => assert.deepEqual(got, [0, 1, 2].map(trip => `echo:c${index}p${trip}`)));
});

test("a client connecting during a burst does not see the pipe as busy", onlyWindows, async () => {
  const { endpoint, streams } = await startCollecting();

  const clients = await Promise.all(Array.from({ length: 24 }, () => connect(endpoint)));

  assert.equal(clients.length, 24);
  await waitFor(() => streams.length === 24, () => `24 server streams, got ${streams.length}`);
});

test("several megabytes cross in both directions byte for byte", onlyWindows, async () => {
  const payload = randomBytes(6 * MEGABYTE);
  const { endpoint } = await startListener((stream) => {
    stream.on("error", () => {});
    stream.on("data", (chunk) => {
      if (!stream.write(chunk)) {
        stream.pause();
        stream.once("drain", () => stream.resume());
      }
    });
  });
  const client = await connect(endpoint);
  const chunks = [];
  const received = new Promise((resolve) => {
    let total = 0;
    client.on("data", (chunk) => {
      chunks.push(chunk);
      total += chunk.length;
      if (total >= payload.length) resolve();
    });
  });

  client.write(payload);
  await received;

  assert.equal(sha(chunks), sha([payload]));
});

test("a client that stops reading fills the stream, and drain follows once it reads again", onlyWindows, async () => {
  const size = 3 * MEGABYTE;
  const chunk = randomBytes(64 * 1024);
  const { endpoint, streams } = await startCollecting();
  const client = await connect(endpoint);
  client.pause();
  await waitFor(() => streams.length === 1, () => "the server stream");
  const [stream] = streams;

  let refused = 0;
  let sent = 0;
  while (sent < size) {
    if (!stream.write(chunk)) refused += 1;
    sent += chunk.length;
  }
  const drained = new Promise(resolve => stream.once("drain", resolve));
  await nap(400);

  assert.ok(refused > 0, "write() reported the stream full");
  assert.ok(stream.writableLength > MEGABYTE, `still queued: ${stream.writableLength} of ${sent}`);
  let received = 0;
  client.on("data", (data) => { received += data.length; });
  client.resume();
  await drained;
  await waitFor(() => received === sent, () => `${sent} bytes, got ${received}`);
  assert.equal(stream.writableLength, 0);
});

test("a consumer that pauses stops the pipe being read, so the client's writes back up", onlyWindows, async () => {
  const size = 3 * MEGABYTE;
  let received = 0;
  const { endpoint, streams } = await startCollecting((stream) => {
    stream.on("data", (chunk) => {
      received += chunk.length;
      stream.pause();
    });
  });
  const client = await connect(endpoint);

  client.write(randomBytes(size));
  await waitFor(() => received > 0, () => "the first chunk");
  await nap(400);

  assert.ok(streams[0].readableLength <= 256 * 1024, `buffered in the server: ${streams[0].readableLength}`);
  assert.ok(client.writableLength > MEGABYTE, `still queued in the client: ${client.writableLength}`);
  streams[0].on("data", () => streams[0].resume());
  streams[0].resume();
  await waitFor(() => received === size, () => `${size} bytes, got ${received}`);
});

test("setEncoding keeps a character whole when it is split across two reads", onlyWindows, async () => {
  const seen = [];
  const { endpoint } = await startListener((stream) => {
    stream.setEncoding("utf8");
    stream.on("data", text => seen.push(text));
    stream.on("error", () => {});
  });
  const client = await connect(endpoint);
  const euro = Buffer.from("€");

  client.write(euro.subarray(0, 1));
  await nap(100);
  client.write(euro.subarray(1));

  await waitFor(() => seen.join("") === "€", () => `the character, got ${JSON.stringify(seen)}`);
});

test("end after a large write delivers every byte, then the client sees end and the stream closes", onlyWindows, async () => {
  const payload = randomBytes(2 * MEGABYTE);
  const { endpoint, streams } = await startCollecting();
  const client = await connect(endpoint);
  await waitFor(() => streams.length === 1, () => "the server stream");
  const closed = new Promise(resolve => streams[0].once("close", resolve));
  const got = receiveAll(client);

  streams[0].write(payload);
  streams[0].end();

  assert.equal(sha(await got), sha([payload]));
  await closed;
  assert.equal(streams[0].destroyed, true);
});

test("destroy closes the client at once, and later clients still connect", onlyWindows, async () => {
  const { endpoint, streams } = await startCollecting();
  const first = await connect(endpoint);
  await waitFor(() => streams.length === 1, () => "the server stream");

  const closed = new Promise(resolve => first.once("close", resolve));
  first.on("error", () => {});
  streams[0].destroy();
  await closed;

  await connect(endpoint);
  await waitFor(() => streams.length === 2, () => "a second server stream");
});

test("a client leaving during a long write ends in close, with no write left hanging", onlyWindows, async () => {
  const { endpoint, streams } = await startCollecting();
  const client = await connect(endpoint);
  client.pause();
  await waitFor(() => streams.length === 1, () => "the server stream");
  const [stream] = streams;
  const closed = new Promise(resolve => stream.once("close", resolve));
  stream.write(randomBytes(4 * MEGABYTE));
  await nap(100);

  client.destroy();

  await closed;
  assert.equal(stream.destroyed, true);
});

test("many idle clients hold no pool threads, so file I/O stays quick", onlyWindows, async () => {
  const { endpoint } = await startListener(stream => stream.on("error", () => {}));
  await Promise.all(Array.from({ length: 16 }, () => connect(endpoint)));
  await nap(100);

  const startedAt = Date.now();
  await Promise.all(Array.from({ length: 16 }, () => fsp.stat(".")));

  assert.ok(Date.now() - startedAt < 2000, `file I/O took ${Date.now() - startedAt} ms`);
});

test("the pipe is the current user's alone", onlyWindows, async () => {
  const { endpoint } = await startListener(stream => stream.on("error", () => {}));
  const sid = createRequire(import.meta.url)("../../scripts/platform/privacy.js").currentUserSid();
  // SDDL prints the machine's built-in Administrator (RID 500) as LA.
  const trustee = sid.endsWith("-500") ? "LA" : sid;

  assert.match(ipc().readPipeSddl(endpoint), new RegExp(`D:P\\(A;;FA;;;${trustee}\\)$`));
});

test("a name already taken is refused and the error names the pipe DACL", onlyWindows, async () => {
  const taken = await startListener(stream => stream.on("error", () => {}));
  const second = ipc().createIpcListener(() => {});

  await assert.rejects(second.listen(taken.endpoint), /owner-only pipe DACL/);
});

test("the Python client connects, passes the server proof and exchanges a line", onlyWindows, async () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "p2.1h-py-"));
  const { publishPipe, serverProof } = ipc();
  const { pipe, secret } = publishPipe(stateDir, "probe");
  const listener = ipc().createIpcListener((stream) => {
    stream.setEncoding("utf8");
    stream.on("error", () => {});
    let buffer = "";
    stream.on("data", (text) => {
      buffer += text;
      for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line === "ping") stream.write("pong\n");
        else stream.write(`${JSON.stringify({ type: "server_proof_ok", proof: serverProof(secret, JSON.parse(line).nonce) })}\n`);
      }
    });
  });
  await listener.listen(pipe);
  openListeners.push(listener);
  const script = `
import sys
from ccdmlib.platform import ipc
stream = ipc.connect("probe", sys.argv[1])
stream.write(b"ping\\n")
stream.flush()
sys.stdout.write(stream.readline().decode("utf-8"))
stream.close()
`;
  const scripts = path.resolve(path.dirname(IPC_MODULE), "..");
  const pythonPath = [process.env.PYTHONPATH, scripts].filter(Boolean).join(path.delimiter);

  // Not spawnSync: the listener runs on this thread.
  const result = await new Promise((resolve, reject) => {
    const child = spawn(PYTHON, ["-c", script, stateDir],
      { env: { ...process.env, PYTHONPATH: pythonPath }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (text) => { stdout += text; });
    child.stderr.setEncoding("utf8").on("data", (text) => { stderr += text; });
    const watchdog = setTimeout(() => child.kill("SIGKILL"), 20000);
    child.on("error", reject);
    child.on("close", (status) => {
      clearTimeout(watchdog);
      resolve({ status, stderr, stdout });
    });
  });

  rmSync(stateDir, { force: true, recursive: true });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "pong");
});

// Run in a process of their own, because what matters is whether it exits.
function runScript(script) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", script, IPC_MODULE], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (text) => { stdout += text; });
    child.stderr.setEncoding("utf8").on("data", (text) => { stderr += text; });
    const watchdog = setTimeout(() => child.kill("SIGKILL"), 20000);
    child.on("error", reject);
    child.on("close", (code, signal) => {
      clearTimeout(watchdog);
      resolve({ code, signal, stderr, stdout });
    });
  });
}

const SCRIPT_START = `
  const { createIpcListener } = require(process.argv[1]);
  const net = require("node:net");
  const endpoint = "\\\\\\\\.\\\\pipe\\\\ccdm-p2.1h-exit-" + process.pid;
  const nap = ms => new Promise(resolve => setTimeout(resolve, ms));
  const connect = () => new Promise((resolve, reject) => {
    const client = net.connect(endpoint);
    client.on("error", () => {});
    client.once("connect", () => resolve(client));
    client.once("error", reject);
  });
`;

test("process.exit is not held up by the waiting call", onlyWindows, async () => {
  const result = await runScript(`${SCRIPT_START}
    (async () => {
      const listener = createIpcListener(stream => stream.on("error", () => {}));
      await listener.listen(endpoint);
      await connect();
      await nap(50);
      process.exit(7);
    })();
  `);

  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.code, 7, result.stderr);
});

test("after close and every client gone, nothing keeps the process alive", onlyWindows, async () => {
  const result = await runScript(`${SCRIPT_START}
    (async () => {
      const streams = [];
      const listener = createIpcListener((stream) => {
        streams.push(stream);
        stream.on("error", () => {});
        stream.on("data", () => {});
      });
      await listener.listen(endpoint);
      const clients = await Promise.all(Array.from({ length: 6 }, connect));
      await nap(50);
      // Each way an instance can end: its client leaves in the middle of a
      // write, the server destroys, the server ends.
      streams[0].write(Buffer.alloc(1024 * 1024));
      clients[0].destroy();
      streams[1].destroy();
      clients[2].on("data", () => {});
      streams[2].end("bye");
      await nap(100);
      listener.close();
      clients.slice(3).forEach(client => client.destroy());
      clients[1].destroy();
      clients[2].destroy();
      process.on("exit", code => console.log("exited " + code));
    })();
  `);

  assert.equal(result.signal, null, `killed by the watchdog: ${result.stdout}${result.stderr}`);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /exited 0/);
});

test("a listener that closes before any client still lets the process end", onlyWindows, async () => {
  const result = await runScript(`${SCRIPT_START}
    (async () => {
      const listener = createIpcListener(() => {});
      await listener.listen(endpoint);
      listener.close();
    })();
  `);

  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.code, 0, result.stderr);
});

test("creating a listener does not load koffi", async () => {
  const result = await runScript(`
    const Module = require("node:module");
    const realLoad = Module._load;
    let loaded = false;
    Module._load = function (request, ...rest) {
      if (request === "koffi") loaded = true;
      return realLoad.call(this, request, ...rest);
    };
    const { createIpcListener } = require(process.argv[1]);
    createIpcListener(() => {});
    console.log(loaded ? "loaded" : "not loaded");
  `);

  assert.equal(result.stdout.trim(), "not loaded", result.stderr);
});
