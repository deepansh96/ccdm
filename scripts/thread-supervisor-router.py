"""Decides whether a Discord thread event belongs to a registered project."""

from __future__ import annotations


PUBLIC_THREAD = 11
# Discord channel types of a thread's parent: 0 is a text channel. Forum (15)
# and media (16) posts are threads too, but never Thread Conversations.
TEXT_PARENT_TYPES = {None, 0}


def project_for_channel(registry: dict, channel_id: str) -> tuple[str, dict] | None:
    """Return the only registered project whose channel is ``channel_id``."""
    projects = registry.get("projects")
    if not isinstance(projects, dict) or not channel_id:
        return None
    matches = [(name, project) for name, project in projects.items()
               if isinstance(project, dict) and str(project.get("channel_id") or "") == channel_id]
    return matches[0] if len(matches) == 1 else None


def eligible_creator(registry: dict, project: dict, creator_id: str) -> bool:
    guests = project.get("guest_user_ids") or []
    allowed = {str(registry.get("discord_user_id") or "")} | {str(guest) for guest in guests}
    return bool(creator_id) and creator_id in allowed


def route_thread_create(registry: dict, event: dict) -> dict:
    """Bind a newly seen thread to its project, or say why it is ignored.

    The parent check happens here, once; afterwards the stored binding names
    the project. Bot-created threads bind only through a pending creation
    request, which a later slice adds."""
    if event.get("type") != PUBLIC_THREAD:
        return {"route": "ignore", "reason": "not-public-thread"}
    if event.get("parent_type") not in TEXT_PARENT_TYPES:
        return {"route": "ignore", "reason": "unsupported-parent"}
    found = project_for_channel(registry, str(event.get("parent_id") or ""))
    if not found:
        return {"route": "ignore", "reason": "unregistered-parent"}
    name, project = found
    if str(project.get("path") or "").startswith("remote:"):
        return {"route": "ignore", "reason": "remote-project"}
    if not eligible_creator(registry, project, str(event.get("creator_id") or "")):
        return {"route": "ignore", "reason": "ineligible-creator"}
    return {"route": "bind", "project": name, "bot_id": project.get("bot_id")}
