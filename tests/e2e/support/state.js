import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const STATE_SCHEMA_VERSION = 1;

function stateDir(explicitStateDir) {
  const dir = explicitStateDir ?? process.env.CCDM_TEST_STATE;
  if (!dir) {
    throw new Error("CCDM_TEST_STATE is required");
  }
  return dir;
}

function stateFile(explicitStateDir) {
  return path.join(stateDir(explicitStateDir), "state.json");
}

function initialState() {
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    commands: [],
    diagnostics: {
      cleanupFailures: [],
      logs: [],
      protectedPathViolations: [],
    },
    fixtures: {
      claude: {
        invocations: [],
      },
      codex: {
        appServerInvocations: [],
        bridgeInvocations: [],
      },
      npm: {
        invocations: [],
      },
      processes: [],
      registry: null,
      tmux: {
        sessions: {},
      },
    },
    snapshots: [],
  };
}

function normalizeState(value) {
  return {
    ...initialState(),
    ...value,
    schemaVersion: STATE_SCHEMA_VERSION,
    commands: value?.commands ?? [],
    diagnostics: {
      ...initialState().diagnostics,
      ...(value?.diagnostics ?? {}),
    },
    fixtures: {
      ...initialState().fixtures,
      ...(value?.fixtures ?? {}),
      claude: {
        invocations: value?.fixtures?.claude?.invocations ?? [],
      },
      codex: {
        appServerInvocations: value?.fixtures?.codex?.appServerInvocations ?? [],
        bridgeInvocations: value?.fixtures?.codex?.bridgeInvocations ?? [],
      },
      npm: {
        invocations: value?.fixtures?.npm?.invocations ?? [],
      },
      tmux: {
        sessions: value?.fixtures?.tmux?.sessions ?? {},
      },
    },
    snapshots: value?.snapshots ?? [],
  };
}

export function readState(explicitStateDir) {
  const file = stateFile(explicitStateDir);
  if (!fs.existsSync(file)) {
    return initialState();
  }
  return normalizeState(JSON.parse(fs.readFileSync(file, "utf8")));
}

export function writeState(nextState, explicitStateDir) {
  const dir = stateDir(explicitStateDir);
  fs.mkdirSync(dir, { recursive: true });
  const file = stateFile(dir);
  const tmp = path.join(dir, `.state.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, `${JSON.stringify(normalizeState(nextState), null, 2)}\n`);
  fs.renameSync(tmp, file);
  return readState(dir);
}

function updateState(explicitStateDir, updater) {
  const current = readState(explicitStateDir);
  const next = updater(current) ?? current;
  return writeState(next, explicitStateDir);
}

export function seedRegistry(workspaceOrRegistry, maybeRegistry) {
  const workspace = maybeRegistry === undefined ? null : workspaceOrRegistry;
  const registry = maybeRegistry === undefined ? workspaceOrRegistry : maybeRegistry;
  if (workspace?.repoDir) {
    fs.writeFileSync(path.join(workspace.repoDir, "registry.json"), `${JSON.stringify(registry, null, 2)}\n`);
  }
  return updateState(workspace?.stateDir, (state) => {
    state.fixtures.registry = registry;
    return state;
  });
}

export function seedFixtureProcess(processRow, options = {}) {
  return updateState(options.stateDir, (state) => {
    state.fixtures.processes.push({ ...processRow });
    return state;
  });
}

export function seedTmuxSession(name, session = {}, options = {}) {
  return updateState(options.stateDir, (state) => {
    state.fixtures.tmux.sessions[name] = { name, ...session };
    return state;
  });
}

export function recordCommandInvocation(invocation, options = {}) {
  return updateState(options.stateDir, (state) => {
    state.commands.push({
      at: new Date().toISOString(),
      ...invocation,
    });
    return state;
  });
}

function sha256(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function walkFiles(root, relative = "") {
  const absolute = path.join(root, relative);
  if (!fs.existsSync(absolute)) {
    return [];
  }
  const stat = fs.statSync(absolute);
  if (stat.isFile()) {
    return [relative];
  }
  if (!stat.isDirectory()) {
    return [];
  }
  return fs.readdirSync(absolute).flatMap((entry) => walkFiles(root, path.join(relative, entry)));
}

export function snapshotFiles(root, files, options = {}) {
  const selected = files ?? walkFiles(root);
  const snapshot = Object.fromEntries(
    selected
      .filter((file) => fs.existsSync(path.join(root, file)) && fs.statSync(path.join(root, file)).isFile())
      .map((file) => {
        const content = fs.readFileSync(path.join(root, file));
        return [file, { bytes: content.byteLength, sha256: sha256(content) }];
      }),
  );
  updateState(options.stateDir, (state) => {
    state.snapshots.push({
      at: new Date().toISOString(),
      root,
      files: snapshot,
    });
    return state;
  });
  return snapshot;
}

export function recordDiagnostic(kind, value, options = {}) {
  return updateState(options.stateDir, (state) => {
    if (!Array.isArray(state.diagnostics[kind])) {
      state.diagnostics[kind] = [];
    }
    state.diagnostics[kind].push(value);
    return state;
  });
}
