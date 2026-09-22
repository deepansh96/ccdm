#!/usr/bin/env python3
"""Post configured Claude usage statistics to one Discord channel."""

import argparse
import contextlib
import fcntl
import hashlib
import json
import math
import os
import stat
import select
import subprocess
import sys
import tempfile
import time
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen


SCRIPT_DIR = Path(__file__).resolve().parent
ROOT_DIR = SCRIPT_DIR.parent
DEFAULT_CONFIG_PATH = ROOT_DIR / ".usage-stats-poster.json"
REGISTRY_PATH = ROOT_DIR / "registry.json"
DEFAULT_HISTORY_DB_PATH = Path.home() / "Library" / "Application Support" / "CCDM" / "usage-stats" / "history.sqlite3"
HISTORY_RETENTION_DAYS = 365
HISTORY_WARNING_BYTES = 5 * 1024 * 1024 * 1024
HISTORY_WARNING_INTERVAL = timedelta(hours=24)
RENDERER_PATH = SCRIPT_DIR / "usage-dashboard-renderer.py"
HISTORY_SCHEMA_VERSION = 1
CLAUDE_PRICES = {
    "claude-haiku-4-5": (1.0, 5.0),
    "claude-sonnet-4-6": (3.0, 15.0),
    "claude-opus-4-6": (15.0, 75.0),
    "claude-opus-4-7": (5.0, 25.0),
}


class PosterError(Exception):
    """An actionable, safe-to-display poster error."""


class PosterHTTPError(PosterError):
    """An HTTP failure whose status can drive account-specific guidance."""

    def __init__(self, label, status):
        super().__init__(f"{label} request failed (HTTP {status})")
        self.status = status


def fmt_reset(reset_str, now):
    if not reset_str:
        return None
    try:
        reset = datetime.fromisoformat(str(reset_str).replace("Z", "+00:00"))
        total_minutes = int((reset - now).total_seconds() / 60)
    except (TypeError, ValueError, OverflowError):
        return None
    if total_minutes < 0:
        return "now"
    if total_minutes < 60:
        return f"{total_minutes}m"
    hours, minutes = divmod(total_minutes, 60)
    if hours >= 24:
        days, hours = divmod(hours, 24)
        return f"{days}d {hours}h"
    return f"{hours}h {minutes}m"


def text_bar(pct, width=15):
    try:
        value = float(pct)
    except (TypeError, ValueError):
        value = 0
    value = max(0, min(value, 100))
    filled = round(value / 100 * width)
    return f"`[{'#' * filled}{'.' * (width - filled)}]` **{value:.0f}%**"


def _safe_percentage(value):
    """Return a finite, clamped percentage or ``None`` when unavailable."""
    if isinstance(value, bool):
        return None
    try:
        value = float(value)
    except (TypeError, ValueError, OverflowError):
        return None
    if not math.isfinite(value):
        return None
    return max(0.0, min(100.0, value))


def fmt_tokens(value):
    if value is None:
        return "n/a"
    try:
        value = int(value)
    except (TypeError, ValueError):
        return "n/a"
    if value >= 1_000_000:
        return f"{value / 1_000_000:.2f}M"
    if value >= 1_000:
        return f"{value / 1_000:.1f}k"
    return str(value)


def estimate_claude_cost(model, usage):
    input_price, output_price = next(
        (price for prefix, price in CLAUDE_PRICES.items() if str(model or "").startswith(prefix)),
        (3.0, 15.0),
    )
    input_tokens = _safe_int(usage.get("input_tokens"))
    output_tokens = _safe_int(usage.get("output_tokens"))
    cache_read = _safe_int(usage.get("cache_read_input_tokens"))
    cache_write = _safe_int(usage.get("cache_creation_input_tokens"))
    return (
        input_tokens * input_price
        + output_tokens * output_price
        + cache_read * input_price * 0.1
        + cache_write * input_price * 1.25
    ) / 1_000_000


def _safe_int(value):
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def get_claude_api_estimate(config_dir, now=None):
    """Return a sanitized local Claude API cost estimate, never source paths."""
    now = now or datetime.now(timezone.utc).astimezone()
    records = {}
    projects_dir = config_dir / "projects"
    if not projects_dir.is_dir():
        # An absent/unreadable configured directory says nothing about usage.
        # Reserve "no local usage" for a directory we successfully scanned.
        return {"status": "unavailable"}

    try:
        transcripts = projects_dir.rglob("*.jsonl")
        for transcript in transcripts:
            try:
                lines = transcript.read_text(errors="replace").splitlines()
            except OSError:
                continue
            for line in lines:
                try:
                    record = json.loads(line)
                    if not isinstance(record, dict):
                        continue
                    message = record.get("message", {})
                    if not isinstance(message, dict):
                        continue
                    usage = message.get("usage")
                    message_id = message.get("id")
                    timestamp_text = record.get("timestamp")
                    if not isinstance(timestamp_text, str) or not isinstance(usage, dict):
                        continue
                    timestamp = datetime.fromisoformat(timestamp_text.replace("Z", "+00:00")).astimezone()
                    if record.get("type") == "assistant" and message_id and usage:
                        records[message_id] = (timestamp, message.get("model", "unknown"), usage)
                except (KeyError, TypeError, ValueError, json.JSONDecodeError):
                    continue
    except OSError:
        return {"status": "unavailable"}

    month = [record for record in records.values() if (record[0].year, record[0].month) == (now.year, now.month)]
    if not month:
        return {"status": "no_local_usage", "today_cost": 0.0, "month_cost": 0.0, "today_requests": 0, "month_requests": 0}

    today = [record for record in month if record[0].date() == now.date()]
    totals = {
        key: sum(_safe_int(usage.get(key)) for _, _, usage in month)
        for key in ("input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens")
    }
    month_cost = sum(estimate_claude_cost(model, usage) for _, model, usage in month)
    today_cost = sum(estimate_claude_cost(model, usage) for _, model, usage in today)
    models = {}
    for _, model, _ in month:
        models[model] = models.get(model, 0) + 1
    model_text = ", ".join(
        f"{model.removeprefix('claude-')} ({count})"
        for model, count in sorted(models.items(), key=lambda item: -item[1])[:3]
    )
    today_requests = f"{len(today)} request{'s' if len(today) != 1 else ''}"
    month_requests = f"{len(month)} request{'s' if len(month) != 1 else ''}"
    return {
        "status": "estimated_local",
        "today_cost": today_cost,
        "month_cost": month_cost,
        "today_requests": len(today),
        "month_requests": len(month),
        "input_tokens": totals["input_tokens"],
        "output_tokens": totals["output_tokens"],
        "cache_read_tokens": totals["cache_read_input_tokens"],
        "cache_write_tokens": totals["cache_creation_input_tokens"],
        "models": model_text,
    }


def get_claude_api_stats(config_dir, label, now=None, estimate=None):
    """Format the local estimate for the legacy manual text embed."""
    estimate = estimate if isinstance(estimate, dict) else get_claude_api_estimate(config_dir, now)
    if estimate["status"] == "unavailable":
        return f"**{label}** (API key)\n*Unable to read local usage*"
    if estimate["status"] == "no_local_usage":
        return f"**{label}** (API key)\n*No local usage this month*"
    return "\n".join([
        f"**{label}** (API key, local estimate)",
        f"Today: **${estimate['today_cost']:.4f}** · {estimate['today_requests']} request{'s' if estimate['today_requests'] != 1 else ''}",
        f"This month: **${estimate['month_cost']:.4f}** · {estimate['month_requests']} request{'s' if estimate['month_requests'] != 1 else ''}",
        f"Tokens: {fmt_tokens(estimate['input_tokens'])} in · {fmt_tokens(estimate['output_tokens'])} out",
        f"Cache: {fmt_tokens(estimate['cache_read_tokens'])} read · {fmt_tokens(estimate['cache_write_tokens'])} write",
        f"Models: {estimate['models']}",
        "*Only Claude Code usage recorded on this Mac*",
    ])


