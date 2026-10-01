"""`threads.sh`: operator commands for Thread Conversations, through the
Thread Supervisor's control socket. Exit 2 is a request that created nothing
(bad usage, an unknown flag, or a validation failure), 1 any other failure."""

from __future__ import annotations

import json
import sys

from . import control, creation
from .paths import default_state_dir


USAGE = ("usage: threads.sh create <project> <name> [--provider claude|codex] [--account <alias>] "
         "[--model <model>] [--effort <effort>] [message…]")


def _refuse(message: str) -> int:
    print(f"threads.sh: {message}", file=sys.stderr)
    return 2


def create(argv: list[str]) -> int:
    if len(argv) < 2:
        return _refuse(USAGE)
    project, name, rest = argv[0], argv[1], argv[2:]
    flags = {}
    while rest and rest[0].startswith("--"):
        flag = rest[0][2:]
        if flag not in creation.FLAGS:
            return _refuse(f"unknown flag {rest[0]}")
        if len(rest) < 2:
            return _refuse(f"{rest[0]} needs a value")
        flags[flag], rest = rest[1], rest[2:]
    payload = {"op": "create", "project": project, "name": name, "flags": flags,
               "first_message": " ".join(rest).strip() or None}
    try:
        response = control.request(default_state_dir(), payload)
    except (OSError, ValueError) as error:
        print(f"threads.sh: the thread supervisor is not reachable: {error}", file=sys.stderr)
        return 1
    if response.get("ok"):
        print(json.dumps(response.get("result"), sort_keys=True))
        return 0
    error = response.get("error") or {}
    print(f"threads.sh: {error.get('message') or error.get('code')}", file=sys.stderr)
    return 2 if error.get("code") == "invalid" else 1


def main(argv: list[str]) -> int:
    if argv[:1] == ["create"]:
        return create(argv[1:])
    return _refuse(USAGE)
