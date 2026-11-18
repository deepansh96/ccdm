import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { injectDiscordMessage, startFakeCodexServer } from "./support/bridge.js";
import { OWNER_ID, createRouterWorkspace, routerRegistry, routerWithWebhooks, runRouterCli,
  waitFor } from "./support/router.js";
import { PYTHON, platformGate } from "./support/platform.js";
import { callSeam, hostOps, tmuxCalls } from "./support/session-fixture.js";
import { readState, updateState } from "./support/state.js";
import { cleanup, registerTeardownCallback } from "./support/teardown.js";
import { startThreadSupervisor, supervisorEnv, supervisorStateDir, supervisorStatus, waitForThreadIdle } from "./support/thread-supervisor.js";

test.afterEach(cleanup);

// The Thread Conversation lifecycle end to end: archive, unarchive, delete and
// resume, through the real Router, Thread Supervisor, start-thread-session.sh
// and CCDM channel server, with the fixture claude and tmux. Only Discord
// thread events, messages and the fake audit log go in. A thread stays
// unarchived until `/close`: any other archive is reverted.
const THREAD_ID = "1700000000000223344";
// `<screen>-t-<thread id>`.
const THREAD_TMUX = `demo_claude-t-${THREAD_ID}`;
const BOT_USER_ID = "fixture-bot-user-id";
const THREAD = { id: THREAD_ID, type: 11, parentId: "demo-channel", name: "Fix flaky test", ownerId: OWNER_ID,
  autoArchiveDuration: 10080 };
// The supervisor environment the tests run with.
const SUPERVISOR_ENV = {};

function threadWorkspace() {
  const workspace = createRouterWorkspace({ ...routerRegistry({
    demo: { channel_id: "demo-channel", type: "claude", transport: "router", guest_user_ids: ["guest-id"],
      screen_name: "demo_claude" },
  }), root_channels: ["root-channel"] });
  const registryFile = path.join(workspace.repoDir, "registry.json");
  const registry = JSON.parse(fs.readFileSync(registryFile, "utf8"));
  registry.projects.demo.path = workspace.tmpDir;
  fs.writeFileSync(registryFile, `${JSON.stringify(registry, null, 2)}\n`);
  return workspace;
}

async function supervised(workspace, env = SUPERVISOR_ENV) {
  await routerWithWebhooks(workspace, ["demo"]);
  updateState(workspace.stateDir, state => {
    state.fixtures.claude.replyText = "on it";
  });
  return startThreadSupervisor(workspace, { env });
}

function threadEvent(workspace, event, fields = {}) {
  updateState(workspace.stateDir, state => {
    (state.fixtures.discord.injectedThreads ||= []).push({ ...THREAD, event, ...fields });
  });
}

const archive = workspace => threadEvent(workspace, "update", { archived: true,
  previous: { ...THREAD, archived: false } });
const unarchive = workspace => threadEvent(workspace, "update", { archived: false,
  previous: { ...THREAD, archived: true } });

// A Discord snowflake for now: milliseconds since the Discord epoch, shifted 22 bits.
const snowflakeNow = () => String((BigInt(Date.now()) - 1420070400000n) << 22n);

function seedArchiveEntry(workspace, userId, changes = [{ key: "archived", old_value: false, new_value: true }]) {
  updateState(workspace.stateDir, state => {
    (state.fixtures.discord.auditLogEntries ||= []).unshift({ id: snowflakeNow(), user_id: userId,
      target_id: THREAD_ID, action_type: 111, changes });
  });
}

function threadMessage(workspace, id, content, author = { id: OWNER_ID, username: "Owner" }) {
  injectDiscordMessage(workspace, { id, channelId: THREAD_ID, content, author });
}

async function threadRow(workspace, predicate = () => true, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await supervisorStatus(workspace);
    const row = last.projects?.demo?.threads?.[THREAD_ID];
    if (row && predicate(row)) return row;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`thread ${THREAD_ID} never matched: ${JSON.stringify(last)}`);
}

