#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const os = require("os");

const ROOT_DIR = path.resolve(__dirname, "..");
const REGISTRY_PATH = path.join(ROOT_DIR, "registry.json");
const API = "https://discord.com/api/v10";

const VIEW_CHANNEL = 1n << 10n;
const GUEST_ALLOW =
  VIEW_CHANNEL |
  (1n << 6n) |
  (1n << 11n) |
  (1n << 15n) |
  (1n << 16n) |
  (1n << 38n);

function usage() {
  console.error(`Usage:
  scripts/guest-access.js invite <project|channel_id> <user_id>
  scripts/guest-access.js grant <project|channel_id> <user_id>
  scripts/guest-access.js revoke <project|channel_id> <user_id>
  scripts/guest-access.js sync [project|channel_id]
  scripts/guest-access.js list [project|channel_id]`);
  process.exit(2);
}

function expandHome(value) {
  if (!value) return value;
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

function readJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function loadRegistry() {
  return readJson(REGISTRY_PATH);
}

function saveRegistry(registry) {
  writeJson(REGISTRY_PATH, registry);
}

function unique(values) {
  return [...new Set(values.filter(Boolean).map(String))];
}

function rootToken(registry) {
  const rootBot = (registry.pool || []).find((bot) => bot.id === "bot1");
  if (!rootBot?.token) throw new Error("registry.json is missing bot1 root token");
  return rootBot.token;
}

function projectBot(registry, project) {
  const bot = (registry.pool || []).find((entry) => entry.id === project.bot_id);
  if (!bot) throw new Error(`registry.json is missing bot ${project.bot_id}`);
  return bot;
}

function resolveProjects(registry, target) {
  const projects = Object.entries(registry.projects || {});
  if (!target) return projects;
  const match = projects.filter(
    ([name, project]) => name === target || String(project.channel_id || "") === target
  );
  if (match.length === 0) throw new Error(`No project registered for ${target}`);
  return match;
}

function roleName(projectName) {
  return `ccdm-guest-${projectName.replace(/[^a-zA-Z0-9._-]/g, "-")}`.slice(0, 100);
}

function effectiveUsers(registry, project) {
  return unique([registry.discord_user_id, ...(project.guest_user_ids || [])]);
}

function updateAccessJson(registry, project) {
  const bot = projectBot(registry, project);
  const stateDir = expandHome(bot.state_dir);
  const file = path.join(stateDir, "access.json");
  const access = readJson(file, {
    dmPolicy: "allowlist",
    allowFrom: [],
    groups: {},
    pending: {},
  });
  const users = effectiveUsers(registry, project);
  access.dmPolicy = access.dmPolicy || "allowlist";
  access.allowFrom = users;
  access.groups = access.groups || {};
  access.groups[project.channel_id] = {
    ...(access.groups[project.channel_id] || {}),
    requireMention: false,
    allowFrom: users,
  };
  access.pending = access.pending || {};
  writeJson(file, access);
}

async function discordApi(token, route, options = {}) {
  const method = options.method || "GET";
  const headers = {
    Authorization: `Bot ${token}`,
    "X-Audit-Log-Reason": "CCDM project guest access",
  };
  let body = options.body;
  if (options.json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(options.json);
  }
  const res = await fetch(`${API}${route}`, { method, headers, body });
  if (options.allow404 && res.status === 404) return null;
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${method} ${route} failed: Discord API ${res.status}${text ? `: ${text}` : ""}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

async function ensureGuestRole(registry, projectName, project, token) {
  if (project.guest_role_id) return project.guest_role_id;
  const name = roleName(projectName);
  const roles = await discordApi(token, `/guilds/${registry.guild_id}/roles`);
  const existing = roles.find((role) => role.name === name);
  if (existing) return existing.id;
  const role = await discordApi(token, `/guilds/${registry.guild_id}/roles`, {
    method: "POST",
    json: { name, permissions: "0", mentionable: false, hoist: false },
  });
  return role.id;
}

async function putOverwrite(token, channelId, overwriteId, type, allow, deny) {
  await discordApi(token, `/channels/${channelId}/permissions/${overwriteId}`, {
    method: "PUT",
    json: { allow: String(allow), deny: String(deny), type },
  });
}

async function managedChannelIds(registry, token) {
  try {
    const channels = await discordApi(token, `/guilds/${registry.guild_id}/channels`);
    const managedParents = new Set([...(registry.category_ids || []), ...(registry.guest_deny_channel_ids || [])]);
    return channels
      .filter((channel) => managedParents.has(channel.id) || managedParents.has(channel.parent_id))
      .map((channel) => channel.id);
  } catch (error) {
    console.error(`Warning: could not list guild channels for guest denies: ${error.message || error}`);
    return [];
  }
}

async function deniedChannelIds(registry, targetProject, token) {
  return unique([
    ...(registry.category_ids || []),
    ...(registry.guest_deny_channel_ids || []),
    ...(await managedChannelIds(registry, token)),
    ...Object.values(registry.projects || {})
      .map((project) => project.channel_id)
      .filter((channelId) => channelId && channelId !== targetProject.channel_id),
  ]).filter((channelId) => channelId !== targetProject.channel_id);
}

async function syncDiscordPermissions(registry, project, roleId, token) {
  for (const channelId of await deniedChannelIds(registry, project, token)) {
    await putOverwrite(token, channelId, roleId, 0, 0n, VIEW_CHANNEL);
  }
  await putOverwrite(token, project.channel_id, roleId, 0, GUEST_ALLOW, 0n);
}

async function tryPutMemberRole(registry, userId, roleId, token) {
  return discordApi(token, `/guilds/${registry.guild_id}/members/${userId}/roles/${roleId}`, {
    method: "PUT",
    allow404: true,
  });
}

async function tryDeleteMemberRole(registry, userId, roleId, token) {
  return discordApi(token, `/guilds/${registry.guild_id}/members/${userId}/roles/${roleId}`, {
    method: "DELETE",
    allow404: true,
  });
}

async function grant(registry, target, userId) {
  const token = rootToken(registry);
  const [[projectName, project]] = resolveProjects(registry, target);
  const roleId = await ensureGuestRole(registry, projectName, project, token);
  project.guest_role_id = roleId;
  project.guest_user_ids = unique([...(project.guest_user_ids || []), userId]);
  saveRegistry(registry);
  updateAccessJson(registry, project);
  await syncDiscordPermissions(registry, project, roleId, token);
  await tryPutMemberRole(registry, userId, roleId, token);
  console.log(`Granted ${userId} guest access to ${projectName}.`);
  return { projectName, project, roleId, token };
}

async function createInvite(registry, project, userId, roleId, token) {
  const form = new FormData();
  form.append(
    "payload_json",
    JSON.stringify({
      max_age: 604800,
      max_uses: 1,
      temporary: false,
      unique: true,
      role_ids: [roleId],
    })
  );
  form.append("target_users_file", new Blob([`${userId}\n`], { type: "text/csv" }), "target_users.csv");
  const invite = await discordApi(token, `/channels/${project.channel_id}/invites`, {
    method: "POST",
    body: form,
  });
  return invite.url || `https://discord.gg/${invite.code}`;
}

async function invite(registry, target, userId) {
  const result = await grant(registry, target, userId);
  const url = await createInvite(registry, result.project, userId, result.roleId, result.token);
  console.log(`Invite: ${url}`);
}

async function revoke(registry, target, userId) {
  const token = rootToken(registry);
  const [[projectName, project]] = resolveProjects(registry, target);
  project.guest_user_ids = unique(project.guest_user_ids || []).filter((id) => id !== String(userId));
  saveRegistry(registry);
  updateAccessJson(registry, project);
  if (project.guest_role_id) {
    await tryDeleteMemberRole(registry, userId, project.guest_role_id, token);
  }
  console.log(`Revoked ${userId} guest access from ${projectName}.`);
}

async function sync(registry, target) {
  const token = rootToken(registry);
  for (const [projectName, project] of resolveProjects(registry, target)) {
    if (!project.channel_id) continue;
    if ((project.guest_user_ids || []).length > 0 && !project.guest_role_id) {
      project.guest_role_id = await ensureGuestRole(registry, projectName, project, token);
      saveRegistry(registry);
    }
    updateAccessJson(registry, project);
    if (project.guest_role_id) {
      await syncDiscordPermissions(registry, project, project.guest_role_id, token);
      for (const userId of project.guest_user_ids || []) {
        await tryPutMemberRole(registry, userId, project.guest_role_id, token);
      }
    }
    console.log(`Synced ${projectName}.`);
  }
}

function list(registry, target) {
  for (const [projectName, project] of resolveProjects(registry, target)) {
    const guests = project.guest_user_ids?.length ? project.guest_user_ids.join(", ") : "(none)";
    console.log(`${projectName}: ${guests}`);
  }
}

async function main() {
  const [action, target, userId] = process.argv.slice(2);
  if (!["invite", "grant", "revoke", "sync", "list"].includes(action)) usage();
  if (["invite", "grant", "revoke"].includes(action) && (!target || !userId)) usage();
  if (["sync", "list"].includes(action) && userId) usage();

  const registry = loadRegistry();
  if (action === "invite") await invite(registry, target, userId);
  if (action === "grant") await grant(registry, target, userId);
  if (action === "revoke") await revoke(registry, target, userId);
  if (action === "sync") await sync(registry, target);
  if (action === "list") list(registry, target);
}

main().catch((error) => {
  console.error(`Error: ${error.message || error}`);
  process.exit(1);
});
