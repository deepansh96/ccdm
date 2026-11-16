"use strict";

// The Thread Supervisor's ops: it holds no Discord credential, so every
// Discord action it takes is one of these, sent with the root token through
// the shared REST queue. Each target must be a registered, non-`remote:`
// project channel or a public thread under one; anything else is
// `scope_violation`. The status board ops act only in the registry's
// `thread_status_channel_id`, and only on root's own messages there. Also
// `create_thread`, a channel session's request for a thread in its own
// channel, which the supervisor fulfils.
const crypto = require("node:crypto");
const { splitMessage } = require("../chunks.js");
const { DEFAULT_TIMEOUT_MS } = require("../deadlines.js");
const { DiscordError, currentDeadline, discordRequest } = require("../discord-rest.js");
const { threadRoute } = require("../inbound.js");
const { coalescedEdit, nextEditArrival } = require("./channel-actions.js");
const { OpError, ScopeViolation } = require("./errors.js");

const PUBLIC_THREAD = 11;
// A week, the longest Discord allows: threads outlive a weekend's quiet.
const THREAD_ARCHIVE_MINUTES = 10080;
const ARCHIVE_DURATIONS = new Set([60, 1440, 4320, 10080]);
const PAGE_LIMIT = 100;
// Archived pages read per parent channel, at most, in one `thread_list`.
const ARCHIVED_PAGES = 10;
// Discord answers for a parent channel that `thread_list` skips: gone, or unreadable.
const SKIPPABLE_CHANNEL = new Set([403, 404]);
const ARCHIVE_ACTION = 111;
const DISCORD_EPOCH = 1420070400000n;
const PROVIDERS = new Set(["claude", "codex"]);
// An owner ping is one short line naming the owner once, as `{owner}`.
const PING_LIMIT = 300;
const OWNER_PLACEHOLDER = "{owner}";
// Any other mention syntax a ping could carry.
const MENTION_SYNTAX = /<@|@everyone|@here/;
const STATUS_LIST_LIMIT = 50;
const MESSAGE_LIMIT = 2000;

const isId = id => typeof id === "string" && /^[\w-]+$/.test(id);

// The route of an eligible project channel, or null.
function projectChannel(ctx, channelId) {
  const route = isId(channelId) ? ctx.table.channels.get(channelId) : null;
  return route && !route.remote ? route : null;
}

const eligibleThread = (ctx, threadId) => isId(threadId)
  ? threadRoute(ctx.table, threadId, null, ctx.discord?.client) : null;

async function channelTarget(ctx, channelId) {
  const route = projectChannel(ctx, channelId);
  if (!route) throw new ScopeViolation(channelId, "channel_id is not a registered project channel");
  return route;
}

async function threadTarget(ctx, threadId) {
  const route = await eligibleThread(ctx, threadId);
  if (!route) throw new ScopeViolation(threadId, "thread_id is not a public thread in a registered project channel");
  return route;
}

// A project channel or one of its threads.
async function conversationTarget(ctx, channelId) {
  const route = projectChannel(ctx, channelId) ?? await eligibleThread(ctx, channelId);
  if (!route) throw new ScopeViolation(channelId, "channel_id is neither a project channel nor one of its threads");
  return route;
}

// As the supervisor's `thread_message` frames classify authors.
function authorClass(ctx, message, route) {
  const id = String(message.author?.id ?? "");
  if (message.webhook_id) return String(message.webhook_id) === route.webhook_id ? "project_webhook" : "other";
  if (message.author?.bot) return id === String(ctx.bot?.id) ? "root_bot" : "other";
  if (id === ctx.table.ownerId) return "owner";
  return (route.guests ?? []).includes(id) ? "guest" : "other";
}

const classified = (ctx, message, route) => ({ ...message, author_class: authorClass(ctx, message, route) });

function guildId(ctx) {
  if (!ctx.table.guildId) throw new OpError("guild_unknown", "the registry has no guild_id");
  return ctx.table.guildId;
}

async function threadCreate(ctx, args) {
  const route = await channelTarget(ctx, args.channel_id);
  if (typeof args.name !== "string" || !args.name || args.name.length > 100) {
    throw new OpError("invalid_args", "name must be 1-100 characters");
  }
  return discordRequest("POST", `/channels/${route.channel_id}/threads`, {
    token: ctx.token, body: { name: args.name, type: PUBLIC_THREAD, auto_archive_duration: THREAD_ARCHIVE_MINUTES },
  });
}

