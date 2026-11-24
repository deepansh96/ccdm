#!/usr/bin/env node
"use strict";

// A fake Google Antigravity CLI for the Gemini bridge: `agy acp` speaks the
// Agent Client Protocol over stdio, as the real one does, and starts each
// session's MCP servers itself, so a scripted `reply` goes through the real
// discord-mcp-server.js and the Router to the fake Discord.
//
// It reads its script from <dir>/agy-plan.json and appends every event to
// <dir>/agy.ndjson, where <dir> is CCDM_FAKE_AGY_DIR or CCDM_TEST_STATE.
// At start it logs its home and a `shell` event with the $HOME a zsh and a
// bash command it runs would see. The script:
//
//   sessionIds   ids handed out by session/new, in order (else random UUIDs)
//   turns        one entry per session/prompt across every agy process:
//                  reply      text sent with the Discord MCP `reply` tool
//                  text       agent message text (no tool call)
//                  usage      {used, size} sent as a usage_update
//                  delayMs    a wait before the turn ends
//                  holdUntilCancel  the turn ends only on session/cancel
//                  ignoreCancel     with holdUntilCancel: the turn never ends
//                  permission the turn first asks session/request_permission
//                             and logs the bridge's answer
//                  replyFails the `reply` tool call is reported failed (no post)
//                  error      the prompt fails with this JSON-RPC error
//                  stopReason the stop reason (default end_turn)
//                A prompt past the script replies "echo: <its text>".
//   compactDelayMs  how long a `/compact` prompt takes
//   exitDelayMs     how long SIGTERM takes to stop this agy
//
// A prompt that starts while another runs on the same session is logged as
// an `overlap` event: ACP runs one prompt at a time.
const { spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const dir = process.env.CCDM_FAKE_AGY_DIR || process.env.CCDM_TEST_STATE || os.tmpdir();
const planFile = path.join(dir, "agy-plan.json");
const logFile = path.join(dir, "agy.ndjson");
const counterFile = path.join(dir, "agy-turns-used");
const args = process.argv.slice(2);

const log = (event) => fs.appendFileSync(logFile, `${JSON.stringify({ pid: process.pid, ...event })}\n`);
const readPlan = () => {
  try {
    return JSON.parse(fs.readFileSync(planFile, "utf8"));
  } catch {
    return {};
  }
};

log({ event: "spawn", argv: args, cwd: process.cwd(), home: os.homedir() });
// The home the agent's shell commands would see, under zsh and bash.
if (args[0] === "acp") {
  const { execFileSync } = require("node:child_process");
  const shellHome = (shell) => {
    try {
      return execFileSync(shell, ["-c", 'printf %s "$HOME"'], { encoding: "utf8", timeout: 5000 });
    } catch (error) {
      return `error: ${error.message}`;
    }
  };
  log({ event: "shell", zsh: shellHome("/bin/zsh"), bash: shellHome("/bin/bash") });
}
if (args[0] !== "acp") {
  process.stderr.write(`fake agy supports only acp, not ${args.join(" ")}\n`);
  process.exit(2);
}

const MODELS = ["gemini-4-neon", "gemini-4-argon", "gemini-3.8-flash", "claude-opus-5-5"];
const LEVELS = ["low", "medium", "high", "xhigh"];
const sessions = new Map();

function configOptions(session) {
  return [
    { id: "model", name: "Model", category: "model", type: "select", currentValue: session.model,
      options: MODELS.map((value) => ({ value, name: value })) },
    { id: "thought_level", name: "Thinking Level", category: "thought_level", type: "select", currentValue: session.level,
      options: LEVELS.map((value) => ({ value, name: value })) },
  ];
}

function nextTurn() {
  let used = 0;
  try {
    used = Number(fs.readFileSync(counterFile, "utf8")) || 0;
  } catch { /* first turn */ }
  fs.writeFileSync(counterFile, String(used + 1));
  return (readPlan().turns || [])[used];
}

function send(message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
}

// Requests this agent sends the client, by id.
let nextAgentRequestId = 1;
const agentRequests = new Map();
const askClient = (method, params) => new Promise((resolve) => {
  const id = `agent-${nextAgentRequestId++}`;
  agentRequests.set(id, resolve);
  send({ id, method, params });
});

const update = (sessionId, body) => send({ method: "session/update", params: { sessionId, update: body } });

// A minimal MCP stdio client for one session's server.
function startMcp(server) {
  const env = { ...process.env };
  for (const { name, value } of server.env || []) env[name] = value;
  const child = spawn(server.command, server.args || [], { env, stdio: ["pipe", "pipe", "pipe"] });
  let buffer = "";
  let nextId = 1;
  const pending = new Map();
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      if (pending.has(message.id)) {
        pending.get(message.id)(message);
        pending.delete(message.id);
      }
    }
  });
  child.stderr.on("data", (chunk) => log({ event: "mcp-stderr", server: server.name, text: String(chunk) }));
  const request = (method, params) => new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
  const ready = (async () => {
    await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake-agy", version: "0" } });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    const tools = await request("tools/list", {});
    log({ event: "mcp-tools", server: server.name, tools: (tools.result?.tools || []).map((tool) => tool.name) });
  })();
  return {
    name: server.name,
    async call(name, toolArgs) {
      await ready;
      const response = await request("tools/call", { name, arguments: toolArgs });
      log({ event: "mcp-call", server: server.name, name, args: toolArgs, result: response.result, error: response.error });
      return response;
    },
    close: () => child.kill(),
  };
}

