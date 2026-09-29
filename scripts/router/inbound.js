"use strict";

// Inbound classification: which Discord events reach a project session or
// root, and as what. Returns null for anything the Router ignores. A result
// with `root: true` is for root's session, never the project's.
const COMMANDS = new Set(["/pause", "/unpause", "/compact", "/clear", "/restart"]);

function allowedAuthor(allowed, table, user) {
  const id = String(user.id);
  const isOwner = id === table.ownerId;
  if (!isOwner && !allowed.has(id)) return null;
  return { id, name: user.globalName || user.username || id, is_owner: isOwner };
}

// A bot mention, or a native reply to a message the root bot itself sent
// (a reply to a webhook message has the webhook as its replied user).
function addressesRoot(message) {
  const botId = message.client?.user?.id;
  if (!botId) return false;
  if (new RegExp(`<@!?${botId}>`).test(String(message.content || ""))) return true;
  return Boolean(message.reference?.messageId) && message.mentions?.repliedUser?.id === botId;
}

function messageEvent(route, author, message) {
  return {
    event: "message",
    message_id: message.id,
    channel_id: route.channel_id,
    author,
    content: String(message.content || ""),
    attachments: [...message.attachments.values()].map(attachment => ({
      id: attachment.id,
      name: attachment.name,
      content_type: attachment.contentType,
      size: attachment.size,
      url: attachment.url,
    })),
    ...(message.reference?.messageId ? { reply_to: message.reference.messageId } : {}),
    ts: new Date(message.createdTimestamp).toISOString(),
  };
}

function classifyMessage(table, message) {
  // 1. Bots and webhooks, including our own Project Identities, never reach a session.
  if (message.author?.bot || message.webhookId) return null;
  const channelId = String(message.channelId ?? message.channel?.id);
  const user = { ...message.author, globalName: message.member?.displayName || message.author.globalName };
  // 2. In a root channel, only the owner and root's allowed users reach root.
  if (table.rootChannels.has(channelId)) {
    const author = allowedAuthor(table.rootAllowedUserIds, table, user);
    const route = { project: "root", channel_id: channelId };
    return author ? { route, root: true, event: messageEvent(route, author, message) } : null;
  }
  const route = table.channels.get(channelId);
  if (!route) return null;
  // 3. Only the owner and that channel's guests.
  const author = allowedAuthor(new Set(route.guests), table, user);
  if (!author) return null;
  // 4. Addressing the bot is for root only; a guest doing it reaches no one.
  if (addressesRoot(message)) {
    return author.is_owner ? { route, root: true, event: messageEvent(route, author, message) } : null;
  }
  const base = {
    message_id: message.id,
    channel_id: route.channel_id,
    author,
    ts: new Date(message.createdTimestamp).toISOString(),
  };
  const content = String(message.content || "");
  // 5. Plain management commands pass through to the session adapter.
  if (COMMANDS.has(content.trim())) {
    return { route, event: { event: "command", command: content.trim().slice(1), ...base } };
  }
  // 6. Everything else is a message.
  return { route, event: messageEvent(route, author, message) };
}

async function classifyReaction(table, reaction, user) {
  if (user.partial) await user.fetch();
  if (user.bot) return null;
  const route = table.channels.get(String(reaction.message.channelId ?? reaction.message.channel?.id));
  if (!route) return null;
  const author = allowedAuthor(new Set(route.guests), table, user);
  if (!author) return null;
  // An uncached message arrives partial, without its webhook or content.
  if (reaction.message.partial) await reaction.message.fetch();
  return {
    route,
    event: {
      event: "reaction",
      message_id: reaction.message.id,
      channel_id: route.channel_id,
      emoji: reaction.emoji.name,
      // Which webhook posted the message, if any, so a session can tell its
      // own Project Identity's messages apart.
      message_webhook_id: reaction.message.webhookId ? String(reaction.message.webhookId) : null,
      message_content: String(reaction.message.content || ""),
      user: author,
      ts: new Date().toISOString(),
    },
  };
}

module.exports = { classifyMessage, classifyReaction };
