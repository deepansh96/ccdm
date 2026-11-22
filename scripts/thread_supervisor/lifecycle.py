"""Archive, unarchive and delete: the Thread Conversation lifecycle.

A thread stays unarchived until `/close`. An archive (`thread_update` with
archived false→true) of an open thread that the `/close` flow did not make
(Discord's inactivity auto-archive, or anyone archiving it by hand) is
reverted at once through `thread_update`, and a live session that is not
mid-turn stops as `stopped/auto-archive`; the next owner or guest message
resumes it. A booting or mid-turn session keeps running, and the row never
closes. Who archived it is logged from one audit-log read, when root has the
optional View Audit Log. An unarchive never starts a session. A delete stops
the session and drops the row and its boot buffers; the provider's
conversation files stay on disk.
"""

from __future__ import annotations

import os
from pathlib import Path
import re
import shlex
import signal
import subprocess
import sys
import time

from ccdmlib.platform import atomic, proc, session_host

from . import registry, reminders, store
from .link import LinkError
from .paths import router_state_dir


# An audit entry is stamped when Discord archived the thread, a little before
# the event reaches the supervisor.
ARCHIVE_LOOKBACK_MS = 30000
STOP_GRACE_SECONDS = 3
# Windows: how long the session host waits for a session to end by itself, how
# long ended processes get to disappear, and what a session's processes can be.
HOST_STOP_GRACE_MS = 3000
SWEEP_WAIT_SECONDS = 2.0
KEY_REMOVE_BUDGET_MS = 2000
KEY_FILE_FLAG = "--ccdm-key-file"
LISTENER_PROGRAMS = frozenset(("claude", "node", "bun", "codex"))
LOWEST_USER_PID = 5
# The audit-log read only names an actor in the log: it never holds the worker long.
LOG_READ_TIMEOUT_SECONDS = 5
KEY_ENV = re.compile(r"""CCDM_ROUTER_KEY_FILE=(?:"([^"]+)"|'([^']+)'|([^\s]+))""")


def _log(message: str) -> None:
    print(f"thread-supervisor: {message}", file=sys.stderr, flush=True)


def key_path(thread_id: str) -> Path:
    return router_state_dir() / "keys" / f".thread-{thread_id}.key"


def _is_listener(command: str) -> bool:
    try:
        argv = shlex.split(command)
    except ValueError:
        return False
    if not argv:
        return False
    exe = os.path.basename(argv[0])
    if exe == "claude":
        return "--dangerously-load-development-channels" in argv and "server:ccdm" in argv
    if exe == "codex":
        return "app-server" in argv
    if exe == "agy":
        return "acp" in argv
    return exe == "node" and any(os.path.basename(arg) in ("ccdm-channel-server.js", "codex-bridge.js", "gemini-bridge.js")
                                 for arg in argv[1:])


def _listener_pids(key_file: Path) -> list[int]:
    """The thread's listener processes on macOS and Linux: those whose environment carries exactly its key path."""
    if proc.WIN32:
        return []  # Another process's environment cannot be read there: see `_windows_listeners`.
    target = os.path.normpath(str(key_file))
    try:
        ps = subprocess.check_output(["ps", "axeww", "-o", "pid=,command="], text=True, stderr=subprocess.DEVNULL)
    except (OSError, subprocess.CalledProcessError):
        return []
    pids = []
    for line in ps.splitlines():
        pid_text, _, command = line.strip().partition(" ")
        if not pid_text.isdigit() or int(pid_text) == os.getpid():
            continue
        keys = [next(group for group in match.groups() if group is not None) for match in KEY_ENV.finditer(command)]
        if any(os.path.normpath(key) == target for key in keys) and _is_listener(command):
            pids.append(int(pid_text))
    return pids


def _same_path(value: str) -> str:
    return os.path.normcase(os.path.normpath(value))


def _thread_matcher(thread_id: str):
    """Whether a Windows process is the thread's, by its arguments alone: the
    pair `--ccdm-key-file <the thread's key>`, or, for a program a session runs,
    a file in the thread's launch directory `launches/<project>/threads/<thread id>/`."""
    key = _same_path(str(key_path(thread_id)))
    launches = _same_path(str(router_state_dir() / "launches")) + os.sep

    def in_launch_dir(value: str) -> bool:
        path = _same_path(value)
        if not path.startswith(launches):
            return False
        parts = path[len(launches):].split(os.sep)
        return len(parts) > 3 and parts[1] == "threads" and parts[2] == thread_id

    def matches(name: str, argv) -> bool:
        if any(flag == KEY_FILE_FLAG and _same_path(value) == key for flag, value in zip(argv, argv[1:])):
            return True
        program = name.lower()
        if (program[:-4] if program.endswith(".exe") else program) not in LISTENER_PROGRAMS:
            return False
        return any(in_launch_dir(arg.split("=", 1)[1] if arg.startswith("-") and "=" in arg else arg)
                   for arg in argv[1:])

    return matches


