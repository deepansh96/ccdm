"""The Thread Supervisor's service: ``thread-supervisor.py run --supervised``.

The same worker install-thread-supervisor.sh supervises on macOS. ``--supervised``
makes it exit 0 while its own ``disable`` is in force, and the service host does
not restart a worker that exits 0.

Thread sessions live in ccdm-host, not in this worker: stopping or removing the
task leaves them running, and the next start keeps them bound. The worker itself
needs the Router, not the host. It reaches the host only to start or stop a
thread session, and a start that finds no host answers in the thread.
"""

from __future__ import annotations

import os
from typing import Dict, Optional

from . import ROOT_DIR, SCRIPTS_DIR, Context, Plan, require_absolute
from . import _worker
from ...platform import exe
# What a session launch passes on to ccdm-host. The worker launches thread
# sessions with its own environment, so the task must carry the same names.
from ..start_codex_session import _FORWARDED_ON_WINDOWS

TEMPLATE = "thread-supervisor.task.xml.in"

_WHAT = "Thread Supervisor"
_SUPERVISOR = SCRIPTS_DIR / "thread-supervisor.py"

# The service host drops every CCDM_* and CLAUDE* name it inherits, so what the
# worker reads is recorded at install. Only non-secret paths: the supervisor
# holds no Discord credential. These are always set.
ALWAYS_SET_ENV = frozenset((
    "CCDM_PYTHON", "CCDM_ROUTER_NODE", "CCDM_ROUTER_STATE_DIR", "CCDM_STATE_ROOT", "PATH", "PYTHONUTF8",
))
# These are recorded only when the installer's own environment sets them: where
# this installation keeps its host, Router and reminders, and the Claude account
# a thread uses when its project names none.
CARRIED_WHEN_SET = tuple(sorted((set(_FORWARDED_ON_WINDOWS) | {"CLAUDE_CONFIG_DIR"}) - ALWAYS_SET_ENV))
_MUST_BE_ABSOLUTE = ("CLAUDE_CONFIG_DIR", "CCDM_REMINDER_STATE_DIR")


def _optional(resolve) -> Optional[str]:
    try:
        return resolve()["command"]
    except exe.ToolNotFound:
        return None


def _codex_shim() -> Optional[str]:
    """npm's codex.cmd, which the Codex resolver finds through PATH."""
    for directory in os.environ.get("PATH", "").split(os.pathsep):
        candidate = os.path.join(directory.strip('"'), "codex.cmd")
        if directory and os.path.isfile(candidate):
            return candidate
    return None


def plan(context: Context) -> Plan:
    node = _worker.resolve_node()
    python = _worker.resolve_python()
    state_dir = os.environ.get("CCDM_THREAD_SUPERVISOR_STATE_DIR") or str(context.state_root / "thread-supervisor")
    router_state_dir = os.environ.get("CCDM_ROUTER_STATE_DIR") or str(context.state_root / "router")
    require_absolute({"CCDM_THREAD_SUPERVISOR_STATE_DIR": state_dir, "CCDM_ROUTER_STATE_DIR": router_state_dir})
    carried = {name: os.environ[name] for name in CARRIED_WHEN_SET if os.environ.get(name)}
    require_absolute({name: carried[name] for name in _MUST_BE_ABSOLUTE if name in carried})

    worker_args = ["--project-root", str(ROOT_DIR), "--state-dir", state_dir]
    report = _worker.run_preflight(_WHAT, python, _SUPERVISOR, worker_args,
                                   {"CCDM_ROUTER_NODE": node, "CCDM_ROUTER_STATE_DIR": router_state_dir})
    _worker.refuse_foreground_worker(context, _WHAT, state_dir)

    disabled = bool(report.get("disabled"))
    if disabled:
        print("The Thread Supervisor is disabled: the task is installed but its worker is not started, and it "
              "exits at each launch until you run py -3 scripts\\thread-supervisor.py enable and then this command again.")
    else:
        print("Run py -3 scripts\\thread-supervisor.py status for the worker, its Router connection, and the bound threads.")

    env: Dict[str, str] = {
        **carried,
        "CCDM_PYTHON": python,
        "CCDM_ROUTER_NODE": node,
        "CCDM_ROUTER_STATE_DIR": router_state_dir,
        "CCDM_STATE_ROOT": str(context.state_root),
        # Claude and Codex resolve for a thread launch; node and Python for the worker.
        "PATH": _worker.task_path((_optional(exe.claude), _codex_shim(), node, python)),
        "PYTHONUTF8": "1",
    }
    return Plan(
        node=node,
        command=[python, str(_SUPERVISOR), "run", "--supervised", *worker_args],
        cwd=str(ROOT_DIR),
        env=env,
        allowed_env=ALWAYS_SET_ENV | frozenset(carried),
        private_dirs=[state_dir],
        # A disabled worker exits 0 at once: the task is registered and nothing is started.
        supervised=not disabled,
    )
