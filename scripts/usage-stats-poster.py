#!/usr/bin/env python3
"""Post a text-only Claude, Codex and Antigravity Usage Report to one Discord channel."""

import argparse
import contextlib
import hashlib
import http.client
import json
import math
import os
import re
import stat
import queue
import select
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import sqlite3
from decimal import Decimal, InvalidOperation
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import HTTPRedirectHandler, Request, build_opener, urlopen


SCRIPT_DIR = Path(__file__).resolve().parent
sys.dont_write_bytecode = True  # no __pycache__ beside the scripts
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from ccdmlib.platform import credentials as claude_credentials  # noqa: E402
from ccdmlib.platform import exe, filelock, paths, proc  # noqa: E402
from ccdmlib.platform.private_fs import ensure_private_dir, fix_hint, is_private  # noqa: E402

WIN32 = sys.platform == "win32"
# Windows runs on the same accounts as the Mac, which stays the only poster.
COLLECT_ONLY_PLATFORM = WIN32
COLLECT_ONLY_MESSAGE = "Windows collects usage only; run with --collect-only"
ROOT_DIR = SCRIPT_DIR.parent
DEFAULT_CONFIG_PATH = ROOT_DIR / ".usage-stats-poster.json"
REGISTRY_PATH = ROOT_DIR / "registry.json"
PLAIN_CLAUDE_SERVICE = claude_credentials.PLAIN_KEYCHAIN_SERVICE
DEFAULT_HISTORY_DB_PATH = (
    paths.state_root() / "usage-stats" / "history.sqlite3"
    if WIN32
    else Path.home() / "Library" / "Application Support" / "CCDM" / "usage-stats" / "history.sqlite3"
)
HISTORY_RETENTION_DAYS = 365
HISTORY_WARNING_BYTES = 5 * 1024 * 1024 * 1024
HISTORY_WARNING_INTERVAL = timedelta(hours=24)
RENDERER_PATH = SCRIPT_DIR / "usage-dashboard-renderer.py"
DEEPSEEK_USAGE_MODULE_PATH = SCRIPT_DIR / "deepseek-local-usage.py"
DEEPSEEK_MARKER_NAME = "ccdm-deepseek.json"
DEEPSEEK_MARKER = {"version": 1, "provider": "deepseek"}
DEEPSEEK_KEY_NAME = "api-key"
DEEPSEEK_DEFAULT_BASE_URL = "https://api.deepseek.com"
DEEPSEEK_BALANCE_ENDPOINT = "/user/balance"
DEEPSEEK_MARKER_MAX_BYTES = 4 * 1024
DEEPSEEK_KEY_MAX_BYTES = 4 * 1024
DEEPSEEK_RESPONSE_MAX_BYTES = 64 * 1024
# Compact one-line footer that keeps the important account-vs-local distinction
# without spending embed space on a technical coverage paragraph.
DEEPSEEK_FOOTER = "*Balance: whole account · Usage: local Codex*"
# A balance reference is a self-contained display budget: a safe alias plus a
# currency and a positive decimal amount.  These caps keep the decoded value
# bounded so nothing over-long can reach the embed.
DEEPSEEK_REFERENCE_MAX_ALIAS_LENGTH = 160
DEEPSEEK_REFERENCE_MAX_AMOUNT_LENGTH = 40
# Display-only currency symbols; the balance schema itself stays USD/CNY only.
DEEPSEEK_CURRENCY_SYMBOLS = {"USD": "$", "CNY": "¥"}
# DeepSeek returns decimal money as strings.  Accept only bounded, plain
# non-negative decimals so no float rounding or exponent parsing is involved.
DEEPSEEK_AMOUNT_PATTERN = re.compile(r"^\d{1,24}(?:\.\d{1,8})?$")
# DeepSeek documents exactly these currency values in the balance schema, so a
# balance row in any other currency is treated as malformed rather than shown.
DEEPSEEK_CURRENCIES = ("CNY", "USD")
DEEPSEEK_KEY_PATTERN = re.compile(r"^sk-[A-Za-z0-9_-]+$")
HISTORY_SCHEMA_VERSION = 1
CLAUDE_PRICES = {
    "claude-haiku-4-5": (1.0, 5.0),
    "claude-sonnet-4-6": (3.0, 15.0),
    "claude-opus-4-6": (15.0, 75.0),
    "claude-opus-4-7": (5.0, 25.0),
}


class PosterError(Exception):
    """An actionable, safe-to-display poster error."""


class AmbiguousPostError(PosterError):
    """Discord received the whole request but its reply was lost, so the post may exist."""


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


CREDENTIAL_PROBLEMS = "credential-file-problems"
CREDENTIAL_NOTICES = "credential-file-notices"


def _read_oauth_credential(service, cache=None):
    if not isinstance(service, claude_credentials.CredentialFile):
        return claude_credentials.read_keychain_item(service)
    cache = {} if cache is None else cache
    result = claude_credentials.read_credentials_file(service.config_dir)
    cache.setdefault(CREDENTIAL_PROBLEMS, {})[service] = result.reason
    noticed = cache.setdefault(CREDENTIAL_NOTICES, set())
    for line in (*result.refusals, *result.warnings):
        if line not in noticed:
            noticed.add(line)
            print(f"Warning: {line}", file=sys.stderr)
    return result.oauth


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


def claude_oauth_account(config_json_path):
    """Return the ``oauthAccount`` Claude Code stored for a home, if any."""
    try:
        data = json.loads(Path(config_json_path).read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, TypeError, ValueError, json.JSONDecodeError):
        return None
    if not isinstance(data, dict):
        return None
    oauth_account = data.get("oauthAccount")
    return oauth_account if isinstance(oauth_account, dict) else None


def claude_account_email(oauth_account):
    """Return the lower-cased login email of ``oauth_account``, if usable."""
    email = oauth_account.get("emailAddress") if isinstance(oauth_account, dict) else None
    return email.strip().lower() if isinstance(email, str) and email.strip() else None


def _oauth_expiry(oauth):
    try:
        return float(oauth.get("expiresAt"))
    except (TypeError, ValueError):
        return float("-inf")


def _oauth_expired(oauth):
    expires_at = oauth.get("expiresAt")
    if not expires_at:
        return False
    try:
        return float(expires_at) / 1000 < datetime.now(timezone.utc).timestamp()
    except (TypeError, ValueError):
        return False


def _read_oauth_credentials(services, cache=None):
    """Return the readable OAuth credentials among ``services``, freshest first.

    A home can hold both its hashed and its plain Keychain item, and only the
    one its sessions run under keeps being refreshed, so the first readable
    item can be a stale leftover. Ties keep the ``services`` order. ``cache``
    lets one collection run read each shared Keychain item only once.
    """
    cache = {} if cache is None else cache
    for service in services:
        if service not in cache:
            cache[service] = _read_oauth_credential(service, cache)
    credentials = [cache[service] for service in services if cache[service]]
    return sorted(credentials, key=_oauth_expiry, reverse=True)


def claude_home_services(config_dir):
    """Where one Claude home's login can be: Keychain items, hashed first, or its file."""
    if claude_credentials.uses_keychain():
        return claude_credentials.keychain_services(config_dir)
    return [claude_credentials.credential_file(config_dir)]


def discover_claude_accounts():
    """Return each Claude login as ``(services, label, dir_hint, email)``.

    The first entry is always the default ``~/.claude`` home, labelled
    ``claude-p``; every other OAuth home ``~/.claude-<name>`` is labelled
    ``claude-<name>``. ``services`` lists every Keychain item that can hold
    that home's login, and ``email`` is the account the home is logged in to
    (``None`` when unknown); callers read them with ``_read_oauth_credentials``
    and keep only a credential whose profile matches ``email``.

    The plain ``Claude Code-credentials`` item belongs to whichever account
    the last session without ``CLAUDE_CONFIG_DIR`` logged in to, so it is a
    candidate for every home whose account is known and never trusted blindly.
    """
    home = Path.home()
    default_email = claude_account_email(claude_oauth_account(home / ".claude" / ".claude.json"))
    accounts = [(claude_home_services(home / ".claude"), "claude-p", "~/.claude", default_email)]
    try:
        config_dirs = sorted(home.glob(".claude-*"))
    except (OSError, RuntimeError, ValueError):
        return accounts

    for config_dir in config_dirs:
        try:
            if not config_dir.is_dir():
                continue
        except OSError:
            continue
        oauth_account = claude_oauth_account(config_dir / ".claude.json")
        if not oauth_account:
            continue
        email = claude_account_email(oauth_account)
        services = claude_home_services(config_dir)
        if email and claude_credentials.uses_keychain():
            services.append(PLAIN_CLAUDE_SERVICE)
        accounts.append((services, config_dir.name.lstrip("."), f"~/{config_dir.name}", email))
    return accounts


def _claude_relogin_block(label, dir_hint):
    command = f"CLAUDE_CONFIG_DIR={dir_hint} claude /login"
    return f"**{label}**\n*Needs re-login: `{command}`*"


def _parse_url(value, field):
    if value is None:
        return None
    if not isinstance(value, str) or not value.strip():
        raise PosterError(f"{field} must be a non-empty URL")
    parsed = urlparse(value)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise PosterError(f"{field} must be an HTTP(S) URL")
    return value.rstrip("/")


def _parse_loopback_base_url(value, field):
    """Accept only a literal loopback ``http://`` override for local tests.

    The official DeepSeek endpoint is HTTPS; the only supported override is a
    plain HTTP loopback origin so local-fake tests never send the private API
    key to a real host or through a redirect.  ``urlparse`` itself can raise
    ``ValueError`` for a malformed bracketed host, so parsing is wrapped to
    surface a safe ``PosterError`` instead of a traceback.
    """
    if value is None:
        return None
    if not isinstance(value, str) or not value.strip():
        raise PosterError(f"{field} must be a non-empty URL")
    try:
        parsed = urlparse(value.strip())
        host = (parsed.hostname or "").lower()
        port = parsed.port
    except ValueError:
        raise PosterError(f"{field} override must be a literal loopback http:// URL") from None
    if (
        parsed.scheme != "http"
        or host not in {"127.0.0.1", "::1", "localhost"}
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
        or parsed.path not in ("", "/")
    ):
        raise PosterError(f"{field} override must be a literal loopback http:// URL")
    if port is None:
        raise PosterError(f"{field} override must include an explicit loopback port")
    if not 0 <= port <= 65535:
        raise PosterError(f"{field} override must use a port between 0 and 65535")
    # IPv6 literals must keep their brackets when rebuilt into a URL.
    host_text = f"[{host}]" if ":" in host else host
    return f"http://{host_text}:{port}"


def _parse_deepseek_reference_amount(value):
    """Return an exact, bounded, positive decimal money string.

    The configured budget is a display reference, not a provider quota, so it
    must be a plain positive decimal string.  Floats, exponents, negatives,
    zero, empty values, and over-long figures are rejected instead of being
    coerced.
    """
    if not isinstance(value, str) or value != value.strip() or not DEEPSEEK_AMOUNT_PATTERN.match(value):
        raise PosterError("deepseek_balance_references amount must be a positive decimal string")
    try:
        number = Decimal(value)
    except (InvalidOperation, ValueError):
        raise PosterError("deepseek_balance_references amount must be a positive decimal string") from None
    if not number.is_finite() or number <= 0:
        raise PosterError("deepseek_balance_references amount must be a positive decimal string")
    text = format(number, "f")
    if len(text) > DEEPSEEK_REFERENCE_MAX_AMOUNT_LENGTH:
        raise PosterError("deepseek_balance_references amount must be a bounded decimal string")
    return text


