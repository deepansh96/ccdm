#!/usr/bin/env node
"use strict";

// The Thread Supervisor's Router link. It holds the single `supervisor`
// Router connection through the shared RouterClient (reconnect, deadlines)
// and relays NDJSON over stdio with the Python worker that spawned it:
//
//   stdout: {type:"connected", bot_user_id, projects}  after each hello_ok
//           {type:"disconnected"}                       the Router went away
//           {type:"event", event, ...}                  every pushed event
//           {type:"response", id, ok, result|error}     an op call's answer
//   stdin:  {type:"request", id, op, args}              an op call
//
// It reads only its Router key; it has no Discord credential and calls
// Discord only through Router ops.
const fs = require("node:fs");
const readline = require("node:readline");
const { RouterClient, reconnectBackoff } = require("./router/client.js");

const argument = name => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : null;
const keyFile = argument("--key-file");

function emit(frame) {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

function log(message) {
  process.stderr.write(`thread-supervisor-link: ${message}\n`);
}

const client = new RouterClient({ key: fs.readFileSync(keyFile, "utf8").trim(), role: "supervisor" });
const connected = () => emit({ type: "connected", bot_user_id: client.hello?.bot_user_id ?? null,
  projects: client.hello?.projects ?? [] });
client.on("event", frame => emit(frame));
client.on("reconnect", connected);
client.on("disconnect", () => emit({ type: "disconnected" }));
let closing = false;
client.on("end", error => {
  if (closing) return;
  log(`the Router ended the supervisor connection: ${error?.code ?? "closed"}`);
  process.exit(1);
});

// The first connect does not retry on its own, so the link waits for a Router
// that is not up yet with the client's own backoff.
async function connect() {
  const { minMs, maxMs } = reconnectBackoff();
  for (let attempt = 0; ; attempt++) {
    try {
      await client.connect();
      return connected();
    } catch (error) {
      if (error.code !== "router_unavailable") {
        log(`the Router refused the supervisor hello: ${error.code}`);
        process.exit(1);
      }
      await new Promise(resolve => setTimeout(resolve, Math.min(maxMs, minMs * 2 ** attempt)));
    }
  }
}

readline.createInterface({ input: process.stdin }).on("line", line => {
  let frame;
  try {
    frame = JSON.parse(line);
  } catch {
    return;
  }
  if (frame?.type !== "request") return;
  client.request(frame.op, frame.args ?? {}).then(
    result => emit({ type: "response", id: frame.id, ok: true, result }),
    error => emit({ type: "response", id: frame.id, ok: false,
      error: { code: error.code ?? "link_error", message: error.message } }));
}).on("close", shutdown);

// The worker closes stdin, or signals, when it stops.
function shutdown() {
  closing = true;
  client.close();
  process.exit(0);
}

for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, shutdown);

connect();
