#!/usr/bin/env python3
"""Aggregate this month's local DeepSeek token usage from configured Codex homes.

The collector is read-only, credential-free, and network-free.  It streams the
Codex rollout JSONL files found under a bounded set of directories and sums the
per-turn token deltas of DeepSeek turns for the current UTC month.

Only counters leave this module.  No filesystem paths, session identifiers,
prompts, model text, or credentials are ever returned or printed by
``collect_month_usage``.

Scope and limits:

* Coverage is "this month's local Codex sessions in the configured DeepSeek
  homes".  Both ``sessions`` and ``archived_sessions`` inside each home are
  scanned; other clients, other machines, ephemeral workers, and deleted
  rollouts are excluded.
* Nothing here is a provider-wide or account-wide measurement.  DeepSeek's
  balance API reports an account balance, not spend, and is handled elsewhere.
* This is token accounting only.  No cost estimate is derived here.

The public interface is::

    collect_month_usage(homes, now) -> dict

where ``homes`` is an iterable of ``pathlib.Path`` Codex homes and ``now`` is a
timezone-aware ``datetime`` used to pick the UTC month.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
from datetime import datetime, timezone
from pathlib import Path


# Directories inside a Codex home that can contain rollout JSONL files.  Both
# live and archived sessions count toward the local month; archived files are
# deliberately included.
SESSION_DIRECTORIES = ("sessions", "archived_sessions")

# The counters reported by Codex.  ``cached_input_tokens`` is a subset of
# ``input_tokens`` and ``reasoning_output_tokens`` is a subset of
# ``output_tokens``; the subsets are reported separately and never added into
# the totals a second time.
COUNTER_KEYS = (
    "input_tokens",
    "cached_input_tokens",
    "output_tokens",
    "reasoning_output_tokens",
    "total_tokens",
)

# Upper bound for a single reported counter.  Codex counters are tiny relative
# to this; anything larger is treated as malformed rather than trusted.
MAX_COUNTER_VALUE = 1 << 62

# A rollout line can be large (tool output, patches), but a single line beyond
# this bound is treated as malformed/truncated rather than buffered whole.
MAX_LINE_BYTES = 1 << 20
# Per-file byte budget so one pathological rollout cannot stall the scan.
MAX_FILE_BYTES = 1 << 28
# Per-file and per-run event budgets so memory stays bounded even for a
# corrupted or adversarial home.  Typical homes sit far below these.
MAX_EVENTS_PER_FILE = 200_000
MAX_TOTAL_EVENTS = 1_000_000
# Per-run file budget across every scanned home.
MAX_SESSION_FILES = 20_000
# Per-run byte budget so a huge (but parseable) home cannot scan forever.
MAX_TOTAL_BYTES = 1 << 32

REASON_HOMES_UNAVAILABLE = "Configured DeepSeek homes were unavailable"
REASON_SOME_HOMES_UNAVAILABLE = "Some DeepSeek homes were unavailable"
REASON_FILES_UNREADABLE = "Some session files could not be read"
REASON_IDENTITY_UNAVAILABLE = "Session identity was unavailable in some files"
REASON_CONTINUITY = "Token continuity was uncertain in some sessions"
REASON_ATTRIBUTION = "Some usage could not be attributed to DeepSeek"
REASON_TIMESTAMP = "Some usage events lacked a usable timestamp"
REASON_MALFORMED = "Some session files were malformed or truncated"
REASON_LIMIT = "The local usage scan reached its safety bounds"


def _empty_counters():
    return {key: 0 for key in COUNTER_KEYS}


def _available_result(period, counters, sessions, partial, reasons):
    reason = "; ".join(reasons) if reasons else None
    return {
        "status": "available",
        "period": period,
        "input_tokens": counters["input_tokens"],
        "cached_input_tokens": counters["cached_input_tokens"],
        "output_tokens": counters["output_tokens"],
        "reasoning_output_tokens": counters["reasoning_output_tokens"],
        "total_tokens": counters["total_tokens"],
        "sessions": sessions,
        "partial": bool(partial),
        "reason": reason[:200] if reason else None,
    }


def _unavailable_result(period, reason):
    result = _available_result(period, _empty_counters(), 0, False, [reason])
    result["status"] = "unavailable"
    return result


def _number(value):
    """Return ``value`` as a bounded non-negative int, or ``None`` if unusable.

    Only real integers (including integral JSON numbers) are accepted.
    Booleans, fractions, negatives, non-finite floats, and outsized values are
    rejected, so a malformed or hostile counter can never be silently
    truncated, rounded, or raised as ``OverflowError`` on the way to a bogus
    total.
    """
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        if value < 0 or value > MAX_COUNTER_VALUE:
            return None
        return value
    if isinstance(value, float):
        if not math.isfinite(value) or value < 0 or value > MAX_COUNTER_VALUE:
            return None
        if not value.is_integer():
            return None
        return int(value)
    return None


def _usage_numbers(raw):
    """Normalize one ``*_token_usage`` object into bounded counters.

    Returns ``None`` when any supplied field is malformed or internally
    inconsistent (a subset larger than its parent, or a ``total_tokens`` that
    does not equal ``input_tokens + output_tokens``).  Nothing is silently
    coerced to zero: an unusable counter invalidates the whole event so the
    caller can flag it as partial instead of counting a wrong number.
    """
    if not isinstance(raw, dict):
        return None
    input_tokens = _number(raw.get("input_tokens"))
    output_tokens = _number(raw.get("output_tokens"))
    if input_tokens is None or output_tokens is None:
        return None
    cached_input_tokens = (
        _number(raw.get("cached_input_tokens")) if "cached_input_tokens" in raw else 0
    )
    if cached_input_tokens is None or cached_input_tokens > input_tokens:
        return None
    reasoning_output_tokens = (
        _number(raw.get("reasoning_output_tokens"))
        if "reasoning_output_tokens" in raw
        else 0
    )
    if reasoning_output_tokens is None or reasoning_output_tokens > output_tokens:
        return None
    if "total_tokens" in raw:
        total_tokens = _number(raw.get("total_tokens"))
        if total_tokens is None or total_tokens != input_tokens + output_tokens:
            return None
    else:
        total_tokens = input_tokens + output_tokens
    return {
        "input_tokens": input_tokens,
        "cached_input_tokens": cached_input_tokens,
        "output_tokens": output_tokens,
        "reasoning_output_tokens": reasoning_output_tokens,
        "total_tokens": total_tokens,
    }


def _decode_usage(raw):
    """Classify one ``*_token_usage`` object.

    Returns ``(numbers, detail_missing, malformed)``:

    * ``numbers`` is the normalized counter dict, or ``None``.
    * ``detail_missing`` is true when the object carries no usable per-turn
      input/output split at all (only e.g. ``total_tokens``), so it cannot be
      decomposed but is not actively wrong.
    * ``malformed`` is true when the object is not a mapping or holds present
      but invalid or internally inconsistent counters.
    """
    if raw is None:
        return None, False, False
    if not isinstance(raw, dict):
        return None, False, True
    if "input_tokens" not in raw and "output_tokens" not in raw:
        return None, True, False
    numbers = _usage_numbers(raw)
    if numbers is None:
        return None, False, True
    return numbers, False, False


def _usage_equal(left, right):
    return all(left[key] == right[key] for key in COUNTER_KEYS)


def _monotonic_delta(current, baseline):
    """Per-counter difference, clamped at zero for safety."""
    return {key: max(0, current[key] - baseline.get(key, 0)) for key in COUNTER_KEYS}


def _usage_regressed(current, baseline):
    """True when any per-turn counter fell below its running cumulative value.

    A reset can move a single component (for example ``cached_input_tokens``)
    without lowering ``total_tokens``.  Clamping each field independently would
    then report the dropped component as zero and silently undercount, so any
    per-field regression is treated as a reset.
    """
    return any(current[key] < baseline.get(key, 0) for key in COUNTER_KEYS)


def _delta_is_valid(delta):
    """True when a computed per-turn delta keeps the subset invariants.

    Two individually valid cumulative samples can still imply an impossible
    per-turn subset: the parent counters may have moved apart more than they
    moved forward, yielding a cached-input delta larger than the input delta or
    a reasoning-output delta larger than the output delta.  Such a delta would
    corrupt the reported breakdown, so it is never trusted.
    """
    return (
        delta["cached_input_tokens"] <= delta["input_tokens"]
        and delta["reasoning_output_tokens"] <= delta["output_tokens"]
        and delta["total_tokens"] == delta["input_tokens"] + delta["output_tokens"]
    )


def _parse_timestamp(value):
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _model_is_deepseek(model):
    return isinstance(model, str) and model.strip().lower().startswith("deepseek")


def _bounded_lines(handle, budget=None):
    """Yield ``(line, consumed)`` pairs, never buffering a whole huge line.

    ``consumed`` counts every byte read for that line, including any discarded
    oversized remainder that is never yielded, so the caller can charge the
    file byte budget for content it never sees.  When ``budget`` is set,
    iteration stops once the total consumed bytes cross it, so a single
    pathological line cannot force unbounded reads past the stated bound.
    """
    limit = MAX_LINE_BYTES
    total = 0
    while True:
        line = handle.readline(limit)
        if not line:
            return
        consumed = len(line)
        if len(line) >= limit and not line.endswith("\n"):
            # Oversized or truncated line: discard the remainder so the next
            # yield starts on a fresh line.
            while True:
                chunk = handle.readline(limit)
                if not chunk:
                    break
                consumed += len(chunk)
                if chunk.endswith("\n"):
                    break
                if budget is not None and total + consumed > budget:
                    break
        total += consumed
        yield line, consumed
        if budget is not None and total > budget:
            return


def _iter_session_files(root, on_error=None):
    """Yield ordinary ``*.jsonl`` files under ``root`` without following links.

    Walk failures are reported through ``on_error`` rather than silently
    looking like a directory that simply had no sessions.
    """
    def report(error):
        if on_error is not None:
            on_error(error)

    for directory, _subdirs, files in os.walk(root, followlinks=False, onerror=report):
        for name in sorted(files):
            if not name.endswith(".jsonl"):
                continue
            candidate = Path(directory) / name
            try:
                if candidate.is_symlink() or not candidate.is_file():
                    continue
            except OSError:
                report(None)
                continue
            yield candidate


def _attribute(turn_model, provider):
    """Return ``(is_deepseek, provable)`` for one token_count event.

    An explicit model from ``turn_context`` wins over a possibly stale
    ``model_provider`` in ``session_meta``.  The session provider is only a
    fallback when no explicit model is available; when neither is known the
    event is unprovable and must not be guessed as DeepSeek.
    """
    if isinstance(turn_model, str) and turn_model.strip():
        return _model_is_deepseek(turn_model), True
    if isinstance(provider, str) and provider.strip():
        return provider.strip().lower() == "deepseek", True
    return False, False


def _scan_session_file(path, prefix):
    """Stream one rollout file into ordered DeepSeek token delta events.

    Returns the per-file events plus flags describing anything that made
    attribution or continuity uncertain.  Paths never appear in the result.
    """
    events = []
    session = None
    provider = None
    turn_model = None
    turn_id = None
    baseline = None
    # Signatures of per-turn deltas already counted while no cumulative counter
    # was available, so a byte-identical repeat is not double-counted.
    last_only_seen = set()
    unreadable = False
    identity_missing = False
    saw_unprovable = False
    saw_malformed = False
    truncated = False
    # A skipped/approximated event carries a partial signal that no appended
    # event may represent, so it is tracked at the file level too.
    saw_approximation = False
    # ``gap`` records that a record between the last cumulative baseline and the
    # next token_count was lost (malformed, truncated, or oversized), so the
    # stale cumulative baseline can no longer be trusted.
    gap = False
    bytes_read = 0

    try:
        with open(path, "r", encoding="utf-8", errors="replace") as handle:
            for raw_line, consumed in _bounded_lines(handle, MAX_FILE_BYTES):
                bytes_read += consumed
                if bytes_read > MAX_FILE_BYTES:
                    truncated = True
                    break
                if raw_line.strip() == "":
                    continue
                oversized = len(raw_line) >= MAX_LINE_BYTES and not raw_line.endswith("\n")
                record = None
                if not oversized:
                    try:
                        record = json.loads(raw_line)
                    except (ValueError, TypeError):
                        record = None
                if oversized or not isinstance(record, dict):
                    # Truncated, oversized, or otherwise unparseable content.
                    # It might be irrelevant tool text, but completeness can no
                    # longer be proven for this file.
                    saw_malformed = True
                    gap = True
                    continue
                payload = record.get("payload")
                if not isinstance(payload, dict):
                    continue
                record_type = record.get("type")

                if record_type == "session_meta":
                    candidate = payload.get("id") or payload.get("session_id")
                    next_session = candidate.strip() if isinstance(candidate, str) else ""
                    if not next_session:
                        # A session boundary we cannot identify: continuity is
                        # unprovable, so reset every carried-over state.
                        identity_missing = True
                        session = None
                        baseline = None
                        last_only_seen.clear()
                        turn_model = None
                        turn_id = None
                    else:
                        if next_session != session:
                            # A new session appended to the same file needs a
                            # fresh cumulative baseline and a fresh turn model;
                            # carrying the previous session's totals or model
                            # over would misattribute the next delta.
                            baseline = None
                            last_only_seen.clear()
                            turn_model = None
                            turn_id = None
                        session = next_session
                    # Always re-read the provider from this meta block: a new
                    # session with no ``model_provider`` must not inherit the
                    # previous session's provider.
                    raw_provider = payload.get("model_provider")
                    provider = (
                        raw_provider.strip().lower()
                        if isinstance(raw_provider, str) and raw_provider.strip()
                        else None
                    )
                    continue

                if record_type == "turn_context":
                    raw_model = payload.get("model")
                    turn_model = (
                        raw_model.strip()
                        if isinstance(raw_model, str) and raw_model.strip()
                        else None
                    )
                    raw_turn = payload.get("turn_id")
                    turn_id = (
                        raw_turn.strip()
                        if isinstance(raw_turn, str) and raw_turn.strip()
                        else None
                    )
                    continue

                if record_type != "event_msg" or payload.get("type") != "token_count":
                    continue

                info = payload.get("info")
                if not isinstance(info, dict):
                    saw_malformed = True
                    gap = True
                    continue

                total, _total_missing, total_bad = _decode_usage(
                    info.get("total_token_usage")
                )
                last, _last_missing, last_bad = _decode_usage(info.get("last_token_usage"))
                if total_bad or last_bad or (total is None and last is None):
                    # Present but malformed or wholly unusable counters: never
                    # count a coerced value, and never trust the cumulative
                    # baseline afterwards.
                    saw_malformed = True
                    gap = True
                    continue

                partial = gap
                skip_event = False
                if gap:
                    # A record between the last baseline and this event was
                    # lost, so the cumulative counter can no longer isolate
                    # this turn.  Only a per-turn delta is provably this
                    # window's usage; without one the cumulative value is
                    # excluded rather than folded into the month, because it
                    # may still carry lifetime or lost-turn history.
                    if last is not None:
                        delta = dict(last)
                    else:
                        delta = None
                        skip_event = True
                        saw_approximation = True
                    partial = True
                    last_only_seen.clear()
                elif baseline is None:
                    if total is None:
                        # Only a per-turn delta is available for the first
                        # event; there is no cumulative counter to compare it to.
                        delta = dict(last)
                        last_only_seen.add(
                            (turn_id or session, tuple(last[key] for key in COUNTER_KEYS))
                        )
                        partial = True
                    elif last is None:
                        # A cumulative-only first event carries no per-turn
                        # delta, so it may already include earlier work.  Exclude
                        # it until a baseline exists, but keep it as the baseline
                        # so the following turns stay attributable.
                        delta = None
                        skip_event = True
                        saw_approximation = True
                        partial = True
                    elif not _usage_equal(total, last):
                        # The cumulative counter already includes work from
                        # before the first event in this file (a partial,
                        # truncated, or migrated rollout).  Only the per-turn
                        # delta is provably this window's usage, so lifetime
                        # history is never folded into the month.
                        delta = dict(last)
                        partial = True
                    else:
                        delta = dict(total)
                elif total is not None and not _usage_regressed(total, baseline):
                    delta = _monotonic_delta(total, baseline)
                elif total is None and last is not None:
                    # No cumulative counter: the running baseline can only
                    # advance by the per-turn delta.  A repeated notification
                    # for the same turn with an identical delta carries no
                    # proof of progress, so count it once and stay partial.
                    signature = (
                        turn_id or session,
                        tuple(last[key] for key in COUNTER_KEYS),
                    )
                    if signature in last_only_seen:
                        delta = None
                        skip_event = True
                        saw_approximation = True
                    else:
                        last_only_seen.add(signature)
                        delta = dict(last)
                    partial = True
                else:
                    # A reset or compaction restarted the cumulative counter, or
                    # a single component counter regressed.  The turn's own usage
                    # is the safest available attribution; when it is missing
                    # the cumulative value is excluded rather than counted as a
                    # delta, since it may already include lifetime history.
                    if last is not None:
                        delta = dict(last)
                    else:
                        delta = None
                        skip_event = True
                        saw_approximation = True
                    partial = True
                if delta is not None and not _delta_is_valid(delta):
                    # Individually valid cumulative samples can still imply an
                    # impossible per-turn subset (for example a cached-input
                    # delta larger than the input delta).  Prefer the validated
                    # per-turn delta; otherwise exclude the event instead of
                    # reporting a corrupt breakdown.
                    if last is not None:
                        delta = dict(last)
                    else:
                        delta = None
                        skip_event = True
                        saw_approximation = True
                    partial = True
                gap = False

                if total is not None:
                    baseline = dict(total)
                elif last is not None and delta is not None:
                    # Without a cumulative counter the running baseline can
                    # only advance by the turn delta, which is conservative.
                    # A suppressed repeat must not inflate it.
                    baseline = {
                        key: (baseline or {}).get(key, 0) + last[key] for key in COUNTER_KEYS
                    }

                if skip_event:
                    continue

                deepseek, provable = _attribute(turn_model, provider)
                if not provable:
                    # Unknown attribution is excluded but never guessed.  The
                    # caller records the resulting gap as a partial signal.
                    saw_unprovable = True
                    continue
                if not deepseek:
                    # A non-DeepSeek turn still advances the baseline above so
                    # the following deltas stay correct.
                    continue

                when = _parse_timestamp(record.get("timestamp"))
                if session is None or turn_id is None:
                    # Identity is not fully provable; the event still counts,
                    # but callers must be told the total may be approximate.
                    identity_missing = True
                events.append({
                    "session": session,
                    "key": turn_id or session or f"unidentified-{prefix}",
                    "when": when,
                    "delta": delta,
                    "cumulative": tuple(
                        (total if total is not None else delta)[key] for key in COUNTER_KEYS
                    ),
                    "partial": partial,
                    "no_timestamp": when is None,
                })
                if len(events) >= MAX_EVENTS_PER_FILE:
                    truncated = True
                    break
    except OSError:
        unreadable = True

    return {
        "session": session,
        "events": events,
        "unreadable": unreadable,
        "identity_missing": identity_missing,
        "saw_unprovable": saw_unprovable,
        "saw_malformed": saw_malformed,
        "saw_approximation": saw_approximation,
        "truncated": truncated,
        "bytes": bytes_read,
    }


def _home_is_readable(home):
    try:
        return home.is_dir() and os.access(home, os.R_OK | os.X_OK)
    except OSError:
        return False


def collect_month_usage(homes, now):
    """Return this UTC month's local DeepSeek token counters for ``homes``.

    ``homes`` is an iterable of ``pathlib.Path`` Codex homes.  ``now`` is a
    timezone-aware ``datetime``; a naive value is interpreted as UTC because
    the reported period is always UTC.
    """
    if not isinstance(now, datetime):
        return _unavailable_result("", "Invalid reference time")
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    reference = now.astimezone(timezone.utc)
    period = reference.strftime("%Y-%m")
    month_key = (reference.year, reference.month)

    home_paths = []
    for raw_home in homes or []:
        try:
            home_paths.append(Path(raw_home))
        except TypeError:
            continue
    if not home_paths:
        return _unavailable_result(period, "No DeepSeek homes configured")

    counters = _empty_counters()
    # Map each deduplicated usage identity to a single owning session id, chosen
    # deterministically as the lexicographically smallest session that emitted
    # it.  Session ids are set-like, so a copied rollout that reuses the same id
    # counts once, while a fork that only inherited a turn does not add a second
    # session.  The owner choice never depends on which home is scanned first.
    owners: dict = {}
    reasons = []
    partial = False
    readable_homes = 0
    files_scanned = 0
    total_events = 0
    total_bytes = 0
    limit_hit = False

    for home in home_paths:
        if limit_hit:
            break
        if not _home_is_readable(home):
            continue
        readable_homes += 1
        for directory in SESSION_DIRECTORIES:
            if limit_hit:
                break
            root = home / directory
            try:
                root_is_dir = root.is_dir()
            except OSError:
                root_is_dir = False
            if not root_is_dir:
                continue
            walk_errors = []
            for file_index, path in enumerate(_iter_session_files(root, walk_errors.append)):
                if (
                    files_scanned >= MAX_SESSION_FILES
                    or total_events >= MAX_TOTAL_EVENTS
                    or total_bytes >= MAX_TOTAL_BYTES
                ):
                    partial = True
                    _append_reason(reasons, REASON_LIMIT)
                    limit_hit = True
                    break
                files_scanned += 1
                scan = _scan_session_file(path, f"{readable_homes}-{directory}-{file_index}")
                total_bytes += scan["bytes"]
                if scan["unreadable"]:
                    partial = True
                    _append_reason(reasons, REASON_FILES_UNREADABLE)
                if scan["identity_missing"]:
                    partial = True
                    _append_reason(reasons, REASON_IDENTITY_UNAVAILABLE)
                if scan["saw_unprovable"]:
                    partial = True
                    _append_reason(reasons, REASON_ATTRIBUTION)
                if scan["saw_malformed"] or scan["truncated"]:
                    partial = True
                    _append_reason(reasons, REASON_MALFORMED)
                if scan["saw_approximation"]:
                    partial = True
                    _append_reason(reasons, REASON_CONTINUITY)
                for event in scan["events"]:
                    total_events += 1
                    if event["partial"]:
                        partial = True
                        _append_reason(reasons, REASON_CONTINUITY)
                    if event["no_timestamp"]:
                        partial = True
                        _append_reason(reasons, REASON_TIMESTAMP)
                        continue
                    when = event["when"]
                    if (when.year, when.month) != month_key:
                        continue
                    delta = event["delta"]
                    identity = (
                        event["key"],
                        when.isoformat(),
                        event["cumulative"],
                        tuple(delta[key] for key in COUNTER_KEYS),
                    )
                    session = event["session"]
                    if identity in owners:
                        # Canonical duplicate: the same turn copied or inherited
                        # between homes.  Count it once, but keep non-identical
                        # events so resumed branches and new fork work survive.
                        existing = owners[identity]
                        if session and (not existing or session < existing):
                            owners[identity] = session
                        continue
                    owners[identity] = session or ""
                    for key in COUNTER_KEYS:
                        counters[key] += delta[key]
            if walk_errors:
                partial = True
                _append_reason(reasons, REASON_FILES_UNREADABLE)

    if readable_homes == 0:
        return _unavailable_result(period, REASON_HOMES_UNAVAILABLE)
    if readable_homes < len(home_paths):
        partial = True
        _append_reason(reasons, REASON_SOME_HOMES_UNAVAILABLE)
    sessions = {owner for owner in owners.values() if owner}
    return _available_result(period, counters, len(sessions), partial, reasons)


def _append_reason(reasons, text):
    if text not in reasons:
        reasons.append(text)


def build_parser():
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    parser.add_argument(
        "--home",
        action="append",
        default=[],
        type=Path,
        help="Codex home to scan; repeat for multiple homes",
    )
    parser.add_argument(
        "--now",
        default=None,
        help="ISO-8601 reference time (defaults to the current UTC time)",
    )
    return parser


def main(argv=None):
    args = build_parser().parse_args(argv)
    if args.now:
        try:
            reference = datetime.fromisoformat(args.now.replace("Z", "+00:00"))
        except ValueError:
            print("deepseek-local-usage: invalid --now value", file=sys.stderr)
            return 2
    else:
        reference = datetime.now(timezone.utc)
    if reference.tzinfo is None:
        reference = reference.replace(tzinfo=timezone.utc)
    result = collect_month_usage(args.home, reference)
    print(json.dumps(result, indent=2, sort_keys=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
