import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import test from "node:test";

import {
  collectProcess,
  injectDiscordMessage,
  startFakeCodexServer,
  waitForFinishedTurns,
} from "./support/bridge.js";
import { PYTHON } from "./support/platform.js";
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
  writeRootKey,
  writeThreadKey,
} from "./support/router.js";
import { startFakeHost } from "./support/session-fixture.js";
import { readState, updateState } from "./support/state.js";
import { cleanup, registerTeardownCallback } from "./support/teardown.js";
import {
  startThreadSupervisor,
  supervisorStateDir,
  supervisorStatus,
} from "./support/thread-supervisor.js";

test.afterEach(cleanup);

const AGENT_TOOLS = ["send_agent_request", "send_agent_reply", "list_agent_targets"];
const THREAD_ID = "1700000000000402001";
const BETA_THREAD_ID = "1700000000000402009";

function rpc(id, method, params) {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params });
}

function toolCall(id, name, args = {}) {
  return rpc(id, "tools/call", { name, arguments: args });
}

function parsedLines(stdout) {
  return stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

async function runMcp(workspace, lines, env, { timeoutMs = 15000 } = {}) {
  const childEnv = routerEnv(workspace, env);
  const command = [process.execPath, path.join(workspace.repoDir, "scripts/discord-mcp-server.js")];
  const child = spawn(command[0], command.slice(1), {
    cwd: workspace.repoDir,
    detached: true,
    env: childEnv,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const running = collectProcess(child, { command, cwd: workspace.repoDir, detached: true, env: childEnv }, workspace);
  registerTeardownCallback(() => running.stop());
  for (const line of lines) {
    child.stdin.write(`${line}\n`);
    let request = null;
    try {
      request = JSON.parse(line);
    } catch {
      // Malformed input gets no response.
    }
    if (request?.id === undefined) continue;
    const deadline = Date.now() + timeoutMs;
    while (!parsedLines(running.stdout).some((entry) => entry.id === request.id)) {
      if (child.exitCode !== null) break;
      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for response ${request.id}; stdout:\n${running.stdout}\nstderr:\n${running.stderr}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  child.stdin.end();
  return await running.closed;
}

function responseById(result) {
  return new Map(parsedLines(result.stdout).map((entry) => [entry.id, entry]));
}

function codexAgentWorkspace(extra = {}) {
  const workspace = createRouterWorkspace({
    ...routerRegistry({
      demo: {
        channel_id: "demo-channel",
        type: "codex",
        transport: "router",
        screen_name: "demo_codex",
        ws_port: 0,
        session_id: null,
        pid: null,
        agent_message_targets: ["beta"],
        ...(extra.demo || {}),
      },
      beta: {
        channel_id: "beta-channel",
        type: "claude",
        transport: "router",
        agent_message_targets: ["demo"],
        ...(extra.beta || {}),
      },
      gamma: {
        channel_id: "gamma-channel",
        type: "claude",
        transport: "router",
        ...(extra.gamma || {}),
      },
    }),
    root_channels: ["root-channel"],
    ...(extra.registry || {}),
  });
  const registryFile = path.join(workspace.repoDir, "registry.json");
  const registry = JSON.parse(fs.readFileSync(registryFile, "utf8"));
  registry.projects.demo.path = workspace.tmpDir;
  registry.projects.beta.path = workspace.tmpDir;
  registry.projects.gamma.path = workspace.tmpDir;
  fs.writeFileSync(registryFile, `${JSON.stringify(registry, null, 2)}\n`);
  fs.mkdirSync(path.join(workspace.homeDir, ".codex"), { recursive: true });
  return workspace;
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

function connectAgentThread(workspace, project, threadId, key, provider = "claude", extra = {}) {
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

function demoMcpEnv(workspace, extra = {}) {
  return {
    CCDM_ROUTER_KEY_FILE: path.join(workspace.routerStateDir, "keys", "demo.key"),
    CCDM_CODEX_PROJECT: "demo",
    CHANNEL_ID: "demo-channel",
    ...extra,
  };
}

function demoThreadMcpEnv(workspace, threadId = THREAD_ID, extra = {}) {
  return {
    CCDM_ROUTER_KEY_FILE: path.join(workspace.routerStateDir, "keys", `.thread-${threadId}.key`),
    CCDM_CODEX_PROJECT: "demo",
    CCDM_THREAD_ID: threadId,
    CCDM_THREAD_PROVIDER: "codex",
    CHANNEL_ID: threadId,
    ...extra,
  };
}

function rootMcpEnv(workspace, extra = {}) {
  return {
    CCDM_ROUTER_KEY_FILE: path.join(workspace.routerStateDir, "keys", ".root.key"),
    CCDM_ROUTER_ROLE: "root",
    CHANNEL_ID: "root-channel",
    ...extra,
  };
}

test("Discord MCP exposes the three Agent Message tools for channel and thread sessions, never root, and requires scope_token for sends", async () => {
  const workspace = codexAgentWorkspace();
  await routerWithWebhooks(workspace, ["demo", "beta"]);
  writeProjectKey(workspace, "demo", "demo-key");
  writeThreadKey(workspace, THREAD_ID, "demo-thread-key");
  writeRootKey(workspace, "root-key");

  const channelResult = await runMcp(
    workspace,
    [
      rpc(1, "initialize", {}),
      rpc(2, "tools/list", {}),
      toolCall(3, "send_agent_request", { target: "beta", text: "missing token" }),
      toolCall(4, "send_agent_request", { target: "beta", text: "wrong token", scope_token: "bad" }),
      toolCall(5, "send_agent_reply", { request_id: "req-111111111111", text: "missing token" }),
      toolCall(6, "send_agent_reply", { request_id: "req-111111111111", text: "wrong token", scope_token: "bad" }),
      toolCall(7, "list_agent_targets", {}),
    ],
    demoMcpEnv(workspace, { DISCORD_REPLY_TOKEN: "secret-scope-token" }),
  );
  assert.equal(channelResult.exitCode, 0, channelResult.stderr || channelResult.stdout);
  const channelOut = responseById(channelResult);
  const channelTools = channelOut.get(2).result.tools;
  const channelNames = channelTools.map((tool) => tool.name);
  for (const name of AGENT_TOOLS) {
    assert.equal(channelNames.includes(name), true, `channel missing ${name}: ${JSON.stringify(channelNames)}`);
  }
  assert.deepEqual(
    channelTools.find((t) => t.name === "send_agent_request").inputSchema.required,
    ["target", "text", "scope_token"],
  );
  assert.deepEqual(
    channelTools.find((t) => t.name === "send_agent_reply").inputSchema.required,
    ["request_id", "text", "scope_token"],
  );
  assert.deepEqual(
    channelTools.find((t) => t.name === "list_agent_targets").inputSchema.required,
    [],
  );
  for (const id of [3, 4, 5, 6]) {
    assert.equal(channelOut.get(id).result.isError, true, `call ${id} should fail without valid scope_token`);
    assert.equal(
      channelOut.get(id).result.content[0].text,
      "Error: Discord write denied: missing or invalid scope token",
    );
  }
  assert.equal(channelOut.get(7).result.isError, undefined, JSON.stringify(channelOut.get(7)));
  assert.match(channelOut.get(7).result.content[0].text, /beta \(channel: offline\)/);

  const threadResult = await runMcp(
    workspace,
    [rpc(1, "tools/list", {})],
    demoThreadMcpEnv(workspace, THREAD_ID, { DISCORD_REPLY_TOKEN: "secret-scope-token" }),
  );
  assert.equal(threadResult.exitCode, 0, threadResult.stderr || threadResult.stdout);
  const threadNames = responseById(threadResult).get(1).result.tools.map((tool) => tool.name);
  for (const name of AGENT_TOOLS) {
    assert.equal(threadNames.includes(name), true, `thread missing ${name}: ${JSON.stringify(threadNames)}`);
  }

  const rootResult = await runMcp(
    workspace,
    [
      rpc(1, "tools/list", {}),
      toolCall(2, "send_agent_request", { target: "beta", text: "from root", scope_token: "secret-scope-token" }),
      toolCall(3, "send_agent_reply", { request_id: "req-111111111111", text: "from root", scope_token: "secret-scope-token" }),
      toolCall(4, "list_agent_targets", {}),
    ],
    rootMcpEnv(workspace, { DISCORD_REPLY_TOKEN: "secret-scope-token" }),
  );
  assert.equal(rootResult.exitCode, 0, rootResult.stderr || rootResult.stdout);
  const rootOut = responseById(rootResult);
  const rootNames = rootOut.get(1).result.tools.map((tool) => tool.name);
  for (const name of AGENT_TOOLS) {
    assert.equal(rootNames.includes(name), false, `root should not list ${name}`);
  }
  for (const id of [2, 3, 4]) {
    assert.equal(rootOut.get(id).result.isError, true);
    assert.match(rootOut.get(id).result.content[0].text, /Unknown tool/);
  }
});

test("Discord MCP Agent Message tools work against a raw client, surface refusal codes, and retry with one idempotency key on disconnect", async () => {
  const workspace = codexAgentWorkspace();
  seedThreads(workspace, {
    [BETA_THREAD_ID]: { type: 11, parentId: "beta-channel", name: "Beta worker", archived: false },
  });
  await routerWithWebhooks(workspace, ["demo", "beta", "gamma"]);
  writeProjectKey(workspace, "demo", "demo-key");
  writeProjectKey(workspace, "beta", "beta-key");
  writeThreadKey(workspace, BETA_THREAD_ID, "beta-thread-key");

  // Connect demo listener so beta can send a request to demo, and connect beta + beta thread.
  const demoListener = await connectAgentProject(workspace, "demo", "demo-key");
  const beta = await connectAgentProject(workspace, "beta", "beta-key");
  const betaThread = await connectAgentThread(workspace, "beta", BETA_THREAD_ID, "beta-thread-key", "claude");

  const incoming = await beta.request("agent_request", {
    target: "demo",
    text: "Check status",
    idempotency_key: "beta-to-demo-1",
  });
  assert.equal(incoming.ok, true, JSON.stringify(incoming));
  const incomingId = incoming.result.request_id;
  await waitFor(
    () => demoListener.events.some((event) => event.event === "agent_message" && event.request_id === incomingId),
    () => `demo incoming request: ${JSON.stringify(demoListener.events)}`,
  );

  const result = await runMcp(
    workspace,
    [
      toolCall(1, "list_agent_targets", {}),
      toolCall(2, "send_agent_request", { target: "beta", text: "Ping from MCP", timeout_minutes: 15, scope_token: "tok" }),
      toolCall(3, "send_agent_request", { target: "gamma", text: "Ungranted", scope_token: "tok" }),
      toolCall(4, "send_agent_reply", { request_id: incomingId, text: "Status is green", scope_token: "tok" }),
      toolCall(5, "send_agent_reply", { request_id: incomingId, text: "Second reply", scope_token: "tok" }),
    ],
    demoMcpEnv(workspace, { DISCORD_REPLY_TOKEN: "tok" }),
  );
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  const out = responseById(result);

  assert.match(out.get(1).result.content[0].text, /beta \(channel: live\)/);
  assert.match(out.get(1).result.content[0].text, new RegExp(`beta/${BETA_THREAD_ID} \\(Beta worker\\)`));

  assert.equal(out.get(2).result.isError, undefined, JSON.stringify(out.get(2)));
  const sentReqId = /\b(req-[0-9a-f]{12})\b/.exec(out.get(2).result.content[0].text)?.[1];
  assert.ok(sentReqId, out.get(2).result.content[0].text);

  await waitFor(
    () => beta.events.some((event) => event.event === "agent_message" && event.request_id === sentReqId),
    () => `beta request event: ${JSON.stringify(beta.events)}`,
  );
  assert.equal(
    beta.events.find((event) => event.event === "agent_message" && event.request_id === sentReqId).text,
    "Ping from MCP",
  );

  assert.equal(out.get(3).result.isError, true);
  assert.match(out.get(3).result.content[0].text, /not_granted/);

  assert.equal(out.get(4).result.isError, undefined, JSON.stringify(out.get(4)));
  assert.match(out.get(4).result.content[0].text, new RegExp(incomingId));
  assert.match(out.get(4).result.content[0].text, /delivered_to_live_session=true/);

  assert.equal(out.get(5).result.isError, true);
  assert.match(out.get(5).result.content[0].text, /already_replied/);

  // Stand-in Router drops the first agent_request attempt, forcing a retry with the same idempotency_key.
  const retryWorkspace = codexAgentWorkspace();
  writeProjectKey(retryWorkspace, "demo", "demo-key");
  let secret = null;
  const seenKeys = [];
  let attempts = 0;
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
          send({ type: "hello_ok", scope: { project: "demo", channel_id: "demo-channel", type: "codex" } });
        } else if (frame.type === "request" && frame.op === "agent_request") {
          seenKeys.push(frame.args.idempotency_key);
          attempts += 1;
          if (attempts === 1) {
            socket.destroy();
          } else {
            send({
              type: "response",
              id: frame.id,
              ok: true,
              result: { request_id: "req-abcdef012345", expires_at: "2026-11-25T03:00:00.000Z", depth: 1 },
            });
          }
        }
      }
    });
  });
  secret = await listenAsRouter(retryWorkspace, server);
  registerTeardownCallback(() => new Promise((resolve) => server.close(resolve)));

  const retried = await runMcp(
    retryWorkspace,
    [toolCall(1, "send_agent_request", { target: "beta", text: "Retry me", scope_token: "tok" })],
    demoMcpEnv(retryWorkspace, {
      DISCORD_REPLY_TOKEN: "tok",
      CCDM_ROUTER_RECONNECT_MIN_MS: "50",
      CCDM_ROUTER_RECONNECT_MAX_MS: "100",
    }),
  );
  assert.equal(retried.exitCode, 0, retried.stderr || retried.stdout);
  const retriedOut = responseById(retried).get(1).result;
  assert.equal(retriedOut.isError, undefined, JSON.stringify(retriedOut));
  assert.match(retriedOut.content[0].text, /req-abcdef012345/);
  assert.equal(seenKeys.length, 2);
  assert.ok(seenKeys[0]);
  assert.equal(seenKeys[0], seenKeys[1], "retry must reuse the same idempotency_key");
  assert.ok(betaThread);
});

const fakeHosts = new WeakMap();
async function launcherEnv(workspace, extraEnv = {}) {
  if (process.platform !== "win32") return routerEnv(workspace, extraEnv);
  if (!fakeHosts.has(workspace)) {
    fakeHosts.set(workspace, await startFakeHost(workspace, { env: routerEnv(workspace) }));
  }
  return routerEnv(workspace, { ...fakeHosts.get(workspace).env, ...extraEnv });
}

function setDemoPort(workspace, port) {
  const registryFile = path.join(workspace.repoDir, "registry.json");
  const registry = JSON.parse(fs.readFileSync(registryFile, "utf8"));
  registry.projects.demo.ws_port = port;
  fs.writeFileSync(registryFile, `${JSON.stringify(registry, null, 2)}\n`);
}

async function startCodexChannel(workspace, extraEnv = {}) {
  const started = await runScript(workspace, "scripts/start-codex-session.sh", {
    args: ["demo"],
    env: await launcherEnv(workspace, extraEnv),
    timeoutMs: 30000,
  });
  assert.equal(started.exitCode, 0, started.stderr || started.stdout);
  return started;
}

function clientMessages(codex, method) {
  return codex.clientMessages.filter((message) => message.method === method);
}

function turnTexts(codex) {
  return clientMessages(codex, "turn/start")
    .map((message) => message.params.input.map((part) => part.text ?? "").join("\n"));
}

function nonBootstrapTurnTexts(codex) {
  return turnTexts(codex).filter((text) => !text.startsWith("You are communicating with the user via Discord"));
}

function requestCodexThread(workspace, threadId = THREAD_ID, name = "Codex Agent Thread") {
  const store = path.join(supervisorStateDir(workspace), "threads.sqlite3");
  execFileSync(PYTHON, ["-c", `import sqlite3, sys
db = sqlite3.connect(sys.argv[1], timeout=5)
db.execute("""INSERT INTO creation_requests (request_id, project, name, provider, account, model, effort,
  first_message, requester_id, requester_kind, status, thread_id, created_at)
  VALUES ('req-thread-1', 'demo', ?, 'codex', NULL, NULL, NULL, NULL, ?, 'owner', 'pending', NULL,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))""", (sys.argv[2], sys.argv[3]))
db.commit()`, store, name, OWNER_ID]);
  updateState(workspace.stateDir, (state) => {
    (state.fixtures.discord.injectedThreads ||= []).push({
      id: threadId,
      type: 11,
      parentId: "demo-channel",
      name,
      ownerId: "fixture-bot-user-id",
      autoArchiveDuration: 10080,
      event: "create",
    });
  });
}

async function waitForThreadRow(workspace, threadId, predicate = () => true, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await supervisorStatus(workspace);
    const row = last.projects?.demo?.threads?.[threadId];
    if (row && predicate(row)) return row;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`thread ${threadId} never matched: ${JSON.stringify(last)}`);
}

