const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const net = require("node:net");
const path = require("node:path");

const originalHttpRequest = http.request.bind(http);
const originalHttpGet = http.get.bind(http);
const originalHttpsRequest = https.request.bind(https);
const originalHttpsGet = https.get.bind(https);
const originalSetInterval = globalThis.setInterval.bind(globalThis);

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
  const state = readState();
  state.fixtures ||= {};
  state.fixtures.discord ||= {};
  state.fixtures.network ||= { blocked: [] };
  updater(state);
  writeState(state);
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

// Stateful per-channel history (newest first) with Discord's before/after
// pagination and reaction membership. Kept apart from `restMessages`, which
// other scenarios use as one shared recent-history page.
function routeChannelHistory(url, method, init) {
  if (url.hostname !== "discord.com" || method !== "GET") return null;
  const listMatch = /^\/api\/v10\/channels\/([^/]+)\/messages$/.exec(url.pathname);
  const reactionMatch = /^\/api\/v10\/channels\/([^/]+)\/messages\/([^/]+)\/reactions\/([^/]+)$/.exec(url.pathname);
  const channelId = listMatch?.[1] ?? reactionMatch?.[1];
  const state = readState();
  const history = state.fixtures?.discord?.history?.[channelId];
  if (!Array.isArray(history)) return null;
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

function routeDiscordApi(url, init = {}) {
  const method = (init.method || "GET").toUpperCase();
  if (url.hostname === "discord.com") {
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
    const sent = state.fixtures?.discord?.includeSentInHistory
      ? (state.fixtures.discord.messages ?? []).filter(message => !message.deleted && message.requestBody?.nonce)
        .map(message => ({ id: message.id, channel_id: message.channelId,
          content: message.content, nonce: message.requestBody.nonce,
          author: { id: "app", bot: true }, timestamp: message.timestamp }))
        .reverse()
      : [];
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
      created = parsedBody.enforce_nonce && state.fixtures.discord.messages.find(entry =>
        entry.channelId === createMessageMatch[1] && entry.requestBody?.nonce === parsedBody.nonce);
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
    const message = (state.fixtures?.discord?.restMessages ?? []).find((entry) => entry.id === getMessageMatch[2]);
    updateState((nextState) => {
      nextState.fixtures.discord.messageFetches ||= [];
      nextState.fixtures.discord.messageFetches.push({
        authorization: headerValue(init.headers, "Authorization"),
        channelId: getMessageMatch[1],
        messageId: getMessageMatch[2],
      });
    });
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
  const routed = routeDiscordApi(url, init) ?? routeDiscordCdn(url, init);
  if (routed) {
    if ((init.method || "GET").toUpperCase() === "POST" &&
        /^\/api\/v10\/channels\/[^/]+\/messages$/.test(url.pathname) &&
        readState().fixtures?.discord?.restLoseResponse) {
      updateState(state => {
        state.fixtures.discord.restLoseResponse = false;
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

function installNetGuard() {
  const originalConnect = net.connect.bind(net);
  const originalCreateConnection = net.createConnection.bind(net);
  function guardedConnect(...args) {
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
