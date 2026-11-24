"use strict";

// Append-only JSON Lines ledger for Agent Messages in the Router's private
// state directory. Every state change is appended and synced before taking
// effect; a write failure surfaces as `ledger_unavailable`.
const { chmod, open, readFile } = require("node:fs/promises");
const path = require("node:path");
const { writeFileAtomic } = require("../../platform/atomic.js");
const { ensurePrivateDir, makeFilePrivate } = require("../../platform/privacy.js");
const { OpError } = require("../ops/errors.js");

const LEDGER_VERSION = 1;
const LEDGER_FILENAME = "agent-messages.jsonl";
const VALID_OPS = new Set(["agent_request", "agent_reply"]);
const VALID_POST_KINDS = new Set(["request", "reply"]);
const VALID_POST_SIDES = new Set(["sender", "receiver"]);
const VALID_DELIVERY_KINDS = new Set(["request", "reply", "notice"]);

const isNonEmptyString = value => typeof value === "string" && value.trim().length > 0;
const isPlainObject = value => Boolean(value && typeof value === "object" && !Array.isArray(value));
const isValidIso = value => typeof value === "string" && Number.isFinite(Date.parse(value));

function isValidConversation(value) {
  return isPlainObject(value)
    && isNonEmptyString(value.project)
    && isNonEmptyString(value.provider)
    && isNonEmptyString(value.conversation_id);
}

function validateRecord(record) {
  if (!isPlainObject(record)) return "record must be a JSON object";
  if (record.v !== LEDGER_VERSION) return `unsupported ledger version: ${record.v}`;
  if (!isValidIso(record.at)) return "missing or invalid timestamp";
  if (typeof record.type !== "string") return "missing record type";

  switch (record.type) {
    case "request":
      if (!isNonEmptyString(record.request_id)) return "request missing request_id";
      if (!isValidConversation(record.from) || !isValidConversation(record.to)) return "request missing conversation";
      if (!isNonEmptyString(record.from_launch) || !isNonEmptyString(record.to_launch)) return "request missing launch";
      if (typeof record.text !== "string") return "request missing text";
      if (!Number.isInteger(record.depth) || record.depth < 1) return "request invalid depth";
      if (!isValidIso(record.expires_at)) return "request invalid expires_at";
      if (!isNonEmptyString(record.idempotency_key)) return "request missing idempotency_key";
      return null;
    case "refusal":
      if (!isNonEmptyString(record.refusal_id)) return "refusal missing refusal_id";
      if (!VALID_OPS.has(record.op)) return "refusal invalid op";
      if (!isValidConversation(record.from)) return "refusal missing from";
      if (!isNonEmptyString(record.code) || typeof record.message !== "string") return "refusal missing code or message";
      if (!isNonEmptyString(record.from_launch) || !isNonEmptyString(record.idempotency_key)) return "refusal missing key";
      return null;
    case "post":
      if (!isNonEmptyString(record.request_id)) return "post missing request_id";
      if (!VALID_POST_KINDS.has(record.kind) || !VALID_POST_SIDES.has(record.side)) return "post invalid kind or side";
      if (!isNonEmptyString(record.channel_id)) return "post missing channel_id";
      return null;
    case "delivery":
      if (!isNonEmptyString(record.delivery_id)) return "delivery missing delivery_id";
      if (!VALID_DELIVERY_KINDS.has(record.kind)) return "delivery invalid kind";
      if (!isNonEmptyString(record.request_id)) return "delivery missing request_id";
      if (!isValidConversation(record.to) || !isNonEmptyString(record.to_launch)) return "delivery missing target";
      return null;
    case "ack":
      if (!isNonEmptyString(record.delivery_id) || !isNonEmptyString(record.request_id)) return "ack missing id";
      return null;
    case "reply":
      if (!isNonEmptyString(record.request_id)) return "reply missing request_id";
      if (!isValidConversation(record.from) || !isValidConversation(record.to)) return "reply missing conversation";
      if (!isNonEmptyString(record.from_launch) || typeof record.text !== "string") return "reply missing body";
      if (!isNonEmptyString(record.idempotency_key)) return "reply missing idempotency_key";
      if (typeof record.delivered_to_live_session !== "boolean") return "reply missing delivered_to_live_session";
      return null;
    case "expired":
    case "failed":
      if (!isNonEmptyString(record.request_id)) return `${record.type} missing request_id`;
      return null;
    default:
      return `unknown record type: ${record.type}`;
  }
}

