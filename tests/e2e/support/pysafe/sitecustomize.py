"""Stops test workspaces from calling os.kill(pid, 0) on Windows.

On win32, signal 0 is CTRL_C_EVENT, which can stop a whole console process
group instead of probing one PID. Production code still makes this call, so
it raises here until those calls are removed. RuntimeError, because callers
read OSError as "that process is dead". Off win32 this module does nothing.
"""

import os
import sys

if sys.platform == "win32":
    _real_kill = os.kill

    def _guarded_kill(pid, sig):
        if sig == 0:
            raise RuntimeError("os.kill(pid, 0) is unsafe on Windows")
        return _real_kill(pid, sig)

    os.kill = _guarded_kill
