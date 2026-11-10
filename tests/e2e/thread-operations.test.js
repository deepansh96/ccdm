import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { injectDiscordMessage } from "./support/bridge.js";
import { PYTHON, platformGate } from "./support/platform.js";
import { runNodeEntrypoint, runScript } from "./support/runner.js";
import { OWNER_ID, ROOT_TOKEN, createRouterWorkspace, routerRegistry, routerWithWebhooks,
  waitFor } from "./support/router.js";
import { readState, updateState } from "./support/state.js";
import { cleanup } from "./support/teardown.js";
import { assertSupervisorStops, startThreadSupervisor, supervisorEnv, supervisorStatus } from "./support/thread-supervisor.js";

test.afterEach(cleanup);

// Operator thread management, end to end: the real Router, Thread
// Supervisor, start-thread-session.sh and CCDM channel server, with the
// fixture claude and tmux. Discord inputs, the conversation resolver CLI and
// threads.sh go in; on Windows, where the sessions run on the fake ccdm-host,
// `scripts/ccdm threads` does.
const WIN = process.platform === "win32";
// What the command calls itself in its usage and in front of each message.
const COMMAND = WIN ? "scripts/ccdm threads" : "threads.sh";
const PREFIX = WIN ? "ccdm threads" : "threads.sh";
const USAGE = `usage: ${COMMAND} create <project> <name> [--provider claude|codex] [--account <alias>] ` +
  `[--model <model>] [--effort <effort>] ${WIN ? "[--message-stdin|--message-file <path>]" : "[message…]"}\n` +
  `       ${COMMAND} list [<project>]\n` +
  `       ${COMMAND} stop|restart|close [<project>] <name|link|id>\n`;
const THREAD_ID = "1700000000000610001";
const THREAD_TMUX = `demo_claude-t-${THREAD_ID}`;
const SIBLING_ID = "1700000000000610002";
const SIBLING_TMUX = `demo_claude-t-${SIBLING_ID}`;
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

// The operator's thread command: the shim on macOS and Linux, `scripts/ccdm threads`
// on Windows, where Python ends each printed line with CRLF.
const unixLines = text => text.replace(/\r\n/g, "\n");
async function threadsCommand(workspace, args, options = {}) {
  const result = await runScript(workspace, WIN ? "scripts/ccdm" : "scripts/threads.sh",
    { args: WIN ? ["threads", ...args] : args, env: supervisorEnv(workspace), ...options });
  return { ...result, stdout: unixLines(result.stdout), stderr: unixLines(result.stderr) };
}

const threadsCli = (workspace, ...args) => threadsCommand(workspace, args);

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

test("a threads.sh stop and an in-thread /restart that both arrive during a boot are each carried out once the launcher exits", async () => {
  const workspace = operationsWorkspace();
  await routerWithWebhooks(workspace, ["demo", "beta"]);
  // The launch hangs until the shortened boot timeout fails it.
  await startThreadSupervisor(workspace, { env: { CCDM_THREAD_BOOT_TIMEOUT_S: "4" } });
  updateState(workspace.stateDir, state => {
    state.fixtures.tmux.devChannelPrompt = "never";
  });
  await boundThread(workspace, THREAD_ID, "fix-login");
  injectDiscordMessage(workspace, { id: "boot-message", channelId: THREAD_ID, content: "please fix the parser",
    author: OWNER });
  await threadRow(workspace, THREAD_ID, row => row.state === "booting");

  const started = Date.now();
  const stopping = threadsCommand(workspace, ["stop", THREAD_ID], { timeoutMs: 90000 });
  // The stop is waiting on the launcher before the /restart arrives.
  await new Promise(resolve => setTimeout(resolve, 1500));
  injectDiscordMessage(workspace, { id: "restart-command", channelId: THREAD_ID, content: "/restart", author: OWNER });

  const stopped = await stopping;
  assert.equal(stopped.exitCode, 0, stopped.stderr || stopped.stdout);
  assert.ok(Date.now() - started < 30000, "the stop was answered after the launch, not at the client's timeout");
  // The /restart was not dropped either: it relaunched the thread.
  await waitFor(() => notices(workspace, THREAD_ID).some(notice => notice.content === "Restarting this thread's session."),
    () => `the /restart notice: ${JSON.stringify(notices(workspace, THREAD_ID))}`, 15000);
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
  await assertSupervisorStops(supervisor);

  for (const args of [["list"], ["list", "demo"], ["stop", "fix-login"], ["restart", link(THREAD_ID)],
    ["close", "demo", THREAD_ID], ["create", "demo", "x"]]) {
    const result = await threadsCli(workspace, ...args);
    assert.equal(result.exitCode, 1, `${args.join(" ")}: ${result.stdout}`);
    assert.match(result.stderr, /thread supervisor is not reachable/, args.join(" "));
    assert.ok(result.stderr.startsWith(`${PREFIX}: `), `${args.join(" ")}: ${result.stderr}`);
    if (WIN) assert.doesNotMatch(result.stderr, /threads\.sh/, args.join(" "));
  }
  assert.deepEqual(launches(workspace, THREAD_ID), []);
});

