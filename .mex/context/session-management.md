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
last_updated: 2026-09-22
---

# Session Management

## Registry

`registry.json` contains `pool`, `projects`, `discord_user_id`, `guild_id`, and shared permission configuration. Pool records contain bot identity, token, state directory, and assignment. Project records contain path, bot ID, channel ID, tmux `screen_name`, session `type`, PID/session state, guest IDs, and optional account/model overrides.

Never print tokens. Treat missing project `type` as `claude`. Use exact tmux targets (`=<screen_name>`) and expand home paths before comparing them.

## Claude Lifecycle

Use `scripts/start-session.sh <project>`. It resolves the assigned state directory, rejects duplicate tmux/listener processes, launches Claude through `zsh -ic`, and records PID/session ID. Optional `claude_home` selects `CLAUDE_CONFIG_DIR`; `model` and `claude_effort` set the listener's `--model` and `--effort` flags. Supported effort values are `low`, `medium`, `high`, `xhigh`, and `max`. Missing, null, or empty effort uses the default; other values are rejected before field splitting, MCP config creation, or launch.

Claude slash commands from project channels are relayed by the root bot through `scripts/send-claude-command.sh`; they are tmux keystrokes, not protocol calls.

## Codex Lifecycle

Use `scripts/start-codex-session.sh <project>`. It validates the target project's named `codex_account` or legacy `codex_home` selector and the applicable top-level `codex_accounts`/`default_codex_account` or legacy selector through the shared resolver before stale MCP cleanup, tmux creation, or PID recording, then passes the resolved channel, guild, bot, allowlist, home, model, and WebSocket configuration to `codex-bridge.js`, which owns `codex app-server`. Project precedence is project named/raw selector, top-level default named/raw selector, then `~/.codex`; a same-scope named/raw conflict or unknown alias fails before lifecycle mutation. The root bridge uses the same resolver for `ROOT_CODEX_HOME`, then the top-level named/raw selector, ambient `CODEX_HOME`, then `~/.codex`, and validates the selection before tearing down `root_agent`. Model overrides use `codex_model`, `codex_reasoning_effort`, and `codex_service_tier`.

After a Codex CLI upgrade, stop every long-lived CCDM Codex session before starting any replacement, then restart the root Codex bridge. Running app-server processes keep their original runtime version.

MiMo API accounts use the same named-account selection and launch path. `scripts/setup-codex-mimo.py` creates an external home with a private `api-key`, provider auth command, and Xiaomi model catalog; it does not mutate registry selectors. Add the home as a `codex_accounts` alias and select it only on the intended project. Omit incompatible GPT model/service-tier overrides. The provider reads credentials from its home, so no MiMo key is passed through tmux command arguments. `--rotate-key` replaces only the private credential; restart affected sessions afterward. MiMo API quota reporting is outside the ChatGPT usage dashboard's scope.

DeepSeek Flash homes follow the same selection and authentication flow through `scripts/setup-codex-deepseek.py`. Its catalog uses standard Responses and shell-command tools, not MiMo's Responses-lite/code-mode metadata. The helper extracts the vendor's literal catalog without executing its installer; only `deepseek-flash` is selected (V4.1 Flash as of 2026-09-22). Image support does not itself configure Computer Use tools, and DeepSeek quota reporting is outside the ChatGPT usage dashboard's scope.

Root multi-channel sessions accept steering only from the active channel and author, reusing the active turn's Discord scope token so in-flight tool calls stay valid. Messages from other channels/authors queue until the turn finishes. Failed steering queues the original message with its own scope for the next turn. Steering was verified live with DeepSeek Flash through app-server; this behavior is provider-independent.

Codex channels handle `/compact`, `/clear`, and `/restart` directly in the bridge.

For an explicit history-preserving restart, use `scripts/start-codex-session.sh <project> --resume <thread_uuid>`. This resumes only at startup; `/clear` still creates a fresh thread. A resume launch requires the fresh Discord instruction request to be accepted and waits up to 60 seconds for listener readiness before reporting success. Failure or timeout returns nonzero and uses the common stop script to clean up listeners and registry runtime state instead of silently creating a new conversation. To change accounts while preserving history, identify and verify the current rollout's thread ID and project directory, stop the old session through the common stop script, copy that rollout into the target home's corresponding `sessions/` path without overwriting an existing file, update only the project's account selector, and start with `--resume`. Keep the original rollout and account selection for recovery. Credentials are never copied. Verify the resumed thread ID, selected process home, and channel listener. In-flight processes do not survive the restart.

## Stop Invariant

`scripts/stop-session.sh <project>` is the common teardown path: kill the recorded process tree, kill the exact tmux session, sweep listener processes by assignment identity, then clear `pid` and `session_id`. Do not replace this with only `tmux kill-session`; orphan listeners have caused duplicate processing.

## Registration

Registration claims the first free pool bot, writes a project entry, applies Discord channel isolation, writes bot/root access files, and starts the selected session. Deregistration performs full teardown, removes overrides/roles/access entries, resets the bot name, releases the pool record, and deletes the project entry.
