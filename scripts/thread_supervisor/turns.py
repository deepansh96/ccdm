"""Whose turn it is in each Thread Conversation, shown as root's reaction on
the input that started it.

The source of truth is the session's own `activity.json` in its launch dir
(`turn_running`, `last_turn_end_at`, and from newer launches `paused`,
`last_turn_outcome` and `turn_replied`), which the CCDM channel server and the
Codex bridge keep, plus the supervisor's own `thread_message` stream.

- A driver input (an owner or guest message that is no command and does not
  address root, or a creation request's first message) makes it the agent's
  turn, and root's ⏳ goes on that message. Only the latest input carries ⏳:
  an earlier one in the same turn loses it.
- On each tick, a `live` thread's turn end newer than the last one seen, held
  for the settle window with no turn running, is taken. If the agent had the
  turn and no input came after that end, the turn passes to the owner and
  the ⏳ becomes ✅ (⚠️ for a failed turn); an interrupted turn just loses its
  ⏳. A turn end with no input since the last one (a compaction, a restart's
  bootstrap, a retry) changes nothing.
- A ✅ or ⚠️ stays on its message for good. A stop takes the ⏳ off (a crash or
  a failed start turns it into ⚠️), and `/close` takes it off before the
  archive, since reactions cannot change in an archived thread.

The store keeps the mark root wants (`mark_*`) apart from the one Discord was
last seen to take (`shown_*`). Event handlers only change the first; the
worker loop makes Discord follow it through the Router's `thread_react`,
retrying a failure with a per-thread backoff, and a message that is gone (or a
thread already archived) counts as done.
"""

from __future__ import annotations

from datetime import datetime, timezone
import json
import os
import re
import sys
import time

from . import capacity, store
from .clock import now
from .link import LinkError


DEFAULT_TICK_SECONDS = 2
DEFAULT_SETTLE_SECONDS = 5
# Thread commands are the supervisor's or the session's, never an input.
COMMAND = re.compile(r"^/(?:close|config|model|restart|clear|compact|pause|unpause)(?:\s|$)")
WAITING, DONE, FAILED = store.WAITING, store.DONE, store.FAILED
# A reaction never holds the worker long.
REACT_TIMEOUT_SECONDS = 5
# A failed reaction is retried after this long, doubling up to the cap.
RETRY_FIRST_SECONDS = 2
RETRY_MAX_SECONDS = 120
# Answers after which the reaction is as settled as it will ever be: the
# message is gone, the thread is archived or out of scope, or the Router has no op.
SETTLED = ("not_found", "thread_archived", "scope_violation", "invalid_args", "unknown_op")
# Failures of the Router itself rather than of one reaction: the rest of a sync pass waits too.
ROUTER_DOWN = ("router_unavailable", "timeout")


class RouterDown(Exception):
    """A mark sync failed because the Router did not answer."""


def _log(message: str) -> None:
    print(f"thread-supervisor: {message}", file=sys.stderr, flush=True)


def _seconds(name: str, default: float) -> float:
    try:
        value = float(os.environ.get(name) or default)
    except ValueError:
        return default
    return value if value >= 0 else default


def _moment(stamp) -> datetime | None:
    if not isinstance(stamp, str) or not stamp:
        return None
    try:
        moment = datetime.fromisoformat(stamp.replace("Z", "+00:00"))
    except ValueError:
        return None
    return moment if moment.tzinfo else moment.replace(tzinfo=timezone.utc)


def _later(first, second) -> bool:
    """Whether ``first`` is after ``second``; an unreadable stamp never is."""
    a, b = _moment(first), _moment(second)
    return bool(a and b and a > b)


def marks_enabled() -> bool:
    """Turn marks are on unless `CCDM_THREAD_TURN_MARKS=0` (the E2E suite's
    default, so other tests' reaction counts stay as they were)."""
    return os.environ.get("CCDM_THREAD_TURN_MARKS") != "0"


def activity(context, row) -> dict | None:
    """The session's activity.json, reread only when it changed; None when unreadable."""
    path = capacity.activity_path(row["project"], row["thread_id"])
    try:
        mtime = path.stat().st_mtime_ns
    except OSError:
        context.activity.pop(row["thread_id"], None)
        return None
    cached = context.activity.get(row["thread_id"])
    if cached and cached[0] == mtime:
        return cached[1]
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return None
    data = data if isinstance(data, dict) else None
    context.activity[row["thread_id"]] = (mtime, data)
    return data


