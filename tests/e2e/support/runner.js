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
  ".claude",
  ".codex",
];

const FIXTURE_TOOLS = new Set([
  "claude",
  "codex",
  "curl",
  "jq",
  "npm",
  "npx",
  "pgrep",
  "pkill",
  "ps",
  "security",
  "sleep",
  "tmux",
  "whisper",
  "zsh",
]);
const HOST_WRAPPERS = new Map([
  ["basename", "/usr/bin/basename"],
  ["cat", "/bin/cat"],
  ["chmod", "/bin/chmod"],
  ["cut", "/usr/bin/cut"],
  ["date", "/bin/date"],
  ["dirname", "/usr/bin/dirname"],
  ["grep", null],
  ["head", "/usr/bin/head"],
  ["ls", "/bin/ls"],
  ["mkdir", "/bin/mkdir"],
  ["python3", null],
  ["sed", null],
  ["tr", "/usr/bin/tr"],
  ["wc", "/usr/bin/wc"],
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
    if (!fs.existsSync(source)) continue;
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
      curl: { requests: [], routes: [] },
      codex: { appServerInvocations: [], bridgeInvocations: [], protocolEvents: [], servers: {} },
      discord: {
        attachmentFetches: [],
        attachments: {},
        channelCacheGets: [],
        channelFetches: [],
        deliveredMessages: [],
        edits: [],
        failures: {},
        fetches: [],
        injectedMessages: [],
        logins: [],
        malformedRequests: [],
        messageFetches: [],
        messages: [],
        nicknamePatches: [],
        ready: [],
        reactions: [],
        restFailureUses: [],
        restFailures: [],
        restMessages: [],
        sends: [],
        typing: [],
        uploadFailures: [],
        uploads: [],
      },
      network: { blocked: [] },
      npm: { invocations: [] },
      npx: { invocations: [] },
      processes: [],
      registry: null,
      security: { credentials: {}, invocations: [] },
      tmux: { sessions: {} },
      whisper: { failures: {}, invocations: [], transcriptions: {} },
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
      curl: {
        requests: value?.fixtures?.curl?.requests || [],
        routes: value?.fixtures?.curl?.routes || [],
      },
      codex: {
        appServerInvocations: value?.fixtures?.codex?.appServerInvocations || [],
        bridgeInvocations: value?.fixtures?.codex?.bridgeInvocations || [],
        protocolEvents: value?.fixtures?.codex?.protocolEvents || [],
        servers: value?.fixtures?.codex?.servers || {},
      },
      discord: {
        ...base.fixtures.discord,
        ...(value?.fixtures?.discord || {}),
        attachmentFetches: value?.fixtures?.discord?.attachmentFetches || [],
        attachments: value?.fixtures?.discord?.attachments || {},
        channelCacheGets: value?.fixtures?.discord?.channelCacheGets || [],
        channelFetches: value?.fixtures?.discord?.channelFetches || [],
        deliveredMessages: value?.fixtures?.discord?.deliveredMessages || [],
        edits: value?.fixtures?.discord?.edits || [],
        fetches: value?.fixtures?.discord?.fetches || [],
        injectedMessages: value?.fixtures?.discord?.injectedMessages || [],
        logins: value?.fixtures?.discord?.logins || [],
        malformedRequests: value?.fixtures?.discord?.malformedRequests || [],
        messageFetches: value?.fixtures?.discord?.messageFetches || [],
        messages: value?.fixtures?.discord?.messages || [],
        nicknamePatches: value?.fixtures?.discord?.nicknamePatches || [],
        ready: value?.fixtures?.discord?.ready || [],
        reactions: value?.fixtures?.discord?.reactions || [],
        restFailureUses: value?.fixtures?.discord?.restFailureUses || [],
        restFailures: value?.fixtures?.discord?.restFailures || [],
        restMessages: value?.fixtures?.discord?.restMessages || [],
        sends: value?.fixtures?.discord?.sends || [],
        typing: value?.fixtures?.discord?.typing || [],
        uploadFailures: value?.fixtures?.discord?.uploadFailures || [],
        uploads: value?.fixtures?.discord?.uploads || [],
      },
      npm: { invocations: value?.fixtures?.npm?.invocations || [] },
      npx: { invocations: value?.fixtures?.npx?.invocations || [] },
      network: { blocked: value?.fixtures?.network?.blocked || [] },
      processes: value?.fixtures?.processes || [],
      security: {
        credentials: value?.fixtures?.security?.credentials || {},
        invocations: value?.fixtures?.security?.invocations || [],
      },
      tmux: { ...(value?.fixtures?.tmux || {}), sessions: value?.fixtures?.tmux?.sessions || {} },
      whisper: {
        failures: value?.fixtures?.whisper?.failures || {},
        invocations: value?.fixtures?.whisper?.invocations || [],
        transcriptions: value?.fixtures?.whisper?.transcriptions || {},
      },
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
  const quoted =
    /^cd '([\\s\\S]*)' && DISCORD_STATE_DIR='([\\s\\S]*?)'(?: CLAUDE_CONFIG_DIR='([\\s\\S]*?)')? claude ([\\s\\S]+)$/.exec(shellCommand);
  const unquoted = quoted ? null : /^cd ([^&]+) && DISCORD_STATE_DIR=([^\\s]+) claude ([\\s\\S]+)$/.exec(shellCommand);
  if (!quoted && !unquoted) {
    throw new Error(\`unsupported tmux launch command: \${shellCommand}\`);
  }
  const configDir = quoted ? quoted[3] : undefined;
  const env = { DISCORD_STATE_DIR: quoted ? quoted[2] : unquoted[2] };
  if (configDir) {
    env.CLAUDE_CONFIG_DIR = configDir;
  }
  const claudeArgs = (quoted ? quoted[4] : unquoted[3]).trim().split(/\\s+/);
  validateClaudeInvocation(claudeArgs, env);
  return {
    cwd: quoted ? quoted[1] : unquoted[1],
    env,
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
    "ROOT_BOT_APP_ID",
    "BOT_APP_ID",
    "BOT_DISPLAY_NAME",
    "CODEX_HOME",
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

function writeClaudeSession(pid, sessionId, configDir) {
  const home = process.env.HOME;
  const baseDir = configDir || (home ? path.join(home, ".claude") : null);
  if (!baseDir) {
    return;
  }
  const sessionsDir = path.join(baseDir, "sessions");
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
        : \`claude \${launch.claudeArgs.join(" ")} DISCORD_STATE_DIR='\${launch.env.DISCORD_STATE_DIR}'\${launch.env.CLAUDE_CONFIG_DIR ? \` CLAUDE_CONFIG_DIR='\${launch.env.CLAUDE_CONFIG_DIR}'\` : ""}\`;
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
      writeClaudeSession(pid, sessionId, launch.env.CLAUDE_CONFIG_DIR);
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
  const invocationEnv = { DISCORD_STATE_DIR: process.env.DISCORD_STATE_DIR };
  if (process.env.CLAUDE_CONFIG_DIR) {
    invocationEnv.CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR;
  }
  recordClaudeInvocation({
    args,
    cwd: process.cwd(),
    env: invocationEnv,
    pid: process.pid,
    sessionId,
  });
  writeClaudeSession(process.pid, sessionId, process.env.CLAUDE_CONFIG_DIR);
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

function runNpx() {
  updateState((state) => {
    state.fixtures.npx.invocations.push({
      args,
      cwd: process.cwd(),
      input: fs.readFileSync(0, "utf8"),
    });
    return state;
  });
  if (args.length === 2 && args[0] === "-y" && args[1] === "ccstatusline@latest") {
    console.log("ccstatusline fixture output");
    return;
  }
  console.error("npx fixture blocks unapproved package execution during E2E scenarios");
  process.exit(42);
}

function runWhisper() {
  const inputPath = args[0];
  const outputDirIndex = args.indexOf("--output_dir");
  const outputDir = outputDirIndex === -1 ? process.cwd() : args[outputDirIndex + 1];
  const inputName = path.basename(inputPath || "audio");
  const state = updateState((nextState) => {
    nextState.fixtures.whisper ||= { failures: {}, invocations: [], transcriptions: {} };
    nextState.fixtures.whisper.invocations.push({
      args,
      cwd: process.cwd(),
      inputExists: Boolean(inputPath && fs.existsSync(inputPath)),
    });
  });

  if (state.fixtures.whisper.failures?.transcribe) {
    console.error(state.fixtures.whisper.failures.transcribe);
    process.exit(3);
  }

  fs.mkdirSync(outputDir, { recursive: true });
  const transcript =
    state.fixtures.whisper.transcriptions?.[inputName] ||
    state.fixtures.whisper.transcriptions?.default ||
    "fixture transcript";
  fs.writeFileSync(
    path.join(outputDir, \`\${path.parse(inputName).name}.txt\`),
    \`\${transcript}\\n\`
  );
}

function readJsonForJq() {
  const expression = args.includes("-r") ? args[args.indexOf("-r") + 1] : args[0];
  const file = args.at(-1) !== expression && !String(args.at(-1)).startsWith("-") ? args.at(-1) : null;
  const input = file ? fs.readFileSync(file, "utf8") : fs.readFileSync(0, "utf8");
  return { expression, json: JSON.parse(input) };
}

function printJqValue(value) {
  if (value === undefined || value === null) return;
  if (typeof value === "object") {
    process.stdout.write(JSON.stringify(value) + "\\n");
  } else {
    process.stdout.write(String(value) + "\\n");
  }
}

function runJq() {
  let expression;
  let json;
  try {
    ({ expression, json } = readJsonForJq());
  } catch (error) {
    console.error(error.message);
    process.exit(4);
  }

  if (expression === ".context_window.used_percentage // empty") {
    printJqValue(json.context_window?.used_percentage);
    return;
  }
  if (expression === ".guild_id") {
    printJqValue(json.guild_id);
    return;
  }
  const poolMatch = /^\\.pool\\[\\] \\| select\\(\\.state_dir \\| endswith\\("([^"]+)"\\)\\) \\| \\.(app_id|id|assigned_to)$/.exec(
    expression,
  );
  if (poolMatch) {
    const [, suffix, field] = poolMatch;
    printJqValue(json.pool?.find((entry) => String(entry.state_dir || "").endsWith(suffix))?.[field]);
    return;
  }
  const projectTypeMatch = /^\\.projects\\["([^"]+)"\\]\\.type \\/\\/ "claude"$/.exec(expression);
  if (projectTypeMatch) {
    printJqValue(json.projects?.[projectTypeMatch[1]]?.type ?? "claude");
    return;
  }
  console.error("unsupported jq expression: " + expression);
  process.exit(2);
}

function parseCurlArgs() {
  let method = "GET";
  let explicitMethod = false;
  let url = null;
  const headers = {};
  let body = "";

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "-s" || arg === "-S" || arg === "-f" || arg === "-L") {
      continue;
    }
    if (arg === "-X" || arg === "--request") {
      method = String(args[++index] || "").toUpperCase();
      explicitMethod = true;
      continue;
    }
    if (arg === "-H" || arg === "--header") {
      const header = String(args[++index] || "");
      const colon = header.indexOf(":");
      if (colon !== -1) {
        headers[header.slice(0, colon)] = header.slice(colon + 1).trimStart();
      }
      continue;
    }
    if (arg === "-d" || arg === "--data" || arg === "--data-raw" || arg === "--data-binary") {
      const value = String(args[++index] || "");
      if (value === "@-") {
        body += fs.readFileSync(0, "utf8");
      } else if (value.startsWith("@")) {
        body += fs.readFileSync(value.slice(1), "utf8");
      } else {
        body += value;
      }
      if (!explicitMethod) {
        method = "POST";
      }
      continue;
    }
    if (arg.startsWith("http://") || arg.startsWith("https://")) {
      url = arg;
      continue;
    }
    console.error("unsupported curl argument: " + arg);
    process.exit(2);
  }

  if (!url) {
    console.error("curl fixture requires an HTTP(S) URL");
    process.exit(2);
  }
  const parsedUrl = new URL(url);
  return { body, headers, method, parsedUrl };
}

function routeMatches(route, request) {
  if (route.method && String(route.method).toUpperCase() !== request.method) return false;
  if (route.hostname && route.hostname !== request.parsedUrl.hostname) return false;
  if (route.path && route.path !== request.parsedUrl.pathname) return false;
  if (route.url && route.url !== request.parsedUrl.href) return false;
  return true;
}

function runCurl() {
  const request = parseCurlArgs();
  const state = readState();
  const route = (state.fixtures.curl.routes || []).find((candidate) => routeMatches(candidate, request));
  const isDiscordNicknamePatch =
    request.method === "PATCH" &&
    request.parsedUrl.hostname === "discord.com" &&
    /^\\/api\\/v10\\/guilds\\/[^/]+\\/members\\/[^/]+$/.test(request.parsedUrl.pathname);
  const recordedRequest = {
    body: request.body,
    headers: request.headers,
    hostname: request.parsedUrl.hostname,
    method: request.method,
    path: request.parsedUrl.pathname,
    query: request.parsedUrl.search,
    url: request.parsedUrl.href,
  };
  updateState((nextState) => {
    nextState.fixtures.curl.requests.push(recordedRequest);
    return nextState;
  });

  if (!route) {
    updateState((nextState) => {
      nextState.fixtures.network.blocked.push({
        kind: "curl",
        target: request.parsedUrl.href,
      });
      return nextState;
    });
    console.error("blocked unapproved curl target: " + request.parsedUrl.href);
    process.exit(43);
  }

  if (isDiscordNicknamePatch) {
    updateState((nextState) => {
      nextState.fixtures.discord.nicknamePatches.push({
        ...recordedRequest,
        exitCode: route.exitCode ?? 0,
      });
      return nextState;
    });
  }

  if (route.stderr) {
    process.stderr.write(String(route.stderr));
  }
  if (route.json !== undefined) {
    process.stdout.write(JSON.stringify(route.json));
  } else if (route.body !== undefined) {
    process.stdout.write(String(route.body));
  }
  process.exit(route.exitCode ?? 0);
}

function runSecurity() {
  if (args[0] !== "find-generic-password" || args[1] !== "-s" || !args[2] || args[3] !== "-w" || args.length !== 4) {
    console.error("unsupported security invocation");
    process.exit(2);
  }
  const service = args[2];
  const state = readState();
  updateState((nextState) => {
    nextState.fixtures.security.invocations.push({ args, service });
    return nextState;
  });
  const credential = state.fixtures.security.credentials?.[service];
  if (!credential) {
    process.exit(44);
  }
  process.stdout.write(JSON.stringify(credential));
}

function runCodex() {
  const listenIndex = args.indexOf("--listen");
  if (args[0] !== "app-server" || listenIndex === -1 || !args[listenIndex + 1]) {
    console.error("unsupported codex invocation");
    process.exit(2);
  }
  const listen = args[listenIndex + 1];
  const prefix = "ws://127.0.0.1:";
  if (!listen.startsWith(prefix) || !/^[0-9]+$/.test(listen.slice(prefix.length))) {
    console.error(\`unsupported codex app-server listen URL: \${listen}\`);
    process.exit(2);
  }
  const port = listen.slice(prefix.length);
  const state = readState();
  updateState((nextState) => {
    nextState.fixtures.codex.appServerInvocations.push({
      args,
      cwd: process.cwd(),
      env: { WS_PORT: process.env.WS_PORT },
      pid: process.pid,
      port,
    });
    return nextState;
  });
  const server = state.fixtures.codex.servers?.[port];
  if (!server?.ready) {
    console.error(\`no fake Codex app-server registered for port \${port}\`);
    process.exit(43);
  }
  if (server.exitImmediately) {
    process.exit(server.exitCode ?? 1);
  }
  process.on("SIGTERM", () => process.exit(0));
  process.on("SIGINT", () => process.exit(0));
  setInterval(() => {}, 1000);
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
  case "codex":
    runCodex();
    break;
  case "curl":
    runCurl();
    break;
  case "npm":
    runNpm();
    break;
  case "npx":
    runNpx();
    break;
  case "jq":
    runJq();
    break;
  case "security":
    runSecurity();
    break;
  case "whisper":
    runWhisper();
    break;
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

function processGroupExists(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessGroupExit(pid, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processGroupExists(pid)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !processGroupExists(pid);
}

async function terminateProcessGroup(pid, timeoutMs = 5000) {
  if (!Number.isInteger(pid)) {
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    // The process group may already be gone.
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // The process may already be gone.
  }
  if (await waitForProcessGroupExit(pid, timeoutMs)) {
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // The process group may already be gone.
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // The process may already be gone.
  }
  await waitForProcessGroupExit(pid, 1000);
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

  registerTeardownCallback(async () => {
    try {
      const state = readState(stateDir);
      for (const row of state.fixtures.processes ?? []) {
        if (row?.owned === true && row.ownerStateDir === stateDir && Number.isInteger(row.pid)) {
          await terminateProcessGroup(row.pid, 5000);
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
  registerTeardownCallback(async () => {
    await terminateProcessGroup(child.pid, 5000);
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
