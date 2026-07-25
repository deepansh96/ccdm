#!/usr/bin/env node

const { createWriteStream } = require("node:fs");
const { mkdir, mkdtemp, readFile, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");

const API_BASE = "https://discord.com/api/v10";
const [channelId, startId, endId] = process.argv.slice(2);
const MAX_MESSAGES = 10_000;

function usage() {
  throw new Error("Usage: export-discord-range.js <channel-id> <start-message-id> [end-message-id]");
}

function validateIds() {
  if (![channelId, startId].every((id) => /^\d+$/.test(id || ""))) usage();
  if (endId && !/^\d+$/.test(endId)) usage();
  if (endId && BigInt(startId) > BigInt(endId)) {
    throw new Error("Start message ID must not be after end message ID");
  }
}

async function botToken() {
  if (process.env.DISCORD_BOT_TOKEN || process.env.BOT_TOKEN) {
    return process.env.DISCORD_BOT_TOKEN || process.env.BOT_TOKEN;
  }
  if (process.env.DISCORD_STATE_DIR) {
    try {
      const env = await readFile(path.join(process.env.DISCORD_STATE_DIR, ".env"), "utf8");
      const match = env.match(/^DISCORD_BOT_TOKEN=(.+)$/m);
      if (match) return match[1].trim();
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  const registry = JSON.parse(await readFile(path.join(__dirname, "..", "registry.json"), "utf8"));
  const project = Object.values(registry.projects || {}).find((entry) => String(entry.channel_id) === channelId);
  const bot = (registry.pool || []).find((entry) => entry.id === project?.bot_id)
    || (registry.pool || []).find((entry) => entry.id === "bot1")
    || registry.pool?.[0];
  if (!bot?.token) throw new Error("No bot token found; set DISCORD_BOT_TOKEN");
  return bot.token;
}

async function discordGet(token, endpoint) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const response = await fetch(`${API_BASE}${endpoint}`, {
      headers: { Authorization: `Bot ${token}` },
    });
    if (response.ok) return response.json();

    const body = await response.text();
    if (response.status !== 429 || attempt === 4) {
      throw new Error(`Discord API ${response.status}: ${body}`);
    }
    let retryAfter = 1;
    try {
      retryAfter = Number(JSON.parse(body).retry_after || retryAfter);
    } catch {
      // Discord normally returns JSON for rate limits; use a short fallback delay.
    }
    await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
  }
}

async function fetchMessages(token) {
  const messages = [
    await discordGet(token, `/channels/${channelId}/messages/${startId}`),
  ];
  if (endId && startId !== endId) {
    messages.push(await discordGet(token, `/channels/${channelId}/messages/${endId}`));
  }
  let before = endId;

  while (startId !== endId) {
    const query = before ? `?before=${before}&limit=100` : "?limit=100";
    const page = await discordGet(token, `/channels/${channelId}/messages${query}`);
    if (!page.length) break;
    const inRange = page.filter(({ id }) =>
      BigInt(id) > BigInt(startId) && (!endId || BigInt(id) < BigInt(endId))
    );
    if (messages.length + inRange.length > MAX_MESSAGES) {
      throw new Error(`Message range exceeds the ${MAX_MESSAGES}-message export limit`);
    }
    messages.push(...inRange);
    const oldest = page.reduce((lowest, { id }) => BigInt(id) < BigInt(lowest) ? id : lowest, page[0].id);
    if (BigInt(oldest) <= BigInt(startId)) break;
    before = oldest;
  }

  return [...new Map(messages.map((message) => [message.id, message])).values()]
    .sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : 1);
}

function safeName(name) {
  return path.basename(name || "attachment").replace(/[^a-zA-Z0-9._-]/g, "_");
}

async function downloadAttachments(messages, directory) {
  const attachmentDir = path.join(directory, "attachments");
  await mkdir(attachmentDir, { mode: 0o700 });
  const saved = new Map();

  for (const message of messages) {
    for (const attachment of message.attachments || []) {
      const destination = path.join(attachmentDir, `${message.id}-${attachment.id}-${safeName(attachment.filename)}`);
      const response = await fetch(attachment.url);
      if (!response.ok || !response.body) throw new Error(`Attachment download failed (${response.status}): ${attachment.url}`);
      await pipeline(Readable.fromWeb(response.body), createWriteStream(destination));
      saved.set(`${message.id}:${attachment.id}`, destination);
    }
  }
  return saved;
}

function transcript(messages, saved) {
  return messages.map((message) => {
    const author = message.author?.global_name || message.author?.username || "Unknown author";
    const lines = [
      `[${message.timestamp}] ${author} (${message.author?.id || "unknown"})`,
      `Message ID: ${message.id}`,
      message.content || "(no text)",
    ];
    for (const attachment of message.attachments || []) {
      lines.push(`Attachment: ${attachment.filename || attachment.id}`);
      lines.push(`URL: ${attachment.url}`);
      lines.push(`Saved: ${saved.get(`${message.id}:${attachment.id}`)}`);
    }
    return lines.join("\n");
  }).join("\n\n---\n\n") + "\n";
}

async function main() {
  validateIds();
  const token = await botToken();
  const messages = await fetchMessages(token);
  const directory = await mkdtemp(path.join(tmpdir(), "discord-export-"));
  const saved = await downloadAttachments(messages, directory);
  const output = path.join(directory, "messages.txt");
  await writeFile(output, transcript(messages, saved), { mode: 0o600 });
  process.stdout.write(`${output}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
