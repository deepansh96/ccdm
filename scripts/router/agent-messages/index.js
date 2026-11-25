"use strict";

// Agent Message module (ADR 0009): checks Agent Message Grants, routes Agent
// Requests and Agent Replies between capable sessions through the Router, posts
// visible linked records in both conversations, and appends every state change
// to the private ledger before it takes effect.
const crypto = require("node:crypto");
const { DiscordError, withDeadline } = require("../discord-rest.js");
const { OpError } = require("../ops/errors.js");
const { createAgentMessageLedger } = require("./ledger.js");
const {
  formatConversationLabel,
  formatRecordHeader,
  linkSuffixReserve,
  messageLink,
} = require("./record-format.js");
const { editWebhookRecord, postBotRecord, postWebhookRecord, reactMark } = require("./records.js");

const CAPABILITY = "agent_messages";
const DEFAULT_TIMEOUT_MINUTES = 30;
const MAX_TIMEOUT_MINUTES = 120;
const DEFAULT_MINUTE_MS = 60000;
const DEFAULT_RATE_WINDOW_MS = 3600000;
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const LEDGER_RETENTION_MINUTES = 30 * 24 * 60;
const RECENT_REFUSALS = 20;
const DEFAULT_LIMITS = Object.freeze({
  depth: 3,
  requests_per_hour: 20,
  open_requests: 5,
  max_characters: 4000,
});
const MARK_REPLIED = "✅";
const MARK_FAILED = "⚠️";
const PUBLIC_THREAD = 11;
const FORUM_TYPES = new Set([15, 16]);
const ARCHIVED_THREAD_CODE = 50083;
const DISCORD_LINK = /^https?:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/channels\/[^/\s]+\/([^/\s]+)(?:\/[^/\s]+)?\/?$/;

const isNonEmptyString = value => typeof value === "string" && value.trim().length > 0;
const isId = value => typeof value === "string" && /^[\w-]+$/.test(value);
const isArchivedThreadError = error => error instanceof DiscordError && error.body?.code === ARCHIVED_THREAD_CODE;
const isSettledMarkError = error => error instanceof DiscordError && (error.status === 404 || error.body?.code === ARCHIVED_THREAD_CODE);
const mintId = prefix => `${prefix}-${crypto.randomBytes(6).toString("hex")}`;

function isProjectPublicThread(channel, projectRoute) {
  return Boolean(
    channel
    && channel.type === PUBLIC_THREAD
    && !FORUM_TYPES.has(channel.parent?.type)
    && String(channel.parentId) === projectRoute.channel_id,
  );
}

function isGrantedProject(senderRoute, targetProjectRoute) {
  return Boolean(
    senderRoute && !senderRoute.remote
    && targetProjectRoute && !targetProjectRoute.remote
    && senderRoute.agent_message_targets.has(targetProjectRoute.project),
  );
}

function minuteMs(env = process.env) {
  const raw = env.CCDM_ROUTER_AGENT_MESSAGE_MINUTE_MS;
  const value = Number(raw);
  return raw !== undefined && raw !== "" && Number.isFinite(value) && value > 0 ? value : DEFAULT_MINUTE_MS;
}

function retentionMs(env = process.env) {
  return LEDGER_RETENTION_MINUTES * minuteMs(env);
}

function expiryRetryDelayMs(env = process.env) {
  return Math.max(25, Math.min(5000, Math.round(minuteMs(env) / 4)));
}

function rateWindowMs(env = process.env) {
  const raw = env.CCDM_ROUTER_AGENT_MESSAGE_RATE_WINDOW_MS;
  const value = Number(raw);
  return raw !== undefined && raw !== "" && Number.isFinite(value) && value > 0 ? value : DEFAULT_RATE_WINDOW_MS;
}

function conversationOf(route, threadName = undefined) {
  return {
    project: route.project,
    provider: route.type,
    conversation_id: route.channel_id,
    ...(route.thread_id ? { thread_id: route.thread_id, thread_name: threadName ?? null } : {}),
  };
}

function statusConversation(conversation) {
  return {
    project: conversation.project,
    provider: conversation.provider,
    conversation_id: conversation.conversation_id,
    ...(conversation.thread_id
      ? { thread_id: conversation.thread_id, thread_name: conversation.thread_name ?? null }
      : {}),
  };
}

function noticeTargetOf(conversation) {
  return {
    project: conversation.project,
    provider: conversation.provider,
    conversation_id: conversation.conversation_id,
    ...(conversation.thread_id ? { thread_id: conversation.thread_id, thread_name: conversation.thread_name ?? null } : {}),
  };
}

function channelName(channel) {
  return typeof channel?.name === "string" && channel.name.length > 0 ? channel.name : null;
}

function sameConversation(a, b) {
  return Boolean(a && b && a.project === b.project && a.conversation_id === b.conversation_id);
}

function isAddressedToCaller(exchange, from) {
  if (sameConversation(exchange.to, from)) return true;
  // A channel conversation whose project moved to another channel while open
  // still addresses that project's channel role; route validation closes it as `failed`.
  return !exchange.to.thread_id && !from.thread_id && exchange.to.project === from.project;
}

function checkOpenExchangeRoutes(table, exchange, from) {
  const targetRoute = table.projects.get(exchange.to.project);
  if (!targetRoute || targetRoute.remote) return `target project ${exchange.to.project} is no longer registered`;
  if (targetRoute.channel_id !== exchange.to_channel_id || !sameConversation(exchange.to, from)) {
    return `target project ${exchange.to.project} moved to another channel`;
  }
  const senderRoute = table.projects.get(exchange.from.project);
  if (!senderRoute || senderRoute.remote) return `sender project ${exchange.from.project} is no longer registered`;
  if (senderRoute.channel_id !== exchange.from_channel_id) {
    return `sender project ${exchange.from.project} moved to another channel`;
  }
  return null;
}

function isCapableListener(connection) {
  return Boolean(connection && connection.listener !== false && connection.capabilities?.has(CAPABILITY));
}

function errorSummary(error) {
  return {
    ...(error?.code ? { code: String(error.code) } : {}),
    ...(error?.status ? { status: error.status } : {}),
    message: error?.message ? String(error.message) : String(error),
  };
}

