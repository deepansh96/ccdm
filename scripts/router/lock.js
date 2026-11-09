"use strict";

// One Router at a time, foreground or supervised: a private lock file in the
// state directory records the holder's pid. A lock left by a dead process
// (a crash or SIGKILL) is reclaimed so launchd's relaunch can start.
const fs = require("node:fs");
const path = require("node:path");

const { ensurePrivateDirSync } = require("../platform/privacy.js");
const { processAlive, processIdentity } = require("../platform/process.js");

const LOCK_FILE = "router.lock";

// "<pid>\n" on POSIX. On Windows "<pid> <startedAt>\n", because a PID comes
// back into use quickly: a live PID with another start time is a stale lock.
function lockContent() {
  const { pid, startedAt } = processIdentity();
  return startedAt === null ? `${pid}\n` : `${pid} ${startedAt}\n`;
}

function holderOf(lockPath) {
  const text = fs.readFileSync(lockPath, "utf8");
  return { pid: Number.parseInt(text, 10), startedAt: text.trim().split(/\s+/)[1] ?? null };
}

function acquireRouterLock(stateDir) {
  ensurePrivateDirSync(stateDir);
  const lockPath = path.join(stateDir, LOCK_FILE);
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd;
    try {
      fd = fs.openSync(lockPath, "wx", 0o600);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const { pid, startedAt } = holderOf(lockPath);
      if (processAlive(pid, startedAt)) {
        throw new Error(`another Router is already running (pid ${pid}); stop it before starting a new one`);
      }
      fs.rmSync(lockPath, { force: true });
      continue;
    }
    fs.writeSync(fd, lockContent());
    fs.closeSync(fd);
    let held = true;
    const release = () => {
      if (!held) return;
      held = false;
      // Only remove the lock this process still owns.
      try {
        if (holderOf(lockPath).pid === process.pid) fs.rmSync(lockPath, { force: true, maxRetries: 5, retryDelay: 20 });
      } catch {
        // Already gone.
      }
    };
    process.once("exit", release);
    return release;
  }
  throw new Error(`another Router claimed ${lockPath} first`);
}

module.exports = { acquireRouterLock };
