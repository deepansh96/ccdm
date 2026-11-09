#!/usr/bin/env node
// Runs the E2E suite with test files in parallel processes. Every test runs in
// its own isolated workspace, so files can run side by side. Files are started
// longest-first (from the previous run's timings) so one slow file doesn't
// finish last on its own. A file that fails under parallel load is rerun alone;
// if it then passes, it is reported as flaky and the run still succeeds.
//
// Usage: node tests/run-e2e.mjs [test files…]   (defaults to tests/e2e/**/*.test.js)
// Environment (see "Run Commands" in tests/e2e/README.md):
//   CCDM_E2E_JOBS             parallel files (POSIX: CPU count - 2, at least 2;
//                             Windows: CPU count - 2, between 1 and 8)
//   CCDM_E2E_FILE_TIMEOUT_MS  per-file deadline; 0 = none (POSIX default: none;
//                             Windows default: 600000)
//   CCDM_E2E_REPORT_DIR       write one TAP file per test file and summary.json
//   CCDM_E2E_KEEP_FAILED=1    keep the TAP output and workspaces of files that did not pass
//   CCDM_E2E_NO_RERUN=1|0     skip (1) or do (0) the rerun-alone step (Windows default: skip)
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WIN = process.platform === "win32";
// After a timeout on POSIX the file's process group gets SIGTERM, so its own
// teardown can run, and SIGKILL if it is still there after this long.
const KILL_GRACE_MS = 5000;
// A grandchild that inherited the output pipes can hold them open after the
// file's process exits; stop waiting for them after this long.
const CLOSE_GRACE_MS = 10000;

// Every default that differs by platform, resolved from the environment.
export function runnerSettings(env = process.env, platform = process.platform,
  parallelism = os.availableParallelism()) {
  const win = platform === "win32";
  const jobs = Number(env.CCDM_E2E_JOBS)
    || (win ? Math.max(1, Math.min(8, parallelism - 2)) : Math.max(2, parallelism - 2));
  let fileTimeoutMs = win ? 600000 : 0;
  if (env.CCDM_E2E_FILE_TIMEOUT_MS !== undefined && env.CCDM_E2E_FILE_TIMEOUT_MS !== "") {
    fileTimeoutMs = Number(env.CCDM_E2E_FILE_TIMEOUT_MS);
    if (!Number.isFinite(fileTimeoutMs) || fileTimeoutMs < 0) {
      throw new Error(`CCDM_E2E_FILE_TIMEOUT_MS must be a number of milliseconds, not ${JSON.stringify(env.CCDM_E2E_FILE_TIMEOUT_MS)}`);
    }
  }
  const noRerun = env.CCDM_E2E_NO_RERUN === "1" ? true : env.CCDM_E2E_NO_RERUN === "0" ? false : win;
  return {
    jobs,
    fileTimeoutMs,
    rerun: !noRerun,
    keepFailed: env.CCDM_E2E_KEEP_FAILED === "1",
    reportDir: env.CCDM_E2E_REPORT_DIR ? path.resolve(env.CCDM_E2E_REPORT_DIR) : null,
  };
}

function testFiles(args) {
  if (args.length) return args.map(file => path.resolve(file));
  const found = [];
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".test.js")) found.push(full);
    }
  };
  walk(path.join(ROOT, "tests", "e2e"));
  return found.sort();
}

