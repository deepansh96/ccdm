"""`threads.sh`: operator commands for Thread Conversations, through the
Thread Supervisor's control socket. `stop`, `restart` and `close` find their
thread by name, link or id through the conversation resolver. Exit 2 is a
request that did nothing (bad usage, an unknown flag, a validation failure,
or a thread the resolver cannot name), 1 any other failure, such as no
supervisor answering."""

from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys

from . import control, creation
from .paths import default_state_dir


USAGE = ("usage: threads.sh create <project> <name> [--provider claude|codex] [--account <alias>] "
         "[--model <model>] [--effort <effort>] [message…]\n"
         "       threads.sh list [<project>]\n"
         "       threads.sh stop|restart|close [<project>] <name|link|id>")
RESOLVER = Path(__file__).resolve().parent.parent / "conversation-resolver.js"
THREAD_OPS = {"stop": "stop_thread", "restart": "restart_thread", "close": "close_thread"}


def _refuse(message: str) -> int:
    print(f"threads.sh: {message}", file=sys.stderr)
    return 2


def _request(payload: dict) -> dict | None:
    """The supervisor's answer, or None (with the reason said) when none answers."""
    try:
        return control.request(default_state_dir(), payload)
    except (OSError, ValueError) as error:
        print(f"threads.sh: the thread supervisor is not reachable: {error}", file=sys.stderr)
        return None


def _failed(response: dict) -> int:
    error = response.get("error") or {}
    print(f"threads.sh: {error.get('message') or error.get('code')}", file=sys.stderr)
    return 2 if error.get("code") == "invalid" else 1


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
    response = _request(payload)
    if response is None:
        return 1
    if response.get("ok"):
        print(json.dumps(response.get("result"), sort_keys=True))
        return 0
    return _failed(response)


def _idle(seconds: int) -> str:
    for unit, size in (("d", 86400), ("h", 3600), ("m", 60)):
        if seconds >= size:
            return f"{seconds // size}{unit}"
    return f"{seconds}s"


def list_threads(argv: list[str]) -> int:
    if len(argv) > 1:
        return _refuse(USAGE)
    response = _request({"op": "list", "project": argv[0] if argv else None})
    if response is None:
        return 1
    if not response.get("ok"):
        return _failed(response)
    table = [("PROJECT", "NAME", "THREAD", "PROVIDER/MODEL", "STATE", "IDLE")]
    for thread in (response.get("result") or {}).get("threads") or []:
        state = f"{thread['state']}/{thread['reason']}" if thread.get("reason") else thread["state"]
        table.append((thread["project"], thread["name"], thread["thread_id"],
                      f"{thread['provider']}/{thread.get('model') or '-'}", state, _idle(thread["idle_seconds"])))
    widths = [max(len(row[column]) for row in table) for column in range(len(table[0]))]
    for row in table:
        print("  ".join(value.ljust(width) for value, width in zip(row, widths)).rstrip())
    return 0


def _resolve(project: str | None, target: str) -> dict | None:
    """The thread ``target`` names, through the conversation resolver; None (with its reason said) otherwise."""
    node = os.environ.get("CCDM_ROUTER_NODE") or "node"
    args = [node, str(RESOLVER), *(["--project", project] if project else []), target]
    try:
        completed = subprocess.run(args, capture_output=True, text=True, stdin=subprocess.DEVNULL)
    except OSError as error:
        print(f"threads.sh: the conversation resolver could not run: {error}", file=sys.stderr)
        return None
    if completed.returncode != 0:
        sys.stderr.write(completed.stderr or f"threads.sh: the conversation resolver exited {completed.returncode}\n")
        return None
    conversation = json.loads(completed.stdout)
    if not conversation.get("thread_id"):
        print(f"threads.sh: '{target}' is the channel of project '{conversation['project']}', not a thread",
              file=sys.stderr)
        return None
    return conversation


def thread_op(command: str, argv: list[str]) -> int:
    if len(argv) not in (1, 2):
        return _refuse(USAGE)
    project, target = (argv[0], argv[1]) if len(argv) == 2 else (None, argv[0])
    conversation = _resolve(project, target)
    if conversation is None:
        return 2
    response = _request({"op": THREAD_OPS[command], "thread_id": conversation["thread_id"]})
    if response is None:
        return 1
    if not response.get("ok"):
        return _failed(response)
    result = response.get("result") or {}
    thread = f"thread '{result['name']}' ({result['thread_id']}) in '{result['project']}'"
    if command == "stop":
        print(f"Stopped {thread}" if result.get("stopped") else f"No running session in {thread} ({result['state']})")
    else:
        print(f"{'Restarting' if command == 'restart' else 'Closing'} {thread}")
    return 0


def main(argv: list[str]) -> int:
    if argv[:1] == ["create"]:
        return create(argv[1:])
    if argv[:1] == ["list"]:
        return list_threads(argv[1:])
    if argv[:1] and argv[0] in THREAD_OPS:
        return thread_op(argv[0], argv[1:])
    return _refuse(USAGE)
