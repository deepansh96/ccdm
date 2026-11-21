#!/usr/bin/env node
"use strict";

// Connects one Discord project channel, or one Thread Conversation, to a
// Gemini session run by the Google Antigravity CLI (agy) through its Agent
// Client Protocol (ACP) server: `agy acp`, JSON-RPC over stdio.
//
// Discord comes and goes through the Router, like the Codex bridge (the
// shared transport in codex-bridge-transport.js): the bridge holds the launch
// key file path and no Discord token. The agent reaches Discord through the
// scoped Discord MCP server (discord-mcp-server.js), which ACP starts for this
// session alone (`mcpServers` in `session/new`), so no agy config file is
// written and sibling sessions never see each other's server. The transport
// instruction is appended to the session's system prompt (agy's
// `_meta.antigravity.systemPrompt.append`), so no bootstrap turn is needed.
//
// ACP runs one prompt at a time and cannot steer a running one, so a message
// that arrives mid-turn is queued (⏳) and every queued message goes into the
// next turn together. Tool permission requests are approved, as Codex
// sessions run with approvals off. A turn that ends without a `reply` call
// but with text posts that text (GEMINI_TEXT_REPLY_FALLBACK=0 turns this
// off). The context percentage comes from ACP `usage_update`.
//
// Environment: CCDM_ROUTER_KEY_FILE, CCDM_GEMINI_PROJECT, CHANNEL_ID (the
// thread id in thread mode), PROJECT_DIR; optional GEMINI_MODEL and
// GEMINI_EFFORT (agy's model and thinking level; a model id with a level
// suffix such as gemini-4-neon-high also works), GEMINI_RESUME_SESSION_ID,
// CCDM_AGY_BIN, CCDM_CHANNEL_READY_FILE, and the thread variables
// CCDM_THREAD_ID, CCDM_THREAD_BOOTSTRAP_FILE, CCDM_THREAD_ACTIVITY_FILE and
// CCDM_THREAD_BOOT_TIMEOUT_S, which work as in the Codex bridge.

const { spawn } = require("child_process");
const { randomBytes, randomUUID } = require("crypto");
const { accessSync, constants: fsConstants, renameSync, writeFileSync } = require("fs");
const { mkdir, mkdtemp, readFile, rm, writeFile } = require("fs/promises");
const os = require("os");
const path = require("path");

const ROOT_DIR = path.resolve(__dirname, "..");
const REGISTRY_PATH = path.join(ROOT_DIR, "registry.json");
const MCP_SERVER_SCRIPT = path.resolve(__dirname, "discord-mcp-server.js");
const REMINDER_STATE_DIR = process.env.CCDM_REMINDER_STATE_DIR || path.join(os.homedir(), ".local", "state", "ccdm", "conversation-reminders");
const REMINDER_CONTEXT_FILE = path.join(REMINDER_STATE_DIR, `active-gemini-${process.pid}.json`);
const REMINDER_RECEIPTS_DIR = path.join(REMINDER_STATE_DIR, "receipts");
process.env.CCDM_REMINDER_PROJECT_ROOT = ROOT_DIR;
process.env.CCDM_REMINDER_STATE_DIR = REMINDER_STATE_DIR;
process.env.CCDM_REMINDER_CONTEXT_FILE = REMINDER_CONTEXT_FILE;
process.env.CCDM_REMINDER_RECEIPTS_DIR = REMINDER_RECEIPTS_DIR;
const reminderAdapter = require("./conversation-reminder-adapter.js");
const { createRouterTransport } = require("./codex-bridge-transport.js");
const { markPaused, markReplied, markTurn } = require("./thread-activity.js");
const routerPaths = require("./router/paths.js");

const PROVIDER = "gemini";
const CHANNEL_ID = process.env.CHANNEL_ID || "";
const PROJECT_DIR = process.env.PROJECT_DIR || "";
const ROUTER_KEY_FILE = process.env.CCDM_ROUTER_KEY_FILE || "";
const ROUTER_PROJECT = process.env.CCDM_GEMINI_PROJECT || "";
const DISCORD_THREAD_ID = process.env.CCDM_THREAD_ID || "";
const THREAD_MODE = Boolean(DISCORD_THREAD_ID);
const THREAD_ACTIVITY_FILE = THREAD_MODE ? process.env.CCDM_THREAD_ACTIVITY_FILE || "" : "";
const LAUNCH_READY_FILE = process.env.CCDM_CHANNEL_READY_FILE || "";
const ROUTER_LAUNCH_DIR = path.join(routerPaths.stateDir(), "launches", ROUTER_PROJECT,
  ...(THREAD_MODE ? ["threads", DISCORD_THREAD_ID] : []));
// agy's own defaults can change between releases; CCDM pins its own.
const DEFAULT_MODEL = "gemini-4-neon";
const DEFAULT_EFFORT = "high";
const GEMINI_MODEL = process.env.GEMINI_MODEL || DEFAULT_MODEL;
const GEMINI_EFFORT = process.env.GEMINI_EFFORT || (process.env.GEMINI_MODEL ? "" : DEFAULT_EFFORT);
const RESUME_SESSION_ID = process.env.GEMINI_RESUME_SESSION_ID || "";
const TEXT_REPLY_FALLBACK = process.env.GEMINI_TEXT_REPLY_FALLBACK !== "0";
const AUDIO_TRANSCRIPTION_ENABLED = !["0", "false", "no", "off"].includes(
  String(process.env.CODEX_BRIDGE_TRANSCRIBE_AUDIO || "").toLowerCase());
