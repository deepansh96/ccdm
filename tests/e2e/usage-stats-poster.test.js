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

function serviceFor(configDir) {
  return `Claude Code-credentials-${crypto.createHash("sha256").update(configDir).digest("hex").slice(0, 8)}`;
}

async function startPosterApi({ organization = { organization_type: "pro" }, unauthorizedTokens = [], acceptDashboard = false, usage = {}, accounts = {} } = {}) {
  const emails = { "fixture-oauth-token": "fixture@example.test", ...accounts };
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
        if (!Object.hasOwn(emails, request.headers.authorization?.replace(/^Bearer /, "") ?? "")) {
          response.statusCode = 401;
          response.end();
          return;
        }
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({
          account: {
            display_name: "Fixture User",
            email: emails[request.headers.authorization.replace(/^Bearer /, "")],
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
        if (!Object.hasOwn(emails, request.headers.authorization?.replace(/^Bearer /, "") ?? "")) {
          response.statusCode = 401;
          response.end();
          return;
        }
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({
          extra_usage: { is_enabled: true, used_credits: 1250 },
          five_hour: { utilization: request.headers.authorization === "Bearer fixture-oauth-token" ? 37 : 5 },
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
            !body.includes('filename="claude-usage-dashboard.png"') ||
            !body.includes('filename="codex-usage-dashboard.png"') ||
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
  const rootState = path.join(workspace.homeDir, ".claude", "channels", "discord");
  fs.mkdirSync(rootState, { recursive: true });
  fs.writeFileSync(path.join(rootState, ".env"), "DISCORD_BOT_TOKEN=fixture-root-token\n");
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
      pool: [{ id: "bot1", token: "fixture-project-token" }],
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
      value: "**claude-p** (Pro)\n5-Hour: `[######.........]` **37%**\n7-Day: `[#########......]` **62%**\nExtra usage: **$12.50** spent",
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
    ["find-generic-password", "-s", serviceFor(path.join(workspace.homeDir, ".claude")), "-w"],
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
    " poster.post_dashboard_to_discord({'discord_base_url': 'http://127.0.0.1:1', 'discord_channel_id': 'x'}, 'token', {'claude': sys.argv[2], 'codex': sys.argv[2]}, 'Claude usage')",
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
    assert.match(text, /Weekly: \*unavailable\*/);
    assert.doesNotMatch(text, /(?:5-Hour|7-Day):/);
    assert.doesNotMatch(text, /\*\*\s*(?:0|1|100)%/);
  }
  assert.equal(result.valid.available, true);
  assert.equal(result.valid.used_percent, 25);
  assert.equal(result.valid.resets_at, "2025-01-01T00:00:00Z");
  assert.equal(result.safe[0].available, false);
  assert.equal(Object.hasOwn(result.safe[0], "used_percent"), false);
  assert.equal(result.safe[0].resets_at, "2025-01-01T00:00:00Z");
});

test("Codex dashboard metrics are weekly only and old SQLite cards are translated at render time", () => {
  const probe = spawnSync("python3", ["-c", [
    "import importlib.util, json, sys",
    "spec = importlib.util.spec_from_file_location('poster', sys.argv[1])",
    "poster = importlib.util.module_from_spec(spec); spec.loader.exec_module(poster)",
    "metric = poster._metric_from_codex_rate_limits({'primary': {'usedPercent': 12, 'windowDurationMins': 10080}, 'secondary': {'usedPercent': 99}}, 'fixture')",
    "current = {'generated_at': '2026-08-18T12:30:00Z', 'cards': poster._safe_history_cards([metric])}",
    "old = {'generated_at': '2026-08-18T12:20:00Z', 'cards': [{'provider': 'codex', 'account': 'fixture', 'window': '5-hour', 'available': True, 'used_percent': 10}]}",
    "payload = poster._provider_dashboard_input(current, [old], 'codex', [metric])",
    "print(json.dumps({'current': payload['cards'], 'history': payload['history'], 'old': old}))",
  ].join("\n"), path.join("scripts", "usage-stats-poster.py")], { encoding: "utf8" });
  assert.equal(probe.status, 0, probe.stderr);
  const result = JSON.parse(probe.stdout);
  assert.equal(result.current.length, 1);
  assert.equal(result.current[0].window, "Weekly");
  assert.equal(result.history[0].cards[0].window, "Weekly");
  assert.equal(result.old.cards[0].window, "5-hour");
});

test("history uses valid SQLite slots as the authoritative chronological timestamp", () => {
  const probe = spawnSync("python3", ["-c", [
    "import importlib.util, json, sqlite3, sys, tempfile",
    "from pathlib import Path",
    "spec = importlib.util.spec_from_file_location('poster', sys.argv[1])",
    "poster = importlib.util.module_from_spec(spec); spec.loader.exec_module(poster)",
    "root = Path(tempfile.mkdtemp()); root.chmod(0o700)",
    "store = poster.HistoryStore(root / 'history.sqlite3')",
    "with store.locked() as connection:",
    " connection.execute(\"insert into snapshots values (?, ?, ?)\", ('2026-08-18T12:20:00Z', 'wrong', json.dumps({'generated_at': '2099-01-01T00:00:00Z', 'cards': []})) )",
    " connection.execute(\"insert into snapshots values (?, ?, ?)\", ('not-a-slot', 'wrong', json.dumps({'generated_at': '2026-01-01T00:00:00Z', 'cards': []})) )",
    " connection.execute(\"insert into snapshots values (?, ?, ?)\", ('2026-08-18T12:10:00Z', 'wrong', json.dumps({'generated_at': '1999-01-01T00:00:00Z', 'cards': []})) )",
    " connection.commit(); print(json.dumps([item['generated_at'] for item in store.history(connection)]))",
  ].join("\n"), path.join("scripts", "usage-stats-poster.py")], { encoding: "utf8" });
  assert.equal(probe.status, 0, probe.stderr);
  assert.deepEqual(JSON.parse(probe.stdout), ["2026-08-18T12:10:00Z", "2026-08-18T12:20:00Z"]);
});

test("legacy Codex 5-hour and 7-day cards collapse to one weekly 7-day value", () => {
  const probe = spawnSync("python3", ["-c", [
    "import importlib.util, json, sys",
    "spec = importlib.util.spec_from_file_location('poster', sys.argv[1])",
    "poster = importlib.util.module_from_spec(spec); spec.loader.exec_module(poster)",
    "snapshot = {'cards': [{'provider': 'codex', 'account': 'one', 'window': '5-hour', 'used_percent': 8}, {'provider': 'codex', 'account': 'one', 'window': '7-day', 'used_percent': 77}]}",
    "payload = poster._provider_dashboard_input(snapshot, [snapshot], 'codex', [])",
    "print(json.dumps(payload['cards']))",
  ].join("\n"), path.join("scripts", "usage-stats-poster.py")], { encoding: "utf8" });
  assert.equal(probe.status, 0, probe.stderr);
  const cards = JSON.parse(probe.stdout);
  assert.equal(cards.length, 1);
  assert.deepEqual([cards[0].window, cards[0].used_percent], ["Weekly", 77]);
});

test("Claude API estimate notes retain only local costs, counts, and status", () => {
  const probe = spawnSync("python3", ["-c", [
    "import importlib.util, json, sys",
    "spec = importlib.util.spec_from_file_location('poster', sys.argv[1])",
    "poster = importlib.util.module_from_spec(spec); spec.loader.exec_module(poster)",
    "note = poster._claude_api_dashboard_note('Example/API', {'status': 'estimated_local', 'today_cost': 1.25, 'month_cost': 3.5, 'today_requests': 2, 'month_requests': 4})",
    "cards = poster._safe_history_cards([{'provider': 'claude', 'account': 'Example/API', 'limits': [], 'dashboard_note': note}])",
    "print(json.dumps({'note': note, 'cards': cards}))",
  ].join("\n"), path.join("scripts", "usage-stats-poster.py")], { encoding: "utf8" });
  assert.equal(probe.status, 0, probe.stderr);
  const { note, cards } = JSON.parse(probe.stdout);
  assert.match(note.title, /Example·API/);
  assert.match(note.lines.join("\n"), /Today  \$1\.2500 · 2 requests/);
  assert.match(note.lines.join("\n"), /This month  \$3\.5000 · 4 requests/);
  assert.match(note.lines.join("\n"), /no rate-limit graph/);
  assert.deepEqual(cards, []);
});

test("missing Claude API config keeps the unavailable/manual status", () => {
  const probe = spawnSync("python3", ["-c", [
    "import importlib.util, json, sys",
    "from pathlib import Path",
    "spec = importlib.util.spec_from_file_location('poster', sys.argv[1])",
    "poster = importlib.util.module_from_spec(spec); spec.loader.exec_module(poster)",
    "estimate = poster.get_claude_api_estimate(Path('/definitely-missing-ccdm-api-config'))",
    "print(json.dumps({'status': estimate['status'], 'text': poster.get_claude_api_stats(Path('/definitely-missing-ccdm-api-config'), 'Fixture', estimate=estimate), 'note': poster._claude_api_dashboard_note('Fixture', estimate)}))",
  ].join("\n"), path.join("scripts", "usage-stats-poster.py")], { encoding: "utf8" });
  assert.equal(probe.status, 0, probe.stderr);
  const result = JSON.parse(probe.stdout);
  assert.equal(result.status, "unavailable");
  assert.match(result.text, /Unable to read local usage/);
  assert.match(result.note.lines.join("\n"), /Local usage unavailable/);
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
    `${JSON.stringify({ oauthAccount: { emailAddress: "Fixture@Example.test" } })}\n`,
  );
  fs.writeFileSync(
    path.join(organizationDir, ".claude.json"),
    `${JSON.stringify({ oauthAccount: { organizationName: "Fixture Organization" } })}\n`,
  );
  fs.mkdirSync(path.join(workspace.homeDir, ".claude-malformed"));
  fs.writeFileSync(path.join(workspace.homeDir, ".claude-malformed", ".claude.json"), "{broken\n");
  fs.writeFileSync(path.join(workspace.homeDir, ".claude-not-a-directory"), "fixture\n");
  seedPosterWorkspace(workspace, api.baseUrl);

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
  assert.match(claudeValue, /\*\*claude-p\*\* \(Pro\)/);
  assert.match(claudeValue, /\*\*claude-email\*\* \(Pro\)/);
  assert.match(claudeValue, /\*\*claude-organization\*\* \(Pro\)/);
  assert.deepEqual(
    readState(workspace.stateDir).fixtures.security.invocations.map((entry) => entry.service),
    [serviceFor(path.join(workspace.homeDir, ".claude")), "Claude Code-credentials", emailService, organizationService],
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
  assert.match(claudeValue, /\*\*claude-p\*\*[\s\S]*Needs re-login: `CLAUDE_CONFIG_DIR=~\/\.claude claude \/login`/);
  assert.match(claudeValue, /\*\*claude-login\*\*[\s\S]*Needs re-login: `CLAUDE_CONFIG_DIR=~\/\.claude-login claude \/login`/);
  assert.match(claudeValue, /\*\*claude-refresh\*\*[\s\S]*Auth expired — start a session on this account to refresh/);
  assert.deepEqual(
    readState(workspace.stateDir).fixtures.security.invocations.map((entry) => entry.service),
    [serviceFor(path.join(workspace.homeDir, ".claude")), "Claude Code-credentials", loginService, refreshService],
  );
  assert.equal(api.requests.filter((request) => request.method === "GET").length, 3);
});

async function runPosterWithDefaultHomeCredentials(credentialsFor) {
  const workspace = createWorkspace();
  const api = await startPosterApi();
  seedPosterWorkspace(workspace, api.baseUrl);
  const hashedService = serviceFor(path.join(workspace.homeDir, ".claude"));
  const state = readState(workspace.stateDir);
  state.fixtures.security.credentials = credentialsFor(hashedService);
  writeState(state, workspace.stateDir);

  const result = await runScript(workspace, "scripts/usage-stats-poster.py");

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  const post = api.requests.find((request) => request.method === "POST");
  assert.ok(post);
  return {
    claudeValue: JSON.parse(post.body).embeds[0].fields[0].value,
    oauthAuthorizations: api.requests
      .filter((request) => request.method === "GET")
      .map((request) => request.authorization),
  };
}

test("poster reads a default-home login saved only in the hashed Keychain item", async () => {
  const { claudeValue, oauthAuthorizations } = await runPosterWithDefaultHomeCredentials((hashedService) => ({
    [hashedService]: { claudeAiOauth: { accessToken: "fixture-oauth-token" } },
  }));

  assert.match(claudeValue, /\*\*claude-p\*\* \(Pro\)/);
  assert.deepEqual(oauthAuthorizations, ["Bearer fixture-oauth-token", "Bearer fixture-oauth-token"]);
});

test("poster uses whichever default-home Keychain item expires last", async () => {
  const past = Date.now() - 60 * 60 * 1000;
  const future = Date.now() + 60 * 60 * 1000;
  const stale = {
    claudeAiOauth: { accessToken: "fixture-stale-token", refreshToken: "fixture-refresh-token", expiresAt: past },
  };
  const fresh = { claudeAiOauth: { accessToken: "fixture-oauth-token", expiresAt: future } };

  for (const credentialsFor of [
    (hashedService) => ({ [hashedService]: stale, "Claude Code-credentials": fresh }),
    (hashedService) => ({ [hashedService]: fresh, "Claude Code-credentials": stale }),
  ]) {
    const { claudeValue, oauthAuthorizations } = await runPosterWithDefaultHomeCredentials(credentialsFor);
    assert.match(claudeValue, /\*\*claude-p\*\* \(Pro\)/);
    assert.doesNotMatch(claudeValue, /expired/);
    assert.deepEqual(oauthAuthorizations, ["Bearer fixture-oauth-token", "Bearer fixture-oauth-token"]);
  }

  // Without expiry data neither item is known to be fresher, so the hashed one wins.
  const { oauthAuthorizations } = await runPosterWithDefaultHomeCredentials((hashedService) => ({
    [hashedService]: { claudeAiOauth: { accessToken: "fixture-oauth-token" } },
    "Claude Code-credentials": { claudeAiOauth: { accessToken: "fixture-other-token" } },
  }));
  assert.deepEqual(oauthAuthorizations, ["Bearer fixture-oauth-token", "Bearer fixture-oauth-token"]);
});

test("poster falls back to the other unexpired Keychain item when the API rejects a token", async () => {
  const revoked = {
    claudeAiOauth: { accessToken: "fixture-revoked-token", expiresAt: Date.now() + 2 * 60 * 60 * 1000 },
  };
  const fallback = await runPosterWithDefaultHomeCredentials((hashedService) => ({
    [hashedService]: revoked,
    "Claude Code-credentials": {
      claudeAiOauth: { accessToken: "fixture-oauth-token", expiresAt: Date.now() + 60 * 60 * 1000 },
    },
  }));
  assert.match(fallback.claudeValue, /\*\*claude-p\*\* \(Pro\)/);
  assert.deepEqual(fallback.oauthAuthorizations, [
    "Bearer fixture-revoked-token",
    "Bearer fixture-oauth-token",
    "Bearer fixture-oauth-token",
  ]);

  // An expired fallback is not tried; the rejected token's own action is reported.
  const noFallback = await runPosterWithDefaultHomeCredentials((hashedService) => ({
    [hashedService]: revoked,
    "Claude Code-credentials": {
      claudeAiOauth: { accessToken: "fixture-oauth-token", expiresAt: Date.now() - 60 * 60 * 1000 },
    },
  }));
  assert.match(noFallback.claudeValue, /\*\*claude-p\*\*[\s\S]*Needs re-login: `CLAUDE_CONFIG_DIR=~\/\.claude claude \/login`/);
  assert.deepEqual(noFallback.oauthAuthorizations, ["Bearer fixture-revoked-token"]);
});

test("poster reports each Claude home only with a login that belongs to its account", async () => {
  const workspace = createWorkspace();
  const api = await startPosterApi({ accounts: { "fixture-work-token": "work@example.test" } });
  const future = Date.now() + 60 * 60 * 1000;
  const defaultDir = path.join(workspace.homeDir, ".claude");
  const workDir = path.join(workspace.homeDir, ".claude-work");
  const otherDir = path.join(workspace.homeDir, ".claude-other");
  for (const [dir, email] of [[defaultDir, "fixture@example.test"], [workDir, "Work@Example.test"], [otherDir, "other@example.test"]]) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, ".claude.json"), `${JSON.stringify({ oauthAccount: { emailAddress: email } })}\n`);
  }
  seedPosterWorkspace(workspace, api.baseUrl);
  const state = readState(workspace.stateDir);
  // The plain item holds the work login and expires last; the work home's own item has expired.
  state.fixtures.security.credentials = {
    [serviceFor(defaultDir)]: { claudeAiOauth: { accessToken: "fixture-oauth-token", expiresAt: future } },
    "Claude Code-credentials": { claudeAiOauth: { accessToken: "fixture-work-token", expiresAt: future + 60_000 } },
    [serviceFor(workDir)]: {
      claudeAiOauth: { accessToken: "fixture-expired-token", refreshToken: "fixture-refresh-token", expiresAt: Date.now() - 1000 },
    },
    [serviceFor(otherDir)]: { claudeAiOauth: { accessToken: "fixture-oauth-token", expiresAt: future } },
  };
  writeState(state, workspace.stateDir);

  const result = await runScript(workspace, "scripts/usage-stats-poster.py");

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  const post = api.requests.find((request) => request.method === "POST");
  assert.ok(post);
  const claudeValue = JSON.parse(post.body).embeds[0].fields[0].value;
  assert.match(claudeValue, /\*\*claude-p\*\* \(Pro\)\n5-Hour: `[^`]*` \*\*37%\*\*/);
  assert.match(claudeValue, /\*\*claude-work\*\* \(Pro\)\n5-Hour: `[^`]*` \*\*5%\*\*/);
  // A home whose account has no readable login is never shown another account's usage.
  assert.match(claudeValue, /\*\*claude-other\*\*\n\*Needs re-login: `CLAUDE_CONFIG_DIR=~\/\.claude-other claude \/login`\*/);
  assert.doesNotMatch(claudeValue, /Personal|@example/);
  // The shared plain item is read from the Keychain once per run.
  const reads = readState(workspace.stateDir).fixtures.security.invocations.map((entry) => entry.service);
  assert.equal(reads.filter((service) => service === "Claude Code-credentials").length, 1);
});

