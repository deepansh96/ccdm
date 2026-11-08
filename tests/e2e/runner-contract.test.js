import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { runnerSettings } from "../run-e2e.mjs";
import { createWorkspace, runNodeEntrypoint, runScript } from "./support/runner.js";
import { cleanup, registerTeardownCallback } from "./support/teardown.js";
import {
  readState,
  recordCommandInvocation,
  seedFixtureProcess,
  seedRegistry,
  seedTmuxSession,
  snapshotFiles,
  writeState,
} from "./support/state.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const RUNNER = path.join(ROOT, "tests", "run-e2e.mjs");
const FIXTURES = path.join(ROOT, "tests", "fixtures", "runner");
const fixture = name => path.join(FIXTURES, `${name}.test.js`);
const label = name => `tests/fixtures/runner/${name}.test.js`;
const tapFile = name => `tests__fixtures__runner__${name}.test.js.tap`;
const FILE_TIMEOUT_MS = 5000;

test("e2e public helpers expose the setup tracer bullet contract", async () => {
  assert.equal(typeof createWorkspace, "function");
  assert.equal(typeof runScript, "function");
  assert.equal(typeof runNodeEntrypoint, "function");
  assert.equal(typeof registerTeardownCallback, "function");
  assert.equal(typeof cleanup, "function");
  assert.equal(typeof readState, "function");
  assert.equal(typeof writeState, "function");
  assert.equal(typeof seedRegistry, "function");
  assert.equal(typeof seedFixtureProcess, "function");
  assert.equal(typeof seedTmuxSession, "function");
  assert.equal(typeof recordCommandInvocation, "function");
  assert.equal(typeof snapshotFiles, "function");
  assert.equal(Object.isFrozen(createWorkspace), true);
  assert.equal(Object.isFrozen(runScript), true);
  assert.equal(Object.isFrozen(runNodeEntrypoint), true);
});

// A fresh temp root per nested run, so it never touches this run's timings
// file or workspaces.
function nestedRunDir(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ccdm-runner-contract-"));
  const tmp = path.join(base, "tmp");
  fs.mkdirSync(tmp);
  t.after(() => fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  return { base, tmp, report: path.join(base, "report"), log: path.join(base, "starts.log") };
}

function runRunner(dirs, files, env = {}) {
  const childEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("CCDM_E2E_")));
  Object.assign(childEnv, { TMPDIR: dirs.tmp, TEMP: dirs.tmp, TMP: dirs.tmp, CCDM_RUNNER_FIXTURE_LOG: dirs.log }, env);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [RUNNER, ...files], { cwd: ROOT, env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", code => resolve({ code, stdout, stderr }));
  });
}

const alive = pid => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function waitGone(pid, ms = 5000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && alive(pid)) await new Promise(resolve => setTimeout(resolve, 100));
  return !alive(pid);
}

const leftoverWorkspaces = dir => fs.readdirSync(dir).filter(name => name.startsWith("ccdm-e2e-")
  && !name.startsWith("ccdm-e2e-report-") && fs.statSync(path.join(dir, name)).isDirectory());

const starts = (dirs, name) => (fs.existsSync(dirs.log) ? fs.readFileSync(dirs.log, "utf8") : "")
  .split("\n").filter(line => line === name).length;

test("runner defaults follow the platform and every setting can be overridden", () => {
  for (const platform of ["linux", "darwin"]) {
    assert.deepEqual(runnerSettings({}, platform, 16),
      { jobs: 14, fileTimeoutMs: 0, rerun: true, keepFailed: false, reportDir: null });
    assert.equal(runnerSettings({}, platform, 2).jobs, 2);
    assert.equal(runnerSettings({}, platform, 1).jobs, 2);
  }
  assert.deepEqual(runnerSettings({}, "win32", 16),
    { jobs: 8, fileTimeoutMs: 600000, rerun: false, keepFailed: false, reportDir: null });
  assert.equal(runnerSettings({}, "win32", 6).jobs, 4);
  assert.equal(runnerSettings({}, "win32", 2).jobs, 1);
  assert.equal(runnerSettings({}, "win32", 1).jobs, 1);

  for (const platform of ["linux", "win32"]) {
    assert.equal(runnerSettings({ CCDM_E2E_JOBS: "3" }, platform, 16).jobs, 3);
    assert.equal(runnerSettings({ CCDM_E2E_JOBS: "12" }, platform, 4).jobs, 12);
    assert.equal(runnerSettings({ CCDM_E2E_FILE_TIMEOUT_MS: "1234" }, platform, 4).fileTimeoutMs, 1234);
    assert.equal(runnerSettings({ CCDM_E2E_FILE_TIMEOUT_MS: "0" }, platform, 4).fileTimeoutMs, 0);
    assert.equal(runnerSettings({ CCDM_E2E_NO_RERUN: "1" }, platform, 4).rerun, false);
    assert.equal(runnerSettings({ CCDM_E2E_NO_RERUN: "0" }, platform, 4).rerun, true);
    assert.equal(runnerSettings({ CCDM_E2E_KEEP_FAILED: "1" }, platform, 4).keepFailed, true);
    assert.equal(runnerSettings({ CCDM_E2E_REPORT_DIR: "report" }, platform, 4).reportDir, path.resolve("report"));
  }
  assert.throws(() => runnerSettings({ CCDM_E2E_FILE_TIMEOUT_MS: "soon" }, "linux", 4), /CCDM_E2E_FILE_TIMEOUT_MS/);
});

