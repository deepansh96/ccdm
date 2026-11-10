import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";

import { injectDiscordMessage } from "./support/bridge.js";
import {
  OWNER_ID as ROUTER_OWNER_ID,
  connectSession,
  createRouterWorkspace,
  routerRegistry,
  runRouterCli,
  startRouter,
  waitFor,
  writeProjectKey,
} from "./support/router.js";
import { createWorkspace, runNodeEntrypoint } from "./support/runner.js";
import { replaceFile } from "./support/platform.js";
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
async function overlappingGuestChanges(first, second, mode) {
  const workspace = createWorkspace();
  const registry = buildRegistry(workspace);
  if (mode) registry.guest_mode = mode;
  else registry.projects.alpha.guest_role_id = "existing-role";
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

// ---------------------------------------------------------------------------
// Guest modes. The top-level `guest_mode` picks how a guest gets into a project
// channel: absent or "roles" (everything above), "member-overwrites" (no role,
// only the guest's own channel overwrites) or "none" (no new guests).
// ---------------------------------------------------------------------------

const SECOND_ID = "333333333333333333";
const STALE_ID = "555555555555555555";
const OTHER_MEMBER_ID = "666666666666666666";
const BOT_ID = "fixture-bot-user-id";
const MEMBER_MODE = "member-overwrites";

// The fake server: the registry's category with an unregistered child and both
// project channels, a category the deny list can name with its child, and a
// category and channel the registry never names.
const SERVER_CHANNELS = [
  { id: "category-a", type: 4, name: "AF" },
  { id: "unregistered-child", type: 0, name: "quiz", parent_id: "category-a" },
  { id: "channel-alpha", type: 0, name: "alpha", parent_id: "category-a" },
  { id: "channel-beta", type: 0, name: "beta", parent_id: "category-a" },
  { id: "deny-category", type: 4, name: "private" },
  { id: "deny-child", type: 0, name: "notes", parent_id: "deny-category" },
  { id: "outside-category", type: 4, name: "elsewhere" },
  { id: "outside-channel", type: 0, name: "general", parent_id: "outside-category" },
];
// Everything a new mode may write on: the project channels, `category_ids`,
// `guest_deny_channel_ids` and their children.
const MANAGED_CHANNELS = ["category-a", "unregistered-child", "channel-alpha", "channel-beta", "deny-category", "deny-child"];

// A workspace whose fake Discord logs every request. `mode` undefined leaves
// `guest_mode` out of the registry; `edit` changes the registry and the fake's
// Discord fixtures before they are seeded.
function guestWorkspace(mode, edit = () => {}) {
  const workspace = createWorkspace();
  const registry = buildRegistry(workspace);
  if (mode !== undefined) {
    registry.guest_mode = mode;
    registry.guest_deny_channel_ids = ["deny-category"];
  }
  const channels = structuredClone(SERVER_CHANNELS);
  const discord = { channels, requestLog: [] };
  edit(registry, discord);
  seedRegistry(workspace, registry);
  const state = readState(workspace.stateDir);
  Object.assign(state.fixtures.discord, discord);
  writeState(state, workspace.stateDir);
  return workspace;
}

function guestAccess(workspace, ...args) {
  return runNodeEntrypoint(workspace, "scripts/guest-access.js", { args, env: preloadEnv(workspace) });
}

function registryText(workspace) {
  return fs.readFileSync(path.join(workspace.repoDir, "registry.json"), "utf8");
}

// Every Discord request the workspace has made, in order, as "METHOD route
// body". A multipart body is its fields, with a file as its name, size and type.
function discordCalls(workspace) {
  return readState(workspace.stateDir).fixtures.discord.requestLog.map(({ authorization, body, method, path: route }) => {
    assert.equal(authorization, "Bot root-token", `${method} ${route}`);
    const text = body == null ? [] : [typeof body === "string" ? body : JSON.stringify(body)];
    return [method, route.replace(/^\/api\/v10/, ""), ...text].join(" ");
  });
}

const denyView = (channelId, userId) => `PUT /channels/${channelId}/permissions/${userId} {"allow":"0","deny":"${VIEW_CHANNEL}","type":1}`;
const allowGuest = (channelId, userId) => `PUT /channels/${channelId}/permissions/${userId} {"allow":"${GUEST_ALLOW}","deny":"0","type":1}`;
// Member-overwrites mode's writes for alpha's `guests`: the deny list in order
// (categories and deny-listed channels, their children, the other project
// channel), then the allow on alpha's channel.
const memberOverwriteCalls = (...guests) => [
  "GET /guilds/guild-id/channels",
  ...["category-a", "deny-category", "unregistered-child", "channel-beta", "deny-child"]
    .flatMap(channelId => guests.map(userId => denyView(channelId, userId))),
  ...guests.map(userId => allowGuest("channel-alpha", userId)),
];
const memberInviteCall = "POST /channels/channel-alpha/invites " + JSON.stringify({
  payload_json: JSON.stringify({ max_age: 604800, max_uses: 1, temporary: false, unique: true }),
  target_users_file: { name: "target_users.csv", size: 19, type: "text/csv" },
});

// No role is created, assigned or removed, no role overwrite is written, and
// nothing outside the managed channels is written, deleted or even read.
function assertMemberModeOnly(workspace) {
  const discord = readState(workspace.stateDir).fixtures.discord;
  assert.deepEqual([discord.roleCreates, discord.memberRolePuts, discord.memberRoleDeletes], [[], [], []]);
  assert.deepEqual(discord.permissionOverwrites.filter(entry => entry.type !== 1), []);
  const touched = [...discord.permissionOverwrites, ...(discord.permissionOverwriteDeletes ?? [])].map(entry => entry.channelId);
  assert.deepEqual(touched.filter(channelId => !MANAGED_CHANNELS.includes(channelId)), []);
  assert.deepEqual(discordCalls(workspace).filter(call => /outside-|\/roles\b/.test(call)), []);
  assert.deepEqual(discord.malformedRequests, []);
}

// Role mode, recorded from guest-access.js as it was before guest modes
// existed: its output and alpha's registry entry after each step, and every
// Discord request of the whole run.
const ROLE_MODE_STEPS = [
  {
    run: 'invite alpha 222222222222222222',
    stdout: 'Granted 222222222222222222 guest access to alpha.\nInvite: https://discord.gg/fake-invite-1\n',
    alpha: '{"path":"<alpha>","screen_name":"alpha_session","channel_id":"channel-alpha","type":"claude","guest_role_id":"fake-role-1","guest_user_ids":["222222222222222222"],"guest_invites":{"222222222222222222":["fake-invite-1"]}}',
    beta: '{"path":"<beta>","screen_name":"beta_session","channel_id":"channel-beta","type":"codex","ws_port":18343}',
  },
  {
    run: 'grant alpha 333333333333333333',
    stdout: 'Granted 333333333333333333 guest access to alpha.\n',
    alpha: '{"path":"<alpha>","screen_name":"alpha_session","channel_id":"channel-alpha","type":"claude","guest_role_id":"fake-role-1","guest_user_ids":["222222222222222222","333333333333333333"],"guest_invites":{"222222222222222222":["fake-invite-1"]}}',
    beta: '{"path":"<beta>","screen_name":"beta_session","channel_id":"channel-beta","type":"codex","ws_port":18343}',
  },
  {
    run: 'sync',
    stdout: 'Synced alpha.\nSynced beta.\n',
    alpha: '{"path":"<alpha>","screen_name":"alpha_session","channel_id":"channel-alpha","type":"claude","guest_role_id":"fake-role-1","guest_user_ids":["222222222222222222","333333333333333333"],"guest_invites":{"222222222222222222":["fake-invite-1"]}}',
    beta: '{"path":"<beta>","screen_name":"beta_session","channel_id":"channel-beta","type":"codex","ws_port":18343}',
  },
  {
    run: 'revoke alpha 222222222222222222',
    stdout: 'Revoked 222222222222222222 guest access from alpha.\n',
    alpha: '{"path":"<alpha>","screen_name":"alpha_session","channel_id":"channel-alpha","type":"claude","guest_role_id":"fake-role-1","guest_user_ids":["333333333333333333"]}',
    beta: '{"path":"<beta>","screen_name":"beta_session","channel_id":"channel-beta","type":"codex","ws_port":18343}',
  },
  {
    run: 'list',
    stdout: 'alpha: 333333333333333333\nbeta: (none)\n',
    alpha: '{"path":"<alpha>","screen_name":"alpha_session","channel_id":"channel-alpha","type":"claude","guest_role_id":"fake-role-1","guest_user_ids":["333333333333333333"]}',
    beta: '{"path":"<beta>","screen_name":"beta_session","channel_id":"channel-beta","type":"codex","ws_port":18343}',
  },
];
const ROLE_MODE_CALLS = [
  'POST /guilds/guild-id/roles {"name":"ccdm-guest-alpha-channel-alpha","permissions":"0","mentionable":false,"hoist":false}',
  'GET /guilds/guild-id/channels',
  'PUT /channels/category-a/permissions/fake-role-1 {"allow":"0","deny":"1024","type":0}',
  'PUT /channels/category-a/permissions/222222222222222222 {"allow":"0","deny":"1024","type":1}',
  'PUT /channels/unregistered-child/permissions/fake-role-1 {"allow":"0","deny":"1024","type":0}',
  'PUT /channels/unregistered-child/permissions/222222222222222222 {"allow":"0","deny":"1024","type":1}',
  'PUT /channels/channel-beta/permissions/fake-role-1 {"allow":"0","deny":"1024","type":0}',
  'PUT /channels/channel-beta/permissions/222222222222222222 {"allow":"0","deny":"1024","type":1}',
  'PUT /channels/channel-alpha/permissions/fake-role-1 {"allow":"274878008384","deny":"0","type":0}',
  'PUT /channels/channel-alpha/permissions/222222222222222222 {"allow":"274878008384","deny":"0","type":1}',
  'PUT /guilds/guild-id/members/222222222222222222/roles/fake-role-1',
  'POST /channels/channel-alpha/invites {"payload_json":"{\\"max_age\\":604800,\\"max_uses\\":1,\\"temporary\\":false,\\"unique\\":true,\\"role_ids\\":[\\"fake-role-1\\"]}","target_users_file":{"name":"target_users.csv","size":19,"type":"text/csv"}}',
  'GET /invites/fake-invite-1/target-users/job-status',
  'GET /guilds/guild-id/channels',
  'PUT /channels/category-a/permissions/fake-role-1 {"allow":"0","deny":"1024","type":0}',
  'PUT /channels/category-a/permissions/222222222222222222 {"allow":"0","deny":"1024","type":1}',
  'PUT /channels/category-a/permissions/333333333333333333 {"allow":"0","deny":"1024","type":1}',
  'PUT /channels/unregistered-child/permissions/fake-role-1 {"allow":"0","deny":"1024","type":0}',
  'PUT /channels/unregistered-child/permissions/222222222222222222 {"allow":"0","deny":"1024","type":1}',
  'PUT /channels/unregistered-child/permissions/333333333333333333 {"allow":"0","deny":"1024","type":1}',
  'PUT /channels/channel-beta/permissions/fake-role-1 {"allow":"0","deny":"1024","type":0}',
  'PUT /channels/channel-beta/permissions/222222222222222222 {"allow":"0","deny":"1024","type":1}',
  'PUT /channels/channel-beta/permissions/333333333333333333 {"allow":"0","deny":"1024","type":1}',
  'PUT /channels/channel-alpha/permissions/fake-role-1 {"allow":"274878008384","deny":"0","type":0}',
  'PUT /channels/channel-alpha/permissions/222222222222222222 {"allow":"274878008384","deny":"0","type":1}',
  'PUT /channels/channel-alpha/permissions/333333333333333333 {"allow":"274878008384","deny":"0","type":1}',
  'PUT /guilds/guild-id/members/333333333333333333/roles/fake-role-1',
  'GET /guilds/guild-id/channels',
  'PUT /channels/category-a/permissions/fake-role-1 {"allow":"0","deny":"1024","type":0}',
  'PUT /channels/category-a/permissions/222222222222222222 {"allow":"0","deny":"1024","type":1}',
  'PUT /channels/category-a/permissions/333333333333333333 {"allow":"0","deny":"1024","type":1}',
  'PUT /channels/unregistered-child/permissions/fake-role-1 {"allow":"0","deny":"1024","type":0}',
  'PUT /channels/unregistered-child/permissions/222222222222222222 {"allow":"0","deny":"1024","type":1}',
  'PUT /channels/unregistered-child/permissions/333333333333333333 {"allow":"0","deny":"1024","type":1}',
  'PUT /channels/channel-beta/permissions/fake-role-1 {"allow":"0","deny":"1024","type":0}',
  'PUT /channels/channel-beta/permissions/222222222222222222 {"allow":"0","deny":"1024","type":1}',
  'PUT /channels/channel-beta/permissions/333333333333333333 {"allow":"0","deny":"1024","type":1}',
  'PUT /channels/channel-alpha/permissions/fake-role-1 {"allow":"274878008384","deny":"0","type":0}',
  'PUT /channels/channel-alpha/permissions/222222222222222222 {"allow":"274878008384","deny":"0","type":1}',
  'PUT /channels/channel-alpha/permissions/333333333333333333 {"allow":"274878008384","deny":"0","type":1}',
  'PUT /guilds/guild-id/members/222222222222222222/roles/fake-role-1',
  'PUT /guilds/guild-id/members/333333333333333333/roles/fake-role-1',
  'DELETE /guilds/guild-id/members/222222222222222222/roles/fake-role-1',
  'DELETE /invites/fake-invite-1',
];

for (const mode of [undefined, "roles"]) {
  test(`a registry with ${mode ? 'guest_mode "roles"' : "no guest_mode"} makes exactly role mode's Discord calls, registry writes and messages`, async () => {
    const workspace = guestWorkspace(undefined, (registry) => {
      if (mode) registry.guest_mode = mode;
    });
    const steps = [];
    for (const args of [["invite", "alpha", GUEST_ID], ["grant", "alpha", SECOND_ID], ["sync"], ["revoke", "alpha", GUEST_ID], ["list"]]) {
      const result = await guestAccess(workspace, ...args);
      assert.equal(result.exitCode, 0, result.stderr || result.stdout);
      const registry = readRegistry(workspace);
      steps.push({
        run: args.join(" "),
        stdout: result.stdout,
        alpha: JSON.stringify({ ...registry.projects.alpha, path: "<alpha>" }),
        beta: JSON.stringify({ ...registry.projects.beta, path: "<beta>" }),
      });
    }

    assert.deepEqual(steps, ROLE_MODE_STEPS);
    assert.deepEqual(discordCalls(workspace), ROLE_MODE_CALLS);
    assert.equal(readRegistry(workspace).guest_mode, mode);
  });
}

test("member-overwrites invite writes only member overwrites and a targeted invite without a role", async () => {
  const workspace = guestWorkspace(MEMBER_MODE);

  const result = await guestAccess(workspace, "invite", "alpha", GUEST_ID);

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.equal(result.stdout, `Granted ${GUEST_ID} guest access to alpha.\nInvite: https://discord.gg/fake-invite-1\n`);
  assert.deepEqual(discordCalls(workspace), [
    ...memberOverwriteCalls(GUEST_ID),
    memberInviteCall,
    "GET /invites/fake-invite-1/target-users/job-status",
  ]);
  assertMemberModeOnly(workspace);
  const alpha = readRegistry(workspace).projects.alpha;
  assert.equal("guest_role_id" in alpha, false);
  assert.deepEqual(alpha.guest_user_ids, [GUEST_ID]);
  assert.deepEqual(alpha.guest_invites, { [GUEST_ID]: ["fake-invite-1"] });
  assert.deepEqual(perBotAccessFiles(workspace), []);
  assert.equal(JSON.stringify(readState(workspace.stateDir).fixtures.discord).includes("project-bot-role-id"), false);
});

test("member-overwrites grant does what invite does without the invite, for every current guest", async () => {
  const workspace = guestWorkspace(MEMBER_MODE, (registry) => {
    registry.projects.alpha.guest_user_ids = [GUEST_ID];
  });

  const result = await guestAccess(workspace, "grant", "alpha", SECOND_ID);

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.equal(result.stdout, `Granted ${SECOND_ID} guest access to alpha.\n`);
  assert.deepEqual(discordCalls(workspace), memberOverwriteCalls(GUEST_ID, SECOND_ID));
  assertMemberModeOnly(workspace);
  const alpha = readRegistry(workspace).projects.alpha;
  assert.equal("guest_role_id" in alpha, false);
  assert.deepEqual(alpha.guest_user_ids, [GUEST_ID, SECOND_ID]);
  assert.equal(alpha.guest_invites, undefined);
});

test("member-overwrites revoke deletes the guest's allow overwrite and their invites, and no role", async () => {
  const workspace = guestWorkspace(MEMBER_MODE, (registry, discord) => {
    // A role id left in the entry is never used in this mode.
    registry.projects.alpha.guest_role_id = "leftover-role";
    registry.projects.alpha.guest_user_ids = [GUEST_ID, SECOND_ID];
    registry.projects.alpha.guest_invites = { [GUEST_ID]: ["fake-invite-1", "fake-invite-2"] };
    discord.channels.find(channel => channel.id === "channel-alpha").permission_overwrites = [
      { id: GUEST_ID, type: 1, allow: GUEST_ALLOW, deny: "0" },
      { id: SECOND_ID, type: 1, allow: GUEST_ALLOW, deny: "0" },
    ];
  });

  const result = await guestAccess(workspace, "revoke", "channel-alpha", GUEST_ID);

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.equal(result.stdout, `Revoked ${GUEST_ID} guest access from alpha.\n`);
  assert.deepEqual(discordCalls(workspace), [
    `DELETE /channels/channel-alpha/permissions/${GUEST_ID}`,
    "DELETE /invites/fake-invite-1",
    "DELETE /invites/fake-invite-2",
  ]);
  assertMemberModeOnly(workspace);
  const alpha = readRegistry(workspace).projects.alpha;
  assert.deepEqual(alpha.guest_user_ids, [SECOND_ID]);
  assert.equal(alpha.guest_invites, undefined);

  // Revoking again finds no overwrite (Discord answers 404) and still succeeds.
  const again = await guestAccess(workspace, "revoke", "alpha", GUEST_ID);
  assert.equal(again.exitCode, 0, again.stderr || again.stdout);
  assert.deepEqual(discordCalls(workspace).slice(3), [`DELETE /channels/channel-alpha/permissions/${GUEST_ID}`]);
});

test("member-overwrites sync rewrites the guests' overwrites and deletes only stale guest overwrites", async () => {
  const workspace = guestWorkspace(MEMBER_MODE, (registry, discord) => {
    registry.projects.alpha.guest_user_ids = [GUEST_ID];
    discord.channels.find(channel => channel.id === "channel-alpha").permission_overwrites = [
      { id: "guild-id", type: 0, allow: "0", deny: VIEW_CHANNEL },
      { id: BOT_ID, type: 1, allow: "395942423632", deny: "0" },
      // Even with a guest's exact permissions, the owner's is kept.
      { id: OWNER_ID, type: 1, allow: GUEST_ALLOW, deny: "0" },
      { id: "some-role", type: 0, allow: GUEST_ALLOW, deny: "0" },
      { id: GUEST_ID, type: 1, allow: GUEST_ALLOW, deny: "0" },
      { id: STALE_ID, type: 1, allow: GUEST_ALLOW, deny: "0" },
      { id: OTHER_MEMBER_ID, type: 1, allow: VIEW_CHANNEL, deny: "0" },
    ];
    discord.channels.find(channel => channel.id === "channel-beta").permission_overwrites = [
      { id: BOT_ID, type: 1, allow: "395942423632", deny: "0" },
    ];
  });

  const result = await guestAccess(workspace, "sync");

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.equal(result.stdout, `Removed the stale guest permission of ${STALE_ID} from alpha.\nSynced alpha.\nSynced beta.\n`);
  assert.deepEqual(discordCalls(workspace), [
    ...memberOverwriteCalls(GUEST_ID),
    "GET /channels/channel-alpha",
    `DELETE /channels/channel-alpha/permissions/${STALE_ID}`,
    // beta has no guests: nothing to write, only stale overwrites to look for.
    "GET /channels/channel-beta",
  ]);
  assertMemberModeOnly(workspace);
  assert.deepEqual(readState(workspace.stateDir).fixtures.discord.permissionOverwriteDeletes, [
    { authorization: "Bot root-token", channelId: "channel-alpha", overwriteId: STALE_ID },
  ]);
  const alpha = readRegistry(workspace).projects.alpha;
  assert.equal("guest_role_id" in alpha, false);
  assert.deepEqual(alpha.guest_user_ids, [GUEST_ID]);
});

test("member-overwrites invite before the user joins says so, and a later sync writes their permissions", async () => {
  const workspace = guestWorkspace(MEMBER_MODE, (registry, discord) => {
    discord.memberRolePut404UserIds = [GUEST_ID];
  });

  const result = await guestAccess(workspace, "invite", "alpha", GUEST_ID);

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.equal(result.stdout, `Granted ${GUEST_ID} guest access to alpha.\nInvite: https://discord.gg/fake-invite-1\n` +
    `${GUEST_ID} is not in the server, so they have no channel permission yet. ` +
    "After they join, run: node scripts/guest-access.js sync alpha\n");
  const alpha = readRegistry(workspace).projects.alpha;
  assert.deepEqual(alpha.guest_user_ids, [GUEST_ID]);
  assert.deepEqual(alpha.guest_invites, { [GUEST_ID]: ["fake-invite-1"] });
  assert.deepEqual(readState(workspace.stateDir).fixtures.discord.permissionOverwrites, []);
  assert.equal(JSON.parse(readState(workspace.stateDir).fixtures.discord.invites[0].fields.payload_json).role_ids, undefined);

  // Still not in the server: sync says so again and writes nothing.
  const early = await guestAccess(workspace, "sync", "alpha");
  assert.equal(early.exitCode, 0, early.stderr || early.stdout);
  assert.match(early.stdout, new RegExp(`^${GUEST_ID} is not in the server, .*sync alpha\nSynced alpha\\.\n$`));
  assert.deepEqual(readState(workspace.stateDir).fixtures.discord.permissionOverwrites, []);

  const joined = readState(workspace.stateDir);
  joined.fixtures.discord.memberRolePut404UserIds = [];
  joined.fixtures.discord.requestLog = [];
  writeState(joined, workspace.stateDir);
  const synced = await guestAccess(workspace, "sync", "alpha");

  assert.equal(synced.exitCode, 0, synced.stderr || synced.stdout);
  assert.equal(synced.stdout, "Synced alpha.\n");
  assert.deepEqual(discordCalls(workspace), [...memberOverwriteCalls(GUEST_ID), "GET /channels/channel-alpha"]);
  assertMemberModeOnly(workspace);
});

test("member-overwrites grant fails when the user is not in the guild", async () => {
  const workspace = guestWorkspace(MEMBER_MODE, (registry, discord) => {
    discord.memberRolePut404UserIds = [GUEST_ID];
  });

  const result = await guestAccess(workspace, "grant", "alpha", GUEST_ID);

  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /Unknown Member/);
  assert.equal(readRegistry(workspace).projects.alpha.guest_user_ids, undefined);
  assertMemberModeOnly(workspace);
});

