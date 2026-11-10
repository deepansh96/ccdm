"""How a message names the command a user should run on this OS.

macOS and Linux have the ``.sh`` scripts and the LaunchAgents. Windows has
neither: every command is a ``scripts/ccdm`` subcommand, a service is a
scheduled task, and a Node script needs ``node`` in front of it.
"""

from __future__ import annotations

import sys

WIN32 = sys.platform == "win32"

# Service name -> the macOS installer `install-service <name>` runs.
POSIX_INSTALLERS = {
    "router": "install-router-service.sh",
    "thread-supervisor": "install-thread-supervisor.sh",
    "reminders": "install-conversation-reminder-service.sh",
    "usage-poster": "install-usage-stats-poster.sh",
}


def script_ref(name: str) -> str:
    """A lifecycle command, as the user types it: ``stop-session``."""
    return f"scripts/ccdm {name}" if WIN32 else f"scripts/{name}.sh"


def installer_ref(service: str) -> str:
    """The command that installs and starts the named service."""
    return f"scripts/ccdm install-service {service}" if WIN32 else f"scripts/{POSIX_INSTALLERS[service]}"


def node_script_ref(script: str) -> str:
    """A Node script of this checkout, run in the foreground: ``router.js``."""
    return f"node scripts/{script}" if WIN32 else f"scripts/{script}"


def reminders_ref() -> str:
    """The Conversation Reminder service's operator command, before its verb."""
    return "scripts/ccdm reminders" if WIN32 else "scripts/conversation-reminder-service.py"


def message_prefix(name: str) -> str:
    """What a lifecycle command's own error lines start with: ``stop-session``."""
    return f"ccdm {name}" if WIN32 else f"{name}.sh"


def service_noun() -> str:
    """What supervises an installed service."""
    return "scheduled task" if WIN32 else "LaunchAgent"


def relaunch_service() -> str:
    """What installing a service again does to its supervisor, after "rerun <installer> to"."""
    return "start the scheduled task again" if WIN32 else "relaunch the LaunchAgent"


def webhook_fix(project: str) -> str:
    """What to run for a project that has no webhook. Windows has no pool bot to migrate from."""
    create = f"node scripts/router.js ensure-webhook {project}"
    if WIN32:
        return f"Run {create}"
    return f"Run scripts/migrate-to-router.sh {project} (or {create})"


def start_router_hint() -> str:
    """The two ways to start the Router, for a "the Router is not reachable" message."""
    return f"{installer_ref('router')}, or {node_script_ref('router.js')} serve"
