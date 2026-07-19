---
name: register-project
description: Assign or release a bot while preserving channel isolation and registry consistency.
triggers:
  - "register project"
  - "deregister project"
  - "assign bot"
edges:
  - target: context/session-management.md
    condition: for registry and lifecycle invariants
  - target: context/discord-security.md
    condition: for permissions, roles, tokens, and allowlists
last_updated: 2026-07-19
---

# Register Or Deregister A Project

## Steps
1. Resolve the channel, absolute project path, session type, and project name.
2. On registration, claim one unassigned pool bot and allocate an unused Codex WebSocket port when needed.
3. Apply the `project-bot` role, the assigned-channel member override, bot state `.env`, project access file, and root-bot mentioned access.
4. Start through the matching lifecycle script and report bot/channel/type without exposing credentials.
5. On deregistration, stop fully first, remove permissions/access entries and guest role, reset the bot name, release the pool entry, then remove the project.

## Gotchas
- One bot cannot serve two projects.
- Update JSON structurally and preserve optional account/model fields.
- Never assign a bot to Plan A general unless explicitly requested.

## Verify
- [ ] Bot sees only its assigned channel.
- [ ] Registry, Discord overrides, and access files agree.
- [ ] Start/stop E2E coverage still passes.

## Update Scaffold
- [ ] Record any schema or lifecycle change.
