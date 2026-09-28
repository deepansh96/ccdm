"""Private SQLite store for Thread Conversations bound by the Thread Supervisor."""

from __future__ import annotations

import os
from pathlib import Path
import sqlite3
import stat


SCHEMA_VERSION = 1
THREAD_STATES = ("registered", "booting", "live", "queued", "stopped", "closed")
STOP_REASONS = ("auto-archive", "evicted", "operator", "crashed", "start-failed", "bot-changed", "guest-changed")
# One row per bound thread. Override columns are null when the thread inherits
# the project's setting; resolved columns hold what the running session uses.
TABLES = {
    "threads": f"""thread_id TEXT PRIMARY KEY, project TEXT NOT NULL, name TEXT NOT NULL,
        creator_id TEXT NOT NULL, starter_message_id TEXT,
        provider TEXT, account TEXT, model TEXT, effort TEXT,
        resolved_provider TEXT, resolved_account TEXT, resolved_model TEXT, resolved_effort TEXT,
        provider_conversation_id TEXT, provider_home TEXT,
        state TEXT NOT NULL CHECK(state IN ({",".join(f"'{value}'" for value in THREAD_STATES)})),
        stop_reason TEXT CHECK(stop_reason IS NULL OR stop_reason IN ({",".join(f"'{value}'" for value in STOP_REASONS)})),
        turn_running INTEGER NOT NULL DEFAULT 0,
        runtime_tmux TEXT, runtime_pid INTEGER, runtime_host TEXT, runtime_home TEXT,
        created_at TEXT NOT NULL, last_owner_activity_at TEXT, last_turn_end_at TEXT,
        pending_config TEXT, pending_close TEXT""",
    "creation_requests": """request_id TEXT PRIMARY KEY, project TEXT NOT NULL, name TEXT NOT NULL,
        provider TEXT, account TEXT, model TEXT, effort TEXT, first_message TEXT,
        requester_id TEXT NOT NULL,
        requester_kind TEXT NOT NULL CHECK(requester_kind IN ('owner','guest','root','channel-agent')),
        status TEXT NOT NULL, thread_id TEXT, created_at TEXT NOT NULL""",
}
COLUMNS = {
    "threads": {"thread_id", "project", "name", "creator_id", "starter_message_id",
                "provider", "account", "model", "effort",
                "resolved_provider", "resolved_account", "resolved_model", "resolved_effort",
                "provider_conversation_id", "provider_home", "state", "stop_reason", "turn_running",
                "runtime_tmux", "runtime_pid", "runtime_host", "runtime_home",
                "created_at", "last_owner_activity_at", "last_turn_end_at", "pending_config", "pending_close"},
    "creation_requests": {"request_id", "project", "name", "provider", "account", "model", "effort",
                          "first_message", "requester_id", "requester_kind", "status", "thread_id", "created_at"},
}


def default_state_dir() -> Path:
    override = os.environ.get("CCDM_THREAD_STATE_DIR")
    if override:
        return Path(override).expanduser()
    return Path.home() / ".local" / "state" / "ccdm" / "thread-supervisor"


def private_directory(path: Path) -> None:
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(path, 0o700)


def store_path(state_dir: Path) -> Path:
    return state_dir / "threads.sqlite3"


def verify(db: sqlite3.Connection) -> None:
    """Refuse a store whose version or exact column sets are not this schema."""
    if db.execute("PRAGMA user_version").fetchone()[0] != SCHEMA_VERSION:
        raise ValueError("thread store schema is unsupported")
    tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    if any(table not in tables or {row[1] for row in db.execute(f"PRAGMA table_info({table})")} != columns
           for table, columns in COLUMNS.items()):
        raise ValueError("thread store schema is unsupported")
    if db.execute("PRAGMA quick_check").fetchone()[0] != "ok":
        raise ValueError("thread store is corrupt")


def check_private(path: Path) -> None:
    if stat.S_IMODE(path.stat().st_mode) & 0o077:
        raise ValueError("thread store permissions are not private")


def connect(state_dir: Path, create: bool = False) -> sqlite3.Connection | None:
    """Open the store, creating or migrating it only when ``create`` is set."""
    path = store_path(state_dir)
    existed = path.exists()
    if not existed and not create:
        return None
    if existed:
        check_private(path)
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
        version = db.execute("PRAGMA user_version").fetchone()[0]
        if version not in (0, SCHEMA_VERSION) or (version == 0 and existed):
            raise ValueError("thread store schema is unsupported")
        if version == 0:
            # Re-read the version under the write lock: a concurrent open may have created it.
            db.execute("BEGIN IMMEDIATE")
            if db.execute("PRAGMA user_version").fetchone()[0] == 0:
                for table, definition in TABLES.items():
                    db.execute(f"CREATE TABLE {table} ({definition})")
                db.execute(f"PRAGMA user_version={SCHEMA_VERSION}")
            db.execute("COMMIT")
        verify(db)
    except (sqlite3.Error, ValueError):
        db.close()
        raise
    os.chmod(path, 0o600)
    return db


def inspect(state_dir: Path) -> str:
    """Read-only check of an existing store; never creates or migrates anything."""
    path = store_path(state_dir)
    if not path.exists():
        return "absent"
    check_private(path)
    with sqlite3.connect(f"file:{path}?mode=ro", uri=True) as db:
        verify(db)
    return "ok"


def bind(db: sqlite3.Connection, thread_id: str, project: str, name: str, creator_id: str,
         created_at: str) -> bool:
    """Insert a registered thread; return False when the thread is already known."""
    db.execute("BEGIN IMMEDIATE")
    try:
        if db.execute("SELECT 1 FROM threads WHERE thread_id=?", (thread_id,)).fetchone():
            db.execute("COMMIT")
            return False
        db.execute("""INSERT INTO threads (thread_id, project, name, creator_id, state, created_at)
            VALUES (?,?,?,?,'registered',?)""", (thread_id, project, name, creator_id, created_at))
        db.execute("COMMIT")
        return True
    except sqlite3.Error:
        db.execute("ROLLBACK")
        raise


def threads(db: sqlite3.Connection) -> list[sqlite3.Row]:
    return db.execute("SELECT * FROM threads ORDER BY project, created_at, thread_id").fetchall()


def thread(db: sqlite3.Connection, thread_id: str) -> sqlite3.Row | None:
    return db.execute("SELECT * FROM threads WHERE thread_id=?", (thread_id,)).fetchone()


def update(db: sqlite3.Connection, thread_id: str, **fields) -> None:
    """Set the named columns on one thread row."""
    unknown = set(fields) - COLUMNS["threads"]
    if unknown or not fields:
        raise ValueError(f"unknown thread columns: {sorted(unknown)}")
    assignments = ", ".join(f"{name}=?" for name in fields)
    db.execute("BEGIN IMMEDIATE")
    try:
        db.execute(f"UPDATE threads SET {assignments} WHERE thread_id=?", (*fields.values(), thread_id))
        db.execute("COMMIT")
    except sqlite3.Error:
        db.execute("ROLLBACK")
        raise
