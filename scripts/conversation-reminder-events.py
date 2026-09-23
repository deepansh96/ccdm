#!/usr/bin/env python3
"""Private, assignment-bound receiver for Conversation Reminder adapter events."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import stat
import sys
from datetime import datetime


SCHEMA_VERSION = 1
EVENT_TYPES = {
    "owner_activity",
    "response_delivered",
    "turn_completed",
    "input_needed",
    "work_resumed",
    "session_terminated",
    "close_requested",
}
ALLOWED_FIELDS = {
    "schema_version",
    "event_id",
    "event_type",
    "project",
    "channel_id",
    "bot_id",
    "assignment_generation",
    "provider",
    "provider_session_id",
    "provider_turn_id",
    "event_time",
    "event_order",
    "adapter_instance_id",
    "message_id",
    "source_message_id",
    "initiator_id",
    "interaction_id",
    "actor_id",
    "activity_kind",
    "disposition",
    "delivered_message_ids",
    "resumed_from_turn_id",
    "command",
}
REQUIRED_FIELDS = {
    "schema_version",
    "event_id",
    "event_type",
    "project",
    "channel_id",
    "bot_id",
    "assignment_generation",
    "provider",
    "event_time",
    "event_order",
    "adapter_instance_id",
}


def default_state_dir() -> Path:
    override = os.environ.get("CCDM_REMINDER_STATE_DIR")
    if override:
        return Path(override).expanduser()
    return Path.home() / ".local" / "state" / "ccdm" / "conversation-reminders"


def load_registry(project_root: Path) -> dict:
    with (project_root / "registry.json").open(encoding="utf-8") as source:
        registry = json.load(source)
    if not isinstance(registry, dict):
        raise ValueError("registry must be a JSON object")
    return registry


def assignment_for(registry: dict, project_name: str) -> dict:
    projects = registry.get("projects")
    project = projects.get(project_name) if isinstance(projects, dict) else None
    if not isinstance(project, dict):
        raise KeyError("project is not registered")
    owner_id = registry.get("discord_user_id")
    channel_id = project.get("channel_id")
    bot_id = project.get("bot_id")
    pool = registry.get("pool")
    matching_bots = [bot for bot in pool if isinstance(bot, dict) and bot.get("id") == bot_id] if isinstance(pool, list) else []
    if not owner_id or not channel_id or not bot_id or len(matching_bots) != 1:
        raise ValueError("project assignment is incomplete or ambiguous")
    bot = matching_bots[0]
    identity = "\0".join((
        project_name,
        str(owner_id),
        str(channel_id),
        str(bot_id),
        str(bot.get("app_id") or ""),
        str(project.get("registered_at") or ""),
    ))
    configured_generation = project.get("assignment_generation")
    generation = str(configured_generation) if configured_generation else "sha256:" + hashlib.sha256(
        identity.encode("utf-8")
    ).hexdigest()
    return {
        "project": project,
        "owner_id": str(owner_id),
        "channel_id": str(channel_id),
        "bot_id": str(bot_id),
        "bot": bot,
        "generation": generation,
    }


def private_directory(path: Path) -> None:
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(path, 0o700)


def database_path(state_dir: Path) -> Path:
    return state_dir / "events.sqlite3"


def connect_database(state_dir: Path, *, create: bool) -> sqlite3.Connection | None:
    db_path = database_path(state_dir)
    if not db_path.exists() and not create:
        return None
    private_directory(state_dir)
    connection = sqlite3.connect(db_path, timeout=2, isolation_level=None)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA journal_mode=WAL")
    connection.execute("PRAGMA synchronous=FULL")
    connection.execute("PRAGMA secure_delete=ON")
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS events (
            commit_order INTEGER PRIMARY KEY AUTOINCREMENT,
            event_id TEXT NOT NULL UNIQUE,
            payload_hash TEXT NOT NULL,
            schema_version INTEGER NOT NULL,
            event_type TEXT NOT NULL,
            project TEXT NOT NULL,
            channel_id TEXT NOT NULL,
            bot_id TEXT NOT NULL,
            assignment_generation TEXT NOT NULL,
            provider TEXT NOT NULL,
            provider_session_id TEXT,
            provider_turn_id TEXT,
            event_time TEXT NOT NULL,
            event_order TEXT NOT NULL,
            message_id TEXT,
            source_message_id TEXT,
            interaction_id TEXT,
            actor_id TEXT,
            activity_kind TEXT,
            disposition TEXT,
            delivered_message_ids_json TEXT NOT NULL,
            payload_json TEXT NOT NULL
        )
        """
    )
    connection.execute(
        "CREATE INDEX IF NOT EXISTS events_project_order ON events(project, commit_order DESC)"
    )
    os.chmod(db_path, 0o600)
    return connection


