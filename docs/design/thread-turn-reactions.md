# Thread turn reactions: design note

Status: built on `feat/thread-turn-reactions` (2026-11-17). It replaces the thread status board and the in-thread owner pings (PR #347/#348), which the owner tried and did not want: a separate status channel to watch, and a root post in the thread after every turn. The never-archive rule from that work stays as it was.

## What it does

Root reacts on the owner's (or a guest's) own message instead of posting anything:

| Mark | When |
|---|---|
| ⏳ | A driver input arrives: an owner or guest message in the thread that is no command and does not address root (the rule `turns.on_message` already used). Only the latest input in a turn carries ⏳; an earlier one loses it. |
| ✅ | The turn ends (the settled turn end of `turns._observe_turn`), with or without a reply. |
| ⚠️ | The turn failed (`last_turn_outcome == "failed"`), or the session crashed or failed to start while the input had ⏳. |
| (none) | An interrupted turn, or a stop: the ⏳ just goes. A turn end with no input since the last one changes nothing. |

A ✅ or ⚠️ stays for good; the next input's ⏳ goes on the new message. 👀 during a boot can sit beside ⏳.

## Where the state comes from

Unchanged from the board: each live session's `activity.json` (turn running, last end and its outcome) plus the supervisor's own `thread_message` stream, with each input timed by its Discord timestamp.

## Desired versus shown

A reaction call can fail (Router restart, Discord 5xx, rate limit), and a stranded ⏳ would lie. So the store keeps two marks per thread:

- `mark_message_id`, `mark_emoji`: the mark root wants. Event handlers change only this: `note_input` sets ⏳; a turn end, a stop, a crash, a reset or `/close` turns a ⏳ into ✅, ⚠️ or nothing (`store.end_waiting`, which never touches any other mark).
- `shown_message_id`, `shown_emoji`: the mark Discord was last seen to take.

The worker loop, whenever no event waits, syncs every thread whose two marks differ: it removes the shown emoji when it is ⏳ or sits on the wanted message, forgets a ✅/⚠️ left on an older message, then adds the wanted one. A failed call backs off per thread (2 s doubling to 2 min, cleared on a Router reconnect). `not_found` (the message was deleted), `thread_archived`, `scope_violation`, `invalid_args` and `unknown_op` count as settled, so nothing retries forever. `/close` (and reconcile finishing an interrupted close) syncs at once, past the backoff, before its archive. A stop first takes a turn end the settle window has not yet accepted, so a turn that answered just before an operator stop still gets ✅.

`stop-session.sh --threads` with no worker running clears a ⏳ in the store; the next worker removes it from Discord.

## Router

Reactions use the existing supervisor op `thread_react`, which now answers `not_found` for Discord's 404 and `thread_archived` for error 50083. Root's reactions never reach a session or `config.on_thread_reaction`: `classifyReaction` drops bot users, and the `/config` ✅ must also be the owner's on the pending warning message. The ping and board ops (`mention_owner`, `thread_notice_delete`, `status_board_*`), the supervisor `hello_ok` capabilities, the ping-reply routing and `thread_status_channel_id` are gone.

## Store v3

v3 drops v2's `status_board` table and its `display_state`, `display_since` and `ping_message_id` columns, and adds the four mark columns. A v1 or v2 store migrates on the worker's next start, after a private `threads.v<n>.backup.sqlite3`, in one transaction that rebuilds `threads` with the v3 definition and copies every row in the columns both versions share (no `DROP COLUMN`, so any SQLite works). A failed migration leaves the store as it was.

## Tests

`tests/e2e/thread-turn-reactions.test.js` (marks against the real Router, supervisor and session fakes), the v1/v2 → v3 migrations in `tests/e2e/thread-supervisor.test.js`, and the op changes in `tests/e2e/router-supervisor-ops.test.js`. Other suites run with `CCDM_THREAD_TURN_MARKS=0`, so their reaction counts are unchanged.
