"use strict";

// One-time move of root's channels and allowed users from root's access.json
// into the registry. access.json is only read; a field the registry already
// has is left alone, so a second run changes nothing.
const { readFile } = require("node:fs/promises");
const { readRegistry, updateRegistry } = require("./registry.js");

// Root channels are access.json's no-mention groups; root's allowed users are
// everyone its allowlists name except the owner, who is always allowed.
function rootConfigFromAccess(access, ownerId) {
  const groups = Object.entries(access.groups || {}).filter(([, group]) => group?.requireMention === false);
  const users = [...(access.allowFrom || []), ...groups.flatMap(([, group]) => group.allowFrom || [])].map(String);
  return {
    root_channels: groups.map(([channelId]) => String(channelId)),
    root_allowed_user_ids: [...new Set(users)].filter(id => id !== ownerId),
  };
}

async function migrateRootConfig({ accessFile, registryFile }) {
  const access = JSON.parse(await readFile(accessFile, "utf8"));
  const registry = await readRegistry(registryFile);
  const ownerId = registry.discord_user_id ? String(registry.discord_user_id) : null;
  const missing = Object.entries(rootConfigFromAccess(access, ownerId)).filter(([field]) => !Object.hasOwn(registry, field));
  if (missing.length > 0) await updateRegistry(registryFile, next => Object.assign(next, Object.fromEntries(missing)));
  return Object.fromEntries(missing);
}

module.exports = { migrateRootConfig };
