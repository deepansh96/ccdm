"""`ccdm session`: drive an ad-hoc session such as a login, on either session host.

`session send` takes its text as an argument only from a shell that keeps it
intact. Text from anywhere else comes through ``--stdin`` or ``--file``, because
``ccdm.cmd`` can run ``&`` and ``|`` in its arguments as commands.
"""

from __future__ import annotations

import argparse
import os
import re
import sys
import time
from pathlib import Path
from typing import Any, Callable, Dict, List, NamedTuple, NoReturn, Optional, Sequence, Tuple

from ..platform import exe, proc, session_host
from ..platform.session_host import SessionHostError
from ._detach import detach_if_self
from .list import fail

# Valid in JavaScript too: on ccdm-host the wait runs there.
_CONTEXT_GRID = r"Context Usage|tokens \(\d+%\)"
_CONTEXT_TIMEOUT_VARIABLE = "CCDM_SESSION_CONTEXT_TIMEOUT_MS"
_CONTEXT_TIMEOUT_MS = 15000
# A grid already on screen from an earlier /context would match at once.
CONTEXT_SETTLE_S = 1.0

_TRAILING_NEWLINE = re.compile(r"\r?\n\Z")
_NAME_VALUE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=", re.DOTALL)
_PROGRAMS_TO_RESOLVE: Dict[str, Callable[[], Dict[str, Any]]] = {"claude": exe.claude, "codex": exe.codex}

_SEND_USAGE = """\
usage: ccdm session send <name> [--literal] [<text>] [--enter]
       ccdm session send <name> (--stdin | --file <path>) [--enter]

Types into a session. Without --literal, <text> may be a key name such as C-c.
Put text that starts with - after --, or send it with --stdin or --file.
--stdin and --file read UTF-8, type it as it is and drop one trailing newline.
From PowerShell or cmd, use --stdin or --file for free text.
"""


class _SendRequest(NamedTuple):
    name: str
    text: Optional[str]
    literal: bool
    enter: bool


def _require_live(name: str) -> None:
    # An ended host session still answers capture.
    if not session_host.is_live(name):
        fail(f"session '{name}' is not running")


# --- new ----------------------------------------------------------------


def _parse_new(words: Sequence[str]) -> Tuple[argparse.Namespace, List[str]]:
    """The options before ``--``, and the program after it."""
    parser = argparse.ArgumentParser(
        prog="ccdm session new",
        usage="ccdm session new <name> [--cwd <dir>] [--env NAME=VALUE]... -- <program> [<arg>...]",
        description="Start an ad-hoc session, for example `claude auth login` or `codex login --device-auth`.",
    )
    parser.add_argument("name")
    parser.add_argument("--cwd", help="Where it runs; this directory when left out.")
    parser.add_argument("--env", action="append", default=[], metavar="NAME=VALUE", help="Set a variable for the program.")
    separator = words.index("--") if "--" in words else len(words)
    options = parser.parse_args(words[:separator])
    program = list(words[separator + 1 :])
    if not program:
        parser.error("name the program to run after --")
    for pair in options.env:
        if not _NAME_VALUE.match(pair):
            parser.error(f"--env needs NAME=VALUE, not {pair}")
    return options, program


def _resolved(program: List[str], env: Dict[str, str]) -> Tuple[List[str], Dict[str, str]]:
    """On Windows the host needs a real program; npm's codex is a .cmd. On POSIX the shell finds it."""
    resolve = _PROGRAMS_TO_RESOLVE.get(program[0]) if proc.WIN32 else None
    if resolve is None:
        return program, env
    try:
        tool = resolve()
    except exe.ToolNotFound as error:
        fail(str(error))
    return [tool["command"], *tool["args"], *program[1:]], {**tool["env"], **env}


def _new(args: argparse.Namespace) -> int:
    options, program = _parse_new(args.words)
    cwd = os.path.abspath(options.cwd or os.getcwd())
    if not os.path.isdir(cwd):
        fail(f"no such directory: {cwd}")
    env = dict(pair.split("=", 1) for pair in options.env)
    argv, session_env = _resolved(program, env)
    started = session_host.start(options.name, argv, cwd, session_env, pty=True, kind="adhoc")
    pid = started.get("pid")
    print(f"Started session '{options.name}'" + (f" (pid {pid})." if pid else "."))
    print(session_host.attach_hint(options.name))
    return 0


# --- capture ------------------------------------------------------------


def _capture(args: argparse.Namespace) -> int:
    _require_live(args.name)
    sys.stdout.write(session_host.capture(args.name, history=args.history, join=args.join))
    return 0


# --- send ---------------------------------------------------------------


def _send_usage_error(message: str) -> NoReturn:
    sys.stderr.write(f"{_SEND_USAGE}\nccdm session send: error: {message}\n")
    raise SystemExit(2)


def _free_text(from_stdin: bool, file_path: Optional[str]) -> str:
    try:
        data = sys.stdin.buffer.read() if from_stdin else Path(str(file_path)).read_bytes()
        text = data.decode("utf-8-sig")
    except (OSError, UnicodeDecodeError) as error:
        fail(f"could not read the text to send: {error}")
    return _TRAILING_NEWLINE.sub("", text, count=1)


