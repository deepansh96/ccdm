import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("GitHub Actions runs the default e2e suite on Node 22", () => {
  const workflow = fs.readFileSync(".github/workflows/e2e.yml", "utf8");

  assert.match(workflow, /push:/);
  assert.match(workflow, /pull_request:/);
  assert.match(workflow, /node-version:\s*22/);
  assert.match(workflow, /npm ci/);
  assert.match(workflow, /zsh/);
  assert.match(workflow, /python3/);
  assert.match(workflow, /jq/);
  assert.match(workflow, /npm test/);
});
