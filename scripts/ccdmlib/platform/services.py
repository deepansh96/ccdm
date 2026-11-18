"""Whether a CCDM background service is installed for this user.

A launchd plist on macOS, a scheduled task on Windows. The answers match
scripts/platform/services.js, which holds the same table; a test compares them.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path
from typing import Dict, Optional

from . import exe

# Service name -> its Windows task, ``\CCDM\<Task>`` or ``CCDM-<Task>``.
SERVICE_TASKS: Dict[str, str] = {
    "router": "Router",
    "host": "Host",
    "thread-supervisor": "ThreadSupervisor",
    "reminders": "Reminders",
    "usage-poster": "UsagePoster",
    "root-at-logon": "RootAtLogon",
}

_QUERY_TIMEOUT_SECONDS = 15.0


def _task_exists(task: str) -> bool:
    # Only ever the schtasks.exe on PATH. A bare name would be looked up in the
    # system directory first, whatever PATH says.
    found = exe._on_path("schtasks")  # pylint: disable=protected-access
    if not found:
        return False
    try:
        completed = subprocess.run(
            [found[0], "/query", "/tn", task], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL, timeout=_QUERY_TIMEOUT_SECONDS, check=False,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except (OSError, subprocess.SubprocessError):
        return False
    return completed.returncode == 0


def service_installed(name: str, platform: Optional[str] = None) -> bool:
    """True when the named service has its plist (macOS) or its task (Windows)."""
    if (sys.platform if platform is None else platform) != "win32":
        return (Path.home() / "Library" / "LaunchAgents" / f"com.ccdm.{name}.plist").exists()
    task = SERVICE_TASKS.get(name)
    if task is None:
        raise ValueError(f"unknown service: {name}")
    return _task_exists(f"\\CCDM\\{task}") or _task_exists(f"CCDM-{task}")
