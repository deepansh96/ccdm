import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { bridgeChildEnv } from "./support/bridge.js";
import { createWorkspace, runNodeEntrypoint } from "./support/runner.js";
import { readState, writeState } from "./support/state.js";
import { cleanup } from "./support/teardown.js";

test.afterEach(cleanup);

test("exports an inclusive Discord message range and downloads attachments", async () => {
  const workspace = createWorkspace();
  const state = readState(workspace.stateDir);
  state.fixtures.discord.restMessages = [
    { id: "103", timestamp: "2026-07-13T10:02:00.000Z", content: "end", author: { id: "2", username: "Bob" }, attachments: [] },
    { id: "102", timestamp: "2026-07-13T10:01:00.000Z", content: "middle", author: { id: "1", username: "Alice" }, attachments: [{ id: "a1", filename: "notes.txt", url: "https://cdn.discordapp.com/a1" }] },
    { id: "101", timestamp: "2026-07-13T10:00:00.000Z", content: "start", author: { id: "1", username: "Alice" }, attachments: [] },
  ];
  state.fixtures.discord.attachments["https://cdn.discordapp.com/a1"] = { body: "attachment body" };
  writeState(state, workspace.stateDir);

  const result = await runNodeEntrypoint(workspace, "scripts/export-discord-range.js", {
    args: ["100", "101", "103"],
    env: bridgeChildEnv(workspace, { DISCORD_BOT_TOKEN: "bot-token" }),
  });

  assert.equal(result.exitCode, 0, result.stderr);
  const output = result.stdout.trim();
  const text = fs.readFileSync(output, "utf8");
  assert.ok(text.indexOf("start") < text.indexOf("middle"));
  assert.ok(text.indexOf("middle") < text.indexOf("end"));
  assert.match(text, /Message ID: 101/);
  assert.match(text, /Message ID: 103/);
  const attachment = text.match(/^Saved: (.+)$/m)?.[1];
  assert.equal(fs.readFileSync(attachment, "utf8"), "attachment body");
  assert.equal(path.dirname(path.dirname(attachment)), path.dirname(output));
});
