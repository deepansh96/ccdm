---
name: decisions
description: Key architectural and technical decisions with reasoning. Load when making design choices or understanding why something is built a certain way.
triggers:
  - "why do we"
  - "why is it"
  - "decision"
  - "alternative"
  - "we chose"
edges:
  - target: context/architecture.md
    condition: when a decision relates to system structure
  - target: context/stack.md
    condition: when a decision relates to technology choice
  - target: context/session-management.md
    condition: when changing lifecycle or process ownership
  - target: context/discord-security.md
    condition: when changing channel isolation or reply authority
last_updated: 2026-07-24
---

# Decisions

<!-- HOW TO USE THIS FILE:
     Each decision follows the format below.
     When a decision changes: DO NOT delete the old entry.
     Mark it as superseded, add the new entry above it.
     The history must be preserved — this is the event clock. -->

## Decision Log

### Export long Discord history through a shared, read-only MCP tool
**Date:** 2026-07-24
**Status:** Active
**Decision:** Reuse the repository's range exporter through the Codex Discord MCP and an export-only MCP config generated for local Claude sessions.
**Reasoning:** Temporary transcripts keep large ranges out of MCP responses, and a separate helper avoids modifying Anthropic's update-managed Discord plugin.
**Alternatives considered:** Expand `fetch_messages` responses or patch the official Claude plugin; rejected because large results consume model context and plugin updates overwrite local edits.
**Consequences:** Local Claude sessions receive a token-free generated MCP config, Codex uses its existing scoped server, and remote Claude hosts require the helper to be deployed separately.

### Use root AGENTS.md as the canonical agent anchor
**Date:** 2026-07-19
**Status:** Active
**Decision:** Keep root `AGENTS.md` as the only real anchor file; `CLAUDE.md` and `.mex/AGENTS.md` symlink to it.
**Reasoning:** The repository requires `AGENTS.md` to be the cross-tool source of truth while Claude and mex must receive identical instructions.
**Alternatives considered:** Keep mex's normal copied anchors; rejected because separate files can drift and conflict with the required root canonical file.
**Consequences:** Unix/macOS checkouts work directly; native Windows checkouts must preserve Git symlinks or replace them with synchronized regular files.

### Use one central registry and generic lifecycle scripts
**Date:** 2026-03-23
**Status:** Active
**Decision:** Store bot/project assignments in `registry.json` and manage every project with shared start/stop scripts.
**Reasoning:** Per-project scripts duplicated lifecycle logic and made assignment state difficult to audit.
**Alternatives considered:** Keep one script per project; rejected because every new project copied operational code.
**Consequences:** New session types and registry fields must remain backward-compatible with existing entries.

### Isolate every project bot to one Discord channel
**Date:** 2026-03-23
**Status:** Active
**Decision:** Deny project bots category visibility and add a member allow override only on the assigned channel.
**Reasoning:** Project agents may handle private repositories and must not read unrelated channels.
**Alternatives considered:** Rely only on bot prompt/access allowlists; rejected because Discord permissions provide a stronger outer boundary.
**Consequences:** Registration, deregistration, and guest access must update Discord permissions and local allowlists together.

### Use tmux for local session ownership
**Date:** 2026-04-12
**Status:** Active
**Decision:** Run long-lived Claude and Codex sessions in named tmux sessions.
**Reasoning:** tmux is available on target hosts and supports inspection, command relay, and deterministic teardown.
**Alternatives considered:** GNU screen; superseded because tmux provides the maintained session interface used by the scripts.
**Consequences:** Launches use `zsh -ic`, and sessions must be restarted after reboot.

### Give Codex explicit scoped Discord write tools
**Date:** 2026-05-22
**Status:** Active
**Decision:** Codex sends user-visible messages only through dynamically registered Discord MCP tools protected by a per-turn scope token.
**Reasoning:** Automatic text streaming could leak intermediate output and let delegated agents post outside parent control.
**Alternatives considered:** Stream all assistant deltas or accept plain-text fallback by default; rejected for privacy and routing correctness.
**Consequences:** The top-level agent must call `reply`, `edit_message`, or `react`; subagents return results only to their parent.

### Default E2E tests to local fakes
**Date:** 2026-05-28
**Status:** Active
**Decision:** Run serialized black-box tests with fixture binaries and JS shims, gating live smoke tests behind `CCDM_LIVE_E2E=1`.
**Reasoning:** CI and local tests must not operate real bots, sessions, credentials, or networks.
**Alternatives considered:** Mock internal functions or run live integrations; rejected because black-box local fakes better exercise scripts without external side effects.
**Consequences:** New integration behavior needs a fixture-backed E2E case rather than a live dependency.
