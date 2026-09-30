import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { injectDiscordMessage, waitForState } from "./support/bridge.js";
import { runScript } from "./support/runner.js";
import {
  OWNER_ID,
  createRouterWorkspace,
  routerEnv,
  routerRegistry,
  routerWithWebhooks,
  runRouterCli,
} from "./support/router.js";
import { readState, seedTmuxSession, updateState, writeState } from "./support/state.js";
import { cleanup } from "./support/teardown.js";

test.afterEach(async () => {
  await cleanup();
});

// `demo` is a router-transport Claude project with a tmux session name and path.
function claudeRouterWorkspace() {
  const workspace = createRouterWorkspace(routerRegistry({
    demo: {
      channel_id: "demo-channel", type: "claude", transport: "router", guest_user_ids: ["guest-id"],
      screen_name: "demo_claude", session_id: null, pid: null,
    },
  }));
  const registryFile = path.join(workspace.repoDir, "registry.json");
  const registry = JSON.parse(fs.readFileSync(registryFile, "utf8"));
  registry.projects.demo.path = workspace.tmpDir;
  fs.writeFileSync(registryFile, `${JSON.stringify(registry, null, 2)}\n`);
  return workspace;
}

function startSession(workspace, extraEnv = {}) {
  return runScript(workspace, "scripts/start-session.sh", { args: ["demo"], env: routerEnv(workspace, extraEnv) });
}

test("start-session launches a router Claude project whose channel server says hello to the Router", async () => {
  const workspace = claudeRouterWorkspace();
  await routerWithWebhooks(workspace, ["demo"]);

  const started = await startSession(workspace);

  assert.equal(started.exitCode, 0, started.stderr || started.stdout);
  const status = await runRouterCli(workspace, ["status"]);
  assert.equal(status.exitCode, 0, status.stderr);
  assert.match(status.stdout, /sessions: 1\n  project demo scope=demo-channel connected=/);
  const session = readState(workspace.stateDir).fixtures.tmux.sessions.demo_claude;
  assert.deepEqual(session.sendKeys, [["Enter"]]);
  const registry = JSON.parse(fs.readFileSync(path.join(workspace.repoDir, "registry.json"), "utf8"));
  assert.equal(typeof registry.projects.demo.pid, "number");
});

test("an owner message reaches the session as a channel notification and its reply posts as demo-claude", async () => {
  const workspace = claudeRouterWorkspace();
  const router = await routerWithWebhooks(workspace, ["demo"]);
  updateState(workspace.stateDir, (state) => {
    state.fixtures.claude.replyText = "on it";
  });
  const started = await startSession(workspace);
  assert.equal(started.exitCode, 0, started.stderr || started.stdout);

  injectDiscordMessage(workspace, {
    id: "owner-message-1",
    channelId: "demo-channel",
    content: "please run the tests",
    createdTimestamp: Date.parse("2026-09-29T10:00:00.000Z"),
    author: { id: OWNER_ID, username: "Owner" },
    attachments: [{ id: "att-1", name: "notes.txt", contentType: "text/plain", size: 2048,
      url: "https://cdn.discordapp.com/attachments/demo-channel/att-1/notes.txt" }],
  });

  const done = await waitForState(workspace, (next) => next.fixtures.discord.messages.length > 0
    && next.fixtures.claude.toolResults?.length > 0);
  assert.deepEqual(done.fixtures.claude.channelNotifications, [{
    content: "please run the tests",
    meta: {
      chat_id: "demo-channel", message_id: "owner-message-1", user: "Owner", user_id: OWNER_ID,
      ts: "2026-09-29T10:00:00.000Z", attachment_count: "1", attachments: "notes.txt (text/plain, 2KB)",
    },
  }], router.stdout);
  assert.deepEqual(done.fixtures.discord.messages.map(({ channelId, content, username, webhookId }) => ({ channelId, content, username, webhookId })), [
    { channelId: "demo-channel", content: "on it", username: "demo-claude", webhookId: "fake-webhook-1" },
  ]);
  assert.deepEqual(done.fixtures.claude.toolResults, [
    { name: "reply", result: { content: [{ type: "text", text: "sent (id: fake-message-1)" }] } },
  ]);
});

