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
| JS interception | Child-scoped preload | Covered | Bridge tests inject `NODE_OPTIONS=--require <preload.cjs>` only into child processes and keep harness `NODE_OPTIONS` empty. |
| JS interception | Closed egress guard | Covered | Preload blocks unexpected `fetch`, `http`, `https`, and `net` egress while allowing only the scenario-local WebSocket upgrade. |
| Fixture contracts | Discord shim exports and gateway injection | Covered | Temp overlay provides `discord.js` `Client`, `GatewayIntentBits`, and `Partials`, records login/ready, and emits injected gateway messages. |
| Fixture contracts | Unified fake Discord store | Covered | Records login, ready, channel cache/fetches, typing, sends, injected/delivered gateway messages, attachment CDN fetches, nickname PATCHes, malformed requests, and configured failures. |
| Fixture contracts | Fake Codex app-server protocol | Covered | Covers startup ordering, `initialize`/`initialized`, MCP status/delete/write/reload, thread start, system/user turns, deltas, MCP reply detection, token usage, WebSocket close, and no-thread-id timeout. |
| Fixture contracts | Fake Codex active-turn protocol | Covered | Covers `thread/compact/start`, context-compaction completion, `thread/archive`, successful and failed `turn/steer`, and approval request responses. |
| Fixture contracts | `ws` dependency resolution | Covered | Bridge fixture self-test proves `ws` resolves from harness `NODE_PATH` before launching the bridge. |
| Codex bridge | Boot and MCP registration | Covered | Drives `scripts/codex-bridge.js` with fake Codex app-server, writes/reloads `discord-channel-id`, and removes stale `discord-*` MCP config. |
| Codex bridge | Login success/failure | Covered | Successful boot records Discord login/ready; configured login rejection exits the bridge. |
| Codex bridge | Channel cache/fetch paths | Covered | Covers cache-hit boot and cache-miss fetch with recorded channel fetch state. |
| Codex bridge | Filtering | Covered | Bot-authored, wrong-channel, and wrong-user injected messages do not start user turns or send replies. |
| Codex bridge | One allowed text turn | Covered | Injected user text starts a Codex turn, records typing, and sends fallback Discord text from agent deltas. |
| Codex bridge | Fallback splitting and MCP suppression | Covered | 2001-character fallback output splits into 2000/1 chunks; a detected Discord MCP reply suppresses fallback text. |
| Codex bridge | Process exit paths | Covered | App-server exit, WebSocket close, and startup without thread id terminate the bridge with observable diagnostics. |
| Codex bridge | Token-usage nickname PATCH | Covered | Token usage notifications route to fake Discord member PATCH and record the computed nickname. |
| Codex bridge | Active-turn controls | Covered | Covers approval responses, successful steer, stale-turn failed steer fallback, queued hourglass reaction cleanup, and typing shutdown after completion. |
| Codex bridge | Slash controls | Covered | Covers `/compact`, `/clear`, context-compaction completion, archive/new-thread flow, and compact/clear while a turn is active. |
| Codex bridge | Error and MCP diagnostics | Covered | Covers non-retryable Codex errors, typing shutdown after failure, stale MCP removal warning/continue behavior, MCP registration fatal diagnostics, and Discord send failure diagnostics. |
| Codex bridge | Attachment input construction | Covered | Covers empty messages, image URLs, fetched text attachments, binary downloads into `.discord-attachments`, failed attachment fetches, and fallback Discord response behavior. |
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
| Discord MCP | JSON-RPC lifecycle | Covered | Drives `scripts/discord-mcp-server.js` through stdin/stdout for `initialize`, `notifications/initialized`, `tools/list`, unknown methods, malformed JSON input, and missing env. |
| Discord MCP | Reply/edit/react/fetch tools | Covered | Covers text replies with references, empty-text file replies, missing files, edit, react, fetch limit capping, and bad negative limits. |
| Discord MCP | Download attachment tool | Covered | Covers default index, explicit index, out-of-range and negative indexes, missing attachments, absolute save directories, filesystem writes, CDN failures, and blocked network failures. |
| Discord MCP | Fake REST API failures | Covered | Scripted fake Discord REST failures propagate 400, 401, 403, 404, 429 including rate-limit body, and 5xx as MCP error content. |
| Fixture contracts | FormData upload shim | Covered | Preload installs a workspace-local `form-data` shim whose `FormData.prototype.submit()` routes uploads through fake Discord and blocks missed non-Discord egress. |
| Discord MCP | Advertised file count/size limits | Covered | Current executable behavior advertises 10 files and 25MB each but does not enforce those limits locally; tests document that uploads still proceed before Discord/fake enforcement. |
| Fixture contracts | Keychain fixture | Covered | `security find-generic-password -s "Claude Code-credentials" -w` records invocations and returns seeded OAuth keychain JSON without touching real Keychain. |
| Fixture contracts | Route-based curl fixture | Covered | Records method, URL path, headers, body, JSON/raw response modes, Anthropic OAuth route guards, and blocked unapproved network targets. |
| Claude usage | Live profile and usage success | Covered | Drives `scripts/claude-usage.sh` with fake OAuth profile/usage responses and fake `claude --version`. |
| Claude usage | Missing auth | Covered | Missing Keychain credential gracefully skips profile/usage and records no curl requests. |
| Claude usage | Malformed API responses | Covered | Invalid profile/usage JSON keeps current warning behavior without failing the report. |
| Claude usage | Missing local stats | Covered | Missing `stats-cache.json` exits successfully after the documented historical-data skip warning. |
| Claude usage | Local stats summaries | Covered | Fixture `stats-cache.json` covers lifetime totals, daily averages, this-week, this-month, monthly breakdown, busiest days, day-of-week distribution, and streaks. |
| Claude usage | History and sessions | Covered | Fixture `history.jsonl` and session JSON files cover project counts, session listing, and corrupt session JSON tolerance. |
| Claude usage | Relative date logic | Covered | Stats fixture around the current test date asserts last-seven-days inclusion and current/longest streak behavior. |
| Usage loop template | Static safety boundary | Covered | `scripts/usage-report-loop.sh.example` uses placeholder channel/token values, fakeable `security`/`claude`/`curl`/`sleep` commands, and documented fixed `/tmp/usage_report_*` files. |
| Usage loop template | Ignored live-loop execution | Deferred | The ignored `scripts/usage-report-loop.sh` is not copied into Test Workspaces and remains out of scope until a safe tracked executable exists. |
| Fixture contracts | `npx` no-network guard | Covered | Fake `npx -y ccstatusline@latest` returns deterministic statusline output, records stdin/args, and blocks unapproved package execution without network access. |
| Fixture contracts | Discord nickname curl PATCH | Covered | Fake `curl` parses shell-level `PATCH /api/v10/guilds/:guild/members/:member`, records method, URL, headers, and body, and mirrors entries into the unified fake Discord nickname store. |
| Nickname/statusline | Project app-id PATCH path | Covered | `cc-statusline-wrapper.sh` reads fixture root `.env`, resolves the project app id from registry state, records the app-id member PATCH, and returns deterministic `ccstatusline` output. |
| Nickname/statusline | Root `@me` PATCH path | Covered | A state dir with no matching registry app id sends the root-style member `@me` PATCH using the session `.env` token. |
| Nickname/statusline | Skip guards | Covered | Disabled Discord messages, missing `DISCORD_STATE_DIR`, and missing context percentage exit successfully without curl requests. |
| Nickname/statusline | Fake curl failures | Covered | Scripted non-zero fake-curl PATCH results are recorded while wrappers preserve current background-subshell success behavior. |
| Nickname/statusline | Rate-limit skip/send | Covered | First context update sends, immediate repeated update with the same unique state basename is skipped by the production rate-limit file. |
| Nickname/statusline | Hardcoded `/tmp` context files | Covered | Tests use unique `DISCORD_STATE_DIR` basenames, assert the current `/tmp/cc-context-<state>` boundary, and clean those files explicitly. |
| Nickname/statusline | Shell curl vs JS Discord interception | Covered | README documents that nickname scripts use the shell-level fake `curl`, while bridge/MCP Discord behavior uses child-scoped JS preload/shims. |
