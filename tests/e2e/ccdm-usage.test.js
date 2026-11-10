// `scripts/ccdm usage`: the on-demand usage report, on fixture Claude homes and a
// local fake of the Anthropic OAuth endpoints. On Linux and macOS it is compared
// line for line with scripts/claude-usage.sh, which usage-report.test.js keeps testing.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";

import { PYTHON, platformGate } from "./support/platform.js";
import { createWorkspace, runScript } from "./support/runner.js";
import { readState, updateState } from "./support/state.js";
import { cleanup, registerTeardownCallback } from "./support/teardown.js";

test.afterEach(async () => {
  await cleanup();
});

const WIN = process.platform === "win32";
const TOKEN = "fixture-oauth-token";
const KEYCHAIN = { CCDM_CLAUDE_CREDENTIALS_STORE: "keychain" };
const FILE_STORE = { CCDM_CLAUDE_CREDENTIALS_STORE: "file" };
const AUTH_ERROR = { type: "error", error: { type: "authentication_error", message: "Invalid bearer token" } };

const PROFILE = {
  account: {
    created_at: "2025-01-01T00:00:00Z",
    display_name: "Fixture User",
    email: "fixture@example.test",
    full_name: "Fixture Example",
  },
  organization: {
    billing_type: "stripe_subscription",
    has_extra_usage_enabled: true,
    organization_type: "claude_max",
    rate_limit_tier: "tier_1",
    subscription_created_at: "2025-01-02T00:00:00Z",
    subscription_status: "active",
  },
};

// Reset times in the past, so both programs print "resetting now" whenever they run.
const USAGE = {
  extra_usage: { is_enabled: true, monthly_limit: 5000, used_credits: 1250, utilization: 25 },
  five_hour: { resets_at: "2026-05-28T16:00:00+00:00", utilization: 40 },
  seven_day: { resets_at: "2026-05-29T16:00:00+00:00", utilization: 70 },
  seven_day_opus: { resets_at: "2026-05-29T16:00:00+00:00", utilization: 85.4 },
  seven_day_sonnet: { resets_at: "2026-05-29T16:00:00+00:00", utilization: 3 },
};

const HEADERS = [
  "CLAUDE CODE USAGE REPORT",
  "ACCOUNT PROFILE",
  "LIVE USAGE LIMITS",
  "LIFETIME TOTALS",
  "DAILY AVERAGES (on active days)",
  "THIS WEEK (last 7 days)",
  "THIS MONTH",
  "MONTHLY BREAKDOWN",
  "TOP 10 BUSIEST DAYS (by messages)",
  "DAY-OF-WEEK DISTRIBUTION",
  "TOP 15 PROJECTS (by message count)",
  "ACTIVE SESSIONS",
  "STREAKS",
];

const stripAnsi = (text) => text.replace(/\x1b\[[0-9;]*m/g, "");
const RULE = "─".repeat(60);

// The titles of the sections, in the order printed: each sits above a rule.
function headersOf(stdout) {
  const lines = stripAnsi(stdout).split("\n");
  return lines.filter((line, index) => lines[index + 1] === RULE);
}

// The report from one header to the end, colours removed.
function from(stdout, header) {
  const text = stripAnsi(stdout);
  const start = text.indexOf(`\n${header}\n`);
  assert.ok(start >= 0, `no "${header}" section in:\n${text}`);
  return text.slice(start);
}

function serviceFor(configDir) {
  return `Claude Code-credentials-${crypto.createHash("sha256").update(configDir).digest("hex").slice(0, 8)}`;
}

function localDateOffset(days) {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() + days);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// The Anthropic OAuth endpoints, on loopback. `reply(token, request)` may answer
// a request itself; otherwise the fixture profile and usage are served.
async function startApi({ rejected = [], reply = () => undefined } = {}) {
  const requests = [];
  const server = http.createServer((request, response) => {
    const token = request.headers.authorization?.replace(/^Bearer /, "");
    requests.push({
      authorization: request.headers.authorization,
      beta: request.headers["anthropic-beta"],
      method: request.method,
      path: request.url,
      userAgent: request.headers["user-agent"],
    });
    let answer = reply(token, request);
    if (answer === undefined) {
      if (rejected.includes(token)) answer = { status: 401, json: AUTH_ERROR };
      else if (request.method === "GET" && request.url === "/api/oauth/profile") answer = { json: PROFILE };
      else if (request.method === "GET" && request.url === "/api/oauth/usage") answer = { json: USAGE };
      else answer = { status: 404, body: "not found" };
    }
    response.statusCode = answer.status ?? 200;
    for (const [name, value] of Object.entries(answer.headers ?? {})) response.setHeader(name, value);
    if (answer.json !== undefined) {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(answer.json));
    } else {
      response.end(answer.body ?? "");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  registerTeardownCallback(async () => {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  });
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, requests };
}

// Every run names a local fake, so no test can reach the real endpoints.
function ccdmUsage(workspace, api, env = {}) {
  return runScript(workspace, "scripts/ccdm", {
    args: ["usage"],
    env: { CCDM_ANTHROPIC_BASE_URL: api.baseUrl, ...env },
    timeoutMs: 30000,
  });
}

function seedKeychain(workspace, credentials) {
  updateState(workspace.stateDir, (state) => {
    state.fixtures.security = { credentials, invocations: [] };
  });
}

// What the fake curl serves to claude-usage.sh: the same bodies the local fake API serves.
function seedCurlRoutes(workspace) {
  updateState(workspace.stateDir, (state) => {
    state.fixtures.curl = {
      requests: [],
      routes: [
        { method: "GET", path: "/api/oauth/profile", json: PROFILE },
        { method: "GET", path: "/api/oauth/usage", json: USAGE },
      ],
    };
  });
}

// A directory the credentials gate accepts on Windows: the current user, SYSTEM
// and Administrators only. A test machine's temp folder can carry other entries.
function protectCredentialsDir(workspace, dir) {
  fs.mkdirSync(dir, { recursive: true });
  if (!WIN) return;
  const sid = spawnSync(PYTHON, ["-c", "import sys; sys.path.insert(0, 'scripts'); from ccdmlib.platform.private_fs import current_user_sid; print(current_user_sid())"], { cwd: workspace.repoDir, encoding: "utf8" });
  assert.equal(sid.status, 0, sid.stderr);
  const icacls = spawnSync("icacls", [dir, "/inheritance:r", "/grant:r", `*${sid.stdout.trim()}:(OI)(CI)F`, "*S-1-5-18:(OI)(CI)F", "*S-1-5-32-544:(OI)(CI)F"], { encoding: "utf8" });
  assert.equal(icacls.status, 0, icacls.stdout);
}

function writeCredentialsFile(workspace, oauth, { name = ".claude", raw = null } = {}) {
  const dir = path.join(workspace.homeDir, name);
  protectCredentialsDir(workspace, dir);
  const file = path.join(dir, ".credentials.json");
  fs.writeFileSync(file, raw ?? JSON.stringify({ claudeAiOauth: oauth }));
  return file;
}

function writeStats(workspace, stats) {
  const claudeDir = path.join(workspace.homeDir, ".claude");
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, "stats-cache.json"), `${JSON.stringify(stats, null, 2)}\n`);
  return claudeDir;
}

