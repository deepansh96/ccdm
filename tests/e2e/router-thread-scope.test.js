import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { OWNER_ID, connectSession, connectThread, createRouterWorkspace, routerRegistry, routerWithWebhooks, runRouterCli,
  seedThreads, waitFor, writeProjectKey, writeThreadKey } from "./support/router.js";
import { readState, updateState } from "./support/state.js";
import { cleanup } from "./support/teardown.js";

// A thread session's hello and its scope: the Router admits a session only to
// a public thread under its registered project's channel, and its replies
// go through the parent's webhook into that thread.

test.afterEach(cleanup);

async function threadWorkspace() {
  const workspace = createRouterWorkspace(routerRegistry({
    far: { channel_id: "far-channel", type: "claude", path: "remote:mac:/srv/far" },
  }));
  await routerWithWebhooks(workspace, ["demo"]);
  seedThreads(workspace, {
    "demo-thread": { type: 11, parentId: "demo-channel" },
    "beta-thread": { type: 11, parentId: "beta-channel" },
    "private-thread": { type: 12, parentId: "demo-channel" },
    "far-thread": { type: 11, parentId: "far-channel" },
  });
  return workspace;
}

const helloError = connection => connection.hello.type === "hello_error" ? connection.hello.error.code : null;

test("a thread hello is refused for a wrong key, wrong parent, private thread or unregistered project", async () => {
  const workspace = await threadWorkspace();
  writeThreadKey(workspace, "demo-thread", "demo-thread-key");
  const refusals = {
    wrongKey: helloError(await connectThread(workspace, { threadId: "demo-thread", key: "stale-key" })),
    wrongParent: helloError(await connectThread(workspace, { threadId: "beta-thread" })),
    privateThread: helloError(await connectThread(workspace, { threadId: "private-thread" })),
    unregistered: helloError(await connectThread(workspace, { project: "ghost", threadId: "demo-thread", key: "demo-thread-key" })),
    remote: helloError(await connectThread(workspace, { project: "far", threadId: "far-thread" })),
    provider: helloError(await connectThread(workspace, { threadId: "demo-thread", key: "demo-thread-key", provider: "gemini" })),
  };
  assert.deepEqual(refusals, { wrongKey: "unauthorized", wrongParent: "not_a_project_thread",
    privateThread: "not_a_project_thread", unregistered: "unauthorized", remote: "not_a_project_thread",
    provider: "unauthorized" });
  const accepted = await connectThread(workspace, { threadId: "demo-thread", key: "demo-thread-key", provider: "codex" });
  assert.deepEqual(accepted.hello.scope, { project: "demo", type: "codex", channel_id: "demo-thread",
    parent_channel_id: "demo-channel", thread_id: "demo-thread" });
});

test("a newer hello for the same thread replaces the old listener with replaced", async () => {
  const workspace = await threadWorkspace();
  const first = await connectThread(workspace, { threadId: "demo-thread" });
  const second = await connectThread(workspace, { threadId: "demo-thread" });
  assert.equal(second.hello.type, "hello_ok");
  await first.closed;
  assert.deepEqual(first.events.map(event => [event.event, event.reason]), [["revoked", "replaced"]]);
  const opOnly = await connectThread(workspace, { threadId: "demo-thread", listener: false });
  assert.equal(opOnly.hello.type, "hello_ok");
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.deepEqual(second.events, []);
});

test("a thread reply posts through the parent's webhook into the thread under the thread provider's name", async () => {
  const workspace = await threadWorkspace();
  const thread = await connectThread(workspace, { threadId: "demo-thread", provider: "codex" });
  const reply = await thread.request("reply", { channel_id: "demo-thread", text: "Tests passed.", context_pct: 42 });
  assert.equal(reply.ok, true, JSON.stringify(reply));
  const edit = await thread.request("edit_message", { channel_id: "demo-thread", message_id: reply.result.message_id,
    text: "Tests passed, twice." });
  assert.equal(edit.ok, true, JSON.stringify(edit));
  const discord = readState(workspace.stateDir).fixtures.discord;
  assert.deepEqual(discord.messages.map(({ channelId, username, avatarUrl, content }) => ({ channelId, username, avatarUrl, content })),
    [{ channelId: "demo-thread", username: "demo-codex · 42%", avatarUrl: "https://cdn.discordapp.com/embed/avatars/1.png",
      content: "Tests passed, twice." }]);
  assert.deepEqual(discord.webhookEdits.map(({ messageId, channelId }) => ({ messageId, channelId })),
    [{ messageId: reply.result.message_id, channelId: "demo-thread" }]);
  // The webhook stays in the parent channel; nothing moved it into the thread.
  assert.deepEqual(discord.webhooks.map(webhook => webhook.channel_id), ["demo-channel"]);
});

test("a thread session cannot reply in its parent channel", async () => {
  const workspace = await threadWorkspace();
  const thread = await connectThread(workspace, { threadId: "demo-thread" });
  const reply = await thread.request("reply", { channel_id: "demo-channel", text: "Wrong place." });
  assert.equal(reply.error?.code, "scope_violation");
  assert.deepEqual(readState(workspace.stateDir).fixtures.discord.messages ?? [], []);
});

