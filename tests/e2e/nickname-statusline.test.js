import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { createWorkspace, runScript } from "./support/runner.js";
import { readState, seedRegistry, writeState } from "./support/state.js";
import { cleanup } from "./support/teardown.js";

const contextTempFiles = new Set();
let scenarioCounter = 0;

test.afterEach(async () => {
  await cleanup();
  for (const file of contextTempFiles) {
    fs.rmSync(file, { force: true });
  }
  contextTempFiles.clear();
});

function uniqueStateName(prefix) {
  scenarioCounter += 1;
  return `${prefix}-${process.pid}-${scenarioCounter}`;
}

function rememberContextFile(stateDir) {
  const file = path.join("/tmp", `cc-context-${path.basename(stateDir)}`);
  contextTempFiles.add(file);
  fs.rmSync(file, { force: true });
  return file;
}

// Pool-era state directories still hold bot tokens on disk, and a stale
// registry still names pool bots; the nickname tools must PATCH no member
// for any of them.
function seedNicknameRegistry(workspace, options = {}) {
  const projectStateName = options.projectStateName ?? uniqueStateName("discord-project");
  const rootSessionStateName = options.rootSessionStateName ?? uniqueStateName("discord-root-session");
  const projectStateDir = path.join(workspace.homeDir, ".claude", "channels", projectStateName);
  const rootSessionStateDir = path.join(workspace.homeDir, ".claude", "channels", rootSessionStateName);
  const rootStateDir = path.join(workspace.homeDir, ".claude", "channels", "discord");
  fs.mkdirSync(projectStateDir, { recursive: true });
  fs.mkdirSync(rootSessionStateDir, { recursive: true });
  fs.mkdirSync(rootStateDir, { recursive: true });
  fs.writeFileSync(path.join(projectStateDir, ".env"), "DISCORD_BOT_TOKEN=project-token\n");
  fs.writeFileSync(path.join(rootSessionStateDir, ".env"), "DISCORD_BOT_TOKEN=session-root-token\n");
  fs.writeFileSync(path.join(rootStateDir, ".env"), "DISCORD_BOT_TOKEN=root-token\n");
  rememberContextFile(projectStateDir);
  rememberContextFile(rootSessionStateDir);

  seedRegistry(workspace, {
    discord_user_id: "allowed-user-id",
    guild_id: "guild-id",
    category_ids: [],
    pool: [
      {
        id: "bot2",
        app_id: "bot-app-id",
        token: "project-token",
        state_dir: projectStateDir,
        assigned_to: "alpha",
      },
    ],
    projects: {
      alpha: {
        path: path.join(workspace.tmpDir, "alpha"),
        bot_id: "bot2",
        screen_name: "alpha_session",
        channel_id: "channel-id",
        type: "claude",
        session_id: null,
        pid: null,
      },
    },
  });
  return { projectStateDir, rootSessionStateDir, rootStateDir };
}

function seedDiscordPatchRoute(workspace, member = "bot-app-id", exitCode = 0) {
  const state = readState(workspace.stateDir);
  state.fixtures.curl.routes.push({
    method: "PATCH",
    hostname: "discord.com",
    path: `/api/v10/guilds/guild-id/members/${member}`,
    exitCode,
    body: "{}",
  });
  writeState(state, workspace.stateDir);
}

// A background PATCH would land well within this window.
async function assertNoNicknamePatch(workspace) {
  await new Promise((resolve) => setTimeout(resolve, 500));
  const state = readState(workspace.stateDir);
  assert.deepEqual(state.fixtures.discord.nicknamePatches, []);
  assert.deepEqual(state.fixtures.curl.requests, []);
}

function runFixture(workspace, tool, args, options = {}) {
  return spawnSync(path.join(workspace.fixtureDir, tool), args, {
    cwd: options.cwd ?? workspace.repoDir,
    encoding: "utf8",
    env: { ...workspace.env, ...(options.env ?? {}) },
    input: options.input,
  });
}

test("statusline wrapper makes no nickname PATCH for a project state dir and returns deterministic statusline output", async () => {
  const workspace = createWorkspace();
  const { projectStateDir } = seedNicknameRegistry(workspace);
  seedDiscordPatchRoute(workspace);

  const result = await runScript(workspace, "scripts/cc-statusline-wrapper.sh", {
    env: {
      DISCORD_STATE_DIR: projectStateDir,
      CONTEXT_DISCORD_INTERVAL: "0",
    },
    input: `${JSON.stringify({ context_window: { used_percentage: 42 } })}\n`,
  });

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /ccstatusline fixture output/);
  await assertNoNicknamePatch(workspace);

  const state = readState(workspace.stateDir);
  assert.deepEqual(state.fixtures.npx.invocations[0].args, ["-y", "ccstatusline@latest"]);
  assert.deepEqual(state.fixtures.network.blocked, []);
});

