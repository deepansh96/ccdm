import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { assertIsolatedPath, buildCommandDiagnostics } from "./diagnostics.js";
import { readState, recordCommandInvocation, writeState } from "./state.js";
import { registerTeardownCallback } from "./teardown.js";

const FORBIDDEN_WORKSPACE_ARTIFACTS = [
  "registry.json",
  ".env",
  "CLAUDE.local.md",
  "scripts/usage-report-loop.sh",
  ".claude",
  ".codex",
];

const FIXTURE_TOOLS = new Set(["claude", "jq", "npm", "pgrep", "pkill", "ps", "sleep", "tmux", "whisper", "zsh"]);
const HOST_WRAPPERS = new Map([
  ["cat", "/bin/cat"],
  ["chmod", "/bin/chmod"],
  ["dirname", "/usr/bin/dirname"],
  ["grep", null],
  ["mkdir", "/bin/mkdir"],
  ["python3", null],
  ["sed", null],
]);

function sourceRoot() {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || "Unable to resolve git root");
  }
  return result.stdout.trim();
}

function gitTrackedFiles(root) {
  const result = spawnSync("git", ["ls-files", "-z"], {
    cwd: root,
    encoding: "buffer",
  });
  if (result.status !== 0) {
    throw new Error(result.stderr.toString("utf8") || "Unable to list tracked files");
  }
  return result.stdout.toString("utf8").split("\0").filter(Boolean);
}

function rejectForbiddenTrackedArtifacts(files) {
  const forbidden = files.filter((file) =>
    FORBIDDEN_WORKSPACE_ARTIFACTS.some((artifact) => file === artifact || file.startsWith(`${artifact}/`)),
  );
  if (forbidden.length > 0) {
    throw new Error(`Tracked local-only artifacts are not allowed in E2E workspaces: ${forbidden.join(", ")}`);
  }
}

function copyTrackedFiles(root, repoDir, files) {
  for (const file of files) {
    const source = path.join(root, file);
    const destination = path.join(repoDir, file);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
    fs.chmodSync(destination, fs.statSync(source).mode);
  }
}

function assertWorkspaceClean(repoDir) {
  const present = FORBIDDEN_WORKSPACE_ARTIFACTS.filter((artifact) => fs.existsSync(path.join(repoDir, artifact)));
  if (present.length > 0) {
    throw new Error(`Local-only artifacts leaked into Test Workspace: ${present.join(", ")}`);
  }
}

function writeExecutable(file, content) {
  fs.writeFileSync(file, content);
  fs.chmodSync(file, 0o755);
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\"'\"'")}'`;
}

function hostCommandPath(name) {
  const result = spawnSync("/bin/sh", ["-lc", `command -v ${name}`], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    return null;
  }
  return result.stdout.trim() || null;
}

