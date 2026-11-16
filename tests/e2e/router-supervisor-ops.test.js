import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { injectDiscordMessage } from "./support/bridge.js";
import { connectThread, createRouterWorkspace, rawRouterSocket, routerRegistry, routerWithWebhooks, runRouterCli,
  seedThreads, waitFor } from "./support/router.js";
import { readState, updateState } from "./support/state.js";
import { cleanup } from "./support/teardown.js";

test.afterEach(cleanup);

const ROOT_AUTH = "Bot root-bot-token";

// A raw client: `hello` is the Router's answer, `events` the pushed events,
// and `request(op, args, extra)` resolves with the op's response frame.
async function rawClient(workspace, hello) {
  const socket = await rawRouterSocket(workspace);
  socket.send({ type: "hello", v: 1, ...hello });
  const answer = await waitFor(() => socket.frames.find(frame => frame.type === "hello_ok" || frame.type === "hello_error"),
    () => `${hello.role} hello: ${JSON.stringify(socket.frames)}`);
  let requests = 0;
  return {
    ...socket,
    hello: answer,
    get events() { return socket.frames.filter(frame => frame.type === "event"); },
    send: socket.send,
    async request(op, args, extra = {}, timeoutMs = 5000) {
      const id = `request-${++requests}`;
      socket.send({ type: "request", id, op, args, ...extra });
      return waitFor(() => socket.frames.find(frame => frame.type === "response" && frame.id === id),
        () => `${op} response: ${JSON.stringify(socket.frames)}`, timeoutMs);
    },
  };
}

function connectSupervisor(workspace) {
  fs.writeFileSync(path.join(workspace.routerStateDir, "keys/.supervisor.key"), "supervisor-key\n", { mode: 0o600 });
  return rawClient(workspace, { role: "supervisor", key: "supervisor-key" });
}

const connectProject = workspace => rawClient(workspace, { role: "project", project: "demo", key: "demo-key" });

// demo's channel holds an eligible thread, a private thread and a forum-style
// thread; root, unregistered and `remote:` channels hold threads too.
async function supervisedRouter() {
  const workspace = createRouterWorkspace({
    ...routerRegistry({ far: { channel_id: "far-channel", type: "claude", path: "remote:mac:/srv/far" } }),
    root_channels: ["root-channel"],
  });
  seedThreads(workspace, {
    "demo-thread": { type: 11, parentId: "demo-channel", name: "Fix flaky test", ownerId: "owner-id",
      autoArchiveDuration: 10080 },
    "private-thread": { type: 12, parentId: "demo-channel" },
    "root-thread": { type: 11, parentId: "root-channel" },
    "stray-thread": { type: 11, parentId: "stray-channel" },
    "remote-thread": { type: 11, parentId: "far-channel" },
  });
  const router = await routerWithWebhooks(workspace, ["demo"]);
  const supervisor = await connectSupervisor(workspace);
  return { workspace, router, supervisor };
}

const discord = workspace => readState(workspace.stateDir).fixtures.discord;
const ok = response => {
  assert.equal(response.ok, true, JSON.stringify(response.error));
  return response.result;
};

test("thread_create makes a standalone public thread with a 10080-minute archive duration", async () => {
  const { workspace, supervisor } = await supervisedRouter();
  const thread = ok(await supervisor.request("thread_create", { channel_id: "demo-channel", name: "Port the parser" }));
  const [create] = discord(workspace).threadCreates;
  assert.deepEqual([create.channelId, create.messageId, create.authorization, create.body],
    ["demo-channel", null, ROOT_AUTH, { name: "Port the parser", type: 11, auto_archive_duration: 10080 }]);
  assert.deepEqual([thread.id, thread.type, thread.parent_id, thread.name, thread.thread_metadata.auto_archive_duration],
    [create.threadId, 11, "demo-channel", "Port the parser", 10080]);
});

test("thread_update PATCHes only archived and auto_archive_duration", async () => {
  const { workspace, supervisor } = await supervisedRouter();
  ok(await supervisor.request("thread_update", { thread_id: "demo-thread", archived: true, auto_archive_duration: 10080,
    name: "Renamed", locked: true }));
  ok(await supervisor.request("thread_update", { thread_id: "demo-thread", archived: false }));
  assert.deepEqual(discord(workspace).threadPatches.map(({ threadId, authorization, body }) => ({ threadId, authorization, body })), [
    { threadId: "demo-thread", authorization: ROOT_AUTH, body: { archived: true, auto_archive_duration: 10080 } },
    { threadId: "demo-thread", authorization: ROOT_AUTH, body: { archived: false } },
  ]);
});

