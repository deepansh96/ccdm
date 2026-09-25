#!/usr/bin/env node

const { Client, GatewayIntentBits, Partials } = require("discord.js");
const { spawn } = require("child_process");
const { createHmac, randomBytes } = require("crypto");
const { writeFile, mkdir, mkdtemp, readFile, rm, rename } = require("fs/promises");
const { rmSync } = require("fs");
const os = require("os");
const path = require("path");
const WebSocket = require("ws");

const MCP_SERVER_SCRIPT = path.resolve(__dirname, "discord-mcp-server.js");
const ROOT_DIR = path.resolve(__dirname, "..");
const REGISTRY_PATH = path.join(ROOT_DIR, "registry.json");
const REMINDER_STATE_DIR = process.env.CCDM_REMINDER_STATE_DIR || path.join(os.homedir(), ".local", "state", "ccdm", "conversation-reminders");
const REMINDER_CONTEXT_FILE = path.join(REMINDER_STATE_DIR, `active-codex-${process.pid}.json`);
const REMINDER_RECEIPTS_DIR = path.join(REMINDER_STATE_DIR, "receipts");
process.env.CCDM_REMINDER_PROJECT_ROOT = ROOT_DIR;
process.env.CCDM_REMINDER_STATE_DIR = REMINDER_STATE_DIR;
process.env.CCDM_REMINDER_CONTEXT_FILE = REMINDER_CONTEXT_FILE;
process.env.CCDM_REMINDER_RECEIPTS_DIR = REMINDER_RECEIPTS_DIR;
const reminderAdapter = require("./conversation-reminder-adapter.js");

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
const FORWARDED_REACTIONS = new Set(["👍", "👎"]);

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
let bootstrapCompletion = null;
let activeTurnId = null;
let activeTurnIdConfirmed = false;
let mcpReplyCalled = false;
let suppressTurnOutput = false;
let pendingBootstrapInstructionReason = null;
let pendingCompactionChannelId = null;
let messageQueue = [];
let bridgePaused = false;
let discordClient = null;
let discordChannel = null;
let codexProcess = null;
let typingInterval = null;
let activeOutputChannelId = null;
let activeTypingChannel = null;
let threadResetting = false;
let lastNicknameUpdate = 0;
let fallbackLoggedCompletedItemTypes = new Set();
let pendingTerminalError = null;
let activeTurnHadProgress = false;
let activeTurnRecoveryAttempt = 0;
let activeTurnChannelScopeToken = null;
let activeReminderContext = null;
// The owner's latest normal message is the Project Conversation's current
// interaction; a reaction-started turn continues that interaction.
let lastOwnerInteraction = null;
let lastResumedInputReceiptId = null;
let pendingInputNeededResumeTurnId = null;
let rootAccess = null;
let rootChannelAccess = new Map();
let bridgeStopping = false;
let sessionTerminationPromise = null;
let discordChannelScopeDir = null;
let discordChannelScopeFile = null;
const NICKNAME_INTERVAL = 60000;
const STREAM_FAILURE_MESSAGE =
  "stream disconnected before completion: response.failed event received";
const STREAM_RECOVERY_PROMPT =
  "Retry the previous user request. The prior model response failed before any work began.";
const DISCORD_MCP_NAME = ROOT_MULTI_CHANNEL ? "discord-root" : `discord-${CHANNEL_ID}`;
const THREAD_INSTRUCTION = ROOT_MULTI_CHANNEL
  ? `This root thread is connected to Discord through the ${DISCORD_MCP_NAME} MCP server. Incoming messages include Discord routing metadata. Do not call Discord MCP tools unless the current task includes an explicit Discord reply scope token. Subagents and delegated tasks must return results to their parent agent, not to Discord.`
  : `This thread is connected to Discord through the ${DISCORD_MCP_NAME} MCP server. Do not call Discord MCP tools unless the current task includes an explicit Discord reply scope token. Subagents and delegated tasks must return results to their parent agent, not to Discord.`;