def _read_oauth_credential(service):
    try:
        result = subprocess.run(
            ["security", "find-generic-password", "-s", service, "-w"],
            capture_output=True,
            text=True,
            timeout=10,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if result.returncode != 0:
        return None
    try:
        credential = json.loads(result.stdout.strip())
    except (TypeError, ValueError, json.JSONDecodeError):
        return None
    if not isinstance(credential, dict):
        return None
    oauth = credential.get("claudeAiOauth")
    if not isinstance(oauth, dict):
        return None
    if not isinstance(oauth.get("accessToken"), str) or not oauth["accessToken"]:
        return None
    return oauth


def _request_json(base_url, endpoint, headers, label):
    request = Request(
        f"{base_url.rstrip('/')}{endpoint}",
        headers=headers,
        method="GET",
    )
    try:
        with urlopen(request, timeout=10) as response:
            if not 200 <= response.status < 300:
                raise PosterHTTPError(label, response.status)
            return json.loads(response.read().decode("utf-8"))
    except HTTPError as error:
        raise PosterHTTPError(label, error.code) from None
    except (URLError, TimeoutError, OSError, UnicodeDecodeError, json.JSONDecodeError):
        raise PosterError(f"{label} request failed; check the endpoint and try again") from None


def claude_account_label(config_json_path):
    """Return the account label stored by Claude Code, if it is usable."""
    try:
        data = json.loads(Path(config_json_path).read_text())
    except (OSError, UnicodeDecodeError, TypeError, ValueError, json.JSONDecodeError):
        return None
    if not isinstance(data, dict):
        return None
    oauth_account = data.get("oauthAccount")
    if not isinstance(oauth_account, dict):
        return None
    for key in ("organizationName", "emailAddress"):
        label = oauth_account.get(key)
        if isinstance(label, str) and label.strip():
            return label.strip()
    return None


def discover_claude_accounts():
    """Return the default login and valid extra Claude config-dir logins.

    Claude Code stores the default login in ``Claude Code-credentials`` and
    derives each ``CLAUDE_CONFIG_DIR`` login's Keychain service from the first
    eight hex characters of that config directory's SHA-256 hash.
    """
    accounts = [("Claude Code-credentials", "Personal", "~/.claude")]
    try:
        home = Path.home()
        config_dirs = sorted(home.glob(".claude-*"))
    except (OSError, RuntimeError, ValueError):
        return accounts

    for config_dir in config_dirs:
        try:
            if not config_dir.is_dir():
                continue
        except OSError:
            continue
        label = claude_account_label(config_dir / ".claude.json")
        if not label:
            continue
        suffix = hashlib.sha256(str(config_dir).encode()).hexdigest()[:8]
        accounts.append(
            (
                f"Claude Code-credentials-{suffix}",
                label,
                f"~/{config_dir.name}",
            )
        )
    return accounts


def get_claude_account_stats(base_url, service, label, dir_hint, missing_message=None):
    oauth = _read_oauth_credential(service)
    if not oauth:
        return missing_message

    expires_at = oauth.get("expiresAt")
    if expires_at:
        try:
            if float(expires_at) / 1000 < datetime.now(timezone.utc).timestamp():
                if oauth.get("refreshToken"):
                    return f"**{label}**\n*OAuth token expired — start a session on this account to refresh*"
                return _claude_relogin_block(label, dir_hint)
        except (TypeError, ValueError):
            pass

    headers = {
        "Authorization": f"Bearer {oauth['accessToken']}",
        "anthropic-beta": "oauth-2025-04-20",
        "User-Agent": "claude-code/usage-stats-poster",
    }
    try:
        profile = _request_json(base_url, "/api/oauth/profile", headers, "Anthropic profile")
        usage = _request_json(base_url, "/api/oauth/usage", headers, "Anthropic usage")
    except PosterHTTPError as error:
        if error.status == 401:
            if oauth.get("refreshToken"):
                return f"**{label}**\n*Auth expired — start a session on this account to refresh*"
            return _claude_relogin_block(label, dir_hint)
        return f"**{label}**\n*Anthropic usage is temporarily unavailable*"
    except PosterError:
        return f"**{label}**\n*Anthropic usage is temporarily unavailable*"

    organization = profile.get("organization") if isinstance(profile, dict) else None
    organization_type = organization.get("organization_type") if isinstance(organization, dict) else None
    if isinstance(organization_type, str) and organization_type.strip():
        plan = organization_type.strip().replace("_", " ").title()
    else:
        plan = "N/A"
    now = datetime.now(timezone.utc)
    lines = [f"**{label}** ({plan})"]
    for key, limit_label in (("five_hour", "5-Hour"), ("seven_day", "7-Day")):
        data = usage.get(key) if isinstance(usage, dict) else None
        if not isinstance(data, dict):
            continue
        reset = fmt_reset(data.get("resets_at"), now)
        reset_part = f"  resets in {reset}" if reset else ""
        lines.append(f"{limit_label}: {text_bar(data.get('utilization', 0) or 0)}{reset_part}")
    extra_usage = usage.get("extra_usage", {}) if isinstance(usage, dict) else {}
    if isinstance(extra_usage, dict) and extra_usage.get("is_enabled"):
        lines.append(f"Extra usage: **${_safe_int(extra_usage.get('used_credits')) / 100:.2f}** spent")
    return "\n".join(lines)


def _claude_relogin_block(label, dir_hint):
    command = f"CLAUDE_CONFIG_DIR={dir_hint} claude /login"
    return f"**{label}**\n*Needs re-login: `{command}`*"


def get_claude_oauth_stats(base_url):
    """Return the default Claude OAuth account block."""
    return get_claude_account_stats(
        base_url,
        "Claude Code-credentials",
        "Personal",
        "~/.claude",
        missing_message="**Personal**\n*Could not get OAuth token*",
    )


def _parse_url(value, field):
    if value is None:
        return None
    if not isinstance(value, str) or not value.strip():
        raise PosterError(f"{field} must be a non-empty URL")
    parsed = urlparse(value)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise PosterError(f"{field} must be an HTTP(S) URL")
    return value.rstrip("/")


def parse_config(raw):
    if not isinstance(raw, dict):
        raise PosterError("poster config must contain a JSON object")
    channel_id = raw.get("discord_channel_id", raw.get("channel_id"))
    if not isinstance(channel_id, str) or not channel_id.strip():
        raise PosterError("poster config requires discord_channel_id")

    api_accounts = raw.get("claude_api_accounts", [])
    if not isinstance(api_accounts, list):
        raise PosterError("claude_api_accounts must be a JSON array")
    normalized_accounts = []
    for index, account in enumerate(api_accounts):
        if not isinstance(account, dict):
            raise PosterError(f"claude_api_accounts[{index}] must be a JSON object")
        account_path = account.get("path")
        label = account.get("label")
        if not isinstance(account_path, str) or not account_path.strip():
            raise PosterError(f"claude_api_accounts[{index}].path must be a non-empty path")
        if not isinstance(label, str) or not label.strip():
            raise PosterError(f"claude_api_accounts[{index}].label must be a non-empty label")
        normalized_accounts.append({"path": Path(os.path.expanduser(account_path)), "label": label})

    anthropic_base_url = raw.get("anthropic_base_url")
    if anthropic_base_url is None:
        anthropic_base_url = os.environ.get("CCDM_ANTHROPIC_BASE_URL") or os.environ.get("ANTHROPIC_BASE_URL")
    discord_base_url = raw.get("discord_base_url")
    if discord_base_url is None:
        discord_base_url = os.environ.get("CCDM_DISCORD_BASE_URL") or os.environ.get("DISCORD_BASE_URL")

    history_value = raw.get(
        "history_db_path",
        raw.get("history_path", raw.get("usage_history_path", raw.get("usage_history_db"))),
    )
    if history_value is None:
        history_value = os.environ.get("CCDM_USAGE_STATS_DB_PATH") or os.environ.get("CCDM_USAGE_STATS_HISTORY_DB")
    if history_value is None:
        history_db_path = DEFAULT_HISTORY_DB_PATH
    elif not isinstance(history_value, str) or not history_value.strip():
        raise PosterError("history_db_path must be a non-empty path")
    else:
        history_db_path = Path(os.path.expanduser(history_value))
        if not history_db_path.is_absolute():
            raise PosterError("history_db_path must be an absolute path or use ~")
    if history_db_path.name in {"", ".", ".."}:
        raise PosterError("history_db_path must name a SQLite database file")

    return {
        "discord_channel_id": channel_id,
        "anthropic_base_url": _parse_url(anthropic_base_url, "anthropic_base_url")
        or "https://api.anthropic.com",
        "discord_base_url": _parse_url(discord_base_url, "discord_base_url")
        or "https://discord.com",
        "claude_api_accounts": normalized_accounts,
        "history_db_path": history_db_path,
    }


def load_config(path):
    try:
        raw = json.loads(path.read_text())
    except FileNotFoundError:
        raise PosterError(f"poster config not found: {path.name}") from None
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        raise PosterError(f"unable to read valid JSON from {path.name}") from None
    return parse_config(raw)


def load_registry_data(path):
    try:
        registry = json.loads(path.read_text())
    except FileNotFoundError:
        raise PosterError("registry.json not found next to the repository") from None
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        raise PosterError("unable to read valid registry.json") from None
    if not isinstance(registry, dict) or not isinstance(registry.get("pool"), list):
        raise PosterError("registry.json has no valid bot pool")
    state_dir = Path(os.environ.get("ROOT_DISCORD_STATE_DIR") or "~/.claude/channels/discord").expanduser()
    try:
        lines = (state_dir / ".env").read_text().splitlines()
    except (OSError, UnicodeError):
        raise PosterError("cannot read root Discord credentials; check ROOT_DISCORD_STATE_DIR") from None
    token = next((line.split("=", 1)[1].strip() for line in lines
                  if line.startswith("DISCORD_BOT_TOKEN=")), "")
    if len(token) >= 2 and token[0] == token[-1] and token[0] in "\"'":
        token = token[1:-1]
    if not token or any(character.isspace() for character in token):
        raise PosterError("root Discord state has no valid DISCORD_BOT_TOKEN")
    return registry, token



def _resolved_codex_home(value):
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        return Path(value).expanduser().resolve(strict=False)
    except (OSError, RuntimeError, ValueError):
        try:
            return Path(os.path.abspath(os.path.expanduser(value)))
        except (OSError, RuntimeError, ValueError):
            return None


def _group_codex_accounts(entries, default_alias=None):
    ordered = []
    groups = {}
    for alias, raw_home in entries:
        home = _resolved_codex_home(raw_home)
        key = str(home) if home is not None else f"invalid:{alias}"
        if key not in groups:
            groups[key] = {"aliases": [], "home": home}
            ordered.append(groups[key])
        groups[key]["aliases"].append(alias)

    accounts = []
    for group in ordered:
        aliases = sorted(group["aliases"])
        label = default_alias if default_alias in aliases else aliases[0]
        accounts.append({"label": label, "home": group["home"]})
    return accounts


def _legacy_codex_accounts(registry, named_aliases=None):
    raw_homes = []
    if isinstance(registry.get("codex_home"), str):
        raw_homes.append(registry["codex_home"])
    projects = registry.get("projects", {})
    if isinstance(projects, dict):
        for project_name in sorted(projects):
            project = projects[project_name]
            if not isinstance(project, dict):
                continue
            project_account = project.get("codex_account")
            if project_account is not None:
                if not isinstance(project_account, str) or not project_account.strip():
                    raise PosterError(f"project {project_name!r} codex_account must be a non-empty alias or null")
            if project.get("codex_account") is not None and project.get("codex_home") is not None:
                raise PosterError(
                    f"project {project_name!r} cannot set both codex_account and codex_home at the same scope"
                )
            if project_account is not None and (named_aliases is None or project_account not in named_aliases):
                raise PosterError(
                    f"project {project_name!r} codex_account refers to unknown alias {project_account!r}"
                )
            if isinstance(project.get("codex_home"), str):
                raw_homes.append(project["codex_home"])
    entries = [
        ("Legacy Codex Home" if index == 0 else f"Legacy Codex Home {index + 1}", home)
        for index, home in enumerate(raw_homes)
    ]
    accounts = _group_codex_accounts(entries)
    for index, account in enumerate(accounts):
        account["label"] = "Legacy Codex Home" if index == 0 else f"Legacy Codex Home {index + 1}"
    return accounts


def _merge_codex_accounts(named_accounts, legacy_accounts):
    """Merge named and legacy homes, preferring named labels on shared homes."""
    merged = list(named_accounts)
    seen_homes = {str(account["home"]) for account in merged if account["home"] is not None}
    visible_legacy = []
    for account in legacy_accounts:
        home_key = str(account["home"]) if account["home"] is not None else None
        if home_key is not None and home_key in seen_homes:
            continue
        if home_key is not None:
            seen_homes.add(home_key)
        visible_legacy.append(account)
    for index, account in enumerate(visible_legacy):
        account["label"] = "Legacy Codex Home" if index == 0 else f"Legacy Codex Home {index + 1}"
    return merged + visible_legacy


def discover_codex_accounts(registry):
    """Return configured Codex Account labels and resolved Codex Homes."""
    if not isinstance(registry, dict):
        raise PosterError("registry.json must contain a JSON object")
    top_default = registry.get("default_codex_account")
    top_home = registry.get("codex_home")
    if "codex_accounts" in registry:
        named_accounts = registry["codex_accounts"]
        if not isinstance(named_accounts, dict):
            raise PosterError("registry.json codex_accounts must be an object mapping aliases to paths")
        for alias, raw_home in named_accounts.items():
            if not isinstance(alias, str) or not alias.strip():
                raise PosterError("registry.json codex_accounts must use non-empty alias names")
            if not isinstance(raw_home, str) or not raw_home.strip():
                raise PosterError(f"registry.json codex_accounts[{alias!r}] must be a non-empty path")

        if top_default is not None and top_home is not None:
            raise PosterError("registry cannot set both default_codex_account and top-level codex_home at the same scope")
        default_alias = top_default
        if default_alias is not None:
            if not isinstance(default_alias, str) or not default_alias.strip():
                raise PosterError("registry.json default_codex_account must be a non-empty alias or null")
            if default_alias not in named_accounts:
                raise PosterError(
                    f"registry.json default_codex_account refers to unknown alias {default_alias!r}"
                )
        aliases = list(named_accounts)
        ordered_aliases = ([default_alias] if default_alias is not None else [])
        ordered_aliases.extend(sorted(alias for alias in aliases if alias != default_alias))
        named = _group_codex_accounts(
            [(alias, named_accounts[alias]) for alias in ordered_aliases],
            default_alias,
        )
        return _merge_codex_accounts(named, _legacy_codex_accounts(registry, set(named_accounts)))

    if top_default is not None and top_home is not None:
        raise PosterError("registry cannot set both default_codex_account and top-level codex_home at the same scope")
    if top_default is not None:
        raise PosterError("registry.json default_codex_account requires a codex_accounts object")
    return _legacy_codex_accounts(registry)


def _format_plan(value):
    plan = str(value or "Codex").replace("_", " ").strip()
    if plan.lower() == "chatgpt":
        return "ChatGPT"
    return plan.title()


def _format_rate_limit_reset(value):
    if value is None:
        return None
    try:
        if isinstance(value, (int, float)):
            reset = datetime.fromtimestamp(value, timezone.utc)
        else:
            reset = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
            if reset.tzinfo is None:
                reset = reset.replace(tzinfo=timezone.utc)
        return fmt_reset(reset.isoformat(), datetime.now(timezone.utc))
    except (TypeError, ValueError, OverflowError, OSError):
        return None


def _format_age_marker(source_ts):
    if not isinstance(source_ts, str) or not source_ts:
        return None
    try:
        record_time = datetime.fromisoformat(source_ts.replace("Z", "+00:00"))
        if record_time.tzinfo is None:
            record_time = record_time.replace(tzinfo=timezone.utc)
        age_minutes = int((datetime.now(timezone.utc) - record_time).total_seconds() / 60)
    except (TypeError, ValueError, OverflowError):
        return None
    return f"*{age_minutes}m ago*" if age_minutes > 5 else None


def _valid_codex_rate_limits(value):
    return isinstance(value, dict) and any(
        isinstance(value.get(key), dict) and bool(value.get(key))
        for key in ("primary", "secondary")
    )


def format_codex_rate_limits(rate_limits, label, reset_credits=None, source_ts=None):
    plan = _format_plan(rate_limits.get("planType", rate_limits.get("plan_type")))
    lines = [f"**{label}** ({plan})"]
    data = _codex_weekly_limit(rate_limits)
    if isinstance(data, dict):
        used_percent = _safe_percentage(data.get("usedPercent", data.get("used_percent")))
        reset = _format_rate_limit_reset(data.get("resetsAt", data.get("resets_at")))
        reset_part = f"  resets in {reset}" if reset else ""
        value_text = text_bar(used_percent) if used_percent is not None else "*unavailable*"
        lines.append(f"Weekly: {value_text}{reset_part}")
    if reset_credits is None:
        reset_credits = rate_limits.get("rateLimitResetCredits")
    if isinstance(reset_credits, dict) and isinstance(reset_credits.get("availableCount"), int):
        lines.append(f"Full resets available: **{reset_credits['availableCount']}**")
    age_marker = _format_age_marker(source_ts)
    if age_marker:
        lines.append(age_marker)
    return "\n".join(lines)


def read_codex_rate_limits(codex_home):
    """Read one Codex Home's live rate limits through the local app-server boundary."""
    environment = os.environ.copy()
    environment.pop("ROOT_CODEX_HOME", None)
    environment["CODEX_HOME"] = str(codex_home)
    try:
        process = subprocess.Popen(
            ["codex", "app-server", "--stdio"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            env=environment,
        )
    except (OSError, subprocess.SubprocessError):
        return None

    def terminate_process():
        try:
            process.stdin.close()
        except (OSError, ValueError):
            pass
        try:
            process.terminate()
            process.wait(timeout=2)
        except (OSError, subprocess.TimeoutExpired):
            try:
                process.kill()
                process.wait(timeout=2)
            except (OSError, subprocess.TimeoutExpired):
                pass

    stdout_buffer = bytearray()
    try:
        stdout_fd = process.stdout.fileno()
        os.set_blocking(stdout_fd, False)
    except (AttributeError, OSError, ValueError):
        terminate_process()
        return None

    def read_line(deadline):
        while True:
            try:
                line_end = stdout_buffer.index(b"\n")
            except ValueError:
                line_end = None
            if line_end is not None:
                line = bytes(stdout_buffer[:line_end])
                del stdout_buffer[:line_end + 1]
                return line

            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return None
            try:
                ready, _, _ = select.select([stdout_fd], [], [], remaining)
            except (OSError, ValueError):
                return None
            if not ready:
                return None
            try:
                chunk = os.read(stdout_fd, 65536)
            except BlockingIOError:
                continue
            except OSError:
                return None
            if not chunk:
                if not stdout_buffer:
                    return None
                line = bytes(stdout_buffer)
                stdout_buffer.clear()
                return line
            stdout_buffer.extend(chunk)

    def request(request_id, method, params=None):
        message = {"jsonrpc": "2.0", "id": request_id, "method": method}
        if params is not None:
            message["params"] = params
        try:
            process.stdin.write((json.dumps(message) + "\n").encode("utf-8"))
            process.stdin.flush()
        except (BrokenPipeError, OSError, ValueError):
            return None
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            line = read_line(deadline)
            if line is None:
                return None
            try:
                response = json.loads(line.decode("utf-8"))
            except (OSError, UnicodeDecodeError, ValueError, TypeError, json.JSONDecodeError):
                return None
            if not isinstance(response, dict):
                return None
            if response.get("id") != request_id:
                continue
            if response.get("error") is not None:
                return None
            return response.get("result")
        return None

    try:
        initialized = request(1, "initialize", {
            "clientInfo": {"name": "usage-stats-poster", "version": "1.0.0"},
        })
        if not isinstance(initialized, dict):
            return None
        try:
            process.stdin.write((json.dumps({"jsonrpc": "2.0", "method": "initialized"}) + "\n").encode("utf-8"))
            process.stdin.flush()
        except (BrokenPipeError, OSError, ValueError):
            return None
        result = request(2, "account/rateLimits/read")
        if not isinstance(result, dict):
            return None
        rate_limits = result.get("rateLimits")
        if not isinstance(rate_limits, dict):
            return None
        rate_limits = dict(rate_limits)
        if "rateLimitResetCredits" in result:
            rate_limits["rateLimitResetCredits"] = result["rateLimitResetCredits"]
        return rate_limits
    except (OSError, TypeError, ValueError, json.JSONDecodeError):
        return None
    finally:
        terminate_process()


def _latest_codex_session_data(codex_home):
    sessions_dir = codex_home / "sessions" if codex_home is not None else None
    if sessions_dir is None or not sessions_dir.is_dir():
        return None
    cutoff = time.time() - timedelta(days=7).total_seconds()
    latest = None
    latest_rate_limit = None
    try:
        files = list(sessions_dir.rglob("*.jsonl"))
    except OSError:
        return None
    for transcript in files:
        try:
            modified = transcript.stat().st_mtime
            if modified < cutoff:
                continue
            lines = transcript.read_text(errors="replace").splitlines()
        except OSError:
            continue
        for line in lines:
            try:
                record = json.loads(line)
                payload = record.get("payload")
                if not isinstance(record, dict) or not isinstance(payload, dict):
                    continue
                if record.get("type") != "event_msg" or payload.get("type") != "token_count":
                    continue
                info = payload.get("info") if isinstance(payload.get("info"), dict) else {}
                last_usage = info.get("last_token_usage") if isinstance(info.get("last_token_usage"), dict) else {}
                total_usage = info.get("total_token_usage") if isinstance(info.get("total_token_usage"), dict) else {}
                candidate_rate_limits = payload.get("rate_limits")
                rate_limits = candidate_rate_limits if _valid_codex_rate_limits(candidate_rate_limits) else None
                if not last_usage and not total_usage and rate_limits is None:
                    continue
                timestamp = record.get("timestamp")
                sort_key = (str(timestamp) if isinstance(timestamp, str) else "", modified)
                if latest is None or sort_key >= latest[0]:
                    latest = (sort_key, rate_limits, last_usage, total_usage)
                if rate_limits is not None and (latest_rate_limit is None or sort_key >= latest_rate_limit[0]):
                    latest_rate_limit = (sort_key, rate_limits, last_usage, total_usage)
            except (AttributeError, TypeError, ValueError, json.JSONDecodeError):
                continue
    if latest is None:
        return None
    source = latest_rate_limit or latest
    return source[1], source[2], source[3], source[0][0]


def get_codex_home_stats(codex_home, label):
    """Read one configured Codex Home, degrading safely to recent session data."""
    if codex_home is None or not codex_home.is_dir() or not os.access(codex_home, os.R_OK | os.X_OK):
        return f"**{label}**\n*Codex Home unavailable*"
    live = read_codex_rate_limits(codex_home)
    if isinstance(live, dict):
        return format_codex_rate_limits(live, label)

    session_data = _latest_codex_session_data(codex_home)
    if session_data is None:
        return f"**{label}**\n*Live rate limits unavailable; no recent usage data*"
    rate_limits, last_usage, total_usage, source_ts = session_data
    if isinstance(rate_limits, dict):
        return format_codex_rate_limits(rate_limits, label, source_ts=source_ts)
    lines = [f"**{label}** (Codex)", "*Live rate limits unavailable*"]
    if last_usage:
        lines.append(f"Last turn: **{fmt_tokens(last_usage.get('total_tokens'))}** tokens")
    if total_usage:
        lines.append(f"Session total: **{fmt_tokens(total_usage.get('total_tokens'))}** tokens")
    age_marker = _format_age_marker(source_ts)
    if age_marker:
        lines.append(age_marker)
    return "\n".join(lines)


def get_codex_stats(registry):
    accounts = discover_codex_accounts(registry)
    if not accounts:
        return None
    value = "\n\n".join(get_codex_home_stats(account["home"], account["label"]) for account in accounts)
    if len(value) > 1024:
        value = value[:1000].rstrip() + "\n*truncated*"
    return value


def get_claude_stats(config):
    blocks = [get_claude_oauth_stats(config["anthropic_base_url"])]
    for service, label, dir_hint in discover_claude_accounts()[1:]:
        block = get_claude_account_stats(config["anthropic_base_url"], service, label, dir_hint)
        if block:
            blocks.append(block)
    for account in config["claude_api_accounts"]:
        if account["path"].is_dir():
            blocks.append(get_claude_api_stats(account["path"], account["label"]))
        else:
            blocks.append(f"**{account['label']}** (API key)\n*Config directory unavailable*")
    value = "\n\n".join(blocks)
    if len(value) > 1024:
        value = value[:1000].rstrip() + "\n*truncated*"
    return value


def _normalise_reset_timestamp(value):
    """Return a stable UTC timestamp, or ``None`` for malformed input."""
    try:
        if isinstance(value, bool):
            return None
        if isinstance(value, (int, float)):
            if not math.isfinite(float(value)):
                return None
            parsed = datetime.fromtimestamp(value, timezone.utc)
        elif isinstance(value, str) and value.strip():
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        else:
            return None
    except (TypeError, ValueError, OverflowError, OSError):
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _collect_claude_oauth_metric(base_url, service, label, dir_hint):
    """Collect a credential-free, renderer-friendly Claude account metric.

    The returned object intentionally contains only display labels, rate-limit
    percentages, and reset timestamps.  In particular, the OAuth credential,
    transcript path, and response payload are never returned to the history
    writer.
    """
    metric = {"provider": "claude", "account": label, "limits": []}
    oauth = _read_oauth_credential(service)
    if not oauth:
        metric["status"] = "unavailable"
        metric["reason"] = "Could not get OAuth token"
        metric["missing_oauth"] = True
        metric["text"] = f"**{label}**\n*Could not get OAuth token*"
        return metric
    expires_at = oauth.get("expiresAt")
    if expires_at:
        try:
            if float(expires_at) / 1000 < datetime.now(timezone.utc).timestamp():
                metric["status"] = "unavailable"
                metric["reason"] = "OAuth token expired"
                metric["text"] = (
                    f"**{label}**\n*OAuth token expired — start a session on this account to refresh*"
                    if oauth.get("refreshToken")
                    else _claude_relogin_block(label, dir_hint)
                )
                return metric
        except (TypeError, ValueError):
            pass

    headers = {
        "Authorization": f"Bearer {oauth['accessToken']}",
        "anthropic-beta": "oauth-2025-04-20",
        "User-Agent": "claude-code/usage-stats-poster",
    }
    try:
        profile = _request_json(base_url, "/api/oauth/profile", headers, "Anthropic profile")
        usage = _request_json(base_url, "/api/oauth/usage", headers, "Anthropic usage")
    except PosterHTTPError as error:
        metric["status"] = "unavailable"
        metric["reason"] = "Auth expired" if error.status == 401 else "Anthropic usage unavailable"
        metric["text"] = (
            f"**{label}**\n*Auth expired — start a session on this account to refresh*"
            if error.status == 401 and oauth.get("refreshToken")
            else _claude_relogin_block(label, dir_hint)
            if error.status == 401
            else f"**{label}**\n*Anthropic usage is temporarily unavailable*"
        )
        return metric
    except PosterError:
        metric["status"] = "unavailable"
        metric["reason"] = "Anthropic usage unavailable"
        metric["text"] = f"**{label}**\n*Anthropic usage is temporarily unavailable*"
        return metric

    organization = profile.get("organization") if isinstance(profile, dict) else None
    organization_type = organization.get("organization_type") if isinstance(organization, dict) else None
    metric["plan"] = str(organization_type or "N/A").replace("_", " ").title()
    for key, window in (("five_hour", "5-hour"), ("seven_day", "7-day")):
        data = usage.get(key) if isinstance(usage, dict) else None
        if not isinstance(data, dict):
            continue
        raw_percent = data.get("utilization")
        try:
            percent = float(raw_percent)
            if isinstance(raw_percent, bool) or not math.isfinite(percent):
                raise ValueError
        except (TypeError, ValueError):
            percent = None
        metric["limits"].append({
            "window": window,
            "used_percent": max(0.0, min(100.0, percent)) if percent is not None else None,
            "available": percent is not None,
            "status": "available" if percent is not None else "unavailable",
            "reason": None if percent is not None else "Usage percentage unavailable",
            "resets_at": _normalise_reset_timestamp(data.get("resets_at")),
        })
    if not metric["limits"]:
        metric["status"] = "unavailable"
        metric["reason"] = "No rate-limit data"
    lines = [f"**{label}** ({metric['plan']})"]
    for limit in metric["limits"]:
        reset = fmt_reset(limit.get("resets_at"), datetime.now(timezone.utc))
        reset_part = f"  resets in {reset}" if reset else ""
        value_text = text_bar(limit["used_percent"]) if limit["available"] else "*unavailable*"
        lines.append(f"{'5-Hour' if limit['window'] == '5-hour' else '7-Day'}: {value_text}{reset_part}")
    extra_usage = usage.get("extra_usage", {}) if isinstance(usage, dict) else {}
    if isinstance(extra_usage, dict) and extra_usage.get("is_enabled"):
        lines.append(f"Extra usage: **${_safe_int(extra_usage.get('used_credits')) / 100:.2f}** spent")
    metric["text"] = "\n".join(lines)
    return metric


def collect_claude_metrics(config):
    """Return structured current Claude metrics for history and rendering."""
    metrics = []
    for index, (service, label, dir_hint) in enumerate(discover_claude_accounts()):
        metric = _collect_claude_oauth_metric(config["anthropic_base_url"], service, label, dir_hint)
        if index > 0 and metric.get("missing_oauth"):
            metric["text"] = None
        metrics.append(metric)
    for account in config["claude_api_accounts"]:
        # API-key transcript accounts have no comparable percentage limit. Keep
        # their sanitized cost summary in the Claude rail, never as a graph line.
        estimate = get_claude_api_estimate(account["path"])
        api_metric = {
            "provider": "claude",
            "account": account["label"],
            "limits": [],
            "dashboard_note": _claude_api_dashboard_note(account["label"], estimate),
        }
        # Reuse the scan above: transcript trees can be large and the manual
        # embed must agree with the dashboard rail for this collection run.
        api_metric["text"] = get_claude_api_stats(account["path"], account["label"], estimate=estimate)
        metrics.append(api_metric)
    return metrics


def _claude_api_dashboard_note(label, estimate):
    """Build a compact, structured display-only API estimate note."""
    status = estimate.get("status") if isinstance(estimate, dict) else "unavailable"
    if status == "estimated_local":
        return {
            "title": f"{_safe_label(label, 'Claude API')} · API estimate",
            "lines": [
                f"Today  ${estimate['today_cost']:.4f} · {estimate['today_requests']} request{'s' if estimate['today_requests'] != 1 else ''}",
                f"This month  ${estimate['month_cost']:.4f} · {estimate['month_requests']} request{'s' if estimate['month_requests'] != 1 else ''}",
                "Local estimate · no rate-limit graph",
            ],
        }
    return {
        "title": f"{_safe_label(label, 'Claude API')} · API estimate",
        "lines": [
            "Local usage unavailable" if status == "unavailable" else "No local usage this month",
            "No rate-limit graph",
        ],
    }


def _codex_weekly_limit(rate_limits):
    """Select Codex's weekly window from duration metadata, with old API fallback."""
    if not isinstance(rate_limits, dict):
        return None
    candidates = []
    for key in ("primary", "secondary", "weekly", "seven_day"):
        value = rate_limits.get(key)
        if not isinstance(value, dict):
            continue
        duration = next((value.get(name) for name in ("windowDurationMins", "window_duration_mins", "durationMinutes", "duration_minutes") if value.get(name) is not None), None)
        try:
            duration = float(duration)
        except (TypeError, ValueError):
            duration = None
        candidates.append((key, value, duration))
    for _, value, duration in candidates:
        if duration is not None and duration >= 6 * 24 * 60:
            return value
    # Older app-server payloads did not expose duration. Secondary was their
    # documented longer window; if it is absent retain a usable primary value
    # but label it only as the weekly Codex allowance, never "5-hour".
    for key, value, _ in candidates:
        if key in {"secondary", "weekly", "seven_day"}:
            return value
    return candidates[0][1] if candidates else None


def _metric_from_codex_rate_limits(rate_limits, label, source="live", source_ts=None):
    metric = {"provider": "codex", "account": label, "limits": [], "source": source}
    if not isinstance(rate_limits, dict):
        metric["status"] = "unavailable"
        metric["reason"] = "Live rate limits unavailable"
        return metric
    data = _codex_weekly_limit(rate_limits)
    if isinstance(data, dict):
        value = _safe_percentage(data.get("usedPercent", data.get("used_percent")))
        limit = {
            "window": "Weekly",
            "available": value is not None,
            "status": "available" if value is not None else "unavailable",
            "reason": None if value is not None else "Usage percentage unavailable",
            "used_percent": max(0.0, min(100.0, value)) if value is not None else None,
            "resets_at": _normalise_reset_timestamp(data.get("resetsAt", data.get("resets_at"))),
        }
        metric["limits"].append(limit)
    if not metric["limits"]:
        metric["status"] = "unavailable"
        metric["reason"] = "No rate-limit data"
    metric["text"] = format_codex_rate_limits(rate_limits, label, source_ts=source_ts)
    if source_ts:
        metric["source_ts"] = source_ts
    return metric


def collect_codex_metrics(registry):
    """Return structured current Codex metrics without retaining source paths."""
    metrics = []
    for account in discover_codex_accounts(registry):
        home = account["home"]
        label = account["label"]
        if home is None or not home.is_dir() or not os.access(home, os.R_OK | os.X_OK):
            metrics.append({
                "provider": "codex", "account": label, "limits": [{
                    "window": "rate limits", "available": False,
                    "status": "unavailable", "reason": "Codex Home unavailable",
                }], "text": f"**{label}**\n*Codex Home unavailable*",
            })
            continue
        live = read_codex_rate_limits(home)
        if isinstance(live, dict):
            metrics.append(_metric_from_codex_rate_limits(live, label))
            continue
        session_data = _latest_codex_session_data(home)
        if session_data is not None and isinstance(session_data[0], dict):
            metrics.append(_metric_from_codex_rate_limits(session_data[0], label, "local_session", session_data[3]))
            continue
        text = [f"**{label}**", "*Live rate limits unavailable; no recent usage data*"]
        if session_data is not None:
            _, last_usage, total_usage, source_ts = session_data
            text = [f"**{label}** (Codex)", "*Live rate limits unavailable*"]
            if last_usage:
                text.append(f"Last turn: **{fmt_tokens(last_usage.get('total_tokens'))}** tokens")
            if total_usage:
                text.append(f"Session total: **{fmt_tokens(total_usage.get('total_tokens'))}** tokens")
            age_marker = _format_age_marker(source_ts)
            if age_marker:
                text.append(age_marker)
        metrics.append({
            "provider": "codex", "account": label, "limits": [{
                "window": "rate limits", "available": False,
                "status": "unavailable", "reason": "No recent usage data",
            }], "text": "\n".join(text),
        })
    return metrics


def _usage_report_values(claude_metrics, codex_metrics):
    """Build the bounded text fields used by manual and scheduled reports."""
    claude_value = "\n\n".join(
        metric["text"]
        for metric in claude_metrics
        if isinstance(metric.get("text"), str) and metric["text"]
    )
    codex_value = "\n\n".join(
        metric["text"]
        for metric in codex_metrics
        if isinstance(metric.get("text"), str) and metric["text"]
    ) or None
    if len(claude_value) > 1024:
        claude_value = claude_value[:1000].rstrip() + "\n*truncated*"
    if len(codex_value or "") > 1024:
        codex_value = codex_value[:1000].rstrip() + "\n*truncated*"
    return claude_value, codex_value


def _usage_report_embed(claude_value, codex_value=None):
    """Return the original text-only Usage Report embed."""
    timestamp = datetime.now().strftime("%b %d, %H:%M")
    embed = {
        "title": "Usage Report",
        "color": 0x5865F2,
        "fields": [{"name": "Claude Code", "value": claude_value, "inline": True}],
        "footer": {"text": timestamp},
    }
    if codex_value is not None:
        embed["fields"].append({"name": "Codex", "value": codex_value, "inline": True})
    return embed


def post_to_discord(config, bot_token, claude_value, codex_value=None):
    embed = _usage_report_embed(claude_value, codex_value)
    request = Request(
        f"{config['discord_base_url'].rstrip('/')}/api/v10/channels/{config['discord_channel_id']}/messages",
        data=json.dumps({"embeds": [embed]}).encode("utf-8"),
        headers={
            "Authorization": f"Bot {bot_token}",
            "Content-Type": "application/json",
            "User-Agent": "ccdm-usage-stats-poster/1.0",
        },
        method="POST",
    )
    try:
        with urlopen(request, timeout=10) as response:
            if not 200 <= response.status < 300:
                raise PosterError(f"Discord post failed (HTTP {response.status})")
            result = json.loads(response.read().decode("utf-8"))
    except HTTPError as error:
        raise PosterError(f"Discord post failed (HTTP {error.code})") from None
    except (URLError, TimeoutError, OSError, UnicodeDecodeError, json.JSONDecodeError):
        raise PosterError("Discord post failed; check the endpoint and try again") from None
    message_id = result.get("id", "unknown") if isinstance(result, dict) else "unknown"
    print(f"Posted (message ID: {message_id})")


def _utc_now():
    """Read an optional deterministic clock used by local validation tests."""
    for key in ("CCDM_USAGE_STATS_NOW", "CCDM_TEST_NOW"):
        value = os.environ.get(key)
        if not value:
            continue
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=timezone.utc)
            return parsed.astimezone(timezone.utc)
        except ValueError:
            continue
    return datetime.now(timezone.utc)


def _floor_utc(value, minutes):
    value = value.astimezone(timezone.utc)
    return value.replace(minute=(value.minute // minutes) * minutes, second=0, microsecond=0)


def _iso_utc(value):
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _safe_label(value, fallback):
    if not isinstance(value, str) or not value.strip():
        return fallback
    # Labels are supplied by account metadata.  Replace path separators and
    # control characters so an accidental local path cannot enter history.
    cleaned = " ".join(value.replace("/", "·").replace("\\", "·").split())
    return cleaned[:160] or fallback


def _safe_history_cards(metrics):
    cards = []
    for metric in metrics:
        if not isinstance(metric, dict):
            continue
        provider = _safe_label(metric.get("provider"), "usage").lower()
        account = _safe_label(metric.get("account"), "unknown")
        limits = metric.get("limits")
        if not isinstance(limits, list):
            limits = []
        for index, limit in enumerate(limits):
            if not isinstance(limit, dict):
                continue
            window = _safe_label(limit.get("window"), f"limit-{index + 1}")
            value = _safe_percentage(limit.get("used_percent"))
            available = limit.get("available") is not False and value is not None
            card = {
                "provider": provider,
                "account": account,
                "window": window,
                "available": bool(available),
                "status": "available" if available else "unavailable",
            }
            if available:
                card["used_percent"] = max(0.0, min(100.0, value))
            reason = limit.get("reason") or metric.get("reason")
            if not available and isinstance(reason, str):
                card["reason"] = _safe_label(reason, "Data unavailable")[:200]
            reset = _normalise_reset_timestamp(limit.get("resets_at"))
            if reset:
                card["resets_at"] = reset
            cards.append(card)
        if not limits and not isinstance(metric.get("dashboard_note"), dict):
            cards.append({
                "provider": provider,
                "account": account,
                "window": "rate limits",
                "available": False,
                "status": "unavailable",
                "reason": _safe_label(metric.get("reason"), "Data unavailable"),
            })
    return cards


def _lstat(path):
    try:
        return os.lstat(path)
    except OSError as error:
        raise PosterError(f"unable to inspect usage history path: {error}") from None


def _assert_no_symlink_components(path, allow_missing=True):
    """Reject symlinked ancestors before creating or opening feature files."""
    path = Path(path)
    current = Path(path.anchor) if path.anchor else Path()
    for component in path.parts[1:] if path.anchor else path.parts:
        current /= component
        try:
            mode = os.lstat(current).st_mode
        except FileNotFoundError:
            if allow_missing:
                continue
            raise PosterError(f"usage history path does not exist: {current}") from None
        except OSError as error:
            raise PosterError(f"unable to inspect usage history path: {error}") from None
        if stat.S_ISLNK(mode):
            # macOS exposes /var and /tmp as stable aliases to /private/*;
            # accepting only these OS-owned aliases keeps normal temp/home
            # paths usable while rejecting operator-controlled symlink hops.
            if sys.platform == "darwin" and str(current) in {"/var", "/tmp"}:
                continue
            raise PosterError(f"usage history path cannot contain symlink: {current}")


def _assert_regular_file(path, label="usage history file"):
    try:
        info = os.lstat(path)
    except OSError as error:
        raise PosterError(f"unable to inspect {label}: {error}") from None
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
        raise PosterError(f"{label} must be a regular, non-symlink file: {path}")
    return info


class HistoryStore:
    """Small, private SQLite history store guarded by an advisory lock."""

    def __init__(self, db_path):
        self.db_path = Path(db_path).expanduser()
        if not self.db_path.is_absolute():
            raise PosterError("history_db_path must be absolute")
        self.history_dir = self.db_path.parent
        self.lock_path = self.history_dir / ".history.lock"
        self.sidecar_paths = (
            Path(f"{self.db_path}-wal"),
            Path(f"{self.db_path}-shm"),
            Path(f"{self.db_path}-journal"),
        )

    def _prepare_directory(self):
        try:
            _assert_no_symlink_components(self.history_dir)
            _assert_no_symlink_components(self.db_path)
            _assert_no_symlink_components(self.lock_path)
            for sidecar in self.sidecar_paths:
                _assert_no_symlink_components(sidecar)

            if self.history_dir.exists():
                directory_info = _lstat(self.history_dir)
                if stat.S_ISLNK(directory_info.st_mode) or not stat.S_ISDIR(directory_info.st_mode):
                    raise PosterError("usage history directory must be a real directory")
                # An existing feature directory is never chmod'd: custom
                # database paths may live below a shared parent.  Require it
                # to already be private instead of mutating unrelated state.
                if directory_info.st_mode & 0o077:
                    raise PosterError("usage history directory must be private (mode 0700 or stricter)")
            else:
                self.history_dir.parent.mkdir(parents=True, exist_ok=True)
                try:
                    os.mkdir(self.history_dir, 0o700)
                except FileExistsError:
                    pass
                directory_info = _lstat(self.history_dir)
                if stat.S_ISLNK(directory_info.st_mode) or not stat.S_ISDIR(directory_info.st_mode):
                    raise PosterError("usage history directory must be a real directory")
                os.chmod(self.history_dir, 0o700)

            if self.db_path.exists():
                _assert_regular_file(self.db_path, "usage history database")
            for path in (self.lock_path, *self.sidecar_paths):
                if path.exists():
                    _assert_regular_file(path, "usage history sidecar")
        except OSError as error:
            raise PosterError(f"unable to prepare usage history directory: {error}") from None

    def _validate_schema(self, connection):
        try:
            version = int(connection.execute("PRAGMA user_version").fetchone()[0])
        except (sqlite3.Error, TypeError, ValueError, IndexError) as error:
            raise PosterError(f"usage history schema is unreadable or corrupt: {error}") from None
        if version not in (0, HISTORY_SCHEMA_VERSION):
            raise PosterError(
                f"unsupported usage history schema version {version}; expected {HISTORY_SCHEMA_VERSION}"
            )
        required = {
            "snapshots": {"slot_utc", "generated_at", "payload_json"},
            "posts": {"slot_utc", "posted_at", "message_id"},
            "warnings": {"warning_key", "warned_at"},
        }
        try:
            tables = {
                row[0]
                for row in connection.execute(
                    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
                )
            }
        except sqlite3.Error as error:
            raise PosterError(f"usage history schema is unreadable or corrupt: {error}") from None
        if version == 0:
            if not tables:
                # A brand-new database has no tables; initialize it in place.
                try:
                    connection.execute("BEGIN IMMEDIATE")
                    connection.execute(
                        "CREATE TABLE snapshots (slot_utc TEXT PRIMARY KEY, generated_at TEXT NOT NULL, payload_json TEXT NOT NULL)"
                    )
                    connection.execute(
                        "CREATE TABLE posts (slot_utc TEXT PRIMARY KEY, posted_at TEXT NOT NULL, message_id TEXT NOT NULL)"
                    )
                    connection.execute(
                        "CREATE TABLE warnings (warning_key TEXT PRIMARY KEY, warned_at TEXT NOT NULL)"
                    )
                    connection.execute("PRAGMA user_version = 1")
                    connection.commit()
                except sqlite3.Error as error:
                    with contextlib.suppress(sqlite3.Error):
                        connection.rollback()
                    raise PosterError(f"unable to initialize usage history schema atomically: {error}") from None
                except BaseException:
                    with contextlib.suppress(sqlite3.Error):
                        connection.rollback()
                    raise
            elif tables == set(required):
                # Version 0 was written before user_version was introduced.
                # Adopt a complete legacy store without rewriting its rows.
                for table, columns in required.items():
                    try:
                        actual = {row[1] for row in connection.execute(f"PRAGMA table_info({table})")}
                    except sqlite3.Error as error:
                        raise PosterError(f"usage history schema table {table!r} is unreadable: {error}") from None
                    if actual != columns:
                        raise PosterError(f"usage history schema table {table!r} is corrupt or unsupported")
            else:
                raise PosterError("usage history schema is partial or unsupported; refusing to migrate it")
            connection.execute("PRAGMA user_version = 1")
            connection.commit()
            return
        if tables != set(required):
            raise PosterError("usage history schema is partial or unsupported; refusing to migrate it")
        for table, columns in required.items():
            try:
                actual = {row[1] for row in connection.execute(f"PRAGMA table_info({table})")}
            except sqlite3.Error as error:
                raise PosterError(f"usage history schema table {table!r} is unreadable: {error}") from None
            if actual != columns:
                raise PosterError(f"usage history schema table {table!r} is corrupt or unsupported")

    @contextlib.contextmanager
    def locked(self):
        self._prepare_directory()
        fd = None
        lock_acquired = False
        connection = None
        try:
            try:
                nofollow = getattr(os, "O_NOFOLLOW", 0)
                fd = os.open(self.lock_path, os.O_RDWR | os.O_CREAT | nofollow, 0o600)
                os.fchmod(fd, 0o600)
                if not stat.S_ISREG(os.fstat(fd).st_mode):
                    raise PosterError("usage history lock must be a regular file")
            except OSError as error:
                raise PosterError(f"unable to open usage history lock: {error}") from None
            try:
                try:
                    fcntl.flock(fd, fcntl.LOCK_EX)
                    lock_acquired = True
                except OSError as error:
                    raise PosterError(f"unable to acquire usage history lock: {error}") from None
                try:
                    nofollow = getattr(os, "O_NOFOLLOW", 0)
                    probe_fd = os.open(self.db_path, os.O_RDWR | os.O_CREAT | nofollow, 0o600)
                    try:
                        if not stat.S_ISREG(os.fstat(probe_fd).st_mode):
                            raise PosterError("usage history database must be a regular file")
                    finally:
                        os.close(probe_fd)
                    previous_umask = os.umask(0o077)
                    try:
                        connection = sqlite3.connect(self.db_path, timeout=10)
                    finally:
                        os.umask(previous_umask)
                    connection.execute("PRAGMA busy_timeout = 10000")
                    connection.execute("PRAGMA journal_mode = DELETE")
                    self._validate_schema(connection)
                    _assert_regular_file(self.db_path, "usage history database")
                    for path in self.sidecar_paths:
                        if path.exists():
                            _assert_regular_file(path, "usage history sidecar")
                    os.chmod(self.db_path, 0o600)
                    yield connection
                except PosterError:
                    raise
                except (OSError, sqlite3.Error) as error:
                    raise PosterError(f"unable to open usage history database: {error}") from None
                finally:
                    if connection is not None:
                        connection.close()
            finally:
                if lock_acquired:
                    try:
                        fcntl.flock(fd, fcntl.LOCK_UN)
                    except OSError as error:
                        raise PosterError(f"unable to release usage history lock: {error}") from None
        finally:
            if fd is not None:
                try:
                    os.close(fd)
                except OSError as error:
                    raise PosterError(f"unable to close usage history lock: {error}") from None

    def write_snapshot(self, connection, slot, payload):
        encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
        connection.execute(
            "INSERT OR IGNORE INTO snapshots(slot_utc, generated_at, payload_json) VALUES (?, ?, ?)",
            (_iso_utc(slot), payload["generated_at"], encoded),
        )
        connection.commit()
        row = connection.execute(
            "SELECT payload_json FROM snapshots WHERE slot_utc = ?", (_iso_utc(slot),)
        ).fetchone()
        if not row:
            return payload
        try:
            return json.loads(row[0])
        except (TypeError, ValueError, json.JSONDecodeError):
            # A damaged current slot is replaced atomically with the newly
            # collected sanitized snapshot; older malformed rows remain
            # safely ignored by history().
            print(
                f"Warning: replacing malformed usage snapshot for UTC slot {_iso_utc(slot)}",
                file=sys.stderr,
            )
            connection.execute(
                "UPDATE snapshots SET generated_at = ?, payload_json = ? WHERE slot_utc = ?",
                (payload["generated_at"], encoded, _iso_utc(slot)),
            )
            connection.commit()
            return payload

    def retain(self, connection, now):
        cutoff = _iso_utc(now - timedelta(days=HISTORY_RETENTION_DAYS))
        connection.execute("DELETE FROM snapshots WHERE slot_utc < ?", (cutoff,))
        connection.commit()

    def history(self, connection, since=None):
        if since is None:
            rows = connection.execute("SELECT slot_utc, payload_json FROM snapshots ORDER BY slot_utc").fetchall()
        else:
            rows = connection.execute(
                "SELECT slot_utc, payload_json FROM snapshots WHERE slot_utc >= ? ORDER BY slot_utc", (_iso_utc(since),)
            ).fetchall()
        result = []
        for slot_utc, encoded in rows:
            try:
                if not isinstance(slot_utc, str):
                    continue
                slot = datetime.fromisoformat(slot_utc.replace("Z", "+00:00"))
                if slot.tzinfo is None:
                    continue
                canonical_slot = _iso_utc(slot)
                value = json.loads(encoded)
            except (TypeError, ValueError, OverflowError, json.JSONDecodeError):
                continue
            if isinstance(value, dict):
                # SQLite's primary-key slot is the durable chronology.  Never
                # trust a payload's self-reported time over that stored slot.
                result.append({**value, "generated_at": canonical_slot})
        return sorted(result, key=lambda snapshot: snapshot["generated_at"])

    def has_post(self, connection, slot):
        return connection.execute("SELECT 1 FROM posts WHERE slot_utc = ?", (_iso_utc(slot),)).fetchone() is not None

    def record_post(self, connection, slot, message_id, posted_at):
        connection.execute(
            "INSERT OR IGNORE INTO posts(slot_utc, posted_at, message_id) VALUES (?, ?, ?)",
            (_iso_utc(slot), _iso_utc(posted_at), str(message_id or "unknown")),
        )
        connection.commit()

    def maybe_warn_size(self, connection, now):
        # Only feature-owned SQLite artifacts are measured.  In particular,
        # never recurse through a configured Codex Home or Claude transcript
        # directory if an operator chose a nearby custom database path.
        owned_names = {
            self.db_path.name,
            f"{self.db_path.name}-wal",
            f"{self.db_path.name}-shm",
            f"{self.db_path.name}-journal",
            self.lock_path.name,
        }
        size = 0
        try:
            for entry in self.history_dir.iterdir():
                if entry.name not in owned_names:
                    continue
                info = os.lstat(entry)
                if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
                    continue
                size += info.st_size
        except OSError as error:
            print(f"Warning: unable to inspect usage history size: {error}", file=sys.stderr)
            return
        if size <= HISTORY_WARNING_BYTES:
            return
        row = connection.execute(
            "SELECT warned_at FROM warnings WHERE warning_key = 'history-size'"
        ).fetchone()
        last = None
        if row:
            try:
                last = datetime.fromisoformat(row[0].replace("Z", "+00:00"))
            except (TypeError, ValueError):
                last = None
        if last is not None and now - last < HISTORY_WARNING_INTERVAL:
            return
        print(
            "Warning: Usage Stats history directory exceeds 5 GiB "
            f"({size} bytes); old snapshots will be retained for {HISTORY_RETENTION_DAYS} days",
            file=sys.stderr,
        )
        if sys.platform == "darwin" and os.environ.get("CCDM_USAGE_STATS_NOTIFY", "1").lower() not in {"0", "false", "no"}:
            try:
                subprocess.run(
                    ["osascript", "-e", 'display notification "Usage Stats history exceeds 5 GiB" with title "CCDM"'],
                    check=False,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    timeout=5,
                )
            except (OSError, subprocess.SubprocessError):
                pass
        connection.execute(
            "INSERT OR REPLACE INTO warnings(warning_key, warned_at) VALUES ('history-size', ?)",
            (_iso_utc(now),),
        )
        connection.commit()


def _provider_dashboard_input(current, history, provider, metrics):
    """Build one provider image without mutating stored schema-v1 snapshots."""
    provider = _safe_label(provider, "usage").lower()

    def compatible(snapshot):
        if not isinstance(snapshot, dict):
            return snapshot
        copied = {**snapshot}
        cards = []
        codex_weekly = {}
        for raw_card in snapshot.get("cards", []):
            if not isinstance(raw_card, dict) or _safe_label(raw_card.get("provider"), "usage").lower() != provider:
                continue
            card = dict(raw_card)
            if provider != "codex":
                cards.append(card)
                continue
            # All historical Codex period names represent the same weekly
            # allowance.  If a legacy row has both labels, the real 7-day
            # value wins instead of producing two overlapping series.
            window = _safe_label(card.get("window"), "").lower().replace("_", " ")
            weekly_names = {"5-hour", "5 hour", "primary", "7-day", "7 day", "weekly"}
            if window not in weekly_names:
                cards.append(card)
                continue
            card["window"] = "Weekly"
            identity = (_safe_label(card.get("account"), "unknown"), _safe_label(card.get("key"), ""))
            priority = 2 if window in {"7-day", "7 day"} else 1 if window == "weekly" else 0
            previous = codex_weekly.get(identity)
            if previous is None:
                codex_weekly[identity] = (priority, len(cards))
                cards.append(card)
            elif priority > previous[0]:
                # Keep the first position stable, but replace its old value.
                codex_weekly[identity] = (priority, previous[1])
                cards[previous[1]] = card
        copied["cards"] = cards
        return copied

    notes = []
    for metric in metrics:
        if isinstance(metric, dict) and _safe_label(metric.get("provider"), "usage").lower() == provider:
            note = metric.get("dashboard_note")
            if isinstance(note, dict):
                notes.append(note)
    return {
        "schema_version": 1,
        "generated_at": current.get("generated_at"),
        "cards": compatible(current).get("cards", []),
        "history": [compatible(snapshot) for snapshot in history],
        "notes": notes,
    }


def _render_dashboard(payload, destination):
    if not RENDERER_PATH.is_file():
        raise PosterError(f"usage dashboard renderer not found: {RENDERER_PATH.name}")
    try:
        import importlib.util
        spec = importlib.util.spec_from_file_location("ccdm_usage_dashboard_renderer", RENDERER_PATH)
        if spec is None or spec.loader is None:
            raise ImportError("unable to load renderer")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        renderer = getattr(module, "render_trend_first", module.render_dashboard)
        rendered = renderer(payload, destination)
        result = Path(rendered)
        _assert_regular_file(result, "rendered usage dashboard")
        result.chmod(0o600)
        return result
    except (ImportError, OSError, ValueError, TypeError, SystemExit) as error:
        raise PosterError(f"unable to render usage dashboard: {error}") from None


def post_dashboard_to_discord(config, bot_token, image_paths, claude_value, codex_value=None):
    """Atomically upload the original text report and both trend PNGs."""
    boundary = f"----ccdm-usage-stats-{os.urandom(12).hex()}"
    files = [("claude-usage-dashboard.png", image_paths["claude"]), ("codex-usage-dashboard.png", image_paths["codex"])]
    payload = {"embeds": [_usage_report_embed(claude_value, codex_value)]}
    try:
        file_bytes = []
        for filename, image_path in files:
            _assert_regular_file(image_path, "rendered usage dashboard")
            file_bytes.append((filename, Path(image_path).read_bytes()))
    except (OSError, PosterError) as error:
        raise PosterError(f"unable to read rendered usage dashboard image: {error}") from None
    chunks = []
    chunks.append(
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"payload_json\"\r\n"
        f"Content-Type: application/json\r\n\r\n{json.dumps(payload, separators=(',', ':'))}\r\n".encode()
    )
    for index, (filename, image_bytes) in enumerate(file_bytes):
        chunks.append(
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"files[{index}]\"; filename=\"{filename}\"\r\n"
            f"Content-Type: image/png\r\n\r\n".encode() + image_bytes + b"\r\n"
        )
    chunks.append(f"--{boundary}--\r\n".encode())
    request = Request(
        f"{config['discord_base_url'].rstrip('/')}/api/v10/channels/{config['discord_channel_id']}/messages",
        data=b"".join(chunks),
        headers={
            "Authorization": f"Bot {bot_token}",
            "Content-Type": f"multipart/form-data; boundary={boundary}",
            "User-Agent": "ccdm-usage-stats-poster/1.0",
        },
        method="POST",
    )
    try:
        with urlopen(request, timeout=20) as response:
            if not 200 <= response.status < 300:
                raise PosterError(f"Discord dashboard post failed (HTTP {response.status})")
            result = json.loads(response.read().decode("utf-8"))
    except HTTPError as error:
        raise PosterError(f"Discord dashboard post failed (HTTP {error.code})") from None
    except (URLError, TimeoutError, OSError, UnicodeDecodeError, json.JSONDecodeError):
        raise PosterError("Discord dashboard post failed; check the endpoint and try again") from None
    return result.get("id", "unknown") if isinstance(result, dict) else "unknown"


def build_parser():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG_PATH, help="poster config JSON path")
    parser.add_argument(
        "--validate-config",
        action="store_true",
        help="parse the config and exit without reading registry credentials or contacting services",
    )
    parser.add_argument(
        "--collect-only",
        action="store_true",
        help="collect and persist one local history snapshot without posting",
    )
    parser.add_argument(
        "--scheduled",
        action="store_true",
        help="run the LaunchAgent behavior: post a trend image only in a UTC 30-minute slot",
    )
    parser.add_argument(
        "--post-now",
        action="store_true",
        help="manually force the trend image post (still records a local post ledger entry)",
    )
    return parser


def main(argv=None):
    args = build_parser().parse_args(argv)
    try:
        config = load_config(args.config)
        if args.validate_config:
            print("Poster configuration is valid")
            return 0
        registry, bot_token = load_registry_data(REGISTRY_PATH)
        scheduled = (
            args.scheduled
            or args.post_now
            or args.collect_only
            or os.environ.get("CCDM_USAGE_STATS_AUTOMATED") == "1"
        )

        # Preserve the legacy/manual surface as a completely independent
        # operation.  In particular, a broken or unwritable history path must
        # never prevent an operator from posting the existing JSON embed.
        if not scheduled:
            claude_metrics = collect_claude_metrics(config)
            codex_metrics = collect_codex_metrics(registry)
            claude_value, codex_value = _usage_report_values(claude_metrics, codex_metrics)
            post_to_discord(config, bot_token, claude_value, codex_value)
            return 0

        now = _utc_now()
        claude_metrics = collect_claude_metrics(config)
        codex_metrics = collect_codex_metrics(registry)
        metrics = claude_metrics + codex_metrics
        claude_value, codex_value = _usage_report_values(claude_metrics, codex_metrics)
        current_payload = {
            "schema_version": 1,
            "generated_at": _iso_utc(_floor_utc(now, 10)),
            "cards": _safe_history_cards(metrics),
        }
        store = HistoryStore(config["history_db_path"])
        with store.locked() as connection:
            store.retain(connection, now)
            current_payload = store.write_snapshot(connection, _floor_utc(now, 10), current_payload)
            store.maybe_warn_size(connection, now)
            if args.collect_only:
                print(f"Collected usage snapshot (UTC slot: {current_payload['generated_at']})")
                return 0
            if scheduled:
                post_slot = _floor_utc(now, 30)
                if not args.post_now and now.minute % 30 >= 10:
                    print(f"Collected usage snapshot (next post slot: {_iso_utc(post_slot + timedelta(minutes=30))})")
                    return 0
                if store.has_post(connection, post_slot):
                    print(f"Usage dashboard already posted for UTC slot: {_iso_utc(post_slot)}")
                    return 0
                # Display all persisted actual slots. Do not invent a 24-hour
                # baseline before the local history began.
                history = store.history(connection)
                temp_names = []
                try:
                    image_paths = {}
                    for provider in ("claude", "codex"):
                        temp_fd, temp_name = tempfile.mkstemp(
                            prefix=f"{provider}-usage-dashboard-", suffix=".png", dir=str(store.history_dir)
                        )
                        temp_names.append(temp_name)
                        try:
                            os.fchmod(temp_fd, 0o600)
                        finally:
                            os.close(temp_fd)
                        _assert_no_symlink_components(temp_name, allow_missing=False)
                        _assert_regular_file(temp_name, "temporary dashboard image")
                        image_paths[provider] = _render_dashboard(
                            _provider_dashboard_input(current_payload, history, provider, metrics), temp_name
                        )
                    message_id = post_dashboard_to_discord(
                        config, bot_token, image_paths, claude_value, codex_value
                    )
                    store.record_post(connection, post_slot, message_id, now)
                    print(f"Posted trend dashboard (message ID: {message_id}; UTC slot: {_iso_utc(post_slot)})")
                finally:
                    for temp_name in temp_names:
                        Path(temp_name).unlink(missing_ok=True)
                return 0

        return 0
    except PosterError as error:
        print(f"Error: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
