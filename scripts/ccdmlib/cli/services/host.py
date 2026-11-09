"""The session host's service: ``node scripts/ccdm-host.js serve``.

Every session lives inside ccdm-host, so stopping it ends them all. The install
therefore refuses while sessions are live and prints how to upgrade without
losing them; ``--force`` goes ahead anyway.
"""

from __future__ import annotations

import json
import os
import subprocess
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

from . import ROOT_DIR, SCRIPTS_DIR, Context, Plan, ServiceError, require_node
from ...platform import proc, session_host
from ...platform.session_host import SessionHostError

TEMPLATE = "host.task.xml.in"
ACCEPTS_OPTIONS = True

# The host drops every CCDM_* name it inherits, so the state root is passed on
# explicitly. CCDM_HOST_KEEP_AWAKE turns on the power request held while project
# or thread sessions run on AC power.
ALLOWED_ENV = frozenset(("CCDM_HOST_KEEP_AWAKE", "CCDM_STATE_ROOT", "PATH"))

# Recorded from the Task Scheduler spike: the processes of a task already sit in
# a Job object. `serve` refuses to run in one unless told that this is expected.
TASKS_RUN_IN_A_JOB = True

_HOST = SCRIPTS_DIR / "ccdm-host.js"
_REGISTRY = ROOT_DIR / "registry.json"
_NO_HOST = ("not_running", "spawn_failed")
_CHECK_TIMEOUT_SECONDS = 60
_SHUTDOWN_TIMEOUT_SECONDS = 90
_STOP_WAIT_SECONDS = 30.0
_POLL_SECONDS = 0.25


def serve_command(node: str) -> List[str]:
    """What the task's service host runs."""
    command = [node, str(_HOST), "serve"]
    if TASKS_RUN_IN_A_JOB:
        command.append("--allow-in-job")
    return command


def _force(options: Sequence[str]) -> bool:
    if any(option != "--force" for option in options):
        raise ServiceError(2, f"ccdm: install-service host takes only --force: {' '.join(options)}")
    return bool(options)


def _run_node(node: str, args: Sequence[str], timeout: float) -> "subprocess.CompletedProcess[bytes]":
    return subprocess.run(
        [node, *args], cwd=str(ROOT_DIR), stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        timeout=timeout, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0), check=False,
    )


def _check_native_packages(node: str) -> None:
    """Refuse now what `serve` would refuse at every start: koffi must load."""
    script = "require(process.argv[1]).processIdentity()"
    try:
        completed = _run_node(node, ["-e", script, str(SCRIPTS_DIR / "platform" / "process.js")], _CHECK_TIMEOUT_SECONDS)
    except (OSError, subprocess.SubprocessError) as error:
        raise ServiceError(1, f"Error: could not check the host's native packages: {error}") from None
    if completed.returncode != 0:
        raise ServiceError(
            2, "Error: preflight failed; the existing task was left unchanged",
            "  - ccdm-host needs the optional native package koffi, which did not load; run npm ci",
        )


def _live_sessions() -> List[Dict[str, Any]]:
    """The running host's live sessions; none when no host is running."""
    try:
        return session_host.list_sessions()
    except SessionHostError as error:
        if error.code in _NO_HOST:
            return []
        raise ServiceError(1, f"Error: cannot ask the running ccdm-host for its sessions: {error}") from None


def _projects_by_session() -> Dict[str, Tuple[str, Optional[str]]]:
    """Session name to (project, conversation id), for the sessions the registry knows."""
    try:
        projects = json.loads(_REGISTRY.read_text(encoding="utf-8")).get("projects", {})
    except (OSError, ValueError, AttributeError):
        return {}
    known = {}
    for project, entry in projects.items():
        if isinstance(entry, dict) and entry.get("screen_name"):
            known[str(entry["screen_name"])] = (project, entry.get("session_id"))
    return known


