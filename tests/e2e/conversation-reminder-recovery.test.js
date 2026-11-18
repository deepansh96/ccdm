import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";

import { PYTHON, fixtureLauncher } from "./support/platform.js";
import { runScript } from "./support/runner.js";
import { createBridgeWorkspace, waitForState } from "./support/bridge.js";
import { routerEnv } from "./support/router.js";
import { readState, writeState } from "./support/state.js";
import { cleanup } from "./support/teardown.js";
import {
  command, event, reconciledExchange, rootRouter, setup, streak, waitForConversation, waitForObserver,
} from "./support/reminder-service.js";

test.afterEach(async () => cleanup());

// The crash tests put a stand-in in Python's place (CCDM_REMINDER_PYTHON): it runs
// the real Python and then, after a successful `subcommand`, kills the observer
// that called it. With a `marker` file the first such call only leaves the marker
// and the second one kills. POSIX takes the shell script it is given. Windows
// starts only real programs, so there the stand-in is the fixture launcher running
// a Node script; the observer is the launcher's parent, and it is still waiting
// for this call when it is killed.
function crashInjector(workspace, name, shellScript, subcommand, marker = null) {
  if (process.platform !== "win32") {
    const wrapper = path.join(workspace.tmpDir, `${name}.sh`);
    fs.writeFileSync(wrapper, shellScript, { mode: 0o700 });
    return wrapper;
  }
  const script = path.join(workspace.tmpDir, `${name}.cjs`);
  fs.writeFileSync(script, `
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const koffi = require(${JSON.stringify(createRequire(import.meta.url).resolve("koffi"))});
const [subcommand, marker, ...args] = process.argv.slice(2);

function parentPidOf(pid) {
  const HANDLE = koffi.pointer(koffi.opaque());
  const kernel32 = koffi.load("kernel32.dll");
  const OpenProcess = kernel32.func("__stdcall", "OpenProcess", HANDLE, ["uint32_t", "int", "uint32_t"]);
  const CloseHandle = kernel32.func("__stdcall", "CloseHandle", "int", [HANDLE]);
  const BasicInformation = koffi.struct({
    exitStatus: "uintptr_t", peb: "uintptr_t", affinity: "uintptr_t", priority: "uintptr_t", pid: "uintptr_t", parent: "uintptr_t",
  });
  const NtQueryInformationProcess = koffi.load("ntdll.dll").func("__stdcall", "NtQueryInformationProcess", "int32_t",
    [HANDLE, "int32_t", koffi.out(koffi.pointer(BasicInformation)), "uint32_t", koffi.pointer("uint32_t")]);
  const handle = OpenProcess(0x1000, 0, pid);
  if (!handle) throw new Error("cannot open process " + pid);
  try {
    const information = {};
    if (NtQueryInformationProcess(handle, 0, information, koffi.sizeof(BasicInformation), null) !== 0) {
      throw new Error("cannot read the parent of process " + pid);
    }
    return Number(information.parent);
  } finally {
    CloseHandle(handle);
  }
}

const status = spawnSync(${JSON.stringify(PYTHON)}, args, { stdio: "inherit", windowsHide: true }).status ?? 1;
if (status === 0 && args[1] === subcommand) {
  if (marker === "-" || fs.existsSync(marker)) process.kill(parentPidOf(process.ppid), "SIGKILL");
  else fs.writeFileSync(marker, "");
}
process.exit(status);
`);
  const program = path.join(workspace.tmpDir, `${name}.exe`);
  fs.copyFileSync(fixtureLauncher(), program);
  fs.writeFileSync(path.join(workspace.tmpDir, `${name}.shim`), `${[process.execPath, script, subcommand, marker ?? "-"].join("\n")}\n`);
  return program;
}

