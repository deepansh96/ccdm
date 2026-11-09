"use strict";

// ccdm-host protocol v1: NDJSON over the private pipe, one response per request,
// echoing its `id`. See docs/adr/0007-windows-session-host.md.
const PROTOCOL_VERSION = 1;

const ERRORS = Object.freeze({
  DUPLICATE_SESSION: "duplicate_session",
  NOT_AUTHENTICATED: "not_authenticated",
  PROTOCOL_MISMATCH: "protocol_mismatch",
  SPAWN_FAILED: "spawn_failed",
  UNKNOWN_SESSION: "unknown_session",
  UNSUPPORTED_OP: "unsupported_op",
});

const MISMATCH_MESSAGE = "restart ccdm-host to finish the upgrade";
const NOT_RUNNING_MESSAGE = "ccdm-host is not running; start it with `node scripts/ccdm-host.js serve`";
// Before authentication a frame is small; afterwards a `new` can carry an environment.
const MAX_HELLO_FRAME = 64 * 1024;
const MAX_FRAME = 8 * 1024 * 1024;

const KINDS = new Set(["project", "thread", "root", "adhoc"]);

const okResponse = (id, result = {}) => ({ id: id ?? null, ok: true, ...result });
const errorResponse = (id, error, message) => ({ id: id ?? null, ok: false, error, message });
const encode = frame => `${JSON.stringify(frame)}\n`;

// A frame is a JSON object; anything else is null.
function parseFrame(line) {
  try {
    const frame = JSON.parse(line);
    return frame && typeof frame === "object" && !Array.isArray(frame) ? frame : null;
  } catch {
    return null;
  }
}

class HostError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

module.exports = {
  ERRORS,
  HostError,
  KINDS,
  MAX_FRAME,
  MAX_HELLO_FRAME,
  MISMATCH_MESSAGE,
  NOT_RUNNING_MESSAGE,
  PROTOCOL_VERSION,
  encode,
  errorResponse,
  okResponse,
  parseFrame,
};
