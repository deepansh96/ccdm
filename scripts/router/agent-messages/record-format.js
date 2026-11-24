"use strict";

// Shared format for visible Agent Message records in Discord.
// Builds and recognises the header line (`-# ⇄ Agent ...`), formats channel
// labels, and chunks record messages within Discord's 2000-character limit.
const { MESSAGE_LIMIT, splitMessage } = require("../chunks.js");

const RECORD_PREFIX = "-# ⇄ Agent ";
// Room reserved on a sender-side first chunk for the counterpart message ID
// added by the link edit once the receiver-side record exists.
const MESSAGE_ID_RESERVE = 40;

function isAgentMessageRecord(text) {
  return typeof text === "string" && text.startsWith(RECORD_PREFIX);
}

function formatConversationLabel(conversation) {
  const base = `${conversation.project}-${conversation.provider}`;
  if (!conversation.thread_id) return base;
  return `${base} › ${conversation.thread_name || conversation.thread_id}`;
}

function messageLink(guildId, channelId, messageId) {
  return `https://discord.com/channels/${guildId ?? "@me"}/${channelId}/${messageId}`;
}

function formatRecordHeader({ kind, direction, label, requestId, counterpartUrl, notDeliveredCode }) {
  const kindWord = kind === "reply" ? "Reply" : "Request";
  const base = `${RECORD_PREFIX}${kindWord} ${direction} **${label}** · ${requestId}`;
  if (counterpartUrl) return `${base} · [counterpart](${counterpartUrl})`;
  if (notDeliveredCode) return `${base} · not delivered: ${notDeliveredCode}`;
  return base;
}

function linkSuffixReserve(guildId, channelId) {
  return ` · [counterpart](${messageLink(guildId, channelId, "")})`.length + MESSAGE_ID_RESERVE;
}

function formatRecordChunks(header, text, { reserveHeaderChars = 0 } = {}) {
  const full = `${header}\n${text}`;
  if (full.length + reserveHeaderChars <= MESSAGE_LIMIT) return [full];
  if (reserveHeaderChars <= 0) return splitMessage(full, MESSAGE_LIMIT);
  const firstLimit = Math.max(header.length + 1, MESSAGE_LIMIT - reserveHeaderChars);
  if (full.length <= firstLimit) return [full];
  let splitAt = full.lastIndexOf("\n", firstLimit);
  if (splitAt < firstLimit * 0.3 || splitAt <= header.length) splitAt = firstLimit;
  return [full.slice(0, splitAt), ...splitMessage(full.slice(splitAt), MESSAGE_LIMIT)];
}

function withCounterpartLink(firstChunk, updatedHeader) {
  const newline = firstChunk.indexOf("\n");
  return newline < 0 ? updatedHeader : `${updatedHeader}${firstChunk.slice(newline)}`;
}

module.exports = {
  RECORD_PREFIX,
  formatConversationLabel,
  formatRecordChunks,
  formatRecordHeader,
  isAgentMessageRecord,
  linkSuffixReserve,
  messageLink,
  withCounterpartLink,
};
