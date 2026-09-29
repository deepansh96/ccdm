"use strict";

// Routing table derived from registry.json. Only router-transport projects
// are routed; pool projects keep being served by their own bots.
const { watch } = require("node:fs");
const { readFile, rename, writeFile, stat } = require("node:fs/promises");
const path = require("node:path");

// How long registry writes must settle before a reload.
const DEFAULT_RELOAD_DEBOUNCE_MS = 250;

async function readRegistry(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

function buildRoutingTable(registry) {
  const channels = new Map();
  const projects = new Map();
  for (const [name, project] of Object.entries(registry.projects || {})) {
    if (project?.transport !== "router" || !project.channel_id) continue;
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

// Structured rewrite through a temporary file, keeping the registry's mode.
async function updateRegistry(file, updater) {
  const registry = await readRegistry(file);
  updater(registry);
  const { mode } = await stat(file);
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(registry, null, 2)}\n`, { mode: mode & 0o777 });
  await rename(temporary, file);
  return registry;
}

module.exports = { DEFAULT_RELOAD_DEBOUNCE_MS, buildRoutingTable, loadRoutingTable, readRegistry, updateRegistry, watchRegistry };