def _parse_deepseek_balance_references(value):
    """Validate the optional ``deepseek_balance_references`` config object.

    Shape: ``{"<account alias>": {"currency": "USD"|"CNY", "amount": "50.00"}}``.
    Each reference is self-contained; extra or unknown fields are rejected so
    no external origin, key, or path can be smuggled into the display budget.
    """
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise PosterError("deepseek_balance_references must be a JSON object")
    references = {}
    for alias, raw in value.items():
        if (
            not isinstance(alias, str)
            or not alias.strip()
            or alias != alias.strip()
            or len(alias) > DEEPSEEK_REFERENCE_MAX_ALIAS_LENGTH
        ):
            raise PosterError("deepseek_balance_references keys must be non-empty account aliases")
        if not isinstance(raw, dict):
            raise PosterError(f"deepseek_balance_references[{alias!r}] must be a JSON object")
        if set(raw) != {"currency", "amount"}:
            raise PosterError(
                f"deepseek_balance_references[{alias!r}] must contain only currency and amount"
            )
        currency = raw.get("currency")
        if not isinstance(currency, str) or currency.strip() not in DEEPSEEK_CURRENCIES:
            raise PosterError(f"deepseek_balance_references[{alias!r}] currency must be USD or CNY")
        amount = _parse_deepseek_reference_amount(raw.get("amount"))
        references[alias] = {"currency": currency.strip(), "amount": amount}
    return references


def parse_config(raw):
    if not isinstance(raw, dict):
        raise PosterError("poster config must contain a JSON object")
    channel_id = raw.get("discord_channel_id", raw.get("channel_id"))
    if COLLECT_ONLY_PLATFORM:
        channel_id = None
    elif not isinstance(channel_id, str) or not channel_id.strip():
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

    deepseek_base_url = raw.get("deepseek_base_url")
    if deepseek_base_url is None:
        deepseek_base_url = os.environ.get("CCDM_DEEPSEEK_BASE_URL")
    deepseek_base_url = _parse_loopback_base_url(deepseek_base_url, "deepseek_base_url") or DEEPSEEK_DEFAULT_BASE_URL
    deepseek_balance_references = _parse_deepseek_balance_references(raw.get("deepseek_balance_references"))

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
        "deepseek_base_url": deepseek_base_url,
        "deepseek_balance_references": deepseek_balance_references,
        "claude_api_accounts": normalized_accounts,
        "history_db_path": history_db_path,
    }


def load_config(path):
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise PosterError(f"poster config not found: {path.name}") from None
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        raise PosterError(f"unable to read valid JSON from {path.name}") from None
    return parse_config(raw)


def load_registry(path):
    try:
        registry = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise PosterError("registry.json not found next to the repository") from None
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        raise PosterError("unable to read valid registry.json") from None
    if not isinstance(registry, dict):
        raise PosterError("unable to read valid registry.json")
    return registry


def load_registry_data(path, require_token=True):
    registry = load_registry(path)
    if not require_token:
        return registry, None
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


def _codex_reset_credit_deadline(reset_credits, now=None):
    """Return the earliest expiry among available, unexpired reset credits."""
    now = now or datetime.now(timezone.utc)
    deadline = None
    credits = reset_credits.get("credits")
    for credit in credits if isinstance(credits, list) else []:
        if not isinstance(credit, dict) or credit.get("status") != "available":
            continue
        expires_at = _normalise_reset_timestamp(credit.get("expiresAt"))
        if not expires_at:
            continue
        expires = datetime.fromisoformat(expires_at.replace("Z", "+00:00"))
        if expires > now:
            deadline = min(deadline, expires) if deadline else expires
    return deadline.isoformat() if deadline else None


CODEX_CREDIT_BALANCE_MAX_LENGTH = 40
# Used credits are summed over these trailing windows of the poster's history.
CODEX_CREDIT_USAGE_WINDOWS = (("24h", timedelta(hours=24)), ("7d", timedelta(days=7)))
# A window's baseline is the last stored balance at or before its start, and
# must be no older than this; otherwise history cannot cover the window.
CODEX_CREDIT_BASELINE_MAX_AGE = timedelta(hours=6)
CODEX_CREDIT_ACCOUNT_KEY_PATTERN = re.compile(r"^[0-9a-f]{16}$")


def _codex_credit_account_key(account_id):
    """Return a short salted hash of the app-server ``accountId``, or ``None``.

    Only this hash is kept, so credit history can tell accounts apart (a home
    that switches ChatGPT accounts, or a label that moves) without storing the
    identifier itself.
    """
    if not isinstance(account_id, str) or not account_id.strip():
        return None
    return hashlib.sha256(f"ccdm-credits:{account_id}".encode("utf-8")).hexdigest()[:16]


def _parse_codex_credit_balance(value):
    """Return a finite, non-negative credit balance from a decimal string, or ``None``."""
    if isinstance(value, bool) or not isinstance(value, (str, int, float)):
        return None
    text = str(value).strip()
    if not text or len(text) > CODEX_CREDIT_BALANCE_MAX_LENGTH:
        return None
    try:
        amount = Decimal(text)
    except (InvalidOperation, ValueError):
        return None
    if not amount.is_finite() or amount < 0:
        return None
    # abs() turns "-0" into 0 so it never renders as "-0".
    balance = float(abs(amount))
    return balance if math.isfinite(balance) else None


def _codex_credits(rate_limits):
    """Return ``{"unlimited": True}``, ``{"balance": float}``, or ``None`` to show nothing."""
    credits = rate_limits.get("credits") if isinstance(rate_limits, dict) else None
    if not isinstance(credits, dict):
        return None
    if credits.get("unlimited") is True:
        return {"unlimited": True}
    balance = _parse_codex_credit_balance(credits.get("balance"))
    if balance is None or (credits.get("hasCredits") is not True and balance <= 0):
        return None
    return {"balance": balance}


def _fmt_credits(value):
    """Format a credit amount with thousands separators and no false precision."""
    if value >= 100:
        return f"{value:,.0f}"
    text = f"{value:,.1f}" if value >= 10 else f"{value:,.2f}"
    return text.rstrip("0").rstrip(".")


def _codex_credit_marker(rate_limits, credits):
    """Return a short spend-state marker, or ``None`` when ordinary usage applies."""
    if rate_limits.get("spendControlReached") is True:
        return "spend limit reached"
    reached = rate_limits.get("rateLimitReachedType")
    if isinstance(reached, str) and reached.endswith("credits_depleted"):
        return "credits depleted"
    weekly = _codex_weekly_limit(rate_limits)
    used = _safe_percentage(weekly.get("usedPercent", weekly.get("used_percent"))) if isinstance(weekly, dict) else None
    limit_reached = reached == "rate_limit_reached" or (used is not None and used >= 100)
    has_balance = credits.get("unlimited") is True or credits.get("balance", 0) > 0
    return "running on credits" if limit_reached and has_balance else None


def format_codex_credits(rate_limits, credits_used=None):
    """Return the Codex credits line, or ``None`` when the account reports none.

    ``credits_used`` maps a window label (``24h``/``7d``) to the credits used
    in that window; a window history cannot cover yet is ``None`` and omitted.
    """
    credits = _codex_credits(rate_limits)
    if credits is None:
        return None
    if credits.get("unlimited"):
        line = "Credits: **unlimited**"
    else:
        line = f"Credits: **{_fmt_credits(credits['balance'])}** left"
        used = [
            f"{_fmt_credits(credits_used[window])} in {window}"
            for window, _ in CODEX_CREDIT_USAGE_WINDOWS
            if isinstance(credits_used, dict) and credits_used.get(window) is not None
        ]
        if used:
            line += " · used " + " · ".join(used)
    marker = _codex_credit_marker(rate_limits, credits)
    return f"{line} · {marker}" if marker else line


def _codex_credits_used(points, balance, now):
    """Sum credit-balance decreases per trailing window from ``(time, balance)`` points.

    ``points`` must all belong to the current account. ``balance`` is the
    current live balance, taken as the last point at ``now``. Each window starts
    from its baseline, the last point at or before the window start; without a
    baseline no older than ``CODEX_CREDIT_BASELINE_MAX_AGE`` the window is
    ``None``. Increases between consecutive points are top-ups and are ignored.
    """
    ordered = sorted(points)
    used = {}
    for window, length in CODEX_CREDIT_USAGE_WINDOWS:
        start = now - length
        baseline = [point for point in ordered if point[0] <= start][-1:]
        if not baseline or baseline[0][0] < start - CODEX_CREDIT_BASELINE_MAX_AGE:
            used[window] = None
            continue
        series = baseline + [point for point in ordered if start < point[0] <= now]
        values = [value for _, value in series] + [balance]
        used[window] = sum(max(0.0, before - after) for before, after in zip(values, values[1:]))
    return used


