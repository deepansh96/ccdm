"use strict";

// Where the Router keeps its private state and finds its one credential.
const { readFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

function stateDir() {
  return process.env.CCDM_ROUTER_STATE_DIR || path.join(os.homedir(), ".local/state/ccdm/router");
}

function socketPath() {
  return path.join(stateDir(), "router.sock");
}

function registryPath() {
  return process.env.CCDM_REGISTRY_PATH || path.resolve(__dirname, "../..", "registry.json");
}

// The root bot token, read from root's Discord state directory as the other
// root admin tools do. It is never copied anywhere else.
async function rootToken() {
  const directory = process.env.ROOT_DISCORD_STATE_DIR || path.join(os.homedir(), ".claude/channels/discord");
  const source = await readFile(path.join(directory, ".env"), "utf8");
  const line = source.split(/\r?\n/).find(value => value.startsWith("DISCORD_BOT_TOKEN="));
  const token = line?.slice("DISCORD_BOT_TOKEN=".length).trim().replace(/^(["'])(.*)\1$/, "$2");
  if (!token || /\s/.test(token)) throw new Error("root Discord credentials are unavailable");
  return token;
}

module.exports = { registryPath, rootToken, socketPath, stateDir };
