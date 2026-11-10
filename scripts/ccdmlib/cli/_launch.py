"""What the session launchers share, on macOS and Windows.

``start-session`` uses all of it; the Codex, thread and root launchers use the
parts that fit (see each function's docstring). A launcher talks to its session
only through ``ccdmlib.platform.session_host``.

Messages keep their macOS wording on POSIX. On Windows "tmux session" reads
"session" and ``scripts/<x>.sh`` reads ``scripts/ccdm <x>``.
"""

from __future__ import annotations

import importlib.util
import json
import os
import re
import shlex
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional, Tuple

from ..platform import commands, paths, proc, session_host
from ..platform.atomic import remove_dir_with_retry

WIN32 = sys.platform == "win32"

_POLL_S = 0.2
_DEFAULT_LAUNCH_TIMEOUT_S = 60.0
_PID_ROUNDS = 20
_PID_ROUND_S = 0.5
_SESSION_FILE_ROUNDS = 4  # A host session's Claude gets this long to write its session file.
_UNLINK_ROUNDS = 20
_UNLINK_ROUND_S = 0.05

_TRUST_PROMPT = re.compile(r"Is this a project you created or one you trust", re.IGNORECASE)
_CHANNEL_PROMPT = re.compile(r"Loading development channels?", re.IGNORECASE)
_AUTO_MODE_OFFER = re.compile(r"Make auto mode your default permission mode", re.IGNORECASE)

_EXITED_BEFORE_CHANNEL_PROMPT = "Claude exited before the development-channel confirmation"
_CHANNEL_PROMPT_MISSING = "The development-channel confirmation never appeared"
_UNKNOWN_SESSION = "unknown_session"

_KEY_FILE_FLAG = "--ccdm-key-file"
_MCP_CONFIG_FLAG = "--mcp-config"
_LISTENER_FLAG = "--dangerously-load-development-channels"
_LISTENER_CHANNEL = "server:ccdm"
_CHANNEL_SERVER = "ccdm-channel-server.js"
_KEY_FILE_IN_ENV = re.compile(r"""CCDM_ROUTER_KEY_FILE=(?:"([^"]+)"|'([^']+)'|([^\s]+))""")


class LaunchFailed(Exception):
    """A session did not come up; the message is what the launcher reports."""


# --- paths and wording --------------------------------------------------


def repo_root() -> Path:
    """The repo as the caller spelled it, so launch files read as they always did.

    Python resolves symlinks in ``__file__``, and on macOS the temporary and
    checkout folders often go through one.
    """
    entry = sys.argv[0] if sys.argv else ""
    if entry and os.path.basename(entry) == "ccdm.py":
        return Path(os.path.abspath(entry)).parent.parent
    return Path(__file__).resolve().parents[3]


def script_ref(name: str) -> str:
    """How a message names a lifecycle command: ``stop-session`` as the user would type it."""
    return commands.script_ref(name)


def session_word() -> str:
    """The noun for a running session in a message."""
    return "session" if WIN32 else "tmux session"


def router_state_dir() -> str:
    """``CCDM_ROUTER_STATE_DIR``, or ``<stateRoot>/router``."""
    return os.environ.get("CCDM_ROUTER_STATE_DIR") or str(paths.state_root() / "router")


def reminder_state_dir() -> Path:
    """``CCDM_REMINDER_STATE_DIR``, or ``<stateRoot>/conversation-reminders``."""
    configured = os.environ.get("CCDM_REMINDER_STATE_DIR")
    return Path(configured) if configured else paths.state_root() / "conversation-reminders"


def clear_capability_marker(project: str) -> None:
    """Remove a project's Conversation Reminder capability marker, if there is one."""
    invalid = project in ("", ".", "..") or "/" in project or (WIN32 and "\\" in project)
    if not invalid:
        (reminder_state_dir() / "capabilities" / f"{project}.json").unlink(missing_ok=True)


