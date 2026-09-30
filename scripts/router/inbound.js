"use strict";

// Inbound classification: which Discord events reach a project session or
// root, and as what. Returns null for anything the Router ignores. A result
// with `root: true` is for root's session, never the project's.
const COMMANDS = new Set(["/pause", "/unpause", "/compact", "/clear", "/restart"]);
const CLOSE_COMMAND = "/close";

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
  // 5. `/close` is for the reminder service alone, which sees it through the observer.
  if (content.trim() === CLOSE_COMMAND) return null;
  // 6. Plain management commands pass through to the session adapter.
  if (COMMANDS.has(content.trim())) {
    return { route, event: { event: "command", command: content.trim().slice(1), ...base } };
  }
  // 7. Everything else is a message.
  return { route, event: messageEvent(route, author, message) };
}

// The reminder observer's copy of every message in a router project channel,
// bots and webhooks included: it tells owner activity and closure from agent
// replies itself, by author and `webhook_id`.
function observedMessage(table, message) {
  const route = table.channels.get(String(message.channelId ?? message.channel?.id));
  if (!route) return null;
  return {
    event: "message",
    project: route.project,
    message_id: message.id,
    channel_id: route.channel_id,
    author: { id: String(message.author?.id ?? ""), bot: Boolean(message.author?.bot) },
    webhook_id: message.webhookId ? String(message.webhookId) : null,
    content: String(message.content || ""),
    attachment_count: message.attachments?.size ?? 0,
    ts: new Date(message.createdTimestamp).toISOString(),
  };
}

// A reaction in a root channel is root's, under root's allowlist, and never a
// project's; one in a project channel is that project's, under its guests.
// `botId` is the root bot's user id, for telling root's own messages apart.
async function classifyReaction(table, reaction, user, botId = null) {
  if (user.partial) await user.fetch();
  if (user.bot) return null;
  const channelId = String(reaction.message.channelId ?? reaction.message.channel?.id);
  const root = table.rootChannels.has(channelId);
  const route = root ? { project: "root", channel_id: channelId } : table.channels.get(channelId);
  if (!route) return null;
  const author = allowedAuthor(root ? table.rootAllowedUserIds : new Set(route.guests), table, user);
  if (!author) return null;
  // An uncached message arrives partial, without its author, webhook, or content.
  if (reaction.message.partial) await reaction.message.fetch();
  const webhookId = reaction.message.webhookId ? String(reaction.message.webhookId) : null;
  const authorId = reaction.message.author?.id ? String(reaction.message.author.id) : null;
  return {
    route,
    ...(root ? { root: true } : {}),
    event: {
      event: "reaction",
      message_id: reaction.message.id,
      channel_id: route.channel_id,
      emoji: reaction.emoji.name,
      // Which webhook posted the message, if any, so a session can tell its
      // own Project Identity's messages apart.
      message_webhook_id: webhookId,
      // Whether the root bot itself posted it (not through a webhook), so root
      // can tell its own replies apart.
      message_author_id: authorId,
      message_from_bot: Boolean(botId) && !webhookId && authorId === String(botId),
      message_content: String(reaction.message.content || ""),
      user: author,
      ts: new Date().toISOString(),
    },
  };
}

module.exports = { classifyMessage, classifyReaction, observedMessage };
