import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { runScript } from "./support/runner.js";
import { OWNER_ID, createRouterWorkspace, routerEnv } from "./support/router.js";
import { readState } from "./support/state.js";
import { cleanup } from "./support/teardown.js";

test.afterEach(async () => {
  await cleanup();
});

// Three pool bots: bot2 served `demo`, bot3 served `beta`, and bot9 is
// unassigned. Every project is on the Router unless `transports` says otherwise.
function poolWorkspace({ transports = {} } = {}) {
  const workspace = createRouterWorkspace({
    discord_user_id: OWNER_ID,
    guild_id: "guild-id",
    max_pool_size: 50,
    project_bot_role_id: "project-bot-role",
    root_channels: ["root-channel"],
    pool: [
      { id: "bot2", app_id: "app-2", token: "bot2-token", state_dir: "__HOME__/.claude/channels/discord2", assigned_to: "demo" },
      { id: "bot3", app_id: "app-3", token: "bot3-token", state_dir: "__HOME__/.claude/channels/discord3", assigned_to: "beta" },
      { id: "bot9", app_id: "app-9", token: "bot9-token", state_dir: "__HOME__/.claude/channels/discord9", assigned_to: null },
    ],
    projects: {
      demo: { channel_id: "demo-channel", type: "claude", transport: "demo" in transports ? transports.demo : "router", bot_id: "bot2",
        bot_display_name: "demo-claude", webhook_id: "webhook-demo", guest_user_ids: ["guest-id"] },
      beta: { channel_id: "beta-channel", type: "codex", transport: "beta" in transports ? transports.beta : "router", bot_id: "bot3",
        webhook_id: "webhook-beta", ws_port: 4501 },
    },
  });
  const registry = readRegistry(workspace);
  for (const bot of registry.pool) {
    bot.state_dir = bot.state_dir.replace("__HOME__", workspace.homeDir);
    fs.mkdirSync(bot.state_dir, { recursive: true });
    fs.writeFileSync(path.join(bot.state_dir, ".env"), `DISCORD_BOT_TOKEN=${bot.token}\n`);
  }
  for (const [name, project] of Object.entries(registry.projects)) {
    if (project.transport === null) delete registry.projects[name].transport;
  }
  writeRegistry(workspace, registry);
  return workspace;
}

const registryFile = (workspace) => path.join(workspace.repoDir, "registry.json");
const readRegistry = (workspace) => JSON.parse(fs.readFileSync(registryFile(workspace), "utf8"));
const writeRegistry = (workspace, registry) =>
  fs.writeFileSync(registryFile(workspace), `${JSON.stringify(registry, null, 2)}\n`);
const stateDirOf = (workspace, n) => path.join(workspace.homeDir, ".claude/channels", `discord${n}`);

function retire(workspace, args = []) {
  return runScript(workspace, "scripts/retire-pool.sh", {
    args, env: routerEnv(workspace, { CCDM_ROUTER_NODE: process.execPath }),
  });
}

// Every Discord mutation the fake could record for retirement, plus requests it did not recognize.
function discordMutations(workspace) {
  const discord = readState(workspace.stateDir).fixtures.discord;
  return {
    memberRemovals: discord.memberRemovals ?? [],
    roleDeletes: discord.roleDeletes ?? [],
    applicationDeletes: discord.applicationDeletes ?? [],
    malformedRequests: discord.malformedRequests ?? [],
  };
}

const NO_MUTATIONS = { memberRemovals: [], roleDeletes: [], applicationDeletes: [], malformedRequests: [] };

for (const args of [[], ["--apply"]]) {
  test(`retirement ${args.length ? "with --apply" : "as a dry run"} refuses while a project is still on the pool, naming it`, async () => {
    const workspace = poolWorkspace({ transports: { beta: null } });
    const before = fs.readFileSync(registryFile(workspace), "utf8");

    const result = await retire(workspace, args);

    assert.notEqual(result.exitCode, 0);
    assert.match(result.stderr, /refusing to retire the Bot Pool: beta is not on the Router \(transport: "router"\)/);
    assert.doesNotMatch(result.stderr, /\bdemo\b/);
    assert.equal(fs.readFileSync(registryFile(workspace), "utf8"), before);
    assert.deepEqual(discordMutations(workspace), NO_MUTATIONS);
    for (const n of [2, 3, 9]) assert.ok(fs.existsSync(stateDirOf(workspace, n)), `discord${n} was moved`);
  });
}

