"use strict";

// Inbound classification: which Discord events reach a project session, and
// as what. Returns null for anything the Router ignores.
const COMMANDS = new Set(["/pause", "/unpause", "/compact", "/clear", "/restart"]);

function allowedAuthor(route, table, user) {
  const id = String(user.id);
  const isOwner = id === table.ownerId;
  if (!isOwner && !route.guests.includes(id)) return null;
  return { id, name: user.globalName || user.username || id, is_owner: isOwner };
}

function classifyMessage(table, message) {
  // 1. Bots and webhooks, including our own Project Identities, never reach a session.
  if (message.author?.bot || message.webhookId) return null;
  const route = table.channels.get(String(message.channelId ?? message.channel?.id));
  if (!route) return null;
  // 2. Only the owner and that channel's guests.
  const author = allowedAuthor(route, table, {
    ...message.author, globalName: message.member?.displayName || message.author.globalName,
  });
  if (!author) return null;
  const base = {
    message_id: message.id,
    channel_id: route.channel_id,
    author,
    ts: new Date(message.createdTimestamp).toISOString(),
  };
  const content = String(message.content || "");
  // 3. Plain management commands pass through to the session adapter.
  if (COMMANDS.has(content.trim())) {
    return { route, event: { event: "command", command: content.trim().slice(1), ...base } };
  }
  // 4. Everything else is a message.
  return {
    route,
    event: {
      event: "message",
      message_id: base.message_id,
      channel_id: base.channel_id,
      author,
      content,
      attachments: [...message.attachments.values()].map(attachment => ({
        id: attachment.id,
        name: attachment.name,
        content_type: attachment.contentType,
        size: attachment.size,
        url: attachment.url,
      })),
      ...(message.reference?.messageId ? { reply_to: message.reference.messageId } : {}),
      ts: base.ts,
    },
  };
}

async function classifyReaction(table, reaction, user) {
  if (user.partial) await user.fetch();
  if (user.bot) return null;
  const route = table.channels.get(String(reaction.message.channelId ?? reaction.message.channel?.id));
  if (!route) return null;
  const author = allowedAuthor(route, table, user);
  if (!author) return null;
  return {
    route,
    event: {
      event: "reaction",
      message_id: reaction.message.id,
      channel_id: route.channel_id,
      emoji: reaction.emoji.name,
      user: author,
      ts: new Date().toISOString(),
    },
  };
}

module.exports = { classifyMessage, classifyReaction };
