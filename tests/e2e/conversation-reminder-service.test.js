import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { assertPrivate } from "./support/platform.js";
import { runScript } from "./support/runner.js";
import { createBridgeWorkspace, waitForState } from "./support/bridge.js";
import { routerEnv, waitFor } from "./support/router.js";
import { readState, writeState } from "./support/state.js";
import { cleanup } from "./support/teardown.js";
import {
  command, event, reconciledExchange, refusalsWithRetryTime, rootRouter, setup, waitForConversation, waitForObserver,
} from "./support/reminder-service.js";

test.afterEach(async () => cleanup());

test("status answers with no worker, and reads an existing store in a protected state dir", async () => {
  const workspace = createBridgeWorkspace();
  const stateDir = setup(workspace);
  const before = await command(workspace, stateDir, "status");
  assert.deepEqual([before.status, before.worker_running], ["uninitialized", false]);
  await command(workspace, stateDir, "sync");
  assertPrivate(stateDir);
  const after = await command(workspace, stateDir, "status");
  assert.deepEqual([after.status, after.worker_running], ["ok", false]);
});

test("a reconciled Project Conversation gets its first emoji only after a full hour", async () => {
  const workspace = createBridgeWorkspace();
  const stateDir = setup(workspace);
  await reconciledExchange(workspace, stateDir);
  const rootState = await rootRouter(workspace);
  const clockFile = path.join(workspace.tmpDir, "reminder-clock");
  fs.writeFileSync(clockFile, "2026-09-24T10:59:59Z");
  const running = runScript(workspace, "scripts/conversation-reminder-service.py", {
    args: ["run", "--project-root", workspace.repoDir, "--state-dir", stateDir],
    env: routerEnv(workspace, { ROOT_DISCORD_STATE_DIR: rootState,
      CCDM_REMINDER_NODE: process.execPath, CCDM_REMINDER_CLOCK_FILE: clockFile }),
    timeoutMs: 10000,
  });
  await waitForObserver(workspace, stateDir);
  await new Promise(resolve => setTimeout(resolve, 600));
  assert.equal(readState(workspace.stateDir).fixtures.discord.messages.length, 0);
  fs.writeFileSync(clockFile, "2026-09-24T11:00:00Z");
  const sent = await waitForState(workspace, state => state.fixtures.discord.messages.length === 1);
  assert.equal(sent.fixtures.discord.messages[0].content, "👀");
  assert.equal(sent.fixtures.discord.messages[0].authorization, "Bot fixture-root-token");
  assert.equal(sent.fixtures.codex.appServerInvocations.length, 0);
  await command(workspace, stateDir, "disable");
  assert.equal((await running).exitCode, 0);
});