test("thread_list returns eligible active threads and archived threads within archived_within_days", async () => {
  const { workspace, supervisor } = await supervisedRouter();
  const day = 24 * 60 * 60 * 1000;
  const ago = days => new Date(Date.now() - days * day).toISOString();
  seedThreads(workspace, {
    "old-thread": { type: 11, parentId: "demo-channel", archived: true, archiveTimestamp: ago(30) },
    "recent-thread": { type: 11, parentId: "demo-channel", archived: true, archiveTimestamp: ago(2) },
    "beta-thread": { type: 11, parentId: "beta-channel", archived: true, archiveTimestamp: ago(1) },
    "stray-archived": { type: 11, parentId: "stray-channel", archived: true, archiveTimestamp: ago(1) },
  });
  const listed = ok(await supervisor.request("thread_list", { archived_within_days: 7 }));
  const summary = listed.threads.map(thread => [thread.id, thread.project, thread.parent_id, thread.archived]);
  assert.deepEqual(summary.sort(), [
    ["beta-thread", "beta", "beta-channel", true],
    ["demo-thread", "demo", "demo-channel", false],
    ["recent-thread", "demo", "demo-channel", true],
  ]);
  const fetches = discord(workspace).threadListFetches;
  assert.ok(fetches.every(fetch => fetch.authorization === ROOT_AUTH));
  assert.deepEqual(fetches.filter(fetch => fetch.route === "active").map(fetch => fetch.guildId), ["guild-id"]);
  assert.ok(!fetches.some(fetch => ["stray-channel", "root-channel", "far-channel"].includes(fetch.channelId)));

  const demoOnly = ok(await supervisor.request("thread_list", { channel_id: "demo-channel", archived_within_days: 60 }));
  assert.deepEqual(demoOnly.threads.map(thread => thread.id).sort(), ["demo-thread", "old-thread", "recent-thread"]);
  assert.deepEqual(demoOnly.skipped_channels, []);
});

test("thread_list skips a registered channel Discord no longer has, logs it once, and lists the rest", async () => {
  const { workspace, router, supervisor } = await supervisedRouter();
  const ago = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  seedThreads(workspace, {
    "recent-thread": { type: 11, parentId: "demo-channel", archived: true, archiveTimestamp: ago },
    "beta-thread": { type: 11, parentId: "beta-channel", archived: true, archiveTimestamp: ago },
  });
  updateState(workspace.stateDir, state => { state.fixtures.discord.missingChannels = ["beta-channel"]; });

  for (let run = 0; run < 2; run++) {
    const listed = ok(await supervisor.request("thread_list", { archived_within_days: 7 }));
    assert.deepEqual(listed.threads.map(thread => thread.id).sort(), ["demo-thread", "recent-thread"]);
    assert.deepEqual(listed.skipped_channels, [{ project: "beta", channel_id: "beta-channel", status: 404 }]);
  }
  const logged = `${router.stdout}\n${router.stderr}`.split("\n").filter(line => line.includes("thread_list_skipped"));
  assert.equal(logged.length, 1, logged.join("\n"));
  assert.match(logged[0], /project=beta channel=beta-channel status=404/);
});

test("router status names a project whose registered channel no longer exists", async () => {
  const { workspace } = await supervisedRouter();
  updateState(workspace.stateDir, state => { state.fixtures.discord.missingChannels = ["beta-channel"]; });
  const json = JSON.parse((await runRouterCli(workspace, ["status", "--json"])).stdout);
  const byName = Object.fromEntries(json.projects.map(project => [project.project, project.channel_missing]));
  assert.deepEqual([byName.beta, byName.demo], [true, false]);
  const text = (await runRouterCli(workspace, ["status"])).stdout;
  assert.ok(text.split("\n").includes("missing channels: beta (beta-channel)"), text);
  assert.match(text, /^ {2}beta channel=beta-channel .* channel_missing$/m);
  assert.doesNotMatch(text, /^ {2}demo .*channel_missing$/m);
});

