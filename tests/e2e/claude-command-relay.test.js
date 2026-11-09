import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";

import { injectDiscordMessage } from "./support/bridge.js";
import { PYTHON } from "./support/platform.js";
import {
  OWNER_ID,
  createRouterWorkspace,
  routerEnv,
  routerRegistry,
  routerWithWebhooks,
  seedThreads,
  waitFor,
  writeThreadKey,
} from "./support/router.js";
import { createWorkspace, runScript } from "./support/runner.js";
import { startFakeHost } from "./support/session-fixture.js";
import { readState, seedRegistry, seedTmuxSession } from "./support/state.js";
import { cleanup, registerTeardownCallback } from "./support/teardown.js";
import { supervisorStateDir } from "./support/thread-supervisor.js";

test.afterEach(async () => {
  await cleanup();
});

const WIN32 = process.platform === "win32";
const SESSION_WORD = WIN32 ? "session" : "tmux session";
// Windows has no tmux. The fake host and the fake tmux share one session table, so
// every assertion on `sendKeys` reads the same on either backend.
const HOME_BACKEND = WIN32 ? "ccdm-host" : "tmux";
const BACKENDS = WIN32 ? ["ccdm-host"] : ["tmux", "ccdm-host"];

const fakeHosts = new WeakMap();
async function backendEnv(workspace, backend = HOME_BACKEND) {
  if (backend === "tmux") return {};
  if (!fakeHosts.has(workspace)) fakeHosts.set(workspace, await startFakeHost(workspace));
  return fakeHosts.get(workspace).env;
}

// Python's print ends a line with CRLF on Windows.
function unixLines(result) {
  const unix = text => text.replaceAll("\r\n", "\n");
  return { ...result, stdout: unix(result.stdout), stderr: unix(result.stderr) };
}

async function sendClaudeCommand(workspace, args, { backend, env = {} } = {}) {
  return unixLines(await runScript(workspace, "scripts/send-claude-command.sh", {
    args,
    env: { ...(await backendEnv(workspace, backend)), ...env },
    timeoutMs: 30000,
  }));
}

function buildRegistry(workspace, overrides = {}) {
  return {
    discord_user_id: "allowed-user-id",
    guild_id: "guild-id",
    category_ids: [],
    projects: {
      alpha: {
        path: path.join(workspace.tmpDir, "alpha project"),
        screen_name: "alpha_session",
        channel_id: "channel-alpha",
        type: "claude",
        session_id: "session-alpha",
        pid: 1234,
        ...(overrides.alpha ?? {}),
      },
      ...(overrides.extraProjects ?? {}),
    },
  };
}

test("send-claude-command relays /compact by project name into the Claude tmux session", async () => {
  const workspace = createWorkspace();
  seedRegistry(workspace, buildRegistry(workspace));
  seedTmuxSession("alpha_session", { paneOutput: "Listening\n" }, { stateDir: workspace.stateDir });

  const result = await sendClaudeCommand(workspace, ["alpha", "compact"]);

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Sent \/compact to Claude project 'alpha'/);
  const session = readState(workspace.stateDir).fixtures.tmux.sessions.alpha_session;
  assert.deepEqual(session.sendKeys, [["-l", "/compact"], ["Enter"]]);
});

test("send-claude-command resolves a project channel and relays /clear", async () => {
  const workspace = createWorkspace();
  seedRegistry(workspace, buildRegistry(workspace));
  seedTmuxSession("alpha_session", { paneOutput: "Listening\n" }, { stateDir: workspace.stateDir });

  const result = await sendClaudeCommand(workspace, ["--channel", "channel-alpha", "/clear"]);

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Sent \/clear to Claude project 'alpha'/);
  const session = readState(workspace.stateDir).fixtures.tmux.sessions.alpha_session;
  assert.deepEqual(session.sendKeys, [["-l", "/clear"], ["Enter"]]);
});

