import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createWorkspace, runScript } from "./support/runner.js";
import { readState, writeState } from "./support/state.js";
import { cleanup, registerTeardownCallback } from "./support/teardown.js";

test.afterEach(async () => {
  await cleanup();
});

async function startPosterApi({ organization = { organization_type: "pro" }, unauthorizedTokens = [], acceptDashboard = false, usage = {} } = {}) {
  const requests = [];
  const unauthorized = new Set(unauthorizedTokens);
  const server = http.createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      requests.push({
        authorization: request.headers.authorization,
        body,
        contentType: request.headers["content-type"],
        method: request.method,
        path: request.url,
        userAgent: request.headers["user-agent"],
      });

      if (request.method === "GET" && request.url === "/api/oauth/profile") {
        if (unauthorized.has(request.headers.authorization?.replace(/^Bearer /, ""))) {
          response.statusCode = 401;
          response.end();
          return;
        }
        if (request.headers.authorization !== "Bearer fixture-oauth-token") {
          response.statusCode = 401;
          response.end();
          return;
        }
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({
          account: {
            display_name: "Fixture User",
            email: "fixture@example.test",
          },
          organization,
        }));
        return;
      }
      if (request.method === "GET" && request.url === "/api/oauth/usage") {
        if (unauthorized.has(request.headers.authorization?.replace(/^Bearer /, ""))) {
          response.statusCode = 401;
          response.end();
          return;
        }
        if (request.headers.authorization !== "Bearer fixture-oauth-token") {
          response.statusCode = 401;
          response.end();
          return;
        }
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({
          extra_usage: { is_enabled: true, used_credits: 1250 },
          five_hour: { utilization: 37 },
          seven_day: { utilization: 62 },
          ...usage,
        }));
        return;
      }
      if (request.method === "POST" && request.url === "/api/v10/channels/fixture-channel/messages") {
        if (acceptDashboard && request.headers["content-type"]?.startsWith("multipart/form-data;")) {
          if (
            request.headers.authorization !== "Bot fixture-root-token" ||
            !request.headers["content-type"].includes("boundary=") ||
            !body.includes('name="payload_json"') ||
            !body.includes('filename="usage-dashboard.png"') ||
            !body.includes("Content-Type: image/png")
          ) {
            response.statusCode = 401;
            response.end();
            return;
          }
          response.statusCode = 200;
          response.setHeader("content-type", "application/json");
          response.end(JSON.stringify({ id: "dashboard-1" }));
          return;
        }
        let payload;
        try {
          payload = JSON.parse(body);
        } catch {
          response.statusCode = 400;
          response.end();
          return;
        }
        if (
          request.headers.authorization !== "Bot fixture-root-token" ||
          request.headers["content-type"] !== "application/json" ||
          !Array.isArray(payload.embeds) ||
          payload.embeds.length !== 1
        ) {
          response.statusCode = 401;
          response.end();
          return;
        }
        response.statusCode = 200;
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ id: "message-1" }));
        return;
      }
      response.statusCode = 404;
      response.end("not found");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  registerTeardownCallback(async () => {
    await new Promise((resolve) => server.close(resolve));
  });
  const address = server.address();
  return { baseUrl: `http://127.0.0.1:${address.port}`, requests };
}

function seedPosterWorkspace(workspace, baseUrl, extraConfig = {}) {
  fs.writeFileSync(
    path.join(workspace.repoDir, ".usage-stats-poster.json"),
    `${JSON.stringify({
      discord_channel_id: "fixture-channel",
      anthropic_base_url: baseUrl,
      discord_base_url: baseUrl,
      ...extraConfig,
    }, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(workspace.repoDir, "registry.json"),
    `${JSON.stringify({
      pool: [{ id: "bot1", token: "fixture-root-token" }],
      projects: {},
    }, null, 2)}\n`,
  );
  const state = readState(workspace.stateDir);
  state.fixtures.security = {
    credentials: {
      "Claude Code-credentials": {
        claudeAiOauth: { accessToken: "fixture-oauth-token" },
      },
    },
    invocations: [],
  };
  writeState(state, workspace.stateDir);
}

test("poster posts a Claude usage embed through the configured Discord endpoint", async () => {
  const workspace = createWorkspace();
  const api = await startPosterApi();
  seedPosterWorkspace(workspace, api.baseUrl);

  const result = await runScript(workspace, "scripts/usage-stats-poster.py", { cwd: workspace.tmpDir });

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Posted \(message ID: message-1\)/);
  const post = api.requests.find((request) => request.method === "POST");
  assert.ok(post);
  assert.equal(post.authorization, "Bot fixture-root-token");
  assert.equal(post.userAgent, "ccdm-usage-stats-poster/1.0");
  const payload = JSON.parse(post.body);
  assert.equal(payload.embeds[0].title, "Usage Report");
  assert.deepEqual(payload.embeds[0].fields, [
    {
      name: "Claude Code",
      value: "**Personal** (Pro)\n5-Hour: `[######.........]` **37%**\n7-Day: `[#########......]` **62%**\nExtra usage: **$12.50** spent",
      inline: true,
    },
  ]);
  assert.deepEqual(
    api.requests.map(({ method, path: requestPath }) => ({ method, path: requestPath })),
    [
      { method: "GET", path: "/api/oauth/profile" },
      { method: "GET", path: "/api/oauth/usage" },
      { method: "POST", path: "/api/v10/channels/fixture-channel/messages" },
    ],
  );
  assert.deepEqual(readState(workspace.stateDir).fixtures.security.invocations.map((entry) => entry.args), [
    ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
  ]);
});

test("manual JSON posting does not open or write the configured history database", async () => {
  const workspace = createWorkspace();
  const api = await startPosterApi();
  const sharedParent = path.join(workspace.homeDir, "shared-state");
  const historyPath = path.join(sharedParent, "usage.sqlite3");
  fs.mkdirSync(sharedParent);
  fs.chmodSync(sharedParent, 0o755);
  seedPosterWorkspace(workspace, api.baseUrl, { history_db_path: historyPath });

  const result = await runScript(workspace, "scripts/usage-stats-poster.py");

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.equal(fs.existsSync(historyPath), false);
  assert.equal(fs.existsSync(path.join(sharedParent, ".history.lock")), false);
  assert.equal(fs.statSync(sharedParent).mode & 0o777, 0o755);
  assert.equal(api.requests.filter((request) => request.method === "POST").length, 1);
});

