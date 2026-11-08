import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { platformGate, PYTHON } from "./support/platform.js";
import {
  connectSession,
  createRouterWorkspace,
  routerEnv,
  routerRegistry,
  routerWithWebhooks,
  runRouterCli,
  waitFor,
} from "./support/router.js";
import { runScript } from "./support/runner.js";
import { updateState } from "./support/state.js";
import { cleanup } from "./support/teardown.js";

// Longer than the Router's reload debounce below, so a reload lands mid-transaction.
const DEBOUNCE_MS = 20;
const HOLD_MS = 400;
const execFileAsync = promisify(execFile);

test.afterEach(async () => {
  await cleanup();
});

const registryFile = workspace => path.join(workspace.repoDir, "registry.json");

// `demo` has its webhook and a connected session; `other` is running (a
// recorded PID and session). Every process in the Test Workspace shares one
// armable mid-transaction pause.
async function overlapWorkspace() {
  const workspace = createRouterWorkspace(routerRegistry({
    other: { channel_id: "other-channel", type: "claude", screen_name: "other_session",
      pid: 999999, session_id: "running-session" },
  }));
  fs.chmodSync(registryFile(workspace), 0o600);
  const hold = path.join(workspace.tmpDir, "registry-hold");
  const env = { CCDM_TEST_REGISTRY_HOLD: hold, CCDM_ROUTER_REGISTRY_DEBOUNCE_MS: String(DEBOUNCE_MS) };
  const router = await routerWithWebhooks(workspace, ["demo"], { env });
  const demo = await connectSession(workspace, "demo", "demo-key");
  // Someone deletes the webhook in Discord: the next reply recreates it.
  updateState(workspace.stateDir, (state) => {
    state.fixtures.discord.webhooks = state.fixtures.discord.webhooks.filter(webhook => webhook.id !== "fake-webhook-1");
  });
  return { workspace, router, demo, hold, env };
}

const exists = file => fs.existsSync(file);

// Every read while a writer is paused holding the lock parses, and the Router's
// reloads during the pause never fail.
async function sampleWhileHeld(workspace, router) {
  const until = Date.now() + HOLD_MS;
  let reads = 0;
  while (Date.now() < until) {
    JSON.parse(fs.readFileSync(registryFile(workspace), "utf8"));
    reads++;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.ok(reads > 10);
  assert.doesNotMatch(router.stdout, /registry_reload_failed/);
}

async function assertBothChangesSurvive(workspace, router, reply, stop) {
  const [replied, stopped] = await Promise.all([reply, stop]);
  assert.deepEqual(replied.message_ids, [replied.message_id]);
  assert.equal(stopped.exitCode, 0, stopped.stderr || stopped.stdout);
  const { demo, other } = JSON.parse(fs.readFileSync(registryFile(workspace), "utf8")).projects;
  assert.equal(demo.webhook_id, "fake-webhook-2");
  assert.deepEqual({ pid: other.pid, session_id: other.session_id }, { pid: null, session_id: null });
  // The reminder service's assignment-changed write survives too.
  assert.match(demo.assignment_generation, /^gen-[0-9a-f]{32}$/);
  assert.equal(fs.statSync(registryFile(workspace)).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(workspace.repoDir).filter(name => /registry\.json\.(lock|.*\.tmp)/.test(name)), []);
  const status = await runRouterCli(workspace, ["status", "--json"]);
  assert.equal(status.exitCode, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).registry_error ?? null, null);
  assert.doesNotMatch(router.stdout, /registry_reload_failed/);
}

// Awaited later; a failure before then must not crash the test process.
function sendReply(demo) {
  const reply = demo.client.request("reply", { channel_id: "demo-channel", text: "still here" });
  reply.catch(() => {});
  return reply;
}

function stopOther(workspace, env) {
  return runScript(workspace, "scripts/stop-session.sh", { args: ["other"], env: routerEnv(workspace, env), timeoutMs: 30000 });
}

test("webhook recreation paused holding the registry lock keeps a concurrent stop's PID clear for another project", async () => {
  const { workspace, router, demo, hold, env } = await overlapWorkspace();
  fs.writeFileSync(`${hold}.armed`, "");

  const reply = sendReply(demo);
  await waitFor(() => exists(`${hold}.waiting`), () => `the Router's webhook write to pause:\n${router.stdout}`);
  const stop = stopOther(workspace, env);
  await waitFor(() => exists(`${hold}.blocked`), () => "stop-session to wait for the registry lock", 20000);
  await sampleWhileHeld(workspace, router);
  fs.writeFileSync(`${hold}.release`, "");

  await assertBothChangesSurvive(workspace, router, reply, stop);
});

