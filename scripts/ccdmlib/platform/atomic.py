"""Replacing files and removing directories another process may hold open.

Windows reports a file held open as a sharing error. The retried errors and the
budget match scripts/platform/atomic.js.
"""

from __future__ import annotations

import errno
import os
import secrets
import shutil
import sys
import time
from pathlib import Path
from typing import Callable, FrozenSet, TypeVar, Union

WIN32 = sys.platform == "win32"
DEFAULT_BUDGET_MS = 2000
MAX_BACKOFF_SECONDS = 0.05
SHARING_ERRORS = frozenset({errno.EPERM, errno.EACCES, errno.EBUSY})
# A directory whose files are still being deleted reports ENOTEMPTY.
REMOVE_ERRORS = SHARING_ERRORS | {errno.ENOTEMPTY}

PathLike = Union[str, "os.PathLike[str]"]
T = TypeVar("T")


def _with_retry(action: Callable[[], T], retryable: FrozenSet[int], budget_ms: int) -> T:
    deadline = time.monotonic() + budget_ms / 1000
    backoff = 0.001
    while True:
        try:
            return action()
        except OSError as error:
            left = deadline - time.monotonic()
            if error.errno not in retryable or left <= 0:
                raise
            time.sleep(min(backoff, left))
            backoff = min(backoff * 2, MAX_BACKOFF_SECONDS)


def replace_with_retry(src: PathLike, dst: PathLike, budget_ms: int = DEFAULT_BUDGET_MS) -> None:
    """``os.replace``: overwrites ``dst`` on every OS, as Node's rename does."""
    _with_retry(lambda: os.replace(src, dst), SHARING_ERRORS, budget_ms)


def rename_with_retry(src: PathLike, dst: PathLike, budget_ms: int = DEFAULT_BUDGET_MS) -> None:
    """``os.rename``: on Windows an existing ``dst`` raises FileExistsError at once."""
    _with_retry(lambda: os.rename(src, dst), SHARING_ERRORS, budget_ms)


def remove_dir_with_retry(path: PathLike, budget_ms: int = DEFAULT_BUDGET_MS) -> None:
    """Remove a directory tree; a directory that is already gone is fine."""

    def remove() -> None:
        try:
            shutil.rmtree(path)
        except FileNotFoundError:
            pass

    _with_retry(remove, REMOVE_ERRORS, budget_ms)


def write_file_atomic(file: PathLike, data: Union[str, bytes], mode: int = 0o600) -> None:
    """Python twin of ``writeFileAtomic``: the target is never partly written."""
    target = Path(file)
    temporary = target.with_name(f".{target.name}.{os.getpid()}.{secrets.token_hex(6)}.tmp")
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0)
    descriptor = os.open(temporary, flags, mode)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(data.encode("utf-8") if isinstance(data, str) else data)
            handle.flush()
            if not WIN32:
                os.fchmod(handle.fileno(), mode)
            os.fsync(handle.fileno())
        replace_with_retry(temporary, target)
    except BaseException:
        try:
            os.unlink(temporary)
        except OSError:
            pass
        raise
