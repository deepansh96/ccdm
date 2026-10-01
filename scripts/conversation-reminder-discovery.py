"""Bounded, checkpointed history discovery for Project Conversations.

The service owns this state machine; the observer only performs the Discord
reads it requests. Each channel establishes a watermark, pages backward until
the owner's latest participation is found (or history starts), reconciles
forward through the newest message, and checks reaction membership before the
historical baseline is committed. Only message IDs, timestamps, message kinds,
and emoji identifiers are persisted; message bodies never reach this store.

The same traversal runs in ``restart`` mode after a worker restart, Gateway
reconnect, or re-enable. It stops at the persisted acknowledgment instead of
building a baseline; the service then applies missed owner activity on top of
the persisted state.

An initial scan then walks the channel's Thread Conversations: its active
threads, plus the archived ones archived within the last week whose
conversation is not closed. Each adopted thread is scanned the same way, into
its own baseline, and the project is released only once every thread's scan
has committed. The whole project shares one per-pass budget.
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
# Archived threads older than this are never adopted.
THREAD_ARCHIVE_WINDOW = timedelta(days=7)
# The channel's thread phases, after its own scan: listing threads, then scanning each.
THREAD_LISTING, THREAD_SCANS = "threads", "thread-scans"
# Channels whose live events are durably buffered until the scan commits.
ACTIVE = {"discovering", "reconciling", "suspended-discovery-history"}
RESTART = "suspended-restart-reconciliation"
STARTABLE = {"suspended-incomplete-discovery", RESTART, *ACTIVE}
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


def _initial_summary(mode: str = "initial", floor: str | None = None) -> dict:
    return {"reply": None, "normal": None, "anchor": None, "closed": False, "guest_after_reply": False,
            "tail": [], "owner_ids": [], "queue": [], "outcome": None, "tail_overflow": False,
            "mode": mode, "floor": floor, "close": None, "reacted": [], "reaction_unresolved": False}


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
        if summary.get("floor") and _iso(message["at"]) < _iso(summary["floor"]):
            # Restart mode: persisted state already reflects everything older.
            return True
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
                summary.update(closed=True, close=_ref(message))
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
                summary.update(closed=True, close=_ref(message))
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
            # They never anchor an answer, but an owner reaction on one still counts.
            message = {**message, "kind": "other"}
        clean.append(message)
    return clean


def _discovery(db: sqlite3.Connection, project: str, conversation: str, generation: str) -> sqlite3.Row | None:
    return db.execute("SELECT * FROM discoveries WHERE project=? AND conversation_id=? AND assignment_generation=?",
                      (project, conversation, generation)).fetchone()


def _next_thread_scan(db: sqlite3.Connection, project: str, channel: str, generation: str) -> sqlite3.Row | None:
    return db.execute("""SELECT * FROM discoveries WHERE project=? AND assignment_generation=?
        AND conversation_id!=? AND phase!='complete' ORDER BY conversation_id LIMIT 1""",
                      (project, generation, channel)).fetchone()


def next_request(db: sqlite3.Connection, usable: dict, now: datetime, guild_id: str | None = None) -> dict | None:
    """Pick the least-served channel this pass and reserve one bounded request."""
    settings = dict(db.execute("SELECT key,value FROM settings").fetchall())
    if settings.get("disabled") == "1":
        return None
    requested = settings.get("discovery_requested") == "1"
    pass_key = int(now.timestamp()) // PASS_SECONDS
    candidates = []
    # Discovery starts from each project's channel; its threads share its status.
    for row in db.execute("SELECT * FROM conversations WHERE conversation_id=channel_id ORDER BY project").fetchall():
        assignment = usable.get(row["project"])
        status = row["reconciliation_status"]
        if status not in STARTABLE or assignment is None or (
                assignment["generation"], assignment["channel_id"], assignment["identity"]) != (
                row["assignment_generation"], row["channel_id"], row["identity"]):
            continue
        found = _discovery(db, row["project"], row["channel_id"], row["assignment_generation"])
        # A channel released before a restart rescans from its persisted acknowledgment.
        fresh_restart = status == RESTART or (found is None and status == "reconciling")
        if fresh_restart:
            found = None
        elif found is None and not requested:
            continue
        if found is not None and found["phase"] == "complete":
            continue
        # The thread being scanned, once the channel's own scan has committed.
        target = found
        if found is not None and found["phase"] == THREAD_SCANS:
            target = _next_thread_scan(db, row["project"], row["channel_id"], row["assignment_generation"])
            if target is None:
                continue
        if target is not None and target["retry_at"] and _iso(target["retry_at"]) > now:
            continue
        pages, reactions = ((found["pass_pages"], found["pass_reactions"])
                            if found is not None and found["pass_key"] == pass_key else (0, 0))
        phase = target["phase"] if target is not None else "backward"
        if (phase == "reactions" and reactions >= REACTIONS_PER_PASS) or (
                phase != "reactions" and pages >= PAGES_PER_PASS):
            continue
        candidates.append((pages + reactions, found["last_seq"] if found is not None else 0,
                           row["project"], row, found, target, fresh_restart))
    if not candidates:
        return None
    _, _, project, row, found, target, fresh_restart = min(candidates, key=lambda item: item[:3])
    generation = row["assignment_generation"]
    if found is None:
        mode = "restart" if fresh_restart else "initial"
        db.execute("DELETE FROM discoveries WHERE project=? AND assignment_generation=?", (project, generation))
        db.execute("""INSERT INTO discoveries
            (project,conversation_id,assignment_generation,phase,started_revision,summary_json)
            VALUES (?,?,?,'backward',?,?)""", (project, row["conversation_id"], generation, row["revision"],
                                             json.dumps(_initial_summary(mode, row["last_ack_at"] if fresh_restart else None))))
        db.execute("UPDATE conversations SET reconciliation_status=? WHERE project=?",
                   ("reconciling" if fresh_restart else "discovering", project))
        found = target = _discovery(db, project, row["channel_id"], generation)
    seq = db.execute("SELECT COALESCE(MAX(last_seq),0)+1 FROM discoveries").fetchone()[0]
    # `target_id` is what is read: the channel, or one of its threads.
    request = {"request_id": f"{seq}", "project": project, "assignment_generation": generation,
               "channel_id": row["channel_id"], "target_id": target["conversation_id"], "limit": PAGE_LIMIT}
    if target["phase"] == "backward":
        request.update(kind="history", **({"before": target["before_id"]} if target["before_id"] else {}))
    elif target["phase"] == "forward":
        request.update(kind="history", after=target["after_id"] or "0")
    elif target["phase"] == THREAD_LISTING:
        before = json.loads(target["summary_json"]).get("threads_before")
        request.update(kind="threads", guild_id=guild_id, **({"before": before} if before else {}))
    else:
        item = json.loads(target["summary_json"])["queue"][0]
        request.update(kind="reactions", message_id=item["id"], emoji=item["emoji"])
    same_pass = found["pass_key"] == pass_key
    pages = (found["pass_pages"] if same_pass else 0) + (request["kind"] != "reactions")
    reactions = (found["pass_reactions"] if same_pass else 0) + (request["kind"] == "reactions")
    # Budgets count attempts, so a crash between request and result still spends them.
    db.execute("""UPDATE discoveries SET last_seq=?, pass_key=?, passes=passes+?,
            pass_pages=?, pass_reactions=? WHERE project=? AND conversation_id=? AND assignment_generation=?""",
        (seq, pass_key, 0 if same_pass else 1, pages, reactions, project, row["channel_id"], generation))
    db.execute("""UPDATE discoveries SET pending_request=?, last_seq=?
        WHERE project=? AND conversation_id=? AND assignment_generation=?""",
        (json.dumps(request), seq, project, target["conversation_id"], generation))
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


def _release(db: sqlite3.Connection, channel: sqlite3.Row) -> str:
    """Commit the project's discovery once no thread scan remains."""
    project, generation = channel["project"], channel["assignment_generation"]
    if _next_thread_scan(db, project, channel["conversation_id"], generation) is not None:
        return "progress"
    db.execute("""UPDATE discoveries SET phase='complete' WHERE project=? AND conversation_id=?
        AND assignment_generation=?""", (project, channel["conversation_id"], generation))
    db.execute("UPDATE conversations SET reconciliation_status='ready' WHERE project=?", (project,))
    return "committed"


