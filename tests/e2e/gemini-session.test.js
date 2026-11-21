import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { injectDiscordMessage, waitForState } from "./support/bridge.js";
import { runScript } from "./support/runner.js";
import { startFakeHost } from "./support/session-fixture.js";
import { OWNER_ID, createRouterWorkspace, routerEnv, routerRegistry, routerWithWebhooks, runRouterCli } from "./support/router.js";
import { readState } from "./support/state.js";
import { cleanup } from "./support/teardown.js";


test.afterEach(cleanup);

// A Gemini project end to end: start-gemini-session.sh, the real Router and
// gemini-bridge.js, driving the fake agy (support/fake-agy.cjs) over ACP. The
// fake agy starts the session's real Discord MCP server, so replies travel
// MCP server -> Router -> project webhook like a live session's.
const SESSION_ID = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const SECOND_SESSION_ID = "1b2c3d4e-5f6a-4b7c-9d8e-0f1a2b3c4d5e";
// 262,144 of a 1,048,576-token window is 25%.
const QUARTER_USAGE = { used: 262144, size: 1048576 };

function geminiWorkspace(project = {}) {
  const workspace = createRouterWorkspace(routerRegistry({
    demo: { channel_id: "demo-channel", type: "gemini", transport: "router", guest_user_ids: ["guest-id"],
      screen_name: "demo_gemini", session_id: null, pid: null, ...project },
  }));
  const registryFile = path.join(workspace.repoDir, "registry.json");
  const registry = JSON.parse(fs.readFileSync(registryFile, "utf8"));
  registry.projects.demo.path = workspace.tmpDir;
  fs.writeFileSync(registryFile, `${JSON.stringify(registry, null, 2)}\n`);
  return workspace;
}

// The fixture PATH has no node, so agy is a wrapper naming it.
function fakeAgyBin(workspace) {
  const fake = path.join(workspace.repoDir, "tests/e2e/support/fake-agy.cjs");
  // Windows: the bridge runs a JavaScript agy under its own Node.
  if (process.platform === "win32") return fake;
  const bin = path.join(workspace.tmpRoot, "agy-bin", "agy");
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  // Named agy in ps, as the real binary is, so listener detection sees it.
  fs.writeFileSync(bin, `#!/bin/bash\nexec -a agy '${process.execPath}' '${path.join(workspace.repoDir, "tests/e2e/support/fake-agy.cjs")}' "$@"\n`);
  fs.chmodSync(bin, 0o755);
  return bin;
}

function agyPlan(workspace, plan) {
  fs.writeFileSync(path.join(workspace.stateDir, "agy-plan.json"), `${JSON.stringify(plan)}\n`);
}

function agyEvents(workspace) {
  const file = path.join(workspace.stateDir, "agy.ndjson");
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
}

const clientRequests = (workspace, method) => agyEvents(workspace)
  .filter((event) => event.event === "client" && event.message.method === method).map((event) => event.message);
const promptTexts = (workspace) => clientRequests(workspace, "session/prompt")
  .map((message) => message.params.prompt.filter((block) => block.type === "text").map((block) => block.text).join("\n"));

// On Windows the launcher needs a session host; each Workspace gets one fake host.
const fakeHosts = new WeakMap();
async function backendEnv(workspace) {
  if (process.platform !== "win32") return {};
  if (!fakeHosts.has(workspace)) fakeHosts.set(workspace, await startFakeHost(workspace, { env: routerEnv(workspace) }));
  return fakeHosts.get(workspace).env;
}

async function startGemini(workspace, args = [], extraEnv = {}) {
  return runScript(workspace, "scripts/start-gemini-session.sh", {
    args: ["demo", ...args],
    env: routerEnv(workspace, { ...await backendEnv(workspace), CCDM_AGY_BIN: fakeAgyBin(workspace), ...extraEnv }),
    timeoutMs: 30000,
  });
}

async function stopDemo(workspace) {
  return runScript(workspace, "scripts/stop-session.sh", { args: ["demo"], env: routerEnv(workspace, await backendEnv(workspace)), timeoutMs: 30000 });
}

const readRegistry = (workspace) => JSON.parse(fs.readFileSync(path.join(workspace.repoDir, "registry.json"), "utf8"));
const webhookContents = (state) => state.fixtures.discord.messages.filter((message) => message.webhookId === "fake-webhook-1")
  .map((message) => message.content);
