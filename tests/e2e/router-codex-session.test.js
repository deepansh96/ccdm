import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { injectDiscordMessage, injectDiscordReaction, startFakeCodexServer, waitForState } from "./support/bridge.js";
import { runScript } from "./support/runner.js";
import {
  OWNER_ID,
  createRouterWorkspace,
  routerEnv,
  routerRegistry,
  routerWithWebhooks,
  runRouterCli,
  waitFor,
} from "./support/router.js";
import { readState, writeState } from "./support/state.js";
import { cleanup } from "./support/teardown.js";

test.afterEach(async () => {
  await cleanup();
});

// `demo` is a router-transport Codex project served by the fake app-server on `port`.
function codexRouterWorkspace(port) {
  const workspace = createRouterWorkspace(routerRegistry({
    demo: {
      channel_id: "demo-channel", type: "codex", transport: "router", guest_user_ids: ["guest-id"],
      screen_name: "demo_codex", ws_port: port, session_id: null, pid: null,
    },
  }));
  const registryFile = path.join(workspace.repoDir, "registry.json");
  const registry = JSON.parse(fs.readFileSync(registryFile, "utf8"));
  registry.projects.demo.path = workspace.tmpDir;
  fs.writeFileSync(registryFile, `${JSON.stringify(registry, null, 2)}\n`);
  fs.mkdirSync(path.join(workspace.homeDir, ".codex"), { recursive: true });
  return workspace;
}

function startCodexSession(workspace, extraEnv = {}) {
  return runScript(workspace, "scripts/start-codex-session.sh", { args: ["demo"], env: routerEnv(workspace, extraEnv), timeoutMs: 30000 });
}

function readRegistry(workspace) {
  return JSON.parse(fs.readFileSync(path.join(workspace.repoDir, "registry.json"), "utf8"));
}

test("start-codex-session launches a router Codex project whose bridge says hello to the Router", async () => {
  const workspace = codexRouterWorkspace(0);
  const codex = await startFakeCodexServer(workspace, { channelId: "demo-channel" });
  setPort(workspace, codex.port);
  await routerWithWebhooks(workspace, ["demo"]);

  const started = await startCodexSession(workspace);

  assert.equal(started.exitCode, 0, started.stderr || started.stdout);
  const status = await runRouterCli(workspace, ["status"]);
  assert.equal(status.exitCode, 0, status.stderr);
  assert.match(status.stdout, /sessions: 1\n  project demo scope=demo-channel connected=/);
  assert.equal(typeof readRegistry(workspace).projects.demo.pid, "number");
});

test("a Codex project with no transport field launches through the Router and replies as its webhook", async () => {
  const workspace = codexRouterWorkspace(0);
  const registryFile = path.join(workspace.repoDir, "registry.json");
  const registry = JSON.parse(fs.readFileSync(registryFile, "utf8"));
  delete registry.projects.demo.transport;
  fs.writeFileSync(registryFile, `${JSON.stringify(registry, null, 2)}\n`);
  const codex = await startFakeCodexServer(workspace, { channelId: "demo-channel", turns: [{ mcpReplyText: "served by the Router" }] });
  setPort(workspace, codex.port);
  await routerWithWebhooks(workspace, ["demo"]);

  const started = await startCodexSession(workspace);

  assert.equal(started.exitCode, 0, started.stderr || started.stdout);
  const status = await runRouterCli(workspace, ["status"]);
  assert.match(status.stdout, /sessions: 1\n  project demo scope=demo-channel connected=/);
  assert.equal(readState(workspace.stateDir).fixtures.tmux.sessions.demo_codex.env.CCDM_ROUTER_KEY_FILE,
    path.join(workspace.routerStateDir, "keys", "demo.key"));
  injectDiscordMessage(workspace, { id: "owner-1", channelId: "demo-channel", content: "hi", author: { id: OWNER_ID, username: "Owner" } });
  const done = await waitForState(workspace, (next) => next.fixtures.discord.messages.length > 0, 15000);
  assert.deepEqual(done.fixtures.discord.messages.map(({ content, webhookId }) => ({ content, webhookId })), [
    { content: "served by the Router", webhookId: "fake-webhook-1" },
  ]);
});

