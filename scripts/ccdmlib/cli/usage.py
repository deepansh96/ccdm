"""`ccdm usage`: the on-demand Claude usage report, the same one `scripts/claude-usage.sh` prints.

Live sections (account profile, usage limits, additional Claude accounts) come
from ``api.anthropic.com/api/oauth/{profile,usage}``. Local sections (lifetime
totals to streaks) come from ``stats-cache.json``, ``history.jsonl`` and
``sessions/`` under ``~/.claude``, found with ``Path.home()``.

The OAuth login is read through ``ccdmlib.platform.credentials`` and never
written or refreshed. The token travels in the ``Authorization`` header only: it
is never an argument of a child process, and no redirect is followed with it.
When there is no usable login, or the API rejects it, the live sections print a
warning and the local sections still print. The command always exits 0.

The sections, their order and their wording follow the shell script line for
line; ``tests/e2e/ccdm-usage.test.js`` compares the two on the same fixture
home. ``CCDM_ANTHROPIC_BASE_URL`` points the live calls at a local fake and is
accepted only as a loopback ``http://`` address.
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import subprocess
import sys
import time
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional
from urllib.error import HTTPError
from urllib.parse import urlparse
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

from ..platform import credentials, exe

API_BASE_URL = "https://api.anthropic.com"
BASE_URL_VARIABLE = "CCDM_ANTHROPIC_BASE_URL"
OAUTH_BETA = "oauth-2025-04-20"
# The script's fixed client name for the additional accounts.
EXTRA_ACCOUNT_USER_AGENT = "claude-code/2.0.32"
REQUEST_TIMEOUT_SECONDS = 20
EXTRA_ACCOUNT_TIMEOUT_SECONDS = 10
VERSION_TIMEOUT_SECONDS = 10
MAX_RESPONSE_BYTES = 4 * 1024 * 1024
_LOOPBACK_HOSTS = ("127.0.0.1", "localhost", "::1")

BOLD = "\033[1m"
CYAN = "\033[0;36m"
GREEN = "\033[0;32m"
YELLOW = "\033[0;33m"
RED = "\033[0;31m"
DIM = "\033[2m"
RESET = "\033[0m"
RULE = "─"

WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
LIMIT_WINDOWS = [
    ("five_hour", "5-Hour Session:"),
    ("seven_day", "7-Day (All):"),
    ("seven_day_opus", "7-Day (Opus):"),
    ("seven_day_sonnet", "7-Day (Sonnet):"),
    ("seven_day_cowork", "7-Day (Cowork):"),
]
EXTRA_ACCOUNT_WINDOWS = [
    ("five_hour", "5-Hour Session"),
    ("seven_day", "7-Day (All)"),
    ("seven_day_opus", "7-Day (Opus)"),
    ("seven_day_sonnet", "7-Day (Sonnet)"),
]


def out(line: str = "") -> None:
    sys.stdout.write(line + "\n")


def _note(message: str) -> None:
    print(f"ccdm usage: {message}", file=sys.stderr, flush=True)


def divider() -> None:
    out(f"{DIM}{RULE * 60}{RESET}")


def header(title: str) -> None:
    out()
    out(f"{BOLD}{CYAN}{title}{RESET}")
    divider()


def _section(name: str, body: Callable[[], None], detail: bool = True) -> None:
    """Run one part of the report. A failure ends that part only, as in the script,
    where each part is its own process; the lines it had printed stay."""
    try:
        body()
    except Exception as error:  # pylint: disable=broad-except
        reason = f"{type(error).__name__}: {error}" if detail else type(error).__name__
        _note(f"{name} stopped early ({reason})")


# ---- live data ----


class _NoRedirect(HTTPRedirectHandler):
    """A redirect would carry the Authorization header to another address."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # type: ignore[no-untyped-def]
        return None


