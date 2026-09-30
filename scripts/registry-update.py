#!/usr/bin/env python3
"""Locked registry.json rewrites for shell and Python writers.

The same lock protects scripts/router/registry.js: a `registry.json.lock`
directory beside the registry, renamed into place complete with its holder's
pid and a per-acquisition nonce.
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
import shutil
import stat
import sys
import time
from pathlib import Path

# The lock protocol matches scripts/router/registry.js exactly (see the comment
# there): a lock directory holds `owner` (pid) and `nonce` (unique to that
# acquisition), is built under a unique staging name and renamed into place,
# is released by renaming it aside, and a dead holder's lock is removed only by
# the waiter holding `<lock>.reclaim-<key>` for that instance, after
# rechecking the lock is still that dead instance.
POLL_S = 0.01
# Claims of claims, if claimants keep dying, before a waiter just waits.
MAX_RECLAIM_DEPTH = 4


def _timeout_s() -> float:
    try:
        return max(0.0, float(os.environ.get("CCDM_REGISTRY_LOCK_TIMEOUT_MS") or 30000) / 1000)
    except ValueError:
        return 30.0


def _alive(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except PermissionError:
        return True
    except OSError:
        return False
    return True


def _unique_suffix() -> str:
    return f"{os.getpid()}-{secrets.token_hex(8)}"


def _read_trimmed(path: Path):
    try:
        return path.read_text().strip()
    except OSError:
        return None


def _lock_instance(directory: Path):
    """The lock instance at `directory` as (pid, key), or None when there is
    none or it changed while being read."""
    try:
        before = os.stat(directory)
    except OSError:
        return None
    nonce = _read_trimmed(directory / "nonce")
    owner = _read_trimmed(directory / "owner")
    try:
        after = os.stat(directory)
    except OSError:
        return None
    if owner is None or after.st_ino != before.st_ino or _read_trimmed(directory / "nonce") != nonce:
        return None
    pid = int(owner) if owner.isascii() and owner.isdigit() else 0
    return pid, (f"n{nonce}" if nonce else f"p{pid}-i{after.st_ino}")


def _dead_key(directory: Path):
    """The key of the instance at `directory` if its holder is dead, else None."""
    instance = _lock_instance(directory)
    return instance[1] if instance and not _alive(instance[0]) else None


def _create_owned(target: Path):
    """Creates `target` owned by this process; its nonce, or None while held."""
    nonce = secrets.token_hex(16)
    staging = target.with_name(f"{target.name}.new-{_unique_suffix()}")
    os.mkdir(staging, 0o700)
    try:
        (staging / "owner").write_text(f"{os.getpid()}\n")
        (staging / "nonce").write_text(f"{nonce}\n")
        os.rename(staging, target)
        return nonce
    except OSError as error:
        shutil.rmtree(staging, ignore_errors=True)
        if error.errno in (errno.ENOTEMPTY, errno.EEXIST):
            return None
        raise
    except BaseException:
        shutil.rmtree(staging, ignore_errors=True)
        raise


def _discard(directory: Path) -> None:
    """Moves `directory` aside and deletes it."""
    aside = directory.with_name(f"{directory.name}.gone-{_unique_suffix()}")
    try:
        os.rename(directory, aside)
    except OSError:
        return
    shutil.rmtree(aside, ignore_errors=True)


def _remove_owned(target: Path, nonce: str) -> None:
    """Removes `target` only while it is still this process's instance `nonce`."""
    if _read_trimmed(target / "nonce") == nonce:
        _discard(target)


def _reclaim(target: Path, key: str, depth: int = 0) -> bool:
    """Removes the dead instance `key` at `target`, holding its reclaim claim.
    True when this waiter held the claim (the instance is gone either way)."""
    claim = target.with_name(f"{target.name}.reclaim-{key}")
    nonce = _create_owned(claim)
    if nonce is None:
        # Another waiter holds the claim; if it died, clear its claim.
        claim_key = _dead_key(claim) if depth < MAX_RECLAIM_DEPTH else None
        return claim_key is not None and _reclaim(claim, claim_key, depth + 1)
    try:
        if _dead_key(target) == key:
            _discard(target)
    finally:
        _remove_owned(claim, nonce)
    return True


def acquire(registry_path):
    """Takes the registry lock; returns the handle `release` takes."""
    lock = Path(f"{registry_path}.lock")
    deadline = time.monotonic() + _timeout_s()
    while True:
        nonce = _create_owned(lock)
        if nonce is not None:
            return lock, nonce
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
        except FileNotFoundError:
            time.sleep(POLL_S)
    Path(f"{hold}.waiting").unlink(missing_ok=True)


def _commit(registry_path: Path, registry: dict) -> None:
    mode = stat.S_IMODE(registry_path.stat().st_mode)
    temporary = registry_path.with_name(f".{registry_path.name}.{os.getpid()}.{secrets.token_hex(4)}.tmp")
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
    try:
        with os.fdopen(fd, "w") as target:
            json.dump(registry, target, indent=2)
            target.write("\n")
            target.flush()
            os.fsync(target.fileno())
        os.chmod(temporary, mode)
        _test_hold()
        os.replace(temporary, registry_path)
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
