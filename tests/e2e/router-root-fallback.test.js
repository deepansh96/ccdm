import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";

import { injectDiscordMessage, startFakeCodexServer, waitForState } from "./support/bridge.js";
import { runScript } from "./support/runner.js";
import {
  OWNER_ID,
  ROOT_TOKEN,
  createRouterWorkspace,
  routerEnv,
  routerRegistry,
  routerWithWebhooks,
  runRouterCli,
  startRouter,
  waitFor,
} from "./support/router.js";
import { readState, updateState } from "./support/state.js";
import { cleanup } from "./support/teardown.js";

test.afterEach(async () => {
  await cleanup();
});

// The fake gateway's bot user, as `client.user` reports it.
const BOT_ID = "fixture-bot-user-id";
const NOTICE = "⚠️ The CCDM Router is unreachable: root is answering root channels through its emergency direct connection until the Router is back.";
// Shortened so the fallback engages after a second, not two minutes.
const FALLBACK_ENV = {
  CCDM_ROOT_FALLBACK_AFTER_MS: "1000",
  CCDM_ROUTER_RECONNECT_MIN_MS: "50",
  CCDM_ROUTER_RECONNECT_MAX_MS: "200",
};

function rootWorkspace() {
  const workspace = createRouterWorkspace({
    ...routerRegistry(),
    root_channels: ["root-channel", "other-root-channel"],
    root_allowed_user_ids: ["helper-id"],
  });
  fs.mkdirSync(path.join(workspace.homeDir, ".codex"), { recursive: true });
  return workspace;
}

function owner(workspace, message) {
  injectDiscordMessage(workspace, { author: { id: OWNER_ID, username: "Owner" }, ...message });
}

// Root's session as `router status` reports it, once root has said hello again.
async function rootSessionAfterRestart(workspace, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await runRouterCli(workspace, ["status", "--json"]);
    const session = result.exitCode === 0 && JSON.parse(result.stdout).sessions.find((next) => next.role === "root");
    if (session) return session;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for root's hello after the Router restart");
}

const MODES = {
  claude: {
    restart: (workspace) => runScript(workspace, "restart-root-agent.sh", { env: routerEnv(workspace, FALLBACK_ENV), timeoutMs: 20000 }),
    async launch(workspace) {
      const restarted = await runScript(workspace, "restart-root-agent.sh", { env: routerEnv(workspace, FALLBACK_ENV), timeoutMs: 20000 });
      assert.equal(restarted.exitCode, 0, restarted.stderr || restarted.stdout);
      return {
        delivered: () => (readState(workspace.stateDir).fixtures.claude.channelNotifications ?? [])
          .map((notification) => notification.meta.message_id),
      };
    },
  },
  codex: {
    restart: (workspace) => runScript(workspace, "restart-root-codex-agent.sh", {
      args: ["root-channel"], env: routerEnv(workspace, FALLBACK_ENV), timeoutMs: 30000,
    }),
    async launch(workspace, codexOptions = {}) {
      const codex = await startFakeCodexServer(workspace, codexOptions);
      const restarted = await runScript(workspace, "restart-root-codex-agent.sh", {
        args: ["root-channel"],
        env: routerEnv(workspace, { ROOT_CODEX_WS_PORT: String(codex.port), ...FALLBACK_ENV }),
        timeoutMs: 30000,
      });
      assert.equal(restarted.exitCode, 0, restarted.stderr || restarted.stdout);
      return {
        codex,
        delivered: () => codex.clientMessages
          .filter((message) => message.method === "turn/start")
          .map((message) => message.params.input?.[0]?.text?.match(/^message_id: (\S+)$/m)?.[1])
          .filter(Boolean),
      };
    },
  },
};

