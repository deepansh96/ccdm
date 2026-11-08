"""Calls one ccdmlib.platform function for tests/e2e/platform-contract.test.js.

Reads ``{"fn":"<module>.<function>","args":[...]}`` on stdin and prints one JSON
outcome: ``{"ok":true,"value":...,"ms":n}`` or ``{"ok":false,"error":{...},"ms":n}``.
"""

from __future__ import annotations

import errno
import importlib
import json
import os
import sys
import time

sys.dont_write_bytecode = True
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", "scripts")))


def main() -> None:
    request = json.loads(sys.stdin.buffer.read().decode("utf-8"))
    module_name, function_name = request["fn"].split(".")
    target = getattr(importlib.import_module(f"ccdmlib.platform.{module_name}"), function_name)
    started = time.monotonic()
    try:
        outcome = {"ok": True, "value": target(*request.get("args", []))}
    except Exception as error:  # Every failure is a result the case asserts on.
        code = errno.errorcode.get(error.errno) if isinstance(error, OSError) else None
        outcome = {"ok": False, "error": {"code": code, "name": type(error).__name__, "message": str(error)}}
    outcome["ms"] = (time.monotonic() - started) * 1000
    sys.stdout.write(json.dumps(outcome, default=os.fspath) + "\n")


if __name__ == "__main__":
    main()