const SYSTEM_INSTRUCTION = ROOT_MULTI_CHANNEL
  ? `You are communicating with the user via Discord. Use ONLY the MCP server named "${DISCORD_MCP_NAME}" to interact. Incoming messages include a Discord routing metadata block; use its channel_id and channel_scope_token for every Discord MCP call. Every Discord write call (\`reply\`, \`edit_message\`, or \`react\`) must also include \`scope_token: "${DISCORD_REPLY_TOKEN}"\`. Do NOT share these tokens with subagents. When spawning subagents, explicitly tell them not to use Discord MCP/tools and to return only to the parent agent. Do NOT use any other discord MCP server. Do NOT output responses as regular text; always use the \`reply\` tool so the user sees your response on Discord. Other available tools on this same server: edit_message, react, fetch_messages, read_last_x_messages_in_channel, export_message_range, download_attachment. Use \`reply\` with the \`files\` parameter to send file attachments. You don't have to reply for every little thing. Try to reply only when you're done, unless something important needs to be confirmed from the user. Also, try to use simpler language and avoid complex language.`
  : `You are communicating with the user via Discord. Use ONLY the MCP server named "${DISCORD_MCP_NAME}" to interact — call its \`reply\` tool to send messages to the user. Every Discord write call (\`reply\`, \`edit_message\`, or \`react\`) must include \`scope_token: "${DISCORD_REPLY_TOKEN}"\`. Do NOT share this scope token with subagents. When spawning subagents, explicitly tell them not to use Discord MCP/tools and to return only to the parent agent. Do NOT use any other discord MCP server. Do NOT output responses as regular text; always use the \`reply\` tool so the user sees your response on Discord. Other available tools on this same server: edit_message, react, fetch_messages, read_last_x_messages_in_channel, export_message_range, download_attachment. Use \`reply\` with the \`files\` parameter to send file attachments. You don't have to reply for every little thing. Try to reply only when you're done, unless something important needs to be confirmed from the user. Also, try to use simpler language and avoid complex language.`;

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

