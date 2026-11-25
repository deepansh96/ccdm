"""`ccdm agent-messages allow|revoke|list|log`: manage Agent Message Grants and inspect history."""

from __future__ import annotations

import argparse
from datetime import datetime
import importlib.util
import json
import os
import sys
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

from ..platform.paths import state_root
from .list import REGISTRY, _read_registry, fail

_REGISTRY_UPDATE_SCRIPT = Path(__file__).resolve().parents[2] / "registry-update.py"
_LEDGER_FILENAME = "agent-messages.jsonl"
_LEDGER_VERSION = 1
_DEFAULT_LOG_LIMIT = 50
_KNOWN_RECORD_TYPES = frozenset((
    "request",
    "refusal",
    "post",
    "post_chunk",
    "delivery",
    "ack",
    "reply",
    "expired",
    "failed",
    "mark",
))
_VALID_OPS = frozenset(("agent_request", "agent_reply"))
_VALID_POST_KINDS = frozenset(("request", "reply"))
_VALID_POST_SIDES = frozenset(("sender", "receiver"))
_VALID_DELIVERY_KINDS = frozenset(("request", "reply", "notice"))


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


def _ledger_path() -> Path:
    router_state = os.environ.get("CCDM_ROUTER_STATE_DIR")
    base = Path(router_state) if router_state else (state_root() / "router")
    return base / _LEDGER_FILENAME


def _is_non_empty_str(value: Any) -> bool:
    return isinstance(value, str) and value.strip() != ""


def _is_valid_iso(value: Any) -> bool:
    if not isinstance(value, str) or not value:
        return False
    normalized = f"{value[:-1]}+00:00" if value.endswith("Z") else value
    try:
        datetime.fromisoformat(normalized)
    except ValueError:
        return False
    return True


def _is_valid_conversation(value: Any) -> bool:
    return (
        isinstance(value, dict)
        and _is_non_empty_str(value.get("project"))
        and _is_non_empty_str(value.get("provider"))
        and _is_non_empty_str(value.get("conversation_id"))
    )


