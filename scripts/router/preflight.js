"use strict";

// Read-only readiness checks for supervising the Router: the interpreter, the
// registry, root's token, and the private socket directory. Each blocker names
// its fix. Nothing is created, re-permissioned, or loaded.
const fs = require("node:fs");
const path = require("node:path");
const { privateDirBlockers } = require("../platform/privacy.js");
const { registryPath, rootStateDir, rootToken, stateDir } = require("./paths.js");

const MINIMUM_NODE_MAJOR = 22;

function registryBlockers(file) {
  let registry;
  try {
    registry = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    return [`registry.json at ${file} cannot be read (${error.message}); fix or restore it`];
  }
  if (!registry || typeof registry !== "object" || Array.isArray(registry)) {
    return [`registry.json at ${file} is not a JSON object; fix or restore it`];
  }
  const blockers = [];
  if (!registry.discord_user_id) blockers.push("registry.json has no discord_user_id; set it to the CCDM owner's Discord user ID");
  if (registry.projects !== undefined && (typeof registry.projects !== "object" || Array.isArray(registry.projects))) {
    blockers.push("registry.json projects must be an object keyed by project name; fix or restore it");
  }
  return blockers;
}

// The directory holding the socket and keys must be private to this user.
// A missing directory is fine: the installer creates it private.
const socketDirectoryBlockers = dir => privateDirBlockers(dir, "Router state directory");

async function preflight() {
  const blockers = [];
  if (Number(process.versions.node.split(".")[0]) < MINIMUM_NODE_MAJOR) {
    blockers.push(`node ${MINIMUM_NODE_MAJOR} or newer is required; found ${process.versions.node}`);
  }
  blockers.push(...registryBlockers(registryPath()));
  try {
    await rootToken();
  } catch {
    blockers.push(`root Discord token is missing; add DISCORD_BOT_TOKEN to ${path.join(rootStateDir(), ".env")}`);
  }
  blockers.push(...socketDirectoryBlockers(stateDir()));
  // On Windows the token directory would otherwise inherit from the profile.
  if (process.platform === "win32") blockers.push(...privateDirBlockers(rootStateDir(), "Root token directory"));
  return { ready: blockers.length === 0, blockers };
}

module.exports = { preflight };
