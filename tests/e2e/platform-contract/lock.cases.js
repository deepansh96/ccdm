// Registry lock protocol v2: Node (scripts/router/registry.js) and Python
// (scripts/registry-update.py) must build and read lock directories identically.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const WIN = process.platform === "win32";
const NO_SUCH_PID = 999999999;
const scriptPath = (ctx, ...parts) => path.join(ctx.root, "scripts", ...parts);

const NODE_LOCK_DIR = `
  const fs = require("node:fs");
  const path = require("node:path");
  const { withRegistryLock } = require(process.argv[1]);
  const file = process.argv[2];
  withRegistryLock(file, async () => {
    const dir = file + ".lock";
    const entries = Object.fromEntries(fs.readdirSync(dir).sort()
      .map(name => [name, fs.readFileSync(path.join(dir, name)).toString("latin1")]));
    console.log(JSON.stringify({ pid: process.pid, entries }));
  });
`;

const LOAD_REGISTRY_UPDATE = `
import importlib.util, json, os, sys
spec = importlib.util.spec_from_file_location("ru", sys.argv[1])
ru = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ru)
`;

const PYTHON_LOCK_DIR = `${LOAD_REGISTRY_UPDATE}
file = sys.argv[2]
handle = ru.acquire(file)
directory = file + ".lock"
entries = {name: open(os.path.join(directory, name), "rb").read().decode("latin1") for name in sorted(os.listdir(directory))}
owner = entries["owner"].strip()
ru.release(handle)
print(json.dumps({"pid": os.getpid(), "entries": entries, "ownerIsDigit": owner.isascii() and owner.isdigit()}))
`;

const NODE_DEAD_KEY = `
  const { _lockInternals: { deadKey } } = require(process.argv[1]);
  deadKey(process.argv[2]).then(key => console.log(JSON.stringify(key)));
`;

const PYTHON_DEAD_KEY = `${LOAD_REGISTRY_UPDATE}
print(json.dumps(ru._dead_key(ru.Path(sys.argv[2]))))
`;

function json(result, label) {
  assert.equal(result.code, 0, `${label}: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

async function deadKeys(ctx, lock) {
  const node = json(await ctx.nodeScript(NODE_DEAD_KEY, [scriptPath(ctx, "router", "registry.js"), lock]), "node");
  const python = json(await ctx.pythonScript(PYTHON_DEAD_KEY, [scriptPath(ctx, "registry-update.py"), lock]), "python");
  return { node, python };
}

function lockAt(ctx, files) {
  const lock = path.join(ctx.dir, "registry.json.lock");
  fs.mkdirSync(lock);
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(lock, name), text);
  return lock;
}

// `value` is the key expected from both, or null for "not dead".
function deadKeyCase(name, files, expected) {
  return {
    name,
    async check(_, ctx) {
      const keys = await deadKeys(ctx, lockAt(ctx, files()));
      assert.deepEqual(keys.node, keys.python, "Node and Python disagree");
      if (expected === null) assert.equal(keys.node, null);
      else assert.equal(keys.node, expected);
    },
  };
}

function assertV2LockDir({ pid, entries }) {
  assert.deepEqual(Object.keys(entries).sort(), WIN ? ["nonce", "owner", "started"] : ["nonce", "owner"]);
  assert.equal(entries.owner, `${pid}\n`);
  assert.match(entries.owner.trim(), /^\d+$/);
  assert.match(entries.nonce, /^[0-9a-f]{32}\n$/);
  if (WIN) assert.match(entries.started, /^\d{15,20}\n$/);
}

export default [
  {
    name: "a lock Node takes holds owner and nonce with exact bytes, and started only on win32",
    async check(_, ctx) {
      const file = path.join(ctx.dir, "registry.json");
      fs.writeFileSync(file, "{}\n");
      assertV2LockDir(json(await ctx.nodeScript(NODE_LOCK_DIR, [scriptPath(ctx, "router", "registry.js"), file]), "node"));
      assert.equal(fs.existsSync(`${file}.lock`), false);
    },
  },
  {
    name: "a lock Python takes holds the same bytes, and its owner passes the pre-v2 isdigit check",
    async check(_, ctx) {
      const file = path.join(ctx.dir, "registry.json");
      fs.writeFileSync(file, "{}\n");
      const taken = json(await ctx.pythonScript(PYTHON_LOCK_DIR, [scriptPath(ctx, "registry-update.py"), file]), "python");
      assertV2LockDir(taken);
      assert.equal(taken.ownerIsDigit, true);
      assert.equal(fs.existsSync(`${file}.lock`), false);
    },
  },
  deadKeyCase("a dead holder with a nonce gets the same key from both",
    () => ({ owner: `${NO_SUCH_PID}\n`, nonce: "abc\n" }), "nabc"),
  deadKeyCase("an unreadable owner counts as a dead holder in both, keyed by nonce",
    () => ({ owner: "not-a-pid\n", nonce: "abc\n" }), "nabc"),
  {
    name: "a live holder with its real start time is not dead in either",
    async check(_, ctx) {
      const started = await ctx.node("process.processStartTime", process.pid);
      const keys = await deadKeys(ctx, lockAt(ctx, {
        owner: `${process.pid}\n`, nonce: "abc\n", ...(started ? { started: `${started}\n` } : {}),
      }));
      assert.deepEqual(keys, { node: null, python: null });
    },
  },
  deadKeyCase("a lock without started is judged by PID alone in both",
    () => ({ owner: `${process.pid}\n`, nonce: "abc\n" }), null),
  deadKeyCase("a started that is not a number is ignored in both",
    () => ({ owner: `${process.pid}\n`, nonce: "abc\n", started: "soon\n" }), null),
  deadKeyCase("a live PID whose started differs is dead on win32, and started is ignored elsewhere",
    () => ({ owner: `${process.pid}\n`, nonce: "abc\n", started: "1\n" }), WIN ? "nabc" : null),
  {
    name: "a lock with no owner file is not treated as dead by either",
    async check(_, ctx) {
      const keys = await deadKeys(ctx, lockAt(ctx, { nonce: "abc\n" }));
      assert.deepEqual(keys, { node: null, python: null });
    },
  },
  {
    name: "activity.json and context.json are written whole, with no temporary file left, and 0600 on POSIX",
    async check(_, ctx) {
      const script = `
        const path = require("node:path");
        const [scripts, dir] = process.argv.slice(1);
        require(path.join(scripts, "thread-activity.js")).markTurn(path.join(dir, "activity.json"), true);
        const { createRouterTransport } = require(path.join(scripts, "codex-bridge-transport.js"));
        createRouterTransport({ project: "demo", launchDir: dir }).setContextPct(42);
      `;
      const dir = path.join(ctx.dir, "launch");
      fs.mkdirSync(dir);
      const result = await ctx.nodeScript(script, [path.join(ctx.root, "scripts"), dir]);
      assert.equal(result.code, 0, result.stderr);
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "activity.json"), "utf8")),
        { turn_running: true, last_turn_end_at: null });
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "context.json"), "utf8")), { context_pct: 42 });
      assert.deepEqual(fs.readdirSync(dir).sort(), ["activity.json", "context.json"]);
      if (!WIN) {
        assert.equal(fs.statSync(path.join(dir, "activity.json")).mode & 0o777, 0o600);
        assert.equal(fs.statSync(path.join(dir, "context.json")).mode & 0o777, 0o600);
      }
    },
  },
];
