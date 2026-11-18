import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";

import { injectDiscordMessage } from "./support/bridge.js";
import { OWNER_ID, createRouterWorkspace, routerWithWebhooks, runRouterCli, seedThreads, startRouter, waitFor,
  writeThreadKey } from "./support/router.js";
import { updateState } from "./support/state.js";
import { cleanup, registerTeardownCallback } from "./support/teardown.js";

test.afterEach(cleanup);

// A Router restart while sessions are connected: the new Router's socket
// listens before its gateway is ready, and every session says hello again at
// once. A thread hello needs Discord to check the thread, so it waits for the
// gateway; refused instead, a session would dead-end.
const THREAD_ID = "1700000000000880001";
const FAST_RECONNECT = { CCDM_ROUTER_RECONNECT_MIN_MS: "50", CCDM_ROUTER_RECONNECT_MAX_MS: "200" };
// The new gateway is ready this long after the restarted Router listens.
const SLOW_READY_MS = 2000;

// The client library as it was before `not_ready` was retryable: it ends for
// good on any refused hello after its first connect. Live sessions keep the
// code they started with, so the Router alone must make a restart safe for them.
function legacyClient(workspace) {
  const current = path.join(workspace.repoDir, "scripts/router/client.js");
  const source = fs.readFileSync(current, "utf8");
  const retrying = "if (this.connectedOnce && !RETRYABLE_HELLO_ERRORS.has(error.code)) this.end(error);";
  assert.ok(source.includes(retrying), "the client's retry rule moved; update the legacy client");
  const legacy = path.join(workspace.repoDir, "scripts/router/legacy-client.js");
  fs.writeFileSync(legacy, source.replace(retrying, "if (this.connectedOnce) this.end(error);"));
  return createRequire(import.meta.url)(legacy);
}

function currentClient(workspace) {
  return createRequire(import.meta.url)(path.join(workspace.repoDir, "scripts/router/client.js"));
}

function restartWorkspace() {
  const workspace = createRouterWorkspace();
  seedThreads(workspace, { [THREAD_ID]: { type: 11, parentId: "demo-channel", name: "Fix flaky test", ownerId: OWNER_ID } });
  writeThreadKey(workspace, THREAD_ID, "thread-key");
  return workspace;
}

// A session through `RouterClient`, recording its reconnects, its end, and its events.
async function session(workspace, RouterClient, options) {
  const client = new RouterClient({ socketPath: workspace.socketPath, env: FAST_RECONNECT, ...options });
  registerTeardownCallback(() => client.close());
  const record = { client, reconnects: 0, ended: null, events: [] };
  client.on("reconnect", () => { record.reconnects += 1; });
  client.on("end", error => { record.ended = error?.code ?? "closed"; });
  client.on("event", event => record.events.push(event));
  await client.connect();
  return record;
}

async function restart(workspace, router, env = {}) {
  updateState(workspace.stateDir, state => { state.fixtures.discord.readyDelayMs = SLOW_READY_MS; });
  await router.stop();
  return startRouter(workspace, { env });
}

test("after a Router restart, thread and project sessions on a client that ends on any refused hello reconnect", async () => {
  const workspace = restartWorkspace();
  const router = await routerWithWebhooks(workspace, ["demo"]);
  const { RouterClient } = legacyClient(workspace);
  const thread = await session(workspace, RouterClient, { project: "demo", key: "thread-key", role: "thread",
    threadId: THREAD_ID, provider: "claude" });
  const project = await session(workspace, RouterClient, { project: "demo", key: "demo-key", role: "project" });

  await restart(workspace, router);

  await waitFor(() => thread.reconnects === 1 && project.reconnects === 1,
    () => `both sessions back: ${JSON.stringify({ thread: [thread.reconnects, thread.ended],
      project: [project.reconnects, project.ended] })}`, 15000);
  assert.deepEqual([thread.ended, project.ended], [null, null]);
  const status = JSON.parse((await runRouterCli(workspace, ["status", "--json"])).stdout);
  assert.deepEqual(status.sessions.map(entry => [entry.role, entry.thread_id ?? null]).sort(),
    [["project", null], ["thread", THREAD_ID]]);

  // The reconnected thread session is live: an owner message reaches it.
  injectDiscordMessage(workspace, { id: "after-restart", channelId: THREAD_ID, content: "still there?",
    author: { id: OWNER_ID, username: "Owner" } });
  await waitFor(() => thread.events.some(event => event.message_id === "after-restart"), () => "the message at the thread");
});

test("a thread hello still waiting when the gateway wait ends is refused as not_ready, and the client says hello again", async () => {
  const workspace = restartWorkspace();
  const router = await routerWithWebhooks(workspace, ["demo"]);
  const { RouterClient } = currentClient(workspace);
  const thread = await session(workspace, RouterClient, { project: "demo", key: "thread-key", role: "thread",
    threadId: THREAD_ID, provider: "claude" });

  // The wait is shorter than the gateway takes: the first hellos are refused.
  await restart(workspace, router, { CCDM_ROUTER_HELLO_READY_WAIT_MS: "100" });

  await waitFor(() => thread.reconnects === 1, () => `the thread session back: ${thread.ended}`, 15000);
  assert.equal(thread.ended, null);
});