const botReactions = (state) => state.fixtures.discord.reactions.map(({ messageId, emoji }) => [messageId, decodeURIComponent(emoji)]);
const ownerMessage = (workspace, id, content) =>
  injectDiscordMessage(workspace, { id, channelId: "demo-channel", content, author: { id: OWNER_ID, username: "Owner" } });

async function geminiSession(plan, project = {}) {
  const workspace = geminiWorkspace(project);
  agyPlan(workspace, { sessionIds: [SESSION_ID, SECOND_SESSION_ID], ...plan });
  await routerWithWebhooks(workspace, ["demo"]);
  const started = await startGemini(workspace);
  assert.equal(started.exitCode, 0, started.stderr || started.stdout);
  return workspace;
}

test("start-gemini-session runs agy acp in the project with the scoped Discord MCP server, and a reply posts as demo-gemini", async () => {
  const workspace = await geminiSession({ turns: [{ usage: QUARTER_USAGE, reply: "tests pass" }] },
    { gemini_model: "gemini-3.8-flash-low" });

  const status = await runRouterCli(workspace, ["status"]);
  assert.match(status.stdout, /sessions: 1\n  project demo scope=demo-channel connected=/);
  const registry = readRegistry(workspace);
  assert.equal(typeof registry.projects.demo.pid, "number");
  assert.equal(registry.projects.demo.session_id, SESSION_ID);

  const spawn = agyEvents(workspace).find((event) => event.event === "spawn");
  assert.deepEqual(spawn.argv, ["acp", "--dangerously-skip-permissions"]);
  assert.equal(fs.realpathSync(spawn.cwd), fs.realpathSync(workspace.tmpDir));
  const [created] = clientRequests(workspace, "session/new");
  assert.equal(created.params.cwd, workspace.tmpDir);
  assert.deepEqual(created.params.mcpServers.map((server) => server.name), ["discord-demo-channel"]);
  const mcpEnv = Object.fromEntries(created.params.mcpServers[0].env.map(({ name, value }) => [name, value]));
  assert.equal(mcpEnv.CCDM_ROUTER_KEY_FILE, path.join(workspace.routerStateDir, "keys", "demo.key"));
  assert.equal(mcpEnv.CCDM_CODEX_PROJECT, "demo");
  assert.match(created.params._meta.antigravity.systemPrompt.append, /discord-demo-channel/);
  for (const secret of ["root-bot-token", "fake-webhook-token", "DISCORD_BOT_TOKEN"]) {
    assert.equal(JSON.stringify(created).includes(secret), false, secret);
  }
  // A model id with a thinking-level suffix selects that model and level.
  assert.deepEqual(clientRequests(workspace, "session/set_config_option").map((message) => [message.params.configId, message.params.value]),
    [["model", "gemini-3.8-flash"], ["thought_level", "low"]]);

  ownerMessage(workspace, "owner-1", "please run the tests");
  const done = await waitForState(workspace, (next) => webhookContents(next).length > 0, 15000);
  assert.deepEqual(promptTexts(workspace), ["please run the tests"]);
  assert.deepEqual(done.fixtures.discord.messages.map(({ channelId, content, username, webhookId }) => ({ channelId, content, username, webhookId })),
    [{ channelId: "demo-channel", content: "tests pass", username: "demo-gemini · 25%", webhookId: "fake-webhook-1" }]);
  // The MCP server's op-only connection did not replace the bridge as the listener.
  const after = await runRouterCli(workspace, ["status"]);
  assert.match(after.stdout, /sessions: 1\n  project demo scope=demo-channel connected=/);
});

