"""`stop-session.sh <project> --threads`: stop a project's thread sessions as operator stops.

A running supervisor does it through its control socket. When none answers,
each of the project's threads (its rows in the store, and its launch dirs
under `launches/<project>/threads/`) has the listeners carrying its
`.thread-<id>.key` path stopped, its session (tmux, or the session host on
Windows) and key removed, and, when no worker holds the store, its row set
`stopped/operator`.
"""

from __future__ import annotations

import sqlite3
import sys

from ccdmlib.platform import filelock
from ccdmlib.platform.commands import message_prefix

from . import control, lifecycle, registry, store
from .paths import default_state_dir, router_state_dir
from .worker import lock_path

# What each error line starts with: the command the operator ran.
PREFIX = message_prefix("stop-session")


def _say(message: str) -> None:
    print(message, flush=True)


def _rows(state_dir, project: str) -> list[dict]:
    try:
        inspected = store.inspect(state_dir) or {}
    except (OSError, ValueError, sqlite3.Error) as error:
        print(f"{PREFIX}: the thread store could not be read: {error}", file=sys.stderr)
        return []
    return [row for row in inspected.get("threads", []) if row["project"] == project]


def _launched(project: str) -> list[str]:
    directory = router_state_dir() / "launches" / project / "threads"
    try:
        return sorted(path.name for path in directory.iterdir() if path.is_dir() and path.name.isdigit())
    except OSError:
        return []


def _screen_name(project_root, project: str) -> str | None:
    try:
        entry = registry.project(registry.load(project_root), project) or {}
    except (OSError, ValueError):
        return None
    screen = entry.get("screen_name")
    return screen if isinstance(screen, str) and screen else None


def _mark_stopped(state_dir, project: str) -> None:
    """Record the stops, unless a worker holds the store meanwhile."""
    path = lock_path(state_dir)
    if not path.exists():
        return
    with path.open("r") as lock:
        if not filelock.try_lock(lock):
            return
        db = store.connect(state_dir)
        if db is None:
            return
        try:
            for row in db.execute("SELECT thread_id FROM threads WHERE project=? AND state IN ('booting', 'live', "
                                  "'queued')", (project,)).fetchall():
                store.finish_boot(db, row["thread_id"], "stopped", "operator")
                store.update(db, row["thread_id"], runtime_pid=None, runtime_tmux=None)
        finally:
            db.close()


def sweep(project_root, state_dir, project: str) -> list[str]:
    rows = {row["thread_id"]: row for row in _rows(state_dir, project)}
    screen = _screen_name(project_root, project)
    stopped = []
    for thread_id in dict.fromkeys([*rows, *_launched(project)]):
        row = rows.get(thread_id) or {}
        running = lifecycle.session_running(thread_id)
        # The stored session name, and the one every launch gives the thread's session.
        names = [row.get("runtime_tmux"), f"{screen}-t-{thread_id}" if screen else None]
        lifecycle.end_session(thread_id, names, row.get("resolved_provider") or row.get("provider"))
        if running:
            stopped.append(thread_id)
    try:
        _mark_stopped(state_dir, project)
    except (OSError, ValueError, sqlite3.Error) as error:
        print(f"{PREFIX}: the thread store could not be updated: {error}", file=sys.stderr)
    return stopped


def main(project_root, project: str) -> int:
    state_dir = default_state_dir()
    try:
        response = control.request(state_dir, {"op": "stop_threads", "project": project})
    except (OSError, ValueError):
        stopped = sweep(project_root, state_dir, project)
        _say(f"Thread supervisor not reachable; swept {len(stopped)} thread session(s) for '{project}' by key path")
        return 0
    if not response.get("ok"):
        error = response.get("error") or {}
        print(f"{PREFIX}: {error.get('message') or error.get('code')}", file=sys.stderr)
        return 1
    stopped = (response.get("result") or {}).get("stopped") or []
    _say(f"Stopped {len(stopped)} thread session(s) for '{project}'")
    return 0