function canReconcileTurnId(msg) {
  return TURN_ID_RECONCILIATION_METHODS.has(msg.method) ||
    (msg.method === "item/completed" && isFallbackMessageItem(msg.params?.item));
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
    if (!canReconcileTurnId(msg)) {
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
  if (!activeTurnIdConfirmed && canReconcileTurnId(msg)) {
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

function isCloseCommand(content) {
  const trimmed = (content || "").trim();
  if (trimmed === "/close") return true;
  for (const appId of [BOT_APP_ID, ROOT_BOT_APP_ID]) {
    if (appId && new RegExp(`^<@!?${escapeRegExp(appId)}>\\s+/close$`).test(trimmed)) return true;
  }
  return false;
}

function reminderEventContext(assignment) {
  return {
    ...assignment,
    provider: ROOT_MULTI_CHANNEL ? "ccdm-root" : "codex",
    ...(threadId ? { provider_session_id: threadId } : {}),
    ...(activeTurnId ? { provider_turn_id: activeTurnId } : {}),
  };
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

async function shouldHandleDiscordReaction(reaction, user) {
  if (user.bot) return false;
  const channelId = reaction.message.channelId || reaction.message.channel?.id;
  if (!channelId) return false;
  if (!ROOT_MULTI_CHANNEL) {
    return channelId === CHANNEL_ID &&
      (ALLOWED_USER_IDS.size === 0 || ALLOWED_USER_IDS.has(user.id));
  }

  try {
    await loadRootAccess(false);
  } catch (err) {
    console.error(`Root access reload failed: ${err.message || err}`);
    return false;
  }

  const channelConfig = rootChannelAccess.get(channelId);
  if (!channelConfig) return false;
  const allowed = allowedRootUsersFor(channelConfig);
  return allowed.size === 0 || allowed.has(user.id);
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
  const sent = [];
  for (const chunk of chunks) {
    sent.push(await channel.send(chunk));
  }
  return sent;
}

function recordSessionTermination() {
  if (!threadId || ROOT_MULTI_CHANNEL) return Promise.resolve();
  if (!sessionTerminationPromise) {
    const endingThreadId = threadId;
    const endingTurnId = activeTurnId;
    sessionTerminationPromise = (async () => {
      const assignment = await reminderAdapter.resolveAssignmentForChannel(CHANNEL_ID, {
        requireCodex: true,
        ...(BOT_APP_ID ? { botAppId: BOT_APP_ID } : {}),
      }).catch(() => null);
      if (!assignment) return;
      await reminderAdapter.emitEvent("session_terminated", {
        ...assignment,
        provider: "codex",
        provider_session_id: endingThreadId,
        ...(endingTurnId ? { provider_turn_id: endingTurnId } : {}),
      }).catch((error) => console.error(`Conversation termination event failed: ${error.message || error}`));
    })();
  }
  return sessionTerminationPromise;
}

async function exitAfterRuntimeLoss(reason) {
  if (bridgeStopping) return;
  bridgeStopping = true;
  console.error(reason);
  await recordSessionTermination();
  process.exit(1);
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
    void exitAfterRuntimeLoss(`Codex app-server exited with code ${code}`);
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
    void exitAfterRuntimeLoss("WebSocket closed");
  });
}

function handleNotification(msg) {
  switch (msg.method) {
    case "item/agentMessage/delta":
      if (!isCurrentTurnNotification(msg)) break;
      deltaBuffer += msg.params.delta;
      break;

    case "turn/completed":
      if (!turnActive || !notificationTurnId(msg)) break;
      if (!isCurrentTurnNotification(msg)) break;
      onTurnCompleted(msg.params?.turn);
      break;

    case "error":
      if (!isCurrentTurnNotification(msg)) break;
      console.error("Codex error:", JSON.stringify(msg.params));
      if (msg.params.willRetry === false) {
        const errorText = msg.params.error?.message || "Codex encountered an error";
        stopTyping();
        pendingTerminalError = {
          errorText,
          recover:
            !suppressTurnOutput &&
            errorText === STREAM_FAILURE_MESSAGE &&
            !activeTurnHadProgress &&
            activeTurnRecoveryAttempt === 0,
        };
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
      if (msg.params?.item?.type !== "userMessage") {
        activeTurnHadProgress = true;
      }
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

async function flushTextReplyFallback() {
  const text = deltaBuffer.trim() || fallbackText.trim();
  deltaBuffer = "";
  fallbackText = "";
  if (text) {
    const sent = await sendToDiscord(text);
    if (activeReminderContext) {
      for (const message of sent || []) {
        await reminderAdapter.recordDeliveredReply(activeReminderContext, message.id);
      }
    }
  }
}

async function onTurnCompleted(turn = {}) {
  stopTyping();
  const outputSuppressed = suppressTurnOutput;
  const terminalError = pendingTerminalError || (outputSuppressed && ["failed", "interrupted"].includes(turn.status)
    ? { errorText: turn.error?.message || `Bootstrap ${turn.status}`, recover: false }
    : null);
  const recoveryAttempt = activeTurnRecoveryAttempt;
  const channelScopeToken = activeTurnChannelScopeToken;
  const channelId = activeOutputChannelId || CHANNEL_ID;
  if (terminalError || outputSuppressed) {
    deltaBuffer = "";
    fallbackText = "";
  } else if ((turn.status === "completed" || turn.status === undefined) && !mcpReplyCalled && TEXT_REPLY_FALLBACK) {
    await flushTextReplyFallback();
  } else {
    deltaBuffer = "";
    fallbackText = "";
  }
  const completedContext = activeReminderContext;
  const turnReceipts = completedContext
    ? await reminderAdapter.receiptsForTurn(completedContext.provider_session_id, completedContext.provider_turn_id)
    : [];
  const latestQuestion = turnReceipts.filter((receipt) => receipt.disposition === "input-needed").at(-1);
  if (latestQuestion && latestQuestion.event_id !== lastResumedInputReceiptId) {
    pendingInputNeededResumeTurnId = completedContext.provider_turn_id;
  }
  if (!terminalError && !outputSuppressed && turn.status === "completed" && completedContext) {
    const receipts = turnReceipts
      .filter((receipt) => receipt.interaction_id === completedContext.interaction_id);
    if (receipts.length > 0) {
      await reminderAdapter.emitEvent("turn_completed", completedContext, {
        delivered_message_ids: receipts.map((receipt) => receipt.message_id),
        source_message_id: completedContext.source_message_id,
      });
    }
  }
  if (completedContext) await reminderAdapter.removeTurnReceipts(completedContext.provider_session_id, completedContext.provider_turn_id);
  activeReminderContext = null;
  await reminderAdapter.clearActiveContext();
  resetActiveTurnId();
  mcpReplyCalled = false;
  suppressTurnOutput = false;
  pendingTerminalError = null;
  activeTurnHadProgress = false;
  activeTurnRecoveryAttempt = 0;
  activeTurnChannelScopeToken = null;
  activeOutputChannelId = null;
  await clearDiscordChannelScope();
  turnActive = false;
  if (outputSuppressed && bootstrapCompletion) {
    const complete = bootstrapCompletion;
    bootstrapCompletion = null;
    if (terminalError) bridgePaused = true;
    complete(terminalError);
  }
  if (terminalError?.recover) {
    console.log("Retrying terminal response.failed turn once");
    // The retry answers the same owner interaction; sendTurn binds it to the
    // retry's own turn ID so its reply and completion stay correlated.
    const retrySource = completedContext
      ? {
        id: completedContext.interaction_id,
        author: { id: completedContext.initiator_id },
        reminderAssignment: completedContext,
        synthetic: true,
      }
      : null;
    await sendTurn(
      [{ type: "text", text: STREAM_RECOVERY_PROMPT }],
      channelId,
      channelScopeToken,
      recoveryAttempt + 1,
      retrySource
    );
    return;
  }
  if (terminalError && !outputSuppressed) {
    await sendToDiscord(`**Error:** ${terminalError.errorText}`, channelId);
  }
  const bootstrapReason = pendingBootstrapInstructionReason;
  pendingBootstrapInstructionReason = null;
  if (bootstrapReason) {
    sendBootstrapInstructionTurn(bootstrapReason);
  } else if (pendingCompactionChannelId) {
    const channelId = pendingCompactionChannelId;
    pendingCompactionChannelId = null;
    startCompaction(channelId);
  } else {
    processQueue();
  }
}

async function processQueue() {
  if (bridgePaused || threadResetting || turnActive || !threadId || messageQueue.length === 0) return;
  const { input, msg: queuedMsg, channelId, channelScopeToken } = messageQueue.shift();
  if (queuedMsg && !queuedMsg.synthetic) {
    queuedMsg.reactions.cache.get("⏳")?.users.remove(queuedMsg.client.user.id).catch(() => {});
  }
  await sendTurn(input, channelId, channelScopeToken, 0, queuedMsg);
}

function canSteerRootScope(channelId, token) {
  if (channelId !== activeOutputChannelId || !token || !activeTurnChannelScopeToken) return false;
  try {
    // Both tokens were minted locally. Keep the active grant unchanged while tools run.
    const incoming = JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString());
    const active = JSON.parse(Buffer.from(activeTurnChannelScopeToken.split(".")[0], "base64url").toString());
    return incoming.channel_id === active.channel_id && incoming.author_id === active.author_id;
  } catch {
    return false;
  }
}

async function routeInput(input, msg, channelId, channelScopeToken) {
  const queueInput = async () => {
    messageQueue.push({ input, msg, channelId, channelScopeToken });
    if (msg && !msg.synthetic) await msg.react("⏳");
  };

  const rootScopeMatches = ROOT_MULTI_CHANNEL && canSteerRootScope(channelId, channelScopeToken);
  if (bridgePaused || threadResetting || (ROOT_MULTI_CHANNEL && turnActive && !rootScopeMatches)) {
    await queueInput();
  } else if (turnActive && activeTurnId && !suppressTurnOutput) {
    try {
      // Reuse this turn's grant, so in-flight tool calls and the correction remain valid.
      // Queue fallback retains the original input and its own grant for the next turn.
      const steerInput = rootScopeMatches
        ? input.map((part, index) => index === 0 && part.type === "text"
          ? { ...part, text: part.text.replace(
            `channel_scope_token: ${channelScopeToken}`,
            `channel_scope_token: ${activeTurnChannelScopeToken}`,
          ) }
          : part)
        : input;
      await sendRequest("turn/steer", {
        threadId,
        input: steerInput,
        expectedTurnId: activeTurnId,
      });
      if (msg && activeReminderContext && msg.author.id === activeReminderContext.owner_id) {
        const receipts = await reminderAdapter.receiptsForTurn(activeReminderContext.provider_session_id, activeReminderContext.provider_turn_id);
        const latestQuestion = receipts.filter((receipt) => receipt.disposition === "input-needed").at(-1);
        if (latestQuestion && latestQuestion.event_id !== lastResumedInputReceiptId) {
          await reminderAdapter.emitEvent("work_resumed", activeReminderContext, {
            source_message_id: msg.id,
            resumed_from_turn_id: activeReminderContext.provider_turn_id,
          });
          lastResumedInputReceiptId = latestQuestion.event_id;
        }
        activeReminderContext = {
          ...activeReminderContext,
          interaction_id: msg.id,
          source_message_id: msg.id,
          initiator_id: msg.author.id,
        };
        await reminderAdapter.writeActiveContext(activeReminderContext);
      }
      console.log(`[steer] Injected into active turn ${activeTurnId}`);
    } catch (err) {
      console.log(`[steer] Failed (${err.message || err}), queuing instead`);
      await queueInput();
    }
  } else if (turnActive) {
    await queueInput();
  } else {
    await sendTurn(input, channelId, channelScopeToken, 0, msg);
  }
}

async function sendTurn(
  input,
  channelId = CHANNEL_ID,
  channelScopeToken = null,
  recoveryAttempt = 0,
  sourceMessage = null
) {
  if (!threadId) {
    messageQueue.push({ input, msg: sourceMessage, channelId, channelScopeToken });
    return;
  }
  turnActive = true;
  activeOutputChannelId = channelId;
  deltaBuffer = "";
  fallbackText = "";
  mcpReplyCalled = false;
  pendingTerminalError = null;
  activeTurnHadProgress = false;
  activeTurnRecoveryAttempt = recoveryAttempt;
  activeTurnChannelScopeToken = channelScopeToken;
  activeReminderContext = null;
  lastResumedInputReceiptId = null;
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
    if (sourceMessage?.reminderAssignment && activeTurnId) {
      activeReminderContext = {
        ...sourceMessage.reminderAssignment,
        provider: "codex",
        provider_session_id: threadId,
        provider_turn_id: activeTurnId,
        interaction_id: sourceMessage.id,
        source_message_id: sourceMessage.id,
        initiator_id: sourceMessage.author.id,
      };
      await reminderAdapter.writeActiveContext(activeReminderContext);
      if (pendingInputNeededResumeTurnId) {
        await reminderAdapter.emitEvent("work_resumed", activeReminderContext, {
          source_message_id: sourceMessage.id,
          resumed_from_turn_id: pendingInputNeededResumeTurnId,
        });
        pendingInputNeededResumeTurnId = null;
      }
    }
  } catch (err) {
    console.error("turn/start failed:", err);
    stopTyping();
    resetActiveTurnId();
    fallbackText = "";
    pendingTerminalError = null;
    activeTurnHadProgress = false;
    activeTurnRecoveryAttempt = 0;
    activeTurnChannelScopeToken = null;
    activeReminderContext = null;
    await reminderAdapter.clearActiveContext();
    await clearDiscordChannelScope();
    turnActive = false;
    await sendToDiscord("**Error:** Failed to send message to Codex");
    activeOutputChannelId = null;
    processQueue();
  }
}

async function sendBootstrapInstructionTurn(reason, { required = false } = {}) {
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
  pendingTerminalError = null;
  activeTurnHadProgress = false;
  activeTurnRecoveryAttempt = 0;
  activeTurnChannelScopeToken = null;
  resetActiveTurnId();
  const completed = new Promise((resolve) => { bootstrapCompletion = resolve; });
  try {
    const result = await sendRequest("turn/start", {
      threadId,
      input: [{ type: "text", text: `${SYSTEM_INSTRUCTION}\n\nThis message only configures the transport; it is not a user task. Do not call tools, inspect files, or send a Discord message. Reply with exactly READY as plain text; the bridge hides this acknowledgment.` }],
      approvalPolicy: "never",
    });
    recordExpectedTurnId(result);
    // A slow provider must not become locally idle while its turn is still running.
    const timeoutMs = Number(process.env.CODEX_BOOTSTRAP_TIMEOUT_MS || 60000);
    let timer;
    const outcome = await Promise.race([
      completed,
      new Promise((resolve) => { timer = setTimeout(() => resolve("timeout"), timeoutMs); }),
    ]);
    clearTimeout(timer);
    if (outcome === "timeout") {
      // Stop accepting/processing work before cancellation, even if acknowledgment is late.
      bridgePaused = true;
      await sendRequest("turn/interrupt", { threadId, turnId: activeTurnId });
      throw new Error("Bootstrap timed out; active turn interrupted. Restart the session.");
    }
    if (outcome) throw new Error(outcome.errorText || "Bootstrap turn failed");
    console.log(`Bootstrap instruction sent${reason ? ` (${reason})` : ""}`);
  } catch (err) {
    console.error(`Bootstrap instruction failed${reason ? ` (${reason})` : ""}:`, err);
    turnActive = false;
    resetActiveTurnId();
    fallbackText = "";
    mcpReplyCalled = false;
    suppressTurnOutput = false;
    bootstrapCompletion = null;
    if (required || bridgePaused) throw err;
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

async function startCompaction(channelId) {
  turnActive = true;
  suppressTurnOutput = true;
  activeOutputChannelId = channelId;
  resetActiveTurnId();
  try {
    await sendRequest("thread/compact/start", { threadId });
    await sendToDiscord("Compaction started.", channelId);
  } catch (err) {
    turnActive = false;
    suppressTurnOutput = false;
    resetActiveTurnId();
    await sendToDiscord(`**Error:** Failed to compact — ${err.message || err}`, channelId);
    activeOutputChannelId = null;
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

async function fetchAttachmentDataUrl(url, contentType) {
  const res = await fetch(url);
  if (!res.ok) return null;
  const type = contentType || res.headers.get("content-type") || "application/octet-stream";
  const data = Buffer.from(await res.arrayBuffer()).toString("base64");
  return `data:${type};base64,${data}`;
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
    `channel_scope_token: ${channelScopeToken}`,
    "",
    "Use the reply_mcp_server with channel_id and channel_scope_token for every Discord MCP call for this message.",
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
      const dataUrl = await fetchAttachmentDataUrl(att.url, att.contentType);
      if (dataUrl) input.push({ type: "image", url: dataUrl });
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

function buildReactionInput(reaction, user) {
  const channelId = reaction.message.channelId || reaction.message.channel.id;
  const source = reaction.message.content.trim().replace(/\s+/g, " ");
  const excerpt = source.length > 80 ? `${source.slice(0, 77)}...` : source;
  const text = `User ${user.globalName || user.username || user.id} reacted ${reaction.emoji.name} to your message${excerpt ? `: "${excerpt}"` : ""} (message ID: ${reaction.message.id}).`;
  const msg = {
    id: reaction.message.id,
    author: user,
    channel: { id: channelId, name: reaction.message.channel?.name },
  };
  const channelScopeToken = ROOT_MULTI_CHANNEL
    ? createDiscordChannelScopeToken(msg)
    : null;
  return {
    channelId,
    channelScopeToken,
    input: [{
      type: "text",
      text: ROOT_MULTI_CHANNEL ? rootRoutingContext(msg, text, channelScopeToken) : text,
    }],
  };
}

async function listMcpServers() {
  const servers = [];
  let cursor;
  do {
    const page = await sendRequest("mcpServerStatus/list", { detail: "full", ...(cursor ? { cursor } : {}) });
    servers.push(...(page?.data || page?.servers || page?.items || []));
    cursor = page?.nextCursor;
  } while (cursor);
  return servers;
}

async function registerDiscordMcp() {
  const mcpName = DISCORD_MCP_NAME;

  // Remove any other discord MCP servers to prevent cross-session replies
  try {
    const servers = await listMcpServers();
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
        CCDM_REMINDER_PROJECT_ROOT: ROOT_DIR,
        CCDM_REMINDER_STATE_DIR: REMINDER_STATE_DIR,
        CCDM_REMINDER_CONTEXT_FILE: REMINDER_CONTEXT_FILE,
        CCDM_REMINDER_RECEIPTS_DIR: REMINDER_RECEIPTS_DIR,
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

  const deadline = Date.now() + Number(process.env.CODEX_MCP_READY_TIMEOUT_MS || 30000);
  do {
    const servers = await listMcpServers();
    const found = servers.find((s) => (s.name || s.id) === mcpName);
    const tools = found?.tools;
    const hasReply = Array.isArray(tools)
      ? tools.some((tool) => tool.name === "reply")
      : tools && Object.values(tools).some((tool) => tool.name === "reply");
    if (hasReply) {
      console.log(`MCP server ready: ${mcpName} (reply tool available)`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  throw new Error(`Discord MCP ${mcpName} did not expose the reply tool before startup deadline`);
}

async function startCodexThread(resumeThreadId = "") {
  const result = await sendRequest(resumeThreadId ? "thread/resume" : "thread/start", {
    ...(resumeThreadId ? { threadId: resumeThreadId } : {}),
    cwd: PROJECT_DIR,
    sandbox: "danger-full-access",
    approvalPolicy: "never",
    developerInstructions: `${THREAD_INSTRUCTION} Use the exposed Discord MCP tools directly. If a tool is deferred, discover it through tool search first. Never reconstruct the Discord transport through shell commands, read its credentials or scope files, or launch a replacement MCP server to send a reply.`,
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

  const resumeThreadId = process.env.CODEX_RESUME_THREAD_ID || "";
  await startCodexThread(resumeThreadId);
  await sendBootstrapInstructionTurn("startup", { required: true });
  console.log(`Codex thread started: ${threadId}`);
}

function startDiscordBot() {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildMessageReactions,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Message, Partials.Reaction, Partials.User],
  });
  discordClient = client;

  client.once("ready", async () => {
    try {
      console.log(`Discord bot logged in as ${client.user.tag}`);
      discordChannel = client.channels.cache.get(CHANNEL_ID) || await client.channels.fetch(CHANNEL_ID);
      if (!discordChannel) throw new Error("Discord channel unavailable");
      console.log(`Listening in #${discordChannel.name}`);
      if (process.env.CODEX_STARTUP_READY_FILE) {
        const readyFile = process.env.CODEX_STARTUP_READY_FILE;
        await writeFile(`${readyFile}.tmp`, "ready\n", { mode: 0o600 });
        await rename(`${readyFile}.tmp`, readyFile);
      }
      if (ROOT_MULTI_CHANNEL) {
        console.log(`Root routing active for ${rootChannelAccess.size} configured channel(s)`);
      }
    } catch (err) {
      console.error("Discord startup failed:", err);
      process.exit(1);
    }
  });

  client.on("messageReactionAdd", async (reaction, user) => {
    if (!(await shouldHandleDiscordReaction(reaction, user))) return;
    try {
      if (user.partial) await user.fetch();
      if (reaction.partial) await reaction.fetch();
      if (reaction.message.partial) await reaction.message.fetch();
    } catch (err) {
      console.log(`[discord] Failed to fetch reaction context: ${err.message || err}`);
      return;
    }
    if (user.bot) return;
    const reactionChannelId = reaction.message.channelId || reaction.message.channel?.id;
    const assignment = await reminderAdapter.resolveAssignmentForChannel(reactionChannelId, {
      requireCodex: true,
      ...(!ROOT_MULTI_CHANNEL && BOT_APP_ID ? { botAppId: BOT_APP_ID } : {}),
    }).catch(() => null);
    const recordedReminder = await reminderAdapter.isRecordedReminderMessage(reaction.message.id);
    // An owner reaction, including one on a recorded reminder, acknowledges the
    // conversation; a reminder reaction never enters a coding turn.
    if (assignment && user.id === assignment.owner_id) {
      await reminderAdapter.emitEvent("owner_activity", reminderEventContext(assignment), {
        actor_id: user.id,
        source_message_id: reaction.message.id,
        activity_kind: "reaction",
        // Shared with the root observer's copy so the service counts it once.
        reaction_emoji: String(reaction.emoji.id || reaction.emoji.name || "") || undefined,
      });
    }
    if (recordedReminder) return;
    if (!FORWARDED_REACTIONS.has(reaction.emoji.name) || reaction.message.author?.id !== client.user.id) return;

    const { input, channelId, channelScopeToken } = buildReactionInput(reaction, user);
    console.log(`[discord] ${user.username}: ${reaction.emoji.name} on ${reaction.message.id}`);
    // A synthetic source message carries the reminder assignment and the
    // conversation's current interaction, so the reaction-started turn's reply
    // and completion re-arm reminders like any other owner exchange.
    const reactionSource = assignment && user.id === assignment.owner_id && !ROOT_MULTI_CHANNEL &&
      lastOwnerInteraction?.assignment_generation === assignment.assignment_generation
      ? { id: lastOwnerInteraction.id, author: user, reminderAssignment: assignment, synthetic: true }
      : null;
    await routeInput(input, reactionSource, channelId, channelScopeToken);
  });

  client.on("messageCreate", async (msg) => {
    if (!msg.author.bot && isCloseCommand(msg.content)) {
      // Root management routing reserves /close in every registered project
      // channel, whichever provider serves it; a project bridge only its own.
      const assignment = await reminderAdapter.resolveAssignmentForChannel(msg.channel.id, {
        requireCodex: !ROOT_MULTI_CHANNEL,
        ...(!ROOT_MULTI_CHANNEL && BOT_APP_ID ? { botAppId: BOT_APP_ID } : {}),
      }).catch(() => null);
      if (assignment) {
        if (msg.author.id === assignment.owner_id) {
          await reminderAdapter.emitEvent("close_requested", reminderEventContext(assignment), {
            actor_id: msg.author.id,
            source_message_id: msg.id,
            command: "/close",
          }).catch((error) => console.error(`Conversation close event failed: ${error.message || error}`));
        }
        return;
      }
    }
    if (!(await shouldHandleDiscordMessage(msg))) return;

    const channelId = msg.channel.id;
    const text = stripThisBotMention(msg.content.trim());
    const bridgeSlashCommand = !ROOT_MULTI_CHANNEL || channelId === CHANNEL_ID;
    if (bridgeSlashCommand && ["/pause", "/unpause", "/compact", "/clear", "/restart"].includes(text)) {
      const assignment = await reminderAdapter.resolveAssignmentForChannel(channelId, {
        requireCodex: true,
        ...(!ROOT_MULTI_CHANNEL && BOT_APP_ID ? { botAppId: BOT_APP_ID } : {}),
      }).catch(() => null);
      if (assignment && msg.author.id === assignment.owner_id) {
        await reminderAdapter.emitEvent("owner_activity", reminderEventContext(assignment), {
          actor_id: msg.author.id,
          source_message_id: msg.id,
          activity_kind: "management-command",
        });
      }
    }

    if (bridgeSlashCommand && text === "/pause") {
      console.log("[discord] /pause requested");
      bridgePaused = true;
      await msg.react("⏸️");
      await sendToDiscord("Bridge paused. New messages will be queued.", channelId);
      return;
    }

    if (bridgeSlashCommand && text === "/unpause") {
      console.log("[discord] /unpause requested");
      bridgePaused = false;
      processQueue();
      await msg.react("▶️");
      await sendToDiscord("Bridge unpaused.", channelId);
      return;
    }

    if (bridgeSlashCommand && text === "/compact") {
      console.log("[discord] /compact requested");
      await msg.react("🔄");
      if (turnActive) {
        pendingCompactionChannelId = channelId;
        await sendToDiscord("Compaction queued.", channelId);
      } else {
        await startCompaction(channelId);
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
        pendingCompactionChannelId = null;
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

    const assignment = await reminderAdapter.resolveAssignmentForChannel(channelId, {
      requireCodex: true,
      ...(!ROOT_MULTI_CHANNEL && BOT_APP_ID ? { botAppId: BOT_APP_ID } : {}),
    }).catch(() => null);
    if (assignment && msg.author.id === assignment.owner_id) {
      if (!ROOT_MULTI_CHANNEL) {
        msg.reminderAssignment = assignment;
        lastOwnerInteraction = { id: msg.id, assignment_generation: assignment.assignment_generation };
      }
      await reminderAdapter.emitEvent("owner_activity", reminderEventContext(assignment), {
        actor_id: msg.author.id,
        source_message_id: msg.id,
        activity_kind: ROOT_MULTI_CHANNEL && [
          `<@${ROOT_BOT_APP_ID}>`, `<@!${ROOT_BOT_APP_ID}>`,
        ].some(mention => ROOT_BOT_APP_ID && msg.content.includes(mention))
          ? "management-command"
          : msg.attachments.size > 0 && !text ? "attachment" : "message",
      });
    }

    console.log(`[discord] ${msg.author.username}: ${text || "(attachment)"} [${input.length} part(s)]`);

    await routeInput(input, msg, channelId, channelScopeToken);
  });

  client.login(BOT_TOKEN);

  let stopping = false;
  async function cleanup() {
    if (stopping) return;
    stopping = true;
    bridgeStopping = true;
    console.log("Shutting down...");
    await recordSessionTermination();
    await reminderAdapter.clearActiveContext().catch(() => {});
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
  await reminderAdapter.drainOutbox();
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
