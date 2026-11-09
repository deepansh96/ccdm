"""`ccdm restart-session <project> [--after-pid PID [--after-started-at T]]`: one session, stopped and started again.

A channel's `/restart` runs this as a helper outside the session it stops: a
direct detached process on macOS and Linux, a child of ccdm-host on Windows,
which leaves it outside the session's Job. It only ever restarts a registered
project. Root restarts itself and a thread's session belongs to the Thread
Supervisor.

A stop run from inside its own session hands off and returns before it is done,
so the stop here runs as a detached copy, and a failed stop leaves the registry
as it was for a rerun: nothing is started after one.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path
from typing import BinaryIO, Dict, Optional, Tuple

from ..platform import proc
from ..platform.paths import state_root
from ..platform.session_host import SessionHostError
from ._detach import detach_if_self

ROOT_DIR = Path(__file__).resolve().parents[3]
_ENTRY = Path(__file__).resolve().parents[2] / "ccdm.py"

_NAME = "restart-session"
_ROOT_SESSION = "root_agent"
_DETACHED = "CCDM_DETACHED"
_SESSION_NAME = "CCDM_SESSION_NAME"
_WAIT_VARIABLE = "CCDM_RESTART_AFTER_PID_TIMEOUT_S"
_DEFAULT_WAIT_SECONDS = 30.0
_POLL_SECONDS = 0.2
_UNSAFE_IN_FILE_NAME = re.compile(r"[^A-Za-z0-9._-]")


def _complain(message: str) -> None:
    print(f"ccdm: {message}", file=sys.stderr, flush=True)


def _pid(value: str) -> int:
    pid = int(value)
    if pid <= 0:
        raise ValueError(value)
    return pid


def _log_path(project: str) -> Path:
    return state_root() / "logs" / f"restart-{_UNSAFE_IN_FILE_NAME.sub('_', project)}.log"


def _open_log(path: Path) -> BinaryIO:
    path.parent.mkdir(parents=True, exist_ok=True)
    return open(path, "ab", buffering=0, opener=lambda name, flags: os.open(name, flags, 0o600))


def _note(log: BinaryIO, project: str, message: str) -> None:
    line = f"{time.strftime('%Y-%m-%d %H:%M:%S')} {_NAME} {project}: {message}\n"
    log.write(line.encode("utf-8"))


def _read_entry(project: str) -> Tuple[str, str]:
    """The project's session name and its start subcommand."""
    with (ROOT_DIR / "registry.json").open(encoding="utf-8") as source:
        entry = json.load(source)["projects"][project]
    start = "start-codex-session" if entry.get("type", "claude") == "codex" else "start-session"
    return entry["screen_name"], start


def _wait_for_exit(log: BinaryIO, project: str, pid: int, started_at: Optional[str]) -> None:
    limit = float(os.environ.get(_WAIT_VARIABLE) or _DEFAULT_WAIT_SECONDS)
    _note(log, project, f"waiting up to {limit:g} s for pid {pid} to exit")
    deadline = time.monotonic() + limit
    while proc.alive(pid, started_at):
        if time.monotonic() >= deadline:
            _note(log, project, f"pid {pid} is still running; going on, and the stop ends it")
            return
        time.sleep(_POLL_SECONDS)
    _note(log, project, f"pid {pid} has exited")


def _step_env(detached: bool) -> Dict[str, str]:
    env = dict(os.environ)
    env.pop(_SESSION_NAME, None)
    env.pop(_DETACHED, None)
    if detached:
        env[_DETACHED] = "1"
    return env


def _run_step(log: BinaryIO, project: str, subcommand: str, detached: bool) -> int:
    _note(log, project, f"running {subcommand}")
    done = subprocess.run(
        [sys.executable, str(_ENTRY), subcommand, project],
        cwd=str(ROOT_DIR),
        env=_step_env(detached),
        stdin=subprocess.DEVNULL,
        stdout=log,
        stderr=subprocess.STDOUT,
    )
    _note(log, project, f"{subcommand} exited {done.returncode}")
    return done.returncode


def _restart(args: argparse.Namespace, start: str) -> int:
    project: str = args.project
    path = _log_path(project)
    with _open_log(path) as log:
        if args.after_pid is not None:
            _wait_for_exit(log, project, args.after_pid, args.after_started_at)
        # Only the stop can be running inside the session it ends. CCDM_DETACHED must
        # not reach the start: a tmux server this start creates would hand it to
        # every later session, and those could then stop themselves in the foreground.
        status = _run_step(log, project, "stop-session", detached=True)
        if status != 0:
            _complain(f"could not stop '{project}', so it was not started again; log: {path}")
            return status
        status = _run_step(log, project, start, detached=False)
    if status != 0:
        _complain(f"'{project}' was stopped but did not start again; log: {path}")
        return status
    print(f"Restarted '{project}'; log: {path}", flush=True)
    return 0


def _handler(args: argparse.Namespace) -> int:
    if args.after_started_at is not None and args.after_pid is None:
        _complain(f"{_NAME}: --after-started-at needs --after-pid")
        return 2
    project: str = args.project
    if project == _ROOT_SESSION:
        _complain(f"{_NAME} never restarts the root session")
        return 2
    try:
        screen, start = _read_entry(project)
    except (OSError, ValueError, KeyError, TypeError, AttributeError) as error:
        _complain(f"{_NAME}: could not read '{project}' from the registry: {error!r}")
        return 1
    if screen == _ROOT_SESSION:
        _complain(f"{_NAME} never restarts the root session")
        return 2
    try:
        detach_if_self(screen)
        return _restart(args, start)
    except (SessionHostError, OSError) as error:
        _complain(f"{_NAME}: {error}")
        return 1


def register(subparsers: argparse._SubParsersAction) -> None:
    parser = subparsers.add_parser(_NAME, help="stop a project's session and start it again")
    parser.add_argument("project", help="the registered project")
    parser.add_argument("--after-pid", type=_pid, metavar="PID", help="first wait up to 30 s for this process to exit")
    parser.add_argument("--after-started-at", metavar="T", help="that process's start time, so a reused PID is not waited for")
    parser.set_defaults(func=_handler)
