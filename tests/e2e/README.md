# CCDM Local-Fake E2E Harness

## Run Commands

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

Test Workspaces are assembled from tracked files only. The workspace builder refuses tracked local-only artifacts and asserts that `registry.json`, `.env`, `CLAUDE.local.md`, `.claude`, and `.codex` are absent from the copied repo.

## Public Helper APIs

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
    "curl": {
      "requests": [],
      "routes": []
    },
    "discord": {
      "attachmentFetches": [],
      "attachments": {},
      "channelCacheGets": [],
      "channelFetches": [],
      "deliveredMessages": [],
      "edits": [],
      "failures": {},
      "fetches": [],
      "injectedMessages": [],
      "logins": [],
      "malformedRequests": [],
      "messageFetches": [],
      "messages": [],
      "nicknamePatches": [],
      "reactions": [],
      "ready": [],
      "restFailureUses": [],
      "restFailures": [],
      "restMessages": [],
      "sends": [],
      "typing": [],
      "uploadFailures": [],
      "uploads": []
    },
    "network": { "blocked": [] },
    "npm": { "invocations": [] },
    "npx": { "invocations": [] },
    "processes": [],
    "security": {
      "credentials": {},
      "invocations": []
    },
    "registry": null,
    "tmux": { "sessions": {} }
  },
  "snapshots": []
}
```

State helpers reload from disk on every read and write updates through atomic write-then-rename. Public helpers are `readState`, `writeState`, `seedRegistry`, `seedFixtureProcess`, `seedTmuxSession`, `recordCommandInvocation`, `snapshotFiles`, and `cleanup`.

## Fixture Contracts and Local Fakes

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

- `tmux new-session -d -s <name> -- zsh -ic <command>` validates the bridge launch shape and records `CODEX_HOME`, `BOT_TOKEN`, `CHANNEL_ID`, `PROJECT_DIR`, `WS_PORT`, `ALLOWED_USER_ID`, `GUILD_ID`, `ROOT_BOT_TOKEN`, `BOT_APP_ID`, and `BOT_DISPLAY_NAME`.
- Codex startup tests seed registries with `type: "codex"`, `ws_port`, optional `codex_home`, placeholder bot tokens, app IDs, channel IDs, Discord user/guild values, and the current `bot1` root-token invariant.
- The fixture records only the bridge command construction. App-server spawning and WebSocket protocol behavior belong to later Codex bridge scenarios.
- The `npm` fixture fails closed and records invocations so startup scenarios can prove Test Workspaces do not run package installation or contact npm.

## Approved Dependency Resolution

Dependencies are installed only in the source checkout before the suite runs. Test Workspaces do not run `npm ci`, do not contact the npm registry, and do not use the developer's original `PATH`.

Child processes resolve approved real dependencies such as `ws` through the injected `NODE_PATH`. Workspace-local module overlays provide fake `discord.js` and `form-data` packages for the executable surfaces under test. This keeps real package resolution explicit while preserving Local Fakes for Discord gateway, REST, CDN, upload, Codex app-server, tmux, process, Keychain, curl, npm, and npx boundaries.

## Child-Scoped JavaScript Interception

The Codex bridge/basic-turn scenarios add child-scoped JavaScript interception. This extends ADR-0002's fixture-binary strategy for Node-only boundaries that cannot be reached through `PATH`:

- `createBridgeWorkspace()` installs a temp-workspace `discord.js` overlay and `bridgeChildEnv()` injects `NODE_OPTIONS=--require <workspace>/tests/e2e/support/preload.cjs` only into child processes under test. The harness process keeps `NODE_OPTIONS` empty.
- The preload replaces `globalThis.fetch`, fails closed for unexpected `http`, `https`, and `net` egress, allows only the local WebSocket upgrade for the scenario `WS_PORT`, and routes Discord member nickname PATCHes plus Discord CDN attachment fetches into fixture state.
- The `discord.js` shim exports `Client`, `GatewayIntentBits`, and `Partials`, records login/ready/channel fetch/typing/send behavior, and consumes test-injected gateway messages from `$CCDM_TEST_STATE`.
- `startFakeCodexServer()` owns the fake Codex WebSocket protocol. It covers `initialize`/`initialized`, MCP status/delete/write/reload, `thread/start`, system and user `turn/start`, active-turn `turn/steer`, `thread/compact/start`, `thread/archive`, approval requests, agent deltas, MCP reply detection, context-compaction completion, token-usage notifications, WebSocket close, and startup no-thread-id failure.
- The `codex` fixture validates `app-server --listen ws://127.0.0.1:<port>`, requires a harness-owned fake server for that port, records the invocation, and stays alive until the bridge exits.
- Bridge control-flow scenarios cover successful steer, stale-turn queue fallback, queued reaction cleanup, `/compact`, `/clear`, compact/clear during an active turn, non-retryable Codex errors, MCP cleanup/registration failures, and command diagnostics.
- Attachment scenarios cover empty messages, image URLs, fetched text attachments, binary downloads into `.discord-attachments`, attachment fetch failures, and Discord send failures. The Discord shim can reject `channel.send()` through fixture state so tests can assert the bridge's current failure diagnostics.

