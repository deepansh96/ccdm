import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { injectDiscordMessage } from "./support/bridge.js";
import { runNodeEntrypoint, runScript } from "./support/runner.js";
import { OWNER_ID, ROOT_TOKEN, createRouterWorkspace, routerRegistry, routerWithWebhooks,
  waitFor } from "./support/router.js";
import { readState, updateState } from "./support/state.js";
import { cleanup } from "./support/teardown.js";
import { startThreadSupervisor, supervisorEnv, supervisorStatus } from "./support/thread-supervisor.js";

test.afterEach(cleanup);

// Operator thread management, end to end: the real Router, Thread
// Supervisor, start-thread-session.sh and CCDM channel server, with the
// fixture claude and tmux. Discord inputs, the conversation resolver CLI and
// threads.sh go in.
const THREAD_ID = "1700000000000610001";
const THREAD_TMUX = "demo_claude-t-610001";
const SIBLING_ID = "1700000000000610002";
const SIBLING_TMUX = "demo_claude-t-610002";
const BETA_THREAD_ID = "1700000000000610003";
const ROOT_AUTH = `Bot ${ROOT_TOKEN}`;
const OWNER = { id: OWNER_ID, username: "Owner" };
const link = threadId => `https://discord.com/channels/guild-id/${threadId}`;

function operationsWorkspace() {
  const workspace = createRouterWorkspace(routerRegistry({
    demo: { channel_id: "demo-channel", type: "claude", transport: "router", screen_name: "demo_claude",
      model: "claude-test-model" },
  }));
  const registryFile = path.join(workspace.repoDir, "registry.json");
  const registry = JSON.parse(fs.readFileSync(registryFile, "utf8"));
  registry.projects.demo.path = workspace.tmpDir;
  registry.projects.beta.path = workspace.tmpDir;
  fs.writeFileSync(registryFile, `${JSON.stringify(registry, null, 2)}\n`);
  return workspace;
}

async function supervised(workspace) {
  await routerWithWebhooks(workspace, ["demo", "beta"]);
  updateState(workspace.stateDir, state => {
    state.fixtures.claude.replyText = "on it";
  });
  return startThreadSupervisor(workspace);
}

async function threadRow(workspace, threadId, predicate = () => true, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await supervisorStatus(workspace);
    const row = Object.values(last.projects ?? {}).map(project => project.threads?.[threadId]).find(Boolean);
    if (row && predicate(row)) return row;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`thread ${threadId} never matched: ${JSON.stringify(last)}`);
}

const discord = workspace => readState(workspace.stateDir).fixtures.discord;
const claude = workspace => readState(workspace.stateDir).fixtures.claude;
const tmuxSessions = workspace => readState(workspace.stateDir).fixtures.tmux.sessions;
const posts = (workspace, threadId) => (discord(workspace).messages ?? []).filter(message => message.channelId === threadId);
const replies = (workspace, threadId) => posts(workspace, threadId).filter(message => message.webhookId);
const notices = (workspace, threadId) => posts(workspace, threadId).filter(message => !message.webhookId)
  .map(({ content, authorization }) => ({ content, authorization }));
const launches = (workspace, threadId) => claude(workspace).invocations
  .filter(invocation => invocation.env.CCDM_ROUTER_KEY_FILE?.endsWith(`.thread-${threadId}.key`));
const resumeArg = invocation => {
  const index = invocation.args.indexOf("--resume");
  return index < 0 ? null : invocation.args[index + 1].replace(/^'|'$/g, "");
};
const alive = pid => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// A user-made thread, bound by the supervisor as `registered`.
async function boundThread(workspace, threadId, name, parentId = "demo-channel") {
  updateState(workspace.stateDir, state => {
    (state.fixtures.discord.injectedThreads ||= []).push({ id: threadId, type: 11, parentId, name, ownerId: OWNER_ID,
      autoArchiveDuration: 10080, event: "create" });
  });
  return threadRow(workspace, threadId);
}

