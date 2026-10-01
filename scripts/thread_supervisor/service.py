"""`enable`, `disable` and `preflight`: the supervised worker's opt-in, like the reminder service's.

`disable` leaves a private `disabled` marker in the state dir. A supervised
worker (`run --supervised`, what the LaunchAgent runs) exits successfully when
it appears and at once when started with it, so KeepAlive does not relaunch
it; the foreground `run` ignores it, for debugging.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
import sqlite3
import stat
import subprocess
import sys

from . import registry, store
from .paths import private_directory, write_private
from .status import status


MINIMUM_NODE_MAJOR = 22
MINIMUM_PYTHON = (3, 9)
ROUTER_SCRIPT = Path(__file__).resolve().parent.parent / "router.js"


def disabled_path(state_dir: Path) -> Path:
    return state_dir / "disabled"


def is_disabled(state_dir: Path) -> bool:
    return disabled_path(state_dir).exists()


def _node() -> str:
    return os.environ.get("CCDM_ROUTER_NODE") or "node"


def _interpreter_blockers() -> list[str]:
    blockers = []
    if sys.version_info < MINIMUM_PYTHON:
        blockers.append(f"python {'.'.join(map(str, MINIMUM_PYTHON))} or newer is required")
    try:
        completed = subprocess.run([_node(), "-p", "process.versions.node.split('.')[0]"], capture_output=True,
                                   text=True, timeout=15)
        major = int(completed.stdout.strip()) if completed.returncode == 0 else 0
    except (OSError, subprocess.TimeoutExpired, ValueError):
        major = 0
    if major < MINIMUM_NODE_MAJOR:
        blockers.append(f"node {MINIMUM_NODE_MAJOR} or newer is required at {_node()}; "
                        "set CCDM_ROUTER_NODE to its absolute path")
    return blockers


def _configuration_blockers(project_root: Path, state_dir: Path) -> list[str]:
    """Interpreters, the registry's owner and guild, and a usable store; reads only."""
    blockers = _interpreter_blockers()
    try:
        current = registry.load(project_root)
    except (OSError, ValueError):
        current = None
        blockers.append("registry.json is unavailable or invalid")
    if current is not None:
        if not registry.owner_id(current):
            blockers.append("registry.json has no CCDM owner (discord_user_id)")
        if not isinstance(current.get("guild_id"), str) or not current["guild_id"]:
            blockers.append("registry.json has no guild_id")
    if state_dir.exists() and stat.S_IMODE(state_dir.stat().st_mode) & 0o077:
        blockers.append("the thread supervisor state directory is not private (expected mode 0700)")
    try:
        store.inspect(state_dir)
    except (OSError, ValueError, sqlite3.Error) as error:
        blockers.append(f"the thread store cannot be used: {error}")
    return blockers


def _router_blockers() -> list[str]:
    try:
        completed = subprocess.run([_node(), str(ROUTER_SCRIPT), "status", "--json"], capture_output=True,
                                   text=True, timeout=15)
        reachable = completed.returncode == 0 and isinstance(json.loads(completed.stdout), dict)
    except (OSError, subprocess.TimeoutExpired, json.JSONDecodeError):
        reachable = False
    return [] if reachable else ["the Router is not reachable; start the Router "
                                 "(scripts/install-router-service.sh, or scripts/router.js serve)"]


def preflight(project_root: Path, state_dir: Path) -> dict:
    """Read-only installer checks: nothing is created or re-permissioned."""
    blockers = _configuration_blockers(project_root, state_dir) + _router_blockers()
    return {"status": "blocked" if blockers else "ok", "blockers": blockers, "disabled": is_disabled(state_dir)}


def enable(project_root: Path, state_dir: Path) -> dict:
    blockers = _configuration_blockers(project_root, state_dir)
    if blockers:
        return {"status": "blocked", "reason": "; ".join(blockers), "blockers": blockers}
    private_directory(state_dir)
    disabled_path(state_dir).unlink(missing_ok=True)
    return service_status(state_dir, project_root)


def disable(project_root: Path, state_dir: Path) -> dict:
    """Stop the supervised worker; threads, the store and the foreground `run` are untouched."""
    private_directory(state_dir)
    write_private(disabled_path(state_dir), "")
    return service_status(state_dir, project_root)


def service_status(state_dir: Path, project_root: Path) -> dict:
    return {**status(state_dir, project_root), "disabled": is_disabled(state_dir)}
