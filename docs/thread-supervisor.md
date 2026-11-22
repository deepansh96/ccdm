# Thread Conversations and the Thread Supervisor

A **Thread Conversation** is a Project Conversation held in one public Discord thread under a registered project channel. It has its own Claude Code, Codex or Gemini conversation, and optionally its own provider, account, model and effort. It is independent of the project's **Channel Conversation** and of sibling threads. The design is recorded in [ADR 0005](adr/0005-thread-conversations-on-the-router.md), on top of the one-bot Router of [ADR 0004](adr/0004-single-root-bot-router-replaces-bot-pool.md).

The **Thread Supervisor** is the CCDM service that turns thread events from the Router into Thread Conversation lifecycle: start, stop, resume, close, and the live-session cap. It is an ordinary Router client and holds no Discord credential. Every Discord action it takes is a Router op, and the Router stays the only token holder.

## What counts as a thread

- **Eligible:** public threads (type 11) whose parent is a registered project channel that is not a `remote:` project.
- **Ignored by every consumer:** private, announcement, forum and media threads, threads in root or unregistered channels, and threads under `remote:` projects.
- **Binding:** a thread binds when the owner or a current guest of the parent channel creates it, or when the root bot creates it to fulfil a pending CCDM creation request. A thread anyone else creates binds nothing and never starts a session.
- **Rollout:** threads are on for every project once the supervisor is installed. There is no per-project flag and no per-thread worktree; every thread works in the shared project checkout.

## Routing and Session Scope

- The Router forwards only default (0) and reply (19) messages. The "thread created" (18) and thread-starter (21) system messages reach no session, root, observer or supervisor.
- A thread message from the owner or a guest of the parent reaches only that thread's session, never the Channel Conversation or a sibling. Guests drive threads without an @mention.
- A thread session's **Session Scope** is its thread alone. Reads, replies, reactions, edits, exports and downloads that target the parent channel, a sibling thread, a root channel, a parent message or the starter message are `scope_violation`.
- Replies post through the parent project's webhook into the thread, as `<project>-<provider> · N%`, named for the thread's own provider. Supervisor notices post as the root bot, so reminder agent-reply detection (by `webhook_id`) never counts them.
- An owner bot mention, or a native reply to a root message, inside a thread reaches root, which answers in that thread. A guest's reaches no one. Neither starts or feeds the thread's own session.
- An owner or guest message with no live session and no supervisor gets 💤 and is not delivered live. Reconciliation may later deliver it once, in a bootstrap.

## Starting a thread

Create a thread in any of four ways. All four become one supervisor creation request:

- by hand in Discord;
- `/thread <name> [--provider claude|codex|gemini] [--account <alias>] [--model <model>] [--effort <effort>] [first message…]` in the project channel;
- the Channel Conversation's `create_thread` tool, for its own channel only;
- the operator's thread command, which takes the same flags:
  - macOS: `scripts/threads.sh create <project> <name> [flags] [message]`.
  - Windows: `scripts/ccdm threads create <project> <name> [flags] --message-stdin`, with the first message on stdin, or `--message-file <path>` for a UTF-8 file. Never give the message as arguments there. Leave both out to create the thread with no first message. macOS accepts the same two flags.

Created threads use a one-week archive duration (`auto_archive_duration: 10080`). Bot-created threads are made with it, and owner-created ones are PATCHed to it. A bad flag creates nothing: `/thread` answers `Thread not created: <reason>`, the tool returns an op error, and the operator's thread command exits 2.

The session starts on the first owner or guest message, or at once when a first message was given:

1. 👀 shows on the triggering message while the session boots.
2. The supervisor runs the thread launcher, the code behind `scripts/ccdm start-thread-session <project> <thread_id> --provider …`, in its own process, with a fresh `keys/.thread-<thread_id>.key`, the launch dir `launches/<project>/threads/<thread_id>/`, and the session `<screen>-t-<thread_id>` (a tmux session on macOS, a `ccdm-host` session on Windows).
   - macOS: `scripts/start-thread-session.sh` runs the same launcher from a terminal.
   - Windows: the worker and `ccdm-host` both start at logon, in no fixed order. The worker's first launch waits until `ccdm-host` answers, 90 seconds at most. If the host still does not answer, the launch goes ahead and fails with the usual notice.
