import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import test from "node:test";

import { injectDiscordMessage } from "./support/bridge.js";
import { runScript } from "./support/runner.js";
import {
  OWNER_ID,
  createRouterWorkspace,
  listenAsRouter,
  proofReply,
  routerEnv,
  routerRegistry,
  routerSocketPath,
  routerWithWebhooks,
  seedThreads,
  waitFor,
  writeProjectKey,
  writeThreadKey,
} from "./support/router.js";
import { startFakeHost } from "./support/session-fixture.js";
import { readState, updateState } from "./support/state.js";
import { cleanup, registerTeardownCallback } from "./support/teardown.js";
import {
  startThreadSupervisor,
  supervisorStatus,
} from "./support/thread-supervisor.js";

test.afterEach(cleanup);

const THREAD_ID = "1700000000000401001";

const fakeHosts = new WeakMap();
async function launcherEnv(workspace, extraEnv = {}) {
  if (process.platform !== "win32") return routerEnv(workspace, extraEnv);
  if (!fakeHosts.has(workspace)) {
    fakeHosts.set(workspace, await startFakeHost(workspace, { env: routerEnv(workspace) }));
  }
  return routerEnv(workspace, { ...fakeHosts.get(workspace).env, ...extraEnv });
}

function claudeGateWorkspace(extra = {}) {
  const workspace = createRouterWorkspace({
    ...routerRegistry({
      demo: {
        channel_id: "demo-channel",
        type: "claude",
        transport: "router",
        screen_name: "demo_claude",
        session_id: null,
        pid: null,
        agent_message_targets: ["beta"],
        ...(extra.demo || {}),
      },
      beta: {
        channel_id: "beta-channel",
        type: "codex",
        transport: "router",
        agent_message_targets: ["demo"],
        ...(extra.beta || {}),
      },
    }),
    root_channels: ["root-channel"],
    ...(extra.registry || {}),
  });
  const registryFile = path.join(workspace.repoDir, "registry.json");
  const registry = JSON.parse(fs.readFileSync(registryFile, "utf8"));
  registry.projects.demo.path = workspace.tmpDir;
  registry.projects.beta.path = workspace.tmpDir;
  fs.writeFileSync(registryFile, `${JSON.stringify(registry, null, 2)}\n`);
  return workspace;
}

async function startClaudeChannel(workspace, project = "demo", extraEnv = {}) {
  const started = await runScript(workspace, "scripts/start-session.sh", {
    args: [project],
    env: await launcherEnv(workspace, extraEnv),
    timeoutMs: 30000,
  });
  assert.equal(started.exitCode, 0, started.stderr || started.stdout);
  return started;
}

async function rawClient(workspace, hello) {
  const socket = net.connect(routerSocketPath(workspace));
  registerTeardownCallback(() => socket.destroy());
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  const frames = [];
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.trim()) frames.push(JSON.parse(line));
    }
  });
  const closed = new Promise((resolve) => socket.once("close", resolve));
  const send = (frame) => socket.write(typeof frame === "string" ? frame : `${JSON.stringify(frame)}\n`);
  send({ type: "hello", v: 1, ...hello });
  const answer = await waitFor(
    () => frames.find((frame) => frame.type === "hello_ok" || frame.type === "hello_error"),
    () => `${hello.role} hello: ${JSON.stringify(frames)}`,
  );
  assert.equal(answer.type, "hello_ok", JSON.stringify(answer));
  let requests = 0;
  return {
    frames,
    closed,
    send,
    close() {
      socket.destroy();
      return closed;
    },
    get events() { return frames.filter((frame) => frame.type === "event"); },
    async request(op, args = {}, timeoutMs = 5000) {
      const id = `request-${++requests}`;
      send({ type: "request", id, op, args });
      return waitFor(
        () => frames.find((frame) => frame.type === "response" && frame.id === id),
        () => `${op} response: ${JSON.stringify(frames)}`,
        timeoutMs,
      );
    },
  };
}

function connectAgentProject(workspace, project, key) {
  return rawClient(workspace, {
    role: "project",
    project,
    key,
    capabilities: ["agent_messages"],
  });
}

function claudeNotifications(workspace, chatId) {
  const all = readState(workspace.stateDir).fixtures.claude.channelNotifications ?? [];
  return chatId ? all.filter((entry) => entry.meta?.chat_id === chatId) : all;
}

function releaseOneTurn(workspace, conversationId) {
  updateState(workspace.stateDir, (state) => {
    (state.fixtures.claude.releaseTurns ||= []).push(conversationId);
  });
}

function waitForReceiverPost(workspace, channelId, requestId) {
  return waitFor(
    () => (readState(workspace.stateDir).fixtures.discord.messages ?? [])
      .some((msg) => msg.channelId === channelId && msg.content.includes(requestId)),
    () => `receiver post for ${requestId} in ${channelId}: ${JSON.stringify(readState(workspace.stateDir).fixtures.discord.messages)}`,
    10000,
  );
}

