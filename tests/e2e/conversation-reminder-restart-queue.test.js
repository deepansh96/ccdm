import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { injectDiscordMessage, waitForState } from "./support/bridge.js";
import { startRouter } from "./support/router.js";
import { readState, updateState } from "./support/state.js";
import { cleanup } from "./support/teardown.js";
import {
  answered, command, discoveredThenStopped, message, missed, reminders, seedHistory, settle, setup, startWorker,
  stopWorker, waitForStatus,
} from "./support/reminder-restart.js";

test.afterEach(async () => cleanup());

test("a rate limit outranks catch-up spacing, and a restart during catch-up cannot bypass it", async () => {
  const names = ["alpha", "beta", "gamma"];
  const { workspace, context } = await setup(Object.fromEntries(names.map(name => [name, `${name}-channel`])));
  seedHistory(workspace, Object.fromEntries(names.map(name => [`${name}-channel`, answered(name)])));
  await discoveredThenStopped(workspace, context, names);
  updateState(workspace.stateDir, (seed) => {
    seed.fixtures.discord.restFailures = [{ method: "POST", path: "/api/v10/channels/alpha-channel/messages",
      status: 429, body: { retry_after: 60, global: true } }];
  });

  await command(workspace, context, "enable");
  context.setClock("2026-09-20T15:20:00Z");
  let worker = startWorker(workspace, context);
  await waitForState(workspace, state => state.fixtures.discord.restFailureUses?.length === 1, 20000);
  const limited = await waitForStatus(workspace, context, current =>
    current.catch_up_next_at === "2026-09-20T15:21:00Z");
  assert.ok(names.every(name => limited.conversations[name].catch_up_queued));
  context.setClock("2026-09-20T15:20:59Z");
  await settle();
  assert.equal(reminders(readState(workspace.stateDir)).length, 0, "no catch-up is sent inside Discord's retry window");

  context.setClock("2026-09-20T15:21:00Z");
  const first = await waitForState(workspace, state => reminders(state).length === 1, 20000);
  assert.equal(reminders(first)[0].channelId, "alpha-channel");
  await waitForStatus(workspace, context, current => current.conversations.alpha.due_at === "2026-09-20T17:21:00Z");
  // Restart two seconds later: every channel reconciles again, yet the durable gate holds.
  await stopWorker(workspace, context, worker);
  await command(workspace, context, "enable");
  context.setClock("2026-09-20T15:21:02Z");
  worker = startWorker(workspace, context);
  await waitForStatus(workspace, context, current => names.every(name =>
    current.conversations[name].reconciliation_status === "ready"));
  context.setClock("2026-09-20T15:21:04Z");
  await settle();
  assert.equal(reminders(readState(workspace.stateDir)).length, 1, "a restart does not reset global spacing");
  const second = await command(workspace, context, "status");
  assert.deepEqual(names.map(name => second.conversations[name].catch_up_queued), [false, true, true]);
  assert.equal(second.readiness.projects.alpha.catch_up_queued, false);

  context.setClock("2026-09-20T15:21:05Z");
  const beta = await waitForState(workspace, state => reminders(state).length === 2, 20000);
  assert.equal(reminders(beta)[1].channelId, "beta-channel");
  context.setClock("2026-09-20T15:21:09Z");
  await settle();
  assert.equal(reminders(readState(workspace.stateDir)).length, 2);
  context.setClock("2026-09-20T15:21:10Z");
  const gamma = await waitForState(workspace, state => reminders(state).length === 3, 20000);
  assert.equal(reminders(gamma)[2].channelId, "gamma-channel");
  assert.deepEqual((await waitForStatus(workspace, context, current =>
    current.conversations.gamma.due_at === "2026-09-20T17:21:10Z")).conversations.beta.due_at,
  "2026-09-20T17:21:05Z");
  await stopWorker(workspace, context, worker);
});

test("a Router reconnect gap is reconciled from history before the next reminder is due", async () => {
  const { workspace, context } = await setup({ alpha: "alpha-channel", beta: "beta-channel" });
  seedHistory(workspace, { "alpha-channel": answered("alpha"), "beta-channel": answered("beta") });
  await command(workspace, context, "enable");
  context.setClock("2026-09-20T08:30:00Z");
  const worker = startWorker(workspace, context);
  await waitForStatus(workspace, context, current => ["alpha", "beta"].every(name =>
    current.conversations[name]?.reconciliation_status === "ready"), undefined, worker);

  await context.router.stop();
  const gap = await waitForStatus(workspace, context, current => ["alpha", "beta"].every(name =>
    current.conversations[name].reconciliation_status === "suspended-observation-access"), undefined, worker);
  assert.match(gap.readiness.projects.alpha.blockers.join("\n"), /history: suspended-observation-access/);
  // While the Router is down, the owner answers alpha; the observer never sees it.
  missed(workspace, "alpha-channel", message("alpha-3", "2026-09-20T08:40:00Z", "owner", "Thanks, looks good"));
  context.setClock("2026-09-20T09:05:00Z");
  await settle();
  assert.equal(reminders(readState(workspace.stateDir)).length, 0, "nothing is sent while the Router is down");

  // The observer's client reconnects on its own; its next revalidation (at most
  // thirty seconds later) resumes the projects through restart reconciliation.
  context.router = await startRouter(workspace);
  const reconciled = await waitForStatus(workspace, context, current => ["alpha", "beta"].every(name =>
    current.conversations[name].reconciliation_status === "ready"), 600, worker);
  assert.deepEqual([reconciled.conversations.alpha.state, reconciled.conversations.alpha.last_ack_message_id],
    ["open-paused", "alpha-3"]);
  const sent = await waitForState(workspace, state => reminders(state).length === 1, 20000);
  assert.equal(reminders(sent)[0].channelId, "beta-channel");
  await settle();
  assert.equal(reminders(readState(workspace.stateDir)).length, 1);
  await stopWorker(workspace, context, worker);
});