def launch_deadline(variable: str = "CCDM_CLAUDE_LAUNCH_TIMEOUT_S") -> float:
    """A ``time.monotonic()`` deadline; thread launchers pass their own variable."""
    return time.monotonic() + float(os.environ.get(variable) or _DEFAULT_LAUNCH_TIMEOUT_S)


def expand_path(value: str) -> str:
    """``~`` expanded, with Windows separators on Windows (``expanduser`` leaves ``/`` there)."""
    expanded = os.path.expanduser(value)
    return os.path.normpath(expanded) if WIN32 else expanded


def effective_claude_home(claude_home: str) -> str:
    """The folder Claude uses: the project's ``claude_home``, ``CLAUDE_CONFIG_DIR``, or ``~/.claude``."""
    return expand_path(claude_home or os.environ.get("CLAUDE_CONFIG_DIR") or os.path.join(str(Path.home()), ".claude"))


def transcript_paths(claude_home: str, cwd: str, session_id: str) -> List[str]:
    """Where Claude may have kept a session: ``<home>/projects/<munged cwd>/<id>.jsonl``.

    ``<munged cwd>`` is the cwd with every non-alphanumeric character as ``-``, so
    ``C:\\x\\y`` is ``C--x-y``. Tried as written and through ``realpath``; Windows
    also tries the other drive-letter case, which Claude takes from its process.
    """
    home = os.path.expanduser(claude_home)
    spellings = [cwd, os.path.realpath(cwd)]
    if WIN32:
        for spelling in list(spellings):
            if spelling[1:2] == ":":
                spellings.append(spelling[0].swapcase() + spelling[1:])
    return [
        os.path.join(home, "projects", re.sub(r"[^A-Za-z0-9]", "-", spelling), f"{session_id}.jsonl")
        for spelling in dict.fromkeys(spellings)
    ]


# --- Claude's start-up screens ------------------------------------------


class Dialogs:
    """One launch's answers to Claude's one-time prompts, so each is answered once."""

    def __init__(self, name: str) -> None:
        self.name = name
        self.offer_answered = False

    def dismiss_auto_mode_offer(self, screen: str) -> None:
        """Esc on "Make auto mode your default permission mode?", which blocks the prompt."""
        if not self.offer_answered and _AUTO_MODE_OFFER.search(screen):
            self.offer_answered = True
            session_host.send_key(self.name, "Escape")


def _screen(name: str) -> str:
    return session_host.capture(name, join=True)


def _ended(name: str) -> bool:
    # On ccdm-host an ended session keeps answering capture, so a dead one must be asked.
    return session_host.backend_name() != "tmux" and not session_host.is_live(name)


def accept_dialogs(name: str, cwd: str, project_path: str, deadline: float) -> Dialogs:
    """Answer Claude's start-up prompts for session ``name``; returns once the channel prompt is accepted.

    One loop up to ``deadline`` (from :func:`launch_deadline`):

    * The folder-trust prompt gets Enter only when ``cwd``, the folder the
      session runs in, is ``project_path``, the registry ``path`` being started.
      Otherwise :class:`LaunchFailed` names both.
    * The "development channels" prompt gets Enter, and the function returns.
    * The one-time auto-mode offer gets Esc, once.

    A launch that needs no dialog is not delayed. Pass the returned
    :class:`Dialogs` to :func:`wait_ready`. Raises :class:`LaunchFailed` with
    today's message if the session ends or the channel prompt never appears.
    """
    dialogs = Dialogs(name)
    trust_answered = False
    while time.monotonic() < deadline:
        try:
            screen = _screen(name)
        except session_host.SessionHostError as error:
            if error.code == _UNKNOWN_SESSION:
                raise LaunchFailed(_EXITED_BEFORE_CHANNEL_PROMPT) from error
            raise
        if not trust_answered and _TRUST_PROMPT.search(screen):
            if not paths.same_path(cwd, project_path):
                raise LaunchFailed(
                    f"Refusing the folder-trust prompt: the session's folder {cwd} "
                    f"is not the project's registered path {project_path}"
                )
            trust_answered = True
            session_host.send_key(name, "Enter")
        else:
            dialogs.dismiss_auto_mode_offer(screen)
            if _CHANNEL_PROMPT.search(screen):
                session_host.send_key(name, "Enter")
                return dialogs
        if _ended(name):
            raise LaunchFailed(_EXITED_BEFORE_CHANNEL_PROMPT)
        time.sleep(_POLL_S)
    raise LaunchFailed(_CHANNEL_PROMPT_MISSING)


