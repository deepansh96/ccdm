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
const discovery = require("./conversation-reminder-discovery.js");

const exec = promisify(execFile);
const script = path.join(__dirname, "conversation-reminder-service.py");
const projectRoot = process.argv[process.argv.indexOf("--project-root") + 1] || path.resolve(__dirname, "..");
const stateDir = process.argv[process.argv.indexOf("--state-dir") + 1] || path.join(os.homedir(), ".local/state/ccdm/conversation-reminders");
const recoverOnce = process.argv.includes("--recover-once");
// REST-only retired cleanup for assignment-changed; it never logs in to the Gateway.
const cleanupRetiredOnce = process.argv.includes("--cleanup-retired-once");
const cleanupProject = cleanupRetiredOnce ? process.argv[process.argv.indexOf("--project") + 1] : null;
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions, GatewayIntentBits.MessageContent],
  partials: [Partials.Message, Partials.Reaction, Partials.User],
});
let busy = false;
let stopping = false;
let connected = false;
let readyOnce = false;
const nextActionAttempt = new Map();
const healthPath = path.join(stateDir, "observer-health.json");
const health = {};
let healthWrite = Promise.resolve();

async function retryClockMs() {
  const file = process.env.CCDM_REMINDER_CLOCK_FILE;
  if (!file) return Date.now();
  const value = Date.parse((await readFile(file, "utf8")).trim());
  if (!Number.isFinite(value)) throw new Error("invalid reminder clock");
  return value;
}

const SUSPENSIONS = {
  "blocked-assignment": "suspended-assignment",
  "blocked-adapter-capability": "suspended-adapter-capability",
  "blocked-observation-access": "suspended-observation-access",
  "blocked-assigned-bot-permissions": "suspended-delivery-access",
};
let registryFingerprint = null;

async function markHealth(project, state, generation) {
  if (health[project] === state) return;
  // Lost access or capability durably stops delivery for that assignment only.
  if (generation && SUSPENSIONS[state]) {
    await exec(process.env.CCDM_REMINDER_PYTHON || "python3", [script, "suspend", "--state-dir", stateDir,
      "--project", project, "--generation", generation, "--reason", SUSPENSIONS[state]]);
  } else if (generation && state === "ready-observe-only" && SUSPENSIONS[health[project]]) {
    // Access or adapter capability returned (for example a Claude session
    // restarted with its adapter); reconcile what was missed before any send.
    await exec(process.env.CCDM_REMINDER_PYTHON || "python3", [script, "resume", "--state-dir", stateDir,
      "--project", project, "--generation", generation]);
  }
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
    await markHealth(found.project, "blocked-assignment", found.assignment_generation);
    return null;
  }
  const readiness = await exec(process.env.CCDM_REMINDER_PYTHON || "python3",
    [path.join(__dirname, "conversation-reminder-readiness.py"), found.project, "--json",
      "--project-root", projectRoot, "--state-dir", stateDir]).then(result => JSON.parse(result.stdout))
    // A blocked readiness report exits nonzero but still explains its cause.
    .catch(error => { try { return JSON.parse(error.stdout); } catch { return null; } });
  if (!readiness?.ready) {
    const assignmentProblem = readiness?.assignment_mismatches?.length || readiness?.missing_credentials?.length;
    await markHealth(found.project, assignmentProblem ? "blocked-assignment" : "blocked-adapter-capability",
      found.assignment_generation);
    return null;
  }
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel?.permissionsFor) {
    await markHealth(found.project, "blocked-observation-access", found.assignment_generation);
    return null;
  }
  // During a Discord outage a guild can be unavailable, with no roles cached;
  // treat that as lost access and retry on the next revalidation.
  if (channel.guild && channel.guild.available === false) {
    await markHealth(found.project, "blocked-observation-access", found.assignment_generation);
    return null;
  }
  let botMember = found.bot_app_id;
  if (channel.guild?.members?.fetch) {
    botMember = await channel.guild.members.fetch(found.bot_app_id).catch(() => null);
    if (!botMember) {
      await markHealth(found.project, "blocked-assigned-bot-permissions", found.assignment_generation);
      return null;
    }
  }
  let rootPermissions, botPermissions;
  try {
    rootPermissions = channel.permissionsFor(client.user);
    botPermissions = channel.permissionsFor(botMember);
  } catch {
    // A partially cached guild cannot resolve permissions yet.
    await markHealth(found.project, "blocked-observation-access", found.assignment_generation);
    return null;
  }
  if (!rootPermissions || !["ViewChannel", "ReadMessageHistory"].every(flag => rootPermissions.has(flag))) {
    await markHealth(found.project, "blocked-observation-access", found.assignment_generation);
    return null;
  }
  if (!botPermissions || !["ViewChannel", "ReadMessageHistory", "SendMessages", "AddReactions"].every(flag => botPermissions.has(flag))) {
    await markHealth(found.project, "blocked-assigned-bot-permissions", found.assignment_generation);
    return null;
  }
  await markHealth(found.project, "ready-observe-only", found.assignment_generation);
  return { ...found, bot_token: bot[0].token };
}

