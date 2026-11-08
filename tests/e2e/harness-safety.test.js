import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { bridgeChildEnv, createBridgeWorkspace } from "./support/bridge.js";
import { assertFixtureExecutable, assertIsolatedPath, redactSecrets } from "./support/diagnostics.js";
import { createWorkspace, runNodeEntrypoint, runScript } from "./support/runner.js";
import {
  readState,
  recordCommandInvocation,
  seedFixtureProcess,
  seedRegistry,
  seedTmuxSession,
  snapshotFiles,
  writeState,
} from "./support/state.js";
import { cleanup, registerTeardownCallback } from "./support/teardown.js";

test.afterEach(async () => {
  await cleanup();
});

test("workspace copies Git-visible source files and excludes local-only artifacts", () => {
  const workspace = createWorkspace();

  assert.ok(fs.existsSync(path.join(workspace.sourceRoot, "registry.example.json")));
  for (const artifact of ["registry.json", ".env", "CLAUDE.local.md", ".claude", ".codex"]) {
    assert.ok(!fs.existsSync(path.join(workspace.repoDir, artifact)), `${artifact} leaked into workspace`);
  }
  assert.ok(fs.existsSync(path.join(workspace.repoDir, "setup.sh")));
});

test("state store reloads from disk and records fixture helpers", () => {
  const workspace = createWorkspace();

  writeState({ custom: "value" }, workspace.stateDir);
  assert.equal(readState(workspace.stateDir).custom, "value");

  seedRegistry(workspace, { pool: [], projects: {} });
  seedFixtureProcess({ pid: process.pid, command: "fixture process" }, { stateDir: workspace.stateDir });
  seedTmuxSession("root_agent", { pane: "ready" }, { stateDir: workspace.stateDir });
  recordCommandInvocation({ command: ["setup.sh"], exitCode: 0 }, { stateDir: workspace.stateDir });
  const snapshot = snapshotFiles(workspace.repoDir, ["setup.sh"], { stateDir: workspace.stateDir });

  const state = readState(workspace.stateDir);
  assert.deepEqual(state.fixtures.registry, { pool: [], projects: {} });
  assert.equal(state.fixtures.processes[0].command, "fixture process");
  assert.equal(state.fixtures.tmux.sessions.root_agent.pane, "ready");
  assert.equal(state.commands[0].exitCode, 0);
  assert.equal(snapshot["setup.sh"].sha256.length, 64);
});

test("command runner injects isolated environment and allowlisted PATH", async () => {
  const workspace = createWorkspace();

  const result = await runScript(workspace, "setup.sh", {
    input: "user-id\nguild-id\nroot-token\n",
  });

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.equal(result.cwd, workspace.repoDir);
  assert.equal(result.detached, true);
  assert.equal(result.env.HOME, workspace.homeDir);
  assert.equal(result.env.PATH, workspace.fixtureDir);
  assert.equal(result.env.TMPDIR, workspace.tmpDir);
  assert.equal(result.env.CCDM_TEST_STATE, workspace.stateDir);
  assert.equal(result.env.NODE_PATH, path.join(workspace.sourceRoot, "node_modules"));
  assert.ok(Object.hasOwn(result.env, "NODE_OPTIONS"));
});

test("missing fixture tools fail fast without falling through to the host PATH", async () => {
  const workspace = createWorkspace({ excludeFixtures: ["jq"] });

  const result = await runScript(workspace, "setup.sh");

  assert.equal(result.exitCode, 1);
  assert.match(result.stdout, /jq/);
  assert.equal(result.env.PATH, workspace.fixtureDir);
});

test("isolation guards produce diagnostics for protected local boundaries", () => {
  const workspace = createWorkspace();
  const protectedTargets = [
    path.join(workspace.sourceRoot, "registry.json"),
    path.join(os.homedir(), ".claude", "settings.json"),
    path.join(os.homedir(), ".codex", "config.toml"),
    "/tmp/ccdm-unapproved-global-file",
  ];

  for (const target of protectedTargets) {
    assert.throws(() => assertIsolatedPath(workspace, target), /Protected path access denied/);
  }
  assert.throws(() => assertFixtureExecutable(workspace, "/usr/bin/tmux"), /Protected path access denied/);
  assert.throws(() => assertFixtureExecutable(workspace, "/usr/bin/security"), /Protected path access denied/);

  const state = readState(workspace.stateDir);
  assert.equal(state.diagnostics.protectedPathViolations.length, 6);
});

