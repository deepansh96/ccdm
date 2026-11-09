const fs = require("node:fs");
const path = require("node:path");

// Harness, fixture binaries, and child-scoped shims all read-modify-write the
// same state.json. Without a cross-process lock, a concurrent writer can drop
// another process's recorded side effect (for example a fake Discord DELETE).
const pause = new Int32Array(new SharedArrayBuffer(4));
// Critical sections take milliseconds, but a loaded machine can stall a
// holder for seconds; a lock this old belongs to a process that exited while
// holding it.
const STALE_LOCK_MS = 10000;

function withStateLock(stateDir, action) {
  if (!stateDir) return action();
  fs.mkdirSync(stateDir, { recursive: true });
  const lock = path.join(stateDir, "state.lock");
  for (;;) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > STALE_LOCK_MS) fs.rmdirSync(lock);
      } catch { /* Another waiter already cleared or replaced it. */ }
      Atomics.wait(pause, 0, 0, 2);
    }
  }
  try {
    return action();
  } finally {
    fs.rmSync(lock, { force: true, recursive: true });
  }
}

// Windows refuses a rename over a file another process has open, and readers
// poll state.json without the lock.
function replaceStateFile(from, to) {
  const deadline = Date.now() + STALE_LOCK_MS;
  for (;;) {
    try {
      return fs.renameSync(from, to);
    } catch (error) {
      if (!["EPERM", "EACCES", "EBUSY"].includes(error.code) || Date.now() > deadline) throw error;
      Atomics.wait(pause, 0, 0, 5);
    }
  }
}

module.exports = { replaceStateFile, withStateLock };