async function threadUpdate(ctx, args) {
  const route = await threadTarget(ctx, args.thread_id);
  const body = {};
  if (args.archived !== undefined) {
    if (typeof args.archived !== "boolean") throw new OpError("invalid_args", "archived must be a boolean");
    body.archived = args.archived;
  }
  if (args.auto_archive_duration !== undefined) {
    if (!ARCHIVE_DURATIONS.has(args.auto_archive_duration)) {
      throw new OpError("invalid_args", "auto_archive_duration must be 60, 1440, 4320 or 10080");
    }
    body.auto_archive_duration = args.auto_archive_duration;
  }
  if (Object.keys(body).length === 0) throw new OpError("invalid_args", "archived or auto_archive_duration is required");
  return discordRequest("PATCH", `/channels/${route.thread_id}`, { token: ctx.token, body });
}

const listed = (thread, route) => ({
  id: thread.id, project: route.project, parent_id: thread.parent_id, name: thread.name, owner_id: thread.owner_id ?? null,
  archived: Boolean(thread.thread_metadata?.archived),
  auto_archive_duration: thread.thread_metadata?.auto_archive_duration ?? null,
  archive_timestamp: thread.thread_metadata?.archive_timestamp ?? null,
});

// Active public threads under the eligible parents (or `channel_id` alone),
// plus their archived public threads, newest archive first, back to
// `archived_within_days` ago and at most ARCHIVED_PAGES pages per parent.
async function threadList(ctx, args) {
  const days = args.archived_within_days;
  if (days !== undefined && !(typeof days === "number" && days >= 0)) {
    throw new OpError("invalid_args", "archived_within_days must be a non-negative number");
  }
  const parents = args.channel_id === undefined
    ? [...ctx.table.channels.values()].filter(route => !route.remote)
    : [await channelTarget(ctx, args.channel_id)];
  const byChannel = new Map(parents.map(route => [route.channel_id, route]));
  const threads = [];
  const active = await discordRequest("GET", `/guilds/${guildId(ctx)}/threads/active`, { token: ctx.token });
  for (const thread of active.threads ?? []) {
    const route = byChannel.get(String(thread.parent_id));
    if (thread.type === PUBLIC_THREAD && route) threads.push(listed(thread, route));
  }
  const cutoff = days === undefined ? -Infinity : Date.now() - days * 24 * 60 * 60 * 1000;
  const skipped = [];
  for (const route of parents) {
    let before;
    for (let page = 0; page < ARCHIVED_PAGES; page++) {
      let result;
      try {
        result = await discordRequest("GET", `/channels/${route.channel_id}/threads/archived/public`, {
          token: ctx.token, query: { limit: PAGE_LIMIT, ...(before ? { before } : {}) },
        });
      } catch (error) {
        // A registered channel Discord no longer has (404), or root cannot
        // read (403), loses only its own archived threads, never the list.
        if (!(error instanceof DiscordError && SKIPPABLE_CHANNEL.has(error.status))) throw error;
        skipped.push({ project: route.project, channel_id: route.channel_id, status: error.status });
        logSkippedOnce(ctx, route, error);
        break;
      }
      const archived = (result.threads ?? []).map(thread => listed(thread, route));
      const recent = archived.filter(thread => Date.parse(thread.archive_timestamp) >= cutoff);
      threads.push(...recent);
      if (!result.has_more || archived.length === 0 || recent.length < archived.length) break;
      before = archived.at(-1).archive_timestamp;
    }
  }
  return { threads, skipped_channels: skipped };
}

// A skipped channel is logged once per registry load, not on every reconcile.
const skippedLogged = new WeakMap();
function logSkippedOnce(ctx, route, error) {
  const logged = skippedLogged.get(ctx.table) ?? new Set();
  skippedLogged.set(ctx.table, logged);
  if (logged.has(route.channel_id)) return;
  logged.add(route.channel_id);
  ctx.log?.(`thread_list_skipped project=${route.project} channel=${route.channel_id} status=${error.status} ` +
    `error=${error.message}`);
}