function readTimings(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const labelOf = file => path.relative(ROOT, file).split(path.sep).join("/");
const sameFile = (a, b) => (WIN ? a.toLowerCase() === b.toLowerCase() : a === b);

// The PIDs to stop for a file's process on Windows, which reuses PIDs and leaves
// a dead parent's PID on its children, so `taskkill /T` could reach a stranger.
// The root must have been created while the runner spawned it, and a process
// counts as a child only if it is no older than its parent. Rows are
// { pid, parent, created } with `created` in milliseconds.
export function windowsTreeToStop(rootPid, processes, { earliest, latest }) {
  const root = processes.find(process => process.pid === rootPid);
  if (!root || root.created < earliest || root.created > latest) return [];
  const tree = [root];
  const seen = new Set([root.pid]);
  for (const parent of tree) {
    for (const candidate of processes) {
      if (candidate.parent === parent.pid && !seen.has(candidate.pid) && candidate.created >= parent.created) {
        seen.add(candidate.pid);
        tree.push(candidate);
      }
    }
  }
  return tree.map(process => process.pid);
}

function windowsProcessSnapshot() {
  const windows = process.env.SystemRoot ?? "C:\\Windows";
  const powershell = path.join(windows, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const script = "Get-CimInstance Win32_Process | ForEach-Object { if ($_.CreationDate) { "
    + "\"$($_.ProcessId) $($_.ParentProcessId) $(([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds())\" } }";
  return new Promise(resolve => {
    execFile(powershell, ["-NoProfile", "-NonInteractive", "-Command", script],
      { encoding: "utf8", timeout: 30000, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
      (error, stdout) => {
        if (error) return resolve(null);
        resolve(stdout.split(/\r?\n/).filter(Boolean).map(line => {
          const [pid, parent, created] = line.trim().split(" ").map(Number);
          return { pid, parent, created };
        }));
      });
  });
}

// Kill the process the runner spawned for one file, and its tree, and nothing else.
async function killFileProcess(child, spawnWindow) {
  if (WIN) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const processes = await windowsProcessSnapshot();
    const pids = processes ? windowsTreeToStop(child.pid, processes, spawnWindow) : [];
    if (pids.length) {
      const taskkill = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe");
      await new Promise(done => {
        const kill = spawn(taskkill, ["/F", ...pids.flatMap(pid => ["/PID", String(pid)])], { stdio: "ignore", windowsHide: true });
        kill.on("error", done);
        kill.on("exit", done);
      });
    }
    if (child.exitCode === null && child.signalCode === null) child.kill();
    return;
  }
  // On POSIX a file with a deadline runs as the leader of its own process group.
  const signalGroup = signal => {
    try {
      process.kill(-child.pid, signal);
      return true;
    } catch {
      return false;
    }
  };
  if (!signalGroup("SIGTERM")) return;
  const deadline = Date.now() + KILL_GRACE_MS;
  while (Date.now() < deadline && signalGroup(0)) await sleep(100);
  signalGroup("SIGKILL");
}

// `node --test` reports a file that exits or throws outside a test as a
// top-level `not ok` named after the file, whose YAML block has `exitCode:` or
// `signal:`. It exits 1 with `# fail 1`, so the exit code alone cannot tell.
function fileLevelCrash(output, file) {
  const lines = output.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^not ok \d+ - (.*?)(?: # .*)?$/);
    if (!match) continue;
    const name = tapUnescape(match[1]);
    if (!sameFile(path.resolve(ROOT, name), file)) continue;
    for (let j = i + 1; j < lines.length; j++) {
      if (/^\s*\.\.\.\s*$/.test(lines[j]) || /^(not )?ok /.test(lines[j])) break;
      if (/^\s+(exitCode|signal):/.test(lines[j])) return true;
    }
  }
  return false;
}

const tapUnescape = text => text.replace(/\\([\\#])/g, "$1");

// createWorkspace() announces each workspace as `ccdm-e2e-workspace <dir>` on
// stderr, which `node --test` passes on as a TAP comment (backslashes escaped).
// Only direct children of this run's temp dir named like a workspace are accepted.
function workspaceDirs(output) {
  const tmp = path.resolve(os.tmpdir());
  const dirs = [...output.matchAll(/ccdm-e2e-workspace (.+?)\r?$/gm)].map(match => tapUnescape(match[1].trim()));
  return [...new Set(dirs)].filter(dir => path.isAbsolute(dir)
    && sameFile(path.dirname(path.resolve(dir)), tmp) && path.basename(dir).startsWith("ccdm-e2e-"));
}

function status(result) {
  if (result.timedOut) return "timed-out";
  if (result.signal || !/^# tests \d+\r?$/m.test(result.output) || fileLevelCrash(result.output, result.file)) {
    return "crashed";
  }
  if (result.code !== 0 || result.fail > 0) return "failed";
  return "passed";
}

function runFile(file, settings, live) {
  return new Promise(resolve => {
    const started = Date.now();
    const deadline = settings.fileTimeoutMs > 0;
    // NODE_TEST_CONTEXT is only set when this runner itself runs under node --test
    // (runner-contract.test.js); passed on, it would make the file's run a subtest.
    const { NODE_TEST_CONTEXT, ...env } = process.env;
    const child = spawn(process.execPath, ["--test", "--test-reporter=tap", file], {
      cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"],
      detached: deadline && !WIN, windowsHide: true,
    });
    // One second either side covers the granularity of the two clocks.
    const spawnWindow = { earliest: started - 1000, latest: Date.now() + 1000 };
    live.add(child);
    let output = "";
    let timedOut = false;
    let killing = null;
    let finished = false;
    let closeTimer = null;
    const timer = deadline ? setTimeout(() => {
      timedOut = true;
      killing = killFileProcess(child, spawnWindow);
    }, settings.fileTimeoutMs) : null;
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.on("data", chunk => { output += chunk; });
    const finish = async (code, signal) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearTimeout(closeTimer);
      await killing;
      live.delete(child);
      const count = key => Number([...output.matchAll(new RegExp(`^# ${key} (\\d+)\\r?$`, "gm"))].at(-1)?.[1] ?? 0);
      const result = { file, label: labelOf(file), code, signal, output, ms: Date.now() - started, timedOut,
        tests: count("tests"), pass: count("pass"), fail: count("fail"), skipped: count("skipped") };
      result.status = status(result);
      result.workspaces = workspaceDirs(output);
      resolve(result);
    };
    child.on("exit", (code, signal) => {
      closeTimer = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        finish(code, signal);
      }, CLOSE_GRACE_MS);
    });
    child.on("close", finish);
    child.on("error", error => {
      output += `\n${error.stack}\n`;
      finish(null, null);
    });
  });
}

const tapName = label => `${label.replace(/[\\/:]+/g, "__")}.tap`;

function writeTap(dir, result) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, tapName(result.label)), result.output);
}

