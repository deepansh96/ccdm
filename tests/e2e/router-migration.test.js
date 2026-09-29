import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { startFakeCodexServer } from "./support/bridge.js";
import { runScript } from "./support/runner.js";
import { OWNER_ID, createRouterWorkspace, routerEnv, runRouterCli, startRouter } from "./support/router.js";
import { readState, writeState } from "./support/state.js";
import { cleanup } from "./support/teardown.js";

test.afterEach(async () => {
  await cleanup();
});

// `demo` is a pool Claude project served by `bot2` from `discord2`; the
// Router is not serving it yet. `ensure-webhook` gives it `fake-webhook-1`.
function poolClaudeWorkspace() {
  const workspace = createRouterWorkspace({
    discord_user_id: OWNER_ID,
    guild_id: "guild-id",
    pool: [{ id: "bot2", app_id: "pool-app-id", token: "pool-bot-token", state_dir: "__STATE__", assigned_to: "demo" }],
    projects: {
      demo: { channel_id: "demo-channel", type: "claude", bot_id: "bot2", screen_name: "demo_claude",
        assignment_generation: "gen-1", session_id: null, pid: null },
    },
  });
  const poolStateDir = path.join(workspace.homeDir, ".claude", "channels", "discord2");
  updateRegistry(workspace, (registry) => {
    registry.pool[0].state_dir = poolStateDir;
    registry.projects.demo.path = workspace.tmpDir;
  });
  return { workspace, poolStateDir };
}

// `beta` is a pool Codex project served by `bot3`, backed by the fake app-server.
async function poolCodexWorkspace() {
  const workspace = createRouterWorkspace({
    discord_user_id: OWNER_ID,
    guild_id: "guild-id",
    root_bot_app_id: "root-app-id",
    pool: [{ id: "bot3", app_id: "beta-app-id", token: "beta-pool-token", state_dir: "__STATE__", assigned_to: "beta" }],
    projects: {
      beta: { channel_id: "beta-channel", type: "codex", bot_id: "bot3", screen_name: "beta_codex",
        assignment_generation: "gen-1", session_id: null, pid: null },
    },
  });
  fs.mkdirSync(path.join(workspace.homeDir, ".codex"), { recursive: true });
  const codex = await startFakeCodexServer(workspace, { channelId: "beta-channel" });
  updateRegistry(workspace, (registry) => {
    registry.pool[0].state_dir = path.join(workspace.homeDir, ".claude", "channels", "discord3");
    registry.projects.beta.path = workspace.tmpDir;
    registry.projects.beta.ws_port = codex.port;
  });
  return { workspace };
}

const registryFile = (workspace) => path.join(workspace.repoDir, "registry.json");
const readRegistry = (workspace) => JSON.parse(fs.readFileSync(registryFile(workspace), "utf8"));

function updateRegistry(workspace, update) {
  const registry = readRegistry(workspace);
  update(registry);
  fs.writeFileSync(registryFile(workspace), `${JSON.stringify(registry, null, 2)}\n`);
}

function migrate(workspace, args, extraEnv = {}) {
  return runScript(workspace, "scripts/migrate-to-router.sh", {
    args, env: routerEnv(workspace, { CCDM_ROUTER_NODE: process.execPath, CCDM_REMINDER_NODE: process.execPath, ...extraEnv }),
    timeoutMs: 60000,
  });
}

function startPoolClaude(workspace) {
  return runScript(workspace, "scripts/start-session.sh", { args: ["demo"], env: routerEnv(workspace) });
}

async function routerSessions(workspace) {
  const status = await runRouterCli(workspace, ["status", "--json"]);
  assert.equal(status.exitCode, 0, status.stderr);
  return JSON.parse(status.stdout).sessions.map(({ role, project, scope }) => ({ role, project, channel_id: scope.channel_id }));
}

const webhookMessages = (workspace) => (readState(workspace.stateDir).fixtures.discord.messages ?? [])
  .filter((message) => message.webhookId)
  .map(({ channelId, webhookId }) => ({ channelId, webhookId }));

