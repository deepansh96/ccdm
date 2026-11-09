"""`ccdm start-codex-session <project> [--resume <uuid>]`: run a project's Codex bridge.

The bridge is a session of the session host: a no-PTY one on Windows, a tmux one
elsewhere. Nothing is typed into Codex, so no terminal is needed. On Windows the
host holds the bridge's stdin pipe for the life of the session; closing that pipe
is how the bridge is asked to stop.

Every project goes through the Router: a fresh launch key (which revokes the
previous launch) lets the bridge say hello, and the PID is recorded only after
that hello succeeds.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import re
import secrets
import shlex
import signal
import stat
import subprocess
import sys
import time
import traceback
import uuid
from pathlib import Path
from types import ModuleType
from typing import Any, Dict, List, NamedTuple, Optional, Tuple

from ..platform import atomic, exe, private_fs, proc, session_host
from ..platform.paths import expand_home, same_path, state_root
from ._detach import detach_if_self

WIN32 = sys.platform == "win32"
_COMMAND = "start-codex-session"
_ARGUMENT_FORM = "<project_name> [--resume <thread_uuid>]"
_INVOKED_AS = "CCDM_INVOKED_AS"
_KEY_FILE_FLAG = "--ccdm-key-file"
_BRIDGE_SCRIPT = "scripts/codex-bridge.js"
_DEFAULT_LAUNCH_TIMEOUT_S = 120
_READY_POLL_S = 0.2
_PID_POLLS = 20
_PID_POLL_S = 0.5
# Time a failed launch's bridge gets to act on its stdin closing before the Job ends it.
_FAILED_LAUNCH_GRACE_MS = 3000
_UNLINK_BUDGET_S = 2.0

# The host starts a session with none of the caller's CCDM* variables. These name
# this installation. The rest (CCDM_ROUTER_ROLE, CCDM_THREAD_ID and so on) name the
# caller's own session and must not reach a new bridge.
_FORWARDED_ON_WINDOWS = (
    "CCDM_STATE_ROOT",
    "CCDM_SESSION_HOST",
    "CCDM_ROUTER_SOCKET",
    "CCDM_HOST_SOCKET",
    "CCDM_ROUTER_NODE",
    "CCDM_CODEX_PATH",
    "CCDM_CODEX_CONFIG_REQUEST_TIMEOUT_MS",
    "CCDM_CODEX_EVENT_ORDER_TIMEOUT_MS",
    "CCDM_PYTHON",
    "CCDM_REMINDER_PYTHON",
    "CCDM_REMINDER_STATE_DIR",
    "CCDM_REMINDER_RECEIPTS_DIR",
    "CCDM_REMINDER_PROJECT_ROOT",
)


def _say(message: str = "") -> None:
    print(message, flush=True)


def _complain(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


def _scripts_dir() -> str:
    # The entry's path as the shell saw it, so a symlinked checkout keeps its name
    # in the session's cwd and in every path built from it (macOS's /tmp is one).
    entry = os.path.abspath(sys.argv[0])
    if os.path.basename(entry) == "ccdm.py":
        return os.path.dirname(entry)
    return str(Path(__file__).resolve().parents[2])


def _registry_update(scripts_dir: str) -> ModuleType:
    sys.dont_write_bytecode = True  # no __pycache__ beside the scripts
    spec = importlib.util.spec_from_file_location("ccdm_registry_update", os.path.join(scripts_dir, "registry-update.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class _Project(NamedTuple):
    path: str
    screen_name: str
    channel_id: str
    ws_port: str
    allowed_user_ids: str
    text_reply_fallback: bool
    codex_model: str
    reasoning_effort: str
    service_tier: str
    webhook_id: str


def _read_project(registry_path: str, project: str) -> _Project:
    with open(registry_path, encoding="utf-8") as stream:
        registry = json.load(stream)
    entry = registry["projects"][project]
    allowed_user_ids = [registry["discord_user_id"]] + list(entry.get("guest_user_ids") or [])
    return _Project(
        path=os.path.expanduser(entry["path"]) if not WIN32 else expand_home(entry["path"]),
        screen_name=entry["screen_name"],
        channel_id=entry["channel_id"],
        ws_port=str(entry.get("ws_port", 18300)),
        allowed_user_ids=",".join(dict.fromkeys(str(user_id) for user_id in allowed_user_ids if str(user_id))),
        text_reply_fallback=entry.get("text_reply_fallback") is True,
        codex_model=entry.get("codex_model") or entry.get("model") or "",
        reasoning_effort=entry.get("codex_reasoning_effort") or entry.get("model_reasoning_effort") or "",
        service_tier=entry.get("codex_service_tier") or entry.get("service_tier") or "default",
        webhook_id=str(entry.get("webhook_id") or ""),
    )


def _resolve_codex_home(scripts_dir: str, registry_path: str, project: str) -> Tuple[int, str]:
    """The resolver's exit status and its answer. Its errors go straight to stderr."""
    resolver = os.path.join(scripts_dir, "resolve-codex-home.py")
    completed = subprocess.run(
        [sys.executable, "-B", resolver, registry_path, project],
        stdout=subprocess.PIPE,
        text=True,
        encoding="utf-8",
    )
    return completed.returncode, completed.stdout.rstrip("\n")


