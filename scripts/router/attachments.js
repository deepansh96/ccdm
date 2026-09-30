"use strict";

// Attachment metadata from delivered message events, so `download_attachment`
// can hand back a still-valid signed CDN URL without asking Discord again.
const CACHE_LIMIT = 500;
// A URL this close to its expiry is refreshed rather than handed out.
const STALE_MARGIN_MS = 5 * 60 * 1000;

function createAttachmentCache(limit = CACHE_LIMIT) {
  // message_id -> { channel_id, attachments }, oldest first.
  const entries = new Map();
  return {
    remember(event) {
      if (event.event !== "message" || event.attachments.length === 0) return;
      entries.delete(event.message_id);
      entries.set(event.message_id, { channel_id: event.channel_id, attachments: event.attachments });
      if (entries.size > limit) entries.delete(entries.keys().next().value);
    },
    get(channelId, messageId) {
      const entry = entries.get(messageId);
      return entry?.channel_id === channelId ? entry.attachments : null;
    },
  };
}

// Signed URLs carry their expiry as hex Unix seconds in `ex`; without one the
// URL can't be trusted to work.
function isStale(url, now = Date.now()) {
  let expiry;
  try {
    expiry = Number.parseInt(new URL(url).searchParams.get("ex"), 16) * 1000;
  } catch {
    return true;
  }
  return !Number.isFinite(expiry) || expiry - now < STALE_MARGIN_MS;
}

module.exports = { createAttachmentCache, isStale };
