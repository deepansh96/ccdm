---
name: discord-security
description: Security boundaries for bot channels, users, credentials, replies, and guest access.
triggers:
  - "Discord permission"
  - "guest access"
  - "scope token"
  - "allowlist"
  - "bot token"
edges:
  - target: context/architecture.md
    condition: when tracing Discord messages through project agents
  - target: context/session-management.md
    condition: when permissions are part of registration or lifecycle work
  - target: patterns/manage-guest-access.md
    condition: when granting, syncing, listing, or revoking guest access
  - target: patterns/debug-discord-session.md
    condition: when a bot cannot read or reply in its assigned channel
last_updated: 2026-07-19
---

# Discord Security

## Bot Isolation

Each project bot gets the zero-permission `project-bot` role with `VIEW_CHANNEL` denied on managed categories, then a member-level allow override only on its assigned channel. The root bot can see managed channels but requires mention outside its root channel. Local `access.json` allowlists are required in addition to Discord permissions.

## Credentials

Bot tokens live only in ignored `registry.json` and per-bot `.env` state files. Claude and Codex auth live under their configured account homes. Never include token values, `auth.json`, Keychain data, or the current bridge scope token in logs, docs, tests, or delegated prompts.

## Codex Replies

The bridge dynamically registers one Discord MCP server for its channel. User-visible writes require the current top-level bridge scope token. Subagents must return to their parent and must not use Discord MCP tools. Plain text fallback is opt-in per project and should remain off when intermediate output could leak.

## Guests

Use `scripts/guest-access.js`; do not create generic server invites. `invite` or `grant` creates/synchronizes the project role, denies other managed locations, allows the target channel, and updates both registry and bot allowlists. Restart the project session after access changes. `revoke` removes the role and all allowlist entries.

Project-specific user and channel access exceptions live in ignored `CLAUDE.local.md`. Apply those rules without copying local IDs into tracked files.

## Routing Rules

Project bots ignore unrelated channels. Codex bridges ignore root-bot mentions to prevent duplicate responses. The root bot handles management commands and Claude slash-command relay; it must not forward those relay commands as ordinary agent prompts.
