"use strict";

// status: Router health for `router status`. Never includes webhook tokens.
const { readWebhookSecret } = require("../webhooks.js");

// What root needs in a project channel to send, read, react, and clean up.
const ROOT_PERMISSIONS = ["SendMessages", "ReadMessageHistory", "AddReactions", "ManageMessages"];

// Root's missing permissions in a channel, or null before the gateway is ready.
async function missingPermissions(ctx, channelId) {
  const client = ctx.discord?.client;
  if (!client?.user) return null;
  const channel = await client.channels.fetch(channelId).catch(() => null);
  let permissions = null;
  try {
    permissions = channel?.permissionsFor?.(client.user) ?? null;
  } catch {
    // A partially cached guild cannot resolve permissions: report them all missing.
  }
  return ROOT_PERMISSIONS.filter(flag => !permissions?.has(flag));
}

// Root's standing in one registered channel, router or pool, for `args.project`.
async function target(ctx, project) {
  const channelId = [...ctx.table.registered].find(([, name]) => name === project)?.[0];
  return channelId ? { project, channel_id: channelId, missing_permissions: await missingPermissions(ctx, channelId) } : null;
}

async function status(ctx, args = {}) {
  const projects = [];
  for (const route of ctx.table.projects.values()) {
    const secret = await readWebhookSecret(ctx.stateDir, route.project);
    projects.push({
      project: route.project,
      channel_id: route.channel_id,
      webhook: Boolean(route.webhook_id && secret?.webhook_id === route.webhook_id),
      missing_permissions: await missingPermissions(ctx, route.channel_id),
    });
  }
  return {
    gateway: ctx.gateway.state,
    registry_loaded_at: ctx.table.loadedAt,
    registry_error: ctx.registry?.error ?? null,
    sessions: ctx.sessions().map(session => ({
      role: session.role,
      project: session.route.project,
      scope: { channel_id: session.route.channel_id },
      connected_at: session.connectedAt,
    })),
    projects,
    scope_violations: ctx.violations(),
    ...(args.project === undefined ? {} : { target: await target(ctx, String(args.project)) }),
  };
}

module.exports = {
  ops: {
    status: { roles: ["status"], scoped: false, run: status },
  },
};
