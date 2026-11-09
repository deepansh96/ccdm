"""``ccdm start-session <project> [--resume <id>]``: brings up a Claude project.

The session is a Router client that holds no Discord token. A fresh launch key
revokes the previous launch; the channel server says hello to the Router with
it, and the PID is recorded only after that hello succeeds.
"""

from __future__ import annotations

import argparse
import json
import os
import secrets
import sys
import uuid
from pathlib import Path
from typing import Any, Dict, List, NamedTuple, Optional, Sequence
from uuid import uuid4

from ..platform import hooks, private_fs, session_host
from . import _launch

_EFFORTS = ("low", "medium", "high", "xhigh", "max")
_SHIM_ARGV0 = "CCDM_SHIM_ARGV0"  # Set by scripts/start-session.sh: its own $0, for the usage line.
_HOST_VARIABLES = ("CCDM_STATE_ROOT", "CCDM_SESSION_HOST", "CCDM_HOST_SOCKET")
_USAGE_ARGUMENTS = "<project_name> [--resume <session_id>]"


class _Project(NamedTuple):
    path: str
    screen: str
    model: str
    effort: str
    claude_home: str
    channel_id: str
    webhook_id: str


def _usage(invoked_as: Optional[str]) -> str:
    name = "scripts/ccdm start-session" if _launch.WIN32 else invoked_as or "scripts/start-session.sh"
    return f"Usage: {name} {_USAGE_ARGUMENTS}"


def _is_canonical_uuid(value: str) -> bool:
    try:
        return str(uuid.UUID(value)) == value
    except ValueError:
        return False


def _read_project(registry: Path, name: str) -> _Project:
    with open(registry, encoding="utf-8") as handle:
        project = json.load(handle)["projects"][name]
    effort = project.get("claude_effort")
    if effort is None or effort == "":
        effort = ""
    elif not isinstance(effort, str) or effort not in _EFFORTS:
        sys.exit("Invalid claude_effort (expected low, medium, high, xhigh, or max)")
    claude_home = _launch.expand_path(project["claude_home"]) if project.get("claude_home") else ""
    return _Project(
        _launch.expand_path(project["path"]),
        project["screen_name"],
        project.get("model") or "",
        effort,
        claude_home,
        str(project["channel_id"]),
        str(project.get("webhook_id") or ""),
    )


def _resume_ok(project: _Project, session_id: str) -> bool:
    home = _launch.effective_claude_home(project.claude_home)
    candidates = _launch.transcript_paths(home, project.path, session_id)
    if any(os.path.isfile(candidate) for candidate in candidates):
        return True
    print(
        f"No saved Claude transcript for session {session_id} in {home} (looked for {candidates[0]})",
        file=sys.stderr,
    )
    return False


class _Launch(NamedTuple):
    name: str
    root: Path
    router_state: str
    key_file: str
    launch_dir: str
    mcp_config: str
    settings: str
    ready_file: str


def _launch_paths(name: str, root: Path) -> _Launch:
    router_state = _launch.router_state_dir()
    launch_dir = os.path.join(router_state, "launches", name)
    return _Launch(
        name,
        root,
        router_state,
        os.path.join(router_state, "keys", f"{name}.key"),
        launch_dir,
        os.path.join(launch_dir, "mcp.json"),
        os.path.join(launch_dir, "settings.json"),
        os.path.join(launch_dir, "ready.json"),
    )


