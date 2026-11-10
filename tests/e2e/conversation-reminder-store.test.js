import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { PYTHON, assertPrivate, platformGate } from "./support/platform.js";
import { runScript } from "./support/runner.js";
import { createBridgeWorkspace } from "./support/bridge.js";
import { routerEnv, waitFor } from "./support/router.js";
import { readState, writeState } from "./support/state.js";
import { cleanup, registerTeardownCallback } from "./support/teardown.js";
import {
  ICACLS, OBSERVER_SCRIPT, SERVICE_SCRIPT, V8_CONVERSATION, V8_RETIRED, alive, backups, claimAt, cli, command,
  downgradeToV7, event, freshCompletion, observerEnv, observerReady, observerWorkspace, pythonProbe,
  reconciledExchange, rootRouter, seedV6, sendAt, setup, sql, startObserverDriver, storeRows, streak,
  waitForObserver,
} from "./support/reminder-service.js";

test.afterEach(async () => cleanup());

const windowsOnly = platformGate("win32", "Windows access lists and scheduled tasks; POSIX modes and the plist are checked elsewhere");

test("the worker reads a ledger with no events table as empty, and still surfaces other database errors", async () => {
  const workspace = createBridgeWorkspace();
  const script = path.join(workspace.repoDir, "scripts", "conversation-reminder-service.py");
  const stateDir = path.join(workspace.tmpDir, "missing-table-state");
  const probe = spawnSync(PYTHON, ["-c", `import importlib.util,json,sqlite3,sys
from pathlib import Path
spec=importlib.util.spec_from_file_location("service", sys.argv[1]); service=importlib.util.module_from_spec(spec)
spec.loader.exec_module(service)
service.is_private=lambda path: True
state=Path(sys.argv[2]); state.mkdir()
path=service.EVENTS.database_path(state); path.parent.mkdir(parents=True,exist_ok=True)
def read():
    return [len(service.event_rows(state)), len(service.rows_matching(state,"p","g","1=1"))]
def error(reader):
    try:
        reader(); return None
    except sqlite3.OperationalError as caught:
        return str(caught)
db=sqlite3.connect(path); db.execute("CREATE TABLE other (id INTEGER)"); db.commit(); db.close()
empty=read()
db=sqlite3.connect(path); db.execute("CREATE TABLE events (id INTEGER)"); db.commit(); db.close()
print(json.dumps([empty, error(lambda: service.event_rows(state)), error(lambda: service.rows_matching(state,"p","g","1=1"))]))`,
  script, stateDir], { encoding: "utf8" });
  assert.equal(probe.status, 0, probe.stderr);
  const [empty, eventRowsError, rowsMatchingError] = JSON.parse(probe.stdout);
  assert.deepEqual(empty, [0, 0]);
  assert.match(eventRowsError, /no such column/);
  assert.match(rowsMatchingError, /no such column/);
});

test("a status read waits for the first event's table, and a ledger that never gets one stays unavailable", async () => {
  const workspace = createBridgeWorkspace();
  const result = await pythonProbe(workspace, "first-event-window.py", [
    "import importlib.util, os, threading, time",
    "from pathlib import Path",
    "spec = importlib.util.spec_from_file_location('events', sys.argv[2])",
    "events = importlib.util.module_from_spec(spec); spec.loader.exec_module(events)",
    "state = Path(sys.argv[3]); events.private_directory(state)",
    // The moment after the first event has created the file and before it has created the table.
    "os.close(os.open(events.database_path(state), os.O_WRONLY | os.O_CREAT, 0o600))",
    "started = time.monotonic()",
    "never = events.status_for(state, 'demo')",
    "waited = time.monotonic() - started",
    "def first_event():",
    "    time.sleep(0.4)",
    "    events.connect_database(state, create=True).close()",
    "writer = threading.Thread(target=first_event); writer.start()",
    "arrived = events.status_for(state, 'demo')",
    "writer.join()",
    "print(json.dumps({'never': never, 'waited': waited, 'limit': events.SCHEMA_WAIT_SECONDS, 'arrived': arrived}))",
  ], [path.join(workspace.repoDir, "scripts", "conversation-reminder-events.py"),
    path.join(workspace.tmpDir, "first-event-state")]);
  // With no writer the read gives up after its wait, with the answer it always gave.
  assert.deepEqual([result.never.available, result.never.reason],
    [false, "event database is unavailable or unsupported"]);
  assert.ok(result.waited >= result.limit, `waited ${result.waited} s`);
  // With a writer the read can only answer once the table exists: no table, no event count.
  assert.deepEqual([result.arrived.available, result.arrived.event_count, result.arrived.events],
    [true, 0, []]);
});