const AUDIO_TRANSCRIPTION_COMMAND = process.env.CODEX_BRIDGE_AUDIO_TRANSCRIPTION_COMMAND || "whisper";
const AUDIO_TRANSCRIPTION_MODEL = process.env.CODEX_BRIDGE_AUDIO_TRANSCRIPTION_MODEL || "turbo";
const AUDIO_TRANSCRIPTION_LANGUAGE = process.env.CODEX_BRIDGE_AUDIO_TRANSCRIPTION_LANGUAGE || "en";
const SESSION_REQUEST_TIMEOUT_MS = Number(process.env.GEMINI_SESSION_TIMEOUT_MS) || 120000;
const DISCORD_REPLY_TOKEN = randomBytes(16).toString("hex");
const DISCORD_MCP_NAME = `discord-${CHANNEL_ID}`;
const FORWARDED_REACTIONS = new Set(["👍", "👎"]);
const EFFORT_SUFFIX = /^(.+)-(low|medium|high|xhigh)$/;

if (!ROUTER_KEY_FILE || !ROUTER_PROJECT || !CHANNEL_ID || !PROJECT_DIR) {
  console.error("Missing required env vars: CCDM_ROUTER_KEY_FILE, CCDM_GEMINI_PROJECT, CHANNEL_ID, PROJECT_DIR");
  process.exit(1);
}

const SYSTEM_INSTRUCTION = [
  `You are communicating with the user via Discord. Use ONLY the MCP server named "${DISCORD_MCP_NAME}" to interact: call its \`reply\` tool to send messages to the user.`,
  `Every Discord write call (\`reply\`, \`edit_message\`, or \`react\`) must include \`scope_token: "${DISCORD_REPLY_TOKEN}"\`. Do NOT share this scope token with subagents; tell any subagent not to use Discord tools and to return only to you.`,
  "Do NOT use any other Discord MCP server. Other tools on this server: edit_message, react, fetch_messages, read_last_x_messages_in_channel, export_message_range, download_attachment" +
    (THREAD_MODE ? "." : ", create_thread.") + " Use `reply` with the `files` parameter to send file attachments.",
  "You don't have to reply for every little thing: reply when you're done, or when something must be confirmed with the user. Use simple language.",
  "Never reconstruct the Discord transport through shell commands, read its credentials, or launch a replacement MCP server to send a reply.",
].join("\n");

// ---- state ---------------------------------------------------------------

let agyProcess = null;
let acp = null;
let sessionId = null;
let configOptions = [];
let turnActive = false;
let turnReplied = false;
let turnText = "";
let pendingCompactionChannelId = null;
let sessionResetting = false;
let bridgePaused = false;
let bridgeStopping = false;
let messageQueue = [];
let typingInterval = null;
let projectChannelId = CHANNEL_ID;
let activeOutputChannelId = null;
let activeReminderContext = null;
let lastOwnerInteraction = null;
let pendingInputNeededResumeTurnId = null;
let sessionTerminationPromise = null;
let activeTurnPromise = null;

function setBridgePaused(paused) {
  bridgePaused = paused;
  markPaused(THREAD_ACTIVITY_FILE, paused);
}
markPaused(THREAD_ACTIVITY_FILE, false);

const discordTransport = createRouterTransport({
  project: ROUTER_PROJECT, role: THREAD_MODE ? "thread" : "project", keyFile: ROUTER_KEY_FILE,
  launchDir: ROUTER_LAUNCH_DIR, registryPath: REGISTRY_PATH, primaryChannelId: CHANNEL_ID,
  threadId: DISCORD_THREAD_ID || null, provider: PROVIDER,
});

// ---- ACP connection ------------------------------------------------------

// JSON-RPC 2.0 over newline-delimited JSON on the agent's stdio.
function createAcpConnection(child, { onNotification, onRequest }) {
  let nextId = 1;
  let buffer = "";
  const pending = new Map();
  const write = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        console.log(`[agy stdout] ${line}`);
        continue;
      }
      if (message.method && message.id !== undefined && message.id !== null) {
        Promise.resolve(onRequest(message)).then(
          (result) => write({ jsonrpc: "2.0", id: message.id, result }),
          (error) => write({ jsonrpc: "2.0", id: message.id, error: { code: error.code || -32603, message: error.message || String(error) } }),
        );
      } else if (message.method) {
        onNotification(message);
      } else if (pending.has(message.id)) {
        const { resolve, reject, timer } = pending.get(message.id);
        pending.delete(message.id);
        clearTimeout(timer);
        if (message.error) reject(Object.assign(new Error(message.error.message || "ACP error"), { code: message.error.code, data: message.error.data }));
        else resolve(message.result);
      }
    }
  });

  return {
    request(method, params, { timeoutMs } = {}) {
      return new Promise((resolve, reject) => {
        const id = nextId++;
        const timer = timeoutMs ? setTimeout(() => {
          pending.delete(id);
          reject(new Error(`${method} timed out after ${timeoutMs} ms`));
        }, timeoutMs) : null;
        timer?.unref?.();
        pending.set(id, { resolve, reject, timer });
        write({ jsonrpc: "2.0", id, method, params });
      });
    },
    notify(method, params) {
      write({ jsonrpc: "2.0", method, params });
    },
    failAll(error) {
      for (const { reject, timer } of pending.values()) {
        clearTimeout(timer);
        reject(error);
      }
      pending.clear();
    },
  };
}

function findAgyBinary() {
  if (process.env.CCDM_AGY_BIN) return process.env.CCDM_AGY_BIN;
  for (const dir of (process.env.PATH || "").split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, "agy");
    try {
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch { /* not here */ }
  }
  return path.join(os.homedir(), ".local", "bin", "agy");
}

