"""Claude Code's OAuth login, read and never written.

macOS keeps it in the Keychain, in one or two items per Claude home. Windows keeps
it in ``<config dir>\\.credentials.json``, with the same ``claudeAiOauth`` object:
``accessToken``, ``refreshToken`` and ``expiresAt`` in milliseconds. Anthropic
rotates the refresh token on every refresh, so nothing here refreshes a login;
that stays with Claude Code (``claude -p /usage``).

The file is read whole and closed at once, with share-delete on Windows, so a
reader never gets in the way of Claude Code saving a new copy for longer than the
read itself; no handle is held across a retry wait. A read can land while Claude
Code is saving, so a parse failure is retried a little and then reported. The
retry count is provisional: how often a read catches a half-written file has not
been measured.

Credentials gate (Windows): entries for the current user, SYSTEM and
Administrators are expected. Any other account that can change the file refuses
it, naming the ``icacls`` command that removes the entry; any other reader gets a
warning and the file is used. The file's DACL is only ever read. Most entries are
inherited from the Claude config folder, and those must be removed there.

``CCDM_CLAUDE_CREDENTIALS_STORE`` (``keychain`` or ``file``) overrides which store
is used, so tests with fixture homes can run either path on any OS.
"""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time
from typing import Any, Dict, List, NamedTuple, Optional, Set, Tuple

from . import private_fs

WIN32 = sys.platform == "win32"
PLAIN_KEYCHAIN_SERVICE = "Claude Code-credentials"
CREDENTIALS_FILE_NAME = ".credentials.json"
SECURE_STORAGE_DIR_VARIABLE = "CLAUDE_SECURESTORAGE_CONFIG_DIR"
STORE_VARIABLE = "CCDM_CLAUDE_CREDENTIALS_STORE"
MAX_CREDENTIALS_BYTES = 1024 * 1024
# Provisional: small on purpose until a real refresh has been observed.
PARSE_RETRIES = 2
PARSE_RETRY_WAIT_SECONDS = 0.25

UNREADABLE_REASON = "Claude credentials file could not be read"
REFUSED_REASON = "Claude credentials file can be changed by another account"

_SYSTEM_SID = "S-1-5-18"
_ADMINISTRATORS_SID = "S-1-5-32-544"
# Access-mask bits an SDDL rights string can name, for a file object.
_RIGHTS: Dict[str, int] = {
    "GA": 0x10000000, "GX": 0x20000000, "GW": 0x40000000, "GR": 0x80000000,
    "FA": 0x001F01FF, "FR": 0x00120089, "FW": 0x00120116, "FX": 0x001200A0,
    "CC": 0x1, "DC": 0x2, "LC": 0x4, "SW": 0x8, "RP": 0x10, "WP": 0x20, "DT": 0x40,
    "LO": 0x80, "CR": 0x100, "SD": 0x10000, "RC": 0x20000, "WD": 0x40000, "WO": 0x80000,
}
# Write data, append, write attributes (extended and basic), delete, change the
# DACL or owner, and the generic rights that include them.
_WRITE_MASK = 0x2 | 0x4 | 0x10 | 0x40 | 0x100 | 0x10000 | 0x40000 | 0x80000 | 0x10000000 | 0x40000000

if WIN32:
    import ctypes
    from ctypes import wintypes
    import msvcrt

    _GENERIC_READ = 0x80000000
    _SHARE_ALL = 0x1 | 0x2 | 0x4  # read, write and delete: a rename over the file still works
    _OPEN_EXISTING = 3
    _FILE_ATTRIBUTE_NORMAL = 0x80
    _kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    _kernel32.CreateFileW.restype = wintypes.HANDLE
    _kernel32.CreateFileW.argtypes = (
        wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p,
        wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE,
    )
    _INVALID_HANDLE = wintypes.HANDLE(-1).value

    def _open_shared(path: str) -> int:
        """A read-only descriptor that does not block a rename over ``path``."""
        handle = _kernel32.CreateFileW(
            path, _GENERIC_READ, _SHARE_ALL, None, _OPEN_EXISTING, _FILE_ATTRIBUTE_NORMAL, None,
        )
        if handle == _INVALID_HANDLE or handle is None:
            raise ctypes.WinError(ctypes.get_last_error())
        return msvcrt.open_osfhandle(handle, os.O_RDONLY | os.O_BINARY)
