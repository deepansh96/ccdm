"""Usage collection on a timer: ``usage-stats-poster.py --collect-only``.

Windows only collects, for ``ccdm usage``. Both machines use the same accounts and
the Mac stays the only poster, so the command below is fixed and no option changes it.
"""

from __future__ import annotations

import os
import subprocess
from datetime import datetime, timedelta
from typing import Dict, List, Sequence

from . import ROOT_DIR, SCRIPTS_DIR, Context, Plan, ServiceError, require_absolute, require_node
from ...platform import exe

TEMPLATE = "usage-poster.task.xml.in"
ACCEPTS_OPTIONS = True

_DEFAULT_INTERVAL_SECONDS = 600
_MINIMUM_INTERVAL_SECONDS = 60
# Task Scheduler refuses a repetition interval longer than 31 days.
_MAXIMUM_INTERVAL_SECONDS = 31 * 24 * 60 * 60
_CONFIG_CHECK_TIMEOUT_SECONDS = 60

_POSTER = SCRIPTS_DIR / "usage-stats-poster.py"
_COLLECT_ONLY = "--collect-only"

# The host drops every CCDM_* name it inherits, so the state root is passed on
# explicitly; collection and `ccdm usage` must agree on it.
_ALWAYS_SET_ENV = frozenset(("CCDM_CODEX_PATH", "CCDM_STATE_ROOT", "PATH", "PYTHONUTF8"))


def _interval_seconds(options: Sequence[str]) -> int:
    if not options:
        return _DEFAULT_INTERVAL_SECONDS
    if len(options) != 2 or options[0] != "--interval":
        raise ServiceError(2, f"ccdm: install-service usage-poster takes only --interval <seconds>: {' '.join(options)}")
    value = options[1]
    seconds = int(value) if value.isascii() and value.isdigit() else -1
    if not _MINIMUM_INTERVAL_SECONDS <= seconds <= _MAXIMUM_INTERVAL_SECONDS:
        raise ServiceError(2, f"Error: --interval must be a whole number of seconds from "
                              f"{_MINIMUM_INTERVAL_SECONDS} to {_MAXIMUM_INTERVAL_SECONDS}: {value}")
    return seconds


def _duration(total_seconds: int) -> str:
    """The ISO 8601 duration Task Scheduler reads: 600 is ``PT10M``."""
    days, rest = divmod(total_seconds, 86400)
    hours, rest = divmod(rest, 3600)
    minutes, seconds = divmod(rest, 60)
    time_part = "".join(f"{count}{unit}" for count, unit in ((hours, "H"), (minutes, "M"), (seconds, "S")) if count)
    date_part = f"{days}D" if days else ""
    return f"P{date_part}T{time_part}" if time_part else f"P{date_part}"


def _resolved_tool(resolve) -> Dict:
    try:
        return resolve()
    except exe.ToolNotFound as error:
        raise ServiceError(1, f"Error: {error}") from None


def _check_poster_config(python: str) -> None:
    """Refuse an unusable config now; a scheduled run would only fail in its log."""
    try:
        completed = subprocess.run(
            [python, str(_POSTER), "--validate-config"], env={**os.environ, "PYTHONUTF8": "1"}, cwd=str(ROOT_DIR),
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            timeout=_CONFIG_CHECK_TIMEOUT_SECONDS, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0), check=False,
        )
    except (OSError, subprocess.SubprocessError) as error:
        raise ServiceError(1, f"Error: could not check the poster config: {error}") from None
    if completed.returncode != 0:
        reason = completed.stderr.decode("utf-8", "replace").strip() or "the poster config is not valid"
        raise ServiceError(2, "Error: poster config check failed; the existing task was left unchanged", f"  - {reason}")


def _task_path(tools: Sequence[Dict]) -> str:
    system_root = os.environ.get("SystemRoot") or "C:\Windows"
    directories: List[str] = []
    for directory in (*(os.path.dirname(tool["command"]) for tool in tools), os.path.join(system_root, "System32"), system_root):
        if directory not in directories:
            directories.append(directory)
    return os.pathsep.join(directories)


def plan(context: Context) -> Plan:
    interval = _interval_seconds(context.options)
    node = require_node()
    python = _resolved_tool(exe.python)[0]
    require_absolute({"CCDM_PYTHON": python})
    codex = _resolved_tool(exe.codex)
    # codex.exe, or codex.js when the resolver falls back to running it with node.
    codex_path = codex["args"][0] if codex["args"] else codex["command"]
    require_absolute({"CCDM_CODEX_PATH": codex_path})
    _check_poster_config(python)

    tools = [codex, {"command": node}]
    try:
        tools.append(exe.claude())  # Only for the client version: without it the poster still collects.
    except exe.ToolNotFound:
        pass
    env = {
        **codex["env"],
        "CCDM_CODEX_PATH": codex_path,
        "CCDM_STATE_ROOT": str(context.state_root),
        "PATH": _task_path(tools),
        "PYTHONUTF8": "1",
    }
    first_run = datetime.now().replace(microsecond=0) + timedelta(seconds=interval)
    return Plan(
        node=node,
        command=[python, str(_POSTER), _COLLECT_ONLY],
        cwd=str(ROOT_DIR),
        env=env,
        allowed_env=_ALWAYS_SET_ENV | frozenset(codex["env"]),
        private_dirs=[],
        supervised=False,
        template_values={"__INTERVAL__": _duration(interval), "__START_BOUNDARY__": first_run.isoformat()},
    )
