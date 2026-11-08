"""One privacy rule in two languages; scripts/platform/privacy.js is the twin.

POSIX: the owner's uid and the mode bits, as always.

Windows, where mode bits mean nothing: a private directory is owned by the
current user and has a protected DACL (inheritance off) whose only entries are
that user with full control (OI)(CI), plus SYSTEM if present. A private file sits
in a private directory, and its own DACL has no entry for another SID.

The DACL is read through the Win32 API and set with icacls.exe. Its output is
localized, so only its exit status is ever used.
"""

from __future__ import annotations

import os
from pathlib import Path
import re
import stat
import subprocess
import sys
from typing import Any, Dict, List, Optional, Set, Tuple, Union

from .atomic import replace_with_retry

WIN32 = sys.platform == "win32"
PathLike = Union[str, "os.PathLike[str]"]
DEFAULT_LABEL = "Private directory"
_SYSTEM_SID = "S-1-5-18"
_FULL_CONTROL = {"FA", "GA", "0x1f01ff"}
_FILE_ERRORS = {2: "ENOENT", 3: "ENOENT", 5: "EACCES"}

if WIN32:
    import ctypes
    from ctypes import wintypes
    import errno

    _SE_FILE_OBJECT = 1
    _OWNER_SECURITY_INFORMATION = 1
    _DACL_SECURITY_INFORMATION = 4
    _SDDL_REVISION_1 = 1
    _TOKEN_QUERY = 8
    _TOKEN_USER_CLASS = 1

    _void_out = ctypes.POINTER(ctypes.c_void_p)
    _kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    _advapi32 = ctypes.WinDLL("advapi32", use_last_error=True)
    _kernel32.GetCurrentProcess.restype = wintypes.HANDLE
    _kernel32.GetCurrentProcess.argtypes = ()
    _kernel32.CloseHandle.restype = wintypes.BOOL
    _kernel32.CloseHandle.argtypes = (wintypes.HANDLE,)
    _kernel32.LocalFree.restype = ctypes.c_void_p
    _kernel32.LocalFree.argtypes = (ctypes.c_void_p,)
    _advapi32.OpenProcessToken.restype = wintypes.BOOL
    _advapi32.OpenProcessToken.argtypes = (wintypes.HANDLE, wintypes.DWORD, ctypes.POINTER(wintypes.HANDLE))
    _advapi32.GetTokenInformation.restype = wintypes.BOOL
    _advapi32.GetTokenInformation.argtypes = (
        wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD),
    )
    _advapi32.ConvertSidToStringSidW.restype = wintypes.BOOL
    _advapi32.ConvertSidToStringSidW.argtypes = (ctypes.c_void_p, _void_out)
    _advapi32.ConvertStringSidToSidW.restype = wintypes.BOOL
    _advapi32.ConvertStringSidToSidW.argtypes = (wintypes.LPCWSTR, _void_out)
    _advapi32.GetNamedSecurityInfoW.restype = wintypes.DWORD
    _advapi32.GetNamedSecurityInfoW.argtypes = (
        wintypes.LPCWSTR, ctypes.c_int, wintypes.DWORD,
        ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p, _void_out,
    )
    _advapi32.ConvertSecurityDescriptorToStringSecurityDescriptorW.restype = wintypes.BOOL
    _advapi32.ConvertSecurityDescriptorToStringSecurityDescriptorW.argtypes = (
        ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD, _void_out, ctypes.c_void_p,
    )

    def _take_wide_string(pointer: Any) -> str:
        """Read a LocalAlloc'd wide string and free it."""
        try:
            return ctypes.wstring_at(pointer)
        finally:
            _kernel32.LocalFree(pointer)

    def _sid_string(sid: Any) -> str:
        text = ctypes.c_void_p()
        if not _advapi32.ConvertSidToStringSidW(sid, ctypes.byref(text)):
            raise OSError("ConvertSidToStringSidW failed")
        return _take_wide_string(text)

    def current_user_sid() -> Optional[str]:
        token = wintypes.HANDLE()
        if not _advapi32.OpenProcessToken(_kernel32.GetCurrentProcess(), _TOKEN_QUERY, ctypes.byref(token)):
            raise OSError("OpenProcessToken failed")
        try:
            buffer = ctypes.create_string_buffer(256)
            needed = wintypes.DWORD()
            if not _advapi32.GetTokenInformation(token, _TOKEN_USER_CLASS, buffer, 256, ctypes.byref(needed)):
                raise OSError("GetTokenInformation failed")
            return _sid_string(ctypes.cast(buffer, ctypes.POINTER(ctypes.c_void_p)).contents)
        finally:
            _kernel32.CloseHandle(token)

    def _canonical_sid(trustee: str) -> str:
        """SDDL writes well-known SIDs as two-letter aliases; a fix line needs the SID."""
        if trustee.startswith("S-"):
            return trustee
        sid = ctypes.c_void_p()
        if not _advapi32.ConvertStringSidToSidW(trustee, ctypes.byref(sid)):
            return trustee
        try:
            return _sid_string(sid)
        finally:
            _kernel32.LocalFree(sid)

    def _read_sddl(target: str) -> str:
        information = _OWNER_SECURITY_INFORMATION | _DACL_SECURITY_INFORMATION
        descriptor = ctypes.c_void_p()
        status = _advapi32.GetNamedSecurityInfoW(
            target, _SE_FILE_OBJECT, information, None, None, None, None, ctypes.byref(descriptor),
        )
        if status != 0:
            code = _FILE_ERRORS.get(status)
            number = getattr(errno, code) if code else None
            raise OSError(number, f"{code or f'WIN32_{status}'}: cannot read the security descriptor of {target}")
        try:
            text = ctypes.c_void_p()
            if not _advapi32.ConvertSecurityDescriptorToStringSecurityDescriptorW(
                descriptor, _SDDL_REVISION_1, information, ctypes.byref(text), None,
            ):
                raise OSError(f"cannot convert the security descriptor of {target}")
            return _take_wide_string(text)
        finally:
            _kernel32.LocalFree(descriptor)