test("messages sent during a Gemini turn wait with ⏳ and go into the next turn together", async () => {
  const workspace = await geminiSession({ turns: [{ delayMs: 1500, reply: "first done" }, { reply: "both done" }] });

  ownerMessage(workspace, "owner-1", "first task");
  await waitForState(workspace, () => promptTexts(workspace).length === 1, 15000);
  ownerMessage(workspace, "owner-2", "also this");
  ownerMessage(workspace, "owner-3", "and that");
  await waitForState(workspace, (next) => botReactions(next).filter(([, emoji]) => emoji === "⏳").length === 2, 15000);
  const done = await waitForState(workspace, (next) => webhookContents(next).includes("both done"), 15000);

  assert.deepEqual(promptTexts(workspace), [
    "first task",
    "[Queued message 1 of 2]\nalso this\n[Queued message 2 of 2]\nand that",
  ]);
  assert.deepEqual(webhookContents(done), ["first done", "both done"]);
  const cleared = await waitForState(workspace, (next) => (next.fixtures.discord.reactionDeletes ?? []).length === 2, 15000);
  assert.deepEqual(cleared.fixtures.discord.reactionDeletes.map(({ messageId, emoji }) => [messageId, decodeURIComponent(emoji)]),
    [["owner-2", "⏳"], ["owner-3", "⏳"]]);
});

test("a Gemini turn that ends with text but no reply call posts that text", async () => {
  const workspace = await geminiSession({ turns: [{ text: "Here is the answer." }] });

  ownerMessage(workspace, "owner-1", "what is it?");
  const done = await waitForState(workspace, (next) => webhookContents(next).length > 0, 15000);

  assert.deepEqual(webhookContents(done), ["Here is the answer."]);
});

test("a failed Gemini prompt posts the error and the next message still runs", async () => {
  const workspace = await geminiSession({ turns: [{ error: "quota exhausted" }, { reply: "recovered" }] });

  ownerMessage(workspace, "owner-1", "first");
  await waitForState(workspace, (next) => webhookContents(next).length > 0, 15000);
  ownerMessage(workspace, "owner-2", "second");
  const done = await waitForState(workspace, (next) => webhookContents(next).includes("recovered"), 15000);

  assert.deepEqual(webhookContents(done), ["**Error:** quota exhausted", "recovered"]);
});

test("/clear cancels the running Gemini turn and opens a fresh agy session; /compact runs agy's compact", async () => {
  const workspace = await geminiSession({ turns: [{ holdUntilCancel: true }, { reply: "fresh" }] });

  ownerMessage(workspace, "owner-1", "long task");
  await waitForState(workspace, () => promptTexts(workspace).length === 1, 15000);
  ownerMessage(workspace, "cmd-clear", "/clear");
  await waitForState(workspace, (next) => webhookContents(next).some((content) => content.startsWith("Conversation cleared")), 15000);
  ownerMessage(workspace, "owner-2", "after clear");
  await waitForState(workspace, (next) => webhookContents(next).includes("fresh"), 15000);
  ownerMessage(workspace, "cmd-compact", "/compact");
  const done = await waitForState(workspace, (next) => webhookContents(next).includes("Compaction complete."), 15000);

  assert.deepEqual(clientRequests(workspace, "session/cancel").map((message) => message.params.sessionId), [SESSION_ID]);
  assert.deepEqual(clientRequests(workspace, "session/new").length, 2);
  assert.deepEqual(clientRequests(workspace, "session/prompt").map((message) => message.params.sessionId),
    [SESSION_ID, SECOND_SESSION_ID, SECOND_SESSION_ID]);
  assert.equal(promptTexts(workspace).at(-1), "/compact");
  // The reply posts before its turn ends, so /compact may still be queued behind it.
  assert.deepEqual(webhookContents(done).filter((content) => content !== "Compaction queued."), [
    "Conversation cleared — fresh session started.", "fresh", "Compaction started.", "Compaction complete.",
  ]);
  assert.deepEqual(botReactions(done).filter(([id]) => id.startsWith("cmd-")), [["cmd-clear", "🔄"], ["cmd-compact", "🔄"]]);
});

test("stop-session stops the Gemini bridge and clears its key, launch files and registry runtime", async () => {
  const workspace = await geminiSession({});
  const pid = readRegistry(workspace).projects.demo.pid;

  const stopped = await stopDemo(workspace);

  assert.equal(stopped.exitCode, 0, stopped.stderr || stopped.stdout);
  assert.match(stopped.stdout, /Stopping recorded process tree for 'demo'/);
  assert.throws(() => process.kill(pid, 0));
  assert.equal(fs.existsSync(path.join(workspace.routerStateDir, "keys", "demo.key")), false);
  assert.equal(fs.existsSync(path.join(workspace.routerStateDir, "launches", "demo")), false);
  assert.deepEqual([readRegistry(workspace).projects.demo.pid, readRegistry(workspace).projects.demo.session_id], [null, null]);
  assert.equal(readState(workspace.stateDir).fixtures.tmux.sessions.demo_gemini, undefined);
});