test("member-overwrites invite fails closed when managed channel discovery fails", async () => {
  const workspace = guestWorkspace(MEMBER_MODE, (registry, discord) => {
    discord.channelListFailures = 1;
  });

  const result = await guestAccess(workspace, "invite", "alpha", GUEST_ID);

  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /channel list failed/);
  assert.equal(readRegistry(workspace).projects.alpha.guest_user_ids, undefined);
  assert.deepEqual(discordCalls(workspace), ["GET /guilds/guild-id/channels"]);
});

test("member-overwrites revoke keeps local access when Discord cleanup fails", async () => {
  const seed = (registry, discord) => {
    registry.projects.alpha.guest_user_ids = [GUEST_ID];
    registry.projects.alpha.guest_invites = { [GUEST_ID]: ["fake-invite-1"] };
    discord.channels.find(channel => channel.id === "channel-alpha").permission_overwrites = [
      { id: GUEST_ID, type: 1, allow: GUEST_ALLOW, deny: "0" },
    ];
  };
  const refusedDelete = guestWorkspace(MEMBER_MODE, (registry, discord) => {
    seed(registry, discord);
    discord.restFailures = [{ method: "DELETE", path: `/api/v10/channels/channel-alpha/permissions/${GUEST_ID}`,
      status: 403, body: { code: 50013, message: "Missing Permissions" } }];
  });
  const failedInvite = guestWorkspace(MEMBER_MODE, (registry, discord) => {
    seed(registry, discord);
    discord.inviteDeleteFailures = ["fake-invite-1"];
  });

  for (const [workspace, message, calls] of [
    [refusedDelete, /Missing Permissions/, [`DELETE /channels/channel-alpha/permissions/${GUEST_ID}`]],
    [failedInvite, /delete invite failed/, [`DELETE /channels/channel-alpha/permissions/${GUEST_ID}`, "DELETE /invites/fake-invite-1"]],
  ]) {
    const result = await guestAccess(workspace, "revoke", "alpha", GUEST_ID);
    assert.notEqual(result.exitCode, 0);
    assert.match(result.stderr, message);
    assert.deepEqual(discordCalls(workspace), calls);
    const alpha = readRegistry(workspace).projects.alpha;
    assert.deepEqual(alpha.guest_user_ids, [GUEST_ID]);
    assert.deepEqual(alpha.guest_invites, { [GUEST_ID]: ["fake-invite-1"] });
  }
});