test("a stop paused holding the registry lock keeps a concurrent webhook recreation for another project", async () => {
  const { workspace, router, demo, hold, env } = await overlapWorkspace();
  fs.writeFileSync(`${hold}.armed`, "");

  const stop = stopOther(workspace, env);
  await waitFor(() => exists(`${hold}.waiting`), () => "stop-session's PID write to pause", 20000);
  const reply = sendReply(demo);
  await waitFor(() => exists(`${hold}.blocked`), () => `the Router to wait for the registry lock:\n${router.stdout}`);
  await sampleWhileHeld(workspace, router);
  fs.writeFileSync(`${hold}.release`, "");

  await assertBothChangesSurvive(workspace, router, reply, stop);
});

test("a registry lock left by a dead writer is reclaimed, and a live holder's lock is waited for, then refused by name", async () => {
  const workspace = createRouterWorkspace(routerRegistry({
    other: { channel_id: "other-channel", type: "claude", screen_name: "other_session", pid: 999999, session_id: "s" },
  }));
  const lock = `${registryFile(workspace)}.lock`;
  // A writer killed while holding the lock (no live pid owns it).
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, "owner"), "999999\n");

  const reclaimed = await stopOther(workspace, {});

  assert.equal(reclaimed.exitCode, 0, reclaimed.stderr || reclaimed.stdout);
  assert.equal(JSON.parse(fs.readFileSync(registryFile(workspace), "utf8")).projects.other.pid, null);
  assert.equal(fs.existsSync(lock), false);

  // A live holder: this test process.
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, "owner"), `${process.pid}\n`);
  const refused = await stopOther(workspace, { CCDM_REGISTRY_LOCK_TIMEOUT_MS: "200" });

  assert.notEqual(refused.exitCode, 0);
  assert.match(refused.stderr, new RegExp(`registry\\.json is locked \\(held by pid ${process.pid}\\)`));
  assert.equal(fs.readFileSync(path.join(lock, "owner"), "utf8"), `${process.pid}\n`);
});

// The lock implementation, driven in this process: the workspace copy, except on
// Windows, where only the repository's own node_modules has koffi.
const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
function registryPath(workspace) {
  return path.join(process.platform === "win32" ? REPO_ROOT : workspace.repoDir, "scripts/router/registry.js");
}

function registryModule(workspace) {
  return createRequire(import.meta.url)(registryPath(workspace));
}

// Runs a Python snippet with the workspace's registry-update.py loaded as `ru`.
function runPython(workspace, code, args = [], options = {}) {
  const prelude = "import importlib.util,sys\n"
    + "spec=importlib.util.spec_from_file_location('ru',sys.argv[1]);ru=importlib.util.module_from_spec(spec);spec.loader.exec_module(ru)\n";
  return execFileAsync(PYTHON, ["-c", prelude + code, path.join(workspace.repoDir, "scripts/registry-update.py"), ...args],
    { encoding: "utf8", ...options });
}

function deadLock(lock) {
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, "owner"), "999999\n");
}

const lockLitter = workspace => fs.readdirSync(workspace.repoDir).filter(name => /registry\.json\.(lock|.*\.tmp)/.test(name));

