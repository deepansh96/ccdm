"use strict";

// Where the Router keeps its private state and finds its one credential.
const { readFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

// Expands a leading `~` or `~/` to the home directory, as guest-access.js and
// the shell lifecycle scripts (Python's os.path.expanduser) do for registry paths.
function expandHome(value) {
  if (typeof value !== "string") return value;
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

function stateDir() {
  return process.env.CCDM_ROUTER_STATE_DIR || path.join(os.homedir(), ".local/state/ccdm/router");
}

function socketPath() {
  return path.join(stateDir(), "router.sock");
}

function registryPath() {
  return process.env.CCDM_REGISTRY_PATH || path.resolve(__dirname, "../..", "registry.json");
}

// Root's Discord state directory: its token and legacy access.json.
function rootStateDir() {
  return process.env.ROOT_DISCORD_STATE_DIR || path.join(os.homedir(), ".claude/channels/discord");
}

// The root bot token, read from root's Discord state directory as the other
// root admin tools do. It is never copied anywhere else.
async function rootToken() {
  const source = await readFile(path.join(rootStateDir(), ".env"), "utf8");
  const line = source.split(/\r?\n/).find(value => value.startsWith("DISCORD_BOT_TOKEN="));
  const token = line?.slice("DISCORD_BOT_TOKEN=".length).trim().replace(/^(["'])(.*)\1$/, "$2");
  if (!token || /\s/.test(token)) throw new Error("root Discord credentials are unavailable");
  return token;
}

module.exports = { expandHome, registryPath, rootStateDir, rootToken, socketPath, stateDir };