function createFixtureRuntime(fixtureDir) {
  const runtime = path.join(fixtureDir, "fixture-runtime.cjs");
  writeExecutable(
    runtime,
    `#!/usr/bin/env node
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const tool = process.argv[2];
const args = process.argv.slice(3);
const stateDir = process.env.CCDM_TEST_STATE;

if (!stateDir) {
  console.error("CCDM_TEST_STATE is required");
  process.exit(64);
}

const stateFile = path.join(stateDir, "state.json");

function initialState() {
  return {
    schemaVersion: 1,
    commands: [],
    diagnostics: { cleanupFailures: [], logs: [], protectedPathViolations: [] },
    fixtures: {
      claude: { invocations: [] },
      codex: { appServerInvocations: [], bridgeInvocations: [] },
      npm: { invocations: [] },
      processes: [],
      registry: null,
      tmux: { sessions: {} },
    },
    snapshots: [],
  };
}

function normalizeState(value) {
  const base = initialState();
  return {
    ...base,
    ...(value || {}),
    commands: value?.commands || [],
    diagnostics: { ...base.diagnostics, ...(value?.diagnostics || {}) },
    fixtures: {
      ...base.fixtures,
      ...(value?.fixtures || {}),
      claude: { invocations: value?.fixtures?.claude?.invocations || [] },
      codex: {
        appServerInvocations: value?.fixtures?.codex?.appServerInvocations || [],
        bridgeInvocations: value?.fixtures?.codex?.bridgeInvocations || [],
      },
      npm: { invocations: value?.fixtures?.npm?.invocations || [] },
      processes: value?.fixtures?.processes || [],
      tmux: { ...(value?.fixtures?.tmux || {}), sessions: value?.fixtures?.tmux?.sessions || {} },
    },
    snapshots: value?.snapshots || [],
  };
}

function readState() {
  if (!fs.existsSync(stateFile)) {
    return initialState();
  }
  return normalizeState(JSON.parse(fs.readFileSync(stateFile, "utf8")));
}

function writeState(nextState) {
  fs.mkdirSync(stateDir, { recursive: true });
  const tmp = path.join(stateDir, \`.state.\${process.pid}.\${Date.now()}.tmp\`);
  fs.writeFileSync(tmp, \`\${JSON.stringify(normalizeState(nextState), null, 2)}\\n\`);
  fs.renameSync(tmp, stateFile);
}

function updateState(updater) {
  const current = readState();
  writeState(updater(current) || current);
  return readState();
}

function normalizeSessionTarget(value) {
  return String(value || "").replace(/^=/, "");
}

function isAlive(pid) {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

function activeOwnedProcesses(state) {
  return state.fixtures.processes.filter((row) =>
    row?.owned === true &&
    row.ownerStateDir === stateDir &&
    Number.isInteger(row.pid) &&
    isAlive(row.pid)
  );
}

function spawnPlaceholder() {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true,
    env: {
      CCDM_FIXTURE_PLACEHOLDER: "1",
      CCDM_TEST_STATE: stateDir,
    },
    stdio: "ignore",
  });
  child.unref();
  return child.pid;
}

function parseClaudeLaunch(shellCommand) {
  const match =
    /^cd '([\\s\\S]*)' && DISCORD_STATE_DIR='([\\s\\S]*)' claude ([\\s\\S]+)$/.exec(shellCommand) ||
    /^cd ([^&]+) && DISCORD_STATE_DIR=([^\\s]+) claude ([\\s\\S]+)$/.exec(shellCommand);
  if (!match) {
    throw new Error(\`unsupported tmux launch command: \${shellCommand}\`);
  }
  const claudeArgs = match[3].trim().split(/\\s+/);
  validateClaudeInvocation(claudeArgs, { DISCORD_STATE_DIR: match[2] });
  return {
    cwd: match[1],
    env: { DISCORD_STATE_DIR: match[2] },
    claudeArgs,
  };
}

function parseCodexBridgeLaunch(shellCommand) {
  const match = /^cd '([^']*)' && ([\\s\\S]+) node scripts\\/codex-bridge\\.js$/.exec(shellCommand);
  if (!match) {
    throw new Error(\`unsupported tmux launch command: \${shellCommand}\`);
  }
  const env = {};
  const envText = match[2];
  const envRe = /([A-Z_]+)='([^']*)'/g;
  for (const envMatch of envText.matchAll(envRe)) {
    env[envMatch[1]] = envMatch[2];
  }
  const required = [
    "BOT_TOKEN",
    "CHANNEL_ID",
    "PROJECT_DIR",
    "WS_PORT",
    "ALLOWED_USER_ID",
    "GUILD_ID",
    "ROOT_BOT_TOKEN",
    "BOT_APP_ID",
    "BOT_DISPLAY_NAME",
  ];
  for (const name of required) {
    if (!env[name]) {
      throw new Error(\`\${name} is required for Codex bridge launch\`);
    }
  }
  return {
    cwd: match[1],
    env,
    bridgeCommand: "node scripts/codex-bridge.js",
  };
}

function parseTmuxLaunch(shellCommand) {
  if (shellCommand.endsWith(" node scripts/codex-bridge.js")) {
    return { kind: "codex-bridge", ...parseCodexBridgeLaunch(shellCommand) };
  }
  return { kind: "claude-listener", ...parseClaudeLaunch(shellCommand) };
}

function validateClaudeInvocation(claudeArgs, env) {
  const channelsIndex = claudeArgs.indexOf("--channels");
  if (channelsIndex === -1 || !claudeArgs[channelsIndex + 1]?.startsWith("plugin:discord")) {
    throw new Error("claude listener must use --channels plugin:discord...");
  }
  if (!claudeArgs.includes("--dangerously-skip-permissions")) {
    throw new Error("claude listener must use --dangerously-skip-permissions");
  }
  if (!env.DISCORD_STATE_DIR) {
    throw new Error("DISCORD_STATE_DIR is required for claude listener");
  }
}

function recordClaudeInvocation(invocation) {
  updateState((state) => {
    state.fixtures.claude.invocations.push(invocation);
    return state;
  });
}

function recordCodexBridgeInvocation(invocation) {
  updateState((state) => {
    state.fixtures.codex.bridgeInvocations.push(invocation);
    return state;
  });
}

function writeClaudeSession(pid, sessionId) {
  const home = process.env.HOME;
  if (!home) {
    return;
  }
  const sessionsDir = path.join(home, ".claude", "sessions");
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.writeFileSync(path.join(sessionsDir, \`\${pid}.json\`), \`\${JSON.stringify({ sessionId }, null, 2)}\\n\`);
}

function runTmux() {
  const subcommand = args[0];
  if (subcommand === "has-session") {
    const targetIndex = args.indexOf("-t");
    const name = normalizeSessionTarget(args[targetIndex + 1]);
    process.exit(readState().fixtures.tmux.sessions[name] ? 0 : 1);
  }

  if (subcommand === "new-session") {
    const sessionIndex = args.indexOf("-s");
    const separatorIndex = args.indexOf("--");
    const name = args[sessionIndex + 1];
    const command = args.slice(separatorIndex + 1);
    if (!name || separatorIndex === -1 || command[0] !== "zsh" || command[1] !== "-ic" || !command[2]) {
      console.error("unsupported tmux new-session invocation");
      process.exit(2);
    }
    const shellCommand = command[2];
    const tmuxState = readState().fixtures.tmux;
    const preexistingSession = tmuxState.sessions[name];
    if (tmuxState.newSessionFailures?.[name]) {
      updateState((state) => {
        state.fixtures.tmux.newSessionFailures[name] -= 1;
        return state;
      });
      console.error("fixture tmux new-session failure");
      process.exit(1);
    }
    if (preexistingSession?.newSessionStatus) {
      console.error("fixture tmux new-session failure");
      process.exit(preexistingSession.newSessionStatus);
    }
    const priorKillAttempts =
      tmuxState.lastKilledSessions?.[name]?.killAttempts ?? preexistingSession?.killAttempts ?? 0;
    const launch = parseTmuxLaunch(shellCommand);
    const pid = spawnPlaceholder();
    const sessionId = \`fixture-session-\${pid}\`;
    const processCommand =
      launch.kind === "codex-bridge"
        ? \`node scripts/codex-bridge.js CHANNEL_ID='\${launch.env.CHANNEL_ID}' BOT_APP_ID='\${launch.env.BOT_APP_ID}' WS_PORT='\${launch.env.WS_PORT}'\`
        : \`claude \${launch.claudeArgs.join(" ")} DISCORD_STATE_DIR='\${launch.env.DISCORD_STATE_DIR}'\`;
    const paneOutput =
      launch.kind === "codex-bridge"
        ? "Codex-Discord bridge running\\nListening in #channel-id\\n"
        : "Listening for channel messages\\n";

    updateState((state) => {
      if (state.fixtures.tmux.sessions[name]) {
        const existing = state.fixtures.tmux.sessions[name];
        if (existing.killFailuresRemaining || existing.newSessionStatus) {
          throw new Error(\`duplicate tmux session: \${name}\`);
        }
      }
      state.fixtures.tmux.sessions[name] = {
        name,
        command,
        cwd: launch.cwd,
        env: launch.env,
        bridgeCommand: launch.bridgeCommand,
        paneOutput,
        pid,
        killAttempts: priorKillAttempts,
        shellCommand,
      };
      state.fixtures.processes.push({
        command: processCommand,
        kind: launch.kind,
        owned: true,
        ownerStateDir: stateDir,
        pid,
        ppid: process.pid,
      });
      return state;
    });
    if (launch.kind === "codex-bridge") {
      recordCodexBridgeInvocation({
        command: launch.bridgeCommand,
        cwd: launch.cwd,
        env: launch.env,
        pid,
      });
    } else {
      recordClaudeInvocation({
        args: launch.claudeArgs,
        cwd: launch.cwd,
        env: launch.env,
        pid,
        sessionId,
      });
      writeClaudeSession(pid, sessionId);
    }
    process.exit(0);
  }

  if (subcommand === "kill-session") {
    const targetIndex = args.indexOf("-t");
    const name = normalizeSessionTarget(args[targetIndex + 1]);
    const state = readState();
    const session = state.fixtures.tmux.sessions[name];
    if (!session) {
      process.exit(1);
    }
    updateState((nextState) => {
      const nextSession = nextState.fixtures.tmux.sessions[name];
      nextSession.killAttempts = (nextSession.killAttempts || 0) + 1;
      if (nextSession.killFailuresRemaining > 0) {
        nextSession.killFailuresRemaining -= 1;
      } else {
        nextState.fixtures.tmux.lastKilledSessions = {
          ...(nextState.fixtures.tmux.lastKilledSessions || {}),
          [name]: { killAttempts: nextSession.killAttempts },
        };
        delete nextState.fixtures.tmux.sessions[name];
      }
      return nextState;
    });
    process.exit(session.killFailuresRemaining > 0 ? 1 : 0);
  }

  if (subcommand === "display-message") {
    const targetIndex = args.indexOf("-t");
    const name = normalizeSessionTarget(args[targetIndex + 1]);
    const session = readState().fixtures.tmux.sessions[name];
    if (!session) {
      process.exit(1);
    }
    if (args.includes("#{pane_pid}")) {
      process.stdout.write(session.panePid ? \`\${session.panePid}\\n\` : "");
      process.exit(0);
    }
    console.error(\`unsupported tmux display-message format: \${args.join(" ")}\`);
    process.exit(2);
  }

  if (subcommand === "capture-pane") {
    const targetIndex = args.indexOf("-t");
    const name = normalizeSessionTarget(args[targetIndex + 1]);
    const session = readState().fixtures.tmux.sessions[name];
    if (!session) {
      process.exit(1);
    }
    process.stdout.write(session.paneOutput || "");
    process.exit(0);
  }

  if (subcommand === "send-keys") {
    const targetIndex = args.indexOf("-t");
    const name = normalizeSessionTarget(args[targetIndex + 1]);
    updateState((state) => {
      const session = state.fixtures.tmux.sessions[name] || { name };
      session.sendKeys = [...(session.sendKeys || []), args.slice(targetIndex + 2)];
      state.fixtures.tmux.sessions[name] = session;
      return state;
    });
    process.exit(0);
  }

  console.error(\`unsupported tmux command: \${args.join(" ")}\`);
  process.exit(2);
}

function runPs() {
  if (args.join(" ") !== "axeww -o pid=,command=") {
    console.error("unsupported ps invocation");
    process.exit(2);
  }
  const rows = activeOwnedProcesses(readState());
  for (const row of rows) {
    process.stdout.write(\`\${String(row.pid).padStart(5, " ")} \${row.command}\\n\`);
  }
}

function runPgrep() {
  if (args[0] !== "-P" || !args[1] || args.length !== 2) {
    console.error("unsupported pgrep invocation");
    process.exit(2);
  }
  const parentPid = Number(args[1]);
  const rows = activeOwnedProcesses(readState()).filter((row) => row.ppid === parentPid);
  for (const row of rows) {
    process.stdout.write(\`\${row.pid}\\n\`);
  }
  process.exit(rows.length > 0 ? 0 : 1);
}

function runPkill() {
  if (args[0] !== "-TERM" || args[1] !== "-P" || !args[2] || args.length !== 3) {
    console.error("unsupported pkill invocation");
    process.exit(2);
  }
  const parentPid = Number(args[2]);
  const rows = activeOwnedProcesses(readState()).filter((row) => row.ppid === parentPid);
  for (const row of rows) {
    try {
      process.kill(row.pid, "SIGTERM");
    } catch {
      // The process may have already exited.
    }
  }
  process.exit(rows.length > 0 ? 0 : 1);
}

function runClaude() {
  if (args.length === 1 && args[0] === "--version") {
    console.log("Claude Code fixture 1.0.0");
    return;
  }
  try {
    validateClaudeInvocation(args, process.env);
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
  const sessionId = \`fixture-session-\${process.pid}\`;
  recordClaudeInvocation({
    args,
    cwd: process.cwd(),
    env: { DISCORD_STATE_DIR: process.env.DISCORD_STATE_DIR },
    pid: process.pid,
    sessionId,
  });
  writeClaudeSession(process.pid, sessionId);
}

function runNpm() {
  updateState((state) => {
    state.fixtures.npm.invocations.push({
      args,
      cwd: process.cwd(),
    });
    return state;
  });
  console.error("npm fixture blocks package-manager execution during E2E scenarios");
  process.exit(42);
}

switch (tool) {
  case "tmux":
    runTmux();
    break;
  case "ps":
    runPs();
    break;
  case "pgrep":
    runPgrep();
    break;
  case "pkill":
    runPkill();
    break;
  case "claude":
    runClaude();
    break;
  case "npm":
    runNpm();
    break;
  case "jq":
  case "whisper":
  case "zsh":
    process.exit(0);
    break;
  default:
    console.error(\`unknown fixture tool: \${tool}\`);
    process.exit(127);
}
`,
  );
  return runtime;
}

