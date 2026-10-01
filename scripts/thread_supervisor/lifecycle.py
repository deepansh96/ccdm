"""Archive, unarchive and delete: the Thread Conversation lifecycle.

An archive (`thread_update` with archived false→true) stops the thread's
session at once and leaves the row `stopped/auto-archive`, which is where an
unknown actor fails open. The archive's actor is then looked up in audit-log
action 111 through `thread_archive_actor`, polled for up to 60 s: the owner
or the root bot closes the conversation (`owner-archive`, `root-archive`);
any other actor, or no matching entry after successful fetches, keeps
`stopped/auto-archive`; and when every fetch was forbidden or failed the row
is `stopped/archive-actor-unknown`. A message that resumes the thread while
the lookup runs ends it. An unarchive never starts a session. A delete stops
the session and drops the row and its boot buffers; the provider's
conversation files stay on disk.
"""

from __future__ import annotations

from dataclasses import dataclass
import itertools
import os
from pathlib import Path
import re
import shlex
import signal
import subprocess
import sys
import threading
import time

from . import registry, reminders, store
from .link import LinkError
from .paths import router_state_dir


ARCHIVE_POLL_WINDOW_SECONDS = 60
ARCHIVE_POLL_INTERVAL_SECONDS = 5
# An audit entry is stamped when Discord archived the thread, a little before
# the event reaches the supervisor.
ARCHIVE_LOOKBACK_MS = 30000
STOP_GRACE_SECONDS = 3
_poll_ids = itertools.count(1)
KEY_ENV = re.compile(r"""CCDM_ROUTER_KEY_FILE=(?:"([^"]+)"|'([^']+)'|([^\s]+))""")


@dataclass
class ArchivePoll:
    id: int
    since_ms: int
    deadline: float
    succeeded: bool = False


def _log(message: str) -> None:
    print(f"thread-supervisor: {message}", file=sys.stderr, flush=True)


def _seconds(name: str, default: float) -> float:
    try:
        value = float(os.environ.get(name) or default)
    except ValueError:
        return default
    return value if value > 0 else default


def key_path(thread_id: str) -> Path:
    return router_state_dir() / "keys" / f".thread-{thread_id}.key"


def _is_listener(command: str) -> bool:
    try:
        argv = shlex.split(command)
    except ValueError:
        return False
    if not argv:
        return False
    exe = os.path.basename(argv[0])
    if exe == "claude":
        return "--dangerously-load-development-channels" in argv and "server:ccdm" in argv
    if exe == "codex":
        return "app-server" in argv
    return exe == "node" and any(os.path.basename(arg) in ("ccdm-channel-server.js", "codex-bridge.js")
                                 for arg in argv[1:])


def _listener_pids(key_file: Path) -> list[int]:
    """The thread's listener processes: those whose environment carries exactly its key path."""
    target = os.path.normpath(str(key_file))
    try:
        ps = subprocess.check_output(["ps", "axeww", "-o", "pid=,command="], text=True, stderr=subprocess.DEVNULL)
    except (OSError, subprocess.CalledProcessError):
        return []
    pids = []
    for line in ps.splitlines():
        pid_text, _, command = line.strip().partition(" ")
        if not pid_text.isdigit() or int(pid_text) == os.getpid():
            continue
        keys = [next(group for group in match.groups() if group is not None) for match in KEY_ENV.finditer(command)]
        if any(os.path.normpath(key) == target for key in keys) and _is_listener(command):
            pids.append(int(pid_text))
    return pids


def session_running(thread_id: str) -> bool:
    return bool(_listener_pids(key_path(thread_id)))


def stop_session(context, row) -> None:
    """Stop a thread's session by its `.thread-<id>.key` path, never by name
    patterns a project or sibling session could match; then its own tmux
    session and key go."""
    thread_id = row["thread_id"]
    context.boots.pop(thread_id, None)
    kill_listeners(key_path(thread_id))
    if row["runtime_tmux"]:
        subprocess.run(["tmux", "kill-session", "-t", f"={row['runtime_tmux']}"], capture_output=True)
    key_path(thread_id).unlink(missing_ok=True)
    store.update(context.db, thread_id, runtime_pid=None, runtime_tmux=None)


def kill_listeners(key_file: Path) -> None:
    """SIGTERM the listeners carrying ``key_file``, then SIGKILL any still running after the grace period."""
    pids = _listener_pids(key_file)
    for pid in pids:
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
    deadline = time.monotonic() + STOP_GRACE_SECONDS
    while pids and time.monotonic() < deadline:
        time.sleep(0.1)
        pids = [pid for pid in pids if pid in _listener_pids(key_file)]
    for pid in pids:
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass


def on_thread_update(context, event: dict) -> None:
    thread_id = event.get("thread_id")
    before, after = event.get("before") or {}, event.get("after") or {}
    if not isinstance(thread_id, str) or before.get("archived") or not after.get("archived"):
        return  # Only an archive matters; an unarchive never starts a session.
    row = store.thread(context.db, thread_id)
    if not row or row["project"] != event.get("project") or row["state"] == "closed":
        return
    stop_archived(context, row, int(time.time() * 1000) - ARCHIVE_LOOKBACK_MS)


def stop_archived(context, row, since_ms: int) -> None:
    """Stop an archived thread's session and look up who archived it, in
    audit entries since ``since_ms``."""
    thread_id = row["thread_id"]
    stop_session(context, row)
    if row["pending_close"]:  # The archive a `/close` made: the root bot's, so closed.
        store.update(context.db, thread_id, state="closed", stop_reason=None, close_reason="close-command",
                     pending_close=None)
        return reminders.emit(context, "conversation_closed", row)
    store.finish_boot(context.db, thread_id, "stopped", "auto-archive")
    poll = ArchivePoll(next(_poll_ids), since_ms,
                       time.monotonic() + _seconds("CCDM_THREAD_ARCHIVE_POLL_WINDOW_S", ARCHIVE_POLL_WINDOW_SECONDS))
    context.archive_polls[thread_id] = poll
    _poll(context, thread_id, poll)


def on_archive_poll(context, frame: dict) -> None:
    thread_id = frame.get("thread_id")
    poll = context.archive_polls.get(thread_id) if isinstance(thread_id, str) else None
    if poll and poll.id == frame.get("poll_id"):
        _poll(context, thread_id, poll)


def _archive_actor(entries: list) -> str | None:
    """The actor of the newest entry that archived the thread (entries come
    newest first). Only a change of ``archived`` to true counts: a rename or
    an ``auto_archive_duration`` PATCH is a thread update too."""
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        changes = entry.get("changes") or []
        if any(isinstance(change, dict) and change.get("key") == "archived" and change.get("new_value") is True
               for change in changes):
            return str(entry.get("user_id") or "") or None
    return None


def _poll(context, thread_id: str, poll: ArchivePoll) -> None:
    row = store.thread(context.db, thread_id)
    if not row or row["state"] != "stopped" or row["stop_reason"] != "auto-archive":
        context.archive_polls.pop(thread_id, None)  # Resumed or gone meanwhile.
        return
    try:
        result = context.link.call("thread_archive_actor", {"thread_id": thread_id, "since": poll.since_ms}) or {}
    except LinkError as error:
        _log(f"thread {thread_id}: the archive actor lookup failed: {error.code}")
        result = None
    if isinstance(result, dict) and not result.get("forbidden"):
        poll.succeeded = True
        actor = _archive_actor(result.get("entries") or [])
        if actor:
            return _classify(context, row, poll, actor)
    if time.monotonic() >= poll.deadline:
        return _classify(context, row, poll, None)
    interval = _seconds("CCDM_THREAD_ARCHIVE_POLL_INTERVAL_S", ARCHIVE_POLL_INTERVAL_SECONDS)
    timer = threading.Timer(interval, context.link.post,
                            args=({"type": "internal", "event": "archive_poll", "thread_id": thread_id,
                                   "poll_id": poll.id},))
    timer.daemon = True
    timer.start()


def _classify(context, row, poll: ArchivePoll, actor: str | None) -> None:
    thread_id = row["thread_id"]
    context.archive_polls.pop(thread_id, None)
    owner = registry.owner_id(registry.load(context.project_root))
    if actor and actor == owner:
        store.update(context.db, thread_id, state="closed", stop_reason=None, close_reason="owner-archive")
        reminders.emit(context, "conversation_closed", row)
    elif actor and context.bot_user_id and actor == context.bot_user_id:
        store.update(context.db, thread_id, state="closed", stop_reason=None, close_reason="root-archive")
    elif not actor and not poll.succeeded:
        store.update(context.db, thread_id, stop_reason="archive-actor-unknown")


def on_thread_delete(context, event: dict) -> None:
    thread_id = event.get("thread_id")
    if not isinstance(thread_id, str):
        return
    row = store.thread(context.db, thread_id)
    if not row or row["project"] != event.get("project"):
        return
    context.archive_polls.pop(thread_id, None)
    stop_session(context, row)
    store.forget(context.db, thread_id)
    reminders.emit(context, "conversation_deleted", row)
