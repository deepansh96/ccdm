import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { injectDiscordMessage } from "./support/bridge.js";
import { OWNER_ID, connectRoot, connectSession, createRouterWorkspace, rawRouterSocket,
  routerEnv, routerRegistry, routerWithWebhooks, runRouterCli, waitFor, writeRootKey } from "./support/router.js";
import { readState, updateState } from "./support/state.js";
import { cleanup } from "./support/teardown.js";

test.afterEach(cleanup);

async function listeners() {
  const workspace = createRouterWorkspace({ ...routerRegistry(), root_channels: ["root-channel"] });
  writeRootKey(workspace, "root-key");
  fs.writeFileSync(path.join(workspace.routerStateDir, "keys/.observer.key"), "observer-key\n", { mode: 0o600 });
  await routerWithWebhooks(workspace, ["demo"]);
  const root = await connectRoot(workspace, "root-key");
  const demo = await connectSession(workspace, "demo", "demo-key");
  const observer = await rawRouterSocket(workspace);
  observer.send({ type: "hello", v: 1, role: "observer", key: "observer-key" });
  await waitFor(() => observer.frames.some(frame => frame.type === "hello_ok"), () => "observer hello");
  return { workspace, root, demo, observer };
}

function inject(workspace, id, extra = {}) {
  injectDiscordMessage(workspace, { id, channelId: "demo-channel", content: id,
    author: { id: OWNER_ID, username: "Owner" }, ...extra });
}

async function fence({ workspace, root, demo, observer }) {
  inject(workspace, "channel-fence");
  inject(workspace, "root-fence", { channelId: "root-channel" });
  await waitFor(() => demo.events.some(event => event.message_id === "channel-fence") &&
    root.events.some(event => event.message_id === "root-fence") &&
    observer.frames.some(frame => frame.message_id === "channel-fence"), () => "all listener fences");
}

const ids = events => events.filter(event => event.message_id && !event.message_id.endsWith("-fence"))
  .map(event => event.message_id);

// Exercise the local fake's external API contract without adding future Router ops.
function fixtureScript(workspace, script) {
  return JSON.parse(execFileSync(process.execPath, ["-e", script], {
    cwd: workspace.repoDir, env: routerEnv(workspace), encoding: "utf8", timeout: 5000,
  }));
}

test("system messages reach no Channel Conversation, root session or reminder observer", async () => {
  const sessions = await listeners();
  for (const type of [18, 21, 6, 1, 7, 20]) {
    inject(sessions.workspace, `system-${type}`, { type });
    inject(sessions.workspace, `mention-${type}`, { type, content: "<@fixture-bot-user-id>" });
    inject(sessions.workspace, `root-${type}`, { type, channelId: "root-channel" });
  }
  await fence(sessions);
  assert.deepEqual({ channel: ids(sessions.demo.events), root: ids(sessions.root.events),
    observer: ids(sessions.observer.frames) }, { channel: [], root: [], observer: [] });
  assert.deepEqual(readState(sessions.workspace.stateDir).fixtures.discord.reactions ?? [], []);
});

test("type 19 replies retain root-bot and Project Identity routing", async () => {
  const sessions = await listeners();
  const { workspace, demo } = sessions;
  inject(workspace, "root-said", { author: { id: "fixture-bot-user-id", bot: true } });
  const reply = await demo.client.request("reply", { channel_id: "demo-channel", text: "Tests passed." });
  inject(workspace, "reply-to-root", { type: 19, replyTo: "root-said" });
  inject(workspace, "reply-to-project", { type: 19, replyTo: reply.message_id });
  await fence(sessions);
  assert.deepEqual(ids(sessions.root.events), ["reply-to-root"]);
  assert.deepEqual(ids(demo.events), ["reply-to-project"]);
});

test("a thread message never reaches the parent Channel Conversation", async () => {
  const sessions = await listeners();
  inject(sessions.workspace, "thread-message", { channelId: "demo-thread", channelType: 11,
    parentId: "demo-channel" });
  await fence(sessions);
  assert.deepEqual({ channel: ids(sessions.demo.events), root: ids(sessions.root.events),
    observer: ids(sessions.observer.frames) }, { channel: [], root: [], observer: [] });
});

