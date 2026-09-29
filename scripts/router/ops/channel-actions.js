"use strict";

// Write actions in the session's channel beyond replies: edits of the
// project's own webhook messages, the bot's reactions, and typing.
const { MESSAGE_LIMIT } = require("../chunks.js");
const { discordRequest } = require("../discord-rest.js");
const { readWebhookSecret } = require("../webhooks.js");
const { OpError, ScopeViolation } = require("./errors.js");
const { scopedMessage } = require("./targets.js");

// Discord's webhook message edit cannot change the username, so `context_pct`
// has nothing to refresh there: only the content changes.
async function editMessage(ctx, args) {
  if (typeof args.text !== "string" || args.text.length === 0 || args.text.length > MESSAGE_LIMIT) {
    throw new OpError("invalid_args", `text must be 1-${MESSAGE_LIMIT} characters`);
  }
  const { route } = ctx.session;
  const secret = await readWebhookSecret(ctx.stateDir, route.project);
  if (!secret) throw new OpError("webhook_missing", `no webhook for ${route.project}; run ensure-webhook`);
  const message = await scopedMessage(ctx, args.message_id);
  if (message.webhook_id !== secret.webhook_id) {
    throw new ScopeViolation(args.message_id, "only this project's own webhook messages can be edited");
  }
  const edited = await discordRequest("PATCH", `/webhooks/${secret.webhook_id}/${secret.token}/messages/${message.id}`, {
    body: { content: args.text, allowed_mentions: { parse: [] } },
  });
  return { message_id: edited.id };
}

// Adds, or with `remove: true` removes, the bot's own reaction.
async function react(ctx, args) {
  if (typeof args.emoji !== "string" || args.emoji.length === 0) throw new OpError("invalid_args", "emoji is required");
  const message = await scopedMessage(ctx, args.message_id);
  await discordRequest(args.remove === true ? "DELETE" : "PUT",
    `/channels/${ctx.session.route.channel_id}/messages/${message.id}/reactions/${encodeURIComponent(args.emoji)}/@me`,
    { token: ctx.token });
  return { message_id: message.id, emoji: args.emoji, removed: args.remove === true };
}

async function typing(ctx) {
  await discordRequest("POST", `/channels/${ctx.session.route.channel_id}/typing`, { token: ctx.token });
  return {};
}

module.exports = {
  ops: {
    edit_message: { roles: ["project"], scoped: true, run: editMessage },
    react: { roles: ["project"], scoped: true, run: react },
    typing: { roles: ["project"], scoped: true, run: typing },
  },
};
