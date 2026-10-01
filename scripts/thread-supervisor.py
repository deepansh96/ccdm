#!/usr/bin/env python3
"""Thread Supervisor: Thread Conversation lifecycle as a Router client.

`run` is the foreground worker; `run --supervised` is the LaunchAgent's, which
exits while `disable` is in force. `enable`, `disable` and `preflight` match the
reminder service's; `status` reports the worker, the session caps and the bound threads.
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
from thread_supervisor import service  # noqa: E402
from thread_supervisor.worker import AlreadyRunning, LinkStopped, run  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("run", "status", "enable", "disable", "preflight"))
    parser.add_argument("--project-root", type=Path, default=Path(__file__).resolve().parent.parent)
    parser.add_argument("--state-dir", type=Path, default=None)
    parser.add_argument("--supervised", action="store_true",
                        help="with run: exit while the supervisor is disabled (the LaunchAgent's mode)")
    args = parser.parse_args()
    state_dir = args.state_dir or default_state_dir()
    try:
        if args.command in ("preflight", "enable"):
            result = getattr(service, args.command)(args.project_root, state_dir)
            if result.get("status") == "blocked":
                print(json.dumps(result, sort_keys=True))
                return 2
        elif args.command == "disable":
            result = service.disable(args.project_root, state_dir)
        else:
            if args.command == "run" and not (args.supervised and service.is_disabled(state_dir)):
                run(args.project_root, state_dir,
                    (lambda: service.is_disabled(state_dir)) if args.supervised else None)
            result = service.service_status(state_dir, args.project_root)
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
