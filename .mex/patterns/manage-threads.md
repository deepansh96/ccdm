---
name: manage-threads
description: List, stop, restart, or close a project's Thread Conversations, or stop all of a project's thread sessions.
triggers:
  - "list threads"
  - "stop thread"
  - "restart thread"
  - "close thread"
  - "stop-session --threads"
edges:
  - target: context/session-management.md
    condition: always before changing thread session state
  - target: patterns/manage-session.md
    condition: when the request is about the project's Channel Conversation
last_updated: 2026-09-28
---

# Manage Threads

## Steps
1. Run `scripts/threads.sh list <project>` to see each thread's name, id, provider/model, state with stop reason, and idle time. It reads the thread store and works without the supervisor.
2. Name the thread by its link `https://discord.com/channels/<guild_id>/<thread_id>`, its id, or its exact name. Add the project before a name (`scripts/threads.sh stop <project> <name>`) when several projects might share it.
3. Run `scripts/threads.sh stop|restart|close [<project>] <thread>`:
   - `stop` marks the thread `stopped/operator`; the owner's next message resumes it.
   - `restart` resumes a live or stopped thread's conversation.
   - `close` archives it with the project bot and marks it `closed`, including a stopped thread.
4. To stop every thread session of a project, run `scripts/stop-session.sh <project> --threads`. Use `--all` to also stop the Channel Conversation.

## Gotchas
- `stop`, `restart`, and `close` go through the running Thread Supervisor. If it is not running, they fail with the reason; start it first (`scripts/install-thread-supervisor.sh` or `scripts/thread-supervisor.py run`).
- An ambiguous name fails and lists every match with its project and id. Retry with the project or the link. Never guess.
- A booting or closed thread refuses all three operations. Wait for a booting thread to go live.
- `scripts/stop-session.sh <project>` without a flag stops only the Channel Conversation. "Restart <project>" still means the channel, never its threads.
- `--threads` updates the thread store and sweeps thread tmux sessions and listeners even when the supervisor is down. It never touches the channel session or its registry `pid`/`session_id`.

## Verify
- [ ] `scripts/threads.sh list <project>` shows the expected state (`stopped/operator`, `live`, or `closed`).
- [ ] After `--threads`, no `<screen_name>-t-*` or `<screen_name>-threads` tmux session remains for the project.
- [ ] The Channel Conversation's tmux session is unchanged unless `--all` was used.

## Debug
Check `scripts/thread-supervisor.py status` for the thread's row, and use `patterns/debug-discord-session.md` for a thread that does not answer.

## Update Scaffold
- [ ] Update `context/session-management.md` if thread operations change.
