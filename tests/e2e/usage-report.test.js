import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { createWorkspace, runScript } from "./support/runner.js";
import { readState, writeState } from "./support/state.js";
import { cleanup } from "./support/teardown.js";

test.afterEach(async () => {
  await cleanup();
});

function localDateOffset(days) {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() + days);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function seedClaudeUsageHome(workspace) {
  const claudeDir = path.join(workspace.homeDir, ".claude");
  fs.mkdirSync(path.join(claudeDir, "sessions"), { recursive: true });
  fs.writeFileSync(
    path.join(claudeDir, "stats-cache.json"),
    `${JSON.stringify(
      {
        dailyActivity: [
          { date: localDateOffset(-8), messageCount: 10, sessionCount: 1, toolCallCount: 5 },
          { date: localDateOffset(-1), messageCount: 20, sessionCount: 2, toolCallCount: 8 },
          { date: localDateOffset(0), messageCount: 30, sessionCount: 3, toolCallCount: 13 },
        ],
        lastComputedDate: localDateOffset(0),
      },
      null,
      2,
    )}\n`,
  );
  fs.writeFileSync(
    path.join(claudeDir, "history.jsonl"),
    [
      JSON.stringify({ project: `${workspace.homeDir}/alpha` }),
      JSON.stringify({ project: `${workspace.homeDir}/alpha` }),
      JSON.stringify({ project: `${workspace.homeDir}/beta` }),
    ].join("\n") + "\n",
  );
  fs.writeFileSync(
    path.join(claudeDir, "sessions", "100.json"),
    `${JSON.stringify({ startedAt: Date.UTC(2026, 4, 28, 10, 30), cwd: `${workspace.homeDir}/alpha` })}\n`,
  );
}

function seedMinimalStats(workspace, stats = {}) {
  const claudeDir = path.join(workspace.homeDir, ".claude");
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(
    path.join(claudeDir, "stats-cache.json"),
    `${JSON.stringify(
      {
        dailyActivity: [],
        lastComputedDate: "2026-05-28",
        ...stats,
      },
      null,
      2,
    )}\n`,
  );
}

function seedAnthropicRoutes(workspace, overrides = {}) {
  const state = readState(workspace.stateDir);
  state.fixtures.security = {
    credentials: {
      "Claude Code-credentials": {
        claudeAiOauth: { accessToken: "fixture-oauth-token" },
      },
    },
    invocations: [],
  };
  state.fixtures.curl = {
    requests: [],
    routes: [
      {
        method: "GET",
        path: "/api/oauth/profile",
        json: {
          account: {
            created_at: "2025-01-01T00:00:00Z",
            display_name: "Fixture User",
            email: "fixture@example.test",
            full_name: "Fixture Example",
          },
          organization: {
            billing_type: "subscription",
            has_extra_usage_enabled: true,
            organization_type: "pro",
            rate_limit_tier: "tier_1",
            subscription_created_at: "2025-01-02T00:00:00Z",
            subscription_status: "active",
          },
        },
      },
      {
        method: "GET",
        path: "/api/oauth/usage",
        json: {
          extra_usage: {
            is_enabled: true,
            monthly_limit: 5000,
            used_credits: 1250,
            utilization: 25,
          },
          five_hour: {
            resets_at: "2026-05-28T16:00:00+00:00",
            utilization: 40,
          },
          seven_day: {
            resets_at: "2026-05-29T16:00:00+00:00",
            utilization: 70,
          },
        },
      },
    ],
    ...overrides,
  };
  writeState(state, workspace.stateDir);
}

function seedSecurityCredential(workspace) {
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

test("claude usage report reads live OAuth data and local history from fixtures", async () => {
  const workspace = createWorkspace();
  seedClaudeUsageHome(workspace);
  seedAnthropicRoutes(workspace);

  const result = await runScript(workspace, "scripts/claude-usage.sh");

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Fixture User \(Fixture Example\)/);
  assert.match(result.stdout, /fixture@example\.test/);
  assert.match(result.stdout, /5-Hour Session:/);
  assert.match(result.stdout, /Messages:\s+60/);
  assert.match(result.stdout, /Sessions:\s+6/);
  assert.match(result.stdout, /Tool Calls:\s+26/);
  assert.match(result.stdout, /Active Days:\s+3/);
  assert.match(result.stdout, /~\/alpha\s+2/);
  assert.match(result.stdout, /2026-05-28 \d{2}:\d{2}\s+~\/alpha/);

  const state = readState(workspace.stateDir);
  assert.deepEqual(
    state.fixtures.security.invocations.map((entry) => entry.args),
    [
      ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
      ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
    ],
  );
  assert.deepEqual(
    state.fixtures.curl.requests.map((entry) => ({
      authorization: entry.headers.Authorization,
      method: entry.method,
      path: entry.path,
      userAgent: entry.headers["User-Agent"],
    })),
    [
      {
        authorization: "Bearer fixture-oauth-token",
        method: "GET",
        path: "/api/oauth/profile",
        userAgent: "claude-code/Claude Code fixture 1.0.0",
      },
      {
        authorization: "Bearer fixture-oauth-token",
        method: "GET",
        path: "/api/oauth/usage",
        userAgent: "claude-code/Claude Code fixture 1.0.0",
      },
    ],
  );
  assert.deepEqual(state.fixtures.network.blocked, []);
});

