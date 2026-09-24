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
DISCOVERY_PATH = Path(__file__).with_name("conversation-reminder-discovery.py")
DISCOVERY_SPEC = importlib.util.spec_from_file_location("ccdm_conversation_discovery", DISCOVERY_PATH)
DISCOVERY = importlib.util.module_from_spec(DISCOVERY_SPEC)
DISCOVERY_SPEC.loader.exec_module(DISCOVERY)
READINESS_PATH = Path(__file__).with_name("conversation-reminder-readiness.py")
READINESS_SPEC = importlib.util.spec_from_file_location("ccdm_conversation_readiness", READINESS_PATH)
READINESS = importlib.util.module_from_spec(READINESS_SPEC)
READINESS_SPEC.loader.exec_module(READINESS)
SCHEMA_VERSION = 5
CATCH_UP_SPACING = timedelta(seconds=5)
STATES = {"closed", "open-paused", "awaiting-owner"}
# Both provider adapters must be installed before any channel may receive a
# reminder; there is no Codex-only release.
PROVIDER_COMPONENTS = {
    "codex": ("scripts/codex-bridge.js", "scripts/discord-mcp-server.js", "scripts/conversation-reminder-adapter.js"),
    "claude": ("scripts/claude-reminder-channel.js", "scripts/claude-reminder-hook.js",
               "scripts/conversation-reminder-adapter.js"),
}


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
    if version not in (0, 1, 2, 3, 4, SCHEMA_VERSION) or (version == 0 and existed):
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
    if db.execute("PRAGMA user_version").fetchone()[0] == 2:
        # A retired assignment keeps its own cleanup identity, and its unresolved
        # intents never block delivery for the replacement generation.
        db.executescript("""
            BEGIN IMMEDIATE;
            CREATE TABLE retired_assignments (
                project TEXT NOT NULL, assignment_generation TEXT NOT NULL,
                channel_id TEXT NOT NULL, bot_id TEXT NOT NULL,
                reason TEXT NOT NULL, retired_at TEXT NOT NULL,
                PRIMARY KEY(project,assignment_generation)
            );
            CREATE TABLE retired_leftovers (
                action_id TEXT PRIMARY KEY, project TEXT NOT NULL, assignment_generation TEXT NOT NULL,
                message_id TEXT NOT NULL, reason TEXT NOT NULL
            );
            DROP INDEX active_delivery_intent;
            CREATE UNIQUE INDEX active_delivery_intent ON delivery_intents(project,assignment_generation)
                WHERE state IN ('sending','uncertain');
            PRAGMA user_version=3;
            COMMIT;
        """)
    if db.execute("PRAGMA user_version").fetchone()[0] == 3:
        # Checkpointed history discovery; live events buffer while a scan is active.
        db.executescript("BEGIN IMMEDIATE;" + DISCOVERY.SCHEMA + "PRAGMA user_version=4; COMMIT;")
    if db.execute("PRAGMA user_version").fetchone()[0] == 4:
        # Overdue channels released by discovery or restart reconciliation receive
        # at most one globally spaced catch-up reminder.
        db.executescript("""
            BEGIN IMMEDIATE;
            CREATE TABLE catch_ups (
                project TEXT NOT NULL, assignment_generation TEXT NOT NULL, marked_at TEXT NOT NULL,
                PRIMARY KEY(project,assignment_generation)
            );
            PRAGMA user_version=5;
            COMMIT;
        """)
    expected = {
        "delivery_intents": {"nonce", "project", "assignment_generation", "revision", "state",
                             "message_id", "claimed_at", "retry_at"},
        "retired_assignments": {"project", "assignment_generation", "channel_id", "bot_id",
                                "reason", "retired_at"},
        "retired_leftovers": {"action_id", "project", "assignment_generation", "message_id", "reason"},
        "discoveries": DISCOVERY.COLUMNS,
        "catch_ups": {"project", "assignment_generation", "marked_at"},
    }
    tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    if any(table not in tables or {row[1] for row in db.execute(f"PRAGMA table_info({table})")} != columns
           for table, columns in expected.items()):
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


def usable_assignment(registry: dict, name: str) -> dict | None:
    """Return the project's assignment only when it is complete and unambiguous."""
    assignment = EVENTS.assignment_for(registry, name)
    same_channel = [item for item in registry["projects"].values() if isinstance(item, dict)
                    and str(item.get("channel_id")) == assignment["channel_id"]]
    return assignment if len(same_channel) == 1 and assignment["bot"].get("token") else None


def retire_conversation(db: sqlite3.Connection, row: sqlite3.Row, reason: str) -> None:
    """Stop an obsolete assignment and keep only cleanup bound to its own identity."""
    project, generation = row["project"], row["assignment_generation"]
    db.execute("INSERT OR IGNORE INTO retired_assignments VALUES (?,?,?,?,?,?)",
               (project, generation, row["channel_id"], row["bot_id"], reason, stamp(clock_now())))
    if row["reminder_message_id"]:
        db.execute("""INSERT OR IGNORE INTO pending_actions
            (action_id,project,kind,message_id,assignment_generation) VALUES (?,?,?,?,?)""",
            ("delete:" + row["reminder_message_id"], project, "delete", row["reminder_message_id"], generation))
    # A ✅ acknowledgment is not cleanup; never act for the obsolete assignment.
    db.execute("""UPDATE pending_actions SET completed=2
        WHERE project=? AND assignment_generation=? AND kind='ack' AND completed=0""", (project, generation))
    db.execute("DELETE FROM discoveries WHERE project=? AND assignment_generation=?", (project, generation))
    db.execute("DELETE FROM catch_ups WHERE project=? AND assignment_generation=?", (project, generation))
    db.execute("DELETE FROM conversations WHERE project=?", (project,))


