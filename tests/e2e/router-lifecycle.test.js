import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { injectDiscordMessage } from "./support/bridge.js";
import { platformGate } from "./support/platform.js";
import {
  OWNER_ID,
  connectSession,
  createRouterWorkspace,
  killRouter,
  rawRouterSocket,
  routerEnv,
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

const onlyWindows = platformGate("win32", "the pipe DACL and remote-client refusal are Windows behaviour");
const scriptsModule = name => createRequire(import.meta.url)(`../../scripts/platform/${name}.js`);

function tryConnect(endpoint) {
  return new Promise((resolve) => {
    const client = net.connect(endpoint);
    client.once("connect", () => { client.destroy(); resolve(null); });
    client.once("error", error => resolve(error.code));
  });
}

// The DACL half of an SDDL string as [flags, ...entries], with each entry split
// on ";", so an entry for anyone but the owner cannot hide.
function daclEntries(sddl) {
  const dacl = sddl.slice(sddl.indexOf("D:") + 2);
  return { flags: dacl.slice(0, dacl.indexOf("(")), entries: dacl.match(/\([^)]*\)/g).map(entry => entry.slice(1, -1).split(";")) };
}

test("on Windows the Router pipe grants only the owner, on every instance", onlyWindows, async () => {
  const workspace = createRouterWorkspace();
  await startRouter(workspace);
  const pipe = fs.readFileSync(path.join(workspace.routerStateDir, "router.pipe"), "utf8").trim();
  const owner = scriptsModule("privacy").currentUserSid();
  const { readPipeSddl } = scriptsModule("ipc");

  // Each read is a client on a fresh instance. Faster than the Router makes
  // new instances, a read finds them all busy and tries again.
  const sddls = [];
  const readWhenFree = () => {
    try {
      sddls.push(readPipeSddl(pipe));
      return true;
    } catch (error) {
      if (!/error 231\b/.test(error.message)) throw error;
      return false;
    }
  };
  for (let reads = 0; reads < 6; reads += 1) await waitFor(readWhenFree, () => "a free pipe instance");

  for (const sddl of sddls) {
    const { flags, entries } = daclEntries(sddl);
    // SDDL prints the machine's built-in Administrator (RID 500) as LA.
    const trustee = owner.endsWith("-500") ? "LA" : owner;
    assert.equal(flags, "P");
    assert.deepEqual(entries, [["A", "", "FA", "", "", trustee]]);
  }
});

test("on Windows the Router pipe refuses the path a remote client would use, and takes the local one", onlyWindows, async (t) => {
  const workspace = createRouterWorkspace();
  await startRouter(workspace);
  const pipe = fs.readFileSync(path.join(workspace.routerStateDir, "router.pipe"), "utf8").trim();
  const remotePath = target => target.replace("\\\\.\\", `\\\\${os.hostname()}\\`);
  const control = net.createServer(socket => socket.destroy());
  const controlPipe = `${pipe}-control`;
  await new Promise(resolve => control.listen(controlPipe, resolve));
  t.after(() => new Promise(resolve => control.close(resolve)));

  assert.equal(await tryConnect(pipe), null);
  // Without a working SMB loopback the remote path proves nothing either way.
  const controlResult = await tryConnect(remotePath(controlPipe));
  if (controlResult !== null) {
    t.skip(`the SMB path to this machine is not available here: ${controlResult}`);
    return;
  }
  assert.equal(await tryConnect(remotePath(pipe)), "EPERM");
});

test("on Windows serve exits non-zero naming the pipe DACL when the pipe cannot be created", onlyWindows, async () => {
  const workspace = createRouterWorkspace();

  const result = await runRouterCli(workspace, ["serve"], { env: routerEnv(workspace, { CCDM_TEST_PIPE_CREATE_FAILS: "1" }) });

  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /pipe DACL/);
  for (const name of ["router.pipe", "router.secret"]) {
    assert.equal(fs.existsSync(path.join(workspace.routerStateDir, name)), false, `${name} survives the failed start`);
  }
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

  killRouter(first);
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

test("with no key file for root, the observer, or a project, a hello with key \"null\", no key, or an empty key is refused", async () => {
  const workspace = createRouterWorkspace();
  await startRouter(workspace);
  const hellos = [
    { role: "root" },
    { role: "observer" },
    { role: "project", project: "demo" },
  ].flatMap((hello) => [{ ...hello, key: "null" }, { ...hello }, { ...hello, key: "" }]);

  for (const hello of hellos) {
    const socket = await rawRouterSocket(workspace);
    socket.send({ type: "hello", v: 1, ...hello });
    await waitFor(() => socket.frames.length > 0, () => `a hello answer for ${JSON.stringify(hello)}`);
    assert.deepEqual(socket.frames.map((frame) => [frame.type, frame.error?.code]), [["hello_error", "unauthorized"]],
      JSON.stringify(hello));
    await socket.closed;
  }
});
