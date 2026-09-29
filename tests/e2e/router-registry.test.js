import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { injectDiscordMessage } from "./support/bridge.js";
import {
  OWNER_ID,
  connectSession,
  routerEnv,
  createRouterWorkspace,
  routerRegistry,
  runRouterCli,
  startRouter,
  waitFor,
  writeProjectKey,
} from "./support/router.js";
import { runNodeEntrypoint } from "./support/runner.js";
import { readState } from "./support/state.js";
import { cleanup } from "./support/teardown.js";

const RELOAD_ENV = { CCDM_ROUTER_REGISTRY_DEBOUNCE_MS: "20" };

test.afterEach(async () => {
  await cleanup();
});

// Atomic replace, the way editors and structured rewrites land a registry.
function replaceRegistry(workspace, registry) {
  const file = path.join(workspace.repoDir, "registry.json");
  fs.writeFileSync(`${file}.edit`, `${JSON.stringify(registry, null, 2)}\n`);
  fs.renameSync(`${file}.edit`, file);
}

// Runs a registry change and waits for the reload it causes. Earlier writes
// settle first so their own reloads are not mistaken for this one.
async function afterReload(router, change) {
  await new Promise((resolve) => setTimeout(resolve, 100));
  const reloads = () => router.stdout.split("registry reloaded").length - 1;
  const before = reloads();
  const result = await change();
  await waitFor(() => reloads() > before, () => `registry reload:\n${router.stdout}\n${router.stderr}`);
  return result;
}

function injectMessage(workspace, id, author, channelId = "demo-channel") {
  injectDiscordMessage(workspace, { id, channelId, content: `from ${id}`, author });
}

async function waitForDelivered(workspace, id) {
  await waitFor(() => readState(workspace.stateDir).fixtures.discord.deliveredMessages.some(entry => entry.id === id),
    () => `gateway delivery of ${id}`);
  // Classification is asynchronous to the gateway emit.
  await new Promise((resolve) => setTimeout(resolve, 150));
}

test("a guest added by a registry edit reaches the connected session, and stops once removed", async () => {
  const workspace = createRouterWorkspace(routerRegistry({
    demo: { channel_id: "demo-channel", type: "claude", transport: "router" },
  }));
  writeProjectKey(workspace, "demo", "demo-key");
  const router = await startRouter(workspace, { env: RELOAD_ENV });
  const demo = await connectSession(workspace, "demo", "demo-key");
  const guest = { id: "new-guest-id", username: "NewGuest" };

  injectMessage(workspace, "before-grant", guest);
  await waitForDelivered(workspace, "before-grant");
  await afterReload(router, () => replaceRegistry(workspace, routerRegistry({
    demo: { channel_id: "demo-channel", type: "claude", transport: "router", guest_user_ids: ["new-guest-id"] },
  })));
  injectMessage(workspace, "after-grant", guest);
  await waitFor(() => demo.events.length > 0, () => `guest message; router:\n${router.stdout}\n${router.stderr}`);

  await afterReload(router, () => replaceRegistry(workspace, routerRegistry({
    demo: { channel_id: "demo-channel", type: "claude", transport: "router", guest_user_ids: [] },
  })));
  injectMessage(workspace, "after-revoke", guest);
  await waitForDelivered(workspace, "after-revoke");

  assert.deepEqual(demo.events.map(event => event.message_id), ["after-grant"]);
});

