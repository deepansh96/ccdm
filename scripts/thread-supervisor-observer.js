#!/usr/bin/env node
"use strict";

// The Thread Supervisor's Gateway client. It logs in as root, hands each
// thread event to the Python service, and applies Discord side effects with
// the owning project's bot. It never dispatches coding input.
const { execFile } = require("node:child_process");
const { readFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { promisify } = require("node:util");
const { Client, GatewayIntentBits } = require("discord.js");

const exec = promisify(execFile);
const service = path.join(__dirname, "thread-supervisor.py");
const argument = name => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : null;
const projectRoot = argument("--project-root") || path.resolve(__dirname, "..");
const stateDir = argument("--state-dir") || process.env.CCDM_THREAD_STATE_DIR ||
  path.join(os.homedir(), ".local/state/ccdm/thread-supervisor");
const AUTO_ARCHIVE_MINUTES = 10080;
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMessageReactions],
});
// Events are handled one at a time, in Gateway order.
let queue = Promise.resolve();

function log(message) {
  process.stderr.write(`thread-supervisor: ${message}\n`);
}

async function rootToken() {
  const directory = process.env.ROOT_DISCORD_STATE_DIR || path.join(os.homedir(), ".claude/channels/discord");
  const source = await readFile(path.join(directory, ".env"), "utf8");
  const line = source.split(/\r?\n/).find(value => value.startsWith("DISCORD_BOT_TOKEN="));
  const token = line?.slice("DISCORD_BOT_TOKEN=".length).trim().replace(/^(["'])(.*)\1$/, "$2");
  if (!token || /\s/.test(token)) throw new Error("root Discord credentials are unavailable");
  return token;
}

async function botToken(botId) {
  const registry = JSON.parse(await readFile(path.join(projectRoot, "registry.json"), "utf8"));
  const bots = (registry.pool || []).filter(row => row?.id === botId);
  return bots.length === 1 ? bots[0].token || null : null;
}

async function setAutoArchive(threadId, botId) {
  const token = await botToken(botId);
  if (!token) {
    log(`thread ${threadId} is bound, but its project bot has no token to set auto-archive`);
    return;
  }
  const response = await fetch(`https://discord.com/api/v10/channels/${threadId}`, {
    method: "PATCH",
    headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ auto_archive_duration: AUTO_ARCHIVE_MINUTES }),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const hint = body.code === 50001 ? "; the project bot needs Manage Threads" : "";
    log(`thread ${threadId} stays bound; auto-archive update failed with ${response.status} ${body.code ?? ""}${hint}`);
  }
}

async function threadCreated(thread) {
  const payload = {
    thread_id: thread.id, type: thread.type, parent_id: thread.parentId, parent_type: thread.parent?.type ?? null,
    name: thread.name, creator_id: thread.ownerId, auto_archive_duration: thread.autoArchiveDuration,
  };
  const { stdout } = await exec(process.env.CCDM_THREAD_PYTHON || "python3", [service, "bind",
    "--project-root", projectRoot, "--state-dir", stateDir, "--payload", JSON.stringify(payload)]);
  const result = JSON.parse(stdout);
  if (result.result === "bound" && result.set_auto_archive) await setAutoArchive(thread.id, result.bot_id);
}

client.on("threadCreate", thread => {
  queue = queue.then(() => threadCreated(thread)).catch(error => log(`thread ${thread.id}: ${error.message}`));
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    queue.finally(() => {
      client.destroy();
      process.exit(0);
    });
  });
}

rootToken().then(token => client.login(token)).catch(error => {
  log(error.message);
  process.exit(1);
});
