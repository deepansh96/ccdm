import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { createWorkspace, runScript } from "./support/runner.js";
import { readState, seedRegistry } from "./support/state.js";
import { cleanup } from "./support/teardown.js";

test.afterEach(cleanup);

function setupFixture(options = {}) {
  const workspace = createWorkspace();
  const home = path.join(workspace.homeDir, options.homeName ?? ".codex-deepseek");
  const catalog = path.join(workspace.tmpDir, "catalog.json");
  fs.writeFileSync(catalog, JSON.stringify({ models: [{
    slug: "deepseek-flash", use_responses_lite: false, supports_reasoning_summaries: true,
    tool_mode: null, shell_type: "shell_command", apply_patch_tool_type: "freeform",
    input_modalities: ["text", "image"], supported_reasoning_levels: [{ effort: "high" }],
  }] }));
  return { workspace, home, catalog };
}

function setup(fixture, { key = "sk-fixture-testing-only", args = [] } = {}) {
  return runScript(fixture.workspace, "scripts/setup-codex-deepseek.py", {
    args: ["--home", fixture.home, "--catalog-file", fixture.catalog, ...args],
    input: key + "\n",
  });
}

test("DeepSeek setup creates private standalone provider state and launches through a named account", async () => {
  const fixture = setupFixture();
  const { workspace, home } = fixture;
  const result = await setup(fixture);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.doesNotMatch(result.stdout + result.stderr, /sk-fixture-testing-only/);
  assert.equal(fs.statSync(home).mode & 0o777, 0o700);
  for (const file of ["api-key", "config.toml", "model-catalogs.json", "ccdm-deepseek.json"]) {
    assert.equal(fs.statSync(path.join(home, file)).mode & 0o777, 0o600);
  }
  const configPath = path.join(home, "config.toml");
  const config = fs.readFileSync(configPath, "utf8");
  assert.match(config, /https:\/\/api.deepseek.com\//);
  assert.match(config, /\[model_providers.deepseek.auth\]/);
  assert.doesNotMatch(config, /sk-fixture|experimental_bearer_token|env_key|model_supports_reasoning_summaries/);
  assert.equal(fs.existsSync(path.join(workspace.repoDir, "registry.json")), false);

  const project = path.join(workspace.tmpDir, "project");
  fs.mkdirSync(project);
  seedRegistry(workspace, {
    root_bot_app_id: "root-app-id", discord_user_id: "user-id", guild_id: "guild-id",
    codex_accounts: { deepseek: home },
    pool: [{ id: "bot2", app_id: "bot-app-id", token: "fixture-token",
      state_dir: path.join(workspace.homeDir, "bot-state"), assigned_to: "alpha" }],
    projects: { alpha: { path: project, bot_id: "bot2", screen_name: "alpha_deepseek",
      channel_id: "channel-id", type: "codex", ws_port: 18342, codex_account: "deepseek" } },
  });
  fs.appendFileSync(configPath, '\n[mcp_servers.discord-old]\ncommand = "old"\n');
  const launch = await runScript(workspace, "scripts/start-codex-session.sh", { args: ["alpha"] });
  assert.equal(launch.exitCode, 0, launch.stderr || launch.stdout);
  const session = readState(workspace.stateDir).fixtures.tmux.sessions.alpha_deepseek;
  assert.equal(session.env.CODEX_HOME, home);
  assert.equal(session.env.DEEPSEEK_API_KEY, undefined);
  assert.doesNotMatch(session.shellCommand, /sk-fixture-testing-only/);
  const cleaned = fs.readFileSync(configPath, "utf8");
  assert.match(cleaned, /\[model_providers.deepseek.auth\]/);
  assert.doesNotMatch(cleaned, /discord-old/);
  assert.equal(fs.readFileSync(path.join(home, "api-key"), "utf8"), "sk-fixture-testing-only\n");
});

test("DeepSeek setup accepts environment credentials and quoted Unicode paths", async () => {
  const fixture = setupFixture({ homeName: 'deepseek "quoted" 🚀' });
  const result = await runScript(fixture.workspace, "scripts/setup-codex-deepseek.py", {
    args: ["--home", fixture.home, "--catalog-file", fixture.catalog],
    env: { DEEPSEEK_API_KEY: "sk-environment-testing-only" },
    input: "sk-ignored-stdin-key\n",
  });
  assert.equal(result.exitCode, 0, result.stderr);
  const config = fs.readFileSync(path.join(fixture.home, "config.toml"), "utf8");
  assert.ok(config.includes(JSON.stringify(path.join(fixture.home, "api-key"))));
  assert.equal(fs.readFileSync(path.join(fixture.home, "api-key"), "utf8"), "sk-environment-testing-only\n");
  assert.doesNotMatch(result.stdout + result.stderr + config, /sk-environment-testing-only/);
});

test("DeepSeek setup extracts vendor JSON as data without executing shell commands", async () => {
  const fixture = setupFixture();
  const payload = fs.readFileSync(fixture.catalog, "utf8");
  const marker = path.join(fixture.workspace.tmpDir, "must-not-exist");
  fs.writeFileSync(fixture.catalog, `#!/bin/sh\ntouch "${marker}"\ncat > "$1" <<'CODEX_MODELS_JSON'\n${payload}\nCODEX_MODELS_JSON\nexit 99\n`);
  const result = await setup(fixture);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(fs.existsSync(marker), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(fixture.home, "model-catalogs.json"))).models[0].slug, "deepseek-flash");
});