async function liveThread(workspace, threadId, name) {
  await boundThread(workspace, threadId, name);
  injectDiscordMessage(workspace, { id: `boot-${threadId}`, channelId: threadId, content: "please fix the parser",
    author: OWNER });
  await threadRow(workspace, threadId, row => row.state === "live" && row.provider_conversation_id != null);
  await waitFor(() => replies(workspace, threadId).length === 1, () => `${threadId}'s bootstrap reply`, 15000);
  return tmuxSessions(workspace)[threadId === THREAD_ID ? THREAD_TMUX : SIBLING_TMUX].pid;
}

// Claude keeps a conversation's transcript at
// <home>/projects/<cwd, each non-alphanumeric character as "-">/<id>.jsonl.
function writeClaudeTranscript(workspace, sessionId) {
  const dir = path.join(workspace.homeDir, ".claude", "projects", workspace.tmpDir.replace(/[^A-Za-z0-9]/g, "-"));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), "{}\n");
}

async function resolve(workspace, ...args) {
  const result = await runNodeEntrypoint(workspace, "scripts/conversation-resolver.js", { args,
    env: supervisorEnv(workspace) });
  return { ...result, json: result.exitCode === 0 ? JSON.parse(result.stdout) : null };
}

function threadsCli(workspace, ...args) {
  return runScript(workspace, "scripts/threads.sh", { args, env: supervisorEnv(workspace) });
}

test("the resolver maps a channel id, a thread id and a thread link, and exits 2 on unknown or ambiguous input", async () => {
  const workspace = operationsWorkspace();
  await supervised(workspace);
  await boundThread(workspace, THREAD_ID, "fix-login");
  await boundThread(workspace, BETA_THREAD_ID, "fix-login", "beta-channel");

  assert.deepEqual((await resolve(workspace, "demo-channel")).json,
    { project: "demo", thread_id: null, provider: "claude", channel_id: "demo-channel" });
  assert.deepEqual((await resolve(workspace, THREAD_ID)).json,
    { project: "demo", thread_id: THREAD_ID, provider: "claude", channel_id: THREAD_ID });
  assert.deepEqual((await resolve(workspace, link(BETA_THREAD_ID))).json,
    { project: "beta", thread_id: BETA_THREAD_ID, provider: "codex", channel_id: BETA_THREAD_ID });
  assert.deepEqual((await resolve(workspace, `https://discord.com/channels/guild-id/beta-channel/1234`)).json,
    { project: "beta", thread_id: null, provider: "codex", channel_id: "beta-channel" });
  assert.deepEqual((await resolve(workspace, "--project", "beta", "fix-login")).json,
    { project: "beta", thread_id: BETA_THREAD_ID, provider: "codex", channel_id: BETA_THREAD_ID });

  for (const args of [["1799999999999999999"], [link("1799999999999999999")], ["no-such-thread"],
    ["--project", "beta", THREAD_ID], ["--project", "nowhere", "fix-login"]]) {
    const refused = await resolve(workspace, ...args);
    assert.equal(refused.exitCode, 2, `${args.join(" ")}: ${refused.stdout}`);
    assert.match(refused.stderr, /conversation-resolver: .+/);
  }
  const ambiguous = await resolve(workspace, "fix-login");
  assert.equal(ambiguous.exitCode, 2, ambiguous.stdout);
  assert.match(ambiguous.stderr, /ambiguous/);
  assert.match(ambiguous.stderr, /demo/);
  assert.match(ambiguous.stderr, /beta/);
});