def _write_launch_files(project: str, launch: _Launch, channel_id: str, claude_home: str) -> Dict[str, str]:
    """Write the key, mcp.json and settings.json; returns the reminder environment."""
    invalid = not project or "/" in project or project.startswith(".") or (_launch.WIN32 and ("\\" in project or ":" in project))
    if invalid:
        sys.exit(f"Invalid project name for a Router launch: {project!r}")
    keys_dir = Path(launch.router_state) / "keys"
    directory = Path(launch.launch_dir)
    for folder in (Path(launch.router_state), keys_dir, directory.parent, directory):
        private_fs.ensure_private_dir(folder)
    Path(launch.ready_file).unlink(missing_ok=True)
    # A previous launch's context percentage would be wrong for this one.
    (directory / "context.json").unlink(missing_ok=True)

    server_script = str(launch.root / "scripts" / "ccdm-channel-server.js")
    reminder_dir = _launch.reminder_state_dir()
    # The channel server records Conversation Reminder events itself; Claude and
    # its command hooks share this launch's reminder context.
    reminder_env = {
        "CCDM_REMINDER_PROJECT_ROOT": str(launch.root),
        "CCDM_REMINDER_STATE_DIR": str(reminder_dir),
        "CCDM_REMINDER_RECEIPTS_DIR": str(reminder_dir / "claude-receipts"),
        "CCDM_CLAUDE_PROJECT": project,
        "CCDM_CLAUDE_CHANNEL_ID": channel_id,
        "CCDM_CLAUDE_LAUNCH_ID": str(uuid4()),
        "CCDM_CLAUDE_HOOK_SETTINGS": launch.settings,
    }
    server_args = [server_script]
    if _launch.WIN32:
        server_args += ["--ccdm-key-file", launch.key_file]  # Another process's environment is not readable on Windows.
    config = {"mcpServers": {"ccdm": {
        "command": "node",
        "args": server_args,
        "env": {
            **reminder_env,
            "CCDM_ROUTER_STATE_DIR": launch.router_state,
            "CCDM_ROUTER_KEY_FILE": launch.key_file,
            "CCDM_CHANNEL_READY_FILE": launch.ready_file,
        },
    }}}
    private_fs.write_private(launch.mcp_config, json.dumps(config, indent=2) + "\n")
    # The official Discord plugin must not load beside the CCDM channel. Hook
    # commands are command hooks: no prompt/agent hook can invoke a model.
    hook = hooks.hook_command(launch.root / "scripts" / "claude-reminder-hook.js")
    settings: Dict[str, Any] = {
        "enabledPlugins": {"discord@claude-plugins-official": False},
        "hooks": {event: [{"hooks": [{"type": "command", "command": hook}]}]
                  for event in ("SessionStart", "Stop", "StopFailure", "SessionEnd")},
    }
    if _launch.WIN32:
        settings["statusLine"] = _launch.status_line_setting(launch.root, _launch.effective_claude_home(claude_home))
    private_fs.write_private(launch.settings, json.dumps(settings, indent=2) + "\n")
    private_fs.write_private(directory / "reminder-env.json", json.dumps(reminder_env) + "\n")
    # Replacing the key revokes whichever session still holds the old one.
    private_fs.write_private(launch.key_file, secrets.token_urlsafe(32) + "\n")
    return reminder_env


def _claude_argv(claude: Sequence[Any], project: _Project, launch: _Launch, resume: str) -> List[str]:
    program, leading, _ = claude
    argv = [
        program, *leading,
        "--dangerously-load-development-channels", "server:ccdm",
        "--dangerously-skip-permissions",
        "--mcp-config", launch.mcp_config,
        "--settings", launch.settings,
    ]
    if project.model:
        argv += ["--model", project.model]
    if project.effort:
        argv += ["--effort", project.effort]
    if resume:
        argv += ["--resume", resume]
    return argv


def _session_env(claude: Sequence[Any], project: _Project, launch: _Launch, reminder_env: Dict[str, str]) -> Dict[str, str]:
    env = {"CCDM_ROUTER_KEY_FILE": launch.key_file, **reminder_env}
    if project.claude_home:
        env["CLAUDE_CONFIG_DIR"] = project.claude_home
    elif session_host.backend_name() != "tmux" and os.environ.get("CLAUDE_CONFIG_DIR"):
        # ccdm-host builds the session's environment from nothing but this.
        env["CLAUDE_CONFIG_DIR"] = os.environ["CLAUDE_CONFIG_DIR"]
    if session_host.backend_name() != "tmux":
        # The session's channel server finds this same host for /restart and the relay.
        env.update({name: os.environ[name] for name in _HOST_VARIABLES if os.environ.get(name)})
    env.update(claude[2])
    return env


def _cleanup_failed_launch(project: str, launch: _Launch, session: str) -> None:
    print(f"Launch of '{project}' failed; cleaning up", file=sys.stderr, flush=True)
    try:
        session_host.stop(session)
    except session_host.SessionHostError:
        pass
    _launch.stop_listeners(_launch.listener_pids(launch.key_file, launch.launch_dir))
    _launch.remove_launch_files(launch.key_file, launch.launch_dir)
    _launch.clear_capability_marker(project)


def _record(registry: Path, project_name: str, name: str, launch: _Launch, project: _Project) -> None:
    on_tmux = session_host.backend_name() == "tmux"
    # Today's rule on tmux: ~/.claude unless the project sets claude_home.
    home = (project.claude_home or "~/.claude") if on_tmux else _launch.effective_claude_home(project.claude_home)
    pid, started_at = _launch.find_claude_process(name, launch.key_file, home)
    if not pid:
        print("Warning: started session, but could not find Claude listener PID to record", flush=True)
        return
    session_id = _launch.read_session_id(home, pid)
    fields: Dict[str, Any] = {"pid": pid, "session_id": session_id}
    if started_at is not None:
        fields["pid_started_at"] = started_at
    _launch.set_project_fields(registry, project_name, fields)
    if session_id:
        print(f"Recorded PID {pid} and session {session_id}", flush=True)
    else:
        print(f"Recorded PID {pid}; session_id not found yet", flush=True)


