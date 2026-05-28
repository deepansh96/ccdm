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
    "codex": {
      "appServerInvocations": [],
      "bridgeInvocations": [],
      "protocolEvents": [],
      "servers": {}
    },
    "discord": {
      "attachmentFetches": [],
      "attachments": {},
      "channelCacheGets": [],
      "channelFetches": [],
      "deliveredMessages": [],
      "failures": {},
      "injectedMessages": [],
      "logins": [],
      "malformedRequests": [],
      "nicknamePatches": [],
      "ready": [],
      "sends": [],
      "typing": []
    },
    "network": { "blocked": [] },
    "npm": { "invocations": [] },
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
- `pkill -TERM -P <pid>` sends SIGTERM only to harness-owned child rows exposed by the same process model.
- `sleep` is a fixture-mode no-op linked to the host `true` binary so background restart paths such as `sleep 8 && tmux send-keys` complete without waiting.
- The Claude fixture supports `claude --version`, validates `--channels plugin:discord...` listener invocations, records the invocation, and writes fixture session metadata under fixture `HOME/.claude/sessions`.

The same tmux/process contract covers the Codex startup surface:

- `tmux new-session -d -s <name> -- zsh -ic <command>` validates the bridge launch shape and records `BOT_TOKEN`, `CHANNEL_ID`, `PROJECT_DIR`, `WS_PORT`, `ALLOWED_USER_ID`, `GUILD_ID`, `ROOT_BOT_TOKEN`, `BOT_APP_ID`, and `BOT_DISPLAY_NAME`.
- Codex startup tests seed registries with `type: "codex"`, `ws_port`, placeholder bot tokens, app IDs, channel IDs, Discord user/guild values, and the current `bot1` root-token invariant.
- The fixture records only the bridge command construction. App-server spawning and WebSocket protocol behavior belong to later Codex bridge scenarios.
- The `npm` fixture fails closed and records invocations so startup scenarios can prove Test Workspaces do not run package installation or contact npm.

The Codex bridge/basic-turn scenarios add child-scoped JavaScript interception:

- `createBridgeWorkspace()` installs a temp-workspace `discord.js` overlay and `bridgeChildEnv()` injects `NODE_OPTIONS=--require <workspace>/tests/e2e/support/preload.cjs` only into child processes under test. The harness process keeps `NODE_OPTIONS` empty.
- The preload replaces `globalThis.fetch`, fails closed for unexpected `http`, `https`, and `net` egress, allows only the local WebSocket upgrade for the scenario `WS_PORT`, and routes Discord member nickname PATCHes plus Discord CDN attachment fetches into fixture state.
- The `discord.js` shim exports `Client`, `GatewayIntentBits`, and `Partials`, records login/ready/channel fetch/typing/send behavior, and consumes test-injected gateway messages from `$CCDM_TEST_STATE`.
- `startFakeCodexServer()` owns the fake Codex WebSocket protocol. It covers `initialize`/`initialized`, MCP status/delete/write/reload, `thread/start`, system and user `turn/start`, agent deltas, MCP reply detection, token-usage notifications, WebSocket close, and startup no-thread-id failure.
- The `codex` fixture validates `app-server --listen ws://127.0.0.1:<port>`, requires a harness-owned fake server for that port, records the invocation, and stays alive until the bridge exits.

The stop/restart surfaces add these process-safety assumptions:

- `scripts/stop-session.sh` is driven as a black-box script. Tests do not intercept shell builtin `kill`; safety comes from fake `ps` and `pgrep` exposing only real harness-owned placeholder PIDs.
- Stop scenarios cover Claude and Codex happy paths, recorded-PID ownership skips, already-stopped projects, orphan listener sweeps, SIGTERM-resistant child fallback to SIGKILL, missing Codex sweep fields, and registry cleanup.
- `restart-root-agent.sh` is exercised against fixture `root_agent` tmux state, including pane PID lookup, `pkill`, retry after a failed `kill-session`, fresh launch, fast background sleep, trust-dialog `send-keys`, launch failure diagnostics, and teardown failure diagnostics.
- Signal ordering is asserted by observable outcomes: owned processes are gone after stop/restart. Exact shell builtin `kill -TERM` versus `kill -KILL` call ordering is intentionally not intercepted in the black-box harness.

## Diagnostics

Command results include command metadata, cwd, redacted environment, stdout, stderr, exit code, signal, fixture state, and file snapshots. Diagnostics redact token-shaped strings, OAuth tokens, Discord bot tokens, registry token fields, `.env` values, command lines, request bodies, and `Authorization` headers.

## Isolation

Runtime guards fail on attempted access to the developer checkout registry, real `~/.claude`, real `~/.codex`, real tmux, real Keychain (`security`), and unapproved global temp files. Bridge scenarios also fail closed on unexpected Discord, CDN, `fetch`, `http`, `https`, and `net` egress. OAuth and richer upload routes are added by later slices when those fakes are introduced.

## Live Gate

Live smoke tests are skipped unless all of the following are true:

- `CCDM_LIVE_E2E=1`
- `CCDM_LIVE_DISCORD_BOT_TOKEN` is set
- `CCDM_LIVE_DISCORD_CHANNEL_ID` is set
- `CCDM_LIVE_DISCORD_USER_ID` is set

The default CI suite never requires live credentials.