test("in a Claude channel session, Agent Messages wait for running turns and deliver one per turn end oldest first while owner messages still arrive mid-turn", async () => {
  const workspace = claudeGateWorkspace();
  await routerWithWebhooks(workspace, ["demo", "beta"]);
  const beta = await connectAgentProject(workspace, "beta", "beta-key");

  updateState(workspace.stateDir, (state) => {
    state.fixtures.claude.holdTurnsIn = ["demo-channel"];
  });
  await startClaudeChannel(workspace, "demo");

  // Start Turn 1 (held).
  injectDiscordMessage(workspace, {
    id: "owner-turn-1",
    channelId: "demo-channel",
    content: "long running task",
    author: { id: OWNER_ID, username: "Owner" },
  });
  await waitFor(
    () => claudeNotifications(workspace, "demo-channel").some((n) => n.meta.message_id === "owner-turn-1"),
    () => `turn 1 start: ${JSON.stringify(claudeNotifications(workspace, "demo-channel"))}`,
    15000,
  );

  // Two Agent Requests arrive during Turn 1.
  const req1 = await beta.request("agent_request", {
    target: "demo",
    text: "First agent request",
    idempotency_key: "gate-chan-req-1",
  });
  assert.equal(req1.ok, true, JSON.stringify(req1));
  const req2 = await beta.request("agent_request", {
    target: "demo",
    text: "Second agent request",
    idempotency_key: "gate-chan-req-2",
  });
  assert.equal(req2.ok, true, JSON.stringify(req2));
  await waitForReceiverPost(workspace, "demo-channel", req1.result.request_id);
  await waitForReceiverPost(workspace, "demo-channel", req2.result.request_id);

  // An owner message arriving mid-turn is STILL delivered immediately and acts as our observable fence.
  injectDiscordMessage(workspace, {
    id: "owner-midturn-1",
    channelId: "demo-channel",
    content: "mid-turn owner nudge",
    author: { id: OWNER_ID, username: "Owner" },
  });
  await waitFor(
    () => claudeNotifications(workspace, "demo-channel").some((n) => n.meta.message_id === "owner-midturn-1"),
    () => `mid-turn owner message: ${JSON.stringify(claudeNotifications(workspace, "demo-channel"))}`,
    15000,
  );
  assert.deepEqual(
    claudeNotifications(workspace, "demo-channel").map((n) => [n.meta.sender, n.content]),
    [
      ["owner", "long running task"],
      ["owner", "mid-turn owner nudge"],
    ],
  );

  // End Turn 1 (still holding subsequent turns): ONLY the oldest Agent Request arrives.
  releaseOneTurn(workspace, "demo-channel");
  await waitFor(
    () => claudeNotifications(workspace, "demo-channel").some((n) => n.meta.request_id === req1.result.request_id),
    () => `first agent request after turn 1 end: ${JSON.stringify(claudeNotifications(workspace, "demo-channel"))}`,
    15000,
  );

  // Send a second mid-turn owner fence while req1's turn is held: req2 must still wait!
  injectDiscordMessage(workspace, {
    id: "owner-midturn-2",
    channelId: "demo-channel",
    content: "fence during req1 turn",
    author: { id: OWNER_ID, username: "Owner" },
  });
  await waitFor(
    () => claudeNotifications(workspace, "demo-channel").some((n) => n.meta.message_id === "owner-midturn-2"),
    () => `second mid-turn owner fence: ${JSON.stringify(claudeNotifications(workspace, "demo-channel"))}`,
    15000,
  );
  assert.deepEqual(
    claudeNotifications(workspace, "demo-channel").map((n) => [n.meta.sender, n.meta.request_id ?? n.meta.message_id, n.content]),
    [
      ["owner", "owner-turn-1", "long running task"],
      ["owner", "owner-midturn-1", "mid-turn owner nudge"],
      ["agent", req1.result.request_id, "First agent request"],
      ["owner", "owner-midturn-2", "fence during req1 turn"],
    ],
  );

  // End req1's turn: now req2 arrives as its own turn.
  releaseOneTurn(workspace, "demo-channel");
  await waitFor(
    () => claudeNotifications(workspace, "demo-channel").some((n) => n.meta.request_id === req2.result.request_id),
    () => `second agent request after req1 turn end: ${JSON.stringify(claudeNotifications(workspace, "demo-channel"))}`,
    15000,
  );
  assert.deepEqual(
    claudeNotifications(workspace, "demo-channel").map((n) => [n.meta.sender, n.meta.request_id ?? n.meta.message_id, n.content]),
    [
      ["owner", "owner-turn-1", "long running task"],
      ["owner", "owner-midturn-1", "mid-turn owner nudge"],
      ["agent", req1.result.request_id, "First agent request"],
      ["owner", "owner-midturn-2", "fence during req1 turn"],
      ["agent", req2.result.request_id, "Second agent request"],
    ],
  );

  // Release final held turn so cleanup is clean.
  updateState(workspace.stateDir, (state) => {
    state.fixtures.claude.holdTurnsIn = [];
  });
});

function waitForChannelPost(workspace, channelId, predicate, label) {
  return waitFor(
    () => (readState(workspace.stateDir).fixtures.discord.messages ?? [])
      .some((msg) => msg.channelId === channelId && predicate(msg)),
    () => `${label} in ${channelId}: ${JSON.stringify(readState(workspace.stateDir).fixtures.discord.messages)}`,
    15000,
  );
}

function waitForReaction(workspace, channelId, emoji, predicate = () => true) {
  const encoded = encodeURIComponent(emoji);
  return waitFor(
    () => (readState(workspace.stateDir).fixtures.discord.reactions ?? [])
      .some((r) => r.channelId === channelId && (r.emoji === emoji || r.emoji === encoded) && predicate(r)),
    () => `reaction ${emoji} in ${channelId}: ${JSON.stringify(readState(workspace.stateDir).fixtures.discord.reactions)}`,
    15000,
  );
}

function createThread(workspace, thread = {}) {
  updateState(workspace.stateDir, (state) => {
    (state.fixtures.discord.injectedThreads ||= []).push({
      id: THREAD_ID,
      type: 11,
      parentId: "demo-channel",
      name: "Gate thread",
      ownerId: OWNER_ID,
      autoArchiveDuration: 1440,
      event: "create",
      ...thread,
    });
  });
}

async function waitForThreadState(workspace, project, threadId, predicate, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await supervisorStatus(workspace);
    const row = last.projects?.[project]?.threads?.[threadId];
    if (row && predicate(row)) return row;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`thread ${project}/${threadId} never matched: ${JSON.stringify(last)}`);
}

