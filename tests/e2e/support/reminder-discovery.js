// Shared setup for the history discovery suites: conversation-reminder-discovery
// and conversation-reminder-discovery-eligibility.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { runScript } from "./runner.js";
import { injectDiscordMessage, waitForState } from "./bridge.js";
import { routerEnv, startRouter } from "./router.js";
import { updateState } from "./state.js";

// History discovery scenarios drive the real foreground service against a
// stateful paginated Discord history fake. Timestamps are literal timelines.
// Every project is a Router project: the observer watches through the real
// Router, root reads history and sends with its own token, and each project's
// agent speaks through its webhook `hook-<name>`, so its identity is
// `router:hook-<name>`.

export async function setup(workspace, projects = { demo: "channel" }) {
  const names = Object.keys(projects);
  fs.writeFileSync(path.join(workspace.repoDir, "registry.json"), JSON.stringify({
    discord_user_id: "owner", guild_id: "guild",
    projects: Object.fromEntries(names.map(name => [name, {
      type: "codex", channel_id: projects[name], webhook_id: `hook-${name}`, assignment_generation: `gen-${name}`,
    }])),
  }), { mode: 0o600 });
  // Root's Discord state holds the only bot token, which the Router and the observer read.
  const rootState = path.join(workspace.homeDir, ".claude", "channels", "discord");
  fs.mkdirSync(rootState, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(rootState, ".env"), "DISCORD_BOT_TOKEN=fixture-root-token\n", { mode: 0o600 });
  await startRouter(workspace);
  return path.join(workspace.homeDir, ".local", "state", "ccdm", "conversation-reminders");
}

// An author named `hook-<name>` is that project's agent, posting through its webhook.
export function message(id, timestamp, author, content = "text", extra = {}) {
  const webhook = author.startsWith("hook-");
  return { id, timestamp, content, type: 0, attachments: [],
    author: { id: author, bot: webhook }, ...(webhook ? { webhook_id: author } : {}), ...extra };
}

// A live arrival is visible both to the Router's observer and to later history reads.
export function arrive(workspace, channelId, raw) {
  updateState(workspace.stateDir, (state) => {
    state.fixtures.discord.history[channelId].unshift(raw);
  });
  if (!raw.author.bot) {
    injectDiscordMessage(workspace, { channelId, id: raw.id, author: { id: raw.author.id }, content: raw.content });
  }
}

export function seedHistory(workspace, history, extra = {}) {
  updateState(workspace.stateDir, (state) => {
    state.fixtures.discord.history = history;
    Object.assign(state.fixtures.discord, extra);
  });
}

export async function command(workspace, stateDir, name, extra = {}) {
  const result = await runScript(workspace, "scripts/conversation-reminder-service.py", {
    args: [name, "--project-root", workspace.repoDir, "--state-dir", stateDir], env: routerEnv(workspace), ...extra,
  });
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

export async function adapterEvent(workspace, stateDir, type, id, time, fields = {}) {
  const value = {
    schema_version: 1, event_id: id, event_type: type, project: "demo", channel_id: "channel",
    bot_id: "router:hook-demo", assignment_generation: "gen-demo", provider: "codex",
    event_time: time, event_order: `${time}:${id}`, adapter_instance_id: "test-adapter", ...fields,
  };
  const result = await runScript(workspace, "scripts/conversation-reminder-events.py", {
    args: ["ingest", "--project-root", workspace.repoDir, "--state-dir", stateDir], env: routerEnv(workspace),
    input: JSON.stringify(value),
  });
  assert.equal(JSON.parse(result.stdout).status, "committed", result.stderr || result.stdout);
}

export function startWorker(workspace, stateDir, time) {
  const clockFile = path.join(workspace.tmpDir, "reminder-clock");
  fs.writeFileSync(clockFile, time);
  const running = runScript(workspace, "scripts/conversation-reminder-service.py", {
    args: ["run", "--project-root", workspace.repoDir, "--state-dir", stateDir],
    env: routerEnv(workspace, { CCDM_REMINDER_NODE: process.execPath, CCDM_REMINDER_CLOCK_FILE: clockFile }),
    timeoutMs: 20000,
  });
  return { running, setClock: value => fs.writeFileSync(clockFile, value) };
}

// The harness records every command invocation into the shared fixture state,
// which can race with the observer's own fixture writes. Wait read-only for
// fixture records before polling status while a scan is writing.
export function fetchCount(state, channelId) {
  return (state.fixtures.discord.historyFetches ?? []).filter(row => row.channelId === channelId).length;
}

export function waitForFixture(workspace, predicate) {
  return waitForState(workspace, predicate, 20000);
}

export async function waitForStatus(workspace, stateDir, predicate, attempts = 160) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const current = await command(workspace, stateDir, "status");
    if (predicate(current)) return current;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for status: ${JSON.stringify(await command(workspace, stateDir, "status"))}`);
}

export async function stop(workspace, stateDir, worker) {
  await command(workspace, stateDir, "disable");
  const result = await worker.running;
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
}

// Newest-first history: an owner question at 08:00:00 followed by `count - 1`
// bot progress messages one second apart, so the owner's participation sits
// on the last page.
export function longHistory(count, prefix = 100000) {
  const start = Date.parse("2026-09-20T08:00:00Z");
  return Array.from({ length: count }, (_, index) => {
    const at = new Date(start + index * 1000).toISOString().replace(".000Z", "Z");
    return index === 0 ? message(String(prefix), at, "owner", "Please run the migration")
      : message(String(prefix + index), at, "hook-demo", `progress ${index}`);
  }).reverse();
}

export async function scanFirstPass(workspace, stateDir, clock) {
  seedHistory(workspace, { channel: longHistory(1150) });
  await command(workspace, stateDir, "discover");
  const worker = startWorker(workspace, stateDir, clock);
  await waitForFixture(workspace, state => fetchCount(state, "channel") === 10);
  await new Promise(resolve => setTimeout(resolve, 400));
  return worker;
}