def _event_order_key(value: object) -> str:
    if isinstance(value, str) and value:
        return value
    if isinstance(value, dict):
        observed = value.get("observed_at_ms")
        instance = value.get("instance_id")
        sequence = value.get("sequence")
        if isinstance(observed, int) and isinstance(instance, str) and isinstance(sequence, int):
            return f"{observed:016d}:{instance}:{sequence:012d}"
    raise ValueError("event_order must identify observation time, adapter, and sequence")


def validate_event(event: object) -> dict:
    if not isinstance(event, dict):
        raise ValueError("event must be a JSON object")
    extra = set(event) - ALLOWED_FIELDS
    missing = REQUIRED_FIELDS - set(event)
    if extra:
        raise ValueError("event contains unsupported fields")
    if missing:
        raise ValueError("event is missing required fields")
    if event.get("schema_version") != SCHEMA_VERSION:
        raise ValueError("unsupported event schema version")
    if event.get("event_type") not in EVENT_TYPES:
        raise ValueError("unsupported event type")
    for field in ("event_id", "project", "channel_id", "bot_id", "assignment_generation", "provider", "adapter_instance_id"):
        if not isinstance(event.get(field), str) or not event[field].strip():
            raise ValueError(f"{field} must be a non-empty string")
    try:
        parsed_time = datetime.fromisoformat(str(event["event_time"]).replace("Z", "+00:00"))
    except ValueError as error:
        raise ValueError("event_time must be an ISO-8601 timestamp") from error
    if parsed_time.tzinfo is None:
        raise ValueError("event_time must include a timezone")
    normalized = dict(event)
    normalized["event_order"] = _event_order_key(event["event_order"])
    if normalized["provider"] not in {"codex", "claude", "ccdm-root"}:
        raise ValueError("unsupported event provider")
    event_type = normalized["event_type"]
    if event_type in {"response_delivered", "turn_completed", "input_needed", "work_resumed", "session_terminated"} and normalized["provider"] not in {"codex", "claude"}:
        raise ValueError("provider lifecycle events require a project adapter")
    if event_type in {"owner_activity", "close_requested"} and normalized["provider"] not in {"codex", "claude", "ccdm-root"}:
        raise ValueError("owner events require a registered CCDM adapter")
    if event_type in {"response_delivered", "input_needed", "turn_completed", "work_resumed"}:
        for field in ("provider_session_id", "provider_turn_id", "message_id", "interaction_id"):
            if field == "message_id" and event_type in {"turn_completed", "work_resumed"}:
                continue
            if not isinstance(normalized.get(field), str) or not normalized[field]:
                raise ValueError(f"{event_type} requires {field}")
    if event_type in {"work_resumed", "owner_activity", "close_requested"} and (
        not isinstance(normalized.get("source_message_id"), str) or not normalized["source_message_id"]
    ):
        raise ValueError(f"{event_type} requires source_message_id")
    if event_type == "session_terminated" and not isinstance(normalized.get("provider_session_id"), str):
        raise ValueError("session_terminated requires provider_session_id")
    if event_type == "response_delivered" and normalized.get("disposition", "progress") not in {"progress", "input-needed"}:
        raise ValueError("unsupported reply disposition")
    if event_type == "input_needed" and (not normalized.get("message_id") or normalized.get("disposition") != "input-needed"):
        raise ValueError("input_needed requires its successfully delivered question")
    if event_type in {"owner_activity", "close_requested"}:
        if not isinstance(normalized.get("actor_id"), str) or not normalized["actor_id"]:
            raise ValueError(f"{event_type} requires actor_id")
    if event_type == "owner_activity" and normalized.get("activity_kind") not in {"message", "attachment", "reaction", "management-command"}:
        raise ValueError("owner_activity requires a supported activity_kind")
    if event_type == "close_requested" and normalized.get("command") != "/close":
        raise ValueError("close_requested requires the exact /close command")
    if event_type == "turn_completed":
        ids = normalized.get("delivered_message_ids")
        if not isinstance(ids, list) or not ids or any(not isinstance(message_id, str) or not message_id for message_id in ids):
            raise ValueError("turn_completed requires confirmed delivered_message_ids")
        if len(ids) != len(set(ids)):
            raise ValueError("delivered_message_ids must be unique")
    normalized.setdefault("delivered_message_ids", [])
    return normalized