test("missing or malformed Claude utilization is recorded as unavailable", async () => {
  const workspace = createWorkspace();
  const api = await startPosterApi({
    usage: { five_hour: {}, seven_day: { utilization: "not-a-number" } },
  });
  const historyPath = path.join(workspace.homeDir, "history", "history.sqlite3");
  seedPosterWorkspace(workspace, api.baseUrl, { history_db_path: historyPath });

  const result = await runScript(workspace, "scripts/usage-stats-poster.py", { args: ["--collect-only"] });

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  const payloadProbe = spawnSync("python3", ["-c", [
    "import sqlite3, sys",
    "connection = sqlite3.connect(sys.argv[1])",
    "print(connection.execute('select payload_json from snapshots').fetchone()[0])",
  ].join("\n"), historyPath], { encoding: "utf8" });
  assert.equal(payloadProbe.status, 0, payloadProbe.stderr);
  assert.match(payloadProbe.stdout, /\"available\":false/);
  assert.doesNotMatch(payloadProbe.stdout, /\"used_percent\":0/);
});

test("history store preserves shared parents and rejects unsupported schemas and symlink paths", async () => {
  const workspace = createWorkspace();
  const api = await startPosterApi();
  const sharedParent = path.join(workspace.homeDir, "shared");
  const featureDir = path.join(sharedParent, "usage-stats");
  const historyPath = path.join(featureDir, "history.sqlite3");
  fs.mkdirSync(sharedParent);
  fs.chmodSync(sharedParent, 0o755);
  seedPosterWorkspace(workspace, api.baseUrl, { history_db_path: historyPath });
  const collected = await runScript(workspace, "scripts/usage-stats-poster.py", { args: ["--collect-only"] });
  assert.equal(collected.exitCode, 0, collected.stderr || collected.stdout);
  assert.equal(fs.statSync(sharedParent).mode & 0o777, 0o755);
  assert.equal(fs.statSync(featureDir).mode & 0o777, 0o700);

  const probe = (code, ...args) => spawnSync("python3", ["-c", [
    "import importlib.util, sys",
    "spec = importlib.util.spec_from_file_location('poster', sys.argv[1])",
    "poster = importlib.util.module_from_spec(spec); spec.loader.exec_module(poster)",
    code,
  ].join("\n"), path.join("scripts", "usage-stats-poster.py"), ...args], { encoding: "utf8" });
  const schemaDir = path.join(workspace.tmpDir, "schema");
  fs.mkdirSync(schemaDir, 0o700);
  const unsupportedDb = path.join(schemaDir, "unsupported.sqlite3");
  const created = spawnSync("python3", ["-c", [
    "import sqlite3, sys",
    "connection = sqlite3.connect(sys.argv[1]); connection.execute('pragma user_version=99'); connection.commit()",
  ].join("\n"), unsupportedDb], { encoding: "utf8" });
  assert.equal(created.status, 0, created.stderr);
  const schemaFailure = probe(
    "try:\n with poster.HistoryStore(sys.argv[2]).locked(): pass\nexcept poster.PosterError as error:\n print(error); raise SystemExit(1)",
    unsupportedDb,
  );
  assert.equal(schemaFailure.status, 1);
  assert.match(schemaFailure.stdout, /unsupported usage history schema version 99/);

  const legacyDb = path.join(schemaDir, "legacy-v0.sqlite3");
  const legacy = spawnSync("python3", ["-c", [
    "import sqlite3, sys",
    "connection = sqlite3.connect(sys.argv[1])",
    "connection.executescript('CREATE TABLE snapshots (slot_utc TEXT PRIMARY KEY, generated_at TEXT NOT NULL, payload_json TEXT NOT NULL); CREATE TABLE posts (slot_utc TEXT PRIMARY KEY, posted_at TEXT NOT NULL, message_id TEXT NOT NULL); CREATE TABLE warnings (warning_key TEXT PRIMARY KEY, warned_at TEXT NOT NULL);')",
    "connection.execute(\"insert into snapshots values (?, ?, ?)\", ('2026-08-18T12:00:00Z', '2026-08-18T12:00:00Z', '{\\\"generated_at\\\":\\\"2026-08-18T12:00:00Z\\\",\\\"cards\\\":[]}'))",
    "connection.commit()",
  ].join("\n"), legacyDb], { encoding: "utf8" });
  assert.equal(legacy.status, 0, legacy.stderr);
  const migrated = probe(
    "try:\n with poster.HistoryStore(sys.argv[2]).locked(): pass\nexcept poster.PosterError as error:\n print(error); raise SystemExit(1)",
    legacyDb,
  );
  assert.equal(migrated.status, 0, migrated.stderr || migrated.stdout);
  const migrationProbe = spawnSync("python3", ["-c", [
    "import sqlite3, sys",
    "connection = sqlite3.connect(sys.argv[1])",
    "print(connection.execute('pragma user_version').fetchone()[0])",
    "print(connection.execute('select payload_json from snapshots').fetchone()[0])",
  ].join("\n"), legacyDb], { encoding: "utf8" });
  assert.equal(migrationProbe.status, 0, migrationProbe.stderr);
  assert.match(migrationProbe.stdout, /^1\n/);
  assert.match(migrationProbe.stdout, /cards/);

  const atomicInitialization = probe(
    "import sqlite3\nconnection = sqlite3.connect(':memory:')\ncreated = [0]\ndef authorize(action, arg1, arg2, database, source):\n if action == sqlite3.SQLITE_CREATE_TABLE:\n  created[0] += 1\n  if created[0] == 2:\n   return sqlite3.SQLITE_DENY\n return sqlite3.SQLITE_OK\nconnection.set_authorizer(authorize)\ntry:\n poster.HistoryStore._validate_schema(None, connection)\nexcept poster.PosterError as error:\n print(error)\nelse:\n raise SystemExit(2)\nconnection.set_authorizer(lambda *args: sqlite3.SQLITE_OK)\nprint(connection.execute(\"select count(*) from sqlite_master where type = 'table' and name not like 'sqlite_%'\").fetchone()[0])\nprint(connection.execute('pragma user_version').fetchone()[0])",
    path.join(schemaDir, "atomic-probe.sqlite3"),
  );
  assert.equal(atomicInitialization.status, 0, atomicInitialization.stderr);
  assert.match(atomicInitialization.stdout, /unable to initialize usage history schema atomically/);
  assert.match(atomicInitialization.stdout, /\n0\n0\s*$/);

  const deniedOpen = probe(
    "def denied(*args, **kwargs):\n raise PermissionError('fixture lock permission denied')\nposter.os.open = denied\ntry:\n with poster.HistoryStore(sys.argv[2]).locked(): pass\nexcept poster.PosterError as error:\n print(error); raise SystemExit(1)",
    path.join(workspace.tmpDir, "permission", "history.sqlite3"),
  );
  assert.equal(deniedOpen.status, 1);
  assert.match(deniedOpen.stdout, /unable to open usage history lock/);

  const deniedFchmod = probe(
    "closed = []\nreal_close = poster.os.close\ndef tracked_close(fd):\n closed.append(fd)\n return real_close(fd)\nposter.os.close = tracked_close\ndef denied(*args, **kwargs):\n raise PermissionError('fixture fchmod permission denied')\nposter.os.fchmod = denied\ntry:\n with poster.HistoryStore(sys.argv[2]).locked(): pass\nexcept poster.PosterError as error:\n print(error)\nprint('closed', len(closed))",
    path.join(workspace.tmpDir, "fchmod-permission", "history.sqlite3"),
  );
  assert.equal(deniedFchmod.status, 0);
  assert.match(deniedFchmod.stdout, /unable to open usage history lock/);
  assert.match(deniedFchmod.stdout, /closed 1/);

  const deniedFlock = probe(
    "def denied(*args, **kwargs):\n raise PermissionError('fixture flock permission denied')\nposter.fcntl.flock = denied\ntry:\n with poster.HistoryStore(sys.argv[2]).locked(): pass\nexcept poster.PosterError as error:\n print(error); raise SystemExit(1)",
    path.join(workspace.tmpDir, "flock-permission", "history.sqlite3"),
  );
  assert.equal(deniedFlock.status, 1);
  assert.match(deniedFlock.stdout, /unable to acquire usage history lock/);

  const deniedUnlock = probe(
    "closed = []\nreal_close = poster.os.close\ndef tracked_close(fd):\n closed.append(fd)\n return real_close(fd)\nposter.os.close = tracked_close\nreal_flock = poster.fcntl.flock\ndef deny_unlock(fd, operation):\n if operation == poster.fcntl.LOCK_UN:\n  raise PermissionError('fixture unlock permission denied')\n return real_flock(fd, operation)\nposter.fcntl.flock = deny_unlock\ntry:\n with poster.HistoryStore(sys.argv[2]).locked(): pass\nexcept poster.PosterError as error:\n print(error)\nprint('closed', len(closed))",
    path.join(workspace.tmpDir, "unlock-permission", "history.sqlite3"),
  );
  assert.equal(deniedUnlock.status, 0);
  assert.match(deniedUnlock.stdout, /unable to release usage history lock/);
  assert.match(deniedUnlock.stdout, /closed [2-9]/);

  const targetDir = path.join(workspace.tmpDir, "real-history");
  fs.mkdirSync(targetDir);
  const ancestorAlias = path.join(workspace.tmpDir, "history-alias");
  fs.symlinkSync(targetDir, ancestorAlias, "dir");
  const ancestorFailure = probe(
    "try:\n with poster.HistoryStore(sys.argv[2]).locked(): pass\nexcept poster.PosterError as error:\n print(error); raise SystemExit(1)",
    path.join(ancestorAlias, "history.sqlite3"),
  );
  assert.equal(ancestorFailure.status, 1);
  assert.match(ancestorFailure.stdout, /cannot contain symlink/);

  const lockDir = path.join(workspace.tmpDir, "lock-history");
  fs.mkdirSync(lockDir, 0o700);
  fs.symlinkSync(path.join(workspace.tmpDir, "lock-target"), path.join(lockDir, ".history.lock"));
  const lockFailure = probe(
    "try:\n with poster.HistoryStore(sys.argv[2]).locked(): pass\nexcept poster.PosterError as error:\n print(error); raise SystemExit(1)",
    path.join(lockDir, "history.sqlite3"),
  );
  assert.equal(lockFailure.status, 1);
  assert.match(lockFailure.stdout, /cannot contain symlink/);
});

test("dashboard image read failures are surfaced as PosterError", () => {
  const missingImage = path.join(os.tmpdir(), `ccdm-missing-dashboard-${process.pid}.png`);
  const probe = spawnSync("python3", ["-c", [
    "import importlib.util, sys",
    "spec = importlib.util.spec_from_file_location('poster', sys.argv[1])",
    "poster = importlib.util.module_from_spec(spec); spec.loader.exec_module(poster)",
    "from datetime import datetime, timezone",
    "try:",
    " poster.post_dashboard_to_discord({'discord_base_url': 'http://127.0.0.1:1', 'discord_channel_id': 'x'}, 'token', sys.argv[2], datetime.now(timezone.utc))",
    "except poster.PosterError as error:",
    " print(error); raise SystemExit(0)",
    "raise SystemExit(2)",
  ].join("\n"), path.join("scripts", "usage-stats-poster.py"), missingImage], { encoding: "utf8" });
  assert.equal(probe.status, 0, probe.stderr || probe.stdout);
  assert.match(probe.stdout, /unable to read rendered usage dashboard image/);
});

test("Codex structured metrics reject invalid percentages and preserve numeric reset epochs", () => {
  const probe = spawnSync("python3", ["-c", [
    "import importlib.util, json, math, sys",
    "spec = importlib.util.spec_from_file_location('poster', sys.argv[1])",
    "poster = importlib.util.module_from_spec(spec); spec.loader.exec_module(poster)",
    "invalid = []",
    "for value in (True, float('nan'), float('inf'), float('-inf'), 10 ** 1000, 'not-a-number'):",
    " metric = poster._metric_from_codex_rate_limits({'primary': {'usedPercent': value, 'resetsAt': 1735689600}}, 'fixture')",
    " invalid.append(metric['limits'][0])",
    "legacy = [poster.format_codex_rate_limits({'primary': {'usedPercent': value}}, 'fixture') for value in (True, float('nan'), float('inf'), float('-inf'), 10 ** 1000, 'not-a-number')]",
    "valid = poster._metric_from_codex_rate_limits({'primary': {'usedPercent': 25, 'resetsAt': 1735689600}}, 'fixture')",
    "safe = poster._safe_history_cards([{'provider': 'codex', 'account': 'fixture', 'limits': [{'window': '5-hour', 'available': True, 'used_percent': float('nan'), 'resets_at': 1735689600}]}])",
    "print(json.dumps({'invalid': invalid, 'legacy': legacy, 'valid': valid['limits'][0], 'safe': safe}))",
  ].join("\n"), path.join("scripts", "usage-stats-poster.py")], { encoding: "utf8" });
  assert.equal(probe.status, 0, probe.stderr);
  const result = JSON.parse(probe.stdout);
  for (const limit of result.invalid) {
    assert.equal(limit.available, false);
    assert.equal(limit.used_percent, null);
    assert.equal(limit.resets_at, "2025-01-01T00:00:00Z");
  }
  for (const text of result.legacy) {
    assert.match(text, /5-Hour: \*unavailable\*/);
    assert.doesNotMatch(text, /\*\*\s*(?:0|1|100)%/);
  }
  assert.equal(result.valid.available, true);
  assert.equal(result.valid.used_percent, 25);
  assert.equal(result.valid.resets_at, "2025-01-01T00:00:00Z");
  assert.equal(result.safe[0].available, false);
  assert.equal(Object.hasOwn(result.safe[0], "used_percent"), false);
  assert.equal(result.safe[0].resets_at, "2025-01-01T00:00:00Z");
});

test("poster discovers labeled extra Claude OAuth config directories with derived Keychain services", async () => {
  const workspace = createWorkspace();
  const api = await startPosterApi();
  const emailDir = path.join(workspace.homeDir, ".claude-email");
  const organizationDir = path.join(workspace.homeDir, ".claude-organization");
  fs.mkdirSync(emailDir);
  fs.mkdirSync(organizationDir);
  fs.writeFileSync(
    path.join(emailDir, ".claude.json"),
    `${JSON.stringify({ oauthAccount: { emailAddress: "fixture-email@example.test" } })}\n`,
  );
  fs.writeFileSync(
    path.join(organizationDir, ".claude.json"),
    `${JSON.stringify({ oauthAccount: { organizationName: "Fixture Organization" } })}\n`,
  );
  fs.mkdirSync(path.join(workspace.homeDir, ".claude-malformed"));
  fs.writeFileSync(path.join(workspace.homeDir, ".claude-malformed", ".claude.json"), "{broken\n");
  fs.writeFileSync(path.join(workspace.homeDir, ".claude-not-a-directory"), "fixture\n");
  seedPosterWorkspace(workspace, api.baseUrl);

  const serviceFor = (configDir) => `Claude Code-credentials-${crypto
    .createHash("sha256")
    .update(configDir)
    .digest("hex")
    .slice(0, 8)}`;
  const emailService = serviceFor(emailDir);
  const organizationService = serviceFor(organizationDir);
  const state = readState(workspace.stateDir);
  state.fixtures.security.credentials[emailService] = {
    claudeAiOauth: { accessToken: "fixture-oauth-token" },
  };
  state.fixtures.security.credentials[organizationService] = {
    claudeAiOauth: { accessToken: "fixture-oauth-token" },
  };
  writeState(state, workspace.stateDir);

  const result = await runScript(workspace, "scripts/usage-stats-poster.py");

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  const post = api.requests.find((request) => request.method === "POST");
  assert.ok(post);
  const claudeValue = JSON.parse(post.body).embeds[0].fields[0].value;
  assert.match(claudeValue, /\*\*Personal\*\* \(Pro\)/);
  assert.match(claudeValue, /\*\*fixture-email@example\.test\*\* \(Pro\)/);
  assert.match(claudeValue, /\*\*Fixture Organization\*\* \(Pro\)/);
  assert.deepEqual(
    readState(workspace.stateDir).fixtures.security.invocations.map((entry) => entry.service),
    ["Claude Code-credentials", emailService, organizationService],
  );
  assert.deepEqual(
    api.requests.filter((request) => request.method === "GET").map((request) => request.path),
    [
      "/api/oauth/profile",
      "/api/oauth/usage",
      "/api/oauth/profile",
      "/api/oauth/usage",
      "/api/oauth/profile",
      "/api/oauth/usage",
    ],
  );
});

test("poster gives each Claude OAuth HTTP 401 an account-specific login action", async () => {
  const workspace = createWorkspace();
  const api = await startPosterApi({
    unauthorizedTokens: ["fixture-personal-401", "fixture-login-401", "fixture-refresh-401"],
  });
  const loginDir = path.join(workspace.homeDir, ".claude-login");
  const refreshDir = path.join(workspace.homeDir, ".claude-refresh");
  fs.mkdirSync(loginDir);
  fs.mkdirSync(refreshDir);
  fs.writeFileSync(
    path.join(loginDir, ".claude.json"),
    `${JSON.stringify({ oauthAccount: { organizationName: "Fixture Login" } })}\n`,
  );
  fs.writeFileSync(
    path.join(refreshDir, ".claude.json"),
    `${JSON.stringify({ oauthAccount: { organizationName: "Fixture Refresh" } })}\n`,
  );
  seedPosterWorkspace(workspace, api.baseUrl);
  const serviceFor = (configDir) => `Claude Code-credentials-${crypto
    .createHash("sha256")
    .update(configDir)
    .digest("hex")
    .slice(0, 8)}`;
  const loginService = serviceFor(loginDir);
  const refreshService = serviceFor(refreshDir);
  const state = readState(workspace.stateDir);
  state.fixtures.security.credentials = {
    "Claude Code-credentials": {
      claudeAiOauth: { accessToken: "fixture-personal-401" },
    },
    [loginService]: {
      claudeAiOauth: { accessToken: "fixture-login-401" },
    },
    [refreshService]: {
      claudeAiOauth: { accessToken: "fixture-refresh-401", refreshToken: "fixture-refresh-token" },
    },
  };
  writeState(state, workspace.stateDir);

  const result = await runScript(workspace, "scripts/usage-stats-poster.py");

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  const post = api.requests.find((request) => request.method === "POST");
  assert.ok(post);
  const claudeValue = JSON.parse(post.body).embeds[0].fields[0].value;
  assert.match(claudeValue, /\*\*Personal\*\*[\s\S]*Needs re-login: `CLAUDE_CONFIG_DIR=~\/\.claude claude \/login`/);
  assert.match(claudeValue, /\*\*Fixture Login\*\*[\s\S]*Needs re-login: `CLAUDE_CONFIG_DIR=~\/\.claude-login claude \/login`/);
  assert.match(claudeValue, /\*\*Fixture Refresh\*\*[\s\S]*Auth expired — start a session on this account to refresh/);
  assert.deepEqual(
    readState(workspace.stateDir).fixtures.security.invocations.map((entry) => entry.service),
    ["Claude Code-credentials", loginService, refreshService],
  );
  assert.equal(api.requests.filter((request) => request.method === "GET").length, 3);
});

test("poster uses N/A when the Claude organization value is malformed", async () => {
  const workspace = createWorkspace();
  const api = await startPosterApi({ organization: ["not", "an", "object"] });
  seedPosterWorkspace(workspace, api.baseUrl);

  const result = await runScript(workspace, "scripts/usage-stats-poster.py", { cwd: workspace.tmpDir });

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  const post = api.requests.find((request) => request.method === "POST");
  assert.ok(post);
  assert.match(JSON.parse(post.body).embeds[0].fields[0].value, /^\*\*Personal\*\* \(N\/A\)/);
});

test("poster falls back when Codex JSON-RPC returns a non-object response", async () => {
  const workspace = createWorkspace();
  const api = await startPosterApi();
  const codexHome = path.join(workspace.homeDir, ".codex-non-object");
  fs.mkdirSync(codexHome);
  seedPosterWorkspace(workspace, api.baseUrl);
  fs.writeFileSync(
    path.join(workspace.repoDir, "registry.json"),
    `${JSON.stringify({
      codex_accounts: { "codex-non-object": codexHome },
      default_codex_account: "codex-non-object",
      pool: [{ id: "bot1", token: "fixture-root-token" }],
      projects: {},
    }, null, 2)}\n`,
  );
  const responsesPath = path.join(workspace.tmpDir, "codex-stdio-responses.json");
  fs.writeFileSync(responsesPath, `${JSON.stringify({
    [fs.realpathSync(codexHome)]: { mode: "non-object" },
  }, null, 2)}\n`);

  const result = await runScript(workspace, "scripts/usage-stats-poster.py", {
    env: { CCDM_TEST_CODEX_STDIO_RESPONSES: responsesPath },
  });

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  const post = api.requests.find((request) => request.method === "POST");
  assert.ok(post);
  const codexValue = JSON.parse(post.body).embeds[0].fields.find(({ name }) => name === "Codex").value;
  assert.match(codexValue, /\*\*codex-non-object\*\*/);
  assert.match(codexValue, /Live rate limits unavailable; no recent usage data/);
});

test("poster reads Codex JSON-RPC lines already buffered above the descriptor", async () => {
  const workspace = createWorkspace();
  const api = await startPosterApi();
  const codexHome = path.join(workspace.homeDir, ".codex-buffered");
  fs.mkdirSync(codexHome);
  seedPosterWorkspace(workspace, api.baseUrl);
  fs.writeFileSync(
    path.join(workspace.repoDir, "registry.json"),
    `${JSON.stringify({
      codex_accounts: { "codex-buffered": codexHome },
      default_codex_account: "codex-buffered",
      pool: [{ id: "bot1", token: "fixture-root-token" }],
      projects: {},
    }, null, 2)}\n`,
  );
  const responsesPath = path.join(workspace.tmpDir, "codex-stdio-responses.json");
  fs.writeFileSync(responsesPath, `${JSON.stringify({
    [fs.realpathSync(codexHome)]: {
      mode: "buffered",
      result: { rateLimits: { planType: "chatgpt", primary: { usedPercent: 27 } } },
    },
  }, null, 2)}\n`);

  const result = await runScript(workspace, "scripts/usage-stats-poster.py", {
    env: { CCDM_TEST_CODEX_STDIO_RESPONSES: responsesPath },
  });

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  const post = api.requests.find((request) => request.method === "POST");
  assert.ok(post);
  const codexValue = JSON.parse(post.body).embeds[0].fields.find(({ name }) => name === "Codex").value;
  assert.match(codexValue, /\*\*codex-buffered\*\* \(ChatGPT\)/);
  assert.match(codexValue, /27%/);
});

test("poster reports named Codex Accounts in default-first alphabetical order", async () => {
  const workspace = createWorkspace();
  const api = await startPosterApi();
  const defaultHome = path.join(workspace.homeDir, ".codex-default");
  const alphaHome = path.join(workspace.homeDir, ".codex-alpha");
  const premiumHome = path.join(workspace.homeDir, ".codex-premium");
  fs.mkdirSync(defaultHome);
  fs.mkdirSync(alphaHome);
  fs.mkdirSync(premiumHome);
  seedPosterWorkspace(workspace, api.baseUrl);
  fs.writeFileSync(
    path.join(workspace.repoDir, "registry.json"),
    `${JSON.stringify({
      codex_accounts: {
        "codex-premium": premiumHome,
        "codex-alpha": alphaHome,
        "codex-default": defaultHome,
      },
      default_codex_account: "codex-default",
      pool: [{ id: "bot1", token: "fixture-root-token" }],
      projects: {},
    }, null, 2)}\n`,
  );
  const responsesPath = path.join(workspace.tmpDir, "codex-stdio-responses.json");
  fs.writeFileSync(responsesPath, `${JSON.stringify({
    [fs.realpathSync(defaultHome)]: {
      rateLimits: { planType: "chatgpt", primary: { usedPercent: 12 }, secondary: { usedPercent: 34 } },
      rateLimitResetCredits: { availableCount: 2 },
    },
    [fs.realpathSync(alphaHome)]: { rateLimits: { planType: "chatgpt", primary: { usedPercent: 56 }, secondary: { usedPercent: 78 } } },
    [fs.realpathSync(premiumHome)]: { rateLimits: { planType: "chatgpt", primary: { usedPercent: 21 }, secondary: { usedPercent: 43 } } },
  }, null, 2)}\n`);

  const result = await runScript(workspace, "scripts/usage-stats-poster.py", {
    env: { CCDM_TEST_CODEX_STDIO_RESPONSES: responsesPath },
  });

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  const post = api.requests.find((request) => request.method === "POST");
  assert.ok(post);
  const payload = JSON.parse(post.body);
  assert.deepEqual(
    readState(workspace.stateDir).fixtures.codex.stdioInvocations.map(({ env }) => path.basename(env.CODEX_HOME)),
    [".codex-default", ".codex-alpha", ".codex-premium"],
  );
  assert.deepEqual(payload.embeds[0].fields.map(({ name }) => name), ["Claude Code", "Codex"]);
  const codexValue = payload.embeds[0].fields[1].value;
  assert.deepEqual(
    [...codexValue.matchAll(/\*\*(codex-[^*]+)\*\*/g)].map(([, label]) => label),
    ["codex-default", "codex-alpha", "codex-premium"],
  );
  assert.match(codexValue, /\*\*codex-default\*\* \(ChatGPT\)[\s\S]*12%/);
  assert.match(codexValue, /\*\*codex-alpha\*\* \(ChatGPT\)[\s\S]*56%/);
  assert.match(codexValue, /\*\*codex-premium\*\* \(ChatGPT\)[\s\S]*21%/);
  assert.match(codexValue, /\*\*codex-default\*\*[\s\S]*Full resets available: \*\*2\*\*/);
});

test("poster terminates a Codex process when stdout setup fails", async () => {
  const workspace = createWorkspace();
  const probe = path.join(workspace.repoDir, "codex-fd-cleanup-probe.py");
  fs.writeFileSync(
    probe,
    `#!/usr/bin/env python3
import runpy
from pathlib import Path

poster = runpy.run_path("scripts/usage-stats-poster.py", run_name="poster_fd_cleanup_probe")

class BrokenStdout:
    def fileno(self):
        raise OSError("fixture stdout fd failure")

class FakeStdin:
    def close(self):
        pass

class FakeProcess:
    def __init__(self):
        self.stdin = FakeStdin()
        self.stdout = BrokenStdout()
        self.terminated = 0
        self.killed = 0

    def terminate(self):
        self.terminated += 1

    def kill(self):
        self.killed += 1

    def wait(self, timeout=None):
        return 0

process = FakeProcess()
poster["subprocess"].Popen = lambda *args, **kwargs: process
assert poster["read_codex_rate_limits"](Path("/fixture/codex")) is None
assert process.terminated == 1
assert process.killed == 0
print("fd cleanup verified")
`,
  );
  fs.chmodSync(probe, 0o755);

  const result = await runScript(workspace, "codex-fd-cleanup-probe.py");

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /fd cleanup verified/);
});

test("poster deduplicates named aliases that share a Codex Home", async () => {
  const workspace = createWorkspace();
  const api = await startPosterApi();
  const sharedHome = path.join(workspace.homeDir, ".codex-shared");
  const otherHome = path.join(workspace.homeDir, ".codex-other");
  fs.mkdirSync(sharedHome);
  fs.mkdirSync(otherHome);
  seedPosterWorkspace(workspace, api.baseUrl);
  fs.writeFileSync(
    path.join(workspace.repoDir, "registry.json"),
    `${JSON.stringify({
      codex_accounts: {
        "codex-zulu": sharedHome,
        "codex-default": sharedHome,
        "codex-alpha": otherHome,
      },
      default_codex_account: "codex-default",
      pool: [{ id: "bot1", token: "fixture-root-token" }],
      projects: {},
    }, null, 2)}\n`,
  );
  const responsesPath = path.join(workspace.tmpDir, "codex-stdio-responses.json");
  fs.writeFileSync(responsesPath, `${JSON.stringify({
    [fs.realpathSync(sharedHome)]: { rateLimits: { planType: "chatgpt", primary: { usedPercent: 11 } } },
    [fs.realpathSync(otherHome)]: { rateLimits: { planType: "chatgpt", primary: { usedPercent: 22 } } },
  }, null, 2)}\n`);

  const result = await runScript(workspace, "scripts/usage-stats-poster.py", {
    env: { CCDM_TEST_CODEX_STDIO_RESPONSES: responsesPath },
  });

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  const post = api.requests.find((request) => request.method === "POST");
  assert.ok(post);
  const payload = JSON.parse(post.body);
  const codexValue = payload.embeds[0].fields.find(({ name }) => name === "Codex").value;
  assert.deepEqual(
    [...codexValue.matchAll(/\*\*(codex-[^*]+)\*\*/g)].map(([, label]) => label),
    ["codex-default", "codex-alpha"],
  );
  assert.equal(readState(workspace.stateDir).fixtures.codex.stdioInvocations.length, 2);
  assert.match(codexValue, /\*\*codex-default\*\*[\s\S]*11%/);
  assert.doesNotMatch(codexValue, /codex-zulu/);
});

test("poster falls back to raw Codex Homes in a legacy registry", async () => {
  const workspace = createWorkspace();
  const api = await startPosterApi();
  const sharedHome = path.join(workspace.homeDir, ".codex-legacy");
  const projectHome = path.join(workspace.homeDir, ".codex-project");
  fs.mkdirSync(sharedHome);
  fs.mkdirSync(projectHome);
  seedPosterWorkspace(workspace, api.baseUrl);
  fs.writeFileSync(
    path.join(workspace.repoDir, "registry.json"),
    `${JSON.stringify({
      codex_home: sharedHome,
      pool: [{ id: "bot1", token: "fixture-root-token" }],
      projects: { project: { codex_home: projectHome, type: "codex" } },
    }, null, 2)}\n`,
  );
  const responsesPath = path.join(workspace.tmpDir, "codex-stdio-responses.json");
  fs.writeFileSync(responsesPath, `${JSON.stringify({
    [fs.realpathSync(sharedHome)]: { rateLimits: { planType: "chatgpt", primary: { usedPercent: 31 } } },
    [fs.realpathSync(projectHome)]: { rateLimits: { planType: "chatgpt", primary: { usedPercent: 42 } } },
  }, null, 2)}\n`);

  const result = await runScript(workspace, "scripts/usage-stats-poster.py", {
    env: { CCDM_TEST_CODEX_STDIO_RESPONSES: responsesPath },
  });

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  const post = api.requests.find((request) => request.method === "POST");
  assert.ok(post);
  const codexValue = JSON.parse(post.body).embeds[0].fields.find(({ name }) => name === "Codex").value;
  assert.deepEqual(
    [...codexValue.matchAll(/\*\*(Legacy Codex Home(?: \d+)?)\*\*/g)].map(([, label]) => label),
    ["Legacy Codex Home", "Legacy Codex Home 2"],
  );
  assert.match(codexValue, /\*\*Legacy Codex Home\*\*[\s\S]*31%/);
  assert.match(codexValue, /\*\*Legacy Codex Home 2\*\*[\s\S]*42%/);
});

test("poster reports a missing configured Codex Home as unavailable", async () => {
  const workspace = createWorkspace();
  const api = await startPosterApi();
  const availableHome = path.join(workspace.homeDir, ".codex-available");
  const missingHome = path.join(workspace.homeDir, ".codex-missing");
  fs.mkdirSync(availableHome);
  seedPosterWorkspace(workspace, api.baseUrl);
  fs.writeFileSync(
    path.join(workspace.repoDir, "registry.json"),
    `${JSON.stringify({
      codex_accounts: { available: availableHome, missing: missingHome },
      default_codex_account: "missing",
      pool: [{ id: "bot1", token: "fixture-root-token" }],
      projects: {},
    }, null, 2)}\n`,
  );
  const responsesPath = path.join(workspace.tmpDir, "codex-stdio-responses.json");
  fs.writeFileSync(responsesPath, `${JSON.stringify({
    [fs.realpathSync(availableHome)]: { rateLimits: { planType: "chatgpt", primary: { usedPercent: 19 } } },
  }, null, 2)}\n`);

  const result = await runScript(workspace, "scripts/usage-stats-poster.py", {
    env: { CCDM_TEST_CODEX_STDIO_RESPONSES: responsesPath },
  });

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  const post = api.requests.find((request) => request.method === "POST");
  assert.ok(post);
  const codexValue = JSON.parse(post.body).embeds[0].fields.find(({ name }) => name === "Codex").value;
  assert.match(codexValue, /\*\*missing\*\*[\s\S]*Codex Home unavailable/);
  assert.match(codexValue, /\*\*available\*\*[\s\S]*19%/);
  assert.equal(readState(workspace.stateDir).fixtures.codex.stdioInvocations.length, 1);
});

test("poster falls back to recent Codex session tokens after a live rate-limit failure", async () => {
  const workspace = createWorkspace();
  const api = await startPosterApi();
  const codexHome = path.join(workspace.homeDir, ".codex-fallback");
  fs.mkdirSync(path.join(codexHome, "sessions"), { recursive: true });
  const secretLikeText = "fixture-secret-must-not-appear";
  fs.writeFileSync(
    path.join(codexHome, "sessions", "rollout-fixture.jsonl"),
    [
      "{partial",
      JSON.stringify({
        type: "event_msg",
        timestamp: new Date().toISOString(),
        payload: {
          type: "token_count",
          info: {
            last_token_usage: { total_tokens: 321, detail: secretLikeText },
            total_token_usage: { total_tokens: 654 },
          },
        },
      }),
      JSON.stringify({ payload: { type: "token_count", info: "corrupt" } }),
    ].join("\n") + "\n",
  );
  seedPosterWorkspace(workspace, api.baseUrl);
  fs.writeFileSync(
    path.join(workspace.repoDir, "registry.json"),
    `${JSON.stringify({
      codex_accounts: { "codex-fallback": codexHome },
      default_codex_account: "codex-fallback",
      pool: [{ id: "bot1", token: "fixture-root-token" }],
      projects: {},
    }, null, 2)}\n`,
  );
  const responsesPath = path.join(workspace.tmpDir, "codex-stdio-responses.json");
  fs.writeFileSync(responsesPath, `${JSON.stringify({
    [fs.realpathSync(codexHome)]: { mode: "error" },
  }, null, 2)}\n`);

  const result = await runScript(workspace, "scripts/usage-stats-poster.py", {
    env: { CCDM_TEST_CODEX_STDIO_RESPONSES: responsesPath },
  });

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  const post = api.requests.find((request) => request.method === "POST");
  assert.ok(post);
  const codexValue = JSON.parse(post.body).embeds[0].fields.find(({ name }) => name === "Codex").value;
  assert.match(codexValue, /\*\*codex-fallback\*\* \(Codex\)/);
  assert.match(codexValue, /Live rate limits unavailable/);
  assert.match(codexValue, /Last turn: \*\*321\*\* tokens/);
  assert.match(codexValue, /Session total: \*\*654\*\* tokens/);
  assert.doesNotMatch(codexValue, new RegExp(secretLikeText));
});

test("poster preserves stale rate-limit fallback age and ignores a newer malformed record", async () => {
  const workspace = createWorkspace();
  const api = await startPosterApi();
  const codexHome = path.join(workspace.homeDir, ".codex-stale-rate-limits");
  fs.mkdirSync(path.join(codexHome, "sessions"), { recursive: true });
  const now = Date.now();
  const staleTimestamp = new Date(now - 12 * 60 * 1000).toISOString();
  const newerTimestamp = new Date(now - 60 * 1000).toISOString();
  fs.writeFileSync(
    path.join(codexHome, "sessions", "rollout-fixture.jsonl"),
    [
      JSON.stringify({
        type: "event_msg",
        timestamp: staleTimestamp,
        payload: {
          type: "token_count",
          rate_limits: { planType: "chatgpt", primary: { usedPercent: 28 } },
        },
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: newerTimestamp,
        payload: { type: "token_count", rate_limits: { primary: {} } },
      }),
    ].join("\n") + "\n",
  );
  seedPosterWorkspace(workspace, api.baseUrl);
  fs.writeFileSync(
    path.join(workspace.repoDir, "registry.json"),
    `${JSON.stringify({
      codex_accounts: { "codex-stale-rate-limits": codexHome },
      default_codex_account: "codex-stale-rate-limits",
      pool: [{ id: "bot1", token: "fixture-root-token" }],
      projects: {},
    }, null, 2)}\n`,
  );
  const responsesPath = path.join(workspace.tmpDir, "codex-stdio-responses.json");
  fs.writeFileSync(responsesPath, `${JSON.stringify({
    [fs.realpathSync(codexHome)]: { mode: "error" },
  }, null, 2)}\n`);

  const result = await runScript(workspace, "scripts/usage-stats-poster.py", {
    env: { CCDM_TEST_CODEX_STDIO_RESPONSES: responsesPath },
  });

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  const post = api.requests.find((request) => request.method === "POST");
  assert.ok(post);
  const codexValue = JSON.parse(post.body).embeds[0].fields.find(({ name }) => name === "Codex").value;
  assert.match(codexValue, /28%/);
  assert.match(codexValue, /\*1[01-3]m ago\*/);
});

test("poster preserves stale token-count fallback age markers", async () => {
  const workspace = createWorkspace();
  const api = await startPosterApi();
  const codexHome = path.join(workspace.homeDir, ".codex-stale-token-count");
  fs.mkdirSync(path.join(codexHome, "sessions"), { recursive: true });
  const staleTimestamp = new Date(Date.now() - 11 * 60 * 1000).toISOString();
  fs.writeFileSync(
    path.join(codexHome, "sessions", "rollout-fixture.jsonl"),
    `${JSON.stringify({
      type: "event_msg",
      timestamp: staleTimestamp,
      payload: {
        type: "token_count",
        info: {
          last_token_usage: { total_tokens: 321 },
          total_token_usage: { total_tokens: 654 },
        },
      },
    })}\n`,
  );
  seedPosterWorkspace(workspace, api.baseUrl);
  fs.writeFileSync(
    path.join(workspace.repoDir, "registry.json"),
    `${JSON.stringify({
      codex_accounts: { "codex-stale-token-count": codexHome },
      default_codex_account: "codex-stale-token-count",
      pool: [{ id: "bot1", token: "fixture-root-token" }],
      projects: {},
    }, null, 2)}\n`,
  );
  const responsesPath = path.join(workspace.tmpDir, "codex-stdio-responses.json");
  fs.writeFileSync(responsesPath, `${JSON.stringify({
    [fs.realpathSync(codexHome)]: { mode: "error" },
  }, null, 2)}\n`);

  const result = await runScript(workspace, "scripts/usage-stats-poster.py", {
    env: { CCDM_TEST_CODEX_STDIO_RESPONSES: responsesPath },
  });

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  const post = api.requests.find((request) => request.method === "POST");
  assert.ok(post);
  const codexValue = JSON.parse(post.body).embeds[0].fields.find(({ name }) => name === "Codex").value;
  assert.match(codexValue, /Last turn: \*\*321\*\* tokens/);
  assert.match(codexValue, /\*1[01-3]m ago\*/);
});

test("poster discovers only registry Codex Homes, not ROOT_CODEX_HOME", async () => {
  const workspace = createWorkspace();
  const api = await startPosterApi();
  const configuredHome = path.join(workspace.homeDir, ".codex-configured");
  const leakedHome = path.join(workspace.homeDir, ".codex-leaked");
  fs.mkdirSync(configuredHome);
  fs.mkdirSync(leakedHome);
  seedPosterWorkspace(workspace, api.baseUrl);
  fs.writeFileSync(
    path.join(workspace.repoDir, "registry.json"),
    `${JSON.stringify({
      codex_accounts: { configured: configuredHome },
      default_codex_account: "configured",
      pool: [{ id: "bot1", token: "fixture-root-token" }],
      projects: {},
    }, null, 2)}\n`,
  );
  const responsesPath = path.join(workspace.tmpDir, "codex-stdio-responses.json");
  fs.writeFileSync(responsesPath, `${JSON.stringify({
    [fs.realpathSync(configuredHome)]: { rateLimits: { planType: "chatgpt", primary: { usedPercent: 17 } } },
  }, null, 2)}\n`);

  const result = await runScript(workspace, "scripts/usage-stats-poster.py", {
    env: {
      CCDM_TEST_CODEX_STDIO_RESPONSES: responsesPath,
      ROOT_CODEX_HOME: leakedHome,
    },
  });

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  const invocations = readState(workspace.stateDir).fixtures.codex.stdioInvocations;
  assert.deepEqual(invocations.map(({ env }) => path.basename(env.CODEX_HOME)), [".codex-configured"]);
  const post = api.requests.find((request) => request.method === "POST");
  assert.ok(post);
  const codexValue = JSON.parse(post.body).embeds[0].fields.find(({ name }) => name === "Codex").value;
  assert.match(codexValue, /\*\*configured\*\*[\s\S]*17%/);
  assert.doesNotMatch(codexValue, /leaked/);
});

test("poster reports malformed named Codex registry fields instead of degrading silently", async () => {
  const api = await startPosterApi();
  const cases = [
    {
      registry: { codex_accounts: [], default_codex_account: null },
      error: /codex_accounts must be an object mapping aliases to paths/,
    },
    {
      registry: { codex_accounts: { configured: "/fixture/codex" }, default_codex_account: 42 },
      error: /default_codex_account must be a non-empty alias or null/,
    },
    {
      registry: { codex_accounts: { configured: "/fixture/codex" }, default_codex_account: "missing" },
      error: /default_codex_account refers to unknown alias 'missing'/,
    },
    {
      registry: {
        codex_accounts: { configured: "/fixture/codex" },
        default_codex_account: "configured",
        codex_home: "/fixture/raw",
      },
      error: /cannot set both default_codex_account and top-level codex_home at the same scope/,
    },
    {
      registry: {
        codex_accounts: { configured: "/fixture/codex" },
        projects: { project: { codex_account: "missing" } },
      },
      error: /project 'project' codex_account refers to unknown alias 'missing'/,
    },
    {
      registry: {
        codex_accounts: { configured: "/fixture/codex" },
        projects: { project: { codex_account: "configured", codex_home: "/fixture/raw" } },
      },
      error: /project 'project' cannot set both codex_account and codex_home at the same scope/,
    },
  ];

  for (const { registry, error } of cases) {
    const workspace = createWorkspace();
    seedPosterWorkspace(workspace, api.baseUrl);
    fs.writeFileSync(
      path.join(workspace.repoDir, "registry.json"),
      `${JSON.stringify({
        ...registry,
        pool: [{ id: "bot1", token: "fixture-root-token" }],
        projects: registry.projects ?? {},
      }, null, 2)}\n`,
    );

    const result = await runScript(workspace, "scripts/usage-stats-poster.py");

    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, error);
    assert.equal(api.requests.filter((request) => request.method === "POST").length, 0);
  }
});

