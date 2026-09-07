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
last_updated: 2026-09-07
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
- When unrelated bots appear in a channel's member list, inspect Administrator grants on every assigned role before changing channel overrides. Administrator bypasses even member-level View Channel denies. Back up channel overwrites first; do not change server roles when authorization covers only one channel.
- For an authorized single-bot Administrator repair, back up roles and channel overwrites privately, confirm the granting role belongs exclusively to that bot, and calculate its required assigned-channel permissions without Administrator before applying the change. Remove only the Administrator bit, verify assigned-channel history access and an unrelated-channel denial using that bot's identity, and restore the role if verification fails. Compare overwrite collections by ID rather than API response order; Discord can reorder them without changing permissions.
- Before expanding a repair, resolve the actual root identity separately from legacy pool management credentials and protect both until dependencies are accounted for. A role PATCH can return HTTP 403 for one management identity while succeeding through the authorized root identity; check role hierarchy without changing root's roles. Audit non-Administrator bots too: an unassigned monitoring role can independently grant broad visibility.
- If an unassigned bot lacks the shared restricted bot role, calculate the effect of adding it before editing any channel overrides; existing member allows may already preserve its intended monitoring channels. HTTP 401 from its saved token is an authentication failure, not a successful access-denial test. Report effective-permission verification separately from any unavailable bot-identity read test.
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
