"use strict";

// Round-trip check for a migration: one short notice through the project's
// webhook, and proof that Discord attributed it to that webhook.
const { discordRequest } = require("./discord-rest.js");
const { avatarUrl, webhookUsername } = require("./identity.js");
const { readRegistry } = require("./registry.js");
const { projectWebhookSecret } = require("./webhooks.js");

const PROBE_TEXT = "🔌 Connected through the CCDM Router.";

async function probe({ project, registryFile, stateDir, token }) {
  const entry = (await readRegistry(registryFile)).projects?.[project];
  if (!entry) throw new Error(`unknown project: ${project}`);
  if (!entry.webhook_id) throw new Error(`${project} has no webhook_id; run ensure-webhook ${project}`);
  const expected = String(entry.webhook_id);
  const secret = await projectWebhookSecret({ project, registryFile, stateDir, token });
  if (!secret) throw new Error(`no webhook token for ${project}; run ensure-webhook ${project}`);
  const type = entry.type === "codex" ? "codex" : "claude";
  const message = await discordRequest("POST", `/webhooks/${secret.webhook_id}/${secret.token}`, {
    query: { wait: "true" },
    body: { content: PROBE_TEXT, username: webhookUsername(project, type), avatar_url: avatarUrl(type), allowed_mentions: { parse: [] } },
  });
  const returned = message?.webhook_id ? String(message.webhook_id) : null;
  if (returned !== expected) {
    throw new Error(`probe message ${message?.id ?? "(none)"} came back with webhook_id ${returned ?? "(none)"}, expected ${expected}`);
  }
  return { message_id: String(message.id), webhook_id: returned };
}

module.exports = { probe };