// Numeric ids, since range exports take snowflakes. 4000 is a thread started
// from parent message 4000, so its starter message shares the thread's id.
const THREAD = "4000";
const SIBLING = "5000";
const historyLine = (channelId, id, content, extra = {}) => ({ id, channel_id: channelId, content, attachments: [],
  timestamp: "2026-10-01T10:00:00.000Z", author: { id: OWNER_ID, username: "Owner" }, ...extra });

async function numericThreadWorkspace() {
  const workspace = createRouterWorkspace({ ...routerRegistry(), root_channels: ["root-channel"] });
  updateState(workspace.stateDir, (state) => {
    state.fixtures.discord.history = {
      "demo-channel": [historyLine("demo-channel", THREAD, "starter"), historyLine("demo-channel", "1001", "parent")],
      [THREAD]: [historyLine(THREAD, "4001", "in the thread", {
        attachments: [{ id: "att-1", filename: "log.txt", content_type: "text/plain", size: 3,
          url: "https://cdn.discordapp.com/attachments/4000/att-1/log.txt?ex=ffffffff" }] })],
      [SIBLING]: [historyLine(SIBLING, "5001", "in the sibling")],
      "root-channel": [historyLine("root-channel", "9001", "in root")],
    };
    state.fixtures.discord.attachments["https://cdn.discordapp.com/attachments/4000/att-1/log.txt?ex=ffffffff"] = { body: "log" };
  });
  const router = await routerWithWebhooks(workspace, ["demo"]);
  seedThreads(workspace, {
    [THREAD]: { type: 11, parentId: "demo-channel" },
    [SIBLING]: { type: 11, parentId: "demo-channel" },
  });
  return { workspace, router };
}

test("every thread op works in the thread and is a scope violation for the parent, a sibling, root and their messages", async () => {
  const { workspace } = await numericThreadWorkspace();
  const thread = await connectThread(workspace, { threadId: THREAD });
  const call = async (op, args) => {
    const response = await thread.request(op, args);
    return response.ok ? "ok" : response.error.code;
  };
  const reply = await thread.request("reply", { channel_id: THREAD, text: "On it." });
  assert.equal(reply.ok, true, JSON.stringify(reply));
  const own = reply.result.message_id;
  const inThread = {
    fetch_messages: await call("fetch_messages", { channel_id: THREAD }),
    read_last_x_messages_in_channel: await call("read_last_x_messages_in_channel", { channel_id: THREAD, count: 1 }),
    export_message_range: await call("export_message_range", { channel_id: THREAD, start_message_id: "4001" }),
    download_attachment: await call("download_attachment", { channel_id: THREAD, message_id: "4001" }),
    react: await call("react", { channel_id: THREAD, message_id: "4001", emoji: "👀" }),
    typing: await call("typing", { channel_id: THREAD }),
    reply: await call("reply", { channel_id: THREAD, text: "Replying.", reply_to: "4001" }),
    edit_message: await call("edit_message", { channel_id: THREAD, message_id: own, text: "Done." }),
  };
  assert.deepEqual(inThread, { fetch_messages: "ok", read_last_x_messages_in_channel: "ok", export_message_range: "ok",
    download_attachment: "ok", react: "ok", typing: "ok", reply: "ok", edit_message: "ok" });

  const opArgs = {
    fetch_messages: () => ({}),
    read_last_x_messages_in_channel: () => ({ count: 1 }),
    export_message_range: id => ({ start_message_id: id }),
    download_attachment: id => ({ message_id: id }),
    react: id => ({ message_id: id, emoji: "👀" }),
    typing: () => ({}),
    reply: id => ({ text: "Wrong place.", reply_to: id }),
    edit_message: id => ({ message_id: id, text: "Wrong place." }),
  };
  const outcomes = {};
  for (const [op, args] of Object.entries(opArgs)) {
    outcomes[op] = {
      parent: await call(op, { channel_id: "demo-channel", ...args("1001") }),
      sibling: await call(op, { channel_id: SIBLING, ...args("5001") }),
      root: await call(op, { channel_id: "root-channel", ...args("9001") }),
    };
    if (args("x").message_id || args("x").start_message_id || args("x").reply_to) {
      outcomes[op].parentMessage = await call(op, { channel_id: THREAD, ...args("1001") });
      outcomes[op].starter = await call(op, { channel_id: THREAD, ...args(THREAD) });
    }
  }
  const channelsOnly = { parent: "scope_violation", sibling: "scope_violation", root: "scope_violation" };
  const withMessages = { ...channelsOnly, parentMessage: "scope_violation", starter: "scope_violation" };
  assert.deepEqual(outcomes, {
    fetch_messages: channelsOnly, read_last_x_messages_in_channel: channelsOnly, export_message_range: withMessages,
    download_attachment: withMessages, react: withMessages, typing: channelsOnly, reply: withMessages,
    edit_message: withMessages,
  });

  const discord = readState(workspace.stateDir).fixtures.discord;
  // Every message lookup went through the thread channel, never the parent.
  assert.deepEqual([...new Set(discord.messageFetches.map(fetch => fetch.channelId))], [THREAD]);
  assert.deepEqual(discord.reactions.map(({ channelId, messageId }) => ({ channelId, messageId })),
    [{ channelId: THREAD, messageId: "4001" }]);
  assert.deepEqual(discord.typing.map(({ channelId }) => channelId), [THREAD]);
  assert.deepEqual(discord.messages.map(({ channelId }) => channelId), [THREAD, THREAD]);
});