// The actions for poolWorkspace(), written out by hand.
function expectedActions(workspace) {
  const home = workspace.homeDir;
  const backup = `${home}/.local/state/ccdm/pool-retirement`;
  return [
    "remove member bot2 (app-2) from guild guild-id",
    "remove member bot3 (app-3) from guild guild-id",
    "remove member bot9 (app-9) from guild guild-id",
    `move state directory ${home}/.claude/channels/discord2 to ${backup}/state/bot2`,
    `move state directory ${home}/.claude/channels/discord3 to ${backup}/state/bot3`,
    `move state directory ${home}/.claude/channels/discord9 to ${backup}/state/bot9`,
    "delete role project-bot (project-bot-role) in guild guild-id",
    `back up the registry to ${backup}/registry.json`,
    "strip pool, max_pool_size, project_bot_role_id from the registry",
    "strip bot_id, bot_display_name, transport from project demo",
    "strip bot_id, transport from project beta",
  ];
}

test("a dry run lists every member removal, state move, role delete, and registry strip, and changes nothing", async () => {
  const workspace = poolWorkspace();
  const before = fs.readFileSync(registryFile(workspace), "utf8");

  const result = await retire(workspace);

  assert.equal(result.exitCode, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split("\n"), [
    "dry run: nothing changes until this is re-run with --apply",
    ...expectedActions(workspace).map((action) => `would ${action}`),
  ]);
  assert.deepEqual(discordMutations(workspace), NO_MUTATIONS);
  assert.equal(fs.readFileSync(registryFile(workspace), "utf8"), before);
  for (const n of [2, 3, 9]) assert.ok(fs.existsSync(stateDirOf(workspace, n)), `discord${n} was moved`);
  assert.equal(fs.existsSync(path.join(workspace.homeDir, ".local/state/ccdm/pool-retirement")), false);
});

test("--apply removes every pool bot, deletes the role, backs up state and registry privately, and strips the pool fields", async () => {
  const workspace = poolWorkspace();
  const before = fs.readFileSync(registryFile(workspace), "utf8");
  const backup = path.join(workspace.homeDir, ".local/state/ccdm/pool-retirement");

  const result = await retire(workspace, ["--apply"]);

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.deepEqual(result.stdout.trim().split("\n"), expectedActions(workspace).map((action) => `done: ${action}`));
  const auth = "Bot root-bot-token";
  assert.deepEqual(discordMutations(workspace), {
    ...NO_MUTATIONS,
    memberRemovals: [
      { authorization: auth, guildId: "guild-id", userId: "app-2" },
      { authorization: auth, guildId: "guild-id", userId: "app-3" },
      { authorization: auth, guildId: "guild-id", userId: "app-9" },
    ],
    roleDeletes: [{ authorization: auth, guildId: "guild-id", roleId: "project-bot-role" }],
  });
  assert.equal(fs.statSync(backup).mode & 0o777, 0o700);
  for (const n of [2, 3, 9]) {
    assert.equal(fs.existsSync(stateDirOf(workspace, n)), false, `discord${n} is still in place`);
    const moved = path.join(backup, "state", `bot${n}`);
    assert.equal(fs.statSync(moved).mode & 0o777, 0o700);
    assert.equal(fs.readFileSync(path.join(moved, ".env"), "utf8"), `DISCORD_BOT_TOKEN=bot${n}-token\n`);
  }
  const registryBackup = path.join(backup, "registry.json");
  assert.equal(fs.statSync(registryBackup).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(registryBackup, "utf8"), before);
  assert.deepEqual(readRegistry(workspace), {
    discord_user_id: OWNER_ID,
    guild_id: "guild-id",
    root_channels: ["root-channel"],
    projects: {
      demo: { channel_id: "demo-channel", type: "claude", webhook_id: "webhook-demo", guest_user_ids: ["guest-id"] },
      beta: { channel_id: "beta-channel", type: "codex", webhook_id: "webhook-beta", ws_port: 4501 },
    },
  });
  assert.doesNotMatch(fs.readFileSync(registryFile(workspace), "utf8"), /token/);
});

test("re-running --apply after retirement is a clean no-op", async () => {
  const workspace = poolWorkspace();
  const first = await retire(workspace, ["--apply"]);
  assert.equal(first.exitCode, 0, first.stderr || first.stdout);
  const retired = fs.readFileSync(registryFile(workspace), "utf8");
  const mutations = discordMutations(workspace);

  const result = await retire(workspace, ["--apply"]);

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.equal(result.stdout.trim(), "the Bot Pool is already retired; nothing to do");
  assert.equal(fs.readFileSync(registryFile(workspace), "utf8"), retired);
  assert.deepEqual(discordMutations(workspace), mutations);
  assert.deepEqual(mutations.applicationDeletes, []);
});
