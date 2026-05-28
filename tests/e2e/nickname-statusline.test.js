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
    max_pool_size: 50,
    project_bot_role_id: null,
    category_ids: [],
    pool: [
      {
        id: "bot1",
        app_id: "root-app-id",
        token: "registry-root-token",
        state_dir: rootStateDir,
        assigned_to: null,
      },
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
        screen_name: "alpha_codex",
        channel_id: "channel-id",
        type: "codex",
        ws_port: 18342,
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

async function waitForNicknamePatch(workspace) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const patches = readState(workspace.stateDir).fixtures.discord.nicknamePatches;
    if (patches.length > 0) {
      return patches[0];
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail("timed out waiting for nickname PATCH fixture state");
}

function runFixture(workspace, tool, args, options = {}) {
  return spawnSync(path.join(workspace.fixtureDir, tool), args, {
    cwd: options.cwd ?? workspace.repoDir,
    encoding: "utf8",
    env: { ...workspace.env, ...(options.env ?? {}) },
    input: options.input,
  });
}

test("statusline wrapper updates the project nickname and returns deterministic statusline output", async () => {
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

  const patch = await waitForNicknamePatch(workspace);
  assert.equal(patch.method, "PATCH");
  assert.equal(patch.url, "https://discord.com/api/v10/guilds/guild-id/members/bot-app-id");
  assert.equal(patch.headers.Authorization, "Bot root-token");
  assert.deepEqual(JSON.parse(patch.body), { nick: "bot2-alpha-codex · 42%" });

  const state = readState(workspace.stateDir);
  assert.deepEqual(state.fixtures.npx.invocations[0].args, ["-y", "ccstatusline@latest"]);
  assert.deepEqual(state.fixtures.network.blocked, []);
});

test("nickname wrapper skips disabled, missing state, and missing context percentage inputs", async () => {
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

  const missingContext = await runScript(workspace, "scripts/cc-discord-nicknames.sh", {
    env: {
      DISCORD_STATE_DIR: projectStateDir,
    },
    input: `${JSON.stringify({ other: true })}\n`,
  });
  assert.equal(missingContext.exitCode, 0, missingContext.stderr || missingContext.stdout);

  await new Promise((resolve) => setTimeout(resolve, 300));
  const state = readState(workspace.stateDir);
  assert.deepEqual(state.fixtures.discord.nicknamePatches, []);
  assert.deepEqual(state.fixtures.curl.requests, []);
});

test("nickname wrapper uses root @me PATCH for state dirs without a registry app id and tolerates curl failure", async () => {
  const workspace = createWorkspace();
  const { rootSessionStateDir } = seedNicknameRegistry(workspace);
  seedDiscordPatchRoute(workspace, "@me", 55);

  const result = await runScript(workspace, "scripts/cc-discord-nicknames.sh", {
    env: {
      CONTEXT_DISCORD_INTERVAL: "0",
      DISCORD_STATE_DIR: rootSessionStateDir,
    },
    input: `${JSON.stringify({ context_window: { used_percentage: 55 } })}\n`,
  });

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /"used_percentage":55/);

  const patch = await waitForNicknamePatch(workspace);
  assert.equal(patch.url, "https://discord.com/api/v10/guilds/guild-id/members/@me");
  assert.equal(patch.headers.Authorization, "Bot session-root-token");
  assert.deepEqual(JSON.parse(patch.body), { nick: "root · 55%" });
  assert.equal(patch.exitCode, 55);
});

test("nickname wrapper rate limits repeated sends with unique hardcoded tmp files", async () => {
  const workspace = createWorkspace();
  const { projectStateDir } = seedNicknameRegistry(workspace);
  seedDiscordPatchRoute(workspace);
  const contextFile = rememberContextFile(projectStateDir);

  const first = await runScript(workspace, "scripts/cc-discord-nicknames.sh", {
    env: {
      CONTEXT_DISCORD_INTERVAL: "60",
      DISCORD_STATE_DIR: projectStateDir,
    },
    input: `${JSON.stringify({ context_window: { used_percentage: 11 } })}\n`,
  });
  assert.equal(first.exitCode, 0, first.stderr || first.stdout);
  await waitForNicknamePatch(workspace);

  const second = await runScript(workspace, "scripts/cc-discord-nicknames.sh", {
    env: {
      CONTEXT_DISCORD_INTERVAL: "60",
      DISCORD_STATE_DIR: projectStateDir,
    },
    input: `${JSON.stringify({ context_window: { used_percentage: 12 } })}\n`,
  });
  assert.equal(second.exitCode, 0, second.stderr || second.stdout);
  await new Promise((resolve) => setTimeout(resolve, 300));

  const state = readState(workspace.stateDir);
  assert.equal(state.fixtures.discord.nicknamePatches.length, 1);
  assert.ok(fs.existsSync(contextFile), `${contextFile} should be written by the production script`);
  assert.equal(path.basename(contextFile).startsWith("cc-context-discord-project-"), true);
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
