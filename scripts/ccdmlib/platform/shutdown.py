"""One way to ask a service to stop, on every OS.

``SIGTERM`` and ``SIGINT`` work everywhere, ``SIGBREAK`` is what a Windows console
can send to one process group, and a marker file reaches a service that has no
console to signal.
"""

from __future__ import annotations

import os
import signal
import sys
import threading
import time
from typing import Any, Callable, Optional, Union

_MARKER_POLL_SECONDS = 0.25


def _watch(marker: Union[str, "os.PathLike[str]"], fn: Callable[[], None]) -> None:
    while not os.path.exists(marker):
        time.sleep(_MARKER_POLL_SECONDS)
    fn()


def on_shutdown(fn: Callable[[], None], marker: Optional[Union[str, "os.PathLike[str]"]] = None) -> None:
    """Call ``fn`` when a stop signal arrives or ``marker`` appears.

    Call this from the main thread. ``fn`` may run in a signal handler or on the
    marker's thread, and more than once, so it should only set a flag the service
    loop reads.
    """

    def handle(_signal: int, _frame: Any) -> None:
        fn()

    signals = [signal.SIGTERM, signal.SIGINT]
    if sys.platform == "win32":
        signals.append(signal.SIGBREAK)
    for number in signals:
        signal.signal(number, handle)
    if marker is not None:
        threading.Thread(target=_watch, args=(marker, fn), daemon=True).start()
