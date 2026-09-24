---
name: analyze-codex-usage
description: Investigate local Codex usage across accounts without double-counting copied rollouts or inherited subagent history.
triggers:
  - "Codex usage investigation"
  - "account consumption"
  - "historical token analysis"
edges:
  - target: context/architecture.md
    condition: always before locating Codex homes and rollouts
  - target: context/session-management.md
    condition: when conversations were copied or resumed across homes/accounts
last_updated: 2026-09-24
---

# Analyze Codex Usage

## Context

Load `context/architecture.md`. Use current official OpenAI documentation (via a docs skill if one is available) for product and rate claims. Account aliases and physical homes are different concepts: conversations can be copied and resumed under another account.

## Steps

1. Fix an explicit UTC cutoff and equal-length comparison periods. Discover registered named/legacy homes plus local Codex homes; resolve symlinks and deduplicate physical paths. Never print whole registry/config/auth files.
2. Read active and archived rollout JSONL and thread metadata. Open input SQLite databases with `mode=ro`. Keep analytical scratch data and private reports outside tracked files. Record missing indexed rollout paths and parse failures.
3. Preserve the first session identity in each file. Forked histories can contain a second, inherited parent `session_meta`; it must not replace the child identity.
4. Remove inherited fork prefixes before counting usage. Some versions rewrite inherited events with the child's creation timestamp and retain parent settings, turn IDs, and token counters. Timestamp filtering and model-name presence alone are insufficient. Identify the first native child turn context using the observed schema; UUIDv7 turn creation time at/after child creation can establish this in compatible versions. Inspect samples and report uncertainty when this cannot be established.
5. Use inherited counters only as a baseline, then count positive cumulative usage increments. Skip unchanged counters and handle counter resets as new segments, checking `last_token_usage`. Never sum successive lifetime totals or add thread database totals to rollout totals.
6. Deduplicate copied events across files using conversation identity, timestamp, and cumulative counter signature. Check conflicting copies rather than arbitrarily summing them. Retain home sightings separately from usage.
7. Attribute accounts using independent saved allowance-window observations where possible. Small reset-time jitter may be tolerated, but zero-usage deadlines can move and fallback observations can be stale. Retain home-only or ambiguous attribution when evidence is insufficient; do not infer account identity from the current file location alone.
8. Compare models, projects, sources, reasoning effort, context size, and waiting/polling. Distinguish explicit subagent threads from separately launched exec workers. Inspect concrete high-usage conversations before calling activity wasteful.
9. Separate provider/API usage from subscription claims. If weighting tokens using current documented rates, label this a fixed-rate comparison proxy, not billed spend or measured subscription allowance. Show cache and output categories without double-counting cached input or reasoning output. Disclose unknown speed tiers and historical pricing limitations.
10. Deliver sanitized summaries, methodology, coverage limits, and optional charts/aggregate CSVs. Leave settings, accounts, and sessions unchanged unless changes were requested.

## Gotchas

- Fork replay can fabricate large daily spikes, including apparent parent activity in a child's file. Resolve inherited history before ranking projects or dates.
- A source labelled `vscode` can be a Discord bridge session; do not infer the user's UI from it.
- A tool/action association is not causal billing attribution. Polling inside execution wrappers may be missed, and some waiting is necessary.
- A raw-token leader can be inexpensive when it uses a cheaper model. Cached input remains a nonzero cost under documented rates.
- Percentage readings from different accounts or reset windows are not additive. Different plan labels need not represent equal capacity.
- An absent local rollout is missing evidence, not proof of zero remote/API consumption.

## Verify

- [ ] Fixed cutoff, period lengths, and time zones are explicit.
- [ ] Fork-prefix samples and cross-home duplicates were inspected.
- [ ] Retained records satisfy input plus output equals total and cached input does not exceed input, or exceptions are explained.
- [ ] Missing files, parse errors, unknown models/tiers, and account-attribution limits are reported.
- [ ] Deliverables contain no credentials, Discord scope tokens, or unnecessary channel IDs/raw messages.
- [ ] No session/account change was made merely to inspect history.
- [ ] After scaffold edits, run `npx mex-agent check`.

## Debug

Unexpected spikes: inspect token-event timestamp clusters, multiple session metadata records, inherited turn IDs, cumulative counter resets, and copied files before blaming a model loop. Unexpected account changes: compare reset-window history and home migration evidence without reading credentials.

## Update Scaffold

- [ ] Record reusable counting/schema gotchas here, not private account statistics
- [ ] Update `.mex/context/architecture.md` or `.mex/ROUTER.md` state only if operational behavior changed
