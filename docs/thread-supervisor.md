# Thread Conversations and the Thread Supervisor

A **Thread Conversation** is a Project Conversation held in one public Discord thread under a registered project channel. It has its own Claude Code or Codex conversation, and optionally its own provider, account, model and effort. It is independent of the project's **Channel Conversation** and of sibling threads. The design is recorded in [ADR 0005](adr/0005-thread-conversations-on-the-router.md), on top of the one-bot Router of [ADR 0004](adr/0004-single-root-bot-router-replaces-bot-pool.md).

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
- `/thread <name> [--provider claude|codex] [--account <alias>] [--model <model>] [--effort <effort>] [first message…]` in the project channel;
- the Channel Conversation's `create_thread` tool, for its own channel only;
- `scripts/threads.sh create <project> <name> [flags] [message]`.

Created threads use a one-week archive duration (`auto_archive_duration: 10080`). Bot-created threads are made with it, and owner-created ones are PATCHed to it. A bad flag creates nothing: `/thread` answers `Thread not created: <reason>`, the tool returns an op error, and `threads.sh` exits 2.

The session starts on the first owner or guest message, or at once when a first message was given:

1. 👀 shows on the triggering message while the session boots.
2. The supervisor runs `scripts/start-thread-session.sh <project> <thread_id> --provider …` with a fresh `keys/.thread-<thread_id>.key`, the launch dir `launches/<project>/threads/<thread_id>/`, and tmux `<screen>-t-<thread_id>`.
3. Every message sent during boot is delivered exactly once, in the first prompt, together with the starter. The starter goes only into a conversation's first boot; a resume does not repeat it.
4. 👀 is removed when the session is live. A failed start posts a one-line reason and is not retried automatically; the next eligible message retries.

A stop that arrives while the launcher still runs (an archive, a delete, `/restart`, `/clear`, `/close`, an applied `/config`, a project change, or an operator stop) waits for the launcher to exit, so it never races the launch.

Accounts are aliases only. Claude aliases live in the registry's `claude_accounts` map (alias → home), and Codex aliases in `codex_accounts`. A Discord message can name an alias, never a path. An unknown alias fails the start.

## Commands in a thread

| Command | Who | Effect |
|---|---|---|
| `/close` | owner | Posts the acknowledgement, archives the thread as root, stops the session, and makes it a **Closed Conversation** (`closed/close-command`). |
| `/restart` | owner or guest | Relaunches the session with `--resume` into the same conversation. |
| `/clear` | owner or guest | Relaunches the session as a fresh conversation. |
| `/config` | owner | With no arguments, shows provider, account, model and effort. `model=` and `effort=` save and restart with resume. `provider=` and `account=` warn that the next conversation starts fresh, and apply only after the owner's ✅ on that warning. |
| `/model` | owner or guest | Shows the provider, model, thinking level and account/home the thread's session runs with, each marked `(thread)`, `(project)` or `(home config)`. It changes nothing and starts no session. |
| `/compact`, `/pause`, `/unpause` | owner or guest | Go to the live session. With no session, the supervisor answers `No live session in this thread.` |

`/thread`, `/config` and `/model` never reach a model; in a project channel `/model` shows the channel session's settings the same way. Every in-thread command affects only its own thread.

## Archive, delete and resume

- **Archive:** an owner or root archive, or `/close`, closes the conversation and stops its session. Any other archive, including Discord's inactivity auto-archive, only stops the session (`stopped/auto-archive`). The supervisor reads the archive actor from audit-log action 111 entries that set `archived` to true (a rename or archive-duration change is not an archive), polling for up to 60 s. A lookup that fails throughout is recorded as `stopped/archive-actor-unknown` and fails open as an auto-archive.
- **Unarchive:** a bot unarchive starts nothing.
- **Delete:** stops the session and drops the supervisor row and the reminder state. Provider conversation files stay on disk.
- **Resume:** an owner or guest message resumes a stopped thread. Only an owner message reopens a Closed Conversation. Either way it resumes the same provider conversation (`claude --resume`, or Codex `--resume <uuid>`) in the same cwd and the home the conversation started in, even if the project has since switched accounts. A missing transcript or rollout is a start failure with a one-line reason, never a silent fresh start.

## Capacity

Live thread sessions are capped per provider by the registry's `thread_session_caps`, defaulting to Claude 6 and Codex 8. Only thread sessions count; Channel Conversations never do.

- **Idle:** no turn running, and no owner message for 30 minutes.
- **At the cap:** the longest-idle session is evicted with `Paused to free a session slot; send a message here to resume.` A session mid-turn or booting is never evicted.
- **No idle session:** the thread is queued with `Queued, N sessions busy.` and starts automatically, FIFO per provider, when a slot frees or a running session goes idle. A new thread never passes one already queued for its provider, and a queued thread keeps its first message across a supervisor restart.

## Supervisor down and reconcile

While the supervisor is down, a thread message with no live session gets 💤. The supervisor will reconcile on its own start, on every Router reconnect and on every gateway resume:

- it binds threads it missed;
- it classifies archives it did not see;
- it marks dead sessions `crashed`;
- it starts only threads whose newest owner message is newer than the last agent reply, with the undelivered messages in the bootstrap; a root mention or a native reply to root never counts.

A live session that dies while the supervisor runs is marked `crashed` as soon as the Router reports it gone, which frees its slot. Crashed, failed and operator-stopped sessions never restart automatically; the next owner or guest message resumes them.

## Project changes

