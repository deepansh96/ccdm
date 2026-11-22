"""`ccdm start-gemini-session <project> [--resume <session_uuid>]`: run a Gemini project's bridge.

The bridge, ``scripts/gemini-bridge.js``, drives ``agy acp`` (the Google
Antigravity CLI) in the project path. It is a session of the session host: a
no-PTY one on Windows, a tmux one elsewhere. On Windows the host holds the
bridge's stdin pipe for the life of the session; closing it asks the bridge to
stop, and the session's Job takes agy down with it.

Like a Codex project it is served through the Router with a fresh launch key and
no Discord token, and its PID is recorded only after the bridge's Router hello,
with the agy session id as ``session_id``.

The model and thinking level come from the project's ``gemini_model`` (or
``model``) and ``gemini_effort``; unset, the bridge uses its own default.
The project's ``gemini_account``, an alias in ``gemini_accounts``, names the
home agy runs under (its sign-in, see ``ccdmlib/gemini_home.py``); unset, agy
runs under the user's home. Windows refuses an account home that is not the
user's own. ``--resume`` continues an agy conversation, which must exist in
that home's ``.gemini/antigravity-cli/conversations``; it never falls back to a
fresh one.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import signal
import sys
import time
import traceback
import uuid
from pathlib import Path
from typing import Any, Dict, List, NamedTuple, Optional, Tuple

from .. import gemini_home
from ..platform import commands, exe, proc, session_host
from ..platform.paths import expand_home
from ._detach import detach_if_self
from .start_codex_session import (
    _FORWARDED_ON_WINDOWS,
    _KEY_FILE_FLAG,
    _clean_failed_launch,
    _command_argv,
    _names_key_file,
    _posix_processes,
    _program,
    _registry_update,
    _router_state_dir,
    _scripts_dir,
    _write_launch_key,
)

WIN32 = sys.platform == "win32"
_COMMAND = "start-gemini-session"
_ARGUMENT_FORM = "<project_name> [--resume <session_uuid>]"
_INVOKED_AS = "CCDM_INVOKED_AS"
_DEFAULT_INVOCATION = f"scripts/ccdm {_COMMAND}" if commands.WIN32 else "scripts/start-gemini-session.sh"
_BRIDGE_SCRIPT = "scripts/gemini-bridge.js"
_DEFAULT_LAUNCH_TIMEOUT_S = 120
_READY_POLL_S = 0.2
_PID_POLLS = 20
_PID_POLL_S = 0.5
# Time a failed launch's bridge gets to act on its stdin closing before the Job ends it.
_FAILED_LAUNCH_GRACE_MS = 3000
_MODEL = re.compile(r"[A-Za-z0-9._:-]+")
_EFFORTS = ("low", "medium", "high", "xhigh")
# What the bridge needs from the caller's environment on top of the forwarded names.
_PASSED_THROUGH = ("CCDM_AGY_BIN", "GEMINI_CANCEL_TIMEOUT_MS")


def _say(message: str = "") -> None:
    print(message, flush=True)


def _complain(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


class _Refused(Exception):
    pass


class _Project(NamedTuple):
    path: str
    screen_name: str
    channel_id: str
    type: str
    model: str
    effort: str
    webhook_id: str
    text_reply_fallback_off: bool
    agy_home: str


def _read_project(registry_path: str, project: str) -> _Project:
    with open(registry_path, encoding="utf-8") as stream:
        registry = json.load(stream)
    entry = (registry.get("projects") or {}).get(project)
    invalid = not project or "/" in project or project.startswith(".") or (WIN32 and ("\\" in project or ":" in project))
    if not isinstance(entry, dict) or invalid:
        raise _Refused(f"Unknown project '{project}'")
    # Both reach the bridge's environment, so only plain values pass.
    model = str(entry.get("gemini_model") or entry.get("model") or "")
    if model and not _MODEL.fullmatch(model):
        raise _Refused(f"Invalid gemini_model '{model}' for '{project}'")
    effort = str(entry.get("gemini_effort") or "")
    if effort and effort not in _EFFORTS:
        raise _Refused(f"Invalid gemini_effort '{effort}' for '{project}' (expected low, medium, high, or xhigh)")
    agy_home = ""
    if (entry.get("type") or "claude") == "gemini":
        try:
            agy_home = gemini_home.resolve(registry, project)
        except gemini_home.GeminiHomeError as error:
            raise _Refused(str(error)) from None
    return _Project(
        path=expand_home(entry["path"]) if WIN32 else os.path.expanduser(entry["path"]),
        screen_name=entry["screen_name"],
        channel_id=str(entry["channel_id"]),
        type=entry.get("type") or "claude",
        model=model,
        effort=effort,
        webhook_id=str(entry.get("webhook_id") or ""),
        text_reply_fallback_off=entry.get("text_reply_fallback") is False,
        agy_home=agy_home,
    )


# --- finding the bridge and its agy --------------------------------------


def _is_posix_listener(command: str, key_file: str) -> bool:
    """The bridge or its agy, carrying this launch's key file path in its environment."""
    target = os.path.normpath(key_file)
    keys = re.finditer(r"""(?:^|\s)CCDM_ROUTER_KEY_FILE=(?:"([^"]+)"|'([^']+)'|([^\s]+))""", command)
    if not any(os.path.normpath(next(g for g in match.groups() if g is not None)) == target for match in keys):
        return False
    argv = _command_argv(command)
    if not argv:
        return False
    program = os.path.basename(argv[0])
    if program == "agy":
        return "acp" in argv
    return program == "node" and any(os.path.basename(arg) == "gemini-bridge.js" for arg in argv[1:])


