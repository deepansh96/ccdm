import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { injectDiscordMessage } from "./support/bridge.js";
import { OWNER_ID, createRouterWorkspace, routerRegistry, routerWithWebhooks, runRouterCli, seedThreads,
  startRouter, waitFor } from "./support/router.js";
import { readState, updateState } from "./support/state.js";
import { cleanup } from "./support/teardown.js";
import { startThreadSupervisor, supervisorStatus } from "./support/thread-supervisor.js";

test.afterEach(cleanup);

// Reconcile after the supervisor's downtime, a Router restart or a Gateway
// resume, through the real Router, Thread Supervisor, start-thread-session.sh
// and CCDM channel server, with the fixture claude and tmux. Discord thread
// events, messages, seeded thread history and the fake audit log go in.
// `routerWithWebhooks` gives demo the fake's first webhook.
const WEBHOOK_ID = "fake-webhook-1";
const ENV = { CCDM_THREAD_ARCHIVE_POLL_WINDOW_S: "1.5", CCDM_THREAD_ARCHIVE_POLL_INTERVAL_S: "0.2",
  CCDM_ROUTER_RECONNECT_MIN_MS: "50", CCDM_ROUTER_RECONNECT_MAX_MS: "200" };
const SLEEPING = encodeURIComponent("💤");
const EYES = encodeURIComponent("👀");

const thread = (id, fields = {}) => ({ id, type: 11, parentId: "demo-channel", name: `Task ${id.slice(-4)}`,
  ownerId: OWNER_ID, autoArchiveDuration: 10080, ...fields });
// `<screen>-t-<thread id>`.
const tmuxName = threadId => `demo_claude-t-${threadId}`;

function reconcileWorkspace() {
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

async function supervised(workspace) {
  const router = await routerWithWebhooks(workspace, ["demo"]);
  updateState(workspace.stateDir, state => {
    state.fixtures.claude.replyText = "on it";
  });
  return { router, supervisor: await startThreadSupervisor(workspace, { env: ENV }) };
}

function threadEvent(workspace, raw, event, fields = {}) {
  updateState(workspace.stateDir, state => {
    (state.fixtures.discord.injectedThreads ||= []).push({ ...raw, event, ...fields });
  });
}

const delivered = (workspace, count) => waitFor(() => (discord(workspace).deliveredThreads ?? []).length >= count,
  () => `${count} thread events delivered`);

const owner = { id: OWNER_ID, username: "Owner" };
const guest = { id: "guest-id", username: "Guest" };

function threadMessage(workspace, threadId, id, content, author = owner) {
  injectDiscordMessage(workspace, { id, channelId: threadId, content, author });
}

// Discord's message history for a thread, oldest first here; stored newest first as Discord returns it.
function seedHistory(workspace, threadId, messages) {
  const start = Date.parse("2026-09-30T10:00:00Z");
  const shaped = messages.map(([id, author, content], index) => ({
    id, type: 0, channel_id: threadId, content, attachments: [],
    timestamp: new Date(start + index * 60000).toISOString(),
    ...(author === "agent"
      ? { webhook_id: WEBHOOK_ID, author: { id: WEBHOOK_ID, username: "demo-claude", bot: true } }
      : { author: { id: author.id, username: author.username } }),
  }));
  updateState(workspace.stateDir, state => {
    (state.fixtures.discord.history ||= {})[threadId] = shaped.reverse();
  });
}

async function threadRows(workspace) {
  return (await supervisorStatus(workspace)).projects?.demo?.threads ?? {};
}

async function threadRow(workspace, threadId, predicate = () => true, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await threadRows(workspace);
    if (last[threadId] && predicate(last[threadId])) return last[threadId];
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`thread ${threadId} never matched: ${JSON.stringify(last)}`);
}

const settle = ms => new Promise(resolve => setTimeout(resolve, ms));
const discord = workspace => readState(workspace.stateDir).fixtures.discord;
const claude = workspace => readState(workspace.stateDir).fixtures.claude;
const notifications = (workspace, threadId) => (claude(workspace).channelNotifications ?? [])
  .filter(notification => notification.meta?.chat_id === threadId);
const threadPosts = (workspace, threadId) => (discord(workspace).messages ?? [])
  .filter(message => message.channelId === threadId);
const reactions = (workspace, threadId, field = "reactions") => (discord(workspace)[field] ?? [])
  .filter(reaction => reaction.channelId === threadId).map(({ messageId, emoji }) => ({ messageId, emoji }));
const occurrences = (text, needle) => text.split(needle).length - 1;
const threadConnected = async (workspace, threadId) =>
  new RegExp(`thread demo thread=${threadId} `).test((await runRouterCli(workspace, ["status"])).stdout);

