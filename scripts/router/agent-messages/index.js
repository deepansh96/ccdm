"use strict";

// Agent Message module (ADR 0009): checks Agent Message Grants, routes Agent
// Requests and Agent Replies between capable sessions through the Router, and
// appends every state change to the private ledger before it takes effect.
const crypto = require("node:crypto");
const { OpError } = require("../ops/errors.js");
const { createAgentMessageLedger } = require("./ledger.js");

const CAPABILITY = "agent_messages";
const DEFAULT_TIMEOUT_MINUTES = 30;
const DEFAULT_MINUTE_MS = 60000;

const isNonEmptyString = value => typeof value === "string" && value.trim().length > 0;
const mintId = prefix => `${prefix}-${crypto.randomBytes(6).toString("hex")}`;

function minuteMs(env = process.env) {
  const raw = env.CCDM_ROUTER_AGENT_MESSAGE_MINUTE_MS;
  const value = Number(raw);
  return raw !== undefined && raw !== "" && Number.isFinite(value) && value > 0 ? value : DEFAULT_MINUTE_MS;
}

function conversationOf(route) {
  return {
    project: route.project,
    provider: route.type,
    conversation_id: route.channel_id,
    ...(route.thread_id ? { thread_id: route.thread_id } : {}),
  };
}

function sameConversation(a, b) {
  return Boolean(a && b && a.project === b.project && a.conversation_id === b.conversation_id);
}

function isCapableListener(connection) {
  return Boolean(connection && connection.listener !== false && connection.capabilities?.has(CAPABILITY));
}

function createAgentMessages({ stateDir, findListener, deliver, log }) {
  const ledger = createAgentMessageLedger({ stateDir });
  // request_id -> exchange state
  const exchanges = new Map();
  // delivery_id -> delivery record
  const deliveries = new Map();

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

  async function request(ctx, args) {
    if (!isNonEmptyString(args.target)) throw new OpError("invalid_args", "target is required");
    if (!isNonEmptyString(args.text)) throw new OpError("invalid_args", "text is required");
    if (!isNonEmptyString(args.idempotency_key)) throw new OpError("invalid_args", "idempotency_key is required");
    if (args.timeout_minutes !== undefined && (!Number.isInteger(args.timeout_minutes) || args.timeout_minutes < 1)) {
      throw new OpError("invalid_args", "timeout_minutes must be a positive integer");
    }

    const from = conversationOf(ctx.session.route);
    const fromLaunch = ctx.session.keyFingerprint;
    const targetName = args.target;
    const senderRoute = ctx.table.projects.get(from.project);
    const targetRoute = targetName === "root" ? null : ctx.table.projects.get(targetName);
    const granted = Boolean(
      senderRoute && !senderRoute.remote
      && targetRoute && !targetRoute.remote
      && senderRoute.agent_message_targets.has(targetName),
    );
    if (!granted) {
      const message = `${from.project} is not granted to send Agent Requests to ${targetName}`;
      await recordRefusal({
        op: "agent_request", from, to: null, target: targetName,
        code: "not_granted", message, fromLaunch, idempotencyKey: args.idempotency_key,
      });
      throw new OpError("not_granted", message);
    }

    const to = conversationOf(targetRoute);
    const targetListener = findListener(to);
    if (!isCapableListener(targetListener)) {
      const message = `${targetRoute.project} has no live agent_messages listener`;
      await recordRefusal({
        op: "agent_request", from, to, target: targetName,
        code: "target_offline", message, fromLaunch, idempotencyKey: args.idempotency_key,
      });
      throw new OpError("target_offline", message);
    }

    const requestId = mintId("req");
    const deliveryId = mintId("del");
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
    await ledger.append({
      type: "delivery",
      delivery_id: deliveryId,
      kind: "request",
      request_id: requestId,
      to,
      to_launch: toLaunch,
      from,
      text: args.text,
      ts,
      expires_at: expiresAt,
      depth,
      post: null,
    });

    exchanges.set(requestId, {
      request_id: requestId,
      state: "open",
      from,
      to,
      from_launch: fromLaunch,
      to_launch: toLaunch,
      depth,
      expires_at: expiresAt,
    });
    deliveries.set(deliveryId, {
      delivery_id: deliveryId,
      kind: "request",
      request_id: requestId,
      to,
      to_launch: toLaunch,
      acked: false,
    });

    deliver(targetListener, {
      event: "agent_message",
      delivery_id: deliveryId,
      kind: "request",
      request_id: requestId,
      text: args.text,
      ts,
      from,
      expires_at: expiresAt,
      depth,
      post: null,
    });
    log?.(`agent_request id=${requestId} from=${from.project} to=${to.project}`);
    return { request_id: requestId, expires_at: expiresAt, depth };
  }

  async function reply(ctx, args) {
    if (!isNonEmptyString(args.request_id)) throw new OpError("invalid_args", "request_id is required");
    if (!isNonEmptyString(args.text)) throw new OpError("invalid_args", "text is required");
    if (!isNonEmptyString(args.idempotency_key)) throw new OpError("invalid_args", "idempotency_key is required");

    const from = conversationOf(ctx.session.route);
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
      if (exchange.state === "replied") {
        const message = `request ${args.request_id} has already been replied to`;
        await recordRefusal({
          op: "agent_reply", from, to: exchange.from, requestId: args.request_id,
          code: "already_replied", message, fromLaunch, idempotencyKey: args.idempotency_key,
        });
        throw new OpError("already_replied", message);
      }

      const senderListener = findListener(exchange.from);
      const deliveredToLive = Boolean(
        isCapableListener(senderListener) && senderListener.keyFingerprint === exchange.from_launch,
      );
      const deliveryId = mintId("del");
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
      await ledger.append({
        type: "delivery",
        delivery_id: deliveryId,
        kind: "reply",
        request_id: exchange.request_id,
        to: exchange.from,
        to_launch: exchange.from_launch,
        from,
        text: args.text,
        ts,
        post: null,
      });

      exchange.state = "replied";
      deliveries.set(deliveryId, {
        delivery_id: deliveryId,
        kind: "reply",
        request_id: exchange.request_id,
        to: exchange.from,
        to_launch: exchange.from_launch,
        acked: false,
      });

      if (deliveredToLive) {
        deliver(senderListener, {
          event: "agent_message",
          delivery_id: deliveryId,
          kind: "reply",
          request_id: exchange.request_id,
          text: args.text,
          ts,
          from,
          post: null,
        });
      }
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

  return { request, reply, ack };
}

module.exports = { CAPABILITY, DEFAULT_TIMEOUT_MINUTES, createAgentMessages };
