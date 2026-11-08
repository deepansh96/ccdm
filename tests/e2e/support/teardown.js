import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { recordDiagnostic } from "./state.js";

const callbacks = [];
const skips = [];
let cleanupRunning = false;
let handlersInstalled = false;

function windowsPowerShell() {
  // By absolute path, so nothing on PATH can stand in for it.
  return process.env.SystemRoot
    ? path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    : "powershell";
}

function commandLineLookup(pid) {
  if (process.platform === "win32") {
    const script = `[Console]::OutputEncoding=[Text.Encoding]::UTF8;(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`;
    return [windowsPowerShell(), ["-NoProfile", "-NonInteractive", "-Command", script]];
  }
  return [fs.existsSync("/bin/ps") ? "/bin/ps" : "ps", ["-ww", "-o", "command=", "-p", String(pid)]];
}

// The command line of a running process, or null when it has gone or cannot be read.
function commandLineOf(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const [command, args] = commandLineLookup(pid);
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 15000, windowsHide: true });
  return result.status === 0 && result.stdout.trim() ? result.stdout.trim() : null;
}

function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

// PIDs read from state may have been reused by an unrelated process, so a
// recorded PID is signalled only when its command line holds the workspace's
// marker (its tmpRoot path). A live process that fails the check is logged.
export function workspaceOwnsPid(pid, marker) {
  const commandLine = commandLineOf(pid);
  if (commandLine?.includes(marker)) return true;
  if (isRunning(pid)) {
    skips.push({ marker, pid });
    process.stderr.write(`ccdm-e2e-teardown skipped pid ${pid}: its command line does not hold ${marker}\n`);
  }
  return false;
}

// Recorded PIDs the harness refused to signal, oldest first.
export function teardownSkips() {
  return [...skips];
}

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

function syncCleanup() {
  if (cleanupRunning) return;
  cleanupRunning = true;
  while (callbacks.length > 0) {
    const callback = callbacks.pop();
    try {
      callback();
    } catch {
      // Best-effort synchronous cleanup — swallow errors.
    }
  }
}

function installHandlers() {
  if (handlersInstalled) {
    return;
  }
  handlersInstalled = true;
  process.once("uncaughtException", (error) => {
    syncCleanup();
    process.exitCode = 1;
    throw error;
  });
  process.once("unhandledRejection", (error) => {
    syncCleanup();
    process.exitCode = 1;
    throw error;
  });
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, async () => {
      await cleanup();
      process.kill(process.pid, signal);
    });
  }
  process.once("exit", () => {
    syncCleanup();
  });
}

installHandlers();