test("a Gemini launch with a model agy does not offer fails, names the model, and cleans up", async () => {
  const workspace = geminiWorkspace({ gemini_model: "gemini-9-ultra" });
  agyPlan(workspace, {});
  await routerWithWebhooks(workspace, ["demo"]);

  const started = await startGemini(workspace);

  assert.notEqual(started.exitCode, 0);
  assert.match(started.stderr + started.stdout, /Unknown Gemini model 'gemini-9-ultra'/);
  assert.equal(readState(workspace.stateDir).fixtures.tmux.sessions.demo_gemini, undefined);
  assert.equal(fs.existsSync(path.join(workspace.routerStateDir, "keys", "demo.key")), false);
  assert.equal(readRegistry(workspace).projects.demo.pid, null);
});

test("start-gemini-session --resume continues a saved agy conversation and refuses a missing one", async () => {
  const workspace = geminiWorkspace();
  agyPlan(workspace, { turns: [{ reply: "resumed" }] });
  await routerWithWebhooks(workspace, ["demo"]);

  const missing = await startGemini(workspace, ["--resume", SESSION_ID]);
  assert.equal(missing.exitCode, 1);
  assert.match(missing.stderr, /agy conversation .* is missing/);
  assert.deepEqual(agyEvents(workspace), []);

  const conversations = path.join(workspace.homeDir, ".gemini", "antigravity-cli", "conversations");
  fs.mkdirSync(conversations, { recursive: true });
  fs.writeFileSync(path.join(conversations, `${SESSION_ID}.db`), "");
  const resumed = await startGemini(workspace, ["--resume", SESSION_ID]);
  assert.equal(resumed.exitCode, 0, resumed.stderr || resumed.stdout);
  assert.deepEqual(clientRequests(workspace, "session/resume").map((message) => message.params.sessionId), [SESSION_ID]);
  assert.equal(clientRequests(workspace, "session/new").length, 0);
  ownerMessage(workspace, "owner-1", "where were we?");
  const done = await waitForState(workspace, (next) => webhookContents(next).length > 0, 15000);
  assert.deepEqual(webhookContents(done), ["resumed"]);
});

test("start-gemini-session refuses a project that is not a Gemini project", async () => {
  const workspace = geminiWorkspace({ type: "codex" });

  const started = await startGemini(workspace);

  assert.equal(started.exitCode, 1);
  assert.match(started.stderr, /is a codex project, not a gemini one/);
  assert.deepEqual(agyEvents(workspace), []);
});

const overlaps = (workspace) => agyEvents(workspace).filter((event) => event.event === "overlap");
const agyPids = (workspace) => [...new Set(agyEvents(workspace).filter((event) => event.event === "spawn").map((event) => event.pid))];
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("agy's tool permission requests get allow_always, and a reply call that fails falls back to the turn's text", async () => {
  const workspace = await geminiSession({ turns: [
    { permission: true, reply: "ran it" },
    { replyFails: true, reply: "never posted", text: "Fallback answer." },
  ] });

  ownerMessage(workspace, "owner-1", "run the build");
  await waitForState(workspace, (next) => webhookContents(next).includes("ran it"), 15000);
  ownerMessage(workspace, "owner-2", "and summarize");
  const done = await waitForState(workspace, (next) => webhookContents(next).includes("Fallback answer."), 15000);

  const [permission] = agyEvents(workspace).filter((event) => event.event === "permission");
  assert.deepEqual(permission.answer, { outcome: { outcome: "selected", optionId: "always" } });
  assert.deepEqual(webhookContents(done), ["ran it", "Fallback answer."]);
});

