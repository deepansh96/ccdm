// Runs scripts/platform (Node) and ccdmlib.platform (Python) side by side and
// fails when they disagree. Slices add a tests/e2e/platform-contract/<name>.cases.js
// file and never edit this runner or the drivers.
//
// A cases file default-exports an array of:
//   name              what the case shows
//   only              "win32" or "posix"; the case is skipped elsewhere
//   skipIf            () => reason string or false, for other conditions
//   setup             async ctx => state, run first; its result reaches the fields below
//   env               object or (ctx, state) => object, added to each driver's environment
//   node, python      "<module>.<function>" to call; either may be left out
//   args              array or (ctx, state) => array, for both calls
//   nodeArgs, pythonArgs   the same, for a call whose arguments differ
//   value             expected value of each call, or (ctx, state) => value
//   throws            true (any error) or an array of accepted error codes
//   agree             false when the two return values are expected to differ
//   check             async ({ node, python }, ctx, state) => {}, for anything else
//
// Each call's outcome is { ok, value, error: { code, name, message }, ms }, where
// ms is how long the function itself took. ctx offers dir, work, home, call(),
// node(), py(), start(), nodeScript(), pythonScript() and defer().
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { PYTHON } from "./support/platform.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const CASES_DIR = path.join(HERE, "platform-contract");
const WIN = process.platform === "win32";
const FAMILY = WIN ? "win32" : "posix";
const CALL_TIMEOUT_MS = 30000;
const DRIVERS = {
  node: [process.execPath, path.join(HERE, "support", "platform-driver.cjs")],
  python: [PYTHON, path.join(HERE, "support", "platform_driver.py")],
};

function runProcess(command, args, { cwd, env, input = "" }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`timed out after ${CALL_TIMEOUT_MS} ms: ${command} ${args.join(" ")}\n${stderr}`));
    }, CALL_TIMEOUT_MS);
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", error => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", code => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(input);
  });
}

// Every child is confined: its home is a temp directory and no CCDM setting of
// the machine running the tests reaches it.
function createContext() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccdm-platform-"));
  const work = path.join(dir, "work");
  const home = path.join(dir, "home");
  fs.mkdirSync(work);
  fs.mkdirSync(home);
  const baseEnv = Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => !/^(CCDM_|NODE_TEST_CONTEXT$|HOMEDRIVE$|HOMEPATH$|PYTHONPATH$)/i.test(key)));
  Object.assign(baseEnv, { HOME: home, USERPROFILE: home, PYTHONDONTWRITEBYTECODE: "1" });
  const environment = extra => ({ ...baseEnv, ...extra });
  const scriptEnv = extra => environment({ PYTHONPATH: path.join(ROOT, "scripts"), ...extra });
  const children = [];
  const deferred = [];

  const ctx = {
    dir,
    work,
    home,
    root: ROOT,
    python: PYTHON,

    async call(language, fn, args = [], env = {}) {
      const [command, ...commandArgs] = DRIVERS[language];
      const result = await runProcess(command, commandArgs, {
        cwd: work, env: environment(env), input: JSON.stringify({ fn, args }),
      });
      assert.equal(result.code, 0, `${language} driver failed for ${fn}: ${result.stderr}`);
      return JSON.parse(result.stdout);
    },

    async node(fn, ...args) {
      const outcome = await ctx.call("node", fn, args);
      assert.ok(outcome.ok, `${fn}: ${outcome.error?.message}`);
      return outcome.value;
    },

    async py(fn, ...args) {
      const outcome = await ctx.call("python", fn, args);
      assert.ok(outcome.ok, `${fn}: ${outcome.error?.message}`);
      return outcome.value;
    },

    nodeScript: (source, args = [], { env = {} } = {}) =>
      runProcess(process.execPath, ["-e", source, ...args], { cwd: work, env: environment(env) }),

    pythonScript: (source, args = [], { env = {} } = {}) =>
      runProcess(PYTHON, ["-c", source, ...args], { cwd: work, env: scriptEnv(env) }),

    // A long-running child; teardown stops it if the case has not.
    start(command, args, { env = {} } = {}) {
      const child = spawn(command, args, {
        cwd: work, env: scriptEnv(env), stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
      });
      child.stderr.resume();
      let buffer = "";
      const waiters = [];
      const lines = [];
      const deliver = () => {
        while (lines.length && waiters.length) waiters.shift().resolve(lines.shift());
      };
      child.stdout.on("data", chunk => {
        buffer += chunk;
        const parts = buffer.split(/\r?\n/);
        buffer = parts.pop();
        lines.push(...parts);
        deliver();
      });
      const exited = new Promise(resolve => {
        child.on("error", resolve);
        child.on("exit", resolve);
      });
      exited.then(() => {
        for (const waiter of waiters.splice(0)) waiter.reject(new Error(`${command} exited before printing a line`));
      });
      const handle = {
        pid: child.pid,
        stdin: child.stdin,
        exited,
        line: () => new Promise((resolve, reject) => {
          waiters.push({ resolve, reject });
          deliver();
        }),
        async stop() {
          if (child.exitCode === null && child.signalCode === null) child.kill();
          await exited;
        },
      };
      children.push(handle);
      return handle;
    },

    defer(action) {
      deferred.push(action);
    },

    async cleanup() {
      await Promise.all(children.map(child => child.stop()));
      for (const action of deferred.reverse()) await action();
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    },
  };
  return ctx;
}

function assertOutcome(language, outcome, definition, expected) {
  if (definition.throws) {
    assert.equal(outcome.ok, false, `${language} should have thrown, got ${JSON.stringify(outcome.value)}`);
    if (Array.isArray(definition.throws)) {
      assert.ok(definition.throws.includes(outcome.error.code),
        `${language} threw ${outcome.error.code}: ${outcome.error.message}`);
    }
    return;
  }
  assert.equal(outcome.ok, true, `${language} threw: ${JSON.stringify(outcome.error)}`);
  if ("value" in definition) assert.deepEqual(outcome.value, expected, `${language} returned the wrong value`);
}

async function runCase(definition) {
  const ctx = createContext();
  try {
    const state = definition.setup ? await definition.setup(ctx) : undefined;
    const resolve = field => (typeof field === "function" ? field(ctx, state) : field);
    const env = resolve(definition.env) ?? {};
    const outcomes = {};
    for (const language of ["node", "python"]) {
      if (!definition[language]) continue;
      const args = resolve(definition[`${language}Args`] ?? definition.args ?? []);
      outcomes[language] = await ctx.call(language, definition[language], args, env);
    }
    const expected = resolve(definition.value);
    for (const [language, outcome] of Object.entries(outcomes)) assertOutcome(language, outcome, definition, expected);
    if (outcomes.node && outcomes.python && !definition.throws && definition.agree !== false) {
      assert.deepEqual(outcomes.node.value, outcomes.python.value, "Node and Python disagree");
    }
    await definition.check?.(outcomes, ctx, state);
  } finally {
    await ctx.cleanup();
  }
}

for (const file of fs.readdirSync(CASES_DIR).filter(name => name.endsWith(".cases.js")).sort()) {
  const { default: cases } = await import(pathToFileURL(path.join(CASES_DIR, file)).href);
  for (const definition of cases) {
    const skip = (definition.only && definition.only !== FAMILY && `only runs on ${definition.only}`)
      || definition.skipIf?.() || false;
    test(`${file.replace(".cases.js", "")}: ${definition.name}`, { skip }, () => runCase(definition));
  }
}
