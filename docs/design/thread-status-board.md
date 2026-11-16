# Thread status board, owner pings, and never-archive: design

Status: built on `feat/thread-status-board` (2026-11-16). D1–D8 and D10 were accepted as proposed; D9 was changed (see §14). Code references are `path:line` on `origin/main` at 94a1b43, before the change.

## 1. What we are building

1. **Status board.** One or more root-bot messages in a dedicated status channel, edited in place. They list every non-closed Thread Conversation with its state, a jump link, provider/model, and the time since its last state change.
2. **Owner ping.** When a thread's turn passes to the owner, root posts `🔔 <@owner> ready for you` in that thread. At most one ping exists per thread, it mentions only the owner, and it is never sent after a stop, crash or `/close`.
3. **Never archive until `/close`.** Any archive outside the `/close` flow (`/close` itself, or `threads.sh close`) is reverted at once.

Thread names are not touched. Discord allows about 2 renames per 10 minutes, and names cannot show custom emoji.

## 2. Where "working" and "waiting on owner" come from

| Candidate | What it gives | Verdict |
|---|---|---|
| Supervisor `thread_message` (`inbound.js:163-179`: `author_class`, `delivered_to_session`, `to_root`) | When a driver input (owner or guest) reached the session, and when the agent replied (`project_webhook`) | **Used for inputs.** It says nothing about when a turn starts or ends. |
| Per-thread `activity.json` (`thread-activity.js:16-34`). Claude: running on every delivered notification (`ccdm-channel-server.js:555-559`), ended by the Stop/StopFailure hooks (`start-thread-session.sh:351-359`). Codex: running on `turn/started` (`codex-bridge.js:729-730`), ended only once the bridge is idle after `turn/completed` (`codex-bridge.js:880-882`) | A turn-running flag and turn-end time, for both providers, in a file the supervisor already owns and reads (`capacity.py:70-79`) | **Used for turns.** It exists today in every live thread launch, so no session restart is needed. |
| Conversation Reminder state (`conversation-reminder-service.py:46`, transitions `:583-632`) | `awaiting-owner` only after a receipt-backed reply to the *current* owner interaction (`:588-620`) | **Rejected as the source.** It is opt-in (`enable`), gated by readiness and discovery, and buffered during reconciliation (`:522-526`). It has no "working" state. A reaction moves it to `open-paused`. A reply sent without `conversation_interaction_id` never qualifies. The supervisor would also have to read another service's private store. |
| Codex `turn/completed`, Claude Stop hook directly | Exact turn ends | Already folded into `activity.json`. Adding a third channel would duplicate it. |

**Decision.** The **Thread Supervisor owns turn status, the board and the ping.** It is the only component that knows every lifecycle fact the rules depend on: `booting`, `queued`, `stopped/<reason>`, `closed`, crash detection (`boot.py:266-280`), and the `/close` ordering (`commands.py:84-99`). It reads turn activity from `activity.json` and driver inputs from its own `thread_message` stream.

Two new modules sit behind the existing event table (`dispatch.py:12-33`):

- `scripts/thread_supervisor/turns.py`: the whose-turn state machine and pings.
- `scripts/thread_supervisor/board.py`: rendering and syncing the board.

The worker loop already wakes every 0.25 s (`worker.py:84-104`). While connected it calls `turns.tick` every `CCDM_THREAD_STATUS_TICK_S` (2 s) and `board.flush` when the board is dirty. The reminder service is unchanged and keeps its own concept of an ignored reply that needs a reminder.

## 3. State machine

Persisted per thread (§8): `whose_turn` ∈ {null, `agent`, `owner`}, `last_input_at`, `last_input_class` ∈ {`owner`, `guest`, `starter`}, `turn_end_seen`, `turn_outcome`, `display_state`, `display_since`, `ping_message_id`.

**Inputs** (`turns.on_message`, called first in `boot.on_thread_message`, `boot.py:157`):

