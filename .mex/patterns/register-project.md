---
name: register-project
description: Register or deregister a project on the Router (channel, webhook, registry entry) while preserving registry consistency.
triggers:
  - "register project"
  - "deregister project"
  - "create webhook"
edges:
  - target: context/session-management.md
    condition: for registry and lifecycle invariants
  - target: context/discord-security.md
    condition: for Session Scope, root permissions, and credentials
last_updated: 2026-10-01
---

# Register Or Deregister A Project

There is no bot to create, claim, rename, role, or give access files: every project is served by the root bot through the Router, under its own `ccdm-<project>` webhook.

## Register
1. Resolve the channel, absolute project path, session type (`claude` or `codex`), and project name. Allocate an unused `ws_port` for Codex.
2. When the user requested a new channel or category lookup, use the root bot's stored credentials (root state `.env`) through Discord REST, limited to the exact guild and category requested. The scoped Discord tools remain the reply/message surface; their lack of channel-administration tools is not a blocker and is not a reason to request the bot token from the user.
3. Write the entry with `path`, `screen_name`, `channel_id`, and `type` (plus `ws_port` and any account/model overrides).
4. Run `node scripts/router.js ensure-webhook <project>`. It finds or creates `ccdm-<project>`, records `webhook_id` in the registry, and keeps the token only in private Router state.
5. Run `scripts/conversation-reminder-service.py assignment-changed --project <project>`, then start through the matching launcher.
6. Check `node scripts/router.js status`: the project is connected in its channel and root has no missing channel permissions. Optionally `node scripts/router.js probe <project>` to confirm the webhook round trip.
7. Thread Conversations need no registration step: they are on for every project once the Thread Supervisor runs. While threads are enabled, `router status` must show `thread_permissions=ok` for the new channel; if root's thread permissions are missing there, grant them once by hand.

## Deregister
1. Stop fully with `scripts/stop-session.sh <project> --all`, which stops the channel session and its Thread Conversations.
2. Run `node scripts/router.js delete-webhook <project>` (deletes the webhook and its token and clears `webhook_id`; a rerun is a no-op).
3. Revoke guests with `scripts/guest-access.js revoke`, remove the entry, then run `assignment-changed`. The Thread Supervisor sets the project's threads `closed/deregistered` without a Discord call; `scripts/threads.sh list` (unfiltered, since the project is no longer registered) confirms it.

## Gotchas
- Changing a registered project's `channel_id` closes its threads (`closed/project-moved`); they do not follow the channel.
- The Router reloads the registry itself; no Router or session restart is needed for a new channel or guest.
- The Router heals a webhook deleted in Discord by recreating it once, updating `webhook_id`, and running `assignment-changed` itself. A second deletion in a row fails replies with `webhook_deleted` until `ensure-webhook` runs. A lost token with a known `webhook_id` is refetched through the bot.
- Webhook usernames containing `discord` or `clyde` are sanitized by the Router, so a project name such as `discord-root-agent` is fine.
- Never substitute a different Discord MCP for an authorized administration workflow; keep REST mutations limited to the exact guild, category, channel, and permissions the user requested.
- Update JSON structurally and preserve optional account/model fields. Never write a bot or webhook token to the registry.
- Never register a project in Plan A general unless explicitly requested.
- Never copy an old `assignment_generation` into a re-registration; polling cannot detect an identical delete/re-add, so the generation contract must run.

## Verify
- [ ] `router status` shows the project's session connected with its channel as scope, and its webhook present.
- [ ] Registry `channel_id` and `webhook_id` match Discord.
- [ ] Start/stop E2E coverage still passes.

## Update Scaffold
- [ ] Record any schema or lifecycle change.
