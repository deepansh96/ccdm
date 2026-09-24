"use strict";

// History discovery transport. The service chooses every bounded request and
// owns eligibility; this module only reads Discord with the root observation
// credentials and reduces each message to an identity, timestamp, and kind.
// Message text is used for command classification and never leaves this process.

// Fixed CCDM management acknowledgments are command output, not answers.
const COMMAND_OUTPUTS = new Set([
  "Bridge paused. New messages will be queued.",
  "Bridge unpaused.",
  "Compaction queued.",
  "Conversation cleared — fresh thread started.",
  "Restarting session — fresh thread coming up.",
  "Restarting root session — fresh thread coming up.",
]);
const MANAGEMENT_COMMANDS = new Set(["/compact", "/clear", "/pause", "/unpause", "/restart"]);
const USER_MESSAGE_TYPES = new Set([0, 19]);

function mentions(content, id) {
  return Boolean(id) && [`<@${id}>`, `<@!${id}>`].some(value => content.startsWith(value));
}

function classify(message, found, rootUserId, isClose) {
  const author = String(message.author?.id || "");
  const content = String(message.content || "").trim();
  let kind = "other";
  if (message.type !== undefined && !USER_MESSAGE_TYPES.has(message.type)) {
    kind = "other";
  } else if (author === found.owner_id) {
    if (isClose(content, found.bot_app_id, rootUserId)) kind = "owner-close";
    else if (MANAGEMENT_COMMANDS.has(content) || mentions(content, rootUserId)) kind = "owner-command";
    else if (content || message.attachments?.length) kind = "owner-message";
  } else if (author === String(found.bot_app_id)) {
    kind = COMMAND_OUTPUTS.has(content) || /^\*\*Error:\*\* Failed to (clear|restart)/.test(content)
      ? "command-output" : "bot";
  } else if (author && !message.author?.bot) {
    kind = "guest";
  }
  const reactions = (Array.isArray(message.reactions) ? message.reactions : [])
    .filter(reaction => Number(reaction?.count) - (reaction?.me ? 1 : 0) > 0 && reaction?.emoji?.name)
    .map(reaction => reaction.emoji.id ? `${reaction.emoji.name}:${reaction.emoji.id}` : reaction.emoji.name);
  return { id: message.id, at: message.timestamp, kind, reactions };
}

async function read(request, found, token, rootUserId, isClose) {
  const base = `https://discord.com/api/v10/channels/${encodeURIComponent(request.channel_id)}/messages`;
  const params = new URLSearchParams({ limit: String(request.limit) });
  let url;
  if (request.kind === "reactions") {
    url = `${base}/${encodeURIComponent(request.message_id)}/reactions/${encodeURIComponent(request.emoji)}?${params}`;
  } else {
    if (request.before) params.set("before", request.before);
    if (request.after) params.set("after", request.after);
    url = `${base}?${params}`;
  }
  let response;
  try {
    response = await fetch(url, { headers: { Authorization: `Bot ${token}` }, signal: AbortSignal.timeout(10000) });
  } catch {
    return { status: 0 };
  }
  if (response.status === 429) {
    const body = await response.json().catch(() => ({}));
    const seconds = Number(body.retry_after ?? response.headers.get("Retry-After"));
    return { status: 429, ...(Number.isFinite(seconds) ? { retry_after: seconds } : {}) };
  }
  if (!response.ok) return { status: response.status };
  const body = await response.json().catch(() => null);
  if (!Array.isArray(body)) return { status: 0 };
  if (request.kind === "reactions") return { status: 200, users: body.map(user => String(user?.id ?? "")) };
  if (body.some(message => typeof message?.id !== "string" || typeof message?.timestamp !== "string")) {
    return { status: 0 };
  }
  return { status: 200, messages: body.map(message => classify(message, found, rootUserId, isClose)) };
}

// One bounded pass: the service stops issuing requests once every channel has
// used its per-pass page and reaction budget, is backing off, or is resolved.
async function runPass({ service, assignment, rootToken, rootUserId, isClose }) {
  const checked = new Map();
  let token;
  for (;;) {
    const { request } = await service(["discovery-next"]);
    if (!request) return;
    if (!checked.has(request.channel_id)) checked.set(request.channel_id, await assignment(request.channel_id));
    const found = checked.get(request.channel_id);
    let result;
    if (!found || found.project !== request.project ||
        found.assignment_generation !== request.assignment_generation) {
      result = { status: 403, reason: "observation access, assignment, or adapter capability unavailable" };
    } else {
      token ||= await rootToken();
      result = await read(request, found, token, rootUserId, isClose);
    }
    await service(["discovery-result", "--payload", JSON.stringify({
      request_id: request.request_id, project: request.project,
      assignment_generation: request.assignment_generation, ...result,
    })]);
  }
}

module.exports = { classify, runPass };
