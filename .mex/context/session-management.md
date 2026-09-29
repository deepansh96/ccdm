---
name: session-management
description: Registry schema and lifecycle rules for Claude and Codex project sessions.
triggers:
  - "start session"
  - "stop session"
  - "register project"
  - "deregister"
  - "tmux"
edges:
  - target: context/architecture.md
    condition: when the end-to-end session flow is needed
  - target: context/discord-security.md
    condition: when lifecycle work changes bot permissions or allowlists
  - target: patterns/manage-session.md
    condition: when performing a start, stop, or restart
  - target: patterns/register-project.md
    condition: when assigning or releasing a project bot
last_updated: 2026-09-29
---

# Session Management

## Registry

`registry.json` contains `pool`, `projects`, `discord_user_id`, `guild_id`, and shared permission configuration. Pool records contain bot identity, token, state directory, and assignment. Project records contain path, bot ID, channel ID, tmux `screen_name`, session `type`, PID/session state, guest IDs, and optional account/model overrides.

Never print tokens. Treat missing project `type` as `claude`. Use exact tmux targets (`=<screen_name>`) and expand home paths before comparing them.

## Claude Lifecycle

Use `scripts/start-session.sh <project>`. It resolves the assigned state directory, rejects duplicate tmux/listener processes, launches Claude through `zsh -ic`, and records PID/session ID. Optional `claude_home` selects `CLAUDE_CONFIG_DIR`; `model` and `claude_effort` set the listener's `--model` and `--effort` flags. Supported effort values are `low`, `medium`, `high`, `xhigh`, and `max`. Missing, null, or empty effort uses the default; other values are rejected before field splitting, MCP config creation, or launch.

A `transport: "router"` Claude project needs no pool bot. `start-session.sh` writes a fresh 0600 launch key at `<router state>/keys/<project>.key` (revoking the previous launch), a secret-free MCP config and settings under `<router state>/launches/<project>/`, and launches `claude --dangerously-load-development-channels server:ccdm` with only the key file path (`CCDM_ROUTER_KEY_FILE`) in its environment: no `DISCORD_STATE_DIR`, token, or supplementary read-only Discord MCP. The `scripts/ccdm-channel-server.js` channel server says hello to the Router, turns Router `message`/`reaction` events into channel notifications with the plugin's attachment metadata (and shows the bot typing on each message, as the plugin does), and forwards `reply` (files, `reply_to` jump link), `react`, `edit_message`, `fetch_messages`, and the supplementary MCP's `read_last_x_messages_in_channel` and `export_message_range` (same arguments and result lines) to Router operations. `download_attachment(chat_id, message_id)` asks the Router for each attachment's signed URL and downloads it itself into the private inbox `<router state>/inbox/<project>/` (0700, files 0600, named `<epoch ms>-<attachment id>.<ext>`), returning the plugin's `downloaded N attachment(s):` lines. Router errors such as `scope_violation` come back to Claude as `<tool> failed: <code> <message>` tool errors. Instead of PATCHing a nickname, the statusline scripts (`_update-nickname.sh`, keyed on `CCDM_ROUTER_KEY_FILE`) write the latest context percentage to a 0600 `<router state>/launches/<project>/context.json` on every render, and the channel server sends it as `context_pct` on each `reply` and `edit_message`, so replies post as `<project>-claude · N%`; a missing or unreadable file omits `context_pct` and the suffix is dropped. Each launch removes the previous launch's `context.json`. The launcher accepts the per-launch development-channel confirmation by sending Enter to the tmux pane, then records the PID only after the channel server reports `hello_ok`; a confirmation that never appears or a failed hello (bounded by `CCDM_CLAUDE_LAUNCH_TIMEOUT_S`, default 60 s) kills the tmux session, removes the key and launch files, and exits non-zero. `stop-session.sh` finds router listeners by that key file path, removes the key and launch files, and the Router then marks the channel's messages 💤. Plain `/pause`, `/unpause`, `/compact`, `/clear`, and `/restart` from the owner or a channel guest arrive as Router `command` events that the channel server runs itself, never as a Claude turn, acknowledging each like the Codex bridge (a reaction, then a short reply): `/compact` and `/clear` are typed into the project's own tmux pane through `scripts/send-claude-command.sh`, `/pause` holds inbound messages and reactions in memory until `/unpause` delivers them in order, and `/restart` runs `stop-session.sh` then `start-session.sh` for that project only (never root) from a backgrounded subshell that outlives the stopped session, logging to `$TMPDIR/ccdm-restart-<project>.log`; the relaunch writes a new launch key.

Claude slash commands from project channels are relayed by the root bot through `scripts/send-claude-command.sh`; they are tmux keystrokes, not protocol calls.

## Codex Lifecycle

