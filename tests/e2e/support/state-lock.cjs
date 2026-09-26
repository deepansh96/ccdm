const fs = require("node:fs");
const path = require("node:path");

// Harness, fixture binaries, and child-scoped shims all read-modify-write the
// same state.json. Without a cross-process lock, a concurrent writer can drop
// another process's recorded side effect (for example a fake Discord DELETE).
const pause = new Int32Array(new SharedArrayBuffer(4));
// Critical sections take milliseconds; a lock this old belongs to a process
// that exited while holding it.
const STALE_LOCK_MS = 1000;

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

module.exports = { withStateLock };