test("the REST fake executes and edits webhook messages in the requested thread", async () => {
  const workspace = createRouterWorkspace();
  const setup = await runRouterCli(workspace, ["ensure-webhook", "demo"]);
  assert.equal(setup.exitCode, 0, setup.stderr);
  const result = fixtureScript(workspace, `(async () => {
    const [webhook] = await (await fetch('https://discord.com/api/v10/channels/demo-channel/webhooks')).json();
    const base = 'https://discord.com/api/v10/webhooks/' + webhook.id + '/' + webhook.token;
    const sent = await (await fetch(base + '?wait=true&thread_id=demo-thread', {
      method: 'POST', body: JSON.stringify({ content: 'Thread reply', username: 'demo-codex · 42%' })
    })).json();
    const edited = await (await fetch(base + '/messages/' + sent.id + '?thread_id=demo-thread', {
      method: 'PATCH', body: JSON.stringify({ content: 'Updated reply' })
    })).json();
    const wrongThread = await fetch(base + '/messages/' + sent.id + '?thread_id=sibling-thread', {
      method: 'PATCH', body: JSON.stringify({ content: 'Wrong thread' })
    });
    console.log(JSON.stringify({ sent: sent.channel_id, edited: edited.channel_id, wrongThread: wrongThread.status }));
  })()`);
  assert.deepEqual(result, { sent: "demo-thread", edited: "demo-thread", wrongThread: 404 });
  const discord = readState(workspace.stateDir).fixtures.discord;
  assert.deepEqual(discord.messages.map(({ channelId, content, username }) => ({ channelId, content, username })),
    [{ channelId: "demo-thread", content: "Updated reply", username: "demo-codex · 42%" }]);
});

test("the Gateway shim exposes thread channels and emits thread and shard lifecycle events", () => {
  const workspace = createRouterWorkspace();
  updateState(workspace.stateDir, state => {
    state.fixtures.discord.threads = {
      'demo-thread': { id: 'demo-thread', type: 11, parentId: 'demo-channel', name: 'Task' },
    };
    state.fixtures.discord.injectedThreads = [
      { id: 'demo-thread', event: 'create', type: 11, parentId: 'demo-channel' },
      { id: 'demo-thread', event: 'update', type: 11, parentId: 'demo-channel', archived: true,
        previous: { id: 'demo-thread', type: 11, parentId: 'demo-channel', archived: false } },
      { id: 'demo-thread', event: 'delete', type: 11, parentId: 'demo-channel' },
    ];
    state.fixtures.discord.injectedGatewayEvents = [{ event: 'shardResume' }, { event: 'shardReady' }];
  });
  const result = fixtureScript(workspace, `(async () => {
    const { Client } = require('discord.js');
    const client = new Client();
    const events = [];
    const shape = c => ({ id: c.id, type: c.type, parentId: c.parentId, isThread: c.isThread() });
    client.on('threadCreate', (thread, fresh) => events.push(['create', shape(thread), fresh]));
    client.on('threadUpdate', (before, after) => events.push(['update', before.archived, after.archived]));
    client.on('threadDelete', thread => events.push(['delete', thread.id]));
    client.on('shardResume', () => events.push(['resume']));
    const done = new Promise(resolve => client.on('shardReady', () => { events.push(['ready']); resolve(); }));
    const keepAlive = setTimeout(() => { throw new Error('Missing Gateway events'); }, 2000);
    await client.login('root-bot-token');
    const channel = await client.channels.fetch('demo-thread');
    await done;
    clearTimeout(keepAlive);
    client.destroy();
    console.log(JSON.stringify({ channel: shape(channel), events }));
  })()`);
  assert.deepEqual(result, {
    channel: { id: 'demo-thread', type: 11, parentId: 'demo-channel', isThread: true },
    events: [ ['create', { id: 'demo-thread', type: 11, parentId: 'demo-channel', isThread: true }, true],
      ['update', false, true], ['delete', 'demo-thread'], ['resume'], ['ready'] ],
  });
});

test("the REST fake creates a public thread with Discord channel metadata", () => {
  const workspace = createRouterWorkspace();
  const result = fixtureScript(workspace, `(async () => {
    const res = await fetch('https://discord.com/api/v10/channels/demo-channel/threads', {
      method: 'POST', headers: { Authorization: 'Bot root-bot-token' },
      body: JSON.stringify({ name: 'Task', type: 11, auto_archive_duration: 10080 })
    });
    console.log(JSON.stringify({ status: res.status, body: await res.json() }));
  })()`);
  assert.equal(result.status, 201);
  assert.equal(result.body.id, '1600000000000000001');
  assert.equal(result.body.parent_id, 'demo-channel');
  assert.equal(result.body.type, 11);
  assert.equal(result.body.thread_metadata.auto_archive_duration, 10080);
});