const discord = workspace => readState(workspace.stateDir).fixtures.discord;
const claude = workspace => readState(workspace.stateDir).fixtures.claude;
const threadPosts = workspace => (discord(workspace).messages ?? []).filter(message => message.channelId === THREAD_ID);
const threadConnected = async workspace =>
  new RegExp(`thread demo thread=${THREAD_ID} `).test((await runRouterCli(workspace, ["status"])).stdout);

async function liveThread(workspace) {
  threadEvent(workspace, "create");
  await threadRow(workspace);
  threadMessage(workspace, "boot-message-1", "please fix the parser");
  await threadRow(workspace, row => row.state === "live" && row.provider_conversation_id != null);
  await waitFor(() => threadPosts(workspace).length === 1, () => "the bootstrap reply", 15000);
}

async function assertStopped(workspace) {
  await waitFor(() => readState(workspace.stateDir).fixtures.tmux.sessions[THREAD_TMUX] === undefined,
    () => "the thread's tmux session to stop", 15000);
  const deadline = Date.now() + 15000;
  while (await threadConnected(workspace)) {
    if (Date.now() > deadline) throw new Error("the thread session never disconnected from the Router");
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

// Root's PATCHes of the thread's `archived`, in order.
const archivePatches = workspace => (discord(workspace).threadPatches ?? [])
  .filter(patch => patch.threadId === THREAD_ID && patch.body.archived !== undefined)
  .map(({ authorization, body }) => [authorization, body.archived]);
const ROOT_AUTH = "Bot root-bot-token";
const idle = workspace => waitForThreadIdle(workspace, "demo", THREAD_ID);

test("an auto-archive of an idle thread is reverted at once and stops its session, leaving the conversation open", async () => {
  const workspace = threadWorkspace();
  await supervised(workspace);
  await liveThread(workspace);
  await idle(workspace);

  archive(workspace);

  await assertStopped(workspace);
  await waitFor(() => archivePatches(workspace).length === 1, () => "the unarchive");
  assert.deepEqual(archivePatches(workspace), [[ROOT_AUTH, false]]);
  assert.equal(discord(workspace).threads[THREAD_ID].archived, false);
  const row = await threadRow(workspace, current => current.state === "stopped");
  assert.deepEqual([row.state, row.stop_reason, row.close_reason], ["stopped", "auto-archive", null]);
  // One audit-log read names the actor in the log; nothing is polled.
  await new Promise(resolve => setTimeout(resolve, 1000));
  assert.equal((discord(workspace).auditLogFetches ?? []).length, 1);
});

test("an owner's archive by hand is reverted too and never closes the conversation", async () => {
  const workspace = threadWorkspace();
  await supervised(workspace);
  await liveThread(workspace);
  await idle(workspace);

  seedArchiveEntry(workspace, OWNER_ID);
  archive(workspace);

  await assertStopped(workspace);
  await waitFor(() => archivePatches(workspace).length === 1, () => "the unarchive");
  const row = await threadRow(workspace, current => current.state === "stopped");
  assert.deepEqual([row.state, row.stop_reason, row.close_reason], ["stopped", "auto-archive", null]);
});

test("without View Audit Log an archive is still reverted", async () => {
  const workspace = threadWorkspace();
  await supervised(workspace);
  await liveThread(workspace);
  await idle(workspace);
  updateState(workspace.stateDir, state => {
    state.fixtures.discord.auditLogForbidden = true;
  });

  archive(workspace);

  await waitFor(() => archivePatches(workspace).length === 1, () => "the unarchive");
  const row = await threadRow(workspace, current => current.state === "stopped");
  assert.deepEqual([row.state, row.stop_reason], ["stopped", "auto-archive"]);
});

test("an archive during a turn is reverted and the session keeps running", async () => {
  const workspace = threadWorkspace();
  await supervised(workspace);
  await liveThread(workspace);
  await idle(workspace);
  updateState(workspace.stateDir, state => {
    state.fixtures.claude.holdTurnsIn = [THREAD_ID];
  });
  threadMessage(workspace, "busy-message-1", "run the whole suite");
  await waitFor(() => claude(workspace).channelNotifications.length === 2, () => "the second turn");

  archive(workspace);

  await waitFor(() => archivePatches(workspace).length === 1, () => "the unarchive");
  await new Promise(resolve => setTimeout(resolve, 1000));
  assert.equal((await threadRow(workspace)).state, "live");
  assert.ok(await threadConnected(workspace));
  updateState(workspace.stateDir, state => {
    state.fixtures.claude.holdTurnsIn = [];
  });
});

test("the archive /close makes stays archived and closes the conversation", async () => {
  const workspace = threadWorkspace();
  await supervised(workspace);
  await liveThread(workspace);

  threadMessage(workspace, "close-message-1", "/close");

  const row = await threadRow(workspace, current => current.state === "closed");
  assert.deepEqual([row.state, row.close_reason], ["closed", "close-command"]);
  await assertStopped(workspace);
  await waitFor(() => (discord(workspace).injectedThreads ?? []).every(entry => entry.delivered), () => "the archive event");
  await new Promise(resolve => setTimeout(resolve, 1000));
  assert.deepEqual(archivePatches(workspace), [[ROOT_AUTH, true]]);
  assert.equal(discord(workspace).threads[THREAD_ID].archived, true);
});

test("on start, the supervisor unarchives an archived thread whose conversation is not closed", async () => {
  const workspace = threadWorkspace();
  const supervisor = await supervised(workspace);
  await liveThread(workspace);
  await idle(workspace);
  await supervisor.stop();
  // Archived while the supervisor was down.
  updateState(workspace.stateDir, state => {
    Object.assign(state.fixtures.discord.threads[THREAD_ID], { archived: true, archiveTimestamp: new Date().toISOString() });
  });

  await startThreadSupervisor(workspace, { env: SUPERVISOR_ENV });

  await waitFor(() => archivePatches(workspace).length === 1, () => "the unarchive on start", 15000);
  assert.equal(discord(workspace).threads[THREAD_ID].archived, false);
  const row = await threadRow(workspace);
  assert.notEqual(row.state, "closed");
});

test("a bot unarchive, and the repeated THREAD_CREATE after it, start no session", async () => {
  const workspace = threadWorkspace();
  await supervised(workspace);
  await liveThread(workspace);
  await idle(workspace);
  archive(workspace);
  await threadRow(workspace, row => row.stop_reason === "auto-archive");
  await assertStopped(workspace);

  unarchive(workspace);
  threadEvent(workspace, "create", { ownerId: BOT_USER_ID, newlyCreated: false });
  // Every injected event, including the update the bind's auto-archive PATCH echoes.
  await waitFor(() => (discord(workspace).injectedThreads ?? []).every(entry => entry.delivered),
    () => "the unarchive events");
  await new Promise(resolve => setTimeout(resolve, 2000));

  assert.equal(claude(workspace).invocations.length, 1);
  assert.equal(readState(workspace.stateDir).fixtures.tmux.sessions[THREAD_TMUX], undefined);
  const row = await threadRow(workspace);
  assert.deepEqual([row.state, row.stop_reason], ["stopped", "auto-archive"]);
});

test("a delete that arrives while the thread's launcher runs waits for the launch, then stops its session and drops the row", async () => {
  const workspace = threadWorkspace();
  await supervised(workspace);
  updateState(workspace.stateDir, state => {
    state.fixtures.claude.holdHellosIn = [THREAD_ID];
  });
  threadEvent(workspace, "create");
  await threadRow(workspace);
  threadMessage(workspace, "boot-message-1", "please fix the parser");
  await threadRow(workspace, row => row.state === "booting");
  await waitFor(() => readState(workspace.stateDir).fixtures.tmux.sessions[THREAD_TMUX]?.devChannelPrompt === "accepted",
    () => "the held launch");

  threadEvent(workspace, "delete");
  await waitFor(() => (discord(workspace).injectedThreads ?? []).every(entry => entry.delivered), () => "the delete");
  await new Promise(resolve => setTimeout(resolve, 1000));
  // The row stays until the launcher it would race has exited.
  assert.equal((await threadRow(workspace)).state, "booting");
  updateState(workspace.stateDir, state => {
    state.fixtures.claude.holdHellosIn = [];
  });

  await assertStopped(workspace);
  const deadline = Date.now() + 15000;
  while ((await supervisorStatus(workspace)).projects?.demo?.threads?.[THREAD_ID]) {
    if (Date.now() > deadline) throw new Error("the deleted thread's row stayed");
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(fs.existsSync(path.join(workspace.routerStateDir, "keys", `.thread-${THREAD_ID}.key`)), false);
});

test("a delete stops the session and drops the row from status", async () => {
  const workspace = threadWorkspace();
  await supervised(workspace);
  await liveThread(workspace);

  threadEvent(workspace, "delete");

  await assertStopped(workspace);
  const deadline = Date.now() + 15000;
  let status = await supervisorStatus(workspace);
  while (status.projects?.demo?.threads?.[THREAD_ID]) {
    if (Date.now() > deadline) throw new Error(`the deleted thread's row stayed: ${JSON.stringify(status)}`);
    await new Promise(resolve => setTimeout(resolve, 50));
    status = await supervisorStatus(workspace);
  }
  assert.deepEqual(status.projects?.demo?.threads ?? {}, {});
});

// Claude keeps a conversation's transcript at
// <home>/projects/<cwd, each non-alphanumeric character as "-">/<id>.jsonl.
function writeClaudeTranscript(workspace, sessionId) {
  const dir = path.join(workspace.homeDir, ".claude", "projects", workspace.tmpDir.replace(/[^A-Za-z0-9]/g, "-"));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), "{}\n");
}

async function stoppedThread(workspace) {
  await liveThread(workspace);
  const { provider_conversation_id: conversationId } = await threadRow(workspace);
  await idle(workspace);
  archive(workspace);
  await threadRow(workspace, row => row.state === "stopped");
  await assertStopped(workspace);
  return conversationId;
}

const resumeArgs = invocation => {
  const index = invocation.args.indexOf("--resume");
  return index < 0 ? null : invocation.args[index + 1].replace(/^'|'$/g, "");
};

test("the next owner message in a stopped Claude thread relaunches it with --resume and the same conversation id", async () => {
  const workspace = threadWorkspace();
  await supervised(workspace);
  const conversationId = await stoppedThread(workspace);
  writeClaudeTranscript(workspace, conversationId);

  threadMessage(workspace, "resume-message-1", "picking this back up");

  await threadRow(workspace, row => row.state === "live");
  await waitFor(() => threadPosts(workspace).length === 2, () => "the resumed session's reply", 15000);
  const invocations = claude(workspace).invocations;
  assert.equal(invocations.length, 2);
  assert.equal(resumeArgs(invocations[0]), null);
  assert.equal(resumeArgs(invocations[1]), conversationId);
  assert.equal(invocations[1].cwd, workspace.tmpDir);
  const row = await threadRow(workspace, current => current.provider_conversation_id != null);
  assert.equal(row.provider_conversation_id, conversationId);
  // The resumed session's bootstrap carries the message that resumed it.
  assert.match(claude(workspace).channelNotifications.at(-1).content, /picking this back up/);
});

test("a resume after the project switched its Claude home continues the conversation in the home it started in", async () => {
  const workspace = threadWorkspace();
  await supervised(workspace);
  const conversationId = await stoppedThread(workspace);
  writeClaudeTranscript(workspace, conversationId);
  // The operator moves the project to another account's home.
  fs.mkdirSync(path.join(workspace.homeDir, ".claude-other"), { recursive: true });
  const registryFile = path.join(workspace.repoDir, "registry.json");
  const registry = JSON.parse(fs.readFileSync(registryFile, "utf8"));
  registry.projects.demo.claude_home = "~/.claude-other";
  fs.writeFileSync(registryFile, `${JSON.stringify(registry, null, 2)}\n`);

  threadMessage(workspace, "resume-message-1", "picking this back up");

  await threadRow(workspace, row => row.state === "live");
  await waitFor(() => threadPosts(workspace).length === 2, () => "the resumed session's reply", 15000);
  const resumed = claude(workspace).invocations[1];
  assert.equal(resumeArgs(resumed), conversationId);
  // The default home, as the conversation's first launch had it.
  assert.equal(resumed.env.CLAUDE_CONFIG_DIR, undefined);
  assert.equal((await threadRow(workspace)).provider_conversation_id, conversationId);
});

// The launcher's recorded pid, which the supervisor stores once the launcher exits.
const storedRuntimePid = workspace => JSON.parse(execFileSync(PYTHON, ["-c", `import json, sqlite3, sys
db = sqlite3.connect(sys.argv[1], timeout=5)
print(json.dumps(db.execute("SELECT runtime_pid FROM threads WHERE thread_id = ?", (sys.argv[2],)).fetchone()[0]))`,
path.join(supervisorStateDir(workspace), "threads.sqlite3"), THREAD_ID], { encoding: "utf8" }));

test("a resumed Claude session whose session id cannot be read keeps the known conversation id", async () => {
  const workspace = threadWorkspace();
  await supervised(workspace);
  const conversationId = await stoppedThread(workspace);
  writeClaudeTranscript(workspace, conversationId);
  updateState(workspace.stateDir, state => {
    state.fixtures.claude.omitSessionFile = true;
  });

  threadMessage(workspace, "resume-message-1", "picking this back up");

  await threadRow(workspace, row => row.state === "live");
  // The launcher gives up on the session file after about 10 s and reports no id.
  await waitFor(() => claude(workspace).invocations.length === 2, () => "the resumed launch", 15000);
  const resumedPid = claude(workspace).invocations[1].pid;
  await waitFor(() => storedRuntimePid(workspace) === resumedPid, () => "the resumed launch to be recorded", 25000);
  assert.equal((await threadRow(workspace)).provider_conversation_id, conversationId);
});

const notices = workspace => threadPosts(workspace).filter(message => !message.webhookId).map(message => message.content);

test("a resume whose Claude transcript is missing posts a one-line reason and leaves the row stopped/start-failed", async () => {
  const workspace = threadWorkspace();
  await supervised(workspace);
  const conversationId = await stoppedThread(workspace);

  threadMessage(workspace, "resume-message-1", "picking this back up");

  const row = await threadRow(workspace, current => current.stop_reason === "start-failed");
  assert.deepEqual([row.state, row.stop_reason, row.provider_conversation_id],
    ["stopped", "start-failed", conversationId]);
  await waitFor(() => notices(workspace).length === 1, () => "the start-failure notice", 15000);
  const [notice] = notices(workspace);
  assert.match(notice, new RegExp(`^Thread session failed to start: .*transcript for conversation ${conversationId} is missing`));
  assert.equal(notice.includes("\n"), false, notice);
  // Never a silent fresh start.
  assert.equal(claude(workspace).invocations.length, 1);
});

test("a guest message resumes a stopped thread", async () => {
  const workspace = threadWorkspace();
  await supervised(workspace);
  const conversationId = await stoppedThread(workspace);
  writeClaudeTranscript(workspace, conversationId);

  threadMessage(workspace, "guest-message-1", "any news?", { id: "guest-id", username: "Guest" });

  await threadRow(workspace, row => row.state === "live");
  const invocations = claude(workspace).invocations;
  assert.equal(invocations.length, 2);
  assert.equal(resumeArgs(invocations[1]), conversationId);
});

test("a guest message cannot reopen a closed thread, and an owner message reopens and resumes it", async () => {
  const workspace = threadWorkspace();
  await supervised(workspace);
  await liveThread(workspace);
  const { provider_conversation_id: conversationId } = await threadRow(workspace);
  writeClaudeTranscript(workspace, conversationId);
  threadMessage(workspace, "close-message-1", "/close");
  await threadRow(workspace, row => row.state === "closed");
  await assertStopped(workspace);

  threadMessage(workspace, "guest-message-1", "any news?", { id: "guest-id", username: "Guest" });
  await waitFor(() => !(discord(workspace).injectedMessages ?? []).some(message => !message.delivered),
    () => "the guest message's delivery");
  await new Promise(resolve => setTimeout(resolve, 2000));
  assert.equal(claude(workspace).invocations.length, 1);
  const closed = await threadRow(workspace);
  assert.deepEqual([closed.state, closed.close_reason], ["closed", "close-command"]);

  threadMessage(workspace, "owner-message-1", "reopening this");

  await threadRow(workspace, row => row.state === "live");
  const invocations = claude(workspace).invocations;
  assert.equal(invocations.length, 2);
  assert.equal(resumeArgs(invocations[1]), conversationId);
  // The agent's replies only: `/close` posted its own root-bot acknowledgement.
  await waitFor(() => threadPosts(workspace).filter(message => message.webhookId).length === 2,
    () => "the reopened session's reply", 15000);
  // The guest's ignored message is not replayed into the reopened conversation.
  assert.doesNotMatch(claude(workspace).channelNotifications.at(-1).content, /any news\?/);
  assert.match(claude(workspace).channelNotifications.at(-1).content, /reopening this/);
});

// ---- what a stop leaves behind on Windows, where a session's processes are found by their arguments ----

const WIN_ONLY = "POSIX finds a thread's listeners by their environment";
const keyFile = workspace => path.join(workspace.routerStateDir, "keys", `.thread-${THREAD_ID}.key`);
const launchDir = (workspace, threadId = THREAD_ID) =>
  path.join(workspace.routerStateDir, "launches", "demo", "threads", threadId);

// A process this test starts and holds, so a stop that ends it can have hit nothing
// else. It idles with `args` as its last arguments.
function spawnWithArgs(args) {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "--", ...args],
    { stdio: "ignore", windowsHide: true });
  const exited = new Promise(resolve => child.once("exit", resolve));
  registerTeardownCallback(async () => {
    child.kill("SIGKILL");
    await exited;
  });
  return { child, exited, running: () => child.exitCode === null && child.signalCode === null };
}