test("DeepSeek setup rejects invalid credentials/catalogs before creating state", async () => {
  for (const invalid of ["wrong-key", "tp-wrong-billing", "sk-line\nbreak"]) {
    const fixture = setupFixture();
    const result = await setup(fixture, { key: invalid });
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /A valid DeepSeek API key is required/);
    assert.equal(fs.existsSync(fixture.home), false);
    assert.doesNotMatch(result.stderr, new RegExp(invalid.replace(/\n/g, "\\n")));
  }
  for (const catalog of ["not json", '{"models":[]}', '{"models":[{"slug":"deepseek-flash"}]}']) {
    const fixture = setupFixture();
    fs.writeFileSync(fixture.catalog, catalog);
    const result = await setup(fixture);
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /DeepSeek setup failed:/);
    assert.equal(fs.existsSync(fixture.home), false);
  }
});

test("DeepSeek setup rejects incompatible or malformed model capabilities", async () => {
  for (const mutation of [
    { use_responses_lite: true }, { tool_mode: "code_mode_only" },
    { input_modalities: null }, { input_modalities: ["text"] },
    { supported_reasoning_levels: null }, { shell_type: "unified_exec" },
  ]) {
    const fixture = setupFixture();
    const catalog = JSON.parse(fs.readFileSync(fixture.catalog, "utf8"));
    Object.assign(catalog.models[0], mutation);
    fs.writeFileSync(fixture.catalog, JSON.stringify(catalog));
    const result = await setup(fixture);
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /DeepSeek setup failed:/);
    assert.doesNotMatch(result.stderr, /Traceback/);
    assert.equal(fs.existsSync(fixture.home), false);
  }
});

test("DeepSeek setup refuses existing homes, checkout paths, and symlinks", async () => {
  const fixture = setupFixture();
  fs.mkdirSync(fixture.home);
  const sentinel = path.join(fixture.home, "config.toml");
  fs.writeFileSync(sentinel, "existing configuration\n");
  assert.equal((await setup(fixture)).exitCode, 1);
  assert.equal(fs.readFileSync(sentinel, "utf8"), "existing configuration\n");
  const link = path.join(fixture.workspace.homeDir, "linked-home");
  fs.symlinkSync(fixture.home, link);
  assert.equal((await setup({ ...fixture, home: link })).exitCode, 1);
  const trackedHome = path.join(fixture.workspace.repoDir, ".codex-deepseek");
  assert.equal((await setup({ ...fixture, home: trackedHome })).exitCode, 1);
  assert.equal(fs.existsSync(trackedHome), false);
});

test("DeepSeek rotation replaces only credentials after bridge config changes and rejects a foreign home marker", async () => {
  const fixture = setupFixture();
  assert.equal((await setup(fixture)).exitCode, 0);
  const configPath = path.join(fixture.home, "config.toml");
  fs.appendFileSync(configPath, '\n[mcp_servers.local_test]\ncommand = "test"\n');
  const config = fs.readFileSync(configPath, "utf8");
  const catalog = fs.readFileSync(path.join(fixture.home, "model-catalogs.json"), "utf8");
  const result = await setup(fixture, { key: "sk-replacement-testing-only", args: ["--rotate-key"] });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.doesNotMatch(result.stdout + result.stderr, /sk-replacement/);
  const keyPath = path.join(fixture.home, "api-key");
  assert.equal(fs.readFileSync(keyPath, "utf8"), "sk-replacement-testing-only\n");
  assert.equal(fs.statSync(keyPath).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(configPath, "utf8"), config);
  assert.equal(fs.readFileSync(path.join(fixture.home, "model-catalogs.json"), "utf8"), catalog);
  fs.writeFileSync(path.join(fixture.home, "ccdm-deepseek.json"), '{"version":1,"provider":"other"}');
  const mismatch = await setup(fixture, { args: ["--rotate-key"] });
  assert.equal(mismatch.exitCode, 1);
  assert.equal(fs.readFileSync(keyPath, "utf8"), "sk-replacement-testing-only\n");
});
