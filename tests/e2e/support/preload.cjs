const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const net = require("node:net");
const path = require("node:path");

const { withStateLock } = require("./state-lock.cjs");

const originalHttpRequest = http.request.bind(http);
const originalHttpGet = http.get.bind(http);
const originalHttpsRequest = https.request.bind(https);
const originalHttpsGet = https.get.bind(https);
const originalSetInterval = globalThis.setInterval.bind(globalThis);

// Simulated sleep: the wall clock jumps by the file's offset while monotonic
// timers do not, as when a Mac wakes.
if (process.env.CCDM_TEST_WALL_OFFSET_FILE) {
  const realNow = Date.now.bind(Date);
  let cached = { at: -Infinity, offset: 0 };
  Date.now = () => {
    const now = realNow();
    if (now - cached.at > 100) {
      let offset = 0;
      try {
        offset = Number(fs.readFileSync(process.env.CCDM_TEST_WALL_OFFSET_FILE, "utf8").trim()) || 0;
      } catch { /* No offset yet. */ }
      cached = { at: now, offset };
    }
    return now + cached.offset;
  };
}

const stateDir = process.env.CCDM_TEST_STATE;
const stateFile = stateDir ? path.join(stateDir, "state.json") : null;

function initialState() {
  return {
    fixtures: {
      discord: {
        attachmentFetches: [],
        attachments: {},
        channels: [],
        channelListFailures: 0,
        inviteDeletes: [],
        inviteTargetJobFetches: [],
        inviteTargetJobStatus: 2,
        invites: [],
        malformedRequests: [],
        memberRoleDeletes: [],
        memberRolePuts: [],
        nicknamePatches: [],
        permissionOverwrites: [],
        roleCreates: [],
        roles: [],
      },
      network: { blocked: [] },
    },
  };
}

function readState() {
  if (!stateFile || !fs.existsSync(stateFile)) return initialState();
  return JSON.parse(fs.readFileSync(stateFile, "utf8"));
}