// [runtime_pid, runtime_tmux] as the store has them.
const storedRuntime = workspace => JSON.parse(execFileSync(PYTHON, ["-c", `import json, sqlite3, sys
db = sqlite3.connect(sys.argv[1], timeout=5)
print(json.dumps(list(db.execute("SELECT runtime_pid, runtime_tmux FROM threads WHERE thread_id = ?", (sys.argv[2],)).fetchone())))`,
path.join(supervisorStateDir(workspace), "threads.sqlite3"), THREAD_ID], { encoding: "utf8" }));

// Every process whose arguments hold the pair `--ccdm-key-file <the thread's key>`, read as the supervisor reads them.
const keyFileCarriers = workspace => JSON.parse(execFileSync(PYTHON, ["-c", `import json, os, sys
sys.path.insert(0, sys.argv[1])
from ccdmlib.platform import proc
same = lambda value: os.path.normcase(os.path.normpath(value))
found = []
for process in proc.find(lambda candidate: candidate.pid != os.getpid()):
    argv = proc.command_line(process.pid) or []
    if any(flag == "--ccdm-key-file" and same(value) == same(sys.argv[2]) for flag, value in zip(argv, argv[1:])):
        found.append(process.pid)
print(json.dumps(found))`, path.join(workspace.repoDir, "scripts"), keyFile(workspace)], { encoding: "utf8" }));