test("a message sent while /compact runs waits for it, so two Gemini prompts never run at once", async () => {
  const workspace = await geminiSession({ compactDelayMs: 1500, turns: [{ reply: "after compact" }] });

  // The message lands while the bridge is still posting "Compaction started.".
  ownerMessage(workspace, "cmd-compact", "/compact");
  ownerMessage(workspace, "owner-1", "next task");
  const done = await waitForState(workspace, (next) => webhookContents(next).includes("after compact"), 15000);

  assert.deepEqual(overlaps(workspace), []);
  assert.deepEqual(promptTexts(workspace), ["/compact", "next task"]);
  assert.deepEqual(webhookContents(done), ["Compaction started.", "Compaction complete.", "after compact"]);
  assert.ok(botReactions(done).some(([id, emoji]) => id === "owner-1" && emoji === "⏳"));
});

test("a /clear whose running turn ignores the cancel stops the Gemini session instead of leaving it stuck", async () => {
  const workspace = geminiWorkspace();
  agyPlan(workspace, { sessionIds: [SESSION_ID, SECOND_SESSION_ID], turns: [{ holdUntilCancel: true, ignoreCancel: true }] });
  await routerWithWebhooks(workspace, ["demo"]);
  const started = await startGemini(workspace, [], { GEMINI_CANCEL_TIMEOUT_MS: "1000" });
  assert.equal(started.exitCode, 0, started.stderr || started.stdout);
  const pid = readRegistry(workspace).projects.demo.pid;

  ownerMessage(workspace, "owner-1", "long task");
  await waitForState(workspace, () => promptTexts(workspace).length === 1, 15000);
  ownerMessage(workspace, "cmd-clear", "/clear");
  const done = await waitForState(workspace, (next) => webhookContents(next).some((content) => content.startsWith("**Error:** Failed to clear")), 15000);

  assert.deepEqual(webhookContents(done), [
    "**Error:** Failed to clear — the running turn did not stop within 1 s of a cancel. The session is stopping; restart it.",
  ]);
  for (let i = 0; i < 100 && alive(pid); i++) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(alive(pid), false, "the bridge exited");
  assert.equal(clientRequests(workspace, "session/new").length, 1);
});

test("/restart waits for a slow-exiting agy before relaunching the Gemini project", async () => {
  const workspace = await geminiSession({ exitDelayMs: 4000 });
  const before = readRegistry(workspace).projects.demo.pid;
  const [firstAgy] = agyPids(workspace);

  ownerMessage(workspace, "cmd-restart", "/restart");
  const deadline = Date.now() + 30000;
  for (;;) {
    const after = readRegistry(workspace).projects.demo.pid;
    if (typeof after === "number" && after !== before && agyPids(workspace).length === 2) {
      const status = await runRouterCli(workspace, ["status"]);
      if (/sessions: 1\n  project demo scope=demo-channel connected=/.test(status.stdout)) break;
    }
    assert.ok(Date.now() < deadline, `demo never relaunched: ${JSON.stringify({ before, after, agy: agyPids(workspace) })}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  assert.equal(alive(firstAgy), false, "the first agy exited");
  assert.equal(alive(before), false, "the first bridge exited");
  const state = readState(workspace.stateDir);
  assert.deepEqual(webhookContents(state), ["Restarting session — fresh session coming up."]);
  assert.deepEqual(botReactions(state), [["cmd-restart", "🔄"]]);
});

test("stop-session takes the Gemini session's agy down too, found by its name and launch key", async () => {
  const workspace = await geminiSession({});
  const [agyPid] = agyPids(workspace);
  assert.ok(alive(agyPid));

  const stopped = await stopDemo(workspace);

  assert.equal(stopped.exitCode, 0, stopped.stderr || stopped.stdout);
  for (let i = 0; i < 50 && alive(agyPid); i++) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(alive(agyPid), false);
});

test("start-gemini-session --resume refuses while the project's session already runs", async () => {
  const workspace = await geminiSession({});

  const resumed = await startGemini(workspace, ["--resume", SESSION_ID]);

  assert.equal(resumed.exitCode, 1);
  assert.match(resumed.stderr, /Refusing to resume 'demo': session 'demo_gemini' is already running/);
  assert.equal(clientRequests(workspace, "session/resume").length, 0);
});

test("start-gemini-session refuses a gemini_effort agy has no level for, before launching", async () => {
  const workspace = geminiWorkspace({ gemini_effort: "max" });

  const started = await startGemini(workspace);

  assert.equal(started.exitCode, 1);
  assert.match(started.stderr, /Invalid gemini_effort 'max' for 'demo'/);
  assert.deepEqual(agyEvents(workspace), []);
});
