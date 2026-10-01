import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { WebSocketServer } from "ws";

import { createWorkspace, scaledTimeout } from "./runner.js";
import { readState, recordCommandInvocation, updateState } from "./state.js";
import { registerTeardownCallback } from "./teardown.js";

const overlayRoots = new WeakMap();

function writeOverlay(workspace) {
  const overlayRoot = path.join(workspace.tmpRoot, "overlays", "node_modules");
  const discordModule = path.join(overlayRoot, "discord.js");
  fs.mkdirSync(discordModule, { recursive: true });
  fs.writeFileSync(
    path.join(discordModule, "index.js"),
    `module.exports = require(${JSON.stringify(path.join(workspace.repoDir, "tests/e2e/support/discord-shim.cjs"))});\n`,
  );
  return overlayRoot;
}

export function bridgeChildEnv(workspace, extraEnv = {}) {
  const overlayRoot = overlayRoots.get(workspace) ?? writeOverlay(workspace);
  overlayRoots.set(workspace, overlayRoot);
  const nodePath = [overlayRoot, workspace.env.NODE_PATH].filter(Boolean).join(path.delimiter);
  return {
    ...workspace.env,
    CCDM_TEST_ACCELERATE_TYPING: "1",
    NODE_OPTIONS: `--require ${path.join(workspace.repoDir, "tests/e2e/support/preload.cjs")}`,
    NODE_PATH: nodePath,
    ...extraEnv,
  };
}

// The Router's private state lives inside the Test Workspace; a short path
// keeps the socket under the platform's Unix-socket length limit.
export function createBridgeWorkspace(options = {}) {
  const base = createWorkspace(options);
  const routerStateDir = path.join(base.tmpRoot, "router");
  const workspace = Object.freeze({ ...base, routerStateDir, socketPath: path.join(routerStateDir, "router.sock") });
  overlayRoots.set(workspace, writeOverlay(workspace));
  return workspace;
}

export function collectProcess(child, metadata, workspace) {
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

  const closed = new Promise((resolve) => {
    child.on("close", (exitCode, signal) => {
      const result = {
        ...metadata,
        exitCode,
        signal,
        stderr,
        stdout,
      };
      recordCommandInvocation(result, { stateDir: workspace.stateDir });
      resolve(result);
    });
  });

  return {
    child,
    get stderr() {
      return stderr;
    },
    get stdout() {
      return stdout;
    },
    closed,
    async stop() {
      if (child.exitCode !== null || child.signalCode) return closed;
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        try {
          child.kill("SIGTERM");
        } catch {
          // The process may have already exited.
        }
      }
      return closed;
    },
    async waitForOutput(pattern, timeoutMs = 5000) {
      const deadline = Date.now() + scaledTimeout(timeoutMs);
      while (Date.now() < deadline) {
        if (pattern.test(stdout) || pattern.test(stderr)) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error(`Timed out waiting for ${pattern}; stdout:\n${stdout}\nstderr:\n${stderr}`);
    },
  };
}

export function runPreloadProbe(workspace, code, extraEnv = {}) {
  const env = bridgeChildEnv(workspace, extraEnv);
  const child = spawn(process.execPath, ["-e", code], {
    cwd: workspace.repoDir,
    detached: true,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const running = collectProcess(
    child,
    { command: [process.execPath, "-e", code], cwd: workspace.repoDir, detached: true, env },
    workspace,
  );
  return running.closed;
}

function recordCodexEvent(workspace, event) {
  updateState(workspace.stateDir, (state) => {
    state.fixtures.codex.protocolEvents.push({ at: new Date().toISOString(), ...event });
  });
}

function markCodexServer(workspace, port, values) {
  updateState(workspace.stateDir, (state) => {
    state.fixtures.codex.servers[String(port)] = {
      ...(state.fixtures.codex.servers[String(port)] ?? {}),
      ...values,
    };
  });
}

// Runs the MCP server the bridge registered, as Codex would, and calls one of
// its tools over stdio. Its environment is the registered config's, on top of
// the Test Workspace's.
async function callRegisteredMcpTool(workspace, config, name, args) {
  const command = config.command === "node" ? process.execPath : config.command;
  const child = spawn(command, config.args ?? [], { env: bridgeChildEnv(workspace, config.env ?? {}), stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const write = (message) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  const result = await new Promise((resolve, reject) => {
    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const message = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        if (message.id === 1) {
          write({ method: "notifications/initialized" });
          write({ id: 2, method: "tools/call", params: { name, arguments: args } });
        } else if (message.id === 2) {
          resolve(message.result);
        }
      }
    });
    child.on("exit", (code) => reject(new Error(`MCP server exited with ${code}: ${stderr}`)));
    write({ id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "codex-fixture", version: "1" } } });
  });
  child.stdin.end();
  return result;
}

