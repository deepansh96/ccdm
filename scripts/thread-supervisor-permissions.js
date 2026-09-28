#!/usr/bin/env node
"use strict";

// Reads, and with `grant` sets, each project bot's member overwrite on its
// own channel with root credentials. The Thread Supervisor resolves the
// targets; this helper touches only the overwrites it is given.
const { readFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const API = "https://discord.com/api/v10";
// View Channel, Send Messages, Read Message History, Attach Files, Add
// Reactions, Send Messages in Threads, Manage Threads, Create Public Threads.
const THREAD_ALLOW = "326417615936";
const MANAGE_THREADS = 1n << 34n;
const CREATE_PUBLIC_THREADS = 1n << 35n;

async function rootToken() {
  const directory = process.env.ROOT_DISCORD_STATE_DIR || path.join(os.homedir(), ".claude/channels/discord");
  const source = await readFile(path.join(directory, ".env"), "utf8").catch(() => "");
  const line = source.split(/\r?\n/).find(value => value.startsWith("DISCORD_BOT_TOKEN="));
  const token = line?.slice("DISCORD_BOT_TOKEN=".length).trim().replace(/^(["'])(.*)\1$/, "$2");
  if (!token || /\s/.test(token)) throw new Error("root Discord credentials are unavailable");
  return token;
}

async function discord(token, route, options = {}) {
  const response = await fetch(`${API}${route}`, {
    method: options.method || "GET",
    headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json",
      "X-Audit-Log-Reason": "CCDM thread permissions" },
    body: options.json === undefined ? undefined : JSON.stringify(options.json),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`${options.method || "GET"} ${route} failed: Discord API ${response.status}${text ? `: ${text}` : ""}`);
  }
  return response.status === 204 ? null : response.json();
}

function hasThreadPermissions(overwrite) {
  const allow = BigInt(overwrite?.allow ?? 0);
  return (allow & MANAGE_THREADS) === MANAGE_THREADS && (allow & CREATE_PUBLIC_THREADS) === CREATE_PUBLIC_THREADS;
}

async function main() {
  const [mode, input] = process.argv.slice(2);
  if (!["check", "grant"].includes(mode) || !input) throw new Error("usage: check|grant <request JSON>");
  const { guild_id: guildId, targets } = JSON.parse(input);
  const token = await rootToken();
  const channels = await discord(token, `/guilds/${guildId}/channels`);
  const results = {};
  for (const { project, channel_id: channelId, bot_user_id: botUserId } of targets) {
    const channel = channels.find(entry => entry.id === channelId);
    if (!channel) {
      results[project] = { result: "failed", reason: `channel ${channelId} is not in the guild` };
      continue;
    }
    const overwrite = (channel.permission_overwrites ?? []).find(entry => entry.id === botUserId && entry.type === 1);
    if (mode === "check") {
      results[project] = { result: hasThreadPermissions(overwrite) ? "ok" : "missing" };
    } else if (overwrite?.allow === THREAD_ALLOW && overwrite?.deny === "0") {
      results[project] = { result: "unchanged" };
    } else {
      try {
        await discord(token, `/channels/${channelId}/permissions/${botUserId}`, {
          method: "PUT", json: { allow: THREAD_ALLOW, deny: "0", type: 1 },
        });
        results[project] = { result: "granted" };
      } catch (error) {
        results[project] = { result: "failed", reason: error.message };
      }
    }
  }
  process.stdout.write(`${JSON.stringify(results)}\n`);
}

main().catch(error => {
  process.stderr.write(`thread-supervisor-permissions: ${error.message}\n`);
  process.exit(1);
});
