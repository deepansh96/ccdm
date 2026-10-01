#!/usr/bin/env node
"use strict";

// The conversation resolver: maps a project channel id, a thread id, a
// Discord link to either, or a thread name to the conversation it names,
// `{project, thread_id|null, provider, channel_id}`. A thread's channel_id is
// the thread itself. It reads the registry and the Thread Supervisor's store
// read-only, and never creates either.
//
// CLI: conversation-resolver.js [--project <project>] <channel-id|thread-id|link|thread-name>
// prints the conversation as JSON, or exits 2 with a reason on stderr when the
// input is unknown, ambiguous, or not in --project.
const { existsSync, readFileSync, statSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const LINK = /^https?:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/channels\/[^/\s]+\/([^/\s]+)(?:\/[^/\s]+)?\/?$/;

class ResolveError extends Error {}

function registryPath() {
  return process.env.CCDM_REGISTRY_PATH || path.resolve(__dirname, "..", "registry.json");
}

function supervisorStateDir() {
  const override = process.env.CCDM_THREAD_SUPERVISOR_STATE_DIR;
  if (override) return override.replace(/^~(?=$|\/)/, os.homedir());
  return path.join(os.homedir(), ".local/state/ccdm/thread-supervisor");
}

function loadRegistry(file) {
  let registry;
  try {
    registry = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new ResolveError(`the registry could not be read: ${error.message}`);
  }
  const projects = registry?.projects;
  return projects !== null && typeof projects === "object" && !Array.isArray(projects) ? projects : {};
}

// node:sqlite warns that it is experimental when first loaded; that is noise on an operator's terminal.
function sqlite() {
  const emitWarning = process.emitWarning;
  process.emitWarning = (warning, ...rest) => {
    if (!/SQLite/.test(String(warning))) emitWarning.call(process, warning, ...rest);
  };
  try {
    return require("node:sqlite");
  } finally {
    process.emitWarning = emitWarning;
  }
}

// The store's bound threads; none when it does not exist yet.
function loadThreads(stateDir) {
  const file = path.join(stateDir, "threads.sqlite3");
  if (!existsSync(file)) return [];
  if (statSync(file).mode & 0o077) throw new ResolveError("the thread store's permissions are not private");
  let db;
  try {
    db = new (sqlite().DatabaseSync)(file, { readOnly: true });
    return db.prepare("SELECT thread_id, project, name, provider, resolved_provider, state FROM threads").all();
  } catch (error) {
    throw new ResolveError(`the thread store could not be read: ${error.message}`);
  } finally {
    db?.close();
  }
}

const projectProvider = entry => entry?.type || "claude";

function threadConversation(projects, row) {
  return { project: row.project, thread_id: row.thread_id,
    provider: row.resolved_provider || row.provider || projectProvider(projects[row.project]), channel_id: row.thread_id };
}

function find(target, projects, threads) {
  const id = target.match(LINK)?.[1] ?? target;
  const thread = threads.find(row => row.thread_id === id);
  if (thread) return threadConversation(projects, thread);
  const channel = Object.entries(projects).find(([, entry]) => entry && String(entry.channel_id) === id);
  if (channel) return { project: channel[0], thread_id: null, provider: projectProvider(channel[1]), channel_id: id };
  return null;
}

function resolveConversation(target, { project = null, registryFile = registryPath(),
  stateDir = supervisorStateDir() } = {}) {
  if (typeof target !== "string" || target.trim() === "") throw new ResolveError("nothing to resolve");
  target = target.trim();
  const projects = loadRegistry(registryFile);
  if (project != null && !Object.hasOwn(projects, project)) throw new ResolveError(`unknown project '${project}'`);
  const threads = loadThreads(stateDir);
  const found = find(target, projects, threads);
  if (found) {
    if (project != null && found.project !== project) {
      throw new ResolveError(`'${target}' belongs to project '${found.project}', not '${project}'`);
    }
    return found;
  }
  if (LINK.test(target)) throw new ResolveError(`'${target}' links to no registered channel or bound thread`);
  const named = threads.filter(row => row.name === target && (project == null || row.project === project));
  if (named.length === 1) return threadConversation(projects, named[0]);
  if (named.length > 1) {
    const where = named.map(row => `${row.thread_id} in '${row.project}'`).join(", ");
    throw new ResolveError(`'${target}' is ambiguous: ${named.length} threads have that name (${where})`);
  }
  throw new ResolveError(`'${target}' is no registered channel, bound thread or thread name${
    project != null ? ` in '${project}'` : ""}`);
}

function main(argv) {
  let project = null;
  if (argv[0] === "--project") {
    project = argv[1];
    argv = argv.slice(2);
  }
  if (argv.length !== 1 || project === undefined) {
    process.stderr.write("usage: conversation-resolver.js [--project <project>] <channel-id|thread-id|link|thread-name>\n");
    return 2;
  }
  try {
    process.stdout.write(`${JSON.stringify(resolveConversation(argv[0], { project }))}\n`);
    return 0;
  } catch (error) {
    if (!(error instanceof ResolveError)) throw error;
    process.stderr.write(`conversation-resolver: ${error.message}\n`);
    return 2;
  }
}

module.exports = { ResolveError, resolveConversation };

if (require.main === module) process.exitCode = main(process.argv.slice(2));