test("poster merges named accounts with project legacy homes and deduplicates shared paths", async () => {
  const workspace = createWorkspace();
  const api = await startPosterApi();
  const defaultHome = path.join(workspace.homeDir, ".codex-named-default");
  const namedOtherHome = path.join(workspace.homeDir, ".codex-named-other");
  const projectHome = path.join(workspace.homeDir, ".codex-project");
  fs.mkdirSync(defaultHome);
  fs.mkdirSync(namedOtherHome);
  fs.mkdirSync(projectHome);
  seedPosterWorkspace(workspace, api.baseUrl);
  fs.writeFileSync(
    path.join(workspace.repoDir, "registry.json"),
    `${JSON.stringify({
      codex_accounts: {
        "named-other": namedOtherHome,
        "named-default": defaultHome,
      },
      default_codex_account: "named-default",
      pool: [{ id: "bot1", token: "fixture-root-token" }],
      projects: {
        "project-raw": { codex_home: projectHome },
        "project-shared": { codex_home: namedOtherHome },
      },
    }, null, 2)}\n`,
  );
  const responsesPath = path.join(workspace.tmpDir, "codex-stdio-responses.json");
  fs.writeFileSync(responsesPath, `${JSON.stringify({
    [fs.realpathSync(defaultHome)]: { rateLimits: { planType: "chatgpt", primary: { usedPercent: 11 } } },
    [fs.realpathSync(namedOtherHome)]: { rateLimits: { planType: "chatgpt", primary: { usedPercent: 22 } } },
    [fs.realpathSync(projectHome)]: { rateLimits: { planType: "chatgpt", primary: { usedPercent: 33 } } },
  }, null, 2)}\n`);

  const result = await runScript(workspace, "scripts/usage-stats-poster.py", {
    env: { CCDM_TEST_CODEX_STDIO_RESPONSES: responsesPath },
  });

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  const post = api.requests.find((request) => request.method === "POST");
  assert.ok(post);
  const codexValue = JSON.parse(post.body).embeds[0].fields.find(({ name }) => name === "Codex").value;
  assert.deepEqual(
    readState(workspace.stateDir).fixtures.codex.stdioInvocations.map(({ env }) => path.basename(env.CODEX_HOME)),
    [".codex-named-default", ".codex-named-other", ".codex-project"],
  );
  assert.match(codexValue, /\*\*named-default\*\*[\s\S]*11%/);
  assert.match(codexValue, /\*\*named-other\*\*[\s\S]*22%/);
  assert.match(codexValue, /\*\*Legacy Codex Home\*\*[\s\S]*33%/);
  assert.doesNotMatch(codexValue, /Legacy Codex Home 2/);
});

