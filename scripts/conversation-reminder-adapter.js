"use strict";

const { execFile } = require("node:child_process");
const { createHash, randomUUID } = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);
const PROJECT_ROOT = process.env.CCDM_REMINDER_PROJECT_ROOT || path.resolve(__dirname, "..");
const STATE_DIR = process.env.CCDM_REMINDER_STATE_DIR || path.join(os.homedir(), ".local", "state", "ccdm", "conversation-reminders");
const OUTBOX_DIR = path.join(STATE_DIR, "outbox");
const CONTEXT_FILE = process.env.CCDM_REMINDER_CONTEXT_FILE || "";
const RECEIPTS_DIR = process.env.CCDM_REMINDER_RECEIPTS_DIR || "";
const ADAPTER_INSTANCE_ID = process.env.CCDM_REMINDER_ADAPTER_INSTANCE_ID || randomUUID();
const EVENT_RECEIVER = path.join(__dirname, "conversation-reminder-events.py");
const EXCLUDED_REMINDER_IDS_FILE = process.env.CCDM_REMINDER_EXCLUDED_MESSAGE_IDS_FILE || path.join(STATE_DIR, "recorded-reminder-message-ids.json");
let eventSequence = 0;

async function ensurePrivateDirectory(directory) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700);
}

function assignmentGeneration(projectName, ownerId, channelId, botId, botAppId, registeredAt) {
  return `sha256:${createHash("sha256").update([
    projectName, ownerId, channelId, botId, botAppId || "", registeredAt || "",
  ].join("\0")).digest("hex")}`;
}

async function resolveAssignmentForChannel(channelId, options = {}) {
  const registryPath = options.registryPath || path.join(PROJECT_ROOT, "registry.json");
  const registry = JSON.parse(await fs.readFile(registryPath, "utf8"));
  const projects = registry.projects && typeof registry.projects === "object" ? registry.projects : {};
  const matches = [];
  for (const [projectName, project] of Object.entries(projects)) {
    if (!project || project.channel_id !== channelId || !project.bot_id) continue;
    const bots = Array.isArray(registry.pool)
      ? registry.pool.filter((bot) => bot && bot.id === project.bot_id)
      : [];
    if (bots.length !== 1) continue;
    const bot = bots[0];
    if (options.botAppId && bot.app_id !== options.botAppId) continue;
    const ownerId = String(registry.discord_user_id || "");
    const generation = project.assignment_generation
      ? String(project.assignment_generation)
      : assignmentGeneration(
        projectName,
        ownerId,
        String(project.channel_id),
        String(project.bot_id),
        String(bot.app_id || ""),
        String(project.registered_at || ""),
      );
    matches.push({
      project: projectName,
      project_type: project.type || "claude",
      owner_id: ownerId,
      channel_id: String(project.channel_id),
      bot_id: String(project.bot_id),
      bot_app_id: String(bot.app_id || ""),
      assignment_generation: generation,
    });
  }
  if (matches.length !== 1) return null;
  if (options.requireCodex && matches[0].project_type !== "codex") return null;
  return matches[0];
}

function createEvent(eventType, context, fields = {}) {
  const now = Date.now();
  eventSequence += 1;
  const event = {
    schema_version: 1,
    event_id: randomUUID(),
    event_type: eventType,
    project: context.project,
    channel_id: context.channel_id,
    bot_id: context.bot_id,
    assignment_generation: context.assignment_generation,
    provider: context.provider || "codex",
    ...(context.provider_session_id ? { provider_session_id: context.provider_session_id } : {}),
    ...(context.provider_turn_id ? { provider_turn_id: context.provider_turn_id } : {}),
    event_time: new Date(now).toISOString(),
    event_order: `${String(now).padStart(16, "0")}:${ADAPTER_INSTANCE_ID}:${String(eventSequence).padStart(12, "0")}`,
    adapter_instance_id: ADAPTER_INSTANCE_ID,
    ...(context.interaction_id ? { interaction_id: context.interaction_id } : {}),
    ...fields,
  };
  return Object.fromEntries(Object.entries(event).filter(([, value]) => value !== undefined && value !== null));
}