function writeState(state) {
  if (!stateDir || !stateFile) return;
  fs.mkdirSync(stateDir, { recursive: true });
  const tmp = path.join(stateDir, `.state.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  fs.renameSync(tmp, stateFile);
}

function updateState(updater) {
  withStateLock(stateDir, () => {
    const state = readState();
    state.fixtures ||= {};
    state.fixtures.discord ||= {};
    state.fixtures.network ||= { blocked: [] };
    updater(state);
    writeState(state);
  });
}

function recordBlocked(kind, target) {
  updateState((state) => {
    state.fixtures.network.blocked ||= [];
    state.fixtures.network.blocked.push({ kind, target });
  });
}

function response(body, options = {}) {
  const status = options.status ?? 200;
  return new Response(status === 204 ? null : body, {
    headers: options.headers,
    status,
  });
}

function headerValue(headers, name) {
  if (!headers) return undefined;
  if (typeof headers.get === "function") return headers.get(name);
  return headers[name] ?? headers[name.toLowerCase()];
}

function formBodyFields(body) {
  if (!body || typeof body.entries !== "function") return null;
  const fields = {};
  for (const [key, value] of body.entries()) {
    fields[key] =
      typeof value === "string"
        ? value
        : { name: value.name, size: value.size, type: value.type };
  }
  return fields;
}

function takeRestFailure(method, url, init = {}) {
  const state = readState();
  const failures = state.fixtures?.discord?.restFailures;
  if (!Array.isArray(failures) || failures.length === 0) return null;
  const failure = failures[0];
  if (failure.method && failure.method !== method) return null;
  if (failure.path && failure.path !== url.pathname) return null;
  const remaining = failures.slice(1);
  updateState((nextState) => {
    nextState.fixtures.discord.restFailures = remaining;
    nextState.fixtures.discord.restFailureUses ||= [];
    nextState.fixtures.discord.restFailureUses.push({
      method,
      path: url.pathname,
      status: failure.status ?? 500,
    });
    if (method === "DELETE" && /^\/api\/v10\/channels\/[^/]+\/messages\/[^/]+$/.test(url.pathname)) {
      const parts = url.pathname.split("/");
      nextState.fixtures.discord.deletes ||= [];
      nextState.fixtures.discord.deletes.push({ method, channelId: parts[4], messageId: parts[6],
        authorization: headerValue(init.headers, "Authorization"), status: failure.status ?? 500 });
      nextState.fixtures.discord.reminderRequests ||= [];
      nextState.fixtures.discord.reminderRequests.push({ method: "DELETE", messageId: parts[6] });
    }
  });
  return response(JSON.stringify(failure.body ?? { message: `status ${failure.status ?? 500}` }), {
    headers: { "content-type": "application/json" },
    status: failure.status ?? 500,
  });
}

// Scripted rate limits: a rule `{ method, path, count, retryAfter, bucket, global }`
// answers matching requests with Discord's 429 shape until `count` runs out
// (`count: null` never does). Unlike `restFailures`, any rule may match, so one
// limited route leaves the others alone. Each 429 is recorded in `rateLimitHits`.
function takeRateLimit(method, url) {
  const rules = readState().fixtures?.discord?.rateLimits;
  if (!Array.isArray(rules) || rules.length === 0) return null;
  const matches = rule => (!rule.method || rule.method === method) && rule.path === url.pathname
    && (rule.count === null || rule.count > 0);
  let rule = null;
  updateState((state) => {
    rule = (state.fixtures.discord.rateLimits ?? []).find(matches) ?? null;
    if (!rule) return;
    if (rule.count !== null) rule.count -= 1;
    state.fixtures.discord.rateLimitHits ||= [];
    state.fixtures.discord.rateLimitHits.push({ method, path: url.pathname });
  });
  if (!rule) return null;
  const retryAfter = rule.retryAfter ?? 1;
  const headers = {
    "content-type": "application/json",
    "retry-after": String(Math.ceil(retryAfter)),
    "x-ratelimit-limit": "5",
    "x-ratelimit-remaining": "0",
    "x-ratelimit-reset-after": String(retryAfter),
    "x-ratelimit-scope": rule.global ? "global" : "user",
    ...(rule.bucket ? { "x-ratelimit-bucket": rule.bucket } : {}),
    ...(rule.global ? { "x-ratelimit-global": "true" } : {}),
  };
  return response(JSON.stringify({ message: "You are being rate limited.", retry_after: retryAfter,
    global: Boolean(rule.global) }), { headers, status: 429 });
}

// Discord knows a created message's author from the token that created it.
function authorForToken(authorization) {
  try {
    const root = process.env.CCDM_REMINDER_PROJECT_ROOT;
    const registry = JSON.parse(fs.readFileSync(path.join(root, "registry.json"), "utf8"));
    const bot = (registry.pool ?? []).find(entry => `Bot ${entry.token}` === authorization);
    if (bot?.app_id) return String(bot.app_id);
  } catch { /* Fall back to the single-bot fixture identity. */ }
  // The Router's token is the fake gateway's bot user.
  if (process.env.CCDM_ROUTER_STATE_DIR) return "fixture-bot-user-id";
  return "app";
}

// Reminders the fake created, as a history read returns them: no nonce.
function createdReminders(state, channelId) {
  if (state.fixtures?.discord?.includeSentInHistory === false) return [];
  return (state.fixtures.discord.messages ?? [])
    .filter(message => !message.deleted && message.requestBody?.nonce && message.channelId === channelId)
    .map(message => ({ id: message.id, channel_id: message.channelId, content: message.content, type: 0,
      attachments: [], author: { id: authorForToken(message.authorization), bot: true },
      timestamp: message.timestamp }))
    .reverse();
}

// Stateful per-channel history (newest first) with Discord's before/after
// pagination and reaction membership. Kept apart from `restMessages`, which
// other scenarios use as one shared recent-history page.
function routeChannelHistory(url, method, init) {
  if (url.hostname !== "discord.com" || method !== "GET") return null;
  const listMatch = /^\/api\/v10\/channels\/([^/]+)\/messages$/.exec(url.pathname);
  const reactionMatch = /^\/api\/v10\/channels\/([^/]+)\/messages\/([^/]+)\/reactions\/([^/]+)$/.exec(url.pathname);
  const channelId = listMatch?.[1] ?? reactionMatch?.[1];
  const state = readState();
  const seeded = state.fixtures?.discord?.history?.[channelId];
  if (!Array.isArray(seeded)) return null;
  // Created reminders join the seeded history in timestamp order.
  const history = [...seeded];
  for (const reminder of createdReminders(state, channelId).reverse()) {
    const index = history.findIndex(message => Date.parse(message.timestamp) <= Date.parse(reminder.timestamp));
    history.splice(index < 0 ? history.length : index, 0, reminder);
  }
  const json = (body, status = 200) => response(JSON.stringify(body), {
    headers: { "content-type": "application/json" }, status,
  });
  const limit = Number(url.searchParams.get("limit") || "50");
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    return json({ message: `Invalid limit: ${url.searchParams.get("limit")}` }, 400);
  }
  const authorization = headerValue(init.headers, "Authorization");
  if (reactionMatch) {
    const emoji = decodeURIComponent(reactionMatch[3]);
    updateState((nextState) => {
      nextState.fixtures.discord.reactionFetches ||= [];
      nextState.fixtures.discord.reactionFetches.push({ authorization, channelId, emoji,
        messageId: reactionMatch[2], limit });
    });
    if (!history.some(message => message.id === reactionMatch[2])) return json({ message: "Unknown Message" }, 404);
    const users = state.fixtures.discord.reactionUsers?.[`${reactionMatch[2]}|${emoji}`] ?? [];
    return json(users.slice(0, limit).map(id => ({ id, bot: false })));
  }
  const before = url.searchParams.get("before");
  const after = url.searchParams.get("after");
  if (before && after) return json({ message: "before and after are exclusive" }, 400);
  let page = history.slice(0, limit);
  if (before) {
    const index = history.findIndex(message => message.id === before);
    if (index < 0) return json({ message: "Unknown cursor" }, 400);
    page = history.slice(index + 1, index + 1 + limit);
  } else if (after) {
    const index = after === "0" ? history.length : history.findIndex(message => message.id === after);
    if (index < 0) return json({ message: "Unknown cursor" }, 400);
    page = history.slice(Math.max(0, index - limit), index);
  }
  let crash = false;
  updateState((nextState) => {
    nextState.fixtures.discord.historyFetches ||= [];
    nextState.fixtures.discord.historyFetches.push({ authorization, channelId, limit,
      ...(before ? { before } : {}), ...(after ? { after } : {}) });
    if (nextState.fixtures.discord.crashAfterHistoryPages > 0) {
      nextState.fixtures.discord.crashAfterHistoryPages -= 1;
      crash = nextState.fixtures.discord.crashAfterHistoryPages === 0;
      if (crash) delete nextState.fixtures.discord.crashAfterHistoryPages;
    }
  });
  if (crash) process.exit(86);
  return json(page);
}

// A message the fake created, seeded in channel history, or injected, shaped
// as Discord's GET returns it.
function channelMessage(state, messageId) {
  const discord = state.fixtures?.discord ?? {};
  const sent = (discord.messages ?? []).find(message => message.id === messageId && !message.deleted);
  if (sent) {
    return { id: sent.id, channel_id: sent.channelId, content: sent.content,
      ...(sent.webhookId ? { webhook_id: sent.webhookId } : {}),
      author: sent.webhookId ? { id: sent.webhookId, username: sent.username, bot: true }
        : { id: authorForToken(sent.authorization), bot: true } };
  }
  for (const [channelId, history] of Object.entries(discord.history ?? {})) {
    const seeded = Array.isArray(history) && history.find(message => message.id === messageId);
    if (seeded) return { ...seeded, channel_id: channelId };
  }
  const injected = (discord.injectedMessages ?? []).find(message => message.id === messageId);
  if (!injected) return null;
  // Discord re-signs attachment URLs on every fetch: `refreshedUrl` stands in for that.
  return { id: injected.id, channel_id: injected.channelId, content: injected.content,
    ...(injected.webhookId ? { webhook_id: injected.webhookId } : {}),
    author: { id: injected.author.id, username: injected.author.username, bot: Boolean(injected.author.bot) },
    attachments: (injected.attachments ?? []).map(attachment => ({ id: attachment.id, filename: attachment.name,
      content_type: attachment.contentType, size: attachment.size, url: attachment.refreshedUrl ?? attachment.url })) };
}

// Discord refuses webhook names and username overrides that contain these
// words or run past 80 characters.
function webhookNameProblem(name) {
  if (typeof name !== "string" || name.length === 0) return "Must be between 1 and 80 in length.";
  if ([...name].length > 80) return "Must be between 1 and 80 in length.";
  if (/discord|clyde/i.test(name)) return `Username cannot contain "${/clyde/i.test(name) ? "clyde" : "discord"}"`;
  return null;
}

// Channel webhooks: create and list with the bot token, execute with the
// webhook's own token. Executed messages are stored with their webhook_id.
function routeWebhooks(url, method, init) {
  if (url.hostname !== "discord.com") return null;
  const json = (body, status = 200) => response(JSON.stringify(body), {
    headers: { "content-type": "application/json" }, status,
  });
  const channelMatch = /^\/api\/v10\/channels\/([^/]+)\/webhooks$/.exec(url.pathname);
  if (channelMatch && method === "GET") {
    const webhooks = (readState().fixtures?.discord?.webhooks ?? []).filter(webhook => webhook.channel_id === channelMatch[1]);
    return json(webhooks);
  }
  if (channelMatch && method === "POST") {
    const parsedBody = init.body ? JSON.parse(String(init.body)) : {};
    const problem = webhookNameProblem(parsedBody.name);
    if (problem) return json({ code: 50035, message: "Invalid Form Body", errors: { name: problem } }, 400);
    let created;
    updateState((state) => {
      state.fixtures.discord.webhooks ||= [];
      state.fixtures.discord.webhookCreates ||= [];
      // Numbered by creation, so a recreated webhook never reuses a deleted id.
      const number = state.fixtures.discord.webhookCreates.length + 1;
      created = { id: `fake-webhook-${number}`, token: `fake-webhook-token-${number}`, type: 1,
        channel_id: channelMatch[1], name: parsedBody.name };
      state.fixtures.discord.webhooks.push(created);
      state.fixtures.discord.webhookCreates.push({ authorization: headerValue(init.headers, "Authorization"),
        channelId: channelMatch[1], name: parsedBody.name });
    });
    return json(created);
  }
  // One webhook by id with the bot token: GET returns it with its token (the
  // bot's application created it); DELETE removes it.
  const webhookMatch = /^\/api\/v10\/webhooks\/([^/]+)$/.exec(url.pathname);
  if (webhookMatch && (method === "GET" || method === "DELETE")) {
    if (!headerValue(init.headers, "Authorization")) return json({ code: 0, message: "401: Unauthorized" }, 401);
    const webhook = (readState().fixtures?.discord?.webhooks ?? []).find(entry => entry.id === webhookMatch[1]);
    if (!webhook) return json({ code: 10015, message: "Unknown Webhook" }, 404);
    if (method === "GET") return json(webhook);
    updateState((state) => {
      state.fixtures.discord.webhooks = state.fixtures.discord.webhooks.filter(entry => entry.id !== webhook.id);
      state.fixtures.discord.webhookDeletes ||= [];
      state.fixtures.discord.webhookDeletes.push({ authorization: headerValue(init.headers, "Authorization"),
        webhookId: webhook.id });
    });
    return response("", { status: 204 });
  }
  // Webhook message edit: only messages this webhook sent. Discord does not
  // let an edit change the username.
  const webhookEditMatch = /^\/api\/v10\/webhooks\/([^/]+)\/([^/]+)\/messages\/([^/]+)$/.exec(url.pathname);
  if (webhookEditMatch && method === "PATCH") {
    const parsedBody = init.body ? JSON.parse(String(init.body)) : {};
    const [, webhookId, webhookToken, messageId] = webhookEditMatch;
    const webhook = (readState().fixtures?.discord?.webhooks ?? []).find(entry => entry.id === webhookId);
    if (!webhook || webhook.token !== webhookToken) return json({ code: 10015, message: "Unknown Webhook" }, 404);
    let edited = null;
    updateState((state) => {
      const message = (state.fixtures.discord.messages ?? []).find(entry =>
        entry.id === messageId && entry.webhookId === webhookId && !entry.deleted);
      if (!message) return;
      message.content = parsedBody.content ?? message.content;
      state.fixtures.discord.webhookEdits ||= [];
      state.fixtures.discord.webhookEdits.push({ webhookId, messageId, content: parsedBody.content });
      edited = message;
    });
    if (!edited) return json({ code: 10008, message: "Unknown Message" }, 404);
    return json({ id: edited.id, channel_id: edited.channelId, content: edited.content, webhook_id: webhookId,
      author: { id: webhookId, username: edited.username, bot: true } });
  }
  const executeMatch = /^\/api\/v10\/webhooks\/([^/]+)\/([^/]+)$/.exec(url.pathname);
  if (executeMatch && method === "POST") {
    // Multipart executes carry the JSON body as payload_json beside files[n].
    const form = formBodyFields(init.body);
    const parsedBody = form ? JSON.parse(form.payload_json ?? "{}") : init.body ? JSON.parse(String(init.body)) : {};
    const uploads = form ? Object.keys(form).filter(key => /^files\[\d+\]$/.test(key))
      .map(key => ({ name: form[key].name, size: form[key].size })) : [];
    const webhook = (readState().fixtures?.discord?.webhooks ?? []).find(entry => entry.id === executeMatch[1]);
    if (!webhook || webhook.token !== executeMatch[2]) return json({ code: 10015, message: "Unknown Webhook" }, 404);
    const problem = parsedBody.username === undefined ? null : webhookNameProblem(parsedBody.username);
    const empty = !parsedBody.content && uploads.length === 0 ? "Cannot send an empty message"
      : [...(parsedBody.content ?? "")].length > 2000 ? "Must be 2000 or fewer in length." : null;
    if (problem || empty) {
      updateState((state) => {
        state.fixtures.discord.webhookRejections ||= [];
        state.fixtures.discord.webhookRejections.push({ webhookId: webhook.id, username: parsedBody.username,
          reason: problem || empty });
      });
      return json({ code: 50035, message: "Invalid Form Body", errors: { username: problem, content: empty } }, 400);
    }
    let created;
    updateState((state) => {
      state.fixtures.discord.messages ||= [];
      created = {
        avatarUrl: parsedBody.avatar_url,
        channelId: webhook.channel_id,
        content: parsedBody.content,
        id: `fake-message-${state.fixtures.discord.messages.length + 1}`,
        username: parsedBody.username ?? webhook.name,
        webhookId: webhook.id,
        ...(uploads.length ? { uploads } : {}),
      };
      state.fixtures.discord.messages.push(created);
    });
    if (url.searchParams.get("wait") !== "true") return response("", { status: 204 });
    // A test can make Discord attribute the returned message to another webhook.
    const returnedWebhookId = readState().fixtures?.discord?.webhookExecuteReturnsWebhookId ?? webhook.id;
    return json({ id: created.id, channel_id: created.channelId, content: created.content, webhook_id: returnedWebhookId,
      author: { id: returnedWebhookId, username: created.username, bot: true } });
  }
  return null;
}

function routeDiscordApi(url, init = {}) {
  const method = (init.method || "GET").toUpperCase();
  if (url.hostname === "discord.com") {
    const limited = takeRateLimit(method, url);
    if (limited) return limited;
    const failure = takeRestFailure(method, url, init);
    if (failure) return failure;
  }

  const guildRolesMatch = /^\/api\/v10\/guilds\/([^/]+)\/roles$/.exec(url.pathname);
  const guildChannelsMatch = /^\/api\/v10\/guilds\/([^/]+)\/channels$/.exec(url.pathname);
  if (url.hostname === "discord.com" && guildChannelsMatch && method === "GET") {
    const state = readState();
    if (state.fixtures?.discord?.channelListFailures > 0) {
      updateState((nextState) => {
        nextState.fixtures.discord.channelListFailures -= 1;
      });
      return response(JSON.stringify({ message: "channel list failed" }), {
        headers: { "content-type": "application/json" },
        status: 500,
      });
    }
    return response(JSON.stringify(state.fixtures?.discord?.channels ?? []), {
      headers: { "content-type": "application/json" },
    });
  }

  if (url.hostname === "discord.com" && guildRolesMatch && method === "GET") {
    const state = readState();
    return response(JSON.stringify(state.fixtures?.discord?.roles ?? []), {
      headers: { "content-type": "application/json" },
    });
  }

  if (url.hostname === "discord.com" && guildRolesMatch && method === "POST") {
    const parsedBody = init.body ? JSON.parse(String(init.body)) : {};
    let created;
    updateState((state) => {
      state.fixtures.discord.roles ||= [];
      state.fixtures.discord.roleCreates ||= [];
      created = {
        id: `fake-role-${state.fixtures.discord.roles.length + 1}`,
        name: parsedBody.name,
        permissions: parsedBody.permissions ?? "0",
      };
      state.fixtures.discord.roles.push(created);
      state.fixtures.discord.roleCreates.push({
        authorization: headerValue(init.headers, "Authorization"),
        guildId: guildRolesMatch[1],
        ...parsedBody,
      });
    });
    return response(JSON.stringify(created), {
      headers: { "content-type": "application/json" },
    });
  }

  const channelPermissionMatch = /^\/api\/v10\/channels\/([^/]+)\/permissions\/([^/]+)$/.exec(url.pathname);
  if (url.hostname === "discord.com" && channelPermissionMatch && method === "PUT") {
    const parsedBody = init.body ? JSON.parse(String(init.body)) : {};
    const state = readState();
    if (
      parsedBody.type === 1 &&
      (state.fixtures?.discord?.memberRolePut404UserIds || []).includes(channelPermissionMatch[2])
    ) {
      return response(JSON.stringify({ message: "Unknown Member" }), {
        headers: { "content-type": "application/json" },
        status: 404,
      });
    }
    updateState((state) => {
      state.fixtures.discord.permissionOverwrites ||= [];
      state.fixtures.discord.permissionOverwrites.push({
        allow: parsedBody.allow,
        authorization: headerValue(init.headers, "Authorization"),
        channelId: channelPermissionMatch[1],
        deny: parsedBody.deny,
        overwriteId: channelPermissionMatch[2],
        type: parsedBody.type,
      });
    });
    return response("", { status: 204 });
  }

  const memberRoleMatch = /^\/api\/v10\/guilds\/([^/]+)\/members\/([^/]+)\/roles\/([^/]+)$/.exec(url.pathname);
  if (url.hostname === "discord.com" && memberRoleMatch && method === "PUT") {
    const state = readState();
    if ((state.fixtures?.discord?.memberRolePut404UserIds || []).includes(memberRoleMatch[2])) {
      return response(JSON.stringify({ message: "Unknown Member" }), {
        headers: { "content-type": "application/json" },
        status: 404,
      });
    }
    updateState((state) => {
      state.fixtures.discord.memberRolePuts ||= [];
      state.fixtures.discord.memberRolePuts.push({
        authorization: headerValue(init.headers, "Authorization"),
        guildId: memberRoleMatch[1],
        roleId: memberRoleMatch[3],
        userId: memberRoleMatch[2],
      });
    });
    return response("", { status: 204 });
  }

  if (url.hostname === "discord.com" && memberRoleMatch && method === "DELETE") {
    updateState((state) => {
      state.fixtures.discord.memberRoleDeletes ||= [];
      state.fixtures.discord.memberRoleDeletes.push({
        authorization: headerValue(init.headers, "Authorization"),
        guildId: memberRoleMatch[1],
        roleId: memberRoleMatch[3],
        userId: memberRoleMatch[2],
      });
    });
    return response("", { status: 204 });
  }

  const createInviteMatch = /^\/api\/v10\/channels\/([^/]+)\/invites$/.exec(url.pathname);
  if (url.hostname === "discord.com" && createInviteMatch && method === "POST") {
    let invite;
    updateState((state) => {
      state.fixtures.discord.invites ||= [];
      invite = {
        authorization: headerValue(init.headers, "Authorization"),
        channelId: createInviteMatch[1],
        code: `fake-invite-${state.fixtures.discord.invites.length + 1}`,
        fields: formBodyFields(init.body),
      };
      state.fixtures.discord.invites.push(invite);
    });
    return response(JSON.stringify({ code: invite.code, url: `https://discord.gg/${invite.code}` }), {
      headers: { "content-type": "application/json" },
    });
  }

  const deleteInviteMatch = /^\/api\/v10\/invites\/([^/]+)$/.exec(url.pathname);
  if (url.hostname === "discord.com" && deleteInviteMatch && method === "DELETE") {
    const state = readState();
    if ((state.fixtures?.discord?.inviteDeleteFailures || []).includes(deleteInviteMatch[1])) {
      return response(JSON.stringify({ message: "delete invite failed" }), {
        headers: { "content-type": "application/json" },
        status: 500,
      });
    }
    updateState((state) => {
      state.fixtures.discord.inviteDeletes ||= [];
      state.fixtures.discord.inviteDeletes.push({
        authorization: headerValue(init.headers, "Authorization"),
        code: deleteInviteMatch[1],
      });
    });
    return response("", { status: 204 });
  }

  const inviteJobMatch = /^\/api\/v10\/invites\/([^/]+)\/target-users\/job-status$/.exec(url.pathname);
  if (url.hostname === "discord.com" && inviteJobMatch && method === "GET") {
    const state = readState();
    const status = state.fixtures?.discord?.inviteTargetJobStatus ?? 2;
    updateState((nextState) => {
      nextState.fixtures.discord.inviteTargetJobFetches ||= [];
      nextState.fixtures.discord.inviteTargetJobFetches.push({
        authorization: headerValue(init.headers, "Authorization"),
        code: inviteJobMatch[1],
      });
    });
    return response(JSON.stringify({ status }), {
      headers: { "content-type": "application/json" },
    });
  }

  // The bot's own user, as the root token's holder sees it.
  if (url.hostname === "discord.com" && url.pathname === "/api/v10/users/@me" && method === "GET") {
    return response(JSON.stringify({ id: "fixture-bot-user-id", username: "fixture-bot", bot: true }), {
      headers: { "content-type": "application/json" },
    });
  }

  const webhookRoute = routeWebhooks(url, method, init);
  if (webhookRoute) return webhookRoute;

  const historyRoute = routeChannelHistory(url, method, init);
  if (historyRoute) return historyRoute;

  const listMessagesMatch = /^\/api\/v10\/channels\/([^/]+)\/messages$/.exec(url.pathname);
  if (url.hostname === "discord.com" && listMessagesMatch && method === "GET") {
    const limit = Number(url.searchParams.get("limit") || "20");
    const before = url.searchParams.get("before");
    const state = readState();
    updateState((nextState) => {
      nextState.fixtures.discord.fetches ||= [];
      nextState.fixtures.discord.fetches.push({
        authorization: headerValue(init.headers, "Authorization"),
        channelId: listMessagesMatch[1],
        limit,
        ...(before ? { before } : {}),
      });
    });
    if (!Number.isInteger(limit) || limit < 1) {
      return response(JSON.stringify({ message: `Invalid message limit: ${url.searchParams.get("limit")}` }), {
        headers: { "content-type": "application/json" },
        status: 400,
      });
    }
    // Like Discord, created reminders stay in channel history, and a history
    // read never returns the create-time nonce.
    const sent = createdReminders(state, listMessagesMatch[1]);
    const messages = [...sent, ...(state.fixtures?.discord?.restMessages ?? [])];
    const beforeIndex = before ? messages.findIndex((message) => message.id === before) : -1;
    const page = beforeIndex >= 0 ? messages.slice(beforeIndex + 1) : messages;
    return response(JSON.stringify(page.slice(0, limit)), {
      headers: { "content-type": "application/json" },
    });
  }

  const createMessageMatch = /^\/api\/v10\/channels\/([^/]+)\/messages$/.exec(url.pathname);
  if (url.hostname === "discord.com" && createMessageMatch && method === "POST") {
    const parsedBody = init.body ? JSON.parse(String(init.body)) : {};
    if (parsedBody.enforce_nonce && (!parsedBody.nonce || typeof parsedBody.nonce !== "string")) {
      return response(JSON.stringify({ message: "nonce required" }), { status: 400 });
    }
    let created;
    let crashAfterAccept = false;
    let crashAfterResponseParsed = false;
    updateState((state) => {
      state.fixtures.discord.messages ||= [];
      state.fixtures.discord.reminderRequests ||= [];
      if (parsedBody.content === "👀") state.fixtures.discord.reminderRequests.push({ method: "POST" });
      // Like Discord, enforce_nonce returns the same author's earlier message
      // only within a few minutes of its creation; afterwards it creates anew.
      const now = Date.parse(process.env.CCDM_REMINDER_CLOCK_FILE
        ? fs.readFileSync(process.env.CCDM_REMINDER_CLOCK_FILE, "utf8").trim() : new Date().toISOString());
      created = parsedBody.enforce_nonce && state.fixtures.discord.messages.find(entry =>
        entry.channelId === createMessageMatch[1] && entry.requestBody?.nonce === parsedBody.nonce &&
        entry.authorization === headerValue(init.headers, "Authorization") &&
        now - Date.parse(entry.timestamp) <= 3 * 60000);
      if (created) return;
      created = {
        authorization: headerValue(init.headers, "Authorization"),
        channelId: createMessageMatch[1],
        content: parsedBody.content ?? "",
        id: `fake-message-${state.fixtures.discord.messages.length + 1}`,
        messageReference: parsedBody.message_reference,
        ...(parsedBody.enforce_nonce ? {
          requestBody: parsedBody,
          timestamp: process.env.CCDM_REMINDER_CLOCK_FILE
            ? fs.readFileSync(process.env.CCDM_REMINDER_CLOCK_FILE, "utf8").trim()
            : new Date().toISOString(),
        } : {}),
      };
      state.fixtures.discord.messages.push(created);
      if (parsedBody.content === "👀" && state.fixtures.discord.crashAfterReminderAccept) {
        crashAfterAccept = true;
        state.fixtures.discord.crashAfterReminderAccept = false;
      }
      if (parsedBody.content === "👀" && state.fixtures.discord.crashAfterReminderResponseParsed) {
        crashAfterResponseParsed = true;
        state.fixtures.discord.crashAfterReminderResponseParsed = false;
      }
    });
    if (crashAfterAccept) process.exit(86);
    // Discord accepted the reminder, then the gateway failed the response.
    let acceptedFailure = null;
    if (parsedBody.content === "👀") {
      updateState((state) => {
        acceptedFailure = state.fixtures.discord.restAcceptedFailures?.shift() ?? null;
      });
    }
    if (acceptedFailure) {
      return response(JSON.stringify({ message: `status ${acceptedFailure.status}` }), {
        headers: { "content-type": "application/json" }, status: acceptedFailure.status,
      });
    }
    const sentResponse = response(JSON.stringify({ id: created.id, content: created.content, timestamp: created.timestamp }), {
      headers: { "content-type": "application/json" },
    });
    if (crashAfterResponseParsed) {
      const parse = sentResponse.json.bind(sentResponse);
      sentResponse.json = async () => {
        await parse();
        process.exit(86);
      };
    }
    return sentResponse;
  }

  const getMessageMatch = /^\/api\/v10\/channels\/([^/]+)\/messages\/([^/]+)$/.exec(url.pathname);
  if (url.hostname === "discord.com" && getMessageMatch && method === "DELETE") {
    let exists = false;
    let crashAfterDelete = false;
    updateState((state) => {
      state.fixtures.discord.deletes ||= [];
      state.fixtures.discord.reminderRequests ||= [];
      state.fixtures.discord.deletes.push({ authorization: headerValue(init.headers, "Authorization"),
        channelId: getMessageMatch[1], messageId: getMessageMatch[2] });
      state.fixtures.discord.reminderRequests.push({ method: "DELETE", messageId: getMessageMatch[2] });
      const message = state.fixtures.discord.messages?.find(entry => entry.id === getMessageMatch[2]);
      exists = Boolean(message && !message.deleted);
      if (exists) message.deleted = true;
      if (exists && state.fixtures.discord.crashAfterReminderDelete) {
        crashAfterDelete = true;
        state.fixtures.discord.crashAfterReminderDelete = false;
      }
    });
    if (crashAfterDelete) process.exit(86);
    return exists ? response("", { status: 204 }) :
      response(JSON.stringify({ message: "Unknown Message" }), { status: 404 });
  }
  if (url.hostname === "discord.com" && getMessageMatch && method === "GET") {
    const state = readState();
    updateState((nextState) => {
      nextState.fixtures.discord.messageFetches ||= [];
      nextState.fixtures.discord.messageFetches.push({
        authorization: headerValue(init.headers, "Authorization"),
        channelId: getMessageMatch[1],
        messageId: getMessageMatch[2],
      });
    });
    // Messages the fake knows the channel of: sent through it, seeded, or injected.
    const known = channelMessage(state, getMessageMatch[2]);
    if (known) {
      return response(JSON.stringify(known.channel_id === getMessageMatch[1] ? known : { code: 10008, message: "Unknown Message" }), {
        headers: { "content-type": "application/json" },
        status: known.channel_id === getMessageMatch[1] ? 200 : 404,
      });
    }
    const message = (state.fixtures?.discord?.restMessages ?? []).find((entry) => entry.id === getMessageMatch[2]);
    if (!message) {
      return response(JSON.stringify({ message: "Unknown Message" }), {
        headers: { "content-type": "application/json" },
        status: 404,
      });
    }
    return response(JSON.stringify(message), {
      headers: { "content-type": "application/json" },
    });
  }

  const editMessageMatch = /^\/api\/v10\/channels\/([^/]+)\/messages\/([^/]+)$/.exec(url.pathname);
  if (url.hostname === "discord.com" && editMessageMatch && method === "PATCH") {
    const parsedBody = init.body ? JSON.parse(String(init.body)) : {};
    updateState((state) => {
      state.fixtures.discord.edits ||= [];
      state.fixtures.discord.edits.push({
        authorization: headerValue(init.headers, "Authorization"),
        channelId: editMessageMatch[1],
        content: parsedBody.content ?? "",
        messageId: editMessageMatch[2],
      });
    });
    return response(JSON.stringify({ id: editMessageMatch[2], content: parsedBody.content ?? "" }), {
      headers: { "content-type": "application/json" },
    });
  }

  const reactionMatch = /^\/api\/v10\/channels\/([^/]+)\/messages\/([^/]+)\/reactions\/([^/]+)\/@me$/.exec(url.pathname);
  if (url.hostname === "discord.com" && reactionMatch && method === "PUT") {
    updateState((state) => {
      state.fixtures.discord.reactions ||= [];
      state.fixtures.discord.reactions.push({
        authorization: headerValue(init.headers, "Authorization"),
        channelId: reactionMatch[1],
        emoji: reactionMatch[3],
        messageId: reactionMatch[2],
      });
    });
    return response("", { status: 204 });
  }
  if (url.hostname === "discord.com" && reactionMatch && method === "DELETE") {
    updateState((state) => {
      state.fixtures.discord.reactionDeletes ||= [];
      state.fixtures.discord.reactionDeletes.push({
        authorization: headerValue(init.headers, "Authorization"),
        channelId: reactionMatch[1],
        emoji: reactionMatch[3],
        messageId: reactionMatch[2],
      });
    });
    return response("", { status: 204 });
  }

  const typingMatch = /^\/api\/v10\/channels\/([^/]+)\/typing$/.exec(url.pathname);
  if (url.hostname === "discord.com" && typingMatch && method === "POST") {
    updateState((state) => {
      state.fixtures.discord.typing ||= [];
      state.fixtures.discord.typing.push({ authorization: headerValue(init.headers, "Authorization"), channelId: typingMatch[1] });
    });
    return response("", { status: 204 });
  }

  const nicknameMatch = /^\/api\/v10\/guilds\/([^/]+)\/members\/([^/]+)$/.exec(url.pathname);
  if (url.hostname === "discord.com" && nicknameMatch && method === "PATCH") {
    const parsedBody = init.body ? JSON.parse(String(init.body)) : {};
    updateState((state) => {
      state.fixtures.discord.nicknamePatches ||= [];
      state.fixtures.discord.nicknamePatches.push({
        appId: nicknameMatch[2],
        authorization: headerValue(init.headers, "Authorization"),
        guildId: nicknameMatch[1],
        nick: parsedBody.nick,
      });
    });
    return response(JSON.stringify({ nick: parsedBody.nick }), {
      headers: { "content-type": "application/json" },
    });
  }

  if (url.hostname === "discord.com") {
    updateState((state) => {
      state.fixtures.discord.malformedRequests ||= [];
      state.fixtures.discord.malformedRequests.push({ method, url: url.href });
    });
    return response(JSON.stringify({ message: "Unhandled fake Discord route" }), {
      headers: { "content-type": "application/json" },
      status: 400,
    });
  }

  return null;
}

