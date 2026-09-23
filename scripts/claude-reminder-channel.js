#!/usr/bin/env node
"use strict";

// Launch-scoped MCP transport filter. The official Discord channel remains the
// only Gateway client; this process relays its stdio protocol to Claude Code.
const { spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { createInterface } = require("node:readline");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const reminder = require("./conversation-reminder-adapter.js");

const projectRoot = process.env.CCDM_REMINDER_PROJECT_ROOT || path.resolve(__dirname, "..");
const selectedProject = process.env.CCDM_CLAUDE_PROJECT || "";
const selectedChannel = process.env.CCDM_CLAUDE_CHANNEL_ID || "";
const selectedAppId = process.env.CCDM_CLAUDE_BOT_APP_ID || "";
const rootAppId = process.env.CCDM_CLAUDE_ROOT_APP_ID || "";
const assignmentFields = [selectedProject, selectedChannel, selectedAppId];
if (assignmentFields.some(Boolean) && !assignmentFields.every(Boolean)) {
  process.stderr.write("Claude reminder channel: incomplete Claude project assignment\n");
  process.exit(2);
}
const stateDir = process.env.CCDM_REMINDER_STATE_DIR || path.join(os.homedir(), ".local", "state", "ccdm", "conversation-reminders");
const launchId = process.env.CCDM_CLAUDE_LAUNCH_ID || randomUUID();
const interactions = new Map();
const pendingReplies = new Map();
let inputNeededMarker = null;
let supportedServerVersion = null;

async function hasCommandHooks() {
  const file = process.env.CCDM_CLAUDE_HOOK_SETTINGS;
  if (!file) return false;
  try {
    if ((await fs.stat(file)).mode & 0o077) return false;
    const settings = JSON.parse(await fs.readFile(file, "utf8"));
    if (settings.enabledPlugins?.["discord@claude-plugins-official"] !== false) return false;
    const expected = `node '${path.join(projectRoot, "scripts", "claude-reminder-hook.js")}'`;
    return ["SessionStart", "Stop", "StopFailure", "SessionEnd"].every(event =>
      settings.hooks?.[event]?.some(group => group.hooks?.some(hook =>
        hook.type === "command" && hook.command === expected,
      )),
    );
  } catch { return false; }
}
const command = process.env.CCDM_CLAUDE_PLUGIN_COMMAND || "bun";
const args = process.env.CCDM_CLAUDE_PLUGIN_ARGS
  ? JSON.parse(process.env.CCDM_CLAUDE_PLUGIN_ARGS)
  : [path.join(process.env.CCDM_CLAUDE_PLUGIN_ROOT || "", "server.ts")];
if (!Array.isArray(args) || args.some(arg => typeof arg !== "string") || args.some(arg => !arg)) {
  process.stderr.write("Claude reminder channel: invalid official plugin launch arguments\n");
  process.exit(2);
}
if (!process.env.CCDM_CLAUDE_PLUGIN_ARGS && !process.env.CCDM_CLAUDE_PLUGIN_ROOT) {
  process.stderr.write("Claude reminder channel: official plugin path is missing\n");
  process.exit(2);
}

const plugin = spawn(command, args, {
  stdio: ["pipe", "pipe", "inherit"],
  env: process.env,
  cwd: process.env.CCDM_CLAUDE_PLUGIN_ROOT || undefined,
});
plugin.on("error", error => {
  process.stderr.write(`Claude reminder channel: official plugin unavailable: ${error.message}\n`);
  process.exitCode = 2;
});
plugin.on("exit", async code => {
  await pluginQueue.catch(() => {});
  process.exit(code || process.exitCode || 0);
});
process.on("SIGTERM", () => plugin.kill("SIGTERM"));
process.on("SIGINT", () => plugin.kill("SIGINT"));

function isClose(text) {
  const trimmed = String(text || "").trim();
  if (trimmed === "/close") return true;
  for (const appId of [selectedAppId, rootAppId]) {
    if (!appId) continue;
    for (const mention of [`<@${appId}>`, `<@!${appId}>`]) {
      if (trimmed.startsWith(mention) && /^\s+\/close$/.test(trimmed.slice(mention.length))) return true;
    }
  }
  return false;
}

async function handlePluginMessage(line) {
  let message;
  try { message = JSON.parse(line); } catch { process.stdout.write(`${line}\n`); return; }
  if (message.id !== undefined && pendingReplies.has(message.id)) {
    const pending = pendingReplies.get(message.id);
    pendingReplies.delete(message.id);
    if (!message.error && !message.result?.isError) {
      const resultText = message.result?.content?.find(item => item.type === "text")?.text || "";
      const single = /^sent \(id: ([^)]+)\)$/.exec(resultText);
      const multiple = /^sent \d+ parts \(ids: ([^)]+)\)$/.exec(resultText);
      const ids = single ? [single[1]] : multiple ? multiple[1].split(", ") : [];
      for (const id of ids) {
        const disposition = pending.disposition === "input-needed" && id === ids.at(-1) ? "input-needed" : "progress";
        const marker = await reminder.recordDeliveredReply(pending.context, id, disposition).catch(error => {
          process.stderr.write(`Claude reminder channel: receipt recording failed: ${error.message}\n`);
        });
        if (marker && disposition === "input-needed") inputNeededMarker = { marker, context: pending.context };
      }
    }
  }
  if (message.result?.tools) {
    const replyTool = message.result.tools.find(tool => tool.name === "reply");
    const replySchema = replyTool?.inputSchema;
    const replyVerified = replySchema?.properties?.chat_id?.type === "string" &&
      replySchema.properties.text?.type === "string" &&
      ["chat_id", "text"].every(field => replySchema.required?.includes(field));
    if (replyVerified) {
      replyTool.inputSchema.properties.conversation_interaction_id = {
        type: "string", description: "Required for Conversation Reminder readiness: copy message_id from the owner channel message being answered.",
      };
      replyTool.inputSchema.properties.conversation_disposition = {
        type: "string", enum: ["progress", "input-needed"],
        description: "Set input-needed only when this delivered reply asks the owner for input while work may continue; otherwise progress.",
      };
      replyTool.inputSchema.required = [...new Set([...(replyTool.inputSchema.required || []), "conversation_interaction_id"])];
      line = JSON.stringify(message);
    }
    if (selectedProject && supportedServerVersion) {
      const markerPath = path.join(stateDir, "capabilities", `${selectedProject}.json`);
      const assignment = await reminder.resolveAssignmentForChannel(selectedChannel, {
        registryPath: path.join(projectRoot, "registry.json"), botAppId: selectedAppId,
      }).catch(() => null);
      if (replyVerified && assignment?.project === selectedProject && assignment.project_type === "claude") {
        const directory = path.dirname(markerPath);
        await fs.mkdir(directory, { recursive: true, mode: 0o700 });
        await fs.chmod(directory, 0o700);
        await fs.writeFile(markerPath, JSON.stringify({
          schema_version: 1,
          project: selectedProject,
          channel_id: selectedChannel,
          assignment_generation: assignment.assignment_generation,
          plugin_version: "0.0.4",
          server_version: supportedServerVersion,
          transport: "official-discord-stdio-proxy",
          hooks_configured: await hasCommandHooks(),
          reply_tool_verified: true,
        }) + "\n", { mode: 0o600 });
      } else {
        await fs.rm(markerPath, { force: true });
      }
    }
  }
  if (message.result?.serverInfo) {
    const capabilities = message.result.capabilities || {};
    if (message.result.serverInfo.name !== "discord" || message.result.serverInfo.version !== "1.0.0" ||
        !capabilities.experimental?.["claude/channel"] || !capabilities.tools) {
      if (selectedProject) await fs.rm(path.join(stateDir, "capabilities", `${selectedProject}.json`), { force: true });
      process.stderr.write("Claude reminder channel: unsupported official Discord transport contract\n");
      plugin.kill("SIGTERM");
      process.exitCode = 2;
      return;
    }
    supportedServerVersion = message.result.serverInfo.version;
    if (selectedProject) {
      await fs.rm(path.join(stateDir, "capabilities", `${selectedProject}.json`), { force: true });
      message.result.instructions = `${message.result.instructions || ""}\nFor every reply, pass conversation_interaction_id copied from the owner message_id being answered. Set conversation_disposition to input-needed only when the delivered reply explicitly asks the owner for input; otherwise use progress. A reply without a valid interaction ID is delivered normally but does not count as a confirmed Conversation Reminder response.`;
      line = JSON.stringify(message);
    }
  }
  if (message.method !== "notifications/claude/channel") {
    process.stdout.write(`${line}\n`);
    return;
  }
  const meta = message.params?.meta || {};
  if (selectedChannel && meta.chat_id !== selectedChannel) return;
  if (!isClose(message.params?.content)) {
    if (meta.chat_id && meta.message_id && meta.user_id && (!selectedChannel || meta.chat_id === selectedChannel)) {
      const assignment = await reminder.resolveAssignmentForChannel(meta.chat_id, {
        registryPath: path.join(projectRoot, "registry.json"),
        ...(selectedProject ? { botAppId: selectedAppId } : {}),
      }).catch(() => null);
      if (assignment && (!selectedProject || assignment.project === selectedProject) && meta.user_id === assignment.owner_id) {
        if (selectedProject) {
          interactions.set(meta.message_id, {
            ...assignment,
            provider: "claude",
            provider_session_id: launchId,
            provider_turn_id: meta.message_id,
            interaction_id: meta.message_id,
            source_message_id: meta.message_id,
            initiator_id: meta.user_id,
          });
        }
        await reminder.emitEvent("owner_activity", { ...assignment, provider: selectedProject ? "claude" : "ccdm-root" }, {
          actor_id: meta.user_id,
          source_message_id: meta.message_id,
          activity_kind: meta.attachment_count ? "attachment" : "message",
        }).catch(error => process.stderr.write(`Claude reminder channel: activity recording failed: ${error.message}\n`));
        if (inputNeededMarker && inputNeededMarker.context.interaction_id !== meta.message_id) {
          const { marker, context } = inputNeededMarker;
          const markerPath = path.join(process.env.CCDM_REMINDER_RECEIPTS_DIR || path.join(stateDir, "claude-receipts"), `${marker.event_id}.json`);
          if (await fs.stat(markerPath).then(() => true).catch(() => false)) {
            await reminder.emitEvent("work_resumed", context, {
              source_message_id: meta.message_id,
              resumed_from_turn_id: context.provider_turn_id,
            }).catch(error => process.stderr.write(`Claude reminder channel: resumed-work recording failed: ${error.message}\n`));
          }
          inputNeededMarker = null;
        }
      }
    }
    process.stdout.write(`${line}\n`);
    return;
  }
  // A filtered command is never relayed to a model even if registration has
  // changed while the provider was running.
  if (!meta.chat_id || !meta.message_id || !meta.user_id) return;
  if (selectedChannel && meta.chat_id !== selectedChannel) return;
  const assignment = await reminder.resolveAssignmentForChannel(meta.chat_id, {
    registryPath: path.join(projectRoot, "registry.json"),
    ...(selectedProject ? { botAppId: selectedAppId } : {}),
  }).catch(() => null);
  if (!assignment || (selectedProject && assignment.project !== selectedProject)) return;
  if (meta.user_id === assignment.owner_id) {
    await reminder.emitEvent("close_requested", { ...assignment, provider: selectedProject ? "claude" : "ccdm-root" }, {
      actor_id: meta.user_id,
      source_message_id: meta.message_id,
      command: "/close",
    });
  }
}

