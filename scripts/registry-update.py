#!/usr/bin/env python3
"""Locked registry.json rewrites for shell and Python writers.

The same lock protects scripts/router/registry.js: a `registry.json.lock`
directory beside the registry, renamed into place complete with its holder's
pid and a per-acquisition nonce (protocol v2; see below).
Every read-modify-write holds it, rereads the registry, and commits through a
unique adjacent temporary file renamed over the registry, keeping its mode, so
readers (the Router's reload) only ever see a whole file and no writer drops
another's change.

    registry-update.py set-project-fields <registry.json> <project> '<json object>'
"""

import errno
import json
import os
import secrets
import stat
import sys
import time
from pathlib import Path

# This file is also loaded by path from a working directory outside scripts/.
_SCRIPTS_DIR = str(Path(__file__).resolve().parent)
if _SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, _SCRIPTS_DIR)

from ccdmlib.platform import atomic, private_fs, proc  # noqa: E402

# Lock protocol v2 matches scripts/router/registry.js exactly (see the comment
# there). A lock directory holds `owner` (exactly "<pid>\n"), `nonce` (unique to
# that acquisition) and, on Windows, `started` (the holder's start time). It is
# built under a unique staging name and renamed into place; a rename failing
# while a lock exists means "held", and with no lock there it is retried for the
# rename budget. It is released by renaming it aside and deleting it, with
# retries, ending in a stderr warning naming the lock rather than a silent leak.
# Liveness is proc.alive with `started`; a lock without `started` is judged by
# PID. The registry is committed by a rename with the same retries. A dead
# holder's lock is removed only by the waiter holding `<lock>.reclaim-<key>` for
# that instance, after rechecking the lock is still that dead instance.
POLL_S = 0.01
# Claims of claims, if claimants keep dying, before a waiter just waits.
MAX_RECLAIM_DEPTH = 4
RENAME_BUDGET_S = atomic.DEFAULT_BUDGET_MS / 1000
MAX_BACKOFF_S = atomic.MAX_BACKOFF_SECONDS
# A commit gets longer on Windows: retries that wake with a busy reader can
# fail for the whole normal budget, and giving up here would lose the change.
COMMIT_BUDGET_MS = 10000 if proc.WIN32 else atomic.DEFAULT_BUDGET_MS
# How often a waiter opens the files inside a held lock. On Windows an open
# file blocks the holder's release, so waiters must not poll them constantly.
HOLDER_CHECK_S = 0.2 if proc.WIN32 else 0.0
LOCK_HELD_ERRNOS = (
    (errno.EPERM, errno.EACCES, errno.EBUSY, errno.ENOTEMPTY, errno.EEXIST)
    if proc.WIN32
    else (errno.ENOTEMPTY, errno.EEXIST)
)


def _timeout_s() -> float:
    try:
        return max(0.0, float(os.environ.get("CCDM_REGISTRY_LOCK_TIMEOUT_MS") or 30000) / 1000)
    except ValueError:
        return 30.0


def _unique_suffix() -> str:
    return f"{os.getpid()}-{secrets.token_hex(8)}"


def _read_trimmed(path: Path):
    try:
        return path.read_text().strip()
    except OSError:
        return None


def _path_exists(path: Path) -> bool:
    """Anything but "not there" counts as there: a lock being deleted cannot be read."""
    try:
        os.stat(path)
    except FileNotFoundError:
        return False
    except OSError:
        return True
    return True


def _warn_not_removed(directory: Path, error) -> None:
    try:
        print(f"registry lock: {directory} could not be removed: {error}", file=sys.stderr)
    except (OSError, ValueError):
        pass


def _lock_instance(directory: Path):
    """The lock instance at `directory` as (pid, key, started), or None when
    there is none or it changed while being read. `started` is None when not
    recorded."""
    try:
        before = os.stat(directory)
    except OSError:
        return None
    nonce = _read_trimmed(directory / "nonce")
    owner = _read_trimmed(directory / "owner")
    started = _read_trimmed(directory / "started")
    try:
        after = os.stat(directory)
    except OSError:
        return None
    if owner is None or after.st_ino != before.st_ino or _read_trimmed(directory / "nonce") != nonce:
        return None
    pid = int(owner) if owner.isascii() and owner.isdigit() else 0
    started = started if started and started.isascii() and started.isdigit() else None
    return pid, (f"n{nonce}" if nonce else f"p{pid}-i{after.st_ino}"), started