async function threadHistory(ctx, args) {
  const route = await threadTarget(ctx, args.thread_id);
  const limit = args.limit === undefined ? PAGE_LIMIT : args.limit;
  if (!Number.isInteger(limit) || limit < 1 || limit > PAGE_LIMIT) throw new OpError("invalid_args", "limit must be 1-100");
  if (args.before !== undefined && !isId(args.before)) throw new OpError("invalid_args", "before must be a message id");
  const messages = await discordRequest("GET", `/channels/${route.thread_id}/messages`, {
    token: ctx.token, query: { limit, ...(args.before ? { before: args.before } : {}) },
  });
  return { messages: messages.map(message => classified(ctx, message, route)) };
}

// A thread's starter message lives in the parent channel, under the thread's id.
async function threadMessageGet(ctx, args) {
  const route = await conversationTarget(ctx, args.channel_id);
  if (!isId(args.message_id)) throw new OpError("invalid_args", "message_id is required");
  try {
    const message = await discordRequest("GET", `/channels/${route.channel_id}/messages/${args.message_id}`, { token: ctx.token });
    return classified(ctx, message, route);
  } catch (error) {
    if (error instanceof DiscordError && error.status === 404) throw new OpError("not_found", `no message ${args.message_id}`);
    throw error;
  }
}

const snowflakeTime = id => Number((BigInt(id) >> 22n) + DISCORD_EPOCH);

// Who archived a thread: its thread-update audit-log entries since `since`
// (an ISO time or epoch ms), newest first, or `{forbidden: true}` without
// View Audit Log.
async function threadArchiveActor(ctx, args) {
  const route = await threadTarget(ctx, args.thread_id);
  const since = typeof args.since === "number" ? args.since : Date.parse(args.since);
  if (!Number.isFinite(since)) throw new OpError("invalid_args", "since must be an ISO time or epoch milliseconds");
  let log;
  try {
    log = await discordRequest("GET", `/guilds/${guildId(ctx)}/audit-logs`, {
      token: ctx.token, query: { action_type: ARCHIVE_ACTION, limit: PAGE_LIMIT },
    });
  } catch (error) {
    if (error instanceof DiscordError && error.status === 403) return { forbidden: true };
    throw error;
  }
  const entries = (log.audit_log_entries ?? []).filter(entry => String(entry.target_id) === route.thread_id &&
    Number(entry.action_type) === ARCHIVE_ACTION && /^\d+$/.test(String(entry.id)) && snowflakeTime(String(entry.id)) >= since)
    .map(({ id, user_id, target_id, action_type, changes }) => ({ id, user_id, target_id, action_type, changes: changes ?? [] }));
  return { entries };
}

async function threadReact(ctx, args) {
  const route = await conversationTarget(ctx, args.channel_id);
  if (!isId(args.message_id)) throw new OpError("invalid_args", "message_id is required");
  if (typeof args.emoji !== "string" || !args.emoji) throw new OpError("invalid_args", "emoji is required");
  await discordRequest(args.remove === true ? "DELETE" : "PUT",
    `/channels/${route.channel_id}/messages/${args.message_id}/reactions/${encodeURIComponent(args.emoji)}/@me`,
    { token: ctx.token });
  return { message_id: args.message_id, emoji: args.emoji, removed: args.remove === true };
}

// Notices post as the root bot, never through the project webhook, so the
// reminder service never counts them as agent replies. With `mention_owner`,
// a notice in a thread pings the owner, and only the owner: the Router puts
// the owner's id in place of `{owner}` and allows no other mention.
async function threadNotice(ctx, args) {
  if (args.mention_owner !== undefined && args.mention_owner !== true) {
    throw new OpError("invalid_args", "mention_owner must be true when given");
  }
  if (args.mention_owner) return ownerPing(ctx, args);
  const route = await conversationTarget(ctx, args.channel_id);
  if (typeof args.text !== "string" || !args.text) throw new OpError("invalid_args", "text is required");
  const ids = [];
  for (const chunk of splitMessage(args.text)) {
    const message = await discordRequest("POST", `/channels/${route.channel_id}/messages`, {
      token: ctx.token, body: { content: chunk, allowed_mentions: { parse: [] } },
    });
    ids.push(message.id);
  }
  return { message_id: ids[0], message_ids: ids };
}

