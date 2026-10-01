"""`status`: whether a worker runs, its Router connection, the session caps, and the bound threads."""

from __future__ import annotations

import fcntl
import json
from pathlib import Path

from . import capacity, registry, store
from .worker import health_path, lock_path


def running(state_dir: Path) -> bool:
    path = lock_path(state_dir)
    if not path.exists():
        return False
    with path.open("r") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return True
        fcntl.flock(lock, fcntl.LOCK_UN)
    return False


def _capacity(project_root: Path) -> dict:
    try:
        current = registry.load(project_root)
    except (OSError, ValueError) as error:
        return {"caps": dict(capacity.DEFAULT_CAPS), "invalid": [f"the registry could not be read: {error}"]}
    caps, invalid = capacity.caps(current)
    return {"caps": caps, "invalid": invalid}


def status(state_dir: Path, project_root: Path) -> dict:
    alive = running(state_dir)
    health = {}
    if alive and health_path(state_dir).exists():
        try:
            health = json.loads(health_path(state_dir).read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            health = {}
    inspected = store.inspect(state_dir)
    projects: dict = {}
    for row in (inspected or {}).get("threads", []):
        projects.setdefault(row["project"], {"threads": {}})["threads"][row["thread_id"]] = {
            "name": row["name"], "creator_id": row["creator_id"], "state": row["state"],
            "stop_reason": row["stop_reason"], "close_reason": row["close_reason"], "ws_port": row["ws_port"],
            "queue_position": row["queue_position"],
            "provider_conversation_id": row["provider_conversation_id"],
            **{field: row[field] for field in store.OVERRIDES},
        }
    return {
        "running": alive,
        "worker_pid": health.get("pid") if alive else None,
        "link_pid": health.get("link_pid") if alive else None,
        "router": health.get("router", "unknown") if alive else "not-running",
        "store": {"user_version": inspected["user_version"]} if inspected else None,
        "capacity": _capacity(project_root),
        "projects": projects,
    }