function createFixtureBin(fixtureDir, runtime, name) {
  writeExecutable(
    path.join(fixtureDir, name),
    `#!/bin/sh
exec ${shellQuote(process.execPath)} ${shellQuote(runtime)} ${shellQuote(name)} "$@"
`,
  );
}

function createHostWrapper(fixtureDir, name, target) {
  const resolvedTarget = target ?? hostCommandPath(name);
  if (!resolvedTarget || !fs.existsSync(resolvedTarget)) {
    return;
  }
  writeExecutable(
    path.join(fixtureDir, name),
    `#!/bin/sh
exec ${shellQuote(resolvedTarget)} "$@"
`,
  );
}

function createFixtures(fixtureDir, options = {}) {
  fs.mkdirSync(fixtureDir, { recursive: true });
  const runtime = createFixtureRuntime(fixtureDir);
  const exclude = new Set(options.excludeFixtures ?? []);
  for (const tool of FIXTURE_TOOLS) {
    if (!exclude.has(tool)) {
      if (tool === "sleep") {
        const truePath = ["/usr/bin/true", "/bin/true"].find((candidate) => fs.existsSync(candidate));
        if (!truePath) {
          throw new Error("Unable to create sleep fixture: true binary not found");
        }
        fs.symlinkSync(truePath, path.join(fixtureDir, tool));
      } else {
        createFixtureBin(fixtureDir, runtime, tool);
      }
    }
  }
  for (const [name, target] of HOST_WRAPPERS) {
    if (!exclude.has(name)) {
      createHostWrapper(fixtureDir, name, target);
    }
  }
}

