"""Bounded, checkpointed history discovery for Project Conversations.

The service owns this state machine; the observer only performs the Discord
reads it requests. Each channel establishes a watermark, pages backward until
the owner's latest participation is found (or history starts), reconciles
forward through the newest message, and checks reaction membership before the
historical baseline is committed. Only message IDs, timestamps, message kinds,
and emoji identifiers are persisted; message bodies never reach this store.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
import json
import sqlite3

PAGE_LIMIT = 100
PAGES_PER_PASS = 10
REACTIONS_PER_PASS = 10
PASS_SECONDS = 30
TRANSIENT_RETRY_SECONDS = 30
DENIED_RETRY_SECONDS = 300
MAX_TAIL = 100
# Channels whose live events are durably buffered until the scan commits.
ACTIVE = {"discovering", "suspended-discovery-history"}
STARTABLE = {"suspended-incomplete-discovery", *ACTIVE}
OWNER_KINDS = {"owner-message", "owner-command", "owner-close"}
MESSAGE_KINDS = OWNER_KINDS | {"bot", "command-output", "guest", "other"}
APPROXIMATION = "historical-owner-then-bot-approximation"
LIMITATION = ("Historical messages carry no turn-completion metadata; the owner-then-assigned-bot "
              "ordering approximates a completed answer and is used only for discovery.")

SCHEMA = """
    CREATE TABLE discoveries (
        project TEXT NOT NULL, assignment_generation TEXT NOT NULL, phase TEXT NOT NULL,
        started_revision INTEGER NOT NULL, watermark_id TEXT, before_id TEXT, after_id TEXT,
        summary_json TEXT NOT NULL, pages_total INTEGER NOT NULL DEFAULT 0,
        reactions_total INTEGER NOT NULL DEFAULT 0, passes INTEGER NOT NULL DEFAULT 0,
        pass_key INTEGER, pass_pages INTEGER NOT NULL DEFAULT 0,
        pass_reactions INTEGER NOT NULL DEFAULT 0, last_seq INTEGER NOT NULL DEFAULT 0,
        pending_request TEXT, retry_at TEXT, reason TEXT, basis TEXT,
        PRIMARY KEY(project,assignment_generation)
    );
