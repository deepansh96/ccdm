"use strict";

// Inbound classification: which Discord events reach a project session or
// root, and as what. Returns null for anything the Router ignores. A result
// with `root: true` is for root's session, never the project's.
const COMMANDS = new Set(["/pause", "/unpause", "/compact", "/clear", "/restart"]);
const CLOSE_COMMAND = "/close";
// In a thread, only these reach the thread session as commands; the
// supervisor's commands never reach it.
const THREAD_COMMANDS = new Set(["/pause", "/unpause", "/compact"]);
const SUPERVISOR_COMMAND = /^\/(?:close|restart|clear|config|model)(?:\s|$)/;
// In a project channel, these are the supervisor's and never reach the session.
const CHANNEL_COMMAND = /^\/(?:thread|config|model)(?:\s|$)/;
// In a root channel, root's own session answers `/model` from its launch settings.
const ROOT_COMMAND = /^\/model(?:\s|$)/;
const PUBLIC_THREAD = 11;
const FORUM_TYPES = new Set([15, 16]);

// The thread route of a public thread under a registered, non-`remote:`
// project channel, or null for any other channel, thread or not. Type and
// parent come from the payload or cache, else from a channel fetch.
async function threadRoute(table, channelId, channel, client) {
  if (table.channels.has(channelId) || table.rootChannels.has(channelId)) return null;
  const thread = channel ?? await client?.channels.fetch(channelId).catch(() => null);
  if (thread?.type !== PUBLIC_THREAD || FORUM_TYPES.has(thread.parent?.type)) return null;
  const parent = table.channels.get(String(thread.parentId));
  if (!parent || parent.remote) return null;
  return {
    project: parent.project, channel_id: channelId, thread_id: channelId, parent_channel_id: parent.channel_id,
    webhook_id: parent.webhook_id, guests: parent.guests,
  };
}

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

