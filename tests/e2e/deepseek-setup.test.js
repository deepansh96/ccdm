import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { assertPrivate, platformGate, PYTHON } from "./support/platform.js";
import { createBridgeWorkspace, startFakeCodexServer } from "./support/bridge.js";
import { routerEnv, routerWithWebhooks, writeRootToken } from "./support/router.js";
import { runScript } from "./support/runner.js";
import { startFakeHost } from "./support/session-fixture.js";
import { readState, seedRegistry } from "./support/state.js";
import { cleanup } from "./support/teardown.js";

test.afterEach(cleanup);

const WIN = process.platform === "win32";
// On Windows the launcher needs a session host.
const sessionHostEnv = async workspace => WIN ? (await startFakeHost(workspace, { env: routerEnv(workspace) })).env : {};

function setupFixture(options = {}) {
  const workspace = createBridgeWorkspace();
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
  const result = await setup(fixture, { args: ["--with-exa"] });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.doesNotMatch(result.stdout + result.stderr, /sk-fixture-testing-only/);
  assertPrivate(home);
  for (const file of ["api-key", "config.toml", "model-catalogs.json", "ccdm-deepseek.json"]) {
    assertPrivate(path.join(home, file));
  }
  const configPath = path.join(home, "config.toml");
  const config = fs.readFileSync(configPath, "utf8");
  assert.match(config, /\[mcp_servers\.exa\]\nurl = "https:\/\/mcp\.exa\.ai\/mcp"/);
  assert.match(config, /https:\/\/api.deepseek.com\//);
  assert.match(config, /\[model_providers.deepseek.auth\]/);
  assert.doesNotMatch(config, /sk-fixture|experimental_bearer_token|env_key|model_supports_reasoning_summaries/);
  assert.equal(fs.existsSync(path.join(workspace.repoDir, "registry.json")), false);

  const project = path.join(workspace.tmpDir, "project");
  fs.mkdirSync(project);
  // Codex launches through the Router, which serves alpha with root's token.
  const codex = await startFakeCodexServer(workspace);
  seedRegistry(workspace, {
    discord_user_id: "user-id", guild_id: "guild-id",
    codex_accounts: { deepseek: home },
    projects: { alpha: { path: project, screen_name: "alpha_deepseek",
      channel_id: "channel-id", type: "codex", ws_port: codex.port, codex_account: "deepseek" } },
  });
  writeRootToken(workspace);
  await routerWithWebhooks(workspace, ["alpha"]);
  fs.appendFileSync(configPath, '\n[mcp_servers.discord-old]\ncommand = "old"\n');
  const launch = await runScript(workspace, "scripts/start-codex-session.sh", {
    args: ["alpha"], env: routerEnv(workspace, await sessionHostEnv(workspace)), timeoutMs: 30000,
  });
  assert.equal(launch.exitCode, 0, launch.stderr || launch.stdout);
  const session = readState(workspace.stateDir).fixtures.tmux.sessions.alpha_deepseek;
  assert.equal(session.env.CODEX_HOME, home);
  assert.equal(session.env.CCDM_ROUTER_KEY_FILE, path.join(workspace.routerStateDir, "keys", "alpha.key"));
  assert.equal(session.env.DEEPSEEK_API_KEY, undefined);
  // A session-host launch has no shell command; its environment is checked as well.
  assert.doesNotMatch(`${session.shellCommand ?? ""} ${JSON.stringify(session.env)}`, /sk-fixture-testing-only/);
  const cleaned = fs.readFileSync(configPath, "utf8");
  assert.match(cleaned, /\[model_providers.deepseek.auth\]/);
  assert.doesNotMatch(cleaned, /discord-old/);
  assert.match(cleaned, /\[mcp_servers\.exa\]/);
  assert.equal(fs.readFileSync(path.join(home, "api-key"), "utf8"), "sk-fixture-testing-only\n");
});