function openSession(sessionId, params) {
  const append = params?._meta?.antigravity?.systemPrompt?.append || "";
  const session = {
    id: sessionId,
    model: "gemini-4-neon",
    level: "high",
    scopeToken: /scope_token: "([0-9a-f]+)"/.exec(append)?.[1] || "",
    mcp: (params.mcpServers || []).map(startMcp),
    cancel: null,
  };
  sessions.set(sessionId, session);
  // agy keeps each conversation in a database under its data directory.
  const conversations = path.join(os.homedir(), ".gemini", "antigravity-cli", "conversations");
  fs.mkdirSync(conversations, { recursive: true });
  fs.writeFileSync(path.join(conversations, `${sessionId}.db`), "");
  return { sessionId, configOptions: configOptions(session) };
}

async function prompt(params) {
  const session = sessions.get(params.sessionId);
  if (!session) throw Object.assign(new Error("unknown session"), { code: -32602 });
  session.running = (session.running || 0) + 1;
  if (session.running > 1) log({ event: "overlap", sessionId: session.id });
  try {
    return await runPrompt(session, params);
  } finally {
    session.running -= 1;
  }
}

async function runPrompt(session, params) {
  const text = (params.prompt || []).filter((block) => block.type === "text").map((block) => block.text).join("\n");
  if (text.trim() === "/compact") {
    const delay = readPlan().compactDelayMs;
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    return { stopReason: "end_turn" };
  }
  const turn = nextTurn() || { reply: `echo: ${text}` };
  if (turn.error) throw Object.assign(new Error(turn.error), { code: -32603 });
  if (turn.usage) {
    update(session.id, { sessionUpdate: "usage_update", ...turn.usage });
    // The reply below goes through the MCP server, a separate process that
    // reads the bridge's context percentage. A round trip to the bridge (it
    // answers an unknown method with an error) proves the bridge has handled
    // the usage_update first, so the reply always carries the percentage.
    await askClient("_ccdm/fake_barrier", {});
  }
  const cancelled = new Promise((resolve) => { session.cancel = resolve; });
  if (turn.permission) {
    const answer = await askClient("session/request_permission", {
      sessionId: session.id,
      toolCall: { toolCallId: randomUUID(), title: "Run shell command", kind: "execute", status: "pending" },
      options: [
        { optionId: "reject", name: "Reject", kind: "reject_once" },
        { optionId: "once", name: "Allow once", kind: "allow_once" },
        { optionId: "always", name: "Always allow", kind: "allow_always" },
      ],
    });
    log({ event: "permission", answer });
  }
  if (turn.holdUntilCancel) {
    if (turn.ignoreCancel) await new Promise(() => {});
    await cancelled;
    session.cancel = null;
    return { stopReason: "cancelled" };
  }
  if (turn.holdUntilFile) {
    while (!fs.existsSync(turn.holdUntilFile)) {
      const outcome = await Promise.race([
        cancelled.then(() => "cancelled"),
        new Promise((resolve) => setTimeout(() => resolve("poll"), 25)),
      ]);
      if (outcome === "cancelled") {
        session.cancel = null;
        return { stopReason: "cancelled" };
      }
    }
  }
  if (turn.delayMs) {
    const outcome = await Promise.race([cancelled.then(() => "cancelled"),
      new Promise((resolve) => setTimeout(() => resolve("done"), turn.delayMs))]);
    if (outcome === "cancelled") {
      session.cancel = null;
      return { stopReason: "cancelled" };
    }
  }
  session.cancel = null;
  if (turn.text) update(session.id, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: turn.text } });
  if (Array.isArray(turn.mcpCalls)) {
    const discord = session.mcp.find((server) => server.name.startsWith("discord-"));
    const reqMatch = /^\[Agent Request (req-[0-9a-f]{12}) /.exec(text);
    for (const call of turn.mcpCalls) {
      const resolvedArgs = { ...(call.args || {}) };
      if (call.withScopeToken) resolvedArgs.scope_token = session.scopeToken;
      if (call.extractRequestId && reqMatch) resolvedArgs.request_id = reqMatch[1];
      const toolName = `mcp_${discord?.name}_${call.name}`;
      const toolCallId = randomUUID();
      update(session.id, { sessionUpdate: "tool_call", toolCallId, name: toolName, title: `Run ${toolName}`, status: "in_progress", kind: "other" });
      await discord?.call(call.name, resolvedArgs);
      update(session.id, { sessionUpdate: "tool_call_update", toolCallId, name: toolName, status: "completed", kind: "other" });
    }
  }
  if (turn.reply !== undefined) {
    const discord = session.mcp.find((server) => server.name.startsWith("discord-"));
    const toolName = `mcp_${discord?.name}_reply`;
    const toolCallId = randomUUID();
    update(session.id, { sessionUpdate: "tool_call", toolCallId, name: toolName, title: `Run ${toolName}`, status: "in_progress", kind: "other" });
    if (turn.replyFails) {
      update(session.id, { sessionUpdate: "tool_call_update", toolCallId, name: toolName, status: "failed", kind: "other" });
    } else {
      await discord?.call("reply", { text: turn.reply, scope_token: session.scopeToken });
      update(session.id, { sessionUpdate: "tool_call_update", toolCallId, name: toolName, status: "completed", kind: "other" });
    }
  }
  return { stopReason: turn.stopReason || "end_turn" };
}