def _api_base_url() -> Optional[str]:
    """Where the live calls go; None when the override is set but not a loopback address."""
    override = os.environ.get(BASE_URL_VARIABLE)
    if not override:
        return API_BASE_URL
    value = override.strip().rstrip("/")
    try:
        parsed = urlparse(value)
        loopback = (
            parsed.scheme == "http"
            and parsed.hostname in _LOOPBACK_HOSTS
            and parsed.username is None
            and parsed.password is None
            and parsed.path == ""
            and not parsed.query
            and not parsed.fragment
        )
        parsed.port  # pylint: disable=pointless-statement
    except ValueError:
        loopback = False
    if not loopback:
        _note(f"{BASE_URL_VARIABLE} must be a loopback http:// address; live data is skipped")
        return None
    return value


def _opener(base_url: str):  # type: ignore[no-untyped-def]
    handlers: List[Any] = [_NoRedirect()]
    if base_url != API_BASE_URL:
        handlers.append(ProxyHandler({}))  # a local fake is never reached through a proxy
    return build_opener(*handlers)


def _request(base_url: str, endpoint: str, token: str, user_agent: str) -> Request:
    return Request(
        f"{base_url}/api/oauth/{endpoint}",
        headers={
            "Authorization": "Bearer " + token,
            "anthropic-beta": OAUTH_BETA,
            "User-Agent": user_agent,
        },
        method="GET",
    )


def api_call(base_url: str, endpoint: str, token: str, user_agent: str) -> str:
    """The response body, whatever the status; empty when the call itself failed."""
    try:
        with _opener(base_url).open(
            _request(base_url, endpoint, token, user_agent), timeout=REQUEST_TIMEOUT_SECONDS
        ) as response:
            return response.read(MAX_RESPONSE_BYTES).decode("utf-8", "replace")
    except HTTPError as error:
        try:
            return error.read(MAX_RESPONSE_BYTES).decode("utf-8", "replace")
        except Exception:  # pylint: disable=broad-except
            return ""
        finally:
            error.close()
    except Exception:  # pylint: disable=broad-except
        return ""


def _parsed(body: str) -> Any:
    """The JSON value of a response, or None when it is empty or not JSON."""
    if not body:
        return None
    try:
        return json.loads(body)
    except ValueError:
        return None


def _error_type(data: Any) -> Optional[str]:
    """The API's error type when a response is an error and not the data asked for."""
    error = data.get("error") if isinstance(data, dict) else None
    if not isinstance(error, dict):
        return None
    return str(error.get("type") or "error")


def is_auth_error(body: str) -> bool:
    return _error_type(_parsed(body)) == "authentication_error"


def _expiry(oauth: Dict[str, Any]) -> float:
    try:
        return float(oauth.get("expiresAt"))  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return float("-inf")


def default_home_tokens() -> List[str]:
    """The default home's tokens to try, in order: the one that expires last, then
    any other that has not expired."""
    try:
        logins = credentials.claude_oauth(Path.home() / ".claude")
    except Exception as error:  # pylint: disable=broad-except
        _note(f"the Claude login could not be read ({type(error).__name__})")
        return []
    now = time.time()
    return [
        oauth["accessToken"]
        for index, oauth in enumerate(logins)
        if index == 0 or not oauth.get("expiresAt") or _expiry(oauth) / 1000 >= now
    ]


def _subprocess_options() -> Dict[str, Any]:
    return {"creationflags": subprocess.CREATE_NO_WINDOW} if exe.WIN32 else {}  # type: ignore[attr-defined]


def client_version() -> str:
    """The first line of `claude --version`, for the User-Agent header."""
    try:
        claude = exe.claude()
        result = subprocess.run(
            [claude["command"], *claude["args"], "--version"],
            env={**os.environ, **claude["env"]},
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=VERSION_TIMEOUT_SECONDS,
            check=False,
            **_subprocess_options(),
        )
    except (OSError, subprocess.SubprocessError):
        return "unknown"
    lines = result.stdout.decode("utf-8", "replace").splitlines()
    first = "".join(char for char in (lines[0] if lines else "") if " " <= char <= "~").strip()
    return first or "unknown"


