"""The thread status board: one root-bot message in the registry's status channel, edited in place.

Under a small `-# CCDM threads` line it shows what needs the owner:

    🔔 Waiting on you (N)      oldest first: <#thread> · project · <t:…:R>
    ⏳ Working (N)             <#thread> · project
    💤 N idle · ⚠️ M failed today

An empty section is left out. A failed turn waits on the owner like any
other. ⚠️ counts crashes and failed starts of the last 24 hours and is left
out at 0; older ones, and stopped, paused and new threads, count as idle.
With nothing waiting or working the board is one line,
`✅ Nothing needs you · 💤 N idle`. It never grows past one message: past
Discord's limit the lowest section loses lines, shown as "+N more".

The text changes only when a state does, and a flush, at most once per
interval, edits only when the text changed, one Router call at a time (5 s
timeout), never while a frame waits.

The board's message is kept in the store's `status_board` table. With none
stored (a new store, or a new channel), root's own messages that start with
the header are adopted, oldest first; any beyond the first (an older
multi-message board) are deleted, so a restart never posts a second board. A
post that timed out is looked for the same way before the next post. The
message deleted in Discord makes the board post again. With
`thread_status_channel_id` unset or invalid, or a Router that does not
advertise the `status_board` capability, the board is off: nothing is
posted, and no error is raised.
"""

from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import os
import re
import sys
import time

from . import registry, store
from .link import LinkError


# The board's first line: small grey text, and how adoption knows root's own board.
HEADER = "-# CCDM threads"
MESSAGE_LIMIT = 2000
DEFAULT_INTERVAL_SECONDS = 10
# A crash or failed start this recent counts as failed; an older one as idle.
FAILED_WINDOW_SECONDS = 24 * 3600
SNOWFLAKE = re.compile(r"\d{17,20}")
# A board call never holds the worker long.
CALL_TIMEOUT_SECONDS = 5
# Failures after which a post may have landed anyway.
AMBIGUOUS = ("timeout", "discord_error", "router_unavailable")
# The Router's hello_ok capability for the status_board ops.
CAPABILITY = "status_board"


def _log(message: str) -> None:
    print(f"thread-supervisor: {message}", file=sys.stderr, flush=True)


def interval_seconds() -> float:
    try:
        value = float(os.environ.get("CCDM_THREAD_STATUS_BOARD_INTERVAL_S") or DEFAULT_INTERVAL_SECONDS)
    except ValueError:
        return DEFAULT_INTERVAL_SECONDS
    return value if value >= 0 else DEFAULT_INTERVAL_SECONDS


def channel_setting(current: dict) -> tuple[str | None, str | None]:
    """The status channel, or why the board is off: (channel_id, None), (None, None) when unset, or (None, error)."""
    value = current.get("thread_status_channel_id")
    if value is None:
        return None, None
    # The same rule as the Router's (scripts/router/registry.js STATUS_CHANNEL_ID): a
    # snowflake string, nothing stripped, so the two always agree.
    if not (isinstance(value, str) and SNOWFLAKE.fullmatch(value)):
        return None, "thread_status_channel_id must be a Discord channel ID (17-20 digits)"
    channel = value
    if channel in {str(item) for item in current.get("root_channels") or [] if isinstance(item, (str, int))}:
        return None, "thread_status_channel_id is a root channel"
    projects = current.get("projects")
    for name, entry in (projects.items() if isinstance(projects, dict) else ()):
        if isinstance(entry, dict) and str(entry.get("channel_id")) == channel:
            return None, f"thread_status_channel_id is project {name}'s channel"
    return channel, None


def _epoch(stamp) -> int:
    try:
        moment = datetime.fromisoformat(str(stamp).replace("Z", "+00:00"))
    except ValueError:
        return int(time.time())
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return int(moment.timestamp())


def _buckets(context, rows: dict, now_s: int) -> tuple[list, list, int, int]:
    """Open threads by what they ask of the owner: waiting rows, working rows,
    and the idle and recently failed counts."""
    waiting, working, idle, failed = [], [], 0, 0
    for thread_id, (state, label) in context.labels.items():
        row = rows.get(thread_id)
        if row is None:
            continue
        if state == "waiting" or (state == "failed" and label.startswith("turn failed")):
            waiting.append(row)  # A failed turn hands the turn to the owner too.
        elif state == "working":
            working.append(row)
        elif state == "failed" and now_s - _epoch(row["display_since"]) < FAILED_WINDOW_SECONDS:
            failed += 1
        else:
            idle += 1  # Idle, paused, new, stopped, and failures older than a day.
    order = lambda row: (_epoch(row["display_since"]), row["thread_id"])  # noqa: E731
    return sorted(waiting, key=order), sorted(working, key=order), idle, failed


def _fit(sections: list[tuple[str, list[str]]], summary: str) -> str:
    """The one board message: each non-empty section's header, count and
    lines, then the summary. Past the message limit the lowest section loses
    lines first, each cut shown as "+N more"."""
    keep = [len(lines) for _title, lines in sections]

    def text() -> str:
        out = [HEADER]
        for (title, lines), kept in zip(sections, keep):
            if not lines:
                continue
            out.append(f"{title} ({len(lines)})")
            out.extend(lines[:kept])
            if kept < len(lines):
                out.append(f"+{len(lines) - kept} more")
        out.append(summary)
        return "\n".join(out)

    for index in reversed(range(len(sections))):
        while len(text()) > MESSAGE_LIMIT and keep[index] > 0:
            keep[index] -= 1
    return text()


