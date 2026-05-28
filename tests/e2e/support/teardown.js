import fs from "node:fs";

import { recordDiagnostic } from "./state.js";

const callbacks = [];
let cleanupRunning = false;
let handlersInstalled = false;

export function registerTeardownCallback(fn) {
  callbacks.push(fn);
}

export async function cleanup(options = {}) {
  if (cleanupRunning) {
    return;
  }
  cleanupRunning = true;
  const failures = [];
  while (callbacks.length > 0) {
    const callback = callbacks.pop();
    try {
      await callback();
    } catch (error) {
      failures.push({
        message: error.message,
        stack: error.stack,
      });
    }
  }
  for (const failure of failures) {
    try {
      recordDiagnostic("cleanupFailures", failure, { stateDir: options.stateDir });
    } catch {
      // Cleanup must continue even if diagnostics cannot be written.
    }
  }
  if (options.tmpRoot && fs.existsSync(options.tmpRoot)) {
    fs.rmSync(options.tmpRoot, { force: true, recursive: true });
  }
  cleanupRunning = false;
}

function installHandlers() {
  if (handlersInstalled) {
    return;
  }
  handlersInstalled = true;
  process.once("uncaughtException", async (error) => {
    await cleanup();
    throw error;
  });
  process.once("unhandledRejection", async (error) => {
    await cleanup();
    throw error;
  });
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, async () => {
      await cleanup();
      process.kill(process.pid, signal);
    });
  }
  process.once("exit", () => {
    if (!cleanupRunning) {
      cleanupRunning = true;
      while (callbacks.length > 0) {
        const callback = callbacks.pop();
        callback();
      }
    }
  });
}

installHandlers();
