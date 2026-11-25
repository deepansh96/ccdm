import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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
  runRouterCli,
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

const AGENT_TOOLS = ["send_agent_request", "send_agent_reply", "list_agent_targets"];
const THREAD_ID = "1700000000000400001";

const fakeHosts = new WeakMap();
async function launcherEnv(workspace, extraEnv = {}) {
  if (process.platform !== "win32") return routerEnv(workspace, extraEnv);
  if (!fakeHosts.has(workspace)) {
    fakeHosts.set(workspace, await startFakeHost(workspace, { env: routerEnv(workspace) }));
  }
  return routerEnv(workspace, { ...fakeHosts.get(workspace).env, ...extraEnv });
}

function claudeAgentWorkspace(extra = {}) {
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

async function startRootClaude(workspace, extraEnv = {}) {
  const restarted = await runScript(workspace, "restart-root-agent.sh", {
    env: await launcherEnv(workspace, extraEnv),
    timeoutMs: 20000,
  });
  assert.equal(restarted.exitCode, 0, restarted.stderr || restarted.stdout);
  return restarted;
}

function createThread(workspace, thread = {}) {
  updateState(workspace.stateDir, (state) => {
    (state.fixtures.discord.injectedThreads ||= []).push({
      id: THREAD_ID,
      type: 11,
      parentId: "demo-channel",
      name: "Agent thread",
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

test("Claude channel and thread sessions list the three Agent Message tools and carry the trust note; root does not", async () => {
  const workspace = claudeAgentWorkspace();
  await routerWithWebhooks(workspace, ["demo", "beta"]);
  await startThreadSupervisor(workspace);

  await startClaudeChannel(workspace, "demo");
  await startRootClaude(workspace);

  createThread(workspace);
  await waitForThreadState(workspace, "demo", THREAD_ID, () => true);
  injectDiscordMessage(workspace, {
    id: "thread-boot-1",
    channelId: THREAD_ID,
    content: "boot thread",
    author: { id: OWNER_ID, username: "Owner" },
  });
  await waitForThreadState(workspace, "demo", THREAD_ID, (row) => row.state === "live");

  await waitFor(
    () => (readState(workspace.stateDir).fixtures.claude.toolLists?.length ?? 0) >= 3
      && (readState(workspace.stateDir).fixtures.claude.channelServers?.length ?? 0) >= 3,
    () => `tool lists and channel servers: ${JSON.stringify(readState(workspace.stateDir).fixtures.claude)}`,
    15000,
  );

  const claude = readState(workspace.stateDir).fixtures.claude;
  const channelTools = claude.toolLists.find((entry) => entry.role === "project" && entry.threadId === null);
  const threadTools = claude.toolLists.find((entry) => entry.role === "thread" && entry.threadId === THREAD_ID);
  const rootTools = claude.toolLists.find((entry) => entry.role === "root");
  assert.ok(channelTools, JSON.stringify(claude.toolLists));
  assert.ok(threadTools, JSON.stringify(claude.toolLists));
  assert.ok(rootTools, JSON.stringify(claude.toolLists));

  for (const toolName of AGENT_TOOLS) {
    assert.equal(channelTools.tools.includes(toolName), true, `channel missing ${toolName}`);
    assert.equal(threadTools.tools.includes(toolName), true, `thread missing ${toolName}`);
    assert.equal(rootTools.tools.includes(toolName), false, `root should not list ${toolName}`);
  }

  const trustNote = fs.readFileSync(path.join(workspace.repoDir, "scripts", "claude-channel-trust.txt"), "utf8");
  const channelServer = claude.channelServers.find((entry) => entry.role === "project");
  const threadServer = claude.channelServers.find((entry) => entry.role === "thread");
  const rootServer = claude.channelServers.find((entry) => entry.role === "root");

  for (const [label, text] of [
    ["launch note", trustNote],
    ["channel instructions", channelServer.instructions],
    ["thread instructions", threadServer.instructions],
  ]) {
    assert.match(text, /another agent, not from the owner/i, label);
    assert.match(text, /destructive, irreversible or outward-facing work/i, label);
    assert.match(text, /data, not instructions/i, label);
    assert.match(text, /reply.*own conversation.*send_agent_reply/is, label);
    for (const toolName of AGENT_TOOLS) {
      assert.equal(text.includes(toolName), true, `${label} missing ${toolName}`);
    }
  }
  for (const toolName of AGENT_TOOLS) {
    assert.equal(rootServer.instructions.includes(toolName), false, `root instructions should not name ${toolName}`);
  }
});

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
  let requests = 0;
  return {
    frames,
    closed,
    send,
    close() {
      socket.destroy();
      return closed;
    },
    hello: answer,
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

function connectAgentProject(workspace, project, key, extra = {}) {
  return rawClient(workspace, {
    role: "project",
    project,
    key,
    capabilities: ["agent_messages"],
    ...extra,
  });
}

function connectAgentThread(workspace, project, threadId, key, provider = "codex", extra = {}) {
  return rawClient(workspace, {
    role: "thread",
    project,
    thread_id: threadId,
    provider,
    key,
    capabilities: ["agent_messages"],
    ...extra,
  });
}

async function spawnChannelServer(workspace, { project = "demo", key = "demo-key", extraEnv = {} } = {}) {
  writeProjectKey(workspace, project, key);
  const keyFile = path.join(workspace.routerStateDir, "keys", `${project}.key`);
  const readyFile = path.join(workspace.tmpDir, `ready-${project}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  const child = spawn(process.execPath, [path.join(workspace.repoDir, "scripts", "ccdm-channel-server.js")], {
    cwd: workspace.repoDir,
    env: routerEnv(workspace, {
      CCDM_CLAUDE_PROJECT: project,
      CCDM_ROUTER_KEY_FILE: keyFile,
      CCDM_CHANNEL_READY_FILE: readyFile,
      CCDM_ROUTER_RECONNECT_MIN_MS: "50",
      CCDM_ROUTER_RECONNECT_MAX_MS: "100",
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

test("send_agent_request returns the req- ID, delivers to the target, surfaces refusal codes, and list_agent_targets shows liveness and threads", async () => {
  const workspace = claudeAgentWorkspace({
    demo: { agent_message_targets: ["beta", "gamma"] },
    registry: {
      projects: {
        demo: {
          channel_id: "demo-channel", type: "claude", transport: "router",
          screen_name: "demo_claude", session_id: null, pid: null,
          agent_message_targets: ["beta", "gamma"],
        },
        beta: { channel_id: "beta-channel", type: "codex", transport: "router", agent_message_targets: ["demo"] },
        gamma: { channel_id: "gamma-channel", type: "codex", transport: "router" },
        ungranted: { channel_id: "ungranted-channel", type: "codex", transport: "router" },
      },
    },
  });
  const registryFile = path.join(workspace.repoDir, "registry.json");
  const reg = JSON.parse(fs.readFileSync(registryFile, "utf8"));
  for (const p of Object.values(reg.projects)) p.path = workspace.tmpDir;
  fs.writeFileSync(registryFile, `${JSON.stringify(reg, null, 2)}\n`);

  const betaThreadId = "1700000000000400002";
  seedThreads(workspace, {
    [betaThreadId]: { type: 11, parentId: "beta-channel", name: "Schema check", archived: false },
  });
  await routerWithWebhooks(workspace, ["demo", "beta", "gamma", "ungranted"]);
  const beta = await connectAgentProject(workspace, "beta", "beta-key");
  writeThreadKey(workspace, betaThreadId, "beta-thread-key");
  await connectAgentThread(workspace, "beta", betaThreadId, "beta-thread-key", "codex");

  updateState(workspace.stateDir, (state) => {
    state.fixtures.claude.toolScript = [
      { name: "list_agent_targets", arguments: {} },
      { name: "send_agent_request", arguments: { target: "beta", text: "Check prod schema" } },
      { name: "send_agent_request", arguments: { target: "ungranted", text: "Should be denied" } },
      { name: "send_agent_request", arguments: { target: "gamma", text: "Target offline" } },
    ];
  });
  await startClaudeChannel(workspace, "demo");

  injectDiscordMessage(workspace, {
    id: "owner-trigger-1",
    channelId: "demo-channel",
    content: "please check beta",
    author: { id: OWNER_ID, username: "Owner" },
  });

  await waitFor(
    () => (readState(workspace.stateDir).fixtures.claude.toolResults?.length ?? 0) >= 4,
    () => `tool results: ${JSON.stringify(readState(workspace.stateDir).fixtures.claude.toolResults)}`,
    15000,
  );
  const results = readState(workspace.stateDir).fixtures.claude.toolResults;

  // list_agent_targets shows beta (live + live thread) and gamma (offline), never ungranted.
  assert.equal(results[0].name, "list_agent_targets");
  assert.equal(results[0].result.isError, undefined, JSON.stringify(results[0]));
  const targetList = results[0].result.content[0].text;
  assert.match(targetList, /beta \(channel: live\)/);
  assert.match(targetList, new RegExp(`beta/${betaThreadId} \\(Schema check\\)`));
  assert.match(targetList, /gamma \(channel: offline\)/);
  assert.equal(targetList.includes("ungranted"), false, targetList);

  // send_agent_request to beta succeeds and returns req-... ID.
  assert.equal(results[1].name, "send_agent_request");
  assert.equal(results[1].result.isError, undefined, JSON.stringify(results[1]));
  const sentText = results[1].result.content[0].text;
  const reqMatch = /\b(req-[0-9a-f]{12})\b/.exec(sentText);
  assert.ok(reqMatch, `expected req-... ID in ${sentText}`);
  const reqId = reqMatch[1];

  await waitFor(
    () => beta.events.some((event) => event.event === "agent_message" && event.kind === "request" && event.request_id === reqId),
    () => `beta request event: ${JSON.stringify(beta.events)}`,
  );
  const delivered = beta.events.find((event) => event.event === "agent_message" && event.request_id === reqId);
  assert.equal(delivered.text, "Check prod schema");
  assert.equal(delivered.from.project, "demo");
  assert.equal(delivered.from.provider, "claude");

  // Refusals surface their Router error code and message.
  assert.equal(results[2].result.isError, true);
  assert.match(results[2].result.content[0].text, /^send_agent_request failed: not_granted /);

  assert.equal(results[3].result.isError, true);
  assert.match(results[3].result.content[0].text, /^send_agent_request failed: target_offline /);
});

test("send_agent_request and send_agent_reply retry with the same idempotency_key on router_unavailable", async () => {
  const workspace = claudeAgentWorkspace();
  const seenRequestKeys = [];
  const seenReplyKeys = [];
  let secret = null;
  let requestAttempts = 0;
  let replyAttempts = 0;

  const server = net.createServer((socket) => {
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
        } else if (frame.type === "request" && frame.op === "agent_request") {
          requestAttempts += 1;
          seenRequestKeys.push(frame.args.idempotency_key);
          if (requestAttempts === 1) {
            socket.destroy();
          } else {
            send({
              type: "response",
              id: frame.id,
              ok: true,
              result: { request_id: "req-aabbccddeeff", expires_at: "2026-11-25T00:30:00.000Z", depth: 1 },
            });
          }
        } else if (frame.type === "request" && frame.op === "agent_reply") {
          replyAttempts += 1;
          seenReplyKeys.push(frame.args.idempotency_key);
          if (replyAttempts === 1) {
            socket.destroy();
          } else {
            send({
              type: "response",
              id: frame.id,
              ok: true,
              result: { request_id: "req-aabbccddeeff", delivered_to_live_session: true },
            });
          }
        }
      }
    });
  });
  secret = await listenAsRouter(workspace, server);
  registerTeardownCallback(() => new Promise((resolve) => server.close(resolve)));

  const channel = await spawnChannelServer(workspace);
  const reqRes = await channel.call("tools/call", {
    name: "send_agent_request",
    arguments: { target: "beta", text: "Retry me" },
  });
  assert.equal(reqRes.result.isError, undefined, JSON.stringify(reqRes));
  assert.match(reqRes.result.content[0].text, /req-aabbccddeeff/);
  assert.equal(requestAttempts, 2);
  assert.equal(seenRequestKeys.length, 2);
  assert.equal(seenRequestKeys[1], seenRequestKeys[0]);

  const replyRes = await channel.call("tools/call", {
    name: "send_agent_reply",
    arguments: { request_id: "req-aabbccddeeff", text: "Retry reply" },
  });
  assert.equal(replyRes.result.isError, undefined, JSON.stringify(replyRes));
  assert.match(replyRes.result.content[0].text, /req-aabbccddeeff/);
  assert.equal(replyAttempts, 2);
  assert.equal(seenReplyKeys.length, 2);
  assert.equal(seenReplyKeys[1], seenReplyKeys[0]);
  assert.notEqual(seenReplyKeys[0], seenRequestKeys[0]);
});

test("Claude receives an Agent Request notification, answers with send_agent_reply, reports sender liveness, and rejects a second reply with already_replied", async () => {
  const workspace = claudeAgentWorkspace();
  await routerWithWebhooks(workspace, ["demo", "beta"]);
  const beta = await connectAgentProject(workspace, "beta", "beta-key");

  updateState(workspace.stateDir, (state) => {
    state.fixtures.claude.toolScript = [
      { name: "send_agent_reply", arguments: { request_id: "{{request_id}}", text: "Migration 42 is clean" } },
      { name: "send_agent_reply", arguments: { request_id: "{{request_id}}", text: "Second reply must fail" } },
    ];
  });
  await startClaudeChannel(workspace, "demo");

  const sent = await beta.request("agent_request", {
    target: "demo",
    text: "Please inspect migration 42",
    idempotency_key: "beta-req-1",
  });
  assert.equal(sent.ok, true, JSON.stringify(sent));
  const reqId = sent.result.request_id;

  await waitFor(
    () => (readState(workspace.stateDir).fixtures.claude.toolResults?.length ?? 0) >= 2
      && beta.events.some((event) => event.event === "agent_message" && event.kind === "reply" && event.request_id === reqId),
    () => `claude reply & beta receipt: ${JSON.stringify({
      claude: readState(workspace.stateDir).fixtures.claude,
      betaEvents: beta.events,
    })}`,
    15000,
  );

  const state = readState(workspace.stateDir);
  const receiverPost = state.fixtures.discord.messages.find(
    (msg) => msg.channelId === "demo-channel" && msg.content.startsWith(`-# ⇄ Agent Request from **beta-codex** · ${reqId}`),
  );
  assert.ok(receiverPost, JSON.stringify(state.fixtures.discord.messages));

  const [notif] = state.fixtures.claude.channelNotifications;
  assert.equal(notif.content, "Please inspect migration 42");
  assert.equal(notif.meta.sender, "agent");
  assert.equal(notif.meta.agent_message, "request");
  assert.equal(notif.meta.request_id, reqId);
  assert.equal(notif.meta.from_project, "beta");
  assert.equal(notif.meta.from_conversation, "channel");
  assert.equal(notif.meta.user, "beta-codex");
  assert.equal(notif.meta.message_id, receiverPost.id);
  assert.equal(typeof notif.meta.ts, "string");

  const [firstReply, secondReply] = state.fixtures.claude.toolResults;
  assert.equal(firstReply.result.isError, undefined, JSON.stringify(firstReply));
  assert.match(firstReply.result.content[0].text, new RegExp(reqId));
  assert.match(firstReply.result.content[0].text, /delivered_to_live_session=true/);

  assert.equal(secondReply.result.isError, true);
  assert.match(secondReply.result.content[0].text, /^send_agent_reply failed: already_replied /);

  const betaReply = beta.events.find((event) => event.event === "agent_message" && event.kind === "reply" && event.request_id === reqId);
  assert.equal(betaReply.text, "Migration 42 is clean");

  // When the sender disconnects before Claude replies, send_agent_reply reports offline.
  const beta2 = await connectAgentProject(workspace, "beta", "beta-key");
  const channel = await spawnChannelServer(workspace, { project: "demo", key: "demo-key-direct" });
  const req3 = await beta2.request("agent_request", {
    target: "demo",
    text: "Reply when I am gone",
    idempotency_key: "beta-req-3",
  });
  assert.equal(req3.ok, true, JSON.stringify(req3));
  await waitFor(
    () => channel.notifications.some((n) => n.meta.request_id === req3.result.request_id),
    () => `channel request notification: ${JSON.stringify(channel.notifications)}`,
  );
  await beta2.close();
  await waitFor(async () => {
    const status = JSON.parse((await runRouterCli(workspace, ["status", "--json"])).stdout);
    return !status.sessions.some((s) => s.project === "beta");
  }, () => "beta disconnected in router status");
  const offlineReply = await channel.call("tools/call", {
    name: "send_agent_reply",
    arguments: { request_id: req3.result.request_id, text: "Sender was offline" },
  });
  assert.equal(offlineReply.result.isError, undefined, JSON.stringify(offlineReply));
  assert.match(offlineReply.result.content[0].text, /delivered_to_live_session=false/);
});

test("Claude receives Agent Reply and expiry notice notifications with their kinds, and omits message_id when post is null", async () => {
  const workspace = claudeAgentWorkspace();
  await routerWithWebhooks(workspace, ["demo", "beta"], {
    env: { CCDM_ROUTER_AGENT_MESSAGE_MINUTE_MS: "200" },
  });
  const beta = await connectAgentProject(workspace, "beta", "beta-key");

  updateState(workspace.stateDir, (state) => {
    state.fixtures.claude.toolScript = [
      { name: "send_agent_request", arguments: { target: "beta", text: "Need answer" } },
      { name: "send_agent_request", arguments: { target: "beta", text: "Will expire", timeout_minutes: 1 } },
    ];
  });
  await startClaudeChannel(workspace, "demo");

  injectDiscordMessage(workspace, {
    id: "owner-trigger-2",
    channelId: "demo-channel",
    content: "send two requests",
    author: { id: OWNER_ID, username: "Owner" },
  });

  await waitFor(
    () => beta.events.filter((event) => event.event === "agent_message" && event.kind === "request").length >= 2,
    () => `two beta requests: ${JSON.stringify(beta.events)}`,
    15000,
  );
  // Clear toolScript so incoming reply/notice don't send more requests.
  updateState(workspace.stateDir, (state) => {
    delete state.fixtures.claude.toolScript;
  });

  const [req1Event, req2Event] = beta.events.filter((event) => event.event === "agent_message" && event.kind === "request");
  const replied = await beta.request("agent_reply", {
    request_id: req1Event.request_id,
    text: "Here is beta's answer",
    idempotency_key: "beta-reply-1",
  });
  assert.equal(replied.ok, true, JSON.stringify(replied));

  await waitFor(
    () => {
      const notifs = readState(workspace.stateDir).fixtures.claude.channelNotifications ?? [];
      return notifs.some((n) => n.meta.agent_message === "reply" && n.meta.request_id === req1Event.request_id)
        && notifs.some((n) => n.meta.agent_message === "notice" && n.meta.request_id === req2Event.request_id);
    },
    () => `reply and notice notifications: ${JSON.stringify(readState(workspace.stateDir).fixtures.claude.channelNotifications)}`,
    15000,
  );

  const state = readState(workspace.stateDir);
  const replyNotif = state.fixtures.claude.channelNotifications.find(
    (n) => n.meta.agent_message === "reply" && n.meta.request_id === req1Event.request_id,
  );
  const replyPost = state.fixtures.discord.messages.find(
    (msg) => msg.channelId === "demo-channel" && msg.content.startsWith(`-# ⇄ Agent Reply from **beta-codex** · ${req1Event.request_id}`),
  );
  assert.ok(replyPost, JSON.stringify(state.fixtures.discord.messages));
  assert.equal(replyNotif.content, "Here is beta's answer");
  assert.equal(replyNotif.meta.sender, "agent");
  assert.equal(replyNotif.meta.from_project, "beta");
  assert.equal(replyNotif.meta.from_conversation, "channel");
  assert.equal(replyNotif.meta.user, "beta-codex");
  assert.equal(replyNotif.meta.message_id, replyPost.id);

  const noticeNotif = state.fixtures.claude.channelNotifications.find(
    (n) => n.meta.agent_message === "notice" && n.meta.request_id === req2Event.request_id,
  );
  const senderReq2Post = state.fixtures.discord.messages.find(
    (msg) => msg.channelId === "demo-channel" && msg.content.startsWith(`-# ⇄ Agent Request to **beta-codex** · ${req2Event.request_id}`),
  );
  assert.ok(senderReq2Post, JSON.stringify(state.fixtures.discord.messages));
  assert.match(noticeNotif.content, /expired/i);
  assert.equal(noticeNotif.meta.sender, "agent");
  assert.equal(noticeNotif.meta.agent_message, "notice");
  assert.equal(noticeNotif.meta.request_id, req2Event.request_id);
  assert.equal(noticeNotif.meta.from_project, "beta");
  assert.equal(noticeNotif.meta.from_conversation, "channel");
  assert.equal(noticeNotif.meta.message_id, senderReq2Post.id);

  // When a reply's receiver-side record post fails (post: null), message_id is omitted.
  const req3 = await beta.request("agent_request", {
    target: "demo",
    text: "Prepare null-post test",
    idempotency_key: "beta-req-null-post",
  });
  assert.equal(req3.ok, true);
  // Make the bot post into demo-channel fail once so the next reply has post: null.
  updateState(workspace.stateDir, (next) => {
    next.fixtures.claude.toolScript = [
      { name: "send_agent_request", arguments: { target: "beta", text: "Reply post will fail" } },
    ];
  });
  injectDiscordMessage(workspace, {
    id: "owner-trigger-3",
    channelId: "demo-channel",
    content: "trigger null post",
    author: { id: OWNER_ID, username: "Owner" },
  });
  await waitFor(
    () => beta.events.filter((event) => event.event === "agent_message" && event.kind === "request").length >= 3,
    () => `third beta request: ${JSON.stringify(beta.events)}`,
    15000,
  );
  updateState(workspace.stateDir, (next) => {
    delete next.fixtures.claude.toolScript;
    next.fixtures.discord.restFailures = [{ method: "POST", path: "/api/v10/channels/demo-channel/messages", status: 500 }];
  });
  const req3FromDemo = beta.events.filter((event) => event.event === "agent_message" && event.kind === "request")[2];
  const replied3 = await beta.request("agent_reply", {
    request_id: req3FromDemo.request_id,
    text: "Answer with no Discord post",
    idempotency_key: "beta-reply-3",
  });
  assert.equal(replied3.ok, true, JSON.stringify(replied3));
  await waitFor(
    () => (readState(workspace.stateDir).fixtures.claude.channelNotifications ?? [])
      .some((n) => n.meta.agent_message === "reply" && n.meta.request_id === req3FromDemo.request_id),
    () => `null-post reply notification: ${JSON.stringify(readState(workspace.stateDir).fixtures.claude.channelNotifications)}`,
    15000,
  );
  const nullPostNotif = readState(workspace.stateDir).fixtures.claude.channelNotifications.find(
    (n) => n.meta.agent_message === "reply" && n.meta.request_id === req3FromDemo.request_id,
  );
  assert.equal(nullPostNotif.content, "Answer with no Discord post");
  assert.equal("message_id" in nullPostNotif.meta, false, JSON.stringify(nullPostNotif.meta));
});

test("an Agent Message produces no owner-interaction record and emits no owner_activity", async () => {
  const workspace = claudeAgentWorkspace();
  const reminderStateDir = path.join(workspace.homeDir, ".local", "state", "ccdm", "conversation-reminders");
  const receiptsDir = path.join(reminderStateDir, "claude-receipts");
  await routerWithWebhooks(workspace, ["demo", "beta"]);
  const beta = await connectAgentProject(workspace, "beta", "beta-key");

  // Even if Claude calls reply passing the Agent Message's message_id as
  // conversation_interaction_id, it must not match any owner interaction.
  updateState(workspace.stateDir, (state) => {
    state.fixtures.claude.toolScript = [
      {
        name: "reply",
        arguments: {
          chat_id: "{{chat_id}}",
          text: "Note to own channel",
          conversation_interaction_id: "{{message_id}}",
          conversation_disposition: "progress",
        },
      },
    ];
  });
  await startClaudeChannel(workspace, "demo", {
    CCDM_REMINDER_STATE_DIR: reminderStateDir,
    CCDM_REMINDER_RECEIPTS_DIR: receiptsDir,
  });

  const sent = await beta.request("agent_request", {
    target: "demo",
    text: "Status check",
    idempotency_key: "beta-reminder-iso-1",
  });
  assert.equal(sent.ok, true, JSON.stringify(sent));

  await waitFor(
    () => (readState(workspace.stateDir).fixtures.claude.toolResults?.length ?? 0) >= 1,
    () => `reply tool result: ${JSON.stringify(readState(workspace.stateDir).fixtures.claude.toolResults)}`,
    15000,
  );

  // Ordinary reply still posted in demo-channel only.
  const ownReply = readState(workspace.stateDir).fixtures.discord.messages.find(
    (msg) => msg.channelId === "demo-channel" && msg.content === "Note to own channel",
  );
  assert.ok(ownReply, JSON.stringify(readState(workspace.stateDir).fixtures.discord.messages));

  // No owner_activity event in outbox or store, and no reminder receipt recorded.
  const outboxDir = path.join(reminderStateDir, "outbox");
  assert.deepEqual(fs.existsSync(outboxDir) ? fs.readdirSync(outboxDir) : [], []);
  assert.deepEqual(fs.existsSync(receiptsDir) ? fs.readdirSync(receiptsDir) : [], []);

  const reminderStatus = await runScript(workspace, "scripts/conversation-reminder-service.py", {
    args: ["status", "--project-root", workspace.repoDir, "--state-dir", reminderStateDir],
    env: routerEnv(workspace),
  });
  assert.equal(reminderStatus.exitCode, 0, reminderStatus.stderr || reminderStatus.stdout);
  const parsedStatus = JSON.parse(reminderStatus.stdout);
  assert.equal(parsedStatus.conversations?.demo?.last_owner_activity_at ?? null, null);
  assert.equal(parsedStatus.conversations?.demo?.response_message_id ?? null, null);
});

test("duplicate delivery_id produces one notification and agent_message_ack completes before notification delivery", async () => {
  const workspace = claudeAgentWorkspace();
  let secret = null;
  let activeSocket = null;
  const pendingAcks = [];
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
          pendingAcks.push(() => send({ type: "response", id: frame.id, ok: true, result: {} }));
        }
      }
    });
  });
  secret = await listenAsRouter(workspace, server);
  registerTeardownCallback(() => new Promise((resolve) => server.close(resolve)));

  const channel = await spawnChannelServer(workspace);
  const push = (event) => activeSocket.write(`${JSON.stringify({ type: "event", event: "agent_message", ...event })}\n`);

  const baseEvent = {
    delivery_id: "del-dup-1",
    kind: "request",
    request_id: "req-111111111111",
    text: "Deliver once",
    ts: "2026-11-25T00:00:00.000Z",
    from: { project: "beta", provider: "codex", conversation_id: "beta-channel" },
    post: { channel_id: "demo-channel", message_id: "msg-101" },
  };
  push(baseEvent);

  // Wait until the channel server has sent agent_message_ack, BEFORE the Router replies to it.
  await waitFor(() => pendingAcks.length === 1, () => `first ack: ${JSON.stringify(ackedIds)}`);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(channel.notifications.length, 0, "notification must wait until agent_message_ack completes");

  // Complete the first ack: now the notification arrives.
  pendingAcks.shift()();
  await waitFor(() => channel.notifications.length === 1, () => `first notification: ${JSON.stringify(channel.notifications)}`);

  // Push the same delivery_id a second time, followed by a distinct delivery_id as a fence.
  push(baseEvent);
  push({
    ...baseEvent,
    delivery_id: "del-dup-2",
    request_id: "req-222222222222",
    text: "Fence message",
    post: { channel_id: "demo-channel", message_id: "msg-102" },
  });

  await waitFor(() => pendingAcks.length >= 2, () => `duplicate + fence acks: ${JSON.stringify(ackedIds)}`);
  while (pendingAcks.length > 0) pendingAcks.shift()();

  await waitFor(
    () => channel.notifications.some((n) => n.meta.request_id === "req-222222222222"),
    () => `fence notification: ${JSON.stringify(channel.notifications)}`,
  );

  assert.deepEqual(
    channel.notifications.map((n) => [n.meta.request_id, n.content]),
    [
      ["req-111111111111", "Deliver once"],
      ["req-222222222222", "Fence message"],
    ],
  );
  assert.deepEqual(ackedIds, ["del-dup-1", "del-dup-1", "del-dup-2"]);
});