async function liveThread(workspace, raw) {
  threadEvent(workspace, raw, "create");
  await threadRow(workspace, raw.id);
  threadMessage(workspace, raw.id, `${raw.id}-boot`, "please fix the parser");
  await threadRow(workspace, raw.id, row => row.state === "live" && row.provider_conversation_id != null);
  await waitFor(() => threadPosts(workspace, raw.id).length === 1, () => "the bootstrap reply", 15000);
}

async function disconnected(workspace, threadId) {
  const deadline = Date.now() + 15000;
  while (await threadConnected(workspace, threadId)) {
    if (Date.now() > deadline) throw new Error(`thread ${threadId} never disconnected from the Router`);
    await settle(50);
  }
}

test("with the supervisor stopped, an owner message in a thread with no session gets 💤", async () => {
  const workspace = reconcileWorkspace();
  const { supervisor } = await supervised(workspace);
  const raw = thread("1700000000000310001");
  threadEvent(workspace, raw, "create");
  await threadRow(workspace, raw.id);
  assert.equal((await supervisor.stop()).exitCode, 0);

  threadMessage(workspace, raw.id, "while-down", "anyone there?");

  await waitFor(() => reactions(workspace, raw.id).length > 0, () => "the 💤 mark", 10000);
  assert.deepEqual(reactions(workspace, raw.id), [{ messageId: "while-down", emoji: SLEEPING }]);
});

test("on restart, a thread created during the downtime binds, and a stranger's does not", async () => {
  const workspace = reconcileWorkspace();
  const { supervisor } = await supervised(workspace);
  assert.equal((await supervisor.stop()).exitCode, 0);
  const created = thread("1700000000000320001");
  const stranger = thread("1700000000000320002", { ownerId: "stranger-id" });
  threadEvent(workspace, created, "create");
  threadEvent(workspace, stranger, "create");
  await delivered(workspace, 2);

  await startThreadSupervisor(workspace, { env: ENV });

  const row = await threadRow(workspace, created.id);
  assert.deepEqual([row.state, row.creator_id, row.name], ["registered", OWNER_ID, created.name]);
  await settle(500);
  assert.equal((await threadRows(workspace))[stranger.id], undefined);
  assert.deepEqual(claude(workspace).invocations ?? [], []);
});

test("on restart, an owner archive during the downtime is classified as owner-archive and stops the session", async () => {
  const workspace = reconcileWorkspace();
  const { supervisor } = await supervised(workspace);
  const raw = thread("1700000000000330001");
  await liveThread(workspace, raw);
  assert.equal((await supervisor.stop()).exitCode, 0);

  const snowflake = String((BigInt(Date.now()) - 1420070400000n) << 22n);
  updateState(workspace.stateDir, state => {
    (state.fixtures.discord.auditLogEntries ||= []).unshift({ id: snowflake, user_id: OWNER_ID, target_id: raw.id,
      action_type: 111, changes: [{ key: "archived", old_value: false, new_value: true }] });
  });
  threadEvent(workspace, raw, "update", { archived: true, archiveTimestamp: new Date().toISOString(),
    previous: { ...raw, archived: false } });
  await delivered(workspace, 2);
  // Nobody stopped it: the supervisor never heard of the archive.
  assert.equal(await threadConnected(workspace, raw.id), true);

  await startThreadSupervisor(workspace, { env: ENV });

  const row = await threadRow(workspace, raw.id, current => current.state === "closed");
  assert.deepEqual([row.state, row.close_reason], ["closed", "owner-archive"]);
  await disconnected(workspace, raw.id);
  assert.equal(readState(workspace.stateDir).fixtures.tmux.sessions[tmuxName(raw.id)], undefined);
});

test("on restart, a killed session's row becomes stopped/crashed and is not restarted", async () => {
  const workspace = reconcileWorkspace();
  const { supervisor } = await supervised(workspace);
  const raw = thread("1700000000000340001");
  await liveThread(workspace, raw);
  assert.equal((await supervisor.stop()).exitCode, 0);

  const { pid } = readState(workspace.stateDir).fixtures.tmux.sessions[tmuxName(raw.id)];
  process.kill(-pid, "SIGKILL");
  await disconnected(workspace, raw.id);
  threadMessage(workspace, raw.id, "after-crash", "are you still there?");
  await waitFor(() => reactions(workspace, raw.id).some(reaction => reaction.emoji === SLEEPING), () => "the 💤 mark");
  seedHistory(workspace, raw.id, [[`${raw.id}-boot`, owner, "please fix the parser"], ["reply-1", "agent", "on it"],
    ["after-crash", owner, "are you still there?"]]);

  await startThreadSupervisor(workspace, { env: ENV });

  const row = await threadRow(workspace, raw.id, current => current.state === "stopped");
  assert.deepEqual([row.state, row.stop_reason], ["stopped", "crashed"]);
  await settle(1500);
  assert.equal(claude(workspace).invocations.length, 1);
  assert.deepEqual([(await threadRows(workspace))[raw.id].state, (await threadRows(workspace))[raw.id].stop_reason],
    ["stopped", "crashed"]);
});

