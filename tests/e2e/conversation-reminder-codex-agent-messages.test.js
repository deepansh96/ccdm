import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  collectProcess,
  injectDiscordMessage,
  startFakeCodexServer,
  waitForFinishedTurns,
} from "./support/bridge.js";
import { runScript } from "./support/runner.js";
import {
  OWNER_ID,
  createRouterWorkspace,
  routerEnv,
  routerRegistry,
  routerWithWebhooks,
  waitFor,
  writeProjectKey,
} from "./support/router.js";
import { readState, updateState } from "./support/state.js";
import { cleanup, registerTeardownCallback } from "./support/teardown.js";
import {
  startThreadHost,
  startThreadSupervisor,
  supervisorEnv,
  supervisorStatus,
} from "./support/thread-supervisor.js";

test.afterEach(cleanup);

const WIN = process.platform === "win32";
const owner = { id: OWNER_ID, username: "Owner" };
const guest = { id: "guest-id", username: "Guest" };
const THREAD_A = "1700000000000405101";
const THREAD_B = "1700000000000405102";

function codexReminderWorkspace(extra = {}) {
  const workspace = createRouterWorkspace({
    ...routerRegistry({
      demo: {
        channel_id: "demo-channel",
        type: "codex",
        transport: "router",
        guest_user_ids: ["guest-id"],
        screen_name: "demo_codex",
        assignment_generation: "gen-demo",
        ws_port: 0,
        session_id: null,
        pid: null,
        agent_message_targets: ["beta", "demo"],
        ...(extra.demo || {}),
      },
      beta: {
        channel_id: "beta-channel",
        type: "codex",
        transport: "router",
        guest_user_ids: ["guest-id"],
        screen_name: "beta_codex",
        assignment_generation: "gen-beta",
        ws_port: 0,
        session_id: null,
        pid: null,
        agent_message_targets: ["demo"],
        ...(extra.beta || {}),
      },
    }),
    root_channels: ["root-channel"],
  });
  const registryFile = path.join(workspace.repoDir, "registry.json");
  const registry = JSON.parse(fs.readFileSync(registryFile, "utf8"));
  registry.projects.demo.path = workspace.tmpDir;
  registry.projects.beta.path = workspace.tmpDir;
  fs.writeFileSync(registryFile, `${JSON.stringify(registry, null, 2)}\n`);
  fs.mkdirSync(path.join(workspace.homeDir, ".codex"), { recursive: true });
  const clockFile = path.join(workspace.tmpDir, "reminder-clock");
  const stateDir = path.join(workspace.homeDir, ".local", "state", "ccdm", "conversation-reminders");
  const now = Date.now();
  return {
    workspace,
    stateDir,
    setClockMinutes: (minutes) => fs.writeFileSync(
      clockFile,
      new Date(now + minutes * 60000).toISOString().replace(/\.\d{3}Z$/, "Z"),
    ),
    env: { CCDM_REMINDER_NODE: process.execPath, CCDM_REMINDER_CLOCK_FILE: clockFile },
  };
}

function servicesEnv(context, extra = {}) {
  return WIN
    ? supervisorEnv(context.workspace, { CCDM_REMINDER_STATE_DIR: context.stateDir, PYTHONUTF8: "1", ...extra })
    : routerEnv(context.workspace, extra);
}

