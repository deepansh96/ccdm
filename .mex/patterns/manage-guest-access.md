---
name: manage-guest-access
description: Grant, synchronize, inspect, or revoke access to one project channel.
triggers:
  - "guest invite"
  - "guest grant"
  - "guest revoke"
edges:
  - target: context/discord-security.md
    condition: always before changing guest permissions
last_updated: 2026-09-28
---

# Manage Guest Access

## Steps
1. Run `scripts/guest-access.js invite|grant|revoke <project-or-channel-id> <user-id>`; use `list` or `sync` for inspection/repair.
2. For invite, send only the generated one-use target-channel invite.
3. Restart the project's Channel Conversation so its running allowlist includes the change. Thread Conversations need no action: `invite`, `grant`, and `revoke` run `scripts/thread-supervisor.py project-changed --project <project>`, which restarts the project's live threads with resume (`guest-changed`) so each regenerates its `access.json` and a Codex project's thread host reloads its guests. Stopped threads stay stopped and pick up the change when they next start.
4. Use `sync` if Discord role state and local allowlists disagree.

## Gotchas
- Do not send a generic guild invite.
- Guests receive text, history, attachments, reactions, and thread replies, not voice access.
- Plan A access is restricted by the root `AGENTS.md` rules.

## Verify
- [ ] Guest sees the target channel and no other managed project channel.
- [ ] Registry and Claude/Codex bot allowlists include or exclude the user as intended.
- [ ] Live threads restarted: the command reports no `restarting ... thread sessions failed` error.
- [ ] `npm test -- --test-name-pattern='guest'` passes when guest code changed.

## Update Scaffold
- [ ] Update security context if the permission model changed.