def render(context, current: dict) -> list[str]:
    """The board: always one message."""
    rows = {row["thread_id"]: row for row in context.db.execute("SELECT * FROM threads WHERE state != 'closed'")}
    waiting, working, idle, failed = _buckets(context, rows, int(time.time()))
    summary = f"💤 {idle} idle" + (f" · ⚠️ {failed} failed today" if failed else "")
    if not waiting and not working:
        return [f"{HEADER}\n✅ Nothing needs you · {summary}"]
    return [_fit([
        ("🔔 Waiting on you", [f"<#{row['thread_id']}> · {row['project']} · <t:{_epoch(row['display_since'])}:R>"
                              for row in waiting]),
        ("⏳ Working", [f"<#{row['thread_id']}> · {row['project']}" for row in working]),
    ], summary)]


def _sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _numeric(message_id: str) -> tuple[int, str]:
    return (len(message_id), message_id)


def _adopt(context, channel: str, slots) -> None:
    """Take over root's board messages in the channel that the store does not
    hold: all of them, oldest first, when it holds none; otherwise those newer
    than its last one (a post that landed after the worker stopped waiting)."""
    result = context.link.call("status_board_list", {}, timeout=CALL_TIMEOUT_SECONDS) or {}
    found = sorted((message["id"] for message in result.get("messages") or []
                    if isinstance(message, dict) and isinstance(message.get("id"), str)
                    and str(message.get("content") or "").startswith(HEADER)), key=_numeric)
    known = [slot["message_id"] for slot in slots]
    newest = max((_numeric(message_id) for message_id in known), default=None)
    fresh = [message_id for message_id in found
             if message_id not in known and (newest is None or _numeric(message_id) > newest)]
    for slot, message_id in enumerate(fresh, len(slots) + 1):
        store.set_board_slot(context.db, slot, channel, message_id, "")


def _reset(context) -> None:
    store.drop_board_slots(context.db)
    context.board_adopted = False
    context.board_readopt = False


def supported(context) -> bool:
    """Whether the connected Router serves the board ops (its hello_ok capability)."""
    return not context.status_ops_missing and CAPABILITY in (context.router_capabilities or ())


def flush(context, force: bool = False) -> None:
    """Bring the status channel's board one call closer to the current text.

    Each flush makes at most one Router call, with a short timeout, and asks
    for the next flush at once while work remains; the worker runs a flush
    only when no frame waits, so the board never delays a session going live
    or its bootstrap."""
    if not force and time.monotonic() - context.board_flush_at < interval_seconds():
        return
    context.board_flush_at = time.monotonic()
    try:
        current = registry.load(context.project_root)
    except (OSError, ValueError):
        return
    channel, _error = channel_setting(current)
    slots = store.board_slots(context.db)
    if channel is None or not supported(context):
        if slots and channel is None:
            _reset(context)
        return
    if any(slot["channel_id"] != channel for slot in slots):
        _reset(context)  # A new channel: the old board's messages stay where they were.
        slots = []
    try:
        if _step(context, channel, current, slots):
            context.board_flush_at = 0.0  # More may remain: the next loop goes on.
    except LinkError as error:
        if error.code == "unknown_op":
            context.status_ops_missing = True
            _log("the Router has no status board ops yet; the board is off until it reconnects")
        elif error.code in ("status_channel_unset", "status_channel_invalid"):
            _log(f"the status board is off: {error}")
        else:
            _log(f"the status board update failed: {error.code}")


def _step(context, channel: str, current: dict, slots) -> bool:
    """One board call toward the current text; False when the board is up to date."""
    if context.board_orphans:
        _delete(context, context.board_orphans.pop(0))
        return True
    if (not slots and not context.board_adopted) or context.board_readopt:
        context.board_adopted, context.board_readopt = True, False
        _adopt(context, channel, slots)
        return True
    texts = render(context, current)
    for index, text in enumerate(texts, 1):
        sha = _sha(text)
        if index <= len(slots):
            slot = slots[index - 1]
            if slot["content_sha256"] == sha:
                continue
            try:
                context.link.call("status_board_edit", {"message_id": slot["message_id"], "text": text},
                                  timeout=CALL_TIMEOUT_SECONDS)
            except LinkError as error:
                if error.code not in ("not_found", "scope_violation"):
                    raise
                # Someone deleted (or replaced) a board message: delete the
                # rest, then post the whole board again, in order.
                context.board_orphans = [other["message_id"] for other in slots if other is not slot]
                _reset(context)
                context.board_adopted = True
                return True
            store.set_board_slot(context.db, index, channel, slot["message_id"], sha)
            return True
        try:
            result = context.link.call("status_board_post", {"text": text}, timeout=CALL_TIMEOUT_SECONDS) or {}
        except LinkError as error:
            if error.code in AMBIGUOUS:
                context.board_readopt = True  # It may have landed: look before posting again.
            raise
        store.set_board_slot(context.db, index, channel, str(result["message_id"]), sha)
        return True
    if len(slots) > len(texts):
        _delete(context, slots[-1]["message_id"])
        store.drop_board_slots(context.db, len(slots))
        return True
    return False


def _delete(context, message_id: str) -> None:
    try:
        context.link.call("status_board_delete", {"message_id": message_id}, timeout=CALL_TIMEOUT_SECONDS)
    except LinkError as error:
        _log(f"deleting status board message {message_id} failed: {error.code}")


def status(current: dict | None, slots: list[dict]) -> dict:
    """The board's configuration and messages, for `thread-supervisor.py status`."""
    if current is None:
        return {"state": "off", "error": "the registry could not be read"}
    channel, error = channel_setting(current)
    if error:
        return {"state": "invalid", "error": error}
    if channel is None:
        return {"state": "off"}
    return {"state": "on", "channel_id": channel,
            "message_ids": [slot["message_id"] for slot in slots if slot.get("channel_id") == channel]}