async function ownerPing(ctx, args) {
  const route = await threadTarget(ctx, args.channel_id);
  const text = args.text;
  if (typeof text !== "string" || !text || text.length > PING_LIMIT) {
    throw new OpError("invalid_args", `text must be 1-${PING_LIMIT} characters`);
  }
  const parts = text.split(OWNER_PLACEHOLDER);
  if (parts.length !== 2) throw new OpError("invalid_args", `text must name ${OWNER_PLACEHOLDER} exactly once`);
  if (parts.some(part => MENTION_SYNTAX.test(part))) {
    throw new OpError("invalid_args", "text may mention no one but the owner");
  }
  const owner = ctx.table.ownerId;
  if (!owner) throw new OpError("owner_unknown", "the registry has no owner");
  const message = await discordRequest("POST", `/channels/${route.thread_id}/messages`, {
    token: ctx.token, body: { content: parts.join(`<@${owner}>`), allowed_mentions: { parse: [], users: [owner] } },
  });
  ctx.pings?.add(String(message.id));
  return { message_id: message.id, message_ids: [message.id] };
}

// The root bot's own message `messageId` in `channelId`, or null when it is gone.
async function ownBotMessage(ctx, channelId, messageId) {
  if (!isId(messageId)) throw new OpError("invalid_args", "message_id is required");
  let message;
  try {
    message = await discordRequest("GET", `/channels/${channelId}/messages/${messageId}`, { token: ctx.token });
  } catch (error) {
    if (error instanceof DiscordError && error.status === 404) return null;
    throw error;
  }
  if (String(message.channel_id ?? channelId) !== channelId || message.webhook_id || !ctx.bot?.id ||
      String(message.author?.id ?? "") !== String(ctx.bot.id)) {
    throw new ScopeViolation(messageId, "only the root bot's own messages there can be changed");
  }
  return message;
}

async function deleteMessage(ctx, channelId, messageId) {
  try {
    await discordRequest("DELETE", `/channels/${channelId}/messages/${messageId}`, { token: ctx.token });
    return true;
  } catch (error) {
    if (error instanceof DiscordError && error.status === 404) return false;
    throw error;
  }
}

// Deletes one of root's own messages in an eligible thread, such as an owner ping.
async function threadNoticeDelete(ctx, args) {
  const route = await threadTarget(ctx, args.channel_id);
  const message = await ownBotMessage(ctx, route.thread_id, args.message_id);
  ctx.pings?.delete(String(args.message_id));
  if (!message) return { deleted: false };
  return { deleted: await deleteMessage(ctx, route.thread_id, message.id) };
}

// The status board's channel: the registry's `thread_status_channel_id`,
// never an op argument.
function statusChannel(ctx) {
  if (ctx.table.statusChannelError) throw new OpError("status_channel_invalid", ctx.table.statusChannelError);
  if (!ctx.table.statusChannelId) throw new OpError("status_channel_unset", "thread_status_channel_id is not set");
  return ctx.table.statusChannelId;
}

function statusText(text) {
  if (typeof text !== "string" || !text || text.length > MESSAGE_LIMIT) {
    throw new OpError("invalid_args", `text must be 1-${MESSAGE_LIMIT} characters`);
  }
  return text;
}

// Root's own messages in the status channel, newest first, to find the board again.
async function statusBoardList(ctx, args) {
  const channelId = statusChannel(ctx);
  const limit = args.limit === undefined ? STATUS_LIST_LIMIT : args.limit;
  if (!Number.isInteger(limit) || limit < 1 || limit > STATUS_LIST_LIMIT) {
    throw new OpError("invalid_args", `limit must be 1-${STATUS_LIST_LIMIT}`);
  }
  const messages = await discordRequest("GET", `/channels/${channelId}/messages`, { token: ctx.token, query: { limit } });
  const own = message => !message.webhook_id && ctx.bot?.id && String(message.author?.id ?? "") === String(ctx.bot.id);
  return {
    channel_id: channelId,
    messages: (messages ?? []).filter(own)
      .map(({ id, content, timestamp }) => ({ id, content: content ?? "", timestamp: timestamp ?? null })),
  };
}

async function statusBoardPost(ctx, args) {
  const channelId = statusChannel(ctx);
  const message = await discordRequest("POST", `/channels/${channelId}/messages`, {
    token: ctx.token, body: { content: statusText(args.text), allowed_mentions: { parse: [] } },
  });
  return { channel_id: channelId, message_id: message.id };
}

