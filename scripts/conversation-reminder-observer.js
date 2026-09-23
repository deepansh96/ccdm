#!/usr/bin/env node
"use strict";

// This is a management-only Gateway client. It never dispatches coding input.
const { execFile } = require("node:child_process");
const { mkdir, readFile, rename, writeFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { promisify } = require("node:util");
const { Client, GatewayIntentBits, Partials } = require("discord.js");
const reminder = require("./conversation-reminder-adapter.js");

const exec = promisify(execFile);
const script = path.join(__dirname, "conversation-reminder-service.py");
const projectRoot = process.argv[process.argv.indexOf("--project-root") + 1] || path.resolve(__dirname, "..");
const stateDir = process.argv[process.argv.indexOf("--state-dir") + 1] || path.join(os.homedir(), ".local/state/ccdm/conversation-reminders");
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions, GatewayIntentBits.MessageContent],
  partials: [Partials.Message, Partials.Reaction, Partials.User],
});
let busy = false;
const healthPath = path.join(stateDir, "observer-health.json");
const health = {};
let healthWrite = Promise.resolve();

async function markHealth(project, state) {
  if (health[project] === state) return;
  health[project] = state;
  healthWrite = healthWrite.then(async () => {
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    const temporary = `${healthPath}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify({ schema_version: 1, channels: health }), { mode: 0o600 });
    await rename(temporary, healthPath);
  });
  await healthWrite;
}

async function registry() {
  return JSON.parse(await readFile(path.join(projectRoot, "registry.json"), "utf8"));
}

async function rootToken() {
  const directory = process.env.ROOT_DISCORD_STATE_DIR || path.join(os.homedir(), ".claude/channels/discord");
  const source = await readFile(path.join(directory, ".env"), "utf8");
  const line = source.split(/\r?\n/).find(value => value.startsWith("DISCORD_BOT_TOKEN="));
  const token = line?.slice("DISCORD_BOT_TOKEN=".length).trim().replace(/^(["'])(.*)\1$/, "$2");
  if (!token || /\s/.test(token)) throw new Error("root Discord credentials are unavailable");
  return token;
}

function closeCommand(content, botAppId, rootAppId) {
  const trimmed = String(content || "").trim();
  if (trimmed === "/close") return true;
  return [botAppId, rootAppId].filter(Boolean).some(id =>
    [`<@${id}>`, `<@!${id}>`].some(mention => trimmed.startsWith(mention) &&
      /^\s+\/close$/.test(trimmed.slice(mention.length))),
  );
}

async function assignment(channelId) {
  const found = await reminder.resolveAssignmentForChannel(channelId, {
    registryPath: path.join(projectRoot, "registry.json"),
  });
  if (!found || !found.owner_id || !found.bot_app_id) return null;
  const data = await registry();
  const bot = data.pool?.filter(row => row?.id === found.bot_id);
  if (bot?.length !== 1 || !bot[0].token || bot[0].assigned_to && bot[0].assigned_to !== found.project) {
    await markHealth(found.project, "blocked-assignment");
    return null;
  }
  const readiness = await exec(process.env.CCDM_REMINDER_PYTHON || "python3",
    [path.join(__dirname, "conversation-reminder-readiness.py"), found.project, "--json",
      "--project-root", projectRoot, "--state-dir", stateDir]).then(result => JSON.parse(result.stdout)).catch(() => null);
  if (!readiness?.ready) {
    await markHealth(found.project, "blocked-adapter-capability");
    return null;
  }
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel?.permissionsFor) {
    await markHealth(found.project, "blocked-observation-access");
    return null;
  }
  let botMember = found.bot_app_id;
  if (channel.guild?.members?.fetch) {
    botMember = await channel.guild.members.fetch(found.bot_app_id).catch(() => null);
    if (!botMember) {
      await markHealth(found.project, "blocked-assigned-bot-permissions");
      return null;
    }
  }
  const rootPermissions = channel.permissionsFor(client.user);
  const botPermissions = channel.permissionsFor(botMember);
  if (!rootPermissions || !["ViewChannel", "ReadMessageHistory"].every(flag => rootPermissions.has(flag))) {
    await markHealth(found.project, "blocked-observation-access");
    return null;
  }
  if (!botPermissions || !["ViewChannel", "ReadMessageHistory", "SendMessages", "AddReactions"].every(flag => botPermissions.has(flag))) {
    await markHealth(found.project, "blocked-assigned-bot-permissions");
    return null;
  }
  await markHealth(found.project, "ready-observe-only");
  return { ...found, bot_token: bot[0].token };
}

async function observeMessage(message) {
  if (message.author?.bot) return;
  const found = await assignment(message.channel?.id);
  if (!found) return;
  const close = closeCommand(message.content, found.bot_app_id, client.user.id);
  if (message.author.id !== found.owner_id) return;
  const context = { ...found, provider: "ccdm-root" };
  if (close) {
    await reminder.emitEvent("close_requested", context, {
      actor_id: message.author.id, source_message_id: message.id, command: "/close",
    });
    return;
  }
  const content = String(message.content || "").trim();
  const rootMention = [`<@${client.user.id}>`, `<@!${client.user.id}>`].some(value => content.startsWith(value));
  const managedCommand = ["/compact", "/clear", "/pause", "/unpause", "/restart"].includes(content);
  if (!content && !message.attachments?.size) return;
  const kind = managedCommand || rootMention ? "management-command"
    : message.attachments?.size ? "attachment" : "message";
  await reminder.emitEvent("owner_activity", context, {
    actor_id: message.author.id, source_message_id: message.id, activity_kind: kind,
  });
}

async function observeReaction(reaction, user) {
  if (user?.bot) return;
  const found = await assignment(reaction.message?.channel?.id || reaction.message?.channelId);
  if (!found || user.id !== found.owner_id) return;
  if (await reminder.isRecordedReminderMessage(reaction.message.id)) return;
  await reminder.emitEvent("owner_activity", { ...found, provider: "ccdm-root" }, {
    actor_id: user.id, source_message_id: reaction.message.id, activity_kind: "reaction",
  });
}

async function sideEffects() {
  if (busy) return;
  busy = true;
  try {
    const pending = await exec(process.env.CCDM_REMINDER_PYTHON || "python3",
      [script, "actions", "--project-root", projectRoot, "--state-dir", stateDir]);
    for (const action of JSON.parse(pending.stdout).actions) {
      const found = await assignment(action.channel_id);
      if (!found || found.project !== action.project ||
          found.assignment_generation !== action.assignment_generation) continue;
      const messageUrl = `https://discord.com/api/v10/channels/${encodeURIComponent(action.channel_id)}` +
        `/messages/${encodeURIComponent(action.message_id)}`;
      const url = action.kind === "ack" ?
        `${messageUrl}/reactions/${encodeURIComponent("✅")}/@me` : messageUrl;
      const response = await fetch(url, {
        method: action.kind === "ack" ? "PUT" : "DELETE",
        headers: { Authorization: `Bot ${found.bot_token}` },
      });
      if (!response.ok && !(action.kind === "delete" && response.status === 404)) continue;
      await exec(process.env.CCDM_REMINDER_PYTHON || "python3",
        [script, "done", "--state-dir", stateDir, "--action-id", action.action_id]);
    }
  } catch (error) {
    process.stderr.write(`Conversation observer side effect pending: ${error.message}\n`);
  } finally {
    busy = false;
  }
}

client.on("messageCreate", message => observeMessage(message).catch(error =>
  process.stderr.write(`Conversation observer message failed: ${error.message}\n`)));
client.on("messageReactionAdd", (reaction, user) => observeReaction(reaction, user).catch(error =>
  process.stderr.write(`Conversation observer reaction failed: ${error.message}\n`)));
client.on("ready", async () => {
  const data = await registry();
  for (const [name, project] of Object.entries(data.projects || {})) {
    if (!project?.channel_id || !(await assignment(project.channel_id))) {
      if (!health[name]) await markHealth(name, "blocked-assignment");
    }
  }
  setInterval(sideEffects, 250);
});
process.on("SIGTERM", () => { client.destroy(); process.exit(0); });
process.on("SIGINT", () => { client.destroy(); process.exit(0); });
rootToken().then(token => client.login(token)).catch(error => {
  process.stderr.write(`Conversation observer unavailable: ${error.message}\n`);
  process.exit(2);
});
