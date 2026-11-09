"use strict";

// Finds the programs CCDM starts: Python, Node, Codex, Claude and Whisper.
// ccdmlib/platform/exe.py makes the same choices, and
// tests/e2e/platform-contract/tools.cases.js fails when the two disagree.
//
// On win32 a program found on PATH comes back as an absolute path, because the
// two languages start a bare name differently: Python's subprocess looks in
// System32 before PATH. A .cmd or .bat is never returned; those need a shell.
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const WIN32 = process.platform === "win32";
const STORE_STUB = /[\\/]windowsapps[\\/]/i;
const NEEDS_SHELL = /\.(?:cmd|bat)$/i;
const ABSOLUTE_WIN32 = /^(?:[a-zA-Z]:[\\/]|[\\/]{2}[^\\/])/;
const PROBE_TIMEOUT_MS = 10000;
const PRINT_EXECUTABLE = "import sys; print(sys.executable)";
const CODEX_PACKAGE = path.join("node_modules", "@openai", "codex");
const CODEX_TARGETS = { x64: "x86_64-pc-windows-msvc", arm64: "aarch64-pc-windows-msvc" };

const warned = new Set();
const probed = new Map();

function warn(message) {
  if (warned.has(message)) return;
  warned.add(message);
  process.stderr.write(`ccdm: ${message}\n`);
}

function notFound(message) {
  return Object.assign(new Error(message), { name: "ToolNotFound", code: "ENOENT" });
}

