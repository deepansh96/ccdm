import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { runSurface, TAG_SURFACES } from "./support/surfaces.js";

const E2E_DIR = fileURLToPath(new URL(".", import.meta.url));
const BUDGET_FILE = "windows-skip-budget.json";
// Not this file: its own checks plant gates as sample text.
const suites = () => fs.readdirSync(E2E_DIR)
  .filter((name) => name.endsWith(".test.js") && name !== "windows-skip-budget.test.js")
  .sort();
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

// The platform contract's own cases say which OS family they run on. A case is
// named as its run prints it: "<cases file without .cases.js>: <case name>".
const CONTRACT_SUITE = "platform-contract.test.js";
const CONTRACT_DIR = "platform-contract";
async function contractCases() {
  const dir = path.join(E2E_DIR, CONTRACT_DIR);
  const found = [];
  for (const name of fs.readdirSync(dir).filter((file) => file.endsWith(".cases.js")).sort()) {
    const { default: cases } = await import(pathToFileURL(path.join(dir, name)).href);
    for (const definition of cases) found.push({ file: `${CONTRACT_DIR}/${name}`, name: definition.name, only: definition.only });
  }
  return found;
}
const contractTestName = (definition) => `${path.basename(definition.file, ".cases.js")}: ${definition.name}`;

