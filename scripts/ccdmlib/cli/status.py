"""`ccdm status [<project>]`: the `list` fields plus ``session_id``, for one project or all."""

from __future__ import annotations

import argparse

from .list import FIELDS, print_rows, project_rows


def _run(args: argparse.Namespace) -> int:
    print_rows(project_rows(args.project), (*FIELDS, "session_id"), args.as_json)
    return 0


def register(subparsers: argparse._SubParsersAction) -> None:
    parser = subparsers.add_parser("status", help="Show a project's session, process and conversation id.")
    parser.add_argument("project", nargs="?", help="One project; every project when left out.")
    parser.add_argument("--json", dest="as_json", action="store_true", help="Print a JSON array, even for one project.")
    parser.set_defaults(func=_run)
