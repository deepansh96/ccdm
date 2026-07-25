---
name: debug-discord-session
description: Diagnose missing, duplicate, or misrouted Discord project responses.
triggers:
  - "bot not responding"
  - "duplicate reply"
  - "wrong channel"
edges:
  - target: context/discord-security.md
    condition: when permissions, scope tokens, or routing may be wrong
  - target: context/session-management.md
    condition: when process or tmux state may be wrong
last_updated: 2026-07-25
---

# Debug A Discord Session

## Steps
1. Confirm the registry assignment, session type, channel ID, bot app ID, state directory, and WebSocket port.
2. Check the exact tmux session and capture its pane.
3. Inspect processes using the same identity rules as the lifecycle scripts; look for orphan or duplicate listeners.
4. Check Discord channel overrides and the relevant `access.json` allowlist.
5. For Codex, confirm the bridge registered the channel MCP server and the top-level turn used its current scope token.
6. Stop through `scripts/stop-session.sh`, then start cleanly if process state is inconsistent.

## Gotchas
- Do not print tokens or scope tokens while debugging.
- Root mentions and project messages intentionally follow different routing paths.
- Claude commands are tmux relay; Codex commands are handled in the bridge.
- `stream disconnected before completion: response.failed event received` is a terminal upstream Responses event after Codex has exhausted its internal retries, not a Discord disconnect. The bridge retries it once only when no agent work has started, which avoids repeating possible side effects.

## Verify
- [ ] One user message produces at most one response from the assigned bot.
- [ ] No other channel can reach the project bot.
- [ ] Relevant bridge/plugin E2E tests pass.

## Update Scaffold
- [ ] Record a recurring failure mode in this pattern.