else:

    def current_user_sid() -> Optional[str]:
        return None


def _split_aces(text: str) -> List[str]:
    """The top-level ``(...)`` groups of an ACE list; a conditional ACE nests more."""
    aces = []
    depth = 0
    start = 0
    for index, char in enumerate(text):
        if char == "(":
            if depth == 0:
                start = index + 1
            depth += 1
        elif char == ")":
            depth -= 1
            if depth == 0:
                aces.append(text[start:index])
    return aces


def _has_flag(flags: str, flag: str) -> bool:
    return any(flags[index:index + 2] == flag for index in range(0, len(flags) - 1, 2))


def _parse_sddl(sddl: str) -> Dict[str, Any]:
    match = re.match(r"^O:([^:]*?)D:(.*)$", sddl, re.DOTALL)
    if not match:
        raise ValueError(f"unexpected security descriptor: {sddl}")
    dacl = match.group(2)
    opening = dacl.find("(")
    control = dacl if opening < 0 else dacl[:opening]
    # A NULL DACL has no entries at all and lets everyone in.
    null_dacl = "NO_ACCESS_CONTROL" in control
    aces = []
    if not null_dacl and opening >= 0:
        for ace in _split_aces(dacl[opening:]):
            parts = ace.split(";")
            rights = parts[2].lower() if parts[2].lower().startswith("0x") else parts[2]
            aces.append({"type": parts[0], "flags": parts[1], "rights": rights, "sid": _canonical_sid(parts[5])})
    return {
        "owner": _canonical_sid(match.group(1)),
        "protected": not null_dacl and "P" in control.replace("AI", "").replace("AR", ""),
        "null_dacl": null_dacl,
        "aces": aces,
    }


def _full_control(ace: Dict[str, str]) -> bool:
    flags = ace["flags"]
    return (ace["type"] == "A" and ace["rights"] in _FULL_CONTROL and _has_flag(flags, "OI")
            and _has_flag(flags, "CI") and not _has_flag(flags, "IO") and not _has_flag(flags, "NP"))


def _fix_line(directory: str, args: List[str]) -> str:
    rendered = [f'"{arg}"' if "(" in arg else arg for arg in args]
    return f'icacls "{directory}" ' + " ".join(rendered)


def _dir_problems(sddl: str, user_sid: str) -> List[Tuple[str, List[str]]]:
    """What is wrong with a directory's descriptor, in the order the fixes must
    run: the owner first (the owner may always rewrite the DACL), then the DACL."""
    parsed = _parse_sddl(sddl)
    is_protected = parsed["protected"]
    aces = parsed["aces"]
    problems: List[Tuple[str, List[str]]] = []
    if parsed["owner"] != user_sid:
        problems.append((f"is owned by {parsed['owner']}", ["/setowner", f"*{user_sid}"]))
    user_entry = any(ace["sid"] == user_sid and _full_control(ace) for ace in aces)
    if parsed["null_dacl"] or not is_protected or not user_entry:
        if parsed["null_dacl"]:
            what = "has no access control at all"
        elif not is_protected:
            what = "inherits permissions from its parent"
        else:
            what = "does not give this user full control"
        problems.append((what, ["/inheritance:r", "/grant:r", f"*{user_sid}:(OI)(CI)F"]))
    seen: Set[str] = set()
    for ace in aces:
        sid = ace["sid"]
        if sid == _SYSTEM_SID:
            continue
        deny = ace["type"] != "A" and "D" in ace["type"]
        if sid == user_sid and not deny:
            continue
        # Removing inheritance takes care of an inherited entry.
        if not is_protected and _has_flag(ace["flags"], "ID"):
            continue
        key = f"{'deny' if deny else 'grant'}:{sid}"
        if key in seen:
            continue
        seen.add(key)
        if deny:
            problems.append((f"has a deny entry for {sid}", ["/remove:d", f"*{sid}"]))
        else:
            problems.append((f"gives access to {sid}", ["/remove:g", f"*{sid}"]))
    return problems


