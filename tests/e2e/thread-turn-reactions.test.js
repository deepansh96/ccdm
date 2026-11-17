import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { injectDiscordMessage, startFakeCodexServer } from "./support/bridge.js";
import { runScript } from "./support/runner.js";
import { OWNER_ID, ROOT_TOKEN, createRouterWorkspace, routerRegistry, routerWithWebhooks, waitFor } from "./support/router.js";
import { readState, updateState } from "./support/state.js";
import { cleanup } from "./support/teardown.js";
import { startThreadSupervisor, supervisorEnv, supervisorStateDir, supervisorStatus,
  waitForThreadIdle } from "./support/thread-supervisor.js";

test.afterEach(cleanup);

// Turn reactions end to end: the real Router, Thread Supervisor,
// start-thread-session.sh and CCDM channel server (or Codex bridge), with the
// fixture claude and tmux. Owner and guest messages go in; root's ⏳, ✅ and ⚠️
// on those messages come out.
const THREAD_ID = "1700000000000556677";
const THREAD_TMUX = `demo_claude-t-${THREAD_ID}`;
const ROOT_AUTH = `Bot ${ROOT_TOKEN}`;
const BOT_USER_ID = "fixture-bot-user-id";
const THREAD = { id: THREAD_ID, type: 11, parentId: "demo-channel", name: "Fix flaky test", ownerId: OWNER_ID,
  autoArchiveDuration: 10080 };
// Production waits seconds; the tests tick and settle fast, with turn marks on.
const FAST = { CCDM_THREAD_STATUS_TICK_S: "0.1", CCDM_THREAD_STATUS_SETTLE_S: "0.3", CCDM_THREAD_TURN_MARKS: "1" };
const MARKS = ["⏳", "✅", "⚠️"];

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

async function supervised(workspace, env = {}) {
  await routerWithWebhooks(workspace, ["demo"]);
  updateState(workspace.stateDir, state => {
    state.fixtures.claude.replyText = "on it";
  });
  return startThreadSupervisor(workspace, { env: { ...FAST, ...env } });
}

function threadEvent(workspace, event, fields = {}) {
  updateState(workspace.stateDir, state => {
    (state.fixtures.discord.injectedThreads ||= []).push({ ...THREAD, event, ...fields });
  });
}

function threadMessage(workspace, id, content, author = { id: OWNER_ID, username: "Owner" }) {
  injectDiscordMessage(workspace, { id, channelId: THREAD_ID, content, author });
}

const GUEST = { id: "guest-id", username: "Guest" };

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
const agentReplies = workspace => (discord(workspace).messages ?? [])
  .filter(message => message.channelId === THREAD_ID && message.webhookId && !message.deleted);
// Root's own posts in the thread: notices only, never a ping.
const rootPosts = workspace => (discord(workspace).messages ?? [])
  .filter(message => message.channelId === THREAD_ID && !message.webhookId);
const idle = workspace => waitForThreadIdle(workspace, "demo", THREAD_ID);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

// The turn-mark reactions root PUT (or, with `field`, DELETEd) in the thread, as [message, emoji].
const markCalls = (workspace, field = "reactions") => (discord(workspace)[field] ?? [])
  .filter(reaction => reaction.channelId === THREAD_ID && MARKS.includes(decodeURIComponent(reaction.emoji)))
  .map(reaction => ({ ...reaction, emoji: decodeURIComponent(reaction.emoji) }));
const marks = (workspace, field) => markCalls(workspace, field).map(({ messageId, emoji }) => [messageId, emoji]);
// What the thread shows now, as "message emoji" (the fake records PUTs and DELETEs apart).
function shown(workspace) {
  const count = new Map();
  for (const [id, emoji] of marks(workspace)) count.set(`${id} ${emoji}`, (count.get(`${id} ${emoji}`) ?? 0) + 1);
  for (const [id, emoji] of marks(workspace, "reactionDeletes")) {
    count.set(`${id} ${emoji}`, (count.get(`${id} ${emoji}`) ?? 0) - 1);
  }
  return [...count].filter(([, times]) => times > 0).map(([key]) => key).sort();
}

