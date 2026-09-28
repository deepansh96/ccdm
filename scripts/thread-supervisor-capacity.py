"""Live-session caps for Thread Conversations: what counts against a
provider's cap, which sessions are idle, and whether a start runs, evicts, or
waits in the queue. Channel Conversations are not thread rows, so they never
count."""

from __future__ import annotations

from datetime import datetime


DEFAULT_CAPS = {"claude": 6, "codex": 12}
# A session is idle once no turn runs and the owner has been quiet this long.
IDLE_SECONDS = 30 * 60
# Claude counts booting and live thread processes; Codex counts conversations
# loaded on any project's thread host, which are its booting and live rows.
LIVE_STATES = ("booting", "live")


def caps(registry: dict) -> dict:
    """The registry's `thread_session_caps`, each provider defaulting when absent or invalid."""
    configured = registry.get("thread_session_caps")
    configured = configured if isinstance(configured, dict) else {}
    return {provider: value if isinstance(value, int) and not isinstance(value, bool) and value > 0 else default
            for provider, default in DEFAULT_CAPS.items() for value in [configured.get(provider)]}


def parse(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def idle(row, now: str) -> bool:
    """No turn running and no owner activity for 30 minutes; a thread the owner
    never wrote in counts from its creation."""
    quiet_since = row["last_owner_activity_at"] or row["created_at"]
    return not row["turn_running"] and (parse(now) - parse(quiet_since)).total_seconds() >= IDLE_SECONDS


def admit(rows, provider_of, provider: str, cap: int, now: str, thread_id: str) -> dict:
    """Whether thread ``thread_id`` may start under ``provider``'s cap: `start`,
    `evict` the live idle session with the oldest activity (never one mid-turn
    or booting), or `queue` behind the ``busy`` sessions."""
    live = [row for row in rows if row["thread_id"] != thread_id and row["state"] in LIVE_STATES
            and provider_of(row) == provider]
    if len(live) < cap:
        return {"result": "start"}
    idle_rows = [row for row in live if row["state"] == "live" and idle(row, now)]
    if not idle_rows:
        return {"result": "queue", "busy": len(live)}
    activity = lambda row: max(parse(value) for value in (row["last_owner_activity_at"] or row["created_at"],
                                                          row["last_turn_end_at"]) if value)
    return {"result": "evict", "victim": min(idle_rows, key=lambda row: (activity(row), row["thread_id"]))}
