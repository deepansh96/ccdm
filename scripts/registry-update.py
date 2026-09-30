#!/usr/bin/env python3
"""Locked registry.json rewrites for shell and Python writers.

The same lock protects scripts/router/registry.js: a `registry.json.lock`
directory beside the registry, created atomically and naming its holder's pid.
Every read-modify-write holds it, rereads the registry, and commits through a
unique adjacent temporary file renamed over the registry, keeping its mode, so
readers (the Router's reload) only ever see a whole file and no writer drops
another's change.

    registry-update.py set-project-fields <registry.json> <project> '<json object>'
"""

import json
import os
import secrets
import shutil
import stat
import sys
import time
from pathlib import Path

# A lock directory still without an owner file after this long was left by a
# holder that died between creating it and recording its pid.
UNOWNED_STALE_S = 10.0
POLL_S = 0.01


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


def _stale(lock: Path):
    """Returns the stale holder's owner text, or None while the holder may be alive."""
    try:
        owner = (lock / "owner").read_text()
    except FileNotFoundError:
        try:
            return "" if time.time() - lock.stat().st_mtime > UNOWNED_STALE_S else None
        except FileNotFoundError:
            return None
    try:
        pid = int(owner.strip())
    except ValueError:
        pid = 0
    return None if _alive(pid) else owner


def _reclaim(lock: Path, owner: str) -> None:
    aside = lock.with_name(f"{lock.name}.stale-{os.getpid()}-{secrets.token_hex(4)}")
    try:
        os.rename(lock, aside)
    except OSError:
        return
    try:
        moved = (aside / "owner").read_text()
    except FileNotFoundError:
        moved = ""
    if moved != owner:
        # Another waiter reclaimed it first and a live writer took the lock
        # since: hand it back.
        try:
            os.rename(aside, lock)
            return
        except OSError:
            pass
    shutil.rmtree(aside, ignore_errors=True)


def acquire(registry_path) -> Path:
    lock = Path(f"{registry_path}.lock")
    deadline = time.monotonic() + _timeout_s()
    while True:
        try:
            os.mkdir(lock, 0o700)
        except FileExistsError:
            owner = _stale(lock)
            if owner is not None:
                _reclaim(lock, owner)
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
            continue
        (lock / "owner").write_text(f"{os.getpid()}\n")
        return lock


def release(lock: Path) -> None:
    try:
        if int((lock / "owner").read_text().strip()) != os.getpid():
            return
    except (OSError, ValueError):
        return
    shutil.rmtree(lock, ignore_errors=True)


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
