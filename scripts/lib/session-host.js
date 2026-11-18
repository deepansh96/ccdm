"use strict";

// The one API launchers and adapters use to run sessions. On macOS and Linux it
// issues tmux commands; on Windows it talks to ccdm-host (protocol v1, see
// docs/adr/0007-windows-session-host.md). CCDM_SESSION_HOST=tmux|ccdm-host
// overrides the choice. scripts/ccdmlib/platform/session_host.py is the twin.
//
// Every verb returns a promise except attachHint. Durations are milliseconds.
// A failure is a HostError with `.code`; with no host running it is `not_running`.
const { execFile } = require("node:child_process");
const path = require("node:path");

const { spawnDetached } = require("../platform/detached.js");
const { ERRORS, HostError, KINDS } = require("../host/protocol.js");

const SESSION_NAME_VARIABLE = "CCDM_SESSION_NAME";
const WAIT_POLL_MS = 200;
const MAX_CAPTURE_BYTES = 64 * 1024 * 1024;
// Time the host needs beyond a request's own wait, to empty a Job and answer.
const HOST_MARGIN_MS = 10000;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function backendName(env = process.env) {
  const chosen = env.CCDM_SESSION_HOST;
  if (!chosen) return process.platform === "win32" ? "ccdm-host" : "tmux";
  if (chosen !== "tmux" && chosen !== "ccdm-host") {
    throw new HostError("bad_backend", `CCDM_SESSION_HOST must be tmux or ccdm-host, not ${chosen}`);
  }
  return chosen;
}

function withoutSessionName(env = {}) {
  return Object.fromEntries(Object.entries(env ?? {}).filter(([key]) => key.toUpperCase() !== SESSION_NAME_VARIABLE));
}

// What every session gets, whatever a caller forwarded: its own name, last.
function launchRequest(name, { argv, cwd, env = {}, pty = true, kind } = {}) {
  if (typeof name !== "string" || !name || name.startsWith("=")) {
    throw new HostError(ERRORS.SPAWN_FAILED, "a session needs a name that does not start with =");
  }
  if (!Array.isArray(argv) || argv.length === 0 || !argv.every(arg => typeof arg === "string")) {
    throw new HostError(ERRORS.SPAWN_FAILED, "argv must be a non-empty array of strings");
  }
  if (typeof cwd !== "string" || !cwd) throw new HostError(ERRORS.SPAWN_FAILED, "a session needs a cwd");
  if (!KINDS.has(kind)) throw new HostError(ERRORS.SPAWN_FAILED, `unknown session kind: ${kind}`);
  return { name, argv, cwd, env: { ...withoutSessionName(env), [SESSION_NAME_VARIABLE]: name }, pty: Boolean(pty), kind };
}

// Multiline on both backends, because the host's own wait always is.
function compiled(regex) {
  if (regex instanceof RegExp) return new RegExp(regex.source, `${regex.flags.replace(/[gym]/g, "")}m`);
  return new RegExp(regex, "m");
}

function keyList(keys) {
  if (keys === undefined || keys === null) return [];
  return Array.isArray(keys) ? keys : [keys];
}

// --- tmux ---------------------------------------------------------------

const shellQuote = value => `'${String(value).replace(/'/g, "'\\''")}'`;

// Today's launch strings quote every value but leave these two words bare.
const BARE_WORDS = new Set(["server:ccdm", "scripts/codex-bridge.js"]);
const BARE_PROGRAM = /^[A-Za-z0-9_./-]+$/;
const BARE_FLAG = /^--?[A-Za-z0-9-]+$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function shellWord(arg, index) {
  const bare = index === 0 ? BARE_PROGRAM.test(arg) : BARE_FLAG.test(arg) || BARE_WORDS.has(arg);
  return bare ? arg : shellQuote(arg);
}

// The string `zsh -ic` runs: byte for byte today's launchers' form, with
// CCDM_SESSION_NAME as the last assignment. tests/e2e/tmux-golden.test.js holds it.
function tmuxLaunchCommand(name, options) {
  const { argv, cwd, env } = launchRequest(name, options);
  const assignments = Object.entries(env).map(([key, value]) => {
    if (!ENV_NAME.test(key)) throw new HostError(ERRORS.SPAWN_FAILED, `not an environment variable name: ${key}`);
    return `${key}=${shellQuote(value)}`;
  });
  return `cd ${shellQuote(cwd)} && ${assignments.join(" ")} ${argv.map(shellWord).join(" ")}`;
}