def wait_ready(
    name: str, ready_file: str, deadline: float, dialogs: Optional[Dialogs] = None, exited: Optional[str] = None
) -> Mapping[str, Any]:
    """Wait for the channel server's ``ready.json``; returns it once it says ``ok``.

    While it waits it still answers the auto-mode offer. Raises
    :class:`LaunchFailed` with today's message on a refused or missing hello. With
    ``exited``, a session that ends first fails at once, with that message.
    """
    dialogs = dialogs or Dialogs(name)
    retryable = (FileNotFoundError, json.JSONDecodeError, PermissionError) if WIN32 else (FileNotFoundError, json.JSONDecodeError)
    while time.monotonic() < deadline:
        try:
            with open(ready_file, encoding="utf-8") as handle:
                outcome = json.load(handle)
        except retryable:
            if exited is not None and not session_host.is_live(name):
                raise LaunchFailed(exited)
            try:
                dialogs.dismiss_auto_mode_offer(_screen(name))
            except session_host.SessionHostError:
                pass  # Today a session that ended here also runs out the deadline.
            time.sleep(_POLL_S)
            continue
        if outcome.get("ok"):
            return outcome
        raise LaunchFailed(f"The channel server's Router hello failed: {outcome.get('error')}")
    raise LaunchFailed("The channel server never said hello to the Router")


# --- launch files -------------------------------------------------------


def _quote(text: str) -> str:
    return "'" + text.replace("'", "'\\''") + "'"


def _user_status_line(claude_home: str) -> Optional[Mapping[str, Any]]:
    try:
        with open(os.path.join(claude_home, "settings.json"), encoding="utf-8") as handle:
            configured = json.load(handle).get("statusLine")
    except (OSError, ValueError, AttributeError):
        return None
    return configured if isinstance(configured, dict) else None


def status_line_setting(root_dir: Path, claude_home: str) -> Dict[str, Any]:
    """The per-launch ``statusLine`` on Windows, keeping the user's own command with ``--chain``.

    ``claude_home`` is from :func:`effective_claude_home`. POSIX launches do not
    set this: macOS users configure their own statusLine (see the README).
    """
    from ..platform.hooks import hook_command

    configured = _user_status_line(claude_home) or {}
    user_command = configured.get("command")
    script = root_dir / "scripts" / "statusline-context.js"
    if isinstance(user_command, str) and user_command and "statusline-context.js" in user_command:
        return dict(configured)  # Already reports the percentage; chaining it would run it twice.
    chain = f" --chain {_quote(user_command)}" if isinstance(user_command, str) and user_command else ""
    return {**configured, "type": "command", "command": hook_command(script) + chain}


def claude_program() -> Tuple[str, List[str], Mapping[str, str]]:
    """``(program, leading args, env)`` that start Claude. On POSIX, the shell's ``claude``.

    Raises ``exe.ToolNotFound`` on Windows if Claude Code is not installed.
    """
    if not WIN32:
        return "claude", [], {}
    from ..platform import exe

    found = exe.claude()
    return found["command"], list(found["args"]), found["env"]


def remove_launch_files(key_file: str, launch_dir: str) -> None:
    """Remove a key and a launch directory's files, keeping ``threads/``.

    The ``threads/`` folder holds running Thread Conversations' files, which
    outlive the channel session.
    """
    _unlink(Path(key_file))
    launch = Path(launch_dir)
    if not launch.is_dir() or launch.is_symlink():
        return
    for entry in launch.iterdir():
        if entry.name == "threads":
            continue
        if entry.is_dir() and not entry.is_symlink():
            if WIN32:
                try:
                    remove_dir_with_retry(entry)
                except OSError:
                    pass
            else:
                shutil.rmtree(entry, ignore_errors=True)
        else:
            _unlink(entry)
    try:
        launch.rmdir()  # Only once no thread launch is left.
    except OSError:
        pass


