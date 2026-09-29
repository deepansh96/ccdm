"use strict";

// The Router's private Unix socket: NDJSON frames, a versioned hello with a
// per-project key, request/response by id, and events pushed to sessions.
const crypto = require("node:crypto");
const { watch } = require("node:fs");
const { chmod, mkdir, readFile, unlink } = require("node:fs/promises");
const net = require("node:net");
const path = require("node:path");
const { ScopeViolation } = require("./ops/errors.js");
const { OPERATIONS } = require("./ops/index.js");

const PROTOCOL_VERSION = 1;
// How many recent scope violations `router status` keeps.
const RECENT_VIOLATIONS = 20;

function send(socket, frame) {
  if (!socket.destroyed) socket.write(`${JSON.stringify(frame)}\n`);
}

function keysMatch(expected, actual) {
  const a = Buffer.from(String(expected));
  const b = Buffer.from(String(actual ?? ""));
  return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

// A frame is a JSON object with a string type; requests also need a string id.
function parseFrame(line) {
  let frame;
  try {
    frame = JSON.parse(line);
  } catch {
    return null;
  }
  if (!frame || typeof frame !== "object" || Array.isArray(frame) || typeof frame.type !== "string") return null;
  if (frame.type === "request" && (typeof frame.id !== "string" || !frame.id)) return null;
  return frame;
}

// A live socket already owns the path: refuse rather than steal it.
async function claimSocketPath(socketPath) {
  const live = await new Promise(resolve => {
    const probe = net.connect(socketPath);
    probe.once("connect", () => { probe.destroy(); resolve(true); });
    probe.once("error", () => resolve(false));
  });
  if (live) throw new Error(`another Router is listening on ${socketPath}`);
  await unlink(socketPath).catch(error => { if (error.code !== "ENOENT") throw error; });
}

function createRouterServer({ stateDir, socketPath, getTable, gateway, context, log }) {
  // project name -> the one session connected for it.
  const sessions = new Map();
  const violations = [];
  const keysDir = path.join(stateDir, "keys");
  let keysWatcher = null;

  async function projectKey(project) {
    try {
      return (await readFile(path.join(keysDir, `${path.basename(project)}.key`), "utf8")).trim();
    } catch {
      return null;
    }
  }

  // The session loses its place: it is told why, then disconnected.
  function revoke(connection, reason) {
    if (sessions.get(connection.route.project) === connection) sessions.delete(connection.route.project);
    log(`revoked project=${connection.route.project} reason=${reason}`);
    send(connection.socket, { type: "event", event: "revoked", reason });
    connection.socket.end();
  }

  // A launch wrote a new key: any session still holding the old one goes.
  async function revokeStaleKeys() {
    for (const connection of [...sessions.values()]) {
      if (!keysMatch(await projectKey(connection.route.project), connection.key)) revoke(connection, "key_rotated");
    }
  }

  async function hello(connection, frame) {
    const reject = (code, message) => {
      send(connection.socket, { type: "hello_error", v: PROTOCOL_VERSION, error: { code, message } });
      connection.socket.end();
    };
    if (frame.v !== PROTOCOL_VERSION) return reject("unsupported_version", `expected v${PROTOCOL_VERSION}`);
    if (frame.role === "status") {
      connection.role = "status";
      return send(connection.socket, { type: "hello_ok", v: PROTOCOL_VERSION, scope: null });
    }
    if (frame.role !== "project") return reject("unsupported_role", `unsupported role: ${frame.role}`);
    const route = getTable().projects.get(String(frame.project));
    if (!route || !keysMatch(await projectKey(route.project), frame.key)) {
      return reject("unauthorized", "unknown project or key");
    }
    // One listener per project: a newer hello replaces whoever held the project.
    const previous = sessions.get(route.project);
    if (previous) revoke(previous, "replaced");
    Object.assign(connection, { role: "project", route, key: frame.key, connectedAt: new Date().toISOString() });
    sessions.set(route.project, connection);
    send(connection.socket, {
      type: "hello_ok", v: PROTOCOL_VERSION,
      scope: { project: route.project, channel_id: route.channel_id, type: route.type },
    });
  }

  async function request(connection, frame) {
    const respond = result => send(connection.socket, { type: "response", id: frame.id, ...result });
    const fail = (code, message = code) => respond({ ok: false, error: { code, message } });
    if (!connection.role) return fail("not_authenticated", "hello first");
    const operation = Object.hasOwn(OPERATIONS, frame.op) ? OPERATIONS[frame.op] : null;
    if (!operation) return fail("unknown_op", `unknown op: ${frame.op}`);
    if (!operation.roles.includes(connection.role)) return fail("forbidden", `${frame.op} is not allowed for ${connection.role}`);
    const args = frame.args && typeof frame.args === "object" ? frame.args : {};
    const violation = (target, message) => {
      log(`scope_violation project=${connection.route.project} op=${frame.op} target=${target}`);
      violations.push({ project: connection.route.project, op: frame.op, target: String(target), at: new Date().toISOString() });
      if (violations.length > RECENT_VIOLATIONS) violations.shift();
      fail("scope_violation", message);
    };
    if (operation.scoped && String(args.channel_id) !== connection.route.channel_id) {
      return violation(args.channel_id, "channel_id is outside this session's scope");
    }
    try {
      const result = await operation.run({ ...context, session: connection, sessions: listSessions, violations: () => [...violations], table: getTable(), gateway }, args);
      respond({ ok: true, result });
    } catch (error) {
      if (error instanceof ScopeViolation) return violation(error.target, error.message);
      if (error.code && !error.status) return fail(error.code, error.message);
      log(`op_failed project=${connection.route?.project ?? "-"} op=${frame.op} error=${error.message}`);
      fail("discord_error", error.message);
    }
  }

  function listSessions() {
    return [...sessions.values()].map(connection => ({
      role: connection.role, route: connection.route, connectedAt: connection.connectedAt,
    }));
  }

  function onConnection(socket) {
    const connection = { socket, role: null, hello: null };
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", chunk => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        const frame = parseFrame(line);
        if (!frame) {
          send(socket, { type: "error", error: { code: "malformed_frame", message: "expected a JSON object with a type (and an id for requests)" } });
          continue;
        }
        // Requests wait for an in-flight hello so they see its outcome, but not for each other.
        let handled;
        if (frame.type === "hello" && !connection.role && !connection.hello) {
          handled = connection.hello = hello(connection, frame);
        } else if (frame.type === "request") {
          handled = (connection.hello ?? Promise.resolve()).catch(() => {}).then(() => request(connection, frame));
        } else {
          handled = Promise.resolve(send(socket, { type: "error", error: { code: "unexpected_frame" } }));
        }
        handled.catch(error => log(`frame_failed error=${error.message}`));
      }
    });
    socket.on("error", () => {});
    socket.on("close", () => {
      if (connection.route && sessions.get(connection.route.project) === connection) sessions.delete(connection.route.project);
    });
  }

  const server = net.createServer(onConnection);

  return {
    async listen() {
      await mkdir(stateDir, { recursive: true, mode: 0o700 });
      await chmod(stateDir, 0o700);
      await claimSocketPath(socketPath);
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, resolve);
      });
      await chmod(socketPath, 0o600);
      await mkdir(keysDir, { recursive: true, mode: 0o700 });
      keysWatcher = watch(keysDir, () => {
        revokeStaleKeys().catch(error => log(`key_check_failed error=${error.message}`));
      });
    },
    // Delivers to the project's live session; false when none is connected.
    deliver(project, event) {
      const connection = sessions.get(project);
      if (!connection) return false;
      send(connection.socket, { type: "event", ...event });
      return true;
    },
    close() {
      keysWatcher?.close();
      for (const connection of sessions.values()) connection.socket.destroy();
      server.close();
    },
  };
}

module.exports = { PROTOCOL_VERSION, createRouterServer };
