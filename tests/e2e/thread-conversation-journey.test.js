import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { injectDiscordMessage } from "./support/bridge.js";
import { OWNER_ID, ROOT_TOKEN, createRouterWorkspace, routerEnv, routerWithWebhooks, waitFor } from "./support/router.js";
import { runScript } from "./support/runner.js";
import { readState, updateState } from "./support/state.js";
import { cleanup } from "./support/teardown.js";
import { startThreadSupervisor, supervisorStatus } from "./support/thread-supervisor.js";

test.afterEach(cleanup);

// The owner's whole Thread Conversation journey across components: the real
// Router, Thread Supervisor, start-thread-session.sh with the CCDM channel
// server and the fixture claude and tmux, and the Conversation Reminder
// service. Only Discord messages, thread events and the reminder clock go in.
const THREAD_ID = "1700000000000556677";
// `<screen>-t-<thread id>`.
const THREAD_TMUX = `demo_claude-t-${THREAD_ID}`;
const ROOT_AUTH = `Bot ${ROOT_TOKEN}`;
const owner = { id: OWNER_ID, username: "Owner" };

function journeyWorkspace() {
  const workspace = createRouterWorkspace({
    discord_user_id: OWNER_ID, guild_id: "guild-id",
    projects: { demo: { channel_id: "demo-channel", type: "claude", transport: "router",
      screen_name: "demo_claude", assignment_generation: "gen-demo" } },
  });
  const registryFile = path.join(workspace.repoDir, "registry.json");
  const registry = JSON.parse(fs.readFileSync(registryFile, "utf8"));
  registry.projects.demo.path = workspace.tmpDir;
  fs.writeFileSync(registryFile, `${JSON.stringify(registry, null, 2)}\n`);
  const clockFile = path.join(workspace.tmpDir, "reminder-clock");
  const now = Date.now();
  return {
    workspace,
    stateDir: path.join(workspace.homeDir, ".local", "state", "ccdm", "conversation-reminders"),
    // Minutes past the test's start, on the reminder service's clock.
    setClock: minutes => fs.writeFileSync(clockFile,
      new Date(now + minutes * 60000).toISOString().replace(/\.\d{3}Z$/, "Z")),
    env: { CCDM_REMINDER_NODE: process.execPath, CCDM_REMINDER_CLOCK_FILE: clockFile },
  };
}

async function reminderService(context, name) {
  const result = await runScript(context.workspace, "scripts/conversation-reminder-service.py", {
    args: [name, "--project-root", context.workspace.repoDir, "--state-dir", context.stateDir],
    env: routerEnv(context.workspace, context.env),
  });
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

// Claude answers every notification, naming the message it answers.
const ANSWER = [{ name: "reply", arguments: { chat_id: "{{chat_id}}", text: "Here is the answer",
  conversation_interaction_id: "{{message_id}}", conversation_disposition: "progress" } }];

// The Router with demo's webhook, demo's channel session (its adapter
// readiness gates the project's reminders), the supervisor, and the running
// reminder worker, ready for demo.
async function journeyServices(context) {
  const { workspace } = context;
  updateState(workspace.stateDir, state => {
    state.fixtures.discord.history = { "demo-channel": [] };
    state.fixtures.claude.toolScript = ANSWER;
  });
  await routerWithWebhooks(workspace, ["demo"]);
  const started = await runScript(workspace, "scripts/start-session.sh", {
    args: ["demo"], env: routerEnv(workspace), timeoutMs: 30000,
  });
  assert.equal(started.exitCode, 0, started.stderr || started.stdout);
  await startThreadSupervisor(workspace);
  await reminderService(context, "enable");
  context.setClock(0);
  const running = runScript(workspace, "scripts/conversation-reminder-service.py", {
    args: ["run", "--project-root", workspace.repoDir, "--state-dir", context.stateDir],
    env: routerEnv(workspace, context.env), timeoutMs: 120000,
  });
  const deadline = Date.now() + 20000;
  while ((await reminderService(context, "status")).conversations.demo?.reconciliation_status !== "ready") {
    if (Date.now() > deadline) throw new Error("demo never became ready for reminders");
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return async () => {
    await reminderService(context, "disable");
    const stopped = await running;
    assert.equal(stopped.exitCode, 0, stopped.stderr || stopped.stdout);
  };
}

async function threadRow(workspace, predicate = () => true, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await supervisorStatus(workspace);
    const row = last.projects?.demo?.threads?.[THREAD_ID];
    if (row && predicate(row)) return row;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`thread ${THREAD_ID} never matched: ${JSON.stringify(last)}`);
}

async function reminderRow(context, predicate, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = (await reminderService(context, "status")).conversations.demo?.threads?.[THREAD_ID];
    if (last && predicate(last)) return last;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`thread ${THREAD_ID}'s reminder state never matched: ${JSON.stringify(last)}`);
}

// Claude keeps a conversation's transcript at
// <home>/projects/<cwd, each non-alphanumeric character as "-">/<id>.jsonl.
function writeClaudeTranscript(workspace, sessionId) {
  const dir = path.join(workspace.homeDir, ".claude", "projects", workspace.tmpDir.replace(/[^A-Za-z0-9]/g, "-"));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), "{}\n");
}

const discord = workspace => readState(workspace.stateDir).fixtures.discord;
const claude = workspace => readState(workspace.stateDir).fixtures.claude;
const posts = (workspace, channelId) => (discord(workspace).messages ?? [])
  .filter(message => message.channelId === channelId);
