#!/usr/bin/env node
"use strict";

// Applies one Thread Supervisor Discord side effect with the owning project's
// bot: add or remove a reaction, read a message, post a one-line notice,
// create a standalone public thread with the one-week auto-archive, or archive
// a thread for `/close`.
// The bot token is read from the registry here, never passed on the command line.
const { readFile } = require("node:fs/promises");
const path = require("node:path");

const API = "https://discord.com/api/v10";
// A public thread, archived after a week of inactivity (Discord's longest).
const PUBLIC_THREAD = 11;
const AUTO_ARCHIVE_MINUTES = 10080;

async function botToken(projectRoot, botId) {
  const registry = JSON.parse(await readFile(path.join(projectRoot, "registry.json"), "utf8"));
  const bots = (registry.pool || []).filter(row => row?.id === botId);
  if (bots.length !== 1 || !bots[0].token) throw new Error(`project bot ${botId} has no token`);
  return bots[0].token;
}

async function discord(token, route, options = {}) {
  const response = await fetch(`${API}${route}`, {
    method: options.method || "GET",
    headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
    body: options.json === undefined ? undefined : JSON.stringify(options.json),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`${options.method || "GET"} ${route} failed: Discord API ${response.status}${text ? `: ${text}` : ""}`);
  }
  return response.status === 204 ? null : response.json();
}

async function main() {
  const [operation, input] = process.argv.slice(2);
  const request = JSON.parse(input || "{}");
  const token = await botToken(request.project_root, request.bot_id);
  const channel = encodeURIComponent(request.channel_id);
  const message = encodeURIComponent(request.message_id || "");
  const reaction = `/channels/${channel}/messages/${message}/reactions/${encodeURIComponent(request.emoji || "")}/@me`;
  let result = null;
  if (operation === "react") {
    await discord(token, reaction, { method: "PUT" });
  } else if (operation === "unreact") {
    await discord(token, reaction, { method: "DELETE" });
  } else if (operation === "get-message") {
    const found = await discord(token, `/channels/${channel}/messages/${message}`);
    result = { id: found.id, content: found.content ?? "", author: found.author?.username ?? found.author?.id ?? "" };
  } else if (operation === "post") {
    const sent = await discord(token, `/channels/${channel}/messages`, {
      method: "POST", json: { content: request.content, allowed_mentions: { parse: [] } },
    });
    result = { id: sent.id };
  } else if (operation === "create-thread") {
    const created = await discord(token, `/channels/${channel}/threads`, {
      method: "POST", json: { name: request.name, type: PUBLIC_THREAD, auto_archive_duration: AUTO_ARCHIVE_MINUTES },
    });
    result = { id: created.id, owner_id: created.owner_id ?? null };
  } else if (operation === "archive") {
    await discord(token, `/channels/${channel}`, { method: "PATCH", json: { archived: true } });
    result = { archived: true };
  } else {
    throw new Error("usage: react|unreact|get-message|post|create-thread|archive <request JSON>");
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main().catch(error => {
  process.stderr.write(`thread-supervisor-discord: ${error.message}\n`);
  process.exit(1);
});