function routeDiscordCdn(url) {
  if (!["cdn.discordapp.com", "media.discordapp.net"].includes(url.hostname)) return null;
  const state = readState();
  const attachment = state.fixtures?.discord?.attachments?.[url.href];
  updateState((nextState) => {
    nextState.fixtures.discord.attachmentFetches ||= [];
    nextState.fixtures.discord.attachmentFetches.push({ url: url.href });
  });
  if (!attachment) {
    return response("missing fake attachment", { status: 404 });
  }
  return response(attachment.body ?? "", {
    headers: { "content-type": attachment.contentType ?? "text/plain" },
    status: attachment.status ?? 200,
  });
}

async function guardedFetch(input, init = {}) {
  const url = new URL(typeof input === "string" ? input : input.url);
  if ((init.method || "GET").toUpperCase() === "POST" && url.hostname === "discord.com" &&
      /^\/api\/v10\/channels\/[^/]+\/messages$/.test(url.pathname) &&
      readState().fixtures?.discord?.restConnectFailures > 0) {
    // The connection is refused before any request reaches Discord.
    updateState(state => {
      state.fixtures.discord.restConnectFailures -= 1;
      state.fixtures.discord.connectFailureUses = (state.fixtures.discord.connectFailureUses || 0) + 1;
    });
    const cause = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    throw Object.assign(new TypeError("fetch failed"), { cause });
  }
  const routed = routeDiscordApi(url, init) ?? routeDiscordCdn(url, init);
  if (routed) {
    if ((init.method || "GET").toUpperCase() === "POST" &&
        /^\/api\/v10\/channels\/[^/]+\/messages$/.test(url.pathname) &&
        readState().fixtures?.discord?.restLoseResponse) {
      updateState(state => {
        // true loses one response; a number loses that many consecutive responses.
        const remaining = Number(state.fixtures.discord.restLoseResponse) - 1;
        state.fixtures.discord.restLoseResponse = remaining > 0 ? remaining : false;
        state.fixtures.discord.lostResponseUses = (state.fixtures.discord.lostResponseUses || 0) + 1;
      });
      throw new Error("Local Fake lost the accepted Discord response");
    }
    const delay = readState().fixtures?.discord?.restResponseDelayMs || 0;
    if (delay && (init.method || "GET").toUpperCase() === "POST" &&
        /^\/api\/v10\/channels\/[^/]+\/messages$/.test(url.pathname)) {
      updateState(state => { state.fixtures.discord.responsePending = true; });
      await new Promise(resolve => setTimeout(resolve, delay));
      updateState(state => { state.fixtures.discord.responsePending = false; });
    }
    return routed;
  }
  recordBlocked("fetch", url.href);
  throw new Error(`Blocked unexpected fetch egress: ${url.href}`);
}

