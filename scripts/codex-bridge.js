#!/usr/bin/env node

const { Client, GatewayIntentBits, Partials } = require("discord.js");
const { spawn } = require("child_process");
const { writeFile, mkdir } = require("fs/promises");
const path = require("path");
const WebSocket = require("ws");

const MCP_SERVER_SCRIPT = path.resolve(__dirname, "discord-mcp-server.js");

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const PROJECT_DIR = process.env.PROJECT_DIR;
const WS_PORT = parseInt(process.env.WS_PORT || "18300", 10);
const ALLOWED_USER_ID = process.env.ALLOWED_USER_ID;
const GUILD_ID = process.env.GUILD_ID;
const ROOT_BOT_TOKEN = process.env.ROOT_BOT_TOKEN;
const BOT_APP_ID = process.env.BOT_APP_ID;
const BOT_DISPLAY_NAME = process.env.BOT_DISPLAY_NAME || "codex";

if (!BOT_TOKEN || !CHANNEL_ID || !PROJECT_DIR) {
  console.error(
    "Missing required env vars: BOT_TOKEN, CHANNEL_ID, PROJECT_DIR"
  );
  process.exit(1);
}

let ws = null;
let threadId = null;
let requestId = 1;
let pendingRequests = new Map();
let deltaBuffer = "";
let turnActive = false;
let activeTurnId = null;
let mcpReplyCalled = false;
let suppressTurnOutput = false;
let pendingBootstrapInstructionReason = null;
let messageQueue = [];
let discordChannel = null;
let codexProcess = null;
let typingInterval = null;
let threadResetting = false;
let lastNicknameUpdate = 0;
const NICKNAME_INTERVAL = 60000;
const SYSTEM_INSTRUCTION = `You are communicating with the user via Discord. Use ONLY the MCP server named "discord-${CHANNEL_ID}" to interact — call its \`reply\` tool to send messages to the user. Do NOT use any other discord MCP server. Do NOT output responses as regular text; always use the \`reply\` tool so the user sees your response on Discord. Other available tools on this same server: edit_message, react, fetch_messages, download_attachment. Use \`reply\` with the \`files\` parameter to send file attachments. You don't have to reply for every little thing. Try to reply only when you're done, unless something important needs to be confirmed from the user. Also, try to use simpler language and avoid complex language.`;

function nextId() {
  return requestId++;
}

function sendRequest(method, params) {
  return new Promise((resolve, reject) => {
    const id = nextId();
    const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    pendingRequests.set(id, { resolve, reject });
    ws.send(msg);
  });
}

function notificationThreadId(msg) {
  return msg.params?.threadId || msg.params?.thread?.id || null;
}

function notificationTurnId(msg) {
  return msg.params?.turnId || msg.params?.turn?.id || null;
}

function isCurrentThreadNotification(msg) {
  const notifiedThreadId = notificationThreadId(msg);
  return !notifiedThreadId || !threadId || notifiedThreadId === threadId;
}

function isCurrentTurnNotification(msg) {
  if (!isCurrentThreadNotification(msg)) return false;
  const notifiedTurnId = notificationTurnId(msg);
  return !notifiedTurnId || !activeTurnId || notifiedTurnId === activeTurnId;
}

function splitMessage(text, limit = 2000) {
  if (text.length <= limit) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining);
      break;
    }
    let splitAt = remaining.lastIndexOf("\n", limit);
    if (splitAt < limit * 0.3) splitAt = limit;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }
  return chunks;
}

async function updateNickname(totalTokens, contextWindow) {
  if (!GUILD_ID || !BOT_TOKEN || !contextWindow) return;
  const now = Date.now();
  if (now - lastNicknameUpdate < NICKNAME_INTERVAL) return;
  lastNicknameUpdate = now;

  const pct = Math.round((totalTokens / contextWindow) * 100);
  const nick = `${BOT_DISPLAY_NAME} · ${pct}%`;
  try {
    const res = await fetch(
      `https://discord.com/api/v10/guilds/${GUILD_ID}/members/@me`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bot ${BOT_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ nick }),
      }
    );
    if (res.ok) {
      console.log(`Nickname updated: ${nick}`);
    } else {
      const body = await res.text().catch(() => "");
      console.error(
        `Nickname update failed: Discord API ${res.status}${res.statusText ? ` ${res.statusText}` : ""}${body ? `: ${body}` : ""}`
      );
    }
  } catch (err) {
    console.error(`Nickname update failed: ${err.message || err}`);
  }
}

