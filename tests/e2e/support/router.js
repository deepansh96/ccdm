import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
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

// Root's Discord state holds the only bot token, which the Router reads.
export function writeRootToken(workspace) {
  const rootStateDir = path.join(workspace.homeDir, ".claude/channels/discord");
  fs.mkdirSync(rootStateDir, { recursive: true, mode: 0o700 });
  const envFile = path.join(rootStateDir, ".env");
  if (!fs.existsSync(envFile)) fs.writeFileSync(envFile, `DISCORD_BOT_TOKEN=${ROOT_TOKEN}\n`, { mode: 0o600 });
}

export function createRouterWorkspace(registry = routerRegistry()) {
  const workspace = createBridgeWorkspace();
  writeRootToken(workspace);
  seedRegistry(workspace, registry);
  return workspace;
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

// Root's key lives beside the project keys under a name no project can take.
export function writeRootKey(workspace, key) {
  const keysDir = path.join(workspace.routerStateDir, "keys");
  fs.mkdirSync(keysDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(keysDir, ".root.key"), `${key}\n`, { mode: 0o600 });
}

// A scripted root session: the shared client library in `role: "root"`.
export async function connectRoot(workspace, key) {
  const { RouterClient } = createRequire(import.meta.url)(path.join(workspace.repoDir, "scripts/router/client.js"));
  const client = new RouterClient({ socketPath: workspace.socketPath, key, role: "root" });
  const events = [];
  client.on("event", (event) => events.push(event));
  const scope = await client.connect();
  registerTeardownCallback(() => client.close());
  return { client, events, scope };
}

const bridgeRouters = new WeakMap();

function readWorkspaceRegistry(workspace) {
  const file = path.join(workspace.repoDir, "registry.json");
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
}

// Every Codex bridge is a Router client. `startBridge` serves `project`
// (default `alpha`, a Codex project in `channelId`) through a Router it starts
// once per Test Workspace: it registers the project (keeping any entry the
// test seeded), ensures its webhook, and writes a fresh launch key, as
// start-codex-session.sh does. The first allowed user is the owner and the
// rest are the project's guests. `root: true` starts root's bridge instead,
// with `channelId` among the registry's root channels. Returns the running
// bridge; `bridge.router` is the running Router.
export async function startBridge(workspace, options = {}) {
  const project = options.project ?? "alpha";
  const channelId = options.channelId ?? "channel-id";
  const allowed = options.allowedUserIds ?? [options.allowedUserId ?? "allowed-user-id"];
  const [owner, ...guests] = allowed;
  const registry = readWorkspaceRegistry(workspace);
  registry.discord_user_id ??= owner;
  registry.guild_id ??= options.guildId ?? "guild-id";
  registry.projects ??= {};
  if (options.root) {
    registry.root_channels = [...new Set([...(registry.root_channels ?? []), channelId])];
    if (options.rootBotAppId) registry.root_bot_app_id ??= options.rootBotAppId;
  } else {
    registry.projects[project] = {
      type: "codex",
      channel_id: channelId,
      path: options.projectDir ?? workspace.repoDir,
      screen_name: `${project}_codex`,
      ...(guests.length ? { guest_user_ids: guests } : {}),
      ...(registry.projects[project] ?? {}),
    };
  }
  seedRegistry(workspace, registry);
  writeRootToken(workspace);

  if (!options.root && !registry.projects[project].webhook_id) {
    const result = await runRouterCli(workspace, ["ensure-webhook", project]);
    if (result.exitCode !== 0) throw new Error(`ensure-webhook ${project} failed: ${result.stderr || result.stdout}`);
  }
  const key = randomBytes(16).toString("hex");
  if (options.root) writeRootKey(workspace, key);
  else writeProjectKey(workspace, project, key);
  if (!bridgeRouters.has(workspace)) bridgeRouters.set(workspace, startRouter(workspace, { env: options.routerEnv }));
  const router = await bridgeRouters.get(workspace);

  const keyFile = path.join(workspace.routerStateDir, "keys", options.root ? ".root.key" : `${project}.key`);
  const env = routerEnv(workspace, {
    ALLOWED_USER_IDS: allowed.join(","),
    CCDM_ROUTER_KEY_FILE: keyFile,
    ...(options.root ? { CCDM_ROUTER_ROLE: "root" } : { CCDM_CODEX_PROJECT: project }),
    CHANNEL_ID: channelId,
    PROJECT_DIR: options.projectDir ?? workspace.repoDir,
    ...(options.botAppId ? { BOT_APP_ID: options.botAppId } : {}),
    ROOT_BOT_APP_ID: options.rootBotAppId ?? "root-bot-app-id",
    WS_PORT: String(options.port),
    ...(options.env ?? {}),
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
  running.router = router;
  return running;
}