function runTool(tool, args) {
  return new Promise((resolve, reject) => {
    execFile(tool, args, { encoding: "utf8", maxBuffer: MAX_CAPTURE_BYTES, windowsHide: true }, (error, stdout, stderr) => {
      if (error && typeof error.code !== "number") {
        reject(new HostError(ERRORS.SPAWN_FAILED, `${tool} could not run: ${error.message}`));
        return;
      }
      resolve({ status: error ? error.code : 0, stdout, stderr });
    });
  });
}

const tmux = args => runTool("tmux", args);
const exactSession = name => `=${name}`;
// A pane target needs the colon: without it tmux reads `=name` as a pane name.
const exactPane = name => `=${name}:`;

function noSuchSession(name, result) {
  return new HostError(ERRORS.UNKNOWN_SESSION, result.stderr.trim() || `no session named ${name}`);
}

async function tmuxSend(name, keys) {
  const result = await tmux(["send-keys", "-t", exactPane(name), ...keys]);
  if (result.status !== 0) throw noSuchSession(name, result);
}

async function tmuxCapture(name, { history = false, join = false } = {}) {
  const args = ["capture-pane", "-t", exactPane(name), "-p"];
  if (join) args.push("-J");
  if (history === true) args.push("-S", "-");
  else if (history) args.push("-S", String(-Math.abs(Number(history))));
  const result = await tmux(args);
  if (result.status !== 0) throw noSuchSession(name, result);
  return result.stdout;
}

const tmuxIsLive = async name => (await tmux(["has-session", "-t", exactSession(name)])).status === 0;
const tmuxKill = async name => (await tmux(["kill-session", "-t", exactSession(name)])).status === 0;

async function tmuxPanePid(name) {
  const result = await tmux(["display-message", "-t", exactPane(name), "-p", "#{pane_pid}"]);
  if (result.status !== 0) return null;
  return Number.parseInt(result.stdout.trim(), 10) || null;
}

const tmuxBackend = {
  async start(name, options) {
    const { kind } = launchRequest(name, options);
    const result = await tmux(["new-session", "-d", "-s", name, "--", "zsh", "-ic", tmuxLaunchCommand(name, options)]);
    if (result.status !== 0) {
      const code = /duplicate session/.test(result.stderr) ? ERRORS.DUPLICATE_SESSION : ERRORS.SPAWN_FAILED;
      throw new HostError(code, result.stderr.trim() || `tmux could not start session ${name}`);
    }
    return { pid: null, kind };
  },
  isLive: tmuxIsLive,
  // `--` only where it is needed, so ordinary text keeps today's argv.
  sendText: (name, text) => tmuxSend(name, text.startsWith("-") ? ["-l", "--", text] : ["-l", text]),
  sendKey: (name, key) => tmuxSend(name, [key]),
  capture: tmuxCapture,
  async waitFor(name, regex, timeout, thenSend) {
    const pattern = compiled(regex);
    const started = Date.now();
    for (;;) {
      const screen = await tmuxCapture(name);
      if (pattern.test(screen)) {
        for (const key of keyList(thenSend)) await tmuxSend(name, [key]);
        return { matched: true, ms: Date.now() - started, screen };
      }
      const remaining = started + timeout - Date.now();
      if (remaining <= 0) return { matched: false, ms: Date.now() - started, screen };
      await sleep(Math.min(WAIT_POLL_MS, remaining));
    }
  },
  // With graceMs: restart-root's sequence, whose waits were 1 s, 2 s and 1 s.
  async stop(name, { graceMs } = {}) {
    if (graceMs === undefined || graceMs === null) return { stopped: await tmuxKill(name) };
    if (!await tmuxIsLive(name)) return { stopped: false };
    const pane = await tmuxPanePid(name);
    if (pane) {
      await runTool("pkill", ["-TERM", "-P", String(pane)]).catch(() => {});
      await sleep(graceMs);
    }
    await tmuxKill(name);
    await sleep(Math.min(2000, graceMs * 2));
    if (await tmuxIsLive(name)) {
      await tmuxKill(name);
      await sleep(Math.min(1000, graceMs));
    }
    return { stopped: true };
  },
  async pids(name) {
    const pane = await tmuxPanePid(name);
    if (!pane) return [];
    const table = await runTool("ps", ["-axo", "pid=,ppid="]);
    const childrenOf = new Map();
    for (const line of table.stdout.split("\n")) {
      const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
      if (!match) continue;
      const [pid, ppid] = [Number(match[1]), Number(match[2])];
      childrenOf.set(ppid, [...(childrenOf.get(ppid) ?? []), pid]);
    }
    const found = [pane];
    for (const pid of found) {
      for (const child of childrenOf.get(pid) ?? []) if (!found.includes(child)) found.push(child);
    }
    return found;
  },
  async list() {
    const result = await tmux(["list-sessions", "-F", "#{session_name}"]);
    if (result.status !== 0) return [];
    return result.stdout.split("\n").filter(Boolean).map(name => ({ name, kind: null, pid: null }));
  },
  attachHint: name => `Attach with: tmux attach -t ${name}`,
  async runDetached(argv, { cwd, env, log } = {}) {
    const pid = spawnDetached(argv[0], argv.slice(1), { cwd, env, log });
    if (pid === undefined) throw new HostError(ERRORS.SPAWN_FAILED, `could not start ${argv[0]}`);
    return { pid };
  },
};