def _listener_pids(key_file: str) -> List[int]:
    if WIN32:
        # Another process's environment cannot be read here: the bridge names its key on its command line.
        found = []
        for process in proc.find(lambda entry: entry.name.lower() == "node.exe"):
            if process.pid == os.getpid():
                continue
            argv = proc.command_line(process.pid) or []
            if _program(argv) == "node" and _names_key_file(argv, key_file):
                found.append(process.pid)
        return found
    return [pid for pid, command in _posix_processes() if _is_posix_listener(command, key_file)]


def _bridge_pid(screen_name: str, key_file: str) -> Optional[int]:
    if WIN32:
        for pid in session_host.pids(screen_name):
            argv = proc.command_line(pid) or []
            if _program(argv) == "node" and _names_key_file(argv, key_file):
                return pid
        return None
    for pid, command in _posix_processes():
        argv = _command_argv(command)
        if len(argv) >= 2 and os.path.basename(argv[0]) == "node" and argv[1].endswith("gemini-bridge.js") \
                and _is_posix_listener(command, key_file):
            return pid
    return None


# --- the steps of a launch ----------------------------------------------


def _bridge_env(project: _Project, name: str, router_state: str, key_file: str, ready_file: str, resume: str) -> Dict[str, str]:
    env: Dict[str, str] = {}
    if WIN32:
        env.update({variable: os.environ[variable] for variable in _FORWARDED_ON_WINDOWS if os.environ.get(variable)})
    env.update({
        "CCDM_GEMINI_PROJECT": name,
        "CCDM_ROUTER_STATE_DIR": router_state,
        "CCDM_ROUTER_KEY_FILE": key_file,
        "CCDM_CHANNEL_READY_FILE": ready_file,
        "CHANNEL_ID": project.channel_id,
        "PROJECT_DIR": project.path,
        "CCDM_AGY_HOME": project.agy_home,
    })
    if project.model:
        env["GEMINI_MODEL"] = project.model
    if project.effort:
        env["GEMINI_EFFORT"] = project.effort
    if project.text_reply_fallback_off:
        env["GEMINI_TEXT_REPLY_FALLBACK"] = "0"
    if resume:
        env["GEMINI_RESUME_SESSION_ID"] = resume
    for variable in _PASSED_THROUGH:
        if os.environ.get(variable):
            env[variable] = os.environ[variable]
    transcribe = os.environ.get("CODEX_BRIDGE_TRANSCRIBE_AUDIO") or os.environ.get("USE_AUDIO_TRANSCRIPTION_IN_BRIDGE") or ""
    if transcribe:
        env["CODEX_BRIDGE_TRANSCRIBE_AUDIO"] = transcribe
    return env