test("thread_history returns thread messages with their author class", async () => {
  const { workspace, supervisor } = await supervisedRouter();
  const registry = JSON.parse(fs.readFileSync(path.join(workspace.repoDir, "registry.json"), "utf8"));
  const webhookId = registry.projects.demo.webhook_id;
  updateState(workspace.stateDir, state => {
    state.fixtures.discord.history = { "demo-thread": [
      { id: "m4", content: "Stranger", timestamp: "2026-09-01T00:04:00Z", author: { id: "stranger-id", username: "s" } },
      { id: "m3", content: "Notice", timestamp: "2026-09-01T00:03:00Z", author: { id: "fixture-bot-user-id", bot: true } },
      { id: "m2", content: "Done.", timestamp: "2026-09-01T00:02:00Z", webhook_id: webhookId,
        author: { id: webhookId, username: "demo-claude · 10%", bot: true } },
      { id: "m1", content: "Guest here", timestamp: "2026-09-01T00:01:00Z", author: { id: "guest-id", username: "g" } },
      { id: "m0", content: "Fix it", timestamp: "2026-09-01T00:00:00Z", author: { id: "owner-id", username: "o" } },
    ] };
  });
  const history = ok(await supervisor.request("thread_history", { thread_id: "demo-thread", limit: 4, before: "m4" }));
  assert.deepEqual(history.messages.map(message => [message.id, message.content, message.author_class]), [
    ["m3", "Notice", "root_bot"], ["m2", "Done.", "project_webhook"], ["m1", "Guest here", "guest"], ["m0", "Fix it", "owner"],
  ]);
  const all = ok(await supervisor.request("thread_history", { thread_id: "demo-thread" }));
  assert.equal(all.messages.find(message => message.id === "m4").author_class, "other");
  const tooMany = await supervisor.request("thread_history", { thread_id: "demo-thread", limit: 101 });
  assert.equal(tooMany.error.code, "invalid_args");
  assert.deepEqual(discord(workspace).historyFetches.map(({ channelId, limit, before, authorization }) =>
    [channelId, limit, before, authorization]), [["demo-thread", 4, "m4", ROOT_AUTH], ["demo-thread", 100, undefined, ROOT_AUTH]]);
});

test("thread_message_get reads the starter message from the parent channel", async () => {
  const { workspace, supervisor } = await supervisedRouter();
  updateState(workspace.stateDir, state => {
    state.fixtures.discord.history = { "demo-channel": [
      { id: "demo-thread", content: "Can you fix the flaky test?", timestamp: "2026-09-01T00:00:00Z",
        author: { id: "owner-id", username: "o" } },
    ] };
  });
  const starter = ok(await supervisor.request("thread_message_get", { channel_id: "demo-channel", message_id: "demo-thread" }));
  assert.deepEqual([starter.id, starter.content, starter.author_class], ["demo-thread", "Can you fix the flaky test?", "owner"]);
  assert.deepEqual(discord(workspace).messageFetches.map(({ channelId, messageId, authorization }) => [channelId, messageId, authorization]),
    [["demo-channel", "demo-thread", ROOT_AUTH]]);
});

// A snowflake for a moment, as Discord derives ids from time.
const snowflake = ms => String((BigInt(ms) - 1420070400000n) << 22n);

test("thread_archive_actor returns the thread's action-111 entries since a moment, or forbidden", async () => {
  const { workspace, supervisor } = await supervisedRouter();
  const since = Date.parse("2026-09-10T00:00:00Z");
  updateState(workspace.stateDir, state => {
    state.fixtures.discord.auditLogEntries = [
      { id: snowflake(since + 2000), user_id: "owner-id", target_id: "demo-thread", action_type: 111,
        changes: [{ key: "archived", old_value: false, new_value: true }] },
      { id: snowflake(since + 1000), user_id: "owner-id", target_id: "other-thread", action_type: 111, changes: [] },
      { id: snowflake(since + 500), user_id: "owner-id", target_id: "demo-thread", action_type: 112, changes: [] },
      { id: snowflake(since - 1000), user_id: "fixture-bot-user-id", target_id: "demo-thread", action_type: 111, changes: [] },
    ];
  });
  const actor = ok(await supervisor.request("thread_archive_actor", { thread_id: "demo-thread",
    since: "2026-09-10T00:00:00Z" }));
  assert.deepEqual(actor.entries.map(entry => [entry.id, entry.user_id, entry.target_id]),
    [[snowflake(since + 2000), "owner-id", "demo-thread"]]);
  const [fetch] = discord(workspace).auditLogFetches;
  assert.deepEqual([fetch.guildId, fetch.actionType, fetch.authorization], ["guild-id", "111", ROOT_AUTH]);

  updateState(workspace.stateDir, state => { state.fixtures.discord.auditLogForbidden = true; });
  assert.deepEqual(ok(await supervisor.request("thread_archive_actor", { thread_id: "demo-thread", since: "2026-09-10T00:00:00Z" })),
    { forbidden: true });
});

test("thread_react adds and removes the bot's reaction in a project channel or its thread", async () => {
  const { workspace, supervisor } = await supervisedRouter();
  ok(await supervisor.request("thread_react", { channel_id: "demo-thread", message_id: "m1", emoji: "👀" }));
  ok(await supervisor.request("thread_react", { channel_id: "demo-thread", message_id: "m1", emoji: "👀", remove: true }));
  ok(await supervisor.request("thread_react", { channel_id: "demo-channel", message_id: "c1", emoji: "✅" }));
  const shape = ({ channelId, messageId, emoji, authorization }) => [channelId, messageId, decodeURIComponent(emoji), authorization];
  assert.deepEqual(discord(workspace).reactions.map(shape),
    [["demo-thread", "m1", "👀", ROOT_AUTH], ["demo-channel", "c1", "✅", ROOT_AUTH]]);
  assert.deepEqual(discord(workspace).reactionDeletes.map(shape), [["demo-thread", "m1", "👀", ROOT_AUTH]]);
});

