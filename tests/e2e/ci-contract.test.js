import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { PYTHON } from "./support/platform.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const WORKFLOW = fs.readFileSync(path.join(ROOT, ".github", "workflows", "e2e.yml"), "utf8");
const FLOOR = path.join(ROOT, "tests", "e2e", "support", "python_floor.py");

// The `jobs:` blocks of a workflow by job id, line-based so the contract needs
// no YAML dependency. Comment lines are dropped: a comment never satisfies a rule.
function workflowJobs(text) {
  const jobs = new Map();
  let inJobs = false;
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*#/.test(line)) continue;
    if (/^jobs:\s*$/.test(line)) {
      inJobs = true;
      continue;
    }
    if (!inJobs) continue;
    if (/^\S/.test(line)) break;
    const header = line.match(/^ {2}([\w-]+):\s*$/);
    if (header) {
      current = header[1];
      jobs.set(current, []);
    } else if (current) {
      jobs.get(current).push(line);
    }
  }
  return new Map([...jobs].map(([id, lines]) => [id, lines.join("\n")]));
}

const has = pattern => job => pattern.test(job);
const lacks = pattern => job => !pattern.test(job);
const ALL = "*";
const LINUX = "local-fake-e2e";
const WINDOWS = "windows-e2e";
const REQUIRED = "windows-required";
const MACOS = "macos-e2e";
const CONTINUES = /^\s*continue-on-error:/m;
const NPM_TEST = /^\s*(- )?run: npm test\s*$/m;
const NODE_22 = /node-version: 22\s*$/m;
const OMIT_OPTIONAL = /^\s*- run: npm ci --omit=optional\s*$/m;
const REPORT_DIR = /CCDM_E2E_REPORT_DIR: \$\{\{ runner\.temp \}\}\/e2e-report/;

// The native packages are checked for, and after the install that could add them.
function assertsKoffiAbsent(job) {
  const install = job.search(/npm ci/);
  const check = job.search(/for package in node_modules\/koffi\b/);
  return install >= 0 && check > install && /\[ -e "\$package" \]/.test(job) && /exit 1/.test(job.slice(check));
}

