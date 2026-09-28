#!/usr/bin/env python3
"""Thread Supervisor: binds threads in registered project channels to their projects."""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import signal
import sqlite3
import stat
import subprocess
import sys
import threading


def _load(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


STORE = _load("ccdm_thread_store", "thread-supervisor-store.py")
ROUTER = _load("ccdm_thread_router", "thread-supervisor-router.py")
# Discord's longest auto-archive duration, in minutes (one week).
AUTO_ARCHIVE_MINUTES = 10080


def clock_now() -> str:
    clock_file = os.environ.get("CCDM_THREAD_CLOCK_FILE")
    value = (datetime.fromisoformat(Path(clock_file).read_text(encoding="utf-8").strip().replace("Z", "+00:00"))
             if clock_file else datetime.now(timezone.utc))
    return value.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def load_registry(project_root: Path) -> dict:
    with (project_root / "registry.json").open(encoding="utf-8") as source:
        registry = json.load(source)
    if not isinstance(registry, dict):
        raise ValueError("registry must be a JSON object")
    return registry


def root_credentials_present() -> bool:
    directory = Path(os.environ.get("ROOT_DISCORD_STATE_DIR") or Path.home() / ".claude" / "channels" / "discord")
    try:
        lines = (directory / ".env").read_text(encoding="utf-8").splitlines()
    except OSError:
        return False
    token = next((line[len("DISCORD_BOT_TOKEN="):].strip().strip("'\"") for line in lines
                  if line.startswith("DISCORD_BOT_TOKEN=")), "")
    return bool(token) and not any(character.isspace() for character in token)


def configuration_blockers(project_root: Path) -> list[str]:
    blockers = []
    try:
        registry = load_registry(project_root)
    except (OSError, ValueError, json.JSONDecodeError):
        registry = None
        blockers.append("registry.json is unavailable or invalid")
    if registry is not None and not registry.get("discord_user_id"):
        blockers.append("registry.json has no CCDM owner (discord_user_id)")
    if registry is not None and not isinstance(registry.get("projects"), dict):
        blockers.append("registry project assignments are invalid")
    if not root_credentials_present():
        blockers.append("root Discord credentials are unavailable: set DISCORD_BOT_TOKEN in "
                        "ROOT_DISCORD_STATE_DIR/.env (default ~/.claude/channels/discord/.env)")
    return blockers


def preflight(project_root: Path, state_dir: Path) -> dict:
    """Read-only checks: it creates, migrates, and re-permissions nothing."""
    blockers = configuration_blockers(project_root)
    if state_dir.exists() and stat.S_IMODE(state_dir.stat().st_mode) & 0o077:
        blockers.append("the thread supervisor state directory is not private (expected mode 0700)")
    try:
        store = STORE.inspect(state_dir)
    except (OSError, ValueError, sqlite3.Error) as error:
        store = "unusable"
        blockers.append(f"the thread store cannot be used: {error}")
    return {"status": "blocked" if blockers else "ok", "blockers": blockers, "store": store,
            "state_dir": str(state_dir)}


def worker(state_dir: Path) -> dict:
    """Report whether a worker holds the lock, and its pid."""
    lock_path = state_dir / "worker.lock"
    if not lock_path.exists():
        return {"running": False}
    with lock_path.open("r") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            pid = lock.read().strip()
            return {"running": True, "worker_pid": int(pid) if pid.isdigit() else None}
        fcntl.flock(lock, fcntl.LOCK_UN)
    return {"running": False}


def status(state_dir: Path) -> dict:
    projects: dict = {}
    db = STORE.connect(state_dir)
    if db:
        with db:
            for row in STORE.threads(db):
                projects.setdefault(row["project"], {"threads": {}})["threads"][row["thread_id"]] = {
                    "name": row["name"], "creator_id": row["creator_id"], "state": row["state"]}
        db.close()
    return {"status": "ok", **worker(state_dir), "state_dir": str(state_dir), "projects": projects}


def bind(project_root: Path, state_dir: Path, event: dict) -> dict:
    decision = ROUTER.route_thread_create(load_registry(project_root), event)
    if decision["route"] != "bind":
        return {"result": "ignored", "reason": decision["reason"]}
    db = STORE.connect(state_dir, create=True)
    try:
        created = STORE.bind(db, str(event["thread_id"]), decision["project"], str(event.get("name") or ""),
                             str(event["creator_id"]), clock_now())
    finally:
        db.close()
    if not created:
        return {"result": "known", "project": decision["project"]}
    return {"result": "bound", "project": decision["project"], "bot_id": decision["bot_id"],
            "set_auto_archive": event.get("auto_archive_duration") != AUTO_ARCHIVE_MINUTES}


def run(project_root: Path, state_dir: Path) -> dict:
    blockers = configuration_blockers(project_root)
    if blockers:
        return {"status": "blocked", "blockers": blockers}
    STORE.private_directory(state_dir)
    lock_path = state_dir / "worker.lock"
    with lock_path.open("a+") as lock:
        os.chmod(lock_path, 0o600)
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return {"status": "blocked", "reason": "the thread supervisor is already running"}
        lock.truncate(0)
        lock.write(str(os.getpid()))
        lock.flush()
        STORE.connect(state_dir, create=True).close()
        stopping = threading.Event()
        signal.signal(signal.SIGTERM, lambda *_: stopping.set())
        signal.signal(signal.SIGINT, lambda *_: stopping.set())
        observer = subprocess.Popen(
            [os.environ.get("CCDM_THREAD_NODE", "node"), str(Path(__file__).with_name("thread-supervisor-observer.js")),
             "--project-root", str(project_root), "--state-dir", str(state_dir)],
            env={**os.environ, "CCDM_THREAD_STATE_DIR": str(state_dir)})
        try:
            while not stopping.wait(0.2):
                # A group-wide SIGTERM reaches the observer too; let this
                # process's handler run before treating the exit as a failure.
                if observer.poll() is not None and not stopping.wait(0.5):
                    return {"status": "blocked", "reason": "the thread observer stopped"}
        finally:
            observer.terminate()
            try:
                observer.wait(timeout=15)
            except subprocess.TimeoutExpired:
                observer.kill()
                observer.wait()
            lock.truncate(0)
    return {"status": "stopped"}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("run", "status", "preflight", "bind"))
    parser.add_argument("--project-root", type=Path, default=Path(__file__).resolve().parent.parent)
    parser.add_argument("--state-dir", type=Path, default=None)
    parser.add_argument("--payload", help="internal: the observer's thread event as JSON")
    args = parser.parse_args()
    state_dir = args.state_dir or STORE.default_state_dir()
    try:
        if args.command == "status":
            result = status(state_dir)
        elif args.command == "preflight":
            result = preflight(args.project_root, state_dir)
        elif args.command == "bind":
            if not args.payload:
                raise ValueError("--payload is required")
            result = bind(args.project_root, state_dir, json.loads(args.payload))
        else:
            result = run(args.project_root, state_dir)
    except (OSError, ValueError, KeyError, sqlite3.Error, json.JSONDecodeError) as error:
        result = {"status": "blocked", "reason": str(error)}
    print(json.dumps(result, sort_keys=True))
    sys.stdout.flush()
    return 2 if result.get("status") == "blocked" else 0


if __name__ == "__main__":
    raise SystemExit(main())