def current_conversation(db: sqlite3.Connection, name: str, assignment: dict) -> sqlite3.Row:
    """Return the row for the current assignment, retiring any other generation first."""
    current = db.execute("SELECT * FROM conversations WHERE project=?", (name,)).fetchone()
    if current is not None and (current["assignment_generation"], current["channel_id"], current["bot_id"],
                                current["owner_id"]) != (assignment["generation"], assignment["channel_id"],
                                                         assignment["bot_id"], assignment["owner_id"]):
        retire_conversation(db, current, "reassigned")
        current = None
    if current is None:
        # Re-registration must receive a new generation; never revive retired timers.
        reused = db.execute("SELECT 1 FROM retired_assignments WHERE project=? AND assignment_generation=?",
                            (name, assignment["generation"])).fetchone()
        db.execute("""INSERT INTO conversations
            (project,channel_id,bot_id,assignment_generation,owner_id,state,revision,
             cleanup_message_ids,reconciliation_status,checkpoint)
            VALUES (?,?,?,?,?,'open-paused',0,'[]',?,0)""",
            (name, assignment["channel_id"], assignment["bot_id"], assignment["generation"],
             assignment["owner_id"],
             "blocked-retired-generation" if reused else "suspended-incomplete-discovery"))
        current = db.execute("SELECT * FROM conversations WHERE project=?", (name,)).fetchone()
    return current


def apply_event(db: sqlite3.Connection, registry: dict, row: sqlite3.Row) -> str:
    return apply_payload(db, registry, EVENTS.validate_event(json.loads(row["payload_json"])), row["commit_order"])


def apply_payload(db: sqlite3.Connection, registry: dict, event: dict, commit_order: int | None) -> str:
    if db.execute("SELECT 1 FROM applied_events WHERE event_id=?", (event["event_id"],)).fetchone():
        return "duplicate"
    status, _ = EVENTS._assignment_result(registry, event)
    if status:
        return status
    if db.execute("SELECT 1 FROM retired_assignments WHERE project=? AND assignment_generation=?",
                  (event["project"], event["assignment_generation"])).fetchone():
        return "stale"
    assignment = usable_assignment(registry, event["project"])
    if assignment is None:
        return "stale"
    current = current_conversation(db, event["project"], assignment)
    if current["reconciliation_status"] in DISCOVERY.ACTIVE or current["reconciliation_status"] == DISCOVERY.RESTART:
        # Left unapplied in the durable event ledger until the history baseline or
        # restart reconciliation commits.
        return "buffered"
    changes = {"checkpoint": current["checkpoint"] if commit_order is None else commit_order,
               "last_event_order": event["event_order"]}
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
            # An acknowledgment of earlier progress in the same turn never suppresses
            # its final answer: the qualifying receipt alone must postdate the last
            # acknowledgment, which then arms a fresh hour.
            final_receipt = receipts[-1] if len(receipts) == len(ids) else None
            if final_receipt and (not current["last_ack_at"] or iso(final_receipt) > iso(current["last_ack_at"])):
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
        # A fresh arming or acknowledgment replaces any queued catch-up.
        db.execute("DELETE FROM catch_ups WHERE project=? AND assignment_generation=?",
                   (event["project"], event["assignment_generation"]))
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
        for row in db.execute("SELECT * FROM conversations").fetchall():
            if row["project"] not in projects:
                retire_conversation(db, row, "deregistered")
        for name in projects:
            try:
                assignment = usable_assignment(registry, name)
            except (KeyError, ValueError):
                assignment = None
            if assignment is None:
                # Ambiguous or missing configuration suspends rather than guesses.
                db.execute("""UPDATE conversations SET reconciliation_status='suspended-assignment'
                    WHERE project=? AND reconciliation_status='ready'""", (name,))
                continue
            current_conversation(db, name, assignment)
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


