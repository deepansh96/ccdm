"""Start and boot handoff: from a thread's first eligible message to a live session.

An owner or guest message in a registered or stopped thread, or an owner
message in a closed one, gets 👀, sets the row `booting`, and launches
start-thread-session.sh; a thread with a provider conversation resumes it
with `--resume`.
Every owner or guest message the Router hands the supervisor while the thread
boots is buffered. On `thread_session_live` the bootstrap, holding the
preamble, the starter and those messages, is written atomically for the
session's channel server, 👀 comes off, and the row is `live`. A launch that
fails, times out or exits early takes 👀 off, posts a one-line reason, and
leaves the row `stopped/start-failed`; the next eligible message retries.
A Codex thread is first given its own app-server port, recorded on the row.
A thread created with a first message starts at once, with no trigger
message (so no 👀) and that message as its starter. Every start is admitted
through its provider's session cap first; a queued thread buffers its
messages until the queue starts it.
"""

from __future__ import annotations

from dataclasses import dataclass
import itertools
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import threading

from . import capacity, ports, registry, store
from .clock import now
from .link import LinkError
from .paths import router_state_dir, write_private


EYES = "👀"
DRIVERS = ("owner", "guest")
# Thread commands are the supervisor's or the session's, never a boot trigger.
COMMAND = re.compile(r"^/(?:close|config|restart|clear|compact|pause|unpause)(?:\s|$)")
DEFAULT_BOOT_TIMEOUT_SECONDS = 120
LAUNCHER = Path(__file__).resolve().parent.parent / "start-thread-session.sh"
NOTICE_LIMIT = 300
_boot_ids = itertools.count(1)


@dataclass
class Boot:
    """One launch attempt, kept in memory from start until its launcher exits."""
    id: int
    project: str
    # None for a start a creation request's first message admitted.
    trigger_message_id: str | None
    starter: str
    live: bool = False
    launched: bool = False
    # A `thread_command` that arrived while the launcher ran, replayed when it exits.
    deferred: dict | None = None


def boot_timeout_seconds() -> float:
    value = os.environ.get("CCDM_THREAD_BOOT_TIMEOUT_S")
    try:
        seconds = float(value) if value else DEFAULT_BOOT_TIMEOUT_SECONDS
    except ValueError:
        seconds = DEFAULT_BOOT_TIMEOUT_SECONDS
    return seconds if seconds > 0 else DEFAULT_BOOT_TIMEOUT_SECONDS


def bootstrap_path(project: str, thread_id: str) -> Path:
    return router_state_dir() / "launches" / project / "threads" / thread_id / "bootstrap.json"


def _log(message: str) -> None:
    print(f"thread-supervisor: {message}", file=sys.stderr, flush=True)


def _addresses_root(context, content: str) -> bool:
    return bool(context.bot_user_id) and re.search(rf"<@!?{re.escape(context.bot_user_id)}>", content) is not None


def _react(context, thread_id: str, message_id: str | None, remove: bool = False) -> None:
    if message_id is None:
        return
    try:
        context.link.call("thread_react", {"channel_id": thread_id, "message_id": message_id, "emoji": EYES,
                                           **({"remove": True} if remove else {})})
    except LinkError as error:
        _log(f"thread {thread_id}: {'removing' if remove else 'adding'} {EYES} failed: {error.code}")


def _starter(context, row, parent_channel_id: str | None) -> str:
    """A thread started from a message has that message's id; read it from the parent."""
    if not parent_channel_id:
        return ""
    try:
        message = context.link.call("thread_message_get", {"channel_id": parent_channel_id,
                                                           "message_id": row["thread_id"]})
    except LinkError as error:
        if error.code != "not_found":
            _log(f"thread {row['thread_id']}: the starter message could not be read: {error.code}")
        return ""
    store.update(context.db, row["thread_id"], starter_message_id=row["thread_id"])
    return str((message or {}).get("content") or "")


def _payload(event: dict) -> str:
    author = event.get("author") or {}
    return json.dumps({
        "message_id": event.get("message_id"), "author": {"id": author.get("id"), "name": author.get("name")},
        "content": str(event.get("content") or ""), "attachments": event.get("attachments") or [],
        "ts": event.get("ts"),
    })


def _note_owner_activity(context, thread_id: str, event: dict) -> None:
    """Only the owner's messages keep a session from idling."""
    if event.get("author_class") != "owner":
        return
    row = store.thread(context.db, thread_id)
    if row and row["project"] == event.get("project"):
        store.update(context.db, thread_id, last_owner_activity_at=now())


def on_thread_message(context, event: dict) -> None:
    thread_id = event.get("thread_id")
    if not isinstance(thread_id, str) or event.get("author_class") not in DRIVERS:
        return
    if event.get("delivered_to_session"):
        return _note_owner_activity(context, thread_id, event)
    content = str(event.get("content") or "").strip()
    if COMMAND.match(content) or _addresses_root(context, content) or not isinstance(event.get("message_id"), str):
        return
    row = store.thread(context.db, thread_id)
    if not row or row["project"] != event.get("project"):
        return
    _note_owner_activity(context, thread_id, event)
    if row["state"] in ("booting", "queued"):
        store.buffer_message(context.db, thread_id, event["message_id"], _payload(event), now())
    elif row["state"] in ("registered", "stopped") or (row["state"] == "closed" and event["author_class"] == "owner"):
        # Only the owner reopens a closed conversation.
        start(context, row, event)


