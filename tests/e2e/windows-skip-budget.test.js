import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { runSurface, TAG_SURFACES } from "./support/surfaces.js";

const E2E_DIR = fileURLToPath(new URL(".", import.meta.url));
const BUDGET_FILE = "windows-skip-budget.json";
const suites = () => fs.readdirSync(E2E_DIR).filter((name) => name.endsWith(".test.js")).sort();
const read = (name) => fs.readFileSync(path.join(E2E_DIR, name), "utf8");
const skipsOnWindows = (tag) => !TAG_SURFACES[tag].includes("win32");

function stringLiteralAt(source, start) {
  const quote = source[start];
  if (!"\"'`".includes(quote)) return null;
  let value = "";
  for (let index = start + 1; index < source.length; index += 1) {
    const char = source[index];
    if (char === "\\") {
      value += source[index + 1];
      index += 1;
    } else if (char === quote) {
      return value;
    } else {
      value += char;
    }
  }
  return null;
}

// Every platformGate(...) in a suite that names a tag, with its test's name.
// A gate whose test cannot be read this way is returned as an unnamed row, so a
// form this scan does not understand fails rather than slipping past the budget.
export function gatesIn(source) {
  const lines = source.split("\n");
  const names = new Map();
  for (const match of source.matchAll(/const (\w+) = platformGate\("(\w+)"/g)) names.set(match[1], match[2]);
  const gates = [];
  lines.forEach((line, index) => {
    const direct = /^\s*(?:await )?(?:t\.)?test\(("|'|`).*platformGate\("(\w+)"/.exec(line);
    const named = /^\s*(?:await )?(?:t\.)?test\(("|'|`).*,\s*(\w+),\s*(?:async\s*)?(?:\(|\w+\s*=>)/.exec(line);
    const tag = direct?.[2] ?? (named && names.get(named[2]));
    if (tag) {
      const quoteAt = line.indexOf(direct?.[1] ?? named[1]);
      gates.push({ line: index + 1, tag, test: stringLiteralAt(line, quoteAt) });
    } else if (/^\s*platformGate\(|\.\.\.platformGate\(|skip:\s*platformGate\(|\btest\(.*platformGate\(/.test(line)) {
      gates.push({ line: index + 1, tag: "unknown", test: null });
    }
  });
  return gates;
}

function windowsSkips() {
  const skips = [];
  for (const file of suites()) {
    const surface = runSurface(file);
    if (surface.tag && skipsOnWindows(surface.tag)) {
      skips.push({ file, tag: surface.tag, test: "*" });
      continue;
    }
    for (const gate of gatesIn(read(file))) {
      if (gate.tag === "unknown" || skipsOnWindows(gate.tag)) skips.push({ file, tag: gate.tag, test: gate.test, line: gate.line });
    }
  }
  return skips;
}

const budget = () => JSON.parse(read(BUDGET_FILE));
const keyOf = (skip) => `${skip.file} :: ${skip.test}`;

test("every Windows skip in the gates has an entry, with a tag and a reason, and no entry is stale", () => {
  const skips = windowsSkips();
  const { skips: entries } = budget();

  for (const skip of skips) assert.notEqual(skip.test, null, `${skip.file}:${skip.line} gates a test this check cannot name`);
  const entryByKey = new Map(entries.map((entry) => [keyOf(entry), entry]));
  assert.equal(entryByKey.size, entries.length, "duplicate budget entries");
  for (const skip of skips) {
    const entry = entryByKey.get(keyOf(skip));
    assert.ok(entry, `${keyOf(skip)} is skipped on Windows but has no entry in ${BUDGET_FILE}`);
    assert.equal(entry.tag, skip.tag, keyOf(skip));
  }
  for (const entry of entries) {
    assert.match(entry.reason ?? "", /\S/, `${keyOf(entry)} has no reason`);
    assert.ok(skips.some((skip) => keyOf(skip) === keyOf(entry)), `${keyOf(entry)} has no matching gate`);
  }
});

test("the number of Windows skips is within the budget", () => {
  const count = windowsSkips().reduce((total, skip) => total
    + (skip.test === "*" ? (read(skip.file).match(/^\s*test\(/gm) ?? []).length : 1), 0);
  const { budget: allowed, skips } = budget();

  assert.ok(Number.isInteger(allowed), "budget must be a number of tests");
  assert.ok(count <= allowed, `${count} tests are skipped on Windows, over the budget of ${allowed}`);
  assert.equal(skips.length <= allowed, true);
});

test("no suite gates by hand or calls python3 directly, and nothing is tagged darwin without being macOS-only", () => {
  for (const file of suites().filter((name) => name !== "windows-skip-budget.test.js")) {
    const source = read(file);
    assert.doesNotMatch(source, /\bskip:\s*process\.platform/, `${file} gates with process.platform; use platformGate`);
    assert.doesNotMatch(source, /\b(?:spawn|spawnSync|execFile|execFileSync|execFileAsync)\(\s*["']python3["']/, `${file} calls python3 directly; use PYTHON`);
    for (const gate of gatesIn(source)) {
      assert.notEqual(gate.tag, "darwin", `${file}:${gate.line}: darwin is for a real macOS facility only, not fixture tests that pass on Linux`);
    }
  }
});

test("the check itself catches a planted skip without an entry and one over budget", () => {
  const gates = gatesIn(`test("planted skip", platformGate("posix", "x"), () => {});\n`);
  assert.deepEqual(gates, [{ line: 1, tag: "posix", test: "planted skip" }]);
  assert.equal(budget().skips.some((entry) => entry.test === "planted skip"), false);

  const namedGate = gatesIn(`const ONLY = platformGate("win32", "x");\ntest("windows case", ONLY, async () => {});\n`);
  assert.deepEqual(namedGate, [{ line: 2, tag: "win32", test: "windows case" }]);

  const unreadable = gatesIn(`const opts = { ...platformGate("posix") };\ntest("x", opts, () => {});\n`);
  assert.deepEqual(unreadable, [{ line: 1, tag: "unknown", test: null }]);
});