test("ignored reminders back off 1h, 2h, 4h, 6h, 8h and each replacement posts before deleting the recorded one", async () => {
  const workspace = createBridgeWorkspace();
  const stateDir = setup(workspace);
  await reconciledExchange(workspace, stateDir);
  const rootState = await rootRouter(workspace);
  const clockFile = path.join(workspace.tmpDir, "reminder-clock");
  fs.writeFileSync(clockFile, "2026-09-24T11:00:00Z");
  const running = runScript(workspace, "scripts/conversation-reminder-service.py", {
    args: ["run", "--project-root", workspace.repoDir, "--state-dir", stateDir],
    env: routerEnv(workspace, { ROOT_DISCORD_STATE_DIR: rootState,
      CCDM_REMINDER_NODE: process.execPath, CCDM_REMINDER_CLOCK_FILE: clockFile }),
    timeoutMs: 20000,
  });
  await waitForState(workspace, state => state.fixtures.discord.messages.length === 1);
  let current = (await waitForConversation(workspace, stateDir, row =>
    row?.due_at === "2026-09-24T13:00:00Z")).conversations.demo;
  assert.equal(current.consecutive_reminders, 1);
  // The response was at 10:00: reminders follow at 11:00, 13:00, 17:00, 23:00 and 07:00.
  const schedule = [["2026-09-24T12:59:59Z", "2026-09-24T13:00:00Z", "2026-09-24T17:00:00Z"],
    ["2026-09-24T16:59:59Z", "2026-09-24T17:00:00Z", "2026-09-24T23:00:00Z"],
    ["2026-09-24T22:59:59Z", "2026-09-24T23:00:00Z", "2026-09-25T07:00:00Z"],
    ["2026-09-25T06:59:59Z", "2026-09-25T07:00:00Z", "2026-09-25T17:00:00Z"]];
  for (const [index, [early, due, next]] of schedule.entries()) {
    fs.writeFileSync(clockFile, early);
    await new Promise(resolve => setTimeout(resolve, 600));
    assert.equal(readState(workspace.stateDir).fixtures.discord.messages.length, index + 1, `nothing before ${due}`);
    fs.writeFileSync(clockFile, due);
    await waitForState(workspace, state => state.fixtures.discord.deletes?.length === index + 1);
    current = (await waitForConversation(workspace, stateDir, row => row?.due_at === next)).conversations.demo;
    assert.equal(current.consecutive_reminders, index + 2);
    assert.equal(current.reminder_message_id, `fake-message-${index + 2}`);
  }
  const observed = readState(workspace.stateDir).fixtures.discord;
  assert.deepEqual(observed.messages.map(row => row.requestBody), observed.messages.map(row => ({
    content: "👀", allowed_mentions: { parse: [] }, nonce: row.requestBody.nonce, enforce_nonce: true })));
  assert.equal(new Set(observed.messages.map(row => row.requestBody.nonce)).size, 5);
  assert.deepEqual(observed.deletes.map(row => row.messageId),
    ["fake-message-1", "fake-message-2", "fake-message-3", "fake-message-4"]);
  assert.deepEqual(observed.reminderRequests.map(row => row.method),
    ["POST", "POST", "DELETE", "POST", "DELETE", "POST", "DELETE", "POST", "DELETE"]);
  await command(workspace, stateDir, "disable");
  assert.equal((await running).exitCode, 0);
});

test("a delayed Discord response anchors the next gap to message creation", async () => {
  const workspace = createBridgeWorkspace();
  const stateDir = setup(workspace);
  await reconciledExchange(workspace, stateDir);
  const seed = readState(workspace.stateDir);
  seed.fixtures.discord.restResponseDelayMs = 800;
  writeState(seed, workspace.stateDir);
  const rootState = await rootRouter(workspace);
  const clockFile = path.join(workspace.tmpDir, "reminder-clock");
  fs.writeFileSync(clockFile, "2026-09-24T11:00:00Z");
  const running = runScript(workspace, "scripts/conversation-reminder-service.py", {
    args: ["run", "--project-root", workspace.repoDir, "--state-dir", stateDir],
    env: routerEnv(workspace, { ROOT_DISCORD_STATE_DIR: rootState,
      CCDM_REMINDER_NODE: process.execPath, CCDM_REMINDER_CLOCK_FILE: clockFile }),
    timeoutMs: 10000,
  });
  await waitForState(workspace, state => state.fixtures.discord.responsePending === true);
  fs.writeFileSync(clockFile, "2026-09-24T11:02:00Z");
  const sent = await waitForConversation(workspace, stateDir, current =>
    current?.reminder_message_id === "fake-message-1");
  assert.equal(sent.conversations.demo.due_at, "2026-09-24T13:00:00Z");
  await command(workspace, stateDir, "disable");
  assert.equal((await running).exitCode, 0);
});

test("a Conversation Reply after a delivery claim invalidates it before the Discord request", async () => {
  const workspace = createBridgeWorkspace();
  const stateDir = setup(workspace);
  await reconciledExchange(workspace, stateDir);
  const clockFile = path.join(workspace.tmpDir, "reminder-clock");
  fs.writeFileSync(clockFile, "2026-09-24T11:00:00Z");
  const env = { CCDM_REMINDER_CLOCK_FILE: clockFile };
  const claimed = await command(workspace, stateDir, "claim", { env });
  assert.equal(typeof claimed.claim.nonce, "string");
  await event(workspace, stateDir, "owner_activity", "reply-before-request", "2026-09-24T11:00:00Z", {
    actor_id: "owner", source_message_id: "reply-before-request", activity_kind: "message",
  });
  const checked = await runScript(workspace, "scripts/conversation-reminder-service.py", {
    args: ["validate", "--project-root", workspace.repoDir, "--state-dir", stateDir,
      "--nonce", claimed.claim.nonce], env,
  });
  assert.equal(checked.exitCode, 0, checked.stderr || checked.stdout);
  assert.equal(JSON.parse(checked.stdout).valid, false);
  assert.equal((await command(workspace, stateDir, "status")).conversations.demo.state, "open-paused");
  assert.deepEqual(readState(workspace.stateDir).fixtures.discord.messages, []);
});