async function windowsSkips() {
  const skips = [];
  for (const definition of await contractCases()) {
    if (definition.only === "posix") skips.push({ file: CONTRACT_SUITE, tag: "posix", test: contractTestName(definition) });
  }
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

test("every Windows skip in the gates has an entry, with a tag and a reason, and no entry is stale", async () => {
  const skips = await windowsSkips();
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

// A whole suite counts every test in it; any other entry is one test.
const testsSkippedBy = (skip) => (skip.test === "*" ? (read(skip.file).match(/^\s*test\(/gm) ?? []).length : 1);

test("the budget is exactly the number of tests skipped on Windows", async () => {
  const count = (await windowsSkips()).reduce((total, skip) => total + testsSkippedBy(skip), 0);
  const { budget: allowed, skips } = budget();

  assert.ok(Number.isInteger(allowed), "budget must be a number of tests");
  assert.equal(allowed, count, `${count} tests are skipped on Windows and the budget is ${allowed}: `
    + (count > allowed ? "make the new skip run rather than raise the budget" : "lower the budget by the skips removed"));
  assert.equal(skips.length <= allowed, true);
});

// Why a test is skipped on Windows. The list is closed: a skip that fits none of
// these names has to run on Windows instead.
//   darwin-only           a real macOS facility (launchd, Keychain, a zsh
//                         installer whose Windows counterpart has its own suite)
//   posix-signals         POSIX signals
//   tmux-backend          the tmux backend
//   posix-pair            the POSIX half of a pair; `windows_test` names the test
//                         (or tests) covering the same behaviour on Windows
//   windows-refused-d2    root Codex, refused on Windows on purpose for now; these
//                         entries go when root Codex runs on Windows
//   posix-only-behaviour  behaviour Windows does not have, such as file mode bits
// `gap` is a test that should run on Windows and does not yet. Only the entries
// named in KNOWN_GAPS ("<file> :: <test>") may carry it, so a new gap cannot be
// added in the budget alone. There is none today.
const CLOSED_CATEGORIES = ["darwin-only", "posix-signals", "tmux-backend", "posix-pair", "windows-refused-d2", "posix-only-behaviour"];
const KNOWN_GAPS = [];

// The name of every test a suite declares, as its source writes it: a name built
// from a template keeps its ${...}.
export function testNamesIn(source) {
  const names = [];
  for (const line of source.split("\n")) {
    const declared = /^\s*(?:await )?(?:t\.)?test\(("|'|`)/.exec(line);
    if (declared) names.push(stringLiteralAt(line, line.indexOf(declared[1])));
  }
  return names;
}

// Whether `ref` ({ file, test }) names a test that exists and runs on Windows.
// `sources` maps a suite's file name to its text; `cases` is contractCases().
export function runsOnWindows(ref, sources, cases) {
  if (typeof ref?.file !== "string" || typeof ref?.test !== "string") return false;
  if (ref.file.startsWith(`${CONTRACT_DIR}/`)) {
    return cases.some((definition) => definition.file === ref.file && definition.name === ref.test && definition.only !== "posix");
  }
  const source = sources.get(ref.file);
  if (source === undefined || !testNamesIn(source).includes(ref.test)) return false;
  const surface = runSurface(ref.file);
  if (surface.tag && skipsOnWindows(surface.tag)) return false;
  return !gatesIn(source).some((gate) => gate.test === ref.test && (gate.tag === "unknown" || skipsOnWindows(gate.tag)));
}

// What is wrong with an entry's category, or null when nothing is.
export function categoryProblem(entry, sources, cases, knownGaps = KNOWN_GAPS) {
  const { category } = entry;
  if (typeof category !== "string" || category === "") return "has no category";
  if (category === "gap") {
    return knownGaps.includes(keyOf(entry)) ? null : "is a gap that KNOWN_GAPS in windows-skip-budget.test.js does not name";
  }
  if (!CLOSED_CATEGORIES.includes(category)) return `has the category "${category}", which is not on the list`;
  if (entry.tag === "darwin" && category !== "darwin-only") return "is tagged darwin, so its category must be darwin-only";
  if (category !== "posix-pair") return entry.windows_test === undefined ? null : "names a windows_test without being a posix-pair";
  const named = [].concat(entry.windows_test ?? []);
  if (named.length === 0) return "is a posix-pair without a windows_test";
  const missing = named.find((ref) => !runsOnWindows(ref, sources, cases));
  return missing ? `names a windows_test that does not exist or is itself skipped on Windows: ${JSON.stringify(missing)}` : null;
}

test("every entry has a category from the list, every posix-pair names a test that runs on Windows, and only the known gaps are gaps", async () => {
  const sources = new Map(suites().map((file) => [file, read(file)]));
  const cases = await contractCases();
  const { skips: entries } = budget();

  for (const entry of entries) {
    const problem = categoryProblem(entry, sources, cases);
    assert.equal(problem, null, `${keyOf(entry)} ${problem}`);
  }
  const gaps = entries.filter((entry) => entry.category === "gap").map(keyOf);
  assert.deepEqual(gaps.sort(), [...KNOWN_GAPS].sort(), "KNOWN_GAPS names an entry that is gone or no longer a gap");
});

test("the category check catches a planted entry with another category or none, a pair without a Windows test, and an unnamed gap", () => {
  const sources = new Map([
    ["planted.test.js", [
      `test("runs everywhere", () => {});`,
      `test("the posix half", platformGate("posix", "x"), () => {});`,
      `const ONLY = platformGate("win32", "x");`,
      "for (const language of LANGUAGES) {",
      "  test(`${language} windows half`, ONLY, async () => {});",
      "}",
    ].join("\n")],
    // Gated as a whole in surfaces.js, so nothing in it runs on Windows.
    ["router-installer.test.js", `test("inside a suite Windows skips", () => {});\n`],
  ]);
  const cases = [
    { file: "platform-contract/planted.cases.js", name: "a windows case", only: "win32" },
    { file: "platform-contract/planted.cases.js", name: "a shared case", only: undefined },
    { file: "platform-contract/planted.cases.js", name: "a posix case", only: "posix" },
  ];
  const problem = (changes) => categoryProblem({
    file: "planted.test.js", test: "the posix half", tag: "posix", category: "posix-pair",
    windows_test: { file: "planted.test.js", test: "${language} windows half" }, reason: "x", ...changes,
  }, sources, cases);
  const windowsTest = (file, name) => problem({ windows_test: { file, test: name } });

  assert.equal(problem({}), null);
  assert.equal(windowsTest("planted.test.js", "runs everywhere"), null);
  assert.equal(windowsTest("platform-contract/planted.cases.js", "a windows case"), null);
  assert.equal(windowsTest("platform-contract/planted.cases.js", "a shared case"), null);
  assert.equal(problem({ windows_test: [{ file: "planted.test.js", test: "runs everywhere" }, { file: "planted.test.js", test: "${language} windows half" }] }), null);
  for (const category of CLOSED_CATEGORIES.filter((name) => name !== "posix-pair")) assert.equal(problem({ category, windows_test: undefined }), null, category);

  assert.match(problem({ category: undefined }), /has no category/);
  assert.match(problem({ category: "" }), /has no category/);
  assert.match(problem({ category: "flaky" }), /"flaky", which is not on the list/);
  assert.match(problem({ category: "posix" }), /not on the list/);
  assert.match(problem({ category: "darwin-only" }), /windows_test without being a posix-pair/);
  assert.match(problem({ tag: "darwin", category: "tmux-backend", windows_test: undefined }), /must be darwin-only/);

  assert.match(problem({ windows_test: undefined }), /posix-pair without a windows_test/);
  assert.match(problem({ windows_test: [] }), /posix-pair without a windows_test/);
  assert.match(problem({ windows_test: "runs everywhere" }), /does not exist/);
  assert.match(windowsTest("planted.test.js", "no such test"), /does not exist/);
  assert.match(windowsTest("missing.test.js", "runs everywhere"), /does not exist/);
  assert.match(windowsTest("planted.test.js", "the posix half"), /itself skipped on Windows/);
  assert.match(windowsTest("router-installer.test.js", "inside a suite Windows skips"), /itself skipped on Windows/);
  assert.match(windowsTest("platform-contract/planted.cases.js", "a posix case"), /itself skipped on Windows/);
  assert.match(windowsTest("platform-contract/planted.cases.js", "no such case"), /does not exist/);
  assert.match(problem({ windows_test: [{ file: "planted.test.js", test: "runs everywhere" }, { file: "planted.test.js", test: "no such test" }] }), /no such test/);

  const gap = { file: "planted.test.js", test: "the posix half", tag: "posix", category: "gap", reason: "x" };
  assert.match(categoryProblem(gap, sources, cases), /KNOWN_GAPS/);
  assert.match(categoryProblem(gap, sources, cases, ["planted.test.js :: another test"]), /KNOWN_GAPS/);
  assert.equal(categoryProblem(gap, sources, cases, ["planted.test.js :: the posix half"]), null);
});

test("no suite gates by hand or calls python3 directly, and nothing is tagged darwin without being macOS-only", () => {
  for (const file of suites()) {
    const source = read(file);
    assert.doesNotMatch(source, /\bskip:\s*process\.platform/, `${file} gates with process.platform; use platformGate`);
    assert.doesNotMatch(source, /\b(?:spawn|spawnSync|execFile|execFileSync|execFileAsync)\(\s*["']python3["']/, `${file} calls python3 directly; use PYTHON`);
    for (const gate of gatesIn(source)) {
      assert.notEqual(gate.tag, "darwin", `${file}:${gate.line}: darwin is for a real macOS facility only, not fixture tests that pass on Linux`);
    }
  }
});

test("every suite gated as a whole takes its test from suiteTest", () => {
  for (const name of Object.keys(runSurface())) {
    assert.match(read(name), /const test = suiteTest\(nodeTest, import\.meta\.url\);/, name);
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
