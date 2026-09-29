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

test("registry example exposes generic named Codex account fields", () => {
  const registryExample = JSON.parse(fs.readFileSync("registry.example.json", "utf8"));

  assert.deepEqual(registryExample.codex_accounts, {
    "example-account": "~/.codex-example",
  });
  assert.equal(registryExample.default_codex_account, "example-account");
  assert.equal("codex_home" in registryExample, false);
});

test("registry example shows the one-bot Router fields and no pool or bot tokens", () => {
  const source = fs.readFileSync("registry.example.json", "utf8");
  const registryExample = JSON.parse(source);

  assert.deepEqual(registryExample.root_channels, ["YOUR_ROOT_CHANNEL_ID"]);
  assert.deepEqual(registryExample.root_allowed_user_ids, []);
  const projects = Object.values(registryExample.projects);
  assert.ok(projects.length > 0, "the example shows at least one project");
  for (const project of projects) {
    assert.equal(typeof project.channel_id, "string");
    assert.equal(typeof project.webhook_id, "string");
  }
  for (const field of ["pool", "max_pool_size", "project_bot_role_id", "bot_id", "bot_display_name", "transport", "token"]) {
    assert.doesNotMatch(source, new RegExp(`"${field}"`), `registry.example.json must not contain "${field}"`);
  }
});

test("setup creates a first-run registry, state files, and executable scripts", async () => {
  const workspace = createWorkspace();

  const result = await runScript(workspace, "setup.sh", {
    input: promptInput("123456789", "987654321", "fixture-root-token"),
  });

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Created registry\.json/);
  assert.match(result.stdout, /Setup complete/);
  // The output guides one-bot setup: root channels in the registry, the Router
  // installed, then root started as a Router client.
  assert.match(result.stdout, /root_channels/);
  assert.match(result.stdout, /scripts\/install-router-service\.sh/);
  assert.match(result.stdout, /restart-root-agent\.sh/);
  assert.doesNotMatch(result.stdout, /plugin:discord|DISCORD_STATE_DIR=|pool/i);

  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(workspace.repoDir, "registry.json"), "utf8")), {
    discord_user_id: "123456789",
    guild_id: "987654321",
    root_channels: [],
    root_allowed_user_ids: [],
    codex_accounts: {},
    default_codex_account: null,
    category_ids: [],
    projects: {},
  });

  const stateDir = path.join(workspace.homeDir, ".claude", "channels", "discord");
  assert.equal(fs.readFileSync(path.join(stateDir, ".env"), "utf8"), "DISCORD_BOT_TOKEN=fixture-root-token\n");
  // Root's channels and users live in the registry; no plugin allowlist is written.
  assert.ok(!fs.existsSync(path.join(stateDir, "access.json")));

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
    root_channels: ["existing-root-channel"],
    root_allowed_user_ids: [],
    category_ids: [],
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
    root_channels: ["old-root-channel"],
    root_allowed_user_ids: ["old-helper"],
    category_ids: ["old-category"],
    projects: { old: {} },
  });

  const result = await runScript(workspace, "setup.sh", {
    input: promptInput("new-user", "new-guild", "y", "fixture-root-token"),
  });

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(workspace.repoDir, "registry.json"), "utf8")), {
    discord_user_id: "new-user",
    guild_id: "new-guild",
    root_channels: [],
    root_allowed_user_ids: [],
    codex_accounts: {},
    default_codex_account: null,
    category_ids: [],
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
