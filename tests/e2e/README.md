# CCDM Local-Fake E2E Harness

Run the default suite with:

```sh
npm test
npm run test:e2e
```

Both commands execute:

```sh
node --test --test-concurrency=1 tests/e2e/**/*.test.js
```

## Harness Architecture

The harness uses Node's built-in `node:test` runner. Each scenario creates an isolated Test Workspace with `createWorkspace()`, runs executable CCDM surfaces with `runScript()` or `runNodeEntrypoint()`, and coordinates fixture state through `$CCDM_TEST_STATE`.

Test Workspaces are assembled from tracked files only. The workspace builder refuses tracked local-only artifacts and asserts that `registry.json`, `.env`, `CLAUDE.local.md`, `.claude`, `.codex`, and ignored usage-loop content are absent from the copied repo.

## Helper Contracts

`createWorkspace()` returns frozen paths and an injected environment containing `cwd`, `HOME`, allowlisted `PATH`, `TMPDIR`, `NODE_OPTIONS`, `NODE_PATH`, and `$CCDM_TEST_STATE`.

`runScript()` spawns shell scripts from the Test Workspace in a detached process group with the injected environment and optional `args`. `runNodeEntrypoint()` does the same for Node entrypoints through `process.execPath`.

The teardown manager exposes `registerTeardownCallback(fn)` and `cleanup()`. Callbacks run idempotently in LIFO order on normal test cleanup and through process-level handlers for assertion failure, uncaught exception, unhandled rejection, `SIGINT`, `SIGTERM`, and process exit. Cleanup failures are recorded in fixture diagnostics.

## Fixture State

`$CCDM_TEST_STATE/state.json` uses schema version `1`:

```json
{
  "schemaVersion": 1,
  "commands": [],
  "diagnostics": {
    "cleanupFailures": [],
    "logs": [],
    "protectedPathViolations": []
  },
  "fixtures": {
    "processes": [],
    "registry": null,
    "tmux": { "sessions": {} }
  },
  "snapshots": []
}
```

State helpers reload from disk on every read and write updates through atomic write-then-rename. Public helpers are `readState`, `writeState`, `seedRegistry`, `seedFixtureProcess`, `seedTmuxSession`, `recordCommandInvocation`, `snapshotFiles`, and `cleanup`.

## Fixture Ownership

Scenario `PATH` contains only harness-owned fixture binaries and approved host wrappers. Missing required tools fail fast rather than falling through to the developer's original `PATH`.

The tmux/process fixture contract covers the Claude start surface:

- `tmux has-session` returns the current fixture session state with production-compatible exit codes.
- `tmux new-session -d -s <name> -- zsh -ic <command>` validates the Claude Discord launch shape, records the session command, cwd, environment, pane output, and a harness-owned placeholder PID.
- `tmux capture-pane` returns recorded pane output, and `tmux send-keys` is recorded so tests can assert the current start surface does not send trust-dialog keys.
- `ps axeww -o pid=,command=` and `pgrep -P <pid>` expose only rows owned by the current `$CCDM_TEST_STATE`; fabricated or foreign PID rows in fixture state are omitted.
- The Claude fixture supports `claude --version`, validates `--channels plugin:discord...` listener invocations, records the invocation, and writes fixture session metadata under fixture `HOME/.claude/sessions`.

## Diagnostics

Command results include command metadata, cwd, redacted environment, stdout, stderr, exit code, signal, fixture state, and file snapshots. Diagnostics redact token-shaped strings, OAuth tokens, Discord bot tokens, registry token fields, `.env` values, command lines, request bodies, and `Authorization` headers.

## Isolation

Runtime guards fail on attempted access to the developer checkout registry, real `~/.claude`, real `~/.codex`, real tmux, real Keychain (`security`), and unapproved global temp files. Concrete Discord, npm, OAuth, and network egress guards are added by later slices when those fakes are introduced.

## Live Gate

Live smoke tests are skipped unless all of the following are true:

- `CCDM_LIVE_E2E=1`
- `CCDM_LIVE_DISCORD_BOT_TOKEN` is set
- `CCDM_LIVE_DISCORD_CHANNEL_ID` is set
- `CCDM_LIVE_DISCORD_USER_ID` is set

The default CI suite never requires live credentials.