// Atomic replace, the way guest-access.js and editors land a registry.
function updateRegistry(workspace, change) {
  const registryFile = path.join(workspace.repoDir, "registry.json");
  const registry = JSON.parse(fs.readFileSync(registryFile, "utf8"));
  change(registry);
  fs.writeFileSync(`${registryFile}.edit`, `${JSON.stringify(registry, null, 2)}\n`);
  fs.renameSync(`${registryFile}.edit`, registryFile);
}

function setPort(workspace, port) {
  const registryFile = path.join(workspace.repoDir, "registry.json");
  const registry = JSON.parse(fs.readFileSync(registryFile, "utf8"));
  registry.projects.demo.ws_port = port;
  fs.writeFileSync(registryFile, `${JSON.stringify(registry, null, 2)}\n`);
}

// 64,600 of a 258,400-token window is 25%.
const SEEDED_USAGE = { last: { inputTokens: 64600 }, modelContextWindow: 258400 };

async function routerCodexSession(turns, codexOptions = {}, { guests, routerEnv: routerExtraEnv } = {}) {
  const workspace = codexRouterWorkspace(0);
  if (guests) updateRegistry(workspace, (registry) => { registry.projects.demo.guest_user_ids = guests; });
  const codex = await startFakeCodexServer(workspace, { channelId: "demo-channel", turns, ...codexOptions });
  setPort(workspace, codex.port);
  const router = await routerWithWebhooks(workspace, ["demo"], { env: routerExtraEnv ?? {} });
  const started = await startCodexSession(workspace);
  assert.equal(started.exitCode, 0, started.stderr || started.stdout);
  return { workspace, codex, router };
}

test("an owner message starts a Codex turn whose reply posts as demo-codex with its context percentage", async () => {
  const { workspace, router } = await routerCodexSession([{
    notificationsBeforeStart: [{ method: "thread/tokenUsage/updated", params: { tokenUsage: SEEDED_USAGE } }],
    mcpReplyText: "tests pass",
    delayMs: 100,
  }]);

  injectDiscordMessage(workspace, {
    id: "owner-message-1",
    channelId: "demo-channel",
    content: "please run the tests",
    author: { id: OWNER_ID, username: "Owner" },
  });

  const done = await waitForState(workspace, (next) => next.fixtures.discord.messages.length > 0, 15000);
  const turnStarts = done.fixtures.codex.protocolEvents
    .filter((event) => event.event === "client-message" && event.message.method === "turn/start")
    .map((event) => event.message.params.input);
  assert.deepEqual(turnStarts.at(-1), [{ type: "text", text: "please run the tests" }], router.stdout);
  assert.deepEqual(done.fixtures.discord.messages.map(({ channelId, content, username, webhookId }) => ({ channelId, content, username, webhookId })), [
    { channelId: "demo-channel", content: "tests pass", username: "demo-codex · 25%", webhookId: "fake-webhook-1" },
  ]);
  assert.deepEqual(done.fixtures.discord.nicknamePatches ?? [], []);
  // The MCP server's reply did not take the bridge's place as the listener.
  const status = await runRouterCli(workspace, ["status"]);
  assert.match(status.stdout, /sessions: 1\n  project demo scope=demo-channel connected=/);
});

test("no Discord bot or webhook token reaches the Codex session environment, launch files, or MCP config", async () => {
  const { workspace } = await routerCodexSession([]);

  const state = readState(workspace.stateDir);
  const launchDir = path.join(workspace.routerStateDir, "launches", "demo");
  const launchFiles = fs.readdirSync(launchDir).map((file) => fs.readFileSync(path.join(launchDir, file), "utf8"));
  const mcpWrites = state.fixtures.codex.protocolEvents
    .filter((event) => event.event === "client-message" && event.message.method === "config/value/write");
  assert.equal(mcpWrites.length, 1);
  const surfaces = [
    JSON.stringify(state.fixtures.tmux.sessions.demo_codex),
    JSON.stringify(state.fixtures.codex.bridgeInvocations),
    JSON.stringify(mcpWrites),
    ...launchFiles,
  ];
  for (const text of surfaces) {
    for (const secret of ["root-bot-token", "pool-bot-token", "fake-webhook-token", "BOT_TOKEN", "DISCORD_STATE_DIR"]) {
      assert.equal(text.includes(secret), false, `${secret} leaked into ${text.slice(0, 300)}`);
    }
  }
  assert.equal(mcpWrites[0].message.params.value.env.CCDM_ROUTER_KEY_FILE, path.join(workspace.routerStateDir, "keys", "demo.key"));
  for (const file of fs.readdirSync(launchDir)) {
    assert.equal(fs.statSync(path.join(launchDir, file)).mode & 0o777, 0o600, file);
  }
  assert.equal(fs.statSync(path.join(workspace.routerStateDir, "keys", "demo.key")).mode & 0o777, 0o600);
});