function startAgy() {
  const bin = findAgyBinary();
  console.log(`Starting ${bin} acp in ${PROJECT_DIR}`);
  agyProcess = spawn(bin, ["acp", "--dangerously-skip-permissions"], {
    cwd: PROJECT_DIR,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
  });
  agyProcess.stderr.setEncoding("utf8");
  agyProcess.stderr.on("data", (data) => console.log(`[agy stderr] ${data.trim()}`));
  agyProcess.on("error", (error) => void exitAfterRuntimeLoss(`agy could not start: ${error.message}`));
  agyProcess.on("exit", (code, signal) => {
    acp?.failAll(new Error("agy exited"));
    void exitAfterRuntimeLoss(`agy acp exited with ${signal || `code ${code}`}`);
  });
  acp = createAcpConnection(agyProcess, { onNotification: handleNotification, onRequest: handleAgentRequest });
}

process.on("exit", () => {
  if (agyProcess && agyProcess.exitCode === null && agyProcess.signalCode === null) agyProcess.kill();
});

// The agent asks before running a tool; every request is approved, the way
// Codex sessions run with approvals off.
async function handleAgentRequest(message) {
  if (message.method === "session/request_permission") {
    const options = message.params?.options || [];
    const option = options.find((candidate) => candidate.kind === "allow_always")
      || options.find((candidate) => candidate.kind === "allow_once") || options[0];
    return option ? { outcome: { outcome: "selected", optionId: option.optionId } } : { outcome: { outcome: "cancelled" } };
  }
  throw Object.assign(new Error(`Method not supported by the CCDM bridge: ${message.method}`), { code: -32601 });
}

function handleNotification(message) {
  if (message.method !== "session/update") return;
  const params = message.params || {};
  if (sessionId && params.sessionId && params.sessionId !== sessionId) return;
  const update = params.update || {};
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
      if (turnActive && update.content?.type === "text") turnText += update.content.text || "";
      break;
    case "tool_call":
    case "tool_call_update": {
      const name = String(update.name || update.title || "");
      if (turnActive && name.includes(DISCORD_MCP_NAME) && /(?:^|_)reply$/.test(name.replace(/^Run /, ""))) {
        if (!turnReplied) markReplied(THREAD_ACTIVITY_FILE);
        turnReplied = true;
      }
      break;
    }
    case "usage_update":
      if (update.size > 0 && Number.isFinite(update.used)) {
        discordTransport.setContextPct(Math.round((update.used / update.size) * 100));
      }
      break;
    case "config_option_update":
      if (Array.isArray(update.configOptions)) configOptions = update.configOptions;
      break;
    default:
      break;
  }
}

// ---- session -------------------------------------------------------------

function discordMcpServer() {
  const env = {
    CCDM_ROUTER_KEY_FILE: ROUTER_KEY_FILE,
    CCDM_ROUTER_STATE_DIR: routerPaths.stateDir(),
    // The scoped MCP server names its project with the Codex variable.
    CCDM_CODEX_PROJECT: ROUTER_PROJECT,
    ...(THREAD_MODE ? { CCDM_THREAD_ID: DISCORD_THREAD_ID } : {}),
    CCDM_THREAD_PROVIDER: PROVIDER,
    CHANNEL_ID,
    DISCORD_REPLY_TOKEN,
    CCDM_REMINDER_PROJECT_ROOT: ROOT_DIR,
    CCDM_REMINDER_STATE_DIR: REMINDER_STATE_DIR,
    CCDM_REMINDER_CONTEXT_FILE: REMINDER_CONTEXT_FILE,
    CCDM_REMINDER_RECEIPTS_DIR: REMINDER_RECEIPTS_DIR,
  };
  return {
    name: DISCORD_MCP_NAME,
    command: process.execPath,
    args: [MCP_SERVER_SCRIPT],
    env: Object.entries(env).map(([name, value]) => ({ name, value: String(value) })),
  };
}

// Select options may come grouped ({group, options: [...]}).
function optionValues(option) {
  const values = [];
  for (const entry of option?.options || []) {
    if (Array.isArray(entry.options)) values.push(...entry.options.map((inner) => inner.value));
    else values.push(entry.value);
  }
  return values;
}

const configOption = (category) => configOptions.find((option) => option.id === category || option.category === category);

// The model and thinking level, checked against what agy offers.
function resolveModelSettings(model, effort) {
  const models = optionValues(configOption("model"));
  let resolvedModel = model;
  let resolvedEffort = effort;
  if (resolvedModel && models.length && !models.includes(resolvedModel)) {
    const suffixed = EFFORT_SUFFIX.exec(resolvedModel);
    if (suffixed && models.includes(suffixed[1])) {
      resolvedModel = suffixed[1];
      resolvedEffort = resolvedEffort || suffixed[2];
    } else {
      throw new Error(`Unknown Gemini model '${model}' (agy offers: ${models.join(", ")})`);
    }
  }
  return { model: resolvedModel, effort: resolvedEffort };
}

async function setConfigOption(configId, value) {
  const option = configOption(configId);
  if (!option || option.currentValue === value) return;
  const result = await acp.request("session/set_config_option", { sessionId, configId: option.id, value },
    { timeoutMs: SESSION_REQUEST_TIMEOUT_MS });
  if (Array.isArray(result?.configOptions)) configOptions = result.configOptions;
}

