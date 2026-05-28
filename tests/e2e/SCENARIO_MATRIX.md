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
| Live smoke | Default skip | Covered | Skips unless `CCDM_LIVE_E2E=1` and documented secrets are set. |
| Discord/Codex/curl/npx fakes | Full behavior | Deferred | Later issue #4 slices introduce those executable-surface fakes. |
