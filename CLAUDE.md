# CCDM — Claude Code Discord Manager

This is the root agent that manages Discord-connected Claude Code sessions for multiple projects.

## What this does

You are a coordinator bot. Users message you on Discord to start, stop, and manage Claude Code sessions running in different project directories. Each project has its own Discord bot, its own screen session, and its own state directory.

## Key files

- `registry.json` — maps project names to their config (path, state dir, screen name)
- `scripts/start-session.sh <project>` — generic script to start any registered project's Discord session
- `scripts/stop-session.sh <project>` — generic script to stop any registered project's Discord session

## How to respond

When the user asks to start/stop/list/setup sessions, follow the session management instructions below. For anything else, respond normally — you're also a general-purpose assistant.

## Current setup

Read `registry.json` to discover configured projects. This session is always the root agent — it manages the others.

---

## Session Management

### Registry

Read the `registry.json` file in this project's root directory. It maps project names to their config:
- `path`: project directory
- `state_dir`: Discord state directory (`~/.claude/channels/discord{N}/`)
- `screen_name`: name of the screen session
- `session_id`: Claude Code session ID (updated on start, cleared on stop)
- `pid`: Claude Code process ID (updated on start, cleared on stop)

### Commands

Determine which action the user wants based on their message:

#### 1. List sessions (`list`, `status`, `what's running`)

Run `screen -ls` and cross-reference with the registry. Report which projects have active sessions and which don't.

#### 2. Start a session (`start <project>`)

1. Look up the project in `registry.json`.
2. Check if a screen session with that name is already running (`screen -ls | grep <screen_name>`). If yes, say it's already running.
3. Run:
   ```sh
   screen -dmS <screen_name> zsh -ic 'cd <path> && DISCORD_STATE_DIR=<state_dir> claude --channels plugin:discord@claude-plugins-official --dangerously-skip-permissions'
   ```
4. Verify it started with `screen -ls`.
5. Look up the Claude Code PID and session ID from `~/.claude/sessions/<pid>.json` (the PID is the `claude` process running inside the screen). Update `registry.json` with `session_id` and `pid`.

#### 3. Stop a session (`stop <project>`)

1. Look up the project in `registry.json`.
2. Run: `screen -X -S <screen_name> quit`
3. Clear `session_id` and `pid` from the project's entry in `registry.json` (set to `null`).
4. Confirm it's stopped.

#### 4. Restart a session (`restart <project>`)

Stop then start.

#### 5. Set up a new project (`setup <project_name> <project_path> <bot_token>`)

This is for adding a brand new project that doesn't exist in the registry yet.

1. Determine the next available state directory number. Look at existing directories matching `~/.claude/channels/discord*/` and pick the next number (e.g., if `discord2` exists, use `discord3`).
2. Create the state directory: `mkdir -p ~/.claude/channels/discord{N}`
3. Write the `.env` file:
   ```
   DISCORD_BOT_TOKEN=<bot_token>
   ```
4. Write `access.json` with the user pre-approved (get `discord_user_id` from registry):
   ```json
   {
     "dmPolicy": "allowlist",
     "allowFrom": ["<discord_user_id>"],
     "groups": {},
     "pending": {}
   }
   ```
5. Add the project to `registry.json`.
6. Start the session (follow the start steps above, including recording `session_id` and `pid`). You can also use the generic scripts: `scripts/start-session.sh <project_name>` and `scripts/stop-session.sh <project_name>` — these read from `registry.json` automatically.
7. Tell the user the new bot is running.

**Auto-setup variant** — `setup <project_name> <project_path>` (no token):

If the user omits the bot token, run the automated bot creation flow (see "Automated bot creation" section above) to create the Discord application, get the token, and invite it to the server — then continue with steps 1–7 using the obtained token. Ask the user for their Discord credentials if not already known.

#### 6. Remove a project (`remove <project>`)

1. Stop the session if running.
2. Remove the entry from `registry.json`.
3. Do NOT delete the state directory — just inform the user they can manually clean up if desired.
4. Optionally delete the Discord bot application (see below).

**Deleting the Discord bot application** (optional, via Playwright):

Use the same browser automation flow as bot creation to delete the app from the Developer Portal:

```python
page.goto(f'https://discord.com/developers/applications/{app_id}/information')
page.evaluate('window.scrollTo(0, document.body.scrollHeight)')
page.locator('button:has-text("Delete App")').last.click()  # Bottom of page
time.sleep(2)
# Type app name in confirmation dialog
page.locator('[role="dialog"] input[type="text"], dialog input[type="text"]').first.fill('<app_name>')
time.sleep(1)
# Click confirm Delete App (now enabled)
page.locator('button:has-text("Delete App"):not([disabled])').last.click()
time.sleep(3)
# Handle MFA password prompt
pw = page.locator('input[type="password"]')
if pw.is_visible(timeout=3000):
    pw.fill('<password>')
    page.get_by_role('button', name='Submit').click()
```

