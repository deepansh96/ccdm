"use strict";

// Starts `ccdm restart-session` for a channel's /restart, and `ccdm restart-root`
// for root Codex's. Stopping a session ends everything in it, so the helper runs
// outside: a direct detached process on macOS and Linux, a child of ccdm-host on
// Windows, in no session's Job.
const path = require("node:path");

const { stateRoot } = require("../platform/paths.js");
const { pythonInvocation } = require("../platform/tools.js");
const sessionHost = require("./session-host.js");

const ROOT_DIR = path.resolve(__dirname, "..", "..");
const CCDM_ENTRY = path.join(ROOT_DIR, "scripts", "ccdm.py");
// ccdm-host gives a helper only the CCDM* names it is passed. These two say which
// accounts the session was started with, and a registry entry need not name one.
const ACCOUNT_VARIABLES = ["CLAUDE_CONFIG_DIR", "CODEX_HOME"];

function restartLogPath(project) {
  return path.join(stateRoot(), "logs", `restart-${project.replace(/[^a-zA-Z0-9._-]/g, "_")}.log`);
}

// The caller's CCDM* variables, without the session's own name: the helper belongs to no session.
function helperEnv() {
  const env = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (/^CCDM/i.test(name) && name.toUpperCase() !== "CCDM_SESSION_NAME") env[name] = value;
  }
  for (const name of ACCOUNT_VARIABLES) {
    if (process.env[name]) env[name] = process.env[name];
  }
  env.CCDM_DETACHED = "1";
  return env;
}

// What a root restart reads besides the account: which root channel, port and users.
const ROOT_VARIABLES = [
  "ROOT_CODEX_HOME", "ROOT_CODEX_CHANNEL_ID", "ROOT_CODEX_WS_PORT", "ROOT_CODEX_ALLOWED_USER_IDS",
  "ROOT_CODEX_BOT_APP_ID", "ROOT_DISCORD_STATE_DIR",
];

// The same log a `ccdm restart-root` run from inside root's own session writes.
function rootRestartLogPath() {
  return path.join(stateRoot(), "logs", "restart-root-root_agent.log");
}

// Starts `ccdm restart-root --provider codex <channel>` for root Codex's /restart.
// Root keeps its own command: `restart-session` never restarts root.
async function scheduleRootRestart(channelId, { afterPid, afterStartedAt } = {}) {
  const log = rootRestartLogPath();
  const args = [CCDM_ENTRY, "restart-root", "--provider", "codex"];
  if (afterPid) args.push("--after-pid", String(afterPid));
  if (afterPid && afterStartedAt) args.push("--after-started-at", String(afterStartedAt));
  args.push("--", String(channelId));
  const helper = helperEnv();
  for (const name of ROOT_VARIABLES) {
    if (process.env[name]) helper[name] = process.env[name];
  }
  const [command, argv, { env }] = pythonInvocation(args, { env: helper });
  await sessionHost.runDetached([command, ...argv], { cwd: ROOT_DIR, env, log });
  return log;
}

// `afterPid` and `afterStartedAt` name a process the helper waits for first.
async function scheduleProjectRestart(project, { afterPid, afterStartedAt } = {}) {
  const log = restartLogPath(project);
  const args = [CCDM_ENTRY, "restart-session", project];
  if (afterPid) args.push("--after-pid", String(afterPid));
  if (afterPid && afterStartedAt) args.push("--after-started-at", String(afterStartedAt));
  const [command, argv, { env }] = pythonInvocation(args, { env: helperEnv() });
  await sessionHost.runDetached([command, ...argv], { cwd: ROOT_DIR, env, log });
  return log;
}

module.exports = { restartLogPath, rootRestartLogPath, scheduleProjectRestart, scheduleRootRestart };
