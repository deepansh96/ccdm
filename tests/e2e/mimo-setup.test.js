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
  const home = path.join(workspace.homeDir, options.homeName ?? ".codex-mimo");
  const catalog = path.join(workspace.tmpDir, "catalog.json");
  fs.writeFileSync(catalog, JSON.stringify({ models: [{
    slug: "mimo-v2.6-pro", use_responses_lite: true, supports_reasoning_summaries: true,
  }] }));
  return { workspace, home, catalog };
}

function setup(fixture, { key = "sk-fixture-testing-only", args = [] } = {}) {
  return runScript(fixture.workspace, "scripts/setup-codex-mimo.py", {
    args: ["--home", fixture.home, "--catalog-file", fixture.catalog, ...args],
    input: key + "\n",
  });
}

test("MiMo setup creates private standalone provider state and launches through a named account", async () => {
  const fixture = setupFixture();
  const { workspace, home } = fixture;
  const result = await setup(fixture);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.doesNotMatch(result.stdout + result.stderr, /sk-fixture-testing-only/);
  assertPrivate(home);
  for (const file of ["api-key", "config.toml", "model-catalogs.json", "ccdm-mimo.json"]) {
    assertPrivate(path.join(home, file));
  }
  const configPath = path.join(home, "config.toml");
  const config = fs.readFileSync(configPath, "utf8");
  assert.match(config, /https:\/\/api.xiaomimimo.com\/v1/);
  assert.match(config, /\[model_providers.mimo.auth\]/);
  assert.doesNotMatch(config, /sk-fixture|experimental_bearer_token|env_key|model_supports_reasoning_summaries/);
  assert.equal(fs.existsSync(path.join(workspace.repoDir, "registry.json")), false);

  const project = path.join(workspace.tmpDir, "project");
  fs.mkdirSync(project);
  // Codex launches through the Router, which serves alpha with root's token.
  const codex = await startFakeCodexServer(workspace);
  seedRegistry(workspace, {
    discord_user_id: "user-id", guild_id: "guild-id",
    codex_accounts: { mimo: home },
    projects: { alpha: { path: project, screen_name: "alpha_mimo",
      channel_id: "channel-id", type: "codex", ws_port: codex.port, codex_account: "mimo" } },
  });
  writeRootToken(workspace);
  await routerWithWebhooks(workspace, ["alpha"]);
  fs.appendFileSync(configPath, '\n[mcp_servers.discord-old]\ncommand = "old"\n');
  const launch = await runScript(workspace, "scripts/start-codex-session.sh", {
    args: ["alpha"], env: routerEnv(workspace, await sessionHostEnv(workspace)), timeoutMs: 30000,
  });
  assert.equal(launch.exitCode, 0, launch.stderr || launch.stdout);
  const session = readState(workspace.stateDir).fixtures.tmux.sessions.alpha_mimo;
  assert.equal(session.env.CODEX_HOME, home);
  assert.equal(session.env.CCDM_ROUTER_KEY_FILE, path.join(workspace.routerStateDir, "keys", "alpha.key"));
  assert.equal(session.env.MIMO_API_KEY, undefined);
  // A session-host launch has no shell command; its environment is checked as well.
  assert.doesNotMatch(`${session.shellCommand ?? ""} ${JSON.stringify(session.env)}`, /sk-fixture-testing-only/);
  const cleaned = fs.readFileSync(configPath, "utf8");
  assert.match(cleaned, /\[model_providers.mimo.auth\]/);
  assert.doesNotMatch(cleaned, /discord-old/);
  assert.equal(fs.readFileSync(path.join(home, "api-key"), "utf8"), "sk-fixture-testing-only\n");
});

test("MiMo setup handles quoted paths and both Token Plan credential types", async () => {
  for (const prefix of ["tp", "ttp"]) {
    const fixture = setupFixture({ homeName: `mimo ${prefix} 'quoted' & 50% 🚀` });
    const result = await setup(fixture, { key: `${prefix}-fixture-testing-only`, args: ["--billing", "token-plan"] });
    assert.equal(result.exitCode, 0, result.stderr);
    const config = fs.readFileSync(path.join(fixture.home, "config.toml"), "utf8");
    assert.match(config, /https:\/\/token-plan-cn.xiaomimimo.com\/v1/);
    assert.ok(config.includes(JSON.stringify(path.join(fixture.home, "api-key"))));
    const parsed = await runScript(fixture.workspace, "scripts/setup-codex-mimo.py", {
      args: ["--home", fixture.home, "--billing", "token-plan", "--rotate-key"],
      input: `${prefix}-replacement-testing-only\n`,
    });
    assert.equal(parsed.exitCode, 0, parsed.stderr);
  }
});

test("MiMo setup rejects invalid credentials/catalogs before creating state", async () => {
  for (const invalid of ["wrong-key", "tp-wrong-billing", "sk-line\nbreak"]) {
    const fixture = setupFixture();
    const result = await setup(fixture, { key: invalid });
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /API key is missing or does not match/);
    assert.equal(fs.existsSync(fixture.home), false);
    assert.doesNotMatch(result.stderr, new RegExp(invalid.replace(/\n/g, "\\n")));
  }
  for (const catalog of ["not json", '{"models":[]}', '{"models":[{"slug":"mimo-v2.6-pro"}]}']) {
    const fixture = setupFixture();
    fs.writeFileSync(fixture.catalog, catalog);
    const result = await setup(fixture);
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /MiMo setup failed:/);
    assert.equal(fs.existsSync(fixture.home), false);
  }
});

