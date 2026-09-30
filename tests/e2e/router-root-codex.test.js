import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { injectDiscordMessage, injectDiscordReaction, startFakeCodexServer, waitForState } from "./support/bridge.js";
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
import { readState } from "./support/state.js";
import { cleanup } from "./support/teardown.js";

test.afterEach(async () => {
  await cleanup();
});

// The fake gateway's bot user, as `client.user` reports it to the Router.
const BOT_ID = "fixture-bot-user-id";
const HELPER_ID = "helper-id";

function rootWorkspace() {
  const workspace = createRouterWorkspace({
    ...routerRegistry(),
    root_channels: ["root-channel", "other-channel"],
    root_allowed_user_ids: [HELPER_ID],
  });
  fs.mkdirSync(path.join(workspace.homeDir, ".codex"), { recursive: true });
  return workspace;
}

function restartRootCodex(workspace, port, extraEnv = {}) {
  return runScript(workspace, "restart-root-codex-agent.sh", {
    args: ["root-channel"],
    env: routerEnv(workspace, { ROOT_CODEX_WS_PORT: String(port), ...extraEnv }),
    timeoutMs: 30000,
  });
}

// Root Codex against the fake app-server, with the Router serving `demo`.
async function rootCodex(codexOptions = {}) {
  const workspace = rootWorkspace();
  const codex = await startFakeCodexServer(workspace, codexOptions);
  await routerWithWebhooks(workspace, ["demo"]);
  const demo = await connectSession(workspace, "demo", "demo-key");
  const restarted = await restartRootCodex(workspace, codex.port);
  assert.equal(restarted.exitCode, 0, restarted.stderr || restarted.stdout);
  return { workspace, codex, demo };
}

function clientMessages(codex, method) {
  return codex.clientMessages.filter((message) => message.method === method);
}

// Turns started by Discord messages, without the bridge's bootstrap turns.
function routedTurns(codex) {
  return clientMessages(codex, "turn/start")
    .filter((message) => message.params.input?.[0]?.text?.startsWith("Discord routing metadata:"));
}

function grant(input) {
  return input[0].text.match(/channel_scope_token: (\S+)/)[1];
}

function discordMessage(workspace, message) {
  injectDiscordMessage(workspace, { author: { id: OWNER_ID, username: "Owner" }, ...message });
}

test("restart-root-codex-agent starts the bridge in root mode as the Router's root client", async () => {
  const { workspace } = await rootCodex();

  const status = await runRouterCli(workspace, ["status"]);
  assert.equal(status.exitCode, 0, status.stderr);
  assert.match(status.stdout, /\n  root root scope=/);
  const session = readState(workspace.stateDir).fixtures.tmux.sessions.root_agent;
  assert.equal(session.cwd, workspace.repoDir);
  assert.equal(session.env.CCDM_ROUTER_ROLE, "root");
  assert.equal(session.env.CCDM_ROUTER_KEY_FILE, path.join(workspace.routerStateDir, "keys", ".root.key"));
  assert.equal(session.env.CHANNEL_ID, "root-channel");
  assert.equal(session.env.ALLOWED_USER_IDS, `${OWNER_ID},${HELPER_ID}`);
});

test("owner messages in a root channel and owner bot mentions in a project channel reach root Codex, not the project", async () => {
  const { workspace, codex, demo } = await rootCodex();

  discordMessage(workspace, { id: "in-root", channelId: "root-channel", content: "status of every project?" });
  await waitFor(() => routedTurns(codex).length === 1, () => "the root-channel turn", 10000);
  discordMessage(workspace, { id: "mention", channelId: "demo-channel", content: `<@${BOT_ID}> restart demo` });
  discordMessage(workspace, { id: "fence", channelId: "demo-channel", content: "fence" });

  await waitFor(() => demo.events.some((event) => event.message_id === "fence"), () => "the fence message at demo", 10000);
  await waitFor(() => routedTurns(codex).length === 2, () => "the mention turn", 10000);
  const [rootTurn, mentionTurn] = routedTurns(codex).map((turn) => turn.params.input[0].text);
  assert.match(rootTurn, /^channel_id: root-channel$/m);
  assert.match(rootTurn, /^message_id: in-root$/m);
  assert.match(rootTurn, /^author_id: owner-id$/m);
  assert.match(rootTurn, /Message:\nstatus of every project\?$/);
  assert.match(mentionTurn, /^channel_id: demo-channel$/m);
  assert.match(mentionTurn, /^message_id: mention$/m);
  assert.match(mentionTurn, /Message:\n<@fixture-bot-user-id> restart demo$/);
  assert.deepEqual(demo.events.map((event) => event.message_id), ["fence"]);
});

