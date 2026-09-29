#!/usr/bin/env node
"use strict";

// CCDM Router: holds the root bot token, routes each router-transport project
// channel to its one session, and acts in Discord on the session's behalf.
//
//   scripts/router.js serve                   run the Router daemon
//   scripts/router.js status                  report Router health (non-zero if unreachable)
//   scripts/router.js ensure-webhook <project>  find or create the project's webhook
const { Client, GatewayIntentBits, Partials } = require("discord.js");
const { RouterClient } = require("./router/client.js");
const { discordRequest } = require("./router/discord-rest.js");
const { classifyMessage, classifyReaction } = require("./router/inbound.js");
const { registryPath, rootToken, socketPath, stateDir } = require("./router/paths.js");
const { loadRoutingTable } = require("./router/registry.js");
const { createRouterServer } = require("./router/server.js");
const { ensureWebhook } = require("./router/webhooks.js");

const OFFLINE_EMOJI = "💤";

function log(line) {
  console.log(`[router] ${line}`);
}

async function serve() {
  const token = await rootToken();
  const table = await loadRoutingTable(registryPath());
  const gateway = { state: "connecting" };
  const server = createRouterServer({
    stateDir: stateDir(), socketPath: socketPath(), getTable: () => table, gateway,
    context: { stateDir: stateDir(), token }, log,
  });
  await server.listen();

  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildMessageReactions, GatewayIntentBits.MessageContent],
    partials: [Partials.Message, Partials.Reaction, Partials.User],
  });
  const ready = new Promise(resolve => client.once("ready", resolve));

  client.on("messageCreate", async message => {
    try {
      const routed = classifyMessage(table, message);
      if (!routed || server.deliver(routed.route.project, routed.event)) return;
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
    server.close();
    client.destroy();
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);

  await client.login(token);
  await ready;
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

async function ensureWebhookCommand(project) {
  if (!project) throw new Error("usage: router.js ensure-webhook <project>");
  const result = await ensureWebhook({ project, registryFile: registryPath(), stateDir: stateDir(), token: await rootToken() });
  console.log(`${result.created ? "created" : "reused"} webhook ${result.name} id=${result.webhook_id}`);
}

const [command = "serve", ...args] = process.argv.slice(2);
const commands = { serve, status, "ensure-webhook": () => ensureWebhookCommand(args[0]) };

if (!Object.hasOwn(commands, command)) {
  console.error(`unknown command: ${command}\nusage: router.js serve | status | ensure-webhook <project>`);
  process.exit(2);
}
commands[command]().catch(error => {
  console.error(`router ${command} failed: ${error.message}`);
  process.exit(1);
});