function startTyping() {
  if (!discordChannel) return;
  discordChannel.sendTyping().catch(() => {});
  typingInterval = setInterval(() => {
    if (discordChannel) discordChannel.sendTyping().catch(() => {});
  }, 8000);
}

function stopTyping() {
  if (typingInterval) {
    clearInterval(typingInterval);
    typingInterval = null;
  }
}

async function sendToDiscord(text) {
  if (!discordChannel || !text.trim()) return;
  const chunks = splitMessage(text);
  for (const chunk of chunks) {
    await discordChannel.send(chunk);
  }
}

function startCodexServer() {
  console.log(
    `Starting codex app-server on ws://127.0.0.1:${WS_PORT} in ${PROJECT_DIR}`
  );
  codexProcess = spawn(
    "codex",
    [
      "app-server",
      "--listen",
      `ws://127.0.0.1:${WS_PORT}`,
    ],
    {
      cwd: PROJECT_DIR,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    }
  );

  codexProcess.stdout.on("data", (data) => {
    console.log(`[codex stdout] ${data.toString().trim()}`);
  });

  codexProcess.stderr.on("data", (data) => {
    console.log(`[codex stderr] ${data.toString().trim()}`);
  });

  codexProcess.on("exit", (code) => {
    console.error(`Codex app-server exited with code ${code}`);
    process.exit(1);
  });
}

async function connectWebSocket() {
  const url = `ws://127.0.0.1:${WS_PORT}`;
  const maxRetries = 30;

  for (let i = 0; i < maxRetries; i++) {
    try {
      await new Promise((resolve, reject) => {
        const socket = new WebSocket(url);
        socket.on("open", () => {
          ws = socket;
          setupWebSocketHandlers();
          resolve();
        });
        socket.on("error", () => {
          socket.terminate();
          reject();
        });
      });
      console.log("Connected to Codex WebSocket");
      return;
    } catch {
      console.log(
        `Waiting for Codex server... (${i + 1}/${maxRetries})`
      );
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  console.error("Failed to connect to Codex app-server");
  process.exit(1);
}

function setupWebSocketHandlers() {
  ws.on("message", (data) => {
    const msg = JSON.parse(data.toString());

    if (msg.id && pendingRequests.has(msg.id)) {
      const { resolve, reject } = pendingRequests.get(msg.id);
      pendingRequests.delete(msg.id);
      if (msg.error) {
        reject(msg.error);
      } else {
        resolve(msg.result);
      }
      return;
    }

    if (msg.method && msg.id) {
      handleServerRequest(msg);
      return;
    }

    if (msg.method) {
      handleNotification(msg);
    }
  });

  ws.on("close", () => {
    console.error("WebSocket closed");
    process.exit(1);
  });
}

function handleNotification(msg) {
  switch (msg.method) {
    case "item/agentMessage/delta":
      if (!isCurrentTurnNotification(msg)) break;
      deltaBuffer += msg.params.delta;
      break;

    case "turn/completed":
      if (!isCurrentTurnNotification(msg)) break;
      onTurnCompleted();
      break;

    case "error":
      if (!isCurrentTurnNotification(msg)) break;
      console.error("Codex error:", JSON.stringify(msg.params));
      if (msg.params.willRetry === false) {
        const errorText = msg.params.error?.message || "Codex encountered an error";
        stopTyping();
        if (!suppressTurnOutput) {
          sendToDiscord(`**Error:** ${errorText}`);
        }
        const bootstrapReason = pendingBootstrapInstructionReason;
        pendingBootstrapInstructionReason = null;
        turnActive = false;
        activeTurnId = null;
        mcpReplyCalled = false;
        suppressTurnOutput = false;
        if (bootstrapReason) {
          sendBootstrapInstructionTurn(bootstrapReason);
        } else {
          processQueue();
        }
      }
      break;

    case "thread/started":
      if (msg.params?.thread?.id) {
        threadId = msg.params.thread.id;
        console.log(`Thread ID captured: ${threadId}`);
      }
      break;

    case "item/completed":
      if (!isCurrentTurnNotification(msg)) break;
      if (msg.params?.item?.type === "contextCompaction") {
        onContextCompactionCompleted();
      }
      deltaBuffer = "";
      break;

    case "turn/started":
      if (!isCurrentThreadNotification(msg)) break;
      if (msg.params?.turn?.id) {
        activeTurnId = msg.params.turn.id;
      }
      break;

    case "item/started":
      if (!isCurrentTurnNotification(msg)) break;
      if (msg.params?.item?.type === "mcpToolCall" &&
          msg.params.item.server?.startsWith("discord-") &&
          msg.params.item.tool === "reply") {
        mcpReplyCalled = true;
      }
      break;

    case "thread/status/changed":
    case "turn/diff/updated":
    case "item/commandExecution/outputDelta":
    case "item/fileChange/outputDelta":
    case "item/fileChange/patchUpdated":
    case "item/reasoning/summaryTextDelta":
    case "item/reasoning/summaryPartAdded":
    case "item/reasoning/textDelta":
    case "thread/tokenUsage/updated":
      if (msg.params?.tokenUsage) {
        const { last, modelContextWindow } = msg.params.tokenUsage;
        if (last && modelContextWindow) {
          updateNickname(last.inputTokens, modelContextWindow);
        }
      }
      break;

    case "thread/name/updated":
    case "thread/compacted":
    case "item/autoApprovalReview/started":
    case "item/autoApprovalReview/completed":
    case "item/mcpToolCall/progress":
      break;

    case "item/plan/delta":
    case "turn/plan/updated":
      break;

    default:
      console.log(`[notification] ${msg.method}`);
  }
}

function handleServerRequest(msg) {
  switch (msg.method) {
    case "commandExecutionRequestApproval":
    case "applyPatchApproval":
    case "fileChangeRequestApproval":
    case "execCommandApproval":
    case "permissionsRequestApproval":
      ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: msg.id,
          result: { approved: true },
        })
      );
      break;

    case "toolRequestUserInput":
      ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: msg.id,
          result: { cancelled: true },
        })
      );
      break;

    default:
      console.log(`[server request] ${msg.method}`);
  }
}