test("member-overwrites guest access makes no Discord request when root credentials are missing", async () => {
  const workspace = guestWorkspace(MEMBER_MODE, (registry) => {
    registry.projects.alpha.guest_user_ids = [SECOND_ID];
  });
  fs.unlinkSync(path.join(workspace.homeDir, ".claude/channels/discord/.env"));

  for (const args of [["invite", "alpha", GUEST_ID], ["grant", "alpha", GUEST_ID], ["revoke", "alpha", SECOND_ID], ["sync"]]) {
    const result = await guestAccess(workspace, ...args);
    assert.notEqual(result.exitCode, 0, args.join(" "));
    assert.match(result.stderr, /Cannot read root Discord credentials/);
  }
  assert.deepEqual(discordCalls(workspace), []);
});

test("member-overwrites guest access reads an explicitly selected root state directory", async () => {
  const workspace = guestWorkspace(MEMBER_MODE);
  const custom = path.join(workspace.homeDir, "custom root");
  fs.mkdirSync(custom);
  fs.writeFileSync(path.join(custom, ".env"), 'DISCORD_BOT_TOKEN="custom-root-token"\n');

  const result = await runNodeEntrypoint(workspace, "scripts/guest-access.js", {
    args: ["grant", "alpha", GUEST_ID],
    env: { ...preloadEnv(workspace), ROOT_DISCORD_STATE_DIR: custom },
  });

  assert.equal(result.exitCode, 0, result.stderr);
  const overwrites = readState(workspace.stateDir).fixtures.discord.permissionOverwrites;
  assert.equal(overwrites.length, 6);
  assert.deepEqual([...new Set(overwrites.map(entry => entry.authorization))], ["Bot custom-root-token"]);
});

