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
const DEFAULT_MINUTE_MS = 60000;
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

function conversationOf(route, threadName = undefined) {
  return {
    project: route.project,
    provider: route.type,
    conversation_id: route.channel_id,
    ...(route.thread_id ? { thread_id: route.thread_id, thread_name: threadName ?? null } : {}),
  };
}

function noticeTargetOf(conversation) {
  return {
    project: conversation.project,
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

function createAgentMessages({ stateDir, context, findListener, listThreadListeners = () => [], deliver, log }) {
  const ledger = createAgentMessageLedger({ stateDir });
  // request_id -> exchange state
  const exchanges = new Map();
  // delivery_id -> delivery record
  const deliveries = new Map();

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

  async function recordRefusal({ op, from, to, target, requestId, code, message, fromLaunch, idempotencyKey }) {
    await ledger.append({
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
  }

  async function markPost(channelId, messageId, emoji, requestId) {
    try {
      await reactMark(context, { channelId, messageId, emoji });
    } catch (error) {
      if (isSettledMarkError(error)) return;
      log?.(`agent_message_mark_failed id=${requestId} channel=${channelId} message=${messageId} emoji=${emoji} error=${error.message}`);
    }
  }

  async function failRequest(exchange, reason) {
    exchange.state = "failed";
    await appendBestEffort({
      type: "failed",
      request_id: exchange.request_id,
      reason,
    });
    if (exchange.sender_post) {
      await markPost(exchange.sender_post.channel_id, exchange.sender_post.message_id, MARK_FAILED, exchange.request_id);
    }
    const deliveryId = mintId("del");
    const ts = new Date().toISOString();
    const target = noticeTargetOf(exchange.to);
    const post = exchange.sender_post
      ? { channel_id: exchange.sender_post.channel_id, message_id: exchange.sender_post.message_id }
      : null;
    const text = `Agent Request ${exchange.request_id} to ${formatConversationLabel(exchange.to)} failed: ${reason}`;
    const recorded = await appendBestEffort({
      type: "delivery",
      delivery_id: deliveryId,
      kind: "notice",
      request_id: exchange.request_id,
      to: exchange.from,
      to_launch: exchange.from_launch,
      target,
      outcome: "failed",
      text,
      ts,
      post,
    });
    if (!recorded) return;
    deliveries.set(deliveryId, {
      delivery_id: deliveryId,
      kind: "notice",
      request_id: exchange.request_id,
      to: exchange.from,
      to_launch: exchange.from_launch,
      acked: false,
    });
    const senderListener = findListener(exchange.from);
    if (isCapableListener(senderListener) && senderListener.keyFingerprint === exchange.from_launch) {
      deliver(senderListener, {
        event: "agent_message",
        delivery_id: deliveryId,
        kind: "notice",
        request_id: exchange.request_id,
        text,
        ts,
        target,
        outcome: "failed",
        post,
      });
    }
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

    const deliveryId = mintId("del");
    const post = { channel_id: receiverPost.channel_id, message_id: receiverPost.message_id };
    const recorded = await appendBestEffort({
      type: "delivery",
      delivery_id: deliveryId,
      kind: "request",
      request_id: exchange.request_id,
      to: exchange.to,
      to_launch: exchange.to_launch,
      from: exchange.from,
      text: exchange.text,
      ts: exchange.ts,
      expires_at: exchange.expires_at,
      depth: exchange.depth,
      post,
    });
    if (!recorded) return;

    deliveries.set(deliveryId, {
      delivery_id: deliveryId,
      kind: "request",
      request_id: exchange.request_id,
      to: exchange.to,
      to_launch: exchange.to_launch,
      acked: false,
    });

    const targetListener = findListener(exchange.to);
    if (isCapableListener(targetListener) && targetListener.keyFingerprint === exchange.to_launch) {
      deliver(targetListener, {
        event: "agent_message",
        delivery_id: deliveryId,
        kind: "request",
        request_id: exchange.request_id,
        text: exchange.text,
        ts: exchange.ts,
        from: exchange.from,
        expires_at: exchange.expires_at,
        depth: exchange.depth,
        post,
      });
    }
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

    const deliveryId = mintId("del");
    const post = receiverPost ? { channel_id: receiverPost.channel_id, message_id: receiverPost.message_id } : null;
    const recorded = await appendBestEffort({
      type: "delivery",
      delivery_id: deliveryId,
      kind: "reply",
      request_id: exchange.request_id,
      to: exchange.from,
      to_launch: exchange.from_launch,
      from,
      text,
      ts,
      post,
    });
    if (!recorded) return;

    deliveries.set(deliveryId, {
      delivery_id: deliveryId,
      kind: "reply",
      request_id: exchange.request_id,
      to: exchange.from,
      to_launch: exchange.from_launch,
      acked: false,
    });

    const senderListener = findListener(exchange.from);
    if (isCapableListener(senderListener) && senderListener.keyFingerprint === exchange.from_launch) {
      deliver(senderListener, {
        event: "agent_message",
        delivery_id: deliveryId,
        kind: "reply",
        request_id: exchange.request_id,
        text,
        ts,
        from,
        post,
      });
    }
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
    const expiresAt = new Date(now + DEFAULT_TIMEOUT_MINUTES * minuteMs()).toISOString();
    const depth = 1;
    const toLaunch = targetListener.keyFingerprint;

    await ledger.append({
      type: "request",
      request_id: requestId,
      from,
      to,
      from_launch: fromLaunch,
      to_launch: toLaunch,
      text: args.text,
      depth,
      expires_at: expiresAt,
      idempotency_key: args.idempotency_key,
    });

    const exchange = {
      request_id: requestId,
      state: "open",
      from,
      to,
      from_launch: fromLaunch,
      to_launch: toLaunch,
      text: args.text,
      ts,
      depth,
      expires_at: expiresAt,
      sender_post: null,
      receiver_post: null,
      postReady: null,
    };
    exchanges.set(requestId, exchange);

    const guildId = ctx.table.guildId;
    const sessionRoute = ctx.session.route;
    exchange.postReady = withDeadline(null, () => publishRequest(exchange, {
      guildId, senderRoute: sessionRoute, contextPct: args.context_pct,
    })).catch(error => log?.(`agent_message_publish_failed id=${requestId} error=${error.message}`));

    log?.(`agent_request id=${requestId} from=${from.project} to=${to.project}`);
    return { request_id: requestId, expires_at: expiresAt, depth };
  }

  async function reply(ctx, args) {
    if (!isNonEmptyString(args.request_id)) throw new OpError("invalid_args", "request_id is required");
    if (!isNonEmptyString(args.text)) throw new OpError("invalid_args", "text is required");
    if (!isNonEmptyString(args.idempotency_key)) throw new OpError("invalid_args", "idempotency_key is required");

    const from = await resolveConversation(ctx.session.route);
    const fromLaunch = ctx.session.keyFingerprint;
    const exchange = exchanges.get(args.request_id);
    if (!exchange || !sameConversation(exchange.to, from)) {
      const message = `unknown request: ${args.request_id}`;
      await recordRefusal({
        op: "agent_reply", from, to: null, requestId: args.request_id,
        code: "unknown_request", message, fromLaunch, idempotencyKey: args.idempotency_key,
      });
      throw new OpError("unknown_request", message);
    }

    const previous = exchange.replyLock ?? Promise.resolve();
    let release;
    exchange.replyLock = new Promise(resolve => { release = resolve; });
    await previous;
    try {
      await exchange.postReady;
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

      exchange.state = "replied";
      const guildId = ctx.table.guildId;
      const replierRoute = ctx.session.route;
      withDeadline(null, () => publishReply(exchange, {
        guildId, replierRoute, from, text: args.text, contextPct: args.context_pct, ts,
      })).catch(error => log?.(`agent_message_reply_publish_failed id=${exchange.request_id} error=${error.message}`));

      log?.(`agent_reply id=${exchange.request_id} from=${from.project} to=${exchange.from.project} live=${deliveredToLive}`);
      return { request_id: exchange.request_id, delivered_to_live_session: deliveredToLive };
    } finally {
      release();
    }
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

  return { request, reply, targets, ack };
}

module.exports = { CAPABILITY, DEFAULT_TIMEOUT_MINUTES, createAgentMessages };