test("threads.sh list prints each thread's name, id, provider/model, state with its reason and idle time, filtered by project", async () => {
  const workspace = operationsWorkspace();
  await supervised(workspace);
  await liveThread(workspace, THREAD_ID, "fix-login");
  await boundThread(workspace, SIBLING_ID, "write-docs");
  await boundThread(workspace, BETA_THREAD_ID, "port-bridge", "beta-channel");
  const stopped = await threadsCli(workspace, "stop", "fix-login");
  assert.equal(stopped.exitCode, 0, stopped.stderr || stopped.stdout);

  const all = await threadsCli(workspace, "list");
  assert.equal(all.exitCode, 0, all.stderr || all.stdout);
  const rows = all.stdout.trim().split("\n");
  assert.match(rows[0], /^PROJECT\s+NAME\s+THREAD\s+PROVIDER\/MODEL\s+STATE\s+IDLE$/);
  assert.equal(rows.length, 4, all.stdout);
  assert.match(all.stdout, new RegExp(`^demo\\s+fix-login\\s+${THREAD_ID}\\s+claude/claude-test-model\\s+stopped/operator\\s+\\d+[smhd]$`, "m"));
  assert.match(all.stdout, new RegExp(`^demo\\s+write-docs\\s+${SIBLING_ID}\\s+claude/claude-test-model\\s+registered\\s+\\d+[smhd]$`, "m"));
  assert.match(all.stdout, new RegExp(`^beta\\s+port-bridge\\s+${BETA_THREAD_ID}\\s+codex/\\S+\\s+registered\\s+\\d+[smhd]$`, "m"));

  const demo = await threadsCli(workspace, "list", "demo");
  assert.equal(demo.exitCode, 0, demo.stderr || demo.stdout);
  assert.equal(demo.stdout.trim().split("\n").length, 3, demo.stdout);
  assert.doesNotMatch(demo.stdout, /port-bridge/);

  const unknown = await threadsCli(workspace, "list", "nowhere");
  assert.equal(unknown.exitCode, 2, unknown.stdout);
  assert.match(unknown.stderr, /nowhere/);
});

async function gone(workspace, pid, tmux) {
  await waitFor(() => !alive(pid) && tmuxSessions(workspace)[tmux] === undefined,
    () => `${tmux} (pid ${pid}) to stop: ${JSON.stringify(tmuxSessions(workspace))}`, 15000);
}

test("threads.sh stop by name and by link stops only that thread's session as stopped/operator", async () => {
  const workspace = operationsWorkspace();
  await supervised(workspace);
  const threadPid = await liveThread(workspace, THREAD_ID, "fix-login");
  const siblingPid = await liveThread(workspace, SIBLING_ID, "write-docs");

  const byName = await threadsCli(workspace, "stop", "demo", "fix-login");
  assert.equal(byName.exitCode, 0, byName.stderr || byName.stdout);
  assert.match(byName.stdout, new RegExp(`Stopped thread 'fix-login' \\(${THREAD_ID}\\) in 'demo'`));
  await gone(workspace, threadPid, THREAD_TMUX);
  const row = await threadRow(workspace, THREAD_ID);
  assert.deepEqual([row.state, row.stop_reason, row.close_reason], ["stopped", "operator", null]);
  assert.ok(alive(siblingPid), "the sibling thread's session still runs");
  assert.equal((await threadRow(workspace, SIBLING_ID)).state, "live");

  const byLink = await threadsCli(workspace, "stop", link(SIBLING_ID));
  assert.equal(byLink.exitCode, 0, byLink.stderr || byLink.stdout);
  await gone(workspace, siblingPid, SIBLING_TMUX);
  assert.deepEqual([(await threadRow(workspace, SIBLING_ID)).state, (await threadRow(workspace, SIBLING_ID)).stop_reason],
    ["stopped", "operator"]);

  for (const args of [["stop", "no-such-thread"], ["stop", "demo-channel"], ["stop", "beta", "fix-login"]]) {
    const refused = await threadsCli(workspace, ...args);
    assert.equal(refused.exitCode, 2, `${args.join(" ")}: ${refused.stdout}`);
    assert.notEqual(refused.stderr.trim(), "");
  }
});

