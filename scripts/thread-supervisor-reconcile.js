#!/usr/bin/env node
"use strict";

// Reads what the Thread Supervisor may have missed while it was down or
// disconnected, for its reconciliation pass:
// `threads` lists the guild's active threads and, per project channel, public
// archived threads until every thread it asks about is found;
// `history` reads a thread's newest messages with root credentials;
// `auto-archive` sets a newly bound thread's one-week auto-archive with the
// project bot, whose token is read from the registry here.
const { readFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const API = "https://discord.com/api/v10";
const AUTO_ARCHIVE_MINUTES = 10080;
// Discord's page limits for archived threads and for channel messages.
const ARCHIVED_PAGE = 100;
const HISTORY_PAGE = 100;
// Archived pages read per channel before giving up on the threads asked about.
const ARCHIVED_PAGES = 20;

async function rootToken() {
  const directory = process.env.ROOT_DISCORD_STATE_DIR || path.join(os.homedir(), ".claude/channels/discord");
  const source = await readFile(path.join(directory, ".env"), "utf8").catch(() => "");
  const line = source.split(/\r?\n/).find(value => value.startsWith("DISCORD_BOT_TOKEN="));
  const token = line?.slice("DISCORD_BOT_TOKEN=".length).trim().replace(/^(["'])(.*)\1$/, "$2");
  if (!token || /\s/.test(token)) throw new Error("root Discord credentials are unavailable");
  return token;
}

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

// Second-precision UTC, which the supervisor clock compares against.
const utc = value => value ? new Date(value).toISOString().replace(/\.\d{3}Z$/, "Z") : null;

// Discord gives only threads in a forum or media channel `applied_tags`; a
// text channel's threads have none. Forum stands in for either.
const FORUM = 15;
const TEXT = 0;

const summary = thread => ({
  thread_id: thread.id, type: thread.type, parent_id: thread.parent_id,
  parent_type: Array.isArray(thread.applied_tags) ? FORUM : TEXT, name: thread.name ?? "",
  creator_id: thread.owner_id ?? null, archived: Boolean(thread.thread_metadata?.archived),
  archived_at: thread.thread_metadata?.archived ? utc(thread.thread_metadata.archive_timestamp) : null,
  auto_archive_duration: thread.thread_metadata?.auto_archive_duration ?? null,
});

async function threads(request) {
  const token = await rootToken();
  const active = (await discord(token, `/guilds/${encodeURIComponent(request.guild_id)}/threads/active`)).threads ?? [];
  const channels = new Set(request.channels.map(channel => channel.channel_id));
  const found = active.filter(thread => channels.has(thread.parent_id)).map(summary);
  const seen = new Set(found.map(thread => thread.thread_id));
  for (const channel of request.channels) {
    const wanted = new Set((channel.thread_ids ?? []).filter(id => !seen.has(id)));
    let before = null;
    for (let page = 0; wanted.size && page < ARCHIVED_PAGES; page++) {
      const listed = await discord(token, `/channels/${encodeURIComponent(channel.channel_id)}/threads/archived/public?limit=${ARCHIVED_PAGE}${before ? `&before=${encodeURIComponent(before)}` : ""}`);
      for (const thread of listed.threads ?? []) {
        wanted.delete(thread.id);
        if (!seen.has(thread.id)) found.push(summary(thread));
        seen.add(thread.id);
      }
      const last = (listed.threads ?? []).at(-1);
      if (!listed.has_more || !last) break;
      before = last.thread_metadata?.archive_timestamp;
    }
  }
  return { threads: found };
}

async function history(request) {
  const messages = await discord(await rootToken(),
    `/channels/${encodeURIComponent(request.thread_id)}/messages?limit=${HISTORY_PAGE}`);
  // Newest first, as Discord returns them.
  return { messages: messages.filter(message => !message.channel_id || message.channel_id === request.thread_id)
    .map(message => ({
    id: message.id, type: message.type ?? 0, author_id: message.author?.id ?? null,
    author_name: message.author?.username ?? null, bot: Boolean(message.author?.bot), content: message.content ?? "",
    timestamp: utc(message.timestamp), reference_message_id: message.message_reference?.message_id ?? null,
  })) };
}

// A failed update leaves the thread bound; it is logged as the observer logs it.
async function autoArchive(request) {
  const token = await botToken(request.project_root, request.bot_id);
  const response = await fetch(`${API}/channels/${encodeURIComponent(request.thread_id)}`, {
    method: "PATCH",
    headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ auto_archive_duration: AUTO_ARCHIVE_MINUTES }),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const hint = body.code === 50001 ? "; the project bot needs Manage Threads" : "";
    process.stderr.write(`thread-supervisor: thread ${request.thread_id} stays bound; auto-archive update failed ` +
      `with ${response.status} ${body.code ?? ""}${hint}\n`);
    return { auto_archive_duration: null };
  }
  return { auto_archive_duration: AUTO_ARCHIVE_MINUTES };
}

async function main() {
  const [mode, input] = process.argv.slice(2);
  const handlers = { threads, history, "auto-archive": autoArchive };
  if (!handlers[mode] || !input) throw new Error("usage: threads|history|auto-archive <request JSON>");
  process.stdout.write(`${JSON.stringify(await handlers[mode](JSON.parse(input)))}\n`);
}

main().catch(error => {
  process.stderr.write(`thread-supervisor-reconcile: ${error.message}\n`);
  process.exit(1);
});