// Retired cleanup may use only the bot that served the retired assignment, and
// only while that bot is not authorized for a different channel.
async function retiredCredentials(action) {
  const data = await registry();
  const bots = Array.isArray(data.pool) ? data.pool.filter(row => row?.id === action.bot_id) : [];
  if (bots.length !== 1 || !bots[0].token) return { reason: "retired bot credentials are no longer available" };
  const projects = data.projects && typeof data.projects === "object" ? data.projects : {};
  const assignedTo = bots[0].assigned_to;
  const channels = Object.values(projects).filter(project => project?.bot_id === action.bot_id)
    .map(project => String(project.channel_id));
  if (assignedTo) channels.push(String(projects[assignedTo]?.channel_id));
  if (channels.some(channel => channel !== action.channel_id)) {
    return { reason: "retired bot is now authorized for another assignment" };
  }
  return { token: bots[0].token };
}

async function reportLeftover(action, reason) {
  await exec(process.env.CCDM_REMINDER_PYTHON || "python3",
    [script, "leftover", "--state-dir", stateDir, "--action-id", action.action_id, "--reason", reason]);
}

// The assignment-change workflow removes a retired assignment's reminders at
// once, with that assignment's own bot, instead of leaving them pending until
// a worker runs. Anything it cannot remove is reported as inaccessible.
const RETIRED_CLEANUP_ATTEMPTS = 3;

async function cleanupRetired(project) {
  const pending = await exec(process.env.CCDM_REMINDER_PYTHON || "python3",
    [script, "actions", "--project-root", projectRoot, "--state-dir", stateDir]);
  const result = { completed: [], inaccessible: [] };
  for (const action of JSON.parse(pending.stdout).actions) {
    if (!action.retired || action.kind !== "delete" || action.project !== project) continue;
    const credentials = await retiredCredentials(action);
    let reason = credentials.reason;
    if (credentials.token) {
      const url = `https://discord.com/api/v10/channels/${encodeURIComponent(action.channel_id)}` +
        `/messages/${encodeURIComponent(action.message_id)}`;
      for (let attempt = 0; attempt < RETIRED_CLEANUP_ATTEMPTS; attempt++) {
        let response;
        try {
          response = await fetch(url, { method: "DELETE", headers: { Authorization: `Bot ${credentials.token}` },
            signal: AbortSignal.timeout(10000) });
        } catch {
          reason = "Discord did not answer the retired cleanup request; delete the message in Discord";
          await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
          continue;
        }
        if (response.ok || response.status === 404) {
          reason = null;
          break;
        }
        if (response.status === 401 || response.status === 403) {
          reason = response.status === 401
            ? "retired bot credentials were rejected" : "retired bot no longer has access to the channel";
          break;
        }
        reason = `Discord did not delete the retired reminder (HTTP ${response.status}); delete the message in Discord`;
        let wait = 1000 * (attempt + 1);
        if (response.status === 429) {
          const body = await response.json().catch(() => ({}));
          const seconds = Number(body.retry_after ?? response.headers.get("Retry-After"));
          if (Number.isFinite(seconds) && seconds >= 0) wait = Math.max(wait, seconds * 1000);
        } else if (response.status < 500) {
          break;
        }
        if (wait > 10000) break;
        await new Promise(resolve => setTimeout(resolve, wait));
      }
    }
    try {
      if (reason) {
        await reportLeftover(action, reason);
        result.inaccessible.push({ message_id: action.message_id, reason });
      } else {
        await exec(process.env.CCDM_REMINDER_PYTHON || "python3",
          [script, "done", "--state-dir", stateDir, "--action-id", action.action_id]);
        result.completed.push(action.message_id);
      }
    } catch {
      // A running worker recorded this action first; its status is authoritative.
    }
  }
  return result;
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
  // Root-management traffic never reopens a conversation, wherever the mention sits.
  const rootMention = [`<@${client.user.id}>`, `<@!${client.user.id}>`].some(value => content.includes(value));
  const managedCommand = ["/compact", "/clear", "/pause", "/unpause", "/restart"].includes(content);
  if (!content && !message.attachments?.size) return;
  const kind = managedCommand || rootMention ? "management-command"
    : message.attachments?.size ? "attachment" : "message";
  await reminder.emitEvent("owner_activity", context, {
    actor_id: message.author.id, source_message_id: message.id, activity_kind: kind,
  });
}

