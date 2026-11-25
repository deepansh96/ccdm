import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { collectProcess, injectDiscordMessage } from "./support/bridge.js";
import { PYTHON } from "./support/platform.js";
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
  supervisorStateDir,
  supervisorStatus,
} from "./support/thread-supervisor.js";

test.afterEach(cleanup);

const WIN = process.platform === "win32";
const owner = { id: OWNER_ID, username: "Owner" };
const THREAD_A = "1700000000000405201";
const BOT_USER_ID = "fixture-bot-user-id";

function geminiReminderWorkspace() {
  const workspace = createRouterWorkspace({
    ...routerRegistry({
      demo: {
        channel_id: "demo-channel",
        type: "gemini",
        transport: "router",
        guest_user_ids: ["guest-id"],
        screen_name: "demo_gemini",
        assignment_generation: "gen-demo",
        session_id: null,
        pid: null,
        agent_message_targets: ["beta", "demo"],
      },
      beta: {
        channel_id: "beta-channel",
        type: "gemini",
        transport: "router",
        guest_user_ids: ["guest-id"],
        screen_name: "beta_gemini",
        assignment_generation: "gen-beta",
        session_id: null,
        pid: null,
        agent_message_targets: ["demo"],
      },
    }),
    root_channels: ["root-channel"],
  });
  const registryFile = path.join(workspace.repoDir, "registry.json");
  const registry = JSON.parse(fs.readFileSync(registryFile, "utf8"));
  registry.projects.demo.path = workspace.tmpDir;
  registry.projects.beta.path = workspace.tmpDir;
  fs.writeFileSync(registryFile, `${JSON.stringify(registry, null, 2)}\n`);
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

function fakeAgyBin(workspace) {
  const fake = path.join(workspace.repoDir, "tests/e2e/support/fake-agy.cjs");
  if (WIN) return fake;
  const bin = path.join(workspace.tmpRoot, "agy-bin", "agy");
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(
    bin,
    `#!/bin/sh\nexec /bin/bash -p -c 'exec -a agy "$0" "$@"' '${process.execPath}' '${fake}' "$@"\n`,
  );
  fs.chmodSync(bin, 0o755);
  return bin;
}

function agyPlan(dir, plan) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "agy-plan.json"), `${JSON.stringify(plan)}\n`);
}

function agyEvents(dir) {
  const file = path.join(dir, "agy.ndjson");
  return fs.existsSync(file)
    ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
    : [];
}

const promptTexts = (dir) => agyEvents(dir)
  .filter((event) => event.event === "client" && event.message.method === "session/prompt")
  .map((event) => event.message.params.prompt.filter((block) => block.type === "text").map((block) => block.text).join("\n"));

const mcpCalls = (dir, name = null) => agyEvents(dir)
  .filter((event) => event.event === "mcp-call" && (name === null || event.name === name));

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

