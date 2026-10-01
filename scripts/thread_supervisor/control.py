"""The private control socket, `<state>/control.sock` (0600), that serves `threads.sh`.

One JSON request line in, one JSON response line out:
`{"op": "create", "project", "name", "flags": {...}, "first_message"}` gets
`{"ok": true, "result": {...}}` or `{"ok": false, "error": {"code", "message"}}`,
where code `invalid` means the request created nothing.
`{"op": "stop_threads", "project"}` stops each of the project's booting, live
and queued thread sessions as `stopped/operator`, and answers
`{"ok": true, "result": {"stopped": [thread ids]}}`. `{"op": "list", "project"}`
answers `{"ok": true, "result": {"threads": [...]}}`, each with its provider
and model, state, stop or close reason and idle seconds; `project` may be
null for every project. `{"op": "stop_thread", "thread_id"}` stops one
thread's session as `stopped/operator`, and `restart_thread` and
`close_thread` run its `/restart` and `/close` as the owner, answering
`{"ok": true, "result": {"thread_id", "project", "name", ...}}`. The server thread
hands each request to the worker loop as an internal `control` frame, so the
store and the Router link are only ever used from that loop.
"""

from __future__ import annotations

from contextlib import contextmanager
import json
import os
from pathlib import Path
import queue
import socket
import threading

from . import boot, capacity, commands, creation, lifecycle, registry, store


SOCKET_NAME = "control.sock"
REPLY_TIMEOUT_SECONDS = 60
LINE_LIMIT = 65536


def socket_path(state_dir: Path) -> Path:
    return state_dir / SOCKET_NAME


@contextmanager
def _in_directory(path: Path):
    """Unix socket paths are limited to about 100 bytes, so bind and connect by
    the socket's name from inside the state dir."""
    previous = os.getcwd()
    os.chdir(path)
    try:
        yield
    finally:
        os.chdir(previous)


def _read_line(connection: socket.socket) -> str:
    data = b""
    while b"\n" not in data and len(data) < LINE_LIMIT:
        chunk = connection.recv(4096)
        if not chunk:
            break
        data += chunk
    return data.split(b"\n", 1)[0].decode("utf-8")


def _send(connection: socket.socket, response: dict) -> None:
    try:
        connection.sendall((json.dumps(response) + "\n").encode("utf-8"))
    except OSError:
        pass


def _error(code: str, message: str) -> dict:
    return {"ok": False, "error": {"code": code, "message": message}}


class ControlServer:
    def __init__(self, state_dir: Path, post):
        self.path = socket_path(state_dir)
        # The worker lock is held, so any socket already here is stale.
        self.path.unlink(missing_ok=True)
        self.post = post
        self.socket = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        umask = os.umask(0o177)
        try:
            with _in_directory(state_dir):
                self.socket.bind(SOCKET_NAME)
        finally:
            os.umask(umask)
        os.chmod(self.path, 0o600)
        self.socket.listen(8)
        threading.Thread(target=self._serve, daemon=True).start()

    def _serve(self) -> None:
        while True:
            try:
                connection, _ = self.socket.accept()
            except OSError:
                return
            threading.Thread(target=self._answer, args=(connection,), daemon=True).start()

    def _answer(self, connection: socket.socket) -> None:
        with connection:
            connection.settimeout(REPLY_TIMEOUT_SECONDS)
            try:
                request = json.loads(_read_line(connection))
            except (OSError, UnicodeDecodeError, json.JSONDecodeError):
                request = None
            if not isinstance(request, dict):
                return _send(connection, _error("invalid", "the request is not a JSON object"))
            replies: queue.Queue = queue.Queue(maxsize=1)
            self.post({"type": "internal", "event": "control", "request": request, "reply": replies.put})
            try:
                response = replies.get(timeout=REPLY_TIMEOUT_SECONDS)
            except queue.Empty:
                response = _error("timeout", "the thread supervisor did not answer in time")
            _send(connection, response)

    def close(self) -> None:
        self.socket.close()
        self.path.unlink(missing_ok=True)


def stop_threads(context, project) -> dict:
    """Operator stops: the project's running and queued thread sessions, never
    restarted on their own. A thread whose launcher still runs is stopped once
    it exits, as a single `stop_thread` is."""
    if not isinstance(project, str) or not project:
        return _error("invalid", "stop_threads needs a project")
    stopped = []
    rows = context.db.execute("SELECT * FROM threads WHERE project=? AND state IN ('booting', 'live', 'queued')",
                              (project,)).fetchall()
    for row in rows:
        launching = context.boots.get(row["thread_id"])
        if launching and not launching.launched:
            launching.deferred_stops.append({"type": "internal", "event": "control", "reply": lambda _response: None,
                                             "request": {"op": "stop_thread", "thread_id": row["thread_id"]}})
        else:
            _operator_stop(context, row)
        stopped.append(row["thread_id"])
    return {"ok": True, "result": {"stopped": stopped}}