def assignment_changed(project_root: Path, state_dir: Path, name: str) -> dict:
    """Generation contract for registration workflows that polling cannot fully observe.

    Retire every known generation for the project, then issue a fresh generation in
    the registry so an identical delete/re-add can never revive old timers or events.
    """
    registry_path = project_root / "registry.json"
    db = connect(state_dir, create=True)
    try:
        db.execute("BEGIN IMMEDIATE")
        registry = EVENTS.load_registry(project_root)
        projects = registry.get("projects")
        if not isinstance(projects, dict):
            raise ValueError("registry project assignments are invalid")
        retired = []
        row = db.execute("SELECT * FROM conversations WHERE project=?", (name,)).fetchone()
        if row is not None:
            retire_conversation(db, row, "assignment-changed")
            retired.append(row["assignment_generation"])
        generation = None
        if isinstance(projects.get(name), dict):
            try:
                assignment = EVENTS.assignment_for(registry, name)
            except (KeyError, ValueError):
                assignment = None
            if assignment and assignment["generation"] not in retired:
                db.execute("INSERT OR IGNORE INTO retired_assignments VALUES (?,?,?,?,?,?)",
                           (name, assignment["generation"], assignment["channel_id"], assignment["bot_id"],
                            "assignment-changed", stamp(clock_now())))
                retired.append(assignment["generation"])
            generation = "gen-" + uuid.uuid4().hex
            projects[name]["assignment_generation"] = generation
            mode = stat.S_IMODE(registry_path.stat().st_mode)
            temporary = registry_path.with_name(f".registry.json.{os.getpid()}.tmp")
            with os.fdopen(os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode), "w") as target:
                json.dump(registry, target, indent=2)
                target.write("\n")
            os.chmod(temporary, mode)
            os.replace(temporary, registry_path)
            try:
                renewed = usable_assignment(registry, name)
            except (KeyError, ValueError):
                renewed = None
            if renewed:
                current_conversation(db, name, renewed)
        db.execute("COMMIT")
        return {"status": "changed", "project": name, "retired_generations": retired,
                "assignment_generation": generation}
    except Exception:
        if db.in_transaction:
            db.execute("ROLLBACK")
        raise
    finally:
        db.close()


def provider_prerequisites(project_root: Path) -> dict:
    providers = {}
    for provider, components in PROVIDER_COMPONENTS.items():
        missing = [name for name in components if not (project_root / name).is_file()]
        providers[provider] = {"met": not missing, "missing": missing}
    return {"met": all(row["met"] for row in providers.values()), "providers": providers}


def root_credentials_present() -> bool:
    directory = Path(os.environ.get("ROOT_DISCORD_STATE_DIR") or Path.home() / ".claude" / "channels" / "discord")
    try:
        lines = (directory / ".env").read_text(encoding="utf-8").splitlines()
    except OSError:
        return False
    token = next((line[len("DISCORD_BOT_TOKEN="):].strip().strip("'\"") for line in lines
                  if line.startswith("DISCORD_BOT_TOKEN=")), "")
    return bool(token) and not any(character.isspace() for character in token)


def enablement_checks(project_root: Path, state_dir: Path, prepare: bool = True) -> dict:
    """Foreground opt-in checks. Discord permissions are verified per channel by the worker.

    With ``prepare`` false nothing is created or re-permissioned, so a failed
    supervisor preflight leaves an existing installation untouched."""
    blockers = []
    prerequisites = provider_prerequisites(project_root)
    if not prerequisites["met"]:
        blockers.append("provider prerequisites are unmet: " + ", ".join(
            f"{provider} missing {', '.join(row['missing'])}"
            for provider, row in prerequisites["providers"].items() if not row["met"]))
    try:
        registry = EVENTS.load_registry(project_root)
    except (OSError, ValueError, json.JSONDecodeError):
        registry = {}
        blockers.append("registry.json is unavailable or invalid")
    owner = bool(registry.get("discord_user_id"))
    if registry and not owner:
        blockers.append("registry.json has no CCDM owner (discord_user_id)")
    if registry and not isinstance(registry.get("projects"), dict):
        blockers.append("registry project assignments are invalid")
    credentials = root_credentials_present()
    if not credentials:
        blockers.append("root Discord credentials are unavailable (ROOT_DISCORD_STATE_DIR/.env)")
    if prepare:
        EVENTS.private_directory(state_dir)
    private = state_dir.is_dir() and stat.S_IMODE(state_dir.stat().st_mode) & 0o077 == 0
    if not prepare and state_dir.exists() and not private:
        blockers.append("the reminder state directory is not private (expected mode 0700)")
    return {"blockers": blockers, "provider_prerequisites": prerequisites, "owner_configured": owner,
            "root_credentials": "present" if credentials else "missing",
            "state_dir_private": private,
            "channel_permissions": "verified per channel by the running worker; see status readiness"}


def preflight(project_root: Path, state_dir: Path) -> dict:
    """Read-only supervisor checks: configuration, adapters, credentials, and an intact store."""
    checks = enablement_checks(project_root, state_dir, prepare=False)
    blockers = list(checks["blockers"])
    current = None
    if not blockers:
        try:
            current = status(state_dir, project_root)
        except (OSError, ValueError, sqlite3.Error, json.JSONDecodeError) as error:
            blockers.append(f"the conversation store cannot be used: {error}")
    return {"status": "blocked" if blockers else "ok", "blockers": blockers, "preflight": checks,
            "disabled": bool(current and current["disabled"]),
            "discovery_requested": bool(current and current["discovery_requested"])}


