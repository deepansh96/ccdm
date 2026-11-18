"""The Thread Supervisor's private SQLite store, schema v3.

v2 added each thread's turn status (whose turn it is, its last input and
accepted turn end) to v1, with a board state, an owner ping and a
`status_board` table that v3 drops again. v3 adds each thread's turn mark: the
reaction root wants on the owner's latest input (⏳, ✅ or ⚠️) and the one
known to be shown on Discord. A v1 or v2 store migrates on the next `connect`,
after a private `threads.v<n>.backup.sqlite3` copy, in one transaction that
keeps every row; a failed migration leaves the store as it was, and a newer
version is refused.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
import os
from pathlib import Path
import sqlite3
import time
import uuid

from ccdmlib.platform.private_fs import is_private

from .paths import private_directory


SCHEMA_VERSION = 3
THREAD_STATES = ("registered", "booting", "live", "queued", "stopped", "closed")
STOP_REASONS = ("auto-archive", "archive-actor-unknown", "evicted", "operator", "crashed", "start-failed")
CLOSE_REASONS = ("owner-archive", "root-archive", "close-command", "deregistered", "project-moved")
REQUESTER_KINDS = ("owner", "guest", "root", "channel-agent")
REQUEST_STATUSES = ("pending", "fulfilled", "failed")
OVERRIDES = ("provider", "account", "model", "effort")
TURN_OWNERS = ("agent", "owner")
INPUT_CLASSES = ("owner", "guest", "starter")
TURN_OUTCOMES = ("completed", "failed")
# Turn marks: the agent is on it, it answered, it failed.
WAITING, DONE, FAILED = "⏳", "✅", "⚠️"
MARKS = (WAITING, DONE, FAILED)


def _one_of(column: str, values: tuple[str, ...], nullable: bool = False) -> str:
    allowed = ",".join(f"'{value}'" for value in values)
    return f"CHECK({column} IS NULL OR {column} IN ({allowed}))" if nullable else f"CHECK({column} IN ({allowed}))"


# One row per bound thread. Override columns are null when the thread inherits
# the project's setting; `resolved_*` hold what its session runs with.
# `parent_channel_id` is the project channel it was bound under, and a queued
# row's `queued_start` holds the trigger and starter it starts with (JSON).
# The turn-status columns after v1's. `whose_turn` is who the conversation
# waits on; `turn_end_seen` is the last turn end read from the session's
# activity.json. `mark_*` is the turn mark root wants on a message (both null
# for none) and `shown_*` the one it last saw Discord take; the worker's tick
# makes the second follow the first.
TURN_COLUMNS = {
    "whose_turn": f"TEXT {_one_of('whose_turn', TURN_OWNERS, nullable=True)}",
    "last_input_at": "TEXT",
    "last_input_class": f"TEXT {_one_of('last_input_class', INPUT_CLASSES, nullable=True)}",
    "turn_end_seen": "TEXT",
    "turn_outcome": f"TEXT {_one_of('turn_outcome', TURN_OUTCOMES, nullable=True)}",
    "mark_message_id": "TEXT",
    "mark_emoji": f"TEXT {_one_of('mark_emoji', MARKS, nullable=True)}",
    "shown_message_id": "TEXT",
    "shown_emoji": f"TEXT {_one_of('shown_emoji', MARKS, nullable=True)}",
}
TABLES = {
    "threads": f"""thread_id TEXT PRIMARY KEY, project TEXT NOT NULL, name TEXT NOT NULL,
        creator_id TEXT NOT NULL, starter_message_id TEXT, parent_channel_id TEXT, created_at TEXT NOT NULL,
        provider TEXT, account TEXT, model TEXT, effort TEXT,
        resolved_provider TEXT, resolved_account TEXT, resolved_model TEXT, resolved_effort TEXT,
        provider_conversation_id TEXT, provider_home TEXT,
        state TEXT NOT NULL {_one_of("state", THREAD_STATES)},
        stop_reason TEXT {_one_of("stop_reason", STOP_REASONS, nullable=True)},
        close_reason TEXT {_one_of("close_reason", CLOSE_REASONS, nullable=True)},
        runtime_tmux TEXT, runtime_pid INTEGER, ws_port INTEGER,
        last_owner_activity_at TEXT, last_agent_reply_at TEXT,
        pending_config TEXT, pending_close TEXT, queue_position INTEGER, queued_start TEXT,
        """ + ", ".join(f"{column} {definition}" for column, definition in TURN_COLUMNS.items()),
    "creation_requests": f"""request_id TEXT PRIMARY KEY, project TEXT NOT NULL, name TEXT NOT NULL,
        provider TEXT, account TEXT, model TEXT, effort TEXT, first_message TEXT,
        requester_id TEXT NOT NULL,
        requester_kind TEXT NOT NULL {_one_of("requester_kind", REQUESTER_KINDS)},
        status TEXT NOT NULL {_one_of("status", REQUEST_STATUSES)},
        thread_id TEXT, created_at TEXT NOT NULL""",
    "boot_buffers": """thread_id TEXT NOT NULL, message_id TEXT NOT NULL, payload TEXT NOT NULL,
        received_at TEXT NOT NULL, PRIMARY KEY(thread_id, message_id)""",
}
V1_COLUMNS = {
    "threads": {"thread_id", "project", "name", "creator_id", "starter_message_id", "parent_channel_id", "created_at",
                "provider", "account", "model", "effort",
                "resolved_provider", "resolved_account", "resolved_model", "resolved_effort",
                "provider_conversation_id", "provider_home", "state", "stop_reason", "close_reason",
                "runtime_tmux", "runtime_pid", "ws_port", "last_owner_activity_at", "last_agent_reply_at",
                "pending_config", "pending_close", "queue_position", "queued_start"},
    "creation_requests": {"request_id", "project", "name", "provider", "account", "model", "effort",
                          "first_message", "requester_id", "requester_kind", "status", "thread_id", "created_at"},
    "boot_buffers": {"thread_id", "message_id", "payload", "received_at"},
}
V2_COLUMNS = {
    **V1_COLUMNS,
    "threads": V1_COLUMNS["threads"] | {"whose_turn", "last_input_at", "last_input_class", "turn_end_seen",
                                        "turn_outcome", "display_state", "display_since", "ping_message_id"},
    "status_board": {"slot", "channel_id", "message_id", "content_sha256"},
}
COLUMNS = {**V1_COLUMNS, "threads": V1_COLUMNS["threads"] | set(TURN_COLUMNS)}
COLUMNS_BY_VERSION = {1: V1_COLUMNS, 2: V2_COLUMNS, SCHEMA_VERSION: COLUMNS}
# Versions a worker migrates, and a read-only reader accepts as they are.
OLDER_VERSIONS = (1, 2)


def store_path(state_dir: Path) -> Path:
    return state_dir / "threads.sqlite3"


def backup_path(state_dir: Path, version: int) -> Path:
    return state_dir / f"threads.v{version}.backup.sqlite3"


def verify(db: sqlite3.Connection, versions: tuple[int, ...] = (SCHEMA_VERSION,)) -> int:
    """Refuse a store whose version, tables or exact column sets are not one
    of ``versions``; returns its version."""
    version = db.execute("PRAGMA user_version").fetchone()[0]
    if version not in versions:
        raise ValueError("thread store schema is unsupported")
    expected = COLUMNS_BY_VERSION[version]
    tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    if tables != set(expected):
        raise ValueError("thread store schema is unsupported")
    for table, columns in expected.items():
        if {row[1] for row in db.execute(f"PRAGMA table_info({table})")} != columns:
            raise ValueError("thread store schema is unsupported")
    if db.execute("PRAGMA quick_check").fetchone()[0] != "ok":
        raise ValueError("thread store is corrupt")
    return version


def _backup(db: sqlite3.Connection, state_dir: Path, version: int) -> None:
    """A private copy of the store before its migration; an earlier copy is kept."""
    target = backup_path(state_dir, version)
    if target.exists():
        return
    temporary = state_dir / f".{target.name}.{os.getpid()}.tmp"
    os.close(os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600))
    try:
        copy = sqlite3.connect(temporary)
        try:
            db.backup(copy)
        finally:
            copy.close()
        os.chmod(temporary, 0o600)
        os.replace(temporary, target)
    except (OSError, sqlite3.Error):
        temporary.unlink(missing_ok=True)
        raise


def _migrate(db: sqlite3.Connection, state_dir: Path, version: int) -> None:
    """v1 or v2 → v3, in one transaction, after the backup. `threads` is
    rebuilt with the current definition and every row copied over in the
    columns both versions have, so it works on any SQLite (no DROP COLUMN) and
    the new columns get their checks; v2's `status_board` goes."""
    _backup(db, state_dir, version)
    db.execute("BEGIN IMMEDIATE")
    try:
        if db.execute("PRAGMA user_version").fetchone()[0] == version:
            kept = ", ".join(sorted(COLUMNS_BY_VERSION[version]["threads"] & COLUMNS["threads"]))
            rows = db.execute("SELECT COUNT(*) FROM threads").fetchone()[0]
            db.execute(f"CREATE TABLE threads_v{SCHEMA_VERSION} ({TABLES['threads']})")
            db.execute(f"INSERT INTO threads_v{SCHEMA_VERSION} ({kept}) SELECT {kept} FROM threads")
            db.execute("DROP TABLE threads")
            db.execute(f"ALTER TABLE threads_v{SCHEMA_VERSION} RENAME TO threads")
            db.execute("DROP TABLE IF EXISTS status_board")
            if db.execute("SELECT COUNT(*) FROM threads").fetchone()[0] != rows:
                raise sqlite3.IntegrityError("the migration lost thread rows")
            if os.environ.get("CCDM_THREAD_STORE_FAIL_MIGRATION") == "1":  # The E2E suite's failed migration.
                raise sqlite3.OperationalError("injected migration failure")
            db.execute(f"PRAGMA user_version={SCHEMA_VERSION}")
        db.execute("COMMIT")
    except sqlite3.Error:
        db.execute("ROLLBACK")
        raise


