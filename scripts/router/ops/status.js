"use strict";

// status: Router health for `router status`. Never includes webhook tokens.
const { readWebhookSecret } = require("../webhooks.js");

// What root needs in a project channel to send, read, react, clean up, and
// create or heal the project's webhook.
const ROOT_PERMISSIONS = ["SendMessages", "ReadMessageHistory", "AddReactions", "ManageMessages", "ManageWebhooks"];
// What root also needs while Thread Conversations are enabled: the three
// channel thread bits.
const THREAD_PERMISSIONS = ["CreatePublicThreads", "SendMessagesInThreads", "ManageThreads"];
// Useful but optional: the guild's View Audit Log lets the supervisor log who
// archived a thread it reopens.
const OPTIONAL_THREAD_PERMISSIONS = ["ViewAuditLog"];
// What root needs in the thread status board's channel.
const STATUS_CHANNEL_PERMISSIONS = ["ViewChannel", "SendMessages", "ReadMessageHistory"];

// How many projects' channels `status` checks at once.
const STATUS_CONCURRENCY = 8;

// Root's view of one channel: whether Discord still has it, and root's
// permissions there; `unknown` before the gateway is ready.
async function channelView(ctx, channelId) {
  const client = ctx.discord?.client;
  if (!client?.user) return { unknown: true, gone: false, permissions: null };
  let channel = null;
  try {
    channel = await client.channels.fetch(channelId);
  } catch (error) {
    // Unknown Channel: the registry names a channel Discord no longer has.
    if (error?.status === 404) return { unknown: false, gone: true, permissions: null };
  }
  let permissions = null;
  try {
    permissions = channel?.permissionsFor?.(client.user) ?? null;
  } catch {
    // A partially cached guild cannot resolve permissions: report them all missing.
  }
  return { unknown: false, gone: false, permissions };
}

// The flags root lacks in a channel view, or null when unknown.
function missingIn(view, flags) {
  return view.unknown ? null : flags.filter(flag => !view.permissions?.has(flag));
}

// Root's missing permissions in a channel, or null before the gateway is ready.
async function missingPermissions(ctx, channelId, flags = ROOT_PERMISSIONS) {
  return missingIn(await channelView(ctx, channelId), flags);
}

// `work` on every item, at most `limit` at once, results in order.
async function mapLimited(items, limit, work) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// Root's standing in one registered channel, for `args.project`.
async function target(ctx, project) {
  const channelId = [...ctx.table.registered].find(([, name]) => name === project)?.[0];
  return channelId ? { project, channel_id: channelId, missing_permissions: await missingPermissions(ctx, channelId) } : null;
}

// One channel fetch per project, several projects at once: checked one by one
// (three fetches each), fifty projects took longer than callers waited.
async function projectStatus(ctx, route) {
  const [secret, view] = await Promise.all([readWebhookSecret(ctx.stateDir, route.project),
    channelView(ctx, route.channel_id)]);
  return {
    project: route.project,
    channel_id: route.channel_id,
    // The registered channel no longer exists in Discord.
    channel_missing: view.gone,
    webhook: Boolean(route.webhook_id && secret?.webhook_id === route.webhook_id),
    missing_permissions: missingIn(view, ROOT_PERMISSIONS),
    missing_thread_permissions: missingIn(view, THREAD_PERMISSIONS),
    missing_optional_thread_permissions: missingIn(view, OPTIONAL_THREAD_PERMISSIONS),
  };
}

async function status(ctx, args = {}) {
  const projects = await mapLimited([...ctx.table.projects.values()], STATUS_CONCURRENCY,
    route => projectStatus(ctx, route));
  const statusChannelId = ctx.table.statusChannelId ?? null;
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
    // The thread status board: off when unset, and off with `error` when invalid.
    status_channel: {
      channel_id: statusChannelId,
      error: ctx.table.statusChannelError ?? null,
      missing_permissions: statusChannelId ? await missingPermissions(ctx, statusChannelId, STATUS_CHANNEL_PERMISSIONS) : null,
    },
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
