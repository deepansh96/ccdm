"""``ccdm start-thread-session``: starts one Thread Conversation's session.

Served through the Router as the ``thread`` role. The Thread Supervisor calls
:func:`run` in a launch thread of its own; on success the last stdout line is
``{"pid", "provider_conversation_id", "tmux", "provider_home"}``, and everything
else goes to stderr. A Codex thread's line also carries ``ws_port``, and on
Windows both carry ``pid_started_at``.

Each launch writes a fresh key, ``keys/.thread-<thread_id>.key``, and a launch
directory, ``launches/<project>/threads/<thread_id>/``, and runs in session
``<screen>-t-<thread id>``. A launch is refused while a process still carries
that key path. A failed launch removes its key, launch directory and session,
unless a newer launch of the thread has replaced its launch token
(``launches/.../.launch-token``), when they are that launch's and stay.
``CCDM_THREAD_BOOTSTRAP_FILE``, from the supervisor, names the bootstrap file the
channel server (or Codex bridge) waits for. The session's adapter keeps the launch
directory's ``activity.json`` (``{turn_running, last_turn_end_at}``) for the
supervisor's idle eviction.

A Codex thread runs ``codex-bridge.js`` in thread mode, with its own app-server on
``CCDM_THREAD_WS_PORT``, the port the supervisor allocated. Its account alias takes
the place of the project's ``codex_account`` in ``resolve-codex-home.py``, and its
provider conversation id is the Codex thread uuid.

``--resume`` continues the thread's provider conversation (``claude --resume``, or
the bridge's Codex thread uuid) in the same home and cwd. ``--home`` names that
home (the one the conversation started in, which the supervisor stored) when it
differs from what the project resolves to now. A missing transcript or rollout
fails the start before any key or session exists; it never starts a fresh
conversation.
"""

from __future__ import annotations

import argparse
import glob
import io
import json
import os
import re
import secrets
import subprocess
import sys
import time
import traceback
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional, Sequence, TextIO, Tuple
from uuid import uuid4

from ..platform import atomic, exe, hooks, paths, private_fs, proc, session_host
from . import _launch
from .start_codex_session import _FORWARDED_ON_WINDOWS, _KEY_FILE_FLAG, _names_key_file, _program

WIN32 = sys.platform == "win32"
_COMMAND = "start-thread-session"
_ARGUMENT_FORM = (
    "<project> <thread_id> --provider claude|codex [--account <alias>] [--model <model>] "
    "[--effort <effort>] [--resume <id>] [--home <path>]"
)
_INVOKED_AS = "CCDM_INVOKED_AS"  # Set by scripts/start-thread-session.sh: its own $0, for the usage line.
_DEFAULT_INVOCATION = f"scripts/ccdm {_COMMAND}" if WIN32 else "scripts/start-thread-session.sh"
_OPTIONS = ("--provider", "--account", "--model", "--effort", "--resume", "--home")
_ID = re.compile(r"[0-9A-Za-z_-]+")
_EFFORTS = ("low", "medium", "high", "xhigh", "max")
_DIGITS = re.compile(r"[0-9]+")
_REFUSED_IN_ANY_HOME = "'\"$`\n"
_DEFAULT_BOOT_TIMEOUT_S = 120.0
_READY_POLL_S = 0.2
_PID_ROUNDS = 20
_PID_ROUND_S = 0.5
# Time a failed launch's bridge gets to act on its stdin closing before its Job ends it.
_FAILED_BRIDGE_GRACE_MS = 3000
_CHANNEL_SERVER = "ccdm-channel-server.js"
_BRIDGE_SCRIPT = "scripts/codex-bridge.js"
_POSIX_LISTENER_SCRIPTS = (_CHANNEL_SERVER, "codex-bridge.js")
# The two shared wait messages that need this launch's timeout in them.
_TIMED_OUT = {
    _launch._CHANNEL_PROMPT_MISSING: "The development-channel confirmation never appeared within {}s",
    "The channel server never said hello to the Router": "The channel server did not say hello to the Router within {}s",
}