test("a Conversation Reply during the Discord request removes its returned reminder", async () => {
  const workspace = createBridgeWorkspace();
  const stateDir = setup(workspace);
  await reconciledExchange(workspace, stateDir);
  const seed = readState(workspace.stateDir);
  seed.fixtures.discord.restResponseDelayMs = 800;
  writeState(seed, workspace.stateDir);
  const rootState = await rootRouter(workspace);
  const clockFile = path.join(workspace.tmpDir, "reminder-clock");
  fs.writeFileSync(clockFile, "2026-09-24T11:00:00Z");
  const running = runScript(workspace, "scripts/conversation-reminder-service.py", {
    args: ["run", "--project-root", workspace.repoDir, "--state-dir", stateDir],
    env: routerEnv(workspace, { ROOT_DISCORD_STATE_DIR: rootState,
      CCDM_REMINDER_NODE: process.execPath, CCDM_REMINDER_CLOCK_FILE: clockFile }),
    timeoutMs: 10000,
  });
  await waitForState(workspace, state => state.fixtures.discord.responsePending === true);
  await event(workspace, stateDir, "owner_activity", "during-request", "2026-09-24T11:00:01Z", {
    actor_id: "owner", source_message_id: "owner-during-request", activity_kind: "message",
  });
  const observed = await waitForState(workspace, state => state.fixtures.discord.deletes?.length === 1);
  assert.deepEqual(observed.fixtures.discord.deletes.map(row => row.messageId), ["fake-message-1"]);
  const state = await waitForConversation(workspace, stateDir, current =>
    current?.state === "open-paused" && current?.cleanup_message_ids.length === 0);
  assert.equal(state.conversations.demo.reminder_message_id, null);
  assert.equal(state.conversations.demo.due_at, null);
  assert.equal(observed.fixtures.codex.appServerInvocations.length, 0);
  await command(workspace, stateDir, "disable");
  assert.equal((await running).exitCode, 0);
});

test("owner closure during the Discord request deletes its returned reminder and confirms closure", async () => {
  const workspace = createBridgeWorkspace();
  const stateDir = setup(workspace);
  await reconciledExchange(workspace, stateDir);
  const seed = readState(workspace.stateDir);
  seed.fixtures.discord.restResponseDelayMs = 800;
  writeState(seed, workspace.stateDir);
  const rootState = await rootRouter(workspace);
  const clockFile = path.join(workspace.tmpDir, "reminder-clock");
  fs.writeFileSync(clockFile, "2026-09-24T11:00:00Z");
  const running = runScript(workspace, "scripts/conversation-reminder-service.py", {
    args: ["run", "--project-root", workspace.repoDir, "--state-dir", stateDir],
    env: routerEnv(workspace, { ROOT_DISCORD_STATE_DIR: rootState,
      CCDM_REMINDER_NODE: process.execPath, CCDM_REMINDER_CLOCK_FILE: clockFile }),
    timeoutMs: 10000,
  });
  await waitForState(workspace, state => state.fixtures.discord.responsePending === true);
  await event(workspace, stateDir, "close_requested", "close-during-request", "2026-09-24T11:00:01Z", {
    actor_id: "owner", source_message_id: "owner-close-during-request", command: "/close",
  });
  await waitForState(workspace, state => state.fixtures.discord.deletes?.length === 1 &&
    state.fixtures.discord.reactions.some(row => row.messageId === "owner-close-during-request"));
  const closed = await waitForConversation(workspace, stateDir, current =>
    current?.state === "closed" && current?.cleanup_message_ids.length === 0);
  assert.equal(closed.conversations.demo.reminder_message_id, null);
  assert.equal(closed.conversations.demo.due_at, null);
  assert.deepEqual(readState(workspace.stateDir).fixtures.discord.deletes.map(row => row.messageId),
    ["fake-message-1"]);
  assert.equal(readState(workspace.stateDir).fixtures.codex.appServerInvocations.length, 0);
  await command(workspace, stateDir, "disable");
  assert.equal((await running).exitCode, 0);
});