3. Every message sent during boot is delivered exactly once, in the first prompt, together with the starter. The starter goes only into a conversation's first boot; a resume does not repeat it.
4. 👀 is removed when the session is live. A failed start posts a one-line reason and is not retried automatically; the next eligible message retries.

A stop that arrives while the launcher still runs (an archive, a delete, `/restart`, `/clear`, `/close`, an applied `/config`, a project change, or an operator stop) waits for the launcher to exit, so it never races the launch.

Accounts are aliases only. Claude aliases live in the registry's `claude_accounts` map (alias → home), Codex aliases in `codex_accounts`, and Gemini aliases in `gemini_accounts` (alias → the home agy runs under as `HOME`, which holds that Google sign-in; without `--account` a Gemini thread uses the project's `gemini_account`, else the user's own home). A Discord message can name an alias, never a path. An unknown alias, or a Gemini account home that is missing, fails the start.

## Commands in a thread

| Command | Who | Effect |
|---|---|---|
| `/close` | owner | Posts the acknowledgement, archives the thread as root, stops the session, and makes it a **Closed Conversation** (`closed/close-command`). |
| `/restart` | owner or guest | Relaunches the session with `--resume` into the same conversation. |
| `/clear` | owner or guest | Relaunches the session as a fresh conversation. |
| `/config` | owner | With no arguments, shows provider, account, model and effort. `model=` and `effort=` save and restart with resume. `provider=` and `account=` warn that the next conversation starts fresh, and apply only after the owner's ✅ on that warning. A `provider=` that changes the provider also clears the thread's account, model and effort overrides the same `/config` does not set, since they belong to the old provider. |
| `/model` | owner or guest | Shows the provider, model, thinking level and account/home the thread's session runs with, each marked `(thread)`, `(project)` or `(home config)`. It changes nothing and starts no session. |
| `/compact`, `/pause`, `/unpause` | owner or guest | Go to the live session. With no session, the supervisor answers `No live session in this thread.` |

`/thread`, `/config` and `/model` never reach a model; in a project channel `/model` shows the channel session's settings the same way. Every in-thread command affects only its own thread.

## Archive, delete and resume

