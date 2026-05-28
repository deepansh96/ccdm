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
        malformedRequests: [],
        nicknamePatches: [],
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

function takeRestFailure(method, url) {
  const state = readState();
  const failures = state.fixtures?.discord?.restFailures;
  if (!Array.isArray(failures) || failures.length === 0) return null;
  const [failure, ...remaining] = failures;
  updateState((nextState) => {
    nextState.fixtures.discord.restFailures = remaining;
    nextState.fixtures.discord.restFailureUses ||= [];
    nextState.fixtures.discord.restFailureUses.push({
      method,
      path: url.pathname,
      status: failure.status ?? 500,
    });
  });
  return response(JSON.stringify(failure.body ?? { message: `status ${failure.status ?? 500}` }), {
    headers: { "content-type": "application/json" },
    status: failure.status ?? 500,
  });
}

function routeDiscordApi(url, init = {}) {
  const method = (init.method || "GET").toUpperCase();
  if (url.hostname === "discord.com") {
    const failure = takeRestFailure(method, url);
    if (failure) return failure;
  }

  const listMessagesMatch = /^\/api\/v10\/channels\/([^/]+)\/messages$/.exec(url.pathname);
  if (url.hostname === "discord.com" && listMessagesMatch && method === "GET") {
    const limit = Number(url.searchParams.get("limit") || "20");
    const state = readState();
    updateState((nextState) => {
      nextState.fixtures.discord.fetches ||= [];
      nextState.fixtures.discord.fetches.push({
        authorization: headerValue(init.headers, "Authorization"),
        channelId: listMessagesMatch[1],
        limit,
      });
    });
    if (!Number.isInteger(limit) || limit < 1) {
      return response(JSON.stringify({ message: `Invalid message limit: ${url.searchParams.get("limit")}` }), {
        headers: { "content-type": "application/json" },
        status: 400,
      });
    }
    return response(JSON.stringify((state.fixtures?.discord?.restMessages ?? []).slice(0, limit)), {
      headers: { "content-type": "application/json" },
    });
  }

  const createMessageMatch = /^\/api\/v10\/channels\/([^/]+)\/messages$/.exec(url.pathname);
  if (url.hostname === "discord.com" && createMessageMatch && method === "POST") {
    const parsedBody = init.body ? JSON.parse(String(init.body)) : {};
    let created;
    updateState((state) => {
      state.fixtures.discord.messages ||= [];
      created = {
        authorization: headerValue(init.headers, "Authorization"),
        channelId: createMessageMatch[1],
        content: parsedBody.content ?? "",
        id: `fake-message-${state.fixtures.discord.messages.length + 1}`,
        messageReference: parsedBody.message_reference,
      };
      state.fixtures.discord.messages.push(created);
    });
    return response(JSON.stringify({ id: created.id, content: created.content }), {
      headers: { "content-type": "application/json" },
    });
  }

  const getMessageMatch = /^\/api\/v10\/channels\/([^/]+)\/messages\/([^/]+)$/.exec(url.pathname);
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
  if (routed) return routed;
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