def _record_threads(db: sqlite3.Connection, channel: sqlite3.Row, found: sqlite3.Row, summary: dict,
                    threads: list[dict], has_more: bool, now: datetime, closed_threads: set[str]) -> str:
    """Adopt the listed active threads and recent, unclosed archived ones; page on through the window."""
    cutoff = now - THREAD_ARCHIVE_WINDOW
    adopted = summary.setdefault("threads", [])
    oldest = None
    for thread in threads:
        archived = thread.get("archived") is True
        try:
            archived_at = _iso(thread["archive_timestamp"]) if archived else None
        except (KeyError, TypeError, ValueError):
            archived_at = None
        if archived_at is not None and (oldest is None or archived_at < _iso(oldest)):
            oldest = thread["archive_timestamp"]
        if thread["id"] not in adopted and (not archived or (
                archived_at is not None and archived_at >= cutoff and thread["id"] not in closed_threads)):
            adopted.append(thread["id"])
    key = (channel["project"], channel["conversation_id"], channel["assignment_generation"])
    if has_more and oldest is not None and _iso(oldest) >= cutoff:
        # Archived threads come newest archive first: the next page may still be recent.
        summary["threads_before"] = oldest
        db.execute("""UPDATE discoveries SET summary_json=?, pages_total=pages_total+1, retry_at=NULL, reason=NULL
            WHERE project=? AND conversation_id=? AND assignment_generation=?""", (json.dumps(summary), *key))
        return "progress"
    for thread_id in adopted:
        # Each adopted thread is tracked under its project's assignment, sharing its status.
        db.execute("""INSERT OR IGNORE INTO conversations
            (project,conversation_id,channel_id,identity,assignment_generation,owner_id,state,revision,
             cleanup_message_ids,reconciliation_status,checkpoint)
            VALUES (?,?,?,?,?,?,'open-paused',0,'[]',?,?)""",
                   (channel["project"], thread_id, channel["channel_id"], channel["identity"],
                    channel["assignment_generation"], channel["owner_id"], channel["reconciliation_status"],
                    channel["checkpoint"]))
        revision = db.execute("SELECT revision FROM conversations WHERE project=? AND conversation_id=?",
                              (channel["project"], thread_id)).fetchone()[0]
        db.execute("""INSERT OR REPLACE INTO discoveries
            (project,conversation_id,assignment_generation,phase,started_revision,summary_json)
            VALUES (?,?,?,'backward',?,?)""",
                   (channel["project"], thread_id, channel["assignment_generation"], revision,
                    json.dumps(_initial_summary())))
    db.execute("""UPDATE discoveries SET phase=?, summary_json=?, pages_total=pages_total+1, retry_at=NULL,
        reason=NULL WHERE project=? AND conversation_id=? AND assignment_generation=?""",
               (THREAD_SCANS, json.dumps(summary), *key))
    return _release(db, channel)


