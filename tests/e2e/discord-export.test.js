import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { bridgeChildEnv } from "./support/bridge.js";
import { createWorkspace, runNodeEntrypoint } from "./support/runner.js";
import { readState, writeState } from "./support/state.js";
import { cleanup } from "./support/teardown.js";

test.afterEach(cleanup);

// The export tool reads only the root token from root's Discord state directory.
function seedRootState(workspace, dir = path.join(workspace.homeDir, ".claude", "channels", "discord"), token = "root-token") {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, ".env"), `DISCORD_BOT_TOKEN=${token}\n`, { mode: 0o600 });
  return dir;
}

test("exports an inclusive Discord message range and downloads attachments", async () => {
  const workspace = createWorkspace();
  const state = readState(workspace.stateDir);
  state.fixtures.discord.restMessages = [
    { id: "103", timestamp: "2026-07-13T10:02:00.000Z", content: "end", author: { id: "2", username: "Bob" }, attachments: [] },
    { id: "102", timestamp: "2026-07-13T10:01:00.000Z", content: "middle", author: { id: "1", username: "Alice" }, attachments: [{ id: "a1", filename: "notes.txt", url: "https://cdn.discordapp.com/a1" }] },
    { id: "101", timestamp: "2026-07-13T10:00:00.000Z", content: "start", author: { id: "1", username: "Alice" }, attachments: [] },
  ];
  state.fixtures.discord.attachments["https://cdn.discordapp.com/a1"] = { body: "attachment body" };
  writeState(state, workspace.stateDir);
  seedRootState(workspace);

  const result = await runNodeEntrypoint(workspace, "scripts/export-discord-range.js", {
    args: ["100", "101", "103"],
    env: bridgeChildEnv(workspace),
  });

  assert.equal(result.exitCode, 0, result.stderr);
  const output = result.stdout.trim();
  const text = fs.readFileSync(output, "utf8");
  assert.ok(text.indexOf("start") < text.indexOf("middle"));
  assert.ok(text.indexOf("middle") < text.indexOf("end"));
  assert.match(text, /Message ID: 101/);
  assert.match(text, /Message ID: 103/);
  const attachment = text.match(/^Saved: (.+)$/m)?.[1];
  assert.equal(fs.readFileSync(attachment, "utf8"), "attachment body");
  assert.equal(path.dirname(path.dirname(attachment)), path.dirname(output));
  assert.deepEqual(
    [...new Set(readState(workspace.stateDir).fixtures.discord.messageFetches.map(({ authorization }) => authorization))],
    ["Bot root-token"],
  );
});

test("exports from a start message through the latest message using an explicitly selected root state directory", async () => {
  const workspace = createWorkspace();
  const state = readState(workspace.stateDir);
  state.fixtures.discord.restMessages = [
    { id: "103", timestamp: "2026-07-13T10:02:00.000Z", content: "latest", author: { id: "2", username: "Bob" }, attachments: [] },
    { id: "102", timestamp: "2026-07-13T10:01:00.000Z", content: "start", author: { id: "1", username: "Alice" }, attachments: [] },
    { id: "101", timestamp: "2026-07-13T10:00:00.000Z", content: "older", author: { id: "1", username: "Alice" }, attachments: [] },
  ];
  writeState(state, workspace.stateDir);
  const rootStateDir = seedRootState(workspace, path.join(workspace.homeDir, "custom root"), "custom-root-token");

  const result = await runNodeEntrypoint(workspace, "scripts/export-discord-range.js", {
    args: ["100", "102"],
    env: bridgeChildEnv(workspace, { ROOT_DISCORD_STATE_DIR: rootStateDir }),
  });

  assert.equal(result.exitCode, 0, result.stderr);
  const text = fs.readFileSync(result.stdout.trim(), "utf8");
  assert.match(text, /Message ID: 102/);
  assert.match(text, /Message ID: 103/);
  assert.doesNotMatch(text, /Message ID: 101/);
  assert.equal(readState(workspace.stateDir).fixtures.discord.messageFetches[0].authorization, "Bot custom-root-token");
});

test("paginates ranges larger than Discord's 100-message page limit", async () => {
  const workspace = createWorkspace();
  const state = readState(workspace.stateDir);
  state.fixtures.discord.restMessages = Array.from({ length: 205 }, (_, index) => {
    const id = String(1204 - index);
    return {
      id,
      timestamp: "2026-07-13T10:00:00.000Z",
      content: `message ${id}`,
      author: { id: "1", username: "Alice" },
      attachments: [],
    };
  });
  writeState(state, workspace.stateDir);
  seedRootState(workspace);

  const result = await runNodeEntrypoint(workspace, "scripts/export-discord-range.js", {
    args: ["100", "1000", "1204"],
    env: bridgeChildEnv(workspace),
  });

  assert.equal(result.exitCode, 0, result.stderr);
  const text = fs.readFileSync(result.stdout.trim(), "utf8");
  assert.equal(text.match(/^Message ID:/gm)?.length, 205);
  assert.ok(text.indexOf("Message ID: 1000") < text.indexOf("Message ID: 1204"));
  assert.deepEqual(
    readState(workspace.stateDir).fixtures.discord.fetches.map(({ before }) => before),
    ["1204", "1104", "1004"],
  );
});

test("exports never fall back to a pool bot token when root credentials are missing", async () => {
  const workspace = createWorkspace();
  const poolStateDir = seedRootState(workspace, path.join(workspace.homeDir, ".claude", "channels", "discord2"), "pool-state-token");
  fs.writeFileSync(path.join(workspace.repoDir, "registry.json"), JSON.stringify({
    pool: [{ id: "bot2", token: "pool-registry-token", state_dir: poolStateDir }],
    projects: { alpha: { channel_id: "100", bot_id: "bot2" } },
  }));
  const result = await runNodeEntrypoint(workspace, "scripts/export-discord-range.js", {
    args: ["100", "101"],
    env: bridgeChildEnv(workspace, { BOT_TOKEN: "", DISCORD_BOT_TOKEN: "", DISCORD_STATE_DIR: poolStateDir }),
  });
  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /Cannot read root Discord credentials/);
  assert.doesNotMatch(result.stderr, /pool-/);
  assert.deepEqual(readState(workspace.stateDir).fixtures.discord.messageFetches, []);
});

test("an export of a link or thread name the conversation resolver cannot name exits 2 with its reason", async () => {
  const workspace = createWorkspace();
  fs.writeFileSync(path.join(workspace.repoDir, "registry.json"), JSON.stringify({
    projects: { alpha: { channel_id: "100", type: "claude" } },
  }));
  seedRootState(workspace);

  for (const channel of ["https://discord.com/channels/guild-id/1799999999999999999", "no-such-thread"]) {
    const result = await runNodeEntrypoint(workspace, "scripts/export-discord-range.js", {
      args: [channel, "101"],
      env: bridgeChildEnv(workspace),
    });
    assert.equal(result.exitCode, 2, result.stdout);
    assert.match(result.stderr, /^conversation-resolver: '.+' (links to no registered channel|is no registered channel)/);
  }
  assert.deepEqual(readState(workspace.stateDir).fixtures.discord.messageFetches, []);
});