# --- finding bridges and app-servers ------------------------------------


def _has_env(command: str, name: str, value: str) -> bool:
    pattern = re.compile(rf"""(?:^|\s){re.escape(name)}=(?:"([^"]*)"|'([^']*)'|([^\s]+))""")
    for match in pattern.finditer(command):
        found = next(group for group in match.groups() if group is not None)
        if found == value:
            return True
    return False


def _command_argv(command: str) -> List[str]:
    try:
        return shlex.split(command)
    except ValueError:
        return []


def _is_posix_bridge(command: str, channel_id: str) -> bool:
    argv = _command_argv(command)
    if len(argv) < 2:
        return False
    return (
        os.path.basename(argv[0]) == "node"
        and os.path.normpath(argv[1]).endswith(_BRIDGE_SCRIPT)
        and _has_env(command, "CHANNEL_ID", channel_id)
    )


def _is_posix_app_server(command: str, ws_port: str) -> bool:
    argv = _command_argv(command)
    if not argv or os.path.basename(argv[0]) not in {"node", "codex"}:
        return False
    return "app-server" in argv and f"ws://127.0.0.1:{ws_port}" in argv


def _posix_processes() -> List[Tuple[int, str]]:
    try:
        listing = subprocess.check_output(["ps", "axeww", "-o", "pid=,command="], text=True, stderr=subprocess.DEVNULL)
    except Exception:
        return []
    processes = []
    for line in listing.splitlines():
        pid_text, _, command = line.strip().partition(" ")
        if pid_text.isdigit() and "ps axeww" not in command and "python3 -" not in command:
            processes.append((int(pid_text), command))
    return processes


def _names_key_file(argv: List[str], key_file: str) -> bool:
    return any(
        arg == _KEY_FILE_FLAG and index + 1 < len(argv) and same_path(argv[index + 1], key_file)
        for index, arg in enumerate(argv)
    )


def _program(argv: List[str]) -> str:
    return re.sub(r"\.exe$", "", os.path.basename(argv[0]), flags=re.IGNORECASE).lower() if argv else ""


def _windows_listener_pids(key_file: str, ws_port: str) -> List[int]:
    # Another process's environment cannot be read here, so the launch key's path,
    # which is the project's own, stands in for the channel.
    address = f"ws://127.0.0.1:{ws_port}"
    found = []
    for process in proc.find(lambda entry: entry.name.lower() in ("node.exe", "codex.exe")):
        if process.pid == os.getpid():
            continue
        argv = proc.command_line(process.pid) or []
        is_bridge = _program(argv) == "node" and _names_key_file(argv, key_file)
        is_app_server = _program(argv) in ("node", "codex") and "app-server" in argv and address in argv
        if is_bridge or is_app_server:
            found.append(process.pid)
    return found


def _listener_pids(project: _Project, key_file: str) -> List[int]:
    if WIN32:
        return _windows_listener_pids(key_file, project.ws_port)
    return [
        pid
        for pid, command in _posix_processes()
        if _is_posix_bridge(command, project.channel_id) or _is_posix_app_server(command, project.ws_port)
    ]


def _bridge_pid(project: _Project, key_file: str) -> Optional[int]:
    if WIN32:
        for pid in session_host.pids(project.screen_name):
            argv = proc.command_line(pid) or []
            if _program(argv) == "node" and _names_key_file(argv, key_file):
                return pid
        return None
    for pid, command in _posix_processes():
        if _is_posix_bridge(command, project.channel_id):
            return pid
    return None


