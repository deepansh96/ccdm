"use strict";

// Message targets: a message_id is in scope only if Discord finds it in the
// session's own channel.
const { DiscordError, discordRequest } = require("../discord-rest.js");
const { OpError, ScopeViolation } = require("./errors.js");

async function scopedMessage(ctx, messageId) {
  if (typeof messageId !== "string" || !/^[\w-]+$/.test(messageId)) {
    throw new OpError("invalid_args", "message_id is required");
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