// `thread` is the message's thread route from `threadRoute`, if any; a result
// with `thread: true` is for that thread's session.
function classifyMessage(table, message, thread = null) {
  // 1. Bots and webhooks, including our own Project Identities, never reach a session.
  if (message.author?.bot || message.webhookId) return null;
  const channelId = String(message.channelId ?? message.channel?.id);
  const user = { ...message.author, globalName: message.member?.displayName || message.author.globalName };
  if (thread) return classifyThreadMessage(table, message, thread, user);
  // 2. In a root channel, only the owner and root's allowed users reach root.
  if (table.rootChannels.has(channelId)) {
    const author = allowedAuthor(table.rootAllowedUserIds, table, user);
    const route = { project: "root", channel_id: channelId };
    if (!author) return null;
    if (ROOT_COMMAND.test(String(message.content || "").trim())) {
      return { route, root: true, event: { event: "command", command: "model", message_id: message.id,
        channel_id: channelId, author, ts: new Date(message.createdTimestamp).toISOString() } };
    }
    return { route, root: true, event: messageEvent(route, author, message) };
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
  // 5. `/thread`, `/config` and `/model` are the Thread Supervisor's (`supervisor: true`).
  if (CHANNEL_COMMAND.test(content.trim())) {
    return { route, supervisor: true, event: supervisorCommand("channel_command", route, author, message) };
  }
  // 6. `/close` is for the reminder service alone, which sees it through the observer.
  if (content.trim() === CLOSE_COMMAND) return null;
  // 7. Plain management commands pass through to the session adapter.
  if (COMMANDS.has(content.trim())) {
    return { route, event: { event: "command", command: content.trim().slice(1), ...base } };
  }
  // 8. Everything else is a message.
  return { route, event: messageEvent(route, author, message) };
}

// A command for the supervisor, `/config model=x` as `config` and its arguments.
function supervisorCommand(event, route, author, message) {
  const [, command, args = ""] = /^\/(\S+)\s*(.*)$/s.exec(String(message.content || "").trim());
  return {
    event, command, args, project: route.project, message_id: message.id, channel_id: route.channel_id,
    ...(route.thread_id ? { thread_id: route.thread_id, parent_channel_id: route.parent_channel_id } : {}),
    author, ts: new Date(message.createdTimestamp).toISOString(),
  };
}

const threadCommand = (route, author, message) => supervisorCommand("thread_command", route, author, message);

// In a thread, the owner and the parent's current guests reach the thread
// session; the supervisor's commands (`supervisor: true`) reach no session. Addressing the bot is
// for root, in the thread, and only from the owner.
function classifyThreadMessage(table, message, route, user) {
  const author = allowedAuthor(new Set(route.guests), table, user);
  if (!author) return null;
  if (addressesRoot(message)) {
    return author.is_owner ? { route, root: true, event: messageEvent(route, author, message) } : null;
  }
  const content = String(message.content || "").trim();
  if (SUPERVISOR_COMMAND.test(content)) return { route, supervisor: true, event: threadCommand(route, author, message) };
  // With no live session, the supervisor answers these as `fallback`.
  if (THREAD_COMMANDS.has(content)) {
    return { route, thread: true, fallback: threadCommand(route, author, message), event: { event: "command",
      command: content.slice(1), message_id: message.id, channel_id: route.channel_id, author,
      ts: new Date(message.createdTimestamp).toISOString() } };
  }
  return { route, thread: true, event: messageEvent(route, author, message) };
}

// Who wrote a thread message, for the supervisor: the owner, a current guest
// of the parent, the root bot itself, the project's own webhook, or anyone else.
function authorClass(table, message, route) {
  const id = String(message.author?.id ?? "");
  if (message.webhookId) return String(message.webhookId) === route.webhook_id ? "project_webhook" : "other";
  if (message.author?.bot) return id === String(message.client?.user?.id) ? "root_bot" : "other";
  if (id === table.ownerId) return "owner";
  return route.guests.includes(id) ? "guest" : "other";
}

// The supervisor's copy of every message in an eligible thread, bots,
// webhooks and strangers included, saying whether its thread session got it
// and whether it addresses root (a bot mention or a native reply to root),
// which never boots or feeds a thread session.
function supervisedMessage(table, message, thread, deliveredToSession) {
  const user = { ...message.author, globalName: message.member?.displayName || message.author?.globalName };
  const author = { id: String(user.id ?? ""), name: user.globalName || user.username || String(user.id ?? ""),
    bot: Boolean(user.bot) };
  return {
    ...messageEvent(thread, author, message),
    event: "thread_message",
    project: thread.project,
    thread_id: thread.thread_id,
    parent_channel_id: thread.parent_channel_id,
    webhook_id: message.webhookId ? String(message.webhookId) : null,
    author_class: authorClass(table, message, thread),
    delivered_to_session: deliveredToSession,
    to_root: !message.author?.bot && !message.webhookId && addressesRoot(message),
  };
}

// The reminder observer's copy of every message in a router project channel,
// bots and webhooks included: it tells owner activity and closure from agent
// replies itself, by author and `webhook_id`.
// A thread message's copy also names its thread; each copy names its
// conversation, the channel or the thread.
function observedMessage(table, message, thread = null) {
  const route = thread ?? table.channels.get(String(message.channelId ?? message.channel?.id));
  if (!route) return null;
  return {
    event: "message",
    project: route.project,
    message_id: message.id,
    channel_id: route.channel_id,
    conversation_id: route.channel_id,
    ...(thread ? { thread_id: thread.thread_id } : {}),
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
// One in a thread (`thread`, its thread route) is that thread session's.
async function classifyReaction(table, reaction, user, botId = null, thread = null) {
  if (user.partial) await user.fetch();
  if (user.bot) return null;
  const channelId = String(reaction.message.channelId ?? reaction.message.channel?.id);
  const root = !thread && table.rootChannels.has(channelId);
  const route = thread ?? (root ? { project: "root", channel_id: channelId } : table.channels.get(channelId));
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
    ...(thread ? { thread: true } : {}),
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

module.exports = { classifyMessage, classifyReaction, observedMessage, supervisedMessage, threadRoute };