test("thread_notice posts as the root bot with no mentions parsed", async () => {
  const { workspace, supervisor } = await supervisedRouter();
  const notice = ok(await supervisor.request("thread_notice", { channel_id: "demo-thread",
    text: "Paused to free a session slot; send a message here to resume. <@owner-id>" }));
  ok(await supervisor.request("thread_notice", { channel_id: "demo-channel", text: "Queued, 2 sessions busy." }));
  const messages = discord(workspace).messages.map(({ id, channelId, content, authorization, webhookId, allowedMentions }) =>
    ({ id, channelId, content, authorization, webhookId, allowedMentions }));
  assert.deepEqual(messages.map(({ id: _id, ...message }) => message), [
    { channelId: "demo-thread", content: "Paused to free a session slot; send a message here to resume. <@owner-id>", authorization: ROOT_AUTH,
      webhookId: undefined, allowedMentions: { parse: [] } },
    { channelId: "demo-channel", content: "Queued, 2 sessions busy.", authorization: ROOT_AUTH,
      webhookId: undefined, allowedMentions: { parse: [] } },
  ]);
  assert.equal(notice.message_id, messages[0].id);
});

test("thread_revoke revokes that thread's connections and reports it to the supervisor", async () => {
  const { workspace, supervisor } = await supervisedRouter();
  seedThreads(workspace, { "sibling-thread": { type: 11, parentId: "demo-channel" } });
  const thread = await connectThread(workspace, { threadId: "demo-thread" });
  const ops = await connectThread(workspace, { threadId: "demo-thread", key: "demo-thread-key", listener: false });
  const sibling = await connectThread(workspace, { threadId: "sibling-thread" });
  ok(await supervisor.request("thread_revoke", { thread_id: "demo-thread", reason: "closed" }));
  await Promise.all([thread.closed, ops.closed]);
  assert.deepEqual(thread.events.map(event => [event.event, event.reason]), [["revoked", "closed"]]);
  assert.deepEqual(ops.events.map(event => [event.event, event.reason]), [["revoked", "closed"]]);
  assert.deepEqual(supervisor.events.filter(event => event.event === "thread_session_revoked")
    .map(({ project, thread_id: threadId, reason }) => [project, threadId, reason]), [["demo", "demo-thread", "closed"]]);
  assert.equal((await sibling.request("typing", { channel_id: "sibling-thread" })).ok, true);
});

const TARGETS = {
  "root channel": "root-channel",
  "unregistered channel": "stray-channel",
  "remote: channel": "far-channel",
  "private thread": "private-thread",
  "thread in a root channel": "root-thread",
  "thread under an unregistered parent": "stray-thread",
  "thread under a remote: parent": "remote-thread",
};

const CALLS = {
  thread_create: id => ({ channel_id: id, name: "Task" }),
  thread_update: id => ({ thread_id: id, archived: true }),
  thread_list: id => ({ channel_id: id }),
  thread_history: id => ({ thread_id: id }),
  thread_message_get: id => ({ channel_id: id, message_id: "m1" }),
  thread_archive_actor: id => ({ thread_id: id, since: "2026-09-10T00:00:00Z" }),
  thread_react: id => ({ channel_id: id, message_id: "m1", emoji: "👀" }),
  thread_notice: id => ({ channel_id: id, text: "Hello" }),
  thread_notice_delete: id => ({ channel_id: id, message_id: "m1" }),
  thread_revoke: id => ({ thread_id: id, reason: "closed" }),
};

test("every supervisor op refuses root, unregistered, remote:, private and stray-thread targets", async () => {
  const { workspace, supervisor } = await supervisedRouter();
  const codes = {};
  for (const [op, args] of Object.entries(CALLS)) {
    for (const [name, id] of Object.entries(TARGETS)) codes[`${op} ${name}`] = (await supervisor.request(op, args(id))).error?.code;
  }
  assert.deepEqual(Object.entries(codes).filter(([, code]) => code !== "scope_violation"), []);
  // The thread-only ops refuse the project channel itself; channel-only ops refuse a thread.
  for (const op of ["thread_update", "thread_history", "thread_archive_actor", "thread_notice_delete", "thread_revoke"]) {
    assert.equal((await supervisor.request(op, CALLS[op]("demo-channel"))).error?.code, "scope_violation", op);
  }
  for (const op of ["thread_create", "thread_list"]) {
    assert.equal((await supervisor.request(op, CALLS[op]("demo-thread"))).error?.code, "scope_violation", op);
  }
  const state = discord(workspace);
  assert.deepEqual([state.threadCreates, state.threadPatches, state.messages, state.reactions, state.auditLogFetches]
    .map(calls => calls ?? []), [[], [], [], [], []]);
});