- **Archive:** a thread stays unarchived until it is closed. Only `/close` and the operator's thread `close` command archive it, and they close the conversation and stop its session. Any other archive is reverted at once: Discord's one-week inactivity auto-archive, the owner or a guest archiving it by hand, or a root archive outside the close flow. Reverting never closes the conversation. A live session that is not mid-turn stops as `stopped/auto-archive`, since a week without messages means it held a slot for nothing, and the next owner or guest message resumes it exactly. A booting session, one mid-turn, or a paused one (whose held messages would be lost) keeps running. A turn marked running whose `activity.json` has not changed for 6 hours (`CCDM_THREAD_STUCK_TURN_S`) counts as stuck, not running, here and for capacity eviction. A close that a crash interrupted after it recorded itself (`pending_close`) is finished by reconcile, or by the archive event: the thread is archived, the row closes as `close-command`, and the reminder service hears `conversation_closed`. With the optional View Audit Log the supervisor logs who archived the thread, from one audit-log read. Rows written by older versions may still show `closed/owner-archive`, `closed/root-archive` or `stopped/archive-actor-unknown`, but none of them is written any more.
- **Unarchive:** an unarchive, including the supervisor's own revert, starts nothing.
- **Delete:** stops the session and drops the supervisor row and the reminder state. Provider conversation files stay on disk.
- **Resume:** an owner or guest message resumes a stopped thread. Only an owner message reopens a Closed Conversation. Either way it resumes the same provider conversation (`claude --resume`, Codex `--resume <uuid>`, or the agy session id for Gemini, from the account home's `.gemini/antigravity-cli`) in the same cwd and the home the conversation started in, even if the project has since switched accounts. A missing transcript or rollout is a start failure with a one-line reason, never a silent fresh start.

## Status: turn marks

The supervisor tracks whose turn it is in every thread. It reads each live session's `activity.json`, which the CCDM channel server and the Codex and Gemini bridges keep. That file records whether a turn is running, when the last one ended and how (`completed`, `failed`, or for Codex `interrupted`), whether the turn replied, and whether `/pause` holds new turns. Each write holds `activity.json.lock`, since the channel server or bridge and each hook run write it. A Claude thread's `UserPromptSubmit` hook marks a turn running, except for a prompt starting with `/` (a local command typed into the pane, which no Stop may follow). The supervisor combines that with its own copy of every thread message, timing each input by its Discord time, so a message the worker handles late still counts from when it was sent.

It shows the turn as root's reaction on the input that started it, in the thread itself; it posts nothing:

- **⏳ the agent is on it:** an owner or guest message that is not a command and does not address root hands the turn to the agent, and root reacts ⏳ on it. Only the latest input carries ⏳: when another input arrives before the turn ends, the ⏳ moves to it. A creation request's first message hands over the turn too, with no message to mark. 👀 during a boot can sit beside ⏳.
- **✅ answered:** when a live session's turn has ended and no turn has run for 5 s (`CCDM_THREAD_STATUS_SETTLE_S`), with no input after it, the turn passes to the owner and the ⏳ becomes ✅, whether or not the turn posted a reply.
- **⚠️ failed:** a failed turn (`last_turn_outcome` `failed`) gets ⚠️ instead, as does a ⏳ whose session crashes or fails to start.
- **Nothing:** an interrupted turn just loses its ⏳. A turn end with no input since the last one (a compaction, the bootstrap of `/restart`, a retry) changes no mark.
- **Never stranded:** a stop (an operator stop, an idle eviction, an archive revert, `/restart`, `/clear`, a `/config` restart, a project change) takes the ⏳ off; a turn that had already ended still gets its ✅ or ⚠️ first. `/close` and the operator's thread `close` command take it off before archiving, since reactions cannot change in an archived thread.
- **Kept:** a ✅ or ⚠️ stays on its message for good. The next input's ⏳ goes on the new message, and old marks are never touched.

The store keeps the mark root wants (`mark_message_id`, `mark_emoji`) apart from the one Discord was last seen to show (`shown_message_id`, `shown_emoji`). Events change only the wanted mark; the worker loop, whenever no event waits, syncs the difference through the Router's `thread_react`: it removes the shown emoji when it is ⏳ or sits on the wanted message, then adds the wanted one, each call waiting at most 5 s. A failure is retried with a per-thread backoff from 2 s doubling to 2 min, reset when the Router reconnects; a message that is gone (`not_found`) or a thread already archived (`thread_archived`) counts as done. Root's own reactions reach no session and no `/config` warning. `CCDM_THREAD_TURN_MARKS=0` turns marks off, as the E2E suite does by default.

`scripts/thread-supervisor.py status` shows each thread's `whose_turn`, `last_input_class`, `turn_outcome` and its wanted and shown marks.

## Capacity

Live thread sessions are capped per provider by the registry's `thread_session_caps`, defaulting to Claude 6, Codex 8 and Gemini 4. Only thread sessions count; Channel Conversations never do.

- **Idle:** no turn running, and no owner message for 30 minutes.
- **At the cap:** the longest-idle session is evicted with `Paused to free a session slot; send a message here to resume.` A session mid-turn or booting is never evicted.
- **No idle session:** the thread is queued with `Queued, N sessions busy.` and starts automatically, FIFO per provider, when a slot frees or a running session goes idle. A new thread never passes one already queued for its provider, and a queued thread keeps its first message across a supervisor restart.

## Supervisor down and reconcile

While the supervisor is down, a thread message with no live session gets 💤. The supervisor will reconcile on its own start, on every Router reconnect and on every gateway resume:

- it binds threads it missed;
- it unarchives every archived thread whose conversation is not closed;
- it marks dead sessions `crashed`;
- it starts only threads whose newest owner message is newer than the last agent reply, with the undelivered messages in the bootstrap; a root mention or a native reply to root never counts.

A registered project channel that Discord no longer has (or that root cannot read) is skipped by the Router's thread list and named in the supervisor's log, and the other channels reconcile as usual; `router status` shows such a project as `channel_missing`.

After a Router restart, every live thread session says hello again. The Router listens before its Discord gateway is ready, so a thread hello waits for it (up to 60 s) before checking the thread, and thread sessions come back on their own. Past that wait the hello is refused as `not_ready`, and the client tries again.

A live session that dies while the supervisor runs is marked `crashed` as soon as the Router reports it gone, which frees its slot. Crashed, failed and operator-stopped sessions never restart automatically; the next owner or guest message resumes them.

## Project changes

- **Deregistration:** stops each thread session and closes the thread (`closed/deregistered`).
- **Channel move:** closes the threads (`closed/project-moved`), because the moved webhook cannot post into the old channel's threads. Each thread remembers the channel it was bound under, so a move made while the supervisor was down closes them on its next start.
- **Path set to `remote:`:** the project now runs on another machine, which has no thread sessions, so its threads close the same way (`closed/project-moved`).
- **Guest changes:** apply on the next message.
- **Channel maintenance:** `restart <project>`, `scripts/ccdm start-session <project>`, `scripts/ccdm stop-session <project>` and a project key rotation act on the Channel Conversation only. `scripts/ccdm stop-session <project> --threads` stops the thread sessions only, and `--all` stops both. The commands are the same on macOS and Windows.
  - macOS: `scripts/start-session.sh <project>` and `scripts/stop-session.sh <project> --threads` (or `--all`) run the same commands.

## Conversation Reminders

Each thread is its own Conversation Reminder conversation, keyed `(project, conversation_id)`, where the id is the thread id:

- **Reminders:** root posts 👀 into the thread on the usual 1h → 24h backoff, behind the 5 s gate.
- **Acknowledgment:** the owner's reply acknowledges only that thread. Guests never acknowledge.
- **Close:** `/close` closes only that thread's reminders. The next owner message reopens them.
- **Archived threads:** a reminder posted into a thread that is still archived (say, while the supervisor was down) reopens the thread without starting a session.
- **Resets:** a provider or account switch resets tracking. A delete drops the state.
- **Status:** reminder `status` nests threads under their project.

See [docs/conversation-reminders.md](conversation-reminders.md).

## Running the supervisor

The supervisor is a Python worker, which owns the store, capacity, lifecycle and launching, plus a Node link that holds the single `supervisor` Router connection. Its private state is under `~/.local/state/ccdm/thread-supervisor/` (0700, files 0600). The state holds:

- the SQLite store `threads.sqlite3`;
- `worker.lock`;
- the control channel used by the operator's thread command and by a project's `--threads` stop: the socket `control.sock` on macOS, and on Windows a named pipe whose name and key are in `supervisor.pipe` and `supervisor.secret`;
- the LaunchAgent logs `service.log` and `service.err`.

The worker writes a fresh `keys/.supervisor.key` in the Router state on each start.

- **Install** with `scripts/install-thread-supervisor.sh`. It runs the read-only `preflight` (interpreters, Router reachable, registry owner and guild, store) before touching launchd. It then renders a secret-free `com.ccdm.thread-supervisor` plist running `run --supervised`, relaunches only after an unsuccessful exit, and restores the prior plist if a load fails.
- **Inspect** with `scripts/thread-supervisor.py status`. It shows the worker, the caps (and any invalid value) and every bound thread with its state.
- **Disable / enable** with `scripts/thread-supervisor.py disable` and `enable`. While disabled, the supervised worker exits and launchd does not relaunch it. `enable` only clears the disabled marker; it does not start the worker. Rerun `scripts/install-thread-supervisor.sh` afterwards to relaunch the LaunchAgent.
- **Debug in the foreground** with `scripts/thread-supervisor.py disable`, then `scripts/thread-supervisor.py run`. A second worker exits with status 2 while the lock is held.
- **Operate threads** with the operator's thread command: `list [<project>]` prints each bound thread, and `stop|restart|close [<project>] <name|link|id>` acts on one. `restart` also accepts thread provider/account/model/effort overrides, applies them before starting the session, and starts fresh for a provider or account change. The output and exit codes are the same on both OSes. `scripts/ccdm send-claude-command`, guest access (which acts on the parent project) and `export-discord-range.js` also accept a thread id.
  - macOS: `scripts/threads.sh list [<project>]` and `scripts/threads.sh stop|restart|close [<project>] <name|link|id> [--provider|--account|--model|--effort <value>]`.
  - Windows: `scripts/ccdm threads list [<project>]` and `scripts/ccdm threads stop|restart|close [<project>] <name|link|id> [--provider|--account|--model|--effort <value>]`.
  - macOS: `scripts/send-claude-command.sh` runs `scripts/ccdm send-claude-command`.
- **Router view:** `node scripts/router.js status` lists each `thread` connection, the supervisor line, and root's missing thread permissions while threads are enabled.
- **Windows:** the service is the scheduled task `\CCDM\ThreadSupervisor`, which runs the same `run --supervised` worker and restarts it after a failure.
  - Install with `scripts/ccdm install-service thread-supervisor`. It runs the same read-only `preflight` first; on a blocker it prints each one, exits 2 and changes nothing. It also refuses while a worker started by hand holds the lock.
  - Inspect with `py -3 scripts\thread-supervisor.py status` and `scripts/ccdm service-status thread-supervisor`. The logs are `~/.local/state/ccdm/services/thread-supervisor.log` and `.err`.
  - `py -3 scripts\thread-supervisor.py disable` makes the worker exit 0, and the task does not restart it. `enable` only clears the marker; run `scripts/ccdm install-service thread-supervisor` again to start the worker. An install while disabled registers the task and starts nothing.
  - `scripts/ccdm uninstall-service thread-supervisor` stops the worker and removes the task. Thread sessions live in the session host: stopping, reinstalling or removing this task leaves them running, and the next start keeps them bound. To stop them, run `scripts/ccdm stop-session <project> --threads`.
  - The task records its settings at install: the state root, the Router state directory, node and Python, and, when they are set, `CLAUDE_CONFIG_DIR` and the installation's other `CCDM_*` paths. After changing one, run the install again from a shell that has the new value.

## Root permissions

Root needs three permissions for threads. They are **granted once by hand**, and no CCDM script PATCHes permissions:

- **Create Public Threads**, in every project channel;
- **Send Messages in Threads**, in every project channel;
- **Manage Threads**, in every project channel, to reopen threads that something other than `/close` archived.

**View Audit Log**, at the guild level, is useful but optional. With it, the supervisor logs who archived a thread it reopened.

Grant them on root's role (Server Settings → Roles), or on each project category or channel. `router status` and reminder readiness report any missing required bit only while threads are enabled: the supervisor's LaunchAgent plist exists, `thread_session_caps` is in the registry, or a supervisor is connected. `router status` lists View Audit Log separately, as `guild permissions (optional)`.

## Operator checklist

These steps run once after the thread work is merged and deployed. They touch real Discord, Claude and Codex, so they are not run in CI. The Default CI Suite covers the same flows against local fakes, including `tests/e2e/thread-conversation-journey.test.js`.

**Grant and install:**

- [ ] Grant root Create Public Threads, Send Messages in Threads and Manage Threads on the project channels, and optionally View Audit Log on the guild.
- [ ] Run `scripts/install-thread-supervisor.sh`. Confirm that `scripts/thread-supervisor.py status` shows the worker running.
  - Windows: run `scripts\ccdm install-service thread-supervisor`. Confirm that `py -3 scripts\thread-supervisor.py status` shows the worker running.
- [ ] In `node scripts/router.js status`, confirm `supervisor: connected` and `thread_permissions=ok` for each project.

**Live smoke:**

- [ ] **thread → Claude reply:** in a Claude project channel, open a public thread and type a task. Expect 👀 during boot, then a reply in the thread as `<project>-claude · N%`. The Channel Conversation receives nothing.
- [ ] **thread → Codex reply:** repeat in a Codex project channel, or use `/thread smoke --provider codex hello` in a Claude one. Expect a reply in the thread as `<project>-codex · N%`.
- [ ] **thread → Gemini reply:** with agy installed and signed in, use `/thread smoke --provider gemini hello` in any project channel. Expect a reply in the thread as `<project>-gemini · N%`.
- [ ] **`/close`:** send `/close` in one smoke thread. Expect the root-bot acknowledgement and the thread archived. The thread list shows it `closed/close-command`, and its session `<screen>-t-<thread_id>` is gone.
  - macOS: `scripts/threads.sh list`, then `tmux ls`.
  - Windows: `scripts\ccdm threads list`. The closed thread's session is absent from `scripts\ccdm list`, and it no longer answers `scripts\ccdm session capture <screen>-t-<thread_id>`.
- [ ] Optionally send another owner message in the closed thread. It should reopen and answer with the same conversation.
- [ ] **turn marks:** your message in a smoke thread gets ⏳ while the agent works, and ✅ once it answers. Send a second message mid-turn: the ⏳ moves to it.
- [ ] **archive revert:** archive a smoke thread by hand. Expect it reopened within seconds, still open in the operator's thread `list` command.
- [ ] **queued follow-up (Claude):** send a second message while Claude is writing its final answer. It should keep ⏳ until that follow-up's answer, which proves the `UserPromptSubmit` hook marks the turn running. If it turns ✅ first, the hook does not fire for channel prompts.

**Clean up:**

- [ ] Delete or archive the smoke threads.