def _bridge_argv(key_file: str) -> List[str]:
    if not WIN32:
        return ["node", _BRIDGE_SCRIPT]
    return [exe.node()["command"], _BRIDGE_SCRIPT, _KEY_FILE_FLAG, key_file]


def _wait_for_hello(session: str, ready_file: str) -> Tuple[Optional[str], Optional[str]]:
    """(None, the agy session id) once the bridge has said hello, else (why the launch failed, None)."""
    deadline = time.monotonic() + float(os.environ.get("CCDM_GEMINI_LAUNCH_TIMEOUT_S") or _DEFAULT_LAUNCH_TIMEOUT_S)
    while time.monotonic() < deadline:
        try:
            with open(ready_file, encoding="utf-8") as stream:
                outcome = json.load(stream)
        except (FileNotFoundError, PermissionError, json.JSONDecodeError):
            try:
                live = session_host.is_live(session)
            except session_host.SessionHostError as error:
                return f"Gemini Router launch failed: {error}", None
            if not live:
                return "Gemini Router launch failed: bridge exited before saying hello", None
            time.sleep(_READY_POLL_S)
            continue
        if outcome.get("ok"):
            session_id = outcome.get("provider_conversation_id")
            _say(f"Bridge connected to the Router (scope {outcome['scope']['channel_id']}, agy session {session_id})")
            return None, session_id
        return f"Gemini Router launch failed: {outcome.get('error')}", None
    return "Gemini Router launch failed: the bridge never said hello to the Router", None


def _stop_failed_launch(screen_name: str, key_file: str) -> None:
    try:
        session_host.stop(screen_name, _FAILED_LAUNCH_GRACE_MS if WIN32 else None)
    except session_host.SessionHostError:
        pass
    if WIN32:
        return  # The session's Job held the bridge and its agy.
    for pid in _listener_pids(key_file):
        try:
            os.kill(pid, signal.SIGTERM)
        except OSError:
            pass


def _record(scripts_dir: str, registry_path: str, project_name: str, screen_name: str, key_file: str,
            session_id: Optional[str]) -> int:
    pid = None
    for attempt in range(_PID_POLLS):
        pid = _bridge_pid(screen_name, key_file)
        if pid:
            break
        if attempt + 1 < _PID_POLLS:
            time.sleep(_PID_POLL_S)
    if not pid:
        _say("Warning: started session, but could not find the Gemini bridge PID to record")
        return 0
    fields: Dict[str, Any] = {"pid": pid, "session_id": session_id}
    if WIN32:
        fields["pid_started_at"] = proc.start_time(pid)
    _registry_update(scripts_dir).set_project_fields(registry_path, project_name, fields)
    _say(f"Recorded PID {pid} and agy session {session_id}")
    return 0


# --- the command --------------------------------------------------------


def _usage(invoked: str) -> str:
    return f"Usage: {invoked} {_ARGUMENT_FORM}"


def _is_canonical_uuid(value: str) -> bool:
    try:
        return str(uuid.UUID(value)) == value
    except ValueError:
        return False


def _parse(arguments: List[str]) -> Tuple[Optional[int], str, str]:
    """(exit code if the arguments end the command, project, resume session)."""
    invoked = os.environ.get(_INVOKED_AS) or _DEFAULT_INVOCATION
    project = arguments[0] if arguments else ""
    if not project or (len(arguments) > 1 and (len(arguments) != 3 or arguments[1] != "--resume")):
        _complain(_usage(invoked))
        return 1, "", ""
    resume = arguments[2] if len(arguments) == 3 else ""
    if resume:
        if not _is_canonical_uuid(resume):
            _complain("Resume session must be a canonical UUID")
            return 1, "", ""
    return None, project, resume


