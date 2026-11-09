"""The Router's service: ``node scripts/router.js serve``, as install-router-service.sh runs it."""

from __future__ import annotations

import os
from pathlib import Path

from . import ROOT_DIR, SCRIPTS_DIR, Context, Plan, require_absolute, require_node, run_preflight

TEMPLATE = "router.task.xml.in"

# Only non-secret paths: the root token stays in root's state directory.
ALLOWED_ENV = frozenset(("CCDM_ROUTER_STATE_DIR", "PATH", "ROOT_DISCORD_STATE_DIR"))


def plan(context: Context) -> Plan:
    node = require_node()
    state_dir = os.environ.get("CCDM_ROUTER_STATE_DIR") or str(context.state_root / "router")
    root_state_dir = os.environ.get("ROOT_DISCORD_STATE_DIR") or str(Path.home() / ".claude" / "channels" / "discord")
    require_absolute({"CCDM_ROUTER_STATE_DIR": state_dir, "ROOT_DISCORD_STATE_DIR": root_state_dir})
    env = {"CCDM_ROUTER_STATE_DIR": state_dir, "ROOT_DISCORD_STATE_DIR": root_state_dir}
    router = SCRIPTS_DIR / "router.js"
    run_preflight(node, router, env)
    system_root = os.environ.get("SystemRoot") or "C:\\Windows"
    path = os.pathsep.join((os.path.dirname(node), os.path.join(system_root, "System32"), system_root))
    return Plan(
        node=node,
        command=[node, str(router), "serve"],
        cwd=str(ROOT_DIR),
        env={**env, "PATH": path},
        allowed_env=ALLOWED_ENV,
        private_dirs=[state_dir],
    )