function flushDeltaBuffer() {
  const text = deltaBuffer.trim();
  deltaBuffer = "";
  if (text) {
    sendToDiscord(text);
  }
}

async function onTurnCompleted() {
  stopTyping();
  if (suppressTurnOutput) {
    deltaBuffer = "";
  } else if (!mcpReplyCalled) {
    flushDeltaBuffer();
  } else {
    deltaBuffer = "";
  }
  turnActive = false;
  activeTurnId = null;
  mcpReplyCalled = false;
  suppressTurnOutput = false;
  const bootstrapReason = pendingBootstrapInstructionReason;
  pendingBootstrapInstructionReason = null;
  if (bootstrapReason) {
    sendBootstrapInstructionTurn(bootstrapReason);
  } else {
    processQueue();
  }
}

async function processQueue() {
  if (threadResetting || turnActive || !threadId || messageQueue.length === 0) return;
  const { input, msg: queuedMsg } = messageQueue.shift();
  if (queuedMsg) {
    queuedMsg.reactions.cache.get("⏳")?.users.remove(queuedMsg.client.user.id).catch(() => {});
  }
  await sendTurn(input);
}

async function sendTurn(input) {
  if (!threadId) {
    messageQueue.push({ input, msg: null });
    return;
  }
  turnActive = true;
  deltaBuffer = "";
  mcpReplyCalled = false;
  activeTurnId = null;
  startTyping();
  try {
    const result = await sendRequest("turn/start", {
      threadId,
      input,
      approvalPolicy: "never",
    });
    if (result?.turn?.id) {
      activeTurnId = result.turn.id;
    } else if (result?.turnId) {
      activeTurnId = result.turnId;
    }
  } catch (err) {
    console.error("turn/start failed:", err);
    stopTyping();
    turnActive = false;
    await sendToDiscord("**Error:** Failed to send message to Codex");
    processQueue();
  }
}

