// The byte-exact tmux launch strings of today's six launchers. The fake tmux
// records its raw argv; a launcher that exits right after new-session is enough,
// because only the launch string is compared here (the other suites cover the rest).
// The one allowed difference is one appended CCDM_SESSION_NAME='<name>' assignment.
// Every launcher slice keeps this file passing.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { startFakeCodexServer } from "./support/bridge.js";
import { PYTHON, platformGate } from "./support/platform.js";
import { createRouterWorkspace, routerEnv, routerRegistry, routerWithWebhooks } from "./support/router.js";
import { createWorkspace, runScript } from "./support/runner.js";
import { callSeam, tmuxCalls } from "./support/session-fixture.js";
import { updateState } from "./support/state.js";
import { cleanup } from "./support/teardown.js";

test.afterEach(cleanup);

const THREAD_ID = "1700000000000123456";

// `<NAME>` placeholders stand for the workspace's paths and port.
const GOLDEN = {
  "claude-project":
    "cd '<PROJECT>' && CCDM_ROUTER_KEY_FILE='<ROUTER>/keys/demo.key' CCDM_REMINDER_PROJECT_ROOT='<REPO>' CCDM_REMINDER_STATE_DIR='<HOME>/.local/state/ccdm/conversation-reminders' CCDM_REMINDER_RECEIPTS_DIR='<HOME>/.local/state/ccdm/conversation-reminders/claude-receipts' CCDM_CLAUDE_PROJECT='demo' CCDM_CLAUDE_CHANNEL_ID='demo-channel' CCDM_CLAUDE_LAUNCH_ID='<LAUNCH_ID>' CCDM_CLAUDE_HOOK_SETTINGS='<ROUTER>/launches/demo/settings.json' claude --dangerously-load-development-channels server:ccdm --dangerously-skip-permissions --mcp-config '<ROUTER>/launches/demo/mcp.json' --settings '<ROUTER>/launches/demo/settings.json'",
  "codex-project":
    "cd '<REPO>' && CODEX_HOME='<HOME>/.codex' CCDM_CODEX_PROJECT='codexdemo' CCDM_ROUTER_STATE_DIR='<ROUTER>' CCDM_ROUTER_KEY_FILE='<ROUTER>/keys/codexdemo.key' CCDM_CHANNEL_READY_FILE='<ROUTER>/launches/codexdemo/ready.json' CHANNEL_ID='codex-channel' PROJECT_DIR='<PROJECT>' WS_PORT='<PORT>' ALLOWED_USER_IDS='owner-id,guest-id' CODEX_SERVICE_TIER='default' CODEX_RESUME_THREAD_ID='' node scripts/codex-bridge.js",
  "claude-thread":
    "cd '<PROJECT>' && CCDM_ROUTER_KEY_FILE='<ROUTER>/keys/.thread-1700000000000123456.key' CCDM_REMINDER_PROJECT_ROOT='<REPO>' CCDM_REMINDER_STATE_DIR='<HOME>/.local/state/ccdm/conversation-reminders' CCDM_REMINDER_RECEIPTS_DIR='<HOME>/.local/state/ccdm/conversation-reminders/claude-receipts' CCDM_CLAUDE_PROJECT='demo' CCDM_CLAUDE_CHANNEL_ID='demo-channel' CCDM_CLAUDE_CONVERSATION_ID='1700000000000123456' CCDM_CLAUDE_LAUNCH_ID='<LAUNCH_ID>' claude --dangerously-load-development-channels server:ccdm --dangerously-skip-permissions --mcp-config '<ROUTER>/launches/demo/threads/1700000000000123456/mcp.json' --settings '<ROUTER>/launches/demo/threads/1700000000000123456/settings.json'",
  "codex-thread":
    "cd '<REPO>' && CODEX_HOME='<HOME>/.codex' CCDM_CODEX_PROJECT='demo' CCDM_ROUTER_STATE_DIR='<ROUTER>' CCDM_ROUTER_KEY_FILE='<ROUTER>/keys/.thread-1700000000000123456.key' CCDM_CHANNEL_READY_FILE='<ROUTER>/launches/demo/threads/1700000000000123456/ready.json' CHANNEL_ID='1700000000000123456' PROJECT_DIR='<PROJECT>' WS_PORT='<PORT>' ALLOWED_USER_IDS='owner-id,guest-id' CCDM_THREAD_ID='1700000000000123456' CCDM_THREAD_PROVIDER='codex' CCDM_THREAD_BOOTSTRAP_FILE='<ROUTER>/launches/demo/threads/1700000000000123456/bootstrap.json' CCDM_THREAD_ACTIVITY_FILE='<ROUTER>/launches/demo/threads/1700000000000123456/activity.json' CODEX_SERVICE_TIER='default' node scripts/codex-bridge.js",
  "claude-root":
    "cd '<REPO>' && CCDM_ROUTER_KEY_FILE='<ROUTER>/keys/.root.key' claude --dangerously-load-development-channels server:ccdm --mcp-config '<ROUTER>/launches/.root/mcp.json' --settings '<ROUTER>/launches/.root/settings.json' --dangerously-skip-permissions",
  "codex-root":
    "cd '<REPO>' && CODEX_HOME='<HOME>/.codex' CCDM_ROUTER_ROLE='root' CCDM_ROUTER_STATE_DIR='<ROUTER>' CCDM_ROUTER_KEY_FILE='<ROUTER>/keys/.root.key' CCDM_CHANNEL_READY_FILE='<ROUTER>/launches/.root/ready.json' CHANNEL_ID='root-channel' PROJECT_DIR='<REPO>' WS_PORT='<PORT>' ALLOWED_USER_IDS='owner-id,helper-id' ROOT_BOT_APP_ID='' BOT_APP_ID='' node scripts/codex-bridge.js",
};