def record_result(db: sqlite3.Connection, payload: dict, now: datetime, recorded_reminders: set[str],
                  adapter_interactions: set[str], reaction_times, closed_threads: set[str] = frozenset()) -> str:
    """Apply one Discord read to the checkpointed scan; commit the baseline when resolved.

    ``closed_threads`` are threads whose conversation is closed; archived, they are never adopted."""
    project, generation = payload.get("project"), payload.get("assignment_generation")
    found = next((item for item in db.execute("""SELECT * FROM discoveries WHERE project=?
        AND assignment_generation=? AND pending_request IS NOT NULL""", (project, generation)).fetchall()
                  if json.loads(item["pending_request"]).get("request_id") == payload.get("request_id")), None)
    if found is None:
        return "ignored"
    request = json.loads(found["pending_request"])
    project, generation = found["project"], found["assignment_generation"]
    channel = db.execute("SELECT * FROM conversations WHERE project=? AND conversation_id=channel_id",
                         (project,)).fetchone()
    row = db.execute("SELECT * FROM conversations WHERE project=? AND conversation_id=?",
                     (project, found["conversation_id"])).fetchone()
    if (channel is None or row is None or channel["assignment_generation"] != generation or
            channel["reconciliation_status"] not in ACTIVE):
        db.execute("DELETE FROM discoveries WHERE project=? AND assignment_generation=?", (project, generation))
        return "ignored"
    in_thread = row["conversation_id"] != channel["conversation_id"]
    key = (project, row["conversation_id"], generation)
    db.execute("UPDATE discoveries SET pending_request=NULL WHERE project=? AND conversation_id=? AND assignment_generation=?", key)
    status = payload.get("status")
    reactions = request["kind"] == "reactions"
    listing = request["kind"] == "threads"
    if status == 429:
        retry = payload.get("retry_after")
        delay = float(retry) if isinstance(retry, (int, float)) and retry >= 0 else TRANSIENT_RETRY_SECONDS
        db.execute("UPDATE discoveries SET retry_at=?, reason=? WHERE project=? AND conversation_id=? AND assignment_generation=?",
                   (_stamp(now + timedelta(seconds=max(1.0, delay))), "rate-limited; waiting for Discord", *key))
        return "backoff"
    if in_thread and status == 404:
        # The thread is gone: it is not adopted.
        db.execute("DELETE FROM discoveries WHERE project=? AND conversation_id=? AND assignment_generation=?", key)
        db.execute("DELETE FROM conversations WHERE project=? AND conversation_id=?", key[:2])
        return _release(db, channel)
    if status in (401, 403) or (status == 404 and not reactions):
        db.execute("UPDATE discoveries SET retry_at=?, reason=? WHERE project=? AND conversation_id=? AND assignment_generation=?",
                   (_stamp(now + timedelta(seconds=DENIED_RETRY_SECONDS)),
                    payload.get("reason") or "history access denied or unavailable", *key))
        db.execute("UPDATE conversations SET reconciliation_status='suspended-discovery-history' WHERE project=?",
                   (project,))
        return "suspended"
    summary = {**_initial_summary(), **json.loads(found["summary_json"])}
    messages = None if reactions or listing else _valid_messages(payload, recorded_reminders)
    users = payload.get("users") or []
    threads = payload.get("threads")
    malformed = (not reactions and not listing and messages is None) or (
        reactions and status == 200 and (not isinstance(users, list) or not all(isinstance(u, str) for u in users))
    ) or (listing and status == 200 and (not isinstance(threads, list) or not all(
        isinstance(thread, dict) and isinstance(thread.get("id"), str) and thread["id"] for thread in threads)))
    if (status != 200 and not (reactions and status == 404)) or malformed:
        db.execute("UPDATE discoveries SET retry_at=?, reason=? WHERE project=? AND conversation_id=? AND assignment_generation=?",
                   (_stamp(now + timedelta(seconds=TRANSIENT_RETRY_SECONDS)),
                    "history temporarily unavailable; resuming from checkpoint", *key))
        return "backoff"
    restart = summary.get("mode") == "restart"
    db.execute("UPDATE conversations SET reconciliation_status=? WHERE project=?",
               ("reconciling" if restart else "discovering", project))
    if listing:
        return _record_threads(db, channel, found, summary, threads, payload.get("has_more") is True, now,
                               set(closed_threads))
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
            # Restart mode checks every tail reaction; the persisted state decides relevance.
            candidate = restart or (summary["reply"] and not summary["closed"] and summary["anchor"] and
                                    not (summary["normal"] and summary["normal"]["id"] in adapter_interactions))
            summary["queue"] = [{"id": item["id"], "at": item["at"], "emoji": emoji}
                                for item in summary["tail"] for emoji in item["emojis"]] if candidate else []
            if candidate and summary["tail_overflow"]:
                summary.update(outcome="reaction-ordering-unresolved", reaction_unresolved=True, queue=[])
    else:
        changes["reactions_total"] = found["reactions_total"] + 1
        item = summary["queue"].pop(0)
        owner = row["owner_id"]
        if status == 200 and owner in users:
            summary["reacted"].append({"id": item["id"], "at": item["at"]})
        elif status == 200 and len(users) >= PAGE_LIMIT:
            summary["reaction_unresolved"] = True
        if restart:
            if summary["reaction_unresolved"]:
                summary["queue"] = []
        elif status == 200 and owner in users:
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
        if not in_thread and row["revision"] != found["started_revision"]:
            # Something changed the conversation outside the buffer; rescan.
            db.execute("DELETE FROM discoveries WHERE project=? AND assignment_generation=?", (project, generation))
            db.execute("UPDATE conversations SET reconciliation_status=? WHERE project=?",
                       (RESTART if restart else "suspended-incomplete-discovery", project))
            return "restarted"
        if restart:
            # The service merges this summary onto the persisted state, then releases the channel.
            changes.update(phase="complete", basis="restart-reconciled")
        else:
            # The channel's baseline commits now; the project is released after its threads'.
            basis = _commit(db, row, summary,
                            bool(summary["normal"] and summary["normal"]["id"] in adapter_interactions))
            changes.update(phase="complete" if in_thread else THREAD_LISTING, basis=basis)
    columns = ",".join(f"{name}=?" for name in changes)
    db.execute(f"UPDATE discoveries SET {columns} WHERE project=? AND conversation_id=? AND assignment_generation=?",
               (*changes.values(), *key))
    if in_thread and changes["phase"] == "complete":
        return _release(db, channel)
    if changes["phase"] != "complete":
        return "progress"
    return "reconciled" if restart else "committed"


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
        # History cannot identify earlier reminders, so a baseline starts a fresh streak.
        changes = {"state": state, "due_at": None, "response_message_id": None, "response_at": None,
                   "current_interaction_id": normal["id"] if normal and state != "closed" else None,
                   "consecutive_reminders": 0}
        if reply is not None and (persisted_ack is None or _iso(reply["at"]) > persisted_ack):
            changes.update(last_ack_at=reply["at"], last_ack_message_id=reply["id"])
        if state == "awaiting-owner":
            changes.update(response_message_id=anchor["id"], response_at=anchor["at"],
                           due_at=_stamp(_iso(anchor["at"]) + timedelta(hours=1)))
        columns = ",".join(f"{name}=?" for name in changes)
        db.execute(f"UPDATE conversations SET {columns}, revision=revision+1 "
                   "WHERE project=? AND conversation_id=?", (*changes.values(), row["project"], row["conversation_id"]))
    for source in summary["owner_ids"]:
        db.execute("""INSERT OR IGNORE INTO owner_sources
            (project,conversation_id,assignment_generation,source_message_id,kind) VALUES (?,?,?,?,?)""",
                   (row["project"], row["conversation_id"], row["assignment_generation"], source, "history"))
    mark_reactions_seen(db, row["project"], row["conversation_id"], row["assignment_generation"], summary["reacted"])
    return basis