function seedMinimalStats(workspace) {
  return writeStats(workspace, { dailyActivity: [], lastComputedDate: "2026-05-28" });
}

// Activity dated from today backwards, as usage-report.test.js seeds it: the
// week, month and current-streak sections have something to count.
function seedRecentHome(workspace) {
  const claudeDir = writeStats(workspace, {
    dailyActivity: [
      { date: localDateOffset(-8), messageCount: 10, sessionCount: 1, toolCallCount: 5 },
      { date: localDateOffset(-1), messageCount: 20, sessionCount: 2, toolCallCount: 8 },
      { date: localDateOffset(0), messageCount: 30, sessionCount: 3, toolCallCount: 13 },
    ],
    lastComputedDate: localDateOffset(0),
  });
  fs.mkdirSync(path.join(claudeDir, "sessions"), { recursive: true });
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

// Activity on fixed dates, so every local section prints the same text on any day
// and in any time zone: session times are built from local clock fields.
function seedFixedHome(workspace) {
  const day = (date, messageCount, sessionCount, toolCallCount) => ({ date, messageCount, sessionCount, toolCallCount });
  const claudeDir = writeStats(workspace, {
    dailyActivity: [
      day("2025-01-06", 1500, 4, 700),
      day("2025-01-07", 250, 2, 90),
      day("2025-01-08", 49, 1, 12),
      day("2025-02-14", 3120, 9, 1810),
      day("2025-03-01", 75, 3, 20),
      day("2025-03-02", 75, 1, 5),
      day("2025-03-03", 80, 2, 31),
      day("2025-03-04", 12, 1, 0),
      day("2025-03-05", 640, 5, 222),
      day("2025-03-10", 101, 2, 47),
      day("2025-03-11", 7, 1, 3),
      day("2025-03-12", 1000, 6, 512),
    ],
    lastComputedDate: "2025-03-12",
  });
  const home = workspace.homeDir;
  const project = (value) => JSON.stringify({ project: value });
  fs.writeFileSync(
    path.join(claudeDir, "history.jsonl"),
    [
      project(`${home}/alpha`),
      project(`${home}/beta`),
      project(`${home}/alpha`),
      "not json",
      project(`/srv/${"very-long-project-directory-name-".repeat(2)}end`),
      project(null),
      JSON.stringify({ display: "an entry without a project" }),
      JSON.stringify([1, 2]),
      project(`${home}/alpha`),
      project(`${home}/beta`),
      project(`${home}/café`),
      ...Array.from({ length: 14 }, (_, index) => project(`/work/p${String(index + 1).padStart(2, "0")}`)),
    ].join("\n") + "\n",
  );
  const sessions = path.join(claudeDir, "sessions");
  fs.mkdirSync(sessions, { recursive: true });
  const session = (name, value) => fs.writeFileSync(path.join(sessions, name), `${JSON.stringify(value)}\n`);
  for (let hour = 1; hour <= 5; hour += 1) {
    session(`10${hour}.json`, { startedAt: new Date(2025, 4, 28, 9 + hour, 30).getTime(), cwd: `${home}/alpha` });
  }
  session("106.json", { startedAt: new Date(2025, 4, 28, 8, 5).getTime(), cwd: `${home}/beta` });
  session("107.json", { cwd: `/srv/${"a-working-directory-with-a-long-name/".repeat(2)}end` });
  session("201.json", { startedAt: new Date(2025, 4, 29, 23, 59).getTime(), cwd: `/srv/${"a-working-directory-with-a-long-name/".repeat(2)}end` });
  fs.writeFileSync(path.join(sessions, "corrupt.json"), "{not json");
  fs.writeFileSync(path.join(sessions, "notes.txt"), "not a session\n");
}

// What both programs print for seedFixedHome, from the first local section to the end.
const FIXED_LOCAL_SECTIONS = `
LIFETIME TOTALS
${RULE}
  Messages:     6,909
  Sessions:     37
  Tool Calls:   3,452
  Active Days:  12
  Period:       2025-01-06 to 2025-03-12

DAILY AVERAGES (on active days)
${RULE}
  Avg Messages/day:     575.8
  Avg Sessions/day:     3.1
  Avg Tool Calls/day:   287.7

THIS WEEK (last 7 days)
${RULE}
  No activity in the last 7 days

THIS MONTH
${RULE}
  No activity this month

MONTHLY BREAKDOWN
${RULE}
  Month        Messages   Sessions      Tools   Days
  ────────── ────────── ────────── ────────── ──────
  2025-01         1,799          7        802      3
  2025-02         3,120          9      1,810      1
  2025-03         1,990         21        840      8

TOP 10 BUSIEST DAYS (by messages)
${RULE}
  Date           Messages   Sessions      Tools
  ──────────── ────────── ────────── ──────────
  2025-02-14        3,120          9      1,810
  2025-01-06        1,500          4        700
  2025-03-12        1,000          6        512
  2025-03-05          640          5        222
  2025-01-07          250          2         90
  2025-03-10          101          2         47
  2025-03-03           80          2         31
  2025-03-01           75          3         20
  2025-03-02           75          1          5
  2025-01-08           49          1         12

DAY-OF-WEEK DISTRIBUTION
${RULE}
  Day            Total Msgs   Avg Msgs   Days
  ──────────── ──────────── ────────── ──────
  Monday              1,681        560      3  ###########
  Tuesday               269         90      3  #
  Wednesday           1,689        563      3  ###########
  Friday              3,120       3120      1  ##############################################################
  Saturday               75         75      1  #
  Sunday                 75         75      1  #

TOP 15 PROJECTS (by message count)
${RULE}
  Project                                       Messages
  ───────────────────────────────────────────── ────────
  ~/alpha                                              3
  ~/beta                                               2
  ...name-very-long-project-directory-name-end         1
  unknown                                              1
  ~/café                                               1
  /work/p01                                            1
  /work/p02                                            1
  /work/p03                                            1
  /work/p04                                            1
  /work/p05                                            1
  /work/p06                                            1
  /work/p07                                            1
  /work/p08                                            1
  /work/p09                                            1
  /work/p10                                            1

ACTIVE SESSIONS
${RULE}
  Active session files: 9
  2025-05-29 23:59  ...orking-directory-with-a-long-name/end
  2025-05-28 14:30  ~/alpha
  2025-05-28 13:30  ~/alpha
  2025-05-28 12:30  ~/alpha
  2025-05-28 11:30  ~/alpha
  ... and 3 more

STREAKS
${RULE}
  Current Streak:  0 day(s)
  Longest Streak:  5 day(s)

  Local data source: ~/.claude/stats-cache.json
  Last computed: 2025-03-12
  Live data source: api.anthropic.com/api/oauth/{usage,profile}

`;

const LIVE_SECTIONS = `
ACCOUNT PROFILE
${RULE}
  Name:           Fixture User (Fixture Example)
  Email:          fixture@example.test
  Plan:           Claude Max
  Rate Limit:     tier_1
  Billing:        Stripe Subscription
  Subscription:   Active
  Extra Usage:    Enabled
  Member Since:   2025-01-01
  Sub Started:    2025-01-02

LIVE USAGE LIMITS
${RULE}
  5-Hour Session:   [########............] 40% used  |  60% left
                    Resets in resetting now

  7-Day (All):      [##############......] 70% used  |  30% left
                    Resets in resetting now

  7-Day (Opus):     [#################...] 85% used  |  15% left
                    Resets in resetting now

  7-Day (Sonnet):   [....................] 3% used  |  97% left
                    Resets in resetting now

  Extra Usage:      [#####...............] 25% used
                    $12.50 / $50.00  ($37.50 remaining)
                    Status: Enabled
`;

test("ccdm usage prints every section of the report in order, from the live API and the local Claude home", async () => {
  const workspace = createWorkspace();
  seedFixedHome(workspace);
  seedKeychain(workspace, { "Claude Code-credentials": { claudeAiOauth: { accessToken: TOKEN } } });
  const api = await startApi();

  const result = await ccdmUsage(workspace, api, KEYCHAIN);

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.doesNotMatch(result.stdout, /\r/);
  assert.deepEqual(headersOf(result.stdout), HEADERS);
  const text = stripAnsi(result.stdout);
  assert.match(text, /^\nCLAUDE CODE USAGE REPORT\n─{60}\n {2}Generated: \d{4}-\d\d-\d\d \d\d:\d\d:\d\d\n\nACCOUNT PROFILE\n/);
  assert.equal(text.slice(text.indexOf("\nACCOUNT PROFILE\n"), text.indexOf("\nLIFETIME TOTALS\n")), LIVE_SECTIONS);
  assert.equal(from(result.stdout, "LIFETIME TOTALS"), FIXED_LOCAL_SECTIONS);
  // The script's colours: bold cyan titles, a dim rule, and limits coloured by how full they are.
  assert.ok(result.stdout.includes("\x1b[1m\x1b[0;36mACCOUNT PROFILE\x1b[0m\n\x1b[2m"));
  assert.ok(result.stdout.includes("\x1b[0;32m40%\x1b[0m") && result.stdout.includes("\x1b[0;33m70%\x1b[0m") && result.stdout.includes("\x1b[0;31m85%\x1b[0m"));

  assert.deepEqual(api.requests, ["profile", "usage"].map((endpoint) => ({
    authorization: `Bearer ${TOKEN}`,
    beta: "oauth-2025-04-20",
    method: "GET",
    path: `/api/oauth/${endpoint}`,
    userAgent: "claude-code/Claude Code fixture 1.0.0",
  })));
  const state = readState(workspace.stateDir);
  assert.deepEqual(state.fixtures.security.invocations.map((entry) => entry.args), [
    ["find-generic-password", "-s", serviceFor(path.join(workspace.homeDir, ".claude")), "-w"],
    ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
  ]);
  assert.deepEqual(state.fixtures.curl.requests, [], "ccdm usage never starts curl");
  assert.deepEqual(state.fixtures.network.blocked, []);
});

test("ccdm usage --help exits 0 without reading a login, and ccdm --help lists the command", async () => {
  const workspace = createWorkspace();
  seedKeychain(workspace, { "Claude Code-credentials": { claudeAiOauth: { accessToken: TOKEN } } });

  const help = await runScript(workspace, "scripts/ccdm", { args: ["usage", "--help"], timeoutMs: 30000 });
  assert.equal(help.exitCode, 0, help.stderr);
  assert.match(help.stdout, /usage: ccdm usage/);
  assert.deepEqual(readState(workspace.stateDir).fixtures.security.invocations, []);

  const listing = await runScript(workspace, "scripts/ccdm", { args: ["--help"], timeoutMs: 30000 });
  assert.equal(listing.exitCode, 0, listing.stderr);
  assert.match(listing.stdout, /^ {4}usage\s+print the Claude usage report/m);
});

// claude-usage.sh gets its live data from the fake curl and ccdm usage from the
// local fake API; both serve the same bodies. Only the "Generated" time may differ.
async function assertSameReport(workspace, api, label) {
  const script = await runScript(workspace, "scripts/claude-usage.sh", { timeoutMs: 30000 });
  const command = await ccdmUsage(workspace, api);
  assert.equal(script.exitCode, 0, script.stderr || script.stdout);
  assert.equal(command.exitCode, 0, command.stderr || command.stdout);
  const generated = /^( {2}Generated: ).*$/m;
  assert.match(script.stdout, generated);
  assert.match(command.stdout, generated);
  const comparable = (stdout) => stdout.replace(generated, "$1<time>");
  assert.equal(stripAnsi(comparable(command.stdout)), stripAnsi(comparable(script.stdout)), `${label}: the reports differ`);
  assert.equal(comparable(command.stdout), comparable(script.stdout), `${label}: the colours differ`);
  return command;
}

test("ccdm usage matches claude-usage.sh line for line on the same fixture home", platformGate("posix", "runs claude-usage.sh, a bash script that needs python3 and curl"), async () => {
  const api = await startApi();
  const hashed = (workspace, name) => serviceFor(path.join(workspace.homeDir, name));

  // Live data and fixed local history: every section, with the limits and the profile.
  const fixed = createWorkspace();
  seedFixedHome(fixed);
  seedCurlRoutes(fixed);
  seedKeychain(fixed, { "Claude Code-credentials": { claudeAiOauth: { accessToken: TOKEN } } });
  const fixedReport = await assertSameReport(fixed, api, "fixed history with live data");
  assert.equal(from(fixedReport.stdout, "LIFETIME TOTALS"), FIXED_LOCAL_SECTIONS);
  assert.deepEqual(headersOf(fixedReport.stdout), HEADERS);

  // Recent history: the week, month and current-streak sections count something.
  // No login, so both print the same two warnings; extra homes without a usable
  // login print their own lines without a network call.
  const recent = createWorkspace();
  seedRecentHome(recent);
  seedCurlRoutes(recent);
  const extraHome = (name, account) => {
    const dir = path.join(recent.homeDir, name);
    fs.mkdirSync(dir, { recursive: true });
    if (account !== undefined) fs.writeFileSync(path.join(dir, ".claude.json"), JSON.stringify(account));
  };
  extraHome(".claude-acme", { oauthAccount: { organizationName: "Acme Org", emailAddress: "acme@example.test" } });
  extraHome(".claude-expired", { oauthAccount: { emailAddress: "expired@example.test" } });
  extraHome(".claude-relogin", { oauthAccount: { emailAddress: "relogin@example.test" } });
  extraHome(".claude-nolabel", {});
  extraHome(".claude-nocfg");
  fs.writeFileSync(path.join(recent.homeDir, ".claude-badjson"), "a file, not a home");
  seedKeychain(recent, {
    [hashed(recent, ".claude-expired")]: { claudeAiOauth: { accessToken: "fixture-expired", refreshToken: "fixture-refresh", expiresAt: Date.now() - 3_600_000 } },
    [hashed(recent, ".claude-relogin")]: { claudeAiOauth: { accessToken: "fixture-expired", expiresAt: Date.now() - 3_600_000 } },
  });
  const requestsBefore = api.requests.length;
  const recentReport = await assertSameReport(recent, api, "recent history without a login");
  const recentText = stripAnsi(recentReport.stdout);
  assert.match(recentText, /Could not fetch profile \(keychain auth may be missing\)/);
  assert.match(recentText, /\nADDITIONAL CLAUDE ACCOUNTS\n─+\n {2}Acme Org {2}\(~\/\.claude-acme\)\n {4}No Keychain credential found for this account\n\n {2}expired@example\.test {2}\(~\/\.claude-expired\)\n {4}OAuth token expired — start a session on this account to refresh\n\n {2}relogin@example\.test {2}\(~\/\.claude-relogin\)\n {4}Needs re-login: CLAUDE_CONFIG_DIR=~\/\.claude-relogin claude \/login\n\nLIFETIME TOTALS\n/);
  assert.match(recentText, /THIS WEEK \(last 7 days\)\n─+\n {2}Messages: {5}50\n/);
  assert.match(recentText, /Current Streak: {2}2 day\(s\)/);
  assert.equal(api.requests.length, requestsBefore, "an expired or missing login is never sent");
  assert.deepEqual(readState(recent.stateDir).fixtures.network.blocked, []);

  // No stats file: both stop after the live sections with the same warning.
  const empty = createWorkspace();
  seedCurlRoutes(empty);
  const emptyReport = await assertSameReport(empty, api, "no stats-cache.json");
  assert.match(emptyReport.stdout, /stats-cache\.json not found — skipping historical stats/);

  // Stats without history or sessions, and a session file that is not JSON.
  const sparse = createWorkspace();
  seedMinimalStats(sparse);
  seedCurlRoutes(sparse);
  const sparseReport = await assertSameReport(sparse, api, "stats only");
  assert.match(sparseReport.stdout, /History file not found/);
  assert.match(sparseReport.stdout, /Sessions directory not found/);
  fs.mkdirSync(path.join(sparse.homeDir, ".claude", "sessions"));
  await assertSameReport(sparse, api, "an empty sessions directory");
  fs.writeFileSync(path.join(sparse.homeDir, ".claude", "sessions", "corrupt.json"), "{not json");
  fs.writeFileSync(path.join(sparse.homeDir, ".claude", "stats-cache.json"), "{not json");
  await assertSameReport(sparse, api, "a stats file that is not JSON");
});

test("ccdm usage uses whichever default-home Keychain item expires last", async () => {
  const hashedService = (workspace) => serviceFor(path.join(workspace.homeDir, ".claude"));
  const stale = { claudeAiOauth: { accessToken: "fixture-stale-token", expiresAt: Date.now() - 60 * 60 * 1000 } };
  const fresh = { claudeAiOauth: { accessToken: TOKEN, expiresAt: Date.now() + 60 * 60 * 1000 } };

  for (const credentialsFor of [
    (workspace) => ({ [hashedService(workspace)]: stale, "Claude Code-credentials": fresh }),
    (workspace) => ({ [hashedService(workspace)]: fresh, "Claude Code-credentials": stale }),
    (workspace) => ({ [hashedService(workspace)]: fresh }),
  ]) {
    const workspace = createWorkspace();
    seedMinimalStats(workspace);
    seedKeychain(workspace, credentialsFor(workspace));
    const api = await startApi({ rejected: ["fixture-stale-token"] });

    const result = await ccdmUsage(workspace, api, KEYCHAIN);

    assert.equal(result.exitCode, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Fixture User \(Fixture Example\)/);
    assert.deepEqual(api.requests.map((entry) => entry.authorization), [`Bearer ${TOKEN}`, `Bearer ${TOKEN}`]);
  }
});

test("ccdm usage falls back to the other Keychain item when the API rejects a token", async () => {
  // The API's rejection as a 401, and as the same body with a 200, which is how the script's curl sees it.
  for (const status of [401, 200]) {
    const workspace = createWorkspace();
    seedMinimalStats(workspace);
    seedKeychain(workspace, {
      [serviceFor(path.join(workspace.homeDir, ".claude"))]: {
        claudeAiOauth: { accessToken: "fixture-revoked-token", expiresAt: Date.now() + 2 * 60 * 60 * 1000 },
      },
      "Claude Code-credentials": {
        claudeAiOauth: { accessToken: TOKEN, expiresAt: Date.now() + 60 * 60 * 1000 },
      },
    });
    const api = await startApi({
      reply: (token) => (token === "fixture-revoked-token" ? { status, json: AUTH_ERROR } : undefined),
    });

    const result = await ccdmUsage(workspace, api, KEYCHAIN);

    assert.equal(result.exitCode, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Fixture User \(Fixture Example\)/);
    assert.match(result.stdout, /5-Hour Session:/);
    assert.deepEqual(api.requests.map((entry) => [entry.path, entry.authorization]), [
      ["/api/oauth/profile", "Bearer fixture-revoked-token"],
      ["/api/oauth/profile", `Bearer ${TOKEN}`],
      ["/api/oauth/usage", `Bearer ${TOKEN}`],
    ]);
  }
});

test("ccdm usage reads .credentials.json without changing it and prints the live sections", async () => {
  const workspace = createWorkspace();
  seedFixedHome(workspace);
  const file = writeCredentialsFile(workspace, { accessToken: TOKEN, refreshToken: "fixture-refresh", expiresAt: Date.now() + 3_600_000 });
  const claudeDir = path.dirname(file);
  const before = { bytes: fs.readFileSync(file), mtimeMs: fs.statSync(file).mtimeMs, names: fs.readdirSync(claudeDir).sort() };
  const api = await startApi();

  const result = await ccdmUsage(workspace, api, FILE_STORE);

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  const text = stripAnsi(result.stdout);
  assert.equal(text.slice(text.indexOf("\nACCOUNT PROFILE\n"), text.indexOf("\nLIFETIME TOTALS\n")), LIVE_SECTIONS);
  assert.equal(from(result.stdout, "LIFETIME TOTALS"), FIXED_LOCAL_SECTIONS);
  assert.deepEqual(api.requests.map((entry) => [entry.path, entry.authorization]), [
    ["/api/oauth/profile", `Bearer ${TOKEN}`],
    ["/api/oauth/usage", `Bearer ${TOKEN}`],
  ]);
  assert.deepEqual(fs.readFileSync(file), before.bytes);
  assert.equal(fs.statSync(file).mtimeMs, before.mtimeMs);
  assert.deepEqual(fs.readdirSync(claudeDir).sort(), before.names, "nothing is created beside the credentials file");
  // The file store never asks the Keychain.
  assert.deepEqual(readState(workspace.stateDir).fixtures.security.invocations, []);
});

test("this OS's own login store is used by default, and its name is in the warning", async () => {
  const workspace = createWorkspace();
  seedMinimalStats(workspace);
  // One login in each store: only this OS's store may be read.
  writeCredentialsFile(workspace, { accessToken: "fixture-file-token", expiresAt: Date.now() + 3_600_000 });
  seedKeychain(workspace, { "Claude Code-credentials": { claudeAiOauth: { accessToken: "fixture-keychain-token" } } });
  const api = await startApi();

  const result = await ccdmUsage(workspace, api);

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Fixture User \(Fixture Example\)/);
  const expected = WIN ? "Bearer fixture-file-token" : "Bearer fixture-keychain-token";
  assert.deepEqual(api.requests.map((entry) => entry.authorization), [expected, expected]);

  const bare = createWorkspace();
  seedMinimalStats(bare);
  const missing = await ccdmUsage(bare, api);
  assert.equal(missing.exitCode, 0, missing.stderr || missing.stdout);
  const hint = WIN ? "credentials file may be missing" : "keychain auth may be missing";
  assert.ok(stripAnsi(missing.stdout).includes(`  Could not fetch profile (${hint})\n`), missing.stdout);
  assert.ok(stripAnsi(missing.stdout).includes(`  Could not fetch live usage (${hint})\n`), missing.stdout);
  assert.equal(api.requests.length, 2, "no request without a login");
});