test("migrating a pool Claude project moves it to the Router, verifies a probe round trip, and exits 0", async () => {
  const { workspace } = poolClaudeWorkspace();
  await startRouter(workspace);
  const pooled = await startPoolClaude(workspace);
  assert.equal(pooled.exitCode, 0, pooled.stderr || pooled.stdout);

  const result = await migrate(workspace, ["demo"]);

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  for (const step of ["preflight", "stop", "ensure-webhook", "transport", "assignment-changed", "start", "verify"]) {
    assert.match(result.stdout, new RegExp(`^${step}: ok`, "m"), result.stdout);
  }
  const demo = readRegistry(workspace).projects.demo;
  assert.deepEqual({ transport: demo.transport, webhook_id: demo.webhook_id, bot_id: demo.bot_id },
    { transport: "router", webhook_id: "fake-webhook-1", bot_id: "bot2" });
  assert.match(demo.assignment_generation, /^gen-[0-9a-f]{32}$/);
  assert.deepEqual(await routerSessions(workspace), [{ role: "project", project: "demo", channel_id: "demo-channel" }]);
  assert.deepEqual(webhookMessages(workspace), [{ channelId: "demo-channel", webhookId: "fake-webhook-1" }]);
  // The pool bot's Claude listener is gone; the router launch holds the tmux session.
  const session = readState(workspace.stateDir).fixtures.tmux.sessions.demo_claude;
  assert.equal(session.env?.DISCORD_STATE_DIR, undefined);
});

test("migrating a pool Codex project moves it to the Router, verifies a probe round trip, and exits 0", async () => {
  const { workspace } = await poolCodexWorkspace();
  await startRouter(workspace);
  const pooled = await runScript(workspace, "scripts/start-codex-session.sh", { args: ["beta"], env: routerEnv(workspace) });
  assert.equal(pooled.exitCode, 0, pooled.stderr || pooled.stdout);

  const result = await migrate(workspace, ["beta"]);

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /^verify: ok/m);
  const beta = readRegistry(workspace).projects.beta;
  assert.deepEqual({ transport: beta.transport, webhook_id: beta.webhook_id }, { transport: "router", webhook_id: "fake-webhook-1" });
  assert.match(beta.assignment_generation, /^gen-[0-9a-f]{32}$/);
  assert.deepEqual(await routerSessions(workspace), [{ role: "project", project: "beta", channel_id: "beta-channel" }]);
  assert.deepEqual(webhookMessages(workspace), [{ channelId: "beta-channel", webhookId: "fake-webhook-1" }]);
  // The router bridge holds no pool token.
  assert.equal(readState(workspace.stateDir).fixtures.tmux.sessions.beta_codex.env?.BOT_TOKEN, undefined);
});

test("a preflight failure with the Router down exits non-zero before stopping the pool session", async () => {
  const { workspace } = poolClaudeWorkspace();
  const pooled = await startPoolClaude(workspace);
  assert.equal(pooled.exitCode, 0, pooled.stderr || pooled.stdout);
  const before = readRegistry(workspace);

  const result = await migrate(workspace, ["demo"]);

  assert.notEqual(result.exitCode, 0);
  assert.match(result.stdout, /^preflight: failed — the Router is not reachable/m);
  assert.doesNotMatch(result.stdout, /^stop:/m);
  assert.match(result.stderr, /stopped at preflight: .*nothing changed/);
  assert.deepEqual(readRegistry(workspace), before);
  const session = readState(workspace.stateDir).fixtures.tmux.sessions.demo_claude;
  assert.equal(session.env.DISCORD_STATE_DIR, path.join(workspace.homeDir, ".claude", "channels", "discord2"));
});

