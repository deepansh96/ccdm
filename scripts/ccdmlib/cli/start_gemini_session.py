"""``ccdm start-gemini-session``: starts a Gemini project's Discord session.

The launcher is still ``scripts/start-gemini-session.sh``: ``gemini-bridge.js`` in
tmux, driving ``agy acp``. This command runs it on macOS and Linux, so that
``ccdm restart-session`` and the operator reach a Gemini project the same way as
the others. The Gemini bridge has not been ported to Windows, where the command
refuses.
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path
from typing import Any

_COMMAND = "start-gemini-session"
_LAUNCHER = Path(__file__).resolve().parents[2] / "start-gemini-session.sh"


def _command(args: argparse.Namespace) -> int:
    if sys.platform == "win32":
        print("ccdm: Gemini sessions are not supported on Windows yet", file=sys.stderr)
        return 1
    argv = [str(_LAUNCHER), *args.arguments]
    sys.stdout.flush()
    sys.stderr.flush()
    os.execv(argv[0], argv)
    return 1  # not reached


def register(subparsers: Any) -> None:
    # The launcher checks its own arguments, so they pass through untouched.
    parser = subparsers.add_parser(_COMMAND, help="start a Gemini project's session (macOS and Linux)",
                                   add_help=False, prefix_chars="\x01")
    parser.add_argument("arguments", nargs=argparse.REMAINDER)
    parser.set_defaults(func=_command)