// With `codexHome`, the fake app-server keeps its MCP config in that Codex
// Home's `config.toml`, which several fake app-servers may share, as real ones
// do. It loads the file's MCP servers when it starts and again on
// `config/mcpServer/reload`, and reports only those it loaded. Each reload's
// loaded names are recorded as the server's `mcpReloads`.
const mcpSectionHeader = /^\[mcp_servers\.([^.\]]+)(?:\.[^\]]*)?\]\s*$/;

function readCodexConfig(codexHome) {
  try {
    return fs.readFileSync(path.join(codexHome, "config.toml"), "utf8");
  } catch {
    return "";
  }
}

function configuredMcpNames(codexHome) {
  const names = readCodexConfig(codexHome).split("\n").map((line) => line.match(mcpSectionHeader)?.[1]).filter(Boolean);
  return [...new Set(names)];
}

function withoutMcpSection(text, name) {
  let skip = false;
  return text.split("\n").filter((line) => {
    if (line.startsWith("[")) skip = line.match(mcpSectionHeader)?.[1] === name;
    return !skip;
  }).join("\n");
}

function mcpSection(name, value) {
  const tomlValue = (v) => (Array.isArray(v) ? `[${v.map(tomlValue).join(", ")}]` : typeof v === "string" ? JSON.stringify(v) : String(v));
  const { env, ...fields } = value ?? {};
  const lines = [`[mcp_servers.${name}]`, ...Object.entries(fields).map(([key, v]) => `${key} = ${tomlValue(v)}`)];
  if (env) lines.push("", `[mcp_servers.${name}.env]`, ...Object.entries(env).map(([key, v]) => `${key} = ${tomlValue(v)}`));
  return `${lines.join("\n")}\n`;
}

function writeCodexConfig(codexHome, text) {
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(codexHome, "config.toml"), text);
}

