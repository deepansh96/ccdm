import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";
import { setImmediate as yieldToLoop } from "node:timers/promises";

const require = createRequire(import.meta.url);
const { serverProof } = require("../../../scripts/platform/ipc.js");

const PIPE_NAME = /^\\\\\.\\pipe\\ccdm-[0-9a-f]{32}-router$/;
const SECRET = /^[0-9a-f]{64}$/;
const SAMPLE_SECRET = "ab".repeat(32);
const SAMPLE_NONCE = "cd".repeat(32);
const SAMPLE_PROOF = "6bf4e1f20871ba74ced35ae59e9715b43abc2400e367a4936420f88c0c9c47f6";

const endpoint = { node: "ipc.ipcEndpoint", python: "ipc.endpoint" };
const readSecret = { node: "ipc.readIpcSecret", python: "ipc.read_secret" };
const prove = { node: "ipc.serverProof", python: "ipc.server_proof" };
const verify = { node: "ipc.verifyServerProof", python: "ipc.verify_server_proof" };

const pipeFor = label => `\\\\.\\pipe\\ccdm-test-${crypto.randomBytes(8).toString("hex")}-${label}`;

const publishers = [
  ["Node", "ipc.publishPipe", value => value, "node"],
  ["Python", "ipc.publish_pipe", ([pipe, secret]) => ({ pipe, secret }), "py"],
];

// Answers the proof, keeps every line it receives, and echoes later lines.
async function fakeServer(ctx, pipe, secret) {
  const received = [];
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    let buffer = "";
    socket.on("data", chunk => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        received.push(line);
        if (received.length % 2 === 1 && line.startsWith('{"type":"server_proof"')) {
          const proof = serverProof(secret, JSON.parse(line).nonce);
          socket.write(`${JSON.stringify({ type: "server_proof_ok", proof })}\n`);
        } else {
          socket.write(`echo ${line}\n`);
        }
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(pipe, resolve);
  });
  const close = () => new Promise(resolve => {
    for (const socket of sockets) socket.destroy();
    server.close(resolve);
  });
  ctx.defer(close);
  return { received, close };
}

const CONNECT_ONCE = `
import sys
from ccdmlib.platform import ipc
try:
    stream = ipc.connect(sys.argv[1], sys.argv[2])
except ipc.ServerProofError as error:
    print("refused:", error)
    sys.exit(0)
stream.write(b"ping\\n")
stream.flush()
sys.stdout.write(stream.readline().decode("utf-8"))
stream.close()
`;

const CONNECT_TWICE = `
import sys
from ccdmlib.platform import ipc
for _ in range(2):
    stream = ipc.connect(sys.argv[1], sys.argv[2])
    stream.write(b"ping\\n")
    stream.flush()
    sys.stdout.write(stream.readline().decode("utf-8"))
    sys.stdout.flush()
    stream.close()
    sys.stdin.readline()
`;

// A pipe with one listening instance: while the first client is connected the
// next one gets ERROR_PIPE_BUSY, until the server opens a second instance.
const BUSY_PIPE = `
import _winapi, json, sys, threading, time
from ccdmlib.platform import ipc
state_dir = sys.argv[1]
pipe, secret = ipc.publish_pipe(state_dir, "router")
OPEN = _winapi.PIPE_ACCESS_DUPLEX
MODE = _winapi.PIPE_WAIT  # Byte mode has no flag of its own.
def instance():
    return _winapi.CreateNamedPipe(pipe, OPEN, MODE, 2, 4096, 4096, 0, _winapi.NULL)
def serve(handle):
    try:
        _winapi.ConnectNamedPipe(handle, False)
    except OSError as error:
        # A client can arrive between CreateNamedPipe and ConnectNamedPipe: it is connected.
        if error.winerror != _winapi.ERROR_PIPE_CONNECTED:
            raise
    request = json.loads(_winapi.ReadFile(handle, 4096)[0])
    reply = json.dumps({"type": "server_proof_ok", "proof": ipc.server_proof(secret, request["nonce"])}) + "\\n"
    _winapi.WriteFile(handle, reply.encode("utf-8"))
first = instance()
threading.Thread(target=serve, args=(first,), daemon=True).start()
client_one = ipc.connect("router", state_dir)
def second():
    time.sleep(0.4)
    serve(instance())
threading.Thread(target=second, daemon=True).start()
started = time.monotonic()
client_two = ipc.connect("router", state_dir)
print(json.dumps({"waited_ms": (time.monotonic() - started) * 1000}))
`;

