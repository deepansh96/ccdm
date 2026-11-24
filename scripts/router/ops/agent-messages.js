"use strict";

// Agent Message operations: project and thread roles only, listener or op-only
// connections. They take no channel_id; the acting conversation comes from the
// authenticated connection.
module.exports = {
  ops: {
    agent_request: {
      roles: ["project", "thread"],
      scoped: false,
      run: (ctx, args) => ctx.agentMessages.request(ctx, args),
    },
    agent_reply: {
      roles: ["project", "thread"],
      scoped: false,
      run: (ctx, args) => ctx.agentMessages.reply(ctx, args),
    },
    agent_message_ack: {
      roles: ["project", "thread"],
      scoped: false,
      run: (ctx, args) => ctx.agentMessages.ack(ctx, args),
    },
  },
};
