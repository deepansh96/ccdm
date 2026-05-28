const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");

const stateDir = process.env.CCDM_TEST_STATE;
const stateFile = stateDir ? path.join(stateDir, "state.json") : null;

function readState() {
  if (!stateFile || !fs.existsSync(stateFile)) return {};
  return JSON.parse(fs.readFileSync(stateFile, "utf8"));
}

function writeState(state) {
  if (!stateDir || !stateFile) return;
  const tmp = path.join(stateDir, `.state.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  fs.renameSync(tmp, stateFile);
}

function updateState(updater) {
  const state = readState();
  state.fixtures ||= {};
  state.fixtures.discord ||= {};
  updater(state);
  writeState(state);
}

function fixtureChannel(id) {
  return {
    id,
    name: `channel-${id}`,
    async send(content) {
      const failure = readState().fixtures?.discord?.failures?.send;
      if (failure) {
        updateState((state) => {
          state.fixtures.discord.sendFailures ||= [];
          state.fixtures.discord.sendFailures.push({ channelId: id, content });
        });
        throw new Error(failure);
      }
      updateState((state) => {
        state.fixtures.discord.sends ||= [];
        state.fixtures.discord.sends.push({ channelId: id, content });
      });
      return { id: `sent-${Date.now()}`, content };
    },
    async sendTyping() {
      updateState((state) => {
        state.fixtures.discord.typing ||= [];
        state.fixtures.discord.typing.push({ channelId: id });
      });
    },
  };
}

function attachmentMap(entries = []) {
  const map = new Map();
  for (const entry of entries) {
    map.set(entry.id ?? entry.url, entry);
  }
  map.values = map.values.bind(map);
  return map;
}

function fixtureMessage(client, raw) {
  return {
    attachments: attachmentMap(raw.attachments),
    author: {
      bot: raw.author?.bot ?? false,
      id: raw.author?.id ?? "allowed-user-id",
      username: raw.author?.username ?? "Allowed User",
    },
    channel: { id: raw.channelId },
    client,
    content: raw.content ?? "",
    id: raw.id,
    reactions: {
      cache: new Map([
        [
          "⏳",
          {
            users: {
              async remove(userId) {
                updateState((state) => {
                  state.fixtures.discord.reactionRemovals ||= [];
                  state.fixtures.discord.reactionRemovals.push({ messageId: raw.id, userId });
                });
              },
            },
          },
        ],
      ]),
    },
    async react(emoji) {
      updateState((state) => {
        state.fixtures.discord.reactions ||= [];
        state.fixtures.discord.reactions.push({ emoji, messageId: raw.id });
      });
    },
  };
}

class Client extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = options;
    this.user = { id: "fixture-bot-user-id", tag: "fixture-bot#0001" };
    this._poller = null;
    this.channels = {
      cache: {
        get: (id) => {
          updateState((state) => {
            state.fixtures.discord.channelCacheGets ||= [];
            state.fixtures.discord.channelCacheGets.push({ id });
          });
          const state = readState();
          if (state.fixtures?.discord?.channelCacheMiss) return undefined;
          return fixtureChannel(id);
        },
      },
      fetch: async (id) => {
        updateState((state) => {
          state.fixtures.discord.channelFetches ||= [];
          state.fixtures.discord.channelFetches.push({ id });
        });
        const state = readState();
        const failure = state.fixtures?.discord?.failures?.channelFetch;
        if (failure) throw new Error(failure);
        if (state.fixtures?.discord?.channelFetchNull) return null;
        return fixtureChannel(id);
      },
    };
  }

  login(token) {
    updateState((state) => {
      state.fixtures.discord.logins ||= [];
      state.fixtures.discord.logins.push({ token });
    });
    const failure = readState().fixtures?.discord?.failures?.login;
    if (failure) return Promise.reject(new Error(failure));
    setTimeout(() => {
      updateState((state) => {
        state.fixtures.discord.ready ||= [];
        state.fixtures.discord.ready.push({ tag: this.user.tag });
      });
      this.emit("ready");
      this._startPolling();
    }, 5);
    return Promise.resolve(token);
  }

  destroy() {
    if (this._poller) clearInterval(this._poller);
    this._poller = null;
  }

  _startPolling() {
    if (this._poller) return;
    this._poller = setInterval(() => {
      const state = readState();
      const messages = state.fixtures?.discord?.injectedMessages ?? [];
      const next = messages.find((message) => !message.delivered);
      if (!next) return;
      next.delivered = true;
      writeState(state);
      updateState((updated) => {
        updated.fixtures.discord.deliveredMessages ||= [];
        updated.fixtures.discord.deliveredMessages.push({ id: next.id });
      });
      this.emit("messageCreate", fixtureMessage(this, next));
    }, 25);
    this._poller.unref();
  }
}

const GatewayIntentBits = {
  GuildMessages: 2,
  Guilds: 1,
  MessageContent: 4,
};

const Partials = {
  Message: "MESSAGE",
};

module.exports = {
  Client,
  GatewayIntentBits,
  Partials,
};