test("on Windows, an archive leaves no process carrying the thread's key file, no host session, and no runtime in the store", platformGate("win32", WIN_ONLY), async () => {
  const workspace = threadWorkspace();
  await supervised(workspace);
  await liveThread(workspace);
  await waitFor(() => storedRuntime(workspace)[0] != null, () => "the launcher's result on the row");
  assert.equal(storedRuntime(workspace)[1], THREAD_TMUX);
  await waitFor(() => keyFileCarriers(workspace).length > 0, () => "the thread's channel server");

  archive(workspace);

  await threadRow(workspace, row => row.state === "stopped");
  await assertStopped(workspace);
  assert.deepEqual(storedRuntime(workspace), [null, null]);
  assert.deepEqual(keyFileCarriers(workspace), []);
  assert.equal(fs.existsSync(keyFile(workspace)), false);
  const kill = hostOps(workspace).find(call => call.op === "kill" && call.name === THREAD_TMUX);
  assert.ok(kill, "the session host was asked to end the session");
  assert.equal(kill.graceMs, 0);
  assert.deepEqual(tmuxCalls(workspace), []);
});

test("on Windows, a stop ends a listener that outlived the thread's host session, found by its key file or launch files, and spares near matches", platformGate("win32", WIN_ONLY), async () => {
  const workspace = threadWorkspace();
  await supervised(workspace);
  await liveThread(workspace);
  // The launcher's form of the key path, and the same path with forward slashes, are one path.
  const byKey = spawnWithArgs(["--ccdm-key-file", keyFile(workspace).replaceAll("\\", "/")]);
  const byLaunchFile = spawnWithArgs(["--settings", path.join(launchDir(workspace), "settings.json")]);
  const nearMisses = [
    spawnWithArgs(["--ccdm-key-file", `${keyFile(workspace)}.bak`]),
    spawnWithArgs([keyFile(workspace), "--ccdm-key-file"]),
    spawnWithArgs(["--ccdm-key-file", path.join(workspace.routerStateDir, "keys", "demo.key")]),
    spawnWithArgs(["--settings", path.join(launchDir(workspace, `${THREAD_ID}9`), "settings.json")]),
    spawnWithArgs(["--settings", path.join(workspace.routerStateDir, "launches", "demo", "settings.json")]),
  ];
  // The host session goes first, as when the host restarted: only the listeners outside it are left.
  const ended = await callSeam(workspace, "python", "stop", { positional: [THREAD_TMUX], env: supervisorEnv(workspace), python: PYTHON });
  assert.deepEqual([ended.ok, ended.value], [true, { stopped: true }], ended.message);
  assert.equal(readState(workspace.stateDir).fixtures.tmux.sessions[THREAD_TMUX], undefined);

  // Whichever stop comes first ends them: this archive, or the crash stop once the Router loses the session.
  archive(workspace);

  await threadRow(workspace, row => row.state === "stopped");
  await Promise.all([byKey.exited, byLaunchFile.exited]);
  assert.deepEqual(keyFileCarriers(workspace), []);
  assert.deepEqual(nearMisses.map(process => process.running()), nearMisses.map(() => true));
  assert.equal(fs.existsSync(keyFile(workspace)), false);
  assert.deepEqual(storedRuntime(workspace), [null, null]);
});