def _history_credit_balance(value):
    """Return a stored balance only when it is a finite, non-negative number."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    try:
        value = float(value)
    except OverflowError:
        return None
    return value if math.isfinite(value) and value >= 0 else None


def read_codex_credit_history(db_path, since):
    """Read stored Codex credit balances per label since ``since``.

    Returns ``{label: [(slot, balance, account_key)]}``; ``account_key`` is the
    stored account hash, or ``None`` when absent (such a point is never
    compared with a live balance).

    The read is read-only and best effort: a missing, locked, unreadable, or
    malformed history returns ``{}`` (no used figures), never an error, so the
    manual post path cannot fail because of history.
    """
    try:
        path = Path(db_path).expanduser()
        if not path.is_absolute():
            return {}
        if not stat.S_ISREG(os.lstat(path).st_mode):
            return {}
        # The store always uses a rollback journal. A WAL sidecar is foreign,
        # and even a read-only open would write its shared-memory file, so skip.
        if any(os.path.lexists(f"{path}{suffix}") for suffix in ("-wal", "-shm")):
            return {}
        connection = sqlite3.connect(f"{path.as_uri()}?mode=ro", uri=True, timeout=2)
        try:
            rows = connection.execute(
                "SELECT slot_utc, payload_json FROM snapshots WHERE slot_utc >= ? ORDER BY slot_utc",
                (_iso_utc(since),),
            ).fetchall()
        finally:
            connection.close()
    except Exception:  # noqa: BLE001 - history only adds optional used figures.
        return {}
    history = {}
    for slot_utc, encoded in rows:
        try:
            slot = datetime.fromisoformat(str(slot_utc).replace("Z", "+00:00"))
            payload = json.loads(encoded)
        except (TypeError, ValueError, OverflowError, json.JSONDecodeError):
            continue
        cards = payload.get("cards") if isinstance(payload, dict) else None
        if slot.tzinfo is None or not isinstance(cards, list):
            continue
        seen = set()
        for card in cards:
            if not isinstance(card, dict) or card.get("provider") != "codex":
                continue
            account = card.get("account")
            balance = _history_credit_balance(card.get("credits_balance"))
            if not isinstance(account, str) or balance is None or account in seen:
                continue
            seen.add(account)
            key = card.get("credits_account")
            key = key if isinstance(key, str) and CODEX_CREDIT_ACCOUNT_KEY_PATTERN.match(key) else None
            history.setdefault(account, []).append((slot, balance, key))
    return history


def format_codex_rate_limits(rate_limits, label, reset_credits=None, source_ts=None, now=None, credits_used=None):
    plan = _format_plan(rate_limits.get("planType", rate_limits.get("plan_type")))
    lines = [f"**{label}** ({plan})"]
    data = _codex_weekly_limit(rate_limits)
    if isinstance(data, dict):
        used_percent = _safe_percentage(data.get("usedPercent", data.get("used_percent")))
        reset = _format_rate_limit_reset(data.get("resetsAt", data.get("resets_at")))
        reset_part = f"  resets in {reset}" if reset else ""
        value_text = text_bar(used_percent) if used_percent is not None else "*unavailable*"
        lines.append(f"Weekly: {value_text}{reset_part}")
    credits_line = format_codex_credits(rate_limits, credits_used)
    if credits_line:
        lines.append(credits_line)
    if reset_credits is None:
        reset_credits = rate_limits.get("rateLimitResetCredits")
    if isinstance(reset_credits, dict) and isinstance(reset_credits.get("availableCount"), int):
        line = f"Full resets available: **{reset_credits['availableCount']}**"
        deadline = _codex_reset_credit_deadline(reset_credits, now)
        if deadline:
            line += f"  use within {fmt_reset(deadline, now or datetime.now(timezone.utc))}"
        lines.append(line)
    age_marker = _format_age_marker(source_ts)
    if age_marker:
        lines.append(age_marker)
    return "\n".join(lines)


CODEX_REQUEST_TIMEOUT_SECONDS = 10


def _start_line_reader(stream):
    """A pipe cannot be polled on Windows, so a daemon thread reads it into a queue.

    Returns ``read_line(deadline)``: one line, or ``None`` at EOF or at the deadline.
    """
    lines = queue.Queue()

    def pump():
        try:
            for line in iter(stream.readline, b""):
                lines.put(line.rstrip(b"\r\n"))
        except (OSError, ValueError):
            pass
        lines.put(None)

    threading.Thread(target=pump, daemon=True).start()

    def read_line(deadline):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return None
        try:
            return lines.get(timeout=remaining)
        except queue.Empty:
            return None

    return read_line


def read_codex_rate_limits(codex_home):
    """Read one Codex Home's live rate limits through the local app-server boundary."""
    environment = os.environ.copy()
    environment.pop("ROOT_CODEX_HOME", None)
    environment["CODEX_HOME"] = str(codex_home)
    command = ["codex", "app-server", "--stdio"]
    launch_options = {}
    if WIN32:
        # A bare name or a .cmd cannot start here, so the resolver names the program.
        try:
            resolved = exe.codex()
        except exe.ToolNotFound:
            return None
        command = [resolved["command"], *resolved["args"], "app-server", "--stdio"]
        environment.update(resolved["env"])
        launch_options["creationflags"] = subprocess.CREATE_NO_WINDOW
    try:
        process = subprocess.Popen(
            command,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            env=environment,
            **launch_options,
        )
    except (OSError, subprocess.SubprocessError):
        return None

    def terminate_process():
        try:
            process.stdin.close()
        except (OSError, ValueError):
            pass
        if WIN32:
            # Codex is a tree on Windows (a launcher and its children), so all of it stops.
            with contextlib.suppress(OSError):
                proc.kill_tree(process.pid)
            with contextlib.suppress(OSError, subprocess.TimeoutExpired):
                process.wait(timeout=2)
            return
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
        if not WIN32:
            os.set_blocking(stdout_fd, False)
    except (AttributeError, OSError, ValueError):
        terminate_process()
        return None

    def read_posix_line(deadline):
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

    read_line = _start_line_reader(process.stdout) if WIN32 else read_posix_line

    def request(request_id, method, params=None):
        message = {"jsonrpc": "2.0", "id": request_id, "method": method}
        if params is not None:
            message["params"] = params
        try:
            process.stdin.write((json.dumps(message) + "\n").encode("utf-8"))
            process.stdin.flush()
        except (BrokenPipeError, OSError, ValueError):
            return None
        deadline = time.monotonic() + CODEX_REQUEST_TIMEOUT_SECONDS
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
        # Keep only a salted hash of the account id, for credit history.
        account_key = _codex_credit_account_key(result.get("accountId"))
        if account_key:
            rate_limits["creditAccountKey"] = account_key
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
    if is_deepseek_home(codex_home):
        # DeepSeek reporting bypasses the subscription rate-limit request: the
        # home reports its real account-wide API balance plus this machine's
        # local token totals through the same display helper as the dashboard.
        # A DeepSeek-backed root Codex session still runs through the Codex
        # app-server; only this rate-limit query is skipped.
        return _deepseek_home_report(codex_home, label)
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
    """Return the legacy text report through the shared metrics helpers.

    Routing through ``collect_codex_metrics`` keeps this legacy surface equal
    to the scheduled dashboard path, so a DeepSeek home reports its real
    account-wide balance instead of a placeholder note, while still issuing one
    balance request per distinct DeepSeek key.
    """
    metrics = collect_codex_metrics(registry)
    if not metrics:
        return None
    value = "\n\n".join(
        metric["text"]
        for metric in metrics
        if isinstance(metric.get("text"), str) and metric["text"]
    )
    if len(value) > 1024:
        value = value[:1000].rstrip() + "\n*truncated*"
    return value or None


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


class ClaudeAccountMismatch(PosterError):
    """No readable credential belongs to the account a Claude home is logged in to."""


CLAUDE_CODE_VERSION_RE = re.compile(r"^\d+\.\d+\.\d+$")
CLAUDE_RESET_GRANTS_USAGE_ENDPOINT = "/api/oauth/usage?cedar_ember=1"


CLAUDE_REFRESH_TIMEOUT_SECONDS = 60


def claude_code_executable():
    """Return the installed native Claude Code binary, or ``None``.

    The native installer links ``claude`` to ``versions/<version>``, so the
    resolved name is the version. LaunchAgent runs lack ``~/.local/bin`` on
    PATH, so that link is checked before PATH. Anthropic reports limit-reset
    grants only to a recent Claude Code client, so without this binary the
    poster keeps the plain usage request and shows no reset count.
    """
    if WIN32:
        # Windows has no versions/<version> link; the version comes from the program.
        try:
            return Path(exe.claude()["command"])
        except exe.ToolNotFound:
            return None
    candidates = [Path.home() / ".local" / "bin" / "claude"]
    found = shutil.which("claude")
    if found:
        candidates.append(Path(found))
    for candidate in candidates:
        try:
            resolved = candidate.resolve(strict=True)
        except (OSError, RuntimeError):
            continue
        if CLAUDE_CODE_VERSION_RE.match(resolved.name):
            return resolved
    return None


def _windows_subprocess_options():
    """No console window, and output decoded as UTF-8 instead of the ANSI code page."""
    return {"creationflags": subprocess.CREATE_NO_WINDOW, "encoding": "utf-8", "errors": "replace"} if WIN32 else {}


def claude_code_client_version(executable):
    """The client version of a Claude Code binary, or ``None`` when it cannot be told."""
    if not WIN32:
        return executable.name
    try:
        result = subprocess.run(
            [str(executable), "--version"],
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            timeout=10,
            **_windows_subprocess_options(),
        )
    except (OSError, subprocess.SubprocessError):
        return None
    words = (result.stdout or "").split()
    return words[0] if result.returncode == 0 and words and CLAUDE_CODE_VERSION_RE.match(words[0]) else None


def refresh_claude_login(executable, config_dir):
    """Have Claude Code refresh one home's login; return whether it ran cleanly.

    Anthropic rotates the refresh token on every refresh, so the poster never
    refreshes a token itself: a print-mode ``/usage`` makes Claude Code refresh
    and save the new tokens under its own locking, without a model turn. With
    ``config_dir`` ``None`` it runs as a default session, refreshing the plain
    Keychain item. Settings, hooks, MCP servers, and the transcript are skipped.
    """
    env = {key: value for key, value in os.environ.items() if key != "CLAUDE_CONFIG_DIR"}
    if config_dir is not None:
        env["CLAUDE_CONFIG_DIR"] = str(config_dir)
    try:
        with tempfile.TemporaryDirectory(prefix="ccdm-claude-refresh-") as cwd:
            result = subprocess.run(
                [
                    str(executable), "-p", "/usage",
                    "--no-session-persistence", "--strict-mcp-config", "--setting-sources", "",
                    "--output-format", "json",
                ],
                cwd=cwd,
                env=env,
                stdin=subprocess.DEVNULL,
                capture_output=True,
                text=True,
                timeout=CLAUDE_REFRESH_TIMEOUT_SECONDS,
                **_windows_subprocess_options(),
            )
    except (OSError, subprocess.SubprocessError):
        return False
    return result.returncode == 0


def _claude_headers(oauth, client_version=None):
    return {
        "Authorization": f"Bearer {oauth['accessToken']}",
        "anthropic-beta": "oauth-2025-04-20",
        "User-Agent": (
            f"claude-cli/{client_version} (external, cli)" if client_version else "claude-code/usage-stats-poster"
        ),
    }


# Scoped weekly buckets whose suffix names a model, e.g. ``seven_day_opus``.
CLAUDE_RESET_MODEL_BUCKETS = {"fable": "Fable", "opus": "Opus", "sonnet": "Sonnet", "haiku": "Haiku"}


def _claude_reset_group(grant, scope_name):
    """Return a reset grant's display group, or ``None`` for an unknown shape.

    A grant that clears the all-models ``seven_day`` bucket, or the 5-hour
    session without any 7-day bucket, is a general reset. One that clears only
    a scoped weekly bucket (``seven_day_<bucket>``) resets a single model's
    allowance: it takes the model named by the bucket (``seven_day_opus``),
    else the account's one model-scoped weekly limit, else "Fable" when its
    label says so, else "model". A grant without a ``clears`` list is ignored.
    """
    clears = grant.get("clears")
    if not isinstance(clears, list):
        return None
    buckets = [bucket for bucket in clears if isinstance(bucket, str)]
    if "seven_day" in buckets:
        return "general"
    scoped = [bucket[len("seven_day_"):] for bucket in buckets if bucket.startswith("seven_day_")]
    if not scoped:
        return "general" if "five_hour" in buckets else None
    named = next((CLAUDE_RESET_MODEL_BUCKETS[name] for name in scoped if name in CLAUDE_RESET_MODEL_BUCKETS), None)
    if named:
        return named
    if scope_name:
        return scope_name
    label = grant.get("label")
    return "Fable" if isinstance(label, str) and "fable" in label.lower() else "model"