test("project and thread connections calling a supervisor op are forbidden", async () => {
  const { workspace } = await supervisedRouter();
  const project = await connectProject(workspace);
  const thread = await connectThread(workspace, { threadId: "demo-thread" });
  const calls = { ...CALLS, thread_request_done: () => ({ request_id: "r", ok: true, thread_id: "demo-thread" }),
    status_board_list: () => ({}), status_board_post: () => ({ text: "x" }),
    status_board_edit: () => ({ message_id: "m", text: "x" }), status_board_delete: () => ({ message_id: "m" }) };
  for (const op of Object.keys(calls)) {
    assert.equal((await project.request(op, calls[op]("demo-channel"))).error?.code, "forbidden", `project ${op}`);
    assert.equal((await thread.request(op, calls[op]("demo-thread"))).error?.code, "forbidden", `thread ${op}`);
  }
  assert.equal((await thread.request("create_thread", { channel_id: "demo-thread", name: "Task" })).error?.code, "forbidden");
});

test("create_thread from a channel session round-trips through the supervisor", async () => {
  const { workspace, supervisor } = await supervisedRouter();
  const project = await connectProject(workspace);
  const pending = project.request("create_thread", { channel_id: "demo-channel", name: "Port the parser", provider: "codex",
    model: "gpt-5.5", effort: "high", first_message: "Start with the lexer." });
  const request = await waitFor(() => supervisor.events.find(event => event.event === "thread_create_request"),
    () => `thread_create_request: ${JSON.stringify(supervisor.frames)}`);
  assert.deepEqual({ ...request, request_id: typeof request.request_id }, {
    type: "event", event: "thread_create_request", request_id: "string", project: "demo", channel_id: "demo-channel",
    name: "Port the parser", provider: "codex", model: "gpt-5.5", effort: "high", first_message: "Start with the lexer.",
    requester: { kind: "channel-agent", project: "demo" },
  });
  assert.ok(request.request_id.length > 0);
  ok(await supervisor.request("thread_request_done", { request_id: request.request_id, ok: true, thread_id: "1600000000000000001" }));
  assert.deepEqual(ok(await pending), { thread_id: "1600000000000000001" });

  const failing = project.request("create_thread", { channel_id: "demo-channel", name: "Second" });
  const second = await waitFor(() => supervisor.events.filter(event => event.event === "thread_create_request")[1],
    () => "second thread_create_request");
  ok(await supervisor.request("thread_request_done", { request_id: second.request_id, ok: false,
    error: { code: "cap_reached", message: "Queued, 2 sessions busy." } }));
  assert.deepEqual((await failing).error, { code: "cap_reached", message: "Queued, 2 sessions busy." });
  assert.equal((await supervisor.request("thread_request_done", { request_id: second.request_id, ok: true })).error?.code,
    "not_found");
});

test("create_thread is scope_violation off the session's channel, times out, and fails when its supervisor goes", async () => {
  const { workspace, supervisor } = await supervisedRouter();
  const project = await connectProject(workspace);
  assert.equal((await project.request("create_thread", { channel_id: "beta-channel", name: "Task" })).error?.code, "scope_violation");
  assert.equal((await project.request("create_thread", { channel_id: "demo-thread", name: "Task" })).error?.code, "scope_violation");

  const started = Date.now();
  const late = await project.request("create_thread", { channel_id: "demo-channel", name: "Slow" },
    { deadline_at: Date.now() + 300 });
  assert.equal(late.error?.code, "timeout");
  assert.ok(Date.now() - started < 3000);
  const [unanswered] = supervisor.events.filter(event => event.event === "thread_create_request");
  assert.equal((await supervisor.request("thread_request_done", { request_id: unanswered.request_id, ok: true })).error?.code,
    "not_found");

  // A pending request whose supervisor goes (here, replaced) fails at once.
  const orphaned = project.request("create_thread", { channel_id: "demo-channel", name: "Orphaned" });
  await waitFor(() => supervisor.events.filter(event => event.event === "thread_create_request").length === 2,
    () => "the orphaned request at the supervisor");
  await connectSupervisor(workspace);
  await supervisor.closed;
  assert.equal((await orphaned).error?.code, "supervisor_unavailable");
});