async function applyModelSettings() {
  const { model, effort } = resolveModelSettings(GEMINI_MODEL, GEMINI_EFFORT);
  if (model) await setConfigOption("model", model);
  if (effort) {
    const efforts = optionValues(configOption("thought_level"));
    if (!efforts.length) {
      console.log(`Model ${model} has no thinking level; ignoring effort ${effort}`);
    } else if (!efforts.includes(effort)) {
      throw new Error(`Invalid Gemini effort '${effort}' for ${model} (agy offers: ${efforts.join(", ")})`);
    } else {
      await setConfigOption("thought_level", effort);
    }
  }
  const current = (category) => configOption(category)?.currentValue;
  console.log(`Gemini session ${sessionId}: model=${current("model") ?? "?"} thinking=${current("thought_level") ?? "-"}`);
}

let agentCapabilities = {};

async function initializeAgy() {
  const result = await acp.request("initialize", {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    clientInfo: { name: "ccdm-gemini-bridge", version: "1.0.0" },
  }, { timeoutMs: SESSION_REQUEST_TIMEOUT_MS });
  agentCapabilities = result?.agentCapabilities || {};
  console.log(`Connected to ${result?.agentInfo?.name || "agy"} ${result?.agentInfo?.version || ""}`.trim());
}

async function openSession(resumeId = "") {
  const params = {
    cwd: PROJECT_DIR,
    mcpServers: [discordMcpServer()],
    _meta: { antigravity: { systemPrompt: { append: SYSTEM_INSTRUCTION } } },
  };
  let result;
  if (resumeId) {
    // session/resume continues without replaying history; session/load replays
    // it as updates, which no turn is listening to.
    const method = agentCapabilities.sessionCapabilities?.resume ? "session/resume" : "session/load";
    result = await acp.request(method, { sessionId: resumeId, ...params }, { timeoutMs: SESSION_REQUEST_TIMEOUT_MS });
    sessionId = result?.sessionId || resumeId;
  } else {
    result = await acp.request("session/new", params, { timeoutMs: SESSION_REQUEST_TIMEOUT_MS });
    sessionId = result?.sessionId;
  }
  if (!sessionId) throw new Error("agy returned no session id");
  configOptions = Array.isArray(result?.configOptions) ? result.configOptions : [];
  await applyModelSettings();
}

// ---- Discord output ------------------------------------------------------

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

async function sendToDiscord(text, channelId = activeOutputChannelId || projectChannelId) {
  if (!text.trim()) return [];
  return await discordTransport.send(channelId, splitMessage(text));
}

async function startTyping(channelId) {
  stopTyping();
  const channel = await discordTransport.fetchChannel(channelId);
  if (!channel) return;
  discordTransport.sendTyping(channel.id).catch(() => {});
  typingInterval = setInterval(() => discordTransport.sendTyping(channel.id).catch(() => {}), 8000);
}

function stopTyping() {
  if (typingInterval) clearInterval(typingInterval);
  typingInterval = null;
}

// ---- reminders -----------------------------------------------------------

async function reminderAssignmentFor(channelId) {
  if (THREAD_MODE) {
    return channelId === DISCORD_THREAD_ID ? reminderAdapter.resolveThreadAssignment(ROUTER_PROJECT, DISCORD_THREAD_ID) : null;
  }
  const assignment = await reminderAdapter.resolveAssignmentForChannel(channelId);
  return assignment?.project === ROUTER_PROJECT ? assignment : null;
}

function reminderEventContext(assignment, turnId = null) {
  return {
    ...assignment,
    provider: PROVIDER,
    ...(sessionId ? { provider_session_id: sessionId } : {}),
    ...(turnId ? { provider_turn_id: turnId } : {}),
  };
}

function recordSessionTermination() {
  if (!sessionId) return Promise.resolve();
  if (!sessionTerminationPromise) {
    const endingSessionId = sessionId;
    sessionTerminationPromise = (async () => {
      const assignment = await reminderAssignmentFor(projectChannelId).catch(() => null);
      if (!assignment) return;
      await reminderAdapter.emitEvent("session_terminated", {
        ...assignment, provider: PROVIDER, provider_session_id: endingSessionId,
      }).catch((error) => console.error(`Conversation termination event failed: ${error.message || error}`));
    })();
  }
  return sessionTerminationPromise;
}

async function exitAfterRuntimeLoss(reason) {
  if (bridgeStopping) return;
  bridgeStopping = true;
  console.error(reason);
  reportLaunchReady({ ok: false, error: reason });
  await recordSessionTermination();
  process.exit(1);
}

// ---- turns ---------------------------------------------------------------