"""
COLUMNS = {"project", "assignment_generation", "phase", "started_revision", "watermark_id", "before_id",
           "after_id", "summary_json", "pages_total", "reactions_total", "passes", "pass_key",
           "pass_pages", "pass_reactions", "last_seq", "pending_request", "retry_at", "reason", "basis"}


def _iso(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)


def _stamp(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _order(message: dict) -> tuple:
    return (_iso(message["at"]), len(message["id"]), message["id"])


def _ref(message: dict) -> dict:
    return {"id": message["id"], "at": message["at"], "kind": message["kind"]}


def _initial_summary() -> dict:
    return {"reply": None, "normal": None, "anchor": None, "closed": False, "guest_after_reply": False,
            "tail": [], "owner_ids": [], "queue": [], "outcome": None, "tail_overflow": False}


def _remember_reactions(summary: dict, message: dict) -> None:
    emojis = [value for value in message.get("reactions", []) if isinstance(value, str)]
    if not emojis:
        return
    if len(summary["tail"]) >= MAX_TAIL:
        summary["tail_overflow"] = True
        return
    summary["tail"].append({"id": message["id"], "at": message["at"], "emojis": emojis})


def _remember_owner(summary: dict, message: dict) -> None:
    # A live observation of a scanned owner message is a duplicate, not a newer
    # reply. /close is excluded so a buffered live closure still gets its ✅.
    if message["kind"] != "owner-close":
        summary["owner_ids"].append(message["id"])


def _absorb_backward(summary: dict, messages: list[dict]) -> bool:
    """Walk newest to oldest; return True once open/closed ownership is known."""
    for message in sorted(messages, key=_order, reverse=True):
        kind = message["kind"]
        if summary["reply"] is None:
            _remember_reactions(summary, message)
            if kind == "guest":
                # Bot messages after a guest message answer that guest.
                summary["anchor"] = None
                summary["guest_after_reply"] = True
            elif kind == "bot" and summary["anchor"] is None:
                summary["anchor"] = _ref(message)
            elif kind in OWNER_KINDS:
                summary["reply"] = _ref(message)
        if kind in OWNER_KINDS:
            _remember_owner(summary, message)
            if kind == "owner-close":
                summary["closed"] = True
                return True
            if kind == "owner-message":
                summary["normal"] = _ref(message)
                return True
    return False


def _absorb_forward(summary: dict, messages: list[dict]) -> None:
    """Walk oldest to newest through messages newer than the watermark."""
    for message in sorted(messages, key=_order):
        kind = message["kind"]
        if kind in OWNER_KINDS:
            summary.update(reply=_ref(message), anchor=None, guest_after_reply=False, tail=[],
                           tail_overflow=False)
            _remember_owner(summary, message)
            if kind == "owner-message":
                summary.update(normal=_ref(message), closed=False)
            elif kind == "owner-close":
                summary["closed"] = True
        elif kind == "guest":
            summary["guest_after_reply"] = True
        elif kind == "bot" and not summary["guest_after_reply"]:
            summary["anchor"] = _ref(message)
        if summary["reply"] is not None:
            _remember_reactions(summary, message)


def _valid_messages(payload: dict, recorded_reminders: set[str]) -> list[dict] | None:
    messages = payload.get("messages")
    if not isinstance(messages, list):
        return None
    clean = []
    for message in messages:
        if (not isinstance(message, dict) or not isinstance(message.get("id"), str) or
                not isinstance(message.get("at"), str) or message.get("kind") not in MESSAGE_KINDS):
            return None
        try:
            _iso(message["at"])
        except ValueError:
            return None
        if message["id"] in recorded_reminders:
            # Recorded Conversation Reminders are identified by ID, never by text.
            message = {**message, "kind": "other", "reactions": []}
        clean.append(message)
    return clean


def next_request(db: sqlite3.Connection, usable: dict, now: datetime) -> dict | None:
    """Pick the least-served channel this pass and reserve one bounded request."""
    settings = dict(db.execute("SELECT key,value FROM settings").fetchall())
    if settings.get("disabled") == "1" or settings.get("discovery_requested") != "1":
        return None
    pass_key = int(now.timestamp()) // PASS_SECONDS
    candidates = []
    for row in db.execute("SELECT * FROM conversations ORDER BY project").fetchall():
        assignment = usable.get(row["project"])
        if row["reconciliation_status"] not in STARTABLE or assignment is None or (
                assignment["generation"], assignment["channel_id"], assignment["bot_id"]) != (
                row["assignment_generation"], row["channel_id"], row["bot_id"]):
            continue
        found = db.execute("SELECT * FROM discoveries WHERE project=? AND assignment_generation=?",
                           (row["project"], row["assignment_generation"])).fetchone()
        if found is not None and found["phase"] == "complete":
            continue
        if found is not None and found["retry_at"] and _iso(found["retry_at"]) > now:
            continue
        pages, reactions = ((found["pass_pages"], found["pass_reactions"])
                            if found is not None and found["pass_key"] == pass_key else (0, 0))
        phase = found["phase"] if found is not None else "backward"
        if (phase == "reactions" and reactions >= REACTIONS_PER_PASS) or (
                phase != "reactions" and pages >= PAGES_PER_PASS):
            continue
        candidates.append((pages + reactions, found["last_seq"] if found is not None else 0,
                           row["project"], row, found))
    if not candidates:
        return None
    _, _, project, row, found = min(candidates, key=lambda item: item[:3])
    generation = row["assignment_generation"]
    if found is None:
        db.execute("""INSERT INTO discoveries (project,assignment_generation,phase,started_revision,summary_json)
            VALUES (?,?,'backward',?,?)""", (project, generation, row["revision"], json.dumps(_initial_summary())))
        db.execute("UPDATE conversations SET reconciliation_status='discovering' WHERE project=?", (project,))
        found = db.execute("SELECT * FROM discoveries WHERE project=? AND assignment_generation=?",
                           (project, generation)).fetchone()
    seq = db.execute("SELECT COALESCE(MAX(last_seq),0)+1 FROM discoveries").fetchone()[0]
    request = {"request_id": f"{seq}", "project": project, "assignment_generation": generation,
               "channel_id": row["channel_id"], "limit": PAGE_LIMIT}
    if found["phase"] == "backward":
        request.update(kind="history", **({"before": found["before_id"]} if found["before_id"] else {}))
    elif found["phase"] == "forward":
        request.update(kind="history", after=found["after_id"] or "0")
    else:
        item = json.loads(found["summary_json"])["queue"][0]
        request.update(kind="reactions", message_id=item["id"], emoji=item["emoji"])
    same_pass = found["pass_key"] == pass_key
    pages = (found["pass_pages"] if same_pass else 0) + (request["kind"] == "history")
    reactions = (found["pass_reactions"] if same_pass else 0) + (request["kind"] == "reactions")
    # Budgets count attempts, so a crash between request and result still spends them.
    db.execute("""UPDATE discoveries SET pending_request=?, last_seq=?, pass_key=?, passes=passes+?,
            pass_pages=?, pass_reactions=? WHERE project=? AND assignment_generation=?""",
        (json.dumps(request), seq, pass_key, 0 if same_pass else 1, pages, reactions, project, generation))
    return request


def _evaluate(summary: dict, active_turn: bool) -> tuple[str, str]:
    """Return (state, basis) for a resolved history summary."""
    if summary["reply"] is None:
        return "open-paused", "no-owner-participation"
    if summary["closed"]:
        return "closed", "closed-in-history"
    if summary["anchor"] is None:
        return "open-paused", "no-answer-after-reply"
    if active_turn:
        return "open-paused", "active-turn"
    if summary["outcome"]:
        return "open-paused", summary["outcome"]
    return "awaiting-owner", APPROXIMATION


def record_result(db: sqlite3.Connection, payload: dict, now: datetime, recorded_reminders: set[str],
                  adapter_interactions: set[str], reaction_times) -> str:
    """Apply one Discord read to the checkpointed scan; commit the baseline when resolved."""
    found = db.execute("SELECT * FROM discoveries WHERE project=? AND assignment_generation=?",
                       (payload.get("project"), payload.get("assignment_generation"))).fetchone()
    if found is None or not found["pending_request"]:
        return "ignored"
    request = json.loads(found["pending_request"])
    if request["request_id"] != payload.get("request_id"):
        return "ignored"
    project, generation = found["project"], found["assignment_generation"]
    row = db.execute("SELECT * FROM conversations WHERE project=?", (project,)).fetchone()
    key = (project, generation)
    if row is None or row["assignment_generation"] != generation or row["reconciliation_status"] not in ACTIVE:
        db.execute("DELETE FROM discoveries WHERE project=? AND assignment_generation=?", key)
        return "ignored"
    db.execute("UPDATE discoveries SET pending_request=NULL WHERE project=? AND assignment_generation=?", key)
    status = payload.get("status")
    reactions = request["kind"] == "reactions"
    if status == 429:
        retry = payload.get("retry_after")
        delay = float(retry) if isinstance(retry, (int, float)) and retry >= 0 else TRANSIENT_RETRY_SECONDS
        db.execute("UPDATE discoveries SET retry_at=?, reason=? WHERE project=? AND assignment_generation=?",
                   (_stamp(now + timedelta(seconds=max(1.0, delay))), "rate-limited; waiting for Discord", *key))
        return "backoff"
    if status in (401, 403) or (status == 404 and not reactions):
        db.execute("UPDATE discoveries SET retry_at=?, reason=? WHERE project=? AND assignment_generation=?",
                   (_stamp(now + timedelta(seconds=DENIED_RETRY_SECONDS)),
                    payload.get("reason") or "history access denied or unavailable", *key))
        db.execute("UPDATE conversations SET reconciliation_status='suspended-discovery-history' WHERE project=?",
                   (project,))
        return "suspended"
    summary = json.loads(found["summary_json"])
    messages = None if reactions else _valid_messages(payload, recorded_reminders)
    users = payload.get("users") or []
    malformed = (not reactions and messages is None) or (
        reactions and status == 200 and (not isinstance(users, list) or not all(isinstance(u, str) for u in users)))
    if (status != 200 and not (reactions and status == 404)) or malformed:
        db.execute("UPDATE discoveries SET retry_at=?, reason=? WHERE project=? AND assignment_generation=?",
                   (_stamp(now + timedelta(seconds=TRANSIENT_RETRY_SECONDS)),
                    "history temporarily unavailable; resuming from checkpoint", *key))
        return "backoff"
    db.execute("UPDATE conversations SET reconciliation_status='discovering' WHERE project=?", (project,))
    changes: dict = {"retry_at": None, "reason": None}
    messages = messages or []
    phase = found["phase"]
    if phase == "backward":
        changes["pages_total"] = found["pages_total"] + 1
        if found["before_id"] is None:
            # The newest message at scan start is the observation watermark.
            newest = max(messages, key=_order)["id"] if messages else None
            changes.update(watermark_id=newest, after_id=newest)
        resolved = _absorb_backward(summary, messages)
        if messages:
            changes["before_id"] = min(messages, key=_order)["id"]
        if resolved or len(messages) < PAGE_LIMIT:
            phase = "forward"
    elif phase == "forward":
        changes["pages_total"] = found["pages_total"] + 1
        _absorb_forward(summary, messages)
        if messages:
            changes["after_id"] = max(messages, key=_order)["id"]
        if len(messages) < PAGE_LIMIT:
            phase = "reactions"
            candidate = (summary["reply"] and not summary["closed"] and summary["anchor"] and
                         not (summary["normal"] and summary["normal"]["id"] in adapter_interactions))
            summary["queue"] = [{"id": item["id"], "at": item["at"], "emoji": emoji}
                                for item in summary["tail"] for emoji in item["emojis"]
                                if item["id"] not in recorded_reminders] if candidate else []
            if candidate and summary["tail_overflow"]:
                summary["outcome"] = "reaction-ordering-unresolved"
                summary["queue"] = []
    else:
        changes["reactions_total"] = found["reactions_total"] + 1
        item = summary["queue"].pop(0)
        owner = row["owner_id"]
        if status == 200 and owner in users:
            if _iso(item["at"]) >= _iso(summary["anchor"]["at"]):
                # A reaction on a message cannot predate that message.
                summary["outcome"] = "owner-reaction-after-answer"
            else:
                times = reaction_times(item["id"])
                if any(_iso(value) >= _iso(summary["anchor"]["at"]) for value in times):
                    summary["outcome"] = "owner-reaction-after-answer"
                elif not times:
                    # Membership alone cannot date the reaction; pause conservatively.
                    summary["outcome"] = "reaction-ordering-unresolved"
        elif status == 200 and len(users) >= PAGE_LIMIT:
            summary["outcome"] = "reaction-ordering-unresolved"
        if summary["outcome"]:
            summary["queue"] = []
    changes.update(phase=phase, summary_json=json.dumps(summary))
    if phase == "reactions" and not summary["queue"]:
        if row["revision"] != found["started_revision"]:
            # Something changed the conversation outside the buffer; rescan.
            db.execute("DELETE FROM discoveries WHERE project=? AND assignment_generation=?", key)
            db.execute("""UPDATE conversations SET reconciliation_status='suspended-incomplete-discovery'
                WHERE project=?""", (project,))
            return "restarted"
        basis = _commit(db, row, summary, bool(summary["normal"] and summary["normal"]["id"] in adapter_interactions))
        changes.update(phase="complete", basis=basis)
    columns = ",".join(f"{name}=?" for name in changes)
    db.execute(f"UPDATE discoveries SET {columns} WHERE project=? AND assignment_generation=?",
               (*changes.values(), *key))
    return "committed" if changes["phase"] == "complete" else "progress"


def _commit(db: sqlite3.Connection, row: sqlite3.Row, summary: dict, active_turn: bool) -> str:
    """Write the historical baseline without overriding persisted newer knowledge."""
    state, basis = _evaluate(summary, active_turn)
    reply, normal, anchor = summary["reply"], summary["normal"], summary["anchor"]
    persisted_ack = _iso(row["last_ack_at"]) if row["last_ack_at"] else None
    if row["state"] == "closed" and (normal is None or (persisted_ack and _iso(normal["at"]) <= persisted_ack)):
        # History never overwrites a persisted closure without a later normal message.
        basis = "persisted-closure"
    elif (row["state"] == "awaiting-owner" and normal is not None and
          row["current_interaction_id"] == normal["id"]):
        basis = "live-completion"
    else:
        if state == "awaiting-owner" and persisted_ack and persisted_ack >= _iso(anchor["at"]):
            state, basis = "open-paused", "recorded-acknowledgment"
        changes = {"state": state, "due_at": None, "response_message_id": None, "response_at": None,
                   "current_interaction_id": normal["id"] if normal and state != "closed" else None}
        if reply is not None and (persisted_ack is None or _iso(reply["at"]) > persisted_ack):
            changes.update(last_ack_at=reply["at"], last_ack_message_id=reply["id"])
        if state == "awaiting-owner":
            changes.update(response_message_id=anchor["id"], response_at=anchor["at"],
                           due_at=_stamp(_iso(anchor["at"]) + timedelta(hours=1)))
        columns = ",".join(f"{name}=?" for name in changes)
        db.execute(f"UPDATE conversations SET {columns}, revision=revision+1 WHERE project=?",
                   (*changes.values(), row["project"]))
    for source in summary["owner_ids"]:
        db.execute("INSERT OR IGNORE INTO owner_sources VALUES (?,?,?,?)",
                   (row["project"], row["assignment_generation"], source, "history"))
    db.execute("UPDATE conversations SET reconciliation_status='ready' WHERE project=?", (row["project"],))
    return basis


def status_for(db: sqlite3.Connection, project: str, generation: str) -> dict | None:
    found = db.execute("SELECT * FROM discoveries WHERE project=? AND assignment_generation=?",
                       (project, generation)).fetchone()
    if found is None:
        return None
    return {"phase": found["phase"], "basis": found["basis"],
            "limitation": LIMITATION if found["basis"] == APPROXIMATION else None,
            "resumable": found["phase"] != "complete", "pages_scanned": found["pages_total"],
            "reaction_checks": found["reactions_total"], "passes": found["passes"],
            "watermark_id": found["watermark_id"], "before_id": found["before_id"],
            "after_id": found["after_id"], "retry_at": found["retry_at"], "reason": found["reason"]}