def format_claude_limit_resets(status, now=None, scope_name=None):
    """Return the limit-reset line for a usage ``cedar_ember`` block, if any.

    Ineligible accounts get no line. Paused, expired, and used-up grants are
    not usable, so they are left out of every count and use-by deadline.
    General resets and model-scoped (Fable) resets are counted separately,
    each with its own earliest deadline; a group with none is omitted.
    """
    if not isinstance(status, dict) or status.get("eligible") is not True:
        return None
    now = now or datetime.now(timezone.utc)
    groups = {}
    grants = status.get("grants")
    for grant in grants if isinstance(grants, list) else []:
        if not isinstance(grant, dict) or grant.get("paused") is True:
            continue
        left = grant.get("resets_left")
        if isinstance(left, bool) or not isinstance(left, int) or left <= 0:
            continue
        group = _claude_reset_group(grant, scope_name)
        if group is None:
            continue
        ends_at = _normalise_reset_timestamp(grant.get("ends_at"))
        ends = datetime.fromisoformat(ends_at.replace("Z", "+00:00")) if ends_at else None
        if ends is not None and ends <= now:
            continue
        count, deadline = groups.get(group, (0, None))
        if ends is not None:
            deadline = min(deadline, ends) if deadline else ends
        groups[group] = (count + left, deadline)
    if not groups:
        return "Resets: **0** available"
    # General resets first, then model-scoped groups in the order seen.
    order = sorted(groups, key=lambda group: group != "general")
    parts = []
    for group in order:
        count, deadline = groups[group]
        part = f"**{count}** {group}"
        if deadline:
            part += f" (use within {fmt_reset(deadline.isoformat(), now)})"
        parts.append(part)
    return "Resets: " + " · ".join(parts)


def _profile_email(profile):
    account = profile.get("account") if isinstance(profile, dict) else None
    return claude_account_email({"emailAddress": account.get("email")}) if isinstance(account, dict) else None


def _request_claude_usage(base_url, oauth, fallbacks=(), email=None, client_version=None):
    """Return ``(profile, usage)`` for the first credential that is ``email``'s.

    A 401 can come from a revoked login whose ``expiresAt`` is still in the
    future, and a shared Keychain item can hold another account's login, so
    each unexpired fallback credential is tried in turn. When ``email`` is
    known, a credential whose profile belongs to another account is skipped
    rather than reported under this home's label.
    """
    rejected = None
    for index, candidate in enumerate((oauth, *fallbacks)):
        if index and _oauth_expired(candidate):
            continue
        headers = _claude_headers(candidate)
        try:
            profile = _request_json(base_url, "/api/oauth/profile", headers, "Anthropic profile")
        except PosterHTTPError as error:
            if error.status != 401 and not index:
                raise
            rejected = rejected or error
            continue
        except PosterError:
            if not index:
                raise
            continue
        if email and _profile_email(profile) != email:
            continue
        if not client_version:
            return profile, _request_json(base_url, "/api/oauth/usage", headers, "Anthropic usage")
        # One request returns usage and limit-reset grants; Anthropic includes
        # the grants only for a request identifying as Claude Code.
        return profile, _request_json(
            base_url,
            CLAUDE_RESET_GRANTS_USAGE_ENDPOINT,
            _claude_headers(candidate, client_version),
            "Anthropic usage",
        )
    if rejected:
        raise rejected
    raise ClaudeAccountMismatch("no Keychain login matches this Claude home's account")


def _claude_refresh_target(services, cache, config_dir):
    """Return how to refresh a home's login: ``(config_dir,)``, ``(None,)``, or ``None``.

    Only a Keychain item with a refresh token can be refreshed. A home's own
    hashed item is refreshed under ``CLAUDE_CONFIG_DIR``; the plain item only
    for ``~/.claude``, whose default sessions use it, as a default session.
    """
    hashed = cache.get(services[0]) if services else None
    if isinstance(hashed, dict) and hashed.get("refreshToken"):
        return (config_dir,)
    plain = cache.get(PLAIN_CLAUDE_SERVICE)
    if config_dir == Path.home() / ".claude" and isinstance(plain, dict) and plain.get("refreshToken"):
        return (None,)
    return None


def _claude_limit_entry(window, raw_percent, resets_at, scope=None):
    """Return one sanitized Claude limit; a bad percentage is unavailable, never 0%."""
    try:
        percent = float(raw_percent)
        if isinstance(raw_percent, bool) or not math.isfinite(percent):
            raise ValueError
    except (TypeError, ValueError):
        percent = None
    entry = {
        "window": f"{window} ({scope})" if scope else window,
        "used_percent": max(0.0, min(100.0, percent)) if percent is not None else None,
        "available": percent is not None,
        "status": "available" if percent is not None else "unavailable",
        "reason": None if percent is not None else "Usage percentage unavailable",
        "resets_at": _normalise_reset_timestamp(resets_at),
    }
    if scope:
        entry["scope"] = scope
    return entry


def _claude_usage_limits(usage):
    limits = usage.get("limits") if isinstance(usage, dict) else None
    return [entry for entry in limits if isinstance(entry, dict)] if isinstance(limits, list) else []


def _claude_unscoped_limits(usage):
    """Return the first unscoped ``session`` and ``weekly_all`` entries by kind."""
    found = {}
    for entry in _claude_usage_limits(usage):
        kind = entry.get("kind")
        if kind in {"session", "weekly_all"} and entry.get("scope") is None and kind not in found:
            found[kind] = entry
    return found


CLAUDE_SCOPE_NAME_PATTERN = re.compile(r"[^A-Za-z0-9 ._+-]")


def _claude_scope_name(scope):
    """Return a model-only scope's display name, or ``None`` to ignore the entry.

    A scope naming a surface (alone or with a model) is not a whole-model
    allowance, so it is never shown under the model's name.
    """
    if not isinstance(scope, dict) or scope.get("surface") is not None:
        return None
    model = scope.get("model")
    name = model.get("display_name") if isinstance(model, dict) else None
    if not isinstance(name, str):
        return None
    # The name is rendered inside Discord markdown and stored in history.
    cleaned = " ".join(CLAUDE_SCOPE_NAME_PATTERN.sub("", name).split())[:32].strip()
    return cleaned or None


def _claude_scoped_limits(usage):
    """Return one 7-day limit per model from ``weekly_scoped`` entries, first wins."""
    scoped = []
    seen = set()
    for entry in _claude_usage_limits(usage):
        if entry.get("kind") != "weekly_scoped":
            continue
        name = _claude_scope_name(entry.get("scope"))
        if not name or name.lower() in seen:
            continue
        seen.add(name.lower())
        scoped.append(_claude_limit_entry("7-day", entry.get("percent"), entry.get("resets_at"), scope=name))
    return scoped


def _collect_claude_oauth_metric(
    base_url, services, label, dir_hint, email=None, cache=None, client_version=None, refresher=None
):
    """Collect a credential-free, renderer-friendly Claude account metric.

    The returned object intentionally contains only display labels, rate-limit
    percentages, and reset timestamps.  In particular, the OAuth credential,
    transcript path, and response payload are never returned to the history
    writer.
    """
    metric = {"provider": "claude", "account": label, "limits": []}
    cache = {} if cache is None else cache
    credentials = _read_oauth_credentials(services, cache)
    refresh_attempted = False

    def refresh():
        """Refresh this home's login once per run; return whether to retry."""
        nonlocal credentials, refresh_attempted
        if refresher is None or refresh_attempted:
            return False
        refresh_attempted = True
        config_dir = Path(dir_hint).expanduser()
        target = _claude_refresh_target(services, cache, config_dir)
        if target is None or not refresher(target[0]):
            return False
        for service in services:
            cache.pop(service, None)
        credentials = _read_oauth_credentials(services, cache)
        return bool(credentials)

    if credentials and _oauth_expired(credentials[0]):
        refresh()
    problems = cache.get(CREDENTIAL_PROBLEMS, {})
    problem = next((problems[service] for service in services if problems.get(service)), None)
    if not credentials and problem:
        # Read but unusable: a refused or unparsable file, not a home with no login.
        metric["status"] = "unavailable"
        metric["reason"] = problem
        metric["text"] = f"**{label}**\n*{problem}*"
        return metric
    if not credentials:
        metric["status"] = "unavailable"
        metric["reason"] = "Could not get OAuth token"
        metric["missing_oauth"] = True
        metric["text"] = f"**{label}**\n*Could not get OAuth token*"
        return metric
    oauth = credentials[0]
    if _oauth_expired(oauth):
        metric["status"] = "unavailable"
        metric["reason"] = "OAuth token expired"
        metric["text"] = (
            f"**{label}**\n*OAuth token expired — start a session on this account to refresh*"
            if oauth.get("refreshToken")
            else _claude_relogin_block(label, dir_hint)
        )
        return metric

    try:
        try:
            profile, usage = _request_claude_usage(base_url, oauth, credentials[1:], email, client_version)
        except (ClaudeAccountMismatch, PosterHTTPError) as error:
            # A revoked access token, or an expired one hidden behind another
            # account's fresher plain item, may still have a usable refresh token.
            if isinstance(error, PosterHTTPError) and error.status != 401:
                raise
            if not refresh() or _oauth_expired(credentials[0]):
                raise
            oauth = credentials[0]
            profile, usage = _request_claude_usage(base_url, oauth, credentials[1:], email, client_version)
    except ClaudeAccountMismatch:
        metric["status"] = "unavailable"
        metric["reason"] = "No login for this account"
        metric["text"] = _claude_relogin_block(label, dir_hint)
        return metric
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
    unscoped_limits = _claude_unscoped_limits(usage)
    for key, kind, window in (("five_hour", "session", "5-hour"), ("seven_day", "weekly_all", "7-day")):
        data = usage.get(key) if isinstance(usage, dict) else None
        # The legacy field comes first; when it is absent or its percentage is
        # unusable, the newer ``limits`` array's entry for the window is used.
        sources = []
        if isinstance(data, dict):
            sources.append(_claude_limit_entry(window, data.get("utilization"), data.get("resets_at")))
        if kind in unscoped_limits:
            entry = unscoped_limits[kind]
            sources.append(_claude_limit_entry(window, entry.get("percent"), entry.get("resets_at")))
        if sources:
            metric["limits"].append(next((source for source in sources if source["available"]), sources[0]))
    metric["limits"].extend(_claude_scoped_limits(usage))
    if not metric["limits"]:
        metric["status"] = "unavailable"
        metric["reason"] = "No rate-limit data"
    lines = [f"**{label}** ({metric['plan']})"]
    scoped = any(limit.get("scope") for limit in metric["limits"])
    for limit in metric["limits"]:
        reset = fmt_reset(limit.get("resets_at"), datetime.now(timezone.utc))
        reset_part = f"  resets in {reset}" if reset else ""
        value_text = text_bar(limit["used_percent"]) if limit["available"] else "*unavailable*"
        if limit.get("scope"):
            name = f"7-Day ({limit['scope']})"
        elif limit["window"] == "5-hour":
            name = "5-Hour"
        else:
            # Name the all-models row only when a model-scoped row sits beside it.
            name = "7-Day (all)" if scoped else "7-Day"
        lines.append(f"{name}: {value_text}{reset_part}")
    extra_usage = usage.get("extra_usage", {}) if isinstance(usage, dict) else {}
    if isinstance(extra_usage, dict) and extra_usage.get("is_enabled"):
        lines.append(f"Extra usage: **${_safe_int(extra_usage.get('used_credits')) / 100:.2f}** spent")
    scoped_names = [limit["scope"] for limit in metric["limits"] if limit.get("scope")]
    reset_line = format_claude_limit_resets(
        usage.get("cedar_ember") if isinstance(usage, dict) else None,
        scope_name=scoped_names[0] if len(scoped_names) == 1 else None,
    )
    if reset_line:
        lines.append(reset_line)
    metric["text"] = "\n".join(lines)
    return metric


