"""`ccdm stop-session <project> [--threads|--all]`: a session, its processes and its state go.

The plain form stops the channel session and leaves thread sessions running.
``--threads`` stops only the project's thread sessions, through the Thread
Supervisor (or by their key paths when it is down); ``--all`` stops both.

On macOS and Linux a recorded process is found by its environment in ``ps``. On
Windows another process's environment cannot be read, so the session's Job ends
it and an orphan is found by its exact command-line arguments. A process is
stopped only after both its command line and its start time have been checked.
"""

from __future__ import annotations

import argparse
import importlib
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
from typing import Callable, List, NamedTuple, Optional, Sequence, Tuple

from ..platform import atomic, proc, session_host
from ..platform.paths import state_root
from ..platform.session_host import SessionHostError
from ._detach import detach_if_self

ROOT_DIR = Path(__file__).resolve().parents[3]

_NAME = "stop-session"
_USAGE_POSIX = "Usage: scripts/stop-session.sh <project_name> [--threads|--all]"
_USAGE_WINDOWS = "Usage: scripts/ccdm stop-session <project_name> [--threads|--all]"
_MODES = ("--threads", "--all")

_TERM_GRACE_SECONDS = 2
_HOST_GRACE_MS = 2000
_JOB_EMPTY_WAIT_SECONDS = 5.0
_SWEEP_WAIT_SECONDS = 2.0
_POLL_SECONDS = 0.1
# A process that has just been killed can hold its files open for a moment longer.
_REMOVE_BUDGET_MS = 5000

_NOT_RUNNING = "not_running"
_NO_TOOL = "spawn_failed"
_STOP_FAILED = "stop_failed"

_KEY_FILE_FLAG = "--ccdm-key-file"
# What a session's own processes can be. A launch-file path in anything else, an
# editor for one, does not make that program part of the session.
_LISTENER_PROGRAMS = frozenset(("claude", "node", "bun", "codex"))
_APP_SERVER_PROGRAMS = frozenset(("node", "codex"))
_LOWEST_USER_PID = 5


class _Session(NamedTuple):
    project: str
    screen: str
    session_type: str
    pid: str
    channel_id: str
    ws_port: str
    legacy_state_dir: str
    key_file: Path
    launch_dir: Path
    marker: Path


def _say(message: str) -> None:
    print(message, flush=True)