test("on restart, only a thread whose newest owner message is newer than the last agent reply starts, with the messages after that reply in its bootstrap exactly once", async () => {
  const workspace = reconcileWorkspace();
  const { supervisor } = await supervised(workspace);
  const waiting = thread("1700000000000350001");
  const answered = thread("1700000000000350002");
  const guestOnly = thread("1700000000000350003");
  for (const raw of [waiting, answered, guestOnly]) threadEvent(workspace, raw, "create");
  for (const raw of [waiting, answered, guestOnly]) await threadRow(workspace, raw.id);
  assert.equal((await supervisor.stop()).exitCode, 0);

  // The owner's last message reached nobody, so the Router marked it.
  threadMessage(workspace, waiting.id, "waiting-owner-2", "and update the docs too");
  await waitFor(() => reactions(workspace, waiting.id).length === 1, () => "the 💤 mark");
  seedHistory(workspace, waiting.id, [["waiting-owner-1", owner, "first ask about the parser"],
    ["waiting-reply", "agent", "the parser is fixed"], ["waiting-guest-1", guest, "the CI log shows a new failure"],
    ["waiting-owner-2", owner, "and update the docs too"]]);
  seedHistory(workspace, answered.id, [["answered-owner-1", owner, "rename the flag"],
    ["answered-reply", "agent", "renamed it"]]);
  seedHistory(workspace, guestOnly.id, [["guest-only-owner-1", owner, "check the build"],
    ["guest-only-reply", "agent", "the build is green"], ["guest-only-guest-1", guest, "thanks!"]]);

  await startThreadSupervisor(workspace, { env: ENV });

  await threadRow(workspace, waiting.id, row => row.state === "live");
  await waitFor(() => notifications(workspace, waiting.id).length === 1 && threadPosts(workspace, waiting.id).length === 1,
    () => `the bootstrap and its reply: ${JSON.stringify(claude(workspace).channelNotifications)}`, 15000);
  await settle(1000);
  const [bootstrap] = notifications(workspace, waiting.id);
  assert.equal(notifications(workspace, waiting.id).length, 1);
  assert.equal(bootstrap.meta.message_id, "waiting-owner-2");
  assert.equal(occurrences(bootstrap.content, "the CI log shows a new failure"), 1, bootstrap.content);
  assert.equal(occurrences(bootstrap.content, "and update the docs too"), 1, bootstrap.content);
  assert.ok(bootstrap.content.indexOf("the CI log shows a new failure") < bootstrap.content.indexOf("and update the docs too"));
  for (const earlier of ["first ask about the parser", "the parser is fixed"]) {
    assert.equal(occurrences(bootstrap.content, earlier), 0, bootstrap.content);
  }
  assert.deepEqual(reactions(workspace, waiting.id), [{ messageId: "waiting-owner-2", emoji: SLEEPING },
    { messageId: "waiting-owner-2", emoji: EYES }]);
  assert.deepEqual(reactions(workspace, waiting.id, "reactionDeletes"), [{ messageId: "waiting-owner-2", emoji: EYES }]);

  const rows = await threadRows(workspace);
  assert.equal(rows[answered.id].state, "registered");
  assert.equal(rows[guestOnly.id].state, "registered");
  assert.equal(claude(workspace).invocations.length, 1);
});

test("an injected shardResume (gateway_resumed) runs the same reconcile", async () => {
  const workspace = reconcileWorkspace();
  await supervised(workspace);
  // The Gateway missed this thread and its message.
  const missed = thread("1700000000000360001");
  seedThreads(workspace, { [missed.id]: missed });
  seedHistory(workspace, missed.id, [["missed-owner-1", owner, "look at the flaky test"]]);
  await settle(500);
  assert.equal((await threadRows(workspace))[missed.id], undefined);

  updateState(workspace.stateDir, state => {
    state.fixtures.discord.injectedGatewayEvents = [{ event: "shardResume" }];
  });

  await threadRow(workspace, missed.id, row => row.state === "live");
  await waitFor(() => notifications(workspace, missed.id).length === 1, () => "the bootstrap", 15000);
  assert.equal(occurrences(notifications(workspace, missed.id)[0].content, "look at the flaky test"), 1);
});