function isProgram(file) {
  try {
    // On win32 lstat, because a Store alias is a reparse point that cannot be followed.
    if (WIN32) return !fs.lstatSync(file).isDirectory();
    if (!fs.statSync(file).isFile()) return false;
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function pathDirectories() {
  const entries = (process.env.PATH || "").split(path.delimiter);
  if (!WIN32) return entries.filter(Boolean);
  // A relative entry would make the choice depend on the current directory.
  return entries.map(entry => entry.replace(/^"+|"+$/g, "")).filter(entry => ABSOLUTE_WIN32.test(entry));
}

// Every match on PATH, in order. On win32 only the .exe form counts.
function onPath(name) {
  const file = WIN32 ? `${name}.exe` : name;
  return pathDirectories().map(dir => path.join(dir, file)).filter(isProgram);
}

// The value of an environment override, or null when it is unset or unusable.
function override(variable, { rejectStoreStub = false } = {}) {
  const value = process.env[variable];
  if (!value) return null;
  if (!WIN32) return value;
  const reason = NEEDS_SHELL.test(value) ? "a .cmd or .bat cannot be started without a shell"
    : rejectStoreStub && STORE_STUB.test(value) ? "it is the Microsoft Store stub, not Python"
      : null;
  if (reason) {
    warn(`ignoring ${variable}=${value}: ${reason}`);
    return null;
  }
  if (/[\\/]/.test(value)) return value;
  const usable = onPath(value.replace(/\.exe$/i, "")).find(file => !(rejectStoreStub && STORE_STUB.test(file)));
  return usable ?? value;
}

// `PYTHONUTF8=1` for a Python child, which otherwise reads and prints in the Windows code page.
function utf8Env(env = process.env) {
  return { ...env, PYTHONUTF8: "1" };
}

// The trimmed output of a successful run, or null. Only a success is remembered,
// so one slow start under load cannot rule a program out for a long-lived service.
function probe(command, args, env = {}) {
  const key = JSON.stringify([command, args]);
  if (probed.has(key)) return probed.get(key);
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env: utf8Env({ ...process.env, ...env }),
    timeout: PROBE_TIMEOUT_MS,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) return null;
  const output = result.stdout.trim();
  probed.set(key, output);
  return output;
}

function pythonCommand() {
  for (const variable of ["CCDM_PYTHON", "CCDM_REMINDER_PYTHON"]) {
    const value = override(variable, { rejectStoreStub: true });
    if (value) return [value];
  }
  if (!WIN32) return ["python3"];
  const rejected = [];
  // The launcher only finds the interpreter, which then runs without it.
  for (const launcher of onPath("py")) {
    if (STORE_STUB.test(launcher)) {
      rejected.push(`${launcher} is the Microsoft Store stub, not Python.`);
      continue;
    }
    const interpreter = probe(launcher, ["-3", "-c", PRINT_EXECUTABLE]);
    if (interpreter && !STORE_STUB.test(interpreter)) return [interpreter];
    rejected.push(interpreter
      ? `${launcher} -3 runs ${interpreter}, under the Microsoft Store's WindowsApps folder.`
      : `${launcher} -3 did not run.`);
  }
  for (const interpreter of onPath("python")) {
    if (!STORE_STUB.test(interpreter)) return [interpreter];
    rejected.push(`${interpreter} is the Microsoft Store stub, not Python.`);
  }
  throw notFound(["No usable Python was found.", ...rejected, "Install Python, or set CCDM_PYTHON to its python.exe."].join(" "));
}

// Arguments for execFile or spawnSync that run Python with `args`.
function pythonInvocation(args, options = {}) {
  const [command, ...prefix] = pythonCommand();
  return [command, [...prefix, ...args], { windowsHide: true, ...options, env: utf8Env(options.env ?? process.env) }];
}

const plain = command => ({ command, args: [], env: {} });

function exists(file) {
  try {
    fs.lstatSync(file);
    return true;
  } catch {
    return false;
  }
}

// Node's own search: this directory's node_modules, then each parent's.
function installedPackage(from, scope, name) {
  for (let dir = from; ; dir = path.dirname(dir)) {
    if (path.basename(dir) !== "node_modules") {
      const candidate = path.join(dir, "node_modules", scope, name);
      if (exists(path.join(candidate, "package.json"))) return candidate;
    }
    if (dir === path.dirname(dir)) return null;
  }
}

function windowsArchitectures() {
  const native = (process.env.PROCESSOR_ARCHITEW6432 || process.env.PROCESSOR_ARCHITECTURE || "").toLowerCase();
  return native === "arm64" ? ["arm64", "x64"] : ["x64", "arm64"];
}

// The lookup in the package's own bin/codex.js, for whichever architecture is installed.
function vendoredCodex(packageDir) {
  for (const architecture of windowsArchitectures()) {
    const platformPackage = installedPackage(packageDir, "@openai", `codex-win32-${architecture}`);
    const vendor = path.join(platformPackage ?? packageDir, "vendor");
    const executable = path.join(vendor, CODEX_TARGETS[architecture], "bin", "codex.exe");
    if (exists(executable)) return executable;
  }
  return null;
}

function codexCommand() {
  const configured = override("CCDM_CODEX_PATH");
  if (configured && WIN32 && /\.js$/i.test(configured)) return { command: resolveCommand("node").command, args: [configured], env: {} };
  if (configured) return plain(configured);
  if (!WIN32) return plain("codex");
  // The npm shim is a .cmd, so it only says where the package is.
  const shimDir = pathDirectories().find(dir => exists(path.join(dir, "codex.cmd")) && exists(path.join(dir, CODEX_PACKAGE)));
  if (!shimDir) throw notFound("Codex was not found. Install @openai/codex with npm, or set CCDM_CODEX_PATH to codex.exe.");
  const packageDir = path.join(shimDir, CODEX_PACKAGE);
  const executable = vendoredCodex(packageDir);
  if (executable) {
    const env = { CODEX_MANAGED_BY_NPM: "1", CODEX_MANAGED_PACKAGE_ROOT: packageDir };
    if (probe(executable, ["--version"], env) !== null) return { command: executable, args: [], env };
  }
  return { command: resolveCommand("node").command, args: [path.join(packageDir, "bin", "codex.js")], env: {} };
}

function claudeCommand() {
  const local = path.join(os.homedir(), ".local", "bin", WIN32 ? "claude.exe" : "claude");
  if (isProgram(local)) return plain(local);
  const [found] = onPath("claude");
  if (found) return plain(found);
  throw notFound("Claude Code was not found in ~/.local/bin or on PATH.");
}

function whisperCommand() {
  const configured = override("CODEX_BRIDGE_AUDIO_TRANSCRIPTION_COMMAND");
  if (configured) return plain(configured);
  if (!WIN32) return plain("whisper");
  const [found] = onPath("whisper");
  if (found) return plain(found);
  throw notFound("whisper.exe was not found on PATH. Install it, or set CODEX_BRIDGE_AUDIO_TRANSCRIPTION_COMMAND.");
}

// `{ command, args, env }` for one tool; `env` is added to the child's environment.
function resolveCommand(name) {
  switch (name) {
    case "python": {
      const [command, ...args] = pythonCommand();
      return { command, args, env: {} };
    }
    case "node": return plain(override("CCDM_ROUTER_NODE") ?? process.execPath);
    case "codex": return codexCommand();
    case "claude": return claudeCommand();
    case "whisper": return whisperCommand();
    default: throw new TypeError(`unknown tool: ${name}`);
  }
}

module.exports = { pythonCommand, pythonInvocation, resolveCommand, utf8Env };
