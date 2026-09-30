import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { startFakeCodexServer } from "./support/bridge.js";
import { runScript } from "./support/runner.js";
import { OWNER_ID, createRouterWorkspace, routerEnv, runRouterCli, startRouter } from "./support/router.js";
import { readState, seedFixtureProcess, seedTmuxSession, updateState, writeState } from "./support/state.js";
import { cleanup, registerTeardownCallback } from "./support/teardown.js";

test.afterEach(async () => {
  await cleanup();
});

// `demo` is an unmigrated Claude project: no `transport` field or webhook
// yet, and a stale entry for its former pool bot `bot2`. Claude has no pool
// mode, so its session is already a Router session. `ensure-webhook` gives it
// `fake-webhook-1`.
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

// `beta` is a Codex project with no `transport` field, no pool bot, and no
// webhook yet, backed by the fake app-server.
async function unmigratedCodexWorkspace() {
  const workspace = createRouterWorkspace({
    discord_user_id: OWNER_ID,
    guild_id: "guild-id",
    pool: [],
    projects: {
      beta: { channel_id: "beta-channel", type: "codex", screen_name: "beta_codex",
        assignment_generation: "gen-1", session_id: null, pid: null },
    },
  });
  fs.mkdirSync(path.join(workspace.homeDir, ".codex"), { recursive: true });
  const codex = await startFakeCodexServer(workspace, { channelId: "beta-channel" });
  updateRegistry(workspace, (registry) => {
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

function startClaude(workspace) {
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

// Refused before any runtime change: no key, tmux session, or PID.
function assertRefusedWithoutWebhook(workspace, result, project, screen) {
  assert.equal(result.exitCode, 1, result.stderr || result.stdout);
  assert.match(result.stderr, new RegExp(`Refusing to start '${project}': it has no webhook_id.*Run scripts/migrate-to-router\\.sh ${project}`));
  assert.equal(readState(workspace.stateDir).fixtures.tmux.sessions[screen], undefined);
  assert.equal(fs.existsSync(path.join(workspace.routerStateDir, "keys", `${project}.key`)), false);
  assert.equal(readRegistry(workspace).projects[project].pid, null);
}

// The official Discord plugin listener a pool-era launch left running with the
// pool bot's state directory.
function spawnLegacyPoolListener(workspace, poolStateDir) {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true, env: { CCDM_TEST_STATE: workspace.stateDir }, stdio: "ignore",
  });
  child.unref();
  registerTeardownCallback(() => {
    try { process.kill(child.pid, "SIGKILL"); } catch { /* already gone */ }
  });
  seedFixtureProcess({
    command: `claude --channels plugin:discord@claude-plugins-official --dangerously-skip-permissions DISCORD_STATE_DIR='${poolStateDir}'`,
    owned: true, ownerStateDir: workspace.stateDir, pid: child.pid, ppid: process.pid,
  }, { stateDir: workspace.stateDir });
  return child.pid;
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("migrating an unmigrated Claude project stops its legacy pool listener, records it on the Router, verifies a probe round trip, and exits 0", async () => {
  const { workspace, poolStateDir } = poolClaudeWorkspace();
  await startRouter(workspace);
  // Without a webhook the project cannot launch; its pool-era listener still runs.
  assertRefusedWithoutWebhook(workspace, await startClaude(workspace), "demo", "demo_claude");
  const legacyPid = spawnLegacyPoolListener(workspace, poolStateDir);

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
  // The router launch holds the tmux session.
  const session = readState(workspace.stateDir).fixtures.tmux.sessions.demo_claude;
  assert.equal(session.env?.DISCORD_STATE_DIR, undefined);
  assert.equal(isAlive(legacyPid), false);
});

test("migrating a Codex project with no transport field or webhook records it on the Router, verifies a probe round trip, and exits 0", async () => {
  const { workspace } = await unmigratedCodexWorkspace();
  assert.equal(readRegistry(workspace).projects.beta.transport, undefined);
  assert.equal(readRegistry(workspace).projects.beta.webhook_id, undefined);
  await startRouter(workspace);
  // Without a webhook the project cannot launch.
  const refused = await runScript(workspace, "scripts/start-codex-session.sh", { args: ["beta"], env: routerEnv(workspace) });
  assertRefusedWithoutWebhook(workspace, refused, "beta", "beta_codex");

  const result = await migrate(workspace, ["beta"]);

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /^verify: ok/m);
  const beta = readRegistry(workspace).projects.beta;
  assert.deepEqual({ transport: beta.transport, webhook_id: beta.webhook_id }, { transport: "router", webhook_id: "fake-webhook-1" });
  assert.match(beta.assignment_generation, /^gen-[0-9a-f]{32}$/);
  assert.deepEqual(await routerSessions(workspace), [{ role: "project", project: "beta", channel_id: "beta-channel" }]);
  assert.deepEqual(webhookMessages(workspace), [{ channelId: "beta-channel", webhookId: "fake-webhook-1" }]);
  // The bridge holds no bot token.
  assert.equal(readState(workspace.stateDir).fixtures.tmux.sessions.beta_codex.env?.BOT_TOKEN, undefined);
});

test("a preflight failure with the Router down exits non-zero before stopping the running session", async () => {
  const { workspace } = poolClaudeWorkspace();
  seedTmuxSession("demo_claude", { paneOutput: "running\n" }, { stateDir: workspace.stateDir });
  const before = readRegistry(workspace);

  const result = await migrate(workspace, ["demo"]);

  assert.notEqual(result.exitCode, 0);
  assert.match(result.stdout, /^preflight: failed — the Router is not reachable/m);
  assert.doesNotMatch(result.stdout, /^stop:/m);
  assert.match(result.stderr, /stopped at preflight: .*nothing changed/);
  assert.deepEqual(readRegistry(workspace), before);
  assert.equal(readState(workspace.stateDir).fixtures.tmux.sessions.demo_claude.paneOutput, "running\n");
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

test("a verify failure after the stop rolls back to the previous registry state, restarts the session, and names the failed step", async () => {
  const { workspace } = poolClaudeWorkspace();
  await startRouter(workspace);
  // The probe comes back under another webhook, so verification fails.
  const state = updateState(workspace.stateDir, (state) => {
    state.fixtures.discord.webhookExecuteReturnsWebhookId = "someone-elses-webhook";
  });

  const result = await migrate(workspace, ["demo"]);

  assert.notEqual(result.exitCode, 0);
  assert.match(result.stdout, /^verify: failed — .*someone-elses-webhook/m);
  assert.match(result.stdout, /^rolling back demo to its previous registry state after the verify step failed$/m);
  assert.match(result.stderr, /migration of demo failed at verify: .*; rolled back to its previous registry state/);
  const demo = readRegistry(workspace).projects.demo;
  assert.deepEqual({ transport: demo.transport, bot_id: demo.bot_id }, { transport: undefined, bot_id: "bot2" });
  assert.match(demo.assignment_generation, /^gen-[0-9a-f]{32}$/);
  assert.equal(typeof demo.pid, "number");
  const session = readState(workspace.stateDir).fixtures.tmux.sessions.demo_claude;
  assert.equal(session.env.DISCORD_STATE_DIR, undefined);
  assert.deepEqual(await routerSessions(workspace), [{ role: "project", project: "demo", channel_id: "demo-channel" }]);
});

test("--rollback refuses a migrated Claude project, which has no pool bot to return to", async () => {
  const { workspace } = poolClaudeWorkspace();
  await startRouter(workspace);
  const migrated = await migrate(workspace, ["demo"]);
  assert.equal(migrated.exitCode, 0, migrated.stderr || migrated.stdout);
  const before = readRegistry(workspace);

  const result = await migrate(workspace, ["--rollback", "demo"]);

  assert.notEqual(result.exitCode, 0);
  assert.match(result.stdout, /^preflight: failed — demo is a Claude project, and Claude has no pool bot to return to/m);
  assert.doesNotMatch(result.stdout, /^stop:/m);
  assert.deepEqual(readRegistry(workspace), before);
  assert.deepEqual(await routerSessions(workspace), [{ role: "project", project: "demo", channel_id: "demo-channel" }]);
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
