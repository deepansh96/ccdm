#!/usr/bin/env node

const { Client, GatewayIntentBits, Partials } = require("discord.js");
const { spawn } = require("child_process");
const { createHmac, randomBytes } = require("crypto");
const { writeFile, mkdir, mkdtemp, readFile, rm } = require("fs/promises");
const { rmSync } = require("fs");
const os = require("os");
const path = require("path");
const WebSocket = require("ws");

const MCP_SERVER_SCRIPT = path.resolve(__dirname, "discord-mcp-server.js");
const ROOT_DIR = path.resolve(__dirname, "..");
const REGISTRY_PATH = path.join(ROOT_DIR, "registry.json");

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const PROJECT_DIR = process.env.PROJECT_DIR;
const WS_PORT = parseInt(process.env.WS_PORT || "18300", 10);
const ALLOWED_USER_IDS = new Set(
  (process.env.ALLOWED_USER_IDS || process.env.ALLOWED_USER_ID || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
);
const GUILD_ID = process.env.GUILD_ID;
const ROOT_BOT_TOKEN = process.env.ROOT_BOT_TOKEN;
const ROOT_BOT_APP_ID = process.env.ROOT_BOT_APP_ID;
const BOT_APP_ID = process.env.BOT_APP_ID;
const BOT_DISPLAY_NAME = process.env.BOT_DISPLAY_NAME || "codex";
const CODEX_MODEL = process.env.CODEX_MODEL || "";
const CODEX_REASONING_EFFORT = process.env.CODEX_REASONING_EFFORT || "";
const CODEX_SERVICE_TIER = process.env.CODEX_SERVICE_TIER || "";
const AUDIO_TRANSCRIPTION_ENABLED = envFlag(
  true,
  "CODEX_BRIDGE_TRANSCRIBE_AUDIO",
  "USE_AUDIO_TRANSCRIPTION_IN_BRIDGE"
);
const AUDIO_TRANSCRIPTION_COMMAND =
  process.env.CODEX_BRIDGE_AUDIO_TRANSCRIPTION_COMMAND || "whisper";
const AUDIO_TRANSCRIPTION_MODEL =
  process.env.CODEX_BRIDGE_AUDIO_TRANSCRIPTION_MODEL || "turbo";
const AUDIO_TRANSCRIPTION_LANGUAGE =
  process.env.CODEX_BRIDGE_AUDIO_TRANSCRIPTION_LANGUAGE || "en";
const TEXT_REPLY_FALLBACK =
  process.env.CODEX_BRIDGE_TEXT_REPLY_FALLBACK === "1";
const ROOT_MULTI_CHANNEL = envFlag(
  false,
  "ROOT_MULTI_CHANNEL",
  "CODEX_BRIDGE_ROOT_MULTI_CHANNEL"
);
const ROOT_ACCESS_FILE =
  process.env.ROOT_ACCESS_FILE ||
  path.join(os.homedir(), ".claude", "channels", "discord", "access.json");
const DISCORD_REPLY_TOKEN = randomBytes(16).toString("hex");
const DISCORD_CHANNEL_SCOPE_SECRET = randomBytes(32).toString("hex");
const TURN_ID_RECONCILIATION_METHODS = new Set([
  "turn/started",
  "item/started",
  "item/agentMessage/delta",
]);

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
let fallbackText = "";
let turnActive = false;
let activeTurnId = null;
let activeTurnIdConfirmed = false;
let mcpReplyCalled = false;
let suppressTurnOutput = false;
let pendingBootstrapInstructionReason = null;
let messageQueue = [];
let discordClient = null;
let discordChannel = null;
let codexProcess = null;
let typingInterval = null;
let activeOutputChannelId = null;
let activeTypingChannel = null;
let threadResetting = false;
let lastNicknameUpdate = 0;
let fallbackLoggedCompletedItemTypes = new Set();
let rootAccess = null;
let rootChannelAccess = new Map();
let discordChannelScopeDir = null;
let discordChannelScopeFile = null;
const NICKNAME_INTERVAL = 60000;
const DISCORD_MCP_NAME = ROOT_MULTI_CHANNEL ? "discord-root" : `discord-${CHANNEL_ID}`;
const THREAD_INSTRUCTION = ROOT_MULTI_CHANNEL
  ? `This root thread is connected to Discord through the ${DISCORD_MCP_NAME} MCP server. Incoming messages include Discord routing metadata. Do not call Discord MCP tools unless the current task includes an explicit Discord reply scope token. Subagents and delegated tasks must return results to their parent agent, not to Discord.`
  : `This thread is connected to Discord through the ${DISCORD_MCP_NAME} MCP server. Do not call Discord MCP tools unless the current task includes an explicit Discord reply scope token. Subagents and delegated tasks must return results to their parent agent, not to Discord.`;
const SYSTEM_INSTRUCTION = ROOT_MULTI_CHANNEL
  ? `You are communicating with the user via Discord. Use ONLY the MCP server named "${DISCORD_MCP_NAME}" to interact. Incoming messages include a Discord routing metadata block; use its channel_id and channel_scope_token for every Discord MCP call. Every Discord write call (\`reply\`, \`edit_message\`, or \`react\`) must also include \`scope_token: "${DISCORD_REPLY_TOKEN}"\`. Do NOT share these tokens with subagents. When spawning subagents, explicitly tell them not to use Discord MCP/tools and to return only to the parent agent. Do NOT use any other discord MCP server. Do NOT output responses as regular text; always use the \`reply\` tool so the user sees your response on Discord. Other available tools on this same server: edit_message, react, fetch_messages, download_attachment. Use \`reply\` with the \`files\` parameter to send file attachments. You don't have to reply for every little thing. Try to reply only when you're done, unless something important needs to be confirmed from the user. Also, try to use simpler language and avoid complex language.`
  : `You are communicating with the user via Discord. Use ONLY the MCP server named "${DISCORD_MCP_NAME}" to interact — call its \`reply\` tool to send messages to the user. Every Discord write call (\`reply\`, \`edit_message\`, or \`react\`) must include \`scope_token: "${DISCORD_REPLY_TOKEN}"\`. Do NOT share this scope token with subagents. When spawning subagents, explicitly tell them not to use Discord MCP/tools and to return only to the parent agent. Do NOT use any other discord MCP server. Do NOT output responses as regular text; always use the \`reply\` tool so the user sees your response on Discord. Other available tools on this same server: edit_message, react, fetch_messages, download_attachment. Use \`reply\` with the \`files\` parameter to send file attachments. You don't have to reply for every little thing. Try to reply only when you're done, unless something important needs to be confirmed from the user. Also, try to use simpler language and avoid complex language.`;

function nextId() {
  return requestId++;
}

function envFlag(defaultValue, ...names) {
  for (const name of names) {
    const value = process.env[name];
    if (!value) continue;
    const normalized = value.toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "off"].includes(normalized)) return false;
  }
  return defaultValue;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\"'\"'")}'`;
}

