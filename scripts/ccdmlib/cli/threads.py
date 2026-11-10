"""`ccdm threads list|create|stop|restart|close`: the operator's Thread Conversation commands.

The commands themselves are scripts/thread_supervisor/threads_cli.py, which asks the
running Thread Supervisor over its private control channel. On macOS and Linux
scripts/threads.sh runs this subcommand, and the messages keep that name.

A lifecycle command hands off to a detached copy before it stops its own session.
This one does not: the supervisor makes every change in its own process, so a
`stop`, `restart` or `close` run inside the thread it names is carried out even
though the caller ends with that session.
"""

from __future__ import annotations

import argparse
from typing import Any, List


def _run(args: argparse.Namespace) -> int:
    from thread_supervisor import threads_cli

    argv: List[str] = list(args.argv)
    if argv in (["--help"], ["-h"]):
        print(threads_cli.USAGE, flush=True)
        return 0
    return int(threads_cli.main(argv))


def register(subparsers: Any) -> None:
    # Nothing here is an option to argparse: a message may hold any word, and bad usage keeps exit 2 and its own text.
    parser = subparsers.add_parser(
        "threads", help="List, create, stop, restart or close Thread Conversations.", add_help=False, prefix_chars="\0"
    )
    parser.add_argument("argv", nargs=argparse.REMAINDER)
    parser.set_defaults(func=_run)
