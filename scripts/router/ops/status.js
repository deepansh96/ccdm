"use strict";

// status: Router health for `router status`. Never includes webhook tokens.
const { readWebhookSecret } = require("../webhooks.js");

// What root needs in a project channel to send, read, react, clean up, and
// create or heal the project's webhook.
const ROOT_PERMISSIONS = ["SendMessages", "ReadMessageHistory", "AddReactions", "ManageMessages", "ManageWebhooks"];
// What root also needs while Thread Conversations are enabled: the three
// channel thread bits, and the guild's View Audit Log to classify archives.
const THREAD_PERMISSIONS = ["CreatePublicThreads", "SendMessagesInThreads", "ManageThreads", "ViewAuditLog"];

// Root's missing permissions in a channel, or null before the gateway is ready.
async function missingPermissions(ctx, channelId, flags = ROOT_PERMISSIONS) {
  const client = ctx.discord?.client;
  if (!client?.user) return null;
  const channel = await client.channels.fetch(channelId).catch(() => null);
  let permissions = null;
  try {
    permissions = channel?.permissionsFor?.(client.user) ?? null;
  } catch {
    // A partially cached guild cannot resolve permissions: report them all missing.
  }
  return flags.filter(flag => !permissions?.has(flag));
}

// Root's standing in one registered channel, for `args.project`.
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
      missing_thread_permissions: await missingPermissions(ctx, route.channel_id, THREAD_PERMISSIONS),
    });
  }
  const supervisor = ctx.supervisor?.();
  return {
    gateway: ctx.gateway.state,
    registry_loaded_at: ctx.table.loadedAt,
    registry_error: ctx.registry?.error ?? null,
    sessions: ctx.sessions().map(session => ({
      role: session.role,
      project: session.route.project,
      scope: { channel_id: session.route.channel_id },
      ...(session.role === "thread" ? { thread_id: session.route.thread_id, provider: session.route.type } : {}),
      connected_at: session.connectedAt,
    })),
    supervisor: { connected: Boolean(supervisor), connected_at: supervisor?.connectedAt ?? null },
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
