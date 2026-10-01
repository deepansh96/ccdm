"""Per-provider caps on live thread sessions, with idle eviction and a FIFO queue.

Caps come from the registry's `thread_session_caps`, read on each admission,
defaulting to `{claude: 6, codex: 8}`; an invalid value falls back to its
default and shows in `status`. Only `booting` and `live` thread rows count.
At a provider's cap, the idle live row with the oldest owner activity is
stopped as `stopped/evicted` with a pause notice in its thread. Idle means
its launch dir's activity.json says no turn is running, and its last owner
message (or its creation) is at least 30 minutes old; a missing or unreadable
activity.json means busy, and a booting session (or one whose launcher still
runs) is never evicted. With no idle victim, or with rows already queued for
its provider, the row is `queued` behind every other queued row, with a
notice naming the provider's live count; its trigger and starter are stored
on the row, so a supervisor restart keeps them. After every event, each
provider's queue drains in FIFO order into free slots, evicting idle sessions
for its head as an admission would.
"""

from __future__ import annotations

from datetime import datetime, timezone
import json
import os
import sys

from . import lifecycle, registry, store
from .link import LinkError
from .paths import router_state_dir


DEFAULT_CAPS = {"claude": 6, "codex": 8}
DEFAULT_IDLE_SECONDS = 30 * 60
RUNNING = ("booting", "live")
PAUSED = "Paused to free a session slot; send a message here to resume."


def _log(message: str) -> None:
    print(f"thread-supervisor: {message}", file=sys.stderr, flush=True)


def caps(current: dict) -> tuple[dict, list[str]]:
    """Each provider's cap, and a line for every invalid value replaced by its default."""
    configured = current.get("thread_session_caps")
    if configured is None:
        return dict(DEFAULT_CAPS), []
    if not isinstance(configured, dict):
        return dict(DEFAULT_CAPS), ["thread_session_caps must be an object; using the defaults"]
    result, invalid = dict(DEFAULT_CAPS), []
    for provider, default in DEFAULT_CAPS.items():
        if provider not in configured:
            continue
        value = configured[provider]
        if isinstance(value, int) and not isinstance(value, bool) and value >= 1:
            result[provider] = value
        else:
            invalid.append(f"thread_session_caps.{provider} must be a positive integer, not {json.dumps(value)}; "
                           f"using {default}")
    return result, invalid


def idle_seconds() -> float:
    value = os.environ.get("CCDM_THREAD_IDLE_S")
    try:
        seconds = float(value) if value else DEFAULT_IDLE_SECONDS
    except ValueError:
        return DEFAULT_IDLE_SECONDS
    return seconds if seconds >= 0 else DEFAULT_IDLE_SECONDS


def activity_path(project: str, thread_id: str):
    return router_state_dir() / "launches" / project / "threads" / thread_id / "activity.json"


def _turn_running(row) -> bool:
    try:
        activity = json.loads(activity_path(row["project"], row["thread_id"]).read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return True
    return not (isinstance(activity, dict) and activity.get("turn_running") is False)


def _last_activity(row) -> str:
    return row["last_owner_activity_at"] or row["created_at"]


def age_seconds(stamp: str) -> float:
    try:
        moment = datetime.fromisoformat(stamp.replace("Z", "+00:00"))
    except ValueError:
        return 0.0
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return (datetime.now(timezone.utc) - moment).total_seconds()


def _running(db, provider: str, except_thread_id: str | None = None) -> list:
    return [row for row in db.execute("SELECT * FROM threads WHERE state IN ('booting', 'live') AND resolved_provider=?",
                                      (provider,))
            if row["thread_id"] != except_thread_id]


def _notice(context, thread_id: str, text: str) -> None:
    try:
        context.link.call("thread_notice", {"channel_id": thread_id, "text": text})
    except LinkError as error:
        _log(f"thread {thread_id}: the capacity notice failed: {error.code}")


def _victim(context, rows):
    """The idle live row whose owner activity is oldest. A row whose launcher
    still runs is never one: its stop would race the launch."""
    threshold = idle_seconds()
    idle = [row for row in rows if row["state"] == "live" and row["thread_id"] not in context.boots
            and not _turn_running(row) and age_seconds(_last_activity(row)) >= threshold]
    return min(idle, key=_last_activity, default=None)


def _queued_ahead(db, provider: str, row) -> list:
    """The queued rows for ``provider`` that start before ``row``: all of them,
    unless ``row`` is queued itself, when only those ahead of it."""
    ahead = db.execute("SELECT * FROM threads WHERE state='queued' AND resolved_provider=? AND thread_id != ?",
                       (provider, row["thread_id"])).fetchall()
    if row["state"] == "queued":
        ahead = [other for other in ahead if other["queue_position"] < row["queue_position"]]
    return ahead


def admit(context, row, resolved: dict, trigger: dict | None, starter: str | None) -> bool:
    """Whether ``row`` may start now, evicting an idle session for it at the
    cap. Otherwise it is queued, behind every row already queued for its
    provider, with its ``trigger`` and ``starter`` stored for when it starts."""
    provider = resolved["provider"]
    cap = caps(registry.load(context.project_root))[0].get(provider, 1)
    running = _running(context.db, provider, row["thread_id"])
    if not _queued_ahead(context.db, provider, row):
        if len(running) < cap:
            return True
        victim = _victim(context, running) if len(running) == cap else None
        if victim is not None:
            lifecycle.stop_session(context, victim)
            store.finish_boot(context.db, victim["thread_id"], "stopped", "evicted")
            _notice(context, victim["thread_id"], PAUSED)
            return True
    if row["state"] != "queued":  # A queued row keeps its place and what it starts with.
        store.enqueue(context.db, row["thread_id"], resolved, json.dumps({"trigger": trigger, "starter": starter}))
        _notice(context, row["thread_id"], f"Queued, {len(running)} sessions busy.")
    return False


def _queued_start(row) -> dict:
    try:
        kept = json.loads(row["queued_start"] or "{}")
    except json.JSONDecodeError:
        kept = {}
    return kept if isinstance(kept, dict) else {}


def drain(context) -> None:
    """Start queued rows, oldest first per provider, while their provider has
    a free slot or an idle session to evict; a provider's queue stops at the
    first row that cannot start, so no later row passes it."""
    from . import boot  # boot admits through this module.

    queued = context.db.execute("SELECT * FROM threads WHERE state='queued' ORDER BY queue_position").fetchall()
    blocked = set()
    for row in queued:
        provider = row["resolved_provider"]
        if provider in blocked:
            continue
        kept = _queued_start(row)
        boot.start(context, row, kept.get("trigger"), kept.get("starter"))
        current = store.thread(context.db, row["thread_id"])
        if current and current["state"] == "queued":
            blocked.add(provider)