async function spawnChannelServer(workspace, { project = "demo", key = "demo-key", threadId = "", extraEnv = {} } = {}) {
  let keyFile;
  if (threadId) {
    writeThreadKey(workspace, threadId, key);
    keyFile = path.join(workspace.routerStateDir, "keys", `.thread-${threadId}.key`);
  } else {
    writeProjectKey(workspace, project, key);
    keyFile = path.join(workspace.routerStateDir, "keys", `${project}.key`);
  }
  const readyFile = path.join(workspace.tmpDir, `ready-${project}-${threadId || "chan"}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  const child = spawn(process.execPath, [path.join(workspace.repoDir, "scripts", "ccdm-channel-server.js")], {
    cwd: workspace.repoDir,
    env: routerEnv(workspace, {
      CCDM_CLAUDE_PROJECT: project,
      CCDM_ROUTER_KEY_FILE: keyFile,
      CCDM_CHANNEL_READY_FILE: readyFile,
      CCDM_ROUTER_RECONNECT_MIN_MS: "50",
      CCDM_ROUTER_RECONNECT_MAX_MS: "100",
      ...(threadId ? { CCDM_THREAD_ID: threadId, CCDM_THREAD_PROVIDER: "claude" } : {}),
      ...extraEnv,
    }),
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  registerTeardownCallback(() => {
    child.kill("SIGTERM");
  });
  const messages = [];
  const notifications = [];
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      const frame = JSON.parse(line);
      messages.push(frame);
      if (frame.method === "notifications/claude/channel") notifications.push(frame.params);
    }
  });
  let nextId = 1;
  const write = (frame) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...frame })}\n`);
  const call = async (method, params = {}, timeoutMs = 15000) => {
    const id = nextId++;
    write({ id, method, params });
    return waitFor(
      () => messages.find((frame) => frame.id === id),
      () => `${method} reply (stderr=${stderr}): ${JSON.stringify(messages)}`,
      timeoutMs,
    );
  };
  await waitFor(() => fs.existsSync(readyFile), () => `ready file (stderr=${stderr})`, 10000);
  const ready = JSON.parse(fs.readFileSync(readyFile, "utf8"));
  assert.equal(ready.ok, true, `channel server hello failed: ${JSON.stringify(ready)} ${stderr}`);
  await call("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } });
  write({ method: "notifications/initialized" });
  return { child, messages, notifications, call, get stderr() { return stderr; } };
}

test("in a Claude channel session, /pause holds Agent Messages and /unpause during a running turn flushes owner messages while keeping Agent Messages gated until turn end", async () => {
  const workspace = claudeGateWorkspace();
  await routerWithWebhooks(workspace, ["demo", "beta"]);
  const beta = await connectAgentProject(workspace, "beta", "beta-key");

  updateState(workspace.stateDir, (state) => {
    state.fixtures.claude.holdTurnsIn = ["demo-channel"];
  });
  await startClaudeChannel(workspace, "demo");

  // Part 1: while idle and paused, an Agent Message is held until /unpause.
  injectDiscordMessage(workspace, {
    id: "cmd-pause-idle",
    channelId: "demo-channel",
    content: "/pause",
    author: { id: OWNER_ID, username: "Owner" },
  });
  await waitForChannelPost(workspace, "demo-channel", (m) => /Session paused/i.test(m.content), "pause ack 1");

  const pausedReqIdle = await beta.request("agent_request", {
    target: "demo",
    text: "Arrived while idle and paused",
    idempotency_key: "pause-idle-req-1",
  });
  assert.equal(pausedReqIdle.ok, true, JSON.stringify(pausedReqIdle));
  await waitForReceiverPost(workspace, "demo-channel", pausedReqIdle.result.request_id);

  // Send a queued owner message too, then /unpause: the owner message flushes
  // first and starts a held turn, so the held Agent Message still waits for
  // that turn to end rather than flushing with the owner message.
  injectDiscordMessage(workspace, {
    id: "owner-paused-1",
    channelId: "demo-channel",
    content: "queued owner 1",
    author: { id: OWNER_ID, username: "Owner" },
  });
  assert.deepEqual(claudeNotifications(workspace, "demo-channel"), []);

  injectDiscordMessage(workspace, {
    id: "cmd-unpause-1",
    channelId: "demo-channel",
    content: "/unpause",
    author: { id: OWNER_ID, username: "Owner" },
  });
  await waitForChannelPost(workspace, "demo-channel", (m) => /Session unpaused/i.test(m.content), "unpause ack 1");
  await waitFor(
    () => claudeNotifications(workspace, "demo-channel").some((n) => n.meta.message_id === "owner-paused-1"),
    () => `flushed owner 1: ${JSON.stringify(claudeNotifications(workspace, "demo-channel"))}`,
    15000,
  );
  // Owner fence mid-turn proves the Agent Message did NOT flush alongside owner-paused-1.
  injectDiscordMessage(workspace, {
    id: "owner-mid-after-unpause-1",
    channelId: "demo-channel",
    content: "mid-turn fence 1",
    author: { id: OWNER_ID, username: "Owner" },
  });
  await waitFor(
    () => claudeNotifications(workspace, "demo-channel").some((n) => n.meta.message_id === "owner-mid-after-unpause-1"),
    () => `mid-turn fence 1: ${JSON.stringify(claudeNotifications(workspace, "demo-channel"))}`,
    15000,
  );
  assert.equal(
    claudeNotifications(workspace, "demo-channel").some((n) => n.meta.request_id === pausedReqIdle.result.request_id),
    false,
    JSON.stringify(claudeNotifications(workspace, "demo-channel")),
  );

  // Part 2: /pause and /unpause WHILE a turn is already running.
  injectDiscordMessage(workspace, {
    id: "cmd-pause-busy",
    channelId: "demo-channel",
    content: "/pause",
    author: { id: OWNER_ID, username: "Owner" },
  });
  await waitFor(
    () => (readState(workspace.stateDir).fixtures.discord.messages ?? [])
      .filter((m) => m.channelId === "demo-channel" && /Session paused/i.test(m.content)).length >= 2,
    () => "pause ack 2",
    15000,
  );
  const pausedReqBusy = await beta.request("agent_request", {
    target: "demo",
    text: "Arrived while busy and paused",
    idempotency_key: "pause-busy-req-2",
  });
  assert.equal(pausedReqBusy.ok, true, JSON.stringify(pausedReqBusy));
  await waitForReceiverPost(workspace, "demo-channel", pausedReqBusy.result.request_id);
  injectDiscordMessage(workspace, {
    id: "owner-paused-2",
    channelId: "demo-channel",
    content: "queued owner while busy",
    author: { id: OWNER_ID, username: "Owner" },
  });

  // /unpause while the turn is still running: owner-paused-2 flushes immediately,
  // while BOTH held Agent Messages still wait for the running turn to end.
  injectDiscordMessage(workspace, {
    id: "cmd-unpause-2",
    channelId: "demo-channel",
    content: "/unpause",
    author: { id: OWNER_ID, username: "Owner" },
  });
  await waitFor(
    () => claudeNotifications(workspace, "demo-channel").some((n) => n.meta.message_id === "owner-paused-2"),
    () => `flushed owner 2: ${JSON.stringify(claudeNotifications(workspace, "demo-channel"))}`,
    15000,
  );
  assert.deepEqual(
    claudeNotifications(workspace, "demo-channel").map((n) => [n.meta.sender, n.content]),
    [
      ["owner", "queued owner 1"],
      ["owner", "mid-turn fence 1"],
      ["owner", "queued owner while busy"],
    ],
  );

  // Release Turn 1 -> first held Agent Message arrives; release its turn -> second arrives.
  releaseOneTurn(workspace, "demo-channel");
  await waitFor(
    () => claudeNotifications(workspace, "demo-channel").some((n) => n.meta.request_id === pausedReqIdle.result.request_id),
    () => `first paused agent msg: ${JSON.stringify(claudeNotifications(workspace, "demo-channel"))}`,
    15000,
  );
  releaseOneTurn(workspace, "demo-channel");
  await waitFor(
    () => claudeNotifications(workspace, "demo-channel").some((n) => n.meta.request_id === pausedReqBusy.result.request_id),
    () => `second paused agent msg: ${JSON.stringify(claudeNotifications(workspace, "demo-channel"))}`,
    15000,
  );
  assert.deepEqual(
    claudeNotifications(workspace, "demo-channel").filter((n) => n.meta.sender === "agent").map((n) => n.meta.request_id),
    [pausedReqIdle.result.request_id, pausedReqBusy.result.request_id],
  );

  updateState(workspace.stateDir, (state) => {
    state.fixtures.claude.holdTurnsIn = [];
  });
});

test("in a Claude channel session, a request expiring while held is dropped, a held reply still delivers, and the sender's expiry notice follows the same idle gate", async () => {
  const workspace = claudeGateWorkspace();
  await routerWithWebhooks(workspace, ["demo", "beta"], {
    env: { CCDM_ROUTER_AGENT_MESSAGE_MINUTE_MS: "250" },
  });
  const beta = await connectAgentProject(workspace, "beta", "beta-key");

  // During Turn 1 (held), Claude sends two requests to beta: one that beta will
  // answer while Turn 1 is still running, and one with timeout_minutes=1 that
  // will expire while Turn 1 is still running.
  updateState(workspace.stateDir, (state) => {
    state.fixtures.claude.holdTurnsIn = ["demo-channel"];
    state.fixtures.claude.toolScript = [
      { name: "send_agent_request", arguments: { target: "beta", text: "Answer me while I am busy" } },
      { name: "send_agent_request", arguments: { target: "beta", text: "Expire while I am busy", timeout_minutes: 1 } },
    ];
  });
  await startClaudeChannel(workspace, "demo");

  injectDiscordMessage(workspace, {
    id: "owner-expiry-turn",
    channelId: "demo-channel",
    content: "kick off busy turn",
    author: { id: OWNER_ID, username: "Owner" },
  });
  await waitFor(
    () => beta.events.filter((e) => e.event === "agent_message" && e.kind === "request").length >= 2,
    () => `two outgoing requests to beta: ${JSON.stringify(beta.events)}`,
    15000,
  );
  updateState(workspace.stateDir, (state) => {
    delete state.fixtures.claude.toolScript;
  });

  const [outReqAnswered, outReqExpiring] = beta.events.filter((e) => e.event === "agent_message" && e.kind === "request");

  // While demo's Turn 1 is still held:
  // 1) beta replies to outReqAnswered (a held reply that MUST deliver later).
  const replyRes = await beta.request("agent_reply", {
    request_id: outReqAnswered.request_id,
    text: "Reply held until turn ends",
    idempotency_key: "held-reply-1",
  });
  assert.equal(replyRes.ok, true, JSON.stringify(replyRes));

  // 2) beta sends demo an incoming request with timeout_minutes=1 that will EXPIRE while held.
  const expiringIncoming = await beta.request("agent_request", {
    target: "demo",
    text: "Should expire while held and never notify",
    timeout_minutes: 1,
    idempotency_key: "expiring-incoming-1",
  });
  assert.equal(expiringIncoming.ok, true, JSON.stringify(expiringIncoming));
  await waitForReceiverPost(workspace, "demo-channel", expiringIncoming.result.request_id);

  // Wait until BOTH expiring requests have actually expired (beta gets its expired
  // notice for expiringIncoming, and demo-channel's post for outReqExpiring gets ⚠️).
  await waitFor(
    () => beta.events.some((e) => e.event === "agent_message" && e.kind === "notice" && e.outcome === "expired" && e.request_id === expiringIncoming.result.request_id),
    () => `beta expired notice for incoming: ${JSON.stringify(beta.events)}`,
    15000,
  );
  const outExpiringPost = await waitFor(
    () => (readState(workspace.stateDir).fixtures.discord.messages ?? [])
      .find((m) => m.channelId === "demo-channel" && m.content.includes(outReqExpiring.request_id)),
    () => "sender post for outReqExpiring",
    10000,
  );
  await waitForReaction(workspace, "demo-channel", "⚠️", (r) => r.messageId === outExpiringPost.id);

  // Send a fresh non-expiring incoming request after the expiry as our final observable notification.
  const liveIncoming = await beta.request("agent_request", {
    target: "demo",
    text: "Fresh request after expired one",
    timeout_minutes: 30,
    idempotency_key: "live-incoming-after-expiry",
  });
  assert.equal(liveIncoming.ok, true, JSON.stringify(liveIncoming));
  await waitForReceiverPost(workspace, "demo-channel", liveIncoming.result.request_id);

  // Mid-turn owner fence proves NONE of the reply, expiry notice, or incoming
  // requests steered the still-running Turn 1!
  injectDiscordMessage(workspace, {
    id: "owner-expiry-fence",
    channelId: "demo-channel",
    content: "still in turn 1",
    author: { id: OWNER_ID, username: "Owner" },
  });
  await waitFor(
    () => claudeNotifications(workspace, "demo-channel").some((n) => n.meta.message_id === "owner-expiry-fence"),
    () => `owner expiry fence: ${JSON.stringify(claudeNotifications(workspace, "demo-channel"))}`,
    15000,
  );
  assert.deepEqual(
    claudeNotifications(workspace, "demo-channel").filter((n) => n.meta.sender === "agent"),
    [],
  );

  // Unhold turns: the held reply, the sender's expiry notice, and the fresh live
  // incoming request all arrive (each as its own turn), while expiringIncoming is NEVER notified!
  updateState(workspace.stateDir, (state) => {
    state.fixtures.claude.holdTurnsIn = [];
  });
  await waitFor(
    () => claudeNotifications(workspace, "demo-channel").some((n) => n.meta.request_id === liveIncoming.result.request_id),
    () => `live incoming after expiry: ${JSON.stringify(claudeNotifications(workspace, "demo-channel"))}`,
    15000,
  );

  const agentNotifs = claudeNotifications(workspace, "demo-channel").filter((n) => n.meta.sender === "agent");
  assert.equal(
    agentNotifs.some((n) => n.meta.request_id === expiringIncoming.result.request_id),
    false,
    `expired request must never be notified: ${JSON.stringify(agentNotifs)}`,
  );
  assert.ok(
    agentNotifs.some((n) => n.meta.agent_message === "reply" && n.meta.request_id === outReqAnswered.request_id && n.content === "Reply held until turn ends"),
    `held reply must be delivered: ${JSON.stringify(agentNotifs)}`,
  );
  assert.ok(
    agentNotifs.some((n) => n.meta.agent_message === "notice" && n.meta.request_id === outReqExpiring.request_id && /expired/i.test(n.content)),
    `held expiry notice must be delivered: ${JSON.stringify(agentNotifs)}`,
  );
  assert.ok(
    agentNotifs.some((n) => n.meta.agent_message === "request" && n.meta.request_id === liveIncoming.result.request_id),
    `fresh incoming request must be delivered: ${JSON.stringify(agentNotifs)}`,
  );
});

test("agent_message_ack is sent immediately on receipt while held by a running turn or /pause", async () => {
  const workspace = claudeGateWorkspace();
  let secret = null;
  let activeSocket = null;
  const ackedIds = [];

  const server = net.createServer((socket) => {
    activeSocket = socket;
    let buffer = "";
    socket.setEncoding("utf8");
    const send = (frame) => socket.write(`${JSON.stringify(frame)}\n`);
    socket.on("data", (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        const frame = JSON.parse(line);
        if (frame.type === "server_proof" && secret) {
          send(proofReply(frame, secret));
        } else if (frame.type === "hello") {
          send({ type: "hello_ok", scope: { project: "demo", channel_id: "demo-channel", type: "claude" } });
        } else if (frame.type === "request" && frame.op === "agent_message_ack") {
          ackedIds.push(frame.args.delivery_id);
          send({ type: "response", id: frame.id, ok: true, result: {} });
        } else if (frame.type === "request") {
          send({ type: "response", id: frame.id, ok: true, result: { message_id: "ack-msg", message_ids: ["ack-msg"] } });
        }
      }
    });
  });
  secret = await listenAsRouter(workspace, server);
  registerTeardownCallback(() => new Promise((resolve) => server.close(resolve)));

  const activityFile = path.join(workspace.tmpDir, "ack-activity.json");
  const channel = await spawnChannelServer(workspace, {
    extraEnv: { CCDM_ACTIVITY_FILE: activityFile },
  });
  const push = (frame) => activeSocket.write(`${JSON.stringify(frame)}\n`);

  // Start a turn via an owner message, then send an Agent Request while busy.
  push({
    type: "event",
    event: "message",
    channel_id: "demo-channel",
    message_id: "busy-owner-1",
    content: "start turn",
    ts: "2026-11-25T00:00:00.000Z",
    author: { id: OWNER_ID, name: "Owner", is_owner: true },
  });
  await waitFor(() => channel.notifications.length === 1, () => "owner notification");

  push({
    type: "event",
    event: "agent_message",
    delivery_id: "del-while-busy",
    kind: "request",
    request_id: "req-111111111111",
    text: "Held while busy",
    ts: "2026-11-25T00:00:01.000Z",
    expires_at: "2099-01-01T00:00:00.000Z",
    from: { project: "beta", provider: "codex", conversation_id: "beta-channel" },
    post: { channel_id: "demo-channel", message_id: "post-1" },
  });
  await waitFor(() => ackedIds.includes("del-while-busy"), () => `acks while busy: ${JSON.stringify(ackedIds)}`);
  await channel.call("ping", {});
  assert.equal(channel.notifications.length, 1, "busy Agent Request must be acked immediately yet held");

  // Also pause, then push another Agent Request: still acked immediately while held.
  push({
    type: "event",
    event: "command",
    command: "pause",
    channel_id: "demo-channel",
    message_id: "cmd-pause-1",
  });
  await waitFor(() => JSON.parse(fs.readFileSync(activityFile, "utf8")).paused === true, () => "paused activity");
  push({
    type: "event",
    event: "agent_message",
    delivery_id: "del-while-paused",
    kind: "request",
    request_id: "req-222222222222",
    text: "Held while paused",
    ts: "2026-11-25T00:00:02.000Z",
    expires_at: "2099-01-01T00:00:00.000Z",
    from: { project: "beta", provider: "codex", conversation_id: "beta-channel" },
    post: { channel_id: "demo-channel", message_id: "post-2" },
  });
  await waitFor(() => ackedIds.includes("del-while-paused"), () => `acks while paused: ${JSON.stringify(ackedIds)}`);
  await channel.call("ping", {});
  assert.equal(channel.notifications.length, 1, "paused Agent Request must be acked immediately yet held");
});