test("the REST fake archives and reopens a thread through channel PATCH", () => {
  const workspace = createRouterWorkspace();
  updateState(workspace.stateDir, state => {
    state.fixtures.discord.threads = { 'demo-thread': { id: 'demo-thread', type: 11,
      parentId: 'demo-channel', name: 'Task', archived: false, autoArchiveDuration: 1440 } };
  });
  const result = fixtureScript(workspace, `(async () => {
    const patch = async body => (await fetch('https://discord.com/api/v10/channels/demo-thread', {
      method: 'PATCH', headers: { Authorization: 'Bot root-bot-token' }, body: JSON.stringify(body)
    })).json();
    const archived = await patch({ archived: true, auto_archive_duration: 10080 });
    const reopened = await patch({ archived: false });
    console.log(JSON.stringify({ archived, reopened }));
  })()`);
  assert.equal(result.archived.thread_metadata?.archived, true);
  assert.equal(result.reopened.thread_metadata.archived, false);
  assert.equal(result.reopened.thread_metadata.auto_archive_duration, 10080);
  assert.equal(result.reopened.parent_id, 'demo-channel');
});

test("the REST fake lists active threads and pages public archives by timestamp", () => {
  const workspace = createRouterWorkspace();
  updateState(workspace.stateDir, state => {
    const base = { type: 11, parentId: 'demo-channel', autoArchiveDuration: 10080 };
    state.fixtures.discord.threads = {
      live: { ...base, id: 'live', archived: false },
      newer: { ...base, id: 'newer', archived: true, archiveTimestamp: '2026-09-30T10:00:00Z' },
      older: { ...base, id: 'older', archived: true, archiveTimestamp: '2026-09-29T10:00:00Z' },
      private: { ...base, id: 'private', type: 12, archived: true },
      other: { ...base, id: 'other', parentId: 'other-channel', archived: true },
    };
  });
  const result = fixtureScript(workspace, `(async () => {
    const get = async route => (await fetch('https://discord.com/api/v10/' + route)).json();
    const active = await get('guilds/guild-id/threads/active');
    const first = await get('channels/demo-channel/threads/archived/public?limit=1');
    const next = await get('channels/demo-channel/threads/archived/public?limit=1&before=2026-09-30T10:00:00Z');
    console.log(JSON.stringify({ active, first, next }));
  })()`);
  assert.deepEqual(result.active.threads?.map(t => t.id), ['live']);
  assert.deepEqual(result.first.threads.map(t => t.id), ['newer']);
  assert.equal(result.first.has_more, true);
  assert.deepEqual(result.next.threads.map(t => t.id), ['older']);
  assert.equal(result.next.has_more, false);
});

test("the REST fake filters audit entries and reports forbidden audit-log access", () => {
  const workspace = createRouterWorkspace();
  updateState(workspace.stateDir, state => {
    state.fixtures.discord.auditLogEntries = [
      { id: 'audit-thread', action_type: 111, target_id: 'demo-thread', user_id: OWNER_ID },
      { id: 'audit-other', action_type: 72, target_id: 'demo-channel', user_id: OWNER_ID },
    ];
  });
  const request = `fetch('https://discord.com/api/v10/guilds/guild-id/audit-logs?action_type=111&limit=1')
    .then(async r => console.log(JSON.stringify({ status: r.status, body: await r.json() })))`;
  const allowed = fixtureScript(workspace, request);
  assert.equal(allowed.status, 200);
  assert.deepEqual(allowed.body.audit_log_entries.map(e => e.id), ['audit-thread']);
  updateState(workspace.stateDir, state => { state.fixtures.discord.auditLogForbidden = true; });
  assert.deepEqual(fixtureScript(workspace, request), { status: 403, body: { code: 50013, message: 'Missing Permissions' } });
  assert.equal(readState(workspace.stateDir).fixtures.discord.auditLogFetches.length, 2);
});

test("thread message GET and history exclude parent and sibling messages", () => {
  const workspace = createRouterWorkspace();
  updateState(workspace.stateDir, state => {
    state.fixtures.discord.restMessages = [
      { id: '1003', channel_id: 'demo-thread', content: 'Thread reply' },
      { id: '1002', channel_id: 'sibling-thread', content: 'Sibling reply' },
      { id: '1001', channel_id: 'demo-channel', content: 'Parent reply' },
    ];
  });
  const result = fixtureScript(workspace, `(async () => {
    const base = 'https://discord.com/api/v10/channels/';
    const history = await (await fetch(base + 'demo-thread/messages')).json();
    const own = await (await fetch(base + 'demo-thread/messages/1003')).json();
    const parent = await fetch(base + 'demo-thread/messages/1001');
    const sibling = await fetch(base + 'demo-thread/messages/1002');
    console.log(JSON.stringify({ ids: history.map(m => m.id), own: own.id,
      parent: parent.status, sibling: sibling.status }));
  })()`);
  assert.deepEqual(result, { ids: ['1003'], own: '1003', parent: 404, sibling: 404 });
});