test("no Discord bot or webhook token reaches the session environment, launch files, or MCP config", async () => {
  const workspace = claudeRouterWorkspace();
  await routerWithWebhooks(workspace, ["demo"]);
  const started = await startSession(workspace);
  assert.equal(started.exitCode, 0, started.stderr || started.stdout);

  const state = readState(workspace.stateDir);
  const launchDir = path.join(workspace.routerStateDir, "launches", "demo");
  const launchFiles = fs.readdirSync(launchDir).map((file) => fs.readFileSync(path.join(launchDir, file), "utf8"));
  const mcpConfig = JSON.parse(fs.readFileSync(path.join(launchDir, "mcp.json"), "utf8"));
  const surfaces = [
    JSON.stringify(state.fixtures.tmux.sessions.demo_claude),
    JSON.stringify(state.fixtures.claude.invocations),
    JSON.stringify(state.fixtures.claude.sessionEnvironments),
    ...launchFiles,
  ];
  assert.equal(state.fixtures.claude.sessionEnvironments.length, 2);
  for (const text of surfaces) {
    for (const secret of ["root-bot-token", "pool-bot-token", "fake-webhook-token", "DISCORD_BOT_TOKEN", "DISCORD_STATE_DIR"]) {
      assert.equal(text.includes(secret), false, `${secret} leaked into ${text.slice(0, 200)}`);
    }
  }
  assert.deepEqual(Object.keys(mcpConfig.mcpServers), ["ccdm"]);
  assert.deepEqual(mcpConfig.mcpServers.ccdm.args, [path.join(workspace.repoDir, "scripts", "ccdm-channel-server.js")]);
  for (const file of fs.readdirSync(launchDir)) {
    assert.equal(fs.statSync(path.join(launchDir, file)).mode & 0o777, 0o600, file);
  }
  assert.equal(fs.statSync(path.join(workspace.routerStateDir, "keys", "demo.key")).mode & 0o777, 0o600);
});

function assertLaunchCleanedUp(workspace) {
  const state = readState(workspace.stateDir);
  assert.equal(state.fixtures.tmux.sessions.demo_claude, undefined);
  assert.equal(fs.existsSync(path.join(workspace.routerStateDir, "keys", "demo.key")), false);
  assert.equal(fs.existsSync(path.join(workspace.routerStateDir, "launches", "demo")), false);
  const registry = JSON.parse(fs.readFileSync(path.join(workspace.repoDir, "registry.json"), "utf8"));
  assert.equal(registry.projects.demo.pid, null);
  assert.equal(registry.projects.demo.session_id, null);
}

test("a launch whose development-channel confirmation never appears exits non-zero and cleans up", async () => {
  const workspace = claudeRouterWorkspace();
  await routerWithWebhooks(workspace, ["demo"]);
  updateState(workspace.stateDir, (state) => {
    state.fixtures.tmux.devChannelPrompt = "never";
  });

  const started = await startSession(workspace, { CCDM_CLAUDE_LAUNCH_TIMEOUT_S: "1" });

  assert.notEqual(started.exitCode, 0, started.stdout);
  assert.match(started.stderr, /development-channel confirmation never appeared/);
  assert.equal(readState(workspace.stateDir).fixtures.tmux.lastKilledSessions?.demo_claude?.killAttempts, 1);
  assertLaunchCleanedUp(workspace);
});

test("a launch whose Router hello fails exits non-zero and cleans up", async () => {
  const workspace = claudeRouterWorkspace();
  // No Router is running, so the channel server's hello cannot succeed.

  const started = await startSession(workspace, { CCDM_CLAUDE_LAUNCH_TIMEOUT_S: "10" });

  assert.notEqual(started.exitCode, 0, started.stdout);
  assert.match(started.stderr, /Router hello failed: router_unavailable/);
  assertLaunchCleanedUp(workspace);
});

