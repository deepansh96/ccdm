"""Creation: one flow for `/thread` in a project channel, `threads.sh create`, and a
channel agent's `create_thread` tool (the Router's `thread_create_request`).

The flags are validated against the registry first; a failure creates nothing.
Then a pending creation request is stored, the root bot creates the thread
(with the one-week archive duration), the request records its id, and a
notice in the thread lists the settings and any first message. Binding the
root bot's new thread through that request applies its overrides and, with a
first message, starts the session at once (binding.on_thread_create).
"""

from __future__ import annotations

import re
import sys
import uuid

from . import registry, store
from .clock import now
from .link import LinkError


FLAGS = ("provider", "account", "model", "effort")
PROVIDERS = ("claude", "codex")
EFFORTS = {
    "claude": ("low", "medium", "high", "xhigh", "max"),
    "codex": ("none", "minimal", "low", "medium", "high", "xhigh"),
}
MODEL = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/@+\[\]-]{0,99}$")
NAME_LIMIT = 100
USAGE = ("usage: /thread <name> [--provider claude|codex] [--account <alias>] [--model <model>] "
         "[--effort <effort>] [first message]")
FLAG = re.compile(r"--([^\s=]+)(?:=(\S+)|\s+(?!--)(\S+))?(?:\s+|$)")


class Invalid(Exception):
    """A request that creates nothing: `/thread` answers with a notice, the CLI exits 2."""


class Failed(Exception):
    """A valid request Discord did not fulfil."""


def parse_command(args: str) -> tuple[str, dict, str | None]:
    """`/thread`'s arguments: `<name> [--flag value]… [first message…]`. A
    name with spaces goes in double quotes."""
    rest = args.strip()
    if not rest:
        raise Invalid(USAGE)
    if rest.startswith('"'):
        end = rest.find('"', 1)
        if end < 0:
            raise Invalid("the thread name's closing quote is missing")
        name, rest = rest[1:end], rest[end + 1:]
    else:
        name, rest = (re.split(r"\s+", rest, maxsplit=1) + [""])[:2]
    flags: dict = {}
    rest = rest.lstrip()
    while rest.startswith("--"):
        match = FLAG.match(rest)
        flag = match.group(1) if match else rest.split()[0][2:]
        if flag not in FLAGS:
            raise Invalid(f"unknown flag --{flag}")
        value = match.group(2) or match.group(3)
        if not value:
            raise Invalid(f"--{flag} needs a value")
        flags[flag] = value
        rest = rest[match.end():]
    return name, flags, rest.strip() or None


def validate(current: dict, project: str | None, name: str | None, flags: dict) -> tuple[dict, dict]:
    """The project's entry and the request's overrides, or Invalid."""
    entry = registry.project(current, project) if isinstance(project, str) else None
    if not entry:
        raise Invalid(f"unknown project '{project}'")
    if not isinstance(name, str) or not name.strip() or len(name.strip()) > NAME_LIMIT:
        raise Invalid(f"the thread name must be 1-{NAME_LIMIT} characters")
    unknown = sorted(set(flags) - set(FLAGS))
    if unknown:
        raise Invalid(f"unknown flag --{unknown[0]}")
    overrides = {field: flags.get(field) or None for field in FLAGS}
    if overrides["provider"] is not None and overrides["provider"] not in PROVIDERS:
        raise Invalid(f"provider '{overrides['provider']}' is not claude or codex")
    provider = overrides["provider"] or entry.get("type") or "claude"
    if overrides["account"] is not None and overrides["account"] not in registry.accounts(current, provider):
        raise Invalid(f"'{overrides['account']}' is not an account alias in {provider}_accounts")
    if overrides["model"] is not None and not MODEL.match(overrides["model"]):
        raise Invalid(f"model '{overrides['model']}' is not a valid model name")
    allowed = EFFORTS.get(provider, ())
    if overrides["effort"] is not None and overrides["effort"] not in allowed:
        raise Invalid(f"effort '{overrides['effort']}' is not valid for {provider} (expected {', '.join(allowed)})")
    return entry, overrides


def settings_text(resolved: dict, first_message: str | None) -> str:
    settings = " · ".join(f"{field} {resolved[field] or 'default'}" for field in FLAGS)
    tail = f"First message: {first_message}" if first_message else "Send a message here to start the session."
    return f"Thread settings: {settings}\n{tail}"


def create(context, project: str | None, name: str | None, flags: dict, first_message: str | None, requester_id: str,
           requester_kind: str) -> dict:
    """Run the creation flow; raises Invalid before anything is created, or Failed."""
    current = registry.load(context.project_root)
    entry, overrides = validate(current, project, name, flags)
    name = name.strip()
    first_message = (first_message or "").strip() or None
    request_id = str(uuid.uuid4())
    store.add_request(context.db, request_id, project, name, overrides, first_message, requester_id, requester_kind,
                      now())
    try:
        created = context.link.call("thread_create", {"channel_id": str(entry.get("channel_id") or ""), "name": name})
        thread_id = str((created or {}).get("id") or "")
        if not thread_id:
            raise LinkError("thread_create_failed", "thread_create returned no thread id")
    except LinkError as error:
        store.update_request(context.db, request_id, status="failed")
        raise Failed(f"the thread could not be created: {error.code}") from error
    store.update_request(context.db, request_id, thread_id=thread_id)
    resolved = registry.resolved_settings(entry, overrides)
    try:
        context.link.call("thread_notice", {"channel_id": thread_id, "text": settings_text(resolved, first_message)})
    except LinkError as error:
        print(f"thread-supervisor: thread {thread_id}: the settings notice failed: {error.code}",
              file=sys.stderr, flush=True)
    return {"request_id": request_id, "thread_id": thread_id, "project": project, "name": name, **resolved}


def on_channel_command(context, event: dict) -> None:
    """`/thread` from the owner or a guest in a project channel; other channel commands are not handled here."""
    if event.get("command") != "thread":
        return
    author = event.get("author") or {}
    try:
        name, flags, first_message = parse_command(str(event.get("args") or ""))
        create(context, event.get("project"), name, flags, first_message, str(author.get("id") or ""),
               "owner" if author.get("is_owner") else "guest")
    except (Invalid, Failed) as error:
        try:
            context.link.call("thread_notice", {"channel_id": event.get("channel_id"),
                                                "text": f"Thread not created: {error}"})
        except LinkError as notice_error:
            print(f"thread-supervisor: the /thread refusal notice failed: {notice_error.code}",
                  file=sys.stderr, flush=True)


def on_create_request(context, event: dict) -> None:
    """A channel agent's `create_thread`, in its own channel: always answered
    with `thread_request_done`, the thread id or the op error the tool returns."""
    project = event.get("project")
    flags = {field: event[field] for field in FLAGS if event.get(field) is not None}
    try:
        result = create(context, project, event.get("name"), flags, event.get("first_message"), str(project),
                        "channel-agent")
        done = {"ok": True, "thread_id": result["thread_id"]}
    except Invalid as error:
        done = {"ok": False, "error": {"code": "invalid", "message": str(error)}}
    except Exception as error:  # The waiting tool must hear back, whatever failed.
        done = {"ok": False, "error": {"code": "thread_create_failed", "message": str(error)}}
    try:
        context.link.call("thread_request_done", {"request_id": event.get("request_id"), **done})
    except LinkError as error:
        print(f"thread-supervisor: create_thread {event.get('request_id')}: thread_request_done failed: {error.code}",
              file=sys.stderr, flush=True)
