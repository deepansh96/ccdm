"use strict";

// Discord posting, linking, and reaction marks for Agent Message records.
// Uses the Router's REST queue (respecting rate limits and waits) and project
// webhook manager, with empty `allowed_mentions` on every write.
const { discordRequest } = require("../discord-rest.js");
const { avatarUrl, webhookUsername } = require("../identity.js");
const { threadQuery } = require("../ops/reply.js");
const { withProjectWebhook } = require("../webhooks.js");
const { formatRecordChunks, withCounterpartLink } = require("./record-format.js");

const ALLOWED_MENTIONS = Object.freeze({ parse: [] });

async function postWebhookRecord(context, { route, header, text, contextPct, reserveHeaderChars = 0 }) {
  const chunks = formatRecordChunks(header, text, { reserveHeaderChars });
  const username = webhookUsername(route.project, route.type, contextPct);
  const webhookCtx = { ...context, session: { route } };
  return withProjectWebhook(webhookCtx, async secret => {
    const ids = [];
    try {
      for (const chunk of chunks) {
        const message = await discordRequest("POST", `/webhooks/${secret.webhook_id}/${secret.token}`, {
          query: { wait: "true", ...threadQuery(route) },
          body: {
            content: chunk,
            username,
            avatar_url: avatarUrl(route.type),
            allowed_mentions: ALLOWED_MENTIONS,
          },
        });
        ids.push(message.id);
      }
      return {
        secret,
        channel_id: route.channel_id,
        message_id: ids[0],
        message_ids: ids,
        firstChunk: chunks[0],
      };
    } catch (error) {
      if (ids.length > 0) error.firstMessageId = ids[0];
      throw error;
    }
  });
}

async function postBotRecord(context, { channelId, header, text }) {
  const chunks = formatRecordChunks(header, text);
  const ids = [];
  for (const chunk of chunks) {
    const message = await discordRequest("POST", `/channels/${channelId}/messages`, {
      token: context.token,
      body: { content: chunk, allowed_mentions: ALLOWED_MENTIONS },
    });
    ids.push(message.id);
  }
  return { channel_id: channelId, message_id: ids[0], message_ids: ids };
}

async function editWebhookRecord({ route, secret, messageId, firstChunk, updatedHeader }) {
  await discordRequest("PATCH", `/webhooks/${secret.webhook_id}/${secret.token}/messages/${messageId}`, {
    query: threadQuery(route),
    body: {
      content: withCounterpartLink(firstChunk, updatedHeader),
      allowed_mentions: ALLOWED_MENTIONS,
    },
  });
}

async function reactMark(context, { channelId, messageId, emoji }) {
  await discordRequest(
    "PUT",
    `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`,
    { token: context.token },
  );
}

module.exports = { editWebhookRecord, postBotRecord, postWebhookRecord, reactMark };