function publishLoop(language, target) {
  return language === "node" ? {
    run: ctx => ctx.nodeScript(`
      const { publishPipe } = require(process.argv[1]);
      const counts = { written: 0, starved: 0 };
      for (let i = 0; i < 40; i++) {
        try {
          publishPipe(process.argv[2], "router");
          counts.written += 1;
        } catch (error) {
          if (!["EPERM", "EACCES", "EBUSY"].includes(error.code)) throw error;
          counts.starved += 1;
        }
      }
      console.log(JSON.stringify(counts));
    `, [path.join(ctx.root, "scripts", "platform", "ipc.js"), target]),
  } : {
    run: ctx => ctx.pythonScript(`
import json, sys
from ccdmlib.platform import ipc
counts = {"written": 0, "starved": 0}
for _ in range(40):
    try:
        ipc.publish_pipe(sys.argv[1], "router")
        counts["written"] += 1
    except PermissionError:
        counts["starved"] += 1
print(json.dumps(counts))
`, [target]),
  };
}

export default [
  {
    name: "ipcEndpoint on POSIX is exactly today's router.sock path",
    only: "posix",
    ...endpoint,
    args: ctx => [path.join(ctx.work, "router"), "router"],
    async check({ node }, ctx) {
      const today = await ctx.nodeScript("process.stdout.write(require(process.argv[1]).socketPath())",
        [path.join(ctx.root, "scripts", "router", "paths.js")],
        { env: { CCDM_ROUTER_STATE_DIR: path.join(ctx.work, "router") } });
      assert.equal(today.code, 0, today.stderr);
      assert.equal(node.value, today.stdout);
    },
  },
  {
    name: "POSIX ignores the endpoint overrides",
    only: "posix",
    ...endpoint,
    env: { CCDM_ROUTER_SOCKET: "/tmp/other.sock" },
    args: ctx => [ctx.work, "router"],
    value: ctx => path.join(ctx.work, "router.sock"),
  },
  {
    name: "with both overrides set, router and host get different pipes on Windows",
    only: "win32",
    async setup() {
      return { router: pipeFor("router"), host: pipeFor("host") };
    },
    ...endpoint,
    env: (_, { router, host }) => ({ CCDM_ROUTER_SOCKET: router, CCDM_HOST_SOCKET: host }),
    args: ctx => [ctx.work, "router"],
    value: (_, { router }) => router,
    async check(_, ctx, { router, host }) {
      const env = { CCDM_ROUTER_SOCKET: router, CCDM_HOST_SOCKET: host };
      for (const [language, fn] of [["node", endpoint.node], ["python", endpoint.python]]) {
        const outcome = await ctx.call(language, fn, [ctx.work, "host"], env);
        assert.equal(outcome.value, host, `${language} host endpoint`);
      }
    },
  },
  {
    name: "a name with no override reads its published pipe on Windows",
    only: "win32",
    setup: ctx => fs.writeFileSync(path.join(ctx.work, "thread-supervisor.pipe"), "\\\\.\\pipe\\from-file\n"),
    ...endpoint,
    env: { CCDM_ROUTER_SOCKET: "\\\\.\\pipe\\unused" },
    args: ctx => [ctx.work, "thread-supervisor"],
    value: "\\\\.\\pipe\\from-file",
  },
  {
    name: "a missing .pipe file is an error on Windows",
    only: "win32",
    ...endpoint,
    args: ctx => [ctx.work, "router"],
    throws: ["ENOENT"],
  },
  ...publishers.flatMap(([label, fn, shape, caller]) => [
    {
      name: `a pipe published by ${label} has the right form and a fresh name each time`,
      async check(_, ctx) {
        const first = shape(await ctx[caller](fn, ctx.work, "router"));
        const second = shape(await ctx[caller](fn, ctx.work, "router"));
        assert.match(first.pipe, PIPE_NAME);
        assert.match(first.secret, SECRET);
        assert.notEqual(first.pipe, second.pipe);
        assert.notEqual(first.secret, second.secret);
        assert.equal(fs.readFileSync(path.join(ctx.work, "router.pipe"), "utf8"), second.pipe);
        assert.equal(fs.readFileSync(path.join(ctx.work, "router.secret"), "utf8"), second.secret);
      },
    },
    {
      name: `a secret published by ${label} is read by both`,
      setup: async ctx => shape(await ctx[caller](fn, ctx.work, "router")),
      ...readSecret,
      args: ctx => [ctx.work, "router"],
      value: (_, { secret }) => secret,
    },
    {
      name: `a pipe published by ${label} is resolved by both on Windows`,
      only: "win32",
      setup: async ctx => shape(await ctx[caller](fn, ctx.work, "router")),
      ...endpoint,
      args: ctx => [ctx.work, "router"],
      value: (_, { pipe }) => pipe,
    },
  ]),
  ...["node", "python"].map(language => ({
    name: `the .pipe file is never half-written (${language} publisher)`,
    async check(_, ctx) {
      const target = path.join(ctx.work, "router.pipe");
      let done = false;
      const running = publishLoop(language, ctx.work).run(ctx).then(result => {
        done = true;
        return result;
      });
      let reads = 0;
      while (!done) {
        try {
          assert.match(fs.readFileSync(target, "utf8"), PIPE_NAME);
          reads += 1;
        } catch (error) {
          if (!["ENOENT", "EBUSY", "EPERM", "EACCES"].includes(error.code)) throw error;
        }
        await yieldToLoop();
      }
      const result = await running;
      assert.equal(result.code, 0, result.stderr);
      assert.ok(reads > 0, "the reader never got a turn");
      // On Windows a nonstop reader can make a rename spend its whole budget. That
      // is the specified failure, and the file must still be whole.
      const { written, starved } = JSON.parse(result.stdout);
      assert.ok(written > 0, "no publish succeeded");
      if (process.platform !== "win32") assert.equal(starved, 0);
    },
  })),
  {
    name: "a proof is the HMAC of the nonce's hex string, keyed by the secret's hex string",
    ...prove,
    args: [SAMPLE_SECRET, SAMPLE_NONCE],
    value: SAMPLE_PROOF,
  },
  {
    name: "a proof made by Node verifies in both",
    setup: ctx => ctx.node(prove.node, SAMPLE_SECRET, SAMPLE_NONCE),
    ...verify,
    args: (_, proof) => [SAMPLE_SECRET, SAMPLE_NONCE, proof],
    value: true,
  },
  {
    name: "a proof made by Python verifies in both",
    setup: ctx => ctx.py(prove.python, SAMPLE_SECRET, SAMPLE_NONCE),
    ...verify,
    args: (_, proof) => [SAMPLE_SECRET, SAMPLE_NONCE, proof],
    value: true,
  },
  ...publishers.map(([label, , , caller]) => ({
    name: `a proof made by ${label} with a different secret fails in both`,
    setup: ctx => ctx[caller](caller === "node" ? prove.node : prove.python, "ef".repeat(32), SAMPLE_NONCE),
    ...verify,
    args: (_, proof) => [SAMPLE_SECRET, SAMPLE_NONCE, proof],
    value: false,
  })),
  ...[["for another nonce", () => serverProof(SAMPLE_SECRET, "00".repeat(32))],
    ["of the wrong length", () => "abc"], ["that is empty", () => ""], ["that is not text", () => null]]
    .map(([label, make]) => ({
      name: `a proof ${label} fails in both`,
      ...verify,
      args: [SAMPLE_SECRET, SAMPLE_NONCE, make()],
      value: false,
    })),
  {
    name: "prepareIpcListen removes a stale socket file on POSIX",
    only: "posix",
    setup: ctx => fs.writeFileSync(path.join(ctx.work, "router.sock"), ""),
    node: "ipc.prepareIpcListen",
    args: ctx => [path.join(ctx.work, "router.sock")],
    check(_, ctx) {
      assert.equal(fs.existsSync(path.join(ctx.work, "router.sock")), false);
    },
  },
  {
    name: "prepareIpcListen accepts a missing socket file on POSIX",
    only: "posix",
    node: "ipc.prepareIpcListen",
    args: ctx => [path.join(ctx.work, "router.sock")],
  },
  {
    name: "prepareIpcListen does nothing on Windows",
    only: "win32",
    setup: ctx => fs.writeFileSync(path.join(ctx.work, "router.sock"), ""),
    node: "ipc.prepareIpcListen",
    args: ctx => [path.join(ctx.work, "router.sock")],
    check(_, ctx) {
      assert.equal(fs.existsSync(path.join(ctx.work, "router.sock")), true);
    },
  },
  {
    name: "connect on POSIX uses the socket and sends no proof",
    only: "posix",
    async check(_, ctx) {
      const stateDir = path.join(ctx.work, "router");
      fs.mkdirSync(stateDir);
      const server = await fakeServer(ctx, path.join(stateDir, "router.sock"), SAMPLE_SECRET);
      const result = await ctx.pythonScript(CONNECT_ONCE, ["router", stateDir]);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.stdout.trim(), "echo ping");
      assert.deepEqual(server.received, ["ping"]);
    },
  },
  {
    name: "connect defaults to <stateRoot>/<name>",
    only: "posix",
    async check(_, ctx) {
      const stateDir = path.join(ctx.home, ".local", "state", "ccdm", "host");
      fs.mkdirSync(stateDir, { recursive: true });
      await fakeServer(ctx, path.join(stateDir, "host.sock"), SAMPLE_SECRET);
      const source = CONNECT_ONCE.replace("sys.argv[1], sys.argv[2]", '"host"');
      const result = await ctx.pythonScript(source);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.stdout.trim(), "echo ping");
    },
  },
  {
    name: "connect on Windows requires the proof, then hands over the stream",
    only: "win32",
    async check(_, ctx) {
      const { pipe, secret } = await ctx.node("ipc.publishPipe", ctx.work, "router");
      const server = await fakeServer(ctx, pipe, secret);
      const result = await ctx.pythonScript(CONNECT_ONCE, ["router", ctx.work]);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.stdout.trim(), "echo ping");
      assert.equal(server.received.length, 2);
      assert.match(JSON.parse(server.received[0]).nonce, SECRET);
      assert.equal(server.received[1], "ping");
    },
  },
  ...[false, true].map(override => ({
    name: `connect on Windows sends nothing to a server without the secret${override ? " (override set)" : ""}`,
    only: "win32",
    async check(_, ctx) {
      const { pipe } = await ctx.node("ipc.publishPipe", ctx.work, "host");
      const listened = override ? pipeFor("host") : pipe;
      const server = await fakeServer(ctx, listened, "12".repeat(32));
      const env = override ? { CCDM_HOST_SOCKET: listened } : {};
      const result = await ctx.pythonScript(CONNECT_ONCE, ["host", ctx.work], { env });
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /^refused:/);
      assert.equal(server.received.length, 1, "only the proof request may reach the server");
    },
  })),
  {
    name: "connect on Windows reaches the host override when the router override is also set",
    only: "win32",
    async check(_, ctx) {
      const { secret } = await ctx.node("ipc.publishPipe", ctx.work, "host");
      const host = pipeFor("host");
      await fakeServer(ctx, host, secret);
      const env = { CCDM_HOST_SOCKET: host, CCDM_ROUTER_SOCKET: pipeFor("router") };
      const result = await ctx.pythonScript(CONNECT_ONCE, ["host", ctx.work], { env });
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.stdout.trim(), "echo ping");
    },
  },
  {
    name: "connect on Windows reads the name and secret again on every call",
    only: "win32",
    async check(_, ctx) {
      const first = await ctx.node("ipc.publishPipe", ctx.work, "router");
      const firstServer = await fakeServer(ctx, first.pipe, first.secret);
      const client = ctx.start(ctx.python, ["-c", CONNECT_TWICE, "router", ctx.work]);
      assert.equal(await client.line(), "echo ping");
      await firstServer.close();
      const second = await ctx.node("ipc.publishPipe", ctx.work, "router");
      await fakeServer(ctx, second.pipe, second.secret);
      client.stdin.write("\n");
      assert.equal(await client.line(), "echo ping");
      client.stdin.end();
    },
  },
  {
    name: "connect on Windows waits out ERROR_PIPE_BUSY",
    only: "win32",
    async check(_, ctx) {
      const result = await ctx.pythonScript(BUSY_PIPE, [ctx.work]);
      assert.equal(result.code, 0, result.stderr);
      assert.ok(JSON.parse(result.stdout).waited_ms >= 200, result.stdout);
    },
  },
];