test("concurrent member-overwrites guest grants both survive, with no role recorded", async () => {
  const alpha = await overlappingGuestChanges(["grant", "alpha", "333333333333333333"], ["grant", "alpha", "444444444444444444"], MEMBER_MODE);

  assert.deepEqual([...alpha.guest_user_ids].sort(), [GUEST_ID, "333333333333333333", "444444444444444444"]);
  assert.equal("guest_role_id" in alpha, false);
});

test("a member-overwrites invite overlapping a revoke does not restore the revoked guest or their invites", async () => {
  const alpha = await overlappingGuestChanges(["revoke", "alpha", GUEST_ID], ["invite", "alpha", "333333333333333333"], MEMBER_MODE);

  assert.deepEqual(alpha.guest_user_ids, ["333333333333333333"]);
  assert.deepEqual(Object.keys(alpha.guest_invites), ["333333333333333333"]);
  assert.equal("guest_role_id" in alpha, false);
});

test("member-overwrites guest access exits 2 for a target it cannot name, before any Discord request", async () => {
  const workspace = guestWorkspace(MEMBER_MODE);
  const before = registryText(workspace);

  for (const args of [["grant", "no-such-thread", GUEST_ID], ["revoke", "1799999999999999999", GUEST_ID],
    ["sync", "no-such-thread"], ["list", "https://discord.com/channels/guild-id/1799999999999999999"]]) {
    const result = await guestAccess(workspace, ...args);
    assert.equal(result.exitCode, 2, `${args.join(" ")}: ${result.stdout}`);
    assert.match(result.stderr, /^conversation-resolver: '.+' (links to no registered channel|is no registered channel)/);
  }
  assert.equal(registryText(workspace), before);
  assert.deepEqual(discordCalls(workspace), []);
});

