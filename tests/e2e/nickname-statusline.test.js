import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { gitBashSh, platformGate } from "./support/platform.js";
import { createWorkspace, runNodeEntrypoint, runScript } from "./support/runner.js";
import { readState, seedRegistry, updateState } from "./support/state.js";
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
  updateState(workspace.stateDir, (state) => {
    state.fixtures.curl.routes.push({
      method: "PATCH",
      hostname: "discord.com",
      path: `/api/v10/guilds/guild-id/members/${member}`,
      exitCode,
      body: "{}",
    });
  });
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

const WIN = process.platform === "win32";
const WINDOWS_ONLY = platformGate("win32", "this case only means anything on Windows");
const STATUSLINE = "scripts/statusline-context.js";
const CONTEXT_JSON = /^\{"context_pct": \d+(\.\d+)?\}\n$/;
const nodeDir = path.dirname(process.execPath);
const routerDir = (workspace) => path.join(workspace.tmpRoot, "router");
const slashes = (value) => value.replaceAll("\\", "/");
const statusJson = (pct) => `${JSON.stringify({ context_window: { used_percentage: pct } })}\n`;

function seedLaunchDir(workspace, ...parts) {
  const dir = path.join(routerDir(workspace), "launches", ...parts);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const keyEnv = (workspace, name) => ({ CCDM_ROUTER_KEY_FILE: path.join(routerDir(workspace), "keys", `${name}.key`) });
const runStatusline = (workspace, env, input, args = []) => runNodeEntrypoint(workspace, STATUSLINE, { args, env, input });

// A workspace hides Git for Windows, so these name the real Git Bash.
const gitRoot = () => path.resolve(path.dirname(gitBashSh()), "..", "..");
const withGitBash = (env) => (WIN ? { ...env, CLAUDE_CODE_GIT_BASH_PATH: path.join(gitRoot(), "bin", "bash.exe") } : env);

// A chained command that saves the exact stdin bytes and prints a marker.
function chainFixture(workspace) {
  const script = path.join(workspace.tmpDir, "chain-fixture.cjs");
  const stdinFile = path.join(workspace.tmpDir, "chain-stdin.bin");
  fs.writeFileSync(script, `const fs = require("node:fs");
fs.writeFileSync(process.argv[2], fs.readFileSync(0));
process.stdout.write("chained-output\\n");
`);
  const command = `'${slashes(process.execPath)}' '${slashes(script)}' '${slashes(stdinFile)}'`;
  return { script, stdinFile, command };
}

function chainCmdFile(workspace, fixture) {
  const cmd = path.join(workspace.tmpDir, "chain-fixture.cmd");
  fs.writeFileSync(cmd, `@"${process.execPath}" "${fixture.script}" "${fixture.stdinFile}"\r\n`);
  return cmd;
}

test("statusline-context records a project session's percentage and prints nothing", async () => {
  const workspace = createWorkspace();
  const launchDir = seedLaunchDir(workspace, "alpha");

  const result = await runStatusline(workspace, keyEnv(workspace, "alpha"), statusJson(42));

  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
  assert.equal(fs.readFileSync(path.join(launchDir, "context.json"), "utf8"), '{"context_pct": 42}\n');
});

test("statusline-context records a thread session's percentage in that thread's own launch directory", async () => {
  const workspace = createWorkspace();
  const projectDir = seedLaunchDir(workspace, "beta");
  const otherThread = seedLaunchDir(workspace, "alpha", "threads", "111");
  const threadDir = seedLaunchDir(workspace, "beta", "threads", "222");

  const result = await runStatusline(workspace, keyEnv(workspace, ".thread-222"), statusJson(17.5));

  assert.equal(result.exitCode, 0, result.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(threadDir, "context.json"), "utf8")), { context_pct: 17.5 });
  assert.equal(fs.existsSync(path.join(projectDir, "context.json")), false);
  assert.equal(fs.existsSync(path.join(otherThread, "context.json")), false);
});

test("statusline-context leaves no file and exits 0 when there is nothing to record", async () => {
  const workspace = createWorkspace();
  const launchDir = seedLaunchDir(workspace, "alpha");
  const key = keyEnv(workspace, "alpha");
  const file = path.join(launchDir, "context.json");
  const cases = [
    ["no key file", {}, statusJson(42)],
    ["missing launch dir", keyEnv(workspace, "gone"), statusJson(42)],
    ["missing thread", keyEnv(workspace, ".thread-404"), statusJson(42)],
    ["no field", key, `${JSON.stringify({ other: true })}\n`],
    ["null field", key, statusJson(null)],
    ["text field", key, statusJson("42")],
    ["negative field", key, statusJson(-1)],
    ["not JSON", key, "not json"],
    ["empty stdin", key, undefined],
  ];
  for (const [name, env, input] of cases) {
    const result = await runStatusline(workspace, env, input);
    assert.equal(result.exitCode, 0, `${name}: ${result.stderr}`);
    assert.equal(result.stdout, "", name);
    assert.equal(result.stderr, "", name);
    assert.equal(fs.existsSync(file), false, name);
  }
  assert.deepEqual(fs.readdirSync(path.join(routerDir(workspace), "launches")), ["alpha"]);
});

