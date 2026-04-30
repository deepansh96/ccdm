#!/bin/bash
# Claude Code Usage Report Script
# Parses local Claude Code data + live API data for comprehensive usage reports
#
# Platform notes:
#   - Live API data (account profile, rate limits) requires macOS Keychain.
#     On Linux, these sections will gracefully skip with a warning.
#   - Local historical data (lifetime stats, streaks, projects) works on any platform.
#
# Dependencies: python3, curl
# Optional: macOS Keychain with Claude Code credentials (for live API data)

CLAUDE_DIR="$HOME/.claude"
STATS_FILE="$CLAUDE_DIR/stats-cache.json"
HISTORY_FILE="$CLAUDE_DIR/history.jsonl"
SESSIONS_DIR="$CLAUDE_DIR/sessions"

# Colors
BOLD='\033[1m'
CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
MAGENTA='\033[0;35m'
DIM='\033[2m'
RESET='\033[0m'

divider() {
    echo -e "${DIM}$(printf '%.0s─' {1..60})${RESET}"
}

header() {
    echo ""
    echo -e "${BOLD}${CYAN}$1${RESET}"
    divider
}

# Helper: get OAuth token from Keychain
get_token() {
    security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null | \
        python3 -c "import sys,json; print(json.loads(sys.stdin.read().strip())['claudeAiOauth']['accessToken'])" 2>/dev/null
}

# Helper: call Anthropic OAuth API
api_call() {
    local endpoint="$1"
    local token
    token=$(get_token)
    if [ -z "$token" ]; then
        echo ""
        return 1
    fi
    local version
    version=$(claude --version 2>/dev/null | head -1 || echo "unknown")
    curl -s "https://api.anthropic.com/api/oauth/${endpoint}" \
        -H "Authorization: Bearer $token" \
        -H "anthropic-beta: oauth-2025-04-20" \
        -H "User-Agent: claude-code/${version}"
}

# ══════════════════════════════════════════════════════════
# SECTION 1: LIVE API DATA
# ══════════════════════════════════════════════════════════

header "CLAUDE CODE USAGE REPORT"
echo -e "  Generated: ${BOLD}$(date '+%Y-%m-%d %H:%M:%S')${RESET}"

# ── Account Profile ──
header "ACCOUNT PROFILE"
PROFILE=$(api_call "profile")
if [ -n "$PROFILE" ] && echo "$PROFILE" | python3 -c "import sys,json; json.load(sys.stdin)" 2>/dev/null; then
    echo "$PROFILE" | python3 -c "
import sys, json
data = json.load(sys.stdin)
acct = data.get('account', {})
org = data.get('organization', {})

print(f'  Name:           {acct.get(\"display_name\", \"N/A\")} ({acct.get(\"full_name\", \"N/A\")})')
print(f'  Email:          {acct.get(\"email\", \"N/A\")}')
print(f'  Plan:           {org.get(\"organization_type\", \"N/A\").replace(\"_\", \" \").title()}')
print(f'  Rate Limit:     {org.get(\"rate_limit_tier\", \"N/A\")}')
print(f'  Billing:        {org.get(\"billing_type\", \"N/A\").replace(\"_\", \" \").title()}')
print(f'  Subscription:   {org.get(\"subscription_status\", \"N/A\").title()}')
print(f'  Extra Usage:    {\"Enabled\" if org.get(\"has_extra_usage_enabled\") else \"Disabled\"}')
print(f'  Member Since:   {acct.get(\"created_at\", \"N/A\")[:10]}')
print(f'  Sub Started:    {org.get(\"subscription_created_at\", \"N/A\")[:10]}')
"
else
    echo -e "  ${YELLOW}Could not fetch profile (keychain auth may be missing)${RESET}"
fi

# ── Live Usage Limits ──
header "LIVE USAGE LIMITS"
USAGE=$(api_call "usage")
if [ -n "$USAGE" ] && echo "$USAGE" | python3 -c "import sys,json; json.load(sys.stdin)" 2>/dev/null; then
    echo "$USAGE" | python3 -c "
import sys, json
from datetime import datetime, timezone

data = json.load(sys.stdin)
now = datetime.now(timezone.utc)