test("missing or malformed credentials skip the live sections with a warning and exit 0", async () => {
  const api = await startApi();
  const warnings = (stdout, hint) => {
    const text = stripAnsi(stdout);
    assert.ok(text.includes(`\nACCOUNT PROFILE\n${RULE}\n  Could not fetch profile (${hint})\n\nLIVE USAGE LIMITS\n${RULE}\n  Could not fetch live usage (${hint})\n\nLIFETIME TOTALS\n`), text);
    assert.equal(from(stdout, "LIFETIME TOTALS"), FIXED_LOCAL_SECTIONS);
  };

  // No credentials file at all.
  const missing = createWorkspace();
  seedFixedHome(missing);
  const noFile = await ccdmUsage(missing, api, FILE_STORE);
  assert.equal(noFile.exitCode, 0, noFile.stderr || noFile.stdout);
  warnings(noFile.stdout, "credentials file may be missing");
  assert.ok(noFile.stdout.includes("\x1b[0;33mCould not fetch profile (credentials file may be missing)\x1b[0m"));

  // A file cut off mid-write, a file that is not JSON, one without a token, and an empty one.
  for (const raw of ['{"claudeAiOauth": {"accessTo', "not json", JSON.stringify({ claudeAiOauth: { refreshToken: "fixture-refresh" } }), ""]) {
    const workspace = createWorkspace();
    seedFixedHome(workspace);
    const file = writeCredentialsFile(workspace, null, { raw });
    const result = await ccdmUsage(workspace, api, FILE_STORE);
    assert.equal(result.exitCode, 0, result.stderr || result.stdout);
    warnings(result.stdout, "credentials file may be missing");
    assert.equal(fs.readFileSync(file, "utf8"), raw);
  }

  // No Keychain item, and one that is not a login.
  const keychain = createWorkspace();
  seedFixedHome(keychain);
  const noItem = await ccdmUsage(keychain, api, KEYCHAIN);
  assert.equal(noItem.exitCode, 0, noItem.stderr || noItem.stdout);
  warnings(noItem.stdout, "keychain auth may be missing");
  seedKeychain(keychain, { "Claude Code-credentials": { claudeAiOauth: { accessToken: "" } } });
  const emptyItem = await ccdmUsage(keychain, api, KEYCHAIN);
  assert.equal(emptyItem.exitCode, 0, emptyItem.stderr || emptyItem.stdout);
  warnings(emptyItem.stdout, "keychain auth may be missing");

  assert.deepEqual(api.requests, [], "nothing is sent without a usable login");
});

