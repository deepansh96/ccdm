#!/usr/bin/env python3
"""Resolve the home a project's Gemini (agy) session runs under.

agy keeps its sign-in and data under ``$HOME/.gemini`` (and, with no
Keychain at that home, a token file there), so a second Google account is a
second home folder: ``gemini_accounts`` maps an alias to one, such as
``{"agy-main": "~", "agy-work": "~/.agy-work"}``. A thread's ``--account``
wins, then the project's ``gemini_account``; with neither, agy runs under the
user's own home.

Usage: resolve-gemini-home.py <registry.json> <project> [--account <alias>]
Prints the absolute home; exits 1 with the reason as the last stderr line.
"""

from __future__ import annotations

import json
import os
import re
import sys
from typing import Any

# The home goes into the session's tmux shell command, so only plain paths pass.
UNSAFE = re.compile(r"[\s'\"$`\\]")


class ResolverError(Exception):
    """An actionable configuration failure."""


def gemini_accounts(registry: dict[str, Any]) -> dict[str, str]:
    accounts = registry.get("gemini_accounts")
    if accounts is None:
        return {}
    if not isinstance(accounts, dict):
        raise ResolverError("gemini_accounts must be an object mapping account aliases to home paths")
    for alias, home in accounts.items():
        if not isinstance(alias, str) or not alias.strip():
            raise ResolverError("gemini_accounts must use non-empty alias names")
        if not isinstance(home, str) or not home.strip():
            raise ResolverError(f"gemini_accounts['{alias}'] must be a non-empty home path")
    return accounts


def expand(path: str) -> str:
    return os.path.normpath(os.path.expanduser(path))


def validate_home(raw: str, label: str) -> str:
    home = expand(raw)
    if not os.path.isabs(home) or UNSAFE.search(home):
        raise ResolverError(f"{label} home '{raw}' must be a plain absolute path")
    if not os.path.isdir(home):
        raise ResolverError(f"{label} home '{raw}' is missing; sign in there first with: HOME={home} agy")
    return home


def resolve_gemini_home(registry: dict[str, Any], project: str, account: str | None = None) -> str:
    projects = registry.get("projects")
    entry = projects.get(project) if isinstance(projects, dict) else None
    if not isinstance(entry, dict):
        raise ResolverError(f"project '{project}' is not present in registry.json")
    accounts = gemini_accounts(registry)
    label = "thread account"
    if account is None:
        account = entry.get("gemini_account")
        label = f"project '{project}' gemini_account"
        if account is not None and (not isinstance(account, str) or not account.strip()):
            raise ResolverError(f"{label} must be a non-empty alias")
    if account is None:
        return expand("~")
    if account not in accounts:
        raise ResolverError(f"{label} '{account}' is not an alias in gemini_accounts")
    return validate_home(accounts[account], f"Gemini account '{account}'")


def main(argv: list[str]) -> int:
    account = None
    if len(argv) == 5 and argv[3] == "--account":
        account = argv[4]
    elif len(argv) != 3:
        print(f"Usage: {argv[0]} <registry.json> <project> [--account <alias>]", file=sys.stderr)
        return 2
    try:
        with open(argv[1], encoding="utf-8") as source:
            registry = json.load(source)
        if not isinstance(registry, dict):
            raise ResolverError("registry.json must contain a JSON object")
        print(resolve_gemini_home(registry, argv[2], account))
        return 0
    except (OSError, ValueError, ResolverError) as error:
        print(str(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