def _check_private(path: Path) -> None:
    if not is_private(path):
        raise ValueError("thread store permissions are not private")


def _publish(state_dir: Path, path: Path) -> None:
    """Build a complete current-schema store in a private temporary file beside
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
        version = verify(db, (*OLDER_VERSIONS, SCHEMA_VERSION))
        if version != SCHEMA_VERSION:
            _migrate(db, state_dir, version)
            verify(db)
    except (sqlite3.Error, ValueError, OSError):
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
        # An older store not yet migrated by a worker is still readable.
        version = verify(db, (*OLDER_VERSIONS, SCHEMA_VERSION))
        return {"user_version": version,
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
         request: sqlite3.Row | None = None, parent_channel_id: str | None = None) -> bool:
    """Insert a registered thread; False when the thread is already bound. A
    thread fulfilling a creation ``request`` takes its overrides, and the
    request is marked fulfilled in the same transaction."""
    overrides = {field: request[field] for field in OVERRIDES} if request else {}
    db.execute("BEGIN IMMEDIATE")
    try:
        if thread(db, thread_id):
            db.execute("COMMIT")
            return False
        db.execute("""INSERT INTO threads (thread_id, project, name, creator_id, parent_channel_id, created_at,
            provider, account, model, effort, state) VALUES (?,?,?,?,?,?,?,?,?,?,'registered')""",
                   (thread_id, project, name, creator_id, parent_channel_id, created_at,
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


def end_waiting(db: sqlite3.Connection, thread_id: str, emoji: str | None = None) -> None:
    """The thread's ⏳ becomes ``emoji`` on the same message, or goes when
    ``emoji`` is None; any other mark is left as it is."""
    db.execute("""UPDATE threads SET mark_emoji=?, mark_message_id=CASE WHEN ? IS NULL THEN NULL ELSE mark_message_id END
        WHERE thread_id=? AND mark_emoji=?""", (emoji, emoji, thread_id, WAITING))


def unsynced_marks(db: sqlite3.Connection) -> list[sqlite3.Row]:
    """Threads whose wanted turn mark differs from the one shown."""
    return db.execute("""SELECT * FROM threads WHERE mark_message_id IS NOT shown_message_id
        OR mark_emoji IS NOT shown_emoji ORDER BY thread_id""").fetchall()