else:

    def _open_shared(path: str) -> int:
        return os.open(path, os.O_RDONLY | getattr(os, "O_CLOEXEC", 0))


class FileRead(NamedTuple):
    """One read of a credentials file. ``oauth`` and ``reason`` are both ``None``
    when the file does not exist; ``reason`` is safe to record."""

    oauth: Optional[Dict[str, Any]]
    reason: Optional[str]
    warnings: List[str]
    refusals: List[str]


def uses_keychain() -> bool:
    """Whether this run reads the Keychain. Linux keeps today's path: tests drive
    it there with a fake ``security``, and nothing ships to Linux."""
    store = os.environ.get(STORE_VARIABLE)
    if store in ("keychain", "file"):
        return store == "keychain"
    return not WIN32


def _usable_oauth(credential: Any) -> Optional[Dict[str, Any]]:
    if not isinstance(credential, dict):
        return None
    oauth = credential.get("claudeAiOauth")
    if not isinstance(oauth, dict):
        return None
    if not isinstance(oauth.get("accessToken"), str) or not oauth["accessToken"]:
        return None
    return oauth


def read_keychain_item(service: str) -> Optional[Dict[str, Any]]:
    try:
        result = subprocess.run(
            ["security", "find-generic-password", "-s", service, "-w"],
            capture_output=True,
            text=True,
            timeout=10,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if result.returncode != 0:
        return None
    try:
        credential = json.loads(result.stdout.strip())
    except (TypeError, ValueError, json.JSONDecodeError):
        return None
    return _usable_oauth(credential)


def keychain_services(config_dir: Path) -> List[str]:
    """Keychain services that can hold one Claude home's login, hashed first.

    Claude Code keeps a home's OAuth credential in ``Claude Code-credentials``
    when ``CLAUDE_CONFIG_DIR`` is unset, and in
    ``Claude Code-credentials-<first 8 hex of sha256(dir path)>`` when the
    variable is set explicitly. Remote logins always set the variable, even
    for ``~/.claude``, while default sessions do not, so ``~/.claude`` can
    have a live credential in either item.
    """
    hashed = f"{PLAIN_KEYCHAIN_SERVICE}-" + hashlib.sha256(str(config_dir).encode()).hexdigest()[:8]
    if config_dir == Path.home() / ".claude":
        return [hashed, PLAIN_KEYCHAIN_SERVICE]
    return [hashed]


def credentials_path(config_dir: Path) -> Path:
    override = os.environ.get(SECURE_STORAGE_DIR_VARIABLE)
    directory = Path(override).expanduser() if override else Path(config_dir)
    return directory / CREDENTIALS_FILE_NAME


def _rights_mask(rights: str) -> int:
    if rights.lower().startswith("0x"):
        try:
            return int(rights, 16)
        except ValueError:
            return _WRITE_MASK
    tokens = [rights[index:index + 2] for index in range(0, len(rights), 2)]
    # A right this table does not know could be anything, so it counts as write.
    return sum(_RIGHTS.get(token, _WRITE_MASK) for token in set(tokens))


def _fix_command(path: str, sid: str, inherited: bool) -> str:
    if inherited:
        folder = os.path.dirname(path)
        return f'icacls "{folder}" /inheritance:d && icacls "{folder}" /remove:g *{sid}'
    return f'icacls "{path}" /remove:g *{sid}'


def gate_from_sddl(path: str, sddl: str, user_sid: Optional[str]) -> Tuple[List[str], List[str]]:
    """``(refusals, warnings)`` for a file's descriptor, separate from the disk read."""
    parsed = private_fs._parse_sddl(sddl)  # pylint: disable=protected-access
    if parsed["null_dacl"]:
        return ([f'Claude credentials file {path} has no access control; run icacls "{path}" /reset'], [])
    expected: Set[Optional[str]] = {user_sid, _SYSTEM_SID, _ADMINISTRATORS_SID}
    refusals: List[str] = []
    warnings: List[str] = []
    seen: Set[Tuple[str, bool]] = set()
    for ace in parsed["aces"]:
        sid = ace["sid"]
        flags = ace["flags"]
        inherit_only = any(flags[index:index + 2] == "IO" for index in range(0, len(flags) - 1, 2))
        if "D" in ace["type"] or inherit_only or sid in expected:
            continue
        inherited = any(flags[index:index + 2] == "ID" for index in range(0, len(flags) - 1, 2))
        if _rights_mask(ace["rights"]) & _WRITE_MASK:
            if (sid, True) not in seen:
                seen.add((sid, True))
                refusals.append(
                    f"Claude credentials file {path} can be changed by {sid}; run {_fix_command(path, sid, inherited)}"
                )
        elif (sid, False) not in seen:
            seen.add((sid, False))
            warnings.append(
                f"Claude credentials file {path} can be read by {sid}; to stop that, run "
                f"{_fix_command(path, sid, inherited)}"
            )
    return refusals, warnings


def _gate(path: Path) -> Tuple[List[str], List[str]]:
    if not WIN32:
        return [], []
    target = os.path.abspath(path)
    sddl = private_fs._read_sddl(target)  # pylint: disable=protected-access
    return gate_from_sddl(target, sddl, private_fs.current_user_sid())


def _read_bytes(path: Path) -> bytes:
    """The whole file; the handle is closed before this returns."""
    descriptor = _open_shared(os.fspath(path))
    with os.fdopen(descriptor, "rb") as stream:
        return stream.read(MAX_CREDENTIALS_BYTES + 1)


def _parse(data: bytes) -> Optional[Dict[str, Any]]:
    if len(data) > MAX_CREDENTIALS_BYTES:
        return None
    try:
        return _usable_oauth(json.loads(data.decode("utf-8")))
    except (UnicodeDecodeError, ValueError):
        return None


def read_credentials_file(config_dir: Path) -> FileRead:
    """Read one home's credentials file through the gate, retrying a parse failure."""
    path = credentials_path(config_dir)
    try:
        refusals, warnings = _gate(path)
    except FileNotFoundError:
        return FileRead(None, None, [], [])
    except (OSError, ValueError):
        return FileRead(None, UNREADABLE_REASON, [], [])
    if refusals:
        return FileRead(None, REFUSED_REASON, warnings, refusals)
    for attempt in range(PARSE_RETRIES + 1):
        if attempt:
            time.sleep(PARSE_RETRY_WAIT_SECONDS)
        try:
            data = _read_bytes(path)
        except FileNotFoundError:
            return FileRead(None, None, warnings, [])
        except OSError:
            continue
        oauth = _parse(data)
        if oauth is not None:
            return FileRead(oauth, None, warnings, [])
    return FileRead(None, UNREADABLE_REASON, warnings, [])


def _expiry(oauth: Dict[str, Any]) -> float:
    try:
        return float(oauth.get("expiresAt"))  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return float("-inf")


def claude_oauth(config_dir: Path) -> List[Dict[str, Any]]:
    """Usable logins for one Claude home, freshest first.

    The Keychain can hold two for a home; the file holds at most one. Warnings
    and refusals go to stderr; ``read_credentials_file`` returns them instead.
    """
    if uses_keychain():
        found = [read_keychain_item(service) for service in keychain_services(Path(config_dir))]
        return sorted((oauth for oauth in found if oauth), key=_expiry, reverse=True)
    result = read_credentials_file(Path(config_dir))
    for line in [*result.refusals, *result.warnings]:
        print(f"Warning: {line}", file=sys.stderr)
    return [result.oauth] if result.oauth else []


class CredentialFile(str):
    """A home's credentials file, standing where a Keychain service name would."""

    config_dir: Path


def credential_file(config_dir: Path) -> CredentialFile:
    name = CredentialFile(os.fspath(credentials_path(config_dir)))
    name.config_dir = Path(config_dir)
    return name
