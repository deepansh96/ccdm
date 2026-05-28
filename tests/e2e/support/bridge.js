import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { WebSocketServer } from "ws";

import { createWorkspace } from "./runner.js";
import { readState, recordCommandInvocation, writeState } from "./state.js";
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

export function createBridgeWorkspace(options = {}) {
  const workspace = createWorkspace(options);
  overlayRoots.set(workspace, writeOverlay(workspace));
  return workspace;
}

function collectProcess(child, metadata, workspace) {
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
      const deadline = Date.now() + timeoutMs;
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
  const state = readState(workspace.stateDir);
  state.fixtures.codex.protocolEvents.push({ at: new Date().toISOString(), ...event });
  writeState(state, workspace.stateDir);
}

function markCodexServer(workspace, port, values) {
  const state = readState(workspace.stateDir);
  state.fixtures.codex.servers[String(port)] = {
    ...(state.fixtures.codex.servers[String(port)] ?? {}),
    ...values,
  };
  writeState(state, workspace.stateDir);
}

export async function startFakeCodexServer(workspace, options = {}) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  const port = server.address().port;
  const turnPlans = [...(options.turns ?? [])];
  const steerPlans = [...(options.steer ?? [])];
  let serverRequestId = 10000;
  markCodexServer(workspace, port, { ready: true, ...(options.fixture ?? {}) });

  server.on("connection", (socket) => {
    recordCodexEvent(workspace, { event: "connection", port });
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString());
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
          reply({
            servers: [
              ...(options.staleMcpName ? [{ name: options.staleMcpName, status: "running" }] : []),
              { name: `discord-${options.channelId ?? "channel-id"}`, status: "running" },
            ],
          });
          break;
        case "config/value/delete":
          if (options.failStaleMcpRemoval && String(message.params?.keyPath ?? "").includes(options.staleMcpName ?? "discord-")) {
            replyError({ code: -32000, message: options.failStaleMcpRemoval });
            break;
          }
          reply({});
          break;
        case "config/value/write":
          if (options.failMcpRegistration) {
            replyError({ code: -32000, message: options.failMcpRegistration });
            break;
          }
          reply({});
          break;
        case "config/mcpServer/reload":
          reply({});
          break;
        case "thread/start":
          reply({});
          if (!options.omitThreadStarted) {
            setTimeout(() => notify("thread/started", { thread: { id: options.threadId ?? "thread-1" } }), 5);
          }
          break;
        case "turn/start": {
          reply({ turnId: `turn-${Date.now()}` });
          const isSystem = message.params?.input?.[0]?.text?.startsWith("You are communicating with the user via Discord");
          const plan = isSystem ? { delta: "", complete: true } : (turnPlans.shift() ?? { delta: "Codex response", complete: true });
          const turnId = plan.turnId ?? `turn-${Date.now()}`;
          setTimeout(() => {
            notify("turn/started", { turn: { id: turnId } });
            if (plan.approvals || options.approvals) {
              serverRequest("fileChangeRequestApproval", { turnId });
              serverRequest("execCommandApproval", { turnId });
              serverRequest("permissionsRequestApproval", { turnId });
              serverRequest("toolRequestUserInput", { turnId });
            }
          }, plan.startDelayMs ?? plan.delayMs ?? 10);
          setTimeout(() => {
            if (plan.mcpReply) {
              notify("item/started", { item: { type: "mcpToolCall", server: `discord-${options.channelId ?? "channel-id"}`, tool: "reply" } });
            }
            if (plan.delta) {
              notify("item/agentMessage/delta", { delta: plan.delta });
            }
            if (plan.error) {
              notify("error", {
                error: { message: plan.error },
                willRetry: plan.willRetry ?? false,
              });
            }
            if (plan.tokenUsage) {
              notify("thread/tokenUsage/updated", { tokenUsage: plan.tokenUsage });
            }
            if (plan.complete !== false) {
              notify("turn/completed", {});
            }
          }, plan.delayMs ?? 10);
          break;
        }
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
              notify("thread/compacted", { threadId: message.params?.threadId ?? options.threadId ?? "thread-1" });
              notify("item/completed", { item: { type: "contextCompaction" } });
            }, 5);
          }
          break;
        case "thread/archive":
          reply({});
          break;
        default:
          reply({});
      }
    });
  });

  registerTeardownCallback(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  return {
    port,
    server,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      markCodexServer(workspace, port, { ready: false });
    },
  };
}

export function startBridge(workspace, options = {}) {
  const env = bridgeChildEnv(workspace, {
    ALLOWED_USER_ID: options.allowedUserId ?? "allowed-user-id",
    BOT_APP_ID: options.botAppId ?? "bot-app-id",
    BOT_DISPLAY_NAME: options.botDisplayName ?? "bot2-alpha-codex",
    BOT_TOKEN: options.botToken ?? "bot-token",
    CHANNEL_ID: options.channelId ?? "channel-id",
    GUILD_ID: options.guildId ?? "guild-id",
    PROJECT_DIR: options.projectDir ?? workspace.repoDir,
    ROOT_BOT_TOKEN: options.rootBotToken ?? "root-token",
    WS_PORT: String(options.port),
  });
  const command = [process.execPath, path.join(workspace.repoDir, "scripts/codex-bridge.js")];
  const child = spawn(command[0], [command[1]], {
    cwd: workspace.repoDir,
    detached: true,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const running = collectProcess(child, { command, cwd: workspace.repoDir, detached: true, env }, workspace);
  registerTeardownCallback(() => running.stop());
  return running;
}

export function injectDiscordMessage(workspace, message = {}) {
  const state = readState(workspace.stateDir);
  state.fixtures.discord.injectedMessages.push({
    author: { bot: false, id: "allowed-user-id", username: "Allowed User", ...(message.author ?? {}) },
    channelId: message.channelId ?? "channel-id",
    content: message.content ?? "hello",
    delivered: false,
    id: message.id ?? `message-${Date.now()}`,
    attachments: message.attachments ?? [],
  });
  writeState(state, workspace.stateDir);
}

export async function waitForState(workspace, predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = readState(workspace.stateDir);
    if (predicate(state)) return state;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for fixture state condition: ${JSON.stringify(readState(workspace.stateDir), null, 2)}`);
}
