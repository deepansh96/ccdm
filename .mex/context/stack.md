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
last_updated: 2026-11-10
---

# Stack

## Core Technologies
- `Node.js 22.5+` - bridge, Discord utilities, conversation resolver (`node:sqlite`), and E2E tests.
- `JavaScript (CommonJS)` - repository Node scripts and tests.
- `Python 3` - the `scripts/ccdm` command and its lifecycle subcommands (`scripts/ccdmlib/`), the Thread Supervisor and reminder workers, JSON update helpers, plus the Usage Stats collector/history writer and renderer integration.
- `zsh` (macOS) - tmux sessions start through an interactive login shell, which is required for user tool paths.
- `Git Bash` (Windows) - the shell root's Bash tool runs, so the same `scripts/ccdm` lines work on both OSes.
- `SQLite (Python standard library)` - private local Usage Stats snapshots/posts ledger; no server or package dependency.
- `JSON/Markdown` - registry, access configuration, documentation, and mex memory.

## Key Libraries
- **discord.js 14** - Discord gateway and API integration.
- **ws 8** - WebSocket transport to Codex app-server.
- **form-data 4** - multipart Discord attachment uploads.
- The Usage Stats installer validates the renderer's Python imaging prerequisite before touching the LaunchAgent; see the Usage Stats setup documentation for the environment-specific installation command.
- **`node:test`** - built-in test runner; no external test framework.
- `tmux` (macOS) and `ccdm-host` (Windows, `scripts/ccdm-host.js`) - the session host: the process/session boundary for both Claude and Codex agents. `scripts/ccdm` reaches either one through one session-host API.
- Optional npm packages, used on Windows only (`optionalDependencies` in `package.json`): `node-pty` and `@xterm/headless` for ConPTY sessions and screen capture in `ccdm-host`, and `koffi` for the Win32 calls behind the named-pipe sockets and process checks.

## What We Deliberately Do NOT Use
- No test framework dependency; use `node:test` and `assert`.
- No service database; Usage Stats uses a private local SQLite file for sanitized history while registry/access configuration remains structured JSON updated with parsers, not text substitution.
- No container or service manager for local sessions; `scripts/ccdm` and the session host are the supported path.
- No manual Codex Discord MCP config; `codex-bridge.js` registers it per session.

## Version Constraints
`package.json` requires Node.js 22.5 or newer (`node:sqlite`, used by the conversation resolver). Mex stable v0.6.3 requires Node.js 20 or newer and is run with `npx mex-agent`.
