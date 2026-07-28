#!/usr/bin/env node

// PROTOTYPE: throwaway live probe for Claude streaming, steering, and MCP scope.

const { randomBytes, randomUUID } = require("crypto");
const { spawn } = require("child_process");
const { createInterface } = require("readline");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const MCP_SCRIPT = path.join(__dirname, "discord-mcp-server.js");
const TIMEOUT_MS = Number(process.env.CLAUDE_PROTOTYPE_TIMEOUT_MS || 120_000);
const scopeToken = randomBytes(24).toString("hex");
const missingFile = `/tmp/ccdm-claude-prototype-missing-${process.pid}`;
const mcpToolName = "mcp__discord-probe__reply";

const mcpConfig = JSON.stringify({
  mcpServers: {
    "discord-probe": {
      command: process.execPath,
      args: [MCP_SCRIPT],
      env: {
        BOT_TOKEN: "prototype-invalid",
        CHANNEL_ID: "prototype-channel",
        DISCORD_REPLY_TOKEN: scopeToken,
      },
    },
  },
});

const agents = JSON.stringify({
  "scope-probe": {
    description: "Runs the delegated Discord scope isolation probe.",
    prompt: [
      `Call ${mcpToolName} exactly once.`,
      `Use text "subagent-probe", files ["${missingFile}"], and scope_token "not-provided".`,
      "Return the exact tool result to the parent. Do not ask for or invent another token.",
    ].join(" "),
    tools: [mcpToolName],
  },
});

const args = [
  "-p",
  "--input-format",
  "stream-json",
  "--output-format",
  "stream-json",
  "--verbose",
  "--include-partial-messages",
  "--replay-user-messages",
  "--forward-subagent-text",
  "--strict-mcp-config",
  "--mcp-config",
  mcpConfig,
  "--agents",
  agents,
  "--permission-mode",
  "bypassPermissions",
  "--dangerously-skip-permissions",
  "--no-session-persistence",
  "--system-prompt",
  "You are running a bridge protocol probe. Follow each user instruction exactly and keep responses minimal.",
];

const child = spawn("zsh", ["-ic", 'exec claude "$@"', "ccdm-prototype", ...args], {
  cwd: ROOT,
  env: process.env,
  stdio: ["pipe", "pipe", "pipe"],
});

const state = {
  phase: "starting",
  sessionIds: [],
  results: [],
  toolUses: [],
  toolResults: [],
  stderr: "",
};
const waiters = new Set();

function snapshot() {
  return {
    phase: state.phase,
    sessionId: state.sessionIds.at(-1) || null,
    sessionsSeen: state.sessionIds.length,
    resultsSeen: state.results.length,
    toolUsesSeen: state.toolUses.length,
  };
}

function printState() {
  process.stdout.write(`${JSON.stringify(snapshot())}\n`);
}

function contentBlocks(message) {
  return Array.isArray(message?.message?.content)
    ? message.message.content
    : Array.isArray(message?.content)
      ? message.content
      : [];
}

function textContent(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textContent).join("\n");
  if (value && typeof value === "object") {
    if (typeof value.text === "string") return value.text;
    if (typeof value.content !== "undefined") return textContent(value.content);
  }
  return "";
}

function observe(message) {
  if (message.type === "system" && message.subtype === "init" && message.session_id) {
    if (state.sessionIds.at(-1) !== message.session_id) {
      state.sessionIds.push(message.session_id);
    }
  }
  if (message.type === "result") {
    state.results.push(message);
  }

  for (const block of contentBlocks(message)) {
    if (block.type === "tool_use") {
      if (!state.toolUses.some((toolUse) => toolUse.id === block.id)) {
        state.toolUses.push({
          id: block.id,
          name: block.name,
          input: block.input || {},
          delegated: Boolean(message.parent_tool_use_id || message.message?.parent_tool_use_id),
        });
      }
    } else if (block.type === "tool_result") {
      if (!state.toolResults.some((result) => result.toolUseId === block.tool_use_id)) {
        state.toolResults.push({
          toolUseId: block.tool_use_id,
          text: textContent(block.content),
          isError: Boolean(block.is_error),
        });
      }
    }
  }

  for (const waiter of [...waiters]) {
    if (waiter.predicate(message)) {
      clearTimeout(waiter.timer);
      waiters.delete(waiter);
      waiter.resolve(message);
    }
  }
}

function waitFor(predicate, label, timeoutMs = TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const waiter = {
      predicate,
      resolve,
      timer: setTimeout(() => {
        waiters.delete(waiter);
        reject(new Error(`Timed out waiting for ${label}`));
      }, timeoutMs),
    };
    waiters.add(waiter);
  });
}

