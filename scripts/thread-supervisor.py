#!/usr/bin/env python3
"""Thread Supervisor: binds threads in registered project channels to their projects."""

from __future__ import annotations

import argparse
import base64
from datetime import datetime, timezone
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import signal
import socket
import sqlite3
import stat
import subprocess
import sys
import threading
import time
import uuid


def _load(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


STORE = _load("ccdm_thread_store", "thread-supervisor-store.py")
ROUTER = _load("ccdm_thread_router", "thread-supervisor-router.py")
LAUNCH = _load("ccdm_claude_launch", "claude-launch.py")
CODEX_HOME = _load("ccdm_codex_home", "resolve-codex-home.py")
# Discord's longest auto-archive duration, in minutes (one week).
AUTO_ARCHIVE_MINUTES = 10080
# How long `disable` waits for a running worker to release its lock.
DISABLE_TIMEOUT_SECONDS = 30
# A thread session that is not ready this long after its trigger, on the
# supervisor clock, fails once and waits for the next owner message.
BOOT_TIMEOUT_SECONDS = 120
BOOTING_EMOJI = "👀"
# How long, on the supervisor clock, an archive waits for its audit-log actor
# before it is treated as an auto-archive, and the real-time retry interval.
ARCHIVE_ACTOR_TIMEOUT_SECONDS = 60
ARCHIVE_ACTOR_RETRY_SECONDS = 0.5
# Discord message types a person sends: a default message and a reply.
USER_MESSAGE_TYPES = {0, 19}
# A thread's starter reference, carrying the parent-channel message it began from.
THREAD_STARTER_MESSAGE = 21
THREAD_USAGE = "/thread <name> [--provider claude|codex] [--account X] [--model Y] [--effort Z] [first message…]"
THREAD_FLAGS = ("provider", "account", "model", "effort")
# Discord's thread name limit.
THREAD_NAME_LIMIT = 100
PROVIDER_LABELS = {"claude": "Claude", "codex": "Codex"}
# The reasoning efforts each provider's channel launch accepts: Claude Code's
# `--effort` values and Codex's `model_reasoning_effort` values.
PROVIDER_EFFORTS = {"claude": LAUNCH.EFFORTS,
                    "codex": ("none", "minimal", "low", "medium", "high", "xhigh")}
CONFIG_HINT = "/config works inside a thread: send it in the thread whose settings you want to see or change."
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


def root_user_id(registry: dict) -> str:
    """The root bot's user id, decoded from its token's first segment when possible."""
    directory = Path(os.environ.get("ROOT_DISCORD_STATE_DIR") or Path.home() / ".claude" / "channels" / "discord")
    try:
        lines = (directory / ".env").read_text(encoding="utf-8").splitlines()
        token = next(line[len("DISCORD_BOT_TOKEN="):].strip().strip("'\"") for line in lines
                     if line.startswith("DISCORD_BOT_TOKEN="))
        encoded = token.split(".")[0]
        decoded = base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4)).decode("ascii")
        if decoded.isdigit():
            return decoded
    except (OSError, StopIteration, ValueError, UnicodeDecodeError):
        pass
    return str(registry.get("root_bot_app_id") or "")


