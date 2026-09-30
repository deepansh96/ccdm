import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  ROOT_TOKEN,
  connectSession,
  createRouterWorkspace,
  routerWithWebhooks,
  runRouterCli,
  waitFor,
} from "./support/router.js";
import { readState, updateState } from "./support/state.js";
import { cleanup } from "./support/teardown.js";

test.afterEach(async () => {
  await cleanup();
});

// Someone deletes the webhook in Discord, outside CCDM.
function deleteWebhookInDiscord(workspace, webhookId) {
  updateState(workspace.stateDir, (state) => {
    state.fixtures.discord.webhooks = state.fixtures.discord.webhooks.filter(webhook => webhook.id !== webhookId);
  });
}

function registry(workspace) {
  return JSON.parse(fs.readFileSync(path.join(workspace.repoDir, "registry.json"), "utf8"));
}

// Moves only the project's registered channel, keeping its webhook_id, as an
// atomic replace, and waits for the Router to reload it.
async function moveChannel(workspace, router, project, channelId) {
  await new Promise((resolve) => setTimeout(resolve, 100));
  const reloads = () => router.stdout.split("registry reloaded").length - 1;
  const before = reloads();
  const next = registry(workspace);
  next.projects[project].channel_id = channelId;
  const file = path.join(workspace.repoDir, "registry.json");
  fs.writeFileSync(`${file}.edit`, `${JSON.stringify(next, null, 2)}\n`);
  fs.renameSync(`${file}.edit`, file);
  await waitFor(() => reloads() > before, () => `registry reload:\n${router.stdout}\n${router.stderr}`);
}

function webhookMessages(workspace) {
  return (readState(workspace.stateDir).fixtures.discord.messages ?? []).filter(message => message.webhookId);
}

test("a reply after the project's webhook was deleted recreates ccdm-demo, lands under it, and reissues the assignment", async () => {
  const workspace = createRouterWorkspace();
  await routerWithWebhooks(workspace, ["demo"]);
  const demo = await connectSession(workspace, "demo", "demo-key");
  assert.equal(registry(workspace).projects.demo.assignment_generation, undefined);
  deleteWebhookInDiscord(workspace, "fake-webhook-1");

  const result = await demo.client.request("reply", { channel_id: "demo-channel", text: "still here" });

  assert.deepEqual(result, { message_id: "fake-message-1", message_ids: ["fake-message-1"] });
  assert.deepEqual(webhookMessages(workspace).map(({ content, webhookId }) => ({ content, webhookId })),
    [{ content: "still here", webhookId: "fake-webhook-2" }]);
  const discord = readState(workspace.stateDir).fixtures.discord;
  assert.deepEqual(discord.webhooks.map(({ id, name, channel_id }) => ({ id, name, channel_id })),
    [{ id: "fake-webhook-2", name: "ccdm-demo", channel_id: "demo-channel" }]);
  const demoEntry = registry(workspace).projects.demo;
  assert.equal(demoEntry.webhook_id, "fake-webhook-2");
  // The reminder service's assignment-changed writes a fresh generation.
  assert.match(demoEntry.assignment_generation, /^gen-[0-9a-f]{32}$/);
});

test("a webhook deleted again right after its recreation fails the next reply with a typed error, creating no third webhook", async () => {
  const workspace = createRouterWorkspace();
  await routerWithWebhooks(workspace, ["demo"]);
  const demo = await connectSession(workspace, "demo", "demo-key");
  deleteWebhookInDiscord(workspace, "fake-webhook-1");
  await demo.client.request("reply", { channel_id: "demo-channel", text: "healed" });
  deleteWebhookInDiscord(workspace, "fake-webhook-2");

  await assert.rejects(demo.client.request("reply", { channel_id: "demo-channel", text: "lost again" }),
    { code: "webhook_deleted", message: /ensure-webhook demo/ });

  const discord = readState(workspace.stateDir).fixtures.discord;
  assert.deepEqual(discord.webhookCreates.map(create => create.name), ["ccdm-demo", "ccdm-demo"]);
  assert.deepEqual(discord.webhooks, []);
  assert.deepEqual(webhookMessages(workspace).map(message => message.content), ["healed"]);
});

test("a lost private webhook token is refetched through the bot on the next reply", async () => {
  const workspace = createRouterWorkspace();
  await routerWithWebhooks(workspace, ["demo"]);
  const demo = await connectSession(workspace, "demo", "demo-key");
  fs.rmSync(path.join(workspace.routerStateDir, "webhooks", "demo.json"));

  const result = await demo.client.request("reply", { channel_id: "demo-channel", text: "after the token loss" });

  assert.deepEqual(result, { message_id: "fake-message-1", message_ids: ["fake-message-1"] });
  assert.deepEqual(webhookMessages(workspace).map(({ content, webhookId }) => ({ content, webhookId })),
    [{ content: "after the token loss", webhookId: "fake-webhook-1" }]);
  assert.equal(readState(workspace.stateDir).fixtures.discord.webhookCreates.length, 1);
  assert.equal(registry(workspace).projects.demo.webhook_id, "fake-webhook-1");
  assert.equal(registry(workspace).projects.demo.assignment_generation, undefined);
  const secretFile = path.join(workspace.routerStateDir, "webhooks", "demo.json");
  assert.equal(fs.statSync(secretFile).mode & 0o777, 0o600);
  const [webhook] = readState(workspace.stateDir).fixtures.discord.webhooks;
  assert.equal(JSON.parse(fs.readFileSync(secretFile, "utf8")).token, webhook.token);
});

