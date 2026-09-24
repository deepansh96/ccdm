#!/usr/bin/env python3
"""Foreground Project Conversation observer and delivery state service."""

from __future__ import annotations

import argparse
from datetime import datetime, timedelta, timezone
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import stat
import subprocess
import time
import uuid


EVENTS_PATH = Path(__file__).with_name("conversation-reminder-events.py")
SPEC = importlib.util.spec_from_file_location("ccdm_conversation_events", EVENTS_PATH)
EVENTS = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(EVENTS)
SCHEMA_VERSION = 2
STATES = {"closed", "open-paused", "awaiting-owner"}


def store_path(state_dir: Path) -> Path:
    return state_dir / "conversations.sqlite3"


def connect(state_dir: Path, create: bool = False) -> sqlite3.Connection | None:
    path = store_path(state_dir)
    existed = path.exists()
    if not existed and not create:
        return None
    if existed and (stat.S_IMODE(path.stat().st_mode) & 0o077):
        raise ValueError("conversation store permissions are not private")
    if existed and path.stat().st_size == 0:
        raise ValueError("conversation store schema is unsupported")
    EVENTS.private_directory(state_dir)
    db = sqlite3.connect(path, timeout=2, isolation_level=None)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("PRAGMA synchronous=FULL")
    db.execute("PRAGMA secure_delete=ON")
    version = db.execute("PRAGMA user_version").fetchone()[0]
    if version not in (0, 1, SCHEMA_VERSION) or (version == 0 and existed):
        db.close()
        raise ValueError("conversation store schema is unsupported")
    if version == 0:
        db.executescript("""
            CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS conversations (
                project TEXT PRIMARY KEY, channel_id TEXT NOT NULL, bot_id TEXT NOT NULL,
                assignment_generation TEXT NOT NULL, owner_id TEXT NOT NULL,
                state TEXT NOT NULL CHECK(state IN ('closed','open-paused','awaiting-owner')),
                revision INTEGER NOT NULL, last_ack_at TEXT, last_ack_message_id TEXT,
                current_interaction_id TEXT, response_message_id TEXT, response_at TEXT,
                due_at TEXT, reminder_message_id TEXT, cleanup_message_ids TEXT NOT NULL,
                last_event_order TEXT, reconciliation_status TEXT NOT NULL,
                checkpoint INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS applied_events (event_id TEXT PRIMARY KEY);
            CREATE TABLE IF NOT EXISTS owner_sources (
                project TEXT NOT NULL, assignment_generation TEXT NOT NULL,
                source_message_id TEXT NOT NULL, kind TEXT NOT NULL,
                PRIMARY KEY(project,assignment_generation,source_message_id)
            );
            CREATE TABLE IF NOT EXISTS qualifications (
                project TEXT NOT NULL, assignment_generation TEXT NOT NULL,
                provider_session_id TEXT NOT NULL, provider_turn_id TEXT NOT NULL,
                kind TEXT NOT NULL, response_message_id TEXT NOT NULL,
                PRIMARY KEY(project,assignment_generation,provider_session_id,
                            provider_turn_id,kind,response_message_id)
            );
            CREATE TABLE IF NOT EXISTS pending_actions (
                action_id TEXT PRIMARY KEY, project TEXT NOT NULL, kind TEXT NOT NULL,
                message_id TEXT NOT NULL, assignment_generation TEXT NOT NULL,
                completed INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS delivery_intents (
                nonce TEXT PRIMARY KEY, project TEXT NOT NULL, assignment_generation TEXT NOT NULL,
                revision INTEGER NOT NULL, state TEXT NOT NULL, message_id TEXT,
                claimed_at TEXT NOT NULL, retry_at TEXT
            );
            CREATE UNIQUE INDEX active_delivery_intent ON delivery_intents(project)
                WHERE state IN ('sending','uncertain');
            PRAGMA user_version=2;
        """)
        db.execute("INSERT OR IGNORE INTO settings VALUES ('disabled','0')")
    required = {"settings", "conversations", "applied_events", "owner_sources", "qualifications", "pending_actions"}
    tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    if not required.issubset(tables) or db.execute("PRAGMA quick_check").fetchone()[0] != "ok":
        db.close()
        raise ValueError("conversation store is corrupt or unsupported")
    columns = {
        "settings": {"key", "value"},
        "conversations": {"project", "channel_id", "bot_id", "assignment_generation", "owner_id",
                          "state", "revision", "last_ack_at", "last_ack_message_id",
                          "current_interaction_id", "response_message_id", "response_at", "due_at",
                          "reminder_message_id", "cleanup_message_ids", "last_event_order",
                          "reconciliation_status", "checkpoint"},
        "applied_events": {"event_id"},
        "owner_sources": {"project", "assignment_generation", "source_message_id", "kind"},
        "qualifications": {"project", "assignment_generation", "provider_session_id",
                           "provider_turn_id", "kind", "response_message_id"},
        "pending_actions": {"action_id", "project", "kind", "message_id",
                            "assignment_generation", "completed"},
    }
    if any({row[1] for row in db.execute(f"PRAGMA table_info({table})")} != expected
           for table, expected in columns.items()):
        db.close()
        raise ValueError("conversation store schema is unsupported")
    if version == 1:
        db.executescript("""
            CREATE TABLE delivery_intents (
                nonce TEXT PRIMARY KEY, project TEXT NOT NULL, assignment_generation TEXT NOT NULL,
                revision INTEGER NOT NULL, state TEXT NOT NULL, message_id TEXT,
                claimed_at TEXT NOT NULL, retry_at TEXT
            );
            CREATE UNIQUE INDEX active_delivery_intent ON delivery_intents(project)
                WHERE state IN ('sending','uncertain');
            PRAGMA user_version=2;
        """)
    expected_intent = {"nonce", "project", "assignment_generation", "revision", "state",
                       "message_id", "claimed_at", "retry_at"}
    if ("delivery_intents" not in {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            or {row[1] for row in db.execute("PRAGMA table_info(delivery_intents)")} != expected_intent):
        db.close()
        raise ValueError("conversation store schema is unsupported")
    os.chmod(path, 0o600)
    return db


def iso(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)


def stamp(value: datetime) -> str:
    utc = value.astimezone(timezone.utc)
    precision = "seconds" if utc.microsecond == 0 else "milliseconds" if utc.microsecond % 1000 == 0 else "microseconds"
    return utc.isoformat(timespec=precision).replace("+00:00", "Z")


def clock_now() -> datetime:
    clock_file = os.environ.get("CCDM_REMINDER_CLOCK_FILE")
    return iso(Path(clock_file).read_text(encoding="utf-8").strip()) if clock_file else datetime.now(timezone.utc)


def event_rows(state_dir: Path) -> list[sqlite3.Row]:
    path = EVENTS.database_path(state_dir)
    if not path.exists():
        return []
    if stat.S_IMODE(path.stat().st_mode) & 0o077:
        raise ValueError("event database permissions are not private")
    with sqlite3.connect(f"file:{path}?mode=ro", uri=True) as source:
        source.row_factory = sqlite3.Row
        return source.execute("SELECT commit_order, event_id, payload_json FROM events ORDER BY commit_order").fetchall()


def apply_event(db: sqlite3.Connection, registry: dict, row: sqlite3.Row) -> str:
    event = EVENTS.validate_event(json.loads(row["payload_json"]))
    if db.execute("SELECT 1 FROM applied_events WHERE event_id=?", (event["event_id"],)).fetchone():
        return "duplicate"
    status, _ = EVENTS._assignment_result(registry, event)
    if status:
        return status
    assignment = EVENTS.assignment_for(registry, event["project"])
    projects = registry.get("projects") or {}
    channel_matches = [item for item in projects.values() if isinstance(item, dict)
                       and str(item.get("channel_id")) == assignment["channel_id"]]
    if len(channel_matches) != 1 or not assignment["bot"].get("token"):
        return "stale"
    current = db.execute("SELECT * FROM conversations WHERE project=?", (event["project"],)).fetchone()
    if current is None or current["assignment_generation"] != event["assignment_generation"]:
        db.execute("""INSERT OR REPLACE INTO conversations
            (project,channel_id,bot_id,assignment_generation,owner_id,state,revision,
             cleanup_message_ids,reconciliation_status,checkpoint)
            VALUES (?,?,?,?,?,'open-paused',0,'[]','suspended-incomplete-discovery',0)""",
            (event["project"], event["channel_id"], event["bot_id"],
             event["assignment_generation"], assignment["owner_id"]),
        )
        current = db.execute("SELECT * FROM conversations WHERE project=?", (event["project"],)).fetchone()
    changes = {"checkpoint": row["commit_order"], "last_event_order": event["event_order"]}
    kind = event["event_type"]
    occurred = event["event_time"]
    duplicate_source = False
    if kind == "close_requested" or (kind == "owner_activity" and event["activity_kind"] != "reaction"):
        source = event["source_message_id"]
        existing_source = db.execute("""SELECT kind FROM owner_sources
            WHERE project=? AND assignment_generation=? AND source_message_id=?""",
            (event["project"], event["assignment_generation"], source)).fetchone()
        duplicate_source = existing_source is not None
        if not duplicate_source:
            db.execute("INSERT INTO owner_sources VALUES (?,?,?,?)",
                       (event["project"], event["assignment_generation"], source, kind))
    stale_owner_event = (kind in {"close_requested", "owner_activity"} and current["last_ack_at"]
                         and iso(occurred) < iso(current["last_ack_at"]))
    if stale_owner_event or duplicate_source:
        pass
    elif kind == "close_requested":
        changes.update(state="closed", due_at=None, current_interaction_id=None,
                       last_ack_at=occurred, last_ack_message_id=event["source_message_id"])
        db.execute("""INSERT OR IGNORE INTO pending_actions
            (action_id,project,kind,message_id,assignment_generation) VALUES (?,?,?,?,?)""",
            ("ack:" + event["source_message_id"], event["project"], "ack",
             event["source_message_id"], event["assignment_generation"]))
    elif kind == "owner_activity":
        if event["activity_kind"] == "message" or event["activity_kind"] == "attachment":
            changes.update(state="open-paused", current_interaction_id=event["source_message_id"],
                           due_at=None, last_ack_at=occurred, last_ack_message_id=event["source_message_id"])
        elif current["state"] != "closed":
            changes.update(state="open-paused", due_at=None,
                           last_ack_at=occurred, last_ack_message_id=event["source_message_id"])
    elif kind in {"input_needed", "turn_completed"} and current["state"] != "closed":
        interaction = event.get("interaction_id")
        ids = [event["message_id"]] if kind == "input_needed" else event["delivered_message_ids"]
        qualification = (event["project"], event["assignment_generation"],
                         event["provider_session_id"], event["provider_turn_id"], kind, ids[-1])
        already_qualified = db.execute("""SELECT 1 FROM qualifications
            WHERE project=? AND assignment_generation=? AND provider_session_id=?
              AND provider_turn_id=? AND kind=? AND response_message_id=?""",
            qualification).fetchone()
        if interaction == current["current_interaction_id"] and not already_qualified:
            receipts = []
            for message_id in ids:
                # The receiver has already validated the matching receipt. Use its
                # confirmed delivery time from the private event ledger.
                source = EVENTS.database_path(Path(db.execute("PRAGMA database_list").fetchone()[2]).parent)
                with sqlite3.connect(f"file:{source}?mode=ro", uri=True) as events_db:
                    events_db.row_factory = sqlite3.Row
                    receipt = events_db.execute("""SELECT event_time FROM events WHERE event_type='response_delivered'
                        AND project=? AND assignment_generation=? AND provider_session_id=?
                        AND provider_turn_id=? AND interaction_id=? AND message_id=? LIMIT 1""",
                        (event["project"], event["assignment_generation"], event.get("provider_session_id"),
                         event.get("provider_turn_id"), interaction, message_id)).fetchone()
                if receipt:
                    receipts.append(receipt["event_time"])
            if len(receipts) == len(ids) and all(not current["last_ack_at"] or iso(t) > iso(current["last_ack_at"]) for t in receipts):
                signal_time = max([iso(occurred), *map(iso, receipts)])
                changes.update(state="awaiting-owner", response_message_id=ids[-1],
                               response_at=stamp(signal_time), due_at=stamp(signal_time + timedelta(hours=1)))
                db.execute("INSERT INTO qualifications VALUES (?,?,?,?,?,?)", qualification)
    elif kind == "work_resumed" and current["state"] == "awaiting-owner":
        if event.get("interaction_id") == current["current_interaction_id"]:
            changes.update(state="open-paused", due_at=None)
    if ("state" in changes and changes["state"] != "awaiting-owner" and current["reminder_message_id"]):
        recorded_id = current["reminder_message_id"]
        db.execute("""INSERT OR IGNORE INTO pending_actions
            (action_id,project,kind,message_id,assignment_generation) VALUES (?,?,?,?,?)""",
            ("delete:" + recorded_id, event["project"], "delete", recorded_id,
             event["assignment_generation"]))
        cleanup_ids = json.loads(current["cleanup_message_ids"])
        changes.update(reminder_message_id=None, cleanup_message_ids=json.dumps([*cleanup_ids, recorded_id]))
    if "state" in changes or "due_at" in changes:
        changes["revision"] = current["revision"] + 1
    columns = ",".join(f"{key}=?" for key in changes)
    db.execute(f"UPDATE conversations SET {columns} WHERE project=?", (*changes.values(), event["project"]))
    db.execute("INSERT INTO applied_events VALUES (?)", (event["event_id"],))
    return "applied"


def sync(project_root: Path, state_dir: Path) -> dict:
    registry = EVENTS.load_registry(project_root)
    rows = event_rows(state_dir)
    db = connect(state_dir, create=True)
    count = 0
    try:
        db.execute("BEGIN IMMEDIATE")
        projects = registry.get("projects")
        if not isinstance(projects, dict):
            raise ValueError("registry project assignments are invalid")
        for name in projects:
            try:
                assignment = EVENTS.assignment_for(registry, name)
            except (KeyError, ValueError):
                continue
            same_channel = [item for item in projects.values() if isinstance(item, dict)
                            and str(item.get("channel_id")) == assignment["channel_id"]]
            if len(same_channel) != 1 or not assignment["bot"].get("token"):
                continue
            current = db.execute("SELECT assignment_generation FROM conversations WHERE project=?", (name,)).fetchone()
            if current is None or current["assignment_generation"] != assignment["generation"]:
                db.execute("""INSERT OR REPLACE INTO conversations
                    (project,channel_id,bot_id,assignment_generation,owner_id,state,revision,
                     cleanup_message_ids,reconciliation_status,checkpoint)
                    VALUES (?,?,?,?,?,'open-paused',0,'[]','suspended-incomplete-discovery',0)""",
                    (name, assignment["channel_id"], assignment["bot_id"],
                     assignment["generation"], assignment["owner_id"]),
                )
        for row in rows:
            if apply_event(db, registry, row) == "applied":
                count += 1
        db.execute("COMMIT")
    except Exception:
        if db.in_transaction:
            db.execute("ROLLBACK")
        raise
    finally:
        db.close()
    return {"status": "synced", "applied": count, "delivery_enabled": False}


def status(state_dir: Path) -> dict:
    lock_path = state_dir / "worker.lock"
    running = False
    if lock_path.exists():
        with lock_path.open("r") as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                fcntl.flock(lock, fcntl.LOCK_UN)
            except BlockingIOError:
                running = True
    observer_channels = {}
    health_path = state_dir / "observer-health.json"
    if running and health_path.exists():
        if stat.S_IMODE(health_path.stat().st_mode) & 0o077:
            raise ValueError("observer health permissions are not private")
        health = json.loads(health_path.read_text(encoding="utf-8"))
        allowed = {"ready-observe-only", "blocked-assignment", "blocked-adapter-capability",
                   "blocked-observation-access", "blocked-assigned-bot-permissions"}
        if health.get("schema_version") != 1 or not isinstance(health.get("channels"), dict) or any(
            not isinstance(name, str) or value not in allowed for name, value in health["channels"].items()
        ):
            raise ValueError("observer health state is unsupported")
        observer_channels = health["channels"]
    db = connect(state_dir)
    if db is None:
        return {"status": "uninitialized", "disabled": False, "worker_running": running,
                "observer_channels": observer_channels, "delivery_enabled": False, "conversations": {}}
    try:
        disabled = db.execute("SELECT value FROM settings WHERE key='disabled'").fetchone()
        if disabled is None:
            raise ValueError("conversation store settings are incomplete")
        conversations = {}
        for row in db.execute("SELECT * FROM conversations"):
            if row["state"] not in STATES:
                raise ValueError("conversation store state is invalid")
            conversations[row["project"]] = {
                "channel_id": row["channel_id"], "assignment_generation": row["assignment_generation"],
                "state": row["state"], "revision": row["revision"],
                "last_ack_at": row["last_ack_at"], "last_ack_message_id": row["last_ack_message_id"],
                "current_interaction_id": row["current_interaction_id"],
                "response_message_id": row["response_message_id"],
                "response_at": row["response_at"], "due_at": row["due_at"],
                "reminder_message_id": row["reminder_message_id"],
                "cleanup_message_ids": json.loads(row["cleanup_message_ids"]),
                "reconciliation_status": row["reconciliation_status"], "checkpoint": row["checkpoint"],
            }
        unresolved = [dict(row) for row in db.execute("""SELECT nonce,project,state,claimed_at
            FROM delivery_intents WHERE state IN ('sending','uncertain') ORDER BY claimed_at LIMIT 100""")]
        pending = [dict(row) for row in db.execute("""SELECT project,kind,message_id FROM pending_actions
            WHERE completed=0 ORDER BY rowid LIMIT 100""")]
        return {"status": "ok", "disabled": disabled["value"] == "1", "worker_running": running,
                "observer_channels": observer_channels, "delivery_enabled": False,
                "conversations": conversations, "unresolved_intents": unresolved,
                "pending_actions": pending,
                "recovery_guidance": ("Run recover after restoring assigned bot access. If intent identity remains "
                                      "unresolved, do not resend or delete by emoji; retain state and investigate "
                                      "the listed nonce. Observation/history gaps remain a separate delivery gate."
                                      if unresolved else "No unresolved delivery intents.")}
    finally:
        db.close()


def set_disabled(state_dir: Path) -> dict:
    db = connect(state_dir, create=True)
    db.execute("BEGIN IMMEDIATE")
    db.execute("INSERT OR REPLACE INTO settings VALUES ('disabled','1')")
    db.execute("COMMIT")
    db.close()
    return status(state_dir)


def set_enabled(state_dir: Path) -> dict:
    db = connect(state_dir, create=True)
    db.execute("BEGIN IMMEDIATE")
    db.execute("INSERT OR REPLACE INTO settings VALUES ('disabled','0')")
    db.execute("COMMIT")
    db.close()
    return status(state_dir)


def pending_actions(state_dir: Path) -> dict:
    db = connect(state_dir)
    if db is None:
        return {"actions": []}
    try:
        rows = db.execute("""SELECT a.action_id,a.project,a.kind,a.message_id,a.assignment_generation,c.channel_id
            FROM pending_actions a JOIN conversations c ON c.project=a.project
            WHERE a.completed=0 ORDER BY a.rowid LIMIT 100""").fetchall()
        return {"actions": [dict(row) for row in rows]}
    finally:
        db.close()


def uncertain_intents(state_dir: Path) -> dict:
    db = connect(state_dir)
    if db is None:
        return {"intents": []}
    try:
        rows = db.execute("""SELECT i.nonce,i.project,i.assignment_generation,i.claimed_at,
            c.channel_id,c.bot_id FROM delivery_intents i JOIN conversations c ON c.project=i.project
            WHERE i.state='uncertain' ORDER BY i.claimed_at LIMIT 100""").fetchall()
        return {"intents": [dict(row) for row in rows]}
    finally:
        db.close()


def complete_action(state_dir: Path, action_id: str) -> dict:
    db = connect(state_dir)
    if db is None:
        raise ValueError("conversation store is not initialized")
    try:
        db.execute("BEGIN IMMEDIATE")
        action = db.execute("SELECT * FROM pending_actions WHERE action_id=?", (action_id,)).fetchone()
        if action is None:
            raise ValueError("pending action does not exist")
        db.execute("UPDATE pending_actions SET completed=1 WHERE action_id=?", (action_id,))
        if action["kind"] == "delete":
            current = db.execute("SELECT cleanup_message_ids FROM conversations WHERE project=?", (action["project"],)).fetchone()
            if current:
                remaining = [value for value in json.loads(current["cleanup_message_ids"]) if value != action["message_id"]]
                db.execute("UPDATE conversations SET cleanup_message_ids=? WHERE project=?",
                           (json.dumps(remaining), action["project"]))
        db.execute("COMMIT")
        return {"status": "complete"}
    finally:
        db.close()


def claim_due(project_root: Path, state_dir: Path) -> dict:
    # Apply committed observations before inspecting a due row. The transaction
    # then binds the intent to the exact assignment and conversation revision.
    sync(project_root, state_dir)
    registry = EVENTS.load_registry(project_root)
    db = connect(state_dir)
    try:
        db.execute("BEGIN IMMEDIATE")
        if db.execute("SELECT value FROM settings WHERE key='disabled'").fetchone()[0] == "1":
            db.execute("COMMIT")
            return {"claim": None}
        now = clock_now()
        for row in db.execute("SELECT * FROM conversations ORDER BY project").fetchall():
            if row["state"] != "awaiting-owner" or row["reconciliation_status"] != "ready":
                continue
            if not row["due_at"] or iso(row["due_at"]) > now or json.loads(row["cleanup_message_ids"]):
                continue
            if db.execute("""SELECT 1 FROM delivery_intents WHERE project=? AND state IN ('sending','uncertain')""",
                          (row["project"],)).fetchone():
                continue
            previous = db.execute("""SELECT retry_at FROM delivery_intents WHERE project=? AND state='failed'
                ORDER BY rowid DESC LIMIT 1""", (row["project"],)).fetchone()
            if previous and previous["retry_at"] and iso(previous["retry_at"]) > now:
                continue
            try:
                assignment = EVENTS.assignment_for(registry, row["project"])
            except (KeyError, ValueError):
                continue
            if (assignment["generation"] != row["assignment_generation"] or
                    assignment["channel_id"] != row["channel_id"] or assignment["bot_id"] != row["bot_id"] or
                    not assignment["bot"].get("token")):
                continue
            nonce = uuid.uuid4().hex[:24]
            db.execute("""INSERT INTO delivery_intents
                (nonce,project,assignment_generation,revision,state,claimed_at)
                VALUES (?,?,?,?,'sending',?)""",
                (nonce, row["project"], row["assignment_generation"], row["revision"], stamp(now)))
            db.execute("COMMIT")
            return {"claim": {"nonce": nonce, "project": row["project"],
                              "channel_id": row["channel_id"],
                              "assignment_generation": row["assignment_generation"]}}
        db.execute("COMMIT")
        return {"claim": None}
    finally:
        db.close()


def validate_claim(project_root: Path, state_dir: Path, nonce: str) -> dict:
    sync(project_root, state_dir)
    registry = EVENTS.load_registry(project_root)
    db = connect(state_dir)
    try:
        db.execute("BEGIN IMMEDIATE")
        intent = db.execute("SELECT * FROM delivery_intents WHERE nonce=?", (nonce,)).fetchone()
        row = db.execute("SELECT * FROM conversations WHERE project=?", (intent["project"],)).fetchone() if intent else None
        disabled = db.execute("SELECT value FROM settings WHERE key='disabled'").fetchone()[0] == "1"
        valid = bool(intent and intent["state"] == "sending" and row and not disabled and
                     row["state"] == "awaiting-owner" and row["reconciliation_status"] == "ready" and
                     row["assignment_generation"] == intent["assignment_generation"] and
                     row["revision"] == intent["revision"] and row["due_at"] and
                     iso(row["due_at"]) <= clock_now() and not json.loads(row["cleanup_message_ids"]))
        if valid:
            try:
                assignment = EVENTS.assignment_for(registry, intent["project"])
                valid = (assignment["generation"] == intent["assignment_generation"] and
                         assignment["channel_id"] == row["channel_id"] and
                         assignment["bot_id"] == row["bot_id"] and bool(assignment["bot"].get("token")))
            except (KeyError, ValueError):
                valid = False
        if not valid and intent and intent["state"] == "sending":
            db.execute("UPDATE delivery_intents SET state='canceled' WHERE nonce=?", (nonce,))
        db.execute("COMMIT")
        return {"valid": valid}
    finally:
        db.close()


def record_result(project_root: Path, state_dir: Path, nonce: str, outcome: str,
                  message_id: str | None, sent_at: str | None, retry_after: float | None) -> dict:
    sync(project_root, state_dir)
    db = connect(state_dir)
    try:
        db.execute("BEGIN IMMEDIATE")
        intent = db.execute("SELECT * FROM delivery_intents WHERE nonce=?", (nonce,)).fetchone()
        if intent is None or intent["state"] not in {"sending", "uncertain"}:
            raise ValueError("delivery intent is not active")
        if intent["state"] == "uncertain" and outcome != "sent":
            raise ValueError("uncertain delivery requires identity-verifiable confirmation")
        row = db.execute("SELECT * FROM conversations WHERE project=?", (intent["project"],)).fetchone()
        if outcome == "sent":
            if not message_id or not sent_at:
                raise ValueError("successful delivery requires a message identity and timestamp")
            delivery_time = iso(sent_at)
            db.execute("UPDATE delivery_intents SET state='sent', message_id=? WHERE nonce=?", (message_id, nonce))
            if row and row["assignment_generation"] == intent["assignment_generation"]:
                eligible_recovery = (intent["state"] == "uncertain" and
                                     row["reconciliation_status"] == "suspended-uncertain-send")
                canceled = (row["revision"] != intent["revision"] or row["state"] != "awaiting-owner" or
                            row["reconciliation_status"] != "ready" and not eligible_recovery)
                old_id = row["reminder_message_id"]
                to_delete = [message_id] if canceled else ([old_id] if old_id else [])
                cleanup = json.loads(row["cleanup_message_ids"])
                for old in to_delete:
                    db.execute("""INSERT OR IGNORE INTO pending_actions
                        (action_id,project,kind,message_id,assignment_generation) VALUES (?,?,?,?,?)""",
                        ("delete:" + old, intent["project"], "delete", old, intent["assignment_generation"]))
                    if old not in cleanup:
                        cleanup.append(old)
                if canceled:
                    db.execute("UPDATE conversations SET cleanup_message_ids=? WHERE project=?",
                               (json.dumps(cleanup), intent["project"]))
                else:
                    db.execute("""UPDATE conversations SET reminder_message_id=?, cleanup_message_ids=?,
                        due_at=?, revision=revision+1 WHERE project=?""",
                        (message_id, json.dumps(cleanup), stamp(delivery_time + timedelta(hours=1)), intent["project"]))
                if intent["state"] == "uncertain" and row["reconciliation_status"] == "suspended-uncertain-send":
                    db.execute("""UPDATE conversations SET reconciliation_status='suspended-restart-reconciliation'
                        WHERE project=?""", (intent["project"],))
            # The exclusion list includes every delivered reminder identity, even
            # after deletion, so a late reaction never reaches a coding agent.
            ids = [r[0] for r in db.execute("SELECT message_id FROM delivery_intents WHERE state='sent' AND message_id IS NOT NULL")]
            exclusion = state_dir / "recorded-reminder-message-ids.json"
            temporary = state_dir / f"recorded-reminder-message-ids.{os.getpid()}.tmp"
            temporary.write_text(json.dumps({"schema_version": 1, "message_ids": ids}), encoding="utf-8")
            os.chmod(temporary, 0o600)
            os.replace(temporary, exclusion)
        else:
            if outcome not in {"failed", "access", "uncertain"}:
                raise ValueError("invalid delivery result")
            retry_at = None
            if outcome == "failed":
                failures = db.execute("""SELECT COUNT(*) FROM delivery_intents
                    WHERE project=? AND assignment_generation=? AND state='failed'""",
                    (intent["project"], intent["assignment_generation"])).fetchone()[0]
                delay = max(min(300, 5 * (2 ** min(failures, 6))), retry_after or 0)
                retry_at = stamp(clock_now() + timedelta(seconds=delay))
            db.execute("UPDATE delivery_intents SET state=?, retry_at=? WHERE nonce=?",
                       (outcome, retry_at, nonce))
            if row and row["assignment_generation"] == intent["assignment_generation"] and outcome != "failed":
                db.execute("UPDATE conversations SET reconciliation_status=? WHERE project=?",
                           ("suspended-uncertain-send" if outcome == "uncertain" else "suspended-delivery-access",
                            intent["project"]))
        db.execute("COMMIT")
        return {"status": outcome}
    except Exception:
        if db.in_transaction:
            db.execute("ROLLBACK")
        raise
    finally:
        db.close()


def suspend_interrupted_sends(state_dir: Path) -> None:
    db = connect(state_dir, create=True)
    try:
        db.execute("BEGIN IMMEDIATE")
        started = db.execute("SELECT value FROM settings WHERE key='worker_started'").fetchone()
        if started:
            db.execute("""UPDATE conversations SET reconciliation_status='suspended-restart-reconciliation'
                WHERE reconciliation_status='ready'""")
        db.execute("INSERT OR REPLACE INTO settings VALUES ('worker_started','1')")
        for intent in db.execute("SELECT * FROM delivery_intents WHERE state='sending'").fetchall():
            db.execute("UPDATE delivery_intents SET state='uncertain' WHERE nonce=?", (intent["nonce"],))
            db.execute("""UPDATE conversations SET reconciliation_status='suspended-uncertain-send'
                WHERE project=? AND assignment_generation=?""",
                (intent["project"], intent["assignment_generation"]))
        db.execute("COMMIT")
    finally:
        db.close()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("sync", "status", "disable", "enable", "run", "recover",
                                            "actions", "done", "intents", "claim", "validate", "result"))
    parser.add_argument("--project-root", type=Path, default=Path(__file__).resolve().parent.parent)
    parser.add_argument("--state-dir", type=Path, default=EVENTS.default_state_dir())
    parser.add_argument("--action-id")
    parser.add_argument("--nonce")
    parser.add_argument("--outcome", choices=("sent", "failed", "access", "uncertain"))
    parser.add_argument("--message-id")
    parser.add_argument("--sent-at")
    parser.add_argument("--retry-after", type=float)
    args = parser.parse_args()
    try:
        if args.command == "status":
            result = status(args.state_dir)
        elif args.command == "disable":
            result = set_disabled(args.state_dir)
        elif args.command == "enable":
            result = set_enabled(args.state_dir)
        elif args.command == "sync":
            result = sync(args.project_root, args.state_dir)
        elif args.command == "actions":
            result = pending_actions(args.state_dir)
        elif args.command == "intents":
            result = uncertain_intents(args.state_dir)
        elif args.command == "done":
            if not args.action_id:
                raise ValueError("--action-id is required")
            result = complete_action(args.state_dir, args.action_id)
        elif args.command == "claim":
            result = claim_due(args.project_root, args.state_dir)
        elif args.command == "validate":
            if not args.nonce:
                raise ValueError("--nonce is required")
            result = validate_claim(args.project_root, args.state_dir, args.nonce)
        elif args.command == "result":
            if not args.nonce or not args.outcome:
                raise ValueError("--nonce and --outcome are required")
            result = record_result(args.project_root, args.state_dir, args.nonce, args.outcome,
                                   args.message_id, args.sent_at, args.retry_after)
        else:
            if status(args.state_dir)["disabled"]:
                print(json.dumps(status(args.state_dir), sort_keys=True))
                return 0
            lock_path = args.state_dir / "worker.lock"
            EVENTS.private_directory(args.state_dir)
            with lock_path.open("a+") as lock:
                os.chmod(lock_path, 0o600)
                try:
                    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError:
                    raise ValueError("conversation observer is already running")
                suspend_interrupted_sends(args.state_dir)
                observer_env = {**os.environ, "CCDM_REMINDER_PROJECT_ROOT": str(args.project_root),
                                "CCDM_REMINDER_STATE_DIR": str(args.state_dir)}
                observer_args = [os.environ.get("CCDM_REMINDER_NODE", "node"),
                                             str(Path(__file__).with_name("conversation-reminder-observer.js")),
                                             "--project-root", str(args.project_root), "--state-dir", str(args.state_dir)]
                if args.command == "recover":
                    sync(args.project_root, args.state_dir)
                    try:
                        completed = subprocess.run([*observer_args, "--recover-once"], env=observer_env,
                                                   capture_output=True, text=True, timeout=30)
                    except subprocess.TimeoutExpired as error:
                        raise ValueError("recovery timed out; retry after checking Discord access") from error
                    if completed.returncode:
                        raise ValueError("recovery could not inspect Discord; check assignment, credentials, and channel access")
                    result = json.loads(completed.stdout)
                    print(json.dumps(result, sort_keys=True))
                    return 0
                observer = subprocess.Popen(observer_args, env=observer_env)
                try:
                    while not status(args.state_dir)["disabled"]:
                        sync(args.project_root, args.state_dir)
                        if observer.poll() is not None:
                            raise ValueError("conversation observer stopped")
                        time.sleep(0.5)
                finally:
                    observer.terminate()
                    observer.wait(timeout=5)
            result = status(args.state_dir)
        print(json.dumps(result, sort_keys=True))
        return 0
    except (OSError, ValueError, sqlite3.Error, json.JSONDecodeError) as error:
        print(json.dumps({"status": "blocked", "reason": str(error)}, sort_keys=True))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