test("threads.sh restart by name and by link relaunches the thread with --resume and the same id, as /restart does", async () => {
  const workspace = operationsWorkspace();
  await supervised(workspace);
  await liveThread(workspace, THREAD_ID, "fix-login");
  const { provider_conversation_id: conversationId } = await threadRow(workspace, THREAD_ID);
  writeClaudeTranscript(workspace, conversationId);

  const byName = await threadsCli(workspace, "restart", "fix-login");
  assert.equal(byName.exitCode, 0, byName.stderr || byName.stdout);
  await waitFor(() => launches(workspace, THREAD_ID).length === 2, () => "the restarted launch", 15000);
  await threadRow(workspace, THREAD_ID, row => row.state === "live");
  assert.equal(resumeArg(launches(workspace, THREAD_ID)[1]), conversationId);

  const stopped = await threadsCli(workspace, "stop", THREAD_ID);
  assert.equal(stopped.exitCode, 0, stopped.stderr || stopped.stdout);
  await threadRow(workspace, THREAD_ID, row => row.state === "stopped");
  const byLink = await threadsCli(workspace, "restart", "demo", link(THREAD_ID));
  assert.equal(byLink.exitCode, 0, byLink.stderr || byLink.stdout);
  await waitFor(() => launches(workspace, THREAD_ID).length === 3, () => `the second restarted launch: ${JSON.stringify(posts(workspace, THREAD_ID))} ${JSON.stringify(tmuxSessions(workspace))}`, 15000);
  const row = await threadRow(workspace, THREAD_ID, current => current.state === "live");
  assert.equal(resumeArg(launches(workspace, THREAD_ID)[2]), conversationId);
  assert.equal(row.provider_conversation_id, conversationId);

  const answered = notices(workspace, THREAD_ID);
  assert.deepEqual(answered.map(notice => notice.authorization), [ROOT_AUTH, ROOT_AUTH]);
  for (const notice of answered) assert.match(notice.content, /Restarting/);
});

test("threads.sh close by name and by link archives the thread, stops its session and leaves closed/close-command, as /close does", async () => {
  const workspace = operationsWorkspace();
  await supervised(workspace);
  const threadPid = await liveThread(workspace, THREAD_ID, "fix-login");
  const siblingPid = await liveThread(workspace, SIBLING_ID, "write-docs");

  const byName = await threadsCli(workspace, "close", "demo", "fix-login");
  assert.equal(byName.exitCode, 0, byName.stderr || byName.stdout);
  const byLink = await threadsCli(workspace, "close", link(SIBLING_ID));
  assert.equal(byLink.exitCode, 0, byLink.stderr || byLink.stdout);

  for (const [threadId, pid, tmux] of [[THREAD_ID, threadPid, THREAD_TMUX], [SIBLING_ID, siblingPid, SIBLING_TMUX]]) {
    const row = await threadRow(workspace, threadId, current => current.state === "closed");
    assert.deepEqual([row.state, row.stop_reason, row.close_reason], ["closed", null, "close-command"]);
    await gone(workspace, pid, tmux);
    const [notice] = notices(workspace, threadId);
    assert.equal(notice.authorization, ROOT_AUTH);
    assert.match(notice.content, /Closing/);
  }
  assert.deepEqual((discord(workspace).threadPatches ?? []).filter(patch => "archived" in patch.body)
    .map(({ authorization, body, threadId }) => ({ authorization, body, threadId })),
  [{ authorization: ROOT_AUTH, body: { archived: true }, threadId: THREAD_ID },
    { authorization: ROOT_AUTH, body: { archived: true }, threadId: SIBLING_ID }]);
  // The archive the close made is not mistaken for an auto-archive.
  await new Promise(resolve => setTimeout(resolve, 1000));
  assert.equal((await threadRow(workspace, THREAD_ID)).close_reason, "close-command");
});

test("every threads.sh subcommand fails clearly when the supervisor is down", async () => {
  const workspace = operationsWorkspace();
  const supervisor = await supervised(workspace);
  await boundThread(workspace, THREAD_ID, "fix-login");
  assert.equal((await supervisor.stop()).exitCode, 0);

  for (const args of [["list"], ["list", "demo"], ["stop", "fix-login"], ["restart", link(THREAD_ID)],
    ["close", "demo", THREAD_ID], ["create", "demo", "x"]]) {
    const result = await threadsCli(workspace, ...args);
    assert.equal(result.exitCode, 1, `${args.join(" ")}: ${result.stdout}`);
    assert.match(result.stderr, /thread supervisor is not reachable/, args.join(" "));
  }
  assert.deepEqual(launches(workspace, THREAD_ID), []);
});
