"use strict";

// Shared format for visible Agent Message records in Discord.
// Builds and recognises the header line (`-# ⇄ Agent ...`), formats channel
// labels, and chunks record messages within Discord's 2000-character limit.
const { MESSAGE_LIMIT } = require("../chunks.js");

const RECORD_PREFIX = "-# ⇄ Agent ";
// Room reserved on a sender-side first chunk for the counterpart message ID
// added by the link edit once the receiver-side record exists.
const MESSAGE_ID_RESERVE = 40;
const RECORD_HEADER_RE = /^-# ⇄ Agent (Request|Reply) (?:to|from) \*\*.*\*\* · ([^\s·]+)(?: · (?:\[counterpart\]\([^)]+\)|not delivered: [^\s]+))?$/s;

function isAgentMessageRecord(text) {
  return typeof text === "string" && text.trimStart().startsWith(RECORD_PREFIX);
}

// Wider guard for agent-written text (`reply` and `edit_message`): catches
// Discord subtext look-alikes (`-#` + 1-3 non-letter/non-digit symbols +
// `Agent`, any case and spacing) without changing exact record classification.
const RECORD_LOOKALIKE_RE = /^-#[^\S\r\n]+(?:[^\p{L}\p{N}\s]{1,3}[^\S\r\n]+|\p{S}[\p{S}\ufe0e\ufe0f]{0,2})agent\b/iu;

function looksLikeAgentMessageRecord(text) {
  if (isAgentMessageRecord(text)) return true;
  return typeof text === "string" && RECORD_LOOKALIKE_RE.test(text.trimStart());
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

function formatContinuationHeader(kindWord, requestId, part, total) {
  return requestId
    ? `${RECORD_PREFIX}${kindWord} · ${requestId} · part ${part}/${total}`
    : `${RECORD_PREFIX}${kindWord} · part ${part}/${total}`;
}

function continuationMeta(header, options) {
  const match = RECORD_HEADER_RE.exec(header);
  const kindWord = options.kind
    ? (options.kind === "reply" ? "Reply" : "Request")
    : (match ? match[1] : (header.startsWith(`${RECORD_PREFIX}Reply `) ? "Reply" : "Request"));
  const requestId = options.requestId ?? (match ? match[2] : null);
  return { kindWord, requestId };
}

function sliceChunk(remaining, limit) {
  if (remaining.length <= limit) return remaining.length;
  const splitAt = remaining.lastIndexOf("\n", limit);
  return splitAt < limit * 0.3 ? limit : splitAt;
}

function formatRecordChunks(header, text, options = {}) {
  const reserve = Math.max(0, options.reserveHeaderChars ?? 0);
  const full = `${header}\n${text}`;
  if (full.length + reserve <= MESSAGE_LIMIT) return [full];

  const { kindWord, requestId } = continuationMeta(header, options);
  const firstBodyLimit = Math.max(1, MESSAGE_LIMIT - header.length - 1 - reserve);

  let assumedTotal = 2;
  let parts = [];
  for (let pass = 0; pass < 6; pass++) {
    parts = [];
    let remaining = text;
    while (remaining.length > 0) {
      const index = parts.length;
      const limit = index === 0
        ? firstBodyLimit
        : Math.max(1, MESSAGE_LIMIT - formatContinuationHeader(kindWord, requestId, index + 1, assumedTotal).length - 1);
      const splitAt = sliceChunk(remaining, limit);
      parts.push(remaining.slice(0, splitAt));
      remaining = remaining.slice(splitAt);
    }
    if (parts.length === assumedTotal) break;
    assumedTotal = parts.length;
  }

  const total = parts.length;
  return parts.map((body, index) => (index === 0
    ? `${header}\n${body}`
    : `${formatContinuationHeader(kindWord, requestId, index + 1, total)}\n${body}`));
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
  looksLikeAgentMessageRecord,
  messageLink,
  withCounterpartLink,
};
