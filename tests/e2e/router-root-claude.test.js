import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { assertPrivate } from "./support/platform.js";
import { injectDiscordMessage, waitForState } from "./support/bridge.js";
import { runScript } from "./support/runner.js";
import {
  OWNER_ID,
  ROOT_TOKEN,
  connectSession,
  createRouterWorkspace,
  routerEnv,
  routerRegistry,
  routerWithWebhooks,
  runRouterCli,
  startRefusingRouter,
  waitFor,
} from "./support/router.js";
import { startFakeHost } from "./support/session-fixture.js";
import { readState, updateState } from "./support/state.js";
import { cleanup } from "./support/teardown.js";

test.afterEach(async () => {
  await cleanup();
});

// The fake gateway's bot user, as `client.user` reports it to the Router.
const BOT_ID = "fixture-bot-user-id";

function rootWorkspace() {
  return createRouterWorkspace({
    ...routerRegistry(),
    root_channels: ["root-channel"],
    root_allowed_user_ids: ["helper-id"],
  });
}

// On Windows the launcher goes through the fake ccdm-host, sharing the fixture's session table.
const WIN = process.platform === "win32";
const fakeHosts = new WeakMap();
async function launcherEnv(workspace) {
  if (!WIN) return {};
  if (!fakeHosts.has(workspace)) fakeHosts.set(workspace, await startFakeHost(workspace, { env: routerEnv(workspace) }));
  return fakeHosts.get(workspace).env;
}

// A Windows temp folder can carry a short (8.3) name; the `ccdm` entry starts Python from the long one.
const repoAsLaunched = workspace => (WIN ? fs.realpathSync.native(workspace.repoDir) : workspace.repoDir);

// Where a restart helper would write its log: `<stateRoot>/logs`.
async function logsDir(workspace) {
  const stateRoot = WIN ? (await launcherEnv(workspace)).CCDM_STATE_ROOT : path.join(workspace.homeDir, ".local", "state", "ccdm");
  return path.join(stateRoot, "logs");
}

async function restartRoot(workspace, extraEnv = {}) {
  return runScript(workspace, "restart-root-agent.sh", {
    env: routerEnv(workspace, { ...(await launcherEnv(workspace)), ...extraEnv }),
    timeoutMs: 20000,
  });
}

test("restart-root-agent launches root Claude whose channel server says hello to the Router as root", async () => {
  const workspace = rootWorkspace();
  await routerWithWebhooks(workspace, ["demo"]);

  const restarted = await restartRoot(workspace);

  assert.equal(restarted.exitCode, 0, restarted.stderr || restarted.stdout);
  const status = await runRouterCli(workspace, ["status"]);
  assert.equal(status.exitCode, 0, status.stderr);
  assert.match(status.stdout, /sessions: 1\n  root root scope=/);
  const session = readState(workspace.stateDir).fixtures.tmux.sessions.root_agent;
  assert.equal(session.cwd, repoAsLaunched(workspace));
  assert.deepEqual(session.sendKeys, [["Enter"]]);
});

test("owner messages in a root channel and owner bot mentions in a project channel reach root Claude, not the project", async () => {
  const workspace = rootWorkspace();
  await routerWithWebhooks(workspace, ["demo"]);
  const demo = await connectSession(workspace, "demo", "demo-key");
  const restarted = await restartRoot(workspace);
  assert.equal(restarted.exitCode, 0, restarted.stderr || restarted.stdout);

  injectDiscordMessage(workspace, { id: "in-root", channelId: "root-channel", content: "status of every project?",
    createdTimestamp: Date.parse("2026-09-29T10:00:00.000Z"), author: { id: OWNER_ID, username: "Owner" } });
  injectDiscordMessage(workspace, { id: "mention", channelId: "demo-channel", content: `<@${BOT_ID}> restart demo`,
    createdTimestamp: Date.parse("2026-09-29T10:01:00.000Z"), author: { id: OWNER_ID, username: "Owner" } });
  injectDiscordMessage(workspace, { id: "fence", channelId: "demo-channel", content: "fence",
    author: { id: OWNER_ID, username: "Owner" } });

  const done = await waitForState(workspace, (next) => next.fixtures.claude.channelNotifications?.length >= 2, 10000);
  await waitFor(() => demo.events.some((event) => event.message_id === "fence"), () => "the fence message at demo", 10000);
  assert.deepEqual(done.fixtures.claude.channelNotifications, [
    { content: "status of every project?", meta: {
      chat_id: "root-channel", message_id: "in-root", user: "Owner", user_id: OWNER_ID, ts: "2026-09-29T10:00:00.000Z" } },
    { content: `<@${BOT_ID}> restart demo`, meta: {
      chat_id: "demo-channel", message_id: "mention", user: "Owner", user_id: OWNER_ID, ts: "2026-09-29T10:01:00.000Z" } },
  ]);
  assert.deepEqual(demo.events.map((event) => event.message_id), ["fence"]);
});

