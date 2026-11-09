"""`ccdm send-claude-command <target> <compact|clear>`: type a slash command into a Claude session.

The target is a project, or a channel id, thread id, Discord link or thread name
that scripts/conversation-resolver.js can name. A thread's command goes to the
thread's own session, ``<screen>-t-<thread id>``. A target nothing can name exits
2 with the resolver's reason.

The channel server runs this from inside the session it types into, so it never
hands off to a detached copy the way lifecycle commands do: its exit code is the
answer the channel relays to the owner.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Dict, NamedTuple, NoReturn, Optional, Sequence, Tuple

from ..platform import exe, proc, session_host
from ..platform.session_host import SessionHostError

ROOT_DIR = Path(__file__).resolve().parents[3]
REGISTRY = ROOT_DIR / "registry.json"

_NAME = "send-claude-command"
_COMMANDS = {"compact": "/compact", "/compact": "/compact", "clear": "/clear", "/clear": "/clear"}
# No host, or no tmux: nothing can be running.
_NOTHING_RUNNING = ("not_running", "spawn_failed")
# A reader can meet registry.json in the moment it is being replaced on Windows.
_REGISTRY_READ_BUDGET_S = 2.0
_REGISTRY_READ_POLL_S = 0.05


class _Target(NamedTuple):
    project: str
    session: str
    session_type: str
    path: str
    channel_id: str
    thread_id: str


def _fail(message: str, code: int = 2) -> NoReturn:
    print(message, file=sys.stderr, flush=True)
    raise SystemExit(code)


def _session_word() -> str:
    return "session" if proc.WIN32 else "tmux session"


def _usage() -> str:
    script = f"scripts/ccdm {_NAME}" if proc.WIN32 else f"scripts/{_NAME}.sh"
    return "\n".join((
        "Usage:",
        f"  {script} <project|channel_id|thread_id|link> <compact|clear|/compact|/clear>",
        f"  {script} --project <project> <compact|clear|/compact|/clear>",
        f"  {script} --channel <channel_id|thread_id|link> <compact|clear|/compact|/clear>",
    ))


def _word(argv: Sequence[str], index: int) -> str:
    return argv[index] if len(argv) > index else ""


def _parse(argv: Sequence[str]) -> Tuple[str, str, str]:
    """The mode, target and requested command."""
    first = _word(argv, 0)
    if first in ("--project", "-p"):
        return "project", _word(argv, 1), _word(argv, 2)
    if first in ("--channel", "-c"):
        return "channel", _word(argv, 1), _word(argv, 2)
    return "auto", first, _word(argv, 1)


def _read_registry() -> str:
    deadline = time.monotonic() + _REGISTRY_READ_BUDGET_S
    while True:
        try:
            return REGISTRY.read_text(encoding="utf-8")
        except PermissionError:
            if not proc.WIN32 or time.monotonic() >= deadline:
                raise
            time.sleep(_REGISTRY_READ_POLL_S)


def _projects() -> Dict[str, Any]:
    try:
        return json.loads(_read_registry()).get("projects", {})
    except FileNotFoundError:
        _fail(f"registry.json not found at {REGISTRY}")
    except json.JSONDecodeError as error:
        _fail(f"registry.json is invalid JSON: {error}")


def _in_registry(projects: Dict[str, Any], mode: str, target: str) -> Optional[Tuple[str, Dict[str, Any], str]]:
    """The named project with no thread, or None when only the resolver can name it."""
    if mode in ("auto", "project") and target in projects:
        return target, projects[target], ""
    if mode in ("auto", "channel"):
        matches = [(name, entry) for name, entry in projects.items() if str(entry.get("channel_id", "")) == target]
        if len(matches) > 1:
            _fail(f"Channel {target} matches multiple projects: {', '.join(name for name, _ in matches)}")
        if matches:
            return matches[0][0], matches[0][1], ""
    if mode == "project":
        _fail(f"Unknown project: {target}")
    return None


def _resolved(projects: Dict[str, Any], target: str) -> Tuple[str, Dict[str, Any], str]:
    """The project and thread the resolver names. Its reason for refusing reaches stderr as it wrote it."""
    try:
        node = exe.node()
        completed = subprocess.run(
            [node["command"], *node["args"], str(ROOT_DIR / "scripts" / "conversation-resolver.js"), target],
            env={**os.environ, **node["env"], "CCDM_REGISTRY_PATH": str(REGISTRY)},
            stdout=subprocess.PIPE,
            encoding="utf-8",
        )
    except (exe.ToolNotFound, OSError) as error:
        _fail(str(error))
    if completed.returncode != 0:
        raise SystemExit(2)
    conversation = json.loads(completed.stdout)
    name = conversation["project"]
    entry = projects.get(name)
    if entry is None:
        _fail(f"Unknown project: {name}")
    thread_id = conversation.get("thread_id") or ""
    if thread_id:
        entry = {**entry, "type": conversation.get("provider") or entry.get("type", "claude")}
    return name, entry, thread_id


def _target(mode: str, target: str) -> _Target:
    projects = _projects()
    name, entry, thread_id = _in_registry(projects, mode, target) or _resolved(projects, target)
    screen = entry.get("screen_name")
    if not screen:
        _fail(f"Project {name} has no screen_name in registry.json")
    return _Target(
        name,
        f"{screen}-t-{thread_id}" if thread_id else screen,
        entry.get("type", "claude"),
        str(entry.get("path", "")),
        str(entry.get("channel_id", "")),
        thread_id,
    )


def _is_live(session: str) -> bool:
    try:
        return session_host.is_live(session)
    except SessionHostError as error:
        if error.code in _NOTHING_RUNNING:
            return False
        raise


def _run(args: argparse.Namespace) -> int:
    argv = args.argv
    if not argv or argv[0] in ("--help", "-h", ""):
        print(_usage())
        return 0
    mode, requested_target, requested_command = _parse(argv)
    if not requested_target or not requested_command:
        _fail(_usage())
    command = _COMMANDS.get(requested_command)
    if command is None:
        _fail(f"Unsupported command '{requested_command}'. Allowed commands: /compact, /clear.")

    target = _target(mode, requested_target)
    if target.thread_id:
        subject = f"thread {target.thread_id} in project '{target.project}'"
        subject_start = f"Thread {target.thread_id} in project '{target.project}'"
        own_channel = "thread"
    else:
        subject = f"project '{target.project}'"
        subject_start = f"Project '{target.project}'"
        own_channel = "project channel"
    word = _session_word()

    if target.session_type != "claude":
        _fail(
            f"{subject_start} is type '{target.session_type}', not 'claude'. "
            f"Codex sessions handle /compact and /clear directly in their {own_channel}.",
            1,
        )
    if target.path.startswith("remote:"):
        _fail(f"{subject_start} is remote ({target.path}). Run {command} on the remote {word} instead.", 1)
    if not _is_live(target.session):
        _fail(f"Claude {word} '{target.session}' for {subject} is not running.", 1)

    try:
        session_host.send_text(target.session, command)
        session_host.send_key(target.session, "Enter")
    except SessionHostError as error:
        _fail(str(error), 1)

    where = f"{word} '{target.session}'"
    if not target.thread_id:
        where += f", channel '{target.channel_id}'"
    print(f"Sent {command} to Claude {subject} ({where}).", flush=True)
    return 0


def register(subparsers: argparse._SubParsersAction) -> None:
    # No option syntax: every word is positional, so usage errors keep exit 2 and today's text.
    parser = subparsers.add_parser(
        _NAME, help="Type /compact or /clear into a project's or thread's Claude session.", add_help=False, prefix_chars="\0"
    )
    parser.add_argument("argv", nargs="*")
    parser.set_defaults(func=_run)