def readiness_report(project_root: Path, state_dir: Path, db: sqlite3.Connection, conversations: dict,
                     observer_channels: dict, running: bool, disabled: bool, requested: bool) -> dict:
    """Per-project delivery readiness across adapters, observation, history, assignments, and intents."""
    prerequisites = provider_prerequisites(project_root)
    try:
        projects = EVENTS.load_registry(project_root).get("projects")
    except (OSError, ValueError, json.JSONDecodeError):
        projects = None
    report = {}
    for name in sorted(projects if isinstance(projects, dict) else {}):
        adapter = READINESS.build_readiness(name, project_root, state_dir)
        conversation = conversations.get(name)
        history = conversation["reconciliation_status"] if conversation else "untracked"
        observation = observer_channels.get(name, "awaiting-validation") if running else "worker-not-running"
        uncertain = [r[0] for r in db.execute("""SELECT nonce FROM delivery_intents WHERE project=?
            AND assignment_generation=? AND state IN ('sending','uncertain')""",
            (name, conversation["assignment_generation"]))] if conversation else []
        blockers = []
        if disabled:
            blockers.append("service is disabled; run enable")
        elif not requested:
            blockers.append("reminders are not enabled; run enable")
        if not prerequisites["met"]:
            blockers.append("provider prerequisites are unmet")
        issues = adapter["missing_credentials"] + adapter["assignment_mismatches"] + adapter["unsupported_capabilities"]
        if issues:
            blockers.append("adapter: " + "; ".join(issues))
        if not running:
            blockers.append("foreground worker is not running; start `run` or rerun "
                            "scripts/install-conversation-reminder-service.sh to relaunch the LaunchAgent")
        elif observation != "ready-observe-only":
            blockers.append("observation: " + observation)
        if history != "ready":
            reason = (conversation.get("discovery") or {}).get("reason") if conversation else None
            blockers.append("history: " + history + (f" ({reason})" if reason else ""))
        if uncertain:
            blockers.append("uncertain delivery: run recover")
        report[name] = {
            "provider": adapter["provider"], "adapter": adapter["status"], "observation": observation,
            "history": history, "assignment": adapter["assignment_mismatches"] or "ok",
            "uncertain_delivery": uncertain,
            "pending_cleanup": conversation["cleanup_message_ids"] if conversation else [],
            "catch_up_queued": bool(conversation and conversation["catch_up_queued"]),
            "delivery_ready": not blockers, "blockers": blockers,
        }
    return {"provider_prerequisites": prerequisites, "projects": report}


def is_disabled(state_dir: Path) -> bool:
    db = connect(state_dir)
    if db is None:
        return False
    try:
        row = db.execute("SELECT value FROM settings WHERE key='disabled'").fetchone()
        return bool(row and row["value"] == "1")
    finally:
        db.close()


def status(state_dir: Path, project_root: Path | None = None) -> dict:
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
                "discovery_requested": False,
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
                "discovery": DISCOVERY.status_for(db, row["project"], row["assignment_generation"]),
                "catch_up_queued": db.execute("""SELECT 1 FROM catch_ups WHERE project=?
                    AND assignment_generation=?""", (row["project"], row["assignment_generation"])).fetchone()
                is not None,
            }
        blocked = [name for name, row in conversations.items()
                   if row["reconciliation_status"] == "blocked-retired-generation"]
        unresolved = [dict(row) for row in db.execute("""SELECT nonce,project,state,claimed_at
            FROM delivery_intents WHERE state IN ('sending','uncertain') ORDER BY claimed_at LIMIT 100""")]
        pending = [dict(row) for row in db.execute("""SELECT project,kind,message_id FROM pending_actions
            WHERE completed=0 ORDER BY rowid LIMIT 100""")]
        retired = []
        for row in db.execute("SELECT * FROM retired_assignments ORDER BY retired_at DESC LIMIT 100").fetchall():
            key = (row["project"], row["assignment_generation"])
            actions = db.execute("""SELECT message_id,completed FROM pending_actions
                WHERE project=? AND assignment_generation=? AND kind='delete' ORDER BY rowid""", key).fetchall()
            retired.append({
                "project": row["project"], "assignment_generation": row["assignment_generation"],
                "channel_id": row["channel_id"], "bot_id": row["bot_id"],
                "reason": row["reason"], "retired_at": row["retired_at"],
                "cleanup": {
                    "pending": [a["message_id"] for a in actions if a["completed"] == 0],
                    "completed": [a["message_id"] for a in actions if a["completed"] == 1],
                    "inaccessible": [dict(a) for a in db.execute("""SELECT message_id,reason FROM retired_leftovers
                        WHERE project=? AND assignment_generation=? ORDER BY rowid""", key)],
                },
                "unresolved_nonces": [r[0] for r in db.execute("""SELECT nonce FROM delivery_intents
                    WHERE project=? AND assignment_generation=? AND state IN ('sending','uncertain')""", key)],
            })
        requested = db.execute("SELECT value FROM settings WHERE key='discovery_requested'").fetchone()
        requested = bool(requested and requested["value"] == "1")
        gate = db.execute("SELECT value FROM settings WHERE key='catch_up_next_at'").fetchone()
        readiness = (readiness_report(project_root, state_dir, db, conversations, observer_channels, running,
                                      disabled["value"] == "1", requested) if project_root else None)
        return {"status": "ok", "disabled": disabled["value"] == "1", "worker_running": running,
                "discovery_requested": requested,
                "observer_channels": observer_channels,
                "delivery_enabled": bool(disabled["value"] != "1" and requested and readiness and
                                         readiness["provider_prerequisites"]["met"]),
                "readiness": readiness, "catch_up_next_at": gate[0] if gate else None,
                "conversations": conversations, "unresolved_intents": unresolved,
                "pending_actions": pending, "retired_assignments": retired,
                "assignment_guidance": ("Blocked projects reuse a retired assignment generation. After confirming "
                                        "the registration, run scripts/conversation-reminder-service.py "
                                        "assignment-changed --project " + ", ".join(sorted(blocked)) + "."
                                        if blocked else None),
                "recovery_guidance": ("Run recover after restoring assigned bot access. If intent identity remains "
                                      "unresolved, do not resend or delete by emoji; retain state and investigate "
                                      "the listed nonce. Observation/history gaps remain a separate delivery gate."
                                      if unresolved else "No unresolved delivery intents.")}
    finally:
        db.close()


