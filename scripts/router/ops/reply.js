"use strict";

// reply: post text in the session's channel under its Project Identity.
const { discordRequest } = require("../discord-rest.js");
const { avatarUrl, webhookUsername } = require("../identity.js");
const { readWebhookSecret } = require("../webhooks.js");
const { OpError } = require("./errors.js");

async function reply(ctx, args) {
  if (typeof args.text !== "string" || args.text.length === 0) throw new OpError("invalid_args", "text is required");
  const { route } = ctx.session;
  const secret = await readWebhookSecret(ctx.stateDir, route.project);
  if (!secret) throw new OpError("webhook_missing", `no webhook for ${route.project}; run ensure-webhook`);
  const message = await discordRequest("POST", `/webhooks/${secret.webhook_id}/${secret.token}`, {
    query: { wait: "true" },
    body: {
      content: args.text,
      username: webhookUsername(route.project, route.type, args.context_pct),
      avatar_url: avatarUrl(route.type),
      allowed_mentions: { parse: [] },
    },
  });
  return { message_id: message.id };
}

module.exports = {
  ops: {
    reply: { roles: ["project"], scoped: true, run: reply },
  },
};
