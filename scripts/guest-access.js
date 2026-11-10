#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { ResolveError, resolveConversation } = require("./conversation-resolver.js");
const { guestModeProblem, updateRegistry } = require("./router/registry.js");
const { expandHome } = require("./platform/paths.js");

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
  scripts/guest-access.js invite <project|channel_id|thread_id|link> <user_id>
  scripts/guest-access.js grant <project|channel_id|thread_id|link> <user_id>
  scripts/guest-access.js revoke <project|channel_id|thread_id|link> <user_id>
  scripts/guest-access.js sync [project|channel_id|thread_id|link]
  scripts/guest-access.js list [project|channel_id|thread_id|link]`);
  process.exit(2);
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

// The registry's `guest_mode` (GUEST_MODES in router/registry.js). Role mode is
// the default and the only mode that creates, assigns or removes a role;
// "member-overwrites" gives each guest channel overwrites of their own instead,
// and "none" takes no new guests.
function guestMode(registry) {
  const problem = guestModeProblem(registry?.guest_mode);
  if (problem) throw new Error(`invalid registry: ${problem}`);
  return registry?.guest_mode || "roles";
}

// `roleId` is null outside role mode, where there is no role to record.
function addGuest(entry, roleId, userId, inviteCode = null) {
  if (roleId !== null) entry.guest_role_id = roleId;
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
  if (options.allow404 && res.status === 404) {
    options.on404?.();
    return null;
  }
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

// Resolves to false when a tolerated 404 (a member who is not in the server)
// left the overwrite unwritten.
async function putOverwrite(token, channelId, overwriteId, type, allow, deny, allow404 = false) {
  let written = true;
  await discordApi(token, `/channels/${channelId}/permissions/${overwriteId}`, {
    method: "PUT",
    json: { allow: String(allow), deny: String(deny), type },
    allow404,
    on404: () => { written = false; },
  });
  return written;
}

async function deleteOverwrite(token, channelId, overwriteId) {
  await discordApi(token, `/channels/${channelId}/permissions/${overwriteId}`, { method: "DELETE", allow404: true });
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

// Denies the guests every other managed location and allows them the project
// channel. With a `roleId` (role mode) the role gets the same overwrites; with
// a null one, only member overwrites are written. Returns the guests whose member
// overwrites a tolerated 404 left unwritten.
async function syncDiscordPermissions(registry, project, roleId, token, userIds = project.guest_user_ids || [], options = {}) {
  const guests = unique(userIds);
  const missing = new Set();
  const putMember = async (channelId, userId, allow, deny) => {
    const written = await putOverwrite(token, channelId, userId, 1, allow, deny, Boolean(options.allowMissingMember));
    if (!written) missing.add(userId);
  };
  const denied = await deniedChannelIds(registry, project, token);
  for (const channelId of denied) {
    if (roleId !== null) await putOverwrite(token, channelId, roleId, 0, 0n, VIEW_CHANNEL);
    for (const userId of guests) {
      await putMember(channelId, userId, 0n, VIEW_CHANNEL);
    }
  }
  if (roleId !== null) await putOverwrite(token, project.channel_id, roleId, 0, GUEST_ALLOW, 0n);
  for (const userId of guests) {
    await putMember(project.channel_id, userId, GUEST_ALLOW, 0n);
  }
  return [...missing];
}

// Member-overwrites mode's sync: rewrites the overwrites of the project's
// guests, then removes guest overwrites left on the project channel for anyone
// else. Only a member overwrite whose allow is exactly GUEST_ALLOW counts as a
// guest's, and the owner's is never removed.
async function syncMemberOverwrites(registry, projectName, project, token) {
  const guests = unique(project.guest_user_ids || []);
  if (guests.length > 0) {
    const missing = await syncDiscordPermissions(registry, project, null, token, guests, { allowMissingMember: true });
    for (const userId of missing) console.log(notInServer(userId, projectName));
  }
  const channel = await discordApi(token, `/channels/${project.channel_id}`);
  const kept = new Set([...guests, String(registry.discord_user_id)]);
  for (const overwrite of channel.permission_overwrites || []) {
    if (overwrite.type !== 1 || kept.has(String(overwrite.id))) continue;
    if (String(overwrite.allow) !== String(GUEST_ALLOW)) continue;
    await deleteOverwrite(token, project.channel_id, overwrite.id);
    console.log(`Removed the stale guest permission of ${overwrite.id} from ${projectName}.`);
  }
}

function notInServer(userId, projectName) {
  return `${userId} is not in the server, so they have no channel permission yet. ` +
    `After they join, run: node scripts/guest-access.js sync ${projectName}`;
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
  const roleId = guestMode(registry) === "roles" ? await ensureGuestRole(registry, projectName, project, token) : null;
  const guestUserIds = unique([...(project.guest_user_ids || []), userId]);
  const missing = await syncDiscordPermissions(registry, project, roleId, token, guestUserIds, options);
  if (roleId !== null) await putMemberRole(registry, userId, roleId, token, Boolean(options.allowMissingMember));
  return { projectName, project, roleId, token, guestUserIds, missing };
}

async function grant(registry, target, userId, options = {}) {
  const result = await prepareGuestAccess(registry, target, userId, options);
  await updateGuestEntry(result.projectName, entry => addGuest(entry, result.roleId, userId));
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
      ...(roleId !== null ? { role_ids: [roleId] } : {}),
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
  const result = await prepareGuestAccess(registry, target, userId, { allowMissingMember: true });
  const inviteResult = await createInvite(registry, result.project, userId, result.roleId, result.token);
  await updateGuestEntry(result.projectName, entry => addGuest(entry, result.roleId, userId, inviteResult.code));
  console.log(`Granted ${userId} guest access to ${result.projectName}.`);
  console.log(`Invite: ${inviteResult.url}`);
  // Without a role the invite carries no access of its own.
  if (result.roleId === null && result.missing.includes(String(userId))) console.log(notInServer(userId, result.projectName));
}

async function deleteInvite(token, code) {
  await discordApi(token, `/invites/${code}`, { method: "DELETE", allow404: true });
}

async function revoke(registry, target, userId) {
  const token = rootToken();
  const [[projectName, project]] = resolveProjects(registry, target);
  if (guestMode(registry) === "member-overwrites") {
    // No role to remove: the guest's access is their own allow overwrite.
    await deleteOverwrite(token, project.channel_id, userId);
  } else if (project.guest_role_id) {
    await tryDeleteMemberRole(registry, userId, project.guest_role_id, token);
  }
  for (const code of project.guest_invites?.[userId] || []) {
    await deleteInvite(token, code);
  }
  await updateGuestEntry(projectName, entry => removeGuest(entry, userId));
  console.log(`Revoked ${userId} guest access from ${projectName}.`);
}

async function sync(registry, target) {
  const token = rootToken();
  const memberMode = guestMode(registry) === "member-overwrites";
  for (const [projectName, project] of resolveProjects(registry, target)) {
    if (!project.channel_id) continue;
    if (memberMode) {
      await syncMemberOverwrites(registry, projectName, project, token);
      console.log(`Synced ${projectName}.`);
      continue;
    }
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
    console.log(`${projectName}: ${guests}`);
  }
}

async function main() {
  const [action, target, userId] = process.argv.slice(2);
  if (!["invite", "grant", "revoke", "sync", "list"].includes(action)) usage();
  if (["invite", "grant", "revoke"].includes(action) && (!target || !userId)) usage();
  if (["sync", "list"].includes(action) && userId) usage();

  const registry = loadRegistry();
  if (guestMode(registry) === "none" && ["invite", "grant", "sync"].includes(action)) {
    console.error(`Error: guest ${action} is off for this registry: guest_mode is "none" (owner decision D4: ` +
      "no guests where the bot would need server-wide Manage Roles). revoke and list still work.");
    process.exit(1);
  }
  try {
    resolveProjects(registry, target);
  } catch (error) {
    if (!(error instanceof ResolveError)) throw error;
    console.error(`conversation-resolver: ${error.message}`);
    process.exit(2);
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
