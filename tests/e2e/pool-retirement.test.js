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

function retire(workspace, args = [], extraEnv = {}) {
  return runScript(workspace, "scripts/retire-pool.sh", {
    args, env: routerEnv(workspace, { CCDM_ROUTER_NODE: process.execPath, ...extraEnv }), timeoutMs: 30000,
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

test("a freshly registered project with no transport or pool markers does not block retirement", async () => {
  const workspace = poolWorkspace();
  const registry = readRegistry(workspace);
  // Registration writes no `transport`, and the project never had a pool bot.
  registry.projects.fresh = { channel_id: "fresh-channel", type: "claude", webhook_id: "webhook-fresh" };
  writeRegistry(workspace, registry);

  const result = await retire(workspace, ["--apply"]);

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.deepEqual(result.stdout.trim().split("\n"), expectedActions(workspace).map(action => `done: ${action}`));
  assert.deepEqual(readRegistry(workspace).projects.fresh,
    { channel_id: "fresh-channel", type: "claude", webhook_id: "webhook-fresh" });
});

test("a retirement interrupted between project strips finishes on the rerun, and a further rerun is a no-op", async () => {
  const workspace = poolWorkspace();
  const hold = path.join(workspace.tmpDir, "registry-hold");
  const waitForPause = async () => {
    const deadline = Date.now() + 20000;
    while (!fs.existsSync(`${hold}.waiting`) || fs.existsSync(`${hold}.release`)
      || !/^\d+\n$/.test(fs.readFileSync(`${hold}.waiting`, "utf8"))) {
      assert.ok(Date.now() < deadline, "retirement never paused at its next registry write");
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    return Number(fs.readFileSync(`${hold}.waiting`, "utf8"));
  };
  // Pause at the top-level strip, then at demo's strip, then at beta's, and
  // kill the run there: demo is stripped, beta is not.
  fs.writeFileSync(`${hold}.armed`, "");
  const interrupted = retire(workspace, ["--apply"], { CCDM_TEST_REGISTRY_HOLD: hold });
  for (let write = 0; write < 2; write++) {
    await waitForPause();
    fs.writeFileSync(`${hold}.armed`, "");
    fs.writeFileSync(`${hold}.release`, "");
  }
  process.kill(await waitForPause(), "SIGKILL");
  assert.notEqual((await interrupted).exitCode, 0);
  const partial = readRegistry(workspace);
  assert.equal("pool" in partial, false);
  assert.deepEqual(partial.projects.demo,
    { channel_id: "demo-channel", type: "claude", webhook_id: "webhook-demo", guest_user_ids: ["guest-id"] });
  assert.deepEqual({ bot_id: partial.projects.beta.bot_id, transport: partial.projects.beta.transport },
    { bot_id: "bot3", transport: "router" });

  const rerun = await retire(workspace, ["--apply"]);

  assert.equal(rerun.exitCode, 0, rerun.stderr || rerun.stdout);
  const backup = `${workspace.homeDir}/.local/state/ccdm/pool-retirement`;
  assert.deepEqual(rerun.stdout.trim().split("\n"), [
    `done: back up the registry to ${backup}/registry.json`,
    "done: strip bot_id, transport from project beta",
  ]);
  const retired = fs.readFileSync(registryFile(workspace), "utf8");
  assert.deepEqual(JSON.parse(retired).projects.beta,
    { channel_id: "beta-channel", type: "codex", webhook_id: "webhook-beta", ws_port: 4501 });
  // The first run's backup, made before anything was stripped, is kept.
  assert.equal(JSON.parse(fs.readFileSync(`${backup}/registry.json`, "utf8")).pool.length, 3);

  const again = await retire(workspace, ["--apply"]);

  assert.equal(again.exitCode, 0, again.stderr || again.stdout);
  assert.equal(again.stdout.trim(), "the Bot Pool is already retired; nothing to do");
  assert.equal(fs.readFileSync(registryFile(workspace), "utf8"), retired);
});

test("state directories written with a leading ~ are expanded and moved, not skipped", async () => {
  const workspace = poolWorkspace();
  const registry = readRegistry(workspace);
  for (const bot of registry.pool) bot.state_dir = bot.state_dir.replace(workspace.homeDir, "~");
  writeRegistry(workspace, registry);

  const dryRun = await retire(workspace);
  assert.equal(dryRun.exitCode, 0, dryRun.stderr);
  assert.deepEqual(dryRun.stdout.trim().split("\n").slice(1), expectedActions(workspace).map(action => `would ${action}`));

  const result = await retire(workspace, ["--apply"]);

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.deepEqual(result.stdout.trim().split("\n"), expectedActions(workspace).map(action => `done: ${action}`));
  const backup = path.join(workspace.homeDir, ".local/state/ccdm/pool-retirement");
  for (const n of [2, 3, 9]) {
    assert.equal(fs.existsSync(stateDirOf(workspace, n)), false, `discord${n} is still in place`);
    assert.equal(fs.readFileSync(path.join(backup, "state", `bot${n}`, ".env"), "utf8"), `DISCORD_BOT_TOKEN=bot${n}-token\n`);
  }
});

test("a state directory that cannot be retired is reported as skipped and the run exits non-zero", async () => {
  const workspace = poolWorkspace();
  const registry = readRegistry(workspace);
  registry.pool[0].state_dir = "channels/discord2"; // relative: not resolvable
  registry.pool[1].state_dir = "~/.claude/channels/missing3"; // expanded, but absent
  delete registry.pool[2].state_dir;
  writeRegistry(workspace, registry);
  const home = workspace.homeDir;
  const skips = [
    "move state directory channels/discord2 of bot2: not an absolute path",
    `move state directory ${home}/.claude/channels/missing3 of bot3: it does not exist`,
    "move the state directory of bot9: the registry names none",
  ];

  const dryRun = await retire(workspace);
  assert.equal(dryRun.exitCode, 0, dryRun.stderr);
  for (const skip of skips) assert.ok(dryRun.stdout.includes(`would skip ${skip}\n`), dryRun.stdout);
  assert.doesNotMatch(dryRun.stdout, /would move state directory/);

  const result = await retire(workspace, ["--apply"]);

  assert.equal(result.exitCode, 2, result.stdout);
  for (const skip of skips) assert.ok(result.stdout.includes(`skipped: ${skip}\n`), result.stdout);
  assert.match(result.stderr, /the Bot Pool was retired, but 3 items were skipped and need manual review:/);
  for (const skip of skips) assert.ok(result.stderr.includes(`  ${skip}`), result.stderr);
  assert.doesNotMatch(result.stdout, /done: move state directory/);
  // Everything else still happened, and the untouched directories stay in place.
  assert.equal("pool" in readRegistry(workspace), false);
  for (const n of [2, 3, 9]) assert.ok(fs.existsSync(stateDirOf(workspace, n)), `discord${n} was moved`);
});