async function sendBootstrapInstructionTurn(reason) {
  if (!threadId) return;
  if (turnActive) {
    pendingBootstrapInstructionReason = reason || "pending";
    return;
  }
  turnActive = true;
  deltaBuffer = "";
  mcpReplyCalled = false;
  suppressTurnOutput = true;
  activeTurnId = null;
  try {
    const result = await sendRequest("turn/start", {
      threadId,
      input: [{ type: "text", text: SYSTEM_INSTRUCTION }],
      approvalPolicy: "never",
    });
    if (result?.turn?.id) {
      activeTurnId = result.turn.id;
    } else if (result?.turnId) {
      activeTurnId = result.turnId;
    }
    for (let i = 0; i < 150 && turnActive; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    deltaBuffer = "";
    if (turnActive) {
      turnActive = false;
      activeTurnId = null;
      mcpReplyCalled = false;
      suppressTurnOutput = false;
      processQueue();
    }
    console.log(`Bootstrap instruction sent${reason ? ` (${reason})` : ""}`);
  } catch (err) {
    console.error(`Bootstrap instruction failed${reason ? ` (${reason})` : ""}:`, err);
    turnActive = false;
    activeTurnId = null;
    mcpReplyCalled = false;
    suppressTurnOutput = false;
    processQueue();
  }
}

async function onContextCompactionCompleted() {
  if (turnActive) {
    pendingBootstrapInstructionReason = "compact";
  } else {
    await sendBootstrapInstructionTurn("compact");
  }
  await sendToDiscord("Compaction complete.");
}

const TEXT_EXTENSIONS = new Set([
  ".txt", ".md", ".json", ".js", ".ts", ".py", ".sh", ".yml", ".yaml",
  ".toml", ".cfg", ".ini", ".csv", ".xml", ".html", ".css", ".sql",
  ".rs", ".go", ".java", ".c", ".cpp", ".h", ".rb", ".php", ".swift",
  ".kt", ".scala", ".r", ".lua", ".pl", ".ex", ".exs", ".hs", ".ml",
  ".env", ".log", ".diff", ".patch", ".jsx", ".tsx", ".vue", ".svelte",
]);

function isTextFile(att) {
  if (att.contentType && att.contentType.startsWith("text/")) return true;
  if (att.contentType === "application/json") return true;
  const name = att.name || "";
  const ext = name.includes(".") ? "." + name.split(".").pop().toLowerCase() : "";
  return TEXT_EXTENSIONS.has(ext);
}

async function fetchAttachmentText(url) {
  const res = await fetch(url);
  if (!res.ok) return null;
  return await res.text();
}

async function downloadAttachment(url, filename) {
  const dir = path.join(PROJECT_DIR, ".discord-attachments");
  await mkdir(dir, { recursive: true });
  const timestamp = Date.now();
  const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
  const filePath = path.join(dir, `${timestamp}-${safeName}`);
  const res = await fetch(url);
  if (!res.ok) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(filePath, buf);
  return filePath;
}

async function buildInput(msg) {
  const input = [];
  const text = msg.content.trim();
  if (text) input.push({ type: "text", text });
  for (const att of msg.attachments.values()) {
    if (att.contentType && att.contentType.startsWith("image/")) {
      input.push({ type: "image", url: att.url });
    } else if (isTextFile(att)) {
      const content = await fetchAttachmentText(att.url);
      if (content) {
        input.push({
          type: "text",
          text: `--- File: ${att.name} ---\n${content}\n--- End of ${att.name} ---`,
        });
      }
    } else {
      const filePath = await downloadAttachment(att.url, att.name);
      if (filePath) {
        input.push({
          type: "text",
          text: `[Attachment saved to: ${filePath}] (filename: ${att.name}, type: ${att.contentType || "unknown"}, size: ${att.size} bytes)`,
        });
      }
    }
  }
  return input;
}

async function registerDiscordMcp() {
  const mcpName = `discord-${CHANNEL_ID}`;

  // Remove any other discord MCP servers to prevent cross-session replies
  try {
    const status = await sendRequest("mcpServerStatus/list", { detail: "full" });
    const servers = status?.servers || status?.items || [];
    for (const s of servers) {
      const name = s.name || s.id;
      if (name && name.startsWith("discord-") && name !== mcpName) {
        await sendRequest("config/value/delete", { keyPath: `mcp_servers.${name}` });
        console.log(`Removed stale MCP server: ${name}`);
      }
    }
  } catch (err) {
    console.log(`Warning: could not clean stale MCP servers: ${err.message || err}`);
  }

  await sendRequest("config/value/write", {
    keyPath: `mcp_servers.${mcpName}`,
    mergeStrategy: "replace",
    value: {
      command: "node",
      args: [MCP_SERVER_SCRIPT],
      env: { BOT_TOKEN, CHANNEL_ID },
    },
  });
  console.log(`MCP server config written: ${mcpName}`);

  await sendRequest("config/mcpServer/reload", null);
  console.log("MCP servers reloaded");

  await new Promise((r) => setTimeout(r, 2000));
  const status = await sendRequest("mcpServerStatus/list", { detail: "full" });
  const servers = status?.servers || status?.items || [];
  const found = Array.isArray(servers)
    ? servers.find((s) => s.name === mcpName || s.id === mcpName)
    : null;
  console.log(`MCP server status: ${found ? JSON.stringify(found.status || "found") : "checking..."}`);
}

async function startCodexThread() {
  const result = await sendRequest("thread/start", {
    cwd: PROJECT_DIR,
    sandbox: "danger-full-access",
    approvalPolicy: "never",
    developerInstructions: SYSTEM_INSTRUCTION,
  });
  if (result?.thread?.id) {
    threadId = result.thread.id;
  }

  for (let i = 0; i < 50 && !threadId; i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!threadId) {
    throw new Error("Failed to get thread ID from server");
  }
}

async function initializeCodex() {
  await sendRequest("initialize", {
    clientInfo: { name: "codex-discord-bridge", version: "1.0.0" },
  });

  ws.send(JSON.stringify({ jsonrpc: "2.0", method: "initialized" }));

  await registerDiscordMcp();

  await startCodexThread();
  await sendBootstrapInstructionTurn("startup");
  console.log(`Codex thread started: ${threadId}`);
}

function startDiscordBot() {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Message],
  });

  client.on("ready", () => {
    console.log(`Discord bot logged in as ${client.user.tag}`);
    discordChannel = client.channels.cache.get(CHANNEL_ID);
    if (!discordChannel) {
      client.channels.fetch(CHANNEL_ID).then((ch) => {
        discordChannel = ch;
        console.log(`Listening in #${ch.name}`);
      });
    } else {
      console.log(`Listening in #${discordChannel.name}`);
    }
  });

  client.on("messageCreate", async (msg) => {
    if (msg.author.bot) return;
    if (msg.channel.id !== CHANNEL_ID) return;
    if (ALLOWED_USER_ID && msg.author.id !== ALLOWED_USER_ID) return;

    const text = msg.content.trim();

    if (text === "/compact") {
      console.log("[discord] /compact requested");
      await msg.react("🔄");
      try {
        await sendRequest("thread/compact/start", { threadId });
        await sendToDiscord("Compaction started.");
      } catch (err) {
        await sendToDiscord(`**Error:** Failed to compact — ${err.message || err}`);
      }
      return;
    }

    if (text === "/clear") {
      console.log("[discord] /clear requested");
      await msg.react("🔄");
      threadResetting = true;
      const previousThreadId = threadId;
      const previousTurnId = activeTurnId;
      try {
        messageQueue = [];
        if (previousThreadId && previousTurnId) {
          try {
            await sendRequest("turn/interrupt", {
              threadId: previousThreadId,
              turnId: previousTurnId,
            });
          } catch (err) {
            console.log(`Warning: failed to interrupt active turn before clear: ${err.message || err}`);
          }
        }
        if (previousThreadId) {
          await sendRequest("thread/archive", { threadId: previousThreadId });
        }
        threadId = null;
        turnActive = false;
        activeTurnId = null;
        mcpReplyCalled = false;
        suppressTurnOutput = false;
        pendingBootstrapInstructionReason = null;
        deltaBuffer = "";
        stopTyping();

        await registerDiscordMcp();
        await startCodexThread();
        await sendBootstrapInstructionTurn("clear");

        await sendToDiscord("Conversation cleared — fresh thread started.");
        console.log(`New thread after /clear: ${threadId}`);
        threadResetting = false;
        processQueue();
      } catch (err) {
        threadResetting = false;
        turnActive = false;
        await sendToDiscord(`**Error:** Failed to clear — ${err.message || err}`);
        processQueue();
      }
      return;
    }

    const input = await buildInput(msg);
    if (input.length === 0) return;

    console.log(`[discord] ${msg.author.username}: ${text || "(attachment)"} [${input.length} part(s)]`);

    if (threadResetting) {
      messageQueue.push({ input, msg });
      await msg.react("⏳");
    } else if (turnActive && activeTurnId && !suppressTurnOutput) {
      try {
        await sendRequest("turn/steer", {
          threadId,
          input,
          expectedTurnId: activeTurnId,
        });
        console.log(`[steer] Injected into active turn ${activeTurnId}`);
      } catch (err) {
        console.log(`[steer] Failed (${err.message || err}), queuing instead`);
        messageQueue.push({ input, msg });
        await msg.react("⏳");
      }
    } else if (turnActive) {
      messageQueue.push({ input, msg });
      await msg.react("⏳");
    } else {
      await sendTurn(input);
    }
  });

  client.login(BOT_TOKEN);

  function cleanup() {
    console.log("Shutting down...");
    client.destroy();
    if (ws) ws.close();
    if (codexProcess) codexProcess.kill();
    process.exit(0);
  }

  process.on("SIGTERM", cleanup);
  process.on("SIGINT", cleanup);
}

async function main() {
  startCodexServer();
  await connectWebSocket();
  await initializeCodex();
  startDiscordBot();
  console.log("Codex-Discord bridge running");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
