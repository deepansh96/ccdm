import path from "node:path";

import { readState, recordDiagnostic, snapshotFiles } from "./state.js";

const SECRET_KEYS = /(?:TOKEN|AUTHORIZATION|PASSWORD|SECRET|OAUTH|DISCORD_BOT_TOKEN|BOT_TOKEN|ROOT_BOT_TOKEN)/i;
const SECRET_VALUE = /(?:Bot\s+)?(?:mfa\.)?[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,}|(?:sk-ant-|ghp_|xoxb-)[A-Za-z0-9_-]+/g;

export function redactSecrets(value) {
  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        SECRET_KEYS.test(key) ? "[REDACTED]" : redactSecrets(item),
      ]),
    );
  }
  if (typeof value === "string") {
    return value.replace(SECRET_VALUE, "[REDACTED]");
  }
  return value;
}

export function buildCommandDiagnostics(result, workspace) {
  return redactSecrets({
    command: result.command,
    cwd: result.cwd,
    env: result.env,
    exitCode: result.exitCode,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
    fixtureState: workspace?.stateDir ? readState(workspace.stateDir) : null,
    fileDiffs: workspace?.repoDir
      ? snapshotFiles(workspace.repoDir, ["registry.json"], { stateDir: workspace.stateDir })
      : null,
  });
}

export function recordProtectedPathViolation(workspace, targetPath, reason) {
  const violation = {
    reason,
    targetPath,
  };
  recordDiagnostic("protectedPathViolations", violation, { stateDir: workspace?.stateDir });
  const diagnostic = buildCommandDiagnostics(
    {
      command: ["isolation-guard", targetPath],
      cwd: workspace?.repoDir,
      env: workspace?.env,
      exitCode: 99,
      signal: null,
      stdout: "",
      stderr: `Protected path access denied: ${targetPath}`,
    },
    workspace,
  );
  const error = new Error(`Protected path access denied: ${targetPath}`);
  error.diagnostics = diagnostic;
  throw error;
}

export function assertIsolatedPath(workspace, targetPath) {
  const resolved = path.resolve(targetPath);
  const protectedPaths = [
    path.join(workspace.sourceRoot, "registry.json"),
    path.join(process.env.HOME ?? "", ".claude"),
    path.join(process.env.HOME ?? "", ".codex"),
  ].filter(Boolean);

  if (protectedPaths.some((protectedPath) => resolved === protectedPath || resolved.startsWith(`${protectedPath}${path.sep}`))) {
    recordProtectedPathViolation(workspace, resolved, "protected local state path");
  }

  if (resolved.startsWith("/tmp/") && !resolved.startsWith(`${workspace.tmpRoot}${path.sep}`)) {
    recordProtectedPathViolation(workspace, resolved, "unapproved global temp path");
  }
}

export function assertFixtureExecutable(workspace, executablePath) {
  const resolved = path.resolve(executablePath);
  if (!resolved.startsWith(`${workspace.fixtureDir}${path.sep}`)) {
    recordProtectedPathViolation(workspace, resolved, "real host executable boundary");
  }
}