// One ACP prompt. `source` is the owner message it answers, for Conversation
// Reminders; `suppress` hides its text (a /compact).
async function runTurn(blocks, channelId, source = null, { suppress = false } = {}) {
  turnActive = true;
  turnReplied = false;
  turnText = "";
  activeOutputChannelId = channelId;
  const turnId = randomUUID();
  markTurn(THREAD_ACTIVITY_FILE, true);
  if (source?.reminderAssignment) {
    activeReminderContext = {
      ...reminderEventContext(source.reminderAssignment, turnId),
      interaction_id: source.id,
      source_message_id: source.id,
      initiator_id: source.author.id,
    };
    await reminderAdapter.writeActiveContext(activeReminderContext).catch(() => {});
    if (pendingInputNeededResumeTurnId) {
      await reminderAdapter.emitEvent("work_resumed", activeReminderContext, {
        source_message_id: source.id, resumed_from_turn_id: pendingInputNeededResumeTurnId,
      }).catch(() => {});
      pendingInputNeededResumeTurnId = null;
    }
  }
  if (!suppress) await startTyping(channelId).catch(() => {});

  let outcome = "completed";
  let errorText = null;
  try {
    const result = await acp.request("session/prompt", { sessionId, prompt: blocks });
    const stopReason = result?.stopReason;
    if (stopReason === "cancelled") outcome = "interrupted";
    else if (stopReason === "refusal") {
      outcome = "failed";
      errorText = "The model refused to continue this request.";
    }
    console.log(`[turn] Finished (${stopReason || "no stop reason"})`);
  } catch (error) {
    outcome = "failed";
    errorText = error.message || String(error);
    console.error(`[turn] session/prompt failed: ${errorText}`);
  }
  stopTyping();

  const context = activeReminderContext;
  if (!suppress && outcome === "completed" && !turnReplied && TEXT_REPLY_FALLBACK && turnText.trim()) {
    try {
      const sent = await sendToDiscord(turnText.trim(), channelId);
      if (context) {
        for (const message of sent) await reminderAdapter.recordDeliveredReply(context, message.id).catch(() => {});
      }
    } catch (error) {
      console.error(`Text reply fallback failed: ${error.code || error.message}`);
    }
  }
  if (errorText && !bridgeStopping && !sessionResetting) {
    await sendToDiscord(`**Error:** ${errorText}`, channelId).catch(() => {});
  }
  if (context) {
    const receipts = await reminderAdapter.receiptsForTurn(context.provider_session_id, context.provider_turn_id);
    if (receipts.some((receipt) => receipt.disposition === "input-needed")) {
      pendingInputNeededResumeTurnId = context.provider_turn_id;
    }
    const answered = receipts.filter((receipt) => receipt.interaction_id === context.interaction_id);
    if (outcome === "completed" && answered.length > 0) {
      await reminderAdapter.emitEvent("turn_completed", context, {
        delivered_message_ids: answered.map((receipt) => receipt.message_id),
        source_message_id: context.source_message_id,
      }).catch(() => {});
    }
    await reminderAdapter.removeTurnReceipts(context.provider_session_id, context.provider_turn_id).catch(() => {});
  }
  activeReminderContext = null;
  await reminderAdapter.clearActiveContext().catch(() => {});
  turnActive = false;
  activeOutputChannelId = null;
  markTurn(THREAD_ACTIVITY_FILE, false, outcome);
  return outcome;
}

function startTurn(blocks, channelId, source, options) {
  activeTurnPromise = runTurn(blocks, channelId, source, options)
    .catch((error) => console.error("Turn failed:", error))
    .finally(() => {
      activeTurnPromise = null;
      void afterTurn();
    });
  return activeTurnPromise;
}

async function afterTurn() {
  if (pendingCompactionChannelId) {
    const channelId = pendingCompactionChannelId;
    pendingCompactionChannelId = null;
    await startCompaction(channelId);
    return;
  }
  processQueue();
}

// Every queued message goes into one turn, in arrival order; it answers the
// owner's latest queued message.
function processQueue() {
  if (bridgePaused || sessionResetting || turnActive || !sessionId || messageQueue.length === 0) return;
  const queued = messageQueue;
  messageQueue = [];
  for (const item of queued) {
    if (item.msg && !item.msg.synthetic) discordTransport.removeOwnReaction(item.msg, "⏳").catch(() => {});
  }
  const blocks = queued.length === 1
    ? queued[0].blocks
    : queued.flatMap((item, index) => [
      { type: "text", text: `[Queued message ${index + 1} of ${queued.length}]` },
      ...item.blocks,
    ]);
  const source = queued.map((item) => item.msg).filter((msg) => msg?.reminderAssignment).at(-1) || null;
  startTurn(blocks, queued.at(-1).channelId, source);
}

async function routeInput(blocks, msg, channelId) {
  if (bridgePaused || sessionResetting || turnActive || !sessionId) {
    messageQueue.push({ blocks, msg, channelId });
    if (msg && !msg.synthetic) await discordTransport.react(msg, "⏳").catch(() => {});
    return;
  }
  startTurn(blocks, channelId, msg);
}

async function startCompaction(channelId) {
  await sendToDiscord("Compaction started.", channelId).catch(() => {});
  const outcome = await new Promise((resolve) => {
    activeTurnPromise = runTurn([{ type: "text", text: "/compact" }], channelId, null, { suppress: true })
      .then(resolve, () => resolve("failed"))
      .finally(() => { activeTurnPromise = null; });
  });
  await sendToDiscord(outcome === "completed" ? "Compaction complete." : "**Error:** Compaction failed.", channelId).catch(() => {});
  processQueue();
}

async function cancelActiveTurn() {
  if (!turnActive || !sessionId) return;
  acp.notify("session/cancel", { sessionId });
  const pending = activeTurnPromise;
  if (pending) {
    await Promise.race([pending, new Promise((resolve) => setTimeout(resolve, 15000))]);
  }
}

// ---- input ---------------------------------------------------------------

const TEXT_EXTENSIONS = new Set([
  ".txt", ".md", ".json", ".js", ".ts", ".py", ".sh", ".yml", ".yaml",
  ".toml", ".cfg", ".ini", ".csv", ".xml", ".html", ".css", ".sql",
  ".rs", ".go", ".java", ".c", ".cpp", ".h", ".rb", ".php", ".swift",
  ".kt", ".scala", ".r", ".lua", ".pl", ".ex", ".exs", ".hs", ".ml",
  ".env", ".log", ".diff", ".patch", ".jsx", ".tsx", ".vue", ".svelte",
]);
const AUDIO_EXTENSIONS = new Set([".aac", ".flac", ".m4a", ".mp3", ".oga", ".ogg", ".opus", ".wav", ".weba"]);

const extension = (att) => (att.name?.includes(".") ? `.${att.name.split(".").pop().toLowerCase()}` : "");
const isTextFile = (att) => att.contentType?.startsWith("text/") || att.contentType === "application/json" || TEXT_EXTENSIONS.has(extension(att));
const isAudioFile = (att) => att.contentType?.startsWith("audio/") || AUDIO_EXTENSIONS.has(extension(att));

