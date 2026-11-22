"""Which process is this, and is that one still running?

Windows reuses PIDs quickly, so there a PID is paired with its creation time. On
POSIX the start time is always ``None`` and liveness is the PID alone. The answers
match scripts/platform/process.js.

Never call ``os.kill(pid, 0)`` on Windows: signal 0 is ``CTRL_C_EVENT`` there and
can stop a whole process group.

Windows also has a process table: ``command_line``, ``children``, ``find`` and
``kill_tree`` exist only there. A parent PID outlives its process and can be reused,
so a process counts as a child only if it started no earlier than its parent, and
one whose start time cannot be read is left alone.
"""

from __future__ import annotations

import os
import sys
import time
from typing import Any, Callable, List, NamedTuple, Optional, Tuple

WIN32 = sys.platform == "win32"

if WIN32:
    import ctypes
    from ctypes import wintypes

    _PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
    _SYNCHRONIZE = 0x00100000
    _STILL_ACTIVE = 259
    _ERROR_INVALID_PARAMETER = 87
    _WAIT_OBJECT_0 = 0
    _PROCESS_TERMINATE = 0x0001
    _TH32CS_SNAPPROCESS = 0x00000002
    _INVALID_HANDLE = wintypes.HANDLE(-1).value
    _ERROR_NO_MORE_FILES = 18
    _PROCESS_COMMAND_LINE_INFORMATION = 60
    _STATUS_INFO_LENGTH_MISMATCH = -1073741820  # 0xC0000004 as a signed NTSTATUS
    _POLL_SECONDS = 0.05
    _KILL_ROUNDS = 10

    class _ProcessEntry32(ctypes.Structure):
        _fields_ = [
            ("dwSize", wintypes.DWORD),
            ("cntUsage", wintypes.DWORD),
            ("th32ProcessID", wintypes.DWORD),
            ("th32DefaultHeapID", ctypes.c_size_t),
            ("th32ModuleID", wintypes.DWORD),
            ("cntThreads", wintypes.DWORD),
            ("th32ParentProcessID", wintypes.DWORD),
            ("pcPriClassBase", wintypes.LONG),
            ("dwFlags", wintypes.DWORD),
            ("szExeFile", wintypes.WCHAR * 260),
        ]

    class _UnicodeString(ctypes.Structure):
        _fields_ = [
            ("Length", wintypes.USHORT),
            ("MaximumLength", wintypes.USHORT),
            ("Buffer", ctypes.c_void_p),
        ]

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
    _kernel32.TerminateProcess.restype = wintypes.BOOL
    _kernel32.TerminateProcess.argtypes = (wintypes.HANDLE, wintypes.UINT)
    _kernel32.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
    _kernel32.CreateToolhelp32Snapshot.argtypes = (wintypes.DWORD, wintypes.DWORD)
    _kernel32.Process32FirstW.restype = wintypes.BOOL
    _kernel32.Process32FirstW.argtypes = (wintypes.HANDLE, ctypes.POINTER(_ProcessEntry32))
    _kernel32.Process32NextW.restype = wintypes.BOOL
    _kernel32.Process32NextW.argtypes = (wintypes.HANDLE, ctypes.POINTER(_ProcessEntry32))
    _kernel32.LocalFree.restype = ctypes.c_void_p
    _kernel32.LocalFree.argtypes = (ctypes.c_void_p,)
    _ntdll = ctypes.WinDLL("ntdll")
    _ntdll.NtQueryInformationProcess.restype = ctypes.c_long
    _ntdll.NtQueryInformationProcess.argtypes = (
        wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.ULONG, ctypes.POINTER(wintypes.ULONG),
    )
    _shell32 = ctypes.WinDLL("shell32", use_last_error=True)
    _shell32.CommandLineToArgvW.restype = ctypes.POINTER(wintypes.LPWSTR)
    _shell32.CommandLineToArgvW.argtypes = (wintypes.LPCWSTR, ctypes.POINTER(ctypes.c_int))

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


