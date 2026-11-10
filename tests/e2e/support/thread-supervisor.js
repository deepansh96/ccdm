import fs from "node:fs";
import path from "node:path";

import { routerEnv, runRouterCli, waitFor } from "./router.js";
import { runScript, scaledTimeout } from "./runner.js";
import { fakeHostEnv, startFakeHost } from "./session-fixture.js";
import { workspaceOwnsPid } from "./teardown.js";

// The Thread Supervisor's private state, under the Test Workspace's home.
export function supervisorStateDir(workspace) {
  return path.join(workspace.homeDir, ".local", "state", "ccdm", "thread-supervisor");
}

// Waits until a Codex thread's bridge has finished its turn: it marks the
// thread idle in its activity file only once a new message would start a
// turn rather than steer the finished one.
export async function waitForThreadIdle(workspace, project, threadId, timeoutMs = 20000) {
  const file = path.join(workspace.routerStateDir, "launches", project, "threads", threadId, "activity.json");
  const idle = () => {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8")).turn_running === false;
    } catch {
      return false;
    }
  };
  await waitFor(idle, () => `thread ${threadId}'s session to finish its turn`, timeoutMs);
}

// A workspace's thread sessions run on the fake ccdm-host: always on Windows, and
// wherever a test asks. It is shared by the worker and anything that launches or
// inspects a session for the same workspace. Its env moves CCDM_STATE_ROOT, so the
// supervisor's own state is pinned where supervisorStateDir() says.
const fakeHosts = new WeakMap();

export async function startThreadHost(workspace) {
  if (!fakeHosts.has(workspace)) fakeHosts.set(workspace, await startFakeHost(workspace, { env: routerEnv(workspace) }));
  return fakeHosts.get(workspace);
}

// For a worker that starts before its host, as at logon: the worker and every
// supervisor command get the fake host's environment now, and
// startThreadSupervisor starts no host. The test starts it with startThreadHost.
const lateHosts = new WeakSet();

export function expectLateThreadHost(workspace) {
  lateHosts.add(workspace);
}

// The worker launches its Node link through CCDM_ROUTER_NODE, as the session
// launchers do, and finds the Router through CCDM_ROUTER_STATE_DIR.
export function supervisorEnv(workspace, extraEnv = {}) {
  const host = fakeHosts.get(workspace)?.env ?? (lateHosts.has(workspace) ? fakeHostEnv(workspace) : null);
  const hostEnv = host ? { ...host, CCDM_THREAD_SUPERVISOR_STATE_DIR: supervisorStateDir(workspace) } : {};
  return routerEnv(workspace, { ...hostEnv, ...extraEnv });
}

// One supervisor CLI command; `json` is its parsed stdout, when it has any.
export async function supervisorCli(workspace, command, { env = {}, timeoutMs } = {}) {
  const result = await runScript(workspace, "scripts/thread-supervisor.py", {
    args: [command], env: supervisorEnv(workspace, env), ...(timeoutMs ? { timeoutMs } : {}),
  });
  let json = null;
  try {
    json = JSON.parse(result.stdout);
  } catch { /* Not JSON. */ }
  return { ...result, json };
}

export async function supervisorStatus(workspace) {
  const result = await supervisorCli(workspace, "status");
  if (result.exitCode !== 0) throw new Error(`thread supervisor status failed: ${result.stderr || result.stdout}`);
  return result.json;
}

// worker_pid comes from status on disk, so it may not be the worker any more.
// Returns whether the worker was signalled. Windows has no SIGTERM to catch, so
// there the worker is asked through the stop file, as a service manager would.
export function signalSupervisorWorker(workspace, workerPid) {
  if (!workspaceOwnsPid(workerPid, workspace.tmpRoot)) return false;
  if (process.platform === "win32" && fs.existsSync(supervisorStateDir(workspace))) {
    fs.writeFileSync(path.join(supervisorStateDir(workspace), "stop"), "");
    return true;
  }
  try {
    process.kill(workerPid, "SIGTERM");
  } catch { /* Already gone. */ }
  return true;
}