async function shows(workspace, expected, timeoutMs = 15000) {
  await waitFor(() => JSON.stringify(shown(workspace)) === JSON.stringify([...expected].sort()),
    () => `the thread to show ${JSON.stringify(expected)}: ${JSON.stringify(shown(workspace))}`, timeoutMs);
}

const holdTurns = (workspace, held) => updateState(workspace.stateDir, state => {
  state.fixtures.claude.holdTurnsIn = held ? [THREAD_ID] : [];
});

// A thread made by the owner, its first message, and its first answered turn.
async function answeredThread(workspace, author = { id: OWNER_ID, username: "Owner" }) {
  threadEvent(workspace, "create");
  await threadRow(workspace);
  threadMessage(workspace, "boot-message-1", "please fix the parser", author);
  await threadRow(workspace, row => row.state === "live" && row.provider_conversation_id != null);
  await waitFor(() => agentReplies(workspace).length === 1, () => "the bootstrap reply", 15000);
  await idle(workspace);
}

// An answered thread with ✅ on its first message, then a second input whose turn is held running.
async function busyThread(workspace) {
  await answeredThread(workspace);
  await shows(workspace, ["boot-message-1 ✅"]);
  holdTurns(workspace, true);
  threadMessage(workspace, "busy-message-1", "run the whole suite");
  await shows(workspace, ["boot-message-1 ✅", "busy-message-1 ⏳"]);
}

// Claude keeps a conversation's transcript at
// <home>/projects/<cwd, each non-alphanumeric character as "-">/<id>.jsonl.
function writeClaudeTranscript(workspace, sessionId) {
  const dir = path.join(workspace.homeDir, ".claude", "projects", workspace.tmpDir.replace(/[^A-Za-z0-9]/g, "-"));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), "{}\n");
}

const reactionPath = (messageId, emoji) =>
  `/api/v10/channels/${THREAD_ID}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`;

test("an owner's input gets ⏳ and its answered turn turns it into ✅, with no post in the thread", async () => {
  const workspace = threadWorkspace();
  await supervised(workspace);
  await answeredThread(workspace);

  await shows(workspace, ["boot-message-1 ✅"]);
  assert.deepEqual(marks(workspace), [["boot-message-1", "⏳"], ["boot-message-1", "✅"]]);
  assert.deepEqual(marks(workspace, "reactionDeletes"), [["boot-message-1", "⏳"]]);
  assert.deepEqual([...new Set([...markCalls(workspace), ...markCalls(workspace, "reactionDeletes")]
    .map(call => call.authorization))], [ROOT_AUTH]);
  const row = await threadRow(workspace, current => current.shown_emoji === "✅");
  assert.deepEqual([row.whose_turn, row.last_input_class, row.turn_outcome, row.mark_message_id, row.mark_emoji,
    row.shown_message_id], ["owner", "owner", "completed", "boot-message-1", "✅", "boot-message-1"]);
  // Nothing changes, so nothing more is sent.
  await pause(1500);
  assert.equal(marks(workspace).length, 2);
  assert.deepEqual(rootPosts(workspace), []);
  assert.deepEqual((discord(workspace).messages ?? []).filter(message => message.channelId === "demo-channel"), []);
});

test("a guest's input is marked the same way", async () => {
  const workspace = threadWorkspace();
  await supervised(workspace);
  await answeredThread(workspace, GUEST);
  await shows(workspace, ["boot-message-1 ✅"]);
  assert.equal((await threadRow(workspace)).last_input_class, "guest");
});

test("a later input takes the ⏳ from an earlier one in the same turn, and only the latest gets ✅", async () => {
  const workspace = threadWorkspace();
  await supervised(workspace);
  await busyThread(workspace);

  threadMessage(workspace, "busy-message-2", "and the lint too");
  await shows(workspace, ["boot-message-1 ✅", "busy-message-2 ⏳"]);
  holdTurns(workspace, false);
  await shows(workspace, ["boot-message-1 ✅", "busy-message-2 ✅"]);
  await idle(workspace);
  await pause(1500);
  assert.deepEqual(shown(workspace), ["boot-message-1 ✅", "busy-message-2 ✅"]);
  // The earlier input only ever had ⏳, and the first ✅ was never touched.
  assert.deepEqual(marks(workspace).filter(([id]) => id === "busy-message-1"), [["busy-message-1", "⏳"]]);
  assert.deepEqual(marks(workspace, "reactionDeletes").filter(([id]) => id === "boot-message-1"),
    [["boot-message-1", "⏳"]]);
});

