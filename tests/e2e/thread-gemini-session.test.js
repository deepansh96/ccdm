import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { injectDiscordMessage } from "./support/bridge.js";
import { runScript } from "./support/runner.js";
import { OWNER_ID, ROOT_TOKEN, createRouterWorkspace, routerRegistry, routerWithWebhooks, runRouterCli, waitFor } from "./support/router.js";
import { readState, updateState } from "./support/state.js";
import { cleanup } from "./support/teardown.js";
import { startThreadSupervisor, supervisorEnv, supervisorStateDir, supervisorStatus, waitForThreadIdle } from "./support/thread-supervisor.js";

test.afterEach(cleanup);

// A Gemini Thread Conversation end to end: the real Router, Thread
// Supervisor, start-thread-session.sh and gemini-bridge.js in thread mode,
// driving the fake agy over ACP. The project itself is a Claude project: a
// thread's provider is its own.
const THREAD_ID = "1700000000000765432";
const THREAD_TMUX = `demo_claude-t-${THREAD_ID}`;
const SESSION_ID = "2c3d4e5f-6a7b-4c8d-8e9f-1a2b3c4d5e6f";
const BOT_USER_ID = "fixture-bot-user-id";
// 262,144 of a 1,048,576-token window is 25%.
const QUARTER_USAGE = { used: 262144, size: 1048576 };

function threadWorkspace() {
  const workspace = createRouterWorkspace({ ...routerRegistry({
    demo: { channel_id: "demo-channel", type: "claude", transport: "router", guest_user_ids: ["guest-id"],
      screen_name: "demo_claude" },
  }), root_channels: ["root-channel"] });
  const registryFile = path.join(workspace.repoDir, "registry.json");
  const registry = JSON.parse(fs.readFileSync(registryFile, "utf8"));
  registry.projects.demo.path = workspace.tmpDir;
  fs.writeFileSync(registryFile, `${JSON.stringify(registry, null, 2)}\n`);
  return workspace;
}

function fakeAgyBin(workspace) {
  const bin = path.join(workspace.tmpRoot, "agy-bin", "agy");
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  // Named agy in ps, as the real binary is, so listener detection sees it.
  fs.writeFileSync(bin, `#!/bin/bash\nexec -a agy '${process.execPath}' '${path.join(workspace.repoDir, "tests/e2e/support/fake-agy.cjs")}' "$@"\n`);
  fs.chmodSync(bin, 0o755);
  return bin;
}

const agyPlan = (workspace, plan) => fs.writeFileSync(path.join(workspace.stateDir, "agy-plan.json"), `${JSON.stringify(plan)}\n`);

function agyEvents(workspace) {
  const file = path.join(workspace.stateDir, "agy.ndjson");
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
}

const clientRequests = (workspace, method) => agyEvents(workspace)
  .filter((event) => event.event === "client" && event.message.method === method).map((event) => event.message);
const promptTexts = (workspace) => clientRequests(workspace, "session/prompt")
  .map((message) => message.params.prompt.filter((block) => block.type === "text").map((block) => block.text).join("\n"));

async function supervised(workspace) {
  await routerWithWebhooks(workspace, ["demo"]);
  return startThreadSupervisor(workspace, { env: { CCDM_AGY_BIN: fakeAgyBin(workspace) } });
}

// A pending creation request the root bot's new thread binds to, as `/thread`
// stores one.
function requestThread(workspace, { provider = "gemini", model = null, effort = null } = {}) {
  const store = path.join(supervisorStateDir(workspace), "threads.sqlite3");
  execFileSync("python3", ["-c", `import sqlite3, sys
db = sqlite3.connect(sys.argv[1], timeout=5)
db.execute("""INSERT INTO creation_requests (request_id, project, name, provider, account, model, effort,
  first_message, requester_id, requester_kind, status, thread_id, created_at)
  VALUES ('request-1', 'demo', 'Fix flaky test', ?, NULL, ?, ?, NULL, ?, 'owner', 'pending', NULL,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))""", (sys.argv[2], sys.argv[3] or None, sys.argv[4] or None, sys.argv[5]))
db.commit()`, store, provider, model ?? "", effort ?? "", OWNER_ID]);
  updateState(workspace.stateDir, (state) => {
    (state.fixtures.discord.injectedThreads ||= []).push({ id: THREAD_ID, type: 11, parentId: "demo-channel",
      name: "Fix flaky test", ownerId: BOT_USER_ID, autoArchiveDuration: 10080, event: "create" });
  });
}

