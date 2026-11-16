"""Whose turn it is in each Thread Conversation, its board state, and the owner ping.

The source of truth is the session's own `activity.json` in its launch dir
(`turn_running`, `last_turn_end_at`, and from newer launches `paused`,
`last_turn_outcome` and `turn_replied`), which the CCDM channel server and the
Codex bridge keep, plus the supervisor's own `thread_message` stream.

- A driver input (an owner or guest message that is no command and does not
  address root, or a creation request's first message) makes it the agent's
  turn.
- On each tick, a `live` thread's turn end newer than the last one seen, held
  for the settle window with no turn running, is taken. If the agent had the
  turn and no input came after that end, the turn passes to the owner, and
  the owner gets one ping in the thread, unless the turn was a guest's, was
  interrupted, or pings are off. A turn with no input since the last end (a
  compaction, a restart's bootstrap, a retry) changes nothing.
- The owner's next message in the thread deletes the ping, as does the next
  ping and `/close` (before its archive). Only `live` threads are evaluated,
  so a stop, a crash or `/close` never pings.

Each tick also derives every open thread's board state (⏳ working, 🔔
waiting on you, 💤 idle, ⚠️ failed) and records when it last changed.
"""

from __future__ import annotations

from datetime import datetime, timezone
import json
import os
import re
import sys
import time

from . import capacity, lifecycle, registry, store
from .clock import now
from .link import LinkError


DEFAULT_TICK_SECONDS = 2
DEFAULT_SETTLE_SECONDS = 5
# How long an input may wait for its turn to start before the thread counts as idle.
INPUT_GRACE_SECONDS = 60
# How long a ping the Router could not post yet is retried.
PING_RETRY_SECONDS = 300
RETRYABLE = ("router_unavailable", "rate_limited", "timeout", "discord_error")
# Thread commands are the supervisor's or the session's, never an input.
COMMAND = re.compile(r"^/(?:close|config|model|restart|clear|compact|pause|unpause)(?:\s|$)")
PING = "🔔 {owner} ready for you"
PING_NO_REPLY = "🔔 {owner} finished without a reply"
PING_FAILED = "⚠️ {owner} the last turn failed"


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


def pings_enabled(current: dict) -> bool:
    """The registry's `thread_owner_pings` (on unless false); `CCDM_THREAD_OWNER_PINGS=0|1` overrides it."""
    override = os.environ.get("CCDM_THREAD_OWNER_PINGS")
    if override in ("0", "1"):
        return override == "1"
    return current.get("thread_owner_pings") is not False


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
    """Every `thread_message`: the owner's deletes the ping; a driver input gives the agent the turn."""
    thread_id = event.get("thread_id")
    if not isinstance(thread_id, str):
        return
    row = store.thread(context.db, thread_id)
    if not row or row["project"] != event.get("project"):
        return
    author = event.get("author_class")
    if author == "owner":
        delete_ping(context, row)
    if author not in ("owner", "guest") or (row["state"] == "closed" and author != "owner"):
        return
    content = str(event.get("content") or "").strip()
    if (event.get("to_root") or COMMAND.match(content) or _addresses_root(context, content)
            or not isinstance(event.get("message_id"), str)):
        return
    note_input(context, thread_id, author)


def note_input(context, thread_id: str, kind: str) -> None:
    store.update(context.db, thread_id, whose_turn="agent", last_input_at=now(), last_input_class=kind,
                 turn_outcome=None)
    context.pending_pings.pop(thread_id, None)


def reset(context, thread_id: str) -> None:
    """A fresh provider conversation (`/clear`, a provider or account switch) waits on no one."""
    store.update(context.db, thread_id, whose_turn=None, turn_outcome=None)
    context.pending_pings.pop(thread_id, None)


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


def delete_ping(context, row) -> None:
    """Delete the thread's owner ping, if it has one; a ping that is already gone is fine."""
    context.pending_pings.pop(row["thread_id"], None)
    message_id = row["ping_message_id"]
    if not message_id:
        return
    store.update(context.db, row["thread_id"], ping_message_id=None)
    try:
        context.link.call("thread_notice_delete", {"channel_id": row["thread_id"], "message_id": message_id})
    except LinkError as error:
        _log(f"thread {row['thread_id']}: deleting the owner ping failed: {error.code}")


def _ping(context, thread_id: str, text: str, deadline: float) -> None:
    row = store.thread(context.db, thread_id)
    if not row:
        return
    delete_ping(context, row)
    try:
        result = context.link.call("thread_notice", {"channel_id": thread_id, "text": text, "mention_owner": True})
    except LinkError as error:
        if error.code in RETRYABLE and time.monotonic() < deadline:
            context.pending_pings[thread_id] = (text, deadline)
        elif error.code == "unknown_op":
            context.status_ops_missing = True
            _log("the Router has no owner ping op yet; pings are off until it reconnects")
        else:
            _log(f"thread {thread_id}: the owner ping failed: {error.code}")
        return
    message_id = (result or {}).get("message_id") if isinstance(result, dict) else None
    if message_id:
        store.update(context.db, thread_id, ping_message_id=str(message_id))