test("poster merges top-level legacy homes with named accounts when no top-level default is selected", async () => {
  const workspace = createWorkspace();
  const api = await startPosterApi();
  const alphaHome = path.join(workspace.homeDir, ".codex-named-alpha");
  const zuluHome = path.join(workspace.homeDir, ".codex-named-zulu");
  const topLegacyHome = path.join(workspace.homeDir, ".codex-top-legacy");
  const projectLegacyHome = path.join(workspace.homeDir, ".codex-project-legacy");
  for (const home of [alphaHome, zuluHome, topLegacyHome, projectLegacyHome]) fs.mkdirSync(home);
  seedPosterWorkspace(workspace, api.baseUrl);
  fs.writeFileSync(
    path.join(workspace.repoDir, "registry.json"),
    `${JSON.stringify({
      codex_accounts: { "named-zulu": zuluHome, "named-alpha": alphaHome },
      default_codex_account: null,
      codex_home: topLegacyHome,
      pool: [{ id: "bot1", token: "fixture-root-token" }],
      projects: { "project-legacy": { codex_home: projectLegacyHome } },
    }, null, 2)}\n`,
  );
  const responsesPath = path.join(workspace.tmpDir, "codex-stdio-responses.json");
  fs.writeFileSync(responsesPath, `${JSON.stringify({
    [fs.realpathSync(alphaHome)]: { rateLimits: { planType: "chatgpt", primary: { usedPercent: 14 } } },
    [fs.realpathSync(zuluHome)]: { rateLimits: { planType: "chatgpt", primary: { usedPercent: 25 } } },
    [fs.realpathSync(topLegacyHome)]: { rateLimits: { planType: "chatgpt", primary: { usedPercent: 36 } } },
    [fs.realpathSync(projectLegacyHome)]: { rateLimits: { planType: "chatgpt", primary: { usedPercent: 47 } } },
  }, null, 2)}\n`);

  const result = await runScript(workspace, "scripts/usage-stats-poster.py", {
    env: { CCDM_TEST_CODEX_STDIO_RESPONSES: responsesPath },
  });

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  const post = api.requests.find((request) => request.method === "POST");
  assert.ok(post);
  const codexValue = JSON.parse(post.body).embeds[0].fields.find(({ name }) => name === "Codex").value;
  assert.deepEqual(
    readState(workspace.stateDir).fixtures.codex.stdioInvocations.map(({ env }) => path.basename(env.CODEX_HOME)),
    [".codex-named-alpha", ".codex-named-zulu", ".codex-top-legacy", ".codex-project-legacy"],
  );
  assert.match(codexValue, /\*\*named-alpha\*\*[\s\S]*14%/);
  assert.match(codexValue, /\*\*named-zulu\*\*[\s\S]*25%/);
  assert.match(codexValue, /\*\*Legacy Codex Home\*\*[\s\S]*36%/);
  assert.match(codexValue, /\*\*Legacy Codex Home 2\*\*[\s\S]*47%/);
});