test("runner reports passed, failed, crashed and timed-out files and kills only the timed-out file's tree", async t => {
  const dirs = nestedRunDir(t);
  const sentinel = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  t.after(() => sentinel.kill("SIGKILL"));

  const run = await runRunner(dirs, ["pass", "fail", "crash", "hang"].map(fixture), {
    CCDM_E2E_FILE_TIMEOUT_MS: String(FILE_TIMEOUT_MS),
    CCDM_E2E_REPORT_DIR: dirs.report,
    CCDM_E2E_JOBS: "4",
    CCDM_E2E_NO_RERUN: "1",
  });

  assert.equal(run.code, 1, run.stderr || run.stdout);
  assert.match(run.stdout, new RegExp(`^# files 4 · parallel 4 · timeout ${FILE_TIMEOUT_MS} ms · no rerun$`, "m"));
  assert.match(run.stdout, /^# files passed 1 · failed 1 · crashed 1 · timed out 1$/m);
  assert.match(run.stdout, new RegExp(`^# failed: ${label("fail")}$`, "m"));
  assert.match(run.stdout, new RegExp(`^# crashed: ${label("crash")}$`, "m"));
  assert.match(run.stdout, new RegExp(`^# timed out: ${label("hang")}$`, "m"));
  assert.match(run.stdout, new RegExp(`^=== TIMED OUT: ${label("hang")} \\(killed after ${FILE_TIMEOUT_MS} ms\\)$`, "m"));

  const summary = JSON.parse(fs.readFileSync(path.join(dirs.report, "summary.json"), "utf8"));
  assert.equal(summary.schemaVersion, 1);
  assert.equal(summary.jobs, 4);
  assert.equal(summary.fileTimeoutMs, FILE_TIMEOUT_MS);
  assert.equal(summary.rerun, false);
  assert.deepEqual(
    { files: summary.totals.files, passed: summary.totals.passed, failed: summary.totals.failed,
      crashed: summary.totals.crashed, timedOut: summary.totals.timedOut },
    { files: 4, passed: 1, failed: 1, crashed: 1, timedOut: 1 },
  );
  const byLabel = Object.fromEntries(summary.files.map(file => [file.label, file]));
  assert.deepEqual(Object.keys(byLabel).sort(), ["crash", "fail", "hang", "pass"].map(label));
  for (const file of summary.files) {
    for (const key of ["label", "status", "exitCode", "signal", "tests", "pass", "fail", "skipped", "durationMs",
      "timedOut", "crashed", "tap", "workspaces"]) {
      assert.ok(Object.hasOwn(file, key), `${file.label} has no ${key}`);
    }
    assert.equal(file.workspaces.length, 1, `${file.label} announced one workspace`);
  }
  assert.deepEqual(
    Object.fromEntries(summary.files.map(file => [file.label, [file.status, file.crashed, file.timedOut]])),
    {
      [label("pass")]: ["passed", false, false],
      [label("fail")]: ["failed", false, false],
      [label("crash")]: ["crashed", true, false],
      [label("hang")]: ["timed-out", false, true],
    },
  );
  assert.deepEqual([byLabel[label("pass")].pass, byLabel[label("pass")].fail], [1, 0]);
  assert.deepEqual([byLabel[label("fail")].pass, byLabel[label("fail")].fail], [1, 1]);
  assert.ok(byLabel[label("hang")].durationMs >= FILE_TIMEOUT_MS);

  const taps = fs.readdirSync(dirs.report).filter(name => name.endsWith(".tap")).sort();
  assert.deepEqual(taps, ["crash", "fail", "hang", "pass"].map(tapFile));
  assert.match(fs.readFileSync(path.join(dirs.report, tapFile("pass")), "utf8"), /^ok 1 - runner fixture passes$/m);
  assert.match(fs.readFileSync(path.join(dirs.report, tapFile("fail")), "utf8"), /^not ok 2 - runner fixture fails an assert$/m);

  // The timed-out file and its child are gone; the sentinel outside the run is not.
  const hangTap = fs.readFileSync(path.join(dirs.report, tapFile("hang")), "utf8");
  const childPid = Number(hangTap.match(/runner-fixture-child (\d+)/)?.[1]);
  assert.ok(childPid > 0, hangTap);
  assert.ok(await waitGone(childPid), `the timed-out file's child ${childPid} survived`);
  assert.ok(alive(sentinel.pid), "the sentinel process outside the run was killed");

  // Every announced workspace is removed, the timed-out file's included.
  for (const file of summary.files) {
    for (const dir of file.workspaces) assert.ok(!fs.existsSync(dir), `${file.label} left ${dir}`);
  }
  assert.deepEqual(leftoverWorkspaces(dirs.tmp), []);
});

test("CCDM_E2E_KEEP_FAILED=1 keeps a failed file's TAP output and workspace, and removes a passed file's", async t => {
  const dirs = nestedRunDir(t);

  const run = await runRunner(dirs, [fixture("pass"), fixture("fail")], {
    CCDM_E2E_KEEP_FAILED: "1",
    CCDM_E2E_NO_RERUN: "1",
  });

  assert.equal(run.code, 1, run.stderr || run.stdout);
  const kept = [...run.stdout.matchAll(/^# kept workspace: (.+)$/gm)].map(match => match[1]);
  assert.equal(kept.length, 1, run.stdout);
  assert.ok(fs.existsSync(path.join(kept[0], "marker")));
  assert.deepEqual(leftoverWorkspaces(dirs.tmp), [path.basename(kept[0])]);

  const report = run.stdout.match(/^# report: (.+)$/m)?.[1];
  assert.ok(report && fs.existsSync(report), run.stdout);
  assert.deepEqual(fs.readdirSync(report), [tapFile("fail")]);
  assert.match(fs.readFileSync(path.join(report, tapFile("fail")), "utf8"), /^not ok 2 - runner fixture fails an assert$/m);
});

test("CCDM_E2E_NO_RERUN switches the rerun-alone step, which is off by default only on Windows", async t => {
  const cases = [
    [{ CCDM_E2E_NO_RERUN: "1" }, 1],
    [{ CCDM_E2E_NO_RERUN: "0" }, 2],
    [{}, process.platform === "win32" ? 1 : 2],
  ];
  for (const [env, expected] of cases) {
    const dirs = nestedRunDir(t);
    const run = await runRunner(dirs, [fixture("fail")], env);
    assert.equal(run.code, 1, run.stderr || run.stdout);
    assert.equal(starts(dirs, "fail"), expected, `${JSON.stringify(env)}: ${run.stdout}`);
    assert.deepEqual(leftoverWorkspaces(dirs.tmp), []);
    if (!env.CCDM_E2E_NO_RERUN) {
      const { jobs } = runnerSettings({}, process.platform, os.availableParallelism());
      assert.match(run.stdout, new RegExp(`^# files 1 · parallel ${jobs}( ·|$)`, "m"));
    }
  }
});

test("createWorkspace announces its workspace on stderr and keeps it under CCDM_E2E_KEEP_FAILED=1", {
  skip: process.platform === "win32" && "the workspace fixture binaries do not build on Windows yet",
}, async () => {
  const lines = [];
  const write = process.stderr.write;
  const saved = process.env.CCDM_E2E_KEEP_FAILED;
  process.stderr.write = (chunk, ...rest) => {
    if (String(chunk).startsWith("ccdm-e2e-workspace ")) {
      lines.push(String(chunk));
      return true;
    }
    return write.call(process.stderr, chunk, ...rest);
  };
  try {
    process.env.CCDM_E2E_KEEP_FAILED = "1";
    const kept = createWorkspace();
    await cleanup();
    assert.ok(fs.existsSync(kept.tmpRoot), "the workspace was removed under CCDM_E2E_KEEP_FAILED=1");
    fs.rmSync(kept.tmpRoot, { recursive: true, force: true });

    delete process.env.CCDM_E2E_KEEP_FAILED;
    const removed = createWorkspace();
    await cleanup();
    assert.ok(!fs.existsSync(removed.tmpRoot), "the workspace was kept without CCDM_E2E_KEEP_FAILED");

    assert.deepEqual(lines, [`ccdm-e2e-workspace ${kept.tmpRoot}\n`, `ccdm-e2e-workspace ${removed.tmpRoot}\n`]);
  } finally {
    process.stderr.write = write;
    if (saved === undefined) delete process.env.CCDM_E2E_KEEP_FAILED;
    else process.env.CCDM_E2E_KEEP_FAILED = saved;
  }
});