test("a Claude thread session delivers no Agent Message before its bootstrap notification and waits for the bootstrap turn to end", async () => {
  const workspace = claudeGateWorkspace();
  seedThreads(workspace, {
    [THREAD_ID]: { type: 11, parentId: "demo-channel", name: "Bootstrap gate", archived: false },
  });
  await routerWithWebhooks(workspace, ["demo", "beta"]);
  const beta = await connectAgentProject(workspace, "beta", "beta-key");

  const launchDir = path.join(workspace.routerStateDir, "launches", "demo", "threads", THREAD_ID);
  fs.mkdirSync(launchDir, { recursive: true, mode: 0o700 });
  const bootstrapFile = path.join(launchDir, "bootstrap.json");
  const activityFile = path.join(launchDir, "activity.json");

  const channel = await spawnChannelServer(workspace, {
    project: "demo",
    key: "thread-bootstrap-key",
    threadId: THREAD_ID,
    extraEnv: {
      CCDM_THREAD_BOOTSTRAP_FILE: bootstrapFile,
      CCDM_THREAD_ACTIVITY_FILE: activityFile,
    },
  });

  // Thread listener is live on the Router, but bootstrap.json does not exist yet.
  const preBootReq = await beta.request("agent_request", {
    target: `demo/${THREAD_ID}`,
    text: "Arrived before thread bootstrap",
    idempotency_key: "pre-bootstrap-req-1",
  });
  assert.equal(preBootReq.ok, true, JSON.stringify(preBootReq));
  await waitForReceiverPost(workspace, THREAD_ID, preBootReq.result.request_id);
  await channel.call("ping", {});
  assert.deepEqual(channel.notifications, [], "no Agent Message may be delivered before bootstrap");

  // Write bootstrap.json (as Thread Supervisor does): bootstrap MUST arrive first,
  // and because bootstrap starts a turn, the Agent Request still waits!
  fs.writeFileSync(bootstrapFile, `${JSON.stringify({
    preamble: "You are in thread Bootstrap gate.",
    starter: "",
    messages: [{
      message_id: "boot-msg-1",
      ts: "2026-11-25T00:00:00.000Z",
      author: { id: OWNER_ID, name: "Owner", is_owner: true },
      content: "start working on thread",
    }],
    included_message_ids: ["boot-msg-1"],
  })}\n`, { mode: 0o600 });

  await waitFor(
    () => channel.notifications.length >= 1,
    () => `bootstrap notification: ${JSON.stringify(channel.notifications)}`,
    10000,
  );
  assert.match(channel.notifications[0].content, /start working on thread/);
  assert.equal(channel.notifications[0].meta.sender, undefined);

  // Inject an owner message during the bootstrap turn: it arrives mid-turn while
  // the pre-bootstrap Agent Request still waits for the bootstrap turn to end!
  injectDiscordMessage(workspace, {
    id: "thread-mid-boot-owner",
    channelId: THREAD_ID,
    content: "owner note during bootstrap turn",
    author: { id: OWNER_ID, username: "Owner" },
  });
  await waitFor(
    () => channel.notifications.some((n) => n.meta.message_id === "thread-mid-boot-owner"),
    () => `mid-bootstrap owner message: ${JSON.stringify(channel.notifications)}`,
    10000,
  );
  assert.equal(
    channel.notifications.some((n) => n.meta.request_id === preBootReq.result.request_id),
    false,
    `Agent Request must wait for bootstrap turn end: ${JSON.stringify(channel.notifications)}`,
  );

  // Run the real Stop hook (thread-activity.js) to end the bootstrap turn: now
  // the held pre-bootstrap Agent Request arrives as its own notification!
  execFileSync(process.execPath, [path.join(workspace.repoDir, "scripts", "thread-activity.js"), activityFile], {
    input: JSON.stringify({ hook_event_name: "Stop" }),
  });
  await waitFor(
    () => channel.notifications.some((n) => n.meta.request_id === preBootReq.result.request_id),
    () => `pre-bootstrap agent request after Stop: ${JSON.stringify(channel.notifications)}`,
    10000,
  );
  assert.deepEqual(
    channel.notifications.map((n) => n.meta.request_id ?? n.meta.message_id),
    ["boot-msg-1", "thread-mid-boot-owner", preBootReq.result.request_id],
  );
});

