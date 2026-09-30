"use strict";

// Splits text into Discord-sized messages the way the Codex bridge always has:
// at the last newline before the limit when it falls past 30% of it,
// otherwise at exactly the limit.
const MESSAGE_LIMIT = 2000;

function splitMessage(text, limit = MESSAGE_LIMIT) {
  if (text.length <= limit) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining);
      break;
    }
    let splitAt = remaining.lastIndexOf("\n", limit);
    if (splitAt < limit * 0.3) splitAt = limit;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }
  return chunks;
}

module.exports = { MESSAGE_LIMIT, splitMessage };
