"""``ccdm setup``: first-run setup on Windows. macOS and Linux use ``./setup.sh``.

Started by ``setup.ps1``, which only finds Python. In order:

1. Checks the tools CCDM needs and the runbook links. A missing tool prints the
   one line that installs it; setup itself installs nothing. Any problem here
   exits 1 before the first question.
2. Asks for the Discord IDs, this machine's name and the guest mode, and writes
   ``registry.json`` from a dict. An existing registry is kept unless the
   operator answers ``y``.
3. Makes ``~/.claude/channels/discord`` private, checks that it is, and only
   then asks for the root bot token and writes ``.env`` there. The token is read
   without echo from a console and is never printed, logged or passed to another
   process. Without a console the prompt is refused. An existing ``.env`` is
   kept unless the operator answers ``y``.
4. Copies ``CLAUDE.local.md.example`` to ``CLAUDE.local.md`` when that is absent,
   and prints the next steps.

``CCDM_SETUP_TOKEN_STDIN=1`` is the test seam: the token is then one line of
piped stdin.
"""

from __future__ import annotations

import argparse
import getpass
import json
import os
import re
import secrets
import shutil
import subprocess
import sys
import warnings
from pathlib import Path
from typing import Any, Callable, Dict, List, NamedTuple, Optional, Tuple

from ..platform import atomic, exe, private_fs

WIN32 = sys.platform == "win32"
ROOT = Path(__file__).resolve().parents[3]

_TOKEN_STDIN = "CCDM_SETUP_TOKEN_STDIN"
_MINIMUM_NODE = (22, 5)
_PROBE_TIMEOUT_SECONDS = 20
_RUNBOOK_LINKS = ("CLAUDE.md", ".mex/AGENTS.md")
_GUEST_MODES = ("member-overwrites", "none")
# "none" until the guest calls of member-overwrites mode are recorded as working
# against real Discord for every one of them; then this becomes "member-overwrites".
_DEFAULT_GUEST_MODE = "none"
_DEFAULT_MACHINE_ID = "win"
_DEFAULT_MACHINE_LABEL = "Windows"
_MACHINE_ID = re.compile(r"[a-z0-9][a-z0-9-]{0,31}")
_MAX_LABEL_CHARS = 64
_YES = ("y", "yes")

_VALIDATE_REGISTRY = (
    "const { validateRegistry } = require(process.argv[1]);"
    "let text = '';"
    "process.stdin.setEncoding('utf8').on('data', chunk => { text += chunk; }).on('end', () => {"
    "  try { validateRegistry(JSON.parse(text)); }"
    "  catch (error) { console.error(error.message); process.exit(1); }"
    "});"
)


class SetupError(Exception):
    """Setup stops here; the lines say why and what to do."""

    def __init__(self, *lines: str) -> None:
        super().__init__(lines[0] if lines else "")
        self.lines = lines


# ---- tools ----


class _Tool(NamedTuple):
    name: str
    find: Callable[[], Optional[str]]
    install: str


def _resolved(resolver: Callable[[], Dict[str, Any]]) -> Callable[[], Optional[str]]:
    def find() -> Optional[str]:
        try:
            return str(resolver()["command"])
        except exe.ToolNotFound:
            return None
    return find


def _on_path(name: str) -> Callable[[], Optional[str]]:
    def find() -> Optional[str]:
        found = exe._on_path(name)  # pylint: disable=protected-access
        return found[0] if found else None
    return find


_REQUIRED = (
    _Tool("node", _resolved(exe.node), "winget install OpenJS.NodeJS.LTS"),
    _Tool("git", _on_path("git"), "winget install Git.Git"),
    _Tool("claude", _resolved(exe.claude), "see https://docs.anthropic.com/en/docs/claude-code"),
    _Tool("codex", _resolved(exe.codex), "npm install -g @openai/codex"),
    _Tool("ffmpeg", _on_path("ffmpeg"), "winget install Gyan.FFmpeg"),
)
_WHISPER = _Tool("whisper", _resolved(exe.whisper), "py -3 -m pip install openai-whisper")


