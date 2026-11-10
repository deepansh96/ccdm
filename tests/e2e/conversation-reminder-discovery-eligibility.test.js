import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { createBridgeWorkspace, waitForState } from "./support/bridge.js";
import { readState, updateState } from "./support/state.js";
import { cleanup } from "./support/teardown.js";
import {
  adapterEvent, command, fetchCount, longHistory, message, scanFirstPass, seedHistory, setup, startWorker, stop,
  waitForFixture, waitForStatus,
} from "./support/reminder-discovery.js";

test.afterEach(async () => cleanup());

test("historical eligibility requires an owner reply answered by the assigned bot", async () => {
  const workspace = createBridgeWorkspace();
  const cases = {
    guestonly: { history: [["11", "08:01", "bot", "Sure"], ["10", "08:00", "guest", "Can you help?"]],
      state: "open-paused", basis: "no-owner-participation" },
    guestafter: { history: [["24", "08:03", "bot", "Answer for guest"], ["23", "08:02", "guest", "Me too?"],
      ["22", "08:01", "bot", "Answer for owner"], ["21", "08:00", "owner", "Question"]],
    state: "awaiting-owner", basis: "historical-owner-then-bot-approximation", response: "22" },
    waiting: { history: [["31", "08:00", "owner", "Next step?"], ["30", "07:00", "bot", "Old answer"]],
      state: "open-paused", basis: "no-answer-after-reply" },
    command: { history: [["43", "08:01", "bot", "Compaction queued."], ["42", "08:00", "owner", "/compact"],
      ["41", "07:05", "bot", "Answer"], ["40", "07:00", "owner", "Question"]],
    state: "open-paused", basis: "no-answer-after-reply" },
    closed: { history: [["53", "08:05", "bot", "Late answer"], ["52", "08:00", "owner", "/close"],
      ["51", "07:05", "bot", "Answer"], ["50", "07:00", "owner", "Question"]],
    state: "closed", basis: "closed-in-history" },
    closedcmd: { history: [["63", "07:40", "bot", "Answer"],
      ["62", "07:31", "bot", "Bridge paused. New messages will be queued."], ["61", "07:30", "owner", "/pause"],
      ["60", "07:00", "owner", "/close"]], state: "closed", basis: "closed-in-history" },
    reopened: { history: [["72", "08:05", "bot", "Answer"], ["71", "08:00", "owner", "New idea"],
      ["70", "07:00", "owner", "/close"]],
    state: "awaiting-owner", basis: "historical-owner-then-bot-approximation", response: "72" },
    eyes: { history: [["81", "08:05", "bot", "👀"], ["80", "08:00", "owner", "Look at this"]],
      state: "awaiting-owner", basis: "historical-owner-then-bot-approximation", response: "81" },
  };
  const stateDir = await setup(workspace, Object.fromEntries(Object.keys(cases).map(name => [name, `${name}-channel`])));
  seedHistory(workspace, Object.fromEntries(Object.entries(cases).map(([name, row]) => [`${name}-channel`,
    row.history.map(([id, time, author, content]) => message(`${name}-${id}`, `2026-09-20T${time}:00Z`,
      author === "bot" ? `hook-${name}` : author, content))])));
  await command(workspace, stateDir, "discover");
  const worker = startWorker(workspace, stateDir, "2026-09-20T08:10:00Z");
  const ready = await waitForStatus(workspace, stateDir, current => Object.keys(cases).every(name =>
    current.conversations[name]?.reconciliation_status === "ready"));
  for (const [name, row] of Object.entries(cases)) {
    const current = ready.conversations[name];
    assert.deepEqual([current.state, current.discovery.basis, current.response_message_id],
      [row.state, row.basis, row.response ? `${name}-${row.response}` : null], name);
  }
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.equal(readState(workspace.stateDir).fixtures.discord.messages?.length ?? 0, 0);
  await stop(workspace, stateDir, worker);
});

