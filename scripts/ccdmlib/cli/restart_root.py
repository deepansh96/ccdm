"""``ccdm restart-root [--provider codex [channel]]``: root comes back as a fresh session.

Root is a Router client that holds no Discord token. A restart writes a fresh
root key, which revokes the root still holding the old one, stops the running
root and starts a new one in session ``root_agent``.

Run from inside root's own session (the owner said "restart yourself"), the
command hands the work to a detached copy and exits 0, so stopping root does not
stop the restart halfway. The copy does the Router check, the stop and the
launch. Everything read-only is checked before that hand-off, so a refusal is
still printed where it was asked.

Messages keep their macOS wording on POSIX. On Windows "tmux session" reads
"session". Root Codex stays refused on Windows: the Windows root is Claude-only
until the owner's decision on a Codex root there (D2).
"""

from __future__ import annotations

import argparse
import json
import os
import re
import secrets
import shlex
import signal
import subprocess
import sys
import time
import traceback
from pathlib import Path
from typing import Any, Dict, List, NamedTuple, Optional, Sequence, Tuple

from ..platform import commands, private_fs, proc, session_host
from . import _launch
from ._detach import detach_if_self

WIN32 = sys.platform == "win32"

_NAME = "restart-root"
_ROOT_SESSION = "root_agent"
_ATTACH_TARGET = "root"
_DETACHED = "CCDM_DETACHED"
_KEY_FILE_FLAG = "--ccdm-key-file"
_BRIDGE_SCRIPT = "scripts/codex-bridge.js"

# tmux: today's waits of 1 s, 2 s and 1 s. ccdm-host: as a project stop.
_TMUX_GRACE_MS = 1000
_HOST_GRACE_MS = 2000
_JOB_EMPTY_WAIT_S = 5.0
_UNLINK_BUDGET_S = 2.0
_ROUTER_CHECK_TIMEOUT_S = 15
_DEFAULT_CODEX_LAUNCH_TIMEOUT_S = 120
_DEFAULT_ROOT_WS_PORT = "18399"
_TERM_GRACE_S = 2
_POLL_S = 0.2
_AFTER_PID_VARIABLE = "CCDM_RESTART_AFTER_PID_TIMEOUT_S"
_DEFAULT_AFTER_PID_WAIT_S = 30.0

# The detached copy is started with the CCDM* names only. These say which
# accounts and which root the caller asked for, so root comes back the same.
_CARRIED_TO_DETACHED_COPY = (
    "CLAUDE_CONFIG_DIR",
    "CODEX_HOME",
    "ROOT_CODEX_HOME",
    "ROOT_CODEX_CHANNEL_ID",
    "ROOT_CODEX_WS_PORT",
    "ROOT_CODEX_ALLOWED_USER_IDS",
    "ROOT_CODEX_BOT_APP_ID",
    "ROOT_DISCORD_STATE_DIR",
)

# ccdm-host starts a session with nothing of the caller's environment. These name
# this installation, and root's own commands need them. Names that describe the
# caller's session (CCDM_ROUTER_ROLE, CCDM_THREAD_ID and so on) are left out.
_FORWARDED_TO_HOST_SESSION = (
    "CCDM_STATE_ROOT",
    "CCDM_SESSION_HOST",
    "CCDM_HOST_SOCKET",
    "CCDM_ROUTER_SOCKET",
    "CCDM_ROUTER_STATE_DIR",
    "CCDM_ROUTER_NODE",
    "CCDM_PYTHON",
    "CCDM_REMINDER_PYTHON",
    "CCDM_REMINDER_STATE_DIR",
    "CCDM_CODEX_PATH",
)

_CODEX_ON_WINDOWS = (
    "Root Codex is not available on Windows yet: the Windows root is Claude only for now. "
    "Run scripts/ccdm restart-root for root Claude."
)


class _Refused(Exception):
    """The restart stops here; the message is what the command reports."""


class _Files(NamedTuple):
    router_state: str
    key_file: str
    launch_dir: str
    mcp_config: str
    settings: str
    ready_file: str


def _say(message: str) -> None:
    print(message, flush=True)


