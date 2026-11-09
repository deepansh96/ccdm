"use strict";

// One ConPTY session: the program under a pseudo-console, a headless terminal
// holding a readable copy of its screen, and the waits that watch that screen.
// node-pty and xterm are optional native packages, loaded when a session starts.
const fs = require("node:fs");
const path = require("node:path");

const COLS = 200;
const ROWS = 50;
const SCROLLBACK = 10000;
const WATCH_MS = 100;
// How long the console gets to flush and close once its program has gone.
const DRAIN_MS = 3000;
const PAUSE_ABOVE_CHARS = 1024 * 1024;
const RESUME_BELOW_CHARS = 128 * 1024;

// tmux key names; anything else is sent as text.
const KEYS = new Map([
  ["Enter", "\r"], ["C-m", "\r"], ["Space", " "], ["Tab", "\t"], ["Escape", "\x1b"],
  ["BSpace", "\x7f"], ["C-c", "\x03"], ["C-d", "\x04"],
  ["Up", "\x1b[A"], ["Down", "\x1b[B"], ["Right", "\x1b[C"], ["Left", "\x1b[D"],
]);

function loadPackages() {
  try {
    return {
      spawnPty: require("node-pty").spawn,
      Terminal: require("@xterm/headless").Terminal,
      Unicode11Addon: require("@xterm/addon-unicode11").Unicode11Addon,
    };
  } catch (error) {
    throw new Error(`PTY sessions need the optional native packages node-pty and @xterm/*, which did not load (${error.code ?? error.message}); run npm ci`);
  }
}

function loadSerializer(term) {
  try {
    const { SerializeAddon } = require("@xterm/addon-serialize");
    const addon = new SerializeAddon();
    term.loadAddon(addon);
    return addon;
  } catch (error) {
    throw new Error(`attach needs the optional package @xterm/addon-serialize, which did not load (${error.code ?? error.message}); run npm ci`);
  }
}

function isFile(file) {
  return fs.statSync(file, { throwIfNoEntry: false })?.isFile() ?? false;
}

// The session's PATH decides, not the host's. Checked up front because a
// CreateProcess failure inside node-pty leaves its OpenConsole running.
function resolveProgram(program, env, cwd) {
  if (!fs.statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`the working directory does not exist: ${cwd}`);
  }
  const pathKey = Object.keys(env).find(key => key.toUpperCase() === "PATH");
  const directories = path.basename(program) === program
    ? (env[pathKey] ?? "").split(";").filter(Boolean)
    : [cwd];
  const names = path.extname(program) ? [program] : [program, `${program}.exe`];
  for (const directory of directories) {
    for (const name of names) {
      const candidate = path.resolve(directory, name);
      if (isFile(candidate)) return candidate;
    }
  }
  throw new Error(`cannot find the program: ${program}`);
}

// Rows of the buffer as text. Only empty cells are trimmed here, so a row that
// wraps keeps the spaces it really printed for when `join` glues it to the next.
function readRows(buffer, from, to) {
  const rows = [];
  for (let y = from; y < to; y += 1) {
    const line = buffer.getLine(y);
    if (!line) break;
    rows.push({ text: line.translateToString(true), wrapped: line.isWrapped });
  }
  return rows;
}

function renderRows(rows, join) {
  const lines = [];
  for (const { text, wrapped } of rows) {
    if (join && wrapped && lines.length > 0) lines[lines.length - 1] += text;
    else lines.push(text);
  }
  return lines.map(line => `${line.replace(/ +$/, "")}\n`).join("");
}

