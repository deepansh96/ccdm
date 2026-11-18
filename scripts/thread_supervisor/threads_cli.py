"""`threads.sh`, and `scripts/ccdm threads` on Windows: operator commands for
Thread Conversations, through the Thread Supervisor's control socket (an
authenticated pipe on Windows). `stop`, `restart` and `close` find their
thread by name, link or id through the conversation resolver. Exit 2 is a
request that did nothing (bad usage, an unknown flag, a validation failure,
or a thread the resolver cannot name), 1 any other failure, such as no
supervisor answering.

`create` takes its first message as the words after the flags, from stdin
(`--message-stdin`) or from a UTF-8 file (`--message-file <path>`). Free text
must not travel as arguments through `ccdm.cmd`, where `&` and `|` can run as
commands, so the Windows usage names only the last two.

Every change is made by the supervisor, in its own process. A command that
stops or restarts the thread it runs in is ended with that session, after
the supervisor has taken the request, so nothing is handed to a detached copy."""

from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys

from ccdmlib.platform import exe

from . import control, creation
from .paths import default_state_dir


WIN32 = sys.platform == "win32"
# How the operator runs this: the shim on macOS and Linux, the `ccdm` subcommand on Windows.
COMMAND = "scripts/ccdm threads" if WIN32 else "threads.sh"
PREFIX = "ccdm threads" if WIN32 else "threads.sh"
MESSAGE_STDIN = "--message-stdin"
MESSAGE_FILE = "--message-file"
MESSAGE_FORM = f"[{MESSAGE_STDIN}|{MESSAGE_FILE} <path>]" if WIN32 else "[message…]"
USAGE = (f"usage: {COMMAND} create <project> <name> [--provider claude|codex] [--account <alias>] "
         f"[--model <model>] [--effort <effort>] {MESSAGE_FORM}\n"
         f"       {COMMAND} list [<project>]\n"
         f"       {COMMAND} stop|restart|close [<project>] <name|link|id>")
RESOLVER = Path(__file__).resolve().parent.parent / "conversation-resolver.js"
THREAD_OPS = {"stop": "stop_thread", "restart": "restart_thread", "close": "close_thread"}


def _refuse(message: str) -> int:
    print(f"{PREFIX}: {message}", file=sys.stderr)
    return 2


def _request(payload: dict) -> dict | None:
    """The supervisor's answer, or None (with the reason said) when none answers."""
    try:
        return control.request(default_state_dir(), payload)
    except (OSError, ValueError) as error:
        print(f"{PREFIX}: the thread supervisor is not reachable: {error}", file=sys.stderr)
        return None


def _failed(response: dict) -> int:
    error = response.get("error") or {}
    print(f"{PREFIX}: {error.get('message') or error.get('code')}", file=sys.stderr)
    return 2 if error.get("code") == "invalid" else 1


def _message_from(source: str, path: str | None) -> str:
    """The first message read from stdin or from ``path``, as UTF-8. Raises OSError or ValueError."""
    if source == MESSAGE_STDIN:
        return sys.stdin.buffer.read().decode("utf-8-sig")
    return Path(path).read_bytes().decode("utf-8-sig")


def create(argv: list[str]) -> int:
    if len(argv) < 2:
        return _refuse(USAGE)
    project, name, rest = argv[0], argv[1], argv[2:]
    flags = {}
    source = path = None
    while rest and rest[0].startswith("--"):
        if rest[0] in (MESSAGE_STDIN, MESSAGE_FILE):
            if source:
                return _refuse(f"{MESSAGE_STDIN} and {MESSAGE_FILE} give the first message once")
            source = rest[0]
            if source == MESSAGE_FILE:
                if len(rest) < 2:
                    return _refuse(f"{rest[0]} needs a value")
                path, rest = rest[1], rest[1:]
            rest = rest[1:]
            continue
        flag = rest[0][2:]
        if flag not in creation.FLAGS:
            return _refuse(f"unknown flag {rest[0]}")
        if len(rest) < 2:
            return _refuse(f"{rest[0]} needs a value")
        flags[flag], rest = rest[1], rest[2:]
    first_message = " ".join(rest)
    if source:
        if rest:
            return _refuse(f"{source} gives the first message, so no message words may follow it")
        try:
            first_message = _message_from(source, path)
        except (OSError, ValueError) as error:
            return _refuse(f"the first message could not be read: {error}")
    payload = {"op": "create", "project": project, "name": name, "flags": flags,
               "first_message": first_message.strip() or None}
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
    try:
        # Windows finds Node as the launchers do; elsewhere the name is looked up on PATH as before.
        node = exe.node()["command"] if WIN32 else os.environ.get("CCDM_ROUTER_NODE") or "node"
        args = [node, str(RESOLVER), *(["--project", project] if project else []), target]
        completed = subprocess.run(args, capture_output=True, encoding="utf-8", stdin=subprocess.DEVNULL)
    except OSError as error:
        print(f"{PREFIX}: the conversation resolver could not run: {error}", file=sys.stderr)
        return None
    if completed.returncode != 0:
        sys.stderr.write(completed.stderr or f"{PREFIX}: the conversation resolver exited {completed.returncode}\n")
        return None
    conversation = json.loads(completed.stdout)
    if not conversation.get("thread_id"):
        print(f"{PREFIX}: '{target}' is the channel of project '{conversation['project']}', not a thread",
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
