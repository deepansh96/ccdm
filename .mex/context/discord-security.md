---
name: discord-security
description: Security boundaries for Session Scope, users, credentials, replies, and guest access.
triggers:
  - "Discord permission"
  - "guest access"
  - "scope token"
  - "allowlist"
  - "bot token"
  - "session scope"
edges:
  - target: context/architecture.md
    condition: when tracing Discord messages through project agents
  - target: context/session-management.md
    condition: when permissions are part of registration or lifecycle work
  - target: patterns/manage-guest-access.md
    condition: when granting, syncing, listing, or revoking guest access
  - target: patterns/debug-discord-session.md
    condition: when a session cannot read or reply in its channel
last_updated: 2026-10-01
---

# Discord Security

## Session Scope

The Router enforces isolation in software. Every operation names a `channel_id`: a project session's must equal its registered channel, and every `message_id` target is fetched and must belong to that channel. Anything else is rejected with `scope_violation` and logged with project, operation, and target, and `router status` lists recent violations. Root may target root channels and any registered channel; the reminder observer is read-only (`forbidden` on any operation). A new launch key revokes the session holding the old one, so one session serves one project channel.

Project replies post through the project's own webhook, and a project may edit only its own webhook messages; reactions and typing show as the root bot. Provenance is `webhook_id` only, never an application ID or display name.

The `project-bot` role and per-channel override model is obsolete: Discord permissions are no longer the isolation boundary, and `scripts/retire-pool.sh` deletes the role. The root bot needs Send Messages, Read Message History, Add Reactions, and Manage Messages in every project channel, plus Manage Webhooks; `router status` and reminder readiness name each missing permission. Isolation between local sessions is software-enforced, not an OS sandbox (ADR 0004).

## Thread Conversations

A Thread Conversation's Session Scope is its thread alone. The `thread` role is checked once at hello: the key must match `keys/.thread-<thread_id>.key`, and the thread must be a public thread (type 11) whose parent is the project's registered channel. Every op must name that thread. The parent channel, sibling threads, root channels, parent messages and the starter message (whose id is the thread id) are `scope_violation`. Thread replies use the parent project's webhook with `thread_id`. A thread key change revokes only that thread, and a project key rotation leaves its threads connected.

The Thread Supervisor holds no Discord credential and makes no direct Discord REST call. It connects as the single `supervisor` role (`keys/.supervisor.key`, rewritten on each start), and every Discord action it takes is a supervisor-only Router op confined to registered project channels and their eligible threads. Its notices post as the root bot. Its `thread_message` copy of bot and webhook messages is for reply tracking only; bot and webhook messages still never reach sessions.

Root needs four permissions for threads, granted once by hand; no script PATCHes them:

- Create Public Threads, Send Messages in Threads and Manage Threads in every project channel;
- View Audit Log on the guild, which the supervisor uses to tell an owner or root archive from an auto-archive.

`router status` and reminder readiness report missing bits only while threads are enabled.

## Credentials

The root bot token is CCDM's only Discord credential. It lives in `ROOT_DISCORD_STATE_DIR/.env` (default `~/.claude/channels/discord/.env`) and is read by the Router, root's emergency fallback, and root admin tools (guest access, registration REST work, operator exports, the usage poster). Missing or invalid root credentials fail before Discord requests. No session environment, file, or MCP config holds a Discord token: sessions get only a per-launch key file path. Webhook tokens live only in private Router state (0600) and never in `registry.json`, logs, or `router status` output. Claude and Codex auth live under their configured account homes. Never include token values, `auth.json`, Keychain data, launch keys, or the current bridge scope token in logs, docs, tests, or delegated prompts.

## Codex Replies

The bridge dynamically registers one Discord MCP server for its channel, backed by the Router. User-visible writes require the current top-level bridge scope token. Subagents must return to their parent and must not use Discord MCP tools. Plain text fallback is opt-in per project and should remain off when intermediate output could leak.

## Guests

Use `scripts/guest-access.js`; do not create generic server invites. `invite` or `grant` creates/synchronizes the project role, denies other managed locations, allows the target channel, and updates the registry's `guest_user_ids`. The Router reloads guests from the registry, so a grant or revoke applies to the next message without a restart. `revoke` removes the role, the registry entry, and outstanding invites. Guests can never reach root: their bot mentions are dropped.

Project-specific user and channel access exceptions live in ignored `CLAUDE.local.md`. Apply those rules without copying local IDs into tracked files.

## Routing Rules

At Router message ingress, only Discord default (0) and reply (19) messages are eligible; all system notices are dropped before session or observer routing. Only owner and channel-guest messages and reactions are forwarded (in a thread, the guests of its parent channel, read on every message); bot and webhook messages never reach sessions. Root channels (`root_channels`) go to root for the owner and `root_allowed_user_ids`. In a project channel, a bot mention or a native reply to a root-bot message goes to root only, preventing duplicate responses; a reply to the project's webhook message goes to the project. Plain management commands go to the project session, and `/close` goes only to the reminder observer. A thread message reaches only its Thread Conversation; the thread's `/close`, `/config`, `/restart` and `/clear`, and a channel's `/thread` and `/config`, reach only the Thread Supervisor. A channel with no live session gets 💤, with no replay, and so does a thread message with neither a live session nor a supervisor; a project without `webhook_id` (not yet migrated) is dropped without 💤, since its old pool bot may still serve it.