test("send-claude-command refuses non-Claude and remote targets", async () => {
  const codexWorkspace = createWorkspace();
  seedRegistry(
    codexWorkspace,
    buildRegistry(codexWorkspace, {
      alpha: { type: "codex", screen_name: "alpha_codex", ws_port: 18342 },
    }),
  );
  seedTmuxSession("alpha_codex", { paneOutput: "Codex bridge\n" }, { stateDir: codexWorkspace.stateDir });

  const codexResult = await sendClaudeCommand(codexWorkspace, ["alpha", "/compact"]);

  assert.equal(codexResult.exitCode, 1);
  assert.match(codexResult.stderr, /not 'claude'/);
  assert.equal(readState(codexWorkspace.stateDir).fixtures.tmux.sessions.alpha_codex.sendKeys, undefined);
  await cleanup();

  const remoteWorkspace = createWorkspace();
  seedRegistry(
    remoteWorkspace,
    buildRegistry(remoteWorkspace, {
      alpha: { path: "remote:vm-alpha" },
    }),
  );
  seedTmuxSession("alpha_session", { paneOutput: "Listening\n" }, { stateDir: remoteWorkspace.stateDir });

  const remoteResult = await sendClaudeCommand(remoteWorkspace, ["alpha", "/clear"]);

  assert.equal(remoteResult.exitCode, 1);
  assert.match(remoteResult.stderr, /is remote/);
  assert.equal(readState(remoteWorkspace.stateDir).fixtures.tmux.sessions.alpha_session.sendKeys, undefined);
});

test("send-claude-command validates the command and running session", async () => {
  const workspace = createWorkspace();
  seedRegistry(workspace, buildRegistry(workspace));

  const invalid = await sendClaudeCommand(workspace, ["alpha", "/context"]);

  assert.equal(invalid.exitCode, 2);
  assert.match(invalid.stderr, /Unsupported command/);

  const stopped = await sendClaudeCommand(workspace, ["alpha", "/compact"]);

  assert.equal(stopped.exitCode, 1);
  assert.match(stopped.stderr, /is not running/);
});

test("send-claude-command exits 2 with the conversation resolver's reason for a target it cannot name", async () => {
  const workspace = createWorkspace();
  seedRegistry(workspace, buildRegistry(workspace));
  seedTmuxSession("alpha_session", { paneOutput: "Listening\n" }, { stateDir: workspace.stateDir });

  for (const args of [["no-such-thread", "/compact"], ["--channel", "1799999999999999999", "/clear"]]) {
    const result = await sendClaudeCommand(workspace, args, { env: { CCDM_ROUTER_NODE: process.execPath } });
    assert.equal(result.exitCode, 2, `${args.join(" ")}: ${result.stdout}`);
    assert.match(result.stderr, /^conversation-resolver: '.+' is no registered channel, bound thread or thread name/);
  }
  const unknownProject = await sendClaudeCommand(workspace, ["--project", "nowhere", "/compact"]);
  assert.equal(unknownProject.exitCode, 2);
  assert.match(unknownProject.stderr, /Unknown project: nowhere/);
  assert.equal(readState(workspace.stateDir).fixtures.tmux.sessions.alpha_session.sendKeys, undefined);
});

