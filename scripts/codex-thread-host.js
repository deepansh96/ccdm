#!/usr/bin/env node
"use strict";

// The Codex thread host: one per project, in tmux `<screen_name>-threads`,
// launched and fed by the Thread Supervisor over a private control socket.
// It holds one Codex conversation per open Thread Conversation, on one
// app-server per Codex Home in use, and serves them through the project
// bot's own Gateway connection. It accepts messages and reactions only in
// threads it hosts and only from the project's allowed users, never writes a
// Discord server into a Codex Home, and never changes the bot's nickname.
const { execFile, spawn } = require("node:child_process");
const { randomBytes } = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const WebSocket = require("ws");
const { Client, GatewayIntentBits, Partials } = require("discord.js");

const argument = name => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : null;
const PROJECT = argument("--project");
const ROOT_DIR = path.resolve(__dirname, "..");
const STATE_DIR = argument("--state-dir") || process.env.CCDM_THREAD_STATE_DIR ||
  path.join(os.homedir(), ".local/state/ccdm/thread-supervisor");
const SERVICE = path.join(__dirname, "thread-supervisor.py");
const MCP_SERVER_SCRIPT = path.join(__dirname, "discord-mcp-server.js");
const CONTROL_SOCKET = "control.sock";
const FULL_ACCESS = "danger-full-access";
const FORWARDED_REACTIONS = new Set(["👍", "👎"]);
// Discord message types a person sends: a default message and a reply.
const USER_MESSAGE_TYPES = new Set([0, 19]);
// Thread messages seen before their thread is opened, so one sent just
// before the handoff still reaches the first turn.
const RECENT_LIMIT = 200;
const BOOTSTRAP_TIMEOUT_MS = Number(process.env.CODEX_BOOTSTRAP_TIMEOUT_MS || 60000);
// How long an unload waits for the app-server before the host moves on.
const UNLOAD_TIMEOUT_MS = 5000;

if (!PROJECT) {
  console.error("usage: codex-thread-host.js --project <project> [--state-dir <dir>]");
  process.exit(2);
}
const registry = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, "registry.json"), "utf8"));
const project = registry.projects?.[PROJECT];
const bot = (registry.pool || []).find(entry => entry.id === project?.bot_id);
if (!project || !bot?.token) {
  console.error(`project ${PROJECT} is not registered with an assigned bot`);
  process.exit(2);
}
const PROJECT_DIR = project.path.replace(/^~(?=$|\/)/, os.homedir());
const ALLOWED_USER_IDS = new Set([registry.discord_user_id, ...(project.guest_user_ids || [])]
  .filter(Boolean).map(String));
const TEXT_REPLY_FALLBACK = project.text_reply_fallback === true;
// The k-th Codex Home in use listens on the base port plus k.
const BASE_PORT = Number(project.thread_ws_port || Number(project.ws_port || 18300) + 1000);
const RUNTIME_DIR = path.join(STATE_DIR, "hosts", PROJECT.replace(/[^A-Za-z0-9._-]/g, "_"));

const conversations = new Map();
const runtimes = new Map();
const recent = [];
let reports = Promise.resolve();

function log(message) {
  console.log(`codex-thread-host[${PROJECT}]: ${message}`);
}

// Reports one thread event to the supervisor, in order.
function report(threadId, event, fields = {}) {
  const payload = JSON.stringify({ thread_id: threadId, event, ...fields });
  reports = reports.then(() => new Promise(resolve => {
    execFile(process.env.CCDM_THREAD_PYTHON || "python3", [SERVICE, "host-event", "--project-root", ROOT_DIR,
      "--state-dir", STATE_DIR, "--payload", payload], (error, _stdout, stderr) => {
      if (error) log(`reporting ${event} for thread ${threadId} failed: ${stderr.trim() || error.message}`);
      resolve();
    });
  }));
  return reports;
}

function request(rt, method, params) {
  return new Promise((resolve, reject) => {
    const id = rt.nextId++;
    rt.pending.set(id, { resolve, reject });
    rt.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  });
}

