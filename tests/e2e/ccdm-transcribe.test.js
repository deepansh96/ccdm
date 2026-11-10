// `scripts/ccdm transcribe <audio path>`: root's voice step on both OSes.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { assertPrivate, privateTempRoot } from "./support/platform.js";
import { createWorkspace, runScript } from "./support/runner.js";
import { readState, writeState } from "./support/state.js";
import { cleanup } from "./support/teardown.js";

test.afterEach(cleanup);

const WIN = process.platform === "win32";

function audioFile(workspace, name = "voice-message.ogg") {
  const file = path.join(workspace.tmpDir, name);
  fs.writeFileSync(file, "fixture audio body");
  return file;
}

function transcribe(workspace, args) {
  return runScript(workspace, "scripts/ccdm", { args: ["transcribe", ...args], timeoutMs: 30000 });
}

// The whisper- directories under the private temp root.
function whisperDirs(workspace) {
  const root = privateTempRoot(workspace);
  return fs.existsSync(root) ? fs.readdirSync(root).filter(name => name.startsWith("whisper-")) : [];
}

function valueOf(args, flag) {
  return args[args.indexOf(flag) + 1];
}

test("transcribe prints the transcript whisper wrote into a private temp directory and removes it", async () => {
  const workspace = createWorkspace();
  const seed = readState(workspace.stateDir);
  seed.fixtures.whisper.transcriptions["voice message (1).ogg"] = "please add audio support";
  writeState(seed, workspace.stateDir);
  // A path with spaces and brackets, quoted as the runbook quotes it.
  const audio = audioFile(workspace, "voice message (1).ogg");

  const result = await transcribe(workspace, [audio]);

  assert.equal(result.exitCode, 0, result.stderr);
  // One line, ended as this OS ends a line of text.
  assert.deepEqual(result.stdout.split(/\r?\n/), ["please add audio support", ""]);
  const invocations = readState(workspace.stateDir).fixtures.whisper.invocations;
  assert.equal(invocations.length, 1);
  const [{ args, inputExists }] = invocations;
  assert.equal(inputExists, true);
  assert.equal(args[0], audio);
  assert.deepEqual(args.slice(1, 7), ["--model", "turbo", "--language", "en", "--output_format", "txt"]);
  const outputDir = valueOf(args, "--output_dir");
  assert.equal(path.dirname(outputDir), privateTempRoot(workspace));
  assert.match(path.basename(outputDir), /^whisper-/);
  assert.equal(fs.existsSync(outputDir), false);
  assert.deepEqual(whisperDirs(workspace), []);
  if (WIN) assertPrivate(privateTempRoot(workspace));
});

test("transcribe exits 3 with `whisper not found` when whisper is not installed", async () => {
  const workspace = createWorkspace({ excludeFixtures: ["whisper"] });

  const result = await transcribe(workspace, [audioFile(workspace)]);

  assert.equal(result.exitCode, 3, result.stderr);
  assert.match(result.stderr, /whisper not found/);
  assert.equal(result.stdout, "");
  assert.deepEqual(whisperDirs(workspace), []);
});

test("transcribe reports a whisper failure, prints no transcript and removes the directory", async () => {
  const workspace = createWorkspace();
  const seed = readState(workspace.stateDir);
  seed.fixtures.whisper.failures.transcribe = "fixture whisper failure";
  writeState(seed, workspace.stateDir);

  const result = await transcribe(workspace, [audioFile(workspace)]);

  assert.equal(result.exitCode, 1, result.stderr);
  assert.match(result.stderr, /fixture whisper failure/);
  assert.match(result.stderr, /whisper exited with code 3/);
  assert.equal(result.stdout, "");
  assert.deepEqual(whisperDirs(workspace), []);
});

test("transcribe refuses a path that is not a file before it starts whisper", async () => {
  const workspace = createWorkspace();

  const result = await transcribe(workspace, [path.join(workspace.tmpDir, "missing.ogg")]);

  assert.equal(result.exitCode, 2, result.stderr);
  assert.match(result.stderr, /no audio file at /);
  assert.equal(readState(workspace.stateDir).fixtures.whisper.invocations.length, 0);
  assert.deepEqual(whisperDirs(workspace), []);
});

test("transcribe --help exits 0 and starts nothing", async () => {
  const workspace = createWorkspace();

  const result = await transcribe(workspace, ["--help"]);

  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout, /usage: ccdm transcribe/);
  assert.equal(readState(workspace.stateDir).fixtures.whisper.invocations.length, 0);
  assert.deepEqual(whisperDirs(workspace), []);
});
