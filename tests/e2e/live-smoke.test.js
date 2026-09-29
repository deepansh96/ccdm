import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { cleanup, registerTeardownCallback } from "./support/teardown.js";

// Live Smoke Suite: the Router against real Discord, Claude, and Codex,
// mirroring the 2026-09-29 feasibility test. See "Live Smoke" in README.md.
const REQUIRED_LIVE_SECRETS = [
  "CCDM_LIVE_DISCORD_BOT_TOKEN",
  "CCDM_LIVE_DISCORD_CHANNEL_ID",
  "CCDM_LIVE_DISCORD_USER_ID",
];

const SOURCE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CLAUDE_PROJECT = "live-claude";
const CODEX_PROJECT = "live-codex";

function liveGateSkipReason() {
  const missingSecrets = REQUIRED_LIVE_SECRETS.filter((name) => !process.env[name]);
  if (process.env.CCDM_LIVE_E2E === "1" && missingSecrets.length === 0) return false;
  return `live smoke skipped; missing gate or secrets: ${missingSecrets.join(", ") || "CCDM_LIVE_E2E"}`;
}

function waitMs(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Git-visible source files, as the local-fake Test Workspace copies them, so
// the live run never reads or writes the checkout's registry or state.
function copySource(repoDir) {
  const listed = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: SOURCE_ROOT,
    encoding: "utf8",
  });
  for (const relative of listed.split("\0").filter(Boolean)) {
    const source = path.join(SOURCE_ROOT, relative);
    if (!fs.existsSync(source) || !fs.statSync(source).isFile()) continue;
    const target = path.join(repoDir, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
    fs.chmodSync(target, fs.statSync(source).mode & 0o777);
  }
  fs.symlinkSync(path.join(SOURCE_ROOT, "node_modules"), path.join(repoDir, "node_modules"));
  for (const artifact of ["registry.json", ".env", "CLAUDE.local.md"]) {
    assert.ok(!fs.existsSync(path.join(repoDir, artifact)), `${artifact} leaked into the live workspace`);
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

// The session environment: the operator's own tools and provider logins, a
// private tmux server, and no Discord token of any kind.
function sessionEnv(live) {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (name.startsWith("CCDM_LIVE_") || /DISCORD_BOT_TOKEN|^BOT_TOKEN$|^TMUX|^CLAUDECODE$/.test(name)) delete env[name];
  }
  return {
    ...env,
    TMUX_TMPDIR: live.tmuxDir,
    CCDM_ROUTER_STATE_DIR: live.routerStateDir,
    CCDM_REGISTRY_PATH: live.registryFile,
    CCDM_REMINDER_STATE_DIR: live.reminderStateDir,
    ROOT_DISCORD_STATE_DIR: live.rootStateDir,
    CCDM_CLAUDE_LAUNCH_TIMEOUT_S: env.CCDM_CLAUDE_LAUNCH_TIMEOUT_S || "120",
    CCDM_CODEX_LAUNCH_TIMEOUT_S: env.CCDM_CODEX_LAUNCH_TIMEOUT_S || "180",
    ...(process.env.CCDM_LIVE_CODEX_HOME ? { CODEX_HOME: process.env.CCDM_LIVE_CODEX_HOME } : {}),
  };
}

function runCommand(live, command, args, { timeoutMs = 60000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: live.repoDir, env: sessionEnv(live), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    // A missing tool must fail the step, not hang cleanup.
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ exitCode: null, signal: null, stdout, stderr, output: `${stdout}${stderr}${error.message}` });
    });
    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      resolve({ exitCode, signal, stdout, stderr, output: `${stdout}${stderr}` });
    });
  });
}

function routerCli(live, args) {
  return runCommand(live, process.execPath, [path.join(live.repoDir, "scripts/router.js"), ...args]);
}

function readRegistry(live) {
  return JSON.parse(fs.readFileSync(live.registryFile, "utf8"));
}

// Every process whose command line or environment names this run's private
// directory: sessions, bridges, app-servers, and the Router.
function sweepProcesses(tmpRoot) {
  let rows = "";
  try {
    rows = execFileSync("ps", ["axeww", "-o", "pid=,command="], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return;
  }
  for (const row of rows.split("\n")) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(row);
    if (!match || Number(match[1]) === process.pid || !match[2].includes(tmpRoot)) continue;
    try {
      process.kill(Number(match[1]), "SIGTERM");
    } catch {
      // Already gone.
    }
  }
}

