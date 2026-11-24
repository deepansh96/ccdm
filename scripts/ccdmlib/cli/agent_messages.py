"""`ccdm agent-messages allow|revoke|list`: manage Agent Message Grants in registry.json."""

from __future__ import annotations

import argparse
import importlib.util
import json
import sys
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from .list import REGISTRY, _read_registry, fail

_REGISTRY_UPDATE_SCRIPT = Path(__file__).resolve().parents[2] / "registry-update.py"


class _CommandError(Exception):
    """A validation or registry problem reported as `ccdm: …` with exit 1."""


class _NoChange(Exception):
    """Sentinel raised inside a locked updater when nothing in registry.json changed."""


def _load_registry_update() -> Any:
    sys.dont_write_bytecode = True
    spec = importlib.util.spec_from_file_location("ccdm_registry_update", str(_REGISTRY_UPDATE_SCRIPT))
    if spec is None or spec.loader is None:
        fail(f"could not load {_REGISTRY_UPDATE_SCRIPT}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _locked_update(updater: Callable[[Dict[str, Any]], None]) -> bool:
    """Run `updater(registry)` under the shared registry lock; False if `_NoChange`."""
    registry_update = _load_registry_update()
    try:
        registry_update.update_registry(str(REGISTRY), updater)
    except _NoChange:
        return False
    except _CommandError as error:
        fail(str(error))
    except FileNotFoundError:
        fail(f"registry.json not found at {REGISTRY}")
    except ValueError as error:
        fail(f"registry.json is invalid JSON: {error}")
    except (TimeoutError, OSError) as error:
        fail(str(error))
    return True


def _targets_list(project: str, entry: Dict[str, Any]) -> List[str]:
    raw = entry.get("agent_message_targets")
    if raw is None:
        return []
    if not isinstance(raw, list) or not all(isinstance(item, str) and item.strip() != "" for item in raw):
        raise _CommandError(f"project {project}: agent_message_targets must be a list of non-empty strings")
    return list(raw)


def _is_remote(entry: Dict[str, Any]) -> bool:
    return str(entry.get("path") or "").startswith("remote:")


def _guest_count(entry: Dict[str, Any]) -> int:
    guests = entry.get("guest_user_ids")
    return len(guests) if isinstance(guests, list) else 0


def _allow(args: argparse.Namespace) -> int:
    source = args.source
    target = args.target
    guest_count = 0

    def apply(registry: Dict[str, Any]) -> None:
        nonlocal guest_count
        projects = registry.get("projects")
        if not isinstance(projects, dict):
            raise _CommandError("registry.json has no projects object")
        from_entry = projects.get(source)
        if not isinstance(from_entry, dict):
            raise _CommandError(f"unknown project: {source}")
        if _is_remote(from_entry):
            raise _CommandError(f"remote project cannot send Agent Requests: {source}")
        to_entry = projects.get(target)
        if not isinstance(to_entry, dict):
            raise _CommandError(f"unknown project: {target}")
        if _is_remote(to_entry):
            raise _CommandError(f"remote project cannot receive Agent Requests: {target}")
        guest_count = _guest_count(from_entry)
        targets = _targets_list(source, from_entry)
        if target in targets:
            raise _NoChange()
        from_entry["agent_message_targets"] = [*targets, target]

    changed = _locked_update(apply)
    if guest_count > 0:
        noun = "guest" if guest_count == 1 else "guests"
        print(
            f"Warning: {source} has {guest_count} {noun}; guests in {source} can trigger Agent Requests to {target}.",
            file=sys.stderr,
            flush=True,
        )
    if changed:
        print(f"Allowed Agent Requests: {source} -> {target}")
    else:
        print(f"Already allowed: {source} -> {target}")
    return 0


def _revoke(args: argparse.Namespace) -> int:
    source = args.source
    target = args.target

    def apply(registry: Dict[str, Any]) -> None:
        projects = registry.get("projects")
        if not isinstance(projects, dict):
            raise _CommandError("registry.json has no projects object")
        from_entry = projects.get(source)
        if not isinstance(from_entry, dict):
            raise _CommandError(f"unknown project: {source}")
        targets = _targets_list(source, from_entry)
        remaining = [item for item in targets if item != target]
        if len(remaining) == len(targets):
            raise _NoChange()
        if remaining:
            from_entry["agent_message_targets"] = remaining
        else:
            from_entry.pop("agent_message_targets", None)

    changed = _locked_update(apply)
    if changed:
        print(f"Revoked Agent Requests: {source} -> {target}")
    else:
        print(f"Nothing to remove: {source} -> {target} was not allowed.")
    return 0


def _read_projects() -> Dict[str, Any]:
    try:
        data = json.loads(_read_registry())
    except FileNotFoundError:
        fail(f"registry.json not found at {REGISTRY}")
    except ValueError as error:
        fail(f"registry.json is invalid JSON: {error}")
    except OSError as error:
        fail(str(error))
    projects = data.get("projects") if isinstance(data, dict) else None
    if not isinstance(projects, dict):
        fail("registry.json has no projects object")
    return projects


def _list(args: argparse.Namespace) -> int:
    projects = _read_projects()
    only: Optional[str] = args.project
    rows: List[Dict[str, Any]] = []
    for source, entry in projects.items():
        if not isinstance(entry, dict):
            continue
        try:
            targets = _targets_list(source, entry)
        except _CommandError as error:
            fail(str(error))
        for target in dict.fromkeys(targets):
            if only is not None and source != only and target != only:
                continue
            rows.append({"from": source, "to": target, "stale": target not in projects})

    if args.as_json:
        print(json.dumps(rows, indent=2, ensure_ascii=False))
        return 0
    for row in rows:
        suffix = " (stale)" if row["stale"] else ""
        print(f"{row['from']} -> {row['to']}{suffix}")
    return 0


def register(subparsers: argparse._SubParsersAction) -> None:
    parser = subparsers.add_parser("agent-messages", help="Manage Agent Message Grants between projects.")
    verbs = parser.add_subparsers(
        title="commands", metavar="<command>", dest="agent_messages_command", required=True
    )
    allow = verbs.add_parser("allow", help="Grant one project permission to send Agent Requests to another.")
    allow.add_argument("source", metavar="<from>", help="Sending project name.")
    allow.add_argument("target", metavar="<to>", help="Receiving project name.")
    allow.set_defaults(func=_allow)
    revoke = verbs.add_parser("revoke", help="Revoke one project's permission to send Agent Requests to another.")
    revoke.add_argument("source", metavar="<from>", help="Sending project name.")
    revoke.add_argument("target", metavar="<to>", help="Receiving project name.")
    revoke.set_defaults(func=_revoke)
    listing = verbs.add_parser("list", help="List Agent Message Grants.")
    listing.add_argument("project", nargs="?", help="Filter grants involving one project.")
    listing.add_argument("--json", dest="as_json", action="store_true", help="Print a JSON array.")
    listing.set_defaults(func=_list)