// Exactly one appended assignment may be present; it is removed before comparing.
function withoutSessionName(command, name) {
  const assignment = ` CCDM_SESSION_NAME='${name}'`;
  const pieces = command.split(assignment);
  assert.ok(pieces.length <= 2, `more than one CCDM_SESSION_NAME assignment: ${command}`);
  return pieces.join("");
}

function goldenWorkspace(port) {
  const workspace = createRouterWorkspace({
    ...routerRegistry({
      demo: { channel_id: "demo-channel", type: "claude", transport: "router", guest_user_ids: ["guest-id"],
        screen_name: "demo_claude", session_id: null, pid: null },
      codexdemo: { channel_id: "codex-channel", type: "codex", transport: "router", guest_user_ids: ["guest-id"],
        screen_name: "demo_codex", ws_port: port, session_id: null, pid: null },
    }),
    root_channels: ["root-channel"],
    root_allowed_user_ids: ["helper-id"],
  });
  const registryFile = path.join(workspace.repoDir, "registry.json");
  const registry = JSON.parse(fs.readFileSync(registryFile, "utf8"));
  registry.projects.demo.path = workspace.tmpDir;
  registry.projects.codexdemo.path = workspace.tmpDir;
  fs.writeFileSync(registryFile, `${JSON.stringify(registry, null, 2)}\n`);
  fs.mkdirSync(path.join(workspace.homeDir, ".codex"), { recursive: true });
  return workspace;
}

// Longest first, and each path both as written and as the shell resolves it.
function normalized(workspace, text) {
  const paths = [["<ROUTER>", workspace.routerStateDir], ["<REPO>", workspace.repoDir], ["<PROJECT>", workspace.tmpDir], ["<HOME>", workspace.homeDir]]
    .flatMap(([placeholder, dir]) => [[placeholder, fs.realpathSync(dir)], [placeholder, dir]])
    .sort((a, b) => b[1].length - a[1].length);
  let result = text;
  for (const [placeholder, dir] of paths) result = result.split(dir).join(placeholder);
  return result.replace(/WS_PORT='\d+'/g, "WS_PORT='<PORT>'");
}

