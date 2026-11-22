import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// The Windows process table. alive and start_time agree with Node in process.cases.js.
const only = "win32";

const SLEEPER = "console.log('ready'); setInterval(() => {}, 1000)";

async function sleeper(ctx, ...args) {
  const child = ctx.start(process.execPath, ["-e", SLEEPER, ...args]);
  assert.equal(await child.line(), "ready");
  return child;
}

// Prints {"depth": n, "pid": p} from each level of a chain of processes.
const CHAIN = `
import json, os, subprocess, sys, time
depth = int(sys.argv[1])
if depth > 0:
    subprocess.Popen([sys.executable, sys.argv[0], str(depth - 1)])
print(json.dumps({"depth": depth, "pid": os.getpid()}), flush=True)
time.sleep(120)
`;

async function chain(ctx, levels) {
  const file = path.join(ctx.dir, "chain.py");
  fs.writeFileSync(file, CHAIN);
  const root = ctx.start(ctx.python, [file, String(levels - 1)]);
  const members = [];
  for (let index = 0; index < levels; index += 1) members.push(JSON.parse(await root.line()));
  members.sort((a, b) => b.depth - a.depth);
  return { root, pids: members.map(member => member.pid) };
}

async function waitDead(ctx, pid) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!(await ctx.py("proc.alive", pid))) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail(`process ${pid} is still running`);
}

// Teardown stops only the root it started; the rest of a chain must go before
// its directory can be removed.
async function stopAfter(ctx, pids) {
  const members = [];
  for (const pid of pids) members.push([pid, await ctx.py("proc.start_time", pid)]);
  ctx.defer(async () => {
    for (const [pid, started] of members) await ctx.py("proc.kill_tree", pid, 0, started);
  });
}

async function kids(ctx, parent, parentStarted, table) {
  const result = await ctx.pythonScript(`
import json, sys
from ccdmlib.platform import proc
table = [proc.Process(pid, ppid, "x") for pid, ppid in json.loads(sys.argv[1])]
print(json.dumps([pid for pid, _ in proc._kids(table, int(sys.argv[2]), sys.argv[3])]))
`, [JSON.stringify(table), String(parent), parentStarted]);
  assert.equal(result.code, 0, result.stderr);
  return JSON.parse(result.stdout);
}

export default [
  {
    name: "command_line splits a process's quoted arguments",
    only,
    setup: ctx => sleeper(ctx, "two words", 'a"b', "plain"),
    python: "proc.command_line",
    args: (_, child) => [child.pid],
    check({ python }) {
      assert.deepEqual(python.value.slice(-3), ["two words", 'a"b', "plain"]);
      assert.match(python.value[0], /node/i);
    },
  },
  {
    name: "command_line of an unused PID is null",
    only,
    python: "proc.command_line",
    args: [999999999],
    value: null,
  },
  {
    name: "children lists direct children only",
    only,
    async check(_outcomes, ctx) {
      const { pids } = await chain(ctx, 3);
      await stopAfter(ctx, pids);
      // The root also has a hidden console host as a child.
      const ofRoot = await ctx.py("proc.children", pids[0]);
      assert.ok(ofRoot.includes(pids[1]) && !ofRoot.includes(pids[2]), JSON.stringify(ofRoot));
      assert.deepEqual(await ctx.py("proc.children", pids[1]), [pids[2]]);
      assert.deepEqual(await ctx.py("proc.children", pids[2]), []);
    },
  },
  {
    name: "children of an unused PID is empty",
    only,
    python: "proc.children",
    args: [999999999],
    value: [],
  },
  {
    name: "find returns the processes a predicate accepts",
    only,
    async check(_outcomes, ctx) {
      const child = await sleeper(ctx);
      const result = await ctx.pythonScript(`
import json, sys
from ccdmlib.platform import proc
print(json.dumps(proc.find(lambda process: process.pid == int(sys.argv[1]))))
`, [String(child.pid)]);
      assert.equal(result.code, 0, result.stderr);
      const found = JSON.parse(result.stdout);
      assert.equal(found.length, 1);
      assert.equal(found[0][0], child.pid);
      assert.match(found[0][2], /node/i);
    },
  },
  {
    name: "a process older than its claimed parent is not its child",
    only,
    async check(_outcomes, ctx) {
      const older = await sleeper(ctx);
      const parent = await sleeper(ctx);
      const parentStarted = await ctx.py("proc.start_time", parent.pid);
      assert.deepEqual(await kids(ctx, parent.pid, parentStarted, [[older.pid, parent.pid]]), []);
    },
  },
  {
    name: "after PID reuse, children of the new holder are not children of the old process",
    only,
    async check(_outcomes, ctx) {
      const orphan = await sleeper(ctx);
      const holder = await sleeper(ctx);
      const holderChild = await sleeper(ctx);
      // The process we mean started before the orphan, and its PID now belongs to \`holder\`.
      const oldStarted = String(BigInt(await ctx.py("proc.start_time", orphan.pid)) - 1n);
      assert.deepEqual(await kids(ctx, holder.pid, oldStarted,
        [[orphan.pid, holder.pid], [holderChild.pid, holder.pid]]), [orphan.pid]);
    },
  },
  {
    name: "kill_tree ends a child and its grandchild, and nothing else",
    only,
    async check(_outcomes, ctx) {
      const bystander = await sleeper(ctx);
      const { pids } = await chain(ctx, 3);
      await ctx.py("proc.kill_tree", pids[0], 0);
      for (const pid of pids) await waitDead(ctx, pid);
      assert.equal(await ctx.py("proc.alive", bystander.pid), true);
    },
  },
  {
    name: "kill_tree still finds a grandchild once the root has exited during the grace period",
    only,
    async check(_outcomes, ctx) {
      const { pids } = await chain(ctx, 2);
      const started = await ctx.py("proc.start_time", pids[0]);
      // A second caller ends the root halfway through the first caller's grace period.
      const killing = ctx.call("python", "proc.kill_tree", [pids[0], 2, started]);
      await new Promise(resolve => setTimeout(resolve, 500));
      await ctx.pythonScript(`
import sys
from ccdmlib.platform import proc
proc._terminate(int(sys.argv[1]), sys.argv[2])
`, [String(pids[0]), started]);
      assert.equal((await killing).ok, true);
      await waitDead(ctx, pids[1]);
    },
  },
  {
    name: "kill_tree lets a process that exits within the grace period finish by itself",
    only,
    async check(_outcomes, ctx) {
      const child = ctx.start(process.execPath, ["-e", "console.log('ready'); setTimeout(() => process.exit(0), 300)"]);
      assert.equal(await child.line(), "ready");
      await ctx.py("proc.kill_tree", child.pid, 10);
      assert.equal(await child.exited, 0);
    },
  },
  {
    name: "kill_tree leaves a reused PID alone",
    only,
    async check(_outcomes, ctx) {
      const child = await sleeper(ctx);
      await ctx.py("proc.kill_tree", child.pid, 0, "1");
      assert.equal(await ctx.py("proc.alive", child.pid), true);
    },
  },
  {
    name: "a wrong start time reads a running PID as dead",
    only,
    setup: sleeper,
    python: "proc.alive",
    args: (_, child) => [child.pid, "1"],
    value: false,
  },
];
