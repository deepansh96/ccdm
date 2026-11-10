"""Root after logon: one run that waits for the Router and ccdm-host, then starts root.

The task runs once per logon, a minute after it, with no restart loop. Its
command is the hidden ``ccdm root-at-logon`` below. The Router and the session
host are tasks of their own that start at the same logon in no fixed order, and
the host's first start can take half a minute, so the run waits for both to
answer before it runs ``ccdm restart-root`` once, in the foreground.
``restart-root`` keeps its own rules: it checks the Router again, writes a fresh
root key and exits 0 only after root's Router hello.

Root on Windows is Claude only, so the service takes no options.
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
import time
from datetime import datetime, timezone
from typing import Any, Dict, List

from . import ROOT_DIR, SCRIPTS_DIR, Context, Plan, ServiceError, require_absolute, require_node
from ...platform import exe, session_host
# What restart-root passes on to root's session; the task must carry the same names.
from ..restart_root import _FORWARDED_TO_HOST_SESSION

TEMPLATE = "root-at-logon.task.xml.in"

_SUBCOMMAND = "root-at-logon"
_DEFAULT_WAIT_SECONDS = 120.0
_POLL_SECONDS = 2.0
_ROUTER_CHECK_TIMEOUT_SECONDS = 15
_ROUTER = "router"
_HOST = "ccdm-host"

# The service host drops every CCDM_* and CLAUDE* name it inherits, so what
# restart-root reads is recorded at install. These are always set.
_ALWAYS_SET_ENV = frozenset(("CCDM_STATE_ROOT", "PATH", "PYTHONUTF8"))
# These are recorded only when the installer's own environment sets them: the
# account root uses, and where this installation keeps its Router and host.
_CARRIED_WHEN_SET = tuple(sorted(
    (set(_FORWARDED_TO_HOST_SESSION) | {"CLAUDE_CONFIG_DIR", "CCDM_CLAUDE_LAUNCH_TIMEOUT_S"}) - _ALWAYS_SET_ENV
))
_MUST_BE_ABSOLUTE = ("CLAUDE_CONFIG_DIR", "CCDM_ROUTER_STATE_DIR", "CCDM_REMINDER_STATE_DIR")

# How much faster than real time the wait runs. Tests only.
_TIME_SCALE_VARIABLE = "CCDM_ROOT_AT_LOGON_TIME_SCALE"


def _resolved(resolve) -> Any:
    try:
        return resolve()
    except exe.ToolNotFound as error:
        raise ServiceError(1, f"Error: {error}") from None


def plan(context: Context) -> Plan:
    node = require_node()
    python = _resolved(exe.python)[0]
    require_absolute({"CCDM_PYTHON": python})
    claude = _resolved(exe.claude)["command"]  # A run without Claude could only fail in its log.
    carried = {name: os.environ[name] for name in _CARRIED_WHEN_SET if os.environ.get(name)}
    require_absolute({name: carried[name] for name in _MUST_BE_ABSOLUTE if name in carried})

    system_root = os.environ.get("SystemRoot") or "C:\\Windows"
    directories: List[str] = []
    for directory in (os.path.dirname(claude), os.path.dirname(node), os.path.join(system_root, "System32"), system_root):
        if directory not in directories:
            directories.append(directory)
    env: Dict[str, str] = {
        **carried,
        "CCDM_STATE_ROOT": str(context.state_root),
        "PATH": os.pathsep.join(directories),
        "PYTHONUTF8": "1",
    }
    return Plan(
        node=node,
        command=[python, str(SCRIPTS_DIR / "ccdm.py"), _SUBCOMMAND, "--wait", f"{_DEFAULT_WAIT_SECONDS:g}"],
        cwd=str(ROOT_DIR),
        env=env,
        allowed_env=_ALWAYS_SET_ENV | frozenset(carried),
        private_dirs=[],
        supervised=False,
    )


# --- the run: `ccdm root-at-logon --wait <seconds>` ----------------------


def _log(message: str) -> None:
    """One line of the run's story; the service host appends stdout to root-at-logon.log."""
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    print(f"{stamp} {_SUBCOMMAND}: {message}", flush=True)


def _time_scale() -> float:
    try:
        scale = float(os.environ.get(_TIME_SCALE_VARIABLE) or 1)
    except ValueError:
        return 1.0
    return scale if scale > 0 else 1.0


def _router_answers(node: str) -> bool:
    """Whether ``router.js status`` exits 0: the check restart-root makes, without its messages."""
    try:
        status = subprocess.run(
            [node, str(SCRIPTS_DIR / "router.js"), "status"], cwd=str(ROOT_DIR), stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=_ROUTER_CHECK_TIMEOUT_SECONDS,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0), check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    return status.returncode == 0


def _host_answers() -> bool:
    """Whether ccdm-host accepts a hello. With tmux there is no host to wait for."""
    try:
        session_host.list_sessions()
    except session_host.SessionHostError:
        return False
    return True


def _not_reachable(node: str) -> List[str]:
    down = []
    if not _router_answers(node):
        down.append(_ROUTER)
    if not _host_answers():
        down.append(_HOST)
    return down


def _run(args: argparse.Namespace) -> int:
    try:
        node = exe.node()["command"]
    except exe.ToolNotFound as error:
        _log(f"{error} root was not started")
        return 1
    scale = _time_scale()
    limit = f"{args.wait:g} s"
    _log(f"waiting up to {limit} for the Router and ccdm-host")
    deadline = time.monotonic() + args.wait / scale
    waiting_for: List[str] = []
    while True:
        down = _not_reachable(node)
        if not down:
            break
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            for name in down:
                _log(f"{name} not reachable after {limit}")
            _log("root was not started")
            return 1
        if down != waiting_for:
            waiting_for = down
            _log(f"still waiting for: {', '.join(down)}")
        time.sleep(min(_POLL_SECONDS / scale, remaining))

    _log("the Router and ccdm-host answer; running restart-root")
    # In the foreground, once: its own lines go to the same two logs.
    code = subprocess.call(
        [sys.executable, str(SCRIPTS_DIR / "ccdm.py"), "restart-root"], cwd=str(ROOT_DIR), stdin=subprocess.DEVNULL,
    )
    _log("root is up" if code == 0 else f"restart-root exited {code}; root was not started")
    return code


def _wait_seconds(value: str) -> float:
    seconds = float(value)
    if not 0 <= seconds < float("inf"):
        raise ValueError(value)
    return seconds


def register(subparsers: Any) -> None:
    # No help text: the task runs this, and it stays out of `ccdm --help`.
    parser = subparsers.add_parser(
        _SUBCOMMAND,
        description="Run by the root-at-logon task: wait for the Router and ccdm-host to answer, then run restart-root once.",
    )
    parser.add_argument("--wait", type=_wait_seconds, default=_DEFAULT_WAIT_SECONDS, metavar="SECONDS",
                        help="how long to wait for both before giving up (default: 120)")
    parser.set_defaults(func=_run)