function requestTarget(args) {
  const first = args[0];
  if (typeof first === "string" || first instanceof URL) {
    const url = new URL(first);
    return {
      display: url.href,
      headers: args[1]?.headers ?? {},
      host: url.hostname,
      method: args[1]?.method || "GET",
      port: String(url.port || (url.protocol === "https:" ? 443 : 80)),
    };
  }
  const options = first ?? {};
  return {
    display: JSON.stringify(options),
    headers: options.headers ?? {},
    host: options.host || options.hostname || "localhost",
    method: options.method || "GET",
    port: String(options.port || options.defaultPort || ""),
  };
}

function isAllowedWebSocketUpgrade(target) {
  const upgrade = target.headers.Upgrade ?? target.headers.upgrade;
  const local = ["127.0.0.1", "localhost", "::1", ""].includes(String(target.host));
  return local && target.port === String(process.env.WS_PORT || "") && String(upgrade).toLowerCase() === "websocket";
}

function blockRequest(kind, original) {
  return function blockedRequest(...args) {
    const target = requestTarget(args);
    if (kind === "http" && isAllowedWebSocketUpgrade(target)) {
      return original(...args);
    }
    recordBlocked(kind, target.display);
    throw new Error(`Blocked unexpected ${kind} egress: ${target.display}`);
  };
}