test("with no or bad arguments the usage names the command as this OS runs it, and nothing is read or sent", async () => {
  const workspace = guestWorkspace("none");
  // Windows does not honour the shebang, so the command there starts with node.
  const command = process.platform === "win32" ? "node scripts/guest-access.js" : "scripts/guest-access.js";

  for (const args of [[], ["bogus"], ["invite", "alpha"], ["list", "alpha", GUEST_ID]]) {
    const result = await guestAccess(workspace, ...args);
    assert.equal(result.exitCode, 2, `${args.join(" ")}: ${result.stdout}`);
    assert.equal(result.stderr, "Usage:\n" +
      `  ${command} invite <project|channel_id|thread_id|link> <user_id>\n` +
      `  ${command} grant <project|channel_id|thread_id|link> <user_id>\n` +
      `  ${command} revoke <project|channel_id|thread_id|link> <user_id>\n` +
      `  ${command} sync [project|channel_id|thread_id|link]\n` +
      `  ${command} list [project|channel_id|thread_id|link]\n`);
  }
  assert.deepEqual(discordCalls(workspace), []);
});

test('guest_mode "none" refuses invite, grant and sync with a reason in plain words, and no Discord request', async () => {
  const workspace = guestWorkspace("none", (registry) => {
    registry.projects.alpha.guest_user_ids = [SECOND_ID];
  });
  const before = registryText(workspace);

  for (const args of [["invite", "alpha", GUEST_ID], ["grant", "alpha", GUEST_ID], ["sync"], ["sync", "alpha"]]) {
    const result = await guestAccess(workspace, ...args);
    assert.equal(result.exitCode, 1, `${args.join(" ")}: ${result.stdout}`);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, `Error: guest ${args[0]} is off for this registry: guest_mode is "none" ` +
      "(no guests where the bot would need server-wide Manage Roles). revoke and list still work.\n");
    // No label of a decision record: a user cannot look one up.
    assert.doesNotMatch(result.stderr, /\bD\d\b|owner decision/);
  }
  assert.equal(registryText(workspace), before);
  assert.deepEqual(discordCalls(workspace), []);
});