def _session_lines(sessions: Sequence[Dict[str, Any]]) -> List[str]:
    known = _projects_by_session()
    lines = []
    for session in sessions:
        details = [str(session.get("kind") or "session")]
        project, session_id = known.get(session["name"], (None, None))
        if project is not None:
            details.append(f"project {project}")
            details.append(f"id {session_id}" if session_id else "no id recorded")
        lines.append(f"  - {session['name']} ({', '.join(details)})")
    return lines


def _refusal(sessions: Sequence[Dict[str, Any]]) -> ServiceError:
    count = f"{len(sessions)} live session{'' if len(sessions) == 1 else 's'}"
    return ServiceError(
        1,
        f"Error: ccdm-host has {count}, and installing the host ends every one; the existing task was left unchanged",
        *_session_lines(sessions),
        "To upgrade the host and keep the conversations:",
        "  1. Note each session's id: scripts/ccdm status",
        "  2. Stop each session: scripts/ccdm stop-session <project>",
        "  3. Install the host: scripts/ccdm install-service host",
        "  4. Start each session again: scripts/ccdm start-session <project> --resume <id>",
        "To install now and end these sessions: scripts/ccdm install-service host --force",
    )


def _lock_holder(lock: Path) -> Optional[Tuple[int, Optional[str]]]:
    """(pid, start time) of the live process named in a lock file."""
    try:
        words = lock.read_text(encoding="utf-8").split()
    except OSError:
        return None
    if not words or not words[0].isdigit():
        return None
    holder = (int(words[0]), words[1] if len(words) > 1 else None)
    return holder if proc.alive(*holder) else None


def _run_by_service(context: Context, host_pid: int) -> bool:
    if _lock_holder(context.lock) is None:
        return False
    try:
        return json.loads(context.state_file.read_text(encoding="utf-8")).get("child_pid") == host_pid
    except (OSError, ValueError, AttributeError):
        return False


def _stop_host_started_by_hand(context: Context, node: str) -> None:
    """A host outside the service holds the host lock, so the task's own could never start."""
    lock = context.state_root / "host" / "host.lock"
    holder = _lock_holder(lock)
    if holder is None or _run_by_service(context, holder[0]):
        return
    print(f"Stopping the ccdm-host that was started outside the service (pid {holder[0]})")
    try:
        _run_node(node, [str(_HOST), "shutdown"], _SHUTDOWN_TIMEOUT_SECONDS)
    except (OSError, subprocess.SubprocessError):
        pass
    deadline = time.monotonic() + _STOP_WAIT_SECONDS
    while _lock_holder(lock) == holder:
        if time.monotonic() >= deadline:
            raise ServiceError(1, f"Error: the running ccdm-host (pid {holder[0]}) did not stop; "
                                  "the existing task was left unchanged")
        time.sleep(_POLL_SECONDS)


def plan(context: Context) -> Plan:
    force = _force(context.options)
    node = require_node()
    _check_native_packages(node)
    sessions = _live_sessions()
    if sessions:
        if not force:
            raise _refusal(sessions)
        print(f"--force: ending {len(sessions)} live session{'' if len(sessions) == 1 else 's'}")
        for line in _session_lines(sessions):
            print(line)
    _stop_host_started_by_hand(context, node)
    system_root = os.environ.get("SystemRoot") or "C:\\Windows"
    path = os.pathsep.join((os.path.dirname(node), os.path.join(system_root, "System32"), system_root))
    return Plan(
        node=node,
        command=serve_command(node),
        cwd=str(ROOT_DIR),
        env={"CCDM_HOST_KEEP_AWAKE": "1", "CCDM_STATE_ROOT": str(context.state_root), "PATH": path},
        allowed_env=ALLOWED_ENV,
        private_dirs=[str(context.state_root / "host")],
    )


def before_uninstall(context: Context) -> None:
    """Say which sessions the uninstall ends; the host stops them when it gets the stop."""
    sessions = _live_sessions()
    if not sessions:
        return
    print(f"Ending {len(sessions)} live session{'' if len(sessions) == 1 else 's'} with the host")
    for line in _session_lines(sessions):
        print(line)
