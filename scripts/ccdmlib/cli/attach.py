"""`ccdm attach <project> [--read-only|-r]`: watch a live session from this terminal.

The target is a project, `root`, a project with ``--thread <id|link>``, or a
session name, which is all a launcher that knows no project can print. The
terminal goes to the backend's own attach, so stdin and stdout are inherited:
Ctrl-] leaves a hosted session running, and the end of the session returns here.

A hosted session without a PTY, such as a Codex bridge, has no screen to attach
to. It holds only its output, so this command follows that output instead.
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from ..platform import exe, session_host
from ..platform.session_host import SessionHostError
from .send_claude_command import _fail, _is_live, _projects, _target

if sys.platform == "win32":
    import msvcrt

ROOT_DIR = Path(__file__).resolve().parents[3]

_ROOT_SESSION = "root_agent"
_INTERRUPTED = 130
_DETACH_KEY = "\x1d"  # Ctrl-]
_FOLLOW_POLL_S = 0.5
_KEY_POLL_S = 0.05
# Enough of what was shown to find its place again once the host's tail has moved.
_ANCHOR_CHARS = 4096


def _is_tmux() -> bool:
    return session_host.backend_name() == "tmux"


def _session(target: str, thread: Optional[str]) -> Tuple[str, Optional[str]]:
    """The session name and how to speak of it; None when the registry does not name it."""
    if thread:
        found = _target("channel", thread)
        if not found.thread_id or found.project != target:
            _fail(f"'{thread}' is not a thread of project '{target}'.")
        return found.session, f"thread {found.thread_id} in project '{target}'"
    if target == "root":
        return _ROOT_SESSION, "the root agent"
    if target in _projects():
        return _target("project", target).session, f"project '{target}'"
    return target, None


def _refuse(target: str, session: str, subject: Optional[str]) -> int:
    """An ended hosted session still holds its last screen, which often says why it ended."""
    if subject is None:
        print(f"Unknown project or session: {target}", file=sys.stderr, flush=True)
        return 2
    if not _is_tmux():
        try:
            print(session_host.capture(session), end="", flush=True)
        except SessionHostError:
            pass
    print(f"Session '{session}' for {subject} is not running.", file=sys.stderr, flush=True)
    return 1


def _has_pty(session: str) -> bool:
    if _is_tmux():
        return True
    return any(entry["name"] == session and entry.get("pty") for entry in session_host._call("list")["sessions"])


def _attach_command(session: str, read_only: bool) -> Tuple[List[str], Optional[Dict[str, str]]]:
    if _is_tmux():
        return ["tmux", "attach", *(["-r"] if read_only else []), "-t", session], None
    node = exe.node()
    script = str(ROOT_DIR / "scripts" / "ccdm-host.js")
    command = [node["command"], *node["args"], script, "attach", "-t", session, *(["-r"] if read_only else [])]
    return command, {**os.environ, **node["env"]}


def _detach_typed(seconds: float) -> bool:
    deadline = time.monotonic() + seconds
    while True:
        if sys.platform == "win32":
            while msvcrt.kbhit():
                if msvcrt.getwch() == _DETACH_KEY:
                    return True
        if time.monotonic() >= deadline:
            return False
        time.sleep(_KEY_POLL_S)


def _new_output(shown: str, text: str) -> str:
    if text.startswith(shown):
        return text[len(shown) :]
    anchor = shown[-_ANCHOR_CHARS:]
    at = text.find(anchor)
    return text[at + len(anchor) :] if at >= 0 else text


def _follow_output(session: str) -> int:
    print(f"Session '{session}' has no terminal screen; following its output. Ctrl-] leaves.", file=sys.stderr, flush=True)
    shown = ""
    ended = f"[session {session} ended]"
    try:
        while True:
            # Liveness first, so output written just before the end is still read.
            live = session_host.is_live(session)
            text = session_host.capture(session, history=True)
            sys.stdout.write(_new_output(shown, text))
            sys.stdout.flush()
            shown = text
            if not live:
                print(ended, file=sys.stderr, flush=True)
                return 0
            if _detach_typed(_FOLLOW_POLL_S):
                return 0
    except KeyboardInterrupt:
        return 0
    except SessionHostError as error:
        # Released while following: the session is over. Anything else means the host is gone.
        if error.code != "unknown_session":
            raise
        print(ended, file=sys.stderr, flush=True)
        return 0


def _run(args: argparse.Namespace) -> int:
    session, subject = _session(args.target, args.thread)
    if not _is_live(session):
        return _refuse(args.target, session, subject)
    if not _has_pty(session):
        return _follow_output(session)
    try:
        command, env = _attach_command(session, args.read_only)
    except exe.ToolNotFound as error:
        _fail(str(error), 1)
    try:
        return subprocess.call(command, env=env)
    except KeyboardInterrupt:
        return _INTERRUPTED


def register(subparsers: argparse._SubParsersAction) -> None:
    parser = subparsers.add_parser("attach", help="watch a live session; Ctrl-] leaves it running")
    parser.add_argument("target", help="a project, `root`, or a session name")
    parser.add_argument("--thread", help="a thread of the project, by id or link")
    parser.add_argument("--read-only", "-r", action="store_true", help="drop input and leave the window size alone")
    parser.set_defaults(func=_run)