def _unlink(path: Path) -> None:
    for _ in range(_UNLINK_ROUNDS):
        try:
            path.unlink(missing_ok=True)
            return
        except PermissionError:
            if not WIN32:
                raise
            time.sleep(_UNLINK_ROUND_S)  # A just-killed process can hold the file for a moment.


# --- which process is it ------------------------------------------------


def _ps_rows() -> List[Tuple[int, str]]:
    try:
        output = subprocess.check_output(
            ["ps", "axeww", "-o", "pid=,command="], text=True, stderr=subprocess.DEVNULL
        )
    except Exception:
        return []
    rows = []
    for line in output.splitlines():
        pid_text, _, command = line.strip().partition(" ")
        if pid_text.isdigit():
            rows.append((int(pid_text), command))
    return rows


def _split_command(command: str) -> List[str]:
    try:
        return shlex.split(command)
    except ValueError:
        return []


def _is_claude_listener(argv: List[str]) -> bool:
    return bool(argv) and os.path.basename(argv[0]) == "claude" and _LISTENER_FLAG in argv and _LISTENER_CHANNEL in argv


def _carries_key_file(command: str, key_file: str) -> bool:
    target = os.path.normpath(os.path.expanduser(key_file))
    for match in _KEY_FILE_IN_ENV.finditer(command):
        value = next(group for group in match.groups() if group is not None)
        if os.path.normpath(os.path.expanduser(value)) == target:
            return True
    return False


def _argument_after(argv: List[str], flag: str) -> Optional[str]:
    for index, argument in enumerate(argv[:-1]):
        if argument == flag:
            return argv[index + 1]
    return None


def listener_pids(key_file: str, launch_dir: Optional[str] = None) -> List[int]:
    """Processes that are a launch's Claude listener: Claude and its channel server.

    POSIX reads ``CCDM_ROUTER_KEY_FILE`` from each process's environment. Windows
    cannot, so it reads command lines: ``--ccdm-key-file <key>`` on the channel
    server, or ``--mcp-config <launch_dir>/mcp.json`` on Claude when ``launch_dir``
    is given. Thread launchers pass the thread's key file (and launch directory).
    """
    if WIN32:
        return _win32_listener_pids(key_file, launch_dir)
    found = []
    for pid, command in _ps_rows():
        argv = _split_command(command)
        is_channel_server = bool(argv) and os.path.basename(argv[0]) == "node" and any(
            os.path.basename(argument) == _CHANNEL_SERVER for argument in argv[1:]
        )
        if (is_channel_server or _is_claude_listener(argv)) and _carries_key_file(command, key_file):
            found.append(pid)
    return found


def _win32_listener_pids(key_file: str, launch_dir: Optional[str]) -> List[int]:
    own = os.getpid()
    mcp_config = os.path.join(launch_dir, "mcp.json") if launch_dir else None
    found = []
    for row in proc.find(lambda process: process.pid != own):
        argv = proc.command_line(row.pid) or []
        key = _argument_after(argv, _KEY_FILE_FLAG)
        config = _argument_after(argv, _MCP_CONFIG_FLAG)
        if (key is not None and paths.same_path(key, key_file)) or (
            mcp_config is not None and config is not None and paths.same_path(config, mcp_config)
        ):
            found.append(row.pid)
    return found


def stop_listeners(pids: List[int]) -> None:
    """Stop processes found by :func:`listener_pids`; one that already ended is fine."""
    for pid in pids:
        try:
            if WIN32:
                # Each PID was verified by its command line just now.
                proc.kill_tree(pid, started_at=proc.start_time(pid))
            else:
                os.kill(pid, signal.SIGTERM)
        except OSError:
            pass


def _claude_pid_by_key_file(key_file: str) -> Optional[int]:
    for pid, command in _ps_rows():
        if _is_claude_listener(_split_command(command)) and _carries_key_file(command, key_file):
            return pid
    return None


