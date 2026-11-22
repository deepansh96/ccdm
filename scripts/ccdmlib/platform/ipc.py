"""Local server endpoints and the server proof; the twin of scripts/platform/ipc.js.

Before sending anything else, a Windows client writes one NDJSON line
``{"type":"server_proof","nonce":"<64 hex>"}`` and the server must answer with
``{"type":"server_proof_ok","proof":"<server_proof(secret, nonce)>"}``. POSIX keeps
today's Unix socket and sends no proof.
"""

from __future__ import annotations

import hashlib
import hmac
import io
import json
import os
import secrets
import socket
import sys
import time
from pathlib import Path
from typing import Any, BinaryIO, Optional, Tuple, Union, cast

from .atomic import write_file_atomic
from .paths import state_root

WIN32 = sys.platform == "win32"

if WIN32:
    import _winapi
    import msvcrt

    _ERROR_SEM_TIMEOUT = 121
    _ERROR_PIPE_BUSY = 231
    # Without this flag a server could impersonate the connecting client.
    _SECURITY_SQOS_PRESENT = 0x00100000

_ENDPOINT_OVERRIDES = {"router": "CCDM_ROUTER_SOCKET", "host": "CCDM_HOST_SOCKET"}
_CONNECT_TIMEOUT_MS = 5000
_MAX_PROOF_LINE = 4096

StateDir = Union[str, "os.PathLike[str]"]


class ServerProofError(ConnectionError):
    """The server at the endpoint could not prove it holds the published secret."""


def publish_pipe(state_dir: StateDir, name: str) -> Tuple[str, str]:
    """Publish a fresh pipe name and secret; the secret is written first."""
    pipe = f"\\\\.\\pipe\\ccdm-{secrets.token_hex(16)}-{name}"
    secret = secrets.token_hex(32)
    write_file_atomic(Path(state_dir) / f"{name}.secret", secret)
    write_file_atomic(Path(state_dir) / f"{name}.pipe", pipe)
    return pipe, secret


def endpoint(state_dir: StateDir, name: str) -> str:
    if not WIN32:
        return os.path.normpath(os.path.join(os.fspath(state_dir), f"{name}.sock"))
    variable = _ENDPOINT_OVERRIDES.get(name)
    override = os.environ.get(variable) if variable else None
    if override:
        return override
    return (Path(state_dir) / f"{name}.pipe").read_text(encoding="utf-8").strip()


def read_secret(state_dir: StateDir, name: str) -> str:
    return (Path(state_dir) / f"{name}.secret").read_text(encoding="utf-8").strip()


def server_proof(secret: str, nonce: str) -> str:
    return hmac.new(secret.encode("utf-8"), nonce.encode("utf-8"), hashlib.sha256).hexdigest()


def verify_server_proof(secret: str, nonce: str, proof: Any) -> bool:
    if not isinstance(proof, str):
        return False
    return hmac.compare_digest(server_proof(secret, nonce).encode("utf-8"), proof.encode("utf-8"))


def connect(name: str, state_dir: Optional[StateDir] = None, timeout_ms: int = _CONNECT_TIMEOUT_MS) -> BinaryIO:
    """Connect to a named server and return a buffered binary stream.

    ``state_dir`` defaults to ``<stateRoot>/<name>``. The endpoint and secret are
    read on every call. On Windows the server must pass the proof before this
    returns (:class:`ServerProofError` otherwise), also when an override is set.
    Use the stream from one thread at a time.
    """
    directory = state_dir if state_dir is not None else state_root() / name
    target = endpoint(directory, name)
    deadline = time.monotonic() + timeout_ms / 1000
    if WIN32:
        return _connect_pipe(target, read_secret(directory, name), deadline)
    return _connect_socket(target, deadline)


def _connect_socket(path: str, deadline: float) -> BinaryIO:
    client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        client.settimeout(max(deadline - time.monotonic(), 0))
        client.connect(path)
        client.settimeout(None)
        # The stream keeps the connection open after this socket object closes.
        return cast(BinaryIO, client.makefile("rwb"))
    finally:
        client.close()


if WIN32:

    def _open_pipe(pipe: str, deadline: float) -> Any:
        while True:
            try:
                return _winapi.CreateFile(
                    pipe,
                    _winapi.GENERIC_READ | _winapi.GENERIC_WRITE,
                    0,
                    _winapi.NULL,
                    _winapi.OPEN_EXISTING,
                    _SECURITY_SQOS_PRESENT,
                    _winapi.NULL,
                )
            except OSError as error:
                if error.winerror != _ERROR_PIPE_BUSY:
                    raise
            remaining_ms = int((deadline - time.monotonic()) * 1000)
            if remaining_ms <= 0:
                raise TimeoutError(f"pipe stayed busy: {pipe}")
            try:
                _winapi.WaitNamedPipe(pipe, remaining_ms)
            except OSError as error:
                if error.winerror == _ERROR_SEM_TIMEOUT:
                    raise TimeoutError(f"pipe stayed busy: {pipe}") from error
                raise

    def _read_proof_line(handle: Any, deadline: float) -> bytes:
        """Read one line without touching anything after it, and never block past the deadline."""
        while True:
            data, _, _ = _winapi.PeekNamedPipe(handle, _MAX_PROOF_LINE)
            end = data.find(b"\n")
            if end >= 0:
                return _winapi.ReadFile(handle, end + 1)[0]
            if len(data) >= _MAX_PROOF_LINE:
                raise ServerProofError("server proof reply is too long")
            if time.monotonic() >= deadline:
                raise ServerProofError("timed out waiting for the server proof")
            time.sleep(0.005)

    def _check_server(handle: Any, secret: str, deadline: float) -> None:
        nonce = secrets.token_hex(32)
        request = json.dumps({"type": "server_proof", "nonce": nonce}, separators=(",", ":")) + "\n"
        try:
            _winapi.WriteFile(handle, request.encode("utf-8"))
            line = _read_proof_line(handle, deadline)
        except ServerProofError:
            raise
        except OSError as error:
            raise ServerProofError("server closed the pipe before proving itself") from error
        try:
            reply = json.loads(line)
        except ValueError as error:
            raise ServerProofError("server proof reply is not JSON") from error
        proof = reply.get("proof") if isinstance(reply, dict) else None
        if not verify_server_proof(secret, nonce, proof):
            raise ServerProofError("server failed the proof")

    def _connect_pipe(pipe: str, secret: str, deadline: float) -> BinaryIO:
        handle = _open_pipe(pipe, deadline)
        try:
            _check_server(handle, secret, deadline)
            descriptor = msvcrt.open_osfhandle(handle, os.O_BINARY)
        except BaseException:
            _winapi.CloseHandle(handle)
            raise
        raw = os.fdopen(descriptor, "r+b", buffering=0)
        return cast(BinaryIO, io.BufferedRWPair(raw, raw))
