import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { createWorkspace, runScript } from "./support/runner.js";
import { readState, writeState } from "./support/state.js";
import { cleanup } from "./support/teardown.js";

test.afterEach(async () => {
  await cleanup();
});

const plistPath = (workspace) =>
  path.join(workspace.homeDir, "Library", "LaunchAgents", "com.discord.usage-stats-poster.plist");

test("usage stats poster installer is a tracked executable surface", () => {
  const installer = path.join("scripts", "install-usage-stats-poster.sh");

  assert.ok(fs.existsSync(installer));
  assert.ok(fs.statSync(installer).mode & 0o111);
});

test("installer renders a secret-free LaunchAgent with the default interval", async () => {
  const workspace = createWorkspace();
  const result = await runScript(workspace, "scripts/install-usage-stats-poster.sh");

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  const resolvedRepoDir = fs.realpathSync(workspace.repoDir);
  const resolvedTmpDir = fs.realpathSync(workspace.tmpDir);
  const expected = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
<key>Label</key>
<string>com.discord.usage-stats-poster</string>
<key>ProgramArguments</key>
<array>
<string>${path.join(workspace.fixtureDir, "python3")}</string>
<string>${path.join(resolvedRepoDir, "scripts", "usage-stats-poster.py")}</string>
</array>
<key>StartInterval</key>
<integer>1800</integer>
<key>EnvironmentVariables</key>
<dict>
<key>CCDM_CODEX_PATH</key>
<string>${path.join(workspace.fixtureDir, "codex")}</string>
<key>PATH</key>
<string>${workspace.fixtureDir}:/usr/bin:/bin</string>
</dict>
<key>StandardOutPath</key>
<string>${path.join(resolvedTmpDir, "usage-stats-poster.log")}</string>
<key>StandardErrorPath</key>
<string>${path.join(resolvedTmpDir, "usage-stats-poster.err")}</string>
</dict>
</plist>
`;
  assert.equal(fs.readFileSync(plistPath(workspace), "utf8"), expected);
  assert.doesNotMatch(expected, /fixture-(root|oauth)-token|fixture-channel|\.usage-stats-poster\.json/);
});

test("installer applies an interval override, replaces the agent, and reports logs without posting", async () => {
  const workspace = createWorkspace();
  const result = await runScript(workspace, "scripts/install-usage-stats-poster.sh", {
    args: ["--interval", "900"],
  });

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /LaunchAgent 'com\.discord\.usage-stats-poster' loaded/);
  assert.match(result.stdout, /LaunchAgent state:.*com\.discord\.usage-stats-poster/);
  assert.match(result.stdout, /Standard output log: .*usage-stats-poster\.log/);
  assert.match(result.stdout, /Standard error log: .*usage-stats-poster\.err/);
  assert.match(fs.readFileSync(plistPath(workspace), "utf8"), /<integer>900<\/integer>/);

  const state = readState(workspace.stateDir);
  assert.deepEqual(state.fixtures.launchctl.invocations, [
    { operation: "list", target: "com.discord.usage-stats-poster" },
    { operation: "unload", target: plistPath(workspace) },
    { operation: "load", target: plistPath(workspace) },
    { operation: "list", target: "com.discord.usage-stats-poster" },
  ]);
  assert.deepEqual(state.fixtures.discord.fetches, []);
  assert.deepEqual(state.fixtures.discord.sends, []);
});

test("installer is idempotent when reinstalling the same LaunchAgent", async () => {
  const workspace = createWorkspace();
  const first = await runScript(workspace, "scripts/install-usage-stats-poster.sh", {
    args: ["--interval", "900"],
  });
  assert.equal(first.exitCode, 0, first.stderr || first.stdout);
  const firstPlist = fs.readFileSync(plistPath(workspace), "utf8");

  const second = await runScript(workspace, "scripts/install-usage-stats-poster.sh", {
    args: ["--interval", "900"],
  });

  assert.equal(second.exitCode, 0, second.stderr || second.stdout);
  assert.equal(fs.readFileSync(plistPath(workspace), "utf8"), firstPlist);
  assert.deepEqual(
    readState(workspace.stateDir).fixtures.launchctl.invocations.map(({ operation }) => operation),
    ["list", "unload", "load", "list", "list", "unload", "load", "list"],
  );
});

test("failed reload restores the prior plist and loaded schedule", async () => {
  const workspace = createWorkspace();
  const first = await runScript(workspace, "scripts/install-usage-stats-poster.sh", {
    args: ["--interval", "1800"],
  });
  assert.equal(first.exitCode, 0, first.stderr || first.stdout);
  const priorPlist = fs.readFileSync(plistPath(workspace), "utf8");

  const state = readState(workspace.stateDir);
  state.fixtures.launchctl.loadFailuresRemaining = 1;
  writeState(state, workspace.stateDir);

  const result = await runScript(workspace, "scripts/install-usage-stats-poster.sh", {
    args: ["--interval", "900"],
  });

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /restored the previous schedule/);
  assert.equal(fs.readFileSync(plistPath(workspace), "utf8"), priorPlist);
  assert.deepEqual(readState(workspace.stateDir).fixtures.launchctl.loaded, ["com.discord.usage-stats-poster"]);
  assert.deepEqual(
    readState(workspace.stateDir).fixtures.launchctl.invocations.map(({ operation }) => operation),
    ["list", "unload", "load", "list", "list", "unload", "load", "unload", "load"],
  );
  assert.deepEqual(fs.readdirSync(path.dirname(plistPath(workspace))), ["com.discord.usage-stats-poster.plist"]);
  assert.deepEqual(readState(workspace.stateDir).fixtures.discord.sends, []);
});

test("invalid rendered plist fails before launchctl replacement", async () => {
  const workspace = createWorkspace();
  const templatePath = path.join(workspace.repoDir, "scripts", "com.discord.usage-stats-poster.plist.in");
  fs.writeFileSync(templatePath, fs.readFileSync(templatePath, "utf8").replace("<integer>__INTERVAL__</integer>", "<integer>invalid</integer>"));

  const result = await runScript(workspace, "scripts/install-usage-stats-poster.sh");

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /rendered LaunchAgent plist is invalid/);
  assert.deepEqual(readState(workspace.stateDir).fixtures.launchctl.invocations, []);
  assert.equal(fs.existsSync(plistPath(workspace)), false);
});

test("setup does not install the opt-in Usage Stats Poster LaunchAgent", async () => {
  const workspace = createWorkspace();
  const result = await runScript(workspace, "setup.sh", {
    input: "fixture-user\nfixture-guild\nfixture-root-token\n",
  });

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.deepEqual(readState(workspace.stateDir).fixtures.launchctl.invocations, []);
});
