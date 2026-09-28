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
import time


def _load(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


STORE = _load("ccdm_thread_store", "thread-supervisor-store.py")
ROUTER = _load("ccdm_thread_router", "thread-supervisor-router.py")
LAUNCH = _load("ccdm_claude_launch", "claude-launch.py")
# Discord's longest auto-archive duration, in minutes (one week).
AUTO_ARCHIVE_MINUTES = 10080
# How long `disable` waits for a running worker to release its lock.
DISABLE_TIMEOUT_SECONDS = 30
# A thread session that is not ready this long after its trigger, on the
# supervisor clock, fails once and waits for the next owner message.
BOOT_TIMEOUT_SECONDS = 120
BOOTING_EMOJI = "👀"
# Discord message types a person sends: a default message and a reply.
USER_MESSAGE_TYPES = {0, 19}
# A thread's starter reference, carrying the parent-channel message it began from.
THREAD_STARTER_MESSAGE = 21
# Claude Code's startup screens, read from the tmux pane.
READY_TEXT = "Listening for channel messages"
STARTUP_PROMPTS = ("I am using this for local development", "trust the files in this folder", "trust this folder")


def log(message: str) -> None:
    print(f"thread-supervisor: {message}", file=sys.stderr, flush=True)


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


def disabled_marker(state_dir: Path) -> Path:
    return state_dir / "disabled"


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
            "disabled": disabled_marker(state_dir).exists(), "state_dir": str(state_dir)}


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


def permission_targets(registry: dict, project: str | None) -> tuple[list[dict], dict]:
    """Each named project's channel and assigned bot user; projects that cannot be targeted, with why."""
    projects = registry.get("projects") if isinstance(registry.get("projects"), dict) else {}
    if project is not None and project not in projects:
        raise ValueError(f"no registered project named {project}")
    bots = {str(bot.get("id")): bot for bot in registry.get("pool") or [] if isinstance(bot, dict)}
    targets, skipped = [], {}
    for name, entry in projects.items():
        if project is not None and name != project:
            continue
        bot = bots.get(str((entry or {}).get("bot_id") or ""))
        if not (entry or {}).get("channel_id") or not bot or not bot.get("app_id"):
            skipped[name] = "the project has no channel or no assigned pool bot with an app_id"
            continue
        targets.append({"project": name, "channel_id": str(entry["channel_id"]), "bot_user_id": str(bot["app_id"])})
    return targets, skipped


def thread_permissions(project_root: Path, mode: str, project: str | None = None) -> tuple[dict, dict]:
    """Run the root-credential REST helper; return its per-project results and the untargetable projects."""
    registry = load_registry(project_root)
    targets, skipped = permission_targets(registry, project)
    if not targets:
        return {}, skipped
    request = json.dumps({"guild_id": str(registry.get("guild_id") or ""), "targets": targets})
    completed = subprocess.run(
        [os.environ.get("CCDM_THREAD_NODE", "node"), str(Path(__file__).with_name("thread-supervisor-permissions.js")),
         mode, request], capture_output=True, text=True, timeout=120)
    if completed.returncode != 0:
        raise ValueError(completed.stderr.strip() or "the thread permission helper failed")
    return json.loads(completed.stdout), skipped


def grant_thread_permissions(project_root: Path, project: str | None) -> dict:
    results, skipped = thread_permissions(project_root, "grant", project)
    grouped: dict = {"granted": [], "unchanged": [], "failed": {name: reason for name, reason in skipped.items()}}
    for name, outcome in results.items():
        if outcome["result"] == "failed":
            grouped["failed"][name] = outcome["reason"]
        else:
            grouped[outcome["result"]].append(name)
    return {"status": "blocked" if grouped["failed"] else "ok", **grouped}


