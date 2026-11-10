// What the harness needs to know about the host OS: which Python to run, how to
// start a script, which tests run here, and the Windows fixture toolchain.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runSurface, TAG_SURFACES } from "./surfaces.js";

function printedExecutable(command, args) {
  const probe = spawnSync(command, [...args, "-c", "import sys; print(sys.executable)"], {
    encoding: "utf8",
    windowsHide: true,
  });
  return probe.status === 0 ? probe.stdout.trim() || null : null;
}

// CCDM_PYTHON, else python3 on POSIX. On win32 the interpreter `py -3` runs, else
// `python`; a path under \WindowsApps\ is the Microsoft Store stub, never Python.
export function resolvePython({ env = process.env, platform = process.platform, probe = printedExecutable } = {}) {
  if (env.CCDM_PYTHON) return env.CCDM_PYTHON;
  if (platform !== "win32") return "python3";
  for (const [command, ...args] of [["py", "-3"], ["python"]]) {
    const executable = probe(command, args);
    if (executable && !executable.toLowerCase().includes("\\windowsapps\\")) return executable;
  }
  return null;
}

// On win32 Python's os.kill(pid, 0) sends Ctrl+C, so every Python this process
// starts, including with the inherited environment, gets the guard module.
if (process.platform === "win32") {
  const guard = fileURLToPath(new URL("./pysafe", import.meta.url));
  process.env.PYTHONPATH = [guard, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter);
}

const resolvedPython = resolvePython();
// A workspace child has only fixtures on PATH, so finding nothing is not fatal
// here; preflight reports it for a real run.
export const PYTHON = resolvedPython ?? "python";

// The Git for Windows directory holding sh.exe and the coreutils. Its bin\ front
// is avoided on purpose: that one puts Git's own curl and friends ahead of the
// fixtures on PATH. CCDM_E2E_GIT_SH overrides the lookup (and a test hides Git with it).
function findGitSh(env) {
  if (env.CCDM_E2E_GIT_SH) return fs.existsSync(env.CCDM_E2E_GIT_SH) ? env.CCDM_E2E_GIT_SH : null;
  const git = spawnSync("git", ["--exec-path"], { encoding: "utf8", windowsHide: true });
  const roots = git.status === 0 ? [path.resolve(git.stdout.trim(), "..", "..", "..")] : [];
  if (env.ProgramFiles) roots.push(path.join(env.ProgramFiles, "Git"));
  return roots.map(root => path.join(root, "usr", "bin", "sh.exe")).find(candidate => fs.existsSync(candidate)) ?? null;
}

let cachedGitSh;
export function gitBashSh(env = process.env) {
  if (env !== process.env) return findGitSh(env);
  if (cachedGitSh === undefined) cachedGitSh = findGitSh(env);
  return cachedGitSh;
}

const NO_GIT_BASH = "The E2E fixtures run hooks through Git Bash, and no Git for Windows sh.exe was found. "
  + "Install Git for Windows, or set CCDM_E2E_GIT_SH to its usr\\bin\\sh.exe.";

// The shell the fixture `claude` runs hook commands with, as Claude Code does on each OS.
export function hookShell({ env = process.env, platform = process.platform } = {}) {
  if (platform !== "win32") return "/bin/sh";
  const sh = gitBashSh(env);
  if (!sh) throw new Error(NO_GIT_BASH);
  return sh;
}

// A coreutils program from the same Git for Windows install, or null.
export function gitBashTool(name) {
  const sh = gitBashSh();
  if (!sh) return null;
  const tool = path.join(path.dirname(sh), `${name}.exe`);
  return fs.existsSync(tool) ? tool : null;
}

