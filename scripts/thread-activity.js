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
// write keeps the fields it does not change. Writers are several processes
// (the channel server or bridge, and each hook run), so a write holds
// `activity.json.lock` (created exclusively) across its read, merge and rename.
// The CCDM channel server marks a Claude turn running when it delivers a
// notification, and the codex bridge follows `turn/started` and
// `turn/completed`.
//
// Run as a Claude command hook with the activity file as its argument, it
// marks the turn ended on Stop (completed) and StopFailure (failed), and
// running on UserPromptSubmit, which covers a prompt Claude takes in after the
// turn that received it had already stopped. A prompt starting with `/` is a
// local command typed into the pane (such as /compact), which no Stop may
// follow, so it marks nothing.
const fs = require("node:fs");
const path = require("node:path");

// How long a write waits for the lock, and when a lock is old enough to be a
// crashed writer's.
const LOCK_WAIT_MS = 2000;
const LOCK_STALE_MS = 10000;

function readActivity(file) {
  try {
    const previous = JSON.parse(fs.readFileSync(file, "utf8"));
    return previous && typeof previous === "object" ? previous : {};
  } catch {
    return {};
  }
}

function pauseMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Takes the file's write lock; false when another writer held it past the wait.
function lock(lockFile) {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      fs.closeSync(fs.openSync(lockFile, "wx", 0o600));
      return true;
    } catch (error) {
      if (error.code !== "EEXIST") return false;
    }
    try {
      if (Date.now() - fs.statSync(lockFile).mtimeMs > LOCK_STALE_MS) fs.rmSync(lockFile, { force: true });
    } catch { /* Released meanwhile. */ }
    if (Date.now() >= deadline) return false;
    pauseMs(10);
  }
}

function writeActivity(file, update) {
  if (!file || !fs.existsSync(path.dirname(file))) return;
  const lockFile = `${file}.lock`;
  if (!lock(lockFile)) {
    process.stderr.write(`thread activity: ${file} is locked by another writer; this update is lost\n`);
    return;
  }
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  try {
    const activity = { ...readActivity(file) };
    update(activity);
    fs.writeFileSync(temporary, `${JSON.stringify(activity)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, file);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    process.stderr.write(`thread activity: ${file} could not be written: ${error.message}\n`);
  } finally {
    fs.rmSync(lockFile, { force: true });
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
    if (event.hook_event_name === "UserPromptSubmit") {
      if (!String(event.prompt ?? "").trimStart().startsWith("/")) markTurn(file, true);
    }
    else markTurn(file, false, event.hook_event_name === "StopFailure" ? "failed" : "completed");
  });
}