def thread_permission_report(project_root: Path) -> dict:
    """Projects whose bot lacks Create Public Threads or Manage Threads on its own channel."""
    try:
        results, _ = thread_permissions(project_root, "check")
    except (OSError, ValueError, json.JSONDecodeError, subprocess.SubprocessError) as error:
        return {"status": "unverified", "reason": str(error)}
    report: dict = {"status": "ok", "missing": sorted(name for name, outcome in results.items()
                                                      if outcome["result"] == "missing")}
    unverified = {name: outcome["reason"] for name, outcome in results.items() if outcome["result"] == "failed"}
    if unverified:
        report["unverified"] = unverified
    return report


def status(state_dir: Path, project_root: Path | None = None) -> dict:
    """Bound threads per project; with a project root, also the thread permission report."""
    projects: dict = {}
    db = STORE.connect(state_dir)
    if db:
        with db:
            for row in STORE.threads(db):
                entry = {"name": row["name"], "creator_id": row["creator_id"], "state": row["state"]}
                for field in ("stop_reason", "provider_conversation_id", "runtime_tmux"):
                    if row[field] is not None:
                        entry[field] = row[field]
                buffered = buffer_path(state_dir, row["thread_id"])
                if row["state"] == "booting" and buffered.exists():
                    entry["buffered_messages"] = len(json.loads(buffered.read_text(encoding="utf-8")))
                projects.setdefault(row["project"], {"threads": {}})["threads"][row["thread_id"]] = entry
        db.close()
    result = {"status": "ok", **worker(state_dir), "disabled": disabled_marker(state_dir).exists(),
              "state_dir": str(state_dir), "projects": projects}
    if project_root is not None:
        result["thread_permissions"] = thread_permission_report(project_root)
    return result


def disable(state_dir: Path) -> dict:
    """Stop the worker and keep it stopped: a disabled `run` exits successfully at launch,
    so a LaunchAgent that relaunches only on unsuccessful exits stays down."""
    STORE.private_directory(state_dir)
    marker = disabled_marker(state_dir)
    os.close(os.open(marker, os.O_WRONLY | os.O_CREAT, 0o600))
    os.chmod(marker, 0o600)
    deadline = time.monotonic() + DISABLE_TIMEOUT_SECONDS
    while worker(state_dir)["running"]:
        if time.monotonic() > deadline:
            return {"status": "blocked", "reason": "the thread supervisor worker did not stop", **worker(state_dir)}
        time.sleep(0.1)
    return status(state_dir)


def enable(project_root: Path, state_dir: Path) -> dict:
    """Clear the disabled marker and validate; the operator then starts `run` or reruns the installer."""
    disabled_marker(state_dir).unlink(missing_ok=True)
    return preflight(project_root, state_dir)


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


def boot_dir(state_dir: Path) -> Path:
    directory = state_dir / "boot"
    STORE.private_directory(directory)
    return directory


def buffer_path(state_dir: Path, thread_id: str) -> Path:
    """Messages held for a booting thread's bootstrap; present only until the handoff."""
    return state_dir / "boot" / f"{thread_id}.json"


class BootLock:
    """Serializes the trigger, buffering, and bootstrap handoff of booting threads."""

    def __init__(self, state_dir: Path):
        self.path = boot_dir(state_dir) / "lock"

    def __enter__(self):
        self.file = os.fdopen(os.open(self.path, os.O_RDWR | os.O_CREAT, 0o600), "r+")
        fcntl.flock(self.file, fcntl.LOCK_EX)
        return self

    def __exit__(self, *_):
        fcntl.flock(self.file, fcntl.LOCK_UN)
        self.file.close()