for (const [mode, { launch, restart }] of Object.entries(MODES)) {
  test(`root ${mode} falls back to a direct gateway for root channels while the Router is down, and hands back before rejoining`, async () => {
    const workspace = rootWorkspace();
    const router = await routerWithWebhooks(workspace, ["demo"]);
    const root = await launch(workspace);
    // Nothing reaches Discord directly while the Router serves root.
    assert.deepEqual(readState(workspace.stateDir).fixtures.discord.logins ?? [], [{ token: ROOT_TOKEN }]);

    process.kill(-router.child.pid, "SIGKILL");
    await router.closed;

    // After the threshold root logs in with its own token and says so in the primary root channel.
    const engaged = await waitForState(workspace, (next) => next.fixtures.discord.messages.length > 0, 15000);
    assert.deepEqual(engaged.fixtures.discord.logins, [{ token: ROOT_TOKEN }, { token: ROOT_TOKEN }]);
    assert.deepEqual(engaged.fixtures.discord.messages.map(({ channelId, content, authorization, webhookId }) =>
      ({ channelId, content, authorization, webhookId })), [
      { channelId: "root-channel", content: NOTICE, authorization: `Bot ${ROOT_TOKEN}`, webhookId: undefined },
    ]);

    // Only root channels, and only the owner and root's allowed users, reach root.
    owner(workspace, { id: "project-mention", channelId: "demo-channel", content: `<@${BOT_ID}> restart demo` });
    owner(workspace, { id: "project-plain", channelId: "demo-channel", content: "hello demo" });
    injectDiscordMessage(workspace, { id: "stranger", channelId: "root-channel", content: "let me in",
      author: { id: "stranger-id", username: "Stranger" } });
    owner(workspace, { id: "in-fallback", channelId: "root-channel", content: "status?" });
    injectDiscordMessage(workspace, { id: "helper-fallback", channelId: "other-root-channel", content: "and here?",
      author: { id: "helper-id", username: "Helper" } });
    await waitFor(() => root.delivered().length >= 2, () => `the fallback deliveries; delivered ${JSON.stringify(root.delivered())}` +
      (root.codex ? `; Codex requests ${JSON.stringify(root.codex.clientMessages.map((message) => message.method ?? `response:${message.id}`))}` : "") +
      `; discord ${JSON.stringify(readState(workspace.stateDir).fixtures.discord.injectedMessages.map(({ id, delivered }) => [id, delivered]))}`, 15000);
    assert.deepEqual(root.delivered(), ["in-fallback", "helper-fallback"]);

    // A message sent while the Router comes back is delivered once, and the
    // direct client is gone before root's hello succeeds.
    owner(workspace, { id: "during-switch", channelId: "root-channel", content: "switching?" });
    await startRouter(workspace);
    const rejoined = await rootSessionAfterRestart(workspace);
    owner(workspace, { id: "after-switch", channelId: "root-channel", content: "back?" });
    await waitFor(() => root.delivered().includes("after-switch"), () => "the message after the switch", 15000);

    assert.deepEqual(root.delivered(), ["in-fallback", "helper-fallback", "during-switch", "after-switch"]);
    const { destroys } = readState(workspace.stateDir).fixtures.discord;
    assert.equal(destroys.length, 1, JSON.stringify(destroys));
    assert.ok(Date.parse(destroys[0].at) <= Date.parse(rejoined.connected_at),
      `direct client destroyed at ${destroys[0].at}, root hello_ok at ${rejoined.connected_at}`);
    // The notice is posted once, by the fallback alone.
    assert.equal(readState(workspace.stateDir).fixtures.discord.messages.filter((m) => m.content === NOTICE).length, 1);
  });
}

for (const [mode, { launch, restart }] of Object.entries(MODES)) {
  test(`restarting root ${mode} while the Router is down fails and leaves the emergency root running with its key`, async () => {
    const workspace = rootWorkspace();
    const router = await routerWithWebhooks(workspace, ["demo"]);
    const root = await launch(workspace);
    process.kill(-router.child.pid, "SIGKILL");
    await router.closed;
    await waitForState(workspace, (next) => next.fixtures.discord.messages.some((m) => m.content === NOTICE), 15000);
    const keyFile = path.join(workspace.routerStateDir, "keys", ".root.key");
    const key = fs.readFileSync(keyFile, "utf8");
    const session = readState(workspace.stateDir).fixtures.tmux.sessions.root_agent;

    const restarted = await restart(workspace);

    assert.notEqual(restarted.exitCode, 0, restarted.stdout);
    assert.match(restarted.stderr, /Router is not answering/);
    const after = readState(workspace.stateDir).fixtures.tmux.sessions.root_agent;
    assert.equal(after?.pid, session.pid);
    assert.equal(after.killAttempts, session.killAttempts);
    process.kill(session.pid, 0);
    assert.equal(fs.readFileSync(keyFile, "utf8"), key);
    owner(workspace, { id: "after-restart", channelId: "root-channel", content: "still there?" });
    await waitFor(() => root.delivered().includes("after-restart"), () => "the message after the refused restart", 15000);
  });
}

