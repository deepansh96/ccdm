"use strict";

// Minimal Discord REST calls. `token` is the root bot token; webhook
// executes authenticate with the webhook's own token in the URL instead.
//
// Every call goes through a per-route queue that absorbs rate limits: it
// waits out exhausted buckets (`X-RateLimit-Remaining: 0`), retries 429s after
// `Retry-After`, and pauses every route on a global 429. A call that cannot be
// sent within the wait bound fails with the typed `rate_limited` code, so
// callers never see a raw 429.
const { OpError } = require("./ops/errors.js");

const API = "https://discord.com/api/v10";
// Real defaults; tests shorten them through the environment.
const DEFAULT_RATE_LIMIT = Object.freeze({ maxWaitMs: 30000, fallbackRetryMs: 1000 });

class DiscordError extends Error {
  constructor(status, body) {
    super(`Discord API ${status}${body?.message ? `: ${body.message}` : ""}`);
    this.status = status;
    this.body = body;
  }
}

function rateLimitSettings(env = process.env) {
  const bound = (value, fallback) => {
    const number = Number(value);
    return value !== undefined && value !== "" && Number.isFinite(number) && number > 0 ? number : fallback;
  };
  return {
    maxWaitMs: bound(env.CCDM_ROUTER_RATE_LIMIT_MAX_WAIT_MS, DEFAULT_RATE_LIMIT.maxWaitMs),
    fallbackRetryMs: bound(env.CCDM_ROUTER_RATE_LIMIT_FALLBACK_MS, DEFAULT_RATE_LIMIT.fallbackRetryMs),
  };
}

// Discord limits per route, split by its major parameter (channel, guild, or
// webhook id and token): the ids after these collections share the limit.
const MINOR = new Set(["messages", "reactions", "members", "roles", "permissions", "invites", "users"]);
function routeKey(method, route) {
  const parts = route.split("/");
  return `${method} ${parts.map((part, index) => (MINOR.has(parts[index - 1]) ? ":id" : part)).join("/")}`;
}

function majorParameter(route) {
  const match = /^\/(channels|guilds|webhooks)\/([^/]+)(?:\/([^/]+))?/.exec(route);
  if (!match) return "";
  return match[1] === "webhooks" ? `${match[2]}/${match[3] ?? ""}` : match[2];
}

// route key -> Discord's bucket hash; bucket id -> when it resets (ms epoch).
const bucketHashes = new Map();
const bucketResets = new Map();
// route key -> the tail of that route's queue.
const queues = new Map();
let globalResetAt = 0;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function bucketId(key, route) {
  const hash = bucketHashes.get(key);
  return hash ? `${hash}:${majorParameter(route)}` : key;
}

function seconds(value) {
  const number = Number(value);
  return value !== null && value !== undefined && value !== "" && Number.isFinite(number) && number >= 0 ? number * 1000 : null;
}

// Waits until `until`, or fails as rate_limited when that passes the deadline.
async function waitUntil(until, deadline, route) {
  const wait = until - Date.now();
  if (wait <= 0) return;
  if (until > deadline) throw new OpError("rate_limited", `Discord rate limit on ${route.split("/")[1]} outlasted the wait bound`);
  await sleep(wait);
}

async function send(method, url, headers, payload) {
  const res = await fetch(url.href, { method, headers, body: payload });
  const text = res.status === 204 ? "" : await res.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { message: text };
  }
  return { res, parsed };
}

async function sendWithinLimits(method, route, url, headers, payload, deadline, settings) {
  const key = routeKey(method, route);
  for (;;) {
    await waitUntil(globalResetAt, deadline, route);
    await waitUntil(bucketResets.get(bucketId(key, route)) ?? 0, deadline, route);
    const { res, parsed } = await send(method, url, headers, payload);
    const hash = res.headers.get("x-ratelimit-bucket");
    if (hash) bucketHashes.set(key, hash);
    const bucket = bucketId(key, route);
    const resetAfter = seconds(res.headers.get("x-ratelimit-reset-after"));
    if (res.headers.get("x-ratelimit-remaining") === "0" && resetAfter !== null) {
      bucketResets.set(bucket, Date.now() + resetAfter);
    } else {
      bucketResets.delete(bucket);
    }
    if (res.status !== 429) {
      if (!res.ok) throw new DiscordError(res.status, parsed);
      return parsed;
    }
    const retryMs = seconds(parsed?.retry_after) ?? seconds(res.headers.get("retry-after")) ?? settings.fallbackRetryMs;
    const retryAt = Date.now() + retryMs;
    if (parsed?.global === true || res.headers.get("x-ratelimit-global") === "true") {
      globalResetAt = Math.max(globalResetAt, retryAt);
    } else {
      bucketResets.set(bucket, Math.max(bucketResets.get(bucket) ?? 0, retryAt));
    }
  }
}

// A FormData `body` is sent as multipart (fetch sets its boundary); anything else as JSON.
async function discordRequest(method, route, { token, body, query } = {}) {
  const settings = rateLimitSettings();
  const deadline = Date.now() + settings.maxWaitMs;
  const url = new URL(`${API}${route}`);
  for (const [key, value] of Object.entries(query || {})) url.searchParams.set(key, String(value));
  const headers = {};
  if (token) headers.Authorization = `Bot ${token}`;
  const multipart = body instanceof FormData;
  if (body !== undefined && !multipart) headers["Content-Type"] = "application/json";
  const payload = body === undefined || multipart ? body : JSON.stringify(body);
  // One request at a time per route, in arrival order.
  const key = routeKey(method, route);
  const previous = queues.get(key) ?? Promise.resolve();
  const run = previous.then(() => sendWithinLimits(method, route, url, headers, payload, deadline, settings));
  const tail = run.catch(() => {});
  queues.set(key, tail);
  tail.then(() => { if (queues.get(key) === tail) queues.delete(key); });
  return run;
}

module.exports = { DEFAULT_RATE_LIMIT, DiscordError, discordRequest, rateLimitSettings };
