import fs from "node:fs";
import path from "node:path";

import { routerEnv, runRouterCli, waitFor } from "./router.js";
import { runScript } from "./runner.js";

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

// The worker launches its Node link through CCDM_ROUTER_NODE, as the session
// launchers do, and finds the Router through CCDM_ROUTER_STATE_DIR.
export function supervisorEnv(workspace, extraEnv = {}) {
  return routerEnv(workspace, extraEnv);
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

// Starts the real worker (`run`, the foreground mode) against the harness
// Router and resolves once `router status` shows its link holding the
// `supervisor` connection. `result` resolves with the worker's exit; `stop()`
// sends the worker SIGTERM and resolves with that exit.
export async function startThreadSupervisor(workspace, { env = {} } = {}) {
  const result = runScript(workspace, "scripts/thread-supervisor.py", {
    args: ["run"], env: supervisorEnv(workspace, env), timeoutMs: 60000,
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
  const current = await supervisorStatus(workspace);
  return {
    result,
    workerPid: current.worker_pid,
    linkPid: current.link_pid,
    async stop() {
      try {
        process.kill(current.worker_pid, "SIGTERM");
      } catch { /* Already gone. */ }
      return result;
    },
  };
}