def collect_claude_metrics(config):
    """Return structured current Claude metrics for history and rendering."""
    metrics = []
    cache = {}
    executable = claude_code_executable()
    client_version = claude_code_client_version(executable) if executable else None
    refresher = (lambda config_dir: refresh_claude_login(executable, config_dir)) if executable else None
    for index, (services, label, dir_hint, email) in enumerate(discover_claude_accounts()):
        metric = _collect_claude_oauth_metric(
            config["anthropic_base_url"], services, label, dir_hint, email, cache, client_version, refresher
        )
        if index > 0 and metric.get("missing_oauth"):
            metric["text"] = None
        if not claude_credentials.uses_keychain() and metric.get("status") == "unavailable" and not metric.get("missing_oauth"):
            print(f"Warning: Claude limits skipped for {label}: {metric['reason']}", file=sys.stderr)
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


def _metric_from_codex_rate_limits(rate_limits, label, source="live", source_ts=None, credit_history=None, now=None):
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
    credits_used = None
    credits = _codex_credits(rate_limits)
    if source == "live" and credits and "balance" in credits:
        # Only a live balance is recorded and compared: a stale session-file
        # balance would date old spending to this slot.
        metric["credits_balance"] = credits["balance"]
        account_key = rate_limits.get("creditAccountKey")
        if isinstance(account_key, str) and CODEX_CREDIT_ACCOUNT_KEY_PATTERN.match(account_key):
            # Compare only balances from this same account: a home that
            # switched accounts, or a label that moved, starts a new series.
            metric["credits_account"] = account_key
            points = [
                (at, value)
                for at, value, key in (credit_history or {}).get(_safe_label(label, "unknown"), [])
                if key == account_key
            ]
            credits_used = _codex_credits_used(points, credits["balance"], now or datetime.now(timezone.utc))
    metric["text"] = format_codex_rate_limits(rate_limits, label, source_ts=source_ts, credits_used=credits_used)
    if source_ts:
        metric["source_ts"] = source_ts
    return metric


def _windows_file_is_private(path):
    try:
        return is_private(path)
    except (OSError, ValueError):
        return False


def _read_bounded_regular_text(path, limit, *, private=False):
    """Read a bounded regular, non-symlink file, or return ``None``.

    ``O_NONBLOCK`` is set so opening a FIFO cannot block before ``fstat`` gets
    a chance to reject it, and ``O_CLOEXEC`` keeps the descriptor out of any
    child process.  ``O_NOFOLLOW`` plus ``fstat`` on the open descriptor closes
    the symlink-swap window between check and read.  ``private`` additionally
    requires a current-owner, owner-only credential file so it cannot be group
    or world readable.
    """
    flags = os.O_RDONLY
    for name in ("O_NONBLOCK", "O_CLOEXEC", "O_NOFOLLOW", "O_BINARY"):
        flags |= getattr(os, name, 0)
    if private and WIN32 and not _windows_file_is_private(path):
        return None
    try:
        descriptor = os.open(path, flags)
    except OSError:
        return None
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode):
            return None
        if private and not WIN32:
            if info.st_mode & (stat.S_IRWXG | stat.S_IRWXO):
                return None
            get_owner = getattr(os, "geteuid", None)
            if get_owner is not None and info.st_uid != get_owner():
                return None
        if info.st_size > limit:
            return None
        chunks = []
        remaining = limit + 1
        while remaining > 0:
            chunk = os.read(descriptor, remaining)
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        data = b"".join(chunks)
    except OSError:
        return None
    finally:
        os.close(descriptor)
    if len(data) > limit:
        return None
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        return None


def is_deepseek_home(home):
    """Return True only for a home carrying the exact DeepSeek setup marker.

    The marker is the sole autodiscovery signal.  An absent or unrecognised
    marker leaves the home on the existing ordinary Codex path.
    """
    if not isinstance(home, Path):
        return False
    try:
        if not home.is_dir():
            return False
    except OSError:
        return False
    text = _read_bounded_regular_text(home / DEEPSEEK_MARKER_NAME, DEEPSEEK_MARKER_MAX_BYTES)
    if text is None:
        return False
    try:
        marker = json.loads(text)
    except (TypeError, ValueError, json.JSONDecodeError):
        return False
    return marker == DEEPSEEK_MARKER


def read_deepseek_key(home):
    """Return a validated private API key from a DeepSeek home, else ``None``.

    The key is used in-memory only for the balance request; it is never
    returned to the history writer, logs, or the rendered dashboard.
    """
    if not isinstance(home, Path):
        return None
    text = _read_bounded_regular_text(home / DEEPSEEK_KEY_NAME, DEEPSEEK_KEY_MAX_BYTES, private=True)
    if text is None:
        return None
    key = text.strip()
    if not DEEPSEEK_KEY_PATTERN.fullmatch(key):
        return None
    return key


def _deepseek_account_groups(accounts):
    """Group configured DeepSeek homes by their private key digest (memory-only)."""
    groups = []
    by_digest = {}
    for account in accounts:
        home = account.get("home")
        label = _safe_label(account.get("label"), "DeepSeek")
        if not is_deepseek_home(home):
            continue
        key = read_deepseek_key(home)
        if key is None:
            # Unreadable credentials stay distinct; never guess they match
            # another home, and never expose the reason's source path.
            groups.append({
                "label": label,
                "aliases": [label],
                "homes": [home],
                "key": None,
                "digest": None,
            })
            continue
        digest = hashlib.sha256(key.encode("utf-8")).hexdigest()
        group = by_digest.get(digest)
        if group is None:
            group = {"label": label, "aliases": [label], "homes": [home], "key": key, "digest": digest}
            by_digest[digest] = group
            groups.append(group)
            continue
        group["homes"].append(home)
        if label not in group["aliases"]:
            group["aliases"].append(label)

    for group in groups:
        aliases = sorted(group["aliases"])
        if not aliases:
            group["label"] = "DeepSeek"
        elif len(aliases) == 1:
            group["label"] = aliases[0]
        elif len(aliases) <= 3:
            group["label"] = " + ".join(aliases) + " (shared key)"
        else:
            group["label"] = f"{aliases[0]} +{len(aliases) - 1} more (shared key)"
    return groups


def _format_deepseek_amount(value):
    """Return a bounded decimal money string, or ``None`` when malformed."""
    if not isinstance(value, str) or not DEEPSEEK_AMOUNT_PATTERN.match(value.strip()):
        return None
    try:
        number = Decimal(value.strip())
    except (InvalidOperation, ValueError):
        return None
    if not number.is_finite() or number < 0:
        return None
    text = format(number, "f")
    return text if len(text) <= 40 else None


def parse_deepseek_balance(payload):
    """Return sanitized balance data or raise ``PosterError`` for malformed input.

    Every documented field is required.  ``currency`` must be one of DeepSeek's
    documented values and may appear at most once per response; a missing or
    malformed ``total_balance``, ``granted_balance``, or ``topped_up_balance``
    fails the whole response instead of degrading one field to ``None``.  The
    decimal strings are preserved exactly, so ``0.00`` never becomes ``0``.
    """
    if not isinstance(payload, dict):
        raise PosterError("DeepSeek balance response was malformed")
    is_available = payload.get("is_available")
    if not isinstance(is_available, bool):
        raise PosterError("DeepSeek balance response was malformed")
    entries = payload.get("balance_infos")
    if not isinstance(entries, list) or not entries:
        raise PosterError("DeepSeek balance response was malformed")
    sanitized = []
    seen_currencies = set()
    for entry in entries:
        if not isinstance(entry, dict):
            raise PosterError("DeepSeek balance response was malformed")
        currency = entry.get("currency")
        if not isinstance(currency, str) or currency.strip() not in DEEPSEEK_CURRENCIES:
            raise PosterError("DeepSeek balance response was malformed")
        currency = currency.strip()
        if currency in seen_currencies:
            # A duplicated currency row cannot be shown as one truthful balance.
            raise PosterError("DeepSeek balance response was malformed")
        seen_currencies.add(currency)
        total = _format_deepseek_amount(entry.get("total_balance"))
        granted = _format_deepseek_amount(entry.get("granted_balance"))
        topped_up = _format_deepseek_amount(entry.get("topped_up_balance"))
        if total is None or granted is None or topped_up is None:
            raise PosterError("DeepSeek balance response was malformed")
        sanitized.append({
            "currency": currency,
            "total": total,
            "granted": granted,
            "topped_up": topped_up,
        })
    return {"is_available": is_available, "entries": sanitized}


class _DeepSeekNoRedirect(HTTPRedirectHandler):
    """Refuse redirects so a private API key is never forwarded elsewhere."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: D102
        return None


def _deepseek_opener():
    return build_opener(_DeepSeekNoRedirect)


def _deepseek_request_origin(base_url):
    """Return the validated origin the balance request may be sent to.

    Only the fixed official DeepSeek origin and a literal loopback test origin
    accepted by ``_parse_loopback_base_url`` are allowed.  This re-checks the
    boundary at the request site, so a private API key can never be sent to an
    arbitrary remote host or to a URL with embedded credentials, and the
    redirect handler above still refuses to forward it elsewhere.  No generic
    remote override exists.
    """
    if not isinstance(base_url, str) or not base_url.strip():
        raise PosterError("DeepSeek balance endpoint was not a supported origin")
    candidate = base_url.strip().rstrip("/")
    if candidate == DEEPSEEK_DEFAULT_BASE_URL:
        return DEEPSEEK_DEFAULT_BASE_URL
    loopback = _parse_loopback_base_url(candidate, "deepseek_base_url")
    if loopback is None:
        raise PosterError("DeepSeek balance endpoint was not a supported origin")
    return loopback


def fetch_deepseek_balance(key, base_url, opener=None, timeout=10):
    """Fetch and validate the account-wide balance for one private key.

    ``base_url`` is re-validated here against the fixed official origin and the
    literal loopback test origin, so this helper can never be pointed at an
    unrelated remote host or a credentials-bearing URL.
    """
    origin = _deepseek_request_origin(base_url)
    request = Request(
        f"{origin}{DEEPSEEK_BALANCE_ENDPOINT}",
        headers={
            "Authorization": f"Bearer {key}",
            "Accept": "application/json",
            "User-Agent": "ccdm-usage-stats-poster/1.0",
        },
        method="GET",
    )
    client = opener or _deepseek_opener()
    try:
        with client.open(request, timeout=timeout) as response:
            status = getattr(response, "status", None) or response.getcode()
            if not 200 <= status < 300:
                raise PosterHTTPError("DeepSeek balance", status)
            raw = response.read(DEEPSEEK_RESPONSE_MAX_BYTES + 1)
    except HTTPError as error:
        # The response body may echo credentials; only the status is surfaced.
        raise PosterHTTPError("DeepSeek balance", error.code) from None
    except (URLError, TimeoutError, OSError):
        raise PosterError("DeepSeek balance request failed; check the endpoint and try again") from None
    if len(raw) > DEEPSEEK_RESPONSE_MAX_BYTES:
        raise PosterError("DeepSeek balance response was too large")
    try:
        payload = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError, json.JSONDecodeError):
        raise PosterError("DeepSeek balance response was malformed") from None
    return parse_deepseek_balance(payload)


_DEEPSEEK_USAGE_UNSET = object()


def load_deepseek_usage_module(path=None):
    """Import the sibling local-usage module relative to this script."""
    target = Path(path) if path is not None else DEEPSEEK_USAGE_MODULE_PATH
    try:
        if not target.is_file() or target.is_symlink():
            return None
    except OSError:
        return None
    try:
        import importlib.util
        spec = importlib.util.spec_from_file_location("ccdm_deepseek_local_usage", target)
        if spec is None or spec.loader is None:
            return None
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module
    except (ImportError, OSError, ValueError, TypeError, SystemExit):
        return None


def _sanitize_local_usage(result):
    """Reduce B's contract to bounded, path-free, JSON-safe display fields."""
    unavailable = {"status": "unavailable", "reason": "Local DeepSeek usage unavailable"}
    if not isinstance(result, dict) or result.get("status") not in {"available", "unavailable"}:
        return unavailable
    if result.get("status") == "unavailable":
        return {"status": "unavailable", "reason": _safe_label(result.get("reason"), "Local DeepSeek usage unavailable")}
    period = result.get("period")
    if not isinstance(period, str) or not re.fullmatch(r"\d{4}-\d{2}", period):
        return {"status": "unavailable", "reason": "Local DeepSeek usage data was malformed"}
    counters = {}
    for name in ("input_tokens", "cached_input_tokens", "output_tokens",
                 "reasoning_output_tokens", "total_tokens", "sessions"):
        value = result.get(name)
        if isinstance(value, bool) or not isinstance(value, int) or value < 0:
            return {"status": "unavailable", "reason": "Local DeepSeek usage data was malformed"}
        counters[name] = value
    return {
        "status": "available",
        "period": period,
        "partial": result.get("partial") is True,
        **counters,
    }


