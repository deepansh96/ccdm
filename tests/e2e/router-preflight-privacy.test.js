import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { platformGate, PYTHON } from "./support/platform.js";
import { createRouterWorkspace, routerEnv, runRouterCli } from "./support/router.js";
import { runNodeEntrypoint } from "./support/runner.js";
import { cleanup } from "./support/teardown.js";

// Windows only: on POSIX the same preflight is covered, with its chmod text, by
// router-installer.test.js and the contract cases.
const windowsOnly = platformGate("win32", "Windows DACL behaviour");
const BUILTIN_USERS = "S-1-5-32-545";
const ICACLS = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "icacls.exe");
const SCRIPTS = fileURLToPath(new URL("../../scripts", import.meta.url));
const privacy = process.platform === "win32" ? createRequire(import.meta.url)(path.join(SCRIPTS, "platform", "privacy.js")) : null;

test.afterEach(async () => {
  await cleanup();
});

function icacls(...args) {
  const result = spawnSync(ICACLS, args, { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, `icacls ${args.join(" ")}: ${result.stdout}${result.stderr}`);
}

function runFixLines(lines) {
  for (const line of lines) {
    const at = line.indexOf("; run icacls ");
    assert.ok(at >= 0, `no fix command in: ${line}`);
    const command = line.slice(at + "; run ".length);
    const result = spawnSync(command, { shell: "cmd.exe", encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, `${command}: ${result.stdout}${result.stderr}`);
  }
}

const tokenDir = workspace => path.join(workspace.homeDir, ".claude", "channels", "discord");

// A workspace whose token and state directories are both private.
function privateWorkspace() {
  const workspace = createRouterWorkspace();
  privacy.ensurePrivateDirSync(tokenDir(workspace));
  privacy.ensurePrivateDirSync(workspace.routerStateDir);
  return workspace;
}

async function preflight(workspace, env = {}) {
  const result = await runNodeEntrypoint(workspace, "scripts/router.js", {
    args: ["preflight"], env: routerEnv(workspace, env),
  });
  return { exitCode: result.exitCode, ...JSON.parse(result.stdout), stderr: result.stderr };
}

function assertBlocked(result, dir) {
  assert.equal(result.exitCode, 1, JSON.stringify(result));
  assert.equal(result.ready, false);
  assert.ok(result.blockers.length > 0);
  assert.ok(result.blockers.every(line => line.includes(dir) && line.includes("; run icacls ")),
    result.blockers.join("\n"));
}

test("preflight passes when the state and token directories are user-only and protected", windowsOnly, async () => {
  const workspace = privateWorkspace();
  const result = await preflight(workspace);
  assert.deepEqual(result.blockers, []);
  assert.equal(result.ready, true);
  assert.equal(result.exitCode, 0);
});

test("an inherited state directory blocks, and its printed fix lines clear it", windowsOnly, async () => {
  const workspace = privateWorkspace();
  fs.rmSync(workspace.routerStateDir, { recursive: true, force: true });
  fs.mkdirSync(workspace.routerStateDir);
  const blocked = await preflight(workspace);
  assertBlocked(blocked, workspace.routerStateDir);
  assert.match(blocked.blockers[0], /Router state directory .* inherits permissions/);
  runFixLines(blocked.blockers);
  const fixed = await preflight(workspace);
  assert.deepEqual(fixed.blockers, []);
  assert.equal(fixed.exitCode, 0);
});

test("an explicit foreign entry blocks, and its printed fix lines clear it", windowsOnly, async () => {
  const workspace = privateWorkspace();
  icacls(workspace.routerStateDir, "/grant", `*${BUILTIN_USERS}:(OI)(CI)R`);
  const blocked = await preflight(workspace);
  assertBlocked(blocked, workspace.routerStateDir);
  assert.deepEqual(blocked.blockers, [
    `Router state directory ${workspace.routerStateDir} gives access to ${BUILTIN_USERS}; run icacls "${workspace.routerStateDir}" /remove:g *${BUILTIN_USERS}`,
  ]);
  runFixLines(blocked.blockers);
  const fixed = await preflight(workspace);
  assert.deepEqual(fixed.blockers, []);
});

test("a directory another SID owns blocks and names the owner fix; nothing is changed", windowsOnly, async () => {
  const workspace = privateWorkspace();
  // The Windows directory is only read; its fix lines are never run.
  const systemRoot = process.env.SystemRoot;
  const blocked = await preflight(workspace, { CCDM_ROUTER_STATE_DIR: systemRoot });
  assert.equal(blocked.exitCode, 1);
  const owner = blocked.blockers.find(line => line.includes("is owned by"));
  assert.ok(owner, blocked.blockers.join("\n"));
  assert.ok(owner.includes(systemRoot));
  assert.match(owner, /; run icacls "[^"]+" \/setowner \*S-1-5-21-/);
});

test("a token directory that is not private blocks with fix text, and the fix clears it", windowsOnly, async () => {
  const workspace = privateWorkspace();
  icacls(tokenDir(workspace), "/inheritance:e");
  const blocked = await preflight(workspace);
  assertBlocked(blocked, tokenDir(workspace));
  assert.match(blocked.blockers[0], /Root token directory/);
  runFixLines(blocked.blockers);
  assert.deepEqual((await preflight(workspace)).blockers, []);
});

function runPython(workspace, source, args) {
  return spawnSync(PYTHON, ["-c", source, ...args], {
    encoding: "utf8",
    env: { ...routerEnv(workspace), PYTHONPATH: SCRIPTS },
    windowsHide: true,
  });
}

const STORE_SCRIPT = `
import sys
from pathlib import Path
from thread_supervisor import store
target = Path(sys.argv[1])
db = store.connect(target, create=True)
db.close()
print(store.inspect(target) is not None)
`;

const CHECK_STORE_SCRIPT = `
import sys
from pathlib import Path
from thread_supervisor import store
try:
    store.inspect(Path(sys.argv[1]))
    print("inspect accepted")
except ValueError as error:
    print("inspect refused:", error)
try:
    db = store.connect(Path(sys.argv[1]))
    db.close()
    print("connect accepted")
except ValueError as error:
    print("connect refused:", error)
`;

const EVENTS_SCRIPT = `
import importlib.util, json, sys
from pathlib import Path
spec = importlib.util.spec_from_file_location("events", sys.argv[2])
events = importlib.util.module_from_spec(spec)
sys.modules["events"] = events
spec.loader.exec_module(events)
state = Path(sys.argv[1])
if sys.argv[3] == "create":
    events.connect_database(state, create=True).close()
print(json.dumps(events.status_for(state, "demo")))
`;

test("the thread store and event database open in a protected dir and are refused in an inherited one", windowsOnly, () => {
  const workspace = privateWorkspace();
  const stateDir = path.join(workspace.tmpRoot, "supervisor");
  const created = runPython(workspace, STORE_SCRIPT, [stateDir]);
  assert.equal(created.status, 0, created.stderr);
  assert.match(created.stdout, /True/);
  assert.equal(privacy.isPrivateFile(path.join(stateDir, "threads.sqlite3")), true);

  const accepted = runPython(workspace, CHECK_STORE_SCRIPT, [stateDir]);
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.match(accepted.stdout, /inspect accepted\s+connect accepted/);

  icacls(stateDir, "/inheritance:e");
  const refused = runPython(workspace, CHECK_STORE_SCRIPT, [stateDir]);
  assert.equal(refused.status, 0, refused.stderr);
  assert.match(refused.stdout, /inspect refused: thread store permissions are not private/);
  assert.match(refused.stdout, /connect refused: thread store permissions are not private/);

  const eventsDir = path.join(workspace.tmpRoot, "reminders");
  const eventsScript = path.join(SCRIPTS, "conversation-reminder-events.py");
  const open = runPython(workspace, EVENTS_SCRIPT, [eventsDir, eventsScript, "create"]);
  assert.equal(open.status, 0, open.stderr);
  assert.equal(JSON.parse(open.stdout).available, true, open.stdout);
  icacls(eventsDir, "/inheritance:e");
  const denied = runPython(workspace, EVENTS_SCRIPT, [eventsDir, eventsScript, "check"]);
  assert.equal(denied.status, 0, denied.stderr);
  const status = JSON.parse(denied.stdout);
  assert.equal(status.available, false, denied.stdout);
  assert.match(status.reason, /not private/);
});

test("the thread store's privacy check passes for guest-access and exports, and fails when it is not private", windowsOnly, async () => {
  const workspace = privateWorkspace();
  const supervisorDir = path.join(workspace.tmpRoot, "supervisor");
  const created = runPython(workspace, STORE_SCRIPT, [supervisorDir]);
  assert.equal(created.status, 0, created.stderr);
  const env = { ...routerEnv(workspace), CCDM_THREAD_SUPERVISOR_STATE_DIR: supervisorDir };
  const resolved = await runNodeEntrypoint(workspace, "scripts/conversation-resolver.js", { args: ["demo-channel"], env });
  assert.equal(resolved.exitCode, 0, resolved.stderr || resolved.stdout);
  assert.doesNotMatch(resolved.stderr, /not private/);

  icacls(supervisorDir, "/inheritance:e");
  const refused = await runNodeEntrypoint(workspace, "scripts/conversation-resolver.js", { args: ["demo-channel"], env });
  assert.notEqual(refused.exitCode, 0);
  assert.match(`${refused.stderr}${refused.stdout}`, /permissions are not private/);
});