function reactionEmoji(reaction) {
  return String(reaction.emoji?.id || reaction.emoji?.name || "") || undefined;
}

async function observeReaction(reaction, user) {
  if (user?.bot) return;
  const found = await assignment(reaction.message?.channel?.id || reaction.message?.channelId);
  if (!found || user.id !== found.owner_id) return;
  // Any owner reaction acknowledges, including one on a recorded reminder.
  // The stable reaction identity lets the service merge this copy with the
  // Codex bridge's copy of the same Discord reaction.
  await reminder.emitEvent("owner_activity", { ...found, provider: "ccdm-root" }, {
    actor_id: user.id, source_message_id: reaction.message.id, activity_kind: "reaction",
    reaction_emoji: reactionEmoji(reaction),
  });
}

// A lost reminder is identified only by evidence bound to its durable intent.
// Discord deduplicates an enforce_nonce create for "the past few minutes" and
// then returns the message the nonce already created. Inside a conservative
// part of that window, recovery repeats the claim's exact create: the answer
// is the reminder the lost request created, or the only one this nonce can
// create. A later history read carries no nonce, so after the window history
// can only prove that nothing was created. A bot 👀 found there is never
// adopted, because nothing ties it to the intent.
const NONCE_REPLAY_MS = 2 * 60000;
const IDENTITY_SKEW_MS = 2 * 60000;
const IDENTITY_WINDOW_MS = 5 * 60000;
const IDENTITY_PAGES = 5;

async function recordRecoveredSend(intent, result) {
  await exec(process.env.CCDM_REMINDER_PYTHON || "python3",
    [script, "result", "--project-root", projectRoot, "--state-dir", stateDir,
      "--nonce", intent.nonce, "--outcome", "sent", "--message-id", result.messageId,
      "--sent-at", result.sentAt]);
}

