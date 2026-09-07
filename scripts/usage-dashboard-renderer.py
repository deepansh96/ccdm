#!/usr/bin/env python3
"""Render a deterministic, trend-first usage dashboard PNG.

The renderer deliberately has no knowledge of credentials, registry files, or
Discord.  A caller supplies a JSON snapshot (or a snapshot/history JSON object)
and receives one PNG.  Pillow is the only runtime dependency::

    python3 scripts/usage-dashboard-renderer.py \
        --input usage-snapshot.json --output usage-dashboard.png

The input accepts the prototype's ``cards``/``history`` shape as well as an
account-oriented shape::

    {
      "generated_at": "2026-08-18T20:30:00Z",
      "accounts": [{
        "provider": "claude", "account": "personal",
        "limits": [{"window": "5-hour", "used_percent": 42,
                     "resets_at": "2026-08-18T23:00:00Z"}]
      }],
      "history": [{"at": "...", "values": {"claude:personal:5-hour": 20}}]
    }

Values with ``available: false`` (or no numeric percentage) remain visible as
unavailable rather than being drawn as zero.  A substantial downward step is
treated as a reset and marked in the graph.  Rendering is deterministic for a
given input: the clock is never consulted and PNG metadata is not written.
"""

from __future__ import annotations

import argparse
import json
import math
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError as exc:  # pragma: no cover - exercised by the CLI only
    raise SystemExit(
        "usage-dashboard-renderer.py requires Pillow; install it with "
        "python3 -m pip install Pillow"
    ) from exc


WIDTH = 1600
HEIGHT = 1000
BACKGROUND = "#f5f6f8"
INK = "#171a1f"
MUTED = "#68717d"
SURFACE = "#ffffff"
BORDER = "#dfe3e8"
RAIL = "#20262d"
RAIL_MUTED = "#9ba6b2"
GRID = "#d9dde2"
RESET = "#c88922"
UNAVAILABLE = "#8b949e"
PALETTE = (
    "#5b36c9",  # violet
    "#c8433c",  # coral
    "#087e9e",  # teal
    "#568d14",  # green
    "#b95c13",  # orange
    "#a12d91",  # magenta
    "#1f5fae",  # blue
    "#08734f",  # emerald
)
PLOT_VERTICAL_INSET = 10

_PERCENT_KEYS = (
    "used_percent",
    "utilization",
    "utilisation",
    "percent",
    "percentage",
    "value",
)
_FONT_PATHS = (
    "/System/Library/Fonts/SFNS.ttf",
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/dejavu/DejaVuSans.ttf",
)
_BOLD_FONT_PATHS = (
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "/System/Library/Fonts/SFNS.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf",
)


class DashboardError(ValueError):
    """Raised when a dashboard input cannot be interpreted safely."""


def _font(size: int, bold: bool = False, path: str | None = None) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    candidates = (path,) if path else (_BOLD_FONT_PATHS if bold else _FONT_PATHS)
    for candidate in candidates:
        if not candidate:
            continue
        try:
            return ImageFont.truetype(candidate, size=size)
        except OSError:
            continue
    # A tiny built-in font is preferable to failing the complete report on a
    # headless host.  Normal production hosts use one of the fixed paths above.
    return ImageFont.load_default()


def _number(value: Any) -> float | None:
    if isinstance(value, bool) or value is None:
        return None
    try:
        value = float(value)
    except (TypeError, ValueError):
        return None
    return value if math.isfinite(value) else None


def _text(value: Any, fallback: str = "") -> str:
    if isinstance(value, str) and value.strip():
        return " ".join(value.split())
    return fallback


def _slug(value: Any) -> str:
    return re.sub(r"[^a-z0-9]+", "_", _text(value).lower()).strip("_")