function nodePath(root) {
  return path.join(root, "node_modules");
}

export const createWorkspace = Object.freeze(function createWorkspace(options = {}) {
  const root = sourceRoot();
  const files = gitTrackedFiles(root);
  rejectForbiddenTrackedArtifacts(files);

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ccdm-e2e-"));
  const repoDir = path.join(tmpRoot, "repo");
  const homeDir = path.join(tmpRoot, "home");
  const tmpDir = path.join(tmpRoot, "tmp");
  const stateDir = path.join(tmpRoot, "state");
  const fixtureDir = path.join(tmpRoot, "fixtures");
  fs.mkdirSync(repoDir, { recursive: true });
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });

  copyTrackedFiles(root, repoDir, files);
  assertWorkspaceClean(repoDir);
  createFixtures(fixtureDir, options);
  writeState(undefined, stateDir);

  const workspace = Object.freeze({
    env: Object.freeze({
      CCDM_TEST_STATE: stateDir,
      HOME: homeDir,
      NODE_OPTIONS: "",
      NODE_PATH: nodePath(root),
      PATH: fixtureDir,
      TMPDIR: tmpDir,
    }),
    fixtureDir,
    homeDir,
    repoDir,
    sourceRoot: root,
    stateDir,
    tmpDir,
    tmpRoot,
  });

  registerTeardownCallback(() => {
    try {
      const state = readState(stateDir);
      for (const row of state.fixtures.processes ?? []) {
        if (row?.owned === true && row.ownerStateDir === stateDir && Number.isInteger(row.pid)) {
          try {
            process.kill(-row.pid, "SIGTERM");
          } catch {
            // The process group may already be gone.
          }
          try {
            process.kill(row.pid, "SIGTERM");
          } catch {
            // The process may already be gone.
          }
        }
      }
    } catch {
      // Workspace removal should still proceed if fixture cleanup cannot read state.
    }
    fs.rmSync(tmpRoot, { force: true, recursive: true });
  });

  return workspace;
});

