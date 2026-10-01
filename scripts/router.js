#!/usr/bin/env node
"use strict";

// CCDM Router: holds the root bot token, routes each router-transport project
// channel to its one session, and acts in Discord on the session's behalf.
//
//   scripts/router.js serve                   run the Router daemon
//   scripts/router.js status [--json]         report Router health (non-zero if unreachable)
//   scripts/router.js preflight               read-only supervision readiness as JSON (non-zero on blockers)
//   scripts/router.js ensure-webhook <project>  find or create the project's webhook
//   scripts/router.js delete-webhook <project>  delete the project's webhook and its token
//   scripts/router.js probe <project>         post a connection notice through the project's webhook
//   scripts/router.js migrate-root-config     copy root channels and users from root access.json
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Client, GatewayIntentBits, Partials } = require("discord.js");
const { createAttachmentCache } = require("./router/attachments.js");
const { RouterClient } = require("./router/client.js");
const { discordRequest } = require("./router/discord-rest.js");
const { acquireRouterLock } = require("./router/lock.js");
const { classifyMessage, classifyReaction, observedMessage, supervisedMessage, threadRoute } = require("./router/inbound.js");
const { preflight } = require("./router/preflight.js");
const { probe } = require("./router/probe.js");
const { registryPath, rootStateDir, rootToken, socketPath, stateDir } = require("./router/paths.js");
const { DEFAULT_RELOAD_DEBOUNCE_MS, loadRoutingTable, watchRegistry } = require("./router/registry.js");
const { assignmentChanged } = require("./router/reminders.js");
const { migrateRootConfig } = require("./router/root-config.js");
const { createRouterServer } = require("./router/server.js");
const { deleteWebhook, ensureWebhook } = require("./router/webhooks.js");