test("root Claude's reply into a project channel posts as the root bot, not a webhook", async () => {
  const workspace = rootWorkspace();
  await routerWithWebhooks(workspace, ["demo"]);
  updateState(workspace.stateDir, (state) => {
    state.fixtures.claude.toolScript = [
      { name: "reply", arguments: { chat_id: "demo-channel", text: "restarting demo now" } },
    ];
  });
  const restarted = await restartRoot(workspace);
  assert.equal(restarted.exitCode, 0, restarted.stderr || restarted.stdout);

  injectDiscordMessage(workspace, { id: "in-root", channelId: "root-channel", content: "restart demo",
    author: { id: OWNER_ID, username: "Owner" } });

  const done = await waitForState(workspace, (next) => next.fixtures.claude.toolResults?.length > 0);
  assert.deepEqual(done.fixtures.claude.toolResults, [
    { name: "reply", result: { content: [{ type: "text", text: "sent (id: fake-message-1)" }] } },
  ]);
  assert.deepEqual(done.fixtures.discord.messages.map(({ channelId, content, authorization, webhookId }) =>
    ({ channelId, content, authorization, webhookId })), [
    { channelId: "demo-channel", content: "restarting demo now", authorization: `Bot ${ROOT_TOKEN}`, webhookId: undefined },
  ]);
});

test("no Discord token reaches the root Claude session environment, launch files, or MCP config", async () => {
  const workspace = rootWorkspace();
  await routerWithWebhooks(workspace, ["demo"]);
  const restarted = await restartRoot(workspace);
  assert.equal(restarted.exitCode, 0, restarted.stderr || restarted.stdout);

  const state = readState(workspace.stateDir);
  const launchDir = path.join(workspace.routerStateDir, "launches", ".root");
  const mcpConfig = JSON.parse(fs.readFileSync(path.join(launchDir, "mcp.json"), "utf8"));
  const surfaces = [
    JSON.stringify(state.fixtures.tmux.sessions.root_agent),
    JSON.stringify(state.fixtures.claude.invocations),
    JSON.stringify(state.fixtures.claude.sessionEnvironments),
    ...fs.readdirSync(launchDir).map((file) => fs.readFileSync(path.join(launchDir, file), "utf8")),
  ];
  assert.equal(state.fixtures.claude.sessionEnvironments.length, 2);
  for (const text of surfaces) {
    for (const secret of [ROOT_TOKEN, "pool-bot-token", "fake-webhook-token", "DISCORD_BOT_TOKEN", "DISCORD_STATE_DIR"]) {
      assert.equal(text.includes(secret), false, `${secret} leaked into ${text.slice(0, 200)}`);
    }
  }
  assert.deepEqual(Object.keys(mcpConfig.mcpServers), ["ccdm"]);
  const channelServer = path.join(repoAsLaunched(workspace), "scripts", "ccdm-channel-server.js");
  const rootKey = path.join(workspace.routerStateDir, "keys", ".root.key");
  // Windows names the key file on the command line: another process's environment is not readable there.
  assert.deepEqual(mcpConfig.mcpServers.ccdm.args, WIN ? [channelServer, "--ccdm-key-file", rootKey] : [channelServer]);
  assert.equal(mcpConfig.mcpServers.ccdm.env.CCDM_ROUTER_ROLE, "root");
  for (const file of fs.readdirSync(launchDir)) {
    assertPrivate(path.join(launchDir, file), file);
  }
  assertPrivate(path.join(workspace.routerStateDir, "keys", ".root.key"));
});

