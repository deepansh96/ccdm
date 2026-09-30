#!/usr/bin/env node

const { createInterface } = require("readline");
const { createHmac, timingSafeEqual } = require("crypto");
const path = require("path");
const { writeFile, mkdir, readFile } = require("fs/promises");
const reminderAdapter = require("./conversation-reminder-adapter.js");
const { RouterClient } = require("./router/client.js");
const { stateDir } = require("./router/paths.js");

const CHANNEL_ID = process.env.CHANNEL_ID;
const DISCORD_REPLY_TOKEN = process.env.DISCORD_REPLY_TOKEN;
const DISCORD_CHANNEL_OVERRIDE = ["1", "true", "yes", "on"].includes(
  (process.env.DISCORD_CHANNEL_OVERRIDE || "").toLowerCase()
);
const DISCORD_CHANNEL_SCOPE_FILE = process.env.DISCORD_CHANNEL_SCOPE_FILE;
const DISCORD_CHANNEL_SCOPE_SECRET = process.env.DISCORD_CHANNEL_SCOPE_SECRET;
const DISCORD_GLOBAL_USER_IDS = new Set(
  (process.env.DISCORD_GLOBAL_USER_IDS || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
);
// Every Codex session's tools are Router operations in
// this project's channel, reached with the launch key file. No Discord token
// is configured. For root Codex (`CCDM_ROUTER_ROLE=root`)
// they act as root in the channel each call names; the Router enforces root's
// channel scope, and the turn's channel grant still applies.
const ROUTER_KEY_FILE = process.env.CCDM_ROUTER_KEY_FILE;
const ROUTER_ROOT = Boolean(ROUTER_KEY_FILE) && process.env.CCDM_ROUTER_ROLE === "root";
const ROUTER_PROJECT = process.env.CCDM_CODEX_PROJECT;

if (!ROUTER_KEY_FILE || !CHANNEL_ID || (!ROUTER_ROOT && !ROUTER_PROJECT)) {
  process.stderr.write(`Missing ${ROUTER_KEY_FILE ? "CCDM_CODEX_PROJECT or CHANNEL_ID" : "CCDM_ROUTER_KEY_FILE or CHANNEL_ID"}\n`);
  process.exit(1);
}

function sendResponse(msg) {
  const json = JSON.stringify(msg);
  process.stdout.write(json + "\n");
}

function makeError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
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

// A project's tools act in the channel the Router currently grants it, which
// follows a registry channel move (the client adopts the Router's
// `scope_changed`); the launch channel stands in only while the Router is
// unreachable, where the request fails anyway.
async function projectChannelId() {
  try {
    return (await routerClient()).scope?.channel_id || CHANNEL_ID;
  } catch {
    return CHANNEL_ID;
  }
}

async function targetChannelId(args) {
  if (!DISCORD_CHANNEL_OVERRIDE) return projectChannelId();
  if (!args.channel_id) {
    throw new Error("channel_id is required in root multi-channel mode");
  }
  if (!ROUTER_ROOT) {
    throw new Error("Root multi-channel mode needs the Router root role");
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
  if (!DISCORD_GLOBAL_USER_IDS.has(String(scope.author_id)) && args.channel_id !== scope.channel_id) {
    throw new Error(`Discord channel ${args.channel_id} is not allowed for this message`);
  }
  return args.channel_id;
}

const replyProperties = {
  text: { type: "string", description: "Message text to send" },
  conversation_disposition: {
    type: "string",
    enum: ["progress", "input-needed"],
    description: "Conversation reply disposition. Defaults to progress; use input-needed only for a delivered question that asks the owner to respond.",
  },
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

// One op-only Router connection (`listener: false`), so the bridge keeps its
// place as the project's listener. A failed or ended connection is retried on
// the next tool call.
let routerConnection = null;

function routerClient() {
  if (!routerConnection) {
    routerConnection = (async () => {
      const key = (await readFile(ROUTER_KEY_FILE, "utf8")).trim();
      const client = ROUTER_ROOT
        ? new RouterClient({ key, role: "root", listener: false })
        : new RouterClient({ project: ROUTER_PROJECT, key, role: "project", listener: false });
      client.on("end", () => {
        routerConnection = null;
      });
      await client.connect();
      return client;
    })().catch((error) => {
      routerConnection = null;
      throw error;
    });
  }
  return routerConnection;
}

// Root Codex's bridge records an engaged emergency fallback in root's launch
// directory. While the Router is down and that bridge is live, root's reply,
// react, and edit_message go straight to Discord as the bot, in root channels
// only (router/emergency.js); the scope token and channel grant still apply.
async function emergencyRequest(op, channelId, args) {
  if (!ROUTER_ROOT) return null;
  const { directRequester, emergencyEngaged } = require("./router/emergency.js");
  if (!emergencyEngaged(path.join(stateDir(), "launches", ".root", "emergency.json"))) return null;
  try {
    return { result: await (await directRequester())(op, { channel_id: channelId, ...args }) };
  } catch (error) {
    throw new Error(`Emergency ${op} failed: ${error.code || error.message}`);
  }
}

async function routerRequest(op, channelId, args) {
  try {
    const client = await routerClient();
    return await client.request(op, { channel_id: channelId, ...args });
  } catch (error) {
    const direct = error.code === "router_unavailable" ? await emergencyRequest(op, channelId, args) : null;
    if (direct) return direct.result;
    throw new Error(`Router ${op} failed: ${error.code || error.message}`);
  }
}

// The bridge records its latest context percentage in the launch directory.
// Root posts as the bot, which carries none.
async function routerContextPct() {
  if (ROUTER_ROOT) return undefined;
  const file = path.join(process.env.CCDM_ROUTER_STATE_DIR || "", "launches", ROUTER_PROJECT, "context.json");
  try {
    const pct = JSON.parse(await readFile(file, "utf8")).context_pct;
    return Number.isFinite(pct) ? pct : undefined;
  } catch {
    return undefined;
  }
}

async function handleToolCall(name, args) {
  const channelId = await targetChannelId(args);
  switch (name) {
    case "reply": {
      const { text, files, reply_to, scope_token, conversation_disposition } = args;
      requireScopeToken(scope_token);
      if (conversation_disposition && !["progress", "input-needed"].includes(conversation_disposition)) {
        throw new Error("Unsupported conversation disposition");
      }
      const reminderContext = await reminderAdapter.readActiveContext(channelId);
      const result = await routerRequest("reply", channelId, {
        text: text || "", files, reply_to, context_pct: await routerContextPct(),
      });
      if (reminderContext) {
        for (const id of result.message_ids) {
          await reminderAdapter.recordDeliveredReply(reminderContext, id, conversation_disposition)
            .catch((error) => {
              process.stderr.write(`Discord MCP: reply ${id} was delivered but its Conversation Reminder receipt was not recorded: ${error.message}\n`);
            });
        }
      }
      return result.message_ids.length > 1
        ? `sent ${result.message_ids.length} parts (ids: ${result.message_ids.join(", ")})`
        : `sent (id: ${result.message_id})`;
    }

    case "edit_message": {
      const { message_id, text, scope_token } = args;
      requireScopeToken(scope_token);
      await routerRequest("edit_message", channelId, { message_id, text, context_pct: await routerContextPct() });
      return `edited (id: ${message_id})`;
    }

    case "react": {
      const { message_id, emoji, scope_token } = args;
      requireScopeToken(scope_token);
      await routerRequest("react", channelId, { message_id, emoji });
      return `reacted with ${emoji}`;
    }

    case "fetch_messages": {
      const result = await routerRequest("fetch_messages", channelId, { limit: Math.min(args.limit || 20, 100) });
      return result.text;
    }

    case "read_last_x_messages_in_channel": {
      const result = await routerRequest("read_last_x_messages_in_channel", channelId, { count: args.count });
      return result.path ? `saved ${result.count} messages to ${result.path}` : result.text;
    }

    case "export_message_range": {
      const result = await routerRequest("export_message_range", channelId, {
        start_message_id: args.start_message_id,
        ...(args.end_message_id ? { end_message_id: args.end_message_id } : {}),
      });
      return `exported to ${result.path}`;
    }

    case "download_attachment": {
      const { message_id, attachment_index = 0, save_dir } = args;
      const att = await routerRequest("download_attachment", channelId, { message_id, attachment_index });
      const dir = save_dir || process.cwd();
      await mkdir(dir, { recursive: true });
      const filePath = path.join(dir, path.basename(att.name || att.id));
      const res = await fetch(att.url);
      if (!res.ok) throw new Error(`Failed to download: ${res.status}`);
      await writeFile(filePath, Buffer.from(await res.arrayBuffer()));
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
        result: { tools: ALL_TOOLS },
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

// Codex closes stdin when it stops this server; the Router connection must not
// keep the process alive.
rl.on("close", () => {
  process.exit(0);
});

process.stderr.write("Discord MCP server started\n");