test("a lost send response is resolved with the same nonce instead of risking a duplicate", async () => {
  const workspace = createBridgeWorkspace();
  const stateDir = setup(workspace);
  await reconciledExchange(workspace, stateDir);
  const rootState = await rootRouter(workspace);
  const clockFile = path.join(workspace.tmpDir, "reminder-clock");
  fs.writeFileSync(clockFile, "2026-09-24T11:00:00Z");
  const env = routerEnv(workspace, { ROOT_DISCORD_STATE_DIR: rootState,
    CCDM_REMINDER_NODE: process.execPath, CCDM_REMINDER_CLOCK_FILE: clockFile });
  const args = ["run", "--project-root", workspace.repoDir, "--state-dir", stateDir];
  const running = runScript(workspace, "scripts/conversation-reminder-service.py", { args, env, timeoutMs: 15000 });
  await waitForConversation(workspace, stateDir, current => current?.reminder_message_id === "fake-message-1");
  const seed = readState(workspace.stateDir);
  seed.fixtures.discord.restLoseResponse = true;
  writeState(seed, workspace.stateDir);
  fs.writeFileSync(clockFile, "2026-09-24T13:00:00Z");
  const replaced = await waitForConversation(workspace, stateDir, current =>
    current?.reminder_message_id === "fake-message-2" && current.cleanup_message_ids.length === 0);
  assert.equal(replaced.conversations.demo.reconciliation_status, "ready");
  assert.equal(replaced.conversations.demo.due_at, "2026-09-24T17:00:00Z");
  assert.equal(replaced.conversations.demo.consecutive_reminders, 2);
  const discord = readState(workspace.stateDir).fixtures.discord;
  assert.equal(discord.lostResponseUses, 1);
  assert.equal(discord.messages.length, 2, "the retry returned the created reminder instead of posting another");
  assert.equal(discord.reminderRequests.filter(row => row.method === "POST").length, 3);
  assert.deepEqual(discord.deletes.map(row => row.messageId), ["fake-message-1"]);
  await command(workspace, stateDir, "disable");
  assert.equal((await running).exitCode, 0);
});