test("nickname wrapper passes input through for disabled, missing state, and missing context percentage inputs", async () => {
  const workspace = createWorkspace();
  const { projectStateDir } = seedNicknameRegistry(workspace);
  seedDiscordPatchRoute(workspace);

  const disabled = await runScript(workspace, "scripts/cc-discord-nicknames.sh", {
    env: {
      DISABLE_DISCORD_MESSAGE: "true",
      DISCORD_STATE_DIR: projectStateDir,
    },
    input: `${JSON.stringify({ context_window: { used_percentage: 7 } })}\n`,
  });
  assert.equal(disabled.exitCode, 0, disabled.stderr || disabled.stdout);
  assert.match(disabled.stdout, /"used_percentage":7/);

  const missingState = await runScript(workspace, "scripts/cc-discord-nicknames.sh", {
    input: `${JSON.stringify({ context_window: { used_percentage: 8 } })}\n`,
  });
  assert.equal(missingState.exitCode, 0, missingState.stderr || missingState.stdout);
  assert.match(missingState.stdout, /"used_percentage":8/);

  const missingContext = await runScript(workspace, "scripts/cc-discord-nicknames.sh", {
    env: {
      DISCORD_STATE_DIR: projectStateDir,
    },
    input: `${JSON.stringify({ other: true })}\n`,
  });
  assert.equal(missingContext.exitCode, 0, missingContext.stderr || missingContext.stdout);
  assert.match(missingContext.stdout, /"other":true/);

  await assertNoNicknamePatch(workspace);
});

test("nickname wrapper makes no root @me PATCH for a root state dir", async () => {
  const workspace = createWorkspace();
  const { rootSessionStateDir } = seedNicknameRegistry(workspace);
  seedDiscordPatchRoute(workspace, "@me");

  const result = await runScript(workspace, "scripts/cc-discord-nicknames.sh", {
    env: {
      CONTEXT_DISCORD_INTERVAL: "0",
      DISCORD_STATE_DIR: rootSessionStateDir,
    },
    input: `${JSON.stringify({ context_window: { used_percentage: 55 } })}\n`,
  });

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /"used_percentage":55/);
  await assertNoNicknamePatch(workspace);
});

test("repeated nickname wrapper runs make no PATCH and leave no rate-limit tmp files", async () => {
  const workspace = createWorkspace();
  const { projectStateDir } = seedNicknameRegistry(workspace);
  seedDiscordPatchRoute(workspace);
  const contextFile = rememberContextFile(projectStateDir);

  for (const pct of [11, 12]) {
    const result = await runScript(workspace, "scripts/cc-discord-nicknames.sh", {
      env: {
        CONTEXT_DISCORD_INTERVAL: "60",
        DISCORD_STATE_DIR: projectStateDir,
      },
      input: `${JSON.stringify({ context_window: { used_percentage: pct } })}\n`,
    });
    assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  }

  await assertNoNicknamePatch(workspace);
  assert.equal(fs.existsSync(contextFile), false);
});

test("npx fixture returns ccstatusline output and blocks unapproved package execution", () => {
  const workspace = createWorkspace();

  const statusline = runFixture(workspace, "npx", ["-y", "ccstatusline@latest"], {
    input: `${JSON.stringify({ context_window: { used_percentage: 1 } })}\n`,
  });
  assert.equal(statusline.status, 0, statusline.stderr || statusline.stdout);
  assert.match(statusline.stdout, /ccstatusline fixture output/);

  const blocked = runFixture(workspace, "npx", ["-y", "left-pad@latest"]);
  assert.equal(blocked.status, 42);
  assert.match(blocked.stderr, /blocks unapproved package execution/);

  const state = readState(workspace.stateDir);
  assert.deepEqual(
    state.fixtures.npx.invocations.map((entry) => entry.args),
    [
      ["-y", "ccstatusline@latest"],
      ["-y", "left-pad@latest"],
    ],
  );
  assert.deepEqual(state.fixtures.network.blocked, []);
});

test("curl fixture parses Discord nickname PATCH requests into the unified fake Discord store", () => {
  const workspace = createWorkspace();
  seedDiscordPatchRoute(workspace, "bot-app-id");

  const result = runFixture(workspace, "curl", [
    "-s",
    "-X",
    "PATCH",
    "https://discord.com/api/v10/guilds/guild-id/members/bot-app-id",
    "-H",
    "Authorization: Bot root-token",
    "-H",
    "Content-Type: application/json",
    "-d",
    '{"nick":"bot2-alpha-codex · 64%"}',
  ]);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const patch = readState(workspace.stateDir).fixtures.discord.nicknamePatches[0];
  assert.equal(patch.method, "PATCH");
  assert.equal(patch.url, "https://discord.com/api/v10/guilds/guild-id/members/bot-app-id");
  assert.equal(patch.headers.Authorization, "Bot root-token");
  assert.deepEqual(JSON.parse(patch.body), { nick: "bot2-alpha-codex · 64%" });
});