def _validate_ledger_record(record: Any) -> Optional[str]:
    if not isinstance(record, dict):
        return "record must be a JSON object"
    version = record.get("v")
    if isinstance(version, bool) or version != _LEDGER_VERSION:
        return f"unsupported ledger version: {version}"
    if not _is_valid_iso(record.get("at")):
        return "missing or invalid timestamp"
    rec_type = record.get("type")
    if not _is_non_empty_str(rec_type):
        return "missing record type"
    if rec_type not in _KNOWN_RECORD_TYPES:
        return None

    if rec_type == "request":
        if not _is_non_empty_str(record.get("request_id")):
            return "request missing request_id"
        if not _is_valid_conversation(record.get("from")) or not _is_valid_conversation(record.get("to")):
            return "request missing conversation"
        if not _is_non_empty_str(record.get("from_launch")) or not _is_non_empty_str(record.get("to_launch")):
            return "request missing launch"
        if not isinstance(record.get("text"), str):
            return "request missing text"
        depth = record.get("depth")
        if isinstance(depth, bool) or not isinstance(depth, int) or depth < 1:
            return "request invalid depth"
        if not _is_valid_iso(record.get("expires_at")):
            return "request invalid expires_at"
        if not _is_non_empty_str(record.get("idempotency_key")):
            return "request missing idempotency_key"
        return None
    if rec_type == "refusal":
        if not _is_non_empty_str(record.get("refusal_id")):
            return "refusal missing refusal_id"
        if record.get("op") not in _VALID_OPS:
            return "refusal invalid op"
        if not _is_valid_conversation(record.get("from")):
            return "refusal missing from"
        if not _is_non_empty_str(record.get("code")) or not isinstance(record.get("message"), str):
            return "refusal missing code or message"
        if not _is_non_empty_str(record.get("from_launch")) or not _is_non_empty_str(record.get("idempotency_key")):
            return "refusal missing key"
        return None
    if rec_type == "post":
        if not _is_non_empty_str(record.get("request_id")):
            return "post missing request_id"
        if record.get("kind") not in _VALID_POST_KINDS or record.get("side") not in _VALID_POST_SIDES:
            return "post invalid kind or side"
        if not _is_non_empty_str(record.get("channel_id")):
            return "post missing channel_id"
        return None
    if rec_type == "post_chunk":
        if not _is_non_empty_str(record.get("request_id")):
            return "post_chunk missing request_id"
        if record.get("kind") not in _VALID_POST_KINDS or record.get("side") not in _VALID_POST_SIDES:
            return "post_chunk invalid kind or side"
        if not _is_non_empty_str(record.get("channel_id")):
            return "post_chunk missing channel_id"
        chunk_index = record.get("chunk_index")
        if isinstance(chunk_index, bool) or not isinstance(chunk_index, int) or chunk_index < 0:
            return "post_chunk invalid chunk_index"
        chunk_count = record.get("chunk_count")
        if (
            isinstance(chunk_count, bool)
            or not isinstance(chunk_count, int)
            or chunk_count < 1
            or chunk_index >= chunk_count
        ):
            return "post_chunk invalid chunk_count"
        if not _is_non_empty_str(record.get("message_id")):
            return "post_chunk missing message_id"
        return None
    if rec_type == "delivery":
        if not _is_non_empty_str(record.get("delivery_id")):
            return "delivery missing delivery_id"
        if record.get("kind") not in _VALID_DELIVERY_KINDS:
            return "delivery invalid kind"
        if not _is_non_empty_str(record.get("request_id")):
            return "delivery missing request_id"
        if not _is_valid_conversation(record.get("to")) or not _is_non_empty_str(record.get("to_launch")):
            return "delivery missing target"
        return None
    if rec_type == "ack":
        if not _is_non_empty_str(record.get("delivery_id")) or not _is_non_empty_str(record.get("request_id")):
            return "ack missing id"
        return None
    if rec_type == "reply":
        if not _is_non_empty_str(record.get("request_id")):
            return "reply missing request_id"
        if not _is_valid_conversation(record.get("from")) or not _is_valid_conversation(record.get("to")):
            return "reply missing conversation"
        if not _is_non_empty_str(record.get("from_launch")) or not isinstance(record.get("text"), str):
            return "reply missing body"
        if not _is_non_empty_str(record.get("idempotency_key")):
            return "reply missing idempotency_key"
        if not isinstance(record.get("delivered_to_live_session"), bool):
            return "reply missing delivered_to_live_session"
        return None
    if rec_type in ("expired", "failed"):
        if not _is_non_empty_str(record.get("request_id")):
            return f"{rec_type} missing request_id"
        return None
    if rec_type == "mark":
        if not _is_non_empty_str(record.get("request_id")):
            return "mark missing request_id"
        if record.get("side") not in _VALID_POST_SIDES:
            return "mark invalid side"
        if not _is_non_empty_str(record.get("emoji")):
            return "mark missing emoji"
        return None
    return f"unknown record type: {rec_type}"


def _read_ledger_records(path: Path) -> Tuple[List[Dict[str, Any]], List[int]]:
    try:
        raw = path.read_bytes()
    except FileNotFoundError:
        return [], []
    except OSError as error:
        fail(f"could not read agent message ledger at {path}: {error}")

    if raw == b"":
        return [], []

    has_trailing_newline = raw.endswith(b"\n")
    lines = raw.split(b"\n")
    if has_trailing_newline:
        lines.pop()

    records: List[Dict[str, Any]] = []
    skipped_lines: List[int] = []
    for index, raw_line in enumerate(lines):
        line_bytes = raw_line[:-1] if raw_line.endswith(b"\r") else raw_line
        is_unterminated_final = not has_trailing_newline and index == len(lines) - 1
        if line_bytes == b"":
            fail(f"agent message ledger invalid empty line {index + 1}")
        try:
            line = line_bytes.decode("utf-8")
            parsed = json.loads(line)
        except (UnicodeDecodeError, ValueError) as error:
            if is_unterminated_final and (line_bytes == b"{" or line_bytes.startswith(b'{"')):
                break
            fail(f"corrupt agent message ledger line {index + 1}: {error}")
        problem = _validate_ledger_record(parsed)
        if problem is not None:
            fail(f"invalid agent message ledger line {index + 1}: {problem}")
        if parsed["type"] not in _KNOWN_RECORD_TYPES:
            skipped_lines.append(index + 1)
            continue
        records.append(parsed)
    return records, skipped_lines


def _public_conversation(conv: Dict[str, Any]) -> Dict[str, Any]:
    out: Dict[str, Any] = {
        "project": conv["project"],
        "provider": conv["provider"],
        "conversation_id": conv["conversation_id"],
    }
    if conv.get("thread_id"):
        out["thread_id"] = conv["thread_id"]
        out["thread_name"] = conv.get("thread_name")
    return out