const CODEX_THREAD_UUID = "0199a5c4-7e1b-7c3d-9f2a-4b8e6d1c3a58";

// The creation-request path gives this thread its Codex provider; the root bot creates it.
function requestCodexThread(workspace) {
  execFileSync(PYTHON, ["-c", `import sqlite3, sys
db = sqlite3.connect(sys.argv[1], timeout=5)
db.execute("""INSERT INTO creation_requests (request_id, project, name, provider, account, model, effort,
  first_message, requester_id, requester_kind, status, thread_id, created_at)
  VALUES ('request-1', 'demo', 'Fix flaky test', 'codex', NULL, NULL, NULL, NULL, ?, 'owner', 'pending', NULL,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))""", (sys.argv[2],))
db.commit()`, path.join(supervisorStateDir(workspace), "threads.sqlite3"), OWNER_ID]);
  threadEvent(workspace, "create", { ownerId: BOT_USER_ID });
}

// A fake app-server for the thread, bound once the supervisor has allocated its port.
async function codexServer(workspace, port, threadId) {
  const codexHome = path.join(workspace.homeDir, ".codex");
  const codex = await startFakeCodexServer(workspace, { port, deferListen: true, codexHome, channelId: THREAD_ID,
    threadId, bootstrapPlan: { mcpReplyText: "on it" } });
  return {
    codex,
    async listenWhenAllocated() {
      await threadRow(workspace, row => row.ws_port === port);
      await codex.listen();
    },
  };
}