test("poster labels a shared home with the alphabetically first alias without a default", async () => {
  const workspace = createWorkspace();
  const api = await startPosterApi();
  const uniqueHome = path.join(workspace.homeDir, ".codex-unique");
  const sharedHome = path.join(workspace.homeDir, ".codex-shared-no-default");
  fs.mkdirSync(uniqueHome);
  fs.mkdirSync(sharedHome);
  seedPosterWorkspace(workspace, api.baseUrl);
  fs.writeFileSync(
    path.join(workspace.repoDir, "registry.json"),
    `${JSON.stringify({
      codex_accounts: {
        "codex-zulu": sharedHome,
        "codex-alpha": uniqueHome,
        "codex-beta": sharedHome,
      },
      pool: [{ id: "bot1", token: "fixture-root-token" }],
      projects: {},
    }, null, 2)}\n`,
  );
  const responsesPath = path.join(workspace.tmpDir, "codex-stdio-responses.json");
  fs.writeFileSync(responsesPath, `${JSON.stringify({
    [fs.realpathSync(uniqueHome)]: { rateLimits: { planType: "chatgpt", primary: { usedPercent: 13 } } },
    [fs.realpathSync(sharedHome)]: { rateLimits: { planType: "chatgpt", primary: { usedPercent: 24 } } },
  }, null, 2)}\n`);

  const result = await runScript(workspace, "scripts/usage-stats-poster.py", {
    env: { CCDM_TEST_CODEX_STDIO_RESPONSES: responsesPath },
  });

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  const post = api.requests.find((request) => request.method === "POST");
  assert.ok(post);
  const codexValue = JSON.parse(post.body).embeds[0].fields.find(({ name }) => name === "Codex").value;
  assert.deepEqual(
    [...codexValue.matchAll(/\*\*(codex-[^*]+)\*\*/g)].map(([, label]) => label),
    ["codex-alpha", "codex-beta"],
  );
  assert.equal(readState(workspace.stateDir).fixtures.codex.stdioInvocations.length, 2);
  assert.doesNotMatch(codexValue, /codex-zulu/);
});