test("delete-webhook removes the project's webhook, its private token, and its registry id; a rerun is a clean no-op", async () => {
  const workspace = createRouterWorkspace();
  const created = await runRouterCli(workspace, ["ensure-webhook", "demo"]);
  assert.equal(created.exitCode, 0, created.stderr || created.stdout);

  const first = await runRouterCli(workspace, ["delete-webhook", "demo"]);
  const second = await runRouterCli(workspace, ["delete-webhook", "demo"]);

  assert.equal(first.exitCode, 0, first.stderr || first.stdout);
  assert.match(first.stdout, /deleted webhook ccdm-demo id=fake-webhook-1/);
  assert.equal(second.exitCode, 0, second.stderr || second.stdout);
  assert.match(second.stdout, /no webhook ccdm-demo to delete/);
  const discord = readState(workspace.stateDir).fixtures.discord;
  assert.deepEqual(discord.webhooks, []);
  assert.deepEqual(discord.webhookDeletes, [{ authorization: `Bot ${ROOT_TOKEN}`, webhookId: "fake-webhook-1" }]);
  assert.equal(fs.existsSync(path.join(workspace.routerStateDir, "webhooks", "demo.json")), false);
  const demoEntry = registry(workspace).projects.demo;
  assert.equal(Object.hasOwn(demoEntry, "webhook_id"), false);
  assert.equal(demoEntry.channel_id, "demo-channel");
});

test("edit_message also refetches a lost private webhook token", async () => {
  const workspace = createRouterWorkspace();
  await routerWithWebhooks(workspace, ["demo"]);
  const demo = await connectSession(workspace, "demo", "demo-key");
  const { message_id } = await demo.client.request("reply", { channel_id: "demo-channel", text: "working…" });
  fs.rmSync(path.join(workspace.routerStateDir, "webhooks", "demo.json"));

  const result = await demo.client.request("edit_message", { channel_id: "demo-channel", message_id, text: "done" });

  assert.deepEqual(result, { message_id: "fake-message-1" });
  assert.deepEqual(webhookMessages(workspace).map(message => message.content), ["done"]);
});

for (const [name, loseToken] of [["", false], [" and its private token is lost", true]]) {
  test(`a reply after the project's channel moved${name} lands in the new channel under a webhook kept there`, async () => {
    const workspace = createRouterWorkspace();
    const router = await routerWithWebhooks(workspace, ["demo"], { env: { CCDM_ROUTER_REGISTRY_DEBOUNCE_MS: "20" } });
    const demo = await connectSession(workspace, "demo", "demo-key");
    assert.equal(registry(workspace).projects.demo.webhook_id, "fake-webhook-1");
    await moveChannel(workspace, router, "demo", "moved-channel");
    const secretFile = path.join(workspace.routerStateDir, "webhooks", "demo.json");
    if (loseToken) fs.rmSync(secretFile);

    const result = await demo.client.request("reply", { channel_id: "moved-channel", text: "over here now" });

    assert.deepEqual(result, { message_id: "fake-message-1", message_ids: ["fake-message-1"] });
    assert.deepEqual(webhookMessages(workspace).map(({ content, channelId, webhookId }) => ({ content, channelId, webhookId })),
      [{ content: "over here now", channelId: "moved-channel", webhookId: "fake-webhook-2" }]);
    const discord = readState(workspace.stateDir).fixtures.discord;
    assert.deepEqual(discord.webhookCreates.map(({ channelId, name }) => ({ channelId, name })),
      [{ channelId: "demo-channel", name: "ccdm-demo" }, { channelId: "moved-channel", name: "ccdm-demo" }]);
    const demoEntry = registry(workspace).projects.demo;
    assert.equal(demoEntry.webhook_id, "fake-webhook-2");
    assert.match(demoEntry.assignment_generation, /^gen-[0-9a-f]{32}$/);
    const secret = JSON.parse(fs.readFileSync(secretFile, "utf8"));
    assert.deepEqual([secret.webhook_id, secret.token], ["fake-webhook-2", "fake-webhook-token-2"]);
    assert.equal(fs.statSync(secretFile).mode & 0o777, 0o600);
  });
}

test("a private webhook secret kept before channels were recorded learns its channel once and keeps its webhook", async () => {
  const workspace = createRouterWorkspace();
  await routerWithWebhooks(workspace, ["demo"]);
  const demo = await connectSession(workspace, "demo", "demo-key");
  const secretFile = path.join(workspace.routerStateDir, "webhooks", "demo.json");
  const { channel_id: _channel, ...legacy } = JSON.parse(fs.readFileSync(secretFile, "utf8"));
  fs.writeFileSync(secretFile, `${JSON.stringify(legacy)}\n`, { mode: 0o600 });

  await demo.client.request("reply", { channel_id: "demo-channel", text: "same place" });

  assert.deepEqual(webhookMessages(workspace).map(({ channelId, webhookId }) => ({ channelId, webhookId })),
    [{ channelId: "demo-channel", webhookId: "fake-webhook-1" }]);
  assert.equal(readState(workspace.stateDir).fixtures.discord.webhookCreates.length, 1);
  assert.equal(registry(workspace).projects.demo.assignment_generation, undefined);
  assert.deepEqual(JSON.parse(fs.readFileSync(secretFile, "utf8")),
    { ...legacy, channel_id: "demo-channel" });
});