test("DeepSeek setup accepts environment credentials and quoted Unicode paths", async () => {
  const fixture = setupFixture({ homeName: "deepseek 'quoted' & 50% 🚀" });
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
  assertPrivate(keyPath);
  assert.equal(fs.readFileSync(configPath, "utf8"), config);
  assert.equal(fs.readFileSync(path.join(fixture.home, "model-catalogs.json"), "utf8"), catalog);
  fs.writeFileSync(path.join(fixture.home, "ccdm-deepseek.json"), '{"version":1,"provider":"other"}');
  const mismatch = await setup(fixture, { args: ["--rotate-key"] });
  assert.equal(mismatch.exitCode, 1);
  assert.equal(fs.readFileSync(keyPath, "utf8"), "sk-replacement-testing-only\n");
});

test("Exa is opt-in and cannot silently change configuration during key rotation", async () => {
  const fixture = setupFixture();
  assert.equal((await setup(fixture)).exitCode, 0);
  const configPath = path.join(fixture.home, "config.toml");
  const original = fs.readFileSync(configPath, "utf8");
  assert.doesNotMatch(original, /mcp_servers\.exa/);
  const result = await setup(fixture, { args: ["--rotate-key", "--with-exa"] });
  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /--with-exa is for new homes/);
  assert.equal(fs.readFileSync(configPath, "utf8"), original);
  assert.equal(fs.readFileSync(path.join(fixture.home, "api-key"), "utf8"), "sk-fixture-testing-only\n");
});

// A home name with a space, quotes, `&`, `%` and a character outside the code page.
const AWKWARD_HOME = "deepseek 'quoted' & 50% 🚀";
const NODE_PRINTS_FILE = "process.stdout.write(require('fs').readFileSync(process.argv[1],'utf8').trim())";

// config.toml in full. The POSIX text is what the helper wrote before it ran on
// Windows; on Windows only the auth command differs.
function expectedConfig(home, { exa = false } = {}) {
  const keyFile = JSON.stringify(path.join(home, "api-key"));
  return [
    "# Generated by CCDM setup-codex-deepseek.py. Credentials stay in api-key.",
    'model = "deepseek-flash"',
    'model_provider = "deepseek"',
    'model_reasoning_effort = "high"',
    'model_reasoning_summary = "none"',
    "model_context_window = 1048576",
    'web_search = "disabled"',
    `model_catalog_json = ${JSON.stringify(path.join(home, "model-catalogs.json"))}`,
    "",
    "[model_providers.deepseek]",
    'name = "DeepSeek"',
    'base_url = "https://api.deepseek.com/"',
    'wire_api = "responses"',
    "",
    "[model_providers.deepseek.auth]",
    ...(WIN
      ? ['command = "node"', `args = ["-e", ${JSON.stringify(NODE_PRINTS_FILE)}, ${keyFile}]`]
      : ['command = "/bin/cat"', `args = [${keyFile}]`]),
    ...(exa ? ["", "[mcp_servers.exa]", 'url = "https://mcp.exa.ai/mcp"'] : []),
    "",
  ].join("\n");
}

// The auth command as Codex reads it from config.toml.
function authCommand(home) {
  const block = fs.readFileSync(path.join(home, "config.toml"), "utf8").split("[model_providers.deepseek.auth]\n")[1];
  return {
    command: JSON.parse(/^command = (.*)$/m.exec(block)[1]),
    args: JSON.parse(/^args = (.*)$/m.exec(block)[1]),
  };
}

// As Codex starts it: no shell, and the program found on PATH.
function runAuthCommand({ command, args }) {
  return spawnSync(command, args, {
    encoding: "utf8",
    env: { PATH: path.dirname(process.execPath), ...(WIN ? { SystemRoot: process.env.SystemRoot } : {}) },
    shell: false,
    windowsHide: true,
  });
}

