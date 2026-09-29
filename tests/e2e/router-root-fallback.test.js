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
import { readState } from "./support/state.js";
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
    async launch(workspace) {
      const restarted = await runScript(workspace, "restart-root-agent.sh", { env: routerEnv(workspace, FALLBACK_ENV) });
      assert.equal(restarted.exitCode, 0, restarted.stderr || restarted.stdout);
      return {
        delivered: () => (readState(workspace.stateDir).fixtures.claude.channelNotifications ?? [])
          .map((notification) => notification.meta.message_id),
      };
    },
  },
  codex: {
    async launch(workspace) {
      const codex = await startFakeCodexServer(workspace);
      const restarted = await runScript(workspace, "restart-root-codex-agent.sh", {
        args: ["root-channel"],
        env: routerEnv(workspace, { ROOT_CODEX_WS_PORT: String(codex.port), ...FALLBACK_ENV }),
        timeoutMs: 30000,
      });
      assert.equal(restarted.exitCode, 0, restarted.stderr || restarted.stdout);
      return {
        delivered: () => codex.clientMessages
          .filter((message) => message.method === "turn/start")
          .map((message) => message.params.input?.[0]?.text?.match(/^message_id: (\S+)$/m)?.[1])
          .filter(Boolean),
      };
    },
  },
};

for (const [mode, { launch }] of Object.entries(MODES)) {
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
    await waitFor(() => root.delivered().length >= 2, () => "the fallback deliveries", 15000);
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

// The one place the real fallback threshold is asserted; every other test shortens it.
test("root's emergency fallback engages after about two minutes by default, overridable by environment", () => {
  const { fallbackThresholdMs } = createRequire(import.meta.url)("../../scripts/router/emergency.js");

  assert.equal(fallbackThresholdMs({}), 120000);
  assert.equal(fallbackThresholdMs({ CCDM_ROOT_FALLBACK_AFTER_MS: "1000" }), 1000);
});