test('guest_mode "none" still revokes and lists', async () => {
  const workspace = guestWorkspace("none", (registry) => {
    registry.projects.alpha.guest_user_ids = [GUEST_ID, SECOND_ID];
    registry.projects.alpha.guest_invites = { [GUEST_ID]: ["fake-invite-1"] };
  });

  const listed = await guestAccess(workspace, "list");
  assert.equal(listed.exitCode, 0, listed.stderr);
  assert.equal(listed.stdout, `alpha: ${GUEST_ID}, ${SECOND_ID}\nbeta: (none)\n`);

  const revoked = await guestAccess(workspace, "revoke", "alpha", GUEST_ID);
  assert.equal(revoked.exitCode, 0, revoked.stderr || revoked.stdout);
  assert.equal(revoked.stdout, `Revoked ${GUEST_ID} guest access from alpha.\n`);
  // Only the recorded invite: no role and no overwrite call.
  assert.deepEqual(discordCalls(workspace), ["DELETE /invites/fake-invite-1"]);
  const alpha = readRegistry(workspace).projects.alpha;
  assert.deepEqual(alpha.guest_user_ids, [SECOND_ID]);
  assert.equal(alpha.guest_invites, undefined);

  const after = await guestAccess(workspace, "list", "alpha");
  assert.equal(after.stdout, `alpha: ${SECOND_ID}\n`);
});

