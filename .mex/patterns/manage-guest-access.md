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
last_updated: 2026-09-29
---

# Manage Guest Access

## Steps
1. Run `scripts/guest-access.js invite|grant|revoke <project-or-channel-id> <user-id>`; use `list` or `sync` for inspection/repair.
2. For invite, send only the generated one-use target-channel invite.
3. Restart the project session so its running allowlist includes the change.
4. Use `sync` if Discord role state and local allowlists disagree.

## Gotchas
- Do not send a generic guild invite.
- Guests receive text, history, attachments, reactions, and thread replies, not voice access.
- Plan A access is restricted by the root `AGENTS.md` rules.

## Verify
- [ ] Guest sees the target channel and no other managed project channel.
- [ ] The registry's `guest_user_ids` includes or excludes the user as intended (the Router reloads it live).
- [ ] `npm test -- --test-name-pattern='guest'` passes when guest code changed.

## Update Scaffold
- [ ] Update security context if the permission model changed.
