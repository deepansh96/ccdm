import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

import { PYTHON } from "./support/platform.js";
import { createBridgeWorkspace, injectDiscordReaction, waitForState } from "./support/bridge.js";
import { readState } from "./support/state.js";
import { cleanup } from "./support/teardown.js";
import {
  arrive, command, fetchCount, longHistory, message, scanFirstPass, seedHistory, setup, startWorker, stop,
  waitForFixture, waitForStatus,
} from "./support/reminder-discovery.js";

test.afterEach(async () => cleanup());

test("discovery arms an old completed-looking answer from its answer time, then delivers", async () => {
  const workspace = createBridgeWorkspace();
  const stateDir = await setup(workspace);
  seedHistory(workspace, { channel: [
    message("1003", "2026-09-20T08:05:00Z", "hook-demo", "Done — the report is ready."),
    message("1002", "2026-09-20T08:01:00Z", "hook-demo", "Working on it."),
    message("1001", "2026-09-20T08:00:00Z", "owner", "Please build the report"),
  ] });
  const requested = await command(workspace, stateDir, "discover");
  assert.equal(requested.discovery_requested, true);
  // History cannot identify earlier reminders, so the baseline starts a fresh streak.
  await command(workspace, stateDir, "sync");
  const seeded = spawnSync(PYTHON, ["-c", "import sqlite3,sys; db=sqlite3.connect(sys.argv[1]); db.execute(\"UPDATE conversations SET consecutive_reminders=5 WHERE project='demo'\"); db.commit(); print(db.total_changes)", path.join(stateDir, "conversations.sqlite3")], { encoding: "utf8" });
  assert.equal(seeded.stdout.trim(), "1", seeded.stderr);
  const worker = startWorker(workspace, stateDir, "2026-09-20T08:30:00Z");
  const ready = await waitForStatus(workspace, stateDir, current =>
    current.conversations.demo?.reconciliation_status === "ready");
  const demo = ready.conversations.demo;
  assert.equal(demo.state, "awaiting-owner");
  assert.equal(demo.response_message_id, "1003");
  assert.equal(demo.response_at, "2026-09-20T08:05:00Z");
  assert.equal(demo.due_at, "2026-09-20T09:05:00Z");
  assert.equal(demo.consecutive_reminders, 0);
  assert.equal(demo.discovery.basis, "historical-owner-then-bot-approximation");
  assert.equal(ready.delivery_enabled, true);
  assert.ok(readState(workspace.stateDir).fixtures.discord.historyFetches.every(row =>
    row.authorization === "Bot fixture-root-token" && row.limit === 100));

  worker.setClock("2026-09-20T09:04:59Z");
  await new Promise(resolve => setTimeout(resolve, 600));
  assert.equal(readState(workspace.stateDir).fixtures.discord.messages?.length ?? 0, 0);
  worker.setClock("2026-09-20T09:05:00Z");
  const sent = await waitForState(workspace, state => state.fixtures.discord.messages?.length === 1);
  assert.equal(sent.fixtures.discord.messages[0].content, "👀");
  assert.equal(sent.fixtures.discord.messages[0].authorization, "Bot fixture-root-token");
  await waitForStatus(workspace, stateDir, current => current.conversations.demo.due_at === "2026-09-20T11:05:00Z" &&
    current.conversations.demo.consecutive_reminders === 1);
  assert.equal(readState(workspace.stateDir).fixtures.codex.appServerInvocations.length, 0);
  await stop(workspace, stateDir, worker);
});