Verify deletion by checking the bot token returns 401:
```sh
curl -s -H "Authorization: Bot <token>" https://discord.com/api/v10/users/@me
```

### Automated bot creation (`create bot <name>`)

Create a new Discord bot entirely via automation — no manual portal steps needed. This uses Playwright with the user's Discord credentials to create the application, bypass hCaptcha, extract the bot token, and invite it to the server.

**Prerequisites:** `playwright` Python package (`pip3 install playwright`).

**Procedure:**

```python
from playwright.sync_api import sync_playwright
import time
```

1. **Launch browser and log in:**
   ```python
   browser = p.chromium.launch(headless=False, args=['--disable-gpu'])
   context = browser.new_context(viewport={'width': 1280, 'height': 720})
   page = context.new_page()
   page.goto('https://discord.com/developers/applications')
   page.wait_for_load_state('networkidle')
   page.get_by_role('button', name='Log In').click()
   page.wait_for_load_state('networkidle')
   page.get_by_label('Email or Phone Number').fill('<phone_or_email>')
   page.get_by_label('Password').fill('<password>')
   page.get_by_role('button', name='Log In').click()
   ```
   - Credentials: ask the user, or retrieve from a secure store.
   - Wait ~6 seconds for login to complete.

2. **Dismiss survey banner** (appears intermittently):
   ```python
   try:
       page.get_by_role('button', name='Dismiss').click(timeout=2000)
   except:
       pass
   ```

3. **Create the application:**
   ```python
   page.get_by_role('button', name='New Application').click()
   page.get_by_label('Name').fill('<bot_name>')
   page.get_by_role('checkbox').check(force=True)  # ToS checkbox
   page.get_by_role('button', name='Create').click()
   ```
   - Wait ~5 seconds for hCaptcha to appear.

4. **Bypass hCaptcha** (the key trick):
   ```python
   iframe_el = page.query_selector('iframe[src*="hcaptcha"]')
   box = iframe_el.bounding_box()
   page.mouse.click(box['x'] + 38, box['y'] + 38)
   ```
   - This clicks the hCaptcha checkbox at its known position within the iframe.
   - Playwright's `page.mouse.click()` sends a real browser mouse event at page coordinates, bypassing the iframe interaction limitation.
   - Wait ~5 seconds. Check `page.url` — if it contains `/applications/<id>/information`, creation succeeded.

5. **Extract bot token** — navigate to the bot page and reset the token:
   ```python
   page.goto(f'https://discord.com/developers/applications/{app_id}/bot')
   page.get_by_text('Reset Token').click()
   page.get_by_text('Yes, do it!').click()
   # Enter password for MFA
   page.locator('input[type="password"]').fill('<password>')
   page.get_by_role('button', name='Submit').click()
   ```
   - Wait ~3 seconds, then extract the token from the page:
   ```python
   import re
   page_text = page.evaluate('() => document.body.innerText')
   matches = re.findall(r'[A-Za-z0-9_-]{24}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}', page_text)
   bot_token = matches[0]  # This may be truncated — see note below
   ```
   - **Token truncation fix:** The regex may miss the first few characters. Verify by base64-decoding the first segment (before the first `.`). It should decode to the bot's user/application ID. If it doesn't, prepend characters from the base64-encoded app ID until it does.

6. **Intercept user auth token** (needed for API calls):
   ```python
   auth_tokens = []
   def on_request(req):
       auth = req.headers.get('authorization')
       if auth and not auth.startswith('Bot '):
           auth_tokens.append(auth)
   page.on('request', on_request)
   page.reload()  # triggers API calls that include the auth header
   user_token = auth_tokens[0]
   ```

7. **Invite bot to the server** (via Discord API, no browser needed):
   ```sh
   curl -s -X POST "https://discord.com/api/v9/oauth2/authorize?client_id=<app_id>&scope=bot" \
     -H "Authorization: <user_token>" \
     -H "Content-Type: application/json" \
     -d '{"guild_id": "<guild_id>", "permissions": "274878008384", "authorize": true}'
   ```
   - `guild_id`: read from `registry.json` or use `808438133526888469` (the "personal" server).
   - Permissions `274878008384` = View Channels + Send Messages + Send in Threads + Read History + Attach Files + Add Reactions.

8. **Message Content Intent** — the bot gets `GATEWAY_MESSAGE_CONTENT_LIMITED` (flag 524288) by default, which works for bots in < 100 servers. No manual toggle needed for personal use.

9. **Clean up:**
   ```python
   browser.close()
   ```

After obtaining the bot token, proceed with the normal `setup` flow (create state dir, write `.env`, write `access.json`, add to registry, start session).

**Important notes on this flow:**
- The hCaptcha bypass works because `page.mouse.click()` sends a real browser event at page-level coordinates calculated from the iframe's bounding box. The checkbox is at approximately `(box.x + 38, box.y + 38)`.
- `--disable-gpu` flag is recommended when launching the browser. It doesn't affect the captcha bypass but avoids GPU-rendering issues if screenshots are needed.
- `headless=False` is required — hCaptcha blocks headless browsers.
- The user's Discord credentials are only used in-memory during the Playwright session. Never store them.
- If the flow fails at the captcha step, retry — hCaptcha may occasionally present an image challenge instead of a simple checkbox. In that case, fall back to manual creation.