test("guest access refuses a registry whose guest_mode it does not know, with no Discord request", async () => {
  const workspace = guestWorkspace("member-overwrite", (registry) => {
    registry.projects.alpha.guest_user_ids = [SECOND_ID];
  });
  const before = registryText(workspace);

  for (const args of [["invite", "alpha", GUEST_ID], ["grant", "alpha", GUEST_ID], ["revoke", "alpha", SECOND_ID], ["sync"], ["list"]]) {
    const result = await guestAccess(workspace, ...args);
    assert.equal(result.exitCode, 1, `${args.join(" ")}: ${result.stdout}`);
    assert.equal(result.stderr, 'Error: invalid registry: guest_mode must be "roles", "member-overwrites" or "none"\n');
  }
  assert.equal(registryText(workspace), before);
  assert.deepEqual(discordCalls(workspace), []);
});

test("registry validation accepts the three guest modes or none, and names guest_mode for anything else", () => {
  const { validateRegistry } = createRequire(import.meta.url)("../../scripts/router/registry.js");
  const registry = { discord_user_id: OWNER_ID, projects: { alpha: { channel_id: "channel-alpha" } } };

  validateRegistry(registry);
  for (const mode of [null, "roles", "member-overwrites", "none"]) validateRegistry({ ...registry, guest_mode: mode });
  for (const mode of ["", "Roles", "member-overwrite", "manage-roles", 1, true, ["roles"], {}]) {
    assert.throws(() => validateRegistry({ ...registry, guest_mode: mode }),
      { message: 'invalid registry: guest_mode must be "roles", "member-overwrites" or "none"' }, JSON.stringify(mode));
  }
});

