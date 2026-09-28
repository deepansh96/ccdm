"use strict";

// Shared Router client library: connect, hello, correlate requests with
// timeouts, and emit pushed events. Reconnect is not implemented yet.
//
//   const client = new RouterClient({ socketPath, project, key, role: "project" });
//   const scope = await client.connect();
//   client.on("event", event => ...);          // every pushed event frame
//   client.on("message" | "reaction" | "command", event => ...);
//   const result = await client.request("reply", { channel_id, text, context_pct });
//
// Failed requests reject with an Error whose `code` is the Router's error code.
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const net = require("node:net");
const { socketPath: defaultSocketPath } = require("./paths.js");

const PROTOCOL_VERSION = 1;

function routerError(code, message = code) {
  return Object.assign(new Error(message), { code });
}

class RouterClient extends EventEmitter {
  constructor({ socketPath = defaultSocketPath(), project, key, role = "project", timeoutMs = 10000 } = {}) {
    super();
    Object.assign(this, { socketPath, project, key, role, timeoutMs });
    this.socket = null;
    this.pending = new Map();
  }

  connect() {
    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (fn, value) => {
        if (!settled) {
          settled = true;
          fn(value);
        }
      };
      const socket = net.connect(this.socketPath);
      this.socket = socket;
      let buffer = "";
      socket.setEncoding("utf8");
      socket.once("connect", () => {
        this.write({ type: "hello", v: PROTOCOL_VERSION, role: this.role,
          ...(this.project ? { project: this.project } : {}), ...(this.key ? { key: this.key } : {}) });
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
          if (frame.type === "hello_ok") settle(resolve, frame.scope);
          else if (frame.type === "hello_error") settle(reject, routerError(frame.error?.code, frame.error?.message));
          else if (frame.type === "response") this.settleRequest(frame);
          else if (frame.type === "event") {
            this.emit("event", frame);
            const { type, event, ...fields } = frame;
            this.emit(event, fields);
          }
        }
      });
      socket.on("error", error => settle(reject, routerError("router_unavailable", error.message)));
      socket.on("close", () => {
        settle(reject, routerError("router_unavailable", "connection closed"));
        for (const { reject: fail, timer } of this.pending.values()) {
          clearTimeout(timer);
          fail(routerError("router_unavailable", "connection closed"));
        }
        this.pending.clear();
        this.emit("close");
      });
    });
  }

  write(frame) {
    this.socket.write(`${JSON.stringify(frame)}\n`);
  }

  request(op, args = {}, { timeoutMs = this.timeoutMs } = {}) {
    if (!this.socket || this.socket.destroyed) return Promise.reject(routerError("router_unavailable", "not connected"));
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
    this.socket?.destroy();
  }
}

module.exports = { RouterClient };
