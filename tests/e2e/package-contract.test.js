import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("package.json exposes the default serialized local-fake e2e suite", () => {
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));

  assert.equal(pkg.engines.node, ">=22");
  assert.equal(pkg.scripts.test, "node --test --test-concurrency=1 tests/e2e/**/*.test.js");
  assert.equal(pkg.scripts["test:e2e"], "node --test --test-concurrency=1 tests/e2e/**/*.test.js");
});
