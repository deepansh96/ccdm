import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";

import { createWorkspace, runScript } from "./support/runner.js";
import { readState, writeState } from "./support/state.js";
import { cleanup, registerTeardownCallback } from "./support/teardown.js";

test.afterEach(async () => {
  await cleanup();
});

async function startPosterApi() {
  const requests = [];
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
        method: request.method,
        path: request.url,
      });

      if (request.method === "GET" && request.url === "/api/oauth/profile") {
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
          organization: { organization_type: "pro" },
        }));
        return;
      }
      if (request.method === "GET" && request.url === "/api/oauth/usage") {
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
        }));
        return;
      }
      if (request.method === "POST" && request.url === "/api/v10/channels/fixture-channel/messages") {
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