test("DeepSeek setup writes the config.toml it always wrote on POSIX, and the same with a Node auth command on Windows", async () => {
  for (const exa of [false, true]) {
    const fixture = setupFixture({ homeName: AWKWARD_HOME });
    const result = await setup(fixture, { args: exa ? ["--with-exa"] : [] });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(fs.readFileSync(path.join(fixture.home, "config.toml"), "utf8"), expectedConfig(fixture.home, { exa }));
    for (const file of ["api-key", "config.toml", "model-catalogs.json", "ccdm-deepseek.json"]) {
      assert.equal(fs.readFileSync(path.join(fixture.home, file)).includes("\r"), false, `${file} has a carriage return`);
    }
  }
});

test("the DeepSeek auth command prints the key when started without a shell, before and after a rotation", async () => {
  const fixture = setupFixture({ homeName: AWKWARD_HOME });
  assert.equal((await setup(fixture)).exitCode, 0);
  const auth = authCommand(fixture.home);
  assert.equal(auth.command, WIN ? "node" : "/bin/cat");
  assert.equal(auth.args.at(-1), path.join(fixture.home, "api-key"));
  assert.doesNotMatch(JSON.stringify(auth), /sk-fixture/);
  const first = runAuthCommand(auth);
  assert.equal(first.status, 0, first.stderr || String(first.error));
  assert.equal(first.stdout.trim(), "sk-fixture-testing-only");
  assert.equal(first.stderr, "");

  const rotated = await setup(fixture, { key: "sk-replacement-testing-only", args: ["--rotate-key"] });
  assert.equal(rotated.exitCode, 0, rotated.stderr);
  assert.deepEqual(authCommand(fixture.home), auth);
  assert.equal(runAuthCommand(auth).stdout.trim(), "sk-replacement-testing-only");
});

// Runs the helper with the privacy helper swapped for one that refuses.
const REFUSING_PRIVACY = `
import runpy, sys
sys.dont_write_bytecode = True
scripts, helper = sys.argv[1:3]
sys.path.insert(0, scripts)
from ccdmlib.platform import private_fs
def refuse(path):
    raise PermissionError("cannot make the home private: refused for this test")
private_fs.ensure_private_dir = refuse
sys.argv = sys.argv[2:]
runpy.run_path(helper, run_name="__main__")
`;

test("DeepSeek setup stops before it writes a key when the home cannot be made private", () => {
  const fixture = setupFixture();
  const scripts = path.join(fixture.workspace.repoDir, "scripts");
  const result = spawnSync(PYTHON, [
    "-c", REFUSING_PRIVACY, scripts, path.join(scripts, "setup-codex-deepseek.py"),
    "--home", fixture.home, "--catalog-file", fixture.catalog,
  ], { encoding: "utf8", env: fixture.workspace.env, input: "sk-fixture-testing-only\n", windowsHide: true });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /DeepSeek setup failed: cannot make the home private/);
  assert.doesNotMatch(result.stdout + result.stderr, /sk-fixture/);
  // Nothing is left behind, so the same command can be run again.
  assert.equal(fs.existsSync(fixture.home), false);
});

const onlyWindows = platformGate("win32", "POSIX rotation leaves the home's mode as the operator set it");

test("on Windows, DeepSeek rotation makes the home private again before it writes the key", onlyWindows, async () => {
  const fixture = setupFixture();
  assert.equal((await setup(fixture)).exitCode, 0);
  // Inheritance back on: the home takes its parent's entries again.
  const icacls = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "icacls.exe");
  assert.equal(spawnSync(icacls, [fixture.home, "/inheritance:e"], { windowsHide: true }).status, 0);
  assert.throws(() => assertPrivate(fixture.home));

  const result = await setup(fixture, { key: "sk-replacement-testing-only", args: ["--rotate-key"] });
  assert.equal(result.exitCode, 0, result.stderr);
  assertPrivate(fixture.home);
  assertPrivate(path.join(fixture.home, "api-key"));
  assert.equal(fs.readFileSync(path.join(fixture.home, "api-key"), "utf8"), "sk-replacement-testing-only\n");
  assert.deepEqual(fs.readdirSync(fixture.home).filter(name => name.startsWith(".api-key-")), []);
});