# By hand: argparse before 3.12 gives an optional positional up when an option
# comes first, and the pinned form puts --literal before the text.
def _parse_send(words: Sequence[str]) -> _SendRequest:
    positional: List[str] = []
    literal = enter = from_stdin = False
    file_path: Optional[str] = None
    index = 0
    while index < len(words):
        word = words[index]
        index += 1
        if word == "--":
            positional.extend(words[index:])
            break
        if word in ("-h", "--help"):
            sys.stdout.write(_SEND_USAGE)
            raise SystemExit(0)
        if word == "--literal":
            literal = True
        elif word == "--enter":
            enter = True
        elif word == "--stdin":
            from_stdin = True
        elif word == "--file":
            if index == len(words):
                _send_usage_error("--file needs a path")
            file_path = words[index]
            index += 1
        elif word.startswith("-") and word != "-":
            _send_usage_error(f"unknown option {word}")
        else:
            positional.append(word)
    if not positional:
        _send_usage_error("name the session")
    if len(positional) > 2:
        _send_usage_error("give the text as one argument")
    text = positional[1] if len(positional) == 2 else None
    if (text is not None) + from_stdin + (file_path is not None) > 1:
        _send_usage_error("give the text one way only")
    if text is None and not from_stdin and file_path is None and not enter:
        _send_usage_error("nothing to send")
    if from_stdin or file_path is not None:
        return _SendRequest(positional[0], _free_text(from_stdin, file_path), True, enter)
    return _SendRequest(positional[0], text, literal, enter)


def _send(args: argparse.Namespace) -> int:
    request = _parse_send(args.words)
    _require_live(request.name)
    if request.text:
        # tmux would read a leading - as one of its own flags.
        if request.literal or request.text.startswith("-"):
            session_host.send_text(request.name, request.text)
        else:
            session_host.send_key(request.name, request.text)
    if request.enter:
        session_host.send_key(request.name, "Enter")
    return 0


# --- kill ---------------------------------------------------------------


def _kill(args: argparse.Namespace) -> int:
    detach_if_self(args.name)
    if not session_host.stop(args.name)["stopped"]:
        fail(f"no session named '{args.name}'")
    print(f"Killed session '{args.name}'.")
    return 0


# --- context ------------------------------------------------------------


def send_context_command(name: str) -> None:
    session_host.send_text(name, "/context")
    session_host.send_key(name, "Enter")


def context_screen(name: str) -> str:
    """The screen once the context grid is on it. Raises SessionHostError if it never comes."""
    configured = os.environ.get(_CONTEXT_TIMEOUT_VARIABLE, "")
    timeout_ms = int(configured) if configured.isdigit() else _CONTEXT_TIMEOUT_MS
    result = session_host.wait_for(name, _CONTEXT_GRID, timeout_ms)
    if not result.get("matched"):
        raise SessionHostError("timeout", f"session '{name}' did not show its context within {timeout_ms} ms")
    return str(result.get("screen") or "")


def print_screen(screen: str) -> None:
    sys.stdout.write(screen if screen.endswith("\n") else f"{screen}\n")


def _context(args: argparse.Namespace) -> int:
    _require_live(args.name)
    send_context_command(args.name)
    time.sleep(CONTEXT_SETTLE_S)
    print_screen(context_screen(args.name))
    return 0


# --- the parsers --------------------------------------------------------


def _hand_parsed(
    verbs: argparse._SubParsersAction, name: str, help_text: str, handler: Callable[[argparse.Namespace], int]
) -> None:
    # Every word reaches the handler, `--` included.
    parser = verbs.add_parser(name, help=help_text, add_help=False, prefix_chars="\0")
    parser.add_argument("words", nargs=argparse.REMAINDER)
    parser.set_defaults(func=handler)


def register(subparsers: argparse._SubParsersAction) -> None:
    parser = subparsers.add_parser("session", help="Start, read, type into or end an ad-hoc session.")
    verbs = parser.add_subparsers(title="commands", metavar="<command>", dest="session_command", required=True)

    _hand_parsed(verbs, "new", "Start an ad-hoc session: new <name> [--cwd D] -- <program> [args].", _new)

    capture = verbs.add_parser("capture", help="Print a session's screen.")
    capture.add_argument("name")
    capture.add_argument("--join", action="store_true", help="Unwrap wrapped lines, so a long URL comes back whole.")
    capture.add_argument("--history", action="store_true", help="Include the scrollback.")
    capture.set_defaults(func=_capture)

    _hand_parsed(verbs, "send", "Type into a session: send <name> [--literal] <text> [--enter], or --stdin, --file.", _send)

    kill = verbs.add_parser("kill", help="End a session.")
    kill.add_argument("name")
    kill.set_defaults(func=_kill)

    context = verbs.add_parser("context", help="Send /context to a Claude session and print its context screen.")
    context.add_argument("name")
    context.set_defaults(func=_context)
