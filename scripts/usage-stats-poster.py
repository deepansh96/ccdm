#!/usr/bin/env python3
"""Post configured Claude usage statistics to one Discord channel."""

import argparse
import json
import os
import select
import subprocess
import sys
import time
from datetime import datetime, timedelta, timezone
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

    organization = profile.get("organization") if isinstance(profile, dict) else None
    organization_type = organization.get("organization_type") if isinstance(organization, dict) else None
    if isinstance(organization_type, str) and organization_type.strip():
        plan = organization_type.strip().replace("_", " ").title()
    else:
        plan = "N/A"
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


def load_registry_data(path):
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
    return registry, bot["token"]


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


def discover_codex_accounts(registry):
    """Return configured Codex Account labels and resolved Codex Homes."""
    named_accounts = registry.get("codex_accounts") if isinstance(registry, dict) else None
    if isinstance(named_accounts, dict):
        default_alias = registry.get("default_codex_account")
        default_is_configured = isinstance(default_alias, str) and default_alias in named_accounts
        aliases = [alias for alias in named_accounts if isinstance(alias, str) and alias.strip()]
        ordered_aliases = []
        if default_is_configured:
            ordered_aliases.append(default_alias)
        ordered_aliases.extend(sorted(alias for alias in aliases if alias != default_alias))
        return _group_codex_accounts(
            [(alias, named_accounts[alias]) for alias in ordered_aliases],
            default_alias if default_is_configured else None,
        )

    raw_homes = []
    if isinstance(registry.get("codex_home"), str):
        raw_homes.append(registry["codex_home"])
    projects = registry.get("projects", {})
    if isinstance(projects, dict):
        for project_name in sorted(projects):
            project = projects[project_name]
            if isinstance(project, dict) and isinstance(project.get("codex_home"), str):
                raw_homes.append(project["codex_home"])
    entries = [("Legacy Codex Home" if index == 0 else f"Legacy Codex Home {index + 1}", home)
               for index, home in enumerate(raw_homes)]
    accounts = _group_codex_accounts(entries)
    for index, account in enumerate(accounts):
        account["label"] = "Legacy Codex Home" if index == 0 else f"Legacy Codex Home {index + 1}"
    return accounts


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


def format_codex_rate_limits(rate_limits, label):
    plan = _format_plan(rate_limits.get("planType", rate_limits.get("plan_type")))
    lines = [f"**{label}** ({plan})"]
    for key, window_label in (("primary", "5-Hour"), ("secondary", "7-Day")):
        data = rate_limits.get(key)
        if not isinstance(data, dict):
            continue
        duration = data.get("windowDurationMins", data.get("window_duration_mins"))
        if duration == 300:
            window_label = "5-Hour"
        elif duration == 10080:
            window_label = "7-Day"
        used_percent = data.get("usedPercent", data.get("used_percent", 0)) or 0
        reset = _format_rate_limit_reset(data.get("resetsAt", data.get("resets_at")))
        reset_part = f"  resets in {reset}" if reset else ""
        lines.append(f"{window_label}: {text_bar(used_percent)}{reset_part}")
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

    stdout_buffer = bytearray()
    try:
        stdout_fd = process.stdout.fileno()
        os.set_blocking(stdout_fd, False)
    except (AttributeError, OSError, ValueError):
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
        return rate_limits
    except (OSError, TypeError, ValueError, json.JSONDecodeError):
        return None
    finally:
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


def _latest_codex_session_data(codex_home):
    sessions_dir = codex_home / "sessions" if codex_home is not None else None
    if sessions_dir is None or not sessions_dir.is_dir():
        return None
    cutoff = time.time() - timedelta(days=7).total_seconds()
    latest = None
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
                rate_limits = payload.get("rate_limits") if isinstance(payload.get("rate_limits"), dict) else None
                if not last_usage and not total_usage and not rate_limits:
                    continue
                timestamp = record.get("timestamp")
                sort_key = (str(timestamp) if isinstance(timestamp, str) else "", modified)
                if latest is None or sort_key >= latest[0]:
                    latest = (sort_key, rate_limits, last_usage, total_usage)
            except (AttributeError, TypeError, ValueError, json.JSONDecodeError):
                continue
    return latest[1:] if latest is not None else None


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
    rate_limits, last_usage, total_usage = session_data
    if isinstance(rate_limits, dict):
        return format_codex_rate_limits(rate_limits, label)
    lines = [f"**{label}** (Codex)", "*Live rate limits unavailable*"]
    if last_usage:
        lines.append(f"Last turn: **{fmt_tokens(last_usage.get('total_tokens'))}** tokens")
    if total_usage:
        lines.append(f"Session total: **{fmt_tokens(total_usage.get('total_tokens'))}** tokens")
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
    for account in config["claude_api_accounts"]:
        if account["path"].is_dir():
            blocks.append(get_claude_api_stats(account["path"], account["label"]))
        else:
            blocks.append(f"**{account['label']}** (API key)\n*Config directory unavailable*")
    value = "\n\n".join(blocks)
    if len(value) > 1024:
        value = value[:1000].rstrip() + "\n*truncated*"
    return value


def post_to_discord(config, bot_token, claude_value, codex_value=None):
    timestamp = datetime.now().strftime("%b %d, %H:%M")
    embed = {
        "title": "Usage Report",
        "color": 0x5865F2,
        "fields": [{"name": "Claude Code", "value": claude_value, "inline": True}],
        "footer": {"text": timestamp},
    }
    if codex_value is not None:
        embed["fields"].append({"name": "Codex", "value": codex_value, "inline": True})
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
        registry, bot_token = load_registry_data(REGISTRY_PATH)
        post_to_discord(config, bot_token, get_claude_stats(config), get_codex_stats(registry))
        return 0
    except PosterError as error:
        print(f"Error: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