def set_disabled(project_root: Path, state_dir: Path) -> dict:
    """Stop sends without deleting closures, history, or delivery state."""
    db = connect(state_dir, create=True)
    db.execute("BEGIN IMMEDIATE")
    db.execute("INSERT OR REPLACE INTO settings VALUES ('disabled','1')")
    db.execute("COMMIT")
    db.close()
    return status(state_dir, project_root)


def set_enabled(project_root: Path, state_dir: Path) -> dict:
    """Manual foreground opt-in: check prerequisites, request discovery, and reconcile first."""
    checks = enablement_checks(project_root, state_dir)
    if checks["blockers"]:
        return {"status": "blocked", "reason": "; ".join(checks["blockers"]), "preflight": checks}
    db = connect(state_dir, create=True)
    try:
        db.execute("BEGIN IMMEDIATE")
        db.execute("INSERT OR REPLACE INTO settings VALUES ('disabled','0')")
        db.execute("INSERT OR REPLACE INTO settings VALUES ('discovery_requested','1')")
        # Observations may have been missed while disabled; nothing sends before reconciliation.
        db.execute("""UPDATE conversations SET reconciliation_status='suspended-restart-reconciliation'
            WHERE reconciliation_status='ready'""")
        db.execute("COMMIT")
    finally:
        db.close()
    return {**status(state_dir, project_root), "preflight": checks}


def request_discovery(project_root: Path, state_dir: Path) -> dict:
    """Persist the operator's discovery request; the foreground worker performs bounded passes."""
    db = connect(state_dir, create=True)
    db.execute("BEGIN IMMEDIATE")
    db.execute("INSERT OR REPLACE INTO settings VALUES ('discovery_requested','1')")
    db.execute("COMMIT")
    db.close()
    return status(state_dir, project_root)


def observation_gap(state_dir: Path) -> dict:
    """A Gateway disconnect or reconnect may have missed events: reconcile before any send."""
    db = connect(state_dir)
    if db is None:
        return {"status": "uninitialized"}
    try:
        db.execute("BEGIN IMMEDIATE")
        for row in db.execute("SELECT project,assignment_generation FROM conversations "
                              "WHERE reconciliation_status='reconciling'").fetchall():
            db.execute("DELETE FROM discoveries WHERE project=? AND assignment_generation=?", tuple(row))
        changed = db.execute("""UPDATE conversations SET reconciliation_status='suspended-restart-reconciliation'
            WHERE reconciliation_status IN ('ready','reconciling')""").rowcount
        db.execute("COMMIT")
        return {"status": "reconciling", "channels": changed}
    finally:
        db.close()


def discovery_next(project_root: Path, state_dir: Path) -> dict:
    sync(project_root, state_dir)
    registry = EVENTS.load_registry(project_root)
    usable = {}
    for name in registry.get("projects") or {}:
        try:
            usable[name] = usable_assignment(registry, name)
        except (KeyError, ValueError):
            usable[name] = None
    db = connect(state_dir, create=True)
    try:
        db.execute("BEGIN IMMEDIATE")
        request = DISCOVERY.next_request(db, usable, clock_now())
        db.execute("COMMIT")
        return {"request": request}
    except Exception:
        if db.in_transaction:
            db.execute("ROLLBACK")
        raise
    finally:
        db.close()


def discovery_result(project_root: Path, state_dir: Path, payload: dict) -> dict:
    if not isinstance(payload, dict):
        raise ValueError("discovery result payload is invalid")
    registry = EVENTS.load_registry(project_root)
    rows = event_rows(state_dir)
    project, generation = payload.get("project"), payload.get("assignment_generation")
    adapter_interactions = {row["interaction_id"] for row in rows_matching(state_dir, project, generation,
        "event_type IN ('response_delivered','turn_completed','input_needed','work_resumed')")}

    def reaction_times(message_id: str) -> list[str]:
        return [row["event_time"] for row in rows_matching(state_dir, project, generation,
                "event_type='owner_activity' AND activity_kind='reaction'")
                if row["source_message_id"] == message_id]

    db = connect(state_dir)
    try:
        db.execute("BEGIN IMMEDIATE")
        recorded = {r[0] for r in db.execute(
            "SELECT message_id FROM delivery_intents WHERE state='sent' AND message_id IS NOT NULL")}
        now = clock_now()
        outcome = DISCOVERY.record_result(db, payload, now, recorded, adapter_interactions, reaction_times)
        if outcome == "committed":
            # Reconcile forward: newer durable events win over the historical baseline.
            for row in rows:
                apply_event(db, registry, row)
        elif outcome == "reconciled":
            reconcile_restart(db, registry, rows, project, generation, now, reaction_times)
        if outcome in {"committed", "reconciled"}:
            mark_catch_up(db, project, generation, now)
        db.execute("COMMIT")
        return {"status": outcome}
    except Exception:
        if db.in_transaction:
            db.execute("ROLLBACK")
        raise
    finally:
        db.close()