def _missing_login_hint() -> str:
    return "keychain auth may be missing" if credentials.uses_keychain() else "credentials file may be missing"


def _title(value: Any) -> str:
    return value.replace("_", " ").title()


def print_profile(data: Dict[str, Any]) -> None:
    acct = data.get("account", {})
    org = data.get("organization", {})
    out(f'  Name:           {acct.get("display_name", "N/A")} ({acct.get("full_name", "N/A")})')
    out(f'  Email:          {acct.get("email", "N/A")}')
    out(f'  Plan:           {_title(org.get("organization_type", "N/A"))}')
    out(f'  Rate Limit:     {org.get("rate_limit_tier", "N/A")}')
    out(f'  Billing:        {_title(org.get("billing_type", "N/A"))}')
    out(f'  Subscription:   {org.get("subscription_status", "N/A").title()}')
    out(f'  Extra Usage:    {"Enabled" if org.get("has_extra_usage_enabled") else "Disabled"}')
    out(f'  Member Since:   {acct.get("created_at", "N/A")[:10]}')
    out(f'  Sub Started:    {org.get("subscription_created_at", "N/A")[:10]}')


def _bar(pct: float, width: int = 20) -> str:
    filled = int(pct / 100 * width)
    return "[" + "#" * filled + "." * (width - filled) + "]"


def _color_pct(pct: float) -> str:
    if pct >= 80:
        return f"{RED}{pct:.0f}%{RESET}"
    if pct >= 50:
        return f"{YELLOW}{pct:.0f}%{RESET}"
    return f"{GREEN}{pct:.0f}%{RESET}"