def time_until(reset_str):
    reset = datetime.fromisoformat(reset_str)
    delta = reset - now
    if delta.total_seconds() <= 0:
        return 'resetting now'
    hours = int(delta.total_seconds() // 3600)
    mins = int((delta.total_seconds() % 3600) // 60)
    if hours > 0:
        return f'{hours}h {mins}m'
    return f'{mins}m'

def bar(pct, width=20):
    filled = int(pct / 100 * width)
    return '[' + '#' * filled + '.' * (width - filled) + ']'

def color_pct(pct):
    if pct >= 80:
        return f'\033[0;31m{pct:.0f}%\033[0m'  # red
    elif pct >= 50:
        return f'\033[0;33m{pct:.0f}%\033[0m'  # yellow
    else:
        return f'\033[0;32m{pct:.0f}%\033[0m'  # green

# 5-hour session
if data.get('five_hour'):
    u = data['five_hour']
    pct = u['utilization']
    print(f'  5-Hour Session:   {bar(pct)} {color_pct(pct)} used  |  {100-pct:.0f}% left')
    print(f'                    Resets in {time_until(u[\"resets_at\"])}')
    print()

# 7-day all models
if data.get('seven_day'):
    u = data['seven_day']
    pct = u['utilization']
    print(f'  7-Day (All):      {bar(pct)} {color_pct(pct)} used  |  {100-pct:.0f}% left')
    print(f'                    Resets in {time_until(u[\"resets_at\"])}')
    print()

# 7-day opus
if data.get('seven_day_opus'):
    u = data['seven_day_opus']
    pct = u['utilization']
    print(f'  7-Day (Opus):     {bar(pct)} {color_pct(pct)} used  |  {100-pct:.0f}% left')
    print(f'                    Resets in {time_until(u[\"resets_at\"])}')
    print()

# 7-day sonnet
if data.get('seven_day_sonnet'):
    u = data['seven_day_sonnet']
    pct = u['utilization']
    print(f'  7-Day (Sonnet):   {bar(pct)} {color_pct(pct)} used  |  {100-pct:.0f}% left')
    print(f'                    Resets in {time_until(u[\"resets_at\"])}')
    print()

# 7-day cowork
if data.get('seven_day_cowork'):
    u = data['seven_day_cowork']
    pct = u['utilization']
    print(f'  7-Day (Cowork):   {bar(pct)} {color_pct(pct)} used  |  {100-pct:.0f}% left')
    print(f'                    Resets in {time_until(u[\"resets_at\"])}')
    print()

# Extra usage
if data.get('extra_usage'):
    u = data['extra_usage']
    pct = u['utilization']
    enabled = u.get('is_enabled', False)
    limit_dollars = u.get('monthly_limit', 0) / 100
    used_dollars = u.get('used_credits', 0) / 100
    remaining = limit_dollars - used_dollars
    print(f'  Extra Usage:      {bar(pct)} {color_pct(pct)} used')
    print(f'                    \${used_dollars:.2f} / \${limit_dollars:.2f}  (\${remaining:.2f} remaining)')
    print(f'                    Status: {\"Enabled\" if enabled else \"Disabled\"}')
"
else
    echo -e "  ${YELLOW}Could not fetch live usage (keychain auth may be missing)${RESET}"
fi

# ══════════════════════════════════════════════════════════
# SECTION 2: LOCAL HISTORICAL DATA
# ══════════════════════════════════════════════════════════

if [ ! -f "$STATS_FILE" ]; then
    echo ""
    echo -e "  ${YELLOW}stats-cache.json not found — skipping historical stats${RESET}"
    exit 0
fi

# ── Lifetime Totals ──
header "LIFETIME TOTALS"
python3 -c "
import json
with open('$STATS_FILE') as f:
    data = json.load(f)
days = data.get('dailyActivity', [])
total_msgs = sum(d['messageCount'] for d in days)
total_sessions = sum(d['sessionCount'] for d in days)
total_tools = sum(d['toolCallCount'] for d in days)
active_days = len(days)
first = days[0]['date'] if days else 'N/A'
last = days[-1]['date'] if days else 'N/A'
print(f'  Messages:     {total_msgs:,}')
print(f'  Sessions:     {total_sessions:,}')
print(f'  Tool Calls:   {total_tools:,}')
print(f'  Active Days:  {active_days}')
print(f'  Period:       {first} to {last}')
"

# ── Daily Averages ──
header "DAILY AVERAGES (on active days)"
python3 -c "
import json
with open('$STATS_FILE') as f:
    data = json.load(f)
days = data.get('dailyActivity', [])
n = len(days)
if n == 0:
    print('  No data')
else:
    avg_msgs = sum(d['messageCount'] for d in days) / n
    avg_sess = sum(d['sessionCount'] for d in days) / n
    avg_tools = sum(d['toolCallCount'] for d in days) / n
    print(f'  Avg Messages/day:     {avg_msgs:.1f}')
    print(f'  Avg Sessions/day:     {avg_sess:.1f}')
    print(f'  Avg Tool Calls/day:   {avg_tools:.1f}')
"

# ── This Week ──
header "THIS WEEK (last 7 days)"
python3 -c "
import json
from datetime import datetime, timedelta
with open('$STATS_FILE') as f:
    data = json.load(f)
days = data.get('dailyActivity', [])
cutoff = (datetime.now() - timedelta(days=7)).strftime('%Y-%m-%d')
recent = [d for d in days if d['date'] >= cutoff]
if not recent:
    print('  No activity in the last 7 days')
else:
    total_msgs = sum(d['messageCount'] for d in recent)
    total_sessions = sum(d['sessionCount'] for d in recent)
    total_tools = sum(d['toolCallCount'] for d in recent)
    print(f'  Messages:     {total_msgs:,}')
    print(f'  Sessions:     {total_sessions:,}')
    print(f'  Tool Calls:   {total_tools:,}')
    print(f'  Active Days:  {len(recent)}')
"

# ── This Month ──
header "THIS MONTH"
python3 -c "
import json
from datetime import datetime
with open('$STATS_FILE') as f:
    data = json.load(f)
days = data.get('dailyActivity', [])
month_prefix = datetime.now().strftime('%Y-%m')
monthly = [d for d in days if d['date'].startswith(month_prefix)]
if not monthly:
    print('  No activity this month')
else:
    total_msgs = sum(d['messageCount'] for d in monthly)
    total_sessions = sum(d['sessionCount'] for d in monthly)
    total_tools = sum(d['toolCallCount'] for d in monthly)
    print(f'  Messages:     {total_msgs:,}')
    print(f'  Sessions:     {total_sessions:,}')
    print(f'  Tool Calls:   {total_tools:,}')
    print(f'  Active Days:  {len(monthly)}')
"

# ── Monthly Breakdown ──
header "MONTHLY BREAKDOWN"
python3 -c "
import json
from collections import defaultdict
with open('$STATS_FILE') as f:
    data = json.load(f)
days = data.get('dailyActivity', [])
months = defaultdict(lambda: {'msgs': 0, 'sessions': 0, 'tools': 0, 'days': 0})
for d in days:
    key = d['date'][:7]
    months[key]['msgs'] += d['messageCount']
    months[key]['sessions'] += d['sessionCount']
    months[key]['tools'] += d['toolCallCount']
    months[key]['days'] += 1
print(f'  {\"Month\":<10} {\"Messages\":>10} {\"Sessions\":>10} {\"Tools\":>10} {\"Days\":>6}')
print(f'  {\"─\"*10} {\"─\"*10} {\"─\"*10} {\"─\"*10} {\"─\"*6}')
for month in sorted(months.keys()):
    m = months[month]
    print(f'  {month:<10} {m[\"msgs\"]:>10,} {m[\"sessions\"]:>10,} {m[\"tools\"]:>10,} {m[\"days\"]:>6}')
"

# ── Top 10 Busiest Days ──
header "TOP 10 BUSIEST DAYS (by messages)"
python3 -c "
import json
with open('$STATS_FILE') as f:
    data = json.load(f)
days = sorted(data.get('dailyActivity', []), key=lambda d: d['messageCount'], reverse=True)[:10]
print(f'  {\"Date\":<12} {\"Messages\":>10} {\"Sessions\":>10} {\"Tools\":>10}')
print(f'  {\"─\"*12} {\"─\"*10} {\"─\"*10} {\"─\"*10}')
for d in days:
    print(f'  {d[\"date\"]:<12} {d[\"messageCount\"]:>10,} {d[\"sessionCount\"]:>10,} {d[\"toolCallCount\"]:>10,}')
"

# ── Day-of-Week Distribution ──
header "DAY-OF-WEEK DISTRIBUTION"
python3 -c "
import json
from datetime import datetime
from collections import defaultdict
with open('$STATS_FILE') as f:
    data = json.load(f)
days = data.get('dailyActivity', [])
dow = defaultdict(lambda: {'msgs': 0, 'count': 0})
names = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
for d in days:
    dt = datetime.strptime(d['date'], '%Y-%m-%d')
    day_name = names[dt.weekday()]
    dow[day_name]['msgs'] += d['messageCount']
    dow[day_name]['count'] += 1
print(f'  {\"Day\":<12} {\"Total Msgs\":>12} {\"Avg Msgs\":>10} {\"Days\":>6}')
print(f'  {\"─\"*12} {\"─\"*12} {\"─\"*10} {\"─\"*6}')
for name in names:
    if name in dow:
        total = dow[name]['msgs']
        cnt = dow[name]['count']
        avg = total / cnt if cnt else 0
        bar = '#' * int(avg / 50)
        print(f'  {name:<12} {total:>12,} {avg:>10.0f} {cnt:>6}  {bar}')
"

# ── Project Usage ──
header "TOP 15 PROJECTS (by message count)"
if [ -f "$HISTORY_FILE" ]; then
    python3 -c "
import json
from collections import Counter
projects = Counter()
with open('$HISTORY_FILE') as f:
    for line in f:
        try:
            entry = json.loads(line.strip())
            proj = entry.get('project', 'unknown')
            proj = proj.replace('$HOME', '~')
            projects[proj] += 1
        except:
            pass
print(f'  {\"Project\":<45} {\"Messages\":>8}')
print(f'  {\"─\"*45} {\"─\"*8}')
for proj, count in projects.most_common(15):
    short = proj if len(proj) <= 44 else '...' + proj[-41:]
    print(f'  {short:<45} {count:>8,}')
" 2>/dev/null
else
    echo "  History file not found"
fi

# ── Active Sessions ──
header "ACTIVE SESSIONS"
if [ -d "$SESSIONS_DIR" ]; then
    session_count=$(ls "$SESSIONS_DIR"/*.json 2>/dev/null | wc -l | tr -d ' ')
    echo "  Active session files: $session_count"
    if [ "$session_count" -gt 0 ]; then
        python3 -c "
import json, os, glob
from datetime import datetime
sessions = []
for f in glob.glob('$SESSIONS_DIR/*.json'):
    try:
        with open(f) as fh:
            s = json.load(fh)
            started = s.get('startedAt', 0)
            cwd = s.get('cwd', 'N/A')
            cwd = cwd.replace('$HOME', '~')
            sessions.append((started, cwd, os.path.basename(f)))
    except:
        pass
sessions.sort(key=lambda x: x[0], reverse=True)
for ts, cwd, name in sessions[:5]:
    dt = datetime.fromtimestamp(ts / 1000).strftime('%Y-%m-%d %H:%M') if ts else 'N/A'
    short_cwd = cwd if len(cwd) <= 40 else '...' + cwd[-37:]
    print(f'  {dt}  {short_cwd}')
if len(sessions) > 5:
    print(f'  ... and {len(sessions) - 5} more')
" 2>/dev/null
    fi
else
    echo "  Sessions directory not found"
fi

# ── Usage Streak ──
header "STREAKS"
python3 -c "
import json
from datetime import datetime, timedelta
with open('$STATS_FILE') as f:
    data = json.load(f)
days = data.get('dailyActivity', [])
dates = sorted([datetime.strptime(d['date'], '%Y-%m-%d') for d in days])

# Current streak
today = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
current_streak = 0
check = today
for i in range(len(dates)):
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

# Longest streak
longest = 0
streak = 1
for i in range(1, len(dates)):
    if (dates[i] - dates[i-1]).days == 1:
        streak += 1
    else:
        longest = max(longest, streak)
        streak = 1
longest = max(longest, streak)

print(f'  Current Streak:  {current_streak} day(s)')
print(f'  Longest Streak:  {longest} day(s)')
"

echo ""
echo -e "${DIM}  Local data source: ~/.claude/stats-cache.json${RESET}"
echo -e "${DIM}  Last computed: $(python3 -c "import json; print(json.load(open('$STATS_FILE')).get('lastComputedDate','unknown'))")${RESET}"
echo -e "${DIM}  Live data source: api.anthropic.com/api/oauth/{usage,profile}${RESET}"
echo ""
