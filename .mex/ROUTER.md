---
name: router
description: Session bootstrap and navigation hub. Read at the start of every session before any task. Contains project state, routing table, and behavioural contract.
edges:
  - target: context/architecture.md
    condition: when working on system design, integrations, or understanding how components connect
  - target: context/stack.md
    condition: when working with specific technologies, libraries, or making tech decisions
  - target: context/conventions.md
    condition: when writing new code, reviewing code, or unsure about project patterns
  - target: context/decisions.md
    condition: when making architectural choices or understanding why something is built a certain way
  - target: context/setup.md
    condition: when setting up the dev environment or running the project for the first time
  - target: context/session-management.md
    condition: when starting, stopping, registering, or deregistering project sessions
  - target: context/discord-security.md
    condition: when changing bot permissions, guest access, channel routing, or credentials
  - target: patterns/INDEX.md
    condition: when starting a task — check the pattern index for a matching pattern file
last_updated: 2026-09-25
---

# Session Bootstrap

If you haven't already read `AGENTS.md`, read it now — it contains the project identity, non-negotiables, and commands.

Then read this file fully before doing anything else in this session.

## Current Project State
**Working:**
- Guest management and usage reporting read root credentials from root Discord state. Exports no longer borrow an unrelated pool token, and project launches no longer pass management credentials, allowing project bots to run without Administrator.
- Root bot manages a registry-backed pool of isolated Discord project bots.
- Claude sessions run through the official Discord plugin; Codex sessions run through `scripts/codex-bridge.js`.
- Opt-in Claude project launches can route that plugin through a launch-scoped reminder adapter that filters `/close` and records reply and lifecycle events; the adapter itself does not send reminders. Its capability marker is bound to the live adapter process and cleared by stop, exit, and every new launch, so a plain restart reports the channel unsupported.
- The foreground Conversation Reminder service observes registered project channels with root credentials, consumes both provider adapters' durable events, and persists owner closure, acknowledgment, reopening, and due times in a private SQLite store. `enable` is the manual opt-in: it validates both provider adapters (no Codex-only release), the registry owner, and root credentials without side effects, prepares the private state only once every blocker clears, then requests bounded, checkpointed discovery of older conversations. Assigned-bot emoji delivery, cleanup, failure handling, and recovery of uncertain sends are implemented: ambiguous sends retry with the same `enforce_nonce` nonce, and the running worker (or operator `recover`) identifies a lost reminder only by replaying that nonce inside Discord's duplicate-check window, never by adopting a bot `👀` from history; after the window it releases the channel only when history proves nothing was sent, and otherwise keeps it suspended with the unbound candidates listed. Any owner reaction, including one on a reminder, acknowledges without entering a coding turn; the root observer's and Codex bridge's copies of one reaction share a stable identity and count once. A reaction-started Codex turn and the automatic `response.failed` retry keep the owner interaction, and a delivered Codex reply whose receipt cannot be stored still returns success. A Codex root reserves `/close` in Claude project channels too. A worker restart, wake from sleep or wall-clock jump, Gateway disconnect/reconnect, or re-enable sends ready channels through restart reconciliation, which reuses the discovery traversal from the persisted acknowledgment, applies missed owner activity and buffered adapter replay, and pauses on undatable reactions before release. Overdue channels get at most one catch-up behind a durable five-second global gate that Discord 429s extend; the next hour anchors to the catch-up send. `status` reports per-channel readiness across adapters, observation, history, assignments, and uncertain delivery. Readiness blockers name their fix (`DISCORD_BOT_TOKEN`, the Claude adapter relaunch command, or starting the worker for untracked history). Registry changes retire obsolete assignment generations before further sends; `assignment-changed` issues a fresh generation for registration workflows and immediately deletes the retired reminders with the retired bot, reporting anything it cannot delete as inaccessible.
- The opt-in `scripts/install-conversation-reminder-service.sh` supervises that same worker as the `com.discord.conversation-reminders` LaunchAgent. The installer validates the interpreters, both provider adapters, the owner, root credentials, and the store with the read-only `preflight` before touching launchd. It renders a secret-free plist with private state and logs, and restores the prior plist and loaded service if a replacement load fails. The LaunchAgent relaunches only after an unsuccessful exit, so `disable` stays stopped. Supervised and foreground launches share one worker lock, and both providers' reply, reminder, and reply-or-close workflows are proven through it with Local Fakes.
- Start, stop, registration, guest access, command relay, voice transcription, and local-fake E2E coverage are present.
- Local Claude and Codex project bots can export an inclusive Discord message range to a temporary text file.
- Codex Discord tools can read the last requested 1-10,000 messages in their scoped channel, returning larger reads as private temporary transcripts.
- Per-project Claude and Codex account, model, and effort overrides are supported.
- Named Codex Account aliases and `default_codex_account` select root and project Codex Homes, while legacy `codex_home` and root overrides remain supported.
- `scripts/setup-codex-mimo.py` prepares isolated MiMo Codex homes with private file-backed provider authentication, validated vendor catalogs, and key rotation; existing named-account launchers select them without lifecycle changes.
- `scripts/setup-codex-deepseek.py` prepares DeepSeek Flash homes with private credentials and key rotation, extracting the vendor catalog as data without executing its installer; `deepseek-flash` currently selects V4.1 Flash with image support; optional `--with-exa` adds hosted web search/page reading.
- Project Codex launches resolve and validate the selected named or legacy home before MCP cleanup, tmux creation, or PID recording through `scripts/resolve-codex-home.py`.
- Project Codex launches support explicit `--resume <thread_uuid>` for saved conversations, including a copied rollout after a home change; resume waits for listener readiness and cleans runtime state on failure, without falling back to a fresh thread.
- Codex startup waits for the scoped Discord reply tool, uses a no-action bootstrap, and tracks bootstrap completion or explicitly interrupts on timeout.
- The Codex bridge retries a generic terminal `response.failed` once when the failed turn produced no agent work.
- The Codex bridge can pause new turns in memory, queue incoming messages, and resume them in order.
- Root Codex sessions steer active turns for the same channel and author while preserving the active Discord grant; other channels/authors queue, and failed steering falls back to a fresh scoped turn.
- The Codex bridge forwards allowed users' 👍 and 👎 reactions on its own messages to the active Codex thread.
- The tracked Usage Stats Poster discovers named and legacy Codex Homes, deduplicates shared homes, and falls back from live rate limits to recent session JSONL data.
- The tracked Usage Stats Poster also collects sanitized UTC 10-minute snapshots in a private SQLite history, retains them for 365 days, warns on feature-owned history growth, and posts the original text Usage Report embed per UTC 30-minute slot without any image attachment; the local posts ledger and advisory lock make retries idempotent.
- The Usage Stats Poster reports a configured DeepSeek home from its DeepSeek setup marker and private `api-key`: it validates the documented user-balance schema (USD/CNY only, every amount required and preserved exactly), fetches one account-wide balance per distinct key, and pairs it with this machine's local DeepSeek token totals, rendering a compact `deepseek (API)` text block with a bold balance, paid/granted breakdown, monthly local totals, and a short balance/local footer instead of a coverage paragraph. An optional `deepseek_balance_references` display budget (USD/CNY positive decimals) draws the same inline used-balance text bar with used and remaining percentages as the other limits and is never inferred from the current balance; conflicting shared-key references omit the bar with a clear status while the real balance and local usage stay visible.
- The opt-in `scripts/install-usage-stats-poster.sh` renders, validates, and idempotently loads a 600-second interval-only secret-free LaunchAgent for the tracked text-only Usage Stats Poster with no Pillow dependency (the separate `scripts/usage-dashboard-renderer.py` trend renderer keeps Pillow as an optional manual dependency), restoring the prior plist and loaded schedule when a replacement load fails.
- Fresh setup output, `registry.example.json`, and the operator README expose generic named-account fields, precedence, migration, and rollback guidance without local credentials or account paths.