async function fetchBuffer(url) {
  const response = await fetch(url);
  if (!response.ok) return null;
  return { data: Buffer.from(await response.arrayBuffer()), type: response.headers.get("content-type") };
}

async function saveAttachment(url, filename) {
  const fetched = await fetchBuffer(url);
  if (!fetched) return null;
  const dir = path.join(PROJECT_DIR, ".discord-attachments");
  await mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `${Date.now()}-${filename.replace(/[^a-zA-Z0-9._-]/g, "_")}`);
  await writeFile(filePath, fetched.data);
  return filePath;
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${command} exited with code ${code}${stderr.trim() ? `: ${stderr.trim()}` : ""}`))));
  });
}

async function transcribeAudio(att) {
  const fetched = await fetchBuffer(att.url);
  if (!fetched) return null;
  const dir = await mkdtemp(path.join(os.tmpdir(), "gemini-bridge-audio-"));
  try {
    const filePath = path.join(dir, (att.name || "audio").replace(/[^a-zA-Z0-9._-]/g, "_") || "audio");
    await writeFile(filePath, fetched.data);
    const outputDir = path.join(dir, "out");
    await mkdir(outputDir, { recursive: true });
    const args = [filePath, "--model", AUDIO_TRANSCRIPTION_MODEL, "--output_format", "txt", "--output_dir", outputDir];
    if (AUDIO_TRANSCRIPTION_LANGUAGE) args.push("--language", AUDIO_TRANSCRIPTION_LANGUAGE);
    await runCommand(AUDIO_TRANSCRIPTION_COMMAND, args);
    return (await readFile(path.join(outputDir, `${path.parse(filePath).name}.txt`), "utf8")).trim();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// A Discord message as ACP content blocks.
async function buildBlocks(msg, text) {
  const blocks = text ? [{ type: "text", text }] : [];
  for (const delivered of msg.attachments || []) {
    const att = { ...delivered, url: await discordTransport.attachmentUrl(msg, delivered) };
    try {
      if (att.contentType?.startsWith("image/")) {
        const fetched = await fetchBuffer(att.url);
        if (fetched) blocks.push({ type: "image", mimeType: att.contentType, data: fetched.data.toString("base64") });
      } else if (AUDIO_TRANSCRIPTION_ENABLED && isAudioFile(att)) {
        let transcript = null;
        let reason = "";
        try {
          transcript = await transcribeAudio(att);
        } catch (error) {
          reason = ` (${error.message || error})`;
        }
        blocks.push({ type: "text", text: transcript
          ? `--- Audio transcription: ${att.name} ---\n${transcript}\n--- End audio transcription ---`
          : `[Audio attachment could not be transcribed: ${att.name}${reason}]` });
      } else if (isTextFile(att)) {
        const fetched = await fetchBuffer(att.url);
        if (fetched) blocks.push({ type: "text", text: `--- File: ${att.name} ---\n${fetched.data.toString("utf8")}\n--- End of ${att.name} ---` });
      } else {
        const filePath = await saveAttachment(att.url, att.name || "attachment");
        if (filePath) {
          blocks.push({ type: "text", text: `[Attachment saved to: ${filePath}] (filename: ${att.name}, type: ${att.contentType || "unknown"}, size: ${att.size} bytes)` });
        }
      }
    } catch (error) {
      blocks.push({ type: "text", text: `[Attachment ${att.name} could not be read: ${error.message || error}]` });
    }
  }
  return blocks;
}

// ---- commands ------------------------------------------------------------

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\"'\"'")}'`;
}

async function findCurrentProject() {
  const registry = JSON.parse(await readFile(REGISTRY_PATH, "utf8"));
  const project = registry.projects?.[ROUTER_PROJECT];
  if (project?.type !== "gemini" || project.channel_id !== projectChannelId) {
    throw new Error(`No gemini project ${ROUTER_PROJECT} in registry.json matches channel ${projectChannelId}`);
  }
  return { projectName: ROUTER_PROJECT, screenName: project.screen_name };
}

function scheduleRestart(projectName, screenName) {
  const logPath = path.join(os.tmpdir(), `ccdm-restart-${projectName.replace(/[^a-zA-Z0-9._-]/g, "_")}.log`);
  const command = [
    `while kill -0 ${process.pid} 2>/dev/null; do sleep 1; done`,
    `tmux kill-session -t ${shellQuote(`=${screenName}`)} 2>/dev/null || true`,
    `cd ${shellQuote(ROOT_DIR)} && ./scripts/start-gemini-session.sh ${shellQuote(projectName)} >> ${shellQuote(logPath)} 2>&1`,
  ].join("; ");
  spawn("/bin/sh", ["-c", command], { detached: true, env: process.env, stdio: "ignore" }).unref();
  return logPath;
}

async function noteManagementCommand(msg, channelId) {
  const assignment = await reminderAssignmentFor(channelId).catch(() => null);
  if (assignment && msg.author.id === assignment.owner_id) {
    await reminderAdapter.emitEvent("owner_activity", reminderEventContext(assignment), {
      actor_id: msg.author.id, source_message_id: msg.id, activity_kind: "management-command",
    }).catch(() => {});
  }
}