def _dead_key(directory: Path):
    """The key of the instance at `directory` if its holder is dead, else None."""
    instance = _lock_instance(directory)
    return instance[1] if instance and not proc.alive(instance[0], instance[2]) else None


def _publish_lock(staging: Path, target: Path) -> bool:
    """Renames the complete `staging` onto `target`; False while `target` is held."""
    deadline = time.monotonic() + RENAME_BUDGET_S
    backoff = 0.001
    while True:
        try:
            os.rename(staging, target)
            return True
        except OSError as error:
            if error.errno not in LOCK_HELD_ERRNOS:
                raise
            if _path_exists(target):
                return False
            if time.monotonic() >= deadline:
                raise
            time.sleep(backoff)
            backoff = min(backoff * 2, MAX_BACKOFF_S)


def _remove_staging(staging: Path) -> None:
    try:
        atomic.remove_dir_with_retry(staging)
    except OSError as error:
        _warn_not_removed(staging, error)


def _create_owned(target: Path):
    """Creates `target` owned by this process; its nonce, or None while held."""
    nonce = secrets.token_hex(16)
    _, started_at = proc.identity()
    staging = target.with_name(f"{target.name}.new-{_unique_suffix()}")
    os.mkdir(staging, 0o700)
    try:
        # Bytes, not text: on Windows text mode would write "\r\n".
        (staging / "owner").write_bytes(f"{os.getpid()}\n".encode("ascii"))
        (staging / "nonce").write_bytes(f"{nonce}\n".encode("ascii"))
        if started_at is not None:
            (staging / "started").write_bytes(f"{started_at}\n".encode("ascii"))
        published = _publish_lock(staging, target)
    except BaseException:
        _remove_staging(staging)
        raise
    if published:
        return nonce
    _remove_staging(staging)
    return None


def _discard(directory: Path) -> bool:
    """Moves `directory` aside and deletes it. False only when it is still in place."""
    aside = directory.with_name(f"{directory.name}.gone-{_unique_suffix()}")
    try:
        atomic.rename_with_retry(directory, aside)
    except FileNotFoundError:
        return True
    except OSError as error:
        _warn_not_removed(directory, error)
        return False
    try:
        atomic.remove_dir_with_retry(aside)
    except OSError as error:
        _warn_not_removed(aside, error)
    return True


def _remove_owned(target: Path, nonce: str) -> None:
    """Removes `target` only while it is still this process's instance `nonce`."""
    deadline = time.monotonic() + RENAME_BUDGET_S
    seen = _read_trimmed(target / "nonce")
    # On Windows a file can be briefly unreadable; that must not leak the lock.
    while proc.WIN32 and seen is None and _path_exists(target):
        if time.monotonic() >= deadline:
            _warn_not_removed(target, "its nonce cannot be read")
            return
        time.sleep(POLL_S)
        seen = _read_trimmed(target / "nonce")
    if seen == nonce:
        _discard(target)


def _reclaim(target: Path, key: str, depth: int = 0) -> bool:
    """Removes the dead instance `key` at `target`, holding its reclaim claim.
    True when this waiter held the claim and the instance is gone either way."""
    claim = target.with_name(f"{target.name}.reclaim-{key}")
    nonce = _create_owned(claim)
    if nonce is None:
        # Another waiter holds the claim; if it died, clear its claim.
        claim_key = _dead_key(claim) if depth < MAX_RECLAIM_DEPTH else None
        return claim_key is not None and _reclaim(claim, claim_key, depth + 1)
    try:
        return _dead_key(target) != key or _discard(target)
    finally:
        _remove_owned(claim, nonce)


