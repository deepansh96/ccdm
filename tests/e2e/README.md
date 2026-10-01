# CCDM Local-Fake E2E Harness

## Run Commands

Run the default suite with:

```sh
npm test
npm run test:e2e
```

Both run `tests/run-e2e.mjs`, which runs test files in parallel (`CCDM_E2E_JOBS`, default CPU count minus 2), longest first by the previous run's timings. A file that fails under parallel load is rerun alone; if it then passes it is reported as `FLAKY` and the run still succeeds. Pass test files to run only those. `npm run test:serial` runs one file at a time:

```sh
node --test --test-concurrency=1 tests/e2e/**/*.test.js
```

Harness deadlines (`waitFor`, `waitForState`, the `runProcess` kill timer) are multiplied by `CCDM_E2E_TIMEOUT_SCALE` (default 4) so parallel load does not kill healthy runs; a passing test never waits them out. Fixture binaries are built once per content in a shared temp directory and linked into each workspace, and the repo's executable scripts are hard-linked rather than copied: macOS XProtect scans every newly written executable on first run, one at a time, which otherwise serializes parallel files.

## Harness Architecture

The harness uses Node's built-in `node:test` runner. Each scenario creates an isolated Test Workspace with `createWorkspace()`, runs executable CCDM surfaces with `runScript()` or `runNodeEntrypoint()`, and coordinates fixture state through `$CCDM_TEST_STATE`.