// Stops the Router and waits for root's fallback notice.
async function routerDown(workspace, router) {
  process.kill(-router.child.pid, "SIGKILL");
  await router.closed;
  await waitForState(workspace, (next) => next.fixtures.discord.messages.some((m) => m.content === NOTICE), 15000);
}

// What root sent to Discord itself, as the bot.
function botActivity(workspace) {
  const { messages, edits = [], reactions = [], typing = [] } = readState(workspace.stateDir).fixtures.discord;
  return {
    messages: messages.filter((m) => m.content !== NOTICE).map(({ channelId, content, authorization, webhookId }) =>
      ({ channelId, content, authorization, webhookId })),
    edits: edits.map(({ channelId, messageId, content, authorization }) => ({ channelId, messageId, content, authorization })),
    reactions: reactions.map(({ channelId, messageId, emoji, authorization }) => ({ channelId, messageId, emoji, authorization })),
    typing,
  };
}

const EYES = encodeURIComponent("👀");
const BOT = `Bot ${ROOT_TOKEN}`;

test("root claude replies, edits, reacts, and types in root channels through the fallback, and goes back to the Router once it returns", async () => {
  const workspace = rootWorkspace();
  const router = await routerWithWebhooks(workspace, ["demo"]);
  await MODES.claude.launch(workspace);
  await routerDown(workspace, router);
  const script = (steps) => updateState(workspace.stateDir, (state) => { state.fixtures.claude.toolScript = steps; });
  const results = () => (readState(workspace.stateDir).fixtures.claude.toolResults ?? [])
    .map(({ result }) => result.content[0].text);

  script([
    { name: "reply", arguments: { chat_id: "{{chat_id}}", text: "answered directly" } },
    { name: "edit_message", arguments: { chat_id: "{{chat_id}}", message_id: "{{last_id}}", text: "edited directly" } },
    { name: "react", arguments: { chat_id: "{{chat_id}}", message_id: "{{message_id}}", emoji: "👀" } },
    { name: "edit_message", arguments: { chat_id: "{{chat_id}}", message_id: "{{message_id}}", text: "not root's" } },
    { name: "reply", arguments: { chat_id: "demo-channel", text: "into a project" } },
  ]);
  owner(workspace, { id: "in-fallback", channelId: "root-channel", content: "status?" });
  await waitFor(() => results().length >= 5, () => `the fallback tool results; got ${JSON.stringify(results())}`, 15000);

  const [reply, edit, react, foreignEdit, projectReply] = results();
  assert.deepEqual([reply, edit, react], ["sent (id: fake-message-2)", "edited (id: fake-message-2)", "reacted"]);
  assert.match(foreignEdit, /^edit_message failed: scope_violation/);
  assert.match(projectReply, /^reply failed: scope_violation/);
  const direct = botActivity(workspace);
  assert.deepEqual(direct.messages, [{ channelId: "root-channel", content: "answered directly", authorization: BOT, webhookId: undefined }]);
  assert.deepEqual(direct.edits, [{ channelId: "root-channel", messageId: "fake-message-2", content: "edited directly", authorization: BOT }]);
  assert.deepEqual(direct.reactions, [{ channelId: "root-channel", messageId: "in-fallback", emoji: EYES, authorization: BOT }]);
  assert.ok(direct.typing.some((entry) => entry.channelId === "root-channel" && entry.authorization === BOT), JSON.stringify(direct.typing));

  // Back on the Router, root reaches registered project channels again.
  script([{ name: "reply", arguments: { chat_id: "demo-channel", text: "back through the Router" } }]);
  await startRouter(workspace);
  await rootSessionAfterRestart(workspace);
  owner(workspace, { id: "after-switch", channelId: "root-channel", content: "back?" });
  await waitFor(() => results().length >= 6, () => `the tool result after the switch; got ${JSON.stringify(results())}`, 15000);
  assert.equal(results()[5], "sent (id: fake-message-3)");
  assert.deepEqual(botActivity(workspace).messages.at(-1),
    { channelId: "demo-channel", content: "back through the Router", authorization: BOT, webhookId: undefined });
});

