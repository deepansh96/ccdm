#!/usr/bin/env node

const { createInterface } = require("readline");
const { execFile } = require("child_process");
const { createHmac, timingSafeEqual } = require("crypto");
const { promisify } = require("util");
const path = require("path");
const { writeFile, mkdir, mkdtemp, stat, readFile } = require("fs/promises");
const { createReadStream } = require("fs");
const { tmpdir } = require("os");

const execFileAsync = promisify(execFile);
const EXPORT_SCRIPT = path.resolve(__dirname, "export-discord-range.js");
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const DISCORD_REPLY_TOKEN = process.env.DISCORD_REPLY_TOKEN;
const EXPORT_ONLY = ["1", "true", "yes", "on"].includes(
  (process.env.DISCORD_MCP_EXPORT_ONLY || "").toLowerCase()
);
const DISCORD_CHANNEL_OVERRIDE = ["1", "true", "yes", "on"].includes(
  (process.env.DISCORD_CHANNEL_OVERRIDE || "").toLowerCase()
);
const DISCORD_ACCESS_FILE = process.env.DISCORD_ACCESS_FILE;
const DISCORD_CHANNEL_SCOPE_FILE = process.env.DISCORD_CHANNEL_SCOPE_FILE;
const DISCORD_CHANNEL_SCOPE_SECRET = process.env.DISCORD_CHANNEL_SCOPE_SECRET;
const DISCORD_GLOBAL_USER_IDS = new Set(
  (process.env.DISCORD_GLOBAL_USER_IDS || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
);

if ((!BOT_TOKEN && !EXPORT_ONLY) || !CHANNEL_ID) {
  process.stderr.write(`Missing ${EXPORT_ONLY ? "CHANNEL_ID" : "BOT_TOKEN or CHANNEL_ID"}\n`);
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

async function discordGet(endpoint, retryRateLimits = false) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(`${API_BASE}${endpoint}`, {
      headers: { Authorization: `Bot ${BOT_TOKEN}` },
    });
    if (res.ok) return res.json();

    const text = await res.text();
    if (!retryRateLimits || res.status !== 429 || attempt === 4) {
      throw new Error(`Discord API ${res.status}: ${text}`);
    }
    let retryAfter = 1;
    try {
      retryAfter = Number(JSON.parse(text).retry_after ?? retryAfter);
    } catch {
      // Discord normally returns JSON for rate limits; use a short fallback delay.
    }
    await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
  }
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

const scopeTokenProperty = {
  scope_token: {
    type: "string",
    description: "Required bridge scope token from the current top-level Discord instructions.",
  },
};
const channelIdProperty = {
  channel_id: {
    type: "string",
    description: "Target Discord channel ID. Required when this MCP server is in root multi-channel mode.",
  },
};
const channelScopeProperty = {
  channel_scope_token: {
    type: "string",
    description: "Signed capability from the incoming Discord routing metadata.",
  },
};

function withScopeToken(properties) {
  return DISCORD_REPLY_TOKEN ? { ...properties, ...scopeTokenProperty } : properties;
}

function withChannelOverride(properties) {
  return DISCORD_CHANNEL_OVERRIDE
    ? { ...properties, ...channelIdProperty, ...channelScopeProperty }
    : properties;
}

function requiredWithScope(fields) {
  return DISCORD_REPLY_TOKEN ? [...fields, "scope_token"] : fields;
}

function requiredWithChannel(fields) {
  return DISCORD_CHANNEL_OVERRIDE
    ? [...fields, "channel_id", "channel_scope_token"]
    : fields;
}

function requireScopeToken(scopeToken) {
  if (DISCORD_REPLY_TOKEN && scopeToken !== DISCORD_REPLY_TOKEN) {
    throw new Error("Discord write denied: missing or invalid scope token");
  }
}

async function targetChannelId(args) {
  if (!DISCORD_CHANNEL_OVERRIDE) return CHANNEL_ID;
  if (!args.channel_id) {
    throw new Error("channel_id is required in root multi-channel mode");
  }
  if (!DISCORD_ACCESS_FILE) {
    throw new Error("Discord access file is required in root multi-channel mode");
  }
  if (!DISCORD_CHANNEL_SCOPE_FILE || !DISCORD_CHANNEL_SCOPE_SECRET) {
    throw new Error("Discord channel scope is required in root multi-channel mode");
  }
  const activeToken = (await readFile(DISCORD_CHANNEL_SCOPE_FILE, "utf8")).trim();
  if (!args.channel_scope_token || args.channel_scope_token !== activeToken) {
    throw new Error("Discord channel scope is missing, expired, or invalid");
  }
  const [encoded, signature, extra] = args.channel_scope_token.split(".");
  if (!encoded || !signature || extra) {
    throw new Error("Discord channel scope is missing, expired, or invalid");
  }
  const expected = Buffer.from(
    createHmac("sha256", DISCORD_CHANNEL_SCOPE_SECRET).update(encoded).digest("base64url")
  );
  const received = Buffer.from(signature);
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
    throw new Error("Discord channel scope is missing, expired, or invalid");
  }
  let scope;
  try {
    scope = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw new Error("Discord channel scope is missing, expired, or invalid");
  }
  const access = JSON.parse(await readFile(DISCORD_ACCESS_FILE, "utf8"));
  if (!Object.hasOwn(access.groups || {}, args.channel_id)) {
    throw new Error(`Discord channel ${args.channel_id} is not allowed`);
  }
  const globalUsers = new Set([
    ...DISCORD_GLOBAL_USER_IDS,
    ...(access.allowFrom || []).map(String),
  ]);
  if (!globalUsers.has(String(scope.author_id))) {
    const sourceConfig = access.groups?.[scope.channel_id];
    const sourceUsers = new Set((sourceConfig?.allowFrom || []).map(String));
    if (!sourceUsers.has(String(scope.author_id)) || args.channel_id !== scope.channel_id) {
      throw new Error(`Discord channel ${args.channel_id} is not allowed for this message`);
    }
  }
  return args.channel_id;
}

