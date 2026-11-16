"""The `run` loop: one locked worker, its store, its Router key, its link and its control socket."""

from __future__ import annotations

from dataclasses import dataclass, field
import fcntl
import json
import os
from pathlib import Path
import signal
import sqlite3
import sys

from . import board, projects, store, turns
from .control import ControlServer
from .dispatch import dispatch
from .link import Link
from .paths import private_directory, write_private, write_supervisor_key


class AlreadyRunning(Exception):
    pass


class LinkStopped(Exception):
    pass


@dataclass
class Context:
    """What every handler gets: the store, the link, and the Router's view."""
    project_root: Path
    state_dir: Path
    db: sqlite3.Connection
    link: Link
    bot_user_id: str | None = None
    # The connected Router's hello_ok capabilities (owner pings, the status board).
    router_capabilities: frozenset = frozenset()
    # Launches in progress, by thread id (boot.Boot).
    boots: dict = field(default_factory=dict)
    # Turn status (turns.py): each live session's activity file as last read
    # ({thread_id: (mtime_ns, data)}), when an unsettled turn end was first
    # seen, pings the Router could not post yet, and each open thread's board
    # state and label from the last tick.
    activity: dict = field(default_factory=dict)
    end_first_seen: dict = field(default_factory=dict)
    pending_pings: dict = field(default_factory=dict)
    labels: dict = field(default_factory=dict)
    status_tick_at: float = 0.0
    # The status board (board.py): when it last flushed, whether its earlier
    # messages were looked for (and must be again, after a post that may have
    # landed), and whether the Router lacks the new ops.
    board_flush_at: float = 0.0
    board_adopted: bool = False
    board_readopt: bool = False
    # Messages of a board being posted again, still to delete, one per flush.
    board_orphans: list = field(default_factory=list)
    status_ops_missing: bool = False
    # The registry as last read, for deregistrations and channel moves (projects.Watch).
    watch: object = None


def lock_path(state_dir: Path) -> Path:
    return state_dir / "worker.lock"


def health_path(state_dir: Path) -> Path:
    return state_dir / "worker.json"


def write_health(state_dir: Path, link: Link, router: str) -> None:
    write_private(health_path(state_dir), json.dumps({"pid": os.getpid(), "link_pid": link.pid, "router": router}))


def _status(context: Context) -> None:
    """Turn status, then the status board, each on its own interval; a failure
    never stops the worker. It waits while frames are queued, so a session
    going live (and its bootstrap) never waits behind it."""
    if context.link.has_frames():
        return
    try:
        turns.tick(context)
        board.flush(context)
    except Exception as error:
        print(f"thread-supervisor: the turn status update failed: {error}", file=sys.stderr, flush=True)


def run(project_root: Path, state_dir: Path, disabled=None) -> None:
    """The worker loop; ``disabled``, when given, is polled and ends the loop once true."""
    private_directory(state_dir)
    path = lock_path(state_dir)
    with path.open("a+") as lock:
        os.chmod(path, 0o600)
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise AlreadyRunning("thread supervisor is already running") from error
        db = store.connect(state_dir, create=True)
        stopping = False

        def stop(_signal, _frame):
            nonlocal stopping
            stopping = True

        signal.signal(signal.SIGTERM, stop)
        signal.signal(signal.SIGINT, stop)
        # A fresh key each start, before the link says hello with it.
        link = Link(write_supervisor_key())
        context = Context(project_root, state_dir, db, link, watch=projects.Watch(project_root))
        control = None
        try:
            control = ControlServer(state_dir, link.post)
            write_health(state_dir, link, "connecting")
            connected = False
            while not stopping and not (disabled and disabled()):
                # Registry changes are handled while connected, so the queue they free can start.
                if connected and context.watch.changed():
                    dispatch(context, {"type": "internal", "event": "registry"})
                if connected:
                    _status(context)
                frame = link.next_frame(0.25)
                if frame is None:
                    continue
                kind = frame.get("type")
                if kind == "connected":
                    context.bot_user_id = frame.get("bot_user_id")
                    context.router_capabilities = frozenset(
                        item for item in frame.get("capabilities") or [] if isinstance(item, str))
                    connected = True
                    # A Router that reconnects may now have the turn-status ops.
                    context.status_ops_missing = False
                    write_health(state_dir, link, "connected")
                    # Whatever happened while this worker or the Router was away.
                    dispatch(context, {"type": "internal", "event": "reconcile"})
                elif kind == "disconnected":
                    connected = False
                    write_health(state_dir, link, "disconnected")
                elif kind in ("event", "internal"):
                    dispatch(context, frame)
                elif kind == "link_exit" and not stopping:
                    raise LinkStopped("the Router link stopped")
        finally:
            if control:
                control.close()
            link.close()
            health_path(state_dir).unlink(missing_ok=True)
            db.close()
    print("thread-supervisor: stopped", file=sys.stderr, flush=True)