def write_private(path: Path, value) -> None:
    """Atomically replace ``path`` with private JSON."""
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    with os.fdopen(os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w") as f:
        json.dump(value, f)
    os.replace(temporary, path)


def thread_provider(registry: dict, row) -> str:
    project = (registry.get("projects") or {}).get(row["project"]) or {}
    return row["provider"] or project.get("type") or "claude"


def message(project_root: Path, state_dir: Path, event: dict) -> dict:
    """Route one message in a thread: record a starter reference, trigger a
    session start, or hold the message for a booting thread's bootstrap.

    This path is provider-agnostic; only Claude threads start for now."""
    thread_id = str(event.get("thread_id") or "")
    db = STORE.connect(state_dir)
    if not db:
        return {"result": "ignored", "reason": "unbound-thread"}
    try:
        with BootLock(state_dir):
            row = STORE.thread(db, thread_id)
            if not row:
                return {"result": "ignored", "reason": "unbound-thread"}
            if event.get("type") == THREAD_STARTER_MESSAGE:
                if event.get("reference_message_id") and not row["starter_message_id"]:
                    STORE.update(db, thread_id, starter_message_id=str(event["reference_message_id"]))
                return {"result": "starter-recorded"}
            if event.get("type", 0) not in USER_MESSAGE_TYPES:
                return {"result": "ignored", "reason": "system-message"}
            registry = load_registry(project_root)
            project = (registry.get("projects") or {}).get(row["project"])
            if not isinstance(project, dict):
                return {"result": "ignored", "reason": "unregistered-project"}
            author = str(event.get("author_id") or "")
            owner = str(registry.get("discord_user_id") or "")
            if not author or not ROUTER.eligible_creator(registry, project, author):
                return {"result": "ignored", "reason": "ineligible-author"}
            if thread_provider(registry, row) != "claude":
                # Codex threads wait for the Codex thread host.
                return {"result": "ignored", "reason": "provider-not-supported"}
            held = {"id": str(event.get("message_id") or ""), "author_id": author,
                    "author": str(event.get("author_name") or author), "content": str(event.get("content") or ""),
                    "timestamp": str(event.get("timestamp") or clock_now())}
            buffered = buffer_path(state_dir, thread_id)
            activity = {"last_owner_activity_at": clock_now()} if author == owner else {}
            if row["state"] == "booting":
                if not buffered.exists():
                    # Handed off: the session's own Gateway delivers it live.
                    return {"result": "live"}
                earlier = json.loads(buffered.read_text(encoding="utf-8"))
                if any(entry["id"] == held["id"] for entry in earlier):
                    return {"result": "duplicate"}
                write_private(buffered, [*earlier, held])
                if activity:
                    STORE.update(db, thread_id, **activity)
                return {"result": "buffered"}
            # A failed start is never retried automatically: only the next
            # owner message retries it.
            retry = row["state"] == "stopped" and row["stop_reason"] == "start-failed" and author == owner
            if row["state"] != "registered" and not retry:
                return {"result": "ignored", "reason": f"thread is {row['state']}"}
            write_private(buffered, [held])
            STORE.update(db, thread_id, state="booting", stop_reason=None, **activity)
            return {"result": "start", "thread_id": thread_id}
    finally:
        db.close()


def discord_request(project_root: Path, operation: str, request: dict):
    """One side effect through the project-bot REST helper; None when it fails."""
    completed = subprocess.run(
        [os.environ.get("CCDM_THREAD_NODE", "node"), str(Path(__file__).with_name("thread-supervisor-discord.js")),
         operation, json.dumps({**request, "project_root": str(project_root)})],
        capture_output=True, text=True, timeout=60)
    if completed.returncode != 0:
        log(completed.stderr.strip() or f"Discord {operation} failed")
        return None
    return json.loads(completed.stdout or "null")


def tmux(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["tmux", *args], capture_output=True, text=True, timeout=30)


def elapsed_seconds(since: str) -> float:
    parse = lambda value: datetime.fromisoformat(value.replace("Z", "+00:00"))
    return (parse(clock_now()) - parse(since)).total_seconds()


def claude_session(resolved: dict) -> tuple[int | None, str | None]:
    """The thread's Claude pid and its session id from <claude_home>/sessions/<pid>.json."""
    home = Path(resolved["claude_home"] or Path.home() / ".claude")
    for _ in range(40):
        for pid in LAUNCH.listener_pids(resolved["state_dir"]):
            try:
                session = json.loads((home / "sessions" / f"{pid}.json").read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            return pid, session.get("sessionId") or session.get("session_id") or session.get("id")
        time.sleep(0.25)
    return None, None


def bootstrap(row, owner: str, starter: dict | None, held: list[dict]) -> dict:
    """The thread's first prompt, as one synthetic channel notification."""
    thread_id = row["thread_id"]
    lines = [f'You are in the Discord thread "{row["name"]}" (chat_id {thread_id}) under this project\'s channel. '
             "It is its own conversation: reply only in this thread, with chat_id "
             f"{thread_id}. You cannot read or post in the parent channel or in other threads."]
    if starter:
        lines += ["", f"The thread was started from this channel message by {starter['author']}:", starter["content"]]
    lines += ["", "Messages in this thread so far:"]
    lines += [f"{message['author']}: {message['content']}" for message in held]
    owner_messages = [message for message in held if message["author_id"] == owner] or held
    latest = owner_messages[-1]
    return {
        "content": "\n".join(lines),
        "meta": {"chat_id": thread_id, "message_id": latest["id"], "user_id": latest["author_id"],
                 "user": latest["author"], "ts": latest["timestamp"]},
        "included_message_ids": [*([starter["id"]] if starter else []), *(message["id"] for message in held)],
    }


def boot(project_root: Path, state_dir: Path, thread_id: str) -> dict:
    """Launch a Claude thread session, accept its startup prompts, and hand over the bootstrap."""
    started = clock_now()
    db = STORE.connect(state_dir)
    row = STORE.thread(db, thread_id) if db else None
    if not row or row["state"] != "booting":
        return {"status": "blocked", "reason": f"thread {thread_id} is not booting"}
    registry = load_registry(project_root)
    bot_id = registry["projects"][row["project"]]["bot_id"]
    with BootLock(state_dir):
        trigger = json.loads(buffer_path(state_dir, thread_id).read_text(encoding="utf-8"))[0]["id"]
    reaction = {"bot_id": bot_id, "channel_id": thread_id, "message_id": trigger, "emoji": BOOTING_EMOJI}
    discord_request(project_root, "react", reaction)
    resolved = LAUNCH.resolve(str(project_root / "registry.json"), row["project"], thread_id)

    def fail(reason: str) -> dict:
        with BootLock(state_dir):
            buffer_path(state_dir, thread_id).unlink(missing_ok=True)
            STORE.update(db, thread_id, state="stopped", stop_reason="start-failed", runtime_tmux=None, runtime_pid=None)
        tmux("kill-session", "-t", f"={resolved['session_name']}")
        for pid in LAUNCH.listener_pids(resolved["state_dir"]):
            try:
                os.kill(pid, signal.SIGTERM)
            except OSError:
                pass
        log(f"thread {thread_id} failed to start: {reason}")
        discord_request(project_root, "post", {"bot_id": bot_id, "channel_id": thread_id,
                                               "content": f"Thread session failed to start: {reason}"})
        discord_request(project_root, "unreact", reaction)
        db.close()
        return {"status": "failed", "reason": reason}

    launched = subprocess.run([str(Path(__file__).with_name("start-thread-session.sh")), row["project"], thread_id],
                              capture_output=True, text=True, timeout=120)
    if launched.returncode != 0:
        detail = (launched.stderr.strip() or launched.stdout.strip() or "the Claude thread launcher failed")
        return fail(detail.splitlines()[-1])
    session = resolved["session_name"]
    answered = None
    while True:
        pane = tmux("capture-pane", "-p", "-t", f"={session}")
        if pane.returncode != 0:
            return fail("the Claude session exited during startup.")
        if READY_TEXT in pane.stdout:
            break
        if pane.stdout != answered and any(prompt in pane.stdout for prompt in STARTUP_PROMPTS):
            tmux("send-keys", "-t", f"={session}", "Enter")
            answered = pane.stdout
        if elapsed_seconds(started) >= BOOT_TIMEOUT_SECONDS:
            return fail(f"Claude was not ready within {BOOT_TIMEOUT_SECONDS} seconds.")
        time.sleep(0.2)

    pid, session_id = claude_session(resolved)
    starter = None
    if row["starter_message_id"]:
        starter = discord_request(project_root, "get-message", {
            "bot_id": bot_id, "channel_id": resolved["channel_id"], "message_id": row["starter_message_id"]})
    with BootLock(state_dir):
        buffered = buffer_path(state_dir, thread_id)
        held = json.loads(buffered.read_text(encoding="utf-8"))
        write_private(Path(resolved["bootstrap_file"]), bootstrap(row, str(registry.get("discord_user_id") or ""), starter, held))
        buffered.unlink()
        STORE.update(db, thread_id, state="live", stop_reason=None, resolved_provider="claude",
                     resolved_account=resolved["claude_home"], resolved_model=resolved["model"],
                     resolved_effort=resolved["effort"], provider_conversation_id=session_id,
                     provider_home=str(resolved["claude_home"] or Path.home() / ".claude"),
                     runtime_tmux=session, runtime_pid=pid)
    discord_request(project_root, "unreact", reaction)
    db.close()
    return {"status": "live", "thread_id": thread_id, "session_id": session_id}


def run(project_root: Path, state_dir: Path) -> dict:
    blockers = configuration_blockers(project_root)
    if blockers:
        return {"status": "blocked", "blockers": blockers}
    if disabled_marker(state_dir).exists():
        return {"status": "disabled", "disabled": True}
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
            while not stopping.wait(0.2) and not disabled_marker(state_dir).exists():
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
    parser.add_argument("command", choices=("run", "status", "preflight", "disable", "enable", "bind", "message",
                                            "boot", "grant-thread-permissions"))
    parser.add_argument("--project-root", type=Path, default=Path(__file__).resolve().parent.parent)
    parser.add_argument("--state-dir", type=Path, default=None)
    parser.add_argument("--payload", help="internal: the observer's thread event as JSON")
    parser.add_argument("--thread-id", help="internal: the thread `boot` starts")
    target = parser.add_mutually_exclusive_group()
    target.add_argument("--project", help="grant-thread-permissions: only this registered project")
    target.add_argument("--all", action="store_true", help="grant-thread-permissions: every registered project")
    args = parser.parse_args()
    if args.command == "grant-thread-permissions" and not (args.project or args.all):
        parser.error("grant-thread-permissions needs --project <project> or --all")
    state_dir = args.state_dir or STORE.default_state_dir()
    try:
        if args.command == "status":
            result = status(state_dir, args.project_root)
        elif args.command == "preflight":
            result = preflight(args.project_root, state_dir)
        elif args.command == "disable":
            result = disable(state_dir)
        elif args.command == "enable":
            result = enable(args.project_root, state_dir)
        elif args.command == "bind":
            if not args.payload:
                raise ValueError("--payload is required")
            result = bind(args.project_root, state_dir, json.loads(args.payload))
        elif args.command == "message":
            if not args.payload:
                raise ValueError("--payload is required")
            result = message(args.project_root, state_dir, json.loads(args.payload))
        elif args.command == "boot":
            if not args.thread_id:
                raise ValueError("--thread-id is required")
            result = boot(args.project_root, state_dir, args.thread_id)
        elif args.command == "grant-thread-permissions":
            result = grant_thread_permissions(args.project_root, args.project)
        else:
            result = run(args.project_root, state_dir)
    except (OSError, ValueError, KeyError, sqlite3.Error, json.JSONDecodeError, subprocess.SubprocessError) as error:
        result = {"status": "blocked", "reason": str(error)}
    print(json.dumps(result, sort_keys=True))
    sys.stdout.flush()
    return 2 if result.get("status") == "blocked" else 0


if __name__ == "__main__":
    raise SystemExit(main())