The Discord MCP JSON-RPC scenarios drive `scripts/discord-mcp-server.js` directly through stdin/stdout with the same child-scoped preload:

- The fake Discord REST store covers `POST/PATCH/GET /channels/:channel/messages`, `PUT /reactions/:emoji/@me`, single-message attachment lookup, scripted 400/401/403/404/429/5xx API failures, and CDN attachment downloads.
- `tests/e2e/support/form-data-shim.cjs` is installed by the preload as the workspace-local `form-data` package so dynamic `import("form-data")` resolves without the real dependency. Its `FormData.prototype.submit()` implementation routes Discord uploads into fixture state and blocks non-Discord submit targets as `form-data` egress.
- MCP tests cover `initialize`, `notifications/initialized`, `tools/list`, unknown methods, malformed JSON input, missing env, and each public tool: `reply`, `edit_message`, `react`, `fetch_messages`, and `download_attachment`.
- Reply coverage includes empty text, missing files, reply references, upload success/failure, and the current behavior that advertised 10-file and 25MB limits are not locally enforced before upload.
- Fetch/download coverage includes limit capping and bad negative limits, attachment default index, out-of-range and negative indexes, missing attachments, absolute save directories, filesystem writes, CDN failures, and blocked network egress.

The Claude usage-report scenarios drive `scripts/claude-usage.sh` with fixture home data and local-fake external boundaries:

- Fixture home data covers `~/.claude/stats-cache.json`, `history.jsonl`, and session JSON files. Scenarios assert lifetime totals, last-seven-days date logic, current/longest streaks, project history parsing, session listing, and corrupt session JSON tolerance.
- The `security` fixture supports `find-generic-password -s "Claude Code-credentials" -w`, records invocations, and returns test-seeded OAuth keychain JSON. Missing credentials make the script exercise its current graceful no-auth path.
- The `curl` fixture records method, URL, path, query, headers, and body under `$CCDM_TEST_STATE`, matches extensible route entries by method/hostname/path/url, supports JSON and raw-body response modes, and blocks unapproved targets as network egress.
- OAuth profile and usage routes are faked through `https://api.anthropic.com/api/oauth/{profile,usage}`. Malformed API responses are covered as current graceful warning behavior.
- Scheduled Discord usage posting is handled outside the default E2E suite by a local LaunchAgent documented in `CLAUDE.local.md`. The removed tmux usage-loop scripts are no longer part of the tracked executable surface.

The nickname/statusline scenarios drive `scripts/cc-discord-nicknames.sh`, `scripts/cc-statusline-wrapper.sh`, and their shared `_update-nickname.sh` helper:

- Project sessions read the fixture root bot token from fixture `HOME/.claude/channels/discord/.env`, resolve the project bot app id through the fixture registry, and send `PATCH /api/v10/guilds/:guild/members/:appId` through the shell-level fake `curl`.
- Root-like sessions whose state dir has no registry app id send `PATCH /api/v10/guilds/:guild/members/@me` with the session bot token. Scripted fake-curl failures are recorded without making the wrapper fail, matching the current background-subshell behavior.
- Skip scenarios cover `DISABLE_DISCORD_MESSAGE=true`, missing `DISCORD_STATE_DIR`, and missing `context_window.used_percentage`.
- Rate-limit scenarios use unique fixture Discord state directory basenames so the production hardcoded `/tmp/cc-context-<state>` files do not collide across tests. The files are cleaned up explicitly after each scenario because this path is not redirected by fixture `TMPDIR`.
- `cc-statusline-wrapper.sh` pipes stdin JSON to the `npx` fixture as `npx -y ccstatusline@latest`; the fixture returns deterministic output and blocks unapproved package execution without npm network access.
- Shell-level fake `curl` routing is separate from JS-level Discord interception: these shell scripts use the fixture binary on `PATH`, while bridge and MCP tests route Discord REST and gateway behavior through the child-scoped preload and JavaScript shims.

