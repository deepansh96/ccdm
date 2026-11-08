#!/usr/bin/env node
"use strict";

// Claude Code's statusLine command, in Node so it needs no bash or jq. Records
// the session's context window usage where the channel server reads it for each
// reply: `<launch dir>/context.json`, or nothing outside a CCDM session.
//
//   node statusline-context.js [--chain '<statusLine command>']
//
// --chain runs an existing statusLine command on the same stdin and prints its
// output. Without it this script prints nothing.
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const { writeFileAtomicSync } = require("./platform/atomic.js");

const THREAD_KEY_PREFIX = ".thread-";

function isDirectory(candidate) {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

async function readStdin() {
  const chunks = [];
  try {
    for await (const chunk of process.stdin) chunks.push(chunk);
  } catch { /* A closed stdin is the same as an empty one. */ }
  return Buffer.concat(chunks);
}

function usedPercentage(input) {
  let pct;
  try {
    pct = JSON.parse(input.toString("utf8"))?.context_window?.used_percentage;
  } catch {
    return null;
  }
  return typeof pct === "number" && Number.isFinite(pct) && pct >= 0 ? pct : null;
}

// A key is `<state>/keys/<project>.key`, or `.thread-<id>.key` for a thread,
// whose launch directory sits under the project that owns it.
function launchDirFor(keyFile) {
  const name = path.basename(keyFile, ".key");
  const launches = path.join(path.dirname(path.dirname(keyFile)), "launches");
  if (!name.startsWith(THREAD_KEY_PREFIX)) return path.join(launches, name);
  const threadId = name.slice(THREAD_KEY_PREFIX.length);
  if (!threadId) return null;
  let projects;
  try {
    projects = fs.readdirSync(launches).sort();
  } catch {
    return null;
  }
  return projects.map(project => path.join(launches, project, "threads", threadId)).find(isDirectory) ?? null;
}

function recordContext(input) {
  const keyFile = process.env.CCDM_ROUTER_KEY_FILE;
  if (!keyFile) return;
  const pct = usedPercentage(input);
  if (pct === null) return;
  const launchDir = launchDirFor(keyFile);
  if (!launchDir || !isDirectory(launchDir)) return;
  try {
    writeFileAtomicSync(path.join(launchDir, "context.json"), `{"context_pct": ${pct}}\n`);
  } catch { /* A status line must still render when the record cannot be written. */ }
}

// Git for Windows only. A bare `bash` on PATH is often WSL's, a different
// filesystem and environment from the one Claude Code runs commands in.
function findGitBash() {
  const { env } = process;
  const besideGit = (env.PATH || "").split(path.delimiter)
    .filter(dir => dir && fs.existsSync(path.join(dir, "git.exe")))
    // git.exe lives in Git\cmd, Git\bin or Git\mingw64\bin.
    .flatMap(dir => [path.resolve(dir, ".."), path.resolve(dir, "..", "..")]);
  const installs = [env.ProgramW6432, env.ProgramFiles, env["ProgramFiles(x86)"],
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "Programs")]
    .filter(Boolean).map(root => path.join(root, "Git"));
  return [env.CLAUDE_CODE_GIT_BASH_PATH, ...[...besideGit, ...installs].map(root => path.join(root, "bin", "bash.exe"))]
    .find(candidate => candidate && fs.existsSync(candidate)) ?? null;
}

function windowsPowerShell() {
  const builtin = path.join(process.env.SystemRoot || "C:\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return fs.existsSync(builtin) ? builtin : "powershell";
}

// The shell Claude Code would run a statusLine command with.
function chainShell() {
  if (process.platform !== "win32") return ["/bin/sh", "-c"];
  const bash = findGitBash();
  return bash ? [bash, "-c"] : [windowsPowerShell(), "-NoProfile", "-Command"];
}

function runChain(command, input) {
  const [shell, ...shellArgs] = chainShell();
  const result = spawnSync(shell, [...shellArgs, command], {
    input,
    stdio: ["pipe", "inherit", "inherit"],
    windowsHide: true,
  });
  if (result.error) process.stderr.write(`statusline-context: --chain did not start: ${result.error.message}\n`);
  return result.status ?? 1;
}

async function main() {
  const args = process.argv.slice(2);
  const chainAt = args.indexOf("--chain");
  const chain = chainAt === -1 ? "" : args[chainAt + 1] ?? "";
  const input = await readStdin();
  recordContext(input);
  if (chain) process.exitCode = runChain(chain, input);
}

main();
