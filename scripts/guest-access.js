#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const os = require("os");
const { ResolveError, resolveConversation } = require("./conversation-resolver.js");
const { updateRegistry } = require("./router/registry.js");

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

// A project's `guest_mode`: "managed" (the default) gates the channel behind a
// guest role and denies guests every other managed location; "registry-only"
// keeps guests in `guest_user_ids` alone, for people who already see the channel
// through their own Discord roles and must keep everything else they see.
const GUEST_MODES = new Set(["managed", "registry-only"]);

function guestMode(projectName, project) {
  const mode = project.guest_mode ?? "managed";
  if (!GUEST_MODES.has(mode)) {
    throw new Error(`Project ${projectName} has unknown guest_mode ${JSON.stringify(mode)}; use "managed" or "registry-only"`);
  }
  return mode;
}

function usage() {
  console.error(`Usage:
  scripts/guest-access.js invite <project|channel_id|thread_id|link> <user_id>
  scripts/guest-access.js grant <project|channel_id|thread_id|link> <user_id>
  scripts/guest-access.js revoke <project|channel_id|thread_id|link> <user_id>
  scripts/guest-access.js sync [project|channel_id|thread_id|link]
  scripts/guest-access.js list [project|channel_id|thread_id|link]`);
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

function loadRegistry() {
  return readJson(REGISTRY_PATH);
}

// Applies `mutate` to this project's fresh registry entry under the registry
// lock every writer shares, so a concurrent PID or webhook update, and a
// concurrent grant, revoke, or invite for another guest, is kept.
function updateGuestEntry(projectName, mutate) {
  return updateRegistry(REGISTRY_PATH, next => {
    const entry = next.projects?.[projectName];
    if (!entry) throw new Error(`Project ${projectName} is no longer registered`);
    mutate(entry);
  });
}

function addGuest(entry, roleId, userId, inviteCode = null) {
  entry.guest_role_id = roleId;
  entry.guest_user_ids = unique([...(entry.guest_user_ids || []), userId]);
  if (inviteCode) {
    entry.guest_invites = entry.guest_invites || {};
    entry.guest_invites[userId] = unique([...(entry.guest_invites[userId] || []), inviteCode]);
  }
}

function removeGuest(entry, userId) {
  entry.guest_user_ids = unique(entry.guest_user_ids || []).filter((id) => id !== String(userId));
  if (entry.guest_invites?.[userId]) {
    delete entry.guest_invites[userId];
    if (Object.keys(entry.guest_invites).length === 0) delete entry.guest_invites;
  }
}

function unique(values) {
  return [...new Set(values.filter(Boolean).map(String))];
}

function rootToken() {
  const stateDir = expandHome(process.env.ROOT_DISCORD_STATE_DIR || "~/.claude/channels/discord");
  let contents;
  try {
    contents = fs.readFileSync(path.join(stateDir, ".env"), "utf8");
  } catch {
    throw new Error("Cannot read root Discord credentials; check ROOT_DISCORD_STATE_DIR");
  }
  const line = contents.split(/\r?\n/).find((entry) => entry.startsWith("DISCORD_BOT_TOKEN="));
  const token = line?.slice("DISCORD_BOT_TOKEN=".length).trim().replace(/^(["'])(.*)\1$/, "$2");
  if (!token || /\s/.test(token)) throw new Error("Root Discord state has no valid DISCORD_BOT_TOKEN");
  return token;
}

// A thread, a link or a thread name names its parent project, through the
// conversation resolver.
function resolveProjects(registry, target) {
  const projects = Object.entries(registry.projects || {});
  if (!target) return projects;
  const match = projects.filter(
    ([name, project]) => name === target || String(project.channel_id || "") === target
  );
  if (match.length > 0) return match;
  const { project } = resolveConversation(target, { registryFile: REGISTRY_PATH });
  return projects.filter(([name]) => name === project);
}

function safeName(value) {
  return String(value || "").replace(/[^a-zA-Z0-9._-]/g, "-");
}

function roleName(projectName, project) {
  return `ccdm-guest-${safeName(projectName)}-${safeName(project.channel_id)}`.slice(0, 100);
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
  const name = roleName(projectName, project);
  const role = await discordApi(token, `/guilds/${registry.guild_id}/roles`, {
    method: "POST",
    json: { name, permissions: "0", mentionable: false, hoist: false },
  });
  return role.id;
}

async function putOverwrite(token, channelId, overwriteId, type, allow, deny, allow404 = false) {
  await discordApi(token, `/channels/${channelId}/permissions/${overwriteId}`, {
    method: "PUT",
    json: { allow: String(allow), deny: String(deny), type },
    allow404,
  });
}

async function managedChannelIds(registry, token) {
  const channels = await discordApi(token, `/guilds/${registry.guild_id}/channels`);
  const managedParents = new Set([...(registry.category_ids || []), ...(registry.guest_deny_channel_ids || [])]);
  return channels
    .filter((channel) => managedParents.has(channel.id) || managedParents.has(channel.parent_id))
    .map((channel) => channel.id);
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

// The registry-only guests of each registry-only project's channel. A managed
// guest who is also one of them keeps that channel: the managed role's deny
// there would otherwise hide it, so they get a member allow instead of a deny.
function registryOnlyGuestsByChannel(registry) {
  const byChannel = new Map();
  for (const [name, project] of Object.entries(registry.projects || {})) {
    if (!project.channel_id || guestMode(name, project) !== "registry-only") continue;
    byChannel.set(String(project.channel_id), new Set(unique(project.guest_user_ids || [])));
  }
  return byChannel;
}

async function syncDiscordPermissions(registry, project, roleId, token, userIds = project.guest_user_ids || [], options = {}) {
  const guests = unique(userIds);
  const denied = await deniedChannelIds(registry, project, token);
  const keep = registryOnlyGuestsByChannel(registry);
  for (const channelId of denied) {
    await putOverwrite(token, channelId, roleId, 0, 0n, VIEW_CHANNEL);
    for (const userId of guests) {
      const [allow, deny] = keep.get(channelId)?.has(userId) ? [GUEST_ALLOW, 0n] : [0n, VIEW_CHANNEL];
      await putOverwrite(token, channelId, userId, 1, allow, deny, Boolean(options.allowMissingMember));
    }
  }
  await putOverwrite(token, project.channel_id, roleId, 0, GUEST_ALLOW, 0n);
  for (const userId of guests) {
    await putOverwrite(token, project.channel_id, userId, 1, GUEST_ALLOW, 0n, Boolean(options.allowMissingMember));
  }
}

async function putMemberRole(registry, userId, roleId, token, allow404 = false) {
  return discordApi(token, `/guilds/${registry.guild_id}/members/${userId}/roles/${roleId}`, {
    method: "PUT",
    allow404,
  });
}

async function tryDeleteMemberRole(registry, userId, roleId, token) {
  return discordApi(token, `/guilds/${registry.guild_id}/members/${userId}/roles/${roleId}`, {
    method: "DELETE",
    allow404: true,
  });
}

async function prepareGuestAccess(registry, target, userId, options = {}) {
  const token = rootToken();
  const [[projectName, project]] = resolveProjects(registry, target);
  const roleId = await ensureGuestRole(registry, projectName, project, token);
  const guestUserIds = unique([...(project.guest_user_ids || []), userId]);
  await syncDiscordPermissions(registry, project, roleId, token, guestUserIds, options);
  await putMemberRole(registry, userId, roleId, token, Boolean(options.allowMissingMember));
  return { projectName, project, roleId, token, guestUserIds };
}

// Fails when the registry entry's mode changed since the command read it.
function requireMode(projectName, entry, expected) {
  const mode = guestMode(projectName, entry);
  if (mode !== expected) throw new Error(`${projectName} switched to guest_mode ${mode} while this command ran; run it again`);
}

// A guest role left from managed mode still shows the channel to whoever holds it.
function warnLeftoverRole(projectName, project) {
  if (project.guest_role_id) {
    console.error(`Warning: ${projectName} still has guest role ${project.guest_role_id} from managed mode; ` +
      "members holding it keep channel access by role until it is removed.");
  }
}

// Registry-only grant: the Router reads `guest_user_ids` live, so this alone
// lets the user drive the project; no role, overwrite or member role changes.
// A read-only member lookup first refuses an ID that is no one in the guild.
async function grantRegistryOnly(registry, projectName, project, userId) {
  const token = rootToken();
  const member = await discordApi(token, `/guilds/${registry.guild_id}/members/${userId}`, { allow404: true });
  if (!member) throw new Error(`${userId} is not a member of the guild; check the user ID`);
  await updateGuestEntry(projectName, entry => {
    requireMode(projectName, entry, "registry-only");
    entry.guest_user_ids = unique([...(entry.guest_user_ids || []), userId]);
  });
  warnLeftoverRole(projectName, project);
  console.log(`Granted ${userId} registry-only guest access to ${projectName}; Discord permissions unchanged.`);
}

async function grant(registry, target, userId, options = {}) {
  const [[projectName, project]] = resolveProjects(registry, target);
  if (guestMode(projectName, project) === "registry-only") return grantRegistryOnly(registry, projectName, project, userId);
  const result = await prepareGuestAccess(registry, target, userId, options);
  await updateGuestEntry(result.projectName, entry => {
    requireMode(result.projectName, entry, "managed");
    addGuest(entry, result.roleId, userId);
  });
  console.log(`Granted ${userId} guest access to ${result.projectName}.`);
  return result;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForTargetUsersJob(token, code) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const job = await discordApi(token, `/invites/${code}/target-users/job-status`);
    if (job.status === 2) return;
    if (job.status === 3) throw new Error(`Invite target-users job failed: ${job.error_message || "unknown error"}`);
    await sleep(1000);
  }
  throw new Error(`Invite target-users job timed out for ${code}`);
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
  try {
    await waitForTargetUsersJob(token, invite.code);
  } catch (error) {
    if (invite.code) await deleteInvite(token, invite.code);
    throw error;
  }
  return { code: invite.code, url: invite.url || `https://discord.gg/${invite.code}` };
}

async function invite(registry, target, userId) {
  const [[projectName, project]] = resolveProjects(registry, target);
  if (guestMode(projectName, project) === "registry-only") {
    throw new Error(`${projectName} uses registry-only guests: give ${userId} Discord access to the channel, then run grant`);
  }
  const result = await prepareGuestAccess(registry, target, userId, { allowMissingMember: true });
  const inviteResult = await createInvite(registry, result.project, userId, result.roleId, result.token);
  await updateGuestEntry(result.projectName, entry => {
    requireMode(result.projectName, entry, "managed");
    addGuest(entry, result.roleId, userId, inviteResult.code);
  });
  console.log(`Granted ${userId} guest access to ${result.projectName}.`);
  console.log(`Invite: ${inviteResult.url}`);
}

async function deleteInvite(token, code) {
  await discordApi(token, `/invites/${code}`, { method: "DELETE", allow404: true });
}

async function revoke(registry, target, userId) {
  const [[projectName, project]] = resolveProjects(registry, target);
  guestMode(projectName, project);
  const codes = project.guest_invites?.[userId] || [];
  // In either mode, a guest role (in registry-only mode, one left from managed
  // mode) is taken off the user, so they stop seeing the channel through it.
  const token = rootToken();
  if (project.guest_role_id) {
    await tryDeleteMemberRole(registry, userId, project.guest_role_id, token);
  }
  for (const code of codes) {
    await deleteInvite(token, code);
  }
  await updateGuestEntry(projectName, entry => removeGuest(entry, userId));
  console.log(`Revoked ${userId} guest access from ${projectName}.`);
}

async function sync(registry, target) {
  const projects = resolveProjects(registry, target);
  const token = rootToken();
  for (const [projectName, project] of projects) {
    if (guestMode(projectName, project) === "registry-only") {
      console.log(`Skipped ${projectName}: registry-only guests keep their own Discord permissions.`);
      continue;
    }
    if (!project.channel_id) continue;
    if ((project.guest_user_ids || []).length > 0 && !project.guest_role_id) {
      const roleId = await ensureGuestRole(registry, projectName, project, token);
      await updateGuestEntry(projectName, entry => {
        entry.guest_role_id = entry.guest_role_id || roleId;
        project.guest_role_id = entry.guest_role_id;
      });
    }
    if (project.guest_role_id) {
      await syncDiscordPermissions(registry, project, project.guest_role_id, token);
      for (const userId of project.guest_user_ids || []) {
        await putMemberRole(registry, userId, project.guest_role_id, token, true);
      }
    }
    console.log(`Synced ${projectName}.`);
  }
}

function list(registry, target) {
  for (const [projectName, project] of resolveProjects(registry, target)) {
    const guests = project.guest_user_ids?.length ? project.guest_user_ids.join(", ") : "(none)";
    let mode;
    try {
      mode = guestMode(projectName, project) === "registry-only" ? " (registry-only)" : "";
    } catch {
      mode = ` (invalid guest_mode ${JSON.stringify(project.guest_mode)})`;
    }
    console.log(`${projectName}${mode}: ${guests}`);
    if (mode === " (registry-only)") warnLeftoverRole(projectName, project);
  }
}

async function main() {
  const [action, target, userId] = process.argv.slice(2);
  if (!["invite", "grant", "revoke", "sync", "list"].includes(action)) usage();
  if (["invite", "grant", "revoke"].includes(action) && (!target || !userId)) usage();
  if (["sync", "list"].includes(action) && userId) usage();
  if (userId && !/^\d{17,20}$/.test(userId)) {
    console.error(`Error: ${JSON.stringify(userId)} is not a Discord user ID (17-20 digits)`);
    process.exit(2);
  }

  const registry = loadRegistry();
  try {
    resolveProjects(registry, target);
  } catch (error) {
    if (!(error instanceof ResolveError)) throw error;
    console.error(`conversation-resolver: ${error.message}`);
    process.exit(2);
  }
  // A managed grant, invite or sync reads every project's mode (to keep
  // registry-only channels for their guests), so all are checked before any write.
  if (["invite", "grant", "sync"].includes(action)) {
    for (const [projectName, project] of Object.entries(registry.projects || {})) guestMode(projectName, project);
  }
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
