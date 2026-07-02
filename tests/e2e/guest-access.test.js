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
  seededState.fixtures.discord.roles = [{ id: "stale-role", name: "ccdm-guest-alpha-channel-alpha" }];
  writeState(seededState, workspace.stateDir);

  const result = await runNodeEntrypoint(workspace, "scripts/guest-access.js", {
    args: ["invite", "alpha", GUEST_ID],
    env: preloadEnv(workspace),
  });

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Granted 222222222222222222 guest access to alpha/);
  assert.match(result.stdout, /Invite: https:\/\/discord\.gg\/fake-invite-1/);

  const registry = readRegistry(workspace);
  assert.equal(registry.projects.alpha.guest_role_id, "fake-role-2");
  assert.deepEqual(registry.projects.alpha.guest_user_ids, [GUEST_ID]);
  assert.deepEqual(registry.projects.alpha.guest_invites, { [GUEST_ID]: ["fake-invite-1"] });

  const access = JSON.parse(
    fs.readFileSync(path.join(workspace.homeDir, ".claude", "channels", "discord2", "access.json"), "utf8"),
  );
  assert.deepEqual(access.allowFrom, [OWNER_ID]);
  assert.deepEqual(access.groups["channel-alpha"].allowFrom, [OWNER_ID, GUEST_ID]);

  const discord = readState(workspace.stateDir).fixtures.discord;
  assert.deepEqual(discord.roleCreates, [
    {
      authorization: "Bot root-token",
      guildId: "guild-id",
      hoist: false,
      mentionable: false,
      name: "ccdm-guest-alpha-channel-alpha",
      permissions: "0",
    },
  ]);
  assert.deepEqual(discord.permissionOverwrites, [
    {
      allow: "0",
      authorization: "Bot root-token",
      channelId: "category-a",
      deny: VIEW_CHANNEL,
      overwriteId: "fake-role-2",
      type: 0,
    },
    {
      allow: "0",
      authorization: "Bot root-token",
      channelId: "category-a",
      deny: VIEW_CHANNEL,
      overwriteId: GUEST_ID,
      type: 1,
    },
    {
      allow: "0",
      authorization: "Bot root-token",
      channelId: "unregistered-child",
      deny: VIEW_CHANNEL,
      overwriteId: "fake-role-2",
      type: 0,
    },
    {
      allow: "0",
      authorization: "Bot root-token",
      channelId: "unregistered-child",
      deny: VIEW_CHANNEL,
      overwriteId: GUEST_ID,
      type: 1,
    },
    {
      allow: "0",
      authorization: "Bot root-token",
      channelId: "channel-beta",
      deny: VIEW_CHANNEL,
      overwriteId: "fake-role-2",
      type: 0,
    },
    {
      allow: "0",
      authorization: "Bot root-token",
      channelId: "channel-beta",
      deny: VIEW_CHANNEL,
      overwriteId: GUEST_ID,
      type: 1,
    },
    {
      allow: GUEST_ALLOW,
      authorization: "Bot root-token",
      channelId: "channel-alpha",
      deny: "0",
      overwriteId: "fake-role-2",
      type: 0,
    },
    {
      allow: GUEST_ALLOW,
      authorization: "Bot root-token",
      channelId: "channel-alpha",
      deny: "0",
      overwriteId: GUEST_ID,
      type: 1,
    },
  ]);
  assert.deepEqual(discord.memberRolePuts, [
    {
      authorization: "Bot root-token",
      guildId: "guild-id",
      roleId: "fake-role-2",
      userId: GUEST_ID,
    },
  ]);
  assert.equal(discord.invites[0].channelId, "channel-alpha");
  assert.equal(JSON.parse(discord.invites[0].fields.payload_json).role_ids[0], "fake-role-2");
  assert.equal(discord.invites[0].fields.target_users_file.name, "target_users.csv");
  assert.deepEqual(discord.inviteTargetJobFetches, [
    { authorization: "Bot root-token", code: "fake-invite-1" },
  ]);
});

test("guest revoke removes the user from config and their project role", async () => {
  const workspace = createWorkspace();
  const registry = buildRegistry(workspace);
  registry.projects.alpha.guest_role_id = "existing-role";
  registry.projects.alpha.guest_user_ids = [GUEST_ID];
  registry.projects.alpha.guest_invites = { [GUEST_ID]: ["fake-invite-1", "fake-invite-2"] };
  seedRegistry(workspace, registry);

  const result = await runNodeEntrypoint(workspace, "scripts/guest-access.js", {
    args: ["revoke", "channel-alpha", GUEST_ID],
    env: preloadEnv(workspace),
  });

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Revoked 222222222222222222 guest access from alpha/);

  const updated = readRegistry(workspace);
  assert.deepEqual(updated.projects.alpha.guest_user_ids, []);
  assert.equal(updated.projects.alpha.guest_invites, undefined);
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
  assert.deepEqual(readState(workspace.stateDir).fixtures.discord.inviteDeletes, [
    { authorization: "Bot root-token", code: "fake-invite-1" },
    { authorization: "Bot root-token", code: "fake-invite-2" },
  ]);
});

test("guest grant fails when the user is not in the guild", async () => {
  const workspace = createWorkspace();
  seedRegistry(workspace, buildRegistry(workspace));
  const state = readState(workspace.stateDir);
  state.fixtures.discord.memberRolePut404UserIds = [GUEST_ID];
  writeState(state, workspace.stateDir);

  const result = await runNodeEntrypoint(workspace, "scripts/guest-access.js", {
    args: ["grant", "alpha", GUEST_ID],
    env: preloadEnv(workspace),
  });

  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /Unknown Member/);
  assert.equal(readRegistry(workspace).projects.alpha.guest_user_ids, undefined);
  assert.equal(
    fs.existsSync(path.join(workspace.homeDir, ".claude", "channels", "discord2", "access.json")),
    false,
  );
});

test("guest invite fails closed when managed channel discovery fails", async () => {
  const workspace = createWorkspace();
  seedRegistry(workspace, buildRegistry(workspace));
  const state = readState(workspace.stateDir);
  state.fixtures.discord.channelListFailures = 1;
  writeState(state, workspace.stateDir);

  const result = await runNodeEntrypoint(workspace, "scripts/guest-access.js", {
    args: ["invite", "alpha", GUEST_ID],
    env: preloadEnv(workspace),
  });

  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /channel list failed/);
  assert.equal(readRegistry(workspace).projects.alpha.guest_user_ids, undefined);
});

test("guest revoke keeps local access when Discord cleanup fails", async () => {
  const workspace = createWorkspace();
  const registry = buildRegistry(workspace);
  registry.projects.alpha.guest_role_id = "existing-role";
  registry.projects.alpha.guest_user_ids = [GUEST_ID];
  registry.projects.alpha.guest_invites = { [GUEST_ID]: ["fake-invite-1"] };
  seedRegistry(workspace, registry);
  const state = readState(workspace.stateDir);
  state.fixtures.discord.inviteDeleteFailures = ["fake-invite-1"];
  writeState(state, workspace.stateDir);

  const result = await runNodeEntrypoint(workspace, "scripts/guest-access.js", {
    args: ["revoke", "alpha", GUEST_ID],
    env: preloadEnv(workspace),
  });

  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /delete invite failed/);
  const updated = readRegistry(workspace);
  assert.deepEqual(updated.projects.alpha.guest_user_ids, [GUEST_ID]);
  assert.deepEqual(updated.projects.alpha.guest_invites, { [GUEST_ID]: ["fake-invite-1"] });
});
