"use strict";

// One Router at a time, foreground or supervised: a private lock file in the
// state directory records the holder's pid. A lock left by a dead process
// (a crash or SIGKILL) is reclaimed so launchd's relaunch can start.
const fs = require("node:fs");
const path = require("node:path");

const LOCK_FILE = "router.lock";

function holderAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function acquireRouterLock(stateDir) {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(stateDir, 0o700);
  const lockPath = path.join(stateDir, LOCK_FILE);
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd;
    try {
      fd = fs.openSync(lockPath, "wx", 0o600);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const pid = Number.parseInt(fs.readFileSync(lockPath, "utf8"), 10);
      if (holderAlive(pid)) {
        throw new Error(`another Router is already running (pid ${pid}); stop it before starting a new one`);
      }
      fs.rmSync(lockPath, { force: true });
      continue;
    }
    fs.writeSync(fd, `${process.pid}\n`);
    fs.closeSync(fd);
    let held = true;
    const release = () => {
      if (!held) return;
      held = false;
      // Only remove the lock this process still owns.
      try {
        if (Number.parseInt(fs.readFileSync(lockPath, "utf8"), 10) === process.pid) fs.rmSync(lockPath, { force: true });
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