def reconcile_restart(db: sqlite3.Connection, registry: dict, rows: list[sqlite3.Row], project: str,
                      generation: str, now: datetime, reaction_times) -> None:
    """Merge a restart scan onto persisted state, then release the channel for sends.

    Missed owner messages, /close, and management commands apply at their Discord
    times through the live state machine, followed by durable provider replay.
    History never arms a reminder by itself. Owner reactions that cannot be dated
    after the current response pause conservatively.
    """
    found = db.execute("SELECT summary_json FROM discoveries WHERE project=? AND assignment_generation=?",
                       (project, generation)).fetchone()
    summary = json.loads(found["summary_json"])
    row = db.execute("SELECT * FROM conversations WHERE project=?", (project,)).fetchone()
    db.execute("UPDATE conversations SET reconciliation_status='ready' WHERE project=?", (project,))
    missed = {}
    for ref, kind in ((summary["normal"], "message"), (summary["close"], "close"),
                      (summary["reply"], "management-command")):
        if ref and (kind != "management-command" or ref["kind"] == "owner-command"):
            missed.setdefault(ref["id"], (ref, kind))
    applied = 0
    for ref, kind in sorted(missed.values(), key=lambda item: (iso(item[0]["at"]), len(item[0]["id"]), item[0]["id"])):
        event = {"schema_version": 1, "event_id": f"history:{generation}:{ref['id']}", "project": project,
                 "channel_id": row["channel_id"], "bot_id": row["bot_id"], "assignment_generation": generation,
                 "provider": "ccdm-root", "event_time": ref["at"], "event_order": f"{ref['at']}:history:{ref['id']}",
                 "adapter_instance_id": "restart-reconciliation", "actor_id": row["owner_id"],
                 "source_message_id": ref["id"]}
        if kind == "close":
            event.update(event_type="close_requested", command="/close")
        else:
            event.update(event_type="owner_activity", activity_kind=kind)
        before = db.execute("SELECT revision FROM conversations WHERE project=?", (project,)).fetchone()[0]
        apply_payload(db, registry, EVENTS.validate_event(event), None)
        after = db.execute("SELECT revision,last_ack_message_id FROM conversations WHERE project=?",
                           (project,)).fetchone()
        applied += after["revision"] != before or after["last_ack_message_id"] == ref["id"] != row["last_ack_message_id"]
    for event_row in rows:
        apply_event(db, registry, event_row)
    basis = "missed-owner-activity" if applied else "no-missed-activity"
    current = db.execute("SELECT * FROM conversations WHERE project=?", (project,)).fetchone()
    seen = {r[0] for r in db.execute("""SELECT source_message_id FROM owner_sources
        WHERE project=? AND assignment_generation=?""", (project, generation))}
    if current["state"] == "awaiting-owner" and current["response_at"]:
        answered = iso(current["response_at"])
        pause = "reaction-ordering-unresolved" if summary["reaction_unresolved"] else None
        for item in summary["reacted"]:
            if pause:
                break
            if iso(item["at"]) >= answered:
                pause = "owner-reaction-after-answer"
            elif "reaction:" + item["id"] not in seen and not reaction_times(item["id"]):
                # Membership cannot date a reaction on an earlier message.
                pause = "reaction-ordering-unresolved"
        if pause:
            source = next((item["id"] for item in summary["reacted"]), current["response_message_id"])
            apply_payload(db, registry, EVENTS.validate_event({
                "schema_version": 1, "event_id": f"history-reaction:{generation}:{uuid.uuid4().hex}",
                "event_type": "owner_activity", "project": project, "channel_id": row["channel_id"],
                "bot_id": row["bot_id"], "assignment_generation": generation, "provider": "ccdm-root",
                "event_time": stamp(now), "event_order": f"{stamp(now)}:history-reaction",
                "adapter_instance_id": "restart-reconciliation", "actor_id": row["owner_id"],
                "source_message_id": source, "activity_kind": "reaction"}), None)
            basis = pause
    DISCOVERY.mark_reactions_seen(db, project, generation, summary["reacted"])
    db.execute("UPDATE discoveries SET basis=? WHERE project=? AND assignment_generation=?",
               (basis, project, generation))


def mark_catch_up(db: sqlite3.Connection, project: str, generation: str, now: datetime) -> None:
    """Queue one catch-up for a channel released while already overdue."""
    row = db.execute("SELECT * FROM conversations WHERE project=?", (project,)).fetchone()
    if (row and row["assignment_generation"] == generation and row["reconciliation_status"] == "ready" and
            row["state"] == "awaiting-owner" and row["due_at"] and iso(row["due_at"]) <= now):
        db.execute("INSERT OR IGNORE INTO catch_ups VALUES (?,?,?)", (project, generation, stamp(now)))