def start(context, row, trigger: dict | None, starter: str | None = None) -> None:
    """Launch a thread's session for its ``trigger`` message, or with no
    trigger when a creation request's first message is the ``starter``."""
    thread_id, project = row["thread_id"], row["project"]
    current = registry.load(context.project_root)
    entry = registry.project(current, project)
    if not entry:
        return
    resolved = registry.resolved_settings(entry, row)
    codex = resolved["provider"] == "codex"
    if not capacity.admit(context, row, resolved, trigger, starter):
        if trigger:
            store.buffer_message(context.db, thread_id, trigger["message_id"], _payload(trigger), now())
        return
    store.begin_boot(context.db, thread_id, resolved)
    trigger_id = trigger["message_id"] if trigger else None
    if trigger:
        store.buffer_message(context.db, thread_id, trigger_id, _payload(trigger), now())
    _react(context, thread_id, trigger_id)
    if starter is None:
        starter = _starter(context, row, trigger.get("parent_channel_id") if trigger else None)
    boot = Boot(next(_boot_ids), project, trigger_id, starter)
    context.boots[thread_id] = boot
    args = [str(LAUNCHER), project, thread_id, "--provider", resolved["provider"]]
    for field in ("account", "model", "effort"):
        if resolved[field]:
            args += [f"--{field}", resolved[field]]
    if row["provider_conversation_id"]:
        args += ["--resume", row["provider_conversation_id"]]
    env = {**os.environ, "CCDM_THREAD_BOOTSTRAP_FILE": str(bootstrap_path(project, thread_id)),
           "CCDM_THREAD_BOOT_TIMEOUT_S": f"{boot_timeout_seconds():g}"}
    if codex:
        port = ports.allocate(current, store.held_ports(context.db, thread_id))
        if port is None:
            return fail(context, thread_id, boot, f"no free Codex app-server port from {ports.base()}")
        store.update(context.db, thread_id, ws_port=port)
        env["CCDM_THREAD_WS_PORT"] = str(port)

    def launch() -> None:
        try:
            completed = subprocess.run(args, env=env, cwd=context.project_root, capture_output=True, text=True,
                                       stdin=subprocess.DEVNULL)
            result = {"returncode": completed.returncode, "stdout": completed.stdout, "stderr": completed.stderr}
        except OSError as error:
            result = {"returncode": 127, "stdout": "", "stderr": f"the thread launcher could not run: {error}"}
        context.link.post({"type": "internal", "event": "launch_exit", "thread_id": thread_id, "boot_id": boot.id,
                           **result})

    threading.Thread(target=launch, daemon=True).start()


def on_session_live(context, event: dict) -> None:
    thread_id = event.get("thread_id")
    if not isinstance(thread_id, str):
        return
    boot = context.boots.get(thread_id)
    row = store.thread(context.db, thread_id)
    if boot is None or not row or row["state"] != "booting":
        return
    messages = [json.loads(buffered["payload"]) for buffered in store.buffered(context.db, thread_id)]
    bootstrap = {
        "preamble": (f'You are the CCDM agent for project "{row["project"]}", serving the Discord thread '
                     f'"{row["name"]}" (thread {thread_id}). This thread is its own conversation: reply only in this '
                     f"thread, passing chat_id {thread_id}."),
        "starter": boot.starter,
        "messages": messages,
        "included_message_ids": [message["message_id"] for message in messages],
    }
    try:
        write_private(bootstrap_path(row["project"], thread_id), json.dumps(bootstrap) + "\n")
    except OSError as error:
        return fail(context, thread_id, boot, f"the bootstrap could not be written: {error.strerror or error}")
    store.finish_boot(context.db, thread_id, "live")
    boot.live = True
    if boot.launched:
        context.boots.pop(thread_id, None)
    _react(context, thread_id, boot.trigger_message_id, remove=True)


def on_launch_exit(context, frame: dict) -> None:
    thread_id = frame.get("thread_id")
    boot = context.boots.get(thread_id)
    if not boot or boot.id != frame.get("boot_id"):
        return
    try:
        _launch_exited(context, thread_id, boot, frame)
    finally:
        if boot.deferred:
            context.link.post(boot.deferred)


def _launch_exited(context, thread_id: str, boot: Boot, frame: dict) -> None:
    if frame.get("returncode") != 0:
        lines = [line.strip() for line in str(frame.get("stderr") or "").splitlines() if line.strip()]
        return fail(context, thread_id, boot, lines[-1] if lines else f"the launcher exited {frame.get('returncode')}")
    try:
        result = json.loads(str(frame.get("stdout") or "").strip().splitlines()[-1])
    except (IndexError, json.JSONDecodeError):
        result = {}
    store.update(context.db, thread_id, runtime_pid=result.get("pid"), runtime_tmux=result.get("tmux"),
                 provider_conversation_id=result.get("provider_conversation_id"),
                 provider_home=result.get("provider_home"))
    boot.launched = True
    if boot.live:
        context.boots.pop(thread_id, None)


def fail(context, thread_id: str, boot: Boot, reason: str) -> None:
    context.boots.pop(thread_id, None)
    store.finish_boot(context.db, thread_id, "stopped", "start-failed")
    _react(context, thread_id, boot.trigger_message_id, remove=True)
    line = " ".join(reason.split())
    if len(line) > NOTICE_LIMIT:
        line = line[:NOTICE_LIMIT - 1] + "…"
    try:
        context.link.call("thread_notice", {"channel_id": thread_id,
                                            "text": f"Thread session failed to start: {line}"})
    except LinkError as error:
        _log(f"thread {thread_id}: the start-failure notice failed: {error.code}")
