"""A local service's request channel: one NDJSON frame in, one out, per connection.

POSIX listens on a Unix socket in the state directory, private through its mode.

Windows listens on a named pipe from ``ipc.publish_pipe``, so the name is new at
each start and a leftover pipe cannot block one. The published secret is the
authkey: both ends run the ``multiprocessing`` challenge before any frame moves.
Frames go through ``send_bytes`` and ``recv_bytes`` only, because the plain receive
of a ``multiprocessing`` connection unpickles what the peer sent.
"""

from __future__ import annotations

from contextlib import contextmanager
import json
import os
from pathlib import Path
import socket
import sys
from typing import Any, Iterator, Optional, Union

from . import ipc

WIN32 = sys.platform == "win32"

if WIN32:
    import multiprocessing.connection as _mp

StateDir = Union[str, "os.PathLike[str]"]

FRAME_LIMIT = 65536
_BACKLOG = 8


class AuthenticationFailed(ConnectionError):
    """The other end of the pipe does not hold the published secret."""


def _encode(value: Any) -> bytes:
    return (json.dumps(value) + "\n").encode("utf-8")


def _decode(data: bytes) -> Any:
    return json.loads(data.split(b"\n", 1)[0].decode("utf-8"))


@contextmanager
def _in_directory(path: StateDir) -> Iterator[None]:
    """Unix socket paths are limited to about 100 bytes, so bind and connect by
    the socket's name from inside the state dir."""
    previous = os.getcwd()
    os.chdir(path)
    try:
        yield
    finally:
        os.chdir(previous)


class _Connection:
    def __enter__(self) -> "_Connection":
        return self

    def __exit__(self, *_exception: Any) -> None:
        self.close()

    def authenticate(self) -> None:
        """Prove both ends hold the secret; raises OSError. POSIX relies on the socket's mode."""

    def close(self) -> None:
        raise NotImplementedError

    def write_frame(self, value: Any) -> None:
        raise NotImplementedError

    def read_frame(self) -> Any:
        """Raises OSError when the peer goes or times out, ValueError on a malformed frame."""
        raise NotImplementedError


class _SocketConnection(_Connection):
    def __init__(self, connection: socket.socket):
        self._socket = connection

    def close(self) -> None:
        self._socket.close()

    def write_frame(self, value: Any) -> None:
        self._socket.sendall(_encode(value))

    def read_frame(self) -> Any:
        data = bytearray()
        chunk = bytearray(4096)
        while b"\n" not in data and len(data) < FRAME_LIMIT:
            count = self._socket.recv_into(chunk)
            if not count:
                break
            data += chunk[:count]
        return _decode(bytes(data))


if WIN32:

    class _PipeConnection(_Connection):
        def __init__(self, connection: Any, secret: str, timeout: Optional[float], server: bool):
            self._pipe = connection
            self._secret = secret.encode("ascii")
            self._timeout = timeout
            self._server = server

        def authenticate(self) -> None:
            try:
                if self._server:
                    _mp.deliver_challenge(self._pipe, self._secret)
                    _mp.answer_challenge(self._pipe, self._secret)
                else:
                    self._wait_for_data()
                    _mp.answer_challenge(self._pipe, self._secret)
                    _mp.deliver_challenge(self._pipe, self._secret)
            except (_mp.AuthenticationError, EOFError) as error:
                raise AuthenticationFailed(str(error)) from error

        def close(self) -> None:
            self._pipe.close()

        def _wait_for_data(self) -> None:
            if not self._pipe.poll(self._timeout):
                raise TimeoutError("the pipe sent nothing in time")

        def write_frame(self, value: Any) -> None:
            self._pipe.send_bytes(_encode(value))

        def read_frame(self) -> Any:
            self._wait_for_data()
            try:
                return _decode(self._pipe.recv_bytes(FRAME_LIMIT))
            except EOFError as error:
                raise ConnectionError("the peer closed the pipe") from error


class Listener:
    """Accepts connections at ``<state_dir>/<socket_name>``, or on a new pipe published as ``pipe_name``.

    The caller holds the service's lock, so anything already at the endpoint is stale.
    """

    def __init__(self, state_dir: StateDir, socket_name: str, pipe_name: str, timeout: Optional[float] = None):
        self._state_dir = Path(state_dir)
        self._pipe_name = pipe_name
        self._timeout = timeout
        if WIN32:
            self._closed = False
            self._pipe, self._secret = ipc.publish_pipe(state_dir, pipe_name)
            self._listener = _mp.Listener(self._pipe, family="AF_PIPE")
        else:
            self._path = self._state_dir / socket_name
            self._path.unlink(missing_ok=True)
            self._socket = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            umask = os.umask(0o177)
            try:
                with _in_directory(state_dir):
                    self._socket.bind(socket_name)
            finally:
                os.umask(umask)
            os.chmod(self._path, 0o600)
            self._socket.listen(_BACKLOG)

    def accept(self) -> _Connection:
        """The next connection, not yet authenticated; raises OSError once closed."""
        if not WIN32:
            connection, _ = self._socket.accept()
            connection.settimeout(self._timeout)
            return _SocketConnection(connection)
        accepted = self._listener.accept()
        if self._closed:
            accepted.close()
            raise OSError("the listener is closed")
        return _PipeConnection(accepted, self._secret, self._timeout, server=True)

    def close(self) -> None:
        if not WIN32:
            self._socket.close()
            self._path.unlink(missing_ok=True)
            return
        self._closed = True
        try:
            # A pipe accept blocked in another thread only wakes for a client.
            _mp.Client(self._pipe, family="AF_PIPE").close()
        except OSError:
            pass
        self._listener.close()
        for suffix in ("pipe", "secret"):
            try:
                (self._state_dir / f"{self._pipe_name}.{suffix}").unlink(missing_ok=True)
            except OSError:
                pass  # A reader has it open; the next start replaces it.


def Client(state_dir: StateDir, socket_name: str, pipe_name: str, timeout: Optional[float] = None) -> _Connection:
    """Connect to a running service; raises OSError when none answers or it fails the challenge."""
    if not WIN32:
        client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            client.settimeout(timeout)
            with _in_directory(state_dir):
                client.connect(socket_name)
        except BaseException:
            client.close()
            raise
        return _SocketConnection(client)
    pipe = ipc.endpoint(state_dir, pipe_name)
    connection = _PipeConnection(_mp.Client(pipe, family="AF_PIPE"), ipc.read_secret(state_dir, pipe_name), timeout,
                                 server=False)
    try:
        connection.authenticate()
    except BaseException:
        connection.close()
        raise
    return connection
