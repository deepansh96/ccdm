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

const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
const isId = value => (typeof value === "string" && value.trim() !== "") || (Number.isInteger(value) && value > 0);

// Rejects a registry the Router cannot route safely, so a reload keeps the
// last good table instead of publishing (and revoking sessions over) a
// half-understood one: the owner, collection types, each project's channel,
// and one owner per channel.
function validateRegistry(registry) {
  const problems = [];
  if (!isObject(registry)) throw new Error("invalid registry: the top level must be a JSON object");
  if (!isId(registry.discord_user_id)) problems.push("discord_user_id (the owner) must be a Discord ID");
  if (registry.guild_id != null && !isId(registry.guild_id)) problems.push("guild_id must be a Discord ID");
  for (const field of ["root_channels", "root_allowed_user_ids"]) {
    if (registry[field] != null && !(Array.isArray(registry[field]) && registry[field].every(isId))) {
      problems.push(`${field} must be a list of Discord IDs`);
    }
  }
  if (!isObject(registry.projects)) problems.push("projects must be an object keyed by project name");
  const owners = new Map((Array.isArray(registry.root_channels) ? registry.root_channels : [])
    .filter(isId).map(id => [String(id), "root"]));
  for (const [name, project] of Object.entries(isObject(registry.projects) ? registry.projects : {})) {
    if (!isObject(project)) {
      problems.push(`project ${name} must be an object`);
      continue;
    }
    if (!isId(project.channel_id)) problems.push(`project ${name}: channel_id must be a Discord ID`);
    if (project.type != null && project.type !== "claude" && project.type !== "codex") {
      problems.push(`project ${name}: type must be "claude" or "codex"`);
    }
    if (project.webhook_id != null && !isId(project.webhook_id)) problems.push(`project ${name}: webhook_id must be a Discord ID`);
    if (project.guest_user_ids != null && !(Array.isArray(project.guest_user_ids) && project.guest_user_ids.every(isId))) {
      problems.push(`project ${name}: guest_user_ids must be a list of Discord IDs`);
    }
    if (!isId(project.channel_id)) continue;
    const channel = String(project.channel_id);
    const other = owners.get(channel);
    if (other) problems.push(`project ${name}: channel_id is already ${other === "root" ? "a root channel" : `project ${other}'s channel`}`);
    else owners.set(channel, name);
  }
  if (problems.length) throw new Error(`invalid registry: ${problems.join("; ")}`);
}

function buildRoutingTable(registry) {
  validateRegistry(registry);
  const channels = new Map();
  const projects = new Map();
  // Every registered project channel: root may act in any.
  const registered = new Map();
  for (const [name, project] of Object.entries(registry.projects)) {
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
// `registry.json.lock` directory beside the registry naming its holder's pid
// (`owner`) and a nonce unique to that acquisition (`nonce`). A lock whose
// holder died is reclaimed; a live holder is waited for up to
// CCDM_REGISTRY_LOCK_TIMEOUT_MS (default 30 s).
//
// Both implementations follow the same protocol, so they exclude each other:
// - A lock directory is built complete under a unique staging name and
//   renamed into place, so the lock never exists without its owner. The
//   rename fails while a (non-empty) lock exists.
// - A holder releases by renaming its own lock aside, then deleting it.
// - A dead holder's lock is removed only by the one waiter that owns the
//   reclaim claim for that lock instance: `<lock>.reclaim-<key>`, itself a
//   lock built the same way, keyed by the dead lock's nonce (or, for a lock
//   written before nonces, its pid and inode). The claimant rechecks that the
//   lock is still that dead instance before moving it aside. A dead instance
//   is never released by its holder and only its claimant removes it, so the
//   check cannot go stale, and a waiter that saw the dead owner too late finds
//   a different instance and leaves it alone. A claim whose claimant died is
//   reclaimed the same way.
const LOCK_POLL_MS = 10;
// Claims of claims, if claimants keep dying, before a waiter just waits.
const MAX_RECLAIM_DEPTH = 4;

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

const uniqueSuffix = () => `${process.pid}-${randomBytes(8).toString("hex")}`;
const readTrimmed = file => readFile(file, "utf8").then(text => text.trim(), () => null);

// The lock instance at `dir`: its holder's pid and a key naming that instance
// alone. Null when there is none, or it changed while being read.
async function lockInstance(dir) {
  const before = await stat(dir, { bigint: true }).catch(() => null);
  if (!before) return null;
  const nonce = await readTrimmed(path.join(dir, "nonce"));
  const owner = await readTrimmed(path.join(dir, "owner"));
  const after = await stat(dir, { bigint: true }).catch(() => null);
  if (owner === null || !after || after.ino !== before.ino || await readTrimmed(path.join(dir, "nonce")) !== nonce) return null;
  const pid = /^\d+$/.test(owner) ? Number(owner) : 0;
  return { pid, key: nonce ? `n${nonce}` : `p${pid}-i${after.ino}` };
}

// The key of the instance at `dir` if its holder is dead, else null.
async function deadKey(dir) {
  const instance = await lockInstance(dir);
  return instance && !alive(instance.pid) ? instance.key : null;
}

// Creates `target` owned by this process; its nonce, or null while held.
async function createOwned(target) {
  const nonce = randomBytes(16).toString("hex");
  const staging = `${target}.new-${uniqueSuffix()}`;
  await mkdir(staging, { mode: 0o700 });
  try {
    await writeFile(path.join(staging, "owner"), `${process.pid}\n`);
    await writeFile(path.join(staging, "nonce"), `${nonce}\n`);
    await rename(staging, target);
    return nonce;
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    if (error.code === "ENOTEMPTY" || error.code === "EEXIST") return null;
    throw error;
  }
}

// Moves `dir` aside and deletes it.
async function discard(dir) {
  const aside = `${dir}.gone-${uniqueSuffix()}`;
  try {
    await rename(dir, aside);
  } catch {
    return;
  }
  await rm(aside, { recursive: true, force: true });
}

// Removes `target` only while it is still this process's instance `nonce`.
async function removeOwned(target, nonce) {
  if (await readTrimmed(path.join(target, "nonce")) === nonce) await discard(target);
}

// Removes the dead instance `key` at `target`, holding its reclaim claim.
// True when this waiter held the claim (the instance is gone either way).
async function reclaim(target, key, depth = 0) {
  const claim = `${target}.reclaim-${key}`;
  const nonce = await createOwned(claim);
  if (!nonce) {
    // Another waiter holds the claim; if it died, clear its claim.
    const claimKey = depth < MAX_RECLAIM_DEPTH ? await deadKey(claim) : null;
    return claimKey !== null && await reclaim(claim, claimKey, depth + 1);
  }
  try {
    if (await deadKey(target) === key) await discard(target);
  } finally {
    await removeOwned(claim, nonce);
  }
  return true;
}

async function acquireRegistryLock(file) {
  const lock = `${file}.lock`;
  const deadline = Date.now() + lockTimeoutMs();
  for (;;) {
    const nonce = await createOwned(lock);
    if (nonce) return () => removeOwned(lock, nonce);
    const key = await deadKey(lock);
    if (key !== null && await reclaim(lock, key)) continue;
    await testNoteBlocked();
    if (Date.now() >= deadline) {
      const holder = await readFile(path.join(lock, "owner"), "utf8").then(text => ` (held by pid ${text.trim()})`, () => "");
      throw new Error(`${file} is locked${holder}; retry once the other writer finishes`);
    }
    await sleep(LOCK_POLL_MS);
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
  DEFAULT_RELOAD_DEBOUNCE_MS, buildRoutingTable, loadRoutingTable, readRegistry, updateRegistry, validateRegistry, watchRegistry,
  withRegistryLock,
  // For the E2E suite's stale-lock race checks.
  _lockInternals: { deadKey, reclaim },
};
