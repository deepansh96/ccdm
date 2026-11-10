import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";

import { assertPrivate, fixtureLauncher, platformGate } from "./support/platform.js";
import { createWorkspace, runNodeEntrypoint, runScript, scaledTimeout } from "./support/runner.js";
import { seedRegistry } from "./support/state.js";
import { cleanup } from "./support/teardown.js";

// setup.sh is the macOS and Linux setup; setup.ps1 and `ccdm setup` are the Windows one.
const ZSH_SETUP = platformGate("posix", "drives setup.sh, a zsh script");
const NOT_WINDOWS = platformGate("posix", "on Windows `ccdm setup` is the setup itself");
const WINDOWS_SETUP = platformGate("win32", "setup.ps1 and `ccdm setup` are the Windows first-run setup");

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

test("registry example documents Claude account aliases for thread overrides", () => {
  const registryExample = JSON.parse(fs.readFileSync("registry.example.json", "utf8"));

  assert.deepEqual(registryExample.claude_accounts, {
    "example-claude-account": "~/.claude-example",
  });
});

test("registry example documents the default thread session caps", () => {
  const registryExample = JSON.parse(fs.readFileSync("registry.example.json", "utf8"));

  assert.deepEqual(registryExample.thread_session_caps, { claude: 6, codex: 8 });
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

test("setup creates a first-run registry, state files, and executable scripts", ZSH_SETUP, async () => {
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

test("setup reports missing required fixture tools before prompting", ZSH_SETUP, async () => {
  const workspace = createWorkspace({ excludeFixtures: ["tmux"] });

  const result = await runScript(workspace, "setup.sh");

  assert.equal(result.exitCode, 1);
  assert.match(result.stdout, /Missing required tools:/);
  assert.match(result.stdout, /tmux/);
  assert.ok(!fs.existsSync(path.join(workspace.repoDir, "registry.json")));
});

test("setup keeps an existing registry when overwrite is declined", ZSH_SETUP, async () => {
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

test("setup overwrites an existing registry when requested", ZSH_SETUP, async () => {
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

test("setup uses the next state directory when the default env is kept", ZSH_SETUP, async () => {
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

test("setup overwrites the default state directory when requested", ZSH_SETUP, async () => {
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

test("setup validates required prompts", ZSH_SETUP, async () => {
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

test("setup reruns without corrupting existing state", ZSH_SETUP, async () => {
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

test("ccdm setup points macOS and Linux at setup.sh and exits 2", NOT_WINDOWS, async () => {
  const workspace = createWorkspace();

  const result = await runScript(workspace, "scripts/ccdm", { args: ["setup"], input: promptInput("1", "2", "3", "4") });

  assert.equal(result.exitCode, 2, result.stderr || result.stdout);
  assert.match(result.stderr, /use \.\/setup\.sh/);
  assert.equal(result.stdout, "");
  assert.ok(!fs.existsSync(path.join(workspace.repoDir, "registry.json")));
  assert.ok(!fs.existsSync(path.join(workspace.homeDir, ".claude")));
});

// ---- Windows: setup.ps1 and `ccdm setup` ----

// Joined at run time, so the workspace's copy of this file does not hold it.
const TOKEN = ["fixture", "root", "token", "not", "a", "real", "one"].join("-");
const OWNER = "100000000000000001";
const GUILD = "200000000000000002";
const ROOT_CHANNEL = "300000000000000003";
const CATEGORY = "400000000000000004";
// The four IDs, then Enter for the machine id, its label and the guest mode.
const REGISTRY_ANSWERS = [OWNER, GUILD, ROOT_CHANNEL, CATEGORY, "", "", ""];
const SEAM = { CCDM_SETUP_TOKEN_STDIN: "1" };
const INSTALLERS = ["winget", "pip", "pip3", "npm"];
const RUNBOOK_LINKS = ["CLAUDE.md", ".mex/AGENTS.md"];

const tokenDir = workspace => path.join(workspace.homeDir, ".claude", "channels", "discord");
const envFile = workspace => path.join(tokenDir(workspace), ".env");
const registryFile = workspace => path.join(workspace.repoDir, "registry.json");
const installerCalls = workspace => path.join(workspace.tmpRoot, "installer-calls.log");
const inRepo = (workspace, name) => path.join(workspace.repoDir, ...name.split("/"));

function removeTool(dir, name) {
  for (const extension of [".exe", ".shim"]) fs.rmSync(path.join(dir, `${name}${extension}`), { force: true });
}

// A program on the workspace's PATH: the fixture launcher and its .shim. What is
// already there is unlinked first, because it is a hard link into a shared set.
function plantTool(dir, name, shimLines) {
  fs.mkdirSync(dir, { recursive: true });
  removeTool(dir, name);
  fs.copyFileSync(fixtureLauncher(), path.join(dir, `${name}.exe`));
  fs.writeFileSync(path.join(dir, `${name}.shim`), `${shimLines.join("\n")}\n`);
}

// A program that only writes down that it was started.
function plantRecorder(workspace, dir, name) {
  const recorder = path.join(workspace.tmpRoot, "record-call.cjs");
  fs.writeFileSync(recorder, "require(\"node:fs\").appendFileSync(process.argv[2], `${process.argv.slice(3).join(\" \")}\\n`);\n");
  plantTool(dir, name, [process.execPath, recorder, installerCalls(workspace), name]);
}

// A Test Workspace as a fresh Windows clone with every tool installed: node, git
// and ffmpeg join the harness's claude, codex and whisper, each installer is a
// recorder, and the runbook links resolve as in a clone made with symlinks.
function windowsWorkspace({ without = [], nodeVersion = null } = {}) {
  const workspace = createWorkspace();
  const fakeNode = path.join(workspace.tmpRoot, "other-node.cjs");
  fs.writeFileSync(fakeNode, `console.log(${JSON.stringify(nodeVersion)});\n`);
  plantTool(workspace.fixtureDir, "node", nodeVersion ? [process.execPath, fakeNode] : [process.execPath]);
  plantTool(workspace.fixtureDir, "git", [":noop"]);
  plantTool(workspace.fixtureDir, "ffmpeg", [":noop"]);
  for (const name of INSTALLERS) plantRecorder(workspace, workspace.fixtureDir, name);
  for (const name of without) removeTool(workspace.fixtureDir, name);
  for (const name of RUNBOOK_LINKS) {
    fs.rmSync(inRepo(workspace, name), { force: true });
    fs.copyFileSync(inRepo(workspace, "AGENTS.md"), inRepo(workspace, name));
  }
  return workspace;
}

// Every run names its own state root, and Codex is the fixture by its override:
// the production lookup wants the npm package beside a codex.cmd.
function setupEnv(workspace, extraEnv = {}) {
  return {
    CCDM_CODEX_PATH: path.join(workspace.fixtureDir, "codex.exe"),
    CCDM_STATE_ROOT: path.join(workspace.homeDir, ".local", "state", "ccdm"),
    ...extraEnv,
  };
}

const ccdmSetup = (workspace, { env, input } = {}) => runScript(workspace, "scripts/ccdm.py", {
  args: ["setup"], env: setupEnv(workspace, env), input, timeoutMs: 30000,
});

// PowerShell 7 where installed, which is what the operator is told to use, and
// the 5.1 that ships with Windows.
function powerShells() {
  const system = path.join(process.env.SystemRoot, "System32");
  const found = spawnSync(path.join(system, "where.exe"), ["pwsh.exe"], { encoding: "utf8", windowsHide: true });
  const seven = found.status === 0 ? found.stdout.split(/\r?\n/).filter(Boolean).slice(0, 1) : [];
  return [
    ...seven.map(shell => ({ shell, args: ["-NoProfile", "-File"] })),
    {
      shell: path.join(system, "WindowsPowerShell", "v1.0", "powershell.exe"),
      args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"],
    },
  ];
}

function setupPs1({ shell, args }, workspace, { env = {}, input = "" } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(shell, [...args, path.join(workspace.repoDir, "setup.ps1")], {
      cwd: workspace.repoDir, env: { ...workspace.env, ...setupEnv(workspace), ...env }, windowsHide: true,
    });
    const timer = setTimeout(() => child.kill(), scaledTimeout(60000));
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({ exitCode, stdout, stderr });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

const expectedRegistry = (overrides = {}) => ({
  discord_user_id: OWNER,
  guild_id: GUILD,
  root_channels: [ROOT_CHANNEL],
  root_allowed_user_ids: [],
  codex_accounts: {},
  default_codex_account: null,
  category_ids: [CATEGORY],
  projects: {},
  machine: { id: "win", label: "Windows" },
  guest_mode: "none",
  ...overrides,
});

// Every file under the workspace that holds `text`, apart from the launcher copies.
function filesHolding(workspace, text) {
  const holding = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && !file.endsWith(".exe") && fs.readFileSync(file).includes(text)) holding.push(file);
    }
  };
  for (const dir of [workspace.repoDir, workspace.homeDir, workspace.stateDir, workspace.tmpDir]) visit(dir);
  return holding;
}

async function routerPreflight(workspace) {
  const result = await runNodeEntrypoint(workspace, "scripts/router.js", { args: ["preflight"], env: setupEnv(workspace) });
  return { exitCode: result.exitCode, ...JSON.parse(result.stdout) };
}

function assertNothingWritten(workspace) {
  assert.ok(!fs.existsSync(registryFile(workspace)), "registry.json was written");
  assert.ok(!fs.existsSync(envFile(workspace)), "a token file was written");
  assert.ok(!fs.existsSync(inRepo(workspace, "CLAUDE.local.md")), "CLAUDE.local.md was written");
}

test("with only the Store stub on PATH, setup.ps1 exits non-zero and says how to install Python", WINDOWS_SETUP, async () => {
  const workspace = windowsWorkspace();
  const stubDir = path.join(workspace.tmpRoot, "WindowsApps");
  for (const name of ["py", "python"]) plantRecorder(workspace, stubDir, name);

  for (const powerShell of powerShells()) {
    for (const env of [{ PATH: stubDir }, { PATH: stubDir, CCDM_PYTHON: path.join(stubDir, "python.exe") }]) {
      const result = await setupPs1(powerShell, workspace, { env, input: promptInput(...REGISTRY_ANSWERS, TOKEN) });

      assert.notEqual(result.exitCode, 0, `${powerShell.shell}: ${result.stdout}`);
      assert.match(result.stderr, /No usable Python was found/);
      assert.match(result.stderr, /winget install Python\.Python\.3/);
      assert.match(result.stderr, /python\.org\/downloads/);
      if (env.CCDM_PYTHON) assert.match(result.stderr, /ignoring CCDM_PYTHON=/);
      assert.equal(result.stdout, "");
    }
  }
  // The stub was never started, and neither was an installer.
  assert.ok(!fs.existsSync(installerCalls(workspace)));
  assertNothingWritten(workspace);
});

test("setup.ps1 refuses a Python older than 3.11", WINDOWS_SETUP, async () => {
  const workspace = windowsWorkspace();
  const oldDir = path.join(workspace.tmpRoot, "old-python");
  // Exits 1 whatever it is asked, as an older interpreter answers the version check.
  const refuses = path.join(workspace.tmpRoot, "exit-one.cjs");
  fs.writeFileSync(refuses, "process.exit(1);\n");
  plantTool(oldDir, "python", [process.execPath, refuses]);

  for (const powerShell of powerShells()) {
    const result = await setupPs1(powerShell, workspace, { env: { PATH: oldDir } });

    assert.equal(result.exitCode, 1, `${powerShell.shell}: ${result.stdout}`);
    assert.match(result.stderr, /older than Python 3\.11/);
    assert.match(result.stderr, /winget install Python\.Python\.3/);
  }
  assertNothingWritten(workspace);
});

test("with ffmpeg absent, setup.ps1 prints its winget line, starts no installer and exits 1 before any question", WINDOWS_SETUP, async () => {
  const workspace = windowsWorkspace({ without: ["ffmpeg"] });

  for (const powerShell of powerShells()) {
    const result = await setupPs1(powerShell, workspace, { env: SEAM, input: promptInput(...REGISTRY_ANSWERS, TOKEN) });

    assert.equal(result.exitCode, 1, `${powerShell.shell}: ${result.stderr}${result.stdout}`);
    assert.match(result.stdout, /Missing required tools/);
    assert.match(result.stdout, /ffmpeg: winget install Gyan\.FFmpeg/);
    assert.match(result.stdout, /Setup installs nothing itself/);
    assert.doesNotMatch(result.stdout, /Discord user ID:|node:|git:|claude:|codex:/);
  }
  assert.ok(!fs.existsSync(installerCalls(workspace)), "an installer was started");
  assertNothingWritten(workspace);
});

test("each missing tool gets its one install line, an old Node counts as missing, and whisper only gets a note", WINDOWS_SETUP, async () => {
  const bare = windowsWorkspace({ without: ["node", "git", "claude", "ffmpeg", "whisper"] });
  const missing = await ccdmSetup(bare, { env: { CCDM_CODEX_PATH: "" }, input: promptInput(...REGISTRY_ANSWERS) });
  assert.equal(missing.exitCode, 1, missing.stderr || missing.stdout);
  for (const line of [
    "node: winget install OpenJS.NodeJS.LTS",
    "git: winget install Git.Git",
    "claude: see https://docs.anthropic.com/en/docs/claude-code",
    "codex: npm install -g @openai/codex",
    "ffmpeg: winget install Gyan.FFmpeg",
  ]) {
    assert.ok(missing.stdout.split(/\r?\n/).includes(`  - ${line}`), `no "${line}" in:\n${missing.stdout}`);
  }
  assert.doesNotMatch(missing.stdout, /Discord user ID:|whisper/);
  assert.ok(!fs.existsSync(installerCalls(bare)), "an installer was started");
  assertNothingWritten(bare);

  const old = windowsWorkspace({ nodeVersion: "v22.4.1" });
  const tooOld = await ccdmSetup(old, { input: promptInput(...REGISTRY_ANSWERS) });
  assert.equal(tooOld.exitCode, 1, tooOld.stderr || tooOld.stdout);
  assert.match(tooOld.stdout, /node 22\.5 or newer \(found 22\.4\): winget install OpenJS\.NodeJS\.LTS/);
  assertNothingWritten(old);

  const noWhisper = windowsWorkspace({ without: ["whisper"] });
  const noted = await ccdmSetup(noWhisper, { env: SEAM, input: promptInput(...REGISTRY_ANSWERS, TOKEN) });
  assert.equal(noted.exitCode, 0, noted.stderr || noted.stdout);
  assert.match(noted.stdout, /Note: whisper was not found/);
  assert.match(noted.stdout, /py -3 -m pip install openai-whisper/);
  assert.ok(!fs.existsSync(installerCalls(noWhisper)), "an installer was started");
});

test("setup.ps1 writes a registry the Router accepts, with every field and the category in category_ids", WINDOWS_SETUP, async () => {
  const { validateRegistry } = createRequire(import.meta.url)("../../scripts/router/registry.js");
  for (const powerShell of powerShells()) {
    const workspace = windowsWorkspace();

    const result = await setupPs1(powerShell, workspace, { env: SEAM, input: promptInput(...REGISTRY_ANSWERS, TOKEN) });

    assert.equal(result.exitCode, 0, `${powerShell.shell}: ${result.stderr}${result.stdout}`);
    assert.match(result.stdout, /Created registry\.json/);
    const text = fs.readFileSync(registryFile(workspace), "utf8");
    const registry = JSON.parse(text);
    assert.deepEqual(registry, expectedRegistry());
    assert.deepEqual(Object.keys(registry), Object.keys(expectedRegistry()));
    assert.equal(text, `${JSON.stringify(expectedRegistry(), null, 2)}\n`);
    validateRegistry(registry);
    assert.equal(fs.readFileSync(envFile(workspace), "utf8"), `DISCORD_BOT_TOKEN=${TOKEN}\n`);
    assert.deepEqual(fs.readdirSync(workspace.repoDir).filter(name => name.endsWith(".tmp")), []);
  }
});

test("the machine names and the guest mode can be answered, and the registry file gets its own private access list", WINDOWS_SETUP, async () => {
  const workspace = windowsWorkspace();

  const result = await ccdmSetup(workspace, {
    env: SEAM, input: promptInput(OWNER, GUILD, ROOT_CHANNEL, CATEGORY, "studio-pc", "Studio PC", "member-overwrites", TOKEN),
  });

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.deepEqual(JSON.parse(fs.readFileSync(registryFile(workspace), "utf8")),
    expectedRegistry({ machine: { id: "studio-pc", label: "Studio PC" }, guest_mode: "member-overwrites" }));
  // A file is private only inside a private directory, and a rename on one volume keeps its access list.
  const moved = path.join(tokenDir(workspace), "registry-moved.json");
  fs.renameSync(registryFile(workspace), moved);
  assertPrivate(moved);
});

test("no prompt or output offers server-wide Manage Roles, and guest_mode is member-overwrites or none", WINDOWS_SETUP, async () => {
  const workspace = windowsWorkspace();
  const finished = await ccdmSetup(workspace, { env: SEAM, input: promptInput(...REGISTRY_ANSWERS, TOKEN) });
  assert.equal(finished.exitCode, 0, finished.stderr || finished.stdout);
  assert.match(finished.stdout, /Guest mode \[none\]: /);
  assert.match(finished.stdout, /member-overwrites/);
  assert.doesNotMatch(finished.stdout + finished.stderr, /manage roles|manage_roles|\broles\b/i);
  assert.equal(JSON.parse(fs.readFileSync(registryFile(workspace), "utf8")).guest_mode, "none");

  for (const answer of ["roles", "manage-roles", "NONE"]) {
    const refusing = windowsWorkspace();
    const refused = await ccdmSetup(refusing, {
      env: SEAM, input: promptInput(OWNER, GUILD, ROOT_CHANNEL, CATEGORY, "", "", answer, TOKEN),
    });
    assert.equal(refused.exitCode, 1, refused.stderr || refused.stdout);
    assert.match(refused.stdout, /Error: guest mode must be member-overwrites or none\./);
    assertNothingWritten(refusing);
  }
});

test("a missing or malformed answer stops setup, and nothing is written for the step it belongs to", WINDOWS_SETUP, async () => {
  for (const [answers, message] of [
    [[""], /Error: your Discord user ID is required\./],
    [[OWNER, "not-an-id"], /Error: the Discord server ID must be a Discord ID, which is digits only\./],
    [[OWNER, GUILD], /Error: the root channel ID is required\./],
    [[OWNER, GUILD, ROOT_CHANNEL, ""], /Error: the category ID is required\./],
    [[OWNER, GUILD, ROOT_CHANNEL, CATEGORY, "Not A Slug"], /Error: the machine id is/],
    [[...REGISTRY_ANSWERS, ""], /Error: the bot token is required\./],
    [[...REGISTRY_ANSWERS, "two words"], /Error: a bot token has no spaces/],
  ]) {
    const workspace = windowsWorkspace();
    const result = await ccdmSetup(workspace, { env: SEAM, input: promptInput(...answers) });
    assert.equal(result.exitCode, 1, result.stderr || result.stdout);
    assert.match(result.stdout, message);
    assert.doesNotMatch(result.stdout, /two words/);
    assert.ok(!fs.existsSync(envFile(workspace)), "a token file was written");
    // The registry is written once its own answers are complete, before the token is asked for.
    assert.equal(fs.existsSync(registryFile(workspace)), answers.length > REGISTRY_ANSWERS.length);
  }
});

test("the token is read through the seam and appears in no output and no file but .env", WINDOWS_SETUP, async () => {
  for (const powerShell of powerShells()) {
    const workspace = windowsWorkspace();

    const result = await setupPs1(powerShell, workspace, { env: SEAM, input: promptInput(...REGISTRY_ANSWERS, TOKEN) });

    assert.equal(result.exitCode, 0, `${powerShell.shell}: ${result.stderr}${result.stdout}`);
    assert.ok(!result.stdout.includes(TOKEN) && !result.stderr.includes(TOKEN), "the token was printed");
    assert.match(result.stdout, /Saved the bot token to /);
    assert.deepEqual(filesHolding(workspace, TOKEN), [envFile(workspace)]);
  }
  const direct = windowsWorkspace();
  const result = await ccdmSetup(direct, { env: SEAM, input: promptInput(...REGISTRY_ANSWERS, TOKEN) });
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.ok(!result.stdout.includes(TOKEN) && !result.stderr.includes(TOKEN), "the token was printed");
  // The harness keeps each command's output and environment in the workspace's state.
  assert.deepEqual(filesHolding(direct, TOKEN), [envFile(direct)]);
});

test("with stdin not a console and no seam, setup refuses the token prompt and never echoes one", WINDOWS_SETUP, async () => {
  const fresh = windowsWorkspace();
  const refused = await ccdmSetup(fresh, { input: promptInput(...REGISTRY_ANSWERS, TOKEN) });
  assert.equal(refused.exitCode, 1, refused.stderr || refused.stdout);
  assert.match(refused.stdout, /this terminal cannot hide input/);
  assert.match(refused.stdout, /Run setup from Windows Terminal or a PowerShell window/);
  assert.doesNotMatch(refused.stdout, /Discord user ID:|typing is hidden/);
  assert.ok(!refused.stdout.includes(TOKEN) && !refused.stderr.includes(TOKEN));
  assertNothingWritten(fresh);

  // A token file is already there and the operator asks to replace it.
  const existing = windowsWorkspace();
  fs.mkdirSync(tokenDir(existing), { recursive: true });
  fs.writeFileSync(envFile(existing), "DISCORD_BOT_TOKEN=earlier-fixture-token\n");
  const replaced = await ccdmSetup(existing, { input: promptInput(...REGISTRY_ANSWERS, "y", TOKEN) });
  assert.equal(replaced.exitCode, 1, replaced.stderr || replaced.stdout);
  assert.match(replaced.stdout, /this terminal cannot hide input/);
  assert.doesNotMatch(replaced.stdout, /typing is hidden/);
  assert.ok(!replaced.stdout.includes(TOKEN) && !replaced.stderr.includes(TOKEN));
  assert.equal(fs.readFileSync(envFile(existing), "utf8"), "DISCORD_BOT_TOKEN=earlier-fixture-token\n");
  assert.deepEqual(filesHolding(existing, TOKEN), []);
});

// Runs `ccdm setup` in a Python that writes down each process setup starts and
// whether the token file existed at that moment. The privacy helper names
// icacls.exe by its System32 path, so a program on PATH cannot stand in for it.
const RECORDING_DRIVER = `
import json
import os
import subprocess
import sys

sys.dont_write_bytecode = True
log, env_file, scripts = sys.argv[1:4]


class RecordingPopen(subprocess.Popen):
    def __init__(self, command, *args, **kwargs):
        with open(log, "a", encoding="utf-8") as stream:
            row = {"command": [str(part) for part in command], "env_file": os.path.exists(env_file)}
            stream.write(json.dumps(row) + "\\n")
        super().__init__(command, *args, **kwargs)


subprocess.Popen = RecordingPopen
sys.path.insert(0, scripts)
from ccdmlib.cli import main

sys.exit(main(["setup"]))
`;

test("the token directory has the protected access list before .env exists, and the Router's preflight reports it private", WINDOWS_SETUP, async () => {
  const workspace = windowsWorkspace();
  const log = path.join(workspace.tmpRoot, "started.jsonl");
  fs.writeFileSync(path.join(workspace.tmpRoot, "recording-setup.py"), RECORDING_DRIVER);

  const result = await runScript(workspace, "../recording-setup.py", {
    args: [log, envFile(workspace), path.join(workspace.repoDir, "scripts")],
    env: setupEnv(workspace, SEAM), input: promptInput(...REGISTRY_ANSWERS, TOKEN), timeoutMs: 30000,
  });

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  const started = fs.readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line));
  const program = row => path.basename(row.command[0]).toLowerCase();
  const onTokenDir = started.filter(row => program(row) === "icacls.exe" && row.command[1] === tokenDir(workspace));
  assert.ok(onTokenDir.length > 0, "icacls was never run on the token directory");
  assert.ok(onTokenDir.some(row => row.command.includes("/inheritance:r")), JSON.stringify(onTokenDir));
  // Every change to the directory's access came before the token file.
  assert.deepEqual(started.filter(row => row.env_file), []);
  // Setup starts Node (its version, the registry check) and icacls, and nothing that installs.
  assert.deepEqual([...new Set(started.map(program))].sort(), ["icacls.exe", "node.exe"]);
  assert.ok(!fs.existsSync(installerCalls(workspace)), "an installer was started");

  assert.equal(fs.readFileSync(envFile(workspace), "utf8"), `DISCORD_BOT_TOKEN=${TOKEN}\n`);
  assertPrivate(tokenDir(workspace));
  assertPrivate(envFile(workspace));
  assert.deepEqual(await routerPreflight(workspace), { exitCode: 0, ready: true, blockers: [] });
});

test("setup writes no token when its directory cannot be made private", WINDOWS_SETUP, async () => {
  const workspace = windowsWorkspace();
  fs.mkdirSync(path.dirname(tokenDir(workspace)), { recursive: true });
  // Something else already sits where the directory belongs.
  fs.writeFileSync(tokenDir(workspace), "not a directory\n");

  const result = await ccdmSetup(workspace, { env: SEAM, input: promptInput(...REGISTRY_ANSWERS, TOKEN) });

  assert.equal(result.exitCode, 1, result.stderr || result.stdout);
  assert.match(result.stdout, /^Error: /m);
  assert.doesNotMatch(result.stdout, /Saved the bot token|typing is hidden/);
  assert.equal(fs.readFileSync(tokenDir(workspace), "utf8"), "not a directory\n");
  assert.deepEqual(filesHolding(workspace, TOKEN), []);
});

test("Enter at both overwrite prompts leaves registry.json and .env byte-identical, and the kept token becomes private", WINDOWS_SETUP, async () => {
  const workspace = windowsWorkspace();
  const registryBytes = Buffer.from("{ \"discord_user_id\": \"9\",\r\n  \"projects\": {}, \"kept\": true }");
  const envBytes = Buffer.from("# kept\r\nDISCORD_BOT_TOKEN=earlier-fixture-token\r\n");
  fs.writeFileSync(registryFile(workspace), registryBytes);
  fs.mkdirSync(tokenDir(workspace), { recursive: true });
  fs.writeFileSync(envFile(workspace), envBytes);

  // No seam and no console: keeping the token needs neither.
  const result = await ccdmSetup(workspace, { input: promptInput("", "") });

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /registry\.json already exists\. Overwrite it\? \(y\/N\): /);
  assert.match(result.stdout, /Keeping the existing registry\.json\./);
  assert.match(result.stdout, /already holds a bot token\. Overwrite it\? \(y\/N\): /);
  assert.match(result.stdout, /Keeping the existing bot token\./);
  assert.doesNotMatch(result.stdout, /Discord user ID:|typing is hidden/);
  assert.ok(fs.readFileSync(registryFile(workspace)).equals(registryBytes));
  assert.ok(fs.readFileSync(envFile(workspace)).equals(envBytes));
  // There is no discordN fallback on Windows.
  assert.deepEqual(fs.readdirSync(path.dirname(tokenDir(workspace))), ["discord"]);
  assert.deepEqual(fs.readdirSync(tokenDir(workspace)), [".env"]);
  assertPrivate(tokenDir(workspace));
  assertPrivate(envFile(workspace));
  assert.deepEqual(await routerPreflight(workspace), { exitCode: 0, ready: true, blockers: [] });
});

test("answering y at both overwrite prompts replaces registry.json and .env", WINDOWS_SETUP, async () => {
  const workspace = windowsWorkspace();
  seedRegistry(workspace, { discord_user_id: "9", projects: { old: { channel_id: "8" } } });
  fs.mkdirSync(tokenDir(workspace), { recursive: true });
  fs.writeFileSync(envFile(workspace), "DISCORD_BOT_TOKEN=earlier-fixture-token\n");

  const result = await ccdmSetup(workspace, { env: SEAM, input: promptInput("y", ...REGISTRY_ANSWERS, "Y", TOKEN) });

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.deepEqual(JSON.parse(fs.readFileSync(registryFile(workspace), "utf8")), expectedRegistry());
  assert.equal(fs.readFileSync(envFile(workspace), "utf8"), `DISCORD_BOT_TOKEN=${TOKEN}\n`);
  assert.deepEqual(fs.readdirSync(tokenDir(workspace)), [".env"]);
});

test("a CLAUDE.md that is a 9-byte text file makes setup fail with the symlink fix, before any question", WINDOWS_SETUP, async () => {
  for (const broken of RUNBOOK_LINKS) {
    const workspace = windowsWorkspace();
    fs.writeFileSync(inRepo(workspace, broken), "AGENTS.md");
    assert.equal(fs.statSync(inRepo(workspace, broken)).size, 9);

    const result = await ccdmSetup(workspace, { env: SEAM, input: promptInput(...REGISTRY_ANSWERS, TOKEN) });

    assert.equal(result.exitCode, 1, result.stderr || result.stdout);
    assert.ok(result.stdout.includes(`Error: ${broken} is neither a symlink to AGENTS.md nor a copy of it`), result.stdout);
    assert.match(result.stdout, /Developer Mode/);
    assert.match(result.stdout, /git config --global core\.symlinks true/);
    assert.match(result.stdout, /clone the repository again/);
    assert.doesNotMatch(result.stdout, /Discord user ID:/);
    assertNothingWritten(workspace);
  }
});

test("CLAUDE.local.md is created from the template only when absent", WINDOWS_SETUP, async () => {
  const template = fs.readFileSync("CLAUDE.local.md.example");
  for (const heading of ["## This machine", "## Claude homes", "## Codex accounts", "## Discord bots"]) {
    assert.ok(template.includes(heading), `CLAUDE.local.md.example has no "${heading}"`);
  }
  assert.match(template.toString(), /<machine id>.*<machine label>/);
  assert.match(template.toString(), /root bot: `<bot name>`/);

  const fresh = windowsWorkspace();
  const created = await ccdmSetup(fresh, { env: SEAM, input: promptInput(...REGISTRY_ANSWERS, TOKEN) });
  assert.equal(created.exitCode, 0, created.stderr || created.stdout);
  assert.match(created.stdout, /Created CLAUDE\.local\.md from CLAUDE\.local\.md\.example/);
  assert.ok(fs.readFileSync(inRepo(fresh, "CLAUDE.local.md")).equals(template));

  const existing = windowsWorkspace();
  const mine = Buffer.from("# my notes\r\nkept as written\r\n");
  fs.writeFileSync(inRepo(existing, "CLAUDE.local.md"), mine);
  const kept = await ccdmSetup(existing, { env: SEAM, input: promptInput(...REGISTRY_ANSWERS, TOKEN) });
  assert.equal(kept.exitCode, 0, kept.stderr || kept.stdout);
  assert.match(kept.stdout, /Keeping the existing CLAUDE\.local\.md\./);
  assert.ok(fs.readFileSync(inRepo(existing, "CLAUDE.local.md")).equals(mine));
});

test("the next steps name the service installs in a working order, restart-root, the -win project and the statusLine note", WINDOWS_SETUP, async () => {
  const workspace = windowsWorkspace();

  const result = await ccdmSetup(workspace, { env: SEAM, input: promptInput(...REGISTRY_ANSWERS, TOKEN) });

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  const steps = result.stdout.slice(result.stdout.indexOf("Next steps"));
  const at = (text) => {
    const index = steps.indexOf(text);
    assert.ok(index >= 0, `the next steps do not say "${text}":\n${steps}`);
    return index;
  };
  // The Router first: the installs after it check that it is running.
  const order = ["router", "host", "thread-supervisor", "root-at-logon", "reminders", "usage-poster"]
    .map(service => at(`scripts\\ccdm install-service ${service}`));
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
  assert.ok(at("scripts\\ccdm install-service root-at-logon") < at("Optional, only if you want them"));
  assert.ok(at("Optional, only if you want them") < at("scripts\\ccdm install-service reminders"));
  assert.ok(at("scripts\\ccdm install-service usage-poster") < at("scripts\\ccdm restart-root"));
  at("while no session is live");
  at("records its environment");
  at("CLAUDE_CONFIG_DIR");
  at("#root-win");
  at("ending in -win");
  at("npm ci");
  assert.match(steps, /statusLine is written for each launch by the launchers/);
  assert.match(steps, /--chain/);
  assert.match(steps, /Setup does not touch Claude settings/);
  assert.ok(!fs.existsSync(path.join(workspace.homeDir, ".claude", "settings.json")));
  assert.ok(!fs.existsSync(installerCalls(workspace)), "an installer was started");
});
