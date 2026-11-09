"use strict";

// One privacy rule in two languages; ccdmlib/platform/private_fs.py is the twin
// and tests/e2e/platform-contract/privacy.cases.js fails when they disagree.
//
// POSIX: the owner's uid and the mode bits, as always.
// Windows, where mode bits mean nothing: a private directory is owned by the
// current user and has a protected DACL (inheritance off) whose only entries are
// that user with full control (OI)(CI), plus SYSTEM if present. A private file
// sits in a private directory, and its own DACL has no entry for another SID.
//
// The DACL is read through the Win32 API and set with icacls.exe. Its output is
// localized, so only its exit status is ever used.
const { execFile, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const fsPromises = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { promisify } = require("node:util");

const { stateRoot } = require("./paths.js");

const WIN32 = process.platform === "win32";
const DEFAULT_LABEL = "Private directory";
const SYSTEM_SID = "S-1-5-18";
const TMP_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
// Where icacls /inheritance:r keeps the inherited entries as explicit ones, as it
// does on GitHub's Windows runner, they can only be named on the next read. One
// round for owner and inheritance, one for those entries, one to spare.
const MAX_REPAIR_ROUNDS = 3;
const SE_FILE_OBJECT = 1;
const OWNER_SECURITY_INFORMATION = 1;
const DACL_SECURITY_INFORMATION = 4;
const SDDL_REVISION_1 = 1;
const TOKEN_QUERY = 8;
const TOKEN_USER_CLASS = 1;
const FULL_CONTROL = new Set(["FA", "GA", "0x1f01ff"]);
const FILE_ERRORS = { 2: "ENOENT", 3: "ENOENT", 5: "EACCES" };

let win32 = null;

// koffi is an optional dependency that exists for Windows; load it only here.
function api() {
  if (win32) return win32;
  const koffi = require("koffi");
  const advapi32 = koffi.load("advapi32.dll");
  const kernel32 = koffi.load("kernel32.dll");
  const out = koffi.out(koffi.pointer("void *"));
  win32 = {
    koffi,
    CloseHandle: kernel32.func("__stdcall", "CloseHandle", "int", ["void *"]),
    GetCurrentProcess: kernel32.func("__stdcall", "GetCurrentProcess", "void *", []),
    LocalFree: kernel32.func("__stdcall", "LocalFree", "void *", ["void *"]),
    ConvertSecurityDescriptorToStringSecurityDescriptorW: advapi32.func("__stdcall",
      "ConvertSecurityDescriptorToStringSecurityDescriptorW", "int", ["void *", "uint32_t", "uint32_t", out, "void *"]),
    ConvertSidToStringSidW: advapi32.func("__stdcall", "ConvertSidToStringSidW", "int", ["void *", out]),
    ConvertStringSidToSidW: advapi32.func("__stdcall", "ConvertStringSidToSidW", "int", ["str16", out]),
    GetNamedSecurityInfoW: advapi32.func("__stdcall", "GetNamedSecurityInfoW", "uint32_t",
      ["str16", "int", "uint32_t", "void *", "void *", "void *", "void *", out]),
    GetTokenInformation: advapi32.func("__stdcall", "GetTokenInformation", "int",
      ["void *", "int", "void *", "uint32_t", koffi.out(koffi.pointer("uint32_t"))]),
    OpenProcessToken: advapi32.func("__stdcall", "OpenProcessToken", "int", ["void *", "uint32_t", out]),
  };
  return win32;
}

// Reads a LocalAlloc'd wide string and frees it.
function takeWideString(pointer) {
  const { koffi, LocalFree } = api();
  try {
    return koffi.decode(pointer, "char16_t", -1);
  } finally {
    LocalFree(pointer);
  }
}

function sidString(sid) {
  const text = [null];
  if (!api().ConvertSidToStringSidW(sid, text)) throw new Error("ConvertSidToStringSidW failed");
  return takeWideString(text[0]);
}

function currentUserSid() {
  if (!WIN32) return null;
  const { CloseHandle, GetCurrentProcess, GetTokenInformation, OpenProcessToken } = api();
  const token = [null];
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, token)) throw new Error("OpenProcessToken failed");
  try {
    const buffer = Buffer.alloc(256);
    if (!GetTokenInformation(token[0], TOKEN_USER_CLASS, buffer, buffer.length, [0])) {
      throw new Error("GetTokenInformation failed");
    }
    return sidString(api().koffi.decode(buffer, "void *"));
  } finally {
    CloseHandle(token[0]);
  }
}

// SDDL writes well-known SIDs as two-letter aliases; a fix line needs the SID.
function canonicalSid(trustee) {
  if (trustee.startsWith("S-")) return trustee;
  const { ConvertStringSidToSidW, LocalFree } = api();
  const sid = [null];
  if (!ConvertStringSidToSidW(trustee, sid)) return trustee;
  try {
    return sidString(sid[0]);
  } finally {
    LocalFree(sid[0]);
  }
}

