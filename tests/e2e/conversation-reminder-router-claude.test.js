import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { assertPrivate } from "./support/platform.js";
import { injectDiscordMessage, waitForState } from "./support/bridge.js";
import { runScript } from "./support/runner.js";
import {
  OWNER_ID,
  ROOT_TOKEN,
  createRouterWorkspace,
  routerEnv,
  routerWithWebhooks,
} from "./support/router.js";
import { readState, updateState, writeState } from "./support/state.js";
import { cleanup } from "./support/teardown.js";
import { startThreadHost, supervisorEnv } from "./support/thread-supervisor.js";

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
      demo: { channel_id: "demo-channel", type: "claude", screen_name: "demo_claude",
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
  // What the fake Claude and Discord saw, so a timeout names the missing step.
  const { claude, discord } = readState(context.workspace.stateDir).fixtures;
  const channelLogs = fs.readdirSync(context.workspace.stateDir).filter((name) => name.startsWith("claude-channel-"))
    .map((name) => fs.readFileSync(path.join(context.workspace.stateDir, name), "utf8").slice(-4000));
  throw new Error(`Timed out waiting for status: ${JSON.stringify(await service(context, "status"))}\n` +
    `claude: ${JSON.stringify({ notifications: claude.channelNotifications, toolResults: claude.toolResults, hookRuns: claude.hookRuns })}\n` +
    `discord messages: ${JSON.stringify(discord.messages)}\nchannel server logs: ${channelLogs.join("\n---\n")}`);
}

// What a launcher runs with. On Windows the session runs on the fake ccdm-host,
// whose env moves the state root, so the reminder state is named; and the Bash
// launchers read UTF-8 pane text through Python, which defaults to the ANSI code page.
async function launcherEnv(context) {
  if (process.platform !== "win32") return routerEnv(context.workspace);
  await startThreadHost(context.workspace);
  return supervisorEnv(context.workspace, { CCDM_REMINDER_STATE_DIR: context.stateDir, PYTHONUTF8: "1" });
}

async function startSession(context) {
  return runScript(context.workspace, "scripts/start-session.sh", {
    args: ["demo"], env: await launcherEnv(context), timeoutMs: 30000,
  });
}

async function stopSession(context) {
  return runScript(context.workspace, "scripts/stop-session.sh", { args: ["demo"], env: await launcherEnv(context) });
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
  updateState(workspace.stateDir, (quiet) => {
    delete quiet.fixtures.claude.toolScript;
  });
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
  assertPrivate(context.markerPath);
  const ready = await readiness(context);
  assert.equal(ready.exitCode, 0, ready.stdout || ready.stderr);
  assert.deepEqual(JSON.parse(ready.stdout).unsupported_capabilities, []);

  const stopped = await stopSession(context);
  assert.equal(stopped.exitCode, 0, stopped.stderr || stopped.stdout);
  await waitForState(workspace, () => !fs.existsSync(context.markerPath));
  const blocked = await readiness(context);
  assert.equal(blocked.exitCode, 2);
  // The launcher as this OS has it: the script on macOS and Linux, the subcommand on Windows.
  const launcher = process.platform === "win32" ? "scripts/ccdm start-session" : "scripts/start-session.sh";
  assert.ok(JSON.parse(blocked.stdout).unsupported_capabilities.join(" ").includes(
    `Claude launch-scoped transport is not verified for this assignment; restart the session with ${launcher} demo`),
  blocked.stdout);

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
    // The whole session record: its shell command on tmux, its argv on the Windows host.
    JSON.stringify(state.fixtures.tmux.sessions.demo_claude),
    ...fs.readdirSync(launchDir).map((file) => fs.readFileSync(path.join(launchDir, file), "utf8")),
  ];
  for (const text of surfaces) assert.equal(text.includes("claude-reminder-channel"), false, text.slice(0, 200));
  const settings = JSON.parse(fs.readFileSync(path.join(launchDir, "settings.json"), "utf8"));
  // Claude Code runs commands through Git Bash on Windows, so paths have forward slashes there.
  // A Windows temp folder can carry a short (8.3) name; the `ccdm` entry starts Python from the long one.
  const windows = process.platform === "win32";
  const repoAsLaunched = windows ? fs.realpathSync.native(workspace.repoDir) : workspace.repoDir;
  const run = (script, ...args) => {
    const files = [path.join(repoAsLaunched, "scripts", script), ...args];
    return `node ${files.map((file) => `'${windows ? file.replaceAll("\\", "/") : file}'`).join(" ")}`;
  };
  const reminderHook = { type: "command", command: run("claude-reminder-hook.js") };
  const activityHook = { type: "command", command: run("thread-activity.js", path.join(launchDir, "activity.json")) };
  assert.deepEqual(settings, {
    enabledPlugins: { "discord@claude-plugins-official": false },
    hooks: {
      SessionStart: [{ hooks: [reminderHook] }],
      Stop: [{ hooks: [reminderHook, activityHook] }],
      StopFailure: [{ hooks: [reminderHook, activityHook] }],
      SessionEnd: [{ hooks: [reminderHook] }],
      UserPromptSubmit: [{ hooks: [activityHook] }],
    },
    // A Windows launch also carries its context status line.
    ...(windows ? { statusLine: { type: "command", command: run("statusline-context.js") } } : {}),
  });
});