test("a persistently lost response is recovered by replaying its nonce, never adopted from history", async () => {
  const workspace = createBridgeWorkspace();
  const stateDir = setup(workspace);
  await reconciledExchange(workspace, stateDir);
  const rootState = await rootRouter(workspace);
  const clockFile = path.join(workspace.tmpDir, "reminder-clock");
  fs.writeFileSync(clockFile, "2026-09-24T11:00:00Z");
  const env = routerEnv(workspace, { ROOT_DISCORD_STATE_DIR: rootState,
    CCDM_REMINDER_NODE: process.execPath, CCDM_REMINDER_CLOCK_FILE: clockFile });
  const seed = readState(workspace.stateDir);
  // Discord accepts the first attempt, but every send response and the first
  // nonce replays are lost. History never shows the reminder, so only the
  // intent's own nonce can identify it.
  seed.fixtures.discord.restLoseResponse = 30;
  seed.fixtures.discord.includeSentInHistory = false;
  writeState(seed, workspace.stateDir);
  const args = ["run", "--project-root", workspace.repoDir, "--state-dir", stateDir];
  const running = runScript(workspace, "scripts/conversation-reminder-service.py", { args, env, timeoutMs: 60000 });
  const suspended = await waitForConversation(workspace, stateDir, current =>
    current?.reconciliation_status === "suspended-uncertain-send");
  assert.equal(suspended.conversations.demo.reminder_message_id, null);
  await waitForState(workspace, state => (state.fixtures.discord.lostResponseUses ?? 0) >= 4, 20000);
  const lost = readState(workspace.stateDir).fixtures.discord;
  assert.equal(lost.messages.length, 1, "every attempt and replay reused the nonce, so Discord kept one reminder");
  assert.equal((await command(workspace, stateDir, "status")).conversations.demo.reconciliation_status,
    "suspended-uncertain-send");

  // The next replay inside Discord's duplicate-check window returns the
  // reminder the lost request created; the worker records it without an operator.
  const answering = readState(workspace.stateDir);
  answering.fixtures.discord.restLoseResponse = false;
  writeState(answering, workspace.stateDir);
  let found;
  for (let attempt = 0; attempt < 160 && !found; attempt++) {
    const current = await command(workspace, stateDir, "status");
    if (current.conversations.demo.reminder_message_id === "fake-message-1" &&
        current.conversations.demo.reconciliation_status === "ready") found = current;
    else await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.ok(found, "the worker resolved the lost reminder through its nonce");
  // The recovered send counts as the first reminder in the streak.
  assert.equal(found.conversations.demo.due_at, "2026-09-24T13:00:00Z");
  assert.equal(found.conversations.demo.consecutive_reminders, 1);
  assert.deepEqual(found.unresolved_intents, []);
  await command(workspace, stateDir, "disable");
  assert.equal((await running).exitCode, 0);
  assert.equal(readState(workspace.stateDir).fixtures.discord.messages.length, 1);
});

test("server errors that never created a reminder release the channel once the identity window closes", async () => {
  const workspace = createBridgeWorkspace();
  const stateDir = setup(workspace);
  await reconciledExchange(workspace, stateDir);
  const rootState = await rootRouter(workspace);
  const clockFile = path.join(workspace.tmpDir, "reminder-clock");
  fs.writeFileSync(clockFile, "2026-09-24T11:00:00Z");
  const env = routerEnv(workspace, { ROOT_DISCORD_STATE_DIR: rootState,
    CCDM_REMINDER_NODE: process.execPath, CCDM_REMINDER_CLOCK_FILE: clockFile });
  const seed = readState(workspace.stateDir);
  // Every send attempt and nonce replay inside the duplicate-check window fails
  // before Discord creates anything.
  seed.fixtures.discord.restFailures = Array.from({ length: 30 }, (_, index) =>
    ({ method: "POST", status: [503, 502, 504][index % 3] }));
  writeState(seed, workspace.stateDir);
  const running = runScript(workspace, "scripts/conversation-reminder-service.py", {
    args: ["run", "--project-root", workspace.repoDir, "--state-dir", stateDir], env, timeoutMs: 60000 });
  await waitForConversation(workspace, stateDir, current =>
    current?.reconciliation_status === "suspended-uncertain-send");
  assert.equal(readState(workspace.stateDir).fixtures.discord.messages.length, 0);
  // After the window closes, history covering it shows no reminder: the
  // channel reconciles and sends once more instead of waiting on an operator.
  fs.writeFileSync(clockFile, "2026-09-24T11:06:00Z");
  const recovered = readState(workspace.stateDir);
  recovered.fixtures.discord.restFailures = [];
  writeState(recovered, workspace.stateDir);
  const sent = await waitForState(workspace, state => (state.fixtures.discord.messages ?? []).length === 1, 20000);
  assert.equal(sent.fixtures.discord.messages[0].content, "👀");
  const released = await waitForConversation(workspace, stateDir, current =>
    current?.reminder_message_id === "fake-message-1");
  assert.equal(released.conversations.demo.due_at, "2026-09-24T13:06:00Z");
  assert.equal(released.conversations.demo.discovery.mode, "restart");
  await command(workspace, stateDir, "disable");
  assert.equal((await running).exitCode, 0);
});

test("operator recovery replays the claim's nonce after restart instead of matching history", async () => {
  const workspace = createBridgeWorkspace();
  const stateDir = setup(workspace);
  await reconciledExchange(workspace, stateDir);
  const rootState = await rootRouter(workspace);
  const clockFile = path.join(workspace.tmpDir, "reminder-clock");
  fs.writeFileSync(clockFile, "2026-09-24T11:00:00Z");
  const env = routerEnv(workspace, { ROOT_DISCORD_STATE_DIR: rootState,
    CCDM_REMINDER_NODE: process.execPath, CCDM_REMINDER_CLOCK_FILE: clockFile });
  const args = ["run", "--project-root", workspace.repoDir, "--state-dir", stateDir];
  const running = runScript(workspace, "scripts/conversation-reminder-service.py", { args, env, timeoutMs: 10000 });
  await waitForConversation(workspace, stateDir, current => current?.reminder_message_id === "fake-message-1");
  const seed = readState(workspace.stateDir);
  seed.fixtures.discord.restLoseResponse = 30;
  seed.fixtures.discord.includeSentInHistory = false;
  writeState(seed, workspace.stateDir);
  fs.writeFileSync(clockFile, "2026-09-24T13:00:00Z");
  await waitForConversation(workspace, stateDir, current =>
    current?.reconciliation_status === "suspended-uncertain-send");
  await command(workspace, stateDir, "disable");
  assert.equal((await running).exitCode, 0);
  await command(workspace, stateDir, "enable", { env });

  const answering = readState(workspace.stateDir);
  answering.fixtures.discord.restLoseResponse = false;
  writeState(answering, workspace.stateDir);

  const recovered = await command(workspace, stateDir, "recover", { env });
  assert.equal(recovered.recovered, 1);
  const observed = readState(workspace.stateDir).fixtures.discord;
  assert.equal(observed.messages.length, 2, "the replay returned the accepted reminder instead of posting another");
  assert.equal(observed.messages[0].deleted, true);
  assert.equal(observed.messages[1].deleted, undefined);
  const recoveredRow = (await command(workspace, stateDir, "status")).conversations.demo;
  assert.deepEqual([recoveredRow.due_at, recoveredRow.consecutive_reminders], ["2026-09-24T17:00:00Z", 2]);
  assert.equal(readState(workspace.stateDir).fixtures.codex.appServerInvocations.length, 0);
});

test("an interrupted claim never adopts an unrelated emoji and is released once history proves nothing was sent", async () => {
  const workspace = createBridgeWorkspace();
  const stateDir = setup(workspace);
  await reconciledExchange(workspace, stateDir);
  const rootState = await rootRouter(workspace);
  const clockFile = path.join(workspace.tmpDir, "reminder-clock");
  fs.writeFileSync(clockFile, "2026-09-24T11:00:00Z");
  const env = routerEnv(workspace, { ROOT_DISCORD_STATE_DIR: rootState,
    CCDM_REMINDER_NODE: process.execPath, CCDM_REMINDER_CLOCK_FILE: clockFile });
  const claimed = await command(workspace, stateDir, "claim", { env });
  assert.ok(claimed.claim?.nonce);
  const fixture = readState(workspace.stateDir);
  // The owner's own 👀 inside the window and the bot's 👀 from before it are
  // not the claim's identity; the bot's older emoji also bounds the scan.
  fixture.fixtures.discord.restMessages = [
    { id: "owner-eye", content: "👀", author: { id: "owner", bot: false }, timestamp: "2026-09-24T11:00:30Z" },
    { id: "ordinary-eye", content: "👀", author: { id: "fixture-bot-user-id", bot: true }, timestamp: "2026-09-24T10:30:00Z" },
  ];
  writeState(fixture, workspace.stateDir);

  // Past the nonce replay window but inside the identity window, an empty
  // result proves nothing.
  fs.writeFileSync(clockFile, "2026-09-24T11:03:00Z");
  const early = await command(workspace, stateDir, "recover", { env });
  assert.deepEqual([early.recovered, early.released], [0, 0]);
  assert.match(early.unresolved[0].reason, /identity window/);
  const waiting = await command(workspace, stateDir, "status");
  assert.equal(waiting.conversations.demo.reconciliation_status, "suspended-uncertain-send");
  assert.equal(waiting.unresolved_intents[0].nonce, claimed.claim.nonce);
  assert.match(waiting.recovery_guidance, /do not resend/i);

  fs.writeFileSync(clockFile, "2026-09-24T12:10:00Z");
  const recovered = await command(workspace, stateDir, "recover", { env });
  assert.deepEqual([recovered.recovered, recovered.released, recovered.unresolved], [0, 1, []]);
  const current = await command(workspace, stateDir, "status");
  assert.equal(current.conversations.demo.reconciliation_status, "suspended-restart-reconciliation");
  assert.deepEqual(current.unresolved_intents, []);
  assert.equal(current.conversations.demo.reminder_message_id, null);
  const discord = readState(workspace.stateDir).fixtures.discord;
  assert.equal(discord.messages.length, 0);
  assert.equal(discord.deletes?.length || 0, 0);
  assert.equal(discord.restMessages[0].content, "👀");
});

test("recovery never adopts an unbound bot emoji in the claim window and keeps the intent suspended", async () => {
  const workspace = createBridgeWorkspace();
  const stateDir = setup(workspace);
  await reconciledExchange(workspace, stateDir);
  const rootState = await rootRouter(workspace);
  const clockFile = path.join(workspace.tmpDir, "reminder-clock");
  fs.writeFileSync(clockFile, "2026-09-24T11:00:00Z");
  const env = routerEnv(workspace, { ROOT_DISCORD_STATE_DIR: rootState,
    CCDM_REMINDER_NODE: process.execPath, CCDM_REMINDER_CLOCK_FILE: clockFile });
  const nonce = (await command(workspace, stateDir, "claim", { env })).claim.nonce;
  const fixture = readState(workspace.stateDir);
  // One ordinary bare-emoji bot reply inside the window, on the second history
  // page, as history returns it: no nonce, nothing that ties it to the claim.
  fixture.fixtures.discord.restMessages = Array.from({ length: 101 }, (_, index) => ({
    id: `history-${index}`, content: index === 100 ? "👀" : "other",
    author: { id: "fixture-bot-user-id", bot: true }, timestamp: "2026-09-24T11:00:10Z",
  }));
  writeState(fixture, workspace.stateDir);

  for (const clock of ["2026-09-24T11:03:00Z", "2026-09-24T12:10:00Z"]) {
    fs.writeFileSync(clockFile, clock);
    const recovered = await command(workspace, stateDir, "recover", { env });
    assert.deepEqual([recovered.recovered, recovered.released], [0, 0]);
    assert.deepEqual(recovered.unresolved[0].candidates, ["history-100"]);
    assert.match(recovered.unresolved[0].reason, /no evidence binds them to this intent, so none was adopted/);
    assert.match(recovered.unresolved[0].reason, /assignment-changed --project demo/);
    const current = await command(workspace, stateDir, "status");
    assert.equal(current.unresolved_intents[0].nonce, nonce);
    assert.equal(current.conversations.demo.reconciliation_status, "suspended-uncertain-send");
    assert.equal(current.conversations.demo.reminder_message_id, null);
  }
  const untouched = readState(workspace.stateDir).fixtures.discord;
  assert.equal(untouched.deletes?.length || 0, 0);
  assert.equal(untouched.messages?.length || 0, 0);

  // Once the operator removes stray emoji, history proves nothing was sent.
  const cleared = readState(workspace.stateDir);
  cleared.fixtures.discord.restMessages = cleared.fixtures.discord.restMessages.filter(row => row.content !== "👀");
  writeState(cleared, workspace.stateDir);
  const released = await command(workspace, stateDir, "recover", { env });
  assert.deepEqual([released.recovered, released.released, released.unresolved], [0, 1, []]);
});

test("a crash after Discord accepts a reminder recovers one identity without resending", async () => {
  const workspace = createBridgeWorkspace();
  const stateDir = setup(workspace);
  await reconciledExchange(workspace, stateDir);
  const rootState = await rootRouter(workspace);
  const clockFile = path.join(workspace.tmpDir, "reminder-clock");
  fs.writeFileSync(clockFile, "2026-09-24T11:00:00Z");
  const env = routerEnv(workspace, { ROOT_DISCORD_STATE_DIR: rootState,
    CCDM_REMINDER_NODE: process.execPath, CCDM_REMINDER_CLOCK_FILE: clockFile });
  const fixture = readState(workspace.stateDir);
  fixture.fixtures.discord.crashAfterReminderAccept = true;
  writeState(fixture, workspace.stateDir);

  const crashed = await runScript(workspace, "scripts/conversation-reminder-service.py", {
    args: ["run", "--project-root", workspace.repoDir, "--state-dir", stateDir], env, timeoutMs: 5000,
  });
  assert.equal(crashed.exitCode, 2);
  const afterCrash = readState(workspace.stateDir);
  assert.equal(afterCrash.fixtures.discord.messages.length, 1);
  // Identity comes from the nonce replay, not from history.
  afterCrash.fixtures.discord.includeSentInHistory = false;
  writeState(afterCrash, workspace.stateDir);
  const recovered = await command(workspace, stateDir, "recover", { env });
  assert.equal(recovered.recovered, 1);
  assert.equal(readState(workspace.stateDir).fixtures.discord.messages.length, 1);
  assert.equal((await command(workspace, stateDir, "status")).conversations.demo.due_at,
    "2026-09-24T13:00:00Z");
});

test("a crash after receiving the Discord response still reconciles the durable intent", async () => {
  const workspace = createBridgeWorkspace();
  const stateDir = setup(workspace);
  await reconciledExchange(workspace, stateDir);
  const rootState = await rootRouter(workspace);
  const clockFile = path.join(workspace.tmpDir, "reminder-clock");
  fs.writeFileSync(clockFile, "2026-09-24T11:00:00Z");
  const env = routerEnv(workspace, { ROOT_DISCORD_STATE_DIR: rootState,
    CCDM_REMINDER_NODE: process.execPath, CCDM_REMINDER_CLOCK_FILE: clockFile });
  const fixture = readState(workspace.stateDir);
  fixture.fixtures.discord.crashAfterReminderResponseParsed = true;
  writeState(fixture, workspace.stateDir);

  const crashed = await runScript(workspace, "scripts/conversation-reminder-service.py", {
    args: ["run", "--project-root", workspace.repoDir, "--state-dir", stateDir], env, timeoutMs: 5000,
  });
  assert.equal(crashed.exitCode, 2);
  const hidden = readState(workspace.stateDir);
  hidden.fixtures.discord.includeSentInHistory = false;
  writeState(hidden, workspace.stateDir);
  const recovered = await command(workspace, stateDir, "recover", { env });
  assert.equal(recovered.recovered, 1);
  assert.equal(readState(workspace.stateDir).fixtures.discord.messages.length, 1);
  assert.equal((await command(workspace, stateDir, "status")).conversations.demo.due_at,
    "2026-09-24T13:00:00Z");
});

test("closure during a lost send keeps the conversation closed and replays cleanup and acknowledgment", async () => {
  const workspace = createBridgeWorkspace();
  const stateDir = setup(workspace);
  await reconciledExchange(workspace, stateDir);
  const rootState = await rootRouter(workspace);
  const clockFile = path.join(workspace.tmpDir, "reminder-clock");
  fs.writeFileSync(clockFile, "2026-09-24T11:00:00Z");
  const env = routerEnv(workspace, { ROOT_DISCORD_STATE_DIR: rootState,
    CCDM_REMINDER_NODE: process.execPath, CCDM_REMINDER_CLOCK_FILE: clockFile });
  const fixture = readState(workspace.stateDir);
  fixture.fixtures.discord.crashAfterReminderAccept = true;
  writeState(fixture, workspace.stateDir);
  const crashed = await runScript(workspace, "scripts/conversation-reminder-service.py", {
    args: ["run", "--project-root", workspace.repoDir, "--state-dir", stateDir], env, timeoutMs: 5000,
  });
  assert.equal(crashed.exitCode, 2);
  await event(workspace, stateDir, "close_requested", "closed-during-recovery", "2026-09-24T11:00:01Z", {
    actor_id: "owner", source_message_id: "close-after-send", command: "/close",
  });
  const visible = readState(workspace.stateDir);
  visible.fixtures.discord.restFailures = [{ method: "DELETE", status: 503 }];
  writeState(visible, workspace.stateDir);

  const first = await command(workspace, stateDir, "recover", { env });
  assert.equal(first.recovered, 1);
  const pending = await command(workspace, stateDir, "status");
  assert.equal(pending.conversations.demo.state, "closed");
  assert.equal(pending.conversations.demo.due_at, null);
  assert.deepEqual(pending.conversations.demo.cleanup_message_ids, ["fake-message-1"]);
  assert.equal(readState(workspace.stateDir).fixtures.discord.reactions.length, 1);

  const second = await command(workspace, stateDir, "recover", { env });
  assert.equal(second.recovered, 0);
  assert.deepEqual((await command(workspace, stateDir, "status")).conversations.demo.cleanup_message_ids, []);
  const discord = readState(workspace.stateDir).fixtures.discord;
  assert.equal(discord.messages.length, 1);
  assert.equal(discord.messages[0].deleted, true);
  // The original send and one nonce replay, which returned the same reminder.
  assert.equal(discord.reminderRequests.filter(row => row.method === "POST").length, 2);
  assert.equal(readState(workspace.stateDir).fixtures.codex.appServerInvocations.length, 0);
});

test("denied identity lookup leaves an uncertain reminder suspended without another send", async () => {
  const workspace = createBridgeWorkspace();
  const stateDir = setup(workspace);
  await reconciledExchange(workspace, stateDir);
  const rootState = await rootRouter(workspace);
  const clockFile = path.join(workspace.tmpDir, "reminder-clock");
  fs.writeFileSync(clockFile, "2026-09-24T11:00:00Z");
  const env = routerEnv(workspace, { ROOT_DISCORD_STATE_DIR: rootState,
    CCDM_REMINDER_NODE: process.execPath, CCDM_REMINDER_CLOCK_FILE: clockFile });
  const nonce = (await command(workspace, stateDir, "claim", { env })).claim.nonce;
  const refusing = readState(workspace.stateDir);
  refusing.fixtures.discord.restFailures = [{ method: "POST", status: 403 }];
  writeState(refusing, workspace.stateDir);
  const replay = await command(workspace, stateDir, "recover", { env });
  assert.equal(replay.recovered, 0);
  assert.match(replay.unresolved[0].reason, /refused the nonce replay; restore root's channel access/);

  fs.writeFileSync(clockFile, "2026-09-24T11:03:00Z");
  const fixture = readState(workspace.stateDir);
  fixture.fixtures.discord.restFailures = [{ method: "GET", path: "/api/v10/channels/channel/messages",
    status: 403 }];
  writeState(fixture, workspace.stateDir);

  const recovered = await command(workspace, stateDir, "recover", { env });
  assert.equal(recovered.recovered, 0);
  assert.match(recovered.unresolved[0].reason, /lookup denied/);
  assert.equal((await command(workspace, stateDir, "status")).unresolved_intents[0].nonce, nonce);
  assert.equal(readState(workspace.stateDir).fixtures.discord.messages.length, 0);
});

test("operator recovery cannot take over a live foreground worker", async () => {
  const workspace = createBridgeWorkspace();
  const stateDir = setup(workspace);
  await reconciledExchange(workspace, stateDir);
  const rootState = await rootRouter(workspace);
  const clockFile = path.join(workspace.tmpDir, "reminder-clock");
  fs.writeFileSync(clockFile, "2026-09-24T10:59:59Z");
  const env = routerEnv(workspace, { ROOT_DISCORD_STATE_DIR: rootState,
    CCDM_REMINDER_NODE: process.execPath, CCDM_REMINDER_CLOCK_FILE: clockFile });
  const running = runScript(workspace, "scripts/conversation-reminder-service.py", {
    args: ["run", "--project-root", workspace.repoDir, "--state-dir", stateDir], env, timeoutMs: 10000,
  });
  await waitForObserver(workspace, stateDir);
  const refused = await runScript(workspace, "scripts/conversation-reminder-service.py", {
    args: ["recover", "--project-root", workspace.repoDir, "--state-dir", stateDir], env,
  });
  assert.equal(refused.exitCode, 2);
  assert.match(refused.stdout, /already running/);
  assert.equal((await command(workspace, stateDir, "status")).worker_running, true);
  await command(workspace, stateDir, "disable");
  assert.equal((await running).exitCode, 0);
  await command(workspace, stateDir, "enable", { env });
  assert.equal((await command(workspace, stateDir, "recover", { env })).recovered, 0);
  assert.equal(readState(workspace.stateDir).fixtures.discord.messages.length, 0);
});

test("recovery completes cleanup after Discord deleted the prior reminder but the worker crashed", async () => {
  const workspace = createBridgeWorkspace();
  const stateDir = setup(workspace);
  await reconciledExchange(workspace, stateDir);
  const rootState = await rootRouter(workspace);
  const clockFile = path.join(workspace.tmpDir, "reminder-clock");
  fs.writeFileSync(clockFile, "2026-09-24T11:00:00Z");
  const env = routerEnv(workspace, { ROOT_DISCORD_STATE_DIR: rootState,
    CCDM_REMINDER_NODE: process.execPath, CCDM_REMINDER_CLOCK_FILE: clockFile });
  const running = runScript(workspace, "scripts/conversation-reminder-service.py", {
    args: ["run", "--project-root", workspace.repoDir, "--state-dir", stateDir], env, timeoutMs: 7000,
  });
  await waitForConversation(workspace, stateDir, current => current?.reminder_message_id === "fake-message-1");
  const fixture = readState(workspace.stateDir);
  fixture.fixtures.discord.crashAfterReminderDelete = true;
  writeState(fixture, workspace.stateDir);
  fs.writeFileSync(clockFile, "2026-09-24T13:00:00Z");
  const crashed = await running;
  assert.equal(crashed.exitCode, 2);
  assert.deepEqual((await command(workspace, stateDir, "status")).conversations.demo.cleanup_message_ids,
    ["fake-message-1"]);
  assert.equal(readState(workspace.stateDir).fixtures.discord.messages[0].deleted, true);

  const recovered = await command(workspace, stateDir, "recover", { env });
  assert.equal(recovered.recovered, 0);
  const current = (await command(workspace, stateDir, "status")).conversations.demo;
  assert.deepEqual(current.cleanup_message_ids, []);
  assert.equal(current.due_at, "2026-09-24T17:00:00Z");
  const discord = readState(workspace.stateDir).fixtures.discord;
  assert.equal(discord.messages.length, 2);
  assert.deepEqual(discord.deletes.map(row => row.messageId), ["fake-message-1", "fake-message-1"]);
});

test("recovery deletes the prior reminder after a crash following local send confirmation", async () => {
  const workspace = createBridgeWorkspace();
  const stateDir = setup(workspace);
  await reconciledExchange(workspace, stateDir);
  const rootState = await rootRouter(workspace);
  const clockFile = path.join(workspace.tmpDir, "reminder-clock");
  fs.writeFileSync(clockFile, "2026-09-24T11:00:00Z");
  const marker = path.join(workspace.tmpDir, "first-confirmation");
  const wrapper = crashInjector(workspace, "crash-after-confirmation",
    `#!/bin/sh\npython3 "$@"\nresult=$?\nif [ "$result" -eq 0 ] && [ "$2" = result ]; then\n  if [ -f '${marker}' ]; then kill -KILL "$PPID"; else : > '${marker}'; fi\nfi\nexit "$result"\n`,
    "result", marker);
  const env = routerEnv(workspace, { ROOT_DISCORD_STATE_DIR: rootState,
    CCDM_REMINDER_NODE: process.execPath, CCDM_REMINDER_CLOCK_FILE: clockFile,
    CCDM_REMINDER_PYTHON: wrapper });
  const running = runScript(workspace, "scripts/conversation-reminder-service.py", {
    args: ["run", "--project-root", workspace.repoDir, "--state-dir", stateDir], env, timeoutMs: 7000,
  });
  await waitForConversation(workspace, stateDir, current => current?.reminder_message_id === "fake-message-1");
  fs.writeFileSync(clockFile, "2026-09-24T13:00:00Z");
  assert.equal((await running).exitCode, 2);
  const pending = (await command(workspace, stateDir, "status")).conversations.demo;
  assert.deepEqual(pending.cleanup_message_ids, ["fake-message-1"]);
  assert.equal(pending.due_at, "2026-09-24T17:00:00Z");
  assert.equal(readState(workspace.stateDir).fixtures.discord.deletes?.length || 0, 0);

  const cleanEnv = routerEnv(workspace, { ROOT_DISCORD_STATE_DIR: rootState,
    CCDM_REMINDER_NODE: process.execPath, CCDM_REMINDER_CLOCK_FILE: clockFile });
  assert.equal((await command(workspace, stateDir, "recover", { env: cleanEnv })).recovered, 0);
  assert.deepEqual((await command(workspace, stateDir, "status")).conversations.demo.cleanup_message_ids, []);
  assert.equal(readState(workspace.stateDir).fixtures.discord.messages.length, 2);
});

test("a crash after durable claim but before the Discord request is released without resending during recovery", async () => {
  const workspace = createBridgeWorkspace();
  const stateDir = setup(workspace);
  await reconciledExchange(workspace, stateDir);
  const rootState = await rootRouter(workspace);
  const clockFile = path.join(workspace.tmpDir, "reminder-clock");
  fs.writeFileSync(clockFile, "2026-09-24T11:00:00Z");
  const wrapper = crashInjector(workspace, "crash-after-claim",
    "#!/bin/sh\npython3 \"$@\"\nresult=$?\nif [ \"$result\" -eq 0 ] && [ \"$2\" = validate ]; then kill -KILL \"$PPID\"; fi\nexit \"$result\"\n",
    "validate");
  const env = routerEnv(workspace, { ROOT_DISCORD_STATE_DIR: rootState,
    CCDM_REMINDER_NODE: process.execPath, CCDM_REMINDER_CLOCK_FILE: clockFile,
    CCDM_REMINDER_PYTHON: wrapper });
  const crashed = await runScript(workspace, "scripts/conversation-reminder-service.py", {
    args: ["run", "--project-root", workspace.repoDir, "--state-dir", stateDir], env, timeoutMs: 5000,
  });
  assert.equal(crashed.exitCode, 2);
  assert.equal(readState(workspace.stateDir).fixtures.discord.messages.length, 0);

  fs.writeFileSync(clockFile, "2026-09-24T12:10:00Z");
  const cleanEnv = routerEnv(workspace, { ROOT_DISCORD_STATE_DIR: rootState,
    CCDM_REMINDER_NODE: process.execPath, CCDM_REMINDER_CLOCK_FILE: clockFile });
  const recovered = await command(workspace, stateDir, "recover", { env: cleanEnv });
  assert.deepEqual([recovered.recovered, recovered.released, recovered.unresolved.length], [0, 1, 0]);
  assert.equal(readState(workspace.stateDir).fixtures.discord.messages.length, 0);
  // History must still be reconciled before the channel sends again.
  assert.equal((await command(workspace, stateDir, "status")).conversations.demo.reconciliation_status,
    "suspended-restart-reconciliation");
});

test("a restarted worker reconciles history before a previously ready channel sends again", async () => {
  const workspace = createBridgeWorkspace();
  const stateDir = setup(workspace);
  await reconciledExchange(workspace, stateDir);
  const rootState = await rootRouter(workspace);
  const clockFile = path.join(workspace.tmpDir, "reminder-clock");
  fs.writeFileSync(clockFile, "2026-09-24T11:00:00Z");
  const env = routerEnv(workspace, { ROOT_DISCORD_STATE_DIR: rootState,
    CCDM_REMINDER_NODE: process.execPath, CCDM_REMINDER_CLOCK_FILE: clockFile });
  const args = ["run", "--project-root", workspace.repoDir, "--state-dir", stateDir];
  const first = runScript(workspace, "scripts/conversation-reminder-service.py", { args, env, timeoutMs: 10000 });
  await waitForConversation(workspace, stateDir, current => current?.reminder_message_id === "fake-message-1");
  await command(workspace, stateDir, "disable");
  assert.equal((await first).exitCode, 0);
  const enabled = await command(workspace, stateDir, "enable", { env });
  assert.equal(enabled.conversations.demo.reconciliation_status, "suspended-restart-reconciliation");
  assert.equal(readState(workspace.stateDir).fixtures.discord.fetches?.length ?? 0, 0);
  fs.writeFileSync(clockFile, "2026-09-24T13:00:00Z");
  const second = runScript(workspace, "scripts/conversation-reminder-service.py", { args, env, timeoutMs: 10000 });
  const sent = await waitForState(workspace, state => state.fixtures.discord.messages.length === 2);
  assert.ok(sent.fixtures.discord.fetches.some(row => row.channelId === "channel" &&
    row.authorization === "Bot fixture-root-token"), "history is read before the channel is released");
  const released = await waitForConversation(workspace, stateDir, current =>
    current?.due_at === "2026-09-24T17:00:00Z");
  assert.deepEqual([released.conversations.demo.discovery.mode, released.conversations.demo.discovery.basis],
    ["restart", "no-missed-activity"]);
  await new Promise(resolve => setTimeout(resolve, 600));
  assert.equal(readState(workspace.stateDir).fixtures.discord.messages.length, 2);
  await command(workspace, stateDir, "disable");
  assert.equal((await second).exitCode, 0);
});
