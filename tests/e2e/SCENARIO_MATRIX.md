# E2E Scenario Matrix

This matrix is append-only for issue #4 slices. Each slice should add covered scenarios or explicit deferrals without deleting earlier entries.

| Area | Scenario | Status | Notes |
| --- | --- | --- | --- |
| Setup | Prerequisite failure | Covered | Missing fixture tool fails before prompts. |
| Setup | First-run registry and root state creation | Covered | Drives `setup.sh` with local fixture binaries. |
| Setup | Existing registry keep | Covered | Declining overwrite preserves existing JSON. |
| Setup | Existing registry overwrite | Covered | Accepting overwrite writes the current setup schema. |
| Setup | Existing state dir alternate selection | Covered | Declining `.env` overwrite selects `discord2`. |
| Setup | Existing state dir overwrite | Covered | Accepting overwrite reuses default state dir. |
| Setup | Required prompt validation | Covered | Discord user id, guild id, and bot token are required. |
| Setup | Rerun/idempotency | Covered | A second run can keep registry and use an alternate state dir. |
| Setup | Current chmod behavior | Covered | `restart-root-agent.sh` and `scripts/claude-usage.sh`. |
| Harness | Tracked-file Test Workspace | Covered | Local-only artifacts are excluded. |
| Harness | `$CCDM_TEST_STATE` schema and helpers | Covered | Versioned store, reload-on-read, atomic write-rename. |
| Harness | Command runner environment | Covered | `cwd`, `HOME`, `PATH`, `TMPDIR`, `NODE_OPTIONS`, `NODE_PATH`, and state are injected. |
| Harness | Detached shell subprocesses | Covered | `runScript` uses `child_process.spawn({ detached: true })`. |
| Harness | Teardown manager | Covered | LIFO, idempotent cleanup with diagnostic failures. |
| Harness | Allowlisted PATH/no fallthrough | Covered | Missing fixture tools fail without host PATH fallback. |
| Harness | Runtime isolation guards | Covered | Developer registry, real Claude/Codex state, real tmux, Keychain, and global temp paths. |
| Harness | Failure diagnostics/redaction | Covered | Commands, streams, exit code, fixture state, file snapshots, and secret redaction. |
| Fixture contracts | tmux session tracking | Covered | `has-session`, `new-session`, command/env capture, pane output, send-key recording, and current exit-code behavior. |
| Fixture contracts | process ownership | Covered | `ps axeww -o pid=,command=` and `pgrep -P` expose harness-owned rows and omit fabricated or foreign PID state. |
| Fixture contracts | Claude listener | Covered | `--version`, Discord channel argument validation, listener invocation recording, and fixture session metadata. |
| Claude start | Successful Claude launch | Covered | Drives `scripts/start-session.sh`, resolves bot state dir, constructs tmux launch, records PID/session, and emits expected stdout. |
| Claude start | Paths with spaces/quotes | Covered | Project paths with spaces and double quotes are captured through the tmux launch contract. |
| Claude start | Already-running tmux guard | Covered | Existing target tmux session exits successfully without launching another listener. |
| Claude start | Duplicate listener guard | Covered | Existing Claude Discord listener using the same state dir fails before creating the target tmux session. |
| Claude start | Missing project | Covered | Documents current executable `KeyError` failure behavior. |
| Claude start | Malformed registry | Covered | Documents current executable JSON parse failure behavior. |
| Claude start | Missing bot | Covered | Documents current executable `StopIteration` failure behavior. |
| Claude start | Multiple-project non-interference | Covered | Starting one project leaves other project PID/session fields and tmux sessions untouched. |
| Claude start | CLAUDE.md pre-trust/send-key boundary | Covered | `start-session.sh` does not write `.claude.json` or send trust-dialog Enter; that remains manual documented workflow. |
| Codex start | Registry fixture schema | Covered | Codex registries include Discord user/guild values, placeholder bot tokens, app IDs, channel IDs, `type: "codex"`, screen names, `ws_port`, and the current `bot1` root-token invariant. |
| Codex start | Successful bridge launch | Covered | Drives `scripts/start-codex-session.sh`, builds the bridge tmux command, records the bridge PID, and leaves app-server spawning to bridge slices. |
| Codex start | Stale MCP cleanup | Covered | Removes stale `~/.codex/config.toml` `discord-*` MCP blocks while preserving unrelated MCP config. |
| Codex start | Bridge environment construction | Covered | Asserts `BOT_TOKEN`, `CHANNEL_ID`, `PROJECT_DIR`, `WS_PORT`, `ALLOWED_USER_ID`, `GUILD_ID`, `ROOT_BOT_TOKEN`, `BOT_APP_ID`, and `BOT_DISPLAY_NAME` from registry fields. |
| Codex start | Paths with spaces/quotes | Covered | Project paths with spaces and double quotes are captured through `PROJECT_DIR`. |
| Codex start | Already-running tmux guard | Covered | Existing target tmux session exits successfully without launching another bridge. |
| Codex start | Duplicate bridge/app-server guard | Covered | Fixture `ps` rows for matching bridge channel/app ID or app-server port fail before creating the target tmux session. |
| Codex start | Missing project | Covered | Documents current executable `KeyError` failure behavior. |
| Codex start | Malformed registry | Covered | Documents current executable JSON parse failure behavior. |
| Codex start | Missing bot | Covered | Documents current executable `StopIteration` failure behavior. |
| Codex start | Missing `bot1` | Covered | Documents current hardcoded root-token invariant as `StopIteration` failure behavior. |
| Codex start | Duplicate channels/ports | Covered | Documents current behavior: duplicate registry channel/port rows do not block startup unless a matching process exists. |
| Codex start | No package install in Test Workspace | Covered | A fail-closed `npm` fixture plus pre/post workspace inventory proves startup does not run `npm ci` or contact npm. |
| Fixture contracts | stop/restart tmux contracts | Covered | `kill-session`, `display-message '#{pane_pid}'`, retryable root-agent kill attempts, new-session launch failure injection, and trust-dialog `send-keys` recording. |
| Fixture contracts | stop/restart process contracts | Covered | `pgrep -P`, `pkill -TERM -P`, fast fixture `sleep`, and fixture `ps` extend the shared harness-owned process model. |
| Process safety | Shell builtin `kill` boundary | Covered | Tests do not replace shell builtin `kill`; only real harness-owned placeholder PIDs are exposed through fake `ps`/`pgrep`, so production `kill -TERM`/`kill -KILL` cannot receive fabricated or host PIDs. |
| Process safety | Signal ordering limit | Covered | SIGTERM-resistant child coverage proves fallback to SIGKILL by observable process death; exact shell builtin `kill` call ordering is not intercepted and remains a documented black-box limit. |
| Stop session | Claude happy path | Covered | Drives `scripts/stop-session.sh`, stops the recorded process tree, kills the tmux session, and clears PID/session registry metadata. |
| Stop session | Codex happy path | Covered | Drives `scripts/stop-session.sh` with seeded Codex registry and bridge process state, then clears registry metadata. |
| Stop session | Recorded-PID ownership skip | Covered | A host/unowned recorded PID is skipped while registry cleanup still occurs. |
| Stop session | Already stopped project | Covered | Missing tmux and listener state exits successfully and clears registry metadata. |
| Stop session | Orphan listener sweep | Covered | Remaining Claude listeners, Codex bridge processes, and Codex app-server processes are found through fixture process state and terminated. |
| Stop session | SIGTERM-resistant child fallback | Covered | A harness-owned child that ignores SIGTERM is removed by the stop script's SIGKILL fallback. |
| Stop session | Missing Codex sweep fields | Covered | Missing channel, port, or app id skips the Codex listener sweep and documents the stderr warning. |
| Root restart | Existing root cleanup and retry | Covered | Simulates `root_agent`, pane PID lookup, child `pkill`, first kill failure, retry, fresh launch, fast background sleep, and `send-keys Enter`. |
| Root restart | Launch failure diagnostics | Covered | Injected tmux `new-session` failure returns non-zero with command diagnostics and fixture state. |
| Root restart | Teardown failure diagnostics | Covered | Cleanup failure after restart is recorded under fixture diagnostics. |
| Live smoke | Default skip | Covered | Skips unless `CCDM_LIVE_E2E=1` and documented secrets are set. |
| Discord/Codex/curl/npx fakes | Full behavior | Deferred | Later issue #4 slices introduce those executable-surface fakes. |
