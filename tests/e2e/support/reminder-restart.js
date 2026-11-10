// Shared setup for the Conversation Reminders restart suites: conversation-reminder-restart,
// conversation-reminder-restart-queue and conversation-reminder-restart-enable.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { runScript } from "./runner.js";
import { createRouterWorkspace, routerEnv, runRouterCli, startRouter } from "./router.js";
import { updateState } from "./state.js";

// Restart, reconnect, and re-enable scenarios drive the real foreground service
// and the real Router against the stateful Discord history fake with a
// controllable clock. Expected times come from literal timelines, never from
// the service's own calculation. Every project is a Router project that speaks
// through the webhook ensure-webhook gives it, so its identity is
// `router:<webhook_id>`, and root sends, acknowledges, and deletes with its token.

// Each project's webhook id, from the current test's registry.
export const webhooks = {};

export const hook = name => webhooks[name];

export async function setup(projects = { demo: "channel" }) {
  const names = Object.keys(projects);
  const workspace = createRouterWorkspace({
    discord_user_id: "owner", guild_id: "guild",
    projects: Object.fromEntries(names.map(name => [name, {
      type: "codex", channel_id: projects[name], assignment_generation: `gen-${name}`,
    }])),
  });
  for (const name of Object.keys(webhooks)) delete webhooks[name];
  for (const name of names) {
    const result = await runRouterCli(workspace, ["ensure-webhook", name]);
    assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  }
  const registry = JSON.parse(fs.readFileSync(path.join(workspace.repoDir, "registry.json"), "utf8"));
  for (const name of names) webhooks[name] = registry.projects[name].webhook_id;
  const clockFile = path.join(workspace.tmpDir, "reminder-clock");
  const context = { stateDir: path.join(workspace.homeDir, ".local", "state", "ccdm", "conversation-reminders"),
    clockFile, env: routerEnv(workspace, { CCDM_REMINDER_NODE: process.execPath, CCDM_REMINDER_CLOCK_FILE: clockFile,
      CCDM_ROUTER_RECONNECT_MIN_MS: "100", CCDM_ROUTER_RECONNECT_MAX_MS: "200" }),
    setClock: value => fs.writeFileSync(clockFile, value), router: null };
  return { workspace, context };
}

export const rootEnvFile = workspace => path.join(workspace.homeDir, ".claude", "channels", "discord", ".env");

// A message authored by a project's webhook is that project's agent reply.
export function message(id, timestamp, author, content = "text", extra = {}) {
  const webhook = Object.values(webhooks).includes(author);
  return { id, timestamp, content, type: 0, attachments: [],
    author: { id: author, bot: webhook }, ...(webhook ? { webhook_id: author } : {}), ...extra };
}

// An owner question at 08:00 answered by the project's webhook at 08:05.
export function answered(name, prefix = name) {
  return [message(`${prefix}-2`, "2026-09-20T08:05:00Z", hook(name), "Done"),
    message(`${prefix}-1`, "2026-09-20T08:00:00Z", "owner", "Please do it")];
}

export function seedHistory(workspace, history, extra = {}) {
  updateState(workspace.stateDir, (state) => {
    state.fixtures.discord.history = history;
    Object.assign(state.fixtures.discord, extra);
  });
}

// A message sent while nothing observed the Router exists only in history.
export function missed(workspace, channelId, raw) {
  updateState(workspace.stateDir, (state) => {
    state.fixtures.discord.history[channelId].unshift(raw);
  });
}

export async function command(workspace, context, name, extra = []) {
  const result = await runScript(workspace, "scripts/conversation-reminder-service.py", {
    args: [name, "--project-root", workspace.repoDir, "--state-dir", context.stateDir, ...extra], env: context.env,
  });
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

// The worker observes through the Router, so one runs before the first worker starts.
export async function startWorker(workspace, context) {
  context.router ??= await startRouter(workspace);
  return runScript(workspace, "scripts/conversation-reminder-service.py", {
    args: ["run", "--project-root", workspace.repoDir, "--state-dir", context.stateDir],
    env: context.env, timeoutMs: 120000,
  });
}

export async function stopWorker(workspace, context, running) {
  await command(workspace, context, "disable");
  const result = await running;
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
}

export async function waitForStatus(workspace, context, predicate, attempts = 200) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const current = await command(workspace, context, "status");
    if (predicate(current)) return current;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for status: ${JSON.stringify(await command(workspace, context, "status"))}`);
}

export const reminders = state => (state.fixtures.discord.messages ?? []).filter(row => row.content === "👀");

export const settle = (ms = 700) => new Promise(resolve => setTimeout(resolve, ms));

// Enable, discover, and reconcile every channel at 08:30, then stop the worker.
export async function discoveredThenStopped(workspace, context, names) {
  await command(workspace, context, "enable");
  context.setClock("2026-09-20T08:30:00Z");
  const first = startWorker(workspace, context);
  const ready = await waitForStatus(workspace, context, current => names.every(name =>
    current.conversations[name]?.reconciliation_status === "ready"));
  await stopWorker(workspace, context, first);
  return ready;
}

export async function adapterEvent(workspace, context, project, type, id, time, fields = {}) {
  const value = {
    schema_version: 1, event_id: id, event_type: type, project, channel_id: `${project}-channel`,
    bot_id: `router:${hook(project)}`, assignment_generation: `gen-${project}`, provider: "codex",
    event_time: time, event_order: `${time}:${id}`, adapter_instance_id: "test-adapter", ...fields,
  };
  const result = await runScript(workspace, "scripts/conversation-reminder-events.py", {
    args: ["ingest", "--project-root", workspace.repoDir, "--state-dir", context.stateDir],
    input: JSON.stringify(value),
  });
  assert.equal(JSON.parse(result.stdout).status, "committed", result.stderr || result.stdout);
}
