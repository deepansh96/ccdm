import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { setImmediate as yieldToLoop } from "node:timers/promises";

const WIN = process.platform === "win32";
const SHARING = ["EPERM", "EACCES", "EBUSY"];
const BUDGET_MS = 200;
// Timers can fire a hair early, so a full budget is measured with a small allowance.
const SPENT_BUDGET_MS = BUDGET_MS - 20;
const isRoot = () => (process.getuid?.() === 0 ? "root ignores directory permissions" : false);

// Python's open() does not allow delete sharing, so on Windows a rename or
// delete of this file fails until the holder closes it.
const HOLD_FOREVER = `
import sys, time
with open(sys.argv[1], "rb"):
    print("ready", flush=True)
    time.sleep(60)
`;

// Holds the file until the writer has made its temporary file, then a little longer.
const HOLD_UNTIL_TEMP = `
import os, sys, time
folder = os.path.dirname(sys.argv[1])
with open(sys.argv[1], "rb"):
    print("ready", flush=True)
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline and not any(n.endswith(".tmp") for n in os.listdir(folder)):
        time.sleep(0.005)
    time.sleep(0.3)
`;

async function holdOpen(ctx, file, source = HOLD_FOREVER) {
  const holder = ctx.start(ctx.python, ["-c", source, file]);
  assert.equal(await holder.line(), "ready");
  return holder;
}

// A failing rename on each OS: a held source on Windows, a read-only directory on POSIX.
async function blockedRename(ctx) {
  const folder = path.join(ctx.work, "blocked");
  fs.mkdirSync(folder);
  const src = path.join(folder, "src");
  fs.writeFileSync(src, "source");
  const dst = path.join(folder, "dst");
  if (WIN) {
    await holdOpen(ctx, src);
  } else {
    fs.chmodSync(folder, 0o555);
    ctx.defer(() => fs.chmodSync(folder, 0o755));
  }
  return { src, dst };
}

async function blockedRemoval(ctx) {
  const folder = path.join(ctx.work, "blocked");
  fs.mkdirSync(path.join(folder, "inner"), { recursive: true });
  const file = path.join(folder, "inner", "held");
  fs.writeFileSync(file, "held");
  if (WIN) {
    await holdOpen(ctx, file);
  } else {
    fs.chmodSync(path.join(folder, "inner"), 0o555);
    ctx.defer(() => fs.chmodSync(path.join(folder, "inner"), 0o755));
  }
  return { folder };
}

const spentBudget = outcomes => {
  for (const [language, outcome] of Object.entries(outcomes)) {
    assert.ok(outcome.ms >= SPENT_BUDGET_MS, `${language} gave up after ${outcome.ms} ms`);
  }
};

const fastFailure = outcomes => {
  for (const [language, outcome] of Object.entries(outcomes)) {
    assert.ok(outcome.ms < 2000, `${language} took ${outcome.ms} ms to throw`);
  }
};

const writers = [
  ["writeFileAtomic", "node", "atomic.writeFileAtomic", mode => [{ mode }]],
  ["writeFileAtomicSync", "node", "atomic.writeFileAtomicSync", mode => [{ mode }]],
  ["write_file_atomic", "python", "atomic.write_file_atomic", mode => [mode]],
];

const WRITE_LOOP = {
  node: `
    const { writeFileAtomicSync } = require(process.argv[1]);
    const counts = { written: 0, starved: 0 };
    for (let i = 0; i < 25; i++) {
      try {
        writeFileAtomicSync(process.argv[2], (i % 2 ? "a" : "b").repeat(262144));
        counts.written += 1;
      } catch (error) {
        if (!["EPERM", "EACCES", "EBUSY"].includes(error.code)) throw error;
        counts.starved += 1;
      }
    }
    console.log(JSON.stringify(counts));
  `,
  python: `
import json, sys
from ccdmlib.platform import atomic
counts = {"written": 0, "starved": 0}
for i in range(25):
    try:
        atomic.write_file_atomic(sys.argv[1], ("a" if i % 2 else "b") * 262144)
        counts["written"] += 1
    except PermissionError:
        counts["starved"] += 1
print(json.dumps(counts))
`,
};