test("security and curl fixtures enforce route contracts and block unapproved targets", async () => {
  const workspace = createWorkspace();
  seedSecurityCredential(workspace);
  const state = readState(workspace.stateDir);
  state.fixtures.curl.routes = [
    {
      body: "profile-body",
      method: "POST",
      path: "/api/oauth/profile",
    },
    {
      json: { usage: true },
      method: "GET",
      path: "/api/oauth/usage",
    },
  ];
  writeState(state, workspace.stateDir);

  const contractScript = path.join(workspace.repoDir, "fixture-contract.sh");
  fs.writeFileSync(
    contractScript,
    `#!/bin/sh
set -eu
security find-generic-password -s "Claude Code-credentials" -w
printf '{"request":true}' | curl -s -X POST "https://api.anthropic.com/api/oauth/profile" -H "Authorization: Bearer fixture-oauth-token" -H "Content-Type: application/json" -d @-
curl -s "https://api.anthropic.com/api/oauth/usage"
set +e
curl -s "https://example.test/not-approved"
blocked_status=$?
set -e
echo "blocked_status=$blocked_status"
`,
  );
  fs.chmodSync(contractScript, 0o755);

  const result = await runScript(workspace, "fixture-contract.sh");
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /fixture-oauth-token/);
  assert.match(result.stdout, /profile-body/);
  assert.match(result.stdout, /\{"usage":true\}/);
  assert.match(result.stdout, /blocked_status=43/);

  const nextState = readState(workspace.stateDir);
  assert.deepEqual(nextState.fixtures.security.invocations[0].args, [
    "find-generic-password",
    "-s",
    "Claude Code-credentials",
    "-w",
  ]);
  assert.deepEqual(
    nextState.fixtures.curl.requests.map((request) => ({
      body: request.body,
      contentType: request.headers["Content-Type"],
      method: request.method,
      path: request.path,
    })),
    [
      {
        body: '{"request":true}',
        contentType: "application/json",
        method: "POST",
        path: "/api/oauth/profile",
      },
      {
        body: "",
        contentType: undefined,
        method: "GET",
        path: "/api/oauth/usage",
      },
      {
        body: "",
        contentType: undefined,
        method: "GET",
        path: "/not-approved",
      },
    ],
  );
  const blocked = nextState.fixtures.network.blocked;
  assert.equal(blocked.length, 1);
  assert.ok(blocked.some((entry) => entry.kind === "curl" && entry.target === "https://example.test/not-approved"));
});

test("usage report handles missing auth, malformed API responses, and missing local stats gracefully", async () => {
  const workspace = createWorkspace();
  const state = readState(workspace.stateDir);
  state.fixtures.curl.routes = [
    { method: "GET", path: "/api/oauth/profile", body: "not json" },
    { method: "GET", path: "/api/oauth/usage", body: "{broken" },
  ];
  writeState(state, workspace.stateDir);
  seedMinimalStats(workspace);

  const missingAuth = await runScript(workspace, "scripts/claude-usage.sh");
  assert.equal(missingAuth.exitCode, 0, missingAuth.stderr || missingAuth.stdout);
  assert.match(missingAuth.stdout, /Could not fetch profile/);
  assert.match(missingAuth.stdout, /Could not fetch live usage/);
  assert.deepEqual(readState(workspace.stateDir).fixtures.curl.requests, []);

  seedSecurityCredential(workspace);
  const malformed = await runScript(workspace, "scripts/claude-usage.sh");
  assert.equal(malformed.exitCode, 0, malformed.stderr || malformed.stdout);
  assert.match(malformed.stdout, /Could not fetch profile/);
  assert.match(malformed.stdout, /Could not fetch live usage/);

  const noStatsWorkspace = createWorkspace();
  const noStats = await runScript(noStatsWorkspace, "scripts/claude-usage.sh");
  assert.equal(noStats.exitCode, 0, noStats.stderr || noStats.stdout);
  assert.match(noStats.stdout, /stats-cache\.json not found/);
});

test("usage report tolerates corrupt session JSON while preserving stats and project output", async () => {
  const workspace = createWorkspace();
  seedClaudeUsageHome(workspace);
  fs.writeFileSync(path.join(workspace.homeDir, ".claude", "sessions", "corrupt.json"), "{not json");

  const result = await runScript(workspace, "scripts/claude-usage.sh");

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Messages:\s+60/);
  assert.match(result.stdout, /Current Streak:\s+2 day\(s\)/);
  assert.match(result.stdout, /Longest Streak:\s+2 day\(s\)/);
  assert.match(result.stdout, /Active session files: 2/);
  assert.match(result.stdout, /~\/alpha\s+2/);
});
