"""The Conversation Reminder service: ``conversation-reminder-service.py run``.

Opt-in, as on macOS: nothing installs it unless the operator asks. It is the same
worker install-conversation-reminder-service.sh supervises, and the foreground
``scripts/ccdm reminders run`` shares its single-worker lock. The worker exits 0
while reminders are disabled, and the service host does not restart a worker
that exits 0.

The worker has no stop handler: a stop ends it, and its observer exits by itself
when its input closes.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Dict

from . import ROOT_DIR, SCRIPTS_DIR, Context, Plan, require_absolute
from . import _worker

TEMPLATE = "reminders.task.xml.in"

_WHAT = "Conversation Reminder"
_SERVICE = SCRIPTS_DIR / "conversation-reminder-service.py"

# The service host drops every CCDM_* name it inherits, so what the worker and
# its observer read is recorded at install. Only non-secret paths: credentials
# stay in their private files. These are always set.
ALWAYS_SET_ENV = frozenset((
    "CCDM_PYTHON", "CCDM_REMINDER_NODE", "CCDM_ROUTER_STATE_DIR", "CCDM_STATE_ROOT", "PATH", "PYTHONUTF8",
    "ROOT_DISCORD_STATE_DIR",
))
# These are recorded only when the installer's own environment sets them.
CARRIED_WHEN_SET = ("CCDM_REMINDER_RECEIPTS_DIR", "CCDM_ROUTER_SOCKET", "CCDM_THREAD_SUPERVISOR_STATE_DIR")
_MUST_BE_ABSOLUTE = ("CCDM_REMINDER_RECEIPTS_DIR", "CCDM_THREAD_SUPERVISOR_STATE_DIR")


def plan(context: Context) -> Plan:
    node = _worker.resolve_node("CCDM_REMINDER_NODE")
    python = _worker.resolve_python()
    state_dir = os.environ.get("CCDM_REMINDER_STATE_DIR") or str(context.state_root / "conversation-reminders")
    root_state_dir = os.environ.get("ROOT_DISCORD_STATE_DIR") or str(Path.home() / ".claude" / "channels" / "discord")
    router_state_dir = os.environ.get("CCDM_ROUTER_STATE_DIR") or str(context.state_root / "router")
    require_absolute({"CCDM_REMINDER_STATE_DIR": state_dir, "ROOT_DISCORD_STATE_DIR": root_state_dir,
                      "CCDM_ROUTER_STATE_DIR": router_state_dir})
    carried = {name: os.environ[name] for name in CARRIED_WHEN_SET if os.environ.get(name)}
    require_absolute({name: carried[name] for name in _MUST_BE_ABSOLUTE if name in carried})

    worker_args = ["--project-root", str(ROOT_DIR), "--state-dir", state_dir]
    report = _worker.run_preflight(_WHAT, python, _SERVICE, worker_args, {
        "CCDM_REMINDER_NODE": node, "CCDM_ROUTER_STATE_DIR": router_state_dir, "ROOT_DISCORD_STATE_DIR": root_state_dir,
    })
    _worker.refuse_foreground_worker(context, _WHAT, state_dir)

    # The macOS installer's three lines, with the commands as Windows spells them.
    disabled = bool(report.get("disabled"))
    if disabled:
        print("Reminders are disabled: the task is installed but its worker is not started, and it exits at each "
              "launch until you run scripts/ccdm reminders enable and then this command again.")
    elif not report.get("discovery_requested"):
        print("Delivery stays off until scripts/ccdm reminders enable; the worker observes but sends nothing.")
    else:
        print("Reminders are enabled; run scripts/ccdm reminders status for per-channel readiness.")

    env: Dict[str, str] = {
        **carried,
        "CCDM_PYTHON": python,
        "CCDM_REMINDER_NODE": node,
        "CCDM_ROUTER_STATE_DIR": router_state_dir,
        "CCDM_STATE_ROOT": str(context.state_root),
        "PATH": _worker.task_path((node, python)),
        "PYTHONUTF8": "1",
        "ROOT_DISCORD_STATE_DIR": root_state_dir,
    }
    return Plan(
        node=node,
        command=[python, str(_SERVICE), "run", *worker_args],
        cwd=str(ROOT_DIR),
        env=env,
        allowed_env=ALWAYS_SET_ENV | frozenset(carried),
        private_dirs=[state_dir],
        # A disabled worker exits 0 at once: the task is registered and nothing is started.
        supervised=not disabled,
    )
