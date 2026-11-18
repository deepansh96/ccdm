import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { assertPrivate, assertPosixMode } from "./support/platform.js";
import { runScript } from "./support/runner.js";
import { waitForState } from "./support/bridge.js";
import { ROOT_TOKEN } from "./support/router.js";
import { readState, updateState } from "./support/state.js";
import { cleanup } from "./support/teardown.js";
import {
  answered, command, discoveredThenStopped, hook, message, reminders, rootEnvFile, seedHistory, settle, setup,
  startWorker, stopWorker, waitForStatus,
} from "./support/reminder-restart.js";

test.afterEach(async () => cleanup());

test("a catch-up waits for the cleanup backlog left before downtime", async () => {
  const { workspace, context } = await setup({ alpha: "alpha-channel" });
  seedHistory(workspace, { "alpha-channel": answered("alpha") });
  await command(workspace, context, "enable");
  context.setClock("2026-09-20T08:30:00Z");
  const first = startWorker(workspace, context);
  await waitForStatus(workspace, context, current => current.conversations.alpha?.reconciliation_status === "ready");
  context.setClock("2026-09-20T09:05:00Z");
  await waitForState(workspace, state => reminders(state).length === 1, 20000);
  await waitForStatus(workspace, context, current => current.conversations.alpha.due_at === "2026-09-20T11:05:00Z");
  updateState(workspace.stateDir, (seed) => {
    const failure = { method: "DELETE", path: "/api/v10/channels/alpha-channel/messages/fake-message-1", status: 500 };
    seed.fixtures.discord.restFailures = [failure, failure];
  });
  context.setClock("2026-09-20T11:05:00Z");
  await waitForState(workspace, state => state.fixtures.discord.restFailureUses?.length === 1, 20000);
  await stopWorker(workspace, context, first);
  const backlog = await command(workspace, context, "status");
  assert.deepEqual(backlog.conversations.alpha.cleanup_message_ids, ["fake-message-1"]);
  assert.deepEqual(backlog.readiness.projects.alpha.pending_cleanup, ["fake-message-1"]);

  await command(workspace, context, "enable");
  context.setClock("2026-09-20T15:20:00Z");
  const second = startWorker(workspace, context);
  await waitForState(workspace, state => state.fixtures.discord.restFailureUses?.length === 2, 20000);
  await settle();
  assert.equal(reminders(readState(workspace.stateDir)).length, 2, "no catch-up while the prior reminder remains");
  context.setClock("2026-09-20T15:20:01Z");
  const sent = await waitForState(workspace, state => reminders(state).length === 3, 20000);
  assert.deepEqual(sent.fixtures.discord.reminderRequests.slice(0, 6).map(row => row.method),
    ["POST", "POST", "DELETE", "DELETE", "DELETE", "POST"]);
  const anchored = await waitForStatus(workspace, context, current =>
    current.conversations.alpha.due_at === "2026-09-20T21:20:01Z");
  assert.equal(anchored.conversations.alpha.catch_up_queued, false);
  assert.equal(anchored.conversations.alpha.consecutive_reminders, 3);
  await stopWorker(workspace, context, second);
});