def _assignment_result(registry: dict, event: dict) -> tuple[str | None, str | None]:
    try:
        assignment = assignment_for(registry, event["project"])
    except KeyError:
        return "stale", "project is no longer registered"
    except ValueError:
        return "stale", "project assignment is incomplete or ambiguous"
    if assignment["channel_id"] != event["channel_id"] or assignment["bot_id"] != event["bot_id"]:
        return "stale", "project channel or bot assignment changed"
    if assignment["generation"] != event["assignment_generation"]:
        return "stale", "project assignment generation changed"
    if event["provider"] in {"codex", "claude"} and (assignment["project"].get("type") or "claude") != event["provider"]:
        return "rejected", "adapter event targets a different project provider"
    if event["event_type"] in {"owner_activity", "close_requested"} and event.get("actor_id") != assignment["owner_id"]:
        return "rejected", "owner event actor does not match the registered owner"
    return None, None


def ingest_event(project_root: Path, state_dir: Path, raw_event: object) -> dict:
    try:
        event = validate_event(raw_event)
    except (TypeError, ValueError) as error:
        return {"status": "rejected", "reason": str(error)}
    try:
        registry = load_registry(project_root)
    except (OSError, json.JSONDecodeError, ValueError):
        return {"status": "retryable_failure", "reason": "current registry could not be read"}
    status, reason = _assignment_result(registry, event)
    if status:
        return {"status": status, "reason": reason, "event_id": event["event_id"]}

    payload_json = json.dumps(event, sort_keys=True, separators=(",", ":"))
    payload_hash = hashlib.sha256(payload_json.encode("utf-8")).hexdigest()
    connection = None
    try:
        connection = connect_database(state_dir, create=True)
        connection.execute("BEGIN IMMEDIATE")
        existing = connection.execute(
            "SELECT payload_hash FROM events WHERE event_id = ?", (event["event_id"],)
        ).fetchone()
        if existing:
            connection.execute("ROLLBACK")
            if existing["payload_hash"] == payload_hash:
                return {"status": "duplicate", "event_id": event["event_id"]}
            return {"status": "rejected", "reason": "event_id was reused with different metadata", "event_id": event["event_id"]}
        if event["event_type"] == "input_needed":
            receipt = connection.execute(
                """SELECT 1 FROM events
                   WHERE event_type = 'response_delivered' AND project = ?
                     AND assignment_generation = ? AND provider_session_id = ?
                     AND provider_turn_id = ? AND interaction_id = ? AND message_id = ?
                     AND disposition = 'input-needed'
                   LIMIT 1""",
                (
                    event["project"], event["assignment_generation"],
                    event["provider_session_id"], event["provider_turn_id"],
                    event["interaction_id"], event["message_id"],
                ),
            ).fetchone()
            if not receipt:
                connection.execute("ROLLBACK")
                return {"status": "rejected", "reason": "input-needed event has no successful scoped reply receipt", "event_id": event["event_id"]}
        delivered_ids = event["delivered_message_ids"]
        if delivered_ids:
            placeholders = ",".join("?" for _ in delivered_ids)
            receipts = connection.execute(
                f"""SELECT COUNT(*) AS count FROM events
                    WHERE event_type = 'response_delivered' AND project = ?
                      AND assignment_generation = ? AND provider_session_id = ?
                      AND provider_turn_id = ? AND interaction_id = ?
                      AND message_id IN ({placeholders})""",
                (
                    event["project"], event["assignment_generation"],
                    event.get("provider_session_id"), event.get("provider_turn_id"),
                    event.get("interaction_id"), *delivered_ids,
                ),
            ).fetchone()["count"]
            if receipts != len(set(delivered_ids)):
                connection.execute("ROLLBACK")
                return {"status": "rejected", "reason": "turn completion references an unconfirmed reply receipt", "event_id": event["event_id"]}
        connection.execute(
            """INSERT INTO events (
                event_id, payload_hash, schema_version, event_type, project,
                channel_id, bot_id, assignment_generation, provider,
                provider_session_id, provider_turn_id, event_time, event_order,
                message_id, source_message_id, interaction_id, actor_id,
                activity_kind, disposition, delivered_message_ids_json, payload_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                event["event_id"], payload_hash, event["schema_version"], event["event_type"],
                event["project"], event["channel_id"], event["bot_id"], event["assignment_generation"],
                event["provider"], event.get("provider_session_id"), event.get("provider_turn_id"),
                event["event_time"], event["event_order"], event.get("message_id"),
                event.get("source_message_id"), event.get("interaction_id"), event.get("actor_id"),
                event.get("activity_kind"), event.get("disposition"),
                json.dumps(delivered_ids, separators=(",", ":")), payload_json,
            ),
        )
        connection.execute("COMMIT")
        return {"status": "committed", "event_id": event["event_id"]}
    except sqlite3.Error:
        if connection is not None and connection.in_transaction:
            connection.execute("ROLLBACK")
        return {"status": "retryable_failure", "reason": "event database is unavailable", "event_id": event["event_id"]}
    except OSError:
        return {"status": "retryable_failure", "reason": "private event storage is unavailable", "event_id": event["event_id"]}
    finally:
        if connection is not None:
            connection.close()
        for suffix in ("-wal", "-shm"):
            sidecar = Path(f"{database_path(state_dir)}{suffix}")
            if sidecar.exists():
                try:
                    os.chmod(sidecar, 0o600)
                except OSError:
                    pass


def _event_summary(row: sqlite3.Row) -> dict:
    event = json.loads(row["payload_json"])
    summary = {
        "event_id": row["event_id"],
        "event_type": row["event_type"],
        "event_time": row["event_time"],
        "event_order": row["event_order"],
        "channel_id": row["channel_id"],
        "assignment_generation": row["assignment_generation"],
        "provider": row["provider"],
    }
    for field in (
        "provider_session_id", "provider_turn_id", "message_id", "source_message_id",
        "interaction_id", "activity_kind", "disposition", "delivered_message_ids",
        "resumed_from_turn_id", "command",
    ):
        if field in event:
            summary[field] = event[field]
    return summary


def status_for(state_dir: Path, project_name: str) -> dict:
    pending_dir = state_dir / "outbox"
    pending_count = len(list(pending_dir.glob("*.json"))) if pending_dir.is_dir() else 0
    db_path = database_path(state_dir)
    if not db_path.exists():
        return {"available": True, "event_count": 0, "pending_count": pending_count, "events": []}
    try:
        if stat.S_IMODE(db_path.stat().st_mode) & 0o077:
            return {"available": False, "reason": "event database permissions are not private", "event_count": 0, "pending_count": pending_count, "events": []}
        connection = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=1)
        connection.row_factory = sqlite3.Row
        rows = connection.execute(
            "SELECT * FROM events WHERE project = ? ORDER BY commit_order DESC LIMIT 100",
            (project_name,),
        ).fetchall()
        count = connection.execute("SELECT COUNT(*) FROM events WHERE project = ?", (project_name,)).fetchone()[0]
        connection.close()
        return {
            "available": True,
            "event_count": count,
            "pending_count": pending_count,
            "events": [_event_summary(row) for row in reversed(rows)],
        }
    except (OSError, sqlite3.Error, json.JSONDecodeError):
        return {"available": False, "reason": "event database is unavailable or unsupported", "event_count": 0, "pending_count": pending_count, "events": []}


def drain_outbox(project_root: Path, state_dir: Path) -> dict:
    outbox = state_dir / "outbox"
    if not outbox.is_dir():
        return {"status": "complete", "committed": 0, "duplicates": 0, "rejected": 0, "stale": 0, "pending": 0}
    outcomes = []
    rejected_dir = state_dir / "rejected"
    for event_path in sorted(outbox.glob("*.json")):
        try:
            raw_event = json.loads(event_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            raw_event = None
        result = ingest_event(project_root, state_dir, raw_event)
        event_id = result.get("event_id")
        outcomes.append({"event_id": event_id, "status": result["status"]})
        if result["status"] in {"committed", "duplicate"}:
            event_path.unlink(missing_ok=True)
        elif result["status"] in {"stale", "rejected"}:
            try:
                private_directory(rejected_dir)
                destination = rejected_dir / event_path.name
                if not destination.exists():
                    shutil.move(str(event_path), destination)
                else:
                    event_path.unlink(missing_ok=True)
            except OSError:
                pass
        else:
            break
    counts = {status: sum(1 for row in outcomes if row["status"] == status) for status in ("committed", "duplicate", "rejected", "stale", "retryable_failure")}
    pending = len(list(outbox.glob("*.json")))
    return {
        "status": "retryable_failure" if counts["retryable_failure"] else "complete",
        "committed": counts["committed"],
        "duplicates": counts["duplicate"],
        "rejected": counts["rejected"],
        "stale": counts["stale"],
        "pending": pending,
        "outcomes": outcomes,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    for command in ("ingest", "drain", "status"):
        sub = subparsers.add_parser(command)
        sub.add_argument("--project-root", type=Path, default=Path.cwd())
        sub.add_argument("--state-dir", type=Path, default=default_state_dir())
        if command == "status":
            sub.add_argument("--project", required=True)
    args = parser.parse_args(argv)
    state_dir = args.state_dir.expanduser()
    if args.command == "ingest":
        try:
            raw_event = json.load(sys.stdin)
        except (json.JSONDecodeError, OSError):
            result = {"status": "rejected", "reason": "input is not valid JSON"}
        else:
            result = ingest_event(args.project_root.resolve(), state_dir, raw_event)
    elif args.command == "drain":
        result = drain_outbox(args.project_root.resolve(), state_dir)
    else:
        result = status_for(state_dir, args.project)
    print(json.dumps(result, sort_keys=True))
    return 1 if result.get("status") == "retryable_failure" else 0


if __name__ == "__main__":
    raise SystemExit(main())
