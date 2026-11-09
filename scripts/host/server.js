"use strict";

// The ccdm-host daemon: owns every CCDM session on Windows, one Job object each.
// Listens through createIpcListener on a pipe published at each start, answers
// the server proof, then requires a valid hello before any other op.
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { StringDecoder } = require("node:string_decoder");

const { writeFileAtomicSync } = require("../platform/atomic.js");
const { createIpcListener, publishPipe, serverProof, unpublishPipe } = require("../platform/ipc.js");
const { safeFileName, stateRoot } = require("../platform/paths.js");
const { ensurePrivateDirSync } = require("../platform/privacy.js");
const { onShutdown, processAlive, processIdentity, processStartTime } = require("../platform/process.js");
const { sessionEnvironment } = require("./env.js");
const { createSessionJob, jobPolicyProblem } = require("./jobs.js");
const {
  ERRORS, HostError, KINDS, LATER_OPS, MAX_FRAME, MAX_HELLO_FRAME, MISMATCH_MESSAGE, PROTOCOL_VERSION,
  encode, errorResponse, okResponse, parseFrame,
} = require("./protocol.js");

const DEFAULT_GRACE_MS = 3000;
const TAIL_CHARS = 256 * 1024;
// `capture` without history stands for one screen.
const SCREEN_LINES = 50;
const POLL_MS = 50;
const JOB_EXIT_WAIT_MS = 5000;
const RETAINED_ENDED_SESSIONS = 100;
const REJECT_FLUSH_MS = 100;

// tmux key names a no-PTY session understands; anything else is sent as text.
const NO_PTY_KEYS = new Map([
  ["Enter", "\n"], ["C-m", "\n"], ["Space", " "], ["Tab", "\t"], ["Escape", "\x1b"],
  ["BSpace", "\x7f"], ["C-c", "\x03"], ["C-d", "\x04"],
]);

const validNonce = nonce => typeof nonce === "string" && /^[0-9a-f]{64}$/.test(nonce);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function tokensMatch(expected, actual) {
  if (typeof actual !== "string") return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(actual);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// One daemon per user: the holder's identity is pid and start time, so a live
// PID with another start time is a stale lock (the router.lock rule).
function acquireHostLock(hostDir) {
  const lockPath = path.join(hostDir, "host.lock");
  const { pid, startedAt } = processIdentity();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let fd;
    try {
      fd = fs.openSync(lockPath, "wx", 0o600);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const held = fs.readFileSync(lockPath, "utf8").trim().split(/\s+/);
      const holder = Number.parseInt(held[0], 10);
      if (processAlive(holder, held[1] ?? null)) {
        throw new Error(`another ccdm-host is already running (pid ${holder}); stop it before starting a new one`);
      }
      fs.rmSync(lockPath, { force: true });
      continue;
    }
    fs.writeSync(fd, `${pid} ${startedAt}\n`);
    fs.closeSync(fd);
    return () => {
      try {
        if (Number.parseInt(fs.readFileSync(lockPath, "utf8"), 10) === pid) {
          fs.rmSync(lockPath, { force: true, maxRetries: 5, retryDelay: 20 });
        }
      } catch { /* Already gone. */ }
    };
  }
  throw new Error(`another ccdm-host claimed ${lockPath} first`);
}

function closeAfterFlush(socket) {
  setTimeout(() => socket.destroy(), REJECT_FLUSH_MS);
}