async function findCurrentProject() {
  const registry = JSON.parse(await readFile(REGISTRY_PATH, "utf8"));
  for (const [projectName, project] of Object.entries(registry.projects || {})) {
    if ((project.type || "claude") !== "codex") continue;
    const bot = (registry.pool || []).find((entry) => entry.id === project.bot_id);
    if (project.channel_id === CHANNEL_ID && (!BOT_APP_ID || bot?.app_id === BOT_APP_ID)) {
      return { projectName, screenName: project.screen_name };
    }
  }
  throw new Error(`No codex project in registry.json matches channel ${CHANNEL_ID}`);
}

function scheduleRestart(projectName, screenName) {
  const safeName = projectName.replace(/[^a-zA-Z0-9._-]/g, "_");
  const logPath = path.join(os.tmpdir(), `ccdm-restart-${safeName}.log`);
  const command = [
    `while kill -0 ${process.pid} 2>/dev/null; do sleep 1; done`,
    `tmux kill-session -t ${shellQuote(`=${screenName}`)} 2>/dev/null || true`,
    `cd ${shellQuote(ROOT_DIR)} && ./scripts/start-codex-session.sh ${shellQuote(projectName)} >> ${shellQuote(logPath)} 2>&1`,
  ].join("; ");
  const child = spawn("/bin/sh", ["-c", command], {
    detached: true,
    env: process.env,
    stdio: "ignore",
  });
  child.unref();
  return logPath;
}

