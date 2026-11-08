"""An exclusive advisory lock on an open file, as ``flock`` gives on POSIX.

The lock is held through the file object or descriptor passed in and ends with
``unlock`` or when the file is closed or its process exits. Windows locks byte 0
with ``msvcrt.locking``, which is mandatory for that byte, so never read or write
a lock file through another handle.
"""

from __future__ import annotations

import sys
import time
from typing import IO, Any, Optional, Union

WIN32 = sys.platform == "win32"

if WIN32:
    import errno
    import msvcrt
    import os
else:
    import fcntl

Lockable = Union[int, IO[Any]]

_POLL_SECONDS = 0.05


if WIN32:

    def _at_byte_zero(file: Lockable) -> int:
        descriptor = file if isinstance(file, int) else file.fileno()
        os.lseek(descriptor, 0, os.SEEK_SET)  # msvcrt.locking starts at the file position.
        return descriptor

    def try_lock(file: Lockable) -> bool:
        """Take the lock if it is free; ``False`` when another open file holds it."""
        try:
            msvcrt.locking(_at_byte_zero(file), msvcrt.LK_NBLCK, 1)
        except OSError as error:
            if error.errno == errno.EACCES:
                return False
            raise
        return True

    def unlock(file: Lockable) -> None:
        msvcrt.locking(_at_byte_zero(file), msvcrt.LK_UNLCK, 1)

else:

    def try_lock(file: Lockable) -> bool:
        """Take the lock if it is free; ``False`` when another open file holds it."""
        try:
            fcntl.flock(file, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return False
        return True

    def unlock(file: Lockable) -> None:
        fcntl.flock(file, fcntl.LOCK_UN)


def lock(file: Lockable, deadline: Optional[float] = None) -> bool:
    """Wait for the lock until ``deadline``, a ``time.monotonic()`` value.

    Returns ``False`` when the deadline passes with the lock still held. With no
    deadline it waits for as long as the lock is held.
    """
    if deadline is None and not WIN32:
        fcntl.flock(file, fcntl.LOCK_EX)
        return True
    while not try_lock(file):
        if deadline is None:
            time.sleep(_POLL_SECONDS)
            continue
        left = deadline - time.monotonic()
        if left <= 0:
            return False
        time.sleep(min(_POLL_SECONDS, left))
    return True
