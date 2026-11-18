// Node's scripts/platform/tools.js and Python's ccdmlib/platform/exe.py pick the
// same program for the same environment and PATH.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { fixtureLauncher } from "../support/platform.js";

const WIN = process.platform === "win32";
const EXE = WIN ? ".exe" : "";
const NODE_DIR = path.dirname(process.execPath);
const WIN_TARGET = { x64: "x86_64-pc-windows-msvc", arm64: "aarch64-pc-windows-msvc" };
const STORE_MESSAGE = /Microsoft Store/;

const python = { node: "tools.pythonCommand", python: "exe.python" };
const tool = name => ({ node: "tools.resolveCommand", nodeArgs: [name], python: `exe.${name}`, pythonArgs: [] });
const plain = command => ({ command, args: [], env: {} });

// A POSIX child is started through the PATH it is given, so the system's stays behind the fixtures.
const searchPath = (...dirs) => [...dirs, ...(WIN ? [] : [process.env.PATH])].join(path.delimiter);

function mkdir(...parts) {
  const dir = path.join(...parts);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function touch(file) {
  mkdir(path.dirname(file));
  fs.writeFileSync(file, "", { mode: 0o755 });
  return file;
}

// A real program that runs `source` under Node and can be found on PATH.
function program(dir, name, source) {
  mkdir(dir);
  const script = path.join(dir, `${name}-program.cjs`);
  fs.writeFileSync(script, source);
  if (WIN) {
    fs.copyFileSync(fixtureLauncher(), path.join(dir, `${name}.exe`));
    fs.writeFileSync(path.join(dir, `${name}.shim`), `${process.execPath}\n${script}\n`);
    return path.join(dir, `${name}.exe`);
  }
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/bin/sh\nexec '${process.execPath}' '${script}' "$@"\n`, { mode: 0o755 });
  return file;
}

// A `py.exe` that answers `-3 -c ...` with the interpreter path it is given.
function pyLauncher(dir, interpreter) {
  return program(dir, "py", `
if (process.argv[2] !== "-3") process.exit(3);
process.stdout.write(${JSON.stringify(`${interpreter}\r\n`)});
`);
}

const VERSION_OK = 'process.stdout.write("codex-cli 0.0.0\\n");';
const VERSION_FAILS = "process.exit(1);";

// An npm global install: the .cmd shim, the package, and optionally its native binary.
function npmInstall(ctx, { architecture = "x64", version = VERSION_OK, nested = false, native = true } = {}) {
  const npm = mkdir(ctx.dir, "npm");
  touch(path.join(npm, "codex.cmd"));
  const packageDir = mkdir(npm, "node_modules", "@openai", "codex");
  fs.writeFileSync(path.join(packageDir, "package.json"), "{}");
  touch(path.join(packageDir, "bin", "codex.js"));
  if (!native) return { npm, packageDir };
  const parent = nested ? packageDir : npm;
  const platformPackage = mkdir(parent, "node_modules", "@openai", `codex-win32-${architecture}`);
  fs.writeFileSync(path.join(platformPackage, "package.json"), "{}");
  const binDir = path.join(platformPackage, "vendor", WIN_TARGET[architecture], "bin");
  return { npm, packageDir, executable: program(binDir, "codex", version) };
}

const managedCodex = (executable, packageDir) => ({
  command: executable,
  args: [],
  env: { CODEX_MANAGED_BY_NPM: "1", CODEX_MANAGED_PACKAGE_ROOT: packageDir },
});

// The real resolver script, started as the launchers start it, with no help finding its imports.
function resolveHome(ctx, codexHome, home = ctx.home) {
  const registry = path.join(ctx.dir, "registry.json");
  fs.writeFileSync(registry, JSON.stringify({ projects: { demo: { codex_home: codexHome } } }));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(CCDM_|HOME$|USERPROFILE$|PYTHONPATH$)/i.test(key)));
  if (home !== null) Object.assign(env, { HOME: home, USERPROFILE: home });
  return spawnSync(ctx.python, [path.join(ctx.root, "scripts", "resolve-codex-home.py"), registry, "demo"], {
    encoding: "utf8", env, windowsHide: true,
  });
}

const RECORDER = `
const fs = require("node:fs");
fs.writeFileSync(process.env.RECORD_TO, JSON.stringify({ utf8: process.env.PYTHONUTF8, argv: process.argv.slice(2) }));
process.stdout.write(process.env.RECORD_REPLY || "");
`;

// Runs `source` with CCDM_PYTHON set to a program that records how it was started.
async function recordedPython(ctx, source, reply = "") {
  const record = path.join(ctx.dir, "python-started.json");
  const env = { CCDM_PYTHON: program(mkdir(ctx.dir, "recorder"), "recorder", RECORDER), RECORD_TO: record, RECORD_REPLY: reply };
  const result = await ctx.nodeScript(source, [ctx.root, ctx.dir], { env });
  assert.equal(result.code, 0, result.stderr);
  return JSON.parse(fs.readFileSync(record, "utf8"));
}

const NODE_CALLERS = [
  "conversation-reminder-adapter.js",
  "conversation-reminder-observer.js",
  "router/reminders.js",
  "router/resume.js",
];
const EXPANDER_CALLERS = [
  "guest-access.js",
  "model-info.js",
  "router/paths.js",
  "router/resume.js",
  "conversation-resolver.js",
  "export-discord-range.js",
];
const source = (ctx, file) => fs.readFileSync(path.join(ctx.root, "scripts", file), "utf8");

// Each stub path is under a WindowsApps folder, and is empty, so running one would fail.
const storeStub = (ctx, name) => touch(path.join(ctx.dir, "WindowsApps", `${name}.exe`));

const interpreter = ctx => path.join(ctx.dir, "real", `python${EXE}`);

export default [
  // Python
  {
    name: "CCDM_PYTHON wins over the old alias",
    ...python,
    env: ctx => ({ CCDM_PYTHON: path.join(ctx.dir, "a"), CCDM_REMINDER_PYTHON: path.join(ctx.dir, "b") }),
    value: ctx => [path.join(ctx.dir, "a")],
  },
  {
    name: "CCDM_REMINDER_PYTHON still works on its own",
    ...python,
    env: ctx => ({ CCDM_REMINDER_PYTHON: path.join(ctx.dir, "b") }),
    value: ctx => [path.join(ctx.dir, "b")],
  },
  {
    name: "an empty CCDM_PYTHON counts as unset",
    ...python,
    env: ctx => ({ CCDM_PYTHON: "", CCDM_REMINDER_PYTHON: path.join(ctx.dir, "b") }),
    value: ctx => [path.join(ctx.dir, "b")],
  },
  {
    name: "an override is not checked, so a missing interpreter still fails at spawn",
    ...python,
    env: { CCDM_PYTHON: "/missing/python" },
    value: ["/missing/python"],
  },
  { name: "POSIX runs python3 from PATH", only: "posix", ...python, value: ["python3"] },
  {
    name: "win32 uses the interpreter py -3 runs",
    only: "win32",
    ...python,
    setup: ctx => pyLauncher(mkdir(ctx.dir, "launcher"), interpreter(ctx)),
    env: ctx => ({ PATH: path.join(ctx.dir, "launcher") }),
    value: ctx => [interpreter(ctx)],
  },
  {
    name: "win32 prefers py -3 over python on PATH",
    only: "win32",
    ...python,
    setup: ctx => {
      pyLauncher(mkdir(ctx.dir, "launcher"), interpreter(ctx));
      touch(path.join(ctx.dir, "later", "python.exe"));
    },
    env: ctx => ({ PATH: `${path.join(ctx.dir, "later")};${path.join(ctx.dir, "launcher")}` }),
    value: ctx => [interpreter(ctx)],
  },
  {
    name: "win32 falls back to python on PATH",
    only: "win32",
    ...python,
    setup: ctx => touch(interpreter(ctx)),
    env: ctx => ({ PATH: path.dirname(interpreter(ctx)) }),
    value: ctx => [interpreter(ctx)],
  },
  {
    name: "win32 rejects a Store stub and uses the next python",
    only: "win32",
    ...python,
    setup: ctx => {
      storeStub(ctx, "python");
      touch(interpreter(ctx));
    },
    env: ctx => ({ PATH: `${path.join(ctx.dir, "WindowsApps")};${path.dirname(interpreter(ctx))}` }),
    value: ctx => [interpreter(ctx)],
  },
  {
    name: "win32 rejects a py that is a Store stub and uses the next candidate",
    only: "win32",
    ...python,
    setup: ctx => {
      storeStub(ctx, "py");
      touch(interpreter(ctx));
    },
    env: ctx => ({ PATH: `${path.join(ctx.dir, "WindowsApps")};${path.dirname(interpreter(ctx))}` }),
    value: ctx => [interpreter(ctx)],
  },
  {
    name: "win32 rejects a py -3 that runs a Store Python and uses the next candidate",
    only: "win32",
    ...python,
    setup: ctx => {
      pyLauncher(mkdir(ctx.dir, "launcher"), "C:\\Users\\x\\AppData\\Local\\Microsoft\\WindowsApps\\python3.11.exe");
      touch(interpreter(ctx));
    },
    env: ctx => ({ PATH: `${path.join(ctx.dir, "launcher")};${path.dirname(interpreter(ctx))}` }),
    value: ctx => [interpreter(ctx)],
  },
  {
    name: "win32 skips a py -3 that fails",
    only: "win32",
    ...python,
    setup: ctx => {
      program(mkdir(ctx.dir, "launcher"), "py", "process.exit(1);");
      touch(interpreter(ctx));
    },
    env: ctx => ({ PATH: `${path.join(ctx.dir, "launcher")};${path.dirname(interpreter(ctx))}` }),
    value: ctx => [interpreter(ctx)],
  },
  {
    name: "win32 explains a Store stub when nothing else is usable",
    only: "win32",
    ...python,
    setup: ctx => storeStub(ctx, "python"),
    env: ctx => ({ PATH: path.join(ctx.dir, "WindowsApps") }),
    throws: ["ENOENT"],
    check: ({ node: nodeOutcome, python: pythonOutcome }, ctx) => {
      for (const outcome of [nodeOutcome, pythonOutcome]) {
        assert.match(outcome.error.message, STORE_MESSAGE);
        assert.ok(outcome.error.message.includes(path.join(ctx.dir, "WindowsApps", "python.exe")), outcome.error.message);
      }
    },
  },
  {
    name: "win32 ignores a Store stub override with a message on stderr",
    only: "win32",
    ...python,
    setup: ctx => storeStub(ctx, "python"),
    env: ctx => ({ CCDM_PYTHON: path.join(ctx.dir, "WindowsApps", "python.exe"), CCDM_REMINDER_PYTHON: path.join(ctx.dir, "b") }),
    value: ctx => [path.join(ctx.dir, "b")],
    check: async (_outcomes, ctx) => {
      const env = { CCDM_PYTHON: path.join(ctx.dir, "WindowsApps", "python.exe"), CCDM_REMINDER_PYTHON: path.join(ctx.dir, "b") };
      const fromNode = await ctx.nodeScript(
        `require(${JSON.stringify(path.join(ctx.root, "scripts", "platform", "tools.js"))}).pythonCommand();`, [], { env });
      assert.match(fromNode.stderr, /ignoring CCDM_PYTHON=.*Microsoft Store/);
      const fromPython = await ctx.pythonScript("from ccdmlib.platform import exe; exe.python()", [], { env });
      assert.match(fromPython.stderr, /ignoring CCDM_PYTHON=.*Microsoft Store/);
    },
  },
  {
    name: "win32 rejects a .cmd override",
    only: "win32",
    ...python,
    env: ctx => ({ CCDM_PYTHON: path.join(ctx.dir, "python.cmd"), CCDM_REMINDER_PYTHON: path.join(ctx.dir, "b") }),
    value: ctx => [path.join(ctx.dir, "b")],
  },
  {
    name: "win32 never takes a python.cmd from PATH",
    only: "win32",
    ...python,
    setup: ctx => touch(path.join(ctx.dir, "shims", "python.cmd")),
    env: ctx => ({ PATH: path.join(ctx.dir, "shims") }),
    throws: ["ENOENT"],
  },
  {
    name: "win32 resolves a bare override through PATH, so subprocess cannot pick a System32 copy",
    only: "win32",
    ...python,
    setup: ctx => touch(path.join(ctx.dir, "tools", "mypython.exe")),
    env: ctx => ({ CCDM_PYTHON: "mypython", PATH: path.join(ctx.dir, "tools") }),
    value: ctx => [path.join(ctx.dir, "tools", "mypython.exe")],
  },
  {
    name: "win32 ignores a relative PATH entry",
    only: "win32",
    ...python,
    setup: ctx => touch(path.join(ctx.work, "tools", "python.exe")),
    env: { PATH: "tools" },
    throws: ["ENOENT"],
  },

  // Node
  {
    name: "node honours CCDM_ROUTER_NODE",
    ...tool("node"),
    env: ctx => ({ CCDM_ROUTER_NODE: path.join(ctx.dir, "n") }),
    value: ctx => plain(path.join(ctx.dir, "n")),
  },
  {
    name: "node is this runtime, which Python finds on PATH",
    ...tool("node"),
    env: () => ({ PATH: searchPath(NODE_DIR) }),
    value: () => plain(process.execPath),
  },
  {
    name: "win32 rejects a node.cmd override",
    only: "win32",
    ...tool("node"),
    env: ctx => ({ CCDM_ROUTER_NODE: path.join(ctx.dir, "node.cmd"), PATH: NODE_DIR }),
    value: () => plain(process.execPath),
  },

  // Codex
  {
    name: "codex honours CCDM_CODEX_PATH",
    ...tool("codex"),
    env: ctx => ({ CCDM_CODEX_PATH: path.join(ctx.dir, "c") }),
    value: ctx => plain(path.join(ctx.dir, "c")),
  },
  { name: "POSIX runs codex from PATH", only: "posix", ...tool("codex"), value: plain("codex") },
  {
    name: "win32 CCDM_CODEX_PATH wins over an npm install",
    only: "win32",
    ...tool("codex"),
    setup: ctx => npmInstall(ctx),
    env: (ctx, state) => ({ CCDM_CODEX_PATH: path.join(ctx.dir, "c.exe"), PATH: `${state.npm};${NODE_DIR}` }),
    value: ctx => plain(path.join(ctx.dir, "c.exe")),
  },
  {
    name: "win32 runs a codex.js override with node",
    only: "win32",
    ...tool("codex"),
    env: ctx => ({ CCDM_CODEX_PATH: path.join(ctx.dir, "codex.js"), PATH: NODE_DIR }),
    value: ctx => ({ command: process.execPath, args: [path.join(ctx.dir, "codex.js")], env: {} }),
  },
  {
    name: "win32 finds codex.exe in a platform package beside the npm package",
    only: "win32",
    ...tool("codex"),
    setup: ctx => npmInstall(ctx),
    env: (_ctx, state) => ({ PATH: `${state.npm};${NODE_DIR}` }),
    value: (_ctx, state) => managedCodex(state.executable, state.packageDir),
  },
  {
    name: "win32 finds codex.exe in a platform package nested in the npm package",
    only: "win32",
    ...tool("codex"),
    setup: ctx => npmInstall(ctx, { nested: true }),
    env: (_ctx, state) => ({ PATH: `${state.npm};${NODE_DIR}` }),
    value: (_ctx, state) => managedCodex(state.executable, state.packageDir),
  },
  {
    name: "win32 finds the arm64 platform package on an arm64 machine",
    only: "win32",
    ...tool("codex"),
    setup: ctx => npmInstall(ctx, { architecture: "arm64" }),
    env: (_ctx, state) => ({ PATH: `${state.npm};${NODE_DIR}`, PROCESSOR_ARCHITEW6432: "ARM64" }),
    value: (_ctx, state) => managedCodex(state.executable, state.packageDir),
  },
  {
    name: "win32 falls back to node codex.js when codex.exe fails --version",
    only: "win32",
    ...tool("codex"),
    setup: ctx => npmInstall(ctx, { version: VERSION_FAILS }),
    env: (_ctx, state) => ({ PATH: `${state.npm};${NODE_DIR}` }),
    value: (_ctx, state) => ({ command: process.execPath, args: [path.join(state.packageDir, "bin", "codex.js")], env: {} }),
  },
  {
    name: "win32 falls back to node codex.js with no platform package",
    only: "win32",
    ...tool("codex"),
    setup: ctx => npmInstall(ctx, { native: false }),
    env: (_ctx, state) => ({ PATH: `${state.npm};${NODE_DIR}` }),
    value: (_ctx, state) => ({ command: process.execPath, args: [path.join(state.packageDir, "bin", "codex.js")], env: {} }),
  },
  {
    name: "win32 rejects a codex.cmd override and uses the npm package",
    only: "win32",
    ...tool("codex"),
    setup: ctx => npmInstall(ctx),
    env: (ctx, state) => ({ CCDM_CODEX_PATH: path.join(state.npm, "codex.cmd"), PATH: `${state.npm};${NODE_DIR}` }),
    value: (_ctx, state) => managedCodex(state.executable, state.packageDir),
  },
  {
    name: "win32 never returns a codex.cmd without its package",
    only: "win32",
    ...tool("codex"),
    setup: ctx => touch(path.join(ctx.dir, "npm", "codex.cmd")),
    env: ctx => ({ PATH: path.join(ctx.dir, "npm") }),
    throws: ["ENOENT"],
  },

  // Claude
  {
    name: "claude prefers ~/.local/bin over PATH",
    ...tool("claude"),
    setup: ctx => {
      touch(path.join(ctx.home, ".local", "bin", `claude${EXE}`));
      touch(path.join(ctx.dir, "bin", `claude${EXE}`));
    },
    env: ctx => ({ PATH: searchPath(path.join(ctx.dir, "bin")) }),
    value: ctx => plain(path.join(ctx.home, ".local", "bin", `claude${EXE}`)),
  },
  {
    name: "claude falls back to PATH",
    ...tool("claude"),
    setup: ctx => touch(path.join(ctx.dir, "bin", `claude${EXE}`)),
    env: ctx => ({ PATH: searchPath(path.join(ctx.dir, "bin")) }),
    value: ctx => plain(path.join(ctx.dir, "bin", `claude${EXE}`)),
  },
  {
    name: "win32 never takes a claude.cmd from PATH",
    only: "win32",
    ...tool("claude"),
    setup: ctx => touch(path.join(ctx.dir, "bin", "claude.cmd")),
    env: ctx => ({ PATH: path.join(ctx.dir, "bin") }),
    throws: ["ENOENT"],
  },

  // Whisper
  {
    name: "whisper honours its override",
    ...tool("whisper"),
    env: ctx => ({ CODEX_BRIDGE_AUDIO_TRANSCRIPTION_COMMAND: path.join(ctx.dir, "w") }),
    value: ctx => plain(path.join(ctx.dir, "w")),
  },
  { name: "POSIX runs whisper from PATH", only: "posix", ...tool("whisper"), value: plain("whisper") },
  {
    name: "win32 finds whisper.exe on PATH",
    only: "win32",
    ...tool("whisper"),
    setup: ctx => touch(path.join(ctx.dir, "bin", "whisper.exe")),
    env: ctx => ({ PATH: path.join(ctx.dir, "bin") }),
    value: ctx => plain(path.join(ctx.dir, "bin", "whisper.exe")),
  },
  {
    name: "win32 reports a missing whisper",
    only: "win32",
    ...tool("whisper"),
    env: ctx => ({ PATH: ctx.dir }),
    throws: ["ENOENT"],
  },

  // PYTHONUTF8
  {
    name: "utf8Env adds PYTHONUTF8 and keeps the rest",
    node: "tools.utf8Env",
    args: [{ KEEP: "1", PYTHONUTF8: "0" }],
    value: { KEEP: "1", PYTHONUTF8: "1" },
  },
  {
    name: "reminders.js starts Python through the resolver with PYTHONUTF8",
    check: async (_outcomes, ctx) => {
      const started = await recordedPython(ctx, `
const [root, dir] = process.argv.slice(1);
require(root + "/scripts/router/reminders.js")
  .assignmentChanged("demo", { registryFile: dir + "/registry.json" })
  .catch(error => { console.error(error); process.exit(1); });`);
      assert.equal(started.utf8, "1");
      assert.ok(started.argv[0].endsWith("conversation-reminder-service.py"), started.argv[0]);
    },
  },
  {
    name: "resume.js starts Python through the resolver with PYTHONUTF8",
    check: async (_outcomes, ctx) => {
      const started = await recordedPython(ctx, `
const [root, dir] = process.argv.slice(1);
require(root + "/scripts/router/resume.js")
  .resolveResume("demo", { type: "codex", path: dir }, { registryFile: dir + "/registry.json" });`, ctx.dir);
      assert.equal(started.utf8, "1");
      assert.ok(started.argv[0].endsWith("resolve-codex-home.py"), started.argv[0]);
    },
  },
  {
    name: "the reminder adapter starts Python through the resolver with PYTHONUTF8",
    check: async (_outcomes, ctx) => {
      const started = await recordedPython(ctx, `
const [root] = process.argv.slice(1);
require(root + "/scripts/conversation-reminder-adapter.js").drainOutbox()
  .then(reply => { if (reply.status !== "ok") process.exit(1); });`, '{"status":"ok"}');
      assert.equal(started.utf8, "1");
      assert.ok(started.argv[0].endsWith("conversation-reminder-events.py"), started.argv[0]);
    },
  },
  {
    name: "no Node caller names python3, and the observer's only spawn is the resolver's",
    check: (_outcomes, ctx) => {
      for (const file of NODE_CALLERS) {
        assert.doesNotMatch(source(ctx, file), /["']python3["']/, file);
        assert.doesNotMatch(source(ctx, file), /CCDM_REMINDER_PYTHON/, file);
        assert.match(source(ctx, file), /pythonInvocation\(/, file);
      }
      const observerSpawns = source(ctx, "conversation-reminder-observer.js").match(/\bexec\(/g);
      assert.equal(observerSpawns.length, 1, "the observer calls exec only inside its python() wrapper");
    },
  },

  // Home paths
  {
    name: "the local home expanders are gone",
    check: (_outcomes, ctx) => {
      for (const file of EXPANDER_CALLERS) {
        const text = source(ctx, file);
        assert.doesNotMatch(text, /function expandHome|const expandHome =|\^~\(\?=/, file);
        assert.doesNotMatch(text, /value === "~"/, file);
        assert.match(text, /expandHome/, file);
        assert.match(text, /platform\/paths\.js/, file);
      }
    },
  },
  {
    name: "resolve-codex-home accepts ~/x",
    check: (_outcomes, ctx) => {
      const home = mkdir(ctx.home, "x");
      const result = resolveHome(ctx, "~/x");
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout.trim(), home);
    },
  },
  {
    name: "resolve-codex-home accepts ~\\x on win32",
    only: "win32",
    check: (_outcomes, ctx) => {
      const home = mkdir(ctx.home, "x");
      const result = resolveHome(ctx, "~\\x");
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout.trim(), home);
    },
  },
  ...["relative\\x", "\\no-drive", "C:drive-relative"].map(value => ({
    name: `resolve-codex-home rejects ${JSON.stringify(value)} on win32`,
    only: "win32",
    check: (_outcomes, ctx) => {
      const result = resolveHome(ctx, value);
      assert.equal(result.status, 1, result.stdout);
      assert.match(result.stderr, /must be a drive or UNC path, or use '~'/);
    },
  })),
  {
    name: "resolve-codex-home on POSIX keeps the error for an unset HOME",
    only: "posix",
    check: (_outcomes, ctx) => {
      const result = resolveHome(ctx, "~/x", null);
      assert.equal(result.status, 1, result.stdout);
      assert.match(result.stderr, /path '~\/x' cannot resolve '~' without an absolute HOME/);
    },
  },
];
