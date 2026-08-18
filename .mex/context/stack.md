---
name: stack
description: Technology stack, library choices, and the reasoning behind them. Load when working with specific technologies or making decisions about libraries and tools.
triggers:
  - "library"
  - "package"
  - "dependency"
  - "which tool"
  - "technology"
edges:
  - target: context/decisions.md
    condition: when the reasoning behind a tech choice is needed
  - target: context/conventions.md
    condition: when understanding how to use a technology in this codebase
last_updated: 2026-08-18
---

# Stack

## Core Technologies
- `Node.js 22+` - bridge, Discord utilities, and E2E tests.
- `JavaScript (CommonJS)` - repository Node scripts and tests.
- `zsh` - session lifecycle scripts; login/interactive mode is required for user tool paths.
- `Python 3` - small embedded process inspection and JSON update helpers in shell scripts, plus the Usage Stats collector/history writer and renderer integration.
- `SQLite (Python standard library)` - private local Usage Stats snapshots/posts ledger; no server or package dependency.
- `JSON/Markdown` - registry, access configuration, documentation, and mex memory.

## Key Libraries
- **discord.js 14** - Discord gateway and API integration.
- **ws 8** - WebSocket transport to Codex app-server.
- **form-data 4** - multipart Discord attachment uploads.
- The Usage Stats installer validates the renderer's Python imaging prerequisite before touching the LaunchAgent; see the Usage Stats setup documentation for the environment-specific installation command.
- **`node:test`** - built-in test runner; no external test framework.
- `tmux` - process/session boundary for both Claude and Codex agents.

## What We Deliberately Do NOT Use
- No test framework dependency; use `node:test` and `assert`.
- No service database; Usage Stats uses a private local SQLite file for sanitized history while registry/access configuration remains structured JSON updated with parsers, not text substitution.
- No container or service manager for local sessions; existing scripts and tmux are the supported path.
- No manual Codex Discord MCP config; `codex-bridge.js` registers it per session.

## Version Constraints
`package.json` requires Node.js 22 or newer. Mex stable v0.6.3 requires Node.js 20 or newer and is run with `npx mex-agent`.