test("a preflight failure names root's missing permissions in the project channel", async () => {
  const { workspace } = poolClaudeWorkspace();
  const denied = readState(workspace.stateDir);
  denied.fixtures.discord.permissionDenials = { "fixture-bot-user-id": ["ManageMessages"] };
  writeState(denied, workspace.stateDir);
  await startRouter(workspace);

  const result = await migrate(workspace, ["demo"]);

  assert.notEqual(result.exitCode, 0);
  assert.match(result.stdout, /^preflight: failed — root lacks ManageMessages in demo-channel$/m);
  assert.equal(readRegistry(workspace).projects.demo.transport, undefined);
});

test("a launcher failure after the stop rolls back to pool, restarts the pool session, and names the failed step", async () => {
  const { workspace, poolStateDir } = poolClaudeWorkspace();
  await startRouter(workspace);
  const pooled = await startPoolClaude(workspace);
  assert.equal(pooled.exitCode, 0, pooled.stderr || pooled.stdout);
  // The fixture Claude never confirms the development channel, so the router launch fails.
  const state = readState(workspace.stateDir);
  state.fixtures.tmux.devChannelPrompt = "never";
  writeState(state, workspace.stateDir);

  const result = await migrate(workspace, ["demo"], { CCDM_CLAUDE_LAUNCH_TIMEOUT_S: "1" });

  assert.notEqual(result.exitCode, 0);
  assert.match(result.stdout, /^start: failed — start-session.sh exited 1: Launch of 'demo' failed/m);
  assert.match(result.stdout, /^rolling back demo to its pool bot after the start step failed$/m);
  assert.match(result.stderr, /migration of demo failed at start/);
  const demo = readRegistry(workspace).projects.demo;
  assert.deepEqual({ transport: demo.transport, bot_id: demo.bot_id }, { transport: undefined, bot_id: "bot2" });
  assert.match(demo.assignment_generation, /^gen-[0-9a-f]{32}$/);
  assert.equal(typeof demo.pid, "number");
  const session = readState(workspace.stateDir).fixtures.tmux.sessions.demo_claude;
  assert.equal(session.env.DISCORD_STATE_DIR, poolStateDir);
  assert.deepEqual(await routerSessions(workspace), []);
});

test("--rollback returns a migrated project to its pool bot, which serves it again", async () => {
  const { workspace, poolStateDir } = poolClaudeWorkspace();
  await startRouter(workspace);
  const migrated = await migrate(workspace, ["demo"]);
  assert.equal(migrated.exitCode, 0, migrated.stderr || migrated.stdout);
  const forward = readRegistry(workspace).projects.demo.assignment_generation;

  const result = await migrate(workspace, ["--rollback", "demo"]);

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  for (const step of ["preflight", "stop", "transport", "assignment-changed", "start"]) {
    assert.match(result.stdout, new RegExp(`^${step}: ok`, "m"), result.stdout);
  }
  const demo = readRegistry(workspace).projects.demo;
  assert.deepEqual({ transport: demo.transport, bot_id: demo.bot_id }, { transport: undefined, bot_id: "bot2" });
  assert.match(demo.assignment_generation, /^gen-[0-9a-f]{32}$/);
  assert.notEqual(demo.assignment_generation, forward);
  const session = readState(workspace.stateDir).fixtures.tmux.sessions.demo_claude;
  assert.equal(session.env.DISCORD_STATE_DIR, poolStateDir);
  assert.equal(fs.existsSync(path.join(workspace.routerStateDir, "keys", "demo.key")), false);
  assert.deepEqual(await routerSessions(workspace), []);
});

test("probe fails clearly when Discord returns the message under another webhook_id", async () => {
  const { workspace } = poolClaudeWorkspace();
  const ensured = await runRouterCli(workspace, ["ensure-webhook", "demo"]);
  assert.equal(ensured.exitCode, 0, ensured.stderr || ensured.stdout);
  const state = readState(workspace.stateDir);
  state.fixtures.discord.webhookExecuteReturnsWebhookId = "someone-elses-webhook";
  writeState(state, workspace.stateDir);

  const result = await runRouterCli(workspace, ["probe", "demo"]);

  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr,
    /router probe failed: probe message fake-message-1 came back with webhook_id someone-elses-webhook, expected fake-webhook-1/);
});
