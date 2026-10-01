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

from . import projects, store
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
    # Launches in progress, by thread id (boot.Boot).
    boots: dict = field(default_factory=dict)
    # Archive actor lookups in progress, by thread id (lifecycle.ArchivePoll).
    archive_polls: dict = field(default_factory=dict)
    # The registry as last read, for deregistrations and channel moves (projects.Watch).
    watch: object = None


def lock_path(state_dir: Path) -> Path:
    return state_dir / "worker.lock"


def health_path(state_dir: Path) -> Path:
    return state_dir / "worker.json"


def write_health(state_dir: Path, link: Link, router: str) -> None:
    write_private(health_path(state_dir), json.dumps({"pid": os.getpid(), "link_pid": link.pid, "router": router}))


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
                frame = link.next_frame(0.25)
                if frame is None:
                    continue
                kind = frame.get("type")
                if kind == "connected":
                    context.bot_user_id = frame.get("bot_user_id")
                    connected = True
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