test("a router Codex launch whose Router hello fails exits non-zero and cleans up", async () => {
  const workspace = codexRouterWorkspace(0);
  const codex = await startFakeCodexServer(workspace, { channelId: "demo-channel" });
  setPort(workspace, codex.port);
  // No Router is running, so the bridge's hello cannot succeed.

  const started = await startCodexSession(workspace, { CCDM_CODEX_LAUNCH_TIMEOUT_S: "20" });

  assert.notEqual(started.exitCode, 0, started.stdout);
  assert.match(started.stderr, /Router hello failed: router_unavailable/);
  const state = readState(workspace.stateDir);
  assert.equal(state.fixtures.tmux.sessions.demo_codex, undefined);
  assert.equal(fs.existsSync(path.join(workspace.routerStateDir, "keys", "demo.key")), false);
  assert.equal(fs.existsSync(path.join(workspace.routerStateDir, "launches", "demo")), false);
  const registry = readRegistry(workspace);
  assert.equal(registry.projects.demo.pid, null);
  assert.equal(registry.projects.demo.session_id, null);
});

function ownerMessage(workspace, message) {
  injectDiscordMessage(workspace, { channelId: "demo-channel", author: { id: OWNER_ID, username: "Owner" }, ...message });
}

// The fake app-server's own record; fixture state writes from several
// processes can drop protocol events.
function clientMessages(codex, method) {
  return codex.clientMessages.filter((message) => message.method === method);
}

// Turns the owner started, without the bridge's bootstrap instruction turns.
function userTurnInputs(codex) {
  return clientMessages(codex, "turn/start")
    .map((message) => message.params.input)
    .filter((input) => !input[0]?.text?.startsWith("You are communicating with the user via Discord"));
}

test("a second owner message during an active router Codex turn steers that turn", async () => {
  const { workspace, codex } = await routerCodexSession([
    { turnId: "turn-active", waitForRelease: true, mcpReplyText: "both handled" },
  ]);

  ownerMessage(workspace, { id: "owner-first", content: "first" });
  await waitFor(() => userTurnInputs(codex).length === 1, () => "the first turn");
  ownerMessage(workspace, { id: "owner-second", content: "also this" });
  await waitFor(() => clientMessages(codex, "turn/steer").length === 1, () => "a steer");
  codex.releaseTurn("turn-active");

  const [steer] = clientMessages(codex, "turn/steer");
  assert.equal(steer.params.expectedTurnId, "turn-active");
  assert.deepEqual(steer.params.input, [{ type: "text", text: "also this" }]);
  const done = await waitForState(workspace, (next) => next.fixtures.discord.messages.length > 0, 15000);
  assert.deepEqual(userTurnInputs(codex), [[{ type: "text", text: "first" }]]);
  assert.deepEqual(done.fixtures.discord.messages.map(({ content, webhookId }) => ({ content, webhookId })), [
    { content: "both handled", webhookId: "fake-webhook-1" },
  ]);
});

function webhookContents(state) {
  return state.fixtures.discord.messages.filter((message) => message.webhookId === "fake-webhook-1").map((message) => message.content);
}

function botReactions(state) {
  return state.fixtures.discord.reactions.map(({ messageId, emoji }) => [messageId, decodeURIComponent(emoji)]);
}