test("MiMo setup refuses existing homes, checkout paths, and symlinks", async () => {
  const fixture = setupFixture();
  fs.mkdirSync(fixture.home);
  const sentinel = path.join(fixture.home, "config.toml");
  fs.writeFileSync(sentinel, "existing configuration\n");
  assert.equal((await setup(fixture)).exitCode, 1);
  assert.equal(fs.readFileSync(sentinel, "utf8"), "existing configuration\n");
  const link = path.join(fixture.workspace.homeDir, "linked-home");
  fs.symlinkSync(fixture.home, link);
  assert.equal((await setup({ ...fixture, home: link })).exitCode, 1);
  const trackedHome = path.join(fixture.workspace.repoDir, ".codex-mimo");
  assert.equal((await setup({ ...fixture, home: trackedHome })).exitCode, 1);
  assert.equal(fs.existsSync(trackedHome), false);
});

test("MiMo rotation replaces only credentials after bridge config changes and rejects billing mismatch", async () => {
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
  const mismatch = await setup(fixture, { key: "tp-fixture-testing-only", args: ["--rotate-key", "--billing", "token-plan"] });
  assert.equal(mismatch.exitCode, 1);
  assert.equal(fs.readFileSync(keyPath, "utf8"), "sk-replacement-testing-only\n");
});

// A home name with a space, quotes, `&`, `%` and a character outside the code page.
const AWKWARD_HOME = "mimo 'quoted' & 50% 🚀";
const NODE_PRINTS_FILE = "process.stdout.write(require('fs').readFileSync(process.argv[1],'utf8').trim())";

// config.toml in full. The POSIX text is what the helper wrote before it ran on
// Windows; on Windows only the auth command differs.
function expectedConfig(home, baseUrl) {
  const keyFile = JSON.stringify(path.join(home, "api-key"));
  return [
    "# Generated by CCDM setup-codex-mimo.py. Credentials stay in api-key.",
    'model = "mimo-v2.6-pro"',
    'model_provider = "mimo"',
    'model_reasoning_effort = "high"',
    'model_reasoning_summary = "none"',
    "model_context_window = 1048576",
    'web_search = "disabled"',
    `model_catalog_json = ${JSON.stringify(path.join(home, "model-catalogs.json"))}`,
    "",
    "[model_providers.mimo]",
    'name = "MiMo"',
    `base_url = "${baseUrl}"`,
    'wire_api = "responses"',
    "",
    "[model_providers.mimo.auth]",
    ...(WIN
      ? ['command = "node"', `args = ["-e", ${JSON.stringify(NODE_PRINTS_FILE)}, ${keyFile}]`]
      : ['command = "/bin/cat"', `args = [${keyFile}]`]),
    "",
  ].join("\n");
}

// The auth command as Codex reads it from config.toml.
function authCommand(home) {
  const block = fs.readFileSync(path.join(home, "config.toml"), "utf8").split("[model_providers.mimo.auth]\n")[1];
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

test("MiMo setup writes the config.toml it always wrote on POSIX, and the same with a Node auth command on Windows", async () => {
  for (const [billing, key, baseUrl] of [
    ["payg", "sk-fixture-testing-only", "https://api.xiaomimimo.com/v1"],
    ["token-plan", "tp-fixture-testing-only", "https://token-plan-cn.xiaomimimo.com/v1"],
  ]) {
    const fixture = setupFixture({ homeName: AWKWARD_HOME });
    const result = await setup(fixture, { key, args: ["--billing", billing] });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(fs.readFileSync(path.join(fixture.home, "config.toml"), "utf8"), expectedConfig(fixture.home, baseUrl));
    for (const file of ["api-key", "config.toml", "model-catalogs.json", "ccdm-mimo.json"]) {
      assert.equal(fs.readFileSync(path.join(fixture.home, file)).includes("\r"), false, `${file} has a carriage return`);
    }
  }
});

test("the MiMo auth command prints the key when started without a shell, before and after a rotation", async () => {
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

test("MiMo setup stops before it writes a key when the home cannot be made private", () => {
  const fixture = setupFixture();
  const scripts = path.join(fixture.workspace.repoDir, "scripts");
  const result = spawnSync(PYTHON, [
    "-c", REFUSING_PRIVACY, scripts, path.join(scripts, "setup-codex-mimo.py"),
    "--home", fixture.home, "--catalog-file", fixture.catalog,
  ], { encoding: "utf8", env: fixture.workspace.env, input: "sk-fixture-testing-only\n", windowsHide: true });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /MiMo setup failed: cannot make the home private/);
  assert.doesNotMatch(result.stdout + result.stderr, /sk-fixture/);
  // Nothing is left behind, so the same command can be run again.
  assert.equal(fs.existsSync(fixture.home), false);
});

const onlyWindows = platformGate("win32", "POSIX rotation leaves the home's mode as the operator set it");

test("on Windows, MiMo rotation makes the home private again before it writes the key", onlyWindows, async () => {
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