function scheduleRootRestart() {
  const logPath = path.join(os.tmpdir(), "ccdm-restart-root-codex.log");
  const command = [
    `while kill -0 ${process.pid} 2>/dev/null; do sleep 1; done`,
    `cd ${shellQuote(ROOT_DIR)} && ./restart-root-codex-agent.sh ${shellQuote(CHANNEL_ID)} >> ${shellQuote(logPath)} 2>&1`,
  ].join("; ");
  const child = spawn("/bin/sh", ["-c", command], {
    detached: true,
    env: process.env,
    stdio: "ignore",
  });
  child.unref();
  return logPath;
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
  if (!notifiedTurnId) {
    return true;
  }
  if (!turnActive) {
    console.log(`[turn] ignoring turn id ${notifiedTurnId} for ${msg.method}; no turn is active`);
    return false;
  }
  if (!activeTurnId) {
    if (!TURN_ID_RECONCILIATION_METHODS.has(msg.method)) {
      console.log(`[turn] ignoring unconfirmed turn id ${notifiedTurnId} for ${msg.method}`);
      return false;
    }
    activeTurnId = notifiedTurnId;
    activeTurnIdConfirmed = true;
    return true;
  }
  if (notifiedTurnId === activeTurnId) {
    activeTurnIdConfirmed = true;
    return true;
  }
  if (!activeTurnIdConfirmed && TURN_ID_RECONCILIATION_METHODS.has(msg.method)) {
    console.log(
      `[turn] accepting active turn id ${notifiedTurnId} for ${msg.method}; previous expected id was ${activeTurnId}`
    );
    activeTurnId = notifiedTurnId;
    activeTurnIdConfirmed = true;
    return true;
  }
  console.log(`[turn] ignoring stale turn id ${notifiedTurnId} for ${msg.method}; active id is ${activeTurnId}`);
  return false;
}

async function initializeDiscordChannelScope() {
  if (!ROOT_MULTI_CHANNEL) return;
  discordChannelScopeDir = await mkdtemp(path.join(os.tmpdir(), "codex-discord-scope-"));
  discordChannelScopeFile = path.join(discordChannelScopeDir, "active");
  await writeFile(discordChannelScopeFile, "", { mode: 0o600 });
}

function createDiscordChannelScopeToken(msg) {
  const encoded = Buffer.from(JSON.stringify({
    author_id: msg.author.id,
    channel_id: msg.channel.id,
    nonce: randomBytes(16).toString("hex"),
  })).toString("base64url");
  const signature = createHmac("sha256", DISCORD_CHANNEL_SCOPE_SECRET)
    .update(encoded)
    .digest("base64url");
  return `${encoded}.${signature}`;
}

async function activateDiscordChannelScope(token) {
  if (!ROOT_MULTI_CHANNEL) return;
  if (!discordChannelScopeFile || !token) {
    throw new Error("Missing Discord channel scope for root turn");
  }
  await writeFile(discordChannelScopeFile, token, { mode: 0o600 });
}

async function clearDiscordChannelScope() {
  if (ROOT_MULTI_CHANNEL && discordChannelScopeFile) {
    await writeFile(discordChannelScopeFile, "", { mode: 0o600 });
  }
}

function resetActiveTurnId() {
  activeTurnId = null;
  activeTurnIdConfirmed = false;
}

