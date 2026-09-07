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
last_updated: 2026-09-07
---

# Decisions

### Keep the legacy Usage Report beside provider dashboards
**Date:** 2026-08-23
**Status:** Active
**Decision:** Each automated Usage Stats post is one atomic Discord message containing the original bounded text Usage Report embed plus two PNG attachments, one each for Claude and Codex. Codex remains weekly-only, charts begin at the earliest real stored slot, and Claude API-key accounts remain graph outliers with sanitized cost facts in the Claude rail.
**Reasoning:** The text summary remains faster to scan and accessible when images are inconvenient, while the two provider-specific images retain historical trends. Reusing one message preserves the existing slot ledger and avoids partial delivery or duplicate retries.
**Alternatives considered:** Send the text report as a second Discord message or restore a text-only schedule; rejected because separate delivery weakens slot idempotency and removing the images loses trend history.
**Consequences:** Manual JSON posting remains independent of SQLite, and scheduled posting reuses the same formatting and Discord field-size bounds before attaching both images.

### Keep Usage Stats history local, sanitized, and slot-idempotent
**Date:** 2026-08-18
**Status:** Active
**Decision:** The opt-in Usage Stats LaunchAgent runs every 600 seconds, records one sanitized snapshot per UTC 10-minute slot in a private SQLite database, and uploads its combined text-and-dashboard report only once per UTC 30-minute slot using an advisory lock and posts ledger. Snapshot retention is 365 days; feature-owned size warnings are suppressed for 24 hours and never traverse agent source logs.
**Reasoning:** Local history enables meaningful trend rendering without introducing a remote service or persisting credentials/transcripts/paths. Ten-minute collection tolerates LaunchAgent drift while the 30-minute ledger prevents duplicate Discord posts.
**Alternatives considered:** Keep only the current text embed or write raw provider/session files; rejected because neither supports a reliable trend view and raw files would expand credential/privacy scope.
**Consequences:** The installer must remain interval-only and rollback-safe; the renderer stays credential- and Discord-free, and manual JSON posting remains available for compatibility.

### Render provider-specific Usage Stats dashboards without migrating history
**Date:** 2026-08-19
**Status:** Superseded by “Keep the legacy Usage Report beside provider dashboards” (2026-08-23)
**Decision:** An automated Usage Stats post contains two PNG attachments, one each for Claude and Codex. Codex is rendered as a weekly limit only, and legacy schema-v1 Codex `5-hour` cards are translated in the in-memory render payload rather than rewritten in SQLite. Charts begin at the earliest real stored slot. Claude API-key accounts remain graph outliers and instead expose sanitized local cost/count/status facts in the Claude rail.
**Reasoning:** Provider-specific images reduce mixed-limit ambiguity while retaining the existing private, slot-idempotent database and post ledger. A render-time compatibility mapping avoids a destructive database migration.
**Consequences:** One scheduled post remains one ledger row and one Discord message, manual JSON embeds remain independent, and renderer payloads may include safe provider notes that are never persisted as transcript paths or raw records.

### Validate Codex homes before lifecycle mutation
**Date:** 2026-08-16
**Status:** Active
**Decision:** Project Codex startup and root Codex restart use `scripts/resolve-codex-home.py` to resolve named or legacy selectors and validate the selected home before stale MCP cleanup, tmux creation, PID recording, or root-session teardown.
**Reasoning:** A missing, malformed, or unusable home must fail with an actionable error without mutating a running project's configuration, registry state, or root listener. The resolver validates only global selectors and the target project's selectors for project launches; root restart applies its environment and top-level precedence without inspecting project entries.
**Alternatives considered:** Keep inline shell/Python precedence and validate after launch setup; rejected because command substitution can mask failures and lifecycle mutation would already have occurred.
**Consequences:** Successful project launches and root restarts pass only an absolute, normalized `CODEX_HOME` to the bridge. Named aliases use the same validation and precedence surface as legacy raw-home selectors; setup, the example registry, and operator documentation expose the generic configuration model.

<!-- HOW TO USE THIS FILE:
     Each decision follows the format below.
     When a decision changes: DO NOT delete the old entry.
     Mark it as superseded, add the new entry above it.
     The history must be preserved — this is the event clock. -->

## Decision Log

### Isolate CCDM Codex state with one optional shared home
**Date:** 2026-08-09
**Status:** Active
**Decision:** Allow a top-level registry `codex_home` to become the default for root and project Codex bridges, while keeping project `codex_home` and `ROOT_CODEX_HOME` as higher-priority overrides.
**Reasoning:** ChatGPT Desktop and mixed long-lived Codex runtimes can rewrite the same `models_cache.json`; a CCDM-only home separates that cache without duplicating configuration across projects or breaking existing installs.
**Alternatives considered:** Force `~/.codex-ccdm` for every install or require one override per project; rejected because the first would invalidate existing login expectations and the second repeats configuration.
**Consequences:** Isolation is opt-in and requires one login in the shared home; every CCDM app-server must be restarted together after a CLI upgrade.

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
