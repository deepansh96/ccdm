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

// A router-only registry: no bot pool and no `transport` fields, since every
// project is served through the Router.
function buildRegistry(workspace) {
  const rootState = path.join(workspace.homeDir, ".claude", "channels", "discord");
  fs.mkdirSync(rootState, { recursive: true });
  fs.writeFileSync(path.join(rootState, ".env"), "DISCORD_BOT_TOKEN=root-token\n");
  return {
    discord_user_id: OWNER_ID,
    guild_id: "guild-id",
    // A leftover pool-era role id: guest access must never touch it.
    project_bot_role_id: "project-bot-role-id",
    category_ids: ["category-a"],
    projects: {
      alpha: {
        path: path.join(workspace.tmpDir, "alpha"),
        screen_name: "alpha_session",
        channel_id: "channel-alpha",
        type: "claude",
      },
      beta: {
        path: path.join(workspace.tmpDir, "beta"),
        screen_name: "beta_session",
        channel_id: "channel-beta",
        type: "codex",
        ws_port: 18343,
      },
    },
  };
}

function perBotAccessFiles(workspace) {
  const channels = path.join(workspace.homeDir, ".claude", "channels");
  return fs.readdirSync(channels)
    .map((dir) => path.join(channels, dir, "access.json"))
    .filter((file) => fs.existsSync(file));
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

  assert.deepEqual(perBotAccessFiles(workspace), []);

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
  assert.equal(JSON.stringify(discord).includes("project-bot-role-id"), false);
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
  assert.deepEqual(perBotAccessFiles(workspace), []);
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
  assert.equal(JSON.stringify(readState(workspace.stateDir).fixtures.discord).includes("project-bot-role-id"), false);
});

test("guest invite tolerates permission setup before the user joins the guild", async () => {
  const workspace = createWorkspace();
  seedRegistry(workspace, buildRegistry(workspace));
  const state = readState(workspace.stateDir);
  state.fixtures.discord.memberRolePut404UserIds = [GUEST_ID];
  writeState(state, workspace.stateDir);

  const result = await runNodeEntrypoint(workspace, "scripts/guest-access.js", {
    args: ["invite", "alpha", GUEST_ID],
    env: preloadEnv(workspace),
  });

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  const registry = readRegistry(workspace);
  assert.equal(registry.projects.alpha.guest_role_id, "fake-role-1");
  assert.deepEqual(registry.projects.alpha.guest_user_ids, [GUEST_ID]);
  assert.deepEqual(registry.projects.alpha.guest_invites, { [GUEST_ID]: ["fake-invite-1"] });
  const discord = readState(workspace.stateDir).fixtures.discord;
  assert.equal(discord.permissionOverwrites.some((entry) => entry.overwriteId === GUEST_ID), false);
  assert.deepEqual(discord.memberRolePuts, []);
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
  assert.deepEqual(perBotAccessFiles(workspace), []);
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

test("guest access fails before Discord writes when root credentials are missing", async () => {
  const workspace = createWorkspace();
  seedRegistry(workspace, buildRegistry(workspace));
  fs.unlinkSync(path.join(workspace.homeDir, ".claude/channels/discord/.env"));
  const result = await runNodeEntrypoint(workspace, "scripts/guest-access.js", {
    args: ["grant", "alpha", GUEST_ID], env: preloadEnv(workspace),
  });
  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /Cannot read root Discord credentials/);
  assert.deepEqual(readState(workspace.stateDir).fixtures.discord.roleCreates, []);
  assert.deepEqual(readState(workspace.stateDir).fixtures.discord.permissionOverwrites, []);
});

test("guest access reads an explicitly selected root state directory", async () => {
  const workspace = createWorkspace();
  seedRegistry(workspace, buildRegistry(workspace));
  const custom = path.join(workspace.homeDir, "custom root");
  fs.mkdirSync(custom);
  fs.writeFileSync(path.join(custom, ".env"), 'DISCORD_BOT_TOKEN="custom-root-token"\n');
  const result = await runNodeEntrypoint(workspace, "scripts/guest-access.js", {
    args: ["grant", "alpha", GUEST_ID],
    env: { ...preloadEnv(workspace), ROOT_DISCORD_STATE_DIR: custom },
  });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(readState(workspace.stateDir).fixtures.discord.roleCreates[0].authorization, "Bot custom-root-token");
});

// Two guest changes overlap: `first` pauses holding the registry lock with its
// write not yet in place, and `second` (which read the registry before that
// write landed) waits for the lock. Both changes must survive.
async function overlappingGuestChanges(first, second) {
  const workspace = createWorkspace();
  const registry = buildRegistry(workspace);
  registry.projects.alpha.guest_role_id = "existing-role";
  registry.projects.alpha.guest_user_ids = [GUEST_ID];
  registry.projects.alpha.guest_invites = { [GUEST_ID]: ["fake-invite-1"] };
  seedRegistry(workspace, registry);
  const hold = path.join(workspace.tmpDir, "registry-hold");
  const env = { ...preloadEnv(workspace), CCDM_TEST_REGISTRY_HOLD: hold };
  const run = args => runNodeEntrypoint(workspace, "scripts/guest-access.js", { args, env, timeoutMs: 20000 });
  const waitForFile = async (file) => {
    const deadline = Date.now() + 10000;
    while (!fs.existsSync(file)) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${file}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };

  fs.writeFileSync(`${hold}.armed`, "");
  const firstRun = run(first);
  await waitForFile(`${hold}.waiting`);
  const secondRun = run(second);
  await waitForFile(`${hold}.blocked`);
  fs.writeFileSync(`${hold}.release`, "");
  for (const result of await Promise.all([firstRun, secondRun])) {
    assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  }
  return readRegistry(workspace).projects.alpha;
}

test("concurrent guest grants both survive", async () => {
  const alpha = await overlappingGuestChanges(["grant", "alpha", "333333333333333333"], ["grant", "alpha", "444444444444444444"]);

  assert.deepEqual([...alpha.guest_user_ids].sort(), [GUEST_ID, "333333333333333333", "444444444444444444"]);
  assert.equal(alpha.guest_role_id, "existing-role");
});

test("an invite overlapping a revoke does not restore the revoked guest or their invites", async () => {
  const alpha = await overlappingGuestChanges(["revoke", "alpha", GUEST_ID], ["invite", "alpha", "333333333333333333"]);

  assert.deepEqual(alpha.guest_user_ids, ["333333333333333333"]);
  assert.deepEqual(Object.keys(alpha.guest_invites), ["333333333333333333"]);
});
