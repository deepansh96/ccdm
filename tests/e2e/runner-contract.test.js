import assert from "node:assert/strict";
import test from "node:test";

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
