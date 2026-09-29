"use strict";

// Routing table derived from registry.json. Only router-transport projects
// are routed; pool projects keep being served by their own bots.
const { readFile, rename, writeFile, stat } = require("node:fs/promises");

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

module.exports = { buildRoutingTable, loadRoutingTable, readRegistry, updateRegistry };