test("a waiter that saw a dead owner too late leaves the live lock taken since in place, in both implementations", async () => {
  const workspace = createRouterWorkspace(routerRegistry({
    other: { channel_id: "other-channel", type: "claude", screen_name: "other_session" },
  }));
  const file = registryFile(workspace);
  const lock = `${file}.lock`;
  const hold = path.join(workspace.tmpDir, "registry-hold");
  const { _lockInternals: { deadKey, reclaim }, updateRegistry } = registryModule(workspace);
  deadLock(lock);
  // Two late waiters, one per implementation, both observe the dead owner.
  const jsKey = await deadKey(lock);
  const pyKey = (await runPython(workspace, "print(ru._dead_key(ru.Path(sys.argv[2])))", [lock])).stdout.trim();
  assert.equal(pyKey, jsKey);

  // A Python writer reclaims the dead lock and pauses holding it.
  fs.writeFileSync(`${hold}.armed`, "");
  const first = execFileAsync(PYTHON, [path.join(workspace.repoDir, "scripts/registry-update.py"),
    "set-project-fields", file, "other", '{"first": true}'], { env: { ...process.env, CCDM_TEST_REGISTRY_HOLD: hold } });
  first.catch(() => {});
  await waitFor(() => exists(`${hold}.waiting`), () => "the first writer to pause holding the lock");
  const held = fs.readFileSync(path.join(lock, "nonce"), "utf8");

  // The late waiters act on what they saw: each holds the claim, and neither
  // moves or deletes the live lock.
  assert.equal(await reclaim(lock, jsKey), true);
  assert.equal((await runPython(workspace, "print(ru._reclaim(ru.Path(sys.argv[2]), sys.argv[3]))", [lock, pyKey])).stdout.trim(), "True");
  assert.equal(fs.readFileSync(path.join(lock, "nonce"), "utf8"), held);

  // A third writer still waits for the first.
  const previous = process.env.CCDM_TEST_REGISTRY_HOLD;
  process.env.CCDM_TEST_REGISTRY_HOLD = hold;
  let third;
  try {
    third = updateRegistry(file, registry => { registry.projects.other.third = true; });
    await waitFor(() => exists(`${hold}.blocked`), () => "the third writer to wait for the lock");
  } finally {
    if (previous === undefined) delete process.env.CCDM_TEST_REGISTRY_HOLD;
    else process.env.CCDM_TEST_REGISTRY_HOLD = previous;
  }
  fs.writeFileSync(`${hold}.release`, "");
  await Promise.all([first, third]);

  const { other } = JSON.parse(fs.readFileSync(file, "utf8")).projects;
  assert.deepEqual({ first: other.first, third: other.third }, { first: true, third: true });
  assert.deepEqual(lockLitter(workspace), []);
});

test("concurrent Node and Python writers racing to reclaim one dead lock all commit", async () => {
  const workspace = createRouterWorkspace(routerRegistry({
    other: { channel_id: "other-channel", type: "claude", screen_name: "other_session" },
  }));
  const file = registryFile(workspace);
  const { updateRegistry } = registryModule(workspace);
  for (let round = 0; round < 3; round++) {
    deadLock(`${file}.lock`);
    const writers = [];
    for (let index = 0; index < 5; index++) {
      writers.push(runPython(workspace, "ru.set_project_fields(sys.argv[2], 'other', {sys.argv[3]: True})",
        [file, `py_${round}_${index}`]));
      writers.push(updateRegistry(file, registry => { registry.projects.other[`js_${round}_${index}`] = true; }));
    }
    await Promise.all(writers);
  }

  const { other } = JSON.parse(fs.readFileSync(file, "utf8")).projects;
  const written = Object.keys(other).filter(key => /^(py|js)_\d_\d$/.test(key));
  assert.equal(written.length, 30, `lost writes: ${written.sort().join(", ")}`);
  assert.deepEqual(lockLitter(workspace), []);
});

test("registry-update.py loaded by path from a working directory outside scripts/ takes and releases the lock", async () => {
  const workspace = createRouterWorkspace(routerRegistry({
    other: { channel_id: "other-channel", type: "claude", screen_name: "other_session" },
  }));
  const file = registryFile(workspace);

  await runPython(workspace, "ru.set_project_fields(sys.argv[2], 'other', {'from_outside': True})", [file], { cwd: workspace.tmpDir });

  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).projects.other.from_outside, true);
  assert.deepEqual(lockLitter(workspace), []);
});

const ON_WINDOWS = platformGate("win32", "exercises Windows file sharing and PID reuse");
const otherProject = () => routerRegistry({ other: { channel_id: "other-channel", type: "claude", screen_name: "other_session" } });
const RELEASE_WARNING = /could not be removed/;