def _ping_eligible(context, row) -> bool:
    if context.status_ops_missing or row["state"] != "live" or row["last_input_class"] == "guest":
        return False
    try:
        if not pings_enabled(registry.load(context.project_root)):
            return False
    except (OSError, ValueError):
        return False
    return lifecycle.session_running(row["thread_id"])


def _observe_turn(context, row) -> None:
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
    first = context.end_first_seen.get(thread_id)
    if not first or first[0] != end:
        context.end_first_seen[thread_id] = (end, time.monotonic())
        first = context.end_first_seen[thread_id]
    if time.monotonic() - first[1] < _seconds("CCDM_THREAD_STATUS_SETTLE_S", DEFAULT_SETTLE_SECONDS):
        return
    context.end_first_seen.pop(thread_id, None)
    store.update(context.db, thread_id, turn_end_seen=end)
    outcome = current.get("last_turn_outcome")
    if (row["whose_turn"] != "agent" or outcome == "interrupted"
            or (row["last_input_at"] and _later(row["last_input_at"], end))):
        return
    failed = outcome == "failed"
    store.update(context.db, thread_id, whose_turn="owner", turn_outcome="failed" if failed else "completed")
    if _ping_eligible(context, store.thread(context.db, thread_id)):
        text = PING_FAILED if failed else PING_NO_REPLY if current.get("turn_replied") is False else PING
        _ping(context, thread_id, text, time.monotonic() + PING_RETRY_SECONDS)


def _retry_pings(context) -> None:
    for thread_id, (text, deadline) in list(context.pending_pings.items()):
        context.pending_pings.pop(thread_id, None)
        row = store.thread(context.db, thread_id)
        if row and row["whose_turn"] == "owner" and _ping_eligible(context, row) and time.monotonic() < deadline:
            _ping(context, thread_id, text, deadline)


def display(context, row) -> tuple[str, str] | None:
    """A thread's board state and its label; None for a closed thread."""
    state, reason = row["state"], row["stop_reason"]
    if state == "closed":
        return None
    if state == "queued":
        return "working", "queued"
    if state == "booting":
        return "working", "starting"
    live = state == "live"
    current = activity(context, row) if live else None
    if live and (current is None or current.get("turn_running") is not False):
        return "working", "working"
    if live and current is not None and current.get("paused") is True:
        return "idle", "paused"
    if state == "stopped" and reason == "crashed":
        return "failed", "crashed"
    if state == "stopped" and reason == "start-failed":
        return "failed", "start failed"
    if row["whose_turn"] == "owner":
        suffix = ("" if live else " · session stopped") + (" · guest" if row["last_input_class"] == "guest" else "")
        if row["turn_outcome"] == "failed":
            return "failed", "turn failed" + suffix
        return "waiting", "waiting on you" + suffix
    if live and row["whose_turn"] == "agent" and row["last_input_at"] and \
            capacity.age_seconds(row["last_input_at"]) < INPUT_GRACE_SECONDS:
        return "working", "starting turn"
    if live:
        return "idle", "idle"
    if state == "registered":
        return "idle", "new"
    return "idle", f"stopped ({reason})" if reason else "stopped"


def tick(context, force: bool = False) -> None:
    """Every few seconds: take settled turn ends, retry pings, and refresh each open thread's board state."""
    interval = _seconds("CCDM_THREAD_STATUS_TICK_S", DEFAULT_TICK_SECONDS)
    if not force and time.monotonic() - context.status_tick_at < interval:
        return
    context.status_tick_at = time.monotonic()
    rows = context.db.execute("SELECT thread_id FROM threads WHERE state != 'closed'").fetchall()
    labels = {}
    for (thread_id,) in rows:
        try:
            row = store.thread(context.db, thread_id)
            if row is not None and row["state"] == "live":
                _observe_turn(context, row)
                row = store.thread(context.db, thread_id)
            if row is None:  # Deleted while this tick ran.
                continue
            shown = display(context, row)
            if shown is None:
                continue
            labels[thread_id] = shown
            if shown[0] != row["display_state"] or not row["display_since"]:
                store.update(context.db, thread_id, display_state=shown[0], display_since=now())
        except Exception as error:  # One thread must not stop the rest.
            _log(f"thread {thread_id}: the status tick failed: {error}")
    context.labels = labels
    _retry_pings(context)