const revocations = connection => connection.events.filter(event => event.event === "revoked").map(event => event.reason);

test("a changed or missing thread key revokes only that thread; rotating the project key leaves threads connected", async () => {
  const { workspace } = await numericThreadWorkspace();
  const demo = await connectSession(workspace, "demo", "demo-key");
  const thread = await connectThread(workspace, { threadId: THREAD });
  const sibling = await connectThread(workspace, { threadId: SIBLING });
  const opOnly = await connectThread(workspace, { threadId: THREAD, listener: false });

  writeProjectKey(workspace, "demo", "demo-key-2");
  await waitFor(() => demo.events.some(event => event.event === "revoked"), () => "demo's revocation");
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.deepEqual([revocations(thread), revocations(sibling), revocations(opOnly)], [[], [], []]);

  writeThreadKey(workspace, THREAD, "rotated-thread-key");
  await waitFor(() => revocations(thread).length && revocations(opOnly).length, () => "the rotated thread's revocations");
  assert.deepEqual([revocations(thread), revocations(opOnly), revocations(sibling)], [["key_rotated"], ["key_rotated"], []]);

  fs.unlinkSync(path.join(workspace.routerStateDir, "keys", `.thread-${SIBLING}.key`));
  await waitFor(() => revocations(sibling).length, () => "the sibling's revocation");
  assert.deepEqual(revocations(sibling), ["key_rotated"]);
});

// Edits the registry with an atomic replace and waits for the Router's reload.
async function editRegistry(workspace, router, edit) {
  await new Promise(resolve => setTimeout(resolve, 100));
  const file = path.join(workspace.repoDir, "registry.json");
  const registry = JSON.parse(fs.readFileSync(file, "utf8"));
  edit(registry);
  const reloads = () => router.stdout.split("registry reloaded").length - 1;
  const before = reloads();
  fs.writeFileSync(`${file}.edit`, `${JSON.stringify(registry, null, 2)}\n`);
  fs.renameSync(`${file}.edit`, file);
  await waitFor(() => reloads() > before, () => `registry reload:\n${router.stdout}`);
}

test("a registry reload revokes thread connections on deregistration and channel moves, never pushing scope_changed", async () => {
  const workspace = createRouterWorkspace();
  const router = await routerWithWebhooks(workspace, ["demo", "beta"]);
  seedThreads(workspace, {
    "demo-thread": { type: 11, parentId: "demo-channel" },
    "beta-thread": { type: 11, parentId: "beta-channel" },
  });
  const demo = await connectThread(workspace, { threadId: "demo-thread" });
  const demoOps = await connectThread(workspace, { threadId: "demo-thread", listener: false });
  const beta = await connectThread(workspace, { project: "beta", threadId: "beta-thread", provider: "codex" });
  const all = [demo, demoOps, beta];
  assert.deepEqual(all.map(connection => connection.hello.type), ["hello_ok", "hello_ok", "hello_ok"]);

  await editRegistry(workspace, router, registry => { registry.projects.demo.webhook_id = "999999"; });
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.deepEqual(all.map(connection => connection.events), [[], [], []]);

  await editRegistry(workspace, router, registry => { registry.projects.demo.channel_id = "moved-channel"; });
  await waitFor(() => revocations(demo).length && revocations(demoOps).length, () => "demo thread revocations");
  await editRegistry(workspace, router, registry => { delete registry.projects.beta; });
  await waitFor(() => revocations(beta).length, () => "beta thread revocation");
  assert.deepEqual(all.map(connection => connection.events.map(event => [event.event, event.reason])),
    [[["revoked", "project_moved"]], [["revoked", "project_moved"]], [["revoked", "deregistered"]]]);
});

test("router status lists each thread connection with its project, thread, provider and connection time", async () => {
  const { workspace } = await numericThreadWorkspace();
  await connectSession(workspace, "demo", "demo-key");
  await connectThread(workspace, { threadId: THREAD, provider: "codex" });
  await connectThread(workspace, { threadId: SIBLING });
  const status = await runRouterCli(workspace, ["status"]);
  assert.equal(status.exitCode, 0, status.stderr);
  assert.match(status.stdout, /^sessions: 3$/m);
  assert.match(status.stdout, /^ {2}project demo scope=demo-channel connected=\S+$/m);
  const threads = status.stdout.split("\n").filter(line => line.startsWith("  thread "));
  assert.deepEqual(threads.map(line => line.replace(/connected=\d{4}-\d\d-\d\dT[\d:.]+Z$/, "connected=<at>")), [
    "  thread demo thread=4000 provider=codex connected=<at>",
    "  thread demo thread=5000 provider=claude connected=<at>",
  ]);
});