test("root Codex steers the active channel and author, and queues other channels and authors", async () => {
  const { workspace, codex } = await rootCodex({
    steer: ["success", "failure"],
    turns: [
      { turnId: "root-active", waitForRelease: true, delta: "active done" },
      { delta: "other channel done" }, { delta: "other author done" }, { delta: "fallback done" },
    ],
  });

  discordMessage(workspace, { id: "root-start", channelId: "root-channel", content: "start" });
  await waitFor(() => routedTurns(codex).length === 1, () => "the first root turn", 10000);
  const activeGrant = grant(routedTurns(codex)[0].params.input);

  discordMessage(workspace, { id: "root-correction", channelId: "root-channel", content: "correction" });
  await waitFor(() => clientMessages(codex, "turn/steer").length === 1, () => "a steer", 10000);
  const [steer] = clientMessages(codex, "turn/steer");
  assert.equal(steer.params.expectedTurnId, "root-active");
  assert.equal(grant(steer.params.input), activeGrant);
  assert.match(steer.params.input[0].text, /Message:\ncorrection$/);

  discordMessage(workspace, { id: "other-channel-message", channelId: "other-channel", content: "other channel" });
  discordMessage(workspace, { id: "other-author-message", channelId: "root-channel", content: "other author",
    author: { id: HELPER_ID, username: "Helper" } });
  await waitForState(workspace, (next) => ["other-channel-message", "other-author-message"].every((id) =>
    next.fixtures.discord.reactions.some((r) => r.messageId === id && decodeURIComponent(r.emoji) === "⏳")), 10000);
  assert.equal(clientMessages(codex, "turn/steer").length, 1);
  assert.equal(routedTurns(codex).length, 1);

  // A failed steer queues the message for its own turn.
  discordMessage(workspace, { id: "root-fallback", channelId: "root-channel", content: "fallback" });
  await waitFor(() => clientMessages(codex, "turn/steer").length === 2, () => "the second steer", 10000);
  codex.releaseTurn("root-active");

  await waitFor(() => routedTurns(codex).length === 4, () => "the three queued turns", 15000);
  const queued = routedTurns(codex).slice(1).map((turn) => turn.params.input);
  assert.match(queued[0][0].text, /^channel_id: other-channel$/m);
  assert.match(queued[1][0].text, /^author_id: helper-id$/m);
  assert.match(queued[2][0].text, /Message:\nfallback$/);
  for (const input of queued) assert.notEqual(grant(input), activeGrant);
});

test("root Codex's reply into a project channel posts as the root bot, not a webhook", async () => {
  const { workspace, codex } = await rootCodex({
    turns: [{
      mcpReplyText: "restarting demo now",
      mcpReplyArgs: (input) => ({
        channel_id: "demo-channel",
        channel_scope_token: grant(input),
      }),
    }],
  });

  discordMessage(workspace, { id: "mention", channelId: "demo-channel", content: `<@${BOT_ID}> restart demo` });

  const done = await waitForState(workspace, (next) => next.fixtures.discord.messages.length > 0, 15000);
  assert.deepEqual(done.fixtures.discord.messages.map(({ channelId, content, authorization, webhookId }) =>
    ({ channelId, content, authorization, webhookId })), [
    { channelId: "demo-channel", content: "restarting demo now", authorization: `Bot ${ROOT_TOKEN}`, webhookId: undefined },
  ]);
  // The MCP server's reply did not take the bridge's place as root's listener.
  discordMessage(workspace, { id: "after-reply", channelId: "root-channel", content: "still there?" });
  await waitFor(() => routedTurns(codex).length === 2, () => "a turn after the reply", 10000);
});

test("an owner 👍 on root's own bot reply in a root channel reaches root Codex, and one on another message does not", async () => {
  const { workspace, codex } = await rootCodex();
  const owner = { id: OWNER_ID, username: "Owner" };

  injectDiscordReaction(workspace, {
    id: "on-owner-message", channelId: "root-channel", emoji: "👍", messageId: "4001", user: owner,
    message: { author: { bot: false, id: OWNER_ID, username: "Owner" }, content: "my own note" },
  });
  injectDiscordReaction(workspace, {
    id: "on-webhook-message", channelId: "root-channel", emoji: "👍", messageId: "4002", user: owner,
    message: { author: { bot: true, id: "fake-webhook-1", username: "demo-codex" }, webhookId: "fake-webhook-1", content: "demo said" },
  });
  await waitForState(workspace, (next) => ["on-owner-message", "on-webhook-message"].every((id) =>
    next.fixtures.discord.deliveredReactions?.some((reaction) => reaction.id === id)), 10000);
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(routedTurns(codex).length, 0);

  injectDiscordReaction(workspace, {
    id: "on-root-reply", channelId: "root-channel", emoji: "👍", messageId: "4003", user: owner,
    message: { author: { bot: true, id: BOT_ID, username: "Root" }, content: "All projects are healthy.", partial: true },
  });
  await waitFor(() => routedTurns(codex).length === 1, () => "the reaction turn", 10000);

  const [turn] = routedTurns(codex).map((message) => message.params.input[0].text);
  assert.match(turn, /^channel_id: root-channel$/m);
  assert.match(turn, /User Owner reacted 👍 to your message: "All projects are healthy." \(message ID: 4003\)\.$/);
});

