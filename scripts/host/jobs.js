"use strict";

// One Windows Job object per session. Job members cannot leave, so a detached
// grandchild dies with its session. koffi is loaded only when first needed.
const JOB_OBJECT_BASIC_PROCESS_ID_LIST = 3;
const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
const PROCESS_SET_QUOTA = 0x0100;
const PROCESS_TERMINATE = 0x0001;
const JOB_OBJECT_ASSIGN_PROCESS_ACCESS = PROCESS_SET_QUOTA | PROCESS_TERMINATE;
// JOBOBJECT_EXTENDED_LIMIT_INFORMATION on 64-bit Windows: BasicLimitInformation
// (LimitFlags at byte 16), IoInfo and four sizes. SetInformationJobObject rejects any other length.
const EXTENDED_LIMIT_SIZE = 144;
const LIMIT_FLAGS_OFFSET = 16;
const PID_LIST_HEADER = 8;
const PID_ENTRY = 8;

let win32 = null;

function kernel32() {
  if (win32) return win32;
  const koffi = require("koffi");
  const library = koffi.load("kernel32.dll");
  const fn = (name, result, args) => library.func("__stdcall", name, result, args);
  win32 = {
    AssignProcessToJobObject: fn("AssignProcessToJobObject", "int", ["void *", "void *"]),
    CloseHandle: fn("CloseHandle", "int", ["void *"]),
    CreateJobObjectW: fn("CreateJobObjectW", "void *", ["void *", "void *"]),
    GetCurrentProcess: fn("GetCurrentProcess", "void *", []),
    GetLastError: fn("GetLastError", "uint32_t", []),
    IsProcessInJob: fn("IsProcessInJob", "int", ["void *", "void *", koffi.out(koffi.pointer("int"))]),
    OpenProcess: fn("OpenProcess", "void *", ["uint32_t", "int", "uint32_t"]),
    QueryInformationJobObject: fn("QueryInformationJobObject", "int", ["void *", "int", "void *", "uint32_t", "void *"]),
    SetInformationJobObject: fn("SetInformationJobObject", "int", ["void *", "int", "void *", "uint32_t"]),
    TerminateJobObject: fn("TerminateJobObject", "int", ["void *", "uint32_t"]),
  };
  return win32;
}

function lastError(api, what) {
  return new Error(`${what} failed (Windows error ${api.GetLastError()})`);
}

// A Job with kill-on-close: if the host dies, every member dies with it.
function createSessionJob() {
  const api = kernel32();
  let handle = api.CreateJobObjectW(null, null);
  if (!handle) throw lastError(api, "CreateJobObjectW");
  const limits = Buffer.alloc(EXTENDED_LIMIT_SIZE);
  limits.writeUInt32LE(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, LIMIT_FLAGS_OFFSET);
  if (!api.SetInformationJobObject(handle, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION, limits, limits.length)) {
    const error = lastError(api, "SetInformationJobObject");
    api.CloseHandle(handle);
    throw error;
  }
  return {
    assign(pid) {
      const processHandle = api.OpenProcess(JOB_OBJECT_ASSIGN_PROCESS_ACCESS, 0, pid);
      if (!processHandle) throw lastError(api, "OpenProcess");
      try {
        if (!api.AssignProcessToJobObject(handle, processHandle)) throw lastError(api, "AssignProcessToJobObject");
      } finally {
        api.CloseHandle(processHandle);
      }
    },
    pids() {
      if (!handle) return [];
      for (let capacity = 256; ; capacity *= 2) {
        const list = Buffer.alloc(PID_LIST_HEADER + capacity * PID_ENTRY);
        const ok = api.QueryInformationJobObject(handle, JOB_OBJECT_BASIC_PROCESS_ID_LIST, list, list.length, null);
        const assigned = list.readUInt32LE(0);
        const listed = list.readUInt32LE(4);
        if (ok && listed >= assigned) {
          return Array.from({ length: listed },
            (_, index) => Number(list.readBigUInt64LE(PID_LIST_HEADER + index * PID_ENTRY)));
        }
        if (!ok && assigned <= capacity) throw lastError(api, "QueryInformationJobObject");
      }
    },
    terminate(exitCode = 1) {
      if (handle && !api.TerminateJobObject(handle, exitCode)) throw lastError(api, "TerminateJobObject");
    },
    close() {
      if (!handle) return;
      api.CloseHandle(handle);
      handle = null;
    },
  };
}

function runningInJob() {
  const api = kernel32();
  const result = [0];
  if (!api.IsProcessInJob(api.GetCurrentProcess(), null, result)) throw lastError(api, "IsProcessInJob");
  return result[0] !== 0;
}

// Whether this process may serve here; the one place that decides. A daemon
// started inside someone else's Job would die when that Job is closed.
function jobPolicyProblem({ allowInJob = false } = {}) {
  if (allowInJob || !runningInJob()) return null;
  return "ccdm-host is running inside a Windows Job object, so it would die with whatever created that Job; "
    + "start it from a normal shell or the host task, or pass --allow-in-job to run it here anyway";
}

module.exports = { createSessionJob, jobPolicyProblem };