test("a root launch with no Router answering exits non-zero before launching or writing root's key", async () => {
  const workspace = rootWorkspace();

  const restarted = await restartRoot(workspace, { CCDM_CLAUDE_LAUNCH_TIMEOUT_S: "10" });

  assert.notEqual(restarted.exitCode, 0, restarted.stdout);
  assert.match(restarted.stderr, /The Router is not answering, so root was not restarted/);
  assert.equal(readState(workspace.stateDir).fixtures.claude.invocations?.length ?? 0, 0);
  assert.equal(readState(workspace.stateDir).fixtures.tmux.sessions.root_agent, undefined);
  assert.equal(fs.existsSync(path.join(workspace.routerStateDir, "keys", ".root.key")), false);
});

test("a root launch whose Router hello fails exits non-zero and removes root's key", async () => {
  const workspace = rootWorkspace();
  // The Router answers its health check but refuses root's hello.
  await startRefusingRouter(workspace);

  const restarted = await restartRoot(workspace, { CCDM_CLAUDE_LAUNCH_TIMEOUT_S: "10" });

  assert.notEqual(restarted.exitCode, 0, restarted.stdout);
  assert.match(restarted.stderr, /Router hello failed: unauthorized/);
  assert.equal(readState(workspace.stateDir).fixtures.tmux.sessions.root_agent, undefined);
  assert.equal(fs.existsSync(path.join(workspace.routerStateDir, "keys", ".root.key")), false);
});

test("a Claude root offers no /restart: its session stays and no restart helper starts", async () => {
  const workspace = rootWorkspace();
  await routerWithWebhooks(workspace, ["demo"]);
  const restarted = await restartRoot(workspace);
  assert.equal(restarted.exitCode, 0, restarted.stderr || restarted.stdout);
  const before = readState(workspace.stateDir).fixtures.tmux.sessions.root_agent;

  injectDiscordMessage(workspace, { id: "restart", channelId: "root-channel", content: "/restart",
    author: { id: OWNER_ID, username: "Owner" } });
  injectDiscordMessage(workspace, { id: "after", channelId: "root-channel", content: "fence",
    author: { id: OWNER_ID, username: "Owner" } });

  const done = await waitForState(workspace, (next) => next.fixtures.claude.channelNotifications?.some(({ meta }) => meta.message_id === "after"), 10000);
  assert.equal(done.fixtures.tmux.sessions.root_agent.pid, before.pid);
  assert.equal(done.fixtures.tmux.lastKilledSessions?.root_agent?.killAttempts ?? 0, before.killAttempts ?? 0);
  const logs = await logsDir(workspace);
  assert.deepEqual(fs.existsSync(logs) ? fs.readdirSync(logs).filter((name) => name.startsWith("restart-")) : [], []);
  assert.deepEqual(done.fixtures.discord.messages, []);
});

test("/model in a root channel is answered by root Claude's channel server from its home, never reaching Claude", async () => {
  const workspace = rootWorkspace();
  fs.mkdirSync(path.join(workspace.homeDir, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(workspace.homeDir, ".claude", "settings.json"), JSON.stringify({ effortLevel: "high" }));
  await routerWithWebhooks(workspace, ["demo"]);
  const restarted = await restartRoot(workspace);
  assert.equal(restarted.exitCode, 0, restarted.stderr || restarted.stdout);

  injectDiscordMessage(workspace, { id: "model", channelId: "root-channel", content: "/model",
    author: { id: OWNER_ID, username: "Owner" } });
  injectDiscordMessage(workspace, { id: "after", channelId: "root-channel", content: "fence",
    author: { id: OWNER_ID, username: "Owner" } });

  const done = await waitForState(workspace, (next) => next.fixtures.discord.messages.length > 0 &&
    next.fixtures.claude.channelNotifications?.length >= 1, 10000);
  assert.deepEqual(done.fixtures.discord.messages.map(({ channelId, content, authorization }) =>
    ({ channelId, content, authorization })), [
    // The home is shown the way the platform writes paths.
    { channelId: "root-channel", authorization: `Bot ${ROOT_TOKEN}`, content:
      `Root's session:\nProvider: claude\nModel: account default\nThinking: high (home config)\nAccount: ${path.join("~", ".claude")}` },
  ]);
  assert.deepEqual(done.fixtures.claude.channelNotifications.map(({ meta }) => meta.message_id), ["after"]);
});