test("a failed turn gets ⚠️ in place of ⏳", async () => {
  const workspace = threadWorkspace();
  await supervised(workspace);
  updateState(workspace.stateDir, state => {
    state.fixtures.claude.failTurnsIn = [THREAD_ID];
  });
  await answeredThread(workspace);
  await shows(workspace, ["boot-message-1 ⚠️"]);
  assert.equal((await threadRow(workspace)).turn_outcome, "failed");
});

test("an interrupted turn just loses its ⏳, and the turn end after it adds nothing", async () => {
  const workspace = threadWorkspace();
  await supervised(workspace);
  await busyThread(workspace);

  // The session records an interrupted end, as the Codex bridge does on turn/interrupt.
  const file = path.join(workspace.routerStateDir, "launches", "demo", "threads", THREAD_ID, "activity.json");
  execFileSync(process.execPath, ["-e", `require(${JSON.stringify(path.resolve("scripts/thread-activity.js"))})`
    + `.markTurn(${JSON.stringify(file)}, false, "interrupted")`]);
  await shows(workspace, ["boot-message-1 ✅"]);

  holdTurns(workspace, false);
  await idle(workspace);
  await pause(1500);
  assert.deepEqual(shown(workspace), ["boot-message-1 ✅"]);
  assert.deepEqual(marks(workspace).filter(([id]) => id === "busy-message-1"), [["busy-message-1", "⏳"]]);
});

test("a /restart's bootstrap turn, with no input since the last end, changes no mark", async () => {
  const workspace = threadWorkspace();
  await supervised(workspace);
  await answeredThread(workspace);
  await shows(workspace, ["boot-message-1 ✅"]);
  writeClaudeTranscript(workspace, (await threadRow(workspace)).provider_conversation_id);
  const before = [marks(workspace).length, marks(workspace, "reactionDeletes").length];

  threadMessage(workspace, "restart-message-1", "/restart");

  await waitFor(() => claude(workspace).invocations.length === 2, () => "the relaunch", 15000);
  await threadRow(workspace, row => row.state === "live");
  await waitFor(() => claude(workspace).channelNotifications.length === 2, () => "the restart's bootstrap", 15000);
  await idle(workspace);
  await pause(1500);
  assert.deepEqual([marks(workspace).length, marks(workspace, "reactionDeletes").length], before);
  assert.deepEqual(shown(workspace), ["boot-message-1 ✅"]);
  assert.equal((await threadRow(workspace)).whose_turn, "owner");
});

test("a session that crashes mid-turn turns its ⏳ into ⚠️", async () => {
  const workspace = threadWorkspace();
  await supervised(workspace);
  await busyThread(workspace);

  const { pid } = readState(workspace.stateDir).fixtures.tmux.sessions[THREAD_TMUX];
  process.kill(-pid, "SIGKILL");

  await threadRow(workspace, row => row.state === "stopped" && row.stop_reason === "crashed");
  await shows(workspace, ["boot-message-1 ✅", "busy-message-1 ⚠️"]);
});

test("an operator stop mid-turn takes the ⏳ off and adds nothing", async () => {
  const workspace = threadWorkspace();
  await supervised(workspace);
  await busyThread(workspace);

  const stop = await runScript(workspace, "scripts/threads.sh", { args: ["stop", THREAD_ID], env: supervisorEnv(workspace) });
  assert.equal(stop.exitCode, 0, stop.stderr);
  await threadRow(workspace, row => row.state === "stopped" && row.stop_reason === "operator");
  await shows(workspace, ["boot-message-1 ✅"]);
  holdTurns(workspace, false);
  await pause(1500);
  assert.deepEqual(shown(workspace), ["boot-message-1 ✅"]);
});