def collect_deepseek_local_usage(module, homes, now):
    """Call the agreed sibling API ``collect_month_usage(homes, now)``."""
    collector = getattr(module, "collect_month_usage", None) if module is not None else None
    if not callable(collector):
        return {"status": "unavailable", "reason": "Local DeepSeek usage collector unavailable"}
    try:
        result = collector(list(homes), now)
    except Exception:  # noqa: BLE001 - never let a collector crash the poster
        return {"status": "unavailable", "reason": "Local DeepSeek usage collection failed"}
    return _sanitize_local_usage(result)


def _money(currency, amount):
    """Format one validated money string with its display currency symbol."""
    return f"{DEEPSEEK_CURRENCY_SYMBOLS.get(currency, currency + ' ')}{amount}"


def _deepseek_used_bar(remaining, reference_amount, width=15):
    """Fill the meter with usage against the configured balance reference."""
    reference = Decimal(reference_amount)
    left = Decimal(remaining) / reference * 100 if reference > 0 else Decimal(0)
    used = max(Decimal(0), Decimal(100) - left)
    clamped = min(used, Decimal(100))
    filled = int(round(clamped / 100 * width))
    return f"`[{'#' * filled}{'.' * (width - filled)}]` **{used:.0f}% used · {left:.0f}% left**"


def _deepseek_reference_for_group(aliases, references):
    """Resolve one display budget for a DeepSeek key group without guessing.

    A shared-key group may expose several account aliases.  If exactly one
    configured reference applies, or every applying alias agrees, that budget
    is returned.  If aliases carry conflicting references the budget is omitted
    and the conflicted aliases are returned so the caller can surface a clear
    status instead of silently picking one.
    """
    if not isinstance(references, dict):
        references = {}
    matched = []
    for alias in aliases or []:
        reference = references.get(alias)
        if isinstance(reference, dict) and "currency" in reference and "amount" in reference:
            matched.append((alias, reference["currency"], reference["amount"]))
    if not matched:
        return None, None
    distinct = {}
    for alias, currency, amount in matched:
        distinct.setdefault((currency, amount), []).append(alias)
    if len(distinct) == 1:
        (currency, amount), _ = next(iter(distinct.items()))
        return {"currency": currency, "amount": amount}, None
    return None, sorted(alias for alias, _, _ in matched)


def _deepseek_display(label, balance, usage, reference=None, reference_conflict=None):
    """Return (note_lines, text_lines) for one DeepSeek key group.

    The recent convention here is the compact, Claude/Codex-style block: a
    bold balance line, the paid/granted breakdown, local monthly totals, and a
    short footer that keeps the account-vs-local distinction.  An optional
    configured reference draws the same inline text bar as the other limits;
    without one the amounts are shown plainly and no percentage is invented.
    A conflicting shared-key reference omits the bar and keeps both the real
    balance and the local usage.
    """
    text_lines = []
    if isinstance(balance, dict) and balance.get("status") == "available":
        entries = balance.get("entries", [])
        reference_line = None
        if reference and not reference_conflict:
            currency = reference["currency"]
            matching = next((e for e in entries if e.get("currency") == currency), None)
            if matching is not None:
                reference_line = (
                    f"Balance: {_deepseek_used_bar(matching['total'], reference['amount'])}"
                    f" · {_money(currency, matching['total'])} of {_money(currency, reference['amount'])} ref"
                )
        if reference_line is not None:
            text_lines.append(reference_line)
        else:
            text_lines.append(
                "Balance: " + " · ".join(f"**{_money(entry['currency'], entry['total'])}**" for entry in entries)
            )
        if len(entries) == 1:
            entry = entries[0]
            text_lines.append(
                f"Paid: {_money(entry['currency'], entry['topped_up'])} · "
                f"Granted: {_money(entry['currency'], entry['granted'])}"
            )
        else:
            text_lines.append(
                " · ".join(
                    f"{entry['currency']}: paid {_money(entry['currency'], entry['topped_up'])} · "
                    f"granted {_money(entry['currency'], entry['granted'])}"
                    for entry in entries
                )
            )
        if balance.get("is_available") is False:
            text_lines.append("*insufficient for API calls*")
    else:
        reason = _safe_label(balance.get("reason") if isinstance(balance, dict) else None, "not reported")
        text_lines.append(f"Balance: *unavailable ({reason})*")

    if reference_conflict:
        text_lines.append("Balance reference: *omitted (conflicting configured references for shared key)*")

    if isinstance(usage, dict) and usage.get("status") == "available":
        sessions = usage["sessions"]
        text_lines.append(
            f"This month: **{fmt_tokens(usage['total_tokens'])} tokens** · "
            f"{sessions} session{'s' if sessions != 1 else ''}{' · partial' if usage.get('partial') else ''}"
        )
        input_tokens = usage.get("input_tokens")
        output_tokens = usage.get("output_tokens")
        if input_tokens is not None and output_tokens is not None:
            tokens = f"in {fmt_tokens(input_tokens)} · out {fmt_tokens(output_tokens)}"
            if usage.get("cached_input_tokens"):
                tokens += f" · cached {fmt_tokens(usage['cached_input_tokens'])}"
            text_lines.append(f"Tokens: {tokens}")
    else:
        reason = _safe_label(usage.get("reason") if isinstance(usage, dict) else None, "not reported")
        text_lines.append(f"This month: *unavailable ({reason})*")

    text_lines.append(DEEPSEEK_FOOTER)
    # The retired dashboard image used a separate note; the compact text is now
    # the single source, so the note mirrors it for any remaining readers.
    return list(text_lines), list(text_lines)


def _deepseek_balance_state(key, base_url, fetcher):
    """Return the display-only balance state for one private key.

    Shared by the grouped dashboard path and the single-home legacy text path
    so both surfaces report the same real balance and the same bounded
    unavailable reasons.  Never raises to the caller.
    """
    if key is None:
        return {"status": "unavailable", "reason": "DeepSeek API key unavailable"}
    try:
        return {"status": "available", **fetcher(key, base_url)}
    except PosterHTTPError as error:
        return {"status": "unavailable", "reason": f"DeepSeek balance unavailable (HTTP {error.status})"}
    except PosterError:
        return {"status": "unavailable", "reason": "DeepSeek balance unavailable"}


def collect_deepseek_metrics(config, registry, now=None, usage_module=_DEEPSEEK_USAGE_UNSET, balance_fetcher=None):
    """Return display-only DeepSeek balance notes without quota/history cards.

    One balance request is issued per distinct private key per run; homes that
    share a key are grouped because the key proves a shared credential, while
    distinct keys stay distinct because no account identifier is available.
    """
    config = config if isinstance(config, dict) else {}
    now = now or datetime.now(timezone.utc)
    base_url = config.get("deepseek_base_url") or DEEPSEEK_DEFAULT_BASE_URL
    if usage_module is _DEEPSEEK_USAGE_UNSET:
        usage_module = load_deepseek_usage_module()
    fetcher = balance_fetcher or fetch_deepseek_balance
    references = config.get("deepseek_balance_references")
    metrics = []
    for group in _deepseek_account_groups(discover_codex_accounts(registry)):
        label = group["label"]
        usage = collect_deepseek_local_usage(usage_module, group["homes"], now)
        balance = _deepseek_balance_state(group.get("key"), base_url, fetcher)
        reference, reference_conflict = _deepseek_reference_for_group(group["aliases"], references)
        note_lines, text_lines = _deepseek_display(
            label, balance, usage, reference=reference, reference_conflict=reference_conflict
        )
        metrics.append({
            "provider": "codex",
            "account": label,
            "limits": [],
            "source": "deepseek",
            "dashboard_note": {"title": f"{label} · API", "lines": note_lines},
            "text": "\n".join([f"**{label}** (API)"] + text_lines),
            "status": "available" if balance.get("status") == "available" else "unavailable",
            "reason": None if balance.get("status") == "available" else balance.get("reason"),
            "balance": balance,
        })
    return metrics


def _deepseek_home_report(home, label, now=None, usage_module=_DEEPSEEK_USAGE_UNSET, balance_fetcher=None):
    """Return the real text report for one DeepSeek home (legacy text path).

    Uses the same display helper and balance state as the grouped dashboard
    path, so a legacy caller sees the account-wide balance, the paid/granted
    breakdown, and the local token totals instead of a placeholder note.
    """
    now = now or datetime.now(timezone.utc)
    if usage_module is _DEEPSEEK_USAGE_UNSET:
        usage_module = load_deepseek_usage_module()
    fetcher = balance_fetcher or fetch_deepseek_balance
    balance = _deepseek_balance_state(read_deepseek_key(home), DEEPSEEK_DEFAULT_BASE_URL, fetcher)
    usage = collect_deepseek_local_usage(usage_module, [home], now)
    _, text_lines = _deepseek_display(label, balance, usage)
    return "\n".join([f"**{label}** (API)"] + text_lines)


