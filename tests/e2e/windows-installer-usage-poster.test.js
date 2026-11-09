// The Windows usage collector: install, uninstall and one scheduled run through a
// fixture schtasks. Task Scheduler is never reached: `schtasks` resolves to the
// workspace's fixture and the workspace's PATH holds nothing else. Windows only
// collects, so a run must leave the Local Fake Discord untouched.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import nodeTest from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PYTHON, platformGate, suiteTest } from "./support/platform.js";
import { routerEnv, createRouterWorkspace } from "./support/router.js";
import { runScript, scaledTimeout } from "./support/runner.js";
import { readState } from "./support/state.js";
import { cleanup, registerTeardownCallback } from "./support/teardown.js";

const test = suiteTest(nodeTest, import.meta.url);
test.afterEach(async () => cleanup());

const require = createRequire(import.meta.url);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const TASK = "\\CCDM\\UsagePoster";
const onlyWindows = platformGate("win32", "Task Scheduler and conhost exist only on Windows");
const MAXIMUM_INTERVAL = 31 * 24 * 60 * 60;

const invocations = workspace => readState(workspace.stateDir).fixtures.schtasks.invocations;
const verbs = workspace => invocations(workspace).map(entry => entry.verb);
const definition = workspace => readState(workspace.stateDir).fixtures.schtasks.definitions[TASK];
const defaultStateRoot = workspace => path.join(workspace.homeDir, ".local", "state", "ccdm");
const serviceFile = (stateRoot, suffix) => path.join(stateRoot, "services", `usage-poster${suffix}`);
const readConfig = stateRoot => JSON.parse(fs.readFileSync(serviceFile(stateRoot, ".json"), "utf8"));
const posterConfigFile = workspace => path.join(workspace.repoDir, ".usage-stats-poster.json");

function installEnv(workspace, extra = {}) {
  return routerEnv(workspace, {
    CCDM_CODEX_PATH: path.join(workspace.fixtureDir, "codex.exe"),
    CCDM_PYTHON: PYTHON,
    CCDM_ROUTER_NODE: process.execPath,
    ...extra,
  });
}

// Python directly on Windows, as the other installer test does.
const ccdm = (workspace, args, env = {}) => runScript(workspace, "scripts/ccdm.py", {
  args, env: installEnv(workspace, env), timeoutMs: scaledTimeout(30000),
});

function createPosterWorkspace(posterConfig = {}) {
  const workspace = createRouterWorkspace();
  fs.writeFileSync(posterConfigFile(workspace), JSON.stringify(posterConfig));
  return workspace;
}

// One fake server for every service the poster could reach; it records each request.
async function startFakeServices() {
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push({ method: request.method, path: request.url });
    request.resume();
    response.setHeader("content-type", "application/json");
    if (request.method === "GET" && request.url === "/api/oauth/profile") {
      response.end(JSON.stringify({ account: { display_name: "Fixture", email: "fixture@example.test" }, organization: { organization_type: "pro" } }));
    } else if (request.method === "GET" && request.url.startsWith("/api/oauth/usage")) {
      response.end(JSON.stringify({ five_hour: { utilization: 37 }, seven_day: { utilization: 62 } }));
    } else {
      response.statusCode = 404;
      response.end("{}");
    }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  registerTeardownCallback(() => new Promise(resolve => server.close(resolve)));
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, requests };
}

function writeCredentials(workspace) {
  const dir = path.join(workspace.homeDir, ".claude");
  require("../../scripts/platform/privacy.js").ensurePrivateDirSync(dir);
  fs.writeFileSync(path.join(dir, ".credentials.json"), JSON.stringify({
    claudeAiOauth: { accessToken: "fixture-oauth-token", expiresAt: Date.now() + 3_600_000 },
  }));
}