const OFFLINE_EMOJI = "💤";
// Thread bits granted at the guild rather than in a project channel.
const GUILD_THREAD_PERMISSIONS = ["ViewAuditLog"];
const THREAD_SUPERVISOR_PLIST = path.join("Library", "LaunchAgents", "com.ccdm.thread-supervisor.plist");

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
  // The gateway client, for `status` to check root's channel permissions.
  const discord = { client: null };
  const server = createRouterServer({
    stateDir: stateDir(), socketPath: socketPath(), getTable: () => table, gateway, registry,
    context: {
      stateDir: stateDir(), registryFile: registryPath(), token, attachments, bot, discord, log,
      // A failed reminder update is logged; the reply it heals still goes out.
      assignmentChanged: project => assignmentChanged(project, { registryFile: registryPath() })
        .then(() => log(`assignment_changed project=${project}`), error => log(`assignment_changed_failed ${error.message}`)),
    },
    log,
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
  discord.client = client;

  const markOffline = (channelId, messageId) => discordRequest("PUT",
    `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(OFFLINE_EMOJI)}/@me`, { token });

  // A thread message: owner and guest messages reach the live thread session,
  // or else the supervisor, or else get 💤. The supervisor also gets a copy of
  // every message, in the same turn as the session delivery.
  async function routeThreadMessage(message, thread) {
    const routed = classifyMessage(table, message, thread);
    if (routed) attachments.remember(routed.event);
    const delivered = Boolean(routed?.thread) && server.deliverThread(thread.thread_id, routed.event);
    const supervised = server.deliverSupervisor(supervisedMessage(table, message, thread, delivered));
    if (!routed || delivered) return;
    if (routed.root) {
      if (!server.deliverRoot(routed.event)) await markOffline(thread.thread_id, message.id);
      return;
    }
    const command = routed.supervisor ? routed.event : routed.fallback;
    if (command) server.deliverSupervisor(command);
    if (!supervised) await markOffline(thread.thread_id, message.id);
  }

  client.on("messageCreate", async message => {
    // System notices are not conversation activity, including for observers.
    if (message.type !== 0 && message.type !== 19) return;
    try {
      const thread = await threadRoute(table, String(message.channelId ?? message.channel?.id), message.channel, client);
      const observed = observedMessage(table, message, thread);
      if (observed) server.deliverObserver(observed);
      if (thread) return await routeThreadMessage(message, thread);
      const routed = classifyMessage(table, message, thread);
      if (!routed) return;
      attachments.remember(routed.event);
      if (routed.supervisor) {
        if (!server.deliverSupervisor(routed.event)) await markOffline(routed.route.channel_id, message.id);
        return;
      }
      if (routed.root ? server.deliverRoot(routed.event) : server.deliver(routed.route.project, routed.event)) return;
      // A project without `webhook_id` is not migrated yet and may still be
      // served by its old pool bot, so its message is dropped without a mark.
      if (!routed.root && !routed.route.webhook_id) return;
      // No live session: mark the message and drop it. Nothing is replayed later.
      await markOffline(routed.route.channel_id, message.id);
    } catch (error) {
      log(`message_failed id=${message.id} error=${error.message}`);
    }
  });
  client.on("messageReactionAdd", async (reaction, user) => {
    try {
      const channelId = String(reaction.message.channelId ?? reaction.message.channel?.id);
      const thread = await threadRoute(table, channelId, reaction.message.channel, client);
      const routed = await classifyReaction(table, reaction, user, client.user?.id, thread);
      if (!routed) return;
      if (routed.thread) {
        // Thread reactions also reach the supervisor (the `/config` ✅) and the observer.
        const { project, thread_id: threadId } = routed.route;
        server.deliverThread(threadId, routed.event);
        server.deliverSupervisor({ ...routed.event, event: "thread_reaction", project, thread_id: threadId });
        return void server.deliverObserver({ ...routed.event, project, conversation_id: threadId, thread_id: threadId });
      }
      // Root-channel reactions are root's alone: no project or observer sees them.
      if (routed.root) return void server.deliverRoot(routed.event);
      server.deliver(routed.route.project, routed.event);
      server.deliverObserver({ ...routed.event, project: routed.route.project });
    } catch (error) {
      log(`reaction_failed error=${error.message}`);
    }
  });

  // Thread lifecycle, for eligible threads only, is the supervisor's. A
  // repeated THREAD_CREATE (after a bot unarchive) is passed on as it comes.
  const threadEvent = async (event, thread, fields = () => ({})) => {
    try {
      const route = await threadRoute(table, String(thread.id), thread, client);
      if (!route) return;
      server.deliverSupervisor({ event, project: route.project, thread_id: route.thread_id,
        parent_channel_id: route.parent_channel_id, ...fields() });
    } catch (error) {
      log(`thread_event_failed event=${event} id=${thread.id} error=${error.message}`);
    }
  };
  const archiveFields = thread => ({ archived: Boolean(thread.archived), auto_archive_duration: thread.autoArchiveDuration ?? null });
  client.on("threadCreate", (thread, newlyCreated) => threadEvent("thread_create", thread, () => ({
    name: thread.name, owner_id: thread.ownerId ? String(thread.ownerId) : null, newly_created: Boolean(newlyCreated),
  })));
  client.on("threadUpdate", (before, after) => threadEvent("thread_update", after, () => ({
    before: archiveFields(before), after: archiveFields(after),
  })));
  client.on("threadDelete", thread => threadEvent("thread_delete", thread));
  // A resumed or re-established Gateway may have missed events; the first
  // shardReady is the initial connection, before the client is ready.
  client.on("shardResume", () => server.deliverSupervisor({ event: "gateway_resumed" }));
  client.on("shardReady", () => {
    if (gateway.state === "ready") server.deliverSupervisor({ event: "gateway_resumed" });
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

async function status(json = false) {
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
  result.threads_enabled = threadsEnabled(result);
  if (!result.threads_enabled) {
    for (const project of result.projects) delete project.missing_thread_permissions;
  }
  if (json) return console.log(JSON.stringify(result));
  console.log(`gateway: ${result.gateway}`);
  console.log(`registry loaded: ${result.registry_loaded_at}`);
  if (result.registry_error) console.log(`registry error: ${result.registry_error.at} ${result.registry_error.message}`);
  console.log(`sessions: ${result.sessions.length}`);
  for (const session of result.sessions) {
    const where = session.role === "thread" ? `thread=${session.thread_id} provider=${session.provider}`
      : `scope=${session.scope.channel_id}`;
    console.log(`  ${session.role} ${session.project} ${where} connected=${session.connected_at}`);
  }
  console.log(result.supervisor?.connected ? `supervisor: connected connected=${result.supervisor.connected_at}`
    : "supervisor: absent");
  console.log("webhooks:");
  for (const project of result.projects) {
    const missing = project.missing_permissions;
    const access = missing === null ? "unknown" : missing.length ? `missing ${missing.join(",")}` : "ok";
    const threads = result.threads_enabled ? ` thread_permissions=${permissionState(project.missing_thread_permissions,
      flag => !GUILD_THREAD_PERMISSIONS.includes(flag))}` : "";
    console.log(`  ${project.project} channel=${project.channel_id} webhook=${project.webhook ? "present" : "missing"} root_permissions=${access}${threads}`);
  }
  if (result.threads_enabled) {
    // Guild permissions read the same through every channel; any channel's answer is the guild's.
    const known = result.projects.find(project => project.missing_thread_permissions);
    const guild = known ? permissionState(known.missing_thread_permissions, flag => GUILD_THREAD_PERMISSIONS.includes(flag))
      : "unknown";
    console.log(`guild permissions: ${guild}`);
  }
  console.log(`scope violations: ${result.scope_violations.length}`);
  for (const violation of result.scope_violations) {
    console.log(`  ${violation.at} project=${violation.project} op=${violation.op} target=${violation.target}`);
  }
}

// Thread Conversations are enabled once the supervisor is installed, configured, or connected.
function threadsEnabled(result) {
  if (result.supervisor?.connected || fs.existsSync(path.join(os.homedir(), THREAD_SUPERVISOR_PLIST))) return true;
  try {
    return Object.hasOwn(JSON.parse(fs.readFileSync(registryPath(), "utf8")), "thread_session_caps");
  } catch {
    return false;
  }
}

// `ok`, `missing <flags>`, or `unknown` before the gateway can check, for the flags `pick` keeps.
function permissionState(missing, pick) {
  if (!missing) return "unknown";
  const flags = missing.filter(pick);
  return flags.length ? `missing ${flags.join(",")}` : "ok";
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

async function deleteWebhookCommand(project) {
  if (!project) throw new Error("usage: router.js delete-webhook <project>");
  const result = await deleteWebhook({ project, registryFile: registryPath(), stateDir: stateDir(), token: await rootToken() });
  if (result.deleted.length === 0) return console.log(`no webhook ${result.name} to delete`);
  console.log(`deleted webhook ${result.name} id=${result.deleted.join(",")}`);
}

async function probeCommand(project) {
  if (!project) throw new Error("usage: router.js probe <project>");
  const result = await probe({ project, registryFile: registryPath(), stateDir: stateDir(), token: await rootToken() });
  console.log(`probe message ${result.message_id} webhook_id=${result.webhook_id}`);
}

async function migrateRootConfigCommand() {
  const moved = await migrateRootConfig({ accessFile: path.join(rootStateDir(), "access.json"), registryFile: registryPath() });
  const fields = Object.entries(moved);
  if (fields.length === 0) return console.log("root config already in the registry: nothing to migrate");
  for (const [field, values] of fields) console.log(`migrated ${field}: ${values.join(", ") || "(none)"}`);
}

const [command = "serve", ...args] = process.argv.slice(2);
const commands = {
  serve, status: () => status(args.includes("--json")), preflight: preflightCommand,
  "ensure-webhook": () => ensureWebhookCommand(args[0]), "delete-webhook": () => deleteWebhookCommand(args[0]),
  probe: () => probeCommand(args[0]),
  "migrate-root-config": migrateRootConfigCommand,
};

if (!Object.hasOwn(commands, command)) {
  console.error(`unknown command: ${command}\nusage: router.js serve | status [--json] | preflight | ensure-webhook <project> | delete-webhook <project> | probe <project> | migrate-root-config`);
  process.exit(2);
}
commands[command]().catch(error => {
  console.error(`router ${command} failed: ${error.message}`);
  process.exit(1);
});
