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

// Thread status end to end: the real Router, Thread Supervisor,
// start-thread-session.sh and CCDM channel server (or Codex bridge), with the
// fixture claude and tmux. Owner and guest messages go in; the owner pings in
// the thread and the status board in the status channel come out.
const THREAD_ID = "1700000000000556677";
const THREAD_TMUX = `demo_claude-t-${THREAD_ID}`;
const STATUS_CHANNEL = "1700000000000777001";
const ROOT_AUTH = `Bot ${ROOT_TOKEN}`;
const BOT_USER_ID = "fixture-bot-user-id";
const THREAD = { id: THREAD_ID, type: 11, parentId: "demo-channel", name: "Fix flaky test", ownerId: OWNER_ID,
  autoArchiveDuration: 10080 };
// Production waits seconds; the tests tick, settle and flush fast, with pings on.
const FAST = { CCDM_THREAD_STATUS_TICK_S: "0.1", CCDM_THREAD_STATUS_SETTLE_S: "0.3",
  CCDM_THREAD_STATUS_BOARD_INTERVAL_S: "0.2", CCDM_THREAD_OWNER_PINGS: "1" };

function threadWorkspace(extra = { thread_status_channel_id: STATUS_CHANNEL }) {
  const workspace = createRouterWorkspace({ ...routerRegistry({
    demo: { channel_id: "demo-channel", type: "claude", transport: "router", guest_user_ids: ["guest-id"],
      screen_name: "demo_claude" },
  }), root_channels: ["root-channel"], ...extra });
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
const sent = (workspace, channelId) => (discord(workspace).messages ?? [])
  .filter(message => message.channelId === channelId && !message.deleted);
const isPing = message => /^(?:🔔|⚠️) <@/.test(message.content) && !message.webhookId;
// Owner pings in the thread: all, and those not deleted.
const allPings = workspace => (discord(workspace).messages ?? []).filter(message => message.channelId === THREAD_ID
  && isPing(message));
const livePings = workspace => sent(workspace, THREAD_ID).filter(isPing);
const agentReplies = workspace => sent(workspace, THREAD_ID).filter(message => message.webhookId);
const numeric = id => [id.length, id];
const boardMessages = workspace => sent(workspace, STATUS_CHANNEL)
  .sort((a, b) => (numeric(a.id) < numeric(b.id) ? -1 : 1));
// What a message reads as now: the fake keeps an edit apart from the content it was posted with.
const current = message => message.editedContent ?? message.content;
const boardText = workspace => boardMessages(workspace).map(current).join("\n");
const boardPosts = workspace => (discord(workspace).messages ?? []).filter(message => message.channelId === STATUS_CHANNEL);
const boardEdits = workspace => (discord(workspace).edits ?? []).filter(edit => edit.channelId === STATUS_CHANNEL);
const idle = workspace => waitForThreadIdle(workspace, "demo", THREAD_ID);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
// The board's parts, as the tests look for them.
const waiting = (count = 1) => `🔔 Waiting on you (${count})\n<#${THREAD_ID}> · demo · <t:`;
const working = (count = 1) => `⏳ Working (${count})\n<#${THREAD_ID}> · demo\n`;
const quiet = (idle, failed = 0) => `✅ Nothing needs you · 💤 ${idle} idle${failed ? ` · ⚠️ ${failed} failed today` : ""}`;

async function boardShows(workspace, text) {
  await waitFor(() => boardText(workspace).includes(text), () => `the board to show ${text}: ${boardText(workspace)}`, 15000);
}

// A thread made by the owner, its first owner message, and its first answered turn.
async function answeredThread(workspace, author = { id: OWNER_ID, username: "Owner" }) {
  threadEvent(workspace, "create");
  await threadRow(workspace);
  threadMessage(workspace, "boot-message-1", "please fix the parser", author);
  await threadRow(workspace, row => row.state === "live" && row.provider_conversation_id != null);
  await waitFor(() => agentReplies(workspace).length === 1, () => "the bootstrap reply", 15000);
  await idle(workspace);
}

// Claude keeps a conversation's transcript at
// <home>/projects/<cwd, each non-alphanumeric character as "-">/<id>.jsonl.
function writeClaudeTranscript(workspace, sessionId) {
  const dir = path.join(workspace.homeDir, ".claude", "projects", workspace.tmpDir.replace(/[^A-Za-z0-9]/g, "-"));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), "{}\n");
}