test("an invalid registry keeps the last good routing table and shows in router status until fixed", async () => {
  const workspace = createRouterWorkspace();
  writeProjectKey(workspace, "demo", "demo-key");
  const router = await startRouter(workspace, { env: RELOAD_ENV });
  const demo = await connectSession(workspace, "demo", "demo-key");
  const loadedBefore = (await runRouterCli(workspace, ["status"])).stdout.match(/registry loaded: (\S+)/)[1];
  const file = path.join(workspace.repoDir, "registry.json");

  fs.writeFileSync(`${file}.edit`, "{ not json");
  fs.renameSync(`${file}.edit`, file);
  await router.waitForOutput(/registry_reload_failed error=/);
  injectMessage(workspace, "while-invalid", { id: OWNER_ID, username: "Owner" });
  await waitFor(() => demo.events.length > 0, () => `owner message while invalid:\n${router.stdout}`);
  const failed = await runRouterCli(workspace, ["status"]);

  assert.equal(failed.exitCode, 0, failed.stderr || failed.stdout);
  assert.match(failed.stdout, new RegExp(`registry loaded: ${loadedBefore}\n`));
  assert.match(failed.stdout, /registry error: \d{4}-\d{2}-\d{2}T\S+ .*JSON/);

  await afterReload(router, () => replaceRegistry(workspace, routerRegistry({
    demo: { channel_id: "demo-channel", type: "claude", transport: "router", guest_user_ids: ["restored-guest"] },
  })));
  injectMessage(workspace, "after-restore", { id: "restored-guest", username: "Restored" });
  await waitFor(() => demo.events.length > 1, () => `guest message after restore:\n${router.stdout}`);
  const restored = await runRouterCli(workspace, ["status"]);

  assert.deepEqual(demo.events.map(event => event.message_id), ["while-invalid", "after-restore"]);
  assert.doesNotMatch(restored.stdout, /registry error/);
  assert.doesNotMatch(restored.stdout, new RegExp(`registry loaded: ${loadedBefore}\n`));
});

test("registering a new project starts routing its channel without a restart", async () => {
  const workspace = createRouterWorkspace();
  writeProjectKey(workspace, "newbie", "newbie-key");
  const router = await startRouter(workspace, { env: RELOAD_ENV });
  await assert.rejects(connectSession(workspace, "newbie", "newbie-key"), { code: "unauthorized" });

  // A newly registered project needs no `transport` field.
  replaceRegistry(workspace, routerRegistry({
    newbie: { channel_id: "newbie-channel", type: "claude" },
  }));
  await router.waitForOutput(/registry reloaded: 4 router project/);
  const newbie = await connectSession(workspace, "newbie", "newbie-key");
  injectMessage(workspace, "now-routed", { id: OWNER_ID, username: "Owner" }, "newbie-channel");
  await waitFor(() => newbie.events.length > 0, () => `newbie message:\n${router.stdout}`);

  assert.deepEqual(newbie.events.map(event => [event.message_id, event.channel_id]), [["now-routed", "newbie-channel"]]);
  assert.match(router.stdout, /router ready/);
  assert.equal(router.stdout.split("router ready").length - 1, 1);
});

test("guest-access.js grant and revoke change who reaches a connected session with no restart", async () => {
  const workspace = createRouterWorkspace(routerRegistry({
    demo: { channel_id: "demo-channel", type: "claude", transport: "router" },
  }));
  writeProjectKey(workspace, "demo", "demo-key");
  const router = await startRouter(workspace, { env: RELOAD_ENV });
  const demo = await connectSession(workspace, "demo", "demo-key");
  const guest = { id: "cli-guest-id", username: "CliGuest" };
  const guestAccess = (action) => runNodeEntrypoint(workspace, "scripts/guest-access.js", {
    args: [action, "demo", "cli-guest-id"], env: routerEnv(workspace),
  });

  const granted = await afterReload(router, () => guestAccess("grant"));
  assert.equal(granted.exitCode, 0, granted.stderr || granted.stdout);
  injectMessage(workspace, "after-cli-grant", guest);
  await waitFor(() => demo.events.length > 0, () => `guest message; router:\n${router.stdout}\n${router.stderr}`);

  const revoked = await afterReload(router, () => guestAccess("revoke"));
  assert.equal(revoked.exitCode, 0, revoked.stderr || revoked.stdout);
  injectMessage(workspace, "after-cli-revoke", guest);
  await waitForDelivered(workspace, "after-cli-revoke");

  assert.deepEqual(demo.events.map(event => event.message_id), ["after-cli-grant"]);
  assert.equal(router.stdout.split("router ready").length - 1, 1);
});