const LAUNCHERS = [
  { key: "claude-project", session: "demo_claude", script: "scripts/start-session.sh", args: ["demo"] },
  { key: "codex-project", session: "demo_codex", script: "scripts/start-codex-session.sh", args: ["codexdemo"] },
  { key: "claude-thread", session: `demo_claude-t-${THREAD_ID}`, script: "scripts/start-thread-session.sh", args: ["demo", THREAD_ID, "--provider", "claude"] },
  { key: "codex-thread", session: `demo_claude-t-${THREAD_ID}`, script: "scripts/start-thread-session.sh", args: ["demo", THREAD_ID, "--provider", "codex"], env: port => ({ CCDM_THREAD_WS_PORT: String(port) }) },
  { key: "claude-root", session: "root_agent", script: "restart-root-agent.sh", args: [] },
  { key: "codex-root", session: "root_agent", script: "restart-root-codex-agent.sh", args: ["root-channel"], env: port => ({ ROOT_CODEX_WS_PORT: String(port) }) },
];

test("the six launchers issue today's exact tmux new-session strings", platformGate("posix", "the launchers are zsh scripts until their port slices land"), async () => {
  const placeholderWorkspace = goldenWorkspace(0);
  const { port } = await startFakeCodexServer(placeholderWorkspace, { channelId: "codex-channel" });
  const registryFile = path.join(placeholderWorkspace.repoDir, "registry.json");
  const registry = JSON.parse(fs.readFileSync(registryFile, "utf8"));
  registry.projects.codexdemo.ws_port = port;
  fs.writeFileSync(registryFile, `${JSON.stringify(registry, null, 2)}\n`);
  await routerWithWebhooks(placeholderWorkspace, ["demo", "codexdemo"]);
  const workspace = placeholderWorkspace;
  updateState(workspace.stateDir, (state) => {
    state.fixtures.tmux.earlyExits = { demo_claude: 1, demo_codex: 1, [`demo_claude-t-${THREAD_ID}`]: 2, root_agent: 2 };
    return state;
  });

  const seen = {};
  for (const launcher of LAUNCHERS) {
    const before = tmuxCalls(workspace).length;
    const result = await runScript(workspace, launcher.script, { args: launcher.args, env: routerEnv(workspace, launcher.env?.(port) ?? {}), timeoutMs: 30000 });
    const calls = tmuxCalls(workspace).slice(before).filter(args => args[0] === "new-session");
    assert.equal(calls.length, 1, `${launcher.key} issued ${calls.length} new-session calls: ${result.stderr || result.stdout}`);
    const [, , , name, separator, shell, flag, command] = calls[0];
    assert.deepEqual([calls[0][0], calls[0][1], calls[0][2], name, separator, shell, flag], ["new-session", "-d", "-s", launcher.session, "--", "zsh", "-ic"]);
    seen[launcher.key] = withoutSessionName(normalized(workspace, command), launcher.session);
  }
  assert.deepEqual(seen, GOLDEN);
});

// A golden string back into what a launcher would hand the seam.
function parsedLaunch(shell) {
  const [, cwd, rest] = /^cd '([^']*)' && (.*)$/s.exec(shell);
  const env = {};
  let remaining = rest;
  for (;;) {
    const assignment = /^([A-Z_]+)='([^']*)' /.exec(remaining);
    if (!assignment) break;
    env[assignment[1]] = assignment[2];
    remaining = remaining.slice(assignment[0].length);
  }
  const argv = [...remaining.matchAll(/'([^']*)'|(\S+)/g)].map(match => match[1] ?? match[2]);
  return { argv, cwd, env };
}

const sessionOf = key => LAUNCHERS.find(launcher => launcher.key === key).session;

for (const language of ["node", "python"]) {
  test(`${language} tmux seam builds each golden launch string byte for byte, with one appended CCDM_SESSION_NAME`, async () => {
    const workspace = createWorkspace();
    for (const [key, shell] of Object.entries(GOLDEN)) {
      const session = sessionOf(key);
      const { argv, cwd, env } = parsedLaunch(shell);
      const positional = language === "node"
        ? [session, { argv, cwd, env, kind: "project" }]
        : [session, argv, cwd, env];
      const result = await callSeam(workspace, language, "tmuxLaunchCommand", { positional, env: { CCDM_SESSION_HOST: "tmux" }, python: PYTHON });
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(withoutSessionName(result.value, session), shell, key);
      assert.deepEqual(result.value.match(/CCDM_SESSION_NAME='[^']*'/g), [`CCDM_SESSION_NAME='${session}'`], key);
    }
  });
}