// One app-server per Codex Home, shared by that home's conversations.
function runtimeFor(home) {
  if (!runtimes.has(home)) {
    const starting = startRuntime(home, BASE_PORT + runtimes.size);
    starting.catch(() => runtimes.delete(home));
    runtimes.set(home, starting);
  }
  return runtimes.get(home);
}

async function startRuntime(home, port) {
  const rt = { home, port, ws: null, process: null, pending: new Map(), nextId: 1 };
  log(`starting codex app-server for ${home} on ws://127.0.0.1:${port}`);
  rt.process = spawn("codex", ["app-server", "--listen", `ws://127.0.0.1:${port}`], {
    cwd: PROJECT_DIR, env: { ...process.env, CODEX_HOME: home }, stdio: ["ignore", "pipe", "pipe"],
  });
  rt.process.stdout.on("data", data => log(`[codex stdout] ${data.toString().trim()}`));
  rt.process.stderr.on("data", data => log(`[codex stderr] ${data.toString().trim()}`));
  rt.process.on("exit", code => runtimeLost(rt, `the Codex app-server for ${home} exited with code ${code}`));
  for (let attempt = 0; !rt.ws; attempt++) {
    try {
      rt.ws = await new Promise((resolve, reject) => {
        const socket = new WebSocket(`ws://127.0.0.1:${port}`);
        socket.once("open", () => resolve(socket));
        socket.once("error", error => { socket.terminate(); reject(error); });
      });
    } catch {
      if (attempt >= 30) throw new Error(`the Codex app-server for ${home} did not accept connections`);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  rt.ws.on("message", data => onRuntimeMessage(rt, JSON.parse(data.toString())));
  rt.ws.on("close", () => runtimeLost(rt, `the Codex app-server connection for ${home} closed`));
  await request(rt, "initialize", { clientInfo: { name: "ccdm-codex-thread-host", version: "1.0.0" } });
  rt.ws.send(JSON.stringify({ jsonrpc: "2.0", method: "initialized" }));
  return rt;
}

function runtimeLost(rt, reason) {
  if (rt.lost || shuttingDown) return;
  rt.lost = true;
  log(reason);
  for (const conv of conversations.values()) {
    if (conv.runtime === rt) failConversation(conv, reason);
  }
  runtimes.delete(rt.home);
}

function onRuntimeMessage(rt, msg) {
  if (msg.id !== undefined && rt.pending.has(msg.id)) {
    const { resolve, reject } = rt.pending.get(msg.id);
    rt.pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
    else resolve(msg.result);
    return;
  }
  if (msg.method && msg.id !== undefined) {
    // Approvals are granted, as in the channel bridge; user-input requests are cancelled.
    const result = msg.method === "toolRequestUserInput" ? { cancelled: true } : { approved: true };
    rt.ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
    return;
  }
  const threadId = msg.params?.threadId || msg.params?.thread?.id;
  for (const conv of conversations.values()) {
    if (conv.runtime === rt && conv.codexThreadId && conv.codexThreadId === threadId) onNotification(conv, msg);
  }
}

function onNotification(conv, msg) {
  const turnId = msg.params?.turnId || msg.params?.turn?.id;
  if (!conv.turnActive || (turnId && conv.activeTurnId && turnId !== conv.activeTurnId)) return;
  switch (msg.method) {
    case "turn/started":
      conv.activeTurnId ||= turnId;
      break;
    case "item/agentMessage/delta":
      conv.deltaBuffer += msg.params.delta;
      break;
    case "item/started":
      if (msg.params?.item?.type === "mcpToolCall" && msg.params.item.server?.startsWith("discord-") &&
          ["reply", "edit_message", "react"].includes(msg.params.item.tool)) {
        conv.mcpReplyCalled = true;
      }
      break;
    case "error":
      if (msg.params?.willRetry === false) conv.terminalError = msg.params.error?.message || "Codex encountered an error";
      break;
    case "turn/completed":
      void onTurnCompleted(conv, msg.params?.turn || {});
      break;
    default:
      break;
  }
}

function mcpName(conv) {
  return `discord-${conv.threadId}`;
}

// Every `discord-*` server of the home other than the conversation's own, sorted.
async function homeDiscordServers(conv) {
  let cursor;
  const others = [];
  do {
    const page = await request(conv.runtime, "mcpServerStatus/list", { detail: "full", ...(cursor ? { cursor } : {}) });
    for (const server of page?.data || page?.servers || []) {
      const name = server.name || server.id;
      if (name?.startsWith("discord-") && name !== mcpName(conv)) others.push(name);
    }
    cursor = page?.nextCursor;
  } while (cursor);
  return others.sort();
}

// The conversation's own Discord server, scoped to its thread, with every
// other `discord-*` server of the home disabled. It travels with each
// thread/start and thread/resume and is never written into the home's config.toml.
function mcpOverride(conv, others) {
  return {
    [mcpName(conv)]: {
      command: "node",
      args: [MCP_SERVER_SCRIPT],
      env: { BOT_TOKEN: bot.token, CHANNEL_ID: conv.threadId, DISCORD_REPLY_TOKEN: conv.replyToken },
      // Without full access, Codex asks before each tool call, and nobody can answer.
      ...(conv.sandbox === FULL_ACCESS ? {} : { default_tools_approval_mode: "approve" }),
    },
    ...Object.fromEntries(others.map(name => [name, { enabled: false }])),
  };
}

function turnSettings(conv) {
  return { ...(conv.model ? { model: conv.model } : {}), ...(conv.effort ? { effort: conv.effort } : {}) };
}

// The settings thread/start and thread/resume share, recording which home
// servers the override disables.
function conversationParams(conv, others) {
  conv.disabledServers = others;
  return {
    cwd: PROJECT_DIR,
    sandbox: conv.sandbox,
    approvalPolicy: "never",
    ...(conv.model ? { model: conv.model } : {}),
    config: { mcp_servers: mcpOverride(conv, others),
      ...(conv.effort ? { model_reasoning_effort: conv.effort } : {}) },
    developerInstructions: `This conversation is the Discord thread "${conv.name}", connected through the ` +
      `${mcpName(conv)} MCP server. Do not call Discord MCP tools unless the current task includes an explicit ` +
      "Discord reply scope token. Subagents and delegated tasks must return results to their parent agent, not to " +
      "Discord. Use the exposed Discord MCP tools directly. If a tool is deferred, discover it through tool search " +
      "first. Never reconstruct the Discord transport through shell commands, read its credentials, or launch a " +
      "replacement MCP server to send a reply.",
  };
}

async function startCodexThread(conv) {
  const result = await request(conv.runtime, "thread/start", conversationParams(conv, await homeDiscordServers(conv)));
  if (!result?.thread?.id) throw new Error("Codex did not return a conversation id");
  conv.codexThreadId = result.thread.id;
  await report(conv.threadId, "conversation-id", { conversation_id: conv.codexThreadId, home: conv.home });
}

// Loads the stored conversation again, with a fresh override; a conversation
// archived on the Codex side is unarchived first.
async function resumeCodexThread(conv, others) {
  const params = { threadId: conv.codexThreadId, ...conversationParams(conv, others || await homeDiscordServers(conv)) };
  try {
    await request(conv.runtime, "thread/resume", params);
  } catch (error) {
    if (!/archived/i.test(error.message)) throw error;
    await request(conv.runtime, "thread/unarchive", { threadId: conv.codexThreadId });
    await request(conv.runtime, "thread/resume", params);
  }
}

// Unloads the conversation from its app-server; it never archives it.
async function unload(conv) {
  if (!conv.runtime || !conv.codexThreadId) return;
  const unloading = (async () => {
    if (conv.turnActive) {
      await request(conv.runtime, "turn/interrupt", { threadId: conv.codexThreadId,
        ...(conv.activeTurnId ? { turnId: conv.activeTurnId } : {}) }).catch(() => {});
    }
    await request(conv.runtime, "thread/unsubscribe", { threadId: conv.codexThreadId });
  })().catch(error => log(`thread ${conv.threadId}: unloading failed: ${error.message}`));
  let timer;
  await Promise.race([unloading, new Promise(resolve => { timer = setTimeout(resolve, UNLOAD_TIMEOUT_MS); })]);
  clearTimeout(timer);
}

// The existing no-action bootstrap, adapted to a thread: it configures the
// transport and its acknowledgment stays hidden.
async function sendBootstrap(conv) {
  const instruction = `You are communicating with the user via Discord, in the thread "${conv.name}". It is its ` +
    "own conversation: you cannot read or post in the parent channel or in other threads. Use ONLY the MCP server " +
    `named "${mcpName(conv)}" to interact — call its \`reply\` tool to send messages to the user. Every Discord ` +
    `write call (\`reply\`, \`edit_message\`, or \`react\`) must include \`scope_token: "${conv.replyToken}"\`. ` +
    "Do NOT share this scope token with subagents. When spawning subagents, explicitly tell them not to use " +
    "Discord MCP/tools and to return only to the parent agent. Do NOT use any other discord MCP server. Do NOT " +
    "output responses as regular text; always use the `reply` tool so the user sees your response on Discord. " +
    "Other available tools on this same server: edit_message, react, fetch_messages, " +
    "read_last_x_messages_in_channel, export_message_range, download_attachment. Use `reply` with the `files` " +
    "parameter to send file attachments. You don't have to reply for every little thing. Try to reply only when " +
    "you're done, unless something important needs to be confirmed from the user. Also, try to use simpler " +
    "language and avoid complex language.";
  const completed = new Promise(resolve => { conv.bootstrapDone = resolve; });
  conv.bootstrapping = true;
  beginTurn(conv);
  const result = await request(conv.runtime, "turn/start", {
    threadId: conv.codexThreadId,
    input: [{ type: "text", text: `${instruction}\n\nThis message only configures the transport; it is not a user ` +
      "task. Do not call tools, inspect files, or send a Discord message. Reply with exactly READY as plain text; " +
      "the host hides this acknowledgment." }],
    approvalPolicy: "never",
    ...turnSettings(conv),
  });
  conv.activeTurnId ||= result?.turn?.id || null;
  let timer;
  const failure = await Promise.race([completed, new Promise(resolve => {
    timer = setTimeout(() => resolve("the bootstrap turn timed out"), BOOTSTRAP_TIMEOUT_MS);
  })]);
  clearTimeout(timer);
  if (failure) throw new Error(failure);
}

function beginTurn(conv) {
  conv.turnActive = true;
  conv.activeTurnId = null;
  conv.deltaBuffer = "";
  conv.mcpReplyCalled = false;
  conv.terminalError = null;
}

async function onTurnCompleted(conv, turn) {
  const text = conv.deltaBuffer.trim();
  const terminalError = conv.terminalError;
  const replied = conv.mcpReplyCalled;
  conv.turnActive = false;
  conv.activeTurnId = null;
  conv.deltaBuffer = "";
  conv.terminalError = null;
  if (conv.bootstrapping) {
    conv.bootstrapping = false;
    const done = conv.bootstrapDone;
    conv.bootstrapDone = null;
    done(terminalError || (["failed", "interrupted"].includes(turn.status) ? `the bootstrap turn ${turn.status}` : null));
    return;
  }
  void report(conv.threadId, "turn-ended");
  if (terminalError) {
    await sendToThread(conv, `**Error:** ${terminalError}`);
  } else if (TEXT_REPLY_FALLBACK && !replied && text && (!turn.status || turn.status === "completed")) {
    await sendToThread(conv, text);
  }
  processQueue(conv);
}

async function sendTurn(conv, input) {
  beginTurn(conv);
  try {
    // A `discord-*` server added to the home since the override was built
    // would reach this conversation: reload it with a refreshed override first.
    const others = await homeDiscordServers(conv);
    if (others.join("\n") !== conv.disabledServers.join("\n")) {
      log(`thread ${conv.threadId}: the home's Discord servers changed; reloading the conversation`);
      await request(conv.runtime, "thread/unsubscribe", { threadId: conv.codexThreadId });
      await resumeCodexThread(conv, others);
    }
    const result = await request(conv.runtime, "turn/start", {
      threadId: conv.codexThreadId, input, approvalPolicy: "never", ...turnSettings(conv),
    });
    conv.activeTurnId ||= result?.turn?.id || null;
    void report(conv.threadId, "turn-started");
  } catch (error) {
    log(`thread ${conv.threadId}: turn/start failed: ${error.message}`);
    conv.turnActive = false;
    await sendToThread(conv, "**Error:** Failed to send message to Codex");
    processQueue(conv);
  }
}

function processQueue(conv) {
  if (conv.paused || conv.turnActive || conv.stopped || conv.queue.length === 0) return;
  void sendTurn(conv, conv.queue.shift());
}

function route(conv, input) {
  if (conv.paused || conv.turnActive) conv.queue.push(input);
  else void sendTurn(conv, input);
}

function splitMessage(text, limit = 2000) {
  const chunks = [];
  for (let rest = text; rest.length > 0;) {
    let cut = rest.length <= limit ? rest.length : rest.lastIndexOf("\n", limit);
    if (cut <= 0) cut = limit;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  return chunks;
}

async function sendToThread(conv, text) {
  try {
    const channel = client.channels.cache.get(conv.threadId) || await client.channels.fetch(conv.threadId);
    for (const chunk of splitMessage(text)) await channel.send(chunk);
  } catch (error) {
    log(`thread ${conv.threadId}: sending to Discord failed: ${error.message}`);
  }
}

// The first real turn: the starter message and every message held until the
// handoff, each exactly once.
function firstTurnText(conv, starter, messages) {
  const lines = [`You are in the Discord thread "${conv.name}" under this project's channel.`];
  if (starter) lines.push("", `The thread was started from this channel message by ${starter.author}:`, starter.content);
  lines.push("", "Messages in this thread so far:", ...messages.map(message => `${message.author}: ${message.content}`));
  return lines.join("\n");
}

async function startConversation(conv, opened) {
  conv.runtime = await runtimeFor(conv.home);
  if (conv.codexThreadId) {
    await resumeCodexThread(conv);
    await report(conv.threadId, "conversation-id", { conversation_id: conv.codexThreadId, home: conv.home });
  } else {
    await startCodexThread(conv);
  }
  if (conv.stopped) return unload(conv);
  await sendBootstrap(conv);
  if (conv.stopped) return;
  const messages = [...opened.messages, ...conv.pending];
  conv.pending = [];
  conv.handedOff = true;
  // sendTurn marks the turn active before yielding, so later messages queue behind it.
  const first = sendTurn(conv, [{ type: "text", text: firstTurnText(conv, opened.starter, messages) }]);
  await first;
  await report(conv.threadId, "ready", conv.trigger);
}

function failConversation(conv, reason) {
  if (conv.stopped) return;
  conv.stopped = true;
  conversations.delete(conv.threadId);
  log(`thread ${conv.threadId} failed: ${reason}`);
  void report(conv.threadId, "failed", { reason: String(reason).split("\n")[0], ...conv.trigger });
}

function messageEntry(msg) {
  return { id: msg.id, channelId: msg.channelId, author_id: msg.author.id, author: msg.author.username || msg.author.id,
    content: msg.content ?? "", timestamp: new Date(msg.createdTimestamp ?? Date.now()).toISOString() };
}

function open(requested) {
  const thread = requested.thread || {};
  const threadId = String(thread.thread_id || "");
  if (!threadId) return { ok: false, error: "open needs a thread id" };
  if (stopping) return { ok: false, stopping: true, error: "the Codex thread host is stopping" };
  if (conversations.has(threadId)) return { ok: false, error: `thread ${threadId} is already open` };
  const messages = requested.messages || [];
  const conv = {
    threadId, name: thread.name || threadId, home: thread.home, model: thread.model || null,
    effort: thread.effort || null, sandbox: thread.sandbox || FULL_ACCESS,
    // The triggering message; a `/thread` first message is in the parent channel.
    trigger: { trigger_message_id: requested.trigger_message_id, trigger_channel_id: requested.trigger_channel_id || threadId },
    // A stored conversation id resumes that conversation.
    replyToken: randomBytes(16).toString("hex"), runtime: null, codexThreadId: thread.conversation_id || null,
    disabledServers: [],
    turnActive: false, activeTurnId: null, bootstrapping: false, bootstrapDone: null, deltaBuffer: "",
    mcpReplyCalled: false, terminalError: null, queue: [], paused: false, stopped: false, handedOff: false,
    pending: [], included: new Set([requested.starter?.id, ...messages.map(message => message.id)].filter(Boolean)),
  };
  conversations.set(threadId, conv);
  // Messages this Gateway delivered before the open, from the trigger on.
  const since = messages[0]?.timestamp || "";
  for (const entry of recent.filter(entry => entry.channelId === threadId && entry.timestamp >= since)) {
    if (!conv.included.has(entry.id)) {
      conv.included.add(entry.id);
      conv.pending.push(entry);
    }
  }
  startConversation(conv, { starter: requested.starter || null, messages })
    .catch(error => failConversation(conv, error.message || error));
  return { ok: true };
}

// Stopping unloads the conversation. Once no conversation is left, the host
// refuses new ones and exits after replying.
async function stop(threadId) {
  const conv = conversations.get(threadId);
  if (conv) {
    conv.stopped = true;
    conversations.delete(threadId);
  }
  if (conversations.size === 0) stopping = true;
  if (!conv) return { ok: true, result: "not-open" };
  await unload(conv);
  return { ok: true, result: "stopped" };
}

async function command(threadId, name) {
  const conv = conversations.get(threadId);
  if (!conv?.handedOff) return { ok: false, error: `thread ${threadId} is not live` };
  if (name === "/pause") {
    conv.paused = true;
  } else if (name === "/unpause") {
    conv.paused = false;
    processQueue(conv);
  } else if (name === "/compact") {
    await request(conv.runtime, "thread/compact/start", { threadId: conv.codexThreadId });
  } else if (name === "/clear") {
    if (conv.turnActive) {
      await request(conv.runtime, "turn/interrupt", { threadId: conv.codexThreadId,
        ...(conv.activeTurnId ? { turnId: conv.activeTurnId } : {}) }).catch(() => {});
      conv.turnActive = false;
    }
    conv.queue = [];
    await startCodexThread(conv);
    await sendBootstrap(conv);
  } else {
    return { ok: false, error: `unknown command ${name}` };
  }
  return { ok: true };
}

async function handleControl(line) {
  let requested;
  try {
    requested = JSON.parse(line);
  } catch {
    return { ok: false, error: "malformed request" };
  }
  const threadId = String(requested.thread_id || "");
  try {
    switch (requested.op) {
      case "ping":
        if (stopping) return { ok: false, stopping: true, error: "the Codex thread host is stopping" };
        return { ok: true, threads: [...conversations.keys()] };
      case "open":
        return open(requested);
      case "stop":
        return await stop(threadId);
      case "config": {
        const conv = conversations.get(threadId);
        if (!conv) return { ok: false, error: `thread ${threadId} is not open` };
        return { ok: true, config: { home: conv.home, model: conv.model, effort: conv.effort, sandbox: conv.sandbox,
          conversation_id: conv.codexThreadId } };
      }
      case "command":
        return await command(threadId, requested.command);
      default:
        return { ok: false, error: `unknown operation ${requested.op}` };
    }
  } catch (error) {
    return { ok: false, error: error.message || String(error) };
  }
}

function startControlServer() {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true, mode: 0o700 });
  fs.chmodSync(RUNTIME_DIR, 0o700);
  // Relative to its private directory: the absolute path can exceed the Unix socket limit.
  process.chdir(RUNTIME_DIR);
  fs.rmSync(CONTROL_SOCKET, { force: true });
  const server = net.createServer(socket => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("error", () => {});
    socket.on("data", chunk => {
      buffer += chunk;
      for (let end; (end = buffer.indexOf("\n")) >= 0;) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        void handleControl(line).then(reply => socket.write(`${JSON.stringify(reply)}\n`, () => {
          if (stopping) void shutdown();
        }));
      }
    });
  });
  const umask = process.umask(0o177);
  server.listen(CONTROL_SOCKET, () => {
    process.umask(umask);
    fs.chmodSync(CONTROL_SOCKET, 0o600);
    log(`control socket ready in ${RUNTIME_DIR}`);
  });
  return server;
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.MessageContent],
  partials: [Partials.Message, Partials.Reaction, Partials.User],
});
let controlServer = null;
let stopping = false;
let shuttingDown = false;