test("bad usage exits 2 with the usage text, and every message names threads.sh on macOS and Linux and scripts/ccdm threads on Windows", async () => {
  const workspace = operationsWorkspace();
  await supervised(workspace);
  await boundThread(workspace, THREAD_ID, "fix-login");
  const printed = [];

  for (const args of [[], ["bogus"], ["create", "demo"], ["list", "demo", "extra"], ["stop"],
    ["restart", "demo", "fix-login", "extra"]]) {
    const refused = await threadsCli(workspace, ...args);
    printed.push(refused);
    assert.deepEqual([refused.exitCode, refused.stdout, refused.stderr], [2, "", `${PREFIX}: ${USAGE}`], args.join(" "));
  }
  for (const [args, reason] of [
    [["create", "demo", "x", "--colour", "red"], "unknown flag --colour"],
    [["create", "demo", "x", "--effort"], "--effort needs a value"],
    [["create", "demo", "x", "--message-file"], "--message-file needs a value"],
    [["create", "demo", "x", "--message-stdin", "--message-stdin"], "--message-stdin and --message-file give the first message once"],
    [["create", "demo", "x", "--message-stdin", "some", "words"], "--message-stdin gives the first message, so no message words may follow it"],
    [["list", "nowhere"], "unknown project 'nowhere'"],
    [["close", "demo-channel"], "'demo-channel' is the channel of project 'demo', not a thread"],
  ]) {
    const refused = await threadsCli(workspace, ...args);
    printed.push(refused);
    assert.deepEqual([refused.exitCode, refused.stdout, refused.stderr], [2, "", `${PREFIX}: ${reason}\n`], args.join(" "));
  }
  // A thread nobody can name: the resolver's own reason, exit 2.
  const unknown = await threadsCli(workspace, "stop", "no-such-thread");
  printed.push(unknown);
  assert.equal(unknown.exitCode, 2, unknown.stdout);
  assert.match(unknown.stderr, /^conversation-resolver: .+/);

  // The one form that is not an error: the usage alone, on stdout.
  const help = await threadsCli(workspace, "--help");
  printed.push(help);
  assert.deepEqual([help.exitCode, help.stdout, help.stderr], [0, USAGE, ""]);
  // The same after a verb: `--help` is not taken for a thread, a project or a name, and nothing is asked.
  for (const args of [["create", "--help"], ["list", "--help"], ["stop", "--help"], ["restart", "-h"], ["close", "--help"]]) {
    const verbHelp = await threadsCli(workspace, ...args);
    printed.push(verbHelp);
    assert.deepEqual([verbHelp.exitCode, verbHelp.stdout, verbHelp.stderr], [0, USAGE, ""], args.join(" "));
  }

  if (WIN) {
    for (const { stdout, stderr } of printed) assert.doesNotMatch(stdout + stderr, /threads\.sh/);
  }
  assert.deepEqual(launches(workspace, THREAD_ID), []);
  assert.equal((await threadRow(workspace, THREAD_ID)).state, "registered");
});

test("the shim and scripts/ccdm threads give the same output and exit codes", async () => {
  const workspace = operationsWorkspace();
  await supervised(workspace);
  const env = supervisorEnv(workspace);
  // No thread is bound, so `list` prints its header alone and no idle time can tick between the two runs.
  for (const args of [[], ["--help"], ["stop", "--help"], ["list"], ["list", "nowhere"], ["stop", "no-such-thread"],
    ["create", "demo", "x", "--colour", "red"]]) {
    const shim = await runScript(workspace, "scripts/threads.sh", { args, env });
    const direct = await runScript(workspace, "scripts/ccdm", { args: ["threads", ...args], env });
    assert.deepEqual([direct.exitCode, direct.stdout, direct.stderr], [shim.exitCode, shim.stdout, shim.stderr],
      args.join(" "));
    assert.notEqual(shim.stdout + shim.stderr, "", args.join(" "));
  }
});

