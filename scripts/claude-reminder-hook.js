#!/usr/bin/env node
"use strict";

// Claude Code command hooks receive JSON on stdin. No prompt/agent hook is used.
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const reminder = require("./conversation-reminder-adapter.js");

const root = process.env.CCDM_REMINDER_PROJECT_ROOT || path.resolve(__dirname, "..");
const project = process.env.CCDM_CLAUDE_PROJECT;
const channel = process.env.CCDM_CLAUDE_CHANNEL_ID;
const appId = process.env.CCDM_CLAUDE_BOT_APP_ID;
const launchId = process.env.CCDM_CLAUDE_LAUNCH_ID;
const stateDir = process.env.CCDM_REMINDER_STATE_DIR || path.join(os.homedir(), ".local", "state", "ccdm", "conversation-reminders");
const receiptsDir = process.env.CCDM_REMINDER_RECEIPTS_DIR || path.join(stateDir, "claude-receipts");
const bindingPath = path.join(stateDir, "claude-sessions", `${launchId}.json`);

async function readInput() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  return JSON.parse(input);
}

async function readReceipts() {
  const names = await fs.readdir(receiptsDir).catch(() => []);
  const receipts = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const marker = JSON.parse(await fs.readFile(path.join(receiptsDir, name), "utf8"));
      if (marker.provider_session_id === launchId) receipts.push(marker);
    } catch { /* An unreadable marker cannot qualify completion. */ }
  }
  return receipts.sort((a, b) => a.event_order.localeCompare(b.event_order));
}

async function removeReceipts(receipts) {
  for (const marker of receipts) await fs.rm(path.join(receiptsDir, `${marker.event_id}.json`), { force: true });
}

async function main() {
  if (!project || !channel || !appId || !launchId) return;
  const input = await readInput();
  if (!input.session_id || input.agent_id) return;
  const assignment = await reminder.resolveAssignmentForChannel(channel, {
    registryPath: path.join(root, "registry.json"), botAppId: appId,
  });
  if (!assignment || assignment.project !== project || assignment.project_type !== "claude") return;
  const context = { ...assignment, provider: "claude", provider_session_id: launchId };
  if (input.hook_event_name === "SessionStart") {
    await fs.mkdir(path.dirname(bindingPath), { recursive: true, mode: 0o700 });
    await fs.chmod(path.dirname(bindingPath), 0o700);
    await fs.writeFile(bindingPath, JSON.stringify({
      schema_version: 1, session_id: input.session_id, assignment_generation: assignment.assignment_generation,
    }) + "\n", { mode: 0o600 });
    return;
  }
  let binding;
  try { binding = JSON.parse(await fs.readFile(bindingPath, "utf8")); } catch { return; }
  if (binding.session_id !== input.session_id || binding.assignment_generation !== assignment.assignment_generation) return;
  const receipts = await readReceipts();
  if (input.hook_event_name === "Stop") {
    // Missing task-registry fields are ambiguous; never infer a finished turn.
    if (!Array.isArray(input.background_tasks) || !Array.isArray(input.session_crons) ||
        input.background_tasks.length || input.session_crons.length) return;
    const grouped = new Map();
    for (const marker of receipts) {
      const key = `${marker.provider_turn_id}\0${marker.interaction_id}`;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(marker);
    }
    for (const group of grouped.values()) {
      const first = group[0];
      await reminder.emitEvent("turn_completed", {
        ...context, provider_turn_id: first.provider_turn_id, interaction_id: first.interaction_id,
      }, { delivered_message_ids: [...new Set(group.map(item => item.message_id))] });
    }
    await removeReceipts(receipts);
  } else if (input.hook_event_name === "StopFailure") {
    await removeReceipts(receipts);
  } else if (input.hook_event_name === "SessionEnd") {
    await reminder.emitEvent("session_terminated", context);
    await removeReceipts(receipts);
    await fs.rm(bindingPath, { force: true });
  }
}

main().catch(error => {
  process.stderr.write(`Claude reminder hook failed: ${error.message}\n`);
  process.exitCode = 1;
});
