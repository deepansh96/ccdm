import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { recordDiagnostic } from "./state.js";

const callbacks = [];
const skips = [];
let cleanupRunning = false;
let handlersInstalled = false;

const JOB_ACCOUNTING_INFORMATION = 1;
const JOB_EXTENDED_LIMIT_INFORMATION = 9;
const JOB_LIMIT_KILL_ON_CLOSE = 0x2000;
// 64-bit layouts of JOBOBJECT_EXTENDED_LIMIT_INFORMATION and
// JOBOBJECT_BASIC_ACCOUNTING_INFORMATION.
const JOB_LIMITS_SIZE = 144;
const JOB_LIMIT_FLAGS_OFFSET = 16;
const JOB_ACCOUNTING_SIZE = 48;
const JOB_ACTIVE_PROCESSES_OFFSET = 40;

let kernel32 = null;

// koffi is an optional dependency that exists for Windows; load it only here.
function jobApi() {
  if (kernel32) return kernel32;
  const koffi = createRequire(import.meta.url)("koffi");
  const library = koffi.load("kernel32.dll");
  const HANDLE = koffi.pointer("CCDM_E2E_HANDLE", koffi.opaque());
  kernel32 = {
    CloseHandle: library.func("__stdcall", "CloseHandle", "int", [HANDLE]),
    CreateEventW: library.func("__stdcall", "CreateEventW", HANDLE, ["void *", "int", "int", "str16"]),
    CreateJobObjectW: library.func("__stdcall", "CreateJobObjectW", HANDLE, ["void *", "str16"]),
    QueryInformationJobObject: library.func("__stdcall", "QueryInformationJobObject", "int",
      [HANDLE, "int", "void *", "uint32_t", "void *"]),
    SetEvent: library.func("__stdcall", "SetEvent", "int", [HANDLE]),
    SetInformationJobObject: library.func("__stdcall", "SetInformationJobObject", "int",
      [HANDLE, "int", "void *", "uint32_t"]),
    TerminateJobObject: library.func("__stdcall", "TerminateJobObject", "int", [HANDLE, "uint32_t"]),
  };
  return kernel32;
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// One job for everything a workspace's fixture launchers start. This process
// holds the only handle, so if the test file dies the kernel ends the tree. A
// process is in this job only because a launcher of this workspace put it there,
// which is the proof of ownership: no PID lookup, no command line.
export function createWorkspaceJob(fixtureDir, { launcherWaitMs, killWaitMs }) {
  const api = jobApi();
  const name = `Local\\ccdm-e2e-job-${process.pid}-${randomUUID()}`;
  const job = api.CreateJobObjectW(null, name);
  if (!job) throw new Error("CreateJobObjectW failed for a workspace job");
  const limits = Buffer.alloc(JOB_LIMITS_SIZE);
  limits.writeUInt32LE(JOB_LIMIT_KILL_ON_CLOSE, JOB_LIMIT_FLAGS_OFFSET);
  if (!api.SetInformationJobObject(job, JOB_EXTENDED_LIMIT_INFORMATION, limits, JOB_LIMITS_SIZE)) {
    api.CloseHandle(job);
    throw new Error("SetInformationJobObject failed for a workspace job");
  }
  const stopEvent = api.CreateEventW(null, 1, 0, `${name}-stop`);
  if (!stopEvent) {
    api.CloseHandle(job);
    throw new Error("CreateEventW failed for a workspace job");
  }
  const liveDir = path.join(fixtureDir, ".live");
  fs.mkdirSync(liveDir);
  fs.writeFileSync(path.join(fixtureDir, ".job"), `${name}\n`);

  const launchersRunning = () => {
    try {
      return fs.readdirSync(liveDir).length > 0;
    } catch {
      return false;
    }
  };
  const activeProcesses = () => {
    const accounting = Buffer.alloc(JOB_ACCOUNTING_SIZE);
    if (!api.QueryInformationJobObject(job, JOB_ACCOUNTING_INFORMATION, accounting, JOB_ACCOUNTING_SIZE, null)) return 0;
    return accounting.readUInt32LE(JOB_ACTIVE_PROCESSES_OFFSET);
  };
  const close = () => {
    api.CloseHandle(stopEvent);
    api.CloseHandle(job);
  };
  const waitWhile = async (condition, timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    while (condition() && Date.now() < deadline) await pause(25);
  };

  let stopped = false;
  return {
    // Ctrl+Break through each running launcher, its grace period, then the kill.
    // Returns null when nothing was running, so the exit path stays synchronous.
    stop() {
      if (stopped) return null;
      stopped = true;
      api.SetEvent(stopEvent);
      if (!launchersRunning() && activeProcesses() === 0) {
        close();
        return null;
      }
      return (async () => {
        await waitWhile(launchersRunning, launcherWaitMs);
        api.TerminateJobObject(job, 1);
        await waitWhile(() => launchersRunning() || activeProcesses() > 0, killWaitMs);
        close();
      })();
    },
  };
}

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
