---
name: register-project
description: Register or deregister a Router or pool project while preserving channel isolation and registry consistency.
triggers:
  - "register project"
  - "deregister project"
  - "assign bot"
edges:
  - target: context/session-management.md
    condition: for registry and lifecycle invariants
  - target: context/discord-security.md
    condition: for permissions, roles, tokens, and allowlists
last_updated: 2026-09-29
---

# Register Or Deregister A Project

## Router Projects
For a project on the Router (`transport: "router"`) there is no bot to claim, rename, role, or give access files:
1. Create or resolve the channel with root's REST credentials, as in step 2 below.
2. Write the entry with `path`, `screen_name`, `channel_id`, `type`, and `transport: "router"`, with no `bot_id`.
3. Run `scripts/router.js ensure-webhook <project>`. It finds or creates `ccdm-<project>`, records `webhook_id` in the registry, and keeps the token only in private Router state.
4. Run `scripts/conversation-reminder-service.py assignment-changed --project <project>`, then start through the matching launcher.
5. On deregistration, stop fully, run `scripts/router.js delete-webhook <project>` (deletes the webhook and its token and clears `webhook_id`; a rerun is a no-op), remove the entry, then run `assignment-changed`.

The Router heals a webhook deleted in Discord by recreating it once, updating `webhook_id`, and running `assignment-changed` itself. A second deletion in a row fails replies with `webhook_deleted` until `ensure-webhook` runs. A lost token with a known `webhook_id` is refetched through the bot.

## Pool Project Steps
1. Resolve the channel, absolute project path, session type, and project name.
2. When the user requested a new channel or category lookup, use the documented root-management workflow and the root bot's stored credentials through Discord REST. The scoped Discord MCP remains the reply/message surface; its lack of channel-administration tools is not a blocker and is not a reason to request the bot token from the user.
3. On registration, claim one unassigned pool bot and allocate an unused Codex WebSocket port when needed.
4. Apply the `project-bot` role, the assigned-channel member override, bot state `.env`, project access file, and root-bot mentioned access.
5. After writing or changing the project entry, run `scripts/conversation-reminder-service.py assignment-changed --project <project>` so Conversation Reminders get a fresh assignment generation.
6. Start through the matching lifecycle script and report bot/channel/type without exposing credentials.
7. On deregistration, stop fully first, remove permissions/access entries and guest role, reset the bot name, release the pool entry, remove the project, then run the same `assignment-changed` command to retire its reminder state.

## Gotchas
- One bot cannot serve two projects.
- Reset the bot name with the bot's own token (`PATCH /users/@me {"username": "<botN>"}`). The root token can only change the guild nickname, not another bot's global username. Discord rate-limits username changes (roughly twice per hour), so rename one bot at a time and do not retry in a loop. Deleting the bot's member overwrite (`DELETE /channels/<channel>/permissions/<app_id>`) removes its access to its old channel; the `project-bot` role and the bot's own managed integration role stay on unassigned pool bots.
- Never substitute a different Discord MCP for an authorized administration workflow; keep REST mutations limited to the exact guild, category, channel, bot, and permissions the user requested.
- Update JSON structurally and preserve optional account/model fields.
- Never assign a bot to Plan A general unless explicitly requested.
- Never copy an old `assignment_generation` into a re-registration; polling cannot detect an identical delete/re-add, so the generation contract must run.

## Verify
- [ ] Bot sees only its assigned channel.
- [ ] Registry, Discord overrides, and access files agree.
- [ ] Start/stop E2E coverage still passes.

## Update Scaffold
- [ ] Record any schema or lifecycle change.