def _claude_pid_from_host(name: str, claude_home: str) -> Optional[int]:
    home = os.path.expanduser(claude_home)
    for pid in session_host.pids(name):
        if os.path.isfile(os.path.join(home, "sessions", f"{pid}.json")):
            return pid
    return None


def _claude_pid_by_command_line(name: str, key_file: str, launch_dir: Optional[str]) -> Optional[int]:
    """The host session's process that was started as this launch's Claude, or ``None``.

    Only the session's own processes are looked at. POSIX reads the key file from
    the environment, as on tmux. Windows reads the command line: Claude's channel
    flags and ``--mcp-config <launch_dir>/mcp.json``, so it needs ``launch_dir``.
    """
    members = session_host.pids(name)
    if not WIN32:
        for pid, command in _ps_rows():
            if pid in members and _is_claude_listener(_split_command(command)) and _carries_key_file(command, key_file):
                return pid
        return None
    if not launch_dir:
        return None
    mcp_config = os.path.join(launch_dir, "mcp.json")
    matches = []
    for pid in members:
        argv = proc.command_line(pid) or []
        config = _argument_after(argv, _MCP_CONFIG_FLAG)
        if _LISTENER_FLAG in argv and _LISTENER_CHANNEL in argv and config is not None and paths.same_path(config, mcp_config):
            matches.append(pid)
    # A launcher that starts Claude with its own arguments matches too: take its child.
    parents = {row.ppid for row in proc.find(lambda process: process.pid in matches)} if len(matches) > 1 else set()
    return next((pid for pid in matches if pid not in parents), None)


def find_claude_process(
    name: str, key_file: str, claude_home: str, launch_dir: Optional[str] = None
) -> Tuple[Optional[int], Optional[str]]:
    """``(pid, start time)`` of a session's Claude, or ``(None, None)`` after 10 s.

    On tmux it is the process carrying this launch's key file. On ccdm-host it is
    the session's process with a ``<claude_home>/sessions/<pid>.json``; if none has
    one after 2 s, it is the session's process whose command line is this launch's
    Claude (``launch_dir`` is the launch directory, needed for that on Windows).
    The start time is ``None`` on POSIX. ``claude_home`` is from
    :func:`effective_claude_home` on ccdm-host. Thread launchers record the result
    as ``runtime_pid``.
    """
    on_tmux = session_host.backend_name() == "tmux"
    for attempt in range(_PID_ROUNDS):
        if on_tmux:
            pid = _claude_pid_by_key_file(key_file)
        else:
            pid = _claude_pid_from_host(name, claude_home)
            if not pid and attempt >= _SESSION_FILE_ROUNDS:
                pid = _claude_pid_by_command_line(name, key_file, launch_dir)
        if pid:
            return pid, proc.start_time(pid)
        time.sleep(_PID_ROUND_S)
    return None, None


def read_session_id(claude_home: str, pid: int) -> Optional[str]:
    """The ``session_id`` in Claude's ``sessions/<pid>.json``, or ``None`` after 10 s."""
    session_file = os.path.join(os.path.expanduser(claude_home), "sessions", f"{pid}.json")
    for _ in range(_PID_ROUNDS):
        try:
            with open(session_file, encoding="utf-8") as handle:
                session = json.load(handle)
            return session.get("sessionId") or session.get("session_id") or session.get("id")
        except Exception:
            time.sleep(_PID_ROUND_S)
    return None


# --- the registry -------------------------------------------------------


def set_project_fields(registry_path: Path, project: str, fields: Mapping[str, Any]) -> None:
    """Update a project's registry fields under the lock every writer shares."""
    sys.dont_write_bytecode = True  # No __pycache__ beside the scripts.
    spec = importlib.util.spec_from_file_location(
        "ccdm_registry_update", os.path.join(os.path.dirname(registry_path), "scripts", "registry-update.py")
    )
    registry_update = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(registry_update)
    registry_update.set_project_fields(str(registry_path), project, dict(fields))
