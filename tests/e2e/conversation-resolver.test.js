import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { createWorkspace, runScript } from "./support/runner.js";
import { readState } from "./support/state.js";
import { cleanup } from "./support/teardown.js";

test.afterEach(async () => cleanup());

// A Discord thread snowflake under alpha's channel; Discord type 11 is a public thread.
const THREAD = "1500000000000123456";
const PUBLIC_THREAD = 11;

function setup(workspace, projects = {}) {
  fs.writeFileSync(path.join(workspace.repoDir, "registry.json"), JSON.stringify({
    discord_user_id: "owner", guild_id: "guild",
    pool: [{ id: "bot2", app_id: "alpha-app", token: "alpha-token" },
      { id: "bot3", app_id: "beta-app", token: "beta-token" }],
    projects: {
      alpha: { type: "claude", path: "/work/alpha", bot_id: "bot2", channel_id: "channel-alpha",
        screen_name: "alpha_session" },
      beta: { type: "codex", path: "/work/beta", bot_id: "bot3", channel_id: "channel-beta",
        screen_name: "beta_session" },
      ...projects,
    },
  }), { mode: 0o600 });
}

// Binds a thread the way the Thread Supervisor does when its observer sees an owner create one.
async function bindThread(workspace, threadId, parentId) {
  const result = await runScript(workspace, "scripts/thread-supervisor.py", {
    args: ["bind", "--payload", JSON.stringify({ thread_id: threadId, type: PUBLIC_THREAD, parent_id: parentId,
      creator_id: "owner", name: "Task", auto_archive_duration: 10080 })],
  });
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.equal(JSON.parse(result.stdout).result, "bound");
}

function resolve(workspace, id) {
  return runScript(workspace, "scripts/resolve-conversation.py", { args: [id] });
}

test("the resolver maps a project channel to its project with no thread", async () => {
  const workspace = createWorkspace();
  setup(workspace);

  const result = await resolve(workspace, "channel-beta");

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.deepEqual(JSON.parse(result.stdout),
    { project: "beta", thread_id: null, provider: "codex", bot: "bot3", channel_id: "channel-beta" });
});

test("the resolver maps a bound thread to its parent project and the thread", async () => {
  const workspace = createWorkspace();
  setup(workspace);
  await bindThread(workspace, THREAD, "channel-alpha");

  const result = await resolve(workspace, THREAD);

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.deepEqual(JSON.parse(result.stdout),
    { project: "alpha", thread_id: THREAD, provider: "claude", bot: "bot2", channel_id: "channel-alpha" });
});

test("the resolver exits nonzero with a reason for an unknown id and never calls Discord", async () => {
  const workspace = createWorkspace();
  setup(workspace);
  await bindThread(workspace, THREAD, "channel-alpha");

  const result = await resolve(workspace, "1500000000000999999");

  assert.notEqual(result.exitCode, 0);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /No project channel or bound thread is registered for 1500000000000999999/);
  const discord = readState(workspace.stateDir).fixtures.discord;
  assert.deepEqual([discord.messageFetches, discord.fetches, discord.messages], [[], [], []]);
});

test("the resolver exits nonzero with a reason for a channel two projects claim", async () => {
  const workspace = createWorkspace();
  setup(workspace, { gamma: { type: "claude", path: "/work/gamma", bot_id: "bot3", channel_id: "channel-alpha" } });

  const result = await resolve(workspace, "channel-alpha");

  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /Channel channel-alpha matches multiple projects: alpha, gamma/);
});
