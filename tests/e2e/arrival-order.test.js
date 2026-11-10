import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const MODULE = require.resolve("../../scripts/lib/arrival-order.js");
const { arrivalOrder, DEFAULT_TIMEOUT_MS } = require(MODULE);

// A promise the test settles by hand.
function gate() {
  let open;
  let fail;
  const opened = new Promise((resolve, reject) => { open = resolve; fail = reject; });
  return { opened, open, fail };
}

// Lets every promise step that is ready run.
const settle = () => new Promise((resolve) => setImmediate(resolve));

function line(t, options = {}) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const logged = [];
  const inOrder = arrivalOrder({ log: (text) => logged.push(text), ...options });
  return { inOrder, logged };
}

test("a slow first handler still acts before a fast second one", { timeout: 30000 }, async (t) => {
  const { inOrder, logged } = line(t);
  const first = gate();
  const acted = [];
  const handle = inOrder("message", async (event) => {
    if (event === "first") await first.opened;
    acted.push(event);
  });

  const done = [handle("first"), handle("second")];
  await settle();
  assert.deepEqual(acted, []);
  first.open();
  await Promise.all(done);

  assert.deepEqual(acted, ["first", "second"]);
  assert.deepEqual(logged, []);
});

test("next() lets the following event start before the handler ends", { timeout: 30000 }, async (t) => {
  const { inOrder } = line(t);
  const slowTail = gate();
  const acted = [];
  const handle = inOrder("message", async (event, next) => {
    acted.push(`${event} acted`);
    next();
    if (event === "first") await slowTail.opened;
    acted.push(`${event} ended`);
  });

  const done = [handle("first"), handle("second")];
  await settle();
  assert.deepEqual(acted, ["first acted", "second acted", "second ended"]);
  slowTail.open();
  await Promise.all(done);
  assert.deepEqual(acted, ["first acted", "second acted", "second ended", "first ended"]);
});

test("a handler that throws, now or later, lets the following event run and reports its error", { timeout: 30000 }, async (t) => {
  const { inOrder, logged } = line(t);
  const acted = [];
  const handle = inOrder("reaction", (event) => {
    if (event === "throws") throw new Error("thrown at once");
    if (event === "rejects") return Promise.reject(new Error("rejected later"));
    acted.push(event);
    return undefined;
  });

  const [thrown, rejected, after] = [handle("throws"), handle("rejects"), handle("after")];
  await assert.rejects(thrown, /thrown at once/);
  await assert.rejects(rejected, /rejected later/);
  await after;

  assert.deepEqual(acted, ["after"]);
  assert.deepEqual(logged, []);
});

test("a handler that never settles stops holding the line after the limit, and still takes effect when it ends", { timeout: 30000 }, async (t) => {
  const { inOrder, logged } = line(t, { timeoutMs: 5000 });
  const stuck = gate();
  const acted = [];
  const handle = inOrder("message", async (event) => {
    if (event === "stuck") await stuck.opened;
    acted.push(event);
  });

  const stuckDone = handle("stuck");
  const laterDone = handle("later");
  await settle();
  t.mock.timers.tick(4999);
  await settle();
  assert.deepEqual(acted, []);
  assert.deepEqual(logged, []);

  t.mock.timers.tick(1);
  await laterDone;
  assert.deepEqual(acted, ["later"]);
  assert.equal(logged.length, 1);
  assert.match(logged[0], /^\[order\] a message event held later events for \d+ ms; they go ahead without it$/);

  stuck.open();
  await stuckDone;
  assert.deepEqual(acted, ["later", "stuck"]);
  // The late finish is not reported again, and the event after it has its own limit.
  await handle("next");
  t.mock.timers.tick(5000);
  await settle();
  assert.equal(logged.length, 1);
});

test("a handler that finishes or calls next() in time leaves no timer behind", { timeout: 30000 }, async (t) => {
  const { inOrder, logged } = line(t, { timeoutMs: 5000 });
  const slowTail = gate();
  const handle = inOrder("message", async (event, next) => {
    if (event === "releases early") {
      next();
      await slowTail.opened;
    }
  });

  const early = handle("releases early");
  await handle("finishes");
  // Past the limit, with the first handler still running: nothing fires.
  t.mock.timers.tick(60000);
  await settle();
  assert.deepEqual(logged, []);
  slowTail.open();
  await early;
  t.mock.timers.tick(60000);
  await settle();
  assert.deepEqual(logged, []);
});

test("the limit is 30 s unless one is given, and a pending limit does not keep the process alive", { timeout: 30000 }, () => {
  assert.equal(DEFAULT_TIMEOUT_MS, 30000);
  // A handler that never settles, under the default limit: the process must still exit at once.
  const script = `
    const { arrivalOrder } = require(${JSON.stringify(MODULE)});
    arrivalOrder()("message", () => new Promise(() => {}))("stuck");
    setImmediate(() => console.log("handler started"));
  `;
  const started = Date.now();
  const result = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", timeout: 20000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "handler started");
  assert.ok(Date.now() - started < 20000, "the process waited for the limit");
});
