"""Codex thread app-server ports: one per thread, from a supervisor base.

The base is 19000, or CCDM_THREAD_WS_PORT_BASE; it is a supervisor setting,
not a registry field. A port is skipped when any registry project names it as
its `ws_port`, a store row holds it, or something already listens on it.
"""

from __future__ import annotations

import os
import socket


DEFAULT_BASE = 19000
SPAN = 1000


def base() -> int:
    try:
        value = int(os.environ.get("CCDM_THREAD_WS_PORT_BASE") or DEFAULT_BASE)
    except ValueError:
        return DEFAULT_BASE
    return value if 0 < value < 65536 else DEFAULT_BASE


def registry_ports(registry: dict) -> set[int]:
    projects = registry.get("projects")
    ports = set()
    for entry in (projects.values() if isinstance(projects, dict) else ()):
        port = entry.get("ws_port") if isinstance(entry, dict) else None
        if isinstance(port, int) and not isinstance(port, bool):
            ports.add(port)
    return ports


def in_use(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        # As the app-server binds: a closed connection lingering in TIME_WAIT
        # leaves the port free, and a listener does not.
        probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            probe.bind(("127.0.0.1", port))
        except OSError:
            return True
    return False


def allocate(registry: dict, held: set[int]) -> int | None:
    """The first free port from the base, or None when the whole span is taken."""
    taken = registry_ports(registry) | held
    start = base()
    for port in range(start, min(start + SPAN, 65536)):
        if port not in taken and not in_use(port):
            return port
    return None