test("discovery pages channels fairly in bounded passes and resumes from the saved cursor", async () => {
  const workspace = createBridgeWorkspace();
  const stateDir = await setup(workspace, { demo: "channel", other: "other-channel" });
  seedHistory(workspace, {
    channel: longHistory(1150),
    "other-channel": [message("2001", "2026-09-21T10:00:00Z", "owner", "Anything new?")],
  });
  await command(workspace, stateDir, "discover");
  const worker = startWorker(workspace, stateDir, "2026-09-24T12:00:00Z");
  await waitForFixture(workspace, state => fetchCount(state, "channel") === 10 &&
    fetchCount(state, "other-channel") === 2);
  await new Promise(resolve => setTimeout(resolve, 600));
  const fetches = readState(workspace.stateDir).fixtures.discord.historyFetches;
  const demoFetches = fetches.filter(row => row.channelId === "channel");
  assert.equal(demoFetches.length, 10);
  assert.ok(fetches.findIndex(row => row.channelId === "other-channel") <
    fetches.indexOf(demoFetches[1]), "a small channel is not starved behind a long one");
  const first = await waitForStatus(workspace, stateDir, current =>
    current.conversations.other?.reconciliation_status === "ready");
  assert.equal(first.conversations.other.state, "open-paused");
  assert.equal(first.conversations.other.discovery.basis, "no-answer-after-reply");
  assert.equal(first.conversations.demo.reconciliation_status, "discovering");
  assert.equal(first.conversations.demo.discovery.pages_scanned, 10);
  assert.equal(first.conversations.demo.discovery.resumable, true);
  assert.equal(first.conversations.demo.discovery.before_id, "100150");

  worker.setClock("2026-09-24T12:00:30Z");
  await waitForFixture(workspace, state => fetchCount(state, "channel") === 13);
  const resumed = readState(workspace.stateDir).fixtures.discord.historyFetches
    .filter(row => row.channelId === "channel").slice(10);
  const ready = await waitForStatus(workspace, stateDir, current =>
    current.conversations.demo?.reconciliation_status === "ready");
  assert.deepEqual(resumed.map(row => row.before ?? `after:${row.after}`),
    ["100150", "100050", "after:101149"]);
  assert.equal(ready.conversations.demo.state, "awaiting-owner");
  assert.equal(ready.conversations.demo.response_message_id, "101149");
  assert.equal(ready.conversations.demo.response_at, "2026-09-20T08:19:09Z");
  assert.equal(ready.conversations.demo.last_ack_message_id, "100000");
  assert.equal(ready.conversations.demo.discovery.passes, 2);
  await stop(workspace, stateDir, worker);
});

test("a throttled channel backs off for Discord's retry window while others continue", async () => {
  const workspace = createBridgeWorkspace();
  const stateDir = await setup(workspace, { demo: "channel", other: "other-channel" });
  seedHistory(workspace, {
    channel: [message("1002", "2026-09-20T08:05:00Z", "hook-demo", "Done"),
      message("1001", "2026-09-20T08:00:00Z", "owner", "Ship it")],
    "other-channel": [message("2001", "2026-09-21T10:00:00Z", "owner", "Anything new?")],
  }, { restFailures: [{ method: "GET", path: "/api/v10/channels/channel/messages", status: 429,
    body: { retry_after: 60 } }] });
  await command(workspace, stateDir, "discover");
  const worker = startWorker(workspace, stateDir, "2026-09-24T12:00:00Z");
  await waitForFixture(workspace, state => state.fixtures.discord.restFailureUses?.length === 1 &&
    fetchCount(state, "other-channel") === 2);
  await new Promise(resolve => setTimeout(resolve, 400));
  const throttled = await waitForStatus(workspace, stateDir, current =>
    current.conversations.other?.reconciliation_status === "ready" &&
    current.conversations.demo?.discovery?.retry_at === "2026-09-24T12:01:00Z");
  assert.equal(throttled.conversations.demo.reconciliation_status, "discovering");
  assert.match(throttled.conversations.demo.discovery.reason, /rate-limited/);
  worker.setClock("2026-09-24T12:00:59Z");
  await new Promise(resolve => setTimeout(resolve, 600));
  assert.equal(readState(workspace.stateDir).fixtures.discord.historyFetches
    .filter(row => row.channelId === "channel").length, 0);
  worker.setClock("2026-09-24T12:01:00Z");
  const ready = await waitForStatus(workspace, stateDir, current =>
    current.conversations.demo?.reconciliation_status === "ready");
  assert.equal(ready.conversations.demo.state, "awaiting-owner");
  assert.equal(ready.conversations.demo.response_at, "2026-09-20T08:05:00Z");
  await stop(workspace, stateDir, worker);
});

