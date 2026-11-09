#!/usr/bin/env node
"use strict";

// ccdm-host: the Windows session daemon and its tmux-shaped command line.
// `serve` runs the daemon; every other subcommand is a client of the running
// one and never starts it.
const fs = require("node:fs");
const path = require("node:path");

const { callHost } = require("./host/client.js");

const REQUEST_MARGIN_MS = 15000;
const DEFAULT_GRACE_MS = 3000;
const DEFAULT_WAIT_SECONDS = 30;

class UsageError extends Error {}

// `--` ends the flags. With stopAtPositional the first bare word does as well,
// so literal keys that start with a dash stay keys.
function parseFlags(args, { values = [], booleans = [], stopAtPositional = false } = {}) {
  const flags = {};
  const rest = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") {
      rest.push(...args.slice(index + 1));
      break;
    }
    if (values.includes(arg)) {
      index += 1;
      if (index >= args.length) throw new UsageError(`${arg} needs a value`);
      (flags[arg] ??= []).push(args[index]);
    } else if (booleans.includes(arg)) {
      flags[arg] = true;
    } else if (stopAtPositional && !arg.startsWith("-")) {
      rest.push(...args.slice(index));
      break;
    } else if (arg.startsWith("-") && arg !== "-") {
      throw new UsageError(`unknown option: ${arg}`);
    } else {
      rest.push(arg);
    }
  }
  return { flags, rest };
}

// The session a tmux target names: "=name", "name" or "=name:".
function target(flags) {
  const raw = flags["-t"]?.at(-1);
  if (!raw) throw new UsageError("-t <session> is required");
  return raw.replace(/^=/, "").replace(/:$/, "");
}

function envPair(text) {
  const separator = text.indexOf("=");
  if (separator <= 0) throw new UsageError(`expected KEY=VALUE, got: ${text}`);
  return [text.slice(0, separator), text.slice(separator + 1)];
}

function readEnvFile(file) {
  return fs.readFileSync(file, "utf8").split(/\r?\n/)
    .filter(line => line && !line.startsWith("#"))
    .map(envPair);
}

