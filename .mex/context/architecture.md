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
last_updated: 2026-09-24
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
- **Session scripts** - `start-session.sh`, `start-codex-session.sh`, and `stop-session.sh` enforce one listener per assignment and maintain registry runtime state.
- **Claude reminder adapter** - opt-in `claude-reminder-channel.js` relays the official Discord plugin through a launch-scoped MCP filter; command hooks and the shared durable receiver record reply and lifecycle events. The foreground service owns reminder delivery, including bounded history discovery; public enablement remains gated on restart reconciliation and catch-up.
- **`scripts/codex-bridge.js`** - connects Discord to `codex app-server`, injects mid-turn messages, handles attachments/audio, and exposes channel-scoped MCP tools.
- **Discord range export** - `export-discord-range.js` paginates an inclusive message range into a temporary transcript; Codex exposes it through the bridge MCP, while `start-session.sh` adds the same export-only MCP to local Claude sessions.
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
