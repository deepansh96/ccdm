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
// The lock holds its holder's claim. On Windows a directory whose entry was
// removed a moment ago can still refuse to go, so the removal is tried again.
const CLEAR = Object.freeze({ force: true, recursive: true, maxRetries: 20, retryDelay: 5 });
// A waiter tries the lock every 2 ms; it checks for a dead holder this often.
const DEAD_HOLDER_CHECK_ROUNDS = 16;

// What a directory holds, or why that cannot be told.
function listing(dir) {
  try {
    return fs.readdirSync(dir);
  } catch (error) {
    return error.code;
  }
}

// The holder leaves its process id in the lock, as an empty directory of that
// name: one call to make, and nothing a file scanner opens.
function claim(lock) {
  fs.mkdirSync(path.join(lock, String(process.pid)));
}

function processGone(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error.code === "ESRCH";
  }
}

// A holder stopped inside its critical section, as a hard kill on Windows
// stops it, would keep every waiter out until the lock counts as stale.
// Removing the dead holder's claim succeeds for one waiter only, and that
// waiter takes the lock where it stands, so the lock is never absent for a
// second waiter to make. Returns whether this process now holds the lock.
function takeOverFromDeadHolder(lock) {
  const held = listing(lock);
  const holder = Array.isArray(held) ? held.find(name => /^\d+$/.test(name)) : null;
  if (!holder || !processGone(Number(holder))) return false;
  try {
    fs.rmdirSync(path.join(lock, holder));
    claim(lock);
    return true;
  } catch {
    // Another waiter took it over first, or the lock went away meanwhile.
    return false;
  }
}

// A holder that ran past the stale limit finds its claim gone: a waiter cleared
// the lock, and whatever is at this path now belongs to someone else.
function release(lock) {
  try {
    fs.rmdirSync(path.join(lock, String(process.pid)));
  } catch (error) {
    if (error.code === "ENOENT") return;
    fs.rmSync(lock, CLEAR);
    return;
  }
  try {
    fs.rmdirSync(lock);
  } catch (error) {
    if (error.code !== "ENOENT") fs.rmSync(lock, CLEAR);
  }
}

function withStateLock(stateDir, action) {
  if (!stateDir) return action();
  fs.mkdirSync(stateDir, { recursive: true });
  const lock = path.join(stateDir, "state.lock");
  const started = Date.now();
  let refusedSince = null;
  for (let round = 0; ; round += 1) {
    let made = false;
    try {
      fs.mkdirSync(lock);
      made = true;
      claim(lock);
      break;
    } catch (error) {
      // The lock was made but not claimed: give it back and go round again.
      if (made) {
        try {
          fs.rmdirSync(lock);
        } catch { /* A waiter that counted it as stale has cleared it. */ }
        if (error.code === "ENOENT") continue;
      }
      // On Windows a lock directory still being removed refuses a new one with
      // EPERM. That passes in milliseconds, so only an unbroken run of refusals
      // this long is a failure. The run is timed from its own first refusal: a
      // wait for a stale lock has already used up this long when the lock is
      // cleared, which is just when the next refusal comes.
      if (error.code === "EEXIST") {
        refusedSince = null;
      } else if (error.code === "EPERM" || error.code === "EACCES") {
        refusedSince ??= Date.now();
        if (Date.now() - refusedSince >= STALE_LOCK_MS) {
          // Node prints these with an uncaught error.
          error.stateLock = { refusedMs: Date.now() - refusedSince, waitedMs: Date.now() - started, stateDir: listing(stateDir) };
          throw error;
        }
      } else {
        throw error;
      }
      // Looked at on the first round and then now and again: each look opens the lock.
      if (error.code === "EEXIST" && round % DEAD_HOLDER_CHECK_ROUNDS === 0 && takeOverFromDeadHolder(lock)) break;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > STALE_LOCK_MS) fs.rmSync(lock, CLEAR);
      } catch { /* Another waiter already cleared or replaced it. */ }
      Atomics.wait(pause, 0, 0, 2);
    }
  }
  try {
    return action();
  } finally {
    release(lock);
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
