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
last_updated: 2026-07-19
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
- **`scripts/codex-bridge.js`** - connects Discord to `codex app-server`, injects mid-turn messages, handles attachments/audio, and exposes channel-scoped MCP tools.
- **`scripts/guest-access.js`** - creates and synchronizes project-scoped Discord roles, channel overrides, and bot allowlists.
- **E2E harness** - Node's built-in test runner plus fixture binaries and local fakes; default tests never contact Discord or agent services.

## External Dependencies
- `Discord API / discord.js` - bot messaging, guild membership, roles, invites, and permission overrides; project bots must remain channel-isolated.
- `Claude Code + official Discord plugin` - runs Claude project sessions using per-bot state directories.
- `Codex CLI/app-server` - runs Codex project sessions; the bridge registers a scoped Discord MCP server dynamically.
- `tmux` - owns long-running local sessions and provides the Claude slash-command relay boundary.
- `macOS Keychain / local auth files` - store agent credentials; never copy their contents into tracked files.

## What Does NOT Exist Here
- No database or web application; durable configuration is JSON and local state files.
- No daemon supervisor for project sessions; tmux sessions must be restarted after reboot.
- No remote-host orchestration; remote setup commands are handed to the user.
- No real external calls in the default E2E suite; live smoke tests require `CCDM_LIVE_E2E=1`.