test("after stop-session the Router treats the channel as offline and the next owner message gets 💤", async () => {
  const workspace = claudeRouterWorkspace();
  const router = await routerWithWebhooks(workspace, ["demo"]);
  const started = await startSession(workspace);
  assert.equal(started.exitCode, 0, started.stderr || started.stdout);

  const stopped = await runScript(workspace, "scripts/stop-session.sh", { args: ["demo"], env: routerEnv(workspace) });

  assert.equal(stopped.exitCode, 0, stopped.stderr || stopped.stdout);
  assert.match(stopped.stdout, /Stopped Discord session 'demo'/);
  const status = await runRouterCli(workspace, ["status"]);
  assert.match(status.stdout, /sessions: 0\n/);
  injectDiscordMessage(workspace, {
    id: "owner-message-2", channelId: "demo-channel", content: "are you there?",
    author: { id: OWNER_ID, username: "Owner" },
  });
  const done = await waitForState(workspace, (next) => next.fixtures.discord.reactions.length > 0);
  assert.deepEqual(done.fixtures.discord.reactions.map(({ channelId, messageId, emoji }) => ({ channelId, messageId, emoji })), [
    { channelId: "demo-channel", messageId: "owner-message-2", emoji: encodeURIComponent("💤") },
  ], router.stdout);
  assert.deepEqual(done.fixtures.claude.channelNotifications ?? [], []);
  const registry = JSON.parse(fs.readFileSync(path.join(workspace.repoDir, "registry.json"), "utf8"));
  assert.equal(registry.projects.demo.pid, null);
});

// Claude runs the statusline command with its own environment, which for a
// router launch carries the launch key path. An inherited DISCORD_STATE_DIR
// must not turn the run into a nickname PATCH.
function runStatusline(workspace, script, pct) {
  const stateDir = path.join(workspace.homeDir, ".claude", "channels", "discord");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, ".env"), "DISCORD_BOT_TOKEN=root-bot-token\n");
  return runScript(workspace, script, {
    env: {
      CCDM_ROUTER_KEY_FILE: path.join(workspace.routerStateDir, "keys", "demo.key"),
      DISCORD_STATE_DIR: stateDir,
      CONTEXT_DISCORD_INTERVAL: "0",
    },
    input: `${JSON.stringify({ context_window: { used_percentage: pct } })}\n`,
  });
}

async function ownerMessageReply(workspace, id, count) {
  injectDiscordMessage(workspace, {
    id, channelId: "demo-channel", content: "status?", author: { id: OWNER_ID, username: "Owner" },
  });
  const done = await waitForState(workspace, (next) => next.fixtures.discord.messages.length >= count
    && (next.fixtures.claude.toolResults?.length ?? 0) >= count);
  return done.fixtures.discord.messages[count - 1].username;
}

test("the statusline's context percentage rides on the next reply's Project Identity without a nickname PATCH", async () => {
  const workspace = claudeRouterWorkspace();
  await routerWithWebhooks(workspace, ["demo"]);
  updateState(workspace.stateDir, (state) => {
    state.fixtures.claude.replyText = "working";
  });
  const started = await startSession(workspace);
  assert.equal(started.exitCode, 0, started.stderr || started.stdout);

  const first = await runStatusline(workspace, "scripts/cc-statusline-wrapper.sh", 42);
  assert.equal(first.exitCode, 0, first.stderr || first.stdout);
  assert.match(first.stdout, /ccstatusline fixture output/);
  assert.equal(await ownerMessageReply(workspace, "owner-message-1", 1), "demo-claude · 42%");

  const second = await runStatusline(workspace, "scripts/cc-statusline-wrapper.sh", 57);
  assert.equal(second.exitCode, 0, second.stderr || second.stdout);
  assert.equal(await ownerMessageReply(workspace, "owner-message-2", 2), "demo-claude · 57%");

  const context = path.join(workspace.routerStateDir, "launches", "demo", "context.json");
  assert.equal(fs.statSync(context).mode & 0o777, 0o600);

  const nicknames = await runStatusline(workspace, "scripts/cc-discord-nicknames.sh", 61);
  assert.equal(nicknames.exitCode, 0, nicknames.stderr || nicknames.stdout);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const after = readState(workspace.stateDir);
  assert.deepEqual(after.fixtures.discord.nicknamePatches, []);
  assert.deepEqual(after.fixtures.curl.requests, []);
});

