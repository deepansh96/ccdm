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
  const { webhook, created } = await findOrCreateWebhook(String(entry.channel_id), { project, stateDir, token });
  await keepWebhook({ project, registryFile, stateDir }, entry, webhook);
  return { webhook_id: String(webhook.id), name: webhookName(project), created };
}

// The channel's `ccdm-<project>` webhook with its token, created when the
// channel has none whose token is known.
async function findOrCreateWebhook(channelId, { project, stateDir, token }) {
  let webhook = (await discordRequest("GET", `/channels/${channelId}/webhooks`, { token }))
    .find(existing => existing.name === webhookName(project));
  if (!webhook?.token) {
    const stored = await readWebhookSecret(stateDir, project);
    if (webhook && stored?.webhook_id === webhook.id) webhook = { ...webhook, token: stored.token };
  }
  const created = !webhook?.token;
  if (created) webhook = await createWebhook(channelId, project, token);
  return { webhook, created };
}

function createWebhook(channelId, project, token) {
  return discordRequest("POST", `/channels/${channelId}/webhooks`, { token, body: { name: webhookName(project) } });
}

// The secret keeps the webhook's channel too, so a reused webhook can be
// checked against the channel the project is routed to.
async function keepWebhook({ project, registryFile, stateDir }, entry, webhook) {
  const secret = { webhook_id: String(webhook.id), token: webhook.token, channel_id: String(webhook.channel_id) };
  await writeWebhookSecret(stateDir, project, secret);
  if (entry.webhook_id !== secret.webhook_id) {
    await updateRegistry(registryFile, next => { next.projects[project].webhook_id = secret.webhook_id; });
  }
  return secret;
}

// The project's webhook id, token, and channel. A token lost while the
// registry still knows the webhook id, or a secret kept before channels were,
// is refetched through the bot and kept again.
async function projectWebhookSecret({ project, registryFile, stateDir, token }) {
  const stored = await readWebhookSecret(stateDir, project);
  const webhookId = (await readRegistry(registryFile)).projects?.[project]?.webhook_id;
  const current = stored && (!webhookId || stored.webhook_id === String(webhookId)) ? stored : null;
  if (current?.channel_id) return current;
  const id = current?.webhook_id ?? webhookId;
  if (!id) return null;
  const webhook = await discordRequest("GET", `/webhooks/${id}`, { token });
  if (!webhook?.token) return null;
  const secret = { webhook_id: String(webhook.id), token: webhook.token, channel_id: String(webhook.channel_id) };
  await writeWebhookSecret(stateDir, project, secret);
  return secret;
}

// The project's channel moved and its webhook still posts to the old one:
// the project gets its webhook in the routed channel, recorded in the
// registry and reported to the reminder service as an assignment change.
async function moveWebhook(ctx, options, channelId) {
  const { project } = options;
  const entry = (await readRegistry(ctx.registryFile)).projects?.[project];
  if (!entry) throw new OpError("webhook_missing", `no registry entry for ${project}`);
  const { webhook } = await findOrCreateWebhook(channelId, options);
  const secret = await keepWebhook(options, entry, webhook);
  ctx.log?.(`webhook_moved project=${project} channel=${channelId} webhook=${secret.webhook_id}`);
  await ctx.assignmentChanged?.(project);
  return secret;
}

// Projects whose webhook the Router recreated and that have not completed a
// webhook operation on the first attempt since: a second deletion in a row
// fails instead of recreating again.
const recreated = new Set();

// Runs `send(secret)` with the project's webhook in the session's routed
// channel. A webhook deleted in Discord is recreated once, recorded in the
// registry, reported to the reminder service as an assignment change, and the
// operation retried.
async function withProjectWebhook(ctx, send) {
  const { project, channel_id: channelId } = ctx.session.route;
  const options = { project, registryFile: ctx.registryFile, stateDir: ctx.stateDir, token: ctx.token };
  const deletedAgain = () => new OpError("webhook_deleted",
    `the ${webhookName(project)} webhook was deleted again right after it was recreated; run ensure-webhook ${project}`);
  try {
    let secret = await projectWebhookSecret(options);
    if (!secret) throw new OpError("webhook_missing", `no webhook for ${project}; run ensure-webhook`);
    if (secret.channel_id !== channelId) secret = await moveWebhook(ctx, options, channelId);
    const result = await send(secret);
    recreated.delete(project);
    return result;
  } catch (error) {
    if (!isUnknownWebhook(error)) throw error;
    if (recreated.has(project)) throw deletedAgain();
  }
  recreated.add(project);
  const entry = (await readRegistry(ctx.registryFile)).projects?.[project];
  if (!entry) throw new OpError("webhook_missing", `no registry entry for ${project}`);
  const secret = await keepWebhook(options, entry, await createWebhook(channelId, project, ctx.token));
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