test("the reminder gap follows 1h, then 2h per ignored reminder, capped at 24h", async () => {
  const workspace = createBridgeWorkspace();
  const script = path.join(workspace.repoDir, "scripts", "conversation-reminder-service.py");
  const probe = spawnSync(PYTHON, ["-c", `import importlib.util,json,sys
spec=importlib.util.spec_from_file_location("service", sys.argv[1]); service=importlib.util.module_from_spec(spec)
spec.loader.exec_module(service)
print(json.dumps([service.reminder_gap(k).total_seconds() / 3600 for k in [*range(16), 1000]]))`, script],
  { encoding: "utf8" });
  assert.equal(probe.status, 0, probe.stderr);
  assert.deepEqual(JSON.parse(probe.stdout),
    [1, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 24, 24, 24, 24]);
});

test("a long ignored streak settles on one reminder a day", async () => {
  const workspace = createBridgeWorkspace();
  const stateDir = setup(workspace);
  await reconciledExchange(workspace, stateDir);
  sql(path.join(stateDir, "conversations.sqlite3"),
    "UPDATE conversations SET consecutive_reminders=11 WHERE project='demo'");
  const clockFile = path.join(workspace.tmpDir, "reminder-clock");
  assert.deepEqual(streak(await sendAt(workspace, stateDir, clockFile, "2026-09-24T11:00:00Z", "r-12")),
    ["awaiting-owner", "2026-09-25T11:00:00Z", 12]);
  assert.equal(await claimAt(workspace, stateDir, clockFile, "2026-09-25T10:59:59Z"), null);
  assert.deepEqual(streak(await sendAt(workspace, stateDir, clockFile, "2026-09-25T11:00:00Z", "r-13")),
    ["awaiting-owner", "2026-09-26T11:00:00Z", 13]);
});

test("an owner reply ends the ignored streak, so the next response starts again at one hour", async () => {
  const workspace = createBridgeWorkspace();
  const stateDir = setup(workspace);
  await reconciledExchange(workspace, stateDir);
  const clockFile = path.join(workspace.tmpDir, "reminder-clock");
  await sendAt(workspace, stateDir, clockFile, "2026-09-24T11:00:00Z", "r-1");
  assert.deepEqual(streak(await sendAt(workspace, stateDir, clockFile, "2026-09-24T13:00:00Z", "r-2")),
    ["awaiting-owner", "2026-09-24T17:00:00Z", 2]);
  await event(workspace, stateDir, "owner_activity", "reply-owner", "2026-09-24T14:00:00Z", {
    actor_id: "owner", source_message_id: "reply-question", activity_kind: "message",
  });
  await cli(workspace, stateDir, "sync");
  const paused = (await cli(workspace, stateDir, "status")).conversations.demo;
  assert.deepEqual([...streak(paused), paused.reminder_message_id], ["open-paused", null, 0, null]);
  assert.ok(paused.cleanup_message_ids.includes("r-2"), "the ignored reminder is queued for deletion");
  assert.deepEqual(streak(await freshCompletion(workspace, stateDir, "turn-2", "reply-question", "2026-09-24T15:00:00Z")),
    ["awaiting-owner", "2026-09-24T16:00:00Z", 0]);
  assert.deepEqual(streak(await sendAt(workspace, stateDir, clockFile, "2026-09-24T16:00:00Z", "r-3")),
    ["awaiting-owner", "2026-09-24T18:00:00Z", 1]);
});

test("a fresh qualifying response while awaiting the owner resets the streak to one hour", async () => {
  const workspace = createBridgeWorkspace();
  const stateDir = setup(workspace);
  await reconciledExchange(workspace, stateDir);
  const clockFile = path.join(workspace.tmpDir, "reminder-clock");
  await sendAt(workspace, stateDir, clockFile, "2026-09-24T11:00:00Z", "r-1");
  await sendAt(workspace, stateDir, clockFile, "2026-09-24T13:00:00Z", "r-2");
  const rearmed = await freshCompletion(workspace, stateDir, "turn-2", "delivery-question", "2026-09-24T14:00:00Z");
  assert.deepEqual([...streak(rearmed), rearmed.reminder_message_id],
    ["awaiting-owner", "2026-09-24T15:00:00Z", 0, "r-2"]);
  assert.equal(await claimAt(workspace, stateDir, clockFile, "2026-09-24T14:59:59Z"), null);
  assert.deepEqual(streak(await sendAt(workspace, stateDir, clockFile, "2026-09-24T15:00:00Z", "r-3")),
    ["awaiting-owner", "2026-09-24T17:00:00Z", 1]);
});