test("after a disconnect and reconnect of the same launch, an unacknowledged delivery arrives once and is not re-sent again", async () => {
  const workspace = claudeAgentWorkspace();
  await routerWithWebhooks(workspace, ["demo", "beta"]);
  const beta = await connectAgentProject(workspace, "beta", "beta-key");
  const launchKey = "demo-same-launch-key";

  const channel1 = await spawnChannelServer(workspace, { key: launchKey });
  const sent = await channel1.call("tools/call", {
    name: "send_agent_request",
    arguments: { target: "beta", text: "Answer while I disconnect" },
  });
  assert.equal(sent.result.isError, undefined, JSON.stringify(sent));
  const reqId = /\b(req-[0-9a-f]{12})\b/.exec(sent.result.content[0].text)[1];

  await waitFor(
    () => beta.events.some((event) => event.event === "agent_message" && event.request_id === reqId),
    () => `beta request: ${JSON.stringify(beta.events)}`,
  );
  const reqDelivery = beta.events.find((event) => event.event === "agent_message" && event.request_id === reqId);
  await beta.request("agent_message_ack", { delivery_id: reqDelivery.delivery_id });

  // Disconnect demo cleanly before beta replies.
  const exited1 = new Promise((resolve) => channel1.child.once("exit", resolve));
  channel1.child.stdin.end();
  await exited1;
  await waitFor(async () => {
    const status = JSON.parse((await runRouterCli(workspace, ["status", "--json"])).stdout);
    return !status.sessions.some((s) => s.project === "demo");
  }, () => "demo disconnected in router status");

  // Beta replies while demo is disconnected.
  const replied = await beta.request("agent_reply", {
    request_id: reqId,
    text: "Delivered on reconnect",
    idempotency_key: "beta-reconnect-reply-1",
  });
  assert.equal(replied.ok, true, JSON.stringify(replied));
  assert.equal(replied.result.delivered_to_live_session, false);

  // Reconnect the same launch (same key fingerprint): receives the pending reply once and acks it.
  const channel2 = await spawnChannelServer(workspace, { key: launchKey });
  await waitFor(
    () => channel2.notifications.some((n) => n.meta.agent_message === "reply" && n.meta.request_id === reqId),
    () => `reconnected reply: ${JSON.stringify(channel2.notifications)} stderr=${channel2.stderr}`,
    10000,
  );
  assert.equal(
    channel2.notifications.filter((n) => n.meta.request_id === reqId).length,
    1,
  );

  // Disconnect and reconnect the same launch again: the acknowledged reply is not re-sent.
  const exited2 = new Promise((resolve) => channel2.child.once("exit", resolve));
  channel2.child.stdin.end();
  await exited2;
  const channel3 = await spawnChannelServer(workspace, { key: launchKey });

  const fence = await beta.request("agent_request", {
    target: "demo",
    text: "Post-reconnect fence",
    idempotency_key: "beta-reconnect-fence-1",
  });
  assert.equal(fence.ok, true, JSON.stringify(fence));
  await waitFor(
    () => channel3.notifications.some((n) => n.content === "Post-reconnect fence"),
    () => `fence notification: ${JSON.stringify(channel3.notifications)}`,
    10000,
  );
  assert.equal(
    channel3.notifications.filter((n) => n.meta.request_id === reqId).length,
    0,
    JSON.stringify(channel3.notifications),
  );
});

