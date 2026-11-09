"""The one API launchers use to run sessions; the twin of scripts/lib/session-host.js.

On macOS and Linux it issues tmux commands. On Windows it speaks ccdm-host's
protocol v1 over the pipe itself, so a call does not start Node.
``CCDM_SESSION_HOST=tmux|ccdm-host`` overrides the choice. Durations are
milliseconds. A failure is a :class:`SessionHostError` with ``.code``; with no
host running the code is ``not_running``.
"""

from __future__ import annotations

import json
import os
import queue
import re
import subprocess
import sys
import threading
import time
from typing import Any, BinaryIO, Dict, List, Mapping, Optional, Pattern, Sequence, Union

from . import ipc
from .paths import state_root

WIN32 = sys.platform == "win32"
KINDS = ("project", "thread", "root", "adhoc")
NOT_RUNNING_MESSAGE = "ccdm-host is not running; start it with `node scripts/ccdm-host.js serve`"
PROTOCOL_VERSION = 1

_SESSION_NAME_VARIABLE = "CCDM_SESSION_NAME"
_CONNECT_TIMEOUT_MS = 1500
_REQUEST_TIMEOUT_MS = 30000
# Time the host needs beyond a request's own wait, to empty a Job and answer.
_HOST_MARGIN_MS = 10000
_WAIT_POLL_S = 0.2

_UNKNOWN_SESSION = "unknown_session"
_SPAWN_FAILED = "spawn_failed"
_DUPLICATE_SESSION = "duplicate_session"
_NOT_AUTHENTICATED = "not_authenticated"

Regex = Union[str, "Pattern[str]"]