async function service(context, name) {
  const result = await runScript(context.workspace, "scripts/conversation-reminder-service.py", {
    args: [name, "--project-root", context.workspace.repoDir, "--state-dir", context.stateDir],
    env: servicesEnv(context, context.env),
  });
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

async function projectReadiness(context, project) {
  const result = await runScript(context.workspace, "scripts/conversation-reminder-readiness.py", {
    args: [project, "--json", "--project-root", context.workspace.repoDir, "--state-dir", context.stateDir],
    env: servicesEnv(context, context.env),
  });
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

async function waitForStatus(context, predicate, description = "reminder status", timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await service(context, "status");
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  throw new Error(`Timed out waiting for ${description}: ${JSON.stringify(last)}`);
}

async function startReminderWorker(context, projects = ["demo", "beta"]) {
  const { workspace } = context;
  updateState(workspace.stateDir, (state) => {
    state.fixtures.discord.history = Object.fromEntries(
      projects.map((name) => [`${name}-channel`, []]),
    );
  });
  await service(context, "enable");
  context.setClockMinutes(0);
  const running = runScript(workspace, "scripts/conversation-reminder-service.py", {
    args: ["run", "--project-root", workspace.repoDir, "--state-dir", context.stateDir],
    env: servicesEnv(context, context.env),
    timeoutMs: 120000,
  });
  await waitForStatus(
    context,
    (current) => projects.every((name) => current.conversations[name]?.reconciliation_status === "ready"),
    "reminder worker ready",
    20000,
  );
  return async () => {
    await service(context, "disable");
    const stopped = await running;
    assert.equal(stopped.exitCode, 0, stopped.stderr || stopped.stdout);
  };
}

function spawnCodexBridge(context, { project, channelId, port, keyFile, extraEnv = {} }) {
  const { workspace } = context;
  const resolvedKeyFile = keyFile || path.join(workspace.routerStateDir, "keys", `${project}.key`);
  const codexHome = path.join(workspace.homeDir, `.codex-${project}-${channelId}`);
  fs.mkdirSync(codexHome, { recursive: true });
  const env = servicesEnv(context, {
    CCDM_ROUTER_KEY_FILE: resolvedKeyFile,
    CCDM_CODEX_PROJECT: project,
    CHANNEL_ID: channelId,
    PROJECT_DIR: workspace.tmpDir,
    WS_PORT: String(port),
    CODEX_HOME: codexHome,
    CCDM_REMINDER_STATE_DIR: context.stateDir,
    ...extraEnv,
  });
  const child = spawn(process.execPath, [path.join(workspace.repoDir, "scripts/codex-bridge.js")], {
    cwd: workspace.repoDir,
    detached: true,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const bridge = collectProcess(
    child,
    { command: [process.execPath, "scripts/codex-bridge.js"], cwd: workspace.repoDir, detached: true, env },
    workspace,
  );
  registerTeardownCallback(() => bridge.stop());
  return bridge;
}

const eyesIn = (workspace, channelId) => (readState(workspace.stateDir).fixtures.discord.messages ?? [])
  .filter((message) => message.channelId === channelId && message.content === "👀");

const extractRequestId = (input) => /^\[Agent Request (req-[0-9a-f]{12}) /.exec(input?.[0]?.text ?? "")?.[1] ?? "";

function registeredContextFile(codex, channelId) {
  const config = codex.clientMessages.find(
    (message) => message.method === "config/value/write" && message.params?.keyPath === `mcp_servers.discord-${channelId}`,
  );
  return config?.params?.value?.env?.CCDM_REMINDER_CONTEXT_FILE || null;
}

function createDiscordThread(workspace, id, name) {
  updateState(workspace.stateDir, (state) => {
    (state.fixtures.discord.injectedThreads ||= []).push({
      id,
      type: 11,
      parentId: "demo-channel",
      name,
      ownerId: OWNER_ID,
      autoArchiveDuration: 10080,
      event: "create",
    });
  });
}

async function waitForThreadRow(workspace, threadId, predicate = () => true, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await supervisorStatus(workspace);
    const row = last.projects?.demo?.threads?.[threadId];
    if (row && predicate(row)) return row;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for thread ${threadId}: ${JSON.stringify(last)}`);
}

test("Codex channel Agent Messages leave reminder state unchanged across request/reply/notice turns (tool and text fallback) and keep armed reminders recurring", async () => {
  const context = codexReminderWorkspace();
  const { workspace } = context;
  await routerWithWebhooks(workspace, ["demo", "beta"], {
    env: { CCDM_ROUTER_AGENT_MESSAGE_MINUTE_MS: "500" },
  });
  const demoKey = writeProjectKey(workspace, "demo", "demo-codex-key");
  const betaKey = writeProjectKey(workspace, "beta", "beta-codex-key");

  const demoCodex = await startFakeCodexServer(workspace, {
    channelId: "demo-channel",
    turns: [
      // Turn 1 (owner): answers owner (arms demo reminder) AND sends Agent Request to beta.
      {
        turnId: "demo-owner-turn-1",
        status: "completed",
        mcpCalls: () => [
          ["reply", { text: "Demo answered owner", conversation_disposition: "progress" }],
          ["send_agent_request", { target: "beta", text: "Check Codex build" }],
        ],
      },
      // Turn 2 (Agent Reply): posts via text-reply fallback during reply-started turn.
      {
        turnId: "demo-agent-reply-turn",
        status: "completed",
        delta: "Demo fallback during reply turn",
        completedItem: true,
      },
      // Turn 3 (Agent Request from beta that expires): posts via text-reply fallback, no send_agent_reply.
      {
        turnId: "demo-expiring-req-turn",
        status: "completed",
        delta: "Demo fallback during expiring request turn",
        completedItem: true,
      },
    ],
  });

  const betaCodex = await startFakeCodexServer(workspace, {
    channelId: "beta-channel",
    turns: [
      // Turn 1 (owner seed): no reply -> beta stays open-paused.
      {
        turnId: "beta-seed-turn",
        status: "completed",
        delta: "",
      },
      // Turn 2 (Agent Request): calls MCP reply (with input-needed) AND send_agent_reply.
      {
        turnId: "beta-agent-req-turn",
        status: "completed",
        mcpCalls: (input) => [
          ["reply", { text: "Beta tool reply during request turn", conversation_disposition: "input-needed" }],
          ["send_agent_reply", { request_id: extractRequestId(input), text: "Codex build is green" }],
        ],
      },
      // Turn 3 (owner trigger for expiring request): only sends expiring Agent Request, no reply.
      {
        turnId: "beta-send-expiring-turn",
        status: "completed",
        mcpCalls: () => [
          ["send_agent_request", { target: "demo", text: "Expiring check", timeout_minutes: 1 }],
        ],
      },
      // Turn 4 (expiry notice): calls MCP reply during notice-started turn.
      {
        turnId: "beta-notice-turn",
        status: "completed",
        mcpCalls: () => [
          ["reply", { text: "Beta reply during expiry notice turn", conversation_disposition: "progress" }],
        ],
      },
    ],
  });

  const demoBridge = spawnCodexBridge(context, {
    project: "demo",
    channelId: "demo-channel",
    port: demoCodex.port,
    keyFile: demoKey,
    extraEnv: { CODEX_BRIDGE_TEXT_REPLY_FALLBACK: "1" },
  });
  const betaBridge = spawnCodexBridge(context, {
    project: "beta",
    channelId: "beta-channel",
    port: betaCodex.port,
    keyFile: betaKey,
    extraEnv: { CODEX_BRIDGE_TEXT_REPLY_FALLBACK: "1" },
  });
  await demoBridge.waitForOutput(/Listening in #demo/, 15000);
  await betaBridge.waitForOutput(/Listening in #beta/, 15000);
  await waitForFinishedTurns(demoBridge, 1, 10000, demoCodex);
  await waitForFinishedTurns(betaBridge, 1, 10000, betaCodex);

  const stopWorker = await startReminderWorker(context, ["demo", "beta"]);

  // Seed beta with an owner interaction and leave it open-paused.
  injectDiscordMessage(workspace, { id: "beta-owner-1", channelId: "beta-channel", author: owner, content: "stand by" });
  await waitForFinishedTurns(betaBridge, 2, 10000, betaCodex);
  await waitForStatus(context, (current) => current.conversations.beta.last_ack_message_id === "beta-owner-1", "beta seeded");
  const betaBefore = (await service(context, "status")).conversations.beta;
  assert.equal(betaBefore.state, "open-paused");
  assert.equal(betaBefore.response_message_id, null);

  // Trigger full exchange: demo answers owner + sends request -> beta replies via MCP tool + send_agent_reply
  // -> demo handles Agent Reply via text-reply fallback.
  injectDiscordMessage(workspace, { id: "demo-owner-1", channelId: "demo-channel", author: owner, content: "ask beta" });
  await waitForFinishedTurns(betaBridge, 3, 15000, betaCodex);
  await waitForFinishedTurns(demoBridge, 3, 15000, demoCodex);
  await waitFor(
    () => (readState(workspace.stateDir).fixtures.discord.messages ?? [])
      .some((m) => m.channelId === "beta-channel" && m.content === "Beta tool reply during request turn")
      && (readState(workspace.stateDir).fixtures.discord.messages ?? [])
        .some((m) => m.channelId === "demo-channel" && m.content === "Demo fallback during reply turn"),
    () => "exchange replies posted to Discord",
    15000,
  );

  const demoOwnerReply = readState(workspace.stateDir).fixtures.discord.messages.find(
    (m) => m.channelId === "demo-channel" && m.content === "Demo answered owner",
  );
  assert.ok(demoOwnerReply);

  const afterExchange = await waitForStatus(
    context,
    (current) => current.conversations.demo.state === "awaiting-owner",
    "demo armed on owner reply",
  );
  // Beta stayed open-paused, untouched by the Agent Request turn's MCP reply (even input-needed).
  assert.deepEqual(
    [
      afterExchange.conversations.beta.state,
      afterExchange.conversations.beta.revision,
      afterExchange.conversations.beta.response_message_id,
      afterExchange.conversations.beta.due_at,
    ],
    ["open-paused", betaBefore.revision, null, null],
  );
  const betaEvents = (await projectReadiness(context, "beta")).events;
  assert.ok(
    betaEvents.length > 0 && betaEvents.every((e) => e.event_type === "owner_activity" && e.source_message_id === "beta-owner-1"),
    JSON.stringify(betaEvents),
  );

  // Demo stayed awaiting-owner on its original owner reply, unaffected by the Agent Reply turn's text fallback.
  assert.equal(afterExchange.conversations.demo.response_message_id, demoOwnerReply.id);
  const demoEventsAfterExchange = (await projectReadiness(context, "demo")).events;
  assert.deepEqual(
    demoEventsAfterExchange.filter((e) => e.event_type === "response_delivered").map((e) => e.message_id),
    [demoOwnerReply.id],
  );
  assert.deepEqual(
    demoEventsAfterExchange.filter((e) => e.event_type === "turn_completed").map((e) => e.delivered_message_ids),
    [[demoOwnerReply.id]],
  );
  assert.ok(
    demoEventsAfterExchange.filter((e) => e.event_type === "owner_activity").every((e) => e.source_message_id === "demo-owner-1"),
    JSON.stringify(demoEventsAfterExchange),
  );

  // Demo's armed reminder fires at +61m and recurs on schedule at +182m; beta gets none.
  context.setClockMinutes(61);
  const firstReminded = await waitForStatus(
    context,
    (current) => current.conversations.demo.consecutive_reminders === 1,
    "demo first reminder",
  );
  const firstEyeId = firstReminded.conversations.demo.reminder_message_id;
  assert.ok(firstEyeId);
  assert.equal(firstReminded.conversations.beta.reminder_message_id, null);

  context.setClockMinutes(61 + 121);
  const secondReminded = await waitForStatus(
    context,
    (current) => current.conversations.demo.consecutive_reminders === 2,
    "demo recurring reminder",
  );
  assert.notEqual(secondReminded.conversations.demo.reminder_message_id, firstEyeId);
  await waitFor(
    () => (readState(workspace.stateDir).fixtures.discord.deletes ?? []).some((d) => d.messageId === firstEyeId),
    () => "first reminder deleted",
    15000,
  );
  assert.deepEqual(eyesIn(workspace, "beta-channel"), []);

  // Notice-started turn (expired request) + text-reply fallback during an Agent Request turn:
  // beta sends a 1-minute (500ms) request to demo; demo posts text-reply fallback without replying;
  // request expires -> beta posts MCP reply during expiry notice turn. Neither records receipts or completions.
  injectDiscordMessage(workspace, { id: "beta-owner-2", channelId: "beta-channel", author: owner, content: "ping demo briefly" });
  await waitForFinishedTurns(demoBridge, 4, 15000, demoCodex);
  await waitForFinishedTurns(betaBridge, 5, 15000, betaCodex);
  await waitFor(
    () => (readState(workspace.stateDir).fixtures.discord.messages ?? [])
      .some((m) => m.channelId === "demo-channel" && m.content === "Demo fallback during expiring request turn")
      && (readState(workspace.stateDir).fixtures.discord.messages ?? [])
        .some((m) => m.channelId === "beta-channel" && m.content === "Beta reply during expiry notice turn"),
    () => "expiring request fallback and expiry notice reply posted",
    15000,
  );

  await waitForStatus(context, (current) => current.conversations.beta.last_ack_message_id === "beta-owner-2", "beta ack 2");
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
  const demoEventsAfterFallback = (await projectReadiness(context, "demo")).events;
  assert.deepEqual(
    demoEventsAfterFallback.filter((e) => e.event_type === "response_delivered").map((e) => e.message_id),
    [demoOwnerReply.id],
  );
  assert.deepEqual(
    demoEventsAfterFallback.filter((e) => e.event_type === "turn_completed").map((e) => e.delivered_message_ids),
    [[demoOwnerReply.id]],
  );

  await stopWorker();
  await demoBridge.stop();
  await betaBridge.stop();
});

test("owner steer into an agent-started Codex channel turn creates reminder context and arms a reminder (guest steer does not), and a closed channel stays closed", async () => {
  const context = codexReminderWorkspace();
  const { workspace } = context;
  await routerWithWebhooks(workspace, ["demo", "beta"]);
  const demoKey = writeProjectKey(workspace, "demo", "demo-steer-key");
  const betaKey = writeProjectKey(workspace, "beta", "beta-steer-key");

  const demoCodex = await startFakeCodexServer(workspace, {
    channelId: "demo-channel",
    turns: [
      // Turn 1 (Agent Request from beta): held until guest & owner steer, then replies via MCP tool.
      {
        turnId: "demo-held-agent-turn",
        status: "completed",
        waitForRelease: true,
        mcpCalls: () => [
          ["reply", { text: "Demo reply after owner steer", conversation_disposition: "progress" }],
        ],
      },
      // Turn 2 (owner trigger to ping closed beta): sends Agent Request to beta.
      {
        turnId: "demo-ping-closed-turn",
        status: "completed",
        mcpCalls: () => [
          ["send_agent_request", { target: "beta", text: "Still closed?" }],
        ],
      },
      // Turn 3 (Agent Reply from closed beta): silent.
      {
        turnId: "demo-closed-reply-turn",
        status: "completed",
      },
    ],
  });

  const betaCodex = await startFakeCodexServer(workspace, {
    channelId: "beta-channel",
    turns: [
      // Turn 1 (owner trigger): sends Agent Request to demo.
      {
        turnId: "beta-trigger-demo-turn",
        status: "completed",
        mcpCalls: () => [
          ["send_agent_request", { target: "demo", text: "Hold for steer test" }],
        ],
      },
      // Turn 2 (Agent Request while closed): posts reply and sends Agent Reply.
      {
        turnId: "beta-closed-agent-turn",
        status: "completed",
        mcpCalls: (input) => [
          ["reply", { text: "Beta reply while closed", conversation_disposition: "progress" }],
          ["send_agent_reply", { request_id: extractRequestId(input), text: "Answering while closed" }],
        ],
      },
    ],
  });

  const demoBridge = spawnCodexBridge(context, {
    project: "demo",
    channelId: "demo-channel",
    port: demoCodex.port,
    keyFile: demoKey,
  });
  const betaBridge = spawnCodexBridge(context, {
    project: "beta",
    channelId: "beta-channel",
    port: betaCodex.port,
    keyFile: betaKey,
  });
  await demoBridge.waitForOutput(/Listening in #demo/, 15000);
  await betaBridge.waitForOutput(/Listening in #beta/, 15000);
  await waitForFinishedTurns(demoBridge, 1, 10000, demoCodex);
  await waitForFinishedTurns(betaBridge, 1, 10000, betaCodex);

  const stopWorker = await startReminderWorker(context, ["demo", "beta"]);
  const demoContextFile = registeredContextFile(demoCodex, "demo-channel");
  assert.ok(demoContextFile, "expected demo reminder context file in MCP config");

  // Beta sends an Agent Request to demo; demo starts its held agent-started turn.
  injectDiscordMessage(workspace, { id: "beta-ask-1", channelId: "beta-channel", author: owner, content: "ping demo" });
  await waitFor(() => demoCodex.pendingReleases().includes("demo-held-agent-turn"), () => "demo held agent turn", 15000);
  await waitForFinishedTurns(betaBridge, 2, 10000, betaCodex);
  assert.equal(fs.existsSync(demoContextFile), false, "agent-started turn must have no reminder context before steer");

  // Guest steers into the agent-started turn: must NOT create reminder context.
  injectDiscordMessage(workspace, { id: "demo-guest-steer", channelId: "demo-channel", author: guest, content: "guest steer" });
  await waitFor(
    () => demoCodex.clientMessages.filter((m) => m.method === "turn/steer").length === 1,
    () => "guest turn/steer",
    10000,
  );
  await demoBridge.waitForOutput(/\[steer\] Injected into active turn demo-held-agent-turn/, 10000);
  assert.equal(fs.existsSync(demoContextFile), false, "guest steer must not create reminder context");

  // Owner steers into the same agent-started turn: MUST create reminder context!
  injectDiscordMessage(workspace, { id: "demo-owner-steer", channelId: "demo-channel", author: owner, content: "owner steer" });
  await waitFor(
    () => demoCodex.clientMessages.filter((m) => m.method === "turn/steer").length === 2,
    () => "owner turn/steer",
    10000,
  );
  await waitFor(
    () => fs.existsSync(demoContextFile),
    () => `owner steer to create reminder context ${demoContextFile}`,
    5000,
  );

  // Release the held turn: its MCP reply records a receipt and turn completion arms demo's reminder.
  demoCodex.releaseTurn("demo-held-agent-turn");
  await waitForFinishedTurns(demoBridge, 2, 15000, demoCodex);

  const postSteerReply = readState(workspace.stateDir).fixtures.discord.messages.find(
    (m) => m.channelId === "demo-channel" && m.content === "Demo reply after owner steer",
  );
  assert.ok(postSteerReply);

  const armed = await waitForStatus(
    context,
    (current) => current.conversations.demo.state === "awaiting-owner",
    "demo armed after owner steer",
  );
  assert.equal(armed.conversations.demo.current_interaction_id, "demo-owner-steer");
  assert.equal(armed.conversations.demo.response_message_id, postSteerReply.id);
  const demoEvents = (await projectReadiness(context, "demo")).events;
  assert.deepEqual(
    demoEvents.filter((e) => e.event_type === "response_delivered").map((e) => e.message_id),
    [postSteerReply.id],
  );
  assert.deepEqual(
    demoEvents.filter((e) => e.event_type === "turn_completed").map((e) => e.delivered_message_ids),
    [[postSteerReply.id]],
  );

  context.setClockMinutes(61);
  await waitForStatus(context, (current) => current.conversations.demo.consecutive_reminders === 1, "demo reminder after steer");
  assert.equal(eyesIn(workspace, "demo-channel").length, 1);

  // Close beta with /close, then have demo send an Agent Request to beta's live session:
  // beta handles it and posts a reply + Agent Reply, yet stays closed with no reminder.
  injectDiscordMessage(workspace, { id: "beta-close-1", channelId: "beta-channel", author: owner, content: "/close" });
  const closedBeta = await waitForStatus(context, (current) => current.conversations.beta.state === "closed", "beta closed");
  const closedRevision = closedBeta.conversations.beta.revision;

  injectDiscordMessage(workspace, { id: "demo-ping-closed", channelId: "demo-channel", author: owner, content: "ping closed beta" });
  await waitForFinishedTurns(betaBridge, 3, 15000, betaCodex);
  await waitForFinishedTurns(demoBridge, 4, 15000, demoCodex);
  context.setClockMinutes(122);
  await waitFor(
    () => (readState(workspace.stateDir).fixtures.discord.messages ?? [])
      .some((m) => m.channelId === "beta-channel" && m.content === "Beta reply while closed"),
    () => "beta reply while closed",
    10000,
  );
  const afterClosedExchange = await service(context, "status");
  assert.deepEqual(
    [
      afterClosedExchange.conversations.beta.state,
      afterClosedExchange.conversations.beta.revision,
      afterClosedExchange.conversations.beta.response_message_id,
      afterClosedExchange.conversations.beta.reminder_message_id,
    ],
    ["closed", closedRevision, null, null],
  );
  assert.deepEqual(eyesIn(workspace, "beta-channel"), []);

  await stopWorker();
  await demoBridge.stop();
  await betaBridge.stop();
});

test("Codex Thread Conversations isolate Agent Messages from reminders, keep armed reminders recurring, and arm on owner steer", async () => {
  const context = codexReminderWorkspace();
  const { workspace } = context;
  const portA = 29610;
  const portB = 29611;

  const codexA = await startFakeCodexServer(workspace, {
    port: portA,
    deferListen: true,
    channelId: THREAD_A,
    bootstrapPlan: {
      turnId: "thread-a-boot",
      status: "completed",
      delta: "",
    },
    turns: [
      // Turn 2 (owner message): answers owner (arms THREAD_A reminder) AND sends Agent Request to THREAD_B.
      {
        turnId: "thread-a-owner-turn",
        status: "completed",
        mcpCalls: () => [
          ["reply", { text: "Thread A answered owner", conversation_disposition: "progress" }],
          ["send_agent_request", { target: `demo/${THREAD_B}`, text: "Check Codex thread B" }],
        ],
      },
      // Turn 3 (Agent Reply from THREAD_B): text-reply fallback during reply-started turn.
      {
        turnId: "thread-a-reply-turn",
        status: "completed",
        delta: "Thread A fallback during reply turn",
        completedItem: true,
      },
      // Turn 4 (Agent Request from THREAD_B that expires): text-reply fallback, no send_agent_reply.
      {
        turnId: "thread-a-expiring-turn",
        status: "completed",
        delta: "Thread A fallback during expiring request",
        completedItem: true,
      },
    ],
  });

  const codexB = await startFakeCodexServer(workspace, {
    port: portB,
    deferListen: true,
    channelId: THREAD_B,
    bootstrapPlan: {
      turnId: "thread-b-boot",
      status: "completed",
      delta: "",
    },
    turns: [
      // Turn 2 (Agent Request from THREAD_A): MCP reply (input-needed) + send_agent_reply.
      {
        turnId: "thread-b-req-turn",
        status: "completed",
        mcpCalls: (input) => [
          ["reply", { text: "Thread B tool reply during request", conversation_disposition: "input-needed" }],
          ["send_agent_reply", { request_id: extractRequestId(input), text: "Thread B green" }],
        ],
      },
      // Turn 3 (owner message): sends expiring Agent Request to THREAD_A, no reply.
      {
        turnId: "thread-b-send-expiring",
        status: "completed",
        mcpCalls: () => [
          ["send_agent_request", { target: `demo/${THREAD_A}`, text: "Expiring thread ping", timeout_minutes: 1 }],
        ],
      },
      // Turn 4 (expiry notice): MCP reply during notice turn.
      {
        turnId: "thread-b-notice-turn",
        status: "completed",
        mcpCalls: () => [
          ["reply", { text: "Thread B reply during notice", conversation_disposition: "progress" }],
        ],
      },
      // Turn 5 (Agent Request from demo channel): held for owner steer, then MCP reply.
      {
        turnId: "thread-b-held-steer-turn",
        status: "completed",
        waitForRelease: true,
        mcpCalls: () => [
          ["reply", { text: "Thread B reply after owner steer", conversation_disposition: "progress" }],
        ],
      },
    ],
  });

  await routerWithWebhooks(workspace, ["demo", "beta"], {
    env: { CCDM_ROUTER_AGENT_MESSAGE_MINUTE_MS: "500" },
  });
  if (WIN) await startThreadHost(workspace);
  await startThreadSupervisor(workspace, {
    env: {
      ...(WIN ? { CCDM_REMINDER_STATE_DIR: context.stateDir } : {}),
      CCDM_THREAD_WS_PORT_BASE: String(portA),
      CODEX_BRIDGE_TEXT_REPLY_FALLBACK: "1",
    },
  });

  // Channel bridge for demo so it can send Agent Requests to THREAD_B (steer test) and closed THREAD_A.
  const demoKey = writeProjectKey(workspace, "demo", "demo-ch-thread-key");
  const demoCodex = await startFakeCodexServer(workspace, {
    channelId: "demo-channel",
    turns: [
      {
        turnId: "demo-send-to-b",
        status: "completed",
        mcpCalls: () => [["send_agent_request", { target: `demo/${THREAD_B}`, text: "Hold thread B for steer" }]],
      },
      {
        turnId: "demo-send-to-closed-a",
        status: "completed",
        mcpCalls: () => [["send_agent_request", { target: `demo/${THREAD_A}`, text: "Ping closed thread A" }]],
      },
    ],
  });
  const demoBridge = spawnCodexBridge(context, {
    project: "demo",
    channelId: "demo-channel",
    port: demoCodex.port,
    keyFile: demoKey,
  });
  await demoBridge.waitForOutput(/Listening in #demo/, 15000);
  await waitForFinishedTurns(demoBridge, 1, 10000, demoCodex);

  const stopWorker = await startReminderWorker(context, ["demo", "beta"]);

  // Boot THREAD_A (gets portA) and THREAD_B (gets portB) with quiet owner bootstrap messages.
  createDiscordThread(workspace, THREAD_A, "Codex Thread A");
  await waitForThreadRow(workspace, THREAD_A);
  injectDiscordMessage(workspace, { id: "thread-a-boot-msg", channelId: THREAD_A, author: owner, content: "open thread A" });
  const allocA = await waitForThreadRow(workspace, THREAD_A, (row) => row.ws_port != null);
  assert.equal(allocA.ws_port, portA);
  await codexA.listen();
  await waitForThreadRow(workspace, THREAD_A, (row) => row.state === "live");
  await waitForStatus(
    context,
    (current) => current.conversations.demo.threads?.[THREAD_A]?.last_ack_message_id === "thread-a-boot-msg",
    "thread A seeded",
  );

  createDiscordThread(workspace, THREAD_B, "Codex Thread B");
  await waitForThreadRow(workspace, THREAD_B);
  injectDiscordMessage(workspace, { id: "thread-b-boot-msg", channelId: THREAD_B, author: owner, content: "open thread B" });
  const allocB = await waitForThreadRow(workspace, THREAD_B, (row) => row.ws_port != null);
  assert.equal(allocB.ws_port, portB);
  await codexB.listen();
  await waitForThreadRow(workspace, THREAD_B, (row) => row.state === "live");
  const statusAfterBoot = await waitForStatus(
    context,
    (current) => current.conversations.demo.threads?.[THREAD_B]?.last_ack_message_id === "thread-b-boot-msg",
    "thread B seeded",
  );
  const threadBBefore = statusAfterBoot.conversations.demo.threads[THREAD_B];
  assert.equal(threadBBefore.state, "open-paused");
  assert.equal(threadBBefore.response_message_id, null);

  // Trigger thread-to-thread exchange: THREAD_A answers owner + sends request to THREAD_B;
  // THREAD_B posts MCP reply (input-needed) + sends Agent Reply; THREAD_A posts text fallback during reply turn.
  injectDiscordMessage(workspace, { id: "thread-a-owner-1", channelId: THREAD_A, author: owner, content: "ask thread B" });
  await waitFor(
    () => (readState(workspace.stateDir).fixtures.discord.messages ?? [])
      .some((m) => m.channelId === THREAD_B && m.content === "Thread B tool reply during request")
      && (readState(workspace.stateDir).fixtures.discord.messages ?? [])
        .some((m) => m.channelId === THREAD_A && m.content === "Thread A fallback during reply turn"),
    () => "thread-to-thread exchange replies posted",
    20000,
  );

  const threadAOwnerReply = readState(workspace.stateDir).fixtures.discord.messages.find(
    (m) => m.channelId === THREAD_A && m.content === "Thread A answered owner",
  );
  assert.ok(threadAOwnerReply);
  const afterThreadExchange = await waitForStatus(
    context,
    (current) => current.conversations.demo.threads?.[THREAD_A]?.state === "awaiting-owner",
    "thread A armed",
  );
  assert.equal(afterThreadExchange.conversations.demo.threads[THREAD_A].response_message_id, threadAOwnerReply.id);
  const threadBAfterExchange = afterThreadExchange.conversations.demo.threads[THREAD_B];
  assert.deepEqual(
    [threadBAfterExchange.state, threadBAfterExchange.revision, threadBAfterExchange.response_message_id, threadBAfterExchange.due_at],
    ["open-paused", threadBBefore.revision, null, null],
  );

  // THREAD_A's armed reminder fires at +61m and recurs at +182m; THREAD_B gets none.
  context.setClockMinutes(61);
  await waitFor(() => eyesIn(workspace, THREAD_A).length === 1, () => "thread A first reminder", 20000);
  assert.deepEqual(eyesIn(workspace, THREAD_B), []);
  context.setClockMinutes(61 + 121);
  await waitFor(() => eyesIn(workspace, THREAD_A).length === 2, () => "thread A recurring reminder", 20000);
  assert.deepEqual(eyesIn(workspace, THREAD_B), []);

  // Expiry notice turn in THREAD_B + text-reply fallback during Agent Request in THREAD_A.
  injectDiscordMessage(workspace, { id: "thread-b-owner-2", channelId: THREAD_B, author: owner, content: "ping thread A briefly" });
  await waitFor(
    () => (readState(workspace.stateDir).fixtures.discord.messages ?? [])
      .some((m) => m.channelId === THREAD_A && m.content === "Thread A fallback during expiring request")
      && (readState(workspace.stateDir).fixtures.discord.messages ?? [])
        .some((m) => m.channelId === THREAD_B && m.content === "Thread B reply during notice"),
    () => "thread expiring request fallback and notice reply posted",
    20000,
  );
  const afterThreadNotice = await waitForStatus(
    context,
    (current) => current.conversations.demo.threads?.[THREAD_B]?.last_ack_message_id === "thread-b-owner-2",
    "thread B ack 2",
  );
  assert.deepEqual(
    [
      afterThreadNotice.conversations.demo.threads[THREAD_B].state,
      afterThreadNotice.conversations.demo.threads[THREAD_B].response_message_id,
      afterThreadNotice.conversations.demo.threads[THREAD_B].due_at,
    ],
    ["open-paused", null, null],
  );

  // Owner steer into an agent-started turn in THREAD_B creates reminder context and arms a reminder.
  const threadBContextFile = registeredContextFile(codexB, THREAD_B);
  assert.ok(threadBContextFile, "expected thread B reminder context file in MCP config");

  injectDiscordMessage(workspace, { id: "demo-ask-thread-b", channelId: "demo-channel", author: owner, content: "ask thread B" });
  await waitFor(() => codexB.pendingReleases().includes("thread-b-held-steer-turn"), () => "thread B held agent turn", 15000);
  assert.equal(fs.existsSync(threadBContextFile), false, "agent-started thread turn must have no reminder context before steer");

  injectDiscordMessage(workspace, { id: "thread-b-owner-steer", channelId: THREAD_B, author: owner, content: "owner steer in thread B" });
  await waitFor(
    () => codexB.clientMessages.filter((m) => m.method === "turn/steer").length === 1,
    () => "thread B owner turn/steer",
    10000,
  );
  await waitFor(
    () => fs.existsSync(threadBContextFile),
    () => `thread B owner steer to create reminder context ${threadBContextFile}`,
    5000,
  );

  codexB.releaseTurn("thread-b-held-steer-turn");
  await waitFor(
    () => (readState(workspace.stateDir).fixtures.discord.messages ?? [])
      .some((m) => m.channelId === THREAD_B && m.content === "Thread B reply after owner steer"),
    () => "thread B post-steer reply",
    15000,
  );
  const threadBPostSteerReply = readState(workspace.stateDir).fixtures.discord.messages.find(
    (m) => m.channelId === THREAD_B && m.content === "Thread B reply after owner steer",
  );
  const afterThreadSteer = await waitForStatus(
    context,
    (current) => current.conversations.demo.threads?.[THREAD_B]?.state === "awaiting-owner",
    "thread B armed after owner steer",
  );
  assert.deepEqual(
    [
      afterThreadSteer.conversations.demo.threads[THREAD_B].current_interaction_id,
      afterThreadSteer.conversations.demo.threads[THREAD_B].response_message_id,
    ],
    ["thread-b-owner-steer", threadBPostSteerReply.id],
  );

  // Closed THREAD_A stays closed when targeted by an Agent Request (target_closed).
  injectDiscordMessage(workspace, { id: "thread-a-close", channelId: THREAD_A, author: owner, content: "/close" });
  const closedThreadStatus = await waitForStatus(
    context,
    (current) => current.conversations.demo.threads?.[THREAD_A]?.state === "closed",
    "thread A closed",
  );
  const closedThreadRevision = closedThreadStatus.conversations.demo.threads[THREAD_A].revision;
  await waitFor(
    () => readState(workspace.stateDir).fixtures.discord.threads[THREAD_A]?.archived === true,
    () => "thread A archived",
    15000,
  );

  injectDiscordMessage(workspace, { id: "demo-ask-closed-a", channelId: "demo-channel", author: owner, content: "ping closed thread A" });
  await waitForFinishedTurns(demoBridge, 3, 15000, demoCodex);
  await waitFor(
    () => (readState(workspace.stateDir).fixtures.codex.protocolEvents ?? [])
      .some((e) => e.event === "mcp-tool-result" && e.tool === "send_agent_request" && e.result?.content?.[0]?.text?.includes("target_closed")),
    () => "target_closed refusal for closed Codex thread",
    15000,
  );
  const closedThreadAfter = (await service(context, "status")).conversations.demo.threads[THREAD_A];
  assert.deepEqual([closedThreadAfter.state, closedThreadAfter.revision], ["closed", closedThreadRevision]);
  assert.equal(readState(workspace.stateDir).fixtures.discord.threads[THREAD_A].archived, true);

  await stopWorker();
  await demoBridge.stop();
});
