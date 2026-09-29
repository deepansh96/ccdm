import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";

import { bridgeChildEnv, collectProcess, createBridgeWorkspace } from "./bridge.js";
import { runNodeEntrypoint } from "./runner.js";
import { seedRegistry } from "./state.js";
import { registerTeardownCallback } from "./teardown.js";

export const OWNER_ID = "owner-id";
export const ROOT_TOKEN = "root-bot-token";

// A router-transport Claude project, a router-transport Codex project, and a
// pool project whose bot still serves its own channel.
export function routerRegistry(overrides = {}) {
  return {
    discord_user_id: OWNER_ID,
    guild_id: "guild-id",
    pool: [{ id: "bot2", token: "pool-bot-token", app_id: "pool-app-id" }],
    projects: {
      demo: { channel_id: "demo-channel", type: "claude", transport: "router", guest_user_ids: ["guest-id"] },
      beta: { channel_id: "beta-channel", type: "codex", transport: "router" },
      legacy: { channel_id: "legacy-channel", type: "claude", bot_id: "bot2" },
      ...overrides,
    },
  };
}

// The Router's private state lives inside the Test Workspace; a short path
// keeps the socket under the platform's Unix-socket length limit.
export function createRouterWorkspace(registry = routerRegistry()) {
  const workspace = createBridgeWorkspace();
  const routerStateDir = path.join(workspace.tmpRoot, "router");
  const rootStateDir = path.join(workspace.homeDir, ".claude/channels/discord");
  fs.mkdirSync(rootStateDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(rootStateDir, ".env"), `DISCORD_BOT_TOKEN=${ROOT_TOKEN}\n`, { mode: 0o600 });
  seedRegistry(workspace, registry);
  return Object.freeze({ ...workspace, routerStateDir, socketPath: path.join(routerStateDir, "router.sock") });
}

export function routerEnv(workspace, extraEnv = {}) {
  return bridgeChildEnv(workspace, { CCDM_ROUTER_STATE_DIR: workspace.routerStateDir, ...extraEnv });
}

// A launcher writes the per-project key before starting a session.
export function writeProjectKey(workspace, project, key) {
  const keysDir = path.join(workspace.routerStateDir, "keys");
  fs.mkdirSync(keysDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(keysDir, `${project}.key`), `${key}\n`, { mode: 0o600 });
}

export function runRouterCli(workspace, args, options = {}) {
  return runNodeEntrypoint(workspace, "scripts/router.js", { args, env: routerEnv(workspace), ...options });
}

// `env` adds to the Router's environment (rate-limit bounds).
export async function startRouter(workspace, { env: extraEnv = {} } = {}) {
  const env = routerEnv(workspace, extraEnv);
  const command = [process.execPath, path.join(workspace.repoDir, "scripts/router.js"), "serve"];
  const child = spawn(command[0], command.slice(1), {
    cwd: workspace.repoDir,
    detached: true,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const running = collectProcess(child, { command, cwd: workspace.repoDir, detached: true, env }, workspace);
  registerTeardownCallback(() => running.stop());
  await running.waitForOutput(/router ready/);
  return running;
}

// Each project gets its webhook and key, then the Router starts.
export async function routerWithWebhooks(workspace, projects, options = {}) {
  for (const project of projects) {
    const result = await runRouterCli(workspace, ["ensure-webhook", project]);
    if (result.exitCode !== 0) throw new Error(`ensure-webhook ${project} failed: ${result.stderr || result.stdout}`);
    writeProjectKey(workspace, project, `${project}-key`);
  }
  return startRouter(workspace, options);
}

// A scripted session: the shared client library, loaded from the Test Workspace.
// `env` stands in for the session process environment (reconnect backoff bounds).
export async function connectSession(workspace, project, key, { env = {} } = {}) {
  const { RouterClient } = createRequire(import.meta.url)(path.join(workspace.repoDir, "scripts/router/client.js"));
  const client = new RouterClient({ socketPath: workspace.socketPath, project, key, role: "project", env });
  const events = [];
  client.on("event", (event) => events.push(event));
  const scope = await client.connect();
  registerTeardownCallback(() => client.close());
  return { client, events, scope };
}

// A raw socket for adversarial frames a well-behaved client can't produce.
// `send` takes a frame object or a literal line; `frames` collects every
// parsed frame the Router sends back; `closed` resolves when the Router hangs up.
export async function rawRouterSocket(workspace) {
  const socket = net.connect(workspace.socketPath);
  registerTeardownCallback(() => socket.destroy());
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  const frames = [];
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.trim()) frames.push(JSON.parse(line));
    }
  });
  const closed = new Promise((resolve) => socket.once("close", resolve));
  return {
    frames,
    closed,
    send(frame) {
      socket.write(typeof frame === "string" ? frame : `${JSON.stringify(frame)}\n`);
    },
  };
}

export async function waitFor(predicate, describe, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${describe()}`);
}

// Fetches a URL the way a session process would, through the fake CDN.
export function fetchThroughFakeCdn(workspace, url) {
  const script = `fetch(${JSON.stringify(url)}).then(async r => process.stdout.write(JSON.stringify({ status: r.status, body: await r.text() })))`;
  const output = execFileSync(process.execPath, ["-e", script], { cwd: workspace.repoDir, env: routerEnv(workspace), encoding: "utf8" });
  return JSON.parse(output);
}
