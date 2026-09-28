import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { createWorkspace, runScript } from "./support/runner.js";
import { bridgeChildEnv } from "./support/bridge.js";
import { readState, writeState } from "./support/state.js";
import { cleanup } from "./support/teardown.js";

test.afterEach(async () => cleanup());

// The pre-thread project bot integer: View Channel, Send Messages, Read
// Message History, Attach Files, Add Reactions, Send Messages in Threads.
const LEGACY_ALLOW = "274878008384";
// LEGACY_ALLOW plus Manage Threads (bit 34) and Create Public Threads (bit 35).
const THREAD_ALLOW = "326417615936";
const ROOT_AUTHORIZATION = "Bot fixture-root-token";

function setup(workspace, overwrites) {
  fs.writeFileSync(path.join(workspace.repoDir, "registry.json"), JSON.stringify({
    discord_user_id: "owner", guild_id: "guild",
    pool: [{ id: "bot-a", app_id: "app-a", token: "alpha-token" },
      { id: "bot-b", app_id: "app-b", token: "beta-token" },
      { id: "bot-c", app_id: "app-c", token: "spare-token" }],
    projects: {
      alpha: { type: "claude", path: "/work/alpha", bot_id: "bot-a", channel_id: "channel-alpha" },
      beta: { type: "codex", path: "/work/beta", bot_id: "bot-b", channel_id: "channel-beta" },
    },
  }), { mode: 0o600 });
  const rootState = path.join(workspace.homeDir, "root-discord");
  fs.mkdirSync(rootState, { recursive: true });
  fs.writeFileSync(path.join(rootState, ".env"), "DISCORD_BOT_TOKEN=fixture-root-token\n", { mode: 0o600 });
  const seed = readState(workspace.stateDir);
  seed.fixtures.discord.channels = [
    { id: "channel-alpha", type: 0, name: "alpha", permission_overwrites: overwrites.alpha },
    { id: "channel-beta", type: 0, name: "beta", permission_overwrites: overwrites.beta },
    { id: "channel-other", type: 0, name: "other", permission_overwrites: [
      { id: "app-c", type: 1, allow: LEGACY_ALLOW, deny: "0" }] },
  ];
  writeState(seed, workspace.stateDir);
  return bridgeChildEnv(workspace, { ROOT_DISCORD_STATE_DIR: rootState, CCDM_THREAD_NODE: process.execPath });
}

async function supervisor(workspace, env, args) {
  return runScript(workspace, "scripts/thread-supervisor.py", {
    args: [...args, "--state-dir", path.join(workspace.tmpDir, "thread-state")], env,
  });
}

async function grant(workspace, env, args) {
  const result = await supervisor(workspace, env, ["grant-thread-permissions", ...args]);
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function mutations(workspace) {
  const discord = readState(workspace.stateDir).fixtures.discord;
  return {
    permissionOverwrites: discord.permissionOverwrites,
    others: [discord.roleCreates, discord.memberRolePuts, discord.memberRoleDeletes, discord.nicknamePatches,
      discord.invites, discord.inviteDeletes, discord.threadPatches ?? [], discord.malformedRequests].flat(),
  };
}

test("grant-thread-permissions --all puts the thread integer on each project's own channel once", async () => {
  const workspace = createWorkspace();
  const env = setup(workspace, {
    alpha: [{ id: "app-a", type: 1, allow: LEGACY_ALLOW, deny: "0" },
      { id: "guest-role", type: 0, allow: LEGACY_ALLOW, deny: "0" }],
    beta: [],
  });

  await grant(workspace, env, ["--all"]);
  const first = mutations(workspace);
  assert.deepEqual(first.permissionOverwrites, [
    { allow: THREAD_ALLOW, authorization: ROOT_AUTHORIZATION, channelId: "channel-alpha", deny: "0",
      overwriteId: "app-a", type: 1 },
    { allow: THREAD_ALLOW, authorization: ROOT_AUTHORIZATION, channelId: "channel-beta", deny: "0",
      overwriteId: "app-b", type: 1 },
  ]);
  assert.deepEqual(first.others, []);

  await grant(workspace, env, ["--all"]);
  assert.equal(mutations(workspace).permissionOverwrites.length, 2);
});

test("--project touches only that project, and an unknown project fails before any REST call", async () => {
  const workspace = createWorkspace();
  const env = setup(workspace, {
    alpha: [{ id: "app-a", type: 1, allow: LEGACY_ALLOW, deny: "0" }],
    beta: [{ id: "app-b", type: 1, allow: LEGACY_ALLOW, deny: "0" }],
  });

  await grant(workspace, env, ["--project", "beta"]);
  assert.deepEqual(mutations(workspace).permissionOverwrites, [
    { allow: THREAD_ALLOW, authorization: ROOT_AUTHORIZATION, channelId: "channel-beta", deny: "0",
      overwriteId: "app-b", type: 1 },
  ]);

  // Any Discord request, read or write, would consume this seeded failure.
  const seed = readState(workspace.stateDir);
  seed.fixtures.discord.restFailures = [{ status: 500, body: { message: "unexpected request" } }];
  writeState(seed, workspace.stateDir);
  const unknown = await supervisor(workspace, env, ["grant-thread-permissions", "--project", "gamma"]);
  assert.equal(unknown.exitCode, 2, unknown.stdout);
  assert.match(JSON.parse(unknown.stdout).reason, /no registered project named gamma/);
  const discord = readState(workspace.stateDir).fixtures.discord;
  assert.equal(discord.restFailures.length, 1);
  assert.deepEqual(discord.restFailureUses ?? [], []);
  assert.equal(discord.permissionOverwrites.length, 1);
});

test("status lists a project whose bot lacks Manage Threads or Create Public Threads until it is granted", async () => {
  const workspace = createWorkspace();
  // Alpha already has both bits. Beta has Create Public Threads (bit 35)
  // without Manage Threads: 274878008384 + 34359738368.
  const env = setup(workspace, {
    alpha: [{ id: "app-a", type: 1, allow: THREAD_ALLOW, deny: "0" }],
    beta: [{ id: "app-b", type: 1, allow: "309237746752", deny: "0" }],
  });
  const status = async () => {
    const result = await supervisor(workspace, env, ["status"]);
    assert.equal(result.exitCode, 0, result.stderr || result.stdout);
    return JSON.parse(result.stdout).thread_permissions;
  };

  assert.deepEqual(await status(), { status: "ok", missing: ["beta"] });
  await grant(workspace, env, ["--all"]);
  assert.deepEqual(await status(), { status: "ok", missing: [] });
  assert.deepEqual(mutations(workspace).permissionOverwrites.map(row => row.channelId), ["channel-beta"]);
});