test("an uncertain delivery stays gated through restart until its nonce replay resolves its identity", async () => {
  const { workspace, context } = await setup({ alpha: "alpha-channel", beta: "beta-channel" });
  seedHistory(workspace, { "alpha-channel": answered("alpha"),
    "beta-channel": [message("beta-3", "2026-09-20T09:30:00Z", hook("beta"), "Done"), ...answered("beta").slice(1)] });
  await command(workspace, context, "enable");
  context.setClock("2026-09-20T08:30:00Z");
  const first = startWorker(workspace, context);
  await waitForStatus(workspace, context, current => ["alpha", "beta"].every(name =>
    current.conversations[name]?.reconciliation_status === "ready"));
  updateState(workspace.stateDir, (seed) => {
    seed.fixtures.discord.crashAfterReminderAccept = true;
    // History briefly lags the accepted reminder.
    seed.fixtures.discord.includeSentInHistory = false;
  });
  context.setClock("2026-09-20T09:05:00Z");
  assert.equal((await first).exitCode, 2);
  assert.equal(reminders(readState(workspace.stateDir)).length, 1);

  // Until a nonce replay returns the accepted reminder, alpha stays gated while
  // beta reconciles normally. History never shows the reminder here.
  updateState(workspace.stateDir, (losing) => {
    losing.fixtures.discord.restLoseResponse = 30;
  });
  await command(workspace, context, "enable");
  context.setClock("2026-09-20T09:06:00Z");
  const second = startWorker(workspace, context);
  const gated = await waitForStatus(workspace, context, current =>
    current.conversations.beta.reconciliation_status === "ready" &&
    current.conversations.alpha.reconciliation_status === "suspended-uncertain-send");
  assert.match(gated.readiness.projects.alpha.blockers.join("\n"), /uncertain delivery: run recover/);
  assert.equal(gated.readiness.projects.alpha.uncertain_delivery.length, 1);
  await settle();
  assert.equal(reminders(readState(workspace.stateDir)).length, 1, "the uncertain channel is never resent");

  // Once a replay inside Discord's duplicate-check window is answered, it
  // returns the 09:05 reminder itself; the worker records it and reconciles.
  updateState(workspace.stateDir, (answering) => {
    answering.fixtures.discord.restLoseResponse = false;
  });
  const adopted = await waitForStatus(workspace, context, current =>
    current.conversations.alpha.reminder_message_id === "fake-message-1" &&
    current.conversations.alpha.reconciliation_status === "ready", 800);
  assert.equal(adopted.conversations.alpha.due_at, "2026-09-20T11:05:00Z");
  assert.deepEqual(adopted.unresolved_intents, []);
  context.setClock("2026-09-20T15:30:00Z");
  const resumed = await waitForState(workspace, state => reminders(state).length === 3, 20000);
  assert.deepEqual(reminders(resumed).map(row => row.channelId).sort(),
    ["alpha-channel", "alpha-channel", "beta-channel"]);
  await waitForStatus(workspace, context, current => current.conversations.alpha.due_at === "2026-09-20T19:30:00Z");
  await settle();
  assert.equal(reminders(readState(workspace.stateDir)).length, 3);
  await stopWorker(workspace, context, second);
});

test("an interrupted restart scan resumes from its checkpoint before releasing the channel", async () => {
  const { workspace, context } = await setup({ alpha: "alpha-channel" });
  const start = Date.parse("2026-09-20T08:00:00Z");
  seedHistory(workspace, { "alpha-channel": Array.from({ length: 150 }, (_, index) => {
    const at = new Date(start + index * 1000).toISOString().replace(".000Z", "Z");
    return index === 0 ? message("300000", at, "owner", "Run it")
      : message(String(300000 + index), at, hook("alpha"), `progress ${index}`);
  }).reverse() });
  await discoveredThenStopped(workspace, context, ["alpha"]);
  const before = readState(workspace.stateDir).fixtures.discord.historyFetches.length;
  updateState(workspace.stateDir, (seed) => {
    seed.fixtures.discord.crashAfterHistoryPages = 2;
  });

  await command(workspace, context, "enable");
  context.setClock("2026-09-20T15:20:00Z");
  assert.equal((await startWorker(workspace, context)).exitCode, 2);
  const interrupted = await command(workspace, context, "status");
  assert.deepEqual([interrupted.conversations.alpha.reconciliation_status,
    interrupted.conversations.alpha.discovery.mode, interrupted.conversations.alpha.discovery.before_id],
  ["reconciling", "restart", "300050"]);
  assert.equal(reminders(readState(workspace.stateDir)).length, 0);

  const resumed = startWorker(workspace, context);
  await waitForStatus(workspace, context, current => current.conversations.alpha.reconciliation_status === "ready");
  const fetches = readState(workspace.stateDir).fixtures.discord.historyFetches.slice(before);
  assert.equal(fetches[2].before, "300050", "the resumed scan continues from its saved cursor");
  const sent = await waitForState(workspace, state => reminders(state).length === 1, 20000);
  assert.equal(reminders(sent)[0].channelId, "alpha-channel");
  await stopWorker(workspace, context, resumed);
});