test("poster import, help, and config validation do not access runtime services", async () => {
  const workspace = createWorkspace();
  fs.writeFileSync(
    path.join(workspace.repoDir, ".usage-stats-poster.json"),
    `${JSON.stringify({ discord_channel_id: "fixture-channel" }, null, 2)}\n`,
  );
  const importProbe = path.join(workspace.repoDir, "import-poster.sh");
  fs.writeFileSync(
    importProbe,
    "#!/bin/sh\nexec python3 -c 'import runpy; runpy.run_path(\"scripts/usage-stats-poster.py\", run_name=\"poster_import_probe\"); print(\"imported\")'\n",
  );
  fs.chmodSync(importProbe, 0o755);

  const imported = await runScript(workspace, "import-poster.sh");
  const help = await runScript(workspace, "scripts/usage-stats-poster.py", { args: ["--help"] });
  const validated = await runScript(workspace, "scripts/usage-stats-poster.py", { args: ["--validate-config"] });

  assert.equal(imported.exitCode, 0, imported.stderr || imported.stdout);
  assert.match(imported.stdout, /imported/);
  assert.equal(help.exitCode, 0, help.stderr || help.stdout);
  assert.match(help.stdout, /--validate-config/);
  assert.equal(validated.exitCode, 0, validated.stderr || validated.stdout);
  assert.match(validated.stdout, /configuration is valid/i);
  const state = readState(workspace.stateDir);
  assert.deepEqual(state.fixtures.security.invocations, []);
  assert.deepEqual(state.fixtures.curl.requests, []);
  assert.deepEqual(state.fixtures.network.blocked, []);
});