# --- the steps of a launch ----------------------------------------------


def _strip_discord_servers(lines: List[str]) -> List[str]:
    filtered: List[str] = []
    skip = False
    for line in lines:
        if line.startswith("[mcp_servers.discord-"):
            skip = True
            continue
        if skip and line.startswith("["):
            skip = False
        if not skip:
            filtered.append(line)
    # Remove consecutive blank lines.
    result: List[str] = []
    previous_blank = False
    for line in filtered:
        blank = line.strip() == ""
        if blank and previous_blank:
            continue
        result.append(line)
        previous_blank = blank
    return result


def _clean_codex_config(scripts_dir: str, codex_home: str) -> None:
    """Remove stale discord MCP entries; they are registered again per session.

    Under the Codex Home lock a registering bridge holds, so no bridge's
    delete-write-reload is interleaved. The file is replaced whole, so a reader
    sees the old contents or the new ones and nothing between.
    """
    config_path = os.path.join(os.path.expanduser(codex_home), "config.toml")
    if not os.path.exists(config_path):
        return
    registry_update = _registry_update(scripts_dir)
    # The registry lock protocol, on the Codex Home config.
    lock = registry_update.acquire(config_path)
    try:
        with open(config_path, encoding="utf-8", newline="") as stream:
            lines = stream.readlines()
        cleaned = _strip_discord_servers(lines)
        if cleaned != lines:
            # Replacing a symlink would cut it off from the file it names.
            target = os.path.realpath(config_path)
            mode = stat.S_IMODE(os.stat(target).st_mode)
            atomic.write_file_atomic(target, "".join(cleaned), mode)
    finally:
        registry_update.release(lock)


def _router_state_dir() -> str:
    configured = os.environ.get("CCDM_ROUTER_STATE_DIR")
    if configured:
        return configured
    if WIN32:
        return str(state_root() / "router")
    return f"{os.environ.get('HOME', '')}/.local/state/ccdm/router"


def _write_launch_key(project: str, router_state: str, launch_dir: str, key_file: str) -> None:
    if not project or "/" in project or project.startswith(".") or (WIN32 and ("\\" in project or ":" in project)):
        sys.exit(f"Invalid project name for a Router launch: {project!r}")
    launch = Path(launch_dir)
    for directory in (Path(router_state), Path(router_state) / "keys", launch.parent, launch):
        private_fs.ensure_private_dir(directory)
    # A previous launch's outcome and context percentage are wrong for this one.
    (launch / "ready.json").unlink(missing_ok=True)
    (launch / "context.json").unlink(missing_ok=True)
    # Replacing the key revokes whichever session still holds the old one.
    private_fs.write_private(key_file, secrets.token_urlsafe(32) + "\n")


def _bridge_env(project: _Project, name: str, codex_home: str, router_state: str, key_file: str, ready_file: str, resume: str) -> Dict[str, str]:
    env: Dict[str, str] = {}
    if WIN32:
        env.update({variable: os.environ[variable] for variable in _FORWARDED_ON_WINDOWS if os.environ.get(variable)})
    env.update(
        {
            "CODEX_HOME": codex_home,
            "CCDM_CODEX_PROJECT": name,
            "CCDM_ROUTER_STATE_DIR": router_state,
            "CCDM_ROUTER_KEY_FILE": key_file,
            "CCDM_CHANNEL_READY_FILE": ready_file,
            "CHANNEL_ID": project.channel_id,
            "PROJECT_DIR": project.path,
            "WS_PORT": project.ws_port,
            "ALLOWED_USER_IDS": project.allowed_user_ids,
        }
    )
    transcribe = os.environ.get("CODEX_BRIDGE_TRANSCRIBE_AUDIO") or os.environ.get("USE_AUDIO_TRANSCRIPTION_IN_BRIDGE") or ""
    if transcribe:
        env["CODEX_BRIDGE_TRANSCRIBE_AUDIO"] = transcribe
    if project.text_reply_fallback:
        env["CODEX_BRIDGE_TEXT_REPLY_FALLBACK"] = "1"
    if project.codex_model:
        env["CODEX_MODEL"] = project.codex_model
    if project.reasoning_effort:
        env["CODEX_REASONING_EFFORT"] = project.reasoning_effort
    env["CODEX_SERVICE_TIER"] = project.service_tier
    env["CODEX_RESUME_THREAD_ID"] = resume
    return env


