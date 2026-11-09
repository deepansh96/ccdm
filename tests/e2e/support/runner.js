import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { assertIsolatedPath, buildCommandDiagnostics } from "./diagnostics.js";
import { fixtureLauncher, gitBashTool, hookShell, interpreterFor, PYTHON } from "./platform.js";
import { readState, recordCommandInvocation, writeState } from "./state.js";
import { createWorkspaceJob, registerTeardownCallback, workspaceOwnsPid } from "./teardown.js";

// Deadlines are upper bounds that a passing test never waits out, so they
// scale with load: parallel files on a busy machine run slower than one file
// on an idle one. CCDM_E2E_TIMEOUT_SCALE overrides the default factor.
export const TIMEOUT_SCALE = Number(process.env.CCDM_E2E_TIMEOUT_SCALE) || 4;
export function scaledTimeout(ms) {
  return ms * TIMEOUT_SCALE;
}

const WIN = process.platform === "win32";

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
  "launchctl",
  "npm",
  "npx",
  "pgrep",
  "pkill",
  "ps",
  "schtasks",
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
  ["mv", "/bin/mv"],
  ["python3", null],
  ["sed", null],
  ["tr", "/usr/bin/tr"],
  ["wc", "/usr/bin/wc"],
  // On Windows the production resolver looks for `py` and `python`, never `python3`.
  ...(WIN ? [["python", null]] : []),
]);

function sourceRoot() {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: process.cwd(),
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || "Unable to resolve git root");
  }
  return result.stdout.trim();
}

function gitSourceFiles(root) {
  const result = spawnSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: root,
    encoding: "buffer",
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(result.stderr.toString("utf8") || "Unable to list source files");
  }
  return result.stdout.toString("utf8").split("\0").filter(Boolean);
}

function rejectForbiddenSourceArtifacts(files) {
  const forbidden = files.filter((file) =>
    FORBIDDEN_WORKSPACE_ARTIFACTS.some((artifact) => file === artifact || file.startsWith(`${artifact}/`)),
  );
  if (forbidden.length > 0) {
    throw new Error(`Local-only artifacts are not allowed in E2E workspaces: ${forbidden.join(", ")}`);
  }
}

