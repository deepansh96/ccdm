import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import test from "node:test";

const CONPTY_PACKAGES = ["node-pty", "@xterm/headless", "@xterm/addon-unicode11", "@xterm/addon-serialize"];

test("the ConPTY packages are exact-version optional dependencies", () => {
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
  const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));
  for (const name of CONPTY_PACKAGES) {
    assert.match(pkg.optionalDependencies[name] ?? "", /^\d+\.\d+\.\d+$/, name);
    assert.equal(pkg.dependencies[name], undefined, name);
    const locked = lock.packages[`node_modules/${name}`];
    assert.equal(locked.version, pkg.optionalDependencies[name], name);
    assert.equal(locked.optional, true, name);
  }
});

test("loading the host's modules does not load the ConPTY packages", () => {
  const hide = `
    const Module = require("node:module");
    const load = Module._load;
    const names = ${JSON.stringify(CONPTY_PACKAGES)};
    Module._load = function (request, ...rest) {
      if (names.includes(request)) throw new Error("loaded " + request);
      return load.call(this, request, ...rest);
    };
    require("./scripts/host/pty.js");
    require("./scripts/host/server.js");
  `;
  const result = spawnSync(process.execPath, ["-e", hide], { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
});

test("package.json exposes the parallel local-fake e2e suite and its serialized fallback", () => {
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));

  assert.equal(pkg.engines.node, ">=22.5");
  assert.equal(pkg.scripts.test, "node tests/run-e2e.mjs");
  assert.equal(pkg.scripts["test:e2e"], "node tests/run-e2e.mjs");
  assert.equal(pkg.scripts["test:serial"], "node --test --test-concurrency=1 tests/e2e/**/*.test.js");
});
