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
const GOLDEN = {};

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
  console.log(JSON.stringify(seen, null, 1));
  assert.deepEqual(seen, Object.fromEntries(Object.entries(GOLDEN).map(([key, value]) => [key, value.shell])));
});

for (const language of ["node", "python"]) {
  test(`${language} tmux seam builds each golden launch string byte for byte, with one appended CCDM_SESSION_NAME`, async () => {
    const workspace = createWorkspace();
    for (const [key, golden] of Object.entries(GOLDEN)) {
      const positional = language === "node"
        ? [golden.session, { argv: golden.argv, cwd: golden.cwd, env: golden.env, kind: "project" }]
        : [golden.session, golden.argv, golden.cwd, golden.env];
      const result = await callSeam(workspace, language, "tmuxLaunchCommand", { positional, env: { CCDM_SESSION_HOST: "tmux" }, python: PYTHON });
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(withoutSessionName(result.value, golden.session), golden.shell, key);
      const assignments = result.value.match(/CCDM_SESSION_NAME='[^']*'/g);
      assert.deepEqual(assignments, [`CCDM_SESSION_NAME='${golden.session}'`], key);
    }
  });
}