async function clearSession(channelId) {
  sessionResetting = true;
  messageQueue = [];
  pendingCompactionChannelId = null;
  try {
    await cancelActiveTurn();
    await recordSessionTermination();
    sessionTerminationPromise = null;
    const previous = sessionId;
    sessionId = null;
    await openSession();
    console.log(`New Gemini session after /clear: ${sessionId} (was ${previous})`);
    await sendToDiscord("Conversation cleared — fresh session started.", channelId);
  } catch (error) {
    await sendToDiscord(`**Error:** Failed to clear — ${error.message || error}. The session is stopping; restart it.`, channelId).catch(() => {});
    await exitAfterRuntimeLoss(`Gemini session reset failed: ${error.message || error}`);
    return;
  } finally {
    sessionResetting = false;
  }
  processQueue();
}

async function handleCommand(msg, text, channelId) {
  await noteManagementCommand(msg, channelId);
  switch (text) {
    case "/pause":
      setBridgePaused(true);
      await discordTransport.react(msg, "⏸️").catch(() => {});
      await sendToDiscord("Bridge paused. New messages will be queued.", channelId);
      return;
    case "/unpause":
      setBridgePaused(false);
      await discordTransport.react(msg, "▶️").catch(() => {});
      await sendToDiscord("Bridge unpaused.", channelId);
      processQueue();
      return;
    case "/compact":
      await discordTransport.react(msg, "🔄").catch(() => {});
      if (turnActive) {
        pendingCompactionChannelId = channelId;
        await sendToDiscord("Compaction queued.", channelId);
      } else {
        await startCompaction(channelId);
      }
      return;
    case "/clear":
      await discordTransport.react(msg, "🔄").catch(() => {});
      await clearSession(channelId);
      return;
    case "/restart":
      await discordTransport.react(msg, "🔄").catch(() => {});
      try {
        const { projectName, screenName } = await findCurrentProject();
        const logPath = scheduleRestart(projectName, screenName);
        await sendToDiscord("Restarting session — fresh session coming up.", channelId);
        console.log(`Restart scheduled for '${projectName}' (${screenName}); log: ${logPath}`);
        await shutdown(0);
      } catch (error) {
        await sendToDiscord(`**Error:** Failed to restart — ${error.message || error}`, channelId);
      }
      return;
    default:
      break;
  }
}

const COMMANDS = new Set(["/pause", "/unpause", "/compact", "/clear", "/restart"]);

// ---- Discord input -------------------------------------------------------

async function onDiscordMessage(msg) {
  if (msg.author.bot || msg.channel.id !== projectChannelId) return;
  const channelId = msg.channel.id;
  const text = (msg.content || "").trim();
  if (text === "/close") {
    const assignment = await reminderAssignmentFor(channelId).catch(() => null);
    if (assignment && msg.author.id === assignment.owner_id) {
      await reminderAdapter.emitEvent("close_requested", reminderEventContext(assignment), {
        actor_id: msg.author.id, source_message_id: msg.id, command: "/close",
      }).catch(() => {});
    }
    return;
  }
  if (COMMANDS.has(text)) {
    console.log(`[discord] ${text} requested`);
    await handleCommand(msg, text, channelId);
    return;
  }
  const blocks = await buildBlocks(msg, text);
  if (blocks.length === 0) return;
  const assignment = await reminderAssignmentFor(channelId).catch(() => null);
  if (assignment && msg.author.id === assignment.owner_id) {
    msg.reminderAssignment = assignment;
    lastOwnerInteraction = { id: msg.id, assignment_generation: assignment.assignment_generation };
    await reminderAdapter.emitEvent("owner_activity", reminderEventContext(assignment), {
      actor_id: msg.author.id, source_message_id: msg.id,
      activity_kind: msg.attachments.length > 0 && !text ? "attachment" : "message",
    }).catch(() => {});
  }
  console.log(`[discord] ${msg.author.username}: ${text || "(attachment)"} [${blocks.length} part(s)]`);
  await routeInput(blocks, msg, channelId);
}

async function onDiscordReaction(event) {
  if (event.user.bot || event.channelId !== projectChannelId) return;
  let reaction;
  try {
    reaction = await event.load();
  } catch (error) {
    console.log(`[discord] Failed to fetch reaction context: ${error.message || error}`);
    return;
  }
  const { user } = reaction;
  const assignment = await reminderAssignmentFor(event.channelId).catch(() => null);
  if (assignment && user.id === assignment.owner_id) {
    await reminderAdapter.emitEvent("owner_activity", reminderEventContext(assignment), {
      actor_id: user.id, source_message_id: reaction.message.id, activity_kind: "reaction",
      reaction_emoji: String(reaction.emoji.id || reaction.emoji.name || "") || undefined,
    }).catch(() => {});
  }
  if (await reminderAdapter.isRecordedReminderMessage(reaction.message.id)) return;
  if (!FORWARDED_REACTIONS.has(reaction.emoji.name) || !(await discordTransport.isOwnMessage(reaction.message))) return;
  const excerptSource = reaction.message.content.trim().replace(/\s+/g, " ");
  const excerpt = excerptSource.length > 80 ? `${excerptSource.slice(0, 77)}...` : excerptSource;
  const text = `User ${user.globalName || user.username || user.id} reacted ${reaction.emoji.name} to your message${excerpt ? `: "${excerpt}"` : ""} (message ID: ${reaction.message.id}).`;
  const source = assignment && user.id === assignment.owner_id &&
    lastOwnerInteraction?.assignment_generation === assignment.assignment_generation
    ? { id: lastOwnerInteraction.id, author: user, reminderAssignment: assignment, synthetic: true }
    : null;
  console.log(`[discord] ${user.username}: ${reaction.emoji.name} on ${reaction.message.id}`);
  await routeInput([{ type: "text", text }], source, event.channelId);
}

