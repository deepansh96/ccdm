"""`ccdm reminders`: run the Conversation Reminder service's operator commands.

Python is named explicitly, because Windows does not honour the script's shebang.
"""

from __future__ import annotations

import argparse
import subprocess
from pathlib import Path
from typing import List

from ..platform import exe
from .list import fail

_SERVICE = Path(__file__).resolve().parents[2] / "conversation-reminder-service.py"

# The operator's verbs that take no argument, each passed to the service as it is.
_PLAIN_VERBS = (
    ("preflight", "Check whether reminders can be enabled, changing nothing."),
    ("enable", "Opt in to reminders once every check passes."),
    ("status", "Show the worker, each project's readiness and its conversations."),
    ("run", "Run the reminder worker here until reminders are disabled."),
    ("disable", "Opt out; a running worker stops by itself."),
    ("discover", "Ask the worker to scan older conversations again."),
    ("recover", "Resolve a send left uncertain, while no worker runs."),
)


def _service(arguments: List[str]) -> int:
    try:
        python = exe.python()
        child = subprocess.Popen([*python, str(_SERVICE), *arguments])
    except exe.ToolNotFound as error:
        fail(str(error))
    except OSError as error:
        fail(f"could not run the reminder service: {error}")
    try:
        code = child.wait()
    except KeyboardInterrupt:
        # Ctrl+C reached the service too; let it stop its observer.
        try:
            child.wait(timeout=35)
        except (subprocess.TimeoutExpired, KeyboardInterrupt):
            child.kill()
            child.wait()
        return 130
    # A negative code means a signal ended it, which the shell reports as 128 + N.
    return code if code >= 0 else 128 - code


def _assignment_changed(args: argparse.Namespace) -> int:
    return _service(["assignment-changed", "--project", args.project])


def _plain(args: argparse.Namespace) -> int:
    return _service([args.reminders_command])


def register(subparsers: argparse._SubParsersAction) -> None:
    parser = subparsers.add_parser("reminders", help="Run a Conversation Reminder operator command.")
    verbs = parser.add_subparsers(title="commands", metavar="<command>", dest="reminders_command", required=True)
    for name, text in _PLAIN_VERBS:
        verbs.add_parser(name, help=text).set_defaults(func=_plain)
    changed = verbs.add_parser(
        "assignment-changed", help="Issue a new reminder assignment after a project is registered or removed."
    )
    changed.add_argument("--project", required=True)
    changed.set_defaults(func=_assignment_changed)