const RULES = [
  { job: ALL, name: "runs on push", ok: has(/^ {2}push:/m) },
  { job: ALL, name: "runs on pull_request", ok: has(/^ {2}pull_request:/m) },
  { job: ALL, name: "launchctl and security never appear as real tools", ok: lacks(/\b(launchctl|security)\b/) },

  { job: LINUX, name: "linux runs on ubuntu", ok: has(/runs-on: ubuntu-latest/) },
  { job: LINUX, name: "linux uses Node 22", ok: has(NODE_22) },
  { job: LINUX, name: "linux omits optional packages", ok: has(OMIT_OPTIONAL) },
  { job: LINUX, name: "linux asserts koffi is absent", ok: assertsKoffiAbsent },
  { job: LINUX, name: "linux verifies host tools", ok: has(/apt-get install -y zsh python3 jq/) },
  { job: LINUX, name: "linux runs the suite", ok: has(NPM_TEST) },
  { job: LINUX, name: "linux can fail the PR", ok: lacks(CONTINUES) },

  { job: WINDOWS, name: "windows runs on windows", ok: has(/runs-on: windows-latest/) },
  { job: WINDOWS, name: "windows covers Node 22 and 24", ok: has(/^\s*node: \[22, 24\]\s*$/m) },
  { job: WINDOWS, name: "windows uses Python 3.11", ok: has(/python-version: '3\.11'/) },
  { job: WINDOWS, name: "windows is informational", ok: has(/^ {4}continue-on-error: true\s*$/m) },
  { job: WINDOWS, name: "windows runs the full suite", ok: has(NPM_TEST) },
  { job: WINDOWS, name: "windows writes the per-file report", ok: has(REPORT_DIR) },
  { job: WINDOWS, name: "windows uploads the report", ok: has(/uses: actions\/upload-artifact@/) },

  { job: REQUIRED, name: "required list runs on windows", ok: has(/runs-on: windows-latest/) },
  { job: REQUIRED, name: "required list can fail the PR", ok: lacks(CONTINUES) },
  { job: REQUIRED, name: "required list reads windows-required.txt", ok: has(/< tests\/e2e\/windows-required\.txt/) },
  { job: REQUIRED, name: "required list runs only the listed files", ok: job => /node tests\/run-e2e\.mjs "\$\{files\[@\]\}"/.test(job) && !NPM_TEST.test(job) },
  { job: REQUIRED, name: "required list refuses an empty list", ok: has(/lists no files[\s\S]*exit 1/) },

  { job: MACOS, name: "macos runs on macos", ok: has(/runs-on: macos-latest/) },
  { job: MACOS, name: "macos uses Node 22", ok: has(NODE_22) },
  { job: MACOS, name: "macos can fail the PR", ok: lacks(CONTINUES) },
  { job: MACOS, name: "macos omits optional packages", ok: has(OMIT_OPTIONAL) },
  { job: MACOS, name: "macos asserts koffi is absent", ok: assertsKoffiAbsent },
  { job: MACOS, name: "macos exports /usr/bin/python3 as CCDM_PYTHON", ok: has(/^\s*CCDM_PYTHON: \/usr\/bin\/python3\s*$/m) },
  { job: MACOS, name: "macos puts /usr/bin first on PATH", ok: has(/echo \/usr\/bin >> "\$GITHUB_PATH"/) },
  { job: MACOS, name: "macos asserts Python 3.9", ok: has(/sys\.version_info\[:2\] == \(3, 9\)/) },
  { job: MACOS, name: "macos installs Pillow for the user", ok: has(/\/usr\/bin\/python3 -m pip install --user Pillow/) },
  { job: MACOS, name: "macos runs vermin with --eval-annotations", ok: has(/vermin" --target=3\.9- --eval-annotations --violations scripts\//) },
  { job: MACOS, name: "macos checks union annotations", ok: has(/\/usr\/bin\/python3 tests\/e2e\/support\/python_floor\.py annotations scripts/) },
  { job: MACOS, name: "macos imports every ccdmlib module", ok: has(/\/usr\/bin\/python3 tests\/e2e\/support\/python_floor\.py imports scripts/) },
  { job: MACOS, name: "macos loads thread-supervisor", ok: has(/\/usr\/bin\/python3 scripts\/thread-supervisor\.py --help/) },
  { job: MACOS, name: "macos loads conversation-reminder-service", ok: has(/\/usr\/bin\/python3 scripts\/conversation-reminder-service\.py --help/) },
  { job: MACOS, name: "macos loads usage-stats-poster", ok: has(/\/usr\/bin\/python3 scripts\/usage-stats-poster\.py --help/) },
  { job: MACOS, name: "macos loads resolve-codex-home", ok: has(/\/usr\/bin\/python3 -c "import runpy; runpy\.run_path\('scripts\/resolve-codex-home\.py'/) },
  { job: MACOS, name: "macos installs Homebrew tmux", ok: has(/brew install tmux/) },
  { job: MACOS, name: "macos runs the full suite", ok: has(NPM_TEST) },
];

function violations(text) {
  const jobs = workflowJobs(text);
  return RULES.filter(rule => !rule.ok(rule.job === ALL ? text : jobs.get(rule.job) ?? "")).map(rule => rule.name);
}

// Replaces `from` inside one job's block, or anywhere for ALL.
function mutated(job, from, to) {
  let start = 0;
  let end = WORKFLOW.length;
  if (job !== ALL) {
    start = WORKFLOW.indexOf(`\n  ${job}:\n`);
    assert.ok(start >= 0, `no job ${job}`);
    const next = WORKFLOW.slice(start + 1).search(/\n {2}[\w-]+:\n/);
    if (next >= 0) end = start + 1 + next;
  }
  const block = WORKFLOW.slice(start, end);
  assert.ok(block.includes(from), `${job} does not hold ${JSON.stringify(from)}`);
  return `${WORKFLOW.slice(0, start)}${block.replace(from, to)}${WORKFLOW.slice(end)}`;
}

const REAL_TOOL_STEP = "      - run: launchctl list\n      - run: npm test";
const SECURITY_STEP = "      - run: security find-generic-password\n      - run: npm test";

const BREAKS = {
  "runs on push": [ALL, "  push:\n", ""],
  "runs on pull_request": [ALL, "  pull_request:\n", ""],
  "launchctl and security never appear as real tools": [MACOS, "      - run: npm test", REAL_TOOL_STEP],

  "linux runs on ubuntu": [LINUX, "ubuntu-latest", "macos-latest"],
  "linux uses Node 22": [LINUX, "node-version: 22", "node-version: 20"],
  "linux omits optional packages": [LINUX, "npm ci --omit=optional", "npm ci"],
  "linux asserts koffi is absent": [LINUX, "for package in node_modules/koffi ", "for package in "],
  "linux verifies host tools": [LINUX, "apt-get install -y zsh python3 jq", "apt-get install -y python3"],
  "linux runs the suite": [LINUX, "- run: npm test", "- run: npm run lint"],
  "linux can fail the PR": [LINUX, "    runs-on: ubuntu-latest", "    runs-on: ubuntu-latest\n    continue-on-error: true"],

  "windows runs on windows": [WINDOWS, "windows-latest", "ubuntu-latest"],
  "windows covers Node 22 and 24": [WINDOWS, "node: [22, 24]", "node: [22]"],
  "windows uses Python 3.11": [WINDOWS, "python-version: '3.11'", "python-version: '3.13'"],
  "windows is informational": [WINDOWS, "continue-on-error: true", "continue-on-error: false"],
  "windows runs the full suite": [WINDOWS, "run: npm test", "run: node tests/run-e2e.mjs tests/e2e/ci-contract.test.js"],
  "windows writes the per-file report": [WINDOWS, "CCDM_E2E_REPORT_DIR", "CCDM_E2E_OTHER_DIR"],
  "windows uploads the report": [WINDOWS, "actions/upload-artifact@v4", "actions/cache@v4"],

  "required list runs on windows": [REQUIRED, "windows-latest", "ubuntu-latest"],
  "required list can fail the PR": [REQUIRED, "    timeout-minutes: 60", "    timeout-minutes: 60\n    continue-on-error: true"],
  "required list reads windows-required.txt": [REQUIRED, "tests/e2e/windows-required.txt", "tests/e2e/other.txt"],
  "required list runs only the listed files": [REQUIRED, 'node tests/run-e2e.mjs "${files[@]}"', "npm test"],
  "required list refuses an empty list": [REQUIRED, "lists no files", "is fine"],

  "macos runs on macos": [MACOS, "macos-latest", "ubuntu-latest"],
  "macos uses Node 22": [MACOS, "node-version: 22", "node-version: 24"],
  "macos can fail the PR": [MACOS, "    timeout-minutes: 90", "    timeout-minutes: 90\n    continue-on-error: true"],
  "macos omits optional packages": [MACOS, "npm ci --omit=optional", "npm ci"],
  "macos asserts koffi is absent": [MACOS, "for package in node_modules/koffi ", "for package in "],
  "macos exports /usr/bin/python3 as CCDM_PYTHON": [MACOS, "CCDM_PYTHON: /usr/bin/python3", "CCDM_PYTHON: /opt/homebrew/bin/python3"],
  "macos puts /usr/bin first on PATH": [MACOS, 'echo /usr/bin >> "$GITHUB_PATH"', "true"],
  "macos asserts Python 3.9": [MACOS, "== (3, 9)", "== (3, 11)"],
  "macos installs Pillow for the user": [MACOS, "pip install --user Pillow", "pip install Pillow"],
  "macos runs vermin with --eval-annotations": [MACOS, " --eval-annotations", ""],
  "macos checks union annotations": [MACOS, "python_floor.py annotations scripts", "python_floor.py --version"],
  "macos imports every ccdmlib module": [MACOS, "python_floor.py imports scripts", "python_floor.py --version"],
  "macos loads thread-supervisor": [MACOS, "scripts/thread-supervisor.py --help", "scripts/other.py --help"],
  "macos loads conversation-reminder-service": [MACOS, "scripts/conversation-reminder-service.py --help", "scripts/other.py --help"],
  "macos loads usage-stats-poster": [MACOS, "scripts/usage-stats-poster.py --help", "scripts/other.py --help"],
  "macos loads resolve-codex-home": [MACOS, "scripts/resolve-codex-home.py", "scripts/other.py"],
  "macos installs Homebrew tmux": [MACOS, "brew install tmux", "brew install jq"],
  "macos runs the full suite": [MACOS, "- run: npm test", "- run: npm run lint"],
};

test("the workflow has the four jobs, each in its required shape", () => {
  assert.deepEqual([...workflowJobs(WORKFLOW).keys()], [LINUX, WINDOWS, REQUIRED, MACOS]);
  assert.deepEqual(violations(WORKFLOW), []);
});

test("every shape rule fails when the workflow breaks it", () => {
  assert.deepEqual(Object.keys(BREAKS).sort(), RULES.map(rule => rule.name).sort());
  for (const [name, [job, from, to]] of Object.entries(BREAKS)) {
    assert.ok(violations(mutated(job, from, to)).includes(name), `breaking "${name}" went unnoticed`);
  }
});

test("each real-tool name, a removed job and a late koffi check are all caught", () => {
  assert.ok(violations(mutated(MACOS, "      - run: npm test", SECURITY_STEP))
    .includes("launchctl and security never appear as real tools"));

  const withoutMacos = WORKFLOW.slice(0, WORKFLOW.indexOf(`\n  ${MACOS}:\n`));
  assert.ok(violations(withoutMacos).includes("macos runs on macos"));

  const jobs = workflowJobs(WORKFLOW);
  const koffiFirst = 'for package in node_modules/koffi; do [ -e "$package" ] && exit 1; done\n- run: npm ci --omit=optional\n';
  assert.equal(assertsKoffiAbsent(koffiFirst), false);
  assert.equal(assertsKoffiAbsent(jobs.get(LINUX)), true);
});

test("the job reader keeps blocks apart and ignores comments", () => {
  const text = [
    "name: x", "jobs:", "  one:", "    # continue-on-error: true", "    runs-on: a",
    "  two:", "    runs-on: b", "other:", "  three:", "    runs-on: c",
  ].join("\n");
  assert.deepEqual([...workflowJobs(text)], [["one", "    runs-on: a"], ["two", "    runs-on: b"]]);
});

function requiredListProblems(text, exists) {
  const entries = text.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith("#"));
  const problems = entries.length ? [] : ["the list is empty"];
  for (const entry of entries) {
    if (!/^tests\/e2e\/[^/]+\.test\.js$/.test(entry)) problems.push(`${entry} is not a test file path`);
    else if (!exists(entry)) problems.push(`${entry} does not exist`);
  }
  for (const entry of new Set(entries)) {
    if (entries.indexOf(entry) !== entries.lastIndexOf(entry)) problems.push(`${entry} is listed twice`);
  }
  return problems;
}

test("windows-required.txt is non-empty and names existing test files once each", () => {
  const list = fs.readFileSync(path.join(ROOT, "tests", "e2e", "windows-required.txt"), "utf8");
  assert.deepEqual(requiredListProblems(list, entry => fs.existsSync(path.join(ROOT, entry))), []);

  const always = () => true;
  assert.deepEqual(requiredListProblems("# only a comment\n\n", always), ["the list is empty"]);
  assert.deepEqual(requiredListProblems("tests/e2e/a.test.js\n", () => false), ["tests/e2e/a.test.js does not exist"]);
  assert.deepEqual(requiredListProblems("scripts/a.py\n", always), ["scripts/a.py is not a test file path"]);
  assert.deepEqual(requiredListProblems("tests/e2e/a.test.js\ntests/e2e/a.test.js\n", always),
    ["tests/e2e/a.test.js is listed twice"]);
});

function floorRun(t, mode, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccdm-python-floor-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }
  return spawnSync(PYTHON, [FLOOR, mode, dir], { encoding: "utf8", windowsHide: true });
}

test("the annotation floor rejects `int | None` without the future import, and nothing else", t => {
  const union = "def f(x: int | None) -> None:\n    return None\n";
  const bad = floorRun(t, "annotations", { "bad.py": union });
  assert.equal(bad.status, 1, bad.stderr || bad.stdout);
  assert.match(bad.stderr, /bad\.py:1: `X \| Y` annotation/);

  const returned = floorRun(t, "annotations", { "bad.py": "def f() -> str | None:\n    return None\n" });
  assert.equal(returned.status, 1, returned.stderr || returned.stdout);
  const variable = floorRun(t, "annotations", { "bad.py": "x: int | None = None\n" });
  assert.equal(variable.status, 1, variable.stderr || variable.stdout);

  const fine = floorRun(t, "annotations", {
    "future.py": `"""Doc."""\nfrom __future__ import annotations\n\n${union}`,
    "bitwise.py": "import os\nFLAGS: int = os.O_RDWR | os.O_CREAT\n\ndef f(mode=os.O_RDWR | os.O_CREAT):\n    return mode\n",
    "quoted.py": 'def f(x: "int | None") -> None:\n    return None\n',
  });
  assert.equal(fine.status, 0, fine.stderr || fine.stdout);
});

test("the annotation floor also reads Python heredocs in shell scripts", t => {
  const script = body => `#!/bin/zsh\npython3 - "$1" <<'PY'\n${body}PY\necho done\n`;
  const union = "def find_pid() -> int | None:\n    return None\n";
  const bad = floorRun(t, "annotations", { "start.sh": script(union) });
  assert.equal(bad.status, 1, bad.stderr || bad.stdout);
  assert.match(bad.stderr, /start\.sh:3: `X \| Y` annotation/);

  const second = floorRun(t, "annotations", { "start.sh": `${script("x = 1\n")}${script(union)}` });
  assert.equal(second.status, 1, second.stderr || second.stdout);
  assert.match(second.stderr, /start\.sh:8: `X \| Y` annotation/);

  const broken = floorRun(t, "annotations", { "start.sh": script("def (:\n") });
  assert.equal(broken.status, 1, broken.stderr || broken.stdout);
  assert.match(broken.stderr, /does not parse/);

  const fine = floorRun(t, "annotations", {
    "future.sh": script(`from __future__ import annotations\n${union}`),
    "quoted.sh": script('def find_pid() -> "int | None":\n    return None\n'),
    "other.sh": "cat <<'EOF'\ndef f() -> int | None: not python\nEOF\n",
  });
  assert.equal(fine.status, 0, fine.stderr || fine.stdout);
});

test("the import floor fails when a ccdmlib module cannot be imported, and walks subpackages", t => {
  const good = { "ccdmlib/__init__.py": "", "ccdmlib/sub/__init__.py": "", "ccdmlib/sub/fine.py": "VALUE = 1\n" };
  const passing = floorRun(t, "imports", good);
  assert.equal(passing.status, 0, passing.stderr || passing.stdout);

  const failing = floorRun(t, "imports", { ...good, "ccdmlib/sub/bad.py": "import no_such_module_on_this_os\n" });
  assert.equal(failing.status, 1, failing.stderr || failing.stdout);
  assert.match(failing.stderr, /ccdmlib\.sub\.bad: ModuleNotFoundError/);

  const empty = floorRun(t, "imports", { "other.py": "" });
  assert.equal(empty.status, 1, empty.stderr || empty.stdout);
});