// A command run inside a thread's session is ended with that session: on Windows
// by the session's Job, or because it carries the thread's key file. Here a
// stand-in for such a command carries the key-file pair, so the stop finds it.
function inThreadCommand(workspace, threadId, verb) {
  const standIn = path.join(workspace.tmpDir, "in-thread-command.cjs");
  fs.writeFileSync(standIn, [
    'const { spawnSync } = require("node:child_process");',
    "const [program, ...args] = process.argv.slice(4);",
    'const done = spawnSync(program, args, { encoding: "utf8", windowsHide: true });',
    "process.stdout.write(JSON.stringify({ status: done.status, stdout: done.stdout, stderr: done.stderr }));",
    "",
  ].join("\n"));
  const key = path.join(workspace.routerStateDir, "keys", `.thread-${threadId}.key`);
  return runNodeEntrypoint(workspace, path.relative(workspace.repoDir, standIn), {
    args: ["--ccdm-key-file", key, PYTHON, path.join(workspace.repoDir, "scripts", "ccdm.py"), "threads", verb, threadId],
    env: supervisorEnv(workspace, { PYTHONUTF8: "1" }), timeoutMs: 30000,
  });
}

test("on Windows, a stop and a restart run from inside the thread's own session are carried out by the supervisor, though the caller ends with the session", platformGate("win32", "POSIX ends a session's commands with its tmux session, which the fixture tmux does not model"), async () => {
  const workspace = operationsWorkspace();
  await supervised(workspace);
  const firstPid = await liveThread(workspace, THREAD_ID, "fix-login");
  const siblingPid = await liveThread(workspace, SIBLING_ID, "write-docs");
  const { provider_conversation_id: conversationId } = await threadRow(workspace, THREAD_ID);
  writeClaudeTranscript(workspace, conversationId);

  // Restart: the old session and the caller are gone, and the thread is live again in the same conversation.
  const restarting = await inThreadCommand(workspace, THREAD_ID, "restart");
  assert.equal(restarting.stdout, "", `the caller was ended before it heard back: ${restarting.stdout}`);
  await waitFor(() => launches(workspace, THREAD_ID).length === 2, () => "the restarted launch", 15000);
  const restarted = await threadRow(workspace, THREAD_ID, row => row.state === "live");
  assert.equal(restarted.provider_conversation_id, conversationId);
  assert.equal(resumeArg(launches(workspace, THREAD_ID)[1]), conversationId);
  assert.ok(!alive(firstPid), "the first session's process is gone");
  assert.deepEqual(notices(workspace, THREAD_ID).map(notice => notice.content), ["Restarting this thread's session."]);
  const secondPid = tmuxSessions(workspace)[THREAD_TMUX].pid;
  assert.notEqual(secondPid, firstPid);

  // Stop: the session and the caller are gone, the row is stopped/operator, and nothing restarts it.
  const stopping = await inThreadCommand(workspace, THREAD_ID, "stop");
  assert.equal(stopping.stdout, "", `the caller was ended before it heard back: ${stopping.stdout}`);
  await gone(workspace, secondPid, THREAD_TMUX);
  const row = await threadRow(workspace, THREAD_ID, current => current.state === "stopped");
  assert.deepEqual([row.state, row.stop_reason, row.close_reason], ["stopped", "operator", null]);
  await new Promise(resolve => setTimeout(resolve, 1000));
  assert.equal(launches(workspace, THREAD_ID).length, 2);
  assert.equal((await threadRow(workspace, THREAD_ID)).state, "stopped");

  assert.ok(alive(siblingPid), "the sibling thread's session still runs");
  assert.equal((await threadRow(workspace, SIBLING_ID)).state, "live");

  // Close, in the sibling: archived, its session gone, closed/close-command.
  const closing = await inThreadCommand(workspace, SIBLING_ID, "close");
  assert.equal(closing.stdout, "", `the caller was ended before it heard back: ${closing.stdout}`);
  const closed = await threadRow(workspace, SIBLING_ID, current => current.state === "closed");
  assert.deepEqual([closed.state, closed.stop_reason, closed.close_reason], ["closed", null, "close-command"]);
  await gone(workspace, siblingPid, SIBLING_TMUX);
  assert.deepEqual((discord(workspace).threadPatches ?? []).filter(patch => "archived" in patch.body)
    .map(({ body, threadId }) => ({ body, threadId })), [{ body: { archived: true }, threadId: SIBLING_ID }]);
  for (const caller of [restarting, stopping, closing]) assert.notEqual(caller.exitCode, 0, "the caller did not finish");
});

const relay = (workspace, ...args) => runScript(workspace, "scripts/send-claude-command.sh", { args,
  env: supervisorEnv(workspace) });

