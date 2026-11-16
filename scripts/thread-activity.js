#!/usr/bin/env node
"use strict";

// A thread session's turn activity, `activity.json` in its launch dir, which
// the Thread Supervisor reads to find an idle session to evict and to tell
// whose turn it is:
//
//   turn_running       a turn is running
//   last_turn_end_at   when the last turn ended
//   last_turn_outcome  how it ended: completed, failed, or (Codex) interrupted
//   turn_replied       whether the current or last turn posted a reply
//   paused             /pause holds new turns
//
// It is replaced atomically (temporary file, then rename, mode 0600), and each
// write keeps the fields it does not change. The CCDM channel server marks a
// Claude turn running when it delivers a notification, and the codex bridge
// follows `turn/started` and `turn/completed`.
//
// Run as a Claude command hook with the activity file as its argument, it
// marks the turn ended on Stop (completed) and StopFailure (failed), and
// running on UserPromptSubmit, which covers a prompt Claude takes in after the
// turn that received it had already stopped.
const fs = require("node:fs");
const path = require("node:path");

function readActivity(file) {
  try {
    const previous = JSON.parse(fs.readFileSync(file, "utf8"));
    return previous && typeof previous === "object" ? previous : {};
  } catch {
    return {};
  }
}

function writeActivity(file, update) {
  if (!file) return;
  const activity = { ...readActivity(file) };
  update(activity);
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(activity)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, file);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    process.stderr.write(`thread activity: ${file} could not be written: ${error.message}\n`);
  }
}

// A turn starts (`running`), or ends with `outcome`. A new turn has not replied yet.
function markTurn(file, running, outcome = "completed") {
  writeActivity(file, activity => {
    if (running && activity.turn_running !== true) activity.turn_replied = false;
    activity.turn_running = running;
    activity.last_turn_end_at = running ? activity.last_turn_end_at ?? null : new Date().toISOString();
    if (!running) activity.last_turn_outcome = outcome;
  });
}

// The running turn posted a reply.
function markReplied(file) {
  writeActivity(file, activity => { activity.turn_replied = true; });
}

function markPaused(file, paused) {
  writeActivity(file, activity => { activity.paused = Boolean(paused); });
}

module.exports = { markPaused, markReplied, markTurn };

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
    if (event.agent_id) return;
    const file = process.argv[2];
    if (event.hook_event_name === "UserPromptSubmit") markTurn(file, true);
    else markTurn(file, false, event.hook_event_name === "StopFailure" ? "failed" : "completed");
  });
}