def collect_codex_metrics(
    registry, config=None, now=None, deepseek_usage=_DEEPSEEK_USAGE_UNSET, deepseek_balance=None, credit_history=None
):
    """Return structured current Codex metrics without retaining source paths.

    DeepSeek homes bypass the subscription rate-limit request: their live
    balance comes from the DeepSeek HTTP API and their local totals from the
    sibling collector, so no Codex rate-limit websocket/stdio call is made for
    them.  A DeepSeek-backed root Codex session still runs through the Codex
    app-server; only this rate-limit query is skipped.
    """
    metrics = []
    credit_now = now or _utc_now()
    for account in discover_codex_accounts(registry):
        home = account["home"]
        label = account["label"]
        if is_deepseek_home(home):
            continue
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
            metrics.append(_metric_from_codex_rate_limits(live, label, credit_history=credit_history, now=credit_now))
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
    return metrics + collect_deepseek_metrics(
        config,
        registry,
        now=now,
        usage_module=deepseek_usage,
        balance_fetcher=deepseek_balance,
    )


# Google Antigravity CLI (``agy``) subscription quota.  ``agy -p /usage`` is a
# read-only print-mode slash command: it answers from the account's quota
# summary without starting an agent turn, spending quota, or leaving a
# conversation behind.  Its JSON form carries one group per model family
# (Gemini, Claude + GPT, the separate Argon cap), each with 5-hour and/or
# weekly buckets of ``remaining_fraction`` and a UTC ``reset_time``.
AGY_BIN_ENV = "CCDM_AGY_BIN"
AGY_TIMEOUT_ENV = "CCDM_AGY_TIMEOUT_SECONDS"
AGY_DEFAULT_TIMEOUT_SECONDS = 30
AGY_OUTPUT_MAX_BYTES = 256 * 1024
AGY_PROVIDER = "antigravity"
AGY_ACCOUNT = "agy"
AGY_FIELD_NAME = "Antigravity"
AGY_MAX_GROUPS = 8
AGY_MAX_BUCKETS = 8
# window -> (history window, display label, display order)
AGY_WINDOWS = {"5h": ("5-hour", "5-Hour", 0), "weekly": ("weekly", "Weekly", 1)}
AGY_NAME_PATTERN = re.compile(r"[^A-Za-z0-9 .,+&()-]")
AGY_SIGN_IN_PATTERN = re.compile(
    r"not (?:logged|signed) in|log ?in|sign ?in|unauthenticated|authenticat|re-?auth|oauth|token (?:expired|revoked)",
    re.IGNORECASE,
)


def _agy_binary():
    """Return ``(binary, expected)`` for the Antigravity CLI.

    ``CCDM_AGY_BIN`` wins when set; otherwise ``agy`` on PATH, then the
    installer's ``~/.local/bin/agy`` (LaunchAgents do not add it to PATH).
    ``expected`` is true when agy was configured or its data directory exists,
    so a machine that never used agy shows no section at all, while a missing
    binary on a machine that did use it renders an unavailable line.
    """
    override = os.environ.get(AGY_BIN_ENV)
    if override is not None and override.strip():
        return Path(override.strip()).expanduser(), True
    found = shutil.which("agy")
    if found:
        return Path(found), True
    default = Path.home() / ".local" / "bin" / "agy"
    if default.is_file():
        return default, True
    return None, (Path.home() / ".gemini" / "antigravity-cli").is_dir()


def _agy_timeout():
    try:
        value = float(os.environ.get(AGY_TIMEOUT_ENV) or AGY_DEFAULT_TIMEOUT_SECONDS)
    except ValueError:
        value = AGY_DEFAULT_TIMEOUT_SECONDS
    if not math.isfinite(value):
        value = AGY_DEFAULT_TIMEOUT_SECONDS
    return max(1.0, min(120.0, value))


def _agy_name(value, limit=48):
    """Return a short display-safe name from agy payload text, or ``None``."""
    if not isinstance(value, str):
        return None
    cleaned = " ".join(AGY_NAME_PATTERN.sub("", value).split())[:limit].strip()
    return cleaned or None


def _read_agy_output(handle):
    handle.seek(0)
    return handle.read(AGY_OUTPUT_MAX_BYTES).decode("utf-8", "replace")


def read_agy_usage(binary, timeout=None):
    """Run ``agy -p /usage`` once and return ``(payload, None)`` or ``(None, reason)``.

    agy runs with the repository as its workspace (never the home folder),
    stdin closed, its log sent to /dev/null (no log file per run), and a
    strict wall-clock limit; on timeout its whole process group is killed.
    Output goes to temporary files so a lingering grandchild holding a pipe
    cannot stall the poster.
    """
    timeout = timeout or _agy_timeout()
    print_timeout = max(1, int(timeout) - 5)
    args = [
        str(binary), "-p", "/usage", "--output-format", "json",
        "--print-timeout", f"{print_timeout}s", "--log-file", os.devnull,
    ]
    env = {**os.environ, "NO_COLOR": "1"}
    try:
        with tempfile.TemporaryFile() as stdout, tempfile.TemporaryFile() as stderr:
            try:
                process = subprocess.Popen(
                    args, cwd=ROOT_DIR, stdin=subprocess.DEVNULL, stdout=stdout, stderr=stderr,
                    env=env, start_new_session=True,
                )
            except FileNotFoundError:
                return None, "agy not found"
            except OSError:
                return None, "agy could not be started"
            try:
                code = process.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                with contextlib.suppress(OSError):
                    os.killpg(process.pid, signal.SIGKILL)
                with contextlib.suppress(subprocess.TimeoutExpired, OSError):
                    process.wait(timeout=5)
                return None, "timed out"
            out_text = _read_agy_output(stdout)
            err_text = _read_agy_output(stderr)
    except OSError:
        return None, "agy output unreadable"
    if code == 3:
        return None, "timed out"
    payload = None
    with contextlib.suppress(ValueError):
        payload = json.loads(out_text)
    detail = err_text
    if isinstance(payload, dict):
        detail = " ".join(str(payload.get(key) or "") for key in ("status", "error", "response")) + " " + err_text
    if code != 0 or not isinstance(payload, dict) or payload.get("status") not in (None, "SUCCESS"):
        if AGY_SIGN_IN_PATTERN.search(detail):
            return None, "sign-in required (run agy to sign in)"
        if code != 0:
            return None, f"agy exited with code {code}"
        return None, "unreadable agy output"
    return payload, None


def parse_agy_usage(payload):
    """Return sanitized quota groups from ``agy -p /usage --output-format json``.

    Each group is ``{"name", "limits"}``; a bucket's used percentage is
    ``100 * (1 - remaining_fraction)``, and a bad fraction is unavailable,
    never 0%.  Returns ``None`` when no group has a usable bucket.
    """
    command = payload.get("command") if isinstance(payload, dict) else None
    data = command.get("data") if isinstance(command, dict) and command.get("name") == "usage" else None
    groups = data.get("groups") if isinstance(data, dict) else None
    if not isinstance(groups, list):
        return None
    result = []
    for group in groups[:AGY_MAX_GROUPS]:
        if not isinstance(group, dict) or not isinstance(group.get("buckets"), list):
            continue
        limits = []
        for bucket in group["buckets"][:AGY_MAX_BUCKETS]:
            if not isinstance(bucket, dict):
                continue
            known = AGY_WINDOWS.get(bucket.get("window"))
            if known:
                window, label, order = known
            else:
                label = _agy_name(bucket.get("name"), 32) or "Limit"
                window, order = label.lower(), 2
            remaining = bucket.get("remaining_fraction")
            used = None
            if not isinstance(remaining, bool) and isinstance(remaining, (int, float)) and math.isfinite(remaining):
                used = round(100.0 * (1.0 - max(0.0, min(1.0, float(remaining)))), 4)
            limits.append({
                "label": label, "order": order, "window": window, "used_percent": used,
                "resets_at": _normalise_reset_timestamp(bucket.get("reset_time")),
            })
        if limits:
            limits.sort(key=lambda limit: limit["order"])
            result.append({"name": _agy_name(group.get("name")) or "Models", "limits": limits})
    return result or None


def _agy_unavailable_metric(reason):
    return {
        "provider": AGY_PROVIDER, "account": AGY_ACCOUNT, "limits": [],
        "status": "unavailable", "reason": reason,
        "text": f"**{AGY_ACCOUNT}**\n*Usage unavailable: {reason}*",
    }


_AGY_UNSET = object()


def collect_agy_metrics(now=None, binary=_AGY_UNSET):
    """Return Antigravity quota metrics, one per model group; never raises.

    A machine without agy (no binary, no data directory, no override) yields
    no metrics, so the report has no Antigravity field.  Every failure after
    that is one short unavailable block.
    """
    now = now or _utc_now()
    if binary is _AGY_UNSET:
        binary, expected = _agy_binary()
        if binary is None:
            return [_agy_unavailable_metric("agy not found")] if expected else []
    try:
        payload, reason = read_agy_usage(binary)
        groups = parse_agy_usage(payload) if reason is None else None
    except Exception:  # noqa: BLE001 - agy must never break the rest of the report
        payload, reason, groups = None, "agy check failed", None
    if reason is None and groups is None:
        reason = "no quota data in agy output"
    if reason is not None:
        return [_agy_unavailable_metric(reason)]
    metrics = []
    for group in groups:
        lines = [f"**{group['name']}**"]
        limits = []
        for limit in group["limits"]:
            used = limit["used_percent"]
            # An untouched bucket's reset_time is just now + its window (the
            # window has not started), so like Claude's null reset it is hidden.
            reset = fmt_reset(limit["resets_at"], now) if used else None
            reset_part = f"  resets in {reset}" if reset else ""
            lines.append(f"{limit['label']}: {text_bar(used) if used is not None else '*unavailable*'}{reset_part}")
            limits.append({
                "window": f"{limit['window']} ({group['name']})",
                "scope": group["name"],
                "available": used is not None,
                "status": "available" if used is not None else "unavailable",
                "reason": None if used is not None else "Usage percentage unavailable",
                "used_percent": used,
                "resets_at": limit["resets_at"],
            })
        metrics.append({
            "provider": AGY_PROVIDER, "account": AGY_ACCOUNT, "group": group["name"],
            "limits": limits, "text": "\n".join(lines),
        })
    return metrics


def _agy_report_values(agy_metrics):
    """Return the Antigravity field values, or ``None`` when there is no section."""
    blocks = [metric["text"] for metric in agy_metrics or [] if isinstance(metric.get("text"), str) and metric["text"]]
    return _pack_field_values(blocks) or None


# Discord embed limits: a field value, the field count, and the whole embed.
DISCORD_FIELD_VALUE_LIMIT = 1024
DISCORD_EMBED_FIELD_LIMIT = 25
DISCORD_EMBED_TOTAL_LIMIT = 6000
TRUNCATED_MARK = "\n*truncated*"


def _truncate_block(block, limit):
    """Cut one block to ``limit`` characters at a line boundary, marked truncated."""
    if len(block) <= limit:
        return block
    room = limit - len(TRUNCATED_MARK)
    kept = ""
    for line in block.split("\n"):
        candidate = f"{kept}\n{line}" if kept else line
        if len(candidate) > room:
            break
        kept = candidate
    # A first line longer than the whole field is cut where it must be.
    return (kept or block[:room]).rstrip() + TRUNCATED_MARK