def mark_reactions_seen(db: sqlite3.Connection, project: str, conversation: str, generation: str,
                        reacted: list[dict]) -> None:
    """Remember owner reactions already accounted for, so a later restart does not re-pause on them."""
    for item in reacted:
        db.execute("""INSERT OR IGNORE INTO owner_sources
            (project,conversation_id,assignment_generation,source_message_id,kind) VALUES (?,?,?,?,?)""",
                   (project, conversation, generation, "reaction:" + item["id"], "history-reaction"))


def status_for(db: sqlite3.Connection, project: str, conversation: str, generation: str) -> dict | None:
    found = db.execute("SELECT * FROM discoveries WHERE project=? AND conversation_id=? AND assignment_generation=?",
                       (project, conversation, generation)).fetchone()
    if found is None:
        return None
    return {"phase": found["phase"], "basis": found["basis"],
            "mode": json.loads(found["summary_json"]).get("mode", "initial"),
            "limitation": LIMITATION if found["basis"] == APPROXIMATION else None,
            "resumable": found["phase"] != "complete", "pages_scanned": found["pages_total"],
            "reaction_checks": found["reactions_total"], "passes": found["passes"],
            "watermark_id": found["watermark_id"], "before_id": found["before_id"],
            "after_id": found["after_id"], "retry_at": found["retry_at"], "reason": found["reason"]}
