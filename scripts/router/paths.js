"use strict";

// Where the Router keeps its private state and finds its one credential.
const { readFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { ipcEndpoint, readIpcSecret } = require("../platform/ipc.js");
const { expandHome, stateRoot } = require("../platform/paths.js");

function stateDir() {
  return process.env.CCDM_ROUTER_STATE_DIR || path.join(stateRoot(), "router");
}

// Where the Router is found, for messages: its socket on POSIX, and on Windows
// the file naming the pipe of the current start.
function socketPath() {
  return path.join(stateDir(), process.platform === "win32" ? "router.pipe" : "router.sock");
}

// Where a client connects right now and the secret the server must prove it
// holds (POSIX has none). On Windows both change at every Router start and
// this throws while either file is missing, so resolve it again for each
// attempt. The pipe name is read first: publishPipe writes the secret first,
// so a new name is never paired with the previous start's secret.
function routerEndpoint() {
  const dir = stateDir();
  const endpoint = ipcEndpoint(dir, "router");
  return { path: endpoint, secret: process.platform === "win32" ? readIpcSecret(dir, "router") : null };
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

module.exports = { expandHome, registryPath, rootStateDir, rootToken, routerEndpoint, socketPath, stateDir };
