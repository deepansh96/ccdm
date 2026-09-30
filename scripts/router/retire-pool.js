"use strict";

// Retires the Bot Pool once every project is on the Router: removes each pool
// bot from the guild, moves its state directory into a private backup,
// deletes the `project-bot` role, and strips the pool fields from the
// registry after backing it up. Bot applications are never deleted.
//
//   scripts/retire-pool.sh            dry run: print the actions, change nothing
//   scripts/retire-pool.sh --apply    take them
const { existsSync } = require("node:fs");
const { chmod, copyFile, mkdir, rename } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { discordRequest } = require("./discord-rest.js");
const { registryPath, rootToken } = require("./paths.js");
const { readRegistry, updateRegistry } = require("./registry.js");

const REGISTRY_FIELDS = ["pool", "max_pool_size", "project_bot_role_id"];
const PROJECT_FIELDS = ["bot_id", "bot_display_name", "transport"];

function backupDir() {
  return process.env.CCDM_POOL_BACKUP_DIR || path.join(os.homedir(), ".local/state/ccdm/pool-retirement");
}

async function privateDir(dir) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
}

// A 404 means the member or role is already gone.
async function deleteIfPresent(route, token) {
  try {
    await discordRequest("DELETE", route, { token });
  } catch (error) {
    if (error.status !== 404) throw error;
  }
}

// A project still tied to a pool bot. Registration writes no `transport`, and
// an interrupted retirement leaves stripped projects without one: neither
// blocks retirement.
function hasPoolMarkers(registry, name, project) {
  if (project?.bot_id || project?.bot_display_name) return true;
  return (Array.isArray(registry.pool) ? registry.pool : []).some(bot => bot?.assigned_to === name);
}

function plan(registry, file) {
  const backup = backupDir();
  const guild = registry.guild_id;
  const pool = Array.isArray(registry.pool) ? registry.pool : [];
  const actions = [];
  for (const bot of pool) {
    actions.push({
      describe: `remove member ${bot.id} (${bot.app_id}) from guild ${guild}`,
      run: async token => deleteIfPresent(`/guilds/${guild}/members/${bot.app_id}`, token),
    });
  }
  for (const bot of pool) {
    if (!bot.state_dir || !existsSync(bot.state_dir)) continue;
    const target = path.join(backup, "state", String(bot.id));
    actions.push({
      describe: `move state directory ${bot.state_dir} to ${target}`,
      run: async () => {
        if (existsSync(target)) throw new Error(`${target} already exists; not overwriting it`);
        await privateDir(path.dirname(target));
        await rename(bot.state_dir, target);
        await chmod(target, 0o700);
      },
    });
  }
  const roleId = registry.project_bot_role_id;
  if (roleId) {
    actions.push({
      describe: `delete role project-bot (${roleId}) in guild ${guild}`,
      run: async token => deleteIfPresent(`/guilds/${guild}/roles/${roleId}`, token),
    });
  }
  const topLevel = REGISTRY_FIELDS.filter(field => field in registry);
  const perProject = Object.entries(registry.projects || {})
    .map(([name, project]) => [name, PROJECT_FIELDS.filter(field => field in project)])
    .filter(([, fields]) => fields.length);
  if (topLevel.length || perProject.length) {
    const target = path.join(backup, "registry.json");
    actions.push({
      describe: `back up the registry to ${target}`,
      // A backup left by an interrupted run already holds the older registry.
      run: async () => {
        if (existsSync(target)) return;
        await privateDir(backup);
        await copyFile(file, target);
        await chmod(target, 0o600);
      },
    });
  }
  if (topLevel.length) {
    actions.push({
      describe: `strip ${topLevel.join(", ")} from the registry`,
      run: async () => updateRegistry(file, next => { for (const field of topLevel) delete next[field]; }),
    });
  }
  for (const [name, fields] of perProject) {
    actions.push({
      describe: `strip ${fields.join(", ")} from project ${name}`,
      run: async () => updateRegistry(file, next => { for (const field of fields) delete next.projects[name][field]; }),
    });
  }
  return actions;
}

async function main(args) {
  const apply = args.includes("--apply");
  const unknown = args.filter(arg => arg !== "--apply");
  if (unknown.length) throw new Error(`usage: retire-pool.sh [--apply] (unexpected ${unknown.join(" ")})`);
  const file = registryPath();
  const registry = await readRegistry(file);
  const actions = plan(registry, file);
  if (!actions.length) {
    console.log("the Bot Pool is already retired; nothing to do");
    return;
  }
  const pooled = Object.entries(registry.projects || {})
    .filter(([name, project]) => hasPoolMarkers(registry, name, project) && project?.transport !== "router")
    .map(([name]) => name);
  if (pooled.length) {
    throw new Error(`refusing to retire the Bot Pool: ${pooled.join(", ")} ${pooled.length === 1 ? "is" : "are"} not on the Router (transport: "router")`);
  }
  if (!apply) {
    console.log("dry run: nothing changes until this is re-run with --apply");
    for (const action of actions) console.log(`would ${action.describe}`);
    return;
  }
  const token = await rootToken();
  for (const action of actions) {
    try {
      await action.run(token);
    } catch (error) {
      throw new Error(`failed to ${action.describe}: ${error.message}`);
    }
    console.log(`done: ${action.describe}`);
  }
}

main(process.argv.slice(2)).catch(error => {
  console.error(error.message);
  process.exit(1);
});