function recordExpectedTurnId(result) {
  if (activeTurnIdConfirmed) return;
  activeTurnId = result?.turn?.id || result?.turnId || activeTurnId;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function mentionsApp(msg, appId) {
  if (!appId) return false;
  if (msg.mentions?.users?.has?.(appId)) return true;
  const mentionPattern = new RegExp(`<@!?${escapeRegExp(appId)}>`);
  return mentionPattern.test(msg.content || "");
}

function mentionsRootBot(msg) {
  return mentionsApp(msg, ROOT_BOT_APP_ID);
}

function mentionsThisBot(msg) {
  return mentionsApp(msg, BOT_APP_ID);
}

function stripThisBotMention(text) {
  if (!ROOT_MULTI_CHANNEL || !BOT_APP_ID) return text;
  return text.replace(new RegExp(`<@!?${escapeRegExp(BOT_APP_ID)}>`, "g"), "").trim();
}

async function loadRootAccess(log = true) {
  if (!ROOT_MULTI_CHANNEL) return;
  const access = JSON.parse(await readFile(ROOT_ACCESS_FILE, "utf8"));
  const channelAccess = new Map(Object.entries(access.groups || {}));
  if (channelAccess.get(CHANNEL_ID)?.requireMention !== false) {
    throw new Error(`Primary root channel ${CHANNEL_ID} is not configured as a no-mention channel in ${ROOT_ACCESS_FILE}`);
  }
  rootAccess = access;
  rootChannelAccess = channelAccess;
  if (log) {
    console.log(`Root multi-channel routing enabled for ${rootChannelAccess.size} channel(s)`);
  }
}

function allowedRootUsersFor(channelConfig) {
  const ids = [
    ...ALLOWED_USER_IDS,
    ...(rootAccess?.allowFrom || []),
    ...(channelConfig?.allowFrom || []),
  ].map((id) => String(id).trim()).filter(Boolean);
  return new Set(ids);
}

async function shouldHandleDiscordMessage(msg) {
  if (msg.author.bot) return false;
  if (!ROOT_MULTI_CHANNEL) {
    if (msg.channel.id !== CHANNEL_ID) return false;
    if (ALLOWED_USER_IDS.size > 0 && !ALLOWED_USER_IDS.has(msg.author.id)) return false;
    if (mentionsRootBot(msg)) return false;
    return true;
  }

  try {
    await loadRootAccess(false);
  } catch (err) {
    console.error(`Root access reload failed: ${err.message || err}`);
    return false;
  }

  const channelConfig = rootChannelAccess.get(msg.channel.id);
  if (!channelConfig) return false;
  const allowed = allowedRootUsersFor(channelConfig);
  if (allowed.size > 0 && !allowed.has(msg.author.id)) return false;
  if (channelConfig.requireMention !== false && !mentionsThisBot(msg)) return false;
  return true;
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

function completedItemType(item) {
  return item?.type || "(missing)";
}

function logCompletedItemType(item) {
  if (!TEXT_REPLY_FALLBACK) return;
  const type = completedItemType(item);
  if (fallbackLoggedCompletedItemTypes.has(type)) return;
  fallbackLoggedCompletedItemTypes.add(type);
  console.log(`[text-reply-fallback] completed item.type=${type}`);
}

function isFallbackMessageItem(item) {
  if (!item || typeof item !== "object") return false;
  const type = item.type;
  if (type === "agentMessage" || type === "assistantMessage") return true;
  if (type === "message") {
    return item.role === "assistant" || item.message?.role === "assistant";
  }
  return false;
}

function extractTextFromValue(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map(extractTextFromValue).filter(Boolean).join("");
  }
  if (typeof value !== "object") return "";
  return extractTextFromValue(value.text) ||
    extractTextFromValue(value.message) ||
    extractTextFromValue(value.content);
}

function appendFallbackText(text) {
  const trimmed = (text || "").trim();
  if (!trimmed) return;
  fallbackText = fallbackText ? `${fallbackText}\n${trimmed}` : trimmed;
}

function captureTextReplyFallback(item) {
  if (!TEXT_REPLY_FALLBACK || !isFallbackMessageItem(item)) return;
  appendFallbackText(deltaBuffer);
  appendFallbackText(
    extractTextFromValue(item.text) ||
    extractTextFromValue(item.message) ||
    extractTextFromValue(item.content)
  );
}

async function updateNickname(totalTokens, contextWindow) {
  if (!GUILD_ID || !BOT_TOKEN || !contextWindow) return;
  const now = Date.now();
  if (now - lastNicknameUpdate < NICKNAME_INTERVAL) return;
  lastNicknameUpdate = now;

  const pct = Math.round((totalTokens / contextWindow) * 100);
  // Discord caps guild nicknames at 32 chars. Trim the base name to fit so the
  // % suffix always survives (otherwise long bot names make every update 400).
  const suffix = ` · ${pct}%`;
  const base = BOT_DISPLAY_NAME.slice(0, Math.max(0, 32 - suffix.length)).replace(/[\s·_-]+$/, "");
  const nick = `${base}${suffix}`;
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

async function channelById(channelId) {
  if (!channelId || !discordClient) return discordChannel;
  if (discordChannel?.id === channelId) return discordChannel;
  const cached = discordClient.channels.cache.get(channelId);
  if (cached) return cached;
  return await discordClient.channels.fetch(channelId);
}

async function startTyping(channelId = CHANNEL_ID) {
  activeTypingChannel = await channelById(channelId);
  if (!activeTypingChannel) return;
  activeTypingChannel.sendTyping().catch(() => {});
  typingInterval = setInterval(() => {
    if (activeTypingChannel) activeTypingChannel.sendTyping().catch(() => {});
  }, 8000);
}

function stopTyping() {
  if (typingInterval) {
    clearInterval(typingInterval);
    typingInterval = null;
  }
  activeTypingChannel = null;
}

async function sendToDiscord(text, channelId = activeOutputChannelId || CHANNEL_ID) {
  const channel = await channelById(channelId);
  if (!channel || !text.trim()) return;
  const chunks = splitMessage(text);
  for (const chunk of chunks) {
    await channel.send(chunk);
  }
}

function startCodexServer() {
  const configArgs = [];
  if (CODEX_MODEL) configArgs.push("-c", `model=${JSON.stringify(CODEX_MODEL)}`);
  if (CODEX_REASONING_EFFORT) {
    configArgs.push(
      "-c",
      `model_reasoning_effort=${JSON.stringify(CODEX_REASONING_EFFORT)}`
    );
  }
  if (CODEX_SERVICE_TIER) {
    configArgs.push("-c", `service_tier=${JSON.stringify(CODEX_SERVICE_TIER)}`);
  }
  console.log(
    `Starting codex app-server on ws://127.0.0.1:${WS_PORT} in ${PROJECT_DIR}` +
      (CODEX_MODEL ? ` model=${CODEX_MODEL}` : "") +
      (CODEX_REASONING_EFFORT ? ` reasoning=${CODEX_REASONING_EFFORT}` : "") +
      (CODEX_SERVICE_TIER ? ` service_tier=${CODEX_SERVICE_TIER}` : "")
  );
  codexProcess = spawn(
    "codex",
    [
      "app-server",
      ...configArgs,
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
        resetActiveTurnId();
        fallbackText = "";
        mcpReplyCalled = false;
        suppressTurnOutput = false;
        activeOutputChannelId = null;
        clearDiscordChannelScope().catch((err) => {
          console.error(`Discord channel scope cleanup failed: ${err.message || err}`);
        }).then(() => {
          turnActive = false;
          if (bootstrapReason) {
            sendBootstrapInstructionTurn(bootstrapReason);
          } else {
            processQueue();
          }
        });
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
      logCompletedItemType(msg.params?.item);
      if (msg.params?.item?.type === "contextCompaction") {
        onContextCompactionCompleted();
      }
      captureTextReplyFallback(msg.params?.item);
      if (TEXT_REPLY_FALLBACK) break;
      deltaBuffer = "";
      break;

    case "turn/started":
      isCurrentTurnNotification(msg);
      break;

    case "item/started":
      if (!isCurrentTurnNotification(msg)) break;
      if (msg.params?.item?.type === "mcpToolCall" &&
          msg.params.item.server?.startsWith("discord-") &&
          ["reply", "edit_message", "react"].includes(msg.params.item.tool)) {
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

function flushTextReplyFallback() {
  const text = deltaBuffer.trim() || fallbackText.trim();
  deltaBuffer = "";
  fallbackText = "";
  if (text) {
    sendToDiscord(text);
  }
}

async function onTurnCompleted() {
  stopTyping();
  if (suppressTurnOutput) {
    deltaBuffer = "";
    fallbackText = "";
  } else if (!mcpReplyCalled && TEXT_REPLY_FALLBACK) {
    flushTextReplyFallback();
  } else {
    deltaBuffer = "";
    fallbackText = "";
  }
  resetActiveTurnId();
  mcpReplyCalled = false;
  suppressTurnOutput = false;
  activeOutputChannelId = null;
  await clearDiscordChannelScope();
  turnActive = false;
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
  const { input, msg: queuedMsg, channelId, channelScopeToken } = messageQueue.shift();
  if (queuedMsg) {
    queuedMsg.reactions.cache.get("⏳")?.users.remove(queuedMsg.client.user.id).catch(() => {});
  }
  await sendTurn(input, channelId, channelScopeToken);
}

async function sendTurn(input, channelId = CHANNEL_ID, channelScopeToken = null) {
  if (!threadId) {
    messageQueue.push({ input, msg: null, channelId, channelScopeToken });
    return;
  }
  turnActive = true;
  activeOutputChannelId = channelId;
  deltaBuffer = "";
  fallbackText = "";
  mcpReplyCalled = false;
  resetActiveTurnId();
  try {
    await activateDiscordChannelScope(channelScopeToken);
    await startTyping(channelId);
    const result = await sendRequest("turn/start", {
      threadId,
      input,
      approvalPolicy: "never",
    });
    recordExpectedTurnId(result);
  } catch (err) {
    console.error("turn/start failed:", err);
    stopTyping();
    resetActiveTurnId();
    fallbackText = "";
    await clearDiscordChannelScope();
    turnActive = false;
    await sendToDiscord("**Error:** Failed to send message to Codex");
    activeOutputChannelId = null;
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
  fallbackText = "";
  mcpReplyCalled = false;
  suppressTurnOutput = true;
  resetActiveTurnId();
  try {
    const result = await sendRequest("turn/start", {
      threadId,
      input: [{ type: "text", text: SYSTEM_INSTRUCTION }],
      approvalPolicy: "never",
    });
    recordExpectedTurnId(result);
    for (let i = 0; i < 150 && turnActive; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    deltaBuffer = "";
    fallbackText = "";
    if (turnActive) {
      turnActive = false;
      resetActiveTurnId();
      fallbackText = "";
      mcpReplyCalled = false;
      suppressTurnOutput = false;
      processQueue();
    }
    console.log(`Bootstrap instruction sent${reason ? ` (${reason})` : ""}`);
  } catch (err) {
    console.error(`Bootstrap instruction failed${reason ? ` (${reason})` : ""}:`, err);
    turnActive = false;
    resetActiveTurnId();
    fallbackText = "";
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
  activeOutputChannelId = null;
}

const TEXT_EXTENSIONS = new Set([
  ".txt", ".md", ".json", ".js", ".ts", ".py", ".sh", ".yml", ".yaml",
  ".toml", ".cfg", ".ini", ".csv", ".xml", ".html", ".css", ".sql",
  ".rs", ".go", ".java", ".c", ".cpp", ".h", ".rb", ".php", ".swift",
  ".kt", ".scala", ".r", ".lua", ".pl", ".ex", ".exs", ".hs", ".ml",
  ".env", ".log", ".diff", ".patch", ".jsx", ".tsx", ".vue", ".svelte",
]);
const AUDIO_EXTENSIONS = new Set([
  ".aac", ".flac", ".m4a", ".mp3", ".oga", ".ogg", ".opus", ".wav", ".weba",
]);

function attachmentExtension(att) {
  const name = att.name || "";
  return name.includes(".") ? "." + name.split(".").pop().toLowerCase() : "";
}

function isTextFile(att) {
  if (att.contentType && att.contentType.startsWith("text/")) return true;
  if (att.contentType === "application/json") return true;
  return TEXT_EXTENSIONS.has(attachmentExtension(att));
}

function isAudioFile(att) {
  if (att.contentType && att.contentType.startsWith("audio/")) return true;
  return AUDIO_EXTENSIONS.has(attachmentExtension(att));
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

async function downloadTempAttachment(url, filename) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "codex-bridge-audio-"));
  const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, "_") || "audio";
  const filePath = path.join(dir, safeName);
  const res = await fetch(url);
  if (!res.ok) {
    await rm(dir, { recursive: true, force: true });
    return null;
  }
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(filePath, buf);
  return { dir, filePath };
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(
          new Error(
            `${command} exited with code ${code}${stderr.trim() ? `: ${stderr.trim()}` : ""}`
          )
        );
      }
    });
  });
}

async function transcribeAudioAttachment(att) {
  const downloaded = await downloadTempAttachment(att.url, att.name || "audio");
  if (!downloaded) return null;
  const outputDir = path.join(downloaded.dir, "out");
  await mkdir(outputDir, { recursive: true });
  try {
    const args = [
      downloaded.filePath,
      "--model",
      AUDIO_TRANSCRIPTION_MODEL,
      "--output_format",
      "txt",
      "--output_dir",
      outputDir,
    ];
    if (AUDIO_TRANSCRIPTION_LANGUAGE) {
      args.push("--language", AUDIO_TRANSCRIPTION_LANGUAGE);
    }
    await runCommand(AUDIO_TRANSCRIPTION_COMMAND, args);
    const transcriptPath = path.join(
      outputDir,
      `${path.parse(downloaded.filePath).name}.txt`
    );
    return (await readFile(transcriptPath, "utf8")).trim();
  } finally {
    await rm(downloaded.dir, { recursive: true, force: true });
  }
}

function rootRoutingContext(msg, text, channelScopeToken) {
  const channelName = msg.channel?.name || msg.channel?.id || "unknown";
  return [
    "Discord routing metadata:",
    `channel_id: ${msg.channel.id}`,
    `channel_name: ${channelName}`,
    `message_id: ${msg.id}`,
    `author_id: ${msg.author.id}`,
    `author_name: ${msg.author.username}`,
    `reply_mcp_server: ${DISCORD_MCP_NAME}`,
    `reply_channel_id: ${msg.channel.id}`,
    `channel_scope_token: ${channelScopeToken}`,
    "",
    "Use the reply_mcp_server with reply_channel_id and channel_scope_token for every Discord MCP call for this message.",
    "",
    "Message:",
    text || "(no text)",
  ].join("\n");
}

async function buildInput(msg, textOverride = null) {
  const input = [];
  const text = textOverride ?? msg.content.trim();
  const channelScopeToken = ROOT_MULTI_CHANNEL
    ? createDiscordChannelScopeToken(msg)
    : null;
  if (ROOT_MULTI_CHANNEL) {
    input.push({ type: "text", text: rootRoutingContext(msg, text, channelScopeToken) });
  } else if (text) {
    input.push({ type: "text", text });
  }
  for (const att of msg.attachments.values()) {
    if (att.contentType && att.contentType.startsWith("image/")) {
      input.push({ type: "image", url: att.url });
    } else if (AUDIO_TRANSCRIPTION_ENABLED && isAudioFile(att)) {
      try {
        const transcript = await transcribeAudioAttachment(att);
        if (transcript) {
          input.push({
            type: "text",
            text: `--- Audio transcription: ${att.name} ---\n${transcript}\n--- End audio transcription ---`,
          });
        } else {
          input.push({
            type: "text",
            text: `[Audio attachment could not be transcribed: ${att.name}]`,
          });
        }
      } catch (err) {
        input.push({
          type: "text",
          text: `[Audio attachment could not be transcribed: ${att.name} (${err.message || err})]`,
        });
      }
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
  return { input, channelScopeToken };
}

async function registerDiscordMcp() {
  const mcpName = DISCORD_MCP_NAME;

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
      env: {
        BOT_TOKEN,
        CHANNEL_ID,
        DISCORD_REPLY_TOKEN,
        ...(ROOT_MULTI_CHANNEL ? {
          DISCORD_CHANNEL_OVERRIDE: "1",
          DISCORD_ACCESS_FILE: ROOT_ACCESS_FILE,
          DISCORD_CHANNEL_SCOPE_FILE: discordChannelScopeFile,
          DISCORD_CHANNEL_SCOPE_SECRET,
          DISCORD_GLOBAL_USER_IDS: [...ALLOWED_USER_IDS].join(","),
        } : {}),
      },
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
    developerInstructions: THREAD_INSTRUCTION,
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
  discordClient = client;

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
    if (ROOT_MULTI_CHANNEL) {
      console.log(`Root routing active for ${rootChannelAccess.size} configured channel(s)`);
    }
  });

  client.on("messageCreate", async (msg) => {
    if (!(await shouldHandleDiscordMessage(msg))) return;

    const channelId = msg.channel.id;
    const text = stripThisBotMention(msg.content.trim());
    const bridgeSlashCommand = !ROOT_MULTI_CHANNEL || channelId === CHANNEL_ID;

    if (bridgeSlashCommand && text === "/compact") {
      console.log("[discord] /compact requested");
      await msg.react("🔄");
      activeOutputChannelId = channelId;
      try {
        await sendRequest("thread/compact/start", { threadId });
        await sendToDiscord("Compaction started.", channelId);
      } catch (err) {
        await sendToDiscord(`**Error:** Failed to compact — ${err.message || err}`, channelId);
      }
      return;
    }

    if (bridgeSlashCommand && text === "/clear") {
      console.log("[discord] /clear requested");
      await msg.react("🔄");
      threadResetting = true;
      activeOutputChannelId = channelId;
      const previousThreadId = threadId;
      const previousTurnId = activeTurnId;
      try {
        messageQueue = [];
        if (previousThreadId && (previousTurnId || turnActive)) {
          try {
            const interruptParams = { threadId: previousThreadId };
            if (previousTurnId) interruptParams.turnId = previousTurnId;
            await sendRequest("turn/interrupt", interruptParams);
            console.log(`[clear] Interrupted turn ${previousTurnId || "(active)"}`);
          } catch (err) {
            console.log(`Warning: failed to interrupt active turn before clear: ${err.message || err}`);
          }
        }
        if (previousThreadId) {
          await sendRequest("thread/archive", { threadId: previousThreadId });
        }
        threadId = null;
        turnActive = false;
        resetActiveTurnId();
        mcpReplyCalled = false;
        suppressTurnOutput = false;
        pendingBootstrapInstructionReason = null;
        deltaBuffer = "";
        fallbackText = "";
        stopTyping();
        await clearDiscordChannelScope();

        await registerDiscordMcp();
        await startCodexThread();
        await sendBootstrapInstructionTurn("clear");

        await sendToDiscord("Conversation cleared — fresh thread started.", channelId);
        console.log(`New thread after /clear: ${threadId}`);
        threadResetting = false;
        activeOutputChannelId = null;
        processQueue();
      } catch (err) {
        threadResetting = false;
        turnActive = false;
        resetActiveTurnId();
        fallbackText = "";
        await clearDiscordChannelScope();
        await sendToDiscord(`**Error:** Failed to clear — ${err.message || err}`, channelId);
        activeOutputChannelId = null;
        processQueue();
      }
      return;
    }

    if (bridgeSlashCommand && text === "/restart") {
      console.log("[discord] /restart requested");
      await msg.react("🔄");
      try {
        if (ROOT_MULTI_CHANNEL) {
          const logPath = scheduleRootRestart();
          await sendToDiscord("Restarting root session — fresh thread coming up.", channelId);
          console.log(`Root restart scheduled; log: ${logPath}`);
          cleanup();
          return;
        }
        const { projectName, screenName } = await findCurrentProject();
        const logPath = scheduleRestart(projectName, screenName);
        await sendToDiscord("Restarting session — fresh thread coming up.", channelId);
        console.log(`Restart scheduled for '${projectName}' (${screenName}); log: ${logPath}`);
        cleanup();
      } catch (err) {
        await sendToDiscord(`**Error:** Failed to restart — ${err.message || err}`, channelId);
      }
      return;
    }

    const { input, channelScopeToken } = await buildInput(msg, text);
    if (input.length === 0) return;

    console.log(`[discord] ${msg.author.username}: ${text || "(attachment)"} [${input.length} part(s)]`);

    if (threadResetting) {
      messageQueue.push({ input, msg, channelId, channelScopeToken });
      await msg.react("⏳");
    } else if (ROOT_MULTI_CHANNEL && turnActive) {
      messageQueue.push({ input, msg, channelId, channelScopeToken });
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
        messageQueue.push({ input, msg, channelId, channelScopeToken });
        await msg.react("⏳");
      }
    } else if (turnActive) {
      messageQueue.push({ input, msg, channelId, channelScopeToken });
      await msg.react("⏳");
    } else {
      await sendTurn(input, channelId, channelScopeToken);
    }
  });

  client.login(BOT_TOKEN);

  function cleanup() {
    console.log("Shutting down...");
    client.destroy();
    if (ws) ws.close();
    if (codexProcess) codexProcess.kill();
    if (discordChannelScopeDir) {
      rmSync(discordChannelScopeDir, { recursive: true, force: true });
    }
    process.exit(0);
  }

  process.on("SIGTERM", cleanup);
  process.on("SIGINT", cleanup);
  process.on("SIGHUP", cleanup);
}

async function main() {
  await loadRootAccess();
  await initializeDiscordChannelScope();
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
