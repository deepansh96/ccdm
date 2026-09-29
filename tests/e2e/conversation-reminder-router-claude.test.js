import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { injectDiscordMessage, waitForState } from "./support/bridge.js";
import { runScript } from "./support/runner.js";
import {
  OWNER_ID,
  ROOT_TOKEN,
  createRouterWorkspace,
  routerEnv,
  routerWithWebhooks,
} from "./support/router.js";
import { readState, writeState } from "./support/state.js";
import { cleanup } from "./support/teardown.js";

test.afterEach(async () => {
  await cleanup();
});

// Conversation Reminders for router-transport Claude projects: the real Router,
// the real channel server under a fake `claude` that runs its command hooks,
// the real reminder service, and the fake Discord. `ensure-webhook` gives demo
// `fake-webhook-1`; no pool bot exists, so nothing but root can send.
function reminderRouterWorkspace() {
  const workspace = createRouterWorkspace({
    discord_user_id: OWNER_ID,
    guild_id: "guild-id",
    projects: {
      demo: { channel_id: "demo-channel", type: "claude", transport: "router", screen_name: "demo_claude",
        assignment_generation: "gen-demo", session_id: null, pid: null },
    },
  });
  const registryFile = path.join(workspace.repoDir, "registry.json");
  const registry = JSON.parse(fs.readFileSync(registryFile, "utf8"));
  registry.projects.demo.path = workspace.tmpDir;
  fs.writeFileSync(registryFile, `${JSON.stringify(registry, null, 2)}\n`);
  const clockFile = path.join(workspace.tmpDir, "reminder-clock");
  const stateDir = path.join(workspace.homeDir, ".local", "state", "ccdm", "conversation-reminders");
  return {
    workspace,
    stateDir,
    markerPath: path.join(stateDir, "capabilities", "demo.json"),
    setClock: (value) => fs.writeFileSync(clockFile, value),
    env: { CCDM_REMINDER_NODE: process.execPath, CCDM_REMINDER_CLOCK_FILE: clockFile },
  };
}

