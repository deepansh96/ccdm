import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { waitForState } from "./support/bridge.js";
import { ROOT_TOKEN } from "./support/router.js";
import { readState, updateState } from "./support/state.js";
import { cleanup } from "./support/teardown.js";
import {
  adapterEvent, answered, command, discoveredThenStopped, hook, message, missed, reminders, seedHistory, settle,
  setup, startWorker, stopWorker, waitForStatus,
} from "./support/reminder-restart.js";

test.afterEach(async () => cleanup());

test("downtime catch-up sends one reminder per overdue channel, spaced globally, anchored to its send", async () => {
  const { workspace, context } = await setup({ alpha: "alpha-channel", beta: "beta-channel", gamma: "gamma-channel" });
  seedHistory(workspace, {
    "alpha-channel": answered("alpha"),
    "beta-channel": answered("beta"),
    "gamma-channel": answered("gamma"),
  });
  const ready = await discoveredThenStopped(workspace, context, ["alpha", "beta", "gamma"]);
  assert.deepEqual(["alpha", "beta", "gamma"].map(name => ready.conversations[name].due_at),
    ["2026-09-20T09:05:00Z", "2026-09-20T09:05:00Z", "2026-09-20T09:05:00Z"]);
  assert.equal(reminders(readState(workspace.stateDir)).length, 0);
  // Gamma's owner replies while the service is down; the bot's later answer has
  // no live completion, so history alone never re-arms it.
  missed(workspace, "gamma-channel", message("gamma-3", "2026-09-20T10:00:00Z", "owner", "Next step"));
  missed(workspace, "gamma-channel", message("gamma-4", "2026-09-20T10:05:00Z", hook("gamma"), "Next step done"));

  await command(workspace, context, "enable");
  context.setClock("2026-09-20T15:20:00Z");
  const second = startWorker(workspace, context);
  const first = await waitForState(workspace, state => reminders(state).length === 1, 20000);
  assert.equal(reminders(first)[0].channelId, "alpha-channel");
  context.setClock("2026-09-20T15:20:04Z");
  await settle();
  assert.equal(reminders(readState(workspace.stateDir)).length, 1, "catch-up sends are spaced five seconds apart");
  context.setClock("2026-09-20T15:20:05Z");
  const both = await waitForState(workspace, state => reminders(state).length === 2, 20000);
  assert.equal(reminders(both)[1].channelId, "beta-channel");
  const anchored = await waitForStatus(workspace, context, current =>
    current.conversations.beta.due_at === "2026-09-20T17:20:05Z");
  // A catch-up is a real send: the streak grows and the next gap is two hours.
  assert.deepEqual([anchored.conversations.alpha.due_at, anchored.conversations.alpha.consecutive_reminders],
    ["2026-09-20T17:20:00Z", 1]);
  assert.deepEqual([anchored.conversations.gamma.state, anchored.conversations.gamma.last_ack_message_id],
    ["open-paused", "gamma-3"]);

  context.setClock("2026-09-20T17:19:59Z");
  await settle();
  assert.equal(reminders(readState(workspace.stateDir)).length, 2, "missed intervals are never replayed");
  context.setClock("2026-09-20T17:20:00Z");
  const next = await waitForState(workspace, state => reminders(state).length === 3, 20000);
  assert.equal(reminders(next)[2].channelId, "alpha-channel");
  const backedOff = await waitForStatus(workspace, context, current =>
    current.conversations.alpha.due_at === "2026-09-20T21:20:00Z");
  assert.equal(backedOff.conversations.alpha.consecutive_reminders, 2);
  assert.equal(readState(workspace.stateDir).fixtures.codex.appServerInvocations.length, 0);
  await stopWorker(workspace, context, second);
});

test("waking from sleep reconciles missed replies before any send and spaces overdue catch-ups", async () => {
  const { workspace, context } = await setup({ alpha: "alpha-channel", beta: "beta-channel", gamma: "gamma-channel" });
  const wallOffset = path.join(workspace.tmpDir, "wall-offset");
  context.env = { ...context.env, CCDM_TEST_WALL_OFFSET_FILE: wallOffset, CCDM_REMINDER_WAKE_SETTLE_MS: "4000" };
  seedHistory(workspace, {
    "alpha-channel": answered("alpha"),
    "beta-channel": answered("beta"),
    "gamma-channel": answered("gamma"),
  });
  await command(workspace, context, "enable");
  context.setClock("2026-09-20T08:30:00Z");
  const running = startWorker(workspace, context);
  const names = ["alpha", "beta", "gamma"];
  await waitForStatus(workspace, context, current => names.every(name =>
    current.conversations[name]?.reconciliation_status === "ready"));
  await settle();
  assert.equal(reminders(readState(workspace.stateDir)).length, 0);

  // The Mac sleeps for seven hours. Gamma's owner replies from a phone; the
  // Router never delivers it and the socket still looks connected on wake.
  missed(workspace, "gamma-channel", message("gamma-3", "2026-09-20T10:00:00Z", "owner", "Next step"));
  fs.writeFileSync(wallOffset, String(7 * 3600000));
  await waitForStatus(workspace, context, current => names.every(name =>
    current.conversations[name].reconciliation_status === "suspended-restart-reconciliation"));
  context.setClock("2026-09-20T15:20:00Z");
  await settle(1000);
  assert.equal(reminders(readState(workspace.stateDir)).length, 0, "nothing sends before restart reconciliation");

  const first = await waitForState(workspace, state => reminders(state).length === 1, 20000);
  assert.equal(reminders(first)[0].channelId, "alpha-channel");
  context.setClock("2026-09-20T15:20:04Z");
  await settle();
  assert.equal(reminders(readState(workspace.stateDir)).length, 1, "catch-up sends are spaced five seconds apart");
  context.setClock("2026-09-20T15:20:05Z");
  const both = await waitForState(workspace, state => reminders(state).length === 2, 20000);
  assert.equal(reminders(both)[1].channelId, "beta-channel");
  const woke = await waitForStatus(workspace, context, current =>
    current.conversations.beta.due_at === "2026-09-20T17:20:05Z");
  assert.deepEqual(names.map(name => woke.conversations[name].discovery.mode), ["restart", "restart", "restart"]);
  assert.deepEqual([woke.conversations.gamma.state, woke.conversations.gamma.last_ack_message_id],
    ["open-paused", "gamma-3"]);
  await settle();
  assert.equal(reminders(readState(workspace.stateDir)).length, 2);
  await stopWorker(workspace, context, running);
});

