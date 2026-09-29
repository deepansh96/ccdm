import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { injectDiscordMessage, waitForState } from "./support/bridge.js";
import { runScript } from "./support/runner.js";
import {
  OWNER_ID,
  createRouterWorkspace,
  routerEnv,
  routerRegistry,
  routerWithWebhooks,
  runRouterCli,
} from "./support/router.js";
import { readState, writeState } from "./support/state.js";
import { cleanup } from "./support/teardown.js";

test.afterEach(async () => {
  await cleanup();
});

// `demo` is a router-transport Claude project with a tmux session name and path.
function claudeRouterWorkspace() {
  const workspace = createRouterWorkspace(routerRegistry({
    demo: {
      channel_id: "demo-channel", type: "claude", transport: "router", guest_user_ids: ["guest-id"],
      screen_name: "demo_claude", session_id: null, pid: null,
    },
  }));
  const registryFile = path.join(workspace.repoDir, "registry.json");
  const registry = JSON.parse(fs.readFileSync(registryFile, "utf8"));
  registry.projects.demo.path = workspace.tmpDir;
  fs.writeFileSync(registryFile, `${JSON.stringify(registry, null, 2)}\n`);
  return workspace;
}

function startSession(workspace, extraEnv = {}) {
  return runScript(workspace, "scripts/start-session.sh", { args: ["demo"], env: routerEnv(workspace, extraEnv) });
}

test("start-session launches a router Claude project whose channel server says hello to the Router", async () => {
  const workspace = claudeRouterWorkspace();
  await routerWithWebhooks(workspace, ["demo"]);

  const started = await startSession(workspace);

  assert.equal(started.exitCode, 0, started.stderr || started.stdout);
  const status = await runRouterCli(workspace, ["status"]);
  assert.equal(status.exitCode, 0, status.stderr);
  assert.match(status.stdout, /sessions: 1\n  project demo scope=demo-channel connected=/);
  const session = readState(workspace.stateDir).fixtures.tmux.sessions.demo_claude;
  assert.deepEqual(session.sendKeys, [["Enter"]]);
  const registry = JSON.parse(fs.readFileSync(path.join(workspace.repoDir, "registry.json"), "utf8"));
  assert.equal(typeof registry.projects.demo.pid, "number");
});

test("an owner message reaches the session as a channel notification and its reply posts as demo-claude", async () => {
  const workspace = claudeRouterWorkspace();
  const router = await routerWithWebhooks(workspace, ["demo"]);
  const state = readState(workspace.stateDir);
  state.fixtures.claude.replyText = "on it";
  writeState(state, workspace.stateDir);
  const started = await startSession(workspace);
  assert.equal(started.exitCode, 0, started.stderr || started.stdout);

  injectDiscordMessage(workspace, {
    id: "owner-message-1",
    channelId: "demo-channel",
    content: "please run the tests",
    createdTimestamp: Date.parse("2026-09-29T10:00:00.000Z"),
    author: { id: OWNER_ID, username: "Owner" },
    attachments: [{ id: "att-1", name: "notes.txt", contentType: "text/plain", size: 2048,
      url: "https://cdn.discordapp.com/attachments/demo-channel/att-1/notes.txt" }],
  });

  const done = await waitForState(workspace, (next) => next.fixtures.discord.messages.length > 0
    && next.fixtures.claude.toolResults?.length > 0);
  assert.deepEqual(done.fixtures.claude.channelNotifications, [{
    content: "please run the tests",
    meta: {
      chat_id: "demo-channel", message_id: "owner-message-1", user: "Owner", user_id: OWNER_ID,
      ts: "2026-09-29T10:00:00.000Z", attachment_count: "1", attachments: "notes.txt (text/plain, 2KB)",
    },
  }], router.stdout);
  assert.deepEqual(done.fixtures.discord.messages.map(({ channelId, content, username, webhookId }) => ({ channelId, content, username, webhookId })), [
    { channelId: "demo-channel", content: "on it", username: "demo-claude", webhookId: "fake-webhook-1" },
  ]);
  assert.deepEqual(done.fixtures.claude.toolResults, [
    { name: "reply", result: { content: [{ type: "text", text: "sent (id: fake-message-1)" }] } },
  ]);
});