function removeDirs(dirs) {
  const left = [];
  for (const dir of dirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      left.push(dir);
    }
  }
  return left;
}

async function main() {
  if (WIN) {
    // One message before any file starts, not a failure in every scenario.
    const { harnessPrerequisiteProblem } = await import("./e2e/support/platform.js");
    const problem = harnessPrerequisiteProblem();
    if (problem) {
      console.error(`E2E run cannot start: ${problem}`);
      process.exit(1);
    }
  }
  const settings = runnerSettings();
  const timingsFile = path.join(os.tmpdir(), "ccdm-e2e-timings.json");
  const started = Date.now();
  const timings = readTimings(timingsFile);
  const live = new Set();
  if (settings.fileTimeoutMs > 0 && !WIN) {
    // Files with a deadline run in their own process groups, which no longer get
    // the terminal's Ctrl-C, so pass it on before stopping.
    for (const signal of ["SIGINT", "SIGTERM"]) {
      process.once(signal, () => {
        for (const child of live) {
          try {
            process.kill(-child.pid, signal);
          } catch {
            // Already gone.
          }
        }
        process.kill(process.pid, signal);
      });
    }
  }

  // Unknown files count as slow so they start early.
  const queue = testFiles(process.argv.slice(2))
    .sort((a, b) => (timings[labelOf(b)] ?? 1e9) - (timings[labelOf(a)] ?? 1e9));
  const results = new Map();
  const attempts = [];
  const record = result => {
    attempts.push(result);
    if (settings.reportDir) writeTap(settings.reportDir, result);
  };
  await Promise.all(Array.from({ length: Math.min(settings.jobs, queue.length) }, async () => {
    while (queue.length) {
      const result = await runFile(queue.shift(), settings, live);
      record(result);
      results.set(result.file, result);
    }
  }));

  // A file that hangs would only hang again, so timed-out files are not rerun.
  const flaky = [];
  const rerun = new Set();
  if (settings.rerun) {
    for (const first of [...results.values()].filter(result => result.status === "failed" || result.status === "crashed")) {
      const again = await runFile(first.file, settings, live);
      record(again);
      rerun.add(first.file);
      if (again.status === "passed") flaky.push(first);
      results.set(first.file, again);
    }
  }

  try {
    fs.writeFileSync(timingsFile, JSON.stringify({ ...timings,
      ...Object.fromEntries([...results.values()].map(result => [result.label, result.ms])) }));
  } catch { /* Timings only order the next run. */ }

  // Workspaces of passing attempts always go. Those of other attempts go too
  // unless CCDM_E2E_KEEP_FAILED=1 (a killed file never ran its own teardown).
  const kept = [];
  const notRemoved = [];
  for (const attempt of attempts) {
    attempt.kept = settings.keepFailed && attempt.status !== "passed" ? attempt.workspaces : [];
    kept.push(...attempt.kept);
    notRemoved.push(...removeDirs(attempt.workspaces.filter(dir => !attempt.kept.includes(dir))));
  }

  const final = [...results.values()].sort((a, b) => a.label.localeCompare(b.label));
  const ofStatus = name => final.filter(result => result.status === name);
  const failed = ofStatus("failed");
  const crashed = ofStatus("crashed");
  const timedOut = ofStatus("timed-out");
  const notPassed = final.filter(result => result.status !== "passed");

  let reportDir = settings.reportDir;
  if (!reportDir && settings.keepFailed && notPassed.length) {
    reportDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccdm-e2e-report-"));
    for (const result of notPassed) writeTap(reportDir, result);
  }

  const sum = key => final.reduce((total, result) => total + result[key], 0);
  const durationMs = Date.now() - started;
  if (settings.reportDir) {
    const summary = {
      schemaVersion: 1,
      platform: process.platform,
      node: process.version,
      jobs: settings.jobs,
      fileTimeoutMs: settings.fileTimeoutMs || null,
      rerun: settings.rerun,
      keepFailed: settings.keepFailed,
      durationMs,
      totals: {
        files: final.length, passed: ofStatus("passed").length, failed: failed.length, crashed: crashed.length,
        timedOut: timedOut.length, flaky: flaky.length,
        tests: sum("tests"), pass: sum("pass"), fail: sum("fail"), skipped: sum("skipped"),
      },
      files: final.map(result => ({
        label: result.label,
        status: result.status,
        exitCode: result.code,
        signal: result.signal,
        tests: result.tests,
        pass: result.pass,
        fail: result.fail,
        skipped: result.skipped,
        durationMs: result.ms,
        timedOut: result.status === "timed-out",
        crashed: result.status === "crashed",
        rerun: rerun.has(result.file),
        flaky: flaky.some(first => first.file === result.file),
        tap: tapName(result.label),
        workspaces: attempts.filter(attempt => attempt.file === result.file).flatMap(attempt => attempt.workspaces),
        keptWorkspaces: attempts.filter(attempt => attempt.file === result.file).flatMap(attempt => attempt.kept),
      })),
    };
    fs.writeFileSync(path.join(settings.reportDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  }

  for (const result of failed) console.log(`\n=== FAILED: ${result.label} (exit ${result.code})\n${result.output.trimEnd()}`);
  for (const result of crashed) {
    const how = result.signal ? `signal ${result.signal}` : `exit ${result.code}`;
    console.log(`\n=== CRASHED: ${result.label} (${how})\n${result.output.trimEnd()}`);
  }
  for (const result of timedOut) {
    console.log(`\n=== TIMED OUT: ${result.label} (killed after ${settings.fileTimeoutMs} ms)\n${result.output.trimEnd()}`);
  }
  for (const result of flaky) {
    const names = result.output.match(/^\s*not ok \d+ - .*$/gm) ?? [];
    console.log(`\n=== FLAKY (failed in parallel, passed alone): ${result.label}\n${names.join("\n")}`);
  }
  const options = [
    settings.fileTimeoutMs > 0 ? `timeout ${settings.fileTimeoutMs} ms` : "",
    settings.rerun ? "" : "no rerun",
  ].filter(Boolean).map(option => ` · ${option}`).join("");
  console.log(`\n# files ${final.length} · parallel ${settings.jobs}${options}`);
  console.log(`# tests ${sum("tests")}\n# pass ${sum("pass")}\n# fail ${sum("fail")}\n# skipped ${sum("skipped")}`);
  console.log(`# duration_ms ${durationMs}`);
  if (crashed.length || timedOut.length) {
    console.log(`# files passed ${final.length - notPassed.length} · failed ${failed.length} · crashed ${crashed.length} · timed out ${timedOut.length}`);
  }
  if (failed.length) console.log(`# failed: ${failed.map(result => result.label).join(", ")}`);
  if (crashed.length) console.log(`# crashed: ${crashed.map(result => result.label).join(", ")}`);
  if (timedOut.length) console.log(`# timed out: ${timedOut.map(result => result.label).join(", ")}`);
  for (const dir of kept) console.log(`# kept workspace: ${dir}`);
  for (const dir of notRemoved) console.log(`# could not remove workspace: ${dir}`);
  if (reportDir) console.log(`# report: ${reportDir}`);
  if (notPassed.length) process.exitCode = 1;
}

function invokedDirectly() {
  try {
    return fs.realpathSync.native(process.argv[1]) === fs.realpathSync.native(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) await main();