test("a newer owner reaction observed during scanning wins over the historical answer", async () => {
  const workspace = createBridgeWorkspace();
  const stateDir = await setup(workspace);
  const worker = await scanFirstPass(workspace, stateDir, "2026-09-20T09:00:00Z");
  injectDiscordReaction(workspace, { channelId: "channel", id: "live-reaction", messageId: "101149",
    emoji: "custom:42", user: { id: "owner" } });
  await waitForState(workspace, state => state.fixtures.discord.deliveredReactions?.some(row => row.id === "live-reaction"));
  await new Promise(resolve => setTimeout(resolve, 400));
  const buffered = await command(workspace, stateDir, "status");
  assert.equal(buffered.conversations.demo.reconciliation_status, "discovering");
  assert.equal(buffered.conversations.demo.last_ack_message_id, null);
  worker.setClock("2026-09-20T09:00:30Z");
  const ready = await waitForStatus(workspace, stateDir, current =>
    current.conversations.demo?.reconciliation_status === "ready");
  assert.equal(ready.conversations.demo.state, "open-paused");
  assert.equal(ready.conversations.demo.due_at, null);
  assert.equal(ready.conversations.demo.last_ack_message_id, "101149");
  await new Promise(resolve => setTimeout(resolve, 600));
  assert.equal(readState(workspace.stateDir).fixtures.discord.messages?.length ?? 0, 0);
  await stop(workspace, stateDir, worker);
});

test("messages arriving during scanning are reconciled forward without counting the owner twice", async () => {
  const workspace = createBridgeWorkspace();
  const stateDir = await setup(workspace);
  const worker = await scanFirstPass(workspace, stateDir, "2026-09-20T09:00:00Z");
  arrive(workspace, "channel", message("102000", "2026-09-20T09:00:10Z", "owner", "One more thing"));
  await waitForState(workspace, state => state.fixtures.discord.deliveredMessages?.some(row => row.id === "102000"));
  arrive(workspace, "channel", message("102001", "2026-09-20T09:00:20Z", "hook-demo", "Handled."));
  await new Promise(resolve => setTimeout(resolve, 400));
  worker.setClock("2026-09-20T09:00:30Z");
  const ready = await waitForStatus(workspace, stateDir, current =>
    current.conversations.demo?.reconciliation_status === "ready");
  assert.equal(ready.conversations.demo.state, "awaiting-owner");
  assert.equal(ready.conversations.demo.last_ack_message_id, "102000");
  assert.equal(ready.conversations.demo.response_message_id, "102001");
  assert.equal(ready.conversations.demo.due_at, "2026-09-20T10:00:20Z");
  await stop(workspace, stateDir, worker);
});

test("an owner /close during scanning closes the conversation and still receives its checkmark", async () => {
  const workspace = createBridgeWorkspace();
  const stateDir = await setup(workspace);
  const worker = await scanFirstPass(workspace, stateDir, "2026-09-20T09:00:00Z");
  arrive(workspace, "channel", message("102000", "2026-09-20T09:00:10Z", "owner", "/close"));
  await waitForState(workspace, state => state.fixtures.discord.deliveredMessages?.some(row => row.id === "102000"));
  await new Promise(resolve => setTimeout(resolve, 400));
  worker.setClock("2026-09-20T09:00:30Z");
  const ready = await waitForStatus(workspace, stateDir, current =>
    current.conversations.demo?.reconciliation_status === "ready");
  assert.equal(ready.conversations.demo.state, "closed");
  const acknowledged = await waitForState(workspace, state => state.fixtures.discord.reactions?.some(row =>
    row.messageId === "102000" && decodeURIComponent(row.emoji) === "✅"));
  assert.equal(acknowledged.fixtures.discord.reactions.find(row => row.messageId === "102000").authorization,
    "Bot fixture-root-token");
  assert.equal(acknowledged.fixtures.discord.messages?.length ?? 0, 0);
  assert.equal(acknowledged.fixtures.codex.appServerInvocations.length, 0);
  await stop(workspace, stateDir, worker);
});
