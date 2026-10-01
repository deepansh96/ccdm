"""Project changes: the worker watches the registry for deregistrations and channel moves.

A project that leaves the registry gets each of its threads' sessions stopped
and the row `closed/deregistered`; a project whose `channel_id` changed, or
whose `path` became `remote:` (another machine, with no thread sessions),
gets `closed/project-moved` (the Router has revoked their connections with
`project_moved`). Neither touches Discord: the channel may be gone. Channels
are compared with the registry this worker last read, so a move while the
worker was down goes unseen.
"""

from __future__ import annotations

import os
import sys

from . import lifecycle, registry, store


def _log(message: str) -> None:
    print(f"thread-supervisor: {message}", file=sys.stderr, flush=True)


class Watch:
    """The registry file's identity and each project's channel, as last read."""

    def __init__(self, project_root):
        self.path = registry.registry_path(project_root)
        self.signature = None
        self.channels: dict[str, object] = {}

    def changed(self) -> bool:
        try:
            info = os.stat(self.path)
        except OSError:
            return False
        signature = (info.st_ino, info.st_mtime_ns, info.st_size)
        if signature == self.signature:
            return False
        self.signature = signature
        return True


def on_registry(context, _frame: dict | None = None) -> None:
    try:
        current = registry.load(context.project_root)
    except (OSError, ValueError) as error:
        return _log(f"the registry could not be read: {error}")
    projects = current.get("projects") if isinstance(current.get("projects"), dict) else {}
    channels = {name: entry.get("channel_id") for name, entry in projects.items() if isinstance(entry, dict)}
    remote = {name for name, entry in projects.items()
              if isinstance(entry, dict) and str(entry.get("path") or "").startswith("remote:")}
    known = context.watch.channels
    for row in context.db.execute("SELECT * FROM threads WHERE state != 'closed'").fetchall():
        project = row["project"]
        if project not in channels:
            reason = "deregistered"
        elif project in remote or (project in known and known[project] != channels[project]):
            reason = "project-moved"
        else:
            continue
        context.archive_polls.pop(row["thread_id"], None)
        context.queued.pop(row["thread_id"], None)
        lifecycle.stop_session(context, row)
        store.finish_boot(context.db, row["thread_id"], "closed")
        store.update(context.db, row["thread_id"], close_reason=reason, pending_close=None)
    context.watch.channels = channels