test("/pause queues router Codex messages and /unpause runs them in order", async () => {
  const { workspace, codex } = await routerCodexSession([
    { turnId: "first-queued-turn", mcpReplyText: "first queued done" },
    { turnId: "second-queued-turn", mcpReplyText: "second queued done" },
  ]);

  ownerMessage(workspace, { id: "cmd-pause", content: "/pause" });
  await waitForState(workspace, (next) => webhookContents(next).includes("Bridge paused. New messages will be queued."), 15000);
  ownerMessage(workspace, { id: "first-queued", content: "first queued" });
  ownerMessage(workspace, { id: "second-queued", content: "second queued" });
  await waitForState(workspace, (next) => botReactions(next).filter(([, emoji]) => emoji === "⏳").length === 2, 15000);
  assert.deepEqual(userTurnInputs(codex), []);

  ownerMessage(workspace, { id: "cmd-unpause", content: "/unpause" });
  const done = await waitForState(workspace, (next) => webhookContents(next).includes("second queued done"), 15000);

  assert.deepEqual(userTurnInputs(codex), [[{ type: "text", text: "first queued" }], [{ type: "text", text: "second queued" }]]);
  assert.deepEqual(webhookContents(done), [
    "Bridge paused. New messages will be queued.", "Bridge unpaused.", "first queued done", "second queued done",
  ]);
  assert.deepEqual(botReactions(done), [
    ["cmd-pause", "⏸️"], ["first-queued", "⏳"], ["second-queued", "⏳"], ["cmd-unpause", "▶️"],
  ]);
});

test("/compact and /clear compact and replace the router Codex thread with webhook acknowledgments", async () => {
  const { workspace, codex } = await routerCodexSession([], {
    compactComplete: true, threadIds: ["thread-before-clear", "thread-after-clear"],
  });

  ownerMessage(workspace, { id: "cmd-compact", content: "/compact" });
  await waitForState(workspace, (next) => webhookContents(next).includes("Compaction complete."), 15000);
  ownerMessage(workspace, { id: "cmd-clear", content: "/clear" });
  const done = await waitForState(workspace, (next) => webhookContents(next).some((content) => content.startsWith("Conversation cleared")), 15000);

  assert.deepEqual(clientMessages(codex, "thread/compact/start").map((message) => message.params.threadId), ["thread-before-clear"]);
  assert.deepEqual(clientMessages(codex, "thread/archive").map((message) => message.params.threadId), ["thread-before-clear"]);
  assert.equal(clientMessages(codex, "thread/start").length, 2);
  assert.deepEqual(webhookContents(done), ["Compaction started.", "Compaction complete.", "Conversation cleared — fresh thread started."]);
  assert.deepEqual(botReactions(done), [["cmd-compact", "🔄"], ["cmd-clear", "🔄"]]);
  assert.deepEqual(userTurnInputs(codex), []);
});

function demoRuntime(workspace) {
  const keyFile = path.join(workspace.routerStateDir, "keys", "demo.key");
  return { pid: readRegistry(workspace).projects.demo.pid, key: fs.existsSync(keyFile) ? fs.readFileSync(keyFile, "utf8") : null };
}

