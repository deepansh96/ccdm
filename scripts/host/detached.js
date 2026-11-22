"use strict";

// run-detached: a helper that must outlive the session that asked for it. It is
// a child of the host, in no session's Job, so killing that session leaves it.
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const { sessionEnvironment } = require("./env.js");
const { ERRORS, HostError, okResponse } = require("./protocol.js");

// A session's environment, minus the name that would make the helper look like
// part of a session, even when the request passes it on.
function helperEnvironment(explicit, hostEnv) {
  const env = sessionEnvironment("", explicit ?? {}, hostEnv);
  for (const name of Object.keys(env)) {
    if (name.toUpperCase() === "CCDM_SESSION_NAME") delete env[name];
  }
  return env;
}

async function runDetached({ argv, cwd, env: explicit, log }, hostEnv) {
  if (!Array.isArray(argv) || argv.length === 0 || !argv.every(arg => typeof arg === "string")) {
    throw new HostError(ERRORS.SPAWN_FAILED, "argv must be a non-empty array of strings");
  }
  if (typeof log !== "string" || !path.isAbsolute(log)) {
    throw new HostError(ERRORS.SPAWN_FAILED, "log must be an absolute path");
  }
  let logFd = null;
  try {
    fs.mkdirSync(path.dirname(log), { recursive: true });
    logFd = fs.openSync(log, "a");
    // Not `detached`: that leaves the helper without a console, and each console
    // program it then ran would open a window. windowsHide gives it a hidden one.
    const child = spawn(argv[0], argv.slice(1), {
      cwd, env: helperEnvironment(explicit, hostEnv), stdio: ["ignore", logFd, logFd], windowsHide: true,
    });
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    child.on("error", () => {});
    child.unref();
    return okResponse(null, { pid: child.pid });
  } catch (error) {
    throw new HostError(ERRORS.SPAWN_FAILED, error.message);
  } finally {
    if (logFd !== null) fs.closeSync(logFd);
  }
}

module.exports = { runDetached };
