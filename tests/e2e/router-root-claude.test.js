import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

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

function restartRoot(workspace, extraEnv = {}) {
  return runScript(workspace, "restart-root-agent.sh", { env: routerEnv(workspace, extraEnv), timeoutMs: 20000 });
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
  assert.equal(session.cwd, workspace.repoDir);
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
  assert.deepEqual(mcpConfig.mcpServers.ccdm.args, [path.join(workspace.repoDir, "scripts", "ccdm-channel-server.js")]);
  assert.equal(mcpConfig.mcpServers.ccdm.env.CCDM_ROUTER_ROLE, "root");
  for (const file of fs.readdirSync(launchDir)) {
    assert.equal(fs.statSync(path.join(launchDir, file)).mode & 0o777, 0o600, file);
  }
  assert.equal(fs.statSync(path.join(workspace.routerStateDir, "keys", ".root.key")).mode & 0o777, 0o600);
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