test("poster uses N/A when the Claude organization value is malformed", async () => {
  const workspace = createWorkspace();
  const api = await startPosterApi({ organization: ["not", "an", "object"] });
  seedPosterWorkspace(workspace, api.baseUrl);

  const result = await runScript(workspace, "scripts/usage-stats-poster.py", { cwd: workspace.tmpDir });

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  const post = api.requests.find((request) => request.method === "POST");
  assert.ok(post);
  assert.match(JSON.parse(post.body).embeds[0].fields[0].value, /^\*\*claude-p\*\* \(N\/A\)/);
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
      pool: [{ id: "bot1", token: "fixture-project-token" }],
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
      pool: [{ id: "bot1", token: "fixture-project-token" }],
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
      pool: [{ id: "bot1", token: "fixture-project-token" }],
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
  assert.match(codexValue, /\*\*codex-default\*\* \(ChatGPT\)[\s\S]*Weekly:.*34%/);
  assert.match(codexValue, /\*\*codex-alpha\*\* \(ChatGPT\)[\s\S]*Weekly:.*78%/);
  assert.match(codexValue, /\*\*codex-premium\*\* \(ChatGPT\)[\s\S]*Weekly:.*43%/);
  assert.doesNotMatch(codexValue, /(?:5-Hour|7-Day):/);
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
      pool: [{ id: "bot1", token: "fixture-project-token" }],
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
      pool: [{ id: "bot1", token: "fixture-project-token" }],
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
      pool: [{ id: "bot1", token: "fixture-project-token" }],
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
      pool: [{ id: "bot1", token: "fixture-project-token" }],
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
      pool: [{ id: "bot1", token: "fixture-project-token" }],
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
      pool: [{ id: "bot1", token: "fixture-project-token" }],
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
      pool: [{ id: "bot1", token: "fixture-project-token" }],
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
        pool: [{ id: "bot1", token: "fixture-project-token" }],
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
      pool: [{ id: "bot1", token: "fixture-project-token" }],
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
      pool: [{ id: "bot1", token: "fixture-project-token" }],
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
      pool: [{ id: "bot1", token: "fixture-project-token" }],
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

test("scheduled poster posts the original text report once per 30-minute slot without image attachments", async () => {
  const workspace = createWorkspace();
  const api = await startPosterApi();
  const historyPath = path.join(workspace.homeDir, "Library", "Application Support", "CCDM", "usage-stats", "history.sqlite3");
  seedPosterWorkspace(workspace, api.baseUrl, { history_db_path: historyPath });
  const codexHome = path.join(workspace.homeDir, ".codex-scheduled");
  fs.mkdirSync(codexHome);
  fs.writeFileSync(
    path.join(workspace.repoDir, "registry.json"),
    `${JSON.stringify({
      codex_accounts: { "codex-scheduled": codexHome },
      default_codex_account: "codex-scheduled",
      pool: [{ id: "bot1", token: "fixture-project-token" }],
      projects: {},
    }, null, 2)}\n`,
  );
  const responsesPath = path.join(workspace.tmpDir, "codex-stdio-responses.json");
  fs.writeFileSync(responsesPath, `${JSON.stringify({
    [fs.realpathSync(codexHome)]: {
      rateLimits: { planType: "chatgpt", primary: { usedPercent: 42, windowDurationMins: 10080 } },
    },
  }, null, 2)}\n`);
  const run = (now) => runScript(workspace, "scripts/usage-stats-poster.py", {
    args: ["--scheduled"],
    env: {
      CCDM_TEST_CODEX_STDIO_RESPONSES: responsesPath,
      CCDM_TEST_NOW: now,
      CCDM_USAGE_STATS_NOTIFY: "0",
    },
  });

  const collect = await run("2026-08-18T12:20:00Z");
  assert.equal(collect.exitCode, 0, collect.stderr || collect.stdout);
  assert.match(collect.stdout, /Collected usage snapshot/);
  assert.equal(api.requests.filter((request) => request.method === "POST").length, 0);

  const posted = await run("2026-08-18T12:30:00Z");
  assert.equal(posted.exitCode, 0, posted.stderr || posted.stdout);
  assert.match(posted.stdout, /Posted usage report/);
  const reportPost = api.requests.find((request) => request.method === "POST");
  assert.ok(reportPost);
  // The scheduled workflow is text-only: a plain JSON embed, never multipart.
  assert.equal(reportPost.contentType, "application/json");
  assert.doesNotMatch(reportPost.body, /multipart\/form-data/);
  assert.doesNotMatch(reportPost.body, /filename="[^"]*\.png"/);
  assert.doesNotMatch(reportPost.body, /Content-Type: image\/png/);
  const dashboardPayload = JSON.parse(reportPost.body);
  assert.equal(dashboardPayload.embeds.length, 1);
  assert.equal(dashboardPayload.embeds[0].title, "Usage Report");
  assert.deepEqual(dashboardPayload.embeds[0].fields.map(({ name }) => name), ["Claude Code", "Codex"]);
  assert.match(dashboardPayload.embeds[0].fields[0].value, /\*\*claude-p\*\* \(Pro\)/);
  assert.match(dashboardPayload.embeds[0].fields[0].value, /5-Hour:/);
  assert.match(dashboardPayload.embeds[0].fields[0].value, /7-Day:/);
  assert.match(dashboardPayload.embeds[0].fields[1].value, /\*\*codex-scheduled\*\* \(ChatGPT\)/);
  assert.match(dashboardPayload.embeds[0].fields[1].value, /Weekly:.*42%/);
  assert.doesNotMatch(dashboardPayload.embeds[0].fields[1].value, /(?:5-Hour|7-Day):/);

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

test("poster never falls back to a project pool token when root credentials are missing", async () => {
  const workspace = createWorkspace();
  const api = await startPosterApi();
  seedPosterWorkspace(workspace, api.baseUrl);
  fs.unlinkSync(path.join(workspace.homeDir, ".claude/channels/discord/.env"));
  const result = await runScript(workspace, "scripts/usage-stats-poster.py");
  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /cannot read root Discord credentials/);
  assert.equal(api.requests.length, 0);
  assert.doesNotMatch(result.stderr, /fixture-project-token/);
});

test("poster can use a custom root state directory without a root pool entry", async () => {
  const workspace = createWorkspace();
  const api = await startPosterApi();
  seedPosterWorkspace(workspace, api.baseUrl);
  fs.writeFileSync(path.join(workspace.repoDir, "registry.json"), JSON.stringify({ pool: [], projects: {} }));
  const custom = path.join(workspace.homeDir, "custom root");
  fs.renameSync(path.join(workspace.homeDir, ".claude/channels/discord"), custom);
  const result = await runScript(workspace, "scripts/usage-stats-poster.py", { env: { ROOT_DISCORD_STATE_DIR: custom } });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(api.requests.find(r => r.method === "POST").authorization, "Bot fixture-root-token");
});

// ---------------------------------------------------------------------------
// DeepSeek account balance integration (local fakes only).
// ---------------------------------------------------------------------------

const DEEPSEEK_FAKE_HELPER_SOURCE = [
  '"""Local-fake DeepSeek usage collector (used only when the real sibling module is absent)."""',
  "from datetime import timezone",
  "",
  "",
  "def collect_month_usage(homes, now):",
  '    period = now.astimezone(timezone.utc).strftime("%Y-%m")',
  "    return {",
  '        "status": "available",',
  '        "period": period,',
  '        "input_tokens": 900,',
  '        "cached_input_tokens": 100,',
  '        "output_tokens": 400,',
  '        "reasoning_output_tokens": 50,',
  '        "total_tokens": 1300,',
  '        "sessions": 1,',
  '        "partial": False,',
  "    }",
  "",
].join("\n");

function installDeepseekUsageHelper(workspace) {
  const helperPath = path.join(workspace.repoDir, "scripts", "deepseek-local-usage.py");
  // Only supply a temporary local fake when the sibling owner's module is not
  // present; never overwrite a real implementation.
  if (fs.existsSync(helperPath)) {
    return false;
  }
  fs.writeFileSync(helperPath, DEEPSEEK_FAKE_HELPER_SOURCE);
  return true;
}

function seedDeepseekHome(workspace, alias, options = {}) {
  const home = path.join(workspace.homeDir, alias);
  fs.mkdirSync(home, { recursive: true });
  if (options.marker !== undefined) {
    fs.writeFileSync(path.join(home, "ccdm-deepseek.json"), JSON.stringify(options.marker));
  }
  fs.writeFileSync(path.join(home, "config.toml"), 'model = "deepseek-flash"\n');
  if (options.key !== undefined) {
    fs.writeFileSync(path.join(home, "api-key"), `${options.key}\n`);
    fs.chmodSync(path.join(home, "api-key"), options.keyMode ?? 0o600);
  }
  if (options.session) {
    const sessionDir = path.join(home, "sessions", "2026", "09", "22");
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionDir, "rollout-fixture-1.jsonl"),
      `${[
        JSON.stringify({ type: "session_meta", payload: { id: "session-fixture-1", model_provider: "deepseek" } }),
        JSON.stringify({ type: "turn_context", payload: { model: "deepseek-flash", turn_id: "turn-1" } }),
        JSON.stringify({
          type: "event_msg",
          timestamp: "2026-09-22T10:00:00Z",
          payload: {
            type: "token_count",
            info: {
              total_token_usage: {
                input_tokens: 900,
                cached_input_tokens: 100,
                output_tokens: 400,
                reasoning_output_tokens: 50,
                total_tokens: 1300,
              },
              last_token_usage: {
                input_tokens: 900,
                cached_input_tokens: 100,
                output_tokens: 400,
                reasoning_output_tokens: 50,
                total_tokens: 1300,
              },
            },
          },
        }),
      ].join("\n")}\n`,
    );
  }
  return home;
}

async function startDeepseekBalanceApi(handler = () => ({
  status: 200,
  body: JSON.stringify({
    is_available: true,
    balance_infos: [{
      currency: "USD",
      total_balance: "12.34",
      granted_balance: "0.00",
      topped_up_balance: "12.34",
    }],
  }),
})) {
  const requests = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      requests.push({
        authorization: request.headers.authorization,
        method: request.method,
        path: request.url,
      });
      const reply = handler(request) || {};
      response.statusCode = reply.status ?? 200;
      for (const [name, value] of Object.entries(reply.headers ?? {})) {
        response.setHeader(name, value);
      }
      if (reply.body !== undefined) {
        response.setHeader("content-type", reply.contentType ?? "application/json");
        response.end(reply.body);
      } else {
        response.end();
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  registerTeardownCallback(async () => {
    await new Promise((resolve) => server.close(resolve));
  });
  const address = server.address();
  return { baseUrl: `http://127.0.0.1:${address.port}`, requests };
}

function probePoster(code, ...args) {
  return spawnSync("python3", ["-c", [
    "import importlib.util, sys",
    "spec = importlib.util.spec_from_file_location('poster', sys.argv[1])",
    "poster = importlib.util.module_from_spec(spec); spec.loader.exec_module(poster)",
    code,
  ].join("\n"), path.join("scripts", "usage-stats-poster.py"), ...args], { encoding: "utf8" });
}

function probePosterTimed(timeoutMs, code, ...args) {
  return spawnSync("python3", ["-c", [
    "import importlib.util, sys",
    "spec = importlib.util.spec_from_file_location('poster', sys.argv[1])",
    "poster = importlib.util.module_from_spec(spec); spec.loader.exec_module(poster)",
    code,
  ].join("\n"), path.join("scripts", "usage-stats-poster.py"), ...args], { encoding: "utf8", timeout: timeoutMs });
}

test("poster reports a DeepSeek balance and local-session coverage without quota cards", async () => {
  const workspace = createWorkspace();
  const api = await startPosterApi();
  const balance = await startDeepseekBalanceApi();
  installDeepseekUsageHelper(workspace);
  const home = seedDeepseekHome(workspace, "deepseek-flash", {
    marker: { version: 1, provider: "deepseek" },
    key: "sk-fixture-deepseek-key",
    session: true,
  });
  const sentinel = path.join(workspace.tmpDir, "auth-command-was-run");
  fs.writeFileSync(
    path.join(home, "config.toml"),
    [
      'model = "deepseek-flash"',
      '[model_providers.deepseek.auth]',
      'command = "/bin/sh"',
      `args = ["-c", "touch ${sentinel}"]`,
      "",
    ].join("\n"),
  );
  const historyPath = path.join(workspace.homeDir, "history", "history.sqlite3");
  seedPosterWorkspace(workspace, api.baseUrl, {
    deepseek_base_url: balance.baseUrl,
    history_db_path: historyPath,
  });
  fs.writeFileSync(
    path.join(workspace.repoDir, "registry.json"),
    `${JSON.stringify({ pool: [], projects: {}, codex_accounts: { "deepseek-flash": home } }, null, 2)}\n`,
  );

  const result = await runScript(workspace, "scripts/usage-stats-poster.py");
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  const post = api.requests.find((request) => request.method === "POST");
  assert.ok(post);
  const payload = JSON.parse(post.body);
  const codexField = payload.embeds[0].fields.find(({ name }) => name === "Codex");
  assert.ok(codexField, "DeepSeek note should appear in the Codex field");
  assert.match(codexField.value, /\*\*deepseek-flash\*\* \(API\)\nBalance: \*\*\$12\.34\*\*\nPaid: \$12\.34 · Granted: \$0\.00\n/);
  assert.match(codexField.value, /\*Balance: whole account · Usage: local Codex\*/);
  // No reference is configured here, so there is no percentage or inline bar.
  assert.doesNotMatch(codexField.value, /% left|\[[#.]+\]/);
  assert.doesNotMatch(codexField.value, /Coverage:/);
  // The fixture rollout carries the full live token split, so the local totals
  // are exact: one DeepSeek session with 1300 tokens this UTC month.
  assert.match(codexField.value, /This month: \*\*1\.3k tokens\*\* · 1 session/);
  assert.match(codexField.value, /Tokens: in 900 · out 400 · cached 100/);

  assert.equal(balance.requests.length, 1);
  assert.equal(balance.requests[0].method, "GET");
  assert.equal(balance.requests[0].path, "/user/balance");
  assert.equal(balance.requests[0].authorization, "Bearer sk-fixture-deepseek-key");
  assert.doesNotMatch(result.stdout, /sk-fixture-deepseek-key/);
  assert.doesNotMatch(result.stderr, /sk-fixture-deepseek-key/);
  assert.equal(readState(workspace.stateDir).fixtures.codex.stdioInvocations.length, 0);
  assert.equal(fs.existsSync(sentinel), false, "poster must never execute config.toml auth commands");

  const collected = await runScript(workspace, "scripts/usage-stats-poster.py", { args: ["--collect-only"] });
  assert.equal(collected.exitCode, 0, collected.stderr || collected.stdout);
  const snapshot = spawnSync("python3", ["-c", [
    "import sqlite3, sys",
    "connection = sqlite3.connect(sys.argv[1])",
    "print(connection.execute('select payload_json from snapshots').fetchone()[0])",
  ].join("\n"), historyPath], { encoding: "utf8" });
  assert.equal(snapshot.status, 0, snapshot.stderr);
  assert.doesNotMatch(snapshot.stdout, /Balance|12\.34/);
  assert.doesNotMatch(snapshot.stdout, /deepseek-flash/);
  assert.doesNotMatch(snapshot.stdout, /sk-fixture-deepseek-key/);
});

test("DeepSeek coverage reports unavailable without hiding the real balance", async () => {
  const workspace = createWorkspace();
  const api = await startPosterApi();
  const balance = await startDeepseekBalanceApi();
  const home = seedDeepseekHome(workspace, "deepseek-flash", {
    marker: { version: 1, provider: "deepseek" },
    key: "sk-fixture-deepseek-key",
    session: true,
  });
  // Simulate a host without the sibling local-usage collector: coverage must
  // degrade to unavailable instead of inventing local totals, while the real
  // account balance still posts.
  fs.rmSync(path.join(workspace.repoDir, "scripts", "deepseek-local-usage.py"), { force: true });
  seedPosterWorkspace(workspace, api.baseUrl, { deepseek_base_url: balance.baseUrl });
  fs.writeFileSync(
    path.join(workspace.repoDir, "registry.json"),
    `${JSON.stringify({ pool: [], projects: {}, codex_accounts: { "deepseek-flash": home } }, null, 2)}\n`,
  );

  const result = await runScript(workspace, "scripts/usage-stats-poster.py");
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  const payload = JSON.parse(api.requests.find((request) => request.method === "POST").body);
  const codexField = payload.embeds[0].fields.find(({ name }) => name === "Codex");
  assert.ok(codexField);
  assert.match(codexField.value, /\*\*deepseek-flash\*\* \(API\)/);
  assert.match(codexField.value, /Balance: \*\*\$12\.34\*\*/);
  assert.match(codexField.value, /Paid: \$12\.34 · Granted: \$0\.00/);
  assert.match(
    codexField.value,
    /This month: \*unavailable \(Local DeepSeek usage collector unavailable\)\*/,
  );
  assert.match(codexField.value, /\*Balance: whole account · Usage: local Codex\*/);
  assert.doesNotMatch(codexField.value, /This month: \*\*/);
});

test("DeepSeek key grouping issues one balance request per distinct key", async () => {
  const workspace = createWorkspace();
  const api = await startPosterApi();
  const balance = await startDeepseekBalanceApi();
  installDeepseekUsageHelper(workspace);
  const sharedA = seedDeepseekHome(workspace, "deepseek-primary", {
    marker: { version: 1, provider: "deepseek" },
    key: "sk-shared-key-value",
    session: true,
  });
  const sharedB = seedDeepseekHome(workspace, "deepseek-mirror", {
    marker: { version: 1, provider: "deepseek" },
    key: "sk-shared-key-value",
    // The same rollout copied into the mirror home: it shares a session id and
    // event identity, so the shared-key group must count it once.
    session: true,
  });
  const other = seedDeepseekHome(workspace, "deepseek-other", {
    marker: { version: 1, provider: "deepseek" },
    key: "sk-distinct-key-value",
  });
  seedPosterWorkspace(workspace, api.baseUrl, { deepseek_base_url: balance.baseUrl });
  fs.writeFileSync(
    path.join(workspace.repoDir, "registry.json"),
    `${JSON.stringify({
      pool: [],
      projects: {},
      codex_accounts: {
        "deepseek-mirror": sharedB,
        "deepseek-other": other,
        "deepseek-primary": sharedA,
      },
    }, null, 2)}\n`,
  );

  const result = await runScript(workspace, "scripts/usage-stats-poster.py");
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  const authorizations = balance.requests.map((request) => request.authorization).sort();
  assert.deepEqual(authorizations, ["Bearer sk-distinct-key-value", "Bearer sk-shared-key-value"]);
  const payload = JSON.parse(api.requests.find((request) => request.method === "POST").body);
  const codexField = payload.embeds[0].fields.find(({ name }) => name === "Codex");
  assert.match(codexField.value, /deepseek-mirror \+ deepseek-primary \(shared key\)/);
  assert.match(codexField.value, /\*\*deepseek-other\*\*/);
  assert.doesNotMatch(codexField.value, /sk-(?:shared|distinct)-key-value/);
  // The copied rollout is deduplicated, so the shared-key note reports the
  // exact single-copy total for this UTC month rather than double-counting it.
  assert.match(
    codexField.value,
    /\*\*deepseek-mirror \+ deepseek-primary \(shared key\)\*\* \(API\)\nBalance: \*\*\$12\.34\*\*\nPaid: \$12\.34 · Granted: \$0\.00\nThis month: \*\*1\.3k tokens\*\* · 1 session\nTokens: in 900 · out 400 · cached 100\n\*Balance: whole account · Usage: local Codex\*\n/,
  );
});

test("malformed or redirecting DeepSeek balance responses stay unavailable and unexposed", async () => {
  const cases = [
    { name: "malformed", handler: () => ({ status: 200, body: '{"is_available": true, "balance_infos": "nope"}' }) },
    { name: "float-amount", handler: () => ({ status: 200, body: JSON.stringify({ is_available: true, balance_infos: [{ currency: "USD", total_balance: 12.34 }] }) }) },
    {
      name: "duplicate-currency",
      handler: () => ({
        status: 200,
        body: JSON.stringify({
          is_available: true,
          balance_infos: [
            { currency: "USD", total_balance: "1.00" },
            { currency: "USD", total_balance: "2.00" },
          ],
        }),
      }),
    },
    { name: "unauthorized", handler: () => ({ status: 401, body: "sk-leaked-secret-body" }), expect: /HTTP 401/ },
    { name: "rate-limited", handler: () => ({ status: 429, body: "sk-leaked-secret-body" }), expect: /HTTP 429/ },
    { name: "server-error", handler: () => ({ status: 500, body: "sk-leaked-secret-body" }), expect: /HTTP 500/ },
    { name: "oversized", handler: () => ({ status: 200, body: `{"padding":"${"x".repeat(96 * 1024)}"}` }) },
    {
      name: "redirect",
      handler: () => ({
        status: 302,
        headers: { location: "/leaked-secret-body" },
        body: "sk-leaked-secret-body",
      }),
      // A redirect must never be followed to a different origin.
    },
  ];
  for (const testCase of cases) {
    const workspace = createWorkspace();
    const api = await startPosterApi();
    const balance = await startDeepseekBalanceApi(testCase.handler);
    installDeepseekUsageHelper(workspace);
    const home = seedDeepseekHome(workspace, "deepseek-flash", {
      marker: { version: 1, provider: "deepseek" },
      key: "sk-fixture-deepseek-key",
    });
    seedPosterWorkspace(workspace, api.baseUrl, { deepseek_base_url: balance.baseUrl });
    fs.writeFileSync(
      path.join(workspace.repoDir, "registry.json"),
      `${JSON.stringify({ pool: [], projects: {}, codex_accounts: { "deepseek-flash": home } }, null, 2)}\n`,
    );

    const result = await runScript(workspace, "scripts/usage-stats-poster.py");
    assert.equal(result.exitCode, 0, `${testCase.name}: ${result.stderr || result.stdout}`);
    const payload = api.requests.find((request) => request.method === "POST");
    const codexField = JSON.parse(payload.body).embeds[0].fields.find(({ name }) => name === "Codex");
    assert.match(codexField.value, /Balance: \*unavailable/, testCase.name);
    assert.doesNotMatch(codexField.value, /leaked-secret/, testCase.name);
    assert.doesNotMatch(result.stdout + result.stderr, /leaked-secret/, testCase.name);
    assert.ok(!(result.stdout + result.stderr).includes(home), testCase.name);
    if (testCase.expect) {
      assert.match(codexField.value, testCase.expect, testCase.name);
    }
    assert.equal(balance.requests.filter((request) => request.path === "/leaked-secret-body").length, 0, testCase.name);
  }
});

test("DeepSeek home marker and private key are required and validated", () => {
  const probe = probePoster([
    "import json, os, tempfile",
    "from pathlib import Path",
    "root = Path(tempfile.mkdtemp())",
    "exact = root / 'exact'",
    "exact.mkdir()",
    "(exact / 'ccdm-deepseek.json').write_text(json.dumps({'provider': 'deepseek', 'version': 1}))",
    "(exact / 'api-key').write_text('sk-valid-key-value\\n')",
    "os.chmod(exact / 'api-key', 0o600)",
    "print('exact', poster.is_deepseek_home(exact), poster.read_deepseek_key(exact) == 'sk-valid-key-value')",
    "wrong = root / 'wrong'",
    "wrong.mkdir()",
    "(wrong / 'ccdm-deepseek.json').write_text(json.dumps({'provider': 'other', 'version': 1}))",
    "(wrong / 'api-key').write_text('sk-valid-key-value\\n')",
    "os.chmod(wrong / 'api-key', 0o600)",
    "print('wrong', poster.is_deepseek_home(wrong))",
    "loose = root / 'loose'",
    "loose.mkdir()",
    "(loose / 'ccdm-deepseek.json').write_text(json.dumps({'provider': 'deepseek', 'version': 1}))",
    "(loose / 'api-key').write_text('sk-valid-key-value\\n')",
    "os.chmod(loose / 'api-key', 0o644)",
    "print('loose', poster.read_deepseek_key(loose) is None)",
    "foreign = root / 'foreign'",
    "foreign.mkdir()",
    "(foreign / 'ccdm-deepseek.json').write_text(json.dumps({'provider': 'deepseek', 'version': 1}))",
    "(foreign / 'api-key').write_text('sk-valid-key-value\\n')",
    "os.chmod(foreign / 'api-key', 0o600)",
    "real_euid = os.geteuid()",
    "poster.os.geteuid = lambda: real_euid + 4242",
    "print('foreign_owner', poster.read_deepseek_key(foreign) is None)",
    "poster.os.geteuid = lambda: real_euid",
    "print('current_owner', poster.read_deepseek_key(foreign) == 'sk-valid-key-value')",
    "linked = root / 'linked'",
    "linked.mkdir()",
    "(linked / 'ccdm-deepseek.json').write_text(json.dumps({'provider': 'deepseek', 'version': 1}))",
    "(linked / 'real-key').write_text('sk-valid-key-value\\n')",
    "os.chmod(linked / 'real-key', 0o600)",
    "os.symlink(linked / 'real-key', linked / 'api-key')",
    "print('symlink', poster.read_deepseek_key(linked) is None)",
    "print('nokey', poster.read_deepseek_key(root / 'missing') is None)",
  ].join("\n"));
  assert.equal(probe.status, 0, probe.stderr || probe.stdout);
  assert.match(probe.stdout, /^exact True True$/m);
  assert.match(probe.stdout, /^wrong False$/m);
  assert.match(probe.stdout, /^loose True$/m);
  assert.match(probe.stdout, /^foreign_owner True$/m);
  assert.match(probe.stdout, /^current_owner True$/m);
  assert.match(probe.stdout, /^symlink True$/m);
  assert.match(probe.stdout, /^nokey True$/m);
});

test("DeepSeek credential reads never block on a FIFO", () => {
  const probe = probePosterTimed(20000, [
    "import json, os, tempfile, time",
    "from pathlib import Path",
    "root = Path(tempfile.mkdtemp())",
    "home = root / 'home'",
    "home.mkdir()",
    "(home / 'ccdm-deepseek.json').write_text(json.dumps({'version': 1, 'provider': 'deepseek'}))",
    "os.mkfifo(home / 'api-key')",
    "start = time.monotonic()",
    "key = poster.read_deepseek_key(home)",
    "key_elapsed = time.monotonic() - start",
    "print('fifo_key', key is None, key_elapsed < 2.0)",
    "os.unlink(home / 'api-key')",
    "os.unlink(home / 'ccdm-deepseek.json')",
    "os.mkfifo(home / 'ccdm-deepseek.json')",
    "start = time.monotonic()",
    "marker = poster.is_deepseek_home(home)",
    "marker_elapsed = time.monotonic() - start",
    "print('fifo_marker', marker is False, marker_elapsed < 2.0)",
    "os.unlink(home / 'ccdm-deepseek.json')",
    "(home / 'ccdm-deepseek.json').write_text(json.dumps({'version': 1, 'provider': 'deepseek'}))",
    "print('marker_after', poster.is_deepseek_home(home))",
  ].join("\n"));
  assert.equal(probe.status, 0, `FIFO probe must exit cleanly: ${probe.stderr || probe.stdout}`);
  assert.match(probe.stdout, /^fifo_key True True$/m);
  assert.match(probe.stdout, /^fifo_marker True True$/m);
  assert.match(probe.stdout, /^marker_after True$/m);
});

test("DeepSeek balance override config accepts only literal loopback http origins", () => {
  const probe = probePoster([
    "base = {'discord_channel_id': 'fixture-channel'}",
    "print('default', poster.parse_config(dict(base))['deepseek_base_url'])",
    "print('loopback', poster.parse_config({**base, 'deepseek_base_url': 'http://127.0.0.1:4321'})['deepseek_base_url'])",
    "print('zero_port', poster.parse_config({**base, 'deepseek_base_url': 'http://127.0.0.1:0'})['deepseek_base_url'])",
    "print('ipv6', poster.parse_config({**base, 'deepseek_base_url': 'http://[::1]:4321'})['deepseek_base_url'])",
    "for value in ['https://api.deepseek.com', 'http://example.com:80', 'http://127.0.0.1:80/path', 'http://user:pass@127.0.0.1:80', 'http://[::1', 'http://127.0.0.1:65536']:",
    "    try:",
    "        poster.parse_config({**base, 'deepseek_base_url': value})",
    "    except poster.PosterError as error:",
    "        print('rejected', value, 'sk-' not in str(error))",
    "    except Exception as error:",
    "        print('TRACEBACK', value, type(error).__name__)",
    "    else:",
    "        print('ACCEPTED', value)",
  ].join("\n"));
  assert.equal(probe.status, 0, probe.stderr || probe.stdout);
  assert.match(probe.stdout, /^default https:\/\/api\.deepseek\.com$/m);
  assert.match(probe.stdout, /^loopback http:\/\/127\.0\.0\.1:4321$/m);
  assert.match(probe.stdout, /^zero_port http:\/\/127\.0\.0\.1:0$/m);
  assert.match(probe.stdout, /^ipv6 http:\/\/\[::1\]:4321$/m);
  for (const value of ["https://api.deepseek.com", "http://example.com:80", "http://127.0.0.1:80/path", "http://user:pass@127.0.0.1:80", "http://[::1", "http://127.0.0.1:65536"]) {
    assert.match(probe.stdout, new RegExp(`^rejected ${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} True$`, "m"));
  }
  assert.doesNotMatch(probe.stdout, /ACCEPTED|TRACEBACK/);
});

test("DeepSeek metric stays a codex display-only note and never shadows ordinary Codex limits", () => {
  const probe = probePoster([
    "import json, os, tempfile",
    "from datetime import datetime, timezone",
    "from pathlib import Path",
    "root = Path(tempfile.mkdtemp())",
    "deepseek_home = root / 'deepseek'",
    "deepseek_home.mkdir()",
    "(deepseek_home / 'ccdm-deepseek.json').write_text(json.dumps({'version': 1, 'provider': 'deepseek'}))",
    "(deepseek_home / 'api-key').write_text('sk-unit-test-key\\n')",
    "os.chmod(deepseek_home / 'api-key', 0o600)",
    "ordinary_home = root / 'ordinary'",
    "ordinary_home.mkdir()",
    "poster.read_codex_rate_limits = lambda home: {'planType': 'chatgpt', 'primary': {'usedPercent': 42, 'windowDurationMins': 10080}}",
    "poster._latest_codex_session_data = lambda home: None",
    "poster.fetch_deepseek_balance = lambda key, base_url, **kwargs: {'is_available': True, 'entries': [{'currency': 'USD', 'total': '3.50', 'granted': '0.00', 'topped_up': '3.50'}]}",
    "class FakeUsage:",
    "    @staticmethod",
    "    def collect_month_usage(homes, now):",
    "        return {'status': 'available', 'period': '2026-09', 'input_tokens': 10, 'cached_input_tokens': 0, 'output_tokens': 5, 'reasoning_output_tokens': 0, 'total_tokens': 15, 'sessions': 1, 'partial': False}",
    "registry = {'codex_accounts': {'deepseek-flash': str(deepseek_home), 'work': str(ordinary_home)}}",
    "metrics = poster.collect_codex_metrics(registry, {}, now=datetime(2026, 9, 22, tzinfo=timezone.utc), deepseek_usage=FakeUsage)",
    "deepseek = next(m for m in metrics if m['account'] == 'deepseek-flash')",
    "print('shape', deepseek['provider'], deepseek['limits'] == [], deepseek['source'])",
    "cards = poster._safe_history_cards(metrics)",
    "print('cards', [(c['account'], c['window'], c.get('used_percent')) for c in cards])",
    "print('deepseek_card', any(c['account'] == 'deepseek-flash' for c in cards))",
    "print('note_title', deepseek['dashboard_note']['title'])",
    "print('first_line', deepseek['dashboard_note']['lines'][0])",
  ].join("\n"));
  assert.equal(probe.status, 0, probe.stderr || probe.stdout);
  assert.match(probe.stdout, /^shape codex True deepseek$/m);
  assert.match(probe.stdout, /^cards \[\('work', 'Weekly', 42\.0\)\]$/m);
  assert.match(probe.stdout, /^deepseek_card False$/m);
  assert.match(probe.stdout, /^note_title deepseek-flash · API$/m);
  assert.match(probe.stdout, /^first_line Balance: \*\*\$3\.50\*\*$/m);
});

test("DeepSeek balance transport failures degrade to a bounded unavailable reason", () => {
  const probe = probePoster([
    "from urllib.error import URLError",
    "class Boom:",
    "    def open(self, request, timeout=None):",
    "        raise URLError('fixture timeout')",
    "try:",
    "    poster.fetch_deepseek_balance('sk-unit-test-key', 'http://127.0.0.1:9', opener=Boom())",
    "except poster.PosterError as error:",
    "    print('timeout', 'unavailable' in str(error).lower() or 'failed' in str(error).lower())",
    "try:",
    "    poster.fetch_deepseek_balance('sk-unit-test-key', 'http://127.0.0.1:9', opener=Boom(), timeout=1)",
    "except poster.PosterError as error:",
    "    print('no_key', 'sk-unit-test-key' not in str(error))",
  ].join("\n"));
  assert.equal(probe.status, 0, probe.stderr || probe.stdout);
  assert.match(probe.stdout, /^timeout True$/m);
  assert.match(probe.stdout, /^no_key True$/m);
});

test("DeepSeek multi-currency balances stay separate and never sum", () => {
  const probe = probePoster([
    "payload = {'is_available': False, 'balance_infos': [",
    "    {'currency': 'USD', 'total_balance': '12.34', 'granted_balance': '0.00', 'topped_up_balance': '12.34'},",
    "    {'currency': 'CNY', 'total_balance': '88.00', 'granted_balance': '8.00', 'topped_up_balance': '80.00'},",
    "]}",
    "balance = {'status': 'available', **poster.parse_deepseek_balance(payload)}",
    "note_lines, text_lines = poster._deepseek_display('deepseek-flash', balance, {'status': 'available', 'period': '2026-09', 'total_tokens': 0, 'sessions': 0, 'partial': False})",
    "print('line', note_lines[0])",
    "print('all', '|'.join(note_lines))",
    "print('text', text_lines[0])",
    "print('note_count', len(note_lines))",
    "_, ref_lines = poster._deepseek_display('deepseek-flash', balance, {'status': 'available', 'period': '2026-09', 'total_tokens': 0, 'sessions': 0, 'partial': False}, reference={'currency': 'CNY', 'amount': '100.00'})",
    "print('ref_line', ref_lines[0])",
    "exact = poster.parse_deepseek_balance({'is_available': True, 'balance_infos': [",
    "    {'currency': 'USD', 'total_balance': '0.10', 'granted_balance': '0.00', 'topped_up_balance': '0.10'}]})['entries'][0]",
    "print('exact', exact['total'], exact['topped_up'], exact['granted'])",
    "for bad in [",
    "    {'is_available': True, 'balance_infos': [{'currency': 'usd', 'total_balance': '1'}]},",
    "    {'is_available': True, 'balance_infos': [{'currency': 'EUR', 'total_balance': '1.00', 'granted_balance': '0.00', 'topped_up_balance': '1.00'}]},",
    "    {'is_available': True, 'balance_infos': [{'currency': 'USD', 'total_balance': '1e3'}]},",
    "    {'is_available': True, 'balance_infos': [{'currency': 'USD', 'total_balance': '-1'}]},",
    "    {'is_available': True, 'balance_infos': [{'currency': 'USD', 'total_balance': '1.00', 'granted_balance': '0.00'}]},",
    "    {'is_available': True, 'balance_infos': [{'currency': 'USD', 'total_balance': '1.00', 'granted_balance': 'nope', 'topped_up_balance': '1.00'}]},",
    "]:",
    "    try:",
    "        poster.parse_deepseek_balance(bad)",
    "    except poster.PosterError:",
    "        print('rejected', bad['balance_infos'][0]['currency'], bad['balance_infos'][0].get('total_balance'), bad['balance_infos'][0].get('granted_balance'))",
    "    else:",
    "        print('ACCEPTED', bad)",
  ].join("\n"));
  assert.equal(probe.status, 0, probe.stderr || probe.stdout);
  assert.match(probe.stdout, /^line Balance: \*\*\$12\.34\*\* · \*\*¥88\.00\*\*$/m);
  assert.match(probe.stdout, /^text Balance: \*\*\$12\.34\*\* · \*\*¥88\.00\*\*$/m);
  assert.match(
    probe.stdout,
    /^all Balance: \*\*\$12\.34\*\* · \*\*¥88\.00\*\*\|USD: paid \$12\.34 · granted \$0\.00 · CNY: paid ¥80\.00 · granted ¥8\.00\|\*insufficient for API calls\*\|This month: \*\*0 tokens\*\* · 0 sessions\|\*Balance: whole account · Usage: local Codex\*$/m,
  );
  assert.doesNotMatch(probe.stdout, /100\.34/, "currencies must never be summed");
  assert.match(probe.stdout, /^note_count 5$/m);
  // A CNY reference meters only the CNY balance and still never sums currencies.
  assert.match(probe.stdout, /^ref_line Balance: `\[##\.{13}\]` \*\*12% used · 88% left\*\* · ¥88\.00 of ¥100\.00 ref$/m);
  assert.doesNotMatch(probe.stdout, /\[[#.]+\]` \*\*.*left\*\* · \$/);
  assert.match(probe.stdout, /^exact 0\.10 0\.10 0\.00$/m);
  assert.match(probe.stdout, /^rejected usd 1 None$/m);
  assert.match(probe.stdout, /^rejected EUR 1\.00 0\.00$/m);
  assert.match(probe.stdout, /^rejected USD 1e3 None$/m);
  assert.match(probe.stdout, /^rejected USD -1 None$/m);
  assert.match(probe.stdout, /^rejected USD 1\.00 0\.00$/m);
  assert.match(probe.stdout, /^rejected USD 1\.00 nope$/m);
  assert.doesNotMatch(probe.stdout, /ACCEPTED/);
});

test("DeepSeek balance requests are refused outside the official or loopback origins", () => {
  const probe = probePoster([
    "from urllib.error import URLError",
    "class Recorder:",
    "    def __init__(self):",
    "        self.urls = []",
    "    def open(self, request, timeout=None):",
    "        self.urls.append(request.full_url)",
    "        raise RuntimeError('refused origins must never be contacted')",
    "recorder = Recorder()",
    "for base in ['https://example.com', 'http://user:pass@127.0.0.1:9', 'https://api.deepseek.com.evil.test', 'http://127.0.0.1:9/path']:",
    "    try:",
    "        poster.fetch_deepseek_balance('sk-unit-test-key', base, opener=recorder)",
    "    except poster.PosterError as error:",
    "        print('refused', base, 'sk-unit-test-key' not in str(error))",
    "    else:",
    "        print('SENT', base)",
    "print('sent_count', len(recorder.urls))",
    "class Capture:",
    "    def open(self, request, timeout=None):",
    "        print('url', request.full_url)",
    "        raise URLError('fixture stop')",
    "try:",
    "    poster.fetch_deepseek_balance('sk-unit-test-key', 'https://api.deepseek.com', opener=Capture())",
    "except poster.PosterError as error:",
    "    print('official_error', 'sk-unit-test-key' not in str(error))",
  ].join("\n"));
  assert.equal(probe.status, 0, probe.stderr || probe.stdout);
  for (const value of ["https://example.com", "http://user:pass@127.0.0.1:9", "https://api.deepseek.com.evil.test", "http://127.0.0.1:9/path"]) {
    assert.match(probe.stdout, new RegExp(`^refused ${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} True$`, "m"));
  }
  assert.match(probe.stdout, /^sent_count 0$/m);
  assert.match(probe.stdout, /^url https:\/\/api\.deepseek\.com\/user\/balance$/m);
  assert.match(probe.stdout, /^official_error True$/m);
  assert.doesNotMatch(probe.stdout, /SENT/);
});

test("legacy get_codex_stats reports real DeepSeek balance instead of a placeholder", () => {
  const probe = probePoster([
    "import json, os, tempfile",
    "from pathlib import Path",
    "root = Path(tempfile.mkdtemp())",
    "home = root / 'deepseek'",
    "home.mkdir()",
    "(home / 'ccdm-deepseek.json').write_text(json.dumps({'version': 1, 'provider': 'deepseek'}))",
    "(home / 'api-key').write_text('sk-unit-test-key\\n')",
    "os.chmod(home / 'api-key', 0o600)",
    "poster.load_deepseek_usage_module = lambda path=None: None",
    "poster.fetch_deepseek_balance = lambda key, base_url, **kwargs: {'is_available': True, 'entries': [{'currency': 'USD', 'total': '5.00', 'granted': '0.00', 'topped_up': '5.00'}]}",
    "registry = {'codex_accounts': {'deepseek-flash': str(home)}}",
    "text = poster.get_codex_stats(registry)",
    "print('placeholder', 'metrics path' in text)",
    "print('balance', 'Balance: **$5.00**\\nPaid: $5.00 · Granted: $0.00' in text)",
    "print('local_label', 'local Codex' in text or 'Local usage' in text)",
    "home_text = poster.get_codex_home_stats(home, 'deepseek-flash')",
    "print('home_placeholder', 'metrics path' in home_text)",
    "print('home_balance', 'Balance: **$5.00**' in home_text)",
    "print('no_accounts', poster.get_codex_stats({'codex_accounts': {}}) is None)",
  ].join("\n"));
  assert.equal(probe.status, 0, probe.stderr || probe.stdout);
  assert.match(probe.stdout, /^placeholder False$/m);
  assert.match(probe.stdout, /^balance True$/m);
  assert.match(probe.stdout, /^local_label True$/m);
  assert.match(probe.stdout, /^home_placeholder False$/m);
  assert.match(probe.stdout, /^home_balance True$/m);
  assert.match(probe.stdout, /^no_accounts True$/m);
});

// ---------------------------------------------------------------------------
// DeepSeek text-only report: references, conflicts, and no image workflow.
// ---------------------------------------------------------------------------

test("DeepSeek balance references accept only USD/CNY positive decimals with no extra fields", () => {
  const probe = probePoster([
    "base = {'discord_channel_id': 'fixture-channel'}",
    "print('default', poster.parse_config(dict(base))['deepseek_balance_references'])",
    "print('usd', poster.parse_config({**base, 'deepseek_balance_references': {'deepseek-flash': {'currency': 'USD', 'amount': '50.00'}}})['deepseek_balance_references'])",
    "print('cny', poster.parse_config({**base, 'deepseek_balance_references': {'a': {'currency': 'CNY', 'amount': '88'}}})['deepseek_balance_references'])",
    "for bad in [",
    "    {'a': {'currency': 'usd', 'amount': '1'}},",
    "    {'a': {'currency': 'EUR', 'amount': '1'}},",
    "    {'a': {'currency': 'USD', 'amount': '0'}},",
    "    {'a': {'currency': 'USD', 'amount': '-1'}},",
    "    {'a': {'currency': 'USD', 'amount': '1e3'}},",
    "    {'a': {'currency': 'USD', 'amount': '1.5', 'url': 'http://example.com'}},",
    "    {'a': {'currency': 'USD', 'amount': 50}},",
    "    {'': {'currency': 'USD', 'amount': '1'}},",
    "    {'a': 'nope'},",
    "    [],",
    "]:",
    "    try:",
    "        poster.parse_config({**base, 'deepseek_balance_references': bad})",
    "    except poster.PosterError as error:",
    "        print('rejected', 'sk-' not in str(error), 'http' not in str(error))",
    "    except Exception as error:",
    "        print('TRACEBACK', type(error).__name__)",
    "    else:",
    "        print('ACCEPTED', bad)",
  ].join("\n"));
  assert.equal(probe.status, 0, probe.stderr || probe.stdout);
  assert.match(probe.stdout, /^default \{\}$/m);
  assert.match(probe.stdout, /^usd \{'deepseek-flash': \{'currency': 'USD', 'amount': '50\.00'\}\}$/m);
  assert.match(probe.stdout, /^cny \{'a': \{'currency': 'CNY', 'amount': '88'\}\}$/m);
  assert.equal((probe.stdout.match(/^rejected True True$/gm) || []).length, 10);
  assert.doesNotMatch(probe.stdout, /ACCEPTED|TRACEBACK/);
});

test("scheduled poster posts a referenced DeepSeek block with the inline used-balance meter", async () => {
  const workspace = createWorkspace();
  const api = await startPosterApi();
  const balance = await startDeepseekBalanceApi();
  installDeepseekUsageHelper(workspace);
  const home = seedDeepseekHome(workspace, "deepseek-flash", {
    marker: { version: 1, provider: "deepseek" },
    key: "sk-fixture-deepseek-key",
    session: true,
  });
  const historyPath = path.join(workspace.homeDir, "Library", "Application Support", "CCDM", "usage-stats", "history.sqlite3");
  seedPosterWorkspace(workspace, api.baseUrl, {
    deepseek_base_url: balance.baseUrl,
    deepseek_balance_references: { "deepseek-flash": { currency: "USD", amount: "50.00" } },
    history_db_path: historyPath,
  });
  fs.writeFileSync(
    path.join(workspace.repoDir, "registry.json"),
    `${JSON.stringify({ pool: [], projects: {}, codex_accounts: { "deepseek-flash": home } }, null, 2)}\n`,
  );

  const result = await runScript(workspace, "scripts/usage-stats-poster.py", {
    args: ["--scheduled"],
    env: { CCDM_TEST_NOW: "2026-09-23T10:30:00Z", CCDM_USAGE_STATS_NOTIFY: "0" },
  });
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Posted usage report/);

  const posts = api.requests.filter((request) => request.method === "POST");
  assert.equal(posts.length, 1, "the scheduled report is a single text post");
  assert.equal(posts[0].contentType, "application/json");
  assert.doesNotMatch(posts[0].body, /multipart\/form-data/);
  assert.doesNotMatch(posts[0].body, /filename="[^"]*\.png"/);
  const codexField = JSON.parse(posts[0].body).embeds[0].fields.find(({ name }) => name === "Codex");
  assert.equal(
    codexField.value,
    [
      "**deepseek-flash** (API)",
      "Balance: `[###########....]` **75% used · 25% left** · $12.34 of $50.00 ref",
      "Paid: $12.34 · Granted: $0.00",
      "This month: **1.3k tokens** · 1 session",
      "Tokens: in 900 · out 400 · cached 100",
      "*Balance: whole account · Usage: local Codex*",
    ].join("\n"),
  );
  assert.equal(balance.requests.length, 1);
  assert.doesNotMatch(result.stdout + result.stderr, /sk-fixture-deepseek-key/);
});

test("scheduled poster never renders or attaches images even when the renderer is missing", async () => {
  const workspace = createWorkspace();
  const api = await startPosterApi();
  const historyPath = path.join(workspace.homeDir, "Library", "Application Support", "CCDM", "usage-stats", "history.sqlite3");
  seedPosterWorkspace(workspace, api.baseUrl, { history_db_path: historyPath });
  // Simulate a host without Pillow and without the trend renderer at all.
  fs.rmSync(path.join(workspace.repoDir, "scripts", "usage-dashboard-renderer.py"), { force: true });

  const result = await runScript(workspace, "scripts/usage-stats-poster.py", {
    args: ["--scheduled"],
    env: { CCDM_TEST_NOW: "2026-09-23T10:30:00Z", CCDM_USAGE_STATS_NOTIFY: "0" },
  });
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Posted usage report/);
  const posts = api.requests.filter((request) => request.method === "POST");
  assert.equal(posts.length, 1);
  assert.equal(posts[0].contentType, "application/json");
  assert.doesNotMatch(posts[0].body, /multipart\/form-data|image\/png|filename=/);
  // No trend or dashboard PNG is ever materialized in the history directory.
  const historyDir = path.dirname(historyPath);
  const pngs = fs.existsSync(historyDir)
    ? fs.readdirSync(historyDir).filter((name) => name.endsWith(".png"))
    : [];
  assert.deepEqual(pngs, []);
  // The poster module no longer references the retired DeepSeek renderer.
  assert.doesNotMatch(
    fs.readFileSync("scripts/usage-stats-poster.py", "utf8"),
    /deepseek-dashboard-renderer|DEEPSEEK_RENDERER/,
  );
});

test("DeepSeek reference budget is per-group and omitted on a shared-key conflict", () => {
  const probe = probePoster([
    "import json, os, tempfile",
    "from datetime import datetime, timezone",
    "from pathlib import Path",
    "root = Path(tempfile.mkdtemp())",
    "def mkhome(name, key):",
    "    home = root / name",
    "    home.mkdir()",
    "    (home / 'ccdm-deepseek.json').write_text(json.dumps({'version': 1, 'provider': 'deepseek'}))",
    "    (home / 'api-key').write_text(key + '\\n')",
    "    os.chmod(home / 'api-key', 0o600)",
    "    return home",
    "shared_a = mkhome('deepseek-primary', 'sk-shared-key-value')",
    "shared_b = mkhome('deepseek-mirror', 'sk-shared-key-value')",
    "other = mkhome('deepseek-other', 'sk-distinct-key-value')",
    "class FakeUsage:",
    "    @staticmethod",
    "    def collect_month_usage(homes, now):",
    "        return {'status': 'available', 'period': '2026-09', 'input_tokens': 10, 'cached_input_tokens': 0, 'output_tokens': 5, 'reasoning_output_tokens': 0, 'total_tokens': 15, 'sessions': 1, 'partial': False}",
    "poster.fetch_deepseek_balance = lambda key, base_url, **kwargs: {'is_available': True, 'entries': [{'currency': 'USD', 'total': '34.13', 'granted': '0.00', 'topped_up': '34.13'}]}",
    "registry = {'codex_accounts': {'deepseek-primary': str(shared_a), 'deepseek-mirror': str(shared_b), 'deepseek-other': str(other)}}",
    "def run(references):",
    "    return poster.collect_codex_metrics(registry, {'deepseek_balance_references': references}, now=datetime(2026, 9, 22, 18, tzinfo=timezone.utc), deepseek_usage=FakeUsage)",
    "one = run({'deepseek-mirror': {'currency': 'USD', 'amount': '50.00'}, 'deepseek-other': {'currency': 'USD', 'amount': '20.00'}})",
    "shared = next(m for m in one if m['account'].startswith('deepseek-mirror'))",
    "other_metric = next(m for m in one if m['account'] == 'deepseek-other')",
    "print('shared_line', shared['text'].splitlines()[1])",
    "print('other_line', other_metric['text'].splitlines()[1])",
    "conflict = run({'deepseek-primary': {'currency': 'USD', 'amount': '50.00'}, 'deepseek-mirror': {'currency': 'USD', 'amount': '80.00'}})",
    "shared2 = next(m for m in conflict if m['account'].startswith('deepseek-mirror'))",
    "body = shared2['text']",
    "print('conflict_bar', '[#' in body or '[.' in body)",
    "print('conflict_balance', 'Balance: **$34.13**' in body)",
    "print('conflict_usage', 'This month: **15 tokens** · 1 session' in body)",
    "print('conflict_status', 'Balance reference: *omitted (conflicting configured references for shared key)*' in body)",
  ].join("\n"));
  assert.equal(probe.status, 0, probe.stderr || probe.stdout);
  // The applying alias wins even though the shared-key label combines two homes.
  assert.match(probe.stdout, /^shared_line Balance: `\[#####\.{10}\]` \*\*32% used · 68% left\*\* · \$34\.13 of \$50\.00 ref$/m);
  // Balance above the reference shows zero usage and an honest remaining percentage.
  assert.match(probe.stdout, /^other_line Balance: `\[\.{15}\]` \*\*0% used · 171% left\*\* · \$34\.13 of \$20\.00 ref$/m);
  assert.match(probe.stdout, /^conflict_bar False$/m);
  assert.match(probe.stdout, /^conflict_balance True$/m);
  assert.match(probe.stdout, /^conflict_usage True$/m);
  assert.match(probe.stdout, /^conflict_status True$/m);
});

test("DeepSeek block keeps amount-only output when the balance or local usage is unavailable", () => {
  const probe = probePoster([
    "usage = {'status': 'available', 'period': '2026-09', 'input_tokens': 900, 'cached_input_tokens': 0, 'output_tokens': 400, 'reasoning_output_tokens': 0, 'total_tokens': 1300, 'sessions': 1, 'partial': True}",
    "balance = {'status': 'available', 'is_available': True, 'entries': [{'currency': 'USD', 'total': '34.13', 'granted': '0.00', 'topped_up': '34.13'}]}",
    "print('no_ref', poster._deepseek_display('deepseek-flash', balance, usage)[1][0])",
    "print('partial', [line for line in poster._deepseek_display('deepseek-flash', balance, usage)[1] if line.startswith('This month:')][0])",
    "missing_usage = {'status': 'unavailable', 'reason': 'Local DeepSeek usage collector unavailable'}",
    "print('no_usage', poster._deepseek_display('deepseek-flash', balance, missing_usage)[1][-2])",
    "missing_balance = {'status': 'unavailable', 'reason': 'DeepSeek balance unavailable (HTTP 401)'}",
    "missing_lines = poster._deepseek_display('deepseek-flash', missing_balance, usage)[1]",
    "print('no_balance', missing_lines[0])",
    "print('no_balance_usage', [line for line in missing_lines if line.startswith('This month:')][0])",
  ].join("\n"));
  assert.equal(probe.status, 0, probe.stderr || probe.stdout);
  assert.match(probe.stdout, /^no_ref Balance: \*\*\$34\.13\*\*$/m);
  assert.match(probe.stdout, /^partial This month: \*\*1\.3k tokens\*\* · 1 session · partial$/m);
  assert.match(probe.stdout, /^no_usage This month: \*unavailable \(Local DeepSeek usage collector unavailable\)\*$/m);
  assert.match(probe.stdout, /^no_balance Balance: \*unavailable \(DeepSeek balance unavailable \(HTTP 401\)\)\*$/m);
  assert.match(probe.stdout, /^no_balance_usage This month: \*\*1\.3k tokens\*\* · 1 session · partial$/m);
});