def _time_until(reset_str: str, now: datetime) -> str:
    if reset_str.endswith("Z"):  # Python 3.9 and 3.10 do not read the Z suffix
        reset_str = reset_str[:-1] + "+00:00"
    reset = datetime.fromisoformat(reset_str)
    if reset.tzinfo is None:
        reset = reset.replace(tzinfo=timezone.utc)
    delta = reset - now
    if delta.total_seconds() <= 0:
        return "resetting now"
    hours = int(delta.total_seconds() // 3600)
    mins = int((delta.total_seconds() % 3600) // 60)
    if hours > 0:
        return f"{hours}h {mins}m"
    return f"{mins}m"


def print_limits(data: Dict[str, Any]) -> None:
    now = datetime.now(timezone.utc)

    def window(label: str, usage: Dict[str, Any]) -> None:
        pct = usage["utilization"]
        out(f"  {label:<18}{_bar(pct)} {_color_pct(pct)} used  |  {100 - pct:.0f}% left")
        out(f'                    Resets in {_time_until(usage["resets_at"], now)}')
        out()

    def extra_usage(usage: Dict[str, Any]) -> None:
        pct = usage["utilization"]
        enabled = usage.get("is_enabled", False)
        limit_dollars = usage.get("monthly_limit", 0) / 100
        used_dollars = usage.get("used_credits", 0) / 100
        remaining = limit_dollars - used_dollars
        out(f'  {"Extra Usage:":<18}{_bar(pct)} {_color_pct(pct)} used')
        out(f"                    ${used_dollars:.2f} / ${limit_dollars:.2f}  (${remaining:.2f} remaining)")
        out(f'                    Status: {"Enabled" if enabled else "Disabled"}')

    # One window the API reports in a shape this cannot print does not hide the others.
    for key, label in LIMIT_WINDOWS:
        if data.get(key):
            _section(f"live limit {key}", lambda key=key, label=label: window(label, data[key]), detail=False)
    if data.get("extra_usage"):
        _section("live limit extra_usage", lambda: extra_usage(data["extra_usage"]), detail=False)


def live_sections() -> None:
    base_url = _api_base_url()
    tokens = default_home_tokens() if base_url else []
    user_agent = f"claude-code/{client_version()}" if tokens else ""

    # Use the first token the API accepts; if none is accepted, report the first.
    token = ""
    profile = ""
    for candidate in tokens:
        response = api_call(base_url, "profile", candidate, user_agent)  # type: ignore[arg-type]
        if not token:
            token, profile = candidate, response
        if not is_auth_error(response):
            token, profile = candidate, response
            break

    header("ACCOUNT PROFILE")
    data = _parsed(profile)
    if isinstance(data, dict) and _error_type(data) is None:
        _section("account profile", lambda: print_profile(data), detail=False)
    else:
        out(f"  {YELLOW}Could not fetch profile ({_missing_login_hint()}){RESET}")

    header("LIVE USAGE LIMITS")
    usage = api_call(base_url, "usage", token, user_agent) if token else ""  # type: ignore[arg-type]
    data = _parsed(usage)
    if isinstance(data, dict) and _error_type(data) is None:
        _section("live usage limits", lambda: print_limits(data), detail=False)
    else:
        out(f"  {YELLOW}Could not fetch live usage ({_missing_login_hint()}){RESET}")

    blocks: List[str] = []
    if base_url:
        try:
            blocks = additional_accounts(base_url)
        except Exception as error:  # pylint: disable=broad-except
            _note(f"additional Claude accounts skipped ({type(error).__name__})")
    if blocks:
        header("ADDITIONAL CLAUDE ACCOUNTS")
        out("\n\n".join(blocks))


def additional_accounts(base_url: str) -> List[str]:
    """One block of lines for each extra login (``~/.claude-<name>``) that names an account."""
    home = str(Path.home())
    keychain = credentials.uses_keychain()
    blocks = []
    for config_dir in sorted(glob.glob(os.path.join(glob.escape(home), ".claude-*"))):
        cfg = os.path.join(config_dir, ".claude.json")
        if not os.path.isdir(config_dir) or not os.path.exists(cfg):
            continue
        try:
            with open(cfg, encoding="utf-8") as stream:
                oauth_acct = json.load(stream).get("oauthAccount") or {}
        except Exception:  # pylint: disable=broad-except
            continue
        label = oauth_acct.get("organizationName") or oauth_acct.get("emailAddress")
        if not label:
            continue
        short_dir = "~" + config_dir[len(home):]
        if exe.WIN32:
            short_dir = short_dir.replace("\\", "/")  # the form Git Bash expands
        lines = [f"  {label}  ({short_dir})"]
        logins = credentials.claude_oauth(Path(config_dir))
        if not logins:
            store = "Keychain credential" if keychain else "credentials file"
            lines.append(f"    No {store} found for this account")
            blocks.append("\n".join(lines))
            continue
        oauth = logins[0]
        if oauth.get("expiresAt") and _expiry(oauth) / 1000 < time.time():
            if oauth.get("refreshToken"):
                lines.append("    OAuth token expired — start a session on this account to refresh")
            else:
                lines.append(f"    Needs re-login: CLAUDE_CONFIG_DIR={short_dir} claude /login")
            blocks.append("\n".join(lines))
            continue
        try:
            with _opener(base_url).open(
                _request(base_url, "usage", oauth["accessToken"], EXTRA_ACCOUNT_USER_AGENT),
                timeout=EXTRA_ACCOUNT_TIMEOUT_SECONDS,
            ) as response:
                usage = json.load(response)
        except Exception as error:  # pylint: disable=broad-except
            lines.append(f"    API error: {error}")
            blocks.append("\n".join(lines))
            continue
        for key, name in EXTRA_ACCOUNT_WINDOWS:
            window = usage.get(key)
            if not window:
                continue
            pct = window.get("utilization", 0) or 0
            lines.append(f"    {name + ':':<17} {_bar(pct)} {pct:.0f}% used  |  {100 - pct:.0f}% left")
        blocks.append("\n".join(lines))
    return blocks


# ---- local data ----


class LocalData:
    """The Claude home's own records. The stats file is read once; a file that
    cannot be read fails each part that needs it, and the report goes on."""

    def __init__(self, claude_dir: Path) -> None:
        self.home = str(Path.home())
        self.stats_file = claude_dir / "stats-cache.json"
        self.history_file = claude_dir / "history.jsonl"
        self.sessions_dir = claude_dir / "sessions"
        self._stats: Any = None
        self._stats_error: Optional[Exception] = None

    def stats(self) -> Any:
        if self._stats_error is not None:
            raise self._stats_error
        if self._stats is None:
            try:
                with open(self.stats_file, encoding="utf-8") as stream:
                    self._stats = json.load(stream)
            except Exception as error:  # pylint: disable=broad-except
                self._stats_error = error
                raise
        return self._stats

    def days(self) -> List[Dict[str, Any]]:
        return self.stats().get("dailyActivity", [])


def lifetime_totals(local: LocalData) -> None:
    days = local.days()
    total_msgs = sum(d["messageCount"] for d in days)
    total_sessions = sum(d["sessionCount"] for d in days)
    total_tools = sum(d["toolCallCount"] for d in days)
    first = days[0]["date"] if days else "N/A"
    last = days[-1]["date"] if days else "N/A"
    out(f"  Messages:     {total_msgs:,}")
    out(f"  Sessions:     {total_sessions:,}")
    out(f"  Tool Calls:   {total_tools:,}")
    out(f"  Active Days:  {len(days)}")
    out(f"  Period:       {first} to {last}")


def daily_averages(local: LocalData) -> None:
    days = local.days()
    count = len(days)
    if count == 0:
        out("  No data")
        return
    avg_msgs = sum(d["messageCount"] for d in days) / count
    avg_sess = sum(d["sessionCount"] for d in days) / count
    avg_tools = sum(d["toolCallCount"] for d in days) / count
    out(f"  Avg Messages/day:     {avg_msgs:.1f}")
    out(f"  Avg Sessions/day:     {avg_sess:.1f}")
    out(f"  Avg Tool Calls/day:   {avg_tools:.1f}")


def this_week(local: LocalData) -> None:
    days = local.days()
    cutoff = (datetime.now() - timedelta(days=7)).strftime("%Y-%m-%d")
    recent = [d for d in days if d["date"] >= cutoff]
    if not recent:
        out("  No activity in the last 7 days")
        return
    total_msgs = sum(d["messageCount"] for d in recent)
    total_sessions = sum(d["sessionCount"] for d in recent)
    total_tools = sum(d["toolCallCount"] for d in recent)
    out(f"  Messages:     {total_msgs:,}")
    out(f"  Sessions:     {total_sessions:,}")
    out(f"  Tool Calls:   {total_tools:,}")
    out(f"  Active Days:  {len(recent)}")


def this_month(local: LocalData) -> None:
    days = local.days()
    month_prefix = datetime.now().strftime("%Y-%m")
    monthly = [d for d in days if d["date"].startswith(month_prefix)]
    if not monthly:
        out("  No activity this month")
        return
    total_msgs = sum(d["messageCount"] for d in monthly)
    total_sessions = sum(d["sessionCount"] for d in monthly)
    total_tools = sum(d["toolCallCount"] for d in monthly)
    out(f"  Messages:     {total_msgs:,}")
    out(f"  Sessions:     {total_sessions:,}")
    out(f"  Tool Calls:   {total_tools:,}")
    out(f"  Active Days:  {len(monthly)}")


def monthly_breakdown(local: LocalData) -> None:
    days = local.days()
    months: Dict[str, Dict[str, int]] = defaultdict(lambda: {"msgs": 0, "sessions": 0, "tools": 0, "days": 0})
    for d in days:
        key = d["date"][:7]
        months[key]["msgs"] += d["messageCount"]
        months[key]["sessions"] += d["sessionCount"]
        months[key]["tools"] += d["toolCallCount"]
        months[key]["days"] += 1
    out(f'  {"Month":<10} {"Messages":>10} {"Sessions":>10} {"Tools":>10} {"Days":>6}')
    out(f"  {RULE * 10} {RULE * 10} {RULE * 10} {RULE * 10} {RULE * 6}")
    for month in sorted(months.keys()):
        m = months[month]
        out(f'  {month:<10} {m["msgs"]:>10,} {m["sessions"]:>10,} {m["tools"]:>10,} {m["days"]:>6}')


def busiest_days(local: LocalData) -> None:
    days = sorted(local.days(), key=lambda d: d["messageCount"], reverse=True)[:10]
    out(f'  {"Date":<12} {"Messages":>10} {"Sessions":>10} {"Tools":>10}')
    out(f"  {RULE * 12} {RULE * 10} {RULE * 10} {RULE * 10}")
    for d in days:
        out(f'  {d["date"]:<12} {d["messageCount"]:>10,} {d["sessionCount"]:>10,} {d["toolCallCount"]:>10,}')


def day_of_week(local: LocalData) -> None:
    days = local.days()
    dow: Dict[str, Dict[str, int]] = defaultdict(lambda: {"msgs": 0, "count": 0})
    for d in days:
        day_name = WEEKDAYS[datetime.strptime(d["date"], "%Y-%m-%d").weekday()]
        dow[day_name]["msgs"] += d["messageCount"]
        dow[day_name]["count"] += 1
    out(f'  {"Day":<12} {"Total Msgs":>12} {"Avg Msgs":>10} {"Days":>6}')
    out(f"  {RULE * 12} {RULE * 12} {RULE * 10} {RULE * 6}")
    for name in WEEKDAYS:
        if name in dow:
            total = dow[name]["msgs"]
            cnt = dow[name]["count"]
            avg = total / cnt if cnt else 0
            marks = "#" * int(avg / 50)
            out(f"  {name:<12} {total:>12,} {avg:>10.0f} {cnt:>6}  {marks}")


def top_projects(local: LocalData) -> None:
    projects: Counter = Counter()
    with open(local.history_file, encoding="utf-8", errors="replace") as stream:
        for line in stream:
            try:
                entry = json.loads(line.strip())
                proj = entry.get("project", "unknown")
                proj = proj.replace(local.home, "~")
                projects[proj] += 1
            except Exception:  # pylint: disable=broad-except
                pass
    out(f'  {"Project":<45} {"Messages":>8}')
    out(f"  {RULE * 45} {RULE * 8}")
    for proj, count in projects.most_common(15):
        short = proj if len(proj) <= 44 else "..." + proj[-41:]
        out(f"  {short:<45} {count:>8,}")


def _session_files(local: LocalData) -> List[str]:
    return glob.glob(os.path.join(glob.escape(str(local.sessions_dir)), "*.json"))


def active_sessions(local: LocalData, files: List[str]) -> None:
    sessions = []
    for file in files:
        try:
            with open(file, encoding="utf-8") as stream:
                session = json.load(stream)
                started = session.get("startedAt", 0)
                cwd = session.get("cwd", "N/A")
                cwd = cwd.replace(local.home, "~")
                sessions.append((started, cwd, os.path.basename(file)))
        except Exception:  # pylint: disable=broad-except
            pass
    sessions.sort(key=lambda row: row[0], reverse=True)
    for started, cwd, _name in sessions[:5]:
        when = datetime.fromtimestamp(started / 1000).strftime("%Y-%m-%d %H:%M") if started else "N/A"
        short_cwd = cwd if len(cwd) <= 40 else "..." + cwd[-37:]
        out(f"  {when}  {short_cwd}")
    if len(sessions) > 5:
        out(f"  ... and {len(sessions) - 5} more")


def streaks(local: LocalData) -> None:
    days = local.days()
    dates = sorted([datetime.strptime(d["date"], "%Y-%m-%d") for d in days])

    today = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
    current_streak = 0
    check = today
    for _ in range(len(dates)):
        if check in dates:
            current_streak += 1
            check -= timedelta(days=1)
        elif check == today:
            check = today - timedelta(days=1)
            if check in dates:
                current_streak += 1
                check -= timedelta(days=1)
            else:
                break
        else:
            break

    longest = 0
    streak = 1
    for index in range(1, len(dates)):
        if (dates[index] - dates[index - 1]).days == 1:
            streak += 1
        else:
            longest = max(longest, streak)
            streak = 1
    longest = max(longest, streak)

    out(f"  Current Streak:  {current_streak} day(s)")
    out(f"  Longest Streak:  {longest} day(s)")


def _last_computed(local: LocalData) -> str:
    try:
        return str(local.stats().get("lastComputedDate", "unknown"))
    except Exception:  # pylint: disable=broad-except
        return ""


def local_sections(local: LocalData) -> None:
    if not local.stats_file.is_file():
        out()
        out(f"  {YELLOW}stats-cache.json not found — skipping historical stats{RESET}")
        return

    for title, name, body in [
        ("LIFETIME TOTALS", "lifetime totals", lifetime_totals),
        ("DAILY AVERAGES (on active days)", "daily averages", daily_averages),
        ("THIS WEEK (last 7 days)", "this week", this_week),
        ("THIS MONTH", "this month", this_month),
        ("MONTHLY BREAKDOWN", "monthly breakdown", monthly_breakdown),
        ("TOP 10 BUSIEST DAYS (by messages)", "busiest days", busiest_days),
        ("DAY-OF-WEEK DISTRIBUTION", "day of week", day_of_week),
    ]:
        header(title)
        _section(name, lambda body=body: body(local))

    header("TOP 15 PROJECTS (by message count)")
    if local.history_file.is_file():
        _section("top projects", lambda: top_projects(local))
    else:
        out("  History file not found")

    header("ACTIVE SESSIONS")
    if local.sessions_dir.is_dir():
        files = _session_files(local)
        out(f"  Active session files: {len(files)}")
        if files:
            _section("active sessions", lambda: active_sessions(local, files))
    else:
        out("  Sessions directory not found")

    header("STREAKS")
    _section("streaks", lambda: streaks(local))

    out()
    out(f"{DIM}  Local data source: ~/.claude/stats-cache.json{RESET}")
    out(f"{DIM}  Last computed: {_last_computed(local)}{RESET}")
    out(f"{DIM}  Live data source: api.anthropic.com/api/oauth/{{usage,profile}}{RESET}")
    out()


# ---- the command ----


def _utf8_stdout() -> None:
    """The report has box-drawing characters; print UTF-8 with plain line ends on every OS."""
    reconfigure = getattr(sys.stdout, "reconfigure", None)
    if reconfigure is not None:
        try:
            reconfigure(encoding="utf-8", errors="replace", newline="\n")
        except (OSError, ValueError):
            pass


def usage(_args: argparse.Namespace) -> int:
    _utf8_stdout()
    try:
        header("CLAUDE CODE USAGE REPORT")
        out(f"  Generated: {BOLD}{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}{RESET}")
        live_sections()
        local_sections(LocalData(Path.home() / ".claude"))
        sys.stdout.flush()
    except BrokenPipeError:
        pass
    return 0


def register(subparsers: Any) -> None:
    parser = subparsers.add_parser(
        "usage",
        help="print the Claude usage report: live limits, account profile and local history",
        description=(
            "Print the Claude usage report: account profile and live limits from the Anthropic OAuth API, "
            "then lifetime totals, averages, monthly breakdown, busiest days, top projects, active sessions "
            "and streaks from the local Claude home. The login is only read. Without a usable login the "
            "live sections print a warning and the rest still prints. Always exits 0."
        ),
    )
    parser.set_defaults(func=usage)