- **Deregistration:** stops each thread session and closes the thread (`closed/deregistered`).
- **Channel move:** closes the threads (`closed/project-moved`), because the moved webhook cannot post into the old channel's threads. Each thread remembers the channel it was bound under, so a move made while the supervisor was down closes them on its next start.
- **Path set to `remote:`:** the project now runs on another machine, which has no thread sessions, so its threads close the same way (`closed/project-moved`).
- **Guest changes:** apply on the next message.
- **Channel maintenance:** `restart <project>`, `start-session.sh <project>`, `stop-session.sh <project>` and a project key rotation act on the Channel Conversation only. `stop-session.sh <project> --threads` stops the thread sessions only, and `--all` stops both.

## Conversation Reminders

Each thread is its own Conversation Reminder conversation, keyed `(project, conversation_id)`, where the id is the thread id:

- **Reminders:** root posts 👀 into the thread on the usual 1h → 24h backoff, behind the 5 s gate.
- **Acknowledgment:** the owner's reply acknowledges only that thread. Guests never acknowledge.
- **Close:** `/close` and an owner archive close only that thread's reminders. The next owner message reopens them.
- **Archived threads:** a reminder posted into an auto-archived thread reopens the thread without starting a session.
- **Resets:** a provider or account switch resets tracking. A delete drops the state.
- **Status:** reminder `status` nests threads under their project.

See [docs/conversation-reminders.md](conversation-reminders.md).

## Running the supervisor

The supervisor is a Python worker, which owns the store, capacity, lifecycle and launching, plus a Node link that holds the single `supervisor` Router connection. Its private state is under `~/.local/state/ccdm/thread-supervisor/` (0700, files 0600). The state holds:

- the SQLite store `threads.sqlite3`;
- `worker.lock`;
- the `control.sock` used by `threads.sh` and `stop-session.sh --threads`;
- the LaunchAgent logs `service.log` and `service.err`.

The worker writes a fresh `keys/.supervisor.key` in the Router state on each start.

- **Install** with `scripts/install-thread-supervisor.sh`. It runs the read-only `preflight` (interpreters, Router reachable, registry owner and guild, store) before touching launchd. It then renders a secret-free `com.ccdm.thread-supervisor` plist running `run --supervised`, relaunches only after an unsuccessful exit, and restores the prior plist if a load fails.
- **Inspect** with `scripts/thread-supervisor.py status`. It shows the worker, the caps (and any invalid value) and every bound thread with its state.
- **Disable / enable** with `scripts/thread-supervisor.py disable` and `enable`. While disabled, the supervised worker exits and launchd does not relaunch it. `enable` only clears the disabled marker; it does not start the worker. Rerun `scripts/install-thread-supervisor.sh` afterwards to relaunch the LaunchAgent.
- **Debug in the foreground** with `scripts/thread-supervisor.py disable`, then `scripts/thread-supervisor.py run`. A second worker exits with status 2 while the lock is held.
- **Operate threads** with `scripts/threads.sh list [<project>]` and `scripts/threads.sh stop|restart|close [<project>] <name|link|id>`. `send-claude-command.sh`, guest access (which acts on the parent project) and `export-discord-range.js` also accept a thread id.
- **Router view:** `node scripts/router.js status` lists each `thread` connection, the supervisor line, and root's missing thread permissions while threads are enabled.

## Root permissions

Root needs four permissions for threads. They are **granted once by hand**, and no CCDM script PATCHes permissions:

- **Create Public Threads**, in every project channel;
- **Send Messages in Threads**, in every project channel;
- **Manage Threads**, in every project channel;
- **View Audit Log**, at the guild level, to tell an owner or root archive from an auto-archive.

Grant them on root's role (Server Settings → Roles), or on each project category or channel. `router status` and reminder readiness report any missing bit only while threads are enabled: the supervisor's LaunchAgent plist exists, `thread_session_caps` is in the registry, or a supervisor is connected. Without View Audit Log, archives are recorded as `archive-actor-unknown` and handled as auto-archives, so an owner archive no longer closes the conversation.

## Operator checklist

These steps run once after the thread work is merged and deployed. They touch real Discord, Claude and Codex, so they are not run in CI. The Default CI Suite covers the same flows against local fakes, including `tests/e2e/thread-conversation-journey.test.js`.

**Grant and install:**

- [ ] Grant root Create Public Threads, Send Messages in Threads and Manage Threads on the project channels, and View Audit Log on the guild.
- [ ] Run `scripts/install-thread-supervisor.sh`. Confirm that `scripts/thread-supervisor.py status` shows the worker running.
- [ ] In `node scripts/router.js status`, confirm `supervisor: connected`, `thread_permissions=ok` for each project, and `guild permissions: ok`.

**Live smoke:**

- [ ] **thread → Claude reply:** in a Claude project channel, open a public thread and type a task. Expect 👀 during boot, then a reply in the thread as `<project>-claude · N%`. The Channel Conversation receives nothing.
- [ ] **thread → Codex reply:** repeat in a Codex project channel, or use `/thread smoke --provider codex hello` in a Claude one. Expect a reply in the thread as `<project>-codex · N%`.
- [ ] **`/close`:** send `/close` in one smoke thread. Expect the root-bot acknowledgement and the thread archived. `scripts/threads.sh list` shows it `closed/close-command`, and its tmux session is gone.
- [ ] Optionally send another owner message in the closed thread. It should reopen and answer with the same conversation.

**Clean up:**

- [ ] Delete or archive the smoke threads.
