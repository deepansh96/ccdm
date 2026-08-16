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
last_updated: 2026-08-16
---

# Session Management

## Registry

`registry.json` contains `pool`, `projects`, `discord_user_id`, `guild_id`, and shared permission configuration. Pool records contain bot identity, token, state directory, and assignment. Project records contain path, bot ID, channel ID, tmux `screen_name`, session `type`, PID/session state, guest IDs, and optional account/model overrides.

Never print tokens. Treat missing project `type` as `claude`. Use exact tmux targets (`=<screen_name>`) and expand home paths before comparing them.

## Claude Lifecycle

Use `scripts/start-session.sh <project>`. It resolves the assigned state directory, rejects duplicate tmux/listener processes, launches Claude through `zsh -ic`, and records PID/session ID. Optional `claude_home` selects `CLAUDE_CONFIG_DIR`.

Claude slash commands from project channels are relayed by the root bot through `scripts/send-claude-command.sh`; they are tmux keystrokes, not protocol calls.

## Codex Lifecycle

Use `scripts/start-codex-session.sh <project>`. It validates the target project's and top-level legacy `codex_home` selectors through the shared resolver before stale MCP cleanup, tmux creation, or PID recording, then passes the resolved channel, guild, bot, allowlist, home, model, and WebSocket configuration to `codex-bridge.js`, which owns `codex app-server`. A project's optional `codex_home` overrides the top-level shared `codex_home`; without either, projects use `~/.codex`. The root bridge uses the same resolver for `ROOT_CODEX_HOME`, then the shared registry home, then ambient `CODEX_HOME`, then `~/.codex`, and validates the selection before tearing down `root_agent`. Model overrides use `codex_model`, `codex_reasoning_effort`, and `codex_service_tier`.

After a Codex CLI upgrade, stop every long-lived CCDM Codex session before starting any replacement, then restart the root Codex bridge. Running app-server processes keep their original runtime version.

Codex channels handle `/compact`, `/clear`, and `/restart` directly in the bridge.

## Stop Invariant

`scripts/stop-session.sh <project>` is the common teardown path: kill the recorded process tree, kill the exact tmux session, sweep listener processes by assignment identity, then clear `pid` and `session_id`. Do not replace this with only `tmux kill-session`; orphan listeners have caused duplicate processing.

## Registration

Registration claims the first free pool bot, writes a project entry, applies Discord channel isolation, writes bot/root access files, and starts the selected session. Deregistration performs full teardown, removes overrides/roles/access entries, resets the bot name, releases the pool record, and deletes the project entry.