test("the owner's /close takes the ⏳ off before archiving the thread", async () => {
  const workspace = threadWorkspace();
  await supervised(workspace);
  await busyThread(workspace);

  threadMessage(workspace, "close-message-1", "/close");

  const row = await threadRow(workspace, current => current.state === "closed");
  assert.deepEqual([row.close_reason, row.mark_emoji, row.shown_emoji], ["close-command", null, null]);
  assert.deepEqual(shown(workspace), ["boot-message-1 ✅"]);
  // Taken off while the thread was still open: reactions cannot change in an archived thread.
  assert.deepEqual(markCalls(workspace, "reactionDeletes").filter(call => call.messageId === "busy-message-1")
    .map(call => [call.emoji, call.threadArchived]), [["⏳", false]]);
  assert.equal(discord(workspace).threads[THREAD_ID].archived, true);
  // The command itself is never marked.
  assert.deepEqual(marks(workspace).filter(([id]) => id === "close-message-1"), []);
});

test("a mark the Router failed to set is retried until Discord shows it", async () => {
  const workspace = threadWorkspace();
  await supervised(workspace);
  await answeredThread(workspace);
  await shows(workspace, ["boot-message-1 ✅"]);
  updateState(workspace.stateDir, state => {
    state.fixtures.discord.restFailures = [{ method: "PUT", path: reactionPath("busy-message-1", "⏳"), status: 500 }];
  });
  holdTurns(workspace, true);
  const sentAt = Date.now();
  threadMessage(workspace, "busy-message-1", "run the whole suite");

  await shows(workspace, ["boot-message-1 ✅", "busy-message-1 ⏳"]);
  assert.ok(Date.now() - sentAt >= 1500, "the retry waited out its backoff");
  assert.deepEqual(discord(workspace).restFailureUses.map(use => [use.method, use.path]),
    [["PUT", reactionPath("busy-message-1", "⏳")]]);
  holdTurns(workspace, false);
  await shows(workspace, ["boot-message-1 ✅", "busy-message-1 ✅"]);
});

test("a deleted message counts as done: its mark is never retried", async () => {
  const workspace = threadWorkspace();
  await supervised(workspace);
  await busyThread(workspace);
  const unknown = { code: 10008, message: "Unknown Message" };
  updateState(workspace.stateDir, state => {
    state.fixtures.discord.restFailures = [
      { method: "DELETE", path: reactionPath("busy-message-1", "⏳"), status: 404, body: unknown },
      { method: "PUT", path: reactionPath("busy-message-1", "✅"), status: 404, body: unknown },
    ];
  });

  holdTurns(workspace, false);

  const row = await threadRow(workspace, current => current.shown_emoji === "✅"
    && current.shown_message_id === "busy-message-1");
  assert.equal(row.mark_emoji, "✅");
  await pause(3000);
  assert.deepEqual(discord(workspace).restFailureUses.map(use => [use.method, use.status]), [["DELETE", 404], ["PUT", 404]]);
  assert.deepEqual(markCalls(workspace).filter(call => call.messageId === "busy-message-1").map(call => call.emoji), ["⏳"]);
  assert.deepEqual(markCalls(workspace, "reactionDeletes").filter(call => call.messageId === "busy-message-1"), []);
});

// Whether any file under the reminder service's state (its outbox, or the
// store an ingested event went to) holds a `conversation_closed` for the thread.
function reminderClosed(workspace) {
  const files = dir => (fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []).flatMap(entry =>
    entry.isDirectory() ? files(path.join(dir, entry.name)) : [path.join(dir, entry.name)]);
  return files(path.join(workspace.homeDir, ".local", "state", "ccdm", "conversation-reminders")).some(file => {
    const text = fs.readFileSync(file).toString("latin1");
    return text.includes("conversation_closed") && text.includes(THREAD_ID);
  });
}

test("a /close a crash interrupted after recording itself is finished on restart", async () => {
  const workspace = threadWorkspace();
  const first = await supervised(workspace, { CCDM_THREAD_FAIL_AFTER_PENDING_CLOSE: "1" });
  await busyThread(workspace);

  // The worker dies after `pending_close` and the archive, before the row closes.
  threadMessage(workspace, "close-message-1", "/close");
  assert.equal((await first.result).exitCode, 70);
  const halfway = await threadRow(workspace);
  assert.notEqual(halfway.state, "closed");
  assert.equal(reminderClosed(workspace), false);
  // The ⏳ went before the archive all the same.
  assert.deepEqual(shown(workspace), ["boot-message-1 ✅"]);

  await startThreadSupervisor(workspace, { env: FAST });
  const row = await threadRow(workspace, current => current.state === "closed");
  assert.deepEqual([row.close_reason, row.stop_reason], ["close-command", null]);
  assert.equal(discord(workspace).threads[THREAD_ID].archived, true);
  await waitFor(() => reminderClosed(workspace), () => "the conversation_closed event");
  assert.equal(readState(workspace.stateDir).fixtures.tmux.sessions[THREAD_TMUX], undefined);
  assert.deepEqual(shown(workspace), ["boot-message-1 ✅"]);
});