test("closing and reopening a conversation starts its next streak at one hour", async () => {
  const workspace = createBridgeWorkspace();
  const stateDir = setup(workspace);
  await reconciledExchange(workspace, stateDir);
  const clockFile = path.join(workspace.tmpDir, "reminder-clock");
  await sendAt(workspace, stateDir, clockFile, "2026-09-24T11:00:00Z", "r-1");
  await sendAt(workspace, stateDir, clockFile, "2026-09-24T13:00:00Z", "r-2");
  await event(workspace, stateDir, "close_requested", "streak-close", "2026-09-24T14:00:00Z", {
    actor_id: "owner", source_message_id: "streak-close-message", command: "/close",
  });
  await cli(workspace, stateDir, "sync");
  assert.deepEqual(streak((await cli(workspace, stateDir, "status")).conversations.demo), ["closed", null, 0]);
  await event(workspace, stateDir, "owner_activity", "reopen-owner", "2026-09-24T15:00:00Z", {
    actor_id: "owner", source_message_id: "reopen-question", activity_kind: "message",
  });
  assert.deepEqual(streak(await freshCompletion(workspace, stateDir, "turn-2", "reopen-question", "2026-09-24T16:00:00Z")),
    ["awaiting-owner", "2026-09-24T17:00:00Z", 0]);
  assert.deepEqual(streak(await sendAt(workspace, stateDir, clockFile, "2026-09-24T17:00:00Z", "r-3")),
    ["awaiting-owner", "2026-09-24T19:00:00Z", 1]);
});

test("a canceled send and a late send after reassignment never grow the streak", async () => {
  const workspace = createBridgeWorkspace();
  const stateDir = setup(workspace);
  await reconciledExchange(workspace, stateDir);
  const clockFile = path.join(workspace.tmpDir, "reminder-clock");
  const env = { CCDM_REMINDER_CLOCK_FILE: clockFile };
  await sendAt(workspace, stateDir, clockFile, "2026-09-24T11:00:00Z", "r-1");
  // A fresh response lands after the claim: the returned reminder is canceled.
  const canceledClaim = await claimAt(workspace, stateDir, clockFile, "2026-09-24T13:00:00Z");
  await freshCompletion(workspace, stateDir, "turn-2", "delivery-question", "2026-09-24T13:00:30Z");
  await cli(workspace, stateDir, "result", ["--nonce", canceledClaim.nonce, "--outcome", "sent",
    "--message-id", "r-canceled", "--sent-at", "2026-09-24T13:00:00Z"], env);
  const canceled = (await cli(workspace, stateDir, "status")).conversations.demo;
  assert.deepEqual([...streak(canceled), canceled.reminder_message_id],
    ["awaiting-owner", "2026-09-24T14:00:30Z", 0, "r-1"]);
  assert.deepEqual(canceled.cleanup_message_ids, ["r-canceled"]);

  // The assignment changes while the next request is in flight: the late send
  // belongs to the retired generation and the new conversation starts at zero.
  const lateClaim = await claimAt(workspace, stateDir, clockFile, "2026-09-24T14:00:30Z");
  assert.ok(lateClaim?.nonce);
  const registryPath = path.join(workspace.repoDir, "registry.json");
  const registry = JSON.parse(fs.readFileSync(registryPath, "utf8"));
  registry.projects.demo.assignment_generation = "generation-2";
  fs.writeFileSync(registryPath, JSON.stringify(registry), { mode: 0o600 });
  await cli(workspace, stateDir, "result", ["--nonce", lateClaim.nonce, "--outcome", "sent",
    "--message-id", "r-late", "--sent-at", "2026-09-24T14:00:30Z"], env);
  const replaced = (await cli(workspace, stateDir, "status")).conversations.demo;
  assert.deepEqual([replaced.assignment_generation, replaced.consecutive_reminders, replaced.reminder_message_id],
    ["generation-2", 0, null]);
});

