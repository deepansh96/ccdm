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

test("guest access exits 2 with the conversation resolver's reason for a target it cannot name", async () => {
  const workspace = createWorkspace();
  seedRegistry(workspace, buildRegistry(workspace));
  const before = fs.readFileSync(path.join(workspace.repoDir, "registry.json"), "utf8");

  for (const args of [["grant", "no-such-thread", GUEST_ID], ["revoke", "1799999999999999999", GUEST_ID],
    ["list", "https://discord.com/channels/guild-id/1799999999999999999"]]) {
    const result = await runNodeEntrypoint(workspace, "scripts/guest-access.js", { args, env: preloadEnv(workspace) });
    assert.equal(result.exitCode, 2, `${args.join(" ")}: ${result.stdout}`);
    assert.match(result.stderr, /^conversation-resolver: '.+' (links to no registered channel|is no registered channel)/);
  }
  assert.equal(fs.readFileSync(path.join(workspace.repoDir, "registry.json"), "utf8"), before);
  const discord = readState(workspace.stateDir).fixtures.discord;
  assert.deepEqual([discord.roleCreates ?? [], discord.permissionOverwrites ?? []], [[], []]);
});

// A registry-only project: its guests already see the channel through their
// own Discord roles, so guest access only edits `guest_user_ids` and must never
// add a role, an overwrite or a member role that would hide their other channels.
function registryOnlyRegistry(workspace) {
  const registry = buildRegistry(workspace);
  registry.projects.alpha.guest_mode = "registry-only";
  return registry;
}

function discordWrites(workspace) {
  const discord = readState(workspace.stateDir).fixtures.discord;
  return [discord.roleCreates ?? [], discord.permissionOverwrites ?? [], discord.memberRolePuts ?? [],
    discord.memberRoleDeletes ?? [], discord.invites ?? []];
}

test("a registry-only grant records the guest without touching Discord permissions", async () => {
  const workspace = createWorkspace();
  seedRegistry(workspace, registryOnlyRegistry(workspace));

  const result = await runNodeEntrypoint(workspace, "scripts/guest-access.js", {
    args: ["grant", "alpha", GUEST_ID], env: preloadEnv(workspace),
  });

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Granted 222222222222222222 registry-only guest access to alpha; Discord permissions unchanged/);
  const alpha = readRegistry(workspace).projects.alpha;
  assert.deepEqual(alpha.guest_user_ids, [GUEST_ID]);
  assert.equal(alpha.guest_role_id, undefined);
  assert.deepEqual(discordWrites(workspace), [[], [], [], [], []]);
  // The only Discord call is a read-only membership check.
  assert.deepEqual(readState(workspace.stateDir).fixtures.discord.memberGets, [{ guildId: "guild-id", userId: GUEST_ID }]);
});

test("a registry-only grant refuses a user who is not in the guild", async () => {
  const workspace = createWorkspace();
  seedRegistry(workspace, registryOnlyRegistry(workspace));
  const state = readState(workspace.stateDir);
  state.fixtures.discord.memberRolePut404UserIds = [GUEST_ID];
  writeState(state, workspace.stateDir);

  const result = await runNodeEntrypoint(workspace, "scripts/guest-access.js", {
    args: ["grant", "alpha", GUEST_ID], env: preloadEnv(workspace),
  });

  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /222222222222222222 is not a member of the guild; check the user ID/);
  assert.equal(readRegistry(workspace).projects.alpha.guest_user_ids, undefined);
  assert.deepEqual(discordWrites(workspace), [[], [], [], [], []]);
});

test("guest access refuses a user ID that is not a Discord snowflake", async () => {
  const workspace = createWorkspace();
  seedRegistry(workspace, registryOnlyRegistry(workspace));
  const before = fs.readFileSync(path.join(workspace.repoDir, "registry.json"), "utf8");

  for (const id of ["<@222222222222222222>", "alice", "2222"]) {
    for (const action of ["grant", "invite", "revoke"]) {
      const result = await runNodeEntrypoint(workspace, "scripts/guest-access.js", {
        args: [action, "alpha", id], env: preloadEnv(workspace),
      });
      assert.equal(result.exitCode, 2, `${action} ${id}`);
      assert.match(result.stderr, /is not a Discord user ID \(17-20 digits\)/);
    }
  }
  assert.equal(fs.readFileSync(path.join(workspace.repoDir, "registry.json"), "utf8"), before);
  assert.deepEqual(readState(workspace.stateDir).fixtures.discord.memberGets ?? [], []);
});

