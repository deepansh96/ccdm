#!/usr/bin/env node
"use strict";

// CCDM channel server: the MCP stdio server a router-transport Claude session
// loads as `server:ccdm`. It speaks to the Router with the launch key (read
// from a private file, never passed as a secret), turns Router message and
// reaction events into channel notifications, and exposes Router operations
// as tools. It holds no Discord credential.
//
// Environment (written by start-session.sh):
//   CCDM_ROUTER_KEY_FILE      the launch key file (0600)
//   CCDM_ROUTER_STATE_DIR     the Router state directory (its socket lives there)
//   CCDM_CLAUDE_PROJECT       the project this session serves
//   CCDM_CHANNEL_READY_FILE   where the Router hello outcome is written for the launcher
//
// The statusline wrapper writes the latest context percentage to
// `<state>/launches/<project>/context.json`; reply and edit_message send it as
// `context_pct`, or omit it when the file is missing or unreadable.
const { readFileSync, renameSync, writeFileSync } = require("node:fs");
const path = require("node:path");
const { createInterface } = require("node:readline");
const { RouterClient } = require("./router/client.js");

const PROTOCOL_VERSION = "2025-03-26";
const INSTRUCTIONS = [
  "The sender reads Discord, not this session. Anything you want them to see must go through the reply tool — your transcript output never reaches their chat.",
  "",
  'Messages from Discord arrive as <channel source="ccdm" chat_id="..." message_id="..." user="..." ts="...">. If the tag has attachment_count, the attachments attribute lists name/type/size. Reply with the reply tool — pass chat_id back. Use reply_to (set to a message_id) only when replying to an earlier message; the latest message doesn\'t need a quote-reply, omit reply_to for normal responses.',
  "",
  "Use react to add emoji reactions, and edit_message for interim progress updates. Edits don't trigger push notifications — when a long task completes, send a new reply so the user's device pings.",
  "",
  "fetch_messages pulls recent channel history. This session can read and act only in its own project channel.",
].join("\n");

function contextPct() {
  const file = path.join(process.env.CCDM_ROUTER_STATE_DIR || "", "launches", process.env.CCDM_CLAUDE_PROJECT || "", "context.json");
  try {
    const pct = JSON.parse(readFileSync(file, "utf8")).context_pct;
    return Number.isFinite(pct) ? pct : undefined;
  } catch {
    return undefined;
  }
}

// Each tool forwards to one Router operation; `args` maps tool input to op args.
const TOOLS = {
  reply: {
    description: "Reply on Discord. Pass chat_id from the inbound message. Optionally pass reply_to (message_id) to link the message you are answering, and files (absolute paths) to attach.",
    properties: {
      chat_id: { type: "string" }, text: { type: "string" },
      reply_to: { type: "string", description: "Message ID to link to. Use message_id from the inbound <channel> block." },
      files: { type: "array", items: { type: "string" }, description: "Absolute file paths to attach. Max 10 files." },
    },
    required: ["chat_id", "text"],
    op: "reply",
    args: ({ chat_id, text, reply_to, files }) => ({ channel_id: chat_id, text, reply_to, files, context_pct: contextPct() }),
    format: result => result.message_ids.length > 1
      ? `sent ${result.message_ids.length} parts (ids: ${result.message_ids.join(", ")})`
      : `sent (id: ${result.message_id})`,
  },
  react: {
    description: "Add an emoji reaction to a Discord message in this channel.",
    properties: { chat_id: { type: "string" }, message_id: { type: "string" }, emoji: { type: "string" } },
    required: ["chat_id", "message_id", "emoji"],
    op: "react",
    args: ({ chat_id, message_id, emoji }) => ({ channel_id: chat_id, message_id, emoji }),
    format: () => "reacted",
  },
  edit_message: {
    description: "Edit a message this session previously sent. Edits don't trigger push notifications.",
    properties: { chat_id: { type: "string" }, message_id: { type: "string" }, text: { type: "string" } },
    required: ["chat_id", "message_id", "text"],
    op: "edit_message",
    args: ({ chat_id, message_id, text }) => ({ channel_id: chat_id, message_id, text, context_pct: contextPct() }),
    format: () => "edited",
  },
  fetch_messages: {
    description: "Fetch recent messages from this session's Discord channel, oldest first with message IDs.",
    properties: { channel: { type: "string" }, limit: { type: "number", description: "Max messages (default 20, Discord caps at 100)." } },
    required: ["channel"],
    op: "fetch_messages",
    args: ({ channel, limit }) => ({ channel_id: channel, limit }),
    format: result => JSON.stringify(result),
  },
};