function twoClaudeReminderWorkspace() {
  const workspace = createRouterWorkspace({
    discord_user_id: OWNER_ID,
    guild_id: "guild-id",
    projects: {
      demo: {
        channel_id: "demo-channel", type: "claude", screen_name: "demo_claude",
        guest_user_ids: ["guest-id"],
        assignment_generation: "gen-demo", session_id: null, pid: null,
        agent_message_targets: ["beta"],
      },
      beta: {
        channel_id: "beta-channel", type: "claude", screen_name: "beta_claude",
        assignment_generation: "gen-beta", session_id: null, pid: null,
        agent_message_targets: ["demo"],
      },
    },
  });
  const registryFile = path.join(workspace.repoDir, "registry.json");
  const registry = JSON.parse(fs.readFileSync(registryFile, "utf8"));
  registry.projects.demo.path = workspace.tmpDir;
  registry.projects.beta.path = workspace.tmpDir;
  fs.writeFileSync(registryFile, `${JSON.stringify(registry, null, 2)}\n`);
  const clockFile = path.join(workspace.tmpDir, "reminder-clock");
  const stateDir = path.join(workspace.homeDir, ".local", "state", "ccdm", "conversation-reminders");
  return {
    workspace,
    stateDir,
    setClock: (value) => fs.writeFileSync(clockFile, value),
    env: { CCDM_REMINDER_NODE: process.execPath, CCDM_REMINDER_CLOCK_FILE: clockFile },
  };
}

const guest = { id: "guest-id", username: "Guest" };

async function startProjectSession(context, project) {
  const started = await runScript(context.workspace, "scripts/start-session.sh", {
    args: [project], env: await launcherEnv(context), timeoutMs: 30000,
  });
  assert.equal(started.exitCode, 0, started.stderr || started.stdout);
  return started;
}

