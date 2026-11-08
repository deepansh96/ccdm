import assert from "node:assert/strict";
import test from "node:test";

import { fixtureWorkspace, recordStart } from "./workspace.js";

recordStart("fail");
fixtureWorkspace();

test("runner fixture passes before the failure", () => {
  assert.ok(true);
});

test("runner fixture fails an assert", () => {
  assert.equal(1 + 1, 3);
});
