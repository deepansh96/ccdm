"""`ccdm list`: one line per project, the registry joined with the session host's liveness.

Output: ``<project>\\t<type>\\t<screen_name>\\t<live|stopped>\\t<pid|->``. ``--json``
prints the same fields as an array of objects. `status`, `session` and `context`
share this module's registry and failure helpers.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, NoReturn, Optional, Sequence, Set

from ..platform import proc, session_host
from ..platform.session_host import SessionHostError

REGISTRY = Path(__file__).resolve().parents[3] / "registry.json"
FIELDS = ("project", "type", "screen_name", "state", "pid")

# No host, or no tmux: nothing can be running.
_NOTHING_RUNNING = ("not_running", "spawn_failed")
# A reader can meet registry.json in the moment it is being replaced on Windows.
_REGISTRY_READ_BUDGET_S = 2.0
_REGISTRY_READ_POLL_S = 0.05
_ABSENT = "-"


def fail(message: str) -> NoReturn:
    print(f"ccdm: {message}", file=sys.stderr, flush=True)
    raise SystemExit(1)


def _read_registry() -> str:
    deadline = time.monotonic() + _REGISTRY_READ_BUDGET_S
    while True:
        try:
            return REGISTRY.read_text(encoding="utf-8")
        except PermissionError:
            if not proc.WIN32 or time.monotonic() >= deadline:
                raise
            time.sleep(_REGISTRY_READ_POLL_S)


def _projects() -> Dict[str, Any]:
    try:
        return json.loads(_read_registry()).get("projects", {})
    except FileNotFoundError:
        fail(f"registry.json not found at {REGISTRY}")
    except ValueError as error:
        fail(f"registry.json is invalid JSON: {error}")


def _live_session_names() -> Set[str]:
    try:
        return {session["name"] for session in session_host.list_sessions()}
    except SessionHostError as error:
        if error.code not in _NOTHING_RUNNING:
            raise
        print(f"ccdm: {error}; every project shows as stopped", file=sys.stderr, flush=True)
        return set()


def project_rows(only: Optional[str] = None) -> List[Dict[str, Any]]:
    """One row per project. ``pid`` is the registry's, and only while the session is live."""
    projects = _projects()
    if only is not None:
        if only not in projects:
            fail(f"unknown project: {only}")
        projects = {only: projects[only]}
    live = _live_session_names()
    rows = []
    for project, entry in projects.items():
        screen = entry.get("screen_name")
        running = bool(screen) and screen in live
        rows.append({
            "project": project,
            "type": entry.get("type", "claude"),
            "screen_name": screen,
            "state": "live" if running else "stopped",
            "pid": entry.get("pid") if running else None,
            "session_id": entry.get("session_id"),
            "path": str(entry.get("path", "")),
        })
    return rows


def print_rows(rows: Sequence[Dict[str, Any]], fields: Sequence[str], as_json: bool) -> None:
    if as_json:
        print(json.dumps([{field: row[field] for field in fields} for row in rows], indent=2, ensure_ascii=False))
        return
    for row in rows:
        print("\t".join(_ABSENT if row[field] is None else str(row[field]) for field in fields))


def _run(args: argparse.Namespace) -> int:
    print_rows(project_rows(), FIELDS, args.as_json)
    return 0


def register(subparsers: argparse._SubParsersAction) -> None:
    parser = subparsers.add_parser("list", help="List the projects and whether each one's session is live.")
    parser.add_argument("--json", dest="as_json", action="store_true", help="Print a JSON array.")
    parser.set_defaults(func=_run)