function send(frame) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...frame })}\n`);
}

// The launcher waits on this file: the Router's hello outcome, written atomically.
function reportReady(outcome) {
  const file = process.env.CCDM_CHANNEL_READY_FILE;
  if (!file) return;
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(outcome)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

function attachmentMeta(attachments = []) {
  if (attachments.length === 0) return {};
  const listed = attachments.map(item => `${item.name} (${item.content_type || "unknown"}, ${(item.size / 1024).toFixed(0)}KB)`);
  return { attachment_count: String(attachments.length), attachments: listed.join("; ") };
}

function notification(kind, event) {
  if (kind === "message") {
    return {
      content: event.content || (event.attachments?.length ? "(attachment)" : ""),
      meta: {
        chat_id: event.channel_id, message_id: event.message_id, user: event.author.name, user_id: event.author.id,
        ts: event.ts, ...attachmentMeta(event.attachments),
      },
    };
  }
  return {
    content: `(reacted ${event.emoji})`,
    meta: {
      chat_id: event.channel_id, message_id: event.message_id, user: event.user.name, user_id: event.user.id,
      ts: event.ts, reaction: event.emoji,
    },
  };
}

function main() {
  const project = process.env.CCDM_CLAUDE_PROJECT;
  let key;
  try {
    key = readFileSync(process.env.CCDM_ROUTER_KEY_FILE, "utf8").trim();
  } catch (error) {
    reportReady({ ok: false, error: `launch key unavailable: ${error.code || error.message}` });
    process.stderr.write(`ccdm channel: launch key unavailable\n`);
    process.exit(1);
  }
  const router = new RouterClient({ project, key, role: "project" });

  // Channel notifications wait until Claude has finished initializing.
  let initialized = false;
  const queued = [];
  const notify = kind => event => {
    const params = notification(kind, event);
    if (initialized) send({ method: "notifications/claude/channel", params });
    else queued.push(params);
  };
  router.on("message", notify("message"));
  router.on("reaction", notify("reaction"));
  router.on("disconnect", () => process.stderr.write("ccdm channel: Router connection lost; reconnecting\n"));
  router.on("reconnect", () => process.stderr.write("ccdm channel: Router connection restored\n"));
  router.on("end", error => process.stderr.write(`ccdm channel: Router session ended${error ? `: ${error.code || error.message}` : ""}\n`));

  router.connect().then(
    scope => reportReady({ ok: true, scope }),
    error => {
      reportReady({ ok: false, error: error.code || error.message });
      process.stderr.write(`ccdm channel: Router hello failed: ${error.code || error.message}\n`);
    },
  );

  async function callTool(id, name, input = {}) {
    const tool = Object.hasOwn(TOOLS, name) ? TOOLS[name] : null;
    if (!tool) return send({ id, error: { code: -32602, message: `unknown tool: ${name}` } });
    try {
      const result = await router.request(tool.op, tool.args(input));
      send({ id, result: { content: [{ type: "text", text: tool.format(result) }] } });
    } catch (error) {
      send({ id, result: { isError: true, content: [{ type: "text", text: `${name} failed: ${error.code || ""} ${error.message}`.trim() }] } });
    }
  }

  const lines = createInterface({ input: process.stdin });
  lines.on("line", line => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return send({ id: null, error: { code: -32700, message: "parse error" } });
    }
    const { id, method, params } = message;
    if (method === "initialize") {
      return send({ id, result: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {}, experimental: { "claude/channel": {} } },
        serverInfo: { name: "ccdm", version: "1.0.0" },
        instructions: INSTRUCTIONS,
      } });
    }
    if (method === "notifications/initialized") {
      initialized = true;
      for (const params of queued.splice(0)) send({ method: "notifications/claude/channel", params });
      return;
    }
    if (method === "tools/list") {
      return send({ id, result: { tools: Object.entries(TOOLS).map(([name, tool]) => ({
        name, description: tool.description,
        inputSchema: { type: "object", properties: tool.properties, required: tool.required },
      })) } });
    }
    if (method === "tools/call") return void callTool(id, params?.name, params?.arguments);
    if (method === "ping") return send({ id, result: {} });
    if (id !== undefined) send({ id, error: { code: -32601, message: `method not found: ${method}` } });
  });
  // Claude closes stdin when the session ends: leave the Router with it.
  lines.on("close", () => {
    router.close();
    process.exit(0);
  });
}

main();
