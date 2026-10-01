"""Where the Thread Supervisor keeps its private state and its Router key."""

from __future__ import annotations

import os
from pathlib import Path
import secrets


SUPERVISOR_KEY_FILE = ".supervisor.key"


def default_state_dir() -> Path:
    override = os.environ.get("CCDM_THREAD_SUPERVISOR_STATE_DIR")
    if override:
        return Path(override).expanduser()
    return Path.home() / ".local" / "state" / "ccdm" / "thread-supervisor"


def router_state_dir() -> Path:
    override = os.environ.get("CCDM_ROUTER_STATE_DIR")
    if override:
        return Path(override).expanduser()
    return Path.home() / ".local" / "state" / "ccdm" / "router"


def private_directory(path: Path) -> None:
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(path, 0o700)


def write_private(path: Path, content: str) -> None:
    """Replace ``path`` atomically with a 0600 file."""
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as target:
            target.write(content)
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
    except OSError:
        temporary.unlink(missing_ok=True)
        raise


def write_supervisor_key() -> Path:
    """Write a fresh `keys/.supervisor.key` in the Router's key directory; a
    newer key makes the Router refuse the previous worker's link."""
    keys = router_state_dir() / "keys"
    private_directory(keys)
    path = keys / SUPERVISOR_KEY_FILE
    write_private(path, f"{secrets.token_hex(32)}\n")
    return path