def handler(args: argparse.Namespace) -> int:
    arguments: List[str] = list(args.arguments)
    if arguments in (["--help"], ["-h"]):
        _say(_usage(_DEFAULT_INVOCATION))
        _say("Starts a registered Gemini project's bridge, which drives agy acp, as a hosted session.")
        return 0
    stop_code, project_name, resume = _parse(arguments)
    if stop_code is not None:
        return stop_code

    scripts_dir = _scripts_dir()
    root_dir = os.path.dirname(scripts_dir)
    registry_path = os.path.join(root_dir, "registry.json")
    try:
        project = _read_project(registry_path, project_name)
    except _Refused as refused:
        _complain(str(refused))
        return 1
    except Exception:
        traceback.print_exc()
        return 1
    if project.type != "gemini":
        _complain(f"Refusing to start '{project_name}': it is a {project.type} project, not a gemini one.")
        return 1
    conversations = os.path.join(gemini_home.data_dir(project.agy_home), "conversations")
    if resume and not os.path.isfile(os.path.join(conversations, f"{resume}.db")):
        _complain(f"The agy conversation {resume} is missing from {conversations}")
        return 1
    name = project.screen_name

    detach_if_self(name)

    if session_host.is_live(name):
        # A requested resume did not happen, so it is not a success.
        if resume:
            _complain(f"Refusing to resume '{project_name}': session '{name}' is already running. "
                      f"Stop it first with {commands.script_ref('stop-session')} '{project_name}'.")
            return 1
        _say(f"Session '{name}' is already running.")
        return 0

    router_state = _router_state_dir()
    key_file = os.path.join(router_state, "keys", f"{project_name}.key")
    launch_dir = os.path.join(router_state, "launches", project_name)
    ready_file = os.path.join(launch_dir, "ready.json")

    existing = _listener_pids(key_file)
    if existing:
        _say(f"Refusing to start '{project_name}': existing Gemini bridge process(es) already use {key_file}:")
        for pid in existing:
            _say(f"  {pid}")
        _say(f"Run {commands.script_ref('stop-session')} '{project_name}' first, then retry.")
        return 1

    # The Router posts replies only through the project's webhook.
    if not project.webhook_id:
        _complain(f"Refusing to start '{project_name}': it has no webhook_id, so its replies could not be posted. "
                  f"{commands.webhook_fix(project_name)}, then retry.")
        return 1

    try:
        argv = _bridge_argv(key_file)
    except exe.ToolNotFound as error:
        _complain(str(error))
        return 1

    # A fresh launch key revokes whichever session still holds the old one.
    _write_launch_key(project_name, router_state, launch_dir, key_file)

    env = _bridge_env(project, project_name, router_state, key_file, ready_file, resume)
    session_host.start(name, argv, root_dir, env, pty=False, kind="project")
    session_word = "tmux session" if session_host.backend_name() == "tmux" else "session"
    _say(f"Started Gemini Router bridge in {session_word} '{name}'")

    failure, session_id = _wait_for_hello(name, ready_file)
    if failure is not None:
        _complain(failure)
        _complain(f"Launch of '{project_name}' failed; cleaning up")
        _stop_failed_launch(name, key_file)
        _clean_failed_launch(scripts_dir, registry_path, project_name, key_file, launch_dir)
        return 1

    _say(session_host.attach_hint(name, project_name))
    return _record(scripts_dir, registry_path, project_name, name, key_file, session_id)


def register(subparsers: Any) -> None:
    # The arguments are checked as the shell launcher always did, with its messages and exit codes.
    parser = subparsers.add_parser(_COMMAND, help="start a Gemini project's bridge session", add_help=False, prefix_chars="\x01")
    parser.add_argument("arguments", nargs=argparse.REMAINDER)
    parser.set_defaults(func=handler)