def _addresses_root(context, content: str) -> bool:
    return bool(context.bot_user_id) and re.search(rf"<@!?{re.escape(context.bot_user_id)}>", content) is not None


def on_message(context, event: dict) -> None:
    """Every `thread_message`: a driver input gives the agent the turn."""
    thread_id = event.get("thread_id")
    if not isinstance(thread_id, str):
        return
    row = store.thread(context.db, thread_id)
    if not row or row["project"] != event.get("project"):
        return
    author = event.get("author_class")
    if author not in ("owner", "guest") or (row["state"] == "closed" and author != "owner"):
        return
    content = str(event.get("content") or "").strip()
    if (event.get("to_root") or COMMAND.match(content) or _addresses_root(context, content)
            or not isinstance(event.get("message_id"), str)):
        return
    note_input(context, thread_id, author, event.get("ts"), event["message_id"])


def note_input(context, thread_id: str, kind: str, at=None, message_id: str | None = None) -> None:
    """The agent has the turn from ``at``: the input's own Discord time when
    known, never the time the worker got to it, so a frame handled late (behind
    a reconcile or a slow Router call) does not look newer than the turn end
    that answered it. The recorded input time never moves back. The input's
    message, when it has one, gets ⏳ in place of any earlier input's."""
    stamp = at if _moment(at) else now()
    row = store.thread(context.db, thread_id)
    if row and _later(row["last_input_at"], stamp):
        stamp = row["last_input_at"]
    marks = {"mark_message_id": message_id, "mark_emoji": WAITING} if message_id and marks_enabled() else {}
    store.update(context.db, thread_id, whose_turn="agent", last_input_at=stamp, last_input_class=kind,
                 turn_outcome=None, **marks)


def reset(context, thread_id: str) -> None:
    """A fresh provider conversation (`/clear`, a provider or account switch) waits on no one."""
    store.update(context.db, thread_id, whose_turn=None, turn_outcome=None)
    store.end_waiting(context.db, thread_id)


def baseline(context, thread_id: str) -> None:
    """A session just went live: an end its activity file already holds (the
    previous launch's, or one written as a stop killed it) never counts."""
    row = store.thread(context.db, thread_id)
    if not row:
        return
    context.activity.pop(thread_id, None)
    context.end_first_seen.pop(thread_id, None)
    seen = (activity(context, row) or {}).get("last_turn_end_at")
    store.update(context.db, thread_id, turn_end_seen=seen if _moment(seen) else now())


def on_stop(context, row, failed: bool = False) -> None:
    """A session is stopping: a turn that already ended still counts, with no
    settle wait; otherwise the ⏳ goes, or becomes ⚠️ when ``failed`` (a crash
    or a failed start)."""
    if row["state"] == "live":
        try:
            _observe_turn(context, row, settle=False)
        except Exception as error:  # The stop goes on regardless.
            _log(f"thread {row['thread_id']}: reading its last turn end failed: {error}")
    context.end_first_seen.pop(row["thread_id"], None)
    store.end_waiting(context.db, row["thread_id"], FAILED if failed else None)


def before_archive(context, thread_id: str) -> None:
    """`/close` is about to archive the thread, after which no reaction can
    change: settle its mark as a stop would, and sync it now."""
    row = store.thread(context.db, thread_id)
    if not row:
        return
    on_stop(context, row)
    if not sync_now(context, thread_id):
        _log(f"thread {thread_id}: its turn mark could not change before the archive")


def _observe_turn(context, row, settle: bool = True) -> None:
    """Take a settled turn end from a live session's activity file."""
    thread_id = row["thread_id"]
    current = activity(context, row)
    end = (current or {}).get("last_turn_end_at")
    if current is None or current.get("turn_running") is not False or not _moment(end):
        context.end_first_seen.pop(thread_id, None)
        return
    if row["turn_end_seen"] is None:  # A row from before turn status: its first end is the baseline.
        store.update(context.db, thread_id, turn_end_seen=end)
        return
    if not _later(end, row["turn_end_seen"]):
        return
    if settle:
        first = context.end_first_seen.get(thread_id)
        if not first or first[0] != end:
            context.end_first_seen[thread_id] = (end, time.monotonic())
            first = context.end_first_seen[thread_id]
        if time.monotonic() - first[1] < _seconds("CCDM_THREAD_STATUS_SETTLE_S", DEFAULT_SETTLE_SECONDS):
            return
    context.end_first_seen.pop(thread_id, None)
    store.update(context.db, thread_id, turn_end_seen=end)
    if row["whose_turn"] != "agent" or (row["last_input_at"] and _later(row["last_input_at"], end)):
        return
    outcome = current.get("last_turn_outcome")
    if outcome == "interrupted":
        return store.end_waiting(context.db, thread_id)
    failed = outcome == "failed"
    store.update(context.db, thread_id, whose_turn="owner", turn_outcome="failed" if failed else "completed")
    store.end_waiting(context.db, thread_id, FAILED if failed else DONE)


