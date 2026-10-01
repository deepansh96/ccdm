"""The event table: one handler per Router event or worker-internal frame; others are ignored.

After each one, any slot it freed goes to the queue."""

from __future__ import annotations

import sys

from . import binding, boot, capacity, commands, config, control, creation, lifecycle, projects, reconcile


HANDLERS = {
    "channel_command": creation.on_channel_command,
    "gateway_resumed": reconcile.reconcile,
    "thread_create": binding.on_thread_create,
    "thread_command": commands.on_thread_command,
    "thread_create_request": creation.on_create_request,
    "thread_delete": lifecycle.on_thread_delete,
    "thread_message": boot.on_thread_message,
    "thread_reaction": config.on_thread_reaction,
    "thread_session_live": boot.on_session_live,
    "thread_update": lifecycle.on_thread_update,
}
# Frames the worker posts itself, never the Router.
INTERNAL_HANDLERS = {
    "archive_poll": lifecycle.on_archive_poll,
    "control": control.on_control,
    "launch_exit": boot.on_launch_exit,
    "reconcile": reconcile.reconcile,
    "registry": projects.on_registry,
}


def dispatch(context, event: dict) -> None:
    table = INTERNAL_HANDLERS if event.get("type") == "internal" else HANDLERS
    handler = table.get(event.get("event"))
    if handler is None:
        return
    try:
        handler(context, event)
    except Exception as error:  # One bad event must not stop the worker.
        print(f"thread-supervisor: {event.get('event')} failed: {error}", file=sys.stderr, flush=True)
    try:
        capacity.drain(context)
    except Exception as error:
        print(f"thread-supervisor: draining the queue failed: {error}", file=sys.stderr, flush=True)