// Stands in for the trigger firing: starts the program the XML names, without its
// conhost, and waits for it. `CCDM_*` from the installer's environment is absent
// here, as it is in a real task.
function runAsScheduledTask(workspace) {
  const xml = definition(workspace);
  const args = [...(/<Arguments>([^<]*)<\/Arguments>/.exec(xml)[1]).matchAll(/&quot;([^&]*)&quot;|"([^"]*)"|(\S+)/g)].map(m => m[1] ?? m[2] ?? m[3]);
  assert.equal(args[0], "--headless");
  const cwd = /<WorkingDirectory>([^<]*)<\/WorkingDirectory>/.exec(xml)[1];
  const env = { ...workspace.env, CCDM_SERVICE_HOST_TEST_PASS: "CCDM_TEST_STATE" };
  delete env.CCDM_STATE_ROOT;
  const child = spawn(args[1], args.slice(2), { cwd, env, stdio: "ignore", windowsHide: true });
  registerTeardownCallback(() => child.kill());
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
}

function assertBoundaryIsOneIntervalAfter(xml, before, after, seconds) {
  const boundary = new Date(/<StartBoundary>([^<]+)<\/StartBoundary>/.exec(xml)[1]).getTime();
  const earliest = Math.floor(before / 1000) * 1000 + seconds * 1000;
  assert.ok(boundary >= earliest && boundary <= after + seconds * 1000, `boundary ${boundary} is not ${seconds}s after install`);
}

test("install-service creates a task repeating every 10 minutes, first run one interval later, and does not start it", onlyWindows, async () => {
  const workspace = createPosterWorkspace();

  const before = Date.now();
  const installed = await ccdm(workspace, ["install-service", "usage-poster"]);
  const after = Date.now();

  assert.equal(installed.exitCode, 0, installed.stderr || installed.stdout);
  const xml = definition(workspace);
  assert.match(xml, /<TimeTrigger>\s*<Repetition>\s*<Interval>PT10M<\/Interval>\s*<StopAtDurationEnd>false<\/StopAtDurationEnd>\s*<\/Repetition>/);
  assert.match(xml, /<StartWhenAvailable>true<\/StartWhenAvailable>/);
  assert.doesNotMatch(xml, /<LogonTrigger>/);
  assert.doesNotMatch(xml, /__[A-Z_]+__/);
  assert.match(xml, /<LogonType>InteractiveToken<\/LogonType>/);
  assert.match(xml, /<Command>[^<]*conhost\.exe<\/Command>/);
  assert.match(xml, /<Arguments>--headless (&quot;|")[^<]*node[^<]*service-host\.js(&quot;|") --config (&quot;|")[^<]*usage-poster\.json(&quot;|") --once<\/Arguments>/);
  assertBoundaryIsOneIntervalAfter(xml, before, after, 600);
  assert.equal(verbs(workspace).includes("/run"), false, "the first run is one interval away");
  assert.ok(fs.existsSync(serviceFile(defaultStateRoot(workspace), ".log")));
  assert.ok(fs.existsSync(serviceFile(defaultStateRoot(workspace), ".err")));
});

test("the task always runs the poster with --collect-only, with the resolved tools in its environment", onlyWindows, async () => {
  const workspace = createPosterWorkspace();
  const codex = path.join(workspace.fixtureDir, "codex.exe");

  const installed = await ccdm(workspace, ["install-service", "usage-poster"]);

  assert.equal(installed.exitCode, 0, installed.stderr || installed.stdout);
  const stateRoot = defaultStateRoot(workspace);
  const config = readConfig(stateRoot);
  // Python reports the long form of a path; a CI temp folder can be an 8.3 short name.
  assert.deepEqual(config.command, [PYTHON, path.join(fs.realpathSync.native(workspace.repoDir), "scripts", "usage-stats-poster.py"), "--collect-only"]);
  assert.deepEqual(Object.keys(config.env).sort(), ["CCDM_CODEX_PATH", "CCDM_STATE_ROOT", "PATH", "PYTHONUTF8"]);
  assert.equal(config.env.CCDM_CODEX_PATH, codex);
  assert.equal(config.env.CCDM_STATE_ROOT, stateRoot);
  assert.equal(config.env.PYTHONUTF8, "1");
  assert.ok(config.env.PATH.split(";").includes(path.dirname(process.execPath)), "node's folder is on the task's PATH");
});

test("--interval below 60, not a whole number, or too long exits 2 before any schtasks call", onlyWindows, async () => {
  const workspace = createPosterWorkspace();
  for (const value of ["59", "abc", "60.5", "-600", "", String(MAXIMUM_INTERVAL + 1)]) {
    const result = await ccdm(workspace, ["install-service", "usage-poster", "--interval", value]);
    assert.equal(result.exitCode, 2, value);
    assert.match(result.stderr, /--interval must be a whole number of seconds from 60 to 2678400/, value);
    assert.deepEqual(invocations(workspace), [], value);
  }
});