def _react(context, row, message_id: str, emoji: str, remove: bool = False) -> str | None:
    """One reaction change; None once it is settled, else the failure's code."""
    try:
        context.link.call("thread_react", {"channel_id": row["thread_id"], "message_id": message_id, "emoji": emoji,
                                           **({"remove": True} if remove else {})}, timeout=REACT_TIMEOUT_SECONDS)
    except LinkError as error:
        if error.code in SETTLED:
            return None
        _log(f"thread {row['thread_id']}: {'removing' if remove else 'adding'} {emoji} failed: {error.code}")
        return error.code
    return None


def sync(context, row, force: bool = False) -> bool:
    """Make Discord show the thread's wanted mark: take the shown one off when
    it is ⏳ or sits on the wanted message, forget a ✅ or ⚠️ left on an older
    message, then add the wanted one. True once in sync; a failure waits out
    the thread's backoff unless ``force``. Raises RouterDown, after the
    backoff is set, when the Router did not answer."""
    thread_id = row["thread_id"]
    wanted = (row["mark_message_id"], row["mark_emoji"])
    shown = (row["shown_message_id"], row["shown_emoji"])
    if wanted == shown:
        context.mark_retry.pop(thread_id, None)
        return True
    retry = context.mark_retry.get(thread_id)
    if retry and not force and time.monotonic() < retry[0]:
        return False
    if shown[1] and (shown[1] == WAITING or shown[0] == wanted[0]):
        failure = _react(context, row, shown[0], shown[1], remove=True)
        if failure:
            return _back_off(context, thread_id, failure)
    if shown[1]:
        store.update(context.db, thread_id, shown_message_id=None, shown_emoji=None)
    if wanted[1]:
        failure = _react(context, row, wanted[0], wanted[1])
        if failure:
            return _back_off(context, thread_id, failure)
        store.update(context.db, thread_id, shown_message_id=wanted[0], shown_emoji=wanted[1])
    context.mark_retry.pop(thread_id, None)
    return True


def _back_off(context, thread_id: str, failure: str) -> bool:
    delay = min(RETRY_MAX_SECONDS, (context.mark_retry.get(thread_id) or (0, RETRY_FIRST_SECONDS / 2))[1] * 2)
    context.mark_retry[thread_id] = (time.monotonic() + delay, delay)
    if failure in ROUTER_DOWN:
        raise RouterDown(failure)
    return False


def sync_now(context, thread_id: str) -> bool:
    """Sync one thread's mark at once, past its backoff: `/close` uses it before archiving."""
    row = store.thread(context.db, thread_id)
    try:
        return sync(context, row, force=True) if row else True
    except RouterDown:
        return False


def sync_marks(context) -> None:
    """Every thread whose mark Discord does not show yet, each failure on its
    own backoff. A Router that does not answer ends the pass, so one outage
    never holds the worker for a timeout per thread."""
    for row in store.unsynced_marks(context.db):
        try:
            sync(context, row)
        except RouterDown:
            return
        except Exception as error:  # One thread must not stop the rest.
            _log(f"thread {row['thread_id']}: syncing its turn mark failed: {error}")


def tick(context, force: bool = False) -> None:
    """Every few seconds: take each live thread's settled turn end."""
    interval = _seconds("CCDM_THREAD_STATUS_TICK_S", DEFAULT_TICK_SECONDS)
    if not force and time.monotonic() - context.status_tick_at < interval:
        return
    context.status_tick_at = time.monotonic()
    for (thread_id,) in context.db.execute("SELECT thread_id FROM threads WHERE state = 'live'").fetchall():
        try:
            row = store.thread(context.db, thread_id)
            if row is not None and row["state"] == "live":  # Not deleted or stopped while this tick ran.
                _observe_turn(context, row)
        except Exception as error:  # One thread must not stop the rest.
            _log(f"thread {thread_id}: the status tick failed: {error}")