async function projectReadiness(context, project) {
  const result = await runScript(context.workspace, "scripts/conversation-reminder-readiness.py", {
    args: [project, "--json", "--project-root", context.workspace.repoDir, "--state-dir", context.stateDir],
    env: routerEnv(context.workspace, context.env),
  });
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

test("an Agent Message exchange between two Claude channel sessions leaves reminder state unchanged, suppresses replies during request/reply/notice turns, and lets an armed reminder recur", async () => {
  const context = twoClaudeReminderWorkspace();
  const { workspace } = context;
  updateState(workspace.stateDir, (state) => {
    state.fixtures.discord.history = { "demo-channel": [], "beta-channel": [] };
  });
  await routerWithWebhooks(workspace, ["demo", "beta"], { env: { CCDM_ROUTER_AGENT_MESSAGE_MINUTE_MS: "500" } });
  await startProjectSession(context, "demo");
  await startProjectSession(context, "beta");

  const now = Date.now();
  const at = (offset) => new Date(now + offset).toISOString().replace(/\.\d{3}Z$/, "Z");
  await service(context, "enable");
  context.setClock(at(0));
  const running = runScript(workspace, "scripts/conversation-reminder-service.py", {
    args: ["run", "--project-root", workspace.repoDir, "--state-dir", context.stateDir],
    env: routerEnv(workspace, context.env), timeoutMs: 120000,
  });
  await waitForStatus(context, (current) =>
    current.conversations.demo?.reconciliation_status === "ready"
    && current.conversations.beta?.reconciliation_status === "ready");

  // Seed beta with an older owner interaction so beta has a valid older owner
  // message_id it could try to name during an agent-started turn, then leave beta open-paused.
  injectDiscordMessage(workspace, { id: "beta-owner-1", channelId: "beta-channel", author: owner, content: "stand by" });
  await waitForState(workspace, (state) => (state.fixtures.claude.channelNotifications ?? [])
    .some((n) => n.meta.message_id === "beta-owner-1"), 15000);
  await waitForStatus(context, (current) => current.conversations.beta.last_ack_message_id === "beta-owner-1");
  const betaBefore = (await service(context, "status")).conversations.beta;
  assert.equal(betaBefore.state, "open-paused");
  assert.equal(betaBefore.response_message_id, null);

  // Demo answers its owner message (arming its reminder) and sends an Agent Request
  // to beta in the same turn. Beta replies in its own channel naming its older owner
  // message (and input-needed) while answering the Agent Request; demo then posts in
  // its channel naming demo-owner-1 when the Agent Reply arrives.
  updateState(workspace.stateDir, (state) => {
    state.fixtures.claude.toolScriptsByConversation = {
      "demo-channel": [
        {
          whenSender: "owner",
          name: "reply",
          arguments: {
            chat_id: "{{chat_id}}",
            text: "Demo answered owner",
            conversation_interaction_id: "{{message_id}}",
            conversation_disposition: "progress",
          },
        },
        {
          whenSender: "owner",
          name: "send_agent_request",
          arguments: { target: "beta", text: "Please check build status" },
        },
        {
          whenAgentKind: "reply",
          name: "reply",
          arguments: {
            chat_id: "{{chat_id}}",
            text: "Demo reporting beta reply",
            conversation_interaction_id: "demo-owner-1",
            conversation_disposition: "progress",
          },
        },
      ],
      "beta-channel": [
        {
          whenAgentKind: "request",
          name: "reply",
          arguments: {
            chat_id: "{{chat_id}}",
            text: "Beta posting during agent request turn",
            conversation_interaction_id: "beta-owner-1",
            conversation_disposition: "input-needed",
          },
        },
        {
          whenAgentKind: "request",
          name: "send_agent_reply",
          arguments: { request_id: "{{request_id}}", text: "Build is green" },
        },
      ],
    };
  });

  injectDiscordMessage(workspace, { id: "demo-owner-1", channelId: "demo-channel", author: owner, content: "check with beta" });

  // Observable fence: beta posted during its request turn, demo received beta's Agent Reply,
  // demo posted during its reply-started turn, and all Stop hooks ran.
  await waitForState(workspace, (state) =>
    (state.fixtures.discord.messages ?? []).some((m) => m.channelId === "beta-channel" && m.content === "Beta posting during agent request turn")
    && (state.fixtures.discord.messages ?? []).some((m) => m.channelId === "demo-channel" && m.content === "Demo reporting beta reply"),
  20000);
  await waitForState(workspace, (state) =>
    (state.fixtures.claude.hookRuns ?? []).filter((run) => run.event === "Stop").length >= 4, 15000);

  const demoOwnerReply = readState(workspace.stateDir).fixtures.discord.messages.find(
    (m) => m.channelId === "demo-channel" && m.content === "Demo answered owner",
  );
  assert.ok(demoOwnerReply);

  const afterExchange = await waitForStatus(context, (current) => current.conversations.demo.state === "awaiting-owner");
  // Beta stayed open-paused with zero response/completion/owner_activity from the agent-started turn.
  assert.deepEqual(
    [afterExchange.conversations.beta.state, afterExchange.conversations.beta.revision,
      afterExchange.conversations.beta.response_message_id, afterExchange.conversations.beta.due_at],
    ["open-paused", betaBefore.revision, null, null],
  );
  const betaEvents = (await projectReadiness(context, "beta")).events;
  assert.ok(betaEvents.length > 0 && betaEvents.every((e) => e.event_type === "owner_activity" && e.source_message_id === "beta-owner-1"),
    JSON.stringify(betaEvents));

  // Demo stayed awaiting-owner on its original owner reply, unaffected by the reply-started turn.
  assert.equal(afterExchange.conversations.demo.response_message_id, demoOwnerReply.id);
  const demoEventsAfterReply = (await projectReadiness(context, "demo")).events;
  assert.deepEqual(
    demoEventsAfterReply.filter((e) => e.event_type === "response_delivered").map((e) => e.message_id),
    [demoOwnerReply.id],
  );
  assert.deepEqual(
    demoEventsAfterReply.filter((e) => e.event_type === "turn_completed").map((e) => e.delivered_message_ids),
    [[demoOwnerReply.id]],
  );
  assert.ok(demoEventsAfterReply.filter((e) => e.event_type === "owner_activity")
    .every((e) => e.source_message_id === "demo-owner-1"));
  const demoAfterReply = afterExchange.conversations.demo;

  // Demo's armed reminder from its sending turn fires at +61m and recurs on schedule at +182m; beta gets none.
  context.setClock(at(61 * 60000));
  const firstReminded = await waitForStatus(context, (current) => current.conversations.demo.consecutive_reminders === 1);
  const firstEyeId = firstReminded.conversations.demo.reminder_message_id;
  assert.ok(firstEyeId);
  assert.equal(firstReminded.conversations.beta.reminder_message_id, null);
  assert.equal(firstReminded.conversations.demo.response_message_id, demoAfterReply.response_message_id);

  context.setClock(at((61 + 121) * 60000));
  const secondReminded = await waitForStatus(context, (current) => current.conversations.demo.consecutive_reminders === 2);
  assert.notEqual(secondReminded.conversations.demo.reminder_message_id, firstEyeId);
  await waitForState(workspace, (state) => (state.fixtures.discord.deletes ?? []).some((row) => row.messageId === firstEyeId), 15000);
  assert.deepEqual(
    reminders(readState(workspace.stateDir)).filter((m) => m.channelId === "beta-channel"),
    [],
  );

  // Notice-started turn (expired request): beta sends a 1-minute (500ms) request to demo,
  // demo does not reply, request expires, and beta posts a reply naming beta-owner-2 during
  // the notice-started turn. Beta's reminder state must stay open-paused with no receipt or completion.
  const stopsBeforeNotice = (readState(workspace.stateDir).fixtures.claude.hookRuns ?? [])
    .filter((run) => run.event === "Stop").length;
  updateState(workspace.stateDir, (state) => {
    state.fixtures.claude.toolScriptsByConversation = {
      "demo-channel": [],
      "beta-channel": [
        {
          whenSender: "owner",
          name: "send_agent_request",
          arguments: { target: "demo", text: "Expiring check", timeout_minutes: 1 },
        },
        {
          whenAgentKind: "notice",
          name: "reply",
          arguments: {
            chat_id: "{{chat_id}}",
            text: "Beta posting during expiry notice turn",
            conversation_interaction_id: "beta-owner-2",
            conversation_disposition: "progress",
          },
        },
      ],
    };
  });
  injectDiscordMessage(workspace, { id: "beta-owner-2", channelId: "beta-channel", author: owner, content: "ask demo quickly" });
  await waitForState(workspace, (state) =>
    (state.fixtures.discord.messages ?? []).some((m) => m.channelId === "beta-channel" && m.content === "Beta posting during expiry notice turn"),
  20000);
  // Stop hooks: beta's send turn, demo's silent request turn, beta's notice turn (+3).
  await waitForState(workspace, (state) =>
    (state.fixtures.claude.hookRuns ?? []).filter((run) => run.event === "Stop").length >= stopsBeforeNotice + 3, 15000);
  await waitForStatus(context, (current) => current.conversations.beta.last_ack_message_id === "beta-owner-2");
  const afterNotice = await service(context, "status");
  assert.deepEqual(
    [afterNotice.conversations.beta.state, afterNotice.conversations.beta.response_message_id, afterNotice.conversations.beta.due_at],
    ["open-paused", null, null],
  );
  const betaEventsAfterNotice = (await projectReadiness(context, "beta")).events;
  assert.deepEqual(
    betaEventsAfterNotice.filter((e) => e.event_type === "response_delivered" || e.event_type === "turn_completed"),
    [],
  );

  await service(context, "disable");
  const stopped = await running;
  assert.equal(stopped.exitCode, 0, stopped.stderr || stopped.stdout);
});

test("owner input joining a Claude agent-started turn restores reminder arming (guest input does not), and a closed channel stays closed on Agent Request", async () => {
  const context = twoClaudeReminderWorkspace();
  const { workspace } = context;
  updateState(workspace.stateDir, (state) => {
    state.fixtures.discord.history = { "demo-channel": [], "beta-channel": [] };
  });
  await routerWithWebhooks(workspace, ["demo", "beta"]);
  await startProjectSession(context, "demo");
  await startProjectSession(context, "beta");

  const now = Date.now();
  const at = (offset) => new Date(now + offset).toISOString().replace(/\.\d{3}Z$/, "Z");
  await service(context, "enable");
  context.setClock(at(0));
  const running = runScript(workspace, "scripts/conversation-reminder-service.py", {
    args: ["run", "--project-root", workspace.repoDir, "--state-dir", context.stateDir],
    env: routerEnv(workspace, context.env), timeoutMs: 120000,
  });
  await waitForStatus(context, (current) =>
    current.conversations.demo?.reconciliation_status === "ready"
    && current.conversations.beta?.reconciliation_status === "ready");

  // Give both channels an older owner interaction, staying open-paused.
  injectDiscordMessage(workspace, { id: "demo-owner-old", channelId: "demo-channel", author: owner, content: "earlier demo note" });
  injectDiscordMessage(workspace, { id: "beta-owner-old", channelId: "beta-channel", author: owner, content: "earlier beta note" });
  await waitForStatus(context, (current) =>
    current.conversations.demo.last_ack_message_id === "demo-owner-old"
    && current.conversations.beta.last_ack_message_id === "beta-owner-old");
  await waitForState(workspace, (state) =>
    (state.fixtures.claude.hookRuns ?? []).filter((run) => run.event === "Stop").length >= 2, 15000);

  // Hold demo's agent-started turn so mid-turn notifications join it before Stop runs.
  updateState(workspace.stateDir, (state) => {
    state.fixtures.claude.holdTurnsIn = ["demo-channel"];
    state.fixtures.claude.toolScriptsByConversation = {
      "beta-channel": [
        {
          whenSender: "owner",
          name: "send_agent_request",
          arguments: { target: "demo", text: "Need status while held" },
        },
      ],
      "demo-channel": [
        {
          whenAgentKind: "request",
          name: "reply",
          arguments: {
            chat_id: "{{chat_id}}",
            text: "Demo pre-join reply",
            conversation_interaction_id: "demo-owner-old",
            conversation_disposition: "progress",
          },
        },
      ],
    };
    state.fixtures.claude.midTurnToolScriptsByConversation = {
      "demo-channel": [
        {
          whenSender: "guest",
          name: "reply",
          arguments: {
            chat_id: "{{chat_id}}",
            text: "Demo reply after guest joined",
            conversation_interaction_id: "demo-owner-old",
            conversation_disposition: "progress",
          },
        },
        {
          whenSender: "owner",
          name: "reply",
          arguments: {
            chat_id: "{{chat_id}}",
            text: "Demo reply after owner joined",
            conversation_interaction_id: "{{message_id}}",
            conversation_disposition: "progress",
          },
        },
      ],
    };
  });

  injectDiscordMessage(workspace, { id: "beta-trigger-1", channelId: "beta-channel", author: owner, content: "ask demo" });
  await waitForState(workspace, (state) =>
    (state.fixtures.discord.messages ?? []).some((m) => m.channelId === "demo-channel" && m.content === "Demo pre-join reply"),
  20000);

  // Guest input joins the agent-started turn mid-turn: must NOT convert it into an ordinary turn.
  injectDiscordMessage(workspace, { id: "demo-guest-mid", channelId: "demo-channel", author: guest, content: "guest chime in" });
  await waitForState(workspace, (state) =>
    (state.fixtures.discord.messages ?? []).some((m) => m.channelId === "demo-channel" && m.content === "Demo reply after guest joined"),
  15000);
  const demoBeforeOwnerJoin = (await projectReadiness(context, "demo")).events;
  assert.deepEqual(demoBeforeOwnerJoin.filter((e) => e.event_type === "response_delivered"), []);

  // Now owner input joins the same held turn: a later reply records its receipt and Stop arms the reminder.
  injectDiscordMessage(workspace, { id: "demo-owner-join", channelId: "demo-channel", author: owner, content: "owner joins turn" });
  await waitForState(workspace, (state) =>
    (state.fixtures.discord.messages ?? []).some((m) => m.channelId === "demo-channel" && m.content === "Demo reply after owner joined"),
  15000);
  updateState(workspace.stateDir, (state) => {
    state.fixtures.claude.holdTurnsIn = [];
  });

  const armed = await waitForStatus(context, (current) => current.conversations.demo.state === "awaiting-owner");
  const ownerJoinReply = readState(workspace.stateDir).fixtures.discord.messages.find(
    (m) => m.channelId === "demo-channel" && m.content === "Demo reply after owner joined",
  );
  assert.ok(ownerJoinReply);
  assert.equal(armed.conversations.demo.current_interaction_id, "demo-owner-join");
  assert.equal(armed.conversations.demo.response_message_id, ownerJoinReply.id);
  const demoEventsAfterJoin = (await projectReadiness(context, "demo")).events;
  assert.deepEqual(
    demoEventsAfterJoin.filter((e) => e.event_type === "response_delivered").map((e) => e.message_id),
    [ownerJoinReply.id],
  );
  assert.deepEqual(
    demoEventsAfterJoin.filter((e) => e.event_type === "turn_completed").map((e) => e.delivered_message_ids),
    [[ownerJoinReply.id]],
  );

  // Close beta with /close, then have demo send an Agent Request to beta's live session:
  // beta receives it, posts a reply and sends an Agent Reply, yet stays closed.
  injectDiscordMessage(workspace, { id: "beta-close-1", channelId: "beta-channel", author: owner, content: "/close" });
  const closedBeta = await waitForStatus(context, (current) => current.conversations.beta.state === "closed");
  const closedRevision = closedBeta.conversations.beta.revision;

  updateState(workspace.stateDir, (state) => {
    state.fixtures.claude.toolScriptsByConversation = {
      "demo-channel": [
        {
          whenSender: "owner",
          name: "send_agent_request",
          arguments: { target: "beta", text: "Are you still closed?" },
        },
      ],
      "beta-channel": [
        {
          whenAgentKind: "request",
          name: "reply",
          arguments: {
            chat_id: "{{chat_id}}",
            text: "Beta note while closed",
            conversation_interaction_id: "beta-owner-old",
            conversation_disposition: "progress",
          },
        },
        {
          whenAgentKind: "request",
          name: "send_agent_reply",
          arguments: { request_id: "{{request_id}}", text: "Answering while closed" },
        },
      ],
    };
  });
  injectDiscordMessage(workspace, { id: "demo-ask-closed", channelId: "demo-channel", author: owner, content: "ping beta" });
  // Observable fence: demo receives beta's Agent Reply.
  await waitForState(workspace, (state) =>
    (state.fixtures.claude.channelNotifications ?? []).some(
      (n) => n.meta.chat_id === "demo-channel" && n.meta.agent_message === "reply" && n.content === "Answering while closed",
    ),
  20000);
  // Advance clock +61m and check beta is still closed with no reminder.
  context.setClock(at(61 * 60000));
  const afterClosedExchange = await service(context, "status");
  assert.deepEqual(
    [afterClosedExchange.conversations.beta.state, afterClosedExchange.conversations.beta.revision,
      afterClosedExchange.conversations.beta.response_message_id, afterClosedExchange.conversations.beta.reminder_message_id],
    ["closed", closedRevision, null, null],
  );
  assert.deepEqual(
    reminders(readState(workspace.stateDir)).filter((m) => m.channelId === "beta-channel"),
    [],
  );

  await service(context, "disable");
  const stopped = await running;
  assert.equal(stopped.exitCode, 0, stopped.stderr || stopped.stdout);
});