test("an answered owner turn pings only the owner once in the thread and shows 🔔 on the board", async () => {
  const workspace = threadWorkspace();
  await supervised(workspace);
  await answeredThread(workspace);

  const [ping] = await waitFor(() => livePings(workspace).length && livePings(workspace), () => "the owner ping", 15000);
  assert.deepEqual([ping.content, ping.authorization, ping.allowedMentions],
    ["🔔 <@owner-id> ready for you", ROOT_AUTH, { parse: [], users: [OWNER_ID] }]);
  const row = await threadRow(workspace, current => current.display_state === "waiting");
  assert.deepEqual([row.whose_turn, row.last_input_class, row.turn_outcome, row.ping_message_id],
    ["owner", "owner", "completed", ping.id]);

  await boardShows(workspace, waiting());
  const [board] = boardPosts(workspace);
  assert.deepEqual([board.authorization, board.allowedMentions], [ROOT_AUTH, { parse: [] }]);
  assert.match(current(board), new RegExp(`^-# CCDM threads\n🔔 Waiting on you \\(1\\)\n<#${THREAD_ID}> · demo · `
    + "<t:\\d+:R>\n💤 0 idle$"));
  assert.equal(boardPosts(workspace).length, 1);
  // Nothing changes, so nothing is edited.
  const edits = boardEdits(workspace).length;
  await pause(1500);
  assert.equal(boardEdits(workspace).length, edits);
  assert.equal(allPings(workspace).length, 1);
  // The parent channel never hears of it.
  assert.deepEqual(sent(workspace, "demo-channel"), []);
  const status = await supervisorStatus(workspace);
  assert.deepEqual([status.board.state, status.board.channel_id, status.board.message_ids, status.owner_pings],
    ["on", STATUS_CHANNEL, [board.id], true]);
});

test("the owner's next message deletes the ping, and the next answer posts one new ping", async () => {
  const workspace = threadWorkspace();
  await supervised(workspace);
  await answeredThread(workspace);
  const [first] = await waitFor(() => livePings(workspace).length && livePings(workspace), () => "the first ping", 15000);

  threadMessage(workspace, "next-message-1", "now add a test");

  await waitFor(() => (discord(workspace).deletes ?? []).some(entry => entry.messageId === first.id), () => "the first ping's delete");
  await waitFor(() => agentReplies(workspace).length === 2, () => "the second reply", 15000);
  const [second] = await waitFor(() => livePings(workspace).length && livePings(workspace), () => "the second ping", 15000);
  assert.notEqual(second.id, first.id);
  await pause(1000);
  assert.deepEqual(livePings(workspace).map(message => message.id), [second.id]);
  assert.equal(allPings(workspace).length, 2);
});

test("a guest-driven turn shows 🔔 · guest on the board and pings no one", async () => {
  const workspace = threadWorkspace();
  await supervised(workspace);
  await answeredThread(workspace, GUEST);

  await boardShows(workspace, waiting());
  await pause(1500);
  assert.deepEqual(allPings(workspace), []);
});

test("a /restart's bootstrap turn, with no new input, sends no ping", async () => {
  const workspace = threadWorkspace();
  await supervised(workspace);
  await answeredThread(workspace);
  await waitFor(() => livePings(workspace).length === 1, () => "the first ping", 15000);
  writeClaudeTranscript(workspace, (await threadRow(workspace)).provider_conversation_id);

  threadMessage(workspace, "restart-message-1", "/restart");

  await waitFor(() => claude(workspace).invocations.length === 2, () => "the relaunch", 15000);
  await threadRow(workspace, row => row.state === "live");
  await waitFor(() => claude(workspace).channelNotifications.length === 2, () => "the restart's bootstrap", 15000);
  await idle(workspace);
  await pause(1500);
  // The owner's /restart deleted the first ping, and the bootstrap turn sent none.
  assert.deepEqual(livePings(workspace), []);
  assert.equal(allPings(workspace).length, 1);
  assert.equal((await threadRow(workspace)).whose_turn, "owner");
  await boardShows(workspace, waiting());
});

