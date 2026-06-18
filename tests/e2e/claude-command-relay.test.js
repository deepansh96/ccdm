import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { createWorkspace, runScript } from "./support/runner.js";
import { readState, seedRegistry, seedTmuxSession } from "./support/state.js";
import { cleanup } from "./support/teardown.js";

test.afterEach(async () => {
  await cleanup();
});

function buildRegistry(workspace, overrides = {}) {
  return {
    discord_user_id: "allowed-user-id",
    guild_id: "guild-id",
    max_pool_size: 50,
    project_bot_role_id: null,
    category_ids: [],
    pool: [
      {
        id: "bot2",
        app_id: "bot-app-id",
        token: "bot-token",
        state_dir: path.join(workspace.homeDir, ".claude", "channels", "discord2"),
        assigned_to: "alpha",
      },
    ],
    projects: {
      alpha: {
        path: path.join(workspace.tmpDir, "alpha project"),
        bot_id: "bot2",
        screen_name: "alpha_session",
        channel_id: "channel-alpha",
        type: "claude",
        session_id: "session-alpha",
        pid: 1234,
        ...(overrides.alpha ?? {}),
      },
      ...(overrides.extraProjects ?? {}),
    },
  };
}

test("send-claude-command relays /compact by project name into the Claude tmux session", async () => {
  const workspace = createWorkspace();
  seedRegistry(workspace, buildRegistry(workspace));
  seedTmuxSession("alpha_session", { paneOutput: "Listening\n" }, { stateDir: workspace.stateDir });

  const result = await runScript(workspace, "scripts/send-claude-command.sh", {
    args: ["alpha", "compact"],
  });

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Sent \/compact to Claude project 'alpha'/);
  const session = readState(workspace.stateDir).fixtures.tmux.sessions.alpha_session;
  assert.deepEqual(session.sendKeys, [["-l", "/compact"], ["Enter"]]);
});

test("send-claude-command resolves a project channel and relays /clear", async () => {
  const workspace = createWorkspace();
  seedRegistry(workspace, buildRegistry(workspace));
  seedTmuxSession("alpha_session", { paneOutput: "Listening\n" }, { stateDir: workspace.stateDir });

  const result = await runScript(workspace, "scripts/send-claude-command.sh", {
    args: ["--channel", "channel-alpha", "/clear"],
  });

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Sent \/clear to Claude project 'alpha'/);
  const session = readState(workspace.stateDir).fixtures.tmux.sessions.alpha_session;
  assert.deepEqual(session.sendKeys, [["-l", "/clear"], ["Enter"]]);
});

test("send-claude-command refuses non-Claude and remote targets", async () => {
  const codexWorkspace = createWorkspace();
  seedRegistry(
    codexWorkspace,
    buildRegistry(codexWorkspace, {
      alpha: { type: "codex", screen_name: "alpha_codex", ws_port: 18342 },
    }),
  );
  seedTmuxSession("alpha_codex", { paneOutput: "Codex bridge\n" }, { stateDir: codexWorkspace.stateDir });

  const codexResult = await runScript(codexWorkspace, "scripts/send-claude-command.sh", {
    args: ["alpha", "/compact"],
  });

  assert.equal(codexResult.exitCode, 1);
  assert.match(codexResult.stderr, /not 'claude'/);
  assert.equal(readState(codexWorkspace.stateDir).fixtures.tmux.sessions.alpha_codex.sendKeys, undefined);
  await cleanup();

  const remoteWorkspace = createWorkspace();
  seedRegistry(
    remoteWorkspace,
    buildRegistry(remoteWorkspace, {
      alpha: { path: "remote:vm-alpha" },
    }),
  );
  seedTmuxSession("alpha_session", { paneOutput: "Listening\n" }, { stateDir: remoteWorkspace.stateDir });

  const remoteResult = await runScript(remoteWorkspace, "scripts/send-claude-command.sh", {
    args: ["alpha", "/clear"],
  });

  assert.equal(remoteResult.exitCode, 1);
  assert.match(remoteResult.stderr, /is remote/);
  assert.equal(readState(remoteWorkspace.stateDir).fixtures.tmux.sessions.alpha_session.sendKeys, undefined);
});

test("send-claude-command validates the command and running session", async () => {
  const workspace = createWorkspace();
  seedRegistry(workspace, buildRegistry(workspace));

  const invalid = await runScript(workspace, "scripts/send-claude-command.sh", {
    args: ["alpha", "/context"],
  });

  assert.equal(invalid.exitCode, 2);
  assert.match(invalid.stderr, /Unsupported command/);

  const stopped = await runScript(workspace, "scripts/send-claude-command.sh", {
    args: ["alpha", "/compact"],
  });

  assert.equal(stopped.exitCode, 1);
  assert.match(stopped.stderr, /is not running/);
});