test("missed owner activity and provider replay are applied before any catch-up is sent", async () => {
  const names = ["closed", "reacted", "ambiguous", "replayed", "denied", "untouched"];
  const { workspace, context } = await setup(Object.fromEntries(names.map(name => [name, `${name}-channel`])));
  seedHistory(workspace, Object.fromEntries(names.map(name => [`${name}-channel`, [
    message(`${name}-2`, "2026-09-20T08:05:00Z", hook(name), "Done"),
    message(`${name}-p`, "2026-09-20T08:02:00Z", hook(name), "Working"),
    message(`${name}-1`, "2026-09-20T08:00:00Z", "owner", "Please do it"),
  ]])));
  await discoveredThenStopped(workspace, context, names);

  // Downtime, 10:00-15:20. Nothing observes the Router.
  missed(workspace, "closed-channel", message("closed-3", "2026-09-20T10:00:00Z", "owner", "/close"));
  const state = updateState(workspace.stateDir, (state) => {
    state.fixtures.discord.history["reacted-channel"][0].reactions = [{ emoji: { name: "party", id: "77" }, count: 1 }];
    state.fixtures.discord.history["ambiguous-channel"][1].reactions = [{ emoji: { name: "👍" }, count: 1 }];
    state.fixtures.discord.reactionUsers = { "reacted-2|party:77": ["owner"], "ambiguous-p|👍": ["owner"] };
    state.fixtures.discord.restFailures = [{ method: "GET", path: "/api/v10/channels/denied-channel/messages",
      status: 403 }];
  });
  // A still-running Codex bridge answered a new owner message and durably recorded it.
  missed(workspace, "replayed-channel", message("replayed-3", "2026-09-20T12:00:00Z", "owner", "One more"));
  missed(workspace, "replayed-channel", message("replayed-4", "2026-09-20T12:05:00Z", hook("replayed"), "Answered"));
  await adapterEvent(workspace, context, "replayed", "owner_activity", "replayed-owner", "2026-09-20T12:00:01Z", {
    actor_id: "owner", source_message_id: "replayed-3", activity_kind: "message" });
  await adapterEvent(workspace, context, "replayed", "response_delivered", "replayed-receipt", "2026-09-20T12:05:00Z", {
    provider_session_id: "session", provider_turn_id: "turn-2", interaction_id: "replayed-3",
    message_id: "replayed-4", disposition: "progress" });
  await adapterEvent(workspace, context, "replayed", "turn_completed", "replayed-complete", "2026-09-20T12:05:00Z", {
    provider_session_id: "session", provider_turn_id: "turn-2", interaction_id: "replayed-3",
    delivered_message_ids: ["replayed-4"] });

  await command(workspace, context, "enable");
  context.setClock("2026-09-20T15:20:00Z");
  const worker = startWorker(workspace, context);
  const settled = await waitForStatus(workspace, context, current =>
    names.filter(name => name !== "denied").every(name =>
      current.conversations[name]?.reconciliation_status === "ready") &&
    current.conversations.denied?.reconciliation_status === "suspended-discovery-history");
  const summary = Object.fromEntries(names.map(name => [name,
    [settled.conversations[name].state, settled.conversations[name].discovery?.basis]]));
  assert.deepEqual(summary, {
    closed: ["closed", "missed-owner-activity"],
    reacted: ["open-paused", "owner-reaction-after-answer"],
    ambiguous: ["open-paused", "reaction-ordering-unresolved"],
    replayed: ["awaiting-owner", "missed-owner-activity"],
    denied: ["awaiting-owner", null],
    untouched: ["awaiting-owner", "no-missed-activity"],
  });
  assert.equal(settled.conversations.replayed.due_at, "2026-09-20T13:05:00Z");
  assert.match(settled.readiness.projects.denied.blockers.join("\n"), /history: suspended-discovery-history .*denied/);
  assert.equal(settled.readiness.projects.denied.delivery_ready, false);

  const acknowledged = await waitForState(workspace, current => current.fixtures.discord.reactions?.some(row =>
    row.messageId === "closed-3" && decodeURIComponent(row.emoji) === "✅"), 20000);
  assert.equal(acknowledged.fixtures.discord.reactions.find(row => row.messageId === "closed-3").authorization,
    `Bot ${ROOT_TOKEN}`);
  const first = await waitForState(workspace, current => reminders(current).length === 1, 20000);
  context.setClock("2026-09-20T15:20:05Z");
  const second = await waitForState(workspace, current => reminders(current).length === 2, 20000);
  assert.deepEqual(reminders(second).map(row => row.channelId).sort(), ["replayed-channel", "untouched-channel"]);
  assert.equal(reminders(first)[0].channelId, "replayed-channel");
  context.setClock("2026-09-20T15:21:00Z");
  await settle();
  assert.equal(reminders(readState(workspace.stateDir)).length, 2);
  assert.equal(readState(workspace.stateDir).fixtures.codex.appServerInvocations.length, 0);
  await stopWorker(workspace, context, worker);
});
