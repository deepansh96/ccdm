"use strict";

// Append-only JSON Lines ledger for Agent Messages in the Router's private
// state directory. Every state change is appended and synced before taking
// effect; a write failure surfaces as `ledger_unavailable`.
const { chmod, open } = require("node:fs/promises");
const path = require("node:path");
const { ensurePrivateDir, makeFilePrivate } = require("../../platform/privacy.js");
const { OpError } = require("../ops/errors.js");

const LEDGER_VERSION = 1;
const LEDGER_FILENAME = "agent-messages.jsonl";

function ledgerPath(stateDir) {
  return path.join(stateDir, LEDGER_FILENAME);
}

function createAgentMessageLedger({ stateDir }) {
  const file = ledgerPath(stateDir);
  let queue = Promise.resolve();
  let dirReady = false;
  let filePrivate = false;

  async function writeLine(record) {
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
      throw new OpError("ledger_unavailable", `agent message ledger unavailable: ${error.message}`);
    }
  }

  return {
    path: file,
    // Serialized append: a failed write rejects only its caller and leaves the
    // queue usable for later attempts.
    append(fields) {
      const record = { v: LEDGER_VERSION, at: new Date().toISOString(), ...fields };
      const run = queue.then(() => writeLine(record), () => writeLine(record));
      queue = run.catch(() => {});
      return run.then(() => record);
    },
  };
}

module.exports = { LEDGER_FILENAME, LEDGER_VERSION, createAgentMessageLedger, ledgerPath };