def _bridge_argv(key_file: str) -> List[str]:
    if not WIN32:
        return ["node", _BRIDGE_SCRIPT]
    return [exe.node()["command"], _BRIDGE_SCRIPT, _KEY_FILE_FLAG, key_file]


def _wait_for_hello(session: str, ready_file: str) -> Optional[str]:
    """None once the bridge has said hello, else why the launch failed."""
    deadline = time.monotonic() + float(os.environ.get("CCDM_CODEX_LAUNCH_TIMEOUT_S") or _DEFAULT_LAUNCH_TIMEOUT_S)
    while time.monotonic() < deadline:
        try:
            with open(ready_file, encoding="utf-8") as stream:
                outcome = json.load(stream)
        except (FileNotFoundError, PermissionError, json.JSONDecodeError):
            try:
                live = session_host.is_live(session)
            except session_host.SessionHostError as error:
                return f"Codex Router launch failed: {error}"
            if not live:
                return "Codex Router launch failed: bridge exited before saying hello"
            time.sleep(_READY_POLL_S)
            continue
        if outcome.get("ok"):
            _say(f"Bridge connected to the Router (scope {outcome['scope']['channel_id']})")
            return None
        return f"Codex Router launch failed: {outcome.get('error')}"
    return "Codex Router launch failed: the bridge never said hello to the Router"


def _remove_file(path: Path) -> None:
    # A bridge that has just been stopped can still hold its files on Windows.
    deadline = time.monotonic() + _UNLINK_BUDGET_S
    while True:
        try:
            path.unlink(missing_ok=True)
            return
        except OSError:
            if time.monotonic() >= deadline:
                return
            time.sleep(0.05)


def _clean_failed_launch(scripts_dir: str, registry_path: str, project: str, key_file: str, launch_dir: str) -> None:
    _remove_file(Path(key_file))
    # Only the channel launch's files go: threads/ holds the project's running
    # Thread Conversations' launch files, which outlive the channel session.
    launch = Path(launch_dir)
    if launch.is_dir() and not launch.is_symlink():
        for entry in launch.iterdir():
            if entry.name == "threads":
                continue
            if entry.is_dir() and not entry.is_symlink():
                atomic.remove_dir_with_retry(entry)
            else:
                _remove_file(entry)
        try:
            launch.rmdir()  # only once no thread launch is left
        except OSError:
            pass
    # No listener survives a failed launch, so none is recorded.
    fields: Dict[str, Any] = {"pid": None, "session_id": None}
    if WIN32:
        fields["pid_started_at"] = None
    _registry_update(scripts_dir).set_project_fields(registry_path, project, fields)


def _stop_failed_launch(project: _Project, key_file: str) -> None:
    try:
        session_host.stop(project.screen_name, _FAILED_LAUNCH_GRACE_MS if WIN32 else None)
    except session_host.SessionHostError:
        pass
    if WIN32:
        return  # The session's Job held everything the bridge started.
    for pid in _listener_pids(project, key_file):
        # A listener may exit on its own between the sweep and the kill.
        try:
            os.kill(pid, signal.SIGTERM)
        except OSError:
            pass


def _record_pid(scripts_dir: str, registry_path: str, project_name: str, project: _Project, key_file: str, resume: str) -> int:
    pid = None
    for attempt in range(_PID_POLLS):
        pid = _bridge_pid(project, key_file)
        if pid:
            break
        if attempt + 1 < _PID_POLLS:
            time.sleep(_PID_POLL_S)
    if not pid:
        _say("Warning: started session, but could not find Codex bridge PID to record")
        return 1 if resume else 0
    fields: Dict[str, Any] = {"pid": pid, "session_id": None}
    if WIN32:
        fields["pid_started_at"] = proc.start_time(pid)
    _registry_update(scripts_dir).set_project_fields(registry_path, project_name, fields)
    _say(f"Recorded PID {pid}")
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
    """(exit code if the arguments end the command, project, resume thread)."""
    invoked = os.environ.get(_INVOKED_AS) or f"ccdm {_COMMAND}"
    project = arguments[0] if arguments else ""
    resume = ""
    if len(arguments) > 1:
        if len(arguments) != 3 or arguments[1] != "--resume":
            _complain(_usage(invoked))
            return 1, "", ""
        resume = arguments[2]
        if not _is_canonical_uuid(resume):
            _complain("Resume thread must be a canonical UUID")
            return 1, "", ""
    if not project:
        _say(_usage(invoked))
        return 1, "", ""
    return None, project, resume