test("poster accepts endpoint overrides from the test environment", async () => {
  const workspace = createWorkspace();
  const api = await startPosterApi();
  seedPosterWorkspace(workspace, api.baseUrl);
  const config = JSON.parse(fs.readFileSync(path.join(workspace.repoDir, ".usage-stats-poster.json"), "utf8"));
  delete config.anthropic_base_url;
  delete config.discord_base_url;
  fs.writeFileSync(path.join(workspace.repoDir, ".usage-stats-poster.json"), `${JSON.stringify(config)}\n`);

  const result = await runScript(workspace, "scripts/usage-stats-poster.py", {
    env: {
      CCDM_ANTHROPIC_BASE_URL: api.baseUrl,
      CCDM_DISCORD_BASE_URL: api.baseUrl,
    },
  });

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.ok(api.requests.some((request) => request.method === "POST"));
});

test("poster includes hand-authored Claude API-account cost estimates", async () => {
  const workspace = createWorkspace();
  const api = await startPosterApi();
  const apiHome = path.join(workspace.homeDir, ".claude-api");
  fs.mkdirSync(path.join(apiHome, "projects", "fixture-project"), { recursive: true });
  const record = {
    timestamp: new Date().toISOString(),
    type: "assistant",
    message: {
      id: "fixture-message",
      model: "claude-haiku-4-5-20251001",
      usage: {
        input_tokens: 10,
        output_tokens: 44,
        cache_read_input_tokens: 16369,
        cache_creation_input_tokens: 20457,
      },
    },
  };
  fs.writeFileSync(
    path.join(apiHome, "projects", "fixture-project", "session.jsonl"),
    [
      JSON.stringify(record),
      JSON.stringify(record),
      "[]",
      JSON.stringify({ message: [] }),
      JSON.stringify({ timestamp: new Date().toISOString(), type: "assistant", message: { usage: "corrupt" } }),
      "{broken",
    ].join("\n") + "\n",
  );
  seedPosterWorkspace(workspace, api.baseUrl, {
    claude_api_accounts: [{ path: "~/.claude-api", label: "Fixture API" }],
  });

  const result = await runScript(workspace, "scripts/usage-stats-poster.py");

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  const post = api.requests.find((request) => request.method === "POST");
  assert.ok(post);
  const claudeValue = JSON.parse(post.body).embeds[0].fields[0].value;
  assert.match(claudeValue, /\*\*Fixture API\*\* \(API key, local estimate\)/);
  assert.match(claudeValue, /Today: \*\*\$0\.0274\*\* · 1 request/);
  assert.match(claudeValue, /This month: \*\*\$0\.0274\*\* · 1 request/);
  assert.match(claudeValue, /Tokens: 10 in · 44 out/);
  assert.match(claudeValue, /Cache: 16\.4k read · 20\.5k write/);
});

test("poster truncates long Claude sections at Discord's field limit", async () => {
  const workspace = createWorkspace();
  const api = await startPosterApi();
  const accounts = Array.from({ length: 40 }, (_, index) => ({
    path: `~/.missing-account-${index}`,
    label: `Configured Claude API account ${index} with a deliberately long label`,
  }));
  seedPosterWorkspace(workspace, api.baseUrl, { claude_api_accounts: accounts });

  const result = await runScript(workspace, "scripts/usage-stats-poster.py");

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  const post = api.requests.find((request) => request.method === "POST");
  assert.ok(post);
  const value = JSON.parse(post.body).embeds[0].fields[0].value;
  assert.ok(value.length <= 1024);
  assert.match(value, /\*truncated\*$/);
  assert.match(value, /Configured Claude API account 0/);
});

