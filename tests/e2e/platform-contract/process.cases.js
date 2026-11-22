import assert from "node:assert/strict";
import path from "node:path";

const WIN = process.platform === "win32";
const alive = { node: "process.processAlive", python: "proc.alive" };
const startTime = { node: "process.processStartTime", python: "proc.start_time" };
const NO_SUCH_PID = 999999999;
const TICKS = /^\d{15,20}$/;

function sleeper(ctx) {
  return ctx.start(process.execPath, ["-e", "console.log('ready'); setInterval(() => {}, 1000)"]);
}

async function runningChild(ctx) {
  const child = sleeper(ctx);
  assert.equal(await child.line(), "ready");
  return child;
}

async function exitedChild(ctx) {
  const child = await runningChild(ctx);
  await child.stop();
  return child;
}

const processModule = ctx => path.join(ctx.root, "scripts", "platform", "process.js");
const NODE_IDENTITY = `
  console.log(JSON.stringify(require(process.argv[1]).processIdentity()));
  setInterval(() => {}, 1000);
`;
const PYTHON_IDENTITY = `
import json, time
from ccdmlib.platform import proc
print(json.dumps(proc.identity()), flush=True)
time.sleep(60)
`;

const LOAD_EVERY_MODULE = `
  const fs = require("node:fs");
  const path = require("node:path");
  const dir = process.argv[1];
  const modules = fs.readdirSync(dir).filter(name => name.endsWith(".js")).map(name => require(path.join(dir, name)));
  if (process.argv[2] === "exercise") {
    const { processAlive, processIdentity, processStartTime } = require(path.join(dir, "process.js"));
    processIdentity();
    processStartTime(process.pid);
    processAlive(process.pid, "1");
  }
  console.log(JSON.stringify({
    modules: modules.length,
    koffi: Object.keys(require.cache).filter(file => /[\\\\/]koffi[\\\\/]/.test(file)),
  }));
`;

async function loadReport(ctx, ...flags) {
  const result = await ctx.nodeScript(LOAD_EVERY_MODULE, [path.join(ctx.root, "scripts", "platform"), ...flags]);
  assert.equal(result.code, 0, result.stderr);
  return JSON.parse(result.stdout);
}

export default [
  {
    name: "a running child is alive in both",
    setup: runningChild,
    ...alive,
    args: (_, child) => [child.pid],
    value: true,
  },
  {
    name: "a child that has exited is dead in both",
    setup: exitedChild,
    ...alive,
    args: (_, child) => [child.pid],
    value: false,
  },
  {
    name: "an unused PID is dead in both",
    ...alive,
    args: [NO_SUCH_PID],
    value: false,
  },
  ...[0, -1, "1", 1.5, null].map(pid => ({
    name: `${JSON.stringify(pid)} is not a live PID`,
    ...alive,
    args: [pid],
    value: false,
  })),
  {
    name: "the matching start time keeps a child alive on Windows",
    only: "win32",
    async setup(ctx) {
      const child = await runningChild(ctx);
      return { pid: child.pid, startedAt: await ctx.py("proc.start_time", child.pid) };
    },
    ...alive,
    args: (_, { pid, startedAt }) => [pid, startedAt],
    value: true,
  },
  {
    name: "a wrong start time reads as dead on Windows",
    only: "win32",
    setup: runningChild,
    ...alive,
    args: (_, child) => [child.pid, "116444736000000000"],
    value: false,
  },
  {
    name: "a start time is ignored on POSIX",
    only: "posix",
    setup: runningChild,
    ...alive,
    args: (_, child) => [child.pid, "116444736000000000"],
    value: true,
  },
  {
    name: "an unreadable start time counts as alive on Windows",
    only: "win32",
    async check(_, ctx) {
      const SYSTEM_PID = 4;
      // An elevated run can read this process, and then there is nothing to show.
      if (await ctx.py("proc.start_time", SYSTEM_PID) !== null) return;
      assert.equal(await ctx.node("process.processAlive", SYSTEM_PID, "1"), true);
      assert.equal(await ctx.py("proc.alive", SYSTEM_PID, "1"), true);
    },
  },
  {
    name: "both read the same start time for a running child",
    setup: runningChild,
    ...startTime,
    args: (_, child) => [child.pid],
    check({ node }) {
      if (WIN) assert.match(node.value, TICKS);
      else assert.equal(node.value, null);
    },
  },
  {
    name: "a child that has exited has no start time",
    setup: exitedChild,
    ...startTime,
    args: (_, child) => [child.pid],
    value: null,
  },
  {
    name: "processIdentity of a Node child equals Python start_time",
    async check(_, ctx) {
      const child = ctx.start(process.execPath, ["-e", NODE_IDENTITY, processModule(ctx)]);
      const { pid, startedAt } = JSON.parse(await child.line());
      assert.equal(pid, child.pid);
      assert.equal(await ctx.py("proc.start_time", pid), startedAt);
      if (WIN) assert.match(startedAt, TICKS);
      else assert.equal(startedAt, null);
    },
  },
  {
    name: "identity of a Python child equals Node processStartTime",
    async check(_, ctx) {
      const child = ctx.start(ctx.python, ["-c", PYTHON_IDENTITY]);
      const [pid, startedAt] = JSON.parse(await child.line());
      assert.equal(pid, child.pid);
      assert.equal(await ctx.node("process.processStartTime", pid), startedAt);
      if (WIN) assert.match(startedAt, TICKS);
      else assert.equal(startedAt, null);
    },
  },
  {
    name: "own identity has this process's PID in both",
    node: "process.processIdentity",
    python: "proc.identity",
    agree: false,
    check({ node, python }) {
      assert.ok(node.value.pid > 0);
      assert.ok(python.value[0] > 0);
      if (WIN) {
        assert.match(node.value.startedAt, TICKS);
        assert.match(python.value[1], TICKS);
      } else {
        assert.equal(node.value.startedAt, null);
        assert.equal(python.value[1], null);
      }
    },
  },
  {
    name: "loading every scripts/platform module does not load koffi",
    async check(_, ctx) {
      const { koffi, modules } = await loadReport(ctx);
      assert.ok(modules >= 4, `only ${modules} modules found`);
      assert.deepEqual(koffi, []);
    },
  },
  {
    name: "using the process helpers on POSIX does not load koffi",
    only: "posix",
    async check(_, ctx) {
      assert.deepEqual((await loadReport(ctx, "exercise")).koffi, []);
    },
  },
];