test("in a Claude thread session, Agent Messages wait for running turns, deliver one per turn end oldest first, respect /pause and /unpause, and preserve mid-turn owner delivery", async () => {
  const workspace = claudeGateWorkspace();
  await routerWithWebhooks(workspace, ["demo", "beta"]);
  await startThreadSupervisor(workspace);
  const beta = await connectAgentProject(workspace, "beta", "beta-key");

  // Boot the thread and let its bootstrap turn complete cleanly.
  createThread(workspace);
  await waitForThreadState(workspace, "demo", THREAD_ID, () => true);
  injectDiscordMessage(workspace, {
    id: "thread-boot-1",
    channelId: THREAD_ID,
    content: "boot gate thread",
    author: { id: OWNER_ID, username: "Owner" },
  });
  await waitForThreadState(workspace, "demo", THREAD_ID, (row) => row.state === "live");
  await waitFor(
    () => claudeNotifications(workspace, THREAD_ID).length >= 1
      && (readState(workspace.stateDir).fixtures.claude.hookRuns ?? []).some((h) => h.event === "Stop"),
    () => `thread bootstrap complete: ${JSON.stringify(readState(workspace.stateDir).fixtures.claude)}`,
    15000,
  );

  // Hold subsequent turns in this thread.
  updateState(workspace.stateDir, (state) => {
    state.fixtures.claude.holdTurnsIn = [THREAD_ID];
  });
  injectDiscordMessage(workspace, {
    id: "thread-turn-1",
    channelId: THREAD_ID,
    content: "thread busy turn",
    author: { id: OWNER_ID, username: "Owner" },
  });
  await waitFor(
    () => claudeNotifications(workspace, THREAD_ID).some((n) => n.meta.message_id === "thread-turn-1"),
    () => `thread turn 1: ${JSON.stringify(claudeNotifications(workspace, THREAD_ID))}`,
    15000,
  );

  // Two Agent Requests arrive during the held thread turn, plus a /pause + owner + /unpause.
  const req1 = await beta.request("agent_request", {
    target: `demo/${THREAD_ID}`,
    text: "Thread agent req 1",
    idempotency_key: "thread-gate-req-1",
  });
  assert.equal(req1.ok, true, JSON.stringify(req1));
  await waitForReceiverPost(workspace, THREAD_ID, req1.result.request_id);

  injectDiscordMessage(workspace, {
    id: "thread-cmd-pause",
    channelId: THREAD_ID,
    content: "/pause",
    author: { id: OWNER_ID, username: "Owner" },
  });
  await waitForChannelPost(workspace, THREAD_ID, (m) => /Session paused/i.test(m.content), "thread pause ack");

  const req2 = await beta.request("agent_request", {
    target: `demo/${THREAD_ID}`,
    text: "Thread agent req 2 while paused",
    idempotency_key: "thread-gate-req-2",
  });
  assert.equal(req2.ok, true, JSON.stringify(req2));
  await waitForReceiverPost(workspace, THREAD_ID, req2.result.request_id);

  injectDiscordMessage(workspace, {
    id: "thread-owner-paused",
    channelId: THREAD_ID,
    content: "queued thread owner message",
    author: { id: OWNER_ID, username: "Owner" },
  });
  injectDiscordMessage(workspace, {
    id: "thread-cmd-unpause",
    channelId: THREAD_ID,
    content: "/unpause",
    author: { id: OWNER_ID, username: "Owner" },
  });
  await waitFor(
    () => claudeNotifications(workspace, THREAD_ID).some((n) => n.meta.message_id === "thread-owner-paused"),
    () => `flushed thread owner after /unpause: ${JSON.stringify(claudeNotifications(workspace, THREAD_ID))}`,
    15000,
  );

  // Mid-turn owner message also arrives immediately; neither Agent Request has arrived yet.
  injectDiscordMessage(workspace, {
    id: "thread-owner-mid",
    channelId: THREAD_ID,
    content: "mid-turn thread owner",
    author: { id: OWNER_ID, username: "Owner" },
  });
  await waitFor(
    () => claudeNotifications(workspace, THREAD_ID).some((n) => n.meta.message_id === "thread-owner-mid"),
    () => `mid-turn thread owner: ${JSON.stringify(claudeNotifications(workspace, THREAD_ID))}`,
    15000,
  );
  assert.deepEqual(
    claudeNotifications(workspace, THREAD_ID).filter((n) => n.meta.sender === "agent"),
    [],
  );

  // Release Turn 1 -> ONLY req1 arrives!
  releaseOneTurn(workspace, THREAD_ID);
  await waitFor(
    () => claudeNotifications(workspace, THREAD_ID).some((n) => n.meta.request_id === req1.result.request_id),
    () => `thread req1 after turn 1: ${JSON.stringify(claudeNotifications(workspace, THREAD_ID))}`,
    15000,
  );

  // Owner fence during req1's held turn proves req2 is still waiting.
  injectDiscordMessage(workspace, {
    id: "thread-owner-fence-2",
    channelId: THREAD_ID,
    content: "fence during thread req1",
    author: { id: OWNER_ID, username: "Owner" },
  });
  await waitFor(
    () => claudeNotifications(workspace, THREAD_ID).some((n) => n.meta.message_id === "thread-owner-fence-2"),
    () => `thread fence 2: ${JSON.stringify(claudeNotifications(workspace, THREAD_ID))}`,
    15000,
  );
  assert.deepEqual(
    claudeNotifications(workspace, THREAD_ID).filter((n) => n.meta.sender === "agent").map((n) => n.meta.request_id),
    [req1.result.request_id],
  );

  // Release req1's turn -> now req2 arrives.
  releaseOneTurn(workspace, THREAD_ID);
  await waitFor(
    () => claudeNotifications(workspace, THREAD_ID).some((n) => n.meta.request_id === req2.result.request_id),
    () => `thread req2 after req1 turn: ${JSON.stringify(claudeNotifications(workspace, THREAD_ID))}`,
    15000,
  );
  assert.deepEqual(
    claudeNotifications(workspace, THREAD_ID).filter((n) => n.meta.sender === "agent").map((n) => n.meta.request_id),
    [req1.result.request_id, req2.result.request_id],
  );

  updateState(workspace.stateDir, (state) => {
    state.fixtures.claude.holdTurnsIn = [];
  });
});

