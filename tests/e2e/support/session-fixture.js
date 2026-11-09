// The Local Fake session host: one core that models sessions, with two fronts.
//   tmux front: the fixture `tmux` command, argv in, exit status and stdout out.
//   Fake ccdm-host front: protocol v1 over a pipe (a Unix socket on POSIX), with Jobs.
// Both keep sessions in `fixtures.tmux.sessions` and write the same launch record
// to `fixtures.sessionHost.launches`, so a launcher test can assert argv, cwd and
// env on either backend.
//
// The fixture runtime loads a copy of this file as session-fixture.mjs, from the
// shared fixture directory, so only node: modules may be imported at the top.
//
// Switches a test sets in `fixtures.claude`, without editing this harness:
//   trustPrompt: the fake claude shows the folder-trust prompt before the channel prompt.
//   autoModeOffer: it shows the one-time auto-mode offer until it gets Escape.
//   contextScreen: `/context` then Enter shows this grid (true: a standard one).
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

const WIN = process.platform === "win32";
const CALL_LOG = "session-calls.ndjson";
const WAIT_POLL_MS = 25;
const PROTOCOL_VERSION = 1;

export const TRUST_PROMPT = "Do you trust the files in this folder?\n\nIs this a project you created or one you trust?\n\n❯ 1. Yes, proceed\n  2. No, exit\n";
export const AUTO_MODE_OFFER = "Make auto mode your default permission mode?\n\n1. Yes\n2. Not now\n";
export const CONTEXT_SCREEN = "Context Usage\n⛁ ⛁ ⛁ ⛀ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶   claude-fixture · 45k/200k tokens (22%)\n⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶   ⛁ Messages: 30k tokens (15%)\n";

// One line per call, in order: `{front, args}` for a tool, `{front, op, ...}` for a pipe op.
function appendCall(stateDir, entry) {
  fs.appendFileSync(path.join(stateDir, CALL_LOG), `${JSON.stringify(entry)}\n`);
}

// ---- the core, as the fixture runtime uses it ----

