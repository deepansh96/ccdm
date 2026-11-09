#!/usr/bin/env node
"use strict";

// Runs one CCDM daemon for a Windows scheduled task and restarts it after a
// failure, the job launchd's KeepAlive does on macOS.
//
//   node service-host.js --config <file>         supervise the daemon
//   node service-host.js --config <file> --once  run it once, same logs, no restart
//
// The task starts this at logon and every 5 minutes, so one start in two finds a
// host already running or a service stopped on purpose, and exits 0 at once.
// Task Scheduler cannot tell: `schtasks /end` kills only the conhost above this
// process and then reports the task Ready, so this host holds its own lock.
//
// The config, written by `ccdm install-service`:
//   { name, command: [program, ...args], cwd, env, service_dir }
// Beside it in service_dir: <name>.state.json .disabled .stop .lock .log .err
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const { writeFileAtomicSync } = require("../platform/atomic.js");
const { cleanEnv } = require("../platform/env.js");
const { killTree, processAlive, processIdentity, rememberSpawn } = require("../platform/process.js");

const BASE_DELAY_MS = 10_000;
const MAX_DELAY_MS = 600_000;
const FAILURE_WINDOW_MS = 10 * 60_000;
const CRASHLOOP_FROM_FAILURE = 6;
const STABLE_UPTIME_MS = 30 * 60_000;
const LOG_LIMIT_BYTES = 10 * 1024 * 1024;
const LOG_KEPT_FILES = 3;
const STOP_POLL_MS = 500;
const STOP_GRACE_MS = 15_000;
// Long enough for a console-close event sent to both processes to reach this one.
const CLEAN_EXIT_SETTLE_MS = 1000;
const CTRL_BREAK_EVENT = 1;
const RENAME_ATTEMPTS = 10;

// How much faster than real time the delays and windows run. Tests only.
const TIME_SCALE = Number(process.env.CCDM_SERVICE_HOST_TIME_SCALE) || 1;
// Names a test may carry past cleanEnv, such as its fixture state. Tests only.
const TEST_PASS = (process.env.CCDM_SERVICE_HOST_TEST_PASS || "").split(",").filter(Boolean);

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// The restart delay after each failure. Failures age out of the window until the
// sixth, which starts a crash loop; only a long uptime ends that, so a daemon that
// keeps failing never drifts back to frequent Discord logins.
function createBackoff() {
  let failures = [];
  let level = 0;
  return {
    get crashloop() {
      return level > 0;
    },
    fail(now) {
      if (level === 0) failures = failures.filter(at => now - at < FAILURE_WINDOW_MS);
      failures.push(now);
      if (level > 0 || failures.length >= CRASHLOOP_FROM_FAILURE) level += 1;
      return level === 0 ? BASE_DELAY_MS : Math.min(BASE_DELAY_MS * 2 ** level, MAX_DELAY_MS);
    },
    reset() {
      failures = [];
      level = 0;
    },
  };
}

// Appends to `file`, moving it aside once it reaches the limit: file.1 is newest.
function createRotatingLog(file, { limit = LOG_LIMIT_BYTES, kept = LOG_KEPT_FILES } = {}) {
  let fd = fs.openSync(file, "a", 0o600);
  let size = fs.fstatSync(fd).size;
  const moveAside = (from, to) => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        if (fs.existsSync(from)) fs.renameSync(from, to);
        return;
      } catch (error) {
        if (attempt >= RENAME_ATTEMPTS) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * attempt);
      }
    }
  };
  const rotate = () => {
    fs.closeSync(fd);
    fd = null;
    try {
      for (let index = kept - 1; index >= 1; index -= 1) moveAside(`${file}.${index}`, `${file}.${index + 1}`);
      moveAside(file, `${file}.1`);
    } finally {
      // A rotation that failed keeps writing to the same file rather than losing output.
      fd = fs.openSync(file, "a", 0o600);
      size = fs.fstatSync(fd).size;
    }
  };
  return {
    write(chunk) {
      if (fd === null) return;
      fs.writeSync(fd, chunk);
      size += chunk.length;
      if (size < limit) return;
      try {
        rotate();
      } catch (error) {
        fs.writeSync(fd, `service-host: log rotation failed: ${error.message}\n`);
      }
    },
    close() {
      if (fd !== null) fs.closeSync(fd);
      fd = null;
    },
  };
}

