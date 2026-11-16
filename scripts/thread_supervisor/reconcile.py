"""Reconcile: catching up with Discord after the supervisor's own downtime, a
Router reconnect, or a Gateway resume.

It runs on each Router connection (worker start and every reconnect) and on
`gateway_resumed`. Project changes come first, so a thread whose project's
channel moved meanwhile is `closed/project-moved` and never started. A
`booting` or `live` row whose process is gone is `stopped/crashed`, and a close
a crash interrupted after `pending_close` is finished. `thread_list` (active
threads, and threads archived in the
last 7 days) then binds unknown active threads under the normal binding
rules, and unarchives every archived thread whose conversation is not
closed: a thread stays open until `/close`. A thread is started only when
`thread_history` shows its newest owner message is newer than its newest
project-webhook message; its bootstrap holds the owner and guest messages
after that agent reply, which the session never received; a message that
mentions root, or natively replies to a root-bot message other than an owner
ping, is root's and never counts. `crashed`, `start-failed` and `operator`
stops never restart here.
"""

from __future__ import annotations

from datetime import datetime
import sys
import time

from . import binding, boot, lifecycle, projects, registry, store, turns
from .clock import now
from .link import LinkError


ARCHIVED_WITHIN_DAYS = 7
HISTORY_PAGE = 100
HISTORY_PAGES = 10
# Stops only a person or a failure undoes.
NEVER_RESTARTED = ("crashed", "start-failed", "operator")
# Default and reply messages; system notices are not conversation.
MESSAGE_TYPES = (0, 19)


def _log(message: str) -> None:
    print(f"thread-supervisor: {message}", file=sys.stderr, flush=True)


def reconcile(context, _event: dict | None = None) -> None:
    # Project changes first: a thread whose channel moved meanwhile is closed, never started.
    projects.on_registry(context)
    _finish_interrupted_closes(context)
    _mark_crashed(context)
    try:
        listed = context.link.call("thread_list", {"archived_within_days": ARCHIVED_WITHIN_DAYS}) or {}
    except LinkError as error:
        return _log(f"reconcile: the thread list failed: {error.code}")
    # A registered channel Discord no longer has (or root cannot read) is
    # skipped by the Router; the rest of the list still reconciles.
    for skipped in listed.get("skipped_channels") or []:
        if isinstance(skipped, dict):
            _log(f"reconcile: skipped project {skipped.get('project')}'s channel {skipped.get('channel_id')} "
                 f"(Discord {skipped.get('status')})")
    for thread in listed.get("threads") or []:
        if not isinstance(thread, dict) or not isinstance(thread.get("id"), str):
            continue
        try:
            _reconcile_thread(context, thread)
        except Exception as error:  # One thread must not stop the rest.
            _log(f"reconcile: thread {thread['id']} failed: {error}")


def _finish_interrupted_closes(context) -> None:
    """A close that recorded `pending_close` and then died: archive the thread
    (again: an archive that already happened is unchanged) and finish it."""
    for row in context.db.execute("SELECT * FROM threads WHERE pending_close IS NOT NULL AND state != 'closed'"):
        try:
            context.link.call("thread_update", {"thread_id": row["thread_id"], "archived": True})
        except LinkError as error:
            _log(f"reconcile: thread {row['thread_id']}: archiving its interrupted close failed: {error.code}")
        lifecycle.finish_close(context, row)
        _log(f"reconcile: thread {row['thread_id']}: finished its interrupted close")


def _mark_crashed(context) -> None:
    """A launch this worker did not start, or a live session whose listeners are gone, has crashed."""
    for row in context.db.execute("SELECT * FROM threads WHERE state IN ('booting', 'live')").fetchall():
        if row["thread_id"] in context.boots:
            continue
        if row["state"] == "live" and lifecycle.session_running(row["thread_id"]):
            continue
        lifecycle.stop_session(context, row)
        store.finish_boot(context.db, row["thread_id"], "stopped", "crashed")