// A process that takes the lock, touches `<marker>.held`, and releases once
// `<marker>.go` exists; resolves with its output.
function holderProcess(language, workspace, file, marker) {
  if (language === "python") {
    return runPython(workspace, [
      "import os,time",
      "handle=ru.acquire(sys.argv[2])",
      "open(sys.argv[3]+'.held','w').close()",
      "while not os.path.exists(sys.argv[3]+'.go'): time.sleep(0.01)",
      "ru.release(handle)",
    ].join("\n"), [file, marker]);
  }
  const script = `
    const fs = require("node:fs");
    const [registry, file, marker] = process.argv.slice(1);
    require(registry).withRegistryLock(file, async () => {
      fs.writeFileSync(marker + ".held", "");
      while (!fs.existsSync(marker + ".go")) await new Promise(resolve => setTimeout(resolve, 10));
    });
  `;
  return execFileAsync(process.execPath, ["-e", script, registryPath(workspace), file, marker], { encoding: "utf8" });
}

// A Python reader that holds each of `files` open for holdMs, then closes them.
// Python's open does not share delete access, the harder case for a rename.
function heldOpen(files, holdMs, readyMarker) {
  const script = [
    "import sys,time",
    "marker,hold=sys.argv[1],float(sys.argv[2])/1000",
    "handles=[open(name) for name in sys.argv[3:]]",
    "open(marker,'w').close()",
    "time.sleep(hold)",
    "[handle.close() for handle in handles]",
  ].join("\n");
  return execFileAsync(PYTHON, ["-c", script, readyMarker, String(holdMs), ...files], { encoding: "utf8" });
}

// Readers that keep opening registry.json and the current lock's owner until
// `stop` exists: one Python, one Node (which shares delete access).
const PYTHON_LOOP_READER = holdMs => [
  "import os,sys,time",
  "file,stop=sys.argv[1],sys.argv[2]",
  "while not os.path.exists(stop):",
  "    handles=[]",
  "    for name in (file, file+'.lock/owner'):",
  "        try: handles.append(open(name))",
  "        except OSError: pass",
  `    time.sleep(${holdMs / 1000})`,
  "    [handle.close() for handle in handles]",
  "    time.sleep(0.01)",
].join("\n");

const NODE_LOOP_READER = holdMs => `
  const fs = require("node:fs");
  const [file, stop] = process.argv.slice(1);
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  (async () => {
    while (!fs.existsSync(stop)) {
      const fds = [];
      for (const name of [file, file + ".lock/owner"]) {
        try { fds.push(fs.openSync(name, "r")); } catch {}
      }
      await sleep(${holdMs});
      fds.forEach(fd => fs.closeSync(fd));
      await sleep(10);
    }
  })();
`;

function startLoopReaders(file, stop) {
  return [
    execFileAsync(PYTHON, ["-c", PYTHON_LOOP_READER(5), file, stop], { encoding: "utf8" }),
    execFileAsync(process.execPath, ["-e", NODE_LOOP_READER(5), file, stop], { encoding: "utf8" }),
  ];
}

test("on Windows, a contended Node write waits for the holder and then succeeds instead of throwing EPERM", ON_WINDOWS, async () => {
  const workspace = createRouterWorkspace(otherProject());
  const file = registryFile(workspace);
  const marker = path.join(workspace.tmpDir, "holder");
  const { updateRegistry } = registryModule(workspace);
  const holder = holderProcess("python", workspace, file, marker);
  await waitFor(() => exists(`${marker}.held`), () => "the Python holder to take the lock");

  const write = updateRegistry(file, registry => { registry.projects.other.contended = true; });
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).projects.other.contended, undefined, "wrote while the lock was held");
  fs.writeFileSync(`${marker}.go`, "");
  await Promise.all([holder, write]);

  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).projects.other.contended, true);
  assert.deepEqual(lockLitter(workspace), []);
});

test("on Windows, Node and Python writers racing past readers holding registry.json and owner open all land", ON_WINDOWS, async () => {
  const workspace = createRouterWorkspace(otherProject());
  const file = registryFile(workspace);
  const stop = path.join(workspace.tmpDir, "stop-readers");
  const readers = startLoopReaders(file, stop);
  const { readRegistry, updateRegistry } = registryModule(workspace);
  const writers = [];
  const started = performance.now();
  // The Router's reload path keeps reading a whole file throughout.
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      await readRegistry(file);
      await new Promise(resolve => setTimeout(resolve, 3));
    }
  })();
  try {
    for (let index = 0; index < 6; index++) {
      writers.push(runPython(workspace, "ru.set_project_fields(sys.argv[2], 'other', {sys.argv[3]: True})", [file, `py_${index}`]));
      writers.push(updateRegistry(file, registry => { registry.projects.other[`js_${index}`] = true; }));
    }
    const results = await Promise.all(writers);
    for (const result of results) assert.doesNotMatch(result?.stderr ?? "", RELEASE_WARNING);
  } finally {
    sampling = false;
    fs.writeFileSync(stop, "");
    await Promise.all(readers);
  }
  await sampler;

  assert.ok(performance.now() - started < 20000, "a writer waited as if for the 30 s lock timeout");
  const { other } = JSON.parse(fs.readFileSync(file, "utf8")).projects;
  assert.equal(Object.keys(other).filter(key => /^(py|js)_\d$/.test(key)).length, 12);
  assert.deepEqual(lockLitter(workspace), []);
});