// The Router moved this project's channel: later messages come from there,
// and queued work follows.
function applyProjectScope(scope) {
  if (THREAD_MODE || !scope?.channel_id || scope.channel_id === projectChannelId) return;
  const previous = projectChannelId;
  projectChannelId = scope.channel_id;
  if (activeOutputChannelId === previous) activeOutputChannelId = projectChannelId;
  if (pendingCompactionChannelId === previous) pendingCompactionChannelId = projectChannelId;
  for (const queued of messageQueue) if (queued.channelId === previous) queued.channelId = projectChannelId;
  console.log(`Router moved this session to channel ${projectChannelId}`);
}

// ---- thread bootstrap ----------------------------------------------------

async function awaitThreadBootstrap() {
  const file = process.env.CCDM_THREAD_BOOTSTRAP_FILE;
  const timeoutS = Number(process.env.CCDM_THREAD_BOOT_TIMEOUT_S);
  const deadline = Date.now() + (Number.isFinite(timeoutS) && timeoutS > 0 ? timeoutS : 120) * 1000;
  while (file && Date.now() < deadline) {
    try {
      return JSON.parse(await readFile(file, "utf8"));
    } catch { /* not written yet */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  console.error("No thread bootstrap arrived; handling live events without it");
  return null;
}

function threadBootstrapText(bootstrap) {
  const messages = Array.isArray(bootstrap.messages) ? bootstrap.messages : [];
  const parts = [String(bootstrap.preamble || "")];
  if (bootstrap.starter) parts.push(`The thread was started from this message:\n${bootstrap.starter}`);
  if (messages.length) {
    parts.push(["Messages sent in the thread so far:", ...messages.map((message) => {
      const attachments = message.attachments?.length
        ? ` [${message.attachments.length} attachment(s): ${message.attachments.map((att) => att.name).join(", ")}; download_attachment with message_id ${message.message_id}]`
        : "";
      return `[${message.ts}] ${message.author?.name ?? message.author?.id}: ${message.content}${attachments}`;
    })].join("\n"));
  }
  return parts.filter(Boolean).join("\n\n");
}

let heldThreadEvents = THREAD_MODE ? [] : null;
const holdUntilBootstrap = (kind, handler) => async (event) => {
  if (heldThreadEvents) heldThreadEvents.push([kind, handler, event]);
  else await handler(event);
};

async function startThreadConversation() {
  const bootstrap = await awaitThreadBootstrap();
  if (bootstrap) {
    const assignment = await reminderAssignmentFor(DISCORD_THREAD_ID).catch(() => null);
    const asked = (Array.isArray(bootstrap.messages) ? bootstrap.messages : [])
      .findLast((message) => assignment && message.author?.id === assignment.owner_id);
    const source = asked
      ? { id: asked.message_id, author: { id: asked.author.id }, reminderAssignment: assignment, synthetic: true }
      : null;
    if (source) lastOwnerInteraction = { id: source.id, assignment_generation: assignment.assignment_generation };
    const text = threadBootstrapText(bootstrap);
    if (text) startTurn([{ type: "text", text }], projectChannelId, source);
  }
  const included = new Set(bootstrap?.included_message_ids ?? []);
  const pending = heldThreadEvents.filter(([kind, , event]) => !(kind === "message" && included.has(event.id)));
  heldThreadEvents = null;
  for (const [, handler, event] of pending) await handler(event);
}

// ---- lifecycle -----------------------------------------------------------

// The launcher reads the startup outcome once; a later failure never
// overwrites a reported success.
let launchReported = false;
function reportLaunchReady(outcome) {
  if (!LAUNCH_READY_FILE || launchReported) return;
  launchReported = true;
  try {
    const tmp = `${LAUNCH_READY_FILE}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(outcome)}\n`, { mode: 0o600 });
    renameSync(tmp, LAUNCH_READY_FILE);
  } catch (error) {
    console.error(`Launch outcome not recorded: ${error.message || error}`);
  }
}

let stopping = false;
async function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  bridgeStopping = true;
  console.log("Shutting down...");
  stopTyping();
  await recordSessionTermination();
  await reminderAdapter.clearActiveContext().catch(() => {});
  discordTransport.destroy();
  if (agyProcess && agyProcess.exitCode === null) agyProcess.kill();
  process.exit(code);
}

async function connectDiscord() {
  discordTransport.onScopeChange(applyProjectScope);
  discordTransport.onMessage(holdUntilBootstrap("message", onDiscordMessage));
  discordTransport.onReaction(holdUntilBootstrap("reaction", onDiscordReaction));
  const { userTag, scope } = await discordTransport.connect();
  console.log(`Discord connected as ${userTag}`);
  if (!THREAD_MODE && scope?.channel_id) applyProjectScope(scope);
  const channel = await discordTransport.fetchChannel(projectChannelId);
  if (!channel) throw new Error("Discord channel unavailable");
  console.log(`Listening in #${channel.name}`);
}

async function main() {
  await reminderAdapter.drainOutbox();
  startAgy();
  await initializeAgy();
  await openSession(RESUME_SESSION_ID);
  try {
    await connectDiscord();
  } catch (error) {
    reportLaunchReady({ ok: false, error: `Router hello failed: ${error.code || error.message}` });
    throw error;
  }
  reportLaunchReady({ ok: true, scope: { channel_id: projectChannelId }, provider_conversation_id: sessionId });
  console.log("Gemini-Discord bridge running");
  if (THREAD_MODE) startThreadConversation().catch((error) => console.error("Thread bootstrap failed:", error));
}

// A stop during startup still takes agy down and records the session's end.
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => void shutdown(0));

main().catch((error) => {
  console.error("Fatal:", error);
  reportLaunchReady({ ok: false, error: String(error.message || error) });
  bridgeStopping = true;
  process.exit(1);
});
