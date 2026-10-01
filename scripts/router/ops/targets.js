"use strict";

// Message targets: a message_id is in scope only if Discord finds it in the
// session's own channel. A thread's starter message shares the thread's id
// but lives in the parent channel, so it is never in the thread's scope.
const { DiscordError, discordRequest } = require("../discord-rest.js");
const { OpError, ScopeViolation } = require("./errors.js");

async function scopedMessage(ctx, messageId) {
  if (typeof messageId !== "string" || !/^[\w-]+$/.test(messageId)) {
    throw new OpError("invalid_args", "message_id is required");
  }
  if (messageId === ctx.session.route.thread_id) {
    throw new ScopeViolation(messageId, "a thread's starter message is in its parent channel");
  }
  try {
    return await discordRequest("GET", `/channels/${ctx.session.route.channel_id}/messages/${messageId}`, { token: ctx.token });
  } catch (error) {
    if (error instanceof DiscordError && (error.status === 404 || error.status === 403)) {
      throw new ScopeViolation(messageId, "message_id is not in this session's channel");
    }
    throw error;
  }
}

module.exports = { scopedMessage };
