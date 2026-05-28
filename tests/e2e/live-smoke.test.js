import assert from "node:assert/strict";
import test from "node:test";

const REQUIRED_LIVE_SECRETS = [
  "CCDM_LIVE_DISCORD_BOT_TOKEN",
  "CCDM_LIVE_DISCORD_CHANNEL_ID",
  "CCDM_LIVE_DISCORD_USER_ID",
];

test("live smoke is gated by CCDM_LIVE_E2E and documented secrets", (t) => {
  const missingSecrets = REQUIRED_LIVE_SECRETS.filter((name) => !process.env[name]);
  if (process.env.CCDM_LIVE_E2E !== "1" || missingSecrets.length > 0) {
    t.skip(`live smoke skipped; missing gate or secrets: ${missingSecrets.join(", ") || "CCDM_LIVE_E2E"}`);
    return;
  }

  assert.equal(process.env.CCDM_LIVE_E2E, "1");
  for (const secret of REQUIRED_LIVE_SECRETS) {
    assert.ok(process.env[secret]);
  }
});
