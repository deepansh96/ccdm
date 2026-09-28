#!/usr/bin/env python3
"""Resolve a Discord channel or thread id to the Project Conversation it belongs to.

Prints `{project, thread_id, provider, bot, channel_id}` as JSON: `thread_id`
is null for a registered project channel, and names the thread for a thread
the Thread Supervisor bound. It reads `registry.json` and the thread store
read-only and never calls Discord; an unknown or ambiguous id exits 2 with the
reason on stderr."""

from __future__ import annotations

import argparse
import importlib.util
import json
from pathlib import Path
import sqlite3
import sys


def _load(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


STORE = _load("ccdm_thread_store", "thread-supervisor-store.py")


class Unresolved(ValueError):
    """An id that names no single Project Conversation, with the reason."""


def bound_thread(state_dir: Path, thread_id: str) -> sqlite3.Row | None:
    """The thread store's row for ``thread_id``, read without creating or migrating the store."""
    if STORE.inspect(state_dir) == "absent":
        return None
    with sqlite3.connect(f"file:{STORE.store_path(state_dir)}?mode=ro", uri=True) as db:
        db.row_factory = sqlite3.Row
        return db.execute("SELECT project, provider, resolved_provider FROM threads WHERE thread_id=?",
                          (thread_id,)).fetchone()


def resolve(project_root: Path, state_dir: Path, target: str) -> dict:
    try:
        with (project_root / "registry.json").open(encoding="utf-8") as source:
            registry = json.load(source)
    except FileNotFoundError:
        raise Unresolved(f"registry.json not found at {project_root / 'registry.json'}")
    except json.JSONDecodeError as error:
        raise Unresolved(f"registry.json is invalid JSON: {error}")
    projects = registry.get("projects") if isinstance(registry.get("projects"), dict) else {}
    matches = [name for name, project in projects.items()
               if isinstance(project, dict) and str(project.get("channel_id") or "") == target]
    if len(matches) > 1:
        raise Unresolved(f"Channel {target} matches multiple projects: {', '.join(matches)}")
    thread_id = None
    provider = None
    if not matches:
        row = bound_thread(state_dir, target)
        if row is None:
            raise Unresolved(f"No project channel or bound thread is registered for {target}")
        if not isinstance(projects.get(row["project"]), dict):
            raise Unresolved(f"Thread {target} belongs to {row['project']}, which is no longer registered")
        matches, thread_id = [row["project"]], target
        provider = row["resolved_provider"] or row["provider"]
    name = matches[0]
    project = projects[name]
    return {"project": name, "thread_id": thread_id, "provider": provider or project.get("type") or "claude",
            "bot": project.get("bot_id"), "channel_id": str(project.get("channel_id"))}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("id", help="a Discord channel or thread id")
    parser.add_argument("--project-root", type=Path, default=Path(__file__).resolve().parent.parent)
    parser.add_argument("--state-dir", type=Path, default=None, help="the Thread Supervisor's state dir")
    args = parser.parse_args()
    try:
        result = resolve(args.project_root, args.state_dir or STORE.default_state_dir(), args.id)
    except (Unresolved, OSError, ValueError, sqlite3.Error) as error:
        print(str(error), file=sys.stderr)
        return 2
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