function readSddl(target) {
  const { ConvertSecurityDescriptorToStringSecurityDescriptorW, GetNamedSecurityInfoW, LocalFree } = api();
  const information = OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION;
  const descriptor = [null];
  const status = GetNamedSecurityInfoW(target, SE_FILE_OBJECT, information, null, null, null, null, descriptor);
  if (status !== 0) {
    const code = FILE_ERRORS[status] ?? `WIN32_${status}`;
    throw Object.assign(new Error(`${code}: cannot read the security descriptor of ${target}`), { code });
  }
  try {
    const text = [null];
    if (!ConvertSecurityDescriptorToStringSecurityDescriptorW(descriptor[0], SDDL_REVISION_1, information, text, null)) {
      throw new Error(`cannot convert the security descriptor of ${target}`);
    }
    return takeWideString(text[0]);
  } finally {
    LocalFree(descriptor[0]);
  }
}

// The top-level "(...)" groups of an ACE list; a conditional ACE nests more.
function splitAces(list) {
  const aces = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < list.length; index += 1) {
    if (list[index] === "(") {
      if (depth === 0) start = index + 1;
      depth += 1;
    } else if (list[index] === ")") {
      depth -= 1;
      if (depth === 0) aces.push(list.slice(start, index));
    }
  }
  return aces;
}

function hasFlag(flags, flag) {
  for (let index = 0; index + 1 < flags.length; index += 2) {
    if (flags.slice(index, index + 2) === flag) return true;
  }
  return false;
}

function parseSddl(sddl) {
  const match = /^O:([^:]*?)D:(.*)$/s.exec(sddl);
  if (!match) throw new Error(`unexpected security descriptor: ${sddl}`);
  const dacl = match[2];
  const open = dacl.indexOf("(");
  const control = open < 0 ? dacl : dacl.slice(0, open);
  // A NULL DACL has no entries at all and lets everyone in.
  const nullDacl = control.includes("NO_ACCESS_CONTROL");
  const aces = nullDacl || open < 0 ? [] : splitAces(dacl.slice(open)).map(ace => {
    const [type, flags, rights, , , trustee] = ace.split(";");
    return { type, flags, rights: rights.toLowerCase().startsWith("0x") ? rights.toLowerCase() : rights, sid: canonicalSid(trustee) };
  });
  return { owner: canonicalSid(match[1]), protected: !nullDacl && control.replace(/AI|AR/g, "").includes("P"), nullDacl, aces };
}

function fullControl(ace) {
  return ace.type === "A" && FULL_CONTROL.has(ace.rights)
    && hasFlag(ace.flags, "OI") && hasFlag(ace.flags, "CI") && !hasFlag(ace.flags, "IO") && !hasFlag(ace.flags, "NP");
}

function fixLine(dir, args) {
  const rendered = args.map(arg => (arg.includes("(") ? `"${arg}"` : arg));
  return `icacls "${dir}" ${rendered.join(" ")}`;
}

// What is wrong with a directory's descriptor, in the order the fixes must run:
// the owner first (the owner may always rewrite the DACL), then the DACL.
function dirProblems(sddl, userSid) {
  const { owner, protected: isProtected, nullDacl, aces } = parseSddl(sddl);
  const problems = [];
  if (owner !== userSid) {
    problems.push({ what: `is owned by ${owner}`, args: ["/setowner", `*${userSid}`] });
  }
  const userEntry = aces.some(ace => ace.sid === userSid && fullControl(ace));
  if (!isProtected || !userEntry) {
    const inherited = isProtected ? "does not give this user full control" : "inherits permissions from its parent";
    problems.push({
      what: nullDacl ? "has no access control at all" : inherited,
      args: ["/inheritance:r", "/grant:r", `*${userSid}:(OI)(CI)F`],
    });
  }
  const seen = new Set();
  for (const ace of aces) {
    if (ace.sid === SYSTEM_SID) continue;
    const deny = ace.type !== "A" && ace.type.includes("D");
    if (ace.sid === userSid && !deny) continue;
    // Removing inheritance takes care of an inherited entry.
    if (!isProtected && hasFlag(ace.flags, "ID")) continue;
    const key = `${deny ? "deny" : "grant"}:${ace.sid}`;
    if (seen.has(key)) continue;
    seen.add(key);
    problems.push(deny
      ? { what: `has a deny entry for ${ace.sid}`, args: ["/remove:d", `*${ace.sid}`] }
      : { what: `gives access to ${ace.sid}`, args: ["/remove:g", `*${ace.sid}`] });
  }
  return problems;
}

function formatProblems(dir, problems, label) {
  return problems.map(({ what, args }) => `${label} ${dir} ${what}; run ${fixLine(dir, args)}`);
}

// The fix-text lines for a descriptor. Separate from the disk read so that a
// descriptor no unelevated test can create, such as a foreign owner, can be judged.
function blockersFromSddl(dir, sddl, userSid = currentUserSid(), label = DEFAULT_LABEL) {
  return formatProblems(dir, dirProblems(sddl, userSid), label);
}