test("send-claude-command.sh given a thread id or link sends the command only to that thread's tmux pane", async () => {
  const workspace = operationsWorkspace();
  await supervised(workspace);
  await liveThread(workspace, THREAD_ID, "fix-login");
  await liveThread(workspace, SIBLING_ID, "write-docs");
  const sentBefore = name => (tmuxSessions(workspace)[name]?.sendKeys ?? []).length;
  const [threadBefore, siblingBefore] = [sentBefore(THREAD_TMUX), sentBefore(SIBLING_TMUX)];

  const byId = await relay(workspace, THREAD_ID, "/compact");
  assert.equal(byId.exitCode, 0, byId.stderr || byId.stdout);
  assert.match(byId.stdout, new RegExp(`Sent /compact to Claude thread ${THREAD_ID} in project 'demo' \\(${WIN ? "" : "tmux "}session '${THREAD_TMUX}'\\)`));
  const byLink = await relay(workspace, "--channel", link(THREAD_ID), "clear");
  assert.equal(byLink.exitCode, 0, byLink.stderr || byLink.stdout);

  assert.deepEqual(tmuxSessions(workspace)[THREAD_TMUX].sendKeys.slice(threadBefore),
    [["-l", "/compact"], ["Enter"], ["-l", "/clear"], ["Enter"]]);
  assert.equal(sentBefore(SIBLING_TMUX), siblingBefore);
  assert.equal(tmuxSessions(workspace).demo_claude, undefined);

  for (const args of [["no-such-thread", "/compact"], ["--channel", link("1799999999999999999"), "/compact"]]) {
    const refused = await relay(workspace, ...args);
    assert.equal(refused.exitCode, 2, `${args.join(" ")}: ${refused.stdout}`);
    assert.match(refused.stderr, /conversation-resolver: .+/);
  }
});

const guests = (workspace, project) => JSON.parse(fs.readFileSync(path.join(workspace.repoDir, "registry.json"), "utf8"))
  .projects[project].guest_user_ids;

test("guest-access.js given a thread id or link grants and revokes the parent project's guest", async () => {
  const workspace = operationsWorkspace();
  await supervised(workspace);
  await boundThread(workspace, THREAD_ID, "fix-login");
  const guestAccess = (...args) => runNodeEntrypoint(workspace, "scripts/guest-access.js", { args,
    env: supervisorEnv(workspace) });

  const granted = await guestAccess("grant", THREAD_ID, "new-guest-id");
  assert.equal(granted.exitCode, 0, granted.stderr || granted.stdout);
  assert.match(granted.stdout, /Granted new-guest-id guest access to demo\./);
  assert.deepEqual(guests(workspace, "demo"), ["new-guest-id"]);
  assert.equal(guests(workspace, "beta"), undefined);
  const overwritten = new Set((discord(workspace).permissionOverwrites ?? []).map(({ channelId }) => channelId));
  assert.ok(overwritten.has("demo-channel"), [...overwritten].join(", "));
  assert.ok(!overwritten.has(THREAD_ID), [...overwritten].join(", "));

  const revoked = await guestAccess("revoke", link(THREAD_ID), "new-guest-id");
  assert.equal(revoked.exitCode, 0, revoked.stderr || revoked.stdout);
  assert.match(revoked.stdout, /Revoked new-guest-id guest access from demo\./);
  assert.deepEqual(guests(workspace, "demo"), []);

  const refused = await guestAccess("grant", "no-such-thread", "new-guest-id");
  assert.equal(refused.exitCode, 2, refused.stdout);
  assert.match(refused.stderr, /conversation-resolver: .+/);
});

test("export-discord-range.js given a thread id or link exports that thread's messages", async () => {
  const workspace = operationsWorkspace();
  await supervised(workspace);
  await boundThread(workspace, THREAD_ID, "fix-login");
  updateState(workspace.stateDir, state => {
    state.fixtures.discord.restMessages = [
      { id: "903", channel_id: THREAD_ID, timestamp: "2026-07-13T10:02:00.000Z", content: "thread end", author: OWNER, attachments: [] },
      { id: "902", channel_id: "demo-channel", timestamp: "2026-07-13T10:01:30.000Z", content: "channel chatter", author: OWNER, attachments: [] },
      { id: "901", channel_id: THREAD_ID, timestamp: "2026-07-13T10:01:00.000Z", content: "thread start", author: OWNER, attachments: [] },
    ];
  });
  const exportRange = (...args) => runNodeEntrypoint(workspace, "scripts/export-discord-range.js", { args,
    env: supervisorEnv(workspace) });

  for (const channel of [THREAD_ID, link(THREAD_ID)]) {
    const result = await exportRange(channel, "901", "903");
    assert.equal(result.exitCode, 0, result.stderr);
    const text = fs.readFileSync(result.stdout.trim(), "utf8");
    assert.match(text, /thread start[\s\S]*thread end/);
    assert.doesNotMatch(text, /channel chatter/);
  }
  assert.ok(discord(workspace).messageFetches.every(({ channelId }) => channelId === THREAD_ID));

  const refused = await exportRange(link("1799999999999999999"), "901");
  assert.equal(refused.exitCode, 2, refused.stdout);
  assert.match(refused.stderr, /conversation-resolver: .+/);
});