// --- ccdm-host ----------------------------------------------------------

const call = (op, args = {}, options = {}) => require("../host/client.js").callHost(op, args, options);

const hostBackend = {
  async start(name, options) {
    const request = launchRequest(name, options);
    const { pid } = await call("new", request);
    return { pid, kind: request.kind };
  },
  isLive: async name => (await call("has", { name })).live,
  sendText: async (name, text) => { await call("send", { name, keys: [text], literal: true }); },
  sendKey: async (name, key) => { await call("send", { name, keys: [key], literal: false }); },
  capture: async (name, { history = false, join = false } = {}) => (await call("capture", { name, history, join })).text,
  async waitFor(name, regex, timeout, thenSend) {
    const pattern = compiled(regex);
    const frame = { name, regex: pattern.source, timeoutMs: timeout, thenSend: keyList(thenSend) };
    if (pattern.flags.includes("i")) frame.flags = "i";
    const { matched, ms, screen } = await call("wait", frame, { timeoutMs: timeout + HOST_MARGIN_MS });
    return { matched, ms, screen };
  },
  async stop(name, { graceMs } = {}) {
    try {
      await call("kill", { name, graceMs: graceMs ?? 0 }, { timeoutMs: (graceMs ?? 0) + HOST_MARGIN_MS });
      return { stopped: true };
    } catch (error) {
      if (error.code === ERRORS.UNKNOWN_SESSION) return { stopped: false };
      throw error;
    }
  },
  async pids(name) {
    try {
      return (await call("pids", { name })).pids;
    } catch (error) {
      if (error.code === ERRORS.UNKNOWN_SESSION) return [];
      throw error;
    }
  },
  async list() {
    const { sessions } = await call("list");
    return sessions.filter(session => session.exit === null).map(({ name, kind, pid }) => ({ name, kind, pid }));
  },
  attachHint: (name, target) => `Attach with: scripts/ccdm attach ${target ?? name}`,
  async runDetached(argv, { cwd, env, log } = {}) {
    // The host resolves neither against the caller, and it needs an absolute log.
    const request = { argv, cwd: cwd ?? process.cwd(), env: withoutSessionName(env), log: log && path.resolve(log) };
    const { pid } = await call("run-detached", request);
    return { pid };
  },
};

const BACKENDS = { tmux: tmuxBackend, "ccdm-host": hostBackend };
const backend = () => BACKENDS[backendName()];

module.exports = {
  backendName,
  tmuxLaunchCommand,
  start: async (name, options) => backend().start(name, options),
  isLive: async name => backend().isLive(name),
  sendText: async (name, text) => backend().sendText(name, text),
  sendKey: async (name, key) => backend().sendKey(name, key),
  capture: async (name, options) => backend().capture(name, options),
  waitFor: async (name, regex, timeout, thenSend) => backend().waitFor(name, regex, timeout, thenSend),
  stop: async (name, options) => backend().stop(name, options),
  pids: async name => backend().pids(name),
  list: async () => backend().list(),
  // The line a launcher prints; the launcher decides which stream.
  attachHint: (name, target) => backend().attachHint(name, target),
  runDetached: async (argv, options) => backend().runDetached(argv, options),
};