async function handle(message) {
  switch (message.method) {
    case "initialize":
      return { protocolVersion: 1, agentInfo: { name: "Fake Antigravity ACP Server", version: "0.0.0" },
        agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} }, promptCapabilities: { image: true } } };
    case "session/new": {
      const plan = readPlan();
      const used = [...sessions.keys()].length;
      return openSession(plan.sessionIds?.[used] || randomUUID(), message.params);
    }
    case "session/resume":
    case "session/load": {
      const db = path.join(os.homedir(), ".gemini", "antigravity-cli", "conversations", `${message.params.sessionId}.db`);
      if (!fs.existsSync(db)) throw Object.assign(new Error("conversation not found"), { code: -32602 });
      return openSession(message.params.sessionId, message.params);
    }
    case "session/set_config_option": {
      const session = sessions.get(message.params.sessionId);
      const { configId, value } = message.params;
      if (configId === "model" && MODELS.includes(value)) session.model = value;
      else if (configId === "thought_level" && LEVELS.includes(value)) session.level = value;
      else throw Object.assign(new Error(`invalid ${configId} ${value}`), { code: -32602 });
      return { configOptions: configOptions(session) };
    }
    case "session/prompt":
      return prompt(message.params);
    default:
      throw Object.assign(new Error(`unknown method ${message.method}`), { code: -32601 });
  }
}

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  let newline;
  while ((newline = input.indexOf("\n")) >= 0) {
    const line = input.slice(0, newline).trim();
    input = input.slice(newline + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    log({ event: "client", message });
    if (message.method === "session/cancel") {
      sessions.get(message.params?.sessionId)?.cancel?.();
      continue;
    }
    if (message.id !== undefined && !message.method && agentRequests.has(message.id)) {
      agentRequests.get(message.id)(message.result ?? { error: message.error });
      agentRequests.delete(message.id);
      continue;
    }
    if (message.id === undefined || !message.method) continue;
    handle(message).then(
      (result) => send({ id: message.id, result }),
      (error) => send({ id: message.id, error: { code: error.code || -32603, message: error.message } }),
    );
  }
});
// Stdin closing (the bridge exited) or SIGTERM stops it, after exitDelayMs.
let exiting = false;
function exitSoon(reason) {
  if (exiting) return;
  exiting = true;
  log({ event: "exit", reason });
  for (const session of sessions.values()) for (const server of session.mcp) server.close();
  const delay = readPlan().exitDelayMs;
  if (delay) setTimeout(() => process.exit(0), delay);
  else process.exit(0);
}
process.stdin.on("end", () => exitSoon("stdin closed"));
process.on("SIGTERM", () => exitSoon("SIGTERM"));