test("the shim and scripts/ccdm send-claude-command give the same output and exit codes", async () => {
  const workspace = createWorkspace();
  seedRegistry(workspace, buildRegistry(workspace));
  seedTmuxSession("alpha_session", { paneOutput: "Listening\n" }, { stateDir: workspace.stateDir });
  const env = await backendEnv(workspace);
  const viaBoth = async (args) => {
    const shim = await runScript(workspace, "scripts/send-claude-command.sh", { args, env, timeoutMs: 30000 });
    const command = await runScript(workspace, "scripts/ccdm", { args: ["send-claude-command", ...args], env, timeoutMs: 30000 });
    assert.equal(command.exitCode, shim.exitCode, args.join(" "));
    assert.equal(command.stdout, shim.stdout, args.join(" "));
    assert.equal(command.stderr, shim.stderr, args.join(" "));
    return unixLines(shim);
  };

  const script = WIN32 ? "scripts/ccdm send-claude-command" : "scripts/send-claude-command.sh";
  const usage = `Usage:\n  ${script} <project|channel_id|thread_id|link> <compact|clear|/compact|/clear>\n  ${script} --project <project> <compact|clear|/compact|/clear>\n  ${script} --channel <channel_id|thread_id|link> <compact|clear|/compact|/clear>\n`;
  for (const args of [[], ["--help"], ["-h"]]) {
    const help = await viaBoth(args);
    assert.deepEqual([help.exitCode, help.stdout, help.stderr], [0, usage, ""], args.join(" "));
  }
  for (const args of [["alpha"], ["--project", "alpha"], ["--channel"]]) {
    const refused = await viaBoth(args);
    assert.deepEqual([refused.exitCode, refused.stdout, refused.stderr], [2, "", usage], args.join(" "));
  }
  const invalid = await viaBoth(["alpha", "/context"]);
  assert.deepEqual([invalid.exitCode, invalid.stdout, invalid.stderr],
    [2, "", "Unsupported command '/context'. Allowed commands: /compact, /clear.\n"]);
  assert.equal(readState(workspace.stateDir).fixtures.tmux.sessions.alpha_session.sendKeys, undefined);

  const sent = await viaBoth(["alpha", "/compact"]);
  assert.deepEqual([sent.exitCode, sent.stdout, sent.stderr],
    [0, `Sent /compact to Claude project 'alpha' (${SESSION_WORD} 'alpha_session', channel 'channel-alpha').\n`, ""]);
});

test("send-claude-command's refusals read as they did, with this OS's word for a session", async () => {
  const workspace = createWorkspace();
  seedRegistry(workspace, buildRegistry(workspace, {
    extraProjects: { beta: { path: "remote:vm-beta", screen_name: "beta_session", channel_id: "channel-beta", type: "claude" },
      gamma: { path: "/somewhere", screen_name: "gamma_codex", channel_id: "channel-gamma", type: "codex" },
      shared: { path: "/somewhere", screen_name: "shared_one", channel_id: "channel-alpha", type: "claude" },
      unnamed: { path: "/somewhere", channel_id: "channel-unnamed", type: "claude" } },
  }));
  const refusal = async (args) => {
    const result = await sendClaudeCommand(workspace, args, { env: { CCDM_ROUTER_NODE: process.execPath } });
    return [result.exitCode, result.stdout, result.stderr];
  };

  assert.deepEqual(await refusal(["alpha", "compact"]), [1, "", `Claude ${SESSION_WORD} 'alpha_session' for project 'alpha' is not running.\n`]);
  assert.deepEqual(await refusal(["beta", "/clear"]), [1, "", `Project 'beta' is remote (remote:vm-beta). Run /clear on the remote ${SESSION_WORD} instead.\n`]);
  assert.deepEqual(await refusal(["gamma", "/compact"]), [1, "", "Project 'gamma' is type 'codex', not 'claude'. Codex sessions handle /compact and /clear directly in their project channel.\n"]);
  assert.deepEqual(await refusal(["unnamed", "/compact"]), [2, "", "Project unnamed has no screen_name in registry.json\n"]);
  assert.deepEqual(await refusal(["--channel", "channel-alpha", "/compact"]), [2, "", "Channel channel-alpha matches multiple projects: alpha, shared\n"]);
  assert.deepEqual(await refusal(["--project", "nowhere", "/compact"]), [2, "", "Unknown project: nowhere\n"]);
  const [code, stdout, stderr] = await refusal(["no-such-thread", "/compact"]);
  assert.deepEqual([code, stdout], [2, ""]);
  assert.match(stderr, /^conversation-resolver: [^\n]+\n$/, "the resolver's reason, alone");
});

test("send-claude-command says when the registry cannot be read", async () => {
  const workspace = createWorkspace();
  const missing = await sendClaudeCommand(workspace, ["alpha", "/compact"]);
  assert.equal(missing.exitCode, 2);
  assert.match(missing.stderr, /^registry\.json not found at .*registry\.json\n$/);

  fs.writeFileSync(path.join(workspace.repoDir, "registry.json"), "{ not json");
  const invalid = await sendClaudeCommand(workspace, ["alpha", "/compact"]);
  assert.equal(invalid.exitCode, 2);
  assert.match(invalid.stderr, /^registry\.json is invalid JSON: /);
});