function assertWhole(text, size) {
  assert.equal(text.length, size, "the target was partly written");
  assert.ok(text === text[0].repeat(size), "the target mixes two writes");
}

async function readUntilDone(file, running, size) {
  let done = false;
  const finished = running.then(result => {
    done = true;
    return result;
  });
  let reads = 0;
  while (!done) {
    try {
      assertWhole(fs.readFileSync(file, "utf8"), size);
      reads += 1;
    } catch (error) {
      if (!["EBUSY", "EPERM", "EACCES"].includes(error.code)) throw error;
    }
    await yieldToLoop();
  }
  return { result: await finished, reads };
}

export default [
  ...writers.map(([label, language, fn]) => ({
    name: `${label} writes the exact bytes and leaves no temporary file`,
    [language]: fn,
    args: ctx => [path.join(ctx.work, "file"), "héllo\nworld\n"],
    value: null,
    check(_, ctx) {
      assert.equal(fs.readFileSync(path.join(ctx.work, "file"), "utf8"), "héllo\nworld\n");
      assert.deepEqual(fs.readdirSync(ctx.work), ["file"]);
    },
  })),
  ...writers.flatMap(([label, language, fn, options]) => [
    {
      name: `${label} gives a new target mode 0600 by default`,
      only: "posix",
      [language]: fn,
      args: ctx => [path.join(ctx.work, "file"), "x"],
      check(_, ctx) {
        assert.equal(fs.statSync(path.join(ctx.work, "file")).mode & 0o777, 0o600);
      },
    },
    {
      name: `${label} sets exactly the given mode over an existing file`,
      only: "posix",
      setup: ctx => fs.writeFileSync(path.join(ctx.work, "file"), "old", { mode: 0o644 }),
      [language]: fn,
      args: ctx => [path.join(ctx.work, "file"), "x", ...options(0o640)],
      check(_, ctx) {
        assert.equal(fs.statSync(path.join(ctx.work, "file")).mode & 0o777, 0o640);
      },
    },
    {
      name: `${label} leaves the target alone when the write fails`,
      setup: ctx => fs.writeFileSync(path.join(ctx.work, "file"), "old"),
      [language]: fn,
      args: ctx => [path.join(ctx.work, "file"), 12345],
      throws: true,
      check(_, ctx) {
        assert.equal(fs.readFileSync(path.join(ctx.work, "file"), "utf8"), "old");
        assert.deepEqual(fs.readdirSync(ctx.work), ["file"]);
      },
    },
    {
      name: `${label} waits out a reader holding the target open`,
      async setup(ctx) {
        const file = path.join(ctx.work, "file");
        fs.writeFileSync(file, "old");
        await holdOpen(ctx, file, HOLD_UNTIL_TEMP);
      },
      [language]: fn,
      args: ctx => [path.join(ctx.work, "file"), "new"],
      check(outcomes, ctx) {
        assert.equal(fs.readFileSync(path.join(ctx.work, "file"), "utf8"), "new");
        if (WIN) assert.ok(outcomes[language].ms >= 200, `the rename was not delayed: ${outcomes[language].ms} ms`);
      },
    },
  ]),
  ...["node", "python"].map(language => ({
    name: `a reader never sees a partly written target (${language} writer)`,
    async check(_, ctx) {
      const file = path.join(ctx.work, "file");
      const size = 262144;
      fs.writeFileSync(file, "c".repeat(size));
      const running = language === "node"
        ? ctx.nodeScript(WRITE_LOOP.node, [path.join(ctx.root, "scripts", "platform", "atomic.js"), file])
        : ctx.pythonScript(WRITE_LOOP.python, [file]);
      const { result, reads } = await readUntilDone(file, running, size);
      assert.equal(result.code, 0, result.stderr);
      assert.ok(reads > 0, "the reader never got a turn");
      // On Windows a nonstop reader can make a rename spend its whole budget. That
      // is the specified failure, and the target must still be whole.
      const { written, starved } = JSON.parse(result.stdout);
      assert.ok(written > 0, "no write succeeded");
      if (!WIN) assert.equal(starved, 0);
    },
  })),
  {
    name: "rename retries a sharing error and rethrows the last one after the budget",
    skipIf: isRoot,
    setup: blockedRename,
    node: "atomic.renameWithRetry",
    python: "atomic.replace_with_retry",
    nodeArgs: (_, { src, dst }) => [src, dst, { budgetMs: BUDGET_MS }],
    pythonArgs: (_, { src, dst }) => [src, dst, BUDGET_MS],
    throws: SHARING,
    check: spentBudget,
  },
  {
    name: "rename_with_retry spends the same budget",
    skipIf: isRoot,
    setup: blockedRename,
    python: "atomic.rename_with_retry",
    args: (_, { src, dst }) => [src, dst, BUDGET_MS],
    throws: SHARING,
    check: spentBudget,
  },
  {
    name: "rename throws a non-retryable error at once",
    node: "atomic.renameWithRetry",
    python: "atomic.replace_with_retry",
    nodeArgs: ctx => [path.join(ctx.work, "missing"), path.join(ctx.work, "dst"), { budgetMs: 10000 }],
    pythonArgs: ctx => [path.join(ctx.work, "missing"), path.join(ctx.work, "dst"), 10000],
    throws: ["ENOENT"],
    check: fastFailure,
  },
  {
    name: "rename_with_retry throws a non-retryable error at once",
    python: "atomic.rename_with_retry",
    args: ctx => [path.join(ctx.work, "missing"), path.join(ctx.work, "dst"), 10000],
    throws: ["ENOENT"],
    check: fastFailure,
  },
  {
    name: "rename_with_retry refuses an existing target on Windows, and replace overwrites it",
    only: "win32",
    setup(ctx) {
      fs.writeFileSync(path.join(ctx.work, "src"), "new");
      fs.writeFileSync(path.join(ctx.work, "dst"), "old");
    },
    python: "atomic.rename_with_retry",
    args: ctx => [path.join(ctx.work, "src"), path.join(ctx.work, "dst"), 10000],
    throws: ["EEXIST"],
    async check(outcomes, ctx) {
      fastFailure(outcomes);
      await ctx.py("atomic.replace_with_retry", path.join(ctx.work, "src"), path.join(ctx.work, "dst"));
      assert.equal(fs.readFileSync(path.join(ctx.work, "dst"), "utf8"), "new");
    },
  },
  {
    name: "removing a directory throws after the budget when it stays blocked",
    skipIf: isRoot,
    setup: blockedRemoval,
    node: "atomic.removeDirWithRetry",
    python: "atomic.remove_dir_with_retry",
    nodeArgs: (_, { folder }) => [folder, { budgetMs: BUDGET_MS }],
    pythonArgs: (_, { folder }) => [folder, BUDGET_MS],
    throws: [...SHARING, "ENOTEMPTY"],
    check: spentBudget,
  },
  ...[["node", "atomic.removeDirWithRetry"], ["python", "atomic.remove_dir_with_retry"]].flatMap(([language, fn]) => [
    {
      name: `${fn} removes a directory tree`,
      setup: ctx => fs.mkdirSync(path.join(ctx.work, "tree", "inner"), { recursive: true }),
      [language]: fn,
      args: ctx => [path.join(ctx.work, "tree")],
      check(_, ctx) {
        assert.equal(fs.existsSync(path.join(ctx.work, "tree")), false);
      },
    },
    {
      name: `${fn} accepts a directory that is already gone`,
      [language]: fn,
      args: ctx => [path.join(ctx.work, "missing")],
      value: null,
    },
  ]),
];