test("poster reports missing config, Keychain, and endpoint failures without credentials", async () => {
  const malformedWorkspace = createWorkspace();
  fs.writeFileSync(path.join(malformedWorkspace.repoDir, ".usage-stats-poster.json"), "{broken\n");
  const malformed = await runScript(malformedWorkspace, "scripts/usage-stats-poster.py", {
    args: ["--validate-config"],
  });
  assert.equal(malformed.exitCode, 1);
  assert.match(malformed.stderr, /unable to read valid JSON from \.usage-stats-poster\.json/);
  assert.doesNotMatch(`${malformed.stdout}\n${malformed.stderr}`, /fixture-(oauth|root)-token/);

  const missingAuthWorkspace = createWorkspace();
  const api = await startPosterApi();
  seedPosterWorkspace(missingAuthWorkspace, api.baseUrl);
  const missingAuthState = readState(missingAuthWorkspace.stateDir);
  missingAuthState.fixtures.security.credentials = {};
  writeState(missingAuthState, missingAuthWorkspace.stateDir);
  const missingAuth = await runScript(missingAuthWorkspace, "scripts/usage-stats-poster.py");
  assert.equal(missingAuth.exitCode, 0, missingAuth.stderr || missingAuth.stdout);
  const missingAuthPost = api.requests.find((request) => request.method === "POST");
  assert.ok(missingAuthPost);
  assert.match(JSON.parse(missingAuthPost.body).embeds[0].fields[0].value, /Could not get OAuth token/);
  assert.deepEqual(readState(missingAuthWorkspace.stateDir).fixtures.curl.requests, []);

  const unreachableWorkspace = createWorkspace();
  seedPosterWorkspace(unreachableWorkspace, "http://127.0.0.1:1");
  const unreachable = await runScript(unreachableWorkspace, "scripts/usage-stats-poster.py");
  assert.equal(unreachable.exitCode, 1);
  assert.match(unreachable.stderr, /Discord post failed|endpoint/);
  assert.doesNotMatch(`${unreachable.stdout}\n${unreachable.stderr}`, /fixture-(oauth|root)-token/);
});

test("poster publishes a placeholder example and ignores local config", () => {
  const example = JSON.parse(fs.readFileSync(".usage-stats-poster.example.json", "utf8"));
  assert.equal(example.discord_channel_id, "REPLACE_WITH_DISCORD_CHANNEL_ID");
  assert.equal(example.claude_api_accounts[0].path, "REPLACE_WITH_CLAUDE_API_CONFIG_PATH");
  assert.match(fs.readFileSync(".gitignore", "utf8"), /^\.usage-stats-poster\.json$/m);
  assert.doesNotMatch(fs.readFileSync(".usage-stats-poster.example.json", "utf8"), /\b\d{17,20}\b/);
  assert.doesNotMatch(fs.readFileSync("scripts/usage-stats-poster.py", "utf8"), /^\s*(?:import|from)\s+(?:requests|httpx|aiohttp)\b/m);
});

test("scheduled poster collects 10-minute snapshots and uploads one trend PNG per 30-minute slot", async () => {
  const workspace = createWorkspace();
  const api = await startPosterApi({ acceptDashboard: true });
  const historyPath = path.join(workspace.homeDir, "Library", "Application Support", "CCDM", "usage-stats", "history.sqlite3");
  seedPosterWorkspace(workspace, api.baseUrl, { history_db_path: historyPath });
  const run = (now) => runScript(workspace, "scripts/usage-stats-poster.py", {
    args: ["--scheduled"],
    env: { CCDM_TEST_NOW: now, CCDM_USAGE_STATS_NOTIFY: "0" },
  });

  const collect = await run("2026-08-18T12:20:00Z");
  assert.equal(collect.exitCode, 0, collect.stderr || collect.stdout);
  assert.match(collect.stdout, /Collected usage snapshot/);
  assert.equal(api.requests.filter((request) => request.method === "POST").length, 0);

  const posted = await run("2026-08-18T12:30:00Z");
  assert.equal(posted.exitCode, 0, posted.stderr || posted.stdout);
  assert.match(posted.stdout, /Posted trend dashboard/);
  const dashboardPost = api.requests.find((request) => request.method === "POST");
  assert.ok(dashboardPost);
  assert.match(dashboardPost.contentType || "", /multipart\/form-data/);
  assert.match(dashboardPost.body, /filename="usage-dashboard\.png"/);

  const duplicate = await run("2026-08-18T12:35:00Z");
  assert.equal(duplicate.exitCode, 0, duplicate.stderr || duplicate.stdout);
  assert.match(duplicate.stdout, /already posted/);
  assert.equal(api.requests.filter((request) => request.method === "POST").length, 1);
  const finalMinuteInSlot = await run("2026-08-18T12:39:59Z");
  assert.equal(finalMinuteInSlot.exitCode, 0, finalMinuteInSlot.stderr || finalMinuteInSlot.stdout);
  assert.match(finalMinuteInSlot.stdout, /already posted/);
  const nextSlot = await run("2026-08-18T12:40:00Z");
  assert.equal(nextSlot.exitCode, 0, nextSlot.stderr || nextSlot.stdout);
  assert.match(nextSlot.stdout, /Collected usage snapshot/);
  assert.equal(api.requests.filter((request) => request.method === "POST").length, 1);

  const query = (sql) => {
    const result = spawnSync("python3", ["-c", [
      "import sqlite3, sys",
      "connection = sqlite3.connect(sys.argv[1])",
      "for row in connection.execute(sys.argv[2]):",
      "    print('\\t'.join(str(value) for value in row))",
    ].join("\n"), historyPath, sql], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim().split("\n").filter(Boolean);
  };
  assert.equal(query("select count(*) from snapshots")[0], "3");
  assert.equal(query("select count(*) from posts")[0], "1");
  const payload = query("select payload_json from snapshots order by slot_utc").join("\n");
  assert.doesNotMatch(payload, /fixture-(oauth|root)-token|projects|history\.sqlite3/);
  assert.equal(fs.statSync(historyPath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(historyPath)).mode & 0o777, 0o700);

  const oldSnapshot = spawnSync("python3", ["-c", [
    "import json, sqlite3, sys",
    "connection = sqlite3.connect(sys.argv[1])",
    "connection.execute(\"insert or replace into snapshots(slot_utc, generated_at, payload_json) values (?, ?, ?)\", ('2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z', json.dumps({'generated_at': '2024-01-01T00:00:00Z', 'cards': []})) )",
    "connection.commit()",
  ].join("\n"), historyPath], { encoding: "utf8" });
  assert.equal(oldSnapshot.status, 0, oldSnapshot.stderr);

  const sourceLog = path.join(path.dirname(historyPath), "codex-sessions", "session.jsonl");
  fs.mkdirSync(path.dirname(sourceLog), { recursive: true });
  fs.writeFileSync(sourceLog, "{\"type\":\"event_msg\",\"payload\":{\"type\":\"token_count\"}}\n");
  const sourceLogContents = fs.readFileSync(sourceLog, "utf8");
  fs.truncateSync(historyPath, 5 * 1024 * 1024 * 1024 + 1);
  const warning = await run("2026-08-18T12:50:00Z");
  assert.equal(warning.exitCode, 0, warning.stderr || warning.stdout);
  assert.match(warning.stderr, /exceeds 5 GiB/);
  assert.equal(query("select count(*) from snapshots")[0], "4");
  assert.equal(fs.readFileSync(sourceLog, "utf8"), sourceLogContents);
  const suppressed = await run("2026-08-18T12:55:00Z");
  assert.equal(suppressed.exitCode, 0, suppressed.stderr || suppressed.stdout);
  assert.doesNotMatch(suppressed.stderr, /exceeds 5 GiB/);
});

test("malformed current-slot snapshots are replaced by the next sanitized collection", async () => {
  const workspace = createWorkspace();
  const api = await startPosterApi();
  const historyPath = path.join(workspace.homeDir, "history", "history.sqlite3");
  seedPosterWorkspace(workspace, api.baseUrl, { history_db_path: historyPath });
  const run = () => runScript(workspace, "scripts/usage-stats-poster.py", {
    args: ["--collect-only"],
    env: { CCDM_TEST_NOW: "2026-08-18T12:20:00Z", CCDM_USAGE_STATS_NOTIFY: "0" },
  });

  const first = await run();
  assert.equal(first.exitCode, 0, first.stderr || first.stdout);
  const corrupt = spawnSync("python3", ["-c", [
    "import sqlite3, sys",
    "connection = sqlite3.connect(sys.argv[1])",
    "connection.execute(\"update snapshots set payload_json = '{broken-json'\")",
    "connection.commit()",
  ].join("\n"), historyPath], { encoding: "utf8" });
  assert.equal(corrupt.status, 0, corrupt.stderr);

  const repaired = await run();
  assert.equal(repaired.exitCode, 0, repaired.stderr || repaired.stdout);
  assert.match(repaired.stderr, /replacing malformed usage snapshot/);
  const payload = spawnSync("python3", ["-c", [
    "import json, sqlite3, sys",
    "connection = sqlite3.connect(sys.argv[1])",
    "print(json.loads(connection.execute('select payload_json from snapshots').fetchone()[0])['generated_at'])",
  ].join("\n"), historyPath], { encoding: "utf8" });
  assert.equal(payload.status, 0, payload.stderr);
  assert.equal(payload.stdout.trim(), "2026-08-18T12:20:00Z");
});