test("Codex channel and thread instructions name the three Agent Message tools and carry the trust note; root Codex does not", async () => {
  const workspace = codexAgentWorkspace();
  const channelCodex = await startFakeCodexServer(workspace, { channelId: "demo-channel" });
  setDemoPort(workspace, channelCodex.port);
  const rootCodex = await startFakeCodexServer(workspace, { channelId: "root-channel" });
  const threadPort = 29460;
  const threadCodex = await startFakeCodexServer(workspace, {
    port: threadPort,
    deferListen: true,
    codexHome: path.join(workspace.homeDir, ".codex"),
    channelId: THREAD_ID,
    bootstrapPlan: { mcpReplyText: "thread ready" },
  });
  await routerWithWebhooks(workspace, ["demo", "beta"]);
  await startThreadSupervisor(workspace, { env: { CCDM_THREAD_WS_PORT_BASE: String(threadPort) } });

  await startCodexChannel(workspace);
  writeRootKey(workspace, "root-key");
  const rootBridgeEnv = routerEnv(workspace, {
    CCDM_ROUTER_ROLE: "root",
    CCDM_ROUTER_KEY_FILE: path.join(workspace.routerStateDir, "keys", ".root.key"),
    CHANNEL_ID: "root-channel",
    PROJECT_DIR: workspace.repoDir,
    WS_PORT: String(rootCodex.port),
    ALLOWED_USER_IDS: OWNER_ID,
  });
  const rootChild = spawn(process.execPath, [path.join(workspace.repoDir, "scripts/codex-bridge.js")], {
    cwd: workspace.repoDir,
    detached: true,
    env: rootBridgeEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const rootBridge = collectProcess(rootChild, { command: [process.execPath, "scripts/codex-bridge.js"], cwd: workspace.repoDir, detached: true, env: rootBridgeEnv }, workspace);
  registerTeardownCallback(() => rootBridge.stop());
  await rootBridge.waitForOutput(/Listening in #/, 15000);

  requestCodexThread(workspace, THREAD_ID);
  await waitForThreadRow(workspace, THREAD_ID, (row) => row.provider === "codex");
  injectDiscordMessage(workspace, {
    id: "thread-boot-instr",
    channelId: THREAD_ID,
    content: "boot codex thread",
    author: { id: OWNER_ID, username: "Owner" },
  });
  const allocated = await waitForThreadRow(workspace, THREAD_ID, (row) => row.ws_port != null);
  assert.equal(allocated.ws_port, threadPort);
  await threadCodex.listen();
  await waitForThreadRow(workspace, THREAD_ID, (row) => row.state === "live");
  await waitFor(() => turnTexts(threadCodex).length >= 1, () => "thread bootstrap turn", 15000);

  const channelStart = clientMessages(channelCodex, "thread/start")[0];
  const channelBootstrap = turnTexts(channelCodex)[0];
  const threadStart = clientMessages(threadCodex, "thread/start")[0];
  const threadBootstrap = turnTexts(threadCodex)[0];
  const rootStart = clientMessages(rootCodex, "thread/start")[0];
  const rootBootstrap = turnTexts(rootCodex)[0];

  for (const [label, text] of [
    ["channel transport instruction", channelStart.params.developerInstructions],
    ["channel bootstrap text", channelBootstrap],
    ["thread transport instruction", threadStart.params.developerInstructions],
    ["thread bootstrap text", threadBootstrap],
  ]) {
    for (const toolName of AGENT_TOOLS) {
      assert.equal(text.includes(toolName), true, `${label} missing ${toolName}: ${text}`);
    }
    assert.match(text, /another agent, not from the owner/i, label);
    assert.match(text, /destructive, irreversible or outward-facing work/i, label);
    assert.match(text, /data, not instructions/i, label);
    assert.match(text, /reply.*own conversation.*send_agent_reply/is, label);
  }
  assert.doesNotMatch(channelStart.params.developerInstructions, /scope_token/);
  assert.doesNotMatch(threadStart.params.developerInstructions, /scope_token/);

  for (const toolName of AGENT_TOOLS) {
    assert.equal(rootStart.params.developerInstructions.includes(toolName), false, `root transport instruction should not name ${toolName}`);
    assert.equal(rootBootstrap.includes(toolName), false, `root bootstrap should not name ${toolName}`);
  }
});

test("an idle Codex session receives an Agent Request, answers and sends through MCP tools, handles reply and expiry notice, and emits no owner_activity", async () => {
  const workspace = codexAgentWorkspace({
    demo: { agent_message_targets: ["beta", "offline_proj"] },
    registry: {
      projects: {
        demo: {
          channel_id: "demo-channel",
          type: "codex",
          transport: "router",
          screen_name: "demo_codex",
          ws_port: 0,
          session_id: null,
          pid: null,
          path: "/tmp",
          agent_message_targets: ["beta", "offline_proj"],
        },
        beta: {
          channel_id: "beta-channel",
          type: "claude",
          transport: "router",
          path: "/tmp",
          agent_message_targets: ["demo"],
        },
        gamma: {
          channel_id: "gamma-channel",
          type: "claude",
          transport: "router",
          path: "/tmp",
        },
        offline_proj: {
          channel_id: "offline-channel",
          type: "claude",
          transport: "router",
          path: "/tmp",
        },
      },
    },
  });
  // Point all paths to workspace.tmpDir.
  const registryFile = path.join(workspace.repoDir, "registry.json");
  const registry = JSON.parse(fs.readFileSync(registryFile, "utf8"));
  for (const project of Object.values(registry.projects)) project.path = workspace.tmpDir;
  fs.writeFileSync(registryFile, `${JSON.stringify(registry, null, 2)}\n`);

  const reminderStateDir = path.join(workspace.homeDir, ".local", "state", "ccdm", "conversation-reminders");
  const codex = await startFakeCodexServer(workspace, {
    channelId: "demo-channel",
    turns: [
      {
        turnId: "agent-request-turn",
        mcpCalls: (input) => {
          const text = input[0]?.text ?? "";
          const reqId = /^\[Agent Request (req-[0-9a-f]{12}) from beta-claude\]/.exec(text)?.[1] ?? "";
          return [
            ["list_agent_targets", {}],
            ["send_agent_reply", { request_id: reqId, text: "Codex handled your request" }],
            ["send_agent_request", { target: "beta", text: "Need beta answer" }],
            ["send_agent_request", { target: "beta", text: "Will expire soon", timeout_minutes: 1 }],
            ["send_agent_request", { target: "gamma", text: "Should be refused" }],
            ["send_agent_request", { target: "offline_proj", text: "Target is offline" }],
          ];
        },
      },
      { turnId: "agent-reply-turn" },
      { turnId: "agent-notice-turn" },
    ],
  });
  setDemoPort(workspace, codex.port);
  await routerWithWebhooks(workspace, ["demo", "beta", "gamma", "offline_proj"], {
    env: { CCDM_ROUTER_AGENT_MESSAGE_MINUTE_MS: "300" },
  });
  writeProjectKey(workspace, "beta", "beta-key");
  const beta = await connectAgentProject(workspace, "beta", "beta-key");

  await startCodexChannel(workspace, { CCDM_REMINDER_STATE_DIR: reminderStateDir });

  // Capability check: beta sees demo as live in agent_targets.
  const targets = await beta.request("agent_targets", {});
  assert.equal(targets.ok, true, JSON.stringify(targets));
  assert.deepEqual(targets.result.targets, [{ project: "demo", channel_live: true, threads: [] }]);

  // Beta sends an Agent Request to idle demo.
  const reqToDemo = await beta.request("agent_request", {
    target: "demo",
    text: "Run diagnostics on demo",
    idempotency_key: "beta-to-demo-idle-1",
  });
  assert.equal(reqToDemo.ok, true, JSON.stringify(reqToDemo));
  const reqId = reqToDemo.result.request_id;

  // Wait for demo's turn to finish all 6 MCP calls and for beta to receive the reply + both requests.
  await waitForFinishedTurns(workspace, 2, 15000, codex);
  await waitFor(
    () => beta.events.some((e) => e.event === "agent_message" && e.kind === "reply" && e.request_id === reqId)
      && beta.events.filter((e) => e.event === "agent_message" && e.kind === "request").length >= 2,
    () => `beta events: ${JSON.stringify(beta.events)}`,
    15000,
  );

  // Verify the request turn input format: header, from-another-agent line, text.
  const firstTurn = nonBootstrapTurnTexts(codex)[0];
  assert.ok(firstTurn, `expected turn text: ${JSON.stringify(turnTexts(codex))}`);
  const firstLines = firstTurn.split("\n");
  assert.equal(firstLines[0], `[Agent Request ${reqId} from beta-claude]`);
  assert.match(firstLines[1], /another agent/i);
  assert.match(firstLines[1], /send_agent_reply/i);
  assert.equal(firstLines.slice(2).join("\n"), "Run diagnostics on demo");

  // Verify Codex's MCP tool results (refusal + offline target).
  const toolResults = readState(workspace.stateDir).fixtures.codex.protocolEvents
    .filter((event) => event.event === "mcp-tool-result");
  assert.match(toolResults.find((e) => e.tool === "list_agent_targets").result.content[0].text, /beta \(channel: live\)/);
  const sendResults = toolResults.filter((e) => e.tool === "send_agent_request");
  assert.equal(sendResults.length, 4, JSON.stringify(sendResults));
  assert.equal(sendResults[2].result.isError, true);
  assert.match(sendResults[2].result.content[0].text, /not_granted/);
  assert.equal(sendResults[3].result.isError, true);
  assert.match(sendResults[3].result.content[0].text, /target_offline/);

  const betaReplyReceived = beta.events.find((e) => e.event === "agent_message" && e.kind === "reply" && e.request_id === reqId);
  assert.equal(betaReplyReceived.text, "Codex handled your request");

  // Beta answers the first request from demo, and lets the second expire.
  const [demoReq1, demoReq2] = beta.events.filter((e) => e.event === "agent_message" && e.kind === "request");
  const replyRes = await beta.request("agent_reply", {
    request_id: demoReq1.request_id,
    text: "Beta answer ready",
    idempotency_key: "beta-answer-demo-1",
  });
  assert.equal(replyRes.ok, true, JSON.stringify(replyRes));

  // Wait for both the reply turn and the expiry notice turn to arrive and finish.
  await waitFor(
    () => nonBootstrapTurnTexts(codex).length >= 3,
    () => `expected 3 agent turns, got: ${JSON.stringify(nonBootstrapTurnTexts(codex))}`,
    15000,
  );
  await waitForFinishedTurns(workspace, 4, 15000, codex);

  const agentTurns = nonBootstrapTurnTexts(codex);
  const replyTurn = agentTurns.find((t) => t.startsWith(`[Agent Reply to ${demoReq1.request_id} from beta-claude]`));
  assert.ok(replyTurn, `missing reply turn in ${JSON.stringify(agentTurns)}`);
  const replyLines = replyTurn.split("\n");
  assert.match(replyLines[1], /another agent/i);
  assert.equal(replyLines.slice(2).join("\n"), "Beta answer ready");

  const noticeTurn = agentTurns.find((t) => t.startsWith(`[Agent Request ${demoReq2.request_id} to beta-claude expired]`));
  assert.ok(noticeTurn, `missing expiry notice turn in ${JSON.stringify(agentTurns)}`);
  const noticeLines = noticeTurn.split("\n");
  assert.match(noticeLines[1], /another agent/i);
  assert.match(noticeLines.slice(2).join("\n"), /expired/i);

  // No owner_activity emitted for any Agent Message.
  const outboxDir = path.join(reminderStateDir, "outbox");
  assert.deepEqual(fs.existsSync(outboxDir) ? fs.readdirSync(outboxDir) : [], []);
});

test("an Agent Request during an active Codex turn sends no turn/steer, gets no ⏳, and starts its own turn later while an owner message still steers", async () => {
  const workspace = codexAgentWorkspace();
  const codex = await startFakeCodexServer(workspace, {
    channelId: "demo-channel",
    turns: [
      { turnId: "active-owner-turn", waitForRelease: true },
      { turnId: "queued-agent-turn" },
    ],
  });
  setDemoPort(workspace, codex.port);
  await routerWithWebhooks(workspace, ["demo", "beta"]);
  writeProjectKey(workspace, "beta", "beta-key");
  const beta = await connectAgentProject(workspace, "beta", "beta-key");

  await startCodexChannel(workspace);

  injectDiscordMessage(workspace, {
    id: "owner-active-1",
    channelId: "demo-channel",
    content: "long owner task",
    author: { id: OWNER_ID, username: "Owner" },
  });
  await waitFor(() => nonBootstrapTurnTexts(codex).length === 1, () => "owner active turn started", 15000);

  // Agent Request arrives mid-turn: must queue without turn/steer or ⏳.
  const midTurnReq = await beta.request("agent_request", {
    target: "demo",
    text: "Wait for your own turn",
    idempotency_key: "beta-mid-turn-1",
  });
  assert.equal(midTurnReq.ok, true, JSON.stringify(midTurnReq));
  const midReqId = midTurnReq.result.request_id;

  // Owner message arrives right after while the same turn is still active: must steer.
  injectDiscordMessage(workspace, {
    id: "owner-steer-1",
    channelId: "demo-channel",
    content: "owner correction mid-turn",
    author: { id: OWNER_ID, username: "Owner" },
  });
  await waitFor(() => clientMessages(codex, "turn/steer").length === 1, () => "owner steer during active turn", 15000);

  // Wait until the Router has posted the request record in demo-channel (confirming delivery path ran).
  await waitFor(
    () => (readState(workspace.stateDir).fixtures.discord.messages ?? [])
      .some((m) => m.channelId === "demo-channel" && m.content.includes(midReqId)),
    () => "receiver request record posted in demo-channel",
    10000,
  );

  // Only the owner message steered; the Agent Request started no turn yet and got no ⏳.
  const steers = clientMessages(codex, "turn/steer");
  assert.equal(steers.length, 1);
  assert.equal(steers[0].params.expectedTurnId, "active-owner-turn");
  assert.deepEqual(steers[0].params.input, [{ type: "text", text: "owner correction mid-turn" }]);
  assert.equal(nonBootstrapTurnTexts(codex).length, 1);
  const hourglassBefore = (readState(workspace.stateDir).fixtures.discord.reactions ?? [])
    .filter((r) => decodeURIComponent(r.emoji) === "⏳");
  assert.deepEqual(hourglassBefore, []);

  // Release the active turn: the queued Agent Request starts a turn of its own.
  codex.releaseTurn("active-owner-turn");
  await waitFor(() => nonBootstrapTurnTexts(codex).length === 2, () => "queued agent turn started", 15000);
  await waitForFinishedTurns(workspace, 3, 15000, codex);

  assert.equal(clientMessages(codex, "turn/steer").length, 1);
  const agentTurn = nonBootstrapTurnTexts(codex)[1];
  assert.ok(agentTurn.startsWith(`[Agent Request ${midReqId} from beta-claude]\n`), agentTurn);
  assert.match(agentTurn, /Wait for your own turn/);
  const hourglassAfter = (readState(workspace.stateDir).fixtures.discord.reactions ?? [])
    .filter((r) => decodeURIComponent(r.emoji) === "⏳");
  assert.deepEqual(hourglassAfter, []);
});

test("while paused, an Agent Request is held until /unpause and a request that expired while held starts no turn", async () => {
  const workspace = codexAgentWorkspace();
  const codex = await startFakeCodexServer(workspace, {
    channelId: "demo-channel",
    turns: [
      { turnId: "fresh-agent-turn" },
      { turnId: "fence-owner-turn" },
    ],
  });
  setDemoPort(workspace, codex.port);
  await routerWithWebhooks(workspace, ["demo", "beta"], {
    env: { CCDM_ROUTER_AGENT_MESSAGE_MINUTE_MS: "250" },
  });
  writeProjectKey(workspace, "beta", "beta-key");
  const beta = await connectAgentProject(workspace, "beta", "beta-key");

  await startCodexChannel(workspace);

  // Pause demo.
  injectDiscordMessage(workspace, {
    id: "owner-pause-1",
    channelId: "demo-channel",
    content: "/pause",
    author: { id: OWNER_ID, username: "Owner" },
  });
  await waitFor(
    () => (readState(workspace.stateDir).fixtures.discord.messages ?? [])
      .some((m) => m.channelId === "demo-channel" && m.content.includes("Bridge paused")),
    () => "bridge paused notice",
    10000,
  );

  // While paused, send one short-lived request (expires while held) and one long-lived request.
  const expiringReq = await beta.request("agent_request", {
    target: "demo",
    text: "Expired while paused",
    timeout_minutes: 1,
    idempotency_key: "beta-paused-expiring-1",
  });
  assert.equal(expiringReq.ok, true, JSON.stringify(expiringReq));
  const expiringId = expiringReq.result.request_id;

  const freshReq = await beta.request("agent_request", {
    target: "demo",
    text: "Still fresh after unpause",
    timeout_minutes: 60,
    idempotency_key: "beta-paused-fresh-1",
  });
  assert.equal(freshReq.ok, true, JSON.stringify(freshReq));
  const freshId = freshReq.result.request_id;

  // Wait until the short-lived request expires (Router sends ⚠️ reaction and expiry notice to beta).
  await waitFor(
    () => beta.events.some((e) => e.event === "agent_message" && e.kind === "notice" && e.request_id === expiringId && e.outcome === "expired")
      && (readState(workspace.stateDir).fixtures.discord.messages ?? [])
        .some((m) => m.channelId === "demo-channel" && m.content.includes(freshId)),
    () => `waiting for expiry notice for ${expiringId}: ${JSON.stringify(beta.events)}`,
    10000,
  );

  // Neither request started a turn while paused, and neither got ⏳.
  assert.deepEqual(nonBootstrapTurnTexts(codex), []);
  const pausedHourglass = (readState(workspace.stateDir).fixtures.discord.reactions ?? [])
    .filter((r) => decodeURIComponent(r.emoji) === "⏳");
  assert.deepEqual(pausedHourglass, []);

  // Unpause, then send a fence owner message after the fresh request starts.
  injectDiscordMessage(workspace, {
    id: "owner-unpause-1",
    channelId: "demo-channel",
    content: "/unpause",
    author: { id: OWNER_ID, username: "Owner" },
  });
  await waitFor(() => nonBootstrapTurnTexts(codex).length >= 1, () => "fresh request turn after unpause", 15000);
  await waitForFinishedTurns(workspace, 2, 15000, codex);

  injectDiscordMessage(workspace, {
    id: "owner-fence-1",
    channelId: "demo-channel",
    content: "post-unpause fence",
    author: { id: OWNER_ID, username: "Owner" },
  });
  await waitFor(() => nonBootstrapTurnTexts(codex).length >= 2, () => "fence turn after unpause", 15000);
  await waitForFinishedTurns(workspace, 3, 15000, codex);

  const turns = nonBootstrapTurnTexts(codex);
  assert.equal(turns.length, 2, JSON.stringify(turns));
  assert.ok(turns[0].startsWith(`[Agent Request ${freshId} from beta-claude]\n`), turns[0]);
  assert.match(turns[0], /Still fresh after unpause/);
  assert.equal(turns[1], "post-unpause fence");
  assert.equal(turns.some((t) => t.includes("Expired while paused") || t.includes(expiringId)), false, JSON.stringify(turns));
});

test("a Codex thread session holds an Agent Request until bootstrap ends, answers with thread metadata, and sends its own request as a thread sender", async () => {
  const workspace = codexAgentWorkspace();
  const threadPort = 29470;
  const threadCodex = await startFakeCodexServer(workspace, {
    port: threadPort,
    deferListen: true,
    codexHome: path.join(workspace.homeDir, ".codex"),
    channelId: THREAD_ID,
    bootstrapPlan: { turnId: "thread-boot-turn", waitForRelease: true, mcpReplyText: "thread booted" },
    turns: [
      {
        turnId: "thread-agent-turn",
        mcpCalls: (input) => {
          const text = input[0]?.text ?? "";
          const reqId = /^\[Agent Request (req-[0-9a-f]{12}) from beta-claude\]/.exec(text)?.[1] ?? "";
          return [
            ["send_agent_reply", { request_id: reqId, text: "Answered from Codex thread" }],
            ["send_agent_request", { target: "beta", text: "Ping from Codex thread" }],
            ["send_agent_request", { target: "gamma", text: "Ungranted from Codex thread" }],
          ];
        },
      },
      { turnId: "thread-reply-received-turn" },
    ],
  });
  await routerWithWebhooks(workspace, ["demo", "beta"]);
  await startThreadSupervisor(workspace, { env: { CCDM_THREAD_WS_PORT_BASE: String(threadPort) } });
  writeProjectKey(workspace, "beta", "beta-key");
  const beta = await connectAgentProject(workspace, "beta", "beta-key");

  requestCodexThread(workspace, THREAD_ID, "Codex Worker");
  await waitForThreadRow(workspace, THREAD_ID, (row) => row.provider === "codex");
  injectDiscordMessage(workspace, {
    id: "thread-boot-msg",
    channelId: THREAD_ID,
    content: "start thread work",
    author: { id: OWNER_ID, username: "Owner" },
  });
  const allocated = await waitForThreadRow(workspace, THREAD_ID, (row) => row.ws_port != null);
  assert.equal(allocated.ws_port, threadPort);
  await threadCodex.listen();
  await waitForThreadRow(workspace, THREAD_ID, (row) => row.state === "live");
  await waitFor(() => turnTexts(threadCodex).length === 1, () => "thread bootstrap started", 15000);

  // Beta discovers the live Codex thread via agent_targets and sends an Agent Request while bootstrap is still active.
  const targets = await beta.request("agent_targets", {});
  assert.equal(targets.ok, true, JSON.stringify(targets));
  assert.deepEqual(targets.result.targets, [
    { project: "demo", channel_live: false, threads: [{ id: THREAD_ID, name: "Codex Worker" }] },
  ]);

  const threadReq = await beta.request("agent_request", {
    target: `demo/${THREAD_ID}`,
    text: "Check thread task",
    idempotency_key: "beta-to-codex-thread-1",
  });
  assert.equal(threadReq.ok, true, JSON.stringify(threadReq));
  const threadReqId = threadReq.result.request_id;

  await waitFor(
    () => (readState(workspace.stateDir).fixtures.discord.messages ?? [])
      .some((m) => m.channelId === THREAD_ID && m.content.includes(threadReqId)),
    () => "receiver request record in thread",
    10000,
  );
  // Still only the bootstrap turn; no steer.
  assert.equal(turnTexts(threadCodex).length, 1);
  assert.deepEqual(clientMessages(threadCodex, "turn/steer"), []);

  // Release bootstrap: the held Agent Request starts its own turn, answers beta, and sends its own requests.
  threadCodex.releaseTurn("thread-boot-turn");
  await waitFor(
    () => beta.events.some((e) => e.event === "agent_message" && e.kind === "reply" && e.request_id === threadReqId)
      && beta.events.some((e) => e.event === "agent_message" && e.kind === "request" && e.text === "Ping from Codex thread")
      && readState(workspace.stateDir).fixtures.codex.protocolEvents
        .filter((event) => event.event === "mcp-tool-result" && event.tool === "send_agent_request").length >= 2,
    () => `beta thread reply & requests: ${JSON.stringify(beta.events)}`,
    15000,
  );

  assert.equal(turnTexts(threadCodex).length, 2);
  assert.ok(turnTexts(threadCodex)[1].startsWith(`[Agent Request ${threadReqId} from beta-claude]\n`), turnTexts(threadCodex)[1]);
  assert.match(turnTexts(threadCodex)[1], /Check thread task/);
  const replyEvent = beta.events.find((e) => e.event === "agent_message" && e.kind === "reply" && e.request_id === threadReqId);
  assert.equal(replyEvent.text, "Answered from Codex thread");
  assert.equal(replyEvent.from.project, "demo");
  assert.equal(replyEvent.from.provider, "codex");
  assert.equal(replyEvent.from.thread_id, THREAD_ID);
  assert.equal(replyEvent.from.thread_name, "Codex Worker");

  // Verify the outbound request sent BY the Codex thread carries thread metadata, and ungranted gamma was refused.
  const outboundReq = beta.events.find((e) => e.event === "agent_message" && e.kind === "request" && e.text === "Ping from Codex thread");
  assert.equal(outboundReq.from.project, "demo");
  assert.equal(outboundReq.from.provider, "codex");
  assert.equal(outboundReq.from.thread_id, THREAD_ID);
  assert.equal(outboundReq.from.thread_name, "Codex Worker");
  await beta.request("agent_message_ack", { delivery_id: outboundReq.delivery_id });

  const threadToolResults = readState(workspace.stateDir).fixtures.codex.protocolEvents
    .filter((event) => event.event === "mcp-tool-result");
  const refusedSend = threadToolResults.filter((e) => e.tool === "send_agent_request")[1];
  assert.ok(refusedSend, JSON.stringify(threadToolResults));
  assert.equal(refusedSend.result.isError, true);
  assert.match(refusedSend.result.content[0].text, /not_granted/);

  // Beta answers the Codex thread's request; the Agent Reply arrives in the thread as its own turn.
  const betaAnswer = await beta.request("agent_reply", {
    request_id: outboundReq.request_id,
    text: "Reply to Codex thread",
    idempotency_key: "beta-reply-to-codex-thread-1",
  });
  assert.equal(betaAnswer.ok, true, JSON.stringify(betaAnswer));
  assert.equal(betaAnswer.result.delivered_to_live_session, true);

  await waitFor(() => turnTexts(threadCodex).length === 3, () => `Codex thread reply turn: ${JSON.stringify(turnTexts(threadCodex))}`, 15000);
  const replyTurn = turnTexts(threadCodex)[2];
  assert.ok(replyTurn.startsWith(`[Agent Reply to ${outboundReq.request_id} from beta-claude]\n`), replyTurn);
  assert.match(replyTurn, /Reply to Codex thread/);
});

function spawnCodexBridge(workspace, port, extraEnv = {}) {
  const env = routerEnv(workspace, {
    CCDM_ROUTER_KEY_FILE: path.join(workspace.routerStateDir, "keys", "demo.key"),
    CCDM_CODEX_PROJECT: "demo",
    CHANNEL_ID: "demo-channel",
    PROJECT_DIR: workspace.tmpDir,
    WS_PORT: String(port),
    ...extraEnv,
  });
  const child = spawn(process.execPath, [path.join(workspace.repoDir, "scripts/codex-bridge.js")], {
    cwd: workspace.repoDir,
    detached: true,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const bridge = collectProcess(
    child,
    { command: [process.execPath, "scripts/codex-bridge.js"], cwd: workspace.repoDir, detached: true, env },
    workspace,
  );
  registerTeardownCallback(() => bridge.stop());
  return bridge;
}

test("agent_message_ack completes before any turn starts and a repeated delivery_id starts no second turn", async () => {
  const workspace = codexAgentWorkspace();
  writeProjectKey(workspace, "demo", "demo-key");
  let secret = null;
  let activeSocket = null;
  const pendingAcks = [];
  const ackedIds = [];
  const seenHellos = [];

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
          seenHellos.push(frame);
          send({ type: "hello_ok", scope: { project: "demo", channel_id: "demo-channel", type: "codex" } });
        } else if (frame.type === "request" && frame.op === "agent_message_ack") {
          ackedIds.push(frame.args.delivery_id);
          pendingAcks.push(() => send({ type: "response", id: frame.id, ok: true, result: {} }));
        } else if (frame.type === "request" && frame.op === "typing") {
          send({ type: "response", id: frame.id, ok: true, result: {} });
        }
      }
    });
  });
  secret = await listenAsRouter(workspace, server);
  registerTeardownCallback(() => new Promise((resolve) => server.close(resolve)));

  const codex = await startFakeCodexServer(workspace, {
    channelId: "demo-channel",
    turns: [{ turnId: "first-turn" }, { turnId: "fence-turn" }],
  });
  const bridge = spawnCodexBridge(workspace, codex.port);
  await bridge.waitForOutput(/Listening in #demo/, 15000);
  await waitForFinishedTurns(bridge, 1, 10000, codex);

  // Verify the bridge's listener hello announced agent_messages.
  assert.deepEqual(seenHellos[0].capabilities, ["agent_messages"]);

  const push = (event) => activeSocket.write(`${JSON.stringify({ type: "event", event: "agent_message", ...event })}\n`);
  const baseEvent = {
    delivery_id: "del-codex-dup-1",
    kind: "request",
    request_id: "req-111122223333",
    text: "Deliver once to Codex",
    ts: "2026-11-25T00:00:00.000Z",
    from: { project: "beta", provider: "claude", conversation_id: "beta-channel" },
    post: { channel_id: "demo-channel", message_id: "msg-201" },
  };
  push(baseEvent);

  // Wait for agent_message_ack BEFORE releasing its response: no turn may start yet.
  await waitFor(() => pendingAcks.length === 1, () => `first ack: ${JSON.stringify(ackedIds)}`);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(nonBootstrapTurnTexts(codex), [], "turn must not start before agent_message_ack completes");

  // Complete the first ack: now the turn starts.
  pendingAcks.shift()();
  await waitFor(() => nonBootstrapTurnTexts(codex).length === 1, () => "first agent turn started", 10000);
  await waitForFinishedTurns(bridge, 2, 10000, codex);

  // Push the exact same delivery_id again, followed by a distinct fence delivery_id.
  push(baseEvent);
  push({
    ...baseEvent,
    delivery_id: "del-codex-dup-2",
    request_id: "req-444455556666",
    text: "Fence delivery",
    post: { channel_id: "demo-channel", message_id: "msg-202" },
  });

  await waitFor(() => pendingAcks.length >= 2, () => `dup + fence acks: ${JSON.stringify(ackedIds)}`);
  while (pendingAcks.length > 0) pendingAcks.shift()();

  await waitFor(() => nonBootstrapTurnTexts(codex).length === 2, () => "fence turn started", 10000);
  await waitForFinishedTurns(bridge, 3, 10000, codex);

  const turns = nonBootstrapTurnTexts(codex);
  assert.equal(turns.length, 2, JSON.stringify(turns));
  assert.ok(turns[0].startsWith("[Agent Request req-111122223333 from beta-claude]\n"));
  assert.match(turns[0], /Deliver once to Codex/);
  assert.ok(turns[1].startsWith("[Agent Request req-444455556666 from beta-claude]\n"));
  assert.match(turns[1], /Fence delivery/);
  assert.deepEqual(ackedIds, ["del-codex-dup-1", "del-codex-dup-1", "del-codex-dup-2"]);
  await bridge.stop();
});

