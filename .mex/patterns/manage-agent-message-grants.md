---
name: manage-agent-message-grants
description: Allow, revoke, or list one-way Agent Message Grants between registered projects.
triggers:
  - "agent message grant"
  - "allow agent messages"
  - "revoke agent messages"
  - "list agent message grants"
  - "agent_message_targets"
edges:
  - target: context/discord-security.md
    condition: before changing Agent Message Grants or Session Scope rules
  - target: patterns/register-project.md
    condition: when registering or deregistering a project that may have stale grants
  - target: patterns/root-commands.md
    condition: for root's full everyday command list
last_updated: 2026-11-25
---

# Manage Agent Message Grants

## Context
An Agent Message Grant is the owner's one-way permission (`projects.<from>.agent_message_targets` in `registry.json`) for every Project Conversation of `<from>` (its Channel Conversation and Thread Conversations) to send Agent Requests to every Project Conversation of `<to>`. Same-project messaging needs a self-grant (`<from>` and `<to>` equal). Grants never expand Session Scope and never apply to `root` or `remote:` projects.

Project sessions never edit grants, and root never edits `registry.json` by hand. Run `scripts/ccdm agent-messages` with the Bash tool from the CCDM checkout; the command is the same on macOS and Windows and writes through the shared registry lock.

## Steps

### Allow a direction
1. Run `scripts/ccdm agent-messages allow <from> <to>`.
2. If `<from>` has guests (`guest_user_ids`), the command prints a warning naming the guest count on stderr and still records the grant. Tell the owner so they know guests in `<from>` can trigger Agent Requests to `<to>`.
3. If either project is unknown or has a `remote:` path, the command prints `ccdm: …`, exits 1, and leaves `registry.json` unchanged.
4. No Router or session restart is needed: the Router hot-reloads the registry and applies the grant on the next send.

### Revoke a direction
1. Run `scripts/ccdm agent-messages revoke <from> <to>`.
2. Removing an absent grant exits 0 and says there was nothing to remove.
3. No Router or session restart is needed: the Router refuses new requests from `<from>` to `<to>` as `not_granted` on the next send. Open requests already accepted are untouched and either receive their reply or expire.

### List grants and clean up stale targets
1. Run `scripts/ccdm agent-messages list` (or `scripts/ccdm agent-messages list <project>` to filter to grants involving one project, and add `--json` to parse the output).
2. Each line prints `from -> to`. Any target that is no longer a registered project is flagged `(stale)`.
3. Revoke stale targets with `scripts/ccdm agent-messages revoke <from> <stale_target>`.

## Gotchas
- Grants are one-way: allowing `A` to message `B` does not let `B` send requests to `A` (replies to an open request need no grant).
- Deregistering a project does not automatically remove grants pointing to it. A project later registered under that old name inherits any stale grant left in another project's `agent_message_targets`, so run `scripts/ccdm agent-messages list` and revoke stale entries during deregistration and before reusing a project name.
- Never hand-edit `agent_message_targets` in `registry.json`: concurrent writers (Router webhook updates, session starts/stops, guest updates) share the registry lock with `scripts/ccdm agent-messages`.

## Verify
- [ ] `scripts/ccdm agent-messages list` reflects only the intended `from -> to` grants and no unintended `(stale)` targets.
- [ ] When a sender has guests, the guest-count warning was relayed to the owner.
- [ ] No Router or session restart was needed for the Router to enforce the updated grants.

## Debug
- If `allow` fails with `ccdm: unknown project: …`, check `scripts/ccdm list` for the exact registered project name.
- If `allow` fails mentioning a `remote:` project, explain that `remote:` projects do not take part in local Agent Messages.
- If a newly allowed send still returns `not_granted`, check `node scripts/router.js status` for a registry load error.
- Router refusal codes for `agent_request`, `agent_reply`, and `agent_targets` (see `README.md` under Agent Messages → Refusal codes for when each happens and whether anything is posted): `invalid_args`, `forbidden`, `ledger_unavailable`, `not_granted`, `unknown_target`, `ambiguous_target`, `text_too_long`, `request_rate_exceeded`, `open_requests_exceeded`, `depth_exceeded`, `target_closed`, `target_offline`, `unknown_request`, `request_expired`, `already_replied`, `request_failed`.

## Update Scaffold
- [ ] Update `.mex/ROUTER.md`, `.mex/patterns/root-commands.md`, and `CLAUDE.md.example` if `scripts/ccdm agent-messages` verbs change.