test("create_thread fails at once with supervisor_unavailable when no supervisor is connected", async () => {
  const workspace = createRouterWorkspace();
  await routerWithWebhooks(workspace, ["demo"]);
  const project = await connectProject(workspace);
  const started = Date.now();
  assert.equal((await project.request("create_thread", { channel_id: "demo-channel", name: "Task" })).error?.code,
    "supervisor_unavailable");
  assert.ok(Date.now() - started < 1000);
});

const NUMERIC_PROJECT_CHANNEL = "1700000000000777003";
const NUMERIC_ROOT_CHANNEL = "1700000000000777002";

// The thread status board's channel, set in the registry.
async function boardRouter(statusChannel = "1700000000000777001") {
  const workspace = createRouterWorkspace({
    ...routerRegistry({ far: { channel_id: "far-channel", type: "claude", path: "remote:mac:/srv/far" },
      // A project and a root channel with snowflake ids, which a status channel may not reuse.
      numeric: { channel_id: NUMERIC_PROJECT_CHANNEL, type: "claude", path: "remote:mac:/srv/numeric" } }),
    root_channels: ["root-channel", NUMERIC_ROOT_CHANNEL],
    ...(statusChannel === null ? {} : { thread_status_channel_id: statusChannel }),
  });
  seedThreads(workspace, {
    "demo-thread": { type: 11, parentId: "demo-channel", name: "Fix flaky test", ownerId: "owner-id" },
    "sibling-thread": { type: 11, parentId: "demo-channel", name: "Sibling" },
    "root-thread": { type: 11, parentId: "root-channel" },
  });
  const router = await routerWithWebhooks(workspace, ["demo"]);
  const supervisor = await connectSupervisor(workspace);
  return { workspace, router, supervisor };
}

const posted = workspace => (discord(workspace).messages ?? []).map(({ id, channelId, content, authorization, allowedMentions }) =>
  ({ id, channelId, content, authorization, allowedMentions }));

test("thread_notice with mention_owner pings only the owner, in a thread only", async () => {
  const { workspace, supervisor } = await boardRouter();
  const ping = ok(await supervisor.request("thread_notice", { channel_id: "demo-thread", text: "🔔 {owner} ready for you",
    mention_owner: true }));
  assert.deepEqual(posted(workspace), [{ id: ping.message_id, channelId: "demo-thread", content: "🔔 <@owner-id> ready for you",
    authorization: ROOT_AUTH, allowedMentions: { parse: [], users: ["owner-id"] } }]);

  const refused = async (args, code) => assert.equal((await supervisor.request("thread_notice",
    { channel_id: "demo-thread", mention_owner: true, ...args })).error?.code, code, JSON.stringify(args));
  await refused({ text: "ready for you" }, "invalid_args");
  await refused({ text: "{owner} and {owner}" }, "invalid_args");
  await refused({ text: "{owner} and <@guest-id>" }, "invalid_args");
  await refused({ text: "{owner} @everyone" }, "invalid_args");
  await refused({ text: "{owner} <@&role-id>" }, "invalid_args");
  await refused({ text: `{owner} ${"x".repeat(300)}` }, "invalid_args");
  await refused({ text: "{owner}", mention_owner: "yes" }, "invalid_args");
  for (const target of ["demo-channel", "root-channel", "root-thread", "stray-channel"]) {
    assert.equal((await supervisor.request("thread_notice", { channel_id: target, text: "{owner}", mention_owner: true }))
      .error?.code, "scope_violation", target);
  }
  assert.equal(posted(workspace).length, 1);
});

test("thread_notice_delete deletes only root's own message in that thread", async () => {
  const { workspace, supervisor } = await boardRouter();
  const ping = ok(await supervisor.request("thread_notice", { channel_id: "demo-thread", text: "🔔 {owner} ready",
    mention_owner: true }));
  const registry = JSON.parse(fs.readFileSync(path.join(workspace.repoDir, "registry.json"), "utf8"));
  updateState(workspace.stateDir, state => {
    state.fixtures.discord.history = { "demo-thread": [
      { id: "agent-reply", content: "Done.", webhook_id: registry.projects.demo.webhook_id,
        author: { id: registry.projects.demo.webhook_id, bot: true } },
      { id: "owner-message", content: "Fix it", author: { id: "owner-id" } },
    ] };
  });
  const refused = async (channel, message) => assert.equal((await supervisor.request("thread_notice_delete",
    { channel_id: channel, message_id: message })).error?.code, "scope_violation", `${channel} ${message}`);
  // A sibling thread does not hold the ping: nothing to delete there.
  assert.deepEqual(ok(await supervisor.request("thread_notice_delete", { channel_id: "sibling-thread",
    message_id: ping.message_id })), { deleted: false });
  await refused("demo-thread", "agent-reply");
  await refused("demo-thread", "owner-message");
  await refused("demo-channel", ping.message_id);
  assert.deepEqual(ok(await supervisor.request("thread_notice_delete", { channel_id: "demo-thread", message_id: ping.message_id })),
    { deleted: true });
  assert.deepEqual(ok(await supervisor.request("thread_notice_delete", { channel_id: "demo-thread", message_id: ping.message_id })),
    { deleted: false });
  assert.deepEqual((discord(workspace).deletes ?? []).map(({ channelId, messageId }) => [channelId, messageId]),
    [["demo-thread", ping.message_id]]);
});