test("/restart relaunches only the router Codex project, which reconnects with a new key", async () => {
  const { workspace } = await routerCodexSession([]);
  const before = demoRuntime(workspace);

  ownerMessage(workspace, { id: "cmd-restart", content: "/restart" });

  const deadline = Date.now() + 30000;
  for (;;) {
    const after = demoRuntime(workspace);
    if (typeof after.pid === "number" && after.pid !== before.pid && after.key && after.key !== before.key) {
      const status = await runRouterCli(workspace, ["status"]);
      if (/sessions: 1\n  project demo scope=demo-channel connected=/.test(status.stdout)) break;
    }
    assert.ok(Date.now() < deadline, `demo never relaunched: ${JSON.stringify({ before, after })}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const state = readState(workspace.stateDir);
  assert.deepEqual(webhookContents(state), ["Restarting session — fresh thread coming up."]);
  assert.deepEqual(botReactions(state), [["cmd-restart", "🔄"]]);
  assert.equal(state.fixtures.tmux.sessions.demo_codex.env.CCDM_ROUTER_KEY_FILE, path.join(workspace.routerStateDir, "keys", "demo.key"));
  assert.equal(state.fixtures.tmux.sessions.root_agent, undefined);
});

// Signed CDN URLs carry their expiry as hex Unix seconds in `ex`.
function signedUrl(name, expiry) {
  return `https://cdn.discordapp.com/attachments/demo-channel/2001/${name}?ex=${expiry}&is=00000001&hm=sig`;
}

test("an image, a file, and a voice attachment reach the router Codex turn through Router downloads", async () => {
  const [shot, archive, voice] = ["shot.png", "archive.bin", "voice-message.ogg"].map((name) => signedUrl(name, "ffffffff"));
  // The gateway delivered an archive URL that has since expired; the Router re-signs it.
  const staleArchive = signedUrl("archive.bin", "00000002");
  const { workspace, codex } = await routerCodexSession([{ mcpReplyText: "got them" }]);
  const seed = readState(workspace.stateDir);
  seed.fixtures.discord.attachments[shot] = { body: "image bytes", contentType: "image/png" };
  seed.fixtures.discord.attachments[archive] = { body: "binary body", contentType: "application/octet-stream" };
  seed.fixtures.discord.attachments[voice] = { body: "fixture audio body", contentType: "audio/ogg" };
  seed.fixtures.whisper.transcriptions["voice-message.ogg"] = "please add audio support";
  writeState(seed, workspace.stateDir);

  ownerMessage(workspace, {
    id: "2001",
    content: "see attached",
    attachments: [
      { id: "att-1", name: "shot.png", contentType: "image/png", size: 11, url: shot },
      { id: "att-2", name: "archive.bin", contentType: "application/octet-stream", size: 11, url: staleArchive, refreshedUrl: archive },
      { id: "att-3", name: "voice-message.ogg", contentType: "audio/ogg", size: 18, url: voice },
    ],
  });
  const done = await waitForState(workspace, (next) => webhookContents(next).includes("got them"), 15000);

  const [input] = userTurnInputs(codex);
  assert.equal(input.length, 4, JSON.stringify(input));
  assert.deepEqual(input[0], { type: "text", text: "see attached" });
  assert.deepEqual(input[1], { type: "image", url: "data:image/png;base64,aW1hZ2UgYnl0ZXM=" });
  const saved = /^\[Attachment saved to: (\S+)\] \(filename: archive\.bin, type: application\/octet-stream, size: 11 bytes\)$/.exec(input[2].text);
  assert.ok(saved, input[2].text);
  assert.equal(fs.readFileSync(saved[1], "utf8"), "binary body");
  assert.equal(input[3].text, "--- Audio transcription: voice-message.ogg ---\nplease add audio support\n--- End audio transcription ---");
  assert.equal(done.fixtures.whisper.invocations.length, 1);
  assert.deepEqual(done.fixtures.discord.attachmentFetches.map(({ url }) => url).sort(), [archive, shot, voice].sort());
  assert.deepEqual(done.fixtures.discord.messageFetches.map(({ authorization, messageId }) => [authorization, messageId]),
    [["Bot root-bot-token", "2001"]]);
});

test("a 👍 on a demo webhook message reaches the router Codex thread and a 👍 on the owner's own message does not", async () => {
  const { workspace, codex } = await routerCodexSession([{ mcpReplyText: "thanks" }]);
  const owner = { id: OWNER_ID, username: "Owner" };

  injectDiscordReaction(workspace, {
    id: "on-owner-message", channelId: "demo-channel", emoji: "👍", messageId: "3001", user: owner,
    message: { author: { bot: false, id: OWNER_ID, username: "Owner" }, content: "my own note" },
  });
  await waitForState(workspace, (next) => next.fixtures.discord.deliveredReactions.some(({ id }) => id === "on-owner-message"), 15000);
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.deepEqual(userTurnInputs(codex), []);

  injectDiscordReaction(workspace, {
    id: "on-demo-reply", channelId: "demo-channel", emoji: "👍", messageId: "3002", user: owner,
    message: { author: { bot: true, id: "fake-webhook-1", username: "demo-codex" }, webhookId: "fake-webhook-1", content: "The PR is ready.", partial: true },
  });
  await waitForState(workspace, (next) => webhookContents(next).includes("thanks"), 15000);

  assert.deepEqual(userTurnInputs(codex), [[
    { type: "text", text: 'User Owner reacted 👍 to your message: "The PR is ready." (message ID: 3002).' },
  ]]);
});

test("a router Codex turn types as the bot and edits its reply through the demo webhook", async () => {
  const { workspace } = await routerCodexSession([{ mcpReplyText: "working…", mcpEditText: "done: 3 files changed", delayMs: 300 }]);

  ownerMessage(workspace, { id: "owner-edit", content: "change the files" });
  const done = await waitForState(workspace, (next) => (next.fixtures.discord.webhookEdits ?? []).length > 0, 15000);

  const [reply] = done.fixtures.discord.messages;
  // The fake keeps the edited content on the stored message.
  assert.deepEqual([reply.content, reply.webhookId], ["done: 3 files changed", "fake-webhook-1"]);
  assert.deepEqual(done.fixtures.discord.webhookEdits, [{ webhookId: "fake-webhook-1", messageId: reply.id, content: "done: 3 files changed" }]);
  assert.ok(done.fixtures.discord.typing.length >= 1);
  assert.deepEqual([...new Set(done.fixtures.discord.typing.map(({ authorization, channelId }) => `${authorization} ${channelId}`))],
    ["Bot root-bot-token demo-channel"]);
});

// Runs a registry change and waits for the Router reload it causes. Earlier
// writes settle first so their own reloads are not mistaken for this one.
async function afterRouterReload(router, change) {
  await new Promise((resolve) => setTimeout(resolve, 100));
  const reloads = () => router.stdout.split("registry reloaded").length - 1;
  const before = reloads();
  change();
  await waitFor(() => reloads() > before, () => `registry reload:\n${router.stdout}\n${router.stderr}`);
}

test("a guest granted after a router Codex launch reaches the thread without a restart, and stops once revoked", async () => {
  const { workspace, codex, router } = await routerCodexSession([
    { mcpReplyText: "hello guest" },
    { mcpReplyText: "glad it helps" },
  ], {}, { guests: [], routerEnv: { CCDM_ROUTER_REGISTRY_DEBOUNCE_MS: "20" } });
  const guest = { id: "late-guest-id", username: "Guest" };
  const pid = readRegistry(workspace).projects.demo.pid;

  await afterRouterReload(router, () => updateRegistry(workspace, (registry) => {
    registry.projects.demo.guest_user_ids = [guest.id];
  }));

  injectDiscordMessage(workspace, { id: "guest-message", channelId: "demo-channel", content: "can you help?", author: guest });
  const replied = await waitForState(workspace, (next) => webhookContents(next).includes("hello guest"), 15000);
  const [reply] = replied.fixtures.discord.messages;
  injectDiscordReaction(workspace, {
    id: "guest-thumbs-up", channelId: "demo-channel", emoji: "👍", messageId: reply.id, user: guest,
    message: { author: { bot: true, id: "fake-webhook-1", username: "demo-codex" }, webhookId: "fake-webhook-1", content: "hello guest" },
  });
  await waitForState(workspace, (next) => webhookContents(next).includes("glad it helps"), 15000);

  assert.deepEqual(userTurnInputs(codex), [
    [{ type: "text", text: "can you help?" }],
    [{ type: "text", text: `User Guest reacted 👍 to your message: "hello guest" (message ID: ${reply.id}).` }],
  ]);
  assert.equal(readRegistry(workspace).projects.demo.pid, pid);

  await afterRouterReload(router, () => updateRegistry(workspace, (registry) => {
    registry.projects.demo.guest_user_ids = [];
  }));

  injectDiscordMessage(workspace, { id: "revoked-message", channelId: "demo-channel", content: "still there?", author: guest });
  injectDiscordReaction(workspace, {
    id: "revoked-thumbs-up", channelId: "demo-channel", emoji: "👍", messageId: reply.id, user: guest,
    message: { author: { bot: true, id: "fake-webhook-1", username: "demo-codex" }, webhookId: "fake-webhook-1", content: "hello guest" },
  });
  await waitForState(workspace, (next) => next.fixtures.discord.deliveredMessages.some(({ id }) => id === "revoked-message") &&
    next.fixtures.discord.deliveredReactions.some(({ id }) => id === "revoked-thumbs-up"), 15000);
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(userTurnInputs(codex).length, 2);
});