def _format_problems(directory: str, problems: List[Tuple[str, List[str]]], label: str) -> List[str]:
    return [f"{label} {directory} {what}; run {_fix_line(directory, args)}" for what, args in problems]


def blockers_from_sddl(directory: str, sddl: str, user_sid: Optional[str] = None,
                       label: str = DEFAULT_LABEL) -> List[str]:
    """The fix-text lines for a descriptor. Separate from the disk read so that a
    descriptor no unelevated test can create, such as a foreign owner, can be judged."""
    return _format_problems(directory, _dir_problems(sddl, user_sid or current_user_sid() or ""), label)


def _win32_dir_problems(directory: str) -> List[Tuple[str, List[str]]]:
    return _dir_problems(_read_sddl(directory), current_user_sid() or "")


def blockers(path: PathLike, label: str = DEFAULT_LABEL) -> List[str]:
    """``[]`` when ``path`` is private or missing, else one line per problem, each
    naming the directory and the command that fixes it."""
    directory = os.path.abspath(path) if WIN32 else os.fspath(path)
    try:
        info = os.lstat(directory)
    except FileNotFoundError:
        return []
    except OSError as error:
        return [f"{label} {directory} cannot be inspected ({error}); fix its permissions"]
    if not stat.S_ISDIR(info.st_mode) or _is_reparse_point(info):
        return [f"{label} {directory} is not a directory; move it aside"]
    if WIN32:
        try:
            return _format_problems(directory, _win32_dir_problems(directory), label)
        except OSError as error:
            return [f"{label} {directory} cannot be inspected ({error}); fix its permissions"]
    lines = []
    if info.st_uid != os.getuid():
        lines.append(f"{label} {directory} is owned by uid {info.st_uid}; run chown {os.getuid()} {directory}")
    mode = stat.S_IMODE(info.st_mode)
    if mode != 0o700:
        lines.append(f"{label} {directory} has mode 0{mode:o}; run chmod 700 {directory}")
    return lines


def _is_reparse_point(info: os.stat_result) -> bool:
    """A junction is a directory to ``lstat`` on Windows; Node calls it a link."""
    if not WIN32:
        return False
    return bool(getattr(info, "st_file_attributes", 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT)


def is_private(path: PathLike) -> bool:
    """Whether a file or directory is private, checked on every call. Raises like
    ``os.stat`` when it is missing."""
    info = os.stat(path)
    if not WIN32:
        return stat.S_IMODE(info.st_mode) & 0o077 == 0
    target = os.path.abspath(path)
    if stat.S_ISDIR(info.st_mode):
        return not blockers(target)
    if blockers(os.path.dirname(target)):
        return False
    parsed = _parse_sddl(_read_sddl(target))
    if parsed["null_dacl"]:
        return False
    user_sid = current_user_sid()
    return all(ace["sid"] in (user_sid, _SYSTEM_SID) for ace in parsed["aces"])


def fix_hint(path: PathLike, posix_text: str) -> str:
    """The text a "not private" message ends with: POSIX's own wording, or the
    Windows fix lines for ``path``."""
    if not WIN32:
        return posix_text
    return "; ".join(blockers(path)) or "expected a protected DACL with only this user"


def _icacls() -> str:
    root = os.environ.get("SystemRoot") or os.environ.get("windir") or "C:\\Windows"
    return os.path.join(root, "System32", "icacls.exe")


def ensure_private_dir(path: PathLike) -> None:
    """Create ``path`` if needed and make it private."""
    directory = Path(path)
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    if not WIN32:
        os.chmod(directory, 0o700)
        return
    target = os.path.abspath(directory)
    problems = _win32_dir_problems(target)
    if not problems:
        return
    for _, args in problems:
        try:
            completed = subprocess.run([_icacls(), target, *args], stdin=subprocess.DEVNULL,
                                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                       creationflags=subprocess.CREATE_NO_WINDOW, check=False)
        except OSError as error:
            raise PermissionError(f"cannot make {target} private: {error}") from None
        if completed.returncode != 0:
            raise PermissionError(f"cannot make {target} private: icacls {args[0]} exited with {completed.returncode}")
    remaining = _win32_dir_problems(target)
    if remaining:
        raise PermissionError(f"cannot make {target} private: " + "; ".join(_format_problems(target, remaining, DEFAULT_LABEL)))


def write_private(path: PathLike, content: str) -> None:
    """Replace ``path`` atomically with a private file. Its directory decides the
    DACL on Windows. Never open with a write-less mode: Windows would make the
    file read-only."""
    target = Path(path)
    temporary = target.with_name(f".{target.name}.{os.getpid()}.tmp")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="") as stream:
            stream.write(content)
        os.chmod(temporary, 0o600)
        replace_with_retry(temporary, target)
    except OSError:
        temporary.unlink(missing_ok=True)
        raise
