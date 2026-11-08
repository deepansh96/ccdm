import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// The lock files the services use are empty, but a handle opened for append sits
// at the end of whatever is there, so these start with content.
function lockFile(ctx, name = "worker.lock") {
  const file = path.join(ctx.dir, name);
  fs.writeFileSync(file, "x");
  return file;
}

const HOLDER = `
import sys
from ccdmlib.platform import filelock
handle = open(sys.argv[1], "a+")
print(filelock.try_lock(handle), flush=True)
sys.stdin.read()
`;

const TRY_THEN_WAIT = `
import json, sys, time
from ccdmlib.platform import filelock
handle = open(sys.argv[1], "a+")
now = time.monotonic()
result = {"try": filelock.try_lock(handle), "lock": filelock.lock(handle, now + 0.4)}
result["waited"] = time.monotonic() - now
print(json.dumps(result))
`;

const WAIT_FOR_LOCK = `
import sys, time
from ccdmlib.platform import filelock
handle = open(sys.argv[1], "a+")
print(filelock.lock(handle, time.monotonic() + float(sys.argv[2])))
`;

const SAME_PROCESS = `
import json, sys
from ccdmlib.platform import filelock
writer = open(sys.argv[1], "a+")
reader = open(sys.argv[1], "r")
result = [filelock.try_lock(writer), filelock.try_lock(reader)]
filelock.unlock(writer)
result.append(filelock.try_lock(reader))
filelock.unlock(reader)
print(json.dumps(result))
`;

const SUPERVISOR_RUNNING = `
import sys
from pathlib import Path
from thread_supervisor.status import running
print(running(Path(sys.argv[1])))
`;

const output = result => {
  assert.equal(result.code, 0, result.stderr);
  return result.stdout.trim();
};

export default [
  {
    name: "a second process hears held within its deadline, and gets the lock once the holder exits",
    async check(_outcomes, ctx) {
      const file = lockFile(ctx);
      const holder = ctx.start(ctx.python, ["-c", HOLDER, file]);
      assert.equal(await holder.line(), "True");
      const held = JSON.parse(output(await ctx.pythonScript(TRY_THEN_WAIT, [file])));
      assert.equal(held.try, false);
      assert.equal(held.lock, false);
      assert.ok(held.waited >= 0.35 && held.waited < 5, `waited ${held.waited} s`);
      // The waiter starts first, so it has to notice the holder going away.
      const waiter = ctx.pythonScript(WAIT_FOR_LOCK, [file, "20"]);
      await holder.stop();
      assert.equal(output(await waiter), "True");
    },
  },
  {
    name: "two handles conflict in one process, a read-only handle can lock, and unlock frees it",
    async check(_outcomes, ctx) {
      assert.deepEqual(JSON.parse(output(await ctx.pythonScript(SAME_PROCESS, [lockFile(ctx)]))), [true, false, true]);
    },
  },
  {
    name: "the supervisor's status sees a held worker.lock as running, and a free one as not",
    async check(_outcomes, ctx) {
      const state = path.join(ctx.dir, "state");
      fs.mkdirSync(state);
      const file = lockFile(ctx, path.join("state", "worker.lock"));
      assert.equal(output(await ctx.pythonScript(SUPERVISOR_RUNNING, [state])), "False");
      const holder = ctx.start(ctx.python, ["-c", HOLDER, file]);
      assert.equal(await holder.line(), "True");
      assert.equal(output(await ctx.pythonScript(SUPERVISOR_RUNNING, [state])), "True");
      await holder.stop();
    },
  },
  {
    name: "the five service files use filelock and never fcntl",
    async check(_outcomes, ctx) {
      for (const file of ["conversation-reminder-service.py", "usage-stats-poster.py", "thread_supervisor/worker.py",
        "thread_supervisor/status.py", "thread_supervisor/operator_stop.py"]) {
        const source = fs.readFileSync(path.join(ctx.root, "scripts", file), "utf8");
        assert.doesNotMatch(source, /\bfcntl\b/, file);
        assert.match(source, /\bfilelock\b/, file);
      }
    },
  },
];