- **Owner message** of any kind, including commands, `to_root` and root mentions: delete the ping (§4).
- **Owner or guest driver message**: a message that is not a `COMMAND` (`boot.py:43`), not `to_root`, and not a root mention. Whether it was delivered, buffered while booting or queued, or is the trigger of a start, it sets `last_input_at=now`, `last_input_class`, and `whose_turn=agent`.
- **Creation first message** (`boot.start(..., starter=…)`): the same, with class `starter`.

**Turn end** (`turns.tick`, for `live` rows only):

1. Read `activity.json` when its `mtime_ns` changed. An unreadable file counts as busy, as in capacity.
2. Let `E` be `last_turn_end_at`. If `turn_running` is false and `E > turn_end_seen`, remember when `E` was first seen (in memory).
3. Once that `E` has held for `CCDM_THREAD_STATUS_SETTLE_S` (5 s) with `turn_running` still false:
   - set `turn_end_seen=E`;
   - **if** `whose_turn=agent`, `E ≥ last_input_at`, and the outcome is not `interrupted`, then set `whose_turn=owner` and `turn_outcome`, and try a ping (§4).

**Baselines.** `on_session_live` (`boot.py:238`) sets `turn_end_seen` to the file's current `E`, so an end left by the previous launch, or written while a stop killed the session, never counts. A row migrated from v1 takes its first observed `E` as its baseline, with no ping.

**Display state** is a pure function of the row and its cached activity, recomputed every tick for every non-closed row. When it changes, the tick sets `display_since=now` and marks the board dirty.

| Condition (first match) | Board |
|---|---|
| `closed` | not listed |
| `queued` / `booting` | ⏳ queued / starting |
| `live`, `turn_running` | ⏳ working |
| `live`, `paused` (activity v2, §9) | 💤 paused |
| `stopped/crashed`, `stopped/start-failed`, or `turn_outcome=failed` | ⚠️ crashed / start failed / turn failed |
| `whose_turn=owner` | 🔔 waiting on you, with `· session stopped` when not live and `· guest` when the last input was a guest's |
| `live`, `whose_turn=agent`, `last_input_at` < 60 s ago | ⏳ starting turn |
| anything else | 💤 idle / stopped / new |

**Cases the brief asks about:**

- **Turn ends with no reply.** It is still the owner's turn: 🔔 and a ping. With activity v2 the ping reads `finished without a reply` (§9).
- **Steered follow-up (Codex).** It joins the running turn, so one end means one ping. Its `last_input_at` precedes `E`.
- **Queued follow-up (Codex).** The bridge marks the turn idle and then starts the queued turn within ms. The 5 s settle window absorbs that gap, so only the final end pings.
- **Queued follow-up (Claude).** A notification delivered during the final answer may run as a new turn after Stop, and nothing marks that turn running. The first end pings (it did answer); the second end finds `whose_turn` already `owner` and stays silent. The board can show 🔔 while Claude works. The v2 `UserPromptSubmit` hook (§9) closes this gap if Claude fires it for channel prompts. **This must be verified live.**
- **`/pause`.** v1 shows 🔔 or ⏳-then-💤 (input pending). v2 shows 💤 paused. A turn already running still ends and pings.
- **Compaction or `/compact`, a `/restart` bootstrap, or a Codex `response.failed` retry.** These turns have no driver input since the last end, so `whose_turn` is unchanged and there is no ping. The board shows ⏳ while they run.
- **Crash.** `thread_session_revoked` sets the row `stopped/crashed` (`boot.py:266-280`): ⚠️, and no ping, because only `live` rows are evaluated. A crash that leaves `turn_running=false` is caught by the settle window plus a `lifecycle.session_running` check before pinging.
- **Stop or `/close`.** Every stop path is synchronous in the worker loop, so the row is no longer `live` by the next tick. Codex `interrupted` (v2) never pings.
- **Eviction or reverted archive.** `whose_turn` is kept, so an idle evicted thread stays 🔔 · session stopped. Whose turn it is does not change because a process went away.
- **`/clear` or a provider/account switch** reset `whose_turn=null`.