function copySourceFiles(root, repoDir, files) {
  for (const file of files) {
    const source = path.join(root, file);
    if (!fs.existsSync(source)) continue;
    const destination = path.join(repoDir, file);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const { mode } = fs.statSync(source);
    // A hard link shares the source's XProtect scan; a fresh copy of an
    // executable is scanned again on its first exec, which serializes
    // parallel test files. Workspaces only add, replace, or remove files.
    if (mode & 0o111) {
      try {
        fs.linkSync(source, destination);
        continue;
      } catch { /* Fall back to a copy, e.g. across volumes. */ }
    }
    fs.copyFileSync(source, destination);
    fs.chmodSync(destination, mode);
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
  if (name === "python3" || name === "python") {
    const python = spawnSync(PYTHON, ["-c", "import sys; print(sys.executable)"], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (python.status === 0 && python.stdout.trim()) {
      return python.stdout.trim();
    }
  }
  if (WIN) {
    return gitBashTool(name);
  }
  const result = spawnSync("/bin/sh", ["-lc", `command -v ${name}`], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) {
    return null;
  }
  return result.stdout.trim() || null;
}

// The shell and flags Claude Code runs a hook command with on this OS: Git Bash
// on Windows, or PowerShell when Git is absent.
function fixtureHookShell() {
  if (!WIN) return [hookShell(), "-c"];
  const bash = gitBashTool("bash");
  if (bash) return [bash, "-c"];
  const windowsDir = process.env.SystemRoot || "C:\\Windows";
  return [path.join(windowsDir, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), "-NoProfile", "-Command"];
}

function createFixtureRuntime(fixtureDir) {
  const runtime = path.join(fixtureDir, "fixture-runtime.cjs");
  fs.copyFileSync(new URL("./state-lock.cjs", import.meta.url), path.join(fixtureDir, "state-lock.cjs"));
  fs.copyFileSync(new URL("./session-fixture.js", import.meta.url), path.join(fixtureDir, "session-fixture.mjs"));
  writeExecutable(
    runtime,
    `#!/usr/bin/env node
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const { replaceStateFile, withStateLock } = require("./state-lock.cjs");

const tool = process.argv[2];
const args = process.argv.slice(3);
const stateDir = process.env.CCDM_TEST_STATE;

if (!stateDir) {
  console.error("CCDM_TEST_STATE is required");
  process.exit(64);
}

const stateFile = path.join(stateDir, "state.json");

// Teardown signals a recorded PID only when its command line holds this path.
const workspaceMarker = path.dirname(stateDir);

// The shell Claude Code runs hook commands with on this OS.
const HOOK_SHELL = ${JSON.stringify(fixtureHookShell())};

function initialState() {
  return {
    schemaVersion: 1,
    commands: [],
    diagnostics: { cleanupFailures: [], logs: [], protectedPathViolations: [] },
    fixtures: {
      claude: { invocations: [] },
      curl: { requests: [], routes: [] },
      codex: { appServerInvocations: [], bridgeInvocations: [], protocolEvents: [], servers: {}, stdioInvocations: [] },
      discord: {
        attachmentFetches: [],
        attachments: {},
        channelCacheGets: [],
        channelFetches: [],
        channelListFailures: 0,
        channels: [],
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
        inviteDeleteFailures: [],
        inviteDeletes: [],
        inviteTargetJobFetches: [],
        inviteTargetJobStatus: 2,
        invites: [],
        memberRolePut404UserIds: [],
        memberRoleDeletes: [],
        memberRolePuts: [],
        permissionOverwrites: [],
        roleCreates: [],
        roles: [],
        sends: [],
        typing: [],
        uploadFailures: [],
        uploads: [],
      },
      network: { blocked: [] },
      launchctl: { invocations: [], loaded: [], loadFailuresRemaining: 0, unloadFailuresRemaining: 0 },
      schtasks: { definitions: {}, failures: {}, invocations: [], running: {}, tasks: [] },
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
      claude: { ...(value?.fixtures?.claude || {}), invocations: value?.fixtures?.claude?.invocations || [] },
      curl: {
        requests: value?.fixtures?.curl?.requests || [],
        routes: value?.fixtures?.curl?.routes || [],
      },
      codex: {
        appServerInvocations: value?.fixtures?.codex?.appServerInvocations || [],
        bridgeInvocations: value?.fixtures?.codex?.bridgeInvocations || [],
        protocolEvents: value?.fixtures?.codex?.protocolEvents || [],
        servers: value?.fixtures?.codex?.servers || {},
        stdioInvocations: value?.fixtures?.codex?.stdioInvocations || [],
      },
      discord: {
        ...base.fixtures.discord,
        ...(value?.fixtures?.discord || {}),
        attachmentFetches: value?.fixtures?.discord?.attachmentFetches || [],
        attachments: value?.fixtures?.discord?.attachments || {},
        channelCacheGets: value?.fixtures?.discord?.channelCacheGets || [],
        channelFetches: value?.fixtures?.discord?.channelFetches || [],
        channelListFailures: value?.fixtures?.discord?.channelListFailures || 0,
        channels: value?.fixtures?.discord?.channels || [],
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
        inviteDeleteFailures: value?.fixtures?.discord?.inviteDeleteFailures || [],
        inviteDeletes: value?.fixtures?.discord?.inviteDeletes || [],
        inviteTargetJobFetches: value?.fixtures?.discord?.inviteTargetJobFetches || [],
        inviteTargetJobStatus: value?.fixtures?.discord?.inviteTargetJobStatus ?? 2,
        invites: value?.fixtures?.discord?.invites || [],
        memberRolePut404UserIds: value?.fixtures?.discord?.memberRolePut404UserIds || [],
        memberRoleDeletes: value?.fixtures?.discord?.memberRoleDeletes || [],
        memberRolePuts: value?.fixtures?.discord?.memberRolePuts || [],
        permissionOverwrites: value?.fixtures?.discord?.permissionOverwrites || [],
        roleCreates: value?.fixtures?.discord?.roleCreates || [],
        roles: value?.fixtures?.discord?.roles || [],
        sends: value?.fixtures?.discord?.sends || [],
        typing: value?.fixtures?.discord?.typing || [],
        uploadFailures: value?.fixtures?.discord?.uploadFailures || [],
        uploads: value?.fixtures?.discord?.uploads || [],
      },
      npm: { invocations: value?.fixtures?.npm?.invocations || [] },
      npx: { invocations: value?.fixtures?.npx?.invocations || [] },
      network: { blocked: value?.fixtures?.network?.blocked || [] },
      launchctl: {
        invocations: value?.fixtures?.launchctl?.invocations || [],
        loaded: value?.fixtures?.launchctl?.loaded || [],
        loadFailuresRemaining: value?.fixtures?.launchctl?.loadFailuresRemaining || 0,
        unloadFailuresRemaining: value?.fixtures?.launchctl?.unloadFailuresRemaining || 0,
      },
      processes: value?.fixtures?.processes || [],
      schtasks: {
        definitions: value?.fixtures?.schtasks?.definitions || {},
        failures: value?.fixtures?.schtasks?.failures || {},
        invocations: value?.fixtures?.schtasks?.invocations || [],
        running: value?.fixtures?.schtasks?.running || {},
        tasks: value?.fixtures?.schtasks?.tasks || [],
      },
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
  replaceStateFile(tmp, stateFile);
}

function updateState(updater) {
  withStateLock(stateDir, () => {
    const current = readState();
    writeState(updater(current) || current);
  });
  return readState();
}

function normalizeSessionTarget(value) {
  return String(value || "").replace(/^=/, "").replace(/:.*$/, "");
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
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", workspaceMarker], {
    detached: true,
    env: {
      CCDM_FIXTURE_PLACEHOLDER: "1",
      CCDM_TEST_STATE: stateDir,
    },
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  return child.pid;
}

function parseClaudeLaunch(shellCommand) {
  const quoted =
    /^cd '([\\s\\S]*)' && ([\\s\\S]*?) claude ([\\s\\S]+)$/.exec(shellCommand);
  if (!quoted) {
    throw new Error(\`unsupported tmux launch command: \${shellCommand}\`);
  }
  const env = {};
  const envRe = /([A-Z_]+)=(?:'([^']*)'|([^\\s]+))/g;
  for (const match of quoted[2].matchAll(envRe)) env[match[1]] = match[2] ?? match[3];
  const claudeArgs = quoted[3].trim().split(/\\s+/);
  validateClaudeInvocation(claudeArgs, env);
  return {
    cwd: quoted[1],
    env,
    claudeArgs,
  };
}

// A quoted launch-string value, as the shell would read it.
function unescapeSingleQuotes(value) {
  return value === undefined ? undefined : value.replace(/'\\\\''/g, "'");
}

function parseCodexBridgeLaunch(shellCommand) {
  const match = /^cd '((?:[^']|'\\\\'')*)' && ([\\s\\S]+) node scripts\\/codex-bridge\\.js$/.exec(shellCommand);
  if (!match) {
    throw new Error(\`unsupported tmux launch command: \${shellCommand}\`);
  }
  const env = {};
  const envText = match[2];
  const envRe = /([A-Z_]+)=(?:'((?:[^']|'\\\\'')*)'|([^\\s]+))/g;
  for (const envMatch of envText.matchAll(envRe)) {
    env[envMatch[1]] = unescapeSingleQuotes(envMatch[2]) ?? envMatch[3];
  }
  // Every Codex launch is a Router launch: it carries the launch key file path
  // instead of any bot identity; root's names no project.
  const required = [
    "CCDM_ROUTER_KEY_FILE",
    env.CCDM_ROUTER_ROLE === "root" ? "CCDM_ROUTER_ROLE" : "CCDM_CODEX_PROJECT",
    "CCDM_ROUTER_STATE_DIR", "CHANNEL_ID", "PROJECT_DIR", "WS_PORT", "ALLOWED_USER_IDS", "CODEX_HOME",
  ];
  for (const name of required) {
    if (!env[name]) {
      throw new Error(\`\${name} is required for Codex bridge launch\`);
    }
  }
  return {
    cwd: unescapeSingleQuotes(match[1]),
    env,
    bridgeCommand: "node scripts/codex-bridge.js",
  };
}

// An ad-hoc launch, such as a login: the seam's quoted form of any other program.
function parseGenericLaunch(shellCommand) {
  const match = /^cd '((?:[^']|'\\'')*)' && ((?:[A-Za-z_][A-Za-z0-9_]*='(?:[^']|'\\'')*' )*)(.+)$/.exec(shellCommand);
  if (!match) {
    throw new Error(\`unsupported tmux launch command: \${shellCommand}\`);
  }
  const env = {};
  for (const envMatch of match[2].matchAll(/([A-Za-z_][A-Za-z0-9_]*)='((?:[^']|'\\'')*)'/g)) {
    env[envMatch[1]] = unescapeSingleQuotes(envMatch[2]);
  }
  const argv = match[3].match(/'(?:[^']|'\\'')*'|[^\s]+/g)
    .map(word => (word.startsWith("'") ? unescapeSingleQuotes(word.slice(1, -1)) : word));
  return { cwd: unescapeSingleQuotes(match[1]), env, argv };
}

function parseTmuxLaunch(shellCommand) {
  if (shellCommand.endsWith(" node scripts/codex-bridge.js")) {
    return { kind: "codex-bridge", ...parseCodexBridgeLaunch(shellCommand) };
  }
  if (!shellCommand.includes("server:ccdm")) {
    return { kind: "generic", ...parseGenericLaunch(shellCommand) };
  }
  return { kind: "claude-listener", ...parseClaudeLaunch(shellCommand) };
}

// Every Claude launch is a Router launch: the CCDM channel and a launch key
// file path, never the official Discord plugin or a bot state directory.
function validateClaudeInvocation(claudeArgs, env) {
  const developmentIndex = claudeArgs.indexOf("--dangerously-load-development-channels");
  if (developmentIndex === -1 || claudeArgs[developmentIndex + 1] !== "server:ccdm" || claudeArgs.includes("--channels")) {
    throw new Error("claude listener must use the CCDM channel");
  }
  if (!claudeArgs.includes("--dangerously-skip-permissions")) {
    throw new Error("claude listener must use --dangerously-skip-permissions");
  }
  if (!env.CCDM_ROUTER_KEY_FILE || env.DISCORD_STATE_DIR) {
    throw new Error("CCDM_ROUTER_KEY_FILE, and no DISCORD_STATE_DIR, is required for claude listener");
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

const DEV_CHANNEL_PROMPT = "WARNING: Loading development channels\\n\\n--dangerously-load-development-channels is for local channel development only.\\n\\n❯ 1. I am using this for local development\\n  2. Exit\\n";

// The fake claude for a CCDM channel launch, detached like a tmux pane process.
function spawnRouterClaude(name, launch) {
  // Through the workspace's link to this file: __filename is in the shared
  // fixture directory, which holds no workspace path.
  const runtime = path.join(workspaceMarker, "fixtures", path.basename(__filename));
  const child = spawn(process.execPath, [runtime, "claude", ...launch.claudeArgs], {
    cwd: launch.cwd,
    detached: true,
    env: { ...process.env, ...launch.env, CCDM_FIXTURE_TMUX_SESSION: name },
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  return child.pid;
}

// A router Codex launch runs the real bridge, detached like a tmux pane
// process, against the fake Codex app-server registered for its port.
function spawnRouterBridge(launch) {
  const logFile = fs.openSync(path.join(stateDir, \`codex-bridge-\${Date.now()}.log\`), "a");
  const child = spawn(process.execPath, [path.join(launch.cwd, "scripts/codex-bridge.js"), ...(launch.bridgeArgs ?? []), workspaceMarker], {
    cwd: launch.cwd,
    detached: true,
    // A tmux fixture has no stdin to hold open, so this bridge gets NUL and stops
    // only when killed. On Windows PATH alone cannot name the fixture Codex.
    env: {
      ...process.env,
      ...launch.env,
      ...(process.platform === "win32" ? { CCDM_CODEX_PATH: path.join(workspaceMarker, "fixtures", "codex.exe") } : {}),
    },
    stdio: ["ignore", logFile, logFile],
    windowsHide: true,
  });
  fs.closeSync(logFile);
  child.unref();
  return child.pid;
}

function unquote(value) {
  return String(value || "").replace(/^'([\\s\\S]*)'$/, "$1");
}

// A fake claude that speaks MCP stdio to its "ccdm" server: it waits for the
// development-channel confirmation, initializes the server, records every
// channel notification, and calls the reply tool when a test scripts
// \`fixtures.claude.replyText\`. Like Claude, it runs the command hooks from
// \`--settings\`: SessionStart once the server is up, and Stop after each
// notification's tool calls finish (or, in a held thread, once released).
function runRouterClaudeHost() {
  const sessionName = process.env.CCDM_FIXTURE_TMUX_SESSION;
  const record = (field, value) => updateState((state) => {
    state.fixtures.claude[field] = [...(state.fixtures.claude[field] || []), value];
    return state;
  });
  // \`fixtures.claude.holdHellosIn\` keeps a thread's channel server (and so its
  // Router hello) from starting until the thread's id leaves the list.
  const heldThread = String(process.env.CCDM_ROUTER_KEY_FILE || "").match(/\\.thread-([^/]+)\\.key$/)?.[1];
  // new-session starts this process before it records the session, so a session
  // that is missing is only gone once it has been seen. The limit ends the wait
  // when new-session failed after starting it.
  const recordedWithinMs = 30000;
  const waitingSince = Date.now();
  let sessionSeen = false;
  const waitForAccept = setInterval(() => {
    const state = readState();
    const session = state.fixtures.tmux.sessions[sessionName];
    if (!session) {
      if (sessionSeen || Date.now() - waitingSince > recordedWithinMs) process.exit(0);
      return;
    }
    sessionSeen = true;
    if (session.devChannelPrompt !== "accepted") return;
    if (heldThread && (state.fixtures.claude.holdHellosIn || []).includes(heldThread)) return;
    clearInterval(waitForAccept);
    startServer();
  }, 50);

  const sessionId = \`fixture-session-\${process.pid}\`;
  let hooks = {};
  try {
    hooks = JSON.parse(fs.readFileSync(unquote(args[args.indexOf("--settings") + 1]), "utf8")).hooks || {};
  } catch {
    // No settings, no hooks.
  }
  const hookEnv = { ...process.env, PATH: \`\${path.dirname(process.execPath)}\${path.delimiter}\${process.env.PATH || ""}\` };
  async function runHooks(event, fields = {}) {
    const input = JSON.stringify({ hook_event_name: event, session_id: sessionId, ...fields });
    for (const hook of (hooks[event] || []).flatMap((group) => group.hooks || [])) {
      if (hook.type !== "command") continue;
      const exitCode = await new Promise((done) => {
        const child = spawn(HOOK_SHELL[0], [...HOOK_SHELL.slice(1), hook.command], { env: hookEnv, stdio: ["pipe", "ignore", "ignore"], windowsHide: true });
        child.on("exit", done);
        child.stdin.end(input);
      });
      record("hookRuns", { event, exitCode });
    }
  }

  function startServer() {
    const configPath = unquote(args[args.indexOf("--mcp-config") + 1]);
    const server = JSON.parse(fs.readFileSync(configPath, "utf8")).mcpServers.ccdm;
    const command = server.command === "node" ? process.execPath : server.command;
    const serverEnv = { ...process.env, ...(server.env || {}) };
    // Both process environments, so tests can grep them for credentials.
    record("sessionEnvironments", { process: "claude", env: process.env });
    record("sessionEnvironments", { process: "ccdm", env: serverEnv });
    const child = spawn(command, server.args || [], {
      env: serverEnv,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const logFile = path.join(stateDir, \`claude-channel-\${process.pid}.log\`);
    child.stderr.on("data", (chunk) => fs.appendFileSync(logFile, chunk));
    const stop = () => { child.kill("SIGTERM"); process.exit(0); };
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
    child.on("exit", () => record("channelServerExits", { pid: child.pid }));
    let nextId = 1;
    const write = (message) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
    const call = (method, params) => { const id = nextId++; write({ id, method, params }); return id; };
    const toolCalls = new Map();
    // \`fixtures.claude.toolScript\` runs its tool calls in order for each
    // notification. String arguments expand {{chat_id}} and {{message_id}} from
    // the notification and {{last_id}} from the previous result's "(id: X)".
    async function runToolScript(steps, meta) {
      let lastId = "";
      const expand = (value) => typeof value === "string"
        ? value.replace(/\\{\\{(chat_id|message_id|last_id)\\}\\}/g, (_, key) => key === "last_id" ? lastId : meta[key])
        : Array.isArray(value) ? value.map(expand) : value;
      for (const step of steps) {
        const input = Object.fromEntries(Object.entries(step.arguments || {}).map(([key, value]) => [key, expand(value)]));
        const result = await new Promise((done) => {
          toolCalls.set(call("tools/call", { name: step.name, arguments: input }), { name: step.name, done });
        });
        lastId = /\\(id: ([^)]+)\\)/.exec(result?.content?.[0]?.text || "")?.[1] || lastId;
      }
    }
    // One turn at a time: each notification's tool calls, then the Stop hook.
    let turns = runHooks("SessionStart", { source: "startup" });
    let toolsListId = null;
    const initializeId = call("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "claude-fixture", version: "1" } });
    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        const message = JSON.parse(line);
        if (message.id === initializeId) {
          record("channelServers", { serverInfo: message.result.serverInfo, capabilities: message.result.capabilities });
          write({ method: "notifications/initialized" });
          toolsListId = call("tools/list", {});
        } else if (message.id === toolsListId) {
          // Each server's tools, by the thread it serves (null for a channel).
          record("toolLists", { threadId: serverEnv.CCDM_THREAD_ID || null,
            tools: (message.result?.tools || []).map((tool) => tool.name) });
        } else if (message.method === "notifications/claude/channel") {
          record("channelNotifications", message.params);
          const { replyText, toolScript } = readState().fixtures.claude;
          const { meta } = message.params;
          turns = turns.then(async () => {
            if (replyText) {
              await new Promise((done) => {
                toolCalls.set(call("tools/call", { name: "reply", arguments: { chat_id: meta.chat_id, text: replyText } }), { name: "reply", done });
              });
            }
            if (toolScript) await runToolScript(toolScript, meta);
            // \`fixtures.claude.holdTurnsIn\` keeps a thread's turns running until its id leaves the list.
            while ((readState().fixtures.claude.holdTurnsIn || []).includes(serverEnv.CCDM_THREAD_ID)) {
              await new Promise((done) => setTimeout(done, 50));
            }
            await runHooks("Stop", { stop_hook_active: false, background_tasks: [], session_crons: [] });
          });
        } else if (toolCalls.has(message.id)) {
          const pending = toolCalls.get(message.id);
          toolCalls.delete(message.id);
          record("toolResults", { name: pending.name, result: message.result, error: message.error });
          pending.done?.(message.result);
        }
      }
    });
  }
}

// tmux and the fake ccdm-host are the two fronts of one session model:
// tests/e2e/support/session-fixture.js, copied beside this file.
async function sessionFixture() {
  const { createSessionFixture } = await import("./session-fixture.mjs");
  return createSessionFixture({
    DEV_CHANNEL_PROMPT, isAlive, normalizeSessionTarget, parseTmuxLaunch, readState,
    recordClaudeInvocation, recordCodexBridgeInvocation, spawnPlaceholder, spawnRouterBridge, spawnRouterClaude,
    stateDir, unquote, updateState, writeClaudeSession,
  });
}

function fixtureFailure(error) {
  console.error(error);
  process.exit(1);
}

function runTmux() {
  sessionFixture().then((fixture) => fixture.runTmux(args)).catch(fixtureFailure);
}

function runFakeHost() {
  sessionFixture().then((fixture) => fixture.runFakeHost()).catch(fixtureFailure);
}

function runPs() {
  if (args.join(" ") === "-axo pid=,ppid=") {
    for (const row of reportableProcesses(readState())) {
      process.stdout.write(\`\${String(row.pid).padStart(5, " ")} \${String(row.ppid).padStart(5, " ")}\\n\`);
    }
    return;
  }
  if (args.join(" ") !== "axeww -o pid=,command=") {
    console.error("unsupported ps invocation");
    process.exit(2);
  }
  const rows = reportableProcesses(readState());
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
  const rows = reportableProcesses(readState()).filter((row) => row.ppid === parentPid);
  for (const row of rows) {
    process.stdout.write(\`\${row.pid}\\n\`);
  }
  process.exit(rows.length > 0 ? 0 : 1);
}

// PID to command line, for those of \`pids\` still running.
function commandLinesOf(pids) {
  const found = new Map();
  if (process.platform === "win32" && pids.length > 0) {
    const powershell = path.join(process.env.SystemRoot || "C:\\\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const filter = pids.map((pid) => \`ProcessId=\${pid}\`).join(" OR ");
    const script = \`[Console]::OutputEncoding=[Text.Encoding]::UTF8;Get-CimInstance Win32_Process -Filter '\${filter}' | ForEach-Object { [string]$_.ProcessId + ' ' + $_.CommandLine }\`;
    // PowerShell has no module cache under a workspace's empty profile, and on a
    // CI runner that first start alone can take more than 15 seconds.
    const result = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", timeout: 60000, windowsHide: true });
    for (const line of String(result.stdout || "").split(/\\r?\\n/)) {
      const match = /^(\\d+) (.*)$/.exec(line);
      if (match) found.set(Number(match[1]), match[2]);
    }
    return found;
  }
  const ps = fs.existsSync("/bin/ps") ? "/bin/ps" : "ps";
  for (const pid of pids) {
    const result = spawnSync(ps, ["-ww", "-o", "command=", "-p", String(pid)], { encoding: "utf8", timeout: 15000, windowsHide: true });
    if (result.status === 0) found.set(pid, result.stdout.trim());
  }
  return found;
}

// What \`ps\` and \`pgrep\` report, which production code goes on to signal. Windows
// reuses PIDs quickly, so there a row must also still hold this workspace's path.
function reportableProcesses(state) {
  const rows = activeOwnedProcesses(state);
  if (process.platform !== "win32") return rows;
  const commandLines = commandLinesOf(rows.map((row) => row.pid));
  return rows.filter((row) => commandLines.get(row.pid)?.includes(workspaceMarker));
}

function runPkill() {
  fs.appendFileSync(path.join(stateDir, "session-calls.ndjson"), \`\${JSON.stringify({ front: "pkill", args })}\\n\`);
  if (args[0] !== "-TERM" || args[1] !== "-P" || !args[2] || args.length !== 3) {
    console.error("unsupported pkill invocation");
    process.exit(2);
  }
  const parentPid = Number(args[2]);
  const rows = activeOwnedProcesses(readState()).filter((row) => row.ppid === parentPid);
  const commandLines = commandLinesOf(rows.map((row) => row.pid));
  let signalled = 0;
  for (const row of rows) {
    // A recorded PID may have been reused; signal only what holds this workspace's path.
    if (!commandLines.get(row.pid)?.includes(workspaceMarker)) {
      updateState((state) => {
        state.fixtures.pkillSkips = [...(state.fixtures.pkillSkips || []), { marker: workspaceMarker, pid: row.pid }];
        return state;
      });
      console.error(\`ccdm-fixture-pkill skipped pid \${row.pid}: its command line does not hold \${workspaceMarker}\`);
      continue;
    }
    try {
      process.kill(row.pid, "SIGTERM");
      signalled += 1;
    } catch {
      // The process may have already exited.
    }
  }
  process.exit(signalled > 0 ? 0 : 1);
}

function runClaude() {
  if (args.length === 1 && args[0] === "--version") {
    console.log(process.env.CCDM_FIXTURE_CLAUDE_VERSION || "Claude Code fixture 1.0.0");
    return;
  }
  try {
    validateClaudeInvocation(args, process.env);
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
  if (args.includes("server:ccdm")) {
    runRouterClaudeHost();
    return;
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
  if (route.headers && Object.entries(route.headers).some(([name, value]) => request.headers[name] !== value)) {
    return false;
  }
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

function runCodexStdio() {
  const state = readState();
  const responseFile = process.env.CCDM_TEST_CODEX_STDIO_RESPONSES;
  let responses = {};
  if (responseFile) {
    try {
      responses = JSON.parse(fs.readFileSync(responseFile, "utf8"));
    } catch (error) {
      console.error("invalid fake Codex stdio response file");
      process.exit(43);
    }
  }
  const home = process.env.CODEX_HOME || "";
  const configuredResponse = responses[home];
  updateState((nextState) => {
    nextState.fixtures.codex.stdioInvocations.push({
      args,
      cwd: process.cwd(),
      env: { CODEX_HOME: home },
      pid: process.pid,
    });
    return nextState;
  });
  const readline = require("node:readline");
  const input = readline.createInterface({ input: process.stdin });
  input.on("line", (line) => {
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      return;
    }
    if (request.method === "initialize") {
      const initializeResponse = JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {} });
      if (configuredResponse?.mode === "buffered") {
        process.stdout.write(
          initializeResponse + "\\n" + JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            result: configuredResponse.result,
          }) + "\\n",
        );
      } else {
        process.stdout.write(initializeResponse + "\\n");
      }
      return;
    }
    if (request.method !== "account/rateLimits/read") {
      return;
    }
    if (!configuredResponse || configuredResponse.mode === "error") {
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32000, message: "fixture rate limit failure" },
      }) + "\\n");
      return;
    }
    if (configuredResponse.mode === "malformed") {
      process.stdout.write("not-json\\n");
      return;
    }
    if (configuredResponse.mode === "non-object") {
      process.stdout.write("[]\\n");
      return;
    }
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: request.id,
      result: configuredResponse,
    }) + "\\n");
  });
  process.on("SIGTERM", () => process.exit(0));
  process.on("SIGINT", () => process.exit(0));
}

function runCodex() {
  if (args[0] === "app-server" && args.includes("--stdio")) {
    runCodexStdio();
    return;
  }
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
      startedAt: processModule().processStartTime(process.pid),
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
  // Fields on the server record, for tests of how this process was stopped.
  const markServer = (values) => updateState((nextState) => {
    Object.assign(nextState.fixtures.codex.servers[port], values(nextState.fixtures.codex.servers[port]));
    return nextState;
  });
  // A held port lets a test see that this process's sockets went with it. The
  // protocol server is the test's own and stays up throughout.
  if (server.heldPort) require("node:net").createServer().listen(server.heldPort, "127.0.0.1");
  const onSignal = (signal) => {
    if (!server.recordSignals) process.exit(0);
    markServer((record) => ({ signals: [...(record.signals || []), signal] }));
    setTimeout(() => process.exit(0), 300);
  };
  process.on("SIGTERM", () => onSignal("SIGTERM"));
  process.on("SIGINT", () => onSignal("SIGINT"));
  // For a test of teardown, which must also stop a fake that does not go by itself.
  if (server.outliveBridge) {
    setInterval(() => {}, 1000);
    return;
  }
  // Like a pane process, it goes when its bridge does, never left orphaned.
  watchBridge(() => {
    try {
      markServer(() => ({ watchdogFired: true }));
    } finally {
      // Teardown may already have removed the workspace; go regardless.
      process.exit(0);
    }
  });
}

function processModule() {
  return require(path.join(workspaceMarker, "repo", "scripts", "platform", "process.js"));
}

// The process that started \`pid\`, whether or not that one is still running.
function parentPidOf(pid) {
  const koffi = require("koffi");
  const HANDLE = koffi.pointer(koffi.opaque());
  const kernel32 = koffi.load("kernel32.dll");
  const OpenProcess = kernel32.func("__stdcall", "OpenProcess", HANDLE, ["uint32_t", "int", "uint32_t"]);
  const CloseHandle = kernel32.func("__stdcall", "CloseHandle", "int", [HANDLE]);
  const BasicInformation = koffi.struct({
    exitStatus: "uintptr_t", peb: "uintptr_t", affinity: "uintptr_t", priority: "uintptr_t", pid: "uintptr_t", parent: "uintptr_t",
  });
  const NtQueryInformationProcess = koffi.load("ntdll.dll").func("__stdcall", "NtQueryInformationProcess", "int32_t",
    [HANDLE, "int32_t", koffi.out(koffi.pointer(BasicInformation)), "uint32_t", koffi.pointer("uint32_t")]);
  const handle = OpenProcess(0x1000, 0, pid);
  if (!handle) return null;
  try {
    const information = {};
    const status = NtQueryInformationProcess(handle, 0, information, koffi.sizeof(BasicInformation), null);
    return status === 0 ? Number(information.parent) : null;
  } finally {
    CloseHandle(handle);
  }
}

// Calls \`onGone\` when the bridge that started this fake is gone. POSIX reparents
// an orphan, so its ppid changes. On Windows ppid never changes, and the parent
// is the fixture launcher, which lives as long as this process; the bridge is
// the launcher's parent. A PID can be reused, so it is paired with its start time.
function watchBridge(onGone) {
  if (process.platform !== "win32") {
    const parent = process.ppid;
    setInterval(() => {
      if (process.ppid !== parent) onGone();
    }, 500);
    return;
  }
  const { processStartTime } = processModule();
  const launcherStarted = processStartTime(process.ppid);
  const bridge = parentPidOf(process.ppid);
  const bridgeStarted = bridge === null ? null : processStartTime(bridge);
  // A process younger than the launcher took the dead bridge's PID.
  if (bridgeStarted === null || launcherStarted === null || BigInt(bridgeStarted) > BigInt(launcherStarted)) {
    onGone();
    return;
  }
  // The bridge runs as this user, so a start time that cannot be read means the
  // PID now belongs to something else; only an exact match counts as the bridge.
  setInterval(() => {
    if (processStartTime(bridge) !== bridgeStarted) onGone();
  }, 500);
}

// Task Scheduler for one workspace. \`/create\` keeps the XML; \`/run\` only records
// the call, because a task's process must outlive this launcher, so the test starts
// it; \`/query\` reports Running while the pid in \`running\` is alive.
function schtasksFlag(flag) {
  const at = args.findIndex((arg) => arg.toLowerCase() === flag);
  return at < 0 ? null : args[at + 1];
}

function runSchtasks() {
  const verb = (args[0] || "").toLowerCase();
  const name = schtasksFlag("/tn");
  const asXml = args.some((arg) => arg.toLowerCase() === "/xml");
  if (!name || !["/query", "/create", "/delete", "/run", "/end"].includes(verb)) {
    console.error("unsupported schtasks invocation");
    process.exit(2);
  }
  updateState((nextState) => {
    nextState.fixtures.schtasks.invocations.push({ name, verb, args });
    return nextState;
  });
  const state = readState().fixtures.schtasks;
  const failuresLeft = state.failures[verb] || 0;
  if (failuresLeft > 0) {
    updateState((nextState) => {
      nextState.fixtures.schtasks.failures[verb] = failuresLeft - 1;
      return nextState;
    });
    console.error("ERROR: The fixture was told to fail.");
    process.exit(1);
  }
  const known = state.tasks.includes(name);
  if (verb === "/query") {
    if (!known) process.exit(1);
    if (asXml) {
      process.stdout.write(state.definitions[name] || "");
    } else if ((schtasksFlag("/fo") || "").toLowerCase() === "csv") {
      const running = state.running[name];
      const status = running && isAlive(running) ? "Running" : "Ready";
      process.stdout.write(\`"\${name}","N/A","\${status}"\n\`);
    }
    process.exit(0);
  }
  if (verb === "/create") {
    const xmlFile = schtasksFlag("/xml");
    const xml = fs.readFileSync(xmlFile).toString("utf16le").replace(/^\\uFEFF/, "");
    updateState((nextState) => {
      const fixture = nextState.fixtures.schtasks;
      fixture.definitions[name] = xml;
      if (!fixture.tasks.includes(name)) fixture.tasks.push(name);
      return nextState;
    });
    process.exit(0);
  }
  if (verb === "/delete") {
    updateState((nextState) => {
      const fixture = nextState.fixtures.schtasks;
      fixture.tasks = fixture.tasks.filter((task) => task !== name);
      delete fixture.definitions[name];
      delete fixture.running[name];
      return nextState;
    });
    process.exit(known ? 0 : 1);
  }
  process.exit(known ? 0 : 1);
}

function runLaunchctl() {
  const operation = args[0];
  if (!["load", "unload", "list"].includes(operation)) {
    console.error("unsupported launchctl invocation");
    process.exit(2);
  }
  const target = args[1] || null;
  let failed = false;
  updateState((nextState) => {
    const launchctl = nextState.fixtures.launchctl;
    launchctl.invocations.push({ operation, target });
    if (operation === "load" && launchctl.loadFailuresRemaining > 0) {
      launchctl.loadFailuresRemaining -= 1;
      failed = true;
      return nextState;
    }
    if (operation === "unload" && launchctl.unloadFailuresRemaining > 0) {
      launchctl.unloadFailuresRemaining -= 1;
      failed = true;
      return nextState;
    }
    const label = target ? path.basename(target).replace(/\.plist$/, "") : null;
    if (operation === "load" && label && !launchctl.loaded.includes(label)) {
      launchctl.loaded.push(label);
    }
    if (operation === "unload" && label) {
      launchctl.loaded = launchctl.loaded.filter((entry) => entry !== label);
    }
    return nextState;
  });
  if (failed) {
    process.exit(1);
  }
  if (operation === "list") {
    if (!readState().fixtures.launchctl.loaded.includes(target)) {
      process.exit(1);
    }
    process.stdout.write("-\\t0\\t" + (target || "") + "\\n");
  }
}

switch (tool) {
  case "tmux":
    runTmux();
    break;
  case "ccdm-host-fake":
    runFakeHost();
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
  case "launchctl":
    runLaunchctl();
    break;
  case "schtasks":
    runSchtasks();
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

// The Windows form of a fixture tool: the launcher, and the .shim it reads to
// know what to start. One copy per tool, so hard links stay under NTFS's limit.
function createWindowsFixture(fixtureDir, launcher, name, shimLines) {
  fs.copyFileSync(launcher, path.join(fixtureDir, `${name}.exe`));
  fs.writeFileSync(path.join(fixtureDir, `${name}.shim`), `${shimLines.join("\n")}\n`);
}

function createFixtureBin(fixtureDir, runtime, name, launcher) {
  if (WIN) {
    createWindowsFixture(fixtureDir, launcher, name, [process.execPath, runtime, name]);
    return;
  }
  writeExecutable(
    path.join(fixtureDir, name),
    `#!/bin/sh
exec ${shellQuote(process.execPath)} ${shellQuote(runtime)} ${shellQuote(name)} "$@"
`,
  );
}

function createHostWrapper(fixtureDir, name, target, launcher) {
  // The table's POSIX paths mean nothing on Windows; it finds each tool itself.
  const resolvedTarget = WIN ? hostCommandPath(name) : target ?? hostCommandPath(name);
  if (!resolvedTarget || !fs.existsSync(resolvedTarget)) {
    return;
  }
  if (WIN) {
    createWindowsFixture(fixtureDir, launcher, name, [resolvedTarget]);
    return;
  }
  writeExecutable(
    path.join(fixtureDir, name),
    `#!/bin/sh
exec ${shellQuote(resolvedTarget)} "$@"
`,
  );
}

function buildFixtures(fixtureDir, runtimeDir, exclude, hostPaths) {
  fs.mkdirSync(fixtureDir, { recursive: true });
  createFixtureRuntime(fixtureDir);
  // Test-only seam: fails once the staging dir has content, on every OS.
  if (process.env.CCDM_E2E_FAIL_FIXTURE_BUILD === "1") {
    throw new Error("Forced fixture build failure");
  }
  const runtime = path.join(runtimeDir, "fixture-runtime.cjs");
  const launcher = WIN ? fixtureLauncher() : null;
  for (const tool of FIXTURE_TOOLS) {
    if (!exclude.has(tool)) {
      if (tool === "sleep" && WIN) {
        createWindowsFixture(fixtureDir, launcher, tool, [":noop"]);
      } else if (tool === "sleep") {
        const truePath = ["/usr/bin/true", "/bin/true"].find((candidate) => fs.existsSync(candidate));
        if (!truePath) {
          throw new Error("Unable to create sleep fixture: true binary not found");
        }
        fs.symlinkSync(truePath, path.join(fixtureDir, tool));
      } else {
        createFixtureBin(fixtureDir, runtime, tool, launcher);
      }
    }
  }
  for (const [name, target] of hostPaths) {
    if (!exclude.has(name)) {
      createHostWrapper(fixtureDir, name, target, launcher);
    }
  }
}

let hostPathsCache = null;
function resolvedHostPaths() {
  hostPathsCache ??= [...HOST_WRAPPERS].map(([name, target]) => [name, target ?? hostCommandPath(name)]);
  return hostPathsCache;
}

// macOS XProtect scans every newly written executable on its first exec, one
// file at a time, so fresh fixture binaries in every workspace queue parallel
// test files behind that scan. Build each distinct fixture set once, keyed by
// its content, and give each workspace a directory of links to it.
const sharedFixtureDirs = new Map();
function sharedFixtureDir(exclude) {
  const key = [...exclude].sort().join(",");
  if (sharedFixtureDirs.has(key)) return sharedFixtureDirs.get(key);
  const hostPaths = resolvedHostPaths();
  const digest = createHash("sha256")
    .update(fs.readFileSync(new URL(import.meta.url)))
    .update(fs.readFileSync(new URL("./state-lock.cjs", import.meta.url)))
    .update(fs.readFileSync(new URL("./session-fixture.js", import.meta.url)))
    .update(fs.readFileSync(new URL("./fixture-shim.cs", import.meta.url)))
    .update(JSON.stringify([process.execPath, key, hostPaths]))
    .digest("hex")
    .slice(0, 16);
  const dir = path.join(os.tmpdir(), `ccdm-e2e-fixtures-${digest}`);
  if (!fs.existsSync(path.join(dir, ".complete"))) {
    const staging = fs.mkdtempSync(`${dir}.staging-`);
    try {
      buildFixtures(staging, dir, exclude, hostPaths);
      fs.writeFileSync(path.join(staging, ".complete"), "");
    } catch (error) {
      fs.rmSync(staging, { recursive: true, force: true });
      throw error;
    }
    try {
      fs.renameSync(staging, dir);
    } catch (error) {
      // Another test file published the same set first.
      fs.rmSync(staging, { recursive: true, force: true });
      if (!fs.existsSync(path.join(dir, ".complete"))) throw error;
    }
  }
  sharedFixtureDirs.set(key, dir);
  return dir;
}

// Windows needs no developer rights for a hard link. A copy only when a file has
// reached NTFS's 1023 links (many kept workspaces).
function linkOrCopy(source, destination) {
  try {
    fs.linkSync(source, destination);
  } catch (error) {
    if (error.code !== "EMLINK") throw error;
    fs.copyFileSync(source, destination);
  }
}

function createFixtures(fixtureDir, options = {}) {
  const shared = sharedFixtureDir(new Set(options.excludeFixtures ?? []));
  fs.mkdirSync(fixtureDir, { recursive: true });
  for (const name of fs.readdirSync(shared)) {
    if (name === ".complete") continue;
    if (WIN) linkOrCopy(path.join(shared, name), path.join(fixtureDir, name));
    else fs.symlinkSync(path.join(shared, name), path.join(fixtureDir, name));
  }
}

function nodePath(root) {
  return path.join(root, "node_modules");
}

// Windows has no process groups, so there the group is the one process.
function processGroupExists(pid) {
  try {
    process.kill(process.platform === "win32" ? pid : -pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessGroupExit(pid, timeoutMs = 5000) {
  const deadline = Date.now() + scaledTimeout(timeoutMs);
  while (Date.now() < deadline) {
    if (!processGroupExists(pid)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !processGroupExists(pid);
}

// `leaderExited`: the process itself is gone, so its PID may be someone else's
// now; only what is left of its group is signalled.
async function terminateProcessGroup(pid, timeoutMs = 5000, { leaderExited = false } = {}) {
  if (!Number.isInteger(pid)) {
    return;
  }
  if (process.platform === "win32") {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // The process may already be gone.
    }
    await waitForProcessGroupExit(pid, timeoutMs);
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    // The process group may already be gone.
  }
  if (!leaderExited) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // The process may already be gone.
    }
  }
  if (await waitForProcessGroupExit(pid, timeoutMs)) {
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // The process group may already be gone.
  }
  if (!leaderExited) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // The process may already be gone.
    }
  }
  await waitForProcessGroupExit(pid, 1000);
}

// A handle the harness holds needs no marker check while the process lives.
// On Windows an exited child's PID can already belong to something else.
async function stopHeldChild(child) {
  const exited = child.exitCode !== null || child.signalCode !== null;
  if (process.platform !== "win32") {
    await terminateProcessGroup(child.pid, 5000, { leaderExited: exited });
    return;
  }
  if (exited || !Number.isInteger(child.pid)) return;
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, scaledTimeout(5000));
    child.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill();
  });
}

// Node's os.homedir() reads USERPROFILE on Windows and os.tmpdir() reads TEMP/TMP;
// Python reads USERPROFILE and tries TMPDIR before TEMP/TMP. SystemRoot, windir
// and ComSpec come from the host because Windows programs fail to start without them.
function workspaceEnv({ root, homeDir, tmpDir, stateDir, fixtureDir, platform = process.platform, hostEnv = process.env }) {
  const env = {
    CCDM_TEST_STATE: stateDir,
    HOME: homeDir,
    NODE_OPTIONS: "",
    NODE_PATH: nodePath(root),
    PATH: fixtureDir,
    // The source tree's copy: tests list the workspace repo exactly, and Python
    // writes bytecode beside this file. __pycache__ is gitignored there.
    PYTHONPATH: path.join(root, "tests", "e2e", "support", "pysafe"),
    TMPDIR: tmpDir,
  };
  if (platform !== "win32") {
    return env;
  }
  const homeDrive = path.win32.parse(homeDir).root.replace(/\\$/, "");
  Object.assign(env, {
    APPDATA: path.win32.join(homeDir, "AppData", "Roaming"),
    HOMEDRIVE: homeDrive,
    HOMEPATH: homeDir.slice(homeDrive.length),
    LOCALAPPDATA: path.win32.join(homeDir, "AppData", "Local"),
    PATHEXT: ".COM;.EXE",
    TEMP: tmpDir,
    TMP: tmpDir,
    USERPROFILE: homeDir,
  });
  for (const key of ["SystemRoot", "windir", "ComSpec"]) {
    if (hostEnv[key] !== undefined) env[key] = hostEnv[key];
  }
  return env;
}

// On Windows a process killed a moment ago can keep the directory for a little
// while longer, and rmSync does not retry that error itself.
async function removeWorkspaceRoot(root) {
  const deadline = Date.now() + scaledTimeout(1000);
  for (;;) {
    try {
      fs.rmSync(root, { force: true, recursive: true });
      return;
    } catch (error) {
      if (!WIN || Date.now() >= deadline || !["EBUSY", "EPERM", "ENOTEMPTY"].includes(error.code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

export const createWorkspace = Object.freeze(function createWorkspace(options = {}) {
  const root = sourceRoot();
  const files = gitSourceFiles(root);
  rejectForbiddenSourceArtifacts(files);

  // Registered before anything exists, so a throw below leaves nothing behind after cleanup().
  let tmpRoot;
  let stateDir;
  let workspaceJob;
  registerTeardownCallback(async () => {
    if (tmpRoot === undefined) return;
    const stopping = workspaceJob?.stop();
    if (stopping) await stopping;
    try {
      const state = readState(stateDir);
      for (const row of state.fixtures.processes ?? []) {
        // What the job ended is gone by now; the marker check is for what it never held.
        if (WIN && Number.isInteger(row?.pid) && !processGroupExists(row.pid)) continue;
        if (row?.owned === true && row.ownerStateDir === stateDir && Number.isInteger(row.pid)
            && workspaceOwnsPid(row.pid, tmpRoot)) {
          await terminateProcessGroup(row.pid, 5000);
        }
      }
    } catch {
      // Workspace removal should still proceed if fixture cleanup cannot read state.
    }
    // With CCDM_E2E_KEEP_FAILED=1 the runner decides, once it knows the file's result.
    if (process.env.CCDM_E2E_KEEP_FAILED !== "1") await removeWorkspaceRoot(tmpRoot);
  });

  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ccdm-e2e-"));
  // tests/run-e2e.mjs reads this line to remove workspaces a killed file left behind.
  process.stderr.write(`ccdm-e2e-workspace ${tmpRoot}\n`);
  stateDir = path.join(tmpRoot, "state");
  const repoDir = path.join(tmpRoot, options.repoDirName ?? "repo");
  const homeDir = path.join(tmpRoot, "home");
  const tmpDir = path.join(tmpRoot, "tmp");
  const fixtureDir = path.join(tmpRoot, "fixtures");
  const env = workspaceEnv({ root, homeDir, tmpDir, stateDir, fixtureDir });
  for (const dir of [repoDir, homeDir, tmpDir, stateDir, env.APPDATA, env.LOCALAPPDATA]) {
    if (dir) fs.mkdirSync(dir, { recursive: true });
  }

  copySourceFiles(root, repoDir, files);
  // The fixture runtime finds the checkout at <tmpRoot>/repo.
  if (options.repoDirName) fs.symlinkSync(repoDir, path.join(tmpRoot, "repo"), "junction");
  assertWorkspaceClean(repoDir);
  createFixtures(fixtureDir, options);
  if (WIN) {
    workspaceJob = createWorkspaceJob(fixtureDir, { killWaitMs: scaledTimeout(3000), launcherWaitMs: scaledTimeout(4000) });
  }
  writeState(undefined, stateDir);

  const workspace = Object.freeze({
    env: Object.freeze(env),
    fixtureDir,
    homeDir,
    repoDir,
    sourceRoot: root,
    stateDir,
    tmpDir,
    tmpRoot,
  });

  return workspace;
});

function buildEnv(workspace, extraEnv = {}) {
  const env = { ...workspace.env, ...extraEnv };
  // A test's own PYTHONPATH must not take away the os.kill(pid, 0) guard.
  if (WIN && extraEnv.PYTHONPATH && workspace.env.PYTHONPATH) {
    env.PYTHONPATH = `${workspace.env.PYTHONPATH}${path.delimiter}${extraEnv.PYTHONPATH}`;
  }
  return env;
}

function runProcess(workspace, command, args, options = {}) {
  assertIsolatedPath(workspace, workspace.homeDir);
  assertIsolatedPath(workspace, workspace.tmpDir);
  const env = buildEnv(workspace, options.env);
  const cwd = options.cwd ?? workspace.repoDir;
  // `command` stays what the test named; only how it starts differs on Windows.
  const [program, ...interpreterArgs] = interpreterFor(command);
  const child = spawn(program, [...interpreterArgs, ...args], {
    cwd,
    detached: true,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  registerTeardownCallback(() => stopHeldChild(child));
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
        if (process.platform === "win32") child.kill("SIGTERM");
        else process.kill(-child.pid, "SIGTERM");
      } catch {
        // The process may have already exited.
      }
    }, scaledTimeout(options.timeoutMs ?? 5000));

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
  workspaceEnv,
});
