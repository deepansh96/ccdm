"use strict";

// Whether a CCDM background service is installed for this user: a launchd
// plist on macOS, a scheduled task on Windows.
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Service name -> its Windows task, `\CCDM\<Task>` or `CCDM-<Task>`.
const SERVICE_TASKS = Object.freeze({
  router: "Router",
  host: "Host",
  "thread-supervisor": "ThreadSupervisor",
  reminders: "Reminders",
  "usage-poster": "UsagePoster",
  "root-at-logon": "RootAtLogon",
});

function taskExists(taskName) {
  return spawnSync("schtasks", ["/query", "/tn", taskName], { stdio: "ignore", windowsHide: true }).status === 0;
}

function serviceInstalled(name, platform = process.platform) {
  if (platform !== "win32") return fs.existsSync(path.join(os.homedir(), "Library", "LaunchAgents", `com.ccdm.${name}.plist`));
  const task = SERVICE_TASKS[name];
  if (!task) throw new Error(`unknown service: ${name}`);
  return taskExists(`\\CCDM\\${task}`) || taskExists(`CCDM-${task}`);
}

module.exports = { SERVICE_TASKS, serviceInstalled };