test(
  "live Router smoke: Claude and Codex round trips, webhook provenance, root mention, and cleanup",
  { skip: liveGateSkipReason(), timeout: 60 * 60 * 1000 },
  async (t) => {
    const require = createRequire(import.meta.url);
    const { DiscordError, discordRequest } = require(path.join(SOURCE_ROOT, "scripts/router/discord-rest.js"));
    const token = process.env.CCDM_LIVE_DISCORD_BOT_TOKEN;
    const ownerId = process.env.CCDM_LIVE_DISCORD_USER_ID;
    const discord = (method, route, options = {}) => discordRequest(method, route, { token, ...options });
    const ownerWaitMs = waitMs("CCDM_LIVE_OWNER_WAIT_MS", 10 * 60 * 1000);
    const replyWaitMs = waitMs("CCDM_LIVE_REPLY_WAIT_MS", 5 * 60 * 1000);
    const quietMs = waitMs("CCDM_LIVE_QUIET_MS", 30 * 1000);
    const say = (line) => {
      t.diagnostic(line);
      process.stderr.write(`[live-smoke] ${line}\n`);
    };

    // Everything this run creates, for the leftover check after cleanup.
    const created = { channels: [], webhooks: [] };
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ccdm-live-"));
    const live = {
      tmpRoot,
      repoDir: path.join(tmpRoot, "repo"),
      registryFile: path.join(tmpRoot, "repo", "registry.json"),
      routerStateDir: path.join(tmpRoot, "router"),
      rootStateDir: path.join(tmpRoot, "root-discord"),
      reminderStateDir: path.join(tmpRoot, "reminders"),
      tmuxDir: path.join(tmpRoot, "tmux"),
    };
    registerTeardownCallback(() => fs.rmSync(tmpRoot, { force: true, recursive: true }));
    registerTeardownCallback(() => sweepProcesses(tmpRoot));
    registerTeardownCallback(() => runCommand(live, "tmux", ["kill-server"], { timeoutMs: 10000 }));

    const deleteQuietly = async (route) => {
      try {
        await discord("DELETE", route);
      } catch (error) {
        if (!(error instanceof DiscordError && error.status === 404)) throw error;
      }
    };
    const gone = async (route) => {
      try {
        await discord("GET", route);
        return false;
      } catch (error) {
        if (error instanceof DiscordError && error.status === 404) return true;
        throw error;
      }
    };

    let failure = null;
    try {
      for (const dir of [live.repoDir, live.routerStateDir, live.rootStateDir, live.reminderStateDir, live.tmuxDir]) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      }
      copySource(live.repoDir);
      // The Router's one credential, private to this run.
      fs.writeFileSync(path.join(live.rootStateDir, ".env"), `DISCORD_BOT_TOKEN=${token}\n`, { mode: 0o600 });

      const anchor = await discord("GET", `/channels/${process.env.CCDM_LIVE_DISCORD_CHANNEL_ID}`);
      const bot = await discord("GET", "/users/@me");
      const suffix = Date.now().toString(36);
      const createChannel = async (name) => {
        const channel = await discord("POST", `/guilds/${anchor.guild_id}/channels`, {
          body: {
            name,
            type: 0,
            topic: "Throwaway CCDM live smoke channel; deleted when the test ends.",
            ...(anchor.parent_id ? { parent_id: anchor.parent_id } : {}),
          },
        });
        created.channels.push(channel.id);
        registerTeardownCallback(() => deleteQuietly(`/channels/${channel.id}`));
        return channel;
      };
      const claudeChannel = await createChannel(`ccdm-live-claude-${suffix}`);
      const codexChannel = await createChannel(`ccdm-live-codex-${suffix}`);
      say(`created #${claudeChannel.name} and #${codexChannel.name}`);

      const projectDir = (name) => {
        const dir = path.join(tmpRoot, "projects", name);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "README.md"), "Throwaway CCDM live smoke project.\n");
        return dir;
      };
      fs.writeFileSync(live.registryFile, `${JSON.stringify({
        discord_user_id: ownerId,
        guild_id: anchor.guild_id,
        root_channels: [],
        root_allowed_user_ids: [],
        pool: [],
        projects: {
          [CLAUDE_PROJECT]: {
            path: projectDir(CLAUDE_PROJECT),
            screen_name: `ccdm_live_claude_${suffix}`,
            channel_id: claudeChannel.id,
            type: "claude",
            transport: "router",
            pid: null,
            session_id: null,
            ...(process.env.CCDM_LIVE_CLAUDE_HOME ? { claude_home: process.env.CCDM_LIVE_CLAUDE_HOME } : {}),
          },
          [CODEX_PROJECT]: {
            path: projectDir(CODEX_PROJECT),
            screen_name: `ccdm_live_codex_${suffix}`,
            channel_id: codexChannel.id,
            type: "codex",
            transport: "router",
            ws_port: await freePort(),
            pid: null,
            session_id: null,
          },
        },
      }, null, 2)}\n`, { mode: 0o600 });

      // 1. A real Router.
      const routerLog = path.join(tmpRoot, "router.log");
      const logFd = fs.openSync(routerLog, "a", 0o600);
      const router = spawn(process.execPath, [path.join(live.repoDir, "scripts/router.js"), "serve"], {
        cwd: live.repoDir, env: sessionEnv(live), detached: true, stdio: ["ignore", logFd, logFd],
      });
      fs.closeSync(logFd);
      const routerExited = new Promise((resolve) => router.once("exit", resolve));
      registerTeardownCallback(async () => {
        try {
          process.kill(-router.pid, "SIGTERM");
        } catch {
          return;
        }
        await Promise.race([routerExited, sleep(5000)]);
      });
      const routerOutput = () => fs.readFileSync(routerLog, "utf8");
      const readyBy = Date.now() + 60000;
      while (!/router ready/.test(routerOutput())) {
        assert.ok(router.exitCode === null && Date.now() < readyBy, `Router never became ready:\n${routerOutput()}`);
        await sleep(250);
      }

      // 2. Each throwaway project's webhook, deleted again on cleanup.
      for (const project of [CLAUDE_PROJECT, CODEX_PROJECT]) {
        registerTeardownCallback(() => routerCli(live, ["delete-webhook", project]));
        const ensured = await routerCli(live, ["ensure-webhook", project]);
        assert.equal(ensured.exitCode, 0, ensured.output);
        assert.match(ensured.stdout, new RegExp(`^created webhook ccdm-${project} id=\\d+$`, "m"));
        created.webhooks.push(readRegistry(live).projects[project].webhook_id);
      }

      // Root, as a Router client, to see where a bot mention goes.
      fs.mkdirSync(path.join(live.routerStateDir, "keys"), { recursive: true, mode: 0o700 });
      const rootKey = "live-smoke-root-key";
      fs.writeFileSync(path.join(live.routerStateDir, "keys/.root.key"), `${rootKey}\n`, { mode: 0o600 });
      const { RouterClient } = require(path.join(live.repoDir, "scripts/router/client.js"));
      const root = new RouterClient({ socketPath: path.join(live.routerStateDir, "router.sock"), key: rootKey, role: "root" });
      const rootEvents = [];
      root.on("event", (event) => rootEvents.push(event));
      await root.connect();
      registerTeardownCallback(() => root.close());

      // 3. The real sessions. The Claude launch only reports the Router hello
      // after it auto-accepted the real development-channel confirmation.
      registerTeardownCallback(() => runCommand(live, path.join(live.repoDir, "scripts/stop-session.sh"), [CLAUDE_PROJECT]));
      const claude = await runCommand(live, path.join(live.repoDir, "scripts/start-session.sh"), [CLAUDE_PROJECT], { timeoutMs: 180000 });
      assert.equal(claude.exitCode, 0, claude.output);
      assert.match(claude.stdout, new RegExp(`^Channel server connected to the Router \\(scope ${claudeChannel.id}\\)$`, "m"));
      registerTeardownCallback(() => runCommand(live, path.join(live.repoDir, "scripts/stop-session.sh"), [CODEX_PROJECT]));
      const codex = await runCommand(live, path.join(live.repoDir, "scripts/start-codex-session.sh"), [CODEX_PROJECT], { timeoutMs: 240000 });
      assert.equal(codex.exitCode, 0, codex.output);
      assert.match(codex.stdout, new RegExp(`^Bridge connected to the Router \\(scope ${codexChannel.id}\\)$`, "m"));

      const status = await routerCli(live, ["status", "--json"]);
      assert.equal(status.exitCode, 0, status.output);
      const sessions = JSON.parse(status.stdout).sessions.map((session) => [session.role, session.project, session.scope.channel_id ?? null]);
      for (const expected of [["project", CLAUDE_PROJECT, claudeChannel.id], ["project", CODEX_PROJECT, codexChannel.id]]) {
        assert.ok(sessions.some((row) => JSON.stringify(row) === JSON.stringify(expected)), JSON.stringify(sessions));
      }
      // No session environment, launch file, or MCP config holds the bot token.
      let leaked = "";
      try {
        leaked = execFileSync("grep", ["-rlF", "--", token, live.routerStateDir, live.reminderStateDir, live.repoDir], { encoding: "utf8" });
      } catch {
        // grep exits non-zero when nothing matches.
      }
      assert.equal(leaked, "");

      const askOwner = async (channelId, text) => (await discord("POST", `/channels/${channelId}/messages`, {
        body: { content: `<@${ownerId}> ${text}`, allowed_mentions: { users: [ownerId] } },
      })).id;
      const waitForMessage = async (channelId, afterId, matches, describe, timeoutMs) => {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          const messages = await discord("GET", `/channels/${channelId}/messages`, { query: { after: afterId, limit: 50 } });
          const found = messages.reverse().find(matches);
          if (found) return found;
          await sleep(2000);
        }
        throw new Error(`Timed out after ${timeoutMs}ms waiting for ${describe}`);
      };

      // 4. One owner round trip each, with an attachment, answered through the
      // project's own webhook under its Project Identity.
      const roundTrip = async (channel, project, usernamePattern) => {
        say(`waiting for the owner in #${channel.name}`);
        const promptId = await askOwner(channel.id,
          "Live smoke: send `Reply with only the file name of the attachment.` here with any small file attached.");
        const owner = await waitForMessage(channel.id, promptId,
          (message) => message.author.id === ownerId && message.attachments.length > 0,
          `the owner's message with an attachment in #${channel.name}`, ownerWaitMs);
        const filename = owner.attachments[0].filename;
        const reply = await waitForMessage(channel.id, owner.id,
          (message) => message.webhook_id && message.content.includes(filename),
          `a ${project} reply naming ${filename}`, replyWaitMs);
        assert.equal(reply.webhook_id, readRegistry(live).projects[project].webhook_id);
        assert.match(reply.author.username, usernamePattern);
        say(`${project} replied as ${reply.author.username}`);
      };
      await roundTrip(claudeChannel, CLAUDE_PROJECT, /^live-claude-claude( · \d+%)?$/);
      await roundTrip(codexChannel, CODEX_PROJECT, /^live-codex-codex( · \d+%)?$/);

      // 5. A bot mention in a project channel reaches root, and the project
      // session never answers it.
      say(`waiting for the owner to mention the bot in #${claudeChannel.name}`);
      const mentionPromptId = await askOwner(claudeChannel.id,
        `Live smoke: now send a message here that mentions <@${bot.id}>, for example \`@${bot.username} live smoke root ping\`.`);
      const mention = await waitForMessage(claudeChannel.id, mentionPromptId,
        (message) => message.author.id === ownerId && message.mentions.some((user) => user.id === bot.id),
        `the owner's bot mention in #${claudeChannel.name}`, ownerWaitMs);
      const reachedRootBy = Date.now() + 30000;
      while (!rootEvents.some((event) => event.event === "message" && event.message_id === mention.id)) {
        assert.ok(Date.now() < reachedRootBy, `the mention never reached root: ${JSON.stringify(rootEvents)}`);
        await sleep(250);
      }
      const rootCopy = rootEvents.find((event) => event.message_id === mention.id);
      assert.equal(rootCopy.channel_id, claudeChannel.id);
      assert.equal(rootCopy.author.id, ownerId);
      await sleep(quietMs);
      const after = await discord("GET", `/channels/${claudeChannel.id}/messages`, { query: { after: mention.id, limit: 50 } });
      assert.deepEqual(after.filter((message) => message.webhook_id).map((message) => message.content), []);
      say("the mention reached root only");
    } catch (error) {
      failure = error;
    }

    // 6. Cleanup runs on success and failure alike; then nothing may be left.
    await cleanup();
    const leftovers = [];
    for (const id of created.channels) if (!(await gone(`/channels/${id}`))) leftovers.push(`channel ${id}`);
    for (const id of created.webhooks) if (!(await gone(`/webhooks/${id}`))) leftovers.push(`webhook ${id}`);
    if (fs.existsSync(tmpRoot)) leftovers.push(`private state ${tmpRoot}`);
    if (failure && leftovers.length > 0) failure.message += `\nleft behind: ${leftovers.join(", ")}`;
    if (failure) throw failure;
    assert.deepEqual(leftovers, []);
  },
);
