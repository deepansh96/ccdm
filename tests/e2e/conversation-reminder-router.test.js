import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";

import { injectDiscordMessage, injectDiscordReaction, startFakeCodexServer, waitForState } from "./support/bridge.js";
import { runScript } from "./support/runner.js";
import {
  OWNER_ID,
  ROOT_TOKEN,
  connectSession,
  createRouterWorkspace,
  routerEnv,
  routerWithWebhooks,
  waitFor,
} from "./support/router.js";
import { readState, writeState } from "./support/state.js";
import { cleanup, registerTeardownCallback } from "./support/teardown.js";

test.afterEach(async () => {
  await cleanup();
});

// Conversation Reminders for router-transport Codex projects: the real Router,
// the real reminder service and its observer as a read-only Router client, and
// the fake Discord. `ensure-webhook` gives demo `fake-webhook-1` and beta
// `fake-webhook-2`. No pool bot exists, so nothing but root can send.
function reminderRouterWorkspace() {
  const workspace = createRouterWorkspace({
    discord_user_id: OWNER_ID,
    guild_id: "guild-id",
    projects: {
      demo: { channel_id: "demo-channel", type: "codex", transport: "router", screen_name: "demo_codex",
        assignment_generation: "gen-demo", session_id: null, pid: null },
      beta: { channel_id: "beta-channel", type: "codex", transport: "router", screen_name: "beta_codex",
        assignment_generation: "gen-beta" },
    },
  });
  const registryFile = path.join(workspace.repoDir, "registry.json");
  const registry = JSON.parse(fs.readFileSync(registryFile, "utf8"));
  registry.projects.demo.path = workspace.tmpDir;
  registry.projects.beta.path = workspace.tmpDir;
  fs.writeFileSync(registryFile, `${JSON.stringify(registry, null, 2)}\n`);
  fs.mkdirSync(path.join(workspace.homeDir, ".codex"), { recursive: true });
  const clockFile = path.join(workspace.tmpDir, "reminder-clock");
  return {
    workspace,
    stateDir: path.join(workspace.homeDir, ".local", "state", "ccdm", "conversation-reminders"),
    setClock: (value) => fs.writeFileSync(clockFile, value),
    env: { CCDM_REMINDER_NODE: process.execPath, CCDM_REMINDER_CLOCK_FILE: clockFile },
  };
}

