#!/usr/bin/env node

const { Client, GatewayIntentBits, Partials } = require("discord.js");
const { spawn } = require("child_process");
const { writeFile, mkdir } = require("fs/promises");
const path = require("path");
const WebSocket = require("ws");

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
let messageQueue = [];
let discordChannel = null;
let codexProcess = null;
let typingInterval = null;
let lastNicknameUpdate = 0;
const NICKNAME_INTERVAL = 60000;

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
  if (!GUILD_ID || !ROOT_BOT_TOKEN || !BOT_APP_ID || !contextWindow) return;
  const now = Date.now();
  if (now - lastNicknameUpdate < NICKNAME_INTERVAL) return;
  lastNicknameUpdate = now;

  const pct = Math.round((totalTokens / contextWindow) * 100);
  const nick = `${BOT_DISPLAY_NAME} · ${pct}%`;
  try {
    const res = await fetch(
      `https://discord.com/api/v10/guilds/${GUILD_ID}/members/${BOT_APP_ID}`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bot ${ROOT_BOT_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ nick }),
      }
    );
    if (res.ok) console.log(`Nickname updated: ${nick}`);
  } catch {}
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
      "-c",
      `sandbox="danger-full-access"`,
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
      deltaBuffer += msg.params.delta;
      break;

    case "turn/completed":
      onTurnCompleted();
      break;

    case "error":
      console.error("Codex error:", JSON.stringify(msg.params));
      if (msg.params.willRetry === false) {
        const errorText = msg.params.error?.message || "Codex encountered an error";
        sendToDiscord(`**Error:** ${errorText}`);
        turnActive = false;
        processQueue();
      }
      break;

    case "thread/started":
      if (msg.params?.thread?.id) {
        threadId = msg.params.thread.id;
        console.log(`Thread ID captured: ${threadId}`);
      }
      break;

    case "thread/status/changed":
    case "turn/started":
    case "item/started":
    case "item/completed":
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

async function onTurnCompleted() {
  stopTyping();
  const response = deltaBuffer.trim();
  deltaBuffer = "";
  turnActive = false;

  if (response) {
    await sendToDiscord(response);
  }

  processQueue();
}

async function processQueue() {
  if (turnActive || messageQueue.length === 0) return;
  const nextInput = messageQueue.shift();
  await sendTurn(nextInput);
}

async function sendTurn(input) {
  turnActive = true;
  deltaBuffer = "";
  startTyping();
  try {
    await sendRequest("turn/start", {
      threadId,
      input,
      approvalPolicy: "never",
    });
  } catch (err) {
    console.error("turn/start failed:", err);
    stopTyping();
    turnActive = false;
    await sendToDiscord("**Error:** Failed to send message to Codex");
    processQueue();
  }
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

async function initializeCodex() {
  await sendRequest("initialize", {
    clientInfo: { name: "codex-discord-bridge", version: "1.0.0" },
  });

  ws.send(JSON.stringify({ jsonrpc: "2.0", method: "initialized" }));

  await sendRequest("thread/start", {
    cwd: PROJECT_DIR,
    sandbox: "danger-full-access",
    approvalPolicy: "never",
  });

  for (let i = 0; i < 50 && !threadId; i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!threadId) {
    console.error("Failed to get thread ID from server");
    process.exit(1);
  }
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

    const input = await buildInput(msg);
    if (input.length === 0) return;

    console.log(`[discord] ${msg.author.username}: ${msg.content.trim() || "(attachment)"} [${input.length} part(s)]`);

    if (turnActive) {
      messageQueue.push(input);
      await msg.react("⏳");
    } else {
      await sendTurn(input);
    }
  });

  client.login(BOT_TOKEN);

  process.on("SIGTERM", () => {
    console.log("Shutting down...");
    client.destroy();
    if (ws) ws.close();
    if (codexProcess) codexProcess.kill();
    process.exit(0);
  });

  process.on("SIGINT", () => {
    console.log("Shutting down...");
    client.destroy();
    if (ws) ws.close();
    if (codexProcess) codexProcess.kill();
    process.exit(0);
  });
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
