import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

import { connectSession, createRouterWorkspace, routerWithWebhooks } from "./support/router.js";
import { readState, updateState } from "./support/state.js";
import { cleanup } from "./support/teardown.js";

test.afterEach(async () => {
  await cleanup();
});

// The first project given a webhook gets the fake's first webhook. Its token
// is read from the fake so no copy of it lands in the Test Workspace.
function demoExecutePath(workspace) {
  const [{ id, token }] = readState(workspace.stateDir).fixtures.discord.webhooks;
  return `/api/v10/webhooks/${id}/${token}`;
}

// Scripts the fake to answer matching requests with 429s; `count: null` never stops.
function scriptRateLimit(workspace, rule) {
  updateState(workspace.stateDir, (state) => {
    state.fixtures.discord.rateLimits = [...(state.fixtures.discord.rateLimits ?? []), rule];
  });
}

function webhookMessages(workspace) {
  return (readState(workspace.stateDir).fixtures.discord.messages ?? []).filter(message => message.webhookId);
}

test("a reply whose first webhook execute gets a 429 is sent once, after Retry-After", async () => {
  const workspace = createRouterWorkspace();
  await routerWithWebhooks(workspace, ["demo"]);
  const demo = await connectSession(workspace, "demo", "demo-key");
  const DEMO_EXECUTE = demoExecutePath(workspace);
  scriptRateLimit(workspace, { method: "POST", path: DEMO_EXECUTE, count: 1, retryAfter: 0.4, bucket: "execute-bucket" });

  const startedAt = Date.now();
  const result = await demo.client.request("reply", { channel_id: "demo-channel", text: "made it", context_pct: 42 });

  assert.ok(Date.now() - startedAt >= 400, "the retry waited out Retry-After");
  assert.deepEqual(result, { message_id: "fake-message-1", message_ids: ["fake-message-1"] });
  assert.deepEqual(webhookMessages(workspace).map(({ content, username }) => ({ content, username })),
    [{ content: "made it", username: "demo-claude · 42%" }]);
  assert.deepEqual(readState(workspace.stateDir).fixtures.discord.rateLimitHits, [{ method: "POST", path: DEMO_EXECUTE }]);
});

test("rapid edit_message calls to one message while its route is limited coalesce to the latest content", async () => {
  const workspace = createRouterWorkspace();
  await routerWithWebhooks(workspace, ["demo"]);
  const demo = await connectSession(workspace, "demo", "demo-key");
  const DEMO_EXECUTE = demoExecutePath(workspace);
  const { message_id } = await demo.client.request("reply", { channel_id: "demo-channel", text: "working…" });
  scriptRateLimit(workspace, { method: "PATCH", path: `${DEMO_EXECUTE}/messages/fake-message-1`, count: 1, retryAfter: 0.5 });

  const results = await Promise.all(["step 1", "step 2", "step 3", "step 4", "step 5"].map(text =>
    demo.client.request("edit_message", { channel_id: "demo-channel", message_id, text })));

  assert.deepEqual(results, Array(5).fill({ message_id: "fake-message-1" }));
  const edits = readState(workspace.stateDir).fixtures.discord.webhookEdits;
  assert.ok(edits.length < 5, `expected fewer than 5 edits, got ${edits.length}`);
  assert.equal(edits.at(-1).content, "step 5");
  assert.equal(webhookMessages(workspace)[0].content, "step 5");
});

test("a route that keeps answering 429 past the wait bound fails as rate_limited while other channels are served", async () => {
  const workspace = createRouterWorkspace();
  await routerWithWebhooks(workspace, ["demo", "beta"], { env: { CCDM_ROUTER_RATE_LIMIT_MAX_WAIT_MS: "1000" } });
  const demo = await connectSession(workspace, "demo", "demo-key");
  const DEMO_EXECUTE = demoExecutePath(workspace);
  const beta = await connectSession(workspace, "beta", "beta-key");
  scriptRateLimit(workspace, { method: "POST", path: DEMO_EXECUTE, count: null, retryAfter: 0.3, bucket: "execute-bucket" });

  const startedAt = Date.now();
  const stuck = demo.client.request("reply", { channel_id: "demo-channel", text: "never lands" });
  const served = await beta.client.request("reply", { channel_id: "beta-channel", text: "beta still works", context_pct: 42 });

  assert.deepEqual(served, { message_id: "fake-message-1", message_ids: ["fake-message-1"] });
  await assert.rejects(stuck, { code: "rate_limited" });
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed >= 600 && elapsed < 2000, `gave up near the 1000 ms bound, after ${elapsed} ms`);
  assert.deepEqual(webhookMessages(workspace).map(({ channelId, content }) => ({ channelId, content })),
    [{ channelId: "beta-channel", content: "beta still works" }]);
});

test("a global 429 pauses every route until Retry-After, not just the route that hit it", async () => {
  const workspace = createRouterWorkspace();
  await routerWithWebhooks(workspace, ["demo", "beta"]);
  const demo = await connectSession(workspace, "demo", "demo-key");
  const DEMO_EXECUTE = demoExecutePath(workspace);
  const beta = await connectSession(workspace, "beta", "beta-key");
  scriptRateLimit(workspace, { method: "POST", path: DEMO_EXECUTE, count: 1, retryAfter: 0.6, global: true });

  const startedAt = Date.now();
  const first = demo.client.request("reply", { channel_id: "demo-channel", text: "hit the global limit" });
  await new Promise(resolve => setTimeout(resolve, 150));
  await beta.client.request("reply", { channel_id: "beta-channel", text: "waited for it" });

  assert.ok(Date.now() - startedAt >= 600, "the other route waited out the global Retry-After");
  await first;
  assert.deepEqual(readState(workspace.stateDir).fixtures.discord.rateLimitHits, [{ method: "POST", path: DEMO_EXECUTE }]);
  assert.deepEqual(webhookMessages(workspace).map(message => message.content).sort(), ["hit the global limit", "waited for it"]);
});

// The one place the real rate-limit defaults are asserted; tests shorten them.
test("rate-limit waits default to a 30 s bound and a 1 s fallback retry, overridable by environment", () => {
  const { rateLimitSettings } = createRequire(import.meta.url)("../../scripts/router/discord-rest.js");

  assert.deepEqual(rateLimitSettings({}), { maxWaitMs: 30000, fallbackRetryMs: 1000 });
  assert.deepEqual(rateLimitSettings({ CCDM_ROUTER_RATE_LIMIT_MAX_WAIT_MS: "1000", CCDM_ROUTER_RATE_LIMIT_FALLBACK_MS: "50" }),
    { maxWaitMs: 1000, fallbackRetryMs: 50 });
});
