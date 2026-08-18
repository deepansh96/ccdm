---
name: router
description: Session bootstrap and navigation hub. Read at the start of every session before any task. Contains project state, routing table, and behavioural contract.
edges:
  - target: context/architecture.md
    condition: when working on system design, integrations, or understanding how components connect
  - target: context/stack.md
    condition: when working with specific technologies, libraries, or making tech decisions
  - target: context/conventions.md
    condition: when writing new code, reviewing code, or unsure about project patterns
  - target: context/decisions.md
    condition: when making architectural choices or understanding why something is built a certain way
  - target: context/setup.md
    condition: when setting up the dev environment or running the project for the first time
  - target: context/session-management.md
    condition: when starting, stopping, registering, or deregistering project sessions
  - target: context/discord-security.md
    condition: when changing bot permissions, guest access, channel routing, or credentials
  - target: patterns/INDEX.md
    condition: when starting a task — check the pattern index for a matching pattern file
last_updated: 2026-08-18
---

# Session Bootstrap

If you haven't already read `AGENTS.md`, read it now — it contains the project identity, non-negotiables, and commands.

Then read this file fully before doing anything else in this session.

## Current Project State
**Working:**
- Root bot manages a registry-backed pool of isolated Discord project bots.
- Claude sessions run through the official Discord plugin; Codex sessions run through `scripts/codex-bridge.js`.
- Start, stop, registration, guest access, command relay, voice transcription, and local-fake E2E coverage are present.
- Local Claude and Codex project bots can export an inclusive Discord message range to a temporary text file.
- Codex Discord tools can read the last requested 1-10,000 messages in their scoped channel, returning larger reads as private temporary transcripts.
- Per-project Claude and Codex account/model overrides are supported.
- Named Codex Account aliases and `default_codex_account` select root and project Codex Homes, while legacy `codex_home` and root overrides remain supported.
- Project Codex launches resolve and validate the selected named or legacy home before MCP cleanup, tmux creation, or PID recording through `scripts/resolve-codex-home.py`.
- The Codex bridge retries a generic terminal `response.failed` once when the failed turn produced no agent work.
- The Codex bridge can pause new turns in memory, queue incoming messages, and resume them in order.
- The Codex bridge forwards allowed users' 👍 and 👎 reactions on its own messages to the active Codex thread.
- The tracked Usage Stats Poster discovers named and legacy Codex Homes, deduplicates shared homes, and falls back from live rate limits to recent session JSONL data.
- The tracked Usage Stats Poster also collects sanitized UTC 10-minute snapshots in a private SQLite history, retains them for 365 days, warns on feature-owned history growth, and uses the shared trend-first renderer for one multipart PNG post per UTC 30-minute slot; the local posts ledger and advisory lock make retries idempotent.
- The opt-in `scripts/install-usage-stats-poster.sh` renders, validates, and idempotently loads a 600-second interval-only secret-free LaunchAgent for the tracked Usage Stats Poster, restoring the prior plist and loaded schedule when a replacement load fails.
- Fresh setup output, `registry.example.json`, and the operator README expose generic named-account fields, precedence, migration, and rollback guidance without local credentials or account paths.

**Not built:**
- Remote VM lifecycle operations are documented but intentionally performed by the user on the remote host.
- The unpublished `mex-mcp` integration is not installed; this repo uses the stable CLI through `npx`.

**Known issues:**
- Sessions do not survive machine restarts.
- Claude OAuth tokens can expire after an account is idle and refresh on the next login/session.
- Voice transcription depends on optional local `whisper`.

## Routing Table

Load the relevant file based on the current task. Always load `context/architecture.md` first if not already in context this session.

| Task type | Load |
|-----------|------|
| Understanding how the system works | `context/architecture.md` |
| Working with a specific technology | `context/stack.md` |
| Writing or reviewing code | `context/conventions.md` |
| Making a design decision | `context/decisions.md` |
| Setting up or running the project | `context/setup.md` |
| Starting, stopping, or registering sessions | `context/session-management.md` |
| Permissions, guests, routing, or credentials | `context/discord-security.md` |
| Any specific task | Check `patterns/INDEX.md` for a matching pattern |

## Behavioural Contract

For every task, follow this loop:

1. **CONTEXT** — Load the relevant context file(s) from the routing table above. Check `patterns/INDEX.md` for a matching pattern. If one exists, follow it. Narrate what you load: "Loading architecture context..."
2. **BUILD** — Do the work. If a pattern exists, follow its Steps. If you are about to deviate from an established pattern, say so before writing any code — state the deviation and why.
3. **VERIFY** — Load `context/conventions.md` and run the Verify Checklist item by item. State each item and whether the output passes. Do not summarise — enumerate explicitly.
4. **DEBUG** — If verification fails or something breaks, check `patterns/INDEX.md` for a debug pattern. Follow it. Fix the issue and re-run VERIFY.
5. **GROW** — After meaningful work, run this binary checklist:
   - **Ground:** What changed in reality? Name the changed behavior, system, command, dependency, or workflow.
   - **Record:** If project state changed, update the "Current Project State" section above. If documented facts changed, update the relevant `context/` file surgically.
   - **Orient:** If this task can recur and no pattern exists, create one in `patterns/` using `patterns/README.md`, then add it to `patterns/INDEX.md`. If a pattern exists but you learned a gotcha, update it.
   - **Write:** Bump `last_updated` in every scaffold file you changed. If the why matters, run `mex log --type decision "<what changed and why>"` or `mex log "<note>"`.
