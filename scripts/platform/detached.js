"use strict";

// Starts a program that outlives its caller. POSIX only: the helper leaves the
// caller's session and process group, as today's `(...) &` restart strings do.
// On Windows a helper must leave the caller's Job, which only ccdm-host can do,
// so callers use the session host's runDetached there.
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

// `env` adds to the caller's environment. The helper never carries
// CCDM_SESSION_NAME: it belongs to no session, including the one that started it.
function spawnDetached(cmd, args = [], { cwd, env, log } = {}) {
  if (process.platform === "win32") {
    throw new Error("spawnDetached is POSIX only; on Windows use the session host's runDetached");
  }
  const childEnv = { ...process.env, ...env };
  delete childEnv.CCDM_SESSION_NAME;
  let logFd = null;
  if (log) {
    fs.mkdirSync(path.dirname(log), { recursive: true });
    logFd = fs.openSync(log, "a", 0o600);
  }
  try {
    const child = spawn(cmd, args, {
      cwd,
      detached: true,
      env: childEnv,
      stdio: logFd === null ? "ignore" : ["ignore", logFd, logFd],
    });
    // A program that cannot start is reported by the missing PID.
    child.on("error", () => {});
    child.unref();
    return child.pid;
  } finally {
    if (logFd !== null) fs.closeSync(logFd);
  }
}

module.exports = { spawnDetached };