def audit_log(project_root: Path, mode: str, request: dict) -> dict | None:
    """One root-credential audit-log read; None when it fails for any reason but a 403."""
    try:
        completed = subprocess.run(
            [os.environ.get("CCDM_THREAD_NODE", "node"), str(Path(__file__).with_name("thread-supervisor-audit.js")),
             mode, json.dumps(request)], capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.SubprocessError) as error:
        log(f"audit-log {mode} failed: {error}")
        return None
    if completed.returncode != 0:
        log(completed.stderr.strip() or f"audit-log {mode} failed")
        return None
    return json.loads(completed.stdout)


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
    # Archives are classified by their audit-log actor, which needs View Audit Log.
    audit = "unverified"
    try:
        guild_id = str(load_registry(project_root).get("guild_id") or "")
    except (OSError, ValueError, json.JSONDecodeError):
        guild_id = ""
    if guild_id and root_credentials_present():
        checked = audit_log(project_root, "check", {"guild_id": guild_id})
        audit = checked["result"] if checked else "unverified"
    if audit == "forbidden":
        blockers.append("the root bot lacks View Audit Log in the guild, so thread archives cannot be told apart "
                        "from auto-archives; grant View Audit Log to the root bot's role")
    return {"status": "blocked" if blockers else "ok", "blockers": blockers, "store": store, "audit_log": audit,
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
                if row["archive_actor"] == "unknown":
                    entry["archive"] = "archive-actor-unknown"
                buffered = buffer_path(state_dir, row["thread_id"])
                if row["state"] == "booting" and buffered.exists():
                    entry["buffered_messages"] = len(json.loads(buffered.read_text(encoding="utf-8")))
                projects.setdefault(row["project"], {"threads": {}})["threads"][row["thread_id"]] = entry
            for row in STORE.requests(db):
                request = {"name": row["name"], "requester_kind": row["requester_kind"], "status": row["status"]}
                if row["thread_id"] is not None:
                    request["thread_id"] = row["thread_id"]
                project = projects.setdefault(row["project"], {"threads": {}})
                project.setdefault("creation_requests", {})[row["request_id"]] = request
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
    """Bind a new thread. A thread created by the project's bot or root binds
    only because it fulfils a pending creation request, whose overrides it takes."""
    registry = load_registry(project_root)
    db = STORE.connect(state_dir, create=True)
    try:
        request = STORE.pending_request(db, str(event.get("thread_id") or ""))
        decision = ROUTER.route_thread_create(registry, event, request["project"] if request else None,
                                              root_user_id(registry))
        if decision["route"] != "bind":
            return {"result": "ignored", "reason": decision["reason"]}
        if request and request["project"] != decision["project"]:
            request = None
        created = STORE.bind(db, str(event["thread_id"]), decision["project"], str(event.get("name") or ""),
                             str(event["creator_id"]), clock_now(), request)
    finally:
        db.close()
    if not created:
        return {"result": "known", "project": decision["project"]}
    return {"result": "bound", "project": decision["project"], "bot_id": decision["bot_id"],
            "set_auto_archive": event.get("auto_archive_duration") != AUTO_ARCHIVE_MINUTES}


class CommandError(ValueError):
    """A `/thread` command the supervisor refuses, with its one-line reason."""


def parse_thread_command(registry: dict, project: dict, arguments: str) -> dict:
    """`<name> [--provider claude|codex] [--account X] [--model Y] [--effort Z] [first message…]`.
    Flags come before the first message; each is validated against the provider
    the thread will run."""
    def token(text: str) -> tuple[str, str]:
        parts = text.split(None, 1)
        return (parts[0], parts[1] if len(parts) > 1 else "") if parts else ("", "")

    name, rest = token(arguments)
    if not name or name.startswith("--"):
        raise CommandError(f"usage: {THREAD_USAGE}")
    if len(name) > THREAD_NAME_LIMIT:
        raise CommandError(f"a thread name has at most {THREAD_NAME_LIMIT} characters.")
    overrides: dict = {}
    while rest.startswith("--"):
        flag, rest = token(rest)
        value, rest = token(rest)
        if flag[2:] not in THREAD_FLAGS:
            raise CommandError(f"unknown option {flag}; use {THREAD_USAGE}")
        if not value or value.startswith("--"):
            raise CommandError(f"{flag} needs a value.")
        overrides[flag[2:]] = value
    project_provider = project.get("type") or "claude"
    provider = overrides.get("provider", project_provider)
    if provider not in PROVIDER_EFFORTS:
        raise CommandError("--provider must be claude or codex.")
    account = overrides.get("account")
    if account is not None:
        # Only a configured alias selects an account; a Discord message never names a directory (ADR 0003).
        if "/" in account or account.startswith(("~", ".")):
            raise CommandError("--account takes an account alias, not a path.")
        aliases = registry.get("codex_accounts" if provider == "codex" else "claude_accounts")
        if not isinstance(aliases, dict) or account not in aliases:
            raise CommandError(f"--account {account} is not a configured {PROVIDER_LABELS[provider]} account alias.")
    model = overrides.get("model")
    if model is not None and not re.fullmatch(r"[A-Za-z0-9._:/\[\]-]+", model):
        raise CommandError("--model has characters a model name never uses.")
    effort = overrides.get("effort")
    if effort is not None and effort not in PROVIDER_EFFORTS[provider]:
        raise CommandError(f"--effort for {PROVIDER_LABELS[provider]} must be one of "
                           f"{', '.join(PROVIDER_EFFORTS[provider])}.")
    return {"name": name, "first_message": rest.strip() or None,
            "overrides": {"provider": overrides.get("provider"), "account": account, "model": model, "effort": effort}}


def channel_command(project_root: Path, state_dir: Path, event: dict) -> dict:
    """Handle `/thread` or `/config` typed by the owner or a guest in a
    registered project channel. `/thread` records a creation request, creates
    the thread with the project bot, and binds it by fulfilling the request;
    with a first message it also asks for the session start."""
    registry = load_registry(project_root)
    channel_id = str(event.get("channel_id") or "")
    found = ROUTER.project_for_channel(registry, channel_id)
    if not found:
        return {"result": "ignored", "reason": "unregistered-channel"}
    project_name, project = found
    if str(project.get("path") or "").startswith("remote:"):
        return {"result": "ignored", "reason": "remote-project"}
    author = str(event.get("author_id") or "")
    if not ROUTER.eligible_creator(registry, project, author):
        return {"result": "ignored", "reason": "ineligible-author"}
    text = str(event.get("content") or "").strip()
    for app_id in (ROUTER.bot_user_id(registry, project), root_user_id(registry)):
        for mention in (f"<@{app_id}>", f"<@!{app_id}>"):
            if app_id and text.startswith(mention):
                text = text[len(mention):].strip()
    command = re.fullmatch(r"/(thread|config)(?:\s+([\s\S]*))?", text)
    if not command:
        return {"result": "ignored", "reason": "not-a-command"}
    bot_id = project["bot_id"]

    def say(line: str) -> None:
        discord_request(project_root, "post", {"bot_id": bot_id, "channel_id": channel_id, "content": line})

    if command.group(1) == "config":
        say(CONFIG_HINT)
        return {"result": "config-hint"}
    try:
        parsed = parse_thread_command(registry, project, command.group(2) or "")
    except CommandError as error:
        say(f"/thread: {error}")
        return {"result": "rejected", "reason": str(error)}
    request_id = str(uuid.uuid4())
    kind = "owner" if author == str(registry.get("discord_user_id") or "") else "guest"
    db = STORE.connect(state_dir, create=True)
    try:
        STORE.create_request(db, request_id, project_name, parsed["name"], parsed["overrides"],
                             parsed["first_message"], author, kind, clock_now())
        created = discord_request(project_root, "create-thread", {"bot_id": bot_id, "channel_id": channel_id,
                                                                  "name": parsed["name"]})
        if not created:
            STORE.update_request(db, request_id, status="failed")
            say("/thread: Discord did not create the thread; check the bot's Create Public Threads permission.")
            return {"result": "failed", "request_id": request_id}
        thread_id = str(created["id"])
        STORE.update_request(db, request_id, thread_id=thread_id)
    finally:
        db.close()
    bound = bind(project_root, state_dir, {"thread_id": thread_id, "type": ROUTER.PUBLIC_THREAD, "parent_id": channel_id,
                                           "parent_type": 0, "name": parsed["name"],
                                           "creator_id": str(created.get("owner_id") or ROUTER.bot_user_id(registry, project)),
                                           "auto_archive_duration": AUTO_ARCHIVE_MINUTES})
    if not parsed["first_message"]:
        # The thread waits for the first owner or guest message in it.
        return {"result": "created", "thread_id": thread_id, "bind": bound["result"]}
    held = {"id": str(event.get("message_id") or ""), "channel_id": channel_id, "author_id": author,
            "author": str(event.get("author_name") or author), "content": parsed["first_message"],
            "timestamp": str(event.get("timestamp") or clock_now())}
    db = STORE.connect(state_dir)
    try:
        with BootLock(state_dir):
            row = STORE.thread(db, thread_id)
            if not row or row["state"] != "registered":
                return {"result": "created", "thread_id": thread_id, "bind": bound["result"]}
            write_private(buffer_path(state_dir, thread_id), [held])
            activity = {"last_owner_activity_at": clock_now()} if kind == "owner" else {}
            STORE.update(db, thread_id, state="booting", **activity)
    finally:
        db.close()
    return {"result": "start", "thread_id": thread_id}


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

    This path is provider-agnostic."""
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
            # Only an owner message resumes a stopped or closed thread, and a
            # failed start is never retried automatically.
            resume = row["state"] in ("stopped", "closed") and author == owner
            if row["state"] != "registered" and not resume:
                return {"result": "ignored", "reason": f"thread is {row['state']}"}
            write_private(buffered, [held])
            STORE.update(db, thread_id, state="booting", stop_reason=None, archive_actor=None, **activity)
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


def host_runtime_dir(state_dir: Path, project: str) -> Path:
    """The private runtime dir of a project's Codex thread host, holding its control socket."""
    return state_dir / "hosts" / re.sub(r"[^A-Za-z0-9._-]", "_", project)


def host_request(runtime_dir: Path, request: dict, timeout: float = 10) -> dict | None:
    """One request on a Codex thread host's control socket; None when the host is unreachable.
    The socket is addressed relative to its directory: an absolute path can exceed the Unix socket limit."""
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
            client.settimeout(timeout)
            previous = os.getcwd()
            os.chdir(runtime_dir)
            try:
                client.connect("control.sock")
            finally:
                os.chdir(previous)
            client.sendall(json.dumps(request).encode("utf-8") + b"\n")
            with client.makefile("rb") as replies:
                line = replies.readline()
        return json.loads(line) if line else None
    except (OSError, ValueError):
        return None


def stop_runtime(project_root: Path, state_dir: Path, row) -> None:
    """The provider-agnostic stop hook: end a thread's session and remove its
    per-thread runtime files (state dir with launch files, inbox, and
    bootstrap; held boot messages), keeping the row so the thread can resume.
    Provider conversation files are never touched. A Codex thread's
    conversation is unloaded from its project's thread host."""
    thread_id = row["thread_id"]
    with BootLock(state_dir):
        buffer_path(state_dir, thread_id).unlink(missing_ok=True)
    try:
        provider = thread_provider(load_registry(project_root), row)
    except (OSError, ValueError):
        provider = None
    if provider == "codex":
        host_request(host_runtime_dir(state_dir, row["project"]), {"op": "stop", "thread_id": thread_id})
        return
    try:
        resolved = LAUNCH.resolve(str(project_root / "registry.json"), row["project"], thread_id)
    except (OSError, ValueError, KeyError, StopIteration, SystemExit):
        resolved = None
    session = row["runtime_tmux"] or (resolved and resolved["session_name"])
    if session:
        tmux("kill-session", "-t", f"={session}")
    if resolved:
        for pid in LAUNCH.listener_pids(resolved["state_dir"]):
            try:
                os.kill(pid, signal.SIGTERM)
            except OSError:
                pass
        shutil.rmtree(resolved["state_dir"], ignore_errors=True)


def archive_actor(project_root: Path, registry: dict, event: dict) -> str | None:
    """Who archived the thread, from audit-log action 111; None when root may
    not read the audit log or no entry appears within the retry window."""
    started = clock_now()
    request = {"guild_id": str(registry.get("guild_id") or ""), "thread_id": str(event["thread_id"]),
               "archived_at": event.get("archived_at")}
    while True:
        found = audit_log(project_root, "actor", request)
        if found and found["result"] == "found":
            return found["user_id"]
        if found and found["result"] == "forbidden":
            log(f"thread {event['thread_id']}: the root bot cannot read the audit log; treating it as auto-archived")
            return None
        if elapsed_seconds(started) >= ARCHIVE_ACTOR_TIMEOUT_SECONDS:
            return None
        time.sleep(ARCHIVE_ACTOR_RETRY_SECONDS)


def archive(project_root: Path, state_dir: Path, event: dict) -> dict:
    """Stop an archived thread's session. An archive by the owner or root
    closes the conversation; any other actor, or none, is an auto-archive that
    leaves it open for the owner's next message."""
    thread_id = str(event.get("thread_id") or "")
    db = STORE.connect(state_dir)
    if not db:
        return {"result": "ignored", "reason": "unbound-thread"}
    try:
        if not STORE.thread(db, thread_id):
            return {"result": "ignored", "reason": "unbound-thread"}
        registry = load_registry(project_root)
        actor = archive_actor(project_root, registry, {**event, "thread_id": thread_id})
        closed = actor is not None and actor in {str(registry.get("discord_user_id") or ""), root_user_id(registry)}
        row = STORE.thread(db, thread_id)
        if not row:
            return {"result": "ignored", "reason": "deleted"}
        stop_runtime(project_root, state_dir, row)
        # An auto-archive never reopens a Closed Conversation.
        if closed or row["state"] == "closed":
            fields = {"state": "closed", "stop_reason": None}
        else:
            fields = {"state": "stopped", "stop_reason": "auto-archive"}
        STORE.update(db, thread_id, **fields, runtime_tmux=None, runtime_pid=None, archive_actor=actor or "unknown")
        return {"result": fields["state"], "thread_id": thread_id, "archive_actor": actor or "unknown"}
    finally:
        db.close()


def delete(project_root: Path, state_dir: Path, event: dict) -> dict:
    """Forget a deleted thread: stop its session and drop its row and runtime files."""
    thread_id = str(event.get("thread_id") or "")
    db = STORE.connect(state_dir)
    if not db:
        return {"result": "ignored", "reason": "unbound-thread"}
    try:
        row = STORE.thread(db, thread_id)
        if not row:
            return {"result": "ignored", "reason": "unbound-thread"}
        stop_runtime(project_root, state_dir, row)
        STORE.forget(db, thread_id)
        return {"result": "forgotten", "thread_id": thread_id}
    finally:
        db.close()


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


def boot_failed(project_root: Path, state_dir: Path, db, thread_id: str, reaction: dict, reason: str) -> dict:
    """A thread start failed: stop it as start-failed, post one line, and remove 👀.
    Only the next owner message retries."""
    with BootLock(state_dir):
        buffer_path(state_dir, thread_id).unlink(missing_ok=True)
        STORE.update(db, thread_id, state="stopped", stop_reason="start-failed", runtime_tmux=None, runtime_pid=None,
                     runtime_host=None)
    stop_runtime(project_root, state_dir, STORE.thread(db, thread_id))
    log(f"thread {thread_id} failed to start: {reason}")
    discord_request(project_root, "post", {"bot_id": reaction["bot_id"], "channel_id": thread_id,
                                           "content": f"Thread session failed to start: {reason}"})
    discord_request(project_root, "unreact", reaction)
    return {"status": "failed", "reason": reason}


def codex_settings(registry: dict, row) -> dict:
    """The Codex Home, model, effort, and sandbox a Codex thread runs with:
    each thread override, else the project's value. A Codex thread in a Claude
    project inherits nothing Claude-specific: without an account it uses the
    Default Codex Account, and without a model or effort, the home's own."""
    project = registry["projects"][row["project"]]
    native = (project.get("type") or "claude") == "codex"
    if row["account"]:
        home = CODEX_HOME.resolve_account_home(CODEX_HOME.codex_accounts(registry), row["account"],
                                               f"thread {row['thread_id']} account")
    elif native:
        home = CODEX_HOME.resolve_codex_home(registry, row["project"])
    else:
        home = CODEX_HOME.resolve_codex_home({**registry, "projects": {row["project"]: {}}}, row["project"])
    inherited = project if native else {}
    return {"home": home, "model": row["model"] or inherited.get("codex_model") or inherited.get("model"),
            "effort": row["effort"] or inherited.get("codex_reasoning_effort") or inherited.get("model_reasoning_effort"),
            "sandbox": project.get("codex_sandbox") or "danger-full-access"}


def claude_overrides(row) -> dict:
    """A Claude thread's account, model, and effort overrides for `claude-launch.py`."""
    return {field: row[field] for field in ("account", "model", "effort") if row[field]}


def quoted(value) -> str:
    return "'" + str(value).replace("'", "'\\''") + "'"


def ensure_host(project_root: Path, state_dir: Path, project: str, session: str, started: str) -> str | None:
    """Start the project's Codex thread host in tmux unless it runs; None once
    its control socket answers, otherwise why it did not. A host that is
    exiting because its last thread stopped is waited out and started again."""
    runtime_dir = host_runtime_dir(state_dir, project)
    launched_here = False
    while True:
        if tmux("has-session", "-t", f"={session}").returncode != 0:
            if launched_here:
                return "the Codex thread host exited during startup."
            command = (f"cd {quoted(project_root)} && node scripts/codex-thread-host.js --project {quoted(project)} "
                       f"--state-dir {quoted(state_dir)}")
            launched = tmux("new-session", "-d", "-s", session, "--", "zsh", "-ic", command)
            if launched.returncode != 0:
                log(launched.stderr.strip() or f"tmux new-session {session} failed")
                return "the Codex thread host could not be launched."
            launched_here = True
        answer = host_request(runtime_dir, {"op": "ping"})
        if answer and answer.get("ok"):
            return None
        if elapsed_seconds(started) >= BOOT_TIMEOUT_SECONDS:
            return f"the Codex thread host was not ready within {BOOT_TIMEOUT_SECONDS} seconds."
        time.sleep(0.2)


def codex_boot(project_root: Path, state_dir: Path, db, row, registry: dict, reaction: dict, started: str) -> dict:
    """Open a Codex thread conversation on the project's thread host, which
    reports it ready or failed through `host-event`."""
    thread_id = row["thread_id"]

    def fail(reason: str) -> dict:
        result = boot_failed(project_root, state_dir, db, thread_id, reaction, reason)
        db.close()
        return result

    try:
        settings = codex_settings(registry, row)
    except CODEX_HOME.ResolverError as error:
        return fail(str(error))
    project = registry["projects"][row["project"]]
    session = f"{project['screen_name']}-threads"
    # A thread with a stored conversation resumes it on the same Codex Home;
    # an account change starts fresh.
    resume = row["provider_conversation_id"] if row["provider_home"] == settings["home"] else None
    starter = None
    if row["starter_message_id"] and not resume:
        starter = discord_request(project_root, "get-message", {
            "bot_id": reaction["bot_id"], "channel_id": str(project["channel_id"]),
            "message_id": row["starter_message_id"]})
    runtime_dir = host_runtime_dir(state_dir, row["project"])
    while True:
        problem = ensure_host(project_root, state_dir, row["project"], session, started)
        if problem:
            return fail(problem)
        with BootLock(state_dir):
            buffered = buffer_path(state_dir, thread_id)
            held = json.loads(buffered.read_text(encoding="utf-8"))
            opened = host_request(runtime_dir, {"op": "open", "thread": {
                "thread_id": thread_id, "name": row["name"], **settings,
                **({"conversation_id": resume} if resume else {})}, "starter": starter, "messages": held,
                "trigger_message_id": reaction["message_id"], "trigger_channel_id": reaction["channel_id"]})
            if opened and opened.get("ok"):
                # Handed off: the host's own Gateway delivers later messages.
                buffered.unlink()
                STORE.update(db, thread_id, resolved_provider="codex", resolved_account=settings["home"],
                             resolved_model=settings["model"], resolved_effort=settings["effort"],
                             runtime_tmux=session, runtime_host=str(runtime_dir / "control.sock"),
                             runtime_home=settings["home"])
        # A host exiting after its last thread stopped refuses new threads; start another.
        if not (opened and opened.get("stopping")) or elapsed_seconds(started) >= BOOT_TIMEOUT_SECONDS:
            break
        time.sleep(0.2)
    if not (opened and opened.get("ok")):
        return fail((opened or {}).get("error") or "the Codex thread host did not accept the thread.")
    while True:
        current = STORE.thread(db, thread_id)
        if not current or current["state"] != "booting":
            db.close()
            return {"status": current["state"] if current else "forgotten", "thread_id": thread_id}
        if elapsed_seconds(started) >= BOOT_TIMEOUT_SECONDS:
            return fail(f"Codex was not ready within {BOOT_TIMEOUT_SECONDS} seconds.")
        time.sleep(0.2)


def host_event(project_root: Path, state_dir: Path, event: dict) -> dict:
    """Record one event the Codex thread host reports about a thread it hosts."""
    thread_id = str(event.get("thread_id") or "")
    kind = event.get("event")
    db = STORE.connect(state_dir)
    if not db:
        return {"result": "ignored", "reason": "unbound-thread"}
    try:
        row = STORE.thread(db, thread_id)
        if not row:
            return {"result": "ignored", "reason": "unbound-thread"}
        if kind == "conversation-id":
            STORE.update(db, thread_id, provider_conversation_id=str(event["conversation_id"]),
                         provider_home=str(event["home"]))
        elif kind == "turn-started":
            STORE.update(db, thread_id, turn_running=1)
        elif kind == "turn-ended":
            STORE.update(db, thread_id, turn_running=0, last_turn_end_at=clock_now())
        elif kind in ("ready", "failed"):
            if row["state"] != "booting":
                return {"result": "ignored", "reason": f"thread is {row['state']}"}
            reaction = {"bot_id": load_registry(project_root)["projects"][row["project"]]["bot_id"],
                        "channel_id": str(event.get("trigger_channel_id") or thread_id),
                        "message_id": str(event.get("trigger_message_id") or ""),
                        "emoji": BOOTING_EMOJI}
            if kind == "failed":
                return boot_failed(project_root, state_dir, db, thread_id, reaction,
                                   str(event.get("reason") or "the Codex conversation failed to start."))
            with BootLock(state_dir):
                STORE.update(db, thread_id, state="live", stop_reason=None)
            discord_request(project_root, "unreact", reaction)
        else:
            raise ValueError(f"unknown host event: {kind}")
        return {"result": "recorded", "event": kind}
    finally:
        db.close()


def boot(project_root: Path, state_dir: Path, thread_id: str) -> dict:
    """Start a thread's session: a Claude thread session, launched and handed its
    bootstrap here, or a Codex conversation on the project's thread host."""
    started = clock_now()
    db = STORE.connect(state_dir)
    row = STORE.thread(db, thread_id) if db else None
    if not row or row["state"] != "booting":
        return {"status": "blocked", "reason": f"thread {thread_id} is not booting"}
    registry = load_registry(project_root)
    bot_id = registry["projects"][row["project"]]["bot_id"]
    with BootLock(state_dir):
        trigger = json.loads(buffer_path(state_dir, thread_id).read_text(encoding="utf-8"))[0]
    # A `/thread` first message is the command itself, in the parent channel.
    reaction = {"bot_id": bot_id, "channel_id": trigger.get("channel_id") or thread_id, "message_id": trigger["id"],
                "emoji": BOOTING_EMOJI}
    discord_request(project_root, "react", reaction)
    if thread_provider(registry, row) == "codex":
        return codex_boot(project_root, state_dir, db, row, registry, reaction, started)
    overrides = claude_overrides(row)

    def fail(reason: str) -> dict:
        result = boot_failed(project_root, state_dir, db, thread_id, reaction, reason)
        db.close()
        return result

    try:
        resolved = LAUNCH.resolve(str(project_root / "registry.json"), row["project"], thread_id, overrides)
    except SystemExit as error:
        return fail(str(error))
    # A thread with a stored conversation resumes it under the same Claude
    # home and cwd; an account change starts fresh.
    home = str(resolved["claude_home"] or Path.home() / ".claude")
    resume = row["provider_conversation_id"] if row["provider_home"] == home else None
    launched = subprocess.run([str(Path(__file__).with_name("start-thread-session.sh")), row["project"], thread_id,
                               *([resume] if resume else []),
                               *(argument for field, value in overrides.items() for argument in (f"--{field}", value))],
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
    if row["starter_message_id"] and not resume:
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
                     provider_home=home,
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
                                            "archive", "delete", "boot", "host-event", "command",
                                            "grant-thread-permissions"))
    parser.add_argument("--project-root", type=Path, default=Path(__file__).resolve().parent.parent)
    parser.add_argument("--state-dir", type=Path, default=None)
    parser.add_argument("--payload", help="internal: the observer's or Codex thread host's thread event as JSON")
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
        elif args.command in ("message", "archive", "delete", "host-event", "command"):
            if not args.payload:
                raise ValueError("--payload is required")
            handler = {"message": message, "archive": archive, "delete": delete, "host-event": host_event,
                       "command": channel_command}[args.command]
            result = handler(args.project_root, state_dir, json.loads(args.payload))
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
