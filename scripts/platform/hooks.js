"use strict";

// The command string for a Claude Code command hook. Claude Code runs hook
// commands through Git Bash, or PowerShell when Git is absent, and a backslash
// path does not survive those, so Windows gets forward slashes. POSIX gets the
// launchers' long-standing string. ccdmlib/platform/hooks.py builds the same one.
const WIN32 = process.platform === "win32";

// A single quote is written the POSIX-shell way, so only Git Bash runs a Windows
// path that contains one; PowerShell would need a different spelling.
function quoted(part) {
  const text = WIN32 ? String(part).replaceAll("\\", "/") : String(part);
  return `'${text.replaceAll("'", "'\\''")}'`;
}

function hookCommand(script, ...args) {
  return ["node", ...[script, ...args].map(quoted)].join(" ");
}

module.exports = { hookCommand };