// Starts the program. `onEnd(exitCode)` fires once, after its last output has
// reached the screen; capture keeps working afterwards from a plain-text copy.
function startConsole({ argv, cwd = process.cwd(), env, job, log, onEnd }) {
  const { spawnPty, Terminal, Unicode11Addon } = loadPackages();
  const program = resolveProgram(argv[0], env, cwd);
  const term = new Terminal({ cols: COLS, rows: ROWS, scrollback: SCROLLBACK, allowProposedApi: true });
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = "11";
  const pty = spawnPty(program, argv.slice(1), { cols: COLS, rows: ROWS, cwd, env, useConpty: true, useConptyDll: true });
  // node-pty has no public way to do these three; its version is pinned exactly.
  const agent = pty._agent;
  // Writing into a console that just closed must not take the host down.
  agent.inSocket.on("error", () => {});
  pty.on("error", () => {});

  // After an exit node-pty stops the conout worker only if more output arrives, which it never does.
  const release = () => {
    try {
      pty.kill();
    } catch { /* Already closed. */ }
    agent._conoutSocketWorker.dispose();
  };

  try {
    // Right after spawn: the program cannot have started anything worth missing yet.
    job.assign(pty.pid);
  } catch (error) {
    release();
    term.dispose();
    throw error;
  }

  const stream = log ? fs.createWriteStream(log, { flags: "a" }) : null;
  stream?.on("error", () => {});
  const waits = new Set();
  // Set once the program has ended and the terminal has been let go.
  let frozen = null;
  let finishing = false;
  let serializer = null;
  const views = new Set();
  const afterFreeze = [];

  function slice(history) {
    const buffer = frozen ?? term.buffer.active;
    const top = frozen ? frozen.top : buffer.baseY;
    const from = history === true ? 0 : Math.max(0, top - Math.abs(Number(history) || 0));
    return frozen ? frozen.rows.slice(from) : readRows(buffer, from, buffer.length);
  }

  const screen = () => renderRows(slice(false), true);

  function send(keys, literal) {
    for (const key of keys) {
      const text = String(key);
      pty.write(literal ? text : KEYS.get(text) ?? text);
    }
  }

  function settle(waiter, matched) {
    if (!waits.delete(waiter)) return;
    clearTimeout(waiter.timer);
    waiter.resolve({ matched, ms: Math.round(performance.now() - waiter.started), screen: screen() });
  }

  // Check and send happen in one turn of the event loop, so the screen cannot
  // change between them.
  function checkWaits() {
    if (waits.size === 0) return;
    const text = screen();
    for (const waiter of [...waits]) {
      if (waiter.regex.test(text)) {
        send(waiter.thenSend, false);
        settle(waiter, true);
      }
    }
  }

  // Nothing can be sent to an ended program, so a wait that has keys to send fails.
  const endedMatch = (regex, thenSend) => thenSend.length === 0 && regex.test(screen());

  function wait({ regex, timeoutMs, thenSend }) {
    if (frozen) {
      const result = { matched: endedMatch(regex, thenSend), ms: 0, screen: screen() };
      return { promise: Promise.resolve(result), cancel() {} };
    }
    const waiter = { regex, thenSend, started: performance.now(), resolve: null, timer: null };
    const promise = new Promise(resolve => { waiter.resolve = resolve; });
    waiter.timer = setTimeout(() => settle(waiter, false), timeoutMs);
    waits.add(waiter);
    checkWaits();
    return { promise, cancel: () => settle(waiter, false) };
  }

  // An ended session has only its plain-text screen left to show.
  function frozenView() {
    return { snapshot: screen().replace(/\n+$/, "").replace(/\n/g, "\r\n"), cols: frozen.width, rows: frozen.height };
  }

  function resize(cols, rows) {
    if (finishing) return;
    try {
      pty.resize(cols, rows);
      term.resize(cols, rows);
    } catch { /* The program ended meanwhile. */ }
  }

  // A live view: onStart gets the screen as of now and onOutput everything after
  // it. Both follow the parser's order, so nothing is lost or shown twice.
  function view({ size, onStart, onOutput, onError }) {
    if (frozen) {
      onStart(frozenView());
      return () => {};
    }
    if (finishing) {
      afterFreeze.push(() => onStart(frozenView()));
      return () => {};
    }
    serializer ??= loadSerializer(term);
    let open = true;
    term.write("", () => {
      if (!open) return;
      try {
        if (size) resize(...size);
        const snapshot = serializer.serialize({ scrollback: 0 });
        views.add(onOutput);
        onStart({ snapshot, cols: term.cols, rows: term.rows });
      } catch (error) {
        onError(error);
      }
    });
    return () => {
      open = false;
      views.delete(onOutput);
    };
  }

  let pending = 0;
  let paused = false;
  pty.onData(data => {
    stream?.write(data);
    pending += data.length;
    if (!paused && pending > PAUSE_ABOVE_CHARS) {
      paused = true;
      pty.pause();
    }
    term.write(data, () => {
      pending -= data.length;
      if (paused && pending < RESUME_BELOW_CHARS) {
        paused = false;
        pty.resume();
      }
      for (const onOutput of views) onOutput(data);
      checkWaits();
    });
  });
  // The headless terminal answers terminal queries. The bundled OpenConsole
  // sends DA1 at startup and holds the program's first screen until it gets a reply.
  term.onData(reply => pty.write(reply));

  let watch = null;
  let fallback = null;
  function finish(code) {
    if (finishing) return;
    finishing = true;
    clearInterval(watch);
    clearTimeout(fallback);
    // The empty write's callback runs once everything before it has been parsed.
    term.write("", () => {
      const buffer = term.buffer.active;
      const rows = readRows(buffer, 0, buffer.length);
      const top = buffer.baseY;
      for (const waiter of [...waits]) settle(waiter, endedMatch(waiter.regex, waiter.thenSend));
      frozen = { rows, top, width: term.cols, height: term.rows };
      stream?.end();
      release();
      term.dispose();
      onEnd(agent.exitCode ?? code);
      for (const start of afterFreeze.splice(0)) start();
    });
  }

  // The output pipe closes when OpenConsole does, after its last client. A
  // session ends with its root program, so once that has gone the rest of the
  // Job goes too, which lets OpenConsole finish.
  pty.onExit(({ exitCode }) => finish(exitCode));
  watch = setInterval(() => {
    let rootAlive;
    try {
      rootAlive = job.pids().includes(pty.pid);
    } catch {
      return;
    }
    if (rootAlive) return;
    clearInterval(watch);
    try {
      job.terminate(1);
    } catch { /* It emptied on its own. */ }
    fallback = setTimeout(() => finish(1), DRAIN_MS);
  }, WATCH_MS);

  return {
    pid: pty.pid,
    send,
    wait,
    capture: ({ history = false, join = false }) => renderRows(slice(history), join),
    view,
    resize,
    resetSize: () => resize(COLS, ROWS),
    // The grace phase. Closing the input pipe makes OpenConsole shut down and
    // send its clients CTRL_CLOSE, which Node programs see as SIGHUP. pty.kill()
    // would call TerminateProcess on the program straight away.
    closeInput: () => agent.inSocket.destroy(),
  };
}

module.exports = { startConsole };