// Starts the real worker (`run`, the foreground mode) against the harness
// Router and resolves once `router status` shows its link holding the
// `supervisor` connection. `result` resolves with the worker's exit; `stop()`
// sends the worker SIGTERM and resolves with that exit.
export async function startThreadSupervisor(workspace, { env = {} } = {}) {
  if (process.platform === "win32" && !lateHosts.has(workspace)) await startThreadHost(workspace);
  fs.mkdirSync(workspace.tmpDir, { recursive: true });
  const result = runScript(workspace, "scripts/thread-supervisor.py", {
    args: ["run"], env: supervisorEnv(workspace, { CCDM_E2E_STACK_DUMP_DIR: workspace.tmpDir, ...env }), timeoutMs: 60000,
  });
  let exited = null;
  result.then(value => { exited = value; });
  const deadline = Date.now() + 15000;
  for (;;) {
    if (exited) throw new Error(`the thread supervisor exited early: ${exited.stderr || exited.stdout}`);
    const output = await runRouterCli(workspace, ["status"]);
    if (/^supervisor: connected/m.test(output.stdout)) break;
    if (Date.now() > deadline) throw new Error(`the supervisor never connected: ${output.stdout}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  // `status` reads the worker's pid from its health file, which the worker
  // replaces as its link connects; a read that meets the replace reports no pid.
  // stop() needs the pid to ask the worker to end, so it is waited for here.
  let current;
  const pidDeadline = Date.now() + 15000;
  for (;;) {
    current = await supervisorStatus(workspace);
    if (Number.isInteger(current.worker_pid) && Number.isInteger(current.link_pid)) break;
    if (Date.now() > pidDeadline) throw new Error(`the supervisor never reported its pid: ${JSON.stringify(current)}`);
    await delay(50);
  }
  return {
    result,
    workerPid: current.worker_pid,
    linkPid: current.link_pid,
    async stop() {
      const asked = signalSupervisorWorker(workspace, current.worker_pid);
      const ended = await Promise.race([result, delay(scaledTimeout(STOP_WAIT_MS)).then(() => null)]);
      if (ended) return ended;
      // The worker did not end when asked. What it was doing goes into
      // `stopEvidence`, and it is ended here so the test fails now, not at the
      // worker's own time limit.
      const seen = stopAccount(workspace, current, asked);
      fs.writeFileSync(path.join(workspace.tmpDir, `dump-${current.worker_pid}`), "");
      await delay(STACK_DUMP_WAIT_MS);
      if (workspaceOwnsPid(current.worker_pid, workspace.tmpRoot)) {
        try {
          process.kill(current.worker_pid, "SIGKILL");
        } catch { /* Gone meanwhile. */ }
      }
      const killed = await Promise.race([result, delay(scaledTimeout(5000)).then(() => null)]);
      if (!killed) return { exitCode: null, signal: null, stdout: "", stderr: "", stopEvidence: `${seen}\n`
        + "the worker's output did not close even after it was ended: another process holds it" };
      return { ...killed, stopEvidence: `${seen}\nworker exit ${killed.exitCode} after it was ended; its stderr `
        + `(with each thread's stack, when it could still print one):\n${killed.stderr}` };
    },
  };
}

// How long a worker gets to end after it is asked (scaled), and how long it then
// gets to print its stacks before it is ended.
const STOP_WAIT_MS = 10000;
const STACK_DUMP_WAIT_MS = 3000;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function readOr(file) {
  try {
    return fs.readFileSync(file, "utf8").trim() || "(empty)";
  } catch (error) {
    return error.code ?? error.message;
  }
}

// What a worker that did not stop left to see: whether it was asked, whether the
// stop file is still there, and its health file, which it removes only once its
// loop and its link and control channel have closed.
function stopAccount(workspace, current, asked) {
  const dir = supervisorStateDir(workspace);
  return [
    `the worker (pid ${current.worker_pid}) did not end within ${scaledTimeout(STOP_WAIT_MS) / 1000} s of the stop request`,
    `asked: ${asked ? (process.platform === "win32" ? "stop file written" : "SIGTERM sent")
      : "no (its pid failed the ownership check)"}`,
    // Alive but with its output closed would mean a child still holds the worker's stdio.
    `worker process: ${processAlive(current.worker_pid) ? "still running" : "gone (its output pipes are still open)"}`,
    `stop file: ${fs.existsSync(path.join(dir, "stop")) ? "present" : "absent"}`,
    `worker.json: ${readOr(path.join(dir, "worker.json"))}`,
  ].join("\n");
}

// Asserts the worker ended by itself when asked, with what was seen when it did not.
export async function assertSupervisorStops(supervisor) {
  const stopped = await supervisor.stop();
  if (stopped.exitCode !== 0) {
    throw new Error(`the thread supervisor did not stop cleanly (exit ${stopped.exitCode}):\n`
      + `${stopped.stopEvidence ?? `stderr:\n${stopped.stderr}`}`);
  }
  return stopped;
}