async function recoverIntents(scheduled = false) {
  const listed = await exec(process.env.CCDM_REMINDER_PYTHON || "python3",
    [script, "intents", "--state-dir", stateDir]);
  let recovered = 0;
  let released = 0;
  const unresolved = [];
  const intents = JSON.parse(listed.stdout).intents;
  for (const nonce of intentBackoff.keys()) {
    if (!intents.some(intent => intent.nonce === nonce)) intentBackoff.delete(nonce);
  }
  for (const intent of intents) {
    const backoff = intentBackoff.get(intent.nonce);
    if (scheduled && backoff && backoff.at > performance.now()) continue;
    const delay = Math.min(INTENT_BACKOFF_MAX_MS, backoff ? backoff.delay * 2 : INTENT_RECOVERY_MS);
    intentBackoff.set(intent.nonce, { at: performance.now() + delay, delay });
    const found = await assignment(intent.channel_id);
    if (!found || found.project !== intent.project ||
        found.assignment_generation !== intent.assignment_generation || found.bot_id !== intent.bot_id) {
      unresolved.push({ project: intent.project, nonce: intent.nonce, reason: "assignment or credentials unavailable" });
      continue;
    }
    const claimed = Date.parse(intent.claimed_at);
    const base = `https://discord.com/api/v10/channels/${encodeURIComponent(intent.channel_id)}/messages`;
    if (await retryClockMs() <= claimed + NONCE_REPLAY_MS) {
      const replay = await sendReminder(base, found.bot_token, intent.nonce);
      if (replay.outcome === "sent") {
        await recordRecoveredSend(intent, replay);
        recovered++;
        continue;
      }
      unresolved.push({ project: intent.project, nonce: intent.nonce, reason: replay.outcome === "access"
        ? "Discord refused the nonce replay; restore assigned bot access, then retry recover"
        : "the nonce replay got no usable answer; retrying while Discord's duplicate check still applies" });
      continue;
    }
    const lower = claimed - IDENTITY_SKEW_MS;
    const upper = claimed + IDENTITY_WINDOW_MS;
    const recorded = new Set(intent.recorded_message_ids || []);
    let before;
    const candidates = [];
    let complete = false;
    let reason = "bounded history did not reach the claim time; identity remains unresolved";
    for (let page = 0; page < IDENTITY_PAGES && !complete; page++) {
      const url = `${base}?limit=100${before ? `&before=${encodeURIComponent(before)}` : ""}`;
      let response;
      try {
        response = await fetch(url, { headers: { Authorization: `Bot ${found.bot_token}` },
          signal: AbortSignal.timeout(10000) });
      } catch {
        reason = "Discord identity lookup unavailable; retry recovery after access returns";
        break;
      }
      if (!response.ok) {
        reason = response.status === 401 || response.status === 403
          ? "Discord identity lookup denied; restore assigned bot access before retrying"
          : "Discord identity lookup failed; retry recovery without resending";
        break;
      }
      const messages = await response.json().catch(() => null);
      if (!Array.isArray(messages) || messages.some(message => !message || typeof message.id !== "string" ||
          typeof message.timestamp !== "string" || !Number.isFinite(Date.parse(message.timestamp)))) {
        reason = "Discord history is malformed; identity remains unresolved";
        break;
      }
      for (const message of messages) {
        const at = Date.parse(message.timestamp);
        if (String(message.author?.id) === String(found.bot_app_id) && message.content === "👀" &&
            at >= lower && at <= upper && !recorded.has(message.id)) candidates.push(message.id);
      }
      // Newest first: a page reaching past the window's start, or the start of
      // the channel, covers every message the claim could have produced.
      complete = messages.length < 100 || messages.some(message => Date.parse(message.timestamp) < lower);
      if (messages.length) before = messages[messages.length - 1].id;
    }
    if (complete && candidates.length) {
      unresolved.push({ project: intent.project, nonce: intent.nonce, candidates,
        reason: `${candidates.length} unrecorded 👀 message(s) from the assigned bot fall in the claim window, ` +
          "but no evidence binds them to this intent, so none was adopted. If a listed message is a stray " +
          "reminder, delete it in Discord and run recover; if it is an ordinary bot message, run " +
          `assignment-changed --project ${intent.project} to retire the unresolved intent` });
      continue;
    }
    if (complete && await retryClockMs() > upper) {
      // The whole window is visible and the bot posted nothing: the request
      // never created a reminder, so the channel may reconcile and send again.
      await exec(process.env.CCDM_REMINDER_PYTHON || "python3",
        [script, "result", "--project-root", projectRoot, "--state-dir", stateDir,
          "--nonce", intent.nonce, "--outcome", "absent"]);
      released++;
      continue;
    }
    if (complete) reason = "no reminder is visible yet; retry after the identity window closes";
    unresolved.push({ project: intent.project, nonce: intent.nonce, reason });
  }
  return { recovered, released, unresolved };
}