// A Codex thread: the bridge's turn/completed ends the turn.
const CODEX_THREAD_UUID = "0199a5c4-7e1b-7c3d-9f2a-4b8e6d1c3a99";

test("a Codex thread's completed turn turns its ⏳ into ✅", async () => {
  const workspace = threadWorkspace();
  fs.mkdirSync(path.join(workspace.homeDir, ".codex"), { recursive: true });
  const codex = await startFakeCodexServer(workspace, { port: 29620, deferListen: true,
    codexHome: path.join(workspace.homeDir, ".codex"), channelId: THREAD_ID, threadId: CODEX_THREAD_UUID,
    bootstrapPlan: { mcpReplyText: "on it" } });
  await supervised(workspace, { CCDM_THREAD_WS_PORT_BASE: "29620" });
  execFileSync("python3", ["-c", `import sqlite3, sys
db = sqlite3.connect(sys.argv[1], timeout=5)
db.execute("""INSERT INTO creation_requests (request_id, project, name, provider, account, model, effort,
  first_message, requester_id, requester_kind, status, thread_id, created_at)
  VALUES ('request-1', 'demo', 'Fix flaky test', 'codex', NULL, NULL, NULL, NULL, ?, 'owner', 'pending', NULL,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))""", (sys.argv[2],))
db.commit()`, path.join(supervisorStateDir(workspace), "threads.sqlite3"), OWNER_ID]);
  threadEvent(workspace, "create", { ownerId: BOT_USER_ID });
  await threadRow(workspace, row => row.provider === "codex");
  threadMessage(workspace, "boot-message-1", "please fix the parser");
  await threadRow(workspace, row => row.ws_port === 29620);
  await shows(workspace, ["boot-message-1 ⏳"]);
  await codex.listen();
  await threadRow(workspace, row => row.state === "live");
  await waitFor(() => agentReplies(workspace).length === 1, () => "the bootstrap reply", 20000);

  await shows(workspace, ["boot-message-1 ✅"]);
  const row = await threadRow(workspace);
  assert.deepEqual([row.whose_turn, row.turn_outcome], ["owner", "completed"]);
});

// The activity writer on its own: the hook ignores a `/` command typed into the
// pane (no Stop may follow it), and concurrent writers never lose each other's fields.
test("the activity hook skips / commands, and concurrent activity writers keep every field", async () => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR || "/tmp"), "ccdm-activity-"));
  try {
    const file = path.join(dir, "activity.json");
    const script = path.resolve("scripts/thread-activity.js");
    const hook = event => execFileSync(process.execPath, [script, file], { input: JSON.stringify(event) });
    const read = () => JSON.parse(fs.readFileSync(file, "utf8"));

    hook({ hook_event_name: "Stop" });
    assert.equal(read().turn_running, false);
    hook({ hook_event_name: "UserPromptSubmit", prompt: "  /compact" });
    assert.equal(read().turn_running, false);
    hook({ hook_event_name: "UserPromptSubmit", prompt: "please go on" });
    assert.equal(read().turn_running, true);

    // Twenty processes at once, half marking a reply and half a pause.
    const writer = index => new Promise((resolve, reject) => execFile(process.execPath, ["-e",
      `require(${JSON.stringify(script)}).${index % 2 ? "markReplied" : "markPaused"}(${JSON.stringify(file)}${index % 2 ? "" : ", true"})`],
    error => (error ? reject(error) : resolve())));
    await Promise.all(Array.from({ length: 20 }, (_, index) => writer(index)));
    assert.deepEqual([read().turn_running, read().turn_replied, read().paused], [true, true, true]);
    assert.deepEqual(fs.readdirSync(dir).sort(), ["activity.json"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
