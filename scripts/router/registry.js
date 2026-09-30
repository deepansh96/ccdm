"use strict";

// Routing table derived from registry.json. Neither Claude nor Codex has a pool
// mode, so every registered project is routed whatever its `transport`. Root's
// channels and allowed users come from the registry too.
const { randomBytes } = require("node:crypto");
const { watch } = require("node:fs");
const { chmod, mkdir, open, readFile, rename, rm, stat, unlink, writeFile } = require("node:fs/promises");
const path = require("node:path");

// How long registry writes must settle before a reload.
const DEFAULT_RELOAD_DEBOUNCE_MS = 250;

async function readRegistry(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

function buildRoutingTable(registry) {
  const channels = new Map();
  const projects = new Map();
  // Every registered project channel: root may act in any.
  const registered = new Map();
  for (const [name, project] of Object.entries(registry.projects || {})) {
    if (!project?.channel_id) continue;
    registered.set(String(project.channel_id), name);
    const route = {
      project: name,
      type: project.type === "codex" ? "codex" : "claude",
      transport: "router",
      channel_id: String(project.channel_id),
      webhook_id: project.webhook_id ? String(project.webhook_id) : null,
      guests: (project.guest_user_ids || []).map(String),
    };
    channels.set(route.channel_id, route);
    projects.set(name, route);
  }
  return {
    ownerId: registry.discord_user_id ? String(registry.discord_user_id) : null,
    guildId: registry.guild_id ? String(registry.guild_id) : null,
    channels,
    projects,
    registered,
    rootChannels: new Set((registry.root_channels || []).map(String)),
    rootAllowedUserIds: new Set((registry.root_allowed_user_ids || []).map(String)),
  };
}

async function loadRoutingTable(file) {
  return { ...buildRoutingTable(await readRegistry(file)), loadedAt: new Date().toISOString() };
}

// Reloads the routing table whenever registry.json changes. The directory is
// watched, not the file, so an atomic replace (rename over the file) is seen.
// A registry that fails to load leaves the last good table in place.
function watchRegistry(file, { debounceMs = DEFAULT_RELOAD_DEBOUNCE_MS, onLoad, onError }) {
  const name = path.basename(file);
  let timer = null;
  let loading = Promise.resolve();
  const reload = () => {
    timer = null;
    loading = loading.then(() => loadRoutingTable(file).then(onLoad, onError));
  };
  const watcher = watch(path.dirname(file), (_event, changed) => {
    if (changed && changed !== name) return;
    clearTimeout(timer);
    timer = setTimeout(reload, debounceMs);
  });
  return { close() { clearTimeout(timer); watcher.close(); } };
}

// Every registry read-modify-write, here and in scripts/registry-update.py
// (the shell and Python writers), holds one cross-process lock: a
// `registry.json.lock` directory beside the registry, created atomically and
// naming its holder's pid. A lock whose holder died is reclaimed; a live
// holder is waited for up to CCDM_REGISTRY_LOCK_TIMEOUT_MS (default 30 s).
//
// A lock directory still without an owner file after this long was left by a
// holder that died between creating it and recording its pid.
const UNOWNED_STALE_MS = 10000;
const LOCK_POLL_MS = 10;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function lockTimeoutMs() {
  const raw = process.env.CCDM_REGISTRY_LOCK_TIMEOUT_MS;
  const value = Number(raw);
  return raw && Number.isFinite(value) && value >= 0 ? value : 30000;
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

// The stale holder's owner text, or null while the holder may be alive.
async function staleOwner(lock) {
  let owner;
  try {
    owner = await readFile(path.join(lock, "owner"), "utf8");
  } catch {
    try {
      return Date.now() - (await stat(lock)).mtimeMs > UNOWNED_STALE_MS ? "" : null;
    } catch {
      return null;
    }
  }
  return alive(Number.parseInt(owner, 10)) ? null : owner;
}

async function reclaim(lock, owner) {
  const aside = `${lock}.stale-${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    await rename(lock, aside);
  } catch {
    return;
  }
  const moved = await readFile(path.join(aside, "owner"), "utf8").catch(() => "");
  // Another waiter reclaimed it first and a live writer took the lock since:
  // hand it back.
  if (moved !== owner && await rename(aside, lock).then(() => true, () => false)) return;
  await rm(aside, { recursive: true, force: true });
}

async function acquireRegistryLock(file) {
  const lock = `${file}.lock`;
  const deadline = Date.now() + lockTimeoutMs();
  for (;;) {
    try {
      await mkdir(lock, { mode: 0o700 });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const owner = await staleOwner(lock);
      if (owner !== null) {
        await reclaim(lock, owner);
        continue;
      }
      await testNoteBlocked();
      if (Date.now() >= deadline) {
        const holder = await readFile(path.join(lock, "owner"), "utf8").then(text => ` (held by pid ${text.trim()})`, () => "");
        throw new Error(`${file} is locked${holder}; retry once the other writer finishes`);
      }
      await sleep(LOCK_POLL_MS);
      continue;
    }
    await writeFile(path.join(lock, "owner"), `${process.pid}\n`);
    return async () => {
      const owner = await readFile(path.join(lock, "owner"), "utf8").catch(() => "");
      if (Number.parseInt(owner, 10) === process.pid) await rm(lock, { recursive: true, force: true });
    };
  }
}

// Runs `action` holding the registry lock.
async function withRegistryLock(file, action) {
  const release = await acquireRegistryLock(file);
  try {
    return await action();
  } finally {
    await release();
  }
}

// Test-only (CCDM_TEST_REGISTRY_HOLD=<path>): the E2E suite overlaps and
// interrupts writers deterministically. The next commit after `<path>.armed`
// appears claims it, writes its pid to `<path>.waiting`, and pauses holding
// the lock, its new registry written but not yet renamed into place, until
// it consumes `<path>.release`. A writer that finds the lock held touches
// `<path>.blocked`.
async function testNoteBlocked() {
  const hold = process.env.CCDM_TEST_REGISTRY_HOLD;
  if (hold) await writeFile(`${hold}.blocked`, `${process.pid}\n`).catch(() => {});
}

async function testHold() {
  const hold = process.env.CCDM_TEST_REGISTRY_HOLD;
  if (!hold) return;
  try {
    await rename(`${hold}.armed`, `${hold}.waiting`);
  } catch {
    return;
  }
  await writeFile(`${hold}.waiting`, `${process.pid}\n`);
  for (;;) {
    try {
      await unlink(`${hold}.release`);
      break;
    } catch {
      await sleep(LOCK_POLL_MS);
    }
  }
  await unlink(`${hold}.waiting`).catch(() => {});
}

// Commits through a unique adjacent temporary file renamed over the registry,
// keeping its mode (registry.json is private), so readers only see whole files.
async function commitRegistry(file, registry) {
  const mode = (await stat(file)).mode & 0o777;
  const temporary = path.join(path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  const handle = await open(temporary, "wx", mode);
  try {
    try {
      await handle.writeFile(`${JSON.stringify(registry, null, 2)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(temporary, mode);
    await testHold();
    await rename(temporary, file);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

// Structured read-modify-write under the registry lock: `updater` (which may
// be async) changes a fresh read, and the result is committed atomically.
async function updateRegistry(file, updater) {
  return withRegistryLock(file, async () => {
    const registry = await readRegistry(file);
    await updater(registry);
    await commitRegistry(file, registry);
    return registry;
  });
}

module.exports = {
  DEFAULT_RELOAD_DEBOUNCE_MS, buildRoutingTable, loadRoutingTable, readRegistry, updateRegistry, watchRegistry, withRegistryLock,
};
