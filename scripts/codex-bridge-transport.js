// Discord transport seam for the Codex bridge.
//
// The bridge core never touches discord.js. It consumes one transport object
// with this surface, so another mode (the Router) can implement the same
// shape without changing steering, pause, bootstrap, voice, attachment, or
// reaction logic.
//
// Events in (register before connect()):
//   onMessage(handler)   handler(message)
//     message = {
//       id, content,
//       channel: { id, name },
//       author: { id, bot, username },
//       mentionedUserIds: string[],
//       attachments: [{ name, url, contentType, size }],
//     }
//   onReaction(handler)  handler(reaction)
//     reaction = {
//       channelId,
//       user: { id, bot },
//       // Completes a possibly partial event before it is acted on.
//       load(): Promise<{
//         emoji: { id, name },
//         user: { id, bot, username, globalName },
//         message: { id, content, channel: { id, name }, author: { id } | null },
//       }>,
//     }
//
// Operations out:
//   connect()                     -> Promise<{ userTag }> once the gateway is ready
//   botUserId()                   -> this bot's user ID, for "own message" checks
//   fetchChannel(channelId)       -> Promise<{ id, name } | null>
//   send(channelId, chunks)       -> Promise<[{ id }] | undefined>, one message per chunk
//   sendTyping(channelId)         -> Promise<void>
//   react(message, emoji)         -> Promise<void>, message from onMessage
//   removeOwnReaction(message, emoji) -> Promise<void>
//   supportsNickname              -> whether setNickname(nick) can run
//   setNickname(nick)             -> Promise<void>, logs its own outcome
//   destroy()
//
// createPoolTransport is the only implementation: the project's pool bot,
// logged in with its own token through discord.js.

const { Client, GatewayIntentBits, Partials } = require("discord.js");

function createPoolTransport({ token, primaryChannelId, guildId }) {
  let client = null;
  let primaryChannel = null;
  let messageHandler = null;
  let reactionHandler = null;
  const rawMessages = new WeakMap();

  async function resolveChannel(channelId) {
    if (!channelId || !client) return primaryChannel;
    if (primaryChannel?.id === channelId) return primaryChannel;
    const cached = client.channels.cache.get(channelId);
    const channel = cached || await client.channels.fetch(channelId);
    if (channelId === primaryChannelId && !primaryChannel) primaryChannel = channel;
    return channel;
  }

  function toMessage(raw) {
    const message = {
      id: raw.id,
      content: raw.content,
      channel: { id: raw.channel.id, name: raw.channel?.name },
      author: { id: raw.author.id, bot: raw.author.bot, username: raw.author.username },
      mentionedUserIds: [...(raw.mentions?.users?.keys?.() || [])],
      attachments: [...raw.attachments.values()].map((att) => ({
        name: att.name,
        url: att.url,
        contentType: att.contentType,
        size: att.size,
      })),
    };
    rawMessages.set(message, raw);
    return message;
  }

  function toReaction(rawReaction, rawUser) {
    return {
      channelId: rawReaction.message.channelId || rawReaction.message.channel?.id,
      user: { id: rawUser.id, bot: rawUser.bot },
      async load() {
        if (rawUser.partial) await rawUser.fetch();
        if (rawReaction.partial) await rawReaction.fetch();
        if (rawReaction.message.partial) await rawReaction.message.fetch();
        const message = rawReaction.message;
        return {
          emoji: { id: rawReaction.emoji.id, name: rawReaction.emoji.name },
          user: {
            id: rawUser.id,
            bot: rawUser.bot,
            username: rawUser.username,
            globalName: rawUser.globalName,
          },
          message: {
            id: message.id,
            content: message.content,
            channel: {
              id: message.channelId || message.channel.id,
              name: message.channel?.name,
            },
            author: message.author ? { id: message.author.id } : null,
          },
        };
      },
    };
  }

  return {
    onMessage(handler) {
      messageHandler = handler;
    },

    onReaction(handler) {
      reactionHandler = handler;
    },

    connect() {
      client = new Client({
        intents: [
          GatewayIntentBits.Guilds,
          GatewayIntentBits.GuildMessages,
          GatewayIntentBits.GuildMessageReactions,
          GatewayIntentBits.MessageContent,
        ],
        partials: [Partials.Message, Partials.Reaction, Partials.User],
      });
      const ready = new Promise((resolve) => {
        client.once("ready", () => resolve({ userTag: client.user.tag }));
      });
      client.on("messageReactionAdd", (reaction, user) => reactionHandler?.(toReaction(reaction, user)));
      client.on("messageCreate", (msg) => messageHandler?.(toMessage(msg)));
      return client.login(token).then(() => ready);
    },

    botUserId() {
      return client?.user?.id;
    },

    async fetchChannel(channelId) {
      const channel = await resolveChannel(channelId);
      return channel ? { id: channel.id, name: channel.name } : null;
    },

    async send(channelId, chunks) {
      const channel = await resolveChannel(channelId);
      if (!channel) return;
      const sent = [];
      for (const chunk of chunks) {
        const message = await channel.send(chunk);
        sent.push({ id: message.id });
      }
      return sent;
    },

    async sendTyping(channelId) {
      const channel = await resolveChannel(channelId);
      if (channel) await channel.sendTyping();
    },

    async react(message, emoji) {
      await rawMessages.get(message).react(emoji);
    },

    async removeOwnReaction(message, emoji) {
      await rawMessages.get(message)?.reactions.cache.get(emoji)?.users.remove(client.user.id);
    },

    supportsNickname: Boolean(guildId && token),

    async setNickname(nick) {
      try {
        const res = await fetch(
          `https://discord.com/api/v10/guilds/${guildId}/members/@me`,
          {
            method: "PATCH",
            headers: {
              Authorization: `Bot ${token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ nick }),
          }
        );
        if (res.ok) {
          console.log(`Nickname updated: ${nick}`);
        } else {
          const body = await res.text().catch(() => "");
          console.error(
            `Nickname update failed: Discord API ${res.status}${res.statusText ? ` ${res.statusText}` : ""}${body ? `: ${body}` : ""}`
          );
        }
      } catch (err) {
        console.error(`Nickname update failed: ${err.message || err}`);
      }
    },

    destroy() {
      client?.destroy();
    },
  };
}

module.exports = { createPoolTransport };
