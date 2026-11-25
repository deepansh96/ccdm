import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import test from "node:test";

import {
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

test.afterEach(cleanup);

const SESSION_ID = "4a5b6c7d-8e9f-4a0b-9c1d-2e3f4a5b6c7d";
const BETA_THREAD_ID = "1700000000000409001";
const BETA_THREAD_NAME = "Deploy check";

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

function connectAgentProject(workspace, project, key) {
  return rawClient(workspace, {
    role: "project",
    project,
    key,
    capabilities: ["agent_messages"],
  });
}

function connectAgentThread(workspace, project, threadId, key, provider = "codex") {
  return rawClient(workspace, {
    role: "thread",
    project,
    thread_id: threadId,
    provider,
    key,
    capabilities: ["agent_messages"],
  });
}

const fakeHosts = new WeakMap();
async function launcherEnv(workspace, extraEnv = {}) {
  if (process.platform !== "win32") return routerEnv(workspace, extraEnv);
  if (!fakeHosts.has(workspace)) {
    fakeHosts.set(workspace, await startFakeHost(workspace, { env: routerEnv(workspace) }));
  }
  return routerEnv(workspace, { ...fakeHosts.get(workspace).env, ...extraEnv });
}

function createNoticeWorkspace(demoType, extraDemo = {}) {
  const workspace = createRouterWorkspace({
    ...routerRegistry({
      demo: {
        channel_id: "demo-channel",
        type: demoType,
        transport: "router",
        screen_name: `demo_${demoType}`,
        session_id: null,
        pid: null,
        agent_message_targets: ["beta"],
        ...extraDemo,
      },
      beta: {
        channel_id: "beta-channel",
        type: "codex",
        transport: "router",
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
  seedThreads(workspace, {
    [BETA_THREAD_ID]: { type: 11, parentId: "beta-channel", name: BETA_THREAD_NAME, archived: false },
  });
  return workspace;
}

function fakeAgyBin(workspace) {
  const fake = path.join(workspace.repoDir, "tests/e2e/support/fake-agy.cjs");
  if (process.platform === "win32") return fake;
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

test("Claude sender receives beta-codex and thread labels on expired and failed notices", async () => {
  const workspace = createNoticeWorkspace("claude");
  await routerWithWebhooks(workspace, ["demo", "beta"], {
    env: { CCDM_ROUTER_AGENT_MESSAGE_MINUTE_MS: "250" },
  });
  writeProjectKey(workspace, "beta", "beta-key");
  writeThreadKey(workspace, BETA_THREAD_ID, "beta-thread-key");
  const beta = await connectAgentProject(workspace, "beta", "beta-key");
  const betaThread = await connectAgentThread(workspace, "beta", BETA_THREAD_ID, "beta-thread-key", "codex");

  updateState(workspace.stateDir, (state) => {
    state.fixtures.claude.toolScript = [
      { name: "send_agent_request", arguments: { target: "beta", text: "Channel expiry", timeout_minutes: 1 } },
      { name: "send_agent_request", arguments: { target: `beta/${BETA_THREAD_ID}`, text: "Thread expiry", timeout_minutes: 1 } },
    ];
  });
  const started = await runScript(workspace, "scripts/start-session.sh", {
    args: ["demo"],
    env: await launcherEnv(workspace),
    timeoutMs: 30000,
  });
  assert.equal(started.exitCode, 0, started.stderr || started.stdout);

  injectDiscordMessage(workspace, {
    id: "claude-owner-exp",
    channelId: "demo-channel",
    content: "send expiring requests",
    author: { id: OWNER_ID, username: "Owner" },
  });

  await waitFor(
    () => beta.events.some((e) => e.event === "agent_message" && e.kind === "request")
      && betaThread.events.some((e) => e.event === "agent_message" && e.kind === "request"),
    () => "beta and betaThread received expiring requests",
    15000,
  );
  updateState(workspace.stateDir, (state) => { delete state.fixtures.claude.toolScript; });

  const chanExpId = beta.events.find((e) => e.event === "agent_message" && e.kind === "request").request_id;
  const threadExpId = betaThread.events.find((e) => e.event === "agent_message" && e.kind === "request").request_id;

  await waitFor(
    () => {
      const notifs = readState(workspace.stateDir).fixtures.claude.channelNotifications ?? [];
      return notifs.some((n) => n.meta.agent_message === "notice" && n.meta.request_id === chanExpId)
        && notifs.some((n) => n.meta.agent_message === "notice" && n.meta.request_id === threadExpId);
    },
    () => `claude expiry notices: ${JSON.stringify(readState(workspace.stateDir).fixtures.claude.channelNotifications)}`,
    15000,
  );

  // Now trigger request_failed notices for channel and thread targets via receiver bot post 500s.
  updateState(workspace.stateDir, (state) => {
    state.fixtures.discord.restFailures = [
      { method: "POST", path: "/api/v10/channels/beta-channel/messages", status: 500 },
      { method: "POST", path: `/api/v10/channels/${BETA_THREAD_ID}/messages`, status: 500 },
    ];
    state.fixtures.claude.toolScript = [
      { name: "send_agent_request", arguments: { target: "beta", text: "Channel fail" } },
      { name: "send_agent_request", arguments: { target: `beta/${BETA_THREAD_ID}`, text: "Thread fail" } },
    ];
  });
  injectDiscordMessage(workspace, {
    id: "claude-owner-fail",
    channelId: "demo-channel",
    content: "send failing requests",
    author: { id: OWNER_ID, username: "Owner" },
  });

  await waitFor(
    () => (readState(workspace.stateDir).fixtures.claude.toolResults?.length ?? 0) >= 4,
    () => `claude tool results: ${JSON.stringify(readState(workspace.stateDir).fixtures.claude.toolResults)}`,
    15000,
  );
  updateState(workspace.stateDir, (state) => { delete state.fixtures.claude.toolScript; });

  const results = readState(workspace.stateDir).fixtures.claude.toolResults;
  const chanFailId = /\b(req-[0-9a-f]{12})\b/.exec(results[2].result.content[0].text)?.[1];
  const threadFailId = /\b(req-[0-9a-f]{12})\b/.exec(results[3].result.content[0].text)?.[1];
  assert.ok(chanFailId && threadFailId, JSON.stringify(results));

  await waitFor(
    () => {
      const notifs = readState(workspace.stateDir).fixtures.claude.channelNotifications ?? [];
      return notifs.some((n) => n.meta.agent_message === "notice" && n.meta.request_id === chanFailId)
        && notifs.some((n) => n.meta.agent_message === "notice" && n.meta.request_id === threadFailId);
    },
    () => `claude failed notices: ${JSON.stringify(readState(workspace.stateDir).fixtures.claude.channelNotifications)}`,
    15000,
  );

  const notifs = readState(workspace.stateDir).fixtures.claude.channelNotifications;
  const findNotice = (id) => notifs.find((n) => n.meta.agent_message === "notice" && n.meta.request_id === id);

  const chanExp = findNotice(chanExpId);
  assert.equal(chanExp.meta.user, "beta-codex");
  assert.match(chanExp.content, /to beta-codex expired/);

  const threadExp = findNotice(threadExpId);
  assert.equal(threadExp.meta.user, `beta-codex › ${BETA_THREAD_NAME}`);
  assert.match(threadExp.content, new RegExp(`to beta-codex › ${BETA_THREAD_NAME} expired`));

  const chanFail = findNotice(chanFailId);
  assert.equal(chanFail.meta.user, "beta-codex");
  assert.match(chanFail.content, /to beta-codex failed:/);

  const threadFail = findNotice(threadFailId);
  assert.equal(threadFail.meta.user, `beta-codex › ${BETA_THREAD_NAME}`);
  assert.match(threadFail.content, new RegExp(`to beta-codex › ${BETA_THREAD_NAME} failed:`));
});

test("Codex sender receives beta-codex and thread labels on expired and failed notices", async () => {
  const workspace = createNoticeWorkspace("codex", { ws_port: 0 });
  fs.mkdirSync(path.join(workspace.homeDir, ".codex"), { recursive: true });

  const codex = await startFakeCodexServer(workspace, {
    channelId: "demo-channel",
    turns: [
      {
        turnId: "send-expiring",
        mcpCalls: () => [
          ["send_agent_request", { target: "beta", text: "Channel expiry", timeout_minutes: 1 }],
          ["send_agent_request", { target: `beta/${BETA_THREAD_ID}`, text: "Thread expiry", timeout_minutes: 1 }],
        ],
      },
      { turnId: "notice-1" },
      { turnId: "notice-2" },
      {
        turnId: "send-failing",
        mcpCalls: () => [
          ["send_agent_request", { target: "beta", text: "Channel fail" }],
          ["send_agent_request", { target: `beta/${BETA_THREAD_ID}`, text: "Thread fail" }],
        ],
      },
      { turnId: "notice-3" },
      { turnId: "notice-4" },
    ],
  });
  const registryFile = path.join(workspace.repoDir, "registry.json");
  const registry = JSON.parse(fs.readFileSync(registryFile, "utf8"));
  registry.projects.demo.ws_port = codex.port;
  fs.writeFileSync(registryFile, `${JSON.stringify(registry, null, 2)}\n`);

  await routerWithWebhooks(workspace, ["demo", "beta"], {
    env: { CCDM_ROUTER_AGENT_MESSAGE_MINUTE_MS: "250" },
  });
  writeProjectKey(workspace, "beta", "beta-key");
  writeThreadKey(workspace, BETA_THREAD_ID, "beta-thread-key");
  const beta = await connectAgentProject(workspace, "beta", "beta-key");
  const betaThread = await connectAgentThread(workspace, "beta", BETA_THREAD_ID, "beta-thread-key", "codex");

  const started = await runScript(workspace, "scripts/start-codex-session.sh", {
    args: ["demo"],
    env: await launcherEnv(workspace),
    timeoutMs: 30000,
  });
  assert.equal(started.exitCode, 0, started.stderr || started.stdout);

  const nonBootstrapTurns = () => codex.clientMessages
    .filter((m) => m.method === "turn/start")
    .map((m) => m.params.input.map((p) => p.text ?? "").join("\n"))
    .filter((text) => !text.startsWith("You are communicating with the user via Discord"));

  // Trigger Turn 1 (two expiring requests).
  injectDiscordMessage(workspace, {
    id: "codex-owner-exp",
    channelId: "demo-channel",
    content: "send expiring requests",
    author: { id: OWNER_ID, username: "Owner" },
  });

  await waitFor(
    () => beta.events.some((e) => e.event === "agent_message" && e.kind === "request")
      && betaThread.events.some((e) => e.event === "agent_message" && e.kind === "request"),
    () => "beta and betaThread received expiring requests",
    15000,
  );
  const chanExpId = beta.events.find((e) => e.event === "agent_message" && e.kind === "request").request_id;
  const threadExpId = betaThread.events.find((e) => e.event === "agent_message" && e.kind === "request").request_id;

  // Wait for bootstrap + Turn 1 + 2 expiry notice turns (4 finished turns).
  await waitForFinishedTurns(workspace, 4, 15000, codex);

  // Trigger Turn 4 (two failing requests via receiver bot post 500s).
  updateState(workspace.stateDir, (state) => {
    state.fixtures.discord.restFailures = [
      { method: "POST", path: "/api/v10/channels/beta-channel/messages", status: 500 },
      { method: "POST", path: `/api/v10/channels/${BETA_THREAD_ID}/messages`, status: 500 },
    ];
  });
  injectDiscordMessage(workspace, {
    id: "codex-owner-fail",
    channelId: "demo-channel",
    content: "send failing requests",
    author: { id: OWNER_ID, username: "Owner" },
  });

  // Wait for all 7 finished turns (bootstrap + 2 owner turns + 4 notice turns).
  await waitForFinishedTurns(workspace, 7, 15000, codex);

  const sendResults = readState(workspace.stateDir).fixtures.codex.protocolEvents
    .filter((e) => e.event === "mcp-tool-result" && e.tool === "send_agent_request");
  assert.equal(sendResults.length, 4, JSON.stringify(sendResults));
  const chanFailId = /\b(req-[0-9a-f]{12})\b/.exec(sendResults[2].result.content[0].text)?.[1];
  const threadFailId = /\b(req-[0-9a-f]{12})\b/.exec(sendResults[3].result.content[0].text)?.[1];
  assert.ok(chanFailId && threadFailId, JSON.stringify(sendResults));

  const turns = nonBootstrapTurns();
  assert.ok(
    turns.some((t) => t.startsWith(`[Agent Request ${chanExpId} to beta-codex expired]\n`)),
    `missing channel expiry label in ${JSON.stringify(turns)}`,
  );
  assert.ok(
    turns.some((t) => t.startsWith(`[Agent Request ${threadExpId} to beta-codex › ${BETA_THREAD_NAME} expired]\n`)),
    `missing thread expiry label in ${JSON.stringify(turns)}`,
  );
  assert.ok(
    turns.some((t) => t.startsWith(`[Agent Request ${chanFailId} to beta-codex failed]\n`)),
    `missing channel failed label in ${JSON.stringify(turns)}`,
  );
  assert.ok(
    turns.some((t) => t.startsWith(`[Agent Request ${threadFailId} to beta-codex › ${BETA_THREAD_NAME} failed]\n`)),
    `missing thread failed label in ${JSON.stringify(turns)}`,
  );
});

test("Gemini sender receives beta-codex and thread labels on expired and failed notices", async () => {
  const workspace = createNoticeWorkspace("gemini");
  agyPlan(workspace.stateDir, {
    sessionIds: [SESSION_ID],
    turns: [
      {
        mcpCalls: [
          { name: "send_agent_request", args: { target: "beta", text: "Channel expiry", timeout_minutes: 1 }, withScopeToken: true },
          { name: "send_agent_request", args: { target: `beta/${BETA_THREAD_ID}`, text: "Thread expiry", timeout_minutes: 1 }, withScopeToken: true },
        ],
      },
      {},
      {},
      {
        mcpCalls: [
          { name: "send_agent_request", args: { target: "beta", text: "Channel fail" }, withScopeToken: true },
          { name: "send_agent_request", args: { target: `beta/${BETA_THREAD_ID}`, text: "Thread fail" }, withScopeToken: true },
        ],
      },
      {},
      {},
    ],
  });

  await routerWithWebhooks(workspace, ["demo", "beta"], {
    env: { CCDM_ROUTER_AGENT_MESSAGE_MINUTE_MS: "250" },
  });
  writeProjectKey(workspace, "beta", "beta-key");
  writeThreadKey(workspace, BETA_THREAD_ID, "beta-thread-key");
  const beta = await connectAgentProject(workspace, "beta", "beta-key");
  const betaThread = await connectAgentThread(workspace, "beta", BETA_THREAD_ID, "beta-thread-key", "codex");

  const started = await runScript(workspace, "scripts/start-gemini-session.sh", {
    args: ["demo"],
    env: await launcherEnv(workspace, { CCDM_AGY_BIN: fakeAgyBin(workspace) }),
    timeoutMs: 30000,
  });
  assert.equal(started.exitCode, 0, started.stderr || started.stdout);

  injectDiscordMessage(workspace, {
    id: "gemini-owner-exp",
    channelId: "demo-channel",
    content: "send expiring requests",
    author: { id: OWNER_ID, username: "Owner" },
  });

  await waitFor(
    () => beta.events.some((e) => e.event === "agent_message" && e.kind === "request")
      && betaThread.events.some((e) => e.event === "agent_message" && e.kind === "request"),
    () => "beta and betaThread received expiring requests",
    15000,
  );
  const chanExpId = beta.events.find((e) => e.event === "agent_message" && e.kind === "request").request_id;
  const threadExpId = betaThread.events.find((e) => e.event === "agent_message" && e.kind === "request").request_id;

  await waitFor(
    () => promptTexts(workspace.stateDir).length >= 3,
    () => `gemini expiry prompts: ${JSON.stringify(promptTexts(workspace.stateDir))}`,
    15000,
  );

  updateState(workspace.stateDir, (state) => {
    state.fixtures.discord.restFailures = [
      { method: "POST", path: "/api/v10/channels/beta-channel/messages", status: 500 },
      { method: "POST", path: `/api/v10/channels/${BETA_THREAD_ID}/messages`, status: 500 },
    ];
  });
  injectDiscordMessage(workspace, {
    id: "gemini-owner-fail",
    channelId: "demo-channel",
    content: "send failing requests",
    author: { id: OWNER_ID, username: "Owner" },
  });

  await waitFor(
    () => promptTexts(workspace.stateDir).length >= 6,
    () => `gemini all 6 prompts: ${JSON.stringify(promptTexts(workspace.stateDir))}`,
    15000,
  );

  const sendCalls = agyEvents(workspace.stateDir).filter((e) => e.event === "mcp-call" && e.name === "send_agent_request");
  assert.equal(sendCalls.length, 4, JSON.stringify(sendCalls));
  const chanFailId = /\b(req-[0-9a-f]{12})\b/.exec(sendCalls[2].result.content[0].text)?.[1];
  const threadFailId = /\b(req-[0-9a-f]{12})\b/.exec(sendCalls[3].result.content[0].text)?.[1];
  assert.ok(chanFailId && threadFailId, JSON.stringify(sendCalls));

  const prompts = promptTexts(workspace.stateDir);
  assert.ok(
    prompts.some((p) => p.startsWith(`[Agent Request ${chanExpId} to beta-codex expired]\n`)),
    `missing channel expiry label in ${JSON.stringify(prompts)}`,
  );
  assert.ok(
    prompts.some((p) => p.startsWith(`[Agent Request ${threadExpId} to beta-codex › ${BETA_THREAD_NAME} expired]\n`)),
    `missing thread expiry label in ${JSON.stringify(prompts)}`,
  );
  assert.ok(
    prompts.some((p) => p.startsWith(`[Agent Request ${chanFailId} to beta-codex failed]\n`)),
    `missing channel failed label in ${JSON.stringify(prompts)}`,
  );
  assert.ok(
    prompts.some((p) => p.startsWith(`[Agent Request ${threadFailId} to beta-codex › ${BETA_THREAD_NAME} failed]\n`)),
    `missing thread failed label in ${JSON.stringify(prompts)}`,
  );
});
