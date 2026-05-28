import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { createWorkspace, runScript } from "./support/runner.js";
import { seedRegistry } from "./support/state.js";
import { cleanup } from "./support/teardown.js";

const promptInput = (...answers) => `${answers.join("\n")}\n`;

test.afterEach(async () => {
  await cleanup();
});

test("setup creates a first-run registry, state files, and executable scripts", async () => {
  const workspace = createWorkspace();

  const result = await runScript(workspace, "setup.sh", {
    input: promptInput("123456789", "987654321", "fixture-root-token"),
  });

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Created registry\.json/);
  assert.match(result.stdout, /Setup complete/);

  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(workspace.repoDir, "registry.json"), "utf8")), {
    discord_user_id: "123456789",
    guild_id: "987654321",
    max_pool_size: 50,
    project_bot_role_id: null,
    category_ids: [],
    pool: [],
    projects: {},
  });

  const stateDir = path.join(workspace.homeDir, ".claude", "channels", "discord");
  assert.equal(fs.readFileSync(path.join(stateDir, ".env"), "utf8"), "DISCORD_BOT_TOKEN=fixture-root-token\n");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(stateDir, "access.json"), "utf8")), {
    dmPolicy: "allowlist",
    allowFrom: ["123456789"],
    groups: {},
    pending: {},
  });

  assert.ok(fs.statSync(path.join(workspace.repoDir, "restart-root-agent.sh")).mode & 0o111);
  assert.ok(fs.statSync(path.join(workspace.repoDir, "scripts", "claude-usage.sh")).mode & 0o111);
});

test("setup reports missing required fixture tools before prompting", async () => {
  const workspace = createWorkspace({ excludeFixtures: ["tmux"] });

  const result = await runScript(workspace, "setup.sh");

  assert.equal(result.exitCode, 1);
  assert.match(result.stdout, /Missing required tools:/);
  assert.match(result.stdout, /tmux/);
  assert.ok(!fs.existsSync(path.join(workspace.repoDir, "registry.json")));
});

test("setup keeps an existing registry when overwrite is declined", async () => {
  const workspace = createWorkspace();
  const existingRegistry = {
    discord_user_id: "existing-user",
    guild_id: "existing-guild",
    max_pool_size: 7,
    project_bot_role_id: null,
    category_ids: [],
    pool: [],
    projects: {},
  };
  seedRegistry(workspace, existingRegistry);

  const result = await runScript(workspace, "setup.sh", {
    input: promptInput("new-user", "new-guild", "n", "fixture-root-token"),
  });

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Keeping existing registry\.json/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(workspace.repoDir, "registry.json"), "utf8")), existingRegistry);
});

test("setup overwrites an existing registry when requested", async () => {
  const workspace = createWorkspace();
  seedRegistry(workspace, {
    discord_user_id: "old-user",
    guild_id: "old-guild",
    max_pool_size: 7,
    project_bot_role_id: "old-role",
    category_ids: ["old-category"],
    pool: [{ id: "bot2" }],
    projects: { old: {} },
  });

  const result = await runScript(workspace, "setup.sh", {
    input: promptInput("new-user", "new-guild", "y", "fixture-root-token"),
  });

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(workspace.repoDir, "registry.json"), "utf8")), {
    discord_user_id: "new-user",
    guild_id: "new-guild",
    max_pool_size: 50,
    project_bot_role_id: null,
    category_ids: [],
    pool: [],
    projects: {},
  });
});

test("setup uses the next state directory when the default env is kept", async () => {
  const workspace = createWorkspace();
  const defaultStateDir = path.join(workspace.homeDir, ".claude", "channels", "discord");
  fs.mkdirSync(defaultStateDir, { recursive: true });
  fs.writeFileSync(path.join(defaultStateDir, ".env"), "DISCORD_BOT_TOKEN=existing\n");

  const result = await runScript(workspace, "setup.sh", {
    input: promptInput("user-id", "guild-id", "fixture-root-token", "n"),
  });

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.equal(fs.readFileSync(path.join(defaultStateDir, ".env"), "utf8"), "DISCORD_BOT_TOKEN=existing\n");
  assert.equal(
    fs.readFileSync(path.join(workspace.homeDir, ".claude", "channels", "discord2", ".env"), "utf8"),
    "DISCORD_BOT_TOKEN=fixture-root-token\n",
  );
});

test("setup overwrites the default state directory when requested", async () => {
  const workspace = createWorkspace();
  const defaultStateDir = path.join(workspace.homeDir, ".claude", "channels", "discord");
  fs.mkdirSync(defaultStateDir, { recursive: true });
  fs.writeFileSync(path.join(defaultStateDir, ".env"), "DISCORD_BOT_TOKEN=existing\n");

  const result = await runScript(workspace, "setup.sh", {
    input: promptInput("user-id", "guild-id", "fixture-root-token", "y"),
  });

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.equal(fs.readFileSync(path.join(defaultStateDir, ".env"), "utf8"), "DISCORD_BOT_TOKEN=fixture-root-token\n");
  assert.ok(!fs.existsSync(path.join(workspace.homeDir, ".claude", "channels", "discord2")));
});

test("setup validates required prompts", async () => {
  const missingDiscord = createWorkspace();
  const discordResult = await runScript(missingDiscord, "setup.sh", {
    input: promptInput(""),
  });
  assert.equal(discordResult.exitCode, 1);
  assert.match(discordResult.stdout, /Error: Discord user ID is required/);

  const missingGuild = createWorkspace();
  const guildResult = await runScript(missingGuild, "setup.sh", {
    input: promptInput("user-id", ""),
  });
  assert.equal(guildResult.exitCode, 1);
  assert.match(guildResult.stdout, /Error: Discord server ID is required/);

  const missingToken = createWorkspace();
  const tokenResult = await runScript(missingToken, "setup.sh", {
    input: promptInput("user-id", "guild-id", ""),
  });
  assert.equal(tokenResult.exitCode, 1);
  assert.match(tokenResult.stdout, /Error: Bot token is required/);
});

test("setup reruns without corrupting existing state", async () => {
  const workspace = createWorkspace();

  const first = await runScript(workspace, "setup.sh", {
    input: promptInput("user-id", "guild-id", "first-token"),
  });
  assert.equal(first.exitCode, 0, first.stderr || first.stdout);

  const second = await runScript(workspace, "setup.sh", {
    input: promptInput("user-id", "guild-id", "n", "second-token", "n"),
  });
  assert.equal(second.exitCode, 0, second.stderr || second.stdout);
  assert.equal(
    fs.readFileSync(path.join(workspace.homeDir, ".claude", "channels", "discord", ".env"), "utf8"),
    "DISCORD_BOT_TOKEN=first-token\n",
  );
  assert.equal(
    fs.readFileSync(path.join(workspace.homeDir, ".claude", "channels", "discord2", ".env"), "utf8"),
    "DISCORD_BOT_TOKEN=second-token\n",
  );
});
