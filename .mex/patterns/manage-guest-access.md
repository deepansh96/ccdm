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
last_updated: 2026-11-10
---

# Manage Guest Access

## Steps
1. Read the registry's top-level `guest_mode` and follow the matching part of "Guest modes" below.
2. Run `node scripts/guest-access.js invite|grant|revoke <project-or-channel-id> <user-id>` (a thread id or link acts on its parent project); use `list` or `sync` for inspection/repair.
3. For invite, send only the generated one-use target-channel invite.
4. Restart the project session so its running allowlist includes the change.
5. Use `sync` if Discord permission state and the registry's guests disagree.

## Guest modes
`guest_mode` is one top-level registry option. Any other value is an invalid registry: the Router keeps its last good table, `router status` shows the error, and `guest-access.js` refuses every action.

- macOS: leave `guest_mode` out (or set `"roles"`). Each project gets one guest role; the role and each guest are denied the other managed locations and allowed the project channel, and the invite carries the role. This needs server-wide Manage Roles, which only the Mac's bot has.
- Windows: the Windows bot never gets server-wide Manage Roles, so role mode is not an option there and is never offered as a fallback. The mode is chosen only after the spike in #202 has recorded what a category-scoped bot can do. Until that result exists, the registry must say `"guest_mode": "none"`.
  - Windows, `"none"` (the safe value): `invite`, `grant` and `sync` refuse, name owner decision D4, exit non-zero and make no Discord call. `revoke` and `list` still work; `revoke` removes the guest from the registry and deletes their recorded invites.
  - Windows, `"member-overwrites"` (only once #202 records that the member overwrites, their deletion and the targeted invite all work with channel-level Manage Permissions):
    1. `invite` and `grant` create no role. They deny the guest View Channel on the other project channels, `category_ids`, `guest_deny_channel_ids` and the channels under those, and allow the guest the project channel, all as overwrites on the guest's own user. `invite` then creates the one-use targeted invite, which carries no role.
    2. If `invite` says the user is not in the server yet, no permission could be written for them. After they join, run `node scripts/guest-access.js sync <project>`; until then they cannot see the project channel.
    3. `revoke` deletes the guest's allow overwrite on the project channel and their recorded invites.
    4. `sync` rewrites the overwrites of the listed guests, then deletes guest overwrites left on the project channel for anyone not in `guest_user_ids`. Only a member overwrite with exactly the guest permissions counts; the owner's is never deleted.

## Gotchas
- Do not send a generic guild invite.
- Guests receive text, history, attachments, reactions, and thread replies, not voice access.
- Plan A access is restricted by the root `AGENTS.md` rules.
- Never give the Windows bot server-wide Manage Roles to make guests work: it could then hand out the Mac's guest roles.
- In `"member-overwrites"` mode nothing outside the project channels, `category_ids`, `guest_deny_channel_ids` and their children is touched. Elsewhere in the server a guest sees whatever `@everyone` sees.
- Revoke every guest before changing `guest_mode`. A mode does not clean up what another mode wrote: `"none"` leaves a member overwrite in place, and `"member-overwrites"` never removes a role.

## Verify
- [ ] Guest sees the target channel and no other managed project channel.
- [ ] The registry's `guest_user_ids` includes or excludes the user as intended (the Router reloads it live).
- [ ] `npm test -- --test-name-pattern='guest'` passes when guest code changed.

## Update Scaffold
- [ ] Update security context if the permission model changed.