test("a Claude thread session sends, receives, lists targets, and answers Agent Messages with thread metadata", async () => {
  const workspace = claudeAgentWorkspace();
  const betaThreadId = "1700000000000400009";
  seedThreads(workspace, {
    [betaThreadId]: { type: 11, parentId: "beta-channel", name: "Beta task", archived: false },
  });
  await routerWithWebhooks(workspace, ["demo", "beta"]);
  await startThreadSupervisor(workspace);
  const beta = await connectAgentProject(workspace, "beta", "beta-key");
  writeThreadKey(workspace, betaThreadId, "beta-thread-key");
  const betaThread = await connectAgentThread(workspace, "beta", betaThreadId, "beta-thread-key", "codex");

  // Boot demo's Claude thread session with a scripted list + send_agent_request.
  updateState(workspace.stateDir, (state) => {
    state.fixtures.claude.toolScript = [
      { name: "list_agent_targets", arguments: {} },
      { name: "send_agent_request", arguments: { target: `beta/${betaThreadId}`, text: "Hello from demo thread" } },
    ];
  });
  createThread(workspace);
  await waitForThreadState(workspace, "demo", THREAD_ID, () => true);
  injectDiscordMessage(workspace, {
    id: "thread-boot-agent",
    channelId: THREAD_ID,
    content: "coordinate with beta thread",
    author: { id: OWNER_ID, username: "Owner" },
  });
  await waitForThreadState(workspace, "demo", THREAD_ID, (row) => row.state === "live");

  await waitFor(
    () => (readState(workspace.stateDir).fixtures.claude.toolResults?.length ?? 0) >= 2
      && betaThread.events.some((event) => event.event === "agent_message" && event.kind === "request"),
    () => `thread send results: ${JSON.stringify({
      claude: readState(workspace.stateDir).fixtures.claude,
      betaThread: betaThread.events,
    })}`,
    15000,
  );

  const [listRes, sendRes] = readState(workspace.stateDir).fixtures.claude.toolResults;
  assert.match(listRes.result.content[0].text, /beta \(channel: live\)/);
  assert.match(listRes.result.content[0].text, new RegExp(`beta/${betaThreadId} \\(Beta task\\)`));

  const reqFromThread = betaThread.events.find((event) => event.event === "agent_message" && event.kind === "request");
  assert.match(sendRes.result.content[0].text, new RegExp(reqFromThread.request_id));
  assert.equal(reqFromThread.text, "Hello from demo thread");
  assert.equal(reqFromThread.from.project, "demo");
  assert.equal(reqFromThread.from.provider, "claude");
  assert.equal(reqFromThread.from.thread_id, THREAD_ID);
  assert.equal(reqFromThread.from.thread_name, "Agent thread");

  // Beta thread answers demo thread; clear toolScript first so reply doesn't re-send.
  updateState(workspace.stateDir, (state) => {
    delete state.fixtures.claude.toolScript;
  });
  const threadReply = await betaThread.request("agent_reply", {
    request_id: reqFromThread.request_id,
    text: "Reply from beta thread",
    idempotency_key: "beta-thread-reply-1",
  });
  assert.equal(threadReply.ok, true, JSON.stringify(threadReply));
  assert.equal(threadReply.result.delivered_to_live_session, true);

  await waitFor(
    () => (readState(workspace.stateDir).fixtures.claude.channelNotifications ?? [])
      .some((n) => n.meta.agent_message === "reply" && n.meta.request_id === reqFromThread.request_id),
    () => `demo thread reply notification: ${JSON.stringify(readState(workspace.stateDir).fixtures.claude.channelNotifications)}`,
    15000,
  );
  const replyNotif = readState(workspace.stateDir).fixtures.claude.channelNotifications.find(
    (n) => n.meta.agent_message === "reply" && n.meta.request_id === reqFromThread.request_id,
  );
  assert.equal(replyNotif.content, "Reply from beta thread");
  assert.equal(replyNotif.meta.chat_id, THREAD_ID);
  assert.equal(replyNotif.meta.sender, "agent");
  assert.equal(replyNotif.meta.from_project, "beta");
  assert.equal(replyNotif.meta.from_conversation, betaThreadId);
  assert.equal(replyNotif.meta.user, "beta-codex › Beta task");
  assert.equal(typeof replyNotif.meta.message_id, "string");

  // Now beta thread sends an Agent Request targeting demo's Claude thread, and demo thread answers.
  updateState(workspace.stateDir, (state) => {
    state.fixtures.claude.toolScript = [
      { name: "send_agent_reply", arguments: { request_id: "{{request_id}}", text: "Demo thread got your request" } },
    ];
  });
  const reqToThread = await betaThread.request("agent_request", {
    target: `demo/${THREAD_ID}`,
    text: "Question for demo thread",
    idempotency_key: "beta-thread-req-1",
  });
  assert.equal(reqToThread.ok, true, JSON.stringify(reqToThread));

  await waitFor(
    () => betaThread.events.some((event) => event.event === "agent_message" && event.kind === "reply" && event.request_id === reqToThread.result.request_id),
    () => `beta thread reply receipt: ${JSON.stringify(betaThread.events)}`,
    15000,
  );

  const reqNotif = readState(workspace.stateDir).fixtures.claude.channelNotifications.find(
    (n) => n.meta.agent_message === "request" && n.meta.request_id === reqToThread.result.request_id,
  );
  assert.ok(reqNotif, JSON.stringify(readState(workspace.stateDir).fixtures.claude.channelNotifications));
  assert.equal(reqNotif.content, "Question for demo thread");
  assert.equal(reqNotif.meta.chat_id, THREAD_ID);
  assert.equal(reqNotif.meta.sender, "agent");
  assert.equal(reqNotif.meta.from_project, "beta");
  assert.equal(reqNotif.meta.from_conversation, betaThreadId);
  assert.equal(reqNotif.meta.user, "beta-codex › Beta task");
  assert.equal(typeof reqNotif.meta.message_id, "string");

  const answerAtBeta = betaThread.events.find(
    (event) => event.event === "agent_message" && event.kind === "reply" && event.request_id === reqToThread.result.request_id,
  );
  assert.equal(answerAtBeta.text, "Demo thread got your request");
  assert.equal(answerAtBeta.from.project, "demo");
  assert.equal(answerAtBeta.from.thread_id, THREAD_ID);
  assert.ok(beta);
});
