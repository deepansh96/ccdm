"""The thread status board: root-bot messages in the registry's status channel, edited in place.

It lists every open Thread Conversation, grouped by board state in attention
order (🔔 waiting on you, ⚠️ failed, ⏳ working, 💤 idle), each with a jump
link, its project, provider/model, its state, and a self-updating relative
time since that state began. The text changes only when a state does, and a
flush, at most once per interval, edits only the messages whose text changed.
Past `MAX_SLOTS` messages the idle threads collapse to a count.

The board's messages are kept in the store's `status_board` table. With none
stored (a new store, or a new channel), root's own messages that start with
the board header are adopted, so a restart never posts a second board. A
message deleted in Discord makes the whole board post again, in order. With
`thread_status_channel_id` unset or invalid the board is off: nothing is
posted, and no error is raised.
"""

from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import os
import sys
import time

from . import registry, store
from .link import LinkError


HEADER = "-# CCDM threads"
MESSAGE_LIMIT = 2000
MAX_SLOTS = 5
DEFAULT_INTERVAL_SECONDS = 10
ORDER = ("waiting", "failed", "working", "idle")
ICONS = {"waiting": "🔔", "failed": "⚠️", "working": "⏳", "idle": "💤"}


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
    # The Router's isId: a non-empty string or a positive integer.
    if not ((isinstance(value, str) and value.strip()) or (type(value) is int and value > 0)):
        return None, "thread_status_channel_id must be a Discord ID"
    channel = str(value).strip()
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


def _line(current: dict, row, shown: tuple[str, str]) -> str:
    entry = registry.project(current, row["project"]) or {}
    settings = registry.resolved_settings(entry, row)
    provider = row["resolved_provider"] or settings["provider"]
    model = row["resolved_model"] or settings["model"] or "default"
    return (f"{ICONS[shown[0]]} <#{row['thread_id']}> · {row['project']} · {provider}/{model} · {shown[1]} "
            f"<t:{_epoch(row['display_since'])}:R>")


def _chunks(lines: list[str]) -> list[list[str]]:
    """Lines packed into messages, leaving room for each one's header."""
    chunks, current, size = [], [], 0
    for line in lines:
        if current and size + len(line) + 1 > MESSAGE_LIMIT - 80:
            chunks.append(current)
            current, size = [], 0
        current.append(line)
        size += len(line) + 1
    if current or not chunks:
        chunks.append(current)
    return chunks


def render(context, current: dict) -> list[str]:
    """The board's messages, top first."""
    rows = {row["thread_id"]: row for row in context.db.execute("SELECT * FROM threads WHERE state != 'closed'")}
    grouped = {group: [] for group in ORDER}
    for thread_id, shown in context.labels.items():
        row = rows.get(thread_id)
        if row is not None and shown[0] in grouped:
            grouped[shown[0]].append((row["display_since"] or "", thread_id, row, shown))
    lines = {group: [_line(current, row, shown) for _since, _id, row, shown in sorted(entries, key=lambda e: e[:2])]
             for group, entries in grouped.items()}
    every = [line for group in ORDER for line in lines[group]]
    chunks = _chunks(every) if every else [["No open threads."]]
    if len(chunks) > MAX_SLOTS and lines["idle"]:
        collapsed = [line for group in ORDER[:-1] for line in lines[group]]
        collapsed.append(f"{ICONS['idle']} +{len(lines['idle'])} idle threads")
        chunks = _chunks(collapsed)
    if len(chunks) > MAX_SLOTS:
        kept = [line for chunk in chunks[:MAX_SLOTS] for line in chunk]
        kept = kept[:-1] + [f"… +{len(every) - len(kept) + 1} more threads"]
        chunks = _chunks(kept)[:MAX_SLOTS]
    stamps = [row["display_since"] for row in rows.values() if row["display_since"]]
    changed = f" · last change <t:{_epoch(max(stamps, key=_epoch))}:R>" if stamps else ""
    return [f"{HEADER} · {index}/{len(chunks)}{changed}\n" + "\n".join(chunk)
            for index, chunk in enumerate(chunks, 1)]


def _sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _numeric(message_id: str) -> tuple[int, str]:
    return (len(message_id), message_id)


def _adopt(context, channel: str) -> None:
    """With no stored board, take over root's earlier board messages in the channel, oldest first."""
    result = context.link.call("status_board_list", {}) or {}
    found = sorted((message["id"] for message in result.get("messages") or []
                    if isinstance(message, dict) and isinstance(message.get("id"), str)
                    and str(message.get("content") or "").startswith(HEADER)), key=_numeric)
    for slot, message_id in enumerate(found, 1):
        store.set_board_slot(context.db, slot, channel, message_id, "")


def _reset(context) -> None:
    store.drop_board_slots(context.db)
    context.board_adopted = False


def flush(context, force: bool = False) -> None:
    """Bring the status channel's board up to date, at most once per interval."""
    if not force and time.monotonic() - context.board_flush_at < interval_seconds():
        return
    context.board_flush_at = time.monotonic()
    try:
        current = registry.load(context.project_root)
    except (OSError, ValueError):
        return
    channel, _error = channel_setting(current)
    slots = store.board_slots(context.db)
    if channel is None or context.status_ops_missing:
        if slots and channel is None:
            _reset(context)
        return
    if any(slot["channel_id"] != channel for slot in slots):
        _reset(context)  # A new channel: the old board's messages stay where they were.
        slots = []
    try:
        if not slots and not context.board_adopted:
            context.board_adopted = True
            _adopt(context, channel)
            slots = store.board_slots(context.db)
        texts = render(context, current)
        for index, text in enumerate(texts, 1):
            sha = _sha(text)
            if index <= len(slots):
                if slots[index - 1]["content_sha256"] == sha:
                    continue
                try:
                    context.link.call("status_board_edit", {"message_id": slots[index - 1]["message_id"], "text": text})
                except LinkError as error:
                    if error.code not in ("not_found", "scope_violation"):
                        raise
                    # Someone deleted (or replaced) a board message: post the whole board again, in order.
                    for slot in slots:
                        _delete(context, slot["message_id"])
                    _reset(context)
                    context.board_adopted = True
                    context.board_flush_at = 0.0
                    return
                store.set_board_slot(context.db, index, channel, slots[index - 1]["message_id"], sha)
            else:
                result = context.link.call("status_board_post", {"text": text}) or {}
                store.set_board_slot(context.db, index, channel, str(result["message_id"]), sha)
        for slot in slots[len(texts):]:
            _delete(context, slot["message_id"])
        store.drop_board_slots(context.db, len(texts) + 1)
    except LinkError as error:
        if error.code == "unknown_op":
            context.status_ops_missing = True
            _log("the Router has no status board ops yet; the board is off until it reconnects")
        elif error.code in ("status_channel_unset", "status_channel_invalid"):
            _log(f"the status board is off: {error}")
        else:
            _log(f"the status board update failed: {error.code}")


def _delete(context, message_id: str) -> None:
    try:
        context.link.call("status_board_delete", {"message_id": message_id})
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