test("/restart in the primary root channel relaunches root Codex through the restart script", async () => {
  const { workspace, codex } = await rootCodex();
  const before = readState(workspace.stateDir).fixtures.tmux.sessions.root_agent;

  discordMessage(workspace, { id: "root-restart", channelId: "root-channel", content: "/restart" });

  const done = await waitForState(workspace, (next) => {
    const session = next.fixtures.tmux.sessions.root_agent;
    return session && session.pid !== before.pid;
  }, 30000);
  assert.deepEqual(done.fixtures.discord.messages.map(({ channelId, content }) => ({ channelId, content })), [
    { channelId: "root-channel", content: "Restarting root session — fresh thread coming up." },
  ]);
  assert.equal(done.fixtures.tmux.sessions.root_agent.env.CHANNEL_ID, "root-channel");
  assert.equal(done.fixtures.tmux.sessions.root_agent.env.CCDM_ROUTER_ROLE, "root");
  // The relaunched bridge becomes root's listener once it says hello.
  const turnsBefore = routedTurns(codex).length;
  for (let attempt = 0; routedTurns(codex).length === turnsBefore; attempt++) {
    assert.ok(attempt < 30, "no turn after the restart");
    discordMessage(workspace, { id: `after-restart-${attempt}`, channelId: "root-channel", content: "back?" });
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
});

test("no Discord token reaches the root Codex session environment, launch files, or bridge MCP config", async () => {
  const { workspace, codex } = await rootCodex();

  const state = readState(workspace.stateDir);
  const launchDir = path.join(workspace.routerStateDir, "launches", ".root");
  const mcpWrites = clientMessages(codex, "config/value/write");
  assert.equal(mcpWrites.length, 1);
  const surfaces = [
    JSON.stringify(state.fixtures.tmux.sessions.root_agent),
    JSON.stringify(state.fixtures.codex.bridgeInvocations),
    JSON.stringify(mcpWrites),
    ...fs.readdirSync(launchDir).map((file) => fs.readFileSync(path.join(launchDir, file), "utf8")),
  ];
  for (const text of surfaces) {
    for (const secret of [ROOT_TOKEN, "pool-bot-token", "fake-webhook-token", "BOT_TOKEN", "DISCORD_STATE_DIR"]) {
      assert.equal(text.includes(secret), false, `${secret} leaked into ${text.slice(0, 300)}`);
    }
  }
  const mcpEnv = mcpWrites[0].params.value.env;
  assert.equal(mcpEnv.CCDM_ROUTER_KEY_FILE, path.join(workspace.routerStateDir, "keys", ".root.key"));
  assert.equal(mcpEnv.CCDM_ROUTER_ROLE, "root");
  assert.equal(fs.statSync(path.join(workspace.routerStateDir, "keys", ".root.key")).mode & 0o777, 0o600);
});

test("a root Codex launch with no Router answering exits non-zero before launching or writing root's key", async () => {
  const workspace = rootWorkspace();
  const codex = await startFakeCodexServer(workspace);

  const restarted = await restartRootCodex(workspace, codex.port, { CCDM_CODEX_LAUNCH_TIMEOUT_S: "20" });

  assert.notEqual(restarted.exitCode, 0, restarted.stdout);
  assert.match(restarted.stderr, /The Router is not answering, so root was not restarted/);
  assert.equal(readState(workspace.stateDir).fixtures.tmux.sessions.root_agent, undefined);
  assert.equal(fs.existsSync(path.join(workspace.routerStateDir, "keys", ".root.key")), false);
});

test("a root Codex launch whose Router hello fails exits non-zero and removes root's key", async () => {
  const workspace = rootWorkspace();
  const codex = await startFakeCodexServer(workspace);
  // The Router answers its health check but refuses root's hello.
  await startRefusingRouter(workspace);

  const restarted = await restartRootCodex(workspace, codex.port, { CCDM_CODEX_LAUNCH_TIMEOUT_S: "20" });

  assert.notEqual(restarted.exitCode, 0, restarted.stdout);
  assert.match(restarted.stderr, /Router hello failed: unauthorized/);
  assert.equal(readState(workspace.stateDir).fixtures.tmux.sessions.root_agent, undefined);
  assert.equal(fs.existsSync(path.join(workspace.routerStateDir, "keys", ".root.key")), false);
});