async function service(context, name, extra = {}) {
  const result = await runScript(context.workspace, "scripts/conversation-reminder-service.py", {
    args: [name, "--project-root", context.workspace.repoDir, "--state-dir", context.stateDir],
    env: routerEnv(context.workspace, context.env), ...extra,
  });
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function readiness(context) {
  return runScript(context.workspace, "scripts/conversation-reminder-readiness.py", {
    args: ["demo", "--json", "--project-root", context.workspace.repoDir, "--state-dir", context.stateDir],
    env: routerEnv(context.workspace, context.env),
  });
}

async function waitForStatus(context, predicate, attempts = 400) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const current = await service(context, "status");
    if (predicate(current)) return current;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for status: ${JSON.stringify(await service(context, "status"))}`);
}

function startSession(context) {
  return runScript(context.workspace, "scripts/start-session.sh", {
    args: ["demo"], env: routerEnv(context.workspace), timeoutMs: 30000,
  });
}

function stopSession(context) {
  return runScript(context.workspace, "scripts/stop-session.sh", { args: ["demo"], env: routerEnv(context.workspace) });
}

const owner = { id: OWNER_ID, username: "Owner" };
const reminders = (state) => (state.fixtures.discord.messages ?? []).filter((row) => row.content === "👀");

test("a router Claude reply and Stop hook get a 👀 from root with a nonce, an owner reply clears it, and /close never reaches Claude", async () => {
  const context = reminderRouterWorkspace();
  const { workspace } = context;
  const seed = readState(workspace.stateDir);
  seed.fixtures.discord.history = { "demo-channel": [] };
  // Claude answers the owner's message, naming it as the interaction answered.
  seed.fixtures.claude.toolScript = [{ name: "reply", arguments: {
    chat_id: "{{chat_id}}", text: "Here is the answer", conversation_interaction_id: "{{message_id}}",
    conversation_disposition: "progress",
  } }];
  writeState(seed, workspace.stateDir);
  await routerWithWebhooks(workspace, ["demo"]);
  const started = await startSession(context);
  assert.equal(started.exitCode, 0, started.stderr || started.stdout);

  const now = Date.now();
  const at = (offset) => new Date(now + offset).toISOString().replace(/\.\d{3}Z$/, "Z");
  await service(context, "enable");
  context.setClock(at(0));
  const running = runScript(workspace, "scripts/conversation-reminder-service.py", {
    args: ["run", "--project-root", workspace.repoDir, "--state-dir", context.stateDir],
    env: routerEnv(workspace, context.env), timeoutMs: 60000,
  });
  await waitForStatus(context, (current) => current.conversations.demo?.reconciliation_status === "ready");

  injectDiscordMessage(workspace, { id: "question-1", channelId: "demo-channel", author: owner, content: "answer this" });
  const answered = await waitForStatus(context, (current) => current.conversations.demo.state === "awaiting-owner");
  const answer = readState(workspace.stateDir).fixtures.discord.messages.find((row) => row.webhookId === "fake-webhook-1");
  assert.equal(answer.content, "Here is the answer");
  assert.equal(answered.conversations.demo.response_message_id, answer.id);
  assert.equal(answered.conversations.demo.identity, "router:fake-webhook-1");

  // An hour of owner silence: root posts 👀 with an enforced nonce.
  context.setClock(at(61 * 60000));
  const reminded = await waitForStatus(context, (current) => current.conversations.demo.reminder_message_id);
  const [reminder, ...others] = reminders(readState(workspace.stateDir));
  assert.deepEqual(others, []);
  assert.equal(reminded.conversations.demo.reminder_message_id, reminder.id);
  assert.deepEqual([reminder.channelId, reminder.authorization, reminder.requestBody.enforce_nonce],
    ["demo-channel", `Bot ${ROOT_TOKEN}`, true]);
  assert.equal(typeof reminder.requestBody.nonce, "string");

  // The owner's reply clears the reminder; Claude keeps working without answering.
  const quiet = readState(workspace.stateDir);
  delete quiet.fixtures.claude.toolScript;
  writeState(quiet, workspace.stateDir);
  injectDiscordMessage(workspace, { id: "reply-1", channelId: "demo-channel", author: owner, content: "thanks, go on" });
  const cleared = await waitForStatus(context, (current) => current.conversations.demo.state === "open-paused" &&
    current.conversations.demo.cleanup_message_ids.length === 0 && !current.conversations.demo.reminder_message_id);
  assert.equal(cleared.conversations.demo.last_ack_message_id, "reply-1");
  await waitForState(workspace, (next) => next.fixtures.discord.deletes.some((row) => row.messageId === reminder.id));

  // /close closes the conversation, and Claude receives no notification for it.
  injectDiscordMessage(workspace, { id: "close-1", channelId: "demo-channel", author: owner, content: "/close" });
  await waitForStatus(context, (current) => current.conversations.demo.state === "closed");
  await waitForState(workspace, (next) => (next.fixtures.discord.reactions ?? []).some((row) =>
    row.messageId === "close-1" && decodeURIComponent(row.emoji) === "✅"));
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepEqual(readState(workspace.stateDir).fixtures.claude.channelNotifications.map((row) => row.meta.message_id),
    ["question-1", "reply-1"]);

  await service(context, "disable");
  const stopped = await running;
  assert.equal(stopped.exitCode, 0, stopped.stderr || stopped.stdout);
});

test("the router Claude capability marker lives with the channel server and is gone after stop or relaunch", async () => {
  const context = reminderRouterWorkspace();
  const { workspace } = context;
  await routerWithWebhooks(workspace, ["demo"]);
  const started = await startSession(context);
  assert.equal(started.exitCode, 0, started.stderr || started.stdout);

  const marker = JSON.parse(fs.readFileSync(context.markerPath, "utf8"));
  assert.deepEqual([marker.project, marker.channel_id, marker.assignment_generation, marker.transport,
    marker.hooks_configured, marker.reply_tool_verified], ["demo", "demo-channel", "gen-demo", "ccdm-channel-server", true, true]);
  assert.equal(fs.statSync(context.markerPath).mode & 0o777, 0o600);
  const ready = await readiness(context);
  assert.equal(ready.exitCode, 0, ready.stdout || ready.stderr);
  assert.deepEqual(JSON.parse(ready.stdout).unsupported_capabilities, []);

  const stopped = await stopSession(context);
  assert.equal(stopped.exitCode, 0, stopped.stderr || stopped.stdout);
  await waitForState(workspace, () => !fs.existsSync(context.markerPath));
  const blocked = await readiness(context);
  assert.equal(blocked.exitCode, 2);
  assert.match(JSON.parse(blocked.stdout).unsupported_capabilities.join(" "),
    /Claude launch-scoped transport is not verified for this assignment; restart the session with scripts\/start-session.sh demo/);

  // A relaunch replaces the marker with its own channel server's.
  const relaunched = await startSession(context);
  assert.equal(relaunched.exitCode, 0, relaunched.stderr || relaunched.stdout);
  const next = JSON.parse(fs.readFileSync(context.markerPath, "utf8"));
  assert.notEqual(next.launch_id, marker.launch_id);
  assert.notEqual(next.pid, marker.pid);
});

test("a router Claude launch loads the hooks but no reminder proxy", async () => {
  const context = reminderRouterWorkspace();
  const { workspace } = context;
  await routerWithWebhooks(workspace, ["demo"]);
  const started = await startSession(context);
  assert.equal(started.exitCode, 0, started.stderr || started.stdout);

  const launchDir = path.join(workspace.routerStateDir, "launches", "demo");
  const mcpConfig = JSON.parse(fs.readFileSync(path.join(launchDir, "mcp.json"), "utf8"));
  assert.deepEqual(Object.keys(mcpConfig.mcpServers), ["ccdm"]);
  const state = readState(workspace.stateDir);
  const surfaces = [
    JSON.stringify(state.fixtures.claude.invocations),
    state.fixtures.tmux.sessions.demo_claude.shellCommand,
    ...fs.readdirSync(launchDir).map((file) => fs.readFileSync(path.join(launchDir, file), "utf8")),
  ];
  for (const text of surfaces) assert.equal(text.includes("claude-reminder-channel"), false, text.slice(0, 200));
  const settings = JSON.parse(fs.readFileSync(path.join(launchDir, "settings.json"), "utf8"));
  const hook = `node '${path.join(workspace.repoDir, "scripts", "claude-reminder-hook.js")}'`;
  assert.deepEqual(settings, {
    enabledPlugins: { "discord@claude-plugins-official": false },
    hooks: Object.fromEntries(["SessionStart", "Stop", "StopFailure", "SessionEnd"].map((event) =>
      [event, [{ hooks: [{ type: "command", command: hook }] }]])),
  });
});