const threadMessage = (workspace, id, content, author = { id: OWNER_ID, username: "Owner" }) =>
  injectDiscordMessage(workspace, { id, channelId: THREAD_ID, content, author });

async function threadRow(workspace, predicate = () => true, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await supervisorStatus(workspace);
    const row = last.projects?.demo?.threads?.[THREAD_ID];
    if (row && predicate(row)) return row;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`thread ${THREAD_ID} never matched: ${JSON.stringify(last)}`);
}

const discord = (workspace) => readState(workspace.stateDir).fixtures.discord;
const threadPosts = (workspace) => (discord(workspace).messages ?? []).filter((message) => message.channelId === THREAD_ID);
const webhookPosts = (workspace) => threadPosts(workspace).filter((message) => message.webhookId);

test("an owner message in a Gemini thread of a Claude project boots a Gemini bridge whose first turn is the bootstrap", async () => {
  const workspace = threadWorkspace();
  updateState(workspace.stateDir, (state) => {
    state.fixtures.discord.history = { "demo-channel": [{ id: THREAD_ID, content: "The parser drops trailing commas",
      author: { id: OWNER_ID, username: "Owner" } }] };
  });
  agyPlan(workspace, { sessionIds: [SESSION_ID], turns: [{ usage: QUARTER_USAGE, reply: "on it" }, { reply: "all done" }] });
  await supervised(workspace);
  requestThread(workspace, { model: "gemini-4-argon", effort: "medium" });
  await threadRow(workspace, (row) => row.provider === "gemini");

  threadMessage(workspace, "boot-message-1", "please fix the parser");
  threadMessage(workspace, "boot-message-2", "and add a regression test", { id: "guest-id", username: "Guest" });
  await threadRow(workspace, (row) => row.state === "live");
  await waitFor(() => webhookPosts(workspace).length === 1, () => `the bootstrap reply: ${JSON.stringify(promptTexts(workspace))}`, 20000);

  const [bootstrap] = promptTexts(workspace);
  assert.match(bootstrap, new RegExp(THREAD_ID));
  assert.match(bootstrap, /Fix flaky test/);
  for (const text of ["The parser drops trailing commas", "please fix the parser", "and add a regression test"]) {
    assert.equal(bootstrap.split(text).length - 1, 1, `${text} in ${bootstrap}`);
  }
  // The thread's overrides chose agy's model and thinking level.
  assert.deepEqual(clientRequests(workspace, "session/set_config_option").map((message) => [message.params.configId, message.params.value]),
    [["model", "gemini-4-argon"], ["thought_level", "medium"]]);
  const [created] = clientRequests(workspace, "session/new");
  assert.deepEqual(created.params.mcpServers.map((server) => server.name), [`discord-${THREAD_ID}`]);
  const mcpEnv = Object.fromEntries(created.params.mcpServers[0].env.map(({ name, value }) => [name, value]));
  assert.equal(mcpEnv.CCDM_THREAD_ID, THREAD_ID);
  assert.equal(mcpEnv.CCDM_THREAD_PROVIDER, "gemini");
  assert.equal(mcpEnv.CCDM_ROUTER_KEY_FILE, path.join(workspace.routerStateDir, "keys", `.thread-${THREAD_ID}.key`));
  assert.equal(created.params.cwd, workspace.tmpDir);

  await waitForThreadIdle(workspace, "demo", THREAD_ID);
  threadMessage(workspace, "live-message-1", "how is it going?");
  await waitFor(() => webhookPosts(workspace).length === 2, () => "the live reply", 20000);

  assert.equal(promptTexts(workspace)[1], "how is it going?");
  assert.deepEqual(webhookPosts(workspace).map(({ channelId, content, username }) => ({ channelId, content, username })), [
    { channelId: THREAD_ID, content: "on it", username: "demo-gemini · 25%" },
    { channelId: THREAD_ID, content: "all done", username: "demo-gemini · 25%" },
  ]);
  // The parent channel heard nothing of it.
  assert.deepEqual((discord(workspace).messages ?? []).filter((message) => message.channelId !== THREAD_ID), []);

  const row = await threadRow(workspace, (current) => current.provider_conversation_id != null);
  assert.equal(row.provider_conversation_id, SESSION_ID);
  assert.equal(row.ws_port, null);
  const status = await runRouterCli(workspace, ["status"]);
  assert.match(status.stdout, new RegExp(`thread demo thread=${THREAD_ID} provider=gemini connected=`));

  const state = readState(workspace.stateDir);
  const session = state.fixtures.tmux.sessions[THREAD_TMUX];
  assert.ok(session, JSON.stringify(Object.keys(state.fixtures.tmux.sessions)));
  assert.deepEqual(session.command.slice(0, 5), ["env", "DISABLE_AUTO_UPDATE=true", "DISABLE_UPDATE_PROMPT=true", "zsh", "-ic"]);
  const launchDir = path.join(workspace.routerStateDir, "launches", "demo", "threads", THREAD_ID);
  const surfaces = [JSON.stringify(session), JSON.stringify(created),
    ...fs.readdirSync(launchDir).map((file) => fs.readFileSync(path.join(launchDir, file), "utf8"))];
  for (const text of surfaces) {
    for (const secret of [ROOT_TOKEN, "pool-bot-token", "fake-webhook-token", "DISCORD_BOT_TOKEN"]) {
      assert.equal(text.includes(secret), false, `${secret} leaked into ${text.slice(0, 200)}`);
    }
  }
});