// `port` binds that port instead of a free one; with `deferListen` it is
// registered for the fixture `codex` at once but bound only by `listen()`, so a
// port allocator can still see it free.
export async function startFakeCodexServer(workspace, options = {}) {
  const httpServer = http.createServer();
  const server = new WebSocketServer({ server: httpServer });
  const listen = () => new Promise((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(options.port ?? 0, "127.0.0.1", resolve);
  });
  if (!options.deferListen) await listen();
  const port = options.port ?? httpServer.address().port;
  const turnPlans = [...(options.turns ?? [])];
  const steerPlans = [...(options.steer ?? [])];
  let serverRequestId = 10000;
  let threadStartCount = 0;
  let registeredMcpName = `discord-${options.channelId ?? "channel-id"}`;
  let registeredMcpConfig = null;
  let mcpStatusCount = 0;
  let mcpReloadCount = 0;
  // A stale server stays loaded until it is deleted and MCP servers reload.
  let staleLoaded = Boolean(options.staleMcpName);
  let staleDeleted = false;
  const codexHome = options.codexHome;
  let loadedMcpNames = codexHome ? configuredMcpNames(codexHome) : [];
  const configDelayMs = options.configDelayMs ?? 0;
  const interruptedTurnIds = new Set();
  const pendingTurnReleases = new Map();
  const clientMessages = [];
  markCodexServer(workspace, port, { ready: true, ...(options.fixture ?? {}) });

  server.on("connection", (socket) => {
    recordCodexEvent(workspace, { event: "connection", port });
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString());
      clientMessages.push(message);
      recordCodexEvent(workspace, { event: "client-message", message });
      if (!message.method) return;
      if (message.method === "initialized") return;

      const reply = (result) => {
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
      };
      const replyError = (error) => {
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, error }));
      };
      const notify = (method, params) => {
        socket.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
      };
      const serverRequest = (method, params = {}) => {
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: serverRequestId++, method, params }));
      };

      switch (message.method) {
        case "initialize":
          reply({});
          if (options.closeAfterInitialize) socket.close();
          break;
        case "mcpServerStatus/list":
          if (options.failMcpStatus) {
            replyError({ code: -32000, message: options.failMcpStatus });
            break;
          }
          mcpStatusCount += 1;
          if (options.paginatedMcp && !message.params?.cursor) {
            reply({ data: [{ name: "unrelated", tools: {} }], nextCursor: "discord-page" });
            break;
          }
          if (codexHome) {
            reply({ data: loadedMcpNames.map((name) => ({ name, tools: { reply: { name: "reply" } } })) });
            break;
          }
          reply({
            data: [
              ...(staleLoaded ? [{ name: options.staleMcpName, status: "running" }] : []),
              { name: registeredMcpName, tools: options.missingReply || mcpStatusCount <= (options.mcpReadyAfter ?? 0) ? {} : { reply: { name: "reply" } } },
            ],
          });
          break;
        case "config/value/write": {
          // As the real app-server: a `replace` write of null removes the
          // key (an MCP server's whole table); there is no delete method.
          const keyPath = String(message.params?.keyPath ?? "");
          const mcpName = keyPath.startsWith("mcp_servers.") ? keyPath.slice("mcp_servers.".length) : null;
          if (message.params?.value === null) {
            if (message.params?.mergeStrategy !== "replace") {
              replyError({ code: -32600, message: "null value requires mergeStrategy replace" });
              break;
            }
            if (options.failStaleMcpRemoval && keyPath.includes(options.staleMcpName ?? "discord-")) {
              replyError({ code: -32000, message: options.failStaleMcpRemoval });
              break;
            }
            if (options.staleMcpName && mcpName === options.staleMcpName) staleDeleted = true;
            if (codexHome && mcpName) writeCodexConfig(codexHome, withoutMcpSection(readCodexConfig(codexHome), mcpName));
            setTimeout(() => reply({}), configDelayMs);
            break;
          }
          if (mcpName) {
            registeredMcpName = mcpName;
            registeredMcpConfig = message.params.value;
          }
          if (options.failMcpRegistration) {
            replyError({ code: -32000, message: options.failMcpRegistration });
            break;
          }
          if (codexHome && mcpName) {
            const rest = withoutMcpSection(readCodexConfig(codexHome), mcpName).replace(/\n*$/, "");
            writeCodexConfig(codexHome, `${rest ? `${rest}\n\n` : ""}${mcpSection(mcpName, message.params.value)}`);
          }
          setTimeout(() => reply({}), configDelayMs);
          break;
        }
        case "config/mcpServer/reload":
          // \`hangMcpReloadAfter: n\`: every reload after the first n never answers.
          mcpReloadCount += 1;
          if (options.hangMcpReloadAfter !== undefined && mcpReloadCount > options.hangMcpReloadAfter) break;
          if (staleDeleted) staleLoaded = false;
          if (codexHome) {
            loadedMcpNames = configuredMcpNames(codexHome);
            const loaded = [...loadedMcpNames];
            updateState(workspace.stateDir, (state) => {
              const record = state.fixtures.codex.servers[String(port)];
              record.mcpReloads = [...(record.mcpReloads ?? []), loaded];
            });
          }
          reply({});
          break;
        case "thread/resume":
          if (options.resumeError) {
            replyError({ code: -32000, message: options.resumeError });
          } else {
            reply({ thread: { id: message.params.threadId } });
          }
          break;
        case "thread/start":
          threadStartCount += 1;
          {
            const configuredThreadIds = options.threadIds ?? (options.threadId ? [options.threadId] : null);
            const startedThreadId = configuredThreadIds?.[threadStartCount - 1] ?? configuredThreadIds?.[configuredThreadIds.length - 1] ?? `thread-${threadStartCount}`;
            if (options.omitThreadStarted) {
              reply({});
              break;
            }
            reply({ thread: { id: startedThreadId } });
            setTimeout(() => notify("thread/started", { thread: { id: startedThreadId } }), 5);
          }
          break;
        case "turn/start": {
          const isSystem = message.params?.input?.[0]?.text?.startsWith("You are communicating with the user via Discord");
          if (isSystem && options.bootstrapError) {
            replyError({ code: -32000, message: options.bootstrapError });
            break;
          }
          const plan = isSystem ? (options.bootstrapPlan ?? { delta: "", complete: true }) : (turnPlans.shift() ?? { delta: "Codex response", complete: true });
          const turnId = plan.turnId ?? `turn-${Date.now()}`;
          const notificationTurnId = plan.notificationTurnId ?? turnId;
          const turnThreadId = message.params?.threadId;
          reply({ turn: { id: turnId } });
          const startTimer = setTimeout(() => {
            for (const notification of plan.notificationsBeforeStart ?? []) {
              notify(notification.method, {
                threadId: turnThreadId,
                ...notification.params,
              });
            }
            if (!plan.omitTurnStarted) {
              notify("turn/started", { threadId: turnThreadId, turn: { id: notificationTurnId } });
            }
            if (plan.approvals || options.approvals) {
              serverRequest("fileChangeRequestApproval", { turnId });
              serverRequest("execCommandApproval", { turnId });
              serverRequest("permissionsRequestApproval", { turnId });
              serverRequest("toolRequestUserInput", { turnId });
            }
          }, plan.startDelayMs ?? plan.delayMs ?? 10);
          startTimer.unref?.();
          const completeTurn = () => {
            if (interruptedTurnIds.has(turnId)) return;
            for (const notification of plan.notificationsBeforeComplete ?? []) {
              notify(notification.method, {
                threadId: turnThreadId,
                ...notification.params,
              });
            }
            if (plan.mcpReply || plan.mcpTool) {
              notify("item/started", {
                threadId: turnThreadId,
                turnId: notificationTurnId,
                item: { type: "mcpToolCall", server: `discord-${options.channelId ?? "channel-id"}`, tool: plan.mcpTool ?? "reply" },
              });
            }
            if (plan.delta) {
              notify("item/agentMessage/delta", { threadId: turnThreadId, turnId: notificationTurnId, delta: plan.delta });
            }
            if (plan.error) {
              notify("error", {
                error: { message: plan.error },
                willRetry: plan.willRetry ?? false,
                threadId: turnThreadId,
                turnId: notificationTurnId,
              });
            }
            if (plan.tokenUsage) {
              notify("thread/tokenUsage/updated", { tokenUsage: plan.tokenUsage });
            }
            if (plan.completedItem) {
              notify("item/completed", {
                threadId: turnThreadId,
                turnId: notificationTurnId,
                item: plan.completedItem === true
                  ? { type: "agentMessage", text: plan.delta ?? "" }
                  : plan.completedItem,
              });
            }
            if (plan.complete !== false) {
              notify("turn/completed", { threadId: turnThreadId, turn: { id: notificationTurnId, ...(plan.status ? { status: plan.status, error: plan.terminalError } : {}) } });
            }
            pendingTurnReleases.delete(turnId);
          };
          // `mcpReplyText`: the agent replies through the registered Discord
          // MCP server's reply tool before the turn completes, adding the
          // arguments `mcpReplyArgs(input)` derives from the turn input (a root
          // turn's channel grant). `mcpEditText` then edits that reply with its
          // edit_message tool.
          const callTool = (tool, args) => {
            notify("item/started", {
              threadId: turnThreadId,
              turnId: notificationTurnId,
              item: { type: "mcpToolCall", server: registeredMcpName, tool },
            });
            return callRegisteredMcpTool(workspace, registeredMcpConfig, tool, {
              ...args,
              scope_token: registeredMcpConfig.env.DISCORD_REPLY_TOKEN,
            }).then(
              (result) => {
                recordCodexEvent(workspace, { event: "mcp-tool-result", tool, result });
                return result;
              },
              (error) => recordCodexEvent(workspace, { event: "mcp-tool-result", tool, error: error.message }),
            );
          };
          // `mcpCalls(input)`: the agent calls these `[tool, args]` in order;
          // a string argument "{{last_id}}" becomes the last "(id: X)" result.
          const runCalls = async () => {
            let lastId = "";
            for (const [tool, args] of plan.mcpCalls(message.params.input)) {
              const expanded = Object.fromEntries(Object.entries(args).map(([key, value]) =>
                [key, value === "{{last_id}}" ? lastId : value]));
              const result = await callTool(tool, expanded);
              lastId = /\(id: ([^)]+)\)/.exec(result?.content?.[0]?.text ?? "")?.[1] ?? lastId;
            }
          };
          const finishTurn = plan.mcpCalls
            ? () => runCalls().then(completeTurn)
            : plan.mcpReplyText
            ? () => {
              callTool("reply", { text: plan.mcpReplyText, ...plan.mcpReplyArgs?.(message.params.input) }).then((result) => {
                const messageId = /\(id: ([^)]+)\)/.exec(result?.content?.[0]?.text ?? "")?.[1];
                if (plan.mcpEditText && messageId) return callTool("edit_message", { message_id: messageId, text: plan.mcpEditText });
              }).then(completeTurn);
            }
            : completeTurn;
          if (plan.waitForRelease) {
            pendingTurnReleases.set(turnId, finishTurn);
          } else {
            const completionTimer = setTimeout(finishTurn, plan.delayMs ?? 10);
            completionTimer.unref?.();
          }
          break;
        }
        case "turn/interrupt":
          if (message.params?.turnId) {
            interruptedTurnIds.add(message.params.turnId);
            pendingTurnReleases.delete(message.params.turnId);
          }
          reply({});
          break;
        case "turn/steer": {
          const plan = steerPlans.shift() ?? "success";
          if (plan === "failure" || plan?.error) {
            replyError({ code: -32000, message: plan?.error ?? "stale turn" });
          } else {
            reply({});
          }
          break;
        }
        case "thread/compact/start":
          reply({});
          if (options.compactComplete) {
            setTimeout(() => {
              const threadId = message.params?.threadId ?? options.threadId ?? "thread-1";
              const turnId = options.compactTurnId ?? "compact-turn";
              notify("turn/started", { threadId, turn: { id: turnId } });
              notify("thread/compacted", { threadId, turnId });
              notify("item/completed", { threadId, turnId, item: { type: "contextCompaction" } });
              notify("turn/completed", { threadId, turn: { id: turnId } });
            }, 5);
          }
          break;
        case "thread/archive":
          reply({});
          break;
        default:
          // A Contract-Checking Fake: a method the real app-server lacks (such
          // as `config/value/delete`) fails as it does there.
          replyError({ code: -32600, message: `Invalid request: unknown variant \`${message.method}\`` });
      }
    });
  });

  registerTeardownCallback(async () => {
    // A bridge still connected would otherwise hold the close open.
    for (const client of server.clients) client.terminate();
    await new Promise((resolve) => server.close(resolve));
    if (httpServer.listening) await new Promise((resolve) => httpServer.close(resolve));
  });

  return {
    port,
    server,
    listen,
    clientMessages,
    releaseTurn(turnId) {
      const release = pendingTurnReleases.get(turnId);
      if (!release) throw new Error(`No pending fake turn release for ${turnId}`);
      release();
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
      if (httpServer.listening) await new Promise((resolve) => httpServer.close(resolve));
      markCodexServer(workspace, port, { ready: false });
    },
  };
}