client.once("ready", () => {
  log(`logged in as ${client.user.tag}`);
  // Opened only once the Gateway is live, so no handed-off message is missed.
  controlServer = startControlServer();
});

client.on("messageCreate", msg => {
  if (!msg.channel?.isThread?.() || msg.author?.bot || !USER_MESSAGE_TYPES.has(msg.type ?? 0)) return;
  if (!ALLOWED_USER_IDS.has(String(msg.author.id))) return;
  const entry = messageEntry(msg);
  const conv = conversations.get(msg.channelId);
  if (!conv) {
    if (msg.channel.parentId === String(project.channel_id)) {
      recent.push(entry);
      if (recent.length > RECENT_LIMIT) recent.shift();
    }
    return;
  }
  // Deduplicated by message id at the handoff.
  if (conv.included.has(entry.id)) return;
  if (!conv.handedOff) {
    conv.included.add(entry.id);
    conv.pending.push(entry);
    return;
  }
  log(`thread ${conv.threadId}: ${entry.author}: ${entry.content}`);
  route(conv, [{ type: "text", text: entry.content }]);
});

client.on("messageReactionAdd", async (reaction, user) => {
  const conv = conversations.get(reaction.message.channelId || reaction.message.channel?.id);
  if (!conv?.handedOff || !ALLOWED_USER_IDS.has(String(user.id))) return;
  try {
    if (user.partial) await user.fetch();
    if (reaction.partial) await reaction.fetch();
    if (reaction.message.partial) await reaction.message.fetch();
  } catch (error) {
    log(`thread ${conv.threadId}: reaction context unavailable: ${error.message}`);
    return;
  }
  if (user.bot || !FORWARDED_REACTIONS.has(reaction.emoji.name) || reaction.message.author?.id !== client.user.id) return;
  const source = reaction.message.content.trim().replace(/\s+/g, " ");
  const excerpt = source.length > 80 ? `${source.slice(0, 77)}...` : source;
  route(conv, [{ type: "text", text: `User ${user.globalName || user.username || user.id} reacted ` +
    `${reaction.emoji.name} to your message${excerpt ? `: "${excerpt}"` : ""} (message ID: ${reaction.message.id}).` }]);
});

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  log("shutting down");
  controlServer?.close();
  fs.rmSync(path.join(RUNTIME_DIR, CONTROL_SOCKET), { force: true });
  client.destroy();
  for (const starting of runtimes.values()) {
    const rt = await starting.catch(() => null);
    rt?.ws?.close();
    rt?.process?.kill();
  }
  await reports;
  process.exit(0);
}

for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => void shutdown());

client.login(bot.token).catch(error => {
  log(`Discord login failed: ${error.message}`);
  process.exit(1);
});
