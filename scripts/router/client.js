"use strict";

// Shared Router client library: connect, hello, correlate requests with
// timeouts, emit pushed events, and reconnect with capped exponential backoff.
//
//   const client = new RouterClient({ socketPath, project, key, role: "project" });
//   // `listener: false` connects for operations only: no events, and the
//   // project's listener keeps its place.
//   const scope = await client.connect();      // the first connect does not retry
//   client.on("event", event => ...);          // every pushed event frame
//   client.on("message" | "reaction" | "command" | "revoked", event => ...);
//   client.on("disconnect" | "reconnect" | "end", ...);
//   const result = await client.request("reply", { channel_id, text, context_pct });
//
// After the Router goes away the client says hello again on its own and emits
// `reconnect` with the scope. While disconnected every request fails at once
// with `router_unavailable`; nothing is queued. A `revoked` event, a refused
// hello on reconnect, or close() ends the client for good (`end`).
//
// Failed requests reject with an Error whose `code` is the Router's error code.
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const net = require("node:net");
const { socketPath: defaultSocketPath } = require("./paths.js");

const PROTOCOL_VERSION = 1;
const DEFAULT_RECONNECT_BACKOFF = Object.freeze({ minMs: 500, maxMs: 30000 });

function routerError(code, message = code) {
  return Object.assign(new Error(message), { code });
}

// Backoff bounds, overridable by environment so tests can shorten them.
function reconnectBackoff(env = process.env) {
  const bound = (value, fallback) => {
    const number = Number(value);
    return value !== undefined && value !== "" && Number.isFinite(number) && number > 0 ? number : fallback;
  };
  const minMs = bound(env.CCDM_ROUTER_RECONNECT_MIN_MS, DEFAULT_RECONNECT_BACKOFF.minMs);
  return { minMs, maxMs: Math.max(minMs, bound(env.CCDM_ROUTER_RECONNECT_MAX_MS, DEFAULT_RECONNECT_BACKOFF.maxMs)) };
}

class RouterClient extends EventEmitter {
  constructor({ socketPath = defaultSocketPath(), project, key, role = "project", listener = true, timeoutMs = 10000,
    reconnect = role !== "status", env = process.env } = {}) {
    super();
    Object.assign(this, { socketPath, project, key, role, listener, timeoutMs, reconnect, backoff: reconnectBackoff(env) });
    this.socket = null;
    this.ready = false;
    this.connectedOnce = false;
    this.ended = false;
    this.attempt = 0;
    this.retryTimer = null;
    this.pending = new Map();
  }

  connect() {
    return new Promise((resolve, reject) => this.open(resolve, reject));
  }

  // One socket attempt. `resolve`/`reject` settle the first connect() only.
  open(resolve, reject) {
    let settled = false;
    const settle = (fn, value) => {
      if (!settled && fn) {
        settled = true;
        fn(value);
      }
    };
    const socket = net.connect(this.socketPath);
    this.socket = socket;
    let revoked = false;
    let buffer = "";
    socket.setEncoding("utf8");
    socket.once("connect", () => {
      this.write({ type: "hello", v: PROTOCOL_VERSION, role: this.role,
        ...(this.project ? { project: this.project } : {}), ...(this.key ? { key: this.key } : {}),
        ...(this.listener ? {} : { listener: false }) });
    });
    socket.on("data", chunk => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        let frame;
        try {
          frame = JSON.parse(line);
        } catch {
          continue;
        }
        if (frame.type === "hello_ok") {
          this.ready = true;
          this.attempt = 0;
          const reconnected = this.connectedOnce;
          this.connectedOnce = true;
          settle(resolve, frame.scope);
          if (reconnected) this.emit("reconnect", frame.scope);
        } else if (frame.type === "hello_error") {
          const error = routerError(frame.error?.code, frame.error?.message);
          if (this.connectedOnce) this.end(error);
          settle(reject, error);
        } else if (frame.type === "response") this.settleRequest(frame);
        else if (frame.type === "event") {
          if (frame.event === "revoked") revoked = true;
          this.emit("event", frame);
          const { type, event, ...fields } = frame;
          this.emit(event, fields);
        }
      }
    });
    socket.on("error", error => settle(reject, routerError("router_unavailable", error.message)));
    socket.on("close", () => {
      const wasReady = this.ready;
      this.ready = false;
      settle(reject, routerError("router_unavailable", "connection closed"));
      for (const { reject: fail, timer } of this.pending.values()) {
        clearTimeout(timer);
        fail(routerError("router_unavailable", "connection closed"));
      }
      this.pending.clear();
      if (this.ended) return;
      if (wasReady) this.emit("disconnect");
      if (revoked) return this.end(routerError("revoked", "the Router revoked this session's key"));
      if (!this.connectedOnce) return;
      if (!this.reconnect) return this.end(routerError("router_unavailable", "connection closed"));
      this.scheduleReconnect();
    });
  }

  scheduleReconnect() {
    const delay = Math.min(this.backoff.maxMs, this.backoff.minMs * 2 ** this.attempt);
    this.attempt += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (!this.ended) this.open();
    }, delay);
  }

  end(error = null) {
    if (this.ended) return;
    this.ended = true;
    clearTimeout(this.retryTimer);
    this.socket?.destroy();
    this.emit("end", error);
  }

  write(frame) {
    this.socket.write(`${JSON.stringify(frame)}\n`);
  }

  request(op, args = {}, { timeoutMs = this.timeoutMs } = {}) {
    if (!this.ready || this.socket.destroyed) return Promise.reject(routerError("router_unavailable", "not connected"));
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(routerError("timeout", `${op} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ type: "request", id, op, args });
    });
  }

  settleRequest(frame) {
    const pending = this.pending.get(frame.id);
    if (!pending) return;
    this.pending.delete(frame.id);
    clearTimeout(pending.timer);
    if (frame.ok) pending.resolve(frame.result);
    else pending.reject(routerError(frame.error?.code, frame.error?.message));
  }

  close() {
    this.end();
  }
}

module.exports = { DEFAULT_RECONNECT_BACKOFF, RouterClient, reconnectBackoff };