test("statusline-context --chain passes the identical stdin bytes on, prints the output and returns its exit code", async () => {
  const workspace = createWorkspace();
  const launchDir = seedLaunchDir(workspace, "alpha");
  const fixture = chainFixture(workspace);
  const input = Buffer.from('{"context_window":{"used_percentage":64},"note":"café"}\r\n', "utf8");

  const chained = await runStatusline(workspace, withGitBash(keyEnv(workspace, "alpha")), input, ["--chain", fixture.command]);
  assert.equal(chained.exitCode, 0, chained.stderr);
  assert.equal(chained.stdout, "chained-output\n");
  assert.deepEqual(fs.readFileSync(fixture.stdinFile), input);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(launchDir, "context.json"), "utf8")), { context_pct: 64 });

  const failing = await runStatusline(workspace, withGitBash({}), statusJson(1), ["--chain", "exit 3"]);
  assert.equal(failing.exitCode, 3, failing.stderr);
});

test("statusline-context runs a .cmd as the chained command through Git Bash", WINDOWS_ONLY, async () => {
  const workspace = createWorkspace();
  const fixture = chainFixture(workspace);
  const input = Buffer.from(statusJson(9), "utf8");

  const result = await runStatusline(workspace, withGitBash({}), input, ["--chain", `'${slashes(chainCmdFile(workspace, fixture))}'`]);

  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout, /chained-output/);
  assert.deepEqual(fs.readFileSync(fixture.stdinFile), input);
});

test("statusline-context falls back to PowerShell for the chain when Git Bash is absent", WINDOWS_ONLY, async () => {
  const workspace = createWorkspace();
  const fixture = chainFixture(workspace);
  const input = Buffer.from(statusJson(9), "utf8");

  // PowerShell runs a .cmd only when PATHEXT lists it, which a workspace's does not.
  const env = { PATH: path.join(process.env.SystemRoot, "System32"), PATHEXT: ".COM;.EXE;.BAT;.CMD" };
  const result = await runStatusline(workspace, env, input, ["--chain", `& '${chainCmdFile(workspace, fixture)}'`]);

  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout, /chained-output/);
  assert.deepEqual(fs.readFileSync(fixture.stdinFile), input);
});

test("statusline-context finds Git Bash through git on PATH and ignores a bare bash.exe", WINDOWS_ONLY, async () => {
  const workspace = createWorkspace();
  const fixture = chainFixture(workspace);
  const decoyDir = path.join(workspace.tmpDir, "decoy");
  fs.mkdirSync(decoyDir);
  fs.writeFileSync(path.join(decoyDir, "bash.exe"), "not a program");
  const PATH = [decoyDir, path.join(gitRoot(), "cmd")].join(path.delimiter);

  const result = await runStatusline(workspace, { PATH }, statusJson(5), ["--chain", fixture.command]);

  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.stdout, "chained-output\n");
});

test("statusline-context records with only Node's directory on PATH", async () => {
  const workspace = createWorkspace();
  const launchDir = seedLaunchDir(workspace, "alpha");

  const result = await runStatusline(workspace, { ...keyEnv(workspace, "alpha"), PATH: nodeDir }, statusJson(33));

  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(fs.readFileSync(path.join(launchDir, "context.json"), "utf8"), '{"context_pct": 33}\n');
});

test("a reader racing statusline-context writers only ever sees a whole context.json", async () => {
  const workspace = createWorkspace();
  const launchDir = seedLaunchDir(workspace, "alpha");
  const file = path.join(launchDir, "context.json");
  fs.writeFileSync(file, '{"context_pct": 1}\n');

  let writing = true;
  let reads = 0;
  const reader = (async () => {
    while (writing) {
      try {
        assert.match(fs.readFileSync(file, "utf8"), CONTEXT_JSON);
        reads += 1;
      } catch (error) {
        // A Windows sharing error during the rename is no partial read.
        if (!["EBUSY", "EPERM", "EACCES"].includes(error.code)) throw error;
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
  })();

  const writers = Array.from({ length: 12 }, (_, index) => runStatusline(workspace, keyEnv(workspace, "alpha"), statusJson(index + 2)));
  const results = await Promise.all(writers);
  writing = false;
  await reader;

  for (const result of results) assert.equal(result.exitCode, 0, result.stderr);
  assert.ok(reads > 0);
  assert.deepEqual(fs.readdirSync(launchDir), ["context.json"]);
});
