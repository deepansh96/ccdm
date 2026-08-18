import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

const repoDir = path.resolve(".");
const script = path.join(repoDir, "scripts", "usage-dashboard-renderer.py");
const fixture = path.join(repoDir, "tests", "fixtures", "usage-dashboard.json");

function runRenderer(output, input = fixture) {
  return new Promise((resolve) => {
    const child = spawn("python3", [script, "--input", input, "--output", output], {
      cwd: repoDir,
      env: { ...process.env, PYTHONHASHSEED: "0" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("usage dashboard renderer produces a deterministic PNG for multi-account history", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ccdm-dashboard-"));
  const first = path.join(directory, "first.png");
  const second = path.join(directory, "second.png");
  const firstRun = await runRenderer(first);
  const secondRun = await runRenderer(second);
  assert.equal(firstRun.code, 0, firstRun.stderr || firstRun.stdout);
  assert.equal(secondRun.code, 0, secondRun.stderr || secondRun.stdout);
  assert.match(firstRun.stdout.trim(), /first\.png$/);
  const firstBytes = fs.readFileSync(first);
  const secondBytes = fs.readFileSync(second);
  assert.deepEqual(firstBytes, secondBytes);
  assert.equal(firstBytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.equal(firstBytes.readUInt32BE(16), 1600);
  assert.equal(firstBytes.readUInt32BE(20), 1000);
  assert.equal(crypto.createHash("sha256").update(firstBytes).digest("hex"), crypto.createHash("sha256").update(secondBytes).digest("hex"));
});

test("usage dashboard renderer accepts stdin and keeps unavailable data non-fatal", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ccdm-dashboard-"));
  const output = path.join(directory, "stdin.png");
  const child = spawn("python3", [script, "--input", "-", "--output", output], { cwd: repoDir });
  const payload = JSON.stringify({
    generated_at: "2026-08-18T20:30:00Z",
    cards: [{ key: "claude_5h", label: "Claude", window: "5-hour", available: false, reason: "No token" }],
    history: [{ at: "2026-08-18T20:30:00Z", claude_5h: null }],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdin.end(payload);
  const code = await new Promise((resolve) => child.on("close", resolve));
  assert.equal(code, 0, stderr);
  assert.ok(fs.statSync(output).size > 1000);
});