def _reconcile_thread(context, thread: dict) -> None:
    thread_id, project = thread["id"], thread.get("project")
    row = store.thread(context.db, thread_id)
    if row and row["project"] != project:
        return
    if thread.get("archived"):
        if row and row["state"] != "closed" and not row["pending_close"]:
            lifecycle.reopen(context, row, _archived_at_ms(thread) - lifecycle.ARCHIVE_LOOKBACK_MS)
        return
    if row is None:
        binding.on_thread_create(context, {"project": project, "thread_id": thread_id, "name": thread.get("name"),
                                           "owner_id": thread.get("owner_id"),
                                           "parent_channel_id": thread.get("parent_id")})
        row = store.thread(context.db, thread_id)
        if row is None:
            return
    if row["state"] not in ("registered", "stopped", "closed") or row["stop_reason"] in NEVER_RESTARTED:
        return
    waiting = _unanswered(context, row, thread)
    owners = [message for message in waiting if message["author_class"] == "owner"]
    if not owners:
        return
    store.update(context.db, thread_id, last_owner_activity_at=now())
    boot.start(context, row, owners[-1], backlog=waiting)


def _archived_at_ms(thread: dict) -> int:
    try:
        return int(datetime.fromisoformat(str(thread.get("archive_timestamp")).replace("Z", "+00:00")).timestamp()
                   * 1000)
    except ValueError:
        return int(time.time() * 1000)


def _unanswered(context, row, thread: dict) -> list[dict]:
    """The owner and guest messages after the thread's newest project-webhook
    message, oldest first, shaped as the Router's `thread_message` events."""
    newer, before = [], None
    for _ in range(HISTORY_PAGES):
        try:
            page = (context.link.call("thread_history", {"thread_id": row["thread_id"], "limit": HISTORY_PAGE,
                                                         **({"before": before} if before else {})})
                    or {}).get("messages") or []
        except LinkError as error:
            _log(f"reconcile: thread {row['thread_id']}: the history read failed: {error.code}")
            return []
        for message in page:  # Newest first.
            if message.get("author_class") == "project_webhook":
                return _events(context, row, thread, reversed(newer))
            newer.append(message)
        if len(page) < HISTORY_PAGE:
            break
        before = page[-1].get("id")
    return _events(context, row, thread, reversed(newer))


def _replies_to_root(context, message: dict) -> bool:
    """A native reply to one of the root bot's messages is root's, as live routing has it."""
    referenced = message.get("referenced_message")
    if not context.bot_user_id or not message.get("message_reference") or not isinstance(referenced, dict):
        return False
    if str((referenced.get("author") or {}).get("id") or "") != context.bot_user_id:
        return False
    # A reply to an owner ping answers the thread, as the Router routes it.
    return not turns.is_ping(referenced, context.bot_user_id, _owner_id(context))


def _owner_id(context) -> str | None:
    try:
        return registry.owner_id(registry.load(context.project_root))
    except (OSError, ValueError):
        return None


def _events(context, row, thread: dict, messages) -> list[dict]:
    events = []
    for message in messages:
        content = str(message.get("content") or "")
        if (message.get("author_class") not in boot.DRIVERS or message.get("type", 0) not in MESSAGE_TYPES
                or not isinstance(message.get("id"), str) or boot.COMMAND.match(content.strip())
                or boot._addresses_root(context, content) or _replies_to_root(context, message)):
            continue
        author = message.get("author") or {}
        events.append({
            "event": "thread_message", "project": row["project"], "thread_id": row["thread_id"],
            "parent_channel_id": thread.get("parent_id"), "message_id": message["id"],
            "author": {"id": str(author.get("id") or ""),
                       "name": author.get("global_name") or author.get("username") or str(author.get("id") or "")},
            "author_class": message["author_class"], "content": content,
            "attachments": [{"id": attachment.get("id"), "name": attachment.get("filename"),
                             "content_type": attachment.get("content_type"), "size": attachment.get("size"),
                             "url": attachment.get("url")}
                            for attachment in message.get("attachments") or [] if isinstance(attachment, dict)],
            "ts": message.get("timestamp"),
        })
    return events