test("the next owner message in a stopped Codex thread relaunches its bridge with --resume and the same Codex thread uuid", async () => {
  const workspace = threadWorkspace();
  fs.mkdirSync(path.join(workspace.homeDir, ".codex"), { recursive: true });
  const first = await codexServer(workspace, 29500, CODEX_THREAD_UUID);
  await supervised(workspace, { ...SUPERVISOR_ENV, CCDM_THREAD_WS_PORT_BASE: "29500" });
  requestCodexThread(workspace);
  await threadRow(workspace, row => row.provider === "codex");
  threadMessage(workspace, "boot-message-1", "please fix the parser");
  await first.listenWhenAllocated();
  await threadRow(workspace, row => row.state === "live" && row.provider_conversation_id === CODEX_THREAD_UUID);
  await waitFor(() => threadPosts(workspace).length === 1, () => "the bootstrap reply", 20000);
  await idle(workspace);
  archive(workspace);
  await threadRow(workspace, row => row.state === "stopped");
  await waitFor(() => readState(workspace.stateDir).fixtures.tmux.sessions[THREAD_TMUX] === undefined,
    () => "the Codex thread's tmux session to stop", 15000);
  // Codex keeps the conversation as a rollout under the home's sessions/.
  const rollouts = path.join(workspace.homeDir, ".codex", "sessions", "2026", "10", "01");
  fs.mkdirSync(rollouts, { recursive: true });
  fs.writeFileSync(path.join(rollouts, `rollout-2026-10-01T00-00-00-${CODEX_THREAD_UUID}.jsonl`), "{}\n");

  // The first fake app-server still listens, so the resumed bridge gets the next port.
  const second = await codexServer(workspace, 29501, CODEX_THREAD_UUID);
  threadMessage(workspace, "resume-message-1", "picking this back up");
  await second.listenWhenAllocated();

  await threadRow(workspace, row => row.state === "live");
  await waitFor(() => threadPosts(workspace).length === 2, () => "the resumed bridge's reply", 20000);
  const invocations = readState(workspace.stateDir).fixtures.codex.bridgeInvocations;
  assert.equal(invocations.length, 2);
  assert.equal(invocations[0].env.CODEX_RESUME_THREAD_ID, undefined);
  assert.equal(invocations[1].env.CODEX_RESUME_THREAD_ID, CODEX_THREAD_UUID);
  assert.equal(invocations[1].env.PROJECT_DIR, workspace.tmpDir);
  assert.equal(invocations[1].env.CODEX_HOME, path.join(workspace.homeDir, ".codex"));
  assert.deepEqual(second.codex.clientMessages.filter(message => message.method?.startsWith("thread/"))
    .map(message => [message.method, message.params.threadId]), [["thread/resume", CODEX_THREAD_UUID]]);
  const row = await threadRow(workspace);
  assert.equal(row.provider_conversation_id, CODEX_THREAD_UUID);
});
