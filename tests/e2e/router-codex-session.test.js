import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { injectDiscordMessage, startFakeCodexServer, waitForState } from "./support/bridge.js";
import { runScript } from "./support/runner.js";
import {
  OWNER_ID,
  createRouterWorkspace,
  routerEnv,
  routerRegistry,
  routerWithWebhooks,
  runRouterCli,
} from "./support/router.js";
import { readState } from "./support/state.js";
import { cleanup } from "./support/teardown.js";

test.afterEach(async () => {
  await cleanup();
});

// `demo` is a router-transport Codex project served by the fake app-server on `port`.
function codexRouterWorkspace(port) {
  const workspace = createRouterWorkspace(routerRegistry({
    demo: {
      channel_id: "demo-channel", type: "codex", transport: "router", guest_user_ids: ["guest-id"],
      screen_name: "demo_codex", ws_port: port, session_id: null, pid: null,
    },
  }));
  const registryFile = path.join(workspace.repoDir, "registry.json");
  const registry = JSON.parse(fs.readFileSync(registryFile, "utf8"));
  registry.projects.demo.path = workspace.tmpDir;
  fs.writeFileSync(registryFile, `${JSON.stringify(registry, null, 2)}\n`);
  fs.mkdirSync(path.join(workspace.homeDir, ".codex"), { recursive: true });
  return workspace;
}

function startCodexSession(workspace, extraEnv = {}) {
  return runScript(workspace, "scripts/start-codex-session.sh", { args: ["demo"], env: routerEnv(workspace, extraEnv), timeoutMs: 30000 });
}

function readRegistry(workspace) {
  return JSON.parse(fs.readFileSync(path.join(workspace.repoDir, "registry.json"), "utf8"));
}

test("start-codex-session launches a router Codex project whose bridge says hello to the Router", async () => {
  const workspace = codexRouterWorkspace(0);
  const codex = await startFakeCodexServer(workspace, { channelId: "demo-channel" });
  setPort(workspace, codex.port);
  await routerWithWebhooks(workspace, ["demo"]);

  const started = await startCodexSession(workspace);

  assert.equal(started.exitCode, 0, started.stderr || started.stdout);
  const status = await runRouterCli(workspace, ["status"]);
  assert.equal(status.exitCode, 0, status.stderr);
  assert.match(status.stdout, /sessions: 1\n  project demo scope=demo-channel connected=/);
  assert.equal(typeof readRegistry(workspace).projects.demo.pid, "number");
});

function setPort(workspace, port) {
  const registryFile = path.join(workspace.repoDir, "registry.json");
  const registry = JSON.parse(fs.readFileSync(registryFile, "utf8"));
  registry.projects.demo.ws_port = port;
  fs.writeFileSync(registryFile, `${JSON.stringify(registry, null, 2)}\n`);
}

// 64,600 of a 258,400-token window is 25%.
const SEEDED_USAGE = { last: { inputTokens: 64600 }, modelContextWindow: 258400 };

async function routerCodexSession(turns) {
  const workspace = codexRouterWorkspace(0);
  const codex = await startFakeCodexServer(workspace, { channelId: "demo-channel", turns });
  setPort(workspace, codex.port);
  const router = await routerWithWebhooks(workspace, ["demo"]);
  const started = await startCodexSession(workspace);
  assert.equal(started.exitCode, 0, started.stderr || started.stdout);
  return { workspace, codex, router };
}

test("an owner message starts a Codex turn whose reply posts as demo-codex with its context percentage", async () => {
  const { workspace, router } = await routerCodexSession([{
    notificationsBeforeStart: [{ method: "thread/tokenUsage/updated", params: { tokenUsage: SEEDED_USAGE } }],
    mcpReplyText: "tests pass",
    delayMs: 100,
  }]);

  injectDiscordMessage(workspace, {
    id: "owner-message-1",
    channelId: "demo-channel",
    content: "please run the tests",
    author: { id: OWNER_ID, username: "Owner" },
  });

  const done = await waitForState(workspace, (next) => next.fixtures.discord.messages.length > 0, 15000);
  const turnStarts = done.fixtures.codex.protocolEvents
    .filter((event) => event.event === "client-message" && event.message.method === "turn/start")
    .map((event) => event.message.params.input);
  assert.deepEqual(turnStarts.at(-1), [{ type: "text", text: "please run the tests" }], router.stdout);
  assert.deepEqual(done.fixtures.discord.messages.map(({ channelId, content, username, webhookId }) => ({ channelId, content, username, webhookId })), [
    { channelId: "demo-channel", content: "tests pass", username: "demo-codex · 25%", webhookId: "fake-webhook-1" },
  ]);
  assert.deepEqual(done.fixtures.discord.nicknamePatches ?? [], []);
  // The MCP server's reply did not take the bridge's place as the listener.
  const status = await runRouterCli(workspace, ["status"]);
  assert.match(status.stdout, /sessions: 1\n  project demo scope=demo-channel connected=/);
});

test("no Discord bot or webhook token reaches the Codex session environment, launch files, or MCP config", async () => {
  const { workspace } = await routerCodexSession([]);

  const state = readState(workspace.stateDir);
  const launchDir = path.join(workspace.routerStateDir, "launches", "demo");
  const launchFiles = fs.readdirSync(launchDir).map((file) => fs.readFileSync(path.join(launchDir, file), "utf8"));
  const mcpWrites = state.fixtures.codex.protocolEvents
    .filter((event) => event.event === "client-message" && event.message.method === "config/value/write");
  assert.equal(mcpWrites.length, 1);
  const surfaces = [
    JSON.stringify(state.fixtures.tmux.sessions.demo_codex),
    JSON.stringify(state.fixtures.codex.bridgeInvocations),
    JSON.stringify(mcpWrites),
    ...launchFiles,
  ];
  for (const text of surfaces) {
    for (const secret of ["root-bot-token", "pool-bot-token", "fake-webhook-token", "BOT_TOKEN", "DISCORD_STATE_DIR"]) {
      assert.equal(text.includes(secret), false, `${secret} leaked into ${text.slice(0, 300)}`);
    }
  }
  assert.equal(mcpWrites[0].message.params.value.env.CCDM_ROUTER_KEY_FILE, path.join(workspace.routerStateDir, "keys", "demo.key"));
  for (const file of fs.readdirSync(launchDir)) {
    assert.equal(fs.statSync(path.join(launchDir, file)).mode & 0o777, 0o600, file);
  }
  assert.equal(fs.statSync(path.join(workspace.routerStateDir, "keys", "demo.key")).mode & 0o777, 0o600);
});

test("a router Codex launch whose Router hello fails exits non-zero and cleans up", async () => {
  const workspace = codexRouterWorkspace(0);
  const codex = await startFakeCodexServer(workspace, { channelId: "demo-channel" });
  setPort(workspace, codex.port);
  // No Router is running, so the bridge's hello cannot succeed.

  const started = await startCodexSession(workspace, { CCDM_CODEX_LAUNCH_TIMEOUT_S: "20" });

  assert.notEqual(started.exitCode, 0, started.stdout);
  assert.match(started.stderr, /Router hello failed: router_unavailable/);
  const state = readState(workspace.stateDir);
  assert.equal(state.fixtures.tmux.sessions.demo_codex, undefined);
  assert.equal(fs.existsSync(path.join(workspace.routerStateDir, "keys", "demo.key")), false);
  assert.equal(fs.existsSync(path.join(workspace.routerStateDir, "launches", "demo")), false);
  const registry = readRegistry(workspace);
  assert.equal(registry.projects.demo.pid, null);
  assert.equal(registry.projects.demo.session_id, null);
});