test("a Router restart (link reconnect) runs the same reconcile", async () => {
  const workspace = reconcileWorkspace();
  const { router } = await supervised(workspace);
  process.kill(-router.child.pid, "SIGKILL");
  await router.closed;
  const missed = thread("1700000000000370001");
  seedThreads(workspace, { [missed.id]: missed });
  seedHistory(workspace, missed.id, [["missed-owner-1", owner, "look at the flaky test"]]);

  await startRouter(workspace);

  await threadRow(workspace, missed.id, row => row.state === "live");
  await waitFor(() => notifications(workspace, missed.id).length === 1, () => "the bootstrap", 15000);
  assert.equal(occurrences(notifications(workspace, missed.id)[0].content, "look at the flaky test"), 1);
});

test("a session that crashes while the supervisor runs is stopped/crashed, and the next owner message resumes it", async () => {
  const workspace = reconcileWorkspace();
  await supervised(workspace);
  const raw = thread("1700000000000370001");
  await liveThread(workspace, raw);
  const conversationId = (await threadRows(workspace))[raw.id].provider_conversation_id;

  const { pid } = readState(workspace.stateDir).fixtures.tmux.sessions[tmuxName(raw.id)];
  process.kill(-pid, "SIGKILL");
  await disconnected(workspace, raw.id);
  const crashed = await threadRow(workspace, raw.id, current => current.state === "stopped");
  assert.deepEqual([crashed.state, crashed.stop_reason], ["stopped", "crashed"]);
  // Claude keeps the transcript at <home>/projects/<cwd, non-alphanumerics as "-">/<id>.jsonl.
  const transcripts = path.join(workspace.homeDir, ".claude", "projects", workspace.tmpDir.replace(/[^A-Za-z0-9]/g, "-"));
  fs.mkdirSync(transcripts, { recursive: true });
  fs.writeFileSync(path.join(transcripts, `${conversationId}.jsonl`), "{}\n");

  threadMessage(workspace, raw.id, "after-crash", "are you still there?");

  const row = await threadRow(workspace, raw.id, current => current.state === "live");
  assert.equal(row.provider_conversation_id, conversationId);
  await waitFor(() => threadPosts(workspace, raw.id).length === 2, () => "the resumed session's reply", 15000);
  const invocations = claude(workspace).invocations;
  assert.equal(invocations.length, 2);
  assert.equal(invocations[1].args[invocations[1].args.indexOf("--resume") + 1].replace(/^'|'$/g, ""), conversationId);
  assert.ok(notifications(workspace, raw.id).some(notification =>
    String(notification.content).includes("are you still there?")), "the resumed bootstrap carries the message");
});

test("on restart, an owner's native reply to a root-bot message is root's and starts nothing", async () => {
  const workspace = reconcileWorkspace();
  const { supervisor } = await supervised(workspace);
  const raw = thread("1700000000000380001");
  threadEvent(workspace, raw, "create");
  await threadRow(workspace, raw.id);
  assert.equal((await supervisor.stop()).exitCode, 0);

  // Newest first, as Discord returns it: the owner replied to root's message after the agent's reply.
  const root = { id: "fixture-bot-user-id", username: "root", bot: true };
  const rootMessage = { id: "root-note", type: 0, channel_id: raw.id, content: "I archived the old branch",
    attachments: [], timestamp: "2026-09-30T10:02:00.000Z", author: root };
  updateState(workspace.stateDir, state => {
    (state.fixtures.discord.history ||= {})[raw.id] = [
      { id: "reply-to-root", type: 19, channel_id: raw.id, content: "thanks, which one?", attachments: [],
        timestamp: "2026-09-30T10:03:00.000Z", author: { id: OWNER_ID, username: "Owner" },
        message_reference: { message_id: "root-note", channel_id: raw.id }, referenced_message: rootMessage,
        mentions: [] },
      rootMessage,
      { id: "agent-reply", type: 0, channel_id: raw.id, content: "on it", attachments: [],
        timestamp: "2026-09-30T10:01:00.000Z", webhook_id: WEBHOOK_ID,
        author: { id: WEBHOOK_ID, username: "demo-claude", bot: true } },
      { id: "owner-ask", type: 0, channel_id: raw.id, content: "please fix the parser", attachments: [],
        timestamp: "2026-09-30T10:00:00.000Z", author: { id: OWNER_ID, username: "Owner" } },
    ];
  });

  await startThreadSupervisor(workspace, { env: ENV });
  await settle(2000);

  assert.equal((await threadRows(workspace))[raw.id].state, "registered");
  assert.deepEqual(claude(workspace).invocations ?? [], []);
});
