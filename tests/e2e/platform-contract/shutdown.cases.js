import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// The real worker loop, with only its Router link replaced: it takes the lock,
// opens the store and the control channel, and has to clean them all up.
const WORKER = `
import os, sys, time
from pathlib import Path
from thread_supervisor import worker
class FakeLink:
    pid = os.getpid()
    def __init__(self, _key):
        self.announced = False
    def post(self, _frame):
        pass
    def next_frame(self, _timeout):
        if not self.announced:
            self.announced = True
            print("ready", flush=True)
        time.sleep(0.05)
    def close(self):
        print("link closed", flush=True)
worker.Link = FakeLink
worker.run(Path(sys.argv[1]), Path(sys.argv[2]))
print("exited", flush=True)
`;

// Node cannot send Ctrl+Break, and the worker needs a process group of its own
// so that the event reaches nobody else.
const SEND_BREAK = `
import json, os, signal, subprocess, sys
worker = subprocess.Popen([sys.executable, "-c", sys.argv[1], sys.argv[2], sys.argv[3]],
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                          creationflags=subprocess.CREATE_NEW_PROCESS_GROUP)
first = worker.stdout.readline().decode().strip()
os.kill(worker.pid, signal.CTRL_BREAK_EVENT)
out, err = worker.communicate(timeout=20)
print(json.dumps({"first": first, "code": worker.returncode, "stdout": out.decode(), "stderr": err.decode()}))
`;

function dirs(ctx) {
  const root = path.join(ctx.dir, "project");
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, "registry.json"), "{}");
  return { root, state: path.join(ctx.dir, "state") };
}

function assertCleanedUp(state) {
  assert.equal(fs.existsSync(path.join(state, "worker.json")), false, "worker.json was left behind");
  for (const file of ["control.sock", "supervisor.pipe", "supervisor.secret"]) {
    assert.equal(fs.existsSync(path.join(state, file)), false, `${file} was left behind`);
  }
}

export default [
  {
    name: "a stop marker ends the worker cleanly, and a marker left from before does not stop the next one",
    async check(_outcomes, ctx) {
      const { root, state } = dirs(ctx);
      fs.mkdirSync(state, { recursive: true });
      fs.writeFileSync(path.join(state, "stop"), "");
      const worker = ctx.start(ctx.python, ["-c", WORKER, root, state]);
      assert.equal(await worker.line(), "ready");
      assert.equal(fs.existsSync(path.join(state, "stop")), false);
      fs.writeFileSync(path.join(state, "stop"), "");
      assert.equal(await worker.line(), "link closed");
      assert.equal(await worker.line(), "exited");
      assert.equal(await worker.exited, 0);
      assertCleanedUp(state);
    },
  },
  {
    name: "Ctrl+Break ends a worker in its own process group cleanly",
    only: "win32",
    async check(_outcomes, ctx) {
      const { root, state } = dirs(ctx);
      const result = await ctx.pythonScript(SEND_BREAK, [WORKER, root, state]);
      assert.equal(result.code, 0, result.stderr);
      const worker = JSON.parse(result.stdout);
      assert.equal(worker.first, "ready", worker.stderr);
      assert.equal(worker.code, 0, worker.stderr);
      assert.deepEqual(worker.stdout.trim().split(/\r?\n/), ["link closed", "exited"]);
      assert.match(worker.stderr, /thread-supervisor: stopped/);
      assertCleanedUp(state);
    },
  },
];
