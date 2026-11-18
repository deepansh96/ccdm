"""The `ccdm` command line: every subcommand is one module in this package.

A module, or a package such as ``services``, joins the command by defining
``register(subparsers)``, which adds its parser and sets a handler with
``parser.set_defaults(func=handler)``. ``handler(args)`` returns the exit code;
None means 0. Nothing here changes when a subcommand is added. Names starting
with ``_`` are helpers and are skipped.

``CCDM_CLI_TEST_MODULES``, unset in production, names one more directory to
search, for test fixtures.
"""

from __future__ import annotations

import argparse
import importlib
import os
import pkgutil
import sys
from types import ModuleType
from typing import List, Optional, Sequence

from ..platform.session_host import SessionHostError

_TEST_MODULES = "CCDM_CLI_TEST_MODULES"


def _load_modules() -> List[ModuleType]:
    fixtures = os.environ.get(_TEST_MODULES)
    if fixtures and fixtures not in __path__:
        __path__.append(fixtures)
    names = sorted(info.name for info in pkgutil.iter_modules(__path__) if not info.name.startswith("_"))
    modules = []
    for name in names:
        try:
            modules.append(importlib.import_module(f"{__name__}.{name}"))
        except Exception as error:  # One broken subcommand must not take away the others.
            print(f"ccdm: skipping subcommand module {name}: {error!r}", file=sys.stderr)
    return modules


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="ccdm", description="Manage CCDM sessions and services.")
    subparsers = parser.add_subparsers(title="commands", metavar="<command>")
    for module in _load_modules():
        register = getattr(module, "register", None)
        if callable(register):
            register(subparsers)
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    handler = getattr(args, "func", None)
    if handler is None:
        parser.print_help(sys.stderr)
        return 2
    try:
        return handler(args) or 0
    except SessionHostError as error:
        print(f"ccdm: {error}", file=sys.stderr)
        return 1