test("a queued catch-up honors an owner reply and a deregistration before its turn", async () => {
  const names = ["alpha", "beta", "gamma"];
  const { workspace, context } = await setup(Object.fromEntries(names.map(name => [name, `${name}-channel`])));
  seedHistory(workspace, Object.fromEntries(names.map(name => [`${name}-channel`, answered(name)])));
  await discoveredThenStopped(workspace, context, names);
  await command(workspace, context, "enable");
  context.setClock("2026-09-20T15:20:00Z");
  const worker = startWorker(workspace, context);
  await waitForState(workspace, state => reminders(state).length === 1, 20000);
  // The fake records the send before the worker commits it, so wait for the commit.
  const queued = await waitForStatus(workspace, context, current => current.conversations.alpha.reminder_message_id);
  assert.deepEqual(names.map(name => queued.conversations[name].catch_up_queued), [false, true, true]);

  const state = updateState(workspace.stateDir, (state) => {
    state.fixtures.discord.history["beta-channel"].unshift(
      message("beta-3", "2026-09-20T15:20:02Z", "owner", "Seen it, thanks"));
  });
  injectDiscordMessage(workspace, { id: "beta-3", channelId: "beta-channel", content: "Seen it, thanks",
    author: { id: "owner" } });
  const registryPath = path.join(workspace.repoDir, "registry.json");
  const registry = JSON.parse(fs.readFileSync(registryPath, "utf8"));
  delete registry.projects.gamma;
  fs.writeFileSync(registryPath, JSON.stringify(registry), { mode: 0o600 });
  const canceled = await waitForStatus(workspace, context, current =>
    current.conversations.beta.state === "open-paused" && current.conversations.gamma === undefined);
  assert.equal(canceled.conversations.beta.catch_up_queued, false);

  context.setClock("2026-09-20T15:20:05Z");
  await settle(1000);
  assert.deepEqual(reminders(readState(workspace.stateDir)).map(row => row.channelId), ["alpha-channel"]);
  await stopWorker(workspace, context, worker);
});

test("disable lets an in-flight send finish, keeps closures, and re-enable reconciles before sending", async () => {
  const names = ["alpha", "beta", "shut"];
  const { workspace, context } = await setup(Object.fromEntries(names.map(name => [name, `${name}-channel`])));
  seedHistory(workspace, {
    "alpha-channel": answered("alpha"), "beta-channel": answered("beta"),
    "shut-channel": [message("shut-3", "2026-09-20T08:10:00Z", "owner", "/close"), ...answered("shut")],
  }, { restResponseDelayMs: 800 });
  await discoveredThenStopped(workspace, context, names);
  await command(workspace, context, "enable");
  context.setClock("2026-09-20T15:20:00Z");
  const worker = startWorker(workspace, context);
  await waitForState(workspace, state => state.fixtures.discord.responsePending === true, 20000);
  const disabled = await command(workspace, context, "disable");
  assert.equal(disabled.delivery_enabled, false);
  assert.equal((await worker).exitCode, 0);

  const stopped = await command(workspace, context, "status");
  assert.equal(stopped.conversations.alpha.reminder_message_id, "fake-message-1", "the in-flight send was recorded");
  assert.equal(stopped.conversations.alpha.due_at, "2026-09-20T17:20:00Z");
  assert.deepEqual(stopped.unresolved_intents, []);
  assert.equal(stopped.conversations.beta.catch_up_queued, true);
  assert.equal(stopped.conversations.shut.state, "closed");
  assert.match(stopped.readiness.projects.beta.blockers.join("\n"), /service is disabled; run enable/);
  context.setClock("2026-09-20T15:30:00Z");
  await settle();
  assert.equal(reminders(readState(workspace.stateDir)).length, 1, "disable stops sends");

  // While disabled the owner answers beta; re-enable must reconcile before anything is due.
  missed(workspace, "beta-channel", message("beta-3", "2026-09-20T15:25:00Z", "owner", "Got it"));
  const enabled = await command(workspace, context, "enable");
  assert.deepEqual(names.map(name => enabled.conversations[name].reconciliation_status),
    Array(3).fill("suspended-restart-reconciliation"));
  assert.equal(enabled.conversations.shut.state, "closed");
  assert.match(enabled.readiness.projects.alpha.blockers.join("\n"), /foreground worker is not running/);
  context.setClock("2026-09-20T17:20:00Z");
  const again = startWorker(workspace, context);
  const reconciled = await waitForStatus(workspace, context, current => names.every(name =>
    current.conversations[name].reconciliation_status === "ready"));
  assert.deepEqual(names.map(name => reconciled.conversations[name].state), ["awaiting-owner", "open-paused", "closed"]);
  const next = await waitForState(workspace, state => reminders(state).length === 2, 20000);
  assert.equal(reminders(next)[1].channelId, "alpha-channel");
  await settle();
  assert.equal(reminders(readState(workspace.stateDir)).length, 2);
  await stopWorker(workspace, context, again);
});
