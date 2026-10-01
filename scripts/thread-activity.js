#!/usr/bin/env node
"use strict";

// A thread session's turn activity, `activity.json {turn_running,
// last_turn_end_at}` in its launch dir, which the Thread Supervisor reads to
// find an idle session to evict. It is replaced atomically (temporary file,
// then rename, mode 0600). The CCDM channel server marks a Claude turn
// running when it delivers a notification, and the codex bridge follows
// `turn/started` and `turn/completed`.
//
// Run as a Claude command hook (Stop, StopFailure) with the activity file as
// its argument, it marks the turn ended.
const fs = require("node:fs");
const path = require("node:path");

function markTurn(file, running) {
  if (!file) return;
  let previous = {};
  try {
    previous = JSON.parse(fs.readFileSync(file, "utf8")) || {};
  } catch { /* No earlier turn. */ }
  const activity = {
    turn_running: running,
    last_turn_end_at: running ? previous.last_turn_end_at ?? null : new Date().toISOString(),
  };
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(activity)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, file);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    process.stderr.write(`thread activity: ${file} could not be written: ${error.message}\n`);
  }
}

module.exports = { markTurn };

if (require.main === module) {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", chunk => { input += chunk; });
  process.stdin.on("end", () => {
    let event = {};
    try {
      event = JSON.parse(input);
    } catch { /* A hook with no input still ends the turn. */ }
    // A subagent's stop is not the session's turn ending.
    if (!event.agent_id) markTurn(process.argv[2], false);
  });
}