def _warn(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


def _session_word() -> str:
    return "session" if proc.WIN32 else "tmux session"


def _usage() -> str:
    return _USAGE_WINDOWS if proc.WIN32 else _USAGE_POSIX


def _field(value: object) -> str:
    return "" if value in (None, "") else str(value)


def _router_state_dir() -> Path:
    return Path(os.environ.get("CCDM_ROUTER_STATE_DIR") or state_root() / "router")


def _reminder_state_dir() -> Path:
    return Path(os.environ.get("CCDM_REMINDER_STATE_DIR") or state_root() / "conversation-reminders")


# A registry that cannot be read leaves every field empty: the sweep finds nothing,
# and the registry update reports the failure and sets the exit code.
def _registry_fields(project: str) -> Tuple[str, str, str, str, str, str]:
    with (ROOT_DIR / "registry.json").open(encoding="utf-8") as source:
        registry = json.load(source)
    entry = registry["projects"][project]
    session_type = entry.get("type", "claude")
    ws_port = entry.get("ws_port", 18300) if session_type == "codex" else entry.get("ws_port")
    pool = registry.get("pool") if isinstance(registry.get("pool"), list) else []
    bot = next((b for b in pool if isinstance(b, dict) and entry.get("bot_id") and b.get("id") == entry.get("bot_id")), {})
    legacy = os.path.expanduser(bot["state_dir"]) if session_type != "codex" and bot.get("state_dir") else None
    return (
        _field(entry["screen_name"]),
        _field(session_type),
        _field(entry.get("pid")),
        _field(entry.get("channel_id")),
        _field(ws_port),
        _field(legacy),
    )


def _session(project: str) -> _Session:
    try:
        fields = _registry_fields(project)
    except (OSError, ValueError, KeyError, TypeError, AttributeError) as error:
        _warn(f"{_NAME}: could not read '{project}' from the registry: {error!r}")
        fields = ("", "", "", "", "", "")
    router_state = _router_state_dir()
    return _Session(
        project,
        *fields,
        key_file=router_state / "keys" / f"{project}.key",
        launch_dir=router_state / "launches" / project,
        marker=_reminder_state_dir() / "capabilities" / f"{project}.json",
    )


def _safe_file_name(project: str) -> bool:
    """Whether a project name can name files without leaving their directories."""
    if project in ("", ".", "..") or "/" in project:
        return False
    return not (proc.WIN32 and ("\\" in project or ":" in project))


# --- finding listeners on macOS and Linux -----------------------------------


def _ps_lines() -> List[str]:
    try:
        output = subprocess.check_output(
            ["ps", "axeww", "-o", "pid=,command="],
            stderr=subprocess.DEVNULL,
            encoding="utf-8",
            errors="replace",
        )
    except Exception:
        return []
    return output.splitlines()


def _ps_rows() -> List[Tuple[str, str]]:
    rows = []
    for line in _ps_lines():
        pid_text, _, command = line.strip().partition(" ")
        if not pid_text.isdigit() or "ps axeww" in command or "python3 -" in command:
            continue
        rows.append((pid_text, command))
    return rows


def _argv_of(command: str) -> List[str]:
    try:
        return shlex.split(command)
    except ValueError:
        return []


def _env_values(command: str, name: str) -> List[str]:
    pattern = rf"""(?:^|\s){re.escape(name)}=(?:"([^"]*)"|'([^']*)'|([^\s]+))"""
    return [next(group for group in match.groups() if group is not None) for match in re.finditer(pattern, command)]


def _is_discord_plugin_path(value: str) -> bool:
    path = os.path.normpath(os.path.expanduser(value))
    roots = ("claude-plugins-official/discord", "claude-plugins-official/external_plugins/discord")
    return any(path.endswith(f"/{root}") or f"/{root}/" in path for root in roots)


def _is_legacy_listener(command: str) -> bool:
    argv = _argv_of(command)
    if not argv:
        return False
    exe = os.path.basename(argv[0])
    if exe in {"tmux", "zsh", "bash", "sh", "fish", "login"}:
        return False
    if exe == "claude" and (
        ("--channels" in argv and any(arg.startswith("plugin:discord") for arg in argv))
        or ("--dangerously-load-development-channels" in argv and "server:discord" in argv)
    ):
        return True
    if exe == "node" and any(os.path.basename(arg) == "claude-reminder-channel.js" for arg in argv[1:]):
        return True
    if exe == "claude-channel-discord":
        return True
    has_discord_cwd = any(arg == "--cwd" and _is_discord_plugin_path(argv[i + 1]) for i, arg in enumerate(argv[:-1]))
    if exe == "bun" and "run" in argv and has_discord_cwd:
        return True
    plugin_root = any(_is_discord_plugin_path(value) for value in _env_values(command, "CLAUDE_PLUGIN_ROOT"))
    return exe == "bun" and any(
        os.path.basename(arg) == "server.ts" and (_is_discord_plugin_path(arg) or plugin_root) for arg in argv[1:]
    )


def _find_legacy_pool_pids(state_dir: str) -> List[str]:
    """A Claude listener from before the Router cutover, with its pool bot's state directory."""
    target = os.path.normpath(os.path.expanduser(state_dir))
    found = []
    for pid_text, command in _ps_rows():
        dirs = _env_values(command, "DISCORD_STATE_DIR")
        if any(os.path.normpath(os.path.expanduser(value)) == target for value in dirs) and _is_legacy_listener(command):
            found.append(pid_text)
    return found


def _is_router_claude_listener(command: str) -> bool:
    argv = _argv_of(command)
    if not argv:
        return False
    exe = os.path.basename(argv[0])
    if exe == "claude":
        return "--dangerously-load-development-channels" in argv and "server:ccdm" in argv
    return exe == "node" and any(os.path.basename(arg) == "ccdm-channel-server.js" for arg in argv[1:])


def _find_router_claude_pids(key_file: Path) -> List[str]:
    target = os.path.normpath(str(key_file))
    found = []
    for pid_text, command in _ps_rows():
        keys = _env_values(command, "CCDM_ROUTER_KEY_FILE")
        if any(os.path.normpath(key) == target for key in keys) and _is_router_claude_listener(command):
            found.append(pid_text)
    return found


def _is_codex_bridge(command: str, channel_id: str) -> bool:
    argv = _argv_of(command)
    if len(argv) < 2:
        return False
    return (
        os.path.basename(argv[0]) == "node"
        and os.path.normpath(argv[1]).endswith("scripts/codex-bridge.js")
        and channel_id in _env_values(command, "CHANNEL_ID")
    )


def _is_codex_app_server(command: str, ws_port: str) -> bool:
    argv = _argv_of(command)
    if not argv or os.path.basename(argv[0]) not in {"node", "codex"}:
        return False
    return "app-server" in argv and f"ws://127.0.0.1:{ws_port}" in argv


def _find_codex_listener_pids(channel_id: str, ws_port: str) -> List[str]:
    return [
        pid_text
        for pid_text, command in _ps_rows()
        if _is_codex_bridge(command, channel_id) or _is_codex_app_server(command, ws_port)
    ]


def _owned_listener_pids(session: _Session) -> List[str]:
    if session.session_type == "codex":
        if not session.channel_id or not session.ws_port:
            _warn(f"Skipping Codex listener sweep for '{session.project}': missing channel_id or ws_port")
            return []
        return _find_codex_listener_pids(session.channel_id, session.ws_port)
    pids = _find_router_claude_pids(session.key_file)
    if session.legacy_state_dir:
        pids.extend(_find_legacy_pool_pids(session.legacy_state_dir))
    return pids


# --- stopping on macOS and Linux --------------------------------------------


def _children_of(pid: str) -> List[str]:
    try:
        result = subprocess.run(["pgrep", "-P", pid], capture_output=True, text=True)
    except OSError:
        return []
    return result.stdout.split()


def _collect_tree(pid: str, found: List[str]) -> None:
    if not re.fullmatch(r"[0-9]+", pid) or pid in found or not proc.alive(int(pid)):
        return
    found.append(pid)
    for child in _children_of(pid):
        _collect_tree(child, found)


def _send(pid: str, signal_number: int) -> None:
    try:
        os.kill(int(pid), signal_number)
    except OSError:
        pass


def _sleep_between_signals() -> None:
    # A plain `sleep` program, as the shell ran, so a test's PATH can shorten it.
    try:
        subprocess.run(["sleep", str(_TERM_GRACE_SECONDS)], check=False)
    except OSError:
        time.sleep(_TERM_GRACE_SECONDS)


def _terminate_pids(pids: Sequence[str]) -> None:
    tree: List[str] = []
    for pid in pids:
        _collect_tree(pid, tree)
    if not tree:
        return
    for pid in tree:
        _send(pid, signal.SIGTERM)
    _sleep_between_signals()
    for pid in tree:
        if proc.alive(int(pid)):
            _send(pid, signal.SIGKILL)


def _stop_posix(session: _Session) -> None:
    if session.pid:
        if session.pid in _owned_listener_pids(session):
            _say(f"Stopping recorded process tree for '{session.project}' (pid {session.pid})")
            _terminate_pids([session.pid])
        else:
            _say(f"Skipping recorded pid {session.pid}: it no longer belongs to '{session.project}'")

    _report_stop(session.screen, _end_session(session.screen, None))

    orphans = _owned_listener_pids(session)
    if orphans:
        _say("Cleaning remaining listener process(es):")
        for pid in orphans:
            _say(f"  {pid}")
        _terminate_pids(orphans)


# --- finding listeners on Windows -------------------------------------------


def _same_path_key(value: str) -> str:
    return os.path.normcase(os.path.normpath(value))


def _program_of(name: str) -> str:
    lowered = name.lower()
    return lowered[:-4] if lowered.endswith(".exe") else lowered


def _carries_key_file(argv: Sequence[str], key_file: str) -> bool:
    for index, arg in enumerate(argv):
        if arg == _KEY_FILE_FLAG and index + 1 < len(argv) and _same_path_key(argv[index + 1]) == key_file:
            return True
        if arg.startswith(f"{_KEY_FILE_FLAG}=") and _same_path_key(arg.split("=", 1)[1]) == key_file:
            return True
    return False


def _inside(path: str, directory: str) -> bool:
    return path == directory or path.startswith(directory + os.sep)


# Thread sessions' launch files sit under threads/, and a plain stop leaves those running.
def _carries_launch_dir(argv: Sequence[str], launch_dir: str, threads_dir: str) -> bool:
    for arg in argv[1:]:
        value = arg.split("=", 1)[1] if arg.startswith("-") and "=" in arg else arg
        path = _same_path_key(value)
        if _inside(path, launch_dir) and not _inside(path, threads_dir):
            return True
    return False


def _is_app_server_on(name: str, argv: Sequence[str], ws_port: str) -> bool:
    return _program_of(name) in _APP_SERVER_PROGRAMS and "app-server" in argv and f"ws://127.0.0.1:{ws_port}" in argv


def _session_matcher(session: _Session, ws_port: str) -> Callable[[str, Sequence[str]], bool]:
    key_file = _same_path_key(str(session.key_file))
    launch_dir = _same_path_key(str(session.launch_dir))
    threads_dir = _same_path_key(str(session.launch_dir / "threads"))

    def matches(name: str, argv: Sequence[str]) -> bool:
        if _carries_key_file(argv, key_file):
            return True
        if _program_of(name) in _LISTENER_PROGRAMS and _carries_launch_dir(argv, launch_dir, threads_dir):
            return True
        return bool(ws_port) and session.session_type == "codex" and _is_app_server_on(name, argv, ws_port)

    return matches


def _verified_command_line(pid: int) -> Tuple[str, Sequence[str]]:
    """The process's start time and arguments, read so that both are the same process's."""
    started = proc.start_time(pid)
    if started is None:
        return "", ()
    try:
        argv = proc.command_line(pid)
    except OSError:
        return "", ()
    if argv is None or proc.start_time(pid) != started:
        return "", ()
    return started, argv


def _windows_listeners(matches: Callable[[str, Sequence[str]], bool]) -> List[Tuple[int, str]]:
    own_pid = os.getpid()
    found = []
    for process in proc.find(lambda candidate: candidate.pid >= _LOWEST_USER_PID and candidate.pid != own_pid):
        started, argv = _verified_command_line(process.pid)
        if started and matches(process.name, argv):
            found.append((process.pid, started))
    return found


# --- stopping on Windows ----------------------------------------------------


def _wait_for_empty_session(screen: str) -> None:
    deadline = time.monotonic() + _JOB_EMPTY_WAIT_SECONDS
    while screen:
        try:
            remaining = session_host.pids(screen)
        except SessionHostError as error:
            if error.code == _NOT_RUNNING:
                return
            raise
        if not remaining:
            return
        if time.monotonic() >= deadline:
            raise SessionHostError(_STOP_FAILED, f"session '{screen}' still has processes after the stop: {remaining}")
        time.sleep(_POLL_SECONDS)


def _sweep_windows(matches: Callable[[str, Sequence[str]], bool]) -> None:
    orphans = _windows_listeners(matches)
    if not orphans:
        return
    _say("Cleaning remaining listener process(es):")
    for pid, _ in orphans:
        _say(f"  {pid}")
    for pid, started in orphans:
        proc.kill_tree(pid, 0.0, started_at=started)
    deadline = time.monotonic() + _SWEEP_WAIT_SECONDS
    while True:
        remaining = _windows_listeners(matches)
        if not remaining:
            return
        if time.monotonic() >= deadline:
            pids = [pid for pid, _ in remaining]
            raise SessionHostError(_STOP_FAILED, f"listener process(es) could not be stopped: {pids}")
        time.sleep(_POLL_SECONDS)


def _session_pids_before_stop(screen: str) -> List[int]:
    if not screen:
        return []
    try:
        return session_host.pids(screen)
    except SessionHostError as error:
        if error.code in (_NOT_RUNNING, _NO_TOOL):
            return []
        raise


def _stop_windows(session: _Session) -> None:
    ws_port = session.ws_port
    if session.session_type == "codex" and (not session.channel_id or not session.ws_port):
        _warn(f"Skipping Codex listener sweep for '{session.project}': missing channel_id or ws_port")
        ws_port = ""
    matches = _session_matcher(session, ws_port)

    if session.pid:
        owned = {str(pid) for pid in _session_pids_before_stop(session.screen)}
        owned.update(str(pid) for pid, _ in _windows_listeners(matches))
        if session.pid in owned:
            _say(f"Stopping recorded process tree for '{session.project}' (pid {session.pid})")
        else:
            _say(f"Skipping recorded pid {session.pid}: it no longer belongs to '{session.project}'")

    _report_stop(session.screen, _end_session(session.screen, _HOST_GRACE_MS))
    _wait_for_empty_session(session.screen)
    _sweep_windows(matches)


# --- shared steps -----------------------------------------------------------


def _end_session(screen: str, grace_ms: Optional[int]) -> bool:
    if proc.WIN32 and not screen:
        return False
    try:
        return bool(session_host.stop(screen, grace_ms=grace_ms)["stopped"])
    except SessionHostError as error:
        if error.code in (_NOT_RUNNING, _NO_TOOL):
            return False
        raise


def _report_stop(screen: str, stopped: bool) -> None:
    if stopped:
        _say(f"Stopped {_session_word()} '{screen}'")
    else:
        _say(f"No active {_session_word()} '{screen}' found")


def _remove_entry(path: Path) -> None:
    if proc.WIN32:
        atomic.remove_tree_with_retry(path, _REMOVE_BUDGET_MS)
    elif path.is_dir() and not path.is_symlink():
        shutil.rmtree(path, ignore_errors=True)
    else:
        path.unlink(missing_ok=True)


def _remove_launch_dir_if_empty(launch: Path) -> None:
    if proc.WIN32:
        if not any(launch.iterdir()):
            atomic.remove_tree_with_retry(launch, _REMOVE_BUDGET_MS)
        return
    try:
        launch.rmdir()
    except OSError:
        pass


def _remove_claude_state(session: _Session) -> None:
    """The stopped launch's key, launch files and transport proof go; its threads' launch files stay."""
    if session.session_type == "codex" or not _safe_file_name(session.project):
        return
    try:
        _remove_entry(session.key_file)
        launch = session.launch_dir
        if launch.is_dir() and not launch.is_symlink():
            for entry in launch.iterdir():
                if entry.name != "threads":
                    _remove_entry(entry)
            _remove_launch_dir_if_empty(launch)
        _remove_entry(session.marker)
    except OSError as error:
        if not proc.WIN32:
            raise
        raise SessionHostError(_STOP_FAILED, f"state of '{session.project}' could not be removed: {error}") from error


def _clear_registry(project: str) -> int:
    registry_update = importlib.import_module("registry-update")
    fields = {"session_id": None, "pid": None}
    if proc.WIN32:  # Only the Windows launchers record the PID's start time.
        fields["pid_started_at"] = None
    return int(registry_update.main(["set-project-fields", str(ROOT_DIR / "registry.json"), project, json.dumps(fields)]))


def _stop_channel(project: str) -> int:
    session = _session(project)
    if session.screen:
        detach_if_self(session.screen)
    if proc.WIN32:
        _stop_windows(session)
    else:
        _stop_posix(session)
    _remove_claude_state(session)
    status = _clear_registry(project)
    if status != 0:
        return status
    _say(f"Stopped Discord session '{project}'")
    return 0


def _stop_threads(project: str) -> int:
    from thread_supervisor.operator_stop import main as stop_threads

    return int(stop_threads(ROOT_DIR, project))


def _stop_channel_for_all(project: str) -> int:
    """Whatever goes wrong with the channel, the thread sessions are still stopped."""
    try:
        return _stop_channel(project)
    except (SessionHostError, OSError) as error:
        _warn(f"ccdm: {error}")
        return 1


def _run(args: argparse.Namespace) -> int:
    argv: List[str] = args.argv
    if len(argv) == 1 and argv[0] in ("-h", "--help"):
        _say(_usage())
        return 0
    if not argv or not argv[0] or len(argv) > 2 or (len(argv) == 2 and argv[1] and argv[1] not in _MODES):
        _say(_usage())
        return 1
    project = argv[0]
    mode = argv[1] if len(argv) == 2 else ""

    if mode == "--threads":
        return _stop_threads(project)
    if mode == "--all":
        channel_status = _stop_channel_for_all(project)
        threads_status = _stop_threads(project)
        if channel_status != 0:
            _warn(
                f"Stopping the channel session of '{project}' failed (exit {channel_status}); "
                "its thread sessions were still stopped."
            )
            return channel_status
        return threads_status
    return _stop_channel(project)


def register(subparsers: argparse._SubParsersAction) -> None:
    # No option syntax: every word is positional, so today's usage errors stay exit 1, not argparse's 2.
    parser = subparsers.add_parser(
        _NAME, help="Stop a project's session, its processes and its state.", add_help=False, prefix_chars="\0"
    )
    parser.add_argument("argv", nargs="*")
    parser.set_defaults(func=_run)