const INTENT_RECOVERY_MS = 5000;
const INTENT_BACKOFF_MAX_MS = 300000;
let nextIntentRecovery = 0;
// Unresolved intents back off per nonce so a stuck lookup never polls Discord hard.
const intentBackoff = new Map();
const SEND_ATTEMPTS = 3;
const SEND_RETRY_MS = [1000, 3000];
// Connection failures before any request byte was sent; nothing reached Discord.
const UNSENT_ERRORS = new Set(["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ENETUNREACH", "EHOSTUNREACH",
  "EADDRNOTAVAIL", "UND_ERR_CONNECT_TIMEOUT"]);

async function sendReminder(url, token, nonce) {
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ content: "👀", allowed_mentions: { parse: [] }, nonce, enforce_nonce: true }),
      signal: AbortSignal.timeout(10000),
    });
  } catch (error) {
    const code = error?.cause?.code || error?.code;
    return { outcome: UNSENT_ERRORS.has(code) ? "failed" : "ambiguous" };
  }
  if (response.ok) {
    const payload = await response.json().catch(() => null);
    const messageId = typeof payload?.id === "string" ? payload.id : null;
    const sentAt = typeof payload?.timestamp === "string" && !Number.isNaN(Date.parse(payload.timestamp))
      ? payload.timestamp : null;
    return messageId && sentAt ? { outcome: "sent", messageId, sentAt } : { outcome: "ambiguous" };
  }
  if (response.status === 429) {
    const body = await response.json().catch(() => ({}));
    return { outcome: "failed", retryAfter: Number(body.retry_after ?? response.headers.get("Retry-After")) };
  }
  // A server error may follow a created message; only the same nonce can tell.
  if (response.status >= 500) return { outcome: "ambiguous" };
  return { outcome: "access" };
}

