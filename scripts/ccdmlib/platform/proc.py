"""Which process is this, and is that one still running?

Windows reuses PIDs quickly, so there a PID is paired with its creation time. On
POSIX the start time is always ``None`` and liveness is the PID alone. The answers
match scripts/platform/process.js.

Never call ``os.kill(pid, 0)`` on Windows: signal 0 is ``CTRL_C_EVENT`` there and
can stop a whole process group.
"""

from __future__ import annotations

import os
import sys
from typing import Any, Optional, Tuple

WIN32 = sys.platform == "win32"

if WIN32:
    import ctypes
    from ctypes import wintypes

    _PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
    _SYNCHRONIZE = 0x00100000
    _STILL_ACTIVE = 259
    _ERROR_INVALID_PARAMETER = 87
    _WAIT_OBJECT_0 = 0

    _kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    _kernel32.OpenProcess.restype = wintypes.HANDLE
    _kernel32.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
    _kernel32.CloseHandle.restype = wintypes.BOOL
    _kernel32.CloseHandle.argtypes = (wintypes.HANDLE,)
    _kernel32.GetExitCodeProcess.restype = wintypes.BOOL
    _kernel32.GetExitCodeProcess.argtypes = (wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD))
    _kernel32.WaitForSingleObject.restype = wintypes.DWORD
    _kernel32.WaitForSingleObject.argtypes = (wintypes.HANDLE, wintypes.DWORD)
    _kernel32.GetProcessTimes.restype = wintypes.BOOL
    _kernel32.GetProcessTimes.argtypes = (wintypes.HANDLE, *[ctypes.POINTER(wintypes.FILETIME)] * 4)

    def _open(pid: int) -> Tuple[Any, int]:
        """A query handle (with wait rights when granted), or ``None`` and the error."""
        handle = _kernel32.OpenProcess(_PROCESS_QUERY_LIMITED_INFORMATION | _SYNCHRONIZE, False, pid)
        if not handle:
            handle = _kernel32.OpenProcess(_PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
        return handle, 0 if handle else ctypes.get_last_error()

    def _running(handle: Any) -> bool:
        code = wintypes.DWORD()
        if not _kernel32.GetExitCodeProcess(handle, ctypes.byref(code)):
            return True
        if code.value != _STILL_ACTIVE:
            return False
        # A process can itself exit with 259; the wait tells the two apart.
        return _kernel32.WaitForSingleObject(handle, 0) != _WAIT_OBJECT_0

    def _creation_ticks(handle: Any) -> Optional[str]:
        created, exited, kernel, user = (wintypes.FILETIME() for _ in range(4))
        if not _kernel32.GetProcessTimes(
            handle, ctypes.byref(created), ctypes.byref(exited), ctypes.byref(kernel), ctypes.byref(user)
        ):
            return None
        return str((created.dwHighDateTime << 32) | created.dwLowDateTime)


def start_time(pid: int) -> Optional[str]:
    """FILETIME ticks of a running process as a decimal string, else ``None``."""
    if not WIN32:
        return None
    handle, _ = _open(pid)
    if not handle:
        return None
    try:
        return _creation_ticks(handle) if _running(handle) else None
    finally:
        _kernel32.CloseHandle(handle)


def identity() -> Tuple[int, Optional[str]]:
    pid = os.getpid()
    return pid, start_time(pid)


def alive(pid: int, started_at: Optional[str] = None) -> bool:
    if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 0:
        return False
    if not WIN32:
        try:
            os.kill(pid, 0)
        except PermissionError:
            return True
        except OSError:
            return False
        return True
    handle, error = _open(pid)
    if not handle:
        return error != _ERROR_INVALID_PARAMETER
    try:
        if not _running(handle):
            return False
        if started_at is None:
            return True
        actual = _creation_ticks(handle)
        return actual is None or actual == started_at
    finally:
        _kernel32.CloseHandle(handle)
