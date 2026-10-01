#!/usr/bin/env python3
"""Thread Supervisor: Thread Conversation lifecycle as a Router client.

`run` is the foreground worker; `status` reports it, the session caps and the bound threads.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import sqlite3
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))

from thread_supervisor.paths import default_state_dir  # noqa: E402
from thread_supervisor.status import status  # noqa: E402
from thread_supervisor.worker import AlreadyRunning, LinkStopped, run  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("run", "status"))
    parser.add_argument("--project-root", type=Path, default=Path(__file__).resolve().parent.parent)
    parser.add_argument("--state-dir", type=Path, default=None)
    args = parser.parse_args()
    state_dir = args.state_dir or default_state_dir()
    try:
        if args.command == "run":
            run(args.project_root, state_dir)
        result = status(state_dir, args.project_root)
    except LinkStopped as error:
        print(json.dumps({"status": "failed", "reason": str(error)}, sort_keys=True))
        return 1
    except (AlreadyRunning, OSError, ValueError, sqlite3.Error) as error:
        print(json.dumps({"status": "blocked", "reason": str(error)}, sort_keys=True))
        return 2
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