test("an unreadable context file drops the percentage rather than posting a wrong one", async () => {
  const workspace = claudeRouterWorkspace();
  await routerWithWebhooks(workspace, ["demo"]);
  updateState(workspace.stateDir, (state) => {
    state.fixtures.claude.replyText = "working";
  });
  const started = await startSession(workspace);
  assert.equal(started.exitCode, 0, started.stderr || started.stdout);
  fs.writeFileSync(path.join(workspace.routerStateDir, "launches", "demo", "context.json"), "{not json", { mode: 0o600 });

  assert.equal(await ownerMessageReply(workspace, "owner-message-1", 1), "demo-claude");
});

// Starts `demo` with the fake claude scripted to run `toolScript` on each
// channel notification.
async function scriptedSession(workspace, toolScript, seed = () => {}) {
  const router = await routerWithWebhooks(workspace, ["demo"]);
  updateState(workspace.stateDir, (state) => {
    state.fixtures.claude.toolScript = toolScript;
    seed(state);
  });
  const started = await startSession(workspace);
  assert.equal(started.exitCode, 0, started.stderr || started.stdout);
  return router;
}

function ownerMessage(workspace, extra = {}) {
  injectDiscordMessage(workspace, {
    id: "owner-message-1", channelId: "demo-channel", content: "take a look",
    createdTimestamp: Date.parse("2026-09-29T10:00:00.000Z"),
    author: { id: OWNER_ID, username: "Owner" }, ...extra,
  });
}

async function toolResults(workspace, count) {
  const done = await waitForState(workspace, (next) => (next.fixtures.claude.toolResults?.length ?? 0) >= count);
  return done.fixtures.claude.toolResults;
}

test("an owner's image and text file reach Claude as metadata and download_attachment writes both into the private inbox", async () => {
  const workspace = claudeRouterWorkspace();
  const shotUrl = "https://cdn.discordapp.com/attachments/demo-channel/att-1/shot.png";
  const notesUrl = "https://cdn.discordapp.com/attachments/demo-channel/att-2/notes.txt";
  await scriptedSession(workspace, [
    { name: "download_attachment", arguments: { chat_id: "{{chat_id}}", message_id: "{{message_id}}" } },
  ], (state) => {
    state.fixtures.discord.attachments[shotUrl] = { body: "fake png bytes", contentType: "image/png" };
    state.fixtures.discord.attachments[notesUrl] = { body: "remember the milk\n", contentType: "text/plain" };
  });

  ownerMessage(workspace, { attachments: [
    { id: "att-1", name: "shot.png", contentType: "image/png", size: 1024, url: shotUrl },
    { id: "att-2", name: "notes.txt", contentType: "text/plain", size: 2048, url: notesUrl },
  ] });

  const [result] = await toolResults(workspace, 1);
  const { channelNotifications } = readState(workspace.stateDir).fixtures.claude;
  assert.equal(channelNotifications[0].meta.attachment_count, "2");
  assert.equal(channelNotifications[0].meta.attachments, "shot.png (image/png, 1KB); notes.txt (text/plain, 2KB)");
  assert.equal(result.result.isError, undefined, JSON.stringify(result));
  const match = /^downloaded 2 attachment\(s\):\n {2}(\S+) {2}\(shot\.png, image\/png, 1KB\)\n {2}(\S+) {2}\(notes\.txt, text\/plain, 2KB\)$/
    .exec(result.result.content[0].text);
  assert.ok(match, result.result.content[0].text);
  const inbox = path.join(workspace.routerStateDir, "inbox", "demo");
  const [shot, notes] = [match[1], match[2]];
  assert.equal(path.dirname(shot), inbox);
  assert.match(path.basename(shot), /^\d+-att-1\.png$/);
  assert.match(path.basename(notes), /^\d+-att-2\.txt$/);
  assert.equal(fs.readFileSync(shot, "utf8"), "fake png bytes");
  assert.equal(fs.readFileSync(notes, "utf8"), "remember the milk\n");
  assert.equal(fs.statSync(shot).mode & 0o777, 0o600);
  assert.equal(fs.statSync(notes).mode & 0o777, 0o600);
  assert.equal(fs.statSync(inbox).mode & 0o777, 0o700);
});