test("unmet Claude prerequisites block enablement and cannot be bypassed into Codex-only delivery", async () => {
  const { workspace, context } = await setup({ alpha: "alpha-channel" });
  seedHistory(workspace, { "alpha-channel": answered("alpha") });
  const adapter = path.join(workspace.repoDir, "scripts", "ccdm-channel-server.js");
  const saved = fs.readFileSync(adapter);
  fs.rmSync(adapter);

  const refused = await runScript(workspace, "scripts/conversation-reminder-service.py", {
    args: ["enable", "--project-root", workspace.repoDir, "--state-dir", context.stateDir], env: context.env,
  });
  assert.equal(refused.exitCode, 2);
  const blocked = JSON.parse(refused.stdout);
  assert.equal(blocked.status, "blocked");
  assert.match(blocked.reason, /provider prerequisites are unmet: claude missing scripts\/ccdm-channel-server\.js/);
  assert.deepEqual(blocked.preflight.provider_prerequisites.providers.codex, { met: true, missing: [] });
  assert.equal(blocked.preflight.root_credentials, "present");
  assert.doesNotMatch(refused.stdout, new RegExp(ROOT_TOKEN));

  // Even a directly requested scan of a ready Codex channel cannot send.
  await command(workspace, context, "discover");
  context.setClock("2026-09-20T15:20:00Z");
  const worker = startWorker(workspace, context);
  const ready = await waitForStatus(workspace, context, current =>
    current.conversations.alpha?.reconciliation_status === "ready");
  assert.equal(ready.delivery_enabled, false);
  assert.equal(ready.readiness.provider_prerequisites.met, false);
  assert.match(ready.readiness.projects.alpha.blockers.join("\n"), /provider prerequisites are unmet/);
  await settle();
  assert.equal(reminders(readState(workspace.stateDir)).length, 0);
  await stopWorker(workspace, context, worker);

  fs.writeFileSync(adapter, saved);
  const enabled = await command(workspace, context, "enable");
  assert.equal(enabled.delivery_enabled, true);
  assert.deepEqual(enabled.preflight.blockers, []);
  assert.equal(enabled.preflight.state_dir_private, true);
  assertPrivate(context.stateDir);
  const again = startWorker(workspace, context);
  const sent = await waitForState(workspace, state => reminders(state).length === 1, 20000);
  assert.equal(reminders(sent)[0].authorization, `Bot ${ROOT_TOKEN}`);
  const released = await waitForStatus(workspace, context, current =>
    current.conversations.alpha.due_at === "2026-09-20T17:20:00Z");
  assert.deepEqual([released.readiness.projects.alpha.delivery_ready, released.readiness.projects.alpha.blockers],
    [true, []]);
  await stopWorker(workspace, context, again);
});

test("enable refuses without root observation credentials or an owner, and never exposes secrets", async () => {
  const { workspace, context } = await setup({ alpha: "alpha-channel" });
  fs.rmSync(rootEnvFile(workspace));
  const registryPath = path.join(workspace.repoDir, "registry.json");
  const registry = JSON.parse(fs.readFileSync(registryPath, "utf8"));
  delete registry.discord_user_id;
  fs.writeFileSync(registryPath, JSON.stringify(registry), { mode: 0o600 });
  const refused = await runScript(workspace, "scripts/conversation-reminder-service.py", {
    args: ["enable", "--project-root", workspace.repoDir, "--state-dir", context.stateDir], env: context.env,
  });
  assert.equal(refused.exitCode, 2);
  const blocked = JSON.parse(refused.stdout);
  assert.match(blocked.reason, /no CCDM owner/);
  assert.match(blocked.reason, /root Discord credentials are unavailable: set DISCORD_BOT_TOKEN in ROOT_DISCORD_STATE_DIR\/\.env/);
  // A refused enable validates without side effects: no state directory exists.
  assert.equal(fs.existsSync(context.stateDir), false);
  const current = await command(workspace, context, "status");
  assert.equal(current.discovery_requested, false);
  assert.equal(current.delivery_enabled, false);
  assert.equal(fs.existsSync(context.stateDir), false);
});

