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
//
// Router `command` events run here, never as a Claude turn: /compact and
// /clear are typed into this session's own tmux pane through
// send-claude-command.sh, /pause queues inbound events until /unpause, and
// /restart relaunches this project (never root) through stop-session.sh and
// start-session.sh.
const { execFile, spawn } = require("node:child_process");
const { readFileSync, renameSync, writeFileSync } = require("node:fs");
const { chmod, mkdir, writeFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createInterface } = require("node:readline");
const { RouterClient } = require("./router/client.js");

const ROOT_DIR = path.dirname(__dirname);
const PROTOCOL_VERSION = "2025-03-26";
const INSTRUCTIONS = [
  "The sender reads Discord, not this session. Anything you want them to see must go through the reply tool — your transcript output never reaches their chat.",
  "",
  'Messages from Discord arrive as <channel source="ccdm" chat_id="..." message_id="..." user="..." ts="...">. If the tag has attachment_count, the attachments attribute lists name/type/size — call download_attachment(chat_id, message_id) to fetch them. Reply with the reply tool — pass chat_id back. Use reply_to (set to a message_id) only when replying to an earlier message; the latest message doesn\'t need a quote-reply, omit reply_to for normal responses.',
  "",
  "Use react to add emoji reactions, and edit_message for interim progress updates. Edits don't trigger push notifications — when a long task completes, send a new reply so the user's device pings.",
  "",
  "fetch_messages pulls recent channel history; read_last_x_messages_in_channel reads up to 10,000 recent messages and export_message_range exports an inclusive range to a file. This session can read and act only in its own project channel.",
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

// The Router's hello scope: this session's one channel.
let scope = {};

const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

// Attachment names are uploader-controlled; strip the delimiters that would
// let one break out of the listing, as the Discord plugin does.
function safeName(attachment) {
  return (attachment.name ?? attachment.id).replace(/[\[\]\r\n;]/g, "_");
}

function sizeKb(attachment) {
  return (attachment.size / 1024).toFixed(0);
}

// The session's private inbox: `<state>/inbox/<project>` (0700), files 0600,
// named `<epoch ms>-<attachment id>.<ext>` like the plugin's inbox.
async function saveAttachment(attachment) {
  if (attachment.size > MAX_ATTACHMENT_BYTES) {
    throw new Error(`attachment too large: ${(attachment.size / 1024 / 1024).toFixed(1)}MB, max ${MAX_ATTACHMENT_BYTES / 1024 / 1024}MB`);
  }
  const response = await fetch(attachment.url);
  if (!response.ok) throw new Error(`download failed: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const name = attachment.name ?? attachment.id;
  const ext = (name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "bin").replace(/[^a-zA-Z0-9]/g, "") || "bin";
  const inbox = path.join(process.env.CCDM_ROUTER_STATE_DIR || "", "inbox", process.env.CCDM_CLAUDE_PROJECT || "");
  await mkdir(inbox, { recursive: true, mode: 0o700 });
  await chmod(inbox, 0o700);
  const file = path.join(inbox, `${Date.now()}-${attachment.id}.${ext}`);
  await writeFile(file, bytes, { mode: 0o600 });
  return file;
}

// The Router resolves one attachment per call; ask by index until it has none.
async function downloadAttachments(router, { chat_id, message_id }) {
  const lines = [];
  for (let index = 0; ; index++) {
    let attachment;
    try {
      attachment = await router.request("download_attachment", { channel_id: chat_id, message_id, attachment_index: index });
    } catch (error) {
      if (error.code === "not_found") break;
      throw error;
    }
    const file = await saveAttachment(attachment);
    lines.push(`  ${file}  (${safeName(attachment)}, ${attachment.content_type ?? "unknown"}, ${sizeKb(attachment)}KB)`);
  }
  if (lines.length === 0) return "message has no attachments";
  return `downloaded ${lines.length} attachment(s):\n${lines.join("\n")}`;
}

// Each tool forwards to one Router operation; `args` maps tool input to op
// args. A tool with `run` does its own work instead.
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
    format: result => `edited (id: ${result.message_id})`,
  },
  fetch_messages: {
    description: "Fetch recent messages from this session's Discord channel, oldest first with message IDs.",
    properties: { channel: { type: "string" }, limit: { type: "number", description: "Max messages (default 20, Discord caps at 100)." } },
    required: ["channel"],
    op: "fetch_messages",
    args: ({ channel, limit }) => ({ channel_id: channel, limit }),
    format: result => result.text || "(no messages)",
  },
  // The read tools keep the supplementary Discord MCP's arguments and results;
  // they always read this session's channel.
  read_last_x_messages_in_channel: {
    description: "Read the last X messages in the Discord channel, oldest-first with message IDs. Reads up to 100 inline; larger reads return a temporary transcript path.",
    properties: { count: { type: "number", description: "Number of recent messages to read (1-10,000)." } },
    required: ["count"],
    op: "read_last_x_messages_in_channel",
    args: ({ count }) => ({ channel_id: scope.channel_id, count }),
    format: result => result.path ? `saved ${result.count} messages to ${result.path}` : result.text,
  },
  export_message_range: {
    description: "Export up to 10,000 Discord messages and their attachments to a temporary transcript. The range is inclusive; omit the end ID to continue through the latest message. Read the returned file, then delete its temporary directory.",
    properties: {
      start_message_id: { type: "string", description: "First message ID to export (inclusive)." },
      end_message_id: { type: "string", description: "Last message ID to export (inclusive). Omit to export through the latest message." },
    },
    required: ["start_message_id"],
    op: "export_message_range",
    args: ({ start_message_id, end_message_id }) => ({ channel_id: scope.channel_id, start_message_id, end_message_id }),
    format: result => `exported to ${result.path}`,
  },
  download_attachment: {
    description: "Download attachments from a Discord message in this channel to the local inbox. Use when the inbound <channel> meta shows attachment_count. Returns file paths ready to Read.",
    properties: { chat_id: { type: "string" }, message_id: { type: "string" } },
    required: ["chat_id", "message_id"],
    run: downloadAttachments,
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
  const listed = attachments.map(item => `${safeName(item)} (${item.content_type || "unknown"}, ${sizeKb(item)}KB)`);
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

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function relayClaudeCommand(project, command) {
  return new Promise((resolve, reject) => {
    execFile(path.join(ROOT_DIR, "scripts", "send-claude-command.sh"), ["--project", project, command], (error, stdout, stderr) => {
      if (error) reject(new Error(stderr.trim() || error.message));
      else resolve(stdout);
    });
  });
}

// Stopping the session kills this process tree, so the restart runs in a
// backgrounded subshell that the launching shell leaves behind.
function scheduleRestart(project) {
  const logPath = path.join(os.tmpdir(), `ccdm-restart-${project.replace(/[^a-zA-Z0-9._-]/g, "_")}.log`);
  const steps = [
    `cd ${shellQuote(ROOT_DIR)}`,
    `./scripts/stop-session.sh ${shellQuote(project)}`,
    `./scripts/start-session.sh ${shellQuote(project)}`,
  ].join(" && ");
  const child = spawn("/bin/sh", ["-c", `(${steps}) >> ${shellQuote(logPath)} 2>&1 &`], { detached: true, env: process.env, stdio: "ignore" });
  child.unref();
  return logPath;
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
  const notify = (kind, event) => {
    // Like the plugin, show the bot typing while Claude takes the message in.
    if (kind === "message") router.request("typing", { channel_id: event.channel_id }).catch(() => {});
    const params = notification(kind, event);
    if (initialized) send({ method: "notifications/claude/channel", params });
    else queued.push(params);
  };
  // While paused, inbound events wait here and are delivered in order on /unpause.
  let paused = false;
  const pausedEvents = [];
  const deliver = kind => event => {
    if (paused) pausedEvents.push([kind, event]);
    else notify(kind, event);
  };
  router.on("message", deliver("message"));
  router.on("reaction", deliver("reaction"));

  // Commands run one at a time, in arrival order, and acknowledge like the
  // Codex bridge: a reaction on the command, then a short reply.
  const react = (event, emoji) => router.request("react", { channel_id: event.channel_id, message_id: event.message_id, emoji });
  const say = (event, text) => router.request("reply", { channel_id: event.channel_id, text, context_pct: contextPct() });
  const COMMANDS = {
    pause: async event => {
      paused = true;
      await react(event, "⏸️");
      await say(event, "Session paused. New messages will be queued.");
    },
    unpause: async event => {
      paused = false;
      for (const [kind, queuedEvent] of pausedEvents.splice(0)) notify(kind, queuedEvent);
      await react(event, "▶️");
      await say(event, "Session unpaused.");
    },
    compact: event => relayAcknowledged(event, "compact"),
    clear: event => relayAcknowledged(event, "clear"),
    restart: async event => {
      await react(event, "🔄");
      await say(event, "Restarting session — fresh session coming up.");
      const logPath = scheduleRestart(project);
      process.stderr.write(`ccdm channel: restart scheduled for '${project}'; log: ${logPath}\n`);
    },
  };
  async function relayAcknowledged(event, name) {
    await react(event, "🔄");
    try {
      await relayClaudeCommand(project, name);
    } catch (error) {
      return say(event, `**Error:** Failed to ${name} — ${error.message}`);
    }
    await say(event, `Sent /${name} to Claude.`);
  }
  let commands = Promise.resolve();
  router.on("command", event => {
    const run = Object.hasOwn(COMMANDS, event.command) ? COMMANDS[event.command] : null;
    if (!run) return;
    commands = commands.then(() => run(event)).catch(error => {
      process.stderr.write(`ccdm channel: /${event.command} failed: ${error.code || error.message}\n`);
    });
  });
  router.on("disconnect", () => process.stderr.write("ccdm channel: Router connection lost; reconnecting\n"));
  router.on("reconnect", () => process.stderr.write("ccdm channel: Router connection restored\n"));
  router.on("end", error => process.stderr.write(`ccdm channel: Router session ended${error ? `: ${error.code || error.message}` : ""}\n`));

  router.connect().then(
    granted => {
      scope = granted;
      reportReady({ ok: true, scope: granted });
    },
    error => {
      reportReady({ ok: false, error: error.code || error.message });
      process.stderr.write(`ccdm channel: Router hello failed: ${error.code || error.message}\n`);
    },
  );

  async function callTool(id, name, input = {}) {
    const tool = Object.hasOwn(TOOLS, name) ? TOOLS[name] : null;
    if (!tool) return send({ id, error: { code: -32602, message: `unknown tool: ${name}` } });
    try {
      const text = tool.run ? await tool.run(router, input) : tool.format(await router.request(tool.op, tool.args(input)));
      send({ id, result: { content: [{ type: "text", text }] } });
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
