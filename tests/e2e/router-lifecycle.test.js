import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

import { injectDiscordMessage } from "./support/bridge.js";
import {
  OWNER_ID,
  connectSession,
  createRouterWorkspace,
  rawRouterSocket,
  runRouterCli,
  startRouter,
  waitFor,
  writeProjectKey,
} from "./support/router.js";
import { readState } from "./support/state.js";
import { cleanup } from "./support/teardown.js";

test.afterEach(async () => {
  await cleanup();
});

test("a new key for a project revokes the connected session, routes to the new key, and refuses the old one", async () => {
  const workspace = createRouterWorkspace();
  writeProjectKey(workspace, "demo", "key-a");
  await startRouter(workspace);
  const a = await connectSession(workspace, "demo", "key-a");
  const aClosed = new Promise((resolve) => a.client.once("end", resolve));

  writeProjectKey(workspace, "demo", "key-b");

  await waitFor(() => a.events.some((event) => event.event === "revoked"), () => "revoked event for key-a");
  await aClosed;
  const b = await connectSession(workspace, "demo", "key-b");
  injectDiscordMessage(workspace, { id: "after-rotation", channelId: "demo-channel", content: "hi",
    author: { id: OWNER_ID, username: "Owner" } });
  await waitFor(() => b.events.length > 0, () => "message for key-b");
  assert.deepEqual(b.events.map((event) => event.message_id), ["after-rotation"]);
  assert.deepEqual(a.events.map((event) => event.event), ["revoked"]);

  const stale = await rawRouterSocket(workspace);
  stale.send({ type: "hello", v: 1, role: "project", project: "demo", key: "key-a" });
  await stale.closed;
  assert.deepEqual(stale.frames.map((frame) => [frame.type, frame.error?.code]), [["hello_error", "unauthorized"]]);
});

test("a hello with the wrong protocol version gets hello_error and the socket closes", async () => {
  const workspace = createRouterWorkspace();
  writeProjectKey(workspace, "demo", "demo-key");
  await startRouter(workspace);
  const socket = await rawRouterSocket(workspace);

  socket.send({ type: "hello", v: 2, role: "project", project: "demo", key: "demo-key" });
  await socket.closed;

  assert.deepEqual(socket.frames.map((frame) => [frame.type, frame.error?.code]), [["hello_error", "unsupported_version"]]);
});

test("malformed frames, pre-hello requests, and unknown ops get typed errors and the Router stays up", async () => {
  const workspace = createRouterWorkspace();
  writeProjectKey(workspace, "demo", "demo-key");
  const router = await startRouter(workspace);
  const socket = await rawRouterSocket(workspace);

  socket.send("{not json\n");
  socket.send("null\n");
  socket.send("42\n");
  socket.send({ id: "no-type" });
  socket.send({ type: "request", op: "reply", args: {} });
  socket.send({ type: "request", id: "before-hello", op: "reply", args: { channel_id: "demo-channel", text: "hi" } });
  socket.send({ type: "hello", v: 1, role: "project", project: "demo", key: "demo-key" });
  socket.send({ type: "request", id: "mystery", op: "summon_dragon", args: {} });
  await waitFor(() => socket.frames.length >= 8, () => `8 frames, got ${JSON.stringify(socket.frames)}`);

  assert.deepEqual(socket.frames.map((frame) => [frame.type, frame.id ?? null, frame.error?.code ?? null]), [
    ["error", null, "malformed_frame"],
    ["error", null, "malformed_frame"],
    ["error", null, "malformed_frame"],
    ["error", null, "malformed_frame"],
    ["error", null, "malformed_frame"],
    ["response", "before-hello", "not_authenticated"],
    ["hello_ok", null, null],
    ["response", "mystery", "unknown_op"],
  ]);
  assert.equal(router.child.exitCode, null);
  const demo = await connectSession(workspace, "demo", "demo-key");
  assert.equal(demo.scope.channel_id, "demo-channel");
});

test("router status lists a scope violation made earlier with its project, op, and target", async () => {
  const workspace = createRouterWorkspace();
  writeProjectKey(workspace, "demo", "demo-key");
  await startRouter(workspace);
  const demo = await connectSession(workspace, "demo", "demo-key");
  await assert.rejects(demo.client.request("reply", { channel_id: "beta-channel", text: "sneaky" }),
    { code: "scope_violation" });

  const status = await runRouterCli(workspace, ["status"]);

  assert.equal(status.exitCode, 0, status.stderr || status.stdout);
  assert.match(status.stdout,
    /scope violations: 1\n  \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z project=demo op=reply target=beta-channel\n/);
});

test("after the Router is killed and restarted, a session reconnects on its own and its reply lands", async () => {
  const workspace = createRouterWorkspace();
  const webhook = await runRouterCli(workspace, ["ensure-webhook", "demo"]);
  assert.equal(webhook.exitCode, 0, webhook.stderr || webhook.stdout);
  writeProjectKey(workspace, "demo", "demo-key");
  const first = await startRouter(workspace);
  const demo = await connectSession(workspace, "demo", "demo-key", {
    env: { CCDM_ROUTER_RECONNECT_MIN_MS: "50", CCDM_ROUTER_RECONNECT_MAX_MS: "200" },
  });
  let reconnectedAt = null;
  demo.client.once("reconnect", () => { reconnectedAt = Date.now(); });

  process.kill(-first.child.pid, "SIGKILL");
  await first.closed;
  const startedAt = Date.now();
  await assert.rejects(demo.client.request("reply", { channel_id: "demo-channel", text: "while down" }),
    { code: "router_unavailable" });
  assert.ok(Date.now() - startedAt < 500, "reply failed promptly");

  await startRouter(workspace);
  const restartedAt = Date.now();
  await waitFor(() => reconnectedAt, () => "reconnect after restart", 1000);
  assert.ok(reconnectedAt - restartedAt < 1000, "reconnected within the configured backoff");
  injectDiscordMessage(workspace, { id: "after-restart", channelId: "demo-channel", content: "still there?",
    author: { id: OWNER_ID, username: "Owner" } });
  await waitFor(() => demo.events.length > 0, () => "message after restart");
  await demo.client.request("reply", { channel_id: "demo-channel", text: "back", context_pct: 42 });

  assert.deepEqual(demo.events.map((event) => event.message_id), ["after-restart"]);
  assert.deepEqual(readState(workspace.stateDir).fixtures.discord.messages.map(({ content, username }) => ({ content, username })),
    [{ content: "back", username: "demo-claude · 42%" }]);
});

// The one place the real reconnect defaults are asserted; every other test shortens them.
test("reconnect backoff defaults to a 500 ms first delay and a 30 s cap, overridable by environment", () => {
  const { reconnectBackoff } = createRequire(import.meta.url)("../../scripts/router/client.js");

  assert.deepEqual(reconnectBackoff({}), { minMs: 500, maxMs: 30000 });
  assert.deepEqual(reconnectBackoff({ CCDM_ROUTER_RECONNECT_MIN_MS: "50", CCDM_ROUTER_RECONNECT_MAX_MS: "200" }),
    { minMs: 50, maxMs: 200 });
});