def _verified_command_line(pid: int):
    """A process's start time and arguments, read so that both are the same process's."""
    started = proc.start_time(pid)
    if started is None:
        return None, ()
    try:
        argv = proc.command_line(pid)
    except OSError:
        return None, ()
    if argv is None or proc.start_time(pid) != started:
        return None, ()
    return started, argv


def _windows_listeners(thread_id: str) -> list[tuple[int, str]]:
    """The thread's processes on Windows, each as (pid, start time)."""
    matches = _thread_matcher(thread_id)
    own = os.getpid()
    try:
        table = proc.find(lambda process: process.pid >= LOWEST_USER_PID and process.pid != own)
    except OSError as error:
        _log(f"thread {thread_id}: the process table could not be read: {error}")
        return []
    found = []
    for process in table:
        started, argv = _verified_command_line(process.pid)
        if started and matches(process.name, argv):
            found.append((process.pid, started))
    return found


def session_running(thread_id: str) -> bool:
    if proc.WIN32:
        return bool(_windows_listeners(thread_id))
    return bool(_listener_pids(key_path(thread_id)))


def session_name(project_root, project: str, thread_id: str) -> str | None:
    """`<screen>-t-<thread id>`, the name every launch gives the thread's session."""
    try:
        entry = registry.project(registry.load(project_root), project) or {}
    except (OSError, ValueError):
        return None
    screen = entry.get("screen_name")
    return f"{screen}-t-{thread_id}" if isinstance(screen, str) and screen else None


def stop_session(context, row, failed: bool = False) -> None:
    """Stop a thread's session by its `.thread-<id>.key` path, never by name
    patterns a project or sibling session could match; then its own
    session and key go. A turn that already ended still gets its mark;
    otherwise the ⏳ goes, or becomes ⚠️ when ``failed`` (a crash)."""
    from . import boot, turns  # Both import modules that import this one.

    thread_id = row["thread_id"]
    turns.on_stop(context, row, failed)
    boot.drop(context, thread_id)
    names = [row["runtime_tmux"]]
    if proc.WIN32:  # A launch that never reported back still has its session in the host.
        names.append(session_name(context.project_root, row["project"], thread_id))
    end_session(thread_id, names, row["resolved_provider"] or row["provider"])
    store.update(context.db, thread_id, runtime_pid=None, runtime_tmux=None)


def end_session(thread_id: str, names, provider: str | None = None) -> None:
    """The thread's listeners, its sessions called ``names`` and its key go.

    macOS and Linux signal the listeners, then end the tmux session. Windows
    has no signal to send: the session host ends the session with everything
    it started, then any process still carrying the thread's key file is ended."""
    names = [name for name in dict.fromkeys(names) if name]
    if proc.WIN32:
        # Only a Codex bridge is known to stop by itself once the host closes its input.
        grace_ms = 0 if provider == "claude" else HOST_STOP_GRACE_MS
        for name in names:
            if not _stop_host_session(thread_id, name, grace_ms):
                break
        _end_windows_listeners(thread_id)
        _remove_key(thread_id)
        return
    kill_listeners(key_path(thread_id))
    for name in names:
        _stop_host_session(thread_id, name, None)
    key_path(thread_id).unlink(missing_ok=True)


def _stop_host_session(thread_id: str, name: str, grace_ms: int | None) -> bool:
    """Whether the session host was there to ask."""
    try:
        session_host.stop(name, grace_ms)
    except session_host.SessionHostError as error:
        _log(f"thread {thread_id}: its session could not be stopped: {error}")
        return error.code != "not_running"
    return True


def _end_windows_listeners(thread_id: str) -> None:
    """End what the session host did not. Each process is matched by its
    arguments, and ended only while its start time is the one read with them."""
    deadline = time.monotonic() + SWEEP_WAIT_SECONDS
    while True:
        remaining = _windows_listeners(thread_id)
        if not remaining:
            return
        if time.monotonic() >= deadline:
            pids = " ".join(str(pid) for pid, _ in remaining)
            return _log(f"thread {thread_id}: process(es) still carry its key file after the stop: {pids}; "
                        f"its next boot is refused until they end (retry: threads stop {thread_id})")
        for pid, started in remaining:
            proc.kill_tree(pid, 0.0, started_at=started)
        time.sleep(0.1)


def _remove_key(thread_id: str) -> None:
    try:  # A process that has just ended can hold the file a moment longer.
        atomic.remove_tree_with_retry(key_path(thread_id), KEY_REMOVE_BUDGET_MS)
    except OSError as error:
        _log(f"thread {thread_id}: its key could not be removed: {error}")