let pluginQueue = reminder.drainOutbox();
createInterface({ input: plugin.stdout }).on("line", line => {
  pluginQueue = pluginQueue.then(() => handlePluginMessage(line)).catch(error => {
    process.stderr.write(`Claude reminder channel: filter failed: ${error.message}\n`);
  });
});
createInterface({ input: process.stdin }).on("line", line => {
  let outgoing = line;
  try {
    const request = JSON.parse(line);
    if (selectedChannel && request.method === "tools/call") {
      const name = request.params?.name;
      const argumentsValue = request.params?.arguments || {};
      const target = name === "fetch_messages" ? argumentsValue.channel
        : ["reply", "react", "edit_message", "download_attachment"].includes(name) ? argumentsValue.chat_id
        : null;
      if (target !== selectedChannel) {
        process.stdout.write(JSON.stringify({
          jsonrpc: "2.0", id: request.id,
          result: { isError: true, content: [{ type: "text", text: "channel not assigned" }] },
        }) + "\n");
        return;
      }
    }
    if (request.method === "tools/call" && request.params?.name === "reply") {
      const supplied = request.params.arguments || {};
      const context = interactions.get(supplied.conversation_interaction_id);
      if (context && supplied.chat_id === context.channel_id && request.id !== undefined) {
        pendingReplies.set(request.id, {
          context,
          disposition: supplied.conversation_disposition === "input-needed" ? "input-needed" : "progress",
        });
      }
      delete supplied.conversation_interaction_id;
      delete supplied.conversation_disposition;
      outgoing = JSON.stringify(request);
    }
  } catch { /* The official MCP server validates malformed requests. */ }
  if (plugin.stdin.writable) plugin.stdin.write(`${outgoing}\n`);
});
