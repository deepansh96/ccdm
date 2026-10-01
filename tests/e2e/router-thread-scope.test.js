import assert from "node:assert/strict";
import test from "node:test";

import { connectThread, createRouterWorkspace, routerRegistry, routerWithWebhooks, seedThreads,
  writeThreadKey } from "./support/router.js";
import { readState } from "./support/state.js";
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
