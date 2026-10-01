"""Conversation Reminder events for a Thread Conversation's lifecycle.

The supervisor tells the reminder service's durable event receiver when a
thread's reminder tracking resets (an accepted provider or account switch;
`/clear` is not one), when the thread closes (an owner archive or its
`/close`), and when it is deleted. Each event is spooled to the receiver's
private outbox, exactly as the provider adapters spool theirs, and drained
at once; one the receiver cannot take yet stays in the outbox for the next
drain.
"""

from __future__ import annotations

from datetime import datetime, timezone
import importlib.util
import itertools
import json
import os
from pathlib import Path
import re
import sys
import uuid

from . import registry


_EVENTS_PATH = Path(__file__).resolve().parent.parent / "conversation-reminder-events.py"
_SPEC = importlib.util.spec_from_file_location("ccdm_thread_supervisor_reminder_events", _EVENTS_PATH)
EVENTS = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(EVENTS)
INSTANCE_ID = f"thread-supervisor:{uuid.uuid4().hex}"
_sequence = itertools.count(1)


def _log(message: str) -> None:
    print(f"thread-supervisor: {message}", file=sys.stderr, flush=True)


def _spool(state_dir: Path, event: dict) -> None:
    outbox = state_dir / "outbox"
    EVENTS.private_directory(outbox)
    name = f"{re.sub(r'[^a-zA-Z0-9_-]', '_', event['event_order'])}-{event['event_id']}.json"
    temporary = outbox / f".{name}.{os.getpid()}.tmp"
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as target:
            target.write(json.dumps(event) + "\n")
        os.replace(temporary, outbox / name)
    except OSError:
        temporary.unlink(missing_ok=True)
        raise


def emit(context, event_type: str, row) -> None:
    """Send ``event_type`` for the thread ``row`` under its project's current assignment."""
    thread_id = row["thread_id"]
    try:
        assignment = EVENTS.assignment_for(registry.load(context.project_root), row["project"])
    except (OSError, ValueError, KeyError) as error:
        return _log(f"thread {thread_id}: no reminder {event_type}, the project has no assignment: {error}")
    at = datetime.now(timezone.utc)
    milliseconds = int(at.timestamp() * 1000)
    event = {
        "schema_version": EVENTS.SCHEMA_VERSION, "event_id": str(uuid.uuid4()), "event_type": event_type,
        "project": row["project"], "channel_id": assignment["channel_id"], "conversation_id": thread_id,
        "bot_id": assignment["bot_id"], "assignment_generation": assignment["generation"],
        "provider": "ccdm-root", "event_time": at.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "event_order": f"{milliseconds:016d}:{INSTANCE_ID}:{next(_sequence):012d}",
        "adapter_instance_id": INSTANCE_ID,
    }
    state_dir = EVENTS.default_state_dir()
    try:
        _spool(state_dir, event)
        EVENTS.drain_outbox(context.project_root, state_dir)
    except OSError as error:
        _log(f"thread {thread_id}: the reminder {event_type} could not be recorded: {error}")