// Injection runs while the bridge's fake gateway poller marks messages
// delivered, so it must hold the state lock like every other writer.
export function injectDiscordMessage(workspace, message = {}) {
  updateState(workspace.stateDir, (state) => {
    state.fixtures.discord.injectedMessages.push({
      author: { bot: false, id: "allowed-user-id", username: "Allowed User", ...(message.author ?? {}) },
      channelId: message.channelId ?? "channel-id",
      type: message.type ?? 0,
      ...(message.channelType !== undefined ? { channelType: message.channelType } : {}),
      ...(message.parentId ? { parentId: message.parentId } : {}),
      content: message.content ?? "hello",
      delivered: false,
      id: message.id ?? `message-${Date.now()}`,
      attachments: message.attachments ?? [],
      ...(message.webhookId ? { webhookId: message.webhookId } : {}),
      ...(message.createdTimestamp ? { createdTimestamp: message.createdTimestamp } : {}),
      ...(message.replyTo ? { replyTo: message.replyTo } : {}),
    });
  });
}

export function injectDiscordReaction(workspace, reaction = {}) {
  updateState(workspace.stateDir, (state) => {
    state.fixtures.discord.injectedReactions.push({
      channelId: reaction.channelId ?? "channel-id",
      delivered: false,
      emoji: reaction.emoji ?? "👍",
      id: reaction.id ?? `reaction-${Date.now()}`,
      message: {
        author: { bot: true, id: "fixture-bot-user-id", username: "Fixture Bot", ...(reaction.message?.author ?? {}) },
        content: reaction.message?.content ?? "",
        partial: reaction.message?.partial ?? false,
        ...(reaction.message?.webhookId ? { webhookId: reaction.message.webhookId } : {}),
      },
      messageId: reaction.messageId ?? "bot-message-id",
      partial: reaction.partial ?? false,
      user: {
        bot: false,
        id: "allowed-user-id",
        partial: false,
        username: "Allowed User",
        ...(reaction.user ?? {}),
      },
    });
  });
}

export async function waitForState(workspace, predicate, timeoutMs = 5000) {
  const deadline = Date.now() + scaledTimeout(timeoutMs);
  while (Date.now() < deadline) {
    const state = readState(workspace.stateDir);
    if (predicate(state)) return state;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for fixture state condition: ${JSON.stringify(readState(workspace.stateDir), null, 2)}`);
}
