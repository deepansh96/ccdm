import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { injectDiscordMessage, startFakeCodexServer } from "./support/bridge.js";
import { runScript } from "./support/runner.js";
import { OWNER_ID, ROOT_TOKEN, createRouterWorkspace, routerRegistry, routerWithWebhooks, waitFor,
  writeProjectKey } from "./support/router.js";
import { readState, updateState } from "./support/state.js";
import { PYTHON } from "./support/platform.js";
import { cleanup, registerTeardownCallback, workspaceOwnsPid } from "./support/teardown.js";
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

// Ends every process of the thread's session at once, as a crash does. POSIX signals
// the session's process group. Windows has none, so each process in the session's
// Job is ended, and only one this workspace started.
function killSession(workspace) {
  const session = readState(workspace.stateDir).fixtures.tmux.sessions[THREAD_TMUX];
  if (process.platform !== "win32") return process.kill(-session.pid, "SIGKILL");
  for (const pid of session.job ?? [session.pid]) {
    if (!workspaceOwnsPid(pid, workspace.tmpRoot)) continue;
    try {
      process.kill(pid, "SIGKILL");
    } catch (error) {
      // Ending one process of the session can end another before its own turn comes.
      if (error.code !== "ESRCH") throw error;
    }
  }
}

test("a session that crashes mid-turn turns its ⏳ into ⚠️", async () => {
  const workspace = threadWorkspace();
  await supervised(workspace);
  await busyThread(workspace);

  killSession(workspace);

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
  // On the fake ccdm-host (always on Windows) the state root is the host's own.
  const roots = [path.join(workspace.homeDir, ".local", "state", "ccdm"), path.join(workspace.tmpRoot, "fake-host-state")];
  return roots.flatMap(root => files(path.join(root, "conversation-reminders"))).some(file => {
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
  execFileSync(PYTHON, ["-c", `import sqlite3, sys
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

test("Agent Message records in a thread are never inputs for thread turn marks", async () => {
  const workspace = threadWorkspace();
  await supervised(workspace);
  await answeredThread(workspace);
  await shows(workspace, ["boot-message-1 ✅"]);

  const registry = JSON.parse(fs.readFileSync(path.join(workspace.repoDir, "registry.json"), "utf8"));
  const webhookId = registry.projects.demo.webhook_id;
  injectDiscordMessage(workspace, {
    id: "record-webhook-1", channelId: THREAD_ID,
    content: "-# ⇄ Agent Request to **beta-claude** · req-0123456789ab\ncheck deploy",
    author: { id: webhookId, username: "demo-claude · 10%", bot: true }, webhookId,
  });
  injectDiscordMessage(workspace, {
    id: "record-root-1", channelId: THREAD_ID,
    content: "-# ⇄ Agent Reply from **beta-claude** · req-0123456789ab\ndeploy healthy",
    author: { id: BOT_USER_ID, username: "root", bot: true },
  });
  // A subsequent real owner message proves the supervisor processed everything before it.
  threadMessage(workspace, "owner-after-records", "thanks, now check logs");
  await shows(workspace, ["boot-message-1 ✅", "owner-after-records ✅"]);

  assert.deepEqual(
    markCalls(workspace).filter(call => call.messageId === "record-webhook-1" || call.messageId === "record-root-1"),
    [],
  );
});

// The activity writer on its own: the hook ignores a `/` command typed into the
// pane (no Stop may follow it), and concurrent writers never lose each other's fields.
test("the activity hook skips / commands, and concurrent activity writers keep every field", async () => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "ccdm-activity-"));
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

// ---- Agent Messages in Thread Conversations (#406) -------------------------

function agentThreadWorkspace() {
  const workspace = createRouterWorkspace({ ...routerRegistry({
    demo: { channel_id: "demo-channel", type: "claude", transport: "router", guest_user_ids: ["guest-id"],
      screen_name: "demo_claude", agent_message_targets: ["beta"] },
    beta: { channel_id: "beta-channel", type: "codex", transport: "router", agent_message_targets: ["demo"] },
  }), root_channels: ["root-channel"] });
  const registryFile = path.join(workspace.repoDir, "registry.json");
  const registry = JSON.parse(fs.readFileSync(registryFile, "utf8"));
  registry.projects.demo.path = workspace.tmpDir;
  registry.projects.beta.path = workspace.tmpDir;
  fs.writeFileSync(registryFile, `${JSON.stringify(registry, null, 2)}\n`);
  return workspace;
}

async function supervisedAgentWorkspace(workspace, env = {}) {
  await routerWithWebhooks(workspace, ["demo", "beta"]);
  updateState(workspace.stateDir, state => {
    state.fixtures.claude.replyText = "on it";
  });
  return startThreadSupervisor(workspace, { env: { ...FAST, ...env } });
}

async function connectAgentSender(workspace, project = "beta") {
  const key = `${project}-agent-key`;
  writeProjectKey(workspace, project, key);
  const { RouterClient } = createRequire(import.meta.url)(path.join(workspace.repoDir, "scripts/router/client.js"));
  const client = new RouterClient({
    socketPath: workspace.socketPath, project, key, role: "project", capabilities: ["agent_messages"],
  });
  const events = [];
  client.on("event", event => events.push(event));
  await client.connect();
  registerTeardownCallback(() => client.close());
  return { client, events };
}

async function sendAgentRequestToThread(workspace, sender, { text, idempotencyKey, threadId = THREAD_ID }) {
  const before = (discord(workspace).messages ?? [])
    .filter(message => message.channelId === threadId && !message.webhookId
      && String(message.content || "").startsWith("-# ⇄ Agent ")).length;
  const result = await sender.client.request("agent_request", {
    target: `demo/${threadId}`,
    text,
    idempotency_key: idempotencyKey,
  });
  // Waiting for the receiver-side record post guarantees the Router posted both
  // records and dispatched the `agent_message` event to the target thread.
  const record = await waitFor(() => {
    const records = (discord(workspace).messages ?? [])
      .filter(message => message.channelId === threadId && !message.webhookId
        && String(message.content || "").startsWith("-# ⇄ Agent "));
    return records.length > before ? records.at(-1) : null;
  }, () => `receiver record post for ${result.request_id}`, 15000);
  return { result, record };
}

function releaseOneClaudeTurn(workspace, threadId = THREAD_ID) {
  updateState(workspace.stateDir, state => {
    state.fixtures.claude.releaseTurns = [...(state.fixtures.claude.releaseTurns || []), threadId];
  });
}

test("Claude thread: an agent-started turn that starts and ends never settles a pending ⏳ on the owner's latest input", async () => {
  const workspace = agentThreadWorkspace();
  await supervisedAgentWorkspace(workspace);
  await answeredThread(workspace);
  await shows(workspace, ["boot-message-1 ✅"]);

  const beta = await connectAgentSender(workspace, "beta");
  holdTurns(workspace, true);
  const { record } = await sendAgentRequestToThread(workspace, beta, {
    text: "Check staging health",
    idempotencyKey: "claude-ac1-req",
  });
  await waitFor(
    () => (claude(workspace).channelNotifications ?? []).some(n => n.meta?.sender === "agent"),
    () => "Claude agent notification",
    15000,
  );

  // Pause before sending the owner's message so it gets ⏳ from the supervisor
  // without joining the running agent-started turn.
  threadMessage(workspace, "pause-1", "/pause");
  await waitFor(
    () => agentReplies(workspace).some(message => message.content.includes("Session paused.")),
    () => "Claude /pause acknowledgement",
    15000,
  );
  threadMessage(workspace, "owner-paused-1", "please check logs next");
  await shows(workspace, ["boot-message-1 ✅", "owner-paused-1 ⏳"]);

  // End the running agent-started turn; its end must not change owner-paused-1's ⏳.
  holdTurns(workspace, false);
  await idle(workspace);
  await pause(800);
  assert.deepEqual(shown(workspace), ["boot-message-1 ✅", "owner-paused-1 ⏳"]);
  assert.equal((await threadRow(workspace)).whose_turn, "agent");
  assert.deepEqual(markCalls(workspace).filter(call => call.messageId === record.id), []);

  // After /unpause, the owner's own turn runs and settles ⏳ into ✅.
  threadMessage(workspace, "unpause-1", "/unpause");
  await shows(workspace, ["boot-message-1 ✅", "owner-paused-1 ✅"]);
  assert.deepEqual(markCalls(workspace).filter(call => call.messageId === record.id), []);
});

test("Claude thread: an owner's turn ending with a held Agent Message behind it still settles ⏳ to ✅ or ⚠️, and the agent-started turn changes nothing", async () => {
  const workspace = agentThreadWorkspace();
  await supervisedAgentWorkspace(workspace);
  await answeredThread(workspace);
  await shows(workspace, ["boot-message-1 ✅"]);
  const beta = await connectAgentSender(workspace, "beta");

  // 1. Owner turn succeeds while an Agent Message waits behind it; the following
  //    agent-started turn starts immediately and later fails, changing nothing.
  holdTurns(workspace, true);
  threadMessage(workspace, "owner-ok-1", "run checks");
  await shows(workspace, ["boot-message-1 ✅", "owner-ok-1 ⏳"]);
  const { record: record1 } = await sendAgentRequestToThread(workspace, beta, {
    text: "Inspect cache after your turn",
    idempotencyKey: "claude-ac2-ok",
  });
  releaseOneClaudeTurn(workspace);
  await waitFor(
    () => (claude(workspace).channelNotifications ?? []).some(n => n.meta?.sender === "agent" && n.content.includes("Inspect cache")),
    () => "held agent request delivered right after owner turn ended",
    15000,
  );
  await shows(workspace, ["boot-message-1 ✅", "owner-ok-1 ✅"]);

  updateState(workspace.stateDir, state => {
    state.fixtures.claude.failTurnsIn = [THREAD_ID];
  });
  holdTurns(workspace, false);
  await idle(workspace);
  await pause(600);
  assert.deepEqual(shown(workspace), ["boot-message-1 ✅", "owner-ok-1 ✅"]);
  assert.deepEqual(markCalls(workspace).filter(call => call.messageId === record1.id), []);

  // 2. Owner turn fails while an Agent Message waits behind it; the following
  //    agent-started turn starts immediately and later succeeds, changing nothing.
  holdTurns(workspace, true);
  threadMessage(workspace, "owner-fail-1", "trigger failing turn");
  await shows(workspace, ["boot-message-1 ✅", "owner-ok-1 ✅", "owner-fail-1 ⏳"]);
  const { record: record2 } = await sendAgentRequestToThread(workspace, beta, {
    text: "Inspect metrics after failing turn",
    idempotencyKey: "claude-ac2-fail",
  });
  releaseOneClaudeTurn(workspace);
  await waitFor(
    () => (claude(workspace).channelNotifications ?? []).some(n => n.meta?.sender === "agent" && n.content.includes("Inspect metrics")),
    () => "second held agent request delivered right after failed owner turn",
    15000,
  );
  await shows(workspace, ["boot-message-1 ✅", "owner-ok-1 ✅", "owner-fail-1 ⚠️"]);

  updateState(workspace.stateDir, state => {
    state.fixtures.claude.failTurnsIn = [];
  });
  holdTurns(workspace, false);
  await idle(workspace);
  await pause(600);
  assert.deepEqual(shown(workspace), ["boot-message-1 ✅", "owner-fail-1 ⚠️", "owner-ok-1 ✅"]);
  assert.deepEqual(markCalls(workspace).filter(call => call.messageId === record2.id), []);
});

test("Claude thread: owner input joining a running agent-started turn settles its ⏳ when that turn ends", async () => {
  const workspace = agentThreadWorkspace();
  await supervisedAgentWorkspace(workspace);
  await answeredThread(workspace);
  await shows(workspace, ["boot-message-1 ✅"]);

  const beta = await connectAgentSender(workspace, "beta");
  holdTurns(workspace, true);
  const { record } = await sendAgentRequestToThread(workspace, beta, {
    text: "Check schema",
    idempotencyKey: "claude-ac3-join",
  });
  await waitFor(
    () => (claude(workspace).channelNotifications ?? []).some(n => n.meta?.sender === "agent"),
    () => "Claude agent-started turn notification",
    15000,
  );

  threadMessage(workspace, "owner-join-1", "also check migrations");
  await waitFor(
    () => (claude(workspace).channelNotifications ?? []).some(n => n.meta?.message_id === "owner-join-1"),
    () => "owner message joining agent-started turn",
    15000,
  );
  await shows(workspace, ["boot-message-1 ✅", "owner-join-1 ⏳"]);

  holdTurns(workspace, false);
  await shows(workspace, ["boot-message-1 ✅", "owner-join-1 ✅"]);
  assert.deepEqual(markCalls(workspace).filter(call => call.messageId === record.id), []);
});

async function answeredCodexAgentThread(workspace, { port, turns = [], steer = [] }) {
  fs.mkdirSync(path.join(workspace.homeDir, ".codex"), { recursive: true });
  const codex = await startFakeCodexServer(workspace, {
    port, deferListen: true,
    codexHome: path.join(workspace.homeDir, ".codex"),
    channelId: THREAD_ID, threadId: CODEX_THREAD_UUID,
    bootstrapPlan: { mcpReplyText: "on it" },
    turns, steer,
  });
  await supervisedAgentWorkspace(workspace, { CCDM_THREAD_WS_PORT_BASE: String(port) });
  execFileSync(PYTHON, ["-c", `import sqlite3, sys
db = sqlite3.connect(sys.argv[1], timeout=5)
db.execute("""INSERT INTO creation_requests (request_id, project, name, provider, account, model, effort,
  first_message, requester_id, requester_kind, status, thread_id, created_at)
  VALUES ('request-1', 'demo', 'Fix flaky test', 'codex', NULL, NULL, NULL, NULL, ?, 'owner', 'pending', NULL,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))""", (sys.argv[2],))
db.commit()`, path.join(supervisorStateDir(workspace), "threads.sqlite3"), OWNER_ID]);
  threadEvent(workspace, "create", { ownerId: BOT_USER_ID });
  await threadRow(workspace, row => row.provider === "codex");
  threadMessage(workspace, "boot-message-1", "please fix the parser");
  await threadRow(workspace, row => row.ws_port === port);
  await codex.listen();
  await threadRow(workspace, row => row.state === "live");
  await waitFor(() => agentReplies(workspace).length === 1, () => "the Codex bootstrap reply", 20000);
  await idle(workspace);
  await shows(workspace, ["boot-message-1 ✅"]);
  return codex;
}

test("Codex thread: an agent-started turn that starts and ends never settles a pending ⏳ on the owner's latest input", async () => {
  const workspace = agentThreadWorkspace();
  const codex = await answeredCodexAgentThread(workspace, {
    port: 29621,
    turns: [
      { turnId: "agent-turn-1", waitForRelease: true, delta: "agent checked" },
      { turnId: "owner-turn-1", waitForRelease: true, mcpReplyText: "owner done" },
    ],
  });
  const beta = await connectAgentSender(workspace, "beta");

  const { record } = await sendAgentRequestToThread(workspace, beta, {
    text: "Check staging health",
    idempotencyKey: "codex-ac1-req",
  });
  await waitFor(() => codex.pendingReleases().includes("agent-turn-1"), () => "Codex agent-turn-1 held", 15000);

  // Pause before sending the owner's message so it gets ⏳ from the supervisor
  // and queues without joining the running agent-started turn.
  threadMessage(workspace, "pause-1", "/pause");
  await waitFor(
    () => agentReplies(workspace).some(message => message.content.includes("Bridge paused.")),
    () => "Codex /pause acknowledgement",
    15000,
  );
  threadMessage(workspace, "owner-paused-1", "now check logs");
  await shows(workspace, ["boot-message-1 ✅", "owner-paused-1 ⏳"]);

  // Ending the agent-started turn leaves the bridge idle while paused;
  // owner-paused-1's ⏳ must stay untouched past the settle window.
  codex.releaseTurn("agent-turn-1");
  await idle(workspace);
  await pause(800);
  assert.deepEqual(shown(workspace), ["boot-message-1 ✅", "owner-paused-1 ⏳"]);
  assert.equal((await threadRow(workspace)).whose_turn, "agent");
  assert.deepEqual(markCalls(workspace).filter(call => call.messageId === record.id), []);

  // After /unpause, the owner's own turn runs and settles ⏳ into ✅.
  threadMessage(workspace, "unpause-1", "/unpause");
  await waitFor(() => codex.pendingReleases().includes("owner-turn-1"), () => "Codex owner-turn-1 held", 15000);
  codex.releaseTurn("owner-turn-1");
  await shows(workspace, ["boot-message-1 ✅", "owner-paused-1 ✅"]);
  assert.deepEqual(markCalls(workspace).filter(call => call.messageId === record.id), []);
});

test("Codex thread: an owner's turn ending with a held Agent Message behind it still settles ⏳ to ✅ or ⚠️, and the agent-started turn changes nothing", async () => {
  const workspace = agentThreadWorkspace();
  const codex = await answeredCodexAgentThread(workspace, {
    port: 29622,
    turns: [
      { turnId: "owner-ok-turn", waitForRelease: true, mcpReplyText: "owner done" },
      { turnId: "agent-after-ok", waitForRelease: true, status: "failed", error: "agent boom" },
      { turnId: "owner-fail-turn", waitForRelease: true, status: "failed", error: "owner boom" },
      { turnId: "agent-after-fail", waitForRelease: true, delta: "agent ok" },
    ],
  });
  const beta = await connectAgentSender(workspace, "beta");

  // 1. Owner succeeds -> ✅ even though an agent-started turn begins immediately after and fails.
  threadMessage(workspace, "owner-ok-1", "run checks");
  await shows(workspace, ["boot-message-1 ✅", "owner-ok-1 ⏳"]);
  await waitFor(() => codex.pendingReleases().includes("owner-ok-turn"), () => "Codex owner-ok-turn held", 15000);
  const { record: record1 } = await sendAgentRequestToThread(workspace, beta, {
    text: "Inspect cache after your turn",
    idempotencyKey: "codex-ac2-ok",
  });
  codex.releaseTurn("owner-ok-turn");
  await waitFor(() => codex.pendingReleases().includes("agent-after-ok"), () => "Codex agent-after-ok held", 15000);
  await shows(workspace, ["boot-message-1 ✅", "owner-ok-1 ✅"]);

  codex.releaseTurn("agent-after-ok");
  await idle(workspace);
  await pause(600);
  assert.deepEqual(shown(workspace), ["boot-message-1 ✅", "owner-ok-1 ✅"]);
  assert.deepEqual(markCalls(workspace).filter(call => call.messageId === record1.id), []);

  // 2. Owner fails -> ⚠️ even though an agent-started turn begins immediately after and succeeds.
  threadMessage(workspace, "owner-fail-1", "trigger failing turn");
  await shows(workspace, ["boot-message-1 ✅", "owner-fail-1 ⏳", "owner-ok-1 ✅"]);
  await waitFor(() => codex.pendingReleases().includes("owner-fail-turn"), () => "Codex owner-fail-turn held", 15000);
  const { record: record2 } = await sendAgentRequestToThread(workspace, beta, {
    text: "Inspect metrics after failing turn",
    idempotencyKey: "codex-ac2-fail",
  });
  codex.releaseTurn("owner-fail-turn");
  await waitFor(() => codex.pendingReleases().includes("agent-after-fail"), () => "Codex agent-after-fail held", 15000);
  await shows(workspace, ["boot-message-1 ✅", "owner-fail-1 ⚠️", "owner-ok-1 ✅"]);

  codex.releaseTurn("agent-after-fail");
  await idle(workspace);
  await pause(600);
  assert.deepEqual(shown(workspace), ["boot-message-1 ✅", "owner-fail-1 ⚠️", "owner-ok-1 ✅"]);
  assert.deepEqual(markCalls(workspace).filter(call => call.messageId === record2.id), []);
});

test("Codex thread: owner input steering into a running agent-started turn settles its ⏳ when that turn ends", async () => {
  const workspace = agentThreadWorkspace();
  const codex = await answeredCodexAgentThread(workspace, {
    port: 29623,
    turns: [
      { turnId: "agent-steered-turn", waitForRelease: true, mcpReplyText: "handled both" },
    ],
  });
  const beta = await connectAgentSender(workspace, "beta");

  const { record } = await sendAgentRequestToThread(workspace, beta, {
    text: "Check schema",
    idempotencyKey: "codex-ac3-steer",
  });
  await waitFor(() => codex.pendingReleases().includes("agent-steered-turn"), () => "Codex agent-steered-turn held", 15000);

  threadMessage(workspace, "owner-steer-1", "also check migrations");
  await waitFor(
    () => codex.clientMessages.some(message => message.method === "turn/steer"),
    () => "Codex turn/steer for owner-steer-1",
    15000,
  );
  await shows(workspace, ["boot-message-1 ✅", "owner-steer-1 ⏳"]);

  codex.releaseTurn("agent-steered-turn");
  await shows(workspace, ["boot-message-1 ✅", "owner-steer-1 ✅"]);
  assert.deepEqual(markCalls(workspace).filter(call => call.messageId === record.id), []);

  // Injected webhook and root-bot record posts never receive turn marks in a Codex thread either.
  const registry = JSON.parse(fs.readFileSync(path.join(workspace.repoDir, "registry.json"), "utf8"));
  const webhookId = registry.projects.demo.webhook_id;
  injectDiscordMessage(workspace, {
    id: "codex-record-webhook-1", channelId: THREAD_ID,
    content: "-# ⇄ Agent Request to **beta-codex** · req-112233445566\ncheck deploy",
    author: { id: webhookId, username: "demo-codex · 10%", bot: true }, webhookId,
  });
  injectDiscordMessage(workspace, {
    id: "codex-record-root-1", channelId: THREAD_ID,
    content: "-# ⇄ Agent Reply from **beta-codex** · req-112233445566\ndeploy healthy",
    author: { id: BOT_USER_ID, username: "root", bot: true },
  });
  threadMessage(workspace, "codex-owner-after-records", "thanks, proceed");
  await shows(workspace, ["boot-message-1 ✅", "codex-owner-after-records ✅", "owner-steer-1 ✅"]);
  assert.deepEqual(
    markCalls(workspace).filter(call => call.messageId === "codex-record-webhook-1" || call.messageId === "codex-record-root-1"),
    [],
  );
});

const GEMINI_SESSION_ID = "3d4e5f6a-7b8c-4d9e-8f0a-1b2c3d4e5f6a";

function fakeAgyBin(workspace) {
  const fake = path.join(workspace.repoDir, "tests/e2e/support/fake-agy.cjs");
  if (process.platform === "win32") return fake;
  const bin = path.join(workspace.tmpRoot, "agy-bin", "agy");
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(bin, `#!/bin/sh\nexec /bin/bash -p -c 'exec -a agy "$0" "$@"' '${process.execPath}' '${fake}' "$@"\n`);
  fs.chmodSync(bin, 0o755);
  return bin;
}

const agyPlan = (workspace, plan) =>
  fs.writeFileSync(path.join(workspace.stateDir, "agy-plan.json"), `${JSON.stringify(plan)}\n`);

function agyPrompts(workspace) {
  const file = path.join(workspace.stateDir, "agy.ndjson");
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean)
    .map(line => JSON.parse(line))
    .filter(event => event.event === "client" && event.message?.method === "session/prompt")
    .map(event => (event.message.params?.prompt || []).filter(b => b.type === "text").map(b => b.text).join("\n"));
}

async function answeredGeminiAgentThread(workspace, turns) {
  agyPlan(workspace, { sessionIds: [GEMINI_SESSION_ID], turns: [{ reply: "on it" }, ...turns] });
  await supervisedAgentWorkspace(workspace, { CCDM_AGY_BIN: fakeAgyBin(workspace) });
  execFileSync(PYTHON, ["-c", `import sqlite3, sys
db = sqlite3.connect(sys.argv[1], timeout=5)
db.execute("""INSERT INTO creation_requests (request_id, project, name, provider, account, model, effort,
  first_message, requester_id, requester_kind, status, thread_id, created_at)
  VALUES ('request-1', 'demo', 'Fix flaky test', 'gemini', NULL, NULL, NULL, NULL, ?, 'owner', 'pending', NULL,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))""", (sys.argv[2],))
db.commit()`, path.join(supervisorStateDir(workspace), "threads.sqlite3"), OWNER_ID]);
  threadEvent(workspace, "create", { ownerId: BOT_USER_ID });
  await threadRow(workspace, row => row.provider === "gemini");
  threadMessage(workspace, "boot-message-1", "please fix the parser");
  await threadRow(workspace, row => row.state === "live");
  await waitFor(() => agentReplies(workspace).length === 1, () => "the Gemini bootstrap reply", 20000);
  await idle(workspace);
  await shows(workspace, ["boot-message-1 ✅"]);
}

test("Gemini thread: an agent-started turn that starts and ends never settles a pending ⏳ on the owner's latest input", async () => {
  const workspace = agentThreadWorkspace();
  const gateAgent1 = path.join(workspace.tmpDir, "gate-agent-1");
  const gateOwner1 = path.join(workspace.tmpDir, "gate-owner-1");
  const gateAgent2 = path.join(workspace.tmpDir, "gate-agent-2");
  const gateOwner2 = path.join(workspace.tmpDir, "gate-owner-2");
  await answeredGeminiAgentThread(workspace, [
    { holdUntilFile: gateAgent1, text: "agent checked" },
    { holdUntilFile: gateOwner1, reply: "owner paused done" },
    { holdUntilFile: gateAgent2, text: "agent checked 2" },
    { holdUntilFile: gateOwner2, reply: "owner queued done" },
  ]);
  const beta = await connectAgentSender(workspace, "beta");

  // 1. Paused while agent-started turn runs: ending the agent-started turn leaves
  //    the bridge idle, yet owner-paused-1's ⏳ must stay untouched past settle.
  const { record: record1 } = await sendAgentRequestToThread(workspace, beta, {
    text: "Check staging health",
    idempotencyKey: "gemini-ac1-req-1",
  });
  await waitFor(() => agyPrompts(workspace).length === 2, () => "Gemini agent prompt 1", 15000);

  threadMessage(workspace, "pause-1", "/pause");
  await waitFor(
    () => agentReplies(workspace).some(message => message.content.includes("Bridge paused.")),
    () => "Gemini /pause acknowledgement",
    15000,
  );
  threadMessage(workspace, "owner-paused-1", "now check logs");
  await shows(workspace, ["boot-message-1 ✅", "owner-paused-1 ⏳"]);

  fs.writeFileSync(gateAgent1, "go");
  await idle(workspace);
  await pause(800);
  assert.deepEqual(shown(workspace), ["boot-message-1 ✅", "owner-paused-1 ⏳"]);
  assert.equal((await threadRow(workspace)).whose_turn, "agent");
  assert.deepEqual(markCalls(workspace).filter(call => call.messageId === record1.id), []);

  threadMessage(workspace, "unpause-1", "/unpause");
  await waitFor(() => agyPrompts(workspace).length === 3, () => "Gemini owner-paused-1 prompt", 15000);
  fs.writeFileSync(gateOwner1, "go");
  await shows(workspace, ["boot-message-1 ✅", "owner-paused-1 ✅"]);

  // 2. Owner message queued naturally behind a running agent-started turn (ACP
  //    cannot steer): ending the agent-started turn must not settle ⏳, and the
  //    owner's queued turn settles ⏳ into ✅ when it finishes.
  const { record: record2 } = await sendAgentRequestToThread(workspace, beta, {
    text: "Check worker queue",
    idempotencyKey: "gemini-ac1-req-2",
  });
  await waitFor(() => agyPrompts(workspace).length === 4, () => "Gemini agent prompt 2", 15000);

  threadMessage(workspace, "owner-queued-2", "also check migrations");
  await shows(workspace, ["boot-message-1 ✅", "owner-paused-1 ✅", "owner-queued-2 ⏳"]);
  fs.writeFileSync(gateAgent2, "go");
  await waitFor(() => agyPrompts(workspace).length === 5, () => "Gemini owner-queued-2 prompt", 15000);
  await pause(600);
  assert.deepEqual(shown(workspace), ["boot-message-1 ✅", "owner-paused-1 ✅", "owner-queued-2 ⏳"]);

  fs.writeFileSync(gateOwner2, "go");
  await shows(workspace, ["boot-message-1 ✅", "owner-paused-1 ✅", "owner-queued-2 ✅"]);
  assert.deepEqual(markCalls(workspace).filter(call => call.messageId === record1.id || call.messageId === record2.id), []);

  // Injected webhook and root-bot record posts never receive turn marks in a Gemini thread either.
  const registry = JSON.parse(fs.readFileSync(path.join(workspace.repoDir, "registry.json"), "utf8"));
  const webhookId = registry.projects.demo.webhook_id;
  injectDiscordMessage(workspace, {
    id: "gemini-record-webhook-1", channelId: THREAD_ID,
    content: "-# ⇄ Agent Request to **beta-codex** · req-665544332211\ncheck deploy",
    author: { id: webhookId, username: "demo-gemini · 10%", bot: true }, webhookId,
  });
  injectDiscordMessage(workspace, {
    id: "gemini-record-root-1", channelId: THREAD_ID,
    content: "-# ⇄ Agent Reply from **beta-codex** · req-665544332211\ndeploy healthy",
    author: { id: BOT_USER_ID, username: "root", bot: true },
  });
  threadMessage(workspace, "gemini-owner-after-records", "thanks, proceed");
  await shows(workspace, ["boot-message-1 ✅", "gemini-owner-after-records ✅", "owner-paused-1 ✅", "owner-queued-2 ✅"]);
  assert.deepEqual(
    markCalls(workspace).filter(call => call.messageId === "gemini-record-webhook-1" || call.messageId === "gemini-record-root-1"),
    [],
  );
});

test("Gemini thread: an owner's turn ending with a held Agent Message behind it still settles ⏳ to ✅ or ⚠️, and the agent-started turn changes nothing", async () => {
  const workspace = agentThreadWorkspace();
  const gateOwnerOk = path.join(workspace.tmpDir, "gate-owner-ok");
  const gateAgent1 = path.join(workspace.tmpDir, "gate-agent-1");
  const gateOwnerFail = path.join(workspace.tmpDir, "gate-owner-fail");
  const gateAgent2 = path.join(workspace.tmpDir, "gate-agent-2");
  await answeredGeminiAgentThread(workspace, [
    { holdUntilFile: gateOwnerOk, reply: "owner done" },
    { holdUntilFile: gateAgent1, stopReason: "refusal" },
    { holdUntilFile: gateOwnerFail, stopReason: "refusal" },
    { holdUntilFile: gateAgent2, text: "agent ok" },
  ]);
  const beta = await connectAgentSender(workspace, "beta");

  // 1. Owner turn succeeds -> ✅ even though a held agent-started turn starts right after and fails.
  threadMessage(workspace, "owner-ok-1", "run checks");
  await shows(workspace, ["boot-message-1 ✅", "owner-ok-1 ⏳"]);
  await waitFor(() => agyPrompts(workspace).length === 2, () => "Gemini owner-ok-1 prompt", 15000);
  const { record: record1 } = await sendAgentRequestToThread(workspace, beta, {
    text: "Inspect cache after your turn",
    idempotencyKey: "gemini-ac2-ok",
  });
  fs.writeFileSync(gateOwnerOk, "go");
  await waitFor(() => agyPrompts(workspace).length === 3, () => "Gemini held agent prompt 1", 15000);
  await shows(workspace, ["boot-message-1 ✅", "owner-ok-1 ✅"]);

  fs.writeFileSync(gateAgent1, "go");
  await idle(workspace);
  await pause(600);
  assert.deepEqual(shown(workspace), ["boot-message-1 ✅", "owner-ok-1 ✅"]);
  assert.deepEqual(markCalls(workspace).filter(call => call.messageId === record1.id), []);

  // 2. Owner turn fails -> ⚠️ even though a held agent-started turn starts right after and succeeds.
  threadMessage(workspace, "owner-fail-1", "trigger failing turn");
  await shows(workspace, ["boot-message-1 ✅", "owner-fail-1 ⏳", "owner-ok-1 ✅"]);
  await waitFor(() => agyPrompts(workspace).length === 4, () => "Gemini owner-fail-1 prompt", 15000);
  const { record: record2 } = await sendAgentRequestToThread(workspace, beta, {
    text: "Inspect metrics after failing turn",
    idempotencyKey: "gemini-ac2-fail",
  });
  fs.writeFileSync(gateOwnerFail, "go");
  await waitFor(() => agyPrompts(workspace).length === 5, () => "Gemini held agent prompt 2", 15000);
  await shows(workspace, ["boot-message-1 ✅", "owner-fail-1 ⚠️", "owner-ok-1 ✅"]);

  fs.writeFileSync(gateAgent2, "go");
  await idle(workspace);
  await pause(600);
  assert.deepEqual(shown(workspace), ["boot-message-1 ✅", "owner-fail-1 ⚠️", "owner-ok-1 ✅"]);
  assert.deepEqual(markCalls(workspace).filter(call => call.messageId === record2.id), []);
});