test("status board ops post, edit, list and delete root's messages in the status channel only", async () => {
  const { workspace, supervisor } = await boardRouter();
  const first = ok(await supervisor.request("status_board_post", { text: "-# CCDM threads · 1/1\n🔔 <#demo-thread>" }));
  assert.equal(first.channel_id, "1700000000000777001");
  assert.deepEqual(posted(workspace), [{ id: first.message_id, channelId: "1700000000000777001",
    content: "-# CCDM threads · 1/1\n🔔 <#demo-thread>", authorization: ROOT_AUTH, allowedMentions: { parse: [] } }]);
  ok(await supervisor.request("status_board_edit", { message_id: first.message_id, text: "-# CCDM threads · 1/1\n⏳" }));
  assert.deepEqual(discord(workspace).edits.map(({ channelId, messageId, content, authorization }) =>
    [channelId, messageId, content, authorization]), [["1700000000000777001", first.message_id, "-# CCDM threads · 1/1\n⏳", ROOT_AUTH]]);

  // Another user's message there, a webhook message, or a message elsewhere is not the board's.
  updateState(workspace.stateDir, state => {
    state.fixtures.discord.history = { "1700000000000777001": [
      { id: "board-old", content: "-# CCDM threads · 1/1", author: { id: "fixture-bot-user-id", bot: true } },
      { id: "someone", content: "hello", author: { id: "owner-id" } },
      { id: "hooked", content: "x", webhook_id: "hook-id", author: { id: "hook-id", bot: true } },
    ], "demo-channel": [{ id: "elsewhere", content: "x", author: { id: "fixture-bot-user-id", bot: true } }] };
  });
  const listed = ok(await supervisor.request("status_board_list", { limit: 10 }));
  assert.deepEqual(listed.messages.map(message => [message.id, message.content]), [["board-old", "-# CCDM threads · 1/1"]]);
  for (const id of ["someone", "hooked"]) {
    assert.equal((await supervisor.request("status_board_edit", { message_id: id, text: "x" })).error?.code, "scope_violation", id);
    assert.equal((await supervisor.request("status_board_delete", { message_id: id })).error?.code, "scope_violation", id);
  }
  // A message in another channel is not in the status channel at all.
  assert.equal((await supervisor.request("status_board_edit", { message_id: "elsewhere", text: "x" })).error?.code, "not_found");
  assert.deepEqual(ok(await supervisor.request("status_board_delete", { message_id: "elsewhere" })), { deleted: false });
  assert.equal((await supervisor.request("status_board_edit", { message_id: "gone", text: "x" })).error?.code, "not_found");
  assert.equal((await supervisor.request("status_board_post", { text: "" })).error?.code, "invalid_args");
  assert.equal((await supervisor.request("status_board_post", { text: "x".repeat(2001) })).error?.code, "invalid_args");
  assert.equal((await supervisor.request("status_board_list", { limit: 51 })).error?.code, "invalid_args");
  // A channel_id argument changes nothing: the target is always the registry's.
  const other = ok(await supervisor.request("status_board_post", { channel_id: "demo-channel", text: "-# CCDM threads" }));
  assert.equal(other.channel_id, "1700000000000777001");
  assert.deepEqual(ok(await supervisor.request("status_board_delete", { message_id: first.message_id })), { deleted: true });
  assert.deepEqual(new Set(posted(workspace).map(message => message.channelId)), new Set(["1700000000000777001"]));
});

test("status board ops fail status_channel_unset without the registry key, and nothing is sent", async () => {
  const { workspace, supervisor } = await boardRouter(null);
  for (const [op, args] of [["status_board_post", { text: "x" }], ["status_board_edit", { message_id: "m", text: "x" }],
    ["status_board_list", {}], ["status_board_delete", { message_id: "m" }]]) {
    assert.equal((await supervisor.request(op, args)).error?.code, "status_channel_unset", op);
  }
  assert.deepEqual(discord(workspace).messages ?? [], []);
});