function send(message) {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

function sendUser(text) {
  send({ type: "user", message: { role: "user", content: text } });
}

async function nextResult(afterCount, label) {
  if (state.results.length > afterCount) return state.results[afterCount];
  await waitFor(() => state.results.length > afterCount, label);
  return state.results[afterCount];
}

function isTextDelta(message) {
  return message.type === "stream_event"
    && message.event?.type === "content_block_delta"
    && message.event?.delta?.type === "text_delta";
}

function matchingToolResult(toolUse) {
  return state.toolResults.find((result) => result.toolUseId === toolUse?.id);
}

async function run() {
  const steeringResultStart = state.results.length;
  state.phase = "active-turn";
  sendUser(
    "Do not use tools. Start with OLD_OUTPUT, then write the integers 1 through 1000, one per line. Do not stop early."
  );
  await waitFor(
    (message) => message.type === "system" && message.subtype === "init",
    "Claude system init"
  );
  printState();

  await waitFor(isTextDelta, "the active turn's first text delta");

  const interruptId = randomUUID();
  state.phase = "interrupting";
  send({
    type: "control_request",
    request_id: interruptId,
    request: { subtype: "interrupt", reason: "prototype-steer" },
  });
  await waitFor(
    (message) =>
      message.type === "control_response"
      && message.response?.request_id === interruptId
      && message.response?.subtype === "success",
    "interrupt acknowledgement"
  );
  sendUser("Do not use tools. Reply exactly STEERED_OK.");

  const interrupted = await nextResult(steeringResultStart, "interrupted result");
  const redirected = await nextResult(steeringResultStart + 1, "redirected result");
  const steeringPassed =
    interrupted.terminal_reason === "aborted_streaming"
    && redirected.is_error === false
    && String(redirected.result || "").trim() === "STEERED_OK";
  if (!steeringPassed) {
    throw new Error(
      `Steering mismatch: interrupted=${interrupted.terminal_reason}, redirected=${JSON.stringify(redirected.result)}`
    );
  }
  state.phase = "steered";
  printState();

  const directToolStart = state.toolUses.length;
  const directResultStart = state.results.length;
  sendUser([
    `Call ${mcpToolName} exactly once with this input:`,
    JSON.stringify({
      text: "top-level-probe",
      files: [missingFile],
      scope_token: scopeToken,
    }),
    "Do not retry. Then reply exactly DIRECT_SCOPE_DONE.",
  ].join("\n"));
  await nextResult(directResultStart, "top-level scope result");
  const directTool = state.toolUses
    .slice(directToolStart)
    .find((toolUse) => toolUse.name === mcpToolName);
  const directToolResult = matchingToolResult(directTool);
  const directScopePassed =
    directTool?.input?.scope_token === scopeToken
    && !directTool?.delegated
    && directToolResult?.text.includes("ENOENT")
    && !directToolResult.text.includes("invalid scope token");
  if (!directScopePassed) {
    throw new Error("Top-level scoped MCP call did not pass the scope guard before the safe file error");
  }
  state.phase = "top-level-scope-proved";
  printState();

  const delegatedToolStart = state.toolUses.length;
  const delegatedResultStart = state.results.length;
  sendUser([
    'Use the Agent tool with subagent_type "scope-probe".',
    'Give it only this prompt: "Run your configured scope check now."',
    "Do not pass, mention, or copy any scope token into the Agent call.",
    "Do not call the Discord MCP yourself. Return the delegated result.",
  ].join("\n"));
  await nextResult(delegatedResultStart, "delegated scope result");
  const delegatedUses = state.toolUses.slice(delegatedToolStart);
  const agentCall = delegatedUses.find((toolUse) => toolUse.name === "Agent");
  const delegatedMcpCall = delegatedUses.find(
    (toolUse) => toolUse.name === mcpToolName && toolUse.delegated
  );
  const delegatedMcpResult = matchingToolResult(delegatedMcpCall);
  const agentInput = JSON.stringify(agentCall?.input || {});
  const delegatedScopePassed =
    agentCall
    && !agentInput.includes(scopeToken)
    && delegatedMcpCall?.input?.scope_token !== scopeToken
    && delegatedMcpResult?.text.includes("missing or invalid scope token");
  if (!delegatedScopePassed) {
    throw new Error("Delegated MCP call did not demonstrate scope-token isolation");
  }
  state.phase = "delegated-scope-denied";
  printState();

  const oldSessionId = state.sessionIds.at(-1);
  const clearResultStart = state.results.length;
  sendUser("/clear");
  await waitFor(
    (message) =>
      (message.type === "system" && message.subtype === "conversation_reset")
      || message.type === "conversation_reset",
    "conversation reset"
  );
  await waitFor(
    (message) =>
      message.type === "system"
      && message.subtype === "init"
      && message.session_id
      && message.session_id !== oldSessionId,
    "new session init"
  );
  await nextResult(clearResultStart, "clear result");
  state.phase = "complete";
  printState();

  process.stdout.write(`${JSON.stringify({
    steering: {
      passed: true,
      interruptedTerminalReason: interrupted.terminal_reason,
      redirectedResult: redirected.result,
    },
    scopedMcp: {
      topLevelPassedScopeGuard: true,
      delegatedCallDenied: true,
      tokenLeakedToAgentInput: false,
    },
    reset: {
      passed: true,
      sessionIdChanged: oldSessionId !== state.sessionIds.at(-1),
    },
  }, null, 2)}\n`);
}

const stdout = createInterface({ input: child.stdout, terminal: false });
stdout.on("line", (line) => {
  try {
    observe(JSON.parse(line));
  } catch {
    // Claude diagnostics may include non-JSON lines; they are not protocol events.
  }
});
child.stderr.on("data", (chunk) => {
  state.stderr += chunk;
});

child.on("exit", (code, signal) => {
  if (state.phase !== "complete") {
    process.stderr.write(`Claude exited early (${code ?? signal})\n`);
  }
});

run()
  .catch((error) => {
    process.stderr.write(`${error.message}\n`);
    const diagnostic = state.stderr.trim().split("\n").slice(-8).join("\n");
    if (diagnostic) process.stderr.write(`${diagnostic}\n`);
    process.exitCode = 1;
  })
  .finally(() => {
    child.kill("SIGTERM");
    stdout.close();
  });