function hostFromNetArgs(args) {
  const first = args[0];
  if (typeof first === "object" && first !== null) {
    return { host: first.host || first.hostname || "localhost", port: String(first.port || "") };
  }
  if (typeof first === "number") {
    return { host: args[1] || "localhost", port: String(first) };
  }
  return { host: "localhost", port: "" };
}

// Unix-socket path of a net.connect call, or null for TCP.
function unixPathFromNetArgs(args) {
  const first = args[0];
  if (typeof first === "string" && !/^\d+$/.test(first)) return first;
  if (typeof first === "object" && first !== null && typeof first.path === "string") return first.path;
  return null;
}

// Local sockets such as the Router's are allowed only inside the Test Workspace.
function isWorkspaceSocket(socketPath) {
  if (!socketPath || !stateDir) return false;
  const workspaceRoot = path.dirname(path.resolve(stateDir));
  return path.resolve(socketPath).startsWith(`${workspaceRoot}${path.sep}`);
}

function installNetGuard() {
  const originalConnect = net.connect.bind(net);
  const originalCreateConnection = net.createConnection.bind(net);
  function guardedConnect(...args) {
    const socketPath = unixPathFromNetArgs(args);
    if (socketPath !== null) {
      if (isWorkspaceSocket(socketPath)) return originalConnect(...args);
      recordBlocked("net", `unix:${socketPath}`);
      throw new Error(`Blocked unexpected net egress: unix:${socketPath}`);
    }
    const { host, port } = hostFromNetArgs(args);
    const allowedPort = String(process.env.WS_PORT || "");
    const isLocal = ["127.0.0.1", "localhost", "::1", ""].includes(String(host));
    if (allowedPort && isLocal && port === allowedPort) {
      return originalConnect(...args);
    }
    const target = `${host}:${port}`;
    recordBlocked("net", target);
    throw new Error(`Blocked unexpected net egress: ${target}`);
  }
  net.connect = guardedConnect;
  net.createConnection = function guardedCreateConnection(...args) {
    const socketPath = unixPathFromNetArgs(args);
    if (socketPath !== null && isWorkspaceSocket(socketPath)) return originalCreateConnection(...args);
    const { host, port } = hostFromNetArgs(args);
    const allowedPort = String(process.env.WS_PORT || "");
    const isLocal = ["127.0.0.1", "localhost", "::1", ""].includes(String(host));
    if (allowedPort && isLocal && port === allowedPort) {
      return originalCreateConnection(...args);
    }
    return guardedConnect(...args);
  };
}