test("known active-turn progress is not a historical completion until the live turn completes", async () => {
  const workspace = createBridgeWorkspace();
  const stateDir = await setup(workspace);
  seedHistory(workspace, { channel: [
    message("92", "2026-09-20T08:01:00Z", "hook-demo", "Still running the tests…"),
    message("91", "2026-09-20T08:00:00Z", "owner", "Run the suite"),
  ] });
  await adapterEvent(workspace, stateDir, "owner_activity", "owner-91", "2026-09-20T08:00:00Z", {
    actor_id: "owner", source_message_id: "91", activity_kind: "message" });
  await adapterEvent(workspace, stateDir, "response_delivered", "progress-92", "2026-09-20T08:01:00Z", {
    provider_session_id: "session", provider_turn_id: "turn", interaction_id: "91",
    message_id: "92", disposition: "progress" });
  await command(workspace, stateDir, "discover");
  const worker = startWorker(workspace, stateDir, "2026-09-20T08:10:00Z");
  const ready = await waitForStatus(workspace, stateDir, current =>
    current.conversations.demo?.reconciliation_status === "ready");
  assert.equal(ready.conversations.demo.state, "open-paused");
  assert.equal(ready.conversations.demo.discovery.basis, "active-turn");
  assert.equal(ready.conversations.demo.due_at, null);
  await adapterEvent(workspace, stateDir, "turn_completed", "complete-91", "2026-09-20T08:30:00Z", {
    provider_session_id: "session", provider_turn_id: "turn", interaction_id: "91",
    delivered_message_ids: ["92"] });
  const armed = await waitForStatus(workspace, stateDir, current =>
    current.conversations.demo?.state === "awaiting-owner");
  assert.equal(armed.conversations.demo.due_at, "2026-09-20T09:30:00Z");
  await stop(workspace, stateDir, worker);
});

test("owner reaction membership acknowledges only when its ordering is established", async () => {
  const workspace = createBridgeWorkspace();
  const names = ["onanswer", "older", "guestreact", "selfonly", "recorded"];
  const stateDir = await setup(workspace, Object.fromEntries(names.map(name => [name, `${name}-channel`])));
  const reacted = (emoji, count = 1, me = false) => ({ reactions: [{ emoji, count, me }] });
  const exchange = (name, progressExtra, answerExtra) => [
    message(`${name}-3`, "2026-09-20T08:05:00Z", `hook-${name}`, "Done", answerExtra),
    message(`${name}-2`, "2026-09-20T08:01:00Z", `hook-${name}`, "Working", progressExtra),
    message(`${name}-1`, "2026-09-20T08:00:00Z", "owner", "Please do it"),
  ];
  seedHistory(workspace, {
    "onanswer-channel": exchange("onanswer", {}, reacted({ name: "👍" })),
    "older-channel": exchange("older", reacted({ name: "party", id: "77" }), {}),
    "guestreact-channel": exchange("guestreact", {}, reacted({ name: "👍" })),
    "selfonly-channel": exchange("selfonly", {}, reacted({ name: "✅" }, 1, true)),
    "recorded-channel": exchange("recorded", reacted({ name: "👀" }), {}),
  }, { reactionUsers: {
    "onanswer-3|👍": ["owner"], "older-2|party:77": ["owner"], "guestreact-3|👍": ["guest"],
    "recorded-2|👀": ["owner"],
  } });
  await adapterEvent(workspace, stateDir, "owner_activity", "recorded-reaction", "2026-09-20T08:02:00Z", {
    project: "recorded", channel_id: "recorded-channel", bot_id: "router:hook-recorded",
    assignment_generation: "gen-recorded", actor_id: "owner", source_message_id: "recorded-2",
    activity_kind: "reaction" });
  await command(workspace, stateDir, "discover");
  const worker = startWorker(workspace, stateDir, "2026-09-20T08:10:00Z");
  await waitForFixture(workspace, state => state.fixtures.discord.reactionFetches?.length === 4);
  const ready = await waitForStatus(workspace, stateDir, current => names.every(name =>
    current.conversations[name]?.reconciliation_status === "ready"));
  assert.deepEqual(Object.fromEntries(names.map(name => [name,
    [ready.conversations[name].state, ready.conversations[name].discovery.basis]])), {
    onanswer: ["open-paused", "owner-reaction-after-answer"],
    older: ["open-paused", "reaction-ordering-unresolved"],
    guestreact: ["awaiting-owner", "historical-owner-then-bot-approximation"],
    selfonly: ["awaiting-owner", "historical-owner-then-bot-approximation"],
    recorded: ["awaiting-owner", "historical-owner-then-bot-approximation"],
  });
  const lookups = readState(workspace.stateDir).fixtures.discord.reactionFetches;
  assert.deepEqual(lookups.map(row => `${row.messageId}|${row.emoji}`).sort(),
    ["guestreact-3|👍", "older-2|party:77", "onanswer-3|👍", "recorded-2|👀"]);
  assert.ok(lookups.every(row => row.authorization === "Bot fixture-root-token" && row.limit === 100));
  await stop(workspace, stateDir, worker);
});

