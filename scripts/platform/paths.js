"use strict";

// Home and state-root paths. ccdmlib/platform/paths.py gives the same answers;
// tests/e2e/platform-contract.test.js fails when the two disagree.
const os = require("node:os");
const path = require("node:path");

const WIN32 = process.platform === "win32";

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

module.exports = { expandHome, samePath, stateRoot };