// lstat's verdict shared by both OSes: an early line, or the directory's stat.
function inspectDir(dir, label) {
  let info;
  try {
    info = fs.lstatSync(dir);
  } catch (error) {
    if (error.code === "ENOENT") return { lines: [] };
    return { lines: [`${label} ${dir} cannot be inspected (${error.message}); fix its permissions`] };
  }
  if (!info.isDirectory()) return { lines: [`${label} ${dir} is not a directory; move it aside`] };
  return { info };
}

function win32DirProblems(dir) {
  return dirProblems(readSddl(dir), currentUserSid());
}

// [] when `dir` is private or missing, else one line per problem, each naming
// the directory and the command that fixes it.
function privateDirBlockers(dir, label = DEFAULT_LABEL) {
  const target = WIN32 ? path.resolve(dir) : dir;
  const { info, lines } = inspectDir(target, label);
  if (lines) return lines;
  if (WIN32) {
    try {
      return formatProblems(target, win32DirProblems(target), label);
    } catch (error) {
      return [`${label} ${target} cannot be inspected (${error.message}); fix its permissions`];
    }
  }
  const blockers = [];
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    blockers.push(`${label} ${dir} is owned by uid ${info.uid}; run chown ${process.getuid()} ${dir}`);
  }
  const mode = info.mode & 0o777;
  if (mode !== 0o700) blockers.push(`${label} ${dir} has mode 0${mode.toString(8)}; run chmod 700 ${dir}`);
  return blockers;
}

// Checked on every call. Throws like stat when the file is missing.
function isPrivateFile(file) {
  const info = fs.statSync(file);
  if (!WIN32) return (info.mode & 0o077) === 0;
  const target = path.resolve(file);
  if (info.isDirectory()) return privateDirBlockers(target).length === 0;
  if (privateDirBlockers(path.dirname(target)).length > 0) return false;
  const { nullDacl, aces } = parseSddl(readSddl(target));
  if (nullDacl) return false;
  const userSid = currentUserSid();
  return aces.every(ace => ace.sid === userSid || ace.sid === SYSTEM_SID);
}

const icaclsPath = () => path.join(process.env.SystemRoot || process.env.windir || "C:\\Windows", "System32", "icacls.exe");

function repairFailed(dir, detail) {
  return Object.assign(new Error(`cannot make ${dir} private: ${detail}`), { code: "EPERM" });
}

function checkRepaired(target) {
  const remaining = win32DirProblems(target);
  if (remaining.length > 0) throw repairFailed(target, formatProblems(target, remaining, DEFAULT_LABEL).join("; "));
}

function ensurePrivateDirSync(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!WIN32) {
    fs.chmodSync(dir, 0o700);
    return;
  }
  const target = path.resolve(dir);
  for (let round = 0; round < MAX_REPAIR_ROUNDS; round += 1) {
    const problems = win32DirProblems(target);
    if (problems.length === 0) return;
    for (const { args } of problems) {
      const result = spawnSync(icaclsPath(), [target, ...args], { stdio: "ignore", windowsHide: true });
      if (result.error) throw result.error;
      if (result.status !== 0) throw repairFailed(target, `icacls ${args[0]} exited with ${result.status}`);
    }
  }
  checkRepaired(target);
}

async function ensurePrivateDir(dir) {
  await fsPromises.mkdir(dir, { recursive: true, mode: 0o700 });
  if (!WIN32) {
    await fsPromises.chmod(dir, 0o700);
    return;
  }
  const target = path.resolve(dir);
  const run = promisify(execFile);
  for (let round = 0; round < MAX_REPAIR_ROUNDS; round += 1) {
    const problems = win32DirProblems(target);
    if (problems.length === 0) return;
    for (const { args } of problems) {
      try {
        await run(icaclsPath(), [target, ...args], { windowsHide: true });
      } catch (error) {
        throw repairFailed(target, `icacls ${args[0]} exited with ${error.code}`);
      }
    }
  }
  checkRepaired(target);
}

// Nothing else cleans <stateRoot>/tmp. A directory still in use can be held open,
// so a failed removal is left for the next sweep.
function sweepOldTmpDirs(root, prefix) {
  const cutoff = Date.now() - TMP_RETENTION_MS;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
    const dir = path.join(root, entry.name);
    try {
      if (fs.lstatSync(dir).mtimeMs < cutoff) fs.rmSync(dir, { recursive: true, force: true });
    } catch { /* Retried by the next sweep. */ }
  }
}

// A fresh private directory. Windows' temp directory is shared with what the user
// runs, so there it lives under <stateRoot>/tmp.
function privateTmpDir(prefix) {
  if (!WIN32) return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const root = path.join(stateRoot(), "tmp");
  ensurePrivateDirSync(root);
  sweepOldTmpDirs(root, prefix);
  const dir = fs.mkdtempSync(path.join(root, prefix));
  ensurePrivateDirSync(dir);
  return dir;
}

module.exports = {
  blockersFromSddl,
  currentUserSid,
  ensurePrivateDir,
  ensurePrivateDirSync,
  isPrivateFile,
  privateDirBlockers,
  privateTmpDir,
};
