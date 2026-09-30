// Discord transport seam for the Codex bridge.
//
// The bridge core never touches discord.js or a Discord token. It consumes one
// transport object with this surface, served by the local Router, so steering,
// pause, bootstrap, voice, attachment, and reaction logic stay independent of
// how Discord is reached.
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
//         message: { id, content, channel: { id, name }, author: { id } | null,
//                    webhookId: string | null, fromBot: boolean },
//       }>,
//     }
//
// Operations out:
//   connect()                     -> Promise<{ userTag }> once the gateway is ready
//   isOwnMessage(message)         -> Promise<boolean>, whether this session
//                                    posted it (reaction forwarding): the
//                                    project's webhook, or for root the bot
//   fetchChannel(channelId)       -> Promise<{ id, name } | null>
//   send(channelId, chunks)       -> Promise<[{ id }] | undefined>, one message per chunk
//   sendTyping(channelId)         -> Promise<void>
//   react(message, emoji)         -> Promise<void>, message from onMessage
//   removeOwnReaction(message, emoji) -> Promise<void>
//   attachmentUrl(message, attachment) -> Promise<string>, a URL to fetch it from
//   setContextPct(pct)            -> records the context percentage replies carry
//   destroy()
//
// createRouterTransport: the local Router, reached with the launch key read
// from its private file; it holds no Discord credential.

const { renameSync, writeFileSync } = require("fs");
const { readFile } = require("fs/promises");
const path = require("path");
const { RouterClient } = require("./router/client.js");
const { createEmergencyGateway } = require("./router/emergency.js");

// Router events carry plain fields; the bridge sees them in its message and
// reaction shapes. A management command arrives as its plain `/command` text.
// In the root role the transport is the Router's root client: it receives
// root-channel messages and the owner's project-channel mentions, and may act
// in any root or registered channel. If the Router stays unreachable past the
// fallback threshold, root hears its own channels through an emergency direct
// gateway until the Router is back (router/emergency.js), which also carries
// its sends, typing, and reactions; its notice goes to `primaryChannelId`, and
// its engagement is recorded in the launch directory for the scoped MCP server.
function createRouterTransport({ project, role = "project", keyFile, launchDir, registryPath, primaryChannelId }) {
  let router = null;
  // Router operations, or root's direct ones while its fallback is engaged.
  let request = null;
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
            author: event.message_author_id ? { id: event.message_author_id } : null,
            webhookId: event.message_webhook_id || null,
            fromBot: event.message_from_bot === true,
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
          primaryChannelId, markerFile: path.join(launchDir, "emergency.json"),
          onMessage: (event) => messageHandler?.(toMessage(event)), log: (line) => console.error(line),
        });
        router = new RouterClient({ key, role: "root", beforeHello: () => fallback.release() });
        fallback.watch(router);
        request = fallback.request(router);
      } else {
        router = new RouterClient({ project, key, role: "project" });
        request = (op, args) => router.request(op, args);
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

    // Root replies post as the root bot, which the Router marks on the
    // reaction. Project replies post through the project's webhook, not as a
    // bot user, so its own messages are those of the webhook the registry
    // records now.
    async isOwnMessage(message) {
      if (root) return !message.webhookId && message.fromBot === true;
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
        const result = await request("reply", { channel_id: channelId, text: chunk, context_pct: contextPct });
        sent.push(...result.message_ids.map((id) => ({ id })));
      }
      return sent;
    },

    async sendTyping(channelId) {
      await request("typing", { channel_id: channelId });
    },

    async react(message, emoji) {
      await request("react", { channel_id: message.channel.id, message_id: message.id, emoji });
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

    // Removes the bot's own reaction through the Router's `react` with `remove`.
    async removeOwnReaction(message, emoji) {
      await request("react", { channel_id: message.channel.id, message_id: message.id, emoji, remove: true });
    },

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

module.exports = { createRouterTransport };