test("a turn ended by an operator stop sends no ping, and the board shows the thread stopped", async () => {
  const workspace = threadWorkspace();
  await supervised(workspace);
  await answeredThread(workspace);
  await waitFor(() => livePings(workspace).length === 1, () => "the first ping", 15000);
  updateState(workspace.stateDir, state => {
    state.fixtures.claude.holdTurnsIn = [THREAD_ID];
  });
  threadMessage(workspace, "busy-message-1", "run the whole suite");
  await boardShows(workspace, working());

  const stop = await runScript(workspace, "scripts/threads.sh", { args: ["stop", THREAD_ID], env: supervisorEnv(workspace) });
  assert.equal(stop.exitCode, 0, stop.stderr);
  await threadRow(workspace, row => row.state === "stopped" && row.stop_reason === "operator");
  updateState(workspace.stateDir, state => {
    state.fixtures.claude.holdTurnsIn = [];
  });
  await boardShows(workspace, quiet(1));
  await pause(1500);
  assert.deepEqual(livePings(workspace), []);
  assert.equal(allPings(workspace).length, 1);
});

test("a session that crashes mid-turn shows ⚠️ crashed and sends no ping", async () => {
  const workspace = threadWorkspace();
  await supervised(workspace);
  await answeredThread(workspace);
  await waitFor(() => livePings(workspace).length === 1, () => "the first ping", 15000);
  updateState(workspace.stateDir, state => {
    state.fixtures.claude.holdTurnsIn = [THREAD_ID];
  });
  threadMessage(workspace, "busy-message-1", "run the whole suite");
  await boardShows(workspace, working());

  const { pid } = readState(workspace.stateDir).fixtures.tmux.sessions[THREAD_TMUX];
  process.kill(-pid, "SIGKILL");

  await threadRow(workspace, row => row.state === "stopped" && row.stop_reason === "crashed");
  await boardShows(workspace, quiet(0, 1));
  await pause(1500);
  assert.deepEqual(livePings(workspace), []);
});

test("a failed turn shows ⚠️ turn failed and pings the owner that it failed", async () => {
  const workspace = threadWorkspace();
  await supervised(workspace);
  updateState(workspace.stateDir, state => {
    state.fixtures.claude.failTurnsIn = [THREAD_ID];
  });
  await answeredThread(workspace);

  const [ping] = await waitFor(() => livePings(workspace).length && livePings(workspace), () => "the failure ping", 15000);
  assert.equal(ping.content, "⚠️ <@owner-id> the last turn failed");
  await boardShows(workspace, waiting());
  assert.equal((await threadRow(workspace)).turn_outcome, "failed");
});

test("threads.sh close deletes the ping before archiving, and the thread leaves the board", async () => {
  const workspace = threadWorkspace();
  await supervised(workspace);
  await answeredThread(workspace);
  const [ping] = await waitFor(() => livePings(workspace).length && livePings(workspace), () => "the ping", 15000);
  await boardShows(workspace, waiting());

  const close = await runScript(workspace, "scripts/threads.sh", { args: ["close", THREAD_ID], env: supervisorEnv(workspace) });
  assert.equal(close.exitCode, 0, close.stderr);

  const row = await threadRow(workspace, current => current.state === "closed");
  assert.deepEqual([row.close_reason, row.ping_message_id], ["close-command", null]);
  // The ping was deleted while the thread was still open: Discord refuses deletes in an archived thread.
  assert.deepEqual((discord(workspace).deletes ?? []).filter(entry => entry.messageId === ping.id)
    .map(entry => entry.threadArchived), [false]);
  assert.equal(discord(workspace).threads[THREAD_ID].archived, true);
  await boardShows(workspace, quiet(0));
  assert.ok(!boardText(workspace).includes(`<#${THREAD_ID}>`));
});

