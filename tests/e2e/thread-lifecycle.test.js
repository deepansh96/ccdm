import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { injectDiscordMessage, startFakeCodexServer } from "./support/bridge.js";
import { OWNER_ID, createRouterWorkspace, routerRegistry, routerWithWebhooks, runRouterCli,
  waitFor } from "./support/router.js";
import { readState, updateState } from "./support/state.js";
import { cleanup } from "./support/teardown.js";
import { startThreadSupervisor, supervisorStateDir, supervisorStatus } from "./support/thread-supervisor.js";

test.afterEach(cleanup);

// The Thread Conversation lifecycle end to end: archive, unarchive, delete and
// resume, through the real Router, Thread Supervisor, start-thread-session.sh
// and CCDM channel server, with the fixture claude and tmux. Only Discord
// thread events, messages and the fake audit log go in.
const THREAD_ID = "1700000000000223344";
// `<screen>-t-<last 6 of the thread id>`.
const THREAD_TMUX = "demo_claude-t-223344";
const BOT_USER_ID = "fixture-bot-user-id";
const THREAD = { id: THREAD_ID, type: 11, parentId: "demo-channel", name: "Fix flaky test", ownerId: OWNER_ID,
  autoArchiveDuration: 10080 };
// The production 60-second audit-log poll, shortened for the tests.
const FAST_POLL = { CCDM_THREAD_ARCHIVE_POLL_WINDOW_S: "1.5", CCDM_THREAD_ARCHIVE_POLL_INTERVAL_S: "0.2" };

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