def _start(project_name: str, resume: str, project: _Project, root: Path, registry: Path) -> int:
    """Everything after the arguments are checked, in the shell launcher's order."""
    name = project.screen
    if session_host.is_live(name):
        if resume:
            print(
                f"Refusing to resume '{project_name}': session '{name}' is already running. "
                f"Run {_launch.script_ref('stop-session')} '{project_name}' first, then retry.",
                file=sys.stderr,
            )
            return 1
        print(f"Session '{name}' is already running.")
        return 0
    if resume and not _resume_ok(project, resume):
        print(f"Refusing to resume '{project_name}': its transcript is missing from the project's Claude home.", file=sys.stderr)
        return 1

    launch = _launch_paths(project_name, root)
    existing = _launch.listener_pids(launch.key_file, launch.launch_dir)
    if existing:
        print(f"Refusing to start '{project_name}': existing Claude Router listener process(es) already use {launch.key_file}:")
        for pid in existing:
            print(f"  {pid}")
        print(f"Run {_launch.script_ref('stop-session')} '{project_name}' first, then retry.")
        return 1
    # The Router posts replies only through the project's webhook: a project
    # without one is refused before any runtime change (key, session, PID).
    if not project.webhook_id:
        print(
            f"Refusing to start '{project_name}': it has no webhook_id, so its replies could not be posted. "
            f"Run {_launch.script_ref('migrate-to-router')} {project_name} "
            f"(or node scripts/router.js ensure-webhook {project_name}), then retry.",
            file=sys.stderr,
        )
        return 1

    try:
        claude = _launch.claude_program()
    except FileNotFoundError as error:  # Windows: Claude Code is not installed.
        print(str(error), file=sys.stderr)
        return 1
    _launch.clear_capability_marker(project_name)
    reminder_env = _write_launch_files(project_name, launch, project.channel_id, project.claude_home)
    argv = _claude_argv(claude, project, launch, resume)
    env = _session_env(claude, project, launch, reminder_env)
    try:
        session_host.start(name, argv, project.path, env, pty=True, kind="project")
    except session_host.SessionHostError as error:
        # As a failed `tmux new-session` under `set -e` did: the error, and no cleanup.
        print(str(error), file=sys.stderr)
        return 1
    resuming = f" (resuming {resume})" if resume else ""
    print(f"Started Claude Router session in {_launch.session_word()} '{name}'{resuming}", flush=True)

    # Accept Claude's start-up prompts, then wait for the channel server's Router hello.
    deadline = _launch.launch_deadline()
    try:
        dialogs = _launch.accept_dialogs(name, project.path, project.path, deadline)
        outcome = _launch.wait_ready(name, launch.ready_file, deadline, dialogs)
    except _launch.LaunchFailed as error:
        print(str(error), file=sys.stderr, flush=True)
        _cleanup_failed_launch(project_name, launch, name)
        return 1
    print(f"Channel server connected to the Router (scope {outcome['scope']['channel_id']})", flush=True)
    print(session_host.attach_hint(name, project_name), flush=True)
    _record(registry, project_name, name, launch, project)
    return 0


def _command(args: argparse.Namespace) -> int:
    invoked_as = os.environ.pop(_SHIM_ARGV0, None)
    arguments: List[str] = list(args.arguments)
    if arguments in (["-h"], ["--help"]):
        print(f"{_usage(None)}\n\nStart a Claude project's session, served through the Router.")  # No $0: a shim's --help is the same from anywhere.
        return 0
    project_name = arguments[0] if arguments else ""
    resume = ""
    if len(arguments) > 1:
        if len(arguments) != 3 or arguments[1] != "--resume":
            print(_usage(invoked_as), file=sys.stderr)
            return 1
        resume = arguments[2]
        if not _is_canonical_uuid(resume):
            print("Resume session must be a canonical UUID", file=sys.stderr)
            return 1
    if not project_name:
        print(_usage(invoked_as))
        return 1
    root = _launch.repo_root()
    registry = root / "registry.json"
    project = _read_project(registry, project_name)
    return _start(project_name, resume, project, root, registry)


def register(subparsers: Any) -> None:
    # A prefix no argument uses: arguments are checked here, in the shell launcher's order,
    # so an option-looking name keeps today's usage line and exit code.
    parser = subparsers.add_parser(
        "start-session", help="start a Claude project's session", add_help=False, prefix_chars="\x00"
    )
    parser.add_argument("arguments", nargs=argparse.REMAINDER)
    parser.set_defaults(func=_command)