def handler(args: argparse.Namespace) -> int:
    arguments: List[str] = list(args.arguments)
    if arguments in (["--help"], ["-h"]):
        _say(_usage(f"ccdm {_COMMAND}"))
        _say("Starts a registered Codex project's bridge as a hosted session.")
        return 0
    stop_code, project_name, resume = _parse(arguments)
    if stop_code is not None:
        return stop_code

    scripts_dir = _scripts_dir()
    root_dir = os.path.dirname(scripts_dir)
    registry_path = os.path.join(root_dir, "registry.json")

    # Field errors stay visible as tracebacks, but the resolver below reports first.
    project: Optional[_Project] = None
    try:
        project = _read_project(registry_path, project_name)
    except Exception:
        traceback.print_exc()
    status, codex_home = _resolve_codex_home(scripts_dir, registry_path, project_name)
    if status != 0:
        return status
    if project is None:
        return 1
    name = project.screen_name

    detach_if_self(name)

    if session_host.is_live(name):
        _say(f"Session '{name}' is already running.")
        return 0

    router_state = _router_state_dir()
    key_file = os.path.join(router_state, "keys", f"{project_name}.key")
    launch_dir = os.path.join(router_state, "launches", project_name)
    ready_file = os.path.join(launch_dir, "ready.json")

    existing = _listener_pids(project, key_file)
    if existing:
        _say(
            f"Refusing to start '{project_name}': existing Codex Discord bridge process(es) already use "
            f"channel {project.channel_id} or port {project.ws_port}:"
        )
        for pid in existing:
            _say(f"  {pid}")
        _say(f"Run scripts/stop-session.sh '{project_name}' first, then retry.")
        return 1

    # The Router posts replies only through the project's webhook: a project
    # without one is refused before any runtime change (MCP cleanup, key, session, PID).
    if not project.webhook_id:
        _complain(
            f"Refusing to start '{project_name}': it has no webhook_id, so its replies could not be posted. "
            f"Run scripts/migrate-to-router.sh {project_name} (or node scripts/router.js ensure-webhook {project_name}), then retry."
        )
        return 1

    try:
        _clean_codex_config(scripts_dir, codex_home)
    except (TimeoutError, OSError, UnicodeDecodeError) as error:
        _complain(str(error))
        _complain(f"Refusing to start '{project_name}': could not clean Discord MCP servers from {codex_home}/config.toml.")
        return 1

    try:
        argv = _bridge_argv(key_file)
    except exe.ToolNotFound as error:
        _complain(str(error))
        return 1

    _write_launch_key(project_name, router_state, launch_dir, key_file)

    env = _bridge_env(project, project_name, codex_home, router_state, key_file, ready_file, resume)
    session_host.start(name, argv, root_dir, env, pty=False, kind="project")
    session_word = "tmux session" if session_host.backend_name() == "tmux" else "session"
    _say(f"Started Codex Router bridge in {session_word} '{name}'")

    failure = _wait_for_hello(name, ready_file)
    if failure is not None:
        _complain(failure)
        _complain(f"Launch of '{project_name}' failed; cleaning up")
        _stop_failed_launch(project, key_file)
        _clean_failed_launch(scripts_dir, registry_path, project_name, key_file, launch_dir)
        return 1

    _say(session_host.attach_hint(name, project_name))
    return _record_pid(scripts_dir, registry_path, project_name, project, key_file, resume)


def register(subparsers: Any) -> None:
    # Nothing here is an option to argparse: `$1`, `--resume` and malformed forms are
    # checked as they always were, with the same messages and exit codes.
    parser = subparsers.add_parser(_COMMAND, help="start a Codex project's bridge session", add_help=False, prefix_chars="\x01")
    parser.add_argument("arguments", nargs=argparse.REMAINDER)
    parser.set_defaults(func=handler)
