import assert from "node:assert/strict";
import test from "node:test";

import { fixtureWorkspace, recordStart } from "./workspace.js";

recordStart("pass");
fixtureWorkspace();

test("runner fixture passes", () => {
  assert.equal(1 + 1, 2);
});