test("denied history suspends the channel with resumable progress instead of skipping it", async () => {
  const workspace = createBridgeWorkspace();
  const stateDir = await setup(workspace);
  const worker = await scanFirstPass(workspace, stateDir, "2026-09-24T12:00:00Z");
  updateState(workspace.stateDir, (seed) => {
    seed.fixtures.discord.restFailures = [{ method: "GET", path: "/api/v10/channels/channel/messages", status: 403 }];
  });
  worker.setClock("2026-09-24T12:00:30Z");
  await waitForFixture(workspace, state => state.fixtures.discord.restFailureUses?.length === 1);
  await new Promise(resolve => setTimeout(resolve, 400));
  const suspended = await waitForStatus(workspace, stateDir, current =>
    current.conversations.demo?.reconciliation_status === "suspended-discovery-history");
  assert.deepEqual([suspended.conversations.demo.discovery.resumable, suspended.conversations.demo.discovery.before_id,
    suspended.conversations.demo.discovery.retry_at], [true, "100150", "2026-09-24T12:05:30Z"]);
  assert.match(suspended.conversations.demo.discovery.reason, /denied/);
  worker.setClock("2026-09-24T12:05:29Z");
  await new Promise(resolve => setTimeout(resolve, 600));
  const denied = readState(workspace.stateDir).fixtures.discord;
  assert.deepEqual([denied.historyFetches.length, denied.restFailureUses.length], [10, 1]);
  worker.setClock("2026-09-24T12:05:30Z");
  await waitForFixture(workspace, state => fetchCount(state, "channel") === 13);
  assert.equal(readState(workspace.stateDir).fixtures.discord.historyFetches[10].before, "100150");
  const ready = await waitForStatus(workspace, stateDir, current =>
    current.conversations.demo?.reconciliation_status === "ready");
  assert.equal(ready.conversations.demo.response_message_id, "101149");
  await stop(workspace, stateDir, worker);
});

test("a crashed scan resumes from its last recorded cursor after restart", async () => {
  const workspace = createBridgeWorkspace();
  const stateDir = await setup(workspace);
  seedHistory(workspace, { channel: longHistory(1150) }, { crashAfterHistoryPages: 5 });
  await command(workspace, stateDir, "discover");
  const first = startWorker(workspace, stateDir, "2026-09-24T12:00:00Z");
  assert.equal((await first.running).exitCode, 2);
  const interrupted = await command(workspace, stateDir, "status");
  assert.deepEqual([interrupted.conversations.demo.reconciliation_status,
    interrupted.conversations.demo.discovery.pages_scanned, interrupted.conversations.demo.discovery.before_id],
  ["discovering", 4, "100750"]);
  const second = startWorker(workspace, stateDir, "2026-09-24T12:00:00Z");
  await waitForState(workspace, state => state.fixtures.discord.historyFetches.length === 10);
  second.setClock("2026-09-24T12:00:30Z");
  // Five first-worker reads (one lost to the crash), then the remaining 8 backward pages and 1 forward page.
  const fetches = (await waitForFixture(workspace, state => fetchCount(state, "channel") === 14))
    .fixtures.discord.historyFetches;
  assert.equal(fetches[5].before, "100750");
  const ready = await waitForStatus(workspace, stateDir, current =>
    current.conversations.demo?.reconciliation_status === "ready");
  assert.equal(ready.conversations.demo.response_message_id, "101149");
  await stop(workspace, stateDir, second);
});