test("teardown callbacks run in LIFO order and cleanup failures are diagnostic records", async () => {
  const workspace = createWorkspace();
  const calls = [];

  registerTeardownCallback(() => {
    calls.push("first");
  });
  registerTeardownCallback(() => {
    calls.push("second");
    throw new Error("cleanup-token-failure");
  });

  await cleanup({ stateDir: workspace.stateDir });

  assert.deepEqual(calls, ["second", "first"]);
  assert.match(
    JSON.stringify(readState(workspace.stateDir).diagnostics.cleanupFailures),
    /cleanup-token-failure/,
  );
});

test("failure diagnostics include command details and redact secrets", async () => {
  const workspace = createWorkspace({ excludeFixtures: ["claude"] });

  const result = await runScript(workspace, "setup.sh", {
    env: {
      AUTHORIZATION: "Bot aaaaaaaaaaaaaaaaaaaaaaaa.BBBBBB.cccccccccccccccccccc",
      DISCORD_BOT_TOKEN: "fixture-token-value",
      OAUTH_TOKEN: "sk-ant-x",
    },
  });

  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.diagnostics.command, [path.join(workspace.repoDir, "setup.sh")]);
  assert.match(result.diagnostics.stdout, /Missing required tools/);
  assert.equal(result.diagnostics.env.AUTHORIZATION, "[REDACTED]");
  assert.equal(result.diagnostics.env.DISCORD_BOT_TOKEN, "[REDACTED]");
  assert.equal(result.diagnostics.env.OAUTH_TOKEN, "[REDACTED]");
  assert.doesNotMatch(JSON.stringify(result.diagnostics), /aaaaaaaaaaaaaaaaaaaaaaaa\.BBBBBB/);

  const redactedBody = redactSecrets({
    commandLine: "curl -H 'Authorization: Bot aaaaaaaaaaaaaaaaaaaaaaaa.BBBBBB.cccccccccccccccccccc'",
    dotenv: "DISCORD_BOT_TOKEN=sk-ant-x",
    requestBody: "Authorization: Bot aaaaaaaaaaaaaaaaaaaaaaaa.BBBBBB.cccccccccccccccccccc",
    registry: { token: "ghp_x" },
  });
  assert.doesNotMatch(JSON.stringify(redactedBody), /ghp_|sk-ant-|Authorization: Bot [A-Za-z0-9_.-]+/);
});

test("a node:test file run directly reports TAP when the reporter comes through NODE_OPTIONS", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccdm-reporter-"));
  try {
    const file = path.join(dir, "probe.test.mjs");
    fs.writeFileSync(file, 'import test from "node:test";\ntest("reporter probe", () => {});\n');
    // Without NODE_TEST_CONTEXT, which this file's own run sets.
    const { NODE_TEST_CONTEXT, ...env } = process.env;
    const child = spawn(process.execPath, [file], {
      env: { ...env, NODE_OPTIONS: "--test-reporter=tap" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    const exitCode = await new Promise((resolve) => child.on("close", resolve));

    assert.equal(exitCode, 0, stdout);
    assert.match(stdout, /^TAP version \d+$/m);
    assert.match(stdout, /^ok 1 - reporter probe$/m);
    assert.match(stdout, /^# pass 1$/m);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the Router live smoke test is skipped and touches nothing without the Live Gate", async () => {
  const workspace = createBridgeWorkspace();
  const fixturesBefore = readState(workspace.stateDir).fixtures;

  // Live secrets alone do not open the gate; the preload fails closed on any egress.
  // A flag after the script is a script argument, so the reporter goes through
  // NODE_OPTIONS (Node 23+ defaults to the spec reporter).
  const result = await runNodeEntrypoint(workspace, "tests/e2e/live-smoke.test.js", {
    env: bridgeChildEnv(workspace, {
      CCDM_LIVE_DISCORD_BOT_TOKEN: "placeholder-live-token",
      CCDM_LIVE_DISCORD_CHANNEL_ID: "placeholder-channel",
      CCDM_LIVE_DISCORD_USER_ID: "placeholder-owner",
      NODE_OPTIONS: `${bridgeChildEnv(workspace).NODE_OPTIONS} --test-reporter=tap`,
    }),
    timeoutMs: 20000,
  });

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.deepEqual(result.command, [process.execPath, path.join(workspace.repoDir, "tests/e2e/live-smoke.test.js")]);
  assert.equal(result.env.NODE_OPTIONS,
    `--require ${path.join(workspace.repoDir, "tests/e2e/support/preload.cjs")} --test-reporter=tap`);
  assert.match(result.stdout, /^ok 1 - live Router smoke: Claude and Codex round trips, webhook provenance, root mention, and cleanup # SKIP/m);
  assert.match(result.stdout, /^# skipped 1$/m);
  assert.match(result.stdout, /^# pass 0$/m);
  assert.deepEqual(readState(workspace.stateDir).fixtures, fixturesBefore);
  assert.deepEqual(fs.readdirSync(workspace.tmpDir), []);
});
