import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { createWorkspace, runNodeEntrypoint } from "./support/runner.js";
import { readState, seedRegistry, writeState } from "./support/state.js";
import { cleanup } from "./support/teardown.js";

const OWNER_ID = "111111111111111111";
const GUEST_ID = "222222222222222222";
const GUEST_ALLOW = "274878008384";
const VIEW_CHANNEL = "1024";

test.afterEach(async () => {
  await cleanup();
});

function buildRegistry(workspace) {
  return {
    discord_user_id: OWNER_ID,
    guild_id: "guild-id",
    max_pool_size: 50,
    project_bot_role_id: "project-bot-role-id",
    category_ids: ["category-a"],
    pool: [
      {
        id: "bot1",
        app_id: "root-app-id",
        token: "root-token",
        state_dir: path.join(workspace.homeDir, ".claude", "channels", "discord"),
        assigned_to: null,
      },
      {
        id: "bot2",
        app_id: "project-app-id",
        token: "project-token",
        state_dir: path.join(workspace.homeDir, ".claude", "channels", "discord2"),
        assigned_to: "alpha",
      },
    ],
    projects: {
      alpha: {
        path: path.join(workspace.tmpDir, "alpha"),
        bot_id: "bot2",
        screen_name: "alpha_session",
        channel_id: "channel-alpha",
        type: "claude",
      },
      beta: {
        path: path.join(workspace.tmpDir, "beta"),
        bot_id: "bot2",
        screen_name: "beta_session",
        channel_id: "channel-beta",
        type: "codex",
        ws_port: 18343,
      },
    },
  };
}

function preloadEnv(workspace) {
  return {
    NODE_OPTIONS: `--require ${path.join(workspace.repoDir, "tests/e2e/support/preload.cjs")}`,
  };
}

function readRegistry(workspace) {
  return JSON.parse(fs.readFileSync(path.join(workspace.repoDir, "registry.json"), "utf8"));
}

test("guest invite configures role-gated channel access before returning the link", async () => {
  const workspace = createWorkspace();
  seedRegistry(workspace, buildRegistry(workspace));
  const seededState = readState(workspace.stateDir);
  seededState.fixtures.discord.channels = [
    { id: "category-a", type: 4, name: "AF" },
    { id: "unregistered-child", type: 0, name: "quiz", parent_id: "category-a" },
    { id: "channel-alpha", type: 0, name: "alpha", parent_id: "category-a" },
  ];
  writeState(seededState, workspace.stateDir);

  const result = await runNodeEntrypoint(workspace, "scripts/guest-access.js", {
    args: ["invite", "alpha", GUEST_ID],
    env: preloadEnv(workspace),
  });

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Granted 222222222222222222 guest access to alpha/);
  assert.match(result.stdout, /Invite: https:\/\/discord\.gg\/fake-invite-1/);

  const registry = readRegistry(workspace);
  assert.equal(registry.projects.alpha.guest_role_id, "fake-role-1");
  assert.deepEqual(registry.projects.alpha.guest_user_ids, [GUEST_ID]);

  const access = JSON.parse(
    fs.readFileSync(path.join(workspace.homeDir, ".claude", "channels", "discord2", "access.json"), "utf8"),
  );
  assert.deepEqual(access.allowFrom, [OWNER_ID, GUEST_ID]);
  assert.deepEqual(access.groups["channel-alpha"].allowFrom, [OWNER_ID, GUEST_ID]);

  const discord = readState(workspace.stateDir).fixtures.discord;
  assert.deepEqual(discord.roleCreates, [
    {
      authorization: "Bot root-token",
      guildId: "guild-id",
      hoist: false,
      mentionable: false,
      name: "ccdm-guest-alpha",
      permissions: "0",
    },
  ]);
  assert.deepEqual(discord.permissionOverwrites, [
    {
      allow: "0",
      authorization: "Bot root-token",
      channelId: "category-a",
      deny: VIEW_CHANNEL,
      overwriteId: "fake-role-1",
      type: 0,
    },
    {
      allow: "0",
      authorization: "Bot root-token",
      channelId: "unregistered-child",
      deny: VIEW_CHANNEL,
      overwriteId: "fake-role-1",
      type: 0,
    },
    {
      allow: "0",
      authorization: "Bot root-token",
      channelId: "channel-beta",
      deny: VIEW_CHANNEL,
      overwriteId: "fake-role-1",
      type: 0,
    },
    {
      allow: GUEST_ALLOW,
      authorization: "Bot root-token",
      channelId: "channel-alpha",
      deny: "0",
      overwriteId: "fake-role-1",
      type: 0,
    },
  ]);
  assert.deepEqual(discord.memberRolePuts, [
    {
      authorization: "Bot root-token",
      guildId: "guild-id",
      roleId: "fake-role-1",
      userId: GUEST_ID,
    },
  ]);
  assert.equal(discord.invites[0].channelId, "channel-alpha");
  assert.equal(JSON.parse(discord.invites[0].fields.payload_json).role_ids[0], "fake-role-1");
  assert.equal(discord.invites[0].fields.target_users_file.name, "target_users.csv");
});

test("guest revoke removes the user from config and their project role", async () => {
  const workspace = createWorkspace();
  const registry = buildRegistry(workspace);
  registry.projects.alpha.guest_role_id = "existing-role";
  registry.projects.alpha.guest_user_ids = [GUEST_ID];
  seedRegistry(workspace, registry);

  const result = await runNodeEntrypoint(workspace, "scripts/guest-access.js", {
    args: ["revoke", "channel-alpha", GUEST_ID],
    env: preloadEnv(workspace),
  });

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Revoked 222222222222222222 guest access from alpha/);

  const updated = readRegistry(workspace);
  assert.deepEqual(updated.projects.alpha.guest_user_ids, []);
  const access = JSON.parse(
    fs.readFileSync(path.join(workspace.homeDir, ".claude", "channels", "discord2", "access.json"), "utf8"),
  );
  assert.deepEqual(access.allowFrom, [OWNER_ID]);
  assert.deepEqual(access.groups["channel-alpha"].allowFrom, [OWNER_ID]);
  assert.deepEqual(readState(workspace.stateDir).fixtures.discord.memberRoleDeletes, [
    {
      authorization: "Bot root-token",
      guildId: "guild-id",
      roleId: "existing-role",
      userId: GUEST_ID,
    },
  ]);
});