test("root codex replies, edits, reacts, and types in root channels through the fallback, and goes back to the Router once it returns", async () => {
  const workspace = rootWorkspace();
  const router = await routerWithWebhooks(workspace, ["demo"]);
  const grant = (input) => input[0].text.match(/channel_scope_token: (\S+)/)[1];
  await MODES.codex.launch(workspace, { turns: [
    { mcpCalls: (input) => {
      const scope = { channel_id: "root-channel", channel_scope_token: grant(input) };
      return [
        ["reply", { ...scope, text: "answered directly" }],
        ["edit_message", { ...scope, message_id: "{{last_id}}", text: "edited directly" }],
        ["react", { ...scope, message_id: "in-fallback", emoji: "👀" }],
        ["edit_message", { ...scope, message_id: "in-fallback", text: "not root's" }],
        ["reply", { channel_id: "demo-channel", channel_scope_token: grant(input), text: "into a project" }],
      ];
    } },
    { mcpCalls: (input) => [["reply", { channel_id: "demo-channel", channel_scope_token: grant(input), text: "back through the Router" }]] },
  ] });
  const results = () => readState(workspace.stateDir).fixtures.codex.protocolEvents
    .filter((event) => event.event === "mcp-tool-result")
    .map(({ result, error }) => result?.content?.[0]?.text ?? error);
  await routerDown(workspace, router);

  owner(workspace, { id: "in-fallback", channelId: "root-channel", content: "status?" });
  await waitFor(() => results().length >= 5, () => `the fallback tool results; got ${JSON.stringify(results())}`, 20000);

  const [reply, edit, react, foreignEdit, projectReply] = results();
  assert.deepEqual([reply, edit, react], ["sent (id: fake-message-2)", "edited (id: fake-message-2)", "reacted with 👀"]);
  assert.match(foreignEdit, /^Error: Emergency edit_message failed: scope_violation/);
  // The owner's grant may name any channel, but the fallback reaches only root channels.
  assert.match(projectReply, /^Error: Emergency reply failed: scope_violation/);
  const direct = botActivity(workspace);
  assert.deepEqual(direct.messages, [{ channelId: "root-channel", content: "answered directly", authorization: BOT, webhookId: undefined }]);
  assert.deepEqual(direct.edits, [{ channelId: "root-channel", messageId: "fake-message-2", content: "edited directly", authorization: BOT }]);
  assert.deepEqual(direct.reactions.filter((entry) => entry.emoji === EYES),
    [{ channelId: "root-channel", messageId: "in-fallback", emoji: EYES, authorization: BOT }]);
  assert.ok(direct.typing.some((entry) => entry.channelId === "root-channel" && entry.authorization === BOT), JSON.stringify(direct.typing));

  // Back on the Router, a project-channel mention's grant reaches that channel again.
  await startRouter(workspace);
  await rootSessionAfterRestart(workspace);
  owner(workspace, { id: "after-switch", channelId: "demo-channel", content: `<@${BOT_ID}> back?` });
  await waitFor(() => results().length >= 6, () => `the tool result after the switch; got ${JSON.stringify(results())}`, 20000);
  assert.equal(results()[5], "sent (id: fake-message-3)");
  assert.deepEqual(botActivity(workspace).messages.at(-1),
    { channelId: "demo-channel", content: "back through the Router", authorization: BOT, webhookId: undefined });
  assert.equal(fs.existsSync(path.join(workspace.routerStateDir, "launches", ".root", "emergency.json")), false);
});

// The one place the real fallback threshold is asserted; every other test shortens it.
test("root's emergency fallback engages after about two minutes by default, overridable by environment", () => {
  const { fallbackThresholdMs } = createRequire(import.meta.url)("../../scripts/router/emergency.js");

  assert.equal(fallbackThresholdMs({}), 120000);
  assert.equal(fallbackThresholdMs({ CCDM_ROOT_FALLBACK_AFTER_MS: "1000" }), 1000);
});