if WIN32:

    class Process(NamedTuple):
        pid: int
        ppid: int
        name: str

    def _table() -> List[Process]:
        snapshot = _kernel32.CreateToolhelp32Snapshot(_TH32CS_SNAPPROCESS, 0)
        if snapshot == _INVALID_HANDLE or snapshot is None:
            raise ctypes.WinError(ctypes.get_last_error())
        try:
            entry = _ProcessEntry32()
            entry.dwSize = ctypes.sizeof(_ProcessEntry32)
            processes: List[Process] = []
            more = _kernel32.Process32FirstW(snapshot, ctypes.byref(entry))
            while more:
                processes.append(Process(entry.th32ProcessID, entry.th32ParentProcessID, entry.szExeFile))
                more = _kernel32.Process32NextW(snapshot, ctypes.byref(entry))
            error = ctypes.get_last_error()
            if error != _ERROR_NO_MORE_FILES:
                raise ctypes.WinError(error)
            return processes
        finally:
            _kernel32.CloseHandle(snapshot)

    def _split_command_line(text: str) -> List[str]:
        if not text:  # CommandLineToArgvW would answer with this process's own path.
            return []
        count = ctypes.c_int()
        argv = _shell32.CommandLineToArgvW(text, ctypes.byref(count))
        if not argv:
            raise ctypes.WinError(ctypes.get_last_error())
        try:
            return [argv[index] for index in range(count.value)]
        finally:
            _kernel32.LocalFree(argv)

    def command_line(pid: int) -> Optional[List[str]]:
        """A running process's arguments, or ``None`` when they cannot be read."""
        handle, _ = _open(pid)
        if not handle:
            return None
        try:
            needed = wintypes.ULONG()
            status = _ntdll.NtQueryInformationProcess(
                handle, _PROCESS_COMMAND_LINE_INFORMATION, None, 0, ctypes.byref(needed)
            )
            if status != _STATUS_INFO_LENGTH_MISMATCH:
                return None
            buffer = ctypes.create_string_buffer(needed.value)
            status = _ntdll.NtQueryInformationProcess(
                handle, _PROCESS_COMMAND_LINE_INFORMATION, buffer, needed.value, ctypes.byref(needed)
            )
            if status < 0:
                return None
            text = _UnicodeString.from_buffer(buffer)
            return _split_command_line(ctypes.wstring_at(text.Buffer, text.Length // 2) if text.Buffer else "")
        finally:
            _kernel32.CloseHandle(handle)

    def find(pred: Callable[[Process], Any]) -> List[Process]:
        """The processes in the table that ``pred`` accepts."""
        return [process for process in _table() if pred(process)]

    def _kids(table: List[Process], parent: int, parent_started: str) -> List[Tuple[int, str]]:
        """``parent``'s children as (pid, start time). A child that started after
        the PID's current holder belongs to that holder, not to the process we mean."""
        holder = start_time(parent)
        kids = []
        for process in table:
            if process.ppid != parent or process.pid == parent:
                continue
            started = start_time(process.pid)
            if started is None or int(started) < int(parent_started):
                continue
            if holder not in (None, parent_started) and int(started) >= int(holder):
                continue
            kids.append((process.pid, started))
        return kids

    def children(pid: int) -> List[int]:
        """The PIDs of a running process's direct children."""
        started = start_time(pid)
        return [] if started is None else [child for child, _ in _kids(_table(), pid, started)]

    def _tree(root: int, root_started: str) -> List[Tuple[int, str]]:
        """The root and its descendants, parents first."""
        table = _table()
        members = [(root, root_started)]
        seen = {root}
        for parent, parent_started in members:  # Grows as children are found.
            for child, started in _kids(table, parent, parent_started):
                if child not in seen:
                    seen.add(child)
                    members.append((child, started))
        return members

    def _live_tree(root: int, root_started: str) -> List[Tuple[int, str]]:
        return [member for member in _tree(root, root_started) if alive(*member)]

    def _terminate(pid: int, started: str) -> None:
        handle = _kernel32.OpenProcess(_PROCESS_TERMINATE | _PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
        if not handle:
            return
        try:
            # Checked on the handle that does the kill, so the PID cannot change hands in between.
            if _running(handle) and _creation_ticks(handle) == started:
                _kernel32.TerminateProcess(handle, 1)
        finally:
            _kernel32.CloseHandle(handle)

    def kill_tree(pid: int, grace: float = 0.0, started_at: Optional[str] = None) -> None:
        """Give a process and its descendants ``grace`` seconds to exit, then terminate them.

        Windows has no signal to send to an arbitrary process, so asking it to
        stop (a stop marker, say) is the caller's part. Nothing happens if ``pid``
        is not running, its start time cannot be read, or it differs from ``started_at``.
        """
        root_started = start_time(pid)
        if root_started is None or started_at not in (None, root_started):
            return
        deadline = time.monotonic() + grace
        while time.monotonic() < deadline and _live_tree(pid, root_started):
            time.sleep(_POLL_SECONDS)
        for _ in range(_KILL_ROUNDS):
            members = _live_tree(pid, root_started)
            if not members:
                return
            for member, started in members:
                _terminate(member, started)
            time.sleep(_POLL_SECONDS)
