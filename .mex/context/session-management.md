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
last_updated: 2026-09-28
---

# Session Management

## Registry

`registry.json` contains `pool`, `projects`, `discord_user_id`, `guild_id`, and shared permission configuration. Pool records contain bot identity, token, state directory, and assignment. Project records contain path, bot ID, channel ID, tmux `screen_name`, session `type`, PID/session state, guest IDs, and optional account/model overrides.

Never print tokens. Treat missing project `type` as `claude`. Use exact tmux targets (`=<screen_name>`) and expand home paths before comparing them.

## Claude Lifecycle

Use `scripts/start-session.sh <project>`. It resolves the assigned state directory, rejects duplicate tmux/listener processes, launches Claude through `zsh -ic`, and records PID/session ID. Optional `claude_home` selects `CLAUDE_CONFIG_DIR`; `model` and `claude_effort` set the listener's `--model` and `--effort` flags. Supported effort values are `low`, `medium`, `high`, `xhigh`, and `max`. Missing, null, or empty effort uses the default; other values are rejected before field splitting, MCP config creation, or launch.

Every Claude Channel Conversation runs behind the conversation-scoped proxy `scripts/claude-reminder-channel.js`, launched with `--dangerously-load-development-channels server:discord`. It is always on, whether or not `CCDM_CLAUDE_REMINDER_ADAPTER=1` is set. The proxy delivers only the project channel's messages, never those of threads under it, and refuses Discord tools aimed at any other channel. It drops the reserved `/thread`, `/config`, and `/close` commands before they reach the model. A launch settings file disables the official plugin's own unscoped listener. Plain launches use the highest installed official plugin release; only the reminder adapter pins `0.0.4`, and only it adds command hooks and the capability marker. If the plugin lacks any of `reply`, `react`, `edit_message`, `download_attachment`, or `fetch_messages`, the proxy fails closed with no tools and no messages. Claude Code older than `2.1.281` (or outside 2.x) fails the launch before tmux creation or registry changes. Each project needs a one-time development-channel consent in its tmux pane at its next restart after this change; accept it once in the pane.

The proxy also has a thread mode (`CCDM_CLAUDE_THREAD_ID`) that admits only its thread. It refuses tools aimed at the parent channel or sibling threads. With `CCDM_CLAUDE_BOOTSTRAP_FILE`, it holds live messages until the launcher atomically writes one synthetic bootstrap notification (`content`, `meta` with the thread `chat_id`, and `included_message_ids`). It delivers that bootstrap once, removes the file, and drops later live copies of the included messages.

The Thread Supervisor starts a Claude Thread Conversation with `scripts/start-thread-session.sh <project> <thread_id>` on the first owner or guest message in a bound thread of a Claude project. Both launchers resolve the project and map model, effort, and account through `scripts/claude-launch.py`. A thread session uses tmux `<screen_name>-t-<last 6 digits>` and its own state dir `<bot state_dir>/threads/<thread_id>/` (symlinked `.env`, parent-group-only `access.json`, `DISCORD_ACCESS_MODE=static`, its own MCP config, settings, and bootstrap file). Listener lookups match that exact state-dir path, so `stop-session.sh <project>` never stops a thread session and a thread start never touches the channel listener. The supervisor answers the consent and trust prompts, hands over the bootstrap once the pane shows it is listening, and stores the session id from `<claude_home>/sessions/<pid>.json`. A boot not ready within 120 seconds is marked `start-failed` and retried only by the next owner message. Archiving or deleting the thread stops its session and removes the thread state dir (a delete also drops the store row); an owner or root archive, read from the audit log, closes the conversation, and any other archive only stops it. The owner's next message relaunches with `start-thread-session.sh <project> <thread_id> <session id>`, which passes `claude --resume <session id>` under the same Claude home and cwd; guest messages and bot posts never resume.

A Codex project's threads run on one Codex thread host per project (`scripts/codex-thread-host.js`, tmux `<screen_name>-threads`), started by the supervisor on the first thread message it needs and never by `start-codex-session.sh`, so `stop-session.sh <project>` leaves it running. The host resolves nothing itself: the supervisor sends each thread's Codex Home (the project's, resolved by `resolve-codex-home.py`), model (`codex_model`), effort (`codex_reasoning_effort`), and sandbox (`codex_sandbox`, default `danger-full-access`) with `open` on the private control socket `<thread state dir>/hosts/<project>/control.sock`. It runs one app-server per Codex Home in use, the first on the project's `thread_ws_port` (default `ws_port + 1000`). The Codex conversation id is stored in the thread row once the host reports it. Stopping a Codex thread (archive, delete, failed boot) sends `stop`, which unloads the conversation with `thread/unsubscribe`, never `thread/archive`; when no hosted thread is left, the host refuses new `open`s, stops its app-servers, and exits, and the supervisor starts a fresh host for the next thread. The owner's next message resumes with `thread/resume <stored id>` on the stored home (after `thread/unarchive` if needed), re-sending the `config.mcp_servers` override; a thread whose home changed starts fresh. Before each turn the host re-reads the home's `discord-*` servers and, if they changed, unloads and resumes the conversation with a refreshed override.

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

`scripts/stop-session.sh <project>` is the common teardown path: kill the recorded process tree, kill the exact tmux session, sweep listener processes by assignment identity, then clear `pid` and `session_id`. Do not replace this with only `tmux kill-session`; orphan listeners have caused duplicate processing. Without a flag it never touches Thread Conversations; `--threads` runs `thread-supervisor.py stop-threads --project <project>` (every booting, live, or queued thread becomes `stopped/operator`, each thread's runtime is swept, and tmux `<screen_name>-threads` is stopped) and leaves the channel session, and `--all` does both. Root operates single threads with `scripts/threads.sh list|stop|restart|close` (see `patterns/manage-threads.md`).

## Registration

Registration claims the first free pool bot, writes a project entry, applies Discord channel isolation, writes bot/root access files, and starts the selected session. Deregistration performs full teardown, removes overrides/roles/access entries, resets the bot name, releases the pool record, and deletes the project entry. Both workflows then run `scripts/conversation-reminder-service.py assignment-changed --project <project>`, which retires the old reminder generation, deletes its recorded reminders at once with the retired bot (reporting any it cannot delete as inaccessible), and writes a fresh `assignment_generation` for a registered project; see `docs/conversation-reminders.md`.

Codex startup enumerates all MCP status pages (`data`, with legacy `servers`/`items` compatibility) and waits for the scoped Discord `reply` tool before creating/resuming the thread. `CODEX_MCP_READY_TIMEOUT_MS` defaults to 30000. Bootstrap is configuration-only and explicitly forbids tools or Discord writes. It stays tracked until completion; `CODEX_BOOTSTRAP_TIMEOUT_MS` defaults to 60000, after which the bridge pauses, requests interruption, and fails startup rather than declaring a still-running turn idle. Failed bootstrap completions also fail startup. Discord transport must use exposed MCP tools, never shell-launched replacements.