test("failed cleanup blocks another replacement until deletion succeeds", async () => {
  const workspace = createBridgeWorkspace();
  const stateDir = setup(workspace);
  await reconciledExchange(workspace, stateDir);
  const rootState = await rootRouter(workspace);
  const clockFile = path.join(workspace.tmpDir, "reminder-clock");
  fs.writeFileSync(clockFile, "2026-09-24T11:00:00Z");
  const running = runScript(workspace, "scripts/conversation-reminder-service.py", {
    args: ["run", "--project-root", workspace.repoDir, "--state-dir", stateDir],
    env: routerEnv(workspace, { ROOT_DISCORD_STATE_DIR: rootState,
      CCDM_REMINDER_NODE: process.execPath, CCDM_REMINDER_CLOCK_FILE: clockFile }),
    timeoutMs: 10000,
  });
  await waitForConversation(workspace, stateDir, current => current?.reminder_message_id === "fake-message-1");
  const seed = readState(workspace.stateDir);
  seed.fixtures.discord.restFailures = Array.from({ length: 20 }, () => ({ method: "DELETE", status: 503 }));
  writeState(seed, workspace.stateDir);
  fs.writeFileSync(clockFile, "2026-09-24T13:00:00Z");
  await waitForState(workspace, state => state.fixtures.discord.deletes?.length === 1);
  assert.deepEqual((await command(workspace, stateDir, "status")).conversations.demo.cleanup_message_ids,
    ["fake-message-1"]);
  fs.writeFileSync(clockFile, "2026-09-24T17:00:00Z");
  await new Promise(resolve => setTimeout(resolve, 450));
  assert.equal(readState(workspace.stateDir).fixtures.discord.messages.length, 2);
  const recovery = readState(workspace.stateDir);
  recovery.fixtures.discord.restFailures = [];
  writeState(recovery, workspace.stateDir);
  fs.writeFileSync(clockFile, "2026-09-24T17:00:01Z");
  await waitForState(workspace, state => state.fixtures.discord.deletes?.length >= 2);
  await waitForState(workspace, state => state.fixtures.discord.messages.length === 3);
  await command(workspace, stateDir, "disable");
  assert.equal((await running).exitCode, 0);
});

test("cleanup waits for Discord's full 429 retry window before deleting by ID", async () => {
  const workspace = createBridgeWorkspace();
  const stateDir = setup(workspace);
  await reconciledExchange(workspace, stateDir);
  const rootState = await rootRouter(workspace);
  const clockFile = path.join(workspace.tmpDir, "reminder-clock");
  fs.writeFileSync(clockFile, "2026-09-24T11:00:00Z");
  const running = runScript(workspace, "scripts/conversation-reminder-service.py", {
    args: ["run", "--project-root", workspace.repoDir, "--state-dir", stateDir],
    env: routerEnv(workspace, { ROOT_DISCORD_STATE_DIR: rootState,
      CCDM_REMINDER_NODE: process.execPath, CCDM_REMINDER_CLOCK_FILE: clockFile }),
    timeoutMs: 10000,
  });
  await waitForConversation(workspace, stateDir, current => current?.reminder_message_id === "fake-message-1");
  const seed = readState(workspace.stateDir);
  seed.fixtures.discord.restFailures = [{ method: "DELETE", status: 429, body: { retry_after: 360 } }];
  writeState(seed, workspace.stateDir);
  fs.writeFileSync(clockFile, "2026-09-24T13:00:00Z");
  await waitForState(workspace, state => state.fixtures.discord.restFailureUses.length === 1);
  assert.deepEqual((await command(workspace, stateDir, "status")).conversations.demo.cleanup_message_ids,
    ["fake-message-1"]);
  fs.writeFileSync(clockFile, "2026-09-24T13:05:59Z");
  await new Promise(resolve => setTimeout(resolve, 600));
  assert.equal(readState(workspace.stateDir).fixtures.discord.deletes.length, 1);
  fs.writeFileSync(clockFile, "2026-09-24T13:06:00Z");
  await waitForState(workspace, state => state.fixtures.discord.deletes.length === 2);
  await waitForConversation(workspace, stateDir, current => current?.cleanup_message_ids.length === 0);
  assert.deepEqual(readState(workspace.stateDir).fixtures.discord.deletes.map(row => row.messageId),
    ["fake-message-1", "fake-message-1"]);
  await command(workspace, stateDir, "disable");
  assert.equal((await running).exitCode, 0);
});

