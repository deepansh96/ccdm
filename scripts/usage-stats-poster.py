#!/usr/bin/env python3
"""Post configured Claude usage statistics to one Discord channel."""

import argparse
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen


SCRIPT_DIR = Path(__file__).resolve().parent
ROOT_DIR = SCRIPT_DIR.parent
DEFAULT_CONFIG_PATH = ROOT_DIR / ".usage-stats-poster.json"
REGISTRY_PATH = ROOT_DIR / "registry.json"
CLAUDE_PRICES = {
    "claude-haiku-4-5": (1.0, 5.0),
    "claude-sonnet-4-6": (3.0, 15.0),
    "claude-opus-4-6": (15.0, 75.0),
    "claude-opus-4-7": (5.0, 25.0),
}


class PosterError(Exception):
    """An actionable, safe-to-display poster error."""


def fmt_reset(reset_str, now):
    if not reset_str:
        return None
    try:
        reset = datetime.fromisoformat(str(reset_str).replace("Z", "+00:00"))
        total_minutes = int((reset - now).total_seconds() / 60)
    except (TypeError, ValueError):
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


def get_claude_api_stats(config_dir, label, now=None):
    """Estimate the current month's API usage from local Claude transcripts."""
    now = now or datetime.now(timezone.utc).astimezone()
    records = {}
    projects_dir = config_dir / "projects"
    if not projects_dir.is_dir():
        return f"**{label}** (API key)\n*No local usage this month*"

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
        return f"**{label}** (API key)\n*Unable to read local usage*"

    month = [record for record in records.values() if (record[0].year, record[0].month) == (now.year, now.month)]
    if not month:
        return f"**{label}** (API key)\n*No local usage this month*"

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
    return "\n".join([
        f"**{label}** (API key, local estimate)",
        f"Today: **${today_cost:.4f}** · {today_requests}",
        f"This month: **${month_cost:.4f}** · {month_requests}",
        f"Tokens: {fmt_tokens(totals['input_tokens'])} in · {fmt_tokens(totals['output_tokens'])} out",
        f"Cache: {fmt_tokens(totals['cache_read_input_tokens'])} read · {fmt_tokens(totals['cache_creation_input_tokens'])} write",
        f"Models: {model_text}",
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
        oauth = credential["claudeAiOauth"]
        if not isinstance(oauth.get("accessToken"), str) or not oauth["accessToken"]:
            return None
        return oauth
    except (KeyError, TypeError, ValueError, json.JSONDecodeError):
        return None


def _request_json(base_url, endpoint, headers, label):
    request = Request(
        f"{base_url.rstrip('/')}{endpoint}",
        headers=headers,
        method="GET",
    )
    try:
        with urlopen(request, timeout=10) as response:
            if not 200 <= response.status < 300:
                raise PosterError(f"{label} request failed (HTTP {response.status})")
            return json.loads(response.read().decode("utf-8"))
    except HTTPError as error:
        raise PosterError(f"{label} request failed (HTTP {error.code})") from None
    except (URLError, TimeoutError, OSError, UnicodeDecodeError, json.JSONDecodeError):
        raise PosterError(f"{label} request failed; check the endpoint and try again") from None


def get_claude_oauth_stats(base_url):
    oauth = _read_oauth_credential("Claude Code-credentials")
    if not oauth:
        return "**Personal**\n*Could not get OAuth token*"

    expires_at = oauth.get("expiresAt")
    if expires_at:
        try:
            if float(expires_at) / 1000 < datetime.now(timezone.utc).timestamp():
                if oauth.get("refreshToken"):
                    return "**Personal**\n*OAuth token expired — start a session on this account to refresh*"
                return "**Personal**\n*Needs re-login before usage can be fetched*"
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
    except PosterError:
        return "**Personal**\n*Anthropic usage is temporarily unavailable*"

    organization = profile.get("organization", {}) if isinstance(profile, dict) else {}
    plan = str(organization.get("organization_type", "N/A")).replace("_", " ").title()
    now = datetime.now(timezone.utc)
    lines = [f"**Personal** ({plan})"]
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

    return {
        "discord_channel_id": channel_id,
        "anthropic_base_url": _parse_url(anthropic_base_url, "anthropic_base_url")
        or "https://api.anthropic.com",
        "discord_base_url": _parse_url(discord_base_url, "discord_base_url")
        or "https://discord.com",
        "claude_api_accounts": normalized_accounts,
    }


def load_config(path):
    try:
        raw = json.loads(path.read_text())
    except FileNotFoundError:
        raise PosterError(f"poster config not found: {path.name}") from None
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        raise PosterError(f"unable to read valid JSON from {path.name}") from None
    return parse_config(raw)


def load_registry(path):
    try:
        registry = json.loads(path.read_text())
    except FileNotFoundError:
        raise PosterError("registry.json not found next to the repository") from None
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        raise PosterError("unable to read valid registry.json") from None
    if not isinstance(registry, dict) or not isinstance(registry.get("pool"), list):
        raise PosterError("registry.json has no valid bot pool")
    root_bot_id = registry.get("root_bot_id") or "bot1"
    bot = next((entry for entry in registry["pool"] if isinstance(entry, dict) and entry.get("id") == root_bot_id), None)
    if not isinstance(bot, dict) or not isinstance(bot.get("token"), str) or not bot["token"]:
        raise PosterError("registry.json has no token for the configured root bot")
    return bot["token"]


def get_claude_stats(config):
    blocks = [get_claude_oauth_stats(config["anthropic_base_url"])]
    for account in config["claude_api_accounts"]:
        if account["path"].is_dir():
            blocks.append(get_claude_api_stats(account["path"], account["label"]))
        else:
            blocks.append(f"**{account['label']}** (API key)\n*Config directory unavailable*")
    value = "\n\n".join(blocks)
    if len(value) > 1024:
        value = value[:1000].rstrip() + "\n*truncated*"
    return value


def post_to_discord(config, bot_token, claude_value):
    timestamp = datetime.now().strftime("%b %d, %H:%M")
    embed = {
        "title": "Usage Report",
        "color": 0x5865F2,
        "fields": [{"name": "Claude Code", "value": claude_value, "inline": True}],
        "footer": {"text": timestamp},
    }
    request = Request(
        f"{config['discord_base_url'].rstrip('/')}/api/v10/channels/{config['discord_channel_id']}/messages",
        data=json.dumps({"embeds": [embed]}).encode("utf-8"),
        headers={
            "Authorization": f"Bot {bot_token}",
            "Content-Type": "application/json",
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


def build_parser():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG_PATH, help="poster config JSON path")
    parser.add_argument(
        "--validate-config",
        action="store_true",
        help="parse the config and exit without reading registry credentials or contacting services",
    )
    return parser


def main(argv=None):
    args = build_parser().parse_args(argv)
    try:
        config = load_config(args.config)
        if args.validate_config:
            print("Poster configuration is valid")
            return 0
        bot_token = load_registry(REGISTRY_PATH)
        post_to_discord(config, bot_token, get_claude_stats(config))
        return 0
    except PosterError as error:
        print(f"Error: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