function createAgentMessages({ stateDir, context, getTable, findListener, listThreadListeners = () => [], deliver, log }) {
  const ledger = createAgentMessageLedger({ stateDir });
  // request_id -> exchange state
  const exchanges = new Map();
  // delivery_id -> delivery record
  const deliveries = new Map();
  // sending project -> timestamps (ms) of counted requests in the sliding window
  const rateTimestamps = new Map();
  // serialized [op, project, conversation_id, from_launch, idempotency_key] -> { at_ms, ok, result?, code?, message? }
  const idempotencyCache = new Map();
  // same key -> tail promise serializing concurrent identical calls
  const idempotencyLocks = new Map();
  // latest 20 refusals for `router status`
  const recentRefusals = [];
  let closed = false;

  function assertLedgerAvailable() {
    const error = ledger.error();
    if (error !== null) {
      throw new OpError("ledger_unavailable", `agent message ledger unavailable: ${error}`);
    }
  }

  function idempotencyKeyFromParts(op, project, conversationId, launch, key) {
    return JSON.stringify([op, project, conversationId, launch, key]);
  }

  function idempotencyKeyFor(op, session, key) {
    return idempotencyKeyFromParts(op, session.route.project, session.route.channel_id, session.keyFingerprint, key);
  }

  function pruneExpiredIdempotency(now) {
    for (const [key, entry] of idempotencyCache) {
      if (now - entry.at_ms < IDEMPOTENCY_TTL_MS) break;
      idempotencyCache.delete(key);
    }
  }

  function lookupIdempotency(cacheKey, now) {
    const entry = idempotencyCache.get(cacheKey);
    if (!entry) return null;
    if (now - entry.at_ms >= IDEMPOTENCY_TTL_MS) {
      idempotencyCache.delete(cacheKey);
      return null;
    }
    return entry;
  }

  function storeIdempotency(cacheKey, entry) {
    pruneExpiredIdempotency(entry.at_ms);
    idempotencyCache.delete(cacheKey);
    idempotencyCache.set(cacheKey, entry);
  }

  function replayIdempotency(entry) {
    if (entry.ok) return { ...entry.result };
    throw new OpError(entry.code, entry.message);
  }

  async function withIdempotency(cacheKey, fn) {
    const previous = idempotencyLocks.get(cacheKey) ?? Promise.resolve();
    let release;
    const lock = new Promise(resolve => { release = resolve; });
    idempotencyLocks.set(cacheKey, lock);
    await previous;
    try {
      const cached = lookupIdempotency(cacheKey, Date.now());
      if (cached) return replayIdempotency(cached);
      try {
        const result = await fn();
        storeIdempotency(cacheKey, { at_ms: Date.now(), ok: true, result: { ...result } });
        return result;
      } catch (error) {
        if (error instanceof OpError && error.code !== "ledger_unavailable" && error.code !== "invalid_args") {
          storeIdempotency(cacheKey, { at_ms: Date.now(), ok: false, code: error.code, message: error.message });
        }
        throw error;
      }
    } finally {
      if (idempotencyLocks.get(cacheKey) === lock) idempotencyLocks.delete(cacheKey);
      release();
    }
  }

  function pruneRate(project, now) {
    const list = rateTimestamps.get(project);
    if (!list) return [];
    const cutoff = now - rateWindowMs();
    const kept = list.filter(ts => ts > cutoff);
    if (kept.length === 0) rateTimestamps.delete(project);
    else rateTimestamps.set(project, kept);
    return kept;
  }

  function recordRate(project, now) {
    const kept = pruneRate(project, now);
    kept.push(now);
    rateTimestamps.set(project, kept);
  }

  function isOpenUnexpired(exchange, now) {
    return exchange.state === "open" && exchange.expires_at_ms > now;
  }

  function countOpenRequests(conversation, now) {
    let count = 0;
    for (const exchange of exchanges.values()) {
      if (isOpenUnexpired(exchange, now) && sameConversation(exchange.from, conversation)) count += 1;
    }
    return count;
  }

  function nextDepth(conversation, now) {
    let deepest = 0;
    for (const exchange of exchanges.values()) {
      if (isOpenUnexpired(exchange, now) && sameConversation(exchange.to, conversation) && exchange.depth > deepest) {
        deepest = exchange.depth;
      }
    }
    return deepest + 1;
  }

  async function withExchangeLock(exchange, fn) {
    const previous = exchange.lock ?? Promise.resolve();
    let release;
    exchange.lock = new Promise(resolve => { release = resolve; });
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  function clearExpiry(exchange) {
    if (exchange.timer) {
      clearTimeout(exchange.timer);
      exchange.timer = null;
    }
  }

  async function fetchChannel(channelId) {
    try {
      return await context.discord?.client?.channels.fetch(channelId) ?? null;
    } catch {
      return null;
    }
  }

  async function isThreadArchived(conversation) {
    if (!conversation?.thread_id) return false;
    const channel = await fetchChannel(conversation.thread_id);
    return Boolean(channel?.archived);
  }

  async function resolveConversation(route) {
    if (!route.thread_id) return conversationOf(route);
    const channel = await fetchChannel(route.thread_id);
    return conversationOf(route, channelName(channel));
  }

  async function resolveTarget(ctx, senderRoute, rawTarget) {
    const deny = () => ({
      ok: false,
      code: "not_granted",
      message: `${senderRoute?.project ?? ctx.session.route.project} is not granted to send Agent Requests to ${rawTarget}`,
      to: null,
    });
    const unknown = () => ({
      ok: false,
      code: "unknown_target",
      message: `unknown target: ${rawTarget}`,
      to: null,
    });

    const linkMatch = DISCORD_LINK.exec(rawTarget);
    if (linkMatch) {
      const linkedId = linkMatch[1];
      let projectRoute = ctx.table.channels.get(linkedId) ?? null;
      let channel = null;
      if (!projectRoute) {
        channel = await fetchChannel(linkedId);
        projectRoute = channel?.parentId ? (ctx.table.channels.get(String(channel.parentId)) ?? null) : null;
      }
      if (!isGrantedProject(senderRoute, projectRoute)) return deny();
      if (!isProjectPublicThread(channel, projectRoute)) return unknown();
      const listener = findListener({ project: projectRoute.project, conversation_id: linkedId, thread_id: linkedId });
      const to = {
        project: projectRoute.project,
        provider: listener?.route.type ?? projectRoute.type,
        conversation_id: linkedId,
        thread_id: linkedId,
        thread_name: channelName(channel),
      };
      return { ok: true, to, targetListener: listener, archived: Boolean(channel.archived) };
    }

    const slash = rawTarget.indexOf("/");
    if (slash >= 0) {
      const projectName = rawTarget.slice(0, slash);
      const threadSpec = rawTarget.slice(slash + 1);
      const projectRoute = projectName === "root" ? null : (ctx.table.projects.get(projectName) ?? null);
      if (!isGrantedProject(senderRoute, projectRoute)) return deny();
      if (!threadSpec) return unknown();
      if (isId(threadSpec)) {
        const byId = await fetchChannel(threadSpec);
        if (isProjectPublicThread(byId, projectRoute)) {
          const listener = findListener({ project: projectRoute.project, conversation_id: threadSpec, thread_id: threadSpec });
          const to = {
            project: projectRoute.project,
            provider: listener?.route.type ?? projectRoute.type,
            conversation_id: threadSpec,
            thread_id: threadSpec,
            thread_name: channelName(byId),
          };
          return { ok: true, to, targetListener: listener, archived: Boolean(byId.archived) };
        }
      }
      const matches = [];
      for (const connection of listThreadListeners(projectRoute.project)) {
        const channel = await fetchChannel(connection.route.thread_id);
        if (channel && channelName(channel) === threadSpec) matches.push({ connection, channel });
      }
      if (matches.length === 0) return unknown();
      if (matches.length > 1) {
        return {
          ok: false,
          code: "ambiguous_target",
          message: `ambiguous target: multiple live threads in ${projectRoute.project} are named ${threadSpec}`,
          to: null,
        };
      }
      const [{ connection, channel }] = matches;
      const threadId = connection.route.thread_id;
      const to = {
        project: projectRoute.project,
        provider: connection.route.type,
        conversation_id: threadId,
        thread_id: threadId,
        thread_name: channelName(channel),
      };
      return { ok: true, to, targetListener: connection, archived: Boolean(channel.archived) };
    }

    const targetRoute = rawTarget === "root" ? null : (ctx.table.projects.get(rawTarget) ?? null);
    if (!isGrantedProject(senderRoute, targetRoute)) return deny();
    const to = conversationOf(targetRoute);
    return { ok: true, to, targetListener: findListener(to), archived: false };
  }

  async function appendBestEffort(fields) {
    try {
      await ledger.append(fields);
      return true;
    } catch (error) {
      log?.(`agent_message_ledger_failed type=${fields.type} error=${error.message}`);
      return false;
    }
  }

  function pushRecentRefusal(record) {
    recentRefusals.push({
      at: record.at,
      from: statusConversation(record.from),
      target: record.target ?? record.request_id ?? null,
      code: record.code,
    });
    if (recentRefusals.length > RECENT_REFUSALS) recentRefusals.shift();
  }

  async function recordRefusal({ op, from, to, target, requestId, code, message, fromLaunch, idempotencyKey }) {
    const record = await ledger.append({
      type: "refusal",
      refusal_id: mintId("ref"),
      op,
      from,
      to: to ?? null,
      ...(target !== undefined ? { target } : {}),
      ...(requestId !== undefined ? { request_id: requestId } : {}),
      code,
      message,
      from_launch: fromLaunch,
      idempotency_key: idempotencyKey,
    });
    pushRecentRefusal(record);
  }

  async function markPost(channelId, messageId, emoji, requestId) {
    try {
      await reactMark(context, { channelId, messageId, emoji });
    } catch (error) {
      if (isSettledMarkError(error)) return;
      log?.(`agent_message_mark_failed id=${requestId} channel=${channelId} message=${messageId} emoji=${emoji} error=${error.message}`);
    }
  }

  async function enqueueDelivery({ kind, requestId, to, toLaunch, payload }) {
    const deliveryId = mintId("del");
    const recorded = await appendBestEffort({
      type: "delivery",
      delivery_id: deliveryId,
      kind,
      request_id: requestId,
      to,
      to_launch: toLaunch,
      ...payload,
    });
    if (!recorded) return;
    const event = {
      event: "agent_message",
      delivery_id: deliveryId,
      kind,
      request_id: requestId,
      ...payload,
    };
    deliveries.set(deliveryId, {
      delivery_id: deliveryId,
      kind,
      request_id: requestId,
      to,
      to_launch: toLaunch,
      event,
      acked: false,
    });
    const listener = findListener(to);
    if (isCapableListener(listener) && listener.keyFingerprint === toLaunch) {
      deliver(listener, event);
    }
  }

  function onListenerHello(connection) {
    if (!isCapableListener(connection)) return;
    const acting = conversationOf(connection.route);
    for (const delivery of deliveries.values()) {
      if (delivery.acked) continue;
      if (delivery.to_launch !== connection.keyFingerprint) continue;
      if (!sameConversation(delivery.to, acting)) continue;
      deliver(connection, delivery.event);
    }
  }

  async function sendNotice(exchange, { outcome, text }) {
    const ts = new Date().toISOString();
    const target = noticeTargetOf(exchange.to);
    const post = exchange.sender_post
      ? { channel_id: exchange.sender_post.channel_id, message_id: exchange.sender_post.message_id }
      : null;
    await enqueueDelivery({
      kind: "notice",
      requestId: exchange.request_id,
      to: exchange.from,
      toLaunch: exchange.from_launch,
      payload: { target, outcome, text, ts, post },
    });
  }

  async function notifyFailed(exchange, reason) {
    if (closed) return;
    if (exchange.sender_post) {
      await markPost(exchange.sender_post.channel_id, exchange.sender_post.message_id, MARK_FAILED, exchange.request_id);
    }
    if (exchange.receiver_post) {
      await markPost(exchange.receiver_post.channel_id, exchange.receiver_post.message_id, MARK_FAILED, exchange.request_id);
    }
    if (closed) return;
    await sendNotice(exchange, {
      outcome: "failed",
      text: `Agent Request ${exchange.request_id} to ${formatConversationLabel(exchange.to)} failed: ${reason}`,
    });
  }

  async function failRequest(exchange, reason) {
    clearExpiry(exchange);
    exchange.state = "failed";
    await appendBestEffort({
      type: "failed",
      request_id: exchange.request_id,
      reason,
    });
    await notifyFailed(exchange, reason);
  }

  async function notifyExpired(exchange) {
    if (closed) return;
    if (exchange.sender_post) {
      await markPost(exchange.sender_post.channel_id, exchange.sender_post.message_id, MARK_FAILED, exchange.request_id);
    }
    if (exchange.receiver_post) {
      await markPost(exchange.receiver_post.channel_id, exchange.receiver_post.message_id, MARK_FAILED, exchange.request_id);
    }
    if (closed) return;
    await sendNotice(exchange, {
      outcome: "expired",
      text: `Agent Request ${exchange.request_id} to ${formatConversationLabel(exchange.to)} expired`,
    });
  }

  async function transitionToExpired(exchange, { bestEffort = false } = {}) {
    clearExpiry(exchange);
    const fields = {
      type: "expired",
      request_id: exchange.request_id,
    };
    if (bestEffort) {
      if (!(await appendBestEffort(fields))) return false;
    } else {
      await ledger.append(fields);
    }
    exchange.state = "expired";
    log?.(`agent_request_expired id=${exchange.request_id}`);
    return true;
  }

  async function expireRequest(exchange) {
    if (closed) return;
    await exchange.postReady;
    if (closed) return;
    const expired = await withExchangeLock(exchange, async () => {
      if (closed || exchange.state !== "open") return false;
      const ok = await transitionToExpired(exchange, { bestEffort: true });
      if (!ok && !closed && exchange.state === "open" && ledger.error() === null) {
        scheduleExpiry(exchange, expiryRetryDelayMs());
      }
      return ok;
    });
    if (!expired) return;
    await withDeadline(null, () => notifyExpired(exchange));
  }

  function scheduleExpiry(exchange, delayMs = null) {
    clearExpiry(exchange);
    if (closed || exchange.state !== "open") return;
    const delay = delayMs === null ? Math.max(0, exchange.expires_at_ms - Date.now()) : Math.max(0, delayMs);
    exchange.timer = setTimeout(() => {
      exchange.timer = null;
      expireRequest(exchange).catch(error => log?.(`agent_message_expire_failed id=${exchange.request_id} error=${error.message}`));
    }, delay);
  }

  async function publishRequest(exchange, { guildId, senderRoute, contextPct }) {
    const senderLabel = formatConversationLabel(exchange.from);
    const targetLabel = formatConversationLabel(exchange.to);
    const senderHeader = formatRecordHeader({
      kind: "request",
      direction: "to",
      label: targetLabel,
      requestId: exchange.request_id,
    });

    let senderPost;
    if (await isThreadArchived(exchange.from)) {
      await appendBestEffort({
        type: "post",
        request_id: exchange.request_id,
        kind: "request",
        side: "sender",
        channel_id: exchange.from.conversation_id,
        skipped: "thread_archived",
      });
      await failRequest(exchange, "sender thread is archived");
      return;
    }
    try {
      senderPost = await postWebhookRecord(context, {
        route: senderRoute,
        header: senderHeader,
        text: exchange.text,
        contextPct,
        reserveHeaderChars: linkSuffixReserve(guildId, exchange.to.conversation_id),
      });
      exchange.sender_post = { channel_id: senderPost.channel_id, message_id: senderPost.message_id };
      await appendBestEffort({
        type: "post",
        request_id: exchange.request_id,
        kind: "request",
        side: "sender",
        channel_id: senderPost.channel_id,
        message_id: senderPost.message_id,
        message_ids: senderPost.message_ids,
      });
    } catch (error) {
      if (error.firstMessageId) {
        exchange.sender_post = { channel_id: exchange.from.conversation_id, message_id: error.firstMessageId };
      }
      await appendBestEffort({
        type: "post",
        request_id: exchange.request_id,
        kind: "request",
        side: "sender",
        channel_id: exchange.from.conversation_id,
        ...(isArchivedThreadError(error) ? { skipped: "thread_archived" } : { error: errorSummary(error) }),
      });
      log?.(`agent_message_post_failed id=${exchange.request_id} kind=request side=sender error=${error.message}`);
      await failRequest(exchange, `sender record post failed: ${error.message}`);
      return;
    }

    const senderUrl = messageLink(guildId, senderPost.channel_id, senderPost.message_id);
    const receiverHeader = formatRecordHeader({
      kind: "request",
      direction: "from",
      label: senderLabel,
      requestId: exchange.request_id,
      counterpartUrl: senderUrl,
    });

    let receiverPost;
    if (await isThreadArchived(exchange.to)) {
      await appendBestEffort({
        type: "post",
        request_id: exchange.request_id,
        kind: "request",
        side: "receiver",
        channel_id: exchange.to.conversation_id,
        skipped: "thread_archived",
      });
      await failRequest(exchange, "receiver thread is archived");
      return;
    }
    try {
      receiverPost = await postBotRecord(context, {
        channelId: exchange.to.conversation_id,
        header: receiverHeader,
        text: exchange.text,
      });
      exchange.receiver_post = { channel_id: receiverPost.channel_id, message_id: receiverPost.message_id };
      await appendBestEffort({
        type: "post",
        request_id: exchange.request_id,
        kind: "request",
        side: "receiver",
        channel_id: receiverPost.channel_id,
        message_id: receiverPost.message_id,
        message_ids: receiverPost.message_ids,
      });
    } catch (error) {
      await appendBestEffort({
        type: "post",
        request_id: exchange.request_id,
        kind: "request",
        side: "receiver",
        channel_id: exchange.to.conversation_id,
        ...(isArchivedThreadError(error) ? { skipped: "thread_archived" } : { error: errorSummary(error) }),
      });
      log?.(`agent_message_post_failed id=${exchange.request_id} kind=request side=receiver error=${error.message}`);
      await failRequest(exchange, `receiver record post failed: ${error.message}`);
      return;
    }

    const receiverUrl = messageLink(guildId, receiverPost.channel_id, receiverPost.message_id);
    const linkedSenderHeader = formatRecordHeader({
      kind: "request",
      direction: "to",
      label: targetLabel,
      requestId: exchange.request_id,
      counterpartUrl: receiverUrl,
    });
    if (!(await isThreadArchived(exchange.from))) {
      try {
        await editWebhookRecord({
          route: senderRoute,
          secret: senderPost.secret,
          messageId: senderPost.message_id,
          firstChunk: senderPost.firstChunk,
          updatedHeader: linkedSenderHeader,
        });
      } catch (error) {
        log?.(`agent_message_link_edit_failed id=${exchange.request_id} kind=request error=${error.message}`);
      }
    }

    const post = { channel_id: receiverPost.channel_id, message_id: receiverPost.message_id };
    await enqueueDelivery({
      kind: "request",
      requestId: exchange.request_id,
      to: exchange.to,
      toLaunch: exchange.to_launch,
      payload: {
        from: exchange.from,
        text: exchange.text,
        ts: exchange.ts,
        expires_at: exchange.expires_at,
        depth: exchange.depth,
        post,
      },
    });
  }

  async function publishReply(exchange, { guildId, replierRoute, from, text, contextPct, ts }) {
    const senderLabel = formatConversationLabel(exchange.from);
    const replierLabel = formatConversationLabel(from);
    const replierHeader = formatRecordHeader({
      kind: "reply",
      direction: "to",
      label: senderLabel,
      requestId: exchange.request_id,
    });

    let replierPost = null;
    if (await isThreadArchived(from)) {
      await appendBestEffort({
        type: "post",
        request_id: exchange.request_id,
        kind: "reply",
        side: "sender",
        channel_id: from.conversation_id,
        skipped: "thread_archived",
      });
    } else {
      try {
        replierPost = await postWebhookRecord(context, {
          route: replierRoute,
          header: replierHeader,
          text,
          contextPct,
          reserveHeaderChars: linkSuffixReserve(guildId, exchange.from.conversation_id),
        });
        await appendBestEffort({
          type: "post",
          request_id: exchange.request_id,
          kind: "reply",
          side: "sender",
          channel_id: replierPost.channel_id,
          message_id: replierPost.message_id,
          message_ids: replierPost.message_ids,
        });
      } catch (error) {
        await appendBestEffort({
          type: "post",
          request_id: exchange.request_id,
          kind: "reply",
          side: "sender",
          channel_id: from.conversation_id,
          ...(isArchivedThreadError(error) ? { skipped: "thread_archived" } : { error: errorSummary(error) }),
        });
        log?.(`agent_message_post_failed id=${exchange.request_id} kind=reply side=sender error=${error.message}`);
      }
    }

    const replierUrl = replierPost ? messageLink(guildId, replierPost.channel_id, replierPost.message_id) : undefined;
    const receiverHeader = formatRecordHeader({
      kind: "reply",
      direction: "from",
      label: replierLabel,
      requestId: exchange.request_id,
      counterpartUrl: replierUrl,
    });

    let receiverPost = null;
    if (await isThreadArchived(exchange.from)) {
      await appendBestEffort({
        type: "post",
        request_id: exchange.request_id,
        kind: "reply",
        side: "receiver",
        channel_id: exchange.from.conversation_id,
        skipped: "thread_archived",
      });
    } else {
      try {
        receiverPost = await postBotRecord(context, {
          channelId: exchange.from.conversation_id,
          header: receiverHeader,
          text,
        });
        await appendBestEffort({
          type: "post",
          request_id: exchange.request_id,
          kind: "reply",
          side: "receiver",
          channel_id: receiverPost.channel_id,
          message_id: receiverPost.message_id,
          message_ids: receiverPost.message_ids,
        });
      } catch (error) {
        await appendBestEffort({
          type: "post",
          request_id: exchange.request_id,
          kind: "reply",
          side: "receiver",
          channel_id: exchange.from.conversation_id,
          ...(isArchivedThreadError(error) ? { skipped: "thread_archived" } : { error: errorSummary(error) }),
        });
        log?.(`agent_message_post_failed id=${exchange.request_id} kind=reply side=receiver error=${error.message}`);
      }
    }

    if (replierPost && receiverPost && !(await isThreadArchived(from))) {
      const receiverUrl = messageLink(guildId, receiverPost.channel_id, receiverPost.message_id);
      const linkedReplierHeader = formatRecordHeader({
        kind: "reply",
        direction: "to",
        label: senderLabel,
        requestId: exchange.request_id,
        counterpartUrl: receiverUrl,
      });
      try {
        await editWebhookRecord({
          route: replierRoute,
          secret: replierPost.secret,
          messageId: replierPost.message_id,
          firstChunk: replierPost.firstChunk,
          updatedHeader: linkedReplierHeader,
        });
      } catch (error) {
        log?.(`agent_message_link_edit_failed id=${exchange.request_id} kind=reply error=${error.message}`);
      }
    }

    if (exchange.sender_post) {
      await markPost(exchange.sender_post.channel_id, exchange.sender_post.message_id, MARK_REPLIED, exchange.request_id);
    }
    if (exchange.receiver_post) {
      await markPost(exchange.receiver_post.channel_id, exchange.receiver_post.message_id, MARK_REPLIED, exchange.request_id);
    }

    const post = receiverPost ? { channel_id: receiverPost.channel_id, message_id: receiverPost.message_id } : null;
    await enqueueDelivery({
      kind: "reply",
      requestId: exchange.request_id,
      to: exchange.from,
      toLaunch: exchange.from_launch,
      payload: { from, text, ts, post },
    });
  }

  async function publishUndelivered({ requestId, from, to, text, code, senderRoute, contextPct }) {
    if (await isThreadArchived(from)) {
      await appendBestEffort({
        type: "post",
        request_id: requestId,
        kind: "request",
        side: "sender",
        channel_id: from.conversation_id,
        skipped: "thread_archived",
      });
      return;
    }
    const header = formatRecordHeader({
      kind: "request",
      direction: "to",
      label: formatConversationLabel(to),
      requestId,
      notDeliveredCode: code,
    });
    try {
      const posted = await postWebhookRecord(context, {
        route: senderRoute,
        header,
        text,
        contextPct,
      });
      await appendBestEffort({
        type: "post",
        request_id: requestId,
        kind: "request",
        side: "sender",
        channel_id: posted.channel_id,
        message_id: posted.message_id,
        message_ids: posted.message_ids,
      });
      await markPost(posted.channel_id, posted.message_id, MARK_FAILED, requestId);
    } catch (error) {
      if (error.firstMessageId) {
        await markPost(from.conversation_id, error.firstMessageId, MARK_FAILED, requestId);
      }
      await appendBestEffort({
        type: "post",
        request_id: requestId,
        kind: "request",
        side: "sender",
        channel_id: from.conversation_id,
        error: errorSummary(error),
      });
      log?.(`agent_message_post_failed id=${requestId} kind=request side=sender code=${code} error=${error.message}`);
    }
  }

  async function request(ctx, args) {
    if (!isNonEmptyString(args.target)) throw new OpError("invalid_args", "target is required");
    if (!isNonEmptyString(args.text)) throw new OpError("invalid_args", "text is required");
    if (!isNonEmptyString(args.idempotency_key)) throw new OpError("invalid_args", "idempotency_key is required");
    if (args.timeout_minutes !== undefined && (!Number.isInteger(args.timeout_minutes) || args.timeout_minutes < 1)) {
      throw new OpError("invalid_args", "timeout_minutes must be a positive integer");
    }
    assertLedgerAvailable();

    const cacheKey = idempotencyKeyFor("agent_request", ctx.session, args.idempotency_key);
    return withIdempotency(cacheKey, async () => {
      const from = await resolveConversation(ctx.session.route);
      const fromLaunch = ctx.session.keyFingerprint;
      const targetName = args.target;
      const senderRoute = ctx.table.projects.get(from.project);
      const resolved = await resolveTarget(ctx, senderRoute, targetName);
      if (!resolved.ok) {
        await recordRefusal({
          op: "agent_request", from, to: resolved.to, target: targetName,
          code: resolved.code, message: resolved.message, fromLaunch, idempotencyKey: args.idempotency_key,
        });
        throw new OpError(resolved.code, resolved.message);
      }

      const { to, targetListener, archived } = resolved;
      const limits = ctx.table.agentMessageLimits ?? DEFAULT_LIMITS;
      if (args.text.length > limits.max_characters) {
        const message = `text exceeds max_characters limit (${limits.max_characters})`;
        await recordRefusal({
          op: "agent_request", from, to, target: targetName,
          code: "text_too_long", message, fromLaunch, idempotencyKey: args.idempotency_key,
        });
        throw new OpError("text_too_long", message);
      }

      const checkNow = Date.now();
      if (pruneRate(from.project, checkNow).length >= limits.requests_per_hour) {
        const message = `project ${from.project} exceeded requests_per_hour limit (${limits.requests_per_hour})`;
        await recordRefusal({
          op: "agent_request", from, to, target: targetName,
          code: "request_rate_exceeded", message, fromLaunch, idempotencyKey: args.idempotency_key,
        });
        throw new OpError("request_rate_exceeded", message);
      }

      if (countOpenRequests(from, checkNow) >= limits.open_requests) {
        const message = `conversation exceeded open_requests limit (${limits.open_requests})`;
        await recordRefusal({
          op: "agent_request", from, to, target: targetName,
          code: "open_requests_exceeded", message, fromLaunch, idempotencyKey: args.idempotency_key,
        });
        throw new OpError("open_requests_exceeded", message);
      }

      const depth = nextDepth(from, checkNow);
      if (depth > limits.depth) {
        const message = `request depth ${depth} exceeds depth limit (${limits.depth})`;
        await recordRefusal({
          op: "agent_request", from, to, target: targetName,
          code: "depth_exceeded", message, fromLaunch, idempotencyKey: args.idempotency_key,
        });
        throw new OpError("depth_exceeded", message);
      }

      if (archived || !isCapableListener(targetListener)) {
        const code = archived ? "target_closed" : "target_offline";
        const requestId = mintId("req");
        const message = archived
          ? `${formatConversationLabel(to)} is archived`
          : `${formatConversationLabel(to)} has no live agent_messages listener`;
        await recordRefusal({
          op: "agent_request", from, to, target: targetName, requestId,
          code, message, fromLaunch, idempotencyKey: args.idempotency_key,
        });
        recordRate(from.project, Date.now());
        const sessionRoute = ctx.session.route;
        withDeadline(null, () => publishUndelivered({
          requestId, from, to, text: args.text, code,
          senderRoute: sessionRoute, contextPct: args.context_pct,
        })).catch(error => log?.(`agent_message_undelivered_failed id=${requestId} error=${error.message}`));
        throw new OpError(code, message);
      }

      const requestId = mintId("req");
      const now = Date.now();
      const ts = new Date(now).toISOString();
      const timeoutMinutes = args.timeout_minutes === undefined
        ? DEFAULT_TIMEOUT_MINUTES
        : Math.min(args.timeout_minutes, MAX_TIMEOUT_MINUTES);
      const expiresAtMs = now + timeoutMinutes * minuteMs();
      const expiresAt = new Date(expiresAtMs).toISOString();
      const toLaunch = targetListener.keyFingerprint;
      const targetProjectRoute = ctx.table.projects.get(to.project);

      await ledger.append({
        type: "request",
        at: ts,
        request_id: requestId,
        from,
        to,
        from_channel_id: senderRoute.channel_id,
        to_channel_id: targetProjectRoute.channel_id,
        from_launch: fromLaunch,
        to_launch: toLaunch,
        text: args.text,
        depth,
        expires_at: expiresAt,
        idempotency_key: args.idempotency_key,
      });
      recordRate(from.project, now);

      const exchange = {
        request_id: requestId,
        state: "open",
        from,
        to,
        from_channel_id: senderRoute.channel_id,
        to_channel_id: targetProjectRoute.channel_id,
        from_launch: fromLaunch,
        to_launch: toLaunch,
        text: args.text,
        ts,
        depth,
        expires_at: expiresAt,
        expires_at_ms: expiresAtMs,
        sender_post: null,
        receiver_post: null,
        postReady: null,
        timer: null,
        lock: null,
      };
      exchanges.set(requestId, exchange);

      const guildId = ctx.table.guildId;
      const sessionRoute = ctx.session.route;
      exchange.postReady = withDeadline(null, () => publishRequest(exchange, {
        guildId, senderRoute: sessionRoute, contextPct: args.context_pct,
      })).catch(error => log?.(`agent_message_publish_failed id=${requestId} error=${error.message}`));
      scheduleExpiry(exchange);

      log?.(`agent_request id=${requestId} from=${from.project} to=${to.project}`);
      return { request_id: requestId, expires_at: expiresAt, depth };
    });
  }

  async function reply(ctx, args) {
    if (!isNonEmptyString(args.request_id)) throw new OpError("invalid_args", "request_id is required");
    if (!isNonEmptyString(args.text)) throw new OpError("invalid_args", "text is required");
    if (!isNonEmptyString(args.idempotency_key)) throw new OpError("invalid_args", "idempotency_key is required");
    assertLedgerAvailable();

    const cacheKey = idempotencyKeyFor("agent_reply", ctx.session, args.idempotency_key);
    return withIdempotency(cacheKey, async () => {
      const from = await resolveConversation(ctx.session.route);
      const fromLaunch = ctx.session.keyFingerprint;
      const exchange = exchanges.get(args.request_id);
      if (!exchange || !isAddressedToCaller(exchange, from)) {
        const message = `unknown request: ${args.request_id}`;
        await recordRefusal({
          op: "agent_reply", from, to: null, requestId: args.request_id,
          code: "unknown_request", message, fromLaunch, idempotencyKey: args.idempotency_key,
        });
        throw new OpError("unknown_request", message);
      }

      return withExchangeLock(exchange, async () => {
        await exchange.postReady;
        if (exchange.state === "open" && Date.now() >= exchange.expires_at_ms) {
          await transitionToExpired(exchange);
          withDeadline(null, () => notifyExpired(exchange))
            .catch(error => log?.(`agent_message_expire_notify_failed id=${exchange.request_id} error=${error.message}`));
        }
        if (exchange.state === "expired") {
          const message = `request ${args.request_id} has expired`;
          await recordRefusal({
            op: "agent_reply", from, to: exchange.from, requestId: args.request_id,
            code: "request_expired", message, fromLaunch, idempotencyKey: args.idempotency_key,
          });
          throw new OpError("request_expired", message);
        }
        if (exchange.state === "replied") {
          const message = `request ${args.request_id} has already been replied to`;
          await recordRefusal({
            op: "agent_reply", from, to: exchange.from, requestId: args.request_id,
            code: "already_replied", message, fromLaunch, idempotencyKey: args.idempotency_key,
          });
          throw new OpError("already_replied", message);
        }
        if (exchange.state === "failed") {
          const message = `request ${args.request_id} failed`;
          await recordRefusal({
            op: "agent_reply", from, to: exchange.from, requestId: args.request_id,
            code: "request_failed", message, fromLaunch, idempotencyKey: args.idempotency_key,
          });
          throw new OpError("request_failed", message);
        }
        const routeMismatch = checkOpenExchangeRoutes(ctx.table, exchange, from);
        if (routeMismatch) {
          clearExpiry(exchange);
          await ledger.append({
            type: "failed",
            request_id: exchange.request_id,
            reason: routeMismatch,
          });
          exchange.state = "failed";
          const message = `request ${args.request_id} failed: ${routeMismatch}`;
          await recordRefusal({
            op: "agent_reply", from, to: exchange.from, requestId: args.request_id,
            code: "request_failed", message, fromLaunch, idempotencyKey: args.idempotency_key,
          });
          withDeadline(null, () => notifyFailed(exchange, routeMismatch))
            .catch(error => log?.(`agent_message_fail_notify_failed id=${exchange.request_id} error=${error.message}`));
          throw new OpError("request_failed", message);
        }

        const limits = ctx.table.agentMessageLimits ?? DEFAULT_LIMITS;
        if (args.text.length > limits.max_characters) {
          const message = `text exceeds max_characters limit (${limits.max_characters})`;
          await recordRefusal({
            op: "agent_reply", from, to: exchange.from, requestId: args.request_id,
            code: "text_too_long", message, fromLaunch, idempotencyKey: args.idempotency_key,
          });
          throw new OpError("text_too_long", message);
        }

        const senderListener = findListener(exchange.from);
        const deliveredToLive = Boolean(
          isCapableListener(senderListener) && senderListener.keyFingerprint === exchange.from_launch,
        );
        const ts = new Date().toISOString();

        await ledger.append({
          type: "reply",
          request_id: exchange.request_id,
          from,
          to: exchange.from,
          from_launch: fromLaunch,
          text: args.text,
          idempotency_key: args.idempotency_key,
          delivered_to_live_session: deliveredToLive,
        });

        clearExpiry(exchange);
        exchange.state = "replied";
        const guildId = ctx.table.guildId;
        const replierRoute = ctx.session.route;
        withDeadline(null, () => publishReply(exchange, {
          guildId, replierRoute, from, text: args.text, contextPct: args.context_pct, ts,
        })).catch(error => log?.(`agent_message_reply_publish_failed id=${exchange.request_id} error=${error.message}`));

        log?.(`agent_reply id=${exchange.request_id} from=${from.project} to=${exchange.from.project} live=${deliveredToLive}`);
        return { request_id: exchange.request_id, delivered_to_live_session: deliveredToLive };
      });
    });
  }

  async function ack(ctx, args) {
    if (!isNonEmptyString(args.delivery_id)) throw new OpError("invalid_args", "delivery_id is required");
    const delivery = deliveries.get(args.delivery_id);
    const acting = conversationOf(ctx.session.route);
    if (
      !delivery
      || !isCapableListener(ctx.session)
      || !sameConversation(delivery.to, acting)
      || ctx.session.keyFingerprint !== delivery.to_launch
    ) {
      throw new OpError("forbidden", "delivery is not addressed to this listener");
    }
    const previous = delivery.ackLock ?? Promise.resolve();
    let release;
    delivery.ackLock = new Promise(resolve => { release = resolve; });
    await previous;
    try {
      if (!delivery.acked) {
        await ledger.append({
          type: "ack",
          delivery_id: delivery.delivery_id,
          request_id: delivery.request_id,
          by: acting,
          by_launch: ctx.session.keyFingerprint,
        });
        delivery.acked = true;
      }
      return {};
    } finally {
      release();
    }
  }

  async function targets(ctx) {
    const senderRoute = ctx.table.projects.get(ctx.session.route.project);
    if (!senderRoute || senderRoute.remote) return { targets: [] };
    const list = [];
    for (const targetName of senderRoute.agent_message_targets) {
      if (targetName === "root") continue;
      const targetRoute = ctx.table.projects.get(targetName);
      if (!targetRoute || targetRoute.remote) continue;
      const channelListener = findListener({ project: targetRoute.project, conversation_id: targetRoute.channel_id });
      const threads = [];
      for (const connection of listThreadListeners(targetRoute.project)) {
        if (!isCapableListener(connection)) continue;
        const threadId = connection.route.thread_id;
        const channel = await fetchChannel(threadId);
        threads.push({ id: threadId, name: channelName(channel) });
      }
      list.push({
        project: targetRoute.project,
        channel_live: isCapableListener(channelListener),
        threads,
      });
    }
    return { targets: list };
  }

  async function load() {
    const readResult = await ledger.read();
    if (!readResult.ok) {
      log?.(`agent_message_ledger_unavailable error=${readResult.error}`);
      return;
    }
    if (readResult.tornFinalLine) {
      log?.("agent_message_ledger_torn_final_line ignored");
    }

    const now = Date.now();
    const rateCutoff = now - rateWindowMs();
    const retentionCutoff = now - retentionMs();
    const table = getTable?.() ?? null;
    const exchangeLastAtMs = new Map();

    const addRateTimestamp = (project, atMs) => {
      if (atMs <= rateCutoff) return;
      const list = rateTimestamps.get(project) ?? [];
      list.push(atMs);
      rateTimestamps.set(project, list);
    };

    for (const record of readResult.records) {
      const atMs = Date.parse(record.at);
      if (record.request_id && record.type !== "refusal") {
        exchangeLastAtMs.set(record.request_id, Math.max(exchangeLastAtMs.get(record.request_id) ?? 0, atMs));
      }
      switch (record.type) {
        case "request": {
          const fromChannelId = record.from_channel_id
            ?? (record.from.thread_id
              ? (table?.projects.get(record.from.project)?.channel_id ?? null)
              : record.from.conversation_id);
          const toChannelId = record.to_channel_id
            ?? (record.to.thread_id
              ? (table?.projects.get(record.to.project)?.channel_id ?? null)
              : record.to.conversation_id);
          exchanges.set(record.request_id, {
            request_id: record.request_id,
            state: "open",
            from: record.from,
            to: record.to,
            from_channel_id: fromChannelId,
            to_channel_id: toChannelId,
            from_launch: record.from_launch,
            to_launch: record.to_launch,
            text: record.text,
            ts: record.at,
            depth: record.depth,
            expires_at: record.expires_at,
            expires_at_ms: Date.parse(record.expires_at),
            sender_post: null,
            receiver_post: null,
            postReady: Promise.resolve(),
            timer: null,
            lock: null,
          });
          addRateTimestamp(record.from.project, atMs);
          if (now - atMs < IDEMPOTENCY_TTL_MS) {
            const cacheKey = idempotencyKeyFromParts(
              "agent_request", record.from.project, record.from.conversation_id, record.from_launch, record.idempotency_key,
            );
            storeIdempotency(cacheKey, {
              at_ms: atMs,
              ok: true,
              result: {
                request_id: record.request_id,
                expires_at: record.expires_at,
                depth: record.depth,
              },
            });
          }
          break;
        }
        case "post": {
          if (record.kind === "request" && record.message_id) {
            const exchange = exchanges.get(record.request_id);
            if (exchange) {
              const postRef = { channel_id: record.channel_id, message_id: record.message_id };
              if (record.side === "sender") exchange.sender_post = postRef;
              else if (record.side === "receiver") exchange.receiver_post = postRef;
            }
          }
          break;
        }
        case "delivery": {
          const {
            v: _v, at: _at, type: _type,
            delivery_id: deliveryId, kind, request_id: requestId, to, to_launch: toLaunch,
            ...payload
          } = record;
          deliveries.set(deliveryId, {
            delivery_id: deliveryId,
            kind,
            request_id: requestId,
            to,
            to_launch: toLaunch,
            event: {
              event: "agent_message",
              delivery_id: deliveryId,
              kind,
              request_id: requestId,
              ...payload,
            },
            acked: false,
          });
          break;
        }
        case "ack": {
          const delivery = deliveries.get(record.delivery_id);
          if (delivery) delivery.acked = true;
          break;
        }
        case "reply": {
          const exchange = exchanges.get(record.request_id);
          if (exchange) exchange.state = "replied";
          if (now - atMs < IDEMPOTENCY_TTL_MS) {
            const cacheKey = idempotencyKeyFromParts(
              "agent_reply", record.from.project, record.from.conversation_id, record.from_launch, record.idempotency_key,
            );
            storeIdempotency(cacheKey, {
              at_ms: atMs,
              ok: true,
              result: {
                request_id: record.request_id,
                delivered_to_live_session: Boolean(record.delivered_to_live_session),
              },
            });
          }
          break;
        }
        case "expired": {
          const exchange = exchanges.get(record.request_id);
          if (exchange) exchange.state = "expired";
          break;
        }
        case "failed": {
          const exchange = exchanges.get(record.request_id);
          if (exchange) exchange.state = "failed";
          break;
        }
        case "refusal": {
          if (atMs >= retentionCutoff) pushRecentRefusal(record);
          if (record.op === "agent_request" && (record.code === "target_offline" || record.code === "target_closed")) {
            addRateTimestamp(record.from.project, atMs);
          }
          if (now - atMs < IDEMPOTENCY_TTL_MS && record.code !== "ledger_unavailable" && record.code !== "invalid_args") {
            const cacheKey = idempotencyKeyFromParts(
              record.op, record.from.project, record.from.conversation_id, record.from_launch, record.idempotency_key,
            );
            storeIdempotency(cacheKey, {
              at_ms: atMs,
              ok: false,
              code: record.code,
              message: record.message,
            });
          }
          break;
        }
      }
    }

    const deliveryAtMs = new Map();
    for (const record of readResult.records) {
      if (record.type === "delivery") {
        deliveryAtMs.set(record.delivery_id, Date.parse(record.at));
      }
    }

    const isPendingKept = (delivery) => {
      if (delivery.acked) return false;
      if (exchanges.get(delivery.request_id)?.state === "open") return true;
      return (deliveryAtMs.get(delivery.delivery_id) ?? 0) >= retentionCutoff;
    };

    const pendingRequestIds = new Set();
    for (const delivery of deliveries.values()) {
      if (isPendingKept(delivery)) pendingRequestIds.add(delivery.request_id);
    }

    const keptExchangeIds = new Set();
    for (const [requestId, exchange] of exchanges) {
      const lastAtMs = exchangeLastAtMs.get(requestId) ?? 0;
      if (exchange.state === "open" || pendingRequestIds.has(requestId) || lastAtMs >= retentionCutoff) {
        keptExchangeIds.add(requestId);
      }
    }

    const keptRecords = readResult.records.filter(record => {
      if (record.type === "refusal") return Date.parse(record.at) >= retentionCutoff;
      if (record.type === "delivery") {
        const delivery = deliveries.get(record.delivery_id);
        if (!delivery) return false;
        if (!delivery.acked) return isPendingKept(delivery);
        return exchanges.has(record.request_id) && keptExchangeIds.has(record.request_id);
      }
      if (exchanges.has(record.request_id)) return keptExchangeIds.has(record.request_id);
      if (record.type === "post") return Date.parse(record.at) >= retentionCutoff;
      return false;
    });

    for (const requestId of [...exchanges.keys()]) {
      if (!keptExchangeIds.has(requestId)) exchanges.delete(requestId);
    }
    for (const [deliveryId, delivery] of [...deliveries.entries()]) {
      const keep = delivery.acked ? keptExchangeIds.has(delivery.request_id) : isPendingKept(delivery);
      if (!keep) deliveries.delete(deliveryId);
    }

    if (readResult.exists) {
      const compacted = await ledger.compact(keptRecords);
      if (!compacted.ok) {
        exchanges.clear();
        deliveries.clear();
        rateTimestamps.clear();
        idempotencyCache.clear();
        recentRefusals.length = 0;
        log?.(`agent_message_ledger_unavailable error=${compacted.error}`);
        return;
      }
    }

    const startNow = Date.now();
    for (const exchange of exchanges.values()) {
      if (exchange.state !== "open") continue;
      if (exchange.expires_at_ms <= startNow) {
        expireRequest(exchange).catch(error => log?.(`agent_message_expire_failed id=${exchange.request_id} error=${error.message}`));
      } else {
        scheduleExpiry(exchange);
      }
    }
  }

  function status() {
    const openRequests = [];
    for (const exchange of exchanges.values()) {
      if (exchange.state !== "open") continue;
      openRequests.push({
        request_id: exchange.request_id,
        from: statusConversation(exchange.from),
        to: statusConversation(exchange.to),
        opened_at: exchange.ts,
        expires_at: exchange.expires_at,
        depth: exchange.depth,
      });
    }
    return {
      ledger: ledger.health(),
      open_requests: openRequests,
      recent_refusals: recentRefusals.map(entry => ({
        at: entry.at,
        from: statusConversation(entry.from),
        target: entry.target,
        code: entry.code,
      })),
    };
  }

  function close() {
    closed = true;
    for (const exchange of exchanges.values()) clearExpiry(exchange);
  }

  return { load, request, reply, targets, ack, status, onListenerHello, close };
}

module.exports = { CAPABILITY, DEFAULT_TIMEOUT_MINUTES, MAX_TIMEOUT_MINUTES, createAgentMessages };