function ledgerPath(stateDir) {
  return path.join(stateDir, LEDGER_FILENAME);
}

function createAgentMessageLedger({ stateDir }) {
  const file = ledgerPath(stateDir);
  let queue = Promise.resolve();
  let dirReady = false;
  let filePrivate = false;
  let unavailableError = null;

  function unavailableOpError(detail = unavailableError) {
    return new OpError("ledger_unavailable", `agent message ledger unavailable: ${detail}`);
  }

  async function writeLine(record) {
    if (unavailableError !== null) throw unavailableOpError();
    try {
      if (!dirReady) {
        await ensurePrivateDir(stateDir);
        dirReady = true;
      }
      const handle = await open(file, "a", 0o600);
      try {
        if (!filePrivate) {
          if (process.platform === "win32") await makeFilePrivate(file);
          else await chmod(file, 0o600);
          filePrivate = true;
        }
        await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch (error) {
      filePrivate = false;
      throw unavailableOpError(error.message);
    }
  }

  async function read() {
    let raw;
    try {
      raw = await readFile(file, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") {
        return { ok: true, exists: false, records: [], tornFinalLine: false };
      }
      unavailableError = error.message;
      return { ok: false, exists: true, records: [], tornFinalLine: false, error: unavailableError };
    }

    if (raw.length === 0) {
      return { ok: true, exists: true, records: [], tornFinalLine: false };
    }

    const hasTrailingNewline = raw.endsWith("\n");
    const lines = raw.split("\n");
    if (hasTrailingNewline) lines.pop();

    const records = [];
    let tornFinalLine = false;
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i].endsWith("\r") ? lines[i].slice(0, -1) : lines[i];
      const isUnterminatedFinal = !hasTrailingNewline && i === lines.length - 1;
      if (line.length === 0) {
        unavailableError = `invalid empty ledger line ${i + 1}`;
        return { ok: false, exists: true, records: [], tornFinalLine: false, error: unavailableError };
      }
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch (error) {
        if (isUnterminatedFinal && (line === "{" || line.startsWith('{"'))) {
          tornFinalLine = true;
          break;
        }
        unavailableError = `corrupt ledger line ${i + 1}: ${error.message}`;
        return { ok: false, exists: true, records: [], tornFinalLine: false, error: unavailableError };
      }
      const problem = validateRecord(parsed);
      if (problem) {
        unavailableError = `invalid ledger line ${i + 1}: ${problem}`;
        return { ok: false, exists: true, records: [], tornFinalLine: false, error: unavailableError };
      }
      records.push(parsed);
    }

    return { ok: true, exists: true, records, tornFinalLine };
  }

  async function compact(records) {
    if (unavailableError !== null) return { ok: false, error: unavailableError };
    try {
      await ensurePrivateDir(stateDir);
      dirReady = true;
      const content = records.length > 0 ? `${records.map(record => JSON.stringify(record)).join("\n")}\n` : "";
      await writeFileAtomic(file, content, { mode: 0o600 });
      if (process.platform === "win32") await makeFilePrivate(file);
      filePrivate = true;
      return { ok: true };
    } catch (error) {
      filePrivate = false;
      unavailableError = error.message;
      return { ok: false, error: unavailableError };
    }
  }

  return {
    path: file,
    read,
    compact,
    error() {
      return unavailableError;
    },
    health() {
      return { ok: unavailableError === null, error: unavailableError };
    },
    // Serialized append: a failed write rejects only its caller and leaves the
    // queue usable for later attempts.
    append(fields) {
      if (unavailableError !== null) return Promise.reject(unavailableOpError());
      const record = { v: LEDGER_VERSION, at: new Date().toISOString(), ...fields };
      const run = queue.then(() => writeLine(record), () => writeLine(record));
      queue = run.catch(() => {});
      return run.then(() => record);
    },
  };
}

module.exports = { LEDGER_FILENAME, LEDGER_VERSION, createAgentMessageLedger, ledgerPath };