function createHost({ hostDir, env = process.env, log = () => {} }) {
  // name -> session. An ended session stays until a new one takes its name, so
  // its output can still be read; `released` marks one that kill-session removed.
  const sessions = new Map();
  let token = null;
  let proofSecret = null;
  let stopping = null;

  const journalPath = path.join(hostDir, "sessions.json");

  function writeJournal() {
    const live = [...sessions.values()].filter(session => session.exit === null && !session.released)
      .map(({ name, kind, pid, startedAt, created, pty, log: logFile }) => ({ name, kind, pid, startedAt, created, pty, log: logFile }));
    writeFileAtomicSync(journalPath, `${JSON.stringify({ version: 1, sessions: live }, null, 2)}\n`);
  }

  const liveSession = name => {
    const session = sessions.get(name);
    if (!session || session.exit !== null || session.released) throw unknownSession(name);
    return session;
  };
  const knownSession = name => {
    const session = sessions.get(name);
    if (!session) throw unknownSession(name);
    return session;
  };
  const unknownSession = name => new HostError(ERRORS.UNKNOWN_SESSION, `no session named ${name}`);

  function trimRetained() {
    const ended = [...sessions.values()].filter(session => session.exit !== null);
    for (const session of ended.slice(0, Math.max(0, ended.length - RETAINED_ENDED_SESSIONS))) sessions.delete(session.name);
  }

  // A session ends with its root process: whatever is left in its Job goes too.
  function endSession(session, code) {
    session.exit = code ?? 1;
    const { job } = session;
    (async () => {
      try {
        job.terminate(session.exit);
        const deadline = Date.now() + JOB_EXIT_WAIT_MS;
        while (Date.now() < deadline && job.pids().length > 0) await sleep(POLL_MS);
      } catch (error) {
        log(`session ${session.name}: could not empty its Job: ${error.message}`);
      } finally {
        job.close();
        session.job = null;
        writeJournal();
        trimRetained();
        session.finished();
      }
    })();
  }

  function appendOutput(session, chunk) {
    session.tail += chunk;
    if (session.tail.length > TAIL_CHARS) {
      const keep = session.tail.slice(-TAIL_CHARS);
      const lineStart = keep.indexOf("\n");
      session.tail = lineStart >= 0 ? keep.slice(lineStart + 1) : keep;
    }
  }

  async function startSession({ name, argv, cwd, env: explicit, kind, log: requestedLog }) {
    if (typeof name !== "string" || !name || name.startsWith("=")) {
      throw new HostError(ERRORS.SPAWN_FAILED, "a session needs a name that does not start with =");
    }
    if (!Array.isArray(argv) || argv.length === 0 || !argv.every(arg => typeof arg === "string")) {
      throw new HostError(ERRORS.SPAWN_FAILED, "argv must be a non-empty array of strings");
    }
    if (!KINDS.has(kind)) throw new HostError(ERRORS.SPAWN_FAILED, `unknown session kind: ${kind}`);
    const existing = sessions.get(name);
    if (existing && existing.exit === null && !existing.released) {
      throw new HostError(ERRORS.DUPLICATE_SESSION, `a live session named ${name} already exists`);
    }

    const session = {
      name, kind, pty: false, exit: null, released: false, pid: null, startedAt: null,
      created: Math.floor(Date.now() / 1000), log: null, tail: "", job: null, child: null, finished: null,
    };
    session.done = new Promise(resolve => { session.finished = resolve; });
    // Taken before the first await, so two racing requests cannot both start.
    sessions.set(name, session);

    let logFd = null;
    try {
      session.log = requestedLog ?? path.join(hostDir, "logs", `${safeFileName(name)}.log`);
      fs.mkdirSync(path.dirname(session.log), { recursive: true });
      logFd = fs.openSync(session.log, "a");
      const childEnv = sessionEnvironment(name, explicit ?? {}, env);
      session.job = createSessionJob();
      const child = spawn(argv[0], argv.slice(1), { cwd, env: childEnv, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      session.child = child;
      // Right after spawn and before anything awaits: the Job is on the child
      // before it can have started a child of its own.
      if (child.pid !== undefined) session.job.assign(child.pid);
      await new Promise((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
      child.on("error", () => {});
      session.pid = child.pid;
      session.startedAt = processStartTime(child.pid);
      const stream = fs.createWriteStream(null, { fd: logFd });
      logFd = null;
      stream.on("error", () => {});
      const decoder = new StringDecoder("utf8");
      const onChunk = chunk => {
        stream.write(chunk);
        appendOutput(session, decoder.write(chunk));
      };
      child.stdout.on("data", onChunk);
      child.stderr.on("data", onChunk);
      child.stdin.on("error", () => {});
      child.once("close", () => stream.end());
      child.once("exit", code => endSession(session, code));
      writeJournal();
      log(`session ${name} started (pid ${session.pid})`);
      return okResponse(null, { pid: session.pid });
    } catch (error) {
      sessions.delete(name);
      if (session.child?.exitCode === null && session.child.pid !== undefined) session.child.kill();
      session.job?.close();
      if (logFd !== null) fs.closeSync(logFd);
      throw new HostError(ERRORS.SPAWN_FAILED, error.message);
    }
  }

  function captureText(session, history) {
    const text = session.tail.replace(/\r\n/g, "\n");
    if (history === true) return text;
    const count = history === false || history === undefined ? SCREEN_LINES : Math.abs(Number(history));
    const lines = text.split("\n");
    if (lines.at(-1) === "") lines.pop();
    const shown = count > 0 ? lines.slice(-count) : [];
    return shown.length ? `${shown.join("\n")}\n` : "";
  }

  // Grace, then the Job. An already ended session is only released.
  async function killSession(session, graceMs = DEFAULT_GRACE_MS) {
    const seen = new Set(session.job ? session.job.pids() : []);
    const note = () => { for (const pid of session.job ? session.job.pids() : []) seen.add(pid); };
    if (session.exit === null) {
      session.child.stdin.end();
      const deadline = Date.now() + graceMs;
      while (Date.now() < deadline && session.exit === null) {
        note();
        await sleep(POLL_MS);
      }
      note();
      if (session.exit === null) {
        try {
          session.job.terminate(1);
        } catch { /* It ended meanwhile. */ }
      }
    }
    await Promise.race([session.done, sleep(JOB_EXIT_WAIT_MS)]);
    session.released = true;
    session.tail = "";
    writeJournal();
    return [...seen];
  }

  const live = () => [...sessions.values()].filter(session => session.exit === null && !session.released);
  const stoppingError = () => new HostError(ERRORS.SPAWN_FAILED, "ccdm-host is shutting down");

  const OPS = {
    async new(frame) {
      if (stopping) throw stoppingError();
      if (frame.pty) throw new HostError(ERRORS.UNSUPPORTED_OP, "pty sessions are not supported yet");
      return startSession(frame);
    },
    has({ name }) {
      const session = sessions.get(name);
      return okResponse(null, { live: Boolean(session && session.exit === null && !session.released) });
    },
    list() {
      const shown = [...sessions.values()].filter(session => !session.released)
        .map(({ name, kind, pid, created, exit, pty }) => ({ name, kind, pid, created, exit, pty }));
      return okResponse(null, { sessions: shown });
    },
    send({ name, keys, literal }) {
      const session = liveSession(name);
      if (!Array.isArray(keys)) throw new HostError(ERRORS.UNSUPPORTED_OP, "keys must be an array");
      for (const key of keys) {
        const text = String(key);
        session.child.stdin.write(literal ? text : NO_PTY_KEYS.get(text) ?? text);
      }
      return okResponse(null);
    },
    capture({ name, history }) {
      const session = knownSession(name);
      if (session.released) throw unknownSession(name);
      return okResponse(null, { text: captureText(session, history) });
    },
    pids({ name }) {
      const session = knownSession(name);
      return okResponse(null, { pids: session.job ? session.job.pids() : [] });
    },
    async kill({ name, graceMs }) {
      const session = knownSession(name);
      if (session.released) throw unknownSession(name);
      return okResponse(null, { killed: await killSession(session, graceMs) });
    },
    ping() {
      return okResponse(null);
    },
    async shutdown() {
      await stop("shutdown request");
      setTimeout(() => process.exit(0), REJECT_FLUSH_MS);
      return okResponse(null);
    },
  };

  async function dispatch(frame) {
    const handler = Object.hasOwn(OPS, frame.op) ? OPS[frame.op] : null;
    if (!handler) {
      const message = LATER_OPS.has(frame.op) ? `${frame.op} is not supported yet` : `unknown op: ${frame.op}`;
      return errorResponse(frame.id, ERRORS.UNSUPPORTED_OP, message);
    }
    try {
      return { ...await handler(frame), id: frame.id ?? null };
    } catch (error) {
      const code = error instanceof HostError ? error.code : ERRORS.UNSUPPORTED_OP;
      return errorResponse(frame.id, code, error.message);
    }
  }

  function onConnection(socket) {
    socket.setEncoding("utf8");
    socket.on("error", () => {});
    let authenticated = false;
    let refused = false;
    let buffer = "";
    const send = frame => { if (!socket.destroyed) socket.write(encode(frame)); };
    const refuse = (id, code, message) => {
      send(errorResponse(id, code, message));
      refused = true;
      buffer = "";
      closeAfterFlush(socket);
    };
    const notAuthenticated = (id = null) => refuse(id, ERRORS.NOT_AUTHENTICATED, "hello required first");

    function beforeHello(frame) {
      if (frame?.type === "server_proof" && validNonce(frame.nonce)) {
        send({ type: "server_proof_ok", proof: serverProof(proofSecret, frame.nonce) });
        return;
      }
      if (frame?.op !== "hello" || !tokensMatch(token, frame.token)) return notAuthenticated(frame?.id);
      if (frame.protocol_version !== PROTOCOL_VERSION) return refuse(frame.id, ERRORS.PROTOCOL_MISMATCH, MISMATCH_MESSAGE);
      authenticated = true;
      send(okResponse(frame.id, { type: "hello_ok", protocol_version: PROTOCOL_VERSION }));
    }

    socket.on("data", chunk => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const frame = parseFrame(line);
        if (!authenticated) {
          beforeHello(frame);
        } else if (!frame) {
          send(errorResponse(null, ERRORS.UNSUPPORTED_OP, "malformed frame"));
        } else {
          dispatch(frame).then(send);
        }
      }
      if (buffer.length > (authenticated ? MAX_FRAME : MAX_HELLO_FRAME)) socket.destroy();
    });
  }

  let listener = null;
  let releaseLock = null;
  let pipe = null;

  async function start() {
    ensurePrivateDirSync(hostDir);
    ensurePrivateDirSync(path.join(hostDir, "logs"));
    releaseLock = acquireHostLock(hostDir);
    token = crypto.randomBytes(32).toString("hex");
    writeFileAtomicSync(path.join(hostDir, "host.token"), `${token}\n`);
    writeJournal();
    const published = publishPipe(hostDir, "host");
    pipe = published.pipe;
    proofSecret = published.secret;
    listener = createIpcListener(onConnection);
    await listener.listen(pipe);
  }

  function stop(reason) {
    if (stopping) return stopping;
    stopping = (async () => {
      log(`stopping: ${reason}`);
      await Promise.all(live().map(session => killSession(session).catch(() => {})));
      writeJournal();
      try {
        listener?.close();
      } catch { /* It may already be closed. */ }
      if (pipe) unpublishPipe(hostDir, "host", pipe);
      fs.rmSync(path.join(hostDir, "host.token"), { force: true, maxRetries: 5, retryDelay: 20 });
      releaseLock?.();
    })();
    return stopping;
  }

  return { start, stop };
}

// The whole `serve` command. Returns a process exit code when it refuses to
// start; otherwise it runs until a shutdown request or a signal ends the process.
async function serve({ allowInJob = false } = {}) {
  const problem = jobPolicyProblem({ allowInJob });
  if (problem) {
    process.stderr.write(`${problem}\n`);
    return 1;
  }
  const hostDir = path.join(stateRoot(), "host");
  const log = line => process.stdout.write(`ccdm-host: ${line}\n`);
  const host = createHost({ hostDir, log });
  try {
    await host.start();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 1;
  }
  onShutdown(reason => {
    host.stop(reason).finally(() => process.exit(0));
  });
  log(`ready (pid ${process.pid})`);
  return null;
}

module.exports = { serve };