for (const language of ["node", "python"]) {
  test(`on Windows, a ${language} release waits out a reader holding owner open and removes the lock`, ON_WINDOWS, async () => {
    const workspace = createRouterWorkspace(otherProject());
    const file = registryFile(workspace);
    const lock = `${file}.lock`;
    const marker = path.join(workspace.tmpDir, "holder");
    const holder = holderProcess(language, workspace, file, marker);
    await waitFor(() => exists(`${marker}.held`), () => "the holder to take the lock");
    const reader = heldOpen([path.join(lock, "owner"), path.join(lock, "nonce")], 600, `${marker}.reading`);
    await waitFor(() => exists(`${marker}.reading`), () => "the reader to open owner");

    fs.writeFileSync(`${marker}.go`, "");
    const [{ stderr }] = await Promise.all([holder, reader]);

    assert.doesNotMatch(stderr, RELEASE_WARNING);
    assert.equal(exists(lock), false);
    assert.deepEqual(lockLitter(workspace), []);
  });

  test(`on Windows, a ${language} release blocked past its budget warns naming the lock and still finishes`, ON_WINDOWS, async () => {
    const workspace = createRouterWorkspace(otherProject());
    const file = registryFile(workspace);
    const lock = `${file}.lock`;
    const marker = path.join(workspace.tmpDir, "holder");
    const holder = holderProcess(language, workspace, file, marker);
    await waitFor(() => exists(`${marker}.held`), () => "the holder to take the lock");
    const reader = heldOpen([path.join(lock, "owner")], 3500, `${marker}.reading`);
    await waitFor(() => exists(`${marker}.reading`), () => "the reader to open owner");

    fs.writeFileSync(`${marker}.go`, "");
    const [{ stderr }] = await Promise.all([holder, reader]);

    assert.match(stderr, /registry\.json\.lock could not be removed/);
    assert.equal(exists(lock), true, "the blocked lock stays in place");
  });
}

test("on Windows, a live PID with the wrong start time is reclaimed by both, and one without started is honored", ON_WINDOWS, async () => {
  const workspace = createRouterWorkspace(otherProject());
  const file = registryFile(workspace);
  const lock = `${file}.lock`;
  const { updateRegistry } = registryModule(workspace);
  const plantLock = files => {
    fs.mkdirSync(lock);
    for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(lock, name), text);
  };

  plantLock({ owner: `${process.pid}\n`, nonce: "reused-node\n", started: "1\n" });
  await updateRegistry(file, registry => { registry.projects.other.node_reclaimed = true; });
  assert.equal(exists(lock), false);

  plantLock({ owner: `${process.pid}\n`, nonce: "reused-python\n", started: "1\n" });
  await runPython(workspace, "ru.set_project_fields(sys.argv[2], 'other', {'python_reclaimed': True})", [file]);
  assert.equal(exists(lock), false);

  const { other } = JSON.parse(fs.readFileSync(file, "utf8")).projects;
  assert.deepEqual({ node: other.node_reclaimed, python: other.python_reclaimed }, { node: true, python: true });

  plantLock({ owner: `${process.pid}\n` });
  const env = { ...process.env, CCDM_REGISTRY_LOCK_TIMEOUT_MS: "200" };
  await assert.rejects(
    runPython(workspace, "ru.set_project_fields(sys.argv[2], 'other', {'x': True})", [file], { env }),
    /is locked \(held by pid/,
  );
  assert.equal(fs.readFileSync(path.join(lock, "owner"), "utf8"), `${process.pid}\n`);
});
