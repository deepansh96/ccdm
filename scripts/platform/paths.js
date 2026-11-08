"use strict";

// Home and state-root paths. ccdmlib/platform/paths.py gives the same answers;
// tests/e2e/platform-contract.test.js fails when the two disagree.
const os = require("node:os");
const path = require("node:path");

const WIN32 = process.platform === "win32";
// Characters NTFS refuses in a name. A ":" would write an alternate data stream.
const WIN32_FORBIDDEN = /[<>:"/\\|?*\x00-\x1f\x7f]/g;
// Matched without the u flag, so only ASCII letters fold: a dotless i is no "I".
const WIN32_DEVICE = /^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])$/i;
const POSIX_NAME_MAX_BYTES = 255;

// `CCDM_STATE_ROOT`, or `~/.local/state/ccdm` on every OS.
function stateRoot() {
  const override = process.env.CCDM_STATE_ROOT;
  return override ? path.resolve(override) : path.join(os.homedir(), ".local", "state", "ccdm");
}

// Expands a leading `~` or `~/`, and `~\` on win32. `~user` stays as it is.
function expandHome(value) {
  if (typeof value !== "string") return value;
  if (value === "~") return os.homedir();
  if (value.startsWith("~/") || (WIN32 && value.startsWith("~\\"))) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

// Compares resolved paths, ignoring case on win32. Symlinks are not followed.
function samePath(a, b) {
  const left = path.resolve(a);
  const right = path.resolve(b);
  return WIN32 ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function trimEnd(value, chars) {
  let end = value.length;
  while (end > 0 && chars.includes(value[end - 1])) end -= 1;
  return value.slice(0, end);
}

// Cuts `name` to `limit`, as measured by `size`, between code points. The
// extension stays when it leaves room for at least part of the stem.
function cutKeepingExtension(name, limit, size) {
  if (size(name) <= limit) return name;
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 && size(name.slice(dot)) < limit ? name.slice(dot) : "";
  const stem = extension ? name.slice(0, dot) : name;
  let room = limit - size(extension);
  let kept = "";
  for (const char of stem) {
    room -= size(char);
    if (room < 0) break;
    kept += char;
  }
  return kept + extension;
}

const codePoints = value => Array.from(value).length;
const utf8Bytes = value => Buffer.byteLength(value, "utf8");

function safeWin32Name(name, max) {
  let safe = trimEnd(name.replace(WIN32_FORBIDDEN, ""), ". ");
  safe = trimEnd(cutKeepingExtension(safe, max, codePoints), ". ");
  // Windows reads a device name up to the first dot, ignoring spaces before it.
  // This runs after the cut, which can leave a device name as the stem.
  const firstDot = safe.indexOf(".");
  const rest = firstDot < 0 ? "" : safe.slice(firstDot);
  if (WIN32_DEVICE.test(trimEnd(firstDot < 0 ? safe : safe.slice(0, firstDot), " "))) {
    safe = cutKeepingExtension(`file${rest}`, max, codePoints);
  }
  return safe || "file";
}

function safePosixName(name) {
  const base = path.posix.basename(name).replace(/\0/g, "");
  if (base === "" || base === "." || base === "..") return "file";
  return cutKeepingExtension(base, POSIX_NAME_MAX_BYTES, utf8Bytes);
}

// One path component that can be written as a regular file. win32 removes what
// NTFS refuses or reads as something else and caps the name at `max` code
// points. POSIX changes only a name that could not be written; `max` does not
// apply there, the limit is 255 UTF-8 bytes.
function safeFileName(name, { max = 120 } = {}) {
  const value = typeof name === "string" ? name : "";
  return WIN32 ? safeWin32Name(value, max) : safePosixName(value);
}

module.exports = { expandHome, safeFileName, samePath, stateRoot };