The stop/restart surfaces add these process-safety assumptions:

- `scripts/stop-session.sh` is driven as a black-box script. Tests do not intercept shell builtin `kill`; safety comes from fake `ps` and `pgrep` exposing only real harness-owned placeholder PIDs.
- Stop scenarios cover Claude and Codex happy paths, recorded-PID ownership skips, already-stopped projects, orphan listener sweeps, SIGTERM-resistant child fallback to SIGKILL, missing Codex sweep fields, and registry cleanup.
- `restart-root-agent.sh` is exercised against fixture `root_agent` tmux state, including pane PID lookup, `pkill`, retry after a failed `kill-session`, fresh launch, fast background sleep, trust-dialog `send-keys`, launch failure diagnostics, and teardown failure diagnostics.
- Signal ordering is asserted by observable outcomes: owned processes are gone after stop/restart. Exact shell builtin `kill -TERM` versus `kill -KILL` call ordering is intentionally not intercepted in the black-box harness.
- General command teardown also sweeps detached process groups created by `runScript()` and waits up to 5 seconds after SIGTERM before SIGKILL, which covers background shell/curl/sleep/npx work left by statusline and restart-style scripts.

## Diagnostics

Command results include command metadata, cwd, redacted environment, stdout, stderr, exit code, signal, fixture state, and file snapshots. Diagnostics redact env values, headers, registry values, `.env` files, command lines, request bodies, OAuth tokens, Discord bot tokens, token-shaped strings, and `Authorization` headers before attaching failure context.

## Test Workspace Isolation

Runtime guards fail on attempted access to the developer checkout registry, real `~/.claude`, real `~/.codex`, real tmux, real Keychain (`security`), and unapproved global temp files. Bridge scenarios also fail closed on unexpected Discord, CDN, `fetch`, `http`, `https`, and `net` egress. Usage-report scenarios additionally fail closed on unapproved `curl` targets, including missed OAuth routes.

## Live Gate

Live smoke tests are skipped unless all of the following are true:

- `CCDM_LIVE_E2E=1`
- `CCDM_LIVE_DISCORD_BOT_TOKEN` is set
- `CCDM_LIVE_DISCORD_CHANNEL_ID` is set
- `CCDM_LIVE_DISCORD_USER_ID` is set

The default CI suite never requires live credentials.

All documented live secrets must be non-empty before a live smoke test may run. Issue #4 does not require a live-smoke scenario matrix; live coverage remains a narrow opt-in drift check for real boundaries.

## CI Behavior

GitHub Actions runs the Default CI Suite on `push` and `pull_request` with Node 22, `npm ci`, zsh, python3, jq, and `npm test`. CI executes the same local-fake command shown above and does not require live Discord, Claude, Codex, tmux, Keychain, OAuth, or npm-network credentials during scenario execution.

## Hardcoded-Boundary Inventory

- `/tmp/cc-context-<state>` nickname files are created by the production nickname helper outside fixture `TMPDIR`. Tests use unique state directory basenames, assert the boundary, and clean the files explicitly.
- Shell builtin `kill` is not intercepted. Stop/restart tests constrain fake process discovery to harness-owned placeholder PIDs and assert observable process cleanup instead of command-order internals.

## Extraction Follow-Ups

Instruction-only root-agent workflows are outside issue #4 until they are extracted into deterministic executable surfaces. Follow-up extraction work should cover register, deregister, pool management, polls, and context report. Those workflows remain documented root-agent conversation behavior, not Default CI Suite coverage.

## Adding Scenarios

Add scenarios through public executable surfaces and harness helpers. Start with one behavior in `node:test`, use a fresh Test Workspace by default, seed fixture state through public helpers, and assert observable outputs such as exit status, stdout/stderr, registry changes, fixture state, fake Discord requests, or diagnostics.

When adding coverage, update `tests/e2e/SCENARIO_MATRIX.md` with either a `Covered` row naming the scenario or a `Deferred` row with the reason and follow-up. Keep Local Fakes as the default boundary, use child-scoped `NODE_OPTIONS` only for child processes under test, and document any new hardcoded boundary that cannot be redirected safely.
