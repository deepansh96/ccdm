#!/usr/bin/env node
// Runs the E2E suite with test files in parallel processes. Every test runs in
// its own isolated workspace, so files can run side by side. Files are started
// longest-first (from the previous run's timings) so one slow file doesn't
// finish last on its own. A file that fails under parallel load is rerun alone;
// if it then passes, it is reported as flaky and the run still succeeds.
//
// Usage: node tests/run-e2e.mjs [test files…]   (defaults to tests/e2e/**/*.test.js)
// CCDM_E2E_JOBS sets the number of parallel files (default: CPU count - 2).
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const JOBS = Number(process.env.CCDM_E2E_JOBS) || Math.max(2, os.availableParallelism() - 2);
const TIMINGS = path.join(os.tmpdir(), "ccdm-e2e-timings.json");

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

function readTimings() {
  try {
    return JSON.parse(fs.readFileSync(TIMINGS, "utf8"));
  } catch {
    return {};
  }
}

function runFile(file) {
  return new Promise(resolve => {
    const started = Date.now();
    const child = spawn(process.execPath, ["--test", "--test-reporter=tap", file], {
      cwd: ROOT, env: process.env, stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.on("data", chunk => { output += chunk; });
    child.on("close", code => {
      const count = key => Number(output.match(new RegExp(`^# ${key} (\\d+)$`, "m"))?.[1] ?? 0);
      resolve({ file, label: path.relative(ROOT, file), code, output, ms: Date.now() - started,
        tests: count("tests"), pass: count("pass"), fail: count("fail"), skipped: count("skipped") });
    });
  });
}

const started = Date.now();
const timings = readTimings();
// Unknown files count as slow so they start early.
const queue = testFiles(process.argv.slice(2))
  .sort((a, b) => (timings[path.relative(ROOT, b)] ?? 1e9) - (timings[path.relative(ROOT, a)] ?? 1e9));
const results = new Map();
await Promise.all(Array.from({ length: Math.min(JOBS, queue.length) }, async () => {
  while (queue.length) {
    const result = await runFile(queue.shift());
    results.set(result.file, result);
  }
}));
const failedOf = list => list.filter(result => result.code !== 0 || result.fail > 0);

const flaky = [];
for (const first of failedOf([...results.values()])) {
  const rerun = await runFile(first.file);
  if (failedOf([rerun]).length === 0) flaky.push(first);
  results.set(first.file, rerun);
}

try {
  fs.writeFileSync(TIMINGS, JSON.stringify({ ...timings,
    ...Object.fromEntries([...results.values()].map(result => [result.label, result.ms])) }));
} catch { /* Timings only order the next run. */ }

const final = [...results.values()];
const failed = failedOf(final);
for (const result of failed) console.log(`\n=== FAILED: ${result.label} (exit ${result.code})\n${result.output.trimEnd()}`);
for (const result of flaky) {
  const names = result.output.match(/^\s*not ok \d+ - .*$/gm) ?? [];
  console.log(`\n=== FLAKY (failed in parallel, passed alone): ${result.label}\n${names.join("\n")}`);
}
const sum = key => final.reduce((total, result) => total + result[key], 0);
console.log(`\n# files ${final.length} · parallel ${JOBS}`);
console.log(`# tests ${sum("tests")}\n# pass ${sum("pass")}\n# fail ${sum("fail")}\n# skipped ${sum("skipped")}`);
console.log(`# duration_ms ${Date.now() - started}`);
if (failed.length) {
  console.log(`# failed: ${failed.map(result => result.label).join(", ")}`);
  process.exitCode = 1;
}