test("a reply with a file and reply_to posts as demo with the upload and a jump-link first line", async () => {
  const workspace = claudeRouterWorkspace();
  const log = path.join(workspace.tmpDir, "build.log");
  fs.writeFileSync(log, "all green\n");
  await scriptedSession(workspace, [
    { name: "reply", arguments: { chat_id: "{{chat_id}}", text: "log attached", reply_to: "{{message_id}}", files: [log] } },
  ]);

  ownerMessage(workspace);

  const [result] = await toolResults(workspace, 1);
  assert.deepEqual(result.result, { content: [{ type: "text", text: "sent (id: fake-message-1)" }] });
  assert.deepEqual(readState(workspace.stateDir).fixtures.discord.messages
    .map(({ channelId, content, username, webhookId, uploads }) => ({ channelId, content, username, webhookId, uploads })), [{
    channelId: "demo-channel",
    content: "↪ [jump](https://discord.com/channels/guild-id/demo-channel/owner-message-1)\nlog attached",
    username: "demo-claude",
    webhookId: "fake-webhook-1",
    uploads: [{ name: "build.log", size: 10 }],
  }]);
});

test("edit_message on the session's own reply and react on the owner's message are recorded", async () => {
  const workspace = claudeRouterWorkspace();
  await scriptedSession(workspace, [
    { name: "reply", arguments: { chat_id: "{{chat_id}}", text: "working…" } },
    { name: "edit_message", arguments: { chat_id: "{{chat_id}}", message_id: "{{last_id}}", text: "done" } },
    { name: "react", arguments: { chat_id: "{{chat_id}}", message_id: "{{message_id}}", emoji: "👀" } },
  ]);

  ownerMessage(workspace);

  const results = await toolResults(workspace, 3);
  assert.deepEqual(results.map(({ name, result }) => [name, result]), [
    ["reply", { content: [{ type: "text", text: "sent (id: fake-message-1)" }] }],
    ["edit_message", { content: [{ type: "text", text: "edited (id: fake-message-1)" }] }],
    ["react", { content: [{ type: "text", text: "reacted" }] }],
  ]);
  const { webhookEdits, reactions, messages } = readState(workspace.stateDir).fixtures.discord;
  assert.deepEqual(webhookEdits, [{ webhookId: "fake-webhook-1", messageId: "fake-message-1", content: "done" }]);
  assert.equal(messages[0].content, "done");
  assert.deepEqual(reactions.map(({ channelId, messageId, emoji }) => ({ channelId, messageId, emoji })), [
    { channelId: "demo-channel", messageId: "owner-message-1", emoji: encodeURIComponent("👀") },
  ]);
});

test("an owner message shows the bot typing in the channel, as the Discord plugin does", async () => {
  const workspace = claudeRouterWorkspace();
  await scriptedSession(workspace, []);

  ownerMessage(workspace);

  const done = await waitForState(workspace, (next) => (next.fixtures.discord.typing?.length ?? 0) > 0);
  assert.deepEqual(done.fixtures.discord.typing, [{ authorization: "Bot root-bot-token", channelId: "demo-channel" }]);
});