async function sideEffects(recoveryOnly = false) {
  // While the Gateway is down no owner activity can be observed, so neither
  // reconciliation nor delivery may run until the reconnect gap is recorded.
  if (busy || stopping || (!recoveryOnly && !connected)) return;
  busy = true;
  try {
    if (!recoveryOnly) {
      await revalidate();
      await discovery.runPass({
        service: async args => JSON.parse((await exec(process.env.CCDM_REMINDER_PYTHON || "python3",
          [script, ...args, "--project-root", projectRoot, "--state-dir", stateDir])).stdout),
        assignment, rootToken, rootUserId: client.user.id, isClose: closeCommand,
      });
    }
    const recovery = recoveryOnly ? await recoverIntents() : null;
    if (!recoveryOnly && performance.now() >= nextIntentRecovery) {
      // A lost response or network blip resolves itself once history shows
      // whether the reminder exists; it never waits on an operator.
      nextIntentRecovery = performance.now() + INTENT_RECOVERY_MS;
      await recoverIntents(true);
    }
    const pending = await exec(process.env.CCDM_REMINDER_PYTHON || "python3",
      [script, "actions", "--project-root", projectRoot, "--state-dir", stateDir]);
    for (const action of JSON.parse(pending.stdout).actions) {
      if ((nextActionAttempt.get(action.action_id) || 0) > await retryClockMs()) continue;
      let token;
      if (action.retired) {
        if (action.kind !== "delete") continue;
        const credentials = await retiredCredentials(action);
        if (!credentials.token) {
          await reportLeftover(action, credentials.reason);
          continue;
        }
        token = credentials.token;
      } else {
        const found = await assignment(action.channel_id);
        if (!found || found.project !== action.project ||
            found.assignment_generation !== action.assignment_generation) continue;
        token = found.bot_token;
      }
      const messageUrl = `https://discord.com/api/v10/channels/${encodeURIComponent(action.channel_id)}` +
        `/messages/${encodeURIComponent(action.message_id)}`;
      const url = action.kind === "ack" ?
        `${messageUrl}/reactions/${encodeURIComponent("✅")}/@me` : messageUrl;
      const response = await fetch(url, {
        method: action.kind === "ack" ? "PUT" : "DELETE",
        headers: { Authorization: `Bot ${token}` },
      });
      if (action.retired && (response.status === 401 || response.status === 403)) {
        await reportLeftover(action, response.status === 401
          ? "retired bot credentials were rejected" : "retired bot no longer has access to the channel");
        continue;
      }
      if (!response.ok && !(action.kind === "delete" && response.status === 404)) {
        let delay = 1000;
        if (response.status === 429) {
          const body = await response.json().catch(() => ({}));
          const seconds = Number(body.retry_after ?? response.headers.get("Retry-After"));
          if (Number.isFinite(seconds) && seconds >= 0) delay = Math.max(1000, seconds * 1000);
        }
        nextActionAttempt.set(action.action_id, await retryClockMs() +
          (response.status === 429 ? delay : Math.min(300000, delay)));
        continue;
      }
      nextActionAttempt.delete(action.action_id);
      await exec(process.env.CCDM_REMINDER_PYTHON || "python3",
        [script, "done", "--state-dir", stateDir, "--action-id", action.action_id]);
    }
    if (recoveryOnly) return { status: "recovery-complete", ...recovery };
    const due = await exec(process.env.CCDM_REMINDER_PYTHON || "python3",
      [script, "claim", "--project-root", projectRoot, "--state-dir", stateDir]);
    const claim = JSON.parse(due.stdout).claim;
    if (!claim) return;
    const found = await assignment(claim.channel_id);
    const args = [script, "result", "--project-root", projectRoot, "--state-dir", stateDir,
      "--nonce", claim.nonce];
    if (!found || found.project !== claim.project ||
        found.assignment_generation !== claim.assignment_generation) {
      await exec(process.env.CCDM_REMINDER_PYTHON || "python3", [...args, "--outcome", "access"]);
      return;
    }
    const checked = await exec(process.env.CCDM_REMINDER_PYTHON || "python3",
      [script, "validate", "--project-root", projectRoot, "--state-dir", stateDir,
        "--nonce", claim.nonce]);
    if (!JSON.parse(checked.stdout).valid) return;
    const url = `https://discord.com/api/v10/channels/${encodeURIComponent(claim.channel_id)}/messages`;
    let outcome = "uncertain";
    let messageId;
    let sentAt;
    let retryAfter;
    // Every attempt reuses the claim's nonce with enforce_nonce, so Discord
    // returns the reminder an earlier ambiguous attempt created instead of
    // posting a second, untracked one.
    let ambiguous = false;
    for (let attempt = 0; attempt < SEND_ATTEMPTS; attempt++) {
      if (attempt) await new Promise(resolve => setTimeout(resolve, SEND_RETRY_MS[attempt - 1]));
      const result = await sendReminder(url, found.bot_token, claim.nonce);
      if (result.outcome === "ambiguous") {
        ambiguous = true;
        if (stopping) break;
        continue;
      }
      ({ messageId, sentAt, retryAfter } = result);
      // A definite refusal proves only that this attempt created nothing.
      outcome = result.outcome !== "sent" && ambiguous ? "uncertain" : result.outcome;
      break;
    }
    const resultArgs = [...args, "--outcome", outcome];
    if (messageId) resultArgs.push("--message-id", messageId);
    if (sentAt) resultArgs.push("--sent-at", sentAt);
    if (Number.isFinite(retryAfter)) resultArgs.push("--retry-after", String(retryAfter));
    await exec(process.env.CCDM_REMINDER_PYTHON || "python3", resultArgs);
  } catch (error) {
    if (recoveryOnly) throw error;
    process.stderr.write(`Conversation observer side effect pending: ${error.message}\n`);
  } finally {
    busy = false;
    if (stopping) shutdown();
  }
}

client.on("messageCreate", message => observeMessage(message).catch(error =>
  process.stderr.write(`Conversation observer message failed: ${error.message}\n`)));
client.on("messageReactionAdd", (reaction, user) => observeReaction(reaction, user).catch(error =>
  process.stderr.write(`Conversation observer reaction failed: ${error.message}\n`)));
