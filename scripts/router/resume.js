"use strict";

// Finds the saved conversation a migration can resume, before the stop step
// clears the project's runtime fields. Returns `{ id, source }`, or
// `{ skip: <reason> }` when nothing resumable exists (a fresh start follows).
//
// Claude: the session UUID from the live `<home>/sessions/<pid>.json` (fresher
// after `/clear`), else the registry's recorded `session_id`, whose transcript
// `<home>/projects/<cwd slug>/<id>.jsonl` must exist in the project's home.
// Codex: the launcher records `session_id: null`, so the registry's value is
// used only when it is a UUID; otherwise the newest non-subagent
// `codex-discord-bridge` rollout for the project directory in the project's
// resolved Codex home, whose rollout file must exist.
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BRIDGE_ORIGINATOR = "codex-discord-bridge";
// A rollout's first line (session metadata with base instructions) is read up to this size.
const FIRST_LINE_LIMIT = 4 * 1024 * 1024;

const expandHome = value => (value === "~" || value.startsWith("~/") ? path.join(os.homedir(), value.slice(1)) : value);

function sameDirectories(dir) {
  const dirs = [path.resolve(dir)];
  try { dirs.push(fs.realpathSync(dir)); } catch { /* missing project directory */ }
  return [...new Set(dirs)];
}

function claudeHome(entry) {
  return path.resolve(expandHome(entry.claude_home || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude")));
}

function claudeTranscript(home, projectDir, id) {
  return sameDirectories(projectDir)
    .map(dir => path.join(home, "projects", dir.replace(/[^A-Za-z0-9]/g, "-"), `${id}.jsonl`))
    .find(file => fs.existsSync(file));
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

// The running session's own id, when the recorded PID is still that session.
function liveClaudeSession(home, entry, projectDir) {
  const pid = Number(entry.pid);
  if (!Number.isInteger(pid) || pid <= 0 || !isAlive(pid)) return null;
  try {
    const session = JSON.parse(fs.readFileSync(path.join(home, "sessions", `${pid}.json`), "utf8"));
    if (session.cwd && !sameDirectories(projectDir).includes(path.resolve(session.cwd))) return null;
    return session.sessionId || session.session_id || null;
  } catch {
    return null;
  }
}

function resolveClaude(entry) {
  const home = claudeHome(entry);
  const projectDir = expandHome(String(entry.path || ""));
  if (!entry.path) return { skip: "the project has no path" };
  const candidates = [];
  const live = liveClaudeSession(home, entry, projectDir);
  if (live) candidates.push({ id: live, source: "live Claude session file" });
  if (entry.session_id && entry.session_id !== live) candidates.push({ id: String(entry.session_id), source: "registry session_id" });
  if (candidates.length === 0) return { skip: "no recorded Claude session_id" };
  const problems = [];
  for (const candidate of candidates) {
    if (!UUID.test(candidate.id)) {
      problems.push(`${candidate.source} ${candidate.id} is not a canonical UUID`);
      continue;
    }
    if (claudeTranscript(home, projectDir, candidate.id)) return candidate;
    problems.push(`transcript for ${candidate.id} (${candidate.source}) is missing from ${home}`);
  }
  return { skip: problems.join("; ") };
}

function readFirstLine(file) {
  const fd = fs.openSync(file, "r");
  try {
    const chunks = [];
    const buffer = Buffer.alloc(64 * 1024);
    let total = 0;
    while (total < FIRST_LINE_LIMIT) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, total);
      if (read === 0) break;
      const newline = buffer.subarray(0, read).indexOf(10);
      chunks.push(Buffer.from(buffer.subarray(0, newline >= 0 ? newline : read)));
      if (newline >= 0) break;
      total += read;
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

function rollouts(home) {
  const found = [];
  const walk = dir => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name)) found.push(full);
    }
  };
  walk(path.join(home, "sessions"));
  return found;
}

function codexHome(project, registryFile) {
  const resolver = path.join(__dirname, "..", "resolve-codex-home.py");
  const result = spawnSync("python3", [resolver, registryFile, project], { encoding: "utf8", env: process.env });
  if (result.status !== 0) {
    const reason = (result.stderr || result.stdout || "").trim().split("\n").filter(Boolean).at(-1);
    throw new Error(`the project's Codex home did not resolve${reason ? `: ${reason}` : ""}`);
  }
  return path.resolve(expandHome(result.stdout.trim()));
}

function resolveCodex(project, entry, registryFile) {
  let home;
  try {
    home = codexHome(project, registryFile);
  } catch (error) {
    return { skip: error.message };
  }
  const files = rollouts(home);
  const recorded = entry.session_id ? String(entry.session_id) : "";
  if (UUID.test(recorded)) {
    if (files.some(file => file.endsWith(`-${recorded}.jsonl`))) return { id: recorded, source: "registry session_id" };
    return { skip: `rollout for ${recorded} (registry session_id) is missing from ${home}/sessions` };
  }
  if (!entry.path) return { skip: "the project has no path" };
  const dirs = sameDirectories(expandHome(String(entry.path)));
  const byNewest = files
    .map(file => { try { return { file, mtime: fs.statSync(file).mtimeMs }; } catch { return null; } })
    .filter(Boolean)
    .sort((a, b) => b.mtime - a.mtime);
  for (const { file } of byNewest) {
    let meta;
    try { meta = JSON.parse(readFirstLine(file)); } catch { continue; }
    const payload = meta?.type === "session_meta" ? meta.payload : null;
    // Subagent threads carry an object `source`; only the bridge's own thread counts.
    if (!payload || payload.originator !== BRIDGE_ORIGINATOR || typeof payload.source !== "string") continue;
    if (!payload.cwd || !dirs.includes(path.resolve(payload.cwd))) continue;
    const id = String(payload.id || "");
    if (UUID.test(id) && file.endsWith(`-${id}.jsonl`)) {
      return { id, source: `newest ${BRIDGE_ORIGINATOR} rollout for the project directory in ${home}` };
    }
  }
  return { skip: `no recorded Codex thread id, and no ${BRIDGE_ORIGINATOR} rollout for the project directory in ${home}/sessions` };
}

function resolveResume(project, entry, { registryFile }) {
  return entry.type === "codex" ? resolveCodex(project, entry, registryFile) : resolveClaude(entry);
}

module.exports = { resolveResume };
