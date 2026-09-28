#!/usr/bin/env node
"use strict";

// Reports a Claude Thread Conversation's turns to the Thread Supervisor, which
// keeps `turn_running` so a session mid-turn is never evicted for capacity.
// The thread proxy reports a turn start when it relays an inbound message; run
// as the thread's `Stop` and `StopFailure` command hook, this reports the end.
const { execFile } = require("node:child_process");
const os = require("node:os");
const path = require("node:path");

const SERVICE = path.join(__dirname, "thread-supervisor.py");
const DEFAULT_STATE_DIR = path.join(os.homedir(), ".local", "state", "ccdm", "thread-supervisor");

function reportTurn(threadId, event, stateDir = DEFAULT_STATE_DIR) {
  const payload = JSON.stringify({ thread_id: threadId, event });
  return new Promise(resolve => {
    execFile(process.env.CCDM_THREAD_PYTHON || "python3", [SERVICE, "host-event", "--project-root",
      path.resolve(__dirname, ".."), "--state-dir", stateDir, "--payload", payload], { timeout: 30000 },
    (error, _stdout, stderr) => {
      if (error) process.stderr.write(`Claude thread turns: reporting ${event} failed: ${stderr.trim() || error.message}\n`);
      resolve(!error);
    });
  });
}

async function hook() {
  const argument = name => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : null;
  const threadId = argument("--thread-id");
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  const event = JSON.parse(input).hook_event_name;
  if (!threadId || !["Stop", "StopFailure"].includes(event)) return;
  if (!await reportTurn(threadId, "turn-ended", argument("--state-dir") || DEFAULT_STATE_DIR)) process.exitCode = 1;
}

if (require.main === module) {
  hook().catch(error => {
    process.stderr.write(`Claude thread turns: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { reportTurn };
