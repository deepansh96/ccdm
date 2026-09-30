import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  connectSession,
  createRouterWorkspace,
  routerEnv,
  routerRegistry,
  routerWithWebhooks,
  runRouterCli,
  waitFor,
} from "./support/router.js";
import { runScript } from "./support/runner.js";
import { updateState } from "./support/state.js";
import { cleanup } from "./support/teardown.js";

// Longer than the Router's reload debounce below, so a reload lands mid-transaction.
const DEBOUNCE_MS = 20;
const HOLD_MS = 400;

test.afterEach(async () => {
  await cleanup();
});

const registryFile = workspace => path.join(workspace.repoDir, "registry.json");

// `demo` has its webhook and a connected session; `other` is running (a
// recorded PID and session). Every process in the Test Workspace shares one
// armable mid-transaction pause.
async function overlapWorkspace() {
  const workspace = createRouterWorkspace(routerRegistry({
    other: { channel_id: "other-channel", type: "claude", screen_name: "other_session",
      pid: 999999, session_id: "running-session" },
  }));
  fs.chmodSync(registryFile(workspace), 0o600);
  const hold = path.join(workspace.tmpDir, "registry-hold");
  const env = { CCDM_TEST_REGISTRY_HOLD: hold, CCDM_ROUTER_REGISTRY_DEBOUNCE_MS: String(DEBOUNCE_MS) };
  const router = await routerWithWebhooks(workspace, ["demo"], { env });
  const demo = await connectSession(workspace, "demo", "demo-key");
  // Someone deletes the webhook in Discord: the next reply recreates it.
  updateState(workspace.stateDir, (state) => {
    state.fixtures.discord.webhooks = state.fixtures.discord.webhooks.filter(webhook => webhook.id !== "fake-webhook-1");
  });
  return { workspace, router, demo, hold, env };
}

const exists = file => fs.existsSync(file);

// Every read while a writer is paused holding the lock parses, and the Router's
// reloads during the pause never fail.
async function sampleWhileHeld(workspace, router) {
  const until = Date.now() + HOLD_MS;
  let reads = 0;
  while (Date.now() < until) {
    JSON.parse(fs.readFileSync(registryFile(workspace), "utf8"));
    reads++;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.ok(reads > 10);
  assert.doesNotMatch(router.stdout, /registry_reload_failed/);
}

async function assertBothChangesSurvive(workspace, router, reply, stop) {
  const [replied, stopped] = await Promise.all([reply, stop]);
  assert.deepEqual(replied.message_ids, [replied.message_id]);
  assert.equal(stopped.exitCode, 0, stopped.stderr || stopped.stdout);
  const { demo, other } = JSON.parse(fs.readFileSync(registryFile(workspace), "utf8")).projects;
  assert.equal(demo.webhook_id, "fake-webhook-2");
  assert.deepEqual({ pid: other.pid, session_id: other.session_id }, { pid: null, session_id: null });
  // The reminder service's assignment-changed write survives too.
  assert.match(demo.assignment_generation, /^gen-[0-9a-f]{32}$/);
  assert.equal(fs.statSync(registryFile(workspace)).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(workspace.repoDir).filter(name => /registry\.json\.(lock|.*\.tmp)/.test(name)), []);
  const status = await runRouterCli(workspace, ["status", "--json"]);
  assert.equal(status.exitCode, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).registry_error ?? null, null);
  assert.doesNotMatch(router.stdout, /registry_reload_failed/);
}

// Awaited later; a failure before then must not crash the test process.
function sendReply(demo) {
  const reply = demo.client.request("reply", { channel_id: "demo-channel", text: "still here" });
  reply.catch(() => {});
  return reply;
}

function stopOther(workspace, env) {
  return runScript(workspace, "scripts/stop-session.sh", { args: ["other"], env: routerEnv(workspace, env), timeoutMs: 30000 });
}

test("webhook recreation paused holding the registry lock keeps a concurrent stop's PID clear for another project", async () => {
  const { workspace, router, demo, hold, env } = await overlapWorkspace();
  fs.writeFileSync(`${hold}.armed`, "");

  const reply = sendReply(demo);
  await waitFor(() => exists(`${hold}.waiting`), () => `the Router's webhook write to pause:\n${router.stdout}`);
  const stop = stopOther(workspace, env);
  await waitFor(() => exists(`${hold}.blocked`), () => "stop-session to wait for the registry lock", 20000);
  await sampleWhileHeld(workspace, router);
  fs.writeFileSync(`${hold}.release`, "");

  await assertBothChangesSurvive(workspace, router, reply, stop);
});

test("a stop paused holding the registry lock keeps a concurrent webhook recreation for another project", async () => {
  const { workspace, router, demo, hold, env } = await overlapWorkspace();
  fs.writeFileSync(`${hold}.armed`, "");

  const stop = stopOther(workspace, env);
  await waitFor(() => exists(`${hold}.waiting`), () => "stop-session's PID write to pause", 20000);
  const reply = sendReply(demo);
  await waitFor(() => exists(`${hold}.blocked`), () => `the Router to wait for the registry lock:\n${router.stdout}`);
  await sampleWhileHeld(workspace, router);
  fs.writeFileSync(`${hold}.release`, "");

  await assertBothChangesSurvive(workspace, router, reply, stop);
});

test("a registry lock left by a dead writer is reclaimed, and a live holder's lock is waited for, then refused by name", async () => {
  const workspace = createRouterWorkspace(routerRegistry({
    other: { channel_id: "other-channel", type: "claude", screen_name: "other_session", pid: 999999, session_id: "s" },
  }));
  const lock = `${registryFile(workspace)}.lock`;
  // A writer killed while holding the lock (no live pid owns it).
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, "owner"), "999999\n");

  const reclaimed = await stopOther(workspace, {});

  assert.equal(reclaimed.exitCode, 0, reclaimed.stderr || reclaimed.stdout);
  assert.equal(JSON.parse(fs.readFileSync(registryFile(workspace), "utf8")).projects.other.pid, null);
  assert.equal(fs.existsSync(lock), false);

  // A live holder: this test process.
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, "owner"), `${process.pid}\n`);
  const refused = await stopOther(workspace, { CCDM_REGISTRY_LOCK_TIMEOUT_MS: "200" });

  assert.notEqual(refused.exitCode, 0);
  assert.match(refused.stderr, new RegExp(`registry\\.json is locked \\(held by pid ${process.pid}\\)`));
  assert.equal(fs.readFileSync(path.join(lock, "owner"), "utf8"), `${process.pid}\n`);
});
