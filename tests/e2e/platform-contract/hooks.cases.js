import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { gitBashTool } from "../support/platform.js";

const fn = { node: "hooks.hookCommand", python: "hooks.hook_command" };
const REMINDER = "scripts/claude-reminder-hook.js";
const ACTIVITY = "scripts/thread-activity.js";

// Exactly what start-session.sh and start-thread-session.sh write on POSIX.
const posixGolden = (script, ...args) => ["node", ...[script, ...args].map(part => `'${part}'`)].join(" ");

const powershell = () => path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");

// A generated command run the way Claude Code runs it, printing the arguments the script received.
function runThrough(shell, shellArgs, command, env) {
  const result = spawnSync(shell, [...shellArgs, command], { encoding: "utf8", env, windowsHide: true });
  assert.equal(result.status, 0, result.stderr || String(result.error));
  return JSON.parse(result.stdout);
}

function hookFixture(ctx) {
  const dir = path.join(ctx.dir, "a dir with spaces");
  fs.mkdirSync(dir);
  const script = path.join(dir, "hook.js");
  fs.writeFileSync(script, "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n");
  return { dir, script, target: path.join(dir, "activity.json") };
}

export default [
  {
    name: "POSIX: the reminder hook is byte-identical to the launchers' string",
    only: "posix",
    ...fn,
    args: [`/opt/ccdm/${REMINDER}`],
    value: posixGolden(`/opt/ccdm/${REMINDER}`),
  },
  {
    name: "POSIX: the activity hook with its argument is byte-identical to the launcher's string",
    only: "posix",
    ...fn,
    args: [`/opt/ccdm/${ACTIVITY}`, "/state/launches/t 1/activity.json"],
    value: posixGolden(`/opt/ccdm/${ACTIVITY}`, "/state/launches/t 1/activity.json"),
  },
  {
    name: "POSIX: a backslash in a path is left alone",
    only: "posix",
    ...fn,
    args: ["/opt/odd\\name/hook.js"],
    value: "node '/opt/odd\\name/hook.js'",
  },
  {
    name: "Windows: the reminder hook uses forward slashes",
    only: "win32",
    ...fn,
    args: [`C:\\ccdm repo\\${REMINDER.replace("/", "\\")}`],
    value: `node 'C:/ccdm repo/${REMINDER}'`,
  },
  {
    name: "Windows: the activity hook converts its argument too",
    only: "win32",
    ...fn,
    args: [`C:\\ccdm\\${ACTIVITY.replace("/", "\\")}`, "C:\\state\\launches\\t\\activity.json"],
    value: `node 'C:/ccdm/${ACTIVITY}' 'C:/state/launches/t/activity.json'`,
  },
  {
    name: "a single quote in a path is escaped for the shell",
    ...fn,
    args: ["/home/o'brien/hook.js"],
    value: "node '/home/o'\\''brien/hook.js'",
  },
  {
    name: "Windows: the generated command runs through Git Bash, with its argument",
    only: "win32",
    skipIf: () => (gitBashTool("bash") ? false : "no Git Bash here"),
    async check(_outcomes, ctx) {
      const { script, target } = hookFixture(ctx);
      const nodeDir = path.dirname(process.execPath);
      const command = await ctx.node(fn.node, script, target);
      const env = { ...process.env, PATH: `${nodeDir}${path.delimiter}${process.env.PATH}` };
      assert.deepEqual(runThrough(gitBashTool("bash"), ["-c"], command, env), [target.replaceAll("\\", "/")]);
    },
  },
  {
    name: "Windows: the generated command runs through PowerShell, with its argument",
    only: "win32",
    async check(_outcomes, ctx) {
      const { script, target } = hookFixture(ctx);
      const nodeDir = path.dirname(process.execPath);
      const command = await ctx.py(fn.python, script, target);
      const env = { ...process.env, PATH: `${nodeDir}${path.delimiter}${process.env.PATH}` };
      assert.deepEqual(runThrough(powershell(), ["-NoProfile", "-Command"], command, env), [target.replaceAll("\\", "/")]);
    },
  },
];
