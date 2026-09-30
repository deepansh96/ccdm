"use strict";

// Root's emergency direct gateway: when root's Router connection has been
// lost for the fallback threshold (about 2 minutes by default), root logs in
// to Discord itself with the root token from root's state directory, hears
// only root channels from the owner and `root_allowed_user_ids`, and posts a
// one-line notice in its primary root channel. Once the Router is reachable
// again the direct client is closed before root's hello goes out, so the two
// paths never deliver at once.
//
//   const fallback = createEmergencyGateway({ onMessage, primaryChannelId, log });
//   const router = new RouterClient({ ..., beforeHello: () => fallback.release() });
//   fallback.watch(router);
//
// `onMessage` receives Router-shaped `message` events. Project channels are
// never heard, mentions included; project sessions just reconnect.
//
// While engaged, root can also answer: `fallback.request(router)` gives a
// requester that sends reply, react, typing, and edit_message straight to
// Discord as the bot (the Router's own root operations, limited to root
// channels and, for edits, the bot's own messages) and everything else to the
// Router. It goes back to the Router the moment the fallback is released,
// before root's hello. `markerFile`, if given, records the engagement (with
// this process's pid) for root Codex's separate MCP server, which answers the
// same way through `directRequester` while `emergencyEngaged(markerFile)`.
const { readFileSync } = require("node:fs");
const { rm, writeFile } = require("node:fs/promises");
const { Client, GatewayIntentBits, Partials } = require("discord.js");
const { discordRequest } = require("./discord-rest.js");
const { classifyMessage } = require("./inbound.js");
const { OpError } = require("./ops/errors.js");
const { OPERATIONS } = require("./ops/index.js");
const { registryPath, rootToken } = require("./paths.js");
const { loadRoutingTable } = require("./registry.js");

const DEFAULT_FALLBACK_AFTER_MS = 120000;
const NOTICE = "⚠️ The CCDM Router is unreachable: root is answering root channels through its emergency direct connection until the Router is back.";

// Root's operations that answer through the direct connection; reads and
// attachments wait for the Router.
const DIRECT_OPS = new Set(["reply", "react", "typing", "edit_message"]);

// Runs the Router's own root operation as the bot, in root channels only.
function directDispatcher({ token, botId, rootChannels }) {
  return async (op, args = {}) => {
    if (!DIRECT_OPS.has(op)) throw new OpError("router_unavailable", `${op} needs the Router`);
    const channelId = String(args.channel_id);
    if (!rootChannels.has(channelId)) {
      throw new OpError("scope_violation", "only root channels are reachable while the Router is down");
    }
    const session = { role: "root", route: { project: "root", channel_id: channelId } };
    return OPERATIONS[op].run({ token, bot: { id: botId }, session }, args);
  };
}

// Whether a live process has recorded an engaged fallback in `markerFile`.
function emergencyEngaged(markerFile) {
  try {
    const { pid } = JSON.parse(readFileSync(markerFile, "utf8"));
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// A dispatcher of its own, for a process apart from the engaged gateway.
async function directRequester() {
  const token = await rootToken();
  const table = await loadRoutingTable(registryPath());
  const bot = await discordRequest("GET", "/users/@me", { token });
  return directDispatcher({ token, botId: bot.id, rootChannels: table.rootChannels });
}

// The threshold, overridable by environment so tests can shorten it.
function fallbackThresholdMs(env = process.env) {
  const number = Number(env.CCDM_ROOT_FALLBACK_AFTER_MS);
  return env.CCDM_ROOT_FALLBACK_AFTER_MS && Number.isFinite(number) && number > 0 ? number : DEFAULT_FALLBACK_AFTER_MS;
}

function createEmergencyGateway({ onMessage, primaryChannelId = null, markerFile = null, log = () => {}, env = process.env }) {
  const thresholdMs = fallbackThresholdMs(env);
  let timer = null;
  let client = null;
  // The in-flight engagement, so a release waits for a login still under way.
  let engaging = null;
  // Root's direct operations, only while engaged.
  let dispatch = null;

  async function engage() {
    const token = await rootToken();
    // Root channels only: no project routes, so project-channel mentions reach no one.
    const table = { ...(await loadRoutingTable(registryPath())), channels: new Map() };
    const primary = primaryChannelId || [...table.rootChannels][0];
    const next = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
      partials: [Partials.Message],
    });
    next.on("messageCreate", message => {
      const routed = classifyMessage(table, message);
      if (routed?.root && table.rootChannels.has(routed.event.channel_id)) onMessage(routed.event);
    });
    const ready = new Promise(resolve => next.once("ready", resolve));
    client = next;
    await next.login(token);
    await ready;
    dispatch = directDispatcher({ token, botId: next.user.id, rootChannels: table.rootChannels });
    if (markerFile) {
      await writeFile(markerFile, `${JSON.stringify({ pid: process.pid })}\n`, { mode: 0o600 })
        .catch(error => log(`emergency marker not written: ${error.message}`));
    }
    log(`emergency direct gateway engaged after ${thresholdMs}ms without the Router`);
    if (primary) {
      await discordRequest("POST", `/channels/${primary}/messages`, { token, body: { content: NOTICE } })
        .catch(error => log(`emergency notice failed: ${error.message}`));
    }
  }

  function arm() {
    if (timer || client) return;
    timer = setTimeout(() => {
      timer = null;
      engaging = engage().catch(error => {
        log(`emergency direct gateway failed: ${error.message}`);
        release();
      });
    }, thresholdMs);
  }

  function disarm() {
    clearTimeout(timer);
    timer = null;
  }

  // Stops direct operations, closes the direct client (if any), and cancels a
  // pending engagement.
  async function release() {
    disarm();
    dispatch = null;
    const pending = engaging;
    engaging = null;
    if (pending) await pending.catch(() => {});
    // A login that finished while this release waited engaged again.
    dispatch = null;
    if (markerFile) await rm(markerFile, { force: true }).catch(() => {});
    if (!client) return;
    client.destroy();
    client = null;
    log("emergency direct gateway closed; rejoining the Router");
  }

  return {
    release,
    // Requests go to Discord directly while engaged, and to `router` otherwise.
    request(router) {
      return (op, args, options) => (dispatch ? dispatch(op, args) : router.request(op, args, options));
    },
    // Arms on a lost Router connection, disarms once it is back; a session
    // that has ended for good (revoked or replaced) never falls back.
    watch(router) {
      router.on("disconnect", arm);
      router.on("reconnect", disarm);
      router.on("end", () => { release(); });
    },
  };
}

module.exports = {
  DEFAULT_FALLBACK_AFTER_MS, NOTICE, createEmergencyGateway, directRequester, emergencyEngaged, fallbackThresholdMs,
};
