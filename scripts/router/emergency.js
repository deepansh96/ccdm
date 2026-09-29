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
const { Client, GatewayIntentBits, Partials } = require("discord.js");
const { discordRequest } = require("./discord-rest.js");
const { classifyMessage } = require("./inbound.js");
const { registryPath, rootToken } = require("./paths.js");
const { loadRoutingTable } = require("./registry.js");

const DEFAULT_FALLBACK_AFTER_MS = 120000;
const NOTICE = "⚠️ The CCDM Router is unreachable: root is answering root channels through its emergency direct connection until the Router is back.";

// The threshold, overridable by environment so tests can shorten it.
function fallbackThresholdMs(env = process.env) {
  const number = Number(env.CCDM_ROOT_FALLBACK_AFTER_MS);
  return env.CCDM_ROOT_FALLBACK_AFTER_MS && Number.isFinite(number) && number > 0 ? number : DEFAULT_FALLBACK_AFTER_MS;
}

function createEmergencyGateway({ onMessage, primaryChannelId = null, log = () => {}, env = process.env }) {
  const thresholdMs = fallbackThresholdMs(env);
  let timer = null;
  let client = null;
  // The in-flight engagement, so a release waits for a login still under way.
  let engaging = null;

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

  // Closes the direct client (if any) and cancels a pending engagement.
  async function release() {
    disarm();
    const pending = engaging;
    engaging = null;
    if (pending) await pending.catch(() => {});
    if (!client) return;
    client.destroy();
    client = null;
    log("emergency direct gateway closed; rejoining the Router");
  }

  return {
    release,
    // Arms on a lost Router connection, disarms once it is back; a session
    // that has ended for good (revoked or replaced) never falls back.
    watch(router) {
      router.on("disconnect", arm);
      router.on("reconnect", disarm);
      router.on("end", () => { release(); });
    },
  };
}

module.exports = { DEFAULT_FALLBACK_AFTER_MS, NOTICE, createEmergencyGateway, fallbackThresholdMs };