test("a refused enable leaves an existing state directory's permissions unchanged", async () => {
  const { workspace, context } = await setup({ alpha: "alpha-channel" });
  fs.mkdirSync(context.stateDir, { recursive: true, mode: 0o755 });
  fs.chmodSync(context.stateDir, 0o755);
  fs.rmSync(rootEnvFile(workspace));
  const refused = await runScript(workspace, "scripts/conversation-reminder-service.py", {
    args: ["enable", "--project-root", workspace.repoDir, "--state-dir", context.stateDir], env: context.env,
  });
  assert.equal(refused.exitCode, 2);
  assert.match(JSON.parse(refused.stdout).reason, /set DISCORD_BOT_TOKEN/);
  assertPosixMode(context.stateDir, 0o755);
  assert.deepEqual(fs.readdirSync(context.stateDir), []);

  // Once every blocker clears, enable prepares the private directory itself.
  fs.writeFileSync(rootEnvFile(workspace), `DISCORD_BOT_TOKEN=${ROOT_TOKEN}\n`, { mode: 0o600 });
  const enabled = await command(workspace, context, "enable");
  assert.deepEqual(enabled.preflight.blockers, []);
  assertPrivate(context.stateDir);
});

test("a generation change during downtime rediscovers the new assignment and shares the catch-up spacing", async () => {
  const { workspace, context } = await setup({ alpha: "alpha-channel", beta: "beta-channel" });
  seedHistory(workspace, { "alpha-channel": answered("alpha"), "beta-channel": answered("beta") });
  await discoveredThenStopped(workspace, context, ["alpha", "beta"]);
  const changed = await command(workspace, context, "assignment-changed", ["--project", "beta"]);
  assert.deepEqual(changed.retired_generations, ["gen-beta"]);
  // A late event from the retired generation is rejected rather than replayed.
  const late = await runScript(workspace, "scripts/conversation-reminder-events.py", {
    args: ["ingest", "--project-root", workspace.repoDir, "--state-dir", context.stateDir],
    input: JSON.stringify({ schema_version: 1, event_id: "late-owner", event_type: "owner_activity", project: "beta",
      channel_id: "beta-channel", bot_id: `router:${hook("beta")}`, assignment_generation: "gen-beta", provider: "codex",
      event_time: "2026-09-20T12:00:00Z", event_order: "late", adapter_instance_id: "test-adapter",
      actor_id: "owner", source_message_id: "beta-late", activity_kind: "message" }),
  });
  assert.notEqual(JSON.parse(late.stdout).status, "committed");

  await command(workspace, context, "enable");
  context.setClock("2026-09-20T15:20:00Z");
  const worker = startWorker(workspace, context);
  const first = await waitForState(workspace, state => reminders(state).length === 1, 20000);
  context.setClock("2026-09-20T15:20:04Z");
  await settle();
  assert.equal(reminders(readState(workspace.stateDir)).length, 1);
  context.setClock("2026-09-20T15:20:05Z");
  const both = await waitForState(workspace, state => reminders(state).length === 2, 20000);
  assert.deepEqual([reminders(first)[0].channelId, reminders(both)[1].channelId].sort(),
    ["alpha-channel", "beta-channel"]);
  const current = await waitForStatus(workspace, context, status =>
    status.conversations.beta.assignment_generation === changed.assignment_generation &&
    status.conversations.beta.reminder_message_id);
  assert.equal(current.conversations.beta.discovery.mode, "initial");
  assert.ok(current.retired_assignments.some(row => row.assignment_generation === "gen-beta"));
  await stopWorker(workspace, context, worker);
});
