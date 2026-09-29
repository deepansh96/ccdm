"use strict";

// Reads of the session's own channel with the bot token, in the Discord MCP's
// line format. Large reads and range exports land in private temporary files.
const { mkdtemp, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { exportRange } = require("../../export-discord-range.js");
const { isStale } = require("../attachments.js");
const { discordRequest } = require("../discord-rest.js");
const { OpError } = require("./errors.js");
const { scopedMessage } = require("./targets.js");

const PAGE_LIMIT = 100;
const INLINE_LIMIT = 100;
const MAX_READ = 10_000;

function formatLine(message) {
  const author = message.author.bot ? "me" : message.author.username;
  const attachments = message.attachments?.length ? ` +${message.attachments.length}att` : "";
  return `[${message.timestamp}] ${author}: ${message.content}${attachments} (id: ${message.id})`;
}

// The newest `count` messages, newest first, one Discord page at a time.
async function recentMessages(ctx, count) {
  const messages = [];
  let before;
  while (messages.length < count) {
    const limit = Math.min(count - messages.length, PAGE_LIMIT);
    const page = await discordRequest("GET", `/channels/${ctx.session.route.channel_id}/messages`, {
      token: ctx.token, query: { limit, ...(before ? { before } : {}) },
    });
    messages.push(...page);
    if (page.length < limit) break;
    before = page.at(-1).id;
  }
  return messages;
}

async function fetchMessages(ctx, args) {
  const limit = args.limit === undefined ? 20 : args.limit;
  if (!Number.isInteger(limit) || limit < 1) throw new OpError("invalid_args", "limit must be a positive integer");
  const messages = (await recentMessages(ctx, Math.min(limit, PAGE_LIMIT))).reverse();
  return { count: messages.length, text: messages.map(formatLine).join("\n") };
}

async function readLastMessages(ctx, args) {
  const { count } = args;
  if (!Number.isInteger(count) || count < 1 || count > MAX_READ) {
    throw new OpError("invalid_args", "count must be an integer between 1 and 10,000");
  }
  const messages = (await recentMessages(ctx, count)).reverse();
  const text = messages.map(formatLine).join("\n");
  if (count <= INLINE_LIMIT) return { count: messages.length, text };
  const directory = await mkdtemp(path.join(tmpdir(), "discord-recent-"));
  const transcript = path.join(directory, "messages.txt");
  await writeFile(transcript, `${text}\n`, { mode: 0o600 });
  return { count: messages.length, path: transcript };
}

const isSnowflake = id => typeof id === "string" && /^\d+$/.test(id);

// Both ends must be messages in the session's channel before anything is read.
async function exportMessageRange(ctx, args) {
  const { start_message_id: startId, end_message_id: endId } = args;
  if (!isSnowflake(startId) || (endId !== undefined && !isSnowflake(endId))) {
    throw new OpError("invalid_args", "start_message_id and end_message_id must be message IDs");
  }
  if (endId !== undefined && BigInt(startId) > BigInt(endId)) {
    throw new OpError("invalid_args", "start_message_id must not be after end_message_id");
  }
  for (const id of endId === undefined ? [startId] : [startId, endId]) await scopedMessage(ctx, id);
  const output = await exportRange({ token: ctx.token, channelId: ctx.session.route.channel_id, startId, endId });
  return { path: output };
}

function pickAttachment(attachments, args) {
  if (args.attachment_id !== undefined) return attachments.find(attachment => attachment.id === String(args.attachment_id));
  const index = args.attachment_index ?? 0;
  if (!Number.isInteger(index) || index < 0) throw new OpError("invalid_args", "attachment_index must be a non-negative integer");
  return attachments[index];
}

// Hands back a signed CDN URL for the session to fetch itself. A delivered
// event's URL is reused while fresh; otherwise the message is fetched from the
// session's channel, which also re-signs its URLs.
async function downloadAttachment(ctx, args) {
  const { channel_id: channelId } = ctx.session.route;
  const cached = typeof args.message_id === "string" ? ctx.attachments.get(channelId, args.message_id) : null;
  const hit = cached && pickAttachment(cached, args);
  if (hit && !isStale(hit.url)) return hit;
  const message = await scopedMessage(ctx, args.message_id);
  const attachments = (message.attachments ?? []).map(attachment => ({
    id: attachment.id, name: attachment.filename, content_type: attachment.content_type,
    size: attachment.size, url: attachment.url,
  }));
  const attachment = pickAttachment(attachments, args);
  if (!attachment) throw new OpError("not_found", `message ${message.id} has no such attachment`);
  return attachment;
}

module.exports = {
  ops: {
    fetch_messages: { roles: ["project"], scoped: true, run: fetchMessages },
    read_last_x_messages_in_channel: { roles: ["project"], scoped: true, run: readLastMessages },
    export_message_range: { roles: ["project"], scoped: true, run: exportMessageRange },
    download_attachment: { roles: ["project"], scoped: true, run: downloadAttachment },
  },
};