test("no option makes the task post, and an option other than --interval exits 2 before any schtasks call", onlyWindows, async () => {
  const workspace = createPosterWorkspace();
  for (const options of [["--post-now"], ["--scheduled"], ["--interval"], ["--interval", "600", "--scheduled"]]) {
    const result = await ccdm(workspace, ["install-service", "usage-poster", ...options]);
    assert.equal(result.exitCode, 2, options.join(" "));
    assert.match(result.stderr, /takes only --interval/, options.join(" "));
    assert.deepEqual(invocations(workspace), [], options.join(" "));
  }
});

test("--interval renders as a Task Scheduler duration and moves the first run with it", onlyWindows, async () => {
  for (const [seconds, duration] of [[900, "PT15M"], [90, "PT1M30S"], [5400, "PT1H30M"], [86400, "P1D"], [90000, "P1DT1H"]]) {
    const workspace = createPosterWorkspace();
    const before = Date.now();
    const installed = await ccdm(workspace, ["install-service", "usage-poster", "--interval", String(seconds)]);
    const after = Date.now();
    assert.equal(installed.exitCode, 0, installed.stderr || installed.stdout);
    assert.match(definition(workspace), new RegExp(`<Interval>${duration}</Interval>`), String(seconds));
    assertBoundaryIsOneIntervalAfter(definition(workspace), before, after, seconds);
  }
});

test("a missing or invalid poster config stops the installer before any schtasks call", onlyWindows, async () => {
  const cases = [
    ["missing", null, /poster config not found/],
    ["not JSON", "{broken", /unable to read valid JSON/],
    ["wrong value", JSON.stringify({ history_db_path: "relative/history.sqlite3" }), /history_db_path must be an absolute path/],
  ];
  for (const [name, content, reason] of cases) {
    const workspace = createPosterWorkspace();
    if (content === null) fs.rmSync(posterConfigFile(workspace));
    else fs.writeFileSync(posterConfigFile(workspace), content);

    const result = await ccdm(workspace, ["install-service", "usage-poster"]);

    assert.equal(result.exitCode, 2, name);
    assert.match(result.stderr, /poster config check failed/, name);
    assert.match(result.stderr, reason, name);
    assert.deepEqual(invocations(workspace), [], name);
    assert.equal(fs.existsSync(serviceFile(defaultStateRoot(workspace), ".json")), false, name);
  }
});

test("a scheduled run records history under the state root, logs to the service log and sends nothing to Discord", onlyWindows, async () => {
  const services = await startFakeServices();
  const workspace = createPosterWorkspace({ anthropic_base_url: services.baseUrl, discord_base_url: services.baseUrl });
  writeCredentials(workspace);
  const stateRoot = path.join(workspace.tmpDir, "custom-state");

  const installed = await ccdm(workspace, ["install-service", "usage-poster"], { CCDM_STATE_ROOT: stateRoot });
  assert.equal(installed.exitCode, 0, installed.stderr || installed.stdout);
  await runAsScheduledTask(workspace);

  assert.ok(fs.existsSync(path.join(stateRoot, "usage-stats", "history.sqlite3")), "history is under the installer's state root");
  assert.equal(fs.existsSync(path.join(defaultStateRoot(workspace), "usage-stats")), false);
  assert.match(fs.readFileSync(serviceFile(stateRoot, ".log"), "utf8"), /Collected usage snapshot/);
  assert.equal(fs.readFileSync(serviceFile(stateRoot, ".err"), "utf8"), "");
  assert.ok(services.requests.some(request => request.path.startsWith("/api/oauth/usage")), "the run collected usage");
  assert.deepEqual(services.requests.filter(request => request.method !== "GET" || request.path.startsWith("/api/v10")), []);
  assert.equal(fs.existsSync(serviceFile(stateRoot, ".state.json")), false, "a --once run keeps no state");
});

