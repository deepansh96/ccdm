"""A lifecycle command must not stop the session it is running in.

Every lifecycle subcommand calls :func:`detach_if_self` before its first change.
If its target is the caller's own session, the work moves to a detached copy of
the same command line and the caller exits 0, so the session can end safely.
"""

from __future__ import annotations

import os
import re
import sys
from pathlib import Path
from typing import Optional, Sequence

from ..platform import session_host
from ..platform.paths import state_root

_DETACHED = "CCDM_DETACHED"
_SESSION_NAME = "CCDM_SESSION_NAME"
_ENTRY = Path(__file__).resolve().parents[2] / "ccdm.py"
# No session host at all, so no session can be the caller's. The real command reports it.
_NO_SESSION_HOST = ("not_running", "spawn_failed")
_UNSAFE_IN_FILE_NAME = re.compile(r"[^A-Za-z0-9._-]")


def _is_own_session(target_session: str) -> bool:
    if os.environ.get(_SESSION_NAME) == target_session:
        return True
    try:
        return os.getpid() in session_host.pids(target_session)
    except session_host.SessionHostError as error:
        if error.code in _NO_SESSION_HOST:
            return False
        raise


def detach_if_self(target_session: str, argv: Optional[Sequence[str]] = None) -> None:
    """Return to run in the foreground, or hand off and exit 0 if the target is the caller's own.

    ``target_session`` is the session name. ``argv`` is the command line without
    the program name, ``sys.argv[1:]`` by default.
    """
    if os.environ.get(_DETACHED) == "1" or not _is_own_session(target_session):
        return
    arguments = list(sys.argv[1:] if argv is None else argv)
    safe_target = _UNSAFE_IN_FILE_NAME.sub("_", target_session)
    log = state_root() / "logs" / f"{arguments[0]}-{safe_target}.log"
    log.parent.mkdir(parents=True, exist_ok=True)
    # ccdm-host starts helpers with none of the CCDM* names unless they are passed.
    env = {name: value for name, value in os.environ.items() if name.upper().startswith("CCDM")}
    env.pop(_SESSION_NAME, None)
    env.update({_DETACHED: "1", "PYTHONUTF8": "1"})
    started = session_host.run_detached([sys.executable, str(_ENTRY), *arguments], env=env, log=str(log))
    print(f"ccdm: {arguments[0]} continues in a detached process (pid {started['pid']}); log: {log}")
    sys.exit(0)
