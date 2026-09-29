"use strict";

// Webhook manager. Each project channel has one `ccdm-<project>` webhook; its
// id is public registry data, its token a credential kept only here, in
// private Router state (0600).
const { mkdir, readFile, rename, rm, writeFile } = require("node:fs/promises");
const path = require("node:path");
const { DiscordError, discordRequest } = require("./discord-rest.js");
const { webhookName } = require("./identity.js");
const { OpError } = require("./ops/errors.js");
const { readRegistry, updateRegistry } = require("./registry.js");

// Discord's error code for a deleted (or never existing) webhook.
const UNKNOWN_WEBHOOK = 10015;

function isUnknownWebhook(error) {
  return error instanceof DiscordError && error.body?.code === UNKNOWN_WEBHOOK;
}

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
  if (created) webhook = await createWebhook(channelId, project, token);
  await keepWebhook({ project, registryFile, stateDir }, entry, webhook);
  return { webhook_id: String(webhook.id), name: webhookName(project), created };
}

function createWebhook(channelId, project, token) {
  return discordRequest("POST", `/channels/${channelId}/webhooks`, { token, body: { name: webhookName(project) } });
}

async function keepWebhook({ project, registryFile, stateDir }, entry, webhook) {
  const secret = { webhook_id: String(webhook.id), token: webhook.token };
  await writeWebhookSecret(stateDir, project, secret);
  if (entry.webhook_id !== secret.webhook_id) {
    await updateRegistry(registryFile, next => { next.projects[project].webhook_id = secret.webhook_id; });
  }
  return secret;
}

// The project's webhook id and token. A token lost while the registry still
// knows the webhook id is refetched through the bot and kept again.
async function projectWebhookSecret({ project, registryFile, stateDir, token }) {
  const stored = await readWebhookSecret(stateDir, project);
  const webhookId = (await readRegistry(registryFile)).projects?.[project]?.webhook_id;
  if (stored && (!webhookId || stored.webhook_id === String(webhookId))) return stored;
  if (!webhookId) return null;
  const webhook = await discordRequest("GET", `/webhooks/${webhookId}`, { token });
  if (!webhook?.token) return null;
  const secret = { webhook_id: String(webhook.id), token: webhook.token };
  await writeWebhookSecret(stateDir, project, secret);
  return secret;
}

// Projects whose webhook the Router recreated and that have not completed a
// webhook operation on the first attempt since: a second deletion in a row
// fails instead of recreating again.
const recreated = new Set();

// Runs `send(secret)` with the project's webhook. A webhook deleted in Discord
// is recreated once, recorded in the registry, reported to the reminder
// service as an assignment change, and the operation retried.
async function withProjectWebhook(ctx, send) {
  const { project } = ctx.session.route;
  const options = { project, registryFile: ctx.registryFile, stateDir: ctx.stateDir, token: ctx.token };
  const deletedAgain = () => new OpError("webhook_deleted",
    `the ${webhookName(project)} webhook was deleted again right after it was recreated; run ensure-webhook ${project}`);
  try {
    const secret = await projectWebhookSecret(options);
    if (!secret) throw new OpError("webhook_missing", `no webhook for ${project}; run ensure-webhook`);
    const result = await send(secret);
    recreated.delete(project);
    return result;
  } catch (error) {
    if (!isUnknownWebhook(error)) throw error;
    if (recreated.has(project)) throw deletedAgain();
  }
  recreated.add(project);
  const entry = (await readRegistry(ctx.registryFile)).projects?.[project];
  if (!entry?.channel_id) throw new OpError("webhook_missing", `no registry entry for ${project}`);
  const secret = await keepWebhook(options, entry, await createWebhook(String(entry.channel_id), project, ctx.token));
  ctx.log?.(`webhook_recreated project=${project} webhook=${secret.webhook_id}`);
  await ctx.assignmentChanged?.(project);
  try {
    return await send(secret);
  } catch (error) {
    throw isUnknownWebhook(error) ? deletedAgain() : error;
  }
}

// Deletes the project's webhook in Discord and its private token, and clears
// `webhook_id` from the registry. Safe to repeat.
async function deleteWebhook({ project, registryFile, stateDir, token }) {
  const entry = (await readRegistry(registryFile)).projects?.[project];
  if (!entry) throw new Error(`unknown project: ${project}`);
  const stored = await readWebhookSecret(stateDir, project);
  const ids = new Set([entry.webhook_id, stored?.webhook_id].filter(Boolean).map(String));
  if (entry.channel_id) {
    for (const webhook of await discordRequest("GET", `/channels/${entry.channel_id}/webhooks`, { token })) {
      if (webhook.name === webhookName(project)) ids.add(String(webhook.id));
    }
  }
  const deleted = [];
  for (const id of ids) {
    try {
      await discordRequest("DELETE", `/webhooks/${id}`, { token });
      deleted.push(id);
    } catch (error) {
      if (!isUnknownWebhook(error)) throw error;
    }
  }
  await rm(secretPath(stateDir, project), { force: true });
  if (entry.webhook_id !== undefined) {
    await updateRegistry(registryFile, next => { delete next.projects[project].webhook_id; });
  }
  return { name: webhookName(project), deleted };
}

module.exports = { deleteWebhook, ensureWebhook, projectWebhookSecret, readWebhookSecret, withProjectWebhook };