function shebangOf(file) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const buffer = Buffer.alloc(128);
    const firstLine = buffer.toString("utf8", 0, fs.readSync(fd, buffer, 0, 128, 0)).split("\n")[0];
    return firstLine.startsWith("#!") ? firstLine : "";
  } catch {
    return "";
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// The argv prefix that starts `script`. POSIX runs it by its own shebang; Windows
// cannot, so there the interpreter is named: [interpreter, script].
export function interpreterFor(script, platform = process.platform) {
  if (platform !== "win32") return [script];
  const extension = path.extname(script).toLowerCase();
  if (extension === ".exe" || extension === ".com") return [script];
  const shebang = shebangOf(script);
  if (/python/.test(shebang) || (!shebang && extension === ".py")) return [PYTHON, script];
  if (/\bnode\b/.test(shebang) || (!shebang && [".js", ".cjs", ".mjs"].includes(extension))) {
    return [process.execPath, script];
  }
  if (/\b(ba|z)sh\b/.test(shebang)) return [gitBashTool("bash") ?? gitBashSh() ?? "bash", script];
  if (/\bsh\b/.test(shebang) || (!shebang && extension === ".sh")) return [gitBashSh() ?? "sh", script];
  return [script];
}

// Git Bash takes /tmp from the TEMP of the oldest process of its runtime that is
// still running, not from its own. Every workspace has its own TEMP, so once the
// workspace that process came from is removed, each bash start prints this line
// until the runtime has no process left. A shim starts bash twice and the command
// behind it once, so the line count differs between two calls that behave the same.
const GIT_BASH_TMP_WARNING = /^(?:ba)?sh(?:\.exe)?: warning: could not find \/tmp, please create!\r?\n/gm;

// `stderr` without that line on Windows; unchanged elsewhere.
export function withoutGitBashTmpWarning(stderr, platform = process.platform) {
  return platform === "win32" ? stderr.replace(GIT_BASH_TMP_WARNING, "") : stderr;
}

// Test options for an OS tag: `test(name, platformGate("posix", "why"), body)`.
// `posix` is Linux and macOS; `darwin` only for a real macOS facility, never for
// a test that passes on Linux with fixtures; `win32` for a Windows-only case.
// Every tag that skips on Windows needs a line in windows-skip-budget.json.
export function platformGate(tag, reason = "", platform = process.platform) {
  const oses = TAG_SURFACES[tag];
  if (!oses) throw new Error(`Unknown platform tag: ${tag}`);
  if (oses.includes(platform)) return {};
  return { skip: reason ? `${tag}: ${reason}` : tag };
}

// For a suite gated as a whole in surfaces.js: its `test`, which skips every case
// on an OS the suite does not run on. Elsewhere it is node:test's own function.
// Use as `const test = suiteTest(nodeTest, import.meta.url);`.
export function suiteTest(nodeTest, file, platform = process.platform) {
  const surface = runSurface(path.basename(fileURLToPath(file)));
  if (surface.oses.includes(platform)) return nodeTest;
  const skip = `${surface.tag}: ${surface.reason}`;
  const gated = (name, ...rest) => {
    const body = rest.at(-1);
    const options = rest.length > 1 ? rest[0] : {};
    return nodeTest(name, { ...options, skip }, body);
  };
  return Object.assign(gated, nodeTest);
}

// The permission bits of `target` on POSIX, for a test about a mode that is not
// a privacy claim; null on Windows, which has no such bits.
export function posixMode(target) {
  return process.platform === "win32" ? null : fs.statSync(target).mode & 0o777;
}

// That `target` has this exact mode on POSIX; Windows has nothing to compare.
export function assertPosixMode(target, mode) {
  if (process.platform !== "win32") assert.equal(fs.statSync(target).mode & 0o777, mode);
}

// Private by this OS's rule: 0700 for a directory and 0600 for anything else on
// POSIX, the DACL rule on Windows (see scripts/platform/privacy.js).
// Where privateTmpDir puts a Test Workspace's directories.
export function privateTempRoot(workspace, platform = process.platform) {
  return platform === "win32"
    ? path.join(workspace.homeDir, ".local", "state", "ccdm", "tmp")
    : workspace.tmpDir;
}

export function assertPrivate(target, message) {
  const info = fs.statSync(target);
  if (process.platform !== "win32") {
    assert.equal(info.mode & 0o777, info.isDirectory() ? 0o700 : 0o600, message);
    return;
  }
  const privacy = createRequire(import.meta.url)("../../../scripts/platform/privacy.js");
  if (info.isDirectory()) assert.deepEqual(privacy.privateDirBlockers(target), [], message);
  else assert.equal(privacy.isPrivateFile(target), true, message ?? `${target} is not private`);
}

function compilerPath(env) {
  if (env.CCDM_E2E_CSC) return fs.existsSync(env.CCDM_E2E_CSC) ? env.CCDM_E2E_CSC : null;
  const windows = env.SystemRoot ?? "C:\\Windows";
  return ["Framework64", "Framework"]
    .map(framework => path.join(windows, "Microsoft.NET", framework, "v4.0.30319", "csc.exe"))
    .find(candidate => fs.existsSync(candidate)) ?? null;
}

const SHIM_SOURCE = fileURLToPath(new URL("./fixture-shim.cs", import.meta.url));
const CTRL_BREAK_SOURCE = fileURLToPath(new URL("./ctrl-break.cs", import.meta.url));
const sourceDigest = source => createHash("sha256").update(fs.readFileSync(source)).digest("hex").slice(0, 16);
// Deliberately not "ccdm-e2e-*": the runner treats those as a dead test's workspaces.
const launcherDir = () => path.join(os.tmpdir(), `ccdm-fixture-launcher-${sourceDigest(SHIM_SOURCE)}`);
const launcherExe = dir => path.join(dir, "fixture-shim.exe");

const NO_COMPILER = "The E2E fixtures need the .NET Framework compiler csc.exe, which ships with Windows, "
  + "and it was not found under %SystemRoot%\\Microsoft.NET\\Framework64\\v4.0.30319. "
  + "Enable .NET Framework 4, or set CCDM_E2E_CSC to a csc.exe.";

// The launcher compiled from fixture-shim.cs. Built once per content hash and
// published by rename, so parallel test files can race for it safely.
export function fixtureLauncher(env = process.env) {
  return compiledOnce(SHIM_SOURCE, launcherDir(), "fixture-shim.exe", env);
}

function compiledOnce(source, dir, exeName, env) {
  const exe = path.join(dir, exeName);
  if (fs.existsSync(exe)) return exe;
  const compiler = compilerPath(env);
  if (!compiler) throw new Error(NO_COMPILER);
  const staging = fs.mkdtempSync(`${dir}.staging-`);
  try {
    const compiled = spawnSync(compiler, [
      "/nologo", "/target:exe", "/optimize+", `/out:${path.join(staging, exeName)}`, source,
    ], { encoding: "utf8", windowsHide: true });
    if (compiled.status !== 0) {
      throw new Error(`csc.exe could not compile ${path.basename(source)}: ${compiled.stdout || compiled.stderr || compiled.error}`);
    }
    try {
      fs.renameSync(staging, dir);
    } catch (error) {
      // Another test file published the same launcher first.
      if (!fs.existsSync(exe)) throw error;
    }
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
  return exe;
}

// Starts a process that can later get sendCtrlBreak. On Windows it runs under
// the ctrl-break launcher: own process group, shared hidden console, and no
// stdin of its own (the launcher reads the harness's commands from it). Elsewhere
// a plain spawn.
export function spawnWithCtrlBreak(command, args, options = {}) {
  if (process.platform !== "win32") return spawn(command, args, { ...options, windowsHide: true });
  const launcher = compiledOnce(CTRL_BREAK_SOURCE,
    path.join(os.tmpdir(), `ccdm-ctrl-break-${sourceDigest(CTRL_BREAK_SOURCE)}`), "ctrl-break.exe", process.env);
  return spawn(launcher, [command, ...args], { ...options, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
}

// Ctrl+Break, delivered to a child started with spawnWithCtrlBreak.
export function sendCtrlBreak(child) {
  if (process.platform !== "win32") throw new Error("sendCtrlBreak exists only on Windows");
  child.stdin.write("break\n");
}

// Why this host cannot run the suite, or null. npm test asks once, before
// starting any file, so a missing tool is one message rather than a failure
// in every scenario.
export function harnessPrerequisiteProblem({ env = process.env, platform = process.platform } = {}) {
  if (platform !== "win32") return null;
  if (!fs.existsSync(launcherExe(launcherDir())) && !compilerPath(env)) return NO_COMPILER;
  if (!gitBashSh(env)) return NO_GIT_BASH;
  if (!env.CCDM_PYTHON && !resolvedPython) return "No usable Python was found: `py -3` and `python` failed or gave the Microsoft Store stub. Install Python, or set CCDM_PYTHON.";
  return null;
}
