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
async function unmigratedCodexWorkspace(codexOptions = {}) {
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
  const codex = await startFakeCodexServer(workspace, { channelId: "beta-channel", ...codexOptions });
  updateRegistry(workspace, (registry) => {
    registry.projects.beta.path = workspace.tmpDir;
    registry.projects.beta.ws_port = codex.port;
  });
  return { workspace, codex };
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

// --resume: the saved conversation is found before the stop step clears the
// runtime fields, and a missing one falls back to a fresh start.
const CLAUDE_SESSION = "3f1c2b7a-9d4e-4c1a-8b2f-5e6d7c8a9b0c";
const LIVE_SESSION = "7a0e9c1d-2b3f-4e5a-9c8d-1f2e3d4c5b6a";
const CODEX_THREAD = "01a0f38d-b24b-7cf2-8c6a-3dafcb29d169";

function writeClaudeTranscript(workspace, id, claudeHome = path.join(workspace.homeDir, ".claude")) {
  const dir = path.join(claudeHome, "projects", workspace.tmpDir.replace(/[^A-Za-z0-9]/g, "-"));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), "{}\n");
}

function writeCodexRollout(workspace, id, { cwd = workspace.tmpDir, originator = "codex-discord-bridge", source = "vscode", mtime } = {}) {
  const dir = path.join(workspace.homeDir, ".codex", "sessions", "2026", "10", "01");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-2026-10-01T00-00-00-${id}.jsonl`);
  fs.writeFileSync(file, `${JSON.stringify({ type: "session_meta", payload: { id, cwd, originator, source } })}\n{}\n`);
  if (mtime) fs.utimesSync(file, mtime, mtime);
}

const claudeLaunches = (workspace) => readState(workspace.stateDir).fixtures.claude.invocations.map((invocation) => invocation.args.join(" "));
const threadRequests = (codex) => codex.clientMessages
  .filter((message) => message.method === "thread/resume" || message.method === "thread/start")
  .map((message) => [message.method, message.params.threadId]);

test("--resume resumes a Claude project's recorded session_id after the stop clears it", async () => {
  const { workspace } = poolClaudeWorkspace();
  updateRegistry(workspace, (registry) => { registry.projects.demo.session_id = CLAUDE_SESSION; });
  writeClaudeTranscript(workspace, CLAUDE_SESSION);
  await startRouter(workspace);

  const result = await migrate(workspace, ["--resume", "demo"]);

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.match(result.stdout, new RegExp(`^resume: ${CLAUDE_SESSION} \\(registry session_id\\)$`, "m"));
  assert.ok(result.stdout.indexOf("resume:") < result.stdout.indexOf("stop: ok"), result.stdout);
  assert.match(result.stdout, new RegExp(`^start: ok \\(resumed ${CLAUDE_SESSION}\\)$`, "m"));
  assert.match(result.stdout, /^verify: ok/m);
  const launches = claudeLaunches(workspace);
  assert.equal(launches.length, 1);
  assert.match(launches[0], new RegExp(`--resume '?${CLAUDE_SESSION}`));
  assert.equal(readRegistry(workspace).projects.demo.session_id, CLAUDE_SESSION);
});

test("--resume prefers the running Claude session's own id over a stale recorded one", async () => {
  const { workspace } = poolClaudeWorkspace();
  const running = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
  running.unref();
  registerTeardownCallback(() => { try { process.kill(running.pid, "SIGKILL"); } catch { /* gone */ } });
  const sessions = path.join(workspace.homeDir, ".claude", "sessions");
  fs.mkdirSync(sessions, { recursive: true });
  fs.writeFileSync(path.join(sessions, `${running.pid}.json`), JSON.stringify({ sessionId: LIVE_SESSION, cwd: workspace.tmpDir }));
  updateRegistry(workspace, (registry) => {
    registry.projects.demo.session_id = CLAUDE_SESSION;
    registry.projects.demo.pid = running.pid;
  });
  writeClaudeTranscript(workspace, CLAUDE_SESSION);
  writeClaudeTranscript(workspace, LIVE_SESSION);
  await startRouter(workspace);

  const result = await migrate(workspace, ["--resume", "demo"]);

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.match(result.stdout, new RegExp(`^resume: ${LIVE_SESSION} \\(live Claude session file\\)$`, "m"));
  assert.match(claudeLaunches(workspace)[0], new RegExp(`--resume '?${LIVE_SESSION}`));
});

for (const [name, setup, reason] of [
  ["no recorded session_id", () => {}, /^resume: skipped — no recorded Claude session_id$/m],
  ["a transcript missing from the project's claude_home", (workspace) => {
    updateRegistry(workspace, (registry) => {
      registry.projects.demo.session_id = CLAUDE_SESSION;
      registry.projects.demo.claude_home = "~/.claude-work";
    });
    // Only the default home has it; the project's own home is what counts.
    writeClaudeTranscript(workspace, CLAUDE_SESSION);
  }, new RegExp(`^resume: skipped — transcript for ${CLAUDE_SESSION} \\(registry session_id\\) is missing from .*\\.claude-work$`, "m")],
]) {
  test(`--resume with ${name} starts a Claude project fresh and still migrates`, async () => {
    const { workspace } = poolClaudeWorkspace();
    setup(workspace);
    await startRouter(workspace);

    const result = await migrate(workspace, ["--resume", "demo"]);

    assert.equal(result.exitCode, 0, result.stderr || result.stdout);
    assert.match(result.stdout, reason);
    assert.match(result.stdout, /^start: ok$/m);
    assert.match(result.stdout, /^verify: ok/m);
    const launches = claudeLaunches(workspace);
    assert.equal(launches.length, 1);
    assert.doesNotMatch(launches[0], /--resume/);
  });
}