def rows_matching(state_dir: Path, project: str, generation: str, condition: str) -> list[sqlite3.Row]:
    path = EVENTS.database_path(state_dir)
    if not path.exists():
        return []
    with sqlite3.connect(f"file:{path}?mode=ro", uri=True) as source:
        source.row_factory = sqlite3.Row
        return source.execute(f"""SELECT interaction_id,source_message_id,event_time FROM events
            WHERE project=? AND assignment_generation=? AND {condition}""", (project, generation)).fetchall()


def pending_actions(state_dir: Path) -> dict:
    db = connect(state_dir)
    if db is None:
        return {"actions": []}
    try:
        rows = db.execute("""SELECT a.action_id,a.project,a.kind,a.message_id,a.assignment_generation,
                COALESCE(c.channel_id,r.channel_id) AS channel_id, COALESCE(c.bot_id,r.bot_id) AS bot_id,
                r.project IS NOT NULL AS retired
            FROM pending_actions a
            LEFT JOIN conversations c ON c.project=a.project AND c.assignment_generation=a.assignment_generation
            LEFT JOIN retired_assignments r ON r.project=a.project AND r.assignment_generation=a.assignment_generation
            WHERE a.completed=0 AND (c.project IS NOT NULL OR r.project IS NOT NULL)
            ORDER BY a.rowid LIMIT 100""").fetchall()
        return {"actions": [{**dict(row), "retired": bool(row["retired"])} for row in rows]}
    finally:
        db.close()