test("a stale login the API rejects prints the warnings and the local sections still print", async () => {
  const workspace = createWorkspace();
  seedFixedHome(workspace);
  const file = writeCredentialsFile(workspace, { accessToken: "fixture-stale-token", refreshToken: "fixture-refresh", expiresAt: Date.now() - 3_600_000 });
  const before = fs.readFileSync(file);
  const api = await startApi({ rejected: ["fixture-stale-token"] });

  const result = await ccdmUsage(workspace, api, FILE_STORE);

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  const text = stripAnsi(result.stdout);
  assert.match(text, /Could not fetch profile \(credentials file may be missing\)/);
  assert.match(text, /Could not fetch live usage \(credentials file may be missing\)/);
  assert.doesNotMatch(text, /N\/A/);
  assert.equal(from(result.stdout, "LIFETIME TOTALS"), FIXED_LOCAL_SECTIONS);
  // Asked, rejected, and never refreshed: no other endpoint is called and the file is untouched.
  assert.deepEqual(api.requests.map((entry) => entry.path), ["/api/oauth/profile", "/api/oauth/usage"]);
  assert.deepEqual(fs.readFileSync(file), before);
  assert.doesNotMatch(result.stdout + result.stderr, /fixture-stale-token|fixture-refresh/);
});

test("malformed API responses and an unreachable API print the warnings and exit 0", async () => {
  const workspace = createWorkspace();
  seedFixedHome(workspace);
  seedKeychain(workspace, { "Claude Code-credentials": { claudeAiOauth: { accessToken: TOKEN } } });
  const bodies = { "/api/oauth/profile": "not json", "/api/oauth/usage": "{broken" };
  const malformedApi = await startApi({ reply: (_token, request) => ({ body: bodies[request.url] }) });

  const malformed = await ccdmUsage(workspace, malformedApi, KEYCHAIN);
  assert.equal(malformed.exitCode, 0, malformed.stderr || malformed.stdout);
  assert.match(malformed.stdout, /Could not fetch profile \(keychain auth may be missing\)/);
  assert.match(malformed.stdout, /Could not fetch live usage \(keychain auth may be missing\)/);
  assert.equal(from(malformed.stdout, "LIFETIME TOTALS"), FIXED_LOCAL_SECTIONS);
  assert.equal(malformedApi.requests.length, 2);

  // A usage window in a shape that cannot be printed hides only itself.
  const partialApi = await startApi({
    reply: (_token, request) => (request.url === "/api/oauth/usage"
      ? { json: { five_hour: { utilization: 0, resets_at: null }, seven_day: { utilization: 70, resets_at: "2026-05-29T16:00:00Z" } } }
      : undefined),
  });
  const partial = await ccdmUsage(workspace, partialApi, KEYCHAIN);
  assert.equal(partial.exitCode, 0, partial.stderr || partial.stdout);
  assert.match(stripAnsi(partial.stdout), / {2}7-Day \(All\): {6}\[#{14}\.{6}\] 70% used {2}\| {2}30% left\n {20}Resets in resetting now\n/);
  assert.doesNotMatch(partial.stderr, /Traceback/);
  assert.equal(from(partial.stdout, "LIFETIME TOTALS"), FIXED_LOCAL_SECTIONS);

  // Nothing listens on the discard port.
  const unreachable = await ccdmUsage(workspace, { baseUrl: "http://127.0.0.1:9" }, KEYCHAIN);
  assert.equal(unreachable.exitCode, 0, unreachable.stderr || unreachable.stdout);
  assert.match(unreachable.stdout, /Could not fetch profile/);
  assert.match(unreachable.stdout, /Could not fetch live usage/);
  assert.equal(from(unreachable.stdout, "LIFETIME TOTALS"), FIXED_LOCAL_SECTIONS);
  assert.doesNotMatch(unreachable.stdout + unreachable.stderr, new RegExp(TOKEN));
});

test("missing stats-cache.json skips the historical sections with the script's warning and exits 0", async () => {
  const workspace = createWorkspace();
  const api = await startApi();

  const result = await ccdmUsage(workspace, api);

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.deepEqual(headersOf(result.stdout), HEADERS.slice(0, 3));
  assert.ok(result.stdout.endsWith("\n\n  \x1b[0;33mstats-cache.json not found — skipping historical stats\x1b[0m\n"), JSON.stringify(result.stdout.slice(-120)));
});

test("ccdm usage tolerates corrupt session JSON and counts recent activity", async () => {
  const workspace = createWorkspace();
  seedRecentHome(workspace);
  fs.writeFileSync(path.join(workspace.homeDir, ".claude", "sessions", "corrupt.json"), "{not json");
  const api = await startApi();

  const result = await ccdmUsage(workspace, api);

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Messages:\s+60/);
  assert.match(result.stdout, /Sessions:\s+6/);
  assert.match(result.stdout, /Tool Calls:\s+26/);
  assert.match(result.stdout, /Active Days:\s+3/);
  assert.match(result.stdout, /THIS WEEK \(last 7 days\)[^\n]*\n[^\n]*\n {2}Messages: {5}50\n {2}Sessions: {5}5\n {2}Tool Calls: {3}21\n {2}Active Days: {2}2\n/);
  assert.match(result.stdout, /Current Streak:\s+2 day\(s\)/);
  assert.match(result.stdout, /Longest Streak:\s+2 day\(s\)/);
  assert.match(result.stdout, /Active session files: 2/);
  assert.match(result.stdout, /~\/alpha\s+2/);
  assert.match(result.stdout, /2026-05-28 \d{2}:\d{2}\s+~\/alpha/);
});

test("additional Claude accounts are read from their own homes, each with its own login", async () => {
  const workspace = createWorkspace();
  seedMinimalStats(workspace);
  const extraHome = (name, account, oauth) => {
    const dir = path.join(workspace.homeDir, name);
    if (oauth) writeCredentialsFile(workspace, oauth, { name });
    else fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, ".claude.json"), JSON.stringify({ oauthAccount: account }));
  };
  extraHome(".claude-acme", { organizationName: "Acme Org" }, { accessToken: "fixture-extra-token", expiresAt: Date.now() + 3_600_000 });
  extraHome(".claude-expired", { emailAddress: "expired@example.test" }, { accessToken: "fixture-expired", refreshToken: "fixture-refresh", expiresAt: Date.now() - 3_600_000 });
  extraHome(".claude-none", { emailAddress: "none@example.test" });
  extraHome(".claude-relogin", { emailAddress: "relogin@example.test" }, { accessToken: "fixture-expired", expiresAt: Date.now() - 3_600_000 });
  extraHome(".claude-revoked", { emailAddress: "revoked@example.test" }, { accessToken: "fixture-revoked-token" });
  const api = await startApi({
    rejected: ["fixture-revoked-token"],
    reply: (token) => (token === "fixture-extra-token"
      ? { json: { five_hour: { utilization: 12 }, seven_day: { utilization: 55.5 }, seven_day_sonnet: { utilization: null }, seven_day_opus: null } }
      : undefined),
  });

  const result = await ccdmUsage(workspace, api, FILE_STORE);

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  const text = stripAnsi(result.stdout);
  assert.equal(text.slice(text.indexOf("\nADDITIONAL CLAUDE ACCOUNTS\n"), text.indexOf("\nLIFETIME TOTALS\n")), `
ADDITIONAL CLAUDE ACCOUNTS
${RULE}
  Acme Org  (~/.claude-acme)
    5-Hour Session:   [##..................] 12% used  |  88% left
    7-Day (All):      [###########.........] 56% used  |  44% left
    7-Day (Sonnet):   [....................] 0% used  |  100% left

  expired@example.test  (~/.claude-expired)
    OAuth token expired — start a session on this account to refresh

  none@example.test  (~/.claude-none)
    No credentials file found for this account

  relogin@example.test  (~/.claude-relogin)
    Needs re-login: CLAUDE_CONFIG_DIR=~/.claude-relogin claude /login

  revoked@example.test  (~/.claude-revoked)
    API error: HTTP Error 401: Unauthorized
`);
  // The default home has no login; each extra home's own token goes to the usage endpoint only.
  assert.deepEqual(api.requests.map((entry) => [entry.path, entry.authorization, entry.userAgent]), [
    ["/api/oauth/usage", "Bearer fixture-extra-token", "claude-code/2.0.32"],
    ["/api/oauth/usage", "Bearer fixture-revoked-token", "claude-code/2.0.32"],
  ]);
  assert.doesNotMatch(result.stdout + result.stderr, /fixture-extra-token|fixture-revoked-token|fixture-expired|fixture-refresh/);
});