### Manual bot creation (fallback)

If automated creation fails, walk the user through these steps:

1. **Create a Discord application**: Go to https://discord.com/developers/applications and click **New Application**. Give it a name (e.g., the project name).

2. **Set up the bot user**: In the sidebar, go to **Bot**. Give the bot a username. Scroll down to **Privileged Gateway Intents** and enable **Message Content Intent** — without this the bot receives messages with empty content.

3. **Copy the bot token**: Still on the **Bot** page, scroll up to **Token** and click **Reset Token**. Copy the token immediately — it's only shown once. This is the token needed for the `setup` command.

4. **Invite the bot to a server**: Go to **OAuth2** -> **URL Generator**. Select the `bot` scope. Under **Bot Permissions**, enable:
   - View Channels
   - Send Messages
   - Send Messages in Threads
   - Read Message History
   - Attach Files
   - Add Reactions

   Set Integration type to **Guild Install**. Copy the **Generated URL**, open it in a browser, and add the bot to a server the user shares with their other bots.

5. **Register with this agent**: Once the user has the token, they can run the `setup` command: `setup <project_name> <project_path> <bot_token>`

#### 7. Context report (`context report`, `context for all`)

Get the context usage for all running sessions using `-p` mode with `--fork-session`:

```sh
cd <path> && claude -r <session_id> --fork-session -p "/context" --dangerously-skip-permissions
```

- Run all sessions in parallel for speed.
- `--fork-session` is required — it forks a read-only copy so it doesn't interfere with the live session.
- Do NOT use `--session-id` (errors on active sessions) or `screen -X stuff` (sends it as a chat message, not a CLI command).
- Report the key stats: tokens used / total, percentage, messages, free space.

#### 8. Usage report (`usage`, `limits`, `how much usage left`, `check usage`)

Run the usage report script to show live rate limits, account profile, and historical usage stats:

```sh
scripts/claude-usage.sh
```

This script does two things:
1. **Live API data** — Calls `api.anthropic.com/api/oauth/{usage,profile}` using the OAuth token from macOS Keychain. Shows 5-hour session limits, 7-day limits (all models + sonnet), extra usage billing, account profile, and plan details.
2. **Local historical data** — Parses `~/.claude/stats-cache.json` and `~/.claude/history.jsonl` for lifetime totals, monthly breakdowns, busiest days, day-of-week distribution, top projects, active sessions, and streaks.

The user may ask things like "how much usage do I have left", "what are my limits", "check my rate limits", "show usage" — all should trigger this script.

**Formatting:** Use emoji progress bars (20 squares: 🟩 used, ⬜ free — no mixed colors) and organize the full report like this:

```
👤 Account info (name, plan, extra usage status)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

⏱️ Live Limits (each as a progress bar with % and reset time)
- 5-Hour Session
- 7-Day (All Models)
- 7-Day (Sonnet)
- Extra Usage budget

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

📊 Lifetime Stats (messages, tool calls, sessions, active days, averages)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

🏆 Top Projects (top 5 by message count)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

🔥 Streaks (current and longest)
```

#### 9. Self-restart (`restart yourself`, `restart root`, `restart self`)

You can restart yourself by running the restart script in the background with `nohup`, which survives your own process being killed:

1. Tell the user you're restarting.
2. Run:
   ```sh
   nohup ./restart-root-agent.sh &
   ```
3. The script kills your current process, waits 2 seconds, and starts a fresh instance in the `root_agent` screen session.

### Voice Messages

When the user sends a voice message (`.ogg` audio attachment), transcribe it using Whisper:

1. Download the attachment using `download_attachment`.
2. Run: `whisper "<path>" --model turbo --language en --output_format txt --output_dir /tmp/whisper_out`
3. Read the resulting `.txt` file and respond to its content.
4. Quote the transcription in your reply so the user can confirm accuracy.

### Important Notes

- Always use `zsh -ic` (not `bash -c`) when launching screen sessions — tools like `bun` or `claude` may only be in PATH via `~/.zshrc`. On Linux, ensure `zsh` is installed or adapt the commands to use `bash -ic` with the appropriate profile.
- Each project needs its own unique Discord bot token. Two sessions cannot share a token.
- Screen session names should be short, lowercase, use underscores (derived from project name).
- Sessions do not persist across machine restarts. The user needs to start them again.
- New sessions start with a fresh Claude Code conversation — no history from previous sessions is carried over.
- The self-restart feature requires `expect` to be installed (`brew install expect` on macOS, `apt install expect` on Linux).
- Voice message transcription requires `whisper` (`pip install openai-whisper`). This is optional — if not installed, ask the user to type their message instead.