test("the owner's /close in the thread deletes the ping before archiving, and the thread leaves the board", async () => {
  const workspace = threadWorkspace();
  await supervised(workspace);
  await answeredThread(workspace);
  const [ping] = await waitFor(() => livePings(workspace).length && livePings(workspace), () => "the ping", 15000);
  await boardShows(workspace, waiting());

  // A thread_command the Router hands the supervisor, answered by commands.py's /close.
  threadMessage(workspace, "close-message-1", "/close");

  const row = await threadRow(workspace, current => current.state === "closed");
  assert.deepEqual([row.close_reason, row.ping_message_id], ["close-command", null]);
  assert.deepEqual((discord(workspace).deletes ?? []).filter(entry => entry.messageId === ping.id)
    .map(entry => entry.threadArchived), [false]);
  assert.equal(discord(workspace).threads[THREAD_ID].archived, true);
  assert.ok(sent(workspace, THREAD_ID).some(message => !message.webhookId && message.content === "Closing this thread."));
  await boardShows(workspace, quiet(0));
  // A closed thread is not pinged again, and the archive stands.
  await pause(1000);
  assert.deepEqual(livePings(workspace), []);
  assert.equal(discord(workspace).threads[THREAD_ID].archived, true);
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

test("a /close a crash interrupted after recording itself is finished on restart: closed, reminders told, off the board", async () => {
  const workspace = threadWorkspace();
  const first = await supervised(workspace, { CCDM_THREAD_FAIL_AFTER_PENDING_CLOSE: "1" });
  await answeredThread(workspace);
  await boardShows(workspace, waiting());

  // The worker dies after `pending_close` and the archive, before the row closes.
  threadMessage(workspace, "close-message-1", "/close");
  assert.equal((await first.result).exitCode, 70);
  const halfway = await threadRow(workspace);
  assert.notEqual(halfway.state, "closed");
  assert.equal(reminderClosed(workspace), false);

  await startThreadSupervisor(workspace, { env: FAST });
  const row = await threadRow(workspace, current => current.state === "closed");
  assert.deepEqual([row.close_reason, row.stop_reason], ["close-command", null]);
  assert.equal(discord(workspace).threads[THREAD_ID].archived, true);
  await waitFor(() => reminderClosed(workspace), () => "the conversation_closed event");
  await boardShows(workspace, quiet(0));
  assert.equal(readState(workspace.stateDir).fixtures.tmux.sessions[THREAD_TMUX], undefined);
});

test("a thread message the supervisor handles late counts from its own time, so the answered turn still pings", async () => {
  const workspace = threadWorkspace();
  await supervised(workspace);
  await answeredThread(workspace);
  const [first] = await waitFor(() => livePings(workspace).length && livePings(workspace), () => "the first ping", 15000);

  // The first ping's delete answers slowly, so the worker handles the owner's
  // next message only after the session (which the Router feeds directly)
  // answered it and its turn ended.
  updateState(workspace.stateDir, state => { state.fixtures.discord.restDeleteDelayMs = 3000; });
  const sentAt = Date.now();
  threadMessage(workspace, "next-message-1", "now add a test");
  await waitFor(() => agentReplies(workspace).length === 2, () => "the second reply", 15000);
  assert.ok(Date.now() - sentAt < 3000, "the turn ended while the worker was still busy");

  const [second] = await waitFor(() => livePings(workspace).length === 1 && livePings(workspace)[0].id !== first.id
    && livePings(workspace), () => "the second ping", 20000);
  assert.equal(second.content, "🔔 <@owner-id> ready for you");
  const row = await threadRow(workspace, current => current.ping_message_id === second.id);
  assert.deepEqual([row.whose_turn, row.turn_outcome], ["owner", "completed"]);
});

test("a supervisor restart reuses the board; a lost store adopts it; a board message deleted in Discord is posted again", async () => {
  const workspace = threadWorkspace();
  const first = await supervised(workspace);
  await answeredThread(workspace);
  await boardShows(workspace, waiting());
  assert.equal(boardPosts(workspace).length, 1);

  // A restart: the stored board is edited, never posted again.
  await first.stop();
  const second = await startThreadSupervisor(workspace, { env: FAST });
  threadMessage(workspace, "next-message-1", "now add a test");
  await waitFor(() => agentReplies(workspace).length === 2, () => "the second reply", 15000);
  await waitFor(() => livePings(workspace).length === 1, () => "the second ping", 15000);
  await boardShows(workspace, waiting());
  assert.equal(boardPosts(workspace).length, 1);

  // A lost store: root's board message in the channel is found and adopted.
  await second.stop();
  const [board] = boardMessages(workspace);
  updateState(workspace.stateDir, state => {
    state.fixtures.discord.history = { [STATUS_CHANNEL]: [{ id: board.id, content: current(board),
      author: { id: BOT_USER_ID, bot: true } }] };
  });
  for (const name of fs.readdirSync(supervisorStateDir(workspace))) {
    if (name.startsWith("threads.")) fs.rmSync(path.join(supervisorStateDir(workspace), name));
  }
  const edits = boardEdits(workspace).length;
  await startThreadSupervisor(workspace, { env: FAST });
  await waitFor(() => boardEdits(workspace).length > edits, () => "the adopted board's edit", 15000);
  assert.equal(boardPosts(workspace).length, 1);
  assert.equal(boardEdits(workspace).at(-1).messageId, board.id);
  const status = await supervisorStatus(workspace);
  assert.deepEqual(status.board.message_ids, [board.id]);

  // Deleted in Discord: the next change (here, a new thread) posts the whole board again.
  updateState(workspace.stateDir, state => {
    state.fixtures.discord.messages.find(message => message.id === board.id).deleted = true;
    state.fixtures.discord.history = {};
  });
  const other = "1700000000000556688";
  threadEvent(workspace, "create", { id: other, name: "Second thread" });
  await waitFor(() => boardPosts(workspace).length === 2, () => "the board posted again", 15000);
  assert.equal(boardMessages(workspace).length, 1);
  await boardShows(workspace, "💤 2 idle");
});

test("with no status channel there is no board and no error; setting the key starts one without a restart", async () => {
  const workspace = threadWorkspace({});
  await supervised(workspace);
  await answeredThread(workspace);
  await waitFor(() => livePings(workspace).length === 1, () => "the ping", 15000);
  await pause(1000);
  assert.deepEqual(boardPosts(workspace), []);
  assert.equal((await supervisorStatus(workspace)).board.state, "off");

  const registryFile = path.join(workspace.repoDir, "registry.json");
  const registry = JSON.parse(fs.readFileSync(registryFile, "utf8"));
  registry.thread_status_channel_id = STATUS_CHANNEL;
  fs.writeFileSync(registryFile, `${JSON.stringify(registry, null, 2)}\n`);

  await boardShows(workspace, waiting());
  assert.equal((await supervisorStatus(workspace)).board.state, "on");
});

test("an invalid status channel turns only the board off", async () => {
  const rootChannel = "1700000000000777002";
  const workspace = threadWorkspace({ thread_status_channel_id: rootChannel, root_channels: ["root-channel", rootChannel] });
  await supervised(workspace);
  await answeredThread(workspace);
  await waitFor(() => livePings(workspace).length === 1, () => "the ping still goes out", 15000);
  await pause(1000);
  assert.deepEqual(sent(workspace, rootChannel), []);
  assert.deepEqual((await supervisorStatus(workspace)).board,
    { state: "invalid", error: "thread_status_channel_id is a root channel" });

  // A path-like value is no channel id either, and nothing is posted anywhere for it.
  const registryFile = path.join(workspace.repoDir, "registry.json");
  const registry = JSON.parse(fs.readFileSync(registryFile, "utf8"));
  registry.thread_status_channel_id = "../status/1700000000000777001";
  fs.writeFileSync(registryFile, `${JSON.stringify(registry, null, 2)}\n`);
  assert.deepEqual((await supervisorStatus(workspace)).board,
    { state: "invalid", error: "thread_status_channel_id must be a Discord channel ID (17-20 digits)" });
  await pause(1000);
  const channels = new Set((discord(workspace).messages ?? []).map(message => message.channelId));
  assert.deepEqual([...channels].filter(channel => channel !== THREAD_ID), []);
});

test("thread_owner_pings: false turns pings off, and the board still shows the thread waiting", async () => {
  const workspace = threadWorkspace({ thread_status_channel_id: STATUS_CHANNEL, thread_owner_pings: false });
  await supervised(workspace, { CCDM_THREAD_OWNER_PINGS: "" });
  await answeredThread(workspace);
  await boardShows(workspace, waiting());
  await pause(1000);
  assert.deepEqual(allPings(workspace), []);
  assert.equal((await supervisorStatus(workspace)).owner_pings, false);
});

// Rows straight into the store, as `[thread_id, state, stop_reason, whose_turn]`.
function insertRows(workspace, rows) {
  const store = path.join(supervisorStateDir(workspace), "threads.sqlite3");
  execFileSync("python3", ["-c", `import json, sqlite3, sys
db = sqlite3.connect(sys.argv[1], timeout=5)
for thread_id, state, reason, turn in json.loads(sys.argv[3]):
    db.execute("""INSERT INTO threads (thread_id, project, name, creator_id, parent_channel_id, created_at, state,
        stop_reason, whose_turn) VALUES (?, 'demo', ?, ?, 'demo-channel', '2026-10-01T00:00:00.000Z', ?, ?, ?)""",
        (thread_id, f"Task {thread_id[-3:]}", sys.argv[2], state, reason, turn))
db.commit()`, store, OWNER_ID, JSON.stringify(rows)]);
  return store;
}

test("an overfull board stays one message: the lowest section loses lines first, shown as +N more", async () => {
  const workspace = threadWorkspace();
  await supervised(workspace);
  const id = index => `1700000000000${900000 + index}`;
  // Sixty threads waiting on the owner (their sessions stopped), ten working, three idle.
  const store = insertRows(workspace, [
    ...Array.from({ length: 60 }, (_, index) => [id(index), "stopped", "operator", "owner"]),
    ...Array.from({ length: 10 }, (_, index) => [id(100 + index), "booting", null, "agent"]),
    ...Array.from({ length: 3 }, (_, index) => [id(200 + index), "registered", null, null]),
  ]);

  await waitFor(() => boardText(workspace).includes("🔔 Waiting on you (60)"), () => `the full board: ${boardText(workspace)}`,
    15000);
  assert.equal(boardMessages(workspace).length, 1);
  const lines = boardText(workspace).split("\n");
  assert.ok(boardText(workspace).length <= 2000, boardText(workspace).length);
  assert.equal(lines[0], "-# CCDM threads");
  const shown = lines.filter(text => text.startsWith("<#")).length;
  assert.ok(shown > 20 && shown < 60, `${shown} waiting lines`);
  // Working, the lower section, is cut first: its header stays, every line goes.
  assert.deepEqual(lines.slice(-4), [`+${60 - shown} more`, "⏳ Working (10)", "+10 more", "💤 3 idle"]);

  // Most of them close: the same message shrinks, with nothing cut.
  execFileSync("python3", ["-c", `import sqlite3, sys
db = sqlite3.connect(sys.argv[1], timeout=5)
db.execute("UPDATE threads SET state='closed', close_reason='close-command' WHERE thread_id >= '1700000000000900002' AND thread_id < '1700000000000900100'")
db.commit()`, store]);
  await waitFor(() => boardText(workspace).includes("🔔 Waiting on you (2)"), () => `the shrunk board: ${boardText(workspace)}`,
    15000);
  assert.equal(boardPosts(workspace).length, 1);
  assert.doesNotMatch(boardText(workspace), /more/);
  assert.match(boardText(workspace), /⏳ Working \(10\)\n(<#\d+> · demo\n){10}💤 3 idle$/);
});

test("adopting an older multi-message board keeps its first message and deletes the rest", async () => {
  const workspace = threadWorkspace();
  const bot = { id: BOT_USER_ID, bot: true };
  updateState(workspace.stateDir, state => {
    state.fixtures.discord.history = { [STATUS_CHANNEL]: [
      { id: "1700000000000770002", content: "-# CCDM threads · 2/2 · last change <t:1:R>\n💤 old", author: bot },
      { id: "1700000000000770001", content: "-# CCDM threads · 1/2 · last change <t:1:R>\n⚠️ old", author: bot },
    ] };
  });
  await supervised(workspace);

  await waitFor(() => boardEdits(workspace).some(edit => edit.messageId === "1700000000000770001"
    && edit.content === `-# CCDM threads\n${quiet(0)}`), () => "the adopted board's edit", 15000);
  await waitFor(() => (discord(workspace).deletes ?? []).some(entry => entry.messageId === "1700000000000770002"),
    () => "the extra message's delete", 15000);
  assert.deepEqual(boardPosts(workspace), []);
  assert.deepEqual((await supervisorStatus(workspace)).board.message_ids, ["1700000000000770001"]);
});

test("a crash counts as failed today, then as idle once a day old", async () => {
  const workspace = threadWorkspace();
  await supervised(workspace);
  const yesterday = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
  const store = insertRows(workspace, [["1700000000000910001", "stopped", "crashed", null],
    ["1700000000000910002", "stopped", "crashed", null]]);
  await boardShows(workspace, quiet(0, 2));
  // One crash is a day old: the supervisor keeps the time each state began.
  execFileSync("python3", ["-c", `import sqlite3, sys
db = sqlite3.connect(sys.argv[1], timeout=5)
db.execute("UPDATE threads SET display_since=? WHERE thread_id='1700000000000910001'", (sys.argv[2],))
db.commit()`, store, yesterday]);
  await boardShows(workspace, quiet(1, 1));
});

// A Codex thread: the bridge's turn/completed hands the turn to the owner.
const CODEX_THREAD_UUID = "0199a5c4-7e1b-7c3d-9f2a-4b8e6d1c3a99";

test("a Codex thread's completed turn pings the owner and shows 🔔 on the board", async () => {
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
  await codex.listen();
  await threadRow(workspace, row => row.state === "live");
  await waitFor(() => agentReplies(workspace).length === 1, () => "the bootstrap reply", 20000);

  const [ping] = await waitFor(() => livePings(workspace).length && livePings(workspace), () => "the owner ping", 15000);
  assert.equal(ping.content, "🔔 <@owner-id> ready for you");
  await boardShows(workspace, waiting());
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
