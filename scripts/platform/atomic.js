"use strict";

// Replacing files and removing directories when another process may hold them
// open, which Windows reports as a sharing error instead of allowing it.
// ccdmlib/platform/atomic.py retries the same errors for the same budget.
const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { setTimeout: sleep } = require("node:timers/promises");

const WIN32 = process.platform === "win32";
const DEFAULT_BUDGET_MS = 2000;
const MAX_BACKOFF_MS = 50;
const SHARING_ERRORS = new Set(["EPERM", "EACCES", "EBUSY"]);
// A directory whose files are still being deleted reports ENOTEMPTY.
const REMOVE_ERRORS = new Set([...SHARING_ERRORS, "ENOTEMPTY"]);

const nextBackoff = backoff => Math.min(backoff * 2, MAX_BACKOFF_MS);

async function withRetry(action, retryable, budgetMs) {
  const deadline = performance.now() + budgetMs;
  for (let backoff = 1; ; backoff = nextBackoff(backoff)) {
    try {
      return await action();
    } catch (error) {
      const left = deadline - performance.now();
      if (!retryable.has(error.code) || left <= 0) throw error;
      await sleep(Math.min(backoff, left));
    }
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function renameWithRetrySync(src, dst, budgetMs) {
  const deadline = performance.now() + budgetMs;
  for (let backoff = 1; ; backoff = nextBackoff(backoff)) {
    try {
      fs.renameSync(src, dst);
      return;
    } catch (error) {
      const left = deadline - performance.now();
      if (!SHARING_ERRORS.has(error.code) || left <= 0) throw error;
      sleepSync(Math.min(backoff, left));
    }
  }
}

function renameWithRetry(src, dst, { budgetMs = DEFAULT_BUDGET_MS } = {}) {
  return withRetry(() => fsp.rename(src, dst), SHARING_ERRORS, budgetMs);
}

function removeDirWithRetry(dir, { budgetMs = DEFAULT_BUDGET_MS } = {}) {
  return withRetry(() => fsp.rm(dir, { recursive: true, force: true }), REMOVE_ERRORS, budgetMs);
}

function temporaryNameFor(file) {
  const suffix = `${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  return path.join(path.dirname(file), `.${path.basename(file)}.${suffix}`);
}

async function writeFileAtomic(file, data, { mode = 0o600 } = {}) {
  const temporary = temporaryNameFor(file);
  const handle = await fsp.open(temporary, "wx", mode);
  try {
    try {
      await handle.writeFile(data);
      if (!WIN32) await handle.chmod(mode);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await renameWithRetry(temporary, file);
  } catch (error) {
    await fsp.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

function writeFileAtomicSync(file, data, { mode = 0o600 } = {}) {
  const temporary = temporaryNameFor(file);
  const descriptor = fs.openSync(temporary, "wx", mode);
  try {
    try {
      fs.writeFileSync(descriptor, data);
      if (!WIN32) fs.fchmodSync(descriptor, mode);
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    renameWithRetrySync(temporary, file, DEFAULT_BUDGET_MS);
  } catch (error) {
    try {
      fs.rmSync(temporary, { force: true });
    } catch { /* The original error is the one to report. */ }
    throw error;
  }
}

module.exports = { removeDirWithRetry, renameWithRetry, writeFileAtomic, writeFileAtomicSync };
