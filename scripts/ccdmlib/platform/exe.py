"""Finds the programs CCDM starts; the same choices as scripts/platform/tools.js.

On Windows a program found on PATH comes back as an absolute path, because
``subprocess`` looks in System32 before PATH for a bare name. A .cmd or .bat is
never returned; those need a shell.
"""

from __future__ import annotations

import errno
import os
import re
import stat
import subprocess
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Set

WIN32 = sys.platform == "win32"
_STORE_STUB = re.compile(r"[\\/]windowsapps[\\/]", re.IGNORECASE)
_NEEDS_SHELL = re.compile(r"\.(?:cmd|bat)$", re.IGNORECASE)
_ABSOLUTE_WIN32 = re.compile(r"(?:[a-zA-Z]:[\\/]|[\\/]{2}[^\\/])")
_PROBE_TIMEOUT_SECONDS = 10
_PRINT_EXECUTABLE = "import sys; print(sys.executable)"
_CODEX_PACKAGE = os.path.join("node_modules", "@openai", "codex")
_CODEX_TARGETS = {"x64": "x86_64-pc-windows-msvc", "arm64": "aarch64-pc-windows-msvc"}

_warned: Set[str] = set()
_probed: Dict[str, str] = {}


class ToolNotFound(FileNotFoundError):
    """A program CCDM needs is not installed where the resolver looks."""

    def __init__(self, message: str) -> None:
        super().__init__(errno.ENOENT, message)
        self.message = message

    def __str__(self) -> str:
        return self.message


def _warn(message: str) -> None:
    if message not in _warned:
        _warned.add(message)
        print(f"ccdm: {message}", file=sys.stderr)


def _exists(path: str) -> bool:
    try:
        os.lstat(path)
    except (OSError, ValueError):
        return False
    return True


def _is_program(path: str) -> bool:
    try:
        # On Windows lstat, because a Store alias is a reparse point that cannot be followed.
        if WIN32:
            return not stat.S_ISDIR(os.lstat(path).st_mode)
        return os.path.isfile(path) and os.access(path, os.X_OK)
    except (OSError, ValueError):
        return False


def _path_directories() -> List[str]:
    entries = os.environ.get("PATH", "").split(os.pathsep)
    if not WIN32:
        return [entry for entry in entries if entry]
    # A relative entry would make the choice depend on the current directory.
    stripped = (entry.strip('"') for entry in entries)
    return [entry for entry in stripped if _ABSOLUTE_WIN32.match(entry)]


def _on_path(name: str) -> List[str]:
    """Every match on PATH, in order. On Windows only the .exe form counts."""
    file = f"{name}.exe" if WIN32 else name
    candidates = [os.path.join(entry, file) for entry in _path_directories()]
    return [candidate for candidate in candidates if _is_program(candidate)]


def _override(variable: str, reject_store_stub: bool = False) -> Optional[str]:
    """The value of an environment override, or None when unset or unusable."""
    value = os.environ.get(variable)
    if not value:
        return None
    if not WIN32:
        return value
    reason = None
    if _NEEDS_SHELL.search(value):
        reason = "a .cmd or .bat cannot be started without a shell"
    elif reject_store_stub and _STORE_STUB.search(value):
        reason = "it is the Microsoft Store stub, not Python"
    if reason:
        _warn(f"ignoring {variable}={value}: {reason}")
        return None
    if "/" in value or "\\" in value:
        return value
    name = re.sub(r"\.exe$", "", value, flags=re.IGNORECASE)
    for file in _on_path(name):
        if not (reject_store_stub and _STORE_STUB.search(file)):
            return file
    return value


