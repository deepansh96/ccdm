#!/usr/bin/env node
"use strict";

// A Claude/Codex/Gemini session's turn activity, `activity.json` in its launch
// dir. For threads the Thread Supervisor reads it to find an idle session to
// evict and to tell whose turn it is; for Claude channels the channel server
// keeps it so it can tell whether a turn is running:
//
//   turn_running                a turn is running
//   turn_agent_started          whether the running turn was started by an Agent Message
//   last_turn_end_at            when the last turn ended
//   last_turn_outcome           how it ended: completed, failed, or (Codex) interrupted
//   last_turn_agent_started     whether the last turn that ended was agent-started
//   last_ordinary_turn_end_at   when the last non-agent-started turn ended
//   last_ordinary_turn_outcome  how that last non-agent-started turn ended
//   turn_replied                whether the current or last turn posted a reply
//   paused                      /pause holds new turns
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

const { writeFileAtomicSync } = require("./platform/atomic.js");

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
  try {
    const activity = { ...readActivity(file) };
    update(activity);
    writeFileAtomicSync(file, `${JSON.stringify(activity)}\n`, { mode: 0o600 });
  } catch (error) {
    process.stderr.write(`thread activity: ${file} could not be written: ${error.message}\n`);
  } finally {
    fs.rmSync(lockFile, { force: true });
  }
}

// A turn starts (`running`), or ends with `outcome`. A new turn has not replied yet.
// `agentStarted` (boolean) flags an agent-started turn (`true`) or an ordinary
// turn / owner input joining a running turn (`false`).
function markTurn(file, running, outcome = "completed", { agentStarted } = {}) {
  writeActivity(file, activity => {
    if (running) {
      const wasRunning = activity.turn_running === true;
      if (!wasRunning) activity.turn_replied = false;
      activity.turn_running = true;
      activity.last_turn_end_at = activity.last_turn_end_at ?? null;
      if (agentStarted === true) {
        activity.turn_agent_started = true;
      } else if (agentStarted === false || !wasRunning) {
        delete activity.turn_agent_started;
      }
      return;
    }
    const endedAgentStarted = typeof agentStarted === "boolean"
      ? agentStarted
      : activity.turn_agent_started === true;
    const endedAt = new Date().toISOString();
    activity.turn_running = false;
    activity.last_turn_end_at = endedAt;
    activity.last_turn_outcome = outcome;
    delete activity.turn_agent_started;
    if (endedAgentStarted) {
      activity.last_turn_agent_started = true;
    } else {
      delete activity.last_turn_agent_started;
      activity.last_ordinary_turn_end_at = endedAt;
      activity.last_ordinary_turn_outcome = outcome;
    }
  });
}

// Owner (or thread driver) input joined a running turn, or a new thread launch
// started, so any agent-started flag clears.
function clearAgentStarted(file) {
  writeActivity(file, activity => {
    delete activity.turn_agent_started;
  });
}

// The running turn posted a reply.
function markReplied(file) {
  writeActivity(file, activity => { activity.turn_replied = true; });
}

function markPaused(file, paused) {
  writeActivity(file, activity => { activity.paused = Boolean(paused); });
}

// A new channel launch starts unpaused and with no turn running, clearing any
// stale state left by a previous launch.
function resetActivity(file) {
  writeActivity(file, activity => {
    activity.turn_running = false;
    activity.paused = false;
    activity.last_turn_end_at = null;
    delete activity.turn_agent_started;
    delete activity.last_turn_outcome;
    delete activity.last_turn_agent_started;
    delete activity.last_ordinary_turn_end_at;
    delete activity.last_ordinary_turn_outcome;
    delete activity.turn_replied;
  });
}

module.exports = { clearAgentStarted, markPaused, markReplied, markTurn, resetActivity };

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