def _node_version(node: str) -> Optional[Tuple[int, int]]:
    try:
        completed = subprocess.run(
            [node, "--version"], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            timeout=_PROBE_TIMEOUT_SECONDS, check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    match = re.match(r"v(\d+)\.(\d+)", completed.stdout.decode("utf-8", "replace").strip())
    return (int(match.group(1)), int(match.group(2))) if match else None


def _check_tools() -> Tuple[List[str], Optional[str]]:
    """The lines for what is missing, and Node's path when it is usable."""
    wanted = ".".join(str(part) for part in _MINIMUM_NODE)
    missing = []
    node = None
    for tool in _REQUIRED:
        found = tool.find()
        if found is None:
            missing.append(f"{tool.name}: {tool.install}")
        elif tool.name == "node":
            version = _node_version(found)
            if version is None:
                missing.append(f"node: {found} did not report its version; {tool.install}")
            elif version < _MINIMUM_NODE:
                missing.append(f"node {wanted} or newer (found {version[0]}.{version[1]}): {tool.install}")
            else:
                node = found
    return missing, node


# ---- the runbook links ----


def _runbook_problems() -> List[str]:
    """CLAUDE.md and .mex/AGENTS.md are committed as symlinks to AGENTS.md. A
    clone made without symlink support has small text files there instead, and
    the agent then loads no runbook."""
    target = ROOT / "AGENTS.md"
    try:
        runbook = target.read_bytes()
    except OSError:
        return ["AGENTS.md is missing; run setup from a complete clone"]
    problems = []
    for name in _RUNBOOK_LINKS:
        file = ROOT.joinpath(*name.split("/"))
        try:
            if file.is_symlink():
                good = file.exists() and os.path.samefile(file, target)
            else:
                good = file.is_file() and file.read_bytes() == runbook
        except OSError:
            good = False
        if not good:
            problems.append(f"{name} is neither a symlink to AGENTS.md nor a copy of it, so the agent would load no runbook")
    return problems


_RUNBOOK_FIX = (
    "Fix: turn on Developer Mode in Windows Settings (System > For developers), run",
    "  git config --global core.symlinks true",
    "and clone the repository again. Then run setup in the new clone.",
)


# ---- questions ----


def _answer(prompt: str) -> str:
    """One line from the operator; the end of input counts as Enter."""
    try:
        return input(prompt).strip()
    except EOFError:
        print()
        return ""


def _ask_id(what: str, prompt: str) -> str:
    value = _answer(prompt)
    if not value:
        raise SetupError(f"Error: {what} is required.")
    if not value.isascii() or not value.isdigit():
        raise SetupError(f"Error: {what} must be a Discord ID, which is digits only.")
    return value


def _ask_default(prompt: str, default: str) -> str:
    return _answer(f"{prompt} [{default}]: ") or default


def _confirmed(prompt: str) -> bool:
    return _answer(prompt).lower() in _YES


def _ask_registry() -> Dict[str, Any]:
    print("Discord IDs: in Discord, turn on Settings > Advanced > Developer Mode, then")
    print("right-click a name, server, channel or category and choose Copy ID.")
    print()
    owner = _ask_id("your Discord user ID", "Your Discord user ID: ")
    guild = _ask_id("the Discord server ID", "Discord server ID: ")
    root_channel = _ask_id("the root channel ID", "Root channel ID (the private channel where you talk to root): ")
    category = _ask_id("the category ID", "Category ID for this machine's project channels: ")
    print()
    machine_id = _ask_default("Machine id", _DEFAULT_MACHINE_ID)
    if not _MACHINE_ID.fullmatch(machine_id):
        raise SetupError("Error: the machine id is 1 to 32 lower-case letters, digits or hyphens, starting with a letter or digit.")
    label = _ask_default("Machine label", _DEFAULT_MACHINE_LABEL)
    if len(label) > _MAX_LABEL_CHARS or not label.isprintable():
        raise SetupError(f"Error: the machine label is at most {_MAX_LABEL_CHARS} printable characters.")
    print()
    print("Guest mode: how people you invite are let into one project channel.")
    print("  none               no new guests can be added from this machine")
    print("  member-overwrites  each guest gets their own permission on the project channel;")
    print("                     choose it only once those calls are known to work on your server")
    guest_mode = _ask_default("Guest mode", _DEFAULT_GUEST_MODE)
    if guest_mode not in _GUEST_MODES:
        raise SetupError("Error: guest mode must be member-overwrites or none.")
    return {
        "discord_user_id": owner,
        "guild_id": guild,
        "root_channels": [root_channel],
        "root_allowed_user_ids": [],
        "codex_accounts": {},
        "default_codex_account": None,
        "category_ids": [category],
        "projects": {},
        "machine": {"id": machine_id, "label": label},
        "guest_mode": guest_mode,
    }


# ---- registry.json ----


def _validate_registry(node: str, text: str) -> None:
    """The Router's own check, so setup never writes a registry it would refuse."""
    try:
        completed = subprocess.run(
            [node, "-e", _VALIDATE_REGISTRY, str(ROOT / "scripts" / "router" / "registry.js")],
            input=text.encode("utf-8"), stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
            timeout=_PROBE_TIMEOUT_SECONDS, check=False,
        )
    except (OSError, subprocess.SubprocessError) as error:
        raise SetupError(f"Error: the registry could not be checked: {error}") from None
    if completed.returncode != 0:
        reason = completed.stderr.decode("utf-8", "replace").strip() or f"node exited with {completed.returncode}"
        raise SetupError(f"Error: registry.json was not written: {reason}")


def _write_registry(path: Path, text: str) -> None:
    """Whole or not at all, and private like every later rewrite of it."""
    temporary = path.with_name(f".{path.name}.{os.getpid()}.{secrets.token_hex(4)}.tmp")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as stream:
            stream.write(text)
            stream.flush()
            os.fsync(stream.fileno())
        private_fs.make_file_private(temporary)
        atomic.replace_with_retry(temporary, path)
    except BaseException:
        try:
            os.unlink(temporary)
        except OSError:
            pass
        raise


def _registry_step(node: str) -> None:
    path = ROOT / "registry.json"
    if path.exists() and not _confirmed("registry.json already exists. Overwrite it? (y/N): "):
        print("Keeping the existing registry.json.")
        return
    text = json.dumps(_ask_registry(), indent=2) + "\n"
    _validate_registry(node, text)
    _write_registry(path, text)
    print()
    print("Created registry.json.")


# ---- the root bot token ----


def _stdin_is_console() -> bool:
    """Whether a hidden prompt can read from stdin. isatty() is not enough: it is
    also true for the null device."""
    if not WIN32 or sys.stdin is not sys.__stdin__:
        return False
    try:
        import ctypes
        import msvcrt

        handle = msvcrt.get_osfhandle(sys.stdin.fileno())
        mode = ctypes.c_uint32()
        return bool(ctypes.windll.kernel32.GetConsoleMode(ctypes.c_void_p(handle), ctypes.byref(mode)))
    except (OSError, ValueError, AttributeError):
        return False


def _token_from_stdin_allowed() -> bool:
    return os.environ.get(_TOKEN_STDIN) == "1"


_NO_CONSOLE = (
    "Error: the bot token is typed at a hidden prompt, and this terminal cannot hide input",
    "(for example the Git Bash window). Nothing was asked and no token was written.",
    "Run setup from Windows Terminal or a PowerShell window:",
    "  pwsh -NoProfile -File setup.ps1",
)


def _read_token() -> str:
    """The token, never echoed. There is no fallback to a prompt that shows it."""
    prompt = "Root bot token (typing is hidden): "
    if _token_from_stdin_allowed():
        token = sys.stdin.readline().strip()
    elif not _stdin_is_console():
        raise SetupError(*_NO_CONSOLE)
    else:
        with warnings.catch_warnings():
            # getpass warns and then echoes when it cannot hide input; make that an error instead.
            warnings.simplefilter("error", getpass.GetPassWarning)
            try:
                token = getpass.getpass(prompt).strip()
            except getpass.GetPassWarning:
                raise SetupError(*_NO_CONSOLE) from None
    if not token:
        raise SetupError("Error: the bot token is required.")
    if any(char.isspace() for char in token):
        raise SetupError("Error: a bot token has no spaces in it; copy it again from the Developer Portal.")
    return token


def _token_step() -> None:
    directory = Path.home() / ".claude" / "channels" / "discord"
    env_file = directory / ".env"
    # The directory is closed to everyone else before the token is asked for.
    try:
        private_fs.ensure_private_dir(directory)
    except OSError as error:
        raise SetupError(f"Error: {error}") from None
    problems = private_fs.blockers(directory, "Root token directory")
    if problems:
        raise SetupError("Error: the token directory is not private, so no token was written:",
                         *(f"  - {problem}" for problem in problems))
    if env_file.exists():
        if not _confirmed(f"{env_file} already holds a bot token. Overwrite it? (y/N): "):
            if not private_fs.is_private(env_file):
                private_fs.make_file_private(env_file)
            print("Keeping the existing bot token.")
            return
    else:
        print("CCDM uses one Discord bot, root. Create it at https://discord.com/developers/applications")
        print("if you have not yet (the README has the steps), and copy its token.")
    token = _read_token()
    try:
        private_fs.write_private(env_file, f"DISCORD_BOT_TOKEN={token}\n")
    except OSError as error:
        raise SetupError(f"Error: the bot token could not be saved: {error}") from None
    print(f"Saved the bot token to {env_file}.")


# ---- CLAUDE.local.md and the next steps ----


def _local_notes_step() -> None:
    target = ROOT / "CLAUDE.local.md"
    if target.exists():
        print("Keeping the existing CLAUDE.local.md.")
        return
    shutil.copyfile(ROOT / "CLAUDE.local.md.example", target)
    print("Created CLAUDE.local.md from CLAUDE.local.md.example; fill in its placeholders.")


def _next_steps() -> List[str]:
    lines = ["Next steps, run from this folder:", ""]
    if not (ROOT / "node_modules").is_dir():
        lines += ["  First install the Node packages:", "       npm ci", ""]
    lines += [
        "  1. Install the services, in this order. Each one is a scheduled task for your user:",
        "       scripts\\ccdm install-service router",
        "       scripts\\ccdm install-service host",
        "       scripts\\ccdm install-service thread-supervisor",
        "       scripts\\ccdm install-service root-at-logon",
        "     The Router goes first: thread-supervisor and reminders check that it is running.",
        "     Install the host from a terminal while no session is live.",
        "     Optional, only if you want them:",
        "       scripts\\ccdm install-service reminders      (conversation reminders)",
        "       scripts\\ccdm install-service usage-poster   (collects usage history on a timer)",
        "     Each task records its environment when it is installed. After changing a path",
        "     or CLAUDE_CONFIG_DIR, install that service again from a shell with the new value.",
        "  2. Start root:",
        "       scripts\\ccdm restart-root",
        "  3. In your root channel (for example #root-win), ask root to register a project.",
        "     Give this machine's projects a name ending in -win.",
        "",
        "Claude's statusLine is written for each launch by the launchers, and a statusLine",
        "you already have keeps running through --chain. Setup does not touch Claude settings.",
    ]
    return lines


# ---- the command ----


def _run() -> int:
    print()
    print("CCDM setup for Windows")
    print()
    print("Checking tools...")
    missing, node = _check_tools()
    if missing:
        print("Missing required tools. Install each with the line beside it:")
        for line in missing:
            print(f"  - {line}")
        print("Then open a new terminal and run setup again. Setup installs nothing itself.")
        return 1
    print("  All required tools found.")
    if _WHISPER.find() is None:
        print("Note: whisper was not found, so voice messages will not be transcribed.")
        print(f"  Install it with: {_WHISPER.install}")
    problems = _runbook_problems()
    if problems:
        raise SetupError(*(f"Error: {problem}." for problem in problems), *_RUNBOOK_FIX)
    env_file = Path.home() / ".claude" / "channels" / "discord" / ".env"
    if not env_file.exists() and not _token_from_stdin_allowed() and not _stdin_is_console():
        raise SetupError(*_NO_CONSOLE)
    print()
    _registry_step(node or "node")
    print()
    _token_step()
    print()
    _local_notes_step()
    print()
    print("Setup complete.")
    print()
    for line in _next_steps():
        print(line)
    return 0


def _setup(_args: argparse.Namespace) -> int:
    if not WIN32:
        print("ccdm setup is for Windows; on macOS and Linux use ./setup.sh", file=sys.stderr)
        return 2
    try:
        return _run()
    except SetupError as error:
        for line in error.lines:
            print(line)
        return 1
    except OSError as error:
        print(f"Error: {error}")
        return 1
    except KeyboardInterrupt:
        print()
        print("Setup stopped.")
        return 130


def register(subparsers: Any) -> None:
    parser = subparsers.add_parser(
        "setup", help="first-run setup on Windows (run setup.ps1)",
        description="First-run setup on Windows: checks the tools, writes registry.json and the root bot token, "
                    "and prints the next steps. It installs nothing. Start it with setup.ps1.",
    )
    parser.set_defaults(func=_setup)