test("a v5 store upgrades to v8, keeping a recorded reminder's pending due time", async () => {
  const downgrade = `ALTER TABLE conversations DROP COLUMN consecutive_reminders;
    ALTER TABLE conversations RENAME COLUMN identity TO bot_id; UPDATE conversations SET bot_id='bot';
    ALTER TABLE retired_assignments RENAME COLUMN identity TO bot_id; PRAGMA user_version=5;`;
  const withReminder = createBridgeWorkspace();
  const stateDir = setup(withReminder);
  await reconciledExchange(withReminder, stateDir);
  const clockFile = path.join(withReminder.tmpDir, "reminder-clock");
  await sendAt(withReminder, stateDir, clockFile, "2026-09-24T11:00:00Z", "r-1");
  const database = path.join(stateDir, "conversations.sqlite3");
  downgradeToV7(database);
  sql(database, downgrade);
  const upgraded = (await cli(withReminder, stateDir, "status")).conversations.demo;
  assert.deepEqual([...streak(upgraded), upgraded.reminder_message_id],
    ["awaiting-owner", "2026-09-24T13:00:00Z", 1, "r-1"]);
  const version = spawnSync(PYTHON, ["-c", "import sqlite3,sys; print(sqlite3.connect(sys.argv[1]).execute('PRAGMA user_version').fetchone()[0])", database], { encoding: "utf8" });
  assert.equal(version.stdout.trim(), "8");
  // Every v5 assignment was a pool bot, so the row stays readable as history,
  // but the Router's webhook now speaks for demo: nothing sends until the
  // operator records the assignment change.
  assert.equal(upgraded.identity, "pool:bot");
  assert.equal(await claimAt(withReminder, stateDir, clockFile, "2026-09-24T13:00:00Z"), null);
  assert.match((await cli(withReminder, stateDir, "status")).readiness.projects.demo.blockers.join("\n"),
    /transport changed; run assignment-changed --project demo/);

  const withoutReminder = createBridgeWorkspace();
  const otherDir = setup(withoutReminder);
  await reconciledExchange(withoutReminder, otherDir);
  downgradeToV7(path.join(otherDir, "conversations.sqlite3"));
  sql(path.join(otherDir, "conversations.sqlite3"), downgrade);
  assert.deepEqual(streak((await cli(withoutReminder, otherDir, "status")).conversations.demo),
    ["awaiting-owner", "2026-09-24T11:00:00Z", 0]);
});

test("a fresh store is created at v8, and a v8 store without the streak or a future version fails closed", async () => {
  const workspace = createBridgeWorkspace();
  const stateDir = setup(workspace);
  await cli(workspace, stateDir, "sync");
  const database = path.join(stateDir, "conversations.sqlite3");
  const shape = spawnSync(PYTHON, ["-c", `import json,sqlite3,sys
db=sqlite3.connect(sys.argv[1])
print(json.dumps([db.execute('PRAGMA user_version').fetchone()[0],
  'consecutive_reminders' in [row[1] for row in db.execute('PRAGMA table_info(conversations)')]]))`, database],
  { encoding: "utf8" });
  assert.deepEqual(JSON.parse(shape.stdout), [8, true]);
  for (const script of ["PRAGMA user_version=9;",
    "ALTER TABLE conversations DROP COLUMN consecutive_reminders;"]) {
    const copy = createBridgeWorkspace();
    const copyDir = setup(copy);
    await cli(copy, copyDir, "sync");
    sql(path.join(copyDir, "conversations.sqlite3"), script);
    const result = await runScript(copy, "scripts/conversation-reminder-service.py", {
      args: ["status", "--project-root", copy.repoDir, "--state-dir", copyDir],
    });
    assert.equal(result.exitCode, 2, script);
    assert.deepEqual(JSON.parse(result.stdout),
      { status: "blocked", reason: "conversation store schema is unsupported" }, script);
  }
});