test("in a Claude thread session, a request expiring while held is dropped and the thread's own expiry notice waits for the running turn to end", async () => {
  const workspace = claudeGateWorkspace();
  await routerWithWebhooks(workspace, ["demo", "beta"], {
    env: { CCDM_ROUTER_AGENT_MESSAGE_MINUTE_MS: "250" },
  });
  await startThreadSupervisor(workspace);
  const beta = await connectAgentProject(workspace, "beta", "beta-key");

  // Boot the thread cleanly first.
  createThread(workspace);
  await waitForThreadState(workspace, "demo", THREAD_ID, () => true);
  injectDiscordMessage(workspace, {
    id: "thread-exp-boot",
    channelId: THREAD_ID,
    content: "boot expiry thread",
    author: { id: OWNER_ID, username: "Owner" },
  });
  await waitForThreadState(workspace, "demo", THREAD_ID, (row) => row.state === "live");
  await waitFor(
    () => (readState(workspace.stateDir).fixtures.claude.hookRuns ?? []).some((h) => h.event === "Stop"),
    () => "thread boot Stop",
    15000,
  );

  // Hold the next turn in the thread; during that held turn, the thread sends an
  // expiring request to beta.
  updateState(workspace.stateDir, (state) => {
    state.fixtures.claude.holdTurnsIn = [THREAD_ID];
    state.fixtures.claude.toolScript = [
      { name: "send_agent_request", arguments: { target: "beta", text: "Thread outgoing expires", timeout_minutes: 1 } },
    ];
  });
  injectDiscordMessage(workspace, {
    id: "thread-exp-turn",
    channelId: THREAD_ID,
    content: "send expiring request from thread",
    author: { id: OWNER_ID, username: "Owner" },
  });
  await waitFor(
    () => beta.events.some((e) => e.event === "agent_message" && e.kind === "request"),
    () => `beta outgoing thread req: ${JSON.stringify(beta.events)}`,
    15000,
  );
  updateState(workspace.stateDir, (state) => {
    delete state.fixtures.claude.toolScript;
  });
  const outThreadReq = beta.events.find((e) => e.event === "agent_message" && e.kind === "request");

  // Beta sends an incoming request to the thread that expires while the thread's turn is held.
  const inThreadExpiring = await beta.request("agent_request", {
    target: `demo/${THREAD_ID}`,
    text: "Incoming thread request expires while held",
    timeout_minutes: 1,
    idempotency_key: "thread-in-expiring-1",
  });
  assert.equal(inThreadExpiring.ok, true, JSON.stringify(inThreadExpiring));
  await waitForReceiverPost(workspace, THREAD_ID, inThreadExpiring.result.request_id);

  // Wait for both expirations to complete in the Router.
  await waitFor(
    () => beta.events.some((e) => e.event === "agent_message" && e.kind === "notice" && e.outcome === "expired" && e.request_id === inThreadExpiring.result.request_id),
    () => `beta expired notice for thread req: ${JSON.stringify(beta.events)}`,
    15000,
  );
  const outPost = await waitFor(
    () => (readState(workspace.stateDir).fixtures.discord.messages ?? [])
      .find((m) => m.channelId === THREAD_ID && m.content.includes(outThreadReq.request_id)),
    () => "thread outgoing sender post",
    10000,
  );
  await waitForReaction(workspace, THREAD_ID, "⚠️", (r) => r.messageId === outPost.id);

  // Send a fresh live request into the thread as our post-expiry observable event.
  const inThreadLive = await beta.request("agent_request", {
    target: `demo/${THREAD_ID}`,
    text: "Fresh thread request after expiry",
    timeout_minutes: 30,
    idempotency_key: "thread-in-live-1",
  });
  assert.equal(inThreadLive.ok, true, JSON.stringify(inThreadLive));
  await waitForReceiverPost(workspace, THREAD_ID, inThreadLive.result.request_id);

  // Mid-turn owner fence proves neither the expiry notice nor any incoming request steered the turn.
  injectDiscordMessage(workspace, {
    id: "thread-exp-fence",
    channelId: THREAD_ID,
    content: "still holding thread turn",
    author: { id: OWNER_ID, username: "Owner" },
  });
  await waitFor(
    () => claudeNotifications(workspace, THREAD_ID).some((n) => n.meta.message_id === "thread-exp-fence"),
    () => `thread expiry fence: ${JSON.stringify(claudeNotifications(workspace, THREAD_ID))}`,
    15000,
  );
  assert.deepEqual(
    claudeNotifications(workspace, THREAD_ID).filter((n) => n.meta.sender === "agent"),
    [],
  );

  // Unhold turns: the thread's own expiry notice and the fresh live request arrive;
  // the expired incoming request is never notified.
  updateState(workspace.stateDir, (state) => {
    state.fixtures.claude.holdTurnsIn = [];
  });
  await waitFor(
    () => claudeNotifications(workspace, THREAD_ID).some((n) => n.meta.request_id === inThreadLive.result.request_id),
    () => `live thread request after expiry: ${JSON.stringify(claudeNotifications(workspace, THREAD_ID))}`,
    15000,
  );

  const threadAgentNotifs = claudeNotifications(workspace, THREAD_ID).filter((n) => n.meta.sender === "agent");
  assert.equal(
    threadAgentNotifs.some((n) => n.meta.request_id === inThreadExpiring.result.request_id),
    false,
    `expired thread request must never be notified: ${JSON.stringify(threadAgentNotifs)}`,
  );
  assert.ok(
    threadAgentNotifs.some((n) => n.meta.agent_message === "notice" && n.meta.request_id === outThreadReq.request_id && /expired/i.test(n.content)),
    `thread expiry notice must arrive after turn end: ${JSON.stringify(threadAgentNotifs)}`,
  );
  assert.ok(
    threadAgentNotifs.some((n) => n.meta.agent_message === "request" && n.meta.request_id === inThreadLive.result.request_id),
    `fresh thread request must arrive: ${JSON.stringify(threadAgentNotifs)}`,
  );
});
