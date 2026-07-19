---
name: conventions
description: How code is written in this project — naming, structure, patterns, and style. Load when writing new code or reviewing existing code.
triggers:
  - "convention"
  - "pattern"
  - "naming"
  - "style"
  - "how should I"
  - "what's the right way"
edges:
  - target: context/architecture.md
    condition: when a convention depends on understanding the system structure
  - target: context/discord-security.md
    condition: when code changes permissions, credentials, or message routing
  - target: context/session-management.md
    condition: when changing lifecycle scripts or registry runtime state
last_updated: 2026-07-19
---

# Conventions

## Naming
- Scripts and tests use kebab-case filenames (`guest-access.js`, `codex-start.test.js`).
- JavaScript functions and variables use camelCase; environment variables use uppercase snake case.
- Registry project keys are human-readable names; `screen_name` is short lowercase snake case.
- Bot names follow `<bot_id>-<project>-<type>` while assigned and revert to `<bot_id>` when released.

## Structure
- Executable lifecycle and integration code lives in `scripts/`; reusable agent instructions live in `skills/`.
- E2E tests live in `tests/e2e/`; shared local fakes and harness helpers live in `tests/e2e/support/`.
- `registry.example.json` is public structure; `registry.json` is local runtime configuration and ignored.
- Shell entry points resolve `SCRIPT_DIR` and `ROOT_DIR` instead of assuming the caller's working directory.
- Keep changes scoped; do not replace existing shell/Node helpers with a new framework.

## Patterns
- Parse and rewrite JSON structurally with `JSON.parse`/`JSON.stringify` or Python's `json` module; never edit registry/access JSON with regex.
- Before launching, check both the exact tmux session and listener processes tied to the bot state directory, channel, app ID, or WebSocket port.
- Stop descendants before parents, terminate tmux, sweep remaining listeners, then clear registry PID/session state.
- Discord writes from Codex require the bridge-issued scope token; delegated agents never receive it.

## Verify Checklist
- [ ] `npm test` passes with local fakes and no live external services.
- [ ] No token, credential, `registry.json` value, or local channel ID was added to tracked output unintentionally.
- [ ] Start/stop changes preserve duplicate-listener detection and cleanup.
- [ ] Discord permission changes keep every project bot isolated to one channel.
- [ ] Registry and access files are handled with structured JSON parsing.
- [ ] Relevant mex context or patterns were updated when behavior changed.
