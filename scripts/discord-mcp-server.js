#!/usr/bin/env node

const { createInterface } = require("readline");
const path = require("path");
const { writeFile, mkdir, stat } = require("fs/promises");
const { createReadStream } = require("fs");

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;

if (!BOT_TOKEN || !CHANNEL_ID) {
  process.stderr.write("Missing BOT_TOKEN or CHANNEL_ID\n");
  process.exit(1);
}

const API_BASE = "https://discord.com/api/v10";

function sendResponse(msg) {
  const json = JSON.stringify(msg);
  process.stdout.write(json + "\n");
}

function makeError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

async function discordGet(endpoint) {
  const res = await fetch(`${API_BASE}${endpoint}`, {
    headers: { Authorization: `Bot ${BOT_TOKEN}` },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Discord API ${res.status}: ${text}`);
  }
  return res.json();
}

async function discordPost(endpoint, body) {
  const res = await fetch(`${API_BASE}${endpoint}`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${BOT_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Discord API ${res.status}: ${text}`);
  }
  return res.json();
}

async function discordPatch(endpoint, body) {
  const res = await fetch(`${API_BASE}${endpoint}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bot ${BOT_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Discord API ${res.status}: ${text}`);
  }
  return res.json();
}

async function discordPut(endpoint) {
  const res = await fetch(`${API_BASE}${endpoint}`, {
    method: "PUT",
    headers: { Authorization: `Bot ${BOT_TOKEN}` },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Discord API ${res.status}: ${text}`);
  }
  return res.status === 204 ? {} : res.json();
}

async function sendMessageWithFiles(channelId, content, files, replyTo) {
  for (const f of files) {
    await stat(f);
  }

  const FormData = (await import("form-data")).default;
  const form = new FormData();

  const payload = { content: content || "" };
  if (replyTo) {
    payload.message_reference = { message_id: replyTo };
  }
  form.append("payload_json", JSON.stringify(payload));

  for (let i = 0; i < files.length; i++) {
    const filePath = files[i];
    const filename = path.basename(filePath);
    form.append(`files[${i}]`, createReadStream(filePath), { filename });
  }

  const res = await new Promise((resolve, reject) => {
    form.submit(
      {
        protocol: "https:",
        host: "discord.com",
        path: `/api/v10/channels/${channelId}/messages`,
        method: "POST",
        headers: { Authorization: `Bot ${BOT_TOKEN}` },
      },
      (err, response) => {
        if (err) return reject(err);
        let data = "";
        response.on("data", (chunk) => (data += chunk));
        response.on("end", () => {
          if (response.statusCode >= 400) {
            reject(new Error(`Discord API ${response.statusCode}: ${data}`));
          } else {
            resolve(JSON.parse(data));
          }
        });
      }
    );
  });
  return res;
}

const TOOLS = [
  {
    name: "reply",
    description:
      "Send a message to the Discord channel. Optionally attach files and/or reply to a specific message.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Message text to send" },
        files: {
          type: "array",
          items: { type: "string" },
          description:
            "Absolute file paths to attach (images, logs, etc). Max 10 files, 25MB each.",
        },
        reply_to: {
          type: "string",
          description: "Message ID to thread under (for quote-replies).",
        },
      },
      required: ["text"],
    },
  },
  {
    name: "edit_message",
    description: "Edit a previously sent message by ID.",
    inputSchema: {
      type: "object",
      properties: {
        message_id: { type: "string", description: "ID of the message to edit" },
        text: { type: "string", description: "New message content" },
      },
      required: ["message_id", "text"],
    },
  },
  {
    name: "react",
    description: "Add an emoji reaction to a message.",
    inputSchema: {
      type: "object",
      properties: {
        message_id: { type: "string", description: "ID of the message to react to" },
        emoji: { type: "string", description: "Emoji to react with (e.g. '👍' or 'custom_name:123456')" },
      },
      required: ["message_id", "emoji"],
    },
  },
  {
    name: "fetch_messages",
    description:
      "Fetch recent messages from the Discord channel. Returns oldest-first with message IDs.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "Max messages to fetch (default 20, max 100).",
        },
      },
    },
  },
  {
    name: "download_attachment",
    description:
      "Download an attachment from a Discord message to a local file. Returns the local file path.",
    inputSchema: {
      type: "object",
      properties: {
        message_id: {
          type: "string",
          description: "ID of the message containing the attachment",
        },
        attachment_index: {
          type: "number",
          description: "Index of the attachment (0-based, default 0)",
        },
        save_dir: {
          type: "string",
          description: "Directory to save the file to (default: current working directory)",
        },
      },
      required: ["message_id"],
    },
  },
];

async function handleToolCall(name, args) {
  switch (name) {
    case "reply": {
      const { text, files, reply_to } = args;
      let result;
      if (files && files.length > 0) {
        result = await sendMessageWithFiles(CHANNEL_ID, text, files, reply_to);
      } else {
        const body = { content: text || "" };
        if (reply_to) {
          body.message_reference = { message_id: reply_to };
        }
        result = await discordPost(`/channels/${CHANNEL_ID}/messages`, body);
      }
      return `sent (id: ${result.id})`;
    }

    case "edit_message": {
      const { message_id, text } = args;
      await discordPatch(`/channels/${CHANNEL_ID}/messages/${message_id}`, {
        content: text,
      });
      return `edited (id: ${message_id})`;
    }

    case "react": {
      const { message_id, emoji } = args;
      const encoded = encodeURIComponent(emoji);
      await discordPut(
        `/channels/${CHANNEL_ID}/messages/${message_id}/reactions/${encoded}/@me`
      );
      return `reacted with ${emoji}`;
    }

    case "fetch_messages": {
      const limit = Math.min(args.limit || 20, 100);
      const messages = await discordGet(
        `/channels/${CHANNEL_ID}/messages?limit=${limit}`
      );
      messages.reverse();
      const formatted = messages.map((m) => {
        const ts = m.timestamp;
        const author = m.author.bot ? "me" : m.author.username;
        const attachments = m.attachments.length
          ? ` +${m.attachments.length}att`
          : "";
        return `[${ts}] ${author}: ${m.content}${attachments} (id: ${m.id})`;
      });
      return formatted.join("\n");
    }

    case "download_attachment": {
      const { message_id, attachment_index = 0, save_dir } = args;
      const msg = await discordGet(
        `/channels/${CHANNEL_ID}/messages/${message_id}`
      );
      if (!msg.attachments || msg.attachments.length === 0) {
        throw new Error("Message has no attachments");
      }
      if (attachment_index >= msg.attachments.length) {
        throw new Error(
          `Attachment index ${attachment_index} out of range (message has ${msg.attachments.length})`
        );
      }
      const att = msg.attachments[attachment_index];
      const dir = save_dir || process.cwd();
      await mkdir(dir, { recursive: true });
      const filePath = path.join(dir, att.filename);
      const res = await fetch(att.url);
      if (!res.ok) throw new Error(`Failed to download: ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      await writeFile(filePath, buf);
      return filePath;
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function handleMessage(msg) {
  if (!msg.method) {
    return;
  }

  switch (msg.method) {
    case "initialize":
      sendResponse({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "discord-mcp", version: "1.0.0" },
        },
      });
      break;

    case "notifications/initialized":
      break;

    case "tools/list":
      sendResponse({
        jsonrpc: "2.0",
        id: msg.id,
        result: { tools: TOOLS },
      });
      break;

    case "tools/call":
      handleToolCall(msg.params.name, msg.params.arguments || {})
        .then((result) => {
          sendResponse({
            jsonrpc: "2.0",
            id: msg.id,
            result: {
              content: [{ type: "text", text: String(result) }],
            },
          });
        })
        .catch((err) => {
          sendResponse({
            jsonrpc: "2.0",
            id: msg.id,
            result: {
              content: [{ type: "text", text: `Error: ${err.message}` }],
              isError: true,
            },
          });
        });
      break;

    default:
      if (msg.id) {
        sendResponse(makeError(msg.id, -32601, `Method not found: ${msg.method}`));
      }
  }
}

const rl = createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  try {
    const msg = JSON.parse(line);
    handleMessage(msg);
  } catch (err) {
    process.stderr.write(`Parse error: ${err.message}\n`);
  }
});

process.stderr.write("Discord MCP server started\n");