// Atomic replace, the way editors and structured rewrites land a registry.
function replaceRegistry(workspace, registry) {
  const file = path.join(workspace.repoDir, "registry.json");
  replaceFile(file, `${JSON.stringify(registry, null, 2)}\n`);
}

test("an invalid guest_mode keeps the Router's last good table and shows in router status until fixed", async () => {
  const workspace = createRouterWorkspace();
  writeProjectKey(workspace, "demo", "demo-key");
  const router = await startRouter(workspace, { env: { CCDM_ROUTER_REGISTRY_DEBOUNCE_MS: "20" } });
  const demo = await connectSession(workspace, "demo", "demo-key");
  const loadedBefore = (await runRouterCli(workspace, ["status"])).stdout.match(/registry loaded: (\S+)/)[1];
  const count = marker => router.stdout.split(marker).length - 1;
  const inject = id => injectDiscordMessage(workspace, { id, channelId: "demo-channel", content: `from ${id}`,
    author: { id: ROUTER_OWNER_ID, username: "Owner" } });

  await new Promise((resolve) => setTimeout(resolve, 100));
  replaceRegistry(workspace, { ...routerRegistry(), guest_mode: "manage-roles" });
  await waitFor(() => count("registry_reload_failed") > 0, () => `schema failure:\n${router.stdout}`);
  const failed = await runRouterCli(workspace, ["status"]);
  assert.equal(failed.exitCode, 0, failed.stderr || failed.stdout);
  assert.match(failed.stdout, new RegExp(`registry loaded: ${loadedBefore}\n`));
  assert.match(failed.stdout, /registry error: \S+ invalid registry: guest_mode must be "roles", "member-overwrites" or "none"/);
  inject("while-invalid");
  await waitFor(() => demo.events.length > 0, () => `owner message while invalid:\n${router.stdout}`);
  assert.doesNotMatch(router.stdout, /registry reloaded/);

  // Each valid mode loads.
  for (const mode of ["none", "member-overwrites", "roles"]) {
    const reloads = count("registry reloaded");
    await new Promise((resolve) => setTimeout(resolve, 100));
    replaceRegistry(workspace, { ...routerRegistry(), guest_mode: mode });
    await waitFor(() => count("registry reloaded") > reloads, () => `reload with ${mode}:\n${router.stdout}\n${router.stderr}`);
    assert.doesNotMatch((await runRouterCli(workspace, ["status"])).stdout, /registry error/);
  }
  inject("after-fix");
  await waitFor(() => demo.events.length > 1, () => `owner message after the fix:\n${router.stdout}`);
  assert.deepEqual(demo.events.map(event => event.message_id), ["while-invalid", "after-fix"]);
});