def _probe(command: str, args: List[str], env: Optional[Dict[str, str]] = None) -> Optional[str]:
    """The stripped output of a successful run, or None; only a success is remembered."""
    key = repr((command, args))
    if key in _probed:
        return _probed[key]
    flags = subprocess.CREATE_NO_WINDOW if WIN32 else 0  # type: ignore[attr-defined]
    try:
        result = subprocess.run(
            [command, *args],
            env={**os.environ, **(env or {}), "PYTHONUTF8": "1"},
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=_PROBE_TIMEOUT_SECONDS,
            creationflags=flags,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if result.returncode != 0:
        return None
    output = result.stdout.decode("utf-8", "replace").strip()
    _probed[key] = output
    return output


def python() -> List[str]:
    """``[command, ...args]`` that runs Python; twin of ``pythonCommand``."""
    for variable in ("CCDM_PYTHON", "CCDM_REMINDER_PYTHON"):
        value = _override(variable, reject_store_stub=True)
        if value:
            return [value]
    if not WIN32:
        return ["python3"]
    rejected: List[str] = []
    # The launcher only finds the interpreter, which then runs without it.
    for launcher in _on_path("py"):
        if _STORE_STUB.search(launcher):
            rejected.append(f"{launcher} is the Microsoft Store stub, not Python.")
            continue
        interpreter = _probe(launcher, ["-3", "-c", _PRINT_EXECUTABLE])
        if interpreter and not _STORE_STUB.search(interpreter):
            return [interpreter]
        rejected.append(
            f"{launcher} -3 runs {interpreter}, under the Microsoft Store's WindowsApps folder."
            if interpreter
            else f"{launcher} -3 did not run."
        )
    for interpreter in _on_path("python"):
        if not _STORE_STUB.search(interpreter):
            return [interpreter]
        rejected.append(f"{interpreter} is the Microsoft Store stub, not Python.")
    raise ToolNotFound(
        " ".join(["No usable Python was found.", *rejected, "Install Python, or set CCDM_PYTHON to its python.exe."])
    )


def _plain(command: str) -> Dict[str, Any]:
    return {"command": command, "args": [], "env": {}}


def node() -> Dict[str, Any]:
    configured = _override("CCDM_ROUTER_NODE")
    if configured:
        return _plain(configured)
    found = _on_path("node")
    if found:
        return _plain(found[0])
    raise ToolNotFound("Node was not found on PATH. Install it, or set CCDM_ROUTER_NODE to its absolute path.")


def _installed_package(start: str, scope: str, name: str) -> Optional[str]:
    """Node's own search: this directory's node_modules, then each parent's."""
    directory = start
    while True:
        if os.path.basename(directory) != "node_modules":
            candidate = os.path.join(directory, "node_modules", scope, name)
            if _exists(os.path.join(candidate, "package.json")):
                return candidate
        parent = os.path.dirname(directory)
        if parent == directory:
            return None
        directory = parent


def _windows_architectures() -> List[str]:
    native = (os.environ.get("PROCESSOR_ARCHITEW6432") or os.environ.get("PROCESSOR_ARCHITECTURE") or "").lower()
    return ["arm64", "x64"] if native == "arm64" else ["x64", "arm64"]


def _vendored_codex(package_dir: str) -> Optional[str]:
    """The lookup in the package's own bin/codex.js, for whichever architecture is installed."""
    for architecture in _windows_architectures():
        platform_package = _installed_package(package_dir, "@openai", f"codex-win32-{architecture}")
        vendor = os.path.join(platform_package or package_dir, "vendor")
        executable = os.path.join(vendor, _CODEX_TARGETS[architecture], "bin", "codex.exe")
        if _exists(executable):
            return executable
    return None


def codex() -> Dict[str, Any]:
    configured = _override("CCDM_CODEX_PATH")
    if configured:
        return _plain(configured)
    if not WIN32:
        return _plain("codex")
    # The npm shim is a .cmd, so it only says where the package is.
    shim_dir = next(
        (
            entry
            for entry in _path_directories()
            if _exists(os.path.join(entry, "codex.cmd")) and _exists(os.path.join(entry, _CODEX_PACKAGE))
        ),
        None,
    )
    if shim_dir is None:
        raise ToolNotFound("Codex was not found. Install @openai/codex with npm, or set CCDM_CODEX_PATH to codex.exe.")
    package_dir = os.path.join(shim_dir, _CODEX_PACKAGE)
    executable = _vendored_codex(package_dir)
    if executable:
        env = {"CODEX_MANAGED_BY_NPM": "1", "CODEX_MANAGED_PACKAGE_ROOT": package_dir}
        if _probe(executable, ["--version"], env) is not None:
            return {"command": executable, "args": [], "env": env}
    return {"command": node()["command"], "args": [os.path.join(package_dir, "bin", "codex.js")], "env": {}}


def claude() -> Dict[str, Any]:
    local = str(Path.home() / ".local" / "bin" / ("claude.exe" if WIN32 else "claude"))
    if _is_program(local):
        return _plain(local)
    found = _on_path("claude")
    if found:
        return _plain(found[0])
    raise ToolNotFound("Claude Code was not found in ~/.local/bin or on PATH.")


def whisper() -> Dict[str, Any]:
    configured = _override("CODEX_BRIDGE_AUDIO_TRANSCRIPTION_COMMAND")
    if configured:
        return _plain(configured)
    if not WIN32:
        return _plain("whisper")
    found = _on_path("whisper")
    if found:
        return _plain(found[0])
    raise ToolNotFound(
        "whisper.exe was not found on PATH. Install it, or set CODEX_BRIDGE_AUDIO_TRANSCRIPTION_COMMAND."
    )
