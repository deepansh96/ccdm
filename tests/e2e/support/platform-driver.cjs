"use strict";

// Calls one scripts/platform function for tests/e2e/platform-contract.test.js.
// Reads {"fn":"<module>.<function>","args":[...]} on stdin and prints one JSON
// outcome: {"ok":true,"value":...,"ms":n} or {"ok":false,"error":{...},"ms":n}.
const path = require("node:path");

const PLATFORM_DIR = path.resolve(__dirname, "../../../scripts/platform");

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  const { fn, args = [] } = JSON.parse(await readStdin());
  const [moduleName, functionName] = fn.split(".");
  const target = require(path.join(PLATFORM_DIR, `${moduleName}.js`))[functionName];
  if (typeof target !== "function") throw new Error(`no such function: ${fn}`);
  const started = performance.now();
  let outcome;
  try {
    const value = await target(...args);
    outcome = { ok: true, value: value === undefined ? null : value };
  } catch (error) {
    outcome = { ok: false, error: { code: error.code ?? null, name: error.name, message: error.message } };
  }
  outcome.ms = performance.now() - started;
  process.stdout.write(`${JSON.stringify(outcome)}\n`);
}

main().catch(error => {
  process.stderr.write(`${error.stack}\n`);
  process.exitCode = 2;
});