test("Discord 429 preserves the prior reminder and waits for the advertised retry time", async () => {
  const workspace = createBridgeWorkspace();
  const stateDir = setup(workspace);
  await reconciledExchange(workspace, stateDir);
  const rootState = await rootRouter(workspace);
  const clockFile = path.join(workspace.tmpDir, "reminder-clock");
  fs.writeFileSync(clockFile, "2026-09-24T11:00:00Z");
  const running = runScript(workspace, "scripts/conversation-reminder-service.py", {
    args: ["run", "--project-root", workspace.repoDir, "--state-dir", stateDir],
    env: routerEnv(workspace, { ROOT_DISCORD_STATE_DIR: rootState,
      CCDM_REMINDER_NODE: process.execPath, CCDM_REMINDER_CLOCK_FILE: clockFile }),
    timeoutMs: 10000,
  });
  await waitForConversation(workspace, stateDir, current => current?.reminder_message_id === "fake-message-1");
  const seed = readState(workspace.stateDir);
  seed.fixtures.discord.restFailures = [{ method: "POST", status: 429, body: { retry_after: 360 } }];
  writeState(seed, workspace.stateDir);
  fs.writeFileSync(clockFile, "2026-09-24T13:00:00Z");
  await waitForState(workspace, state => state.fixtures.discord.restFailureUses.length === 1);
  // The retry time counts from the clock when the refusal is recorded, so the
  // clock moves on only after that.
  await waitFor(() => refusalsWithRetryTime(stateDir).length === 1, () => "the 429 to be recorded with its retry time", 15000);
  assert.equal((await command(workspace, stateDir, "status")).conversations.demo.reminder_message_id,
    "fake-message-1");
  assert.equal(readState(workspace.stateDir).fixtures.discord.deletes?.length || 0, 0);
  fs.writeFileSync(clockFile, "2026-09-24T13:05:59Z");
  await new Promise(resolve => setTimeout(resolve, 650));
  assert.equal(readState(workspace.stateDir).fixtures.discord.messages.length, 1);
  fs.writeFileSync(clockFile, "2026-09-24T13:06:00Z");
  await waitForState(workspace, state => state.fixtures.discord.messages.length === 2);
  await waitForConversation(workspace, stateDir, current => current?.due_at === "2026-09-24T17:06:00Z");
  await command(workspace, stateDir, "disable");
  assert.equal((await running).exitCode, 0);
});

test("a bot access failure suspends delivery without deleting the prior reminder", async () => {
  const workspace = createBridgeWorkspace();
  const stateDir = setup(workspace);
  await reconciledExchange(workspace, stateDir);
  const rootState = await rootRouter(workspace);
  const clockFile = path.join(workspace.tmpDir, "reminder-clock");
  fs.writeFileSync(clockFile, "2026-09-24T11:00:00Z");
  const running = runScript(workspace, "scripts/conversation-reminder-service.py", {
    args: ["run", "--project-root", workspace.repoDir, "--state-dir", stateDir],
    env: routerEnv(workspace, { ROOT_DISCORD_STATE_DIR: rootState,
      CCDM_REMINDER_NODE: process.execPath, CCDM_REMINDER_CLOCK_FILE: clockFile }),
    timeoutMs: 10000,
  });
  await waitForConversation(workspace, stateDir, current => current?.reminder_message_id === "fake-message-1");
  const seed = readState(workspace.stateDir);
  seed.fixtures.discord.restFailures = [{ method: "POST", status: 403 }];
  writeState(seed, workspace.stateDir);
  fs.writeFileSync(clockFile, "2026-09-24T13:00:00Z");
  await waitForState(workspace, state => state.fixtures.discord.restFailureUses.length === 1);
  const suspended = await waitForConversation(workspace, stateDir, current =>
    current?.reconciliation_status === "suspended-delivery-access");
  assert.equal(suspended.conversations.demo.reminder_message_id, "fake-message-1");
  assert.equal(readState(workspace.stateDir).fixtures.discord.deletes?.length || 0, 0);
  fs.writeFileSync(clockFile, "2026-09-24T17:00:00Z");
  await new Promise(resolve => setTimeout(resolve, 600));
  assert.equal(readState(workspace.stateDir).fixtures.discord.messages.length, 1);
  await command(workspace, stateDir, "disable");
  assert.equal((await running).exitCode, 0);
});
