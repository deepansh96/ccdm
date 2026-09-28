#!/usr/bin/env node
"use strict";

// Reads the guild audit log with root credentials for the Thread Supervisor.
// `actor` finds who archived a thread (action 111, `archived` false -> true);
// `check` probes whether root can read the audit log at all.
const { readFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const API = "https://discord.com/api/v10";
// Audit-log action type THREAD_UPDATE.
const THREAD_UPDATE = 111;
// Discord's snowflake epoch; an id's top bits are milliseconds since it.
const DISCORD_EPOCH = 1420070400000n;
// An entry older than the archive by more than this is an earlier archive.
const ARCHIVE_SLACK_MS = 10000;

async function rootToken() {
  const directory = process.env.ROOT_DISCORD_STATE_DIR || path.join(os.homedir(), ".claude/channels/discord");
  const source = await readFile(path.join(directory, ".env"), "utf8").catch(() => "");
  const line = source.split(/\r?\n/).find(value => value.startsWith("DISCORD_BOT_TOKEN="));
  const token = line?.slice("DISCORD_BOT_TOKEN=".length).trim().replace(/^(["'])(.*)\1$/, "$2");
  if (!token || /\s/.test(token)) throw new Error("root Discord credentials are unavailable");
  return token;
}

// Resolves to the entries, or null when root lacks View Audit Log (403).
async function archiveEntries(token, guildId, limit) {
  const response = await fetch(`${API}/guilds/${encodeURIComponent(guildId)}/audit-logs?action_type=${THREAD_UPDATE}&limit=${limit}`, {
    headers: { Authorization: `Bot ${token}` },
    signal: AbortSignal.timeout(10000),
  });
  if (response.status === 403) return null;
  if (!response.ok) throw new Error(`GET audit log failed: Discord API ${response.status}`);
  return (await response.json()).audit_log_entries ?? [];
}

const createdAt = id => Number((BigInt(id) >> 22n) + DISCORD_EPOCH);

async function main() {
  const [mode, input] = process.argv.slice(2);
  if (!["actor", "check"].includes(mode) || !input) throw new Error("usage: actor|check <request JSON>");
  const request = JSON.parse(input);
  const entries = await archiveEntries(await rootToken(), request.guild_id, mode === "check" ? 1 : 50);
  let result;
  if (entries === null) {
    result = { result: "forbidden" };
  } else if (mode === "check") {
    result = { result: "ok" };
  } else {
    const archivedAt = request.archived_at ? Date.parse(request.archived_at) : null;
    // Entries come newest first.
    const entry = entries.find(candidate => candidate.target_id === request.thread_id &&
      (candidate.changes ?? []).some(change => change.key === "archived" && change.new_value === true) &&
      (archivedAt === null || createdAt(candidate.id) >= archivedAt - ARCHIVE_SLACK_MS));
    result = entry ? { result: "found", user_id: String(entry.user_id) } : { result: "none" };
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main().catch(error => {
  process.stderr.write(`thread-supervisor-audit: ${error.message}\n`);
  process.exit(1);
});
