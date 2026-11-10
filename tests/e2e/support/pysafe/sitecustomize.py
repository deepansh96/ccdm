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

    # A process started with CCDM_E2E_STACK_DUMP_DIR prints every thread's stack to
    # its stderr each time the harness creates `dump-<its pid>` there, so a worker
    # that does not stop when asked shows where it is. Only the process the harness
    # starts watches: the variable is taken out before any child inherits it.
    _dump_dir = os.environ.pop("CCDM_E2E_STACK_DUMP_DIR", None)
    if _dump_dir:
        import faulthandler
        import threading
        import time

        def _dump_on_request(request):
            while True:
                if os.path.exists(request):
                    try:
                        os.unlink(request)
                    except OSError:
                        pass
                    faulthandler.dump_traceback(file=sys.stderr, all_threads=True)
                    sys.stderr.flush()
                time.sleep(0.25)

        threading.Thread(target=_dump_on_request, args=(os.path.join(_dump_dir, f"dump-{os.getpid()}"),),
                         name="e2e-stack-dump", daemon=True).start()