export function createSessionFixture(context) {
  const {
    DEV_CHANNEL_PROMPT, isAlive, normalizeSessionTarget, parseTmuxLaunch, readState,
    recordClaudeInvocation, recordCodexBridgeInvocation, spawnPlaceholder, spawnRouterBridge, spawnRouterClaude,
    stateDir, unquote, updateState, writeClaudeSession,
  } = context;

  const sessions = () => readState().fixtures.tmux.sessions;

  // A session that a test told to exit at once is gone when anything looks.
  function isLive(name) {
    const session = sessions()[name];
    if (session?.startupMode === "exit") {
      updateState((state) => { delete state.fixtures.tmux.sessions[name]; return state; });
      return false;
    }
    return Boolean(session);
  }

  // Why a launch does not start: null, or {status, message}, or {early: true}.
  function launchRefusal(name) {
    const tmuxState = readState().fixtures.tmux;
    if (tmuxState.newSessionFailures?.[name]) {
      updateState((state) => {
        state.fixtures.tmux.newSessionFailures[name] -= 1;
        return state;
      });
      return { status: 1, message: "fixture tmux new-session failure" };
    }
    // `earlyExits[name]` launches start and exit at once: the session is gone
    // before anything can look at its pane.
    if (tmuxState.earlyExits?.[name]) {
      updateState((state) => {
        state.fixtures.tmux.earlyExits[name] -= 1;
        return state;
      });
      return { early: true };
    }
    const preexisting = tmuxState.sessions[name];
    if (preexisting?.newSessionStatus) {
      return { status: preexisting.newSessionStatus, message: "fixture tmux new-session failure" };
    }
    return null;
  }

  // `launch` is what parseTmuxLaunch returns, or the same shape from an argv.
  // `record` is the launch record; the fronts differ only in how it is filled.
  function launchSession(name, launch, { command, shellCommand, record }) {
    const tmuxState = readState().fixtures.tmux;
    const preexistingSession = tmuxState.sessions[name];
    const priorKillAttempts =
      tmuxState.lastKilledSessions?.[name]?.killAttempts ?? preexistingSession?.killAttempts ?? 0;
    // A CCDM channel launch runs the fake claude, which hosts the real channel
    // server once the development-channel confirmation is accepted.
    const routerChannel = launch.kind === "claude-listener" && launch.claudeArgs.includes("server:ccdm");
    const routerBridge = launch.kind === "codex-bridge" && Boolean(launch.env.CCDM_ROUTER_KEY_FILE);
    const pid = routerChannel
      ? spawnRouterClaude(name, launch)
      : routerBridge ? spawnRouterBridge(launch) : spawnPlaceholder();
    // A `--resume <id>` launch continues that session, as Claude does.
    const resumeIndex = launch.kind === "claude-listener" ? launch.claudeArgs.indexOf("--resume") : -1;
    const sessionId = resumeIndex >= 0 ? unquote(launch.claudeArgs[resumeIndex + 1]) : `fixture-session-${pid}`;
    const processCommand =
      routerBridge
        ? `node scripts/codex-bridge.js CHANNEL_ID='${launch.env.CHANNEL_ID}' WS_PORT='${launch.env.WS_PORT}' CCDM_ROUTER_KEY_FILE='${launch.env.CCDM_ROUTER_KEY_FILE}'`
        : launch.kind === "codex-bridge"
        ? `node scripts/codex-bridge.js CHANNEL_ID='${launch.env.CHANNEL_ID}' BOT_APP_ID='${launch.env.BOT_APP_ID}' WS_PORT='${launch.env.WS_PORT}'`
        : launch.kind === "claude-listener"
        ? `claude ${launch.claudeArgs.join(" ")} CCDM_ROUTER_KEY_FILE='${launch.env.CCDM_ROUTER_KEY_FILE}'`
        : record.argv.join(" ");
    const devChannelPrompt = routerChannel ? (tmuxState.devChannelPrompt === "never" ? "never" : "pending") : undefined;
    const trustPrompt = launch.kind === "claude-listener" && readState().fixtures.claude.trustPrompt ? "pending" : undefined;
    const autoModeOffer = launch.kind === "claude-listener" && readState().fixtures.claude.autoModeOffer ? "pending" : undefined;
    const launchedScreen =
      launch.kind === "codex-bridge"
        ? "Codex-Discord bridge running\nListening in #channel-id\n"
        : launch.kind === "generic"
          ? ""
          : devChannelPrompt === "pending"
            ? DEV_CHANNEL_PROMPT
            : devChannelPrompt === "never"
              ? "Starting Claude Code\n"
              : "Listening for channel messages\n";
    const afterTrustScreen = autoModeOffer ? AUTO_MODE_OFFER : launchedScreen;
    const paneOutput = trustPrompt ? TRUST_PROMPT : afterTrustScreen;

    updateState((state) => {
      if (state.fixtures.tmux.sessions[name]) {
        const existing = state.fixtures.tmux.sessions[name];
        if (existing.killFailuresRemaining || existing.newSessionStatus) {
          throw new Error(`duplicate tmux session: ${name}`);
        }
      }
      state.fixtures.tmux.sessions[name] = {
        name,
        command,
        cwd: launch.cwd,
        env: launch.env,
        bridgeCommand: launch.bridgeCommand,
        paneOutput,
        ...(devChannelPrompt ? { devChannelPrompt } : {}),
        ...(trustPrompt ? { trustPrompt, afterTrustScreen } : {}),
        ...(autoModeOffer ? { autoModeOffer, afterOfferScreen: launchedScreen } : {}),
        pid,
        killAttempts: priorKillAttempts,
        shellCommand,
        startupMode: tmuxState.startupMode,
        kind: record.kind,
      };
      state.fixtures.processes.push({
        command: processCommand,
        kind: launch.kind,
        owned: true,
        ownerStateDir: stateDir,
        pid,
        ppid: process.pid,
      });
      state.fixtures.sessionHost ||= { launches: [], detached: [] };
      state.fixtures.sessionHost.launches.push({ ...record, pid });
      return state;
    });
    if (launch.kind === "codex-bridge") {
      recordCodexBridgeInvocation({
        command: launch.bridgeCommand,
        cwd: launch.cwd,
        env: launch.env,
        pid,
      });
    } else if (launch.kind === "claude-listener") {
      recordClaudeInvocation({
        args: launch.claudeArgs,
        cwd: launch.cwd,
        env: launch.env,
        pid,
        sessionId,
      });
      // `fixtures.claude.omitSessionFile`: Claude never writes its session file.
      if (!readState().fixtures.claude.omitSessionFile) writeClaudeSession(pid, sessionId, launch.env.CLAUDE_CONFIG_DIR);
    }
    return pid;
  }

  // Keys as tmux gets them: ["-l", text], ["-l", "--", text], or [key].
  function sendKeys(name, keys) {
    updateState((state) => {
      const session = state.fixtures.tmux.sessions[name] || { name };
      session.sendKeys = [...(session.sendKeys || []), keys];
      const contextScreen = state.fixtures.claude.contextScreen;
      if (keys[0] === "-l") {
        session.typedText = keys.at(-1);
      } else if (keys[0] === "Enter" && session.trustPrompt === "pending") {
        session.trustPrompt = "accepted";
        session.paneOutput = session.afterTrustScreen;
      } else if (keys[0] === "Escape" && session.autoModeOffer === "pending") {
        session.autoModeOffer = "dismissed";
        session.paneOutput = session.afterOfferScreen;
      } else if (keys[0] === "Enter" && session.typedText === "/context" && contextScreen) {
        session.typedText = undefined;
        session.paneOutput = contextScreen === true ? CONTEXT_SCREEN : contextScreen;
      } else if (session.devChannelPrompt === "pending" && keys[0] === "Enter") {
        session.devChannelPrompt = "accepted";
        session.paneOutput = "Listening for channel messages from: server:ccdm\n";
      }
      state.fixtures.tmux.sessions[name] = session;
      return state;
    });
  }

  function killSession(name) {
    const session = sessions()[name];
    if (!session) return { found: false };
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
    return { found: true, failed: session.killFailuresRemaining > 0 };
  }

  // ---- tmux front ----

  function targetName(args) {
    return normalizeSessionTarget(args[args.indexOf("-t") + 1]);
  }

  function tmuxNewSession(args) {
    const name = args[args.indexOf("-s") + 1];
    const separatorIndex = args.indexOf("--");
    const command = args.slice(separatorIndex + 1);
    if (!name || separatorIndex === -1 || command[0] !== "zsh" || command[1] !== "-ic" || !command[2]) {
      console.error("unsupported tmux new-session invocation");
      process.exit(2);
    }
    const shellCommand = command[2];
    const refusal = launchRefusal(name);
    if (refusal?.early) process.exit(0);
    if (refusal) {
      console.error(refusal.message);
      process.exit(refusal.status);
    }
    const launch = parseTmuxLaunch(shellCommand);
    const parsedArgv = launch.kind === "codex-bridge"
      ? launch.bridgeCommand.split(" ")
      : launch.kind === "generic" ? launch.argv : ["claude", ...launch.claudeArgs.map(unquote)];
    launchSession(name, launch, {
      command,
      shellCommand,
      record: { front: "tmux", name, kind: null, argv: parsedArgv, cwd: launch.cwd, env: launch.env, pty: true, rawArgv: args },
    });
    process.exit(0);
  }

  function runTmux(args) {
    appendCall(stateDir, { front: "tmux", args });
    const subcommand = args[0];
    if (subcommand === "has-session") {
      process.exit(isLive(targetName(args)) ? 0 : 1);
    }
    if (subcommand === "new-session") {
      tmuxNewSession(args);
    }
    if (subcommand === "kill-session") {
      const result = killSession(targetName(args));
      process.exit(!result.found || result.failed ? 1 : 0);
    }
    if (subcommand === "display-message") {
      const session = sessions()[targetName(args)];
      if (!session) process.exit(1);
      if (args.includes("#{pane_pid}")) {
        process.stdout.write(session.panePid ? `${session.panePid}\n` : "");
        process.exit(0);
      }
      console.error(`unsupported tmux display-message format: ${args.join(" ")}`);
      process.exit(2);
    }
    if (subcommand === "capture-pane") {
      const session = sessions()[targetName(args)];
      if (!session) process.exit(1);
      process.stdout.write(session.paneOutput || "");
      process.exit(0);
    }
    if (subcommand === "send-keys") {
      const targetIndex = args.indexOf("-t");
      sendKeys(normalizeSessionTarget(args[targetIndex + 1]), args.slice(targetIndex + 2));
      process.exit(0);
    }
    if (subcommand === "list-sessions") {
      if (args[1] !== "-F" || args[2] !== "#{session_name}") {
        console.error(`unsupported tmux list-sessions format: ${args.join(" ")}`);
        process.exit(2);
      }
      const names = Object.keys(sessions());
      if (names.length === 0) {
        console.error("no server running");
        process.exit(1);
      }
      process.stdout.write(`${names.join("\n")}\n`);
      process.exit(0);
    }
    if (subcommand === "attach") {
      if (!sessions()[targetName(args)]) {
        console.error(`can't find session: ${targetName(args)}`);
        process.exit(1);
      }
      process.exit(0);
    }
    console.error(`unsupported tmux command: ${args.join(" ")}`);
    process.exit(2);
  }

  // ---- fake ccdm-host front ----

  class OpError extends Error {
    constructor(code, message) {
      super(message);
      this.code = code;
    }
  }

  const unknownSession = name => new OpError("unknown_session", `no session named ${name}`);

  // The same launch shapes the tmux front parses, from a plain argv.
  function launchFromArgv({ argv, cwd, env }) {
    const program = path.basename(argv[0]).replace(/\.(exe|cmd)$/i, "");
    if (program === "claude") return { kind: "claude-listener", cwd, env, claudeArgs: argv.slice(1) };
    if (program === "node" && argv.some(arg => path.basename(arg) === "codex-bridge.js")) {
      const script = argv.findIndex(arg => path.basename(arg) === "codex-bridge.js");
      return { kind: "codex-bridge", cwd, env, bridgeCommand: "node scripts/codex-bridge.js", bridgeArgs: argv.slice(script + 1) };
    }
    return { kind: "generic", cwd, env };
  }

  // A real child outside the session's root process: what a Job holds besides it.
  function addJobChild(name, parentPid) {
    const childPid = spawnPlaceholder();
    updateState((state) => {
      state.fixtures.processes.push({ command: "job child", kind: "job-child", owned: true, ownerStateDir: stateDir, pid: childPid, ppid: parentPid });
      state.fixtures.tmux.sessions[name].job = [parentPid, childPid];
      return state;
    });
  }

  function endJob(pids) {
    for (const pid of pids) {
      try {
        process.kill(pid);
      } catch { /* It may already have ended. */ }
    }
  }

  async function waitForScreen(frame) {
    const started = Date.now();
    const pattern = new RegExp(frame.regex, frame.flags);
    for (;;) {
      const session = sessions()[frame.name];
      if (!session) throw unknownSession(frame.name);
      const screen = session.paneOutput || "";
      if (pattern.test(screen)) {
        for (const key of frame.thenSend ?? []) sendKeys(frame.name, [key]);
        return { matched: true, ms: Date.now() - started, screen };
      }
      if (Date.now() - started >= frame.timeoutMs) return { matched: false, ms: Date.now() - started, screen };
      await new Promise(resolve => setTimeout(resolve, WAIT_POLL_MS));
    }
  }

  const HOST_OPS = {
    new(frame) {
      const { name, argv, cwd, env = {}, pty = false, kind } = frame;
      if (!["project", "thread", "root", "adhoc"].includes(kind)) throw new OpError("spawn_failed", `unknown session kind: ${kind}`);
      if (isLive(name)) throw new OpError("duplicate_session", `a live session named ${name} already exists`);
      const refusal = launchRefusal(name);
      if (refusal?.early) return { pid: null };
      if (refusal) throw new OpError("spawn_failed", refusal.message);
      const launch = launchFromArgv({ argv, cwd, env });
      const pid = launchSession(name, launch, {
        command: argv,
        shellCommand: null,
        record: { front: "ccdm-host", name, kind, argv, cwd, env, pty },
      });
      addJobChild(name, pid);
      return { pid };
    },
    has: ({ name }) => ({ live: isLive(name) }),
    list() {
      const shown = Object.values(sessions()).map(({ name, kind, pid }) => ({
        name, kind, pid, created: Math.floor(Date.now() / 1000), exit: null, pty: true,
      }));
      return { sessions: shown };
    },
    send({ name, keys, literal }) {
      if (!sessions()[name]) throw unknownSession(name);
      for (const key of keys) sendKeys(name, literal ? ["-l", String(key)] : [String(key)]);
      return {};
    },
    capture({ name }) {
      const session = sessions()[name];
      if (!session) throw unknownSession(name);
      return { text: session.paneOutput || "" };
    },
    wait: waitForScreen,
    pids({ name }) {
      const session = sessions()[name];
      if (!session) {
        if (readState().fixtures.tmux.lastKilledSessions?.[name]) return { pids: [] };
        throw unknownSession(name);
      }
      return { pids: (session.job ?? [session.pid]).filter(isAlive) };
    },
    kill({ name }) {
      const session = sessions()[name];
      if (!session) throw unknownSession(name);
      const members = session.job ?? [session.pid];
      const result = killSession(name);
      if (result.failed) throw new OpError("spawn_failed", `fixture could not kill ${name}`);
      endJob(members);
      return { killed: members };
    },
    "run-detached"({ argv, cwd, env = {}, log }) {
      if (log) fs.mkdirSync(path.dirname(log), { recursive: true });
      const logFd = log ? fs.openSync(log, "a") : null;
      const child = spawn(argv[0], argv.slice(1), {
        cwd,
        detached: true,
        env: { ...process.env, ...env },
        stdio: logFd === null ? "ignore" : ["ignore", logFd, logFd],
        windowsHide: true,
      });
      if (logFd !== null) fs.closeSync(logFd);
      if (child.pid === undefined) throw new OpError("spawn_failed", `could not start ${argv[0]}`);
      child.on("error", () => {});
      child.unref();
      updateState((state) => {
        state.fixtures.sessionHost ||= { launches: [], detached: [] };
        state.fixtures.sessionHost.detached.push({ argv, cwd, env, log: log ?? null, pid: child.pid });
        state.fixtures.processes.push({ command: argv.join(" "), kind: "run-detached", owned: true, ownerStateDir: stateDir, pid: child.pid, ppid: process.pid });
        return state;
      });
      return { pid: child.pid };
    },
    ping: () => ({}),
  };

  function hostConnection(socket, { secret, token, badProof }) {
    socket.setEncoding("utf8");
    socket.on("error", () => {});
    let authenticated = false;
    let buffer = "";
    const send = frame => { if (!socket.destroyed) socket.write(`${JSON.stringify(frame)}\n`); };
    const answer = async (frame) => {
      try {
        const handler = Object.hasOwn(HOST_OPS, frame.op) ? HOST_OPS[frame.op] : null;
        if (!handler) throw new OpError("unsupported_op", `unknown op: ${frame.op}`);
        send({ id: frame.id ?? null, ok: true, ...await handler(frame) });
      } catch (error) {
        send({ id: frame.id ?? null, ok: false, error: error.code ?? "unsupported_op", message: error.message });
      }
    };
    socket.on("data", (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const frame = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        if (authenticated) {
          appendCall(stateDir, { front: "ccdm-host", ...frame });
          answer(frame);
        } else if (frame.type === "server_proof") {
          const key = badProof ? "not-the-secret" : secret;
          send({ type: "server_proof_ok", proof: crypto.createHmac("sha256", key).update(frame.nonce).digest("hex") });
        } else if (frame.op === "hello" && frame.token === token && frame.protocol_version === PROTOCOL_VERSION) {
          appendCall(stateDir, { front: "ccdm-host", op: "hello" });
          authenticated = true;
          send({ id: frame.id ?? null, ok: true, type: "hello_ok", protocol_version: PROTOCOL_VERSION });
        } else {
          appendCall(stateDir, { front: "ccdm-host", op: "refused" });
          send({ id: frame.id ?? null, ok: false, error: "not_authenticated", message: "hello required first" });
          socket.destroy();
        }
      }
    });
  }

  // Publishes itself as the real host does, then serves until killed.
  function runFakeHost() {
    const hostDir = process.env.CCDM_FAKE_HOST_DIR;
    fs.mkdirSync(hostDir, { recursive: true });
    const secret = crypto.randomBytes(32).toString("hex");
    const token = crypto.randomBytes(32).toString("hex");
    const endpoint = WIN ? `\\\\.\\pipe\\ccdm-${crypto.randomBytes(16).toString("hex")}-host` : path.join(hostDir, "host.sock");
    const options = { secret, token, badProof: process.env.CCDM_FAKE_HOST_BAD_PROOF === "1" };
    const server = net.createServer(socket => hostConnection(socket, options));
    server.listen(endpoint, () => {
      fs.writeFileSync(path.join(hostDir, "host.secret"), secret);
      fs.writeFileSync(path.join(hostDir, "host.token"), `${token}\n`);
      if (WIN) fs.writeFileSync(path.join(hostDir, "host.pipe"), endpoint);
      process.stdout.write("fake-host ready\n");
    });
  }

  return { runFakeHost, runTmux };
}

