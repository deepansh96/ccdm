"use strict";

// reply: post text and files in the session's channel under its Project Identity.
const { readFile } = require("node:fs/promises");
const path = require("node:path");
const { splitMessage } = require("../chunks.js");
const { discordRequest } = require("../discord-rest.js");
const { avatarUrl, webhookUsername } = require("../identity.js");
const { readWebhookSecret } = require("../webhooks.js");
const { OpError } = require("./errors.js");
const { scopedMessage } = require("./targets.js");

const MAX_FILES = 10;

async function projectWebhook(ctx) {
  const { route } = ctx.session;
  const secret = await readWebhookSecret(ctx.stateDir, route.project);
  if (!secret) throw new OpError("webhook_missing", `no webhook for ${route.project}; run ensure-webhook`);
  return secret;
}

function validFiles(files) {
  if (files === undefined) return [];
  if (!Array.isArray(files) || files.length > MAX_FILES || !files.every(file => typeof file === "string" && path.isAbsolute(file))) {
    throw new OpError("invalid_args", `files must be at most ${MAX_FILES} absolute paths`);
  }
  return files;
}

// Files go as multipart beside payload_json, as Discord's execute expects.
async function executeBody(payload, files) {
  if (files.length === 0) return payload;
  const form = new FormData();
  form.append("payload_json", JSON.stringify(payload));
  for (const [index, file] of files.entries()) {
    let bytes;
    try {
      bytes = await readFile(file);
    } catch (error) {
      throw new OpError("invalid_args", `cannot read ${file}: ${error.code || error.message}`);
    }
    form.append(`files[${index}]`, new Blob([bytes]), path.basename(file));
  }
  return form;
}

// Webhooks can't send native replies, so the first line links to the target.
function jumpLine(ctx, messageId) {
  return `↪ [jump](https://discord.com/channels/${ctx.table.guildId}/${ctx.session.route.channel_id}/${messageId})`;
}

async function reply(ctx, args) {
  const files = validFiles(args.files);
  if (typeof args.text !== "string" || (args.text.length === 0 && files.length === 0)) {
    throw new OpError("invalid_args", "text is required");
  }
  const { route } = ctx.session;
  const secret = await projectWebhook(ctx);
  const target = args.reply_to === undefined ? null : await scopedMessage(ctx, args.reply_to);
  const text = target ? `${jumpLine(ctx, target.id)}\n${args.text}` : args.text;
  const username = webhookUsername(route.project, route.type, args.context_pct);
  // Long text becomes ordered messages; the files ride on the first one.
  const ids = [];
  for (const [index, chunk] of splitMessage(text).entries()) {
    const payload = { content: chunk, username, avatar_url: avatarUrl(route.type), allowed_mentions: { parse: [] } };
    const message = await discordRequest("POST", `/webhooks/${secret.webhook_id}/${secret.token}`, {
      query: { wait: "true" },
      body: await executeBody(payload, index === 0 ? files : []),
    });
    ids.push(message.id);
  }
  return { message_id: ids[0], message_ids: ids };
}

module.exports = {
  ops: {
    reply: { roles: ["project"], scoped: true, run: reply },
  },
};
