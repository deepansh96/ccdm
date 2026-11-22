"""What the two Python worker services share: the Thread Supervisor and Conversation Reminders.

Both run a Python worker that holds ``worker.lock`` in its state directory, has a
read-only ``preflight`` and keeps its own ``disabled`` marker. This is not a
service module: no service is named after it.
"""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence

from . import ROOT_DIR, Context, ServiceError, _host_alive, require_absolute, require_node
from ...platform import exe, filelock
from ...platform.paths import is_abs

_PREFLIGHT_TIMEOUT_SECONDS = 180
_NODE_PROBE_TIMEOUT_SECONDS = 30
_MINIMUM_NODE_MAJOR = 22


def _flags() -> int:
    return getattr(subprocess, "CREATE_NO_WINDOW", 0)


def resolve_python() -> str:
    """The shared resolver's interpreter, as an absolute path; the Store stub is never returned."""
    try:
        python = exe.python()[0]
    except exe.ToolNotFound as error:
        raise ServiceError(1, f"Error: {error}") from None
    require_absolute({"CCDM_PYTHON": python})
    return python


def resolve_node(variable: Optional[str] = None) -> str:
    """Node from ``variable`` when it is set, as the macOS installer reads it, else the shared check."""
    configured = os.environ.get(variable) if variable else None
    if not configured:
        return require_node()
    wanted = f"node {_MINIMUM_NODE_MAJOR} or newer is required"
    if not is_abs(configured):
        raise ServiceError(1, f"Error: {wanted}; set {variable} to its absolute path")
    try:
        probe = subprocess.run(
            [configured, "-p", "process.versions.node"], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, timeout=_NODE_PROBE_TIMEOUT_SECONDS, creationflags=_flags(), check=False,
        )
        major = probe.stdout.decode("utf-8", "replace").strip().split(".")[0]
    except (OSError, subprocess.SubprocessError):
        major = ""
    if not major.isdigit() or int(major) < _MINIMUM_NODE_MAJOR:
        raise ServiceError(1, f"Error: {wanted} at {configured}")
    return configured


def task_path(programs: Iterable[Optional[str]]) -> str:
    """The folders of the given programs, then the system's, each once."""
    system_root = os.environ.get("SystemRoot") or "C:\\Windows"
    directories: List[str] = []
    for program in programs:
        if program and os.path.dirname(program) not in directories:
            directories.append(os.path.dirname(program))
    for directory in (os.path.join(system_root, "System32"), system_root):
        if directory not in directories:
            directories.append(directory)
    return os.pathsep.join(directories)


def run_preflight(what: str, python: str, script: Path, args: Sequence[str], env: Dict[str, str]) -> Dict[str, Any]:
    """The worker's read-only ``preflight``; exit 2 with each blocker when it is not ready."""
    try:
        completed = subprocess.run(
            [python, str(script), "preflight", *args], env={**os.environ, **env, "PYTHONUTF8": "1"}, cwd=str(ROOT_DIR),
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            timeout=_PREFLIGHT_TIMEOUT_SECONDS, creationflags=_flags(), check=False,
        )
        text = completed.stdout.decode("utf-8", "replace")
        code: Optional[int] = completed.returncode
    except (OSError, subprocess.SubprocessError) as error:
        text, code = str(error), None
    report: Any = None
    try:
        report = json.loads(text)
    except ValueError:
        pass
    if code == 0 and isinstance(report, dict):
        return report
    if isinstance(report, dict):
        blockers = report.get("blockers") or [report.get("reason") or "unknown failure"]
    else:
        blockers = [f"the {what} could not run its preflight"]
    raise ServiceError(2, f"Error: {what} preflight failed; the existing task was left unchanged",
                       *(f"  - {blocker}" for blocker in blockers))


def refuse_foreground_worker(context: Context, what: str, state_dir: str) -> None:
    """A worker started by hand holds the lock, so the task's own would exit 2 at every start."""
    path = Path(state_dir) / "worker.lock"
    try:
        with path.open("r") as lock:
            if filelock.try_lock(lock):
                filelock.unlock(lock)
                return
    except OSError:
        return
    if _host_alive(context):
        return  # The installed service's own worker; the install stops it.
    raise ServiceError(
        1, f"Error: a {what} worker is already running outside the service; the existing task was left unchanged",
        "Stop it (Ctrl+C in its terminal), then run this command again.",
    )