**Not built:**
- Remote VM lifecycle operations are documented but intentionally performed by the user on the remote host.
- The unpublished `mex-mcp` integration is not installed; this repo uses the stable CLI through `npx`.

**Known issues:**
- Sessions do not survive machine restarts.
- Claude OAuth tokens can expire after an account is idle and refresh on the next login/session.
- Voice transcription depends on optional local `whisper`.

## Routing Table

Load the relevant file based on the current task. Always load `context/architecture.md` first if not already in context this session.

| Task type | Load |
|-----------|------|
| Understanding how the system works | `context/architecture.md` |
| Working with a specific technology | `context/stack.md` |
| Writing or reviewing code | `context/conventions.md` |
| Making a design decision | `context/decisions.md` |
| Setting up or running the project | `context/setup.md` |
| Starting, stopping, or registering sessions | `context/session-management.md` |
| Permissions, guests, routing, or credentials | `context/discord-security.md` |
| Any specific task | Check `patterns/INDEX.md` for a matching pattern |

## Behavioural Contract

For every task, follow this loop:

1. **CONTEXT** — Load the relevant context file(s) from the routing table above. Check `patterns/INDEX.md` for a matching pattern. If one exists, follow it. Narrate what you load: "Loading architecture context..."
2. **BUILD** — Do the work. If a pattern exists, follow its Steps. If you are about to deviate from an established pattern, say so before writing any code — state the deviation and why.
3. **VERIFY** — Load `context/conventions.md` and run the Verify Checklist item by item. State each item and whether the output passes. Do not summarise — enumerate explicitly.
4. **DEBUG** — If verification fails or something breaks, check `patterns/INDEX.md` for a debug pattern. Follow it. Fix the issue and re-run VERIFY.
5. **GROW** — After meaningful work, run this binary checklist:
   - **Ground:** What changed in reality? Name the changed behavior, system, command, dependency, or workflow.
   - **Record:** If project state changed, update the "Current Project State" section above. If documented facts changed, update the relevant `context/` file surgically.
   - **Orient:** If this task can recur and no pattern exists, create one in `patterns/` using `patterns/README.md`, then add it to `patterns/INDEX.md`. If a pattern exists but you learned a gotcha, update it.
   - **Write:** Bump `last_updated` in every scaffold file you changed. If the why matters, run `mex log --type decision "<what changed and why>"` or `mex log "<note>"`.