async function service(context, name, extra = {}) {
  const result = await runScript(context.workspace, "scripts/conversation-reminder-service.py", {
    args: [name, "--project-root", context.workspace.repoDir, "--state-dir", context.stateDir],
    env: routerEnv(context.workspace, context.env), ...extra,
  });
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function startWorker(context) {
  const running = runScript(context.workspace, "scripts/conversation-reminder-service.py", {
    args: ["run", "--project-root", context.workspace.repoDir, "--state-dir", context.stateDir],
    env: routerEnv(context.workspace, context.env),
    timeoutMs: 60000,
  });
  return running;
}

async function waitForStatus(context, predicate, attempts = 400) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const current = await service(context, "status");
    if (predicate(current)) return current;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for status: ${JSON.stringify(await service(context, "status"))}`);
}

async function stopWorker(context, running) {
  await service(context, "disable");
  const result = await running;
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
}

function historyMessage(id, timestamp, author, content, extra = {}) {
  return { id, timestamp, content, type: 0, attachments: [], author, ...extra };
}

const owner = { id: OWNER_ID, username: "Owner" };
const reminders = (state) => (state.fixtures.discord.messages ?? []).filter((row) => row.content === "👀");
const turnStarts = (codex) => codex.clientMessages.filter((message) => message.method === "turn/start" &&
  !message.params?.input?.[0]?.text?.startsWith("You are communicating with the user via Discord"));

// The observer's key lives beside the others under a name no project can take.
function writeObserverKey(workspace, key) {
  const keysDir = path.join(workspace.routerStateDir, "keys");
  fs.mkdirSync(keysDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(keysDir, ".observer.key"), `${key}\n`, { mode: 0o600 });
}

async function connectObserver(workspace, key) {
  const { RouterClient } = createRequire(import.meta.url)(path.join(workspace.repoDir, "scripts/router/client.js"));
  const client = new RouterClient({ socketPath: workspace.socketPath, key, role: "observer" });
  const events = [];
  client.on("event", (event) => events.push(event));
  const scope = await client.connect();
  registerTeardownCallback(() => client.close());
  return { client, events, scope };
}

test("the observer role receives every project-channel event, /close reaches only it, and it cannot write", async () => {
  const { workspace } = reminderRouterWorkspace();
  await routerWithWebhooks(workspace, ["demo", "beta"]);
  writeObserverKey(workspace, "observer-key");
  const observer = await connectObserver(workspace, "observer-key");
  const session = await connectSession(workspace, "demo", "demo-key");
  assert.equal(observer.scope.project, "observer");

  injectDiscordMessage(workspace, { id: "owner-1", channelId: "demo-channel", author: owner, content: "hello" });
  injectDiscordMessage(workspace, { id: "agent-1", channelId: "demo-channel", content: "answer",
    webhookId: "fake-webhook-1", author: { id: "fake-webhook-1", bot: true, username: "demo-codex" } });
  injectDiscordMessage(workspace, { id: "close-1", channelId: "demo-channel", author: owner, content: " /close " });
  injectDiscordReaction(workspace, { id: "reaction-1", channelId: "demo-channel", emoji: "👍", messageId: "agent-1",
    user: owner, message: { author: { bot: true, id: "fake-webhook-1" }, webhookId: "fake-webhook-1", content: "answer" } });

  await waitFor(() => observer.events.length >= 4, () => `observer events: ${JSON.stringify(observer.events)}`, 10000);
  const seen = observer.events.map((event) => [event.event, event.message_id, event.channel_id]);
  assert.deepEqual(seen, [
    ["message", "owner-1", "demo-channel"],
    ["message", "agent-1", "demo-channel"],
    ["message", "close-1", "demo-channel"],
    ["reaction", "agent-1", "demo-channel"],
  ]);
  assert.equal(observer.events[1].webhook_id, "fake-webhook-1");
  assert.equal(observer.events[0].author.id, OWNER_ID);
  assert.equal(observer.events[3].user.id, OWNER_ID);
  // The session sees the owner's message and reaction, never the /close or its own reply.
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepEqual(session.events.map((event) => [event.event, event.message_id]),
    [["message", "owner-1"], ["reaction", "agent-1"]]);

  const before = readState(workspace.stateDir).fixtures.discord;
  for (const [op, args] of [
    ["reply", { channel_id: "demo-channel", text: "sneaky" }],
    ["react", { channel_id: "demo-channel", message_id: "owner-1", emoji: "👀" }],
  ]) {
    await assert.rejects(observer.client.request(op, args), (error) => error.code === "forbidden", op);
  }
  const after = readState(workspace.stateDir).fixtures.discord;
  assert.deepEqual(after.messages ?? [], before.messages ?? []);
  assert.deepEqual(after.reactions ?? [], before.reactions ?? []);
});

test("an observer with the wrong key is refused", async () => {
  const { workspace } = reminderRouterWorkspace();
  await routerWithWebhooks(workspace, ["demo"]);
  writeObserverKey(workspace, "observer-key");
  await assert.rejects(connectObserver(workspace, "wrong-key"), (error) => error.code === "unauthorized");
});

test("history detects a router agent reply only by the project's own webhook_id", async () => {
  const context = reminderRouterWorkspace();
  const { workspace } = context;
  await routerWithWebhooks(workspace, ["demo", "beta"]);
  const state = readState(workspace.stateDir);
  state.fixtures.discord.history = {
    // Another project's webhook message and a bot message without a webhook are not answers.
    "demo-channel": [
      historyMessage("d3", "2026-09-20T08:05:00Z", { id: "fake-webhook-2", bot: true }, "beta answer",
        { webhook_id: "fake-webhook-2" }),
      historyMessage("d2", "2026-09-20T08:04:00Z", { id: "stray-bot", bot: true }, "some bot"),
      historyMessage("d1", "2026-09-20T08:00:00Z", { id: OWNER_ID }, "Question?"),
    ],
    "beta-channel": [
      historyMessage("b2", "2026-09-20T08:05:00Z", { id: "fake-webhook-2", bot: true }, "Answer",
        { webhook_id: "fake-webhook-2" }),
      historyMessage("b1", "2026-09-20T08:00:00Z", { id: OWNER_ID }, "Question?"),
    ],
  };
  writeState(state, workspace.stateDir);
  await service(context, "enable");
  context.setClock("2026-09-20T08:30:00Z");
  const running = startWorker(context);
  const ready = await waitForStatus(context, (current) => ["demo", "beta"].every((name) =>
    current.conversations[name]?.reconciliation_status === "ready"));
  assert.deepEqual([ready.conversations.demo.state, ready.conversations.demo.discovery.basis],
    ["open-paused", "no-answer-after-reply"]);
  assert.deepEqual([ready.conversations.beta.state, ready.conversations.beta.response_message_id],
    ["awaiting-owner", "b2"]);
  assert.equal(ready.conversations.beta.identity, "router:fake-webhook-2");
  assert.equal(ready.conversations.demo.identity, "router:fake-webhook-1");

  context.setClock("2026-09-20T09:05:00Z");
  const sent = await waitForState(workspace, (next) => reminders(next).length === 1, 20000);
  assert.deepEqual(reminders(sent).map((row) => [row.channelId, row.authorization]),
    [["beta-channel", `Bot ${ROOT_TOKEN}`]]);
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(reminders(readState(workspace.stateDir)).length, 1);
  await stopWorker(context, running);
});

test("a router Codex reply is reminded as root with a nonce, deduped, cleared by the owner, and closed without a turn", async () => {
  const context = reminderRouterWorkspace();
  const { workspace } = context;
  const codex = await startFakeCodexServer(workspace, {
    channelId: "demo-channel",
    turns: [
      { turnId: "answer-turn", status: "completed", mcpReplyText: "Here is the answer", delayMs: 50 },
      // The owner's reply starts a turn that keeps working without answering.
      { turnId: "reply-turn", waitForRelease: true },
    ],
  });
  const registryFile = path.join(workspace.repoDir, "registry.json");
  const registry = JSON.parse(fs.readFileSync(registryFile, "utf8"));
  registry.projects.demo.ws_port = codex.port;
  fs.writeFileSync(registryFile, `${JSON.stringify(registry, null, 2)}\n`);
  const seed = readState(workspace.stateDir);
  seed.fixtures.discord.history = { "demo-channel": [], "beta-channel": [] };
  writeState(seed, workspace.stateDir);
  await routerWithWebhooks(workspace, ["demo", "beta"]);
  const started = await runScript(workspace, "scripts/start-codex-session.sh", {
    args: ["demo"], env: routerEnv(workspace), timeoutMs: 30000,
  });
  assert.equal(started.exitCode, 0, started.stderr || started.stdout);

  const now = Date.now();
  const at = (offset) => new Date(now + offset).toISOString().replace(/\.\d{3}Z$/, "Z");
  await service(context, "enable");
  context.setClock(at(0));
  const running = startWorker(context);
  await waitForStatus(context, (current) => current.conversations.demo?.reconciliation_status === "ready");

  injectDiscordMessage(workspace, { id: "question-1", channelId: "demo-channel", author: owner, content: "answer this" });
  const answered = await waitForStatus(context, (current) => current.conversations.demo.state === "awaiting-owner");
  const answer = readState(workspace.stateDir).fixtures.discord.messages.find((row) => row.webhookId === "fake-webhook-1");
  assert.equal(answer.content, "Here is the answer");
  assert.equal(answered.conversations.demo.response_message_id, answer.id);
  assert.equal(answered.conversations.demo.identity, "router:fake-webhook-1");
  assert.deepEqual(reminders(readState(workspace.stateDir)), []);

  // An hour of owner silence: root posts 👀 with an enforced nonce.
  context.setClock(at(61 * 60000));
  const first = await waitForStatus(context, (current) => current.conversations.demo.reminder_message_id);
  const [reminder, ...others] = reminders(readState(workspace.stateDir));
  assert.deepEqual(others, []);
  assert.equal(first.conversations.demo.reminder_message_id, reminder.id);
  assert.deepEqual([reminder.channelId, reminder.authorization, reminder.requestBody.enforce_nonce],
    ["demo-channel", `Bot ${ROOT_TOKEN}`, true]);
  assert.equal(typeof reminder.requestBody.nonce, "string");

  // A lost response is retried with the same nonce; Discord returns the created reminder.
  const lose = readState(workspace.stateDir);
  lose.fixtures.discord.restLoseResponse = true;
  writeState(lose, workspace.stateDir);
  context.setClock(at(3 * 3600000 + 61 * 60000));
  const replaced = await waitForStatus(context, (current) => current.conversations.demo.reminder_message_id &&
    current.conversations.demo.reminder_message_id !== reminder.id && current.conversations.demo.cleanup_message_ids.length === 0);
  const deduped = readState(workspace.stateDir);
  const discord = deduped.fixtures.discord;
  assert.equal(discord.lostResponseUses, 1);
  assert.equal(reminders(deduped).length, 2, "the retry returned the created reminder instead of posting another");
  assert.equal(discord.reminderRequests.filter((row) => row.method === "POST").length, 3);
  assert.deepEqual(discord.deletes.map((row) => [row.messageId, row.authorization]), [[reminder.id, `Bot ${ROOT_TOKEN}`]]);
  assert.equal(replaced.conversations.demo.consecutive_reminders, 2);

  // The owner's reply clears the reminder.
  const second = replaced.conversations.demo.reminder_message_id;
  injectDiscordMessage(workspace, { id: "reply-1", channelId: "demo-channel", author: owner, content: "thanks, go on" });
  const cleared = await waitForStatus(context, (current) => current.conversations.demo.state === "open-paused" &&
    current.conversations.demo.cleanup_message_ids.length === 0 && !current.conversations.demo.reminder_message_id);
  assert.equal(cleared.conversations.demo.last_ack_message_id, "reply-1");
  await waitForState(workspace, (next) => next.fixtures.discord.deletes.some((row) => row.messageId === second));
  const turnsBeforeClose = turnStarts(codex).length;

  // /close reaches the reminder service only; Codex starts no turn.
  injectDiscordMessage(workspace, { id: "close-1", channelId: "demo-channel", author: owner, content: "/close" });
  await waitForStatus(context, (current) => current.conversations.demo.state === "closed");
  const acknowledged = await waitForState(workspace, (next) =>
    (next.fixtures.discord.reactions ?? []).some((row) => row.messageId === "close-1"));
  const check = acknowledged.fixtures.discord.reactions.find((row) => row.messageId === "close-1");
  assert.deepEqual([decodeURIComponent(check.emoji), check.authorization], ["✅", `Bot ${ROOT_TOKEN}`]);
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(turnStarts(codex).length, turnsBeforeClose);
  assert.ok(!turnStarts(codex).some((message) => JSON.stringify(message.params.input).includes("/close")));
  assert.ok(!(readState(workspace.stateDir).fixtures.discord.reactions ?? [])
    .some((row) => row.messageId === "close-1" && decodeURIComponent(row.emoji) === "💤"));
  await stopWorker(context, running);
});