function installFormDataShim() {
  const repoNodeModules = path.join(process.cwd(), "node_modules", "form-data");
  const shimPath = path.join(__dirname, "form-data-shim.cjs");
  try {
    fs.mkdirSync(repoNodeModules, { recursive: true });
    fs.writeFileSync(
      path.join(repoNodeModules, "package.json"),
      `${JSON.stringify({ name: "form-data", main: "index.cjs" }, null, 2)}\n`,
    );
    fs.writeFileSync(path.join(repoNodeModules, "index.cjs"), `module.exports = require(${JSON.stringify(shimPath)});\n`);
  } catch (error) {
    recordBlocked("form-data-shim-install", error.message);
    throw error;
  }
}

function install() {
  if (process.env.CCDM_TEST_FORM_DATA_SHIM === "1") {
    installFormDataShim();
  }
  globalThis.fetch = guardedFetch;
  if (process.env.CCDM_TEST_ACCELERATE_TYPING === "1") {
    globalThis.setInterval = (callback, delay, ...args) =>
      originalSetInterval(callback, delay === 8000 ? 50 : delay, ...args);
  }
  http.request = blockRequest("http", originalHttpRequest);
  http.get = blockRequest("http", originalHttpGet);
  https.request = blockRequest("https", originalHttpsRequest);
  https.get = blockRequest("https", originalHttpsGet);
  installNetGuard();
}

install();

module.exports = {
  guardedFetch,
  install,
};