test("with the session host down, the target reads as not running", async () => {
  const workspace = createWorkspace();
  seedRegistry(workspace, buildRegistry(workspace));
  const noHost = await sendClaudeCommand(workspace, ["alpha", "/compact"], {
    backend: "tmux",
    env: { CCDM_SESSION_HOST: "ccdm-host", CCDM_STATE_ROOT: path.join(workspace.tmpDir, "no-host-here") },
  });
  assert.equal(noHost.exitCode, 1, noHost.stderr || noHost.stdout);
  assert.match(noHost.stderr, /is not running\.\n$/);
});

// The real channel server against the real Router and the fake Discord, typing
// into a session on one backend. Only the owner's message goes in.
const THREAD_ID = "1500000000000000001";
const THREAD_SESSION = `demo_claude-t-${THREAD_ID}`;
const OWNER = { id: OWNER_ID, username: "Owner" };
const nodeRequire = createRequire(import.meta.url);

async function channelWorkspace() {
  const workspace = createRouterWorkspace(routerRegistry({
    demo: { channel_id: "demo-channel", type: "claude", transport: "router", screen_name: "demo_claude", session_id: null, pid: null },
  }));
  const registryFile = path.join(workspace.repoDir, "registry.json");
  const registry = JSON.parse(fs.readFileSync(registryFile, "utf8"));
  registry.projects.demo.path = workspace.tmpDir;
  fs.writeFileSync(registryFile, JSON.stringify(registry));
  await routerWithWebhooks(workspace, ["demo"]);
  return workspace;
}

