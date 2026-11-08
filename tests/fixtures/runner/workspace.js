// Fixture files for tests/e2e/runner-contract.test.js. They live outside
// tests/e2e so the default run never picks them up.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Announces a workspace the way createWorkspace() does, and never removes it:
// the runner under test must.
export function fixtureWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccdm-e2e-"));
  fs.writeFileSync(path.join(dir, "marker"), "runner fixture\n");
  process.stderr.write(`ccdm-e2e-workspace ${dir}\n`);
  return dir;
}

// Appends one line per start, so a test can count runs of a file.
export function recordStart(name) {
  if (process.env.CCDM_RUNNER_FIXTURE_LOG) fs.appendFileSync(process.env.CCDM_RUNNER_FIXTURE_LOG, `${name}\n`);
}