// Histories discord-mcp.test.js reads through the supplementary Discord MCP,
// whose results are the shapes these tools keep.
const MCP_READ_HISTORY = [
  { id: "203", timestamp: "2026-09-27T10:02:00.000Z", content: "latest", author: { username: "Alice" }, attachments: [] },
  { id: "202", timestamp: "2026-09-27T10:01:00.000Z", content: "reply", author: { username: "bot", bot: true }, attachments: [{}] },
  { id: "201", timestamp: "2026-09-27T10:00:00.000Z", content: "older", author: { username: "Alice" }, attachments: [] },
];
const MCP_EXPORT_HISTORY = [
  { id: "103", timestamp: "2026-07-13T10:02:00.000Z", content: "latest", author: { id: "2", username: "Bob" }, attachments: [] },
  { id: "102", timestamp: "2026-07-13T10:01:00.000Z", content: "start", author: { id: "1", username: "Alice" }, attachments: [] },
  { id: "101", timestamp: "2026-07-13T10:00:00.000Z", content: "older", author: { id: "1", username: "Alice" }, attachments: [] },
];

test("read_last_x_messages_in_channel returns the supplementary Discord MCP's inline lines", async () => {
  const workspace = claudeRouterWorkspace();
  await scriptedSession(workspace, [
    { name: "read_last_x_messages_in_channel", arguments: { count: 2 } },
  ], (state) => {
    state.fixtures.discord.history = { "demo-channel": MCP_READ_HISTORY };
  });

  ownerMessage(workspace);

  const [read] = await toolResults(workspace, 1);
  assert.deepEqual(read.result, { content: [{ type: "text",
    text: "[2026-09-27T10:01:00.000Z] me: reply +1att (id: 202)\n[2026-09-27T10:02:00.000Z] Alice: latest (id: 203)" }] });
});

test("fetch_messages returns history lines like the Discord plugin, or (no messages) for an empty channel", async () => {
  const workspace = claudeRouterWorkspace();
  await scriptedSession(workspace, [
    { name: "fetch_messages", arguments: { channel: "{{chat_id}}", limit: 2 } },
  ], (state) => {
    state.fixtures.discord.history = { "demo-channel": MCP_READ_HISTORY };
  });

  ownerMessage(workspace);

  const [fetched] = await toolResults(workspace, 1);
  assert.deepEqual(fetched.result, { content: [{ type: "text",
    text: "[2026-09-27T10:01:00.000Z] me: reply +1att (id: 202)\n[2026-09-27T10:02:00.000Z] Alice: latest (id: 203)" }] });
  const state = readState(workspace.stateDir);
  state.fixtures.discord.history = { "demo-channel": [] };
  writeState(state, workspace.stateDir);
  ownerMessage(workspace, { id: "owner-message-2" });
  const [, empty] = await toolResults(workspace, 2);
  assert.deepEqual(empty.result, { content: [{ type: "text", text: "(no messages)" }] });
});

