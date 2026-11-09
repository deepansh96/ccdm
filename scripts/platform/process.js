"use strict";

// Which process is this, and is that one still running? Windows reuses PIDs
// quickly, so there a PID is paired with its creation time. On POSIX the start
// time is always null and liveness is the PID alone, as it has always been.
// ccdmlib/platform/proc.py gives the same answers.
const WIN32 = process.platform === "win32";
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const STILL_ACTIVE = 259;

let win32 = null;

// koffi is an optional dependency that exists for Windows; load it only here.
function kernel32() {
  if (win32) return win32;
  const koffi = require("koffi");
  const library = koffi.load("kernel32.dll");
  const HANDLE = koffi.pointer("CCDM_HANDLE", koffi.opaque());
  const FILETIME = koffi.struct("CCDM_FILETIME", { low: "uint32_t", high: "uint32_t" });
  const fileTimeOut = koffi.out(koffi.pointer(FILETIME));
  win32 = {
    CloseHandle: library.func("__stdcall", "CloseHandle", "int", [HANDLE]),
    GetExitCodeProcess: library.func("__stdcall", "GetExitCodeProcess", "int",
      [HANDLE, koffi.out(koffi.pointer("uint32_t"))]),
    GetProcessTimes: library.func("__stdcall", "GetProcessTimes", "int",
      [HANDLE, fileTimeOut, fileTimeOut, fileTimeOut, fileTimeOut]),
    OpenProcess: library.func("__stdcall", "OpenProcess", HANDLE, ["uint32_t", "int", "uint32_t"]),
  };
  return win32;
}

// The creation time of a running process as the decimal string of FILETIME
// ticks, or null when it cannot be read (POSIX, gone, or access denied).
function processStartTime(pid) {
  if (!WIN32) return null;
  const api = kernel32();
  const handle = api.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
  if (!handle) return null;
  try {
    const exitCode = [0];
    if (!api.GetExitCodeProcess(handle, exitCode) || exitCode[0] !== STILL_ACTIVE) return null;
    const created = {};
    if (!api.GetProcessTimes(handle, created, {}, {}, {})) return null;
    return ((BigInt(created.high) << 32n) | BigInt(created.low)).toString();
  } finally {
    api.CloseHandle(handle);
  }
}

function processIdentity() {
  return { pid: process.pid, startedAt: processStartTime(process.pid) };
}

function processAlive(pid, startedAt = null) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch (error) {
    return error.code === "EPERM";
  }
  if (!WIN32 || startedAt === null) return true;
  const actual = processStartTime(pid);
  return actual === null || actual === startedAt;
}

const DEFAULT_SHUTDOWN_SIGNALS = Object.freeze(["SIGINT", "SIGTERM", "SIGHUP", ...(WIN32 ? ["SIGBREAK"] : [])]);

// Calls `fn` once, with the signal name or "stdin", when this process is asked
// to stop. Stdin EOF counts only when asked for. Returns a function that
// removes the handlers.
function onShutdown(fn, { signals = DEFAULT_SHUTDOWN_SIGNALS, stdinEof = false } = {}) {
  let fired = false;
  const trigger = reason => {
    if (fired) return;
    fired = true;
    fn(reason);
  };
  const onStdinEnd = () => trigger("stdin");
  for (const signal of signals) process.on(signal, trigger);
  if (stdinEof) {
    process.stdin.on("end", onStdinEnd);
    process.stdin.resume();
  }
  return () => {
    for (const signal of signals) process.off(signal, trigger);
    if (stdinEof) process.stdin.off("end", onStdinEnd);
  };
}

module.exports = { onShutdown, processAlive, processIdentity, processStartTime };