// ---- what tests use ----

// Starts the fake ccdm-host for a workspace. `env` is what a seam call needs to
// find it. The fixture runtime is the same one the fixture commands run.
export async function startFakeHost(workspace, { badProof = false, env: extraEnv = {} } = {}) {
  const { registerTeardownCallback } = await import("./teardown.js");
  const stateRoot = path.join(workspace.tmpRoot, "fake-host-state");
  const hostDir = path.join(stateRoot, "host");
  const runtime = path.join(workspace.fixtureDir, "fixture-runtime.cjs");
  const child = spawn(process.execPath, [runtime, "ccdm-host-fake", workspace.tmpRoot], {
    cwd: workspace.tmpRoot,
    env: {
      ...workspace.env,
      ...extraEnv,
      CCDM_FAKE_HOST_DIR: hostDir,
      ...(badProof ? { CCDM_FAKE_HOST_BAD_PROOF: "1" } : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const exited = new Promise(resolve => child.once("exit", resolve));
  registerTeardownCallback(async () => {
    child.kill();
    await exited;
  });
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  await new Promise((resolve, reject) => {
    let stdout = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
      if (stdout.includes("fake-host ready")) resolve();
    });
    child.once("exit", code => reject(new Error(`fake ccdm-host exited with ${code}: ${stderr}`)));
  });
  return { child, hostDir, stateRoot, env: { CCDM_STATE_ROOT: stateRoot, CCDM_SESSION_HOST: "ccdm-host" } };
}

// Every call the fronts saw, in order: tmux argv and pipe ops.
export function sessionCalls(workspace) {
  try {
    return fs.readFileSync(path.join(workspace.stateDir, CALL_LOG), "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

export const tmuxCalls = workspace => sessionCalls(workspace).filter(call => call.front === "tmux").map(call => call.args);
export const hostOps = workspace => sessionCalls(workspace).filter(call => call.front === "ccdm-host");

// ---- calling the seam from a test, in a workspace child, as a launcher would ----

const PYTHON_NAMES = {
  attachHint: "attach_hint", backendName: "backend_name", isLive: "is_live", list: "list_sessions",
  runDetached: "run_detached", sendKey: "send_key", sendText: "send_text",
  tmuxLaunchCommand: "tmux_launch_command", waitFor: "wait_for",
};
const SNAKE_OPTIONS = { graceMs: "grace_ms" };

const NODE_DRIVER = `
const seam = require(process.argv[1]);
const [verb, positional, options] = JSON.parse(process.argv[2]);
const revive = value => value && value.regexSource ? new RegExp(value.regexSource, value.flags) : value;
const started = performance.now();
(async () => {
  const args = positional.map(revive);
  if (options) args.push(options);
  return seam[verb](...args);
})().then(
  value => console.log(JSON.stringify({ ok: true, value: value === undefined ? null : value, ms: performance.now() - started })),
  error => console.log(JSON.stringify({ ok: false, code: error.code ?? null, message: error.message, ms: performance.now() - started })),
);
`;

const PYTHON_DRIVER = `
import sys
sys.dont_write_bytecode = True
import json, re, time
sys.path.insert(0, sys.argv[1])
from ccdmlib.platform import session_host
verb, positional, options = json.loads(sys.argv[2])
def revive(value):
    if isinstance(value, dict) and value.get("regexSource"):
        return re.compile(value["regexSource"], re.IGNORECASE if "i" in value.get("flags", "") else 0)
    return value
started = time.monotonic()
try:
    value = getattr(session_host, verb)(*[revive(item) for item in positional], **(options or {}))
    print(json.dumps({"ok": True, "value": value, "ms": (time.monotonic() - started) * 1000}))
except session_host.SessionHostError as error:
    print(json.dumps({"ok": False, "code": error.code, "message": str(error), "ms": (time.monotonic() - started) * 1000}))
`;

// `python` is the interpreter to use; the harness's PYTHON, passed in so this
// file keeps to node: imports.
export function callSeam(workspace, language, verb, { positional = [], options, env = {}, python }) {
  const childEnv = { ...workspace.env, ...env, PYTHONDONTWRITEBYTECODE: "1" };
  const [command, args] = language === "node"
    ? [process.execPath, ["-e", NODE_DRIVER, path.join(workspace.repoDir, "scripts", "lib", "session-host.js"),
        JSON.stringify([verb, positional, options ?? null])]]
    : [python, ["-c", PYTHON_DRIVER, path.join(workspace.repoDir, "scripts"),
        JSON.stringify([PYTHON_NAMES[verb] ?? verb, positional, options
          ? Object.fromEntries(Object.entries(options).map(([key, value]) => [SNAKE_OPTIONS[key] ?? key, value])) : null])]];
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: workspace.tmpRoot, env: childEnv, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      try {
        resolve(JSON.parse(stdout.trim().split("\n").at(-1)));
      } catch {
        reject(new Error(`${language} ${verb} printed no result (exit ${code}): ${stderr}${stdout}`));
      }
    });
  });
}