test("a stopped Gemini thread resumes its agy session on the next owner message", async () => {
  const workspace = threadWorkspace();
  agyPlan(workspace, { sessionIds: [SESSION_ID], turns: [{ reply: "first" }, { reply: "resumed" }] });
  await supervised(workspace);
  requestThread(workspace);
  await threadRow(workspace, (row) => row.provider === "gemini");
  threadMessage(workspace, "boot-message-1", "start");
  await waitFor(() => webhookPosts(workspace).length === 1, () => "the first reply", 20000);
  await threadRow(workspace, (row) => row.provider_conversation_id === SESSION_ID);
  await waitForThreadIdle(workspace, "demo", THREAD_ID);

  const stopped = await runScript(workspace, "scripts/threads.sh", { args: ["stop", THREAD_ID], env: supervisorEnv(workspace) });
  assert.equal(stopped.exitCode, 0, stopped.stderr || stopped.stdout);
  await threadRow(workspace, (row) => row.state === "stopped");
  threadMessage(workspace, "after-stop-1", "carry on");
  await waitFor(() => webhookPosts(workspace).length === 2, () => "the resumed reply", 20000);

  assert.deepEqual(clientRequests(workspace, "session/resume").map((message) => message.params.sessionId), [SESSION_ID]);
  assert.equal(clientRequests(workspace, "session/new").length, 1);
  assert.deepEqual(webhookPosts(workspace).map((message) => message.content), ["first", "resumed"]);
});

test("threads.sh create refuses Gemini account aliases and Claude-only efforts, creating nothing", async () => {
  const workspace = threadWorkspace();
  await supervised(workspace);

  const withAccount = await runScript(workspace, "scripts/threads.sh",
    { args: ["create", "demo", "side task", "--provider", "gemini", "--account", "work"], env: supervisorEnv(workspace) });
  const withEffort = await runScript(workspace, "scripts/threads.sh",
    { args: ["create", "demo", "side task", "--provider", "gemini", "--effort", "max"], env: supervisorEnv(workspace) });

  assert.equal(withAccount.exitCode, 2, withAccount.stderr || withAccount.stdout);
  assert.match(withAccount.stderr + withAccount.stdout, /'work' is not an account alias in gemini_accounts/);
  assert.equal(withEffort.exitCode, 2, withEffort.stderr || withEffort.stdout);
  assert.match(withEffort.stderr + withEffort.stdout, /effort 'max' is not valid for gemini \(expected low, medium, high, xhigh\)/);
  assert.deepEqual(discord(workspace).threadCreates ?? [], []);
});