test("a v6 store migrates to v8, keying conversations and retired assignments by pool identity", async () => {
  const workspace = createBridgeWorkspace();
  const { stateDir, database } = seedV6(workspace);
  const status = await cli(workspace, stateDir, "status");
  assert.equal(status.conversations.demo.identity, "pool:bot");
  assert.equal(status.conversations.demo.consecutive_reminders, 2);
  assert.equal(status.retired_assignments[0].identity, "pool:old-bot");
  assert.deepEqual(storeRows(database),
    { version: 8, conversations: [V8_CONVERSATION], retired_assignments: [V8_RETIRED] });

  // The pre-migration store is kept privately beside the migrated one.
  assert.deepEqual(backups(stateDir), ["conversations.v6.backup.sqlite3"]);
  const backup = path.join(stateDir, "conversations.v6.backup.sqlite3");
  assertPrivate(backup);
  const original = storeRows(backup);
  assert.equal(original.version, 6);
  assert.deepEqual(original.conversations[0].bot_id, "bot");
  assert.deepEqual(original.retired_assignments[0].bot_id, "old-bot");

  // The retired assignment's cleanup still names its former pool bot as
  // history; root deletes that reminder with its own token.
  const actions = await cli(workspace, stateDir, "actions");
  assert.deepEqual(actions.actions.map(a => [a.message_id, a.channel_id, a.bot_id, a.retired]),
    [["r-old", "old-channel", "old-bot", true]]);

  // Re-running on the v8 store changes nothing and takes no second backup.
  await cli(workspace, stateDir, "status");
  assert.deepEqual(storeRows(database),
    { version: 8, conversations: [V8_CONVERSATION], retired_assignments: [V8_RETIRED] });
  assert.deepEqual(backups(stateDir), ["conversations.v6.backup.sqlite3"]);
});

test("a failed v7 migration leaves the v6 store usable", async () => {
  const workspace = createBridgeWorkspace();
  const { stateDir, database } = seedV6(workspace);
  // An injected failure aborts the identity rewrite partway through.
  sql(database, `CREATE TRIGGER fail_migration BEFORE UPDATE ON retired_assignments
    BEGIN SELECT RAISE(ABORT, 'injected migration failure'); END;`);
  const failed = await runScript(workspace, "scripts/conversation-reminder-service.py", {
    args: ["status", "--project-root", workspace.repoDir, "--state-dir", stateDir],
  });
  assert.notEqual(failed.exitCode, 0);
  const untouched = storeRows(database);
  assert.equal(untouched.version, 6);
  assert.equal(untouched.conversations[0].bot_id, "bot");
  assert.equal(untouched.retired_assignments[0].bot_id, "old-bot");
  assert.deepEqual(backups(stateDir), ["conversations.v6.backup.sqlite3"]);

  sql(database, "DROP TRIGGER fail_migration;");
  await cli(workspace, stateDir, "status");
  assert.deepEqual(storeRows(database),
    { version: 8, conversations: [V8_CONVERSATION], retired_assignments: [V8_RETIRED] });
});

test("the worker stops its observer by closing its stdin: it exits 0 well inside 15 s and no observer remains", async () => {
  const { workspace, stateDir, rootState } = await observerWorkspace();
  const driver = await startObserverDriver(workspace, stateDir, rootState);
  driver.child.stdin.write("stop\n");
  const stopped = await waitFor(() => driver.lines()[1], () => "the observer to stop", 40000);
  assert.equal(stopped.code, 0);
  assert.ok(stopped.seconds < 15, `the stop took ${stopped.seconds} s`);
  assert.equal(alive(driver.pid), false, "the observer is still running");
  assert.equal(await driver.exited, 0);
});

test("an observer whose worker is killed sees its stdin close and exits by itself", async () => {
  const { workspace, stateDir, rootState } = await observerWorkspace();
  const driver = await startObserverDriver(workspace, stateDir, rootState);
  driver.child.kill("SIGKILL");
  await driver.exited;
  await waitFor(() => !alive(driver.pid), () => "the orphaned observer to exit", 15000);
});

// An observer started the old way has no stop flag: its stdin is nothing, or a
// pipe that has already ended, and neither may stop it.
for (const [name, stdin] of [["no stdin", "ignore"], ["an ended stdin pipe", "pipe"]]) {
  test(`an observer started without the stop flag keeps observing with ${name}, and SIGTERM still stops it`, async () => {
    const { workspace, stateDir, rootState } = await observerWorkspace();
    const child = spawn(process.execPath, [path.join(workspace.repoDir, OBSERVER_SCRIPT),
      "--project-root", workspace.repoDir, "--state-dir", stateDir], {
      cwd: workspace.repoDir, env: observerEnv(workspace, stateDir, rootState), stdio: [stdin, "ignore", "pipe"],
      windowsHide: true,
    });
    child.stdin?.end();
    child.stderr.resume();
    const exited = new Promise(resolve => child.once("exit", (code, signal) => resolve({ code, signal })));
    registerTeardownCallback(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited;
    });
    // It reaches the channel after its stdin ended, and stays.
    await observerReady(stateDir);
    await new Promise(resolve => setTimeout(resolve, 1000));
    assert.deepEqual([child.exitCode, child.signalCode], [null, null]);
    child.kill("SIGTERM");
    const stopped = await exited;
    // A caught SIGTERM is a clean exit; on Windows the same call is a hard kill.
    if (process.platform !== "win32") assert.deepEqual(stopped, { code: 0, signal: null });
  });
}