## 4. Pings

- **Eligible when:**
  - the row is `live`;
  - `lifecycle.session_running(thread_id)`;
  - `last_input_class` is not `guest`;
  - `thread_owner_pings` is not false (§7).
- **Post.** First delete the previous `ping_message_id`, if any, through `thread_notice_delete`. Then post `thread_notice {channel_id: thread, text: "🔔 {owner} ready for you", mention_owner: true}` (§6) and store the id. A failed turn uses `⚠️ {owner} the last turn failed`. A post that fails with `router_unavailable` or `rate_limited` is retried on later ticks for up to 5 minutes, and only while `whose_turn` is still `owner` and no owner message has arrived.
- **Delete:**
  - on the owner's next message in the thread (§3);
  - in `/close` and `threads.sh close`, before the archive PATCH (`commands.py:88-92`), because messages in an archived thread cannot be deleted;
  - when the next ping replaces it.
  
  A 404 counts as success. Any other failure is logged and the id is dropped, so at most one orphan can remain.
- **Native reply to a ping.** A reply to a ping is a native reply to a root-bot message, so today it routes to root, not the thread (`docs/thread-supervisor.md`, Routing). The Router will instead treat a native reply whose referenced root-bot message matches its own ping template (`^(🔔|⚠️) <@owner> `) as an ordinary thread message (§10, decision D8).

## 5. Never archive until `/close`

**New `lifecycle.on_thread_update`** (replaces `lifecycle.py:141-233`). On `archived` false→true for a bound row of that project:

- **Row `closed` or with `pending_close`:** accept. This is the `/close` / `threads.sh close` archive, since `commands.py:89-98` sets the row closed before the event is handled.
- **Any other actor** (Discord's 7-day auto-archive, an owner or guest archive in the UI, a root REST archive):
  1. call `thread_update {archived:false}` at once;
  2. if the row is `live`, its launcher has exited, and `activity.turn_running` is false, stop the session as `stopped/auto-archive` (the existing reason, now meaning "stopped because Discord archived it");
  3. `booting`, `queued` and mid-turn rows keep running.
  
  The row is never closed and `whose_turn` is kept.

**Why stop an idle session.** Discord archives on inactivity after `auto_archive_duration` (10080 min: `threads.js:17-18,79`, and PATCHed for owner-made threads). A session idle that long holds a capacity slot and, for Codex, a whole app-server. Resume is exact (`--resume` in the home the conversation started in, `boot.py:212-215`), so the stop loses nothing. The next owner or guest message resumes it, with the thread already unarchived. A manual archive by the owner during a turn is not taken as permission to kill work, so mid-turn sessions are kept.

**Consequences:**

- The audit-log actor lookup is no longer needed: `ArchivePoll`, `_poll`, `_classify` and the `thread_archive_actor` calls are removed. `owner-archive`, `root-archive` and `archive-actor-unknown` stay valid in the CHECKs for old rows but are no longer written.
- Guild **View Audit Log** is no longer required (D6). `router status` and reminder readiness drop it, and `AGENTS.md`, `discord-security.md` and `docs/thread-supervisor.md` lose it. The `thread_archive_actor` op stays for one release, unused, and is then removed.

**Other details:**

- **Reconcile** (`reconcile.py:76-80`): an archived listed thread whose row is not closed is unarchived and gets the same stop rule. After downtime its session is already `crashed` by `_mark_crashed`. Unbound archived threads are ignored, and `ARCHIVED_WITHIN_DAYS` stays 7.
- **Our own unarchive** produces true→false, which the handler ignores (`lifecycle.py:144`). The repeated `THREAD_CREATE` binds idempotently. A failed PATCH (403 without Manage Threads, 5xx) is logged and retried by the next reconcile; nothing loops.
- **Root posts.** A root post into an archived thread unarchives it. Pings only go to `live` threads, which are never left archived. The reminder service's send into an auto-archived thread (`docs/thread-supervisor.md`, Conversation Reminders) still works and now rarely triggers. Supervisor notices remain root-bot posts that the reminder service never counts as replies.

## 6. Router ops (supervisor role only; `forbidden` to every other role)

| Op | Args | Scope check (else `scope_violation`) | Discord call |
|---|---|---|---|
| `thread_notice` (extended) | `channel_id`, `text`, `mention_owner?: true` | With `mention_owner`: an eligible thread only (`threadTarget`, `threads.js:44`); `text` ≤ 300 chars, contains `{owner}` exactly once, and no other mention syntax (`<@`, `<@&`, `@everyone`, `@here`), else `invalid_args` | POST as root; `{owner}` becomes `<@ownerId>` from the Router's table; `allowed_mentions: {parse: [], users: [ownerId]}`. Without the flag it is unchanged (`parse: []`, `threads.js:202-213`). |
| `thread_notice_delete` | `channel_id`, `message_id` | An eligible thread; the fetched message is in that thread, has no `webhook_id`, and its author is the root bot | DELETE; 404 → `{deleted: false}` |
| `status_board_list` | `limit?` ≤ 50 | None: the target is the registry's status channel, never an argument | GET; returns only root-bot non-webhook messages `{id, content, timestamp}` |
| `status_board_post` | `text` ≤ 2000 | As above | POST, `allowed_mentions: {parse: []}` (`<#thread>` jump links render without pinging) |
| `status_board_edit` | `message_id`, `text` | The message is in the status channel and is root's own | PATCH through the existing `coalescedEdit` (`channel-actions.js:24-44`), key `status/<id>` |
| `status_board_delete` | `message_id` | As for edit | DELETE |

Every status op fails `status_channel_unset` when the key is absent. All of them use the root token through the shared REST queue under the client's deadline. `router status` gains a line, shown only when the key is set: `thread status channel: <id> permissions=ok|missing:<View Channel,Send Messages,Read Message History>`.

**Security.** No new role. No session, root or observer gains anything. The supervisor still has no credential. Its new reach is one registry-named channel, plus deletion of root's own messages in eligible threads. The only mention it can produce is the owner's, composed by the Router. `discord-security.md` gains these sentences in its Thread Conversations section.

## 7. Configuration

- **`thread_status_channel_id`** (Discord ID). The board is on only when it is set.
  - **Router validation** (`registry.js:25-57`): the value must be an ID that is neither a root channel nor a project channel. An invalid value never invalidates the registry: the rest of it loads normally, the board is off (`status_channel_invalid` from every status op), and the error shows in `router status` as `thread status channel: off (invalid: <reason>)` and in `--json` as `status_channel.error` (D9, as changed).
  - **Ingress.** Messages in that channel route nowhere: it is unregistered.
- **`thread_owner_pings`** (boolean, default `true`). It is independent of the board, so pings work without a status channel (D3).
- **Hot reload.** The Router's reload (`registry.js:99-116`) retargets the status ops at once. The supervisor rereads on `context.watch.changed()` (`worker.py:86`):
  - a changed channel id clears the `status_board` rows and reposts the board in full in the new channel (old messages stay; the operator deletes them);
  - an unset or invalid key clears the rows, stops board calls, and shows `board: off|invalid: <reason>` in `thread-supervisor.py status`;
  - nothing errors.
- **Tunables:** `CCDM_THREAD_STATUS_TICK_S` (2), `CCDM_THREAD_STATUS_SETTLE_S` (5), `CCDM_THREAD_STATUS_BOARD_INTERVAL_S` (10).

**Board format.** Plain content, chunked by line into ≤ 2000-character slots, grouped by state in attention order: 🔔, ⚠️, ⏳, 💤. Within a group, the oldest `display_since` comes first.

```
-# CCDM threads · 1/2 · last change <t:1763290000:R>
🔔 <#1700000000000223344> · plio · claude/opus-4-8 · <t:1763289000:R>
⏳ <#1700000000000223355> · ccdm · codex/gpt-6-sol · <t:1763289900:R>
```

- **Relative times.** `<t:…:R>` renders client-side and refreshes on its own, so content changes only on real transitions; there are no per-minute edits.
- **Flush.** `board.flush` runs at most once per interval. It renders the board, compares each slot with its stored `content_sha256`, and edits only the slots that changed.
- **Slot count.** Missing slots are posted at the bottom, which keeps the order. Surplus slots are deleted.
- **Overflow.** Beyond 5 slots (about 110 lines), the 💤 group collapses to `💤 +N idle threads`.

## 8. Persistence: supervisor store v2

The threads table gains these columns (nullable, with CHECKs):

- `whose_turn` (`agent` | `owner`)
- `last_input_at`
- `last_input_class` (`owner` | `guest` | `starter`)
- `turn_end_seen`
- `turn_outcome` (`completed` | `failed`)
- `display_state` (`working` | `waiting` | `idle` | `failed`)
- `display_since`
- `ping_message_id`

There is one new table: `status_board(slot INTEGER PRIMARY KEY, channel_id TEXT NOT NULL, message_id TEXT NOT NULL, content_sha256 TEXT NOT NULL)`.

**Migration** happens in `store.connect` (`store.py:118-143`), modelled on the reminder store's `backup_store` (`conversation-reminder-service.py:231-232`):

1. On `user_version` 1, copy the store with the SQLite backup API to `threads.v1.backup.sqlite3` (0600).
2. Run `BEGIN IMMEDIATE`, then 8 × `ALTER TABLE threads ADD COLUMN`, then `CREATE TABLE status_board`, then `PRAGMA user_version=2`, then `COMMIT`.
3. Run `verify` against the exact v2 column sets. `COLUMNS` becomes per-version (`store.py:55-83`).

Any failure rolls back and leaves the v1 store intact, and the worker exits non-zero (launchd retries). `inspect` and `status` accept v1 and v2, and refuse anything newer. Old code refuses v2 by design. **Rollback:** stop the worker, restore the backup, run the old code. Existing rows start with null status columns, `display_since=` the migration time, and a baseline on the first tick.

**In memory only:** activity `mtime_ns` and first-seen times, pending ping retries, and the last flush time.

**Finding the board after a restart.** Stored slots are trusted and edited. An edit returning `not_found` drops all slots and reposts them all in order. With no stored slots (a fresh store or a channel change), `status_board_list` adopts root's messages that start with `-# CCDM threads`, ordered by id, and deletes the extras. So a restart never posts a duplicate.

## 9. Activity v2 (optional fields, new launches only)

`markTurn` (`thread-activity.js:16-34`) merges fields instead of rewriting two. The supervisor treats missing fields as v1, so live sessions are not restarted.

- **`paused`.** The Claude channel server sets and clears it in `/pause` and `/unpause` (`ccdm-channel-server.js:617-626`). The Codex bridge sets it wherever `bridgePaused` changes (`codex-bridge.js:887,1108,1677-1690`).
- **`last_turn_outcome`.** Claude: `completed` from Stop and `failed` from StopFailure (the hook reads `hook_event_name`). Codex: from `turn.status` (`codex-bridge.js:831-883`): completed, failed or interrupted.
- **`turn_replied`.** Codex `mcpReplyCalled`; Claude: any `reply` op since the turn started. It is used only for the ping wording.
- **Claude `UserPromptSubmit` hook** runs `thread-activity.js` to mark the turn running (`start-thread-session.sh:356-359`). It closes the queued-follow-up gap from §3 if Claude fires it for channel-originated prompts.

## 10. Deploy

1. **Router** (`launchctl kickstart -k gui/$UID/com.ccdm.router`): the new and extended ops, registry validation, the status-permission line, and the ping-reply routing rule. Clients reconnect with backoff (`client.js:43`, 500 ms → 30 s). No session restarts, and root's fallback needs about 2 minutes of downtime before it engages.
2. **Thread Supervisor** (rerun `scripts/install-thread-supervisor.sh`): the v2 migration and the new modules. Live thread sessions keep running across a supervisor restart (`reconcile.py:60-68` marks crashed only rows whose process is gone).
3. **Conversation Reminder service:** no code change, no restart.
4. **Channel servers and bridges** (activity v2): not restarted. Each thread gets v2 on its next launch (resume, eviction, `/restart`). Project-channel sessions and root never write `activity.json`.
5. **Operator:** create the status channel; grant root View Channel, Send Messages and Read Message History there, and deny Send Messages to everyone else; set `thread_status_channel_id` through `scripts/registry-update.py` under the registry lock.

Deploy the Router before the supervisor. A supervisor that gets `unknown_op` turns its board and pings off until the next Router reconnect.

## 11. Failure modes

- **Router down / 429:** ops fail, the board stays dirty and flushes later (edits coalesce in the Router); a ping retries ≤ 5 min, then is dropped (the board still shows 🔔). **Unarchive refused:** retried by reconcile; the owner's next message unarchives anyway.
- **Supervisor down:** the board freezes (its `last change` header shows its age); a turn that ended meanwhile pings on the first tick after restart (newer than the stored `turn_end_seen`, row still live). A crash between a ping POST and the store write leaves one orphan ping (accepted).
- **`activity.json` missing/unreadable:** no transition, ⏳ shown. **Status channel gone or permission lost:** 404/403 logged once per flush; `router status` names the missing bit.

## 12. Test plan (Local Fakes in `tests/e2e/`; no real Discord)

The fake Discord gains a status channel, records message PATCH and DELETE calls and `allowed_mentions`, and serves GET for the status channel. Claude turns use the fixture `claude`, which runs the command hooks (`support/runner.js:506-515`). Codex turns use `startFakeCodexServer` (`support/bridge.js`) to emit `turn/started` and `turn/completed`.

**New file `thread-status-board.test.js`:**

1. **Claude happy path.** An owner message gives ⏳ on the board, then Stop gives 🔔 and one ping with `allowed_mentions {parse: [], users: [owner]}`. The board line has `<#id>`, the project, provider/model and `<t:…:R>`.
2. **Ping replacement.** The owner's next message deletes the ping. The next end posts a new ping, and only one ping exists at any time.
3. **Codex follow-ups.** A steered follow-up gives one ping. A completion followed by `turn/started` within the settle window gives one ping. A turn with no driver input (`/compact`, the `/restart` bootstrap) gives none.
4. **No ping after a stop.** No ping after `threads.sh stop`, a killed fixture (`thread_session_revoked` → ⚠️), or `/close`. `/close` deletes the ping before its archive PATCH (checked by REST call order).
5. **Guest-driven turn.** The board shows 🔔 · guest, and there is no ping. A v2 `/pause` followed by an owner message shows 💤 paused and no ping.
6. **Debounce and idempotence.** A burst of transitions gives at most one PATCH per slot per interval. Unchanged content gives no PATCH.
7. **Restart.** A supervisor restart reuses the slots with no new POST. A deleted store adopts the board through `status_board_list`. A slot deleted in Discord leads to a full repost. 60 threads fill several ordered slots; shrinking deletes the extras.
8. **Configuration.** With the key unset, no status op is called and nothing errors. Setting it by hot reload makes the board appear without a restart. A key equal to a project channel turns only the board off: `router status` shows the error, and the registry and the project's routing are unaffected.
9. **Native reply.** A native reply to a ping reaches the thread session, not root.

**Extended files:**

- `router-supervisor-ops.test.js`: each new op is `forbidden` to every other role. Status ops never reach another channel. Editing or deleting a webhook message, another user's message, or a message in another thread is a `scope_violation`. `mention_owner` on a project channel is a `scope_violation`. Extra mention syntax is `invalid_args`.
- `thread-lifecycle.test.js`: replaces the owner-archive and root-archive tests (`:110-194`):
  - an auto archive and an owner archive are both unarchived by PATCH, and an idle session is stopped as `stopped/auto-archive` while the row stays open;
  - a mid-turn or booting archive is unarchived and keeps its session;
  - a `/close` or `threads.sh close` archive is kept;
  - a reconcile at start unarchives an archived open row;
  - without View Audit Log an archive is still reverted (as built, one audit-log read only names the actor in the log).
- `thread-supervisor.test.js`:
  - a v1 store with rows migrates to v2 with a 0600 backup;
  - an injected failure leaves v1 intact;
  - a v3 store is refused;
  - `status` reads v1 before the migration.

## 13. Out of scope / later

Channel Conversation status; board buttons/components; pushing activity through Router events instead of polling; remote projects; folding the reminder service's first 👀 into the ping; Claude background tasks on Stop (ignored: a turn that left them running counts as ended); thread locking; deleting an old board after a channel change; per-guest pings.

## 14. Decisions to confirm

- **D1.** The source of truth is `activity.json` plus the supervisor's input stream. The supervisor owns the board and pings. The reminder state is not used.
- **D2.** Guest-driven turns show 🔔 · guest on the board but do not ping the owner.
- **D3.** Pings are on by default (`thread_owner_pings`) and independent of the board key.
- **D4.** The board is grouped by state, with the project on each line, and the 💤 group collapses past 5 slots.
- **D5.** A reverted archive stops an idle session (`stopped/auto-archive`) and keeps a booting or mid-turn one.
- **D6.** An owner UI archive no longer closes a thread. The audit-log lookup is removed, and View Audit Log is dropped from the required permissions, which changes an `AGENTS.md` non-negotiable.
- **D7.** A failed turn (v2) shows ⚠️ and pings with a "turn failed" text.
- **D8.** A native reply to a ping routes to the thread session (a Router routing change).
- **D9 (changed at approval).** An invalid `thread_status_channel_id` (not a 17-20 digit channel id string exactly, as review tightened it so the Router and supervisor always agree; a root channel; or a project channel) does not invalidate the registry. It turns the board off, and the error shows in `router status` and `router status --json`, while the rest of the registry loads normally. The supervisor applies the same check and shows `board: invalid` in its `status`.

As built, D6 keeps View Audit Log listed as useful but optional: the supervisor still makes one audit-log read per reverted archive, only to log who archived the thread. `router status` reports it on a `guild permissions (optional):` line and in `missing_optional_thread_permissions`; it never blocks reminder readiness. `CCDM_THREAD_OWNER_PINGS=0|1` overrides `thread_owner_pings` for one worker (the test harness defaults it to `0`).

Review changes after the build:
- an input counts from its Discord `ts`, not from when the worker handled it;
- the board makes one Router call per flush, and only while no frame waits;
- ping, board and audit-log calls time out after 5 s;
- a ping or board post that may have landed is looked for before it is posted again;
- the Router and reconcile recognise a ping by its exact text, which replaces the Router-memory-only check that §11 assumed;
- pings and the board need the Router's `hello_ok` capabilities;
- a `/` prompt does not mark a turn running, and a turn with no activity for 6 h is stuck, not running;
- a paused session is never stopped by an archive revert;
- `activity.json` writes are locked;
- reconcile finishes a close that a crash interrupted.
- **D10.** The status channel is made root-write-only by hand, so the board stays at the bottom.
