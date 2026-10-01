"use strict";

// How long a Router request may take before its client gives up. The client
// sends that moment as the request's `deadline_at`, and the Router stops
// sending Discord calls for it once it passes.
//
// Most operations are one or two Discord calls and keep the short default.
// Large reads page through Discord 100 messages at a time, so they get a
// budget per page: a 10,000-message read is 100 pages, far past 10 s at real
// Discord latency and rate limits.
const DEFAULT_TIMEOUT_MS = 10_000;
const PAGE_SIZE = 100;
// One page's Discord round trip plus room for its share of rate-limit waits.
const PAGE_BUDGET_MS = 1_000;
const MAX_READ = 10_000;
// An export's size is unknown until it is paged (up to 10,000 messages), and
// it also downloads every attachment in the range.
const EXPORT_TIMEOUT_MS = 10 * 60_000;
// `thread_list` reads the active threads, then up to ten archived pages for
// every registered project channel, one rate-limited call at a time.
const THREAD_LIST_TIMEOUT_MS = 5 * 60_000;
// The longest budget any operation gets; MCP hosts must wait at least this long.
const MAX_TIMEOUT_MS = EXPORT_TIMEOUT_MS;

// The timeout for `op`: never shorter than `fallback`, the client's default.
function requestTimeoutMs(op, args = {}, fallback = DEFAULT_TIMEOUT_MS) {
  if (op === "read_last_x_messages_in_channel") {
    const count = Number.isInteger(args?.count) ? Math.min(Math.max(args.count, 1), MAX_READ) : 1;
    return Math.max(fallback, DEFAULT_TIMEOUT_MS + Math.ceil(count / PAGE_SIZE) * PAGE_BUDGET_MS);
  }
  if (op === "export_message_range") return Math.max(fallback, EXPORT_TIMEOUT_MS);
  if (op === "thread_list") return Math.max(fallback, THREAD_LIST_TIMEOUT_MS);
  return fallback;
}

module.exports = { DEFAULT_TIMEOUT_MS, EXPORT_TIMEOUT_MS, THREAD_LIST_TIMEOUT_MS, MAX_TIMEOUT_MS, PAGE_BUDGET_MS, requestTimeoutMs };
