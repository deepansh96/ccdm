"""The Router event table: one handler per supervisor event; others are ignored."""

from __future__ import annotations

import sys

from . import binding


HANDLERS = {
    "thread_create": binding.on_thread_create,
}


def dispatch(context, event: dict) -> None:
    handler = HANDLERS.get(event.get("event"))
    if handler is None:
        return
    try:
        handler(context, event)
    except Exception as error:  # One bad event must not stop the worker.
        print(f"thread-supervisor: {event.get('event')} failed: {error}", file=sys.stderr, flush=True)
