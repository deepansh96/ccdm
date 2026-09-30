"use strict";

// Tells the Conversation Reminder service a project's identity changed, as
// registration workflows do, so its reminders move to a fresh assignment.
const { execFile } = require("node:child_process");
const path = require("node:path");

const SERVICE = path.resolve(__dirname, "../conversation-reminder-service.py");

function assignmentChanged(project, { registryFile }) {
  return new Promise((resolve, reject) => {
    execFile("python3", [SERVICE, "assignment-changed", "--project", project,
      "--project-root", path.dirname(registryFile)], { timeout: 60000 }, (error, _stdout, stderr) => {
      if (error) reject(new Error(`assignment-changed ${project} failed: ${stderr.trim() || error.message}`));
      else resolve();
    });
  });
}

module.exports = { assignmentChanged };
