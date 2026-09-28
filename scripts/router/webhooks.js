"use strict";

// Webhook manager. Each project channel has one `ccdm-<project>` webhook; its
// id is public registry data, its token a credential kept only here, in
// private Router state (0600).
const { mkdir, readFile, rename, writeFile } = require("node:fs/promises");
const path = require("node:path");
const { discordRequest } = require("./discord-rest.js");
const { webhookName } = require("./identity.js");
const { readRegistry, updateRegistry } = require("./registry.js");

function secretPath(stateDir, project) {
  return path.join(stateDir, "webhooks", `${path.basename(project)}.json`);
}

async function readWebhookSecret(stateDir, project) {
  try {
    const secret = JSON.parse(await readFile(secretPath(stateDir, project), "utf8"));
    return secret?.webhook_id && secret?.token ? secret : null;
  } catch {
    return null;
  }
}

async function writeWebhookSecret(stateDir, project, secret) {
  const file = secretPath(stateDir, project);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(secret)}\n`, { mode: 0o600 });
  await rename(temporary, file);
}

// Finds or creates the project's webhook, records its id in the registry, and
// keeps the token private. Safe to repeat.
async function ensureWebhook({ project, registryFile, stateDir, token }) {
  const registry = await readRegistry(registryFile);
  const entry = registry.projects?.[project];
  if (!entry?.channel_id) throw new Error(`unknown project or missing channel_id: ${project}`);
  const channelId = String(entry.channel_id);
  const existing = (await discordRequest("GET", `/channels/${channelId}/webhooks`, { token }))
    .find(webhook => webhook.name === webhookName(project));
  let webhook = existing;
  if (!webhook?.token) {
    const stored = await readWebhookSecret(stateDir, project);
    if (webhook && stored?.webhook_id === webhook.id) webhook = { ...webhook, token: stored.token };
  }
  const created = !webhook?.token;
  if (created) {
    webhook = await discordRequest("POST", `/channels/${channelId}/webhooks`, {
      token, body: { name: webhookName(project) },
    });
  }
  await writeWebhookSecret(stateDir, project, { webhook_id: String(webhook.id), token: webhook.token });
  if (entry.webhook_id !== String(webhook.id)) {
    await updateRegistry(registryFile, next => { next.projects[project].webhook_id = String(webhook.id); });
  }
  return { webhook_id: String(webhook.id), name: webhookName(project), created };
}

module.exports = { ensureWebhook, readWebhookSecret };