def _complain(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


def _on_tmux() -> bool:
    return session_host.backend_name() == "tmux"


def _files() -> _Files:
    router_state = _launch.router_state_dir()
    launch_dir = os.path.join(router_state, "launches", ".root")
    return _Files(
        router_state,
        os.path.join(router_state, "keys", ".root.key"),
        launch_dir,
        os.path.join(launch_dir, "mcp.json"),
        os.path.join(launch_dir, "settings.json"),
        os.path.join(launch_dir, "ready.json"),
    )


def _unlink(*paths: str) -> None:
    for path in paths:
        # A just-stopped process can hold its files for a moment on Windows.
        deadline = time.monotonic() + _UNLINK_BUDGET_S
        while True:
            try:
                Path(path).unlink(missing_ok=True)
                break
            except OSError:
                if not WIN32 or time.monotonic() >= deadline:
                    break  # The next launch replaces it.
                time.sleep(0.05)


# --- the Router check ----------------------------------------------------


def _router_node() -> str:
    configured = os.environ.get("CCDM_ROUTER_NODE")
    if configured or not WIN32:
        return configured or "node"
    from ..platform import exe

    return exe.node()["command"]


def _router_answers(root: Path) -> bool:
    """Whether the Router answers ``router.js status``; says why not.

    A restart rotates root's key and stops the running root, and the new root can
    only say hello to a live Router. While the Router is down the running root is
    the only way to reach root, so it and its key are left alone. The check is
    read-only and bounded.
    """
    try:
        status = subprocess.run(
            [_router_node(), str(root / "scripts" / "router.js"), "status"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=_ROUTER_CHECK_TIMEOUT_S,
        )
        problem = (status.stderr.strip() or "Router status check failed") if status.returncode else None
    except (OSError, subprocess.TimeoutExpired) as error:
        problem = f"Router status check failed: {error}"
    if problem is None:
        return True
    _complain(problem)
    _complain(
        "The Router is not answering, so root was not restarted: the running root and its key are unchanged. "
        f"Start the Router ({commands.installer_ref('router')}, or node scripts/router.js serve) and retry."
    )
    return False


# --- stopping the running root -------------------------------------------


def _hand_off_if_inside_root(args: argparse.Namespace) -> None:
    """Return in the process that goes on to stop root: never one inside root's own session.

    Called after every read-only check and before the first change. Inside
    root's session the work moves to a detached copy of this command line, which
    starts again from the top, and this process exits 0.
    """
    detach_if_self(_ROOT_SESSION, forward=_CARRIED_TO_DETACHED_COPY)
    # A tmux server started below would hand this to every later session, which
    # could then stop itself in the foreground.
    os.environ.pop(_DETACHED, None)
    if args.after_pid is None:
        return
    # The root that asked for the restart finishes its own cleanup first. At the
    # limit the restart goes on, and the stop ends that process.
    limit = float(os.environ.get(_AFTER_PID_VARIABLE) or _DEFAULT_AFTER_PID_WAIT_S)
    deadline = time.monotonic() + limit
    while proc.alive(args.after_pid, args.after_started_at) and time.monotonic() < deadline:
        time.sleep(_POLL_S)


def _stop_running_root(files: _Files) -> None:
    """Stop session ``root_agent``, whether it is Claude or Codex.

    On tmux this is today's sequence: TERM to the pane's children, kill the
    session, and once more if it survived. On ccdm-host the session's Job ends,
    and the restart goes on only once the Job is empty.
    """
    if _on_tmux():
        session_host.stop(_ROOT_SESSION, _TMUX_GRACE_MS)
        return
    session_host.stop(_ROOT_SESSION, _HOST_GRACE_MS)
    deadline = time.monotonic() + _JOB_EMPTY_WAIT_S
    while session_host.pids(_ROOT_SESSION):
        if time.monotonic() >= deadline:
            raise _Refused(f"Session '{_ROOT_SESSION}' still has running processes after the stop; root was not started.")
        time.sleep(_POLL_S)
    if WIN32:
        # A listener that left the Job is found by this launch's own paths on its command line.
        _launch.stop_listeners(_launch.listener_pids(files.key_file, files.launch_dir))


def _prepare_private_dirs(files: _Files) -> None:
    launch = Path(files.launch_dir)
    for directory in (Path(files.router_state), Path(files.router_state) / "keys", launch.parent, launch):
        private_fs.ensure_private_dir(directory)
    # A previous launch's outcome and context percentage are wrong for this one.
    _unlink(files.ready_file, os.path.join(files.launch_dir, "context.json"))


def _write_fresh_key(files: _Files) -> None:
    # Replacing the key revokes the root session still holding the old one.
    private_fs.write_private(files.key_file, secrets.token_urlsafe(32) + "\n")


def _forwarded_to_host_session() -> Dict[str, str]:
    if _on_tmux():
        return {}  # A tmux session has the tmux server's environment, as it always did.
    return {name: os.environ[name] for name in _FORWARDED_TO_HOST_SESSION if os.environ.get(name)}


# --- root Claude ----------------------------------------------------------


def _write_claude_launch_files(root: Path, files: _Files) -> None:
    _prepare_private_dirs(files)
    server_args = [str(root / "scripts" / "ccdm-channel-server.js")]
    if WIN32:
        server_args += [_KEY_FILE_FLAG, files.key_file]  # Another process's environment is not readable on Windows.
    config = {"mcpServers": {"ccdm": {
        "command": "node",
        "args": server_args,
        "env": {
            "CCDM_ROUTER_ROLE": "root",
            "CCDM_ROUTER_STATE_DIR": files.router_state,
            "CCDM_ROUTER_KEY_FILE": files.key_file,
            "CCDM_CHANNEL_READY_FILE": files.ready_file,
        },
    }}}
    private_fs.write_private(files.mcp_config, json.dumps(config, indent=2) + "\n")
    # The official Discord plugin must not load beside the CCDM channel.
    settings: Dict[str, Any] = {"enabledPlugins": {"discord@claude-plugins-official": False}}
    if WIN32:
        settings["statusLine"] = _launch.status_line_setting(root, _launch.effective_claude_home(""))
    private_fs.write_private(files.settings, json.dumps(settings, indent=2) + "\n")
    _write_fresh_key(files)


def _claude_session_env(claude: Sequence[Any], files: _Files) -> Dict[str, str]:
    env = {"CCDM_ROUTER_KEY_FILE": files.key_file}
    if not _on_tmux() and os.environ.get("CLAUDE_CONFIG_DIR"):
        env["CLAUDE_CONFIG_DIR"] = os.environ["CLAUDE_CONFIG_DIR"]
    env.update(_forwarded_to_host_session())
    env.update(claude[2])
    return env


def _root_wording(message: str) -> str:
    """A shared launcher message, as the root launcher has always worded it."""
    if message.startswith("Claude exited"):
        return f"Root {message}"
    if message.startswith("The channel server"):
        return "Root" + message[len("The"):]
    return message


def _restart_claude(args: argparse.Namespace) -> int:
    root = _launch.repo_root()
    files = _files()
    try:
        claude = _launch.claude_program()
    except FileNotFoundError as error:  # Windows: Claude Code is not installed.
        _complain(str(error))
        return 1
    if not _router_answers(root):
        return 1
    _hand_off_if_inside_root(args)

    try:
        _write_claude_launch_files(root, files)
    except OSError as error:
        _complain(str(error))
        _complain("Root Claude Router launch preparation failed")
        return 1

    _stop_running_root(files)

    program, leading, _ = claude
    argv = [
        program, *leading,
        "--dangerously-load-development-channels", "server:ccdm",
        "--mcp-config", files.mcp_config,
        "--settings", files.settings,
        "--dangerously-skip-permissions",
    ]
    try:
        session_host.start(_ROOT_SESSION, argv, str(root), _claude_session_env(claude, files), pty=True, kind="root")
    except session_host.SessionHostError as error:
        _complain(str(error))
        _complain(f"Failed to create {_launch.session_word()} '{_ROOT_SESSION}'")
        return 1

    # Accept Claude's start-up prompts, then wait for the channel server's Router
    # hello as root. Folder trust is accepted only for the repo root just launched in.
    deadline = _launch.launch_deadline()
    exited = None if _on_tmux() else "Root Claude exited before its channel server said hello to the Router"
    try:
        dialogs = _launch.accept_dialogs(_ROOT_SESSION, str(root), str(root), deadline)
        _launch.wait_ready(_ROOT_SESSION, files.ready_file, deadline, dialogs, exited=exited)
    except _launch.LaunchFailed as error:
        _complain(_root_wording(str(error)))
        _complain("Root launch failed; cleaning up")
        try:
            session_host.stop(_ROOT_SESSION)
        except session_host.SessionHostError:
            pass
        _unlink(files.key_file, files.ready_file)
        return 1
    _say("Root channel server connected to the Router")
    _say(f"Restarted root agent in {_launch.session_word()} '{_ROOT_SESSION}'")
    _say(session_host.attach_hint(_ROOT_SESSION, _ATTACH_TARGET))
    return 0


# --- root Codex -----------------------------------------------------------


class _CodexRoot(NamedTuple):
    channel_id: str
    allowed_user_ids: str
    bot_app_id: str
    ws_port: str
    codex_home: str


def _read_root_channel(registry_path: str, channel_id: str) -> Tuple[str, str, str]:
    """``(channel, root bot app id, allowed user ids)`` from the registry."""
    with open(registry_path, encoding="utf-8") as stream:
        registry = json.load(stream)
    root_channels = [str(channel) for channel in registry.get("root_channels") or []]
    if not root_channels:
        raise _Refused(
            f"No root_channels in {registry_path}. "
            "Run `node scripts/router.js migrate-root-config` to move them from root's access.json."
        )
    if not channel_id:
        if len(root_channels) != 1:
            usage = "scripts/ccdm restart-root --provider codex" if WIN32 else "restart-root-codex-agent.sh"
            raise _Refused(
                f"Usage: {usage} <channel_id> (or set ROOT_CODEX_CHANNEL_ID)\n"
                "Refusing to guess because the registry lists several root channels."
            )
        channel_id = root_channels[0]
    if channel_id not in root_channels:
        raise _Refused(f"Root channel {channel_id} is not in root_channels in {registry_path}.")
    owner = str(registry.get("discord_user_id") or "")
    allowed: List[str] = []
    for user_id in [owner, *(registry.get("root_allowed_user_ids") or [])]:
        user_id = str(user_id).strip()
        if user_id and user_id not in allowed:
            allowed.append(user_id)
    return channel_id, str(registry.get("root_bot_app_id") or ""), ",".join(allowed)


def _env_values(command: str, name: str) -> List[str]:
    pattern = rf"""(?:^|\s){re.escape(name)}=(?:"([^"]*)"|'([^']*)'|([^\s]+))"""
    return [next(group for group in match.groups() if group is not None) for match in re.finditer(pattern, command)]


def _argv_of(command: str) -> List[str]:
    try:
        return shlex.split(command)
    except ValueError:
        return []


def _is_discord_plugin_path(value: str) -> bool:
    plugin_path = os.path.normpath(os.path.expanduser(value))
    roots = ("claude-plugins-official/discord", "claude-plugins-official/external_plugins/discord")
    return any(plugin_path.endswith(f"/{root}") or f"/{root}/" in plugin_path for root in roots)


def _is_legacy_claude_root(command: str, state_dir: str) -> bool:
    """A root Claude from before the Router: the Discord plugin with root's state directory."""
    target = os.path.normpath(os.path.expanduser(state_dir))
    dirs = _env_values(command, "DISCORD_STATE_DIR")
    if not any(os.path.normpath(os.path.expanduser(value)) == target for value in dirs):
        return False
    argv = _argv_of(command)
    if not argv:
        return False
    program = os.path.basename(argv[0])
    if program == "claude" and "--channels" in argv and any(arg.startswith("plugin:discord") for arg in argv):
        return True
    if program == "claude-channel-discord":
        return True
    if program != "bun":
        return False
    if any(arg == "--cwd" and _is_discord_plugin_path(argv[index + 1]) for index, arg in enumerate(argv[:-1])):
        return True
    plugin_roots = _env_values(command, "CLAUDE_PLUGIN_ROOT")
    return (
        any(os.path.basename(arg) == "server.ts" for arg in argv[1:])
        and bool(plugin_roots)
        and _is_discord_plugin_path(plugin_roots[0])
    )


def _is_root_bridge(command: str, codex: _CodexRoot, key_file: str) -> bool:
    argv = _argv_of(command)
    if len(argv) < 2 or os.path.basename(argv[0]) != "node" or not os.path.normpath(argv[1]).endswith(_BRIDGE_SCRIPT):
        return False
    return (
        bool(codex.bot_app_id and codex.bot_app_id in _env_values(command, "BOT_APP_ID"))
        or codex.ws_port in _env_values(command, "WS_PORT")
        or key_file in _env_values(command, "CCDM_ROUTER_KEY_FILE")
    )


def _is_app_server(command: str, ws_port: str) -> bool:
    argv = _argv_of(command)
    return (
        bool(argv)
        and os.path.basename(argv[0]) in ("node", "codex")
        and "app-server" in argv
        and f"ws://127.0.0.1:{ws_port}" in argv
    )


def _root_listener_pids(codex: _CodexRoot, key_file: str) -> List[str]:
    """Root's own processes that outlived its session, found in ``ps`` by their environment.

    macOS and Linux only: a Windows install starts on the Router, with nothing
    older to sweep, and another process's environment cannot be read there.
    """
    if WIN32:
        return []
    state_dir = os.environ.get("ROOT_DISCORD_STATE_DIR") or os.path.join(os.environ.get("HOME", ""), ".claude/channels/discord")
    try:
        listing = subprocess.check_output(["ps", "axeww", "-o", "pid=,command="], text=True, stderr=subprocess.DEVNULL)
    except Exception:
        return []
    found = []
    for line in listing.splitlines():
        pid_text, _, command = line.strip().partition(" ")
        if not pid_text.isdigit() or "ps axeww" in command or "python3 -" in command:
            continue
        if (
            _is_legacy_claude_root(command, state_dir)
            or _is_root_bridge(command, codex, key_file)
            or _is_app_server(command, codex.ws_port)
        ):
            found.append(pid_text)
    return found


def _collect_tree(pid: str, found: List[str]) -> None:
    if not pid.isdigit() or pid in found or not proc.alive(int(pid)):
        return
    found.append(pid)
    try:
        children = subprocess.run(["pgrep", "-P", pid], capture_output=True, text=True).stdout.split()
    except OSError:
        children = []
    for child in children:
        _collect_tree(child, found)


def _signal_all(pids: Sequence[str], signal_number: int) -> None:
    for pid in pids:
        try:
            os.kill(int(pid), signal_number)
        except OSError:
            pass


def _terminate_pids(pids: Sequence[str]) -> None:
    """TERM to each process and its descendants, then KILL to any left after 2 s."""
    tree: List[str] = []
    for pid in pids:
        _collect_tree(pid, tree)
    if not tree:
        return
    _signal_all(tree, signal.SIGTERM)
    try:
        subprocess.run(["sleep", str(_TERM_GRACE_S)], check=False)  # The program, as the shell ran it.
    except OSError:
        time.sleep(_TERM_GRACE_S)
    _signal_all([pid for pid in tree if proc.alive(int(pid))], signal.SIGKILL)


def _codex_env(root: Path, files: _Files, codex: _CodexRoot) -> Dict[str, str]:
    env = _forwarded_to_host_session()
    env.update({
        "CODEX_HOME": codex.codex_home,
        "CCDM_ROUTER_ROLE": "root",
        "CCDM_ROUTER_STATE_DIR": files.router_state,
        "CCDM_ROUTER_KEY_FILE": files.key_file,
        "CCDM_CHANNEL_READY_FILE": files.ready_file,
        "CHANNEL_ID": codex.channel_id,
        "PROJECT_DIR": str(root),
        "WS_PORT": codex.ws_port,
        "ALLOWED_USER_IDS": codex.allowed_user_ids,
        "ROOT_BOT_APP_ID": codex.bot_app_id,
        "BOT_APP_ID": codex.bot_app_id,
    })
    return env


def _wait_for_bridge_hello(ready_file: str) -> Optional[str]:
    """None once the bridge has said hello as root, else why the launch failed."""
    deadline = time.monotonic() + float(os.environ.get("CCDM_CODEX_LAUNCH_TIMEOUT_S") or _DEFAULT_CODEX_LAUNCH_TIMEOUT_S)
    while time.monotonic() < deadline:
        try:
            with open(ready_file, encoding="utf-8") as stream:
                outcome = json.load(stream)
        except (FileNotFoundError, PermissionError, json.JSONDecodeError):
            if not session_host.is_live(_ROOT_SESSION):
                return "Root Codex launch failed: bridge exited before saying hello"
            time.sleep(_POLL_S)
            continue
        if outcome.get("ok"):
            _say("Root bridge connected to the Router")
            return None
        return f"Root Codex launch failed: {outcome.get('error')}"
    return "Root Codex launch failed: the bridge never said hello to the Router"


def _restart_codex(args: argparse.Namespace) -> int:
    if WIN32:
        _complain(_CODEX_ON_WINDOWS)
        return 1
    root = _launch.repo_root()
    registry_path = str(root / "registry.json")
    files = _files()

    # Everything is validated before the running root is touched.
    channel_id = args.channel or os.environ.get("ROOT_CODEX_CHANNEL_ID") or ""
    try:
        channel_id, registry_app_id, registry_allowed = _read_root_channel(registry_path, channel_id)
    except _Refused as refusal:
        _complain(str(refusal))
        return 1
    except Exception:
        traceback.print_exc()
        return 1
    resolver = subprocess.run(
        [sys.executable, "-B", str(root / "scripts" / "resolve-codex-home.py"), registry_path, "--root"],
        stdout=subprocess.PIPE, text=True, encoding="utf-8",
    )
    if resolver.returncode != 0:
        return resolver.returncode  # Its own message is already on stderr.
    allowed_user_ids = os.environ.get("ROOT_CODEX_ALLOWED_USER_IDS") or registry_allowed
    if not allowed_user_ids:
        _complain("No allowed Discord user IDs found. Set ROOT_CODEX_ALLOWED_USER_IDS.")
        return 1
    codex = _CodexRoot(
        channel_id,
        allowed_user_ids,
        # Only used to strip root's own mention from message text; the Router
        # decides which messages address root.
        os.environ.get("ROOT_CODEX_BOT_APP_ID") or registry_app_id,
        os.environ.get("ROOT_CODEX_WS_PORT") or _DEFAULT_ROOT_WS_PORT,
        resolver.stdout.rstrip("\n"),
    )
    if not _router_answers(root):
        return 1
    _hand_off_if_inside_root(args)

    _stop_running_root(files)
    orphans = _root_listener_pids(codex, files.key_file)
    if orphans:
        _say("Cleaning remaining root listener process(es):")
        for pid in orphans:
            _say(f"  {pid}")
        _terminate_pids(orphans)
    _prepare_private_dirs(files)
    _write_fresh_key(files)

    # Nothing is typed into Codex, so the bridge needs no terminal. On ccdm-host
    # the host holds the bridge's stdin, and the key file on the command line is
    # how the bridge is found again.
    argv = ["node", _BRIDGE_SCRIPT] if _on_tmux() else ["node", _BRIDGE_SCRIPT, _KEY_FILE_FLAG, files.key_file]
    try:
        session_host.start(_ROOT_SESSION, argv, str(root), _codex_env(root, files, codex), pty=False, kind="root")
    except session_host.SessionHostError as error:
        _complain(str(error))
        _complain(f"Failed to create {_launch.session_word()} '{_ROOT_SESSION}'")
        _unlink(files.key_file)
        return 1

    failure = _wait_for_bridge_hello(files.ready_file)
    if failure is not None:
        _complain(failure)
        _complain("Root launch failed; cleaning up")
        try:
            session_host.stop(_ROOT_SESSION)
        except session_host.SessionHostError:
            pass
        _terminate_pids(_root_listener_pids(codex, files.key_file))
        _unlink(files.key_file, files.ready_file)
        return 1

    _say(f"Restarted root Codex agent in {_launch.session_word()} '{_ROOT_SESSION}'")
    _say(f"Channel: {codex.channel_id}")
    _say(session_host.attach_hint(_ROOT_SESSION, _ATTACH_TARGET))
    return 0


# --- the command ----------------------------------------------------------


def _pid(value: str) -> int:
    pid = int(value)
    if pid <= 0:
        raise ValueError(value)
    return pid


def _handler(args: argparse.Namespace) -> int:
    if args.channel is not None and args.provider != "codex":
        args.parser.error("a channel is only for root Codex: add --provider codex")
    if args.after_started_at is not None and args.after_pid is None:
        args.parser.error("--after-started-at needs --after-pid")
    try:
        return _restart_codex(args) if args.provider == "codex" else _restart_claude(args)
    except _Refused as refusal:
        _complain(str(refusal))
        return 1


def register(subparsers: Any) -> None:
    parser = subparsers.add_parser(
        _NAME,
        help="restart the root agent as a fresh session",
        description="Restart the root agent: a fresh root key, the running root stopped, and a new root "
        "started in session 'root_agent'. Run from inside root's own session, the work moves to a detached copy.",
    )
    parser.add_argument("--provider", choices=("claude", "codex"), default="claude", help="which root to start (default: claude)")
    parser.add_argument("channel", nargs="?", help="root Codex's channel; needed when the registry lists several root channels")
    parser.add_argument("--after-pid", type=_pid, metavar="PID", help="first wait up to 30 s for this process to exit")
    parser.add_argument("--after-started-at", metavar="T", help="that process's start time, so a reused PID is not waited for")
    parser.set_defaults(func=_handler, parser=parser)
