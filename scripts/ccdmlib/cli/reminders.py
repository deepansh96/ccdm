"""`ccdm reminders`: run the Conversation Reminder service's operator commands.

Python is named explicitly, because Windows does not honour the script's shebang.
"""

from __future__ import annotations

import argparse
import subprocess
from pathlib import Path

from ..platform import exe
from .list import fail

_SERVICE = Path(__file__).resolve().parents[2] / "conversation-reminder-service.py"


def _assignment_changed(args: argparse.Namespace) -> int:
    try:
        python = exe.python()
        completed = subprocess.run([*python, str(_SERVICE), "assignment-changed", "--project", args.project])
    except exe.ToolNotFound as error:
        fail(str(error))
    except OSError as error:
        fail(f"could not run the reminder service: {error}")
    # A negative code means a signal ended it, which the shell reports as 128 + N.
    return completed.returncode if completed.returncode >= 0 else 128 - completed.returncode


def register(subparsers: argparse._SubParsersAction) -> None:
    parser = subparsers.add_parser("reminders", help="Run a Conversation Reminder operator command.")
    verbs = parser.add_subparsers(title="commands", metavar="<command>", dest="reminders_command", required=True)
    changed = verbs.add_parser(
        "assignment-changed", help="Issue a new reminder assignment after a project is registered or removed."
    )
    changed.add_argument("--project", required=True)
    changed.set_defaults(func=_assignment_changed)