test("an assignment change before commit discards the old scan and rescans the new generation", async () => {
  const workspace = createBridgeWorkspace();
  const stateDir = await setup(workspace);
  const worker = await scanFirstPass(workspace, stateDir, "2026-09-24T12:00:00Z");
  const changed = await command(workspace, stateDir, "assignment-changed", { args: ["assignment-changed",
    "--project-root", workspace.repoDir, "--state-dir", stateDir, "--project", "demo"] });
  await waitForFixture(workspace, state => fetchCount(state, "channel") >= 19);
  await new Promise(resolve => setTimeout(resolve, 400));
  const rescanned = await waitForStatus(workspace, stateDir, current =>
    current.conversations.demo?.assignment_generation === changed.assignment_generation &&
    current.conversations.demo?.discovery?.pages_scanned === 10);
  assert.equal(rescanned.conversations.demo.reconciliation_status, "discovering");
  assert.ok(readState(workspace.stateDir).fixtures.discord.historyFetches.slice(10)
    .some(row => !row.before && !row.after), "the new generation starts from a fresh watermark");
  assert.ok(rescanned.retired_assignments.some(row => row.assignment_generation === "gen-demo"));
  worker.setClock("2026-09-24T12:00:30Z");
  const ready = await waitForStatus(workspace, stateDir, current =>
    current.conversations.demo?.reconciliation_status === "ready");
  assert.equal(ready.conversations.demo.assignment_generation, changed.assignment_generation);
  assert.equal(ready.conversations.demo.response_message_id, "101149");
  await stop(workspace, stateDir, worker);
});

test("history keeps a persisted closure unless it shows a later normal owner message", async () => {
  const workspace = createBridgeWorkspace();
  const stateDir = await setup(workspace, { kept: "kept-channel", reopened: "reopened-channel" });
  seedHistory(workspace, {
    // The /close message itself was deleted; only the recorded closure knows it.
    "kept-channel": [message("kept-3", "2026-09-20T09:30:00Z", "hook-kept", "Late answer"),
      message("kept-1", "2026-09-20T08:00:00Z", "owner", "Question")],
    "reopened-channel": [message("reopened-3", "2026-09-20T09:30:00Z", "hook-reopened", "Answer"),
      message("reopened-2", "2026-09-20T09:20:00Z", "owner", "Actually, one more"),
      message("reopened-1", "2026-09-20T08:00:00Z", "owner", "Question")],
  });
  for (const name of ["kept", "reopened"]) {
    await adapterEvent(workspace, stateDir, "close_requested", `${name}-close`, "2026-09-20T09:00:00Z", {
      project: name, channel_id: `${name}-channel`, bot_id: `router:hook-${name}`, assignment_generation: `gen-${name}`,
      actor_id: "owner", source_message_id: `${name}-deleted-close`, command: "/close" });
  }
  await command(workspace, stateDir, "discover");
  const worker = startWorker(workspace, stateDir, "2026-09-20T09:40:00Z");
  const ready = await waitForStatus(workspace, stateDir, current => ["kept", "reopened"].every(name =>
    current.conversations[name]?.reconciliation_status === "ready"));
  assert.deepEqual([ready.conversations.kept.state, ready.conversations.kept.discovery.basis],
    ["closed", "persisted-closure"]);
  assert.deepEqual([ready.conversations.reopened.state, ready.conversations.reopened.due_at],
    ["awaiting-owner", "2026-09-20T10:30:00Z"]);
  await stop(workspace, stateDir, worker);
});