test("an invalid thread_status_channel_id turns the board off, shown in router status, while the registry loads", async () => {
  const notAnId = "thread_status_channel_id must be a Discord channel ID (17-20 digits)";
  for (const [value, error] of [[NUMERIC_PROJECT_CHANNEL, "thread_status_channel_id is project numeric's channel"],
    [NUMERIC_ROOT_CHANNEL, "thread_status_channel_id is a root channel"], [{ id: 1 }, notAnId],
    // A path, a padded id, a non-snowflake word and the example's placeholder are all not ids.
    ["../status/1700000000000777001", notAnId], [" 1700000000000777001", notAnId], ["demo-channel", notAnId],
    ["YOUR_THREAD_STATUS_CHANNEL_ID", notAnId]]) {
    const { workspace, supervisor } = await boardRouter(value);
    assert.equal((await supervisor.request("status_board_post", { text: "x" })).error?.code, "status_channel_invalid");
    const text = (await runRouterCli(workspace, ["status"])).stdout;
    assert.ok(text.split("\n").includes(`thread status channel: off (invalid: ${error})`), text);
    assert.doesNotMatch(text, /registry error/);
    const json = JSON.parse((await runRouterCli(workspace, ["status", "--json"])).stdout);
    assert.deepEqual(json.status_channel, { channel_id: null, error, missing_permissions: null });
    assert.equal(json.registry_error, null);
    // Every project still routes.
    const project = await connectProject(workspace);
    assert.equal((await project.request("typing", { channel_id: "demo-channel" })).ok, true);
    await cleanup();
  }
});

test("router status reports the status channel and root's missing permissions there", async () => {
  const { workspace } = await boardRouter();
  assert.match((await runRouterCli(workspace, ["status"])).stdout, /^thread status channel: 1700000000000777001 permissions=ok$/m);
  updateState(workspace.stateDir, state => {
    state.fixtures.discord.permissionDenials = { "fixture-bot-user-id": ["SendMessages"] };
  });
  const json = JSON.parse((await runRouterCli(workspace, ["status", "--json"])).stdout);
  assert.deepEqual(json.status_channel, { channel_id: "1700000000000777001", error: null, missing_permissions: ["SendMessages"] });
});

test("a native reply to an owner ping reaches the thread session, not root", async () => {
  const { workspace, supervisor } = await boardRouter();
  const thread = await connectThread(workspace, { threadId: "demo-thread" });
  const ping = ok(await supervisor.request("thread_notice", { channel_id: "demo-thread", text: "🔔 {owner} ready for you",
    mention_owner: true }));
  const notice = ok(await supervisor.request("thread_notice", { channel_id: "demo-thread", text: "Restarting." }));
  injectDiscordMessage(workspace, { id: "reply-to-ping", channelId: "demo-thread", content: "go on", replyTo: ping.message_id,
    author: { id: "owner-id", username: "Owner" } });
  await waitFor(() => thread.events.some(event => event.message_id === "reply-to-ping"), () => "the reply at the thread");
  const supervised = await waitFor(() => supervisor.events.find(event => event.event === "thread_message"
    && event.message_id === "reply-to-ping"), () => "the supervisor's copy");
  assert.deepEqual([supervised.to_root, supervised.delivered_to_session], [false, true]);
  // A native reply to any other root-bot message is still root's.
  injectDiscordMessage(workspace, { id: "reply-to-notice", channelId: "demo-thread", content: "why?", replyTo: notice.message_id,
    author: { id: "owner-id", username: "Owner" } });
  const toRoot = await waitFor(() => supervisor.events.find(event => event.event === "thread_message"
    && event.message_id === "reply-to-notice"), () => "the supervisor's copy of the reply to the notice");
  assert.equal(toRoot.to_root, true);
  assert.ok(!thread.events.some(event => event.message_id === "reply-to-notice"));

  // A ping this Router does not remember (one posted before a restart) is
  // known by its exact text; a root message that only looks like one is not.
  const remembered = ok(await supervisor.request("thread_notice", { channel_id: "demo-thread",
    text: "🔔 <@owner-id> ready for you" }));
  const lookalike = ok(await supervisor.request("thread_notice", { channel_id: "demo-thread",
    text: "🔔 <@owner-id> ready for you!" }));
  for (const [id, replyTo, toThread] of [["reply-to-old-ping", remembered.message_id, true],
    ["reply-to-lookalike", lookalike.message_id, false]]) {
    injectDiscordMessage(workspace, { id, channelId: "demo-thread", content: "and?", replyTo,
      author: { id: "owner-id", username: "Owner" } });
    const copy = await waitFor(() => supervisor.events.find(event => event.event === "thread_message"
      && event.message_id === id), () => `the supervisor's copy of ${id}`);
    assert.equal(copy.to_root, !toThread, id);
  }
  await waitFor(() => thread.events.some(event => event.message_id === "reply-to-old-ping"), () => "the old ping's reply");
  assert.ok(!thread.events.some(event => event.message_id === "reply-to-lookalike"));
});