// Revalidate owner, uniqueness, access, and capability for every registered
// project whenever the registry changes, and periodically so a stopped or
// restarted Claude adapter is noticed without other channel traffic.
const REVALIDATE_MS = 30000;
let lastRevalidation = 0;
async function revalidate() {
  const source = await readFile(path.join(projectRoot, "registry.json"), "utf8");
  if (source === registryFingerprint && performance.now() - lastRevalidation < REVALIDATE_MS) return;
  lastRevalidation = performance.now();
  for (const [name, project] of Object.entries(JSON.parse(source).projects || {})) {
    if (!project?.channel_id || !(await assignment(project.channel_id))) {
      if (!health[name]) await markHealth(name, "blocked-assignment");
    }
  }
  registryFingerprint = source;
}

// Any disconnect, resume, or new session may have dropped events. Durably send
// every ready channel back through restart reconciliation before further sends.
let gapChain = Promise.resolve();
let gapSequence = 0;
function observationGap(connectedNow) {
  connected = false;
  gapSequence++;
  gapChain = gapChain.then(async () => {
    await exec(process.env.CCDM_REMINDER_PYTHON || "python3",
      [script, "observation-gap", "--project-root", projectRoot, "--state-dir", stateDir]);
    connected = connectedNow;
  }).catch(error => {
    process.stderr.write(`Conversation observer could not record an observation gap: ${error.message}\n`);
    process.exit(2);
  });
  return gapChain;
}
for (const name of ["shardDisconnect", "shardReconnecting", "invalidated"]) {
  client.on(name, () => observationGap(false));
}
client.on("shardResume", () => observationGap(true));
// The first shardReady precedes "ready"; any later one is a new Gateway session.
client.on("shardReady", () => { if (readyOnce) observationGap(true); });

// Timers stop while the machine sleeps but the wall clock keeps going, and the
// Gateway socket can look connected until a missed heartbeat is noticed. A tick
// whose wall-clock gap disagrees with its monotonic gap, or that arrives far too
// late, is treated like a restart: nothing sends before restart reconciliation,
// and overdue channels get spaced catch-ups.
const WAKE_GAP_MS = 30000;
// Long enough for discord.js to notice a dead socket (about one heartbeat).
const WAKE_SETTLE_MS = Number(process.env.CCDM_REMINDER_WAKE_SETTLE_MS) || 45000;
let lastTick = null;
function wakeDetected() {
  const wall = Date.now();
  const monotonic = performance.now();
  const previous = lastTick;
  lastTick = { wall, monotonic };
  if (!previous) return false;
  const monotonicGap = monotonic - previous.monotonic;
  return monotonicGap > WAKE_GAP_MS || Math.abs(wall - previous.wall - monotonicGap) > WAKE_GAP_MS;
}

function tick() {
  if (wakeDetected()) {
    process.stderr.write("Conversation observer resumed after sleep or a clock jump; reconciling before any send\n");
    observationGap(false);
    const sequence = gapSequence;
    // Reconnect events supersede this hold; otherwise resume once the socket
    // has had time to prove itself or be replaced.
    gapChain.then(() => setTimeout(() => {
      if (gapSequence === sequence && !stopping) connected = true;
    }, WAKE_SETTLE_MS));
  }
  sideEffects(false);
}

client.on("ready", async () => {
  connected = true;
  readyOnce = true;
  await revalidate();
  if (recoverOnce) {
    try {
      const result = await sideEffects(true);
      process.stdout.write(`${JSON.stringify(result)}\n`);
      client.destroy();
      process.exit(0);
    } catch (error) {
      process.stderr.write(`Conversation recovery unavailable: ${error.message}\n`);
      client.destroy();
      process.exit(2);
    }
  }
  setInterval(tick, 250);
});
// Disable stops new work, but an in-flight Discord request finishes and its
// result is recorded, so it never becomes an uncertain send.
function shutdown() {
  stopping = true;
  if (busy) return;
  client.destroy();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
if (cleanupRetiredOnce) {
  cleanupRetired(cleanupProject).then(result => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exit(0);
  }).catch(error => {
    process.stderr.write(`Retired reminder cleanup unavailable: ${error.message}\n`);
    process.exit(2);
  });
} else {
  rootToken().then(token => client.login(token)).catch(error => {
    process.stderr.write(`Conversation observer unavailable: ${error.message}\n`);
    process.exit(2);
  });
}