test("export_message_range returns the supplementary Discord MCP's exported-to line and private transcript", async () => {
  const workspace = claudeRouterWorkspace();
  await scriptedSession(workspace, [
    { name: "export_message_range", arguments: { start_message_id: "102" } },
  ], (state) => {
    state.fixtures.discord.history = { "demo-channel": MCP_EXPORT_HISTORY };
  });

  ownerMessage(workspace);

  const [exported] = await toolResults(workspace, 1);
  const exportText = exported.result.content[0].text;
  assert.match(exportText, /^exported to \//, JSON.stringify(exported));
  const exportPath = exportText.replace(/^exported to /, "");
  const text = fs.readFileSync(exportPath, "utf8");
  assert.match(text, /Message ID: 102/);
  assert.match(text, /Message ID: 103/);
  assert.doesNotMatch(text, /Message ID: 101/);
  assert.equal(fs.statSync(exportPath).mode & 0o777, 0o600);
});

test("a read past 100 messages returns the supplementary Discord MCP's saved-transcript line", async () => {
  const workspace = claudeRouterWorkspace();
  const history = Array.from({ length: 150 }, (_, index) => ({
    id: String(1149 - index), timestamp: "2026-09-27T10:00:00.000Z", content: `message ${1149 - index}`,
    author: { username: "Alice" }, attachments: [],
  }));
  await scriptedSession(workspace, [
    { name: "read_last_x_messages_in_channel", arguments: { count: 120 } },
  ], (state) => {
    state.fixtures.discord.history = { "demo-channel": history };
  });

  ownerMessage(workspace);

  const [read] = await toolResults(workspace, 1);
  const text = read.result.content[0].text;
  assert.match(text, /^saved 120 messages to \//, JSON.stringify(read));
  const transcript = text.replace(/^saved 120 messages to /, "");
  const lines = fs.readFileSync(transcript, "utf8").trim().split("\n");
  assert.equal(lines.length, 120);
  assert.equal(lines[0], "[2026-09-27T10:00:00.000Z] Alice: message 1030 (id: 1030)");
  assert.equal(lines.at(-1), "[2026-09-27T10:00:00.000Z] Alice: message 1149 (id: 1149)");
  assert.equal(fs.statSync(transcript).mode & 0o777, 0o600);
});

test("tool calls aimed at another channel surface scope_violation to Claude and touch nothing in Discord", async () => {
  const workspace = claudeRouterWorkspace();
  await scriptedSession(workspace, [
    { name: "reply", arguments: { chat_id: "beta-channel", text: "wrong room" } },
    { name: "react", arguments: { chat_id: "beta-channel", message_id: "{{message_id}}", emoji: "👀" } },
    { name: "edit_message", arguments: { chat_id: "beta-channel", message_id: "{{message_id}}", text: "x" } },
    { name: "fetch_messages", arguments: { channel: "beta-channel" } },
    { name: "download_attachment", arguments: { chat_id: "beta-channel", message_id: "{{message_id}}" } },
  ]);

  ownerMessage(workspace);

  const results = await toolResults(workspace, 5);
  for (const { name, result } of results) {
    assert.equal(result.isError, true, name);
    assert.match(result.content[0].text, new RegExp(`^${name} failed: scope_violation `), name);
  }
  const { messages, reactions, webhookEdits, attachmentFetches } = readState(workspace.stateDir).fixtures.discord;
  assert.deepEqual([messages, reactions, webhookEdits ?? [], attachmentFetches], [[], [], [], []]);
});

function command(workspace, id, content, author = { id: OWNER_ID, username: "Owner" }) {
  injectDiscordMessage(workspace, { id, channelId: "demo-channel", content, author });
}

function acknowledgments(state) {
  const { reactions, messages } = state.fixtures.discord;
  return {
    reactions: reactions.map(({ messageId, emoji }) => [messageId, decodeURIComponent(emoji)]),
    messages: messages.map(({ channelId, content, username }) => [channelId, content, username]),
  };
}

test("/compact and /clear are typed into demo's own tmux pane with an acknowledgment and no Claude turn", async () => {
  const workspace = claudeRouterWorkspace();
  await routerWithWebhooks(workspace, ["demo"]);
  const started = await startSession(workspace);
  assert.equal(started.exitCode, 0, started.stderr || started.stdout);
  seedTmuxSession("other_claude", { paneOutput: "Listening\n" }, { stateDir: workspace.stateDir });

  command(workspace, "cmd-compact", "/compact");
  await waitForState(workspace, (next) => next.fixtures.tmux.sessions.demo_claude.sendKeys.length >= 3);
  command(workspace, "cmd-clear", "/clear");
  const done = await waitForState(workspace, (next) => next.fixtures.tmux.sessions.demo_claude.sendKeys.length >= 5
    && next.fixtures.discord.messages.length >= 2);

  assert.deepEqual(done.fixtures.tmux.sessions.demo_claude.sendKeys, [
    ["Enter"], ["-l", "/compact"], ["Enter"], ["-l", "/clear"], ["Enter"],
  ]);
  assert.equal(done.fixtures.tmux.sessions.other_claude.sendKeys, undefined);
  assert.deepEqual(acknowledgments(done), {
    reactions: [["cmd-compact", "🔄"], ["cmd-clear", "🔄"]],
    messages: [
      ["demo-channel", "Sent /compact to Claude.", "demo-claude"],
      ["demo-channel", "Sent /clear to Claude.", "demo-claude"],
    ],
  });
  assert.deepEqual(done.fixtures.claude.channelNotifications ?? [], []);
});

test("/pause queues owner messages and /unpause delivers them to Claude in order", async () => {
  const workspace = claudeRouterWorkspace();
  await routerWithWebhooks(workspace, ["demo"]);
  const started = await startSession(workspace);
  assert.equal(started.exitCode, 0, started.stderr || started.stdout);

  command(workspace, "cmd-pause", "/pause");
  await waitForState(workspace, (next) => next.fixtures.discord.messages.length >= 1);
  command(workspace, "queued-1", "first while paused");
  command(workspace, "queued-2", "second while paused");
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.deepEqual(readState(workspace.stateDir).fixtures.claude.channelNotifications ?? [], []);

  command(workspace, "cmd-unpause", "/unpause");
  const done = await waitForState(workspace, (next) => (next.fixtures.claude.channelNotifications?.length ?? 0) >= 2
    && next.fixtures.discord.messages.length >= 2);

  assert.deepEqual(done.fixtures.claude.channelNotifications.map(({ content, meta }) => [content, meta.message_id]), [
    ["first while paused", "queued-1"],
    ["second while paused", "queued-2"],
  ]);
  assert.deepEqual(acknowledgments(done), {
    reactions: [["cmd-pause", "⏸️"], ["cmd-unpause", "▶️"]],
    messages: [
      ["demo-channel", "Session paused. New messages will be queued.", "demo-claude"],
      ["demo-channel", "Session unpaused.", "demo-claude"],
    ],
  });
});

function demoRuntime(workspace) {
  const registry = JSON.parse(fs.readFileSync(path.join(workspace.repoDir, "registry.json"), "utf8"));
  const keyFile = path.join(workspace.routerStateDir, "keys", "demo.key");
  return { pid: registry.projects.demo.pid, key: fs.existsSync(keyFile) ? fs.readFileSync(keyFile, "utf8") : null };
}

// Restarts demo with `author`'s /restart and waits for the relaunched session
// to hold a new PID record and a new key, with root's pane untouched.
async function assertRestartsOnlyDemo(workspace, author) {
  await routerWithWebhooks(workspace, ["demo"]);
  const started = await startSession(workspace);
  assert.equal(started.exitCode, 0, started.stderr || started.stdout);
  seedTmuxSession("root_agent", { paneOutput: "root listening\n" }, { stateDir: workspace.stateDir });
  const before = demoRuntime(workspace);

  command(workspace, "cmd-restart", "/restart", author);

  const deadline = Date.now() + 20000;
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
  assert.equal(state.fixtures.tmux.lastKilledSessions.demo_claude.killAttempts, 1);
  assert.equal(state.fixtures.tmux.sessions.demo_claude.devChannelPrompt, "accepted");
  assert.deepEqual(state.fixtures.tmux.sessions.root_agent, { name: "root_agent", paneOutput: "root listening\n" });
  assert.equal(state.fixtures.tmux.lastKilledSessions.root_agent, undefined);
  assert.deepEqual(acknowledgments(state), {
    reactions: [["cmd-restart", "🔄"]],
    messages: [["demo-channel", "Restarting session — fresh session coming up.", "demo-claude"]],
  });
  assert.deepEqual(state.fixtures.claude.channelNotifications ?? [], []);
}

test("/restart in demo's channel relaunches only demo, which reconnects with a new key", async () => {
  await assertRestartsOnlyDemo(claudeRouterWorkspace(), { id: OWNER_ID, username: "Owner" });
});

test("a guest's /restart follows the Codex bridge's allowed-user policy: demo restarts and root never does", async () => {
  await assertRestartsOnlyDemo(claudeRouterWorkspace(), { id: "guest-id", username: "Guest" });
});