async function spoolEvent(event) {
  await ensurePrivateDirectory(OUTBOX_DIR);
  const eventOrder = String(event.event_order).replace(/[^a-zA-Z0-9_-]/g, "_");
  const filePath = path.join(OUTBOX_DIR, `${eventOrder}-${event.event_id}.json`);
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  try {
    await fs.writeFile(temporaryPath, `${JSON.stringify(event)}\n`, { flag: "wx", mode: 0o600 });
    await fs.rename(temporaryPath, filePath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
  return filePath;
}

async function drainOutbox() {
  try {
    const { stdout } = await execFileAsync(
      process.env.CCDM_REMINDER_PYTHON || "python3",
      [EVENT_RECEIVER, "drain", "--project-root", PROJECT_ROOT, "--state-dir", STATE_DIR],
      { encoding: "utf8", maxBuffer: 1024 * 1024 },
    );
    return JSON.parse(stdout);
  } catch {
    return { status: "retryable_failure" };
  }
}

async function emitEvent(eventType, context, fields = {}) {
  if (!context || !context.project || !context.owner_id) return null;
  const event = createEvent(eventType, context, fields);
  await spoolEvent(event);
  await drainOutbox();
  return event;
}

async function writeActiveContext(context) {
  if (!CONTEXT_FILE) return;
  await ensurePrivateDirectory(path.dirname(CONTEXT_FILE));
  const payload = {
    schema_version: 1,
    project: context.project,
    owner_id: context.owner_id,
    channel_id: context.channel_id,
    bot_id: context.bot_id,
    assignment_generation: context.assignment_generation,
    provider: "codex",
    provider_session_id: context.provider_session_id,
    provider_turn_id: context.provider_turn_id,
    interaction_id: context.interaction_id,
    source_message_id: context.source_message_id,
    initiator_id: context.initiator_id,
  };
  const temporaryPath = `${CONTEXT_FILE}.${process.pid}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(payload)}\n`, { flag: "w", mode: 0o600 });
  await fs.chmod(temporaryPath, 0o600);
  await fs.rename(temporaryPath, CONTEXT_FILE);
}

async function readActiveContext(targetChannelId) {
  if (!CONTEXT_FILE) return null;
  try {
    const context = JSON.parse(await fs.readFile(CONTEXT_FILE, "utf8"));
    if (context.schema_version !== 1 || context.provider !== "codex" || context.channel_id !== targetChannelId) return null;
    for (const field of ["project", "owner_id", "channel_id", "bot_id", "assignment_generation", "provider_session_id", "provider_turn_id", "interaction_id"]) {
      if (typeof context[field] !== "string" || !context[field]) return null;
    }
    return context;
  } catch {
    return null;
  }
}

async function recordDeliveredReply(context, messageId, disposition = "progress") {
  if (!context || !messageId || !RECEIPTS_DIR) return null;
  const normalizedDisposition = disposition === "input-needed" ? "input-needed" : "progress";
  const receipt = createEvent("response_delivered", context, {
    message_id: String(messageId),
    disposition: normalizedDisposition,
    ...(context.source_message_id ? { source_message_id: context.source_message_id } : {}),
    ...(context.initiator_id ? { initiator_id: context.initiator_id } : {}),
  });
  await spoolEvent(receipt);
  await ensurePrivateDirectory(RECEIPTS_DIR);
  const markerPath = path.join(RECEIPTS_DIR, `${receipt.event_id}.json`);
  const marker = {
    event_id: receipt.event_id,
    event_type: receipt.event_type,
    event_order: receipt.event_order,
    provider_session_id: receipt.provider_session_id,
    provider_turn_id: receipt.provider_turn_id,
    interaction_id: receipt.interaction_id,
    message_id: receipt.message_id,
    disposition: receipt.disposition,
  };
  await fs.writeFile(markerPath, `${JSON.stringify(marker)}\n`, { flag: "wx", mode: 0o600 });
  if (normalizedDisposition === "input-needed") {
    const inputEvent = createEvent("input_needed", context, {
      message_id: String(messageId),
      disposition: "input-needed",
      source_message_id: context.source_message_id,
    });
    await spoolEvent(inputEvent);
  }
  await drainOutbox();
  return marker;
}

async function receiptsForTurn(sessionId, turnId) {
  if (!RECEIPTS_DIR) return [];
  let names;
  try {
    names = await fs.readdir(RECEIPTS_DIR);
  } catch {
    return [];
  }
  const receipts = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const marker = JSON.parse(await fs.readFile(path.join(RECEIPTS_DIR, name), "utf8"));
      if (marker.provider_session_id === sessionId && marker.provider_turn_id === turnId) receipts.push(marker);
    } catch {
      // An unreadable receipt cannot qualify a response.
    }
  }
  return receipts.sort((left, right) => left.event_order.localeCompare(right.event_order));
}

async function removeTurnReceipts(sessionId, turnId) {
  const receipts = await receiptsForTurn(sessionId, turnId);
  if (!RECEIPTS_DIR) return;
  for (const receipt of receipts) {
    await fs.rm(path.join(RECEIPTS_DIR, `${receipt.event_id}.json`), { force: true });
  }
}

async function clearActiveContext() {
  if (!CONTEXT_FILE) return;
  await fs.rm(CONTEXT_FILE, { force: true });
}

async function isRecordedReminderMessage(messageId) {
  try {
    const payload = JSON.parse(await fs.readFile(EXCLUDED_REMINDER_IDS_FILE, "utf8"));
    if (payload.schema_version !== 1 || !Array.isArray(payload.message_ids)) return true;
    return payload.message_ids.includes(String(messageId));
  } catch (error) {
    if (error.code === "ENOENT") return false;
    return true;
  }
}

module.exports = {
  clearActiveContext,
  createEvent,
  drainOutbox,
  emitEvent,
  isRecordedReminderMessage,
  readActiveContext,
  recordDeliveredReply,
  removeTurnReceipts,
  receiptsForTurn,
  resolveAssignmentForChannel,
  writeActiveContext,
};