function spawnGeminiBridge(context, { project, channelId, agyDir, extraEnv = {} }) {
  const { workspace } = context;
  const keyFile = path.join(workspace.routerStateDir, "keys", `${project}.key`);
  const env = servicesEnv(context, {
    CCDM_ROUTER_KEY_FILE: keyFile,
    CCDM_GEMINI_PROJECT: project,
    CHANNEL_ID: channelId,
    PROJECT_DIR: workspace.tmpDir,
    CCDM_AGY_BIN: fakeAgyBin(workspace),
    CCDM_FAKE_AGY_DIR: agyDir,
    CCDM_REMINDER_STATE_DIR: context.stateDir,
    ...extraEnv,
  });
  const child = spawn(process.execPath, [path.join(workspace.repoDir, "scripts/gemini-bridge.js")], {
    cwd: workspace.repoDir,
    detached: true,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const bridge = collectProcess(
    child,
    { command: [process.execPath, "scripts/gemini-bridge.js"], cwd: workspace.repoDir, detached: true, env },
    workspace,
  );
  registerTeardownCallback(() => bridge.stop());
  return bridge;
}

const eyesIn = (workspace, channelId) => (readState(workspace.stateDir).fixtures.discord.messages ?? [])
  .filter((message) => message.channelId === channelId && message.content === "👀");

function requestGeminiThread(workspace, threadId, name) {
  const store = path.join(supervisorStateDir(workspace), "threads.sqlite3");
  execFileSync(PYTHON, ["-c", `import sqlite3, sys
db = sqlite3.connect(sys.argv[1], timeout=5)
db.execute("""INSERT INTO creation_requests (request_id, project, name, provider, account, model, effort,
  first_message, requester_id, requester_kind, status, thread_id, created_at)
  VALUES ('request-gemini-rem-1', 'demo', ?, 'gemini', NULL, NULL, NULL, NULL, ?, 'owner', 'pending', NULL,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))""", (sys.argv[2], sys.argv[3]))
db.commit()`, store, name, OWNER_ID]);
  updateState(workspace.stateDir, (state) => {
    (state.fixtures.discord.injectedThreads ||= []).push({
      id: threadId,
      type: 11,
      parentId: "demo-channel",
      name,
      ownerId: BOT_USER_ID,
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

test("Gemini channel Agent Messages leave reminder state unchanged across request/reply/notice turns (tool and text fallback) and keep armed reminders recurring", async () => {
  const context = geminiReminderWorkspace();
  const { workspace } = context;
  await routerWithWebhooks(workspace, ["demo", "beta"], {
    env: { CCDM_ROUTER_AGENT_MESSAGE_MINUTE_MS: "500" },
  });
  writeProjectKey(workspace, "demo", "demo-gemini-key");
  writeProjectKey(workspace, "beta", "beta-gemini-key");

  const demoAgyDir = path.join(workspace.tmpRoot, "agy-demo-1");
  const betaAgyDir = path.join(workspace.tmpRoot, "agy-beta-1");

  agyPlan(demoAgyDir, {
    turns: [
      // Turn 1 (owner): answers owner (arms demo reminder) AND sends Agent Request to beta.
      {
        mcpCalls: [
          { name: "reply", args: { text: "Demo answered owner", conversation_disposition: "progress" }, withScopeToken: true },
          { name: "send_agent_request", args: { target: "beta", text: "Check Gemini build" }, withScopeToken: true },
        ],
      },
      // Turn 2 (Agent Reply): posts via text-reply fallback during reply-started turn.
      {
        text: "Demo fallback during reply turn",
      },
      // Turn 3 (Agent Request from beta that expires): posts via text-reply fallback, no send_agent_reply.
      {
        text: "Demo fallback during expiring request turn",
      },
    ],
  });

  agyPlan(betaAgyDir, {
    turns: [
      // Turn 1 (owner seed): no reply -> beta stays open-paused.
      {},
      // Turn 2 (Agent Request): calls MCP reply (input-needed) AND send_agent_reply.
      {
        mcpCalls: [
          { name: "reply", args: { text: "Beta tool reply during request turn", conversation_disposition: "input-needed" }, withScopeToken: true },
          { name: "send_agent_reply", args: { text: "Gemini build is green" }, withScopeToken: true, extractRequestId: true },
        ],
      },
      // Turn 3 (owner trigger for expiring request): only sends expiring Agent Request, no reply.
      {
        mcpCalls: [
          { name: "send_agent_request", args: { target: "demo", text: "Expiring check", timeout_minutes: 1 }, withScopeToken: true },
        ],
      },
      // Turn 4 (expiry notice): calls MCP reply during notice-started turn.
      {
        mcpCalls: [
          { name: "reply", args: { text: "Beta reply during expiry notice turn", conversation_disposition: "progress" }, withScopeToken: true },
        ],
      },
    ],
  });

  const demoBridge = spawnGeminiBridge(context, { project: "demo", channelId: "demo-channel", agyDir: demoAgyDir });
  const betaBridge = spawnGeminiBridge(context, { project: "beta", channelId: "beta-channel", agyDir: betaAgyDir });
  await demoBridge.waitForOutput(/Gemini-Discord bridge running/, 15000);
  await betaBridge.waitForOutput(/Gemini-Discord bridge running/, 15000);

  const stopWorker = await startReminderWorker(context, ["demo", "beta"]);

  // Seed beta with an owner interaction and leave it open-paused.
  injectDiscordMessage(workspace, { id: "beta-owner-1", channelId: "beta-channel", author: owner, content: "stand by" });
  await waitFor(() => promptTexts(betaAgyDir).length === 1, () => "beta seed prompt", 15000);
  await waitForStatus(context, (current) => current.conversations.beta.last_ack_message_id === "beta-owner-1", "beta seeded");
  const betaBefore = (await service(context, "status")).conversations.beta;
  assert.equal(betaBefore.state, "open-paused");
  assert.equal(betaBefore.response_message_id, null);

  // Trigger full exchange: demo answers owner + sends request -> beta calls MCP reply (input-needed) + send_agent_reply
  // -> demo handles Agent Reply via text-reply fallback.
  injectDiscordMessage(workspace, { id: "demo-owner-1", channelId: "demo-channel", author: owner, content: "ask beta" });
  await waitFor(
    () => (readState(workspace.stateDir).fixtures.discord.messages ?? [])
      .some((m) => m.channelId === "beta-channel" && m.content === "Beta tool reply during request turn")
      && (readState(workspace.stateDir).fixtures.discord.messages ?? [])
        .some((m) => m.channelId === "demo-channel" && m.content === "Demo fallback during reply turn"),
    () => "Gemini exchange replies posted",
    20000,
  );
  await waitFor(() => promptTexts(demoAgyDir).length === 2 && promptTexts(betaAgyDir).length === 2, () => "exchange prompts completed", 15000);

  const demoOwnerReply = readState(workspace.stateDir).fixtures.discord.messages.find(
    (m) => m.channelId === "demo-channel" && m.content === "Demo answered owner",
  );
  assert.ok(demoOwnerReply);

  const afterExchange = await waitForStatus(
    context,
    (current) => current.conversations.demo.state === "awaiting-owner",
    "demo armed on owner reply",
  );
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

  // Notice-started turn (expired request) + text-reply fallback during Agent Request:
  injectDiscordMessage(workspace, { id: "beta-owner-2", channelId: "beta-channel", author: owner, content: "ping demo briefly" });
  await waitFor(
    () => (readState(workspace.stateDir).fixtures.discord.messages ?? [])
      .some((m) => m.channelId === "demo-channel" && m.content === "Demo fallback during expiring request turn")
      && (readState(workspace.stateDir).fixtures.discord.messages ?? [])
        .some((m) => m.channelId === "beta-channel" && m.content === "Beta reply during expiry notice turn"),
    () => "expiring request fallback and notice reply posted",
    20000,
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

test("an owner message queued behind an agent-started Gemini channel turn starts an ordinary turn that arms a reminder, and a closed channel stays closed", async () => {
  const context = geminiReminderWorkspace();
  const { workspace } = context;
  await routerWithWebhooks(workspace, ["demo", "beta"]);
  writeProjectKey(workspace, "demo", "demo-gemini-q-key");
  writeProjectKey(workspace, "beta", "beta-gemini-q-key");

  const demoAgyDir = path.join(workspace.tmpRoot, "agy-demo-q");
  const betaAgyDir = path.join(workspace.tmpRoot, "agy-beta-q");
  const releaseHeldRequest = path.join(workspace.tmpRoot, "release-demo-request");

  agyPlan(demoAgyDir, {
    turns: [
      // Turn 1 (Agent Request from beta): held while owner message queues behind it, then posts via text-reply fallback.
      {
        holdUntilFile: releaseHeldRequest,
        text: "Demo fallback during held agent request",
      },
      // Turn 2 (queued owner message): starts its own ordinary turn and answers owner via MCP reply.
      {
        mcpCalls: [
          { name: "reply", args: { text: "Demo answered queued owner", conversation_disposition: "progress" }, withScopeToken: true },
        ],
      },
      // Turn 3 (owner trigger to ping closed beta): sends Agent Request to beta.
      {
        mcpCalls: [
          { name: "send_agent_request", args: { target: "beta", text: "Still closed?" }, withScopeToken: true },
        ],
      },
      // Turn 4 (Agent Reply from closed beta): silent.
      {},
    ],
  });

  agyPlan(betaAgyDir, {
    turns: [
      // Turn 1 (owner trigger): sends Agent Request to demo.
      {
        mcpCalls: [
          { name: "send_agent_request", args: { target: "demo", text: "Hold Gemini for queue test" }, withScopeToken: true },
        ],
      },
      // Turn 2 (Agent Request while closed): posts reply + send_agent_reply.
      {
        mcpCalls: [
          { name: "reply", args: { text: "Beta reply while closed", conversation_disposition: "progress" }, withScopeToken: true },
          { name: "send_agent_reply", args: { text: "Answering while closed" }, withScopeToken: true, extractRequestId: true },
        ],
      },
    ],
  });

  const demoBridge = spawnGeminiBridge(context, { project: "demo", channelId: "demo-channel", agyDir: demoAgyDir });
  const betaBridge = spawnGeminiBridge(context, { project: "beta", channelId: "beta-channel", agyDir: betaAgyDir });
  await demoBridge.waitForOutput(/Gemini-Discord bridge running/, 15000);
  await betaBridge.waitForOutput(/Gemini-Discord bridge running/, 15000);

  const stopWorker = await startReminderWorker(context, ["demo", "beta"]);

  // Beta sends an Agent Request to demo; demo starts its held agent-started turn.
  injectDiscordMessage(workspace, { id: "beta-ask-q", channelId: "beta-channel", author: owner, content: "ping demo" });
  await waitFor(() => promptTexts(demoAgyDir).length === 1, () => "demo held agent request prompt", 15000);
  assert.match(promptTexts(demoAgyDir)[0], /^\[Agent Request req-[0-9a-f]{12} from beta-gemini\]/);

  // Owner message arrives during the agent-started turn -> queues with ⏳.
  injectDiscordMessage(workspace, { id: "demo-owner-queued", channelId: "demo-channel", author: owner, content: "owner follow-up" });
  await waitFor(
    () => (readState(workspace.stateDir).fixtures.discord.reactions ?? [])
      .some((r) => r.messageId === "demo-owner-queued" && decodeURIComponent(r.emoji) === "⏳"),
    () => "queued owner ⏳ reaction",
    10000,
  );
  assert.equal(promptTexts(demoAgyDir).length, 1);

  // Release the held agent-started turn: it finishes with no receipt/completion, then the queued owner message
  // runs as its own ordinary turn and arms demo's reminder.
  fs.writeFileSync(releaseHeldRequest, "go\n");
  await waitFor(
    () => (readState(workspace.stateDir).fixtures.discord.messages ?? [])
      .some((m) => m.channelId === "demo-channel" && m.content === "Demo fallback during held agent request")
      && (readState(workspace.stateDir).fixtures.discord.messages ?? [])
        .some((m) => m.channelId === "demo-channel" && m.content === "Demo answered queued owner"),
    () => "agent fallback and queued owner reply posted",
    20000,
  );
  const demoPrompts = promptTexts(demoAgyDir);
  assert.equal(demoPrompts.length, 2, JSON.stringify(demoPrompts));
  assert.equal(demoPrompts[1], "owner follow-up");

  const ownerReply = readState(workspace.stateDir).fixtures.discord.messages.find(
    (m) => m.channelId === "demo-channel" && m.content === "Demo answered queued owner",
  );
  assert.ok(ownerReply);

  const armed = await waitForStatus(
    context,
    (current) => current.conversations.demo.state === "awaiting-owner",
    "demo armed on queued owner turn",
  );
  assert.equal(armed.conversations.demo.current_interaction_id, "demo-owner-queued");
  assert.equal(armed.conversations.demo.response_message_id, ownerReply.id);
  const demoEvents = (await projectReadiness(context, "demo")).events;
  assert.deepEqual(
    demoEvents.filter((e) => e.event_type === "response_delivered").map((e) => e.message_id),
    [ownerReply.id],
  );
  assert.deepEqual(
    demoEvents.filter((e) => e.event_type === "turn_completed").map((e) => e.delivered_message_ids),
    [[ownerReply.id]],
  );

  context.setClockMinutes(61);
  await waitForStatus(context, (current) => current.conversations.demo.consecutive_reminders === 1, "demo reminder after queued turn");
  assert.equal(eyesIn(workspace, "demo-channel").length, 1);

  // Close beta with /close, then have demo send an Agent Request to beta's live session:
  // beta handles it and replies, yet stays closed with no reminder.
  injectDiscordMessage(workspace, { id: "beta-close-q", channelId: "beta-channel", author: owner, content: "/close" });
  const closedBeta = await waitForStatus(context, (current) => current.conversations.beta.state === "closed", "beta closed");
  const closedRevision = closedBeta.conversations.beta.revision;

  injectDiscordMessage(workspace, { id: "demo-ping-closed-q", channelId: "demo-channel", author: owner, content: "ping closed beta" });
  await waitFor(() => promptTexts(demoAgyDir).length === 4, () => "demo received reply from closed beta", 20000);
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

test("Gemini Thread Conversations isolate Agent Messages from reminders, keep armed reminders recurring, arm on queued owner turn, and keep closed threads closed", async () => {
  const context = geminiReminderWorkspace();
  const { workspace } = context;
  await routerWithWebhooks(workspace, ["demo", "beta"], {
    env: { CCDM_ROUTER_AGENT_MESSAGE_MINUTE_MS: "500" },
  });
  if (WIN) await startThreadHost(workspace);

  const threadAgyDir = path.join(workspace.tmpRoot, "agy-thread-a");
  const betaAgyDir = path.join(workspace.tmpRoot, "agy-beta-thread");
  const releaseThreadHeldReq = path.join(workspace.tmpRoot, "release-thread-held-req");

  agyPlan(threadAgyDir, {
    turns: [
      // Turn 1 (bootstrap owner message): quiet -> THREAD_A stays open-paused.
      {},
      // Turn 2 (Agent Request from beta): MCP reply (input-needed) + send_agent_reply.
      {
        mcpCalls: [
          { name: "reply", args: { text: "Thread A tool reply during request", conversation_disposition: "input-needed" }, withScopeToken: true },
          { name: "send_agent_reply", args: { text: "Thread A green" }, withScopeToken: true, extractRequestId: true },
        ],
      },
      // Turn 3 (owner message): sends expiring Agent Request to beta, no reply -> stays open-paused.
      {
        mcpCalls: [
          { name: "send_agent_request", args: { target: "beta", text: "Expiring from Gemini thread", timeout_minutes: 1 }, withScopeToken: true },
        ],
      },
      // Turn 4 (expiry notice): text-reply fallback during notice turn.
      {
        text: "Thread A fallback during expiry notice",
      },
      // Turn 5 (Agent Request from beta): held while owner queues behind it, then posts via text-reply fallback.
      {
        holdUntilFile: releaseThreadHeldReq,
        text: "Thread A fallback during held request",
      },
      // Turn 6 (queued owner message): answers owner (arms THREAD_A reminder) AND sends Agent Request to beta.
      {
        mcpCalls: [
          { name: "reply", args: { text: "Thread A answered queued owner", conversation_disposition: "progress" }, withScopeToken: true },
          { name: "send_agent_request", args: { target: "beta", text: "Check after arming thread" }, withScopeToken: true },
        ],
      },
      // Turn 7 (Agent Reply from beta): text-reply fallback during reply turn (must not disturb armed reminder).
      {
        text: "Thread A fallback during reply turn",
      },
    ],
  });

  agyPlan(betaAgyDir, {
    turns: [
      // Turn 1 (owner): sends Agent Request to THREAD_A.
      {
        mcpCalls: [
          { name: "send_agent_request", args: { target: `demo/${THREAD_A}`, text: "Check Gemini thread A" }, withScopeToken: true },
        ],
      },
      // Turn 2 (Agent Reply from THREAD_A): silent.
      {},
      // Turn 3 (expiring Agent Request from THREAD_A): silent (no send_agent_reply, so it expires).
      {},
      // Turn 4 (owner): sends Agent Request to THREAD_A (for held/queued owner test).
      {
        mcpCalls: [
          { name: "send_agent_request", args: { target: `demo/${THREAD_A}`, text: "Hold Gemini thread A" }, withScopeToken: true },
        ],
      },
      // Turn 5 (Agent Request from THREAD_A after arming): answers with send_agent_reply.
      {
        mcpCalls: [
          { name: "send_agent_reply", args: { text: "Beta confirms armed thread" }, withScopeToken: true, extractRequestId: true },
        ],
      },
      // Turn 6 (owner): sends Agent Request to closed THREAD_A -> target_closed.
      {
        mcpCalls: [
          { name: "send_agent_request", args: { target: `demo/${THREAD_A}`, text: "Ping closed Gemini thread" }, withScopeToken: true },
        ],
      },
    ],
  });

  await startThreadSupervisor(workspace, {
    env: {
      ...(WIN ? { CCDM_REMINDER_STATE_DIR: context.stateDir } : {}),
      CCDM_AGY_BIN: fakeAgyBin(workspace),
      CCDM_FAKE_AGY_DIR: threadAgyDir,
    },
  });

  writeProjectKey(workspace, "beta", "beta-gemini-thread-key");
  const betaBridge = spawnGeminiBridge(context, { project: "beta", channelId: "beta-channel", agyDir: betaAgyDir });
  await betaBridge.waitForOutput(/Gemini-Discord bridge running/, 15000);

  const stopWorker = await startReminderWorker(context, ["demo", "beta"]);

  // Boot Gemini THREAD_A via real Thread Supervisor with quiet owner bootstrap.
  requestGeminiThread(workspace, THREAD_A, "Gemini Thread A");
  await waitForThreadRow(workspace, THREAD_A, (row) => row.provider === "gemini");
  injectDiscordMessage(workspace, { id: "thread-a-boot-1", channelId: THREAD_A, author: owner, content: "open Gemini thread A" });
  await waitForThreadRow(workspace, THREAD_A, (row) => row.state === "live");
  await waitFor(() => promptTexts(threadAgyDir).length === 1, () => "thread A bootstrap prompt", 15000);
  const statusAfterBoot = await waitForStatus(
    context,
    (current) => current.conversations.demo.threads?.[THREAD_A]?.last_ack_message_id === "thread-a-boot-1",
    "thread A seeded",
  );
  const threadABefore = statusAfterBoot.conversations.demo.threads[THREAD_A];
  assert.equal(threadABefore.state, "open-paused");
  assert.equal(threadABefore.response_message_id, null);

  // 1. Beta sends Agent Request to THREAD_A -> THREAD_A posts MCP reply (input-needed) + send_agent_reply -> unchanged!
  injectDiscordMessage(workspace, { id: "beta-req-1", channelId: "beta-channel", author: owner, content: "ask thread A" });
  await waitFor(() => promptTexts(betaAgyDir).length === 2, () => "beta received thread A reply", 20000);
  await waitFor(
    () => (readState(workspace.stateDir).fixtures.discord.messages ?? [])
      .some((m) => m.channelId === THREAD_A && m.content === "Thread A tool reply during request"),
    () => "thread A request turn reply posted",
    15000,
  );
  const threadAAfterReq = (await service(context, "status")).conversations.demo.threads[THREAD_A];
  assert.deepEqual(
    [threadAAfterReq.state, threadAAfterReq.revision, threadAAfterReq.response_message_id, threadAAfterReq.due_at],
    ["open-paused", threadABefore.revision, null, null],
  );

  // 2. Expiry notice in THREAD_A: text-reply fallback during notice turn arms nothing.
  injectDiscordMessage(workspace, { id: "thread-a-owner-2", channelId: THREAD_A, author: owner, content: "send expiring request" });
  await waitFor(
    () => (readState(workspace.stateDir).fixtures.discord.messages ?? [])
      .some((m) => m.channelId === THREAD_A && m.content === "Thread A fallback during expiry notice"),
    () => "thread A notice fallback posted",
    20000,
  );
  const afterThreadNotice = await waitForStatus(
    context,
    (current) => current.conversations.demo.threads?.[THREAD_A]?.last_ack_message_id === "thread-a-owner-2",
    "thread A ack 2",
  );
  assert.deepEqual(
    [
      afterThreadNotice.conversations.demo.threads[THREAD_A].state,
      afterThreadNotice.conversations.demo.threads[THREAD_A].response_message_id,
      afterThreadNotice.conversations.demo.threads[THREAD_A].due_at,
    ],
    ["open-paused", null, null],
  );

  // 3. Owner message queued behind held agent-started turn in THREAD_A starts an ordinary turn, arms reminder,
  //    sends Agent Request to beta, handles beta's Agent Reply via fallback, and armed reminder recurs at +61m/+182m!
  injectDiscordMessage(workspace, { id: "beta-req-hold", channelId: "beta-channel", author: owner, content: "hold thread A" });
  await waitFor(() => promptTexts(threadAgyDir).length === 5, () => "thread A held agent prompt", 15000);

  injectDiscordMessage(workspace, { id: "thread-a-owner-queued", channelId: THREAD_A, author: owner, content: "owner queued in thread A" });
  await waitFor(
    () => (readState(workspace.stateDir).fixtures.discord.reactions ?? [])
      .some((r) => r.messageId === "thread-a-owner-queued" && decodeURIComponent(r.emoji) === "⏳"),
    () => "thread A queued owner ⏳ reaction",
    10000,
  );

  fs.writeFileSync(releaseThreadHeldReq, "go\n");
  await waitFor(
    () => (readState(workspace.stateDir).fixtures.discord.messages ?? [])
      .some((m) => m.channelId === THREAD_A && m.content === "Thread A fallback during held request")
      && (readState(workspace.stateDir).fixtures.discord.messages ?? [])
        .some((m) => m.channelId === THREAD_A && m.content === "Thread A answered queued owner")
      && (readState(workspace.stateDir).fixtures.discord.messages ?? [])
        .some((m) => m.channelId === THREAD_A && m.content === "Thread A fallback during reply turn"),
    () => "thread A held fallback, queued owner reply, and reply-turn fallback posted",
    25000,
  );

  const threadAOwnerReply = readState(workspace.stateDir).fixtures.discord.messages.find(
    (m) => m.channelId === THREAD_A && m.content === "Thread A answered queued owner",
  );
  assert.ok(threadAOwnerReply);

  const threadAArmed = await waitForStatus(
    context,
    (current) => current.conversations.demo.threads?.[THREAD_A]?.state === "awaiting-owner",
    "thread A armed on queued owner turn",
  );
  assert.deepEqual(
    [
      threadAArmed.conversations.demo.threads[THREAD_A].current_interaction_id,
      threadAArmed.conversations.demo.threads[THREAD_A].response_message_id,
    ],
    ["thread-a-owner-queued", threadAOwnerReply.id],
  );

  // Armed reminder in THREAD_A recurs on schedule (+61m and +182m), unaffected by the Agent Reply fallback turn.
  context.setClockMinutes(61);
  await waitFor(() => eyesIn(workspace, THREAD_A).length === 1, () => "thread A first reminder", 20000);
  context.setClockMinutes(61 + 121);
  await waitFor(() => eyesIn(workspace, THREAD_A).length === 2, () => "thread A recurring reminder", 20000);

  // 4. Closed Gemini thread stays closed when targeted by an Agent Request (target_closed).
  injectDiscordMessage(workspace, { id: "thread-a-close", channelId: THREAD_A, author: owner, content: "/close" });
  const closedStatus = await waitForStatus(
    context,
    (current) => current.conversations.demo.threads?.[THREAD_A]?.state === "closed",
    "thread A closed",
  );
  const closedRev = closedStatus.conversations.demo.threads[THREAD_A].revision;
  await waitFor(
    () => readState(workspace.stateDir).fixtures.discord.threads[THREAD_A]?.archived === true,
    () => "thread A archived",
    15000,
  );

  injectDiscordMessage(workspace, { id: "beta-req-closed", channelId: "beta-channel", author: owner, content: "ping closed thread A" });
  await waitFor(
    () => mcpCalls(betaAgyDir, "send_agent_request").some((c) => c.result?.content?.[0]?.text?.includes("target_closed")),
    () => "target_closed refusal for closed Gemini thread",
    20000,
  );
  const closedAfter = (await service(context, "status")).conversations.demo.threads[THREAD_A];
  assert.deepEqual([closedAfter.state, closedAfter.revision], ["closed", closedRev]);
  assert.equal(readState(workspace.stateDir).fixtures.discord.threads[THREAD_A].archived, true);

  await stopWorker();
  await betaBridge.stop();
});
