"""Where the Thread Supervisor keeps its private state and its Router key."""

from __future__ import annotations

import os
from pathlib import Path
import secrets

from ccdmlib.platform import private_fs
from ccdmlib.platform.paths import state_root


SUPERVISOR_KEY_FILE = ".supervisor.key"


def default_state_dir() -> Path:
    override = os.environ.get("CCDM_THREAD_SUPERVISOR_STATE_DIR")
    if override:
        return Path(override).expanduser()
    return state_root() / "thread-supervisor"


def router_state_dir() -> Path:
    override = os.environ.get("CCDM_ROUTER_STATE_DIR")
    if override:
        return Path(override).expanduser()
    return state_root() / "router"


private_directory = private_fs.ensure_private_dir
write_private = private_fs.write_private


def write_supervisor_key() -> Path:
    """Write a fresh `keys/.supervisor.key` in the Router's key directory; a
    newer key makes the Router refuse the previous worker's link."""
    keys = router_state_dir() / "keys"
    private_directory(keys)
    path = keys / SUPERVISOR_KEY_FILE
    write_private(path, f"{secrets.token_hex(32)}\n")
    return path