const replyProperties = {
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
};

const ALL_TOOLS = [
  {
    name: "reply",
    description:
      "Send a message to the Discord channel. Optionally attach files and/or reply to a specific message.",
    inputSchema: {
      type: "object",
      properties: withScopeToken(withChannelOverride(replyProperties)),
      required: requiredWithScope(requiredWithChannel(["text"])),
    },
  },
  {
    name: "edit_message",
    description: "Edit a previously sent message by ID.",
    inputSchema: {
      type: "object",
      properties: withScopeToken(withChannelOverride({
        message_id: { type: "string", description: "ID of the message to edit" },
        text: { type: "string", description: "New message content" },
      })),
      required: requiredWithScope(requiredWithChannel(["message_id", "text"])),
    },
  },
  {
    name: "react",
    description: "Add an emoji reaction to a message.",
    inputSchema: {
      type: "object",
      properties: withScopeToken(withChannelOverride({
        message_id: { type: "string", description: "ID of the message to react to" },
        emoji: { type: "string", description: "Emoji to react with (e.g. '👍' or 'custom_name:123456')" },
      })),
      required: requiredWithScope(requiredWithChannel(["message_id", "emoji"])),
    },
  },
  {
    name: "fetch_messages",
    description:
      "Fetch recent messages from the Discord channel. Returns oldest-first with message IDs.",
    inputSchema: {
      type: "object",
      properties: withChannelOverride({
        limit: {
          type: "number",
          description: "Max messages to fetch (default 20, max 100).",
        },
      }),
      required: requiredWithChannel([]),
    },
  },
  {
    name: "read_last_x_messages_in_channel",
    description:
      "Read the last X messages in the Discord channel, oldest-first with message IDs. Reads up to 100 inline; larger reads return a temporary transcript path.",
    inputSchema: {
      type: "object",
      properties: withChannelOverride({
        count: {
          type: "number",
          description: "Number of recent messages to read (1-10,000).",
        },
      }),
      required: requiredWithChannel(["count"]),
    },
  },
  {
    name: "export_message_range",
    description:
      "Export up to 10,000 Discord messages and their attachments to a temporary transcript. The range is inclusive; omit the end ID to continue through the latest message. Read the returned file, then delete its temporary directory.",
    inputSchema: {
      type: "object",
      properties: withChannelOverride({
        start_message_id: {
          type: "string",
          description: "First message ID to export (inclusive).",
        },
        end_message_id: {
          type: "string",
          description: "Last message ID to export (inclusive). Omit to export through the latest message.",
        },
      }),
      required: requiredWithChannel(["start_message_id"]),
    },
  },
  {
    name: "download_attachment",
    description:
      "Download an attachment from a Discord message to a local file. Returns the local file path.",
    inputSchema: {
      type: "object",
      properties: withChannelOverride({
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
      }),
      required: requiredWithChannel(["message_id"]),
    },
  },
];
const TOOLS = EXPORT_ONLY
  ? ALL_TOOLS.filter((tool) => tool.name === "export_message_range")
  : ALL_TOOLS;