function format(text, session) {
  const values = { session_name: session.name, pane_pid: session.pid, session_created: session.created, session_kind: session.kind };
  return text.replace(/#\{(\w+)\}/g, (_, name) => String(values[name] ?? ""));
}

async function liveSessions() {
  return (await callHost("list")).sessions.filter(session => session.exit === null);
}

const write = text => process.stdout.write(text);

const COMMANDS = {
  async "new-session"(args) {
    const { flags, rest } = parseFlags(args, {
      values: ["-s", "-c", "-e", "--env-file", "--kind", "--log"], booleans: ["-d", "--no-pty"],
    });
    if (!flags["-s"]) throw new UsageError("-s <name> is required");
    if (!flags["--kind"]) throw new UsageError("--kind <project|thread|root|adhoc> is required");
    if (rest.length === 0) throw new UsageError("a command is required after --");
    const env = Object.fromEntries((flags["--env-file"] ?? []).flatMap(readEnvFile));
    Object.assign(env, Object.fromEntries((flags["-e"] ?? []).map(envPair)));
    await callHost("new", {
      name: flags["-s"].at(-1),
      argv: rest,
      cwd: flags["-c"]?.at(-1) ?? process.cwd(),
      env,
      pty: !flags["--no-pty"],
      kind: flags["--kind"].at(-1),
      ...(flags["--log"] ? { log: path.resolve(flags["--log"].at(-1)) } : {}),
    });
    return 0;
  },
  async "has-session"(args) {
    const { flags } = parseFlags(args, { values: ["-t"] });
    return (await callHost("has", { name: target(flags) })).live ? 0 : 1;
  },
  async "send-keys"(args) {
    const { flags, rest } = parseFlags(args, { values: ["-t"], booleans: ["-l"], stopAtPositional: true });
    await callHost("send", { name: target(flags), keys: rest, literal: Boolean(flags["-l"]) });
    return 0;
  },
  async "capture-pane"(args) {
    const { flags } = parseFlags(args, { values: ["-t", "-S"], booleans: ["-p", "-J"] });
    const start = flags["-S"]?.at(-1);
    let history = false;
    if (start === "-") history = true;
    else if (start !== undefined) history = Math.abs(Number(start));
    const { text } = await callHost("capture", { name: target(flags), history, join: Boolean(flags["-J"]) });
    write(text);
    return 0;
  },
  // Waits inside the host for the screen to match, then sends the keys there too.
  async "wait-for"(args) {
    const { flags } = parseFlags(args, { values: ["-t", "--regex", "--timeout", "--then-send"] });
    const regex = flags["--regex"]?.at(-1);
    if (!regex) throw new UsageError("--regex <pattern> is required");
    const seconds = flags["--timeout"] ? Number(flags["--timeout"].at(-1)) : DEFAULT_WAIT_SECONDS;
    if (!Number.isFinite(seconds) || seconds < 0) throw new UsageError("--timeout needs a number of seconds");
    const timeoutMs = Math.round(seconds * 1000);
    const { matched, screen } = await callHost(
      "wait",
      { name: target(flags), regex, timeoutMs, thenSend: flags["--then-send"] ?? [] },
      { timeoutMs: timeoutMs + REQUEST_MARGIN_MS },
    );
    write(screen);
    return matched ? 0 : 1;
  },
  async "kill-session"(args) {
    const { flags } = parseFlags(args, { values: ["-t", "--grace"] });
    const graceMs = flags["--grace"] ? Number(flags["--grace"].at(-1)) : DEFAULT_GRACE_MS;
    if (!Number.isFinite(graceMs) || graceMs < 0) throw new UsageError("--grace needs a number of milliseconds");
    await callHost("kill", { name: target(flags), graceMs }, { timeoutMs: graceMs + REQUEST_MARGIN_MS });
    return 0;
  },
  async "list-sessions"(args) {
    const { flags } = parseFlags(args, { values: ["-F"] });
    const pattern = flags["-F"]?.at(-1) ?? "#{session_name}: #{session_kind} #{pane_pid}";
    for (const session of await liveSessions()) write(`${format(pattern, session)}\n`);
    return 0;
  },
  async "display-message"(args) {
    const { flags, rest } = parseFlags(args, { values: ["-t"], booleans: ["-p"] });
    if (rest.length === 0) throw new UsageError("a format string is required");
    const name = target(flags);
    const session = (await liveSessions()).find(entry => entry.name === name);
    if (!session) {
      process.stderr.write(`no session named ${name}\n`);
      return 1;
    }
    write(`${format(rest.join(" "), session)}\n`);
    return 0;
  },
  async pids(args) {
    const { flags } = parseFlags(args, { values: ["-t"] });
    for (const pid of (await callHost("pids", { name: target(flags) })).pids) write(`${pid}\n`);
    return 0;
  },
  async shutdown() {
    await callHost("shutdown", {}, { timeoutMs: 60000 });
    return 0;
  },
};

async function serveCommand(args) {
  if (process.platform !== "win32") {
    process.stderr.write("ccdm-host runs on Windows; other platforms use tmux\n");
    return 1;
  }
  const { flags } = parseFlags(args, { booleans: ["--allow-in-job"] });
  // Without koffi the host cannot make Jobs or tell itself apart from a stale lock.
  try {
    require("./platform/process.js").processIdentity();
  } catch (error) {
    process.stderr.write(`ccdm-host needs the optional native package koffi, which did not load (${error.code ?? error.message}); run npm ci\n`);
    return 1;
  }
  const { serve } = require("./host/server.js");
  return serve({ allowInJob: Boolean(flags["--allow-in-job"]) });
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  try {
    if (command === "serve") {
      const code = await serveCommand(args);
      if (code !== null) process.exitCode = code;
      return;
    }
    const handler = COMMANDS[command];
    if (!handler) {
      process.stderr.write(`usage: ccdm-host <serve|${Object.keys(COMMANDS).join("|")}>\n`);
      process.exitCode = 2;
      return;
    }
    process.exitCode = await handler(args);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = error instanceof UsageError ? 2 : 1;
  }
}

main();
