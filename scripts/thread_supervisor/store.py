"""The Thread Supervisor's private SQLite store, schema v1."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
import os
from pathlib import Path
import sqlite3
import stat
import time
import uuid

from .paths import private_directory


SCHEMA_VERSION = 1
THREAD_STATES = ("registered", "booting", "live", "queued", "stopped", "closed")
STOP_REASONS = ("auto-archive", "archive-actor-unknown", "evicted", "operator", "crashed", "start-failed")
CLOSE_REASONS = ("owner-archive", "root-archive", "close-command", "deregistered", "project-moved")
REQUESTER_KINDS = ("owner", "guest", "root", "channel-agent")
REQUEST_STATUSES = ("pending", "fulfilled", "failed")
OVERRIDES = ("provider", "account", "model", "effort")


def _one_of(column: str, values: tuple[str, ...], nullable: bool = False) -> str:
    allowed = ",".join(f"'{value}'" for value in values)
    return f"CHECK({column} IS NULL OR {column} IN ({allowed}))" if nullable else f"CHECK({column} IN ({allowed}))"


# One row per bound thread. Override columns are null when the thread inherits
# the project's setting; `resolved_*` hold what its session runs with.
# A queued row's `queued_start` holds the trigger and starter it starts with (JSON).
TABLES = {
    "threads": f"""thread_id TEXT PRIMARY KEY, project TEXT NOT NULL, name TEXT NOT NULL,
        creator_id TEXT NOT NULL, starter_message_id TEXT, created_at TEXT NOT NULL,
        provider TEXT, account TEXT, model TEXT, effort TEXT,
        resolved_provider TEXT, resolved_account TEXT, resolved_model TEXT, resolved_effort TEXT,
        provider_conversation_id TEXT, provider_home TEXT,
        state TEXT NOT NULL {_one_of("state", THREAD_STATES)},
        stop_reason TEXT {_one_of("stop_reason", STOP_REASONS, nullable=True)},
        close_reason TEXT {_one_of("close_reason", CLOSE_REASONS, nullable=True)},
        runtime_tmux TEXT, runtime_pid INTEGER, ws_port INTEGER,
        last_owner_activity_at TEXT, last_agent_reply_at TEXT,
        pending_config TEXT, pending_close TEXT, queue_position INTEGER, queued_start TEXT""",
    "creation_requests": f"""request_id TEXT PRIMARY KEY, project TEXT NOT NULL, name TEXT NOT NULL,
        provider TEXT, account TEXT, model TEXT, effort TEXT, first_message TEXT,
        requester_id TEXT NOT NULL,
        requester_kind TEXT NOT NULL {_one_of("requester_kind", REQUESTER_KINDS)},
        status TEXT NOT NULL {_one_of("status", REQUEST_STATUSES)},
        thread_id TEXT, created_at TEXT NOT NULL""",
    "boot_buffers": """thread_id TEXT NOT NULL, message_id TEXT NOT NULL, payload TEXT NOT NULL,
        received_at TEXT NOT NULL, PRIMARY KEY(thread_id, message_id)""",
}
COLUMNS = {
    "threads": {"thread_id", "project", "name", "creator_id", "starter_message_id", "created_at",
                "provider", "account", "model", "effort",
                "resolved_provider", "resolved_account", "resolved_model", "resolved_effort",
                "provider_conversation_id", "provider_home", "state", "stop_reason", "close_reason",
                "runtime_tmux", "runtime_pid", "ws_port", "last_owner_activity_at", "last_agent_reply_at",
                "pending_config", "pending_close", "queue_position", "queued_start"},
    "creation_requests": {"request_id", "project", "name", "provider", "account", "model", "effort",
                          "first_message", "requester_id", "requester_kind", "status", "thread_id", "created_at"},
    "boot_buffers": {"thread_id", "message_id", "payload", "received_at"},
}


def store_path(state_dir: Path) -> Path:
    return state_dir / "threads.sqlite3"


def verify(db: sqlite3.Connection) -> None:
    """Refuse a store whose version, tables or exact column sets are not schema v1."""
    if db.execute("PRAGMA user_version").fetchone()[0] != SCHEMA_VERSION:
        raise ValueError("thread store schema is unsupported")
    tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    if tables != set(COLUMNS):
        raise ValueError("thread store schema is unsupported")
    for table, columns in COLUMNS.items():
        if {row[1] for row in db.execute(f"PRAGMA table_info({table})")} != columns:
            raise ValueError("thread store schema is unsupported")
    if db.execute("PRAGMA quick_check").fetchone()[0] != "ok":
        raise ValueError("thread store is corrupt")


def _check_private(path: Path) -> None:
    if stat.S_IMODE(path.stat().st_mode) & 0o077:
        raise ValueError("thread store permissions are not private")


def _publish(state_dir: Path, path: Path) -> None:
    """Build a complete schema-v1 store in a private temporary file beside
    ``path`` and link it into place, so no reader ever sees a half-made store.
    A store some other process published first wins."""
    temporary = state_dir / f".threads.{os.getpid()}.{uuid.uuid4().hex}.sqlite3"
    os.close(os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600))
    try:
        db = sqlite3.connect(temporary, isolation_level=None)
        try:
            # Rollback journaling until the first `connect` turns on WAL: a
            # read-only reader cannot open a WAL store that has no -shm yet.
            db.execute("BEGIN IMMEDIATE")
            for table, definition in TABLES.items():
                db.execute(f"CREATE TABLE {table} ({definition})")
            db.execute(f"PRAGMA user_version={SCHEMA_VERSION}")
            db.execute("COMMIT")
        finally:
            db.close()
        try:
            os.link(temporary, path)
        except FileExistsError:
            pass
    finally:
        for suffix in ("", "-wal", "-shm", "-journal"):
            Path(f"{temporary}{suffix}").unlink(missing_ok=True)


def connect(state_dir: Path, create: bool = False) -> sqlite3.Connection | None:
    """Open the store, creating it only when ``create`` is set."""
    path = store_path(state_dir)
    if not path.exists():
        if not create:
            return None
        private_directory(state_dir)
        _publish(state_dir, path)
    _check_private(path)
    if path.stat().st_size == 0:
        raise ValueError("thread store schema is unsupported")
    db = sqlite3.connect(path, timeout=2, isolation_level=None)
    db.row_factory = sqlite3.Row
    try:
        db.execute("PRAGMA journal_mode=WAL")
        db.execute("PRAGMA synchronous=FULL")
        db.execute("PRAGMA secure_delete=ON")
        verify(db)
    except (sqlite3.Error, ValueError):
        db.close()
        raise
    for suffix in ("", "-wal", "-shm"):
        sidecar = Path(f"{path}{suffix}")
        if sidecar.exists():
            os.chmod(sidecar, 0o600)
    return db


# A read-only reader cannot open a WAL store while it has no -shm, as for a
# moment when its last writer closes; such an open is retried this long.
INSPECT_RETRY_SECONDS = 2


def inspect(state_dir: Path) -> dict | None:
    """Read-only check of an existing store; never creates anything."""
    path = store_path(state_dir)
    if not path.exists():
        return None
    _check_private(path)
    deadline = time.monotonic() + INSPECT_RETRY_SECONDS
    while True:
        try:
            return _inspect(path)
        except sqlite3.OperationalError:
            if time.monotonic() >= deadline:
                raise
            time.sleep(0.02)


def _inspect(path: Path) -> dict:
    db = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    db.row_factory = sqlite3.Row
    try:
        verify(db)
        return {"user_version": db.execute("PRAGMA user_version").fetchone()[0],
                "threads": [dict(row) for row in db.execute("SELECT * FROM threads ORDER BY project, created_at, thread_id")]}
    finally:
        db.close()


def thread(db: sqlite3.Connection, thread_id: str) -> sqlite3.Row | None:
    return db.execute("SELECT * FROM threads WHERE thread_id=?", (thread_id,)).fetchone()


# How long a pending request that has not yet recorded its thread id may still
# claim a bot-created thread by name: well past thread_create's deadline.
REQUEST_MATCH_SECONDS = 300


def pending_request(db: sqlite3.Connection, project: str, name: str, thread_id: str) -> sqlite3.Row | None:
    """The pending creation request ``thread_id`` fulfils: the one that
    recorded it, else (its THREAD_CREATE can beat thread_create's answer) the
    oldest recent one for ``name`` in ``project`` that recorded no thread yet.
    A request for another thread, or a stale one, matches nothing."""
    recorded = db.execute("""SELECT * FROM creation_requests WHERE status='pending' AND project=? AND thread_id=?
        ORDER BY created_at, request_id LIMIT 1""", (project, thread_id)).fetchone()
    if recorded:
        return recorded
    cutoff = (datetime.now(timezone.utc) - timedelta(seconds=REQUEST_MATCH_SECONDS)).isoformat(
        timespec="milliseconds").replace("+00:00", "Z")
    return db.execute("""SELECT * FROM creation_requests WHERE status='pending' AND project=? AND name=?
        AND thread_id IS NULL AND created_at >= ? ORDER BY created_at, request_id LIMIT 1""",
                      (project, name, cutoff)).fetchone()


def add_request(db: sqlite3.Connection, request_id: str, project: str, name: str, overrides: dict,
                first_message: str | None, requester_id: str, requester_kind: str, created_at: str) -> None:
    """Insert a pending creation request; null overrides inherit the project's settings."""
    db.execute("""INSERT INTO creation_requests (request_id, project, name, provider, account, model, effort,
        first_message, requester_id, requester_kind, status, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,'pending',?)""",
               (request_id, project, name, *(overrides.get(field) for field in OVERRIDES), first_message,
                requester_id, requester_kind, created_at))


def update_request(db: sqlite3.Connection, request_id: str, **fields) -> None:
    columns = ", ".join(f"{column}=?" for column in fields)
    db.execute(f"UPDATE creation_requests SET {columns} WHERE request_id=?", (*fields.values(), request_id))


def bind(db: sqlite3.Connection, thread_id: str, project: str, name: str, creator_id: str, created_at: str,
         request: sqlite3.Row | None = None) -> bool:
    """Insert a registered thread; False when the thread is already bound. A
    thread fulfilling a creation ``request`` takes its overrides, and the
    request is marked fulfilled in the same transaction."""
    overrides = {field: request[field] for field in OVERRIDES} if request else {}
    db.execute("BEGIN IMMEDIATE")
    try:
        if thread(db, thread_id):
            db.execute("COMMIT")
            return False
        db.execute("""INSERT INTO threads (thread_id, project, name, creator_id, created_at,
            provider, account, model, effort, state) VALUES (?,?,?,?,?,?,?,?,?,'registered')""",
                   (thread_id, project, name, creator_id, created_at,
                    *(overrides.get(field) for field in OVERRIDES)))
        if request:
            db.execute("UPDATE creation_requests SET status='fulfilled', thread_id=? WHERE request_id=?",
                       (thread_id, request["request_id"]))
        db.execute("COMMIT")
        return True
    except sqlite3.Error:
        db.execute("ROLLBACK")
        raise


def update(db: sqlite3.Connection, thread_id: str, **fields) -> None:
    columns = ", ".join(f"{column}=?" for column in fields)
    db.execute(f"UPDATE threads SET {columns} WHERE thread_id=?", (*fields.values(), thread_id))


def held_ports(db: sqlite3.Connection, except_thread_id: str) -> set[int]:
    """The ws_ports other threads' rows hold."""
    return {row[0] for row in db.execute("SELECT ws_port FROM threads WHERE ws_port IS NOT NULL AND thread_id != ?",
                                         (except_thread_id,))}


def enqueue(db: sqlite3.Connection, thread_id: str, resolved: dict, queued_start: str | None = None) -> None:
    """Queue a thread behind every queued one, with what its session will run
    with and ``queued_start`` (its trigger and starter, as JSON), and empty its
    boot buffer of any earlier attempt."""
    db.execute("BEGIN IMMEDIATE")
    try:
        position = db.execute("SELECT COALESCE(MAX(queue_position), 0) + 1 FROM threads").fetchone()[0]
        update(db, thread_id, state="queued", stop_reason=None, close_reason=None, queue_position=position,
               queued_start=queued_start,
               **{f"resolved_{field}": resolved.get(field) for field in OVERRIDES})
        db.execute("DELETE FROM boot_buffers WHERE thread_id=?", (thread_id,))
        db.execute("COMMIT")
    except sqlite3.Error:
        db.execute("ROLLBACK")
        raise


def begin_boot(db: sqlite3.Connection, thread_id: str, resolved: dict) -> None:
    """Mark a thread `booting` with what its session runs with. A thread that
    was queued keeps the messages buffered meanwhile; any other empties its
    boot buffer of an earlier attempt."""
    db.execute("BEGIN IMMEDIATE")
    try:
        queued = (thread(db, thread_id) or {"state": None})["state"] == "queued"
        update(db, thread_id, state="booting", stop_reason=None, close_reason=None, queue_position=None,
               queued_start=None,
               **{f"resolved_{field}": resolved.get(field) for field in OVERRIDES})
        if not queued:
            db.execute("DELETE FROM boot_buffers WHERE thread_id=?", (thread_id,))
        db.execute("COMMIT")
    except sqlite3.Error:
        db.execute("ROLLBACK")
        raise


def buffer_message(db: sqlite3.Connection, thread_id: str, message_id: str, payload: str, received_at: str) -> None:
    """Keep a message sent while the thread boots; a repeat of one is ignored."""
    db.execute("INSERT OR IGNORE INTO boot_buffers (thread_id, message_id, payload, received_at) VALUES (?,?,?,?)",
               (thread_id, message_id, payload, received_at))


def buffered(db: sqlite3.Connection, thread_id: str) -> list[sqlite3.Row]:
    """A booting thread's buffered messages, in the order the Router sent them."""
    return db.execute("SELECT * FROM boot_buffers WHERE thread_id=? ORDER BY rowid", (thread_id,)).fetchall()


def finish_boot(db: sqlite3.Connection, thread_id: str, state: str, stop_reason: str | None = None) -> None:
    """End a boot (or a wait in the queue) as `live`, or `stopped` with
    ``stop_reason``; the buffer goes either way."""
    db.execute("BEGIN IMMEDIATE")
    try:
        update(db, thread_id, state=state, stop_reason=stop_reason, queue_position=None, queued_start=None)
        db.execute("DELETE FROM boot_buffers WHERE thread_id=?", (thread_id,))
        db.execute("COMMIT")
    except sqlite3.Error:
        db.execute("ROLLBACK")
        raise


def forget(db: sqlite3.Connection, thread_id: str) -> None:
    """Drop a deleted thread's row and its boot buffer."""
    db.execute("BEGIN IMMEDIATE")
    try:
        db.execute("DELETE FROM boot_buffers WHERE thread_id=?", (thread_id,))
        db.execute("DELETE FROM threads WHERE thread_id=?", (thread_id,))
        db.execute("COMMIT")
    except sqlite3.Error:
        db.execute("ROLLBACK")
        raise