function parseArguments(argv) {
  const once = argv.includes("--once");
  const at = argv.indexOf("--config");
  if (at < 0 || !argv[at + 1]) throw new Error("usage: service-host.js --config <file> [--once]");
  return { configFile: argv[at + 1], once };
}

function loadConfig(file) {
  const config = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const key of ["name", "cwd", "service_dir"]) {
    if (typeof config[key] !== "string" || !config[key]) throw new Error(`service config has no ${key}`);
  }
  if (!Array.isArray(config.command) || config.command.length === 0) throw new Error("service config has no command");
  return config;
}

function childEnvironment(config) {
  const passed = Object.fromEntries(TEST_PASS.filter(name => process.env[name] !== undefined)
    .map(name => [name, process.env[name]]));
  return cleanEnv({ ...passed, ...config.env });
}

function startDaemon(config, logs) {
  // Not hidden: a hidden child would get a console of its own, and Ctrl+Break
  // only reaches a process sharing this host's headless console.
  const child = rememberSpawn(spawn(config.command[0], config.command.slice(1), {
    cwd: config.cwd,
    env: childEnvironment(config),
    stdio: ["ignore", "pipe", "pipe"],
  }));
  child.stdout?.on("data", chunk => logs.out.write(chunk));
  child.stderr?.on("data", chunk => logs.err.write(chunk));
  const exited = new Promise((resolve) => {
    // "close" waits for the pipes to drain, so the last line reaches the log.
    child.once("close", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
    child.once("error", (error) => {
      logs.err.write(`service-host: cannot start ${config.command[0]}: ${error.message}\n`);
      resolve(-1);
    });
  });
  return { child, exited };
}

// A daemon has no window to close, so a stop is asked for with Ctrl+Break, which
// Node surfaces as SIGBREAK. POSIX is only here for the tests.
function requestDaemonStop(child, logs) {
  if (process.platform !== "win32") return child.kill("SIGTERM");
  try {
      const koffi = require("koffi");
      const generate = koffi.load("kernel32.dll").func("__stdcall", "GenerateConsoleCtrlEvent", "int", ["uint32_t", "uint32_t"]);
      // Group 0 is every process on this console: this host, which ignores it, and the daemon.
      return generate(CTRL_BREAK_EVENT, 0) !== 0;
  } catch (error) {
    logs.err.write(`service-host: cannot send Ctrl+Break: ${error.message}\n`);
    return false;
  }
}

function acquireLock(file) {
  const content = () => {
    const { pid, startedAt } = processIdentity();
    return startedAt === null ? `${pid}\n` : `${pid} ${startedAt}\n`;
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let fd;
    try {
      fd = fs.openSync(file, "wx", 0o600);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let holder = "";
      try {
        holder = fs.readFileSync(file, "utf8").trim();
      } catch {
        continue;
      }
      const [pid, startedAt] = holder.split(/\s+/);
      if (processAlive(Number.parseInt(pid, 10), startedAt ?? null)) return null;
      fs.rmSync(file, { force: true });
      continue;
    }
    fs.writeSync(fd, content());
    fs.closeSync(fd);
    return () => fs.rmSync(file, { force: true });
  }
  return null;
}

function hostPaths(config) {
  const base = path.join(config.service_dir, config.name);
  return {
    state: `${base}.state.json`,
    disabled: `${base}.disabled`,
    stop: `${base}.stop`,
    lock: `${base}.lock`,
    log: `${base}.log`,
    err: `${base}.err`,
  };
}

async function runOnce(config) {
  const paths = hostPaths(config);
  const logs = { out: createRotatingLog(paths.log), err: createRotatingLog(paths.err) };
  const { exited } = startDaemon(config, logs);
  const code = await exited;
  logs.out.close();
  logs.err.close();
  return code;
}

async function supervise(config) {
  const paths = hostPaths(config);
  if (fs.existsSync(paths.disabled) || fs.existsSync(paths.stop)) return 0;
  const releaseLock = acquireLock(paths.lock);
  if (!releaseLock) return 0;

  const logs = { out: createRotatingLog(paths.log), err: createRotatingLog(paths.err) };
  const identity = processIdentity();
  const say = message => logs.err.write(`service-host: ${message}\n`);
  const writeState = (state, fields = {}) => writeFileAtomicSync(paths.state, `${JSON.stringify({
    state,
    last_exit_code: null,
    next_start_at: null,
    child_pid: null,
    ...fields,
    host_pid: identity.pid,
    host_started_at: identity.startedAt,
    updated_at: new Date().toISOString(),
  })}\n`);

  const backoff = createBackoff();
  let lastExit = null;
  let stopRequested = false;
  let consoleClosing = false;
  let wake = () => {};
  let current = null;
  let forceStop = null;

  // A stop is the same whether the daemon is up or waiting for its next start.
  const requestStop = () => {
    if (stopRequested) return;
    stopRequested = true;
    say("stop requested");
    wake();
    if (!current) return;
    const { child } = current;
    const asked = requestDaemonStop(child, logs);
    forceStop = setTimeout(() => {
      say("daemon did not stop in time; ending it");
      killTree(child);
    }, asked ? STOP_GRACE_MS : 0);
  };
  const watcher = setInterval(() => {
    if (fs.existsSync(paths.stop)) requestStop();
  }, STOP_POLL_MS / TIME_SCALE);
  // Without these handlers the Ctrl+Break above would end this host too.
  process.on("SIGBREAK", () => {});
  process.on("SIGINT", () => {});
  process.on("SIGTERM", () => requestStop());
  // Windows raises this when the console goes away, at log off. It sends the same
  // event to the daemon, which then exits 0, and that is no decision to stay off.
  process.on("SIGHUP", () => {
    consoleClosing = true;
    wake();
  });

  const finish = (code) => {
    clearInterval(watcher);
    clearTimeout(forceStop);
    logs.out.close();
    logs.err.close();
    releaseLock();
    return code;
  };
  const markDisabled = () => {
    fs.writeFileSync(paths.disabled, `${new Date().toISOString()}\n`);
    fs.rmSync(paths.stop, { force: true });
    writeState("disabled", { last_exit_code: lastExit });
  };

  // A failure here, such as a state folder that has gone, must still end this
  // process: its stop-file timer would otherwise keep it alive with no daemon,
  // holding the lock that makes every watchdog run exit.
  try {
  for (;;) {
    current = startDaemon(config, logs);
    const { pid } = current.child;
    writeState(backoff.crashloop ? "crashloop" : "running", { last_exit_code: lastExit, child_pid: pid ?? null });
    const stable = setTimeout(() => {
      backoff.reset();
      writeState("running", { last_exit_code: lastExit, child_pid: pid ?? null });
    }, STABLE_UPTIME_MS / TIME_SCALE);

    lastExit = await current.exited;
    clearTimeout(stable);
    current = null;

    if (lastExit === 0 && !stopRequested && !consoleClosing) {
      await delay(CLEAN_EXIT_SETTLE_MS);
    }
    if (consoleClosing) {
      say(`console closed; daemon exited ${lastExit}`);
      return finish(0);
    }
    if (stopRequested || lastExit === 0) {
      say(`daemon exited ${lastExit}; staying stopped`);
      markDisabled();
      return finish(0);
    }

    const waitMs = backoff.fail(Date.now() * TIME_SCALE);
    const state = backoff.crashloop ? "crashloop" : "backoff";
    const nextStart = Date.now() + waitMs / TIME_SCALE;
    writeState(state, { last_exit_code: lastExit, next_start_at: new Date(nextStart).toISOString() });
    say(`daemon exited ${lastExit}; ${state}; restart in ${waitMs / 1000}s`);
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, waitMs / TIME_SCALE);
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    wake = () => {};
    if (consoleClosing) return finish(0);
    if (stopRequested) {
      markDisabled();
      return finish(0);
    }
  }
  } catch (error) {
    console.error(`service-host: ${error.message}`);
    return finish(1);
  }
}

async function main() {
  const { configFile, once } = parseArguments(process.argv.slice(2));
  const config = loadConfig(configFile);
  return once ? runOnce(config) : supervise(config);
}

if (require.main === module) {
  main().then((code) => {
    process.exit(code);
  }, (error) => {
    console.error(`service-host: ${error.message}`);
    process.exit(1);
  });
}

module.exports = { createBackoff, createRotatingLog };
