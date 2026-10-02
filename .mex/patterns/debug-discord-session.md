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
last_updated: 2026-10-02
---

# Debug A Discord Session

## Steps
1. Run `node scripts/router.js status`: the Router must be reachable with its gateway ready, the registry loaded without error, and the project's session connected with its channel as scope. Check its webhook presence, root's missing permissions, and recent scope violations. Router logs are in `~/.local/state/ccdm/router/router.log` and `router.err`.
2. Confirm the registry entry: session type, channel ID, `webhook_id`, guests, and WebSocket port.
3. Check the exact tmux session and capture its pane.
4. Inspect processes using the same identity rules as the lifecycle scripts; look for orphan or duplicate listeners.
5. For Codex, confirm the bridge registered the channel MCP server and the top-level turn used its current scope token.
6. Stop through `scripts/stop-session.sh`, then start cleanly if process state is inconsistent.

## Gotchas
- MCP status in current Codex uses paginated `data`, not just legacy `servers`/`items`. Verify the scoped reply tool is present before starting a thread.
- Bootstrap is not a user request: instruct the model to acknowledge without tools. Never drop active-turn tracking merely because startup is slow; interrupt on timeout and fail closed.
- Tool listing alone does not prove the model invokes tools correctly. Use dummy credentials and a local recording MCP stub with the real tool schema to verify direct replies and steering; never let a test agent access live Discord credentials or use shell transport workarounds.
- For root after reboot, distinguish the Router gateway from the root listener. A one-shot LaunchAgent can exit 0 after starting detached tmux while the bridge later dies. Check launch logs, tmux creation times, and automatic restore: tmux-resurrect can replace the sole existing pane during a scratch restore; its `@resurrect-never-overwrite on` option protects already-running panes. Without surviving bridge logs, report a restore race as suspected, not proven.
- A 💤 reaction means the Router found no live session for the channel; offline messages are never replayed.
- `router_unavailable` from a session means the Router is down; launchd restarts it and sessions reconnect. If it stays down about 2 minutes, root's emergency gateway serves root channels only.
- A reply that fails with `scope_violation` targeted another channel or a message outside the session's channel; the Router logs project, operation, and target.
- `webhook_deleted` means the webhook was deleted twice in a row; run `node scripts/router.js ensure-webhook <project>`.
- Do not print tokens, launch keys, or scope tokens while debugging.
- Root mentions and project messages intentionally follow different routing paths: a bot mention in a project channel reaches root only.
- Plain management commands are handled by the session's own adapter for both providers (Claude through the channel server's tmux relay, Codex in the bridge).
- `stream disconnected before completion: response.failed event received` is a terminal upstream Responses event after Codex has exhausted its internal retries, not a Discord disconnect. The bridge retries it once only when no agent work has started, which avoids repeating possible side effects.
- A Claude session whose pane stops repainting and ignores Esc, Ctrl+C, SIGINT, and a resize is stuck at the OS level, not busy. Check for a hung credential read with `pgrep -lf "security find-generic-password"`, which looks for `Claude Code-credentials` (projects without `claude_home`) or `Claude Code-credentials-<first 8 hex of sha256(Claude config dir path, e.g. ~/.claude-af)>`; the Usage Stats Poster also runs short `security` reads, so confirm the match is a long-lived child of the frozen session. A locked login keychain (typical after the Mac sleeps) blocks that read, and the CLI cannot repaint or answer queued Discord messages until the keychain is unlocked on the machine (log in, or `security unlock-keychain`). Confirm the hang and try unlocking before restarting: a restart keeps committed work but loses uncommitted work and the session's live context.

## Verify
- [ ] One user message produces at most one response, under the project's webhook identity.
- [ ] `router status` shows exactly one session for the project, scoped to its channel.
- [ ] Relevant Router, channel server, and bridge E2E tests pass.

## Update Scaffold
- [ ] Record a recurring failure mode in this pattern.