test("no Discord bot or webhook token reaches the session environment, launch files, or MCP config", async () => {
  const workspace = claudeRouterWorkspace();
  await routerWithWebhooks(workspace, ["demo"]);
  const started = await startSession(workspace);
  assert.equal(started.exitCode, 0, started.stderr || started.stdout);

  const state = readState(workspace.stateDir);
  const launchDir = path.join(workspace.routerStateDir, "launches", "demo");
  const launchFiles = fs.readdirSync(launchDir).map((file) => fs.readFileSync(path.join(launchDir, file), "utf8"));
  const mcpConfig = JSON.parse(fs.readFileSync(path.join(launchDir, "mcp.json"), "utf8"));
  const surfaces = [
    JSON.stringify(state.fixtures.tmux.sessions.demo_claude),
    JSON.stringify(state.fixtures.claude.invocations),
    JSON.stringify(state.fixtures.claude.sessionEnvironments),
    ...launchFiles,
  ];
  assert.equal(state.fixtures.claude.sessionEnvironments.length, 2);
  for (const text of surfaces) {
    for (const secret of ["root-bot-token", "pool-bot-token", "fake-webhook-token", "DISCORD_BOT_TOKEN", "DISCORD_STATE_DIR"]) {
      assert.equal(text.includes(secret), false, `${secret} leaked into ${text.slice(0, 200)}`);
    }
  }
  assert.deepEqual(Object.keys(mcpConfig.mcpServers), ["ccdm"]);
  assert.deepEqual(mcpConfig.mcpServers.ccdm.args, [path.join(workspace.repoDir, "scripts", "ccdm-channel-server.js")]);
  for (const file of fs.readdirSync(launchDir)) {
    assert.equal(fs.statSync(path.join(launchDir, file)).mode & 0o777, 0o600, file);
  }
  assert.equal(fs.statSync(path.join(workspace.routerStateDir, "keys", "demo.key")).mode & 0o777, 0o600);
});

function assertLaunchCleanedUp(workspace) {
  const state = readState(workspace.stateDir);
  assert.equal(state.fixtures.tmux.sessions.demo_claude, undefined);
  assert.equal(fs.existsSync(path.join(workspace.routerStateDir, "keys", "demo.key")), false);
  assert.equal(fs.existsSync(path.join(workspace.routerStateDir, "launches", "demo")), false);
  const registry = JSON.parse(fs.readFileSync(path.join(workspace.repoDir, "registry.json"), "utf8"));
  assert.equal(registry.projects.demo.pid, null);
  assert.equal(registry.projects.demo.session_id, null);
}

test("a launch whose development-channel confirmation never appears exits non-zero and cleans up", async () => {
  const workspace = claudeRouterWorkspace();
  await routerWithWebhooks(workspace, ["demo"]);
  const state = readState(workspace.stateDir);
  state.fixtures.tmux.devChannelPrompt = "never";
  writeState(state, workspace.stateDir);

  const started = await startSession(workspace, { CCDM_CLAUDE_LAUNCH_TIMEOUT_S: "1" });

  assert.notEqual(started.exitCode, 0, started.stdout);
  assert.match(started.stderr, /development-channel confirmation never appeared/);
  assert.equal(readState(workspace.stateDir).fixtures.tmux.lastKilledSessions?.demo_claude?.killAttempts, 1);
  assertLaunchCleanedUp(workspace);
});

test("a launch whose Router hello fails exits non-zero and cleans up", async () => {
  const workspace = claudeRouterWorkspace();
  // No Router is running, so the channel server's hello cannot succeed.

  const started = await startSession(workspace, { CCDM_CLAUDE_LAUNCH_TIMEOUT_S: "10" });

  assert.notEqual(started.exitCode, 0, started.stdout);
  assert.match(started.stderr, /Router hello failed: router_unavailable/);
  assertLaunchCleanedUp(workspace);
});

test("after stop-session the Router treats the channel as offline and the next owner message gets 💤", async () => {
  const workspace = claudeRouterWorkspace();
  const router = await routerWithWebhooks(workspace, ["demo"]);
  const started = await startSession(workspace);
  assert.equal(started.exitCode, 0, started.stderr || started.stdout);

  const stopped = await runScript(workspace, "scripts/stop-session.sh", { args: ["demo"], env: routerEnv(workspace) });

  assert.equal(stopped.exitCode, 0, stopped.stderr || stopped.stdout);
  assert.match(stopped.stdout, /Stopped Discord session 'demo'/);
  const status = await runRouterCli(workspace, ["status"]);
  assert.match(status.stdout, /sessions: 0\n/);
  injectDiscordMessage(workspace, {
    id: "owner-message-2", channelId: "demo-channel", content: "are you there?",
    author: { id: OWNER_ID, username: "Owner" },
  });
  const done = await waitForState(workspace, (next) => next.fixtures.discord.reactions.length > 0);
  assert.deepEqual(done.fixtures.discord.reactions.map(({ channelId, messageId, emoji }) => ({ channelId, messageId, emoji })), [
    { channelId: "demo-channel", messageId: "owner-message-2", emoji: encodeURIComponent("💤") },
  ], router.stdout);
  assert.deepEqual(done.fixtures.claude.channelNotifications ?? [], []);
  const registry = JSON.parse(fs.readFileSync(path.join(workspace.repoDir, "registry.json"), "utf8"));
  assert.equal(registry.projects.demo.pid, null);
});
