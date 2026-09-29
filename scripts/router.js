#!/usr/bin/env node
"use strict";

// CCDM Router: holds the root bot token, routes each router-transport project
// channel to its one session, and acts in Discord on the session's behalf.
//
//   scripts/router.js serve                   run the Router daemon
//   scripts/router.js status                  report Router health (non-zero if unreachable)
//   scripts/router.js preflight               read-only supervision readiness as JSON (non-zero on blockers)
//   scripts/router.js ensure-webhook <project>  find or create the project's webhook
//   scripts/router.js migrate-root-config     copy root channels and users from root access.json
const path = require("node:path");
const { Client, GatewayIntentBits, Partials } = require("discord.js");
const { createAttachmentCache } = require("./router/attachments.js");
const { RouterClient } = require("./router/client.js");
const { discordRequest } = require("./router/discord-rest.js");
const { acquireRouterLock } = require("./router/lock.js");
const { classifyMessage, classifyReaction } = require("./router/inbound.js");
const { preflight } = require("./router/preflight.js");
const { registryPath, rootStateDir, rootToken, socketPath, stateDir } = require("./router/paths.js");
const { DEFAULT_RELOAD_DEBOUNCE_MS, loadRoutingTable, watchRegistry } = require("./router/registry.js");
const { migrateRootConfig } = require("./router/root-config.js");
const { createRouterServer } = require("./router/server.js");
const { ensureWebhook } = require("./router/webhooks.js");

const OFFLINE_EMOJI = "💤";

function log(line) {
  console.log(`[router] ${line}`);
}

async function serve() {
  // Taken before anything else, so a refused start leaves the running Router's
  // socket and state untouched.
  acquireRouterLock(stateDir());
  const token = await rootToken();
  let table = await loadRoutingTable(registryPath());
  const gateway = { state: "connecting" };
  // The last failed reload, shown by `router status` until a good one lands.
  const registry = { error: null };
  const attachments = createAttachmentCache();
  // The root bot's own user, known once the gateway is ready.
  const bot = { id: null };
  const server = createRouterServer({
    stateDir: stateDir(), socketPath: socketPath(), getTable: () => table, gateway, registry,
    context: { stateDir: stateDir(), token, attachments, bot }, log,
  });
  await server.listen();
  const registryWatcher = watchRegistry(registryPath(), {
    debounceMs: Number(process.env.CCDM_ROUTER_REGISTRY_DEBOUNCE_MS) || DEFAULT_RELOAD_DEBOUNCE_MS,
    onLoad(next) {
      table = next;
      registry.error = null;
      server.refreshRoutes();
      log(`registry reloaded: ${table.projects.size} router project(s)`);
    },
    onError(error) {
      registry.error = { message: error.message, at: new Date().toISOString() };
      log(`registry_reload_failed error=${error.message}`);
    },
  });

  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildMessageReactions, GatewayIntentBits.MessageContent],
    partials: [Partials.Message, Partials.Reaction, Partials.User],
  });
  const ready = new Promise(resolve => client.once("ready", resolve));

  client.on("messageCreate", async message => {
    try {
      const routed = classifyMessage(table, message);
      if (!routed) return;
      attachments.remember(routed.event);
      if (routed.root ? server.deliverRoot(routed.event) : server.deliver(routed.route.project, routed.event)) return;
      // No live session: mark the message and drop it. Nothing is replayed later.
      await discordRequest("PUT",
        `/channels/${routed.route.channel_id}/messages/${message.id}/reactions/${encodeURIComponent(OFFLINE_EMOJI)}/@me`,
        { token });
    } catch (error) {
      log(`message_failed id=${message.id} error=${error.message}`);
    }
  });
  client.on("messageReactionAdd", async (reaction, user) => {
    try {
      const routed = await classifyReaction(table, reaction, user);
      if (routed) server.deliver(routed.route.project, routed.event);
    } catch (error) {
      log(`reaction_failed error=${error.message}`);
    }
  });

  const stop = () => {
    registryWatcher.close();
    server.close();
    client.destroy();
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);

  await client.login(token);
  await ready;
  bot.id = client.user.id;
  gateway.state = "ready";
  log(`router ready: ${table.projects.size} router project(s), socket ${socketPath()}`);
}

async function status() {
  const client = new RouterClient({ role: "status", timeoutMs: 5000 });
  let result;
  try {
    await client.connect();
    result = await client.request("status");
  } catch (error) {
    console.error(`router unreachable at ${socketPath()}: ${error.message}`);
    process.exitCode = 1;
    return;
  } finally {
    client.close();
  }
  console.log(`gateway: ${result.gateway}`);
  console.log(`registry loaded: ${result.registry_loaded_at}`);
  if (result.registry_error) console.log(`registry error: ${result.registry_error.at} ${result.registry_error.message}`);
  console.log(`sessions: ${result.sessions.length}`);
  for (const session of result.sessions) {
    console.log(`  ${session.role} ${session.project} scope=${session.scope.channel_id} connected=${session.connected_at}`);
  }
  console.log("webhooks:");
  for (const project of result.projects) {
    console.log(`  ${project.project} channel=${project.channel_id} webhook=${project.webhook ? "present" : "missing"}`);
  }
  console.log(`scope violations: ${result.scope_violations.length}`);
  for (const violation of result.scope_violations) {
    console.log(`  ${violation.at} project=${violation.project} op=${violation.op} target=${violation.target}`);
  }
}

async function preflightCommand() {
  const result = await preflight();
  console.log(JSON.stringify(result));
  if (!result.ready) process.exitCode = 1;
}

async function ensureWebhookCommand(project) {
  if (!project) throw new Error("usage: router.js ensure-webhook <project>");
  const result = await ensureWebhook({ project, registryFile: registryPath(), stateDir: stateDir(), token: await rootToken() });
  console.log(`${result.created ? "created" : "reused"} webhook ${result.name} id=${result.webhook_id}`);
}

async function migrateRootConfigCommand() {
  const moved = await migrateRootConfig({ accessFile: path.join(rootStateDir(), "access.json"), registryFile: registryPath() });
  const fields = Object.entries(moved);
  if (fields.length === 0) return console.log("root config already in the registry: nothing to migrate");
  for (const [field, values] of fields) console.log(`migrated ${field}: ${values.join(", ") || "(none)"}`);
}

const [command = "serve", ...args] = process.argv.slice(2);
const commands = {
  serve, status, preflight: preflightCommand,
  "ensure-webhook": () => ensureWebhookCommand(args[0]), "migrate-root-config": migrateRootConfigCommand,
};

if (!Object.hasOwn(commands, command)) {
  console.error(`unknown command: ${command}\nusage: router.js serve | status | preflight | ensure-webhook <project> | migrate-root-config`);
  process.exit(2);
}
commands[command]().catch(error => {
  console.error(`router ${command} failed: ${error.message}`);
  process.exit(1);
});