test("a registry-only invite is refused before any Discord write", async () => {
  const workspace = createWorkspace();
  seedRegistry(workspace, registryOnlyRegistry(workspace));

  const result = await runNodeEntrypoint(workspace, "scripts/guest-access.js", {
    args: ["invite", "alpha", GUEST_ID], env: preloadEnv(workspace),
  });

  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /alpha uses registry-only guests: give 222222222222222222 Discord access to the channel, then run grant/);
  assert.equal(readRegistry(workspace).projects.alpha.guest_user_ids, undefined);
  assert.deepEqual(discordWrites(workspace), [[], [], [], [], []]);
});

test("a registry-only revoke removes only the registry entry and recorded invites", async () => {
  const workspace = createWorkspace();
  const registry = registryOnlyRegistry(workspace);
  registry.projects.alpha.guest_user_ids = [GUEST_ID, "333333333333333333"];
  registry.projects.alpha.guest_invites = { [GUEST_ID]: ["fake-invite-1"] };
  seedRegistry(workspace, registry);

  const result = await runNodeEntrypoint(workspace, "scripts/guest-access.js", {
    args: ["revoke", "alpha", GUEST_ID], env: preloadEnv(workspace),
  });

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  const alpha = readRegistry(workspace).projects.alpha;
  assert.deepEqual(alpha.guest_user_ids, ["333333333333333333"]);
  assert.equal(alpha.guest_invites, undefined);
  assert.deepEqual(discordWrites(workspace), [[], [], [], [], []]);
  assert.deepEqual(readState(workspace.stateDir).fixtures.discord.inviteDeletes,
    [{ authorization: "Bot root-token", code: "fake-invite-1" }]);
});

test("a registry-only revoke takes a guest role left from managed mode off the user", async () => {
  const workspace = createWorkspace();
  const registry = registryOnlyRegistry(workspace);
  registry.projects.alpha.guest_role_id = "existing-role";
  registry.projects.alpha.guest_user_ids = [GUEST_ID];
  seedRegistry(workspace, registry);

  const result = await runNodeEntrypoint(workspace, "scripts/guest-access.js", {
    args: ["revoke", "alpha", GUEST_ID], env: preloadEnv(workspace),
  });

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.deepEqual(readRegistry(workspace).projects.alpha.guest_user_ids, []);
  const discord = readState(workspace.stateDir).fixtures.discord;
  assert.deepEqual(discord.memberRoleDeletes,
    [{ authorization: "Bot root-token", guildId: "guild-id", roleId: "existing-role", userId: GUEST_ID }]);
  assert.deepEqual([discord.roleCreates, discord.permissionOverwrites, discord.memberRolePuts], [[], [], []]);
});

test("a registry-only grant and list warn about a guest role left from managed mode", async () => {
  const workspace = createWorkspace();
  const registry = registryOnlyRegistry(workspace);
  registry.projects.alpha.guest_role_id = "existing-role";
  seedRegistry(workspace, registry);

  for (const args of [["grant", "alpha", GUEST_ID], ["list", "alpha"]]) {
    const result = await runNodeEntrypoint(workspace, "scripts/guest-access.js", { args, env: preloadEnv(workspace) });
    assert.equal(result.exitCode, 0, result.stderr || result.stdout);
    assert.match(result.stderr, /alpha still has guest role existing-role from managed mode/);
  }
});