Use `scripts/start-codex-session.sh <project>`. It validates the target project's named `codex_account` or legacy `codex_home` selector and the applicable top-level `codex_accounts`/`default_codex_account` or legacy selector through the shared resolver before stale MCP cleanup, tmux creation, or PID recording, then passes the resolved channel, guild, bot, allowlist, home, model, and WebSocket configuration to `codex-bridge.js`, which owns `codex app-server`. Project precedence is project named/raw selector, top-level default named/raw selector, then `~/.codex`; a same-scope named/raw conflict or unknown alias fails before lifecycle mutation. The root bridge uses the same resolver for `ROOT_CODEX_HOME`, then the top-level named/raw selector, ambient `CODEX_HOME`, then `~/.codex`, and validates the selection before tearing down `root_agent`. Model overrides use `codex_model`, `codex_reasoning_effort`, and `codex_service_tier`.

After a Codex CLI upgrade, stop every long-lived CCDM Codex session before starting any replacement, then restart the root Codex bridge. Running app-server processes keep their original runtime version.

A ChatGPT-account home can only run the models listed in that home's `models_cache.json`, which the app-server refreshes at startup against the running CLI's client version. Requesting anything else fails at the backend with `The '<model>' model is not supported when using Codex with a ChatGPT account.` That message also appears when the installed CLI is simply older than the model's release: `gpt-6-sol` was rejected on 0.153.4 and worked immediately after `npm install -g @openai/codex@latest` (0.155.1), which then listed `gpt-6-sol`/`gpt-6-luna` in the refreshed catalog. Confirm the slug against a live home's catalog before writing `codex_model` rather than guessing from a display name.

MiMo API accounts use the same named-account selection and launch path. `scripts/setup-codex-mimo.py` creates an external home with a private `api-key`, provider auth command, and Xiaomi model catalog; it does not mutate registry selectors. Add the home as a `codex_accounts` alias and select it only on the intended project. Omit incompatible GPT model/service-tier overrides. The provider reads credentials from its home, so no MiMo key is passed through tmux command arguments. `--rotate-key` replaces only the private credential; restart affected sessions afterward. MiMo API quota reporting is outside the ChatGPT usage dashboard's scope.

DeepSeek Flash homes follow the same selection and authentication flow through `scripts/setup-codex-deepseek.py`. Its catalog uses standard Responses and shell-command tools, not MiMo's Responses-lite/code-mode metadata. The helper extracts the vendor's literal catalog without executing its installer; only `deepseek-flash` is selected (V4.1 Flash as of 2026-09-22). Image support does not itself configure Computer Use tools, and usage reporting shows account-wide DeepSeek balance separately from local Codex token totals.

Root multi-channel sessions accept steering only from the active channel and author, reusing the active turn's Discord scope token so in-flight tool calls stay valid. Messages from other channels/authors queue until the turn finishes. Failed steering queues the original message with its own scope for the next turn. Steering was verified live with DeepSeek Flash through app-server; this behavior is provider-independent.

Codex channels handle `/compact`, `/clear`, and `/restart` directly in the bridge.

For an explicit history-preserving restart, use `scripts/start-codex-session.sh <project> --resume <thread_uuid>`. This resumes only at startup; `/clear` still creates a fresh thread. A resume launch requires the fresh Discord instruction request to be accepted and waits up to 60 seconds for listener readiness before reporting success. Failure or timeout returns nonzero and uses the common stop script to clean up listeners and registry runtime state instead of silently creating a new conversation. To change accounts while preserving history, identify and verify the current rollout's thread ID and project directory, stop the old session through the common stop script, copy that rollout into the target home's corresponding `sessions/` path without overwriting an existing file, update only the project's account selector, and start with `--resume`. Keep the original rollout and account selection for recovery. Credentials are never copied. Verify the resumed thread ID, selected process home, and channel listener. In-flight processes do not survive the restart.

## Stop Invariant

`scripts/stop-session.sh <project>` is the common teardown path: kill the recorded process tree, kill the exact tmux session, sweep listener processes by assignment identity, then clear `pid` and `session_id`. Do not replace this with only `tmux kill-session`; orphan listeners have caused duplicate processing.

## Registration

A Router project's registration instead creates the channel, runs `scripts/router.js ensure-webhook <project>`, and writes the entry with `transport: "router"` and no bot assignment or renaming; its deregistration runs `scripts/router.js delete-webhook <project>` and removes the entry. Pool registration claims the first free pool bot, writes a project entry, applies Discord channel isolation, writes bot/root access files, and starts the selected session. Deregistration performs full teardown, removes overrides/roles/access entries, resets the bot name, releases the pool record, and deletes the project entry. Both workflows then run `scripts/conversation-reminder-service.py assignment-changed --project <project>`, which retires the old reminder generation, deletes its recorded reminders at once with the retired bot (reporting any it cannot delete as inaccessible), and writes a fresh `assignment_generation` for a registered project; see `docs/conversation-reminders.md`.

Codex startup enumerates all MCP status pages (`data`, with legacy `servers`/`items` compatibility) and waits for the scoped Discord `reply` tool before creating/resuming the thread. `CODEX_MCP_READY_TIMEOUT_MS` defaults to 30000. Bootstrap is configuration-only and explicitly forbids tools or Discord writes. It stays tracked until completion; `CODEX_BOOTSTRAP_TIMEOUT_MS` defaults to 60000, after which the bridge pauses, requests interruption, and fails startup rather than declaring a still-running turn idle. Failed bootstrap completions also fail startup. Discord transport must use exposed MCP tools, never shell-launched replacements.
