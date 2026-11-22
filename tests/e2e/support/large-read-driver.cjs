"use strict";

// The Router's large-read op without a Router listening, for suites that only
// care where its transcript lands. Argv: channel id, message count.
const path = require("node:path");

const { ops } = require(path.join(__dirname, "..", "..", "..", "scripts", "router", "ops", "reads.js"));

const [channelId, count] = process.argv.slice(2);
const ctx = { token: "root-token", session: { route: { channel_id: channelId } } };

ops.read_last_x_messages_in_channel.run(ctx, { count: Number(count) }).then((result) => {
  process.stdout.write(JSON.stringify(result));
});