def acquire(registry_path):
    """Takes the registry lock; returns the handle `release` takes."""
    lock = Path(f"{registry_path}.lock")
    deadline = time.monotonic() + _timeout_s()
    next_holder_check = 0.0
    while True:
        nonce = _create_owned(lock)
        if nonce is not None:
            return lock, nonce
        if time.monotonic() >= next_holder_check:
            next_holder_check = time.monotonic() + HOLDER_CHECK_S
            key = _dead_key(lock)
            if key is not None and _reclaim(lock, key):
                continue
        _test_note_blocked()
        if time.monotonic() >= deadline:
            holder = ""
            try:
                holder = f" (held by pid {(lock / 'owner').read_text().strip()})"
            except OSError:
                pass
            raise TimeoutError(f"{registry_path} is locked{holder}; retry once the other writer finishes")
        time.sleep(POLL_S)


def release(handle) -> None:
    lock, nonce = handle
    _remove_owned(lock, nonce)


# Test-only (CCDM_TEST_REGISTRY_HOLD=<path>): the E2E suite overlaps and
# interrupts writers deterministically. The next commit after `<path>.armed`
# appears claims it, writes its pid to `<path>.waiting`, and pauses holding
# the lock, its new registry written but not yet renamed into place, until
# it consumes `<path>.release`. A writer that finds the lock held touches
# `<path>.blocked`.
def _test_note_blocked() -> None:
    hold = os.environ.get("CCDM_TEST_REGISTRY_HOLD")
    if hold:
        try:
            Path(f"{hold}.blocked").write_text(f"{os.getpid()}\n")
        except OSError:
            pass


def _test_hold() -> None:
    hold = os.environ.get("CCDM_TEST_REGISTRY_HOLD")
    if not hold:
        return
    try:
        os.rename(f"{hold}.armed", f"{hold}.waiting")
    except OSError:
        return
    Path(f"{hold}.waiting").write_text(f"{os.getpid()}\n")
    while True:
        try:
            os.unlink(f"{hold}.release")
            break
        except OSError:
            time.sleep(POLL_S)
    Path(f"{hold}.waiting").unlink(missing_ok=True)


def _commit(registry_path: Path, registry: dict) -> None:
    mode = stat.S_IMODE(registry_path.stat().st_mode)
    temporary = registry_path.with_name(f".{registry_path.name}.{os.getpid()}.{secrets.token_hex(4)}.tmp")
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as target:
            json.dump(registry, target, indent=2)
            target.write("\n")
            target.flush()
            os.fsync(target.fileno())
        os.chmod(temporary, mode)
        # Windows ignores the mode above; the new file would take its directory's access.
        private_fs.make_file_private(temporary)
        _test_hold()
        atomic.replace_with_retry(temporary, registry_path, COMMIT_BUDGET_MS)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise


def update_registry(registry_path, updater) -> dict:
    """Applies `updater(registry)` to a fresh read under the registry lock."""
    registry_path = Path(registry_path)
    lock = acquire(registry_path)
    try:
        with registry_path.open(encoding="utf-8") as source:
            registry = json.load(source)
        updater(registry)
        _commit(registry_path, registry)
        return registry
    finally:
        release(lock)


def set_project_fields(registry_path, project: str, fields: dict) -> dict:
    def apply(registry: dict) -> None:
        entry = (registry.get("projects") or {}).get(project)
        if not isinstance(entry, dict):
            raise KeyError(f"unknown project: {project}")
        entry.update(fields)
    return update_registry(registry_path, apply)


def main(argv) -> int:
    if len(argv) != 4 or argv[0] != "set-project-fields":
        print("usage: registry-update.py set-project-fields <registry.json> <project> '<json object>'", file=sys.stderr)
        return 2
    _, registry_path, project, fields = argv
    fields = json.loads(fields)
    if not isinstance(fields, dict):
        print("fields must be a JSON object", file=sys.stderr)
        return 2
    try:
        set_project_fields(registry_path, project, fields)
    except (KeyError, OSError, ValueError) as error:
        print(f"Error: {error.args[0] if isinstance(error, KeyError) else error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