function buildEnv(workspace, extraEnv = {}) {
  return {
    ...workspace.env,
    ...extraEnv,
  };
}

function runProcess(workspace, command, args, options = {}) {
  assertIsolatedPath(workspace, workspace.homeDir);
  assertIsolatedPath(workspace, workspace.tmpDir);
  const env = buildEnv(workspace, options.env);
  const cwd = options.cwd ?? workspace.repoDir;
  const child = spawn(command, args, {
    cwd,
    detached: true,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (options.input) {
    child.stdin.end(options.input);
  } else {
    child.stdin.end();
  }

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        // The process may have already exited.
      }
    }, options.timeoutMs ?? 5000);

    child.on("close", (exitCode, signal) => {
      clearTimeout(timeout);
      const result = {
        command: [command, ...args],
        cwd,
        detached: true,
        env,
        exitCode,
        signal,
        stderr,
        stdout,
      };
      recordCommandInvocation(result, { stateDir: workspace.stateDir });
      result.diagnostics = buildCommandDiagnostics(result, workspace);
      resolve(result);
    });
  });
}

export const runScript = Object.freeze(async function runScript(workspace, relativeScript, options = {}) {
  const script = path.join(workspace.repoDir, relativeScript);
  return runProcess(workspace, script, options.args ?? [], options);
});

export const runNodeEntrypoint = Object.freeze(async function runNodeEntrypoint(workspace, relativeScript, options = {}) {
  const script = path.join(workspace.repoDir, relativeScript);
  return runProcess(workspace, process.execPath, [script, ...(options.args ?? [])], options);
});

export const runnerInternals = Object.freeze({
  FORBIDDEN_WORKSPACE_ARTIFACTS,
});