// Starts the server under a parent holding its stdin, as Claude does, and waits for its hello.
async function startChannelServer(workspace, { backend = HOME_BACKEND, keyName = "demo", env = {} } = {}) {
  const readyFile = path.join(workspace.tmpDir, `ready-${keyName}.json`);
  const child = spawn(process.execPath, [path.join(workspace.repoDir, "scripts", "ccdm-channel-server.js")], {
    cwd: workspace.repoDir,
    env: routerEnv(workspace, {
      CCDM_ROUTER_KEY_FILE: path.join(workspace.routerStateDir, "keys", `${keyName}.key`),
      CCDM_CLAUDE_PROJECT: "demo",
      CCDM_CLAUDE_CHANNEL_ID: "demo-channel",
      CCDM_CLAUDE_LAUNCH_ID: "fixture-launch",
      CCDM_REMINDER_PROJECT_ROOT: workspace.repoDir,
      CCDM_REMINDER_STATE_DIR: path.join(workspace.tmpDir, "reminder-state"),
      CCDM_CHANNEL_READY_FILE: readyFile,
      CCDM_PYTHON: PYTHON,
      ...(await backendEnv(workspace, backend)),
      ...env,
    }),
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  let errors = "";
  let output = "";
  child.stderr.on("data", (chunk) => { errors += chunk; });
  child.stdout.setEncoding("utf8").on("data", (chunk) => { output += chunk; });
  registerTeardownCallback(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
  });
  await waitFor(() => fs.existsSync(readyFile), () => `the channel server's hello; stderr:\n${errors}`, 20000);
  const ready = JSON.parse(fs.readFileSync(readyFile, "utf8"));
  assert.equal(ready.ok, true, `${JSON.stringify(ready)}\n${errors}`);
  return {
    async instructions() {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`);
      const line = await waitFor(() => output.split("\n").find((text) => text.includes('"instructions"')),
        () => `the initialize answer; stdout:\n${output}\nstderr:\n${errors}`, 10000);
      return JSON.parse(line).result.instructions;
    },
  };
}

const sessionsOf = (workspace) => readState(workspace.stateDir).fixtures.tmux.sessions;
const postsTo = (workspace, channelId) => readState(workspace.stateDir).fixtures.discord.messages
  .filter((message) => message.channelId === channelId).map((message) => message.content);

function ownerCommand(workspace, id, channelId, content) {
  injectDiscordMessage(workspace, { id, channelId, content, author: OWNER });
}

const threadServerEnv = (extra = {}) => ({ CCDM_THREAD_ID: THREAD_ID, ...extra });

function seedThreadSessions(workspace) {
  seedTmuxSession("demo_claude", { paneOutput: "Listening\n" }, { stateDir: workspace.stateDir });
  seedTmuxSession(THREAD_SESSION, { paneOutput: "Listening\n" }, { stateDir: workspace.stateDir });
  seedThreads(workspace, { [THREAD_ID]: { type: 11, parentId: "demo-channel" } });
  writeThreadKey(workspace, THREAD_ID, `${THREAD_ID}-key`);
}

async function threadCompact(workspace) {
  ownerCommand(workspace, "thread-compact", THREAD_ID, "/compact");
  await waitFor(() => postsTo(workspace, THREAD_ID).length >= 1, () => `the thread's reply: ${JSON.stringify(sessionsOf(workspace))}`, 20000);
}

for (const backend of BACKENDS) {
  test(`on ${backend}, the owner's /compact in a project channel is typed into that project's session, then Enter`, async () => {
    const workspace = await channelWorkspace();
    seedTmuxSession("demo_claude", { paneOutput: "Listening\n" }, { stateDir: workspace.stateDir });
    seedTmuxSession("other_claude", { paneOutput: "Listening\n" }, { stateDir: workspace.stateDir });
    await startChannelServer(workspace, { backend });

    ownerCommand(workspace, "cmd-compact", "demo-channel", "/compact");
    await waitFor(() => postsTo(workspace, "demo-channel").length >= 1, () => `the acknowledgment: ${JSON.stringify(sessionsOf(workspace))}`, 20000);

    assert.deepEqual(sessionsOf(workspace).demo_claude.sendKeys, [["-l", "/compact"], ["Enter"]]);
    assert.equal(sessionsOf(workspace).other_claude.sendKeys, undefined);
    assert.deepEqual(postsTo(workspace, "demo-channel"), ["Sent /compact to Claude."]);
  });

  test(`on ${backend}, a thread session's /compact goes into the thread's own session, never the project's`, async () => {
    const workspace = await channelWorkspace();
    seedThreadSessions(workspace);
    await startChannelServer(workspace, { backend, keyName: `.thread-${THREAD_ID}`, env: threadServerEnv({ CCDM_SESSION_NAME: THREAD_SESSION }) });

    await threadCompact(workspace);

    assert.deepEqual(sessionsOf(workspace)[THREAD_SESSION].sendKeys, [["-l", "/compact"], ["Enter"]]);
    assert.equal(sessionsOf(workspace).demo_claude.sendKeys, undefined);
    assert.deepEqual(postsTo(workspace, THREAD_ID), ["Sent /compact to Claude."]);
  });
}

test("a thread session with only the project's session name types nowhere and tells the owner", async () => {
  const workspace = await channelWorkspace();
  seedThreadSessions(workspace);
  await startChannelServer(workspace, { keyName: `.thread-${THREAD_ID}`, env: threadServerEnv({ CCDM_SESSION_NAME: "demo_claude" }) });

  await threadCompact(workspace);

  assert.equal(sessionsOf(workspace)[THREAD_SESSION].sendKeys, undefined);
  assert.equal(sessionsOf(workspace).demo_claude.sendKeys, undefined);
  assert.deepEqual(postsTo(workspace, THREAD_ID), [
    `**Error:** Failed to compact — ${WIN32 ? "this thread session has no session name" : "this thread session has no tmux session"}`,
  ]);
});

// The thread store, as much of it as the resolver reads.
function seedThreadStore(workspace, rows) {
  const { ensurePrivateDirSync } = nodeRequire("../../scripts/platform/privacy.js");
  const { DatabaseSync } = nodeRequire("node:sqlite");
  const directory = supervisorStateDir(workspace);
  ensurePrivateDirSync(directory);
  const file = path.join(directory, "threads.sqlite3");
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE threads (thread_id TEXT, project TEXT, name TEXT, provider TEXT, resolved_provider TEXT, state TEXT)");
  const insert = db.prepare("INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?)");
  for (const row of rows) insert.run(...row);
  db.close();
  fs.chmodSync(file, 0o600);
  return directory;
}

test("send-claude-command given a thread's id or link types only into that thread's session", async () => {
  const workspace = createWorkspace();
  seedRegistry(workspace, buildRegistry(workspace));
  const sibling = "1500000000000000002";
  const stateDir = seedThreadStore(workspace, [
    [THREAD_ID, "alpha", "fix-login", "claude", "claude", "live"],
    [sibling, "alpha", "write-docs", "claude", "claude", "live"],
  ]);
  const threadSession = `alpha_session-t-${THREAD_ID}`;
  const siblingSession = `alpha_session-t-${sibling}`;
  for (const name of ["alpha_session", threadSession, siblingSession]) {
    seedTmuxSession(name, { paneOutput: "Listening\n" }, { stateDir: workspace.stateDir });
  }
  const env = { CCDM_ROUTER_NODE: process.execPath, CCDM_THREAD_SUPERVISOR_STATE_DIR: stateDir };

  const byId = await sendClaudeCommand(workspace, [THREAD_ID, "/compact"], { env });
  assert.equal(byId.exitCode, 0, byId.stderr || byId.stdout);
  assert.equal(byId.stdout, `Sent /compact to Claude thread ${THREAD_ID} in project 'alpha' (${SESSION_WORD} '${threadSession}').\n`);
  const byLink = await sendClaudeCommand(workspace, ["--channel", `https://discord.com/channels/guild-id/${THREAD_ID}`, "clear"], { env });
  assert.equal(byLink.exitCode, 0, byLink.stderr || byLink.stdout);

  assert.deepEqual(sessionsOf(workspace)[threadSession].sendKeys, [["-l", "/compact"], ["Enter"], ["-l", "/clear"], ["Enter"]]);
  assert.equal(sessionsOf(workspace)[siblingSession].sendKeys, undefined);
  assert.equal(sessionsOf(workspace).alpha_session.sendKeys, undefined);
});

function relayInstructions(commands, ownSession) {
  return `Discord relays only ${commands} as commands; any other slash command the owner sends arrives as a plain message and does not run. When the owner sends one, or asks you to run one (such as a skill only they may invoke), type it into your own ${ownSession}. It runs when your current turn ends.`;
}

// realpathSync, as Node resolves the server's own path: a Windows temp folder's short (8.3) name stays.
const windowsOwnSession = (workspace) =>
  `session with the Bash tool: "${fs.realpathSync(workspace.repoDir).replace(/\\/g, "/")}/scripts/ccdm" session send "$CCDM_SESSION_NAME" --literal '/<command>' --enter`;
const POSIX_OWN_SESSION = `tmux pane: tmux send-keys -t "$TMUX_PANE" -l '/<command>' && tmux send-keys -t "$TMUX_PANE" Enter`;

test("RELAY_INSTRUCTIONS tells a session how to type into itself on this OS", async () => {
  const workspace = await channelWorkspace();
  seedThreadSessions(workspace);
  const ownSession = WIN32 ? windowsOwnSession(workspace) : POSIX_OWN_SESSION;

  const project = await startChannelServer(workspace);
  const projectText = await project.instructions();
  assert.equal(projectText.split("\n\n").at(-1), relayInstructions("/pause, /unpause, /compact, /clear and /restart", ownSession));

  const thread = await startChannelServer(workspace, { keyName: `.thread-${THREAD_ID}`, env: threadServerEnv({ CCDM_SESSION_NAME: THREAD_SESSION }) });
  const threadText = await thread.instructions();
  assert.equal(threadText.split("\n\n").at(-1), relayInstructions("/pause, /unpause and /compact", ownSession));
});
