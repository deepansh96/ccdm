"use strict";

// Write actions in the session's channel beyond replies: edits of the
// project's own webhook messages (root: the bot's own messages), the bot's
// reactions, and typing.
const { MESSAGE_LIMIT } = require("../chunks.js");
const { currentDeadline, discordRequest, withDeadline } = require("../discord-rest.js");
const { projectWebhookSecret } = require("../webhooks.js");
const { OpError, ScopeViolation } = require("./errors.js");
const { threadQuery } = require("./reply.js");
const { scopedMessage } = require("./targets.js");

// webhook message -> { latest, sending, next }. While an edit to a message is
// queued or in flight, newer edits replace the one waiting behind it, so only
// the latest content is sent next; every caller gets that send's result.
// `latest` is the arrival order of the newest edit sent or queued, so an older
// edit that finishes its lookups late never overwrites newer content. A
// coalesced send lasts as long as its latest waiting client's deadline.
const edits = new Map();
// Idle entries kept to recognise late older edits; pruned past this many.
const IDLE_EDITS = 1000;
let editArrivals = 0;

function coalescedEdit(key, arrival, text, send) {
  return new Promise((resolve, reject) => {
    const waiter = { resolve, reject, deadline: currentDeadline() };
    let entry = edits.get(key);
    if (!entry) edits.set(key, entry = { latest: 0, sending: null, next: null });
    if (arrival < entry.latest) {
      const newer = entry.next ?? entry.sending;
      if (newer) newer.waiters.push(waiter);
      else if (entry.error) reject(entry.error);
      else resolve(entry.result);
      return;
    }
    entry.latest = arrival;
    if (entry.next) {
      entry.next.text = text;
      entry.next.waiters.push(waiter);
      return;
    }
    entry.next = { text, waiters: [waiter] };
    if (!entry.sending) drainEdits(entry, send);
  });
}

async function drainEdits(entry, send) {
  while (entry.next) {
    entry.sending = entry.next;
    entry.next = null;
    try {
      const deadlines = entry.sending.waiters.map(waiter => waiter.deadline);
      const deadline = deadlines.includes(null) ? null : Math.max(...deadlines);
      entry.result = await withDeadline(deadline, () => send(entry.sending.text));
      entry.error = null;
      for (const waiter of entry.sending.waiters) waiter.resolve(entry.result);
    } catch (error) {
      entry.error = error;
      for (const waiter of entry.sending.waiters) waiter.reject(error);
    }
  }
  entry.sending = null;
  if (edits.size > IDLE_EDITS) {
    for (const [key, idle] of edits) if (!idle.sending && !idle.next) edits.delete(key);
  }
}

// Discord's webhook message edit cannot change the username, so `context_pct`
// has nothing to refresh there: only the content changes.
async function editMessage(ctx, args) {
  const arrival = ++editArrivals;
  if (typeof args.text !== "string" || args.text.length === 0 || args.text.length > MESSAGE_LIMIT) {
    throw new OpError("invalid_args", `text must be 1-${MESSAGE_LIMIT} characters`);
  }
  if (ctx.session.role === "root") return editBotMessage(ctx, args, arrival);
  const { route } = ctx.session;
  const secret = await projectWebhookSecret({
    project: route.project, registryFile: ctx.registryFile, stateDir: ctx.stateDir, token: ctx.token,
  });
  if (!secret) throw new OpError("webhook_missing", `no webhook for ${route.project}; run ensure-webhook`);
  const message = await scopedMessage(ctx, args.message_id);
  if (message.webhook_id !== secret.webhook_id) {
    throw new ScopeViolation(args.message_id, "only this project's own webhook messages can be edited");
  }
  return coalescedEdit(`${secret.webhook_id}/${message.id}`, arrival, args.text, async text => {
    const edited = await discordRequest("PATCH", `/webhooks/${secret.webhook_id}/${secret.token}/messages/${message.id}`, {
      query: threadQuery(route), body: { content: text, allowed_mentions: { parse: [] } },
    });
    return { message_id: edited.id };
  });
}

async function editBotMessage(ctx, args, arrival) {
  const message = await scopedMessage(ctx, args.message_id);
  if (message.webhook_id || !ctx.bot.id || message.author?.id !== ctx.bot.id) {
    throw new ScopeViolation(args.message_id, "only the bot's own messages can be edited");
  }
  const { channel_id: channelId } = ctx.session.route;
  return coalescedEdit(`bot/${message.id}`, arrival, args.text, async text => {
    const edited = await discordRequest("PATCH", `/channels/${channelId}/messages/${message.id}`, {
      token: ctx.token, body: { content: text, allowed_mentions: { parse: [] } },
    });
    return { message_id: edited.id };
  });
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
    edit_message: { roles: ["project", "root", "thread"], scoped: true, run: editMessage },
    react: { roles: ["project", "root", "thread"], scoped: true, run: react },
    typing: { roles: ["project", "root", "thread"], scoped: true, run: typing },
  },
};