test("a restarted Gemini thread sends no turn of its own: its preamble rides along with the next owner message", async () => {
  const workspace = threadWorkspace();
  agyPlan(workspace, { sessionIds: [SESSION_ID], turns: [{ reply: "first" }, { reply: "second" }] });
  await supervised(workspace);
  requestThread(workspace);
  await threadRow(workspace, (row) => row.provider === "gemini");
  threadMessage(workspace, "boot-message-1", "start");
  await waitFor(() => webhookPosts(workspace).length === 1, () => "the first reply", 20000);
  await threadRow(workspace, (row) => row.provider_conversation_id === SESSION_ID);
  await waitForThreadIdle(workspace, "demo", THREAD_ID);

  const restarted = await runScript(workspace, "scripts/threads.sh", { args: ["restart", THREAD_ID], env: supervisorEnv(workspace) });
  assert.equal(restarted.exitCode, 0, restarted.stderr || restarted.stdout);
  await waitFor(() => clientRequests(workspace, "session/resume").length === 1, () => "the resumed session", 20000);
  await threadRow(workspace, (row) => row.state === "live", 20000);
  await new Promise((resolve) => setTimeout(resolve, 1000));
  assert.equal(promptTexts(workspace).length, 1, JSON.stringify(promptTexts(workspace)));

  threadMessage(workspace, "after-restart-1", "carry on");
  await waitFor(() => webhookPosts(workspace).length === 2, () => "the reply after the restart", 20000);
  const [preamble, message] = clientRequests(workspace, "session/prompt")[1].params.prompt.map((block) => block.text);
  assert.match(preamble, new RegExp(`serving the Discord thread "Fix flaky test" \\(thread ${THREAD_ID}\\)`));
  assert.equal(message, "carry on");
  assert.deepEqual(webhookPosts(workspace).map((post) => post.content), ["first", "second"]);
});

test("a project's plain model goes only to threads of its own provider, and /model shows a Gemini model's own level", () => {
  const scripts = path.resolve("scripts");
  const out = execFileSync("python3", ["-c", `import json, sys
sys.path.insert(0, sys.argv[1])
from thread_supervisor import config, model_info, registry
none = dict.fromkeys(("provider", "account", "model", "effort"))
gemini_project = {"type": "gemini", "model": "gemini-4-argon"}
print(json.dumps({
  "claude_under_gemini": registry.resolved_settings(gemini_project, {**none, "provider": "claude"})["model"],
  "codex_under_gemini": registry.resolved_settings(gemini_project, {**none, "provider": "codex"})["model"],
  "gemini_under_gemini": registry.resolved_settings(gemini_project, none)["model"],
  "gemini_under_claude": registry.resolved_settings({"type": "claude", "model": "opus"}, {**none, "provider": "gemini"})["model"],
  "claude_under_claude": registry.resolved_settings({"type": "claude", "model": "opus"}, none)["model"],
  "suffixed": model_info.describe({}, "demo", {"type": "gemini", "gemini_model": "gemini-3.8-flash-low"}),
  "plain": model_info.describe({}, "demo", {"type": "gemini", "gemini_model": "gemini-4-argon"}),
  "default": model_info.describe({}, "demo", {"type": "gemini"}),
  "accounts": registry.accounts({"gemini_accounts": {"x": "~/.x"}}, "gemini"),
  "switch": config.provider_reset({"provider": None, "account": "work", "model": "opus", "effort": "max"},
                                  {"type": "claude"}, {"provider": "gemini"}),
  "same": config.provider_reset({"provider": None, "account": "work", "model": None, "effort": None},
                                {"type": "claude"}, {"provider": "claude", "effort": "low"}),
}))`, scripts], { encoding: "utf8" });
  const result = JSON.parse(out);

  assert.deepEqual([result.claude_under_gemini, result.codex_under_gemini, result.gemini_under_gemini,
    result.gemini_under_claude, result.claude_under_claude], [null, null, "gemini-4-argon", null, "opus"]);
  assert.deepEqual([result.suffixed.effort, result.suffixed.effort_source], ["low", "bridge default"]);
  assert.deepEqual([result.plain.effort, result.plain.effort_source], [null, null]);
  assert.deepEqual([result.default.model, result.default.effort], ["gemini-4-neon", "high"]);
  assert.deepEqual(result.accounts, {});
  assert.deepEqual(result.switch, { account: null, model: null, effort: null, provider: "gemini" });
  assert.deepEqual(result.same, { provider: "claude", effort: "low" });
});