test("without --resume a recorded Claude session is not resumed", async () => {
  const { workspace } = poolClaudeWorkspace();
  updateRegistry(workspace, (registry) => { registry.projects.demo.session_id = CLAUDE_SESSION; });
  writeClaudeTranscript(workspace, CLAUDE_SESSION);
  await startRouter(workspace);

  const result = await migrate(workspace, ["demo"]);

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.doesNotMatch(result.stdout, /^resume:/m);
  assert.doesNotMatch(claudeLaunches(workspace)[0], /--resume/);
});

test("a rollback after --resume resumes the same Claude session again", async () => {
  const { workspace } = poolClaudeWorkspace();
  updateRegistry(workspace, (registry) => { registry.projects.demo.session_id = CLAUDE_SESSION; });
  writeClaudeTranscript(workspace, CLAUDE_SESSION);
  await startRouter(workspace);
  updateState(workspace.stateDir, (state) => {
    state.fixtures.discord.webhookExecuteReturnsWebhookId = "someone-elses-webhook";
  });

  const result = await migrate(workspace, ["--resume", "demo"]);

  assert.notEqual(result.exitCode, 0);
  assert.match(result.stdout, /^rolling back demo to its previous registry state after the verify step failed$/m);
  assert.equal(result.stdout.match(new RegExp(`^start: ok \\(resumed ${CLAUDE_SESSION}\\)$`, "gm"))?.length, 2, result.stdout);
  const launches = claudeLaunches(workspace);
  assert.equal(launches.length, 2);
  for (const launch of launches) assert.match(launch, new RegExp(`--resume '?${CLAUDE_SESSION}`));
  assert.equal(readRegistry(workspace).projects.demo.session_id, CLAUDE_SESSION);
});

test("--resume resumes a Codex project's newest bridge rollout for its directory, since the registry records no thread id", async () => {
  const { workspace, codex } = await unmigratedCodexWorkspace();
  const older = new Date("2026-09-30T00:00:00Z");
  const newer = new Date("2026-10-01T00:00:00Z");
  writeCodexRollout(workspace, CODEX_THREAD, { mtime: older });
  // Newer, but not the bridge's own thread for this directory.
  writeCodexRollout(workspace, "01a0f39d-f0a0-7000-8000-000000000001", { source: { subagent: {} }, mtime: newer });
  writeCodexRollout(workspace, "01a0f39d-f0a0-7000-8000-000000000002", { originator: "codex_exec", source: "exec", mtime: newer });
  writeCodexRollout(workspace, "01a0f39d-f0a0-7000-8000-000000000003", { cwd: "/elsewhere", mtime: newer });
  await startRouter(workspace);

  const result = await migrate(workspace, ["--resume", "beta"]);

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.match(result.stdout, new RegExp(`^resume: ${CODEX_THREAD} \\(newest codex-discord-bridge rollout for the project directory in .*\\.codex\\)$`, "m"));
  assert.match(result.stdout, new RegExp(`^start: ok \\(resumed ${CODEX_THREAD}\\)$`, "m"));
  assert.match(result.stdout, /^verify: ok/m);
  assert.deepEqual(threadRequests(codex), [["thread/resume", CODEX_THREAD]]);
});

test("--resume with no Codex rollout starts the Codex project fresh and still migrates", async () => {
  const { workspace, codex } = await unmigratedCodexWorkspace();
  await startRouter(workspace);

  const result = await migrate(workspace, ["--resume", "beta"]);

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /^resume: skipped — no recorded Codex thread id, and no codex-discord-bridge rollout for the project directory in /m);
  assert.match(result.stdout, /^start: ok$/m);
  assert.deepEqual(threadRequests(codex), [["thread/start", undefined]]);
});

test("--resume skips a Codex rollout whose directory another Codex project shares, since it cannot say whose thread it is", async () => {
  const { workspace, codex } = await unmigratedCodexWorkspace();
  updateRegistry(workspace, (registry) => {
    registry.projects.gamma = { channel_id: "gamma-channel", type: "codex", screen_name: "gamma_codex", path: workspace.tmpDir };
  });
  writeCodexRollout(workspace, CODEX_THREAD);
  await startRouter(workspace);

  const result = await migrate(workspace, ["--resume", "beta"]);

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /^resume: skipped — no recorded Codex thread id, and Codex project\(s\) gamma share the project directory$/m);
  assert.deepEqual(threadRequests(codex), [["thread/start", undefined]]);
});

test("--resume falls back to a fresh start when the launcher cannot resume the Codex thread", async () => {
  const { workspace, codex } = await unmigratedCodexWorkspace({ resumeError: "no rollout found for thread" });
  writeCodexRollout(workspace, CODEX_THREAD);
  await startRouter(workspace);

  const result = await migrate(workspace, ["--resume", "beta"]);

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.match(result.stdout, new RegExp(`^resume: skipped — the launcher could not resume ${CODEX_THREAD}: start-codex-session\\.sh exited 1: .*; starting fresh$`, "m"));
  assert.match(result.stdout, /^start: ok \(fresh\)$/m);
  assert.match(result.stdout, /^verify: ok/m);
  assert.deepEqual(threadRequests(codex), [["thread/resume", CODEX_THREAD], ["thread/start", undefined]]);
});

test("migrate-to-router.sh rejects unknown flags and a --resume without a project", async () => {
  const { workspace } = poolClaudeWorkspace();
  for (const args of [["--resume"], ["--resume", "--rollback", "demo"], ["demo", "--resume"], ["--fork", "demo"]]) {
    const result = await migrate(workspace, args);
    assert.equal(result.exitCode, 2, `${args}: ${result.stdout}`);
    assert.match(result.stderr, /usage: migrate-to-router\.sh \[--resume\] <project> \| --rollback <project>/);
  }
});
