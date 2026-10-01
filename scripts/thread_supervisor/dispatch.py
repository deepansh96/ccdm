"""The event table: one handler per Router event or worker-internal frame; others are ignored."""

from __future__ import annotations

import sys

from . import binding, boot, control, creation


HANDLERS = {
    "channel_command": creation.on_channel_command,
    "thread_create": binding.on_thread_create,
    "thread_message": boot.on_thread_message,
    "thread_session_live": boot.on_session_live,
}
# Frames the worker posts itself, never the Router.
INTERNAL_HANDLERS = {
    "control": control.on_control,
    "launch_exit": boot.on_launch_exit,
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