class SessionHostError(RuntimeError):
    """A session-host verb failed; ``code`` is the protocol error name."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def backend_name(env: Optional[Mapping[str, str]] = None) -> str:
    chosen = (os.environ if env is None else env).get("CCDM_SESSION_HOST")
    if not chosen:
        return "ccdm-host" if WIN32 else "tmux"
    if chosen not in ("tmux", "ccdm-host"):
        raise SessionHostError("bad_backend", f"CCDM_SESSION_HOST must be tmux or ccdm-host, not {chosen}")
    return chosen


def _without_session_name(env: Optional[Mapping[str, str]]) -> Dict[str, str]:
    return {key: value for key, value in (env or {}).items() if key.upper() != _SESSION_NAME_VARIABLE}


def _launch_request(
    name: str, argv: Sequence[str], cwd: str, env: Optional[Mapping[str, str]], pty: bool, kind: str
) -> Dict[str, Any]:
    if not isinstance(name, str) or not name or name.startswith("="):
        raise SessionHostError(_SPAWN_FAILED, "a session needs a name that does not start with =")
    if not argv or not all(isinstance(arg, str) for arg in argv):
        raise SessionHostError(_SPAWN_FAILED, "argv must be a non-empty list of strings")
    if not isinstance(cwd, str) or not cwd:
        raise SessionHostError(_SPAWN_FAILED, "a session needs a cwd")
    if kind not in KINDS:
        raise SessionHostError(_SPAWN_FAILED, f"unknown session kind: {kind}")
    session_env = _without_session_name(env)
    session_env[_SESSION_NAME_VARIABLE] = name
    return {"name": name, "argv": list(argv), "cwd": cwd, "env": session_env, "pty": bool(pty), "kind": kind}


# Multiline on both backends, because the host's own wait always is.
def _compiled(regex: Regex) -> "Pattern[str]":
    if isinstance(regex, str):
        return re.compile(regex, re.MULTILINE)
    return re.compile(regex.pattern, regex.flags | re.MULTILINE)


def _key_list(keys: Union[None, str, Sequence[str]]) -> List[str]:
    if keys is None:
        return []
    return [keys] if isinstance(keys, str) else list(keys)


# --- tmux ---------------------------------------------------------------


def _shell_quote(value: str) -> str:
    return "'" + str(value).replace("'", "'\\''") + "'"


# Today's launch strings quote every value but leave these two words bare.
_BARE_WORDS = frozenset(("server:ccdm", "scripts/codex-bridge.js"))
_BARE_PROGRAM = re.compile(r"^[A-Za-z0-9_./-]+$")
_BARE_FLAG = re.compile(r"^--?[A-Za-z0-9-]+$")
_ENV_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def _shell_word(arg: str, index: int) -> str:
    if index == 0:
        bare = bool(_BARE_PROGRAM.match(arg))
    else:
        bare = bool(_BARE_FLAG.match(arg)) or arg in _BARE_WORDS
    return arg if bare else _shell_quote(arg)


def tmux_launch_command(
    name: str, argv: Sequence[str], cwd: str, env: Optional[Mapping[str, str]] = None, kind: str = "adhoc"
) -> str:
    """The string ``zsh -ic`` runs, in today's launchers' exact form."""
    request = _launch_request(name, argv, cwd, env, True, kind)
    assignments = []
    for key, value in request["env"].items():
        if not _ENV_NAME.match(key):
            raise SessionHostError(_SPAWN_FAILED, f"not an environment variable name: {key}")
        assignments.append(f"{key}={_shell_quote(value)}")
    words = " ".join(_shell_word(arg, index) for index, arg in enumerate(request["argv"]))
    return f"cd {_shell_quote(request['cwd'])} && {' '.join(assignments)} {words}"


def _run_tool(tool: str, args: Sequence[str]) -> "subprocess.CompletedProcess[str]":
    try:
        return subprocess.run(
            [tool, *args], capture_output=True, text=True, encoding="utf-8", errors="replace"
        )
    except OSError as error:
        raise SessionHostError(_SPAWN_FAILED, f"{tool} could not run: {error}") from error


def _tmux(args: Sequence[str]) -> "subprocess.CompletedProcess[str]":
    return _run_tool("tmux", args)


def _exact_session(name: str) -> str:
    return f"={name}"


def _exact_pane(name: str) -> str:
    # A pane target needs the colon: without it tmux reads `=name` as a pane name.
    return f"={name}:"


def _no_such_session(name: str, result: "subprocess.CompletedProcess[str]") -> SessionHostError:
    return SessionHostError(_UNKNOWN_SESSION, result.stderr.strip() or f"no session named {name}")


def _tmux_send(name: str, keys: Sequence[str]) -> None:
    result = _tmux(["send-keys", "-t", _exact_pane(name), *keys])
    if result.returncode != 0:
        raise _no_such_session(name, result)


def _tmux_capture(name: str, history: Union[bool, int] = False, join: bool = False) -> str:
    args = ["capture-pane", "-t", _exact_pane(name), "-p"]
    if join:
        args.append("-J")
    if history is True:
        args.extend(["-S", "-"])
    elif history:
        args.extend(["-S", str(-abs(int(history)))])
    result = _tmux(args)
    if result.returncode != 0:
        raise _no_such_session(name, result)
    return result.stdout


def _tmux_is_live(name: str) -> bool:
    return _tmux(["has-session", "-t", _exact_session(name)]).returncode == 0


def _tmux_kill(name: str) -> bool:
    return _tmux(["kill-session", "-t", _exact_session(name)]).returncode == 0


def _tmux_pane_pid(name: str) -> Optional[int]:
    result = _tmux(["display-message", "-t", _exact_pane(name), "-p", "#{pane_pid}"])
    if result.returncode != 0:
        return None
    text = result.stdout.strip()
    return int(text) if text.isdigit() else None


def _tmux_stop(name: str, grace_ms: Optional[int]) -> Dict[str, bool]:
    if grace_ms is None:
        return {"stopped": _tmux_kill(name)}
    if not _tmux_is_live(name):
        return {"stopped": False}
    pane = _tmux_pane_pid(name)
    if pane:
        try:
            _run_tool("pkill", ["-TERM", "-P", str(pane)])
        except SessionHostError:
            pass
        time.sleep(grace_ms / 1000)
    _tmux_kill(name)
    # restart-root's waits were 1 s, 2 s and 1 s.
    time.sleep(min(2000, grace_ms * 2) / 1000)
    if _tmux_is_live(name):
        _tmux_kill(name)
        time.sleep(min(1000, grace_ms) / 1000)
    return {"stopped": True}


def _tmux_pids(name: str) -> List[int]:
    pane = _tmux_pane_pid(name)
    if not pane:
        return []
    children: Dict[int, List[int]] = {}
    for line in _run_tool("ps", ["-axo", "pid=,ppid="]).stdout.splitlines():
        fields = line.split()
        if len(fields) == 2 and fields[0].isdigit() and fields[1].isdigit():
            children.setdefault(int(fields[1]), []).append(int(fields[0]))
    found = [pane]
    for pid in found:
        for child in children.get(pid, []):
            if child not in found:
                found.append(child)
    return found


def _tmux_wait(name: str, pattern: "Pattern[str]", timeout_ms: int, then_send: List[str]) -> Dict[str, Any]:
    started = time.monotonic()
    while True:
        screen = _tmux_capture(name)
        elapsed_ms = int((time.monotonic() - started) * 1000)
        if pattern.search(screen):
            for key in then_send:
                _tmux_send(name, [key])
            return {"matched": True, "ms": elapsed_ms, "screen": screen}
        if elapsed_ms >= timeout_ms:
            return {"matched": False, "ms": elapsed_ms, "screen": screen}
        time.sleep(min(_WAIT_POLL_S, (timeout_ms - elapsed_ms) / 1000))


def _spawn_detached(
    argv: Sequence[str],
    cwd: Optional[str],
    env: Optional[Mapping[str, str]],
    log: Optional[str],
) -> Dict[str, int]:
    if WIN32:
        raise SessionHostError(_SPAWN_FAILED, "detached helpers on Windows go through ccdm-host")
    child_env = dict(os.environ)
    child_env.update(env or {})
    child_env.pop(_SESSION_NAME_VARIABLE, None)
    log_fd = None
    if log:
        os.makedirs(os.path.dirname(os.path.abspath(log)), exist_ok=True)
        log_fd = os.open(log, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    target = subprocess.DEVNULL if log_fd is None else log_fd
    try:
        child = subprocess.Popen(
            list(argv),
            cwd=cwd,
            env=child_env,
            stdin=subprocess.DEVNULL,
            stdout=target,
            stderr=target,
            start_new_session=True,
        )
    except OSError as error:
        raise SessionHostError(_SPAWN_FAILED, f"could not start {argv[0]}: {error}") from error
    finally:
        if log_fd is not None:
            os.close(log_fd)
    return {"pid": child.pid}


# --- ccdm-host ----------------------------------------------------------


def _not_running() -> SessionHostError:
    return SessionHostError("not_running", NOT_RUNNING_MESSAGE)


def _encode(frame: Mapping[str, Any]) -> bytes:
    return (json.dumps(frame, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")


class _Abandoned(SessionHostError):
    """No answer in time: a read is still blocked, so the stream must stay open."""


def _read_line(stream: BinaryIO, deadline: float) -> bytes:
    # Per read, never for the whole connection: a Windows pipe handle opened for
    # synchronous I/O runs one call at a time, so a blocked reader would hold up the next write.
    box: "queue.Queue[Any]" = queue.Queue(1)

    def reader() -> None:
        try:
            box.put(stream.readline())
        except (OSError, ValueError) as error:
            box.put(error)

    threading.Thread(target=reader, daemon=True).start()
    try:
        line = box.get(timeout=max(deadline - time.monotonic(), 0))
    except queue.Empty as error:
        raise _Abandoned("timeout", "ccdm-host did not answer in time") from error
    if isinstance(line, Exception):
        raise _not_running() from line
    return line


def _read_frame(stream: BinaryIO, deadline: float) -> Dict[str, Any]:
    line = _read_line(stream, deadline)
    if not line:
        raise _not_running()
    try:
        frame = json.loads(line.decode("utf-8"))
    except ValueError as error:
        raise SessionHostError(_NOT_AUTHENTICATED, "ccdm-host sent a malformed frame") from error
    if not isinstance(frame, dict):
        raise SessionHostError(_NOT_AUTHENTICATED, "ccdm-host sent a malformed frame")
    return frame


def _write_frame(stream: BinaryIO, frame: Mapping[str, Any]) -> None:
    try:
        stream.write(_encode(frame))
        stream.flush()
    except OSError as error:
        raise _not_running() from error


def _open_host() -> BinaryIO:
    directory = state_root() / "host"
    try:
        stream = ipc.connect("host", directory, timeout_ms=_CONNECT_TIMEOUT_MS)
    except ipc.ServerProofError as error:
        raise SessionHostError(_NOT_AUTHENTICATED, "the server on the ccdm-host pipe did not prove itself") from error
    except OSError as error:
        raise _not_running() from error
    try:
        token = (directory / "host.token").read_text(encoding="utf-8").strip()
        _write_frame(stream, {"op": "hello", "protocol_version": PROTOCOL_VERSION, "token": token})
        reply = _read_frame(stream, time.monotonic() + _CONNECT_TIMEOUT_MS / 1000)
    except _Abandoned:
        raise SessionHostError(_NOT_AUTHENTICATED, "the server on the ccdm-host pipe did not answer in time") from None
    except OSError as error:
        stream.close()
        raise _not_running() from error
    except SessionHostError:
        stream.close()
        raise
    if reply.get("ok") is not True:
        stream.close()
        raise SessionHostError(
            str(reply.get("error", _NOT_AUTHENTICATED)), str(reply.get("message", "ccdm-host refused the hello"))
        )
    return stream


def _call(op: str, args: Optional[Mapping[str, Any]] = None, timeout_ms: int = _REQUEST_TIMEOUT_MS) -> Dict[str, Any]:
    stream = _open_host()
    try:
        _write_frame(stream, {"id": 1, "op": op, **(args or {})})
        response = _read_frame(stream, time.monotonic() + timeout_ms / 1000)
    except _Abandoned:
        # A reader thread still holds the stream's lock; closing it would block.
        raise
    except BaseException:
        stream.close()
        raise
    stream.close()
    if response.get("ok") is not True:
        raise SessionHostError(str(response.get("error")), str(response.get("message")))
    return response


# --- the verbs ----------------------------------------------------------


def _is_tmux() -> bool:
    return backend_name() == "tmux"


def start(
    name: str,
    argv: Sequence[str],
    cwd: str,
    env: Optional[Mapping[str, str]] = None,
    pty: bool = True,
    kind: Optional[str] = None,
) -> Dict[str, Any]:
    request = _launch_request(name, argv, cwd, env, pty, str(kind))
    if _is_tmux():
        command = tmux_launch_command(name, argv, cwd, env, request["kind"])
        result = _tmux(["new-session", "-d", "-s", name, "--", "zsh", "-ic", command])
        if result.returncode != 0:
            code = _DUPLICATE_SESSION if "duplicate session" in result.stderr else _SPAWN_FAILED
            raise SessionHostError(code, result.stderr.strip() or f"tmux could not start session {name}")
        return {"pid": None, "kind": request["kind"]}
    response = _call("new", request)
    return {"pid": response.get("pid"), "kind": request["kind"]}


def is_live(name: str) -> bool:
    if _is_tmux():
        return _tmux_is_live(name)
    return bool(_call("has", {"name": name})["live"])


def send_text(name: str, text: str) -> None:
    if _is_tmux():
        # `--` only where it is needed, so ordinary text keeps today's argv.
        _tmux_send(name, ["-l", "--", text] if text.startswith("-") else ["-l", text])
    else:
        _call("send", {"name": name, "keys": [text], "literal": True})


def send_key(name: str, key: str) -> None:
    if _is_tmux():
        _tmux_send(name, [key])
    else:
        _call("send", {"name": name, "keys": [key], "literal": False})


def capture(name: str, history: Union[bool, int] = False, join: bool = False) -> str:
    if _is_tmux():
        return _tmux_capture(name, history, join)
    return str(_call("capture", {"name": name, "history": history, "join": join})["text"])


def wait_for(
    name: str, regex: Regex, timeout_ms: int, then_send: Union[None, str, Sequence[str]] = None
) -> Dict[str, Any]:
    pattern = _compiled(regex)
    keys = _key_list(then_send)
    if _is_tmux():
        return _tmux_wait(name, pattern, timeout_ms, keys)
    frame: Dict[str, Any] = {"name": name, "regex": pattern.pattern, "timeoutMs": timeout_ms, "thenSend": keys}
    if pattern.flags & re.IGNORECASE:
        frame["flags"] = "i"
    response = _call("wait", frame, timeout_ms + _HOST_MARGIN_MS)
    return {"matched": response.get("matched"), "ms": response.get("ms"), "screen": response.get("screen")}


def stop(name: str, grace_ms: Optional[int] = None) -> Dict[str, bool]:
    if _is_tmux():
        return _tmux_stop(name, grace_ms)
    try:
        _call("kill", {"name": name, "graceMs": grace_ms or 0}, (grace_ms or 0) + _HOST_MARGIN_MS)
    except SessionHostError as error:
        if error.code == _UNKNOWN_SESSION:
            return {"stopped": False}
        raise
    return {"stopped": True}


def pids(name: str) -> List[int]:
    if _is_tmux():
        return _tmux_pids(name)
    try:
        return list(_call("pids", {"name": name})["pids"])
    except SessionHostError as error:
        if error.code == _UNKNOWN_SESSION:
            return []
        raise


def list_sessions() -> List[Dict[str, Any]]:
    if _is_tmux():
        result = _tmux(["list-sessions", "-F", "#{session_name}"])
        if result.returncode != 0:
            return []
        return [{"name": name, "kind": None, "pid": None} for name in result.stdout.splitlines() if name]
    sessions = _call("list")["sessions"]
    return [
        {"name": session["name"], "kind": session["kind"], "pid": session["pid"]}
        for session in sessions
        if session.get("exit") is None
    ]


def attach_hint(name: str, target: Optional[str] = None) -> str:
    """The line a launcher prints; the launcher decides which stream."""
    if _is_tmux():
        return f"Attach with: tmux attach -t {name}"
    # Until the owner-facing `scripts/ccdm attach` exists, the command that does attach.
    return f"Attach with: node scripts/ccdm-host.js attach -t {name}"


def run_detached(
    argv: Sequence[str],
    cwd: Optional[str] = None,
    env: Optional[Mapping[str, str]] = None,
    log: Optional[str] = None,
) -> Dict[str, int]:
    if _is_tmux():
        return _spawn_detached(argv, cwd, env, log)
    # The host resolves neither against the caller, and it needs an absolute log.
    request = {
        "argv": list(argv),
        "cwd": cwd or os.getcwd(),
        "env": _without_session_name(env),
        "log": os.path.abspath(log) if log else None,
    }
    response = _call("run-detached", request)
    return {"pid": response["pid"]}