test("the OAuth token goes to the API in a header and never into a child process's arguments or environment", async () => {
  // Runs the command in-process with every child start recorded.
  const driver = `#!/usr/bin/env python3
import json, os, subprocess, sys
sys.dont_write_bytecode = True
here = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(here, "scripts"))
log = os.path.join(here, "usage-children.jsonl")
started = subprocess.Popen.__init__
def recording(self, args, *rest, **options):
    with open(log, "a", encoding="utf-8") as stream:
        stream.write(json.dumps({
            "args": [args] if isinstance(args, (str, bytes)) else [os.fsdecode(arg) for arg in args],
            "env": json.dumps(dict(options["env"])) if options.get("env") is not None else "",
        }) + "\\n")
    return started(self, args, *rest, **options)
subprocess.Popen.__init__ = recording
from ccdmlib.cli import main
raise SystemExit(main(["usage"]))
`;
  for (const store of [KEYCHAIN, FILE_STORE]) {
    const workspace = createWorkspace();
    seedMinimalStats(workspace);
    seedKeychain(workspace, { "Claude Code-credentials": { claudeAiOauth: { accessToken: TOKEN, refreshToken: "fixture-refresh" } } });
    writeCredentialsFile(workspace, { accessToken: TOKEN, refreshToken: "fixture-refresh", expiresAt: Date.now() + 3_600_000 });
    writeCredentialsFile(workspace, { accessToken: "fixture-extra-token", expiresAt: Date.now() + 3_600_000 }, { name: ".claude-acme" });
    fs.writeFileSync(path.join(workspace.homeDir, ".claude-acme", ".claude.json"), JSON.stringify({ oauthAccount: { organizationName: "Acme Org" } }));
    const script = path.join(workspace.repoDir, "usage-driver.py");
    fs.writeFileSync(script, driver);
    fs.chmodSync(script, 0o755);
    const api = await startApi();

    const result = await runScript(workspace, "usage-driver.py", { env: { CCDM_ANTHROPIC_BASE_URL: api.baseUrl, ...store }, timeoutMs: 30000 });

    assert.equal(result.exitCode, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Fixture User \(Fixture Example\)/);
    assert.ok(api.requests.length >= 2 && api.requests.slice(0, 2).every((entry) => entry.authorization === `Bearer ${TOKEN}`));
    const children = fs.readFileSync(path.join(workspace.repoDir, "usage-children.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.ok(children.some((child) => child.args.at(-1) === "--version"), "the recorder saw `claude --version` start");
    if (store === KEYCHAIN) assert.ok(children.some((child) => child.args.includes("find-generic-password")));
    for (const child of children) {
      assert.doesNotMatch(child.args.join(" "), /fixture-oauth-token|fixture-extra-token|fixture-refresh|Bearer/, `a child's arguments: ${child.args.join(" ")}`);
      assert.doesNotMatch(child.env, /fixture-oauth-token|fixture-extra-token|fixture-refresh/, "a child's environment");
    }
    assert.doesNotMatch(result.stdout + result.stderr, /fixture-oauth-token|fixture-extra-token|fixture-refresh/);
    const state = readState(workspace.stateDir);
    assert.doesNotMatch(JSON.stringify(state.fixtures.security.invocations), /fixture-oauth-token/);
    assert.deepEqual(state.fixtures.curl.requests, []);
  }
});

test("the token is not sent after a redirect, and only a loopback address can replace the API", async () => {
  const workspace = createWorkspace();
  seedMinimalStats(workspace);
  seedKeychain(workspace, { "Claude Code-credentials": { claudeAiOauth: { accessToken: TOKEN } } });
  const elsewhere = await startApi();
  const redirecting = await startApi({
    reply: (_token, request) => ({ status: 302, headers: { location: `${elsewhere.baseUrl}${request.url}` } }),
  });

  const redirected = await ccdmUsage(workspace, redirecting, KEYCHAIN);
  assert.equal(redirected.exitCode, 0, redirected.stderr || redirected.stdout);
  assert.match(redirected.stdout, /Could not fetch profile/);
  assert.match(redirected.stdout, /Could not fetch live usage/);
  assert.equal(redirecting.requests.length, 2);
  assert.deepEqual(elsewhere.requests, [], "a redirect is not followed");

  for (const address of ["https://example.test", "http://example.test", "http://127.0.0.1.example.test:8080", `${elsewhere.baseUrl}/api`, "http://name@127.0.0.1:9", "http://127.0.0.1:port"]) {
    const refused = await ccdmUsage(workspace, { baseUrl: address }, KEYCHAIN);
    assert.equal(refused.exitCode, 0, refused.stderr || refused.stdout);
    assert.match(refused.stderr, /CCDM_ANTHROPIC_BASE_URL must be a loopback http:\/\/ address; live data is skipped/, address);
    assert.match(refused.stdout, /Could not fetch profile/);
    assert.match(refused.stdout, /LIFETIME TOTALS/);
  }
  assert.deepEqual(elsewhere.requests, []);
  const state = readState(workspace.stateDir);
  assert.deepEqual(state.fixtures.network.blocked, []);
  // Refused before the login is read: only the redirect run asked the Keychain.
  assert.equal(state.fixtures.security.invocations.length, 2);
});
