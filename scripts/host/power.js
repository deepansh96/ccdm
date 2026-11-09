"use strict";

// Keep-awake for ccdm-host: one Windows power request while project or thread
// sessions run on AC power, so the PC does not go to sleep under them when idle.
// Root and adhoc sessions never count, and on battery nothing is held.
//
// Everything Windows-specific sits behind a seam of two calls:
//   onAc()        -> false only when the PC is known to run on battery
//   hold(reason)  -> a function that releases that request
// koffi is loaded when the first call needs it, never at require time.
const fs = require("node:fs");
const path = require("node:path");

const { writeFileAtomicSync } = require("../platform/atomic.js");

const POLL_MS = 30_000;
const COUNTED_KINDS = new Set(["project", "thread"]);

const POWER_REQUEST_CONTEXT_VERSION = 0;
const POWER_REQUEST_CONTEXT_SIMPLE_STRING = 0x1;
// POWER_REQUEST_TYPE: holds off idle sleep, leaves the display alone.
const POWER_REQUEST_SYSTEM_REQUIRED = 1;
const INVALID_HANDLE_VALUE = -1;
// SYSTEM_POWER_STATUS is 12 bytes; ACLineStatus is its first: 0 battery, 1 AC, 255 unknown.
const SYSTEM_POWER_STATUS_SIZE = 12;
const AC_LINE_OFFLINE = 0;

const reasonFor = count => `CCDM: ${count} sessions`;
const countedSessions = sessions => sessions.filter(session => COUNTED_KINDS.has(session.kind)).length;

function loadPowerApi() {
  const koffi = require("koffi");
  const kernel32 = koffi.load("kernel32.dll");
  const fn = (name, result, args) => kernel32.func("__stdcall", name, result, args);
  // REASON_CONTEXT on 64-bit Windows: two 32-bit fields, then a 24-byte union
  // whose first 8 bytes are the simple reason string.
  const reasonContext = koffi.struct({
    Version: "uint32_t",
    Flags: "uint32_t",
    SimpleReasonString: "str16",
    Reserved: koffi.array("uint64_t", 2),
  });
  return {
    CloseHandle: fn("CloseHandle", "int", ["intptr_t"]),
    GetLastError: fn("GetLastError", "uint32_t", []),
    GetSystemPowerStatus: fn("GetSystemPowerStatus", "int", ["void *"]),
    PowerClearRequest: fn("PowerClearRequest", "int", ["intptr_t", "int"]),
    PowerCreateRequest: fn("PowerCreateRequest", "intptr_t", [koffi.pointer(reasonContext)]),
    PowerSetRequest: fn("PowerSetRequest", "int", ["intptr_t", "int"]),
  };
}

// The real seam. `api` is only passed by a test, which records the calls.
function win32PowerSeam(api = null) {
  const windows = () => (api ??= loadPowerApi());
  const failure = what => new Error(`${what} failed (Windows error ${windows().GetLastError()})`);
  return {
    onAc() {
      const status = Buffer.alloc(SYSTEM_POWER_STATUS_SIZE);
      if (!windows().GetSystemPowerStatus(status)) throw failure("GetSystemPowerStatus");
      // A desktop reports AC. An unknown state keeps the request: only a known battery releases it.
      return status[0] !== AC_LINE_OFFLINE;
    },
    hold(reason) {
      const { CloseHandle, PowerClearRequest, PowerCreateRequest, PowerSetRequest } = windows();
      const handle = PowerCreateRequest({
        Version: POWER_REQUEST_CONTEXT_VERSION,
        Flags: POWER_REQUEST_CONTEXT_SIMPLE_STRING,
        SimpleReasonString: reason,
        Reserved: [0, 0],
      });
      if (!handle || Number(handle) === INVALID_HANDLE_VALUE) throw failure("PowerCreateRequest");
      if (!PowerSetRequest(handle, POWER_REQUEST_SYSTEM_REQUIRED)) {
        const error = failure("PowerSetRequest");
        CloseHandle(handle);
        throw error;
      }
      return () => {
        PowerClearRequest(handle, POWER_REQUEST_SYSTEM_REQUIRED);
        CloseHandle(handle);
      };
    },
  };
}

// Tests only: the seam as files in `dir`. A file `ac` holding "battery" means
// battery power; `requests.json` is what is held now and every call so far.
function fakePowerSeam(dir) {
  const record = { held: [], calls: [] };
  const save = () => writeFileAtomicSync(path.join(dir, "requests.json"), `${JSON.stringify(record)}\n`);
  fs.mkdirSync(dir, { recursive: true });
  save();
  return {
    onAc() {
      try {
        return fs.readFileSync(path.join(dir, "ac"), "utf8").trim() !== "battery";
      } catch {
        return true;
      }
    },
    hold(reason) {
      record.held.push(reason);
      record.calls.push(["hold", reason]);
      save();
      return () => {
        record.held.splice(record.held.indexOf(reason), 1);
        record.calls.push(["release", reason]);
        save();
      };
    },
  };
}

// Holds one request whose reason follows the count. A change of count takes the
// new request before it lets the old one go, so the PC is never left without one.
function createKeepAwake({ seam, pollMs = POLL_MS, log = () => {} }) {
  let count = 0;
  let held = null;
  let timer = null;
  let lastProblem = null;

  function apply() {
    try {
      const wanted = count > 0 && seam.onAc() ? reasonFor(count) : null;
      if ((held?.reason ?? null) === wanted) return;
      const previous = held;
      held = wanted === null ? null : { reason: wanted, release: seam.hold(wanted) };
      log(wanted === null ? "keep-awake released" : `keep-awake holds "${wanted}"`);
      previous?.release();
      lastProblem = null;
    } catch (error) {
      // Sessions matter more than sleep: say it once and try again at the next poll.
      if (error.message !== lastProblem) log(`keep-awake is not available: ${error.message}`);
      lastProblem = error.message;
    }
  }

  return {
    // `sessions` is every live session; AC power is polled only while one counts.
    update(sessions) {
      count = countedSessions(sessions);
      if (count > 0 && !timer) {
        timer = setInterval(apply, pollMs);
        timer.unref();
      } else if (count === 0 && timer) {
        clearInterval(timer);
        timer = null;
      }
      apply();
    },
    close() {
      this.update([]);
    },
  };
}

// The keep-awake of one `serve`, or null when it was not asked for. The host task
// asks with CCDM_HOST_KEEP_AWAKE=1; a host started by hand holds nothing.
function keepAwakeFromEnv(env, log) {
  if (env.CCDM_HOST_KEEP_AWAKE !== "1") return null;
  // Both names below are for tests: the fake seam's directory and a shorter poll.
  const seam = env.CCDM_HOST_POWER_FAKE ? fakePowerSeam(env.CCDM_HOST_POWER_FAKE) : win32PowerSeam();
  return createKeepAwake({ seam, pollMs: Number(env.CCDM_HOST_POWER_POLL_MS) || POLL_MS, log });
}

module.exports = { POLL_MS, createKeepAwake, keepAwakeFromEnv, reasonFor, win32PowerSeam };
