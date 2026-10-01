"""The worker's side of the Node Router link: NDJSON over the link's stdio."""

from __future__ import annotations

import itertools
import json
import os
from pathlib import Path
import queue
import subprocess
import threading


LINK_SCRIPT = Path(__file__).resolve().parent.parent / "thread-supervisor-link.js"
# Longer than the RouterClient's own 10-second op deadline, which answers first.
CALL_TIMEOUT_SECONDS = 15


class LinkError(Exception):
    def __init__(self, code: str, message: str = ""):
        super().__init__(message or code)
        self.code = code


class Link:
    """Spawns the link and splits its output: op responses go to the waiting
    caller, and everything else (connection changes, events, the link's exit)
    to `next_frame`, in arrival order."""

    def __init__(self, key_file: Path):
        node = os.environ.get("CCDM_ROUTER_NODE") or "node"
        self.process = subprocess.Popen([node, str(LINK_SCRIPT), "--key-file", str(key_file)],
                                        stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1)
        self.frames: queue.Queue = queue.Queue()
        self.responses: dict[str, dict] = {}
        self.answered = threading.Condition()
        self.ids = itertools.count(1)
        threading.Thread(target=self._read, daemon=True).start()

    @property
    def pid(self) -> int:
        return self.process.pid

    def _read(self) -> None:
        for line in self.process.stdout:
            try:
                frame = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not isinstance(frame, dict):
                continue
            if frame.get("type") == "response":
                with self.answered:
                    self.responses[str(frame.get("id"))] = frame
                    self.answered.notify_all()
            else:
                self.frames.put(frame)
        self.frames.put({"type": "link_exit"})
        with self.answered:
            self.answered.notify_all()

    def post(self, frame: dict) -> None:
        """Queue a worker-internal frame (a launch's exit, say) behind the
        Router frames already received, so handlers see one ordered stream."""
        self.frames.put(frame)

    def next_frame(self, timeout: float) -> dict | None:
        try:
            return self.frames.get(timeout=timeout)
        except queue.Empty:
            return None

    def call(self, op: str, args: dict) -> object:
        """One Router op through the link; raises LinkError with the Router's code."""
        request_id = str(next(self.ids))
        try:
            self.process.stdin.write(json.dumps({"type": "request", "id": request_id, "op": op, "args": args}) + "\n")
            self.process.stdin.flush()
        except (BrokenPipeError, ValueError) as error:
            raise LinkError("router_unavailable", "the Router link stopped") from error
        with self.answered:
            answered = self.answered.wait_for(
                lambda: request_id in self.responses or self.process.poll() is not None, CALL_TIMEOUT_SECONDS)
            frame = self.responses.pop(request_id, None)
        if frame is None:
            raise LinkError("timeout" if not answered else "router_unavailable", f"{op} got no answer")
        if not frame.get("ok"):
            error = frame.get("error") or {}
            raise LinkError(str(error.get("code") or "link_error"), str(error.get("message") or ""))
        return frame.get("result")

    def close(self) -> None:
        try:
            self.process.stdin.close()
        except OSError:
            pass
        try:
            self.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait()
