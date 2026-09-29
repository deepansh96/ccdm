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
//   isOwnMessage(message)         -> Promise<boolean>, whether this session
//                                    posted it (reaction forwarding)
//   fetchChannel(channelId)       -> Promise<{ id, name } | null>
//   send(channelId, chunks)       -> Promise<[{ id }] | undefined>, one message per chunk
//   sendTyping(channelId)         -> Promise<void>
//   react(message, emoji)         -> Promise<void>, message from onMessage
//   removeOwnReaction(message, emoji) -> Promise<void>
//   attachmentUrl(message, attachment) -> Promise<string>, a URL to fetch it from
//   supportsNickname              -> whether setNickname(nick) can run
//   setNickname(nick)             -> Promise<void>, logs its own outcome
//   setContextPct(pct)            -> optional; records the context percentage
//                                    that replies carry instead of a nickname
//   destroy()
//
// createPoolTransport: the project's pool bot, logged in with its own token
// through discord.js. createRouterTransport: the local Router, reached with
// the launch key read from its private file; it holds no Discord credential.

const { Client, GatewayIntentBits, Partials } = require("discord.js");
const { renameSync, writeFileSync } = require("fs");
const { readFile } = require("fs/promises");
const path = require("path");
const { RouterClient } = require("./router/client.js");
const { createEmergencyGateway } = require("./router/emergency.js");

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

    async isOwnMessage(message) {
      return Boolean(client?.user?.id) && message.author?.id === client.user.id;
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

    async attachmentUrl(_message, attachment) {
      return attachment.url;
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

// Router events carry plain fields; the bridge sees them in its message and
// reaction shapes. A management command arrives as its plain `/command` text.
// In the root role the transport is the Router's root client: it receives
// root-channel messages and the owner's project-channel mentions, and may act
// in any root or registered channel. If the Router stays unreachable past the
// fallback threshold, root hears its own channels through an emergency direct
// gateway until the Router is back (router/emergency.js); its notice goes to
// `primaryChannelId`.
function createRouterTransport({ project, role = "project", keyFile, launchDir, registryPath, primaryChannelId }) {
  let router = null;
  let scope = null;
  let messageHandler = null;
  let reactionHandler = null;
  let contextPct;

  const root = role === "root";
  const channel = (channelId) => ({ id: channelId, name: root ? channelId : project });

  function toMessage(event, content = event.content) {
    return {
      id: event.message_id,
      content,
      channel: channel(event.channel_id),
      author: { id: event.author.id, bot: false, username: event.author.name },
      mentionedUserIds: [],
      attachments: (event.attachments || []).map((att) => ({
        id: att.id,
        name: att.name,
        url: att.url,
        contentType: att.content_type,
        size: att.size,
      })),
    };
  }

  function toReaction(event) {
    const user = { id: event.user.id, bot: false, username: event.user.name, globalName: event.user.name };
    return {
      channelId: event.channel_id,
      user: { id: user.id, bot: false },
      async load() {
        return {
          emoji: { id: null, name: event.emoji },
          user,
          message: {
            id: event.message_id,
            content: event.message_content || "",
            channel: channel(event.channel_id),
            webhookId: event.message_webhook_id || null,
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

    async connect() {
      const key = (await readFile(keyFile, "utf8")).trim();
      if (root) {
        const fallback = createEmergencyGateway({
          primaryChannelId, onMessage: (event) => messageHandler?.(toMessage(event)), log: (line) => console.error(line),
        });
        router = new RouterClient({ key, role: "root", beforeHello: () => fallback.release() });
        fallback.watch(router);
      } else {
        router = new RouterClient({ project, key, role: "project" });
      }
      router.on("message", (event) => messageHandler?.(toMessage(event)));
      router.on("command", (event) => messageHandler?.(toMessage(event, `/${event.command}`)));
      router.on("reaction", (event) => reactionHandler?.(toReaction(event)));
      router.on("disconnect", () => console.error("Router connection lost; reconnecting"));
      router.on("reconnect", () => console.log("Router connection restored"));
      router.on("end", (error) => console.error(`Router session ended${error ? `: ${error.code || error.message}` : ""}`));
      scope = await router.connect();
      return { userTag: `${root ? "root" : project} via the CCDM Router`, scope };
    },

    // Project replies post through the project's webhook, not as a bot user,
    // so its own messages are those of the webhook the registry records now.
    async isOwnMessage(message) {
      if (!message.webhookId) return false;
      try {
        const registry = JSON.parse(await readFile(registryPath, "utf8"));
        return String(registry.projects?.[project]?.webhook_id ?? "") === message.webhookId;
      } catch (err) {
        console.error(`Registry unreadable for own-message check: ${err.message || err}`);
        return false;
      }
    },

    async fetchChannel(channelId) {
      const inScope = root ? scope?.root_channels?.includes(channelId) : channelId === scope?.channel_id;
      return inScope ? channel(channelId) : null;
    },

    async send(channelId, chunks) {
      const sent = [];
      for (const chunk of chunks) {
        const result = await router.request("reply", { channel_id: channelId, text: chunk, context_pct: contextPct });
        sent.push(...result.message_ids.map((id) => ({ id })));
      }
      return sent;
    },

    async sendTyping(channelId) {
      await router.request("typing", { channel_id: channelId });
    },

    async react(message, emoji) {
      await router.request("react", { channel_id: message.channel.id, message_id: message.id, emoji });
    },

    // The Router hands back a still-valid signed URL, re-signing one that has
    // expired since delivery (a message queued while paused, say). If it
    // can't, the delivered URL is still worth trying.
    async attachmentUrl(message, attachment) {
      try {
        const resolved = await router.request("download_attachment", {
          channel_id: message.channel.id, message_id: message.id, attachment_id: attachment.id,
        });
        return resolved.url;
      } catch (err) {
        console.error(`Router download_attachment failed for ${attachment.name}: ${err.code || err.message}`);
        return attachment.url;
      }
    },

    // The Router has no reaction-removal operation.
    async removeOwnReaction() {},

    supportsNickname: false,

    async setNickname() {},

    // The bridge's scoped MCP server reads the same percentage from the launch
    // directory, so its replies carry it too.
    setContextPct(pct) {
      contextPct = pct;
      const file = path.join(launchDir, "context.json");
      const tmp = `${file}.${process.pid}.tmp`;
      try {
        writeFileSync(tmp, `${JSON.stringify({ context_pct: pct })}\n`, { mode: 0o600 });
        renameSync(tmp, file);
      } catch (err) {
        console.error(`Context percentage not recorded: ${err.message || err}`);
      }
    },

    destroy() {
      router?.close();
    },
  };
}

module.exports = { createPoolTransport, createRouterTransport };