const eyes = (workspace, channelId) => posts(workspace, channelId).filter(message => message.content === "👀");
const agentReplies = (workspace, channelId) => posts(workspace, channelId)
  .filter(message => message.webhookId === "fake-webhook-1");
const stopHooks = workspace => (claude(workspace).hookRuns ?? []).filter(run => run.event === "Stop").length;
const settle = () => new Promise(resolve => setTimeout(resolve, 1500));
// Thread sessions, not the channel's, run with the thread's own key.
const threadInvocations = workspace => claude(workspace).invocations
  .filter(invocation => invocation.env.CCDM_ROUTER_KEY_FILE?.endsWith(`/.thread-${THREAD_ID}.key`));
const resumeArgs = invocation => {
  const index = invocation.args.indexOf("--resume");
  return index < 0 ? null : invocation.args[index + 1].replace(/^'|'$/g, "");
};

test("the owner's thread journey: reply, reminder, acknowledgment, /close, and reopening the same conversation", async () => {
  const context = journeyWorkspace();
  const { workspace } = context;
  const stop = await journeyServices(context);

  // 1. The owner creates a thread by hand, and a Claude thread session replies in it.
  updateState(workspace.stateDir, state => {
    (state.fixtures.discord.injectedThreads ||= []).push({ id: THREAD_ID, type: 11, parentId: "demo-channel",
      name: "Fix flaky test", ownerId: OWNER_ID, autoArchiveDuration: 10080, event: "create" });
  });
  await threadRow(workspace);
  injectDiscordMessage(workspace, { id: "journey-question", channelId: THREAD_ID, author: owner,
    content: "please fix the parser" });
  await waitFor(() => agentReplies(workspace, THREAD_ID).length === 1, () => "the thread session's reply", 20000);
  const [reply] = agentReplies(workspace, THREAD_ID);
  assert.deepEqual([reply.content, reply.username], ["Here is the answer", "demo-claude"]);
  assert.deepEqual(agentReplies(workspace, "demo-channel"), []);
  const live = await threadRow(workspace, row => row.state === "live" && row.provider_conversation_id != null);
  const conversationId = live.provider_conversation_id;
  assert.ok(readState(workspace.stateDir).fixtures.tmux.sessions[THREAD_TMUX], "the thread's tmux session runs");

  // 2. Once the turn ends, the reminder fires in the thread after the hour, never in the channel.
  await waitFor(() => stopHooks(workspace) >= 1, () => "the Stop hook", 10000);
  await settle();
  context.setClock(61);
  await waitFor(() => eyes(workspace, THREAD_ID).length === 1, () => "the thread's reminder", 20000);
  assert.equal(eyes(workspace, THREAD_ID)[0].authorization, ROOT_AUTH);
  assert.deepEqual(eyes(workspace, "demo-channel"), []);

  // 3. The owner's reply acknowledges it: no further reminder, even a day later.
  updateState(workspace.stateDir, state => {
    delete state.fixtures.claude.toolScript;
  });
  injectDiscordMessage(workspace, { id: "journey-ack", channelId: THREAD_ID, author: owner, content: "thanks" });
  const acknowledged = await reminderRow(context, row => row.last_ack_message_id === "journey-ack");
  assert.equal(acknowledged.state, "open-paused");
  context.setClock(61 + 24 * 60);
  await settle();
  await settle();
  assert.equal(eyes(workspace, THREAD_ID).length, 1);

  // 4. /close archives the thread as root, closes its reminders and stops its session.
  injectDiscordMessage(workspace, { id: "journey-close", channelId: THREAD_ID, author: owner, content: "/close" });
  const closed = await threadRow(workspace, row => row.state === "closed");
  assert.equal(closed.close_reason, "close-command");
  assert.deepEqual((discord(workspace).threadPatches ?? []).filter(patch => "archived" in patch.body)
    .map(({ authorization, body, threadId }) => ({ authorization, body, threadId })),
  [{ authorization: ROOT_AUTH, body: { archived: true }, threadId: THREAD_ID }]);
  await reminderRow(context, row => row.state === "closed");
  await waitFor(() => readState(workspace.stateDir).fixtures.tmux.sessions[THREAD_TMUX] === undefined,
    () => "the thread's tmux session to stop", 15000);
  assert.equal(threadInvocations(workspace).length, 1);

  // 5. The owner's next message reopens it and resumes the same Claude conversation.
  writeClaudeTranscript(workspace, conversationId);
  updateState(workspace.stateDir, state => {
    state.fixtures.claude.toolScript = ANSWER;
  });
  injectDiscordMessage(workspace, { id: "journey-reopen", channelId: THREAD_ID, author: owner,
    content: "one more thing" });
  const reopened = await threadRow(workspace, row => row.state === "live");
  assert.equal(reopened.provider_conversation_id, conversationId);
  await waitFor(() => agentReplies(workspace, THREAD_ID).length === 2, () => "the reopened session's reply", 20000);
  assert.deepEqual(threadInvocations(workspace).map(resumeArgs), [null, conversationId]);
  assert.match(claude(workspace).channelNotifications.at(-1).content, /one more thing/);
  await reminderRow(context, row => row.state !== "closed");
  assert.deepEqual(agentReplies(workspace, "demo-channel"), []);
  await stop();
});