test("on Windows the events, store and health files are private in a protected state dir and refused in an inherited one", windowsOnly, async () => {
  const workspace = createBridgeWorkspace();
  const stateDir = setup(workspace);
  await reconciledExchange(workspace, stateDir);
  const rootState = await rootRouter(workspace);
  const running = runScript(workspace, SERVICE_SCRIPT, {
    args: ["run", "--project-root", workspace.repoDir, "--state-dir", stateDir],
    env: routerEnv(workspace, { ROOT_DISCORD_STATE_DIR: rootState, CCDM_REMINDER_NODE: process.execPath }),
    timeoutMs: 60000,
  });
  // status reads the observer's health file, and accepts it.
  await waitForObserver(workspace, stateDir);
  await command(workspace, stateDir, "disable");
  assert.equal((await running).exitCode, 0);

  const files = ["events.sqlite3", "conversations.sqlite3", "observer-health.json"];
  const isPrivate = () => pythonProbe(workspace, "privacy-probe.py", [
    "import os",
    "from ccdmlib.platform.private_fs import is_private",
    "print(json.dumps({name: is_private(os.path.join(sys.argv[2], name)) for name in sys.argv[3:]}))",
  ], [stateDir, ...files]);
  assertPrivate(stateDir);
  for (const name of files) assertPrivate(path.join(stateDir, name), name);
  assert.deepEqual(await isPrivate(), Object.fromEntries(files.map(name => [name, true])));

  // The directory takes its parent's permissions again: nothing in it is trusted.
  const inherited = spawnSync(ICACLS, [stateDir, "/inheritance:e"], { encoding: "utf8", windowsHide: true });
  assert.equal(inherited.status, 0, inherited.stdout + inherited.stderr);
  assert.deepEqual(await isPrivate(), Object.fromEntries(files.map(name => [name, false])));
  const refused = await runScript(workspace, SERVICE_SCRIPT, {
    args: ["status", "--project-root", workspace.repoDir, "--state-dir", stateDir],
  });
  assert.equal(refused.exitCode, 2, refused.stdout);
  assert.match(JSON.parse(refused.stdout).reason, /permissions are not private/);
  const events = await runScript(workspace, "scripts/conversation-reminder-events.py", {
    args: ["status", "--project", "demo", "--state-dir", stateDir],
  });
  assert.deepEqual([JSON.parse(events.stdout).available, JSON.parse(events.stdout).reason],
    [false, "event database permissions are not private"]);
});

test("service_installed asks schtasks for a service's task under both of its names", windowsOnly, async () => {
  const workspace = createBridgeWorkspace();
  const installed = name => pythonProbe(workspace, "service-installed.py", [
    "from ccdmlib.platform.services import service_installed",
    "try:",
    "    print(json.dumps(service_installed(sys.argv[2])))",
    "except ValueError as error:",
    "    print(json.dumps(str(error)))",
  ], [name]);
  const fixture = () => readState(workspace.stateDir).fixtures.schtasks;
  const setTasks = tasks => {
    const state = readState(workspace.stateDir);
    state.fixtures.schtasks.tasks = tasks;
    state.fixtures.schtasks.invocations = [];
    writeState(state, workspace.stateDir);
  };
  const folder = String.raw`\CCDM\ThreadSupervisor`;

  // No task: both names are asked, with a query and nothing else.
  assert.equal(await installed("thread-supervisor"), false);
  assert.deepEqual(fixture().invocations.map(({ name, verb }) => [verb, name]),
    [["/query", folder], ["/query", "CCDM-ThreadSupervisor"]]);
  for (const task of [folder, "CCDM-ThreadSupervisor"]) {
    setTasks([task]);
    assert.equal(await installed("thread-supervisor"), true, task);
  }
  // Another service's task is not this one's.
  setTasks([String.raw`\CCDM\Router`]);
  assert.equal(await installed("thread-supervisor"), false);
  assert.equal(await installed("router"), true);
  assert.equal(await installed("no-such-service"), "unknown service: no-such-service");
});