Test Workspaces are assembled from Git-visible source files: tracked files plus untracked files that are not ignored. This lets new scripts and tests run before they are committed. The workspace builder refuses local-only artifacts and asserts that `registry.json`, `.env`, `CLAUDE.local.md`, `.claude`, and `.codex` are absent from the copied repo.

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
      "servers": {},
      "stdioInvocations": []
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
- `tmux new-session -d -s <name> -- zsh -ic <command>` validates the Claude Router launch shape (the `server:ccdm` channel with `CCDM_ROUTER_KEY_FILE`, never the official plugin or `DISCORD_STATE_DIR`), records the session command, cwd, environment, and pane output, and runs a fake `claude` that hosts the real channel server.
- `tmux capture-pane` returns recorded pane output, and `tmux send-keys` is recorded so tests can assert the current start surface does not send trust-dialog keys.
- `ps axeww -o pid=,command=` and `pgrep -P <pid>` expose only rows owned by the current `$CCDM_TEST_STATE`; fabricated or foreign PID rows in fixture state are omitted.
- `pkill -TERM -P <pid>` sends SIGTERM only to harness-owned child rows exposed by the same process model.
- `sleep` is a fixture-mode no-op linked to the host `true` binary so background restart paths such as `sleep 8 && tmux send-keys` complete without waiting.
- The Claude fixture supports `claude --version`, validates `server:ccdm` listener invocations, records the invocation, and writes fixture session metadata under fixture `HOME/.claude/sessions` (or the launch's `CLAUDE_CONFIG_DIR`).

The same tmux/process contract covers the Codex startup surface:

- `tmux new-session -d -s <name> -- zsh -ic <command>` validates the Router bridge launch shape and records `CODEX_HOME`, `CCDM_CODEX_PROJECT`, `CCDM_ROUTER_STATE_DIR`, `CCDM_ROUTER_KEY_FILE`, `CCDM_CHANNEL_READY_FILE`, `CHANNEL_ID`, `PROJECT_DIR`, `WS_PORT`, and `ALLOWED_USER_IDS`; no Discord token, bot app id, or bot display name reaches the launch.
- Codex startup tests seed registries with `type: "codex"`, `ws_port`, named `codex_accounts`/ `default_codex_account` fields or optional legacy `codex_home`, channel IDs, and Discord user/guild values. The only (placeholder) bot token is root's, in fixture root Discord state, and only the Router reads it; each launch writes the project's 0600 Router launch key.
- `scripts/resolve-codex-home.py` validates named and legacy selectors and supports the root restart's `ROOT_CODEX_HOME` → top-level named/raw selector → ambient `CODEX_HOME` → `~/.codex` precedence through the same executable surface. It expands `~`, normalizes path components without resolving symlinks, and requires a usable home plus any present `config.toml` before project startup mutates MCP config, or before either launch path mutates tmux or registry state.
- Named-account startup scenarios seed `codex_accounts`, `default_codex_account`, and project `codex_account` selectors, then assert project overrides, Default Codex Account inheritance, root selection, `ROOT_CODEX_HOME` precedence, and registry re-read through the recorded `CODEX_HOME`.
- Named-account failures cover malformed alias maps, null/empty/wrong-typed selectors, same-scope named/raw conflicts, unknown aliases, aliased-home usability, and broken unrelated-project selectors while preserving the existing failure-ordering assertions.
- Fresh setup and registry example scenarios assert generic named-account fields, the absence of the legacy `codex_home` key from fresh output, and placeholder-only values; the operator documentation audit checks the account model, precedence, login, persistence, migration, restart, and rollback guidance. They also assert the one-bot registry shape: fresh `setup.sh` output has `root_channels` and `root_allowed_user_ids` with no pool fields and writes no plugin `access.json`, its printed next steps name `scripts/install-router-service.sh`, `router status`, and `restart-root-agent.sh`, and `registry.example.json` shows a per-project `webhook_id` with no bot tokens.
- Codex resolver scenarios cover null versus malformed selectors, actionable failures for missing/non-directory/inaccessible homes and unusable `config.toml`, broken versus valid symlinks, paths with spaces, unresolved paths, and ignored broken selectors on unrelated projects. Successful scenarios assert the resolved `CODEX_HOME` in the recorded tmux launch; failure scenarios assert no tmux session, MCP cleanup, or PID mutation.
- Root restart scenarios additionally assert ambient fallback, emergency `ROOT_CODEX_HOME` recovery over a broken registry home, current-registry re-read on repeated restarts, and preservation of the existing `root_agent` tmux session and listener process when root validation fails.
- The fixture runs the recorded bridge command against the fake app-server and a real Router so the launch can wait for the bridge's Router hello. App-server protocol behavior belongs to the Codex bridge scenarios.
- The `npm` fixture fails closed and records invocations so startup scenarios can prove Test Workspaces do not run package installation or contact npm.

## Approved Dependency Resolution

Dependencies are installed only in the source checkout before the suite runs. Test Workspaces do not run `npm ci`, do not contact the npm registry, and do not use the developer's original `PATH`.

Child processes resolve approved real dependencies such as `ws` through the injected `NODE_PATH`. Workspace-local module overlays provide fake `discord.js` and `form-data` packages for the executable surfaces under test. This keeps real package resolution explicit while preserving Local Fakes for Discord gateway, REST, CDN, upload, Codex app-server, tmux, process, Keychain, curl, npm, and npx boundaries.

## Child-Scoped JavaScript Interception

The Codex bridge/basic-turn scenarios add child-scoped JavaScript interception. This extends ADR-0002's fixture-binary strategy for Node-only boundaries that cannot be reached through `PATH`:

- `createBridgeWorkspace()` installs a temp-workspace `discord.js` overlay and `bridgeChildEnv()` injects `NODE_OPTIONS=--require <workspace>/tests/e2e/support/preload.cjs` only into child processes under test. The harness process keeps `NODE_OPTIONS` empty.
- The preload replaces `globalThis.fetch`, fails closed for unexpected `http`, `https`, and `net` egress, allows only the local WebSocket upgrade for the scenario `WS_PORT` and Unix-socket connections inside the Test Workspace (such as the Router socket), and routes Discord member nickname PATCHes plus Discord CDN attachment fetches into fixture state.
- The `discord.js` shim exports `Client`, `GatewayIntentBits`, and `Partials`, records login/ready/channel fetch/typing/send behavior, and consumes test-injected gateway messages from `$CCDM_TEST_STATE`.
- `startFakeCodexServer()` owns the fake Codex WebSocket protocol. It covers `initialize`/`initialized`, MCP status/delete/write/reload, `thread/start`, system and user `turn/start`, active-turn `turn/steer`, `thread/compact/start`, `thread/archive`, approval requests, agent deltas, MCP reply detection, context-compaction completion, token-usage notifications, WebSocket close, and startup no-thread-id failure.
- The `codex` fixture validates `app-server --listen ws://127.0.0.1:<port>`, requires a harness-owned fake server for that port, records the invocation, and stays alive until the bridge exits.
- The `codex` fixture also implements the poster's `app-server --stdio` JSON-RPC boundary, records one invocation per selected `CODEX_HOME`, and returns scenario-authored live rate-limit or failure responses.
- Bridge control-flow scenarios cover successful steer, stale-turn queue fallback, queued reaction cleanup, `/compact`, `/clear`, `/restart`, compact/clear during an active turn, non-retryable Codex errors, guarded one-shot recovery from a generic terminal `response.failed`, MCP cleanup/registration failures, and command diagnostics.
- Attachment scenarios cover empty messages, inline image data, fetched text attachments, binary downloads into `.discord-attachments`, attachment fetch failures, and Discord send failures. The Discord shim can reject `channel.send()` through fixture state so tests can assert the bridge's current failure diagnostics.

The Discord MCP JSON-RPC scenarios drive `scripts/discord-mcp-server.js` directly through stdin/stdout with the same child-scoped preload. Every Codex MCP server is a Router client: the scenarios start a real Router serving a router-transport Codex project (its webhook and launch key in place) and give the server `CCDM_ROUTER_KEY_FILE`, `CCDM_CODEX_PROJECT`, and `CHANNEL_ID`, or `CCDM_ROUTER_ROLE=root` with root's key. The server holds no Discord token; stdin stays open until each call's response arrives, since a Router-backed server exits when Codex closes stdin:

- The fake Discord REST store also covers channel webhooks for the Router: `POST/GET /channels/:channel/webhooks` with the bot token, and `POST /webhooks/:id/:token` execute with `wait=true`, username and avatar overrides, and rejection (recorded in `webhookRejections`) of names or usernames containing `discord` or `clyde` or longer than 80 characters. Executed messages are stored in `messages` with their `webhookId` and `username`. Multipart executes (`payload_json` plus `files[n]`) record `uploads`, and content over 2000 characters is rejected. `PATCH /webhooks/:id/:token/messages/:message` edits only that webhook's messages (recorded in `webhookEdits`, username unchanged), `GET /channels/:channel/messages/:message` answers 404 for a sent or injected message that lives in another channel, and `POST /channels/:channel/typing` and reaction `DELETE .../@me` are recorded in `typing` and `reactionDeletes`. Single-message GETs also find seeded `history` messages in their channel, return injected messages' attachments (with `refreshedUrl` standing in for Discord re-signing a stale URL), and are all recorded in `messageFetches`. Scripted `rateLimits` rules (`{ method, path, count, retryAfter, bucket, global }`, `count: null` for a route that never recovers) answer matching requests with Discord's 429 shape (`Retry-After`, `X-RateLimit-Bucket`, `X-RateLimit-Remaining: 0`, `X-RateLimit-Reset-After`, and `X-RateLimit-Global` for global limits) and record each 429 in `rateLimitHits`; unlike `restFailures`, any rule may match, so other routes keep working.
- The fake Discord REST store covers `POST/PATCH/GET /channels/:channel/messages`, `PUT /reactions/:emoji/@me`, single-message attachment lookup, scripted 400/401/403/404/429/5xx API failures, and CDN attachment downloads.
- `tests/e2e/support/form-data-shim.cjs` is installed by the preload as the workspace-local `form-data` package so dynamic `import("form-data")` resolves without the real dependency. Its `FormData.prototype.submit()` implementation routes Discord uploads into fixture state and blocks non-Discord submit targets as `form-data` egress. The Router's own uploads are multipart webhook executes through the fake `fetch`, recorded as `uploads` on the webhook message.
- MCP tests cover `initialize`, `notifications/initialized`, `tools/list`, unknown methods, malformed JSON input, missing env (no Router key file, or a key file without a project), the bridge scope token, root multi-channel mode as the Router root role with a signed channel scope (and its refusal for a project-role server or outside root's Router scope), Claude's read-only mode (only the recent-message reader and range export, using the state-directory token), and each public tool as a Router operation: `reply`, `edit_message`, `react`, `fetch_messages`, `read_last_x_messages_in_channel`, `export_message_range`, and `download_attachment`. Router failures surface as MCP error content `Router <op> failed: <code>` (`invalid_args`, `not_found`, `scope_violation`, `discord_error`, `rate_limited`), with the Discord status in the Router's `op_failed` log line.
- Reply coverage includes empty text, missing files, reply references as webhook jump links, upload success/failure, the Router enforcing the advertised 10-file limit, and the current behavior that the advertised 25MB limit is not locally enforced before upload.
- Fetch/download coverage includes limit capping, the Router's rate-limit retry, a private transcript for 500-message pagination, bad negative limits, attachment default index, out-of-range and negative indexes, missing attachments, absolute save directories, filesystem writes, CDN failures, and blocked network egress.

The Claude usage-report scenarios drive `scripts/claude-usage.sh` with fixture home data and local-fake external boundaries:

- Fixture home data covers `~/.claude/stats-cache.json`, `history.jsonl`, and session JSON files. Scenarios assert lifetime totals, last-seven-days date logic, current/longest streaks, project history parsing, session listing, and corrupt session JSON tolerance.
- The `security` fixture supports `find-generic-password -s "Claude Code-credentials" -w`, records invocations, and returns test-seeded OAuth keychain JSON. Missing credentials make the script exercise its current graceful no-auth path.
- The `curl` fixture records method, URL, path, query, headers, and body under `$CCDM_TEST_STATE`, matches extensible route entries by method/hostname/path/url, supports JSON and raw-body response modes, and blocks unapproved targets as network egress.
- OAuth profile and usage routes are faked through `https://api.anthropic.com/api/oauth/{profile,usage}`. Malformed API responses are covered as current graceful warning behavior.
- The `launchctl` fixture records LaunchAgent `unload`, `load`, and `list` calls under `$CCDM_TEST_STATE`; installer scenarios never touch the real user's LaunchAgents directory.

The tracked `scripts/usage-stats-poster.py` scenarios drive the manual Discord posting surface with the same Test Workspace and Keychain fixture plus a local HTTP fake for Anthropic and Discord:

- The poster reads an ignored root `.usage-stats-poster.json`, derives `registry.json` from the repository location, and posts Claude and configured Codex sections with the root bot token from fixture root Discord state (`ROOT_DISCORD_STATE_DIR`).
- Claude OAuth discovery reports the default login plus valid extra `~/.claude-*` config directories, using each directory's `.claude.json` organization/email label and derived Keychain service; malformed or non-directory candidates are ignored.
- Named Codex Account discovery uses `codex_accounts` with the Default Codex Account first, alphabetical remaining aliases, one query per unique Codex Home, and deterministic shared-home labels. Registries without named accounts fall back to top-level and project Legacy Codex Home overrides; malformed named-account fields fail visibly.
- Valid mixed registries retain named-account ordering, add non-conflicting top-level/project Legacy Codex Homes, and deduplicate shared paths; same-scope named/raw selector conflicts fail visibly.
- Missing or unreadable configured homes remain visible as unavailable. The poster tries live `codex app-server --stdio` rate limits first, renders available full-reset credits, then falls back to recent session JSONL token counts while ignoring corrupt or partial records and marking stale rate-limit/token-count data. It uses registry values only and never discovers `ROOT_CODEX_HOME` from its environment.
- The tracked `.usage-stats-poster.example.json` contains placeholders only. Tests cover config validation, import/help no-I/O behavior, configured Claude API-account transcript cost estimates, Discord field truncation, missing credentials, malformed config, unreachable endpoints, and credential redaction.
- Poster scenarios cover named-account ordering, shared-home deduplication and labeling, legacy fallback, malformed named-account validation, unavailable homes, full-reset metadata, live-rate-limit failure and stale JSONL fallback, corrupt session records, account-specific Claude 401 guidance, and environment isolation.
- `anthropic_base_url` and `discord_base_url` are optional config overrides used only to point default E2E scenarios at the local HTTP fake; production defaults remain the real service URLs.
- `tests/e2e/usage-stats-installer.test.js` drives the opt-in LaunchAgent installer through the `launchctl` fixture and asserts the Python 3 prerequisite and a Pillow-free install, absolute-path plist rendering, secret/config exclusion, the 600-second default (with interval-only overrides), invalid-render refusal, unload-before-load replacement, idempotency, launch-state/log reporting, no automatic Discord post, and unchanged `setup.sh` behavior. Poster scenarios also cover private SQLite history snapshots, UTC 10-minute collection versus UTC 30-minute text Usage Report posts, duplicate ledgers, retention, schema/path safety, malformed utilization, image-read failures, and size-warning suppression.

The nickname/statusline scenarios drive `scripts/cc-discord-nicknames.sh`, `scripts/cc-statusline-wrapper.sh`, and their shared `_update-nickname.sh` helper:

- No session PATCHes a nickname: project and root state directories that still hold bot tokens, a stale registry pool entry, and repeated renders all leave the shell-level fake `curl` and the fake Discord nickname store empty, and write no `/tmp/cc-context-<state>` file.
- Pass-through scenarios cover `DISABLE_DISCORD_MESSAGE=true`, missing `DISCORD_STATE_DIR`, and missing `context_window.used_percentage`.
- Router sessions (`CCDM_ROUTER_KEY_FILE`) write the latest context percentage to their launch directory instead (`router-claude-session.test.js`).
- `cc-statusline-wrapper.sh` pipes stdin JSON to the `npx` fixture as `npx -y ccstatusline@latest`; the fixture returns deterministic output and blocks unapproved package execution without npm network access.
- Shell-level fake `curl` routing is separate from JS-level Discord interception: these shell scripts use the fixture binary on `PATH`, while bridge and MCP tests route Discord REST and gateway behavior through the child-scoped preload and JavaScript shims.

The stop/restart surfaces add these process-safety assumptions:

- `scripts/stop-session.sh` is driven as a black-box script. Tests do not intercept shell builtin `kill`; safety comes from fake `ps` and `pgrep` exposing only real harness-owned placeholder PIDs.
- Stop scenarios cover Claude and Codex happy paths, recorded-PID ownership skips, already-stopped projects, orphan listener sweeps, SIGTERM-resistant child fallback to SIGKILL, missing Codex sweep fields, and registry cleanup.
- `restart-root-agent.sh` is exercised against fixture `root_agent` tmux state, including pane PID lookup, `pkill`, retry after a failed `kill-session`, fresh launch as a Router root client against a real Router, development-channel confirmation `send-keys`, launch failure diagnostics, and teardown failure diagnostics. `router-root-claude.test.js` drives the same launcher with the fake `claude` hosting the real channel server in the root role: `router status` shows root, root-channel messages and project-channel bot mentions reach root only, root's `reply` posts as the bot, no Discord token reaches the session, and a failed hello removes root's key.
- Root's emergency fallback (`router-root-fallback.test.js`) kills the real Router under root Claude and root Codex with a shortened `CCDM_ROOT_FALLBACK_AFTER_MS`: root logs in directly and posts its notice in the primary root channel, only root-channel messages from allowed users reach it (project-channel mentions don't), and after the Router restarts the fake's recorded `destroys` shows the direct client gone before root's `connected_at`, with each message delivered once. The real 2-minute default is asserted there once.
- `restart-root-codex-agent.sh` runs the real Codex bridge in root mode against the fake app-server and a real Router (`router-root-codex.test.js`): `router status` shows root, root-channel messages and project-channel bot mentions reach root Codex only, same-author messages steer while other channels and authors queue, root's `reply` into a project channel posts as the bot, no Discord token reaches the session env, launch files, or bridge MCP config, and a failed hello removes root's key.
- Signal ordering is asserted by observable outcomes: owned processes are gone after stop/restart. Exact shell builtin `kill -TERM` versus `kill -KILL` call ordering is intentionally not intercepted in the black-box harness.
- General command teardown also sweeps detached process groups created by `runScript()` and waits up to 5 seconds after SIGTERM before SIGKILL, which covers background shell/curl/sleep/npx work left by statusline and restart-style scripts.

The Conversation Reminder scenarios drive `scripts/conversation-reminder-service.py`, its provider adapters, and `scripts/install-conversation-reminder-service.sh` as Executable Surfaces:

- The foreground worker runs against the stateful Discord fake in `preload.cjs`. That fake provides per-channel `history` with pagination, reaction membership, nonce-checked sends, deletions, and scripted failures. `CCDM_REMINDER_CLOCK_FILE` is a controllable clock, so expected times come from literal timelines instead of hour-long sleeps.
- The fake Gateway hands each injected message to only one client. Scenarios that need both a coding adapter and the root observer run the adapter while the worker is stopped. The durable event ledger carries its events into the worker's restart reconciliation.
- `conversation-reminder-launchagent.test.js` installs through the `launchctl` fixture, then launches the rendered plist's `ProgramArguments` with its rendered environment. It keeps the harness fixture `PATH` so the worker cannot fall through to host tools. It proves the single-worker lock across supervised and foreground launches, disable and re-enable, private state, and the both-provider reply, reminder, and reply-or-close workflow with stopped coding agents. No scenario loads a real LaunchAgent or contacts Discord.

## One-Bot Router Surfaces

The one-bot model's executables are covered against the real Router and the Contract-Checking Fake Discord (webhooks, `webhook_id` provenance, scripted 429s):

- **Router**: `scripts/router.js serve`, the client library, `router status`, `preflight`, and the `ensure-webhook`, `delete-webhook`, `probe`, and `migrate-root-config` admin commands, driven through the discord.js shim and raw socket frames for adversarial cases (out-of-scope targets, stale keys, wrong versions, malformed frames, observer writes).
- **Router installer**: `scripts/install-router-service.sh` against the `launchctl` Fixture Binary (preflight refusal, secret-free plist, rollback, one lock).
- **Claude channel server**: `scripts/ccdm-channel-server.js` for projects and root under the fake `claude` Fixture Binary.
- **Codex Router mode**: `scripts/codex-bridge.js` for projects and root against the fake app-server.
- **Root fallback**: root's emergency gateway after a killed Router, under a shortened `CCDM_ROOT_FALLBACK_AFTER_MS`.
- **Cutover**: `scripts/migrate-to-router.sh` migrate, verify, automatic rollback, and `--rollback` refusal.
- **Retirement**: `scripts/retire-pool.sh` dry run, refusal while a project is off the Router, and `--apply` side effects in the fake.

The documentation audit (`documentation-audit.test.js`) keeps the README, `CLAUDE.md.example`, `AGENTS.md`, `registry.example.json`, `setup.sh`, and `.mex` on the one-bot model and free of pool bot management instructions.

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

## Live Smoke

`tests/e2e/live-smoke.test.js` mirrors the 2026-09-29 Router feasibility test against real Discord, Claude, and Codex. It detects drift in Discord webhooks and gateway routing, in Claude's development-channel flag and its confirmation prompt, and in the Codex bridge. It does not repeat the local-fake scenarios. The operator runs it by hand from a checkout with `tmux`, `claude`, and `codex` on `PATH` and logged in:

```sh
CCDM_LIVE_DISCORD_BOT_TOKEN=<root bot token> \
CCDM_LIVE_DISCORD_CHANNEL_ID=<any channel in the CCDM server> \
CCDM_LIVE_DISCORD_USER_ID=<owner user id> \
CCDM_LIVE_E2E=1 node --test tests/e2e/live-smoke.test.js
```

- `CCDM_LIVE_DISCORD_CHANNEL_ID` names the guild, and the throwaway channels are created in its category. The root bot needs Manage Channels and Manage Webhooks there.
- The Router drops bot-authored messages, so the owner sends the inbound messages. The test pings the owner in each throwaway channel and waits up to `CCDM_LIVE_OWNER_WAIT_MS` (default 10 minutes) for each one. It waits up to `CCDM_LIVE_REPLY_WAIT_MS` (default 5 minutes) for each agent reply, and `CCDM_LIVE_QUIET_MS` (default 30 seconds) for silence after the mention.
- Optional: `CCDM_LIVE_CODEX_HOME` selects the Codex home, and `CCDM_LIVE_CLAUDE_HOME` becomes the Claude project's `claude_home`. Otherwise the operator's defaults are used.

The test runs the following steps:

1. It copies the Git-visible source into a private `ccdm-live-*` temp directory. The registry, Router state, root `.env`, reminder state, and a private tmux server (`TMUX_TMPDIR`) all live there, so the checkout's `registry.json` and the operator's running sessions are never touched.
2. It starts a real Router (`scripts/router.js serve`) and creates two throwaway text channels (`ccdm-live-claude-*`, `ccdm-live-codex-*`). It gives the `live-claude` and `live-codex` router-transport projects their webhooks through `ensure-webhook`, and connects a root client with a root key.
3. It launches `start-session.sh live-claude` against the real `claude` binary and requires `Channel server connected to the Router`, which prints only after the development-channel confirmation was auto-accepted and the channel server's hello succeeded. It then launches `start-codex-session.sh live-codex` and requires `Bridge connected to the Router`. `router status --json` must list both project sessions with their scopes, and no file under the Router state, reminder state, or workspace may contain the bot token.
4. For each project, the owner sends a message with an attachment. The reply must name the attachment, carry the project's registry `webhook_id`, and appear as `live-claude-claude` or `live-codex-codex` (with an optional ` · N%` suffix).
5. The owner mentions the bot in the Claude channel. The message must reach the root client, and no webhook reply may follow, so the mention reaches root only.
6. Cleanup runs even when an assertion fails, and on `SIGINT`/`SIGTERM`. It stops both sessions, deletes both webhooks, stops the Router, deletes both channels, kills the private tmux server and any process naming the temp directory, and removes the temp directory with its key files and token. The test then fails if any channel or webhook still resolves in Discord or the temp directory remains.

Without the Live Gate the test is reported skipped before it creates anything. `harness-safety.test.js` verifies this with placeholder secrets under the fail-closed preload.

## CI Behavior

GitHub Actions runs the Default CI Suite on `push` and `pull_request` with Node 22, `npm ci`, zsh, python3, jq, and `npm test`. CI executes the same local-fake command shown above and does not require live Discord, Claude, Codex, tmux, Keychain, OAuth, or npm-network credentials during scenario execution.

## Hardcoded-Boundary Inventory

- `/tmp/cc-context-<state>` was the retired nickname rate-limit file outside fixture `TMPDIR`. Tests use unique state directory basenames, assert that no such file is written, and clean up explicitly.
- Shell builtin `kill` is not intercepted. Stop/restart tests constrain fake process discovery to harness-owned placeholder PIDs and assert observable process cleanup instead of command-order internals.

## Extraction Follow-Ups

Instruction-only root-agent workflows are outside issue #4 until they are extracted into deterministic executable surfaces. Follow-up extraction work should cover the conversational steps of register and deregister (their webhook steps are already the executable `router.js ensure-webhook`/`delete-webhook` admin commands), polls, and context report. Those workflows remain documented root-agent conversation behavior, not Default CI Suite coverage.

## Adding Scenarios

Add scenarios through public executable surfaces and harness helpers. Start with one behavior in `node:test`, use a fresh Test Workspace by default, seed fixture state through public helpers, and assert observable outputs such as exit status, stdout/stderr, registry changes, fixture state, fake Discord requests, or diagnostics.

When adding coverage, update `tests/e2e/SCENARIO_MATRIX.md` with either a `Covered` row naming the scenario or a `Deferred` row with the reason and follow-up. Keep Local Fakes as the default boundary, use child-scoped `NODE_OPTIONS` only for child processes under test, and document any new hardcoded boundary that cannot be redirected safely.
