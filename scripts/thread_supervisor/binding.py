"""Binding: which new threads become Thread Conversations."""

from __future__ import annotations

import sys

from . import registry, store
from .clock import now
from .link import LinkError


# Discord's longest auto-archive duration, one week in minutes.
AUTO_ARCHIVE_MINUTES = 10080


def on_thread_create(context, event: dict) -> None:
    """Bind a thread its parent's owner or a current guest created, or one the
    root bot created for a pending creation request. Any other creator binds
    nothing, and a thread already bound stays as it is."""
    project, thread_id = event.get("project"), event.get("thread_id")
    name, creator = event.get("name") or "", event.get("owner_id")
    if not isinstance(project, str) or not isinstance(thread_id, str) or not isinstance(creator, str):
        return
    if store.thread(context.db, thread_id):
        return
    current = registry.load(context.project_root)
    if not registry.project(current, project):
        return
    request = None
    if creator != registry.owner_id(current) and creator not in registry.guests(current, project):
        if not context.bot_user_id or creator != context.bot_user_id:
            return
        request = store.pending_request(context.db, project, name)
        if not request:
            return
    if not store.bind(context.db, thread_id, project, name, creator, now(), request):
        return
    # The Router creates the root bot's threads with the one-week duration
    # already; a hand-made thread starts with Discord's shorter default.
    if request is None:
        try:
            context.link.call("thread_update", {"thread_id": thread_id, "auto_archive_duration": AUTO_ARCHIVE_MINUTES})
        except LinkError as error:
            print(f"thread-supervisor: thread {thread_id} is bound, but its auto-archive update failed: {error.code}",
                  file=sys.stderr, flush=True)