def kill_listeners(key_file: Path) -> None:
    """macOS and Linux: SIGTERM the listeners carrying ``key_file``, then SIGKILL any still running after the grace period."""
    if proc.WIN32:
        return  # No signals there: `end_session` goes through the session host.
    pids = _listener_pids(key_file)
    for pid in pids:
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
    deadline = time.monotonic() + STOP_GRACE_SECONDS
    while pids and time.monotonic() < deadline:
        time.sleep(0.1)
        pids = [pid for pid in pids if pid in _listener_pids(key_file)]
    for pid in pids:
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass


def on_thread_update(context, event: dict) -> None:
    thread_id = event.get("thread_id")
    before, after = event.get("before") or {}, event.get("after") or {}
    if not isinstance(thread_id, str) or before.get("archived") or not after.get("archived"):
        return  # Only an archive matters; an unarchive never starts a session.
    row = store.thread(context.db, thread_id)
    if not row or row["project"] != event.get("project"):
        return
    if row["state"] == "closed":
        return  # The archive `/close` (or `threads.sh close`) made.
    if row["pending_close"]:
        # A close interrupted after it recorded itself (`/close` runs to the
        # end within one event, so only a crash leaves this): finish it.
        return finish_close(context, row)
    since_ms = event.get("since_ms")
    reopen(context, row, since_ms if isinstance(since_ms, int) else int(time.time() * 1000) - ARCHIVE_LOOKBACK_MS)


def reopen(context, row, since_ms: int) -> None:
    """Revert an archive the `/close` flow did not make: unarchive the thread
    at once, and stop its session if it is idle."""
    thread_id = row["thread_id"]
    try:
        context.link.call("thread_update", {"thread_id": thread_id, "archived": False})
    except LinkError as error:
        _log(f"thread {thread_id}: reverting its archive failed: {error.code}")
    _log(f"thread {thread_id}: reverted an archive by {_archive_actor(context, thread_id, since_ms)}")
    stop_if_idle(context, store.thread(context.db, thread_id))


def stop_if_idle(context, row) -> None:
    """Stop a live session that is not mid-turn as `stopped/auto-archive`; the
    next owner or guest message resumes it. A booting session, one mid-turn,
    or a paused one (whose held messages would be lost) keeps running."""
    from . import capacity  # capacity imports this module.

    if (not row or row["state"] != "live" or row["thread_id"] in context.boots or capacity.turn_running(row)
            or capacity.paused(row)):
        return
    stop_session(context, row)
    store.finish_boot(context.db, row["thread_id"], "stopped", "auto-archive")


def finish_close(context, row) -> None:
    """The end of `/close` and `threads.sh close` once the thread is archived:
    the session stops, the row closes as `close-command`, and the reminder
    service hears `conversation_closed`. Reconcile and the archive handler
    also use it to finish a close a crash interrupted after `pending_close`."""
    thread_id = row["thread_id"]
    stop_session(context, store.thread(context.db, thread_id) or row)
    store.update(context.db, thread_id, state="closed", stop_reason=None, close_reason="close-command",
                 pending_close=None)
    reminders.emit(context, "conversation_closed", row)


def _archive_actor(context, thread_id: str, since_ms: int) -> str:
    """Who archived the thread, for the log only: one audit-log read, which
    needs the optional View Audit Log."""
    try:
        result = context.link.call("thread_archive_actor", {"thread_id": thread_id, "since": since_ms},
                                   timeout=LOG_READ_TIMEOUT_SECONDS) or {}
    except LinkError as error:
        return f"an unknown actor ({error.code})"
    if result.get("forbidden"):
        return "an unknown actor (no View Audit Log)"
    for entry in result.get("entries") or []:
        if not isinstance(entry, dict):
            continue
        changes = entry.get("changes") or []
        if any(isinstance(change, dict) and change.get("key") == "archived" and change.get("new_value") is True
               for change in changes):
            actor = str(entry.get("user_id") or "")
            try:
                owner = registry.owner_id(registry.load(context.project_root))
            except (OSError, ValueError):
                owner = None
            if actor and actor == owner:
                return "the owner"
            if actor and actor == context.bot_user_id:
                return "the root bot"
            return f"user {actor}" if actor else "an unknown actor"
    return "Discord (no audit entry yet: an auto-archive, or not yet logged)"


def on_thread_delete(context, event: dict) -> None:
    thread_id = event.get("thread_id")
    if not isinstance(thread_id, str):
        return
    row = store.thread(context.db, thread_id)
    if not row or row["project"] != event.get("project"):
        return
    from . import boot  # boot imports this module.

    if boot.defer(context, thread_id, event):  # Once the running launcher exits.
        return
    stop_session(context, row)
    store.forget(context.db, thread_id)
    reminders.emit(context, "conversation_deleted", row)