class _Refused(Exception):
    """The launch cannot start, and nothing has been created yet."""

    def __init__(self, message: str, code: int = 1) -> None:
        super().__init__(message)
        self.code = code


def _valid_home(value: str) -> bool:
    # The home reaches a session's launch line, so it must be a plain absolute path.
    if any(character in value for character in _REFUSED_IN_ANY_HOME):
        return False
    if WIN32:
        return paths.is_abs(value)
    return value.startswith("/") and "\\" not in value


class _ThreadLaunch:
    """One launch: every value it needs comes from ``env`` and ``cwd``, never the process's."""

    def __init__(self, argv: Sequence[str], env: Dict[str, str], cwd: str, stdout: TextIO, stderr: TextIO) -> None:
        self.argv = list(argv)
        self.env = env
        self.cwd = cwd
        self.stdout = stdout
        self.stderr = stderr
        self.on_tmux = session_host.backend_name(env) == "tmux"
        self.options: Dict[str, str] = {}
        self.root = _launch.repo_root()
        self.token = secrets.token_hex(16)

    # --- messages and the environment -----------------------------------

    def _say(self, message: str) -> None:
        print(message, file=self.stderr, flush=True)

    def _usage(self) -> _Refused:
        invoked = self.env.get(_INVOKED_AS) or _DEFAULT_INVOCATION
        return _Refused(f"Usage: {invoked} {_ARGUMENT_FORM}", 2)

    def _home_dir(self) -> str:
        return self.env.get("USERPROFILE" if WIN32 else "HOME") or str(Path.home())

    def _expand(self, value: str) -> str:
        if value == "~" or value.startswith("~/") or (WIN32 and value.startswith("~\\")):
            value = self._home_dir().rstrip("/") + value[1:]
        elif value.startswith("~") and not WIN32:
            value = os.path.expanduser(value)  # ~user comes from the password database.
        return os.path.normpath(value) if WIN32 else value

    def _state_root(self) -> str:
        override = self.env.get("CCDM_STATE_ROOT")
        if override:
            return os.path.abspath(os.path.join(self.cwd, override))
        return os.path.join(self._home_dir(), ".local", "state", "ccdm")

    def _router_state(self) -> str:
        return self.env.get("CCDM_ROUTER_STATE_DIR") or os.path.join(self._state_root(), "router")

    def _reminder_dir(self) -> Path:
        return Path(self.env.get("CCDM_REMINDER_STATE_DIR") or os.path.join(self._state_root(), "conversation-reminders"))

    def _registry_path(self) -> str:
        return os.path.join(self.cwd, self.env.get("CCDM_REGISTRY_PATH") or str(self.root / "registry.json"))

    # --- the arguments ---------------------------------------------------

    def _parse(self) -> None:
        if len(self.argv) < 2:
            raise self._usage()
        self.project, self.thread_id = self.argv[:2]
        rest = self.argv[2:]
        while rest:
            if len(rest) < 2 or rest[0] not in _OPTIONS:
                raise self._usage()
            self.options[rest[0]] = rest[1]
            rest = rest[2:]
        self.provider = self.options.get("--provider", "")
        self.account = self.options.get("--account", "")
        self.resume = self.options.get("--resume", "")
        self.home_override = self.options.get("--home", "")
        if not _ID.fullmatch(self.thread_id):
            raise _Refused(f"Invalid thread id: '{self.thread_id}'", 2)
        if self.provider not in ("claude", "codex"):
            raise self._usage()
        if self.resume and not _ID.fullmatch(self.resume):
            raise _Refused(f"Invalid conversation id to resume: '{self.resume}'", 2)
        if self.home_override:
            if not _valid_home(self.home_override):
                raise _Refused(f"Invalid conversation home: '{self.home_override}'", 2)
            if not os.path.isdir(self.home_override):
                raise _Refused(f"The conversation's home {self.home_override} is missing")

    # --- the project's settings ------------------------------------------

    def _read_registry(self) -> Mapping[str, Any]:
        with open(self._registry_path(), encoding="utf-8") as handle:
            registry = json.load(handle)
        entry = (registry.get("projects") or {}).get(self.project)
        name_invalid = (
            not self.project or "/" in self.project or self.project.startswith(".")
            or (WIN32 and ("\\" in self.project or ":" in self.project))
        )
        if not isinstance(entry, dict) or name_invalid:
            raise _Refused(f"Unknown project '{self.project}'")
        if not entry.get("webhook_id"):
            raise _Refused(f"Project '{self.project}' has no webhook_id, so its thread replies could not be posted")
        self.path_dir = self._expand(entry["path"])
        self.screen = entry["screen_name"]
        self.channel_id = str(entry.get("channel_id"))
        return registry

    def _read_claude_settings(self, registry: Mapping[str, Any]) -> None:
        entry = registry["projects"][self.project]
        # An account is an alias in `claude_accounts`, never a path.
        if self.account:
            accounts = registry.get("claude_accounts")
            home = accounts.get(self.account) if isinstance(accounts, dict) else None
            if not isinstance(home, str) or not home:
                raise _Refused(f"Unknown Claude account alias '{self.account}'")
        else:
            home = entry.get("claude_home") or ""
        # The default home leaves CLAUDE_CONFIG_DIR unset, as Claude's own default.
        config_dir = self._expand(home) if home else ""
        default_home = os.path.join(self._home_dir(), ".claude")
        if not self.on_tmux and not config_dir and self.env.get("CLAUDE_CONFIG_DIR"):
            # ccdm-host builds the session's environment from nothing but the launch's.
            config_dir = default_home = self._expand(self.env["CLAUDE_CONFIG_DIR"])
        self.claude_home = config_dir or default_home
        # A resumed conversation stays in the home it started in.
        override = self.home_override
        if override and os.path.normpath(override) != os.path.normpath(self.claude_home):
            self.claude_home = override
            config_dir = "" if os.path.normpath(override) == os.path.normpath(default_home) else override
        self.config_dir = config_dir
        self.model = self.options.get("--model") or entry.get("model") or ""
        self.effort = self.options.get("--effort") or entry.get("claude_effort") or ""
        if self.effort and self.effort not in _EFFORTS:
            raise _Refused(f"Invalid effort '{self.effort}' (expected low, medium, high, xhigh, or max)")

    def _read_codex_settings(self, registry: Mapping[str, Any]) -> None:
        entry = registry["projects"][self.project]
        allowed = [registry.get("discord_user_id")] + list(entry.get("guest_user_ids") or [])
        self.allowed_user_ids = ",".join(dict.fromkeys(str(user) for user in allowed if user))
        self.model = self.options.get("--model") or entry.get("codex_model") or entry.get("model") or ""
        self.effort = (
            self.options.get("--effort") or entry.get("codex_reasoning_effort") or entry.get("model_reasoning_effort") or ""
        )
        self.service_tier = entry.get("codex_service_tier") or entry.get("service_tier") or "default"
        self.text_reply_fallback = entry.get("text_reply_fallback") is True
        self.codex_home = self._resolve_codex_home()
        # A resumed conversation stays in the home it started in.
        if self.home_override:
            self.codex_home = self.home_override
        self.ws_port = self.env.get("CCDM_THREAD_WS_PORT", "")
        if not _DIGITS.fullmatch(self.ws_port):
            raise _Refused(f"No ws_port was allocated for Codex thread {self.thread_id}")

    def _resolve_codex_home(self) -> str:
        resolver = self.root / "scripts" / "resolve-codex-home.py"
        account = ["--account", self.account] if self.account else []
        completed = subprocess.run(
            [sys.executable, "-B", str(resolver), self._registry_path(), self.project, *account],
            env=self.env,
            cwd=self.cwd,
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            encoding="utf-8",
            creationflags=subprocess.CREATE_NO_WINDOW if WIN32 else 0,
        )
        self.stderr.write(completed.stderr)
        self.stderr.flush()
        if completed.returncode != 0:
            raise _Refused("")  # The resolver's reason is already its last stderr line.
        return completed.stdout.rstrip("\n")

    def _check_resume(self) -> None:
        if not self.resume:
            return
        if self.provider == "claude":
            transcripts = _launch.transcript_paths(self.claude_home, self.path_dir, self.resume)
            if not any(os.path.isfile(path) for path in transcripts):
                raise _Refused(f"The Claude transcript for conversation {self.resume} is missing from {self.claude_home}")
            return
        pattern = os.path.join(glob.escape(self.codex_home), "sessions", "**", f"rollout-*-{self.resume}.jsonl")
        if not glob.glob(pattern, recursive=True):
            raise _Refused(f"The Codex rollout for conversation {self.resume} is missing from {self.codex_home}")

    # --- finding this thread's processes ----------------------------------

    def _listener_pids(self) -> List[int]:
        """Processes carrying this launch's key path: the claude and channel server, or the bridge."""
        if WIN32:
            return _launch.listener_pids(self.key_file, self.launch_dir)
        return [
            pid
            for pid, command in _launch._ps_rows()
            if _launch._carries_key_file(command, self.key_file) and self._is_posix_listener(_launch._split_command(command))
        ]

    @staticmethod
    def _is_posix_listener(argv: List[str]) -> bool:
        if not argv:
            return False
        program = os.path.basename(argv[0])
        if program == "claude":
            return _launch._is_claude_listener(argv)
        if program == "codex":
            return "app-server" in argv
        return program == "node" and any(os.path.basename(arg) in _POSIX_LISTENER_SCRIPTS for arg in argv[1:])

    def _bridge_pid(self) -> Optional[int]:
        if WIN32:
            for pid in session_host.pids(self.name):
                argv = proc.command_line(pid) or []
                if _program(argv) == "node" and _names_key_file(argv, self.key_file):
                    return pid
            return None
        for pid, command in _launch._ps_rows():
            argv = _launch._split_command(command)
            if (
                len(argv) >= 2 and os.path.basename(argv[0]) == "node" and argv[1].endswith("codex-bridge.js")
                and _launch._carries_key_file(command, self.key_file)
            ):
                return pid
        return None

    # --- a failed launch ---------------------------------------------------

    def _cleanup(self) -> None:
        # A newer launch of this thread replaced the token: the key, launch dir and
        # session are that launch's now, never this one's to remove.
        try:
            current = (Path(self.launch_dir) / ".launch-token").read_text(encoding="utf-8").strip()
        except OSError:
            current = ""
        if current != self.token:
            self._say(f"Leaving thread {self.thread_id}'s launch files to its newer launch")
            return
        grace = _FAILED_BRIDGE_GRACE_MS if self.provider == "codex" and not self.on_tmux else None
        try:
            session_host.stop(self.name, grace)
        except session_host.SessionHostError:
            pass
        _launch.stop_listeners(self._listener_pids())
        _launch.remove_launch_files(self.key_file, self.launch_dir)

    def _fail(self, reason: str) -> int:
        self._say(reason)
        self._cleanup()
        return 1

    def _give_up(self, reason: str) -> int:
        # The wait's own reason, then the launch's: a failed launch has always said it twice.
        self._say(reason)
        return self._fail(reason)

    # --- the launch files -----------------------------------------------

    def _reminder_env(self) -> Dict[str, str]:
        reminder_dir = self._reminder_dir()
        with open(self._registry_path(), encoding="utf-8") as handle:
            channel_id = str(json.load(handle)["projects"][self.project]["channel_id"])
        # The channel server and the command hooks record this thread's Conversation
        # Reminder events, with the thread as their conversation.
        return {
            "CCDM_REMINDER_PROJECT_ROOT": str(self.root),
            "CCDM_REMINDER_STATE_DIR": str(reminder_dir),
            "CCDM_REMINDER_RECEIPTS_DIR": str(reminder_dir / "claude-receipts"),
            "CCDM_CLAUDE_PROJECT": self.project,
            "CCDM_CLAUDE_CHANNEL_ID": channel_id,
            "CCDM_CLAUDE_CONVERSATION_ID": self.thread_id,
            "CCDM_CLAUDE_LAUNCH_ID": str(uuid4()),
        }

    def _write_launch_files(self) -> Optional[Dict[str, str]]:
        launch = Path(self.launch_dir)
        # A fresh launch directory: no previous launch's ready, context or bootstrap file.
        try:
            atomic.remove_tree_with_retry(launch)
        except OSError:
            pass
        for directory in (Path(self.router_state), Path(self.key_file).parent, launch.parent.parent.parent,
                          launch.parent.parent, launch.parent, launch):
            private_fs.ensure_private_dir(directory)
        # The token first: from here on this launch owns the key and the launch dir.
        private_fs.write_private(launch / ".launch-token", self.token + "\n")
        private_fs.write_private(self.key_file, secrets.token_urlsafe(32) + "\n")
        # A Codex bridge takes its settings from its session's environment instead.
        if self.provider == "codex":
            return None
        scripts = self.root / "scripts"
        reminder_env = self._reminder_env()
        env = {
            **reminder_env,
            "CCDM_ROUTER_STATE_DIR": self.router_state,
            "CCDM_ROUTER_KEY_FILE": self.key_file,
            "CCDM_CHANNEL_READY_FILE": str(launch / "ready.json"),
            "CCDM_THREAD_ID": self.thread_id,
            "CCDM_THREAD_PROVIDER": "claude",
            "CCDM_THREAD_BOOTSTRAP_FILE": self.bootstrap_file,
            "CCDM_THREAD_ACTIVITY_FILE": str(launch / "activity.json"),
        }
        if self.env.get("CCDM_THREAD_BOOT_TIMEOUT_S"):
            env["CCDM_THREAD_BOOT_TIMEOUT_S"] = self.env["CCDM_THREAD_BOOT_TIMEOUT_S"]
        # The key path as an argument too: another process's environment is not readable on Windows.
        config = {"mcpServers": {"ccdm": {
            "command": "node", "args": [str(scripts / _CHANNEL_SERVER), _KEY_FILE_FLAG, self.key_file], "env": env,
        }}}
        private_fs.write_private(launch / "mcp.json", json.dumps(config, indent=2) + "\n")
        # The official Discord plugin must not load beside the CCDM channel. The Stop
        # and StopFailure command hooks mark the turn ended in activity.json; the
        # reminder hook records the turn's completion.
        activity_hook = hooks.hook_command(scripts / "thread-activity.js", launch / "activity.json")
        reminder_hook = hooks.hook_command(scripts / "claude-reminder-hook.js")
        settings: Dict[str, Any] = {
            "enabledPlugins": {"discord@claude-plugins-official": False},
            "hooks": {event: [{"hooks": [{"type": "command", "command": command}
                                         for command in ([activity_hook] if event in ("Stop", "StopFailure") else [])
                                         + [reminder_hook]]}]
                      for event in ("SessionStart", "Stop", "StopFailure", "SessionEnd")},
        }
        if WIN32:
            settings["statusLine"] = _launch.status_line_setting(self.root, self.claude_home)
        private_fs.write_private(launch / "settings.json", json.dumps(settings, indent=2) + "\n")
        private_fs.write_private(launch / "reminder-env.json", json.dumps(reminder_env) + "\n")
        return reminder_env

    # --- the session -----------------------------------------------------

    def _forwarded(self) -> Dict[str, str]:
        # ccdm-host starts a session with none of the caller's CCDM* variables, and the
        # channel server needs these to find the host when it types into its own session.
        if self.on_tmux:
            return {}
        return {name: self.env[name] for name in _FORWARDED_ON_WINDOWS if self.env.get(name)}

    def _start_claude(self, reminder_env: Dict[str, str]) -> int:
        launch = Path(self.launch_dir)
        program, leading, program_env = self.claude
        argv = [
            program, *leading,
            "--dangerously-load-development-channels", "server:ccdm",
            "--dangerously-skip-permissions",
            "--mcp-config", str(launch / "mcp.json"),
            "--settings", str(launch / "settings.json"),
        ]
        if self.model:
            argv += ["--model", self.model]
        if self.effort:
            argv += ["--effort", self.effort]
        if self.resume:
            argv += ["--resume", self.resume]
        env = {**self._forwarded(), "CCDM_ROUTER_KEY_FILE": self.key_file, **reminder_env}
        if self.config_dir:
            env["CLAUDE_CONFIG_DIR"] = self.config_dir
        env.update(program_env)
        try:
            session_host.start(self.name, argv, self.path_dir, env, pty=True, kind="thread")
        except session_host.SessionHostError as error:
            self._say(str(error))
            return self._fail(self._could_not_start())
        self._say(f"Started Claude thread session in {_launch.session_word()} '{self.name}'")

        # Accept Claude's start-up prompts, then wait for the channel server's
        # Router hello; the boot timeout covers both.
        deadline = time.monotonic() + self.timeout
        try:
            dialogs = _launch.accept_dialogs(self.name, self.path_dir, self.path_dir, deadline)
            _launch.wait_ready(self.name, str(launch / "ready.json"), deadline, dialogs,
                               exited="Claude exited before its Router hello")
        except _launch.LaunchFailed as error:
            reason = str(error)
            template = _TIMED_OUT.get(reason)
            return self._give_up(template.format(f"{self.timeout:g}") if template else reason)

        # The Claude listener's PID, and its session id from <claude_home>/sessions/<pid>.json.
        pid, started_at = _launch.find_claude_process(self.name, self.key_file, self.claude_home)
        if not pid:
            return self._give_up("The thread session's Claude process could not be found")
        session_id = _launch.read_session_id(self.claude_home, pid)
        return self._succeed({"pid": pid, "provider_conversation_id": session_id, "tmux": self.name,
                              "provider_home": self.claude_home}, started_at)

    def _codex_env(self) -> Dict[str, str]:
        launch = Path(self.launch_dir)
        env = {
            **self._forwarded(),
            "CODEX_HOME": self.codex_home,
            "CCDM_CODEX_PROJECT": self.project,
            "CCDM_ROUTER_STATE_DIR": self.router_state,
            "CCDM_ROUTER_KEY_FILE": self.key_file,
            "CCDM_CHANNEL_READY_FILE": str(launch / "ready.json"),
            "CHANNEL_ID": self.thread_id,
            "PROJECT_DIR": self.path_dir,
            "WS_PORT": self.ws_port,
            "ALLOWED_USER_IDS": self.allowed_user_ids,
            "CCDM_THREAD_ID": self.thread_id,
            "CCDM_THREAD_PROVIDER": "codex",
            "CCDM_THREAD_BOOTSTRAP_FILE": self.bootstrap_file,
            "CCDM_THREAD_ACTIVITY_FILE": str(launch / "activity.json"),
        }
        if self.env.get("CCDM_THREAD_BOOT_TIMEOUT_S"):
            env["CCDM_THREAD_BOOT_TIMEOUT_S"] = self.env["CCDM_THREAD_BOOT_TIMEOUT_S"]
        env["CODEX_SERVICE_TIER"] = self.service_tier
        if self.model:
            env["CODEX_MODEL"] = self.model
        if self.effort:
            env["CODEX_REASONING_EFFORT"] = self.effort
        if self.text_reply_fallback:
            env["CODEX_BRIDGE_TEXT_REPLY_FALLBACK"] = "1"
        transcribe = self.env.get("CODEX_BRIDGE_TRANSCRIBE_AUDIO") or self.env.get("USE_AUDIO_TRANSCRIPTION_IN_BRIDGE") or ""
        if transcribe:
            env["CODEX_BRIDGE_TRANSCRIBE_AUDIO"] = transcribe
        if self.resume:
            env["CODEX_RESUME_THREAD_ID"] = self.resume
        return env

    def _wait_for_bridge(self) -> Dict[str, Any]:
        """The bridge's ready.json once it says ok; it reports its Router hello and Codex thread uuid."""
        ready_file = os.path.join(self.launch_dir, "ready.json")
        retryable = (FileNotFoundError, json.JSONDecodeError, PermissionError) if WIN32 else (FileNotFoundError, json.JSONDecodeError)
        deadline = time.monotonic() + self.timeout
        outcome: Optional[Dict[str, Any]] = None
        while time.monotonic() < deadline:
            try:
                with open(ready_file, encoding="utf-8") as handle:
                    outcome = json.load(handle)
                break
            except retryable:
                if not session_host.is_live(self.name):
                    raise _launch.LaunchFailed("The Codex bridge exited before its Router hello")
                time.sleep(_READY_POLL_S)
        if outcome is None:
            raise _launch.LaunchFailed(f"The Codex bridge did not say hello to the Router within {self.timeout:g}s")
        if not outcome.get("ok"):
            raise _launch.LaunchFailed(f"The Codex bridge failed to start: {outcome.get('error')}")
        return outcome

    def _start_codex(self) -> int:
        # The bridge runs from this checkout; its app-server and turns run in the project path.
        if WIN32:
            argv = [exe.node()["command"], _BRIDGE_SCRIPT, _KEY_FILE_FLAG, self.key_file]
        else:
            argv = ["node", _BRIDGE_SCRIPT]
        try:
            session_host.start(self.name, argv, str(self.root), self._codex_env(), pty=False, kind="thread")
        except session_host.SessionHostError as error:
            self._say(str(error))
            return self._fail(self._could_not_start())
        self._say(f"Started Codex thread bridge in {_launch.session_word()} '{self.name}'")
        try:
            outcome = self._wait_for_bridge()
        except _launch.LaunchFailed as error:
            return self._give_up(str(error))
        pid = None
        for _ in range(_PID_ROUNDS):
            pid = self._bridge_pid()
            if pid:
                break
            time.sleep(_PID_ROUND_S)
        if not pid:
            return self._give_up("The thread session's Codex bridge process could not be found")
        return self._succeed({"pid": pid, "provider_conversation_id": outcome.get("provider_conversation_id"),
                              "tmux": self.name, "provider_home": self.codex_home, "ws_port": int(self.ws_port)},
                             proc.start_time(pid) if WIN32 else None)

    def _could_not_start(self) -> str:
        return f"{'tmux' if self.on_tmux else 'ccdm-host'} could not start the thread session"

    def _succeed(self, result: Dict[str, Any], started_at: Optional[str]) -> int:
        if WIN32:
            # A PID alone can be reused on Windows; the thread store has room for only the PID.
            result["pid_started_at"] = started_at
            private_fs.write_private(Path(self.launch_dir) / "runtime.json",
                                     json.dumps({"pid": result["pid"], "pid_started_at": started_at}) + "\n")
        self._say(session_host.attach_hint(self.name, self.name))
        print(json.dumps(result), file=self.stdout, flush=True)
        return 0

    # --- the whole launch --------------------------------------------------

    def execute(self) -> int:
        self._parse()
        # The project's settings, with the thread's overrides applied.
        registry = self._read_registry()
        if self.provider == "claude":
            self._read_claude_settings(registry)
        else:
            self._read_codex_settings(registry)
        self._check_resume()

        self.router_state = self._router_state()
        self.key_file = os.path.join(self.router_state, "keys", f".thread-{self.thread_id}.key")
        self.launch_dir = os.path.join(self.router_state, "launches", self.project, "threads", self.thread_id)
        self.name = f"{self.screen}-t-{self.thread_id}"
        self.bootstrap_file = self.env.get("CCDM_THREAD_BOOTSTRAP_FILE") or os.path.join(self.launch_dir, "bootstrap.json")
        self.timeout = float(self.env.get("CCDM_THREAD_BOOT_TIMEOUT_S") or _DEFAULT_BOOT_TIMEOUT_S)

        existing = self._listener_pids()
        if existing:
            raise _Refused(f"Refusing to start thread {self.thread_id}: listener process(es) already use "
                           f"{self.key_file}: {' '.join(str(pid) for pid in existing)}")
        if session_host.is_live(self.name):
            raise _Refused(f"Refusing to start thread {self.thread_id}: {_launch.session_word()} '{self.name}' is already running")
        if self.provider == "claude":
            try:
                self.claude = _launch.claude_program()
            except FileNotFoundError as error:  # Windows: Claude Code is not installed.
                raise _Refused(str(error))

        try:
            reminder_env = self._write_launch_files()
        except Exception:
            self.stderr.write(traceback.format_exc())
            return self._fail("The thread launch files could not be written")
        try:
            return self._start_claude(reminder_env) if self.provider == "claude" else self._start_codex()
        except (session_host.SessionHostError, OSError, ValueError, KeyError) as error:
            return self._fail(str(error) or type(error).__name__)