def _format_conversation(conv: Optional[Dict[str, Any]], fallback_target: Optional[str] = None) -> str:
    if conv is None:
        return fallback_target if fallback_target else "-"
    if conv.get("thread_id"):
        name = conv.get("thread_name")
        if name:
            return f"{conv['project']}/{conv['thread_id']} ({name})"
        return f"{conv['project']}/{conv['thread_id']}"
    return str(conv["project"])


def _build_log_entries(records: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    exchanges: Dict[str, Dict[str, Any]] = {}
    entries: List[Dict[str, Any]] = []

    for record in records:
        rec_type = record["type"]
        if rec_type == "request":
            entry: Dict[str, Any] = {
                "kind": "exchange",
                "request_id": record["request_id"],
                "from": _public_conversation(record["from"]),
                "to": _public_conversation(record["to"]),
                "opened_at": record["at"],
                "expires_at": record["expires_at"],
                "ended_at": None,
                "depth": record["depth"],
                "outcome": "open",
                "_text": record["text"],
                "_reply": None,
                "_reason": None,
            }
            exchanges[record["request_id"]] = entry
            entries.append(entry)
        elif rec_type == "reply":
            exchange = exchanges.get(record["request_id"])
            if exchange is not None:
                exchange["outcome"] = "replied"
                exchange["ended_at"] = record["at"]
                exchange["_reply"] = {
                    "at": record["at"],
                    "from": _public_conversation(record["from"]),
                    "to": _public_conversation(record["to"]),
                    "delivered_to_live_session": record["delivered_to_live_session"],
                    "_text": record["text"],
                }
        elif rec_type == "expired":
            exchange = exchanges.get(record["request_id"])
            if exchange is not None:
                exchange["outcome"] = "expired"
                exchange["ended_at"] = record["at"]
        elif rec_type == "failed":
            exchange = exchanges.get(record["request_id"])
            if exchange is not None:
                exchange["outcome"] = "failed"
                exchange["ended_at"] = record["at"]
                if isinstance(record.get("reason"), str) and record["reason"]:
                    exchange["_reason"] = record["reason"]
        elif rec_type == "refusal":
            to_raw = record.get("to")
            refusal_entry: Dict[str, Any] = {
                "kind": "refusal",
                "refusal_id": record["refusal_id"],
                "request_id": record.get("request_id"),
                "op": record["op"],
                "from": _public_conversation(record["from"]),
                "to": _public_conversation(to_raw) if _is_valid_conversation(to_raw) else None,
                "target": record.get("target"),
                "at": record["at"],
                "outcome": "refused",
                "code": record["code"],
                "message": record["message"],
            }
            entries.append(refusal_entry)

    return entries


def _serialize_log_entry(entry: Dict[str, Any], include_text: bool) -> Dict[str, Any]:
    if entry["kind"] == "refusal":
        out: Dict[str, Any] = {
            "kind": "refusal",
            "refusal_id": entry["refusal_id"],
            "request_id": entry["request_id"],
            "op": entry["op"],
            "from": entry["from"],
            "to": entry["to"],
            "at": entry["at"],
            "outcome": "refused",
            "code": entry["code"],
            "message": entry["message"],
        }
        if entry["target"] is not None:
            out["target"] = entry["target"]
        return out

    out = {
        "kind": "exchange",
        "request_id": entry["request_id"],
        "from": entry["from"],
        "to": entry["to"],
        "opened_at": entry["opened_at"],
        "expires_at": entry["expires_at"],
        "ended_at": entry["ended_at"],
        "depth": entry["depth"],
        "outcome": entry["outcome"],
    }
    if include_text:
        out["text"] = entry["_text"]
    if entry["_reply"] is not None:
        reply_obj: Dict[str, Any] = {
            "at": entry["_reply"]["at"],
            "from": entry["_reply"]["from"],
            "to": entry["_reply"]["to"],
            "delivered_to_live_session": entry["_reply"]["delivered_to_live_session"],
        }
        if include_text:
            reply_obj["text"] = entry["_reply"]["_text"]
        out["reply"] = reply_obj
    if entry["_reason"] is not None:
        out["reason"] = entry["_reason"]
    return out


def _format_indented_text(label: str, text: str) -> List[str]:
    text_lines = text.splitlines() or [""]
    lines = [f"  {label}: {text_lines[0]}"]
    for continuation in text_lines[1:]:
        lines.append(f"    {continuation}")
    return lines


def _format_log_entry_text(entry: Dict[str, Any], include_text: bool) -> List[str]:
    if entry["kind"] == "refusal":
        identifier = entry["request_id"] or entry["refusal_id"]
        route = f"{_format_conversation(entry['from'])} -> {_format_conversation(entry['to'], entry['target'])}"
        parts = [entry["at"], identifier, route, "refused"]
        if entry["op"] == "agent_reply":
            parts.append("op=agent_reply")
        parts.append(f"code={entry['code']}")
        return ["  ".join(parts)]

    route = f"{_format_conversation(entry['from'])} -> {_format_conversation(entry['to'])}"
    parts = [entry["opened_at"], entry["request_id"], route, entry["outcome"]]
    if entry["outcome"] == "replied" and entry["ended_at"]:
        parts.append(f"replied_at={entry['ended_at']}")
    elif entry["outcome"] in ("expired", "failed") and entry["ended_at"]:
        parts.append(f"ended_at={entry['ended_at']}")
        if entry["_reason"]:
            parts.append(f"reason={entry['_reason']}")
    elif entry["outcome"] == "open":
        parts.append(f"expires_at={entry['expires_at']}")
    lines = ["  ".join(parts)]
    if include_text:
        lines.extend(_format_indented_text("request", entry["_text"]))
        if entry["_reply"] is not None:
            lines.extend(_format_indented_text("reply", entry["_reply"]["_text"]))
    return lines


def _target_project(entry: Dict[str, Any]) -> Optional[str]:
    to_conv = entry.get("to")
    if isinstance(to_conv, dict):
        return str(to_conv["project"])
    raw_target = entry.get("target")
    if isinstance(raw_target, str) and raw_target and not raw_target.startswith(("http://", "https://")):
        return raw_target.split("/", 1)[0]
    return None


def _matches_project(entry: Dict[str, Any], project: str) -> bool:
    return entry["from"]["project"] == project or _target_project(entry) == project


def _filter_log_entries(
    entries: List[Dict[str, Any]],
    *,
    project: Optional[str],
    request_id: Optional[str],
    limit: int,
) -> List[Dict[str, Any]]:
    filtered = entries
    if request_id is not None:
        exchanges = [entry for entry in filtered if entry["kind"] == "exchange" and entry["request_id"] == request_id]
        if exchanges:
            filtered = exchanges[:1]
        else:
            filtered = [
                entry
                for entry in filtered
                if entry.get("request_id") == request_id or entry.get("refusal_id") == request_id
            ]
    if project is not None:
        filtered = [entry for entry in filtered if _matches_project(entry, project)]
    if len(filtered) > limit:
        filtered = filtered[-limit:]
    return filtered


def _log(args: argparse.Namespace) -> int:
    if args.limit < 1:
        fail("--limit must be a positive integer")
    records, skipped_lines = _read_ledger_records(_ledger_path())
    entries = _filter_log_entries(
        _build_log_entries(records),
        project=args.project,
        request_id=args.request_id,
        limit=args.limit,
    )
    if args.as_json:
        serialized = [_serialize_log_entry(entry, args.include_text) for entry in entries]
        print(json.dumps(serialized, indent=2, ensure_ascii=False))
    else:
        for entry in entries:
            for line in _format_log_entry_text(entry, args.include_text):
                print(line)
    if skipped_lines:
        count = len(skipped_lines)
        noun = "record" if count == 1 else "records"
        line_label = "line" if count == 1 else "lines"
        line_numbers = ", ".join(str(num) for num in skipped_lines)
        print(
            f"Note: skipped {count} unknown ledger {noun} ({line_label} {line_numbers}); "
            "the running Router refuses a ledger with unknown record types, so Agent Message sends "
            "may be failing with ledger_unavailable — check `router status` for ledger health.",
            file=sys.stderr,
            flush=True,
        )
    return 0


def register(subparsers: argparse._SubParsersAction) -> None:
    parser = subparsers.add_parser("agent-messages", help="Manage Agent Message Grants and inspect history.")
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
    log_parser = verbs.add_parser("log", help="Print Agent Message exchange history from the Router ledger.")
    log_parser.add_argument("--project", help="Show only entries where this project is sender or target.")
    log_parser.add_argument("--request", dest="request_id", help="Show one exchange by request ID.")
    log_parser.add_argument("--limit", type=int, default=_DEFAULT_LOG_LIMIT, help="Maximum entries to print (default: 50).")
    log_parser.add_argument("--text", dest="include_text", action="store_true", help="Include message text.")
    log_parser.add_argument("--json", dest="as_json", action="store_true", help="Print a JSON array.")
    log_parser.set_defaults(func=_log)
