import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("package.json exposes the parallel local-fake e2e suite and its serialized fallback", () => {
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));

  assert.equal(pkg.engines.node, ">=22");
  assert.equal(pkg.scripts.test, "node tests/run-e2e.mjs");
  assert.equal(pkg.scripts["test:e2e"], "node tests/run-e2e.mjs");
  assert.equal(pkg.scripts["test:serial"], "node --test --test-concurrency=1 tests/e2e/**/*.test.js");
});