def _execute(argv: Sequence[str], env: Dict[str, str], cwd: str, stdout: TextIO, stderr: TextIO) -> int:
    try:
        return _ThreadLaunch(argv, env, cwd, stdout, stderr).execute()
    except _Refused as refused:
        if str(refused):
            print(str(refused), file=stderr, flush=True)
        return refused.code
    except session_host.SessionHostError as error:
        print(str(error), file=stderr, flush=True)
        return 1
    except Exception:
        stderr.write(traceback.format_exc())
        stderr.flush()
        return 1


def run(argv: Sequence[str], env: Mapping[str, str], cwd: str) -> Tuple[int, str, str]:
    """Launch a thread's session: ``argv`` as for the command, returning ``(returncode, stdout, stderr)``.

    For the Thread Supervisor, which calls this on several threads at once. A launch's
    settings come only from ``env`` and ``cwd``; it reads and writes nothing in
    ``os.environ``, never changes the process's working directory and never exits it.
    Which session host to use is the seam's choice, from the same environment.
    """
    stdout, stderr = io.StringIO(), io.StringIO()
    returncode = _execute(argv, dict(env), cwd, stdout, stderr)
    return returncode, stdout.getvalue(), stderr.getvalue()


def _command(args: argparse.Namespace) -> int:
    arguments: List[str] = list(args.arguments)
    if arguments in (["--help"], ["-h"]):
        print(f"Usage: {_DEFAULT_INVOCATION} {_ARGUMENT_FORM}\n\nStart one Thread Conversation's session.")
        return 0
    return _execute(arguments, dict(os.environ), os.getcwd(), sys.stdout, sys.stderr)


def register(subparsers: Any) -> None:
    # Nothing here is an option to argparse, so malformed arguments keep today's message and exit code.
    parser = subparsers.add_parser(_COMMAND, help="start a Thread Conversation's session", add_help=False, prefix_chars="\x01")
    parser.add_argument("arguments", nargs=argparse.REMAINDER)
    parser.set_defaults(func=_command)