async function handleToolCall(name, args) {
  if (EXPORT_ONLY && name !== "export_message_range") {
    throw new Error(`Tool unavailable in export-only mode: ${name}`);
  }

  switch (name) {
    case "reply": {
      const { text, files, reply_to, scope_token } = args;
      requireScopeToken(scope_token);
      const channelId = await targetChannelId(args);
      let result;
      if (files && files.length > 0) {
        result = await sendMessageWithFiles(channelId, text, files, reply_to);
      } else {
        const body = { content: text || "" };
        if (reply_to) {
          body.message_reference = { message_id: reply_to };
        }
        result = await discordPost(`/channels/${channelId}/messages`, body);
      }
      return `sent (id: ${result.id})`;
    }

    case "edit_message": {
      const { message_id, text, scope_token } = args;
      requireScopeToken(scope_token);
      const channelId = await targetChannelId(args);
      await discordPatch(`/channels/${channelId}/messages/${message_id}`, {
        content: text,
      });
      return `edited (id: ${message_id})`;
    }

    case "react": {
      const { message_id, emoji, scope_token } = args;
      requireScopeToken(scope_token);
      const channelId = await targetChannelId(args);
      const encoded = encodeURIComponent(emoji);
      await discordPut(
        `/channels/${channelId}/messages/${message_id}/reactions/${encoded}/@me`
      );
      return `reacted with ${emoji}`;
    }

    case "fetch_messages":
    case "read_last_x_messages_in_channel": {
      const channelId = await targetChannelId(args);
      const limit = name === "read_last_x_messages_in_channel"
        ? args.count
        : Math.min(args.limit || 20, 100);
      if (
        name === "read_last_x_messages_in_channel"
        && (!Number.isInteger(limit) || limit < 1 || limit > 10000)
      ) {
        throw new Error("count must be an integer between 1 and 10,000");
      }
      let messages;
      if (name === "read_last_x_messages_in_channel") {
        messages = [];
        let before;
        // ponytail: 10,000-message cap matches export; raise only if MCP payload limits prove safe.
        while (messages.length < limit) {
          const pageLimit = Math.min(limit - messages.length, 100);
          const page = await discordGet(
            `/channels/${channelId}/messages?limit=${pageLimit}${before ? `&before=${before}` : ""}`,
            true
          );
          messages.push(...page);
          if (page.length < pageLimit) break;
          before = page.at(-1).id;
        }
      } else {
        messages = await discordGet(
          `/channels/${channelId}/messages?limit=${limit}`
        );
      }
      messages.reverse();
      const formatted = messages.map((m) => {
        const ts = m.timestamp;
        const author = m.author.bot ? "me" : m.author.username;
        const attachments = m.attachments.length
          ? ` +${m.attachments.length}att`
          : "";
        return `[${ts}] ${author}: ${m.content}${attachments} (id: ${m.id})`;
      });
      const output = formatted.join("\n");
      if (name === "read_last_x_messages_in_channel" && limit > 100) {
        const directory = await mkdtemp(path.join(tmpdir(), "discord-recent-"));
        const transcript = path.join(directory, "messages.txt");
        await writeFile(transcript, `${output}\n`, { mode: 0o600 });
        return `saved ${messages.length} messages to ${transcript}`;
      }
      return output;
    }

    case "export_message_range": {
      const channelId = await targetChannelId(args);
      const scriptArgs = [
        EXPORT_SCRIPT,
        channelId,
        args.start_message_id,
        ...(args.end_message_id ? [args.end_message_id] : []),
      ];
      try {
        const { stdout } = await execFileAsync(process.execPath, scriptArgs, {
          env: process.env,
        });
        return `exported to ${stdout.trim()}`;
      } catch (error) {
        throw new Error((error.stderr || error.message).trim());
      }
    }

    case "download_attachment": {
      const { message_id, attachment_index = 0, save_dir } = args;
      const channelId = await targetChannelId(args);
      const msg = await discordGet(
        `/channels/${channelId}/messages/${message_id}`
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