test("a managed grant keeps a registry-only channel visible to that channel's own guests", async () => {
  const workspace = createWorkspace();
  const registry = registryOnlyRegistry(workspace);
  // GUEST_ID drives alpha as a registry-only guest and now becomes a managed guest of beta.
  registry.projects.alpha.guest_user_ids = [GUEST_ID];
  seedRegistry(workspace, registry);

  const result = await runNodeEntrypoint(workspace, "scripts/guest-access.js", {
    args: ["grant", "beta", GUEST_ID], env: preloadEnv(workspace),
  });

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  const alphaOverwrites = readState(workspace.stateDir).fixtures.discord.permissionOverwrites
    .filter((entry) => entry.channelId === "channel-alpha");
  // beta's role is still denied on alpha, but the user's own allow outranks it.
  assert.deepEqual(alphaOverwrites.map(({ overwriteId, type, allow, deny }) => ({ overwriteId, type, allow, deny })), [
    { overwriteId: "fake-role-1", type: 0, allow: "0", deny: VIEW_CHANNEL },
    { overwriteId: GUEST_ID, type: 1, allow: GUEST_ALLOW, deny: "0" },
  ]);
});

test("sync skips registry-only projects and still syncs managed ones", async () => {
  const workspace = createWorkspace();
  const registry = registryOnlyRegistry(workspace);
  registry.projects.alpha.guest_user_ids = [GUEST_ID];
  registry.projects.beta.guest_role_id = "beta-role";
  registry.projects.beta.guest_user_ids = ["333333333333333333"];
  seedRegistry(workspace, registry);

  const result = await runNodeEntrypoint(workspace, "scripts/guest-access.js", {
    args: ["sync"], env: preloadEnv(workspace),
  });

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Skipped alpha: registry-only guests keep their own Discord permissions/);
  assert.match(result.stdout, /Synced beta/);
  const updated = readRegistry(workspace);
  assert.equal(updated.projects.alpha.guest_role_id, undefined);
  const discord = readState(workspace.stateDir).fixtures.discord;
  assert.deepEqual(discord.roleCreates, []);
  assert.equal(discord.permissionOverwrites.some((entry) => entry.overwriteId === GUEST_ID), false);
  assert.ok(discord.permissionOverwrites.length > 0);
  assert.equal(discord.memberRolePuts.some((entry) => entry.userId === GUEST_ID), false);
});

test("list marks registry-only projects", async () => {
  const workspace = createWorkspace();
  const registry = registryOnlyRegistry(workspace);
  registry.projects.alpha.guest_user_ids = [GUEST_ID];
  seedRegistry(workspace, registry);

  const result = await runNodeEntrypoint(workspace, "scripts/guest-access.js", {
    args: ["list"], env: preloadEnv(workspace),
  });

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /^alpha \(registry-only\): 222222222222222222$/m);
  assert.match(result.stdout, /^beta: \(none\)$/m);
});

test("list reports an unknown guest_mode instead of failing every project", async () => {
  const workspace = createWorkspace();
  const registry = buildRegistry(workspace);
  registry.projects.alpha.guest_mode = "registry_only";
  seedRegistry(workspace, registry);

  const result = await runNodeEntrypoint(workspace, "scripts/guest-access.js", {
    args: ["list"], env: preloadEnv(workspace),
  });

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /^alpha \(invalid guest_mode "registry_only"\): \(none\)$/m);
  assert.match(result.stdout, /^beta: \(none\)$/m);
});

test("an unknown guest_mode fails before any registry or Discord write", async () => {
  const workspace = createWorkspace();
  const registry = buildRegistry(workspace);
  registry.projects.alpha.guest_mode = "registry_only";
  seedRegistry(workspace, registry);
  const before = fs.readFileSync(path.join(workspace.repoDir, "registry.json"), "utf8");

  // A grant for beta reads alpha's mode too, so it also fails before writing.
  for (const args of [["grant", "alpha", GUEST_ID], ["invite", "alpha", GUEST_ID], ["revoke", "alpha", GUEST_ID], ["sync", "alpha"], ["sync"],
    ["grant", "beta", GUEST_ID]]) {
    const result = await runNodeEntrypoint(workspace, "scripts/guest-access.js", { args, env: preloadEnv(workspace) });
    assert.notEqual(result.exitCode, 0, args.join(" "));
    assert.match(result.stderr, /Project alpha has unknown guest_mode "registry_only"; use "managed" or "registry-only"/);
  }
  assert.equal(fs.readFileSync(path.join(workspace.repoDir, "registry.json"), "utf8"), before);
  assert.deepEqual(discordWrites(workspace), [[], [], [], [], []]);
});
