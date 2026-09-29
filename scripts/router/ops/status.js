"use strict";

// status: Router health for `router status`. Never includes webhook tokens.
const { readWebhookSecret } = require("../webhooks.js");

async function status(ctx) {
  const projects = [];
  for (const route of ctx.table.projects.values()) {
    const secret = await readWebhookSecret(ctx.stateDir, route.project);
    projects.push({
      project: route.project,
      channel_id: route.channel_id,
      webhook: Boolean(route.webhook_id && secret?.webhook_id === route.webhook_id),
    });
  }
  return {
    gateway: ctx.gateway.state,
    registry_loaded_at: ctx.table.loadedAt,
    sessions: ctx.sessions().map(session => ({
      role: session.role,
      project: session.route.project,
      scope: { channel_id: session.route.channel_id },
      connected_at: session.connectedAt,
    })),
    projects,
    scope_violations: ctx.violations(),
  };
}

module.exports = {
  ops: {
    status: { roles: ["status"], scoped: false, run: status },
  },
};
