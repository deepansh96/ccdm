"""`ccdm context report`: the context screen of every live local Claude project session."""

from __future__ import annotations

import argparse
import sys
import time
from typing import Any, Dict, List

from ..platform.session_host import SessionHostError
from .list import project_rows
from .session import CONTEXT_SETTLE_S, context_screen, print_screen, send_context_command


def _targets() -> List[Dict[str, Any]]:
    return [
        row
        for row in project_rows()
        if row["state"] == "live" and row["type"] == "claude" and not row["path"].startswith("remote:")
    ]


def _report_failure(row: Dict[str, Any], error: SessionHostError) -> None:
    print(f"ccdm: {row['project']}: {error}", file=sys.stderr, flush=True)


def _report(_args: argparse.Namespace) -> int:
    targets = _targets()
    if not targets:
        print("No live Claude sessions.")
        return 0
    # Every session first, so they fill their screens side by side.
    sent = []
    for row in targets:
        try:
            send_context_command(row["screen_name"])
        except SessionHostError as error:
            _report_failure(row, error)
        else:
            sent.append(row)
    if sent:
        time.sleep(CONTEXT_SETTLE_S)
    shown = 0
    for row in sent:
        try:
            screen = context_screen(row["screen_name"])
        except SessionHostError as error:
            _report_failure(row, error)
            continue
        print(f"=== {row['project']} ({row['screen_name']}) ===", flush=True)
        print_screen(screen)
        shown += 1
    return 0 if shown == len(targets) else 1


def register(subparsers: argparse._SubParsersAction) -> None:
    parser = subparsers.add_parser("context", help="Report on the context the sessions are using.")
    verbs = parser.add_subparsers(title="commands", metavar="<command>", dest="context_command", required=True)
    report = verbs.add_parser("report", help="Print the context screen of every live Claude session.")
    report.set_defaults(func=_report)
