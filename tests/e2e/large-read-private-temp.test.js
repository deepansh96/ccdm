import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { bridgeChildEnv } from "./support/bridge.js";
import { assertPrivate, privateTempRoot } from "./support/platform.js";
import { createWorkspace, runNodeEntrypoint } from "./support/runner.js";
import { updateState } from "./support/state.js";
import { cleanup } from "./support/teardown.js";

test.afterEach(cleanup);

const CHANNEL_ID = "demo-channel";
const DAY_MS = 24 * 60 * 60 * 1000;
const WIN = process.platform === "win32";

async function largeRead(workspace) {
  updateState(workspace.stateDir, (state) => {
    state.fixtures.discord.history ||= {};
    state.fixtures.discord.history[CHANNEL_ID] = Array.from({ length: 150 }, (_, index) => ({
      id: String(1150 - index), channel_id: CHANNEL_ID, timestamp: "2026-09-01T10:00:00.000Z",
      content: `message ${1150 - index}`, author: { id: "owner-id", username: "Owner" }, attachments: [],
    }));
  });
  const result = await runNodeEntrypoint(workspace, "tests/e2e/support/large-read-driver.cjs", {
    args: [CHANNEL_ID, "120"],
    env: bridgeChildEnv(workspace),
  });
  assert.equal(result.exitCode, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function plantDir(root, name, ageDays) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "messages.txt"), "old transcript\n");
  const when = new Date(Date.now() - ageDays * DAY_MS);
  fs.utimesSync(dir, when, when);
  return dir;
}

test("a read over the inline limit lands in the private temp location", async () => {
  const workspace = createWorkspace();

  const result = await largeRead(workspace);

  assert.equal(result.count, 120);
  assert.equal(result.text, undefined);
  assert.equal(path.dirname(path.dirname(result.path)), privateTempRoot(workspace));
  assert.match(path.basename(path.dirname(result.path)), /^discord-recent-/);
  assertPrivate(result.path);
  assert.equal(fs.readFileSync(result.path, "utf8").split("\n").length, 121);
});

test("a large read clears discord-recent directories older than 7 days on Windows and none on POSIX", async () => {
  const workspace = createWorkspace();
  const root = privateTempRoot(workspace);
  const old = plantDir(root, "discord-recent-old", 8);
  const young = plantDir(root, "discord-recent-young", 6);

  const result = await largeRead(workspace);

  assert.equal(fs.existsSync(old), !WIN);
  assert.equal(fs.existsSync(young), true);
  assert.equal(fs.existsSync(result.path), true);
});
