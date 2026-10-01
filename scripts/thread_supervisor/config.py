"""`/config`: a thread's provider, account, model and effort.

In a thread it is the owner's. With no arguments it lists the four settings
and where each comes from, the thread's override or the project. `model=` and
`effort=` are validated by `/thread`'s rules, saved as the thread's overrides,
and a running session restarts into the same provider conversation.
`provider=` and `account=` start a fresh conversation, so they only post a
warning with ✅ on it and store `pending_config`, which any later `/config`
with arguments drops; the owner's ✅ on that exact
message (a `thread_reaction`) applies the whole change, clears
`provider_conversation_id`, and starts a running session afresh. In a
project channel it only lists the project's settings, which new threads
inherit.
"""

from __future__ import annotations

import json
import sys

from . import boot, creation, lifecycle, registry, reminders, store
from .clock import now
from .link import LinkError


FIELDS = ("provider", "account", "model", "effort")
OWNER_ONLY = "Only the owner can change this thread's settings."
RESTARTING = "Restarting this thread's session."
FRESH_START = "Starting a fresh conversation in this thread."
CHECK = "✅"
# Changing these starts a fresh provider conversation.
FRESH = ("provider", "account")
# A session in these states is restarted to take a change.
RUNNING = ("booting", "live")


class Invalid(Exception):
    """A `/config` that changes nothing."""


def parse(args: str) -> dict:
    """`field=value` pairs, in any order."""
    changes = {}
    for token in args.split():
        field, _, value = token.partition("=")
        if field not in FIELDS:
            raise Invalid(f"unknown setting {field} (expected provider, account, model or effort)")
        if not value:
            raise Invalid(f"{field} needs a value, as {field}=<value>")
        changes[field] = value
    return changes


def _log(message: str) -> None:
    print(f"thread-supervisor: {message}", file=sys.stderr, flush=True)


def _notice(context, channel_id: str, text: str) -> dict:
    try:
        return context.link.call("thread_notice", {"channel_id": channel_id, "text": text}) or {}
    except LinkError as error:
        _log(f"{channel_id}: the /config notice failed: {error.code}")
        return {}


def project_account(current: dict, entry: dict, provider: str) -> str | None:
    """The project's account alias for ``provider``; a Claude project names a home path, never shown."""
    if provider != "codex":
        return None
    alias = entry.get("codex_account") or current.get("default_codex_account")
    return alias if isinstance(alias, str) and alias else None


def settings_lines(current: dict, entry: dict, overrides, sources: bool = True) -> list[str]:
    """One `field: value` line per setting, each with its source when ``sources`` is set."""
    resolved = registry.resolved_settings(entry, overrides)
    resolved["account"] = resolved["account"] or project_account(current, entry, resolved["provider"])
    return [f"{field}: {resolved[field] or 'default'}"
            + (f" ({'thread' if overrides[field] else 'project'})" if sources else "") for field in FIELDS]


def on_channel_config(context, event: dict) -> None:
    current = registry.load(context.project_root)
    entry = registry.project(current, str(event.get("project")))
    channel_id = event.get("channel_id")
    if not entry or not isinstance(channel_id, str):
        return
    lines = settings_lines(current, entry, dict.fromkeys(FIELDS), sources=False)
    refusal = ["/config does not change channel settings."] if str(event.get("args") or "").strip() else []
    _notice(context, channel_id, "\n".join([*refusal, "Settings new threads in this channel inherit:", *lines]))


def on_thread_config(context, row, owner: bool, event: dict) -> None:
    thread_id = row["thread_id"]
    if not owner:
        return _notice(context, thread_id, OWNER_ONLY)
    current = registry.load(context.project_root)
    entry = registry.project(current, row["project"])
    if not entry:
        return
    args = str(event.get("args") or "").strip()
    if not args:
        return _notice(context, thread_id, "\n".join(["Thread settings:", *settings_lines(current, entry, row)]))
    # A new change request supersedes any pending one: a ✅ on the old warning applies nothing.
    if row["pending_config"]:
        store.update(context.db, thread_id, pending_config=None)
    try:
        changes = parse(args)
        creation.validate(current, row["project"], row["name"], {**{field: row[field] for field in FIELDS}, **changes})
    except (Invalid, creation.Invalid) as error:
        return _notice(context, thread_id, f"Settings not changed: {error}")
    listed = " · ".join(f"{field} {value}" for field, value in changes.items())
    if not any(field in changes for field in FRESH):
        return _apply(context, row, changes, f"Settings saved: {listed}.")
    warning = _notice(context, thread_id, f"Changing {listed} starts a fresh conversation in this thread. "
                                          f"React {CHECK} to this message to apply it.")
    message_id = warning.get("message_id")
    if not message_id:
        return
    store.update(context.db, thread_id, pending_config=json.dumps({"message_id": message_id, "changes": changes,
                                                                   "requested_at": now()}))
    try:
        context.link.call("thread_react", {"channel_id": thread_id, "message_id": message_id, "emoji": CHECK})
    except LinkError as error:
        _log(f"thread {thread_id}: adding {CHECK} to the /config warning failed: {error.code}")


def on_thread_reaction(context, event: dict) -> None:
    """Only the owner's ✅ on the pending warning itself applies a pending change."""
    thread_id = event.get("thread_id")
    if event.get("emoji") != CHECK or not (event.get("user") or {}).get("is_owner") or not isinstance(thread_id, str):
        return
    row = store.thread(context.db, thread_id)
    if not row or row["project"] != event.get("project") or not row["pending_config"]:
        return
    try:
        pending = json.loads(row["pending_config"])
    except json.JSONDecodeError:
        pending = {}
    if not pending.get("message_id") or pending.get("message_id") != event.get("message_id"):
        return
    changes = {field: value for field, value in (pending.get("changes") or {}).items() if field in FIELDS}
    store.update(context.db, thread_id, pending_config=None)
    current = registry.load(context.project_root)
    try:
        creation.validate(current, row["project"], row["name"], {**{field: row[field] for field in FIELDS}, **changes})
    except creation.Invalid as error:  # The registry changed since the warning.
        return _notice(context, thread_id, f"Settings not changed: {error}")
    listed = " · ".join(f"{field} {value}" for field, value in changes.items())
    _apply(context, row, changes, f"Settings saved: {listed}.", fresh=True)


def _apply(context, row, changes: dict, saved: str, fresh: bool = False) -> None:
    """Save ``changes`` and restart a running session, into the same conversation
    or, when ``fresh``, a new one."""
    thread_id = row["thread_id"]
    running = row["state"] in RUNNING
    if running:
        context.archive_polls.pop(thread_id, None)
        lifecycle.stop_session(context, row)
    store.update(context.db, thread_id, **changes, **({"provider_conversation_id": None} if fresh else {}))
    if fresh:
        reminders.emit(context, "conversation_reset", row)
    if not running:
        return _notice(context, thread_id, f"{saved} The next session uses them.")
    _notice(context, thread_id, f"{saved} {FRESH_START if fresh else RESTARTING}")
    boot.start(context, store.thread(context.db, thread_id), None, starter="")
