"""In-thread commands the Router hands the supervisor as `thread_command`.

Each affects only its own thread. `/restart` relaunches the session into the
same provider conversation and `/clear` relaunches it fresh; both are open to
the owner and guests, and only the owner's reopens a closed thread. `/close`
is the owner's: the acknowledgement is posted first (a post after archiving
would unarchive the thread), `pending_close` is set, the thread is archived
through `thread_update`, the session stops, and the row is
`closed/close-command`. `/compact`, `/pause` and `/unpause` reach the supervisor
only when the thread has no live session. Every answer is a root-bot notice.
A `/restart`, `/clear` or `/close` that arrives while the thread's launcher
still runs waits for it to exit, so a stop never races a launch.
"""

from __future__ import annotations

import json
import sys

from . import boot, lifecycle, store
from .clock import now
from .link import LinkError


NO_LIVE_SESSION = "No live session in this thread."
OWNER_ONLY_CLOSE = "Only the owner can close this thread."
OWNER_ONLY_REOPEN = "Only the owner can reopen a closed thread."
RESTARTING = "Restarting this thread's session."
CLEARING = "Starting a fresh conversation in this thread."
CLOSING = "Closing this thread."


def _log(message: str) -> None:
    print(f"thread-supervisor: {message}", file=sys.stderr, flush=True)


def _notice(context, thread_id: str, text: str) -> None:
    try:
        context.link.call("thread_notice", {"channel_id": thread_id, "text": text})
    except LinkError as error:
        _log(f"thread {thread_id}: the notice failed: {error.code}")


def on_thread_command(context, event: dict) -> None:
    thread_id = event.get("thread_id")
    if not isinstance(thread_id, str):
        return
    row = store.thread(context.db, thread_id)
    if not row or row["project"] != event.get("project"):
        return
    owner = bool((event.get("author") or {}).get("is_owner"))
    command = event.get("command")
    if command in ("compact", "pause", "unpause"):
        return _notice(context, thread_id, NO_LIVE_SESSION)
    launching = context.boots.get(thread_id)
    if command in ("restart", "clear", "close") and launching and not launching.launched:
        launching.deferred = event  # The latest one wins.
        return
    if command in ("restart", "clear"):
        _relaunch(context, row, owner, fresh=command == "clear")
    elif command == "close":
        _close(context, row, owner, event)


def _relaunch(context, row, owner: bool, fresh: bool) -> None:
    thread_id = row["thread_id"]
    if row["state"] == "closed" and not owner:
        return _notice(context, thread_id, OWNER_ONLY_REOPEN)
    _notice(context, thread_id, CLEARING if fresh else RESTARTING)
    context.archive_polls.pop(thread_id, None)
    lifecycle.stop_session(context, row)
    if fresh:
        store.update(context.db, thread_id, provider_conversation_id=None)
    # The command itself is never a turn: the new session gets no trigger and no starter.
    boot.start(context, store.thread(context.db, thread_id), None, starter="")


def _close(context, row, owner: bool, event: dict) -> None:
    thread_id = row["thread_id"]
    if not owner:
        return _notice(context, thread_id, OWNER_ONLY_CLOSE)
    _notice(context, thread_id, CLOSING)
    store.update(context.db, thread_id, pending_close=json.dumps({"message_id": event.get("message_id"),
                                                                  "requested_at": now()}))
    try:
        context.link.call("thread_update", {"thread_id": thread_id, "archived": True})
    except LinkError as error:
        _log(f"thread {thread_id}: archiving for /close failed: {error.code}")
    context.archive_polls.pop(thread_id, None)
    lifecycle.stop_session(context, store.thread(context.db, thread_id))
    store.update(context.db, thread_id, state="closed", stop_reason=None, close_reason="close-command",
                 pending_close=None)