def _pack_field_values(blocks):
    """Pack account blocks into field values of at most 1024 characters.

    Blocks are never split across fields; only a block longer than a whole
    field on its own is truncated.
    """
    values = []
    for block in blocks:
        block = _truncate_block(block, DISCORD_FIELD_VALUE_LIMIT)
        if values and len(values[-1]) + 2 + len(block) <= DISCORD_FIELD_VALUE_LIMIT:
            values[-1] = f"{values[-1]}\n\n{block}"
        else:
            values.append(block)
    return values


def _usage_report_values(claude_metrics, codex_metrics):
    """Build the bounded text field values used by manual and scheduled reports.

    Returns ``(claude_values, codex_values)``: lists of field values, one field
    per list item, with ``codex_values`` ``None`` when there is no Codex text.
    """
    def blocks(metrics):
        return [metric["text"] for metric in metrics if isinstance(metric.get("text"), str) and metric["text"]]

    return _pack_field_values(blocks(claude_metrics)) or [""], _pack_field_values(blocks(codex_metrics)) or None


def _usage_report_embed(claude_value, codex_value=None, agy_value=None):
    """Return the original text-only Usage Report embed.

    Each value may be one string or a list of field values; a provider's
    second and later fields are named ``<provider> (cont.)``. Over Discord's
    field-count or total-length limit, the provider with the most fields loses
    its last field, and its new last field is marked truncated, until the
    embed fits; each provider keeps at least its first field.
    """
    timestamp = datetime.now().strftime("%b %d, %H:%M")
    embed = {
        "title": "Usage Report",
        "color": 0x5865F2,
        "fields": [],
        "footer": {"text": timestamp},
    }
    providers = []
    for name, values in (("Claude Code", claude_value), ("Codex", codex_value), (AGY_FIELD_NAME, agy_value)):
        if values is not None:
            providers.append([
                {"name": name if index == 0 else f"{name} (cont.)", "value": value, "inline": True}
                for index, value in enumerate([values] if isinstance(values, str) else values)
            ])

    def over_limit():
        fields = [field for provider in providers for field in provider]
        size = len(embed["title"]) + len(timestamp) + sum(len(f["name"]) + len(f["value"]) for f in fields)
        return len(fields) > DISCORD_EMBED_FIELD_LIMIT or size > DISCORD_EMBED_TOTAL_LIMIT

    while over_limit():
        provider = max(providers, key=len)
        if len(provider) < 2:
            break
        provider.pop()
        last = provider[-1]
        if not last["value"].endswith(TRUNCATED_MARK):
            last["value"] = _truncate_block(last["value"] + TRUNCATED_MARK, DISCORD_FIELD_VALUE_LIMIT)
    embed["fields"] = [field for provider in providers for field in provider]
    return embed


def post_to_discord(config, bot_token, claude_value, codex_value=None, agy_value=None):
    """Post the existing text-only Usage Report and return the Discord message id."""
    embed = _usage_report_embed(claude_value, codex_value, agy_value)
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
    # urllib wraps connect/send failures in URLError, so Discord never saw a
    # complete request and a retry cannot duplicate the post.  Failures while
    # waiting for or reading the reply are ambiguous: Discord may already have
    # created the message.
    try:
        response = urlopen(request, timeout=10)
    except HTTPError as error:
        raise PosterError(f"Discord post failed (HTTP {error.code})") from None
    except URLError:
        raise PosterError("Discord post failed; check the endpoint and try again") from None
    except (OSError, http.client.HTTPException):
        raise AmbiguousPostError("Discord post reply was lost; the report may have been posted") from None
    with response:
        if not 200 <= response.status < 300:
            raise PosterError(f"Discord post failed (HTTP {response.status})")
        try:
            result = json.loads(response.read().decode("utf-8"))
        except (OSError, http.client.HTTPException, UnicodeDecodeError, json.JSONDecodeError):
            # A 2xx status means the message was created; only its id is unknown.
            result = None
    message_id = result.get("id", "unknown") if isinstance(result, dict) else "unknown"
    return message_id


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


def _deepseek_history_card(metric):
    """The balance card a Windows snapshot keeps for a later merged view.

    The Mac leaves DeepSeek out of history (its note is display-only); Windows
    only collects, so without this card its balance would never be recorded.
    """
    balance = metric.get("balance") if isinstance(metric.get("balance"), dict) else {}
    available = balance.get("status") == "available"
    card = {
        "provider": "deepseek",
        "account": _safe_label(metric.get("account"), "unknown"),
        "window": "balance",
        "available": available,
        "status": "available" if available else "unavailable",
    }
    if available:
        card["is_available"] = balance.get("is_available") is True
        card["balances"] = [dict(entry) for entry in balance.get("entries", []) if isinstance(entry, dict)]
    else:
        card["reason"] = _safe_label(metric.get("reason"), "DeepSeek balance unavailable")[:200]
    return card


def _safe_history_cards(metrics):
    cards = []
    for metric in metrics:
        if not isinstance(metric, dict):
            continue
        if COLLECT_ONLY_PLATFORM and metric.get("source") == "deepseek":
            cards.append(_deepseek_history_card(metric))
            continue
        provider = _safe_label(metric.get("provider"), "usage").lower()
        account = _safe_label(metric.get("account"), "unknown")
        limits = metric.get("limits")
        if not isinstance(limits, list):
            limits = []
        first_card = len(cards)
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
            # A model-scoped limit (Claude's 7-day Fable allowance) already has
            # its own window, e.g. "7-day (Fable)", so it is a separate series
            # and never mixes into the all-models "7-day" one.
            if isinstance(limit.get("scope"), str) and limit["scope"].strip():
                card["scope"] = _safe_label(limit["scope"], "")[:32]
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
        # A Codex credit balance is a plain number (no credential or payload),
        # kept once per account on its first card for used-credit history.
        balance = _history_credit_balance(metric.get("credits_balance"))
        if provider == "codex" and balance is not None and len(cards) > first_card:
            cards[first_card]["credits_balance"] = round(balance, 4)
            key = metric.get("credits_account")
            if isinstance(key, str) and CODEX_CREDIT_ACCOUNT_KEY_PATTERN.match(key):
                cards[first_card]["credits_account"] = key
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
                if not is_private(self.history_dir):
                    hint = fix_hint(self.history_dir, "mode 0700 or stricter")
                    raise PosterError(f"usage history directory must be private ({hint})")
            else:
                self.history_dir.parent.mkdir(parents=True, exist_ok=True)
                try:
                    os.mkdir(self.history_dir, 0o700)
                except FileExistsError:
                    pass
                directory_info = _lstat(self.history_dir)
                if stat.S_ISLNK(directory_info.st_mode) or not stat.S_ISDIR(directory_info.st_mode):
                    raise PosterError("usage history directory must be a real directory")
                ensure_private_dir(self.history_dir)

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
                if sys.platform != "win32":
                    os.fchmod(fd, 0o600)
                if not stat.S_ISREG(os.fstat(fd).st_mode):
                    raise PosterError("usage history lock must be a regular file")
            except OSError as error:
                raise PosterError(f"unable to open usage history lock: {error}") from None
            try:
                try:
                    filelock.lock(fd)
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
                        filelock.unlock(fd)
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


def _codex_credit_history(config, now):
    """Read the credit balances that the used-credit windows can need."""
    longest = max(length for _, length in CODEX_CREDIT_USAGE_WINDOWS)
    return read_codex_credit_history(config["history_db_path"], now - longest - CODEX_CREDIT_BASELINE_MAX_AGE)


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
        help="run the LaunchAgent behavior: post the text Usage Report once per UTC 30-minute slot",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="collect and print the Usage Report to stdout without posting, reading the bot token, or writing history",
    )
    parser.add_argument(
        "--post-now",
        action="store_true",
        help="alias for --scheduled, kept for compatibility (the posts ledger still allows one post per slot)",
    )
    return parser


def main(argv=None):
    args = build_parser().parse_args(argv)
    if COLLECT_ONLY_PLATFORM and not (args.collect_only or args.validate_config):
        print(COLLECT_ONLY_MESSAGE, file=sys.stderr)
        return 2
    try:
        config = load_config(args.config)
        if args.validate_config:
            print("Poster configuration is valid")
            return 0
        if args.dry_run:
            # Collection only: no bot token, no post, and history is only
            # read (best effort) for used credits, exactly like a manual post.
            registry, _ = load_registry_data(REGISTRY_PATH, require_token=False)
            claude_metrics = collect_claude_metrics(config)
            codex_metrics = collect_codex_metrics(
                registry, config, credit_history=_codex_credit_history(config, _utc_now())
            )
            claude_value, codex_value = _usage_report_values(claude_metrics, codex_metrics)
            embed = _usage_report_embed(claude_value, codex_value, _agy_report_values(collect_agy_metrics()))
            print("\n\n".join(f"## {field['name']}\n{field['value']}" for field in embed["fields"]))
            print("\n(dry run: nothing was posted or recorded)")
            return 0
        # Windows never posts, so it never reads root's bot token.
        registry, bot_token = load_registry_data(REGISTRY_PATH, require_token=not COLLECT_ONLY_PLATFORM)
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
            # History is only read (best effort) for used credits; it is never
            # created, locked, or written here.
            codex_metrics = collect_codex_metrics(
                registry, config, credit_history=_codex_credit_history(config, _utc_now())
            )
            claude_value, codex_value = _usage_report_values(claude_metrics, codex_metrics)
            agy_value = _agy_report_values(collect_agy_metrics())
            message_id = post_to_discord(config, bot_token, claude_value, codex_value, agy_value)
            print(f"Posted (message ID: {message_id})")
            return 0

        now = _utc_now()
        claude_metrics = collect_claude_metrics(config)
        codex_metrics = collect_codex_metrics(
            registry, config, now=now, credit_history=_codex_credit_history(config, now)
        )
        agy_metrics = collect_agy_metrics(now=now)
        metrics = claude_metrics + codex_metrics + agy_metrics
        claude_value, codex_value = _usage_report_values(claude_metrics, codex_metrics)
        agy_value = _agy_report_values(agy_metrics)
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
                # Any run inside the 30-minute slot may post until the ledger
                # records it, so a skipped (sleep) or failed run is retried by
                # the next 10-minute run instead of losing the whole slot.
                post_slot = _floor_utc(now, 30)
                if store.has_post(connection, post_slot):
                    print(f"Usage report already posted for UTC slot: {_iso_utc(post_slot)}")
                    return 0
                # The scheduled workflow posts the existing text embed only:
                # no trend PNGs are rendered and no multipart attachment is
                # produced.  The retired renderer/upload helpers stay defined
                # for API back-compat but are never invoked here.
                try:
                    message_id = post_to_discord(config, bot_token, claude_value, codex_value, agy_value)
                except AmbiguousPostError:
                    # Prefer a possibly missed slot over a duplicate report:
                    # later runs in this slot must not post again.
                    store.record_post(connection, post_slot, "uncertain", now)
                    raise
                store.record_post(connection, post_slot, message_id, now)
                print(f"Posted usage report (message ID: {message_id}; UTC slot: {_iso_utc(post_slot)})")
                return 0

        return 0
    except PosterError as error:
        print(f"Error: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