test("after a disconnect and reconnect of the same Codex launch, an unacknowledged delivery arrives once and is not re-sent again", async () => {
  const workspace = codexAgentWorkspace();
  await routerWithWebhooks(workspace, ["demo", "beta"]);
  const launchKey = "codex-same-launch-key";
  writeProjectKey(workspace, "demo", launchKey);
  writeProjectKey(workspace, "beta", "beta-key");
  const beta = await connectAgentProject(workspace, "beta", "beta-key");

  // Launch 1 sends an Agent Request to beta.
  const codex1 = await startFakeCodexServer(workspace, {
    channelId: "demo-channel",
    turns: [{
      turnId: "send-before-disconnect",
      mcpCalls: () => [["send_agent_request", { target: "beta", text: "Answer while Codex disconnects" }]],
    }],
  });
  const bridge1 = spawnCodexBridge(workspace, codex1.port);
  await bridge1.waitForOutput(/Listening in #demo/, 15000);
  await waitForFinishedTurns(bridge1, 1, 10000, codex1);

  injectDiscordMessage(workspace, {
    id: "owner-trigger-reconnect",
    channelId: "demo-channel",
    content: "send request to beta",
    author: { id: OWNER_ID, username: "Owner" },
  });
  await waitFor(
    () => beta.events.some((e) => e.event === "agent_message" && e.kind === "request"),
    () => `beta request: ${JSON.stringify(beta.events)}`,
    15000,
  );
  await waitForFinishedTurns(bridge1, 2, 10000, codex1);
  const reqDelivery = beta.events.find((e) => e.event === "agent_message" && e.kind === "request");
  const reqId = reqDelivery.request_id;
  await beta.request("agent_message_ack", { delivery_id: reqDelivery.delivery_id });

  // Disconnect Codex bridge 1 before beta replies.
  await bridge1.stop();
  await waitFor(async () => {
    const res = await beta.request("agent_targets", {});
    return res.result?.targets?.[0]?.channel_live === false;
  }, () => "demo offline after stop");

  // Beta replies while demo is disconnected (pending delivery bound to launchKey).
  const replied = await beta.request("agent_reply", {
    request_id: reqId,
    text: "Delivered after Codex reconnect",
    idempotency_key: "beta-codex-reconnect-reply-1",
  });
  assert.equal(replied.ok, true, JSON.stringify(replied));
  assert.equal(replied.result.delivered_to_live_session, false);

  // Reconnect the SAME launch key: receives the pending reply once and acks it.
  const codex2 = await startFakeCodexServer(workspace, {
    channelId: "demo-channel",
    turns: [{ turnId: "reconnected-reply-turn" }],
  });
  const bridge2 = spawnCodexBridge(workspace, codex2.port);
  await bridge2.waitForOutput(/Listening in #demo/, 15000);
  await waitFor(() => nonBootstrapTurnTexts(codex2).length === 1, () => "reconnected reply turn", 15000);
  await waitForFinishedTurns(bridge2, 2, 10000, codex2);

  const reconnectTurn = nonBootstrapTurnTexts(codex2)[0];
  assert.ok(reconnectTurn.startsWith(`[Agent Reply to ${reqId} from beta-claude]\n`), reconnectTurn);
  assert.match(reconnectTurn, /Delivered after Codex reconnect/);

  // Disconnect and reconnect the same launch key again: the acknowledged reply must NOT be re-sent.
  await bridge2.stop();
  const codex3 = await startFakeCodexServer(workspace, {
    channelId: "demo-channel",
    turns: [{ turnId: "post-reconnect-fence-turn" }],
  });
  const bridge3 = spawnCodexBridge(workspace, codex3.port);
  await bridge3.waitForOutput(/Listening in #demo/, 15000);
  await waitForFinishedTurns(bridge3, 1, 10000, codex3);

  const fence = await beta.request("agent_request", {
    target: "demo",
    text: "Post-reconnect fence request",
    idempotency_key: "beta-codex-reconnect-fence-1",
  });
  assert.equal(fence.ok, true, JSON.stringify(fence));
  await waitFor(() => nonBootstrapTurnTexts(codex3).length === 1, () => "post-reconnect fence turn", 15000);
  await waitForFinishedTurns(bridge3, 2, 10000, codex3);

  const turns3 = nonBootstrapTurnTexts(codex3);
  assert.equal(turns3.length, 1, JSON.stringify(turns3));
  assert.ok(turns3[0].startsWith(`[Agent Request ${fence.result.request_id} from beta-claude]\n`), turns3[0]);
  assert.equal(turns3.some((t) => t.includes(reqId)), false, JSON.stringify(turns3));
  await bridge3.stop();
});



