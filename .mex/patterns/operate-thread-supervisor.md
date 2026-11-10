---
name: operate-thread-supervisor
description: Install, inspect, debug, or operate the Thread Supervisor, its LaunchAgent, and Thread Conversations.
triggers:
  - "thread supervisor"
  - "thread conversation"
  - "threads.sh"
  - "thread permissions"
edges:
  - target: context/session-management.md
    condition: for Thread Conversation lifecycle, commands, capacity, and stop rules
  - target: context/discord-security.md
    condition: for thread Session Scope, the supervisor's credential boundary, and root's thread permissions
  - target: patterns/operate-conversation-reminders.md
    condition: when a thread's reminders, acknowledgment, or closure look wrong
last_updated: 2026-11-10
---

# Operate The Thread Supervisor

## Context
Read `docs/thread-supervisor.md`. The supervisor is a Router client (`supervisor` role) with no Discord credential. It owns Thread Conversation lifecycle; the Router routes thread traffic. Its private state is `~/.local/state/ccdm/thread-supervisor/`.

Thread sessions launch on both OSes. The operator commands for threads and the supervisor's service exist on macOS only today; each Windows line below names the issue that adds it.

## Steps
1. Make sure root has Create Public Threads, Send Messages in Threads and Manage Threads in the project channels, and View Audit Log on the guild. These are granted once by hand in Discord, never by a script.
2. Install supervision only when the operator asks.
   - macOS: run `scripts/install-thread-supervisor.sh`. It runs the read-only `preflight` first and changes nothing if a check fails.
   - Windows: pending (#249). There is no Thread Supervisor service to install yet.
3. Inspect the supervisor and the Router.
   - macOS: `scripts/thread-supervisor.py status` shows the worker, caps, `capacity.invalid` and bound threads.
   - Windows: pending (#249) for the supervisor's status.
   - Both: `node scripts/router.js status` shows the `thread` lines, the `supervisor:` line, `thread_permissions=` per project and `guild permissions:`.
4. Operate threads.
   - macOS: `scripts/threads.sh list [<project>]`, `scripts/threads.sh create <project> <name> [flags] [message]`, and `scripts/threads.sh stop|restart|close [<project>] <name|link|id>`.
   - Windows: pending (#241). `scripts/ccdm` has no `threads` command yet.
5. To stop a project's thread sessions, run `scripts/ccdm stop-session <project> --threads`; `--all` also stops the channel. A plain `scripts/ccdm stop-session <project>` or "restart <project>" touches the channel only.
6. Debug in the foreground.
   - macOS: run `scripts/thread-supervisor.py disable`, then `scripts/thread-supervisor.py run`; `enable` clears the disabled marker but starts nothing, so rerun `scripts/install-thread-supervisor.sh` after it to relaunch the LaunchAgent.
   - Windows: pending (#249).

## Gotchas
- Never edit `threads.sqlite3` by hand; use the thread commands in step 4 or Discord actions (archive, delete, a new owner message).
- `stopped/crashed`, `stopped/start-failed` and `stopped/operator` never restart automatically; the next owner or guest message, or a thread restart from step 4, starts them.
- Without View Audit Log every archive is `archive-actor-unknown` and only stops the session, so an owner archive stops closing conversations.
- A thread message that got 💤 while the supervisor was down is delivered once, through reconcile, only if it is an unanswered owner message.
- Caps come from the registry's `thread_session_caps` (default Claude 6, Codex 8); an invalid value falls back and shows in `status`.

## Verify
- [ ] `router status` shows `supervisor: connected`, `thread_permissions=ok` for every project, and `guild permissions: ok`.
- [ ] macOS: `~/Library/LaunchAgents/com.ccdm.thread-supervisor.plist` holds paths only, with no tokens.
- [ ] A test thread under a project channel gets 👀, then a reply as `<project>-<provider> · N%`.

## Debug
- Check `service.log` and `service.err` in the supervisor state dir.
- A second worker exits with status 2 while `worker.lock` is held.
- A thread that never starts: check the thread list from step 4 for its state and reason, and the one-line start-failure notice in the thread.

## Update Scaffold
- [ ] Update `.mex/ROUTER.md` state and `docs/thread-supervisor.md` if lifecycle or operator behaviour changes.
