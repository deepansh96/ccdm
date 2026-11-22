import { spawn } from "node:child_process";
import test from "node:test";

import { fixtureWorkspace, recordStart } from "./workspace.js";

recordStart("hang");
fixtureWorkspace();

// A child of the file, so the test can check the timeout kill takes the tree.
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
process.stderr.write(`runner-fixture-child ${child.pid}\n`);

test("runner fixture never finishes", async () => {
  await new Promise(() => setInterval(() => {}, 1000));
});