async function supervised(workspace, env = FAST_POLL) {
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

function seedArchiveEntry(workspace, userId) {
  updateState(workspace.stateDir, state => {
    (state.fixtures.discord.auditLogEntries ||= []).unshift({ id: snowflakeNow(), user_id: userId,
      target_id: THREAD_ID, action_type: 111, changes: [{ key: "archived", old_value: false, new_value: true }] });
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

test("an owner archive closes the conversation as owner-archive and stops its session", async () => {
  const workspace = threadWorkspace();
  await supervised(workspace);
  await liveThread(workspace);

  seedArchiveEntry(workspace, OWNER_ID);
  archive(workspace);

  const row = await threadRow(workspace, current => current.state === "closed");
  assert.deepEqual([row.state, row.close_reason], ["closed", "owner-archive"]);
  await assertStopped(workspace);
});

test("a root-bot archive closes the conversation as root-archive", async () => {
  const workspace = threadWorkspace();
  await supervised(workspace);
  await liveThread(workspace);

  seedArchiveEntry(workspace, BOT_USER_ID);
  archive(workspace);

  const row = await threadRow(workspace, current => current.state === "closed");
  assert.deepEqual([row.state, row.close_reason], ["closed", "root-archive"]);
  await assertStopped(workspace);
});

test("an auto-archive with no audit entry stops the session as auto-archive after polling the audit log", async () => {
  const workspace = threadWorkspace();
  await supervised(workspace);
  await liveThread(workspace);

  archive(workspace);

  await assertStopped(workspace);
  // The 1.5 s window at 0.2 s apart polls several times before giving up.
  await waitFor(() => (discord(workspace).auditLogFetches ?? []).length >= 3, () => "the audit-log polls", 15000);
  const row = await threadRow(workspace);
  assert.deepEqual([row.state, row.stop_reason, row.close_reason], ["stopped", "auto-archive", null]);
  assert.deepEqual([...new Set(discord(workspace).auditLogFetches.map(fetch => fetch.actionType))], ["111"]);
});

test("another member's archive stops the session as auto-archive", async () => {
  const workspace = threadWorkspace();
  await supervised(workspace);
  await liveThread(workspace);

  seedArchiveEntry(workspace, "moderator-id");
  archive(workspace);

  await assertStopped(workspace);
  const row = await threadRow(workspace);
  assert.deepEqual([row.state, row.stop_reason], ["stopped", "auto-archive"]);
});

test("a forbidden audit log stops the session as archive-actor-unknown", async () => {
  const workspace = threadWorkspace();
  await supervised(workspace);
  await liveThread(workspace);
  updateState(workspace.stateDir, state => {
    state.fixtures.discord.auditLogForbidden = true;
  });

  archive(workspace);

  const row = await threadRow(workspace, current => current.stop_reason === "archive-actor-unknown");
  assert.deepEqual([row.state, row.stop_reason], ["stopped", "archive-actor-unknown"]);
  assert.ok(discord(workspace).auditLogFetches.length >= 3, JSON.stringify(discord(workspace).auditLogFetches));
  await assertStopped(workspace);
});

test("a bot unarchive, and the repeated THREAD_CREATE after it, start no session", async () => {
  const workspace = threadWorkspace();
  await supervised(workspace);
  await liveThread(workspace);
  archive(workspace);
  await threadRow(workspace, row => row.stop_reason === "auto-archive");
  await assertStopped(workspace);

  unarchive(workspace);
  threadEvent(workspace, "create", { ownerId: BOT_USER_ID, newlyCreated: false });
  await waitFor(() => (discord(workspace).deliveredThreads ?? []).length === 4, () => "the unarchive events");
  await new Promise(resolve => setTimeout(resolve, 2000));

  assert.equal(claude(workspace).invocations.length, 1);
  assert.equal(readState(workspace.stateDir).fixtures.tmux.sessions[THREAD_TMUX], undefined);
  const row = await threadRow(workspace);
  assert.deepEqual([row.state, row.stop_reason], ["stopped", "auto-archive"]);
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
  seedArchiveEntry(workspace, OWNER_ID);
  archive(workspace);
  await threadRow(workspace, row => row.state === "closed");
  await assertStopped(workspace);

  threadMessage(workspace, "guest-message-1", "any news?", { id: "guest-id", username: "Guest" });
  await waitFor(() => !(discord(workspace).injectedMessages ?? []).some(message => !message.delivered),
    () => "the guest message's delivery");
  await new Promise(resolve => setTimeout(resolve, 2000));
  assert.equal(claude(workspace).invocations.length, 1);
  const closed = await threadRow(workspace);
  assert.deepEqual([closed.state, closed.close_reason], ["closed", "owner-archive"]);

  threadMessage(workspace, "owner-message-1", "reopening this");

  await threadRow(workspace, row => row.state === "live");
  const invocations = claude(workspace).invocations;
  assert.equal(invocations.length, 2);
  assert.equal(resumeArgs(invocations[1]), conversationId);
  await waitFor(() => threadPosts(workspace).length === 2, () => "the reopened session's reply", 15000);
  // The guest's ignored message is not replayed into the reopened conversation.
  assert.doesNotMatch(claude(workspace).channelNotifications.at(-1).content, /any news\?/);
  assert.match(claude(workspace).channelNotifications.at(-1).content, /reopening this/);
});

const CODEX_THREAD_UUID = "0199a5c4-7e1b-7c3d-9f2a-4b8e6d1c3a58";

// The creation-request path gives this thread its Codex provider; the root bot creates it.
function requestCodexThread(workspace) {
  execFileSync("python3", ["-c", `import sqlite3, sys
db = sqlite3.connect(sys.argv[1], timeout=5)
db.execute("""INSERT INTO creation_requests (request_id, project, name, provider, account, model, effort,
  first_message, requester_id, requester_kind, status, thread_id, created_at)
  VALUES ('request-1', 'demo', 'Fix flaky test', 'codex', NULL, NULL, NULL, NULL, ?, 'owner', 'pending', NULL,
  '2026-10-01T00:00:00Z')""", (sys.argv[2],))
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
  await supervised(workspace, { ...FAST_POLL, CCDM_THREAD_WS_PORT_BASE: "29500" });
  requestCodexThread(workspace);
  await threadRow(workspace, row => row.provider === "codex");
  threadMessage(workspace, "boot-message-1", "please fix the parser");
  await first.listenWhenAllocated();
  await threadRow(workspace, row => row.state === "live" && row.provider_conversation_id === CODEX_THREAD_UUID);
  await waitFor(() => threadPosts(workspace).length === 1, () => "the bootstrap reply", 20000);
  archive(workspace);
  await threadRow(workspace, row => row.state === "stopped");
  await waitFor(() => readState(workspace.stateDir).fixtures.tmux.sessions["demo_claude-t-223344"] === undefined,
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
