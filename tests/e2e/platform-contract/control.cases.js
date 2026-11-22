import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { assertPrivate } from "../support/platform.js";

const SERVER = `
import sys
from pathlib import Path
from ccdmlib.platform import private_fs
from thread_supervisor import control
state = Path(sys.argv[1])
private_fs.ensure_private_dir(state)
seen = []
def post(frame):
    seen.append(frame["request"])
    frame["reply"]({"ok": True, "result": {"seen": len(seen), "echo": frame["request"]}})
server = control.ControlServer(state, post)
print("ready", flush=True)
sys.stdin.read()
server.close()
print("closed", flush=True)
`;

const REQUEST = `
import json, sys
from pathlib import Path
from thread_supervisor import control
try:
    print(json.dumps(control.request(Path(sys.argv[1]), json.loads(sys.argv[2]))))
except (OSError, ValueError) as error:
    print(json.dumps({"failed": type(error).__name__, "is_oserror": isinstance(error, OSError)}))
`;

// Speaks the pipe with no key: whatever it sends, it must never reach the service.
const NO_AUTHKEY = String.raw`
import json, sys
import multiprocessing.connection as mp
connection = mp.Client(sys.argv[1], family="AF_PIPE")
connection.send_bytes(b'{"op": "smuggled"}\n')
received = []
try:
    while True:
        received.append(connection.recv_bytes().decode("latin-1"))
except (EOFError, OSError):
    pass
print(json.dumps(received))
`;

const WRONG_AUTHKEY = `
import sys
import multiprocessing.connection as mp
try:
    mp.Client(sys.argv[1], family="AF_PIPE", authkey=b"not-the-key")
except mp.AuthenticationError:
    print("rejected")
else:
    print("accepted")
`;

const RAW_FRAME = String.raw`
import json, sys
import multiprocessing.connection as mp
connection = mp.Client(sys.argv[1], family="AF_PIPE", authkey=sys.argv[2].encode("ascii"))
connection.send_bytes(b'{"op": "raw"}\n')
print(json.dumps(connection.recv_bytes().decode("utf-8")))
`;

const HOLD_PIPE = `
import sys
import multiprocessing.connection as mp
listener = mp.Listener(sys.argv[1], family="AF_PIPE")
print("ready", flush=True)
sys.stdin.read()
`;

const stateDir = ctx => path.join(ctx.dir, "state");

async function startServer(ctx) {
  const server = ctx.start(ctx.python, ["-c", SERVER, stateDir(ctx)]);
  assert.equal(await server.line(), "ready");
  return server;
}

async function stopServer(server) {
  server.stdin.end();
  assert.equal(await server.line(), "closed");
  await server.exited;
}

const published = (ctx, suffix) => fs.readFileSync(path.join(stateDir(ctx), `supervisor.${suffix}`), "utf8").trim();

async function script(ctx, source, ...args) {
  const result = await ctx.pythonScript(source, args);
  assert.equal(result.code, 0, result.stderr);
  return result.stdout.trim();
}

const request = async (ctx, payload) => JSON.parse(await script(ctx, REQUEST, stateDir(ctx), JSON.stringify(payload)));

export default [
  {
    name: "a request and its answer round-trip through the supervisor's channel",
    async check(_outcomes, ctx) {
      const server = await startServer(ctx);
      const payload = { op: "ping", text: "café", nested: { a: [1, 2] } };
      assert.deepEqual(await request(ctx, payload), { ok: true, result: { seen: 1, echo: payload } });
      await stopServer(server);
    },
  },
  {
    name: "with no service listening, a request fails as OSError",
    async check(_outcomes, ctx) {
      fs.mkdirSync(stateDir(ctx));
      assert.equal((await request(ctx, { op: "ping" })).is_oserror, true);
    },
  },
  {
    name: "the channel's source never uses the unpickling receive",
    async check(_outcomes, ctx) {
      const source = fs.readFileSync(path.join(ctx.root, "scripts", "ccdmlib", "platform", "control.py"), "utf8");
      assert.doesNotMatch(source, /\brecv\(/);
      assert.match(source, /recv_bytes\(/);
      assert.match(source, /send_bytes\(/);
    },
  },
  {
    name: "the pipe rejects a client without the authkey, and its frame reaches no one",
    only: "win32",
    async check(_outcomes, ctx) {
      const server = await startServer(ctx);
      const pipe = published(ctx, "pipe");
      const received = JSON.parse(await script(ctx, NO_AUTHKEY, pipe));
      assert.ok(!received.some(frame => frame.includes('"ok"')), JSON.stringify(received));
      assert.equal(await script(ctx, WRONG_AUTHKEY, pipe), "rejected");
      // The first request that does arrive is the first the service has seen.
      assert.equal((await request(ctx, { op: "ping" })).result.seen, 1);
      await stopServer(server);
    },
  },
  {
    name: "frames on the pipe are NDJSON lines through send_bytes and recv_bytes",
    only: "win32",
    async check(_outcomes, ctx) {
      const server = await startServer(ctx);
      const frame = JSON.parse(await script(ctx, RAW_FRAME, published(ctx, "pipe"), published(ctx, "secret")));
      assert.ok(frame.endsWith("\n"), JSON.stringify(frame));
      assert.deepEqual(JSON.parse(frame), { ok: true, result: { seen: 1, echo: { op: "raw" } } });
      await stopServer(server);
    },
  },
  {
    name: "the authkey is private and rotates with the pipe name, which a held old pipe cannot block",
    only: "win32",
    async check(_outcomes, ctx) {
      const first = await startServer(ctx);
      assertPrivate(path.join(stateDir(ctx), "supervisor.secret"));
      const oldPipe = published(ctx, "pipe");
      const oldSecret = published(ctx, "secret");
      await stopServer(first);
      assert.equal(fs.existsSync(path.join(stateDir(ctx), "supervisor.pipe")), false);

      const squatter = ctx.start(ctx.python, ["-c", HOLD_PIPE, oldPipe]);
      assert.equal(await squatter.line(), "ready");
      const second = await startServer(ctx);
      assert.notEqual(published(ctx, "pipe"), oldPipe);
      assert.notEqual(published(ctx, "secret"), oldSecret);
      assert.equal((await request(ctx, { op: "ping" })).result.seen, 1);
      await stopServer(second);
    },
  },
  {
    name: "a pipe name left by a dead worker fails as OSError at once",
    only: "win32",
    async check(_outcomes, ctx) {
      const server = await startServer(ctx);
      await server.stop();
      assert.ok(fs.existsSync(path.join(stateDir(ctx), "supervisor.pipe")));
      assert.equal((await request(ctx, { op: "ping" })).is_oserror, true);
    },
  },
];