def _time(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        result = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    if result.tzinfo is None:
        return result.replace(tzinfo=timezone.utc)
    return result


def _time_key(value: datetime | None, original_index: int) -> tuple[float, int]:
    return ((value or datetime.min.replace(tzinfo=timezone.utc)).timestamp(), original_index)


def _duration(reset_at: Any, generated_at: datetime | None) -> str | None:
    if not reset_at or generated_at is None:
        return None
    reset = _time(reset_at)
    if reset is None:
        return None
    minutes = max(0, int((reset - generated_at).total_seconds() // 60))
    if minutes < 60:
        return f"{minutes}m"
    hours, remainder = divmod(minutes, 60)
    if hours >= 24:
        days, hours = divmod(hours, 24)
        return f"{days}d {hours}h"
    return f"{hours}h {remainder}m"


def _parse_color(value: Any) -> str | None:
    if isinstance(value, str) and re.fullmatch(r"#[0-9a-fA-F]{6}", value):
        return value.lower()
    return None


def _status(raw: dict[str, Any], value: float | None) -> tuple[bool, str | None]:
    status = _text(raw.get("status")).lower()
    available = raw.get("available", True)
    if available is False or status in {"unavailable", "error", "unknown", "missing"}:
        return False, _text(raw.get("reason") or raw.get("error"), "Data unavailable")
    if value is None:
        return False, _text(raw.get("reason") or raw.get("error"), "No usage value")
    return True, None


def _raw_value(raw: Any) -> float | None:
    if isinstance(raw, dict):
        for key in _PERCENT_KEYS:
            if key in raw:
                return _number(raw[key])
        return None
    return _number(raw)


def _limit_rows(account: dict[str, Any]) -> Iterable[dict[str, Any]]:
    limits = account.get(
        "limits",
        account.get("cards", account.get("windows", account.get("rate_limits", account.get("usage")))),
    )
    if isinstance(limits, list):
        for limit in limits:
            if isinstance(limit, dict):
                yield {**account, **limit}
        return
    if isinstance(limits, dict):
        for window, limit in limits.items():
            if isinstance(limit, dict):
                yield {**account, **limit, "window": limit.get("window", window)}
            else:
                yield {**account, "window": window, "used_percent": limit}


def _row_key(row: dict[str, Any]) -> str:
    explicit = _text(row.get("key") or row.get("id") or row.get("series"))
    if explicit:
        return explicit
    provider = _slug(row.get("provider", row.get("source")))
    account = _slug(row.get("account", row.get("account_name", row.get("alias"))))
    window = _slug(row.get("window", row.get("period")))
    return ":".join(part for part in (provider, account, window) if part)


def _card_rows(data: dict[str, Any]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    direct = data.get("cards", data.get("limits"))
    if isinstance(direct, list):
        rows.extend(row for row in direct if isinstance(row, dict))
    elif isinstance(direct, dict):
        rows.extend(
            {**value, "key": value.get("key", key)} if isinstance(value, dict) else {"key": key, "used_percent": value}
            for key, value in direct.items()
        )

    accounts = data.get("accounts")
    if isinstance(accounts, list):
        for account in accounts:
            if isinstance(account, dict):
                rows.extend(_limit_rows(account))
    elif isinstance(accounts, dict):
        for name, account in accounts.items():
            if isinstance(account, dict):
                rows.extend(_limit_rows({"account": name, **account}))

    # This convenience shape makes it easy for collectors to emit one provider
    # object without first constructing an accounts array.
    for provider in ("claude", "codex"):
        source = data.get(provider)
        if isinstance(source, dict):
            rows.extend(_limit_rows({"provider": provider, **source}))
        elif isinstance(source, list):
            for account in source:
                if isinstance(account, dict):
                    rows.extend(_limit_rows({"provider": provider, **account}))
    return rows


def _make_card(raw: dict[str, Any], index: int, generated_at: datetime | None) -> dict[str, Any]:
    provider = _text(raw.get("provider", raw.get("source")), "Usage")
    provider_key = _slug(provider) or "usage"
    account = _text(raw.get("account", raw.get("account_name", raw.get("alias"))))
    window = _text(raw.get("window", raw.get("period")), "Limit")
    label = _text(raw.get("label"), provider.title() if provider_key in {"claude", "codex"} else provider)
    explicit_key = _text(raw.get("key") or raw.get("id") or raw.get("series"))
    key = explicit_key or ":".join(part for part in (provider_key, _slug(account), _slug(window)) if part)
    key = key or f"series-{index + 1}"
    value = _raw_value(raw)
    available, reason = _status(raw, value)
    explicit_unavailable = raw.get("available") is False or _text(raw.get("status")).lower() in {
        "unavailable", "error", "unknown", "missing"
    }
    if available:
        value = max(0.0, min(100.0, value or 0.0))
    else:
        value = None
    reset = _text(raw.get("reset") or raw.get("resets_in") or raw.get("reset_after"))
    reset = reset or _duration(raw.get("resets_at") or raw.get("reset_at"), generated_at)
    aliases = {key, explicit_key, _slug(key)}
    aliases.update(
        value for value in (
            ":".join(part for part in (provider_key, _slug(account), _slug(window)) if part),
            "/".join(part for part in (provider_key, _slug(account), _slug(window)) if part),
            _slug(f"{label}_{window}"),
        ) if value
    )
    return {
        "key": key,
        "aliases": frozenset(aliases),
        "provider": provider,
        "provider_key": provider_key,
        "account": account,
        "label": label,
        "window": window,
        "used_percent": value,
        "available": available,
        "explicit_unavailable": explicit_unavailable,
        "reason": reason,
        "reset": reset,
        "color": _parse_color(raw.get("color")),
    }


def _snapshot_entries(raw: Any) -> dict[str, Any]:
    """Flatten the common history value shapes into key -> raw value."""
    result: dict[str, Any] = {}
    if not isinstance(raw, dict):
        return result
    for key, value in raw.items():
        if key not in {
            "at", "timestamp", "generated_at", "reset", "resets", "reset_events", "available",
            "values", "limits", "usage", "data", "cards",
        }:
            result[str(key)] = value
    for nested_key in ("values", "limits", "usage", "data"):
        nested = raw.get(nested_key)
        if isinstance(nested, dict):
            result.update({str(key): value for key, value in nested.items()})
        elif isinstance(nested, list):
            for item in nested:
                if isinstance(item, dict):
                    item_key = _text(item.get("key") or item.get("id") or item.get("series"))
                    if item_key:
                        result[item_key] = item
    cards = raw.get("cards")
    if isinstance(cards, list):
        for item in cards:
            if isinstance(item, dict):
                item_key = _row_key(item)
                if item_key:
                    result[item_key] = item
    accounts = raw.get("accounts")
    if isinstance(accounts, list):
        account_rows = (row for account in accounts if isinstance(account, dict) for row in _limit_rows(account))
        for item in account_rows:
            item_key = _row_key(item)
            if item_key:
                result[item_key] = item
    elif isinstance(accounts, dict):
        for account_name, account in accounts.items():
            if not isinstance(account, dict):
                continue
            for item in _limit_rows({"account": account_name, **account}):
                item_key = _row_key(item)
                if item_key:
                    result[item_key] = item
    for provider in ("claude", "codex"):
        source = raw.get(provider)
        if not isinstance(source, dict):
            continue
        if any(key in source for key in ("limits", "cards", "windows", "rate_limits", "usage")):
            provider_rows = _limit_rows({"provider": provider, **source})
        else:
            provider_rows = (
                row
                for account_name, account in source.items()
                if isinstance(account, dict)
                for row in _limit_rows({"provider": provider, "account": account_name, **account})
            )
        for item in provider_rows:
            item_key = _row_key(item)
            if item_key:
                result[item_key] = item
    return result


def _match_value(entries: dict[str, Any], card: dict[str, Any]) -> tuple[float | None, bool | None, str | None]:
    for key, raw in entries.items():
        if _slug(key) not in card["aliases"] and key not in card["aliases"]:
            continue
        value = _raw_value(raw)
        if isinstance(raw, dict):
            available, reason = _status(raw, value)
            return (max(0.0, min(100.0, value)) if available and value is not None else None, available, reason)
        return (max(0.0, min(100.0, value)) if value is not None else None, value is not None, None)
    return None, None, None


def _history(data: dict[str, Any], cards: list[dict[str, Any]]) -> list[dict[str, Any]]:
    source = data.get("history", data.get("snapshots", []))
    if isinstance(source, dict):
        source = [value for value in source.values() if isinstance(value, dict)]
    if not isinstance(source, list):
        return []
    points: list[dict[str, Any]] = []
    for original_index, snapshot in enumerate(source):
        if not isinstance(snapshot, dict):
            continue
        at = _time(snapshot.get("at", snapshot.get("timestamp", snapshot.get("generated_at"))))
        entries = _snapshot_entries(snapshot)
        values: dict[str, float | None] = {}
        available: dict[str, bool] = {}
        reasons: dict[str, str] = {}
        for card in cards:
            value, is_available, reason = _match_value(entries, card)
            values[card["key"]] = value
            if is_available is not None:
                available[card["key"]] = is_available
            if reason:
                reasons[card["key"]] = reason
        points.append({
            "at": at,
            "values": values,
            "available": available,
            "reasons": reasons,
            "reset": bool(snapshot.get("reset") or snapshot.get("reset_events") or snapshot.get("resets")),
            "index": original_index,
        })
    points.sort(key=lambda item: _time_key(item["at"], item["index"]))
    return points


def _chart_cards(normalized: dict[str, Any]) -> list[dict[str, Any]]:
    """Return only series with at least one finite, plottable history value."""
    history = normalized["history"]
    cards = normalized["cards"]
    return [
        card
        for card in cards
        if any(
            (value := _number(point.get("values", {}).get(card["key"]))) is not None
            and point.get("available", {}).get(card["key"], True) is not False
            for point in history
        )
    ]


def normalize_data(raw: dict[str, Any]) -> dict[str, Any]:
    """Normalize supported JSON shapes into the renderer's stable internal form."""
    if not isinstance(raw, dict):
        raise DashboardError("input must be a JSON object")
    generated_at = _time(raw.get("generated_at", raw.get("updated_at")))
    raw_cards = _card_rows(raw)
    cards: list[dict[str, Any]] = []
    seen: dict[str, int] = {}
    for index, item in enumerate(raw_cards):
        card = _make_card(item, index, generated_at)
        count = seen.get(card["key"], 0) + 1
        seen[card["key"]] = count
        if count > 1:
            card["key"] = f"{card['key']}#{count}"
            card["aliases"] = frozenset(set(card["aliases"]) | {card["key"]})
        cards.append(card)

    history = _history(raw, cards)
    if not cards and history:
        # A history-only payload still gets a useful graph.  Keys are treated as
        # series labels; current values come from the last point below.
        # ``_history`` cannot map values without cards, so inspect the raw
        # snapshots directly for this history-only convenience shape.
        source = raw.get("history", raw.get("snapshots", []))
        if isinstance(source, dict):
            source = list(source.values())
        keys = sorted({key for snapshot in source if isinstance(snapshot, dict) for key in _snapshot_entries(snapshot)})
        cards = [_make_card({"key": key, "label": key}, index, generated_at) for index, key in enumerate(keys)]
        history = _history(raw, cards)

    latest = history[-1] if history else None
    for card in cards:
        if card["used_percent"] is None and not card["explicit_unavailable"] and latest and card["key"] in latest["values"]:
            if latest["available"].get(card["key"], latest["values"][card["key"]] is not None):
                card["used_percent"] = latest["values"][card["key"]]
                card["available"] = card["used_percent"] is not None
                card["reason"] = None

    if generated_at is None and latest and latest["at"] is not None:
        generated_at = latest["at"]
    for index, card in enumerate(cards):
        if not card["color"]:
            card["color"] = PALETTE[index % len(PALETTE)]
    providers_with_accounts = {
        provider: len({card["account"] for card in cards if card["provider"] == provider and card["account"]})
        for provider in {card["provider"] for card in cards}
    }
    for card in cards:
        account_required = providers_with_accounts.get(card["provider"], 0) > 1
        card["display"] = (
            f"{card['label']} · {card['account']} · {card['window']}"
            if account_required and card["account"]
            else f"{card['label']} · {card['window']}"
        )
    notes = []
    for raw_note in raw.get("notes", []):
        if not isinstance(raw_note, dict):
            continue
        title = _text(raw_note.get("title"))
        lines = raw_note.get("lines")
        if not title or not isinstance(lines, list):
            continue
        safe_lines = [_text(line)[:160] for line in lines if _text(line)]
        if safe_lines:
            notes.append({"title": title[:160], "lines": safe_lines[:4]})
    return {"generated_at": generated_at, "cards": cards, "history": history, "notes": notes}


def _measure(draw: ImageDraw.ImageDraw, value: str, font: ImageFont.ImageFont) -> tuple[int, int]:
    box = draw.textbbox((0, 0), value, font=font)
    return box[2] - box[0], box[3] - box[1]


def _fit(value: str, draw: ImageDraw.ImageDraw, font: ImageFont.ImageFont, width: int) -> str:
    if _measure(draw, value, font)[0] <= width:
        return value
    suffix = "…"
    while value and _measure(draw, value + suffix, font)[0] > width:
        value = value[:-1]
    return (value.rstrip() + suffix) if value else suffix


def rounded_rectangle(draw: ImageDraw.ImageDraw, box: tuple[int, int, int, int], radius: int, fill: str, outline: str | None = None, width: int = 1) -> None:
    """Draw a rounded rectangle on Pillow versions without rounded_rectangle."""
    x1, y1, x2, y2 = (int(value) for value in box)
    radius = max(0, min(int(radius), (x2 - x1) // 2, (y2 - y1) // 2))

    def fill_round(bounds: tuple[int, int, int, int], corner: int, color: str) -> None:
        bx1, by1, bx2, by2 = bounds
        draw.rectangle((bx1 + corner, by1, bx2 - corner, by2), fill=color)
        draw.rectangle((bx1, by1 + corner, bx2, by2 - corner), fill=color)
        draw.pieslice((bx1, by1, bx1 + 2 * corner, by1 + 2 * corner), 180, 270, fill=color)
        draw.pieslice((bx2 - 2 * corner, by1, bx2, by1 + 2 * corner), 270, 360, fill=color)
        draw.pieslice((bx1, by2 - 2 * corner, bx1 + 2 * corner, by2), 90, 180, fill=color)
        draw.pieslice((bx2 - 2 * corner, by2 - 2 * corner, bx2, by2), 0, 90, fill=color)

    if outline and width > 0:
        fill_round((x1, y1, x2, y2), radius, outline)
        inset = min(width, max(0, radius - 1), (x2 - x1) // 2, (y2 - y1) // 2)
        if inset:
            fill_round((x1 + inset, y1 + inset, x2 - inset, y2 - inset), radius - inset, fill)
        return
    fill_round((x1, y1, x2, y2), radius, fill)


def _segments(points: list[tuple[int, int] | None]) -> Iterable[list[tuple[int, int]]]:
    segment: list[tuple[int, int]] = []
    for point in points:
        if point is None:
            if segment:
                yield segment
                segment = []
        else:
            segment.append(point)
    if segment:
        yield segment


def _draw_legend(draw: ImageDraw.ImageDraw, cards: list[dict[str, Any]], box: tuple[int, int, int, int], show_accounts: bool) -> int:
    x1, y1, x2, _ = box
    x, y = x1, y1
    text_font = _font(16)
    row_height = 30
    for index, card in enumerate(cards):
        text = card["display"] if show_accounts else f"{card['label']} · {card['window']}"
        item_width = 18 + _measure(draw, text, text_font)[0] + 28
        if x != x1 and x + item_width > x2:
            x, y = x1, y + row_height
        color = card["color"] if card["available"] else UNAVAILABLE
        if index % 3 == 0:
            draw.ellipse((x, y + 8, x + 11, y + 19), fill=color)
        elif index % 3 == 1:
            draw.rectangle((x, y + 8, x + 11, y + 19), fill=color)
        else:
            draw.polygon(((x + 5, y + 7), (x + 12, y + 19), (x, y + 19)), fill=color)
        draw.text((x + 20, y), _fit(text, draw, text_font, max(80, x2 - x - 20)), font=text_font, fill="#414952")
        x += item_width
    return y + row_height if cards else y


def _drop_indexes(card: dict[str, Any], history: list[dict[str, Any]]) -> set[int]:
    drops: set[int] = set()
    previous: float | None = None
    for index, point in enumerate(history):
        value = point["values"].get(card["key"])
        if value is not None and previous is not None and value < previous - 8:
            drops.add(index)
        if point["reset"] and value is not None:
            drops.add(index)
        if value is not None:
            previous = value
    return drops


def _history_x_positions(history: list[dict[str, Any]], px1: int, px2: int) -> list[int]:
    """Place snapshots by elapsed time instead of list position when possible."""
    if len(history) <= 1:
        return [px1 for _ in history]
    timestamps = [point["at"].timestamp() if point.get("at") else None for point in history]
    if any(value is None for value in timestamps) or timestamps[-1] <= timestamps[0]:
        denominator = max(1, len(history) - 1)
        return [px1 + int((px2 - px1) * index / denominator) for index in range(len(history))]
    elapsed = timestamps[-1] - timestamps[0]
    return [px1 + int((px2 - px1) * (value - timestamps[0]) / elapsed) for value in timestamps]


def _history_tick_indexes(history: list[dict[str, Any]], x_positions: list[int], min_spacing: int = 120) -> list[int]:
    """Choose readable boundary and quarter ticks without changing point positions."""
    count = len(history)
    if count <= 1:
        return list(range(count))

    candidates = sorted(set([0, count - 1, count // 4, count // 2, (count * 3) // 4]))
    spacing = max(1, int(min_spacing))
    selected = [candidates[0]]
    for index in candidates[1:-1]:
        if x_positions[index] - x_positions[selected[-1]] >= spacing:
            selected.append(index)

    # The last timestamp is always meaningful.  If it would collide with an
    # interior tick, drop that interior tick while retaining the boundary.
    last = candidates[-1]
    if x_positions[last] - x_positions[selected[-1]] < spacing and len(selected) > 1:
        selected.pop()
    selected.append(last)
    return selected


def _history_coverage_label(history: list[dict[str, Any]]) -> str:
    """Describe the span covered by valid history timestamps for the heading."""
    timestamps = [
        point["at"]
        for point in history
        if isinstance(point, dict) and isinstance(point.get("at"), datetime)
    ]
    if len(timestamps) < 2:
        return "RECENT SNAPSHOT"

    span_minutes = max(0, int((max(timestamps) - min(timestamps)).total_seconds() // 60))
    # The history query targets the previous day.  Keep the established title
    # when the available coverage is within one hour of that target window.
    if 23 * 60 <= span_minutes < 25 * 60:
        return "24-HOUR TRAJECTORY"
    if span_minutes < 60:
        minutes = max(1, span_minutes)
        return f"LAST {minutes} MINUTE{'S' if minutes != 1 else ''}"

    days, remaining_minutes = divmod(span_minutes, 24 * 60)
    hours, minutes = divmod(remaining_minutes, 60)
    if days:
        label = f"LAST {days} DAY{'S' if days != 1 else ''}"
        if hours:
            label += f" {hours} HOUR{'S' if hours != 1 else ''}"
        return label
    if minutes == 0:
        return f"LAST {hours} HOUR{'S' if hours != 1 else ''}"
    return f"LAST {hours} HOUR{'S' if hours != 1 else ''} {minutes} MINUTE{'S' if minutes != 1 else ''}"


def _history_tick_label(when: datetime | None, include_date: bool) -> str:
    if when is None:
        return "unknown"
    time_label = when.strftime("%I:%M %p").lstrip("0")
    return f"{when.strftime('%b')} {when.day}\n{time_label}" if include_date else time_label


def _reset_annotation_layout(
    reset_xs: Iterable[int],
    px1: int,
    px2: int,
    label_width: int,
    minimum_gap: int = 12,
) -> list[tuple[int, int, int]]:
    """Return bounded, collision-free ``(anchor, text_x, lane)`` labels."""
    anchors = sorted({max(px1, min(px2, int(value))) for value in reset_xs})
    if not anchors:
        return []
    width = max(1, int(label_width))
    gap = max(0, int(minimum_gap))
    lanes: list[list[tuple[int, int]]] = []
    layout: list[tuple[int, int, int]] = []
    for anchor in anchors:
        text_x = max(px1, min(anchor - width // 2, px2 - width))
        text_bounds = (text_x, text_x + width)
        lane = 0
        while lane < len(lanes) and any(
            text_bounds[0] < previous[1] + gap and text_bounds[1] > previous[0] - gap
            for previous in lanes[lane]
        ):
            lane += 1
        if lane == len(lanes):
            lanes.append([])
        lanes[lane].append(text_bounds)
        layout.append((anchor, text_x, lane))
    return layout


def _plot_y_bounds(py1: int, py2: int) -> tuple[int, int]:
    """Return the inset y-range used for percentage data and grid lines."""
    inset = min(PLOT_VERTICAL_INSET, max(0, (py2 - py1) // 2))
    return py1 + inset, py2 - inset


def _plot_y(percent: float, py1: int, py2: int) -> int:
    """Map a clamped percentage linearly into the inset plot y-range."""
    inner_py1, inner_py2 = _plot_y_bounds(py1, py2)
    value = max(0.0, min(100.0, float(percent)))
    return inner_py2 - int((inner_py2 - inner_py1) * value / 100)


def _series_marker(draw: ImageDraw.ImageDraw, x: int, y: int, color: str, style: int, size: int = 4) -> None:
    """Draw a shape cue so overlapping series are not color-only."""
    if style % 3 == 0:
        draw.ellipse((x - size, y - size, x + size, y + size), fill=BACKGROUND, outline=color, width=2)
    elif style % 3 == 1:
        draw.rectangle((x - size, y - size, x + size, y + size), fill=BACKGROUND, outline=color, width=2)
    else:
        draw.polygon(((x, y - size - 1), (x - size - 1, y + size), (x + size + 1, y + size)), fill=BACKGROUND, outline=color)


def draw_trend_chart(draw: ImageDraw.ImageDraw, normalized: dict[str, Any], box: tuple[int, int, int, int]) -> None:
    x1, y1, x2, y2 = box
    history = normalized["history"]
    cards = _chart_cards(normalized)
    light_muted = MUTED
    plot = (x1 + 72, y1 + 126, x2 - 28, y2 - 88)
    px1, py1, px2, py2 = plot
    for percent in (0, 25, 50, 75, 100):
        y = _plot_y(percent, py1, py2)
        draw.line((px1, y, px2, y), fill=GRID, width=2)
        label = f"{percent}%"
        label_width = _measure(draw, label, _font(17))[0]
        draw.text((px1 - label_width - 15, y - 10), label, font=_font(17), fill=light_muted)

    if not history:
        draw.text((px1 + 20, (py1 + py2) // 2 - 12), "No historical snapshots available", font=_font(22, True), fill=MUTED)
        return
    count = len(history)
    x_positions = _history_x_positions(history, px1, px2)
    tick_indexes = _history_tick_indexes(history, x_positions)
    crosses_days = len({point["at"].date() for point in history if point.get("at")}) > 1
    for index in tick_indexes:
        x = x_positions[index]
        draw.line((x, py1, x, py2), fill=GRID, width=1)
        when = history[index]["at"]
        label = _history_tick_label(when, crosses_days)
        label_width = _measure(draw, label, _font(16))[0]
        draw.multiline_text((x - label_width / 2, py2 + 24), label, font=_font(16), fill=light_muted, spacing=1, align="center")

    reset_xs: set[int] = set()
    for card_index, card in enumerate(cards):
        points: list[tuple[int, int] | None] = []
        for index, point in enumerate(history):
            value = point["values"].get(card["key"])
            if value is None or point["available"].get(card["key"], True) is False:
                points.append(None)
                continue
            x = x_positions[index]
            y = _plot_y(value, py1, py2)
            points.append((x, y))
        color = card["color"] if card["available"] else UNAVAILABLE
        for segment in _segments(points):
            if len(segment) == 1:
                x, y = segment[0]
                _series_marker(draw, x, y, color, card_index, 5)
            else:
                draw.line(segment, fill=color, width=4, joint="curve")
        for point in points:
            if point is not None:
                _series_marker(draw, point[0], point[1], color, card_index)
        for index in _drop_indexes(card, history):
            if index >= len(points) or points[index] is None:
                continue
            x, y = points[index]  # type: ignore[misc]
            reset_xs.add(x)
            for marker_y in range(py1 + 2, py2, 10):
                draw.line((x, marker_y, x, min(marker_y + 5, py2)), fill=RESET, width=1)
            draw.polygon(((x, y - 13), (x - 6, y - 4), (x + 6, y - 4)), fill=RESET)
        available_points = [point for point in points if point is not None]
        if available_points:
            end_x, end_y = available_points[-1]
            _series_marker(draw, end_x, end_y, color, card_index, 7)
    if reset_xs:
        reset_font = _font(13, True)
        reset_label = "RESET"
        label_width, label_height = _measure(draw, reset_label, reset_font)
        label_layout = _reset_annotation_layout(reset_xs, px1, px2, label_width)
        label_top = py1 - label_height - 22
        for anchor, text_x, lane in label_layout:
            label_y = label_top - lane * (label_height + 8)
            draw.text((text_x, label_y), reset_label, font=reset_font, fill=RESET)
            # Keep the label visibly tied to the dashed event line without
            # consuming the x-axis label band below the plot.
            if lane == 0:
                draw.line((anchor, label_y + label_height + 3, anchor, py1 - 2), fill=RESET, width=1)
    footer = f"Historical snapshots · {len(history)} point{'s' if len(history) != 1 else ''}"
    if any(_drop_indexes(card, history) for card in cards):
        footer += " · reset drops marked"
    draw.text((x2 - _measure(draw, footer, _font(16))[0] - 4, y2 - 48), footer, font=_font(16), fill=MUTED)


def _rail_groups(cards: list[dict[str, Any]]) -> list[list[dict[str, Any]]]:
    """Group current-limit cards by provider/account while preserving order."""
    groups: list[list[dict[str, Any]]] = []
    indexes: dict[tuple[str, str], int] = {}
    for card in cards:
        key = (card["provider"], card["account"])
        group_index = indexes.get(key)
        if group_index is None:
            group_index = len(groups)
            indexes[key] = group_index
            groups.append([])
        groups[group_index].append(card)
    return groups


def _rail_value_layout(metric_y: int, value_font: ImageFont.ImageFont) -> tuple[int, int]:
    """Return the value text y-position and a safely separated bar y-position."""
    value_y = metric_y - 4
    # Reserve the full glyph box (including Pillow's font ascent offset) before
    # starting the bar.  This keeps wide values such as ``100%`` readable.
    value_bottom = value_y + value_font.getbbox("100%")[3]
    return value_y, value_bottom + 6


def _availability_summary(cards: list[dict[str, Any]]) -> str:
    """Summarize availability across every current limit window."""
    total = len(cards)
    if total == 0:
        return "No limits available"
    available = sum(1 for card in cards if card.get("available") is True)
    if available == total:
        return "All limits available"
    return f"{available} of {total} limits available"


def _rail_notes_height(notes: list[dict[str, Any]]) -> int:
    """Reserve a legible, dedicated space for API-only cost facts."""
    return sum(126 + max(0, len(note.get("lines", [])) - 2) * 18 for note in notes)


def _draw_rail(draw: ImageDraw.ImageDraw, normalized: dict[str, Any], box: tuple[int, int, int, int]) -> None:
    x1, y1, x2, y2 = box
    cards = normalized["cards"]
    notes = normalized.get("notes", [])
    rounded_rectangle(draw, box, 24, RAIL)
    draw.text((x1 + 34, y1 + 38), "NOW", font=_font(16, True), fill=RAIL_MUTED)
    draw.text((x1 + 34, y1 + 70), "Current limits", font=_font(30, True), fill="#f8fafc")
    subtitle = _availability_summary(cards)
    draw.text((x1 + 34, y1 + 114), subtitle, font=_font(17), fill=RAIL_MUTED)
    if not cards:
        draw.text((x1 + 34, y1 + 166), "No current limits", font=_font(20), fill=RAIL_MUTED)
        _draw_rail_notes(draw, notes, x1, y2 - 28, x2)
        return

    content_y = y1 + 166
    note_height = _rail_notes_height(notes)
    content_height = y2 - content_y - 28 - note_height - (16 if notes else 0)
    groups = _rail_groups(cards)
    if any(len(group) > 1 for group in groups):
        row_height = max(82, min(142, content_height // len(groups)))
        small = _font(13)
        name_font = _font(18, True)
        value_font = _font(max(24, min(34, row_height - 66)), False)
        account_counts = {
            provider: len({card["account"] for card in cards if card["provider"] == provider and card["account"]})
            for provider in {card["provider"] for card in cards}
        }
        for index, group in enumerate(groups):
            row_y = content_y + index * row_height
            if index:
                draw.line((x1 + 34, row_y - 11, x2 - 34, row_y - 11), fill="#39424c", width=2)
            first = group[0]
            name = first["label"]
            if first["account"] and account_counts.get(first["provider"], 0) > 1:
                name = f"{name} · {first['account']}"
            draw.text((x1 + 34, row_y), _fit(name, draw, name_font, x2 - x1 - 68), font=name_font, fill="#f8fafc")

            metric_y = row_y + 29
            available_width = x2 - x1 - 68
            gap = 12 if len(group) > 1 else 0
            tile_width = (available_width - gap * (len(group) - 1)) // len(group)
            for metric_index, card in enumerate(group):
                tile_x = x1 + 34 + metric_index * (tile_width + gap)
                tile_x2 = tile_x + tile_width
                window = _fit(card["window"], draw, small, max(42, tile_width - 56))
                draw.text((tile_x, metric_y), window, font=small, fill=RAIL_MUTED)
                if card["available"]:
                    value_text = f"{card['used_percent']:g}%"
                    value_color = card["color"]
                else:
                    value_text = "—"
                    value_color = UNAVAILABLE
                value_width = _measure(draw, value_text, value_font)[0]
                value_y, bar_y = _rail_value_layout(metric_y, value_font)
                draw.text((tile_x2 - value_width, value_y), value_text, font=value_font, fill=value_color)
                bar = (tile_x, bar_y, tile_x2, bar_y + 9)
                rounded_rectangle(draw, bar, 5, "#39424c")
                if card["available"]:
                    fill_width = max(8, int((bar[2] - bar[0]) * card["used_percent"] / 100))
                    rounded_rectangle(draw, (bar[0], bar[1], bar[0] + fill_width, bar[3]), 5, card["color"])
                reset_text = f"reset {card['reset']}" if card["reset"] else (card["reason"] or "reset unavailable")
                draw.text((tile_x, bar_y + 13), _fit(reset_text, draw, small, tile_width), font=small, fill=RAIL_MUTED)
        _draw_rail_notes(draw, notes, x1, y2 - 28, x2)
        return

    row_height = max(48, min(142, content_height // len(cards)))
    small = _font(15)
    name_font = _font(18, True)
    value_font = _font(max(25, min(42, row_height - 25)), False)
    compact = row_height < 79
    for index, card in enumerate(cards):
        row_y = content_y + index * row_height
        if index:
            draw.line((x1 + 34, row_y - 11, x2 - 34, row_y - 11), fill="#39424c", width=2)
        name = card["label"]
        if card["account"] and len({item["account"] for item in cards if item["provider"] == card["provider"]}) > 1:
            name = f"{name} · {card['account']}"
        draw.text((x1 + 34, row_y), _fit(name, draw, name_font, 210), font=name_font, fill="#f8fafc")
        window_text = card["window"]
        if compact and card["reset"]:
            window_text = f"{window_text} · {card['reset']}"
        draw.text((x1 + 34, row_y + (22 if compact else 28)), _fit(window_text, draw, small, 170), font=small, fill=RAIL_MUTED)
        if card["available"]:
            value_text = f"{card['used_percent']:g}%"
            value_color = card["color"]
        else:
            value_text = "—"
            value_color = UNAVAILABLE
        value_width = _measure(draw, value_text, value_font)[0]
        draw.text((x2 - 34 - value_width, row_y - 3), value_text, font=value_font, fill=value_color)
        # Keep the reset/status line below the bar.  With eight cards the
        # previous geometry put both at the same y-coordinate, making the
        # rail unreadable; compact rows fold reset timing into the subtitle.
        bar_offset = 40 if compact else min(65, max(44, row_height - 31))
        bar_y = row_y + bar_offset
        bar = (x1 + 34, bar_y, x2 - 34, bar_y + 12)
        rounded_rectangle(draw, bar, 6, "#39424c")
        if card["available"]:
            fill_width = max(10, int((bar[2] - bar[0]) * card["used_percent"] / 100))
            rounded_rectangle(draw, (bar[0], bar[1], bar[0] + fill_width, bar[3]), 6, card["color"])
        if not compact:
            reset_text = f"Resets in {card['reset']}" if card["reset"] else (card["reason"] or "Reset time unavailable")
            # Keep reset text with its own bar. Aligning it to the row bottom
            # makes a sparse multi-account rail collide with the next title.
            reset_y = bar_y + 18
            draw.text((x1 + 34, reset_y), _fit(reset_text, draw, small, x2 - x1 - 68), font=small, fill=RAIL_MUTED)
    _draw_rail_notes(draw, notes, x1, y2 - 28, x2)


def _draw_rail_notes(draw: ImageDraw.ImageDraw, notes: list[dict[str, Any]], x1: int, bottom: int, x2: int) -> None:
    """Draw a dedicated API-cost section, separate from rate-limit cards."""
    if not notes:
        return
    height = _rail_notes_height(notes)
    y = max(300, bottom - height)
    for note in notes:
        rounded_rectangle(draw, (x1 + 24, y, x2 - 24, y + 116), 12, "#2c353f")
        draw.text((x1 + 38, y + 13), "API USAGE", font=_font(12, True), fill="#b9c3ce")
        draw.text((x1 + 38, y + 31), _fit(note["title"], draw, _font(16, True), x2 - x1 - 76), font=_font(16, True), fill="#f8fafc")
        usage_lines = [line for line in note["lines"] if line.startswith(("Today", "This month"))]
        if len(usage_lines) >= 2:
            for index, line in enumerate(usage_lines[:2]):
                label = "Today" if line.startswith("Today") else "This month"
                value = line[len(label):].strip()
                cost, _, requests = value.partition(" · ")
                column_x = x1 + 38 + index * ((x2 - x1 - 76) // 2)
                draw.text((column_x, y + 56), label.upper(), font=_font(11, True), fill=RAIL_MUTED)
                draw.text((column_x, y + 70), _fit(cost, draw, _font(22, True), (x2 - x1 - 84) // 2), font=_font(22, True), fill="#f8fafc")
                draw.text((column_x, y + 97), _fit(requests, draw, _font(11), (x2 - x1 - 84) // 2), font=_font(11), fill=RAIL_MUTED)
        else:
            line = note["lines"][0] if note["lines"] else "Local usage unavailable"
            draw.text((x1 + 38, y + 62), _fit(line, draw, _font(16), x2 - x1 - 76), font=_font(16), fill=RAIL_MUTED)
        y += 126


def render_dashboard(data: dict[str, Any], output: str | Path) -> Path:
    """Render ``data`` to ``output`` and return its resolved path."""
    normalized = normalize_data(data)
    image = Image.new("RGB", (WIDTH, HEIGHT), BACKGROUND)
    draw = ImageDraw.Draw(image)
    generated_at = normalized["generated_at"]
    draw.text((38, 28), "LIMIT OBSERVATORY", font=_font(20, True), fill="#41505f")
    draw.text((38, 64), "Where your usage is headed", font=_font(43, True), fill=INK)
    updated = generated_at.strftime("%b %d  ·  %I:%M %p").replace(" 0", " ") if generated_at else "Updated time unavailable"
    updated_width = _measure(draw, updated, _font(20))[0]
    draw.text((1562 - updated_width, 53), updated, font=_font(20), fill=MUTED)

    main_box = (32, 136, 1150, 968)
    rounded_rectangle(draw, main_box, 24, BORDER)
    rounded_rectangle(draw, (34, 138, 1148, 966), 22, SURFACE)
    draw.text((70, 170), _history_coverage_label(normalized["history"]), font=_font(16, True), fill=MUTED)
    draw.text((70, 205), "Usage grows; resets create the sharp drops.", font=_font(31, True), fill=INK)
    chart_cards = _chart_cards(normalized)
    show_accounts = len({(card["provider"], card["account"]) for card in chart_cards if card["account"]}) > 1
    legend_end = _draw_legend(draw, chart_cards, (70, 263, 1110, 330), show_accounts)
    chart_box = (52, max(legend_end + 1, 288), 1130, 935)
    draw_trend_chart(draw, {**normalized, "cards": chart_cards}, chart_box)
    _draw_rail(draw, normalized, (1176, 136, 1568, 968))

    target = Path(output)
    target.parent.mkdir(parents=True, exist_ok=True)
    # Explicit compression and no metadata keep byte output stable across runs.
    image.save(target, format="PNG", optimize=False, compress_level=9)
    return target.resolve()


def render_trend_first(data: dict[str, Any], output: str | Path) -> Path:
    """Compatibility name for callers migrating from the prototype renderer."""
    return render_dashboard(data, output)


def _load_json(path: str) -> dict[str, Any]:
    if path == "-":
        raw = json.load(sys.stdin)
    else:
        with Path(path).open(encoding="utf-8") as handle:
            raw = json.load(handle)
    if not isinstance(raw, dict):
        raise DashboardError("input JSON must contain an object")
    return raw


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    parser.add_argument("--input", "-i", default="-", help="snapshot/history JSON file, or - for stdin")
    parser.add_argument("--output", "-o", required=True, type=Path, help="destination PNG path")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        output = render_dashboard(_load_json(args.input), args.output)
    except (DashboardError, OSError, json.JSONDecodeError) as exc:
        print(f"usage-dashboard-renderer: {exc}", file=sys.stderr)
        return 2
    print(output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
