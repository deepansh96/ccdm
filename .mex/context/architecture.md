---
name: architecture
description: How the major pieces of this project connect and flow. Load when working on system design, integrations, or understanding how components interact.
triggers:
  - "architecture"
  - "system design"
  - "how does X connect to Y"
  - "integration"
  - "flow"
edges:
  - target: context/stack.md
    condition: when specific technology details are needed
  - target: context/decisions.md
    condition: when understanding why the architecture is structured this way
last_updated: 2026-09-28
---

# Architecture

## System Overview
```text
Discord user -> root Discord bot -> root Claude/Codex agent
  -> registry.json lookup -> assigned bot + project configuration
  -> start/stop/guest helper scripts -> tmux session and Discord permissions
  -> Claude: official Discord plugin -> Claude Code in project directory
  -> Codex: codex-bridge.js -> codex app-server in project directory
  -> scoped Discord MCP reply/edit/react tools -> project channel
```

The root agent coordinates lifecycle and access. Each project agent works only in its registered directory and channel.

## Key Components
- **`registry.json`** - source of truth for bot pool, project assignments, channels, tmux names, account homes, and runtime PIDs; local and untracked because it contains secrets.
- **Session scripts** - `start-session.sh`, `start-codex-session.sh`, and `stop-session.sh` enforce one listener per assignment and maintain registry runtime state. `start-session.sh` and `start-thread-session.sh` share `claude-launch.py` for Claude project resolution, proxy configuration, and model/effort/account flags.
- **Claude conversation proxy and reminder adapter** - `claude-reminder-channel.js` always relays the official Discord plugin for Claude Channel Conversations. It is an MCP filter scoped to one conversation that keeps thread traffic and other channels out and drops reserved `/thread`, `/config`, and `/close`. With the opt-in reminder adapter, command hooks and the shared durable receiver record reply and lifecycle events. The foreground service owns reminder delivery, bounded history discovery, restart/reconnect reconciliation, and globally spaced catch-up; `enable` opts in only when both provider adapters are installed.
- **Conversation Reminder service** - `conversation-reminder-service.py run` observes project channels with root credentials and sends through assigned bots. It runs in the foreground or under the opt-in `com.discord.conversation-reminders` LaunchAgent from `install-conversation-reminder-service.sh`. Both launches share one worker lock and the same reconciliation, independently of project and root coding sessions.
- **Thread Supervisor** - `thread-supervisor.py run` is a separate root-level service with its own Gateway observer (`thread-supervisor-observer.js`, root credentials). It binds owner- or guest-created public threads under registered local project channels in a private SQLite thread store (`thread-supervisor-store.py`; binding rules in `thread-supervisor-router.py`) and sets their auto-archive to one week with the project bot. The first owner or guest message in a bound Claude-project thread starts that thread's Claude session through `start-thread-session.sh`; a `boot` worker beside the event queue reacts 👀, answers startup prompts, holds messages sent during boot, and hands the proxy one bootstrap (REST side effects go through `thread-supervisor-discord.js` with the project bot). Thread archives are classified by their root audit-log actor through `thread-supervisor-audit.js` (owner or root closes; anything else, or no entry within 60 seconds, is an auto-archive); archives, deletions, and failed boots share one provider-agnostic stop hook that removes per-thread runtime files, and an owner message resumes a stopped or closed thread. In a Codex project, the same message path opens the thread's own Codex conversation on the project's Codex thread host (`codex-thread-host.js`, tmux `<screen_name>-threads`), which the boot worker starts if needed and feeds over a private control socket; the host runs one app-server per Codex Home, logs into the project bot's Gateway for the threads it hosts, scopes each conversation's Discord server with a per-conversation `config.mcp_servers` override, and reports events back through `thread-supervisor.py host-event`. Stopping a Codex thread unloads its conversation from the host, which exits once no thread is left; resume re-sends the override through `thread/resume`. The observer hands `/thread` and `/config` typed in a project channel to `thread-supervisor.py command`, which validates the options, records a creation request, creates the thread with the project bot, and binds it as the request's fulfilment (the router admits a bot- or root-created thread only through a pending request); a Claude thread's account, model, and effort overrides reach `claude-launch.py` through `start-thread-session.sh` options, and a Codex thread's through the host's `open`. The running worker also serves a private request socket (`requests.sock` in its state dir) through which `threads.sh create` (requester `root`) and the `create_thread` tool that `codex-bridge.js` and `claude-launch.py` enable only for Channel Conversations (requester `channel-agent`, scoped to the server's own `CHANNEL_ID`) submit creation requests via `thread-supervisor.py submit`; they share the `/thread` validation and creation path, and the worker starts the boot itself. In-thread commands are not built yet. `install-thread-supervisor.sh` supervises the same worker as the `com.discord.thread-supervisor` LaunchAgent (relaunch only on unsuccessful exit); `disable` stops it via a private `disabled` marker and `enable` clears it. It shares nothing at runtime with the Conversation Reminder service.
- **`scripts/codex-bridge.js`** - connects Discord to `codex app-server`, injects mid-turn messages, handles attachments/audio, and exposes channel-scoped MCP tools.
- **Discord range export** - `export-discord-range.js` paginates an inclusive message range into a temporary transcript; Codex exposes it through the bridge MCP, while `start-session.sh` adds the same MCP to local Claude sessions in read-only mode, exposing only `read_last_x_messages_in_channel` and `export_message_range` beside the official plugin's tools.
- **`scripts/guest-access.js`** - creates and synchronizes project-scoped Discord roles, channel overrides, and bot allowlists.
- **`scripts/usage-stats-poster.py`** - reads the ignored poster config, gathers the default and valid extra Claude OAuth accounts through the Keychain and Anthropic OAuth boundaries, discovers and deduplicates compatible named/legacy Codex Homes, writes sanitized UTC-slot snapshots to a private SQLite history with advisory locking/retention, and preserves the manual combined embed surface. Automated LaunchAgent runs reuse that bounded text summary and post the original text Usage Report embed once per UTC 30-minute slot through a local ledger, with no image rendering or attachment. Configured DeepSeek homes are reported from their private key instead of the Codex rate-limit request: the poster validates the documented account-wide `GET /user/balance` response (USD/CNY only, all amounts required and preserved exactly) and pairs it with this machine's local DeepSeek token totals in a compact `deepseek (API)` text block that uses an optional `deepseek_balance_references` display budget for an inline used-balance bar with used and remaining percentages and no quota card, while a DeepSeek-backed root Codex session still runs through the Codex app-server.
- **`scripts/usage-dashboard-renderer.py`** - credential-free Pillow renderer for the trend-first PNG; retained for back-compat but no longer invoked by the posting workflow. The text-only poster installer does not require Pillow.
- **E2E harness** - Node's built-in test runner plus fixture binaries and local fakes; default tests never contact Discord or agent services.

## External Dependencies
- `Discord API / discord.js` - bot messaging, guild membership, roles, invites, and permission overrides; project bots must remain channel-isolated.
- `Claude Code + official Discord plugin` - runs Claude project sessions using per-bot state directories.
- `Codex CLI/app-server` - runs Codex project sessions; the bridge registers a scoped Discord MCP server dynamically.
- `tmux` - owns long-running local sessions and provides the Claude slash-command relay boundary.
- `macOS Keychain / local auth files` - store agent credentials; never copy their contents into tracked files.

## What Does NOT Exist Here
- No web application; durable configuration is JSON and the Usage Stats feature's private SQLite history is local state only. The history writer never traverses or deletes Claude/Codex source logs.
- No daemon supervisor for project sessions; tmux sessions must be restarted after reboot.
- No remote-host orchestration; remote setup commands are handed to the user.
- No real external calls in the default E2E suite; live smoke tests require `CCDM_LIVE_E2E=1`.