def uncertain_intents(state_dir: Path) -> dict:
    db = connect(state_dir)
    if db is None:
        return {"intents": []}
    try:
        rows = db.execute("""SELECT i.nonce,i.project,i.assignment_generation,i.claimed_at,
            c.channel_id,c.bot_id FROM delivery_intents i JOIN conversations c
              ON c.project=i.project AND c.assignment_generation=i.assignment_generation
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


SUSPENSIONS = {"suspended-assignment", "suspended-adapter-capability", "suspended-observation-access",
               "suspended-delivery-access"}


def suspend_assignment(state_dir: Path, project: str, generation: str, reason: str) -> dict:
    """Durably stop delivery for one assignment after lost access or capability."""
    if reason not in SUSPENSIONS:
        raise ValueError("unsupported suspension reason")
    db = connect(state_dir)
    if db is None:
        return {"status": "uninitialized"}
    try:
        db.execute("BEGIN IMMEDIATE")
        db.execute("""UPDATE conversations SET reconciliation_status=?
            WHERE project=? AND assignment_generation=?
              AND reconciliation_status IN ('ready','suspended-restart-reconciliation','reconciling')""",
                   (reason, project, generation))
        db.execute("COMMIT")
        return {"status": "suspended"}
    finally:
        db.close()


def record_leftover(state_dir: Path, action_id: str, reason: str) -> dict:
    """Report retired cleanup that cannot be done with the retired bot's own credentials."""
    db = connect(state_dir)
    if db is None:
        raise ValueError("conversation store is not initialized")
    try:
        db.execute("BEGIN IMMEDIATE")
        action = db.execute("""SELECT a.* FROM pending_actions a JOIN retired_assignments r
            ON r.project=a.project AND r.assignment_generation=a.assignment_generation
            WHERE a.action_id=? AND a.completed=0""", (action_id,)).fetchone()
        if action is None:
            raise ValueError("pending retired cleanup does not exist")
        db.execute("UPDATE pending_actions SET completed=2 WHERE action_id=?", (action_id,))
        db.execute("INSERT OR REPLACE INTO retired_leftovers VALUES (?,?,?,?,?)",
                   (action_id, action["project"], action["assignment_generation"], action["message_id"], reason))
        db.execute("COMMIT")
        return {"status": "inaccessible"}
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
        if (db.execute("SELECT value FROM settings WHERE key='disabled'").fetchone()[0] == "1" or
                not provider_prerequisites(project_root)["met"]):
            db.execute("COMMIT")
            return {"claim": None}
        now = clock_now()
        for row in db.execute("SELECT * FROM conversations ORDER BY project").fetchall():
            if row["state"] != "awaiting-owner" or row["reconciliation_status"] != "ready":
                continue
            if not row["due_at"] or iso(row["due_at"]) > now or json.loads(row["cleanup_message_ids"]):
                continue
            if db.execute("""SELECT 1 FROM delivery_intents WHERE project=? AND assignment_generation=?
                    AND state IN ('sending','uncertain')""",
                          (row["project"], row["assignment_generation"])).fetchone():
                continue
            previous = db.execute("""SELECT retry_at FROM delivery_intents WHERE project=?
                AND assignment_generation=? AND state='failed'
                ORDER BY rowid DESC LIMIT 1""", (row["project"], row["assignment_generation"])).fetchone()
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
            if db.execute("SELECT 1 FROM catch_ups WHERE project=? AND assignment_generation=?",
                          (row["project"], row["assignment_generation"])).fetchone():
                # Initial and catch-up sends share one durable global spacing gate,
                # so neither a restart nor a second channel can bypass it.
                gate = db.execute("SELECT value FROM settings WHERE key='catch_up_next_at'").fetchone()
                if gate and iso(gate[0]) > now:
                    continue
                db.execute("INSERT OR REPLACE INTO settings VALUES ('catch_up_next_at',?)",
                           (stamp(now + CATCH_UP_SPACING),))
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
            db.execute("DELETE FROM catch_ups WHERE project=? AND assignment_generation=?",
                       (intent["project"], intent["assignment_generation"]))
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
            else:
                # The assignment changed while the request was in flight. Remove the
                # late reminder only through the retired assignment's own identity.
                db.execute("""INSERT OR IGNORE INTO pending_actions
                    (action_id,project,kind,message_id,assignment_generation) VALUES (?,?,?,?,?)""",
                    ("delete:" + message_id, intent["project"], "delete", message_id,
                     intent["assignment_generation"]))
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
                if retry_after and db.execute("SELECT 1 FROM catch_ups WHERE project=? AND assignment_generation=?",
                                              (intent["project"], intent["assignment_generation"])).fetchone():
                    # Discord's rate limit takes precedence over catch-up spacing.
                    gate = db.execute("SELECT value FROM settings WHERE key='catch_up_next_at'").fetchone()
                    limited = clock_now() + timedelta(seconds=retry_after)
                    if not gate or iso(gate[0]) < limited:
                        db.execute("INSERT OR REPLACE INTO settings VALUES ('catch_up_next_at',?)", (stamp(limited),))
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
            # Observations may have been missed while no worker ran. Access and
            # assignment suspensions are revalidated by the new observer.
            db.execute("""UPDATE conversations SET reconciliation_status='suspended-restart-reconciliation'
                WHERE reconciliation_status IN ('ready','suspended-assignment','suspended-adapter-capability',
                                                'suspended-observation-access','suspended-delivery-access')""")
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
    parser.add_argument("command", choices=("sync", "status", "preflight", "disable", "enable", "run", "recover",
                                            "actions", "done", "leftover", "intents", "claim", "validate",
                                            "result", "assignment-changed", "suspend", "discover",
                                            "discovery-next", "discovery-result", "observation-gap"))
    parser.add_argument("--project-root", type=Path, default=Path(__file__).resolve().parent.parent)
    parser.add_argument("--state-dir", type=Path, default=EVENTS.default_state_dir())
    parser.add_argument("--action-id")
    parser.add_argument("--nonce")
    parser.add_argument("--outcome", choices=("sent", "failed", "access", "uncertain"))
    parser.add_argument("--message-id")
    parser.add_argument("--sent-at")
    parser.add_argument("--retry-after", type=float)
    parser.add_argument("--reason")
    parser.add_argument("--project")
    parser.add_argument("--generation")
    parser.add_argument("--payload")
    args = parser.parse_args()
    try:
        if args.command == "status":
            result = status(args.state_dir, args.project_root)
        elif args.command == "preflight":
            result = preflight(args.project_root, args.state_dir)
            if result["status"] == "blocked":
                print(json.dumps(result, sort_keys=True))
                return 2
        elif args.command == "disable":
            result = set_disabled(args.project_root, args.state_dir)
        elif args.command == "enable":
            result = set_enabled(args.project_root, args.state_dir)
            if result["status"] == "blocked":
                print(json.dumps(result, sort_keys=True))
                return 2
        elif args.command == "discover":
            result = request_discovery(args.project_root, args.state_dir)
        elif args.command == "observation-gap":
            result = observation_gap(args.state_dir)
        elif args.command == "discovery-next":
            result = discovery_next(args.project_root, args.state_dir)
        elif args.command == "discovery-result":
            if not args.payload:
                raise ValueError("--payload is required")
            result = discovery_result(args.project_root, args.state_dir, json.loads(args.payload))
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
        elif args.command == "assignment-changed":
            if not args.project:
                raise ValueError("--project is required")
            result = assignment_changed(args.project_root, args.state_dir, args.project)
        elif args.command == "suspend":
            if not args.project or not args.generation or not args.reason:
                raise ValueError("--project, --generation, and --reason are required")
            result = suspend_assignment(args.state_dir, args.project, args.generation, args.reason)
        elif args.command == "leftover":
            if not args.action_id or not args.reason:
                raise ValueError("--action-id and --reason are required")
            result = record_leftover(args.state_dir, args.action_id, args.reason)
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
            if is_disabled(args.state_dir):
                print(json.dumps(status(args.state_dir, args.project_root), sort_keys=True))
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
                    result["readiness"] = status(args.state_dir, args.project_root)["readiness"]
                    print(json.dumps(result, sort_keys=True))
                    return 0
                observer = subprocess.Popen(observer_args, env=observer_env)
                try:
                    while not is_disabled(args.state_dir):
                        sync(args.project_root, args.state_dir)
                        if observer.poll() is not None:
                            raise ValueError("conversation observer stopped")
                        time.sleep(0.5)
                finally:
                    # The observer finishes an in-flight request (bounded by its
                    # 10-second Discord timeout) before exiting.
                    observer.terminate()
                    try:
                        observer.wait(timeout=15)
                    except subprocess.TimeoutExpired:
                        observer.kill()
                        observer.wait()
            result = status(args.state_dir, args.project_root)
        print(json.dumps(result, sort_keys=True))
        return 0
    except (OSError, ValueError, sqlite3.Error, json.JSONDecodeError) as error:
        print(json.dumps({"status": "blocked", "reason": str(error)}, sort_keys=True))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