test("a run that fails writes its error to the .err log and still sends nothing to Discord", onlyWindows, async () => {
  const services = await startFakeServices();
  const workspace = createPosterWorkspace({ anthropic_base_url: services.baseUrl, discord_base_url: services.baseUrl });
  const installed = await ccdm(workspace, ["install-service", "usage-poster"]);
  assert.equal(installed.exitCode, 0, installed.stderr || installed.stdout);

  fs.writeFileSync(posterConfigFile(workspace), "{broken");
  await runAsScheduledTask(workspace);

  assert.match(fs.readFileSync(serviceFile(defaultStateRoot(workspace), ".err"), "utf8"), /unable to read valid JSON/);
  assert.deepEqual(services.requests, []);
});

test("Codex installed through npm with no native program is rendered as codex.js, and the task can run it", onlyWindows, async () => {
  const workspace = createPosterWorkspace();
  const npmDir = path.join(workspace.tmpDir, "npm");
  const packageDir = path.join(npmDir, "node_modules", "@openai", "codex");
  fs.mkdirSync(path.join(packageDir, "bin"), { recursive: true });
  fs.writeFileSync(path.join(npmDir, "codex.cmd"), "");
  fs.writeFileSync(path.join(packageDir, "package.json"), "{}");
  fs.writeFileSync(path.join(packageDir, "bin", "codex.js"), "");
  const codexJs = path.join(packageDir, "bin", "codex.js");

  const installed = await ccdm(workspace, ["install-service", "usage-poster"], {
    CCDM_CODEX_PATH: undefined,
    PATH: `${npmDir};${workspace.fixtureDir}`,
  });

  assert.equal(installed.exitCode, 0, installed.stderr || installed.stdout);
  const config = readConfig(defaultStateRoot(workspace));
  assert.equal(config.env.CCDM_CODEX_PATH, codexJs);
  const probe = spawnSync(PYTHON, ["-c", "import json; from ccdmlib.platform import exe; print(json.dumps(exe.codex()))"], {
    cwd: workspace.repoDir,
    encoding: "utf8",
    env: { ...workspace.env, ...config.env, PYTHONPATH: path.join(workspace.repoDir, "scripts") },
  });
  assert.equal(probe.status, 0, probe.stderr);
  assert.deepEqual(JSON.parse(probe.stdout), { command: process.execPath, args: [codexJs], env: {} });
});

test("Codex that cannot be found stops the installer before any schtasks call", onlyWindows, async () => {
  const workspace = createPosterWorkspace();

  const result = await ccdm(workspace, ["install-service", "usage-poster"], { CCDM_CODEX_PATH: undefined });

  assert.equal(result.exitCode, 1, result.stderr || result.stdout);
  assert.match(result.stderr, /Codex was not found/);
  assert.deepEqual(invocations(workspace), []);
});

test("uninstall-service removes the task and service-status follows it", onlyWindows, async () => {
  const workspace = createPosterWorkspace();
  const installed = await ccdm(workspace, ["install-service", "usage-poster"]);
  assert.equal(installed.exitCode, 0, installed.stderr || installed.stdout);
  assert.match((await ccdm(workspace, ["service-status", "usage-poster"])).stdout, /^usage-poster: installed \(task \\CCDM\\UsagePoster\)/m);

  const removed = await ccdm(workspace, ["uninstall-service", "usage-poster"]);

  assert.equal(removed.exitCode, 0, removed.stderr || removed.stdout);
  assert.equal(readState(workspace.stateDir).fixtures.schtasks.tasks.includes(TASK), false);
  assert.equal(verbs(workspace).includes("/end"), false, "schtasks /end is not a stop");
  assert.equal(fs.existsSync(serviceFile(defaultStateRoot(workspace), ".json")), false);
  assert.match((await ccdm(workspace, ["service-status", "usage-poster"])).stdout, /^usage-poster: not installed/m);
});

test("the macOS installer gains no config check and its plist still posts", () => {
  const installer = fs.readFileSync(path.join(REPO, "scripts", "install-usage-stats-poster.sh"), "utf8");
  const plist = fs.readFileSync(path.join(REPO, "scripts", "com.discord.usage-stats-poster.plist.in"), "utf8");
  assert.doesNotMatch(installer, /--validate-config/);
  assert.doesNotMatch(plist, /--collect-only/);
});
