import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { assertIsolatedPath, buildCommandDiagnostics } from "./diagnostics.js";
import { recordCommandInvocation, writeState } from "./state.js";
import { registerTeardownCallback } from "./teardown.js";

const FORBIDDEN_WORKSPACE_ARTIFACTS = [
  "registry.json",
  ".env",
  "CLAUDE.local.md",
  "scripts/usage-report-loop.sh",
  ".claude",
  ".codex",
];

const FIXTURE_TOOLS = new Set(["claude", "tmux", "zsh", "python3", "jq", "whisper"]);
const HOST_WRAPPERS = new Map([
  ["cat", "/bin/cat"],
  ["chmod", "/bin/chmod"],
  ["dirname", "/usr/bin/dirname"],
  ["mkdir", "/bin/mkdir"],
]);

function sourceRoot() {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || "Unable to resolve git root");
  }
  return result.stdout.trim();
}

function gitTrackedFiles(root) {
  const result = spawnSync("git", ["ls-files", "-z"], {
    cwd: root,
    encoding: "buffer",
  });
  if (result.status !== 0) {
    throw new Error(result.stderr.toString("utf8") || "Unable to list tracked files");
  }
  return result.stdout.toString("utf8").split("\0").filter(Boolean);
}

function rejectForbiddenTrackedArtifacts(files) {
  const forbidden = files.filter((file) =>
    FORBIDDEN_WORKSPACE_ARTIFACTS.some((artifact) => file === artifact || file.startsWith(`${artifact}/`)),
  );
  if (forbidden.length > 0) {
    throw new Error(`Tracked local-only artifacts are not allowed in E2E workspaces: ${forbidden.join(", ")}`);
  }
}

function copyTrackedFiles(root, repoDir, files) {
  for (const file of files) {
    const source = path.join(root, file);
    const destination = path.join(repoDir, file);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
    fs.chmodSync(destination, fs.statSync(source).mode);
  }
}

function assertWorkspaceClean(repoDir) {
  const present = FORBIDDEN_WORKSPACE_ARTIFACTS.filter((artifact) => fs.existsSync(path.join(repoDir, artifact)));
  if (present.length > 0) {
    throw new Error(`Local-only artifacts leaked into Test Workspace: ${present.join(", ")}`);
  }
}

function writeExecutable(file, content) {
  fs.writeFileSync(file, content);
  fs.chmodSync(file, 0o755);
}

function createFixtureBin(fixtureDir, name) {
  writeExecutable(
    path.join(fixtureDir, name),
    `#!/bin/sh
echo "$0 $*" >> "$CCDM_TEST_STATE/${name}.log"
exit 0
`,
  );
}

function createHostWrapper(fixtureDir, name, target) {
  if (!fs.existsSync(target)) {
    return;
  }
  writeExecutable(
    path.join(fixtureDir, name),
    `#!/bin/sh
exec ${target} "$@"
`,
  );
}

function createFixtures(fixtureDir, options = {}) {
  fs.mkdirSync(fixtureDir, { recursive: true });
  const exclude = new Set(options.excludeFixtures ?? []);
  for (const tool of FIXTURE_TOOLS) {
    if (!exclude.has(tool)) {
      createFixtureBin(fixtureDir, tool);
    }
  }
  for (const [name, target] of HOST_WRAPPERS) {
    if (!exclude.has(name)) {
      createHostWrapper(fixtureDir, name, target);
    }
  }
}

function nodePath(root) {
  return path.join(root, "node_modules");
}

export const createWorkspace = Object.freeze(function createWorkspace(options = {}) {
  const root = sourceRoot();
  const files = gitTrackedFiles(root);
  rejectForbiddenTrackedArtifacts(files);

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ccdm-e2e-"));
  const repoDir = path.join(tmpRoot, "repo");
  const homeDir = path.join(tmpRoot, "home");
  const tmpDir = path.join(tmpRoot, "tmp");
  const stateDir = path.join(tmpRoot, "state");
  const fixtureDir = path.join(tmpRoot, "fixtures");
  fs.mkdirSync(repoDir, { recursive: true });
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });

  copyTrackedFiles(root, repoDir, files);
  assertWorkspaceClean(repoDir);
  createFixtures(fixtureDir, options);
  writeState(undefined, stateDir);

  const workspace = Object.freeze({
    env: Object.freeze({
      CCDM_TEST_STATE: stateDir,
      HOME: homeDir,
      NODE_OPTIONS: "",
      NODE_PATH: nodePath(root),
      PATH: fixtureDir,
      TMPDIR: tmpDir,
    }),
    fixtureDir,
    homeDir,
    repoDir,
    sourceRoot: root,
    stateDir,
    tmpDir,
    tmpRoot,
  });

  registerTeardownCallback(() => {
    fs.rmSync(tmpRoot, { force: true, recursive: true });
  });

  return workspace;
});

function buildEnv(workspace, extraEnv = {}) {
  return {
    ...workspace.env,
    ...extraEnv,
  };
}

function runProcess(workspace, command, args, options = {}) {
  assertIsolatedPath(workspace, workspace.homeDir);
  assertIsolatedPath(workspace, workspace.tmpDir);
  const env = buildEnv(workspace, options.env);
  const cwd = options.cwd ?? workspace.repoDir;
  const child = spawn(command, args, {
    cwd,
    detached: true,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (options.input) {
    child.stdin.end(options.input);
  } else {
    child.stdin.end();
  }

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        // The process may have already exited.
      }
    }, options.timeoutMs ?? 5000);

    child.on("close", (exitCode, signal) => {
      clearTimeout(timeout);
      const result = {
        command: [command, ...args],
        cwd,
        detached: true,
        env,
        exitCode,
        signal,
        stderr,
        stdout,
      };
      recordCommandInvocation(result, { stateDir: workspace.stateDir });
      result.diagnostics = buildCommandDiagnostics(result, workspace);
      resolve(result);
    });
  });
}

export const runScript = Object.freeze(async function runScript(workspace, relativeScript, options = {}) {
  const script = path.join(workspace.repoDir, relativeScript);
  return runProcess(workspace, script, [], options);
});

export const runNodeEntrypoint = Object.freeze(async function runNodeEntrypoint(workspace, relativeScript, options = {}) {
  const script = path.join(workspace.repoDir, relativeScript);
  return runProcess(workspace, process.execPath, [script, ...(options.args ?? [])], options);
});

export const runnerInternals = Object.freeze({
  FORBIDDEN_WORKSPACE_ARTIFACTS,
});
