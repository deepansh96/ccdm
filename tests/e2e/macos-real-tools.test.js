// Today's tmux command shapes against Homebrew tmux and real zsh, which the rest
// of the suite replaces with fixtures. TMUX is unset and TMUX_TMPDIR is inside
// the workspace, so nothing here can reach the user's own tmux server.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import nodeTest from "node:test";

import { suiteTest } from "./support/platform.js";
import { createWorkspace, scaledTimeout } from "./support/runner.js";
import { cleanup, registerTeardownCallback } from "./support/teardown.js";

const test = suiteTest(nodeTest, import.meta.url);
const SESSION = "ccdm-real-tools";

function homebrewTmux() {
  const tmux = ["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux"].find(candidate => fs.existsSync(candidate));
  assert.ok(tmux, "Homebrew tmux is required: brew install tmux");
  return tmux;
}

// A tmux bound to one workspace-private server, which teardown stops.
function privateTmux(t) {
  t.after(() => cleanup());
  const workspace = createWorkspace();
  const binary = homebrewTmux();
  const socketDir = path.join(workspace.tmpRoot, "tmux");
  fs.mkdirSync(socketDir);
  const env = {
    HOME: workspace.homeDir,
    PATH: `${path.dirname(binary)}:/usr/bin:/bin`,
    TMPDIR: workspace.tmpRoot,
    TMUX_TMPDIR: socketDir,
    LANG: "en_US.UTF-8",
  };
  const tmux = (...args) => spawnSync(binary, args, { env, encoding: "utf8", timeout: scaledTimeout(10000) });
  registerTeardownCallback(() => { tmux("kill-server"); });
  const launchDir = path.join(workspace.tmpRoot, "launch-dir");
  fs.mkdirSync(launchDir);
  return { tmux, socketDir, launchDir, env };
}

// The launchers' shape: tmux new-session -d -s NAME -- zsh -ic "cd 'DIR' && VAR='x' TOOL"
function startSession({ tmux, launchDir }, name = SESSION) {
  const tool = `/bin/sh -c 'echo "probe=$CCDM_PROBE dir=\${PWD##*/}"; exec /bin/cat'`;
  const launched = tmux("new-session", "-d", "-s", name, "--", "zsh", "-ic",
    `cd '${launchDir}' && CCDM_PROBE='from-launch' ${tool}`);
  assert.equal(launched.status, 0, launched.stderr);
}

async function waitForPane({ tmux }, expected, name = SESSION) {
  const deadline = Date.now() + scaledTimeout(10000);
  let pane = "";
  while (Date.now() < deadline) {
    const captured = tmux("capture-pane", "-t", `=${name}:`, "-p");
    assert.equal(captured.status, 0, captured.stderr);
    pane = captured.stdout;
    if (expected.test(pane)) return pane;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.fail(`pane never matched ${expected}; it holds:\n${pane}`);
}

test("the session starts on a socket inside the workspace, with the launch's cwd and environment", async t => {
  const session = privateTmux(t);
  assert.equal(session.env.TMUX, undefined);
  startSession(session);

  await waitForPane(session, /probe=from-launch dir=launch-dir/);

  const socket = session.tmux("display-message", "-p", "-t", `=${SESSION}:`, "#{socket_path}");
  assert.equal(socket.status, 0, socket.stderr);
  const inside = `${fs.realpathSync(session.socketDir)}${path.sep}`;
  assert.ok(fs.realpathSync(socket.stdout.trim()).startsWith(inside), socket.stdout);
});

test("has-session and kill-session match the exact name with =", async t => {
  const session = privateTmux(t);
  const longer = `${SESSION}-longer`;
  startSession(session, longer);
  await waitForPane(session, /probe=from-launch/, longer);

  assert.notEqual(session.tmux("has-session", "-t", `=${SESSION}`).status, 0, "= must not match a longer name");
  assert.equal(session.tmux("has-session", "-t", SESSION).status, 0, "without = tmux takes a prefix");
  assert.notEqual(session.tmux("kill-session", "-t", `=${SESSION}`).status, 0);
  assert.equal(session.tmux("has-session", "-t", `=${longer}`).status, 0);

  assert.equal(session.tmux("kill-session", "-t", `=${longer}`).status, 0);
  assert.notEqual(session.tmux("has-session", "-t", `=${longer}`).status, 0);
});

test("send-keys -l types its text literally and capture-pane reads it back", async t => {
  const session = privateTmux(t);
  startSession(session);
  await waitForPane(session, /probe=from-launch/);

  const typed = session.tmux("send-keys", "-t", SESSION, "-l", "/compact Enter");
  assert.equal(typed.status, 0, typed.stderr);
  const enter = session.tmux("send-keys", "-t", SESSION, "Enter");
  assert.equal(enter.status, 0, enter.stderr);

  // The terminal echoes the typed line and cat prints it back once it is ended.
  const pane = await waitForPane(session, /\/compact Enter\n\/compact Enter/);
  assert.equal(pane.match(/\/compact Enter/g).length, 2, pane);
});