// Edits coalesce per message, as a session's `edit_message` does.
async function statusBoardEdit(ctx, args) {
  const arrival = nextEditArrival();
  const channelId = statusChannel(ctx);
  const text = statusText(args.text);
  const message = await ownBotMessage(ctx, channelId, args.message_id);
  if (!message) throw new OpError("not_found", `no message ${args.message_id}`);
  return coalescedEdit(`status/${message.id}`, arrival, text, async latest => {
    try {
      const edited = await discordRequest("PATCH", `/channels/${channelId}/messages/${message.id}`, {
        token: ctx.token, body: { content: latest, allowed_mentions: { parse: [] } },
      });
      return { channel_id: channelId, message_id: edited.id };
    } catch (error) {
      if (error instanceof DiscordError && error.status === 404) throw new OpError("not_found", `no message ${message.id}`);
      throw error;
    }
  });
}

async function statusBoardDelete(ctx, args) {
  const channelId = statusChannel(ctx);
  const message = await ownBotMessage(ctx, channelId, args.message_id);
  return { deleted: message ? await deleteMessage(ctx, channelId, message.id) : false };
}

async function threadRevoke(ctx, args) {
  const route = await threadTarget(ctx, args.thread_id);
  if (typeof args.reason !== "string" || !args.reason) throw new OpError("invalid_args", "reason is required");
  return { revoked: ctx.revokeThread(route.thread_id, args.reason) };
}

function optionalString(args, field) {
  if (args[field] !== undefined && (typeof args[field] !== "string" || !args[field])) {
    throw new OpError("invalid_args", `${field} must be a non-empty string`);
  }
  return args[field] === undefined ? {} : { [field]: args[field] };
}

// A channel session asks the supervisor for a thread in its own channel and
// waits, within its deadline, for the supervisor's `thread_request_done`.
async function createThread(ctx, args) {
  if (typeof args.name !== "string" || !args.name || args.name.length > 100) {
    throw new OpError("invalid_args", "name must be 1-100 characters");
  }
  if (args.provider !== undefined && !PROVIDERS.has(args.provider)) {
    throw new OpError("invalid_args", "provider must be claude or codex");
  }
  const { project, channel_id: channelId } = ctx.session.route;
  const overrides = Object.assign({}, ...["provider", "account", "model", "effort", "first_message"]
    .map(field => optionalString(args, field)));
  const requestId = crypto.randomUUID();
  const deadline = currentDeadline() ?? Date.now() + DEFAULT_TIMEOUT_MS;
  return ctx.threadRequests.open(requestId, deadline, {
    event: "thread_create_request", request_id: requestId, project, channel_id: channelId, name: args.name,
    ...overrides, requester: { kind: "channel-agent", project },
  });
}

function threadRequestDone(ctx, args) {
  if (!isId(args.request_id)) throw new OpError("invalid_args", "request_id is required");
  if (typeof args.ok !== "boolean") throw new OpError("invalid_args", "ok must be a boolean");
  if (args.ok && args.thread_id !== undefined && !isId(args.thread_id)) {
    throw new OpError("invalid_args", "thread_id must be a thread id");
  }
  const error = typeof args.error === "string" ? { code: "thread_create_failed", message: args.error }
    : { code: String(args.error?.code || "thread_create_failed"), message: String(args.error?.message || "thread creation failed") };
  if (!ctx.threadRequests.done(args.request_id, args.ok ? { thread_id: args.thread_id ?? null } : null, error)) {
    throw new OpError("not_found", `no pending create_thread ${args.request_id}`);
  }
  return {};
}

const supervisorOp = run => ({ roles: ["supervisor"], scoped: false, run });

module.exports = {
  ops: {
    thread_create: supervisorOp(threadCreate),
    thread_update: supervisorOp(threadUpdate),
    thread_list: supervisorOp(threadList),
    thread_history: supervisorOp(threadHistory),
    thread_message_get: supervisorOp(threadMessageGet),
    thread_archive_actor: supervisorOp(threadArchiveActor),
    thread_react: supervisorOp(threadReact),
    thread_notice: supervisorOp(threadNotice),
    thread_notice_delete: supervisorOp(threadNoticeDelete),
    status_board_list: supervisorOp(statusBoardList),
    status_board_post: supervisorOp(statusBoardPost),
    status_board_edit: supervisorOp(statusBoardEdit),
    status_board_delete: supervisorOp(statusBoardDelete),
    thread_revoke: supervisorOp(threadRevoke),
    thread_request_done: supervisorOp(threadRequestDone),
    create_thread: { roles: ["project"], scoped: true, run: createThread },
  },
};