def _operator_stop(context, row) -> None:
    context.archive_polls.pop(row["thread_id"], None)
    lifecycle.stop_session(context, row)
    store.finish_boot(context.db, row["thread_id"], "stopped", "operator")


def list_threads(context, project) -> dict:
    """Every bound thread, or ``project``'s: what it runs with (or would), its state and how long it has idled."""
    current = registry.load(context.project_root)
    if project is not None and not registry.project(current, project):
        return _error("invalid", f"unknown project {project!r}")
    threads = []
    for row in context.db.execute("SELECT * FROM threads ORDER BY project, created_at, thread_id"):
        if project is not None and row["project"] != project:
            continue
        settings = registry.resolved_settings(registry.project(current, row["project"]) or {}, row)
        running = row["state"] in ("booting", "live", "queued")
        last = max(stamp for stamp in (row["created_at"], row["last_owner_activity_at"], row["last_agent_reply_at"])
                   if stamp)
        threads.append({
            "project": row["project"], "name": row["name"], "thread_id": row["thread_id"],
            "provider": (row["resolved_provider"] if running else None) or settings["provider"],
            "model": (row["resolved_model"] if running else None) or settings["model"],
            "state": row["state"], "reason": row["stop_reason"] or row["close_reason"],
            "idle_seconds": max(0, int(capacity.age_seconds(last))),
        })
    return {"ok": True, "result": {"threads": threads}}


def _summary(context, thread_id: str, **extra) -> dict:
    row = store.thread(context.db, thread_id)
    return {"ok": True, "result": {"thread_id": thread_id, "project": row["project"], "name": row["name"],
                                   "state": row["state"], **extra}}


def stop_thread(context, row) -> dict:
    """An operator stop of one thread's running or queued session; any other thread is left as it is."""
    running = row["state"] in ("booting", "live", "queued")
    if running:
        _operator_stop(context, row)
    return _summary(context, row["thread_id"], stopped=running)


def _as_owner(command: str):
    """The thread's in-thread command, as the owner sends it; a launch still
    running defers it as it would the message."""
    def run(context, row) -> dict:
        commands.on_thread_command(context, {"type": "event", "event": "thread_command", "command": command,
                                             "thread_id": row["thread_id"], "project": row["project"],
                                             "author": {"is_owner": True}, "message_id": None})
        return _summary(context, row["thread_id"])
    return run


THREAD_OPS = {"stop_thread": stop_thread, "restart_thread": _as_owner("restart"), "close_thread": _as_owner("close")}


def handle(context, request: dict) -> dict:
    op = request.get("op")
    if op == "stop_threads":
        return stop_threads(context, request.get("project"))
    if op == "list":
        return list_threads(context, request.get("project"))
    if op in THREAD_OPS:
        thread_id = request.get("thread_id")
        row = store.thread(context.db, thread_id) if isinstance(thread_id, str) else None
        if not row:
            return _error("invalid", f"no bound thread {thread_id!r}")
        return THREAD_OPS[op](context, row)
    if op != "create":
        return _error("invalid", f"unknown op {op!r}")
    flags = request.get("flags") if isinstance(request.get("flags"), dict) else {}
    try:
        result = creation.create(context, request.get("project"), request.get("name"), flags,
                                 request.get("first_message"), "root", "root")
    except creation.Invalid as error:
        return _error("invalid", str(error))
    except creation.Failed as error:
        return _error("failed", str(error))
    return {"ok": True, "result": result}


def on_control(context, frame: dict) -> None:
    """The worker loop's side: answer one control request, always. A
    `stop_thread` that arrives while the thread's launcher still runs waits
    for it to exit, as an in-thread command does, so the stop finds the
    session's tmux."""
    request = frame.get("request") or {}
    thread_id = request.get("thread_id") if request.get("op") == "stop_thread" else None
    launching = context.boots.get(thread_id) if isinstance(thread_id, str) else None
    if launching and not launching.launched:
        launching.deferred_stops.append(frame)
        return
    try:
        response = handle(context, request)
    except Exception as error:  # The client must hear back, whatever failed.
        response = _error("failed", str(error))
    frame["reply"](response)


def request(state_dir: Path, payload: dict) -> dict:
    """The client's side: one request to a running worker. Raises OSError when
    no worker serves the socket, ValueError on a malformed answer."""
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
        client.settimeout(REPLY_TIMEOUT_SECONDS + 5)
        with _in_directory(state_dir):
            client.connect(SOCKET_NAME)
        client.sendall((json.dumps(payload) + "\n").encode("utf-8"))
        response = json.loads(_read_line(client))
    if not isinstance(response, dict):
        raise ValueError("the thread supervisor's answer is not a JSON object")
    return response
