"""The Thread Supervisor's private SQLite store, schema v1."""

from __future__ import annotations

import os
from pathlib import Path
import sqlite3
import stat

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
        pending_config TEXT, pending_close TEXT, queue_position INTEGER""",
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
                "pending_config", "pending_close", "queue_position"},
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


def connect(state_dir: Path, create: bool = False) -> sqlite3.Connection | None:
    """Open the store, creating it only when ``create`` is set."""
    path = store_path(state_dir)
    existed = path.exists()
    if not existed and not create:
        return None
    if existed:
        _check_private(path)
        if path.stat().st_size == 0:
            raise ValueError("thread store schema is unsupported")
    private_directory(state_dir)
    if not existed:
        os.close(os.open(path, os.O_WRONLY | os.O_CREAT, 0o600))
    db = sqlite3.connect(path, timeout=2, isolation_level=None)
    db.row_factory = sqlite3.Row
    try:
        db.execute("PRAGMA journal_mode=WAL")
        db.execute("PRAGMA synchronous=FULL")
        db.execute("PRAGMA secure_delete=ON")
        if db.execute("PRAGMA user_version").fetchone()[0] == 0 and not existed:
            db.execute("BEGIN IMMEDIATE")
            for table, definition in TABLES.items():
                db.execute(f"CREATE TABLE {table} ({definition})")
            db.execute(f"PRAGMA user_version={SCHEMA_VERSION}")
            db.execute("COMMIT")
        verify(db)
    except (sqlite3.Error, ValueError):
        db.close()
        raise
    for suffix in ("", "-wal", "-shm"):
        sidecar = Path(f"{path}{suffix}")
        if sidecar.exists():
            os.chmod(sidecar, 0o600)
    return db


def inspect(state_dir: Path) -> dict | None:
    """Read-only check of an existing store; never creates anything."""
    path = store_path(state_dir)
    if not path.exists():
        return None
    _check_private(path)
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


def pending_request(db: sqlite3.Connection, project: str, name: str) -> sqlite3.Row | None:
    """The oldest pending creation request for ``name`` in ``project``."""
    return db.execute("""SELECT * FROM creation_requests WHERE status='pending' AND project=? AND name=?
        ORDER BY created_at, request_id LIMIT 1""", (project, name)).fetchone()


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


def begin_boot(db: sqlite3.Connection, thread_id: str, resolved: dict) -> None:
    """Mark a thread `booting` with what its session runs with, and empty its
    boot buffer of any earlier attempt."""
    db.execute("BEGIN IMMEDIATE")
    try:
        update(db, thread_id, state="booting", stop_reason=None, close_reason=None,
               **{f"resolved_{field}": resolved.get(field) for field in OVERRIDES})
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
    """End a boot as `live`, or `stopped` with ``stop_reason``; the buffer goes either way."""
    db.execute("BEGIN IMMEDIATE")
    try:
        update(db, thread_id, state=state, stop_reason=stop_reason)
        db.execute("DELETE FROM boot_buffers WHERE thread_id=?", (thread_id,))
        db.execute("COMMIT")
    except sqlite3.Error:
        db.execute("ROLLBACK")
        raise
