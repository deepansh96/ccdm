import test from "node:test";

import { fixtureWorkspace, recordStart } from "./workspace.js";

recordStart("crash");
fixtureWorkspace();

test("runner fixture never gets here", () => {});

// Exits outside any test, which node --test reports as a file-level failure.
process.exit(3);
