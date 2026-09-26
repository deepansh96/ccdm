#!/usr/bin/env python3
"""Show whether one registered project supports observe-only reminder events."""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys


_EVENTS_PATH = Path(__file__).with_name("conversation-reminder-events.py")
_SPEC = importlib.util.spec_from_file_location("ccdm_conversation_reminder_events", _EVENTS_PATH)
if _SPEC is None or _SPEC.loader is None:
    raise RuntimeError("Conversation Reminder event receiver is unavailable")
_EVENTS = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_EVENTS)


def adapter_process_live(pid: object) -> bool:
    """True only while the recorded launch-scoped Claude channel adapter is running."""
    if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        pass
    try:
        ps = "/bin/ps" if os.path.exists("/bin/ps") else "ps"
        command = subprocess.run([ps, "-p", str(pid), "-ww", "-o", "command="], capture_output=True,
                                 text=True, timeout=5).stdout
    except (OSError, subprocess.SubprocessError):
        return False
    # A reused PID belongs to some other program, never the adapter.
    return "claude-reminder-channel.js" in command


def build_readiness(project_name: str, project_root: Path, state_dir: Path) -> dict:
    missing_credentials: list[str] = []
    assignment_mismatches: list[str] = []
    unsupported_capabilities: list[str] = []
    assignment_summary = None
    provider = "unknown"
    try:
        registry = _EVENTS.load_registry(project_root)
    except (OSError, json.JSONDecodeError, ValueError):
        registry = {}
        assignment_mismatches.append("registry.json is unavailable or invalid")
    try:
        assignment = _EVENTS.assignment_for(registry, project_name)
    except KeyError:
        assignment = None
        assignment_mismatches.append("project is not registered")
    except ValueError:
        assignment = None
        assignment_mismatches.append("project assignment is incomplete or ambiguous")
    if assignment:
        project = assignment["project"]
        provider = project.get("type") or "claude"
        assignment_summary = {
            "channel_id": assignment["channel_id"],
            "bot_id": assignment["bot_id"],
            "generation": assignment["generation"],
        }
        if provider not in {"codex", "claude"}:
            unsupported_capabilities.append(f"provider {provider} has no reminder adapter")
        if str(project.get("path") or "").startswith("remote:") and provider in {"codex", "claude"}:
            # Local events cannot prove an authenticated adapter on the remote host.
            unsupported_capabilities.append(
                f"remote {provider.capitalize()} adapter deployment is not verified by local readiness")
        if provider == "claude":
            try:
                capability = json.loads((state_dir / "capabilities" / f"{project_name}.json").read_text())
            except (OSError, json.JSONDecodeError):
                capability = {}
            verified = (
                capability.get("assignment_generation") == assignment["generation"]
                and capability.get("channel_id") == assignment["channel_id"]
                and capability.get("transport") == "official-discord-stdio-proxy"
                and capability.get("plugin_version") == "0.0.4"
                and capability.get("server_version") == "1.0.0"
                and capability.get("hooks_configured") is True
                and capability.get("reply_tool_verified") is True
            )
            relaunch = (f"; restart the session with CCDM_CLAUDE_REMINDER_ADAPTER=1 "
                        f"scripts/start-session.sh {project_name}")
            if not verified:
                unsupported_capabilities.append(
                    "Claude launch-scoped transport is not verified for this assignment" + relaunch)
            elif not adapter_process_live(capability.get("pid")):
                # A plain restart runs the unfiltered official plugin; an exited
                # adapter launch no longer filters /close or records completions.
                unsupported_capabilities.append(
                    "Claude launch-scoped transport is not running for this assignment" + relaunch)
        if not assignment["bot"].get("token"):
            missing_credentials.append("assigned_project_bot_token")
        if not assignment["bot"].get("app_id"):
            assignment_mismatches.append("assigned project bot app ID is missing")
        channel_matches = [
            name for name, candidate in (registry.get("projects") or {}).items()
            if isinstance(candidate, dict) and candidate.get("channel_id") == assignment["channel_id"]
        ]
        if len(channel_matches) != 1:
            assignment_mismatches.append("project channel assignment is ambiguous")

    receiver = _EVENTS.status_for(state_dir, project_name)
    if not receiver.get("available"):
        unsupported_capabilities.append("durable event receiver is unavailable")
    ready = not missing_credentials and not assignment_mismatches and not unsupported_capabilities
    return {
        "contract_version": 1,
        "project": project_name,
        "provider": provider,
        "status": "ready-observe-only" if ready else "blocked",
        "ready": ready,
        "delivery_enabled": False,
        "reminders_enabled": False,
        "missing_credentials": missing_credentials,
        "assignment_mismatches": assignment_mismatches,
        "unsupported_capabilities": unsupported_capabilities,
        "assignment": assignment_summary,
        "capabilities": {
            "scoped_reply_receipts": provider in {"codex", "claude"},
            "attachment_reply_receipts": provider in {"codex", "claude"},
            "successful_text_fallback_receipts": provider == "codex",
            "progress_input_needed_disposition": provider in {"codex", "claude"},
            "active_turn_resume_events": provider in {"codex", "claude"},
            "owner_activity_events": True,
            "exact_close_interception": True,
            "durable_event_replay": receiver.get("available", False),
        },
        "event_receiver": receiver,
        "events": receiver.get("events", []),
        "tested_runtime": {
            "bridge_contract": (
                "Claude Code 2.x from 2.1.281 command hooks and official Discord plugin 0.0.4 MCP stdio; local fake in the default E2E suite"
                if provider == "claude" else
                "Codex app-server JSON-RPC over WebSocket; local fake in the default E2E suite"
            ),
            "provider_login_used": False,
        },
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("project", help="registered project key")
    parser.add_argument("--project-root", type=Path, default=Path(__file__).resolve().parent.parent)
    parser.add_argument("--state-dir", type=Path, default=_EVENTS.default_state_dir())
    parser.add_argument("--json", action="store_true", help="print machine-readable status")
    args = parser.parse_args(argv)
    readiness = build_readiness(args.project, args.project_root.expanduser().resolve(), args.state_dir.expanduser())
    if args.json:
        print(json.dumps(readiness, sort_keys=True))
    else:
        print(f"{readiness['provider'].capitalize()} Conversation Reminder adapter: {readiness['status']}")
        print(f"Project: {readiness['project']}")
        print(f"Event receiver: {'available' if readiness['event_receiver']['available'] else 'unavailable'}")
        print("Reminder delivery: see scripts/conversation-reminder-service.py status")
        if readiness["missing_credentials"]:
            print("Missing credentials: " + ", ".join(readiness["missing_credentials"]))
        if readiness["assignment_mismatches"]:
            print("Assignment mismatch: " + "; ".join(readiness["assignment_mismatches"]))
        if readiness["unsupported_capabilities"]:
            print("Unsupported capabilities: " + "; ".join(readiness["unsupported_capabilities"]))
        print(f"Committed lifecycle events: {readiness['event_receiver']['event_count']}")
        print(f"Uncommitted events: {readiness['event_receiver']['pending_count']}")
    return 0 if readiness["ready"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
